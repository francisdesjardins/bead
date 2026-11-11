import { expect, test } from '@playwright/test';

import { diagnosticOf, hasError, pointerOf } from '../diagnostics.ts';

test("escapes a pointer's tokens, and tells an error from a warning", () => {
  expect(pointerOf(['services', 0, 'a/b~c'])).toBe('/services/0/a~1b~0c');
  expect(
    hasError([
      diagnosticOf('PROCEDURE_ID_UNIQUE', {
        message: "id 4, Slow's already",
        place: { file: 'proto/catalog/v3/catalog.proto', line: 41, column: 5 },
      }),
    ])
  ).toBe(true);
  expect(
    hasError([diagnosticOf('SERVICE_SKIPPED', { message: 'skipped', place: { file: 'a.proto' } })])
  ).toBe(false);
});
