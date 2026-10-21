import { expect, test } from '@playwright/test';
import { GENERATED_CODE_SUPPORTS_VERSION_4 } from '../generated-code';

// definition

test.describe('the contract with generated code', () => {
  test('holds the constant of the contract this runtime supports', () => {
    expect(GENERATED_CODE_SUPPORTS_VERSION_4).toBe(true);
  });
});
