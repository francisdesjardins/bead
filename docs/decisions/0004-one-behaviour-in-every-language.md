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
holds what a server of the interop service, `spec/interop-service.json`, does with what its clients
send, over one connection or several: the envelopes it answers, what it reports, and the silence it
keeps; `spec/transports.json` holds what a transport's server does at its edge, over HTTP and over a
WebSocket: the exchanges and the messages it takes, and what it gives back; `spec/clocks.json` holds
what every side's test clock does when a case advances it; `spec/durations.json` holds what every
place that takes a duration an application gives a side makes of every input;
`spec/identities.json` holds what a router takes, or refuses, as a procedure is declared to it
([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)); `spec/codecs.json`
holds the bytes every side's codecs write of what they read and of what they are given, in `raw`,
`text` and `json` ([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)). Beside
the wire, its
companion [`spec/debugging.md`](../../spec/debugging.md) has two files of its own
([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)): `spec/debug-filters.json` holds
what a debug filter reads as and keeps, and `spec/metrics.json` what a registry writes and what each
exit of a call counts. Every implementation's tests read them from `spec/`, never a copy: an entry
one side does not read is one nobody checks. Nine generators write them,
`spec/generators/make_vectors.py`, `make_conversations.py`, `make_transports.py`, `make_clocks.py`,
`make_durations.py`, `make_debug_filters.py`, `make_metrics.py`, `make_codecs.py` and
`make_identities.py`, and regenerating gives the same
bytes: nothing drawn at random is in them.

**The interop runs both ways, and is required.** Each implementation's interop server offers the
interop service over WebSocket and over HTTP, and each implementation's client calls every other's
server over both: today the C# client against the TypeScript server, and the TypeScript client
against the C# server. Each side finds the other from the directory that holds `spec/spec.md`, and
starts its server. Where the other runtime is missing, the interop is skipped, saying so;
`BEAD_INTEROP_REQUIRED=1` turns the skip into a failure, and CI sets it.

**One vocabulary, its steps named by who acts.** A step is what the test does — `send` an envelope,
an HTTP request or a WebSocket message; `open` a connection, again once it closed; `close` it;
`advance` the clock; wait `until` a gauge says so — or what the implementation under test does next:
`expect` an envelope, a response or a close and its code, and `report` an error with the connection
it came on. Every file speaks it, whatever the bytes' direction: what reads `send` and `expect` in a
case where the implementation is a server reads the same where it is a client. A step names the
connection or the exchange it is on, `on`, wherever an entry has more than one.

**A relay is played as a conversation across connections.** Section 14 is the router's: a relay
takes a request on one connection and asks it on another, which a conversation plays once its steps
name their connections. A destination is registered on the wire, as an application would: the
interop service registers its caller's connection as a destination, under the id and the timeout
given, and unregisters it, so a destination that dies with its connection and one registered anew
are steps, not a harness's setup. A connection may be declared one that carries nothing back, as an
HTTP client that does not listen is (section 15.8), which reaches section 14.3's fourth step. Leg B's
request is then an `expect` on that connection, its flags and the credential it presents given, so a
relay that passes on a destination, or presents on leg B other than what section 14.2's table says,
fails; and every failure an entry expects gives the relays it crossed, 0 where it crossed none. The
interop's relay admits as section 14.3 has a server's relay do by default, a call in leg A's
connection's session or one presenting a credential it forwards, and `interop-service.json` says
so:

```json
{
  "name": "a failure of the destination's crosses one relay more",
  "clauses": ["14.5.2", "14.6"],
  "steps": [
    { "open": "client" },
    { "open": "device" },
    {
      "send": "A1 10 00 03  00 00 00 01  00 01 00 0C | 7B 22 6E 61 6D 65 22 3A 22 61 64 61 22 7D",
      "on": "client"
    },
    {
      "expect": { "kind": 17, "callId": 1, "payload": "22 61 64 61 22", "credential": "OPAQUE" },
      "on": "client"
    },
    {
      "send": "A1 10 00 03  00 00 00 01  00 01 00 0F | 7B 22 64 65 73 74 69 6E 61 74 69 6F 6E 22 3A 31 32 7D",
      "on": "device"
    },
    { "expect": { "kind": 17, "callId": 1, "payload": "31 32" }, "on": "device" },
    { "send": "A1 10 02 04  00 00 00 03  00 01 00 02  00 00 00 0C | 6E 75 6C 6C", "on": "client" },
    {
      "expect": {
        "kind": 16,
        "callId": 2,
        "flags": 0,
        "serviceId": 1,
        "procedureId": 2,
        "payload": "6E 75 6C 6C"
      },
      "on": "device"
    },
    { "send": "A1 12 00 02  00 00 00 02 | 00 07 00 01", "on": "device" },
    {
      "expect": { "kind": 18, "callId": 3, "failure": { "code": 7, "scope": 1, "relays": 1 } },
      "on": "client"
    }
  ]
}
```

What turns on a real transport — a destination over HTTP that does not listen, an outbox past its
bound, a WebSocket that closes as leg B goes — plays in `spec/transports.json`, not on a scripted
connection: a scripted refusal would test the router against its harness.

**The transports' file plays a server in exact octets.** The implementation is the server, the
interop service behind it, and the test is a peer of its own, over sockets of its own. The generator
renders each request to its octets — its request line, its fields in their order and their case, its
body, in pieces when a case holds one back — so both sides' peers write the same bytes, and only a
given or captured value is put in: the server's `{host}`, a connection's `{token}`. A response is
read as the file's `$comment` says: one socket per exchange unless a case says otherwise; its
status; its fields by name, in any case; its body by its length, or de-chunked. Over a WebSocket,
the peer frames RFC 6455 itself where a case needs what a library will not do: a ping left
unanswered, a message in fragments, a frame past the bound. A value drawn at random is captured by
one of the shapes the schema names, each defined once in ASCII classes — `token`, `delay-seconds`,
`http-date` — never by a free pattern. A case sets the bounds it plays by the names section 15 gives
them, in a table as section 12.2 names the router's limits, and the file's `defaults` holds their
defaults, which each side checks against its own; the bound per address is played from one source,
through the address a proxy on the same machine forwards, which section 15.12 states as both sides
take it:

```json
{
  "name": "a request on a call id already waiting is refused 409, marked",
  "clauses": ["15.5.3", "15.6.8"],
  "steps": [
    {
      "send": { "head": "POST /bead HTTP/1.1\r\nhost: {host}\r\ncontent-length: 0\r\n\r\n" },
      "on": "connect"
    },
    {
      "expect": {
        "status": 201,
        "fields": { "bead-connection-token": { "capture": "token", "shape": "token" } }
      },
      "on": "connect"
    },
    {
      "send": {
        "head": "POST /bead HTTP/1.1\r\nhost: {host}\r\nbead-connection-token: {token}\r\ncontent-type: application/prs.bead\r\ncontent-length: 36\r\n\r\n",
        "body": "A1 10 00 03  00 00 00 01  00 01 00 03 | 7B 22 6D 69 6C 6C 69 73 65 63 6F 6E 64 73 22 3A 33 36 30 30 30 30 30 7D"
      },
      "on": "slow"
    },
    { "expect": { "status": 200 }, "on": "slow" },
    {
      "send": {
        "head": "POST /bead HTTP/1.1\r\nhost: {host}\r\nbead-connection-token: {token}\r\ncontent-type: application/prs.bead\r\ncontent-length: 15\r\n\r\n",
        "body": "A1 10 00 03  00 00 00 01  00 01 00 01 | 22 78 22"
      },
      "on": "again"
    },
    { "expect": { "status": 409, "fields": { "bead-refusal": "call-waiting" } }, "on": "again" }
  ]
}
```

**A step over a socket is done when its bytes come, or when a gauge says so.** An `expect` waits for
its bytes within a patience. What sends no byte — a listen held, a call id buried, a request waiting
— is waited on with `until` and one of the gauges both servers name alike: `connections`,
`addresses`, `bodyBytes`, `listens`, `waitingExchanges`, `buriedCallIds`, `outboxEnvelopes`. Silence
is asserted only after an `until`, never after a sleep, and a send whose outcome turns on an earlier
one comes after an `expect` or an `until`. A race a case sets on purpose is one whose outcome is the
same in either order, or whose order an `until` fixes. A gauge is read, and a refusal is never
scripted, because a gauge shows what the wire does not — a listen held sends nothing — where a
scripted refusal stands in for what the wire can show.

**A WebSocket's ping plays on the real clock.** Both sides ping and drop a peer that leaves a ping
unanswered (section 15.3); the C# side's platform times it, which no clock given reaches. A few
cases are marked as played in real time, at a heartbeat of 200 ms: a ping seen within its bounds,
and a peer that never answers dropped within its own.

**Time is a step, on the clock every side is given**
([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)). `advance` steps it from due to
due, and `spec/check.py` refuses one that no `until` a timer armed on it precedes since the last
send, expect or advance; `wall` moves its wall clock alone, which starts where each file says; and
`spec/clocks.json` holds both sides' test clocks to that one meaning.

**Each entry cites its units, and a list holds what none cites.** A unit is a clause of
`spec/spec.md`, `"15.5"`, an item of its numbered list, `"9.2.5"`, or a row of its table counted
from 1, `"15.6.8"`. Every vector, conversation and transport case cites the units it checks, the
generators writing them, since a generator knows which check each refusal fails. `spec/check.py`
reads the units out of the spec, refuses a citation to none, and holds `spec/uncited.txt`, the units
of sections 1 to 15 no entry cites: it fails when that list and the files disagree, a unit newly
uncited or one listed that an entry now cites. The companion's files cite its own units, which
`spec/debugging-uncited.txt` lists alike.

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
can close is work to do, and one only a platform imposes says which platform, and why. A case that
crosses a row says so, `differs`, naming the row and the language it excuses: `spec/check.py`
checks that the row names that case, and each side's harness checks that it played every case but
the ones excused for its language.

**No implementation is the reference: the set evolves together**, wherever it can. Where one
implementation does Y and another can do Y and Z, every implementation does Y: the second keeps to
Y, or comes back to it, and Z comes to all of them at once, by a decision that meets the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). A divergence is put to the user.

## Consequences

**Each behaviour is written and tested once per language.** The conformance files take most of that
cost off the wire: 221 vectors in 10 groups, 150 conversations, 56 transports' cases and 9 clock
cases, which both sides play, written once. CI's `spec` job regenerates them and fails on any byte
that differs, or on any file a generator writes that is not committed.

**What no entry plays stays with each side's twin tests**, and `docs/support.md` says so: a
destination that is a router the relay calls through, with its two legs' limits and the session
every requester presenting none or `OPAQUE` shares behind it (sections 14.3 and 14.7), until the interop
plays a relay across languages; HTTP/2 and TLS, which both servers serve, an
open row of the matrix naming both; keep-alive, pipelining and a connection used again, which one
socket per exchange leaves out; and the transport's contract with its router — its events, its
handles, its gauges.

**Nothing is retired in this change.** A twin test leaves both sides one assertion at a time, in the
change that pairs each of its assertions with the case that plays it, and the cell of the matrix it
proves points to that case in the same change; the twins of a transport's contract stay.

**The client part comes by a decision of its own**, with the outcomes the spec names for a client's
call — a result, a failure and its code, refused, lost, timed out, disconnected — which each side
gives as a property of its error, never as a class.

**Two vocabularies become one, and one word changes.** The conversations' `in` and `out` are written
again as `send` and `expect`, by their generator; the implementations' `hops` becomes `relays` on
both sides, the spec's word for the relays a failure crossed.

**The harnesses play the conformance files without retry**, on both sides: Playwright retries a
failed test twice on CI, which would hide on the TypeScript side what fails the C# side's run.

**The file gives a broker's conformance a vocabulary to start from**: named connections, a clock
advanced, and, later, a client part. A broker's own part is decided with its transport, and this
file commits it to nothing.

**The report of the vectors and conversations each side plays is still owed**
([0006](0006-a-rule-has-its-gate.md)): the transports' harnesses check that they played every case,
and `spec/check.py` sees only what the other files' tests name.

**Every side's tests read every group of vectors, the conversations, and the transports' cases.**
`spec/check.py`, in the spec job, reports group by group which sides' tests read it, and fails on a
group or a file one side's tests never name, so a new group fails until every side reads it. It
reads the tests' sources: it sees the groups a test names, not the vectors it plays. The same check
holds the files' shape: each follows its schema in `spec/schemas/`, repeats the spec's version,
names each entry once within its file, and each group of vectors is named by a section of the spec,
as sections 14 and 15 name the files that check them.

**The interop needs both runtimes in one place.** In CI, only the `dotnet` job has both: it installs
the TypeScript side for its interop server, runs the C# tests, the C# client's interop among them,
then the TypeScript side's `test:interop`. The `typescript` job leaves out the tests of the C#
server.

**A language joins with every vector, conversation and transport case passing, and with interop
against every language already here**: a client of each against a server of each other, N × (N − 1)
pairs, two today and six with a third language.

**No side decides by default.** What one language could add on its own waits for the others, or for
a decision that brings it to all of them; what a platform cannot do at all stays a row of the
matrix, never a silent fork.

**What lands with this revision**, in one change: the spec's sections 14 and 15 naming the files
that check them, section 15's table of the transport's bounds and the forwarded address of section
15.12; `spec/transports.json`, its schema and `make_transports.py`; the conversations across
connections, their shape and their generator; the units every entry cites and `spec/uncited.txt`;
`spec/check.py`'s units, its list, its `differs` and its parts; the interop service's registering of
destinations and its relay's admission; both sides' harnesses, and `hops` named `relays`;
[0006](0006-a-rule-has-its-gate.md)'s table and `docs/support.md`, the file, its counts and the
sentence on a client's behaviour.

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
| Each vector and conversation should cite the clause it checks                                                         | Accepted with the transports' conformance: every entry cites its units, and a list holds the units none cites.                                                                           |
| `specVersion` abbreviates ([0003](0003-one-word-one-meaning.md))                                                      | Refused: it is the spec's own word, as the folder, the `spec` job and the `spec-v` tags have it, and CloudEvents names its own `specversion`.                                            |

The transports' conformance met the Tenth Man too. Its objections, each with its answer:

| Objection                                                                                                                                             | Answer                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 409 example is a race, and nothing says when a step over a socket is done or an `advance` may run                                                 | Accepted: the example waits for the first request's head and asks an hour of `slow`; a step is done when its bytes come or a gauge says so, a dependent send comes after what settles it, and the check refuses an `advance` that no timer armed precedes.                                     |
| The relay example cannot be expected: the schema refuses its relay count, the harnesses disagree, and its client never logs in                        | Accepted: every expected failure gives its relays, 0 on the conversations as they are; `hops` becomes `relays` on both sides; the interop's relay asks for a session, and the example logs in.                                                                                                 |
| An injected clock on every timer of both sides is an architecture decision, made in a paragraph, and the reach it states is false                     | Accepted: the clock is a decision of its own, with its alternatives and every timer it reaches or leaves; no case depends on `advance` until it lands.                                                                                                                                         |
| Destinations registered through the harness and a scripted refusal test the router against each harness, and contradict the typed credential's design | Accepted: destinations are registered on the wire, a connection may carry nothing back, `refuse` is dropped, the rows that turn on a transport play in the transports' file, as the typed credential's design now says.                                                                        |
| A destination that is a router called through leaves 14.3's two legs' limits and 14.7's shared session unplayed                                       | Accepted as found: those stay with the twin tests and the matrix says so. Refused for this change: a relay across languages in the interop, a topology of its own, which comes as a change of its own.                                                                                         |
| The conversations' shape and both harnesses hold one connection, one queue and reports without their connection                                       | Accepted: `on` stands beside a step's action, each connection has its own queue, a report names its connection, and leg B's request gives its flags.                                                                                                                                           |
| A raw HTTP/1.1 peer written once per language is a new source of divergence and cannot express what it was brought for                                | Accepted: the generator renders each request to its octets, the file's comment fixes how a response is read, a shared set of response octets checks each reader, and the WebSocket peer frames RFC 6455 itself where a case needs it; one socket per exchange is named for what it leaves out. |
| The client part has no shared vocabulary and no example                                                                                               | Accepted: it comes by a decision of its own, with the outcomes the spec names for a client's call.                                                                                                                                                                                             |
| A side will skip by name a case that crosses a platform's difference, and naming the file proves nothing                                              | Accepted: a case carries `differs`, the check ties it to its row, and each harness checks that it played every case but those excused.                                                                                                                                                         |
| Retiring the twins a case covers loses what only they assert                                                                                          | Accepted: nothing is retired in this change; an assertion leaves both sides when a case plays it, the matrix's cells move with it, and the transport's contract keeps its twins.                                                                                                               |
| Excluding the WebSocket's ping leaves out a behaviour both sides share                                                                                | Accepted: it plays on the real clock, in a few cases marked so, at a heartbeat of 200 ms.                                                                                                                                                                                                      |
| HTTP/2 and TLS are not one side's: both servers serve them                                                                                            | Accepted: the sentence is corrected, and they are an open row of the matrix naming both servers.                                                                                                                                                                                               |
| Citing a clause of many rules, and a report that never fails, give false coverage; and the vectors' codes do not tie a refusal to its clause          | Accepted: a citation names its finest unit, `spec/uncited.txt` holds what none cites and the check fails when it is wrong, and the vectors cite too.                                                                                                                                           |
| Playwright's retries make a shared case a gate on one side only                                                                                       | Accepted: both sides' harnesses play the conformance files without retry, and the clock's case rests on the waits it removes.                                                                                                                                                                  |
| The bounds a case sets have no names the spec owns                                                                                                    | Accepted: section 15 names them in a table, the file uses those names alone, and its `defaults` are checked by each side.                                                                                                                                                                      |
| A second source address makes a machine's configuration a precondition                                                                                | Accepted: section 15.12 states the forwarded address both sides take, and the bound per address plays through it, from one source.                                                                                                                                                             |
| "The file prepares the broker's transport" claims what it does not hold                                                                               | Accepted: narrowed to a vocabulary to start from, which commits a broker's part to nothing.                                                                                                                                                                                                    |
| Two files would speak two vocabularies                                                                                                                | Accepted: one vocabulary, named by who acts, and the conversations are written again to it.                                                                                                                                                                                                    |
| Values captured by a free pattern match differently in each language                                                                                  | Accepted: the schema names a closed set of shapes, each in ASCII classes.                                                                                                                                                                                                                      |
| The revision leaves 0006's table and the matrix's table of files as they are                                                                          | Accepted: both change in this revision, and the spec's sections 14 and 15 name their files.                                                                                                                                                                                                    |
