import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { namesOnce, PAYLOAD_CODECS, payloadCodecOf } from '../payloads';

// helpers

const BACKSLASH = String.fromCharCode(0x5c);
const ENCODER = new TextEncoder();

/** `text`'s bytes in UTF-8. */
const utf8 = (text: string): Uint8Array => {
  return ENCODER.encode(text);
};

/** What `act` throws, by its class and its message; none when it returns. */
const refusalOf = (act: () => unknown): [string, string] | undefined => {
  try {
    act();
  } catch (error) {
    return [(error as Error).name, (error as Error).message];
  }

  return undefined;
};

/** `value` written by the `json` codec, as text. */
const written = (value: unknown): string => {
  return new TextDecoder().decode(PAYLOAD_CODECS.json.encode(value));
};

class Thing {
  readonly a = 1;
}

// definition

test.describe('the json codec', () => {
  test('refuses what it does not read, each in its own words, with a SyntaxError', () => {
    const refusals: [bytes: Uint8Array, words: string][] = [
      [new Uint8Array([0x22, 0xff, 0x22]), 'the payload is not UTF-8'],
      [new Uint8Array([0xef, 0xbb, 0xbf, 0x31]), 'the payload starts with a byte order mark'],
      [utf8(`${'['.repeat(65)}${']'.repeat(65)}`), 'the payload is nested deeper than 64'],
      [utf8('{"a":1,"a":2}'), 'the payload names a member twice'],
      [utf8(`"${BACKSLASH}ud800"`), 'the payload holds a surrogate alone'],
      [utf8(`{"${BACKSLASH}udc00":1}`), 'the payload holds a surrogate alone'],
      [utf8('1E400'), 'the payload holds a number past the largest double'],
    ];

    for (const [bytes, words] of refusals) {
      expect(
        refusalOf(() => {
          return PAYLOAD_CODECS.json.decode(bytes);
        }),
        words
      ).toEqual(['SyntaxError', words]);
    }

    expect(
      refusalOf(() => {
        return PAYLOAD_CODECS.json.decode(utf8('[1,]'));
      })?.[1]
    ).toMatch(/^the payload is not JSON: /);
  });

  test('refuses a string never closed as not JSON, its scan bounded by the text', () => {
    expect(
      refusalOf(() => {
        return PAYLOAD_CODECS.json.decode(utf8(`"${'x'.repeat(1_000)}`));
      })?.[1]
    ).toMatch(/^the payload is not JSON: /);
  });

  test('refuses 16 MiB of nested arrays before it parses them, within a second', () => {
    const half = 8 * 1024 * 1024;
    const bytes = utf8(`${'['.repeat(half)}${']'.repeat(half)}`);
    const started = performance.now();

    expect(
      refusalOf(() => {
        return PAYLOAD_CODECS.json.decode(bytes);
      })
    ).toEqual(['SyntaxError', 'the payload is nested deeper than 64']);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('reads −0 as 0 at every depth, and a member named __proto__ as a member', () => {
    expect(PAYLOAD_CODECS.json.decode(utf8('[-0,{"a":-0}]'))).toStrictEqual([0, { a: 0 }]);

    const read = PAYLOAD_CODECS.json.decode(utf8('{"__proto__":{"a":1},"b":2}')) as object;

    expect(Object.hasOwn(read, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
    expect(written(read)).toBe('{"__proto__":{"a":1},"b":2}');
  });

  test('refuses what JSON has no value for, each in its own words, with a TypeError', () => {
    const holed: unknown[] = [];

    holed[1] = 2;

    const refusals: [value: unknown, words: string][] = [
      [undefined, 'the value holds what JSON has no value for, undefined'],
      [{ a: undefined }, 'the value holds what JSON has no value for, undefined'],
      [() => {}, 'the value holds what JSON has no value for, function'],
      [1n, 'the value holds what JSON has no value for, bigint'],
      [Symbol('a'), 'the value holds what JSON has no value for, symbol'],
      [new Date(0), 'the value holds what JSON has no value for, an object of Date'],
      [new Map(), 'the value holds what JSON has no value for, an object of Map'],
      [new Thing(), 'the value holds what JSON has no value for, an object of Thing'],
      [holed, 'the value holds what JSON has no value for, an array with a hole'],
      [Number.NaN, 'the value holds a number that is not finite, NaN'],
      [[-Infinity], 'the value holds a number that is not finite, -Infinity'],
      [`a${String.fromCharCode(0xdc00)}`, 'the value holds a surrogate alone'],
      [{ [String.fromCharCode(0xd800)]: 1 }, 'the value holds a surrogate alone'],
    ];

    for (const [value, words] of refusals) {
      expect(
        refusalOf(() => {
          return PAYLOAD_CODECS.json.encode(value);
        }),
        words
      ).toEqual(['TypeError', words]);
    }
  });

  test('refuses a value nested deeper than 64, a cycle among them', () => {
    const cycle: unknown[] = [];

    cycle.push(cycle);

    expect(
      refusalOf(() => {
        return PAYLOAD_CODECS.json.encode(cycle);
      })
    ).toEqual(['TypeError', 'the value is nested deeper than 64']);
  });

  test('refuses what does not write within an object one of whose names may be an array index', () => {
    for (const value of [{ 1: Number.NaN }, { 1: undefined }, { 1: 1, a: new Date(0) }]) {
      expect(
        refusalOf(() => {
          return PAYLOAD_CODECS.json.encode(value);
        })?.[0],
        String(Object.values(value))
      ).toBe('TypeError');
    }
  });

  test("writes each object's names sorted by their UTF-16 code units, an array index's among them", () => {
    expect(written({ b: 1, 10: 2, 9: 3, '1a': 4 })).toBe('{"10":2,"1a":4,"9":3,"b":1}');
    expect(written({ z: [{ b: 1, a: 2 }], a: null })).toBe('{"a":null,"z":[{"a":2,"b":1}]}');
  });

  test('writes an object of no prototype, and a member named __proto__ as a member', () => {
    const value = Object.create(null) as Record<string, unknown>;

    value['b'] = true;
    Object.defineProperty(value, '__proto__', { enumerable: true, value: 'x' });

    expect(written(value)).toBe('{"__proto__":"x","b":true}');
  });
});

test.describe('the text codec', () => {
  test('reads UTF-8 strictly, a leading U+FEFF kept, and writes a string', () => {
    expect(
      refusalOf(() => {
        return PAYLOAD_CODECS.text.decode(new Uint8Array([0xc3]));
      })
    ).toEqual(['SyntaxError', 'the payload is not UTF-8']);
    expect(PAYLOAD_CODECS.text.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x31]))).toBe(
      `${String.fromCharCode(0xfeff)}1`
    );
    expect([...PAYLOAD_CODECS.text.encode('ok')]).toEqual([0x6f, 0x6b]);
  });

  test('refuses a string holding a surrogate alone, and what is not a string, with a TypeError', () => {
    expect(
      refusalOf(() => {
        return PAYLOAD_CODECS.text.encode(String.fromCharCode(0xd800));
      })
    ).toEqual(['TypeError', 'the text holds a surrogate alone']);
    expect(
      refusalOf(() => {
        return PAYLOAD_CODECS.text.encode(1 as unknown as string);
      })
    ).toEqual(['TypeError', 'a text payload is a string, not number']);
  });
});

test.describe('the raw codec', () => {
  test('reads and writes its bytes as they are', () => {
    const bytes = new Uint8Array([0xff, 0x00]);

    expect(PAYLOAD_CODECS.raw.decode(bytes)).toBe(bytes);
    expect(PAYLOAD_CODECS.raw.encode(bytes)).toBe(bytes);
  });
});

test.describe('payloadCodecOf', () => {
  test('payloadCodecOf freezes a codec of two functions, and refuses one that is not', () => {
    const decode = (bytes: Uint8Array): number => {
      return bytes.length;
    };
    const encode = (value: number): Uint8Array => {
      return new Uint8Array(value);
    };
    const codec = payloadCodecOf({ decode, encode });

    expect(Object.isFrozen(codec)).toBe(true);
    expect(codec.decode(new Uint8Array(3))).toBe(3);
    expect(codec.encode(2)).toEqual(new Uint8Array(2));

    for (const given of [undefined, null, {}, { decode }, { encode }, { decode, encode: 'x' }]) {
      expect(() => {
        return payloadCodecOf(given as never);
      }, JSON.stringify(given)).toThrow(ProgrammerError);
    }
  });
});

test.describe('namesOnce', () => {
  test('tells whether each object names each member once, by a well-formed name, its escapes read', () => {
    expect(namesOnce('[{"a":1},{"a":{"a":2}},"a","a"]')).toBe(true);
    expect(namesOnce('{"a":1,"b":{"c":1,"c":2}}')).toBe(false);
    expect(namesOnce(`{"a":1,"${BACKSLASH}u0061":2}`)).toBe(false);
    expect(namesOnce(`{"${BACKSLASH}ud800":1}`)).toBe(false);
  });
});
