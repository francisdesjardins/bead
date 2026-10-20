# 0009 — The repository follows Conventional Commits, git-flow and Keep a Changelog, and what the languages share meets the Tenth Man

- **Status**: accepted
- **Scope**: the repository

## Context

A protocol with several implementations is changed by more hands than any one of them, and read by
people who were not there. Its history has to say what changed without being read in full, its
releases have to come from somewhere known, and its reasons have to survive the people who held
them. Each of these has a public convention already; inventing one costs every newcomer a lesson.

The changes that cost the most to undo are the ones nobody argues with: a change to the wire that
every peer must then speak, and a name that travels into every language. A review that agrees by
default finds what is wrong with a change only when someone happens to disagree.

## Decision

### The repository's history

**Every commit subject is a Conventional Commit**, `type(scope)!: description`, the scope and the
`!` optional, with the types of the Angular convention that Conventional Commits 1.0.0 names as its
example: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`,
`test`. Merges keep git's own subject. A commit's body is sized to its diff, not to the
investigation behind it.

**Branches follow git-flow, as Vincent Driessen describes it**: `main` holds what was released,
`develop` what comes next; a `feature/*` branch starts from `develop` and ends in it; a `release/*`
branch prepares a version from `develop` and ends in both, its tag on `main`; a `hotfix/*` branch
starts from `main` and ends in both. git-flow's `finish` writes the merges, and tags a version `v*`
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).

**The CHANGELOG follows Keep a Changelog 1.1.0.** There is one, `CHANGELOG.md` at the root, for
every implementation and the spec. Its `[Unreleased]` section is kept current: a change worth
telling goes there, under Keep a Changelog's own headings, in the commit that makes it. A release
turns `[Unreleased]` into its version and its date. Once a `release/*` or `hotfix/*` branch has
dated its version, a change made on it tells its line under that version, which ships it.

**The reasons are in `docs/decisions/`**, one decision a record, changed rather than appended to
([README](README.md)). What the repository says looks forward: a comment, a README or a record
states what holds now and where the project goes, in the present tense. A part the repository does
not hold is bound by constraint, in the present, and named in the decisions' [README](README.md),
under "Where Bead goes". The CHANGELOG says what changed, one line a change; a record says why.

### The Tenth Man

**The Tenth Man Rule holds for every change that reaches across the languages**: an addition to or a
change of the protocol, a renaming, and any behaviour the implementations share, down to the order
of a status's values; and for every change to what every language's tests answer to: the spec, its
conformance files, their shape and their tooling, and the gates the implementations share. CI's
mechanics, a shard or a runner's pin, are not among them. When the others agree, one reviewer is
bound to disagree, in this repository's workflows an agent at xhigh effort: it argues that the
consensus is wrong. Each of its objections is answered, accepted or refused with its reason, before
the user decides. Not ten opinions: as many as the change needs, plus the one that dissents.

**The round's size follows the change**, so that a round costs what its change needs and each suite
runs once. One behaviour, a few files on each side and no new record: one dissenting agent at
xhigh against the proposal as written, its objections answered in the record's table, then the
change made directly. A change that adds a record, touches the wire's identity or spans many files:
the `bead-tenth-man-round` workflow, then `bead-implement-both-sides`
([the workflows](../../.claude/workflows/README.md)), its whole suites run locally or left to CI on
the pushed feature branch (`suites: 'ci'`).

**The objections and their answers are kept in the repository, in a record**, under its
`## The Tenth Man`: the record the change writes; or the one whose decision it changes, which gains
the round; or, for a change of the spec, its files or their gates that changes no decision, the
record whose Scope holds what it changes. A change that changes several records keeps its round in
the first it names, and the others point to it. A change that moves, trims or re-voices a record and
keeps every decision is no change this rule holds, and keeps no round. A design's objections enter
the repository with its record, and a decision the repository holds keeps no round in a file git
does not keep.

## Consequences

- `tools/check-commits.mjs` holds every subject in a push or a pull request to the convention, in
  CI's `commits` job, and `.githooks/commit-msg` holds a commit's subject to it before git records
  it, once a clone opts in. A subject that does not parse fails the run.
- The branches are checked by nothing but review ([0006](0006-a-rule-has-its-gate.md)): CI runs on
  every branch alike, and `ci-ok` stands for every job. Branch protection, which makes it the one
  check a branch requires, waits on GitHub Pro or a public repository.
- A version's entries are only as complete as the commits that wrote them: a change that skips the
  CHANGELOG is missing from the release it ships in.
- The TypeScript side's comment budget refuses a comment in its sources that narrates the past;
  elsewhere, looking forward is held by review.
- A change that reaches across the languages takes one round of dissent more than any other change,
  and the dissent is written down: a decision that survives it is one the next reader need not argue
  again.
- A reader finds a decision's rounds in its record, or through its record's pointer to the record
  that holds a round several share. A record without `## The Tenth Man` meets one at the next change
  of its decision.

## The Tenth Man

This record's sentence on a release branch's lines met the Tenth Man with the release's gate, in
[0008](0008-three-version-axes-and-names-qualified-by-their-owner.md).

How a record is kept and voiced met the Tenth Man twice: when the records were realigned, and when
this record said where a round lives. Its objections, each with the answer that holds:

### On the records' realignment

| Objection                                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The realignment's own rule puts it under the Tenth Man                            | Accepted in part: each step that changes a decision meets the Tenth Man of its own, and a record without the section meets it at the next change of its decision. Refused: a step that only moves, trims or re-voices a record, keeping every decision, takes no round.                                                                                                                                           |
| Dropping "yet" and "until" deletes where Bead goes                                | Accepted: open work is stated as open, in the present, and an edit never turns it into a refusal.                                                                                                                                                                                                                                                                                                                 |
| "To come" is "yet" with another word                                              | Accepted in part: a sentence that binds a part the repository does not hold is the constraint on whatever will hold it, in the present; a gate that does not run is among [0006](0006-a-rule-has-its-gate.md)'s gates owed; and the decisions' README names, under "Where Bead goes", the parts the records bind before the repository holds them. Refused: that a part not built cannot be named in the present. |
| One option for the Tenth Man's sections cannot keep rounds that answer each other | Accepted: rounds stay in their order, each under a plain heading; a row a later row replaced is dropped, and the later row kept in its words; a round that is the reason a choice does not come back stays whole.                                                                                                                                                                                                 |
| Splitting this record is weighed by links that break anyway                       | Accepted: every link to this record names its file, and a released tag ships it, so it is neither split nor renamed; it holds two sub-headings, and the sentence that binds a part the repository does not hold.                                                                                                                                                                                                  |

### On where the objections live

| Objection                                                                                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "With the record or the design" leaves rounds in files git does not keep: the parameter rule's and the realignment's have no other home, so the rule is false the day it lands | Accepted: the parameter rule's round is [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)'s; the realignment's rows that settle a decision go with that decision's round, its editorial rest keeping none; and the builder's design keeps its round in its record, [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md). |
| The builder's design workflow writes its round to a file of the repository that is no record                                                                                   | Accepted: it writes the design beside the builder's inputs, which the repository does not keep, and its round enters the repository with the builder's record.                                                                                                                                                                                                                    |
| No home for the round of a change that writes no record and changes none, and none for one that changes several                                                                | Accepted: the record whose Scope holds what the change changes takes the first; the first record a change names takes the second, the others pointing to it.                                                                                                                                                                                                                      |
| The rule is one no tool checks, and joins neither [0006](0006-a-rule-has-its-gate.md)'s list of what review holds nor its gates owed                                           | Accepted: review holds where a round is kept, and [0006](0006-a-rule-has-its-gate.md)'s list says so. No gate is owed: a round is prose, and no tool reads its home.                                                                                                                                                                                                              |
