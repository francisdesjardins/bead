# Decisions

Why Bead is shaped the way it is. One file per decision, each one readable on its own.

A record states a decision that holds: what forced it, what it is, and what it costs. The spec says
what an implementation does, and the code how; a record says why, so that a reason outlives the
person who held it. Code, configuration and other records cite a record by its number, and **a
number, once given, names its decision for good: it is never given to another**, as an RFC's or a
PEP's is not, since commits, tags and released CHANGELOG sections cite it where nothing can rewrite
them. Between two releases, records are regrouped, moved in the index, normalized and renamed where
that reads clearer, every citation moving with them; a record is never renumbered, and the index,
not the numbers, gives the order to read them in. A record merged into another keeps its file, a
short one whose Status says `merged into` its successor and links it, so that whoever comes by the
old number finds where its decision went; the release's CHANGELOG section names each merge. Gaps in
the numbering stay.

**A decision is changed, not appended to.** A record is rewritten in place while its decision holds,
so it reads as it stands: what changed, and when, is the CHANGELOG's and the commits'. A record that
only grows, a date at a time, makes its reader replay every step to learn where things stand. A part
that becomes a decision of its own takes the next number never given, and the record it leaves
names it in its Scope, where a reader who comes by the old number looks. A decision that reverses
keeps its number; its Status names what replaced it, and its successor is written beside it. A
file's name stays unless it misleads.

**At each release, the records are brought to it.** A record is in the present, with its view on
what is ahead: what it said was coming, and that the release carries, is stated as what holds; what
it said of how things were leaves it; what is still ahead stays ahead. The `bead-release-documents`
workflow does it, for the records as for every document that states where Bead goes, on the
release branch before the finish, and `tools/release.mjs prepare` lists it among what a release
owes by hand.

## Where Bead goes

Bead is typed two-way RPC with client-paced notifications, transfers under credit and sessions,
alike in a tab, a Web Worker, a server and over a topic-based publish/subscribe broker used as a
transport, never a network of its own
([0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)), and proven byte for byte by
the conformance files and the interop. The records bind, in the present, parts the repository does
not hold:

- **a topic-based publish/subscribe broker's bindings**
  ([0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)), each a subsection of the
  spec's section 15, on its version, over the core and the in-memory broker that
  [0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md),
  [0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)
  and
  [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)
  state, MQTT 5's standing
  ([0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md)):
  AMQP 1.0 on RabbitMQ 4, its adapter on each side and the interop against a real broker in CI,
  which proves the core common; and a relay that carries a subscription, which a page across a
  broker needs
  ([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md));
- **a third language's core**, its router, its service layer and its sessions before it has a
  socket, playing its conformance over the in-memory transport it carries first
  ([0036](0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md)),
  under a toolchain and a CI job of its own ([0005](0005-a-toolchain-per-language.md)), the
  validators of a blueprint's rules generated for it by beadc, or beadc refusing to generate it
  ([0035](0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md)),
  and each part it lacks, its transports among them, a row of the support matrix
  ([0004](0004-one-behaviour-in-every-language.md));
- **the transports' client part** of the conformance over HTTP and a WebSocket, as the broker's
  cases have one, with the outcomes the spec names for a client's call
  ([0004](0004-one-behaviour-in-every-language.md)) and the defaults of a client's durations
  ([0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md));
- **a relay across languages in the interop**, one side's relay in front of the other's
  destination, in the twin tests' place for a relay's two legs' limits and the session its
  requesters share ([0004](0004-one-behaviour-in-every-language.md),
  [0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md));
- **the DevTools extension on Firefox**, its own glue beside the core every browser shares
  ([0015](0015-a-pages-client-announces-itself-to-a-devtools-hook.md));
- **a counted call's cost, measured**: a call counted against one not counted, on each side, a
  measure beside those the benches take
  ([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md));
- **a constrained C side**, which builds debugging by its switches
  ([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)), refuses a declaration out of
  its range alone ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md))
  and polls deadlines on a 1 kHz loop
  ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)).

Ahead besides, each by a decision of its own that meets the Tenth Man:

- **a connection's age and a graceful drain**, for every long-lived transport at once, a
  WebSocket's and a broker's, as HTTP/2's `GOAWAY` drains one
  ([RFC 9113 §6.8](https://www.rfc-editor.org/rfc/rfc9113#section-6.8)) and gRPC's
  `MAX_CONNECTION_AGE` re-spreads them
  ([0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md));
- what
  [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)
  keeps ahead of a broker: an acceptor that proves itself to its opener, and a publisher's identity
  a broker vouches for standing for an `ELSEWHERE`;
- **a payload's rules written in CEL**, a total subset beadc compiles into each side beside the
  rules it compiles already, and then the rules
  [0035](0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md)
  refuses until they land: the well-known string formats, `bytes.pattern`, `bytes.in`, `any`,
  `duration`, `timestamp`, `field_mask` and `predefined` rules;
- **a connection's close code carried on `close`**, what its peer said — 1000, 1001 or a 4xxx —
  on every transport ([RFC 6455 §7.1.5](https://www.rfc-editor.org/rfc/rfc6455#section-7.1.5),
  [§7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1)), `error` keeping what a side
  ends a connection for of its own ([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md));
- what [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md) keeps ahead of the bounds a side
  keeps against a peer that holds it: a bound on the payload bytes of the calls a connection has
  answered, as HTTP/2's connection window; a raise of `maximumAnsweringCalls` for one trusted
  connection; a requester's queue past it; and a budget of what waits for every socket together, as
  `bodyBytesBudget` is for bodies;
- **one corpus read alike by both sides' parsers**, held as a gate, as
  `tools/protobuf-conformance.mjs differential` holds a `proto` payload
  ([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)),
  beside the six targets both sides fuzz by hand, guided by coverage
  ([the root README](../../README.md#fuzzing)), and a short run of them in CI;
- what [0030](0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md)
  names: `Forwarded`, once a proxy that writes it alone is met, an IPv6 client keyed by its prefix,
  and a per-address value fit for a NAT, for an HTTP server and a WebSocket server at once;
- a hook that verifies a WebSocket's credential at its upgrade, refusing before the 101, and a
  credential replaced in place on a live connection
  ([0032](0032-a-websocket-upgrade-from-no-page-carries-its-credential-beside-every-envelope.md));
- **an opt-in that hands a procedure its call's bearer credential**, a `JWT`'s token or what its
  transport carried beside an `ELSEWHERE`, both schemes at once, to the procedure that asks alone,
  as RFC 8693's token exchange or a call on its user's behalf needs
  ([0010](0010-a-request-presents-a-credential-of-a-scheme.md));
- what
  [0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)
  keeps ahead of HTTP/JSON transcoding: a gateway apart from its server, over a real transport,
  which a pool of connections would spare a handshake an exchange; a `raw` body streamed as a
  transfer as it comes; OpenAPI 3.2.0, whose `itemSchema` describes a stream's events;
  `google.api.field_behavior` read into `readOnly`, `writeOnly` and `required`; and an application
  failure's own status, an option of its enum value's, at the options' v1 freeze;
- what
  [0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)
  keeps ahead of a gateway's problems, each a round of its own: a report's context, the exchange and
  the route it came of; an event for each refusal of the gateway's own; and an occurrence's id in a
  problem, [RFC 9457 §3.1.5](https://www.rfc-editor.org/rfc/rfc9457#section-3.1.5)'s `instance`.

A part that lands leaves this list, and brings its gates to [0006](0006-a-rule-has-its-gate.md)'s
table.

## The decisions

### The envelope and its calls

| #                                                           | Decision                                                                                                        | Status   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| [0001](0001-the-envelope-sits-at-fixed-offsets.md)          | The envelope sits at fixed big-endian offsets, behind an 8-byte prefix and its layout byte                      | accepted |
| [0002](0002-a-subscription-goes-at-its-clients-pace.md)     | A client may pace its subscription, and what waits, waits by key                                                | accepted |
| [0010](0010-a-request-presents-a-credential-of-a-scheme.md) | A request presents a credential of a scheme, in the header's last block, and runs in the session it resolves to | accepted |

### Payloads

| #                                                                                                                                           | Decision                                                                                                                                | Status   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)                                                                        | A JSON payload is read as I-JSON, its noncharacters aside, and written in RFC 8785's canonical form, the same bytes from every language | accepted |
| [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)                                         | A `proto` payload's records are read against its message before its library reads them                                                  | accepted |
| [0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)                                                            | A `proto` payload is protobuf's binary format, read and written through each side's stock library, and Bead states only what is its own | accepted |
| [0035](0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md)                                              | A payload that reads is held to its message's rules before its resolver sees it                                                         | accepted |
| [0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md) | A `proto` message that leaves a required field unset neither reads nor writes, and a gateway refuses it where its server would          | accepted |

### Services and their names

| #                                                                                                          | Decision                                                                                                                | Status   |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| [0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)                                | Ids are for life, a procedure's name takes one ASCII form, and every side refuses a declaration off them as it is made  | accepted |
| [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)            | A service's procedures are typed descriptors, served and called through one layer in each runtime                       | accepted |
| [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)               | A `.proto` becomes one checked blueprint, and each language's server and client are generated from it alone             | accepted |
| [0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md) | A procedure is also an HTTP route, which a gateway answers as one more client of its server, one connection an exchange | accepted |

### Transports and relays

| #                                                                                                                         | Decision                                                                                                                                                           | Status   |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| [0012](0012-a-listen-held-is-not-silence.md)                                                                              | A listen held is not silence, and a connection without a session is its server's                                                                                   | accepted |
| [0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)                                                    | A relay terminates each leg between two transports, and routes nothing past it                                                                                     | accepted |
| [0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)                                                  | HTTP draws a connection by a token, and a listen holds it                                                                                                          | accepted |
| [0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)                                                       | A topic-based publish/subscribe broker is one more transport, and Bead is never a network of its own                                                               | accepted |
| [0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)                         | A transport goes on through its listener's throw, and takes nothing new once its stop began                                                                        | accepted |
| [0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md)                                            | A transport draws each connection's handle, and gives none twice                                                                                                   | accepted |
| [0029](0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md)                                               | A listen names its cursor and its wait in fields of its own, at the connection's one URL                                                                           | accepted |
| [0032](0032-a-websocket-upgrade-from-no-page-carries-its-credential-beside-every-envelope.md)                             | A WebSocket upgrade from no page carries its credential beside every envelope of its connection, a client follows no redirect, and a connect bounds what it awaits | accepted |
| [0036](0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md) | An in-memory transport joins two routers of one process, and a server takes several transports through one                                                         | accepted |
| [0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)                              | Over a broker, a connection is placed once at its open, and named by both its ends                                                                                 | accepted |
| [0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)              | A broker's transport numbers its parcels, and sends an envelope in parts under its peer's bound                                                                    | accepted |
| [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)           | A broker's adapter offers bytes at topics, and Bead keeps its own credit, credential and heartbeat                                                                 | accepted |
| [0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md)             | Over MQTT 5, a participant is one clean link and a parcel one PUBLISH, each counted to its byte                                                                    | accepted |

### A server's edge

| #                                                                                         | Decision                                                                                                                                                                               | Status   |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)   | A server listens on the loopback, takes the loopback's names, IP literals and the hosts it is told, each named by a request's authority                                                | accepted |
| [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md) | A server tells each refusal it judges of its own, a client names the one it reads, and a request's fields are visible ASCII                                                            | accepted |
| [0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)       | An HTTP server answers CORS to the origins it names, and to no other                                                                                                                   | accepted |
| [0030](0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md)    | A server believes `X-Forwarded-For` from the proxies it names and as many unnamed ones as it counts                                                                                    | accepted |
| [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)                                     | A side bounds what a peer holds of it: the calls it answers on a connection, a request's bytes, a WebSocket server's connections, what waits for a socket, and a request that trickles | accepted |
| [0034](0034-a-server-tells-each-access-it-refuses-never-the-credential.md)                | A server tells each access it refuses, never the credential                                                                                                                            | accepted |

### Time

| #                                                                      | Decision                                                                                                                                     | Status   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)     | Every side takes its time from a clock it is given                                                                                           | accepted |
| [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md) | A side holds a duration an application gives it as whole milliseconds from 1 to 2³¹ − 1, and every place that takes one is a row of one file | accepted |

### Beside the wire

| #                                                                  | Decision                                                                                         | Status   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------- |
| [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)    | Every language traces, filters and counts its calls alike, beside the wire, at no cost when off  | accepted |
| [0015](0015-a-pages-client-announces-itself-to-a-devtools-hook.md) | A page's client announces itself to a DevTools hook, which watches it only while a panel is open | accepted |

### One behaviour in every language

| #                                                                     | Decision                                                                                                                                | Status   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [0003](0003-one-word-one-meaning.md)                                  | One word means one thing, and there are no abbreviations                                                                                | accepted |
| [0004](0004-one-behaviour-in-every-language.md)                       | Every language plays one behaviour, held by the conformance files and the interop                                                       | accepted |
| [0005](0005-a-toolchain-per-language.md)                              | Each language keeps its own toolchain, and the root holds only what all share                                                           | accepted |
| [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)    | The C# side composes interfaces, writes every body as a block, takes two parameters and an options record, and builds without a warning | accepted |
| [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) | Versions run on three axes, and names are qualified by their owner                                                                      | accepted |

### How the repository decides

| #                                                               | Decision                                                                                                                     | Status   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| [0006](0006-a-rule-has-its-gate.md)                             | A rule has its gate, or it is a preference                                                                                   | accepted |
| [0009](0009-conventional-commits-git-flow-and-the-tenth-man.md) | The repository follows Conventional Commits, git-flow and Keep a Changelog, and what the languages share meets the Tenth Man | accepted |

## Writing one

The next decision is 0043. Its file is `NNNN-the-decision-in-a-few-words.md`, and its title states
the decision, not its subject. The title may grow with the record; the file's name stays, unless it
would mislead.

Under the title, a **Status** (accepted, or what replaced it) and a **Scope**: what the decision
binds — the spec's sections, the files, the sides — and, where a part of it is another record's,
which. Then Nygard's shape, trimmed to what gets read:

- **Context**: the forces — a standard, a platform's behaviour with its version, a measure, where
  Bead goes — and the options not taken, each described for what it is.
- **Decision**: each choice and its reason, in the present tense. The rule is the spec's: a record
  names its clause rather than restating it.
- **Consequences**: what the decision costs, what it makes impossible, and its gate, or who holds it
  where no tool can ([0006](0006-a-rule-has-its-gate.md)).
- **The Tenth Man**, for a decision the languages share
  ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)): one intro, then its rounds in
  their order, each under a plain heading, a table of objections in their words and the answer that
  holds, accepted or refused with its reason. A row a later row replaced is dropped. A record
  without the section meets the Tenth Man at the next change of its decision.

Three things keep these worth reading. **State the cost**: a decision with no consequence is a
preference. **Give the number** where there is one: the sentence that survives a year is the one
with a measurement in it. **Keep history out**: no list of what lands, no column of how things
stood, no "today" and no "yet"; the CHANGELOG says what changed, and the commits how.

A record cites what a reader of the repository can open: the spec, the conformance files, the code,
the other records. A part the repository does not hold is bound by constraint, in the present, and
named under [Where Bead goes](#where-bead-goes); a gate that does not run is among
[0006](0006-a-rule-has-its-gate.md)'s gates owed.

A change of anything the languages share — the protocol, a name, a behaviour — keeps the Tenth
Man's objections and their answers in the repository
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)): in the record it writes; in the
one whose decision it changes, which gains the round; or, for a change of the spec, its files or
their gates that changes no decision, in the record whose Scope holds what it changes. A change that
changes several records keeps its round in the first it names, the others pointing to it. A record
lands with the spec, the conformance files and every implementation it changes; add it to the table
above, under its theme, in the same change.
