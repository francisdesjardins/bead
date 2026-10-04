# Bead

[![CI](https://github.com/francisdesjardins/bead/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/francisdesjardins/bead/actions/workflows/ci.yml?query=branch%3Amain)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Bead is a binary wire protocol for calls between a client and a server: a request and its result or
failure, a subscription and its notifications, the commands a server sends back, cancels, sessions,
relays, and transfers of large payloads under credit. Each envelope is written at fixed big-endian
offsets, behind an 8-byte prefix whose first byte is the layout, `0xA1` today, so a reader knows
before anything else whether it can read the rest.

This repository holds the protocol and its implementations, side by side:

- **the specification**, and the conformance files every implementation plays;
- **a TypeScript implementation**: WebSocket, HTTP and Web Worker transports, each a client and a
  server, the client and server routers, the service, session and notification managers, and a
  demo;
- **a C# implementation** at behavioural parity with it: the same envelope, the same routers, the
  WebSocket and HTTP transports;
- **an interop service** each side offers, which the other side's client calls over both
  transports.

Nothing is published yet.

## Why Bead

A client and its server talk in more ways than requests and answers. The server pushes changes the
client must keep up with. A large file goes up while other calls carry on. A call is cancelled
halfway. A session outlives a dropped connection, and the server sometimes has to ask the client
something. Bead carries all of it in one small binary envelope, whatever carries the envelope:
WebSocket, plain HTTP where WebSocket cannot pass, a Web Worker in the page, and a publish/subscribe
broker (coming).

- **Read without decoding.** A fixed 8-byte prefix and fixed offsets say what an envelope is, which
  call it belongs to and how long it is. A router or a relay acts on it without parsing its payload,
  whatever that payload's format.
- **Subscriptions at the client's pace.** A paced subscription sends only what the client has
  credited. What waits is kept by key, so a state keeps its latest value and an event keeps every
  one. A queue past its bound ends the subscription out loud, never in silence.
- **Large payloads under credit.** A transfer goes in chunks, as fast as its receiver credits them,
  beside the calls still under way.
- **Everything a conversation needs**: cancel, sessions, relays, and commands, the server's own
  calls to the client.
- **One behaviour in every language.** The spec, its 221 vectors and 134 conversations are the
  contract. The TypeScript and C# implementations both play them, and call each other in CI over
  both transports.
- **No dependency.** The TypeScript side runs in browsers and in Node with nothing else installed.

Bead fits wherever a client and its server hold a conversation rather than trade messages: directly,
from a browser over WebSocket or plain HTTP, or across a publish/subscribe broker that already joins
services and devices (coming). Think of a dashboard or a collaborative tool that follows state as it
changes, an app that uploads large files while it keeps working, a back office whose server needs to
ask the client something, or a gateway that forwards calls it never reads. A browser speaks Bead
natively, with no proxy in between. Over a broker, Bead adds what topics alone lack: calls with
their answers and failures, cancels, each client's own pace, and transfers under credit. Both ends
keep the same API, whatever carries the envelopes.

## Layout

```
spec/                         spec.md, the conformance files both sides read, and check.py
  generators/                 the Python scripts that write them
  schemas/                    their JSON Schemas
implementations/
  typescript/                 a Yarn project of its own: src/, interop/, demo/, tools/
  dotnet/                     Bead.slnx: src/, interop/, tests/
docs/
  decisions/                  the decision records, and their index
  support.md                  the support matrix: each feature in each language, and its test
tools/                        repository checks and the coverage report, Node without dependencies
.githooks/                    the repository checks before each commit, opt-in
.github/workflows/ci.yml      the CI
CLAUDE.md, .claude/workflows/ the standing instructions for Claude sessions, and their workflows
```

Each implementation has its own toolchain, lockfile, linter, formatter and test runner, and runs
from its own folder. The root has no `package.json` and no task runner; it holds what both sides
share, above all `spec/`, which both read in their tests.

## The specification and its conformance files

[`spec/spec.md`](spec/spec.md) states what every implementation does, in the RFC 2119 sense. Each of
its sections names the vector groups that check it. Beside it:

| File                                                | What it holds                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`vectors.json`](spec/vectors.json)                 | 221 named vectors in 10 groups: headers and envelopes read and written back to their bytes, the refusals, each with its code, and a `JWT`'s verdicts |
| [`conversations.json`](spec/conversations.json)     | 134 conversations: envelopes in and out of a server, step by step, over one connection or several, under the limits and pacing each one sets         |
| [`transports.json`](spec/transports.json)           | 56 cases: what a transport's server does at its edge, over HTTP and over a WebSocket, the bytes each way                                             |
| [`clocks.json`](spec/clocks.json)                   | 9 clock cases: what every side's test clock does when a case advances it                                                                             |
| [`interop-service.json`](spec/interop-service.json) | the interop service: its id, its revision, and its procedures                                                                                        |

Both implementations read these files from `spec/` in their tests; neither keeps a copy. Four
generators write them, and regenerating must give the same bytes:

```sh
python spec/generators/make_vectors.py
python spec/generators/make_conversations.py
python spec/generators/make_transports.py
python spec/generators/make_clocks.py
git diff --exit-code -- spec
```

Each file follows its JSON Schema in [`spec/schemas/`](spec/schemas/), and repeats the version
`spec.md` states as its `specVersion`. `spec/check.py` holds both, that the spec's sections and the
groups of vectors name each other, and that every unit an entry cites is the spec's; then it reports
which groups and files each side's tests read, and fails on one a side does not. It runs on Python
3.14, with `jsonschema`, which `spec/requirements.txt` locks with every hash:

```sh
python -m venv .venv    # then activate it: .venv/bin/activate, or .venv\Scripts\Activate.ps1
python -m pip install --require-hashes --only-binary=:all: -r spec/requirements.txt
python spec/check.py
```

## TypeScript

In `implementations/typescript`. Node 24 or later. Yarn 4 is vendored under `.yarn/releases/`, and
`.yarnrc.yml` points every `yarn` there; where no `yarn` is installed,
`node .yarn/releases/yarn-4.18.1.cjs` stands for it.

```sh
cd implementations/typescript
yarn install --immutable
yarn check        # types, lint, format, comment budget, the doc examples
yarn test         # the unit tests, and the interop against the C# server
```

The package is `@francisdesjardins/bead`, private for now; its `exports` point at the sources. Its
[README](implementations/typescript/README.md) describes each layer.

## C#

In `implementations/dotnet`. The .NET 10 SDK, as `global.json` pins it; tests run on
Microsoft.Testing.Platform. Every warning is an error, the recommended analyzers are on, and every
public member has its doc comment.

```sh
cd implementations/dotnet
dotnet format Bead.slnx --verify-no-changes
dotnet test --solution Bead.slnx
```

With `CI=true`, a restore that would change a `packages.lock.json` fails.

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

## The demo

A page with a button per kind of call — a read, a write, a subscription, a transfer either way, a
cancel, a failure, a command — and the calls and envelopes logged as the client sees them, over
WebSocket, HTTP or a Web Worker.

```sh
cd implementations/typescript
yarn demo                    # page and servers on http://localhost:8080 (DEMO_PORT moves it)
yarn playground:build:file   # the static build, into demo/dist/playground/
```

The static build runs its server in a Web Worker of the page, every path relative, so any static
host serves it as files.

## Coverage

A local command, not a CI job. Each side writes its own report — c8 an istanbul
`coverage-final.json`, `dotnet test --coverage` one cobertura XML per test project — and
`tools/coverage-report.mjs` reads either, merges what they say of the same file, and prints each
file's lines and branches run, then the lines no report ran.

```sh
cd implementations/typescript
yarn test:coverage
node ../../tools/coverage-report.mjs coverage/coverage-final.json --under implementations/typescript/src
```

```sh
cd implementations/dotnet
dotnet test --project tests/Bead.Core.Tests --coverage --coverage-output-format cobertura --coverage-output core.cobertura.xml --results-directory TestResults/coverage
dotnet test --project tests/Bead.Transport.WebSockets.Tests --coverage --coverage-output-format cobertura --coverage-output transport.cobertura.xml --results-directory TestResults/coverage
dotnet test --project tests/Bead.Transport.Http.Tests --coverage --coverage-output-format cobertura --coverage-output http.cobertura.xml --results-directory TestResults/coverage
dotnet test --project tests/Bead.Interop.Tests --coverage --coverage-output-format cobertura --coverage-output interop.cobertura.xml --results-directory TestResults/coverage
node ../../tools/coverage-report.mjs TestResults/coverage/*.cobertura.xml --under implementations/dotnet/src
```

## Support

[`docs/support.md`](docs/support.md) shows, feature by feature, what each implementation supports
and the test that proves it: the aim is one behaviour in every language, and a difference stays
there only until it closes.

## Repository checks

- `node tools/check-commits.mjs <range>`: every commit subject in the range is a Conventional
  Commit; merges are left out. With `--message <file>`, the message git is about to record, which
  must also be UTF-8 without a byte order mark.

It also runs before each commit, once a clone opts in with `git config core.hooksPath .githooks`:
`commit-msg` holds the subject to Conventional Commits, merges aside. Both hooks also run the
checks a clone keeps for itself in `.claude/local/`, when it has them.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs every job on every push and pull request, on a pinned
runner image, `ubuntu-26.04`: `spec` (regenerate, then diff, then `spec/check.py`), `typescript` on
Node 26 and on the floor, 24 (install, check, test, the demo's static build, and the root's files
under the same formatter), `dotnet` (format, test, and the interop both ways with
`BEAD_INTEROP_REQUIRED=1`), and `commits` (the subjects). `ci-ok` needs them all and is the only
required check.

## Contributing

- Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
- Branches follow git-flow: `main`, `develop`, `feature/*`, `release/*`, `hotfix/*`.
- [`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
  a change worth telling goes under `[Unreleased]` with the commit that makes it.
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
