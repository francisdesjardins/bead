# 0006 — A rule has its gate, or it is a preference

- **Status**: accepted
- **Scope**: the repository, and every implementation

## Context

This repository states many rules: about the wire, the conformance files, the interop, each
language's style, the lockfiles, the commits. A rule written in a README and nowhere else survives
exactly as long as the attention of whoever read it last, and two implementations multiply the
places where that attention can lapse.

A gate is not free either. The worst failure a check has is finding nothing and reporting success: a
walk that reads no file, a filter that runs no test, an interop that skips.

## Decision

**Every rule names the thing that fails when it stops being true**, and that thing runs in CI, on
every push and every pull request, in one of its jobs, under `ci-ok`, which needs every other job so
that one check stands for them all. Branch protection, which makes `ci-ok` the one check a branch
requires, waits on GitHub Pro or a public repository. Each rule, and the job that holds it, whose
comment in [`ci.yml`](../../.github/workflows/ci.yml) says what it runs:

| Rule                                                                                                                | Job                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| The conformance files are what their generators write                                                               | `spec`                                           |
| The conformance files keep their frame ([0004](0004-one-behaviour-in-every-language.md)), and every side reads them | `spec`                                           |
| No configuration holds a published test key                                                                         | `spec`                                           |
| Every implementation reads the wire alike, as the conformance files state it, but what a row of the matrix excuses  | `typescript`, `dotnet`                           |
| Every implementation refuses a declaration off section 16                                                           | `typescript`, `dotnet`                           |
| Every implementation traces, filters and counts alike                                                               | `typescript`, `dotnet`                           |
| Debugging costs nothing while off: it reads no clock                                                                | `typescript`, `dotnet`                           |
| Debugging costs nothing while off: it allocates nothing                                                             | `dotnet`; on the TypeScript side, review (below) |
| Every side takes its time from the clock it is given                                                                | `typescript`, `dotnet`                           |
| A side holds a duration as section 1.4 states, at every place that takes one                                        | `typescript`, `dotnet`                           |
| Each side's client speaks to the other's server                                                                     | `dotnet`, the interop both ways                  |
| The TypeScript side's types, lint, format and comments                                                              | `typescript`                                     |
| The C# side's layout, code style, analyzers and doc comments                                                        | `dotnet`                                         |
| A lockfile changes only on purpose                                                                                  | `spec`, `typescript`, `dotnet`                   |
| The root's files keep the house format                                                                              | `typescript`                                     |
| A commit subject is a Conventional Commit                                                                           | `commits`                                        |
| Every relative link of the repository's Markdown, and its anchor, resolves                                          | `commits`                                        |

**A gate guards itself against finding nothing.** A floor says what it must have found: the comment
budget fails under 40 blocks in 10 files; Microsoft.Testing.Platform fails a run where no test ran,
with exit code 8, and Playwright one that found no test; `BEAD_INTEROP_REQUIRED=1` turns an interop
that would skip into one that fails. A floor is passed by a wide margin and fails only when code
really went away, which is worth being told.

**A ceiling is a policy, and is chosen as one.** The comment budget's, 50 words to a comment and 120
to an internal JSDoc, is a decision about what a reader's attention is worth, never a snapshot of
what the code weighs today.

**A rule no tool can check is written as a preference**, with who holds it. Review holds these: one
word, one meaning ([0003](0003-one-word-one-meaning.md)), with the Tenth Man for every renaming
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)); the parameter rule, its count on
the C# side and on both sides what a third parameter may be, the one optional positional, and an
event's values, with the C# side's classes without a base
([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)); git-flow's branch names and
the CHANGELOG's entries; the spec's version and its companion's, each moved by the release that
changes its document, and their `spec-v` and `debugging-v` tags
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)); a row of the support matrix
for every difference between languages ([0004](0004-one-behaviour-in-every-language.md)); what a
call allocates for debugging on the TypeScript side, which no test reads
([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)); the two house styles kept alike
([0005](0005-a-toolchain-per-language.md)); a comment's tags, as the README's "Contributing" gives
them; and the voice of what the repository says outside the TypeScript sources
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)).

## Consequences

**Adding a rule means adding what fails**, or writing it as a preference. A rule that grows a gate
leaves the review's list for the table above.

**A gate that reads the artifact is the kind to prefer**: the conformance files, the regenerated
bytes, the built assemblies with their warnings. A count can be satisfied by editing a number; a
vector cannot.

**Gates owed**, the one list a gate's landing edits, moving its rule to the table above:

- a report of the vectors and conversations each side's tests play, where `spec/check.py` sees the
  groups and files they name ([0004](0004-one-behaviour-in-every-language.md));
- a check that every file of entries but the vectors, which their groups name, is named by a line
  of its document, and that the line's label is its file's, as the companion's are
  ([0004](0004-one-behaviour-in-every-language.md));
- a check of the C# side's parameters, which no analyzer of .NET's recommended set counts
  ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md));
- the TypeScript side's check of what a third parameter may be, `bead/options-last`;
- `beadc check`, which holds a manifest to section 16 and to the builder's rules, and
  `beadc breaking`, which holds a manifest to the last release's
  ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)).

**The hooks copy one gate and add a clone's own.** `.githooks/commit-msg` holds a subject to
Conventional Commits before git records it, as CI's `commits` job does, and both hooks run the
checks a clone keeps for itself, which CI cannot run. A clone opts in with
`git config core.hooksPath .githooks`.
