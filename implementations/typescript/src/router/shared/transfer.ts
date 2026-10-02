// ── Transfer ──────────────────────────────────────────────────────────────────

// dependencies

import type { IProtocolFailure, IRouterFailures, IRouterLimits } from './types';

// interfaces

/** One chunk to send: its bytes, where they start in the whole payload, and whether they end it. */
export interface IChunk {
  bytes: Uint8Array;
  isLast: boolean;
  offset: number;
}

/** What a sender holds of a payload it sends as a transfer, the opening sent first. */
export interface IOutgoingTransfer {
  /** The end below which the receiver lets it send, from the highest credit received. */
  readonly creditEnd: number;
  /** Whether every byte went out. */
  readonly isComplete: boolean;
  /** The bytes the opening carries: the payload's first, sent without credit. */
  readonly opening: Uint8Array;
  /** The whole payload's length. */
  readonly total: number;
  /**
   * Raises the end the receiver granted, to `creditEnd` — the total at most. A credit lower than
   * one received already, come late or out of order, grants nothing.
   */
  grant(creditEnd: number): void;
  /**
   * The next chunk the credit lets go out: a full one, or the last, which reaches the total;
   * `undefined` when neither fits under the credit, so no small chunk ever goes.
   */
  nextChunk(): IChunk | undefined;
}

/** What a receiver holds of a payload it receives as a transfer, from its opening on. */
export interface IIncomingTransfer {
  /** The bytes received from the start, one after the other. */
  readonly contiguous: number;
  /** The end below which it lets its sender send, from the credits it granted. */
  readonly creditEnd: number;
  /** The whole payload's length, as the opening declared it. */
  readonly total: number;
  /**
   * The end of a credit to grant now, and granted: a window past the bytes received, once its sender
   * has used half of the last — or the rest, when less is left — and no more than `available` bytes
   * past the last end granted. `undefined` when there is none to grant.
   */
  creditToGrant(available: number): number | undefined;
  /** The whole payload, once every byte came: each byte copied once, and its pieces let go. */
  payload(): Uint8Array;
  /**
   * Places a chunk's bytes, checked in this order: within the total, not empty, `isLast` when it
   * reaches the total and only then, full when it does not — or `chunkInvalid`; within the credit —
   * or `creditExceeded`; received already, whole — a duplicate; clear of every byte received — or
   * `chunkInvalid`. Too many runs of bytes apart is `chunkInvalid` too.
   */
  place(
    bytes: Uint8Array,
    chunk: { isLast: boolean; offset: number }
  ): ChunkOutcome | IProtocolFailure;
}

// types

export type ChunkOutcome = (typeof ChunkOutcome)[keyof typeof ChunkOutcome];

// constants

/** What placing a chunk did: placed its bytes, placed none since it had them, or completed it. */
export const ChunkOutcome = Object.freeze({
  PLACED: 'placed',
  DUPLICATE: 'duplicate',
  COMPLETE: 'complete',
} as const);

// helpers

/** The payload bytes an envelope of `headerBytes` carries, as a chunk or an opening, under `limits`. */
export const chunkPayloadBytes = (
  { chunkBytes, maximumEnvelopeBytes }: Pick<IRouterLimits, 'chunkBytes' | 'maximumEnvelopeBytes'>,
  headerBytes: number
): number => {
  return Math.min(chunkBytes, maximumEnvelopeBytes) - headerBytes;
};

// definition

/**
 * A payload as its sender sends it: the opening carries its first `openingBytes`, without credit;
 * each chunk after carries `payloadBytesPerChunk` of it, or the last of it, as the receiver's credit
 * allows.
 */
export const createOutgoingTransfer = (
  payload: Uint8Array,
  { openingBytes, payloadBytesPerChunk }: { openingBytes: number; payloadBytesPerChunk: number }
): IOutgoingTransfer => {
  const total = payload.length;
  let creditEnd = openingBytes;
  let sent = openingBytes;

  return {
    get creditEnd() {
      return creditEnd;
    },
    get isComplete() {
      return sent === total;
    },
    get opening() {
      return payload.subarray(0, openingBytes);
    },
    get total() {
      return total;
    },

    grant: (granted) => {
      creditEnd = Math.max(creditEnd, Math.min(granted, total));
    },
    nextChunk: () => {
      const end = Math.min(sent + payloadBytesPerChunk, total);

      // a full chunk, or the last one, and only under the credit
      if (sent === total || end > creditEnd) {
        return undefined;
      }

      const chunk = { bytes: payload.subarray(sent, end), isLast: end === total, offset: sent };

      sent = end;

      return chunk;
    },
  };
};

/**
 * A payload as its receiver receives it: `total` bytes, the opening's first, each chunk after placed
 * at its offset, in any order, and joined once whole. Credit is granted a `windowBytes` at a time;
 * `maximumChunkRuns` bounds the runs of bytes apart it holds. A chunk before the last carries
 * `payloadBytesPerChunk` at least, as its sender sends them, and a chunk comes whole again or not at
 * all over bytes received: each piece it holds is a chunk's own bytes, never a sliver of them.
 */
export const createIncomingTransfer = (
  opening: Uint8Array,
  {
    failures,
    limits,
    payloadBytesPerChunk,
    total,
  }: {
    failures: Pick<IRouterFailures, 'chunkInvalid' | 'creditExceeded'>;
    limits: Pick<IRouterLimits, 'maximumChunkRuns' | 'windowBytes'>;
    payloadBytesPerChunk: number;
    total: number;
  }
): IIncomingTransfer | IProtocolFailure => {
  // the runs of bytes received, apart and in order, each [start, end)
  const runs: [start: number, end: number][] = [];
  // the bytes themselves, each received once, where they go, until they are joined
  const pieces: { bytes: Uint8Array; offset: number }[] = [];
  let whole: Uint8Array | undefined;
  // the opening came without credit: its own bytes are its credit
  let creditEnd = opening.length;

  const invalid = (detail: string): IProtocolFailure => {
    return { ...failures.chunkInvalid, detail };
  };

  // an opening that holds the whole payload opens no transfer
  if (opening.length >= total) {
    return invalid(
      `an opening of ${String(opening.length)} bytes holds its whole total of ${String(total)}`
    );
  }

  // bytes clear of every byte received, placed, and the runs joined around them
  const receive = (bytes: Uint8Array, offset: number): void => {
    pieces.push({ bytes, offset });

    // the runs, in order, those that touch joined into one
    const joined: [start: number, end: number][] = [];
    const end = offset + bytes.length;

    for (const run of [...runs, [offset, end] as [number, number]].toSorted(([first], [second]) => {
      return first - second;
    })) {
      const last = joined.at(-1);

      if (last !== undefined && run[0] <= last[1]) {
        last[1] = Math.max(last[1], run[1]);
      } else {
        joined.push([run[0], run[1]]);
      }
    }

    runs.splice(0, runs.length, ...joined);
  };

  const contiguousOf = (): number => {
    const [first] = runs;

    return first !== undefined && first[0] === 0 ? first[1] : 0;
  };

  if (opening.length > 0) {
    receive(opening, 0);
  }

  return {
    get contiguous() {
      return contiguousOf();
    },
    get creditEnd() {
      return creditEnd;
    },
    get total() {
      return total;
    },

    creditToGrant: (available) => {
      const next = Math.min(total, contiguousOf() + limits.windowBytes, creditEnd + available);

      // a credit waits until half a window can go at once — or the rest of the payload, when less
      if (
        next - creditEnd < Math.min(limits.windowBytes / 2, total - creditEnd) ||
        next === creditEnd
      ) {
        return undefined;
      }

      creditEnd = next;

      return creditEnd;
    },
    payload: () => {
      // joined once: the pieces go, and the whole stays what a second ask gets
      if (whole === undefined) {
        whole = new Uint8Array(total);

        for (const { bytes, offset } of pieces.splice(0)) {
          whole.set(bytes, offset);
        }
      }

      return whole;
    },
    place: (bytes, { isLast, offset }) => {
      // bounds written as differences, so no sum runs past what an integer holds
      if (offset >= total || bytes.length > total - offset) {
        return invalid(`bytes from ${String(offset)} run past the total of ${String(total)}`);
      }

      if (bytes.length === 0) {
        return invalid('a chunk carries one byte at least');
      }

      if (isLast !== (bytes.length === total - offset)) {
        return invalid(
          isLast
            ? `a last chunk from ${String(offset)} ends before the total of ${String(total)}`
            : `a chunk from ${String(offset)} reaches the total, yet says more follow`
        );
      }

      // one before the last is full, as its sender sends them, so no small chunk is held
      if (!isLast && bytes.length < payloadBytesPerChunk) {
        return invalid(
          `a chunk before the last carries ${String(payloadBytesPerChunk)} bytes at least, not ${String(bytes.length)}`
        );
      }

      if (bytes.length > creditEnd - offset) {
        return {
          ...failures.creditExceeded,
          detail: `bytes from ${String(offset)} run past the credit's end of ${String(creditEnd)}`,
        };
      }

      const isReceived = runs.some(([start, end]) => {
        return start <= offset && offset + bytes.length <= end;
      });

      if (isReceived) {
        return ChunkOutcome.DUPLICATE;
      }

      // in part over bytes received, it would hold its whole buffer for a sliver of new bytes
      const isOverlapping = runs.some(([start, end]) => {
        return start < offset + bytes.length && offset < end;
      });

      if (isOverlapping) {
        return invalid(`bytes from ${String(offset)} overlap bytes received in part`);
      }

      receive(bytes, offset);

      if (runs.length > limits.maximumChunkRuns) {
        return invalid(`more than ${String(limits.maximumChunkRuns)} runs of bytes apart`);
      }

      return contiguousOf() === total ? ChunkOutcome.COMPLETE : ChunkOutcome.PLACED;
    },
  };
};
