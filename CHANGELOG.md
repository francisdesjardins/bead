# Changelog

All notable changes to this repository are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Badges in the README: CI on `main`, and the license.
- The conformance files' steps for time (decision 0011): `advance`, which steps the clock a side is
  given from due to due, `until` a timer armed on it, `wall`, which moves the wall clock alone, and
  each file's `wallClock`, where it starts; `spec/check.py` refuses an `advance` that no timer armed
  precedes.
- `specVersion` in each conformance file, repeating the version `spec/spec.md` now states, `0.1.0`,
  and when it moves, in decision 0008.
- JSON Schemas for the conformance files, in `spec/schemas/`.
- `spec/check.py`, which the `spec` job runs after the regeneration, from dependencies locked with
  every hash in `spec/requirements.txt`: every file under its schema and every schema with its file,
  no key twice, one version across the spec and its files, one name to a vector or a conversation
  in its group, every group of vectors named by a section of the spec, which names no other, and a
  report of the groups each side's tests read, which fails on one a side does not.
- The units of `spec/spec.md` each vector and conversation checks, cited in its `clauses`: a clause,
  an item of its numbered list, a row of its table. `spec/uncited.txt` lists the units none cites,
  and `spec/check.py` fails when that list and the files disagree.
- Relays in the conversations, across the connections a conversation opens, each step naming its
  own: twelve of them, for section 14. The interop service's `register` and `unregister` register a
  caller's connection as a destination on the wire, and `interop-service.json` states what its
  relay admits.
- `spec/transports.json`, its schema and its generator: what a server of the interop service does at
  its HTTP transport's edge, which each side's tests play against their own server with a peer that
  writes HTTP/1.1 in exact octets, the bounds' defaults each side checks, and responses cut across
  reads that each side's reader reads alike.
- The WebSocket's cases in `spec/transports.json`, played with frames the peer writes itself: a
  message whole or in fragments, a text message reported, a message past its limit closed 1009, a
  clean close and a stop, and, on the real clock, the ping and the peer that leaves it unanswered.
- `spec/clocks.json`, its schema and its generator: what every side's test clock does when a case
  advances it — timers chained in one advance, a periodic timer across its periods and armed again as
  it is taken, timers due at once, the wall clock moved alone — which both sides play, so that
  `advance` means one thing in every file (decision 0011). Both test clocks refuse a timer for less
  than a millisecond or past the ceiling, and an advance within another.
- The first cases that advance the clock a server is given: in the transports' file, a call id
  buried 5 seconds, then handed on; in the conversations, a command past its 10 seconds, its call id
  reserved as long, an answer within dropped and one after reported `CALL_UNKNOWN`.
- The `spec` job regenerates `spec/transports.json` and `spec/clocks.json` too.

### Changed

- Every layer of both sides takes its time from a clock it is given, exposes it, and refuses one
  that differs from the clock of the layer beneath it (decision 0011): `Clock`, a `TimeProvider`,
  where the C# side's options said `Time`; `clock`, the part of the globals Bead calls, on the
  TypeScript side, the platform's by default. What bounds a platform's own close or stop, and a
  WebSocket's ping, stay on the real clock.
- A timeout past 2³¹ − 1 milliseconds is refused wherever one is taken, as `LONGEST_TIMER` and
  `Clocks.LongestTimer` state; never is `Infinity` and `Timeout.InfiniteTimeSpan`, which arm
  nothing. The TypeScript session manager's `isArmable` goes. A timeout under a millisecond is
  refused wherever one is taken, 0 aside where it means no timer or the default, and `NaN` on the
  TypeScript side; a server's connection inactivity timeout of 0 is refused, as a transfer's is:
  Bead arms no timer for less than a millisecond.
- A transport server client's last activity is `lastActivity`, milliseconds since the epoch, and
  `LastActivity`, a `DateTimeOffset`, each read from its clock; its event is `lastActivityChanged`
  and `LastActivityChanged`, and a session manager's update `updateLastActivity` and
  `UpdateLastActivity`. The TypeScript side's `timestamp()` and `ITimestamp` go.
- A trace tells `startedAt` and `duration`, flat on its event, where it told `timestamp: { event,
  duration }`: on the C# side `StartedAt`, a `DateTimeOffset`, and `Duration`, a `TimeSpan?` in
  whole milliseconds, its statistics' `DurationSummary` in `TimeSpan`, and `DebugTimestamp` goes. A
  notification's one step starts as it is sent or heard, and a failed notify tells its failure at
  that same start.
- The banned-API analyzer (RS0030) on the C# side, and oxlint's `no-restricted-globals` and
  `no-restricted-properties` on the TypeScript side, refuse the platform's clocks and timers; an
  exception is suppressed where it stands, with its reason.
- The TypeScript side's tests run on `@sinonjs/fake-timers`' `createClock()`, never installed on the
  globals, a development dependency; the C# side's harnesses on a clock of their own, which keeps
  its timers and fires them from due to due over a `FakeTimeProvider`'s readings.
- Section 15.10 says that a listen's inactivity timeout never reads the wall clock.

- The Tenth Man meets every change to what every language's tests answer to: the spec, its
  conformance files, their shape and their tooling, and the gates the implementations share.
- The conversations' steps are named by who acts, `send` and `expect` where they said `in` and
  `out`; an expected failure gives the relays it crossed, and an expected command its flags, which
  both sides now compare.
- A failure's `hops` is `relays` on both sides, the spec's word, and its message says "through N
  relays".
- Both sides play the conformance files without retry.
- Section 15.12 names the HTTP transport's bounds in a table, and states the address a server takes
  from a proxy on its machine it trusts; section 15.3 names `maximumMessageBytes` and `heartbeat`.
- Section 15.4 says that a connect is of Bead's type, as both servers take it.
- Section 15.7 says that a request handed on is never refused, and that a cut which overtakes its
  200 head leaves its exchange lost; a transports' case may expect a status `orLost`.

### Fixed

- The HTTP transport, on both sides, answers 200, then cuts, the exchange of a request it handed on
  when handing it on closes the connection, where it answered 404 `connection-unknown`, a refusal
  that says nothing was tried.
- The C# side's trace counts a call's duration on its clock's monotonic reading, as the TypeScript
  side's does, where it read the wall clock, which a clock set by hand moves; the twin test plays on
  both sides.

## [0.1.0] - 2026-10-02

### Added

- The Bead specification, `spec/spec.md`, for layout `0xA1`: the prefix, kinds, flags and blocks,
  reading an envelope, failures and the protocol's codes, calls and answers, cancel and
  reservation, subscriptions and pacing, transfers, sessions, relays and transports.
- The conformance files both implementations play: `spec/vectors.json` (123 vectors in 9 groups),
  `spec/conversations.json` (72 conversations) and `spec/interop-service.json`, with the generators
  that write them, `spec/generators/make_vectors.py` and `spec/generators/make_conversations.py`.
- The TypeScript implementation, `@francisdesjardins/bead`, in `implementations/typescript`: the
  WebSocket, HTTP and Web Worker transports, each a client and a server; the client and server
  routers; the service, session and notification managers; the client and server facades; gauges
  and health; and its interop server.
- The C# implementation, in `implementations/dotnet`: `Bead.Core`, `Bead.Transport.WebSockets`
  and `Bead.Transport.Http`, at behavioural parity with the TypeScript side, with its interop
  service and server.
- Interop both ways, over WebSocket and HTTP: the C# client against the TypeScript server and the
  TypeScript client against the C# server, required in CI by `BEAD_INTEROP_REQUIRED=1`.
- The demo, `yarn demo`, and its static build for a playground, `yarn playground:build:file`.
- `docs/decisions/`: the decision records, 0001 to 0009, and their index.
- `docs/support.md`: the support matrix, each feature in each language with the test that holds it,
  and the differences between the implementations.
- `tools/check-commits.mjs`, which holds every commit subject to Conventional Commits.
- `tools/coverage-report.mjs`, a local command: it merges the TypeScript side's istanbul report and
  the C# side's cobertura reports, and prints what the tests leave unrun, file by file.
- CI, on a pinned runner image, `ubuntu-26.04`: `spec`, `typescript` on Node 26 and on the floor,
  24, `dotnet`, `commits`, and `ci-ok`, the one required check. `typescript` also builds the demo's
  static playground and holds the root's files to the formatter.
- `.githooks/`, opt-in with `git config core.hooksPath .githooks`: the Conventional Commits check
  over each message, and the checks a clone keeps for itself in `.claude/local/`, when it has them.
- `CLAUDE.md` and `.claude/workflows/`: the standing instructions for Claude sessions, and their
  workflows.
- The licence, Apache-2.0.

[Unreleased]: https://github.com/francisdesjardins/bead/compare/v0.1.0...develop
[0.1.0]: https://github.com/francisdesjardins/bead/releases/tag/v0.1.0
