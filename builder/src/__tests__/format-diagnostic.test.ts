import { expect, test } from '@playwright/test';

import { bufDiagnosticOf, diagnosticOf, hasError } from '../diagnostics.ts';
import { ErrorFormat, formatDiagnostic } from '../format-diagnostic.ts';

const atLine = diagnosticOf('PROCEDURE_ID_UNIQUE', {
  message: "id 4, Slow's already",
  place: { file: 'proto/catalog/v3/catalog.proto', line: 41, column: 5 },
});
const atPointer = diagnosticOf('NAME_FORM', {
  message: 'not "Echo"',
  place: { file: 'spec/a.json', line: 9, column: 3, pointer: '/services/0/procedureName' },
});

// ! CI's runner sets GITHUB_WORKSPACE, which moves every file the github format names: these
// findings are printed outside a workflow, as given
let workspace: string | undefined;

test.beforeEach(() => {
  workspace = process.env['GITHUB_WORKSPACE'];
  delete process.env['GITHUB_WORKSPACE'];
});

test.afterEach(() => {
  if (workspace !== undefined) {
    process.env['GITHUB_WORKSPACE'] = workspace;
  }
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

test("a breaking finding on a .proto ends its line with its pointer, and buf's is named buf:", () => {
  const renamed = diagnosticOf('PROCEDURE_SAME_NAME', {
    message: 'procedure 1 echo is repeat now',
    place: {
      file: 'proto/x/v1/x.proto',
      line: 22,
      column: 7,
      pointer: '/services/0/procedures/0/procedureName',
    },
  });
  const field = bufDiagnosticOf('FIELD_SAME_TYPE', {
    message: 'Field "1" changed type.',
    place: { file: 'proto/x/v1/x.proto', line: 34, column: 3 },
  });

  expect(formatDiagnostic(renamed, ErrorFormat.TEXT)).toBe(
    'proto/x/v1/x.proto:22:7: error PROCEDURE_SAME_NAME: procedure 1 echo is repeat now (at /services/0/procedures/0/procedureName)'
  );
  expect(formatDiagnostic(renamed, ErrorFormat.GITHUB)).toBe(
    '::error file=proto/x/v1/x.proto,line=22,col=7,title=PROCEDURE_SAME_NAME::procedure 1 echo is repeat now (at /services/0/procedures/0/procedureName)'
  );
  expect(formatDiagnostic(field, ErrorFormat.TEXT)).toBe(
    'proto/x/v1/x.proto:34:3: error buf:FIELD_SAME_TYPE: Field "1" changed type.'
  );
  expect(hasError([field])).toBe(true);
});
