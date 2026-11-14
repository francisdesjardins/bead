import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ALLOWED, markedOf, problemsOf, sitesOf, sourcesOf } from '../check-details.mjs';

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

  test('finds a TypeScript problem of a gateway built from an error message', () => {
    const text =
      "return problemOfOwn('unwritable', reason.message);\n" +
      "return problemOfOwn('closed', 'the connection closed');";

    assert.deepEqual(sitesOf(text, TS), [1]);
  });

  test('finds a C# failure built from an exception message', () => {
    const text = 'return Failure.OfProtocol(ProtocolCode.PayloadUndecodable, reason.Message);';

    assert.deepEqual(sitesOf(text, CS), [1]);
  });

  test('finds a C# problem of a gateway built from an exception message', () => {
    const text =
      'return HttpProblems.Own(OwnFailure.Unwritable, reason.Message);\n' +
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

  test('a state handed on to a helper makes no helper of its caller', () => {
    const text = [
      'fn deliver<S: Side>(state: &mut S, envelope: Envelope) { let detail = state.detail_of(&envelope); }',
      'fn send<S: Side>(state: &mut S, credits: Vec<Credit>) { deliver(state, credit_of(credits)); }',
      'fn close<S: Side>(state: &mut S, (reason, handle): (&str, Option<&H>)) {',
      '    let local = CallError::Disconnected(reason.to_owned());',
      '    let credits = state.close_all(handle);',
      '    send(state, credits);',
      '}',
      'fn end<S: Side>(state: &mut S, panicked: &Panicked) { close(state, (&panicked.to_string(), None)); }',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), []);
  });

  test('a word parameter still makes a helper whatever the state beside it', () => {
    const text = [
      'fn fail<S: Side>(state: &mut S, reason: &str) { state.send(Failure::application(reason)); }',
      'fn end<S: Side>(state: &mut S, panicked: &Panicked) { fail(state, &panicked.to_string()); }',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [2]);
  });

  test('a method whose word parameter reaches a sink is a helper at that argument', () => {
    const text = [
      'impl Probe {',
      '    fn fail(&mut self, reason: &str) { self.send(Failure::application(reason)); }',
      '    fn end(&mut self, panicked: &Panicked) { self.fail(&panicked.to_string()); }',
      '}',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [3]);
  });

  test('reads whole a helper’s call a comparison splits', () => {
    const text = [
      'fn fail<S: Side>(state: &mut S, urgent: bool, reason: &str) { state.send(Failure::application(reason)); }',
      'fn end<S: Side>(state: &mut S, error: &Error) { fail(state, state.count() < state.bound(), &error.to_string()); }',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [2]);
  });

  test('reads whole a helper’s call whose first argument is a comparison', () => {
    const text = [
      'fn fail(urgent: bool, reason: &str) -> Failure { Failure::application(reason) }',
      'fn end(count: usize, error: &Error) -> Failure { fail(count < 4, &error.to_string()) }',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [2]);
  });

  test('reads whole a helper’s call a shift splits', () => {
    const text = [
      'fn fail(code: u32, reason: &str) -> Failure { Failure::application(reason) }',
      'fn end(error: &Error) -> Failure { fail(1 << 4, &error.to_string()) }',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [2]);
  });

  test('reads whole a helper’s call a closure of two parameters splits', () => {
    const text = [
      'fn fail(pick: impl Fn(u8, u8) -> u8, reason: &str) -> Failure { Failure::application(reason) }',
      'fn end(error: &Error) -> Failure { fail(|a, b| a + b, &error.to_string()) }',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [2]);
  });

  test('reads whole a method’s call in its path form', () => {
    const text = [
      'impl Probe {',
      '    fn fail(&mut self, reason: &str) { self.send(Failure::application(reason)); }',
      '    fn end(&mut self, error: &Error) { Self::fail(self, &error.to_string()); }',
      '}',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [3]);
  });

  test('leaves a call of a helper’s name the file shows to be another function’s', () => {
    const text = [
      'use crate::gateway::pace::Field;',
      'impl Refusal {',
      '    fn of(status: u16, detail: &str) -> Self { Self { status, detail: detail.to_owned() } }',
      '}',
      'impl Probe {',
      '    fn failed(&self, failure: &Failure) -> Problem { Problem { detail: failure.detail().to_owned() } }',
      '}',
      'fn answer(error: &Error) {',
      '    let length = Field::of("content-length", body.len().to_string());',
      '    let problem = failed(&CallFailure { code: 5 }, &error.to_string());',
      '    let shown = Probe::of(&error.to_string());',
      '    let refused = Refusal::of(400, &error.to_string());',
      '    let answered = probe.failed(&error.to_string());',
      '}',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [12, 13]);
  });

  test('reaches every helper of its name through a path the file does not resolve', () => {
    const text = [
      'pub trait Words: Send {',
      '    fn said(words: &str) -> Failure { Failure::application(words) }',
      '    fn told(&self, error: &Error) -> Failure { Self::said(&error.to_string()) }',
      '}',
      'impl Words for Probe {}',
      'impl<T> Refusal<T> {',
      '    fn of(status: u16, detail: &str) -> Self { Self { status, detail: detail.to_owned() } }',
      '}',
      'type R = Refusal<u8>;',
      'fn answer<T: Words>(error: &Error) {',
      '    let by_type = Probe::said(&error.to_string());',
      '    let by_trait = Words::said(&error.to_string());',
      '    let by_parameter = T::said(&error.to_string());',
      '    let by_qualified = <Probe as Words>::said(&error.to_string());',
      '    let by_turbofish = Refusal::<u8>::of(400, &error.to_string());',
      '    let by_alias = R::of(400, &error.to_string());',
      '}',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [3, 11, 12, 13, 14, 15, 16]);
  });

  test('reaches a local function and a closure by their bare call', () => {
    const text = [
      'impl Probe {',
      '    fn end(&mut self, error: &Error) {',
      '        fn fail(reason: &str) -> Failure { Failure::application(reason) }',
      '        let say = |words: &str| Failure::application(words);',
      '        self.send(fail(&error.to_string()));',
      '        self.send(say(&error.to_string()));',
      '    }',
      '}',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [5, 6]);
  });

  test('finds a detail handed to a gateway’s problem, through a helper of the file too', () => {
    const text = [
      'impl Inner {',
      '    fn own_problem(&self, own: OwnFailure, detail: &str) -> Problem {',
      '        problem_of_own(own, detail, &OwnProblemOptions::default())',
      '    }',
      '    fn bound(&self, other: MessageFormError) -> Problem {',
      '        self.report(&RouterError::Other(Arc::new(other.clone())));',
      '        let problem = self.own_problem(OwnFailure::Failed, &other.to_string());',
      '        let refused = problem_of_refusal(400, &other.to_string());',
      '        self.own_problem(OwnFailure::Failed, "")',
      '    }',
      '}',
    ].join('\n');

    assert.deepEqual(sitesOf(text, RS), [7, 8]);
  });

  test('leaves what another generator writes, and reads what beadc writes', () => {
    const site =
      '    fn to_owned_message(&self) -> Edges { Edges { detail: self.detail.to_string() } }';
    const buffa = [
      '// @generated by buffa-codegen. DO NOT EDIT.',
      '// source: transcoding.proto',
      '',
      site,
    ].join('\n');
    const beadc = [
      '// @generated by beadc 0.13.0 from spec/transcoding.proto: bead-blueprint/1, spec 0.14.0.',
      '// Do not edit: regenerate with beadc.',
      '',
      site,
    ].join('\n');

    assert.deepEqual(
      sitesOf(
        buffa,
        'implementations/rust/crates/bead-interop/src/transcoding/generated/messages/transcoding.__view.rs'
      ),
      []
    );
    assert.deepEqual(
      sitesOf(
        beadc,
        'implementations/rust/crates/bead-interop/src/transcoding/generated/bead_http.rs'
      ),
      [4]
    );
  });
});

describe('sourcesOf', () => {
  test('reads every side’s sources, their tests aside, what a generator writes among them', () => {
    const paths = [
      'implementations/typescript/src/transcoding/http-gateway.ts',
      'implementations/typescript/src/transcoding/__tests__/http-gateway.test.ts',
      'implementations/dotnet/src/Bead.Transcoding.Http/HttpGateway.cs',
      'implementations/dotnet/tests/Bead.Transcoding.Tests/HttpGatewayTests.cs',
      'implementations/rust/crates/bead/src/gateway/host.rs',
      'implementations/rust/crates/bead/src/gateway/host/tests.rs',
      'implementations/rust/crates/bead-interop/src/transcoding/generated/messages/transcoding.__view.rs',
    ];

    assert.deepEqual(sourcesOf(paths), [
      'implementations/typescript/src/transcoding/http-gateway.ts',
      'implementations/dotnet/src/Bead.Transcoding.Http/HttpGateway.cs',
      'implementations/rust/crates/bead/src/gateway/host.rs',
      'implementations/rust/crates/bead-interop/src/transcoding/generated/messages/transcoding.__view.rs',
    ]);
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

  test('accepts the Rust side’s allowed sites and reports one gone', () => {
    const core = 'implementations/rust/crates/bead/src/router/core.rs';
    const site = [
      'let failure = state',
      '    .core()',
      '    .failure(ProtocolCode::CAPACITY_EXCEEDED)',
      `    ${MARKER}`,
      '    .saying(error.message().to_owned());',
    ].join('\n');

    assert.equal(ALLOWED[core], 2);
    assert.deepEqual(
      problemsOf([core], () => `${site}\n${site}`),
      []
    );
    assert.match(problemsOf([core], () => site)[0], /1 allowed site\(s\) gone/);
  });

  test('refuses a marker that holds no site, by its line', () => {
    const problems = problemsOf([TS], () => `${MARKER}\nconst x = 1;`);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /:1: a marker that holds no site/);
  });
});
