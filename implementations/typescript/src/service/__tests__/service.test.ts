import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import * as service from '../service';

// constants

const PACKAGE = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
) as { exports: Record<string, string> };

// definition

test.describe('the service entry', () => {
  test('exports what a generated file imports', () => {
    expect(PACKAGE.exports['./service']).toBe('./src/service/service.ts');
    expect(Object.keys(service).toSorted()).toEqual([
      'FailureError',
      'GENERATED_CODE_SUPPORTS_VERSION_4',
      'PAYLOAD_CODECS',
      'ProcedureKind',
      'ProgrammerError',
      'commandOf',
      'createServiceClient',
      'createServiceServer',
      'detailBoundOf',
      'failuresOf',
      'payloadCodecOf',
      'requestOf',
      'violationsDetailOf',
      'violationsOf',
      'wordsOf',
    ]);
  });
});
