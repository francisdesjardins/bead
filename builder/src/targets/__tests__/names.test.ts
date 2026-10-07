import { expect, test } from '@playwright/test';

import {
  C_SHARP_OBJECT_MEMBERS,
  classNamesOf,
  csharpNameOfFailure,
  RUNTIME_TYPES,
  TYPESCRIPT_PROCEDURE_NAMES,
} from '../names.ts';

test("a service's classes, in every official target", () => {
  expect(classNamesOf('Interop')).toEqual([
    'InteropProcedures',
    'InteropFailures',
    'InteropServer',
    'InteropServerOptions',
    'InteropClient',
  ]);
});

test("a failure's C# name: its words, each its first letter kept", () => {
  expect(csharpNameOfFailure('ON_PURPOSE')).toBe('OnPurpose');
  expect(csharpNameOfFailure('A_B1')).toBe(csharpNameOfFailure('A_B_1'));
  expect(csharpNameOfFailure('CODE')).toBe('Code');
});

test('the names each target reserves', () => {
  expect(TYPESCRIPT_PROCEDURE_NAMES.has('then')).toBe(true);
  expect(C_SHARP_OBJECT_MEMBERS.has('GetHashCode')).toBe(true);
  expect(RUNTIME_TYPES.has('HttpServer')).toBe(true);
});
