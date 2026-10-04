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
- Fifteen more cases that advance the clock a server is given. In the conversations: a request's
  transfer gone silent, `TRANSFER_STALLED`, and its call then held abandoned; a command waiting on
  its result's transfer, not its own time; a result that gets no credit; a relay's leg B past its
  destination's timeout. Over HTTP: the idle and the exchange timeouts; a listen held for its wait,
  and for the server's bound; a listen holding a connection's timeouts, with a session or none; the
  server's own timeout, by default and from a session's end; a session ending during a held listen.
  Over WebSocket: a session's timeout, its connection staying, and its connection's, each message
  starting it anew. `spec/check.py` holds an advance over a socket to the due its `until` named; the
  transports' file names the HTTP server's own `connectionInactivityTimeout` among its defaults and
  options, and the conversations' limits take a transfer's inactivity.
- Section 13.8 verifies a `JWT` one way, an access token of RFC 9068's profile, as RFC 8725
  recommends, and its verdicts are a group of vectors, `jwtVerdicts`: a token, a key, a time and an
  audience, taken or refused and why. Both sides verify it, on Web Crypto and on `ECDsa` and
  `HMACSHA256`, and play the group, its audience one or a set.
- `spec/check.py` refuses a published test key outside `spec/`, the tests and the interop service:
  its parameters, or its thumbprint (RFC 7638), in any file git lists.
- A transport carries a credential beside an envelope, both ways, as one argument: on the
  TypeScript side, the message event's first argument and `send`'s are `{ data, credential }`; on
  the C# side, `TransportMessage` has its `Credential`. Over HTTP it is the `Authorization` field of
  the `POST /bead` that carries a request, as it came, its surrounding whitespace removed: an empty
  one carries none, and a `POST /bead` with two is refused 400, `malformed`.
- A conversation names the token an answer announced, `token`, and writes it in a later send as
  `<name>`; a failure's detail is compared where a conversation gives one. A send says what its
  transport carried beside it, `carried`, and so does a request leg B sends; a connection may carry
  no credential, `carries`, or reach off the machine in the clear, `secure`; a conversation may set
  its server's relay, `relay`; and a request expected names the credential it presents.
- A credential's session (decision 0010, sections 13.9 and 13.10): a `JWT` a side verifies, or an
  `ELSEWHERE` its verifier holds, runs its call in a session of its own, named by a record — its
  issuer with its `sid`, else with its `sub`, or its verifier's `id` — and kept per connection while
  it bounds a subscription, its end timed on the clock the side is given, the wall clock read again
  at each step and a timer of 2³¹ − 1 ms at most armed toward it. A credential renewed under the
  same identifier moves its end, and `endSession`, `EndSession`, ends it by its identifier on every
  connection that keeps it. A connection holds one subscription per procedure and per session.
- `credentials`, `Credentials`, among a server's and a client's options: a `JWT`'s keys, each with
  its issuer and its algorithm, its audience, and a key set the side asks for a `kid` it holds no
  key of, once a minute at most for an issuer, its answer held and an ask under way shared; and an
  `ELSEWHERE`'s verifier, `verify`, `Verify`, given what the transport carried and the call's
  signal. A side given a `JWT`'s keys holds its limits to 1,024 bytes at least (section 12.2), and
  keys or a key set given without an audience are refused as the side is built, unless its relay
  verifies. A `JWT`'s verdict reads the wall clock once its signature has verified.
- A client's credential, `credential`, `Credential`, by default and per call: `NONE`, `OPAQUE`, a
  `JWT` or an `ELSEWHERE`. A default withdrawn once a call that presented it is refused
  `SESSION_REQUIRED`, while it is still, by value, the credential that call presented, tells its
  application, `credentialWithdrawn`, `CredentialWithdrawn`; a call
  presenting an `ELSEWHERE` over a transport that carries none, or a bearer credential in the clear
  off the machine, fails before it goes, `DESTINATION_UNREACHABLE`, as does a server's command over
  HTTP. A transport says whether it carries a credential and whether it is secure,
  `carriesCredential` and `isSecure`, on both sides, and a server's transport may be told what
  stands in front of it, `secure`, `Secure`: TLS terminated before it, or a proxy in the clear.
- A relay forwards a credential, and its destination verifies it (section 14): its default
  admission is `requireSessionOrCredential`, `RequireSessionOrCredential`; a destination is
  registered with the audience it verifies; `verifies`, `Verifies`, has the relay verify what it
  forwards against its destinations' audiences; a `JWT` crosses with its same bytes to a destination
  of its audience, an `ELSEWHERE` moves to leg B's transport, and a call the relay cannot so forward
  is refused `DESTINATION_UNREACHABLE` at a step of its own, 14.3's fifth; leg B's header counts its
  credential, at the sixth.
- The interop service verifies a `JWT` under two issuers' published test keys and a key set's
  third, and an `ELSEWHERE` of its own auth-scheme, `Interop`; `revoke` ends a credential's session
  by its identifier, `register` takes the audience its destination verifies, and `ticks` and `tick`
  hold per session. 221 vectors in 10 groups, where 123 were in 9; 134 conversations, where 89 were;
  56 transports' cases, where 50 were.

### Changed

- The SESSION block gives way to the CREDENTIAL block (decision 0010): bit `0x08`, the header's last
  block, a credential scheme on 2 bytes — `NONE`, `OPAQUE`, `JWT`, `ELSEWHERE`, or one to come — its
  length on 2, its bytes padded to a word, so a header holds 1,020 bytes; `0x01` is kept for a block
  to come. An answer announces its connection's session as `OPAQUE`, 20 bytes, or its end as `NONE`,
  and a side counts 20 where it counted 16. Both sides name it `credential`, `Credential`, where they
  said `sessionToken`, and a trace carries its scheme alone; the C# side's `HeaderBytesOf` refuses a
  credential its kind does not take, as its writer and the TypeScript side's do.
- A request runs in its call's session (decision 0010, section 9.2, step 5): a credential scheme the
  side takes none of is refused `CREDENTIAL_UNSUPPORTED`, the admission block's new code 36, its
  detail naming the schemes the side takes; then its credential resolves — none to its connection's
  session, `OPAQUE` to it when the token is that session's, compared in constant time — and a
  credential that does not hold is refused `SESSION_REQUIRED`, whatever its procedure requires; then
  its admission decides. The router asks `sessionOf`, `SessionOf`, once per request, with its call's
  signal, past its call id held and before `beforeRequest`; the call's session, `session`,
  `Session`, reaches the admission and the resolver, and `requireSession`, `RequireSession`, tests
  it, never the connection's. A client presents `OPAQUE`, the session it learned, on a call that asks
  for it among its options, `credential`, `Credential`, and never by default. A notification's
  filter is given the session a subscription is held in, `filter(handle, identifier)`; on the
  TypeScript side `sessionOf` takes its request and its signal apart, and on the C# side
  `Credential.Elsewhere` is a method, `JwtKey` and `JwtAlgorithm` are public, and
  `DropSubscriptions` ends the subscriptions of a connection's own session alone.
- A transfer's opening carries one byte of its payload at least: one without is refused
  `CHUNK_INVALID`, and a requester whose header leaves it none fails before it goes,
  `ENVELOPE_TOO_LARGE`. An opening gets no credit before its credential resolves and its admission
  settles.
- The interop service's `whoami` answers from its call's session, and `login` opens its
  connection's session whatever its call presents.
- The demo's tokens are access tokens of RFC 9068's profile, typed `at+jwt` and signed HS256: the
  page presents its token as a `JWT` on every call, the servers verify it through their
  `credentials`, `whoami` answers the call's session and `logout` ends it; `DEMO_KEY` gives the
  demo its key, in base64url, 32 bytes at least, and a key published with its RFC is refused.
- A listen held over HTTP holds its connection's timeouts — the server's own, and a session's
  connection timeout — silence counting anew from its end, by a new optional event of the
  transport's, `listen` and `Listen`; a session's session timeout and `lastActivity` count messages
  alone. A connection whose session ended takes the server's own connection timeout, counted from
  that end, where it kept the session's; a session stored without its timeouts holds both without
  end, where it held 600 ms and 30 s (decision 0012). The server's gauges count `listening`, the C#
  session manager gains `ResetConnectionInactivityTimeout` and `ResetSessionInactivityTimeout`, and
  section 15.12 names the HTTP server's own `connectionInactivityTimeout`, 30 s.
- The interop service's `login` takes `sessionTimeout` and `connectionTimeout`, and `register`'s
  timeout is held as every duration is.
- Every layer of both sides takes its time from a clock it is given, exposes it, and refuses one
  that differs from the clock of the layer beneath it (decision 0011): `Clock`, a `TimeProvider`,
  where the C# side's options said `Time`; `clock`, the part of the globals Bead calls, on the
  TypeScript side, the platform's by default. What bounds a platform's own close or stop, and a
  WebSocket's ping, stay on the real clock.
- Every duration an application gives a side — a timeout, a delay, a limit, a bound — is held as a
  whole number of milliseconds from 1 to 2³¹ − 1, as section 1.4 now states: a fraction is rounded
  to the nearest, a half up, and one under a millisecond or past the ceiling is refused, and on the
  TypeScript side `NaN` and a non-number, in the same words on both sides, by one assertion a side,
  `assertHeld` and `Clocks.AssertHeld`, beside `LONGEST_TIMER` and `Clocks.LongestTimer`. A timeout
  or a bound refuses 0, where a call's and a connect's waited without end, a reservation and a
  session took their default, the HTTP client's inactivity was lost at once and a close timeout cut
  at once: one left out is its default, and never is `Infinity` and `Timeout.InfiniteTimeSpan`
  alone, where its place takes it. A delay takes 0 as at once, and refuses never: a reconnection's
  delay of never retried at once. A session's timeouts may be left out, `number | undefined` and
  `TimeSpan?`, for the manager's default, as a C# session built without them now takes too; a
  service manager's default timeout is checked as it is built, and a call's own as the defaults are
  applied, so a call's trace shows the duration held, and a refused one fails before the trace and
  the deprecation event, `resolveRequestOptions` refusing it. The TypeScript session manager's
  `isArmable` goes.
- The TypeScript reconnection arms its wait before its tap hears it, as the C# one does, and refuses
  a delay before its tap hears it; a connect refused for its timeout leaves the TypeScript client
  as it was, uninitialized, its target kept for no reconnection, as the C# one does. The TypeScript
  WebSocket server's close timeout of `Infinity` waits without end, where Node took it for a
  millisecond. The C# side writes milliseconds in the invariant culture, in its refusals and in
  the failure details that go on the wire.
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
- The C# side's trace of a received call starts as its resolver takes it, before its admission and
  its decoding, as the TypeScript side's does, where it started once the payload decoded; through a
  router, which asks the admission itself, both start once it admitted the call.

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
