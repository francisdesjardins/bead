import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  comparableOf,
  corpusOf,
  cutKeyOf,
  elementsOfPath,
  elementsOfProto,
  integrityOf,
  payloadOf,
  readPin,
  SIDES,
} from '../protovalidate-differential.mjs';

const PIN = new URL('../protovalidate-differential/pin.json', import.meta.url);
const VALIDATIONS = new URL('../../spec/validations.json', import.meta.url);

describe('the pin', () => {
  test('names its oracle among its packages, each by its tarball and its sha512', () => {
    const pin = readPin(readFileSync(PIN, 'utf8'));

    assert.equal(pin.oracle, '@bufbuild/protovalidate');
    assert.ok(
      pin.packages.some((each) => {
        return each.name === '@bufbuild/protobuf';
      })
    );
    assert.throws(() => {
      return readPin(JSON.stringify({ ...pin, oracle: 'nothing' }));
    }, /oracle names one of its packages/u);
    assert.throws(() => {
      return readPin(
        JSON.stringify({ ...pin, packages: [{ ...pin.packages[0], integrity: 'md5-x' }] })
      );
    }, /integrity is npm's sha512/u);
    assert.match(integrityOf(Buffer.from('')), /^sha512-z4PhNX7vuL3x/u);
  });

  test("each side's testee is under its implementation's tools", () => {
    assert.deepEqual(Object.keys(SIDES), ['typescript', 'csharp']);
    assert.ok(SIDES.typescript.folder.startsWith('implementations/typescript/tools/'));
    assert.ok(SIDES.csharp.folder.startsWith('implementations/dotnet/tools/'));
  });
});

describe('the paths', () => {
  test("reads Bead's rendering back into its elements, a key's escapes and its cut among them", () => {
    assert.deepEqual(elementsOfPath('items[2].name'), [
      { name: 'items', subscript: { integer: '2' } },
      { name: 'name' },
    ]);
    assert.deepEqual(elementsOfPath('labels["a\\tb\\"\\u0001"]'), [
      { name: 'labels', subscript: { string: 'a\tb"\u0001', cut: false } },
    ]);
    assert.deepEqual(elementsOfPath('flags[true].by_id[-1]'), [
      { name: 'flags', subscript: { bool: true } },
      { name: 'by_id', subscript: { integer: '-1' } },
    ]);
    assert.deepEqual(elementsOfPath('labels["kk"...]'), [
      { name: 'labels', subscript: { string: 'kk', cut: true } },
    ]);
    assert.deepEqual(elementsOfPath(undefined), []);
  });

  test("cuts protovalidate's string key as spec 18.4 cuts one, back to a character's start", () => {
    assert.deepEqual(cutKeyOf('k'.repeat(64)), { string: 'k'.repeat(64), cut: false });
    assert.deepEqual(cutKeyOf(`${'k'.repeat(63)}é`), { string: 'k'.repeat(63), cut: true });
    assert.deepEqual(
      elementsOfProto({
        elements: [
          { fieldName: 'keyed', subscript: { case: 'stringKey', value: 'k'.repeat(70) } },
          { fieldName: 'items', subscript: { case: 'index', value: 3n } },
          { fieldName: 'flags', subscript: { case: 'boolKey', value: false } },
          { fieldName: 'name', subscript: { case: undefined } },
        ],
      }),
      [
        { name: 'keyed', subscript: { string: 'k'.repeat(64), cut: true } },
        { name: 'items', subscript: { integer: '3' } },
        { name: 'flags', subscript: { bool: false } },
        { name: 'name' },
      ]
    );
  });

  test('compares violations sorted by rule id, then by path, its words and forKey held', () => {
    const one = { ruleId: 'string.min_len', forKey: false, message: 'a' };

    assert.deepEqual(
      comparableOf([
        { ...one, elements: elementsOfPath('names[1]') },
        { ...one, ruleId: 'required', elements: elementsOfPath('needed') },
        { ...one, elements: elementsOfPath('names[0]') },
      ]),
      [
        { ruleId: 'required', path: 'needed', forKey: false, message: 'a' },
        { ruleId: 'string.min_len', path: 'names[0]', forKey: false, message: 'a' },
        { ruleId: 'string.min_len', path: 'names[1]', forKey: false, message: 'a' },
      ]
    );
  });
});

describe('the corpus', () => {
  test("holds every verdict's payload, then the same mutations of one seed, every run", () => {
    const { verdicts } = JSON.parse(readFileSync(VALIDATIONS, 'utf8'));
    const first = corpusOf(verdicts, { seed: 35, size: 50 });
    const again = corpusOf(verdicts, { seed: 35, size: 50 });

    assert.equal(first.length, verdicts.length + 50);
    assert.deepEqual(first.at(-1)?.payload, again.at(-1)?.payload);
    assert.deepEqual(first[0]?.payload, payloadOf(verdicts[0]));
    assert.notDeepEqual(
      corpusOf(verdicts, { seed: 36, size: 50 }).at(-1)?.payload,
      first.at(-1)?.payload
    );
  });
});
