// ── Broker sequence ───────────────────────────────────────────────────────────

// dependencies

import { CloseCode, PARCEL_PREFIX_BYTES } from './broker-parcel';
import type { IClock, TimeoutId } from './clock';
import { GenericError } from './errors';

// interfaces

/** One direction of a connection, as its receiver numbers what comes (spec 15.19). */
export interface IBrokerSequence {
  /** The sequence it awaits next. */
  readonly awaited: number;
  /** What a parcel of `sequence` is: the next, taken; a copy, below it; a loss, past it. */
  take(sequence: number): SequenceVerdict;
}

/** What a participant holds in parts across its connections, bounded by its `heldBytesBudget`. */
export interface IHeldBytes {
  readonly budget: number;
  readonly held: number;
  give(bytes: number): void;
  /** Charges `bytes`, or refuses them when they would take what it holds past its budget. */
  take(bytes: number): boolean;
}

/** What bounds an envelope's parts, at both ends (spec 15.20). */
export interface IPartsBounds {
  /** Milliseconds from an envelope's first part before its rate is held. */
  readonly bodyGracePeriod: number;
  /** The clock its rate is held on: the one its side is given. */
  readonly clock: IClock;
  /** One envelope's parts together, at most. */
  readonly maximumEnvelopePartsBytes: number;
  /** The slowest, in bytes a second, parts may come once the grace passed. */
  readonly minimumBodyBytesPerSecond: number;
}

/** One direction's envelope in parts, as its receiver holds it until its last part came. */
export interface IBrokerParts {
  /** What it holds now. */
  readonly bytes: number;
  /** One DATA's part: whole once `isLast`, with the credential its first part carried. */
  add(
    part: Uint8Array,
    options: { credential?: string | undefined; isLast: boolean }
  ): PartsVerdict;
  /** Lets go of what it holds, its budget given back and its rate no longer held. */
  stop(): void;
}

/** Why a connection is lost of its own: its CLOSE's code, and the report naming the bound. */
export interface IBrokerLoss {
  readonly code: number;
  readonly reason: string;
}

// types

/** What a parcel's sequence is to its receiver: {@link SEQUENCE_VERDICTS}. */
export type SequenceVerdict = (typeof SEQUENCE_VERDICTS)[keyof typeof SEQUENCE_VERDICTS];

/** A part taken: the envelope it ends, held for more, or the connection lost past a bound. */
export type PartsVerdict =
  | { readonly credential?: string | undefined; readonly envelope: Uint8Array }
  | { readonly held: true }
  | { readonly lost: IBrokerLoss };

// constants

/** A parcel's sequence, to its receiver (spec 15.19). */
export const SEQUENCE_VERDICTS = Object.freeze({
  /** Below the next awaited: what its broker delivered again, dropped in silence. */
  COPY: 'copy',
  /** Past the next awaited: a parcel dropped for good, which loses the connection. */
  LOSS: 'loss',
  /** The next awaited, taken and handed on. */
  NEXT: 'next',
});

/** What a participant holds in parts by default, across its connections (spec 15.23). */
export const HELD_BYTES_BUDGET = 268_435_456;

// helpers

/** The report of a loss to a gap, naming the sequence awaited and the one that came (spec 15.19). */
export const gapOf = ({ awaited, came }: { awaited: number; came: number }): IBrokerLoss => {
  return {
    code: CloseCode.LOST,
    reason: `a parcel lost: ${String(awaited)} was awaited, and ${String(came)} came`,
  };
};

/**
 * An envelope cut in parts for a peer (spec 15.20): each parcel at most `room` bytes, each part as
 * large as that lets it but the last, the credential on the first alone. One part when it fits;
 * none fits a credential that leaves the first no byte, a {@link GenericError}.
 */
export const partsOf = (
  envelope: Uint8Array,
  { credentialBytes, room }: { credentialBytes: number; room: number }
): Uint8Array[] => {
  const first = room - PARCEL_PREFIX_BYTES - (credentialBytes === 0 ? 0 : 2 + credentialBytes);
  const next = room - PARCEL_PREFIX_BYTES;

  if (first < 1 || next < 1) {
    throw new GenericError(
      `a parcel of ${String(room)} bytes leaves no byte of an envelope beside its credential`
    );
  }

  if (envelope.length <= first) {
    return [envelope];
  }

  const parts = [envelope.subarray(0, first)];

  for (let at = first; at < envelope.length; at += next) {
    parts.push(envelope.subarray(at, at + next));
  }

  return parts;
};

/** What a participant holds in parts, charged by each part and given back once it is done. */
export const createHeldBytes = (budget: number): IHeldBytes => {
  let held = 0;

  return {
    budget,
    get held() {
      return held;
    },
    give: (bytes) => {
      held -= bytes;
    },
    take: (bytes) => {
      if (held + bytes > budget) {
        return false;
      }

      held += bytes;

      return true;
    },
  };
};

// definition

/**
 * One direction's sequence, as its receiver awaits it (spec 15.19): from `awaited`, one more each;
 * below it, a copy; past it, a loss, since a broker keeps a publisher's order on one topic and
 * resends nothing into a link that kept no session, so a gap never fills. No set of ids is kept.
 */
export const createBrokerSequence = (awaited = 1): IBrokerSequence => {
  let next = awaited;

  return {
    get awaited() {
      return next;
    },
    take: (sequence) => {
      if (sequence < next) {
        return SEQUENCE_VERDICTS.COPY;
      }

      if (sequence > next) {
        return SEQUENCE_VERDICTS.LOSS;
      }

      next += 1;

      return SEQUENCE_VERDICTS.NEXT;
    },
  };
};

/**
 * One direction's envelope in parts (spec 15.20): held until its last part came, then handed on
 * whole with the credential its first part carried. Past `maximumEnvelopePartsBytes` the connection
 * closes with 1009; a part that would take what its participant holds past its budget, or parts
 * slower than `minimumBodyBytesPerSecond` once `bodyGracePeriod` passed since its first part, on the
 * clock given, lose it with 4000, `slow` hearing that last. Each loss names its bound and its value.
 */
export const createBrokerParts = (
  { held, slow }: { held: IHeldBytes; slow: (loss: IBrokerLoss) => void },
  { bodyGracePeriod, clock, maximumEnvelopePartsBytes, minimumBodyBytesPerSecond }: IPartsBounds
): IBrokerParts => {
  let parts: Uint8Array[] = [];
  let bytes = 0;
  let credential: string | undefined;
  let firstAt = 0;
  let timer: TimeoutId | undefined;

  const stop = (): void => {
    clock.clearTimeout(timer);
    timer = undefined;
    held.give(bytes);
    parts = [];
    bytes = 0;
    credential = undefined;
  };
  // * due once the parts have not brought what the longer of the grace and their rate asks of them,
  // as section 15.12 holds a body; a rate of 0 holds none
  const pace = (): void => {
    if (minimumBodyBytesPerSecond === 0) {
      return;
    }

    const due =
      firstAt + Math.max(bodyGracePeriod, Math.ceil((bytes * 1_000) / minimumBodyBytesPerSecond));

    clock.clearTimeout(timer);
    timer = clock.setTimeout(
      () => {
        timer = undefined;
        stop();
        slow({
          code: CloseCode.LOST,
          reason: `an envelope's parts came slower than minimumBodyBytesPerSecond, ${String(minimumBodyBytesPerSecond)} bytes a second, past bodyGracePeriod, ${String(bodyGracePeriod)} ms`,
        });
      },
      // ! a millisecond at least, counted whole: no timer is armed for less (decision 0011)
      Math.max(1, Math.ceil(due - clock.performance.now()))
    );
    // a browser's timer has no `unref`
    (timer as { unref?: () => unknown }).unref?.();
  };

  return {
    get bytes() {
      return bytes;
    },
    add: (part, { credential: carried, isLast }) => {
      if (parts.length === 0 && isLast) {
        return { credential: carried, envelope: part };
      }

      // ! a credential on the first part alone (spec 15.20)
      if (parts.length > 0 && carried !== undefined) {
        stop();

        return {
          lost: {
            code: CloseCode.PROTOCOL_ERROR,
            reason: 'a part past the first of an envelope carries a credential',
          },
        };
      }

      if (bytes + part.length > maximumEnvelopePartsBytes) {
        stop();

        return {
          lost: {
            code: CloseCode.TOO_BIG,
            reason: `an envelope's parts would pass maximumEnvelopePartsBytes, ${String(maximumEnvelopePartsBytes)} bytes`,
          },
        };
      }

      if (!held.take(part.length)) {
        stop();

        return {
          lost: {
            code: CloseCode.LOST,
            reason: `a part would pass its participant's heldBytesBudget, ${String(held.budget)} bytes`,
          },
        };
      }

      if (parts.length === 0) {
        firstAt = clock.performance.now();
        credential = carried;
      }

      parts.push(part);
      bytes += part.length;

      if (!isLast) {
        return (pace(), { held: true });
      }

      const envelope = new Uint8Array(bytes);
      let at = 0;

      for (const each of parts) {
        envelope.set(each, at);
        at += each.length;
      }

      const whole = { credential, envelope };

      stop();

      return whole;
    },
    stop,
  };
};
