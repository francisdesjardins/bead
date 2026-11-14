# Bead, on the Rust side

Bead is a binary wire protocol: the envelopes of a request, its result or failure, the notifications
of a subscription and the commands a server sends back, written at fixed offsets. This workspace is
its Rust implementation, at behavioural parity with the TypeScript and C# sides in what it holds:
the same behaviour, played from the same conformance files in [`spec/`](../../spec/), and proven
against the other sides in the interop. It holds the envelope's codec; the client and server routers
with their service, session and notification managers, and the service layer, its server half and
its client half; sessions and credentials with a `JWT`'s verification; the clock it is given and
every duration held as spec 1.4 holds it; the trace, the filter and the registry, and a
participant's trace of its parcels; the WebSocket and HTTP transports, server and client, features
of the core over tokio's sockets, and the in-memory transport; the broker's core over an in-memory
broker, its MQTT 5 binding, a feature of the core and a client of its own, and the joined transport;
and the `proto` payload's codec on Buffa — playing every conformance file it reaches, each part it
lacks a row of [`docs/support.md`](../../docs/support.md)'s differences, ahead with the stage that
brings it. The rules its code keeps — one owner per router, traits and composition, no unsafe code,
two parameters then an options struct, every warning an error — are
[decision 0044](../../docs/decisions/0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)'s;
its sockets are
[decision 0049](../../docs/decisions/0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)'s,
its broker bindings
[decision 0050](../../docs/decisions/0050-the-rust-sides-broker-bindings-are-features-of-its-core-and-mqtt-5-a-client-of-its-own-over-its-sockets.md)'s.

## Build and test

Rust 1.99.1 and edition 2024, as `rust-toolchain.toml` pins them, which rustup installs with clippy,
rustfmt and llvm-tools, and the target `wasm32-unknown-unknown`. The core is pure Rust; its socket
transports' TLS, aws-lc-rs, is built by the platform's C compiler, so a build with `websocket`,
`http` or `mqtt`, the workspace's among them, needs one: on Windows, the MSVC build tools, their C
compiler and their linker; or the GNU host, with a MinGW-w64's `dlltool` on the `PATH`, which
`windows-sys` asks of it. From this folder:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked
cargo clippy --workspace --all-targets --locked
cargo clippy -p francisdesjardins-bead --lib --locked
cargo clippy -p francisdesjardins-bead --lib --features websocket --locked
cargo clippy -p francisdesjardins-bead --lib --features http --locked
cargo clippy -p francisdesjardins-bead --lib --features mqtt --locked
cargo clippy -p francisdesjardins-bead --lib --features testing --locked --target wasm32-unknown-unknown
cargo test --workspace --all-features --locked
cargo doc --workspace --no-deps --all-features --locked
cargo build --workspace --locked
cargo deny --locked check
cargo deny --manifest-path fuzz/Cargo.toml --locked check
cargo deny --manifest-path tools/protobuf-conformance/Cargo.toml --locked check
cargo deny --manifest-path tools/protovalidate-differential/Cargo.toml --locked check
cargo deny --manifest-path ../../examples/hello/rust/Cargo.toml --locked check
```

The second lints each member on its default features. The third to the sixth lint the core's
library with no feature and with each transport's alone, `websocket`, `http` and `mqtt` (decisions
0049, 0050), so that each builds on its own. The seventh
checks the core for the browser's WebAssembly, never runs it, by its features, no socket and no
broker binding among them:
what the core links builds there, and `.cargo/config.toml` gives getrandom its `unsupported` backend
on that target alone, so that no dependency is added for it.

Every warning of rustc, clippy and rustdoc is an error, by `.cargo/config.toml`'s `[build] warnings
= "deny"`, as `TreatWarningsAsErrors` is on the C# side; `CARGO_BUILD_WARNINGS=warn` releases one
run. `cargo build --workspace` builds the core on its default features alone, where what the test kit
alone reaches is left out. `cargo deny` holds the dependencies to RustSec's advisories, the licences
`deny.toml` allows, crates.io alone, and one version of each, in the workspace and in the projects
outside it, each by its own lock: the fuzz targets, the conformance player, the protovalidate
differential's testee and `examples/hello`'s Rust half, every one from this folder, so that the
workspace's `deny.toml` is theirs.

`bead-protobuf`'s tests read and write messages Buffa generates in its build script from
`crates/bead-protobuf/proto/tests.binpb`, the set protoc writes of their `.proto` files at
[`builder/protoc.json`](../../builder/protoc.json)'s pin: no Rust build runs protoc. `node
tools/check-protobuf.mjs` writes the set again, apart, and fails on a difference; `--write` writes it
in place, after a change of a file it holds. protoc is `BEADC_PROTOC`, or the one
`builder/tools/fetch-protoc.mjs` fetches.

The coverage, as CI measures it, lines and regions, held to the side's floor in
[`tools/coverage-floors.json`](../../tools/coverage-floors.json):

```sh
cargo llvm-cov --workspace --all-features --locked --json --summary-only --ignore-filename-regex '([/\\]tests\.rs|[/\\]tests[/\\].*|[/\\]testing\.rs|[/\\]testing[/\\].*|[/\\]generated[/\\].*|[/\\]crates[/\\]bead-goldens[/\\].*)$' --output-path coverage/rust.json
node ../../tools/coverage-report.mjs coverage/rust.json --under implementations/rust/crates/bead/src --under implementations/rust/crates/bead-protobuf/src --floor rust
```

## Features

`francisdesjardins-bead` builds its core with no feature, and each feature adds to it, as Cargo's
features are additive:

- `websocket`: the WebSocket transport, server and client (RFC 6455), on tungstenite, its server
  reading its own head; `WebSocketServer` and `WebSocketClient` over them;
- `http`: the HTTP transport, server and client (RFC 9110, 9112), on hyper, HTTP/2 beside HTTP/1.1
  under TLS on the server (RFC 9113); `HttpServer` and `HttpClient` over them;
- `mqtt`: MQTT 5 over a broker (decision 0041), a client of Bead's own over TCP, TLS or a WebSocket
  of subprotocol `mqtt`, its upgrade and its frames its own; `MqttBrokerAdapter` over it, and its
  defaults, `MQTT_CONNECT_TIMEOUT` among them;
- `testing`: the test kit, `bead::testing`, which the tests alone turn on: no API.

Each of `websocket`, `http` and `mqtt` brings TLS on rustls over aws-lc-rs, a client verifying by
the platform's own verifier, and `bead::rustls`, the rustls it builds, for an application's
`ServerConfig` or `ClientConfig`. What judges a request, a head, a target, a host, an origin and a
WebSocket's handshake, is always built, as is the HTTP policy, so the fuzz targets reach it with no
feature.

## Listening and proxies

A WebSocket or HTTP server listens on `localhost` unless its `TransportServerStartOptions` gives
an `address`: both loopbacks, `127.0.0.1` and `::1`, on one port (spec 15.12). Where the IPv6
loopback is absent, it listens on `127.0.0.1` alone and reports that address. A container, or any
server another machine reaches, says `0.0.0.0` or `::` and names its hosts in `hosts`: a
container's loopback is its own, which a published port never reaches. An address given is
`localhost` or an IP address written bare, `::1`, not `[::1]`; any other name fails the start, a
`ProgrammerError`. On the loopback it is secure (spec 13.4); behind a proxy on the same machine
that serves the network in the clear, its options say `secure: Some(false)`
([decision 0024](../../docs/decisions/0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)).

Behind a proxy, a server over HTTP or WebSocket believes `X-Forwarded-For` from the proxies
`trusted_proxies` names, each an IP address or a network in CIDR, `10.0.0.0/8` say, or the compose
network's, and as many more as `unnamed_proxies` counts. From the socket's address it walks the
field from the right: while the address reached is listed, or is unlisted and fewer than the
count have been passed, the next entry is the client's. What a client wrote to the left of the
first unlisted address past the count is never read. None trusts no proxy, the loopback among
them. `Forwarded` is never read. The address reached names the connection's handle, its `clients`
entry and its refusals; its port stays the socket's. Each entry is read in RFC 7239's node forms,
its port dropped, IPv4-mapped as IPv4 and IPv6 as RFC 5952 writes it; an entry that does not read
ends the walk at the proxy that wrote it.

A deployment lists its proxy's network, a container's ingress or a sidecar on `127.0.0.1` among
them. A proxy whose platform does not publish its addresses is counted, `unnamed_proxies`, from
0 to 8, 0 by default. A listed proxy costs none of that count, wherever it stands: the count is
of the proxies the list does not name alone. A name, a network whose bits past its prefix are
set, a network of prefix 0, or a count past 8 is a `ProgrammerError` as the transport is built.
A request that reaches the socket past a counted proxy is read by entries its client wrote, so a
server reachable without that proxy lists its proxies instead
([decision 0030](../../docs/decisions/0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md)).

A proxy neither listed nor counted is a client as any other: each client behind it is its
address. `maximum_connections_per_address` counts it, so a refusal whose address is the proxy's,
or `largestAddressConnections` near its ceiling, is a proxy to list. A bound by address counts
the users behind one NAT as one and the addresses of an IPv6 network as many.

```rust
use bead::HttpTransportServerOptions;

// a sidecar on the loopback, listed, and a router before it, its addresses unpublished, counted
let mut options = HttpTransportServerOptions::default();
options.trusted_proxies = Some(vec!["127.0.0.1".to_owned()]);
options.unnamed_proxies = Some(1);
```

## Layout

A virtual workspace, its packages `francisdesjardins-bead*`, their libraries `bead*`, none published
(`publish = false`):

```
crates/
  bead/                         the core: the library, its unit tests beside each module, the test
                                kit, and the conformance players under tests/
  bead-protobuf/                the `proto` payload's codec on Buffa 0.9.2: the check of a payload's
                                records, the required walk, the typed codec over Buffa's generated
                                code and the dynamic one over its `DynamicMessage`; the validators'
                                runtime beadc's generated rules judge by; its tests' `.proto` files
                                and their set under proto/, and beadc's validators of
                                spec/validations.proto under tests/generated/
  bead-protobuf-build/          Bead's setting of Buffa's generator, for a build script: views,
                                reflection, and each repeated or map field of a closed enum opened
  bead-interop/                 the interop service: its descriptors and classes, which beadc
                                generates from spec/interop-blueprint.json into src/generated/; its
                                resolvers and its credentials
  bead-goldens/                 beadc's Rust goldens, builder/test/golden/rust, each output mounted
                                whole under the workspace's lints, and under tests/ the consumer's
                                refusals and the messages' parity with config_of
  bead-interop-server/          the interop service's server, bead-interop-server, over WebSocket
                                and HTTP, and over MQTT 5 where BEAD_MQTT_URL names a broker,
                                which the other sides' clients call; and under tests/, the Rust
                                client's trials against each side's server
  bead-house/                   the side's own checks that no lint holds: the parameter rule, the
                                options struct's shape, each library crate's public surface
                                against its list under surfaces/, no tuple on that surface, the
                                count of the tuples of three elements or more a function takes,
                                the errors a future of a Result documents, the comment tags, every
                                member under the workspace's lints
benches/                        bead-bench, the in-memory bench, written as bead-bench/1
fuzz/                           cargo-fuzz's targets, a project outside the workspace
tools/protobuf-conformance/     the testee of protobuf's conformance suite, which
                                tools/protobuf-conformance.mjs rust builds and runs, and its
                                failure list, failing.txt
tools/check-protobuf.mjs        the check of the tests' descriptor set, as protoc writes it
```

## The runtime

Bead takes the application's tokio runtime and starts none of its own: the runtime enables its time
driver, by `enable_all` or `enable_time`, or a router, the in-memory transport and broker, a
broker's participant and `SystemClock` refuse to be built on it, the runtime given or the current
one; a socket's transport asks its IO driver too, by `enable_all` or `enable_io`, and refuses
likewise. Each router is one owner, a task of that runtime that holds its state and runs its jobs
one at a time, in the order they came; an operation goes as it is made, and dropping its future
cancels nothing. A router's transport holds it, so it lives as long as its connection does, its last
handle dropped or not; one that neither its application nor its transport holds ends with its owner,
but a resolver a service manager registered holds that manager, and so its router, which then ends
by its dispose. A job that panics past the guards of the sites the spec lets throw ends its router
at once, each call it waits on failed with that panic for its reason. A server over a socket serves
until its stop or its dispose while a connection it serves holds it; idle, its last handle dropped
lets its port go.

The core spawns, yields and resolves a name through one private module, `platform`, and reads time
through its clock alone (decision 0011): clippy's `disallowed-methods` and `disallowed-types`, in
`clippy.toml`, refuse tokio's spawns, its yield, its resolver and its timers, std's `Instant`,
`SystemTime::now` and a thread of Bead's own anywhere else. A test takes them from the kit, `bead::testing`'s `spawn`, `yield_now`,
`rest`, `patience`, `Instant` and `wall_now`; a native target, the benches, the interop or a player
that measures real time, is exempted once, at its root, with its reason.

## Modules

`crates/bead/src`:

| Module                                                         | What it holds                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envelope`                                                     | an envelope's codec: its prefix, its header and its blocks, a failure's record, and the envelope whole                                             |
| `constants`, `failure`, `errors`                               | the wire's values, a failure as a router raises or receives it, and the errors beside it                                                           |
| `identity`, `duration`, `clock`                                | a procedure's identity (spec 16), every duration held as spec 1.4 holds it, the clock a side is given (decision 0011)                              |
| `payloads`, `json`, `violations`                               | the codecs of spec 17, `raw`, `text` and `json`; a `json` value's reader and writer; `PAYLOAD_INVALID`'s detail (spec 18)                          |
| `router`                                                       | the core both routers share, the client's and the server's, the relay, the admissions Bead gives, and transfers                                    |
| `owner`                                                        | one owner per router: its jobs from one queue, in order, what a turn defers and what a listener makes within it at the tail                        |
| `platform`                                                     | what the core spawns on, the application's tokio runtime, its time driver checked, a socket's IO driver too: the one place it spawns               |
| `managers`                                                     | the service manager, a server's notifications and their pacing, its sessions                                                                       |
| `service`                                                      | a service's procedures as typed descriptors, its failures, and the service server                                                                  |
| `server`, `client`                                             | a server, and a client: a transport, its router and its services, built together                                                                   |
| `credentials`, `jwt_verifier`, `session_token`, `call_session` | what resolves a `JWT` and an `ELSEWHERE`, a `JWT`'s verification (spec 13.8), a session's token, a call's session                                  |
| `transport`, `memory`                                          | what a router takes its envelopes from and hands them to, and the in-memory transport (spec 15.13)                                                 |
| `life`                                                         | the life every transport server shares: its ready state, and the guards around its start, its stop and its dispose                                 |
| `websocket`                                                    | the WebSocket transport (spec 15.2, 15.3), behind `websocket`: its server, its client, the connection either end runs, its heartbeat, its facades  |
| `http`                                                         | the HTTP transport (spec 15.4 to 15.11), behind `http`: its server, on hyper, its client, its exchanges and fields, its facades                    |
| `mqtt`                                                         | MQTT 5 over a broker, behind `mqtt`: its packets, written and read, its link, its quota, its adapter, over TCP, TLS or a WebSocket                 |
| `net`                                                          | what a transport over a socket does alike: `localhost` bound, a socket's bounds, a close in stages, a name's addresses raced, TLS                  |
| `judgement`, `http_policy`                                     | what a server judges of a request, pure and always built: a head, a target, a host, an origin, proxies, a handshake; and the HTTP policy           |
| `broker`                                                       | the broker's core: its participant, its parcel, its sequence, its heartbeat, its transports and the in-memory broker                               |
| `joined`                                                       | the joined transport, a server's transports through one (spec 15.14)                                                                               |
| `debug`, `metrics`                                             | the trace and the `debug` filter, a participant's trace of its parcels (debugging 13), and the metrics registry (`spec/debugging.md`)              |
| `base64url`, `ordered`                                         | base64url without padding, read strictly (RFC 4648 §5), and a map that keeps the order its keys first came in, as the other sides' walks follow it |
| `testing`                                                      | the test kit, behind the feature `testing`: no API                                                                                                 |

`bead::json::to_value` is a resolver's road from a type of its own to a `json` value: Bead's own
serializer, which refuses a double that is not finite at any depth, where `serde_json`'s writes
`null`.

Each server transport takes the procedures it is given, by their addresses, `ProcedureAddress`
(spec 9.11, decision 0048): `MemoryTransportServerOptions::procedures`, and a broker's
`BrokerTransportServerOptions::procedures` on every name it serves, `procedures_by_name` giving a
name its own list in place of it, for a connection its OPEN reached by that name. A request to any
other that names no destination is answered as one to no resolver, `SERVICE_UNKNOWN` or
`PROCEDURE_UNKNOWN`, before its credential, its admission and its payload, and counts under its
procedure's series. None given, it takes every procedure; empty, none; an address of service 0 or
of procedure 0, the only ones a `u16` holds out of range, is refused as the transport is built, a
`ProgrammerError`, as is a list for a name the broker's transport does not serve, and one named
twice is one (spec 9.12). Its router asks `ServerTransport::names_procedures`, `false` for a
transport given no list, once as it is built, then `takes_procedure` of each request that names no
destination, or never; a `JoinedServerTransport` names them when one of its transports does, and
asks the transport that drew each handle. beadc's Rust target writes the lists in an output's
`bead_served.rs`, `SERVED_PROCEDURES`, as the other sides' targets do (decision 0051). What a
transport takes is no access: it grants none, and each procedure keeps its own admission.

`crates/bead-protobuf/src`:

| Module     | What it holds                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records`  | a message's schema, read once from its descriptors, and the check of a payload's records against it (spec 17.9.1 to 17.9.6)                                                                                     |
| `required` | the walk of the fields protobuf requires (spec 17.9.7), over a view or a dynamic message, whose presence is the wire's or the application's, and a writer's depth pass (17.9.3), each 100 messages deep at most |
| `refusal`  | a refusal's reasons in spec 17.2's words, what more the side knows in its cause                                                                                                                                 |
| `codec`    | `ProtoCodec`, the typed codec of a message Buffa generates, and `DynamicCodec`, by its descriptor alone, each a payload codec of `proto`                                                                        |
| `validate` | the validators' runtime (spec 18, decision 0051): `validator_of`, the sink a message's generated rules judge into, its rules' sites, a pattern's table and its walk, and the readings spec 18.8 fixes           |
| `testing`  | the test kit, behind the feature `testing`: the tests' messages, generated from `proto/tests.binpb`; no API                                                                                                     |

A message an application binds to `proto` is generated as `bead-protobuf-build` sets Buffa's
generator, from a `FileDescriptorSet` its build writes; `ProtoCodec` reads it through its view,
which tells a field given from one left out, and gives the owned message. An owned message holds a
required scalar bare, so no typed value leaves one unset; `DynamicCodec`, its value Buffa's
`DynamicMessage`, is the form that can, and refuses it. `ProtoCodec::new` refuses a message whose
generator left a repeated or map field of a closed enum closed, which `bead-protobuf-build` opens.

## Tests

A module's unit tests are beside it, `src/envelope.rs`'s in `src/envelope/tests.rs`; a twin test,
one the other sides hold by the same sentence, is named by it in snake case, the unit of the spec it
holds in a comment just above it, `// spec 15.13`, which `spec/check.py` reads. The conformance
players are in `crates/bead/tests/`, one file a conformance file, a trial per entry named by the
entry's own name, under `libtest-mimic`; the `proto` entries of `spec/codecs.json` are played in
`crates/bead-protobuf/tests/codecs.rs`, the same way, through both codecs, and
`spec/transcoding.json` in `crates/bead-protobuf/tests/transcoding.rs`, its exchanges through a
gateway on its own listener over a real socket, but the one its `differs` excuses the side from.
The gateway's and the caller's twins are `crates/bead/tests/gateway.rs` and `tests/caller.rs`.

`bead::testing`, behind the feature `testing`, is the test kit: the stepping clock the players give
the side, the conformance files' typed readers, the durations' helper, a pair of the in-memory
transport, the scripted transports the unit tests write bytes on, the seeded mutations the suite's
readers are fed, and what a test takes from its platform: a task spawned, a turn yielded, a rest, a
patience, a monotonic instant and the wall clock's reading. It is no API: an application never turns
the feature on. What the conformance players, the fuzz targets, the interop service and the bench
reach that the API does not offer, the envelope's codec among it, is `bead::internal`, hidden from
the docs and outside SemVer, as the C# side's members reach theirs by `InternalsVisibleTo`; no
feature turns it on.

What plays against a real broker of MQTT 5 — the cases over MQTT 5 in `tests/transports.rs`, the
adapter's twins against the broker in `src/mqtt/tests/fixture.rs`, the interop over MQTT 5 — needs
one given by `BEAD_MQTT_URL`, and `BEAD_MQTT_WS_URL` for the adapter's link over a WebSocket, each
link made as the broker's users with the run's password, `BEAD_MQTT_PASSWORD`; it is skipped,
saying so, where none is, and `BEAD_MQTT_REQUIRED=1` fails it instead. The root's
[`tools/mqtt-broker.mjs`](../../tools/mqtt-broker.mjs) starts a Mosquitto of the run's own and stops
it whatever the command's end:

```sh
node ../../tools/mqtt-broker.mjs run -- cargo test -p francisdesjardins-bead --features testing,mqtt --locked --test transports
node ../../tools/mqtt-broker.mjs run -- cargo test -p francisdesjardins-bead --features testing,mqtt --locked --lib mqtt::
```

The interop runs from `crates/bead-interop-server`: its trials, `cargo test -p
francisdesjardins-bead-interop-server --test interop`, a trial a case, a transport and a server,
named by the TypeScript side's sentence in snake case, play the Rust client against the TypeScript,
C# and Rust servers, over WebSocket, over HTTP and, where `BEAD_MQTT_URL` names a broker, over
MQTT 5, once `BEAD_INTEROP_RUST=1` asks, and are ignored otherwise, saying so; the
other sides' interop tests start the binary `BEAD_INTEROP_RUST_SERVER` names
([the root README](../../README.md#interop-both-ways)). `BEAD_HOUSE_WRITE=1 cargo test -p francisdesjardins-bead-house` writes each
crate's list of its public items anew, its diff the change's to review.

## Fuzzing and the bench

`node ../../tools/fuzz.mjs build rust`, then `run rust
envelope|payload-codecs|http-fields|debug-filter|jwt|ws-handshake|broker-parcel|proto-codecs|mqtt-packets|mqtt-websocket-frames`,
fuzzes the side's ten targets with cargo-fuzz on the nightly the tool pins by its date, on Linux or
WSL: the eight every side shares, `mqtt-packets`, its MQTT 5 client's reader of a broker's packets,
and `mqtt-websocket-frames`, its reader of an MQTT 5 WebSocket's frames, the Rust side's alone, since
the other sides read a broker's bytes through MQTT.js and MQTTnet.
[`fuzz.yml`](../../.github/workflows/fuzz.yml) runs the ten every week, each ten minutes, its corpus
kept between runs ([the root README](../../README.md#fuzzing)).
`crates/bead/tests/envelope_fuzz.rs` and `broker_parcel_fuzz.rs` feed the envelope readers and the
parcel's seeded mutations of `spec/vectors.json` in the suite, from `bead::testing::mutations`, the
generator every side shares; `mqtt_packets_fuzz.rs` feeds the MQTT 5 packets' reader seeded
mutations of its own packets, and `mqtt_websocket_frames_fuzz.rs` the WebSocket's frame reader
seeded mutations of its own frames. `node ../../tools/bench-release.mjs rust` runs bead-bench in fresh
processes, from its release build: the envelope's codec, a request written and read back, calls on
one in-memory connection kept, exchanges, each a client and its connection drawn, called once and
closed, and protobuf's JSON read and written by Bead's mapping beside Buffa's own;
[`bench.yml`](../../.github/workflows/bench.yml) compares it with the last release's on every push
to a release or hotfix branch. `cargo run --release --locked --manifest-path benches/Cargo.toml --
--scale` measures instead a message's cost through a router alone and through a `Server`, each
holding 1, 1,000 and 10,000 connections, and fails unless it holds flat.
