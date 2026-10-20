# Security

## Reporting a vulnerability

Report a vulnerability privately, through GitHub's private vulnerability reporting: the
repository's **Security** tab, **Report a vulnerability**. Do not open a public issue for it.

Say what is affected — the protocol as the spec states it, an implementation, `beadc`, the DevTools
extension or the demo — how to reproduce it, and what it lets a peer do.

## What to expect

Bead is a personal project, kept at its author's pace, with no warranty (see the
[licence](LICENSE)) and no promise of an answer or a fix by any date. A report is read, and a fix,
when one comes, lands on `develop` and in the next release; an earlier release takes none. Nothing
is published to npm, NuGet or a registry before 1.0.0, so a fix reaches a user as a new commit to
build on, pinned.

## What Bead already holds

The bounds a side keeps against a peer that holds it — calls, connections, transfers, the pace of
what waits for a socket, the time a request's head and body take — are stated in the spec's
section 15.12 and decision [0033](docs/decisions/0033-a-side-bounds-what-a-peer-holds-of-it.md);
a refused access is told to its server, never its credential
([0034](docs/decisions/0034-a-server-tells-each-access-it-refuses-never-the-credential.md)). Both
sides' parsers are fuzzed, guided by coverage ([README.md](README.md#fuzzing)). A report that one of
them does not hold is a vulnerability.
