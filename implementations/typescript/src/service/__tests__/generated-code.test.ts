import { expect, test } from '@playwright/test';
import * as transcoding from '../../transcoding/transcoding';
import { GENERATED_CODE_SUPPORTS_VERSION_6 } from '../generated-code';
import * as service from '../service';

// helpers

/** The contract constants an entry exports, by name. */
const contractsOf = (entry: Record<string, unknown>): string[] => {
  return Object.keys(entry)
    .filter((name) => {
      return name.startsWith('GENERATED_CODE_SUPPORTS_VERSION_');
    })
    .toSorted();
};

// definition

test.describe('the contract with generated code', () => {
  test('holds the constants of the contracts this runtime supports, 5 and 6, and no other', () => {
    expect(GENERATED_CODE_SUPPORTS_VERSION_6).toBe(true);
    expect(transcoding.GENERATED_CODE_SUPPORTS_VERSION_5).toBe(true);
    // * 4 goes: code that names it reads a required field unset, which no longer conforms
    expect(contractsOf(service)).toEqual(['GENERATED_CODE_SUPPORTS_VERSION_6']);
    expect(contractsOf(transcoding)).toEqual(['GENERATED_CODE_SUPPORTS_VERSION_5']);
  });
});
