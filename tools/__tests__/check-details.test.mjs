import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ALLOWED, problemsOf, sitesOf } from '../check-details.mjs';

const TS = 'implementations/typescript/src/router/shared/new-file.ts';
const CS = 'implementations/dotnet/src/Bead.Core/NewFile.cs';

describe('sitesOf', () => {
  test('finds a TypeScript detail built from an error message', () => {
    const text = 'a();\nconst x = { ...failures.f, detail: toError(reason).message };\n';

    assert.deepEqual(sitesOf(text, TS), [2]);
  });

  test('finds a detail variable assigned an error message', () => {
    assert.deepEqual(sitesOf('const detail = reason.message;', TS), [1]);
  });

  test('finds a C# failure built from an exception message', () => {
    const text = 'return Failure.OfProtocol(ProtocolCode.PayloadUndecodable, reason.Message);';

    assert.deepEqual(sitesOf(text, CS), [1]);
  });

  test('leaves a fixed detail and a transport event alone', () => {
    assert.deepEqual(sitesOf('{ ...f, detail: "the bound" };', TS), []);
    assert.deepEqual(sitesOf('transport.Message += OnMessage;', CS), []);
  });
});

describe('problemsOf', () => {
  const read = () => 'const x = { detail: error.message };';

  test('refuses a site no entry allows', () => {
    const problems = problemsOf([TS], read);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /spec 9\.0/);
  });

  test('accepts the allowed count and reports one gone', () => {
    const [path] = Object.keys(ALLOWED);
    const allowed = ALLOWED[path];
    const has = () => Array(allowed).fill('const x = { detail: error.message };').join('\n');

    assert.deepEqual(problemsOf([path], has), []);
    assert.match(problemsOf([path], () => '')[0], /gone/);
  });
});
