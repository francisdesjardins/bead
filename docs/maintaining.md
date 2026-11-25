# Maintaining Bead

This guide is for a maintainer who keeps the repository by hand: the gates and the order to run
them in, what each workflow of [`.claude/workflows/`](../.claude/workflows/README.md) does and the
procedure that does the same without it, the everyday chores, and the release. The
[README](../README.md) says how each part builds and tests; this guide links it rather than
repeating it. Commands run from the repository's root unless a step names a folder.

## What a maintainer needs

- git, with git-flow's commands (`git flow release start`, `git flow release finish`), and the
  GitHub CLI, `gh`, which `tools/flow.mjs` and the steps below call;
- each part's toolchain, as the README's [TypeScript](../README.md#typescript), [C#](../README.md#c),
  [Rust](../README.md#rust) and [builder](../README.md#the-builder) sections name it;
- a Python virtual environment with `spec/requirements.txt` installed, for `spec/check.py` and the
  generators ([the specification](../README.md#the-specification-and-its-conformance-files));
- Docker, for the brokers' fixtures and the supply chain's scanners;
- the hooks, once per clone: `git config core.hooksPath .githooks`. `pre-commit` holds the staged
  root files to their format, and `commit-msg` holds the subject to Conventional Commits.

## The gates

Each gate is a command that fails. CI runs the jobs a change reaches: on a feature branch and a pull
request into `develop`, those `tools/ci-scope.mjs` maps its changed paths to; on `develop`, `main`,
a release or a hotfix branch and by hand, every job. `ci-ok` stands for all of them
([CI](../README.md#ci), [`ci.yml`](../.github/workflows/ci.yml)).

| Gate                     | Command                                                                                                            | What it refuses                                                                                                                               | CI job                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Commit subjects          | `node tools/check-commits.mjs develop..HEAD`, or `--message <file>`                                                | a subject that is not a Conventional Commit; a message that is not UTF-8 without a byte order mark                                            | `commits`                      |
| Links                    | `node tools/check-links.mjs`                                                                                       | a relative Markdown link to no file or folder git keeps, or to an anchor no heading gives                                                     | `commits`                      |
| Cited tests              | `node tools/check-citations.mjs`                                                                                   | a test `docs/support.md` cites that no side declares; a cell of its differences with no citation and no word of its legend                    | `commits`                      |
| Details                  | `node tools/check-details.mjs`                                                                                     | an exception's message put into a failure's detail at a site not marked and counted as the side's own words                                   | `commits`                      |
| The page                 | `node site/check.mjs`, then `node --test "site/__tests__/*.test.mjs"`                                              | a diagram or an icon that is not its source's render, a page the build no longer gives byte for byte; the deploy's own tests                  | `commits`                      |
| Names                    | `node tools/check-names.mjs`                                                                                       | a public name that differs between sides with no row of `tools/names.tsv`; more names `alone` than the file's pin                             | `commits`                      |
| Durations                | `node tools/check-durations.mjs`                                                                                   | a surface member that takes a duration and has no row of `tools/durations.tsv`                                                                | `commits`                      |
| Twins                    | `node tools/check-twins.mjs`                                                                                       | a TypeScript or C# test with no Rust twin under its title's key and no row of `tools/twins.tsv`; a `pending` row                              | `commits`                      |
| Versions                 | `node tools/check-versions.mjs`                                                                                    | versions that disagree; a released CHANGELOG section changed; on a release branch, a version its changes owe and did not get                  | `commits`                      |
| The root's tools         | `node --test "tools/__tests__/*.test.mjs"`                                                                         | a root tool that fails its own tests                                                                                                          | `commits`                      |
| Supply chain             | the last three steps of the `commits` job in `ci.yml`, a `grep` then two scanners by Docker                        | an action not pinned by its commit's full sha; a known advisory in a lockfile (OSV-Scanner); a Semgrep finding                                | `commits`                      |
| Format                   | `node tools/check-format.mjs`                                                                                      | a root file off the TypeScript side's formatter; it needs `yarn install` in `implementations/typescript`                                      | `commits`                      |
| Conformance files        | the eleven generators, `git diff --exit-code -- spec`, then `python spec/check.py`                                 | a conformance file its generator does not write byte for byte; a unit whose text moved unacknowledged; a count or a schema that does not hold | `spec`                         |
| Generated code           | `node builder/src/cli.ts generate --check`, `node tools/check-validations.mjs`, `node tools/check-transcoding.mjs` | an interop, a validator or a route table that is not what beadc writes; they need `builder/` installed                                        | `builder`                      |
| Rust descriptor set      | `node tools/check-protobuf.mjs`, from `implementations/rust`; `--write` writes it                                  | a `tests.binpb` of `bead-protobuf` that is not what protoc writes at its pin                                                                  | `rust`                         |
| Examples                 | `node tools/check-examples.mjs`                                                                                    | an example's copy of the house that differs from its source                                                                                   | `examples`                     |
| Protobuf conformance     | `node tools/protobuf-conformance.mjs typescript\|csharp\|rust\|differential`                                       | a codec off its failure list or under the runner's floor; two sides that read one corpus apart (Linux or macOS)                               | `protobuf-conformance`         |
| Validators' differential | `node tools/protovalidate-differential.mjs oracle\|typescript\|csharp\|rust`                                       | a side's violations that differ from protovalidate-es's                                                                                       | `protovalidate-differential`   |
| Coverage                 | `node tools/coverage-report.mjs <report> --under <src> --floor <side>`                                             | a side under its floor in `tools/coverage-floors.json` ([Coverage](../README.md#coverage))                                                    | `typescript`, `dotnet`, `rust` |
| Accessibility            | `node site/deploy.mjs --assemble`, then `node tools/check-a11y.mjs --serve site/out …`                             | a WCAG 2.2 AA violation on the page, the privacy policy, the not-found page or the demo ([The page](../README.md#the-page))                   | `typescript`                   |
| The page's layout        | `node layout.mjs`, from `site/`                                                                                    | the top bar, the widths, the targets, the menu or the contents' parts off their layout                                                        | `site`                         |

Each side's own gates and suites are its section of the README: [TypeScript](../README.md#typescript),
[C#](../README.md#c), [Rust](../README.md#rust), [the builder](../README.md#the-builder),
[an example](../README.md#an-example), [interop](../README.md#interop-both-ways). CI's jobs
`typescript`, `dotnet`, `rust`, `interop-rust`, `mqtt`, `amqp`, `builder` and `examples` run them.

### The order before a push

1. `node tools/ci-scope.mjs --local`, which prints the commands of the jobs the branch's changes
   reach, against its merge base with `origin/develop`, the working tree included: the `commits`
   job's checks first, then each job's, each from its folder. `check-citations.mjs` and
   `check-details.mjs` read the files git lists, so a new file counts once it is tracked
   (`git add -N <file>`).
2. Run them in their order; `--gates` leaves out the whole suites, for a branch that leaves them to
   CI.
3. Push, then follow the run (below).

A merge into `develop` and a release run everything: `node tools/ci-scope.mjs --local --all`.

## The workflows, by hand

Each workflow is a script an agent session runs. Its drafts and reports stay out of the
repository's files. A workflow that changes files leaves them in the working tree, unstaged:
staging, committing and every decision stay with the maintainer. Each one has a procedure a person
can follow in its place.

| Workflow                                                  | When                                                                 | What it produces                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`bead-tenth-man-round`](#bead-tenth-man-round)           | a change that reaches across the languages, before it is implemented | a design, its reasons and the Tenth Man's table; the decisions left open          |
| [`bead-implement-every-side`](#bead-implement-every-side) | a settled design, on its feature branch                              | the spec, each side and the integration, every gate run, the commits              |
| [`bead-adversarial-review`](#bead-adversarial-review)     | before a freeze: a release, a version of the spec or a companion     | findings by severity and a verdict; nothing in the repository changes             |
| [`bead-release-documents`](#bead-release-documents)       | on a release branch, after `prepare` and before the finish           | the documents as of the release, one commit                                       |
| [`bead-page-audit`](#bead-page-audit)                     | at each release, and whenever the page may have drifted              | the page's findings in both languages; with `apply`, the fixes and the build      |
| [`bead-onboarding-docs`](#bead-onboarding-docs)           | at each release, after the documents                                 | the guides under [`guides/`](guides/), proven by a project outside the repository |
| [`bead-builder-design`](#bead-builder-design)             | the builder's design                                                 | a design document, its objections answered                                        |

### bead-tenth-man-round

The Tenth Man Rule ([CLAUDE.md](../CLAUDE.md#the-tenth-man-rule),
[0009](decisions/0009-conventional-commits-git-flow-and-the-tenth-man.md)) holds for every change
that reaches across the languages, and for every change to what every language's tests answer to:
the spec, its conformance files, their tooling and the shared gates. When the others agree, one
reviewer is bound to disagree.

The workflow drafts the change, has one dissenter argue against it, and revises it with each
objection answered. It writes a design, a shared part then one section per stage (`spec`,
`typescript`, `csharp`, `rust`), and its reasons with the table of objections. A small round,
one behaviour with a few files on each side and no new record, has no separate draft: the proposal
is written whole once.

By hand:

1. Write the proposal: what each side does today, by file and line, and where they differ; the
   standards in play, each named with its section; the change, as the spec's text, the conformance
   cases by file, name and unit, each side's change, the twin tests by name, the records, the rows
   of `docs/support.md` and the CHANGELOG's line.
2. Give it to a second person, who argues in writing that it is wrong: a standard misread, a peer
   or a deployment it breaks, what a platform does not allow, where the sides would still differ, a
   name, an order, a cost left out, a simpler design passed over. Each objection states its claim,
   its evidence and its remedy.
3. Answer each objection, after checking its claim: accepted, and the design changes; accepted in
   part; or refused, with its reason.
4. Write the table, Objection and Answer, under the record's `## The Tenth Man`. Decision 0009
   says which record keeps it; [Writing one](decisions/README.md#writing-one) says how a record is
   written.
5. Decide. What a standard or a decision already taken settles is settled; the rest is the
   maintainer's choice.

### bead-implement-every-side

The workflow implements a settled design in stages: the spec and its conformance first, then the
sides together, then an integration that runs every gate and the interop once over the settled
tree, and builds the commits.

By hand, on the design's feature branch:

1. The spec: its text, the generators (a generated file is never edited by hand), the ledgers by
   `python spec/check.py --write-units <unit…>` for each unit whose text the design moves, a new
   unit given its status, the record with its round, the rows of `docs/support.md`, the
   CHANGELOG's `[Unreleased]` and the README's counts. Then `python spec/check.py`, the format,
   the links and the versions.
2. Each side, in its own folder, with its tests. A test on one side has its twin on the others,
   named by the same sentence: `Underscored_sentence` in C#, `snake_case_sentence` in Rust. Run
   the tests of what changes while working, then the side's checks and its whole suite.
3. The integration: the generators again, with nothing more moving; every command
   `node tools/ci-scope.mjs --local` prints, in the order above, each side's coverage held to its
   floor and the brokers' suites among them; the interop both ways.
4. The commits, each a slice with a Conventional Commit subject, each one building and passing the
   fast gates. A feature branch may also leave the whole suites to CI: push it and follow its run.

### bead-adversarial-review

Before a freeze, the workflow reviews the scope it is given through several lenses: the spec read
as a standard; the wire and the calls; sessions, relays and transports; the conformance files and
the tests that play them; the companion `spec/debugging.md`. A second reader verifies each finding,
and one synthesis gives a verdict and the findings by severity. It changes nothing in the
repository.

By hand:

1. For each lens, one reviewer looks for what is wrong, missing or inconsistent, says what was
   looked at and found sound, and gives each finding its evidence (file and line, or a probe run and
   its output), a severity and a remedy. A blocker stops the version; a major ships only fixed or
   declared, as a row of the matrix or an open point; a minor is the rest.
2. A second reader puts each finding to the code and gives it a verdict, confirmed, in part or
   refuted, and its own severity. It reruns the proof of a blocker and a major, and of a minor only
   where reading cannot settle it. What does not reproduce is refuted.
3. One synthesis merges the duplicates, states whether the version can ship and under what
   conditions, and lists the work by severity.

### bead-release-documents

On a release branch, after `node tools/release.mjs prepare`, which lists it among what it owes by
hand, every document that states what holds and where Bead goes is brought to the release: the
records and their index, the spec and its companions, `docs/support.md`, the READMEs, `CLAUDE.md`
and the workflows' README. The CHANGELOG's released sections and what a generator writes stay as
they are.

By hand:

1. Find the documents in scope: those whose files changed since the last `v*` tag, those that cite
   a record, a section or a file that changed, and those that still state as ahead what the
   release's CHANGELOG section lists (search for `ahead`, `yet`, `until`, `will`, `planned`).
2. Rewrite each sentence that moves: what the release carries is stated as what holds, what only
   history explains leaves, and what is still ahead stays ahead, said plainly. Hold each changed
   sentence to the code.
3. The spec and its companions move in form alone. A change of a requirement's meaning, a MUST, a
   value, an order or a unit's scope, is not made here: it needs its own Tenth Man round.
4. Records may be merged, split or renamed where that reads clearer. A number names its decision
   for good: no record is renumbered, and a merged record keeps a short file that names its
   successor. Move every citation of a moved record, then update the index, its "Where Bead goes"
   and "The next decision is" line.
5. Add one CHANGELOG line under the release's Changed, run the gates, and commit
   `docs: the documents as of X.Y.Z`.
6. Hold the page to the release, as the next workflow does, with its fixes applied.

### bead-page-audit

The workflow holds every claim of the page beadproto.dev serves to the repository, in English and
in French, section by section, and with `apply` writes the fixes and rebuilds the page.

By hand:

1. For each `<section id>` of `site/src/content.en.html` and `site/src/content.fr.html` (the same
   ids in both), with `site/src/data.mjs`, `site/src/snippets/` and the diagrams' sources, check
   each claim against the repository: the spec, the conformance files, `docs/support.md`, the
   records, the READMEs, the CHANGELOG and the code. A `{{fact of="…"}}` placeholder holds by
   construction; the words around it do not.
2. Note each finding with its lines in both files, what holds and where, and its kind: false,
   stale, misleading, missing, the French apart from the English, a typo, or prose that is not
   plain. A second reader confirms or refutes each.
3. Write each fix in both languages, render the diagrams whose source moved, rebuild and check
   the page, and look at it in both themes, on a desktop and a phone
   ([The page, rebuilt and deployed](#the-page-rebuilt-and-deployed)).

### bead-onboarding-docs

The workflow writes or refreshes the guides under [`guides/`](guides/) for teams that adopt Bead
outside its repository.

By hand:

1. Gather the facts the guides state, each with its file and line: the builder's README,
   `examples/hello`, the goldens, the implementations' READMEs and `docs/support.md`.
2. From those facts alone, build the guides' scenario as a team would, in a folder outside the
   repository, and run it: a valid and an invalid request, the command's round trip, the paced
   subscription. Correct each fact the run disproves.
3. Write the guides from that project, its snippets copied from its files, and say plainly what is
   not published.
4. Hold each claim and snippet to the facts and the project, then run the links, the format and,
   where a guide cites a test, the citations.

### bead-builder-design

The workflow designed `beadc`: three angles (the front end on descriptors, the intermediate model
and its conformance, the developer's experience), one synthesis, a Tenth Man, and a design document
with every objection answered, the decisions left open and what is out of scope. The document is
kept outside the repository; its round of objections lives in
[0022](decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md).
A redesign of the builder by hand is a full Tenth Man round, with three drafts in place of one.

## Everyday chores

### A feature branch

A change starts on a `feature/*` branch from `develop`, its commits Conventional Commits, its
CHANGELOG line under `[Unreleased]` in the commit that makes it:

```sh
git flow feature start <name>          # feature/<name>, from develop
git push -u origin feature/<name>
```

### A CI run, followed by its id

```sh
gh run list --workflow ci.yml --branch feature/<name> --limit 1
gh run watch <id> --exit-status
gh run view <id> --log-failed
```

Read each run to its end. A failure that may be a flake is run again against the same tree with
`gh workflow run ci.yml --ref <branch>`, and a failure that comes back is investigated. A run that
was cancelled is run again with `gh run rerun <id>`. A new Semgrep rule that fails an unchanged
commit is a finding.

### A feature branch, finished

`tools/flow.mjs` finishes a feature branch once CI has passed on its head
([Finishing a feature](../README.md#finishing-a-feature)):

```sh
node tools/flow.mjs finish feature/<name> --dry-run
node tools/flow.mjs finish feature/<name>
```

It runs from a clone on `develop`, or the clone `--repo` names, never from inside the worktree it
would remove. It checks that the branch is on `origin` and not yet merged, that `develop` is clean
and at `origin/develop`, that the local branch holds nothing `origin`'s lacks, that a worktree with
the branch checked out is clean, unlocked and not the main one, and that a run of `ci.yml` passed
for the branch's head on `origin`, waiting for one still going. It then merges that head into `develop` with `--no-ff`,
pushes `develop`, and waits for CI's run of the merge. On that run's success it deletes the branch
on `origin`, its worktree (the `node_modules` folders first) and the local branch; on a failure it
names the failed jobs and deletes nothing. It never pushes `main` or a tag, and refuses a
`release/*` or `hotfix/*` branch. `--dry-run` fetches, makes every check and says what it would do.

When the merge conflicts, the tool stops and leaves the merge as git leaves it. Abort it with
`git merge --abort`, merge `develop` into the feature branch, resolve the conflict there, push, and
run the finish again once CI passes. A merge resolved and committed on `develop` instead is
finished by hand: push `develop`, follow its run, then delete the branch on `origin`, its worktree
and the local branch.

### A twin owed

`tools/check-twins.mjs` fails on a TypeScript or C# test with no Rust twin under its title's key.
Add the Rust twin under the same sentence, or record why there is none:

```sh
node tools/check-twins.mjs --write
```

`--write` adds a `pending` row to `tools/twins.tsv` for each new test and drops each row whose test
is now twinned. A `pending` row fails until it is classified: replace `pending` with `retitled` (a
twin under another sentence), `held` (a twin the key does not reach), `ahead` (a row of
`docs/support.md`) or `native` (the platform's or the tool's own), and its `-` with the reason that
names the twin, the row or the platform.

### A unit of the spec, acknowledged

`spec/check.py` keeps the sha256 of every unit's text in `spec/units.txt`,
`spec/debugging-units.txt` and `spec/transcoding-units.txt`, and fails when a text moves. Once the
change to a unit is meant, and what plays it still holds, acknowledge it by name:

```sh
python spec/check.py --write-units 15.7 debugging:4.2 transcoding:5.2
```

It writes the hashes of the units named and of no other, follows a renumbered unit, and prints what
plays each. A new unit gets the status `?`, which fails until its author replaces it with `cited`
or a reason the ledger's header lists. A change of a unit's meaning is a Tenth Man change.

### A row of a table

Three other tables are kept by hand beside their gates. `tools/names.tsv` places each public name
the sides spell apart (`node tools/check-names.mjs`); `tools/durations.tsv` places each surface
member that takes a duration (`node tools/check-durations.mjs`); `tools/a11y-exceptions.json` holds
each accessibility exception, its rule, its selector and its reason. Each tool's header gives its
row's form.

### A dependency update

Dependabot ([`dependabot.yml`](../.github/dependabot.yml)) opens grouped pull requests against
`develop` every week, and CI judges each one. Each release waits out its first days, three for a
patch, a week for a minor and two weeks for a major; security updates are not held, and each Yarn
project's `npmMinimalAgeGate` refuses at install a version younger than three days. A few pins move
by hand, each named in `dependabot.yml` with its reason: beadc's image digests, the `typescript`
alias of an example's TypeScript half, Google.Protobuf and protobuf's Python library with the
conformance runner and protoc's pin, the Rust toolchain and a .NET major. An update lands as any change does: on a `feature/deps-…` branch, a `build(deps): …` commit
each, judged by CI on the pushed branch, then finished by `tools/flow.mjs`.

### The page, rebuilt and deployed

After a change to the wire or to what the page states, change both languages alike, then, from
`site/` ([The page](../README.md#the-page)):

```sh
yarn install --immutable
node render.mjs --chromium <chrome> --fonts src/fonts   # the diagrams whose source moved
node icons.mjs --chromium <chrome>                      # only when the mark moved
node build.mjs
node check.mjs
node layout.mjs --chromium <chrome>
```

Look at the page in both themes, on a desktop and a phone, and commit `site/dist/` with its
sources. The deploy ships a commit that is on `origin`, from a clean tree, by the maintainer's own
login:

```sh
yarn wrangler login                 # once
node deploy.mjs --assemble          # out/ alone, a trial
node deploy.mjs
node ../tools/check-a11y.mjs https://beadproto.dev/ "https://beadproto.dev/?lng=fr" https://beadproto.dev/playground/
```

## The release

A release moves every version in one commit, on a `release/*` branch (or a `hotfix/*` branch from
`main`), and CI judges that commit before any tag exists ([Releasing](../README.md#releasing)).
While the product's major is 0, a release that breaks what a consumer calls, reads or builds moves
its minor, and a release of fixes alone its patch. A document whose files changed moves `minor`
when an implementation must change to keep passing, `patch` otherwise, and `minor` at least when a
file, a key or a property was added
([0008](decisions/0008-three-version-axes-and-names-qualified-by-their-owner.md)).

1. **Review.** Before a freeze, an adversarial review of the release, by hand or by its workflow
   ([bead-adversarial-review](#bead-adversarial-review)): a blocker stops the version.
2. **Start.** From `develop`: `git flow release start X.Y.Z`.
3. **The digests.** Move by hand, each to its tag's current digest, the Dockerfile frontend's and
   the Node base's (`NODE_DIGEST`) in `builder/Dockerfile`, and shellcheck's image in `ci.yml`.
4. **Prepare.**

   ```sh
   node tools/release.mjs prepare [--spec <move>] [--debugging <move>] [--transcoding <move>] --python .venv/bin/python --dry-run
   node tools/release.mjs prepare [--spec <move>] [--debugging <move>] [--transcoding <move>] --python .venv/bin/python
   ```

   It moves every version, the product's and each changed document's, a document's move given as
   `patch`, `minor`, `major`, `same` or `x.y.z`, from its last release, as the rule above asks; moves each C# project's
   `PublicAPI.Unshipped.txt` into its `PublicAPI.Shipped.txt`; runs the generators and the page's
   build; dates and links the CHANGELOG's section; runs `spec/check.py` and the format check; and
   prints each line it owes by hand.

5. **Publish.** `git add -A && git commit -m "chore(release): X.Y.Z"`, then
   `git flow release publish X.Y.Z`. CI and the benches run on the branch.
6. **What prepare owes by hand**, each on the release branch:
   - the CHANGELOG's line under the release on each document's new version and tag;
   - each gate of [0006](decisions/0006-a-rule-has-its-gate.md)'s "Gates owed" that names the
     release, its rule moved to that record's table;
   - the documents brought to the release ([bead-release-documents](#bead-release-documents)), then
     the page ([bead-page-audit](#bead-page-audit)) and the guides
     ([bead-onboarding-docs](#bead-onboarding-docs));
   - the run of `bench.yml` on the branch, read ([the benches](#the-benches-compared));
   - the last run of `fuzz.yml`, its findings read, each a case of its side's tests:
     `gh run list --workflow fuzz.yml --limit 1`.

   A coverage floor may rise at a release, by `tools/coverage-report.mjs --raise <side>`. A fix on
   the branch tells its line under `[X.Y.Z]`.

7. **Before the finish.** Run `prepare` again, without a document's move: it re-dates, regenerates
   and checks. Commit `chore(release): X.Y.Z, dated` if it changed something, and wait for `ci-ok`
   on the branch.
8. **The finish, on the maintainer's word.** `git flow release finish --keepremote X.Y.Z`, without
   `-p`: it merges into `main`, tags `vX.Y.Z` and merges back into `develop`; `origin`'s branch
   goes with the push.
9. **The tags.** `node tools/release.mjs tag` tags each document whose version no tag names yet,
   runs the gate as `main`'s run will, takes out of `ci.yml` each `beadc breaking` waiver the
   release makes moot and prints the commit that keeps that. If it reports an entry the back-merge
   filed under the released version, move it back under `[Unreleased]` in a commit on `develop`.
10. **The push, on the maintainer's word.** The one line `tag` prints:
    `git push --atomic origin main develop vX.Y.Z <document tags> :release/X.Y.Z`. Then follow the
    runs of `main` and `develop`.
11. **The image.** The tag starts `image.yml`, which builds beadc's image from the tag's commit,
    publishes it under the release's version, attested and signed, verifies it by the builder's
    README's block and prints its digest
    ([0055](decisions/0055-beadcs-image-is-published-at-each-release-under-its-version-attested-and-signed.md)):
    `gh run list --workflow image.yml --limit 1`. GitHub starts no run when more than three tags are
    pushed at once; then dispatch it on the tag, `gh workflow run image.yml --ref vX.Y.Z`. A run
    that failed once its index was pushed, at the attestation, the signature or the verification,
    takes `gh run rerun <run> --failed`: a new dispatch refuses the version the registry holds.

A hotfix starts from `main` with `git flow hotfix start X.Y.Z` and follows the same steps;
`prepare` also takes every `beadc breaking` waiver out of `ci.yml`, each moot since the release
`main` holds.

### The benches, compared

`bench.yml` measures each side on every push to a release or hotfix branch, against the newest
`v*` tag, and compares the two at 25% ([Measurement](../README.md#measurement)):

```sh
gh run list --workflow bench.yml --branch release/X.Y.Z --limit 1
```

Each side's comparison is in the run's summary, and its two reports and the comparison in the
artifact `bench-<side>`. A regression shows as a warning on a green run; a refused comparison or a
failed measure fails the job. A `regression` or `inconclusive` is read once and judged, then
explained in the release's notes or fixed, never chased by a rerun. Run by hand, from the GitHub
Actions page, `bench.yml` also takes a `baseline`, the `sides` and a `filter`; the README gives the
same comparison on one machine with `tools/bench-release.mjs` and `tools/bench-compare.mjs`.
