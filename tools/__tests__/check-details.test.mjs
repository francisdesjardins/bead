import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ALLOWED, markedOf, problemsOf, sitesOf } from '../check-details.mjs';

const TS = 'implementations/typescript/src/router/shared/new-file.ts';
const CS = 'implementations/dotnet/src/Bead.Core/NewFile.cs';
const RS = 'implementations/rust/crates/bead/src/router/new_file.rs';
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

  test('finds a Rust detail built from an error’s Display, across the lines rustfmt breaks it into', () => {
    const text = [
      'let failure = core',
      '    .failure(ProtocolCode::PAYLOAD_UNDECODABLE)',
      '    .saying(format!(',
      '        "the codec refused it: {}",',
      '        error',
      '    ));',
      'let other = core.failure(C).saying(format!("refused: {error:?}"));',
      'let third = Failure::application(code, error.to_string());',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [3, 7, 8]);
  });

  test('finds a Rust detail through a helper whatever its parameter is named', () => {
    const text = [
      'fn malformed(side: RouterSide, detail: String) -> Failure {',
      '    Failure::protocol(ProtocolCode::ENVELOPE_MALFORMED, side).saying(detail)',
      '}',
      'fn unreachable_of(&self, why: &str) -> Failure {',
      '    Failure::protocol(C, side).saying(format!("destination {} is unreachable: {why}", id))',
      '}',
      'let held = read(bytes).map_err(|error| malformed(side, error.to_string()))?;',
      'let gone = self.unreachable_of(&error.to_string());',
      'let too_large = |words: String| core.failure(C).saying(words);',
      'let refused = too_large(reason.to_string());',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [7, 8, 10]);
  });

  test('finds a Rust detail through a helper that hands its parameter to another', () => {
    const text = [
      'fn malformed(side: RouterSide, detail: String) -> Failure {',
      '    Failure::protocol(ProtocolCode::ENVELOPE_MALFORMED, side).saying(detail)',
      '}',
      'fn unread<T: Display>(side: RouterSide, why: &str) -> Failure {',
      '    malformed(side, format!("the header does not read: {why}"))',
      '}',
      'let failure = unread(side, &error.to_string());',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [7]);
  });

  test('finds a Rust detail of an error the file binds by any name, a panic’s among them', () => {
    const text = [
      'if let Err(panicked) = called {',
      '    f.saying(format!("the resolver panicked: {panicked}"));',
      '}',
      'x.map_err(|refusal| f.saying(format!("undecodable: {refusal}")));',
      'x.unwrap_or_else(|err| f.saying(format!("{}", err)));',
      'x.map_err(|_error| f.saying(format!("{_error}")));',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [2, 4, 5]);
  });

  test('finds a Rust detail field and a detail binding', () => {
    const text = [
      'let record = FailureRecord { code, scope, detail: error.to_string(), relays: 0 };',
      'let detail = refused.reason().to_owned();',
      'let hook = AdmissionHook {',
      '    detail: format!("{source:?}"),',
      '};',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [1, 2, 4]);
  });

  test('leaves a Rust detail of fixed words, a failure’s own detail and an error that is no detail alone', () => {
    const text = [
      'fn unreachable_of(&self, why: &str) -> Failure {',
      '    F.saying(format!("destination {} is unreachable: {why}", self.destination_id))',
      '}',
      'fn too_large_of(&self, length: u64, limit: u64) -> Failure {',
      '    F.saying(format!("{length} bytes, past the limit of {limit}"))',
      '}',
      'f.saying("this side takes no notification");',
      'f.saying(format!("call {call_id} is open already ( {}", error.kind));',
      'core.failure(C).saying(failure.detail().to_owned());',
      'let gone = self.unreachable_of("its connection closed");',
      'let large = self.too_large_of(length, limit);',
      'pub struct Record { pub detail: String }',
      '// .saying(error.to_string())',
      '/* .saying(error.to_string()) */',
      'f.saying(".saying(error.to_string())");',
      'return Err(ConnectError::new(error.to_string()));',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), []);
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

  test('holds a Rust site by the marker above its .saying in a chain', () => {
    const text = [
      'let failure = state',
      '    .core()',
      '    .failure(ProtocolCode::CAPACITY_EXCEEDED)',
      `    ${MARKER}`,
      '    .saying(error.message().to_owned());',
    ].join('\n');

    assert.deepEqual(markedOf(text, RS), { held: [5], unheld: [], idle: [] });
  });

  test('refuses a Rust inner doc comment as a marker', () => {
    const text = [
      "//! a detail of the side's own words: the codec's, for the side's report alone",
      'let failure = core.failure(C).saying(error.to_string());',
    ].join('\n');

    assert.deepEqual(markedOf(text, RS), { held: [], unheld: [2], idle: [] });
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

  test('accepts the Rust side’s allowed site and reports one gone', () => {
    const core = 'implementations/rust/crates/bead/src/router/core.rs';
    const site = [
      'let failure = state',
      '    .core()',
      '    .failure(ProtocolCode::CAPACITY_EXCEEDED)',
      `    ${MARKER}`,
      '    .saying(error.message().to_owned());',
    ].join('\n');

    assert.equal(ALLOWED[core], 1);
    assert.deepEqual(
      problemsOf([core], () => site),
      []
    );
    assert.match(problemsOf([core], () => '')[0], /1 allowed site\(s\) gone/);
  });

  test('refuses a marker that holds no site, by its line', () => {
    const problems = problemsOf([TS], () => `${MARKER}\nconst x = 1;`);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /:1: a marker that holds no site/);
  });
});
