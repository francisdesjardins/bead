# 0050 — The Rust side's broker bindings are features of its core, MQTT 5 a client of its own over its sockets

- **Status**: accepted
- **Scope**: the Rust side's broker bindings, MQTT 5 and AMQP 1.0: their features of the core, `mqtt`
  and `amqp`, their items, their names and their defaults; the MQTT 5 adapter, its client, its
  tests, the brokers' fixtures' users of the Rust interop, and its interop with the TypeScript and
  C# sides; the stage of
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md) that brings
  them, and 0044's list of crates. The bindings' rules stay
  [0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md)'s
  and
  [0043](0043-over-amqp-1-0-a-participant-is-one-connection-whose-exclusive-inbox-ends-with-it-and-a-parcel-one-message-of-one-profile-each-counted-to-its-byte.md)'s,
  the adapter's contract
  [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)'s,
  placement
  [0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)'s,
  parcels
  [0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)'s,
  the surface [0047](0047-every-side-shows-one-public-surface.md)'s, the sockets
  [0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)'s,
  one behaviour and a difference a row [0004](0004-one-behaviour-in-every-language.md)'s. Ahead: the
  AMQP 1.0 binding, the open row `Rust's AMQP 1.0 binding`, and the choice of its client, which
  this record weighs below.

## Context

**What each side does.** The TypeScript side ships each binding as a subpath of its one package,
`./mqtt-broker-adapter` and `./amqp-broker-adapter`, over MQTT.js 5.16.1 and rhea 3.0.5, optional
peer dependencies, with Bead's own code beside them where the libraries fall short: `mqtt-packets.ts`
counts a packet `S = 1 + v(R) + R` (15.30), `mqtt-packet-guard.ts` reads each received packet's
size at its Remaining Length on MQTT.js's stream (15.29), `amqp-messages.ts` writes the message
profile (15.35), and `amqp-management.ts` holds RabbitMQ's management pair. Each module exports its
defaults, `CONNECT_TIMEOUT` among them, and a password provider of type `({ signal }) => string |
Promise<string>`. The C# side ships a project each, `Bead.Transport.Mqtt` over MQTTnet 5.2.0.1603 and
`Bead.Transport.Amqp` over AMQPNetLite.Core 2.5.5, each reaching `Bead.Core`'s inside by
`InternalsVisibleTo`; beside the libraries, `MqttPackets`, `MqttSendQuota`, `AmqpManagement`, and a
guard on MQTTnet's channel that reads each received packet's size at its Remaining Length and ends
the link past the Maximum Packet Size; it exports no default as a constant. The Rust side holds the
adapter's contract, `BrokerAdapter` and `BrokerListener`, at its root, and plays the broker's cases
over its in-memory broker alone; every feature's item sits at its root (0049), `CredentialProvider`
already has the shape of both other sides' password providers, and `bead::internal` reaches the
core's inside for the workspace's own members, outside SemVer.

**What the probes found**, each on the pinned toolchain, rustc 1.99.1, read on 2026-11-10:

- **rumqttc 0.25.1**, against a scripted MQTT 5 peer whose CONNACK gives a Receive Maximum of 2 and
  which withholds every PUBACK: the two PUBLISH went at once, and the SUBSCRIBE asked at about
  100 ms and the PUBACK of a QoS 1 PUBLISH the peer sent at 329 ms both waited for the peer's PUBACK
  at 1,545 ms. Its event loop turns its requests off while its in-flight count is full
  (`rumqttc-0.25.1/src/v5/eventloop.rs:178-225`), against [MQTT-3.3.4-8]: a client delays no other
  packet for its quota. Its TLS fails `cargo deny`: RUSTSEC-2025-0134, RUSTSEC-2026-0049 and
  RUSTSEC-2026-0098.
- **rumqttc-v5-next 0.34.0**, the same peer: it holds the quota, the SUBSCRIBE going at 93 ms and the
  PUBACK at 314 ms. It is a fork begun on 2026-03-23 by one hand, through twelve breaking minors; it
  sends a DISCONNECT of 0x95 on a packet past its own bound (`framed.rs:59`), which every side levels
  down, so Bead would put a guard of its own before it; its WebSocket brings a second tungstenite;
  and its reconnection, its session store and its persistence are turned off one by one. What it
  would keep is a codec and a state machine Bead overrides.
- **fe2o3-amqp 0.18.4**, against the fixture's RabbitMQ 4.4.0, over a socket Bead opened: SASL PLAIN
  works, but the management pair's receiver, of its sender's name on one session, is refused before
  any ATTACH goes, `DuplicatedLinkName`: its session keys its links by name alone
  (`session/mod.rs:686-688`), where AMQP 1.0 §2.6.1 names a link uniquely among the links of one
  direction; across two sessions RabbitMQ pairs nothing. So no inbox is declared, bound or deleted
  (15.33). Its engines spawn past `crate::platform` (`connection/engine.rs:82`). Its encoder writes
  18 of `amqpMessages`' 24 rows to the byte, a 255-byte Data section as `vbin32` where Types §1.6.19
  gives `vbin8` (`serde_amqp-0.18.0/src/ser.rs:526`), and takes no message already written.
- **fe2o3-amqp-types 0.18.0 and serde_amqp 0.18.0 as the codec alone**: none of fe2o3-amqp's three
  defects is the codec's; the probe writes and reads back OPEN, BEGIN, an ATTACH with `paired`, FLOW,
  TRANSFER, the SASL frames and a management body, reads a 255-byte Data section as `vbin8` and
  `vbin32` alike, and is clean under `deny.toml` with fifteen crates added, proc macros among them.
  But the published reader panics on a peer's malformed compound in a debug build, "attempt to
  subtract with overflow" (`serde_amqp-0.18.0/src/de.rs:961`, a `list8` of size 0; `:1070`, a `map8`
  of size 0; `:982`, a `list32` of size 2); the fix, #441, is merged on 2026-10-29 and unreleased,
  0.18.0 of 2026-09-08 being its last release; and `serde_amqp` went through three breaking minors in
  three months under one maintainer.
- **The feature path** (`cargo tree -d`, `cargo deny` under `deny.toml`): a binding over the core's
  sockets and Bead's own codec adds no crate to the lock.

**The standards.**

- **[MQTT Version 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)**, OASIS
  Standard: §1.5.4 and §1.5.6, strings and Binary Data; §2.1.4, the Remaining Length; §2.2.2,
  properties in any order; §3.1, CONNECT, its Clean Start, its will, its Keep Alive, its Session
  Expiry, Receive Maximum, Maximum Packet Size [MQTT-3.1.2-24] and Topic Alias Maximum, its User Name
  and Password; §3.2, CONNACK; §3.3, PUBLISH, [MQTT-3.3.4-7] and **[MQTT-3.3.4-8], no other packet
  delayed for the quota**; §3.8.3.1, Retain Handling; §3.9, SUBACK's 0x9E; §3.10 and §3.11,
  UNSUBSCRIBE; §3.14, DISCONNECT, 0x00, 0x8E and 0x95; §4.8.2, shared subscriptions; §4.9, flow
  control; **§4.13.1, a client detecting a packet too large SHOULD send a DISCONNECT of 0x95**; §6,
  over a WebSocket ([MQTT-6.0.0-1] to [MQTT-6.0.0-3]).
- **[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)**: §1.9, a subprotocol; §4.1, the client's
  handshake; §5.4, fragmentation; §5.6, data frames.
- **[AMQP 1.0](https://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-overview-v1.0-os.html)**,
  OASIS Standard: Types §1.2 and §1.6, any valid encoding readable; Transport §2.2 to §2.7, **§2.6.1,
  a link's name unique among the links of one direction**; Messaging §3.2 to §3.5; Security §5.2 and
  §5.3; [RFC 4616](https://www.rfc-editor.org/rfc/rfc4616), SASL PLAIN, and
  [RFC 4422](https://www.rfc-editor.org/rfc/rfc4422) Appendix A, EXTERNAL; AMQP Request-Response
  Messaging with Link Pairing 1.0, which RabbitMQ 4's HTTP over AMQP 1.0 follows.
- **[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446)**, **[RFC 5280 §6](https://www.rfc-editor.org/rfc/rfc5280#section-6)**
  and **[RFC 8305](https://www.rfc-editor.org/rfc/rfc8305)**: the core's TLS, its verifier and its
  Happy Eyeballs, as 0049 has them.
- **[Cargo's features](https://doc.rust-lang.org/cargo/reference/features.html)**: additive, an
  optional dependency behind a feature, the twin of npm's optional peer; the
  **[Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)**' C-FEATURE, a feature named
  for what it brings, and C-REEXPORT, an item where its user looks for it.

**The options not taken**, each with its reason:

- **A crate per binding**, `bead-transport-mqtt` and `bead-transport-amqp`: a second dependency line
  pinned to the core's version, and a binding that reaches the core's inside through `internal`,
  outside SemVer, so that a published crate on it pins the core to its exact version, the C# side's
  `InternalsVisibleTo` having no checked form in Rust; or ten items made public for one consumer,
  against 0047's pinned surface.
- **Public modules `bead::mqtt` and `bead::amqp`**: their one forcing reason is one name, the root's
  `CONNECT_TIMEOUT` of 10 s beside the bindings' 30 s, and the twin of a TypeScript subpath holds for
  `websocket` and `http` too, which 0049 put at the root; two conventions for one kind of item is the
  state 0047 refuses. Turning `websocket` and `http` into modules too renames thirteen exports, the
  surface's list, `tools/names.tsv`, `tools/durations.tsv` and the interop server, for the same
  surface.
- **The two connect timeouts unexported**, the C# form: the TypeScript side exports them and the
  Rust side every other default.
- **A new `PasswordProvider` type**: `CredentialProvider` is that type already.
- **A codec always built**, as 0049's head's parse is: that parse is consumed by the core, and a
  broker's codec has no consumer but its feature, its tests and its fuzz target.
- **MQTT 5's libraries**: rumqttc 0.25.1 and rumqttc-v5-next 0.34.0, for what the probes found;
  `mqtt5-protocol` 0.16.2, packets, encoding and validation alone, 34 releases since 2025-11-26 and
  three in October 2026, a codec moving faster than a dependency's cooldown lets Bead follow, and a
  reader of a broker's bytes outside the lints Bead's own packets are written under;
  `mqttbytes-core-next` 0.34.0, the fork's packet primitives, its churn with them; mqtt5 0.50.0,
  the strongest of them: its send quota waits for a QoS > 0 PUBLISH alone, by its packet
  identifier, as [MQTT-3.3.4-8] has it, and its packet reader holds no `unwrap`, `expect` or
  `panic!` outside its tests. But it has had 97 releases since 2025-08-04 and four breaking minors
  in October 2026 alone, 0.47 to 0.50, past what a minor's seven-day cooldown lets Bead follow. It
  spawns its own tokio tasks, 46 sites under `src/client` and `src/transport`, beside
  `crate::platform`. It owns its sockets and its TLS, beside the core's socket layer and its
  loopback and `secure` judgements. It answers a received packet past its bound with a DISCONNECT
  0x95 (`client/direct/reader.rs` 140), which every side of Bead levels down. And it brings
  persistent sessions, retry, replay and authentication handlers that Bead's own reconnection would
  turn off; ntex-mqtt, on ntex's runtime and
  not on the application's tokio through `crate::platform`; paho-mqtt, a C library behind `unsafe`;
  mqttbytes 0.6.0, of 2021. No client and no codec holds the binding as 0041 has it, and eleven
  packets are small by hand.
- **AMQP 1.0's libraries but the three branches weighed below**: ntex-amqp, on ntex's runtime where
  a `BrokerAdapter` is `Send + Sync`; Qpid Proton, C behind `unsafe`; lapin and amqprs, which speak
  AMQP 0-9-1.
- **The broker jobs behind `rust`**: `needs` waits on a job's end, so `mqtt` and `amqp` would start
  after the `rust` job's whole Linux leg; 0049 accepts it for `interop-rust`, which runs in a
  container with no toolchain and no C compiler, where the broker jobs run on the runner's host. A
  job building once for three consumers is one more job and an artifact to spare one parallel
  build.
- **A row of Differences for a reader fuzzed on one side**: no kind of the matrix holds it, and a
  fuzz target is a gate.

## Decision

### Two features of the core, `mqtt` and `amqp`, their items at the root

Each binding is **a feature of the core**, `mqtt` and `amqp`, additive and off by default, as
`websocket` and `http` are: a transport that ships to applications and needs the core's inside
(0044, 0049) takes one dependency line and one version, `crate::platform` its one spawn, one table
of lints, and `internal` kept outside SemVer for the workspace's members alone. Every item of a
binding is **at the crate's root**, each `pub use` under its feature's `cfg`, its module private;
a user writes `bead = { package = "francisdesjardins-bead", features = ["mqtt"] }`, then
`use bead::{MqttBrokerAdapter, MqttBrokerAdapterOptions};`.

**Everything of a binding is under its feature**, its codec among it: a build without it compiles
nothing of it, and the browser's check, `--features testing --target wasm32-unknown-unknown`, none.
`bead::internal` re-exports each codec's reader under the same `cfg`, and the fuzz project, outside
the workspace, turns the features on in its own manifest, which no application's build unifies
with. The socket layer and `bead::rustls` build under any of `websocket`, `http`, `mqtt` and
`amqp`; `CredentialProvider` and `CredentialProviderError` move to a module of their own under
`websocket`, `mqtt` or `amqp`, still at the root by the same names: a broker adapter's password
provider is that type. `mqtt` builds MQTT 5 over a WebSocket of subprotocol `mqtt` with the
`websocket` feature's crates; `amqp`, with AMQP 1.0's binding, over TCP and TLS alone. No crate
joins `Cargo.lock`, and `deny.toml` is unchanged.

### The names and the options

`MqttBrokerAdapter` and `MqttBrokerAdapterOptions`, `AmqpBrokerAdapter` and
`AmqpBrokerAdapterOptions`, the twins of the other sides' by name; the defaults the TypeScript side
exports by the same names, `KEEP_ALIVE`, `MAXIMUM_PACKET_SIZE`, `TRANSPORT_MQTT`, `IDLE_TIMEOUT`,
`LINK_CREDIT`, `MAXIMUM_MESSAGE_SIZE` and `TRANSPORT_AMQP`, each a row of `tools/names.tsv` that
goes from the TypeScript side's alone to the same on two sides; and the bindings' connect timeouts,
30 s, `MQTT_CONNECT_TIMEOUT` and `AMQP_CONNECT_TIMEOUT`, each named by its owner, since the root's
`CONNECT_TIMEOUT` is the transport client's 10 s: a row of the Rust side's own, which names the
TypeScript module's `CONNECT_TIMEOUT`. `CredentialProvider`'s row names the function's type a
WebSocket client's connect and a broker adapter's password take, which the other sides write in
place.

`MqttBrokerAdapterOptions::new(url, id)` is `#[non_exhaustive]`, not `Copy`, with no `Default`, its
two required settings its constructor's, every other field a public `Option`: `password`,
`password_provider`, `tls` (an `Arc<rustls::ClientConfig>`), `maximum_packet_size`, `keep_alive`,
`connect_timeout`, `delivery`, `groups`, `clock` and `runtime`. `AmqpBrokerAdapterOptions::new(url,
id)` takes `maximum_message_size`, `link_credit`, `idle_timeout` and `virtual_host` in place of the
MQTT-only three, as the C# side's options hold them. `MqttBrokerAdapter::new(&options)` gives
`Result<Self, ProgrammerError>`, refusing as built what the other sides refuse as built: a password
and a provider both, either beside a client certificate, read as the TLS configuration's
`client_auth_cert_resolver.has_certs()`, and the ranges. Each adapter implements `BrokerAdapter`,
with `is_linked()` and `unsettled()` its own.

### MQTT 5: a client of Bead's own, over the core's sockets

**The Rust side writes and reads the MQTT 5 packets it uses itself**, over TCP, TLS and a WebSocket
of subprotocol `mqtt`. It writes CONNECT (Clean Start 1, Session Expiry 0, Receive Maximum 65,535,
Topic Alias Maximum 0, its Maximum Packet Size, its Keep Alive, User Name and Password as 0041 has
them, the will of GONE at QoS 1, RETAIN 0, Delay 0), PUBLISH (QoS 0 or 1, RETAIN 0, a Message Expiry
Interval alone), PUBACK (0x00), SUBSCRIBE (one filter, QoS 1, No Local 0, Retain As Published 0,
Retain Handling 2), UNSUBSCRIBE (one filter), PINGREQ and DISCONNECT (0x00); it reads CONNACK,
PUBLISH, PUBACK, SUBACK, UNSUBACK, PINGRESP and DISCONNECT, each property in any order §2.2.2
allows, and refuses AUTH. Eleven packets, which `mqtt-packets.ts` and `MqttPackets.cs` count too.

What it holds by construction: its quota per incarnation, **no other packet delayed for it**
([MQTT-3.3.4-8]); each packet counted `S = 1 + v(R) + R` before it goes, refused past its CONNACK's
bound (15.30); a received packet past its own bound closes its network connection, no DISCONNECT,
its link lost (15.29), as the row of Leveled down has it; 0x8E a takeover (15.21); one filter per
UNSUBSCRIBE; no request cancelled once its packet may have gone; each WebSocket message one binary
frame, one packet; every callback gated by its incarnation. **Its connection is one task's**,
spawned through `crate::platform`, owning the socket, the quota, the filters and the PUBACK
reasons; an operation takes effect as it is made, its future only waits (0044). **Its reader faces
a peer's bytes**: it parses by checked operations under the workspace's lints, `indexing_slicing`
and `arithmetic_side_effects` denied, held by seeded mutations, `tests/mqtt_packets_fuzz.rs`, and a
cargo-fuzz target, `mqtt-packets`.

### AMQP 1.0's client, ahead

The `amqp` feature, its names and its options are decided above; **AMQP 1.0's client is ahead**,
with the open row `Rust's AMQP 1.0 binding`. It holds 0043 whichever carries it: SASL PLAIN as its
id, EXTERNAL under a certificate, never ANONYMOUS; the message profile written by Bead, by the
generator's rule (15.35), as the TypeScript side writes it; RabbitMQ's management pair, sender and
receiver of one name on one session (§2.6.1); credit granted by the adapter alone, one more as each
message is settled (15.34), a name's credit of 1, unsettled, `first`, no `max-message-size` on a
receiver; `released` as no subscriber; the sessions as walls (15.33); a received message settled
`accepted` on the receiver it came on (15.36); `linkCredit` refused past 2,147,483,647, as the row
of Leveled down has it. Its frame layer, its connection, its SASL exchange, its sessions, its links,
its credit, its management pair and its profile's writer are Bead's own on every branch; three
branches carry the rest:

- **Bead's own engine and codec**: the types, the performatives and the SASL frames written and read
  by Bead, a fixed subset of some fifteen encodings, thirteen performatives and three SASL frames,
  under the workspace's lints, behind a seam of its own, `amqp/codec`, that nothing but the engine
  reaches; no crate joins the lock, and a fuzz target, `amqp-frames`, holds its reader. It is the
  largest part, of the order of 4,000 lines with its tests' peer, of which some 1,200 are the codec.
- **`fe2o3-amqp-types` and `serde_amqp` as the codec**, at a release that carries #441, past the
  cooldown every dependency keeps: `amqp/codec` then holds the frame layer and the
  profile's writer alone, `amqp-frames` fuzzing Bead's reading of what the codec gives the engine;
  fifteen crates join the lock, `deny.toml` unchanged, no duplicate.
- **fe2o3-amqp whole**, after its fixes upstream, its links keyed by name and role (§2.6.1) and its
  8-bit widths to 255 (Types §1.6.19-21): the least code in the repository, an engine beside the
  core's owner, spawning past `crate::platform`.

### What the Rust side plays

`tests/transports.rs` plays every case over `mqtt` no row excuses it from, through a `CaseBroker`
trait, the twin of the C# side's `IBrokerCaseBroker`, the in-memory broker its first
implementation and Mosquitto's the next, `testing::link_relay` cutting a link for `lose`; against
the broker `BEAD_MQTT_URL` names with the run's password, skipped saying so where none is given,
failed where `BEAD_MQTT_REQUIRED=1`. `tests/vectors.rs` plays `mqttPublishBounds`, and
`tests/durations.rs` the places `mqttBrokerAdapter.keepAlive` and
`mqttBrokerAdapter.connectTimeout`. The adapter's twins of the other sides' tests run against
`testing::mqtt_script`, a peer that writes what it sends from the test's own bytes, never through
the client's codec, and against the fixture over TCP and WebSocket. **The interop**:
`bead-interop-server` serves over MQTT 5, its id `rs-server`, its names `interop-rs` and
`interop-both`, and its trials, `rs-client`, run against the TypeScript and C# servers; the
TypeScript and C# interop tests run against it.

### CI

The `rust` job lints the core's library with `mqtt` alone beside `websocket` and `http`; its
`--all-features` steps take every feature. The `mqtt` job **keeps its `needs`**: it installs the
pinned toolchain, restores the `rust` job's Linux cache read-only, builds what it runs, and runs the
Rust side's cases, its adapter's fixture twins, its trials and the TypeScript and C# clients against
its server over its broker, on the runner's host, beside `rust`. `fuzz.yml` and `tools/fuzz.mjs` run
`mqtt-packets` ten minutes a week, named as the Rust side's alone, as `blueprint` is the TypeScript
side's. The Windows leg runs every scripted twin; the fixture's twins and the cases skip there,
saying so.

## Consequences

- **A build with `mqtt` or `amqp` needs aws-lc-rs's C compiler**, as one with a socket feature does,
  the fuzz build among them.
- **The Rust side owns one more reader of a peer's bytes**, MQTT 5's, fuzzed by a target of its own,
  `mqtt-packets`, and by the seeded mutations of `tests/mqtt_packets_fuzz.rs`; neither has a twin,
  since the other sides read a broker's bytes through their libraries.
- **No crate joins the lock** with `mqtt`.
- **CI lints the core's library five ways**: with no feature, with `websocket`, `http` or `mqtt`
  alone, and with all.
- **Three serve `interop-both`**, the TypeScript, C# and Rust servers.
- **The Rust side keeps to every leveled row the MQTT 5 binding holds**: no DISCONNECT of 0x95, each
  WebSocket message one frame, a Password as text. The first is
  [0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md)'s,
  its reason Mosquitto's will handling.
- **The `mqtt` job builds from the `rust` job's cache**, beside it, not behind it.
- **Ahead**: AMQP 1.0's binding, `Rust's AMQP 1.0 binding`, its client by one of the three branches
  above, its fuzz target, its cases, its groups `amqpMessages` and `amqpPublishBounds`, its places
  and its interop.

**Its gates**: the cases over `mqtt` of `spec/transports.json`, the group `mqttPublishBounds`, the
two places of `mqttBrokerAdapter`, the adapter's twins, the interop over MQTT 5 both ways, the `mqtt`
job running the Rust side, and the fuzz target `mqtt-packets`.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, at xhigh effort. Seven objections, each checked against its probe or the code before it
was answered: six accepted and one in part, none refused. The first is answered as the record
stands, AMQP 1.0's client ahead.

| Objection                                                                                                                                                                                                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AMQP 1.0's client weighs two poles, fe2o3-amqp whole or everything by hand, and passes over the split between them: `fe2o3-amqp-types` and `serde_amqp` as the codec, the engine Bead's own, none of the three defects being the codec's. | In part. The option is real and verified: the defects sit in `fe2o3-amqp` (`session/mod.rs:687`, `connection/engine.rs:82`), the codec writes and reads every performative Bead needs, and it is deny-clean with fifteen crates. Against it, as published: `serde_amqp` 0.18.0 panics on a peer's malformed compound in a debug build (`de.rs:961`, `:1070`, `:982`), where the Rust side refuses by a `Result` and never panics; its fix is merged and unreleased; three breaking minors in three months under one maintainer; fifteen crates, proc macros among them. It is one of the three branches of AMQP 1.0's client, which is ahead; the engine is Bead's on every branch, behind a seam, `amqp/codec`, that a library can take without touching it. |
| The public modules `bead::mqtt` and `bead::amqp` are unforced and break 0049's precedent of every feature's item at the root; the clash is one name; and the reason against a crate misreads `internal`.                                  | Accepted. The items are at the root under their feature's `cfg`; the two connect timeouts are `MQTT_CONNECT_TIMEOUT` and `AMQP_CONNECT_TIMEOUT`, each a row of the Rust side's own naming the TypeScript module's `CONNECT_TIMEOUT`; every other default keeps its name, seven rows of `tools/names.tsv` going from the TypeScript side's alone to the same. On `internal`: a workspace member is not "another crate" in its doc; the reason against a crate is that `internal` is outside SemVer, so a published crate on it pins the core to its exact version, and one dependency line is what a user writes.                                                                                                                                              |
| MQTT 5's client leaves out the two codec-only crates its own probe fetched, `mqtt5-protocol` and `mqttbytes-core-next`.                                                                                                                   | Accepted. The Context names both: `mqtt5-protocol` 0.16.2, 34 releases in eleven months, three in October 2026; `mqttbytes-core-next` 0.34.0, the fork's primitives and its churn; each a reader of a broker's bytes outside the lints Bead's own eleven packets are written under. No client and no codec holds the binding as 0041 has it.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The CI gives `mqtt` and `amqp` `needs: rust`, serializing two twenty-minute jobs behind CI's longest, and does not say so.                                                                                                                | Accepted. The broker jobs keep their `needs`; each installs the pinned toolchain and restores the `rust` job's Linux cache read-only, then builds and runs the Rust side over its broker, beside `rust`. 0049's reason for `interop-rust`'s handed binaries, a container with no toolchain and no C compiler, does not reach jobs on the runner's host. A job building once for three consumers is weighed and refused: one more job and an artifact to spare one parallel build.                                                                                                                                                                                                                                                                             |
| A new row of Differences, "A broker client's reader, fuzzed", is of no kind the table admits and states a gate as a behaviour.                                                                                                            | Accepted. No row. The Consequences, the Rust README and `tools/fuzz.mjs`'s doc name `mqtt-packets` as the Rust side's alone, as `blueprint` is the TypeScript side's, and why it has no twin: the other sides read a broker's bytes through their libraries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| With the Rust side's client, two sides of three can send a DISCONNECT of 0x95; the leveled row's C# half is stale and its lift cell misstates what lifting takes.                                                                         | Accepted. The C# adapter's inspector reads each packet's size and ends the link, and MQTTnet's `MqttClientDisconnectOptionsReason` holds `PacketTooLarge`. The row says what forces it and what would lift it, every side keeping to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| "A build without the feature compiles nothing of it" contradicts codecs always built, compiled by every user of neither binding and by the browser's check.                                                                               | Accepted. Each codec is under its feature, `internal` re-exporting it under the same `cfg`, and the fuzz project, outside the workspace, turns the features on in its own manifest, which no application unifies with. 0049's head's parse is always built because the core consumes it; a broker's codec has no consumer but its feature. The fuzz build then compiles aws-lc-rs, which the `rust` job's fuzz build proves.                                                                                                                                                                                                                                                                                                                                  |
