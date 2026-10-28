# 0044 — The Rust side owns each router's state in one task, starts each operation as it is made, composes traits, forbids unsafe code, takes two parameters and an options struct, and builds without a warning

- **Status**: accepted
- **Scope**: the Rust side, `implementations/rust`, its first stage, the core before any socket
  ([0036](0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md)),
  in three steps: **1a**, the envelope's and a parcel's codecs, the routers, client and server, the
  managers and the service layer, sessions and credentials with a `JWT`'s verification, the clock
  and the durations, the trace, the filter and the registry, the transports' generic part, the
  in-memory transport and the interop service; **1b**, the broker's core, the in-memory broker and
  the joined transport; **1c**, the `proto` payload's codec, under its spike; and every conformance
  file the core plays over them; the workspace, its toolchain, its lints, its gates, its CI job and
  its coverage floor. Beside it, **the partial side**: a side that plays part of the corpus while
  its steps and stages land, each part ahead a row of [the support matrix](../support.md) that
  `spec/check.py`'s `AHEAD` holds
  ([0004](0004-one-behaviour-in-every-language.md)). This record is
  [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)'s twin for Rust; the
  toolchain's place is [0005](0005-a-toolchain-per-language.md)'s, the names and the versions
  [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)'s, a clock
  [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)'s, a duration
  [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s, a `json` payload
  [0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)'s. The transports over
  sockets and the interop, the broker bindings, the gateway and beadc's Rust target are each a
  stage ahead, under a record of its own; the crate's layout and its modules are its README's.

## Context

Rust becomes Bead's third language (the user, 2026-10-27), at parity with the TypeScript and C#
sides, its surface mapping almost name for name, its tests answering to the same conformance
files. Rust's own norms meet the house's at every line: no exceptions but a `Result`, no base class
but traits, no garbage collector but ownership, no runtime but the application's. Carrying
JavaScript's or .NET's idioms over word for word fights the language; taking Rust's defaults alone
makes three designs of one.

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
through `Value::from`, `json!`, `to_value` and `to_string` alike; of `spec/codecs.json`'s 24
doubles written, Rust's `Display` spells 13 as RFC 8785 does, `serde_json` 15, `ryu-js` 1.0.3 all 24. `Duration::from_secs_f64` rounds to the nanosecond: no input of `spec/durations.json` lies near
a half for it, and none is finer than its tick. On stable, `-C instrument-coverage` counts lines
and regions, a region for every way a decision can go, and no branch; the nightly's
`-Z coverage-options=branch` counts `if`, `if let`, `let else`, `&&` and a guard, and no `match`
arm and no `?`, which are how a codec and a router decide. A runtime built without tokio's time
driver passes `Handle::try_current()`, and tokio panics as a timer is armed. Clippy's
`too_many_arguments` counts the receiver.

**The options weighed, and not taken**:

- **An executor abstraction** over several runtimes: a second way to spawn, time and cancel, for
  runtimes no side's user asked for; tokio, the ecosystem's, is the application's runtime.
- **A bounded queue** per router: a backpressure of Rust's alone, where JavaScript's microtasks and
  the C# scheduler are unbounded and what bounds work is Bead's own, `maximumAnsweringCalls`,
  credit and the limits of spec 12.2.
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
  no Miri, for the TLS of a later stage alone.
- **cargo-nextest**: a second runner, where Cargo's own runs the doc tests among the rest.
- **A minimal beadc target in this stage** for the interop's descriptors: beadc's Rust target is a
  stage of its own; until it lands the descriptors are written by hand and held to the blueprint.

## Decision

### Three steps, then the stages after

| Step   | What lands                                                                                                                                                                                                                                                                                                                                                                                                   | What it plays                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1a** | `bead`: the envelope's codec, the routers, the service layer and its managers, sessions, credentials and a `JWT`'s verification, the clock and the durations, the trace, the filter and the registry, the transports' generic part, the in-memory transport, the client and server facades, `bead::json`, and the test kit `bead::testing` behind the feature `testing`; `bead-interop`, the interop service | `spec/vectors.json` but its broker's groups; `spec/conversations.json` through a scripted transport and through the in-memory pair; `spec/clocks.json`; `spec/durations.json` but its transports' places; `spec/identities.json` but the ids no `u16` and no `u32` holds; `spec/codecs.json`'s `raw`, `text` and `json` entries; `spec/debug-filters.json` and `spec/metrics.json` whole; `spec/validations.json`'s details; the spec's and the companion's twins but those of its transports |
| **1b** | in `bead`: the broker's core, its participant, its parcel, its sequence, its heartbeat and its transports, the in-memory broker, the joined transport                                                                                                                                                                                                                                                        | `parcels` and `parcelRefusals`; the cases over the in-memory broker of `spec/transports.json`; the conversations through a broker pair; the broker's places of `spec/durations.json`; spec 15.14's twins                                                                                                                                                                                                                                                                                      |
| **1c** | `bead-protobuf`, after its spike                                                                                                                                                                                                                                                                                                                                                                             | `spec/codecs.json`'s `proto` entries; protobuf's conformance suite through a Rust testee of `tools/protobuf-conformance.mjs`                                                                                                                                                                                                                                                                                                                                                                  |

1b sits in the core because the C# side's `Bead.Core` holds the broker's core and the in-memory
broker, and its cases need no socket; 1c apart, because the router never depends on protobuf and
the codec's library is a spike's to choose. **Each step merges once it plays**: 1a reaches
`develop` with Rust's row of `spec/check.py`'s `SIDES`, so the twins, the reads and the counts hold
it from then on, and a change that reaches across the languages lands on three sides from then on.
After the core, each a record of its own: the transports over sockets, WebSocket (RFC 6455) and
HTTP/1.1 and HTTP/2 (RFC 9110, 9112, 9113), with the interop both ways; the broker bindings, MQTT 5
and AMQP 1.0; the gateway; and beadc's Rust target with `examples/hello`'s Rust half.

### The partial side

A side may play part of the corpus while its steps and stages land
([0004](0004-one-behaviour-in-every-language.md)). **What it does not play yet is a row of the
matrix's differences, of kind open, whose cell for that side says it is ahead, and a row of
`spec/check.py`'s `AHEAD`**: each part a transport of `spec/transports.json`, a group, a file read
whole, an encoding, a unit or a document whole, a durations place's owner or a place's way. The
check consults it at every turn: the twins skip a unit ahead, the reads a group, a file or an
encoding ahead, the durations' harness a place ahead, and the conformance table's cell of that
side states what it plays of how many where part is ahead. **A part ahead that the side plays
fails**, so the table only shrinks, and a step or a stage lands by deleting its row. A side's tests
are told from its sources by a predicate where a suffix does not tell them: the Rust side's are a
module's `tests.rs`, a crate's `tests/` and the test kit, `src/testing.rs` and `src/testing/`, so a
doc comment on a source's item never stands for a twin.

### The workspace and its names

- A virtual workspace, `implementations/rust/Cargo.toml`, `crates/*` its members, one
  `Cargo.lock`, committed, every build `--locked`; `fuzz/`, a cargo-fuzz project outside it;
  `benches/`, `bead-bench`, the in-memory bench 0036 asks of each side.
- **The crates mirror the C# assemblies**, not the TypeScript package's subpath exports: a crate is
  Rust's unit of dependency and of `forbid(unsafe_code)`, as an assembly is .NET's. `bead` is
  `Bead.Core`'s twin, `bead-protobuf` `Bead.Protobuf`'s, `bead-interop` the interop service's;
  `bead-house`, dev only, holds the house's own checks. The later crates are named now, so no
  rename follows: `bead-transport-websocket`, `bead-transport-http`, `bead-transport-mqtt`,
  `bead-transport-amqp`, `bead-transcoding`, `bead-transcoding-http`, `bead-interop-server`.
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
`rustfmt` and `llvm-tools`, which come with the toolchain and never from the registry. `edition =
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
item documented and a private one where its invariant needs it, as on both sides;
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
`BSD-3-Clause`, `ISC`, `Unicode-3.0` and `BSL-1.0`; crates.io alone as a source, no git; and
`multiple-versions = "deny"`, each duplicate a listed exception with its reason.

**`bead-house`**, a dev-only crate whose test reads every crate's source with `syn`, holds what no
lint does, as `tools/oxlint-plugin.mjs` holds the TypeScript side's: the parameter rule below, its
cases listed as `oxlint-plugin.cases.ts` lists its own; the comment tags of `CLAUDE.md` on plain
comments alone, none on a doc comment, a doc comment being what rustc's tokenizer reads as one
(`///`, `//!`, `/** */`, `/*! */`), so `//!` is never taken for the `!` tag; and every member's
`[lints] workspace = true`, so no crate leaves the policy. **`//!` is kept**, Rust's inner doc
comment, the language's and its standard library's form for a module's and a crate's documentation:
the one exception to the `!` tag, a doc comment, never the tag, though Better Comments shows it as
one.

### One owner per router

**Each router's state belongs to one tokio task, its owner**, which runs jobs one at a time in the
order they came; a job is a synchronous `FnOnce(&mut State)`, so **a turn awaits nothing** and no
other job runs within it. What waits — a resolver, a send on a transport, a timer — runs off the
owner and posts its outcome as a job of its own: a turn and its continuations, as the C# side's
`async` methods on its `SerialScheduler` run from await to await. `post`, `run`, `cover` and
`when_idle` stand for the scheduler's `Post`, `Run`, `Cover` and `WhenIdle`. The router is re-cut as
turns and continuations, its turns the other sides', not ported line by line: what `RouterCore.cs`
does between two awaits is one job.

**An operation takes effect when it is made; its future only waits.** Every operation the other
sides start as it is called — `request`, `notify`, `subscribe`, `command`, `connect`, `close`,
`dispose` — is a plain `fn` on the handle, never an `async fn`: it checks its arguments, posts its
job to the owner, which draws the call id and sends in the order calls are made, and returns a named
`#[must_use]` future of the outcome (`Call<T>`, `Connect`, …), as a promise or a `Task` is returned
already running. What it refuses as it is made is its `Err` at once, as both sides throw it
synchronously: `fn request(&self, payload: P, request: Request) -> Result<Call<R>,
ProgrammerError>`, read `router.request(payload, request)?.await`. **Dropping a call's future
cancels nothing**: the call went when it was made, and goes on to its answer or its timeout; a
cancel is its options' `CancellationToken`.

Two differences from the C# scheduler, each held by a twin:

- **A turn is synchronous**: a C# method that awaits within the router is cut, at each await, into
  a job and the continuation it posts.
- **A call made within a turn**, a listener's, cannot run inline, the turn borrowing the state: it
  runs when that turn ends, before any job queued after it, from a queue of the turn's own that the
  owner drains first, where both other sides run it at once. Should a conversation or a case tell
  the two orders apart, the difference is put to the user as a divergence.

**What a listener hands its router back** from within a turn — an envelope its transport carries,
a connection let go, a dispose — never takes the turn-end queue: it goes behind every job queued,
taken in a later turn, never within that one, as spec 9.0 has it and both other sides do. A
transport's events reach the owner through `offer_behind`, whatever turn tells them; a dispose
marks its router disposed at once, a flag its handle and its state share, so the rest of its turn
sends nothing, and lets go of what the router holds through `run_behind`. Twins:
`an_envelope_a_listener_hands_its_router_within_a_turn_is_taken_behind_what_came_before_it`, and
spec 9.0's three, a failed resolver's, a failed admission's and a dispose from the report listener.

Beside them: **the queue is unbounded**, as JavaScript's microtasks and the C# scheduler's are;
**resolvers run off the owner**, spawned on the runtime, the router awaiting each one's
`JoinHandle`, so its panic is seen; **the public handles are `Clone + Send + Sync`**, an `Arc` to
the owner's queue, and a resolver's future `Send + 'static`, no `!Send` resolver offered; **the
runtime is the application's**, its handle given in the options or the current one, none a
`ProgrammerError`, and **its time driver checked at construction**: the builder arms a zero timer
once under the handle's `enter()`, within `catch_unwind`, and what tokio panics there is a
`ProgrammerError` ("a router's runtime enables tokio's time driver"), never a panic inside a later
call; Bead starts no runtime and no thread of its own. **The owner lives** until `dispose().await`
or its transport's close, the transport holding a handle to its queue, as a router lives on the
other sides as long as its transport holds it.

### The clock and the durations

A `Clock` trait, `Send + Sync + Debug`, gives the monotonic reading, the wall clock and a timer
armed ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)); **`SystemClock`**, the
platform's, runs on tokio's timers and `SystemTime::now()`, one clock a stack, a second refused.
**tokio's paused time is not the test clock**: it moves no wall clock, fires every timer due at once
in its own order and settles nothing between them, where `spec/clocks.json` asks the armed order, a
periodic timer armed again before its callback and a settle between timers. The stepping clock is
the core's own, in its kit, `SteppingClock.cs`'s twin. What a platform's own socket times stays on
the real clock, as on both sides.

**A duration is a `std::time::Duration`**, never milliseconds as a float
([0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)); **never is
`Duration::MAX`**, `bead::NEVER`, as `Infinity` and `Timeout.InfiniteTimeSpan` are each platform's
own never; held as spec 1.4 holds one, from the nanoseconds; `LONGEST_TIMER` a `Duration`, 2³¹ − 1
ms. A refusal is an `Err` whose reason is a code, `DurationRefusal::{UnderTheFloor, PastTheCeiling,
ZeroRefused, NeverRefused, NotANumber}`, which the harness checks against the file's derived
reason; the words stay Rust's. A `Duration` holds no value under zero, no NaN and nothing that is
no number: those inputs are played at no place, each by its row. A reconnection's delay takes both
ways, a `Duration` and a function of the previous delay and the attempt.

### Failures and errors

Rust's form is a `Result`. Bead's errors are named as the TypeScript side names them, each `Debug +
Display + Error + Send + Sync + 'static`: `Failure`, its code a `NonZeroU16`, an application's code
and the protocol's alike; `CallError`, a `Failure`, a cancel or a disconnection, `#[non_exhaustive]`;
`ConnectError`, `ReconnectError`, `CapacityError`, `ReadyStateError`; `ProgrammerError`, with a
reason code where a file derives one; `BrokerRefusedError` with 1b. An operation returns the error
it can return, never a crate-wide `Error`. **No panic in the library**: a builder that refuses its
options returns `Result<Self, ProgrammerError>`.

**What the spec lets a side throw has a Rust form at every site.** A resolver returns `Result<T,
ResolverError>`: `ResolverError::Failure` is its procedure's own failure, answered as it is;
`ResolverError::Other`, a boxed error, anything else, answered `PROCEDURE_FAILED` with no detail and
reported (spec 9.0). Every other callback the spec lets throw — an admission, a verifier, a key
set's ask, an application's codec — takes the same shape, or a boxed error where the other sides
answer every throw alike. **A panic is its site's throw**: a resolver's seen on its `JoinHandle`,
the others' within `catch_unwind`, answered and reported as the throw it stands for, the transport
going on ([0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)).
Under `panic = "abort"`, which an application may set, nothing unwinds: a platform row of the
matrix, every throw site among it.

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
its fields public, every member an `Option`, `Debug + Clone + Default`, taken by `&`, and set as C#'s
object initializer sets one, by assignment over its default:

```rust
let mut options = RouterClientOptions::default();
options.timeout = Some(Duration::from_secs(1));
let router = RouterClient::new(transport, &options)?;
```

From another crate the fields stay assignable and only the literal is refused, so an option added
later breaks no caller. One form: no `with_*` setters beside it, no builder where the other sides
take an options object. Clippy's `too_many_arguments` at 4, since it counts the receiver, and
`bead-house`'s test for the rule itself hold it, as `max-params` and `bead/options-last` hold the
TypeScript side's.

### Names, side by side

C-CASE gives Rust its cases, and the words are the other sides': `RouterClient::new`,
`MemoryTransportClient::new`, `ServiceManager`, `Clock` for `IClock`, a trait carrying no `I`, an
acronym a word, `Jwt`, `Http`, an overload a second name, `notify` and `notify_unwritten`. A name
that drifts from the other sides' exports is a parity defect, renamed on every side.

### Payloads, a `JWT`, randomness

**JSON** ([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)): **Bead's own
reader**, a strict RFC 8259 tokenizer with spec 17.5's checks in the TypeScript reader's order; a
whole number within 64 bits read as an integer, any other as the nearest double, both written back
through the double; **`serde_json::Value`** the value; **Bead's own canonical writer**, numbers by
`ryu-js`, RFC 8785; and **`bead::json::to_value`**, Bead's own `serde::Serializer`, the resolver's
documented road from its type to a `json` payload, which refuses a double that is not finite at any
depth where `serde_json` writes `null`. What the type cannot hold — a surrogate alone, a name twice,
`undefined` — is excused by its row; NaN and Infinity are played.

**A `JWT`'s verification** on RustCrypto: ES256 by `p256`, its signature R‖S's 64 bytes and nothing
else, HS256 by `hmac`'s constant-time check; pure Rust, so no C toolchain on Windows and
`forbid(unsafe_code)` costs nothing. base64url by Bead's own strict decoder. An `OPAQUE` token's
bytes by `getrandom`, the system's source. **No `thiserror`**: a dozen error types, each a short
hand-written `Display`. **No `tracing`** in the core: a bridge, optional, beside it later. **No
credential in a string** (spec 15.1): a type that holds a credential, a session's token, what a
transport carries or a key writes its `Debug` by hand, a credential by its scheme, a token or a
carried value by whether it is there, a key by its issuer and its algorithm, and never derives it.

### Protobuf, the gate of 1c

`bead-protobuf`'s library is chosen by a spike whose acceptance is the corpus, not a library's
claim, over five criteria: `spec/codecs.proto`, of edition 2023, generated at the pinned protoc;
**all of `spec/codecs.json`'s `proto` entries** pass through Bead's records check, the required walk
and the closed enum's normalization
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md),
[0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)),
a written value able to leave a required field unset and refused when it does, no entry excused by
a library's representation; protobuf's conformance suite at the floor the other sides keep; the
leveled rows kept; and **the runtime descriptors** the records check and the required walk read,
with a dynamic message the gateway's ProtoJSON reads by descriptor, from the library or a facade of
Bead's that the spike measures. Buffa is tried first, then Google's official v4 with a descriptor
facade, then prost with prost-reflect; **no common restriction is added to fit a library**, and
should none meet the five, 1c stays ahead and the finding comes back as a decision.

### Debugging and metrics

The trace, the filter and the registry are Bead's own, as on both sides
([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)), the exposition 0.0.4 byte for
byte, and **always built**: no Cargo feature leaves debugging out, which would be a Z for one side.

### Tests and coverage

- **A module's unit tests in a file beside it**: `src/envelope.rs` declares `#[cfg(test)] mod
  tests;`, its tests in `src/envelope/tests.rs`, with the module's private items at hand.
- **The test kit is inside the core**, as tokio keeps its `test-util`: `#[cfg(any(test, feature =
  "testing"))] #[doc(hidden)] pub mod testing`, holding the stepping clock, each conformance file's
  typed reader, `deny_unknown_fields` and never by index, the durations' helper and what the players
  reach that the public API does not, as the C# players reach it by `InternalsVisibleTo`. The core
  takes itself as a dev-dependency with the feature, so a unit test and a player share one copy of
  it; resolver 3 keeps the feature out of every build that is not a test's. Every item of the core
  that the kit alone reaches carries the kit's `cfg`, or it is dead code in a build without it,
  which `build.warnings` fails.
- **The conformance players** in `crates/bead/tests/`, one file a conformance file, `harness =
  false` under `libtest-mimic`, a trial per entry named by its own name.
- **Twin tests** carry the other sides' sentence in snake case, the unit named in a comment just
  above, `// spec 15.13`, which `spec/check.py` reads. Cargo's own runner: `cargo test --workspace
  --all-features --locked`.
- **Coverage, lines and regions on the pinned stable**, through `cargo llvm-cov`'s LLVM JSON export,
  every test binary's profile merged, the unit tests and the kit left out; read by
  `tools/coverage-report.mjs`, which tells it from istanbul's JSON by its `type`, and held to the
  floor `rust` of `tools/coverage-floors.json`, which names `lines` and `regions`, written by
  `--raise` from the run that lands 1a and never down, over each library crate's `src/`. **A floor
  on a measure no report measured fails, for every side**, which closes the trap of a share of
  nothing read as 100 %.

### The CI job, fuzz and bench

CI's `rust` job ([0006](0006-a-rule-has-its-gate.md)), on Linux: `cargo fmt --check`, `cargo
clippy --workspace --all-targets --all-features --locked`, `cargo doc`, a build on the default
features alone, `cargo deny --locked check`, the tests under coverage held to the floor, and the
fuzz targets built on the dated nightly, never run; on Windows, `cargo test --workspace
--all-features --locked`, as the user's MSVC toolchain builds it. The registry and the target are
cached by the lock and the toolchain, cargo-deny and cargo-llvm-cov installed prebuilt, each checked
by its SHA-256, and `ci-ok` needs the job. **Fuzz**: cargo-fuzz on the nightly, on Linux or WSL, by
hand through `tools/fuzz.mjs`, its four targets the twins the core holds, `envelope`,
`payload-codecs`, `debug-filter` and `jwt`, `http-fields` and `ws-handshake` coming with the
transports. **Bench**: `bead-bench`, the in-memory bench, writing `bead-bench/2` for
`tools/bench-compare.mjs`, run by `tools/bench-release.mjs rust`.

## Consequences

- **Every change that reaches across the languages costs a third side** from 1a's merge on: a Tenth
  Man that weighs three, a twin per behaviour, a column per table. Merging 1a early brings that cost
  forward, and spares porting every change that lands on `develop` meanwhile by hand.
- **The core's size**, of the order of `Bead.Core`'s and its tests, re-cut as turns and
  continuations rather than ported line by line: review leans on the gates — the corpus, the twins,
  clippy denied, the coverage floor.
- **A partial side for a while**: the rows ahead in the matrix and in `AHEAD`, each a promise the
  next steps and stages keep; one that stalls leaves its row standing.
- **Lints denied whole**: a nursery lint added or renamed by a compiler upgrade breaks the build on
  that upgrade's commit, by design; the upgrade reviews them, and one allowed is a line of the table
  with its reason. The nightly's pin, the fuzz build's alone, moves by hand.
- **A measure of its own**: Rust's floor counts regions, the others' branches; the two are not one
  number, and the matrix's row `Rust counts regions where the others count branches` says so.
- **No cancel on drop**, unlike much of Rust's ecosystem: a user who drops a call's future and
  expects a CANCEL gets none; the README and `request`'s doc comment say so.
- **A call within a turn** goes as the turn ends, where the other sides run it at once; what a
  listener hands its router back goes behind every job queued, as on the other sides, so the owner
  posts two ways and each caller names its way.
- **Bead's own JSON stack**, a reader, a writer and a serializer, where most crates take
  `serde_json` whole: the price of RFC 8785, spec 17.5's checks and a NaN refused.
- **Options by assignment**: a line more than a literal, for options that never break a caller.
- **The time driver's check**: one caught panic at a misbuilt router's construction, through the
  application's panic hook, and under `panic = "abort"` an abort there.
- **Types that hold less**: values of `spec/codecs.json`, inputs of `spec/durations.json` and ids no
  `u16` or `u32` holds are excused from Rust, each by its row; no `proto` entry is.
- **The interop service's descriptors written by hand** until beadc's Rust target, held by a test
  against `spec/interop-blueprint.json`, an open row of the matrix.
- **Impossible**: a `!Send` resolver; a router without a tokio runtime and its time driver; a
  duration under zero; a call that waits to be polled before it goes.

**Its gates**: clippy's denied table and `build.warnings`; rustfmt; cargo-deny; `bead-house`'s
parameter rule, comment tags and lints' inheritance; the players of every conformance file the core
reaches and the twins, which `spec/check.py` holds by Rust's row of `SIDES` and its `AHEAD`; the
coverage floor of lines and regions; and CI's `rust` job, on Linux and on Windows.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)):
seventeen objections, each checked against its probe before it was answered, fifteen accepted, two
in part, none refused; the form of a module's documentation was the user's to choose.

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A call written as an `async fn` takes effect when first polled: calls go in await order, a future dropped unpolled sends nothing, and "dropping a call's future cancels nothing, as a promise or a `Task` not awaited does" is false; TypeScript and C# draw ids and send in call order.                                                                                                                                                                                                                                                                                            | **Accepted.** Every operation the other sides start as it is called is a plain `fn` that checks its arguments, posts its job to the owner, which draws the id and sends in call order, and returns a named `#[must_use]` future that only waits; a refusal as it is made is its `Err` at once, as both sides throw it synchronously. "An operation takes effect when it is made; its future only waits". Twins `sends_each_call_in_the_order_it_is_made_whatever_order_it_is_awaited_in` (probed: `[1, 2, 3]`, the third dropped unawaited) and `a_call_s_future_dropped_unpolled_still_sends_its_call`.                                                                                                                                                                                                                                                                            |
| The spike's criteria leave out the runtime descriptors that [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md) requires of Rust and that the gateway and beadc's target build on; criterion 2 says every entry and then excuses two by a library's type, which would write `needs set to no field` as the bytes of `needs set at its defaults`, where both sides refuse it, reopening [0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md). | **Accepted.** Criterion 5: the runtime descriptors the records check and the required walk read, and a dynamic message for the gateway's ProtoJSON, from the codec's library or a facade of Bead's that the spike measures. Criterion 2 passes or fails over every `proto` entry; a written value can leave a required field unset and is refused when it does; Buffa passes only through a write form that tracks presence, else the spike moves on. No entry excuses a library's representation.                                                                                                                                                                                                                                                                                                                                                                                  |
| A unit test beside its module cannot use a separate test crate's clock, that crate depending on `bead` (two copies, `E0277`); `cargo build --workspace` builds `bead` with the feature on; the feature's name fails `redundant_feature_names`.                                                                                                                                                                                                                                                                                                                                      | **Accepted.** The kit is inside the core, as tokio's `test-util`: `#[cfg(any(test, feature = "testing"))] #[doc(hidden)] pub mod testing`, `bead` its own dev-dependency with the feature (probed: one copy, a plain build on the default features). An item of the core that the kit alone reaches carries the kit's `cfg`, or `build.warnings` fails a build without the feature on its dead code; CI builds the default features and documents with all of them. `spec/check.py`'s Rust tests name `src/testing`.                                                                                                                                                                                                                                                                                                                                                                |
| `unreachable_pub` and the nursery's `redundant_pub_crate` refuse every visibility of an item in a private module; the draft passed only because every probed module was public. `missing_const_for_fn` with `avoid-breaking-exported-api = false` pushes `const` onto public functions; `single_use_lifetimes` has known false positives.                                                                                                                                                                                                                                           | **Accepted.** `redundant_pub_crate` and `missing_const_for_fn` allowed at priority 1, each with its reason in the table; `single_use_lifetimes` off; `avoid-breaking-exported-api = false` kept, so the other API-shape lints judge the public surface while `0.y` lets it break. The table was run over a tree shaped like the core and passes whole; every other nursery lint stays denied, one allowed later a line of the table with its reason.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The nightly's branch coverage counts no `match` arm and no `?`, which is how a codec and a router decide, while stable's regions see every way not taken; the nightly leg costs a hand-moved pin and an unstable flag, and its figure is not what cobertura or istanbul count.                                                                                                                                                                                                                                                                                                      | **Accepted.** Lines and regions on the pinned stable, read from `llvm-cov`'s JSON export (probed: its `type`, its version 3.1.0, each file's `summary.lines` and `summary.regions`); `tools/coverage-report.mjs` reads it, told from istanbul's JSON by its `type`; Rust's floor names `lines` and `regions`; a floor on a measure no report measured fails, for every side. The matrix's row reads `Rust counts regions where the others count branches`; the nightly serves the fuzz build alone.                                                                                                                                                                                                                                                                                                                                                                                 |
| The spec's throws (9.0, 13, 15.1) have no Rust form beyond listeners; the core must play "a resolver that throws before it answers is answered PROCEDURE_FAILED, and reported", and the draft never says what a resolver returns to throw, or what its panic becomes.                                                                                                                                                                                                                                                                                                               | **Accepted.** A resolver returns `Result<T, ResolverError>`: `Failure(Failure)` answered as the procedure's own, `Other(Box<dyn Error + Send + Sync>)` answered `PROCEDURE_FAILED` with no detail and reported, the variant named `Other`, since `Error` would repeat its type's word. Admissions, verifiers, key sets and an application's codec take the same shape, or a boxed error where the other sides answer every throw alike. A panic is its site's throw. The row becomes `A panic under panic = "abort"`, every throw site.                                                                                                                                                                                                                                                                                                                                             |
| A resolver's NaN goes through `Value::from`, `json!`, `to_value` and `to_string` as `null` without an error, where `spec/codecs.json` and both sides refuse `not a finite number`; the excuse would hide a miswrite, and the reader's mapping of a number is unsaid.                                                                                                                                                                                                                                                                                                                | **Accepted.** `bead::json::to_value`, a `serde::Serializer` of Bead's own with its own compound serializers, so a nested NaN is refused too, is the resolver's documented road to a value; the harness gives a double through it, so NaN and Infinity are played, five entries excused, not seven. The reader reads a whole number within `i64` or `u64` as an integer, any other as the nearest double, both written back through the double.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A runtime built without `enable_time` passes `Handle::try_current()`, and tokio panics as `SystemClock` arms its first timer, inside a Bead call.                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Accepted**, its first remedy: the builder arms a zero timer once at construction, under the handle's `enter()`, within `catch_unwind`, and what tokio panics there is a `ProgrammerError` ("a router's runtime enables tokio's time driver"), probed on the current runtime, the given handle's path held by a twin of its own as it lands. Its cost stated: one caught panic through the application's hook, and under `panic = "abort"` an abort at that construction, within the panic row. The README names `enable_all` or `enable_time`.                                                                                                                                                                                                                                                                                                                                    |
| A `#[repr(u16)]` enum cannot hold a code none of spec 8.1's names names, which the spec keeps as a number; `TryFrom<u8>` has the wrong width; `LONGEST_TIMER` in milliseconds contradicts the durations' type.                                                                                                                                                                                                                                                                                                                                                                      | **Accepted, and widened**: an open code space is a newtype with associated constants, `ProtocolCode(NonZeroU16)` as `http::StatusCode` (probed), and so is `CredentialScheme(u16)`, since spec 9.2's first step answers a scheme the receiver takes none of `CREDENTIAL_UNSUPPORTED` by its number. Closed enums stay where the spec refuses the unknown: a kind (3.3), a failure's flags (7.2), a `JWT`'s `alg` (13). `Failure::code` is a `NonZeroU16`; `LONGEST_TIMER` a `Duration`.                                                                                                                                                                                                                                                                                                                                                                                             |
| Cargo features `trace` and `metrics` give Rust a Z the others lack, which `CLAUDE.md`'s parity rule forbids, and cost a second build, `required-features` and `cfg` at every site.                                                                                                                                                                                                                                                                                                                                                                                                  | **Accepted.** No such features; Rust builds the trace, the filter and the registry, and its cell of `Debugging left out at build time` reads `not available` as the others'. Leaving debugging out at build time is a decision of its own for every side; [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md) is not revised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `#[non_exhaustive]` options keep public fields assignable from another crate, which is C#'s object initializer; Cargo's SemVer reference makes a public field added to a struct with no private field major, and the attribute added later major too, and advises marking a struct at its introduction.                                                                                                                                                                                                                                                                             | **Accepted.** Every `…Options` is `#[non_exhaustive]` from its first commit, `Default`, public fields, set by assignment over the default; probed, `field_reassign_with_default` does not fire on that form from another crate. One form: no `with_*` setters beside it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `warnings = "deny"` in the lints table breaks the nightly legs on any warning a newer rustc adds; Cargo 1.99.1's `[build] warnings = "deny"` covers rustc, clippy and rustdoc, lives in the folder's config, and is released per leg by `CARGO_BUILD_WARNINGS=warn`. The job caches nothing and has no Windows leg.                                                                                                                                                                                                                                                                 | **Accepted.** `[build] warnings = "deny"` in `implementations/rust/.cargo/config.toml`, the `warnings` level and `RUSTDOCFLAGS` gone; probed, a step's exit is 101 under deny and 0 under `warn`. With coverage on stable, the one nightly step, the fuzz build, sets `CARGO_BUILD_WARNINGS: warn`. The job caches the registry and the target by the lock and the toolchain, and a `windows-2025` leg runs `cargo test --workspace --all-features --locked`, as the builder's job runs on Windows.                                                                                                                                                                                                                                                                                                                                                                                 |
| The owner is mapped onto `SerialScheduler` by name, yet C#'s `Run` takes a `Func<Task<T>>` whose continuations interleave at each await and runs inline when on the scheduler; a call a listener makes within a turn runs inline on the other sides and at the queue's tail in Rust; "the owner's task ends when its last handle drops" is Rust's alone.                                                                                                                                                                                                                            | **In part.** Accepted: both differences are stated, the router is re-cut as turns and continuations rather than ported line by line, and the owner lives until its dispose or its transport's close, the transport holding a handle, as a router lives on the other sides (twin `keeps_its_connection_when_the_application_drops_its_last_handle`). Narrowed: the turns themselves are the other sides' (what C# runs between two awaits is one job), and a call made within a turn does not go to the queue's tail: it runs as that turn ends, before any job queued after it, from a queue of the turn's own, held by `a_call_a_listener_makes_within_a_turn_goes_as_that_turn_ends_before_any_job_queued_after_it`. Inline it cannot run, the turn borrowing the state; should the corpus tell that order from the others', it is a divergence put to the user before 1a merges. |
| Merging 1a, 1b and 1c as one branch, `SIDES` in its last commit, leaves the core invisible to `spec/check.py`'s twins and reads until the end, while every cross-language change on `develop` must be ported to the branch by hand; `AHEAD` already holds parts of a side ahead.                                                                                                                                                                                                                                                                                                    | **Accepted.** 1a merges once it plays, with its row of `SIDES`; `AHEAD` holds `Rust's broker core` (the `parcels` and `parcelRefusals` groups, the broker transport's cases, its units and places) and `Rust's proto codec` (the `proto` entries) as open rows, which 1b and 1c delete as they land; Rust's reads of `spec/vectors.json` name each group, so a group ahead is never credited. The counts after 1a are written, the transports' cases at none of them.                                                                                                                                                                                                                                                                                                                                                                                                               |
| The draft moves the spec to 0.9.1 and every file's `specVersion` on the feature branch; [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) moves the spec's version in the release commit, its minor or patch the maintainer's to say, and history agrees.                                                                                                                                                                                                                                                                                                       | **Accepted.** The branch leaves `specVersion` at 0.9.0; the change is a patch-sized clarification by 0008's rule — `$comment`s, `differs` items and an enum value of a schema, no file, top-level key or property added — for the maintainer to confirm at release, and `tools/release.mjs prepare` moves the version then.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Better Comments builds its pattern from the language's line comment, `//` for Rust, so every `//!` line, Rust's inner doc comment, which the draft requires on every crate and module, renders as the `!` alert; `bead-house` must tell `//!` from `// !`.                                                                                                                                                                                                                                                                                                                          | **In part.** The facts hold, and `bead-house` tells them by rustc's own tokens, a doc comment never being a tag. The form was the user's, two of their own rules meeting here, Rust's newest norms and `CLAUDE.md`'s tags as the extension shows them: (a) no `//!` anywhere, a module's docs as `///` on its `mod` item, a crate's from its README, `bead-house` refusing `//!`; (b) `//!` kept, the language's and std's form, `CLAUDE.md` naming it Rust's one exception. **The user chose (b)**, 2026-10-28.                                                                                                                                                                                                                                                                                                                                                                    |
| The draft's notes on Rust's idioms say `Sync` is "read from several threads at once", too narrow, since a `Mutex<T>` is `Sync` and written through, and credit cargo-deny with answering for `unsafe`, which it never checks; `'static`, `dyn` and Cargo features are missing.                                                                                                                                                                                                                                                                                                      | **Accepted.** `Sync` is "`&T` can be shared between threads", a `Mutex` the example; cargo-deny's four checks named and its silence on `unsafe` said; notes added on `'static`, on `dyn` against generics and on Cargo features, the kit's `testing` the example; the note on `async` rewritten by the first objection's answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
