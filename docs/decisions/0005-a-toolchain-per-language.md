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
  `yarn.lock`, installed `--immutable` in CI; oxlint, its type-aware half on tsgolint, and oxfmt;
  TypeScript for the types; Playwright's runner for the tests, and c8 for their coverage.
- **C#**, in `implementations/dotnet`: `net10.0`; `global.json` pins the SDK and the test runner,
  Microsoft.Testing.Platform; `Directory.Build.props` holds every project to one set of rules
  ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)); `Directory.Packages.props`
  holds one version per package; each project has its `packages.lock.json`, and with `CI=true` a
  restore that would change one fails, as Yarn's immutable install does; `nuget.config` clears every
  source but nuget.org and maps every package to it, so every package comes from where CI takes it,
  whatever the machine's own configuration adds.

**The root has no manifest and no task runner.** It holds what every implementation shares: `spec/`
and its generators, the builder, `builder/`, the examples, `examples/`, `docs/`, `tools/`,
`.githooks/`, the CI, the README, the CHANGELOG, the licence, and the standing instructions for
Claude sessions, `CLAUDE.md` and `.claude/workflows/`; the rest of `.claude/` is each clone's own,
which git ignores. The builder and the examples are placed by
[0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md):
`examples/` holds projects written as a consumer writes one, each language's half under its own
toolchain, the house's rules by reference where its platform can and a copy held to them where it
cannot. The root's tools are Node scripts without dependencies. The spec's are Python 3.14's: its
generators use the standard library alone, and its check, `spec/check.py`, needs `jsonschema`,
which `spec/requirements.in` names and `spec/requirements.txt` locks with every hash, installed
with `--require-hashes --only-binary=:all:`.

**A language that joins comes the same way**: a folder under `implementations/`, its own native
toolchain, and a CI job of its own. A part every language uses that is neither an implementation nor
the spec is placed by a decision of its own, as the builder and the examples are by
[0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md).

## Consequences

- A contributor installs the toolchains of the languages they touch, Node for the root's tools, and
  Python for the spec's. The interop asks for both runtimes
  ([0004](0004-one-behaviour-in-every-language.md)), and so does CI's `dotnet` job.
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
- Coverage is measured by each side's own tool, c8's istanbul report and `dotnet test --coverage`'s
  cobertura, and read by one root script, `tools/coverage-report.mjs`, which merges either; it is a
  local command, not a CI job.
- Three lockfile formats: a `yarn.lock` for the TypeScript side, one for the builder and one for
  each example's TypeScript half, at the TypeScript side's pins and locked versions where they share
  a package, a `packages.lock.json` per C# project, an example's among them, and
  `spec/requirements.txt`, so an upgrade is made side by side, never by one command.
