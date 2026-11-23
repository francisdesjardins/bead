// ── WebSocket message budget ──────────────────────────────────────────────────

// interfaces

/** One connection's share of a budget: what its message partway holds (spec 15.12). */
export interface IMessageHolder {
  /** What its message partway holds. */
  readonly held: number;
  /** Its message began: among equal sums, the one that began first is cast off first. */
  begin(): void;
  /**
   * Charges its message `bytes`, casting off as few other holders as fit them, each by its
   * `castOff`; false when it is cast off itself, its charge not taken and what it held released,
   * its own `castOff` left to its caller, which fails it once it handed on what came before.
   */
  charge(bytes: number): boolean;
  /** Its message whole, or its connection failed: what it held released. Idempotent. */
  release(): void;
}

/** What one holder is: how it is cast off, and whether its message is past its grace. */
export interface IMessageHolderOptions {
  /**
   * Fails its connection with 1013, at once, once the budget released what it held: a holder
   * another's charge casts off.
   */
  castOff: () => void;
  /** Whether its message partway is past its `bodyGracePeriod`, on its rate's clock. */
  isPastGrace: () => boolean;
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
 * A budget of `messageBytesBudget` bytes, shared by a server's connections (spec 15.12). A charge
 * that would pass it casts off holders, as few as fit it, its own charge counted in its own sum:
 * those whose message is past its grace before those within it, then the one that holds the most,
 * then the one whose message began first. The asking holder is cast off only when it comes first,
 * or when its own sum would pass the budget alone, which no other's cast-off fits; each one cast
 * off fails with 1013, IANA's "Try Again Later".
 */
export const createMessageBudget = (messageBytesBudget: number): IMessageBudget => {
  const entries = new Map<IMessageHolder, IEntry>();
  let held = 0;
  let ordinal = 0;

  const releaseOf = (entry: IEntry): void => {
    held -= entry.sum;
    entry.sum = 0;
  };

  // whom a charge of `bytes` by `asking` casts off, in order; none where it fits
  const castOffBy = (asking: IEntry, bytes: number): IEntry[] => {
    if (held + bytes <= messageBytesBudget) {
      return [];
    }

    const sumOf = (entry: IEntry): number => {
      return entry === asking ? entry.sum + bytes : entry.sum;
    };

    // ! no other's cast-off fits a sum past the budget alone
    if (sumOf(asking) > messageBytesBudget) {
      return [asking];
    }

    const holders = [...entries.values()].filter((entry) => {
      return entry === asking || entry.sum > 0;
    });
    const isPast = new Map(
      holders.map((entry) => {
        return [entry, entry.isPastGrace()];
      })
    );
    const order = holders.toSorted((a, b) => {
      return (
        Number(isPast.get(b)) - Number(isPast.get(a)) || sumOf(b) - sumOf(a) || a.began - b.began
      );
    });

    if (order[0] === asking) {
      return [asking];
    }

    const gone: IEntry[] = [];
    let total = held + bytes;

    for (const entry of order) {
      if (total <= messageBytesBudget) {
        break;
      }

      if (entry !== asking) {
        gone.push(entry);
        total -= entry.sum;
      }
    }

    return gone;
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
        const gone = castOffBy(entry, bytes);

        // * released before any is cast off, so what a cast-off does meets the budget settled
        for (const each of gone) {
          releaseOf(each);
        }

        const isTaken = !gone.includes(entry);

        if (isTaken) {
          entry.sum += bytes;
          held += bytes;
        }

        for (const each of gone) {
          if (each !== entry) {
            each.castOff();
          }
        }

        return isTaken;
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
