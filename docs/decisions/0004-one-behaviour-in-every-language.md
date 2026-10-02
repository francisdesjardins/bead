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

**Each side reads the groups of vectors it names**, so a group neither side reads would pass
unnoticed. A conformance report that fails both sides on a group they do not read is the gate this
decision still owes ([0006](0006-a-rule-has-its-gate.md)).

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
