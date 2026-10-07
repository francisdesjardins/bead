import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { checkRoots } from '../../check.ts';
import { formOf, projectionOf } from '../../model/form.ts';
import { deriveRoot, FIXTURES, INTEROP_PROTO, toCrlf } from './derive.ts';

const SPEC_BLUEPRINT = new URL('../../../../spec/interop-blueprint.json', import.meta.url);

test("the interop's .proto gives spec/interop-blueprint.json, its projection byte for byte, in LF and in CRLF", () => {
  const expected = readFileSync(SPEC_BLUEPRINT, 'utf8');
  const roots = [FIXTURES, deriveRoot(INTEROP_PROTO, { root: 'crlf', change: toCrlf })];

  for (const root of roots) {
    const checked = checkRoots([root], { files: [INTEROP_PROTO] });

    expect(checked.diagnostics, root).toEqual([]);
    expect(checked.blueprint, root).toBeDefined();
    expect(formOf(projectionOf(checked.blueprint)), root).toBe(expected);
  }
});

test('its whole blueprint names what it read of the .proto', () => {
  const checked = checkRoots([FIXTURES], { files: [INTEROP_PROTO] });

  expect(checked.blueprint?.proto).toEqual({
    files: [{ path: INTEROP_PROTO, package: 'bead.interop.v1' }],
    messages: [],
  });
  expect(checked.blueprint?.services[0]?.proto).toEqual({
    file: INTEROP_PROTO,
    fullName: 'bead.interop.v1.InteropService',
  });
});

test('a finding on the blueprint of a .proto points at the option that causes it', () => {
  const root = deriveRoot(INTEROP_PROTO, {
    root: 'id-0',
    change: (text) => {
      return text.replace('    id: 1\n    revision: 1\n', '    id: 0\n    revision: 1\n');
    },
  });
  const checked = checkRoots([root], { files: [INTEROP_PROTO] });

  expect(
    checked.diagnostics.map((diagnostic) => {
      return [diagnostic.rule, diagnostic.line, diagnostic.column];
    })
  ).toEqual([['SERVICE_ID_RANGE', 18, 5]]);
});
