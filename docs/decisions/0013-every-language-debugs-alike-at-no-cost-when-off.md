# 0013 — Every language traces, filters and counts its calls alike, beside the wire, at no cost when off

- **Status**: accepted
- **Scope**: a companion document, `spec/debugging.md`, with its own version; its conformance files,
  `spec/debug-filters.json` and `spec/metrics.json`, their schemas, their generators and
  `spec/check.py`; the version axes of [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md);
  every implementation's service manager, routers, debug filter, statistics and harnesses; the demo;
  the support matrix

## Context

Each side traces its calls, traces its envelopes, filters both, and sums up how long its calls took:
the TypeScript side's `debug` events, `parseDebugFilter`, `filterDebug`, `filterEnvelopeDebug` and
`createDebugStatistics`; the C# side's `Debug` events, `DebugFilter.Parse`, `DebugFilters` and
`DebugStatistics`. The support matrix says "not in the spec": the two are alike by the rule of parity
alone, held by twin tests over the same inputs. Where no twin looks, the filter's grammar parts, as
the two platforms' regular expressions and casings do:

- a separator: U+0085 parts two words on the C# side alone, U+FEFF on the TypeScript side alone;
- `*`: the pattern `a*` matches a name holding `\r` or U+2028 on the C# side alone;
- case: the pattern `key` matches a name spelled with the Kelvin sign, U+212A, on the C# side alone;
  U+0130 lowers to two code units on one side and stays on the other;
- parentheses: `d(rx,tx)` is read as two patterns, `d(rx` and `tx)`, which match nothing, on both
  sides and in silence;
- a refusal: `d(UP)` is refused `not "up"` on one side and `not "UP"` on the other, and a value
  holding a quote is escaped on one side alone.

A language that joins finds no grammar to read, only two implementations to copy.

A listener's error crosses into the call. On both sides, a trace listener that throws on a call's
answer turns its result into a rejection, and one that throws on a request's step leaves the request
unanswered, its requester waiting out its timeout, where spec 9.5 has a side that fails before it
answers answer `PROCEDURE_FAILED`. A twin test on each side pins the first: a listener that throws on
the answer fails the call once.

The statistics answer one question badly: how long the last thousand calls took, all of them
together, round trips and handling times mixed unless a filter parts them. A dashboard asks, per
service and per procedure, how many calls, how many failed and why, how long they took, and how many
are under way. Nothing a side exposes answers it: the gauges count what each layer holds now, never
per procedure, and health is a verdict for a probe, `application/health+json`, which no scraper reads.

A side that runs a 1 kHz loop turns its debugging off, and off must cost nothing. It costs: the
trace's event is built only for a listener, but what feeds it is built for every call. Each call made
reads its clock twice and builds its step, on both sides, and on the C# side copies its options; each
request answered, each notification sent or heard, reads the clock and builds a step; and on the
TypeScript side each envelope, out or in, is copied into a redacted header for a listener that may
not be there. A filter does not help: it runs in the listener, once the event and its copies are
built.

Five ways were weighed for the surface and its counts:

- **Debugging left to each implementation**, outside the spec, as it is: free now, and every
  language that joins invents its own grammar and its own words.
- **OpenTelemetry's tracing and metrics APIs**, the standard for spans and instruments: a dependency
  on every side and on a constrained profile, exporters besides, and no filter grammar. The trace
  already has a span's shape, a start on the wall clock and a duration on the monotonic one
  ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)), which a bridge can map.
- **Each platform's Prometheus client**, `prom-client` and `prometheus-net`: a dependency a side,
  each writing its exposition its own way — the order of its series, its numbers, its help — which no
  conformance file holds alike.
- **Each platform's own instruments**: .NET's `System.Diagnostics.Metrics` and `ActivitySource`, in
  its base library, which OpenTelemetry .NET, `prometheus-net` and `dotnet-counters` read; Node's
  `diagnostics_channel`, a channel a library publishes on for whoever subscribes, `hasSubscribers`
  telling whether to build a message at all. No dependency, and no work while nobody listens. But
  Node's library has a channel and no instruments, so the TypeScript side would keep its own counts
  still; a C side has neither; and what reaches a scraper is each platform's exporter's writing,
  which a conformance file could hold by names, units and buckets and never by a byte.
- **A companion document that states what a side traces, filters and counts, held by conformance
  files, and a registry of Bead's own that writes the Prometheus text format.** Chosen.

Where to count was weighed too. The service manager, where the trace is, sees a request only once its
router admitted it: a refusal of its route, its credential or its admission (spec 9.2, steps 3 to 7)
and a relayed call never reach it — a server that refuses every call `ACCESS_DENIED` would count
none failed — and its clock starts once the credential resolved and the transfer came whole, past the
waits an operator looks for. Of a call it makes, it sees neither the refusals its router makes before
the request goes nor the moment the request is handed to the transport. The router's gates see every
exit, and the instant each call starts and ends. Chosen: the gates, each named.

What to write: OpenMetrics 1.0, `application/openmetrics-text; version=1.0.0`; the Prometheus text
format 0.0.4; or both, by the scraper's `Accept`. OpenMetrics ends with `# EOF` and names a counter's
family without its `_total`, so its text cannot be appended to another; 0.0.4 is what every
Prometheus scrapes, and families of distinct names append. Chosen: 0.0.4 alone. Its bounds were
weighed apart: Prometheus 3 rewrites a histogram's `le` as it ingests a scrape, whatever the format,
into OpenMetrics' canonical numbers — `le="1"` is stored as `le="1.0"` — and its migration guide warns
that alerts, recording rules and dashboards naming a bound as a whole number, `le="1"`, stop working;
a bound under 0.0001 is stored with an exponent, `le="1e-05"`; OpenMetrics 1.0 requires that form of
`le`. Chosen: each `le` in OpenMetrics' canonical form, from a table of
constants.

How to cut the families: one family a measure, a `direction` label parting the calls a side makes
from those it answers, as the first draft had, mixes round trips with handling times, as the
statistics do, and counts a failure twice. OpenTelemetry's semantic conventions for RPC, a Release
Candidate, keep `rpc.client.call.duration` and `rpc.server.call.duration` apart, and gRPC's A66
counts `grpc.client.attempt.started` and `grpc.server.call.started`, so that what is under way is
what started less what ended. Notifications part the same way, by role: OpenTelemetry's messaging
conventions keep `messaging.client.sent.messages` and `messaging.client.consumed.messages` apart, and
Prometheus's naming guide asks that a sum or a mean over every label of a family mean something, which
notifications sent and heard, and subscriptions dropped at both ends, never do summed together.
Chosen: that vocabulary, calls and notifications alike.

What a label holds for a value it does not know: OpenTelemetry's `_OTHER`, the fallback of
`rpc.method` for a method a server does not recognize and of `error.type` (Stable); A66's `other`, in
lower case, for a method not registered. Chosen: `_OTHER`, on every label, `code` included.

What a side does past its ceiling: an OpenTelemetry SDK folds the attribute sets past its
cardinality limit into one overflow set, `otel.metric.overflow` (Stable), which no value of a label
stands for. A side's procedures are known as it is built, and a C side's once it is compiled. Chosen:
a declaration past the ceiling refused as it is made, so `_OTHER` means a value not known, never a
bound reached.

How fine: OpenTelemetry's recommended buckets start at 5 ms, and the trace's whole milliseconds, a
fraction dropped, put every call under 2 ms in the first bucket and add nothing to `_sum` for a call
under one: a 1 kHz loop reads a mean of 0 s. Node and .NET read the monotonic clock finer than that; a
browser coarsens it to 100 µs, or 5 µs once cross-origin isolated
([W3C High Resolution Time](https://www.w3.org/TR/hr-time-3/)). Two lists from 10 µs were weighed: a
1, 2.5, 5 progression to 10 s, 19 bounds, as Prometheus's own default runs above 5 ms; and A66's, 41
bounds from 0 to 100 s, which has a bound at 1, 2, 3, 4, 5, 6, 8 and 10 ms where the first has 1, 2.5,
5 and 10. Both count a 1 kHz loop's overruns past 1 ms exactly; A66's alone has a loop at 500 Hz or
250 Hz find its period among its bounds, and estimates a quantile near 1 ms within 200 µs, where the
first does within 500. Chosen: whole microseconds, A66's bounds, its 0 included.

For the filter's grammar: the `debug` package's `DEBUG` as it is — names parted by commas or white
space, `*` for any run, `-` to leave a name out — matches names case-sensitively, parts them on
JavaScript's `\s`, which reaches past ASCII, and has no way to keep a direction, a type of call or a
kind of envelope. Chosen: `DEBUG`'s words, three selectors of Bead's, written in ABNF, in ASCII.

Where it lives: a section 16 of `spec/spec.md` would tie a changed bucket or a filter's refusal to
the version every wire file repeats, and tag a `spec-v*`, for what never crosses the wire. Chosen: a
companion document, `spec/debugging.md`, with its own version.

Durations an application gives, and their conformance file, are a decision of their own, 0014,
landed first: nothing here depends on them.

## Decision

**Debugging is a side's own, and never the wire's.** A side that carries the protocol whole traces
its calls and its envelopes, filters both, and counts its calls and its notifications, as
`spec/debugging.md` states; nothing it traces, filters or counts goes on the wire, and a peer never
knows whether it listens. A constrained profile may leave the trace and the filter out, or the
metrics, or both, at build time, and conforms to the wire — sections 1 to 15 of `spec/spec.md` —
either way: what it leaves out is a row of the support matrix, not a difference of the protocol.

**One surface, named alike.** Each side keeps its platform's shapes
([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)): an event and an emitter's
listener, a record and an object, a `TimeSpan` and milliseconds.

| Piece                  | TypeScript                                                                                | C#                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The trace of calls     | `manager.on('debug', (error, event) => …)`, `IDebugEvent`                                 | `manager.Debug += (error, debugEvent) => …`, `DebugEvent`                                          |
| Whether anyone listens | `manager.isDebugging`                                                                     | `manager.IsDebugging`                                                                              |
| The trace of envelopes | `router.on('debug', ({ connectionHandle, direction, header }) => …)`                      | `router.Debug += (direction, envelope) => …`, `TracedEnvelope`                                     |
| The filter             | `parseDebugFilter`, `filterDebug`, `filterEnvelopeDebug`, `IDebugFilter`                  | `DebugFilter.Parse`, `DebugFilters.FilterDebug`, `DebugFilters.FilterEnvelopeDebug`, `DebugFilter` |
| The registry           | `createMetricsRegistry({ maximumProcedures })`, `IMetricsRegistry`; `metricsRegistry`     | `new MetricsRegistry(options)`, `MetricsRegistryOptions`; `MetricsRegistry`                        |
| Its exposition         | `registry.exposition()`, `IMetricsExposition`: `{ contentType, text }`                    | `registry.Exposition()`, `MetricsExposition(ContentType, Text)`                                    |
| A requester's series   | `router.declareRequester(procedure)`, `IProcedureSeries`; the router's request's `series` | `router.DeclareRequester(procedure)`, `ProcedureSeries`; `RouterRequest.Series`                    |

`metricsRegistry` and `MetricsRegistry` are a router's option, which the servers and clients that
build a router pass on. The registry is not `Metrics`: `prometheus-net`'s static class of that name
would make a bare one ambiguous (CS0104) in an application that uses both, which
[0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) avoids. A requester's series is
the handle its declaration gives back, which the manager hands to its router's `request` with each
call: `declareRequester` and `DeclareRequester` give it, `IProcedureSeries` and `ProcedureSeries`,
and the router's request carries it as `series` and `Series`.

**The trace of calls tells each step**, at the service manager, with the same fields on every side:
its direction, `tx` out and `rx` in; its type, `request`, `command` or `notification`; its
procedure's id and name, its service's id and revision; `startedAt`, the call's start on the wall
clock, a notification's as it is sent or heard; `duration`, whole milliseconds on the monotonic
reading once the call answered, none before and none for a notification; the call's options, its
defaults applied, its credential left out; what came in and what went out, decoded; and what it
failed with, by its code, its scope and its detail. The steps: a call made, and its answer or its
failure; a request received once admitted and decoded, and the answer it sends; a notification sent,
and its failure to go at that same start; a notification heard, or its failure to decode. A request
refused by its admission, or whose payload does not decode, is not traced.

**The trace of envelopes tells each envelope**, at the router, out once it is written within its
bound, in once it reads: its direction, its connection — `server` on a client — and its header,
which carries its credential's scheme in place of its credential, on both sides. An advisory kind is
skipped before the trace; an envelope that does not read is reported, not traced.

**A listener's error never changes a call.** An error a listener throws — the trace's, a filter's
around it — is reported, as spec 9.0 reports an error: the router's `error` event, `Error`, with the
call's connection on a server, which the service manager reports through its router's. The call goes
on as if nobody listened: its outcome, its answer and what goes on the wire are the same. Both sides
call each listener within a guard, and count on a path no listener runs on.

**The filter is `DEBUG`'s words, three selectors of Bead's, in ASCII.** `spec/debugging.md` states it
in ABNF ([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234), whose quoted strings are
case-insensitive, in US-ASCII alone):

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

- A separator is a comma or one of the six characters C's `isspace` reads as white space in the C
  locale: space, tab, line feed, vertical tab, form feed, carriage return. Nothing outside ASCII
  parts two words.
- `d(…)` keeps directions; `t(…)` types of call, by the trace's words, `r`, `c` and `n` kept as their
  short forms; `e(…)` kinds of envelope, by their names in section 3.1 of `spec/spec.md`. A selector's
  letter and its values are read without regard to case, in ASCII alone, as RFC 5234 reads a string:
  `D(RX)` holds, and `e(chun<U+212A>)` names no kind. Selectors of one letter add up.
- A pattern names procedures to keep, or, after `-`, to leave out, which wins. It matches a whole
  name: `*` stands for any run of characters, none included, line terminators among them; an ASCII
  letter stands for itself in either case; every other character stands for itself alone, compared
  code point by code point, so a name outside ASCII is compared as it is. A pattern never holds a
  parenthesis.
- A call passes on its direction, its type and its name; an envelope on its direction and its kind,
  so one filter serves both. A list left empty keeps every one; an empty filter keeps everything.
- A word that starts with `d(`, `t(` or `e(`, in either case, and ends with `)` is read as a
  selector, and refused when it is not one: empty, `d()`; a value left empty, `d(rx|)`; a value that
  names none of its letter's, `d(rx)(tx)` among them. Any other word holding `(` or `)` is refused:
  `d(rx,tx)` is two such words. A refusal names the value or the word as it was written, quoted as
  JSON writes a string ([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)):
  `a debug filter takes a direction among rx, tx, not "UP"`. A filter given whole, not as a string,
  is refused in the grammar's names.
- A filter given as a function is asked at each event. The first it gives must hold, or the listener
  is not made; one that later fails, or a function that throws, leaves the last that held.

The filter compares the names it is given, whatever they hold: section 16 of `spec/spec.md` states
what a procedure's name holds ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)), and every such name is a pattern the filter reads.

**A registry counts what its side declares, for a router given one.** A router given none counts
nothing. Its families take OpenTelemetry's semantic conventions for RPC
([Release Candidate](https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/)), named as a
Prometheus name is written, `bead` in place of `rpc` so they never meet an application's own `rpc_*`
families in one scrape; the started counters follow gRPC's
[A66](https://github.com/grpc/proposal/blob/master/A66-otel-stats.md); the notifications part by
role, as OpenTelemetry's messaging conventions do:

| Family                              | Type      | Labels                                            | Counts                                                                 |
| ----------------------------------- | --------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `bead_client_call_duration_seconds` | histogram | `service`, `procedure`, `type`                    | how long each call the side made took, from its start to its end       |
| `bead_client_call_handled_total`    | counter   | `service`, `procedure`, `type`, `outcome`, `code` | each call the side made, as it ends                                    |
| `bead_client_call_started_total`    | counter   | `service`, `procedure`, `type`                    | each call the side made, as its router's `request` takes it            |
| `bead_notifications_heard_total`    | counter   | `service`, `procedure`                            | each notification heard under a subscription the side holds            |
| `bead_notifications_sent_total`     | counter   | `service`, `procedure`, `outcome`                 | each notification for one subscription, handed to its transport or not |
| `bead_server_call_duration_seconds` | histogram | `service`, `procedure`, `type`                    | how long each call the side answered took, from its arrival to its end |
| `bead_server_call_handled_total`    | counter   | `service`, `procedure`, `type`, `outcome`, `code` | each call the side answered, as it ends                                |
| `bead_server_call_started_total`    | counter   | `service`, `procedure`, `type`                    | each call the side answered, as its request opens it                   |
| `bead_subscriptions_dropped_total`  | counter   | `service`, `procedure`, `code`                    | each subscription ended other than by its client's cancel, at each end |

- **Client and server are a call's roles**, as OpenTelemetry's span kinds are: `bead_client_*` counts
  the calls a side makes, its `tx`, and `bead_server_*` those it answers, its `rx`, whatever the side.
  A server's commands to a client count among its client calls, `type="command"`; a client's answers
  to them among its server calls. `type` is `request` or `command`, by the router's side: a client's
  router makes requests and answers commands, a server's the reverse.
- **`service`** is the service's id, in decimal; **`procedure`** its name; the two together are
  OpenTelemetry's `rpc.method`, which names a method with its service. A call the side has no
  declaration for is `_OTHER` for both, as `rpc.method` is for a method its server does not
  recognize: a request whose header does not read, a service or a procedure unknown, a request that
  names a destination, a call made that carries no `series`. A relay counts the calls it relays
  under its server families' `_OTHER`, and their leg B, which carries none, as `_OTHER` in client
  families: `type="command"` toward a connection of the relay's own, through its own `request`, in
  its registry; `type="request"` through a router it calls, in that router's. No procedure is
  named `_OTHER`, which starts with no lower-case letter ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)); a registry given one keeps its
  series apart, its `service` a decimal. The notification families have no `_OTHER`: a
  notification sent, heard or ended belongs to a procedure its side declared. No label is ever a
  connection, a session, a call id, a destination or a credential.
- **`outcome`** says how a call ended — `result`, `failure`, `timeout` (a call made alone),
  `cancelled`, `closed` or `error`, by the exits below — and what became of a notification, `sent`
  or `failed`. **`code`**, OpenTelemetry's `error.type`, is set on `failure` alone and on a
  subscription dropped by a failure: a protocol code by its name in section 8 of `spec/spec.md`,
  `ACCESS_DENIED`; a code section 8 names none of, `_OTHER`, `error.type`'s own fallback; a
  procedure's own failure, `application`, until a decision gives a procedure's codes their names. A
  label left out is read by Prometheus as one empty.
- **In flight is started less handled**, exact at each exposition: a family's `_handled_total` is
  written, and its counts read, before its `_started_total`, as their names order them, so the
  difference never reads below 0. No gauge is kept besides: it would read that same difference at
  the scrape, and miss what started and ended between two.

**The registry keys a procedure by its address, and holds one name for it.** A procedure is declared
as its resolver is registered; as a requester is made, through the router's `declareRequester` and
`DeclareRequester`, which give back its series; as a notification is registered, on the side that
hears; and as a notification's resolver is registered, on the side that notifies. Its service id and
procedure id key it, whichever families declare it, and the registry holds one name for it: a
declaration of an address it holds under the same name takes the same series; one that names an
address it holds under another name, or a name its service holds at another address — two names one
when they are equal once their ASCII letters are read in one case, as section 16 compares them — is
refused, as a resolver registered twice is — a `ProgrammerError` on the TypeScript side, an
`ArgumentException` on the C# side, a code on a C side — as it is made, never on a call. It holds
one revision a service, and refuses a declaration at another the same way. Its router refuses first
a declaration off section 16 ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)).

**Each family's procedures have a ceiling, and a declaration past it is refused.** A side's client
families name `maximumProcedures` procedures at most, its server families as many, its notification
families as many: 1,000 by default. A declaration that would name one more is refused as it is made,
the same way; `_OTHER`'s series are its router's, and count against none.

**Every series is made before it counts.** As a procedure is declared, the registry makes its series
at 0 in each family it is declared to — its started count; every outcome of its family, and under
`failure` each code its family's exits can end with, as the tables below list them, and in its
subscriptions dropped those codes and none; its buckets, its `_sum` and its `_count` — and, as it is
given to a router, the `_OTHER` series of that router's call families. A count then never makes a
series: an alert reads a series from its start, a rate sees the first increment, and a constrained
side counts into tables it allocated once. A route refused, a header that does not read and a
relayed call are `_OTHER`'s, so a procedure's server series take the 12 codes the other rows of the
table of a call this side answers list: the five of the admission's block,
`SUBSCRIPTION_UNSUPPORTED`, `CHUNK_INVALID`, `CREDIT_EXCEEDED`, `PAYLOAD_UNDECODABLE`,
`TRANSFER_STALLED`, `PROCEDURE_FAILED` and `application`. The side that notifies takes its two,
`CAPACITY_EXCEEDED` and `SESSION_REQUIRED`. The client families, the side that hears and `_OTHER`
take every code, section 8's 22, `application` and `_OTHER`, since a peer's answer, or a relay's,
can carry any. So a procedure takes 61 series in the server families: 44 in the histogram, its 42
buckets, its `_sum` and its `_count`; 1 started; 16 handled, `result`, `cancelled`, `closed` and
`error`, and `failure` under each of its 12 codes. It takes 74 in the client ones: 44, 1, and 29
handled, `timeout` besides and 24 codes. It takes 5 in the notification families of the side that
notifies, 2 sent, `sent` and `failed`, and 3 dropped, its two codes and none; and 26 in those of the
side that hears, 1 heard and 25 dropped, 24 codes and none.

**Every call is counted at its router's gates, and each gate is named:**

| Gate                      | Where                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server call starts      | as its request opens its call — past spec 9.2's steps 1 and 2, which answer nothing, open no call and are reported, not counted — timed from that request's arrival, so a credential's wait for its key set and a transfer's chunks fall within |
| A server call ends        | as its answer is handed to its transport — a whole answer at its own hand-off, a result sent as a transfer at its last chunk's — or as it ends unanswered; timed to that instant                                                                |
| A client call starts      | as its router's `request` takes it, once nothing makes it a programmer's error and its signal is not aborted                                                                                                                                    |
| A client call ends        | as its router settles it: its answer come whole, a refusal of its router's, its time passed, its caller's cancel, its connection gone; timed to that instant                                                                                    |
| A notification goes       | as it is handed to its transport for one subscription, at once or from its queue as a credit lets it go (11.8, 11.9), or as it cannot be                                                                                                        |
| A notification is heard   | as its router pairs it with a subscription it holds                                                                                                                                                                                             |
| A subscription is dropped | as its router ends it other than by its client's cancel, at each of its ends                                                                                                                                                                    |

An answer, or a notification, handed to its transport and then refused by it keeps what was counted
at its hand-off, and the refusal is reported (9.0). A router takes a call it makes in this order:
first what makes it a programmer's error — a timeout or a payload's limit that does not hold, a
subscription its router does not hold, a command that names no connection — and a signal aborted
already, each refused and not counted; then the call starts; then every check that can refuse it,
each ending it in the turn it started. A request whose header does not read, answered at the gate
(9.6.2), starts and ends in one turn too, under `_OTHER`.

Each call this side answers ends as one of:

| A call this side answers                                                                                                       | `outcome`   | `code`                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| its result is handed to its transport, whole or by its last chunk (9.3, 12.5)                                                  | `result`    |                                                                                       |
| its route is refused (9.2, steps 3 and 4)                                                                                      | `failure`   | `DESTINATION_UNKNOWN`, `SERVICE_UNKNOWN`, `PROCEDURE_UNKNOWN`                         |
| its credential is refused, or its verifier fails, or it would wait past the calls let wait for its issuer (9.2, step 5; 13.8)  | `failure`   | `CREDENTIAL_UNSUPPORTED`, `SESSION_REQUIRED`, `PROCEDURE_FAILED`, `CAPACITY_EXCEEDED` |
| its admission refuses it, or fails (9.2, step 5)                                                                               | `failure`   | the refusal's name, of the admission's block; `PROCEDURE_FAILED`                      |
| its subscription cannot be carried back (9.2, step 6)                                                                          | `failure`   | `SUBSCRIPTION_UNSUPPORTED`                                                            |
| its payload, or its transfer's total, past its limit, or a transfer its side takes none of (9.2, step 7; 12.3)                 | `failure`   | `PAYLOAD_TOO_LARGE`                                                                   |
| its transfer's opening refused: no byte of its payload, or its whole total (12.3)                                              | `failure`   | `CHUNK_INVALID`                                                                       |
| its transfer's opening past the transfers its connection receives at once, or past the budget left (12.3)                      | `failure`   | `CAPACITY_EXCEEDED`                                                                   |
| its request's transfer ended before its payload is whole: a chunk refused, or nothing came (12.6, 12.7)                        | `failure`   | `CHUNK_INVALID`, `CREDIT_EXCEEDED`, `TRANSFER_STALLED`                                |
| its header does not read, and it is answered (9.6.2)                                                                           | `failure`   | `ENVELOPE_MALFORMED`, `LAYOUT_UNSUPPORTED`, `ENVELOPE_TOO_LARGE`                      |
| a payload its procedure cannot read (9.5)                                                                                      | `failure`   | `PAYLOAD_UNDECODABLE`                                                                 |
| a resolver that fails before it answers, or a result its side cannot send (9.5, 12.1)                                          | `failure`   | `PROCEDURE_FAILED`                                                                    |
| a procedure's own failure, or a refusal of admission its resolver answers (9.5)                                                | `failure`   | `application`; the refusal's name                                                     |
| its subscription's queue past its bounds before its answer (11.10)                                                             | `failure`   | `CAPACITY_EXCEEDED`                                                                   |
| its result's transfer stalled, nothing coming for `transferInactivityTimeout` before its last chunk (12.7)                     | `failure`   | `TRANSFER_STALLED`                                                                    |
| a relayed call's answer: its destination's, passed on, or its relay's own (14.3, 14.5)                                         | as answered | as answered                                                                           |
| its requester cancels it, its credential resolving or not, its transfer under way or not (10.2, 12.7)                          | `cancelled` |                                                                                       |
| its connection closes, or the side is disposed (9.10, 12.10)                                                                   | `closed`    |                                                                                       |
| it ends with no answer handed to its transport — its handler fails, and its answer as failed cannot go — and is reported (9.0) | `error`     |                                                                                       |

A call whose result goes as a transfer ends at its last chunk: until then it can still end
`failure` `TRANSFER_STALLED`, `cancelled` or `closed`, and is counted so. A request that opens a
subscription and is refused in its own answer — its queue past its bounds before it, say — is that
call's `failure`, at both ends, never a subscription dropped.

Each call this side makes ends as one of:

| A call this side makes                                                                                            | `outcome`   | `code`                            |
| ----------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------- |
| it asks for `OPAQUE` and its side knows no session, before it goes (13.4)                                         | `failure`   | `SESSION_REQUIRED`                |
| it presents a credential its transport cannot carry, before it goes (13.4)                                        | `failure`   | `DESTINATION_UNREACHABLE`         |
| no call id is free (9.1)                                                                                          | `failure`   | `CAPACITY_EXCEEDED`               |
| its payload past its limit, or a transfer its side sends none of (12.1, 12.2)                                     | `failure`   | `PAYLOAD_TOO_LARGE`               |
| its header leaves its opening no byte within `chunkBytes` (12.3)                                                  | `failure`   | `ENVELOPE_TOO_LARGE`              |
| a result comes whole (9.7, 12.6), whether its requester decodes it or not                                         | `result`    |                                   |
| a failure comes (9.7), passed on by relays or not (7.5)                                                           | `failure`   | its name, `application`, `_OTHER` |
| its router ends it once it went: an answer that does not read (9.6.3), its result's transfer refused (12.3, 12.6) | `failure`   | its name                          |
| its time passes (9.9), or its transfer's inactivity (12.7, 12.8)                                                  | `timeout`   |                                   |
| its caller cancels it (10.1)                                                                                      | `cancelled` |                                   |
| its connection is not open as it starts, or closes, or the side is disposed (9.10)                                | `closed`    |                                   |
| anything else its router fails it with: a transport that refuses its request                                      | `error`     |                                   |

A call to a connection that is not open fails with the type a connection that closes fails it with,
on both sides — `DisconnectError`, `DisconnectException` — and counts alike, `closed`: the two are
one race with a close.

**The metrics count what the wire carried; the trace tells what the side made of it.** A result its
requester cannot decode came as a result, and is counted so at both ends; the trace tells the
failure. A request that opens a subscription counts as a call by its answer; what follows it is the
notifications'.

**Notifications count by role, in three families**, each at its router:

- **`bead_notifications_sent_total`**, at the side that notifies: `sent` for a notification handed
  to its transport for one subscription; `failed` for one that cannot be — too large for one envelope
  (12.1), its router disposed, a transport that throws as it is handed it — which is reported.
- **`bead_notifications_heard_total`**, at the side that hears: a notification its router pairs with
  a subscription it holds, whether it decodes or not. One under no subscription is reported, and one
  on a call id reserved dropped in silence (11.7): neither is counted.
- **`bead_subscriptions_dropped_total`**, at each end of a subscription, never from the manager's
  `dropped` event:

| End                    | A subscription dropped                                        | `code`                                           |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| the side that notifies | its queue past its bounds once it was answered (11.10)        | `CAPACITY_EXCEEDED`                              |
| the side that notifies | its session ended (13.6)                                      | `SESSION_REQUIRED`                               |
| the side that hears    | a failure on its call id once it was answered (11.7, item 2)  | the failure's: its name, `application`, `_OTHER` |
| either                 | its connection closes, or the side is disposed (11.7, item 3) |                                                  |

A client's cancel (11.7, item 1) drops nothing, at either end. A notification a later one of the same
key replaces in its queue (11.9), or one its subscription's end leaves queued, is neither sent nor
failed: that is its pacing, or that end, which the third family counts.

**Durations are whole microseconds, in A66's buckets.** A router reads its monotonic clock at a call's
start gate and at its end gate, and observes the difference with its fraction dropped: the TypeScript
side the difference of its two milliseconds times 1,000, the C# side a `TimeSpan`'s ticks over 10.
Every call that ends is observed, whatever its outcome, so a series' `_count` is the sum of its
handled counts. The buckets are A66's, its 0 included: 41 bounds and `+Inf`, 42 buckets, from 0 to
100 s. A duration of _d_ µs falls in every bucket whose bound, in microseconds, is _d_ or more: an
integer comparison, and a call the clock saw take no time falls in the bucket of 0, as a refusal in
the turn it started does under a clock that did not move. Each bound is written as its `le`,
OpenMetrics' canonical number for it (Go's `%g`, a `.0` added when it holds no point and no
exponent), the string Prometheus 3 stores whatever a target writes, so a query reads alike on
Prometheus 2 and 3. `spec/debugging.md` lists the constants, which each side writes from a table,
formatting no number as it writes:

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

A side reads its durations as finely as its platform's monotonic clock: a TypeScript side in a
browser, at the coarsening W3C High Resolution Time sets, 100 µs or 5 µs, its buckets under that
holding zeros and its `_sum` a multiple of it — a row of the support matrix. The trace keeps its
whole milliseconds (0011); its duration is the manager's, the metrics' the router's.

**`exposition()` writes the registry in [the Prometheus text exposition format, version
0.0.4](https://prometheus.io/docs/instrumenting/exposition_formats/)**, and gives its media type
with it, `text/plain; version=0.0.4; charset=utf-8`, which Prometheus 3 requires of a target, so
Grafana reads it through Prometheus. `spec/debugging.md` states its bytes:

- the families in the order of their names, each one group, its `# HELP` then its `# TYPE`; within
  one, the series by service id, then procedure id, `_OTHER` last, then `type`, `request` first, then
  `outcome` in the order `result`, `failure`, `timeout`, `cancelled`, `closed`, `error` — `sent`
  then `failed` — then `code`, none first, then by its number in section 8, `application` and
  `_OTHER` last; a histogram's buckets rising to `+Inf`, then its `_sum` and its `_count`;
- the labels in the order `service`, `procedure`, `type`, `outcome`, `code`, `le`; a label's value
  with `\`, `"` and line feed escaped, a help's with `\` and line feed, as 0.0.4 escapes them; a lone
  surrogate in a name written U+FFFD, as spec 7.4 writes a detail;
- a count, and a `_count`, in decimal; a `le` from the table above; a `_sum` from whole microseconds,
  held exactly — a `long` on the C# side, whole seconds and the microseconds under one on the
  TypeScript side, whose numbers stop being exact at 2⁵³ µs, which 1,000 calls of a second at a time
  reach in 104 days — and written as whole seconds, then, when microseconds remain, a point and their
  six digits less their trailing zeros: 10 µs `0.00001`, 2,500,000 µs `2.5`, 3,000,000 µs `3`; never
  an exponent;
- no timestamp; every line ends with a line feed, the last one too.

An application serves the text where it likes — at `/metrics`, beside its `/health` — or appends it to
its own exposition when that one is 0.0.4: Bead's families are `bead_*` alone, each one group. One
whose exposition is OpenMetrics serves Bead's at a path of its own, a second target. Bead opens no
port. One registry given to two routers sums them.

**Nothing is paid while nobody listens and no registry is given.** A call reads no clock and
allocates nothing for debugging: no step, no copy of its options or its payloads, no redacted header.
One check a call, one an envelope, is the whole cost. A side that traces reads, at a call's start,
the wall clock for `startedAt` and the monotonic one for `duration`, and the monotonic one at its
end. A side that counts reads the monotonic clock twice a call, at its router's gates, never the wall
clock, and adds to series it reaches through what it holds already — a call made, through the
`series` it carries; a call answered, through the resolver its request is routed to; a notification,
through the subscription it goes under — with no lookup of its own and no allocation.

- **Its gates** ([0006](0006-a-rule-has-its-gate.md)): each side's test clock counts its readings;
  twin tests over a manager on a fake router show a call made, a request answered, a notification
  sent and heard reading none with nobody listening, and three a call with a listener; twin tests on
  a router show a counted call reading two more than an uncounted one. On the C# side,
  `GC.GetAllocatedBytesForCurrentThread()` around a call's synchronous steps, with no `await` within
  them, shows a counted call allocating not a byte more than an uncounted one, and pins what a call
  allocates with nobody listening. The TypeScript side has no allocation count a test reads, and holds
  that part by inspection, a row of the matrix. The latency bench measures a counted call against one
  not counted, on each side.
- **Two build switches**, for a side whose platform builds that way: one leaves out the trace and the
  filter, the other the registry, each alone or both, so a 1 kHz loop that wants its dashboard builds
  the registry without the trace. The constrained profile's C side takes them as its preprocessor's,
  named in its own record. The TypeScript and C# sides build both, and pay the check alone.

**`spec/debugging.md` is a document of its own, version 0.1.0.** It holds, in numbered clauses as
`spec/spec.md` does: who conforms to it — a side that carries the protocol whole, and a constrained
profile for what it builds; what debugging is, a side's own and never the wire's; a listener's error;
the cost when off and its build switches; the trace of calls; the trace of envelopes; the filter, its
grammar, its refusals and a function's filter, under `_Debug filters: spec/debug-filters.json._`;
and the metrics — the registry, its declarations and their refusals, its ceiling, its families,
labels and values, its gates, every exit and its outcome, its buckets and their `le`, its
exposition's bytes, the series made ahead — under `_Metrics: spec/metrics.json._`. It moves as
`spec/spec.md` moves ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)): the
minor when an implementation must change to keep passing, the patch when a conforming one passes
unchanged. It names the wire's kinds and codes as `spec/spec.md` states them: a code that section
gains adds a value to `code`, and moves both minors.

**Two conformance files, one for each build switch.** A side built without the registry plays
`spec/debug-filters.json` alone, one without the trace `spec/metrics.json` alone, and the matrix says
which; the two share no harness besides. Each repeats the companion's version as its
`debuggingVersion`, and cites the companion's clauses.

- **`spec/debug-filters.json`**: fixtures of calls and envelopes, and its entries, each a filter as
  written, and either what it parses to and which fixtures it keeps, or why it is refused — a selector
  or a value empty, a value that names nothing, a word holding a parenthesis — with the value as
  written; and the steps of a filter given as a function. Its entries reach every selector, case of a
  letter and of a value, the short forms, `d(rx,tx)`, `d(rx)(tx)`, `-` alone, an exclusion that wins,
  `*` alone and across `\r` and U+2028, and the inputs where the platforms parted: U+0085, U+FEFF,
  U+00A0 and U+2028 between two names, U+212A and U+0130 in a pattern and in a value, a quote and a
  backslash in a value refused. The sentences of a refusal stay with the twin tests, as a C side
  reports a code and no English.
- **`spec/metrics.json`, one file and not two**, since what its two groups check meet in one
  exposition. Its `expositions`, each the procedures a registry is given to declare — each taken, or
  refused by a reason of the companion's, another name at its address, its name at another address,
  past the ceiling, never a sentence — the calls and notifications it counts, their outcomes, their
  codes, their microseconds, and the text it writes, byte for byte: the order, the escaping, the
  series made at 0, every `le`, the bucket of 0 and the edges of the others, the `_sum`. Its `exits`,
  each a conversation of the interop service's server given a registry, in the steps of
  `spec/conversations.json`, which it reuses, and `counted`: the series that moved since the case
  began or since the last `counted`, each by the line the exposition writes for it, with its value,
  every other series unmoved. Each player reads the exposition on its core's scheduler once the step
  before it settled. They play each exit a conversation reaches — a result, every refusal, a
  transfer's answers, a transfer stalled, cancelled or closed before its last chunk, a cancel, a
  close, a request that does not read, a subscription refused in its own answer, a relayed call at
  both of the relay's gates, a command answered, failed or timed out — with durations under the clock
  the case advances. A client's own exits that no conversation reaches — each refusal made before its
  request goes, its caller's cancel, `error` — a registry shared by two routers, and the C# side's
  threads stay with twin tests.

**`spec/check.py` holds both** ([0006](0006-a-rule-has-its-gate.md)):

- two documents, each with its version: each file repeats its own — the wire's files `specVersion`,
  from `spec/spec.md`, the companion's `debuggingVersion`, from `spec/debugging.md`;
- each file cites its own document's units, which the same `units_of` reads, and
  `spec/debugging-uncited.txt` lists those of the companion's that no entry cites, as `uncited.txt`
  lists the wire's;
- the companion's `_Debug filters:` and `_Metrics:` lines name a file of `spec/`, as `_Conversations:`
  and `_Transports:` do;
- `debug-filters` and `metrics` join the files each side's tests read whole, and their groups —
  `filters` and `sources`, `expositions` and `exits` — the groups whose entries' names are unique;
- an `exits` case's `advance` follows a timer armed, and its connections are opened before they are
  named, as a conversation's; its `counted` follows an `expect`, a `report`, an `advance` or a
  `close`, a step the server takes, never a `send` alone;
- each exposition the file pins reads as 0.0.4: its families in the order of their names, its
  buckets rising, each `le` one of the companion's constants, OpenMetrics' canonical number for its
  bound, each series' `_count` the sum of its handled counts, none started below handled.

`make_debug_filters.py` and `make_metrics.py` write the files from Python tables, as `make_clocks.py`
writes its own; the second writes each exposition by the companion's rules, a third writer of the
text beside the two sides.

### What changes on each side

| As it stands                                                                                                                                                     | What holds                                               | Why                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A separator outside ASCII: U+0085 on the C# side, U+FEFF on the TypeScript side, U+00A0 and U+2028 on both                                                       | a comma and ASCII white space alone                      | a C side matches it in a few lines, and neither platform's `\s` is another's              |
| `*` across `\r` and U+2028 on the C# side alone                                                                                                                  | any run, line terminators among them                     | a pattern says "any"                                                                      |
| Case folded by each platform: U+212A on the C# side alone, U+0130 two ways                                                                                       | ASCII alone, a name outside ASCII compared as it is      | RFC 5234's reading of a string                                                            |
| `d(rx,tx)` kept in silence as two patterns                                                                                                                       | refused, a word holding a parenthesis                    | a filter that keeps nothing says so                                                       |
| `t(request)` refused                                                                                                                                             | the trace's words, the letters kept as their short forms | one vocabulary for the trace, the filter and the metrics                                  |
| A refused value lowered (TypeScript) or bare (C#)                                                                                                                | as written, quoted as JSON                               | the words a user typed, escaped alike                                                     |
| A filter given whole refused with `rx, tx` or `Rx, Tx`, a kind as a number or a name                                                                             | the grammar's names                                      | one vocabulary                                                                            |
| The client's envelope trace without its connection (TypeScript) or with `server` (C#)                                                                            | `server` on both                                         | the TypeScript core hands it already, and drops it                                        |
| The credential's scheme inside the header (TypeScript) or beside it (C#)                                                                                         | inside the header, on both                               | the header the trace hands on is the one redacted                                         |
| `debug` and `IsDebugging`                                                                                                                                        | `isDebugging` and `IsDebugging`                          | one word, one meaning ([0003](0003-one-word-one-meaning.md)); `debug` is the event's name |
| A failed call's `rx`: three members (TypeScript), the whole failure (C#)                                                                                         | its code, its scope and its detail                       | the same fields                                                                           |
| A listener that throws fails a call that got its result, or leaves a request unanswered                                                                          | reported, the call unchanged                             | spec 9.5, and a trace never on the wire                                                   |
| A requester's procedure made anew at each call, its router told nothing as the requester is made                                                                 | a declaration, whose series each call carries            | a call made finds its series without a lookup                                             |
| A call's programmer's errors checked after some of its refusals: after its credential on the TypeScript client, after its connection on a command, on both sides | first, with an aborted signal, before the call starts    | every refusal with a code counted, alike, and none of a programmer's                      |
| The statistics                                                                                                                                                   | gone, for the registry                                   | a window of durations no scraper reads, fed through the trace                             |
| The payload a trace hands on: a copy, or the value                                                                                                               | stays a row of the matrix                                | a C# record does not change after its call                                                |
| `events('debug')`, an iterator of the emitter's, on the TypeScript side alone                                                                                    | a row of the matrix                                      | the shared emitter's, as every event of the TypeScript side has                           |

## Consequences

**The surface breaks in small places, on both sides.** The TypeScript client's envelope trace gains
its connection; `debug` becomes `isDebugging`; the C# header traced carries its scheme, and a failed
call's trace three members; a refusal's words change on one side or the other; a separator outside
ASCII no longer parts two words, a pattern no longer matches across a non-ASCII case, and `d(rx,tx)`
is refused; a listener that throws no longer fails a call; a router's request carries a requester's
series, and a router refuses a programmer's error before any refusal with a code. The statistics go,
with what they exported. The changelog says each.

**Each side reworks its hot path.** A call's start and its steps move under one check of whoever
listens, on both service managers; the TypeScript router redacts a header only for a listener; the
routers count at their gates, and take a call's programmer's errors first. A filter still runs in its
listener: a listener that keeps one procedure pays for every event built, and turning the trace on
stays a cost an application chooses.

**A registry on each side, its bytes held alike.** Each side writes the text itself, with no
dependency ([0005](0005-a-toolchain-per-language.md)). A dashboard made for OpenTelemetry's RPC
metrics reads Bead's families once its queries are rewritten: `bead` for `rpc`, `service` and
`procedure` for `rpc_method`, and its failure ratio read from `bead_*_call_handled_total` by `outcome`
and `code`, since Bead's histograms carry no `error_type`. One made for an application's 0.0.4 scrape
reads them appended. An application whose scrape is OpenMetrics, or whose platform publishes through
`System.Diagnostics.Metrics`, scrapes Bead's text apart; a `Meter` beside the registry on the C# side
is a later decision, which meets the Tenth Man.

**Series are paid for every procedure declared, failed or not.** 61 a procedure in the server
families, 74 in the client ones, the notifications' besides: 100 procedures answered make 6,100
series in a side's server families, and the ceiling, 1,000 procedures, 61,000. A peer cannot widen
any of it: a code no name covers is `_OTHER`, a procedure unknown `_OTHER`. An application cannot
pass it: a declaration past the ceiling is refused as the side is built. Each family keeps a table
of the codes its exits can end with, and no series waits at 0 for a code its exits never reach.

**A declaration can be refused.** A resolver registered, or a requester made, under a name the
registry holds at another address, at an address it holds under another name, or at another revision
of a service it holds, is refused as the side is built, and so is one off section 16, by its router
([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)).

**Latency is not split by outcome.** A histogram carries no `outcome`, which would multiply its
series by its five or six outcomes: a burst of quick refusals lowers its quantiles, and the handled
counts show the burst.

**The finest bounds are 0 and 10 µs, and the trace keeps its milliseconds.** A 1 kHz loop reads its
calls by tens to hundreds of microseconds in the metrics, its period among A66's bounds, and by whole
milliseconds in the trace, which a span bridge reads as it is. A TypeScript side in a browser reads
them at its platform's coarsening.

**The registry answers what the statistics did, as estimates.** An application that read them reads a
mean from a histogram's `_sum` and `_count`, and a quantile only as Prometheus's `histogram_quantile`
estimates one within a bucket; no minimum and no maximum. The demo's page does the same.

**A subscription dropped counts at each of its ends.** Each family of notifications sums to one
meaning; a sum of `bead_subscriptions_dropped_total` over a fleet counts a subscription once at each
end whose router has a registry, and the target a series came from tells the two ends apart.

**The constrained profile pays what it builds.** Its row in the matrix — debugging, as the
constrained profile builds it: the trace and the filter, and the registry, each in or out by its
switch; conforming to the wire either way, and to `spec/debugging.md` for what it builds — lands with
the C side. A 1 kHz loop that turns the trace off and keeps the registry pays two monotonic readings
and a few increments into static tables a counted call, and nothing more; built with neither, it
pays nothing. The TypeScript and C# sides, which build both, pay the check alone. How its
registry reaches a scraper, over its supervision link or a relay's, is the C side's to decide.

**A version axis more, and two files with their harnesses.** 0008's spec axis gains the companion:
its version in its files as `debuggingVersion`, and a release whose companion moved tags
`debugging-v` and that version. Each side reads both files whole, as `spec/clocks.json`; the exits
play on each side's conversation player, given a registry.

## What lands with this record

After 0014, in one change or in this order, each with its twin tests on both sides:

1. **`spec/debugging.md` and `spec/debug-filters.json`**: the companion at 0.1.0, its schema, its
   generator, `spec/check.py`'s second document and its lines; the trace's alignments and the
   filter's grammar on both sides, each playing the file, one test a side.
2. **A listener's error**: both sides calling each listener within a guard, and the service manager
   gaining a way to report through its router; the two twin tests that pin the opposite reversed —
   `service-manager.test.ts`'s
   `a debug listener that throws on the answer rejects the call once, with no second trace` and
   `ServiceManagerTests.A_debug_listener_that_throws_on_the_answer_fails_the_call_once_with_no_second_trace`
   — and a twin test of a request answered as a listener throws on its `rx` step.
3. **No cost when off**: both service managers and the TypeScript router reworked; the test clocks
   counting their readings; the twin tests of readings, and the C# side's of allocations.
4. **The metrics**: both registries and their exposition, the routers' gates and option, the series
   made ahead, the ceiling and the declarations' refusals; a router's surface gaining what declares a
   procedure to its registry — `declareRequester` and `DeclareRequester`, their series carried by the
   router's request as `series` and `Series`, a resolver registered saying whether its procedure
   notifies, a notification registered — and the `_OTHER` series made as a registry is given to a
   router, none of which a router has now; each router's `request` taking a call's programmer's
   errors and an aborted signal first; the subscriptions dropped counted at the router at both ends;
   `spec/metrics.json`, its schema, its generator, its harnesses on both sides; the twin tests of
   each refusal a call made meets before its request goes. The statistics go: `createDebugStatistics`,
   `IDebugStatistics`, `IDebugStatisticsOptions`, `IDurationSummary`, `DEBUG_STATISTICS_DEFAULTS` and
   `debug-statistics.ts`; `DebugStatistics`, `DebugStatisticsOptions` and `DurationSummary`; their
   seven twin tests a side.
5. **The demo**: its servers given one registry; its `stats` procedure reading it in place of the
   statistics, and its page showing the calls, their mean and a median estimated within its bucket,
   `stats`' own series left out; `/metrics` served beside `/health`, on its machine alone.
6. **The documents**: `docs/support.md`'s row "The debug filter and statistics" becomes "Debugging
   and metrics", citing `spec/debugging.md`, its cells naming every twin test — the C# client's
   envelope trace and the TypeScript server's among them — with the rows of the table above, the
   TypeScript side's allocations held by inspection, and `events('debug')`; a row "A duration read in
   a browser", a TypeScript side reading its durations at its platform's coarsening, its test giving
   a router a clock whose monotonic reading moves by 100 µs, as a browser's does
   ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)), and showing a call of 30 µs
   observed as 0 or 100, under Node, since no TypeScript test runs in a browser; 0006's table gains
   the row "Debugging costs nothing while off", with its gates; 0008's spec axis names the companion;
   the TypeScript README's statistics give way to the registry; the changelog; this record in the
   decisions' table; and the Bead page, whose statistics' example gives way to the registry, rebuilt
   and published again at its URL.

## The Tenth Man

The first draft, which held durations too, met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). Its objections, each with its
answer:

| Objection                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metrics given to the service manager cannot count most failures: the router refuses them first, and relays never reach a manager             | Accepted: a router counts at its gates, where every exit passes; the procedure is resolved from the registered resolvers, `_OTHER` for one unknown or relayed; a call answered is timed from its request's arrival; the trace stays at the manager; the record lists every exit and its outcome.                                             |
| A debug listener that throws fails a call that succeeded, or leaves a request unanswered, against spec 9.5                                   | Accepted: a listener's error is reported, as 9.0 reports, and never changes a call or the wire; both sides guard each listener; the two twin tests that pin the opposite are reversed, and one more shows a request answered as a listener throws on its `rx` step; the metrics count on a path no listener runs on.                         |
| The four families repeat the statistics' fault: round trips and handling times mixed, failures counted twice, notifications counted as calls | The user's choice: OpenTelemetry's RPC vocabulary, client and server families apart; a started counter and a handled one by outcome, in flight their difference, no gauge besides; one count of failures, by `code`; a family of its own for notifications — sent, heard, failed, dropped; the outcomes and every label's values named here. |
| Buckets finer than the measurement: whole milliseconds, truncated, into buckets of 1 ms and 2.5 ms                                           | The user's choice: whole microseconds, `_sum` an integer of them written as decimal seconds by an exact rule, buckets from 10 µs; the trace keeps its whole milliseconds. Which bounds, the second round settled.                                                                                                                            |
| Cardinality is set by the peer, not the application, and lazily created series break both alerts and the C profile                           | The user's choice: codes by their section-8 names, one fallback for a code none names, `application` for a procedure's own unless declared; every known series made at 0 as its resolver or requester is made; each family capped; `service` the service's id. The fallback's spelling and what the cap does, the second round settled.      |
| `durations.json` pins what the spec leaves free: English refusal sentences, and client defaults that no clause states                        | Accepted, and carried to 0014 by the user's choice: the file pins each outcome and its reason by a stable place id; the sentences stay with the twin tests; a default the file holds cites a clause that states it, or is marked informative, or left out; a close's timeout stays the server's until the client part decides.               |
| `debug-filters.json` settles what a procedure name is ahead of the identity-rules decision, and pins a silent trap                           | The user's choice: ASCII alone — the comma and ASCII white space part words, case folds in ASCII, a name outside ASCII compared as it is; a word holding a parenthesis that is not a selector refused; `t()` takes the trace's words, the letters kept; the ABNF references every value; the identity rules stay with their decision.        |
| "Nothing is paid when off" has a gate for clock readings only, and the 1 kHz loop is served by the build switch, not by this rework          | Accepted: no clock reading and no allocation for debugging while nobody listens and no registry is given; readings gated over a manager on a fake router, allocations on the C# side, the TypeScript side by inspection in the matrix; two build switches; a counted call's cost stated; the latency bench measures it.                      |
| The platforms' own instrumentation APIs were never weighed, and a separate Bead text cannot be appended to the application's scrape          | The user's choice: a registry of Bead's, no dependency, writing the Prometheus text format 0.0.4 and giving its media type; served at `/metrics` or appended to an application's 0.0.4 scrape; the platforms' instruments weighed in the Context and set aside; the statistics go.                                                           |
| Section 16 inside the wire spec ties debugging's changes to the version every conformance file carries                                       | The user's choice: a companion document, `spec/debugging.md`, with its own version, its files repeating it; a constrained profile that leaves debugging out conforms to the wire, sections 1 to 15, with its row in the matrix.                                                                                                              |
| The durations file is a separate decision, bundled under a debugging title                                                                   | The user's choice: durations are 0014's, landed first.                                                                                                                                                                                                                                                                                       |

The second draft met the Tenth Man again. Its objections, each with its answer:

| Objection                                                                                                                                                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bound written by the decimal rule is not the `le` Prometheus 3 stores, nor OpenMetrics' canonical number: a query copied from the scrape matches nothing | Accepted: each `le` is OpenMetrics' canonical number for its bound, a constant the companion lists and each side writes from a table; `_sum` keeps the decimal rule; `spec/metrics.json` pins the canonical strings, and `spec/check.py` checks each `le` it reads is one.                                                                                                                                                                                                                                                                                                                                              |
| A client call starts as its router draws its call id, yet the table counts exits that draw nothing and leaves refusals made before the draw uncounted      | The user's choice: a client call starts as its router's `request` takes it, before any check that can refuse it with a code; a programmer's error and a signal aborted already are taken first, and stay uncounted; every refusal after starts and ends in one turn — `SESSION_REQUIRED` and `DESTINATION_UNREACHABLE` before it goes, `ENVELOPE_TOO_LARGE`, no call id free, no connection; twin tests pin each refusal made before the request goes.                                                                                                                                                                  |
| The server table says what ends a call but not when, and three conversations already played turn on it                                                     | Accepted: the gate is named — a server call ends as its answer is handed to its transport, a whole answer at its hand-off, a transfer's at its last chunk's, and is timed to it; until then a transfer's call can end `failure` `TRANSFER_STALLED`, `cancelled` or `closed`; an answer handed off then refused keeps its count and is reported; rows for 12.7's and 12.3's answers; a subscription refused in its own answer is a call's failure, never dropped, at both ends; each player reads the exposition on its core's scheduler once the step before settled; a `counted` step follows a step the server takes. |
| "No lookup, no allocation" has no mechanism for the calls a side makes, and a relay's leg B has no count the record states                                 | Accepted: a requester's declaration gives back its series, which the manager hands to its router's `request` with each call, named alike on both sides; a call that carries none counts as `_OTHER`, never by its name nor by its address; leg B counts as `_OTHER` in client families, `command` toward a connection of the relay's, `request` through a router it calls; `spec/metrics.json` pins a relayed call's lines at both of the relay's gates.                                                                                                                                                                |
| A name labels a series while an address keys it: two declarations that agree on one and differ on the other write duplicate series, in no order            | Accepted: the registry keys a procedure by its service id and procedure id and holds one name for it; a declaration that names an address it holds under another name, or a name its service holds at another address, is refused as a resolver registered twice is, as it is made, never on a call; `spec/metrics.json` holds the refusals; the identity rules' decision may relax it.                                                                                                                                                                                                                                 |
| `bead_notifications_total` mixes two roles in one family, the fault the draft fixed for calls                                                              | The user's choice: three families — `bead_notifications_sent_total`, `sent` or `failed`; `bead_notifications_heard_total`; `bead_subscriptions_dropped_total`, by `code` — the subscriptions dropped counted at the router at both ends, never from the manager's event.                                                                                                                                                                                                                                                                                                                                                |
| `_OTHER` absorbs the ceiling's overflow, unlike the OpenTelemetry SDK it cites; A66 is misquoted; the claim about OpenTelemetry's dashboards does not hold | The user's choice: `_OTHER` for every value a label does not know, `code` included, as OpenTelemetry's `rpc.method` and `error.type` spell it; a declaration past the ceiling refused as it is made, so `_OTHER` never stands for a bound reached; A66 cited for its started counters and the bounds taken from it, never for a fallback, which it spells `other`; the dashboard claim corrected. A series is made at 0 only for a code its family's exits can end with, as the exit tables list them.                                                                                                                  |
| The 10 µs floor assumes a clock the TypeScript side lacks in a browser, with no row in the matrix; and the buckets weighed against loops at other periods  | The user's choice: A66's bounds, its 0 included — 41 bounds and `+Inf`, 61 and 74 series a procedure — so a loop at 1 kHz, 500 Hz or 250 Hz finds its period among them; a row of the matrix, a TypeScript side in a browser reading its durations at its platform's coarsening, with its test.                                                                                                                                                                                                                                                                                                                         |
