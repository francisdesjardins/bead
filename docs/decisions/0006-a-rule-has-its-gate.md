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

| Rule                                                                                                                                                                                                                                                                                                                                                    | Job                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| The conformance files are what their generators write                                                                                                                                                                                                                                                                                                   | `spec`                                           |
| The conformance files keep their frame ([0004](0004-one-behaviour-in-every-language.md)), and every side reads them                                                                                                                                                                                                                                     | `spec`                                           |
| No configuration holds a published test key                                                                                                                                                                                                                                                                                                             | `spec`                                           |
| The interop's blueprint keeps its schema and its form, its arrays in their order, and `interop-service.json` its procedures, by name ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                                                                     | `spec`                                           |
| Every implementation reads the wire alike, as the conformance files state it, but what a row of the matrix excuses                                                                                                                                                                                                                                      | `typescript`, `dotnet`                           |
| Every implementation refuses a declaration off section 16                                                                                                                                                                                                                                                                                               | `typescript`, `dotnet`                           |
| Every implementation traces, filters and counts alike                                                                                                                                                                                                                                                                                                   | `typescript`, `dotnet`                           |
| Debugging costs nothing while off: it reads no clock                                                                                                                                                                                                                                                                                                    | `typescript`, `dotnet`                           |
| Debugging costs nothing while off: it allocates nothing                                                                                                                                                                                                                                                                                                 | `dotnet`; on the TypeScript side, review (below) |
| Every side takes its time from the clock it is given                                                                                                                                                                                                                                                                                                    | `typescript`, `dotnet`                           |
| A side holds a duration as section 1.4 states, at every place that takes one                                                                                                                                                                                                                                                                            | `typescript`, `dotnet`                           |
| Each side's client speaks to the other's server                                                                                                                                                                                                                                                                                                         | `dotnet`, the interop both ways                  |
| The TypeScript side's types, lint, format and comments                                                                                                                                                                                                                                                                                                  | `typescript`                                     |
| A TypeScript function takes at most two parameters, then one options object; an event, at most two values                                                                                                                                                                                                                                               | `typescript`                                     |
| The TypeScript side's interop calls its generated server and client, never a service manager's accessor ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                                                                                                  | `typescript`                                     |
| The C# side's layout, code style, analyzers and doc comments                                                                                                                                                                                                                                                                                            | `dotnet`                                         |
| The C# side's interop calls its generated server and client, never a service manager's accessor, and the builder's C# goldens build under this side's gates ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                                              | `dotnet`                                         |
| `bead/options.proto` and the builder's fixtures keep buf's lint and format, and the options' generated code is what protoc-gen-es writes ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                                                                 | `builder`                                        |
| The builder's tests on Linux and on Windows; its types, lint and format on Linux                                                                                                                                                                                                                                                                        | `builder`                                        |
| The interop's `.proto` gives the interop's blueprint, its projection byte for byte, in either line ending, on Linux and on Windows ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                                                                       | `builder`                                        |
| A blueprint keeps section 16 and the builder's rules, and its form, the interop's by `beadc check` and `beadc blueprint --check` ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md), [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                            | `builder`                                        |
| Each side's interop code is what beadc generates from the interop's blueprint, and the TypeScript target's goldens type-check as a consumer compiles them ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                                                | `builder`                                        |
| protoc's C# messages from buf's set are what protoc writes from the `.proto`, its embedded descriptor aside ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                                                                                              | `builder`                                        |
| beadc's image builds on amd64 and arm64, its test stage passes on the image itself, and each wrapper runs `beadc version`, `beadc generate --check` over the repository and the messages fixture through it ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                              | `builder`                                        |
| The two wrappers make the same engine calls, print the same bytes and exit alike, on Linux and on Windows, by `pwsh -File` and in a session, and each passes its shell's lint at its pin ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                 | `builder`                                        |
| The image's build fails when a package's licence leaves its label ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md))                                                                                                                                                                                        | `builder`                                        |
| A lockfile changes only on purpose                                                                                                                                                                                                                                                                                                                      | `spec`, `typescript`, `dotnet`, `builder`        |
| The root's files keep the house format                                                                                                                                                                                                                                                                                                                  | `typescript`                                     |
| A commit subject is a Conventional Commit                                                                                                                                                                                                                                                                                                               | `commits`                                        |
| Every relative link of the repository's Markdown, and its anchor, resolves                                                                                                                                                                                                                                                                              | `commits`                                        |
| Each version agrees with itself, the C# lock files' project ranges included, and a released section of the CHANGELOG stays as its tag shipped it                                                                                                                                                                                                        | `commits`                                        |
| A release moves each version its changes owe, one step past its last release, at least its minor where a file, a key or a property was added; it dates its CHANGELOG section and links it; each document's tag sits at the first `v*` that gives its version, stated or its own ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)) | `commits`                                        |
| The root's tools do what their tests say                                                                                                                                                                                                                                                                                                                | `commits`                                        |

**A gate guards itself against finding nothing.** A floor says what it must have found: the comment
budget fails under 40 blocks in 10 files; Microsoft.Testing.Platform fails a run where no test ran,
with exit code 8, and Playwright one that found no test; `BEAD_INTEROP_REQUIRED=1` turns an interop
that would skip into one that fails, `BEADC_PROTOC_REQUIRED=1` a builder test that would skip
without protoc, `BEADC_WRAPPERS_REQUIRED=1` a wrapper's test that would skip without bash,
PowerShell 7.6 or, on Windows, the right to make a symbolic link, and `BEADC_IMAGE_REQUIRED=1` one that would skip without beadc's image;
`tools/check-versions.mjs` fails where no `v*` is reached and where a released section of the CHANGELOG has no tag, and a document none of whose files repeats its version. A floor is passed by a wide margin and fails only when code really went away, which is
worth being told.

**A ceiling is a policy, and is chosen as one.** The comment budget's, 50 words to a comment and 120
to an internal JSDoc, is a decision about what a reader's attention is worth, never a snapshot of
what the code weighs today.

**A rule no tool can check is written as a preference**, with who holds it. Review holds these: one
word, one meaning ([0003](0003-one-word-one-meaning.md)), with the Tenth Man for every renaming
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)); the parameter rule on the C#
side, its count, what a third parameter may be and an event's values, and on the TypeScript side
what `bead/options-last` lets pass, a callback aliased under a name ending in `Options` and the
exceptions it lists, the events of three values among them, with the one optional positional on
both sides and the C# side's classes without a base
([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)); git-flow's branch names and
the CHANGELOG's entries; whether a document's move is its minor or its patch, past the floor
`tools/check-versions.mjs` holds
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)); a row of the support matrix
for every difference between languages ([0004](0004-one-behaviour-in-every-language.md)); what a
call allocates for debugging on the TypeScript side, which no test reads
([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)); the two house styles kept alike
([0005](0005-a-toolchain-per-language.md)); a comment's tags, as the README's "Contributing" gives
them; the voice of what the repository says outside the TypeScript sources, and where a change's
round of the Tenth Man is kept ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)).

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
- `beadc breaking`, which holds a blueprint to the last release's
  ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md));
- `examples/hello`'s two builds, its C# messages generated and external
  ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md));
- tests for `tools/check-commits.mjs` and `tools/check-links.mjs`, which the step that runs the
  root's tools' tests, in Node's runner, would hold.

**The hooks copy two gates and add a clone's own.** `.githooks/commit-msg` holds a subject to
Conventional Commits before git records it, as CI's `commits` job does, and `.githooks/pre-commit`
the staged root files to their format, as its `typescript` job does, when the TypeScript side is
installed; both hooks run the checks a clone keeps for itself, which CI cannot run. A clone opts in
with `git config core.hooksPath .githooks`.
