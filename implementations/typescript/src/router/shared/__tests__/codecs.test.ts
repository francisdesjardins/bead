// ── Codecs ────────────────────────────────────────────────────────────────────

// Bead's codecs, `spec/codecs.json`, played against the TypeScript side's: each payload read, and
// written back or refused, and each value written or refused, through its encoding's codec —
// `proto`'s over the generated `Probe`, as generated code makes one. The C# side plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { create, fromBinary, type MessageInitShape, toBinary } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';
import { checkProtoRecords } from '../../../proto/records';
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

/** What a `proto` reader read of a `Probe`: its text in UTF-16 code units, number, depth below it. */
interface IProbeHeld {
  nested: number;
  number: number;
  text: string;
}

/** What a `proto` reader read of the top `Probe`: what it holds, each field where it holds any. */
interface IProbeRead extends IProbeHeld {
  children?: Record<string, IProbeHeld>;
  counts?: number[];
  delimited?: IProbeHeld;
  stamps?: number[];
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
 * `Probe`'s codec, as generated code makes a `proto` binding's: its records checked against its
 * descriptor, then protobuf-es's reader with spec 17.9.3's bound, and its writer over the
 * initializer it takes.
 */
const PROBE_CODEC = payloadCodecOf<Probe, MessageInitShape<typeof ProbeSchema>>({
  decode: (bytes) => {
    checkProtoRecords(bytes, ProbeSchema);

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

/**
 * How deep messages nest below `probe`, at the deepest: through `child` and `delimited`, and
 * through each of `children`, its entry counting as a message and its value as another.
 */
const nestedBelow = (probe: Probe): number => {
  let deepest = 0;

  for (const below of [probe.child, probe.delimited]) {
    if (below !== undefined) {
      deepest = Math.max(deepest, 1 + nestedBelow(below));
    }
  }

  for (const value of Object.values(probe.children)) {
    deepest = Math.max(deepest, 2 + nestedBelow(value));
  }

  return deepest;
};

/** What a read of a `Probe` the top one holds gives, as the file writes it. */
const heldOf = (probe: Probe): IProbeHeld => {
  return { nested: nestedBelow(probe), number: probe.number, text: unitsOf(probe.text) };
};

/** What a read of `probe` gives, as the file writes it: each field it holds any of, beside its own. */
const readOf = (probe: Probe): IProbeRead => {
  const keys = Object.keys(probe.children).toSorted();

  return {
    ...heldOf(probe),
    ...(probe.counts.length === 0 ? {} : { counts: [...probe.counts] }),
    ...(probe.stamps.length === 0 ? {} : { stamps: [...probe.stamps] }),
    ...(keys.length === 0
      ? {}
      : {
          children: Object.fromEntries(
            keys.map((key) => {
              return [unitsOf(key), heldOf(probe.children[key] as Probe)];
            })
          ),
        }),
    ...(probe.delimited === undefined ? {} : { delimited: heldOf(probe.delimited) }),
  };
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
    ).toEqual(["a string's leading U+FEFF", 'an object naming a member twice']);

    // * each value one no JavaScript value holds, which this side cannot build; the payload, protobuf-es's
    // own reading, which the test below holds
    for (const entry of CODECS.values.filter((value) => {
      return isExcused(value);
    })) {
      expect(
        thrownBy(() => {
          return valueOf(entry);
        }),
        entry.name
      ).toBeInstanceOf(Error);
    }
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
    test(`reads each payload, then refuses it or writes back its bytes, handing on the value of its canonical form: ${entry.name}`, () => {
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
    test(`writes each value given in its form to its bytes, or refuses it: ${entry.name}`, () => {
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

  // * the matrix's rows of protobuf-es: where it parts from 17.9.4, and where Bead states no rule

  test("a string's leading U+FEFF in a proto payload, as protobuf-es strips it", () => {
    expect(readOf(PROBE_CODEC.decode(bytesOf('0A 04 EF BB BF 61')))).toEqual({
      nested: 0,
      number: 0,
      text: '0061',
    });
  });

  test('a proto string holding a surrogate alone, as protobuf-es writes it', () => {
    // U+FFFD in its place, where a text or a json writer refuses it
    expect(hexOf(PROBE_CODEC.encode({ text: LONE_SURROGATE }))).toBe('0A 05 61 EF BF BD 62');
  });

  test("a proto map's entry, its key at its default, as protobuf-es writes it", () => {
    // * the empty key written, where Google.Protobuf leaves it out as any field at its default
    expect(hexOf(PROBE_CODEC.encode({ children: { '': {} } }))).toBe('62 04 0A 00 12 00');
  });
});
