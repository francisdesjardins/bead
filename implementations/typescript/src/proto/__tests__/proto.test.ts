import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import * as proto from '../proto';

// constants

const PACKAGE = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
) as { exports: Record<string, string> };

// definition

test.describe('the proto entry', () => {
  test('exports what a generated file imports', () => {
    expect(PACKAGE.exports['./proto']).toBe('./src/proto/proto.ts');
    expect(Object.keys(proto).toSorted()).toEqual([
      'bytesContain',
      'bytesEndWith',
      'bytesEqual',
      'bytesStartWith',
      'checkProtoRecords',
      'codePointLength',
      'entriesByKey',
      'isUnique',
      'judgeRules',
      'matchesPattern',
      'protoCodecOf',
      'utf8Length',
      'validatorOf',
    ]);
  });
});
