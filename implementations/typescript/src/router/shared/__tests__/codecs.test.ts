// ── Codecs ────────────────────────────────────────────────────────────────────

// Bead's codecs, `spec/codecs.json`, played against the TypeScript side's: each payload read, and
// written back or refused, and each value written or refused, through its encoding's codec —
// `proto`'s made by `payloadCodecOf` over the generated `Probe`. The C# side plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { create, fromBinary, type MessageInitShape, toBinary } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';
import { type IPayloadCodec, PAYLOAD_CODECS, payloadCodecOf } from '../payloads';
import { type Probe, ProbeSchema } from './codecs_pb';

// interfaces

/** A row of `docs/support.md` an entry crosses, and the language it excuses. */
interface IDiffers {
  language: string;
  row: string;
}

/** What every entry holds: its name, its encoding, its outcome, and what excuses a side from it. */
interface IEntry {
  clauses: string[];
  differs?: IDiffers[];
  encoding: keyof typeof CODECS_BY_ENCODING;
  name: string;
  refused?: string;
  /** The bytes written, in hexadecimal, two digits each and a space between. */
  written?: string;
}

/** Bytes read, in hexadecimal; of a `proto` payload taken, what its reader read of them. */
interface IPayloadEntry extends IEntry {
  bytes: string;
  read?: IProbeRead;
}

/** What a `proto` reader read of the top `Probe`: its text in UTF-16 code units, number, depth. */
interface IProbeRead {
  nested: number;
  number: number;
  text: string;
}

/** A `Probe` given to a writer, one field set or none: its text as UTF-16 code units. */
interface IProbeValue {
  child?: Record<string, never>;
  number?: number;
  text?: string;
}

/** A value given to a writer, in one of the file's eight forms. */
interface IValueEntry extends IEntry {
  value: {
    bytes?: string;
    double?: string;
    form?: 'loneSurrogate' | 'loneSurrogateName' | 'nameTwice' | 'undefined';
    json?: unknown;
    nested?: number;
    number?: string;
    probe?: IProbeValue;
    text?: string;
  };
}

// constants

const CODECS = JSON.parse(
  readFileSync(new URL('../../../../../../spec/codecs.json', import.meta.url), 'utf8')
) as { payloads: IPayloadEntry[]; values: IValueEntry[] };

const LANGUAGE = 'TypeScript';

// the string the form loneSurrogate names: a, U+D800, b
const LONE_SURROGATE = `a${String.fromCharCode(0xd800)}b`;

/**
 * `Probe`'s codec, as generated code makes a `proto` binding's: protobuf-es's reader with spec
 * 17.9.3's bound, and its writer over the initializer it takes.
 */
const PROBE_CODEC = payloadCodecOf<Probe, MessageInitShape<typeof ProbeSchema>>({
  decode: (bytes) => {
    // ! protobuf-es counts the top message: 101 is spec 17.9's 100 below it
    return fromBinary(ProbeSchema, bytes, { recursionLimit: 101 });
  },
  encode: (given) => {
    return toBinary(ProbeSchema, create(ProbeSchema, given));
  },
});

// each encoding's codec, by the file's names
const CODECS_BY_ENCODING = Object.freeze({ ...PAYLOAD_CODECS, proto: PROBE_CODEC });

// helpers

/** The bytes the file writes in hexadecimal. */
const bytesOf = (hex: string): Uint8Array => {
  return Uint8Array.from(hex.split(' ').filter(Boolean), (pair) => {
    return Number.parseInt(pair, 16);
  });
};

/** `bytes` as the file writes them. */
const hexOf = (bytes: Uint8Array): string => {
  return Buffer.from(bytes)
    .toString('hex')
    .toUpperCase()
    .replace(/(..)(?!$)/g, '$1 ');
};

/** A string of the file's UTF-16 code units, four hexadecimal digits each and a space between. */
const stringOfUnits = (units: string): string => {
  return String.fromCharCode(
    ...units
      .split(' ')
      .filter(Boolean)
      .map((unit) => {
        return Number.parseInt(unit, 16);
      })
  );
};

/** `text`'s UTF-16 code units, as the file writes them. */
const unitsOf = (text: string): string => {
  return Array.from({ length: text.length }, (_, index) => {
    return text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0');
  }).join(' ');
};

/** What a read of `probe` gives, as the file writes it: how many messages nest below it. */
const readOf = (probe: Probe): IProbeRead => {
  let nested = 0;

  for (let child = probe.child; child !== undefined; child = child.child) {
    nested += 1;
  }

  return { nested, number: probe.number, text: unitsOf(probe.text) };
};

/** A `Probe`'s initializer, as a row gives one. */
const probeOf = ({ child, number, text }: IProbeValue): MessageInitShape<typeof ProbeSchema> => {
  return {
    ...(child === undefined ? {} : { child: {} }),
    ...(number === undefined ? {} : { number }),
    ...(text === undefined ? {} : { text: stringOfUnits(text) }),
  };
};

/** Whether a row of the matrix excuses this side from `entry`. */
const isExcused = (entry: IEntry): boolean => {
  return (entry.differs ?? []).some(({ language }) => {
    return language === LANGUAGE;
  });
};

/** The value a row's form names, as this side builds it. */
const valueOf = ({ value }: IValueEntry): unknown => {
  if ('json' in value) {
    return value.json;
  }

  if (value.double !== undefined) {
    const view = new DataView(new ArrayBuffer(8));

    view.setBigUint64(0, BigInt(`0x${value.double}`));

    return view.getFloat64(0);
  }

  if (value.number !== undefined) {
    return JSON.parse(value.number) as unknown;
  }

  if (value.text !== undefined) {
    return value.text;
  }

  if (value.bytes !== undefined) {
    return bytesOf(value.bytes);
  }

  if (value.nested !== undefined) {
    let nested: unknown[] = [];

    for (let depth = 1; depth < value.nested; depth += 1) {
      nested = [nested];
    }

    return nested;
  }

  if (value.probe !== undefined) {
    return probeOf(value.probe);
  }

  if (value.form === 'loneSurrogate') {
    return LONE_SURROGATE;
  }

  if (value.form === 'loneSurrogateName') {
    return { [LONE_SURROGATE]: 1 };
  }

  if (value.form === 'undefined') {
    return undefined;
  }

  throw new Error(`no value of this side holds the form ${String(value.form)}`);
};

/** What `act` throws; none when it returns. */
const thrownBy = (act: () => unknown): unknown => {
  try {
    act();
  } catch (error) {
    return error;
  }

  return undefined;
};

// definition

test.describe('the codecs', () => {
  test.describe.configure({ retries: 0 });

  test('plays every entry of the file but those a row of the matrix excuses this side from', () => {
    expect(
      [...CODECS.payloads, ...CODECS.values]
        .filter((entry) => {
          return isExcused(entry);
        })
        .map(({ name }) => {
          return name;
        })
    ).toEqual([
      "a string's leading U+FEFF",
      'an unknown varint of 11 bytes',
      'an unknown record past the end of its message',
      'a string past the end of its message',
      'a length past 32 bits',
      'a length past 32 bits, a field after',
      'an object naming a member twice',
    ]);
  });

  test('plays every encoding of the file through a codec of its own, and no other', () => {
    const encodings = new Set(
      [...CODECS.payloads, ...CODECS.values].map(({ encoding }) => {
        return encoding;
      })
    );

    expect([...encodings].toSorted()).toEqual(Object.keys(CODECS_BY_ENCODING).toSorted());
  });

  for (const entry of CODECS.payloads) {
    test(`payloads: ${entry.name}`, () => {
      test.skip(isExcused(entry), 'a row of the matrix excuses this side');

      if (entry.encoding === 'proto') {
        const read = (): IProbeRead => {
          return readOf(PROBE_CODEC.decode(bytesOf(entry.bytes)));
        };

        // * a refusal's class is protobuf-es's own: the words of a refusal are each side's
        if (entry.refused === undefined) {
          expect(read()).toEqual(entry.read);
        } else {
          expect(thrownBy(read)).toBeInstanceOf(Error);
        }

        return;
      }

      const codec = CODECS_BY_ENCODING[entry.encoding] as IPayloadCodec<unknown>;

      if (entry.refused !== undefined) {
        expect(
          thrownBy(() => {
            return codec.decode(bytesOf(entry.bytes));
          })
        ).toBeInstanceOf(SyntaxError);

        return;
      }

      const read = codec.decode(bytesOf(entry.bytes));
      const written = codec.encode(read);

      expect(hexOf(written)).toBe(entry.written);
      // * toStrictEqual tells −0 from 0, so a value read as it came, not as its canonical form, fails
      expect(codec.decode(written)).toStrictEqual(read);
    });
  }

  for (const entry of CODECS.values) {
    test(`values: ${entry.name}`, () => {
      test.skip(isExcused(entry), 'a row of the matrix excuses this side');

      const codec = CODECS_BY_ENCODING[entry.encoding] as IPayloadCodec<unknown>;
      const value = valueOf(entry);

      if (entry.refused !== undefined) {
        expect(
          thrownBy(() => {
            return codec.encode(value);
          })
        ).toBeInstanceOf(TypeError);

        return;
      }

      expect(hexOf(codec.encode(value))).toBe(entry.written);
    });
  }

  // * the matrix's rows of protobuf-es: where it parts from 17.9.1 and 17.9.4, and where Bead states
  // no rule

  test("a string's leading U+FEFF in a proto payload, as protobuf-es strips it", () => {
    expect(readOf(PROBE_CODEC.decode(bytesOf('0A 04 EF BB BF 61')))).toEqual({
      nested: 0,
      number: 0,
      text: '0061',
    });
  });

  test('a proto field at another wire type, as protobuf-es reads it', () => {
    // its text at the varint wire type, and its number at the fixed32 one, refused; its number at
    // the length-delimited one, an empty run, read as the number 0
    expect(
      thrownBy(() => {
        return PROBE_CODEC.decode(bytesOf('08 61'));
      })
    ).toBeInstanceOf(Error);
    expect(readOf(PROBE_CODEC.decode(bytesOf('12 00')))).toEqual({
      nested: 0,
      number: 0,
      text: '',
    });
    expect(
      thrownBy(() => {
        return PROBE_CODEC.decode(bytesOf('15 01 02 03 04'));
      })
    ).toBeInstanceOf(Error);
  });

  test('a proto record past the end of its message, and an unknown varint of more than 10 bytes, as protobuf-es reads them', () => {
    // the child's unknown fixed32 takes the parent's last four bytes, and its text the parent's three
    expect(readOf(PROBE_CODEC.decode(bytesOf('0A 01 61 1A 02 25 00 0A 01 62')))).toEqual({
      nested: 1,
      number: 0,
      text: '0061',
    });
    expect(PROBE_CODEC.decode(bytesOf('1A 02 0A 03 61 62 63')).child?.text).toBe('abc');
    expect(readOf(PROBE_CODEC.decode(bytesOf(`48${' 80'.repeat(10)} 00`)))).toEqual({
      nested: 0,
      number: 0,
      text: '',
    });
  });

  test('a proto length past 32 bits, as protobuf-es reads it', () => {
    // a length's fifth byte keeps 4 bits, so 0x80 0x80 0x80 0x80 0x10 is read as a length of 0
    expect(readOf(PROBE_CODEC.decode(bytesOf('0A 80 80 80 80 10')))).toEqual({
      nested: 0,
      number: 0,
      text: '',
    });
    expect(readOf(PROBE_CODEC.decode(bytesOf('0A 80 80 80 80 10 10 07')))).toEqual({
      nested: 0,
      number: 7,
      text: '',
    });
  });

  test('a proto string holding a surrogate alone, as protobuf-es writes it', () => {
    // U+FFFD in its place, where a text or a json writer refuses it
    expect(hexOf(PROBE_CODEC.encode({ text: LONE_SURROGATE }))).toBe('0A 05 61 EF BF BD 62');
  });
});
