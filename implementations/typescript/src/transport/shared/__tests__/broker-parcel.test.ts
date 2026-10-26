// dependencies

import { expect, test } from '@playwright/test';
import { hexadecimalOf } from '../../../router/server/__tests__/expected-envelope';
import {
  fromHexadecimal,
  type IParcelVectorFields,
  VECTORS,
} from '../../../router/shared/__tests__/vectors';
import {
  type IParcel,
  isToken,
  ParcelFlag,
  ParcelKind,
  readParcel,
  writeParcel,
} from '../broker-parcel';
import { ProgrammerError } from '../errors';

// helpers

// a parcel's fields as the vectors write them: each of its bytes in hexadecimal
const fieldsOf = (parcel: IParcel): IParcelVectorFields => {
  const { acceptor, carried, incarnation, opener, ...rest } = parcel;

  return {
    ...rest,
    acceptor: hexadecimalOf(acceptor),
    opener: hexadecimalOf(opener),
    ...(carried === undefined ? {} : { carried: hexadecimalOf(carried) }),
    ...(incarnation === undefined ? {} : { incarnation: hexadecimalOf(incarnation) }),
  } as IParcelVectorFields;
};

// the vectors' fields, as the codec writes them
const parcelOf = (fields: IParcelVectorFields): IParcel => {
  const { acceptor, carried, incarnation, opener, ...rest } = fields;

  return {
    ...rest,
    acceptor: fromHexadecimal(acceptor),
    opener: fromHexadecimal(opener),
    ...(carried === undefined ? {} : { carried: fromHexadecimal(carried) }),
    ...(incarnation === undefined ? {} : { incarnation: fromHexadecimal(incarnation) }),
  };
};

// definition

test.describe('broker parcel', () => {
  test('writes and reads each kind of parcel byte for byte, reads a layout to come by its prefix, and refuses a parcel that does not read', () => {
    for (const { bytes, name, parcel, written } of VECTORS.parcels) {
      const read = readParcel(fromHexadecimal(bytes));

      expect('parcel' in read ? fieldsOf(read.parcel) : read, name).toEqual({
        ...parcel,
        ...(parcel.carried === undefined
          ? {}
          : { carried: hexadecimalOf(fromHexadecimal(parcel.carried)) }),
      });

      if (written !== false) {
        expect(hexadecimalOf(writeParcel(parcelOf(parcel))), name).toBe(
          hexadecimalOf(fromHexadecimal(bytes))
        );
      }
    }

    for (const { bytes, name, refused } of VECTORS.parcelRefusals) {
      const read = readParcel(fromHexadecimal(bytes));

      expect('refused' in read ? read.refused : 'read', name).toBe(refused);

      // * a parcel that does not read keeps its prefix, which names the connection it closes
      if ('prefix' in read) {
        expect(read.prefix.opener, name).toHaveLength(8);
      }
    }

    // each kind the file holds, and each refusal of either sort
    expect(
      new Set(
        VECTORS.parcels.map(({ parcel }) => {
          return parcel.kind;
        })
      )
    ).toEqual(new Set([...Object.values(ParcelKind), 0x80, 0xff]));
    expect(
      new Set(
        VECTORS.parcelRefusals.map(({ refused }) => {
          return refused;
        })
      )
    ).toEqual(new Set(['does-not-read', 'no-parcel']));
  });

  test('writes no parcel a side refuses, nor one of a kind no writer writes', () => {
    const opener = fromHexadecimal('11 12 13 14 15 16 17 18');
    const acceptor = fromHexadecimal('21 22 23 24 25 26 27 28');
    const none = new Uint8Array(8);
    const open = {
      acceptor: none,
      bound: 1_024,
      id: 'peer',
      incarnation: new Uint8Array(16),
      kind: ParcelKind.OPEN,
      opener,
      sequence: 1,
    };

    for (const fields of [
      { ...open, kind: 0 },
      { ...open, id: 'a/b' },
      { ...open, bound: 1_023 },
      { ...open, acceptor },
      { ...open, bound: 1_023, kind: ParcelKind.ACCEPT, acceptor },
      { acceptor: none, kind: ParcelKind.PING, opener, sequence: 2 },
      { acceptor, kind: ParcelKind.PING, opener, sequence: 0 },
      { acceptor, kind: ParcelKind.RESET, opener, sequence: 3 },
      { acceptor, flags: ParcelFlag.SECURE, kind: ParcelKind.PING, opener, sequence: 2 },
      { acceptor, kind: ParcelKind.DATA, opener, sequence: 3 },
      { acceptor, code: 1_003, kind: ParcelKind.CLOSE, opener, sequence: 3 },
      { acceptor, kind: 0x80, opener, sequence: 3 },
      { acceptor, kind: 0x0a, opener, sequence: 3 },
      { acceptor, kind: ParcelKind.PING, layout: 0xb2, opener, sequence: 2 },
    ]) {
      expect(
        () => {
          return writeParcel(fields);
        },
        JSON.stringify({ ...fields, acceptor: undefined, opener: undefined })
      ).toThrow(ProgrammerError);
    }

    // what a side sends reads back as it was written
    expect('parcel' in readParcel(writeParcel(open))).toBe(true);
  });

  test('takes a token of 1 to 64 characters of base64url’s alphabet, and nothing else', () => {
    for (const id of ['a', 'peer', '-_09AZaz', 'x'.repeat(64)]) {
      expect(isToken(id), id).toBe(true);
    }

    for (const id of ['', 'x'.repeat(65), 'peer.1', 'a/b', 'a b', 'é', '$share', 'a+b', 'a#']) {
      expect(isToken(id), id).toBe(false);
    }
  });
});
