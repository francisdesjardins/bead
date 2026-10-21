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

// constants

const { details: DETAILS } = JSON.parse(
  readFileSync(new URL('../../../../../../spec/validations.json', import.meta.url), 'utf8')
) as { details: IDetailEntry[] };

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
    // cut inside its second line, the first whole; after the first, its line feed kept or not
    expect(readOf(detail.slice(0, firstLine + 20))).toEqual({ violations: [FROM] });
    expect(readOf(detail.slice(0, firstLine + 1))).toEqual({ violations: [FROM] });
    expect(readOf(detail.slice(0, firstLine))).toEqual({ violations: [FROM] });
    // * no closing line: what it left out is not counted, and nothing says it stopped
    expect(readOf(detail.slice(0, detail.lastIndexOf('\n')))).toEqual({
      violations: [FROM, NAME],
    });
  });

  test('reads no violations from a detail empty, cut or of another form', () => {
    expect(readOf('')).toEqual({ violations: [] });
    expect(readOf('{"bounds":{"lte"')).toEqual({ violations: [] });
    expect(readOf('the request is invalid')).toEqual({ violations: [] });
    expect(readOf('{"error":"invalid"}\n{"more":0}')).toEqual({ violations: [] });
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
        code: ProtocolCode.PAYLOAD_INVALID,
        detail: '{"ruleId":"required"}\n{"more":0}',
        scope: FailureScope.APPLICATION,
      })
    ).toEqual({ violations: [] });
  });
});

test.describe('violationsDetailOf', () => {
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
