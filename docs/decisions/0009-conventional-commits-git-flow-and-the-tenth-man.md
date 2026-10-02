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

**The CHANGELOG follows Keep a Changelog 1.1.0.** There is one, `CHANGELOG.md` at the root, for every
implementation and the spec. Its `[Unreleased]` section is kept current: a change worth telling goes
there, under Keep a Changelog's own headings, in the commit that makes it. A release turns
`[Unreleased]` into its version and its date.

**The reasons are in `docs/decisions/`**, one decision a record, changed rather than appended to
([README](README.md)). What the repository says looks forward: a comment, a README or a record
states what holds now and where the project goes, in the present tense. The CHANGELOG says what
changed, one line a change; a record says why.

**The Tenth Man Rule holds for every change that reaches across the languages**: an addition to or
a change of the protocol, a renaming, and any behaviour the implementations share, down to the order
of a status's values; and for every change to what every language's tests answer to: the spec, its
conformance files, their shape and their tooling, and the gates the implementations share. CI's
mechanics, a shard or a runner's pin, are not among them. When the others agree, one reviewer is bound to disagree, in this repository's workflows
an agent at xhigh effort: it argues that the consensus is wrong. Each of its objections is answered,
accepted or refused with its reason, before the user decides. Not ten opinions: as many as the
change needs, plus the one that dissents. The objections and their answers are kept with the record
or the design the change makes.

## Consequences

- `tools/check-commits.mjs` holds every subject in a push or a pull request to the convention, in
  CI's `commits` job, and `.githooks/commit-msg` holds a commit's subject to it before git records
  it, once a clone opts in. A subject that does not parse fails the run.
- The branches are checked by nothing but review ([0006](0006-a-rule-has-its-gate.md)): CI runs on
  every branch alike, and `ci-ok` is the one check a branch requires.
- A version's entries are only as complete as the commits that wrote them: a change that skips the
  CHANGELOG is missing from the release it ships in.
- The TypeScript side's comment budget refuses a comment in its sources that narrates the past;
  elsewhere, looking forward is held by review.
- A change that reaches across the languages takes one round of dissent more than any other change,
  and the dissent is written down: a decision that survives it is one the next reader need not argue
  again.
