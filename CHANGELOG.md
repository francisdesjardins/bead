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
  connection that keeps it, and nothing else: a credential that still holds opens it anew;
  `endSessionsOf`, `EndSessionsOf`, ends every credential's session of an issuer, as when a key of
  its leaks. A connection holds one subscription per procedure and per session.
- `credentials`, `Credentials`, among a server's and a client's options: a `JWT`'s keys, each with
  its issuer and its algorithm, its audience, and a key set, given with the issuers it answers for
  and asked for those alone, when no key of a token's issuer names its `kid`, once a minute at most
  for an issuer, with a signal its deadline aborts: its answer is held ten minutes, an ask under way
  is shared, a `kid` that comes while its issuer's minute runs waits for the ask its deadline lets
  go, a token without a `kid` waits on its issuer's keys while none serve, and at most
  `maximumWaitingCalls`, `MaximumWaitingCalls`, 64 by default, wait for an issuer's deadline at
  once, one past them refused `CAPACITY_EXCEEDED`; and an `ELSEWHERE`'s verifier, `verify`,
  `Verify`, given what the transport carried and the call's signal. A side given a `JWT`'s keys
  holds its limits to 1,024 bytes at least (section 12.2), and keys or a key set given without an
  audience are refused as the side is built. A `JWT`'s verdict reads the wall clock once its
  signature has verified.
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
  admission is `requireSessionOrCredential`, `RequireSessionOrCredential`, and an admission never
  answers `SESSION_REQUIRED` to a call that presented a credential, but `ACCESS_DENIED`, so its
  client keeps a credential that may hold; a destination is
  registered with the audience it verifies; `verifies`, `Verifies`, has the relay verify what it
  forwards against its destinations' audiences; a `JWT` crosses with its same bytes to a destination
  of its audience, an `ELSEWHERE` moves to leg B's transport, and a call the relay cannot so forward
  is refused `DESTINATION_UNREACHABLE` at a step of its own, 14.3's fifth; leg B's header counts its
  credential, at the sixth.
- The interop service verifies a `JWT` under two issuers' published test keys and a key set's third,
  and an `ELSEWHERE` of its own auth-scheme, `Interop`; `endSession` ends a credential's session by
  its identifier, and `endSessionsOf` an issuer's, `register` takes the audience its destination
  verifies, and `ticks` and `tick` hold per session. 221 vectors in 10 groups, where 123 were in 9;
  142 conversations, where 89 were; 56 transports' cases, where 50 were.
- `spec/durations.json`, its schema and its generator (decision 0014): what each of the 21 places
  that take a duration an application gives a side makes of each of 19 inputs, by each of the 31
  ways its surface takes it — held, at once, never, its default, or refused and why — which each
  side plays in one harness, through one helper that alone reads the file. The generator plays both
  platforms' conversions, JavaScript's arithmetic and .NET's truncation to ticks, and fails on an
  outcome either reaches otherwise unless it crosses a row of the support matrix, and on an input
  in seconds within a tick of a half. `spec/check.py` holds every place to an outcome for each
  input, to the clauses it observes and nothing else, and to a harness on each side that names it;
  a `differs` names a row that names its entry between backticks, and moves to
  `common.schema.json`; the `spec` job regenerates the file, and the bounds' defaults it shares with
  the transports' file come from one module of the generators.
- `spec/debugging.md`, the spec's companion (decision 0013), at version 0.1.0 of its own: what a
  side traces, filters and counts beside the wire, which a constrained profile may leave out and
  still conform to the wire. It states the trace of calls and of envelopes; a listener's error,
  which never changes a call; the cost while nobody listens, and two build switches; the debug
  filter's grammar in ABNF, in ASCII alone, and its refusals by reason; and a registry of metrics,
  its declarations, its ceiling, nine families under OpenTelemetry's RPC names, `bead` for `rpc`,
  every series made at 0, the router's gates and every exit of a call, A66's buckets in whole
  microseconds with each `le` OpenMetrics' canonical number, and its exposition's bytes in the
  Prometheus text format 0.0.4. `spec/spec.md` says where it stands beside it, and decision 0008's
  spec axis carries its version, which moves as the spec's does, a release whose companion moved
  tagging `debugging-v` and that version.
- `spec/debug-filters.json` and `spec/metrics.json`, their schemas and their generators, each
  repeating the companion's version as its `debuggingVersion`: 52 filters, what each reads as and
  keeps of fixed calls and envelopes, or its refusal's reason and what it names, and 5 filters given
  as functions, event by event; 22 expositions, a registry's text byte for byte, and 49 exits, the
  interop service's conversations played by a server given a registry, a `counted` step listing the
  series each step moved. `spec/check.py` holds the companion's version, its units, which
  `spec/debugging-uncited.txt` lists where none cites them, and the lines naming its files; reads
  each exposition as 0.0.4, its families, its help and its buckets the companion's, each `_count` the
  sum of its handled counts, none started below handled; and requires each side's tests to read
  both files. The `spec` job regenerates them.
- A metrics registry on each side (decision 0013), `createMetricsRegistry` and `MetricsRegistry`,
  which a router given it as its `metricsRegistry`, `MetricsRegistry`, counts into at its gates, and
  which every client and server passes on to the router it builds; one given to two routers sums
  them. It counts what its side declares, each series made at 0 as its procedure is declared: a
  resolver as it is registered, a notification as it is registered, and a requester as it is made,
  through its router's `declareRequester`, `DeclareRequester`, whose series each of its calls
  carries to its router's request as `series`, `Series`. A declaration of an address the registry
  holds under another name, of a name its service holds at another address, or past
  `maximumProcedures`, `MaximumProcedures`, 1,000 by default, is refused as it is made, a
  `ProgrammerError` and an `ArgumentException`. Its exposition, `exposition()` and `Exposition()`,
  writes its nine families in the Prometheus text format 0.0.4 and gives its media type with it,
  `{ contentType, text }` and `MetricsExposition(ContentType, Text)`, for an application to serve at
  `/metrics` or append to its own 0.0.4 scrape: Bead opens no port.
- A page's DevTools hook (decision 0015): a client built in a page announces itself to the hook a
  DevTools extension defines under `Symbol.for('@francisdesjardins/bead/devtools-hook')`,
  `DEVTOOLS_HOOK_KEY`, handing it a source of protocol 1 — its `debug` events while the extension
  watches, and its registry's exposition, never the client or its credential — and attaches nothing
  until it is watched; `devtools: false` among a client's options refuses.
- The DevTools extension, Chrome's first, in `implementations/typescript/devtools/` (decision
  0015): `yarn devtools:build` builds it unpacked, and a Bead panel shows the calls and envelopes of
  each client the page announced, filtered by client and by the package's own filter, what their
  registries count, and, for a page with no hook, the HTTP transport's exchanges the Network panel
  saw, read with the package's codec. `yarn test:devtools` tests it in Chromium, and CI runs it.
- The demo's servers count into one registry, which `/metrics` serves beside `/health`, on this
  machine alone, and the `metrics` procedure over Bead, on every transport, the worker's server's
  own included; the page's client counts into one of its own. A Metrics panel shows both, a line a
  procedure — the calls made or answered, those in flight, their median and p95, and what did not
  end in a result — and each exposition as a scrape reads it; the Server panel, the calls answered,
  their mean and a median estimated within its bucket. The reads, `stats` and `metrics`, are left
  out of the logs and of those counts.
- Spec section 16, the identity rules (decision 0017): a service's id and a procedure's from 1 to
  65,535, service 0 the protocol's; a service's revision from 1 to 2³¹ − 1, 0 meaning unknown and
  never declared; a procedure's name, in ABNF, a lower-case ASCII letter then 62 ASCII letters or
  digits at most, read whole, a character at a time, never by a platform's regular expression or
  case mapping; two names one when equal once each ASCII upper-case letter is read as its lower-case
  one; one name an address and one revision a service where a side counts; ids and names for life
  within a service, and a revision counting its contract's releases, as SHOULDs `beadc breaking`
  holds. `spec/identities.json`, its schema and its generator, `make_identities.py`, pin what a
  router refuses with no memory: 31 names and 28 ids and revisions, each declared every way a side
  declares, and 8 folds. Both sides play it, `identities.test.ts` and `IdentitiesTests`, the C#
  side excused from the 17 inputs no `ushort` or `int` holds, a platform row of the support matrix,
  "An id or a revision no C# type holds". `common.schema.json` gains the ids, the revision and the
  name, which `interop-service.schema.json` takes.
- Spec section 17, payloads (decision 0016): `raw`, its bytes; `text`, UTF-8 read strictly, its
  leading U+FEFF kept; `json`, one JSON text in UTF-8 read as I-JSON (RFC 7493), a noncharacter
  taken, nested 64 deep at most, each number the double nearest it, and written in the canonical
  form of the JSON Canonicalization Scheme (RFC 8785): one value, one sequence of bytes, from every
  language. `spec/codecs.json`, its schema and its generator, `make_codecs.py`, pin 69 payloads read
  and 38 values written, RFC 8785's Appendix B among them: the bytes written back, or refused and
  why. Both sides play it, `codecs.test.ts` and `CodecsTests`, through each runtime's codecs,
  `router/shared/payloads.ts` and `Bead.Core`'s `Payloads`, which the interop's serializers delegate
  to, and which the service layer makes public. A platform row of the support matrix, "A value a
  side's type cannot hold", excuses the TypeScript side from an object naming a member twice and the
  C# side from `NaN` and `Infinity`. Eight conversations play it over the wire, a payload echoed in
  its own characters, one echoed in its canonical form, and six answered `PAYLOAD_UNDECODABLE`: 150
  conversations. The interop gains a case each way, a value outside ASCII, its members in another
  order, echoed equal.
- `spec/check.py` holds both new files: each under its schema, a name once in its group, every unit
  an entry cites one of the spec's, a `differs` naming a row of the support matrix that names the
  file and the entry, the `_Identities:` and `_Codecs:` lines naming files of `spec/`, and each
  side's tests reading both. The `spec` job regenerates them.

- The service layer (decision 0018), which generated code is a thin shell over, in each runtime:
  a procedure's typed descriptor, `requestOf` and `commandOf`, and `RequestProcedure<…>` and
  `CommandProcedure<…>` with their `ProcedureBindings`, holding its procedure, its admission rule,
  its failures and its payloads' codecs; the server side of a service, `createServiceServer` and
  `ServiceServer<TService, TData>`, whose `on` registers a resolver before or after `offer`, which
  binds every resolver to one Bead server, once, with `command`, `notify` and
  `proceduresWithoutResolver`, and `CommandOf`, `NotifierOf` and `ProceduresWithoutResolver`; the
  client side, `createServiceClient` and `ServiceClient<TService>`, a requester of each procedure
  its server answers and a notification of each that notifies, made as it is built at the windows
  its caller gives, and `on` for the commands it answers. An admission rule is `none`, `session` or
  a hook by name, `AdmissionRule`, and a hook is data, `{ admits, detail }` and `AdmissionHook`,
  refused `ACCESS_DENIED` with its detail; a hook named and not given, or given and not named, is
  refused as the layer is built. A service's failures are a catalogue, `failuresOf` and
  `FailureCatalogue`, and a resolver answers the ones its procedure lists: on the C# side a failure
  class per procedure, `NoFailure` for one that lists none, `AdmissionFailure` for a refusal; on the
  TypeScript side a code no procedure lists, which only a cast reaches, is sent as written and
  reported. A descriptor's `validate`, `Validate`, which throws on a request its rules refuse, is
  called before the resolver, and before the encode on a client whose options say `validates`,
  `Validates`. The TypeScript
  side's entry `@francisdesjardins/bead/service` exports it all, which a generated file imports
  alone; the constant of the contract with generated code is `GENERATED_CODE_SUPPORTS_VERSION_1`
  and `GeneratedCode.SupportsVersion1`.
- A procedure's kind, `procedureKind` and `ProcedureKind`, `ProcedureKind`'s `request`, `notifies`
  or `command`, never its envelopes' kind, which each router checks as the procedure is declared, by
  the way it is declared, after its identity: spec 16.10's third reason, `against its kind`, and
  16.11, what each way takes. A procedure that states none is taken every way. `spec/identities.json`
  gains a sixth way, a server's resolver that notifies, and a group of 6 procedure kinds, which both
  sides play each way. A procedure the TypeScript side hands out as a function carries its
  procedure's members as its own, none of them a function's.
- The payload codecs, public: `IPayloadCodec`, `PAYLOAD_CODECS` and `payloadCodecOf` on the
  TypeScript side, a `json` value read as `JsonValue` and written as `unknown`; `IPayloadCodec<T>`
  and `PayloadCodecs`, with `Raw`, `Text`, `Json` and `Of`, on the C# side. `payloadCodecOf` and
  `PayloadCodecs.Of` make a codec of two functions, a protobuf message's from its stock library's.
- Spec section 17.9, `proto`: a protobuf message in protobuf's binary wire format, read and written
  through each side's stock library, Bead stating four things of its own: what does not decode does
  not read, an empty payload is the message with no field set, a reader refuses a message nested
  more than 100 deep below the top one and sets that bound in its library, and a string's leading
  U+FEFF is a character of it. `spec/codecs.proto` holds the fixed message, `Probe`;
  `spec/codecs.json` gains 28 `proto` payloads, with the fields each reads, and 6 values, its schema
  the reasons `not its message` and `nested past 100`; and `spec/check.py` holds every `.proto` of
  `spec/` named by the spec, and every encoding section 17 states played. The TypeScript side
  generates `Probe` with protoc-gen-es run by buf, its output committed and held to its generator by
  `yarn check`; the C# test project with Grpc.Tools, beside Google.Protobuf. The support matrix
  gains an open row, a string's leading U+FEFF, which protobuf-es strips, and three platform rows: a
  proto field at a wire type not its own, a proto string no string holds given to a writer, and a
  failure its procedure does not list.
- On the C# side, `IBeadServer<TData>`, which `Server<TData>`, `WebSocketServer<TData>` and
  `HttpServer<TData>` implement, the last two gaining `RequireSessionOrCredential`, and `IClient`,
  which `WebSocketClient` and `BeadHttpClient` implement; and `FailureException`'s `IsApplication`
  and `IsProtocol`, the TypeScript side's `isApplication` and `isProtocol`.

### Changed

- The decision records state what holds and where Bead goes: their index groups them by theme under
  its rules and names, under "Where Bead goes", the parts the records bind before the repository
  holds them; 0001's relay is decision 0019 and the connection HTTP draws decision 0020; the rule of
  a duration moves from 0011 to 0014; 0006 keeps its table as rule and job, with its gates owed;
  each Tenth Man section keeps its rounds in order, each answer the one that holds; and the C# side
  has a README of its layout and its modules. A gate in CI's `commits` job,
  `tools/check-links.mjs`, holds every relative link of the repository's Markdown, and its anchor,
  to a file or a heading that exists.
- The parameter rule takes an options object after two parameters, as Deno's style guide counts them,
  held by `max-params` at 3 and by review.
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
  filter is given the session a subscription is held in, its subscriber's `identifier`; on the
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
  whole milliseconds, and `DebugTimestamp` goes. A notification's one step starts as it is sent or
  heard, and a failed notify tells its failure at that same start.
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
- Section 1.4 refuses a value that is no number, and says what a delay is: a wait before an act —
  a pause, a reconnection's wait, the `wait` a client's listens ask — never without end. Section
  15.12 says that a client times its own inactivity by `inactivityTimeout`, 5 minutes by default,
  which section 15.10 names; section 1 names its file, `spec/durations.json`. The support matrix
  gains three rows — a duration finer than a tick and a duration that is not a number, platform, and
  a reconnection's delay given as a number, open — and the rows of -1 ms and of the Web Worker name
  what of the file crosses them.
- The traces are `spec/debugging.md`'s, sections 4 and 5, and built only for a listener (decision
  0013): while nobody listens, a call reads no clock and builds no step, no copy of its options or
  its payloads, and an envelope no redacted header, one check each. The TypeScript client's router
  tells each envelope with its connection, `server`, as the C# one does; the C# side's traced header
  carries its credential's scheme in place of its credential, as the TypeScript side's does, and
  `TracedEnvelope` is its connection and its header alone; a failed call's `rx` is its failure's
  code, scope and detail on both sides, where the C# side traced the whole failure.
- `isDebugging`, on the TypeScript service manager, where it said `debug`, beside the C# side's
  `IsDebugging`: `debug` is the event's name (decision 0003).
- The debug filter reads `spec/debugging.md`'s grammar, in ASCII alone, on both sides: a comma or
  ASCII white space parts two words, and U+0085, U+FEFF, U+00A0 or U+2028 no longer does; `*` runs
  across every line terminator; an ASCII letter matches itself in either case, and a name outside
  ASCII is compared as it is, where each platform folded its own case; `t(request)`,
  `t(command)` and `t(notification)` are taken, `r`, `c` and `n` their short forms; a word holding a
  parenthesis that is no selector is refused, `d(rx,tx)` among them, where it was kept in silence
  as two patterns that match nothing; a refusal names the word or the value as it was written,
  quoted as JSON writes a string; and a filter given whole is refused in the grammar's names.
- A listener's error goes to its router's error event, through a member both sides' routers gain,
  `report` and `Report`, through which a service manager reports what its trace's listener threw,
  with the call's connection on a server; the C# core's port reports with no connection what
  belongs to none.
- A router takes a call it makes in one order, on both sides (`spec/debugging.md` 9.3): a
  programmer's error and a signal aborted already first, each refused and never counted, where the
  TypeScript client checked a notification bound to the call after its credential, and both sides
  checked a command's after its connection; then the call starts; then every refusal with a code,
  `SESSION_REQUIRED` and `DESTINATION_UNREACHABLE` before it goes among them, and a command to a
  connection not open, which fails `DisconnectError`, `DisconnectException`, as one whose
  connection closes does.
- The spec's preamble: a side conforms to the wire by sections 1 to 15, to what it declares by
  section 16, and to what its codecs write and read by section 17, for each encoding it offers; a
  relay, which reads no payload, offers none. Sections 6.1 and 9.5 point to section 17.
- A router refuses a declaration as it is made — a resolver registered, a requester made, a
  notification registered — out of its range or off its form (spec 16.10), on both sides, before
  any reason of its own and its registry's: a `ProgrammerError` and an `ArgumentException`, where a
  requester's and a notification's checked nothing, and a resolver's revision and name were
  anything. A service manager's `getNotification`, `GetNotification`, checks before its own reason.
- The metrics registry, on both sides (`spec/debugging.md` 7.3): "its name at another address"
  compares names as section 16 does, its ASCII letters in either case, where it compared them
  exactly; and it holds one revision a service, refusing a declaration at another,
  `another revision of its service`, before the ceiling. The TypeScript side's `DeclaredProcedure`
  takes `serviceRevision`, and `spec/metrics.json` pins both refusals.
- The C# side writes a JSON payload in RFC 8785's canonical form, where it wrote
  `JsonSerializer`'s: a character outside ASCII as it is, and `+`, `<` and `>` too, where it escaped
  them; a number as ECMAScript writes its double, `1e+21` and `0` where it wrote `1E+21` and `-0`;
  members sorted. It reads a number with `double.Parse`, a tie to the even, where `JsonElement`
  reads some ties of 768 digits to the odd neighbour, and refuses bytes that are not UTF-8.
- The TypeScript side reads a JSON payload as I-JSON: bytes that are not UTF-8, a byte order mark, a
  name given twice, a surrogate alone, a number past the largest double and a payload nested deeper
  than 64 are answered `PAYLOAD_UNDECODABLE`, where it read them; it writes members sorted, and
  refuses what JSON has no value for — `undefined`, `NaN`, a `Date`, a `Map`, a `BigInt`, a function,
  an object of a class, an array with a hole — where `JSON.stringify` converted it.
- A JSON payload's value is its canonical form's on both sides: `1.0` is `1`, `-0` is `0`, and an
  integer past 2⁵³ − 1 is the double nearest it.
- A value that does not write, on both sides (`spec/debugging.md` 4.3 and 10.1): a request's fails
  its call before anything goes, written before its trace and its deprecation, so nothing is traced,
  deprecated or counted; a notification's goes to none of its subscriptions, counted `failed` for
  each and reported once by its router, and notifying fails no caller. A router's notify takes the
  reason in its payload's place: the TypeScript side's `IRouterLike.notify` takes
  `Uint8Array | Error`, and the C# side's `IRouterLike.Notify` has an overload of an `Exception`.
- `spec/debugging.md` 1.2, 6.10 and 8.3 name sections 16 and 17: no procedure is named `_OTHER`, and
  every procedure's name is a pattern a debug filter reads.

- A notify filter takes one argument, the subscriber: `ISubscriber`, its `connectionHandle` and
  its session's `identifier`, and `Subscriber`, a record of `init` properties, which replaces the
  C# side's internal `SubscriptionPlace` (decision 0018). On the TypeScript side `ISubscriber` moves
  to the shared types, generic over its handle, `string` by default, and the `service-manager`
  entry exports it with `ProcedureKind`, `IBoundCall`, `IRegistrar` and `SessionIdentifier`.
- A notification asked for again at another window, or with none against one, is refused on both
  sides, a `ProgrammerError` and an `InvalidOperationException`, where the second window was dropped
  in silence.
- A call bound to its payload is a bound call: the C# delegate `Requester<TResponse>` is
  `BoundCall<TResponse>`, and on the TypeScript side `IRequest` gives an `IBoundCall` and
  `INotification` an `IRegistrar`, each with a `then` no promise matches, so awaiting one with its
  options' call forgotten does not compile.
- The C# side's `NotifyRequest` is a record of `init` properties, `Procedure`, `Filter` and `Key`,
  and `IRouterLike.Notify` has two overloads, of a payload and of the `Exception` a value that did
  not write gives, where `NotifyRequest` was positional: one shape on both sides, the TypeScript
  union's two arms.
- The C# interop service's `Offer` takes any `IBeadServer<string>`.

### Removed

- The debug statistics, for the metrics registry: `createDebugStatistics`, `IDebugStatistics`,
  `IDebugStatisticsOptions`, `IDurationSummary`, `DEBUG_STATISTICS_DEFAULTS` and
  `debug-statistics.ts` on the TypeScript side; `DebugStatistics`, `DebugStatisticsOptions` and
  `DurationSummary` on the C# side; and their seven twin tests a side.

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
- A debug listener that throws, or a filter around it, no longer fails a call that got its result,
  nor leaves a request unanswered, its requester waiting out its timeout, against spec 9.5, on both
  sides: each listener is called within a guard, what it throws is reported, and the call keeps its
  outcome, its answer and what goes on the wire. The twin tests that pinned the opposite are
  reversed, and one more answers a request as a listener throws on its `rx` step.

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
