import { expect, test } from '@playwright/test';

import {
  diagnosticOf,
  ErrorFormat,
  formatDiagnostic,
  hasError,
  pointerOf,
} from '../diagnostics.ts';

const atLine = diagnosticOf('PROCEDURE_ID_UNIQUE', {
  message: "id 4, Slow's already",
  place: { file: 'proto/catalog/v3/catalog.proto', line: 41, column: 5 },
});
const atPointer = diagnosticOf('NAME_FORM', {
  message: 'not "Echo"',
  place: { file: 'spec/a.json', line: 9, column: 3, pointer: '/services/0/procedureName' },
});

test('prints a finding as file:line:column, or at its JSON Pointer, as text', () => {
  expect(formatDiagnostic(atLine, ErrorFormat.TEXT)).toBe(
    "proto/catalog/v3/catalog.proto:41:5: error PROCEDURE_ID_UNIQUE: id 4, Slow's already"
  );
  expect(formatDiagnostic(atPointer, ErrorFormat.TEXT)).toBe(
    'spec/a.json#/services/0/procedureName: error NAME_FORM: not "Echo"'
  );
});

test("prints a finding as a JSON line and as GitHub's workflow command", () => {
  expect(JSON.parse(formatDiagnostic(atPointer, ErrorFormat.JSON))).toEqual({
    file: 'spec/a.json',
    line: 9,
    column: 3,
    pointer: '/services/0/procedureName',
    severity: 'error',
    rule: 'NAME_FORM',
    message: 'not "Echo"',
  });
  expect(formatDiagnostic(atLine, ErrorFormat.GITHUB)).toBe(
    "::error file=proto/catalog/v3/catalog.proto,line=41,col=5,title=PROCEDURE_ID_UNIQUE::id 4, Slow's already"
  );
  expect(
    formatDiagnostic(
      diagnosticOf('BLUEPRINT_SCHEMA', { message: '50%\nnext', place: { file: 'a,b:c.json' } }),
      ErrorFormat.GITHUB
    )
  ).toBe('::error file=a%2Cb%3Ac.json,title=BLUEPRINT_SCHEMA::50%25%0Anext');
});

test("escapes a pointer's tokens, and tells an error from a warning", () => {
  expect(pointerOf(['services', 0, 'a/b~c'])).toBe('/services/0/a~1b~0c');
  expect(hasError([atLine])).toBe(true);
  expect(
    hasError([diagnosticOf('SERVICE_SKIPPED', { message: 'skipped', place: { file: 'a.proto' } })])
  ).toBe(false);
});
