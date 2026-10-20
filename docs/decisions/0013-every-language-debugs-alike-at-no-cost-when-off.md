# 0013 — Every language traces, filters and counts its calls alike, beside the wire, at no cost when off

- **Status**: accepted
- **Scope**: a companion document, `spec/debugging.md`, with its own version, and its conformance
  files, `spec/debug-filters.json` and `spec/metrics.json`; every implementation's service manager,
  routers, debug filter and registry; the support matrix. Debugging 4.3 and 10.1 are
  [0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)'s too, and debugging 1.2,
  6.10, 7.3 and 8.3 [0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)'s.

## Context

**What each platform's matching does.** Two sides that trace, filter and count alike by parity
alone, held by twin tests over the same inputs, part wherever no twin looks, as their platforms'
regular expressions and casings do:

- a separator: .NET's `\s` takes U+0085, JavaScript's U+FEFF;
- `*`: `.` in .NET takes `\r` and U+2028, so the pattern `a*` matches a name holding either there
  alone;
- case: the pattern `key` matches a name spelled with the Kelvin sign, U+212A, under .NET's
  ignore-case alone; U+0130 lowers to two code units on one platform, and stays one on the other;
- parentheses: words parted at a comma read `d(rx,tx)` as two patterns, `d(rx` and `tx)`, which
  match nothing, in silence;
- a refusal: a value is quoted as each side's writer quotes it, lowered or as typed, a quote escaped
  or not.

A language that joins would find no grammar to read, only two implementations to copy.

**A listener's error must not cross into the call.** Spec 9.5 has a side that fails before it
answers answer `PROCEDURE_FAILED`: a listener that throws on a call's answer would turn its result
into a rejection, and one that throws on a request's step would leave the request unanswered, its
requester waiting out its timeout.

**A step names its call by a key, not by an order.** Without a call id, a trace of calls is linked
to the trace of envelopes by order and by its start. On the TypeScript side that order holds, an
HTTP batch of answers included, but it rests on the depth of a promise chain no test pins; on the
C# side it holds for one call, not across the threads that make calls. On a server, requests
received from many connections hold one id at once. Six ways were weighed: none, the order pinned
by a test, which one language cannot keep; the step told inside the router's turn, which puts a
listener on the C# router's scheduler, where one connection's listener stalls every other; the
router telling the steps, which undoes where the trace lives; the id given back by `request`,
which a timeout, a cancel and a connection gone carry none of; the id on the answer's step alone,
which leaves a call in flight to its position; and the manager telling the step once its router
drew the id, from its own flow. Chosen: the last. The field follows OpenTelemetry's
`jsonrpc.request.id`, at Development status.

**A dashboard asks**, per service and per procedure, how many calls, how many failed and why, how
long they took, and how many are under way. A gauge counts what a layer holds now, never per
procedure; health is a verdict for a probe, `application/health+json`, which no scraper reads; and a
window of the last durations, every call together, round trips and handling times mixed, answers
none of it.

**A side that runs a 1 kHz loop turns its debugging off, and off must cost nothing.** A side that
builds a step, reads a clock or copies a header before it asks whether anyone listens pays it on
every call; a filter, which runs in the listener, saves none of it.

Five ways were weighed for the surface and its counts:

- **Debugging left to each implementation**, outside the spec: free, and every language that joins
  invents its own grammar and its own words.
- **OpenTelemetry's tracing and metrics APIs**, the standard for spans and instruments: a dependency
  on every side and on a constrained profile, exporters besides, and no filter grammar. The trace
  already has a span's shape, a start on the wall clock and a duration on the monotonic one
  ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)), which a bridge can map.
- **Each platform's Prometheus client**, `prom-client` and `prometheus-net`: a dependency a side,
  each writing its exposition its own way — the order of its series, its numbers, its help — which
  no conformance file holds alike.
- **Each platform's own instruments**: .NET's `System.Diagnostics.Metrics` and `ActivitySource`, in
  its base library, which OpenTelemetry .NET, `prometheus-net` and `dotnet-counters` read; Node's
  `diagnostics_channel`, a channel a library publishes on for whoever subscribes, `hasSubscribers`
  telling whether to build a message at all. No dependency, and no work while nobody listens. But
  Node's library has a channel and no instruments, so the TypeScript side would keep its own counts
  still; a C side has neither; and what reaches a scraper is each platform's exporter's writing,
  which a conformance file could hold by names, units and buckets and never by a byte.
- **A companion document that states what a side traces, filters and counts, held by conformance
  files, and a registry of Bead's own that writes the Prometheus text format.** Chosen.

Where to count was weighed too. The service manager, where the trace is, sees a request only once
its router admitted it: a refusal of its route, its credential or its admission (spec 9.2, steps 4
to 8) and a relayed call never reach it — a server that refuses every call `ACCESS_DENIED` would
count none failed — and its clock starts once the credential resolved and the transfer came whole,
past the waits an operator looks for. Of a call it makes, it sees neither the refusals its router
makes before the request goes nor the moment the request is handed to the transport. The router's
gates see every exit, and the instant each call starts and ends. Chosen: the gates, each named.

What to write: OpenMetrics 1.0, `application/openmetrics-text; version=1.0.0`; the Prometheus text
format 0.0.4; or both, by the scraper's `Accept`. OpenMetrics ends with `# EOF` and names a
counter's family without its `_total`, so its text cannot be appended to another; 0.0.4 is what
every Prometheus scrapes, and families of distinct names append. Chosen: 0.0.4 alone. Its bounds
were weighed apart: Prometheus 3 rewrites a histogram's `le` as it ingests a scrape, whatever the
format, into OpenMetrics' canonical numbers — `le="1"` is stored as `le="1.0"` — and its migration
guide warns that alerts, recording rules and dashboards naming a bound as a whole number, `le="1"`,
stop working; a bound under 0.0001 is stored with an exponent, `le="1e-05"`; OpenMetrics 1.0
requires that form of `le`. Chosen: each `le` in OpenMetrics' canonical form, from a table of
constants.

How to cut the families: one family a measure, a `direction` label parting the calls a side makes
from those it answers, mixes round trips with handling times, and counts a failure twice.
OpenTelemetry's semantic conventions for RPC, a Release Candidate, keep `rpc.client.call.duration`
and `rpc.server.call.duration` apart, and gRPC's A66 counts `grpc.client.attempt.started` and
`grpc.server.call.started`, so that what is under way is what started less what ended. Notifications
part the same way, by role: OpenTelemetry's messaging conventions keep
`messaging.client.sent.messages` and `messaging.client.consumed.messages` apart, and Prometheus's
naming guide asks that a sum or a mean over every label of a family mean something, which
notifications sent and heard, and subscriptions dropped at both ends, never do summed together.
Chosen: that vocabulary, calls and notifications alike.

What a label holds for a value it does not know: OpenTelemetry's `_OTHER`, the fallback of
`rpc.method` for a method a server does not recognize and of `error.type` (Stable); A66's `other`,
in lower case, for a method not registered. Chosen: `_OTHER`, on every label, `code` included.

What a side does past its ceiling: an OpenTelemetry SDK folds the attribute sets past its
cardinality limit into one overflow set, `otel.metric.overflow` (Stable), which no value of a label
stands for. A side's procedures are known as it is built, and a C side's once it is compiled.
Chosen: a declaration past the ceiling refused as it is made, so `_OTHER` means a value not known,
never a bound reached.

How fine: OpenTelemetry's recommended buckets start at 5 ms, and the trace's whole milliseconds, a
fraction dropped, put every call under 2 ms in the first bucket and add nothing to `_sum` for a call
under one: a 1 kHz loop reads a mean of 0 s. Node and .NET read the monotonic clock finer than that;
a browser coarsens it to 100 µs, or 5 µs once cross-origin isolated ([W3C High Resolution
Time](https://www.w3.org/TR/hr-time-3/)). Two lists from 10 µs were weighed: a 1, 2.5, 5 progression
to 10 s, 19 bounds, as Prometheus's own default runs above 5 ms; and A66's, 41 bounds from 0 to 100
s, which has a bound at 1, 2, 3, 4, 5, 6, 8 and 10 ms where the first has 1, 2.5, 5 and 10. Both
count a 1 kHz loop's overruns past 1 ms exactly; A66's alone has a loop at 500 Hz or 250 Hz find its
period among its bounds, and estimates a quantile near 1 ms within 200 µs, where the first does
within 500. Chosen: whole microseconds, A66's bounds, its 0 included.

For the filter's grammar: the `debug` package's `DEBUG` as it is — names parted by commas or white
space, `*` for any run, `-` to leave a name out — matches names case-sensitively, parts them on
JavaScript's `\s`, which reaches past ASCII, and has no way to keep a direction, a type of call or a
kind of envelope. Chosen: `DEBUG`'s words, three selectors of Bead's, written in ABNF, in ASCII.

Where it lives: a section of `spec/spec.md` itself would tie a changed bucket or a filter's refusal
to the version every wire file repeats, and tag a `spec-v*`, for what never crosses the wire.
Chosen: a companion document, `spec/debugging.md`, with its own version.

## Decision

**Debugging is a side's own, and never the wire's** (debugging 1 and 2). A side that carries the
protocol whole traces its calls and its envelopes, filters both, and counts its calls and its
notifications; nothing it traces, filters or counts goes on the wire, and a peer never knows whether
it listens. A constrained profile may leave the trace and the filter out, or the metrics, or both,
at build time, and conforms to `spec/spec.md` either way, by debugging 1.2: what it leaves out is a
row of the support matrix, not a difference of the protocol.

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
| A step's call          | `IDebugEvent`'s `callId` and `connectionHandle`; the router's request's `onCallId`        | `DebugEvent.CallId`, `DebugEvent.ConnectionHandle`; `RouterRequest.OnCallId`                       |

`metricsRegistry` and `MetricsRegistry` are a router's option, which the servers and clients that
build a router pass on. The registry is not `Metrics`: `prometheus-net`'s static class of that name
would make a bare one ambiguous (CS0104) in an application that uses both, which
[0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) avoids. A requester's series
is the handle its declaration gives back, which the manager hands to its router's `request` with
each call: `declareRequester` and `DeclareRequester` give it, `IProcedureSeries` and
`ProcedureSeries`, and the router's request carries it as `series` and `Series`.

**The trace of calls and the trace of envelopes tell each step**, at the service manager and at the
router, with the same fields on every side, as debugging 4 and 5 state. A call's options are traced
with their defaults applied and its credential left out, and an envelope's header with its
credential's scheme in place of its credential, so the header a trace hands on is the one redacted.
A client's trace of envelopes names its connection, `server`, as a server's names each of its own. A
call's `startedAt` is on the wall clock and its `duration` whole milliseconds on the monotonic
reading ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)). Each step of a call
names it as its envelopes do, `callId` and `connectionHandle`, `server` on a client: a call made
once its router drew its id, which the router's `request` hands its manager through `onCallId`,
`OnCallId`; a request received by its header's. The manager tells a call's `tx` step from its own
flow once it holds the id, never from its router's turn. A call refused before its id is drawn names
none, and neither does a notification, sent or heard (debugging 4.1, 4.2, 4.4). An error on a `tx`
step says its `tx` did not go out, and why, for an answer as for a notification: an answer its
router could not send is told again at its start with its error; an answer to a request its router
already answered in its resolver's place, its subscription's queue past its bounds (spec 11.10), is
told once, as its resolver answers, with the failure its router answered, which the router holds for
its manager from the moment it answers in the resolver's place, `answeredOf`, `AnsweredOf`; and a
resolver that failed before it answered tells a step of no answer with what it failed with. On the
C# side, an answer that goes to its router as that router answers in the resolver's place, on its
own thread, is told again at its start with the router's failure, as one its router could not send
is. What goes in their place, `PROCEDURE_FAILED` or the router's own failure, is the envelopes' to
tell. So a span a bridge makes of the step takes its status from what the call returned, as
OpenTelemetry's RPC conventions set it. A call answered nothing tells no failure (debugging 4.2,
4.3).

**A listener's error never changes a call** (debugging 2.2 and 2.3). It is reported, as spec 9.0
reports an error, through the router's `error` event, `Error`; the call goes on as if nobody
listened, its outcome, its answer and what goes on the wire the same. Both sides call each listener
within a guard, and count on a path no listener runs on.

**The filter is `DEBUG`'s words, three selectors of Bead's, in ASCII** (debugging 6), its grammar in
ABNF ([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234), whose quoted strings are case-insensitive,
in US-ASCII alone). Each of its choices has its reason:

- a comma, and the six characters C's `isspace` reads as white space in the C locale, part two
  words, and nothing outside ASCII does: a C side matches it in a few lines, and neither platform's
  `\s` is another's;
- `*` stands for any run of characters, line terminators among them: a pattern says "any";
- a selector, and an ASCII letter of a pattern, is read without regard to case in ASCII alone, and a
  name outside ASCII is compared as it is, code point by code point: RFC 5234's reading of a string;
- a word holding a parenthesis that is no selector is refused, `d(rx,tx)` among them: a filter that
  keeps nothing says so;
- `t(…)` takes the trace's words, `request`, `command` and `notification`, with `r`, `c` and `n` as
  their short forms: one vocabulary for the trace, the filter and the metrics;
- a refusal names the value or the word as it was written, quoted as JSON writes a string ([RFC
  8259](https://www.rfc-editor.org/rfc/rfc8259)): the words a user typed, escaped alike; and a
  filter given whole is refused in the grammar's names, one vocabulary again.

The filter compares the names it is given, whatever they hold: section 16 of `spec/spec.md` states
what a procedure's name holds
([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)), and every such name
is a pattern the filter reads.

**A registry counts what its side declares, for a router given one** (debugging 7 to 12), and writes
its text itself, with no dependency ([0005](0005-a-toolchain-per-language.md)). Each of its choices
has its reason:

- **its families** take OpenTelemetry's semantic conventions for RPC ([Release
  Candidate](https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/)), named as a Prometheus
  name is written, `bead` in place of `rpc` so they never meet an application's own `rpc_*` families
  in one scrape; the started counters follow gRPC's
  [A66](https://github.com/grpc/proposal/blob/master/A66-otel-stats.md); and the notifications part
  by role, three families, as OpenTelemetry's messaging conventions do, so a sum over every label of
  a family means something (debugging 8 and 10);
- **client and server are a call's roles**, as OpenTelemetry's span kinds are: `bead_client_*`
  counts the calls a side makes, and `bead_server_*` those it answers, whatever the side;
- **in flight is started less handled**, exact within each series at its reading, and no gauge is
  kept besides: it would read that same difference at the scrape, and miss what started and ended
  between two (debugging 8.5). A registry reads each series' counts once, its handled before its
  started, and writes every line of it from that reading, so its `_count` is the sum of its handled
  counts (debugging 11.2); across series, a side that counts from several threads reads each at its
  own instant, as Prometheus's client libraries collect;
- **a value a label does not know is `_OTHER`**, on every label, `code` included, as OpenTelemetry's
  `rpc.method` and `error.type` spell it; no label is ever a connection, a session, a call id, a
  destination or a credential (debugging 8);
- **a procedure is keyed by its address, and the registry holds one name for it**: a declaration
  that names an address it holds under another name, or a name its service holds at another address,
  is refused as it is made, as a resolver registered twice is, never on a call; one of its service
  at another revision takes the same series, since no label carries a revision and Prometheus
  identifies a series by its name and its labels (debugging 7.3);
- **each family's procedures have a ceiling**, `maximumProcedures`, 1,000 by default, and a
  declaration past it is refused as it is made, so `_OTHER` means a value not known, never a bound
  reached (debugging 7.4);
- **every series is made before it counts**, at 0, for each code its family's exits can end with: an
  alert reads a series from its start, a rate sees the first increment, and a constrained side
  counts into tables it allocated once (debugging 7.5 to 7.7);
- **every call is counted at its router's gates**, which see every exit and the instant each call
  starts and ends, each gate named and each exit given its outcome and its code (debugging 9); a
  router takes a call's programmer's errors and an aborted signal first, uncounted, so every refusal
  with a code is counted alike;
- **the metrics count what the wire carried, and the trace tells what the side made of it**
  (debugging 9.8);
- **durations are whole microseconds, in A66's buckets**, its 0 included, each bound written as its
  `le`, OpenMetrics' canonical number for it, from a table of constants: the string Prometheus 3
  stores whatever a target writes, so a query reads alike on Prometheus 2 and 3 (debugging 11);
- **the exposition is the Prometheus text format 0.0.4**, its bytes stated to the last line feed,
  given with its media type, `text/plain; version=0.0.4; charset=utf-8` (debugging 12): every
  Prometheus scrapes it, and Bead's families, `bead_*` alone, append to an application's own 0.0.4
  exposition. Bead opens no port.

**Nothing is paid while nobody listens and no registry is given** (debugging 3). One check a call,
one an envelope, is the whole cost. A side that counts reads the monotonic clock twice a call, at
its router's gates, never the wall clock, and adds to series it reaches through what it holds
already, with no lookup of its own and no allocation. Where Bead goes
([the index](README.md#where-bead-goes)), a counted call is measured against one not counted, on
each side, a measure beside those the benches take ([the root README](../../README.md#measurement)),
and it gates nothing: what the clause bounds, the readings and the allocations, its gates hold.

- **Its gates** ([0006](0006-a-rule-has-its-gate.md)): each side's test clock counts its readings;
  twin tests over a manager on a fake router show a call made, a request answered, a notification
  sent and heard reading none with nobody listening, and three a call with a listener; twin tests on
  a router show a counted call reading two more than an uncounted one. On the C# side,
  `GC.GetAllocatedBytesForCurrentThread()` around a call's synchronous steps, with no `await` within
  them, shows a counted call allocating not a byte more than an uncounted one, and pins what a call
  allocates with nobody listening. The TypeScript side has no allocation count a test reads, and
  holds that part by inspection, a row of the matrix.
- **Two build switches**, for a side whose platform builds that way: one leaves out the trace and
  the filter, the other the registry, each alone or both, so a 1 kHz loop that wants its dashboard
  builds the registry without the trace. A C side takes them as its preprocessor's, in its own
  record. The TypeScript and C# sides build both, and pay the check alone.

**The companion is a document of its own, with a version of its own**
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)), and two conformance files,
one for each build switch, which a side built without the other plays alone:
`spec/debug-filters.json` pins every filter's reading and refusal, and `spec/metrics.json` every
exposition, byte for byte, and every exit a conversation reaches, each played as
[0004](0004-one-behaviour-in-every-language.md) has every conformance file played. The sentences of
a refusal, a client's own exits that no conversation reaches, a registry shared by two routers and
the C# side's threads stay with twin tests.

## Consequences

**A call made is told once its id is drawn.** On the TypeScript side its `tx` step comes in the
caller's turn, after its REQUEST is traced; a deprecated procedure's `deprecated` comes before it.
The call has started by then, so a `tx` listener's synchronous work counts in its duration when it
outlasts the round trip, as any work of the caller's turn does. On the C# side the step is told
once the id is heard, off the caller's thread unless its router drew the id before the manager
awaits it: steps of calls made from one thread come in no order among themselves, and a listener
counts on no caller's stack. A listener never runs on a router's scheduler.

**A step's call id is the wire's, and lives as long as its call.** A reader keys a step and its
envelopes by connection and call id between the call's opening and its end; a log longer than a
call id's turn sees an id again.

**The hook costs one empty reference a call.** The request a manager hands its router carries
`onCallId`, empty while nobody listens, as it carries the series of the registry: 8 bytes a call
on .NET, about 6 a literal on V8.

**A filter runs in its listener**: a listener that keeps one procedure pays for every event built,
and turning the trace on is a cost an application chooses.

**A registry on each side, its bytes held alike.** Each side writes the text itself, with no
dependency ([0005](0005-a-toolchain-per-language.md)). A dashboard made for OpenTelemetry's RPC
metrics reads Bead's families once its queries are rewritten: `bead` for `rpc`, `service` and
`procedure` for `rpc_method`, and its failure ratio read from `bead_*_call_handled_total` by
`outcome` and `code`, since Bead's histograms carry no `error_type`. One made for an application's
0.0.4 scrape reads them appended. An application whose scrape is OpenMetrics, or whose platform
publishes through `System.Diagnostics.Metrics`, scrapes Bead's text apart; a `Meter` beside the
registry on the C# side is a decision of its own, which meets the Tenth Man.

**Series are paid for every procedure declared, failed or not.** 61 a procedure in the server
families, 74 in the client ones, the notifications' besides: 100 procedures answered make 6,100
series in a side's server families, and the ceiling, 1,000 procedures, 61,000. A peer cannot widen
any of it: a code no name covers is `_OTHER`, a procedure unknown `_OTHER`. An application cannot
pass it: a declaration past the ceiling is refused as the side is built. Each family keeps a table
of the codes its exits can end with, and no series waits at 0 for a code its exits never reach.

**A declaration can be refused.** A resolver registered, or a requester made, under a name the
registry holds at another address, or at an address it holds under another name, is refused as the
side is built, and so is one off section 16, by its router
([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)). Two revisions of one
service in one process, two generated copies of it say, count into the same series.

**One reading costs a series' counts copied.** The C# side copies each series' counts into a
snapshot at each exposition while its threads go on counting, and writes the series' lines from it;
the TypeScript side reads on one thread, so its reading is one already.

**Latency is not split by outcome.** A histogram carries no `outcome`, which would multiply its
series by its five or six outcomes: a burst of quick refusals lowers its quantiles, and the handled
counts show the burst.

**The finest bounds are 0 and 10 µs, and the trace keeps its milliseconds.** A 1 kHz loop reads its
calls by tens to hundreds of microseconds in the metrics, its period among A66's bounds, and by
whole milliseconds in the trace, which a span bridge reads as it is. A TypeScript side in a browser
reads them at its platform's coarsening.

**A mean and a quantile are estimates**: a mean from a histogram's `_sum` and `_count`, a quantile
as Prometheus's `histogram_quantile` estimates one within a bucket, and no minimum or maximum. The
demo's page reads them so.

**A subscription dropped counts at each of its ends.** Each family of notifications sums to one
meaning; a sum of `bead_subscriptions_dropped_total` over a fleet counts a subscription once at each
end whose router has a registry, and the target a series came from tells the two ends apart. Each
end counts it under the code of the failure that ended it, whatever that code: the side that
notifies ends one with the failure its application chooses (spec 11.7, item 2), as the side that
hears receives one, so both ends' series take every code and the count follows the wire.

**A constrained profile pays what it builds**: its row of the matrix is "not available" on the
TypeScript and C# sides, which build both. A 1 kHz loop that turns the trace off and keeps the
registry pays two monotonic readings and a few increments into static tables a counted call, and
nothing more; built with neither, it pays nothing. How its registry reaches a scraper, over its
supervision link or a relay's, is the C side's to decide.

**The companion's version is an axis of
[0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)'s**: its files repeat it as
`debuggingVersion`, and a release whose companion moved tags `debugging-v` and that version.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
six rounds. A closing connection's teardown, with debugging 9.7 and an exit of
`spec/metrics.json`, met it in [0001](0001-the-envelope-sits-at-fixed-offsets.md)'s round, which
keeps its objections and answers. Its objections, each with the answer that holds:

### The first round

| Objection                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metrics given to the service manager cannot count most failures: the router refuses them first, and relays never reach a manager             | Accepted: a router counts at its gates, where every exit passes; the procedure is resolved from the registered resolvers, `_OTHER` for one unknown or relayed; a call answered is timed from its request's arrival; the trace stays at the manager; the companion lists every exit and its outcome.                                                                                                           |
| A debug listener that throws fails a call that succeeded, or leaves a request unanswered, against spec 9.5                                   | Accepted: a listener's error is reported, as 9.0 reports, and never changes a call or the wire; both sides guard each listener, and twin tests show a call unchanged and a request answered as a listener throws on its `rx` step; the metrics count on a path no listener runs on.                                                                                                                           |
| The four families repeat the statistics' fault: round trips and handling times mixed, failures counted twice, notifications counted as calls | Chosen, as the Context weighs it: OpenTelemetry's RPC vocabulary, client and server families apart; a started counter and a handled one by outcome, in flight their difference, no gauge besides; one count of failures, by `code`; a family of its own for notifications — sent, heard, failed, dropped; the outcomes and every label's values named here.                                                   |
| Buckets finer than the measurement: whole milliseconds, truncated, into buckets of 1 ms and 2.5 ms                                           | Chosen, as the Context weighs it: whole microseconds, `_sum` an integer of them written as decimal seconds by an exact rule, in A66's buckets (the second round); the trace keeps its whole milliseconds.                                                                                                                                                                                                     |
| Cardinality is set by the peer, not the application, and lazily created series break both alerts and the C profile                           | Chosen, as the Context weighs it: codes by their section-8 names, one fallback for a code none names, `application` for a procedure's own unless declared; every known series made at 0 as its resolver or requester is made; each family capped; `service` the service's id; the fallback is `_OTHER`, and a declaration past the cap is refused (the second round).                                         |
| `durations.json` pins what the spec leaves free: English refusal sentences, and client defaults that no clause states                        | Accepted, in [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s file: it pins each outcome and its reason by a stable place id; the sentences stay with the twin tests; a default the file holds cites a clause that states it, or is marked informative, or left out; a close's timeout stays the server's until the client part decides.                                              |
| `debug-filters.json` settles what a procedure name is ahead of the identity-rules decision, and pins a silent trap                           | Chosen, as the Context weighs it: ASCII alone — the comma and ASCII white space part words, case folds in ASCII, a name outside ASCII compared as it is; a word holding a parenthesis that is not a selector refused; `t()` takes the trace's words, the letters kept; the ABNF references every value; the identity rules are [0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)'s. |
| "Nothing is paid when off" has a gate for clock readings only, and the 1 kHz loop is served by the build switch, not by this rework          | Accepted: no clock reading and no allocation for debugging while nobody listens and no registry is given; readings gated over a manager on a fake router, allocations on the C# side, the TypeScript side by inspection in the matrix; two build switches; a counted call's cost stated, and its measure where Bead goes.                                                                                     |
| The platforms' own instrumentation APIs were never weighed, and a separate Bead text cannot be appended to the application's scrape          | Chosen, as the Context weighs it: a registry of Bead's, no dependency, writing the Prometheus text format 0.0.4 and giving its media type; served at `/metrics` or appended to an application's 0.0.4 scrape; the platforms' instruments weighed in the Context and set aside.                                                                                                                                |
| Section 16 inside the wire spec ties debugging's changes to the version every conformance file carries                                       | Chosen, as the Context weighs it: a companion document, `spec/debugging.md`, with its own version, its files repeating it; a constrained profile that leaves debugging out conforms to the wire, with its row in the matrix.                                                                                                                                                                                  |
| The durations file is a separate decision, bundled under a debugging title                                                                   | Accepted: durations are [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s.                                                                                                                                                                                                                                                                                                             |

### The second round

| Objection                                                                                                                                                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bound written by the decimal rule is not the `le` Prometheus 3 stores, nor OpenMetrics' canonical number: a query copied from the scrape matches nothing | Accepted: each `le` is OpenMetrics' canonical number for its bound, a constant the companion lists and each side writes from a table; `_sum` keeps the decimal rule; `spec/metrics.json` pins the canonical strings, and `spec/check.py` checks each `le` it reads is one.                                                                                                                                                                                                                                                                                                                                              |
| A client call starts as its router draws its call id, yet the table counts exits that draw nothing and leaves refusals made before the draw uncounted      | Chosen: a client call starts as its router's `request` takes it, before any check that can refuse it with a code; a programmer's error and a signal aborted already are taken first, and stay uncounted; every refusal after starts and ends in one turn — `SESSION_REQUIRED` and `DESTINATION_UNREACHABLE` before it goes, `PAYLOAD_TOO_LARGE`, no call id free, no connection; twin tests pin each refusal made before the request goes.                                                                                                                                                                              |
| The server table says what ends a call but not when, and three conversations already played turn on it                                                     | Accepted: the gate is named — a server call ends as its answer is handed to its transport, a whole answer at its hand-off, a transfer's at its last chunk's, and is timed to it; until then a transfer's call can end `failure` `TRANSFER_STALLED`, `cancelled` or `closed`; an answer handed off then refused keeps its count and is reported; rows for 12.7's and 12.3's answers; a subscription refused in its own answer is a call's failure, never dropped, at both ends; each player reads the exposition on its core's scheduler once the step before settled; a `counted` step follows a step the server takes. |
| "No lookup, no allocation" has no mechanism for the calls a side makes, and a relay's leg B has no count the record states                                 | Accepted: a requester's declaration gives back its series, which the manager hands to its router's `request` with each call, named alike on both sides; a call that carries none counts as `_OTHER`, never by its name nor by its address; leg B counts as `_OTHER` in client families, `command` toward a connection of the relay's, `request` through a router it calls; `spec/metrics.json` pins a relayed call's lines at both of the relay's gates.                                                                                                                                                                |
| A name labels a series while an address keys it: two declarations that agree on one and differ on the other write duplicate series, in no order            | Accepted: the registry keys a procedure by its service id and procedure id and holds one name for it; a declaration that names an address it holds under another name, or a name its service holds at another address, is refused as a resolver registered twice is, as it is made, never on a call; `spec/metrics.json` holds the refusals; [0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md) keeps "another name at its address" exact and folds "its name at another address" (debugging 7.3).                                                                                             |
| `bead_notifications_total` mixes two roles in one family, the fault the draft fixed for calls                                                              | Chosen, as the Context weighs it: three families — `bead_notifications_sent_total`, `sent` or `failed`; `bead_notifications_heard_total`; `bead_subscriptions_dropped_total`, by `code` — the subscriptions dropped counted at the router at both ends, never from the manager's event.                                                                                                                                                                                                                                                                                                                                 |
| `_OTHER` absorbs the ceiling's overflow, unlike the OpenTelemetry SDK it cites; A66 is misquoted; the claim about OpenTelemetry's dashboards does not hold | Chosen, as the Context weighs it: `_OTHER` for every value a label does not know, `code` included, as OpenTelemetry's `rpc.method` and `error.type` spell it; a declaration past the ceiling refused as it is made, so `_OTHER` never stands for a bound reached; A66 cited for its started counters and the bounds taken from it, never for a fallback, which it spells `other`; a dashboard made for OpenTelemetry's RPC metrics reads Bead's families once its queries are rewritten. A series is made at 0 only for a code its family's exits can end with, as the exit tables list them.                           |
| The 10 µs floor assumes a clock the TypeScript side lacks in a browser, with no row in the matrix; and the buckets weighed against loops at other periods  | Chosen, as the Context weighs it: A66's bounds, its 0 included — 41 bounds and `+Inf`, 61 and 74 series a procedure — so a loop at 1 kHz, 500 Hz or 250 Hz finds its period among them; a row of the matrix, a TypeScript side in a browser reading its durations at its platform's coarsening, with its test.                                                                                                                                                                                                                                                                                                          |

### On the bench

| Objection                                                                                                                                             | Answer                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The latency bench is a gate in this record and in the decisions' README, not in 0006's gates owed, and the change strikes it from the companion alone | Accepted: no clause of section 3 states a threshold a bench could fail on, so it measures and gates nothing. It leaves the companion's 3.4 and this record's gates together, stays here as what a bench measures, and the README names it under "Where Bead goes". |

### On the call id

| Objection                                                                                                                                                                                                                                       | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two calls to one procedure, started in one millisecond and answered in one HTTP batch, are told apart by nothing; on the TypeScript side they are linked by position, and on the C# side order is lost only across threads                      | Accepted: the batch is linked by position on the TypeScript side, under a promise chain no test pins; on the C# side one call's step comes before its request. The Context states the need as a key in place of an order, and weighs pinning the order by a test, which one language cannot keep.                                                                                                                                                                                                                                                     |
| The id on the answer's step alone is refused for leaving calls in flight unlinked, yet it closes the batch, and the standard a step maps to needs the id only once the call ends                                                                | Accepted in part: the id on the answer's step alone closes the batch and moves nothing, and a panel links a call in flight by its turn; it is weighed fairly, and loses to the manager telling the step once its router drew the id, which names every step at the same cost while nobody listens and links a call in flight across threads for a reader of C# logs. `jsonrpc.request.id` is an attribute set any time before its span ends, which favours neither.                                                                                   |
| Telling the step inside `OnCallId` puts it on the C# router's scheduler, which keeps application code off on purpose: one slow listener stalls every connection of a server, and one that makes a blocking call on the same router deadlocks it | Accepted: the step is never told inside the router's turn. The manager tells it from its own flow; a task source made with `RunContinuationsAsynchronously` keeps its continuation off the scheduler, and a C# test pins it.                                                                                                                                                                                                                                                                                                                          |
| Debugging 4.4's order sentence forces the step told inside the router's turn, and telling it from the manager's own flow once the id is drawn is never weighed                                                                                  | Accepted: the manager's own flow is the decision. Debugging 4.4 states that a call names its call once its id is drawn and that its `tx` step comes before its `rx` step, no order against its envelope; the twin test asserts the id, not the order. On the TypeScript side the step comes in the caller's turn, after its REQUEST, in the order the calls were made.                                                                                                                                                                                |
| Told inside the core, a listener's work counts in the call's duration, a listener's call re-enters mid-call, refused calls lose their order, and a caller's stack sits under the core's frames                                                  | Accepted in part: told from the manager's own flow, the step avoids the re-entry, the reorder and the deeper stack on the TypeScript side. The counted duration still spans a `tx` listener's synchronous work when it outlasts the round trip, since the call has started; the Consequences say so. On the C# side the step is told off the caller's thread unless its router drew the id first, unordered across calls, with no caller's stack to count on; said too. `deprecated` comes before the `tx` step on both sides, pinned by a twin test. |
| A `tx` step told only on failure is lost on success over a router that draws no id; an absent id means three things; a panel's fallback for an older Bead covers none                                                                           | Accepted: the manager tells the `tx` step at one place on every path, named or not. `IRouterLike`'s doc states the router's duty on both sides; a notification names none by its type; the extension keeps no fallback, and the hook's protocol stays 1.                                                                                                                                                                                                                                                                                              |
| `connectionHandle` is no option once each step names its call: a server's step without its connection names nothing; and the reason given covers only requests received                                                                         | Accepted: `connectionHandle` is part of the decision, for a server's steps and to key a client's as its envelopes are. The Context limits "one id open on many connections" to requests received; a server's commands draw from one sequence for the router on both sides.                                                                                                                                                                                                                                                                            |
| The cost while nobody listens is not none: the request handed to the router gains a field on every call, which a reflection check cannot see                                                                                                    | Accepted: one empty reference a call, 8 bytes on .NET and about 6 a literal on V8, as the series is paid; debugging 3.1 says so. The C# allocation gate is pinned absolute, which sees a field and a display class alike.                                                                                                                                                                                                                                                                                                                             |
| The id of a notification heard buys nothing and changes two public interfaces: a client holds one notification per procedure, bound to one call at a time                                                                                       | Accepted: a notification heard names no call, and `trigger`, `Trigger` stay as they are; a reader keys it by its source and its procedure, whose subscribing call names the id.                                                                                                                                                                                                                                                                                                                                                                       |
| The bytes of an envelope are a second decision bundled into this one                                                                                                                                                                            | Accepted: they are left to a decision of their own, when the panel's view of exchanges needs them.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| No standard is named for the field                                                                                                                                                                                                              | Accepted: the field follows OpenTelemetry's `jsonrpc.request.id`, at Development status, named in the Context, the nearest convention for a wire's own request id on an RPC span; Bead is not JSON-RPC, and a bridge writes the id as its string.                                                                                                                                                                                                                                                                                                     |

### On the conformance before 0.2.0

| Objection                                                                                                                                                                       | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A resolver that fails on its signal, its call cancelled, or under a disposed router, tells a failure step for a call answered nothing (spec 9.4)                                | Accepted: the manager holds the call's signal and tells a failure step only while it is not aborted, the C# side's token riding in what it answers with, within decision 0007's two parameters, as the router reports nothing for an aborted call's failure; debugging 4.2 says a call answered nothing tells no failure, and a twin test on each side holds it. The C# side posts its cancellation to its resolvers' scheduler, which leaves a window of one turn: a callback that fails for a reason of its own within it tells a step whose `PROCEDURE_FAILED` its router drops, a step that tells what the resolver did. |
| An answer told, then a second answered step with another `tx`, gives one call two answers, and an error on a `tx` step one meaning for a notification and another for an answer | Accepted: one meaning, the notification's: an error on a `tx` step says its `tx` did not go out, and why. An answer its router refuses is told again at its start with its error; a resolver that failed before it answered tells a step of no answer with its error; the `PROCEDURE_FAILED` in their place is the trace of envelopes' to tell. Telling the answer once its router took it, the other way weighed, would move every answer's step after its send and into its duration, a change of every call's trace.                                                                                                      |
| The notifying side's new row rests on no clause, and `dropSubscriptions` sends a protocol code that a resolver's answer refuses                                                 | Accepted in part: spec 11.7, item 2, names the failure an application ends a subscription with, and debugging 10.3's row cites it. `dropSubscriptions`, `DropSubscriptions`, takes every code, as the side that hears receives one, spec 8.1 reading a code it does not name as a number: the notifying side's series take the 24 codes, `_OTHER` among them, made at 0 as its procedure is declared, with no record of the series made. Refusing a protocol code section 8 does not name, as a resolver's answer is refused one, is weighed and left.                                                                       |
| A closure made for every request, while nobody listens, breaks debugging 3.1                                                                                                    | Accepted: no closure a request makes; each step is told behind the check that someone listens, the C# side building its answer's step in a method of its own, outside its asynchronous send, so that a request allocates nothing more, its gate's pin unmoved.                                                                                                                                                                                                                                                                                                                                                               |
| A guard that reads a string's tokens alone misses an f-string's literal text, which Python's tokenizer gives apart                                                              | Accepted: the debug filters' generator holds every string it writes to ASCII, a character outside it as its escape, reading an f-string's and a t-string's literal parts where its tokenizer has them; an entry that names a code point holds it, and so does each fixture whose comment names one, by its index.                                                                                                                                                                                                                                                                                                            |

### On the companion's 0.2.0

The round that [0004](0004-one-behaviour-in-every-language.md),
[0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md),
[0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)
and
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)
share, at xhigh effort, met the trace's failure answered in a resolver's place, the one reading of
each series and the series a second revision counts into, and put no objection to them; its
objections are those records'. Each of the three rests on a standard, and none was put to the user:
a span's status set from the status its call returned, OpenTelemetry's RPC conventions; each metric
collected at its own instant, Prometheus's client libraries; and a series identified by its name and
its labels, Prometheus's.
