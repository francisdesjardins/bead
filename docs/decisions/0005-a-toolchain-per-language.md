# 0005 — Each language keeps its own toolchain, and the root holds only what all share

- **Status**: accepted
- **Scope**: the repository, and every implementation

## Context

Each language comes with its own build, its own registry, its own lockfile, its own linter and
formatter, and its own test runner, and its contributors know those, not another's. A rule that is a
preference in each project is not a rule, so within one language every file must be judged by the
same configuration.

Two ways were weighed for the repository as a whole. One toolchain over every language, a task
runner and a manifest at the root, bolts each language after the first onto the first one's tools: a
linter and a formatter that read TypeScript and JSON do not read C#, and a root `package.json` makes
Node a prerequisite of a C# change. A polyglot build system above them all puts a tool every
contributor learns between each language and its native commands.

## Decision

**Each implementation lives in `implementations/<language>`, with its own toolchain, lockfile,
linter, formatter and test runner, and runs from its own folder.** Within it, one configuration
judges every file, and a version is held once.

- **TypeScript**, in `implementations/typescript`: Node 24.9 or later, as `engines` declares, and CI
  runs it on the current line and on that floor, 24.9; Yarn, vendored under `.yarn/releases/`
  and pointed at by `yarnPath`, so every `yarn` there runs that file whatever the machine has; one
  `yarn.lock`, installed `--immutable` in CI; `enableScripts: false` in `.yarnrc.yml`, so no
  dependency runs a script as it installs but those `package.json` names in `dependenciesMeta`,
  buf's and esbuild's, each checking its platform's binary and fetching it when the package that
  carries it was not installed; oxlint, its type-aware half on tsgolint, and oxfmt; TypeScript for
  the types; Playwright's runner for the tests, and c8 for their coverage. An install script is code
  of a dependency's author, run on every machine and every runner that installs, so every Yarn
  project of the repository sets the same line, the builder's naming buf's alone, an example's
  TypeScript half buf's and esbuild's, and each fuzz project's, the TypeScript side's and the
  builder's under their `tools/fuzz/`, none; no tool fails when the line goes, so review holds it
  ([0006](0006-a-rule-has-its-gate.md)).
- **C#**, in `implementations/dotnet`: `net10.0`; `global.json` pins the SDK and the test runner,
  Microsoft.Testing.Platform; `Directory.Build.props` holds every project to one set of rules
  ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)); `Directory.Packages.props`
  holds one version per package; each project has its `packages.lock.json`, and with `CI=true` a
  restore that would change one fails, as Yarn's immutable install does; `nuget.config` clears every
  source but nuget.org and maps every package to it, so every package comes from where CI takes it,
  whatever the machine's own configuration adds.
- **Rust**, in `implementations/rust`: Rust 1.99.1 and edition 2024, as `rust-toolchain.toml` pins
  them with clippy, rustfmt and llvm-tools, the toolchain's own components, and `rust-version` the
  floor at the pin; a virtual workspace of crates, one `Cargo.lock`, every build `--locked`; clippy
  and rustc's lints in the workspace's `[lints]` table, every crate inheriting it, and Cargo's own
  `[build] warnings = "deny"` in the folder's `.cargo/config.toml`, so a warning of rustc, clippy
  or rustdoc is an error, locally as in CI; rustfmt; cargo-deny for advisories, licences, bans and
  sources; Cargo's own test runner; and coverage of lines and regions, from LLVM's JSON export on
  the pinned stable ([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)).

**The root has no manifest and no task runner.** It holds what every implementation shares: `spec/`
and its generators, the builder, `builder/`, the examples, `examples/`, `docs/`, `tools/`,
`.githooks/`, the CI, the README, the CHANGELOG, the licence, and the standing instructions for
Claude sessions, `CLAUDE.md` and `.claude/workflows/`; the rest of `.claude/` is each clone's own,
which git ignores. The builder and the examples are placed by
[0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md):
`examples/` holds projects written as a consumer writes one, each language's half under its own
toolchain, the house's rules by reference where its platform can and a copy held to them where it
cannot. The root's tools are Node scripts without dependencies; one that needs a program fetches it
by a pin and checks it before it runs it, as `tools/protobuf-conformance.mjs` fetches protobuf's
conformance runner by `tools/protobuf-conformance/runner.json`, its sha512,
`tools/protovalidate-differential.mjs` protovalidate-es and what it loads by
`tools/protovalidate-differential/pin.json`, each package's sha512, `tools/fuzz.mjs` the C# side's
fuzzer by `tools/fuzz/fuzzer.json`, its SHA-256, and `builder/tools/fetch-protoc.mjs` protoc by
`builder/protoc.json`, its sha256, into a folder git ignores, with no manifest and no lockfile
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).
The spec's are Python 3.14's: its check, `spec/check.py`, needs `jsonschema`, and two of its
generators a library each, `make_validations.py` `google-re2`, RE2 itself, and
`make_transcoding.py` `protobuf`, protobuf's own Python library; `spec/requirements.in` names the
three and `spec/requirements.txt` locks them with every hash, installed with
`--require-hashes --only-binary=:all:`; the other generators use the standard library alone.

**Each language after Rust comes the same way**: a folder under `implementations/`, its own
native toolchain, and a CI job of its own, as Rust's is held to clippy's pedantic, nursery and cargo
groups denied and to the newest Rust norms ([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)). A part every
language uses that is neither an implementation nor the spec is placed by a decision of its own, as
the builder and the examples are by
[0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md).

## Consequences

- A contributor installs the toolchains of the languages they touch, Node for the root's tools, and
  Python for the spec's. The interop asks for both runtimes
  ([0004](0004-one-behaviour-in-every-language.md)), and so do CI's `dotnet`, `mqtt` and `amqp`
  jobs.
- The house style is stated once per language, in that language's own terms: the TypeScript side's
  `curly` and `arrow-body-style` are oxlint rules whose C# counterparts are `.editorconfig` rules
  the build holds; the parameter rule is `max-params` and `bead/options-last` on one side and
  review's on the other ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)).
  Keeping the two alike is review's, not a tool's.
- The root's prose and scripts have no formatter of their own: CI holds the root's prose, scripts
  and schemas, and the spec's text, to the TypeScript side's oxfmt, through
  `-c implementations/typescript/.oxfmtrc.json` (`tools/check-format.mjs` lists them, for CI and the
  pre-commit hook), so formatting them needs that side installed. The conformance files are left
  to their generators, and the interop's blueprint to `spec/check.py`, which holds its form
  ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
- Coverage is measured by each side's own tool, c8's istanbul report, `dotnet test --coverage`'s
  cobertura and `cargo llvm-cov`'s LLVM JSON export, and read by one root script,
  `tools/coverage-report.mjs`, which merges the first two by line and reads the third's summary of
  lines and regions, an LLVM export told from istanbul's JSON by its `type`. CI's `typescript`,
  `dotnet` and `rust` jobs run it after their tests, each side held to its floor, which names its
  measures, and a floor on a measure no report measured fails ([0006](0006-a-rule-has-its-gate.md));
  a clone runs the same commands.
- Four lockfile formats: a `yarn.lock` for the TypeScript side, one for the builder, one for each
  example's TypeScript half and one for each fuzz project, at the TypeScript side's pins and locked
  versions where they share a package, a `packages.lock.json` per C# project, an example's among
  them, a `Cargo.lock` for the Rust workspace and one for its fuzz project, and
  `spec/requirements.txt`, so an upgrade is made side by side, never by one command.
