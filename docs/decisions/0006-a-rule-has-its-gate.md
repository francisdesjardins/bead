# 0006 — A rule has its gate, or it is a preference

- **Status**: accepted
- **Scope**: the repository, and every implementation

## Context

This repository states many rules: about the wire, the conformance files, the interop, each
language's style, the lockfiles, the commits. A rule written in a README and nowhere else survives
exactly as long as the attention of whoever read it last, and two implementations multiply the
places where that attention can lapse.

A gate is not free either. The worst failure a check has is finding nothing and reporting success:
a walk that reads no file, a filter that runs no test, an interop that skips.

## Decision

**Every rule names the thing that fails when it stops being true**, and that thing runs in CI, on
every push and every pull request, under `ci-ok`, which needs every other job and is the one check a
branch requires. The gates today:

| Rule                                                              | Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The conformance files are what their generators write             | `spec`: regenerate, then `git diff --exit-code`, and no file new                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Every implementation reads the wire alike                         | each side's tests over `spec/vectors.json`, `spec/conversations.json`, `spec/transports.json` and `spec/clocks.json`, each played whole, but the cases a row of the matrix excuses                                                                                                                                                                                                                                                                                                                                                                        |
| The conformance files keep their shape, and every side reads them | `spec`: `spec/check.py`, after the regeneration: each file under its schema, the version `spec/spec.md` states, every group of vectors named by a section of the spec and read by each side's tests, every unit an entry cites one of the spec's, `spec/uncited.txt` the units none cites, and an `advance` after a timer armed                                                                                                                                                                                                                           |
| Each side's client speaks to the other's server                   | the interop both ways, in the `dotnet` job, with `BEAD_INTEROP_REQUIRED=1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The TypeScript side's types, lint, format and comments            | `yarn check`: `tsc`, oxlint with `--deny-warnings`, oxfmt, the comment budget, the JSDoc examples                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The C# side's layout, code style, analyzers and doc comments      | `dotnet format --verify-no-changes`, then `dotnet test`, which builds with every warning an error                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Every side takes its time from the clock it is given              | the banned-API analyzer (RS0030) over the C# side's sources; oxlint's `no-restricted-globals` and `no-restricted-properties` over the TypeScript side's; an exception suppressed where it stands, with its reason; both test clocks refuse a timer for less than a millisecond or past the ceiling, and an advance within another; a duration an application gives a side (spec 1.4) goes through one assertion a side, which the twin tables of the same inputs hold, `tests/Shared/Durations.cs` and `durationsOf`, until a conformance file of its own |
| A lockfile changes only on purpose                                | `yarn install --immutable`; `RestoreLockedMode` under `CI=true`; `pip install --require-hashes` over `spec/requirements.txt`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The root's files keep the house format                            | oxfmt `--check` over them, in the `typescript` job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A commit subject is a Conventional Commit                         | `tools/check-commits.mjs`, in the `commits` job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**A gate guards itself against finding nothing.** A floor says what it must have found: the comment
budget fails under 40 blocks in 10 files; Microsoft.Testing.Platform fails a run where no test ran,
with exit code 8, and Playwright one that found no test; `BEAD_INTEROP_REQUIRED=1` turns an interop
that would skip into one that fails. A floor is passed by a wide margin and fails only when code
really went away, which is worth being told.

**A ceiling is a policy, and is chosen as one.** The comment budget's, 50 words to a comment and 120
to an internal JSDoc, is a decision about what a reader's attention is worth, never a snapshot of
what the code weighs today.

**A rule no tool can check is written as a preference**, with who holds it. Review holds these
today: one word, one meaning ([0003](0003-one-word-one-meaning.md)), with the Tenth Man for every
renaming ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)); the C# side's two
parameters and its classes without a base
([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)); git-flow's branch names and
the CHANGELOG's entries; the spec's version, moved by the release that changes the spec, and its
`spec-v` tag ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)); a row of the
support matrix for every difference between languages
([0004](0004-one-behaviour-in-every-language.md)).

## Consequences

**Adding a rule means adding what fails**, or writing it as a preference. A rule that grows a gate
leaves the review's list for the table above.

**A gate that reads the artifact is the kind to prefer**: the conformance files, the regenerated
bytes, the built assemblies with their warnings. A count can be satisfied by editing a number; a
vector cannot.

**Two gates are still owed**: a report of the vectors each side's tests play, where `spec/check.py`
sees the groups they name ([0004](0004-one-behaviour-in-every-language.md)), and a check of the C#
side's parameters, which no analyzer of .NET's recommended set counts.

**The hooks are a copy, not the gate.** `.githooks/` runs checks before each commit once a clone
opts in, with `git config core.hooksPath .githooks`; CI runs them whatever a clone does.
