// ── Parcel properties ─────────────────────────────────────────────────────────

// What a broker's parcel reader and writer hold of any bytes (spec 15.17, 15.18), which the
// `broker-parcel` fuzz target and `broker-parcel-fuzz.test.ts` share; the Rust side's twin is
// `bead::testing::parcels`.

// dependencies

import { isDeepStrictEqual } from 'node:util';
import { bytesOfHex, ordered } from '../../../router/shared/__tests__/mutations';
import {
  type IParcel,
  isToken,
  KIND_NAMES,
  LARGEST_RECEIVE_BOUND,
  LEAST_RECEIVE_BOUND,
  PARCEL_LAYOUT,
  ParcelKind,
  readParcel,
  writeParcel,
} from '../broker-parcel';
import { ProgrammerError } from '../errors';

// constants

/** The writer's own refusal of what would not read back: never met by a parcel that read. */
const READ_BACK = 'a parcel this side refuses is never written';

// helpers

/** A parcel's fields, its bytes in hexadecimal, for a break's words. */
const describe = (fields: IParcel): string => {
  return JSON.stringify(fields, (_key, value: unknown) => {
    return value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value;
  });
};

/** Whether `one` and `other` are the same bytes. */
const isSame = (one: Uint8Array, other: Uint8Array): boolean => {
  return Buffer.from(one).equals(Buffer.from(other));
};

// definition

/**
 * Whether the side's writer refuses `fields` by design (spec 15.18): a layout other than `0xB1`, an
 * advisory kind or one not assigned, or an OPEN or an ACCEPT that names no token or a receive bound
 * outside 1,024 to 2^32 - 1. Such a parcel a side reads and no writer writes.
 */
export const isRefusedByDesign = (fields: IParcel): boolean => {
  const { bound, id, kind, layout } = fields;
  const isOpening = kind === ParcelKind.OPEN || kind === ParcelKind.ACCEPT;
  const isOpenAsWritten =
    isToken(id ?? '') &&
    bound !== undefined &&
    bound >= LEAST_RECEIVE_BOUND &&
    bound <= LARGEST_RECEIVE_BOUND;

  return (
    layout !== PARCEL_LAYOUT || KIND_NAMES[kind] === undefined || (isOpening && !isOpenAsWritten)
  );
};

/**
 * What `input` breaks of the properties, in words; none where it holds them: the reader gives a
 * parcel, no parcel or a parcel that does not read; a parcel that reads is written again, its
 * writer refusing exactly those it refuses by design and never with its read-back refusal; what it
 * writes reads as the same parcel and writes again to the same bytes. What the reader or the writer
 * throws other than the writer's documented refusal, a `ProgrammerError`, goes on.
 */
export const parcelBreakOf = (input: Uint8Array): string | undefined => {
  const read = readParcel(input);

  if (!('parcel' in read)) {
    return undefined;
  }

  const fields = read.parcel;
  let written: Uint8Array;

  try {
    written = writeParcel(fields);
  } catch (reason) {
    if (!(reason instanceof ProgrammerError)) {
      throw reason;
    }

    if (reason.message.startsWith(READ_BACK)) {
      return `${reason.message}: ${describe(fields)}`;
    }

    return isRefusedByDesign(fields)
      ? undefined
      : `refused, not by design, ${reason.message}: ${describe(fields)}`;
  }

  if (isRefusedByDesign(fields)) {
    return `written, where it is refused by design: ${describe(fields)}`;
  }

  const again = readParcel(written);

  if (!('parcel' in again) || !isDeepStrictEqual(again.parcel, fields)) {
    return `what it wrote reads as ${JSON.stringify(again)}: ${describe(fields)}`;
  }

  return isSame(writeParcel(again.parcel), written)
    ? undefined
    : `written again to other bytes: ${describe(fields)}`;
};

/**
 * The seeds of `spec/vectors.json`: the bytes of every parcel and of every message refused as one,
 * ordered by their SHA-1, as every side draws them.
 */
export const parcelSeedsOf = (vectors: {
  parcelRefusals: readonly { bytes: string }[];
  parcels: readonly { bytes: string }[];
}): Uint8Array[] => {
  return ordered(
    [...vectors.parcels, ...vectors.parcelRefusals].map(({ bytes }) => {
      // * no byte at all is a message refused too
      const read = bytes.trim() === '' ? new Uint8Array() : bytesOfHex(bytes);

      if (read === undefined) {
        throw new Error(`${JSON.stringify(bytes)} is no hexadecimal`);
      }

      return read;
    })
  );
};
