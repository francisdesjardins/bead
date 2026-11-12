# 0044 — The Rust side owns each router's state in one task, starts each operation as it is made, composes traits, forbids unsafe code, takes two parameters and an options struct, and builds without a warning

- **Status**: accepted
- **Scope**: the Rust side, `implementations/rust`, its core with no socket feature
  ([0036](0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md)):
  the envelope's and a parcel's codecs, the routers, client and server, the managers and the service
  layer, its server half and its client half, sessions and credentials with a `JWT`'s verification,
  the clock and the durations, the trace, the filter and the registry and a participant's trace of
  its parcels, the transports' generic part, the in-memory transport and the interop service; the
  broker's core, the in-memory broker and the joined transport; the `proto` payload's codec, on
  Buffa; and every conformance file the core plays over them; the workspace, its toolchain, its
  lints, its gates, its CI job and its coverage floor; and the Rust side as a partial side, whose
  rule is [0004](0004-one-behaviour-in-every-language.md)'s. This record is
  [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)'s twin for Rust, each rendering
  for its sides the public surface [0047](0047-every-side-shows-one-public-surface.md) shapes; the
  toolchain's place is [0005](0005-a-toolchain-per-language.md)'s, the names and the versions
  [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)'s, a clock
  [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)'s, a duration
  [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s, a `json` payload
  [0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)'s, and what an application
  makes from within a telling and a dispose's two marks, on every side,
  [0045](0045-a-router-takes-what-its-application-makes-in-one-queue-behind-the-turn-that-tells-it.md)'s,
  and a connection's reads paced by what its router has not taken, on every side,
  [0046](0046-a-router-paces-each-connections-reads-by-what-it-has-not-taken.md)'s. Its transports
  over sockets, WebSocket (RFC 6455) and HTTP/1.1 and HTTP/2 (RFC 9110, 9112, 9113), features of its
  core, with the interop both ways with the TypeScript and C# sides, are
  [0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)'s.
  Its broker bindings, MQTT 5 and AMQP 1.0, features of its core, are
  [0050](0050-the-rust-sides-broker-bindings-are-features-of-its-core-and-mqtt-5-a-client-of-its-own-over-its-sockets.md)'s.
  Ahead: beadc's Rust target, with `examples/hello`'s Rust half, the lists of the procedures a
  server's transports take
  ([0048](0048-one-contract-gives-several-packages-and-a-servers-transport-takes-the-procedures-it-is-given.md))
  and the validators of a blueprint's rules generated for it, or beadc refusing to generate them
  ([0035](0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md));
  its gateway; and its AMQP 1.0 binding, each stage under a record of its own. The crate's layout and its modules are its README's.

## Context

Rust is Bead's third language, at parity with the TypeScript and C# sides, its surface mapping
almost name for name, its tests answering to the same conformance files. Rust's own norms meet the
house's at every line: no exceptions but a `Result`, no base class but traits, no garbage collector
but ownership, no runtime but the application's. Carrying JavaScript's or .NET's idioms over word
for word fights the language; taking Rust's defaults alone makes three designs of one.

**The toolchain, verified from the channel manifest**
(`https://static.rust-lang.org/dist/channel-rust-stable.toml`, dated 2026-10-15): Rust 1.99.1
(2026-10-13), cargo 0.100.0, clippy 0.1.99, rustfmt 1.10.0. Edition 2024 is the newest: 1.99.1's
`--edition` takes 2015 to 2024 or `future`, and refuses 2027. Cargo's resolver 3, MSRV-aware
(RFC 3537), is edition 2024's default. The `[lints]` table (RFC 3389) holds a policy for every
crate of a workspace; Cargo's `[build] warnings = "deny"` makes every warning of rustc, of clippy
and of rustdoc an error of the build, `CARGO_BUILD_WARNINGS` its environment form.

**The two sides run one turn at a time**: JavaScript's one thread, deferring by `queueMicrotask`;
the C# side's `SerialScheduler`, a `TaskScheduler` of concurrency 1 on the thread pool, its explicit
form ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)). A promise and a `Task`
have started when their call returns: both sides draw a call's id and send it in the order calls
are made. An `async fn` in Rust does nothing until it is first polled: probed, calls written so
send in the order they are awaited, `[2, 1]`, and a future dropped unpolled sends nothing.

**What the registry and the libraries hold, probed**: `serde_json` 1.0.154 refuses `"a\ud800b"`
outright, keeps the last of a name given twice, caps its depth at 128, and writes NaN as `null`
through `Value::from`, `json!`, `to_value` and `to_string` alike; of `spec/codecs.json`'s 24 doubles
written, Rust's `Display` spells 13 as RFC 8785 does, `serde_json` 15, `ryu-js` 1.0.3 all 24.
`Duration::from_secs_f64` rounds to the nanosecond: no input of `spec/durations.json` lies near a
half for it, and none is finer than its tick. On stable, `-C instrument-coverage` counts lines and
regions, a region for every way a decision can go, and no branch; the nightly's
`-Z coverage-options=branch` counts `if`, `if let`, `let else`, `&&` and a guard, and no `match` arm
and no `?`, which are how a codec and a router decide. A runtime built without tokio's time driver
passes `Handle::try_current()`, and tokio panics as a timer is armed. Clippy's `too_many_arguments`
counts the receiver.

**The options weighed, and not taken**:

- **An executor abstraction** over several runtimes: a second way to spawn, time and cancel, for
  runtimes no side's user asked for; tokio, the ecosystem's, is the application's runtime. As a
  public trait it costs a box and a virtual call per spawn, 60 to 84 ns measured, and its future's
  `Send` is a promise to freeze.
- **The browser platform built with the core**, the core's executor, clock and tests in a page, its
  shape designed (Consequences, Ahead) and not built: no consumer asks for it, and nothing on the
  native surface waits on it. The funnel, its gate and the browser target's check keep the door
  open, while the platform would bring a test host's dependencies into every native test build, a
  second body of `SystemClock`, a test job and its driver, and rows of the matrix stating a platform
  no application uses.
- **A bounded queue** per router: a backpressure of Rust's alone, where JavaScript's microtasks and
  the C# scheduler are unbounded. Bead's own bounds, `maximumAnsweringCalls`, credit and the limits
  of spec 12.2, bound the work a turn takes, judged as it takes it; none bounds what waits for that
  turn. A bounded queue alone would only move that wait into the transport, which cannot learn that
  its router is behind: a bound on what waits is a pace on a connection's reads,
  [0046](0046-a-router-paces-each-connections-reads-by-what-it-has-not-taken.md)'s.
- **An operation as an `async fn`**: it sends nothing until polled, sends in await order, and
  nothing when its future is dropped unpolled, where both other sides send as the call is made.
- **Cancel on drop**, much of Rust's ecosystem's way: neither other side can, so Rust keeps to what
  all do, and cancels by the `CancellationToken` of its options, spec 10's CANCEL.
- **An enum for never**, `After(Duration)` or `Never`: a second type at every place, and a delay's
  never, which spec 1.4 refuses, a type error where the other sides report a refusal.
- **Options without `#[non_exhaustive]`**: Cargo's SemVer reference makes a public field added to a
  struct with no private field a major change, and the attribute added later a major change too.
- **Closed enums for open code spaces**: a `#[repr(u16)]` enum cannot hold a code spec 8.1 keeps
  as a number.
- **`serde_json` as the reader and as `to_value`**: it refuses a surrogate alone that a `JWT`'s
  verdict reads as a value, keeps a name twice, and writes a NaN as `null`.
- **A test kit in a crate of its own**: a unit test beside its module cannot use it, the kit
  depending on the core (two copies of the crate, `E0277`), and a plain build turns its feature on.
- **Branch coverage on a nightly**: a hand-moved pin and an unstable flag, to measure less.
- **Warnings denied in the lints table**: it breaks the nightly legs on any warning a newer rustc
  adds, and holds no rustdoc warning.
- **Debugging left out by Cargo features**: a Z the other sides lack, and a second build.
- **aws-lc-rs**, rustls' default provider, for the core's crypto: C and assembly, a native build and
  no Miri; the socket features' TLS alone takes it
  ([0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)).
- **cargo-nextest**: a second runner, where Cargo's own runs the doc tests among the rest.
- **A minimal beadc target with the core** for the interop's descriptors: beadc's Rust target is a
  stage of its own, ahead, which generates them; the descriptors are written by hand and held to the
  blueprint.

## Decision

### The core, and the stages after it

| Crate                                                     | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                  | What it plays                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bead`, `bead-interop`                                    | `bead`: the envelope's codec, the routers, the service layer, its server half and its client half, its managers, sessions, credentials and a `JWT`'s verification, the clock and the durations, the trace, the filter and the registry, the transports' generic part, the in-memory transport, the client and server facades, `bead::json`, and the test kit `bead::testing` behind the feature `testing`; `bead-interop`, the interop service | `spec/vectors.json` but its broker's groups; `spec/conversations.json` through a scripted transport and through the in-memory pair; `spec/clocks.json`; `spec/durations.json` but its transports' places; `spec/identities.json` but the ids no `u16` and no `u32` holds; `spec/codecs.json`'s `raw`, `text` and `json` entries; `spec/debug-filters.json` and `spec/metrics.json` whole; `spec/validations.json`'s details; the spec's and the companion's twins but those of its transports |
| `bead`                                                    | the broker's core, its participant and the trace of its parcels, its parcel, its sequence, its heartbeat and its transports, the in-memory broker, the joined transport                                                                                                                                                                                                                                                                        | `parcels` and `parcelRefusals`; the cases over the in-memory broker of `spec/transports.json`; the conversations through a broker pair; the broker's places of `spec/durations.json`; spec 15.14's twins                                                                                                                                                                                                                                                                                      |
| `bead-protobuf`                                           | the `proto` payload's codec, on Buffa 0.9.2: the check of a payload's records, the required walk, the typed codec and the dynamic one                                                                                                                                                                                                                                                                                                          | `spec/codecs.json`'s `proto` entries, the two values a typed message cannot hold through the dynamic message; protobuf's conformance suite through a Rust testee of `tools/protobuf-conformance.mjs`                                                                                                                                                                                                                                                                                          |
| `bead` with `websocket` and `http`, `bead-interop-server` | the WebSocket and HTTP transports, server and client, their facades and their TLS ([0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)); `bead-interop-server`, the interop service's server over both, and the Rust client's trials against each side's                                                                                                                         | the cases over HTTP and over WebSocket of `spec/transports.json`; their places of `spec/durations.json`; spec 15.10's and 15.12's twins; the interop both ways with the TypeScript and C# sides                                                                                                                                                                                                                                                                                               |
| `bead` with `mqtt` and `amqp`, `bead-interop-server`      | the MQTT 5 adapter and its client, over the core's sockets ([0050](0050-the-rust-sides-broker-bindings-are-features-of-its-core-and-mqtt-5-a-client-of-its-own-over-its-sockets.md)), and the AMQP 1.0 adapter, ahead; `bead-interop-server` over MQTT 5                                                                                                                                                                                       | the cases over MQTT 5 of `spec/transports.json`; `mqttPublishBounds`; the places of `mqttBrokerAdapter`; the twins of 15.25 to 15.31; the interop over MQTT 5 both ways                                                                                                                                                                                                                                                                                                                       |

The broker's core sits in `bead`, since the C# side's `Bead.Core` holds the broker's core and the
in-memory broker, and its cases need no socket; the `proto` codec stands apart, since the router
never depends on protobuf, as `Bead.Core` never references `Bead.Protobuf`. **A stage merges once it
plays**, deleting its rows ahead ([0004](0004-one-behaviour-in-every-language.md)), Rust's row of
`spec/check.py`'s `SIDES` holding the side's twins, its reads and its counts, so a change that
reaches across the languages lands on the three sides. Of the service layer, the core holds the
descriptors, the failures' catalogue, the managers' requesters and resolvers and the server of one
service, `ServiceServer`, and its client half, `ServiceClient`, the twin of `createServiceClient`
and of `ServiceClient<TService>`. Its transports over sockets, WebSocket (RFC 6455) and HTTP/1.1
and HTTP/2 (RFC 9110, 9112, 9113), the features `websocket` and `http` of its core, play the cases
over HTTP and over WebSocket and their places of `spec/durations.json`, and the interop runs both
ways with the TypeScript and C# sides, under
[0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md).
Its broker bindings, MQTT 5 and AMQP 1.0, features of its core, are
[0050](0050-the-rust-sides-broker-bindings-are-features-of-its-core-and-mqtt-5-a-client-of-its-own-over-its-sockets.md)'s,
its MQTT 5 binding a client of its own over its sockets. Ahead, in this order: beadc's Rust
target, with `examples/hello`'s Rust half, the lists of the procedures a server's transports take
([0048](0048-one-contract-gives-several-packages-and-a-servers-transport-takes-the-procedures-it-is-given.md))
and the validators of a blueprint's rules generated for it, or beadc refusing to generate them
([0035](0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md));
its gateway; and its AMQP 1.0 binding, each stage under a record of its own.

### The partial side

The Rust side is a partial side, under [0004](0004-one-behaviour-in-every-language.md)'s rule: each
part it does not play is an open row of [the support matrix](../support.md), ahead with the stage
that brings it, and, where a conformance file plays that part, a row of `spec/check.py`'s `AHEAD`:
`Rust's gateway`, `Rust's AMQP 1.0 binding` and `Rust's beadc target`, each a row of the matrix and
of `AHEAD`; `Rust's service manager over a router of the application's own`, which no conformance
file plays, a row of the matrix alone. **Its tests are told from its sources by a predicate**, since
a suffix does not tell them, both being `.rs`: a module's `tests.rs`, a crate's `tests/` and the
test kit, `src/testing.rs` and `src/testing/`, so a doc comment on a source's item never stands for
a twin.

### The workspace and its names

- A virtual workspace, `implementations/rust/Cargo.toml`, `crates/*` and `benches/` its members, one
  `Cargo.lock`, committed, every build `--locked`; `fuzz/`, a cargo-fuzz project outside it;
  `benches/`, `bead-bench`, the in-memory bench 0036 asks of each side.
- **The crates mirror the C# assemblies**, not the TypeScript package's subpath exports: a crate is
  Rust's unit of dependency and of `forbid(unsafe_code)`, as an assembly is .NET's. `bead` is
  `Bead.Core`'s twin, `bead-protobuf` `Bead.Protobuf`'s, `bead-interop` the interop service's,
  `bead-interop-server` its server and the Rust client's trials against each side's;
  `bead-house`, dev only, holds the house's own checks. The crates of the stages ahead are named
  already, so no rename follows: `bead-transcoding` and `bead-transcoding-http`. A part that needs
  the core's inside and ships to applications, a transport, comes as a feature of the core
  ([0047](0047-every-side-shows-one-public-surface.md)): its sockets
  ([0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md))
  and its broker bindings
  ([0050](0050-the-rust-sides-broker-bindings-are-features-of-its-core-and-mqtt-5-a-client-of-its-own-over-its-sockets.md)).
- **Packages qualified by their owner, libraries short**, as NuGet's `FrancisDesjardins.Bead.*`
  over the assemblies `Bead.*`
  ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)): the package
  `francisdesjardins-bead`, its library `bead`, so code reads `use bead::RouterClient`; a workspace
  dependency renames it once, `bead = { package = "francisdesjardins-bead", path = "crates/bead" }`.
  crates.io has no namespace, and `bead` is another's there.
- `[workspace.package]` holds the product's one version, which `tools/release.mjs` moves with the
  TypeScript manifest and `Directory.Build.props`, and `publish = false` until a first publication
  sets it, as the TypeScript manifest stays `private: true`.

### The toolchain

`rust-toolchain.toml` pins `channel = "1.99.1"`, `profile = "minimal"`, its components `clippy`,
`rustfmt` and `llvm-tools`, which come with the toolchain and never from the registry, and its
target `wasm32-unknown-unknown`, for which the browser target's check builds. `edition =
"2024"`, `resolver = "3"`, and **the floor is the pin**: `rust-version = "1.99.1"`, as the
TypeScript side declares the floor it runs on and the C# side pins its SDK; a lower floor is a
support promise nobody asked for. The pin moves by a commit of its own, its new lints reviewed.
**A warning is an error by Cargo's own `[build] warnings = "deny"`**, in the folder's
`.cargo/config.toml`, so a local `cargo build`, `cargo clippy` or `cargo doc` judges as CI does, as
`TreatWarningsAsErrors` does on the C# side, with no `RUSTFLAGS` and no `RUSTDOCFLAGS`. A dated
nightly serves one leg alone, the fuzz build, under `CARGO_BUILD_WARNINGS=warn`: a newer
compiler's warnings are no gate of the pinned one's.

### The lints, the format, the house's checks

The table, probed over a tree shaped like the core — private modules re-exported, `pub(crate)` and
`pub(super)` items, a module beside its folder, nested `tests.rs` files, the kit, a second crate —
where it passes whole. Each lint keeps its level here, so the table is what a reader reads; whether
a warning fails the build is `build.warnings`' alone.

```toml
[workspace.lints.rust]
unsafe_code = "forbid"
missing_docs = "deny"
unreachable_pub = "deny"
missing_debug_implementations = "deny"
unused_qualifications = "deny"
unused_lifetimes = "deny"
redundant_lifetimes = "deny"
non_ascii_idents = "forbid"
let_underscore_drop = "deny"
trivial_casts = "deny"
trivial_numeric_casts = "deny"
unit_bindings = "deny"
unnameable_types = "deny"
unexpected_cfgs = "deny"

[workspace.lints.rustdoc]
broken_intra_doc_links = "deny"
private_intra_doc_links = "deny"
missing_crate_level_docs = "deny"
unescaped_backticks = "deny"

[workspace.lints.clippy]
all = { level = "deny", priority = -1 }
pedantic = { level = "deny", priority = -1 }
nursery = { level = "deny", priority = -1 }
cargo = { level = "deny", priority = -1 }
# nursery lints allowed, each with its reason
# rustc's unreachable_pub asks pub(crate) of an item a private module offers the crate; this one
# asks pub of the same item, so no visibility passes both: rustc's form is kept
redundant_pub_crate = { level = "allow", priority = 1 }
# a public const fn is a promise only a major release takes back; const is written where the code
# needs one, never because it could be
missing_const_for_fn = { level = "allow", priority = 1 }
```

Every other nursery lint stays denied; one that the implementation finds wrong for the code it
meets is allowed the same way, a line of this table with its reason, by a revision of this record,
never by an `#[allow]` in the code. **Restriction lints, chosen**, each denied: `unwrap_used`,
`expect_used`, `panic`, `todo`, `unimplemented`, `unreachable` and `exit`, since a library never
ends its caller; `indexing_slicing`, `string_slice`, `get_unwrap`, `arithmetic_side_effects` and
`as_conversions`, since a parser of a peer's bytes indexes, slices and counts by checked operations
only; `dbg_macro`, `print_stdout` and `print_stderr`, since a library writes nothing of its own and
the trace is its voice ([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md));
`mem_forget`, `undocumented_unsafe_blocks`, `unnecessary_safety_comment` and
`unnecessary_safety_doc`, defence in depth beside `forbid(unsafe_code)`; `allow_attributes` and
`allow_attributes_without_reason`, since an exception is `#[expect(lint, reason = "…")]`, which
fails once it stops matching; `clone_on_ref_ptr`, `rc_mutex` and `mutex_atomic`;
`missing_assert_message` and `assertions_on_result_states`, since a test's assertion says what it
holds; `wildcard_enum_match_arm`, `rest_pat_in_fully_bound_structs` and `unneeded_field_pattern`,
since a new variant of a wire enum breaks every `match` that must decide it; `try_err`,
`map_err_ignore`, `error_impl_error`, `let_underscore_must_use` and `let_underscore_untyped`, since
an error is named, kept or said dropped; `impl_trait_in_params`, `partial_pub_fields`,
`same_name_method` and `multiple_inherent_impl`, one surface read alike; `mod_module_files`,
edition 2018's form, `envelope.rs` beside `envelope/`, never `mod.rs`; and one form each:
`str_to_string`, `format_push_string`, `verbose_file_reads`, `needless_raw_strings`,
`redundant_type_annotations`, `unseparated_literal_suffix`, `empty_structs_with_brackets`,
`if_then_some_else_none`, `deref_by_slicing`, `infinite_loop`, `mixed_read_write_in_expression`,
`suspicious_xor_used_as_pow`, `string_lit_chars_any`, `float_cmp_const`, `lossy_float_literal`,
`fn_to_numeric_cast_any`, `filetype_is_file`, `large_include_file` and `create_dir`. Left off, each
for its reason: `implicit_return` and `question_mark_used`, which fight the language's own form;
`std_instead_of_core`, no `no_std` being aimed at; `missing_docs_in_private_items`, every public
item documented and a private one where its invariant needs it, as on the other sides;
`pattern_type_mismatch`, `semicolon_inside_block`, `tests_outside_test_module`, since an
integration test is outside any module by nature, `renamed_function_params`, which would force
std's `f` against [0003](0003-one-word-one-meaning.md)'s no abbreviations, `self_named_module_files`,
and rustc's `single_use_lifetimes`, whose false positives rustc lists.

`clippy.toml` sets `too-many-arguments-threshold = 4`, the receiver being counted, the tests'
allowances of `unwrap`, `expect`, `panic`, indexing and printing, and
`avoid-breaking-exported-api = false`, so the API-shape lints judge the public surface while `0.y`
lets it break. `rustfmt.toml`, stable options only: `edition` and `style_edition` 2024 (RFC 3338),
`max_width = 100`, `newline_style = "Unix"`, the field-init and `?` shorthands. `deny.toml`
(cargo-deny 0.20.2): RustSec's advisories and `yanked = "deny"`; the licences `Apache-2.0`, `MIT`,
`BSD-3-Clause`, `Unicode-3.0`, `BSL-1.0` and `Zlib`; crates.io alone as a source, no git;
and `multiple-versions = "deny"`, each duplicate a listed exception with its reason.

**`bead-house`**, a dev-only crate whose test reads every crate's source with `syn`, holds what no
lint does, as `tools/oxlint-plugin.mjs` and `tools/check-surface.mjs` hold the TypeScript side's:
the parameter rule below, each options parameter taken by `&` and each public `…Options` struct's
shape, its cases listed as `oxlint-plugin.cases.ts` lists its own; no tuple taken or given by a
`pub` item, at any depth of its type, the crate's aliases of every visibility expanded, nor a
variant or a `pub` tuple struct of two unnamed fields or more, a one-field newtype aside
([0047](0047-every-side-shows-one-public-surface.md)), its cases in `cases/tuples.rs`; each library crate's public
items, every `pub` one with its declaration, its fields, its variants, its inherent methods and the
traits it derives or implements, its bodies not, pinned to its list in
`crates/bead-house/surfaces/`, `internal` a section of its own and the test kit left out by name, so
the surface grows by a decision ([0047](0047-every-side-shows-one-public-surface.md)); the comment tags
of `CLAUDE.md` on plain comments alone, none on a doc comment, a doc comment being what rustc's
tokenizer reads as one (`///`, `//!`, `/** */`, `/*! */`), so `//!` is never taken for the `!` tag;
and every member's `[lints] workspace = true`, so no crate leaves the policy. The surface names
crates of their own before 1.0: rustls 0.23's configurations in the socket transports' `tls`
fields, tokio-util 0.7's `CancellationToken` in every options struct, and Buffa 0.9 in
`bead-protobuf`'s `ProtoSchema` and `DynamicCodec::new`; a breaking release of one of them, once
taken, is a breaking release of Bead (C-STABLE). **`//!` is kept**,
Rust's inner doc comment, the language's and its standard library's form for a module's and a
crate's documentation: the one exception to the `!` tag, a doc comment, never the tag, though Better
Comments shows it as one.

### One owner per router

**Each router's state belongs to one tokio task, its owner**, which runs jobs one at a time in the
order they came; a job is a synchronous `FnOnce(&mut State)`, so **a turn awaits nothing** and no
other job runs within it. What waits — a resolver, a send on a transport, a timer — runs off the
owner and posts its outcome as a job of its own: a turn and its continuations, as the C# side's
`async` methods on its `SerialScheduler` run from await to await. `post`, `run`, `cover` and
`when_idle` stand for the scheduler's `Post`, `Run`, `Cover` and `WhenIdle`. The router is re-cut as
turns and continuations, its turns the other sides', not ported line by line: what `RouterCore.cs`
does between two awaits is one job.

**Beside the owner, a few states are shared under std's `Mutex`**, each held the length of a copy or
a write, never across an `await`, which clippy's `await_holding_lock` refuses: a client's
notifications, the series of what it hears, its session token and its default credential; a
server's series of what it notifies; each router's resolvers; and a call's handler, its session and
the failure its router answered in its handler's place. Each serves what is read off the owner
synchronously, `has_notification`, a request's resolver, a call's `answered`, a gauge, or an
operation that takes effect as it is made; the rest of a router's state is its owner's alone.

**An operation takes effect when it is made; its future only waits.** Every operation the other
sides start as it is called — `request`, `notify`, `subscribe`, `command`, `connect`, `close`,
`dispose` — is a plain `fn` on the handle, never an `async fn`: it checks its arguments, posts its
job to the owner, which draws the call id and sends in the order calls are made, and returns a named
`#[must_use]` future of the outcome (`Call<T>`, `Connect`, …), as a promise or a `Task` is returned
already running. What it refuses as it is made is its `Err` at once, as the other sides throw it
synchronously: `fn request(&self, payload: P, request: RouterRequest) -> Result<Call<R>,
ProgrammerError>`, read `router.request(payload, request)?.await`. **Dropping a call's future
cancels nothing**: the call went when it was made, and goes on to its answer or its timeout; a
cancel is its options' `CancellationToken`. A call made before its router's dispose goes, and one
made after fails unsent, `Disconnected`, "the router was disposed", in its future, `request`'s own
`Result` unchanged: the dispose sets its handle's mark at once, and its job, queued behind the
call's, the state's, as on every side
([0045](0045-a-router-takes-what-its-application-makes-in-one-queue-behind-the-turn-that-tells-it.md)).
What only the owner's state can tell is refused within the future, never as the operation is made:
a session token another connection holds, given to `SessionManager::set`, is its future's
`CallError::Refused`, where a timeout spec 1.4 does not hold is its `Err` at once, the matrix's row
`A session token another connection holds, given to set`.

Two differences from the C# scheduler, each held by a twin:

- **A turn is synchronous**: a C# method that awaits within the router is cut, at each await, into
  a job and the continuation it posts.
- **No job runs inline**: `run`, like `post` and `offer`, queues at the owner's tail, where the C#
  scheduler's `Run` runs inline when it is current, for its router's own calls. A call made within
  a turn, a listener's, cannot run inline anyway, the turn borrowing the state: it joins the tail,
  behind what that turn sends and among what it defers in the order deferred, as every side takes
  it, the other two deferring it at their public surface
  ([0045](0045-a-router-takes-what-its-application-makes-in-one-queue-behind-the-turn-that-tells-it.md)).
  A continuation joins the same tail, as a microtask does on the TypeScript side, and assumes
  nothing of the state between its turn and itself.

**What a listener hands its router back** from within a turn — an envelope its transport carries,
a connection let go, a dispose — goes to the same tail, taken in a later turn, never within that
one, as spec 9.0 has it. A transport's events reach the owner through `offer`, whatever turn tells
them. A dispose sets its handle's mark, `Disposal`, at once, so what is made after it fails unsent;
its job, behind what came before it, sets the state's mark first and lets go of what the router
holds, so the turn it was made in still sends its answer, the two marks read as
[0045](0045-a-router-takes-what-its-application-makes-in-one-queue-behind-the-turn-that-tells-it.md)'s
table has them; what its transport tells once it is disposed is dropped at its bridge, as both
other sides stop listening within their dispose. Twins:
`an_envelope_a_listener_hands_its_router_within_a_turn_is_taken_behind_what_came_before_it`,
spec 9.0's three, a failed resolver's, a failed admission's and a dispose from the report listener,
`lets_its_connections_go_after_the_turn_its_report_listener_disposes_it_in_behind_the_failed_resolver_s_answer`,
and `a_request_its_transport_tells_once_its_router_is_disposed_reaches_no_resolver`.

Beside them: **the owner's queue holds what the router posts for itself without bound, and what a
transport hands it within
[0046](0046-a-router-paces-each-connections-reads-by-what-it-has-not-taken.md)'s
bound**. An envelope's size, `maximumAnsweringCalls` and a transfer's bounds are judged as the turn
takes it; the bridge counts what each connection's transport handed that no turn took yet, and
pauses that connection past `maximumUntakenEnvelopes` or `maximumUntakenBytes` by the transport's
required `pause`, as HTTP/2's flow control paces a stream (RFC 9113 §5.2) and .NET's
`PipeOptions.PauseWriterThreshold` a pipe's writer. A transport's listener still returns nothing:
the pause is a call, never a wait. **Resolvers run off the owner**, spawned on the runtime, the
router awaiting each one's `JoinHandle`, so its panic is seen; **the public handles are
`Clone + Send + Sync`**, an `Arc` to
the owner's queue, and a resolver's future `Send + 'static`, no `!Send` resolver offered; **the
runtime is the application's**, its handle given in the options or the current one, none a
`ProgrammerError`, and **its time driver checked at construction**: the builder arms a zero timer
once under the handle's `enter()`, within `catch_unwind`, and what tokio panics there is a
`ProgrammerError` ("a router's runtime enables tokio's time driver"), never a panic inside a later
call; Bead starts no runtime and no thread of its own. **The owner lives** while its application
holds a handle to it or its transport holds it, the transport holding its bridge, which holds a
handle to its queue, as a router lives on the other sides as long as its transport holds it; its
state holds its transport and that bridge weakly, so nothing of its own keeps it. Neither held, a
router never disposed ends with its owner, what its state held let go, as the other sides collect
a router nothing references; a resolver a service manager registered holds that manager, and so
its router, which then ends by its dispose. Twins:
`keeps_its_connection_when_the_application_drops_its_last_handle`,
`a_router_never_disposed_ends_once_its_application_and_its_transport_let_it_go` and
`routers_never_disposed_over_the_in_memory_transport_end_once_nothing_holds_them`.

**The core spawns through one private module, `platform`, and reads time through its clock alone,
as clippy's `disallowed-methods` and `disallowed-types` hold it.** `platform::spawn` is the one
call of tokio's spawn, `platform::lookup_host` the one of its resolver, which spawns on its
blocking pool a resolution that runs to its end whatever becomes of the connect that asked, and
`platform::runtime_of` the one reading of the current runtime and of its time driver, which every
part of the core that takes a runtime calls with its own refusal;
`SystemClock`'s body is the one reader of std's `Instant`, of `SystemTime::now()` and of tokio's
timers. Each of the two funnels sits under one `#[expect]`, and the public surface names tokio's
`Handle`, the application's runtime being tokio's. The lists refuse every other path in every
target clippy sees, as CI runs it: tokio's spawns, `try_current` and `current` ("spawn through
`crate::platform`"); `tokio::net::lookup_host` ("resolve through `crate::platform`"); `block_on`, `block_in_place` and `std::thread::sleep` ("a turn awaits
nothing"); tokio's `sleep`, `sleep_until`, `interval`, `interval_at`, `timeout` and `timeout_at`,
`SystemTime::now`, and the types `std::time::Instant` and `tokio::time::Instant`, so that every
`elapsed()` is held too ("time through the clock"); `std::thread::spawn` ("no thread of Bead's
own"). `SystemTime` stays allowed as a type, `Clock::wall` returning it. A test takes its spawn,
its rest, its patience, its `Instant` and its wall clock from the kit; a target that stays native,
the players over sockets, the durations' harness, the protobuf service's tests and the bench,
carries one `#[expect]` at its root with its reason.

**The core compiles for the browser's target**, `wasm32-unknown-unknown`: CI runs clippy over its
library there, so a dependency or an API that does not build in a page (tokio's `net` or
`rt-multi-thread`, a native TLS stack, `std::os`) fails the change that brings it, and the socket
transports and the broker bindings sit in features of the core, `websocket`, `http`, `mqtt` and
`amqp`, AMQP 1.0's ahead, that the check leaves out by name, each reaching the core's inside by
`pub(crate)`. The target is checked, never run: the folder's `.cargo/config.toml` gives getrandom
its `unsupported` backend on it,
`--cfg getrandom_backend="unsupported"`, the backend getrandom names for this case, which adds no
dependency and no lock entry, keeps `wasm_js` out of the library as getrandom asks, and has no
effect on a crate that depends on Bead. A draw there is an error, which each of Bead's draws already
takes as a `Result`. What would trap there at run time, a clock or a thread, the disallowed lists
hold.

### The clock and the durations

A `Clock` trait, `Send + Sync + Debug`, gives the monotonic reading, the wall clock and a timer
armed ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)); **`SystemClock`**, the
platform's, runs on tokio's timers and `SystemTime::now()`, one clock a stack, a second refused.
**tokio's paused time is not the test clock**: it moves no wall clock, fires every timer due at once
in its own order and settles nothing between them, where `spec/clocks.json` asks the armed order, a
periodic timer armed again before its callback and a settle between timers. The stepping clock is
the core's own, in its kit, `SteppingClock.cs`'s twin. What a platform's own socket times stays on
the real clock, as on the other sides.

**A duration is a `std::time::Duration`**, never milliseconds as a float
([0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)); **never is
`Duration::MAX`**, `bead::NEVER`, as `Infinity` and `Timeout.InfiniteTimeSpan` are each platform's
own never; held as spec 1.4 holds one, from the nanoseconds; `LONGEST_TIMER` a `Duration`, 2³¹ − 1
ms. A refusal is an `Err` whose reason is a code, `DurationRefusal::{UnderTheFloor, PastTheCeiling,
ZeroRefused, NeverRefused, NotANumber}`, which the harness checks against the file's derived
reason; the words stay Rust's. A `Duration` holds no value under zero, no NaN and nothing that is
no number: those inputs are played at no place, each by its row. A reconnection's delay is a
`TransportClientReconnectDelay`, `Fixed(Duration)` or `Resolver`, a function of the previous delay
and the attempt, as every side takes a number or a function ([0047](0047-every-side-shows-one-public-surface.md)).

### Failures and errors

Rust's form is a `Result`. Bead's errors are named as the TypeScript side names them, each `Debug +
Display + Error + Send + Sync + 'static`: `Failure`, its code a `NonZeroU16`, an application's code
and the protocol's alike; `CallError`, a `Failure`, a cancel or a disconnection, `#[non_exhaustive]`;
`ConnectError`, `ReconnectError`, `CapacityError`, `ReadyStateError`, `BrokerRefusedError`;
`ProgrammerError`, with a reason code where a file derives one. An operation returns the error it
can return, never a crate-wide `Error`. An error that wraps another keeps it as its `source`, std's
word, as the other sides keep a `cause` and an `InnerException`: an `Arc<dyn Error + Send + Sync>`
where the error is `Clone`, as `ConnectError`, `ReconnectError` and a failed `BrokerError` are; a
wrapper that only changes the kind takes its source's words and source, never says them twice.
**No panic in the library**: a builder that refuses its options returns
`Result<Self, ProgrammerError>`.

**What the spec lets a side throw has a Rust form at every site.** A resolver returns `Result<T,
ResolverError>`: `ResolverError::Other`, a boxed error built by `ResolverError::other` from any
error, answered `PROCEDURE_FAILED` with no detail and reported (spec 9.0), a `Failure` among them
reported as itself; a procedure answers its own failure through its answerer (spec 9.5). Every
other callback the spec lets throw — an admission, a verifier, a key set's ask, an application's
codec, a rule — takes the same shape, or a boxed error where the other sides answer every throw
alike: a rule's judgment is `Result<Judged, Box<dyn Error + Send + Sync>>`, its error answered
`PROCEDURE_FAILED` and reported in its own words (spec 18.2). **A panic is its site's throw**: a
resolver's seen on its `JoinHandle`, the others' within `catch_unwind`, a future's as it is polled,
answered and reported as the throw it stands for, the transport going on
([0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)).
The sites are every place the router calls the application's code: an admission, a verifier and
its future, a key set's ask and its future, a codec as it reads and as it writes, a rule, at a
resolver and at a requester, a listener, a call's hooks, and a transport's `send` and what the
router asks of its transport. A codec's panic as it reads a request is its throw other than a
refusal: answered `PROCEDURE_FAILED` with no detail and reported, as every side answers a codec that
throws other than its refusal (spec 9.0, 17.2). Its panic as it reads a result fails the call here,
undecodable; as it writes, the call fails with its throw and nothing goes. A rule's panic is its
error: at a resolver, answered `PROCEDURE_FAILED` and reported `a rule panicked: …`; at a requester,
its call failed before anything goes. A hook's panic fails its own call; a `send`'s is the
transport's error, the send undone and reported, as the other sides' writers take a `send` that
throws. **A panic past those sites**, within a turn — a custom clock's, say — leaves the owner's
state half changed with nothing to undo it: the owner ends at once, each call it waits on failed
now with that panic for its reason, the panic reported, nothing queued run, and a call made after
refused at once, never going on over that state, where the C# scheduler goes on past a job's
exception. Held by `a_hook_that_panics_fails_its_own_call_and_the_router_answers_the_next`,
`a_request_whose_send_panics_fails_as_its_transport_s_throw_would_and_the_router_answers_the_next`,
`a_request_whose_codec_panics_as_it_reads_is_answered_procedure_failed_with_no_detail_and_reported_never_reaching_the_callback`
and
`a_turn_that_panics_ends_its_router_failing_each_call_it_waits_on_with_that_panic_and_strands_no_later_call`
among them. Under `panic = "abort"`, which an application may set and `wasm32-unknown-unknown`
sets by default, nothing unwinds: a platform row of the matrix, every throw site among it.

**A code space the spec keeps open is a newtype with associated constants**, as `http::StatusCode`
holds one: `ProtocolCode(NonZeroU16)`, a code spec 8.1 names none of kept as a number, and
`CredentialScheme(u16)`, since spec 9.2 answers a scheme a receiver takes none of by its number;
each `From` the number, `get()` back, `Display` by name or number. **A space the spec closes is an
enum**, `#[non_exhaustive]`, `TryFrom` the wire's width: an envelope's kind, a failure's flags, a
`JWT`'s `alg`.

### Two parameters, then the options

**Beside the receiver** — `self`, `&self`, `&mut self`, as C#'s `this` is no parameter — **at most
two parameters, then at most one options struct, always last**; a third essential thing is a design
to revisit. The options struct is named `…Options`, **`#[non_exhaustive]` from its first commit**,
its fields public, `Debug + Clone` and **never `Copy`**, **taken by `&`**. **Every field is an
`Option`, with the default its doc states, but a setting the rule marks required
([0047](0047-every-side-shows-one-public-surface.md)): such a field is plain, at most two of them, and
the struct's constructor of its required members, `new`, which takes them and nothing else, as
C-BUILDER's `Command::new(program)` takes its program, sets them; the struct then has no `Default`. With none required it derives
`Default`.** It is set as C#'s object initializer sets one, by assignment over what `default()` or
that constructor gives:

```rust
let mut options = RouterClientOptions::default();
options.timeout = Some(Duration::from_secs(1));
let router = RouterClient::new(transport, &options)?;
```

From another crate the fields stay assignable and only the literal is refused, so an option added
later breaks no caller: C-STRUCT-PRIVATE's aim, reached by RFC 2008's attribute rather than
accessors, and the constructor of the required members is C-BUILDER's. One form: no `with_*` setters
beside it, no builder where the other sides take an options object. `&` lets a caller keep and reuse
its options, as the other sides' callers keep their object, where C-CALLER-CONTROL would hand
ownership over: a function that keeps a part clones it, a count or a few words. An options struct is
never `Copy`, since clippy's `trivially_copy_pass_by_ref` refuses `&` of a small `Copy` one and
`needless_pass_by_value` refuses one taken by value and only read. Where a member is required in
some instantiations alone, the side states it by a type of its own where the type names the case, as
`CommandOptions`, whose `new` takes its connection, and otherwise takes it as an `Option` refused
where the object is used, a row of the matrix. A callback Bead declares takes its options as
`&…Options` too. Clippy's `too_many_arguments` at 4, since it counts the receiver, and
`bead-house`'s tests hold it: the parameters, each public `…Options` struct's shape, and each
options parameter by `&`, as `max-params`, `bead/options-last` and `tools/check-surface.mjs` hold
the TypeScript side's. The count binds every function. Inside the crate a tuple counts as one
parameter, and `bead-house` counts the tuples of three elements or more a function takes, its
parameters' own types alone read, against each member's pin, which may only fall, so a site leaves
the count by a record of the call and none joins it. It reads what the house reads, each crate's
tests, benches and fuzz targets among them, where the C# side's count reads its `src` assemblies
alone: a crate's tests sit in its `src`. On the surface no item takes or gives one
([0047](0047-every-side-shows-one-public-surface.md)), which `bead-house`'s `tuples.rs` holds: two
things are two parameters, a third essential thing a record of the call, `RouterRequest` or
`NotifyRequest`, and several values given back a `#[non_exhaustive]` struct. Two kinds of record
stay exhaustive, so that a literal builds them: the wire's own, an envelope's header and a failure's
`FailureRecord`, whose fields the spec fixes; and what an application builds to hand in,
`ProcedureAddress`, `CallAddress`, `CallAsked` and `EnvelopeAsked`.

### Names, side by side

C-CASE gives Rust its cases, and the words are the other sides': `RouterClient::new`,
`MemoryTransportClient::new`, `ServiceManager`, `Clock` for `IClock`, a trait carrying no `I`, an
acronym a word, `Jwt`, `Http`, an overload a second name, `notify` and `notify_unwritten`. A name
that drifts from the other sides' exports is a parity defect, renamed on every side. A constructor
is `new` (C-CTOR), and a conversion is `From` or `TryFrom` (C-CONV-TRAITS), never a static `of`. A
function that derives a value from what it is given is `…_of`, the other sides' `…Of`. A method
keeps the TypeScript side's word, as `ListedFailure::of` keeps `catalogue.of`. An event the other
sides emit is a `…Listener` or an `on_…` the Rust side registers. A TypeScript `type` member is
`…_type` here, since `type` is Rust's keyword. A variant of an error enum names the end the
operation met, as std's `io::ErrorKind::TimedOut` does, where the TypeScript side names the error
after the event, and the C# side so where it has a type of its own: `CallError::Disconnected` is
`DisconnectError` and `DisconnectException`, `CallError::Cancelled` is `CancelError`,
`CallError::TimedOut` is `TimeoutError`, which `tools/names.tsv` renders, `rendered: error`. An
interface the other sides give over one object, which narrows it, is a newtype here that holds it,
`ServiceManagerClient` over `ServiceManager` (C-NEWTYPE), built by the crate alone
([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)).
An event that tells a change is a struct variant of `SessionEvent`, its fields the other sides'
`SessionChange` members, `session`, `new_value` and `old_value`, as an event enum's struct variant
carries named values in Rust (winit's `WindowEvent::CursorMoved { device_id, position }`). A
callable that holds what it calls through is a struct with its call where the other sides type a
function: `Notifier`, which the service server's `notifier_of(&descriptor)` gives, beside the
TypeScript side's `INotifier` and the C# side's delegate `Notifier<TNotification>`, `rendered:
callable`; the service server gives its handles as C# does, `notifier_of` and `command_of`, `…_of`
by the rule above, since 0003 keeps `notify` for sending. A set of flags an implementer declares,
which the wire does not carry, is a bit set of associated constants, as `BrokerCapabilities` is,
where C# writes a `[Flags]` enum and TypeScript an object of optional booleans, `rendered: flags`
([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)); clippy's
`struct_excessive_bools`, denied, refuses a struct of four `bool`. A default Bead declares is
exported, and one the TypeScript side holds as a table's member is a `const` of the options struct
that table satisfies, `REQUEST_DEFAULTS`, `RECONNECT_DEFAULTS`, `METRICS_REGISTRY_DEFAULTS`, as
`LIMIT_DEFAULTS` and `PACING_DEFAULTS` are; `MEMORY_ADDRESS` stays a constant, since Rust's memory
connect options require their server and hold the address as a `String`, so no `const` of them can
be written ([0047](0047-every-side-shows-one-public-surface.md)). The Rust names are the other sides',
each held by `tools/names.tsv` ([0047](0047-every-side-shows-one-public-surface.md)).

### Payloads, a `JWT`, randomness

**JSON** ([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)): **Bead's own
reader**, a strict RFC 8259 tokenizer with spec 17.5's checks in the TypeScript reader's order; a
whole number within 64 bits read as an integer, any other as the nearest double, both written back
through the double; **`serde_json::Value`** the value; **Bead's own canonical writer**, numbers by
`ryu-js`, RFC 8785; and **`bead::json::to_value`**, Bead's own `serde::Serializer`, the resolver's
documented road from its type to a `json` payload, which refuses a double that is not finite at any
depth where `serde_json` writes `null`. What the type cannot hold — a surrogate alone, a name twice,
`undefined` — is excused by its row; NaN and Infinity are played. **`JsonOf<T>`** reads a `json`
payload as the application's own type through serde, and refuses a JSON value not of it in words of
its own, `not its type`, as a codec an application writes does (spec 17.2), serde's in its cause:
the type is the application's, and the matrix's row says so. Its other refusals say 17.2's words.

**A `JWT`'s verification** on RustCrypto: ES256 by `p256`, its signature R‖S's 64 bytes and nothing
else, HS256 by `hmac`'s constant-time check; pure Rust, so the core with no feature needs no C toolchain
on Windows, its socket transports' TLS, aws-lc-rs, alone built by the platform's C compiler
([0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)),
and `forbid(unsafe_code)` costs nothing. base64url by Bead's own strict decoder. An `OPAQUE` token's
bytes by `getrandom`, the system's source. **No `thiserror`**: a dozen error types, each a short
hand-written `Display`. **No `tracing`** in the core; an optional bridge from the Rust side's trace
to `tracing` is ahead. **No credential in a string** (spec 15.1): a type that holds a credential, a
session's token, what a transport carries or a key writes its `Debug` by hand, a credential by its
scheme, a token or a carried value by whether it is there, a key by its issuer and its algorithm,
and never derives it.

### Protobuf, on Buffa

`bead-protobuf`, `Bead.Protobuf`'s twin, is built on **Buffa 0.9.2**, Apache-2.0: `buffa`, the
runtime; `buffa-descriptor` with `reflect`, the runtime descriptors and the dynamic message;
`buffa-types`, the well-known types; and `buffa-build`, the generator, fed the `FileDescriptorSet`
that protoc writes at its pin (`builder/protoc.json`), never calling protoc itself. Buffa meets the
five criteria the choice is held to, each run against the corpus, none read from a library's claim:
`spec/codecs.proto`, of edition 2023, generated at the pinned protoc, its `IMPLICIT`, `DELIMITED`,
`CLOSED` and `LEGACY_REQUIRED` honoured; **all of `spec/codecs.json`'s `proto` entries** through
Bead's records check, the required walk and the closed enum's normalization
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md),
[0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)),
no entry excused by a library's representation; protobuf's conformance suite at the floor the other
sides keep, its failure list one test, an extension's string, which both other sides list beside
their JSON's; the leveled
rows kept; and **the runtime descriptors and a dynamic message from the library itself**, with no
facade of Bead's. The order stops at the first library that meets the five, so Google's official v4
and prost with prost-reflect, after it, are not taken; v4's published runtime holds no descriptor
pool, no reflection, no dynamic message and no JSON, and builds a C kernel. **No common restriction
is added to fit a library.**

- **The read path: Bead's records check, Buffa's view, the required walk, then the owned message.**
  The records check (spec 17.9.1 to 17.9.6) reads a pool decoded from protoc's set,
  `buffa_descriptor::DescriptorPool`, and Buffa needs it: alone, it takes a tag of more than five
  bytes and a map's entry with a field it does not declare, and counts no map's entry toward depth.
  The view decodes at `DecodeOptions::with_recursion_limit(100)`: Buffa counts the messages below
  the top, so 100 is 17.9.3's bound through children and groups, and the check holds a map's
  entries. The walk (17.9.7) reads the view's `ReflectMessage::has()`, which the wire decoder's
  presence answers, merged as protobuf merges a message given twice, and never the owned message's
  reflection, whose `has()` of a required field compares its value with its default. The walk
  takes a field as required by its presence, and an edition's singular message field by its own
  `features.field_presence`, since buffa-descriptor reads such a field as of explicit presence
  whatever its feature says. The view and the dynamic message decode with Buffa's own budgets of
  unknown fields and of element memory lifted, as neither other side's library holds one: the
  procedure's payload limit bounds a payload. `to_owned_message()` then gives the application its
  value.
- **A singular closed enum's undeclared number** is dropped before Buffa reads, as on every side
  (17.9.8,
  [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md#on-the-corpus-that-writes-every-field-of-probe)),
  the last declared number kept; the walk checks that a required closed enum's number is declared,
  since the dynamic message takes any.
- **The generator** opens each repeated and map field of a closed enum by Buffa's `open_enums_in`,
  the fields read from the descriptors, so such an item or value is kept as the leveled row has it;
  views and vtable reflection are on, and `allow_message_set(true)` takes the suite's messages. The
  dynamic message the gateway reads by descriptor reads by a pool that carries the same opening.
- **The writer.** The typed codec writes Buffa's owned message, which holds a `LEGACY_REQUIRED`
  field bare and a closed enum as its Rust enum, so no typed value leaves a required field unset or
  holds an undeclared number: the type makes the fault impossible rather than hiding it. The write
  form that tracks presence is the dynamic message, Buffa's `DynamicMessage`, Bead's walk before
  its `encode_to_vec`. `spec/codecs.json`'s values `needs set to no field` and `needs with a shade
  its enum does not declare` are played through it, each refused `a required field unset`, and the
  matrix's platform row `A proto value that leaves a required field unset or holds a closed enum's
  undeclared number, given to a typed writer` says so; every other `proto` value is written
  through the generated code, as spec 17.9 has it, and the dynamic message writes the same bytes.
- **Its gates.** The generated code is included under one `#[expect(clippy::all, clippy::pedantic,
  clippy::nursery, clippy::restriction, missing_docs, reason = "…")]` on the module that includes
  it, the exception's form this record names, which fails once it stops matching; Bead's own code
  beside it keeps the table whole. `deny.toml` allows `Zlib`, the licence of `foldhash`, which
  Buffa's runtime takes through `hashbrown`, a permissive licence the OSI approves; and it skips
  `syn` 2, which `buffa-codegen` and `prettyplease` alone bring, at build time, beside Bead's `syn`
  3, with its reason. Buffa's runtime holds `unsafe` code of its own, as a dependency may; the
  generated code holds none, and `bead-protobuf` forbids it.
- **The testee** of `tools/protobuf-conformance.mjs` reads binary through the read path above and
  writes from the owned message. Its JSON goes through Buffa's `DynamicMessage` and its ProtoJSON,
  `serde_json` reading with `float_roundtrip`; Bead's own mapping of protobuf's JSON comes with its
  gateway, ahead
  ([0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)),
  and with it the two `FieldNameExtension.Validator` tests join its failure list, as they stand on
  both other sides'. The runner's binary asks glibc 2.38 or later, Debian 13's.

### Debugging and metrics

The trace, the filter and the registry are Bead's own, as on the other sides
([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)), the exposition 0.0.4 byte for
byte, and **always built**: no Cargo feature leaves debugging out, which would be a Z for one side.

### Tests and coverage

- **A module's unit tests in a file beside it**: `src/envelope.rs` declares `#[cfg(test)] mod
  tests;`, its tests in `src/envelope/tests.rs`, with the module's private items at hand.
- **The test kit is inside the core**, as tokio keeps its `test-util`:
  `#[cfg(any(test, feature = "testing"))] #[doc(hidden)] pub mod testing`, holding the stepping
  clock, each conformance file's typed reader, `deny_unknown_fields` and never by index, the
  durations' helper, the scripted transports and the parcels' readers: what only a test has; and
  what a test takes from its platform, each the kit's own funnel under one `#[expect]`: `spawn`,
  `rest` (tokio's sleep), `patience` (tokio's timeout, its `Result` the same), `Instant`, a newtype
  of the kit's over std's, never a re-export, which the gate would flag at each `Instant::now()`,
  and `wall_now`. The core takes itself as a dev-dependency with the feature, so a unit test and a
  player share one copy of it; resolver 3 keeps the feature out of every build that is not a test's.
  Every item of the core that the kit alone reaches carries the kit's `cfg`, or it is dead code in a
  build without it, which `build.warnings` fails.
- **What the workspace's own members reach that the API does not offer** — the envelope's codec, and
  what the conformance players, the fuzz targets, the interop service and the bench call — goes
  through one `#[doc(hidden)] pub mod internal` of the core, with no feature, as the C# players and
  the C# bench reach theirs by `InternalsVisibleTo`
  ([0047](0047-every-side-shows-one-public-surface.md)): outside SemVer, as its documentation says and
  as cargo-semver-checks reads a hidden item, and no road for another crate. The codec's items are
  `pub` in their private module and re-exported by `internal` alone, which `unreachable_pub`
  accepts; an item no member calls stays `pub(crate)`, and the kit's `testing::scripted` names the
  codec's real types through `internal`.
- **The conformance players** in `crates/bead/tests/`, one file a conformance file, `harness =
  false` under `libtest-mimic`, a trial per entry named by its own name.
- **Twin tests** carry the other sides' sentence in snake case, the unit named in a comment just
  above, `// spec 15.13`, which `spec/check.py` reads. Cargo's own runner: `cargo test --workspace
  --all-features --locked`.
- **A refusal the types make has a consumer twin**: `testing::surface::Consumer` compiles a consumer
  against the built library and asserts each refusal by its code and its message, on the pinned
  stable, where rustdoc's `compile_fail` checks no code; a doc example shows what compiles.
- **Coverage, lines and regions on the pinned stable**, through `cargo llvm-cov`'s LLVM JSON export,
  every test binary's profile merged, the unit tests and the kit left out; read by
  `tools/coverage-report.mjs`, which tells it from istanbul's JSON by its `type`, and held to the
  floor `rust` of `tools/coverage-floors.json`, which names `lines` and `regions`, raised by
  `--raise`, never down, over each library crate's `src/`. **A floor on a measure no report measured
  fails, for every side**, which closes the trap of a share of nothing read as 100 %.

### The CI job, fuzz and bench

CI's `rust` job ([0006](0006-a-rule-has-its-gate.md)), on Linux: `cargo fmt --check`, `cargo clippy
--workspace --all-targets --all-features --locked` and again on each member's default features, the
core's lib linted with no feature, with `websocket` alone, with `http` alone and with `mqtt` alone
(`cargo clippy -p francisdesjardins-bead --lib --locked`, `--features websocket`, `--features http`,
`--features mqtt`), the browser target's `cargo clippy -p francisdesjardins-bead --lib --features
testing --locked --target wasm32-unknown-unknown`, by its features, no socket and no broker binding
among them
([0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)),
`cargo doc`, a build on the default features alone, `cargo deny --locked check` and the same on the
fuzz targets and the conformance player, outside the workspace, the tests under coverage held to the
floor, and the fuzz targets built on the dated nightly, never run; on Windows, `cargo test
--workspace --all-features --locked`, as the user's MSVC toolchain builds it. The registry and the
target are cached by the lock and the toolchain, cargo-deny and cargo-llvm-cov installed prebuilt,
each checked by its SHA-256, and `ci-ok` needs the job. **Fuzz**: cargo-fuzz on the nightly, on
Linux or WSL, through `tools/fuzz.mjs`, by hand and ten minutes a target every week
([0006](0006-a-rule-has-its-gate.md)), its nine targets: eight the twins of the other sides' eight,
`envelope`, `payload-codecs`, `http-fields`, `debug-filter`, `jwt`, `ws-handshake`, `broker-parcel`
and `proto-codecs`, each reading what no socket or broker feature holds, through a crate's surface,
`bead::internal` or a test kit; and `mqtt-packets`, its MQTT 5 client's reader of a broker's
packets, the Rust side's alone, through `bead::internal` under the feature `mqtt`, which the fuzz
project's manifest turns on beside `testing`
([0050](0050-the-rust-sides-broker-bindings-are-features-of-its-core-and-mqtt-5-a-client-of-its-own-over-its-sockets.md)).
Its suite holds the envelope readers' and the parcel reader's seeded mutations, the same inputs as
the other sides', and `tests/mqtt_packets_fuzz.rs`'s, the packets a broker sends mutated, its own.
**Bench**: `bead-bench`, the in-memory bench, each fresh process writing `bead-bench/1`, which
`tools/bench-release.mjs rust` merges into `bead-bench/2` for `tools/bench-compare.mjs`. The gates
every side shares hold it too: `tools/check-details.mjs` reads its sources, `tools/check-names.mjs`
and `tools/check-durations.mjs` its surface lists, the differential its testee, a release reads its
bench's comparison in CI, and its broker trial plays every case no row of the matrix excuses it from
([0006](0006-a-rule-has-its-gate.md)).

## Consequences

- **Every change that reaches across the languages costs a third side**: a Tenth Man that weighs
  three, a twin per behaviour, a column per table; a stage merges once it plays, so no change made
  meanwhile is ported to it by hand.
- **The core's size**, of the order of `Bead.Core`'s and its tests, re-cut as turns and
  continuations rather than ported line by line: review leans on the gates — the corpus, the twins,
  clippy denied, the coverage floor.
- **A partial side**: the rows ahead in the matrix and in `AHEAD`, each a promise the stages ahead
  keep; one that stalls leaves its row standing.
- **Lints denied whole**: a nursery lint added or renamed by a compiler upgrade breaks the build on
  that upgrade's commit, by design; the upgrade reviews them, and one allowed is a line of the table
  with its reason. The nightly's pin, the fuzz build's alone, moves by hand.
- **A measure of its own**: Rust's floor counts regions, the others' branches; the two are not one
  number, and the matrix's row `Rust counts regions where the others count branches` says so.
- **No cancel on drop**, unlike much of Rust's ecosystem: a user who drops a call's future and
  expects a CANCEL gets none; the README and `request`'s doc comment say so.
- **One queue, no lane**: a call within a turn, a continuation and what a listener hands its router
  back each go to the owner's tail, as on the other sides
  ([0045](0045-a-router-takes-what-its-application-makes-in-one-queue-behind-the-turn-that-tells-it.md));
  a continuation pays for it by assuming nothing of the state between its turn and itself.
- **A panic ends its router**, past the sites the spec lets throw: an application whose clock or
  other code panics within a turn loses that router, each of its calls failed with the panic,
  where the C# side goes on; it never runs on over a state half changed.
- **Bead's own JSON stack**, a reader, a writer and a serializer, where most crates take
  `serde_json` whole: the price of RFC 8785, spec 17.5's checks and a NaN refused.
- **Options by assignment**: a line more than a literal, for options that never break a caller.
- **The time driver's check**: one caught panic at the construction of a part built on a misbuilt
  runtime, a router, the in-memory transport or broker, a broker's participant, a clock or a socket
  transport, whose IO driver is checked so too
  ([0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)),
  through the application's panic hook, and under `panic = "abort"` an abort there.
- **Types that hold less**: values of `spec/codecs.json`, inputs of `spec/durations.json` and ids no
  `u16` or `u32` holds are excused from Rust, each by its row; no `proto` entry is, the two values a
  typed message cannot hold being played through the dynamic message, a platform row of the matrix.
- **A dependency that holds more than Bead's own code**: Buffa's runtime holds `unsafe` code, as a
  library may, and brings a licence, `Zlib`, and a second `syn` at build time, each a line of
  `deny.toml`; its generated code lives under one `#[expect]` of the whole table, so a lint the
  pinned compiler adds is judged on Bead's own code alone.
- **The interop service's descriptors written by hand**, held by a test against
  `spec/interop-blueprint.json`, an open row of the matrix; beadc's Rust target, ahead, generates
  them.
- **A port beneath the service manager**, the inner half of the matrix's row
  `Rust's service manager over a router of the application's own`: the manager reads its router
  through a `pub(crate)` trait, `RouterLike`, which Bead's two routers take each through a wrapper
  of its own, its registration of a notification held as it is made and its future waiting for the
  subscription, its call free to draw no id; the twins of that row's three tests play over the test
  kit's router through it, at one allocation more per call, the work a call covers boxed for the
  port. Its public half, a `ServiceRouter` variant over it and an answer for its resolvers, is the
  row's.
- **The funnel, a rule to keep**: a change that spawns or reads time goes through `platform` or
  the clock, or fails clippy; a test reaches them through the kit; a target that stays native names
  its exemption and its reason. A core dependency that does not build for the browser's target
  fails its check, which costs one clippy run in CI, 11.5 s from a cold target directory, and no
  dependency, no lock entry and no change of the surface.
- **Impossible**: a `!Send` resolver; a router without a tokio runtime and its time driver,
  natively; a runtime other than tokio's natively; a spawn or a reading of time outside the funnel;
  a core dependency that does not build for `wasm32-unknown-unknown`; a duration under zero; a call
  that waits to be polled before it goes.

**Ahead: the core in a page and in a worker**, the Rust side's and the C# side's in one stage, with
its executor, its clock and its tests, then what it serves there: the transports in a page, the Web
Worker transport, the DevTools hook from their clients, its contract then a document every side
reads ([0015](0015-a-pages-client-announces-itself-to-a-devtools-hook.md)), and a Rust worker for
the demo. The C# side comes into a page as `Bead.Core` built for .NET's `browser-wasm`, where the
platform analyzer flags 22 sites in four files, its TCP helpers (`HappyEyeballs.cs`, `Loopbacks.cs`,
`HttpRedirects.cs`) and `ECDsa.Create(ECParameters)` in `JwtVerifier.cs`, none in the router, the
scheduler, the clocks, the codec, the in-memory transport or the broker: the matrix's row
`The core in a page and in a worker`. Its shape:

- **The switch** is a Cargo feature, `web`, never the target alone: `wasm32-unknown-unknown` names
  no JavaScript host, as getrandom states, and a JavaScript import fails a host without one as its
  module is instantiated. The feature turns on `wasm-bindgen`, `wasm-bindgen-futures`, `web-time`
  and getrandom's `wasm_js`, within getrandom's own exception, a crate that depends on
  `wasm-bindgen` on that target, and does nothing natively. Without it, the core on that target
  refuses through a `ProgrammerError` of `runtime_of`, never a panic, and never a `compile_error!`,
  which would break the browser target's check.
- **The executor** is `platform`'s browser half: `Handle` a unit type, `spawn` over
  `wasm_bindgen_futures::spawn_local`, its `JoinHandle` Bead's own over a oneshot channel. The
  native half stays as it is.
- **The clock** is `SystemClock`'s browser body: its readings from `web-time`, the wall clock std's
  `SystemTime`, its timers the global `setTimeout` and `setInterval`, whose closures live in a table
  of the thread's own under a key, so that `Timer: Send + Sync` holds. The delay is bound as an
  `i32`, HTML's `long`; every due is clamped to `LONGEST_TIMER` and rounded up to its next whole
  millisecond, as tokio rounds a deadline natively, so a due past the longest waits the longest
  instead of firing at once, as Chromium and Node fire a delay past 2³¹ − 1 ms, and a timer fires no
  earlier on either of Rust's platforms. A test of the browser clock holds that a due past the
  longest waits the longest; how the rounding meets the TypeScript side's arm in a page is weighed
  there.
- **The tests** run under Node in the `rust` job, wasm-bindgen-test-runner's default host, which
  has the clock's four APIs; Chromium runs what only a page has, a `web-sys` WebSocket or a
  `MessagePort`. A test that panics on purpose runs under `#[cfg(panic = "unwind")]`, unwinding
  being impossible in a browser on the pinned stable, and `vectors.json` is embedded in a browser
  build. The conformance players play on the browser's executor, as scenario functions independent
  of the runner, before the matrix states the platform as running, its row saying "unit tests
  alone" short of that.
- **`Send` for what a page holds `!Send`** has two candidates, chosen on a probe of the first
  transport that holds one. `MaybeSend` and `MaybeSync` (wgpu, matrix-sdk): the supertraits
  replaced, an alias per target for each boxed `dyn` (E0225), `arc_with_non_send_sync` firing in a
  browser. A thread-bound handle (leptos' `SendWrapper`, the browser clock's own table): every bound
  stays `Send`, at a lookup per access and a `Result` refused on the wrong thread, and it survives
  WebAssembly's threads, where `MaybeSend` does not. Past 1.0.0, only the thread-bound handle stays
  open without a major release (`trait_removed_supertrait`).
- **The runtime fields in a browser** have two candidates: absent, both targets named in
  `[package.metadata.docs.rs] targets`; or matrix-sdk's drop-in, a public unit `Handle` documented
  as nothing to give in a page, so that a crate built for both targets sets the field without a
  `cfg`. Neither moves a native caller's surface.
- **The evidence it starts from**: the owner's twins pass on `spawn_local`, in Chromium 156 in a
  page and in a dedicated worker, and under Node 26.10.0:
  `sends_each_call_in_the_order_it_is_made_whatever_order_it_is_awaited_in`,
  `a_call_s_future_dropped_unpolled_still_sends_its_call`,
  `a_call_a_listener_makes_within_a_turn_goes_behind_every_call_made_before_it`,
  `an_envelope_a_listener_hands_its_router_within_a_turn_is_taken_behind_what_came_before_it` and
  `keeps_its_connection_when_the_application_drops_its_last_handle`, with spec 9.0's three pairs,
  among 298 of 314 tests.

**Its gates**: clippy's denied table and `build.warnings`; clippy's `disallowed-methods` and
`disallowed-types`, which hold every spawn and every reading of time to the funnel; the core's
clippy for `wasm32-unknown-unknown`; rustfmt; cargo-deny; `bead-house`'s parameter rule, options
structs, surfaces, comment tags and lints' inheritance; the players of every conformance file the
core reaches and the twins, which `spec/check.py` holds by Rust's row of `SIDES` and its `AHEAD`;
the coverage floor of lines and regions; and CI's `rust` job, on Linux and on Windows.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)):
seventeen objections, each checked against its probe before it was answered, fifteen accepted, two
in part, none refused; the form of a module's documentation was the user's to choose.

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A call written as an `async fn` takes effect when first polled: calls go in await order, a future dropped unpolled sends nothing, and "dropping a call's future cancels nothing, as a promise or a `Task` not awaited does" is false; TypeScript and C# draw ids and send in call order.                                                                                                                                                                                                                                                                                            | **Accepted.** Every operation the other sides start as it is called is a plain `fn` that checks its arguments, posts its job to the owner, which draws the id and sends in call order, and returns a named `#[must_use]` future that only waits; a refusal as it is made is its `Err` at once, as both sides throw it synchronously. "An operation takes effect when it is made; its future only waits". Twins `sends_each_call_in_the_order_it_is_made_whatever_order_it_is_awaited_in` (probed: `[1, 2, 3]`, the third dropped unawaited) and `a_call_s_future_dropped_unpolled_still_sends_its_call`.                                                                                                                                                                                                                                                                                                                                                                                             |
| The spike's criteria leave out the runtime descriptors that [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md) requires of Rust and that the gateway and beadc's target build on; criterion 2 says every entry and then excuses two by a library's type, which would write `needs set to no field` as the bytes of `needs set at its defaults`, where both sides refuse it, reopening [0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md). | **Accepted.** Criterion 5: the runtime descriptors the records check and the required walk read, and a dynamic message for the gateway's ProtoJSON, from the codec's library or a facade of Bead's that the spike measures. Criterion 2 passes or fails over every `proto` entry; a written value can leave a required field unset and is refused when it does; Buffa passes only through a write form that tracks presence, else the spike moves on. No entry excuses a library's representation. Run, Buffa's write form that tracks presence is its `DynamicMessage`, its views recording presence from the wire alone: the two values that leave a required field unset go through it, a platform row of the matrix, **the user's choice**.                                                                                                                                                                                                                                                      |
| A unit test beside its module cannot use a separate test crate's clock, that crate depending on `bead` (two copies, `E0277`); `cargo build --workspace` builds `bead` with the feature on; the feature's name fails `redundant_feature_names`.                                                                                                                                                                                                                                                                                                                                      | **Accepted.** The kit is inside the core, as tokio's `test-util`: `#[cfg(any(test, feature = "testing"))] #[doc(hidden)] pub mod testing`, `bead` its own dev-dependency with the feature (probed: one copy, a plain build on the default features). An item of the core that the kit alone reaches carries the kit's `cfg`, or `build.warnings` fails a build without the feature on its dead code; CI builds the default features and documents with all of them. `spec/check.py`'s Rust tests name `src/testing`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unreachable_pub` and the nursery's `redundant_pub_crate` refuse every visibility of an item in a private module; the draft passed only because every probed module was public. `missing_const_for_fn` with `avoid-breaking-exported-api = false` pushes `const` onto public functions; `single_use_lifetimes` has known false positives.                                                                                                                                                                                                                                           | **Accepted.** `redundant_pub_crate` and `missing_const_for_fn` allowed at priority 1, each with its reason in the table; `single_use_lifetimes` off; `avoid-breaking-exported-api = false` kept, so the other API-shape lints judge the public surface while `0.y` lets it break. The table was run over a tree shaped like the core and passes whole; every other nursery lint stays denied, one allowed later a line of the table with its reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The nightly's branch coverage counts no `match` arm and no `?`, which is how a codec and a router decide, while stable's regions see every way not taken; the nightly leg costs a hand-moved pin and an unstable flag, and its figure is not what cobertura or istanbul count.                                                                                                                                                                                                                                                                                                      | **Accepted.** Lines and regions on the pinned stable, read from `llvm-cov`'s JSON export (probed: its `type`, its version 3.1.0, each file's `summary.lines` and `summary.regions`); `tools/coverage-report.mjs` reads it, told from istanbul's JSON by its `type`; Rust's floor names `lines` and `regions`; a floor on a measure no report measured fails, for every side. The matrix's row reads `Rust counts regions where the others count branches`; the nightly serves the fuzz build alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The spec's throws (9.0, 13, 15.1) have no Rust form beyond listeners; the core must play "a resolver that throws before it answers is answered PROCEDURE_FAILED, and reported", and the draft never says what a resolver returns to throw, or what its panic becomes.                                                                                                                                                                                                                                                                                                               | **Accepted.** A resolver returns `Result<T, ResolverError>`: `Other(Box<dyn Error + Send + Sync>)`, a failure among them reported as itself, answered `PROCEDURE_FAILED` with no detail and reported, the variant named `Other`, since `Error` would repeat its type's word. Admissions, verifiers, key sets and an application's codec take the same shape, or a boxed error where the other sides answer every throw alike. A panic is its site's throw. The row becomes `A panic under panic = "abort"`, every throw site.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A resolver's NaN goes through `Value::from`, `json!`, `to_value` and `to_string` as `null` without an error, where `spec/codecs.json` and both sides refuse `not a finite number`; the excuse would hide a miswrite, and the reader's mapping of a number is unsaid.                                                                                                                                                                                                                                                                                                                | **Accepted.** `bead::json::to_value`, a `serde::Serializer` of Bead's own with its own compound serializers, so a nested NaN is refused too, is the resolver's documented road to a value; the harness gives a double through it, so NaN and Infinity are played, five entries excused, not seven. The reader reads a whole number within `i64` or `u64` as an integer, any other as the nearest double, both written back through the double.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A runtime built without `enable_time` passes `Handle::try_current()`, and tokio panics as `SystemClock` arms its first timer, inside a Bead call.                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Accepted**, its first remedy: the builder arms a zero timer once at construction, under the handle's `enter()`, within `catch_unwind`, and what tokio panics there is a `ProgrammerError` ("a router's runtime enables tokio's time driver"), probed on the current runtime, the given handle's path held by a twin of its own. Its cost stated: one caught panic through the application's hook, and under `panic = "abort"` an abort at that construction, within the panic row. The README names `enable_all` or `enable_time`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A `#[repr(u16)]` enum cannot hold a code none of spec 8.1's names names, which the spec keeps as a number; `TryFrom<u8>` has the wrong width; `LONGEST_TIMER` in milliseconds contradicts the durations' type.                                                                                                                                                                                                                                                                                                                                                                      | **Accepted, and widened**: an open code space is a newtype with associated constants, `ProtocolCode(NonZeroU16)` as `http::StatusCode` (probed), and so is `CredentialScheme(u16)`, since spec 9.2's first step answers a scheme the receiver takes none of `CREDENTIAL_UNSUPPORTED` by its number. Closed enums stay where the spec refuses the unknown: a kind (3.3), a failure's flags (7.2), a `JWT`'s `alg` (13). `Failure::code` is a `NonZeroU16`; `LONGEST_TIMER` a `Duration`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Cargo features `trace` and `metrics` give Rust a Z the others lack, which `CLAUDE.md`'s parity rule forbids, and cost a second build, `required-features` and `cfg` at every site.                                                                                                                                                                                                                                                                                                                                                                                                  | **Accepted.** No such features; Rust builds the trace, the filter and the registry, and its cell of `Debugging left out at build time` reads `not available` as the others'. Leaving debugging out at build time is a decision of its own for every side; [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md) is not revised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `#[non_exhaustive]` options keep public fields assignable from another crate, which is C#'s object initializer; Cargo's SemVer reference makes a public field added to a struct with no private field major, and the attribute added later major too, and advises marking a struct at its introduction.                                                                                                                                                                                                                                                                             | **Accepted.** Every `…Options` is `#[non_exhaustive]` from its first commit, `Default`, public fields, set by assignment over the default; probed, `field_reassign_with_default` does not fire on that form from another crate. One form: no `with_*` setters beside it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `warnings = "deny"` in the lints table breaks the nightly legs on any warning a newer rustc adds; Cargo 1.99.1's `[build] warnings = "deny"` covers rustc, clippy and rustdoc, lives in the folder's config, and is released per leg by `CARGO_BUILD_WARNINGS=warn`. The job caches nothing and has no Windows leg.                                                                                                                                                                                                                                                                 | **Accepted.** `[build] warnings = "deny"` in `implementations/rust/.cargo/config.toml`, the `warnings` level and `RUSTDOCFLAGS` gone; probed, a step's exit is 101 under deny and 0 under `warn`. With coverage on stable, the one nightly step, the fuzz build, sets `CARGO_BUILD_WARNINGS: warn`. The job caches the registry and the target by the lock and the toolchain, and a `windows-2025` leg runs `cargo test --workspace --all-features --locked`, as the builder's job runs on Windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The owner is mapped onto `SerialScheduler` by name, yet C#'s `Run` takes a `Func<Task<T>>` whose continuations interleave at each await and runs inline when on the scheduler; a call a listener makes within a turn runs inline on the other sides and at the queue's tail in Rust; "the owner's task ends when its last handle drops" is Rust's alone.                                                                                                                                                                                                                            | **In part.** Accepted: both differences are stated, the router is re-cut as turns and continuations rather than ported line by line, and the owner lives while its application or its transport holds it, the transport holding a handle, as a router lives on the other sides, and ends once neither does (twins `keeps_its_connection_when_the_application_drops_its_last_handle` and `a_router_never_disposed_ends_once_its_application_and_its_transport_let_it_go`). Narrowed: the turns themselves are the other sides' (what C# runs between two awaits is one job), and a call made within a turn, which cannot run inline, the turn borrowing the state, goes to the queue's tail, behind what that turn sends and among what it defers, the order every side keeps by [0045](0045-a-router-takes-what-its-application-makes-in-one-queue-behind-the-turn-that-tells-it.md), whose round weighed it, held by `a_call_a_listener_makes_within_a_turn_goes_behind_every_call_made_before_it`. |
| Merging 1a, 1b and 1c as one branch, `SIDES` in its last commit, leaves the core invisible to `spec/check.py`'s twins and reads until the end, while every cross-language change on `develop` must be ported to the branch by hand; `AHEAD` already holds parts of a side ahead.                                                                                                                                                                                                                                                                                                    | **Accepted.** A step merges once it plays, with the side's row of `SIDES`; each part ahead is an open row of `AHEAD`, which the step that plays it deletes; Rust's reads of `spec/vectors.json` name each group, so that a group ahead is never credited; and the matrix states what the side plays of how many.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The draft moves the spec to 0.9.1 and every file's `specVersion` on the feature branch; [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) moves the spec's version in the release commit, its minor or patch the maintainer's to say, and history agrees.                                                                                                                                                                                                                                                                                                       | **Accepted.** A feature branch leaves `specVersion` as it is: the spec's version moves in the release commit by 0008's rule, its minor or patch the maintainer's to say, `tools/release.mjs prepare` moving it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Better Comments builds its pattern from the language's line comment, `//` for Rust, so every `//!` line, Rust's inner doc comment, which the draft requires on every crate and module, renders as the `!` alert; `bead-house` must tell `//!` from `// !`.                                                                                                                                                                                                                                                                                                                          | **In part.** The facts hold, and `bead-house` tells them by rustc's own tokens, a doc comment never being a tag. The form was the user's, two of their own rules meeting here, Rust's newest norms and `CLAUDE.md`'s tags as the extension shows them: (a) no `//!` anywhere, a module's docs as `///` on its `mod` item, a crate's from its README, `bead-house` refusing `//!`; (b) `//!` kept, the language's and std's form, `CLAUDE.md` naming it Rust's one exception. **The user chose (b)**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The draft's notes on Rust's idioms say `Sync` is "read from several threads at once", too narrow, since a `Mutex<T>` is `Sync` and written through, and credit cargo-deny with answering for `unsafe`, which it never checks; `'static`, `dyn` and Cargo features are missing.                                                                                                                                                                                                                                                                                                      | **Accepted.** `Sync` is "`&T` can be shared between threads", a `Mutex` the example; cargo-deny's four checks named and its silence on `unsafe` said; notes added on `'static`, on `dyn` against generics and on Cargo features, the kit's `testing` the example; the note on `async` rewritten by the first objection's answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### The runtime seam

A second round met a draft that built the browser platform whole: eight objections, each checked
against its probe before it was answered, six accepted, two in part, none refused; no point was left
to the user.

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The gate as specified fails CI. Run as CI runs it (`--workspace --all-targets`, the cap lifted so no crate hides its dependents), the disallowed list flags 42 sites in the seamed copy, not the 22 of `--lib`. Those include targets kept native, and tests that go through a kit that re-exports std's `Instant`. The list misses `Instant::elapsed`, `tokio::time::{timeout, sleep_until, interval}`, `Handle::current`, `JoinSet::spawn`, `block_in_place` and `std::thread::sleep`.                                                                                                    | **Accepted.** Rerun on the repository with the list completed and `disallowed-types` added for std's and tokio's `Instant`, which holds every `elapsed` (`clock.rs`'s among them): 92 sites. 23 are in the library and collapse into two funnels, `platform` and `SystemClock`'s native body, each with one `#[expect]`; spawning becomes a function there, since a re-exported `Handle`'s `spawn` is still flagged. 42 are in 13 unit-test files and move to the kit, whose `Instant` becomes a newtype. 27 are in five native-only targets, each exempted once with its reason. The count is stated from the CI command. |
| The C# side can run in a page: .NET 10's `browser-wasm` runs a `net10.0` library, and the platform analyzer finds 22 CA1416 sites in `Bead.Core`, all in four files (TCP helpers and `ECDsa.Create`), none in the router, the scheduler, the clock or the codec. Recording "not available" makes a gap that can close an impossibility, against Parity, and the choice is the user's.                                                                                                                                                                                                       | **In part.** The evidence holds (22 sites, deduplicated by position), and the matrix is corrected: `The Web Worker transport` becomes open, its C# and Rust cells ahead, and a new open row, `The core in a page and in a worker`, names what stands in the way on each side. No point goes to the user: no side gains a page in this round, and Parity settles that the two sides come into a page together, in the stage that takes Rust there.                                                                                                                                                                          |
| A simpler option was passed over. No surface freezes on this choice, so the only reason for now is drift, which the gate alone stops natively. The option is the native funnel, the gate, and a compile-only clippy run for the browser's target, with the platform waiting for a consumer; none exists, and the measure in a worker is a workload hypothesis to test. The draft understates its costs: `wasm-bindgen-test`'s unconditional dependencies built into every native test, 41 files rewritten, a job and its driver, two clocks, a CLI pin, rows that state an unused platform. | **Accepted, and taken as the decision.** It is verified: `wasm-bindgen-test` 0.3.79's dependencies are unconditional, and the measure's own report disowns its ratio. The browser target's check runs on the repository as it stands, clean, with getrandom's `unsupported` backend given per target in `.cargo/config.toml`: no dependency, no lock entry, 11.5 s. The browser half is designed and recorded ahead, and the owner's twins on `spawn_local` are its evidence.                                                                                                                                              |
| `target_os = "unknown"` names no browser. getrandom, on which the draft relies, refuses to infer JavaScript from that target and recommends against `wasm_js` in a library. A `#[wasm_bindgen] extern` import fails a host without JavaScript when the module is instantiated. The remedy is a `web` feature with a `compile_error!` without it, or the target alone with its reason recorded.                                                                                                                                                                                              | **In part.** The library enables nothing for the target, and the check gives getrandom its `unsupported` backend, as getrandom asks. The browser half sits behind a `web` feature that turns on `wasm-bindgen`, `web-time` and getrandom's `wasm_js`, within getrandom's own exception. The `compile_error!` is not taken: it would break the browser target's check. Without the feature, the core refuses through a `Result`.                                                                                                                                                                                            |
| The browser clock fires at once past 2³¹ − 1 ms: HTML's `setTimeout` takes a signed 32-bit `long`, and the draft binds a `u32` and falls back to `u32::MAX`. Chromium and Node fire those dues at once, while tokio waits. `as_millis()` truncates where tokio rounds a deadline up.                                                                                                                                                                                                                                                                                                        | **Accepted**, verified on Chromium 156, Node 26.10.0 and tokio's source. The delay is bound as an `i32`, each due clamped to `LONGEST_TIMER` and rounded up to its next whole millisecond, as tokio does natively, and a test of the browser clock holds that a due past the longest waits the longest.                                                                                                                                                                                                                                                                                                                    |
| Chromium adds nothing that Node does not catch (298 of 314 on each, the same 16 left). It needs a Playwright job and a driver of Bead's own, and it is a Z for one side, since the TypeScript side's unit tests run under Node alone. The conformance corpus never plays on the browser's executor.                                                                                                                                                                                                                                                                                         | **Accepted.** The browser half's tests run under Node, in the `rust` job, and Chromium runs what only a page has. The corpus plays on the browser's executor (scenario functions independent of the runner, the vectors embedded) before the matrix states the platform as running, the row saying "unit tests alone" short of that. No browser test job is added in this round.                                                                                                                                                                                                                                           |
| `MaybeSend` is decided too early: it fixes the public supertraits of 13 traits and the boxed aliases before the transport it serves exists. The draft's own browser clock shows the alternative, a `Send` handle over a thread-bound value, as leptos' `SendWrapper` does, which has none of `MaybeSend`'s costs and survives atomics.                                                                                                                                                                                                                                                      | **Accepted.** The record states the question with both candidates, `MaybeSend` (wgpu, matrix-sdk) and the thread-bound handle (leptos, the browser clock's table), chosen on a probe of the first transport that holds a `!Send` value. Past 1.0.0 only the thread-bound handle stays open without a major release. "Impossible: a browser build with threads while `Send` is kept" is withdrawn, since a key crosses threads where a `JsValue` cannot.                                                                                                                                                                    |
| Aliasing tokio's `Handle` as `Runtime` inverts tokio's vocabulary (a `Runtime` owns the workers, a `Handle` refers to one), and matrix-sdk keeps tokio's names. Absent fields in a browser force a `cfg` per assignment and leave the browser surface undocumented on docs.rs.                                                                                                                                                                                                                                                                                                              | **Accepted.** The funnel's type is `Handle`, tokio's own natively. The fields in a browser keep both candidates: absent, with both targets in `[package.metadata.docs.rs] targets`, or matrix-sdk's drop-in, a public unit `Handle` documented as nothing to give in a page. Neither moves a native caller.                                                                                                                                                                                                                                                                                                                |

### A request's identity, and the router beneath a service manager

A third round met the draft that gave the Rust core its small APIs for eight rows the TypeScript and
C# sides share: eleven objections, each checked against its probe before it was answered, eight
accepted, three in part, none refused. It brought into the change the rule spec 9.3 and 9.4 hold
every side to, an answer or a subscription going only to a request its router dispatched, which the
TypeScript and C# sides keep by refusing any other header. The Rust port beneath the service
manager holds, the inner half of the matrix's row; its public half is the row's.

| Objection                                                                                                                                                                                                                                                                                                        | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The draft records, as a design difference, that the TypeScript and C# sides answer a header they never dispatched; that breaks spec 9.3 and 9.4: an answer given a copy goes out, marks nothing and closes nothing, so the call's own answer goes out too, and a cancelled call's copy answers after the CANCEL. | Accepted. The probe sends two RESULTs on call 7 and a RESULT on call 5 after its CANCEL; C# takes the same path. Fixed in this change: `isAnswering` and `IsAnswering` are `false` for a header never dispatched, `respond` and `subscribe` refuse one, a `ProgrammerError` on the TypeScript side and an `ArgumentException` on the C# side, which has no `ProgrammerError`, before the disposed gate; the transfer refusal folds into it. No product code answers a header it was not handed; 25 TypeScript and 23 C# test sites move to a dispatched header. A CHANGELOG line under Fixed names 9.3 and 9.4; no matrix row. |
| The Rust twins of rows 1 and 5 keep their source's title but assert `false` where the source asserts `true`, and cannot show the difference they are cited for.                                                                                                                                                  | Accepted, through the first answer: all three sides assert `false`, the twins are whole, and neither row needs an excuse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The cost given leaves out the test kit's pattern: Rust's `Peer::respond` opens a call, then answers it; the Rust cell's "answers nothing" holds only for the public surface.                                                                                                                                     | Accepted. The TypeScript and C# sites open their call first and answer the header it was handed, as `Peer::respond` does: each changes its header argument, never its scenario. The cell is gone with the row.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Taking `IRouterLike` off the TypeScript and C# surfaces applies a leveling that does not fit: Rust is the partial side, can take a router of the application's own (`RelayRouter`), and `IRouterLike` is a released extension point.                                                                             | Accepted. The row is the partial side's, `Rust's service manager over a router of the application's own`, ahead; `IRouterLike` stays; `RouterLike` stays `same` with Rust `-` and `ServiceRouter` `alone`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Refusing a Rust port because its double would be the only Rust router reaching those paths holds Rust to a standard the other sides' fakes do not meet.                                                                                                                                                          | Accepted. The reason is its size, a moderate refactor beyond small APIs; the `pub(crate)` port is the inner half of the row's closing, and when it comes is the user's to choose.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Row 6 needs a window between held and settled; a Rust port with a synchronous registration would close nothing of it.                                                                                                                                                                                            | Accepted. The row's closing asks for a registration held when made whose future only waits for the subscription, as this record lets an operation be.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The seam moves the identity rule only partly into the part: `end_counted` and `ended` still read the map, and `get_mut` stays in the core's reach; the claim that the seam twins `answering-calls.test.ts:31` and `:81` does not follow.                                                                         | In part. Every read by identity goes through the part, `get_mut` private to it, and "counted once" has one home, `Answering::end`; a part-level `end` holding the clock, and the counting on close, take and take-all moved into the part, are what those two rows need: stated as beyond this change, the claim dropped.                                                                                                                                                                                                                                                                                                      |
| Row 5's twin reads the part directly, so the core function the Rust server calls is never exercised.                                                                                                                                                                                                             | Accepted. The twin builds each request's `Dispatch` with the id and header it was dispatched with and asks `router_core::is_answering`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Merging `Answerer` and `AnswerTarget` into one `differs` row ties a lasting difference of shape to a row whose closing leaves both names in place.                                                                                                                                                               | Accepted. Both stay `alone`, as `RelayRouter` and `IRouterTarget` do; with no row of how a side answers, `tools/names.tsv` does not move.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The test kit's behaviour moves: `Peer::respond` through `open` forgets a call abandoned on that call id; and the workspace's gates were not run.                                                                                                                                                                 | In part. The kit keeps `open`, the move stated: it answers as a dispatched call would, a request opening that call id forgetting its abandon on the wire too. The workspace's suites and docs pass with it; `cargo deny` reads no manifest that moves.                                                                                                                                                                                                                                                                                                                                                                         |
| `AnsweringCalls::of` names nothing and reads like a constructor; rename it `call_of`.                                                                                                                                                                                                                            | In part. Renamed, to `answering_of`: it names what it gives, as `signal_of` and `receiving_of` do, and leaves `call_of`, which `router/answers.rs` keeps for a dispatch's address.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### On the Rust side's form in the spec, its companions and the records

A round met the draft that lifted the last passages of the spec's companions naming two sides'
forms, named the Rust side's where the records name forms, and gave the spec a gate that keeps it
from naming a language: eight objections, each checked before it was answered, six accepted,
two in part, none refused.

| Objection                                                                                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The draft's rows for `DisconnectError` and `CancelError` turn `tools/check-names.mjs` red: the rule `error` keys a variant by its own name, `disconnected` against `disconnect`, and an `own` row names one side alone; `TimeoutError`, the same case, is left `alone`. | Accepted. Probed: both rows fail as drafted. The rule gains the participle, as std's `io::ErrorKind::TimedOut` names a timeout: a variant's keys are its own and the stems its first word may come of, -ed or -d taken off, a doubled consonant single again. `DisconnectError`, `CancelError` and `TimeoutError` are `rendered: error`, the C# cells `-` for the platform's `OperationCanceledException` and `TimeoutException`; the pin falls to 333; 0044 states the rendering; a test of its own pins three pairs that render and two that do not. The rows pass, the whole file passes, and the 23 tests of the gate pass.                                                                    |
| The gate does not hold O5's rule: its second check reads `tools/names.tsv`, which holds no members, and at the forms sweep's parent it passes three of the pairs that sweep had to move.                                                                                | Accepted. Verified: `check-names.mjs` leaves members to each side's surface test, and the pairs at debugging 252, 259 and 538 pass the drafted checks. The second check is the pair check: two backticked identifiers side by side, one name under `check-names.mjs`'s case rules and spelled apart, read by paragraph so a pair across a line break is caught. It finds the five pairs before the sweep, the two the sweep left, none on the revised text, and no false hit. The `names.tsv` lookup stays as a third check, for a side's type named alone. The gate is implemented at high, run red on both texts and green on the revised one.                                                   |
| Lifted as drafted, 9.7 sends the reader to `tools/names.tsv`, a tool's input that cannot hold the C# side's cancel, the platform's, where 17.2 sends a reader to the support matrix; and no row of the matrix names a disconnection or a cancel.                        | Accepted. Verified: no row names the six types, and 17.2 sends its reader to the matrix. 9.7 states the rule and ends "Each side's two types are the support matrix's"; a matrix row names the three disconnections and the three cancels, citing the six twins of 9.7, two on each side. The unit stays a wording change.                                                                                                                                                                                                                                                                                                                                                                         |
| 0028's rewritten sentence answers "anything else a decoder throws" `PROCEDURE_FAILED`, unscoped, where 17.2 answers so at a request alone: a result's or a notification's decoder fails as a refusal does.                                                              | Accepted. Verified against spec 17.2. The sentence answers a request whose check refuses it `PAYLOAD_UNDECODABLE`, a request's decoder that throws or panics other than by its refusal `PROCEDURE_FAILED`, with no detail, reported, and has a result's or a notification's fail as a refusal does.                                                                                                                                                                                                                                                                                                                                                                                                |
| The 9.4 row adds a codec's bug but leaves out a rule that fails to judge, which 17.2 pairs with it and 18.2 answers `PROCEDURE_FAILED`; the twins are placed in files with no registry; the claim that the change is wording rests on one side's probe.                 | Accepted. Verified: 18.2 answers a rule that fails to judge `PROCEDURE_FAILED`, the drafted files hold no registry, and the C# and Rust sides were read, not run. One row names a side's own error before it answers: a resolver that fails, a codec that fails other than by its refusal, a rule that fails to judge, or a result it cannot send. Its twins go beside the tests that count a server's call, two per side, the Rust one named by its panic; the change is a patch when all three pass as they stand, and a bug of a side, with the companion's minor, otherwise.                                                                                                                   |
| In 12.6, "one the client makes itself connects as RFC 8305 does" binds the C# side alone, since on the TypeScript side the platform's `fetch` connects, and claims the whole RFC where both sides follow §4 and §5.                                                     | Accepted. Probed: Node's `fetch` races a name's families with `autoSelectFamily` on by default, and fails to the other family with it off; the C# transports interleave and race at 250 ms, with no separate AAAA and A queries. The sentence reads "What carries them when its application gives none races a name's address families, as RFC 8305 §5 asks", held by the TypeScript side's platform and the C# side's transports; both delays lie within §5's bounds, so no matrix row.                                                                                                                                                                                                           |
| "Stock" is given one meaning only in 0031's Consequences, where the uses that bind are the spec's and the matrix's, and 0003 puts a meaning where it binds; the two options go to the user.                                                                             | In part. The finding holds: the spec, the transcoding companion, the matrix, the README's bench keys and nine records use the word, and none defines it. Option (a) is taken without putting it to the user: 17.9 defines it at its first use, "the one it takes as published, in whose place nothing of Bead's reads or writes the binary format", held to the binary format since Bead's own JSON mapping reads and writes JSON in the library's place, and 0031 follows. Option (b) would leave the word on a measured surface, `transcoding.read.stock`, and in the transcoding companion, while the spec dropped it: two vocabularies, which 0003 refuses. Unit 17.9 moves, wording, a patch. |
| 0010's pairs turned into triples copy into a record no gate reads what `tools/names.tsv` holds under a gate, and drift; 0011's condition is settled, since the Rust side holds `LONGEST_TIMER`.                                                                         | In part. 0010's list names each member once, in the spec's case, and says the surface is named alike on every side; it does not point to `tools/names.tsv` for them, which holds no members: a type it lists is held there, a member by each side's own surface test. The same rule carries the rest of the records' sweep. 0016's file paths and 0033's conversations keep their additions, a place in the tree being a side's own. 0011 reads "which the C# and Rust sides keep for parity", verified at `duration.rs:16`.                                                                                                                                                                       |
