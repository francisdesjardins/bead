# Changelog

All notable changes to this repository are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- An AMQP 1.0 management link whose ATTACH is answered with no source or target is refused on the
  TypeScript side as on the C# side: its DETACH's condition fails the request, and no request goes
  on its pair (AMQP 1.0 §2.6.3, spec 15.33).
- An AMQP 1.0 stop on the C# side fails each publication without an outcome, sent or waiting for
  credit, and each name's subscription awaiting its ATTACH with the stop's error, as the TypeScript
  side does: a publication its library releases as its session ends is never told no subscriber
  (spec 15.35).

## [0.8.0] - 2026-10-28

### Added

- A broker as a transport, its core on both sides: a participant's client and server transports
  over a broker's adapter, a connection placed once through a server's name, opened in three legs
  and named by both its ends, its parcels numbered so that a copy never reaches the router and
  nothing overtakes, an envelope sent in parts under its peer's bound, a heartbeat and a will of
  Bead's own, a participant whose link another of its id takes over fenced until it is started
  again, an OPEN and a DATA that carries a credential given a life in their broker where the adapter
  offers one, a server's names served by its broker's word, and the credential a request presents
  carried beside it (spec 15.16 to 15.24, decisions 0038 to 0040).
- MQTT 5 as a broker's first binding, on both sides: an adapter over MQTT.js (an optional peer
  dependency, in Node and in a page over WebSocket) and a `Bead.Transport.Mqtt` package over MQTTnet,
  each a link that keeps no session, authenticated by a password or a client certificate, a parcel
  one PUBLISH of QoS 1 counted to its byte under both ends' Maximum Packet Size and held to its
  broker's Receive Maximum, its PUBACK once taken, 0x10 as no subscriber, a subscription let go once
  its UNSUBACK came under 0x80 and refused on 0x80 or more, and a will of Bead's GONE (spec 15.25 to
  15.31, decision 0041).
- AMQP 1.0 on RabbitMQ 4 as a broker's second binding, on both sides: an adapter over rhea (an
  optional peer dependency, in Node) and a `Bead.Transport.Amqp` package over AMQPNetLite, each link
  one fresh connection whose exclusive inbox, declared through RabbitMQ's management on it, ends with
  it, each served name a provisioned queue its participants consume in turn, a session of its own
  for each name and for what goes to names and to inboxes, a parcel one message of one profile counted
  to its byte under the broker's max-message-size and the participant's own, sent through the root's
  topic exchange, accepted, released as no subscriber or rejected, settled once taken under credit of
  its own, a name's 1 so that its queue hands each member one OPEN at a time, a name let go within
  `connectTimeout` or its link lost, and a life as its header's ttl (spec 15.32 to 15.38, decision
  0043).
- An in-memory broker on both sides, which copies, reorders, drops and overruns as a test asks: the
  broker cases of `spec/transports.json`, both roles, and the conversations play over it.
- `spec/vectors.json`'s `parcels` and `parcelRefusals`, a broker's parcels read and written back and
  the messages refused as parcels; `spec/transports.json`'s 44 broker cases, a client role among
  them; and `spec/durations.json`'s broker places, `brokerParticipant.heartbeat`,
  `brokerTransportServer.acceptTimeout` and `brokerParticipant.bodyGracePeriod`, and the way
  `broker` of `transportClient.connectTimeout`.
- `spec/transports.json`'s 43 cases over MQTT 5, played against Mosquitto 2.1.2 by
  `tools/mqtt-broker.mjs`, a broker of its own per run with a password drawn for it;
  `spec/vectors.json`'s `mqttPublishBounds`; `spec/durations.json`'s `mqttBrokerAdapter.keepAlive`
  and `mqttBrokerAdapter.connectTimeout`; the interop over MQTT 5, both ways, in CI's job `mqtt`.
- `spec/transports.json`'s 39 cases over AMQP 1.0 and its `brokers.amqp`, played against RabbitMQ
  4.4.0 by `tools/amqp-broker.mjs`, a broker of its own per run on the fixture it shares with
  `tools/mqtt-broker.mjs`; `spec/vectors.json`'s `amqpMessages`, the profile written to its every
  byte by the spec's own writer, and `amqpPublishBounds`; `spec/durations.json`'s
  `amqpBrokerAdapter.idleTimeout` and `amqpBrokerAdapter.connectTimeout`; the interop over AMQP 1.0,
  both ways, in CI's job `amqp`.
- The internal demo over MQTT 5, `?transport=mqtt`: its page a client participant over the broker's
  WebSocket, served where a broker is given (`node tools/mqtt-broker.mjs run -- yarn demo`), and
  `yarn test:demo`'s leg over it, which skips, saying so, where none is.
- The DevTools panel followed over MQTT 5: a test of the extension that runs the demo's page over
  the broker and finds its calls, each step and its envelopes in the panel, in CI's job `mqtt`.

### Changed

- The spec moves to 0.9.0 (`spec-v0.9.0`), its companion, `spec/debugging.md`, to 0.4.1
  (`debugging-v0.4.1`), and the transcoding's companion, `spec/transcoding.md`, to 0.2.0
  (`transcoding-v0.2.0`).
- The documents are brought to 0.8.0: the records, the spec and its companions in form alone, the
  READMEs and the matrix; no record moves, the index gathers the broker's records under a theme of
  their own, and Rust as the third language, a payload's rules in CEL, the close code carried on
  `close` and a relay that carries a subscription stay ahead.
- A connection over a broker is placed at its open, and nothing overtakes on it, where decision
  0021 had a request published to its procedure's topic and a cancel overtake it; 15.15, how a
  connect ends, stands under a heading of its own, `### A connect`.
- A WebSocket client asks one credential at a time of each provider by its identity: a different
  provider can answer while an earlier source stays pending; a later attempt using that source
  waits for it to settle within its own bounds, then asks anew.
- A proto message that leaves a required field unset — proto2's `required`, an edition's
  `LEGACY_REQUIRED` — at any depth but inside an `Any`, neither reads nor writes on either side
  (spec 17.9.7, decision 0042). A request is answered `PAYLOAD_UNDECODABLE`, a result fails its
  call, and a value fails before it goes. A gateway refuses one 400 `PAYLOAD_UNDECODABLE` after its
  reading, placed as a violation's field is (transcoding 5.2.4, 7.4). Both sides and every gateway
  must change.
- A closed enum's undeclared number sets nothing on a singular field, on both sides (spec 17.9.8).
- Generated code names `GENERATED_CODE_SUPPORTS_VERSION_6`, `GeneratedCode.SupportsVersion6`, and
  calls `protoCodecOf` / `ProtoCodecs`. The runtimes no longer carry version 4, so code generated
  before this change must be regenerated.
- beadc's document requires each field of `LEGACY_REQUIRED` presence (transcoding 11.4, 11.5,
  11.7). The blueprint marks one `legacyRequired`, under the feature `legacy-required`.
  `HTTP_REQUIRED_UNBOUND` refuses a route no call can satisfy, and `HTTP_PATCH_REQUIRED` warns.
- `spec/codecs.json`'s rows of 17.9.7 and 17.9.8 over `Probe`'s `needs`, `needs_items` and `shade`,
  and `spec/transcoding.json`'s readings, bindings, writings and exchanges of a required field,
  over `spec/transcoding-required.proto`, of edition 2023, and the procedures `require`,
  `getNeeds` and `updateNeeds`.

### Fixed

- Over MQTT 5 on a WebSocket, each side sends every message to its broker as one binary frame, and
  a page cuts its messages to 16 KiB at most, which Chromium sends whole: Mosquitto 2.1.2's WebSocket
  listener frames what it sends amid a fragmented message as a continuation, which ends the link. A
  page's burst keeps its link, the demo's glyph among them.
- A WebSocket connect lets go of its socket on every failure and writes no credential that settles
  in the turn its attempt is disposed or times out.
- A C# WebSocket connect disposed as its credential arrives reports the attempt's end, with
  cancellation and timeout taking precedence, even when its aborted socket fails first.
- A PATCH body naming a field whose proto name holds an underscore before a digit binds on the
  TypeScript side, its derived mask set by proto names (transcoding 4.5).
- `HttpEvents.DataOf`, and an `Any`'s bytes on writing, read as 17.9 reads a payload, its records
  checked and its depth bounded.
- beadc keeps the rules of a body that a variable binds into.
- The C# side's JSON mapping reads and writes a delimited field and a group as the message it
  holds, as the TypeScript side does, where it refused one with `no form for a Group`.
- The C# bench builds whole, `spec/transcoding-required.proto`'s messages compiled beside
  `spec/transcoding.proto`'s, and CI's .NET job builds it.

## [0.7.0] - 2026-10-26

### Added

- Generated HTTP clients on both sides: an output with `http: true` writes a typed
  `<Service>HttpClient` beside its route table, over fetch or HttpClient, calling the default
  routes with Bead's JSON mapping, reading problems as Bead failures and notifications as an
  asynchronous event stream; credentials destined off the machine in the clear fail before
  dispatch, redirects are refused, and a stream never reconnects automatically. Both clients take
  the gateway URL first and optional options last; TypeScript calls procedures directly and reads
  subscriptions through `subscribe<Procedure>`, matching the C# methods.

- The demo answers its sign-up over HTTP and JSON: the internal demo mounts a gateway of beadc's
  route table on its public port, `POST /api/SignUp/signUp` and `/openapi.json`, and the page shows
  the same sign-up as a `curl` and the gateway's answer, a refusal as RFC 9457's problem, written
  by the runtime's own mapping where its server is a Web Worker.
- The demo shows the same service on both sides: `examples/hello`'s resolvers, server and client,
  its TypeScript file beside its C# one, one tab a role, written from the repository's files by
  `demo/make-samples.ts` and held to them by the demo's tests.
- Three more fuzz targets: `jwt`, the JWT verifier, and `ws-handshake`, the WebSocket upgrade's
  judgement, on both sides, seeded from `spec/vectors.json`'s verdicts and `spec/transports.json`'s
  upgrades; `blueprint`, beadc's blueprint reader and its form, from `builder/tools/fuzz/`, seeded
  from the repository's blueprints.
- Payload rules: protovalidate's `buf.validate` rules on a `proto` request, read by beadc into the
  blueprint under the feature `validate` and generated as native validators on both sides; a server
  judges every request before its resolver, a client before it sends when its options say so, and
  `failFast` stops at the first violation (spec 18, decision 0035).
- `PAYLOAD_INVALID` (52): a payload that reads and breaks a rule, its violations in its detail as
  lines of canonical JSON, a cut keeping its whole lines (spec 8.1, 9.5, 18.6).
- beadc builds a pattern's DFA ahead of time, its classes from its own Unicode 17.0.0 tables, and a
  target declares the features it generates.
- `spec/validations.json` and `spec/validations.proto`, written by
  `spec/generators/make_validations.py`, its patterns judged by RE2 itself, `google-re2`, pinned in
  `spec/requirements.txt`, and Unicode's files pinned by `spec/generators/ucd.json`; the interop's
  `checked`, its conversations and its exit; each side's validators of it held to what beadc
  writes by `tools/check-validations.mjs`; and the differential against protovalidate-es, in CI.
- beadc runs buf's `PROTOVALIDATE` lint rule, and refuses a rule it does not compile;
  `beadc breaking`'s `PROCEDURE_RULES_TIGHTENED`.
- The in-memory transport, on both sides: two routers of one process, each envelope whole, once and
  in order in a later turn, a credential and the caller's address beside each request, transfers
  taken (spec 15.13, decision 0036). Each side's conversations play through a pair of it, and the C#
  side's service tests link a server and a client through it.
- A joined server transport, on both sides: one server takes its connections from several
  transports, each handle its own transport's (spec 15.14, decision 0036).
- Each side's bench measures calls in memory, and `exchange.*`: a connection drawn, called once and
  closed, as a gateway draws one per HTTP exchange.
- HTTP/JSON transcoding, on both sides: a gateway that answers each procedure's
  `POST /api/<Service>/<procedure>`, `GET` there for one marked `NO_SIDE_EFFECTS`, and each
  `google.api.http` rule as written, one route a path by the peers' precedence, one Bead connection
  per exchange through the in-memory transport into the application's own server, joined;
  protobuf's JSON mapping read and written by Bead's own mapping, one form on both sides, the binary
  payload its stock library's; failures as `application/problem+json`, a status by where its code
  arose, `PAYLOAD_INVALID` 422 with its violations, a body, a query or a variable its reading
  refuses 400 in the mapping's words, where the request carried it in a `pointer`, a JSON Pointer
  into the body as written that names what holds a key past 64 bytes, or a `parameter`, its name
  cut; a refusal of its own in the companion's words, which `spec/transcoding.json`
  holds, naming its gate or its bound and nothing its request carried, a request of no type to a
  route that takes a body 415 and a body HTTP cannot frame refused as HTTP refuses it; each failure
  it answers 500 or above but `PROCEDURE_FAILED` reported on the gateway's `error`, an error of its
  own answered with its code alone, and none of an exception's words in a problem (spec 9.0);
  notifications as Server-Sent Events at the reader's pace, each event an id, a reconnection
  answered 204 (`spec/transcoding.md` 0.1.0, decision 0037). A gateway counts an `accept` weight it
  cannot read as 1, refuses two `content-type` fields 415, answers 304 an `if-none-match` that holds
  `*` among other tags, takes a raw or text route's query of empty sequences, and drops a stream
  past `maximumUnsentBytes` before any byte of it goes. It refuses, as it is built, a route whose
  method is none of `http.proto`'s, that has no template or whose template is off its grammar,
  naming the route, two routes of one method that tie, naming both, and a notification where its
  procedure does not notify, or none where it does. Each side binds a request's message from the
  variables its gateway decoded of the route it matched, its query and its body: `bindRequest`, and
  the C# side's `HttpBinding.Bind`, of a message and its `BindingOptions`. A target that holds an
  octet past US-ASCII is refused 400 as HTTP refuses it, unmarked.
  The TypeScript gateway's own listener listens on `localhost`, both loopbacks, by default, once
  until it stops, and gives its address.
- beadc reads `google.api.http` and `idempotency_level` into the blueprint's routes and messages'
  shapes, under no feature, and writes one OpenAPI 3.1.1 document a blueprint, embedded byte for byte
  with a route table in each output with `http: true`; its rules `HTTP_*`; `beadc breaking`'s
  category `HTTP`, held under `WIRE` and `API` wherever a blueprint states a route, buf's
  `WIRE_JSON` among it.
- `spec/transcoding.md`, the transcoding's companion, its units in `spec/transcoding-units.txt`,
  which `spec/check.py` holds as it holds the spec's; `spec/transcoding.proto` and
  `spec/transcoding.json`, written by `spec/generators/make_transcoding.py`, which reads and writes
  every body beside protobuf's own Python library, pinned in `spec/requirements.txt`, and names each
  edge where it parts; an entry cites `spec.md`'s units behind `spec:`, `spec:9.2.5`.
- Protobuf's conformance suite's JSON tests through each side's mapping of protobuf's JSON, 5,601
  tests binary and JSON, the same two failures listed on both sides.
- `tools/check-transcoding.mjs`, which holds each side's route table and document of
  `spec/transcoding.proto` to what beadc writes, in CI's `builder` job.
- Each side's bench measures `transcoding.read.*` and `transcoding.write.*`: Bead's mapping of
  protobuf's JSON against its stock library's, on a message of every kind of field, and
  `--transcoding` runs those alone.
- `examples/hello` serves its service over HTTP too, by a gateway on a port of its own beside its
  WebSocket one, one server joined; `pairs.mjs` asks each server's gateway what a person asks with
  curl, and `transcript.txt` holds its answers.
- `spec/durations.json`'s places `gateway.timeout` and `gateway.heartbeat`, and the way `gateway` of
  `httpTransportServer.headersTimeout`, `httpTransportServer.bodyGracePeriod` and
  `httpTransportServer.sendGracePeriod`, a gateway's bounds being 15.12's; a gateway's place cites
  `transcoding.md`'s units, `transcoding:9.2`.
- The DevTools panel reads a `PAYLOAD_INVALID`'s detail with the package's own reader: a call's
  Overview tables its violations, a row each with its field, rule, words and bounds, then what the
  closing line counts, that its side stopped, or that the detail was cut; the Wire view sums one up
  on its line.
- The demo's sign-up, a service beadc generates from the demo's own `.proto`, its request held to
  protovalidate's rules: a refusal's violations each under its field, marked `aria-invalid` and
  described by them, one of no field above the form, and "Validate before sending" refusing before
  anything goes; `yarn test:demo` runs the demo's tests, and CI holds its generated code.

### Changed

- The spec moves to 0.8.0 (`spec-v0.8.0`), its companion, `spec/debugging.md`, to 0.4.0
  (`debugging-v0.4.0`), and the transcoding's companion, `spec/transcoding.md`, is first released,
  at 0.1.0 (`transcoding-v0.1.0`).
- The documents are brought to 0.7.0: the records, the spec and its companions in form alone, the
  READMEs and the matrix; no record moves, and the broker, a third language's core, the close code
  carried on `close` and the CEL step of payload rules stay ahead.
- The TypeScript side names a credential scheme to come `scheme 4` in `CREDENTIAL_UNSUPPORTED`'s
  detail, as the C# side and its own header refusals do, where it wrote the bare number.
- The builder, the TypeScript side and the example use Buf 1.75 and the current Oxlint and Oxfmt
  pins, their indirect dependencies refreshed, `fast-uri` past its four advisories among them; the
  C# side and the example use .NET SDK 10.0.403; CI uses Python 3.14.9 and Semgrep 1.182.1, and the
  builder's image Node 26.12.1.
- The demo shows its parts in scenes, one a tab: its calls, its payload rules beside the same
  sign-up over HTTP, the sign-up's OpenAPI document, its server and its metrics, and its code, both
  sides side by side; the address's fragment names the scene shown, the logs stay in a rail beside
  them that a visitor folds away, and its type scale, spacing and radii are penumbra's.
- A descriptor's `validate` gives its violations, and is given `failFast` and the bound of what it
  holds; a violation is answered `PAYLOAD_INVALID`, no longer `PROCEDURE_FAILED`, by the service
  manager. Generated code names `GENERATED_CODE_SUPPORTS_VERSION_4`, `GeneratedCode.SupportsVersion4`;
  the runtimes no longer carry version 3, so code generated before this release must be regenerated.
- The companion counts `PAYLOAD_INVALID` among each family's codes: a procedure takes 62 series in
  the server families and 75 in the client ones, `_OTHER` 74 and 75 (debugging 7.6, 7.7). Its 9.4's
  rows from its thirteenth on are one later, past the new one, and its 9.6's from its fifth on.
- The interop service is at revision 2, `checked` among its procedures.
- The example's count past 10 is a rule of its `.proto`, its failure retired, its service at
  revision 2.
- Spec 15.3 states that a side fails a connection with 1009 past its `maximumMessageBytes` (RFC
  6455 §7.1.7): it drains until the peer's close or its close timeout, its close unclean whatever
  code the peer answers with, and the side reports it naming the bound and its value. A side's close
  timeout, 5 seconds by default, bounds each closing handshake it begins, which a client SHOULD hold
  where its platform lets it. Spec 15.1 states what a side's transport, a client's as a server's, reports
  on its `error`: what it ends a connection for of its own — a protocol error, a 1009, a drop, or
  over HTTP an envelope past `maximumBodyBytes` and a batch that does not read — each once, as the
  connection ends, before its close, and a listener's throw; never a peer gone without its closing
  handshake, one its heartbeat drops, its own abort past its close timeout, nor over HTTP a server
  gone, a refusal of its own, an exchange lost or its inactivity timeout.
- Spec 13.4 and 14.3 count an in-memory transport among what never leaves the machine, and 15.1
  what it carries beside an envelope.
- `spec/durations.json`'s `transportClient.connectTimeout` gains the way `memory`, the in-memory
  client's connect.
- Generated code that writes a route table names `GENERATED_CODE_SUPPORTS_VERSION_5`,
  `GeneratedCode.SupportsVersion5`; the runtimes carry 4 and 5, so a project that generates no route
  table regenerates nothing.
- The HTTP transport's options take one policy object of hosts, origins, proxies and bounds, which a
  gateway takes too; a member given in it and beside it is refused, whatever its value.
- Decision 0008's axis carries the transcoding's companion beside the debugging one: its file repeats
  its `transcodingVersion`, and a release whose transcoding moved tags `transcoding-v`;
  `tools/release.mjs prepare` takes `--transcoding <move>`, and `tools/check-versions.mjs` holds its
  version and its tag.
- Decision 0022 states that a member the blueprint adds under no feature is a minor of
  `bead-blueprint/1`, which every older reader refuses by its closed schema, and that `requires`
  names what a target must play.
- The C# side's `IServerTransport` names the type its handles begin with, `Type`, which a join
  reads, and a connect refused before anything goes is a `ConnectException`, as the TypeScript
  side's `ConnectError`.
- Spec 15.12 states that a client bounds what it reads, an answer or an envelope a batch brings, by
  `maximumBodyBytes`, as both HTTP clients do.
- Both WebSocket servers report a drop as `<handle> is dropped: …`, naming `maximumUnsentBytes`, or
  `minimumSendBytesPerSecond` and `sendGracePeriod`, in the spec's spelling with their values,
  where the TypeScript side wrote `the client fell behind: …` and the C# side its option's name
  alone.
- Both HTTP servers report a drop in that shape, `<handle> is dropped: …`, naming
  `maximumOutboxBytes`, or `minimumSendBytesPerSecond` and `sendGracePeriod`, with their values,
  the pace's sentence the WebSocket's own, where the TypeScript side wrote `the client fell
  behind: …` and the C# side `<handle> is dropped behind its <Option>`, no value.
- `spec/durations.json` names a WebSocket's close timeout `webSocketTransport.closeTimeout`, by two
  ways, `client` and `server`, as `webSocketTransport.heartbeat` is, and both sides' harnesses play
  each, where `webSocketTransportServer.closeTimeout` was the server's place alone, its outcomes
  played by each client's tests.
- `spec/durations.json` holds an HTTP connection's inactivity timeout as one place,
  `httpTransport.inactivityTimeout`, by two ways, `client` and `server`, where
  `httpTransportServer.inactivityTimeout` and `httpTransportClient.inactivityTimeout` held the same
  outcomes apart: two owners share a place where the spec names one option for both and every
  column of the file agrees (decision 0014). The file holds 27 places, by 43 ways.
- Each destination a server's router lists says whether its connection closed, `isClosed` and
  `Destination.IsClosed`, its registration's as it is now; `registerDestination` takes `replaces`,
  the registration the caller holds, whose id the new one takes at once, under one lock on the C#
  side, so no relayed call meanwhile is answered `DESTINATION_UNKNOWN` (spec 14.1, 14.4, decision
  0019). Registering an id that is taken stays refused, closed or not: who may register which
  destination is the application's to decide, and the relay checks nobody.
- The interop service keeps its registrations by destination id: `register` refuses code 8 only a
  destination whose connection is open, or one that is no connection's, and registers anew in its
  place one whose connection closed; `unregister` takes out its caller's own.
- The conversation of a destination dead with its connection opens the device again as a new
  connection, under a handle never given, which registers the destination anew; each side's
  scripted player draws a new handle when a name opens again, and the conversations played in
  memory are 170 of the 175.
- The Web Worker client tells its worker's `error`, an exception its script did not catch, once as
  the connection ends, before its close, unclean, naming the error's message and where it was
  thrown; its server hears that close unclean, by `bead-lost`, as it hears a `disconnect` that is
  not clean (spec 15.1, decision 0036).
- The TypeScript side's transport client and server refuse a start or a connect in the C# side's
  words: `the transport client is already open`, `the transport server is already connecting`,
  `the transport server is starting`; a reconnect and a dispose as it connects too:
  `the transport client is already reconnecting`, `the transport client was never connected`,
  `the transport client cannot reconnect while <state>` and `the transport client was disposed as
  it connected`. Its service client and server refuse a second resolver as `<name> is already a
  registered resolver`, a window for what does not notify as `a window is given for <name>, which is
  no procedure of this service that notifies`, and a command a hook admits as `<name> is admitted by
  the hook <hook>, which a client side is given none of`. A send or a disconnect unless open is a
  `ReadyStateError` in those words too, `the transport client is uninitialized, not open`, its `got`
  and `expected` kept.
- A server's options name the form to write where an entry is refused for its form alone, on both
  sides: a hosts entry with a port names the host without it, a trusted proxy in brackets names
  its bare address, and the refused origins wildcard names `*`.
- The TypeScript side refuses a procedure's declaration in the C# side's words, naming it and the
  clause: `"echo" at 0/1, revision 3, is out of its range: a service and a procedure are from 1 to
  65535, a revision from 1 to 2147483647 (spec 16.2)`, and alike off its form and against its kind.
- The TypeScript side's json and text payloads refuse in the C# side's words, naming their encoding:
  `a json payload is not UTF-8`, `a text payload is not UTF-8`, `a json payload is not one JSON
  text`, `a json value holds a surrogate alone`, and the rest alike.
- A metrics registry that refuses a name says it alike on both sides, `the metrics registry holds
  1/1 as "echo", and is given "other": another name at its address`, as the TypeScript side wrote
  it, its ceiling naming the families it passes; and limits too small for a JWT say on both sides that `a side that takes or presents a JWT
  holds a chunk's envelope and an envelope of 1,024 bytes at least`, as the C# side wrote it.
- The TypeScript side's `TimeoutError` says what the C# side says at each wait: a call past its
  timeout `no answer came in 10 milliseconds`, a key set's ask at its deadline `the key set's ask
  for <issuer> was unsettled as its deadline was reached`, and a connection `timed out after 10ms`;
  it takes its words beside its `timeout`, which it keeps. A call on an ask unsettled at its
  deadline fails with that `TimeoutError`, as the C# side's with its `TimeoutException`, and one on
  an ask that failed with `the key set's ask for <issuer> failed`, its issuer unquoted.
- `tools/check-details.mjs` holds each allowed site itself: each carries its marker, `// ! a detail
  of the side's own words: <why>`, on its line or right above it, and its file counts its marked
  sites, so a new site beside an allowed one fails by its line and a site moved holds.

### Fixed

- Connect cancellation, timeout and disposal bound each supplied provider or HTTP executor even
  when it ignores cancellation. WebSocket clients join one live credential-provider call per
  client. An abandoned call is cancelled and waited out within the next attempt's own bound, then
  the provider is called anew. Clients observe late failures and notify provider completion outside
  the connect's continuation.
  A provider's own cancellation is its failure; a late HTTP connection is released. A provider's
  completion callback runs after connect settles and cannot refuse that connect.
- Generated HTTP clients read gateway refusals and intermediary statuses as Bead failures, keep
  status and Retry-After in their detail, distinguish body bounds from malformed payloads and lost
  streams, and accept a base URL path. Authorization follows the transports' field check; event
  decoding is bounded and linear. C# disposes only its own handler; fetch uses same-origin credentials.
- HTTP clients count an exchange whose executor fails after dispatch as handed over and lose the
  connection. An executor's own failure is reported once before the close; answer reads, listens
  and disconnects reach their ending on both sides, including a cancellation the executor raises.
- Every gateway response body obeys its send pace and maximumUnsentBytes bound: whole answers,
  problems, the OpenAPI document and events. Whole bodies go in slices of at most 64 KiB; a drop
  reports its bound once and releases the exchange and socket, cancelling a stream's call.
  Stream writes settle in order and return each notification's credit. The byte bound includes
  the host's exposed pending bytes and the write handed to it.

- beadc retries temporary work area creation when a concurrent invocation removes its empty
  `.beadc` parent, with at most three attempts.
- The TypeScript HTTP client releases a connection disposed between its 201 response and the end
  of connect, refusing the connect and ending Closed as the C# client does.
- A client's disposal releases a replacement its close listener opens before disposal settles.
  TypeScript's transport clients and the C# WebSocket client end Closed with no kept connection,
  as the C# HTTP client does.
- The C# gateway writes its heartbeat comment a heartbeat after its stream's last write, armed again
  by each write, as the TypeScript side does, where it wrote one each heartbeat whatever went; and
  it refuses a JSON text nested past 202 levels as `nested past 100` before its message is read,
  where it answered `not JSON` past 256.
- A relay words alike, on both sides, the `DESTINATION_UNREACHABLE` it answers a call whose
  credential leg B cannot carry: `it verifies another audience than the one the token names, or
  none`, `it was registered with no audience`, and `its transport leaves the machine in the clear,
  which a bearer credential never crosses`, where the TypeScript side said each its own way and the
  C# side the last another.
- The C# server's gauges count the credentials' sessions it keeps and those of them timed,
  `credentialSessions` and `timedCredentialSessions`, as the TypeScript server's do.
- The TypeScript session manager times a session stored with a token of its own on a connection
  that held none as one whose token it draws, as the C# side does: its gauges count it among
  `timedConnections`.
- The C# HTTP server tells nothing of a connection after its close: an envelope whose connection a
  `DELETE` closes as it is handed on is answered the 404 marked `connection-unknown`, as the
  TypeScript side answers it, where the router could hear it after the close and hold the
  connection for good; a connection's opening and its listens are told before its close too.
- The DevTools panel's redraws keep what their reader did: a block scrolled stays scrolled and a
  section opened or closed stays so, the Metrics view's exposition among them, as each second's
  reading redraws the view, and a call's detail keeps its folded branches while that call and tab
  stay shown.
- beadc compiles and lints projects on another drive than its installation, using a temporary copy
  of its options under the project's `.beadc/`.
- The TypeScript WebSocket client over `ws` offers no `permessage-deflate`, as the C# client does,
  so a third-party server cannot negotiate compression on one side alone.
- The demo's relay forwards a listen's `bead-after` and `bead-wait`, which the HTTP server needs:
  the page over `?transport=http` connects again, where every listen was refused 400 `malformed`.
- The TypeScript servers report a server not yet started as insecure unless its application says
  otherwise or it has TLS, as the C# servers do.
- The TypeScript HTTP server writes an answer that comes before its request's body is whole with
  `connection: close`, its connection closed in stages, as spec 15.12 states and the C# side does,
  where it kept the connection alive.
- The C# HTTP server resets, over HTTP/2, the stream of a request with neither `:authority` nor
  `host`, `PROTOCOL_ERROR`, under any hosts, `*` among them (RFC 9113 §8.3.1), as the TypeScript
  side's does, where it answered 403 `host-refused`.
- Both HTTP servers, both WebSocket servers and both gateways answer a request whose target holds an
  octet other than visible ASCII — a control character, HTAB and a bare CR among them, a space, DEL
  or an octet past US-ASCII — in its path or its query, or whose path's percent-decoding holds NUL,
  400 unmarked over HTTP/1.1 and its stream reset `PROTOCOL_ERROR` over HTTP/2, before anything else
  of it is judged, and tell no refusal (spec 15.12, transcoding 3.6, decision 0026): the C# side
  took a control character, which it upgraded at a WebSocket's address and answered a marked 404 at
  a path not its own, and the TypeScript side took `%00` in a path, which its gateway bound in a
  variable. `%00` in a query, and every other octet percent-encoded, stay taken.
- The C# gateway resets over HTTP/2 the stream of a request whose field or target HTTP refuses of
  its own, `PROTOCOL_ERROR`, nothing written, as the TypeScript gateway does, where it answered 400.
- The C# WebSocket server refuses an upgrade whose `Content-Length` is not zeros alone, a line it
  cannot read or two lines among them, 400 `malformed`, as the TypeScript side does.
- The C# WebSocket server tells a peer that drops without its closing handshake, its TCP
  connection ended or reset, by its unclean `Close` alone, no `Error`, as the TypeScript side does.
- Both WebSocket servers tell a message past `maximumMessageBytes` by one `error` of their own,
  `<handle> is closed with 1009: a message past its maximumMessageBytes, N bytes`, a `GenericError`
  keeping `ws`'s error as its `cause` on the TypeScript side, an `InvalidDataException` on the C#
  side, which told none; then an unclean close, which the C# side told clean when the peer's answer
  was a 1000.
- Both WebSocket servers report a connection's error once its close or its drop began, and tell its
  close all the same, so a listener of `error` that throws keeps no connection open, a drop's among
  them. The C# server tells at most one `Error` a connection: none past its own 1009, its drop, its
  abort after `CloseTimeout`, or its heartbeat's drop.
- The TypeScript WebSocket server gives `ws` its `closeTimeout`, so a peer that never answers its
  1009 is dropped after it rather than after `ws`'s own 30 seconds.
- The TypeScript WebSocket client takes `closeTimeout`, `CLOSE_TIMEOUT` by default, 5 seconds, held
  as the server's, and gives it to `ws`, so a server that never answers its `disconnect` or its 1009
  is dropped after it, as the C# client's `CloseTimeout` drops it, rather than after `ws`'s own 30
  seconds; over the global `WebSocket`, its platform bounds its close.
- Both HTTP servers report a drop once its connection's end began, its exchanges cut, then tell
  its close all the same, so a listener of `error` that throws keeps no connection open; a
  connection two late answers drop is reported once.
- Both WebSocket clients tell, once open, a protocol error on `error`, and a message past their
  `maximumMessageBytes` as `the connection is closed with 1009: a message past its
  maximumMessageBytes, N bytes`, a `GenericError` keeping `ws`'s error as its `cause` on the
  TypeScript side, an `InvalidDataException` on the C# side, then their unclean close: the
  TypeScript client told none once open, and the C# client told its own 1009 only when its server
  never answered, as its abort. Over the global `WebSocket`, whose `error` cannot be told from a
  drop, the TypeScript client tells none.
- The C# WebSocket client tells no error for a server gone without its closing handshake, its
  heartbeat's drop or its own abort past `CloseTimeout`, and tells its close all the same when a
  listener of `Error` throws, where the close was lost.
- Both HTTP clients tell, before their close, an envelope past `maximumBodyBytes`, an answer's or a
  batch's, as `the connection is closed: an envelope past its maximumBodyBytes, N bytes`, and a
  batch that does not read as `the connection is closed: a batch that does not read, …`, saying
  what of it does not, each an error of their own, where they told their close alone.
- The C# client validates a notifying procedure's subscribing request under `Validates`, as the
  TypeScript side does.
- The TypeScript service manager names a notification's window as the C# side does, `window 4`
  or `no window`, in the error of a second ask for it with another.
- A destination registered on a connection its router no longer holds is closed from its
  registration, unreachable at once, and never forwarded to (spec 14.4).
- A Web Worker client whose worker errs before the connection opens, its script failing to load,
  fails its connect with a `ConnectError` at once, rather than after its timeout.
- The C# in-memory server settles a connect in the turn after its listeners heard the connection,
  as the TypeScript side does, so a close of theirs fails the connect, where the client opened on a
  connection already closed.
- An in-memory connect given up on, by a dispose, its token or its clock, draws no connection: the
  TypeScript client hands its server an aborted signal, `accept(peer, { signal })`, which the
  TypeScript server honours. A cancel or a timeout met as its server draws the connection holds on
  both sides until the connect settles, what was drawn closed unclean and no close told, where the
  C# client opened it and a reconnection then closed it clean, and the TypeScript client left it
  open.
- The C# in-memory client carries an empty credential as none, as an empty field does and the
  TypeScript client does, where its server was handed an empty one.
- The TypeScript join refuses a transport that names no type, a join among them, with a
  `ProgrammerError`, as the C# side does, where it took one whose handles no transport owned.
- A TypeScript transport client's reconnection its signal ends rejects with a `CancelError`
  worded `the reconnection was cancelled`, as the C# side words it, the signal's reason its
  `cause`, where it said nothing.
- The C# interop service is offered whole by one service server, `checked` with its rules among
  its procedures, as the TypeScript side offers it, where a second one answered `checked`.
- The C# side's `FailureException.Header` stays redacted, its credential's scheme alone, whatever
  header it is given, as the TypeScript side's `FailureError` keeps it, where a header given from
  outside the router kept its credential.
- The TypeScript side's refusal of a debug filter given whole names a kind's number quoted as JSON
  writes a string, `not "153"`, as the C# side does (debugging 6.7, 6.8), where it named it bare.
- The TypeScript `failuresOf` refuses a service id that is no whole number from 1 to 65535 with a
  `ProgrammerError`, as the C# side's `FailureCatalogue` does (spec 16.2, 16.3), where it took one.
- The C# side refuses a router's limit out of its range by its name and its value
  (`WindowBytes is a whole number above 0, not 0`), the limits in the order of their names, and
  words a paced request that opens no subscription as the TypeScript side words it, where it said
  one rule for every limit.
- The C# metrics registry refuses a declaration in the TypeScript side's sentences, the name held
  and the name given quoted as JSON writes them, the families it overflows named and the spec's
  reason last, where its sentences were its own.
- The TypeScript side's `SESSION_REQUIRED` for an `OPAQUE` call before any session, and its refusal
  of an empty transfer opening, read as the C# side's: `no session is known for OPAQUE to stand
  for`, and `… of its payload at least, not 0`.
- The TypeScript side's pending calls hold a reservation's timeout as the C# side's do, refusing
  one past the longest timer or under a millisecond, where they reserved for the default.

## [0.6.0] - 2026-10-20

### Added

- `SECURITY.md` says how to report a vulnerability, privately, and what to expect of a personal
  project; the README opens on what Bead explores, shows it at a glance, and where it stands next
  to the alternatives.
- The benches measure HTTP and WebSocket, cross-language calls, notifications and allocation over
  repeated runs; `tools/bench-compare.mjs` compares their reports.
- `implementations/typescript/tools/bench.mjs` and `implementations/dotnet/tools/Bead.Benchmarks`: the
  same four layers measured on each side in the same units, the envelope codec, the `json` payload
  codec, an echo over a WebSocket on the loopback and a transfer of 20 MiB, by hand (README,
  Measurement).
- `tools/check-details.mjs`, in CI: no exception's message goes into a failure's detail but at
  the sites that report alone, or where the error is the side's own (spec 9.0), on either side
  (decision 0006).
- Each CI run keeps its coverage reports 14 days, among its artifacts: the TypeScript side's HTML
  and lcov, the C# side's cobertura files.
- Each side's envelope readers are fuzzed in its suite: seeded mutations of `spec/vectors.json`'s
  bytes, each read returning or refusing with a failure within a second; `BEAD_FUZZ_INPUTS` draws
  more for a longer run.
- `tools/fuzz.mjs`: coverage-guided fuzzing of both sides' parsers by hand, Jazzer.js on the
  TypeScript side and SharpFuzz with libFuzzer on the C# side, the envelope reader, the `json` and
  `text` codecs, the HTTP fields and the debug filter, seeded from the conformance files (README,
  Fuzzing).
- The DevTools panel places its detail right of the list, under it, or by the panel's width as
  DevTools' Elements panel does, and a splitter between them sizes both; the panel keeps both
  choices.
- Debugging 9.7 states that a call made on a connection that closes fails as closed,
  `DisconnectError`, `DisconnectException`, even when the signal it was given is that of a call the
  close ends; an exit of `spec/metrics.json` closes a connection while a call on it awaits its
  command, and counts both `closed`, once each.
- A router limit of the protocol's, `maximumAnsweringCalls`, `MaximumAnsweringCalls`, 64: a
  requester holds its calls on a connection to it, failing one past it before it goes, and a request
  past it is answered `CAPACITY_EXCEEDED` before anything else of it is read, on every transport
  (spec 9.1, 9.2's new step 3; decision 0033). Each side gauges `largestAnsweringCalls`, the busiest
  connection's, which its health warns on at 80%.
- A server holds what waits for a client's socket to `minimumSendBytesPerSecond`, 240, past
  `sendGracePeriod`, 5 s, and a WebSocket server to `maximumUnsentBytes` besides, dropping and
  reporting a client behind them, its close unclean; over HTTP, an answer or a listen's batch behind
  its pace is an exchange lost, its connection closed at both ends (spec 15.7, 15.12; decision
  0033).
- Both transports' servers bound a request's head, `headersTimeout`, 30 s, answered 408 as HTTP
  answers it, and an HTTP server a body, `minimumBodyBytesPerSecond`, 240, past `bodyGracePeriod`,
  5 s, refused 408 `too-slow`, marked and told (spec 15.6, 15.12; decision 0033).
- A server's router tells each access it refuses, `accessRefused`, `AccessRefused`: its stage, the
  code answered, its reason, the credential's scheme, what was called, the connection, and the
  refused request's own address and port, which its transport hands beside each envelope; never the
  credential, nor a claim (spec 13.12, 15.1; decision 0034). `spec/vectors.json` gains
  `credentialRefusals`, the reason of each credential refused but a `JWT`'s.
- The conversations of 9.2's new step 3 and of a request held to `chunkBytes`; the transports'
  cases of a WebSocket server's connections, a body's rate and a head's time; the durations of
  `sendGracePeriod`, `headersTimeout` and `bodyGracePeriod`; and an exit that counts a request past
  the calls its connection has answered.

### Changed

- The spec moves to 0.7.0 (`spec-v0.7.0`), and its companion, `spec/debugging.md`, to 0.3.0
  (`debugging-v0.3.0`).
- The documents are brought to 0.6.0: the records, the spec and its companion in form alone, the
  READMEs and the matrix; no record moves, and the broker and what remains of the fuzzing and the
  measurement stay ahead.
- The DevTools panel uses penumbra's spacing grid and a shared radius scale, with comments for
  measured glyphs, strokes and native slider alignment.

- Both sides close a closing connection's sending transfers with its receiving ones, before they
  settle its calls: every transfer of the connection ends, and every call of it is taken out, before
  any of its calls is counted.
- The README says why nothing is published before 1.0.0: the wire, the names and the API change
  freely until then, with no deprecation cycle.
- The DevTools panel reads at DevTools' own density, penumbra's type scale set to 12 px under a
  skin of DevTools' own colours: its controls and their groups stand 22 px, its record and clear
  icons are drawn centred, its controls and tabs are of one look in both themes, and its bar holds
  on one line on a wide panel. Its tabs move on the arrow keys, Home and End, its filter's syntax opens from a
  `?` beside it, and an exchange's labels stop short of the next lane, whole in a tooltip.
- The `json` codec reads and writes a large payload in a fraction of the time, its output the
  same: the C# side writes a string that holds no escape as its bytes, and the TypeScript side
  finds the end of a string by search rather than character by character. A 64 KiB echo over a
  WebSocket goes in a twelfth of the time on the C# side, a 20 MiB transfer in an eighth.
- The toolchain is current: buf 1.74.0, Playwright 1.64.1, oxfmt 0.73.0, oxlint 1.88, Roslyn 5.9.0,
  xunit.v3 4.0.2, and OSV-Scanner 2.7.0 and Semgrep 1.181.0 in CI; beadc's image is on Node 26.12.0.
  The floors stay (protobuf-es 2.13, Node 24.9).
- A redirect, 301, 302, 303, 307 or 308, is judged as any status that is not 2xx, its
  `bead-refusal` left unread, on both sides (spec 15.6): the C# side's listen counts a marked one
  lost and listens again, and its send no longer rejects one. The TypeScript side's fetch receives
  `redirect: 'manual'` (`IFetchInit.redirect`), so a connect answered with a redirect names its
  status on Node, and `the server drew no connection: a redirect` in a page, which reads none.
- A redirect followed all the same by a fetch or a handler given is caught at its answer, read from
  `redirected` on the TypeScript side, which `IFetchResponseLike` may now say, and from the
  response's `RequestMessage` on the C# side: its connect fails
  `the server drew no connection: a redirect followed`, and a send or a listen loses its
  connection, its answer never read. The C# side refuses at construction, with an
  `ArgumentException` naming `AllowAutoRedirect`, a `Handler` whose innermost `HttpClientHandler`
  or `SocketsHttpHandler` would follow.
- On the TypeScript side, the header a resolver, its `admit`, its callback and a `beforeRequest` are
  handed is an `IHandedRequestHeader`, exported beside `IRequestHeader`: its credential, a
  `HandedCredential`, says a `JWT`'s scheme alone, so a procedure that reads a `JWT`'s token there
  no longer compiles. The C# side's `RequestHeader` says so with a `Credential` whose `Token` is
  none.
- A WebSocket server bounds its connections, `maximumConnections`, 10,000, and
  `maximumConnectionsPerAddress`, 64, an upgrade past them refused 503 `busy` before its 101: behind
  a proxy it now needs `trustedProxies` or `unnamedProxies`, as an HTTP server does, or every client
  past the 64th is refused (spec 15.2, step 8, 15.12; decision 0033).
- A request that came whole, and a transfer's opening, is held to `chunkBytes`, answered
  `ENVELOPE_TOO_LARGE` past it, as its requester sends it (spec 12.2). An HTTP server's
  `maximumWaitingExchanges` follows its router's `maximumAnsweringCalls`.
- The TypeScript HTTP server's answers are held to `minimumSendBytesPerSecond`, as the C# one's were
  to Kestrel's `MinResponseDataRate`, which the C# side sets to none, Bead's rule in its place, as
  Bead's body rate replaces Kestrel's `MinRequestBodyDataRate`; a head is answered 408 at 30 s,
  where Node's 60 s held, the transport setting `headersTimeout`, `requestTimeout` and
  `connectionsCheckingInterval` on every server it listens on, those its `createServer` builds
  among them.
- An HTTP outbox past its bound is reported as it closes its connection (spec 15.9).
- Spec 9.2's steps 3 to 8 are steps 4 to 9, and 15.6's rows from 409 on one later, past its new 408;
  debugging 9.4's rows from its second on are one later. Spec 15.12's table names the transports
  each bound holds on.
- Three conversations ask `bytes` for the result they send as a transfer, and the one of a relay's
  legs' payload limit sends leg A's request whole within `chunkBytes`; leg B's header, counted call
  by call, is its twins'.
- Spec 15.12 states that a head's 408 comes past its time and within 2 seconds of it, on the
  platform's clock, as Kestrel's heartbeat answers a connection's first head 1 to 2 seconds past it.
  An `expect` of `spec/transports.json` may name `after`, the soonest what it reads may come, which
  the head's two cases set to their `headersTimeout` less 100 ms; a runner that misses a `within`
  tells when the response came, or that it never did.

### Removed

- `transportCredential` from `IAdmissionRequest`, `IRequestResolverProps` and `ISessionRequest`,
  and `forwardsCredentials` from `IRequestHandler`, on the TypeScript side;
  `SessionRequest.TransportCredential` and `IRequestHandler.ForwardsCredentials` from the C# side's
  public surface, and `RouterCore`, `RouterCoreOptions`, `IRouterCorePort`, `CoreRequest` and
  `AnswerInfo`, internal as the TypeScript side's core is. A procedure no longer takes a credential
  unverified to pass on; a relay's destination does.

### Fixed

- The C# HTTP server tells a listen that replaces another as held before it tells the end of the
  one it replaced, as the TypeScript side does, so a count of the listens held never falls to 0
  as one takes over.
- The DevTools panel's control borders reach at least 3:1 contrast against their surfaces in both
  themes.

- On the C# side, a resolver hears its signal before its call's rejection when its connection
  closes, whatever scheduler it runs on: the teardown cancels each incoming call's token in its own
  turn, by `CancelAsync`, its callbacks run after it. On the thread pool under load, a resolver
  could catch its outgoing call's `DisconnectException` with its token not yet cancelled.
- In the DevTools panel's Envelopes mode, the call whose envelope is clicked stays selected, each of
  its envelopes marked, as its row is in the Calls mode.
- Spec 15.6 states that a send answered with a redirect is lost, as both sides play it, and that a
  page reads no status of a redirect; it said the send failed.
- Both sides hand `sessionOf` what a transport carried beside a request presenting `ELSEWHERE`
  alone, as spec 15.1 says; one presenting none, `OPAQUE` or a `JWT` came with it all the same.
- On the C# side, a relay refuses an `ELSEWHERE` that leg A's transport carried nothing for, to a
  connection of its own as to any other leg B, `DESTINATION_UNREACHABLE`, as the TypeScript side does;
  no transport reaches it today.
- On the C# side, a call or a command presenting `Credential.Elsewhere()`, nothing for its
  transport to carry, a JWT with no token, or a scheme to come is an `ArgumentException` before the
  call starts, not counted, as the TypeScript side's `ProgrammerError` is; it failed counted,
  `DESTINATION_UNREACHABLE`, or went with a scheme no side writes (spec 13.4, debugging 9.3).
- On the C# side, a call that would present a default withdrawn is counted, started and ended
  `SESSION_REQUIRED`, as on the TypeScript side, and fails after a programmer's error and before a
  connection not open, as there.
- On the C# side, a request whose sending fails as its router is disposed is rejected as disposed,
  as the TypeScript side rejects it, not with the transport's refusal, which raced the disposal.
- On the C# side, an HTTP body whose read Kestrel fails — slower than its rate, a malformed chunked
  one — is answered the status of its failure, unmarked, its connection closed, never 200 and empty,
  which said the server had the envelope (spec 15.7).
- Every answer an HTTP server writes before its request's body is whole closes its socket in
  stages, its write side first, so its client reads it before the close, the TypeScript side's 404
  `connection-unknown` among them, which kept its socket and drained the body (spec 15.12).
- Spec 8.3's open point closes: a receiver bounds the calls a peer has it answer on a connection
  that keeps it, a WebSocket's or a Web Worker's, and what it holds of their requests in bytes (spec
  9.2, step 3, 12.2).

### Security

- A procedure is handed no bearer credential its call came with, on both sides: its resolver, its
  admission, a `beforeRequest` and a relay's `beforeRoute` read the call's session, and of a `JWT`
  its scheme alone; what a transport carried beside an `ELSEWHERE`, and a `JWT`'s token, reach the
  side's verifier and a relay alone. A registered resolver and its `admit` were handed both, and on
  the C# side so were a `BeforeRequest` and a relay's `BeforeRoute`.

## [0.5.0] - 2026-10-14

### Added

- `beadc check` refuses, `CSHARP_NAMESPACE`, a `csharp_namespace` that is no C# namespace,
  identifiers of ASCII letters, digits and `_` by dots: the C# target writes it as it is, so
  anything else would be code of the `.proto`'s author in every consumer's build.
- CI holds the supply chain: every action pinned by its commit's full sha, its version beside it;
  OSV-Scanner over every lockfile and NuGetAudit over every C# package, direct or transitive, a
  known advisory failing the run; Semgrep's community rules for TypeScript, C#, GitHub Actions and
  secrets over the code. No dependency runs a script as it installs, but buf's and esbuild's,
  named in each `package.json` (decision 0006).

- Each side's tests run under coverage in CI, and what they run, lines and branches each, holds the
  side's floor in `tools/coverage-floors.json`: `tools/coverage-report.mjs --floor` fails under it,
  or where nothing was measured, and writes the report into the run's summary. A floor sits half a
  point under what was measured and rises with `--raise`, never down but by a decision (decision
  0006). The C# side is measured over the whole solution, its six test projects.
- A WebSocket upgrade that carries no `Origin` carries its `Authorization` beside every envelope
  of its connection, which a request presenting `ELSEWHERE` stands for, resolved per request by the
  verifier as over HTTP; one that carries an `Origin` carries none, a page's browser writing its own
  authentication on it. A client writes the credential its connect is given, `credential` or
  `credentialProvider`, `Credential` or `CredentialProvider`, a string or a provider called at each
  attempt, a reconnection's included; it is refused over a URL in the clear off the loopback and, on
  the TypeScript side, over a `WebSocket` constructor without `ws`'s shape; and an upgrade with two
  `Authorization` fields is refused 400 (spec 15.2; decision 0032).
- A server counts the proxies on every path to it that `trustedProxies` does not name,
  `unnamedProxies`, `UnnamedProxies`, 0 to 8, over HTTP and over WebSocket: one whose address the
  list holds costs none, any other one of the count, so a router whose addresses its platform does
  not publish is passed, and a count past 8 is refused as built; a platform that publishes its
  ranges is named in the list (spec 15.12; decision 0030).

### Changed

- The spec moves to 0.6.0 (`spec-v0.6.0`), and its companion, `spec/debugging.md`, to 0.2.1
  (`debugging-v0.2.1`).
- `beadc breaking` refuses a bare waiver of a breaking rule, `--except PROCEDURE_SAME_NAME`, and of
  buf's, `--except buf:FIELD_SAME_TYPE`, exit 2, naming the subject's form or a path: kept in a CI,
  it would waive a later change's finding too. A waiver names its subject or its `.proto` path, as
  buf's `ignore_only` does; a warning of `check`'s, which finds no subject, is still waived by its
  name (decision 0022).
- Without `clean`, `beadc generate --check` fails on a `_bead.ts` or a `*Bead.cs` under beadc's own
  header that the source no longer gives, and `generate` names it and leaves it: nothing but beadc
  writes one, so a service a source dropped no longer ships in silence. Under `clean`, `generate`
  still takes it out.
- The DevTools extension's hook and bridge post to the page's own origin, `'/'`, never `'*'`, which
  would reach a document the window navigated to.
- The C# side's projects build under the threading analyzers' VSTHRD100 and VSTHRD101: an
  `async void`, an `async` lambda given to an event among them, fails the build. The WebSocket
  connection's close awaits `CancelAsync`, and the C# README names the analyzer for an
  application's own listeners.
- A client transport's `carriesCredential` is `carries(credential)`, `Carries`, on both sides: a
  WebSocket carries the bytes its upgrade carried alone, compared in constant time. A client refuses a credential with a space or a tab first or last,
  which no field value holds (spec 15.5). The TypeScript WebSocket server's `connection` event shows
  the upgrade headers aside, as the HTTP server's shows a connect (decision 0032).
- A server given no address listens on `localhost`, both loopbacks, `127.0.0.1` and `::1` on one
  port, as Kestrel's `ListenLocalhost`: no other process can answer a client that reaches it by
  `localhost` on the other family. `localhost` is the one name an address takes; a port taken on
  either family fails the start, a drawn one is drawn again; where the IPv6 loopback is absent it
  listens on `127.0.0.1` and reports it (spec 15.12; decision 0024).
- The TypeScript HTTP transport's `createServer` is called once per address bound, told it as
  `{ address }`: an application that configures its server after building it configures each.
- Decision 0030 is renamed for the count it holds, "A server believes `X-Forwarded-For` from the
  proxies it names and as many unnamed ones as it counts", its file with it; every citation moves.
- A relay answers a result leg A cannot carry, one past leg A's limit, `PROCEDURE_FAILED` with no
  detail, whatever refused it, `PAYLOAD_TOO_LARGE` among them, as a server answers a result its side
  cannot send, and reports why it did not go out with leg A's connection; an answer leg A's
  transport did not take goes nowhere again, and is reported. 34 would say the request was refused
  at its admission, though the destination's procedure ran (spec 14.5; decision 0019).
- A failure a side answers for an error of its own, a resolver that throws, a verifier or an
  admission that fails, a result it cannot send, an answer leg A cannot carry, a codec that throws
  other than a refusal, carries no detail of that error, never an exception's message, which is
  reported; `PROCEDURE_FAILED` so answered carries none, as OWASP ASVS 5.0's 16.5.1 returns a
  generic message to the consumer of an unexpected error (spec 9.0; decision 0001).
- The documents are brought to 0.5.0: the records, the spec in form alone, the READMEs and the
  support matrix state what it carries as what holds, and what is ahead, the bounds a server keeps
  against a peer, a security event for a refused credential and the parsers fuzzed, where Bead goes;
  the broker as a transport moves to 0.6.0. No record changes its number or its file.

### Fixed

- The C# WebSocket client follows no redirect answered to its upgrade, as the TypeScript one does:
  a 3xx fails its connect, its status named (spec 15.6; decision 0032).
- The TypeScript side puts nothing of an error its envelope codec throws, other than a refusal, in
  the failure it answers: the exception's message, which a peer's bytes could reach, is reported,
  never sent (spec 9.0).
- The C# side answers a request its envelope codec throws on, other than a refusal,
  `ENVELOPE_MALFORMED` with no detail, where it answered nothing and the call waited out its
  timeout; such an error, at the prefix or past it, is reported once, with its connection
  (spec 9.0).

## [0.4.1] - 2026-10-13

### Added

- A WebSocket server believes `X-Forwarded-For` from the proxies it is told of, `trustedProxies`,
  `TrustedProxies`, as an HTTP server does: the same entries, the same refusals as it is built, a
  network of prefix 0 among them, and the same walk of the upgrade's field, so a connection behind
  a proxy it names is named and told by its client's address, never the proxy's. It bounds no
  address, so nothing else moves (spec 15.12; decision 0030).
- `spec/check.py` holds every count the tables of files of `docs/support.md` and the README state
  to the files it counts: the vectors and each group's, the conversations, the transports' cases by
  transport and by clock, the clock cases, the durations' places, ways and inputs, the identities'
  names, ids, kinds, ways and folds, the codecs' payloads and values, the filters and their calls,
  the expositions and the exits, and what each side plays; the protobuf suite's tests to its
  runner's floor; and a table or a row that loses a count, or a row that states a number none
  holds, fails (decision 0006).

### Changed

- The spec moves to 0.5.0 (`spec-v0.5.0`); its companion, `spec/debugging.md`, stays at 0.2.0.
- A relay refuses a call that opens a subscription with the detail "this relay carries no
  subscription", on both sides: a relay carries none, and one that would is a decision of its own.
- The documents are brought to 0.4.1: `beadc breaking` is stated as CI runs it, against the last
  release, which carries the interop's blueprint and `examples/hello`'s; a WebSocket connection's
  handle is named by its client's address (decision 0025); the README's roadmap puts the
  penetration test next, the broker at the product's 0.5.0 and the hop bound further. Decision 0017
  cites the interop schema's pattern as it is, and `examples/hello`'s README names the C# packages
  as decision 0008 does. No record is merged, renamed or split.

## [0.4.0] - 2026-10-13

### Added

- Every server transport tells each refusal it judges of its own, the event `refusal`, `Refusal`, on
  both sides: its status, its reason, the request's authority and origin as they came, and the
  client's address and port, never its target, a token or a credential; the 404 that ends a listen
  or an exchange as its connection closes is told by `close` alone (spec 15.1; decision 0026). Its
  record is `ITransportServerRefusal` on the TypeScript side and `TransportServerRefusal` on the C#
  side, `IServerTransport` gaining `Refusal`; a throw of its listener is reported through `error`
  with the empty handle. `spec/transports.json` checks it at every marked refusal.
- On the TypeScript side, `IHTTPResponseLike.stream`, through which an HTTP/2 stream is reset, and
  `IHandshakeRequestLike.url`, the target an upgrade's authority is read from, both optional.
- `.claude/workflows/bead-release-documents.js`: a release brings to itself every document that
  states what holds and where Bead goes — the records, the spec and its companion, the READMEs, the
  matrix, `CLAUDE.md` — what landed in the present and what is ahead kept ahead, the spec moving in
  form alone, records regrouped, merged, split or renamed where that reads clearer, a number never
  given again, every citation moved with them; `tools/release.mjs prepare` lists it among what a
  release owes by hand.
- `docs/support.md`'s "Leveled down": each place where every side keeps to what one platform can do
  though a standard allows more, with the standard, what forces it, what would lift it and the tests
  that hold it on each side.
- `spec/units.txt` and `spec/debugging-units.txt`: every unit of each document, its front matter and
  each section's lead included, whether an entry cites it or why none does, and the sha256 of its
  text. `spec/check.py` holds each reason by its rule — a `lead` or a `defines` unit carries no key
  word, a `twins` unit is named by its own number, `spec 15.10`, in a test's title or a comment just
  above its declaration, on each side, a `builder` unit by beadc's, an `open` one by its document's
  status line, an `owed` one printed — and fails when a unit's text moved, naming what plays it,
  until `--write-units` acknowledges that unit by name. Each side's twin tests name the units they
  hold.
- The conversation `a cancel that crossed its answer is dropped, nothing reported` (spec 12.9.6).
- beadc marks a deprecated procedure, service and failure at compile time, in both targets alike:
  JSDoc's `@deprecated` and C#'s `[Obsolete]` with `DiagnosticId` `BEAD0001`, on every declaration
  each target writes for it, with the blueprint's deprecation message or "No replacement is named.";
  in TypeScript, a deprecated name passed to `on`, `of` or `is` is marked by its own overload.
- A failure's deprecation in the blueprint, from protobuf's `deprecated` on its enum value.
- `PROTO_FILE`: `beadc check` refuses a `proto` path off its form (`..`, an absolute path, a
  backslash) or one `proto.files` does not list, and a service's `proto` in a blueprint with no
  `proto`.
- `beadc breaking` names each finding's subject, its entity by ids (`service:1/procedure:4`), in
  text, `json` and `github`; `WAIVER_UNUSED`, a warning, says a waiver that waived nothing.
- `AGAINST_BLUEPRINT`, a warning: an earlier's committed blueprint that its `.proto` contradicts, or
  one named and missing.
- `clean` in `beadc.yaml`, buf's opt-in removal of what `generate` no longer writes.
- An HTTP server answers CORS to the origins `origins`, `Origins`, names, and to no other, on both
  sides: their preflight is answered 204, `Access-Control-Allow-Methods: GET, POST, DELETE`,
  `Access-Control-Allow-Headers` naming `Authorization` and the names the preflight asks, then `*`,
  so a browser that caches no wildcard keeps the answer, `Access-Control-Max-Age: 7200`; every
  answer to them once their origin is judged names it and exposes every field. A page of a listed
  origin now connects, calls and listens over HTTP, as it did over WebSocket, its tracing's fields
  among its requests, and presents `ELSEWHERE` in `Authorization`, which HTTP alone carries (spec 15.12;
  decision 0027).
- `yarn test:browser`, on the TypeScript side, in a Playwright config of its own: a page Chromium
  loads from another origin calls each side's interop server over HTTP with the bundled HTTP client,
  and CI's .NET job runs it against both. Both interop servers name the origins
  `BEAD_INTEROP_ORIGINS` lists.
- `protoRuntime` in a TypeScript output of `beadc.yaml`: the module a generated `proto` codec
  imports `checkProtoRecords` from, `@francisdesjardins/bead/proto` by default, or a path relative
  to the output, as `runtime` names its own.
- Each side reads a `proto` payload's records against its message's descriptor before its stock
  library does, and refuses what protobuf refuses where a library reads on: a record past the end of
  its message, a packed record whose values do not end at its length, a varint of more than 10
  bytes, a tag of more than 5 bytes or past 32 bits, a length past the bytes after it, a field at a
  wire type its type does not take, and a map's entry with a field it does not declare (spec 17.9.5,
  17.9.6; decision 0028). The check lives in `@francisdesjardins/bead/proto`, `checkProtoRecords`,
  and in the `Bead.Protobuf` assembly, `ProtoRecords.Check`; the four open rows of the support
  matrix where a stock library read what protobuf refuses close, and a known field at a wire type
  its type does not take, and a map's entry's undeclared field, are two rows of its "Leveled down".
- Each side's generated `proto` codec plays protobuf's conformance suite, v36.2, and both read one
  corpus alike, in CI, through `tools/protobuf-conformance.mjs`, its runner fetched by its pin,
  `tools/protobuf-conformance/runner.json`; Google.Protobuf's order of the unknown fields it writes
  back, and its leaving out a map's entry's key at its default, which protobuf-es writes, are
  platform rows of the support matrix.
- The DevTools panel reads a call whole. Calls shows a row a call, its steps and its envelopes met by
  its call id on its connection, its outcome in words, a command the server made read the right way
  round, and its envelopes beneath it in words; a subscription keeps its last 50 notifications and
  counts the others. A call's detail has five tabs: Overview, its failure whole; Payload, as a tree;
  Exchange, its envelopes as beads on its thread in SVG, a third lane for a destination behind a
  relay, a transfer's bytes against its credit; Diff, a notification against the one before it, an
  answer against its procedure's last; and Trace, the stack that made it, each frame opened in
  Sources. State rebuilds a client's session, calls in flight, subscriptions and their credit, and
  transfers at any moment a cursor stands on, replaying nothing; Timeline draws every call on one
  axis of time, and a span dragged across it bounds the list. The bar pauses (`Ctrl+E`), clears
  (`Ctrl+L`), keeps the log across a reload, exports the records as JSON, `bead-devtools-log`, and
  imports them back, and its Requests, Commands, Notifications and Failed buttons filter in one
  click; the keyboard moves through the calls, and a call's context menu copies its payloads or a
  snippet that makes it again by the page's own service manager. Metrics shows a row a procedure and
  its calls a second over the last minute, a procedure's name showing its calls alone; Wire names
  each procedure a client told, says a listen for a `POST` with no body, and copies an exchange as
  the skeleton of an entry of `spec/conversations.json`, a credential's own bytes zeroed. An empty
  panel says why and offers to reload the page.
- The extension's hook, while a panel watches, tells the panel more of each call: a failure whole —
  where it was raised, the relays it crossed, its destination, the call id its envelope named — the
  call's options whole, `destinationId` and `closeOnTimeout` among them, each payload as a tree of
  its preview's bounds beside its text, the stack that made each call made, and an envelope's time
  as the page's time origin and its monotonic reading since. The hook's protocol stays 1, and a page
  no panel inspects pays nothing.
- `requireCredential`, `RequireCredential`, a server's relay's admission by default (spec 14.3).
- `largestAddressConnections` among an HTTP server transport's gauges, under
  `maximumConnectionsPerAddress`, on both sides: the health check warns at 80% of it, so a proxy
  left off `trustedProxies` shows on `/health` before the first 503 (decision 0030).
- `isCredentialWithdrawn`, `IsCredentialWithdrawn`, on a client's router: whether its default
  credential stands withdrawn (spec 13.4).
- `spec/transports.json` plays the client's address behind the proxies a server names: the walk
  past two networks, a field from a socket no entry holds, an entry that is no address, a refusal
  told behind a proxy, and an entry's node forms held in one form (spec 15.12).

### Changed

- The spec moves to 0.4.0 (`spec-v0.4.0`), and its companion, `spec/debugging.md`, to 0.2.0
  (`debugging-v0.2.0`).
- A decision record's number names its decision for good and is never given to another: records
  are still regrouped, moved in the index and renamed between releases, but none is renumbered,
  and one merged into another keeps a short file naming its successor (`docs/decisions/README.md`,
  the `bead-release-documents` workflow).
- The documents are brought to 0.4.0: the records, the spec and its companion in form alone, the
  READMEs, the support matrix and `CLAUDE.md` state what holds and where Bead goes. What a `proto`
  payload is, protobuf's format with Bead's own rules and its bound of 100, which decision 0018 held
  beside the service layer, is a decision of its own, 0031; 0018 keeps the layer, and the index
  groups 0016, 0028 and 0031 under Payloads. No record is renumbered.
- A WebSocket server names each connection `type=WS;ip=…;port=…;ordinal=…`, by its peer's port and
  the rank it was taken at, so no two connections share a handle. On the TypeScript side,
  `generateHandle` takes `{ ip, ordinal, port, type }`, `port` optional, one
  `ITransportServerHandleInfo` in place of `ITransportServerClientHandleInfo` and
  `ITransportServerDrawnHandleInfo`; `generateDrawnHandle` goes, and the socket form of
  `TransportServerConnectionHandle` ends in its ordinal (decision 0025).
- `hosts`, `Hosts`, lists hosts without their port, taken besides `localhost`, the names under
  `.localhost` and IP literals, which every server takes; each is compared by its host, the
  request's port aside, so `bead.test` takes `bead.test:8443` and `bead.test:80`; `[]` takes those
  every server takes; `['*']` takes every host. An entry with a port, an empty one, one that is no
  host, or `*` beside another is refused as the transport is built (decision 0024).
- `origins`, `Origins`, is checked as the transport is built: each entry is an origin as RFC 6454
  serializes it; `*` and `null` are refused.
- A request names its host by its absolute-form target, then over HTTP/2 by its `:authority`, then by
  its `Host` (RFC 9112 §3.2.2, RFC 9113 §8.3.1), on both sides: the TypeScript side answered an
  absolute-form target 404 and read `host` before `:authority`; the C# side answered 400 a `Host`
  that differed from its absolute-form target. Such a target is read as it came, `http://` or
  `https://` in lower case and an authority, a userinfo or a colon with no port answered 400; the
  `Host` beside it is judged as one field line alone, which an HTTP/1.0 request may leave out.
- Both sides answer a host holding a percent-encoded octet, `*`, `+`, `,`, `;` or `=` in a name, an
  `IPvFuture` literal or a colon with no port 400 over HTTP/1.1 and with a stream reset over HTTP/2,
  as the C# side's server did: the TypeScript side took them.
- `spec.md` 15.1 states that a transport draws each connection's handle and gives none twice, 14.4
  follows it, 15.12 states a request's authority, a host's grammar and the hosts every server takes,
  and 15.13 goes: one point is open, section 8.3. `transports.json` adds nine cases, the hosts every
  server takes, a list adding to them, `[]`, `*` and an absolute-form target, over HTTP and at a
  WebSocket's address, and the forms a host is not to the 400 it answers; a step's request names
  its version and its target, absolute-form among them.
- The TypeScript side names a client that comes over IPv4 to a dual-stack listener by its IPv4
  address, in its handle and its address, as the C# side does.
- A server listens on `127.0.0.1` unless `start` is given an address, on both transports and both
  sides, where it listened on `0.0.0.0`; a container, or any server another machine reaches, says
  `0.0.0.0` or `::`. On its defaults a server is secure (spec 13.4). An address is an IP address
  written bare, by RFC 3986's grammar: a name, `[::1]`, `127.1` or `0` fails the start on both sides
  (spec 15.12; decision 0024).
- A request whose field holds a control character other than HTAB, or an octet past ASCII, is
  answered 400 unmarked on both sides, at both transports, before anything else of it is judged: the
  C# side took the first, the TypeScript side the second (spec 15.12; decision 0026). Over HTTP/2
  its stream is reset, but where Node's HTTP/2 parser drops a field holding a control character
  before the TypeScript side's transport reads it, and where Kestrel ends the session of an octet
  that is no UTF-8, both in one platform row of `docs/support.md`.
- A WebSocket client names the status and the reason of an upgrade refused, over `ws` and on the C#
  side; an HTTP client's connect names its reason. The global `WebSocket` reads nothing of a refused
  upgrade. On the TypeScript side, `IWebSocketLike.on` takes `unexpected-response`, `ws`'s, its
  response an `IUpgradeResponseLike`.
- The C# clients race the address families of a name, as RFC 8305 asks: a connect by `localhost` to
  a server on one family no longer waits two seconds on Windows.
- `spec.md` 15.1 states the refusal a server tells, 15.6 what a client names of one, 15.12 the octets
  a field holds, the address a server listens on and a client's port, and 13.4 judges a server by
  the address it listens on alone. `transports.json` gives every marked refusal what its server
  tells of it, `told`, its port `{port}`, which each runner fills with the port its step sent from,
  reads a head's characters as one octet each, and adds three cases: a listen held, answered the 404
  of its connection's close and told by none, and a field past visible ASCII, over HTTP and at a
  WebSocket's address.
- The conformance files cite the units they play and left uncited: 4.2 by the vectors of a kept
  bit, 5.1 by those that fail two checks, 5.2 by the header refusals whose detail says which check
  failed, 9.6 by the entries of the gate, 12.6 by the transfers placed out of order or delivered
  whole, 13.10.4, 14.5.3 and 17.2 by the entries that play them; `metrics.json` cites the rows of
  the companion's 7.2, 7.6, 8.1 and 11.3 its expositions write.
- `spec/conversations.json` pins the interop's failure details, fail's, ticks', denied's, logout's
  and register's, and each credit's `paced`, which its schema requires and `metrics.json`'s exits
  repeat; the generators take each interop code from the blueprint's catalogue, and `spec/check.py`
  holds each "code N" of `interop-service.json`'s prose to it; `interop-service.json`'s `verifiers`
  holds the ELSEWHERE verifier's verdicts and what `endSessionsOf` takes and refuses, which both
  sides' interop tests read; the runners play `stop`, pongs, reserved opcodes and an uncaptured
  `{name}` alike, and the C# codecs runner refuses an encoding it does not name.
- Every response on an HTTP server's path carries `Vary: Origin`, but HTTP's own 400.
- A preflight from an origin `origins` names, refused 405 `method-refused` and told, is answered;
  any other `OPTIONS` is still refused 405.
- On the TypeScript side, `IHTTPResponseLike` requires `setHeader`, which Node's responses have.
- `spec.md` 15.12 states the CORS answer, 15.6 a preflight in its order, its 204 and `vary: Origin`,
  and 15.12's fields rule HTTP's own 400 with none of the path's fields. `transports.json` adds four
  cases over HTTP, a listed origin's preflight and answers, a preflight judged before its origin,
  and an `OPTIONS` that is no preflight; its steps of HTTP's own 400 hold it to none of the path's
  fields, over HTTP and at a WebSocket's address, and an upgrade from a taken origin to none of
  CORS's.
- A listen over HTTP carries its cursor and its wait in the fields `bead-after` and `bead-wait`, at
  the connection's one URL, on both sides; a listen without `bead-after` is refused 400
  `malformed`, and no exchange's query is read. A page of another origin preflights its
  connection's opening, not every batch (spec 15.9; decision 0029).
- `bead-after`, `bead-wait`, `bead-listen` and `bead-sequence` are read as RFC 9651 Items, their
  parameters ignored.
- `spec.md` 15.9 states the listen's fields and their grammar, 15.8 `bead-listen` as an Item, 15.6's
  400 a listen without `bead-after`, and 15.12 a field value's ends and the preflight's
  `Access-Control-Allow-Headers`. `transports.json` writes every listen's counts in its fields and
  adds two cases over HTTP, a count in two field lines or as a list, and a listen without
  `bead-after` whatever its target holds; the case of a count that does not parse widens to RFC
  9651's grammar, its parameters ignored, and `bead-listen`'s case to a parameter.
- `spec.md` 13.8's key set is a clause of its own, 13.9, each of its rules an item, 13.9.1 to
  13.9.7, and 13.9 and 13.10 are 13.10 and 13.11; 15.2's order at a WebSocket's address is its
  items, 15.2.1 to 15.2.8, the stop's 503 the last. `conversations.json` and `transports.json` cite
  the item each entry plays, and name in their `$comment` both of the interop's files.
- A document's minor moves when an implementation that conforms to its last version must change to
  conform to this one (decision 0008); `spec.md` names the interop's blueprint and what its service
  does as files of its version; the companion moves by `spec.md`'s rule, under a version of its own;
  a blueprint matter of the interop's moves the spec's version, one of the builder alone the
  builder's (decision 0017).

- `--except <RULE>@<scope>` names a finding's subject of the rule's kind; a pointer is refused, and
  so is `--except WAIVER_UNUSED`. `SERVICE_SAME_HOOKS` finds once a hook, and `RESERVED_NO_DELETE`'s
  subject is the earlier's range, whatever part of it the current released.
- `generate` removes nothing unless `clean` is set; with it, a file of a kind beadc writes, read by
  its header in both targets, and prints each.
- Every C# file beadc writes opens with `#pragma warning disable CS0612, CS0618, BEAD0001`, and a
  TypeScript file that marks a declaration or names a deprecated message with `/* eslint-disable */`.
- The TypeScript side's service layer keeps each mapped member linked to its descriptor, so a
  deprecation reaches a notification, a command, a notifier, a resolver's key and a window.
- A `SERVICE_REVISION` reads a file's syntax, edition, features and `csharp_namespace`, and no other
  language's option.
- The blueprint schema holds `services[].proto.file` and `proto.messages[].file` to the path form of
  `proto.files[].path`.
- `init` takes buf's lower snake case alone, and writes `clean: true`.
- CI's `beadc breaking` step compares against the newest `vX.Y.Z` whose commit is not HEAD's, and
  fails on every warning; `tools/release.mjs tag` writes `ci.yml` without the waivers the release
  makes moot, and `prepare` on a hotfix without every waiver.
- `spec/codecs.proto` is edition 2023, and `Probe` gains a packed field, a repeated fixed32, a map
  and a delimited field, `counts`, `stamps`, `children` and `delimited`; a `proto` row's `read`
  gives each where it holds any, and how deep messages nest below it through each; `codecs.json`
  gains 20 `proto` payloads and excuses no side from a `proto` payload but
  `a string's leading U+FEFF`. Spec 17.9.3 counts a group and a map's entry as a message toward the
  depth bound.
- Generated code names `GENERATED_CODE_SUPPORTS_VERSION_3`, `GeneratedCode.SupportsVersion3`, and
  its `proto` codec checks a payload's records before its library reads them; a C# project that
  binds `proto` references `Bead.Protobuf`. The runtimes no longer carry version 2, so code
  generated before 0.4.0 must be regenerated.
- A client transport calls each listener of its `reconnect`, `Reconnect` on the C# side, within its
  guard, on both sides: a throw is reported through its `error`, the next listener is told and the
  reconnection goes on; `spec.md` 15.1 names a reconnection among the events it guards (decision
  0023).
- A server's transport, as the server gives it, carries `error` and `refusal` alike, so an
  application hears both through `server.transport`, `server.Transport`, whichever transport it
  built: `IServerTransportLike` gains `error` and `refusal`, and `IServerTransport` gains `Error`.
- A router tells its service manager the failure it answered a request with in its resolver's
  place: `IRouterLike` gains `answeredOf`, `AnsweredOf` on the C# side, which a router of the
  application's own implements (decision 0013).
- The DevTools panel shows a call a row, its envelopes beneath it, and Envelopes is a mode of
  Calls; a filter refused keeps the last that held, as debugging 6.9 keeps one given in place, the
  field marked and its reason said; a selection the filter or the client hides is let go with a
  word; the page's state stays apart from the records let go; and below 720 pixels the panel folds
  its detail under its list.
- The DevTools extension holds what every browser shares — the hook, the panel and its model, the
  wire's and the registry's readers, the messages — apart from Chrome's glue, in
  `implementations/typescript/devtools/chrome/`: its manifest, its bridge, its background, its
  DevTools page, and the panel's host made of Chrome's API.
- `requireSessionOrCredential`, `RequireSessionOrCredential`, is `shareLegBSession`,
  `ShareLegBSession`, named for what it lends: leg B's session, to every session of leg A's, at
  every destination. `spec/conversations.json`'s relay conversations that log in at the relay and present
  none through it name it, and its schema's `beforeRoute` is `requireCredential`, `shareLegBSession`
  or `requireSession`; the transports' relay cases present a `JWT`.
- **Breaking:** a call that needs no identity, and the call that renews a withdrawn default, present
  none, `{ scheme: NONE }`, `Credential.None`: once the default is withdrawn, one that gives no
  credential of its own fails before it goes, where it went out without one.
- `spec.md` 15.2 and 15.5 state that a client writes no `Origin`, a page's browser writing its own,
  as both sides' clients already do; a client of another library that writes its target as its
  `Origin` is refused under `hosts: ['*']` by a name `hosts` does not list (decision 0024).

### Removed

- `spec/uncited.txt`, `spec/debugging-uncited.txt` and `--write-uncited`, which the ledgers replace.
- `GENERATED_CODE_SUPPORTS_VERSION_2` and `GeneratedCode.SupportsVersion2`: the runtime no longer
  serves code generated before 0.4.0, which reads a `proto` payload unchecked (decision 0028).
- `isProxyTrusted`, `IsProxyTrusted`, which `trustedProxies` replaces; the loopback is trusted only
  when listed.

### Fixed

- Over HTTP/2, a request whose field value starts or ends with a space or a tab is malformed on both
  sides, its stream reset `PROTOCOL_ERROR` (RFC 9113 §8.2.1); the C# side took it and read the
  value padded.
- On the C# side, HTTP's own 400 at an HTTP server's path carries no `Cache-Control` nor
  `X-Content-Type-Options`, as the TypeScript side's, Node's and Kestrel's own never did.
- A `.proto` message marked `deprecated` no longer fails a C# consumer's build through beadc's file,
  nor a TypeScript consumer's lint.
- beadc makes its temporary folders, `breaking`'s and protoc's, under the project's `.beadc/` where a
  `beadc.yaml` is read, which `init`'s `.gitignore` and the repository's ignore.
- An earlier's root that holds no `.proto` is refused, named as its `beadc.yaml` names it, `git
archive` writing a submodule as an empty folder.
- An archive's pax `size` overrides its ustar size, as GNU tar and bsdtar read it; an empty or NUL
  path, and an entry over an earlier one, are refused.
- buf's finding on a deleted file is placed at the earlier's path, and a `buf:` waiver is held to the
  rules its category runs.
- `check` reads an extension's field, of a file or a message, nested or not, and names a map's field
  by its own name; a blueprint with no service, or a service with no procedure, is said in its words.
- A file-system error is one line, exit 2; a write makes its folder, and one that fails leaves no
  `.tmp` behind.
- `--against-ref`, given to beadc on Node, is refused, naming the pipe that does its work.
- `init` names the cause of a file Windows PowerShell's `>` wrote, and the README labels its pwsh
  block.
- `spec.md` states what was left to a reader: a listener's return and its `error` listener are their
  platform's (15.1, decision 0023); a server's stop (15.1, 15.3); the 503 of an upgrade once a stop
  began closes its connection and is told, as the other refusals at a WebSocket's address (15.2); a
  client may wait what a `Retry-After` asks, which Bead's own clients do not read (15.7); what the
  HTTP connection's token is worth in the clear, TLS off the machine being the deployment's (15.4,
  decision 0020); the side sending a result's transfer reports its stall (12.7); BCP 14's key words,
  verbatim, and "is never" for what "may not" forbade; the core rules of RFC 5234 in every grammar,
  the filter's terminals Unicode scalar values; 9.10 beside 9.4 in 15.1, and records 0022 and 0026
  in the index.
- `debugging.md` 8.1 names where its families part from OpenTelemetry's RPC conventions, and the
  shape their `_handled_total` families take; each of its references to a unit of `spec.md` names
  it.
- The C# exposition reads each series' counts once, its handled before its started, and writes the
  series' lines from that reading, so its `_count` is the sum of its handled counts and its started
  never below them at every exposition; `debugging.md` 8.5 and 11.2 state each series at one
  reading, and across series each at its own instant (decision 0013).
- The trace tells the failure a router answered in the resolver's place: a `tx` step whose request
  its router already answered, its subscription's queue past its bounds, carries the
  `CAPACITY_EXCEEDED` it answered, where it told an answer with no error (`debugging.md` 4.2;
  decision 0013).
- A registry counts a service declared at a second revision into its series, where it refused it:
  `spec.md` 16.7's MUST holds one name an address and one address a name, its SHOULD one revision a
  service, and `debugging.md` 7.3 no longer refuses `another revision of its service`, its
  `past the ceiling` now 7.3.3. `metrics.json` plays a service at three revisions on three routers,
  and its schema drops the reason (decision 0017).

### Security

- A server takes, besides the hosts it lists, only `localhost`, the names under `.localhost` and IP
  literals, over HTTP and at a WebSocket's address, on both sides. A page that rebinds its name to a
  server's address is refused 403 `host-refused`, as is a request that names no host. A server
  reached by a name, a public one, one behind a proxy that keeps the `Host`, or a service reached by
  its in-cluster name, now names it in `hosts`, or refuses it. The refusal is told on the wire, by
  every client that can read it, and by the server's `refusal` event; a page's WebSocket sees only
  its close.
- A server is no longer reachable from the network by default: it listens on the loopback.
- A WebSocket server no longer takes two sockets from one address and port, to two of its addresses,
  as one connection: each is its own, in its own session, and a stop closes both, 1001.
- No HTTP answer carries `Access-Control-Allow-Credentials`, so no cookie goes across origins, and a
  page of an origin no `origins` names reads nothing. A page of the public network reaching a server
  on the loopback or a private address needs, besides, the permission its browser asks of its user.
- A server's relay admits by default only a credential it forwards, `requireCredential`,
  `RequireCredential`: a call presenting none or `OPAQUE` is refused `ACCESS_DENIED`, its detail
  naming the default, where any requester in a session at the relay ran at the destination in leg
  B's session. A relay whose requesters log in at it gives a `beforeRoute` that checks the
  destination against the requester's session (spec 14.3, 14.7; decision 0019).
- `origins`, `Origins`, refuses `null` as the transport is built, as it refuses `*`: a browser sends
  it for every page that has no origin of its own, a sandboxed frame of any site among them, which
  naming it let drive the server and read every answer (spec 15.12; decisions 0024, 0027).
- An HTTP server believes `X-Forwarded-For` from the proxies it is told of alone, `trustedProxies`,
  `TrustedProxies`, each an address or a network (RFC 4632, RFC 4291), refused as built otherwise, a
  network of prefix 0 among them, the field walked from the right past each of them, each entry read
  in RFC 7239's node forms and held in one form; a proxy off the loopback, a container's or an
  ingress, was ignored under `isProxyTrusted`, every client behind it one address, refused 503 past
  64 (spec 15.12; decision 0030).
- Under `hosts: ['*']`, a server's own origin is no longer its request's authority: a page that
  rebinds its name to the server's address, which `*` takes, was its own origin by that same `Host`,
  and is now refused 403 `origin-refused`; a page of the application's own under `*` names its host
  in `hosts` or its origin in `origins` (spec 15.2, 15.12; decision 0024).
- A client whose default credential was withdrawn fails before it goes each call that would present
  it, `SESSION_REQUIRED`, until its application gives one again, or none, where it presented none
  and ran in its connection's session, or in none, in silence; a call that gives its own credential,
  or none, goes (spec 13.4; decision 0010).

## [0.3.0] - 2026-10-12

### Added

- `.claude/workflows/`: three workflows launched by name, a round of the Tenth Man, an implementation
  on both sides with its integration and a commit plan, and an adversarial review by lens.
- `tools/check-format.mjs`, the root's files in the layout the TypeScript side's formatter gives
  them, `beadc.yaml` among them: CI runs it, and the pre-commit hook over the staged files.
- `spec/interop-blueprint.json`, the interop service's API in the builder's format,
  `bead-blueprint/1`, under `spec/schemas/bead-blueprint.schema.json`: its service's id and
  revision, and each procedure's id, kind, bindings, admission and failures. `spec/check.py` holds
  it to its schema and its form, its members and its arrays in their order, and
  `interop-service.json` to its procedures; `--write-blueprints` lays it out (decision 0022).
- `builder/`, the builder `beadc`, on Node with a toolchain of its own: `bead/options.proto`,
  whose extensions take 58500 until their first publication takes a number of protobuf's global
  registry; a front end that compiles a `.proto` with buf and resolves it into a blueprint;
  `beadc check`, which refuses a `.proto` or a blueprint by rule name, section 16's identities
  among its rules; `beadc blueprint`, which writes a blueprint in its form and, with `--check`,
  holds one to it; `beadc version`. The interop's `.proto` is its fixture, whose blueprint is
  `spec/interop-blueprint.json` byte for byte; CI's `builder` job runs its tests on Linux and on
  Windows (decision 0022).
- `beadc generate`, the TypeScript target: from a blueprint, a `<name>_bead.ts` for each service,
  its descriptors, its catalogue, a server class where only resolvers are written, a client class
  holding a requester of each procedure by its name, and the types of its hooks and its windows,
  `<Name>Admissions` and `<Name>Windows`, over the service layer of
  `@francisdesjardins/bead/service`, with protoc-gen-es's messages where a binding is `proto`;
  `--check` writes nothing and fails on a difference (decision 0022).
- `beadc generate`'s C# target: from a blueprint, a `<Name>Bead.cs` for each service, its
  descriptors, its catalogue and a class of failures for each procedure that lists any, the records
  of its hooks and its windows, `<Name>Admissions` and `<Name>Windows`, a server class where only
  resolvers are written and a client class holding a requester of each procedure by its name, over
  the service layer of Bead.Core, every type qualified; protoc's C# messages from buf's set where a
  binding is `proto`, each file in its namespace's folder, protoc held to one pin,
  `builder/protoc.json`, which `builder/tools/fetch-protoc.mjs` fetches by its sha256 (decision
  0022).
- `generate` refuses two files it would write at one path, and leaves alone the files of a build's
  and a package manager's folders.
- `DESCRIPTION_TARGET`: `beadc check` refuses a description holding a character no XML
  documentation comment holds.
- `NAME_TARGET` refuses a procedure named `code`, a hook and a failure named as the C# class they
  sit in, and, on a `.proto`, a class a message or an enum of its C# namespace holds.
- The root's `beadc.yaml` generates each side's interop; CI's `builder` job holds both to it.
- `beadc wrapper` and `beadc init`: `init` writes a project, its `beadc.yaml`, a `.proto`,
  `buf.yaml`, the editor's copy of the options and the wrappers `beadc.sh` and `beadc.ps1`, which
  `wrapper` prints; the two wrappers run beadc's image as the caller, without a network, read-only,
  making one engine call from the arguments as each shell hands them (decision 0022).
- beadc's image, `builder/Dockerfile`: Node, beadc, buf, protoc-gen-es, protoc at its pin, the
  files of `spec/` it reads and the licence texts of what it adds, its tests run on the image
  itself; CI builds it on amd64 and arm64 and runs the wrappers against it (decision 0022).
- `examples/hello`, a project written as a consumer writes one: a `.proto` of `proto` messages, a
  procedure that notifies at a window of 1, a command, a catalogue and a hook, generated by beadc
  into a TypeScript and a C# half, each built with its messages beadc's or its own build's; CI's
  `examples` job plays each client against each server (decision 0022).
- A release moves an example's versions: its C# lock file's project range, held by
  `tools/check-versions.mjs`, the image its wrappers name and its blueprint's `specVersion`, which
  CI's `examples` job holds to beadc (decision 0008).
- `Error` on the C# side's `HttpTransportServer` and `HttpTransportClient`, as their WebSocket
  siblings have it.
- `beadc breaking`: a project held to its last release by id, in two categories, `WIRE` within
  `API`, the default: 20 rules of Bead's over the two blueprints, `SERVICE_SAME_HOOKS`,
  `NAME_NO_DELETE` and `SERVICE_REVISION` among them, `API` holding a service or a procedure gone
  even where `WIRE` passes it, deprecated, then its id reserved; and buf's over the messages of two
  buf images, each finding `buf:`-prefixed, its rules keyed by a service's or an rpc's name excepted;
  `--against` a folder, its committed blueprint read for Bead's rules, `-` for a tar on standard
  input, or a blueprint, `PROTO_SKIPPED` where a `.proto` side goes uncompared; `--except` waives a
  finding by its rule, scoped to its pointer or file. The wrappers' `--against-ref <ref>` pipes the
  project's `git archive` at that ref into the run. CI holds the interop's blueprint and
  `examples/hello` against the last release that carries a blueprint, from 0.3.0 (decisions 0017
  and 0022).
- The builder's `type-check` compiles the TypeScript goldens against `@bufbuild/protobuf` 2.13.0,
  the floor their header names, installed beside the pin as an npm alias that `version.test.ts`
  holds to `PROTOBUF_FLOOR`.
- `spec/conversations.json`: a name that holds an escape is read as its escapes say, whatever a
  payload of its shape read on another connection held.
- `spec/codecs.json`: protobuf's own refusals of a tag past 32 bits or of more than 5 bytes, of a
  length past 32 bits, of an unknown varint of 11 bytes and of a record past the end of its
  message; the support matrix states where protobuf-es, and where Google.Protobuf, reads what
  protobuf refuses.

### Changed

- The spec moves to 0.3.0 (`spec-v0.3.0`); its companion, `spec/debugging.md`, stays at 0.1.0.
- `spec/interop-service.json` states each procedure by its name alone, in the blueprint's order:
  the generators and both sides' interop read each procedure's ids and kind in the blueprint.
- `tools/release.mjs prepare` moves the version of every conformance file that repeats one, as
  `tools/check-versions.mjs` finds them, the interop's blueprint among them.
- The C# interop's `logout` refuses a call in a credential's session with the TypeScript side's
  detail, "a call in a credential's session ends no connection's session", which the interop
  holds both ways.
- `tools/check-versions.mjs` holds the builder's `package.json`, where the tree has one, at the
  product's version, and `tools/release.mjs prepare` moves it with the product's (decision 0008).
- The TypeScript side's interop is generated from `spec/interop-blueprint.json`:
  `interop/generated/interop_bead.ts`; its resolvers are written in `interop/handlers.ts` and its
  credentials in `interop/credentials.ts`, and `interop/offer.ts` is gone. Its lint refuses a service
  manager's accessor there.
- `tools/release.mjs prepare` moves the generated code's header to the release's versions.
- The service layer's options are typed by the service on both sides. The C# side's
  `ServiceServerOptions<TService>` takes the service's hooks as a record of one required member a
  hook, `IServiceAdmissions<TService>`, and `ServiceClientOptions<TService>` the windows of its
  procedures that notify as a record, `IServiceWindows<TService>`, in place of the records keyed by
  name: a hook left out does not compile, and a service written without beadc writes its records.
  `ServiceServer` takes its options in a constructor of their own, beside one that takes none. A
  hook that is no hook is refused on both sides. A client side takes its Bead client apart from its
  options, `createServiceClient(procedures, client, options)` and
  `new ServiceClient<TService>(procedures, client, options)`, the TypeScript side naming its options
  `IServiceClientOptions<S>` (decision 0018).
- The contract with generated code is at 2, `GENERATED_CODE_SUPPORTS_VERSION_2` and
  `GeneratedCode.SupportsVersion2`: generated code takes the layer's options typed by the service
  (decision 0018).
- The C# side's interop is generated from `spec/interop-blueprint.json`:
  `interop/Bead.Interop/Generated/InteropBead.cs`; its resolvers are written in
  `InteropHandlers.cs` and its credentials in `InteropCredentials.cs`, and `InteropService.cs` is
  gone. The banned-API analyzer refuses the service manager there, and `dotnet format` leaves the
  generated folders out.
- `spec.md` 15.1 calls each listener of a transport within a guard and reports what it throws;
  15.2, 15.3, 15.6 and 15.7 state what a stop answers what arrives as it runs.
- Spec 16.8 and 16.9: `beadc breaking` holds ids and names for life against the last release,
  and refuses a revision lowered, or left where the contract moved.
- `tools/release.mjs prepare` lists, among what it owes by hand, each `--except` of CI's
  `beadc breaking` step and each of decision 0006's gates owed that names the version it prepares.
- `spec.md` 15.6 gives the order in which a server judges a request at its path, the stop placed
  in it, and `spec/transports.json` plays it with two faults in one request; 15.7 answers the 404
  an exchange it would look up by a well-formed token; 15.5 refuses two `Authorization` fields on
  a `POST` that presents a token, a connect's being read by no one.
- `spec.md` 15.13 states two points open in this version: a server takes every host when `hosts`
  is not given, so a server a browser can reach names its hosts; and a WebSocket server can take
  two sockets from one address and port as one connection.

### Removed

- `spec/interop-service.json`'s `serviceId`, `serviceRevision`, `procedureId` and `offeredBy`: the
  interop's ids, revision and kinds are `spec/interop-blueprint.json`'s.
- `GENERATED_CODE_SUPPORTS_VERSION_1` and `GeneratedCode.SupportsVersion1`: the runtime no longer
  serves contract 1's code (decision 0018).

### Fixed

- The TypeScript side compiles under a consumer's `strict` without `exactOptionalPropertyTypes`:
  the WebSocket client's heartbeat guards the methods it calls by their value, which narrows them
  under either setting, where TS2722 refused its call.
- A catalogue's `is` narrows to `IListedFailureError<Name>`, the failure of that name, so a false
  answer leaves a `FailureError` one, to be asked of another name, where it narrowed it to `never`.
- beadc's refusal of a protoc missing or off its pin names the fix to whoever runs it, in a clone
  or not: protoc's release at the pin and `BEADC_PROTOC`, or beadc's image, and no path of the
  repository's.
- A release finishes with `--keepremote`, its branch kept on origin, and the one push `tag` prints
  deletes it, so nothing reaches origin before that push.
- A listener of a transport's events that throws changes nothing the transport does, on both
  implementations, server and client: the listeners after it are told, its connection is drawn,
  its message handed on, its close done, and its throw is reported through the transport's
  `error` with the connection. A throw no longer ends the Node process, nor answers 500 over the
  router's answer on the C# side.
- A stop over HTTP draws no connection and holds none from its start: a connect is refused 503
  `busy` with its `Retry-After`, and an exchange with a token is answered 404
  `connection-unknown`, as the stop answers each listen it holds.
- A WebSocket server refuses an upgrade its stop crossed 503 `busy` with its `Retry-After`,
  marked, on both implementations, where the TypeScript side left it unanswered and the C# side
  answered it bare, and closes going away a connection that registers as it stops.
- The C# side's server awaits its router's teardown as it disposes, and stops its transport even
  when that teardown throws; a server counts no close under way once disposed, on both
  implementations. The C# side's WebSocket connection settles its write pump and a close under way
  once the connection ends, its read begun or not, and observes the close it sends a message too
  big.
- The TypeScript side's HTTP server reads a `Content-Length` as the number its digits write: a
  connect or a listen whose length is `00` has no body, as RFC 9110 §8.6 reads it, where it was
  refused 400.
- The TypeScript side reads a JSON member name that holds an escape as its escapes say, in a
  payload and in a token's header and claims, where V8's `JSON.parse` could read it as the name
  of an earlier object of the same shape: a payload one connection sent changed how another's
  read, and a header's `crit` written with an escape could go unseen.

## [0.2.0] - 2026-10-07

### Added

- Badges in the README: CI on `main`, and the license.
- The conformance files' steps for time (decision 0011): `advance`, which steps the clock a side is
  given from due to due, `until` a timer armed on it, `wall`, which moves the wall clock alone, and
  each file's `wallClock`, where it starts; `spec/check.py` refuses an `advance` that no timer armed
  precedes.
- `specVersion` in each conformance file, repeating the version `spec/spec.md` states, and when it
  moves, in decision 0008.
- JSON Schemas for the conformance files, in `spec/schemas/`.
- `spec/check.py`, which the `spec` job runs after the regeneration, from dependencies locked with
  every hash in `spec/requirements.txt`: every file under its schema and every schema with its file,
  no key twice, one version across the spec and its files, one name to a vector or a conversation
  in its group, every group of vectors named by a section of the spec, which names no other, and a
  report of the groups each side's tests read, which fails on one a side does not.
- The units of `spec/spec.md` each vector and conversation checks, cited in its `clauses`: a clause,
  an item of its numbered list, a row of its table. `spec/uncited.txt` lists the units none cites,
  and `spec/check.py` fails when that list and the files disagree.
- Relays in the conversations, for section 14, across the connections a conversation opens, each
  step naming its own. The interop service's `register` and `unregister` register a caller's
  connection as a destination on the wire, and `interop-service.json` states what its relay admits.
- `spec/transports.json`, its schema and its generator: what a server of the interop service does at
  its HTTP transport's edge, which each side's tests play against their own server with a peer that
  writes HTTP/1.1 in exact octets, the bounds' defaults each side checks, and responses cut across
  reads that each side's reader reads alike; and a relay's leg B on a real transport: a destination
  over HTTP that does not listen, answered `DESTINATION_UNREACHABLE`, a request past its
  destination's outbox and a WebSocket that closes as leg B goes, each answered `DESTINATION_LOST`,
  since section 15.9 says that an envelope past an outbox is one its transport had.
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
  `HMACSHA256`, and play the group, its audience one or a set. A string a claim holds is of
  well-formed Unicode: an `aud`, a `sid` or a `sub` that holds a surrogate alone is no string, and
  an `aud` array holding one no array of strings, refused at its step on both sides.
- `spec/check.py` refuses a published test key outside `spec/`, the tests and the interop service:
  its parameters, or its thumbprint (RFC 7638), in any file git lists.
- A transport carries a credential beside an envelope, both ways, as one argument: on the TypeScript
  side, the message event's first argument and `send`'s are `{ data, credential }`; on the C# side,
  `TransportMessage` has its `Credential`. Over HTTP it is the `Authorization` field of the
  `POST /bead` that carries a request, as it came, its surrounding whitespace removed: an empty one
  carries none, and a `POST /bead` with two is refused 400, `malformed`. A router hands its resolver
  what a request's transport carried for an `ELSEWHERE` alone, on both sides: what came beside any
  other stays at the router (spec 14.2).
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
  go, a token without a `kid` waits on its issuer's keys while none serve, keys of one issuer and
  one material, by their RFC 7638 thumbprint, count as one key, the first in the order searched, so
  a key set that answers again a key the application gave refuses none of the tokens that name it by
  its `kid`, nor one without a `kid` when it answers no other key of that issuer, and at most
  `maximumWaitingCalls`, `MaximumWaitingCalls`, 64 by default, wait for an issuer's deadline at
  once, one past them refused `CAPACITY_EXCEEDED`, which section 8.2 says, as it says a requester's
  call with no call id free; and an `ELSEWHERE`'s verifier, `verify`, `Verify`, given what the
  transport carried and the call's signal. A side given a `JWT`'s keys holds its limits to 1,024
  bytes at least (section 12.2), and keys or a key set given without an audience are refused as the
  side is built. A `JWT`'s verdict reads the wall clock once its signature has verified.
- A client's credential, `credential`, `Credential`, by default and per call: `NONE`, `OPAQUE`, a
  `JWT` or an `ELSEWHERE`. A default withdrawn once a call that presented it is refused
  `SESSION_REQUIRED`, while it is still, by value, the credential that call presented, tells its
  application, `credentialWithdrawn`, `CredentialWithdrawn`; a failure that ends a subscription its
  server had answered withdraws nothing, over HTTP even when it overtakes that answer in a listen's
  batch, which the failure says, `mayOvertake`, `MayOvertake`; a call presenting an `ELSEWHERE` over
  a transport that carries none, or a bearer credential in the clear off the machine, fails before
  it goes, `DESTINATION_UNREACHABLE`, as does a server's command over HTTP; a call that asks for
  `OPAQUE` while its client knows no session fails before it goes, `SESSION_REQUIRED`, and withdraws
  nothing. Section 13.4 names the IPv6 loopback as a URL writes it, `[::1]`, and takes a `localhost`
  name on the loopback without resolving it, as Secure Contexts does; both sides read a loopback
  host by the WHATWG URL Standard's host parser, so `127.0.0.1.` is on the loopback, and a host
  followed by a space is not. A transport says whether it carries a credential and whether it is
  secure, `carriesCredential` and `isSecure`, on both sides, and a server's transport may be told
  what stands in front of it, `secure`, `Secure`: TLS terminated before it, or a proxy in the clear.
- A relay forwards a credential, and its destination verifies it (section 14): its default
  admission is `requireSessionOrCredential`, `RequireSessionOrCredential`, and an admission never
  answers `SESSION_REQUIRED` to a call that presented a credential, but `ACCESS_DENIED`, so its
  client keeps a credential that may hold; a destination is
  registered with the audience it verifies; `verifies`, `Verifies`, has the relay verify what it
  forwards against its destinations' audiences; a `JWT` crosses with its same bytes to a destination
  of its audience, an `ELSEWHERE` moves to leg B's transport, and a call the relay cannot so forward
  is refused `DESTINATION_UNREACHABLE` at a step of its own, 14.3's fifth; leg B's header counts its
  credential, at the sixth; a `JWT` and an `ELSEWHERE` a relay forwards without verifying resolve to
  no session in a later turn, as section 9.2's do: a call presenting none that came after one may be
  taken first. A `JWT`, and an `ELSEWHERE` its transport carried, pass the default admission of a
  relay that does not verify on their scheme alone, and learn which destinations exist; a
  conversation plays the `ELSEWHERE`.
- The interop service verifies a `JWT` under two issuers' published test keys and a key set's third,
  and an `ELSEWHERE` of its own auth-scheme, `Interop`; `endSession` ends a credential's session by
  its identifier, and `endSessionsOf` an issuer's, `register` takes the audience its destination
  verifies, and `ticks` and `tick` hold per session. The vectors, the conversations and the
  transports' cases this release plays are counted in `docs/support.md`.
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
  the transports' file come from one module of the generators. Section 1.4 refuses a value that is
  no number, and says what a delay is: a wait before an act — a pause, a reconnection's wait, the
  `wait` a client's listens ask — never without end; section 15.12 says that a client times its own
  inactivity by `inactivityTimeout`, 5 minutes by default, which section 15.10 names; section 15.9
  reads a listen's `after` and `wait` as counts, 0 when left out, one to fifteen ASCII digits
  otherwise; section 1 names its file. The support matrix gains three rows — a duration finer than
  a tick and a duration that is not a number, platform, and a reconnection's delay given as a
  number, open — and the rows of -1 ms and of the Web Worker name what of the file crosses them.
- `spec/debugging.md`, the spec's companion (decision 0013), at version 0.1.0 of its own: what a
  side traces, filters and counts beside the wire, which a constrained profile may leave out and
  still conform to the wire. It states the trace of calls and of envelopes, each step of a call
  naming its call, and an answer that did not go told with why beside it, a step's payloads the
  call's own, which no listener changes; a listener's error, which never changes a call; the cost
  while nobody listens, and two build switches; the debug filter's grammar in ABNF, in ASCII alone,
  and its refusals by reason, a filter given as a function that gives none keeping every event, and
  none of its failures reported; and a registry of metrics, its declarations, each refused for the
  first reason that applies, its ceiling, nine families under OpenTelemetry's RPC names, `bead` for
  `rpc`, every series made at 0, a subscription dropped counted at either end under the code of the
  failure that ended it, whatever its code, as spec 11.7 lets an application end one with the
  failure it chooses, the router's gates and every exit of a call, A66's buckets in whole
  microseconds with each `le` OpenMetrics' canonical number, and its exposition's bytes in the
  Prometheus text format 0.0.4. It names spec sections 16 and 17 where it reads a name: no procedure
  is named `_OTHER`, and every procedure's name is a pattern a debug filter reads. A side that
  carries the protocol whole is one built with neither of its two switches, which a constrained
  profile uses to leave out what it does not build, and a listener is synchronous. Sections 6 to 12
  name the file that checks each, and the support matrix the twin tests that hold what a test can of
  sections 1 to 5. `spec/spec.md` says where it stands beside it, and decision 0008's spec axis
  carries its version, which moves as the spec's does, a release whose companion moved tagging
  `debugging-v` and that version.
- `spec/debug-filters.json` and `spec/metrics.json`, their schemas and their generators, each
  repeating the companion's version as its `debuggingVersion`: 52 filters, what each reads as and
  keeps of fixed calls and envelopes, or its refusal's reason and what it names, and 6 filters given
  as functions, event by event, an entry naming a character holding it, which its generator checks,
  writing every character outside ASCII as its escape; 24 expositions, a registry's text byte for
  byte, and 50 exits, the interop service's conversations played by a server given a registry, a
  `counted` step listing the series each step moved. `spec/check.py` holds the companion's version,
  its units, which `spec/debugging-uncited.txt` lists where none cites them, and the lines naming
  its files; reads each exposition as 0.0.4, its families, its help and its buckets the companion's,
  each `_count` the sum of its handled counts, none started below handled; and requires each side's
  tests to read both files. The `spec` job regenerates them.
- A metrics registry on each side (decision 0013), `createMetricsRegistry` and `MetricsRegistry`,
  which a router given it as its `metricsRegistry`, `MetricsRegistry`, counts into at its gates, and
  which every client and server passes on to the router it builds; one given to two routers sums
  them. It counts what its side declares, each series made at 0 as its procedure is declared: a
  resolver as it is registered, a notification as it is registered, and a requester as it is made,
  through its router's `declareRequester`, `DeclareRequester`, whose series each of its calls
  carries to its router's request as `series`, `Series`. A declaration of an address the registry
  holds under another name, of a name its service holds at another address, its ASCII letters
  compared in either case as section 16 compares names, of its service at another revision than the
  one it holds, `another revision of its service`, or past `maximumProcedures`,
  `MaximumProcedures`, 1,000 by default, is refused as it is made, a `ProgrammerError` and an
  `ArgumentException`; `spec/metrics.json` pins each refusal, and the TypeScript side's
  `DeclaredProcedure` carries `serviceRevision`. Its exposition, `exposition()` and `Exposition()`,
  writes its nine families in the Prometheus text format 0.0.4 and gives its media type with it,
  `{ contentType, text }` and `MetricsExposition(ContentType, Text)`, for an application to serve at
  `/metrics` or append to its own 0.0.4 scrape: Bead opens no port.
- A page's DevTools hook (decision 0015): a client built in a page announces itself to the hook a
  DevTools extension defines under `Symbol.for('@francisdesjardins/bead/devtools-hook')`,
  `DEVTOOLS_HOOK_KEY`, handing it a source of protocol 1 — its `debug` events while the extension
  watches, and its registry's exposition, never the client or its credential — and attaches nothing
  until it is watched; `devtools: false` among a client's options refuses. A hook that is none, or
  whose read or whose `register` throws, is ignored, the client built all the same.
- The DevTools extension, Chrome's first, in `implementations/typescript/devtools/` (decision
  0015): `yarn devtools:build` builds it unpacked, and a Bead panel shows the calls, each by its
  call id and its connection, and envelopes of each client the page announced, filtered by client
  and by the package's own filter, what their registries count, and, for a page with no hook, the
  HTTP transport's exchanges the Network panel saw, read with the package's codec.
  `yarn test:devtools` tests it in Chromium, and CI runs it.
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
  within a service, and a revision counting its contract's releases, as SHOULDs the builder's
  `beadc breaking` is to hold, a gate decision 0006 owes. `spec/identities.json`, its schema and its
  generator, `make_identities.py`, pin what a router refuses with no memory: 31 names and 28 ids and
  revisions, each declared every way a side declares, and 8 folds. Both sides play it,
  `identities.test.ts` and `IdentitiesTests`, the C# side excused from the 17 inputs no `ushort` or
  `int` holds, a platform row of the support matrix, "An id or a revision no C# type holds".
  `common.schema.json` gains the ids, the revision and the name, which `interop-service.schema.json`
  takes.
- Spec section 17, payloads (decision 0016): `raw`, its bytes; `text`, UTF-8 read strictly, its
  leading U+FEFF kept; `json`, one JSON text in UTF-8 read as I-JSON (RFC 7493), a noncharacter
  taken, nested 64 deep at most, each number the double nearest it, one of magnitude 2⁻¹⁰⁷⁵ or less,
  half the smallest positive double, read as 0, and written in the canonical form of the JSON
  Canonicalization Scheme (RFC 8785): one value, one sequence of bytes, from every language.
  `spec/codecs.json`, its schema and its generator, `make_codecs.py`, pin payloads read and values
  written, RFC 8785's Appendix B among them: the bytes written back, or refused and why. Both sides
  play it, `codecs.test.ts` and `CodecsTests`, through each runtime's codecs,
  `router/shared/payloads.ts` and `Bead.Core`'s `Payloads`, which the interop's serializers delegate
  to, and which the service layer makes public. A platform row of the support matrix, "A value a
  side's type cannot hold", excuses the TypeScript side from an object naming a member twice and the
  C# side from `NaN` and `Infinity`. Eight conversations play it over the wire, a payload echoed in
  its own characters, one echoed in its canonical form, and six answered `PAYLOAD_UNDECODABLE`. The
  interop gains a case each way, a value outside ASCII, its members in another order, echoed equal.
- `spec/check.py` holds both new files: each under its schema, a name once in its group, every unit
  an entry cites one of the spec's, a `differs` naming a row of the support matrix that names the
  file and the entry, the `_Identities:` and `_Codecs:` lines naming files of `spec/`, and each
  side's tests reading both. The `spec` job regenerates them.
- Spec 8.3, an open point of this version: nothing bounds the calls a peer holds open over a
  WebSocket or a Web Worker; the support matrix gives it a row.

- Decision 0021: a topic-based publish/subscribe broker is one more transport, and Bead is never a
  network of its own. It routes nothing past one relay and shares no session's state between
  servers; a broker's transport is one core in each implementation and one adapter a broker, and
  what it owes is decided with it.
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
- `bead/options-last`, the TypeScript side's oxlint JS plugin, `tools/oxlint-plugin.mjs`, at `error`:
  past `max-params`'s count, it judges what a third parameter may be, the elements of a rest tuple,
  a type's signatures and an event's values, and lists each exception of today with its reason;
  `yarn check` holds it to its cases.
- Each step of the trace of calls names its call, `callId` and `connectionHandle`, on both sides
  (decision 0013): a call made once its router drew its id; a call refused before, and a
  notification, name none. A router's `request` takes an `onCallId`.
- `tools/release.mjs`, which moves every version in a release commit, the C# lock files' project
  ranges included, dates the CHANGELOG, and tags the spec and its companion beside the product
  after the finish; and `tools/check-versions.mjs`, in CI's `commits` job, which holds that every
  version agrees with itself, that a released section of the CHANGELOG stays as shipped, and that a
  release moves each version its changes owe, dates its section, and tags its documents where they
  belong (decision 0008). With them come the root's tools' own tests, in Node's runner.

### Changed

- The spec moves to 0.2.0 (`spec-v0.2.0`), and its companion, `spec/debugging.md`, is first released
  at 0.1.0 (`debugging-v0.1.0`). Layout `0xA1` is revised in place: the CREDENTIAL block takes the
  SESSION block's bit, so a 0.1.0 peer and a 0.2.0 peer refuse each other's envelopes that carry a
  credential, `ENVELOPE_MALFORMED`.
- The decision records state what holds and where Bead goes: their index groups them by theme under
  its rules and names, under "Where Bead goes", the parts the records bind before the repository
  holds them; 0001's relay is decision 0019 and the connection HTTP draws decision 0020; the rule of
  a duration moves from 0011 to 0014; 0006 keeps its table as rule and job, with its gates owed;
  0004 states the frame every file of entries keeps, and what each file holds besides stays its own
  record's; the spec and its companion name, in their preambles, the record behind each section;
  each Tenth Man section keeps its rounds in order, each answer the one that holds; and the C# side
  has a README of its layout and its modules. A gate in CI's `commits` job,
  `tools/check-links.mjs`, holds every relative link of the repository's Markdown, and its anchor,
  to a file or a heading that exists.
- The parameter rule takes an options object after two parameters, as Deno's style guide counts them,
  held by `max-params` at 3 and `bead/options-last` on the TypeScript side, and by review.
  `resolveRequestOptions` takes its defaults first, `RequestDefaults`, and the call's options last.
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
  `CHUNK_INVALID`, and a requester whose header, its `TRANSFER` block added, leaves it none or
  passes 1,020 bytes fails before it goes, `PAYLOAD_TOO_LARGE`: a `JWT` of 997 bytes or more, 993
  beside a destination, goes whole only, and a credential no header of its request holds is a
  programmer's error, before the call starts. An opening gets no credit before its credential
  resolves and its admission settles.
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
  section 15.12 names the HTTP server's own `connectionInactivityTimeout`, 30 s; section 13.7 says
  that a timeout neither the application nor its transport gives is without end.
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
- Spec 15.1: on a connection, a transport hands each envelope on once, in the order its side sent
  it, unless its section says otherwise, stating what may overtake and what a copy is; 15.9: over
  HTTP, a failure that ends a subscription may come before its call's result, which the client then
  reports as `CALL_UNKNOWN`. Every transport and both sides keep it as they are.
- The Tenth Man's objections are kept in the repository, in the record whose decision a change makes
  or changes, or whose Scope holds what it changes; 0007 holds the parameter rule's.
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
- The spec's preamble: each file of entries is named by a section whose clauses it plays, a group of
  vectors by its name, and each entry cites the units it checks; a side conforms to the wire by
  sections 1 to 15, to what it declares by section 16, and to what its codecs write and read by
  section 17, for each encoding it offers, a relay offering none; it does what each entry says, but
  an entry whose `differs` names a row of the support matrix and its language, and a unit no entry
  cites binds it all the same. Sections 6.1 and 9.5 point to section 17.
- Spec 9.2: step 3 answers `DESTINATION_UNKNOWN` to a request that names a destination at a receiver
  that relays nothing, and a receiver that relays takes section 14.3's steps in place of steps 3 to
  7, and goes on as section 14.2 says in place of step 8, as both sides do; a conversation plays a
  relay that verifies presented an `ELSEWHERE`.
- Spec 11.6: the result of a request that opens a subscription, too large for one envelope, is
  answered `PROCEDURE_FAILED` and reported `PAYLOAD_TOO_LARGE`, as 12.1 has it and both sides do;
  a conversation plays it.
- Spec 9.1, 9.7, 11.10, 12.1, 12.2 and 15.5 say what both sides do where their words fell short: a
  requester with no call id free, a failure that ends a subscription at the client that holds it,
  the application that sets a queue's bounds, a result's header counted with an announcement, the
  bytes a receiver reserves for its transfers, how long a cancelled call id stays reserved.
- A router refuses a declaration as it is made — a resolver registered, a requester made, a
  notification registered — out of its range or off its form (spec 16.10), on both sides, before
  any reason of its own and its registry's: a `ProgrammerError` and an `ArgumentException`, where a
  requester's and a notification's checked nothing, and a resolver's revision and name were
  anything. A service manager's `getNotification`, `GetNotification`, checks before its own reason.
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
- Spec 12.5 and 12.6.1: the last chunk of a transfer is full at most, and both sides refuse one past
  full `CHUNK_INVALID`. A sender whose `chunkBytes` is larger than its receiver's, whose chunks
  0.1.0 placed, is refused so: both ends set `chunkBytes` alike (12.2). 12.2 says a receiver holds
  `chunkBytes` to a CHUNK, and an opening and a payload sent whole to `maximumEnvelopeBytes`; 12.3.3
  states the order of its refusals, `PAYLOAD_TOO_LARGE`, `CAPACITY_EXCEEDED`, `CHUNK_INVALID`. Three
  conversations play them.
- A WebSocket server takes an upgrade from its own origin, or with no `Origin`, by default: any
  client that sends an `Origin` is judged by it, as an HTTP exchange is, so a page of another origin,
  a development server on another port or an extension's among them, and a client that always sends
  one, Go's `x/net/websocket` among them, are refused 403 where they were taken. A client gets in by
  sending no `Origin`, by sending the server's own, or by being named in `origins`, `Origins`. A
  `file:` page, a `data:` page and a sandboxed frame send `null`, as a browser does in place of an
  origin it withholds, after a cross-origin redirect or under a referrer policy: naming `null` takes
  every one of them, of any site.
- A server's own origin is `http://` or `https://` followed by its request's `Host`, compared ASCII
  case-insensitively, the `Origin` field read as the serialized origin it carries, never parsed as a
  URL (spec 15.12, RFC 6454 §6.2), on both sides and both transports: an `Origin` of `ws:`, `wss:`,
  `ftp:`, `file:` or any other scheme, or with a path or a userinfo, naming the server's host, is
  refused 403 where the HTTP server took it. Every browser writes its `Origin` and its `Host` from
  one URL, and keeps its own.
- Both sides' WebSocket servers answer 426 an upgrade of any `Sec-WebSocket-Version` but 13, or of
  none, naming 13 in their own `Sec-WebSocket-Version`, and close its connection (spec 15.2, RFC 6455
  §4.2.2): the TypeScript side's where `ws` took version 8, whose handshake carries its origin in
  `Sec-WebSocket-Origin`, and answered any other 400; the C# side's where it answered 426 alone. An
  upgrade is judged by the `Origin` an exchange is.
- A WebSocket server judges a request at its address in the order spec 15.2 states: 400 as HTTP
  answers it to a `Host` missing, repeated or no host; 403, `host-refused`, to a host not taken,
  whatever the request; 405, `method-refused`, to a method but `GET` or `HEAD`, its `Allow` naming
  both; 426, `upgrade-required`, to a request that asks no WebSocket, a `HEAD` and an `HTTP/1.0`
  request among them; 426, `version-refused`, to a version but 13, or a version listed; 400,
  `malformed`, to a malformed upgrade, a key with a space inside, two version fields, a malformed
  `Sec-WebSocket-Protocol` and content among them; each 426 naming `websocket` in its `Upgrade`
  (RFC 9110 §15.5.22), each refusal marked, never stored nor sniffed, its body empty, its connection
  closed. An `Upgrade` listing `websocket` among other protocols is taken. The TypeScript side
  answered such requests 400 or 405 unmarked, or 426 with `ws`'s own body; the C# side answered them
  426 alone, and took a key with a space inside, a version listed in one field, two version fields
  and a malformed `Sec-WebSocket-Protocol`.
- An HTTP server answers 400 an HTTP/1.1 request without a `Host`, and one with two `Host` field
  lines or a `Host` that is no host (spec 15.12, RFC 9112 §3.2), unmarked, on both transports.
- The TypeScript side asks Node 24.9 or later, whose `shouldUpgradeCallback` its WebSocket server
  judges a request through before `ws` reads it.
- The TypeScript side's WebSocket transports take a message of an envelope's limit by default,
  16,778,240 bytes, `MAXIMUM_MESSAGE_BYTES`, as the C# side's do: the server where `ws` took
  104,857,600, the client wherever its `WebSocket` takes a bound, `ws`'s; `createWSClient` holds it
  to its limits, as `createWSServer` does.
- The TypeScript side's `IIncomingMessageLike`, the request a `WebSocketServer` hands its transport,
  gives its headers, its raw headers, its HTTP version and its method, and its socket's address, as
  Node's request does; the socket the transport answers raw, a `CONNECT`'s or an upgrade `ws` cannot
  read, is an `IUpgradeSocketLike`, `end`, `destroy`, `on` and `once`. `IHTTPRequestLike` gives its
  `httpVersion`. The WebSocket transport builds its own `node:http` server and hands it to its
  `WebSocketServer` as `server`, beside `maxPayload`, what `IWebSocketServerConstructor` takes:
  Node's `shouldUpgradeCallback` hands `ws` only the upgrades the transport takes, and the transport
  answers every other request itself. It listens for `wsClientError` as a guard, answering 400
  `malformed`. A `WebSocketServer` given in place of `ws`'s takes its upgrades from that server, as
  `ws` does.

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
- The C# side's server router fails a request of its own that names no connection, or that
  subscribes, by the task it gives, as the TypeScript side's does by its promise, where it threw as
  it was called.
- Both sides refuse `CHUNK_INVALID` a chunk before the last past full, which spec 12.6.1 refuses,
  where they placed it.
- Both sides cut a failure's detail back to the start of the character the cut fell in, and no
  further: a continuation byte at the cut that no character before it reaches drops nothing (spec
  7.3). Two vectors.
- A resolver registered on a router, on both sides, that fails before it answers is answered
  `PROCEDURE_FAILED`, as spec 9.5 says, where its requester waited out its timeout; the twin tests
  that pinned the silence are reversed.
- The TypeScript side's HTTP server takes its own origin with a `Host` in any ASCII case, as the C#
  side does, and both take a host among `hosts` in any ASCII case (RFC 9110 §4.2.3).
- A WebSocket server upgrades no `HTTP/1.0` request, whose `Upgrade` it ignores (RFC 9110 §7.8).
  The TypeScript WebSocket server refuses an upgrade with content, whose body it read as frames, and
  an upgrade without a `Host`, which it took; both TypeScript servers refuse a request with two
  `Host` field lines, which they took by the first, or with a `Host` that is no host.
- The C# side's servers read the `Host` field as it came, as the TypeScript side's do, where
  ASP.NET Core's `HttpRequest.Host` turned its punycode into Unicode: a page on an IDN host, its
  `Host` and its `Origin` in punycode as a browser sends them, is its own where the HTTP server
  refused it 403; `hosts` names such a host in punycode, the form the field carries; and a `Host` of
  invalid punycode, `xn--a` say, is a host as any other where the HTTP server answered 500.

### Security

- A WebSocket server takes an upgrade only from the hosts and origins it takes, `hosts`, `Hosts`,
  and `origins`, `Origins`, as the HTTP server does, and refuses any other 403, `host-refused` or
  `origin-refused`, its body empty: a page of another origin no longer calls a server on the
  loopback. It judges its own origin by `Host`, and refuses a host it does not take whatever the
  request, as the HTTP server does: `hosts` refuses a page that rebinds its name to the server's
  address.
- The C# side's `TransportMessage`, `SessionRequest` and `Session<TData>` write whether a
  credential or a session's token is there in their strings, never it.

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

[Unreleased]: https://github.com/francisdesjardins/bead/compare/v0.8.0...develop
[0.8.0]: https://github.com/francisdesjardins/bead/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/francisdesjardins/bead/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/francisdesjardins/bead/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/francisdesjardins/bead/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/francisdesjardins/bead/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/francisdesjardins/bead/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/francisdesjardins/bead/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/francisdesjardins/bead/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/francisdesjardins/bead/releases/tag/v0.1.0
