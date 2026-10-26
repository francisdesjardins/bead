// ── Proto records ─────────────────────────────────────────────────────────────

// The check of a `proto` payload's records, on `Probe`, the message of `spec/codecs.proto`, and on
// a descriptor written here where `Probe` reaches no case. The C# side's `ProtoRecordsTests` plays
// the same sentences; `spec/codecs.json`'s entries play the check through the generated codec.

// dependencies

import { type DescMessage, ScalarType } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';
import { ProbeSchema } from '../../router/shared/__tests__/codecs_pb';
import { checkProtoRecords } from '../records';

// helpers

/** The bytes of `hex`, two digits each, a space between. */
const bytesOf = (hex: string): Uint8Array => {
  return Uint8Array.from(hex.split(' ').filter(Boolean), (pair) => {
    return Number.parseInt(pair, 16);
  });
};

/** `length` as a varint. */
const varintOf = (length: number): number[] => {
  const bytes: number[] = [];
  let rest = length;

  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }

  bytes.push(rest);

  return bytes;
};

/** A length-delimited record of the tag `tag`, `body` after its length. */
const recordOf = (tag: number, body: number[]): number[] => {
  return [tag, ...varintOf(body.length), ...body];
};

/** A `Probe` with `count` messages below it through `child`, each holding the next. */
const childrenDeep = (count: number): number[] => {
  let bytes: number[] = [];

  for (let index = 0; index < count; index += 1) {
    bytes = recordOf(0x1a, bytes);
  }

  return bytes;
};

/** A `Probe` with `count` groups below it through `delimited`, each holding the next. */
const groupsDeep = (count: number): number[] => {
  const opened: number[] = Array.from<number>({ length: count }).fill(0x6b);
  const closed: number[] = Array.from<number>({ length: count }).fill(0x6c);

  return [...opened, ...closed];
};

/** A `Probe` with `count` maps' entries below it through `children`, each value holding the next. */
const entriesDeep = (count: number): number[] => {
  let bytes: number[] = [];

  for (let index = 0; index < count; index += 1) {
    bytes = recordOf(0x62, recordOf(0x12, bytes));
  }

  return bytes;
};

/** What checking `bytes` against `message` throws; none when it takes them. */
const thrownBy = (bytes: Uint8Array | number[], message: DescMessage = ProbeSchema): unknown => {
  try {
    checkProtoRecords(Uint8Array.from(bytes), message);
  } catch (error) {
    return error;
  }

  return undefined;
};

/** Each of `payloads` refused, a `SyntaxError`, as a codec's reader refuses. */
const expectRefused = (payloads: readonly string[]): void => {
  for (const hex of payloads) {
    expect(thrownBy(bytesOf(hex)), hex).toBeInstanceOf(SyntaxError);
  }
};

// definition

test.describe("the check of a proto payload's records", () => {
  test('refuses reserved wire types on unknown fields as well as known fields', () => {
    for (const hex of ['A0 06 01', '1A 03 A0 06 01']) {
      expect(thrownBy(bytesOf(hex)), hex).toBeUndefined();
    }
    for (const hex of ['0E', '0F', 'A6 06', 'A7 06', '1A 02 A6 06', '1A 02 A7 06']) {
      expect(thrownBy(bytesOf(hex)), hex).toBeInstanceOf(SyntaxError);
    }
  });

  test('reads enum map values as varints and refuses other wire types or undeclared entry fields', () => {
    const message = {
      fields: [{ fieldKind: 'map', mapKey: ScalarType.STRING, mapKind: 'enum', number: 1 }],
    } as unknown as DescMessage;

    for (const hex of [
      '',
      '0A 00',
      '0A 03 0A 01 61',
      '0A 02 10 01',
      '0A 05 0A 01 61 10 01',
      '0A 05 10 01 0A 01 61',
      '0A 02 10 7F',
      '0A 04 10 01 10 00',
    ]) {
      expect(thrownBy(bytesOf(hex), message), hex).toBeUndefined();
    }

    for (const hex of [
      '0A 02 12 00',
      '0A 05 15 00 00 00 00',
      '0A 02 13 14',
      '0A 02 18 01',
      '0A 02 10 80',
      '0A 02 08 01',
    ]) {
      expect(thrownBy(bytesOf(hex), message), hex).toBeInstanceOf(SyntaxError);
    }
  });

  test('takes every record a message holds, a group closed by its own end group, a map of messages, a repeated scalar packed or not, and an unknown field of each wire type skipped', () => {
    const payloads = [
      '',
      '0A 01 61 10 07 1A 02 10 01',
      // a group, closed by its own end group, and one in a child
      '6B 0A 01 61 6C',
      '1A 05 6B 0A 01 61 6C',
      // a map of messages, its key and value in either order, and either left out
      '62 07 0A 01 6B 12 02 10 01',
      '62 07 12 03 0A 01 78 0A 00',
      '62 00 62 02 0A 00 62 02 12 00',
      // counts packed and not, stamps packed and not, in one message
      '50 01 52 03 02 03 04 5D 01 00 00 00 5A 08 01 00 00 00 02 00 00 00 52 00',
      // an unknown field of each wire type: I64, LEN, I32, VARINT, and a group, empty or not
      '21 01 02 03 04 05 06 07 08 2A 01 7A 35 01 02 03 04 48 07 23 24 23 08 01 2A 00 24',
      // a varint of 10 bytes, its field known and not, and a tag of 5 bytes within 32 bits
      '10 FF FF FF FF FF FF FF FF FF 01 48 80 80 80 80 80 80 80 80 80 00',
      'C8 80 80 80 00 01 F8 FF FF FF 0F 01 0A 01 62',
    ];

    for (const hex of payloads) {
      expect(thrownBy(bytesOf(hex)), hex).toBeUndefined();
    }
  });

  test('refuses a record past the end of its message, at any depth, its field known or not', () => {
    // spec 17.9.1
    expectRefused([
      // a child's unknown fixed32, unknown length-delimited and unknown varint; its known string
      '0A 01 61 1A 02 25 00 0A 01 62',
      '1A 02 2A 05 0A 03 61 62 63',
      '1A 02 48 80 10 01',
      '1A 02 0A 03 61 62 63',
      // a string in a map's value, and in a child's child
      '62 06 12 04 0A 04 61 62 10 07',
      '1A 04 1A 02 0A 02 10 07',
      // a string in a group, past the payload, and a group never closed
      '6B 0A 05 61 6C',
      '6B 0A 01 61',
    ]);
  });

  test('refuses a packed record whose values do not end at its length', () => {
    // spec 17.9.1
    expectRefused([
      // a fixed width that does not divide the record, short and long
      '5A 05 01 00 00 00 02',
      '5A 03 01 00 00 10 07',
      // a last varint that runs past the record, into a field after it, and past the payload
      '52 02 05 81 10 01 10 07',
      '52 01 81',
    ]);
  });

  test('refuses a varint of more than 10 bytes, its field known or not', () => {
    // spec 17.9.1
    expectRefused([
      '10 80 80 80 80 80 80 80 80 80 80 01',
      '48 80 80 80 80 80 80 80 80 80 80 00',
      '52 0B 80 80 80 80 80 80 80 80 80 80 01',
      '1A 0C 48 80 80 80 80 80 80 80 80 80 80 00',
    ]);
  });

  test('refuses a tag of more than 5 bytes, or past 32 bits', () => {
    // spec 17.9.1
    expectRefused([
      '90 80 80 80 80 00 07',
      '90 80 80 80 80 80 80 80 00 07',
      '90 80 80 80 40 07',
      '90 80 80 80 80 80 0F 07',
      'F8 FF FF FF 7F 01',
      '90 80 80 80 80 80 80 80 80 80 80 80 00 07',
      // field number 0, the wire types 6 and 7, and an end group that closes no group
      '00 01',
      '4E',
      '4F',
      '24',
      '6B 0A 01 61 44',
    ]);
  });

  test('refuses a length past the bytes that follow it, a varint past 32 bits among them', () => {
    // spec 17.9.1
    expectRefused([
      '0A 05 61 62',
      '2A 05 61',
      '0A 80 80 80 80 10',
      '0A 80 80 80 80 10 10 07',
      '0A FF FF FF FF FF FF FF FF FF 01',
      '0A 80 80 80 80 80 80 80 80 80 80 00',
    ]);
  });

  test('refuses a message nested more than 100 deep below the top one, groups and map entries counted', () => {
    // spec 17.9.3: an entry counts as a message, its value as another
    expect(thrownBy(childrenDeep(100))).toBeUndefined();
    expect(thrownBy(childrenDeep(101))).toBeInstanceOf(SyntaxError);
    expect(thrownBy(groupsDeep(100))).toBeUndefined();
    expect(thrownBy(groupsDeep(101))).toBeInstanceOf(SyntaxError);
    expect(thrownBy(entriesDeep(50))).toBeUndefined();
    expect(thrownBy(entriesDeep(51))).toBeInstanceOf(SyntaxError);

    // an unknown group counts as a message: under 99 children, the 100th below the top
    const groupUnder = (count: number): number[] => {
      let bytes = [0x23, 0x24];

      for (let index = 0; index < count; index += 1) {
        bytes = recordOf(0x1a, bytes);
      }

      return bytes;
    };

    expect(thrownBy(groupUnder(99))).toBeUndefined();
    expect(thrownBy(groupUnder(100))).toBeInstanceOf(SyntaxError);
  });

  test("builds a message's shape once, from its descriptor, a message that holds itself among them", () => {
    // a descriptor of the fields the check reads alone: a message whose field 3 holds itself
    let reads = 0;
    const fields: object[] = [];
    const looped = {
      get fields(): object[] {
        reads += 1;

        return fields;
      },
    } as unknown as DescMessage;

    fields.push({ delimitedEncoding: false, fieldKind: 'message', message: looped, number: 3 });

    expect(thrownBy(bytesOf('1A 04 1A 02 1A 00'), looped)).toBeUndefined();
    // its child walked by the same shape: field 3 at the varint wire type, two deep
    expect(thrownBy(bytesOf('1A 04 1A 02 18 01'), looped)).toBeInstanceOf(SyntaxError);
    expect(reads).toBe(1);
  });

  test("refuses a field at a wire type its type does not take, in a map's entry too", () => {
    // spec 17.9.5
    expectRefused([
      '08 61',
      '12 00',
      '15 01 02 03 04',
      '18 03 0A 05 61 62 63 64 65',
      '1B 1C',
      '55 01 00 00 00',
      '58 01',
      '6A 03 0A 01 61',
      // an entry's key at the varint wire type, and its value at the varint and the group's
      '62 04 08 02 12 00',
      '62 04 0A 00 10 01',
      '62 04 0A 00 13 14',
      // a child's field
      '1A 02 08 61',
    ]);
  });

  test("refuses a map's entry with a field it does not declare", () => {
    // spec 17.9.6
    expectRefused([
      '62 0C 1A 0A 01 7A 12 06 0A 04 61 62 63 64',
      '62 05 0A 00 1A 01 7A',
      '62 04 0A 00 18 01',
      '62 07 0A 00 1D 01 02 03 04',
    ]);
  });
});
