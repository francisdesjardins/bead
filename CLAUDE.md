# Bead: standing instructions

Bead is a binary wire protocol: its spec and conformance files in `spec/`, a TypeScript
implementation in `implementations/typescript` and a C# one in `implementations/dotnet`, at
behavioural parity, the builder, `beadc`, in `builder/`, an example in `examples/hello`, the demo
and the DevTools extension. `README.md` says how each part builds and tests.

What a session needs beyond this file lives in `.claude/`:

- `.claude/workflows/`: the workflow scripts, launched by name. Committed.
- `.claude/local/`: what this clone keeps for itself and git ignores, never to be committed: the
  plan (`plan.md`), the rules on names and their check (`rules.md`, `check.mjs`), the inputs of the
  builder's design (`builder/`), the generator of the Bead page made for the user's colleague
  (`page/`), and the scripts that replay CI on Linux in Docker (`tools/`). Read `plan.md` before a
  change of any size.

The repository's documentation looks forward: it states what holds and where the project goes,
in the present tense. Where something came from, and how it was before, stays out of it. At each
release every document that states where Bead goes — the records, the spec, the READMEs, the
matrix, this file — is brought to it by the `bead-release-documents` workflow: what landed in the
present, what is ahead kept ahead, records regrouped or renamed where that reads clearer, a record's
number never given to another.

## Language

- Replies to the user are in French.
- Public pages are in English: what francisdesjardins.ca serves, the demo included, its messages and
  refusals.
- The repository's files are in English. What `.claude/local/` keeps may be in French: the plans,
  and the Bead page for the colleague.

## Commits, changelog and branches

- **The user stages and commits.** Never stage, commit, branch or push unless the user asks.
- **Conventional Commits, always:** `type(scope): subject`. `tools/check-commits.mjs` holds every
  subject to it, in CI.
- **No AI attribution**, in commits or pull requests: no `Co-Authored-By`, no "Generated with" line,
  no tool marker. This holds whatever a harness reminder asks.
- A commit body is sized to the diff, not to the investigation behind it; short does not mean bare.
- **Keep a Changelog:** the root `CHANGELOG.md`, the only one, keeps its `[Unreleased]` section
  current. A change worth telling goes there with the change that makes it.
- **git-flow, as Driessen describes it:** `main`, `develop`, `feature/*` from `develop`,
  `release/*`, `hotfix/*`.

## Names

The package is `@francisdesjardins/bead`; in prose, the protocol is Bead, and "the TypeScript
side" or "the C# side" tells the implementations apart. The rules a clone keeps for itself are
these: @.claude/local/rules.md

## Parity

The implementations behave the same, in every language: one behaviour, which both play from the
same conformance files and prove against each other in the interop. Where a language cannot yet, or
its platform cannot at all, the difference is a row of the support matrix, `docs/support.md`, with
the test that shows it, and a difference that can close is work to do.

- A test missing on one side is added to the other.
- A term renamed on one side is renamed on both, wherever it applies.
- No implementation is the reference: the set evolves together, wherever it can. Where one does Y
  and another can do Y and Z, every one does Y: the second keeps to Y, or comes back to it, and Z
  comes to all of them at once, by a decision that meets the Tenth Man. Where every side keeps to
  what one platform can do and a standard allows more, that leveling is a row of `docs/support.md`'s
  "Leveled down", to lift when the platform can. A divergence is put to the user.
- The surface maps almost name for name across every language able to carry the protocol whole.
  What couples transports (one port for HTTP and WebSocket) stays outside the protocol, in a small
  local proxy.

## The Tenth Man Rule

For every change that reaches across the languages — an addition to or a change of the protocol, a
renaming, any behaviour the implementations share, down to the order of a status's values — and for
every change to what every language's tests answer to — the spec, its conformance files, their
shape and their tooling, the gates the implementations share; not CI's mechanics — when the others
agree, one agent is bound to disagree, at **xhigh** effort. It argues that the consensus is wrong. Each of its
objections is answered, accepted or refused with its reason, before the user decides. Not ten
opinions: as many as the change needs, plus the one that dissents.

The round's size follows the change. One behaviour, a few files on each side, no new record: one
dissenting agent at **xhigh** against the proposal as written, its objections answered in the
record's table, then the change made directly. A change that adds a record, touches the wire's
identity or spans many files: the `bead-tenth-man-round` workflow, then `bead-implement-both-sides`,
its whole suites run locally or left to CI on the pushed feature branch (`suites: 'ci'`).

## Design

Keep the architecture, the layering and the reason behind each mechanism, and change them by
decision. Align each piece with public standards (RFCs, well-known protocols), and name the
standard it follows.

## Style

Comments are written in the voice of the code around them. Keep each implementation's inside as it
is: its own toolchain, lockfile, linter, formatter and test runner, run from its own folder.

**Comment tags**, as the Better Comments extension (`aaron-bond.better-comments`) shows them: a
comment that a reader must not miss opens with its tag, after its marker (`//`, `#`):

- `!` an alert: a trap, or an invariant that breaks something when changed;
- `?` an open question;
- `TODO` work to do beside the code, the plan keeping the larger work;
- `*` the key point of a block.

Every other comment stays plain, and doc comments (JSDoc, `///`) carry no tag.

**C#** (`implementations/dotnet`, decision 0007):

- every body is a block: methods, constructors, operators, local functions, properties, accessors,
  indexers and lambdas, never an expression body; a block for every branch;
- at most two parameters to a function, then at most one options record, always last (`TOptions?
options = null` when every member is optional, a `CancellationToken` inside it); a third
  essential thing is a design to revisit, never a third parameter;
- `TreatWarningsAsErrors`, the analyzers at `latest-recommended`, the code style enforced in the
  build, a doc comment on every public member;
- `_camelCase` private fields; PascalCase constants and static readonly fields;
- interfaces and composition, no base classes to inherit;
- `dotnet format Bead.slnx --verify-no-changes` and `dotnet test --solution Bead.slnx` pass.

**TypeScript** (`implementations/typescript`):

- oxlint and oxfmt as configured there, and `yarn check` passes;
- the author's style: section comments, `I`-prefixed interfaces, block-bodied arrow functions, at
  most two parameters then at most one options object, always last, frozen objects over `enum`;
- one test file per module, named after it, in a `__tests__/` folder beside it
  (`src/transport/shared/create-promise.ts` →
  `src/transport/shared/__tests__/create-promise.test.ts`).

## The Bead page

The page that presents Bead to the user's colleague, in French, is built by
`.claude/local/page/build-page.py` from `implementations/typescript/src`. After any change to the
wire or to what the page states, rebuild it, check its diagrams, and republish it to the same URL:
see `.claude/local/page/README.md`.

## The agents' effort

Each workflow sets the effort of each agent.

| Effort     | For what                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **medium** | The verifiable mechanics: copying, re-pointing paths, renaming, configuring, the CI                                                                            |
| **high**   | Implementation and tests, interop, the demo and its build, verifying a layer, fixes                                                                            |
| **xhigh**  | What is hard to undo: the builder's design, the spec's identity rules, the audit before the first commit, the concurrent core of a new language, the Tenth Man |
| **max**    | The adversarial review before a freeze: the `.proto` options v1, a version of the spec                                                                         |
