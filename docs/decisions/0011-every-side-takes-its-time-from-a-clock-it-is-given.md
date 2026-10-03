# 0011 — Every side takes its time from a clock it is given

- **Status**: accepted
- **Scope**: every implementation, the conformance files and their harnesses

## Context

Bead times a great deal: a call waits 5 seconds for its answer, a call id stays reserved as long, a
transfer stalls after 30, a session and a connection end once idle, an HTTP exchange gives up after
5 minutes, a listen is held 30 seconds, a cancel that comes before its request is buried 5, a client
waits between listens and between connections. The typed credential
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)) adds instants from outside: a token's
`exp` and `nbf`. The conformance files state those rules
([0004](0004-one-behaviour-in-every-language.md)), and a case that waits on the real clock for one
passes or fails with the machine's load: a 5-minute timeout is never played, and a 30-second one
costs the run its time.

The C# side takes its time from a `TimeProvider`, .NET's own type, on most of its timers, and its
tests advance a `FakeTimeProvider`. The TypeScript side takes it from the globals, which its tests
replace in place, file by file. Neither reaches all of its own timers, and the two test clocks
already disagree on what advancing means: one fires every timer due at the end of the advance, the
other steps from due to due.

Three ways were weighed:

- **A fake clock installed on the globals of the TypeScript harness**, as `@sinonjs/fake-timers`'
  `install()` does, changes no surface, and moves every library on the globals with Bead —
  `node:http`'s timeouts, `ws`'s close, `undici`'s keep-alive — which a `TimeProvider` never
  reaches on the C# side.
- **Short timeouts on the real clock, and bounded waits**, keeps every case at the mercy of a
  runner's load, its durations bent to fit.
- **A clock given to every stack, in each platform's own shape**, reaches Bead's timers and nothing
  else, alike on both sides, and lets an application advance its own.

## Decision

**What the spec times takes the clock; what bounds a platform's own close takes the real one.** The
clock times what sections 10.3, 12, 13 and 15.5 to 15.10 time, the bounds of section 15.12, and a
client's connect and its waits. The real clock times, alike on both sides, what bounds a platform's
close or stop against a peer that does not answer — a close handshake, a stop's grace, a
disconnect's `DELETE` — and a WebSocket's ping, which the C# side's platform times
([0004](0004-one-behaviour-in-every-language.md) plays it in real time), with the platforms' own
timers: `node:http`'s, `undici`'s, `ws`'s, Kestrel's, `SocketsHttpHandler`'s.

**Time has three uses.** A duration runs on a timer. A deadline of Bead's own, a call id's
reservation, is compared on the monotonic reading. An instant from outside, a token's `exp` or
`nbf`, is compared against the wall clock, with its leeway; a session that ends at `exp` is a timer
armed for `exp` less the wall clock's reading as its credential resolves, and armed again when a
renewal moves it. Section 15.10's "never on a reading of its clock" reads "of its wall clock".

**A stack has one clock, set where it starts and read upward.** The transports, the session manager
and a router built alone take one — `clock` on the TypeScript side, `Clock` on the C# side — and
each layer exposes the clock it runs on. A layer built on another runs on that layer's clock, and
refuses one that differs; a façade given a transport already built takes that transport's clock,
and the builder of its sessions receives the clock to use. The code the builder generates adds
none: it runs on its transport's clock.

**The clock has each platform's shape.** On the C# side it is a `TimeProvider`. On the TypeScript
side it is the part of the globals Bead calls — `setTimeout`, `clearTimeout`, `setInterval`,
`clearInterval`, `Date.now` and `performance.now` — which `globalThis` is by default, so its timers
keep the platform's handle, `unref` included where it has one. The pair is a row of each side's list
of terms ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)). The word is _clock_
([0003](0003-one-word-one-meaning.md)): `clock`, `Clock`, `IClock`; a _timestamp_ is the monotonic
reading alone, and the instants a side reports are `lastActivity`, `LastActivity`.

**One ceiling, JavaScript's: 2³¹ − 1 milliseconds**, which the C# side keeps for parity, though its
timers reach twice as far. Every option and method that takes a timeout refuses a longer one — a
session manager's reset and a server's connection timeout among them — and _never_ is `Infinity` and
`Timeout.InfiniteTimeSpan`, which arm nothing. One constant a side, beside its clock.

**`advance` steps.** It settles the side; takes the earliest timer due by now plus its milliseconds;
sets both readings to that due; fires it; settles; and so on, then sets the readings to now plus its
milliseconds. A callback reads its own due, a timer it arms counts from there, and a periodic timer
fires once for each period crossed, each at its own due. The C# harness steps its `FakeTimeProvider`
from due to due, from the timers it records; the TypeScript side's test clock is
`@sinonjs/fake-timers`' `createClock()`, never installed on the globals, and its `tickAsync` steps.
Both pass one shared table of clock cases: two timers chained in one advance, a periodic timer
across three periods, a timer armed at its own due.

**An `advance` follows a timer armed.** Each side's test clock counts the timers armed and their
dues, and `until` waits for "a timer armed, due its milliseconds from now" before an advance:
`spec/check.py` refuses an `advance` that no such `until` precedes since the last send or expect.
Bytes and gauges prove what crossed the wire; this proves what the side means to fire.

**The wall clock starts where a file says.** Each conformance file states its start as an RFC 3339
instant, and both sides' test clocks start there; `advance` moves both readings together, and a step
of its own moves the wall clock alone, forward or back, as a clock set by hand moves.

**Randomness is not time.** A wait drawn at random keeps its platform's draw, and both sides check it
by its bounds: advanced to a millisecond short of half the wait, nothing; advanced to the whole of
it, what it waited for.

**The clock does not order sockets.** A case where a timer ends a connection under an exchange
handed on expects the exchange `orLost` (spec 15.7): the clock makes the end come on time, not its
bytes come first.

**Every language plays the contract in readings and deadlines.** A side is given a monotonic reading
and a wall one; a deadline is due once the monotonic reading reaches it, and is acted on at the
side's next turn — a timer's callback, or a loop's cycle; `advance` moves the readings and lets the
side take its turns. The shapes above are the TypeScript and C# sides'; a language that joins maps
the contract in its own record, as a loop of 1 kHz with no timer to create will.

**The rule has its gate** ([0006](0006-a-rule-has-its-gate.md)). On the C# side, the banned-API
analyzer (RS0030) refuses `DateTime`'s and `DateTimeOffset`'s `Now` and `UtcNow`, `Stopwatch`,
`Environment.TickCount64`, a `Timer`'s constructors, and `Task.Delay` and `CancellationTokenSource`
given no `TimeProvider`. On the TypeScript side, oxlint's `no-restricted-globals` and
`no-restricted-properties` refuse the globals' timers and clocks. Each exception is suppressed where
it stands, with its reason, as [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)
overrules an analyzer.

## Consequences

**The surface changes on both sides.** The C# options' `Time` becomes `Clock`; the TypeScript
transports, session manager and router take `clock`; each layer exposes its own; a layer refuses a
clock that differs from the one beneath it. `timestamp()`'s `{ ms, sec, usec }` goes, as 0003
already asks, and the reported instants are `lastActivity`. A timeout past the ceiling, which some
places read as never and one as 5 seconds, is refused everywhere.

**The TypeScript side's tests take a development dependency**, `@sinonjs/fake-timers`, through its
own lockfile ([0005](0005-a-toolchain-per-language.md)); `spyTimers`, `timersOf`, `timersWhile`,
`spyIntervals`, `clockOf`, the swaps made inline in six files, and the swaps of `Math.random`, give
way to it wherever they stand for Bead's timers.

**Advancing a clock is deterministic for Bead's timers alone.** A platform's timer still runs on the
real clock, and a case that waits on one is marked, played in real time, and bounded generously.

**The WebSocket's close stays where it is.** The TypeScript side's client waits the 30 seconds of
`ws`, the C# side's 5, each on the real clock: aligning them is the client part's decision, and
until then a row of the support matrix.

**What lands with this record**, in one change, before the typed credential: the `advance` step in
both schemas, in milliseconds; the wall clock's start; the `until` on a timer armed and its rule in
`spec/check.py`; both harnesses and both test clocks, and the shared table of clock cases; one case
in each file that both sides play — in `spec/transports.json`, a cancel's burial (until
`buriedCallIds` 1, until its timer is armed, advance 5,000, until `buriedCallIds` 0), in
`spec/conversations.json`, a call id's reservation; the analyzers' gate and its row in
[0006](0006-a-rule-has-its-gate.md)'s table; the renamings; and section 15.10's word. The other cases
that advance a clock follow.

## The Tenth Man

The draft met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). Its
objections, each with its answer:

| Objection                                                                                                                | Answer                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `advance` has no semantics, and the two test clocks already disagree on every timer armed or repeated within one advance | Accepted: `advance` steps from due to due on both sides, and both test clocks pass one shared table of clock cases.                                                      |
| Across a socket, an `advance` can run before the server arms the timer it means to fire                                  | Accepted: each test clock counts its timers armed, `until` waits for one, and the check refuses an `advance` that none precedes.                                         |
| The TypeScript ping on the clock creates a difference, and drops its connections on any advance of two heartbeats        | Accepted: both pings stay on the real clock and play in real time; no row is added.                                                                                      |
| The wall clock is not read "for what is reported alone": 0010 compares `exp` and `nbf`, and no start is stated           | Accepted: three uses of time, the wall clock's start in each file, a step that moves it alone, and 15.10's word.                                                         |
| The ceiling rests on a false premise about .NET, and the same long timeout meets three behaviours                        | Accepted: the ceiling is JavaScript's, kept for parity, refused everywhere, and _never_ is `Infinity` or `InfiniteTimeSpan`.                                             |
| `time`, `ITime` and `timestamp()` break one word, one meaning                                                            | Accepted: the word is _clock_, a timestamp is the monotonic reading, and the reported instants are `lastActivity`.                                                       |
| The TypeScript clock copies a .NET type no JavaScript tool implements                                                    | Accepted: it is the globals' own shape, `globalThis` by default, and the test clock is `fake-timers`' `createClock()`, never installed.                                  |
| A façade's one clock cannot reach layers given already built, and the draft decides the builder's surface                | Accepted: one clock a stack, read upward, a differing one refused, and the generated code adds none.                                                                     |
| Bounding the WebSocket close at 5 seconds alike is a shared behaviour no clause states                                   | Accepted: the close stays where it is, on the real clock, and its alignment is the client part's decision.                                                               |
| What the clock reaches is drawn by an inventory, which misses a timer, with no gate                                      | Accepted: one rule, what the spec times against what bounds a platform's close, and the analyzers' gate.                                                                 |
| The record lands with no shared case of `advance`, and 0010 says the clock lands with it                                 | Accepted: it lands with the step, the rule, both test clocks and one case a file, before 0010.                                                                           |
| A timer-callback contract cannot be mirrored by a C side polling deadlines on a 1 kHz loop                               | Accepted: the shapes are the TypeScript and C# sides'; the contract every language plays is in readings and deadlines.                                                   |
| Randomness is left on the platform, yet a TypeScript test swaps `Math.random`                                            | Accepted: both sides check a drawn wait by its bounds, and the swaps go.                                                                                                 |
| The first cases close connections under exchanges cut after their head, which the clock does not order                   | Accepted in part: the clock does not order sockets, and such a case expects `orLost`, which the transports' file now has; a lingering close is the transports' to weigh. |
