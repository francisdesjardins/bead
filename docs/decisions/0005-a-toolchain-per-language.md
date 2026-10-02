# 0005 — Each language keeps its own toolchain, and the root holds only what all share

- **Status**: accepted
- **Scope**: the repository, and every implementation

## Context

Each language comes with its own build, its own registry, its own lockfile, its own linter and
formatter, and its own test runner, and its contributors know those, not another's. A rule that is a
preference in each project is not a rule, so within one language every file must be judged by the
same configuration.

Two ways were weighed for the repository as a whole. One toolchain over every language, a task
runner and a manifest at the root, bolts each language after the first onto the first one's tools:
a linter and a formatter that read TypeScript and JSON do not read C#, and a root `package.json`
makes Node a prerequisite of a C# change. A polyglot build system above them all puts a tool every
contributor learns between each language and its native commands.

## Decision

**Each implementation lives in `implementations/<language>`, with its own toolchain, lockfile,
linter, formatter and test runner, and runs from its own folder.** Within it, one configuration
judges every file, and a version is held once.

- **TypeScript**, in `implementations/typescript`: Node 24 or later, as `engines` declares; Yarn
  4.18.0, vendored under `.yarn/releases/` and pointed at by `yarnPath`, so every `yarn` there runs
  that file whatever the machine has; one `yarn.lock`, installed `--immutable` in CI; oxlint, its
  type-aware half on tsgolint, and oxfmt; TypeScript 7 for the types; Playwright's runner for the
  tests, and c8 for their coverage.
- **C#**, in `implementations/dotnet`: `global.json` pins the SDK, 10.0.401, and the test runner,
  Microsoft.Testing.Platform; `Directory.Build.props` holds every project to one set of rules
  ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md));
  `Directory.Packages.props` holds one version per package; each project has its
  `packages.lock.json`, and with `CI=true` a restore that would change one fails, as Yarn's
  immutable install does; `nuget.config` clears every source but nuget.org and maps every package to
  it, so every package comes from where CI takes it, whatever the machine's own configuration adds.

**The root has no manifest and no task runner.** It holds what every implementation shares: `spec/`
and its generators, `docs/`, `tools/`, `.githooks/`, the CI, the README, the CHANGELOG, the licence,
and the standing instructions for Claude sessions, `CLAUDE.md` and `.claude/`. The generators use
Python's standard library alone, and the root's tools are Node scripts without dependencies, so
neither has a lockfile to keep.

**A language that joins comes the same way**: a folder under `implementations/`, its own native
toolchain, and a CI job of its own.

## Consequences

- A contributor installs the toolchains of the languages they touch, and Node for the root's tools.
  The interop asks for both runtimes ([0004](0004-one-behaviour-in-every-language.md)), and so does
  CI's `dotnet` job.
- The house style is stated once per language, in that language's own terms: the TypeScript side's
  `curly`, `arrow-body-style` and `max-params` are oxlint rules, and their C# counterparts are
  `.editorconfig` rules the build holds. Keeping the two alike is review's, not a tool's.
- The root's prose and scripts have no formatter of their own: CI holds `README.md`, `CHANGELOG.md`,
  `CLAUDE.md`, `docs/`, `spec/spec.md`, `spec/interop-service.json`, `tools/` and `.github/` to the
  TypeScript side's oxfmt, through `-c implementations/typescript/.oxfmtrc.json`, so formatting them
  needs that side installed. The conformance files are left to their generators.
- Coverage is measured by each side's own tool, c8's istanbul report and `dotnet test --coverage`'s
  cobertura, and read by one root script, `tools/coverage-report.mjs`, which merges either; it is a
  local command, not a CI job.
- Two lockfile formats, ten lockfiles in all today: one `yarn.lock`, and nine `packages.lock.json`.
  An upgrade is made side by side, never by one command.
