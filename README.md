# Bead

[![CI](https://github.com/francisdesjardins/bead/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/francisdesjardins/bead/actions/workflows/ci.yml?query=branch%3Amain)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Bead is an exploration: how far one `.proto` file, a generator and a hybrid binary protocol can go —
a specification with its conformance files, two implementations at parity and the core of a
third, and the tools around them. It is a personal project, kept at its author's pace.

Bead is a binary wire protocol for calls between a client and a server: a request and its result or
failure, a subscription and its notifications, the commands a server sends back, cancels, sessions,
relays, and transfers of large payloads under credit. Each envelope is written at fixed big-endian
offsets, behind an 8-byte prefix whose first byte is the layout, `0xA1`, so a reader knows before
anything else whether it can read the rest.

This repository holds the protocol and its implementations, side by side:

- **the specification**, and the conformance files every implementation plays;
- **a TypeScript implementation**: WebSocket, HTTP, Web Worker and in-memory transports, each a
  client and a server, a broker's core over an in-memory broker, over MQTT 5 and over AMQP 1.0, its
  adapters over MQTT.js and rhea, a server's transports joined into one, the client and server
  routers, the service, session and notification managers, a gateway that answers a service's
  procedures over HTTP and JSON, and a demo;
- **a C# implementation** at behavioural parity with it: the same envelope, the same routers, the
  WebSocket, HTTP and in-memory transports, the broker's core over an in-memory broker, over MQTT 5
  and over AMQP 1.0, its adapters over MQTTnet and AMQPNetLite, the joined one, and the same
  gateway;
- **a Rust implementation**, its core whole: the same envelope, the same routers and managers,
  sessions and credentials, the trace, the filter and the registry, the in-memory transport, the
  broker's core over an in-memory broker, the joined one, and the `proto` codec on Buffa, playing
  the conformance files its core reaches, each part it lacks a row of the support matrix ahead
  ([0044](docs/decisions/0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md));
- **an interop service** the TypeScript and C# sides offer, which the other side's client calls over
  WebSocket, HTTP, MQTT 5 and AMQP 1.0, beside a gateway whose routes the other side's generated
  HTTP client calls.

**Nothing is published.** No package goes to npm or NuGet, and no image to a registry: build on a
commit, pinned. Publication is ahead.

## At a glance

A service is declared once, in a `.proto` with Bead's options, and `beadc` generates its server and
its client in TypeScript and in C#. What is left to write is the resolvers and the calls, here
abridged from [`examples/hello`](examples/hello), whose C# half writes the same:

```ts
// the server: its admission hooks, by the names the .proto gives them, and a resolver that asks
// its caller back before it answers
const hello = new HelloServer({ admissions: { greeted } });

hello.on('sayHello', async ({ connectionHandle, payload }, response) => {
  const name =
    payload.name === ''
      ? (await hello.command.askName({ question: 'What is your name?' })({ connectionHandle })).name
      : payload.name;

  return response({ greeting: `Hello, ${name}!` });
});
hello.offer(server);

// the client: answers the server's command, calls, and follows a subscription at its own pace
await using client = createWSClient();
const greeter = new HelloClient(client, { windows: { countDown: 1 } });

greeter.on('askName', (_request, response) => {
  return response({ name: 'Ada' });
});
await client.connect({ host: '127.0.0.1', port });

const { greeting } = await greeter.sayHello({ name: '' })(); // 'Hello, Ada!'

await greeter.notifications.countDown({ from: 3 }, async ({ remaining }) => {
  // a window of 1: the next tick waits until this callback settles
})();
```

## Next to the alternatives

gRPC-Web and Connect carry unary calls and server streaming to a browser, neither a client's stream
nor the server's own calls to the client; Bead carries both, and subscriptions the client paces,
over a WebSocket or plain HTTP.

## Why Bead

A client and its server talk in more ways than requests and answers. The server pushes changes the
client must keep up with. A large file goes up while other calls carry on. A call is cancelled
halfway. A call presents its own credential — a signed token, say — which outlives a dropped
connection and crosses a relay to the server that verifies it, and the server sometimes has to ask
the client something. Bead carries all of it in one small binary envelope, whatever carries the
envelope: WebSocket, plain HTTP where WebSocket cannot pass, a Web Worker in the page, memory
between two routers of one process, and a topic-based publish/subscribe broker, its core and an
in-memory broker on both sides, MQTT 5 its first binding to a real broker
([0041](docs/decisions/0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md))
and AMQP 1.0 on RabbitMQ 4 its second
([0043](docs/decisions/0043-over-amqp-1-0-a-participant-is-one-connection-whose-exclusive-inbox-ends-with-it-and-a-parcel-one-message-of-one-profile-each-counted-to-its-byte.md)).

- **Read without decoding.** A fixed 8-byte prefix and fixed offsets say what an envelope is, which
  call it belongs to and how long it is. A router or a relay acts on it without parsing its payload,
  whatever that payload's format.
- **Subscriptions at the client's pace.** A paced subscription sends only what the client has
  credited. What waits is kept by key, so a state keeps its latest value and an event keeps every
  one. A queue past its bound ends the subscription out loud, never in silence.
- **Large payloads under credit.** A transfer goes in chunks, as fast as its receiver credits them,
  beside the calls still under way.
- **Everything a conversation needs**: cancel, sessions, a credential on each call — a JWT, or
  what its transport carries — relays that forward it to the destination that verifies it, and
  commands, the server's own calls to the client.
- **One behaviour in every language.** The spec and its conformance files are the contract. The
  TypeScript and C# implementations both play them, and call each other in CI over WebSocket, HTTP,
  MQTT 5 and AMQP 1.0, and through each other's gateway.
- **No dependency.** The TypeScript side runs in browsers and in Node with nothing else installed;
  a project that binds `proto` brings protobuf-es, an optional peer, one over MQTT 5 brings
  MQTT.js, another, and one over AMQP 1.0 brings rhea, a third.

Bead fits wherever a client and its server hold a conversation rather than trade messages: directly,
from a browser over WebSocket or plain HTTP, and across a topic-based publish/subscribe broker that
already joins services and devices, MQTT 5's and AMQP 1.0's. Think of a dashboard
or a collaborative tool that follows state as it changes, an app that uploads large files while it
keeps working, a back office whose server needs to ask the client something, or a gateway that
forwards calls it never reads. A browser speaks Bead natively, with no proxy in between. Over a
broker, Bead adds what topics alone lack: calls with their answers and failures, cancels, each
client's own pace, and transfers under credit. Both ends keep the same API, whatever carries the
envelopes.

## Where Bead goes

- **Next**: Rust's transports over sockets with the interop both ways, then its broker bindings,
  its gateway and beadc's Rust target, each a record of its own after its core
  ([0044](docs/decisions/0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)),
  each a row of the
  [support matrix](docs/support.md#differences) until it lands.
- **Then**: a payload's rules written in CEL, a total subset beadc compiles into each side beside
  the rules it compiles already
  ([0035](docs/decisions/0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md));
  a connection's close code carried on `close`
  ([0033](docs/decisions/0033-a-side-bounds-what-a-peer-holds-of-it.md)); and a relay that carries
  a subscription, which a page across a broker needs
  ([0019](docs/decisions/0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)).
- **Further**: one corpus read alike by both sides' parsers, held as a gate as
  `tools/protobuf-conformance.mjs differential` holds a `proto` payload, and a short run of the
  targets of [Fuzzing](#fuzzing) in CI; a guard in CI against a gross regression of the benches
  ([Measurement](#measurement)); the transports' client part of the conformance over HTTP and a
  WebSocket, a relay across languages in the interop, the DevTools extension on Firefox, a counted
  call's cost measured against an uncounted one, a constrained C side and publication, each bound
  by the records that [the index](docs/decisions/README.md#where-bead-goes) names, with what else is
  ahead.

## Layout

```
spec/                         spec.md, debugging.md, transcoding.md, the conformance files both sides read, and check.py
  generators/                 the Python scripts that write them
  schemas/                    their JSON Schemas
implementations/
  typescript/                 a Yarn project of its own: src/, interop/, demo/, devtools/, browser/, tools/
  dotnet/                     Bead.slnx: src/, interop/, tests/, tools/Bead.Fuzz; and the other tools/, outside it
  rust/                       a Cargo workspace of its own: crates/bead, crates/bead-interop, crates/bead-house; fuzz/, benches/
builder/                      beadc, the builder: a Yarn project of its own: src/, proto/, test/, tools/
  Dockerfile                  beadc's image, built from the root, its tests run on the image itself
  wrappers/                   beadc.sh and beadc.ps1, which run the image, as templates beadc fills
  licenses/                   protobuf's licence, which the image ships for protoc and a package that carry none
examples/
  hello/                      a project as a consumer writes one, its TypeScript and C# halves generated by beadc
beadc.yaml                    the interop's code, generated from its blueprint by beadc
docs/
  decisions/                  the decision records, and their index
  support.md                  the support matrix: each feature in each language, and its test
tools/                        repository checks, the release, the coverage report, bench-compare.mjs and fuzz.mjs, the brokers' fixtures, mqtt-broker.mjs, amqp-broker.mjs and broker-fixture.mjs, Node without dependencies
  fuzz/                       fuzzer.json, the pin of the C# side's fuzzer and of its instrumenter
  protobuf-conformance/       runner.json, the pin of protobuf's conformance runner and its floor, and the testees' service.proto
  protovalidate-differential/ pin.json, the pin of protovalidate-es and the packages it needs
.githooks/                    the repository checks before each commit, opt-in
.github/workflows/ci.yml      the CI
CLAUDE.md, .claude/workflows/ the standing instructions for Claude sessions, and their workflows
```

Each implementation has its own toolchain, lockfile, linter, formatter and test runner, and runs
from its own folder. The root has no `package.json` and no task runner; it holds what every side
shares, above all `spec/`, which each reads in its tests.

## The specification and its conformance files

[`spec/spec.md`](spec/spec.md) states what every implementation does, in the RFC 2119 sense. Each
file of entries is named by a section whose clauses it plays, and each entry cites the units it
checks: [`units.txt`](spec/units.txt) lists every unit, whether an entry cites it or why none does,
and the hash of its text. Its companion, [`spec/debugging.md`](spec/debugging.md), states what a
side traces, filters and counts beside the wire, and its second,
[`spec/transcoding.md`](spec/transcoding.md), what a side's gateway answers over HTTP of its
procedures, each under a version of its own. Beside them:

| File                                                            | What it holds                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`vectors.json`](spec/vectors.json)                             | 457 named vectors in 16 groups: headers and envelopes read and written back to their bytes, the refusals, each with its code, a `JWT`'s verdicts, the credentials refused with their told reason, a broker's parcels and the messages refused as parcels, an MQTT 5 PUBLISH counted to its every byte under a bound, and an AMQP 1.0 message written and counted to its every byte |
| [`conversations.json`](spec/conversations.json)                 | The conversations: envelopes in and out of a server, step by step, over one connection or several, under the limits and pacing each one sets                                                                                                                                                                                                                                       |
| [`transports.json`](spec/transports.json)                       | 250 cases: what a transport's server does at its edge, over HTTP, over a WebSocket and over a broker, in memory, over MQTT 5 and over AMQP 1.0, the bytes each way, and over a broker what a client's transport does with the parcels its acceptors send, and the brokers the cases over MQTT 5 and AMQP 1.0 play against                                                          |
| [`clocks.json`](spec/clocks.json)                               | 9 clock cases: what every side's test clock does when a case advances it                                                                                                                                                                                                                                                                                                           |
| [`durations.json`](spec/durations.json)                         | 34 places that take a duration an application gives a side, by 51 ways, and what each makes of each of 19 inputs: held, at once, never, its default, or refused and why                                                                                                                                                                                                            |
| [`identities.json`](spec/identities.json)                       | 31 procedure names, 28 ids and revisions and 6 procedure kinds, each declared the six ways a side declares, and 8 pairs of names: what a router takes, or refuses and why, as a procedure is declared                                                                                                                                                                              |
| [`codecs.json`](spec/codecs.json)                               | Payloads read and values written, in `raw`, `text`, `json` and `proto`: the bytes written back, a JSON value in its canonical form, the fields a `proto` payload reads, or refused and why                                                                                                                                                                                         |
| [`codecs.proto`](spec/codecs.proto)                             | `Probe`, the fixed message the `proto` rows of `codecs.json` read and write, which each side's tests generate with their stock protobuf generator                                                                                                                                                                                                                                  |
| [`debug-filters.json`](spec/debug-filters.json)                 | 52 debug filters, what each reads as and which calls and envelopes it keeps, or why it is refused, and 6 filters given as functions, event by event                                                                                                                                                                                                                                |
| [`metrics.json`](spec/metrics.json)                             | 24 expositions, the text a registry writes for what it counts, byte for byte, and 53 exits of the interop service's server, the series each step moved                                                                                                                                                                                                                             |
| [`validations.json`](spec/validations.json)                     | 180 verdicts, payloads judged by their message's rules, the violations each gives in their order, and 64 details, what `PAYLOAD_INVALID`'s detail writes and reads                                                                                                                                                                                                                 |
| [`validations.proto`](spec/validations.proto)                   | the messages the verdicts judge, their rules protovalidate's, which beadc generates each side's validators for                                                                                                                                                                                                                                                                     |
| [`transcoding.json`](spec/transcoding.json)                     | 26 templates, 192 readings, 78 writings, 66 bindings, 46 failures, 10 events and 78 exchanges: what a gateway answers over HTTP of a service's procedures, its routes and its bindings, protobuf's JSON read and written by Bead's mapping, its problems, its streams, and its exchanges over a real socket                                                                        |
| [`transcoding.proto`](spec/transcoding.proto)                   | the messages and the service the entries play a gateway against, `google.api.http` rules among them, which beadc generates each side's code, route table and document of                                                                                                                                                                                                           |
| [`transcoding-required.proto`](spec/transcoding-required.proto) | the messages of `edition = "2023"` that `transcoding.proto` imports, since a `proto3` file declares none of them: fields protobuf requires, `LEGACY_REQUIRED`, at every depth, and a closed enum                                                                                                                                                                                   |
| [`interop-blueprint.json`](spec/interop-blueprint.json)         | the interop service's API: its one service, its 19 procedures, each with its kind, its bindings, its admission and its failures, in the builder's blueprint's form                                                                                                                                                                                                                 |
| [`interop-service.json`](spec/interop-service.json)             | what each procedure of the interop service takes, answers, admits and notifies, by its name; what its relay admits and forwards; and the credentials it verifies                                                                                                                                                                                                                   |

Every implementation reads these files from `spec/` in its tests; none keeps a copy. Eleven
generators write them, and regenerating must give the same bytes:

```sh
python spec/generators/make_vectors.py
python spec/generators/make_conversations.py
python spec/generators/make_transports.py
python spec/generators/make_clocks.py
python spec/generators/make_durations.py
python spec/generators/make_debug_filters.py
python spec/generators/make_metrics.py
python spec/generators/make_codecs.py
python spec/generators/make_identities.py
python spec/generators/make_validations.py
python spec/generators/make_transcoding.py
git diff --exit-code -- spec
```

Each file follows its JSON Schema in [`spec/schemas/`](spec/schemas/), and repeats the version
`spec.md` states as its `specVersion`, or, for `debug-filters.json` and `metrics.json`, the version
`debugging.md` states as its `debuggingVersion`, and, for `transcoding.json`, the one
`transcoding.md` states as its `transcodingVersion`. `spec/check.py` holds each, that the spec's
sections and the groups of vectors name each other, that every unit an entry cites is its
document's, that each ledger gives every unit of its document its status, each reason held by its
rule, and the hash of its text, which moves only where `python spec/check.py --write-units 15.7`
names the unit, and that every exposition reads as the Prometheus text format 0.0.4, that the
interop's blueprint is in its form and `interop-service.json` states its procedures, and that each
count the table above and the matrix's, in [`docs/support.md`](docs/support.md), state is what the
files hold; then it reports which groups and files each side's tests read, and fails on one a side
does not. It runs on Python 3.14, with `jsonschema`, `make_validations.py` with `google-re2` and
`make_transcoding.py` with `protobuf`, protobuf's own Python library, which `spec/requirements.txt`
locks with every hash; `make_validations.py` reads Unicode 17.0.0's files where
`spec/generators/ucd.json` pins them, fetched once into the temporary folder:

```sh
python -m venv .venv    # then activate it: .venv/bin/activate, or .venv\Scripts\Activate.ps1
python -m pip install --require-hashes --only-binary=:all: -r spec/requirements.txt
python spec/check.py
```

The interop's blueprint is written by hand and laid out by `python spec/check.py --write-blueprints`:
members sorted as RFC 8785 sorts them, arrays by identity, integers alone, two spaces and a final
newline.

## TypeScript

In `implementations/typescript`. Node 24.9 or later. Yarn 4 is vendored under `.yarn/releases/`, and
`.yarnrc.yml` points every `yarn` there; where no `yarn` is installed,
`node .yarn/releases/yarn-4.18.1.cjs` stands for it.

```sh
cd implementations/typescript
yarn install --immutable
yarn check        # types, lint and its plugin's cases, format, comment budget, the doc examples, the generated Probe
yarn test         # the unit tests, and the interop against the C# server
```

The package is `@francisdesjardins/bead`, private; its `exports` point at the sources. Its
[README](implementations/typescript/README.md) describes each layer.

## C#

In `implementations/dotnet`. The .NET 10 SDK, as `global.json` pins it; tests run on
Microsoft.Testing.Platform. Every warning is an error, the recommended analyzers are on, and every
public member has its doc comment. Its [README](implementations/dotnet/README.md) describes its
layout and its modules.

```sh
cd implementations/dotnet
dotnet format Bead.slnx --verify-no-changes --exclude ../../builder/test/golden/csharp interop/Bead.Interop/Generated tests/Bead.Protobuf.Tests/Generated
dotnet build Bead.slnx
dotnet test --solution Bead.slnx
```

With `CI=true`, a restore that would change a `packages.lock.json` fails. The core's test project
generates `Probe` from `spec/codecs.proto` at each build, with Grpc.Tools, beside Google.Protobuf;
nothing it generates is committed.

## Rust

In `implementations/rust`. Rust 1.99.1 and edition 2024, as `rust-toolchain.toml` pins them, which
rustup installs with clippy, rustfmt and llvm-tools; on Windows, the MSVC build tools' C++ linker,
and no C compiler beyond it, the core being pure Rust. Clippy's `pedantic`, `nursery` and `cargo`
groups and chosen restriction lints are denied, `unsafe_code` forbidden, and every warning of rustc,
clippy and rustdoc an error by its `.cargo/config.toml`
([0044](docs/decisions/0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)).
Its [README](implementations/rust/README.md) describes its crates and its modules.

```sh
cd implementations/rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked
cargo test --workspace --all-features --locked
cargo deny --locked check
```

The packages are `francisdesjardins-bead*`, their libraries `bead*`, `publish = false`. Bead takes
the application's tokio runtime, which enables its time driver, `enable_all` or `enable_time`, and
starts none of its own; an operation goes as it is made, and dropping its future cancels nothing.
Its `proto` codec, `bead-protobuf`, is built on Buffa 0.9.2, whose generated code its tests include
under one `#[expect]` of the workspace's lints.

## The builder

In `builder/`, `beadc`: it compiles a `.proto` with buf, resolves it into a blueprint, refuses a
`.proto` or a blueprint by rule name, writes a blueprint in its form, holds a project to its last
release, `beadc breaking`, and generates a typed server and client, in TypeScript and in C#: each
side's interop is its output
([0022](docs/decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
Node 24.9 or later, and a toolchain of its own, as the TypeScript side's: Yarn 4 vendored under
`.yarn/releases/`, buf from its lockfile, and protoc, which writes the C# messages, by its pin,
`protoc.json`, whose archive `tools/fetch-protoc.mjs` fetches and checks by its sha256. Node runs
`src/cli.ts` as written.

```sh
cd builder
yarn install --immutable
export BEADC_PROTOC="$(node tools/fetch-protoc.mjs)"   # protoc, by its pin
yarn check        # types, the goldens' types, lint, format, buf's lint and format, the options' generated code
yarn test         # beadc's tests, the interop's .proto and its blueprint, and both targets' goldens among them
node src/cli.ts check ../spec/interop-blueprint.json
node src/cli.ts blueprint --check ../spec/interop-blueprint.json
```

The last two hold the interop's blueprint to beadc's rules and to its form, as CI does. The root's
[`beadc.yaml`](beadc.yaml) names what beadc generates from that blueprint, each side's interop: from
the root, `generate` writes both, and `generate --check`, CI's step, holds them there; the
interop's blueprint binds no message, so neither needs protoc:

```sh
node builder/src/cli.ts generate --check
```

Its [README](builder/README.md) gives the commands, the rules and their reasons, the TypeScript and
C# targets, the image and its wrappers, and what each option of `bead/options.proto` means.

## An example

[`examples/hello`](examples/hello/README.md) is a project written as a consumer writes one: a
`.proto` of `proto` messages, a procedure that notifies at a window of 1, its request held to a
rule, a command, a catalogue and a hook, generated by beadc into a TypeScript half and a C# half,
each of whose servers answers its routes over HTTP and JSON by a gateway beside it
([0022](docs/decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
Each half reaches its runtime from its source, the TypeScript half by a Yarn `portal:` and the C#
half by a `ProjectReference`, takes the house's rules by reference where its platform can, a copy
held to them where it cannot, and builds twice: its messages generated by beadc, and by its
platform's own generator, protoc-gen-es under `buf generate` and Grpc.Tools.
[`pairs.mjs`](examples/hello/pairs.mjs) plays each client against each server, both modes of each
half, sixteen pairs, then asks that server's gateway, and holds what each client writes and the
gateway answers to [`transcript.txt`](examples/hello/transcript.txt), byte for byte. Its README says
how to generate, build and run it, and what a project outside this repository writes instead.

## Interop, both ways

Each side starts the other's interop server and calls it with its own client, over WebSocket and
over HTTP, and, against a broker of the run's own, over MQTT 5 and over AMQP 1.0:

- the C# client against the TypeScript server: `Bead.Interop.Tests`, run by `dotnet test`, starts
  it with Node from `implementations/typescript`, which must be installed;
- the TypeScript client against the C# server: `yarn test:interop` builds and starts
  `Bead.Interop.Server` with `dotnet run`.

In the same runs, each side's generated HTTP client calls the gateway the other side's interop
server serves beside it, of `spec/transcoding.proto`'s service: protobuf's JSON and every native
encoding, its problems and the authorization it presents, a stream's result, notifications and
ending failure, and the gateway's own refusals of a route, a size and a busy stream; and both
served OpenAPI documents are compared byte for byte (`interop.test.ts`'s gateway tests under
`the C# server of the interop service`; `HttpInteropTests.cs`).

Where the other runtime is missing, each skips its interop, saying so. `BEAD_INTEROP_REQUIRED=1`
turns that skip into a failure, as the CI sets it: there, a skip could only be a path to the other
side gone wrong.

```sh
cd implementations/typescript && BEAD_INTEROP_REQUIRED=1 yarn test:interop
cd implementations/dotnet && BEAD_INTEROP_REQUIRED=1 dotnet test --project tests/Bead.Interop.Tests
```

Over a broker, the broker is one of the run's own: `tools/mqtt-broker.mjs` starts a Mosquitto 2.1.2
and `tools/amqp-broker.mjs` a RabbitMQ 4.4.0, each by its digest under Docker, a password drawn for
the run, and `run` stops it whatever the command's end. The TypeScript client calls the C# server
over each by `yarn test:mqtt` and `yarn test:amqp`, among the cases over that binding and its
adapter's tests; the C# client calls the TypeScript server by `Bead.Interop.Tests`, filtered to its
transport's trait. Where `BEAD_MQTT_URL` or `BEAD_AMQP_URL` names no broker, each skips, saying so;
`BEAD_MQTT_REQUIRED=1` and `BEAD_AMQP_REQUIRED=1` turn that skip into a failure, as CI's jobs `mqtt`
and `amqp` set them.

```sh
cd implementations/typescript && node ../../tools/mqtt-broker.mjs run -- yarn test:mqtt
cd implementations/typescript && node ../../tools/amqp-broker.mjs run -- yarn test:amqp
cd implementations/dotnet && node ../../tools/mqtt-broker.mjs run -- dotnet test --project tests/Bead.Interop.Tests --filter-trait "transport=MQTT"
cd implementations/dotnet && node ../../tools/amqp-broker.mjs run -- dotnet test --project tests/Bead.Interop.Tests --filter-trait "transport=AMQP"
```

A page of another origin calls both HTTP servers in Chromium: `yarn test:browser`, in a Playwright
config of its own, serves a page on `localhost` whose bundled HTTP client calls each side's interop
server on `127.0.0.1`, which names the page's origin as `BEAD_INTEROP_ORIGINS` lists it. Its C#
half starts `Bead.Interop.Server` with `dotnet run`, and skips or fails as the interop does. Over
MQTT 5, a page's client links to the broker's WebSocket, `BEAD_MQTT_WS_URL`, and calls each side's
interop server through its name, as CI's job `mqtt` runs it (`yarn test:browser --grep "MQTT 5"`);
where no broker is given, it skips, saying so.

```sh
cd implementations/typescript
yarn playwright install chromium
BEAD_INTEROP_REQUIRED=1 yarn test:browser
```

## The demo

A page with a button per kind of call — a read, a write, a subscription, a transfer either way, a
cancel, a failure, a command — the calls and envelopes logged as the client sees them, and what the
client's and the server's metrics registries count, over WebSocket, HTTP or a Web Worker, and,
where it runs beside a broker, over MQTT 5 with `?transport=mqtt`; and a sign-up form, a service
beadc generates from the demo's `.proto`, whose refusals by its payload rules show each violation
under its field.

```sh
cd implementations/typescript
yarn demo                    # page and servers on http://localhost:8080 (DEMO_PORT moves it)
yarn playground:build:file   # the static build, into demo/dist/playground/
yarn test:demo               # its tests, once the static build is built
node ../../tools/mqtt-broker.mjs run -- yarn demo   # beside a broker, over MQTT 5 at ?transport=mqtt
```

The static build runs its server in a Web Worker of the page, every path relative, so any static
host serves it as files. `yarn test:demo`'s leg over MQTT 5 skips, saying so, where no broker is
given.

## The DevTools extension

A Bead panel in Chrome's DevTools: the calls, envelopes and metrics of each client a page builds,
which announces itself to the extension unless its options say `devtools: false`, a server in a Web
Worker of the page included, whose messages the Network panel does not show.

```sh
cd implementations/typescript
yarn devtools:build   # unpacked, into devtools/dist/: chrome://extensions, then Load unpacked
yarn test:devtools    # its tests, once it and the demo's static build are built
```

Where a broker is given, `BEAD_MQTT_URL` and `BEAD_MQTT_WS_URL`, its tests also follow the demo's
client over MQTT 5 to the panel, as CI's job `mqtt` runs them (`yarn test:devtools --grep "over
MQTT 5"`); where none is, that test skips, saying so.

## Coverage

Each side's tests run under coverage in CI, and what they run is held to the side's floor in
[`tools/coverage-floors.json`](tools/coverage-floors.json), each measure it names: lines and
branches, or lines and regions on the Rust side, whose stable compiler counts no branch. Each side
writes its own report — c8 an istanbul `coverage-final.json`, `dotnet test --coverage` one cobertura
XML per test project, `cargo llvm-cov` one LLVM JSON export — and `tools/coverage-report.mjs`
reads each, merges what the first two say of the same file, and prints each file's lines and
branches or regions run, then the lines no report ran; with `--floor`, it fails under the side's
floor, when it measured nothing, or on a measure the floor names and no report measured, and with
`--summary`, it writes the report into the run's summary. A floor sits half a point under what was measured, and
rises with `--raise`, never down but by a decision
([0006](docs/decisions/0006-a-rule-has-its-gate.md)). Each run keeps its reports 14 days, among its
artifacts: `coverage-typescript`, c8's HTML to browse and its lcov, `coverage-csharp`, the
cobertura files, and `coverage-rust`, the LLVM export. Locally, the same commands as CI's:

```sh
cd implementations/typescript
yarn test:coverage --grep-invert "the C# server of the interop service"
node ../../tools/coverage-report.mjs coverage/coverage-final.json --under implementations/typescript/src --floor typescript
```

```sh
cd implementations/dotnet
rm -rf TestResults/coverage  # every report in the folder is merged: a stale one counts too
dotnet test --solution Bead.slnx --coverage --coverage-output-format cobertura --results-directory TestResults/coverage
node ../../tools/coverage-report.mjs TestResults/coverage/*.cobertura.xml --under implementations/dotnet/src --floor csharp
```

```sh
cd implementations/rust
cargo llvm-cov --workspace --all-features --locked --json --summary-only --ignore-filename-regex '(/tests\.rs|/tests/.*|/testing\.rs|/testing/.*)$' --output-path coverage/rust.json
node ../../tools/coverage-report.mjs coverage/rust.json --under implementations/rust/crates/bead/src --under implementations/rust/crates/bead-protobuf/src --floor rust
```

## Measurement

Both sides measure the same seven layers on the loopback. Run one comparison at a time on a quiet
machine, with Node, the TypeScript dependencies and .NET installed. Both benches start the other
side's interop server as the interop tests do: `interop/serve.ts` for TypeScript, and
`dotnet run -c Release --no-build --project interop/Bead.Interop.Server` for C#, after one build. The server reports its
WebSocket, HTTP and gateway ports and serves until its standard input closes. A launch failure
fails the bench; every reported measure has every requested run.

For a release, `tools/bench-release.mjs` runs at least five fresh processes (five by default).
Each process runs one warm-up pass followed by two recorded runs (`--runs 2` by default). The
orchestrator asks the bench for one extra run and drops the first from the statistics, on both
sides and on a previous tag's checkout alike. It runs TypeScript under `node --expose-gc` and C#
from its built binary, with the build outside the measurement processes. The TypeScript bench's
C# interop server is built once, then launched with `--no-build`.

From the root, screen each side against the last release's stored report:

```sh
node tools/bench-release.mjs typescript --output .bench/candidate-typescript.json
node tools/bench-release.mjs csharp --output .bench/candidate-csharp.json
node tools/bench-compare.mjs .bench/baseline-typescript.json .bench/candidate-typescript.json --threshold 25%
node tools/bench-compare.mjs .bench/baseline-csharp.json .bench/candidate-csharp.json --threshold 25%
```

`--processes` requires an integer of at least 5; `--runs` and `--seconds` require positive integers.
`--seconds` defaults to 3 and bounds each timed phase of each run. Each codec also warms for 5,000
round trips, each call payload for 500 calls, and each large echo for one call. A full bench costs
about 75 minutes per side at N=5, depending on the machine; a full baseline/candidate interleave
costs twice that. Run the two client sides sequentially. `--transcoding` runs only the four
transcoding measures and starts no interop server. `--filter <id-or-name>` on the orchestrator and
on both benches selects an exact measurement ID or name. Shared phases, such as the three
percentiles of one latency run, run once and report only the selected rows. An unmatched filter
fails the run.

Each bench also runs alone, writing `bead-bench/1`; its `--runs` defaults to 3 and includes no
discarded pass. With `--json`, JSON alone goes to stdout. Without it, the bench prints its
environment, method, and each measure's median, minimum and maximum. The orchestrator writes
`bead-bench/2` to stdout, or to `--output <file>`. Progress and every process's value go to stderr.

| Layer         | Measure                                                    | Unit and scope                                                                                                                                         |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Envelope      | `codec.roundTrip`                                          | ns per request written and read back, at 0 B, 1 KiB and 64 KiB                                                                                         |
| Payload       | `json.roundTrip`                                           | ns per JSON string encoded and decoded, at the same sizes                                                                                              |
| Transcoding   | `transcoding.read.bead`, `transcoding.read.stock`          | ns per body of `spec/transcoding.json`'s message of every kind of field read to its message's bytes, by Bead's mapping and by the stock library's JSON |
| Transcoding   | `transcoding.write.bead`, `transcoding.write.stock`        | ns per message's bytes written to its body, by Bead's mapping and by the stock library's JSON                                                          |
| Calls         | `call.p50`, `call.p95`, `call.p99`                         | us per sequential JSON echo, at the same sizes, over HTTP, WebSocket and in memory                                                                     |
| Calls         | `call.throughput`                                          | calls/s in batches of 32, over each transport and payload size                                                                                         |
| Calls         | `call.memory`                                              | B/call over 2,000 sequential calls; the runtime's method below defines these bytes                                                                     |
| Exchanges     | `exchange.p50`, `exchange.p95`, `exchange.p99`             | us per exchange in memory: a client and its connection drawn, one JSON echo, closed                                                                    |
| Exchanges     | `exchange.throughput`, `exchange.memory`                   | exchanges/s in batches of 32, and B/exchange over 2,000 sequential exchanges                                                                           |
| Notifications | `notification.p50`, `notification.p95`, `notification.p99` | us from the server's notify to its client's handler                                                                                                    |
| Notifications | `notification.throughput`                                  | notifications/s received, including the final drain                                                                                                    |
| Large echo    | `transfer.echo`, `transfer.throughput`                     | ms per 20 MiB echo and MiB/s, counting both directions                                                                                                 |

Every call measure runs with client and server in the same process (`local`) and with the other
language's interop server in a child process (`interop`), on each transport; in memory, locally
alone, where each exchange draws a connection as a gateway draws one per HTTP exchange, against
calls on one connection kept. The report's `side` names its client: `typescript` calls C# in
`interop`, and `csharp` calls TypeScript. Codecs, notifications and large echoes run locally. The
notification producer targets a 1 ms cadence, uses a credit window of 32 and gives every value its
own place, with no replacement key. At each wake-up it sends every value whose deadline passes,
catching up after a late timer; at most 32 values await their handlers. It sleeps until the next
deadline when caught up. Each value's monotonic timestamp is taken immediately before its own
notify; latency includes serialization, scheduling, transport and decoding. Every due notification
reaches the handler within the timed phase plus a 30 s drain allowance. Throughput records the
achieved rate, including drain time.

A WebSocket carries the 20 MiB echo as protocol transfer chunks. HTTP carries each payload in one
whole envelope, with a 32 MiB envelope and payload limit on both endpoints; HTTP supports no
protocol transfer chunks. The large-echo rows compare the cost of moving the same application
payload through each transport's supported framing.

Both sides count bytes allocated on their managed heap around 2,000 calls, process-wide, including
transient objects and unrelated background work. C# uses `GC.GetTotalAllocatedBytes(true)`. Node
uses `v8.GCProfiler`, with `used_heap_size` readings just inside its start/stop interval:
`allocated = usedEnd - usedStart + sum(beforeGC.heapStatistics.usedHeapSize - afterGC.heapStatistics.usedHeapSize)`.
The sum counts bytes reclaimed by every collection, so transient allocations count too. The
profiler's camelCase fields and the heap reading's snake_case field carry those names on Node
24.9. `--expose-gc` is optional: it allows a full GC before profiling, reducing garbage carried
into the interval. The calculation requires no explicit GC. A negative or non-finite allocation
value fails the run. Both counters include client and server in `local`, and only the client
process in `interop`. Neither counts the remote server or native allocations; V8 also excludes
external buffers such as `ArrayBuffer` backing stores. The reports state each counter and scope.

Each bench's `bead-bench/1` report carries:

- `side`: `typescript` or `csharp`;
- `environment`: CPU model and logical count, OS platform/release/architecture, Node and V8
  versions, .NET version information, and the measured Git commit;
- `method`: runs, seconds per phase, concurrency, notification interval/window, memory call count,
  the memory method/scope/limitations, and the large-echo and interop scopes;
- `measures`: rows with `id`, `name`, `scenario`, `transport`, `sizeBytes`, `unit`, `direction`, raw
  `samples` in run order, and their `median`, `min` and `max`. An even run count averages the two
  central samples. The ID is `<scenario>.<transport>.<sizeBytes>.<name>`; codecs use transport
  `none`. Latency, codec time and memory use direction `lower`; throughputs use `higher`.

The orchestrator's `bead-bench/2` keeps the same identities and environment. Its `method` adds
`processes` and `warmup`, with `runs` counting recorded runs per process. Each measure has
`processes`, an array of recorded run arrays in process order, `warmups`, the discarded runs per
process, and `medians`, the median of each process. Its `median`, `min` and `max` summarize these
process medians. Runs within a process are not independent samples. Processes that differ in
side, environment, commit, runtime versions, method, IDs or units are refused; any process failure
fails the collection without publishing a report.

The comparison reads both schemas, treating `/1` as one process. It checks units, directions,
raw samples and statistics. Every baseline measure must be in the candidate; a measure the
candidate adds is listed `new`, with no verdict. Different memory counters are identified.
Without a threshold, cross-side and single-process comparisons print and exit 0. With a
threshold, fewer than five processes on either side refuses a verdict (exit 2): re-bench the
previous tag under this method. Invalid reports, missing or incompatible baseline measures and
selectors matching nothing also exit 2.

```sh
node tools/bench-compare.mjs baseline.json candidate.json --threshold 25%
node tools/bench-compare.mjs baseline.json candidate.json --threshold 25% --threshold call.p99=15% --threshold local.http.1024.call.p99=10%
```

The effect is the Hodges–Lehmann relative change: the median of every candidate/baseline
process-median ratio, minus one, in percent. Positive means a larger value; a zero baseline gives
an unbounded increase unless both values are zero. A regression is an increase for `lower`, a
decrease for `higher`. An exact ID's threshold takes precedence over a name's, then the default;
repeat `--threshold` for distinct selectors. Equality passes.

A measure is `regression` only when its effect is strictly past the threshold and its exact
one-sided Mann–Whitney p is at most .05, over process medians in the regression's direction. It is
`inconclusive` when only the effect is past the threshold, and `ok` otherwise. Every labeling of
the pooled observations is enumerated by its rank sum, counting ties exactly. At five processes
per side without ties, U must reach 21 of 25 (p = 12/252). The output shows U, p, every process's
median, and each measure's smallest detectable change: the infimum rank-significant percentage
shift of the observed candidate spread, normalized to zero HL change, against the baseline.
This describes empirical rank resolution at these samples, not a power guarantee. Relative
resolution is unavailable with zero values or too few samples to attain p ≤ .05.

Exit 1 means at least one `regression` and is advisory; `inconclusive` alone exits 0 and still
requires review. At N=5, simulations on the transcoding measurements give roughly 1% false flags
per unchanged measure and 70–90% detection at a +35% change. These rates depend on the
measurement's distribution; 112 measures can give about one false flag per side, with noisier
tails. The threshold and p test screen findings; confirmation settles them. CI has no performance
guard: its `dotnet` job builds the C# bench in Release, so that a release's measure finds it whole,
and measures nothing.

Confirm every `regression` and `inconclusive` on a quiet machine against a checkout of the previous
tag. `--tree` builds and runs that baseline, alternating the trees process by process in ABBA
order, baseline then candidate, then candidate then baseline. Both trees need their TypeScript
dependencies installed. `--filter` reaches the benches only when both take it; when one has none,
both run whole and their reports are selected by the same ID or name, so that a measure meets the
same phases before it, and the same warm-up, in each tree. The C# side's in-memory call throughput
settles each process in one of a few modes, from one version to the next alike; its confirmation
takes eight processes or more a tree. For example, from the candidate tree:

```sh
git worktree add --detach ../bench-baseline v0.7.0
# Install the TypeScript dependencies in ../bench-baseline/implementations/typescript.
node tools/bench-release.mjs typescript --tree ../bench-baseline --baseline-output .bench/confirm-baseline-typescript.json --output .bench/confirm-candidate-typescript.json --filter call.p99
node tools/bench-compare.mjs .bench/confirm-baseline-typescript.json .bench/confirm-candidate-typescript.json --threshold 25%
node tools/bench-release.mjs csharp --tree ../bench-baseline --baseline-output .bench/confirm-baseline-csharp.json --output .bench/confirm-candidate-csharp.json --filter call.p99
node tools/bench-compare.mjs .bench/confirm-baseline-csharp.json .bench/confirm-candidate-csharp.json --threshold 25%
```

For a full interleave, omit `--filter`. Each release keeps its two full reports,
`.bench/v<version>-typescript.json` and `.bench/v<version>-csharp.json`, which git ignores. A
`regression` or `inconclusive` is read before the finish, confirmed, then explained in the release's
notes or fixed. A stored baseline from another session can include machine drift; the interleave
reduces that drift's effect.

## Fuzzing

Both sides fuzz the same six parsers, guided by coverage, each fed raw bytes: `envelope`, the
envelope reader, header and body, and a failure's record; `payload-codecs`, the `json` and `text`
codecs' readers, what they read written back; `http-fields`, the HTTP transport's field parsers,
an Item of RFC 9651 for the `Bead-*` fields, `Authorization`, `X-Forwarded-For`, the target and its
`Host`, and `Origin`, the first byte picking the field; `debug-filter`, the `debug` filter's
parser and the patterns of the filter it returns; `jwt`, the JWT verifier of section 13.8, over a
token one octet a character, as the header carries it, verified as it came and again signed with
the HS256 key it may name, under the keys, audiences and clock of `spec/vectors.json`'s verdicts;
`ws-handshake`, the WebSocket transport's judgement of an upgrade before its 101 (spec 15.2), the
first byte picking the whole head, its request line or one field of RFC 6455's handshake that the
rest replaces. The Rust side fuzzes four of them, those its core holds, `envelope`,
`payload-codecs`, `debug-filter` and `jwt`, with cargo-fuzz on the nightly `tools/fuzz.mjs` pins by
its date, on Linux or WSL, from `implementations/rust/fuzz/`, `http-fields` and `ws-handshake`
coming with its transports. The TypeScript side fuzzes a seventh, `blueprint`, beadc's blueprint reader, its
JSON, its schema and its rules, and its form written back and read again; beadc has no C# side, so
it has no twin. A target lets its parser's documented refusal pass; any other exception, an input
past 1 s, or memory past 256 MiB of its own is a finding. The TypeScript side runs
[Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) over
`implementations/typescript/tools/fuzz/`, a Yarn project of its own, installed by hand, which
neither the package's install nor CI fetches; `blueprint` runs from `builder/tools/fuzz/`, beadc's
alike, since beadc's code imports its own `.ts` files as Node runs them, which the TypeScript
side's type-check refuses. The C# side runs
[SharpFuzz](https://github.com/Metalnem/sharpfuzz) and libFuzzer for Windows,
[libfuzzer-dotnet](https://github.com/Metalnem/libfuzzer-dotnet), over
`implementations/dotnet/tools/Bead.Fuzz`, whose fuzzer `tools/fuzz/fuzzer.json` pins by its release
and its SHA-256. `tools/fuzz.mjs` drives both, by hand; CI only builds and checks the targets.

From the root, once, then after every change to what a target reads:

```sh
(cd implementations/typescript/tools/fuzz && yarn install)
(cd builder/tools/fuzz && yarn install)
node tools/fuzz.mjs fetch
node tools/fuzz.mjs seed
node tools/fuzz.mjs build typescript
node tools/fuzz.mjs build csharp
```

`fetch` writes the fuzzer and SharpFuzz's instrumenter into `Bead.Fuzz/.fuzzer/`; `seed` writes the
bytes of `spec/vectors.json`, `conversations.json`, `transports.json`, `codecs.json` and
`debug-filters.json` into each side's `corpus/<target>/`, and the repository's blueprints, with
each case of `builder/test/blueprints/` applied to the interop's, into `builder/tools/fuzz/`'s;
`build typescript` bundles both folders' targets with the TypeScript side's esbuild, so it wants
`yarn install` done in `implementations/typescript` and in `builder`; `build csharp` publishes
`Bead.Fuzz` and instruments its copies of `Bead.Core` and `Bead.Transport.WebSockets`. Then, for
ten minutes:

```sh
node tools/fuzz.mjs run typescript envelope -- -max_total_time=600
node tools/fuzz.mjs run csharp envelope -- -max_total_time=600
```

A run grows its target's `corpus/<target>/` and writes a finding to `findings/<target>/`, as
`crash-`, `timeout-` or `oom-` and the input's SHA-1; git ignores both folders. The run prints the
finding's exception and its stack. Given files in place of the corpus, a run reads each once, on
either side, so a finding replays on its own side and on the other:

```sh
node tools/fuzz.mjs run csharp http-fields implementations/dotnet/tools/Bead.Fuzz/findings/http-fields/crash-<sha1>
node tools/fuzz.mjs run typescript http-fields implementations/dotnet/tools/Bead.Fuzz/findings/http-fields/crash-<sha1>
node tools/fuzz.mjs run csharp http-fields <finding> -- -minimize_crash=1 -runs=10000
```

On the C# side, libFuzzer's `cov` counts its own driver's edges; the instrumented assemblies'
coverage is its `ft`. Node and Jazzer.js hold about 220 MiB before the first input, so the
TypeScript side's process limit is 512 MiB, and `blueprint`'s 768 MiB, since it loads beadc's
descriptors and schemas before it, about 170 MiB more; Node holds its heap to 256 MiB, as the C#
side's runtime holds its managed heap, so what a run keeps past it fails as a finding, never as a
slow climb to the limit. A finding becomes a case of the side's envelope fuzz test, or of its
parser's own test file, its input in hexadecimal.

## Support

[`docs/support.md`](docs/support.md) shows, feature by feature, what each implementation supports
and the test that proves it: the aim is one behaviour in every language, and a difference stays
there only until it closes. It holds beadc's two wrappers alike, `beadc.sh` beside `beadc.ps1`,
with what one shell cannot do and the test that shows it, and an example's two halves, each client
against each server.

## Repository checks

- `node tools/check-commits.mjs <range>`: every commit subject in the range is a Conventional
  Commit; merges are left out. With `--message <file>`, the message git is about to record, which
  must also be UTF-8 without a byte order mark.
- `node tools/check-links.mjs`: every relative link of the repository's Markdown resolves, to a file
  or a folder git keeps, and its anchor to a heading of the file it names. Given files, those alone.
- `node tools/check-details.mjs`: no exception's message goes into a failure's detail but at the few
  sites that report alone (spec 9.0), on either side, each marked where it stands by
  `// ! a detail of the side's own words: <why>`. Given files, those alone.
- `node tools/check-versions.mjs`: on every ref, each version agrees with itself — the TypeScript
  package's and the builder's, the C# side's and the project ranges of the C# lock files, an
  example's among them, and each conformance file's with its document's — and each released section
  of the CHANGELOG stays as its tag shipped it. On a release branch, a pull request into `main` and
  `main`, the product and each changed document also move one step past their last release, the
  CHANGELOG is dated and linked, and each document's tag stands where it belongs. `--ref` and
  `--base` judge the tree as another ref, as CI does.
- `node tools/check-format.mjs`: the root's own files — the README to the CI, the spec's texts and
  schemas, the tools, the workflows, an example's files outside its halves — in the layout the
  TypeScript side's formatter gives them; with `--staged`, the staged ones alone. It needs the
  TypeScript side installed.
- `node tools/check-examples.mjs`: each project of `examples/` keeps what it copies of the house as
  the house has it — the C# half's `global.json`, `nuget.config` and `.editorconfig`, the TypeScript
  half's oxfmt options and its packages' descriptors — and its wrappers, its `buf.yaml` and its git
  lines as `beadc wrapper` and `beadc init` write them, under a name `init` takes. It needs the
  builder installed.
- `node tools/protobuf-conformance.mjs typescript|csharp|rust|differential`: protobuf's conformance
  suite through one side's generated `proto` codec, its failure list held both ways and its count
  of tests to the floor `tools/protobuf-conformance/runner.json` pins with the runner, fetched by
  its sha512; or one corpus of `Probe` through the TypeScript and C# sides, read alike. The suite
  runs on Linux or macOS, where the runner has a binary, on Linux one of glibc 2.38 or later; it
  needs the TypeScript side and the builder installed, .NET for the C# side, and Rust's toolchain
  for the Rust side.
- `node tools/protovalidate-differential.mjs oracle|typescript|csharp`: protovalidate-es, at the pin
  `tools/protovalidate-differential/pin.json` holds and fetched by its sha512, over the verdicts of
  `spec/validations.json`; or those verdicts and a corpus mutated from them through one side's
  generated validators and through protovalidate-es, the violations compared by rule and by path
  elements. It needs the TypeScript side and the builder installed, and .NET for the C# side.
- `node tools/check-validations.mjs [typescript|csharp]`: each side's validators of
  `spec/validations.proto`, committed beside its verdicts test, are what beadc writes for it;
  `--write` writes them. It needs the builder installed.
- `node tools/check-transcoding.mjs [typescript|csharp]`: each side's route table and document of
  `spec/transcoding.proto`, committed beside its gateway's tests, are what beadc writes for it;
  `--write` writes them. It needs the builder installed.
- `node tools/mqtt-broker.mjs start|stop|run -- <command…>`: a Mosquitto 2.1.2 of the run's own,
  by its digest under Docker or natively with `--native <folder>`, that `spec/transports.json`'s
  `brokers.mqtt` describes, its access control spec 15.31's, under a container name, loopback ports
  and a password drawn for the run; `start` prints `BEAD_MQTT_URL`, `BEAD_MQTT_WS_URL`,
  `BEAD_MQTT_PASSWORD` and `BEAD_MQTT_BROKER` as PowerShell's `$env:` lines, or to `$GITHUB_ENV`
  with `--github-env`; `run` starts one, runs the command under those variables and stops it
  whatever the command's end, so that each suite, terminal or worktree plays the cases over MQTT 5
  against a broker of its own.
- `node tools/amqp-broker.mjs start|stop|run -- <command…>`: a RabbitMQ 4.4.0 of the run's own, by
  its digest under Docker, that `spec/transports.json`'s `brokers.amqp` describes, its exchange,
  name queues and permissions spec 15.38's, under a container name, a loopback port and a password
  drawn for the run; `start` prints `BEAD_AMQP_URL`, `BEAD_AMQP_PASSWORD` and `BEAD_AMQP_BROKER`
  as PowerShell's `$env:` lines, or to `$GITHUB_ENV` with `--github-env`; `run` starts one, runs
  the command under those variables and stops it whatever the command's end. What it shares with
  `tools/mqtt-broker.mjs`, the container's name, the ports, the password, the run's folder and the
  three commands, is `tools/broker-fixture.mjs`'s.
- `node --test "tools/__tests__/*.test.mjs"`: the root's tools' own tests, in Node's runner, each in
  repositories it makes under the system's temporary folder.

Two run before each commit, once a clone opts in with `git config core.hooksPath .githooks`:
`pre-commit` holds the staged root files to their format, when the TypeScript side is installed,
and `commit-msg` holds the subject to Conventional Commits, merges aside. Both hooks also run the
checks a clone keeps for itself in `.claude/local/`, when it has them.

## Releasing

A release moves every version in one commit, on a `release/*` branch or a `hotfix/*` one, and CI
judges that commit, every job, before any tag exists. `tools/release.mjs prepare` moves the
product's version in the TypeScript side's and the builder's `package.json`, in
`Directory.Build.props`, in the C# lock files' project ranges, an example's among them, in the
header of the code beadc generates and in the image an example's wrappers name, and each changed
document's a step past its last release, the spec's in that header too and in the `specVersion` of
a blueprint an example generated; it runs the generators, dates the CHANGELOG's version and links
it, then runs the gate as a release, `spec/check.py` and the root's format check, naming any whose
tool is absent with the CI job that holds it.
`tools/release.mjs tag`, after the finish, tags each document whose version no tag names yet at the
release's `v*`, runs the gate as `main`'s run will, and prints the one push:

```sh
git flow release start 0.2.0
node tools/release.mjs prepare --spec minor --python .venv/bin/python
git add -A && git commit -m "chore(release): 0.2.0"
git flow release publish 0.2.0                 # CI judges the release commit, every job, as a release
# fixes, if any, each with its line under [0.2.0]; then, right before the finish:
node tools/release.mjs prepare --python .venv/bin/python   # re-dates, regenerates, checks
git commit -am "chore(release): 0.2.0, dated"   # only if it changed something
# wait for ci-ok on release/0.2.0
git flow release finish --keepremote 0.2.0     # without -p: origin's branch goes with the push
node tools/release.mjs tag                     # spec-v…, debugging-v… and transcoding-v… at v0.2.0, then the gate on develop
git commit -m "ci: take out the waivers v0.2.0 makes moot" -- .github/workflows/ci.yml   # only if tag took one out
git push --atomic origin main develop v0.2.0 spec-v0.2.0 debugging-v0.1.0 :release/0.2.0
```

Before `prepare`, the release moves by hand the three digests beadc's image and its lint pin: the
Dockerfile frontend's and the Node base's (`NODE_DIGEST`) in `builder/Dockerfile`, and shellcheck's
image in `ci.yml`, each to its tag's current digest; CI then builds and tests the image on them.
`prepare` lists what else the release owes by hand: the CHANGELOG's line, under the release, that
tells a document's new version and its tag, the spec's or a companion's; each of
[0006](docs/decisions/0006-a-rule-has-its-gate.md)'s gates owed that names the release, whose rule
moves to that record's table; the documents brought to the release by the
`bead-release-documents` workflow ([`.claude/workflows/`](.claude/workflows/README.md)); and both
benches' reports, kept and compared with the last release's, as [Measurement](#measurement) says.

A waiver of CI's `beadc breaking` step, an `--except`, holds until the release that carries its
change is the one the step compares against: the release's own commit is still compared with the
release before it, so `prepare` leaves the waivers be on a release branch, and on a hotfix, which
starts from `main`, takes every one out of the step, each moot since the release `main` holds.
After the finish, `tag` takes out of the step on the branch checked out, `develop` at its
back-merge, each waiver the tagged commit carries, and prints the commit that keeps that, made
before the push.

While the product's major is 0, a release that breaks what a consumer calls, reads or builds moves
its minor, and a release of fixes alone its patch
([0008](docs/decisions/0008-three-version-axes-and-names-qualified-by-their-owner.md)). A document
whose files changed takes `--spec`, `--debugging` or `--transcoding`: `minor` when an
implementation must change to keep passing, `patch` when a conforming one passes unchanged, and
`minor` at least when a file, a key or a property was added
([0008](docs/decisions/0008-three-version-axes-and-names-qualified-by-their-owner.md)). Nothing is
staged, committed, tagged or pushed except by these commands. If `tag` reports an entry the
back-merge filed under the released version, it goes back under `[Unreleased]` in a commit on
`develop` before the push.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs every job on every push and pull request, on pinned
runner images, `ubuntu-26.04`, and `windows-2025` and `ubuntu-26.04-arm` for the builder's: `spec`
(regenerate, then diff, then `spec/check.py`); `playwright` (the exact version of
`@playwright/test` the TypeScript side pins, which names Microsoft's image of it, the one the
`typescript` and `dotnet` jobs run in, its Chromium already there); `typescript` on Node 26 and on
the floor, 24.9 (install, check, test, under coverage on Node 26, held to the side's floor, the
demo's static build, the DevTools extension built and, on Node 26, tested in Chromium, the demo's
tests on Node 26, and the root's files under the same formatter); `dotnet` (every C# package
audited by NuGetAudit as it restores, format, build, the builder's C# goldens among its projects,
the C# bench built in Release, test under coverage, held to the side's floor, the interop both ways
with `BEAD_INTEROP_REQUIRED=1`, each side's generated HTTP client against the other's gateway among
it, and a page of another origin in Chromium against both HTTP servers); `mqtt` (on the runner's
host, a Mosquitto 2.1.2 by its digest and a password drawn for the run, with `BEAD_MQTT_REQUIRED=1`
and `BEAD_INTEROP_REQUIRED=1`: the cases over MQTT 5 on both sides, each adapter against it over
TCP and WebSocket, the interop over MQTT 5 both ways, the demo's server and its page's client over
it, a page's client in Chromium, and the DevTools extension following the demo's client over it);
`amqp` (on the runner's host, a RabbitMQ 4.4.0 by its digest, its heartbeat lowered, and a password
drawn for the run, with `BEAD_AMQP_REQUIRED=1` and `BEAD_INTEROP_REQUIRED=1`: the cases over AMQP
1.0 on both sides, each adapter against it, and the interop over AMQP 1.0 both ways, with no page
leg, since no page reaches an AMQP 1.0 broker); `rust` on Linux and Windows (on Linux, the
toolchain its file pins, format, clippy, the documentation, a build on the default features alone,
cargo-deny, the tests under coverage, lines and regions held to the side's floor, and the fuzz
targets built on the nightly pinned by its date; on Windows, the tests); `builder` (install,
protoc by its pin's sha256, test with `BEADC_PROTOC_REQUIRED=1` and `BEADC_WRAPPERS_REQUIRED=1`,
the wrappers held to one contract against a stand-in engine, then beadc over the interop's
blueprint, its rules and its form, `beadc generate --check` over the root's `beadc.yaml`, each
side's interop, and over the demo's, and `tools/check-validations.mjs` and
`tools/check-transcoding.mjs`, each side's validators of `spec/validations.proto` and its route
table and document of `spec/transcoding.proto` held to what beadc writes, on Node 26 on Linux and
Windows and on 24.9 on Linux; then `beadc breaking` over the interop's blueprint and
`examples/hello`, against the last release, which carries both, on Linux; its types, the goldens'
among them, lint and format, buf's among them, on Linux; and on the image's legs, Linux on Node
26, amd64 and arm64, each natively: beadc's image built, its test stage run on the image itself,
each wrapper run against it with `BEADC_IMAGE_REQUIRED=1`, over the repository and
`examples/hello`, and the wrappers' lint, each linter at its pin); `examples` on Node 26 and on
24.9, the floor the TypeScript half declares (what each example copies, or takes from beadc's
wrapper and init, held to its source; beadc on Node holding `examples/hello`'s generated files;
buf's lint and layout over its `.proto`; each half's gates and both its builds; then each client
against each server, both modes of each half, sixteen pairs, each server's gateway asked after its
client); `protobuf-conformance` (protobuf's conformance suite, its runner by its pin's sha512,
through each side's generated `proto` codec and its JSON, each held to its failure list and the
floor, the C# testee's format, then one corpus of `Probe` through the TypeScript and C# sides);
`protovalidate-differential` (protovalidate-es, by its pin's sha512, over the verdicts of
`spec/validations.json`, then those verdicts and a corpus mutated from them through each side's
generated validators and through protovalidate-es, the violations compared, and the C# testee's
format); and `commits` (the subjects, the links, the details, the versions, the root's tools' own
tests, then the supply chain: every action pinned by its commit's full sha, OSV-Scanner over every
lockfile, and Semgrep's community rules for TypeScript, C#, GitHub Actions and secrets, each
scanner at its digest).
`ci-ok` needs them all, so one check stands for every job.

## How Bead is made

The ideas, the protocol's design and the TypeScript side are mine. TypeScript is where my expertise
has been these last years; the other languages are less familiar to me, and I am not an expert in
every RFC the spec cites. Much of the rest is written by AI agents working under this repository's
rules: the other implementations, the generator, and many of the spec's readings of RFCs and other
standards.

Those rules keep every language to one behaviour. They hold each one to the same conformance files,
to the interop between sides, and to a strict linter and analyzer set, and they put every change
that reaches across the languages through an adversarial review before it lands. What these gates
hold is held. Where a side departs from TypeScript's idioms, or where the spec reads a standard, it
has been checked by tests and by those reviews, not by a specialist. Corrections from people who
know better are welcome.

## Contributing

- Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
- Branches follow git-flow: `main`, `develop`, `feature/*`, `release/*`, `hotfix/*`.
- [`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
  a change worth telling goes under `[Unreleased]` with the commit that makes it; on a release
  branch, once its version is dated, under that version.
- [`docs/decisions/`](docs/decisions/README.md) holds why Bead is shaped as it is, one record a
  decision, changed rather than appended to; the CHANGELOG says what changed, a record says why
  ([0009](docs/decisions/0009-conventional-commits-git-flow-and-the-tenth-man.md)).
- A comment a reader must not miss opens with its tag, after its marker (`//`, `#`), as the
  [Better Comments](https://marketplace.visualstudio.com/items?itemName=aaron-bond.better-comments)
  extension shows them: `!` an alert, a trap or an invariant that breaks something when changed;
  `?` an open question; `TODO` work to do beside the code; `*` the key point of a block. Every other
  comment stays plain, and doc comments carry no tag. In an editor without the extension, the tags
  read as they are.

## Licence

[Apache-2.0](LICENSE).
