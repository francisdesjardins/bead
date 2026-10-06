// ── Codecs ────────────────────────────────────────────────────────────────────

// Bead's codecs, `spec/codecs.json`, played against the TypeScript side's: each payload read, and
// written back or refused, and each value written or refused, through the codec of its encoding.
// The C# side plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { type IPayloadCodec, PAYLOAD_CODECS } from '../payloads';

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
  encoding: keyof typeof PAYLOAD_CODECS;
  name: string;
  refused?: string;
  /** The bytes written, in hexadecimal, two digits each and a space between. */
  written?: string;
}

/** Bytes read, in hexadecimal. */
interface IPayloadEntry extends IEntry {
  bytes: string;
}

/** A value given to a writer, in one of the file's seven forms. */
interface IValueEntry extends IEntry {
  value: {
    bytes?: string;
    double?: string;
    form?: 'loneSurrogate' | 'loneSurrogateName' | 'nameTwice' | 'undefined';
    json?: unknown;
    nested?: number;
    number?: string;
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

  test('plays every entry of the file but the one a row of the matrix excuses this side from', () => {
    expect(
      [...CODECS.payloads, ...CODECS.values]
        .filter((entry) => {
          return isExcused(entry);
        })
        .map(({ name }) => {
          return name;
        })
    ).toEqual(['an object naming a member twice']);
  });

  for (const entry of CODECS.payloads) {
    test(`payloads: ${entry.name}`, () => {
      test.skip(isExcused(entry), 'a row of the matrix excuses this side');

      const codec = PAYLOAD_CODECS[entry.encoding] as IPayloadCodec<unknown>;

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

      const codec = PAYLOAD_CODECS[entry.encoding] as IPayloadCodec<unknown>;
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
});
