# Bead

[![CI](https://github.com/francisdesjardins/bead/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/francisdesjardins/bead/actions/workflows/ci.yml?query=branch%3Amain)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Bead is a binary wire protocol for calls between a client and a server: a request and its result or
failure, a subscription and its notifications, the commands a server sends back, cancels, sessions,
relays, and transfers of large payloads under credit. Each envelope is written at fixed big-endian
offsets, behind an 8-byte prefix whose first byte is the layout, `0xA1`, so a reader knows before
anything else whether it can read the rest.

This repository holds the protocol and its implementations, side by side:

- **the specification**, and the conformance files every implementation plays;
- **a TypeScript implementation**: WebSocket, HTTP and Web Worker transports, each a client and a
  server, the client and server routers, the service, session and notification managers, and a
  demo;
- **a C# implementation** at behavioural parity with it: the same envelope, the same routers, the
  WebSocket and HTTP transports;
- **an interop service** each side offers, which the other side's client calls over both
  transports.

**Nothing is published before 1.0.0.** No package goes to npm or NuGet, and no image to a
registry, so that the wire, the names and the API can change freely until then, with no deprecation
cycle. Build on a commit, pinned.

## Why Bead

A client and its server talk in more ways than requests and answers. The server pushes changes the
client must keep up with. A large file goes up while other calls carry on. A call is cancelled
halfway. A call presents its own credential — a signed token, say — which outlives a dropped
connection and crosses a relay to the server that verifies it, and the server sometimes has to ask
the client something. Bead carries all of it in one small binary envelope, whatever carries the
envelope: WebSocket, plain HTTP where WebSocket cannot pass, a Web Worker in the page, and, from
0.6.0, a topic-based publish/subscribe broker ([Where Bead goes](#where-bead-goes)).

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
  TypeScript and C# implementations both play them, and call each other in CI over both transports.
- **No dependency.** The TypeScript side runs in browsers and in Node with nothing else installed;
  a project that binds `proto` brings protobuf-es, an optional peer.

Bead fits wherever a client and its server hold a conversation rather than trade messages: directly,
from a browser over WebSocket or plain HTTP, and, [where Bead goes](#where-bead-goes), across a
topic-based publish/subscribe broker that already joins services and devices. Think of a dashboard
or a collaborative tool that follows state as it changes, an app that uploads large files while it
keeps working, a back office whose server needs to ask the client something, or a gateway that
forwards calls it never reads. A browser speaks Bead natively, with no proxy in between. Over a
broker, Bead is to add what topics alone lack: calls with their answers and failures, cancels, each
client's own pace, and transfers under credit. Both ends keep the same API, whatever carries the
envelopes.

## Where Bead goes

A version here is the product's, its `v*` tag; the spec and its companion move on an axis of their
own ([0008](docs/decisions/0008-three-version-axes-and-names-qualified-by-their-owner.md)).

- **Next**: the bounds a server keeps against a peer that holds it — the calls a peer holds open
  over a WebSocket or a Web Worker (spec 8.3), a WebSocket server's connections, what a WebSocket
  server queues for a client that no longer reads, a request whose headers or body trickle in — and
  a security event for a credential refused, each by a decision of its own; then each side's
  parsers fuzzed, guided by coverage, Jazzer.js on the TypeScript side and SharpFuzz on the C#
  side, both held to read one corpus alike, a short run in CI.
- **0.6.0**: a topic-based publish/subscribe broker as one more transport, one core and one
  adapter a broker, Bead's envelope, routers and sessions the same at each end
  ([0021](docs/decisions/0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)).
- **Further**: HTTP/JSON transcoding, payload validation, the transports' client part of the
  conformance, a relay across languages in the interop, the DevTools extension on Firefox, a
  latency bench and a constrained C side, each bound by the records that
  [the index](docs/decisions/README.md#where-bead-goes) names, with what else is ahead.
- **An idea, with no version**: one router over several transports, then HTTP and WebSocket on
  one port, mounted in an application's own web server, which would take the place of the
  small local proxy that couples the two transports
  ([0004](docs/decisions/0004-one-behaviour-in-every-language.md)).

## Layout

```
spec/                         spec.md, debugging.md, the conformance files both sides read, and check.py
  generators/                 the Python scripts that write them
  schemas/                    their JSON Schemas
implementations/
  typescript/                 a Yarn project of its own: src/, interop/, demo/, devtools/, browser/, tools/
  dotnet/                     Bead.slnx: src/, interop/, tests/; and tools/, outside it
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
tools/                        repository checks, the release and the coverage report, Node without dependencies
.githooks/                    the repository checks before each commit, opt-in
.github/workflows/ci.yml      the CI
CLAUDE.md, .claude/workflows/ the standing instructions for Claude sessions, and their workflows
```

Each implementation has its own toolchain, lockfile, linter, formatter and test runner, and runs
from its own folder. The root has no `package.json` and no task runner; it holds what both sides
share, above all `spec/`, which both read in their tests.

## The specification and its conformance files

[`spec/spec.md`](spec/spec.md) states what every implementation does, in the RFC 2119 sense. Each
file of entries is named by a section whose clauses it plays, and each entry cites the units it
checks: [`units.txt`](spec/units.txt) lists every unit, whether an entry cites it or why none does,
and the hash of its text. Its companion, [`spec/debugging.md`](spec/debugging.md), states what a
side traces, filters and counts beside the wire, under a version of its own. Beside them:

| File                                                    | What it holds                                                                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`vectors.json`](spec/vectors.json)                     | 230 named vectors in 10 groups: headers and envelopes read and written back to their bytes, the refusals, each with its code, and a `JWT`'s verdicts                                                  |
| [`conversations.json`](spec/conversations.json)         | The conversations: envelopes in and out of a server, step by step, over one connection or several, under the limits and pacing each one sets                                                          |
| [`transports.json`](spec/transports.json)               | 116 cases: what a transport's server does at its edge, over HTTP and over a WebSocket, the bytes each way                                                                                             |
| [`clocks.json`](spec/clocks.json)                       | 9 clock cases: what every side's test clock does when a case advances it                                                                                                                              |
| [`durations.json`](spec/durations.json)                 | 21 places that take a duration an application gives a side, by 31 ways, and what each makes of each of 19 inputs: held, at once, never, its default, or refused and why                               |
| [`identities.json`](spec/identities.json)               | 31 procedure names, 28 ids and revisions and 6 procedure kinds, each declared the six ways a side declares, and 8 pairs of names: what a router takes, or refuses and why, as a procedure is declared |
| [`codecs.json`](spec/codecs.json)                       | Payloads read and values written, in `raw`, `text`, `json` and `proto`: the bytes written back, a JSON value in its canonical form, the fields a `proto` payload reads, or refused and why            |
| [`codecs.proto`](spec/codecs.proto)                     | `Probe`, the fixed message the `proto` rows of `codecs.json` read and write, which each side's tests generate with their stock protobuf generator                                                     |
| [`debug-filters.json`](spec/debug-filters.json)         | 52 debug filters, what each reads as and which calls and envelopes it keeps, or why it is refused, and 6 filters given as functions, event by event                                                   |
| [`metrics.json`](spec/metrics.json)                     | 24 expositions, the text a registry writes for what it counts, byte for byte, and 51 exits of the interop service's server, the series each step moved                                                |
| [`interop-blueprint.json`](spec/interop-blueprint.json) | the interop service's API: its one service, its 18 procedures, each with its kind, its bindings, its admission and its failures, in the builder's blueprint's form                                    |
| [`interop-service.json`](spec/interop-service.json)     | what each procedure of the interop service takes, answers, admits and notifies, by its name; what its relay admits and forwards; and the credentials it verifies                                      |

Both implementations read these files from `spec/` in their tests; neither keeps a copy. Nine
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
git diff --exit-code -- spec
```

Each file follows its JSON Schema in [`spec/schemas/`](spec/schemas/), and repeats the version
`spec.md` states as its `specVersion`, or, for `debug-filters.json` and `metrics.json`, the version
`debugging.md` states as its `debuggingVersion`. `spec/check.py` holds both, that the spec's sections
and the groups of vectors name each other, that every unit an entry cites is its document's, that
each ledger gives every unit of its document its status, each reason held by its rule, and the
hash of its text, which moves only where `python spec/check.py --write-units 15.7` names the unit,
and that every exposition reads as the Prometheus text format 0.0.4, that the interop's blueprint
is in its form and `interop-service.json` states its procedures, and that each count the table
above and the matrix's, in [`docs/support.md`](docs/support.md), state is what the files hold;
then it reports which groups and files each side's tests read, and fails on one a side does not.
It runs on Python 3.14, with `jsonschema`, which `spec/requirements.txt` locks with every hash:

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
dotnet format Bead.slnx --verify-no-changes --exclude ../../builder/test/golden/csharp interop/Bead.Interop/Generated
dotnet build Bead.slnx
dotnet test --solution Bead.slnx
```

With `CI=true`, a restore that would change a `packages.lock.json` fails. The core's test project
generates `Probe` from `spec/codecs.proto` at each build, with Grpc.Tools, beside Google.Protobuf;
nothing it generates is committed.

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
`.proto` of `proto` messages, a procedure that notifies at a window of 1, a command, a catalogue and
a hook, generated by beadc into a TypeScript half and a C# half
([0022](docs/decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
Each half reaches its runtime from its source, the TypeScript half by a Yarn `portal:` and the C#
half by a `ProjectReference`, takes the house's rules by reference where its platform can, a copy
held to them where it cannot, and builds twice: its messages generated by beadc, and by its
platform's own generator, protoc-gen-es under `buf generate` and Grpc.Tools.
[`pairs.mjs`](examples/hello/pairs.mjs) plays each client against each server, both modes of each
half, sixteen pairs, and holds what each client writes to
[`transcript.txt`](examples/hello/transcript.txt), byte for byte. Its README says how to generate,
build and run it, and what a project outside this repository writes instead.

## Interop, both ways

Each side starts the other's interop server and calls it with its own client, over WebSocket and
over HTTP:

- the C# client against the TypeScript server: `Bead.Interop.Tests`, run by `dotnet test`, starts
  it with Node from `implementations/typescript`, which must be installed;
- the TypeScript client against the C# server: `yarn test:interop` builds and starts
  `Bead.Interop.Server` with `dotnet run`.

Where the other runtime is missing, each skips its interop, saying so. `BEAD_INTEROP_REQUIRED=1`
turns that skip into a failure, as the CI sets it: there, a skip could only be a path to the other
side gone wrong.

```sh
cd implementations/typescript && BEAD_INTEROP_REQUIRED=1 yarn test:interop
cd implementations/dotnet && BEAD_INTEROP_REQUIRED=1 dotnet test --project tests/Bead.Interop.Tests
```

A page of another origin calls both HTTP servers in Chromium: `yarn test:browser`, in a Playwright
config of its own, serves a page on `localhost` whose bundled HTTP client calls each side's interop
server on `127.0.0.1`, which names the page's origin as `BEAD_INTEROP_ORIGINS` lists it. Its C#
half starts `Bead.Interop.Server` with `dotnet run`, and skips or fails as the interop does.

```sh
cd implementations/typescript
yarn playwright install chromium
BEAD_INTEROP_REQUIRED=1 yarn test:browser
```

## The demo

A page with a button per kind of call — a read, a write, a subscription, a transfer either way, a
cancel, a failure, a command — the calls and envelopes logged as the client sees them, and what the
client's and the server's metrics registries count, over WebSocket, HTTP or a Web Worker.

```sh
cd implementations/typescript
yarn demo                    # page and servers on http://localhost:8080 (DEMO_PORT moves it)
yarn playground:build:file   # the static build, into demo/dist/playground/
```

The static build runs its server in a Web Worker of the page, every path relative, so any static
host serves it as files.

## The DevTools extension

A Bead panel in Chrome's DevTools: the calls, envelopes and metrics of each client a page builds,
which announces itself to the extension unless its options say `devtools: false`, a server in a Web
Worker of the page included, whose messages the Network panel does not show.

```sh
cd implementations/typescript
yarn devtools:build   # unpacked, into devtools/dist/: chrome://extensions, then Load unpacked
yarn test:devtools    # its tests, once it and the demo's static build are built
```

## Coverage

Each side's tests run under coverage in CI, and what they run is held to the side's floor in
[`tools/coverage-floors.json`](tools/coverage-floors.json), lines and branches each. Each side
writes its own report — c8 an istanbul `coverage-final.json`, `dotnet test --coverage` one cobertura
XML per test project — and `tools/coverage-report.mjs` reads either, merges what they say of the
same file, and prints each file's lines and branches run, then the lines no report ran; with
`--floor`, it fails under the side's floor, or when it measured nothing, and with `--summary`, it
writes the report into the run's summary. A floor sits half a point under what was measured, and
rises with `--raise`, never down but by a decision
([0006](docs/decisions/0006-a-rule-has-its-gate.md)). Each run keeps its reports 14 days, among its
artifacts: `coverage-typescript`, c8's HTML to browse and its lcov, and `coverage-csharp`, the
cobertura files. Locally, the same commands as CI's:

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

## Measurement

Both sides measure the same four layers on the loopback. Run each bench separately on a quiet
machine, with Node, the TypeScript dependencies and .NET installed. Both benches start the other
side's interop server as the interop tests do: `interop/serve.ts` for TypeScript, and
`dotnet run -c Release --project interop/Bead.Interop.Server` for C#. The server reports its
WebSocket and HTTP ports and serves until its standard input closes. A launch failure fails the
bench; every reported measure has every requested run.

From the root:

```sh
node --expose-gc implementations/typescript/tools/bench.mjs --runs 3 --seconds 3 --json > typescript.json
dotnet build -c Release implementations/dotnet/tools/Bead.Benchmarks
dotnet run -c Release --no-build --project implementations/dotnet/tools/Bead.Benchmarks -- --runs 3 --seconds 3 --json > csharp.json
node tools/bench-compare.mjs typescript.json csharp.json
```

`--runs` defaults to 3; `--seconds` defaults to 3 and bounds each timed phase of each run. Both
require positive integers. Each codec warms for 5,000 round trips, each call payload for 500 calls,
and each large echo for one call. Longer phases give the runtimes more time to warm. Without
`--json`, the report prints its environment and method, then each measure's median, minimum and
maximum. Progress goes to stderr; JSON alone goes to stdout.

| Layer         | Measure                                                    | Unit and scope                                                                     |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Envelope      | `codec.roundTrip`                                          | ns per request written and read back, at 0 B, 1 KiB and 64 KiB                     |
| Payload       | `json.roundTrip`                                           | ns per JSON string encoded and decoded, at the same sizes                          |
| Calls         | `call.p50`, `call.p95`, `call.p99`                         | us per sequential JSON echo, at the same sizes, over HTTP and WebSocket            |
| Calls         | `call.throughput`                                          | calls/s in batches of 32, over each transport and payload size                     |
| Calls         | `call.memory`                                              | B/call over 2,000 sequential calls; the runtime's method below defines these bytes |
| Notifications | `notification.p50`, `notification.p95`, `notification.p99` | us from the server's notify to its client's handler                                |
| Notifications | `notification.throughput`                                  | notifications/s received, including the final drain                                |
| Large echo    | `transfer.echo`, `transfer.throughput`                     | ms per 20 MiB echo and MiB/s, counting both directions                             |

Every call measure runs with client and server in the same process (`local`) and with the other
language's interop server in a child process (`interop`), on each transport. The report's `side`
names its client: `typescript` calls C# in `interop`, and `csharp` calls TypeScript. Codecs,
notifications and large echoes run locally. The notification producer targets a 1 ms cadence,
uses a credit window of 32 and gives every value its own place, with no replacement key. At each
wake-up it sends every value whose deadline passes, catching up after a late timer; at most 32
values await their handlers. It sleeps until the next deadline when caught up. Each value's
monotonic timestamp is taken immediately before its own notify; latency includes serialization,
scheduling, transport and decoding. Every due notification reaches the handler within the timed
phase plus a 30 s drain allowance. Throughput records the achieved rate, including drain time.

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

Both JSON reports use `bead-bench/1`:

- `side`: `typescript` or `csharp`;
- `environment`: CPU model and logical count, OS platform/release/architecture, Node and V8
  versions, .NET version information, and the measured Git commit;
- `method`: runs, seconds per phase, concurrency, notification interval/window, memory call count,
  the memory method/scope/limitations, and the large-echo and interop scopes;
- `measures`: rows with `id`, `name`, `scenario`, `transport`, `sizeBytes`, `unit`, `direction`, raw
  `samples` in run order, and their `median`, `min` and `max`. An even run count averages the two
  central samples. The ID is `<scenario>.<transport>.<sizeBytes>.<name>`; codecs use transport
  `none`. Latency, codec time and memory use direction `lower`; throughputs use `higher`.

The comparison matches IDs, checks units, directions, samples and statistics, and requires the
same measurement set. It prints the candidate median's change relative to the baseline median's
absolute value: positive means a larger value. A zero baseline gives an unbounded change unless
both values are zero. It also identifies different memory methods. Every number belongs to its
machine, runtime, method and run; compare on the same machine and inspect the spread.

```sh
node tools/bench-compare.mjs baseline.json candidate.json --threshold 25%
node tools/bench-compare.mjs baseline.json candidate.json --threshold 25% --threshold call.p99=15% --threshold local.http.1024.call.p99=10%
```

A threshold tests regression: an increase for `lower`, a decrease for `higher`. An exact ID takes
precedence over a measure name, which takes precedence over the default percentage. Repeat
`--threshold` for distinct selectors. Equality passes; a regression strictly past its threshold
exits 1. Without thresholds the tool prints a comparison and exits 0; invalid reports, incompatible
measurement sets and selectors that match nothing exit 2. These commands run by hand; CI has no
performance guard.

Each release keeps both reports, `.bench/v<version>-typescript.json` and
`.bench/v<version>-csharp.json`, which git ignores, and compares each with the last release's on
the machine that made them:

```sh
node tools/bench-compare.mjs .bench/v0.5.0-typescript.json .bench/v0.6.0-typescript.json --threshold 25%
node tools/bench-compare.mjs .bench/v0.5.0-csharp.json .bench/v0.6.0-csharp.json --threshold 25%
```

A regression past its threshold is read before the finish: explained in the release's notes, or
fixed.

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
  sites that report alone (spec 9.0), on either side. Given files, those alone.
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
- `node tools/protobuf-conformance.mjs typescript|csharp|differential`: protobuf's conformance
  suite through one side's generated `proto` codec, its failure list held both ways and its count
  of tests to the floor `tools/protobuf-conformance/runner.json` pins with the runner, fetched by
  its sha512; or one corpus of `Probe` through both sides, read alike. The suite runs on Linux or
  macOS, where the runner has a binary; it needs the TypeScript side and the builder installed,
  and .NET for the C# side.
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
node tools/release.mjs tag                     # spec-v… and debugging-v… at v0.2.0, then the gate on develop
git commit -m "ci: take out the waivers v0.2.0 makes moot" -- .github/workflows/ci.yml   # only if tag took one out
git push --atomic origin main develop v0.2.0 spec-v0.2.0 debugging-v0.1.0 :release/0.2.0
```

Before `prepare`, the release moves by hand the three digests beadc's image and its lint pin: the
Dockerfile frontend's and the Node base's (`NODE_DIGEST`) in `builder/Dockerfile`, and shellcheck's
image in `ci.yml`, each to its tag's current digest; CI then builds and tests the image on them.
`prepare` lists what else the release owes by hand: the CHANGELOG's line, under the release, that
tells a document's new version and its tag, the spec's or its companion's; each of
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
whose files changed takes `--spec` or `--debugging`: `minor` when an implementation must
change to keep passing, `patch` when a conforming one passes unchanged, and `minor` at least when a
file, a key or a property was added
([0008](docs/decisions/0008-three-version-axes-and-names-qualified-by-their-owner.md)). Nothing is
staged, committed, tagged or pushed except by these commands. If `tag` reports an entry the
back-merge filed under the released version, it goes back under `[Unreleased]` in a commit on
`develop` before the push.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs every job on every push and pull request, on pinned
runner images, `ubuntu-26.04`, and `windows-2025` and `ubuntu-26.04-arm` for the builder's: `spec`
(regenerate, then diff, then `spec/check.py`), `typescript` on Node 26 and on the floor, 24.9
(install, check, test, under coverage on Node 26, held to the side's floor, the demo's static
build, the DevTools extension built and, on Node 26, tested in Chromium, and the root's files under
the same formatter), `dotnet` (every C# package audited by NuGetAudit as it restores, format,
build, the builder's C# goldens among its projects, test under coverage, held to the side's floor,
the interop both ways with `BEAD_INTEROP_REQUIRED=1`, and a page of another origin in Chromium
against both HTTP servers),
`builder` (install, protoc by its pin's sha256, test with `BEADC_PROTOC_REQUIRED=1` and
`BEADC_WRAPPERS_REQUIRED=1`, the wrappers held to one contract against
a stand-in engine, then beadc over the interop's blueprint, its rules and its form, and
`beadc generate --check` over the root's `beadc.yaml`, each side's interop, on Node 26 on Linux and
Windows and on 24.9 on Linux; then `beadc breaking` over the interop's blueprint and
`examples/hello`, against the last release, which carries both, on Linux; its types, the
goldens' among them, lint and format, buf's among them, on Linux; and on the image's legs, Linux on
Node 26, amd64 and arm64, each natively: beadc's image built, its test stage run on the image
itself, each wrapper run against it with `BEADC_IMAGE_REQUIRED=1`, over the repository and
`examples/hello`, and the wrappers' lint, each linter at its pin), `examples` on Node 26 and on
24.9, the floor the TypeScript half declares (what each example copies, or takes from beadc's
wrapper and init, held to its source; beadc on Node holding `examples/hello`'s generated files;
buf's lint and layout over its `.proto`; each half's gates and both its builds; then each client
against each server, both modes of each half, sixteen pairs), `protobuf-conformance` (protobuf's
conformance suite, its runner by its pin's sha512, through each side's generated `proto` codec, each
held to its failure list and the floor, the C# testee's format, then one corpus of `Probe` through
both sides), and `commits` (the subjects, the links, the versions, the root's tools' own tests,
then the supply chain: every action pinned by its commit's full sha, OSV-Scanner over every
lockfile, and Semgrep's community rules for TypeScript, C#, GitHub Actions and secrets, each
scanner at its digest).
`ci-ok` needs them all, so one check stands for every job; branch protection, which would make it
the one check a branch requires, waits on GitHub Pro or a public repository.

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
