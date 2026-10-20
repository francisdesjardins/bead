# Bead: debugging

What a side of Bead traces, filters and counts beside the wire, stated once. The key words "MUST",
"MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED",
"NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
[BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)]
[[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all
capitals, as shown here.

This document is the companion of [`spec.md`](spec.md), which states the wire: what it states never
goes on the wire. Sections 6 to 12 each name the conformance file that checks them; sections 1 to 5
name none: the support matrix, [`docs/support.md`](../docs/support.md), names the twin tests that
hold what of them a test can. The why of each rule is in the decisions:

- [0013](../docs/decisions/0013-every-language-debugs-alike-at-no-cost-when-off.md): the whole of it;
- [0016](../docs/decisions/0016-a-json-payload-has-one-form-whichever-side-writes-it.md): the
  payloads it writes (4.3, 10.1);
- [0017](../docs/decisions/0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md): the
  names it reads (1.2, 6.10, 7.3, 8.3).

**Version: 0.3.0**. Each of its conformance files repeats it as its `debuggingVersion`, and follows
its schema in [`schemas/`](schemas/). It moves by `spec.md`'s rule, under a version of its own
([0008](../docs/decisions/0008-three-version-axes-and-names-qualified-by-their-owner.md)): the minor
when an implementation that conforms to its last version must change to conform to this one, the
patch when one that conforms passes unchanged. **Status: every section is written.**

## 1. Conformance

1.1. A side that carries the protocol whole, built with neither of section 3.5's switches, MUST
trace its calls and its envelopes, filter both, and count its calls and its notifications, as this
document states.

1.2. A constrained profile MAY leave out, at build time, the trace and the filter, or the metrics,
or both, as section 3.5's switches do. It conforms to `spec.md` either way, its wire by sections 1
to 15, what it declares by section 16 and its codecs by section 17, and to this document for what it
builds: what it leaves out is a row of the support matrix, not a difference of the protocol. A side
built without the metrics plays `spec/debug-filters.json` alone, one built without the trace
`spec/metrics.json` alone.

1.3. This document names the wire's kinds and codes as `spec.md` states them, its kinds by section
3.1 and its codes by section 8. A code that `spec.md` section 8 gains adds a value to `code`
(section 8.4 of this document), and moves the minor of both documents.

## 2. Beside the wire

2.1. Debugging is a side's own. Nothing a side traces, filters or counts goes on the wire, and a
peer never knows whether it listens.

2.2. A listener's error never changes a call. An error a listener throws, the trace's or the one a
filter wraps, MUST be reported, as section 9.0 of `spec.md` reports an error: through its router's
error event, with the call's connection on a server, through which its service manager reports its
own. A listener is synchronous: what it returns is not awaited, and an error it raises once it
returned is its platform's, outside this guard. The call goes on as if nobody listened: its outcome,
its answer and what goes on the wire are the same.

2.3. A side calls each listener within a guard, and counts on a path no listener runs on.

## 3. The cost when off

3.1. While nobody listens and no registry is given, a call MUST read no clock and allocate nothing
for debugging: no step, no copy of its options or its payloads, no redacted header. One check a call,
and one an envelope, is the whole cost. What a call allocates for itself may hold an empty reference
the trace or the registry fills, the hook through which its call id is heard among them.

3.2. A side that traces reads, at a call's start, the wall clock for `startedAt` and the monotonic
clock for `duration`, and the monotonic clock at its end.

3.3. A side that counts reads the monotonic clock twice a call, at its router's gates (section 9),
and never the wall clock. It adds to series it reaches through what it holds already, with no lookup
of its own and no allocation: a call made, through the series it carries; a call answered, through
the resolver its request is routed to; a notification, through the subscription it goes under.

3.4. A side holds 3.1 to 3.3 by gates of its own
([0006](../docs/decisions/0006-a-rule-has-its-gate.md)), twin on every side. Its test clock counts
its readings: over a service manager on a fake router, a call made, a request answered, a
notification sent and one heard read none while nobody listens, and a call three with a listener;
on a router, a counted call reads two more than an uncounted one. Where its platform counts what a
thread allocates, a counted call's synchronous steps allocate not a byte more than an uncounted
one's, and what a call allocates while nobody listens is pinned; where it does not, the side holds
that part by inspection, a row of the support matrix.

3.5. A side whose platform builds that way has two build switches: one leaves out the trace and the
filter, the other the registry, each alone or both. Built with the registry and without the trace, a
side pays two monotonic readings and a few increments a counted call, and nothing more; built with
neither, it pays nothing. A side that builds both pays the check alone while nobody listens and no
registry is given.

## 4. The trace of calls

4.1. A service manager tells each step of a call to whoever listens, with the same fields on every
side, each in its platform's case:

| Field                          | What it holds                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `direction`                    | `tx` for a step out, `rx` for a step in                                                                                         |
| `type`                         | `request`, `command` or `notification`                                                                                          |
| `procedureId`, `procedureName` | its procedure                                                                                                                   |
| `serviceId`, `serviceRevision` | its procedure's service                                                                                                         |
| `startedAt`                    | the call's start, on the wall clock; a notification's, as it is sent or heard                                                   |
| `duration`                     | whole milliseconds of the monotonic clock, a fraction dropped, once the call answered; none before, and none for a notification |
| `options`                      | the call's options, its defaults applied, its credential left out                                                               |
| `rx`, `tx`                     | what came in and what went out, decoded                                                                                         |
| the error, beside the step     | what the step failed with; a failure by its code, its scope and its detail                                                      |
| `callId`, `connectionHandle`   | its call, as its envelopes name it (5.1): its call id, and its connection, `server` on a client; none where 4.2 names none      |

A step's `rx` and `tx` may be the call's own values, not copies of them: a listener MUST NOT change
them, since its call may still read what it changed.

4.2. The steps it tells, and the call each names:

| Step                                                                                               | Direction | Its call                                                    |
| -------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------- |
| a call made                                                                                        | `tx`      | its own, once its router drew its id; none if refused first |
| its answer, or its failure                                                                         | `rx`      | the call made's                                             |
| a request received, once admitted and decoded                                                      | `rx`      | its request's                                               |
| the answer it sends, its failure to go at that start, or its resolver's failure before it answered | `tx`      | its request's                                               |
| a notification sent, and its failure to go at that start                                           | `tx`      | none: it goes to each subscription under that one's id      |
| a notification heard, or its failure to decode                                                     | `rx`      | none: its subscription's call names it                      |

A `tx` step with an error says that its `tx` did not go out, and why: a notification that could not
go; an answer its router could not send, past its limit say, told again at its start with what its
router refused it with; an answer to a request its router already answered in its resolver's place,
as its subscription's queue went past its bounds (`spec.md` 11.10), told once, as its resolver
answers, with the failure its router answered it with; or none, from a resolver that failed before
it answered, with what it failed with. A request whose answer did not go is answered
`PROCEDURE_FAILED` in its place (`spec.md` 9.5, 12.1), unless its router answered it first, which
the trace of envelopes tells (5.1). A call cancelled, gone with its connection, or whose router was
disposed, is answered nothing (`spec.md` 9.4) and tells no failure; nor does a resolver that fails
once it answered.

4.3. A request refused by its admission, or whose admission fails, answered `PROCEDURE_FAILED`
(`spec.md` 9.2, step 6), or whose payload does not decode, is not traced: no step of it was told,
and none of its answer is; nor is a call whose value does not write, which is not made (`spec.md`
17.2). A relayed call is no call of a service manager's at the relay: neither of its legs is traced
as one, and their envelopes are, each leg under its own call id (5.1).

4.4. A call made names its call once its router drew its id, and its `tx` step is told then; one its
router refuses before drawing an id names none, and its `tx` step is told as it is refused. Its `tx`
step comes before its `rx` step. A call id names its call on its connection while the call is open:
once it ended, its router may draw it again (`spec.md` 9.1).

## 5. The trace of envelopes

5.1. A router tells each envelope to whoever listens, out once it is written within its bound, in
once it reads: its direction, its connection, `server` on a client, and its header, which carries
its credential's scheme in place of its credential.

5.2. An envelope of an advisory kind is skipped before the trace, and one that does not read is
reported, not traced.

## 6. The filter

_Debug filters: `spec/debug-filters.json`._

6.1. A filter is a string of words, which this grammar reads, in ABNF
([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)), whose quoted strings are case-insensitive, in
US-ASCII alone:

```abnf
filter     = *separator [ word *( 1*separator word ) *separator ]
separator  = "," / SP / HTAB / LF / %x0B / %x0C / CR
word       = selector / exclusion / pattern
selector   = directions / types / kinds
directions = "d(" direction *( "|" direction ) ")"
types      = "t(" type *( "|" type ) ")"
kinds      = "e(" kind *( "|" kind ) ")"
direction  = "rx" / "tx"
type       = "request" / "command" / "notification" / "r" / "c" / "n"
kind       = "request" / "result" / "failure" / "notification" / "chunk" / "credit" / "cancel"
exclusion  = "-" *character
pattern    = first *character
first      = %x00-08 / %x0E-1F / %x21-27 / %x2A-2B / %x2E-10FFFF
character  = first / "-"
```

`SP`, `HTAB`, `LF` and `CR` are RFC 5234's core rules
([Appendix B.1](https://www.rfc-editor.org/rfc/rfc5234#appendix-B.1)), and its terminals Unicode
scalar values, never a surrogate.

6.2. A separator is a comma or one of the six characters C's `isspace` reads as white space in the C
locale: space, tab, line feed, vertical tab, form feed and carriage return. Nothing outside ASCII
parts two words.

6.3. `d(…)` keeps directions; `t(…)` types of call, by the trace's words, `r`, `c` and `n` kept as
the short forms of `request`, `command` and `notification`; `e(…)` kinds of envelope, by their names
in section 3.1 of `spec.md`. A selector's letter and its values are read without regard to case, in
ASCII alone, as RFC 5234 reads a string: `D(RX)` holds, and `e(chun<U+212A>)` names no kind.
Selectors of one letter add up.

6.4. A pattern names procedures to keep, or, after `-`, to leave out, which wins. It matches a whole
name: `*` stands for any run of characters, none included, line terminators among them; an ASCII
letter stands for itself in either case; every other character stands for itself alone, compared
code point by code point, so a name outside ASCII is compared as it is. A pattern never holds a
parenthesis.

6.5. A call passes on its direction, its type and its procedure's name, and an envelope on its
direction and its kind, so one filter serves both. A list left empty keeps every one: an empty
filter keeps everything.

6.6. A filter reads as five lists, each in the order of its words and of a selector's values, a
value given twice kept twice: its directions, its types and its kinds, by the names of this
grammar's rules `direction`, `type` without its short forms, and `kind`, in lower case; its patterns
and its exclusions, as they were written, an exclusion without its `-`.

6.7. A word that starts with `d(`, `t(` or `e(`, in either case, and ends with `)`, is read as a
selector. A side MUST refuse a filter whose words do not all hold, naming the first that does not,
in the order of its words and of a selector's values, by its reason:

| Reason                | A word refused                                                  | Named     |
| --------------------- | --------------------------------------------------------------- | --------- |
| `selector empty`      | a selector with nothing within its parentheses: `d()`           | the word  |
| `value empty`         | a selector with a value left empty: `d(rx\|)`                   | the word  |
| `names nothing`       | a value that names none of its letter's: `d(UP)`, `d(rx)(tx)`   | the value |
| `holds a parenthesis` | any other word holding `(` or `)`: `d(rx,tx)` is two such words | the word  |

A refusal names the value or the word as it was written, quoted as JSON writes a string
([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)):
`a debug filter takes a direction among rx, tx, not "UP"`. The sentence is each side's own, and a C
side reports a code.

6.8. A filter given whole, not as a string, is refused in this grammar's names: its directions, its
types and its kinds.

6.9. A filter given as a function is asked as its listener is made, and again at each event. The
first it gives MUST hold, or the listener is not made; one that later fails to hold, or a function
that throws, leaves the last that held, and is not reported: a filter has no router to report
through, and is asked again at the next event. A function that gives none gives no filter, which
keeps every event, as an empty filter does (6.5), as its listener is made and at any event.

6.10. The filter compares the names it is given, whatever they hold; `spec.md` section 16 states
what a procedure's name holds, and every such name is a pattern the filter reads.

## 7. The registry

_Metrics: `spec/metrics.json`._

7.1. A registry counts what its side declares, for a router given one; a router given none counts
nothing. A router takes it as its option, `metricsRegistry`, `MetricsRegistry`, which the servers
and the clients that build a router pass on. One registry given to two routers sums them.

7.2. A procedure is declared to the registry of the router it is declared on:

1. as its resolver is registered, to the server families; and, when its procedure notifies, as the
   side that notifies, to the notification families;
2. as a requester is made, through the router's `declareRequester`, `DeclareRequester`, which gives
   back its series, to the client families;
3. as a notification is registered, on the side that hears, to the notification families.

7.3. A registry keys a procedure by its address, its service id and its procedure id, whichever
families declare it, and holds one name for it: a declaration of an address it holds under the same
name takes the same series, and so does one of its service at another revision, which no label
carries (section 8.1), as Prometheus identifies a series by its name and its labels. A router
refuses first what `spec.md` section 16.10 refuses. A side MUST refuse a declaration as it is made,
never on a call, as it refuses a resolver registered twice, for the first of these reasons that
applies, in their order:

| Reason                        | A declaration that names                                                       |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `another name at its address` | an address the registry holds under another name, one by `spec.md` 16.6 or not |
| `its name at another address` | a name its service holds at another address, the two one by `spec.md` 16.6     |
| `past the ceiling`            | one procedure more than its families name at most (7.4)                        |

A declaration refused declares nothing.

7.4. A side's client families name `maximumProcedures` procedures at most, its server families as
many, and its notification families as many: 1,000 by default. `_OTHER`'s series are its router's,
and count against none.

7.5. Every series is made before it counts. As a procedure is declared, the registry makes its
series at 0 in each family it is declared to, under the `type` its router gives it (section 8.2):
its started count; each outcome of its family, and under `failure` each code its family's exits can
end with; in its subscriptions dropped, those codes and none; its buckets, its `_sum` and its
`_count`. As it is given to a router, the registry makes that router's `_OTHER` series in its call
families. A count never makes a series.

7.6. The codes a family's exits can end with, by section 9's and section 10's tables:

| Series                                                                | Its codes                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a procedure's in the server families                                  | 12: `SESSION_REQUIRED`, `ACCESS_DENIED`, `PAYLOAD_TOO_LARGE`, `CAPACITY_EXCEEDED`, `CREDENTIAL_UNSUPPORTED`, `SUBSCRIPTION_UNSUPPORTED`, `CHUNK_INVALID`, `CREDIT_EXCEEDED`, `PAYLOAD_UNDECODABLE`, `TRANSFER_STALLED`, `PROCEDURE_FAILED`, `application` |
| a procedure's in the client families, and `_OTHER`'s in both          | 24: section 8's 22, `application` and `_OTHER`, since a peer's answer, or a relay's, can carry any                                                                                                                                                        |
| a procedure's in the notification families, as the side that notifies | 24, as a procedure's in the client families, since its application ends a subscription with the failure it chooses (`spec.md` 11.7, item 2)                                                                                                               |
| a procedure's in the notification families, as the side that hears    | 24, as a procedure's in the client families                                                                                                                                                                                                               |

A route refused, a header that does not read and a relayed call are `_OTHER`'s, which is why a
procedure's server series take none of their codes.

7.7. So a procedure takes 61 series in the server families: 44 in the histogram, its 42 buckets, its
`_sum` and its `_count`; 1 started; and 16 handled, `result`, `cancelled`, `closed` and `error`, and
`failure` under each of its 12 codes. It takes 74 in the client families: 44, 1, and 29 handled,
`timeout` besides and 24 codes. It takes 27 in the notification families of the side that notifies,
2 sent and 25 dropped, its 24 codes and none; and 26 in those of the side that hears, 1 heard and 25
dropped, the same 25. `_OTHER` takes 73 series in the server families of a router and 74 in
its client families.

## 8. The families

_Metrics: `spec/metrics.json`._

8.1. A registry writes nine families. They take OpenTelemetry's semantic conventions for RPC
([Release Candidate](https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/)), named as a
Prometheus name is written, `bead` in place of `rpc`; their started counters follow gRPC's
[A66](https://github.com/grpc/proposal/blob/master/A66-otel-stats.md), and their notifications part
by role, as OpenTelemetry's messaging conventions do. They part from the RPC conventions in three
places: their buckets are A66's (section 11.3), their histograms carry no `error.type`, which `code`
carries on the counters alone (section 8.4), and no family carries `rpc.system.name`. Their
`_handled_total` families take the shape of grpc-ecosystem's
[`go-grpc-middleware`](https://github.com/grpc-ecosystem/go-grpc-middleware). Each has its type, the
unit it counts, its labels and its help:

| Family                              | Type      | Unit          | Labels                                            | Help                                                                                 |
| ----------------------------------- | --------- | ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `bead_client_call_duration_seconds` | histogram | seconds       | `service`, `procedure`, `type`                    | How long each call this side made took, from its start to its end, in seconds.       |
| `bead_client_call_handled_total`    | counter   | calls         | `service`, `procedure`, `type`, `outcome`, `code` | Each call this side made, as it ended, by its outcome.                               |
| `bead_client_call_started_total`    | counter   | calls         | `service`, `procedure`, `type`                    | Each call this side made, as its router took it.                                     |
| `bead_notifications_heard_total`    | counter   | notifications | `service`, `procedure`                            | Each notification heard under a subscription this side holds.                        |
| `bead_notifications_sent_total`     | counter   | notifications | `service`, `procedure`, `outcome`                 | Each notification for one subscription, handed to its transport or not.              |
| `bead_server_call_duration_seconds` | histogram | seconds       | `service`, `procedure`, `type`                    | How long each call this side answered took, from its arrival to its end, in seconds. |
| `bead_server_call_handled_total`    | counter   | calls         | `service`, `procedure`, `type`, `outcome`, `code` | Each call this side answered, as it ended, by its outcome.                           |
| `bead_server_call_started_total`    | counter   | calls         | `service`, `procedure`, `type`                    | Each call this side answered, as its request opened it.                              |
| `bead_subscriptions_dropped_total`  | counter   | subscriptions | `service`, `procedure`, `code`                    | Each subscription ended other than by its client's cancel, at this end.              |

8.2. Client and server are a call's roles, as OpenTelemetry's span kinds are: `bead_client_*`
counts the calls a side makes, its `tx`, and `bead_server_*` those it answers, its `rx`, whatever the
side. A server's commands to a client count among its client calls, and a client's answers to them
among its server calls. `type` is `request` or `command`, by the router's side: a client's router
makes requests and answers commands, a server's the reverse.

8.3. `service` is the service's id, in decimal, and `procedure` its procedure's name; the two
together are OpenTelemetry's `rpc.method`. A call the side has no declaration for is `_OTHER` for
both, as `rpc.method` is for a method its server does not recognize: a request whose header does not
read, a service or a procedure unknown, a request that names a destination, a call made that carries
no series. A relay counts the calls it relays under its server families' `_OTHER`, and their leg B,
which carries none, as `_OTHER` in client families: `command` toward a connection of the relay's
own, through its own router's `request`, in its registry; `request` through a router it calls, in
that router's. No procedure is named `_OTHER`, which starts with no lower-case letter
(`spec.md` 16.4); a registry given one keeps its series apart, its `service` a decimal. The
notification families have no `_OTHER`: a notification sent, heard or ended belongs to a procedure
its side declared. No label is ever a connection, a session, a call id, a destination or a
credential.

8.4. `outcome` says how a call ended, `result`, `failure`, `timeout` (a call made alone),
`cancelled`, `closed` or `error`, by section 9's exits, and what became of a notification, `sent` or
`failed`. `code`, OpenTelemetry's `error.type`, is set on `failure` alone and on a subscription
dropped by a failure: a protocol code by its name in section 8 of `spec.md`, `ACCESS_DENIED`; a code
section 8 names none of, `_OTHER`; a procedure's own failure, `application`. A label left out is
written nowhere, as Prometheus reads an empty one.

8.5. What is under way is a started count less the handled counts of its `service`, `procedure` and
`type`, exact within each series at its reading: a registry reads the counts of each `service`,
`procedure` and `type` of a role once, its handled counts before its started count, and writes each
of their lines from that one reading, so the difference never reads below 0. Across series, a side
that counts from several threads reads each at its own instant, as Prometheus's client libraries
collect. A family's `_handled_total` is written before its `_started_total`, as their names order
them. No gauge is kept besides.

## 9. The gates

_Metrics: `spec/metrics.json`._

9.1. A router counts every call at its gates:

| Gate                      | Where                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server call starts      | as its request opens its call, past steps 1 and 2 of `spec.md`'s 9.2, which answer nothing, open no call and are reported, not counted; timed from that request's arrival, so a credential's wait and a transfer's chunks fall within |
| A server call ends        | as its answer is handed to its transport, a whole answer at its own hand-off, a result sent as a transfer at its last chunk's, or as it ends unanswered; timed to that instant                                                        |
| A client call starts      | as its router's `request` takes it, once nothing makes it a programmer's error and its signal is not aborted                                                                                                                          |
| A client call ends        | as its router settles it: its answer come whole, a refusal of its router's, its time passed, its caller's cancel, its connection gone; timed to that instant                                                                          |
| A notification goes       | as it is handed to its transport for one subscription, at once or from its queue as a credit lets it go (`spec.md` 11.8, 11.9), or as it cannot be                                                                                    |
| A notification is heard   | as its router pairs it with a subscription it holds                                                                                                                                                                                   |
| A subscription is dropped | as its router ends it other than by its client's cancel, at each of its ends                                                                                                                                                          |

9.2. An answer, or a notification, handed to its transport and then refused by it keeps what was
counted at its hand-off, and the refusal is reported (`spec.md` 9.0).

9.3. A router takes a call it makes in this order: first what makes it a programmer's error, a
timeout or a payload's limit that does not hold, a credential no call presents (`spec.md` 13.4)
and one no header of its request holds (`spec.md` 4.4), a subscription its router does not hold, a command that names no connection, and
a signal aborted already, each refused and not counted; then the call starts; then every check that
can refuse it, each ending it in the turn it started. A request whose header does not read,
answered at the gate (`spec.md` 9.6.2), starts and ends in one turn too, under `_OTHER`; so does a
request past the calls its connection has its side answer at once (`spec.md` 9.2, step 3), under its
procedure's series when its router declares it, `_OTHER`'s otherwise (7.3).

9.4. Each call a side answers ends as one of these, the sections `spec.md`'s:

| A call this side answers                                                                                                            | `outcome`   | `code`                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| its result is handed to its transport, whole or by its last chunk (9.3, 12.5)                                                       | `result`    |                                                                                       |
| its call past those its connection has it answer at once (9.2, step 3)                                                              | `failure`   | `CAPACITY_EXCEEDED`                                                                   |
| its route is refused (9.2, steps 4 and 5)                                                                                           | `failure`   | `DESTINATION_UNKNOWN`, `SERVICE_UNKNOWN`, `PROCEDURE_UNKNOWN`                         |
| its credential is refused, or its verifier fails, or it would wait past the calls let wait for its issuer (9.2, step 6; 13.8, 13.9) | `failure`   | `CREDENTIAL_UNSUPPORTED`, `SESSION_REQUIRED`, `PROCEDURE_FAILED`, `CAPACITY_EXCEEDED` |
| its admission refuses it, or fails (9.2, step 6)                                                                                    | `failure`   | the refusal's name, of the admission's block; `PROCEDURE_FAILED`                      |
| its subscription cannot be carried back (9.2, step 7)                                                                               | `failure`   | `SUBSCRIPTION_UNSUPPORTED`                                                            |
| its payload, or its transfer's total, past its limit, or a transfer its side takes none of (9.2, step 8; 12.3)                      | `failure`   | `PAYLOAD_TOO_LARGE`                                                                   |
| its transfer's opening refused: no byte of its payload, or its whole total (12.3)                                                   | `failure`   | `CHUNK_INVALID`                                                                       |
| its transfer's opening past the transfers its connection receives at once, or past the budget left (12.3)                           | `failure`   | `CAPACITY_EXCEEDED`                                                                   |
| its request's transfer ended before its payload is whole: a chunk refused, or nothing came (12.6, 12.7)                             | `failure`   | `CHUNK_INVALID`, `CREDIT_EXCEEDED`, `TRANSFER_STALLED`                                |
| its header does not read, and it is answered (9.6.2)                                                                                | `failure`   | `ENVELOPE_MALFORMED`, `LAYOUT_UNSUPPORTED`, `ENVELOPE_TOO_LARGE`                      |
| a payload its procedure cannot read (9.5)                                                                                           | `failure`   | `PAYLOAD_UNDECODABLE`                                                                 |
| a resolver that fails before it answers, or a result its side cannot send (9.5, 12.1)                                               | `failure`   | `PROCEDURE_FAILED`                                                                    |
| a procedure's own failure, or a refusal of admission its resolver answers (9.5)                                                     | `failure`   | `application`; the refusal's name                                                     |
| its subscription's queue past its bounds before its answer (11.10)                                                                  | `failure`   | `CAPACITY_EXCEEDED`                                                                   |
| its result's transfer stalled, nothing coming for `transferInactivityTimeout` before its last chunk (12.7)                          | `failure`   | `TRANSFER_STALLED`                                                                    |
| a relayed call's answer: its destination's, passed on, or its relay's own (14.3, 14.5)                                              | as answered | as answered                                                                           |
| its requester cancels it, its credential resolving or not, its transfer under way or not (10.2, 12.7)                               | `cancelled` |                                                                                       |
| its connection closes, or the side is disposed (9.10, 12.10)                                                                        | `closed`    |                                                                                       |
| it ends with no answer handed to its transport, its handler failing and its answer as failed unable to go, and is reported (9.0)    | `error`     |                                                                                       |

9.5. A call whose result goes as a transfer ends at its last chunk: until then it can still end
`failure` `TRANSFER_STALLED`, `cancelled` or `closed`, and is counted so. A request that opens a
subscription and is refused in its own answer, its queue past its bounds before it, is that call's
`failure`, at both ends, never a subscription dropped.

9.6. Each call a side makes ends as one of these, the sections `spec.md`'s:

| A call this side makes                                                                                                                                                        | `outcome`   | `code`                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------- |
| it asks for `OPAQUE` and its side knows no session, or would present a default withdrawn, before it goes (13.4)                                                               | `failure`   | `SESSION_REQUIRED`                |
| it presents a credential its transport cannot carry, before it goes (13.4)                                                                                                    | `failure`   | `DESTINATION_UNREACHABLE`         |
| no call id is free, or its calls waiting on the connection number `maximumAnsweringCalls`, before it goes (9.1)                                                               | `failure`   | `CAPACITY_EXCEEDED`               |
| its payload past its limit, a transfer its side sends none of, or one its header leaves no opening, past 1,020 bytes or without a byte within `chunkBytes` (12.1, 12.2, 12.3) | `failure`   | `PAYLOAD_TOO_LARGE`               |
| a result comes whole (9.7, 12.6), whether its requester decodes it or not                                                                                                     | `result`    |                                   |
| a failure comes (9.7), passed on by relays or not (7.5)                                                                                                                       | `failure`   | its name, `application`, `_OTHER` |
| its router ends it once it went: an answer that does not read (9.6.3), its result's transfer refused (12.3, 12.6)                                                             | `failure`   | its name                          |
| its time passes (9.9), or its transfer's inactivity (12.7, 12.8)                                                                                                              | `timeout`   |                                   |
| its caller cancels it (10.1)                                                                                                                                                  | `cancelled` |                                   |
| its connection is not open as it starts, or closes, or the side is disposed (9.10)                                                                                            | `closed`    |                                   |
| anything else its router fails it with: a transport that refuses its request                                                                                                  | `error`     |                                   |

9.7. A call to a connection that is not open fails with the type a connection that closes fails it
with, `DisconnectError`, `DisconnectException`, and counts alike, `closed`: the two are one race with
a close. A call made on a connection that closes fails and counts so too, even when the signal it
was given is that of a call the close ends: never as a cancel, `CancelError`, `OperationCanceledException`.

9.8. The metrics count what the wire carried, and the trace tells what the side made of it. A result
its requester cannot decode came as a result, and is counted so at both ends; the trace tells the
failure. A request that opens a subscription counts as a call by its answer; what follows it is the
notifications'. A failure whose code a procedure's server series take none of, which a resolver
registered on its router itself, not through a service manager, alone can answer, counts under
`PROCEDURE_FAILED`, the code a service manager answers in its place (`spec.md` 9.5), since no count
makes a series (7.5).

## 10. Notifications

_Metrics: `spec/metrics.json`._

10.1. `bead_notifications_sent_total` counts at the side that notifies: `sent` for a notification
handed to its transport for one subscription, and `failed` for one that cannot be, too large for one
envelope (`spec.md` 12.1), a value that does not write (`spec.md` 17.2), counted for each
subscription it was for, its router disposed, a transport that throws as it is handed it, which is
reported.

10.2. `bead_notifications_heard_total` counts at the side that hears a notification its router pairs
with a subscription it holds, whether it decodes or not. One under no subscription is reported, and
one on a call id reserved dropped in silence (`spec.md` 11.7): neither is counted.

10.3. `bead_subscriptions_dropped_total` counts at each end of a subscription, never from a service
manager's `dropped` event:

| End                    | A subscription dropped                                                  | `code`                                           |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| the side that notifies | its queue past its bounds once it was answered (`spec.md` 11.10)        | `CAPACITY_EXCEEDED`                              |
| the side that notifies | its session ended (`spec.md` 13.6)                                      | `SESSION_REQUIRED`                               |
| the side that hears    | a failure on its call id once it was answered (`spec.md` 11.7, item 2)  | the failure's: its name, `application`, `_OTHER` |
| either                 | its connection closes, or the side is disposed (`spec.md` 11.7, item 3) |                                                  |
| the side that notifies | a failure its application ends it with (`spec.md` 11.7, item 2)         | the failure's: its name, `application`, `_OTHER` |

10.4. A client's cancel (`spec.md` 11.7, item 1) drops nothing, at either end. A notification a
later one of the same key replaces in its queue (`spec.md` 11.9), or one its subscription's end
leaves queued, is neither sent nor failed: that is its pacing, or that end, which the dropped
subscriptions count.

## 11. Durations

_Metrics: `spec/metrics.json`._

11.1. A router reads its monotonic clock at a call's start gate and at its end gate, and observes
the difference in whole microseconds, its fraction dropped: the TypeScript side the difference of
its two milliseconds in nanoseconds, rounded to a whole one, then over 1,000, so that a reading's
binary fraction drops no microsecond, 0.3 ms less 0.2 ms reading 100 µs; the C# side a `TimeSpan`'s
ticks over 10.

11.2. Every call that ends is observed, whatever its outcome, so a series' `_count` is the sum of
its handled counts, each series at one reading (section 8.5).

11.3. The buckets are A66's, its 0 included: 41 bounds and `+Inf`, 42 buckets, from 0 to 100 s. A
duration of _d_ µs falls in every bucket whose bound, in microseconds, is _d_ or more: an integer
comparison, so a call the clock saw take no time falls in the bucket of 0. Each bound is written as
its `le`, OpenMetrics' canonical number for it, Go's `%g` with a `.0` added when it holds no point
and no exponent, the string Prometheus 3 stores whatever a target writes. A side writes these
constants from a table, formatting no number:

|  Bound, µs | `le`     |   Bound, µs | `le`     |  Bound, µs | `le`     |
| ---------: | -------- | ----------: | -------- | ---------: | -------- |
|          0 | `0.0`    |          10 | `1e-05`  |         50 | `5e-05`  |
|        100 | `0.0001` |         300 | `0.0003` |        600 | `0.0006` |
|        800 | `0.0008` |       1,000 | `0.001`  |      2,000 | `0.002`  |
|      3,000 | `0.003`  |       4,000 | `0.004`  |      5,000 | `0.005`  |
|      6,000 | `0.006`  |       8,000 | `0.008`  |     10,000 | `0.01`   |
|     13,000 | `0.013`  |      16,000 | `0.016`  |     20,000 | `0.02`   |
|     25,000 | `0.025`  |      30,000 | `0.03`   |     40,000 | `0.04`   |
|     50,000 | `0.05`   |      65,000 | `0.065`  |     80,000 | `0.08`   |
|    100,000 | `0.1`    |     130,000 | `0.13`   |    160,000 | `0.16`   |
|    200,000 | `0.2`    |     250,000 | `0.25`   |    300,000 | `0.3`    |
|    400,000 | `0.4`    |     500,000 | `0.5`    |    650,000 | `0.65`   |
|    800,000 | `0.8`    |   1,000,000 | `1.0`    |  2,000,000 | `2.0`    |
|  5,000,000 | `5.0`    |  10,000,000 | `10.0`   | 20,000,000 | `20.0`   |
| 50,000,000 | `50.0`   | 100,000,000 | `100.0`  |            | `+Inf`   |

11.4. A side reads its durations as finely as its platform's monotonic clock: a TypeScript side in a
browser at the coarsening W3C High Resolution Time sets, 100 µs or 5 µs, its buckets under it
holding zeros and its `_sum` a multiple of it. The trace keeps its whole milliseconds; its duration
is the service manager's, the metrics' the router's.

## 12. The exposition

_Metrics: `spec/metrics.json`._

12.1. A registry's exposition, `exposition()`, `Exposition()`, writes it in
[the Prometheus text exposition format, version 0.0.4](https://prometheus.io/docs/instrumenting/exposition_formats/),
and gives its media type with it: `text/plain; version=0.0.4; charset=utf-8`.

12.2. It writes its families in the order of their names, each that holds a series as one group, its
`# HELP` line, then its `# TYPE` line, then its series; a family that holds none is not written.

12.3. Within a family, the series come by service id, then procedure id, `_OTHER` last; then by
`type`, `request` first; then by `outcome`, in the order `result`, `failure`, `timeout`,
`cancelled`, `closed`, `error`, or `sent` then `failed`; then by `code`, none first, then by its
number in section 8 of `spec.md`, `application` and `_OTHER` last. A histogram's series writes its
buckets rising to `+Inf`, then its `_sum`, then its `_count`.

12.4. A series' labels come in the order `service`, `procedure`, `type`, `outcome`, `code`, `le`,
each written `name="value"`, a comma between, none around. A label's value is written with `\`, `"`
and line feed escaped as `\\`, `\"` and `\n`, and a help with `\` and line feed escaped, as 0.0.4
escapes them; a lone surrogate in a name is written U+FFFD, as `spec.md` 7.4 writes a detail.

12.5. A count, and a `_count`, is written in decimal; a `le` from 11.3's table; and a `_sum` from
its whole microseconds, held exactly, a `long` on the C# side, whole seconds and the microseconds
under one on the TypeScript side, whose numbers stop being exact at 2⁵³ µs. A `_sum` is written as
its whole seconds, then, when microseconds remain, a point and their six digits less their trailing
zeros, never with an exponent: 10 µs `0.00001`, 2,500,000 µs `2.5`, 3,000,000 µs `3`.

12.6. A line holds no timestamp, and ends with a line feed, the last one too.

12.7. An application serves the text where it likes, at `/metrics` beside its `/health`, or appends
it to its own exposition when that one is 0.0.4: Bead's families are `bead_*` alone, each one group.
One whose exposition is OpenMetrics serves Bead's at a path of its own, a second target. Bead opens
no port.
