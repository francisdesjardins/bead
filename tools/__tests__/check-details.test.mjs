import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ALLOWED, markedOf, problemsOf, sitesOf } from '../check-details.mjs';

const TS = 'implementations/typescript/src/router/shared/new-file.ts';
const CS = 'implementations/dotnet/src/Bead.Core/NewFile.cs';
const MARKER = "// ! a detail of the side's own words: the codec's, for the side's report alone";
const SITE = 'const x = { detail: error.message };';

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

  test('finds a C# problem of a gateway built from an exception message', () => {
    const text =
      'return HttpProblems.Own(OwnFailure.Unwritable, (reason.Message, _options.Challenge));\n' +
      'var field = descriptor is { FieldType: FieldType.Message };';

    assert.deepEqual(sitesOf(text, CS), [1]);
  });

  test('leaves a fixed detail and a transport event alone', () => {
    assert.deepEqual(sitesOf('{ ...f, detail: "the bound" };', TS), []);
    assert.deepEqual(sitesOf('transport.Message += OnMessage;', CS), []);
  });

  test('leaves a comment that names a site alone', () => {
    assert.deepEqual(sitesOf('// a detail: error.message, for the report', TS), []);
  });
});

describe('markedOf', () => {
  test('holds a site its marker ends, or the first code line below the marker’s comment', () => {
    const text = [`${SITE} ${MARKER}`, '', MARKER, '// the rest of why', SITE].join('\n');

    assert.deepEqual(markedOf(text, TS), { held: [1, 5], unheld: [], idle: [] });
  });

  test('holds a C# site by the same marker', () => {
    const text = `${MARKER}\nreturn Failure.OfProtocol(ProtocolCode.PayloadUndecodable, reason.Message);`;

    assert.deepEqual(markedOf(text, CS), { held: [2], unheld: [], idle: [] });
  });

  test('refuses a marker with no why, and one a blank line parts from its site', () => {
    const text = ["// ! a detail of the side's own words:", SITE, '', MARKER, '', SITE].join('\n');

    assert.deepEqual(markedOf(text, TS), { held: [], unheld: [2, 6], idle: [4] });
  });
});

describe('problemsOf', () => {
  // a file of more than one allowed site, for one to move beside the other
  const [path, allowed] = Object.entries(ALLOWED).find(([, count]) => count > 1);
  const marked = Array(allowed).fill(`${MARKER}\n${SITE}`);

  test('refuses a site no entry allows', () => {
    const problems = problemsOf([TS], () => SITE);

    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /^implementations\/typescript\/src\/router\/shared\/new-file\.ts:1: /
    );
    assert.match(problems[0], /spec 9\.0/);
  });

  test('accepts the allowed marked sites and reports one gone', () => {
    assert.deepEqual(
      problemsOf([path], () => marked.join('\n')),
      []
    );
    assert.match(problemsOf([path], () => '')[0], /gone/);
  });

  test('accepts an allowed site moved, its marker with it', () => {
    const [first, ...rest] = marked;
    const moved = [...rest, 'a();', '', first, 'b();'].join('\n');

    assert.deepEqual(
      problemsOf([path], () => moved),
      []
    );
  });

  test('refuses a new site beside an allowed one, by its line', () => {
    const lines = [...marked, SITE].join('\n');
    const problems = problemsOf([path], () => lines);

    assert.equal(problems.length, 1);
    assert.ok(problems[0].startsWith(`${path}:${String(allowed * 2 + 1)}: `));
    assert.match(problems[0], /spec 9\.0/);
  });

  test('refuses a new site beside an allowed one, in the place of one gone', () => {
    const [, ...rest] = marked;
    const lines = [...rest, SITE].join('\n');
    const problems = problemsOf([path], () => lines);

    assert.equal(problems.length, 2);
    assert.ok(problems[0].startsWith(`${path}:${String(rest.length * 2 + 1)}: `));
    assert.match(problems[1], /1 allowed site\(s\) gone/);
  });

  test('refuses a new site beside an allowed one, marked but not counted', () => {
    const problems = problemsOf([path], () => [...marked, MARKER, SITE].join('\n'));

    assert.equal(problems.length, 1);
    assert.ok(
      problems[0].includes(`${String(allowed + 1)} marked site(s), ${String(allowed)} allowed`)
    );
  });

  test('refuses a marker that holds no site, by its line', () => {
    const problems = problemsOf([TS], () => `${MARKER}\nconst x = 1;`);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /:1: a marker that holds no site/);
  });
});
