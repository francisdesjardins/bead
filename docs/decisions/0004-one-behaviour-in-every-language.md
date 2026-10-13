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
implementation does, in the RFC 2119 sense. A unit no entry cites, which `spec/units.txt` lists,
binds every implementation all the same: the entries say what a side does, and the text states what
it must. Beside it, `spec/vectors.json` holds the bytes of envelopes and what they say, and what a
reader refuses with which code; `spec/conversations.json` holds what a server of the interop
service — its API, `spec/interop-blueprint.json`, and its behaviour, relay and credentials,
`spec/interop-service.json` — does with what its clients send, over one connection or several:
the envelopes it answers, what it reports, and the silence it keeps; `spec/transports.json`
holds what a transport's server does at its edge, over HTTP and over a WebSocket: the exchanges and
the messages it takes, and what it gives back; `spec/clocks.json` holds what every side's test clock
does when a case advances it; `spec/durations.json` holds what every place that takes a duration an
application gives a side makes of every input; `spec/identities.json` holds what a router takes, or
refuses, as a procedure is declared to it
([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)); `spec/codecs.json`
holds the bytes every side's codecs write of what they read and of what they are given, in `raw`,
`text`, `json` and `proto` ([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)).
Beside the wire, its companion [`spec/debugging.md`](../../spec/debugging.md) has two files of its
own ([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)): `spec/debug-filters.json`
holds what a debug filter reads as and keeps, and `spec/metrics.json` what a registry writes and
what each exit of a call counts.

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

What turns on a real transport at a destination on a connection of the relay's own — one over HTTP
that does not listen, its outbox past its bound, a WebSocket that closes as leg B goes — plays in
`spec/transports.json`, not on a scripted connection: a scripted refusal would test the router
against its harness.

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

**Each entry cites its units, and a ledger holds every unit.** A unit is a clause of `spec/spec.md`,
`"15.5"`, an item of its numbered list, `"9.2.5"`, or a row of its table counted from 1, `"15.6.8"`;
besides, its front matter is unit `0`, and each section's heading and the lines it holds outside
every clause are its lead, `"15.0"`, so that every line belongs to a unit. Every vector,
conversation and transport case cites the units it checks, the generators writing them, since a
generator knows which check each refusal fails. `spec/check.py` reads the units out of the spec,
refuses a citation to none, and holds `spec/units.txt`. It lists every unit of `spec.md` with one of
two things: cited, or the reason none cites it, from a closed set, each reason held by a rule the
check applies. A `lead` unit introduces its items or rows, each cited or held, and a `defines` unit
defines what the others use: neither carries a key word of BCP 14, and no sentence follows a lead's
list. A `twins` unit is named by its own number, `spec 15.10`, by a test on each side, in its title
or a comment just above its declaration, never by its clause's number; a `builder` unit by a test of
beadc's. An `open` unit is named by its document's status line, and an `owed` one, which nothing
holds yet, is printed on a line of the check's summary. The ledger also keeps the sha256 of each
unit's text after its number, white space folded, a table's rule aside, and the version's number
folded out of unit `0`.

- It fails when the ledger and the files disagree: a unit it lacks or one the document lost, a
  unit cited that it gives a reason, or one it calls cited that no entry cites.
- It fails when a unit's text moved since its hash was written, naming what plays the unit — the
  entries that cite it, its items' or its section's, or the tests that name it — until
  `--write-units` acknowledges that unit by name in the same diff. This is the suspect link of
  requirements traceability (DO-178C §5.5 and §6.5, ISO 26262-8 clauses 6 and 8): one unit's text
  moved leaves its links to be looked at again, and that unit's alone is acknowledged. A
  renumbered unit moves its key alone, which `--write-units` follows.
- The companion's files cite its own units, which `spec/debugging-units.txt` keeps alike.

**Every file of entries keeps one frame.** Each file of `spec/` whose entries a side plays, which
[the README](../../README.md)'s table names:

- is written by its generator in `spec/generators/`, and regenerating it gives the same bytes:
  nothing drawn at random is in it;
- follows its schema in `spec/schemas/`, repeats the version of the document it belongs to, and
  names each entry once within its group;
- cites the units each of its cases checks: every entry that plays a case — a vector, a
  conversation, a transport's case, a place, a name, an id, a fold, a procedure's kind, a payload, a
  value, a filter, a source, an exposition, an exit — and none of the fixtures, inputs and responses
  it plays them with;
- is named, on a line of its own, by a section of its document whose clauses it plays, as section 15
  names `spec/transports.json`, and a group of vectors is named by its name;
- is read by every side's tests from `spec/`: no implementation commits a copy, and a build takes
  the file of `spec/` afresh; an entry one side does not read is one nobody checks;
- is played whole by every side, but what a row of the support matrix excuses: an entry crosses a
  row by its `differs`, which names the row and the language the row excuses, the row naming the
  entry back.

The clock cases cite no unit, and no section names them: they hold every side's test clock to one
meaning of `advance`, which [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)
decides and the spec does not state. Three files of `spec/` hold no entries, are written by hand,
and are read whole: the interop service's API, `spec/interop-blueprint.json`, a blueprint of the
builder's in its one form
([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)),
which the generators read; its behaviour, relay and credentials, `spec/interop-service.json`,
under its schema, which states each of the blueprint's procedures by its name, and which the
conversations and the transports' cases play against; and `spec/codecs.proto`, the message the
codecs' `proto` entries read and write, which section 17 names, every side's tests compile, and the
codecs' generator reads. What else a file holds — its keys, the reasons its outcomes give, the ways
a side takes an input, how a side plays it — is its own record's: the durations' one harness and one
helper are [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s, the codecs'
[0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)'s, the identities'
[0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)'s, the debug filters' and
the metrics' [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s.

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
cost off the wire: the vectors, the conversations, the transports' cases and the clock cases,
which both sides play, written once. CI's `spec` job regenerates them and fails on any byte
that differs, or on any file a generator writes that is not committed.

**What no entry plays stays with each side's twin tests**, and `docs/support.md` says so: a
destination that is a router the relay calls through, with its two legs' limits and the session
every requester presenting none or `OPAQUE` shares behind it (sections 14.3 and 14.7), until the
interop plays a relay across languages, which is open work
([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)), and its leg B refused or
lost there over HTTP (section 14.5, its fourth and fifth rows), whose responses the twins script,
until the transports' file has a client part; HTTP/2 and TLS, which both
servers serve, an open row of the matrix naming both; keep-alive, pipelining and a connection used
again, which one socket per exchange leaves out; and the transport's contract with its router — its
events, its handles, its gauges.

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
advanced, and, later, a client part. A broker's own part is decided with its transport
([0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)), and this file commits it to
nothing.

**`spec/check.py` holds the frame**, in the spec job, and reports group by group which sides' tests
name each file and group, failing on one a side never names. It reads the tests' sources: it sees
what a test names, not the entries it plays, so a report of what each side plays is a gate owed
([0006](0006-a-rule-has-its-gate.md)). The transports' harnesses check, on both sides, that they
played every case but those excused for their language, and so do the codecs' harnesses, and the C#
side's identities', each checking that what it skips is what its language is excused from; the other
harnesses skip what is excused in their loops, and check nothing more.

**The interop needs both runtimes in one place.** In CI, only the `dotnet` job has both: it installs
the TypeScript side for its interop server, runs the C# tests, the C# client's interop among them,
then the TypeScript side's `test:interop`, and its `test:browser`, whose page of another origin
calls both sides' HTTP servers in Chromium. The `typescript` job leaves out the tests of the C#
server.

**A language joins with every vector, conversation and transport case passing, and with interop
against every language already here**: a client of each against a server of each other, N × (N − 1)
pairs, two today and six with a third language.

**No side decides by default.** What one language could add on its own waits for the others, or for
a decision that brings it to all of them; what a platform cannot do at all stays a row of the
matrix, never a silent fork. Where every side keeps to what one platform can do and a standard
allows more, that leveling is a row of the matrix's ["Leveled down"](../support.md#leveled-down),
to lift when the platform can.

**What lands with this revision**, in one change: the spec's sections 14 and 15 naming the files
that check them, section 15's table of the transport's bounds and the forwarded address of section
15.12; `spec/transports.json`, its schema and `make_transports.py`; the conversations across
connections, their shape and their generator; the units every entry cites and `spec/units.txt`;
`spec/check.py`'s units, its ledger, its `differs` and its parts; the interop service's registering of
destinations and its relay's admission; both sides' harnesses, and `hops` named `relays`;
[0006](0006-a-rule-has-its-gate.md)'s table and `docs/support.md`, the file, its counts and the
sentence on a client's behaviour.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md))
in seven rounds. Its objections, each with its answer:

### On the files' schemas, their version and their check

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

### On the transports' conformance

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

### On the frame of every file

| Objection                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A frame stated for every file holds for none: `differs`, `reason` and `ways` each live in a few files, in shapes of their own, and the one harness and one helper hold for the durations alone          | Accepted: the paragraph states only what holds for every file of entries; what else a file holds, the durations' one harness and one helper among it, stays its own record's.                                                                                |
| "Each section it checks names it" is false of `spec.md`: the conversations, the transports' cases, the durations, the identities and the vectors are named by fewer sections than they cite             | Accepted: a file is named by a section of its document whose clauses it plays, which every file keeps; the stronger form holds of the companion alone.                                                                                                       |
| "Excuses an entry only by its `differs`" overrides what a profile and a row of the matrix excuse, and a constrained C side could not conform                                                            | Accepted in part: the bullet takes [0006](0006-a-rule-has-its-gate.md)'s words, played whole but what a row of the matrix excuses, a `differs` being how an entry crosses one. Refused: a clause on a profile's parts, which comes with the C side's record. |
| The rewording drops two limits, that `spec/check.py` sees what a test names and not what it plays, and that the transports' harnesses alone check they played every case; and the C# build reads a copy | Accepted: both limits are stated under **`spec/check.py` holds the frame**, the weaker one as weaker; no implementation commits a copy, and a build takes the file of `spec/` afresh.                                                                        |
| Changing `spec/check.py` in an editorial change reverses the round that kept `spec/` out of it; and the gap is wider, a line's label not tied to its file                                               | Accepted: `spec/check.py` does not change; the check that every file of entries is named by a line of its document, the line's label its file's, joins 0006's gates owed.                                                                                    |
| "Cites, entry by entry" is false beyond the clock cases: the transports' responses, the durations' inputs, the debug filters' fixtures and the identities' ways cite nothing                            | Accepted: every entry that plays a case cites its units, and the fixtures, inputs and responses it plays them with cite none.                                                                                                                                |
| `spec/codecs.proto` is written by hand, under no schema, read by every side's tests, and in neither the frame nor its exceptions; and a list of nine files is one registry more                         | Accepted: it stands beside the interop service as a file written by hand and read whole; the paragraph names the files of entries by the README's table, and lists none.                                                                                     |

### On the text of 0.2.0

The spec's preamble and its companion's, sections 8.3, 9.2, 11.6 and 14.3, and the text of a few
clauses reworded to what both sides do. The user chose where it asked: the text binds, and the
entries say what a side does; 11.6 takes 12.1's subject, played over a procedure that notifies
nothing; and one parser of a loopback host for both sides comes with the transport's security.

| Objection                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Each section names the conformance files that check it" is false for 15 of 17 sections, the form this record's round refused                                                                           | Accepted: the preamble takes this record's form, each file of entries named by a section whose clauses it plays, a group of vectors by its name, each entry citing its units, `spec/uncited.txt` listing those none cites, and the clock cases named as those no section names. The companion keeps the stronger form for its sections 6 to 12, where it holds.       |
| The new MUST narrows the frame: the clock cases fall out, any row of the matrix excuses with no `differs`, and a MUST binds a demonstration rather than behaviour                                       | Accepted: the spec says that a side does what each entry says, the clock cases holding `advance` to one meaning, but an entry whose `differs` names a row and the side's language; that every side plays the files whole stays this record's to say.                                                                                                                  |
| "Binds it all the same, held by its twin tests" claims tests that do not exist: 16.8 holds by nothing, 9.0 is a definition, a third side has none, and the companion's 1.2, 1.3 and 3.5 hold by no test | Accepted: the sentence ends at "binds it all the same"; the companion says that the support matrix names the twin tests that hold what of its sections 1 to 5 a test can.                                                                                                                                                                                             |
| 9.2's new paragraph promises that a requester not admitted learns nothing of a relay's destinations, services or procedures, against 14.3, 0019 and the code                                            | Accepted: a request with no destination is answered `SERVICE_UNKNOWN` or `PROCEDURE_UNKNOWN` before its credential is asked; the paragraph says that such a requester learns of the destinations only what 14.3 says, and names no services or procedures.                                                                                                            |
| "In place of steps 3 to 8", placed before the resolution paragraph, frees a relay from the later turn while the C# side admits a forwarded credential in the same turn                                  | Accepted: the paragraph follows the resolution paragraph and says steps 3 to 7, the credential resolving as that paragraph says, and section 14.2 in place of step 8; 14.3's lead says the same, and both sides take the later turn ([0001](0001-the-envelope-sits-at-fixed-offsets.md), At the wire's edges).                                                        |
| The new `ELSEWHERE` conversation repeats what is played, and the path no entry plays, a relay that verifies presented an `ELSEWHERE`, stays unplayed                                                    | Accepted in part: the conversation of a relay that verifies an `ELSEWHERE` — a verifier that fails, one that does not hold, one that crosses — is added, played on both sides. Refused, the drop of the other: retitled, it is the one entry that reaches 14.3's second step after an `ELSEWHERE` admitted on its scheme.                                             |
| 11.6 keeps "a subscription's result", yet the conversation sends SUBSCRIPTION to a procedure that notifies nothing, and cannot observe "subscribes nothing"                                             | Accepted: 11.6 takes 12.1's subject, the result of a request that opens a subscription, its procedure notifying or not, and the conversation cites it so; the twin tests that hold "subscribes nothing" for a procedure that notifies are named in the matrix's list of what no entry plays.                                                                          |
| The open point, inside 8.2, rides on 8.2's citations, and "not tested" misreads the matrix's legend                                                                                                     | Accepted: the open point is a clause of its own, 8.3, which `spec/uncited.txt` lists; its cells read "not available: no bound".                                                                                                                                                                                                                                       |
| The changelog's sweep misses a line under Changed for a section 0.1.0 never had, and the new lines repeat the defect                                                                                    | Accepted: a line under Changed words a rule 0.1.0 released, every other goes into its Added entry; section 1.4's line moves to the durations' entry, and "in that order" goes until the registry's order is stated.                                                                                                                                                   |
| The change writes totals in five places that every later change must move again                                                                                                                         | Accepted: no total in the changelog, the README's prose or this record; one count stays in `docs/support.md`, moved by each change that adds entries and checked by the release against `spec/check.py`'s report; a check of that table is a gate owed ([0006](0006-a-rule-has-its-gate.md)).                                                                         |
| 17.6's "half the smallest positive double, 5 × 10⁻³²⁴" makes half 2.5 × 10⁻³²⁴, and numbers between 2⁻¹⁰⁷⁵ and it read 0 by the text and the smallest double on both sides                              | Accepted: 17.6 says 2⁻¹⁰⁷⁵ or less, half of 2⁻¹⁰⁷⁴; two entries of `spec/codecs.json` pin both sides of it.                                                                                                                                                                                                                                                           |
| "Each as its parser canonicalizes it" makes conforming a divergence the sides have: `127.0.0.1.` is on the loopback for the TypeScript side, not for the C# side                                        | Accepted: the clause does not land; 13.4 names `[::1]` in a URL alone, and one parser for both sides is a change of behaviour of its own, with its own round.                                                                                                                                                                                                         |
| Judging `localhost` "on the condition that the name resolves to the loopback alone" contradicts "never by what a name resolves to", and no side evaluates it                                            | Accepted: 13.4 says that a side takes such a name on the loopback without resolving it, as Secure Contexts does where the platform resolves it there alone, and that its application gives another host where it does not.                                                                                                                                            |
| 9.7's "a failure on the call id of a subscription the side holds ends it" binds a server, which reports such a failure `CALL_UNKNOWN` and keeps the subscription                                        | Accepted: 9.7 says a failure a client receives on a subscription it holds, as 11.7's second item has it.                                                                                                                                                                                                                                                              |
| "No decision changes" is not so: the conformance contract, the companion's subject, the `ELSEWHERE` the default admission passes, and the page                                                          | Accepted: this record's Decision says that what no entry cites binds all the same, and keeps the round; [0010](0010-a-request-presents-a-credential-of-a-scheme.md) names the `ELSEWHERE` beside the `JWT` and points here; the companion keeps [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s subject, which stays as it is; the page is rebuilt. |
| 13.4's new sentence splits a sentence before its colon; a transfer credits nothing; a listen's count is read once its query is decoded                                                                  | Accepted: the sentence follows the one it continues and names `OPAQUE`; the budget is what a side reserves for its transfers, each opening's and each credit it grants; the count is read once the query is decoded.                                                                                                                                                  |

### On a relay's leg B on a real transport

A relay's destination on a connection of its own plays in `spec/transports.json`: one over HTTP
that does not listen, answered `DESTINATION_UNREACHABLE`; a request past its outbox, and a WebSocket
that closes as leg B goes, each answered `DESTINATION_LOST`. Section 15.9 says that an envelope past
an outbox is one its transport had. A leg B through a router the relay calls over HTTP stays with
the twins.

| Objection                                                                                                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The outbox at a relay is not racy: both sides answer `DESTINATION_LOST` by construction, while the procedure cannot have run; a case would choose between section 14.5's fourth and fifth rows | Accepted in part: the outbox's turn is reported whichever row it takes, and the text, not a case, decides which, by the user's decision: section 15.9 says that an envelope past its outbox is one its transport had, as a notification handed to its transport counts as sent (`debugging.md` section 10.1) and as a transport's send settles on queueing, never on delivery. A send that rejected would answer the fourth row only if the connection closed after the rejection, and would add a report to the outbox's own case. |
| Totals written by several changes at once collide                                                                                                                                              | Accepted: a change names what it adds, the totals stay in `docs/support.md` and the README's table of files, the change that merges last counts them again, and a release checks them against the files; the changelog states none.                                                                                                                                                                                                                                                                                                 |
| A destination over HTTP that does not listen is played over real sockets already, by twins                                                                                                     | Accepted: the case adds its registration on the wire, its exact octets and the citation of section 14.5's fourth row, and carries the twins' detail; the matrix's cell names it beside them, and they stay for what the client hears, which the file does not hold.                                                                                                                                                                                                                                                                 |
| Leaving a leg B through a router called over HTTP to scripted twins widens an exception this record bounded, with no row saying so                                                             | Accepted: the widening is a decision of its own, kept here with its reason — the transports' file plays a server, never the client a relay calls through, until it has a client part — and the record's list of what no entry plays, and the matrix's, are extended, not doubled.                                                                                                                                                                                                                                                   |

### On the fixes of 0.3.0

The order of an HTTP exchange's refusals, stated as both sides play it, a `Content-Length` read as
its number; the TypeScript side's reader of a JSON name that holds an escape; where each stock
`proto` library reads what protobuf refuses, four open rows; and a server's hosts by default and two
WebSocket sockets taken as one, two points open in section 15.13 for the security pass, which
[0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md) and
[0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md) close. Each part's
own text is in [0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md),
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md) and
[0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md).

| Objection                                                                                                                                                                                                                                                                                                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A tag of more than 5 bytes, or past 32 bits, is no `platform` difference: protobuf's Encoding guide gives a tag as a uint32 varint and its conformance suite refuses it in REQUIRED `BadTag_*` tests, which Google.Protobuf fails and protobuf's failure list keeps; the C# side breaks 17.9.1, and the reference reader is a third reading | Accepted: an `open` row, the TypeScript side refusing as 17.9.1 has it and the C# side excused; the reference refuses a tag of more than 5 bytes or past 32 bits, in both its reads of a tag; five entries refused, excused for C#, the suite's three shapes on field 2 among them, and two read or refused by both, a tag of 5 bytes within 32 bits and one of more than 10. The C# pin test holds Google.Protobuf's reading, measured as number 7 on field 2; the C# test that lists what it is excused from takes the TypeScript twin's sentence. [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md) counts the tag among what a library reads against protobuf's rules, not among what Bead states no rule of; nothing to file upstream |
| A fourth point is shared by both sides: a length whose varint sets bits past 32, which protobuf's REQUIRED `BadLength_Varint32BitOverflow` refuses and both libraries read; the three points are not the whole, and the guard is scoped to one side                                                                                         | Accepted, as an `open` row rather than an open point of the spec: 17.9.1 states the rule, and two entries state it in `spec/codecs.json`, each excused for both sides, `differs` a list, so a third language plays them. The guard, or each library's fix, closes each row on the side that needs it, compared with the reference reader; running protobuf's own suite against each side's codec is owed to a later round                                                                                                                                                                                                                                                                                                                                                                |
| 15.13 leaves out three parts of 8.3's shape; "each with its port" refuses every browser at a default port; 15.13.2 writes a handle's form the spec never states, and commits the closing to one mechanism; the two sides do not behave alike at a stop                                                                                      | Accepted: the status line counts three open points; two Features rows "open in this version" name each side's present tests, with a paragraph; 15.13.1 names the hosts as clients' `Host` names them, a port only where a request names one; 15.13.2 states that no two connections a transport holds are one, and the defect, the mechanism left to the security pass, which names both candidates. What each side does with the orphan at a stop goes in its Features row, not in the spec, which names no language                                                                                                                                                                                                                                                                    |
| The sentence for `examples/hello`'s README is false: a loopback server is reachable by a browser on the same machine through DNS rebinding, which the review proved against this example                                                                                                                                                    | Accepted: the README says the example takes every host, that a rebinding page reaches it while it runs, and that a server a browser can reach names its hosts. The example's hosts are not taken into 0.3.0: the security pass's default covers it unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The two sides judge "the connect's own 400" apart: the TypeScript side refuses `Content-Length: 00`, which RFC 9110 §8.6 reads as zero and the C# side draws; the order paragraph misstates three steps                                                                                                                                     | Accepted: the TypeScript side reads the field as its number, a fix on the release branch with a `Fixed` line; 15.4 says what a body is; a generated case draws a connect and holds a listen whose length is `00`, `send()` taking the line as written; 15.6 reads "no type, or another", "is judged by its token" and "a body or its counts", and case 1 gains a connect with no type                                                                                                                                                                                                                                                                                                                                                                                                    |
| The built path's cost is up to three times, not 1.5; the conversation's validity rests on a comment no tool holds, and another test file in the worker can neutralise it; 0016 announces a report the user has not decided                                                                                                                  | In part: "up to about three times" in [0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md), linear and bounded by `maximumBodyBytes`; 0016 states what holds, and announces no report. `make_conversations.py` asserts that no other payload of `spec/*.json` names the shape, and the TypeScript unit test, the proof, draws its name per run. Refused: a check of the TypeScript tests from the spec's tooling, which reads no implementation ([0005](0005-a-toolchain-per-language.md)); and reading a string token by `slice` in 0.3.0, a constant factor no peer can turn into more than linear work, left out of a release branch's fix                                                                                                                            |
| The upstream reports are imprecise: C#'s tag needs none, protobuf's suite misses point 1 only because its case cuts the submessage at the buffer's end, and the length overflow is a report of its own to protobuf-es                                                                                                                       | Accepted: three reports put to the user, none for Google.Protobuf; the protobuf-es report on points 1 and 2 carries bytes after the submessage and proposes a suite case beside `PrematureEofInSubmessageValue`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### On the ledger of units

A ledger of every unit, each cited or held by its reason, with the hash of its text, in place of the
lists of the units no entry cites; and 13.9.4 cited where it is played.

| Objection                                                                                                                                                                                                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `twins` hold ("the matrix names the unit or its clause") fails the first ledger on 15.10 and 12.6.5. It passes units no twin holds, since one mention of a clause excuses all of its items, and `§` is the matrix's notation for RFC sections | Accepted: `twins` holds only when a test of each side names the unit by its own number (`spec 15.10` in its title, or in a comment just above its declaration). Never the unit's clause, and never `§`. `spec/check.py` searches the test trees it already reads for the groups each side plays. A unit named on one side alone fails. Both sides' twins name their units. `builder` holds alike, over beadc's tests                                                                                                                                                      |
| `lead` and `defines` rebuild M7's blind spot: units called `lead` state requirements of their own, and when one moves, the gate names no entry                                                                                                    | Accepted: `lead` and `defines` are held mechanically. A unit with either status carries no BCP 14 key word, and no sentence follows a `lead` unit's list. 4.2, 5.1, 9.6, 12.6 and 17.2 are `cited`, by the entries that play them, the generators adding those citations; 5.2's SHOULD is cited by the header refusals whose detail says which check failed. 14.5's last sentence, which no conversation reaches, is `twins`. When a `lead` unit moves, the failure names the entries that cite its items; when a `defines` unit moves, the entries that cite its section |
| The acknowledgement is a blanket `--write-units`, wired into the workflows, so it is a pipeline step and not a person's. Merges are resolved blind, and large units train the reflex                                                              | Accepted: `--write-units` moves a hash only for the units named on its command line, and prints what plays each. Any other moved unit fails. The implementation workflow passes the units its design names. The release workflow acknowledges none, and hands the list to the user. A merge is resolved by taking each side's lines, and the check judges the result. The large units stay as they are. Splitting 13.8 and 15.2 into items is work of its own                                                                                                             |
| The ledger hashes none of the text that defines conformance itself: the front matter, the key words, the version and status, each section's file line, and the companion's version rule                                                           | Accepted: each document has a unit `0` for its front matter, and each section a unit `N.0` for its heading and the lines it holds outside every clause, both `defines`. The version's number is folded out of `0`'s hash, since `tools/check-versions.mjs` holds it and every release moves it. The text after each unit's number is what is hashed, so a renumber moves the ledger's key alone                                                                                                                                                                           |
