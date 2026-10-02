# 0004 — Every language plays one behaviour, held by the conformance files and the interop

- **Status**: accepted
- **Scope**: every implementation, and the specification

## Context

Bead is a protocol before it is a package. It has a TypeScript implementation and a C# one, a third
language is planned, and a builder will generate servers and clients in each from the same
definitions. Two implementations of the same bytes drift unless something holds them to those bytes,
and only a test both run does.

Three ways were weighed. One core shared by every language, compiled once and bound in each, holds
the behaviour by construction, but costs each platform its idioms and its debugging, and makes every
language wait on one toolchain. One implementation taken as the reference, the others reading its
code, makes its bugs the spec. Copies of the conformance files kept by each implementation drift as
copies do.

## Decision

**The conformance files are the contract.** [`spec/spec.md`](../../spec/spec.md) states what every
implementation does, in the RFC 2119 sense. Beside it, `spec/vectors.json` holds the bytes of
envelopes and what they say, and what a reader refuses with which code; `spec/conversations.json`
holds what a server of the interop service, `spec/interop-service.json`, does with what a client
sends: the envelopes it answers, what it reports, and the silence it keeps. Every implementation's
tests read them from `spec/`, never a copy: a vector or a conversation one side does not read is one
nobody checks. Two generators write them, `spec/generators/make_vectors.py` and
`make_conversations.py`, and regenerating gives the same bytes.

**The interop runs both ways, and is required.** Each implementation's interop server offers the
interop service over WebSocket and over HTTP, and each implementation's client calls every other's
server over both: today the C# client against the TypeScript server, and the TypeScript client
against the C# server. Each side finds the other from the directory that holds `spec/spec.md`, and
starts its server. Where the other runtime is missing, the interop is skipped, saying so;
`BEAD_INTEROP_REQUIRED=1` turns the skip into a failure, and CI sets it.

**The surface is one too.** A name on one side is the same name on every other, in its language's
case, and any language that can carry the protocol whole mirrors the surface almost name for name;
each language's own mapping of terms is its implementation's record, as
[0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md) is the C# side's. A test missing
on one side is added to the other, and a term renamed on one side is renamed on every side where it
applies. What couples transports stays outside the protocol: one public port for WebSocket and HTTP
comes from a small local proxy in front, as the demo's `demo/relay.ts` is, never from a server the
transports share, so no transport needs another's server in any language.

**A difference between languages is a row of the support matrix**, `docs/support.md`, with the test
that shows it, and it stays a row until it closes. Normalising is always the aim: a difference that
can close is work to do, and one only a platform imposes says which platform, and why.

**No implementation is the reference: the set evolves together**, wherever it can. Where one
implementation does Y and another can do Y and Z, every implementation does Y: the second keeps to
Y, or comes back to it, and Z comes to all of them at once, by a decision that meets the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). A divergence is put to the user.

## Consequences

**Each behaviour is written and tested once per language.** The conformance files take most of that
cost off the wire: 123 vectors in 9 groups and 72 conversations, which both sides play, written once.
CI's `spec` job regenerates them and fails on any byte that differs, or on any file a generator
writes that is not committed.

**Relays and transports have neither vector nor conversation yet** (spec, sections 14 and 15): a
conversation plays one connection, and a relay needs a destination behind it. Each implementation's
own tests check them, and parity there rests on the rule that a test on one side has its twin on
the other.

**Every side's tests read every group of vectors, and the conversations.** `spec/check.py`, in the
spec job, reports group by group which sides' tests read it, and fails on a group one side's tests
never name, so a new group fails until every side reads it. It reads the tests' sources: it sees
the groups a test names, not the vectors it plays, and a report of the vectors each side plays is
still owed ([0006](0006-a-rule-has-its-gate.md)). The same check holds the files' shape: each
follows its schema in `spec/schemas/`, repeats the spec's version, and each group of vectors is
named by a section of the spec.

**The interop needs both runtimes in one place.** In CI, only the `dotnet` job has both: it installs
the TypeScript side for its interop server, runs the C# tests, the C# client's interop among them,
then the TypeScript side's `test:interop`. The `typescript` job leaves out the tests of the C#
server.

**A language joins with every vector and conversation passing, and with interop against every
language already here**: a client of each against a server of each other, N × (N − 1) pairs, two
today and six with a third language.

**No side decides by default.** What one language could add on its own waits for the others, or for
a decision that brings it to all of them; what a platform cannot do at all stays a row of the
matrix, never a silent fork.

## The Tenth Man

The conformance files' schemas, their version and their check met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). Its objections, each with its
answer:

| Objection                                                                                                             | Answer                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A list of groups each side keeps by hand is a count, which an edit satisfies with no test reading the group           | Accepted: no side keeps a list; `spec/check.py` reads each side's tests for the groups they name. A report of the vectors each side plays is owed ([0006](0006-a-rule-has-its-gate.md)). |
| The check needs `jsonschema`, against 0005's root without dependencies, and nothing verifies what the registry serves | Accepted: [0005](0005-a-toolchain-per-language.md) says so, and `spec/requirements.txt` locks it with every hash, installed with `--require-hashes --only-binary=:all:`.                 |
| A conformance file the check does not know of goes unchecked                                                          | Accepted: every `spec/*.json` needs its schema, and every schema its file.                                                                                                               |
| "Every refusal" lets a refusal group pass with no section naming it                                                   | Accepted: a section names each group in full; "every refusal" gathers them, and counts for none.                                                                                         |
| A malformed file makes the check fail on an error of its own, hiding the schema's                                     | Accepted: it reports what the schemas found, and stops there.                                                                                                                            |
| The spec's version is a rule with no gate and no policy                                                               | Accepted: [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) says when it moves, and review holds it ([0006](0006-a-rule-has-its-gate.md)).                           |
| An envelope's payload and failure are not tied to its kind, and a key may come twice                                  | Accepted: the schema ties them, and the check refuses a key given twice (RFC 7493).                                                                                                      |
| A validator from the TypeScript side's lockfile, rather than Python                                                   | Refused: the spec's tools stay apart from any implementation's install, as its generators do, and the hashes give Python's lock what Yarn's has.                                         |
| Each vector and conversation should cite the clause it checks                                                         | Refused for now: a group cites its sections, and a clause on each of the 195 entries changes the files' shape; it is weighed with the transports' conformance.                           |
| `specVersion` abbreviates ([0003](0003-one-word-one-meaning.md))                                                      | Refused: it is the spec's own word, as the folder, the `spec` job and the `spec-v` tags have it, and CloudEvents names its own `specversion`.                                            |
