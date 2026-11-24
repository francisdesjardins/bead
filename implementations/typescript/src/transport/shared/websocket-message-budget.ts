// ── WebSocket message budget ──────────────────────────────────────────────────

// interfaces

/** One connection's share of a budget: what its message partway holds (spec 15.12). */
export interface IMessageHolder {
  /** What its message partway holds. */
  readonly held: number;
  /** Its message began: among equal sums, the one that began first is cast off first. */
  begin(): void;
  /**
   * Charges its message `bytes`, as so many charges of one, each other holder a unit finds first
   * cast off by its `castOff`; false when it is cast off itself, what it held released, its own
   * `castOff` left to its caller, which fails it once it handed on what came before.
   */
  charge(bytes: number): boolean;
  /** Its message whole, or its connection failed: what it held released. Idempotent. */
  release(): void;
}

/** What one holder is: how it is cast off. */
export interface IMessageHolderOptions {
  /**
   * Fails its connection with 1013, at once, once the budget released what it held: a holder
   * another's charge casts off.
   */
  castOff: () => void;
}

/** The bytes a server holds of messages partway, across its connections (spec 15.12). */
export interface IMessageBudget {
  /** What its holders hold together: the gauge `messageBytes`. */
  readonly held: number;
  /** A holder for one connection, until `forget` lets it go. */
  holderOf(options: IMessageHolderOptions): IMessageHolder;
  /** Lets a holder go, its connection gone, what it held released. */
  forget(holder: IMessageHolder): void;
}

// types

// a holder as the budget keeps it
interface IEntry extends IMessageHolderOptions {
  // the rank its message began at, across the budget
  began: number;
  sum: number;
}

// definition

/**
 * A budget of `messageBytesBudget` bytes, shared by a server's connections (spec 15.12). A charge of
 * _n_ decides as _n_ charges of one, each taken in the room left. A unit that finds none judges the
 * order for itself: the holder whose message holds the most, the asking one's sum counting that
 * unit, then, among equal sums, the one whose message began first. The one that comes first is cast
 * off and its charge released at once, then the next unit is judged; the asking holder is cast off
 * only when it comes first, so a charge that passes the budget alone casts off each holder before it,
 * then its own. A holder with nothing charged is in no order. Each one cast off fails with 1013,
 * IANA's "Try Again Later", as Redis's client eviction casts off the client that holds the most.
 */
export const createMessageBudget = (messageBytesBudget: number): IMessageBudget => {
  const entries = new Map<IMessageHolder, IEntry>();
  let held = 0;
  let ordinal = 0;

  const releaseOf = (entry: IEntry): void => {
    held -= entry.sum;
    entry.sum = 0;
  };

  // whether `entry`, its sum `sum`, comes before `other` in the order: the larger sum, then, among
  // equal sums, the message begun first
  const isBefore = (entry: IEntry, { other, sum }: { other: IEntry; sum: number }): boolean => {
    return sum > other.sum || (sum === other.sum && entry.began < other.began);
  };

  // * the loop every side takes: `asking` takes what room is left, then the next unit judges the
  // order, casting off the first other holder, or `asking` itself when it comes first; those cast
  // off, in order, and whether `asking` is among them
  const castOffBy = (asking: IEntry, bytes: number): { gone: IEntry[]; isCastOff: boolean } => {
    // * a charge that fits judges nothing
    if (held + bytes <= messageBytesBudget) {
      asking.sum += bytes;
      held += bytes;

      return { gone: [], isCastOff: false };
    }

    const others = [...entries.values()]
      .filter((entry) => {
        return entry !== asking && entry.sum > 0;
      })
      .toSorted((a, b) => {
        return b.sum - a.sum || a.began - b.began;
      });
    const gone: IEntry[] = [];
    let units = bytes;

    for (;;) {
      const taken = Math.min(Math.max(messageBytesBudget - held, 0), units);

      asking.sum += taken;
      held += taken;
      units -= taken;

      if (units === 0) {
        return { gone, isCastOff: false };
      }

      const top = others.shift();

      if (top === undefined || isBefore(asking, { other: top, sum: asking.sum + 1 })) {
        releaseOf(asking);

        return { gone, isCastOff: true };
      }

      // * released at once, so the next unit meets the budget settled
      releaseOf(top);
      gone.push(top);
    }
  };

  const holderOf = (options: IMessageHolderOptions): IMessageHolder => {
    const entry: IEntry = { ...options, began: 0, sum: 0 };

    const holder: IMessageHolder = {
      get held() {
        return entry.sum;
      },
      begin: () => {
        ordinal += 1;
        entry.began = ordinal;
      },
      charge: (bytes) => {
        const { gone, isCastOff } = castOffBy(entry, bytes);

        // * told once the charge settled, so what a cast-off does meets the budget settled
        for (const each of gone) {
          each.castOff();
        }

        return !isCastOff;
      },
      release: () => {
        releaseOf(entry);
      },
    };

    entries.set(holder, entry);

    return holder;
  };

  return {
    get held() {
      return held;
    },
    forget: (holder) => {
      const entry = entries.get(holder);

      if (entry !== undefined) {
        releaseOf(entry);
        entries.delete(holder);
      }
    },
    holderOf,
  };
};
