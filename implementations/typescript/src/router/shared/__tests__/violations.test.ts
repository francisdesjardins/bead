// ── Violations ────────────────────────────────────────────────────────────────

// PAYLOAD_INVALID's detail, `spec/validations.json`'s details played against the TypeScript side's
// writer and reader: each entry of `write` written under its bound, each of `read` read back, a
// test each. The C# side plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { FailureScope, ProtocolCode } from '../constants';
import {
  detailBoundOf,
  type IViolation,
  isRefused,
  violationsDetailOf,
  violationsOf,
  wordsOf,
} from '../violations';

// interfaces

/** What a validator gave, and the bound its detail is written under. */
interface IWrite {
  maximumBytes: number;
  more?: number;
  stopped?: true;
  violations: IViolation[];
}

/** What a reader reads of a detail. */
interface IRead {
  more?: number;
  stopped?: true;
  violations: IViolation[];
}

/** An entry of the details: a detail written, or one read. */
interface IDetailEntry {
  clauses: string[];
  detail: string;
  name: string;
  read?: IRead;
  write?: IWrite;
}

/** A verdict, of which the words of its violations are read here. */
interface IVerdict {
  name: string;
  violations: IViolation[];
}

// constants

const { details: DETAILS, verdicts: VERDICTS } = JSON.parse(
  readFileSync(new URL('../../../../../../spec/validations.json', import.meta.url), 'utf8')
) as { details: IDetailEntry[]; verdicts: IVerdict[] };

// the rules whose words depend on what was judged, which their id and bounds do not give (18.8.6)
const JUDGED_WORDS: ReadonlySet<string> = new Set(['message.oneof', 'required']);

const FROM: IViolation = Object.freeze({
  bounds: { lte: 10 },
  fieldPath: 'from',
  message: 'must be less than or equal to 10',
  ruleId: 'int32.lte',
});

const NAME: IViolation = Object.freeze({
  bounds: { min_len: '1' },
  fieldPath: 'names[0]',
  message: 'must be at least 1 characters',
  ruleId: 'string.min_len',
});

// helpers

/** The violations a detail carries, as a reader reads a PAYLOAD_INVALID's. */
const readOf = (detail: string) => {
  return violationsOf({ code: ProtocolCode.PAYLOAD_INVALID, detail, scope: FailureScope.PROTOCOL });
};

// definition

test.describe('the details', () => {
  test.describe.configure({ retries: 0 });

  test('plays each entry as a writer or as a reader, never both', () => {
    expect(
      DETAILS.filter(({ read, write }) => {
        return (read === undefined) === (write === undefined);
      })
    ).toEqual([]);
  });

  for (const entry of DETAILS) {
    test(entry.name, () => {
      const { detail, read, write } = entry;

      if (write !== undefined) {
        const { maximumBytes, more = 0, stopped = false, violations } = write;

        expect(violationsDetailOf({ more, stopped, violations }, { maximumBytes })).toBe(detail);

        return;
      }

      expect(readOf(detail)).toEqual(read);
    });
  }
});

test.describe('violationsOf', () => {
  test('keeps the whole lines of a detail its reader cut', () => {
    const detail = violationsDetailOf(
      { more: 3, stopped: false, violations: [FROM, NAME] },
      { maximumBytes: 1_024 }
    );
    const firstLine = detail.indexOf('\n');

    expect(readOf(detail)).toEqual({ more: 3, violations: [FROM, NAME] });
    // cut inside its second line, as a reader's lower bound cuts it (spec 7.3), the first whole;
    // after the first, its line feed kept or not
    expect(readOf(detail.slice(0, firstLine + 20))).toEqual({ violations: [FROM] });
    expect(readOf(detail.slice(0, firstLine + 1))).toEqual({ violations: [FROM] });
    expect(readOf(detail.slice(0, firstLine))).toEqual({ violations: [FROM] });
    // * no closing line: what it left out is not counted, and nothing says it stopped
    expect(readOf(detail.slice(0, detail.lastIndexOf('\n')))).toEqual({
      violations: [FROM, NAME],
    });
  });

  test('reads no violations from a detail empty, cut or of another form', () => {
    const whole = violationsDetailOf(
      { more: 0, stopped: false, violations: [FROM] },
      { maximumBytes: 1_024 }
    );

    expect(readOf('')).toEqual({ violations: [] });
    expect(readOf('{"bounds":{"lte"')).toEqual({ violations: [] });
    expect(readOf('the request is invalid')).toEqual({ violations: [] });
    expect(readOf(whole.slice(0, 10))).toEqual({ violations: [] });
    expect(readOf(`{"error":"invalid"}\n${whole}`)).toEqual({ violations: [] });
    expect(readOf('{"error":"invalid"}\n{"more":0}')).toEqual({ violations: [] });
    // a line of another form first: the lines after it are not read
    expect(readOf('{"error":"invalid"}\n{"ruleId":"required"}\n{"more":0}')).toEqual({
      violations: [],
    });
    expect(readOf('[1,2,3]')).toEqual({ violations: [] });
    // a line of 18.3's members but its ruleId, which every violation has, or with one of another type
    expect(readOf('{"fieldPath":"from"}\n{"more":0}')).toEqual({ violations: [] });
    expect(readOf('{"bounds":[10],"ruleId":"int32.lte"}\n{"more":0}')).toEqual({ violations: [] });
    expect(readOf('{"message":10,"ruleId":"int32.lte"}\n{"more":0}')).toEqual({ violations: [] });
    expect(readOf('{"forKey":"true","ruleId":"required"}\n{"more":0}')).toEqual({ violations: [] });
    expect(readOf('{"stopped":false}')).toEqual({ violations: [] });
    expect(readOf('﻿{"ruleId":"required"}')).toEqual({ violations: [] });
    // a failure of another code carries none, whatever its detail
    expect(
      violationsOf({
        code: ProtocolCode.PROCEDURE_FAILED,
        detail: '{"ruleId":"required"}\n{"more":0}',
        scope: FailureScope.PROTOCOL,
      })
    ).toEqual({ violations: [] });
    expect(
      violationsOf({
        code: ProtocolCode.PAYLOAD_UNDECODABLE,
        detail: '{"ruleId":"required"}\n{"more":0}',
        scope: FailureScope.PROTOCOL,
      })
    ).toEqual({ violations: [] });
    expect(
      violationsOf({
        code: ProtocolCode.PAYLOAD_INVALID,
        detail: '{"ruleId":"required"}\n{"more":0}',
        scope: FailureScope.APPLICATION,
      })
    ).toEqual({ violations: [] });
    expect(readOf('{"ruleId":"required"}\n{"more":0}')).toEqual({
      more: 0,
      violations: [{ ruleId: 'required' }],
    });
    // and PAYLOAD_INVALID's, of the protocol, its violations
    expect(readOf(whole)).toEqual({ more: 0, violations: [FROM] });
  });

  test('reads forKey on the violation of a map key, its other members beside it', () => {
    const key: IViolation = {
      bounds: { min_len: '2' },
      fieldPath: 'labels["a"]',
      forKey: true,
      message: 'must be at least 2 characters',
      ruleId: 'string.min_len',
    };

    expect(
      readOf(
        violationsDetailOf({ more: 0, stopped: false, violations: [key] }, { maximumBytes: 1_024 })
      )
    ).toEqual({
      more: 0,
      violations: [key],
    });
    // * without its words, it takes those its rule and bounds give, a key's as a value's
    expect(
      readOf(
        '{"bounds":{"min_len":"2"},"fieldPath":"labels[\\"a\\"]","forKey":true,"ruleId":"string.min_len"}'
      )
    ).toEqual({ violations: [key] });
  });
});

test.describe('violationsOf, its members and its count', () => {
  test('takes a member empty as absent, its line kept, and an empty ruleId as an id', () => {
    expect(
      readOf(
        '{"bounds":{},"fieldPath":"","forKey":false,"message":"","ruleId":"required"}\n{"more":0}'
      )
    ).toEqual({ more: 0, violations: [{ ruleId: 'required' }] });
    // * an empty message takes its rule's words, as an absent one does
    expect(
      readOf('{"bounds":{"lte":10},"fieldPath":"from","message":"","ruleId":"int32.lte"}')
    ).toEqual({ violations: [FROM] });
    expect(readOf('{"ruleId":""}\n{"message":"must be even","ruleId":""}\n{"more":1}')).toEqual({
      more: 1,
      violations: [{ ruleId: '' }, { message: 'must be even', ruleId: '' }],
    });
  });

  test('reads a closing count from 0 to the largest integer I-JSON holds, and none past it nor of a fraction', () => {
    const line =
      '{"bounds":{"lte":10},"fieldPath":"from","message":"must be less than or equal to 10","ruleId":"int32.lte"}';

    expect(readOf(`${line}\n{"more":9007199254740991}`)).toEqual({
      more: Number.MAX_SAFE_INTEGER,
      violations: [FROM],
    });
    // * a number is read as the double nearest it (spec 17.6), so 1e2 counts a hundred
    expect(readOf(`${line}\n{"more":1e2}`)).toEqual({ more: 100, violations: [FROM] });

    for (const count of ['9007199254740992', '1e300', '1.5', '-1', '"3"', 'true', 'null']) {
      expect(readOf(`${line}\n{"more":${count}}`), count).toEqual({ violations: [FROM] });
    }
  });
});

test.describe('violationsDetailOf', () => {
  test('writes no member empty, and a count past the largest integer I-JSON holds as it', () => {
    expect(
      violationsDetailOf(
        {
          more: 0,
          stopped: false,
          violations: [{ bounds: {}, fieldPath: '', message: '', ruleId: 'required' }],
        },
        { maximumBytes: 1_024 }
      )
    ).toBe('{"ruleId":"required"}\n{"more":0}');
    expect(
      violationsDetailOf({ more: 2 ** 60, stopped: false, violations: [] }, { maximumBytes: 1_024 })
    ).toBe('{"more":9007199254740991}');
  });

  test('leaves the value a violation broke on the side that judged', () => {
    expect(
      violationsDetailOf(
        { more: 0, stopped: false, violations: [{ ...FROM, value: 11 }] },
        { maximumBytes: 1_024 }
      )
    ).toBe(
      '{"bounds":{"lte":10},"fieldPath":"from","message":"must be less than or equal to 10","ruleId":"int32.lte"}\n{"more":0}'
    );
  });
});

test.describe('wordsOf', () => {
  test("gives a rule's words from its id and its bounds, and none where they depend on what was judged", () => {
    expect(wordsOf({ bounds: { gte: 0, lte: 10 }, ruleId: 'int32.gte_lte' })).toBe(
      'must be greater than or equal to 0 and less than or equal to 10'
    );
    expect(wordsOf({ bounds: { gt: 10, lt: 5 }, ruleId: 'double.gt_lt_exclusive' })).toBe(
      'must be greater than 10 or less than 5'
    );
    expect(wordsOf({ bounds: { in: ['a', 'b'] }, ruleId: 'string.in' })).toBe(
      'must be in list [a, b]'
    );
    expect(wordsOf({ bounds: { prefix: 'iVBORw==' }, ruleId: 'bytes.prefix' })).toBe(
      'does not have prefix 89504e47'
    );
    expect(wordsOf({ ruleId: 'enum.defined_only' })).toBe(
      'value must be one of the defined enum values'
    );
    expect(wordsOf({ ruleId: 'required' })).toBeUndefined();
    expect(wordsOf({ bounds: { fields: ['x', 'y'] }, ruleId: 'message.oneof' })).toBeUndefined();
    expect(wordsOf({ bounds: {}, ruleId: 'int32.lte' })).toBeUndefined();
  });

  test('gives every violation of the verdicts the words of its rule and its bounds, and none where they depend on what was judged', () => {
    const violations = VERDICTS.flatMap(({ violations: judged }) => {
      return judged;
    });

    expect(violations.length).toBeGreaterThan(0);

    for (const { bounds, message, ruleId } of violations) {
      expect(wordsOf({ bounds, ruleId }), ruleId).toBe(
        JUDGED_WORDS.has(ruleId) ? undefined : message
      );
    }
  });

  test('gives no words where the bounds lack what its rule needs, or its rule is none it renders', () => {
    const none: Pick<IViolation, 'bounds' | 'ruleId'>[] = [
      // a member its words need, missing
      { bounds: {}, ruleId: 'string.const' },
      { bounds: {}, ruleId: 'string.min_len' },
      { bounds: {}, ruleId: 'string.prefix' },
      { bounds: {}, ruleId: 'string.in' },
      { bounds: {}, ruleId: 'bytes.const' },
      { bounds: {}, ruleId: 'bytes.max_len' },
      { bounds: {}, ruleId: 'bool.const' },
      { bounds: {}, ruleId: 'enum.in' },
      { bounds: {}, ruleId: 'int32.const' },
      { bounds: {}, ruleId: 'int32.gt' },
      { bounds: {}, ruleId: 'int32.not_in' },
      { bounds: {}, ruleId: 'repeated.min_items' },
      { bounds: {}, ruleId: 'map.max_pairs' },
      { bounds: { gte: 0 }, ruleId: 'int32.gte_lte' },
      { bounds: { lt: 5 }, ruleId: 'double.gt_lt_exclusive' },
      // a member its words cannot write: a list's item, bytes that are no base64, a null
      { bounds: { in: [1, {}] }, ruleId: 'int32.in' },
      { bounds: { not_in: [null] }, ruleId: 'string.not_in' },
      { bounds: { prefix: '!!!' }, ruleId: 'bytes.prefix' },
      { bounds: { const: '!!!' }, ruleId: 'bytes.const' },
      { bounds: { lte: null }, ruleId: 'uint64.lte' },
      { bounds: { const: { value: 1 } }, ruleId: 'string.const' },
      // a rule it renders none of: an unknown member, an unknown kind, a rule of no kind
      { bounds: { email: true }, ruleId: 'string.email' },
      { bounds: { ip: true }, ruleId: 'bytes.ip' },
      { bounds: { items: { min_len: '1' } }, ruleId: 'repeated.items' },
      { bounds: { keys: { min_len: '1' } }, ruleId: 'map.keys' },
      { bounds: { finite: true }, ruleId: 'int32.finite' },
      { bounds: { lt: 1, gt: 2 }, ruleId: 'int32.lt_gt' },
      { bounds: { gt: '1s' }, ruleId: 'duration.gt' },
      { bounds: { lt_now: true }, ruleId: 'timestamp.lt_now' },
      { bounds: { fields: ['x'] }, ruleId: 'oneof' },
      { bounds: {}, ruleId: 'bool.in' },
      { bounds: {}, ruleId: 'enum.lt' },
    ];

    for (const violation of none) {
      expect(wordsOf(violation), violation.ruleId).toBeUndefined();
    }

    // * a bound of a scalar is written as `%s` writes it, a flag among them
    expect(wordsOf({ bounds: { lte: true }, ruleId: 'int32.lte' })).toBe(
      'must be less than or equal to true'
    );
    expect(wordsOf({ bounds: { const: false }, ruleId: 'bool.const' })).toBe('must equal false');
  });
});

test.describe('wordsOf, its rules and their bounds', () => {
  test('gives words to the rules beadc compiles alone, by their templates', () => {
    expect(wordsOf({ bounds: { pattern: '^a$' }, ruleId: 'string.pattern' })).toBe(
      'does not match regex pattern `^a$`'
    );
    expect(wordsOf({ bounds: { min_items: '2' }, ruleId: 'repeated.min_items' })).toBe(
      'must contain at least 2 item(s)'
    );
    expect(wordsOf({ ruleId: 'float.finite' })).toBe('must be finite');

    // * bytes' pattern and lists, which beadc does not compile, take none, nor an id of no rule's
    for (const violation of [
      { bounds: { pattern: '^a$' }, ruleId: 'bytes.pattern' },
      { bounds: { in: ['AQI='] }, ruleId: 'bytes.in' },
      { bounds: { not_in: ['AQI='] }, ruleId: 'bytes.not_in' },
      { bounds: { in: [true] }, ruleId: 'bool.in' },
      { bounds: { gt: 1, lt: 3 }, ruleId: 'enum.gt_lt' },
      { bounds: { const: 1 }, ruleId: 'repeated.const' },
      { bounds: { lte: 1 }, ruleId: '' },
      { bounds: { lte: 1 }, ruleId: 'constructor' },
    ]) {
      expect(wordsOf(violation), violation.ruleId).toBeUndefined();
    }
  });

  test('takes a list for in and not_in alone, and a scalar for every other member', () => {
    expect(wordsOf({ bounds: { in: [1, 'a', true] }, ruleId: 'int32.in' })).toBe(
      'must be in list [1, a, true]'
    );
    expect(wordsOf({ bounds: { not_in: [] }, ruleId: 'string.not_in' })).toBe(
      'must not be in list []'
    );

    for (const bounds of [{ in: 1 }, { in: [[1]] }, { in: [1, [2]] }, { in: 'a' }]) {
      expect(wordsOf({ bounds, ruleId: 'int32.in' }), JSON.stringify(bounds)).toBeUndefined();
    }

    for (const bounds of [{ lte: [1] }, { lte: {} }, { lte: null }]) {
      expect(wordsOf({ bounds, ruleId: 'int32.lte' }), JSON.stringify(bounds)).toBeUndefined();
    }
  });

  test('takes bytes in base64 as RFC 4648 writes it alone, padded, of its standard alphabet', () => {
    expect(wordsOf({ bounds: { const: 'AP8=' }, ruleId: 'bytes.const' })).toBe('must be 00ff');
    expect(wordsOf({ bounds: { suffix: 'AQ==' }, ruleId: 'bytes.suffix' })).toBe(
      'does not have suffix 01'
    );
    expect(wordsOf({ bounds: { contains: 'AQID' }, ruleId: 'bytes.contains' })).toBe(
      'does not contain 010203'
    );
    expect(wordsOf({ bounds: { const: 'AR==' }, ruleId: 'bytes.const' })).toBe('must be 01');

    for (const text of ['AP8', '-_8=', 'AP 8=', 'AP8=\n', 'A===', 'AP8=AP8=', '!!!!', 'AQ=']) {
      expect(wordsOf({ bounds: { const: text }, ruleId: 'bytes.const' }), text).toBeUndefined();
    }
  });
});

test.describe('detailBoundOf', () => {
  test('bounds a detail by maximumDetailBytes, and by an envelope less its 32 bytes beside it', () => {
    expect(detailBoundOf({ maximumDetailBytes: 1_024, maximumEnvelopeBytes: 16_778_240 })).toBe(
      1_024
    );
    expect(detailBoundOf({ maximumDetailBytes: 1_024, maximumEnvelopeBytes: 100 })).toBe(68);
    expect(detailBoundOf({ maximumDetailBytes: 0, maximumEnvelopeBytes: 64 })).toBe(0);
  });
});

test.describe('isRefused', () => {
  test('refuses a request a violation is held or counted of, and takes one of none', () => {
    expect(isRefused({ more: 0, stopped: false, violations: [] })).toBe(false);
    expect(isRefused({ more: 1, stopped: true, violations: [] })).toBe(true);
    expect(isRefused({ more: 0, stopped: false, violations: [FROM] })).toBe(true);
  });
});
