# Bead, on the Rust side

Bead is a binary wire protocol: the envelopes of a request, its result or failure, the notifications
of a subscription and the commands a server sends back, written at fixed offsets. This workspace is
its Rust implementation, at parity with the TypeScript and C# sides: the same behaviour, played from
the same conformance files in [`spec/`](../../spec/). It holds the core today — the envelope's codec,
the client's and the server's routers with their service, session and notification managers and the
service layer, sessions and credentials with a `JWT`'s verification, the clock it is given and every
duration held as spec 1.4 holds it, the trace, the filter and the metrics registry, and the in-memory
transport — and plays every conformance file the core reaches; what it does not play yet is a row of
[`docs/support.md`](../../docs/support.md)'s differences, each ahead with the step that brings it. The
rules its code keeps — one owner per router, traits and composition, no unsafe code, two parameters
then an options struct, every warning an error — are [decision
0044](../../docs/decisions/0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)'s.

## Build and test

Rust 1.99.1 and edition 2024, as `rust-toolchain.toml` pins them, which rustup installs with clippy,
rustfmt and llvm-tools. On Windows, the MSVC build tools' C++ linker, and no C compiler beyond it,
the core being pure Rust. From this folder:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked
cargo test --workspace --all-features --locked
cargo deny --locked check
```

Every warning of rustc, clippy and rustdoc is an error, by `.cargo/config.toml`'s `[build] warnings
= "deny"`, as `TreatWarningsAsErrors` is on the C# side; `CARGO_BUILD_WARNINGS=warn` releases one
run. `cargo build --workspace` builds the core on its default features alone, where what the test kit
alone reaches is left out. `cargo deny` holds the dependencies to RustSec's advisories, the licences
`deny.toml` allows, crates.io alone, and one version of each.

The coverage, as CI measures it, lines and regions, held to the side's floor in
[`tools/coverage-floors.json`](../../tools/coverage-floors.json):

```sh
cargo llvm-cov --workspace --all-features --locked --json --summary-only --ignore-filename-regex '(/tests\.rs|/tests/.*|/testing\.rs|/testing/.*)$' --output-path coverage/rust.json
node ../../tools/coverage-report.mjs coverage/rust.json --under implementations/rust/crates/bead/src --under implementations/rust/crates/bead-protobuf/src --floor rust
```

## Layout

A virtual workspace, its packages `francisdesjardins-bead*`, their libraries `bead*`, none published
yet (`publish = false`):

```
crates/
  bead/                         the core: the library, its unit tests beside each module, the test
                                kit, and the conformance players under tests/
  bead-interop/                 the interop service: its descriptors, written by hand as beadc's Rust
                                target will write them from spec/interop-blueprint.json, its
                                resolvers and its credentials
  bead-house/                   the side's own checks that no lint holds: the parameter rule, the
                                comment tags, every member under the workspace's lints
benches/                        bead-bench, the in-memory bench, written as bead-bench/1
fuzz/                           cargo-fuzz's targets, a project outside the workspace
```

## The runtime

Bead takes the application's tokio runtime and starts none of its own: the runtime enables its time
driver, by `enable_all` or `enable_time`, or a router refuses to be built on it. Each router is one
owner, a task of that runtime that holds its state and runs its jobs one at a time, in the order
they came; an operation goes as it is made, and dropping its future cancels nothing. A router's
transport holds it, so it lives as long as its connection does, its last handle dropped or not.

## Modules

`crates/bead/src`:

| Module                                                         | What it holds                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `envelope`                                                     | an envelope's codec: its prefix, its header and its blocks, a failure's record, and the envelope whole                    |
| `constants`, `failure`, `errors`                               | the wire's values, a failure as a router raises or receives it, and the errors beside it                                  |
| `identity`, `duration`, `clock`                                | a procedure's identity (spec 16), every duration held as spec 1.4 holds it, the clock a side is given (decision 0011)     |
| `payloads`, `json`, `violations`                               | the codecs of spec 17, `raw`, `text` and `json`; a `json` value's reader and writer; `PAYLOAD_INVALID`'s detail (spec 18) |
| `router`                                                       | the core both routers share, the client's and the server's, the relay, the admissions Bead gives, and transfers           |
| `owner`                                                        | one owner per router: its jobs in their order, a job posted within a turn going as that turn ends                         |
| `managers`                                                     | the service manager, a server's notifications and their pacing, its sessions                                              |
| `service`                                                      | a service's procedures as typed descriptors, its failures, and the service server                                         |
| `server`, `client`                                             | a server, and a client: a transport, its router and its services, built together                                          |
| `credentials`, `jwt_verifier`, `session_token`, `call_session` | what resolves a `JWT` and an `ELSEWHERE`, a `JWT`'s verification (spec 13.8), a session's token, a call's session         |
| `transport`, `memory`                                          | what a router takes its envelopes from and hands them to, and the in-memory transport (spec 15.13)                        |
| `debug`, `metrics`                                             | the trace and the `debug` filter, and the metrics registry (`spec/debugging.md`)                                          |
| `testing`                                                      | the test kit, behind the feature `testing`: no API                                                                        |

`bead::json::to_value` is a resolver's road from a type of its own to a `json` value: Bead's own
serializer, which refuses a double that is not finite at any depth, where `serde_json`'s writes
`null`.

## Tests

A module's unit tests are beside it, `src/envelope.rs`'s in `src/envelope/tests.rs`; a twin test,
one the other sides hold by the same sentence, is named by it in snake case, the unit of the spec it
holds in a comment just above it, `// spec 15.13`, which `spec/check.py` reads. The conformance
players are in `crates/bead/tests/`, one file a conformance file, a trial per entry named by the
entry's own name, under `libtest-mimic`.

`bead::testing`, behind the feature `testing`, is the test kit: the stepping clock the players give
the side, the conformance files' typed readers, the durations' helper, a pair of the in-memory
transport, and the scripted transports the unit tests write bytes on. It is no API: an application
never turns the feature on.

## Fuzzing and the bench

`node ../../tools/fuzz.mjs build rust`, then `run rust envelope|payload-codecs|debug-filter|jwt`,
fuzzes the core's four targets with cargo-fuzz on the nightly the tool pins by its date, on Linux or
WSL; the transports' two come with them. `node ../../tools/bench-release.mjs rust` runs bead-bench in
fresh processes, from its release build: calls on one in-memory connection kept, and exchanges, each
a client and its connection drawn, called once and closed.
