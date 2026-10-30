# 0011 — Every side takes its time from a clock it is given

- **Status**: accepted
- **Scope**: every implementation, the timers the spec states and section 15.10's clock, the
  conformance files and their harnesses. What a side holds of a duration an application gives it,
  spec 1.4, is [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s.

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

.NET gives a `TimeProvider`, which `FakeTimeProvider` advances by firing every timer due once the
advance ends. JavaScript's timers are globals, which `@sinonjs/fake-timers` replaces, stepping from
due to due. Two test clocks that advance differently disagree on every timer armed or repeated
within one advance.

Three ways were weighed:

- **A fake clock installed on the globals of the TypeScript harness**, as `@sinonjs/fake-timers`'
  `install()` does, changes no surface, and moves every library on the globals with Bead —
  `node:http`'s timeouts, `ws`'s close, `undici`'s keep-alive — which a `TimeProvider` never reaches
  on the C# side.
- **Short timeouts on the real clock, and bounded waits**, keeps every case at the mercy of a
  runner's load, its durations bent to fit.
- **A clock given to every stack, in each platform's own shape**, reaches Bead's timers and nothing
  else, alike on every side, and lets an application advance its own.

## Decision

**What the spec times takes the clock; what bounds a platform's own close, or its socket, takes the
real one.** The clock times everything the spec times — a call's timeout and a relay's leg B among
it — the bounds of section 15.12, a body's rate among them, but not those it holds a platform's
socket and parser to, and a client's connect and its waits. The real clock times, alike on every
side, what bounds a platform's close or stop against a peer that does not answer — a close
handshake, a stop's grace, a disconnect's `DELETE`, a lingering close's 2 seconds — and a heartbeat:
a WebSocket's ping, which the C# side's platform times, and a broker's, which each side times on its
platform's timer, `heartbeat.ts` and `Heartbeat.cs` on `TimeProvider.System`, and the Rust side's
`broker/heartbeat.rs` on its `SystemClock`, a ping on a connection silent for its `heartbeat` (spec
15.21;
[0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)),
each played in real time ([0004](0004-one-behaviour-in-every-language.md)). What the spec times over
a broker beside it takes the clock: a half-open connection's `acceptTimeout`, and the rate of an
envelope's parts (spec 15.18, 15.20). It times as well what 15.12 holds a platform's socket and
parser to: what waits for a socket, its pace and its bound, since each bounds what the platform's
socket does; and a head's `headersTimeout`, since the platform's parser alone sees a head before it
is whole, and its check, Kestrel's heartbeat or Node's `connectionsCheckingInterval`, is internal
([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)). These run on the platforms' own timers,
`node:http`'s, `undici`'s, `ws`'s, Kestrel's, `SocketsHttpHandler`'s, or on a side's own timer on
the platform's clock, `globalThis` and `TimeProvider.System`.

**Time has three uses.** A duration runs on a timer. A deadline of Bead's own, a call id's
reservation, is compared on the monotonic reading. An instant from outside, a token's `exp` or
`nbf`, is compared against the wall clock, with its leeway; a credential's session a side keeps is
a timer armed for its credential's end less the wall clock's reading as it comes to be kept, at
each step's due, and again when a renewal moves it. Section 15.10 times a client's inactivity "on a
timer of the client's, never on a reading of its wall clock".

**A stack has one clock, set where it starts and read upward.** The transports, the session manager
and a router built alone take one — `clock` on the TypeScript side, `Clock` on the C# side, `clock`
on the Rust side — and each layer exposes the clock it runs on. A layer built on another runs on
that layer's clock, and refuses one that differs; a facade given a transport already built takes
that transport's clock, and the builder of its sessions receives the clock to use. The code the
builder generates adds none: it runs on its transport's clock.

**The clock has each platform's shape.** On the C# side it is a `TimeProvider`. On the Rust side it
is a `Clock` trait, its monotonic reading, its wall clock and a timer armed, `SystemClock` the
platform's on tokio's timers, and a router built on a runtime without tokio's time driver refused as
it is built, never failing at its first timer
([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)). On the
TypeScript side it is the part of the globals Bead calls — `setTimeout`, `clearTimeout`,
`setInterval`, `clearInterval`, `Date.now` and `performance.now` — which `globalThis` is by default,
so its timers keep the platform's handle, `unref` included where it has one. The pair is a row of
each side's list of terms ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)). The
word is _clock_ ([0003](0003-one-word-one-meaning.md)): `clock`, `Clock`, `IClock`; a _timestamp_ is
the monotonic reading alone, and the instants a side reports are `lastActivity`, `LastActivity`, and
a trace's `startedAt`, `StartedAt`, beside its `duration`, `Duration` — the shape of an
OpenTelemetry span: a start on the wall clock, a duration on the monotonic one.

**One ceiling, JavaScript's: 2³¹ − 1 milliseconds**, which the C# side keeps for parity, though its
timers reach twice as far. Every option and method that takes a timeout refuses a longer one — a
session manager's reset and a server's connection timeout among them — and _never_ is `Infinity`,
`Timeout.InfiniteTimeSpan` and `Duration::MAX`, which arm nothing. One constant a side, beside its
clock. **And one floor: a millisecond, counted whole.** Bead arms no timer for less on the clock it
is given, where Node waits a millisecond at least and .NET fires at once, nor for a fraction, which
both drop. How a side holds a duration an application gives it, between that floor and that
ceiling, is [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s.

**`advance` steps.** It settles the side; takes the earliest timer due by now plus its milliseconds;
sets both readings to that due; fires it; settles; and so on, then sets the readings to now plus its
milliseconds. A callback reads its own due, a timer it arms counts from there, and a periodic timer
fires once for each period crossed, each at its own due. The C# harnesses' test clock keeps the
timers armed on it and fires them from due to due, a `FakeTimeProvider` giving its readings alone:
the fake fires a timer due within an advance with its readings at the end already, and timers due at
once in no order of its own. The TypeScript side's test clock is `@sinonjs/fake-timers`'
`createClock()`, never installed on the globals, and its `tickAsync` steps. The Rust side's is the
core's own `SteppingClock`, in its test kit, the C# one's twin, its own timers in armed order:
tokio's paused time is not it, since it moves no wall clock, fires every timer due at once in its
own order and settles nothing between them. Each passes one shared table of clock cases,
`spec/clocks.json`: two timers chained in one advance, a periodic timer across three periods, timers
due at once, the wall clock moved alone. A periodic timer is armed again as it is taken, before its
callback runs: it fires after every timer armed before it fired, and before any its callback arms. A
due is counted in whole milliseconds, a fraction dropped, as Node and .NET count it; each test clock
refuses a timer for less than a millisecond or past the ceiling, and an advance within another, so
what Bead never arms fails a test on every side.

**An `advance` follows a timer armed.** Each side's test clock counts the timers armed and their
dues, and `until` waits for "a timer armed, due its milliseconds from now" before an advance:
`spec/check.py` refuses an `advance` that no such `until` precedes since the last send, expect or
advance. Bytes and gauges prove what crossed the wire; this proves what the side means to fire.

**The wall clock starts where a file says.** Each conformance file states its start as an RFC 3339
instant, and every side's test clock starts there; `advance` moves both readings together, and a
step of its own moves the wall clock alone, forward or back, as a clock set by hand moves.

**Randomness is not time.** A wait drawn at random keeps its platform's draw, and the TypeScript and
C# sides check it by its bounds, the wait their HTTP client draws before it listens again: advanced
to a millisecond short of half the wait, nothing; advanced to the whole of it, what it waited for.

**The clock does not order sockets.** A case where a timer ends a connection under an exchange
handed on expects the exchange `orLost` (spec 15.7): the clock makes the end come on time, not its
bytes come first.

**Every language plays the contract in readings and deadlines.** A side is given a monotonic reading
and a wall one; a deadline is due once the monotonic reading reaches it, and is acted on at the
side's next turn — a timer's callback, or a loop's cycle; `advance` moves the readings and lets the
side take its turns. The shapes above are the TypeScript, C# and Rust sides', the Rust side's mapped
by [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md); a language
that joins maps the contract in its own record, and a 1 kHz loop with no timer to create maps it to
deadlines it polls each cycle.

**The rule has its gate** ([0006](0006-a-rule-has-its-gate.md)). On the C# side, the banned-API
analyzer (RS0030) refuses `DateTime`'s and `DateTimeOffset`'s `Now` and `UtcNow`, `Stopwatch`,
`Environment.TickCount64`, a `Timer`'s constructors, and `Task.Delay` and `CancellationTokenSource`
given no `TimeProvider`. On the TypeScript side, oxlint's `no-restricted-globals` and
`no-restricted-properties` refuse the globals' timers and clocks. On the Rust side, clippy's
`disallowed-methods` and `disallowed-types` refuse tokio's sleeps, intervals and timeouts,
`SystemTime::now` and the `Instant`s, so that time goes through the clock
([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)). Each
exception is suppressed where it stands, with its reason, as
[0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md) overrules an analyzer.

## Consequences

**The TypeScript side's tests take a development dependency**, `@sinonjs/fake-timers`, through its
own lockfile ([0005](0005-a-toolchain-per-language.md)), never installed on the globals;
`spyIntervals` watches the ping, which is the platform's.

**Advancing a clock is deterministic for the timers on the clock a side is given alone.** A
platform's timer, and a bound on the platform's clock, still run on the real clock, and a case that
waits on one is marked, played in real time, and bounded generously: a head's 408, its `after` and
its `within` around its time ([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)).

**Every WebSocket end bounds its close on the real clock.** Each closing handshake it begins waits
its close timeout at most, 5 seconds by default (spec 15.3,
[0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s place
`webSocketTransport.closeTimeout`), the TypeScript client handing it to `ws`; a client over the
global `WebSocket` leaves its close to its platform, a platform row of the support matrix ("A
WebSocket client's message limit, its ping and its close timeout").

## The Tenth Man

A broker's heartbeat on the platform's timer, and what the spec times over a broker on the clock met
the round of the broker's core, which
[0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md) keeps.

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
three rounds here, and in two more on durations, which
[0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md) holds. Its objections, each
with the answer that holds:

### The clock

| Objection                                                                                                                | Answer                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advance` has no semantics, and the two test clocks already disagree on every timer armed or repeated within one advance | Accepted: `advance` steps from due to due on both sides, and both test clocks pass one shared table of clock cases.                                                               |
| Across a socket, an `advance` can run before the server arms the timer it means to fire                                  | Accepted: each test clock counts its timers armed, `until` waits for one, and the check refuses an `advance` that none precedes.                                                  |
| The TypeScript ping on the clock creates a difference, and drops its connections on any advance of two heartbeats        | Accepted: both pings stay on the real clock and play in real time; no row is added.                                                                                               |
| The wall clock is not read "for what is reported alone": 0010 compares `exp` and `nbf`, and no start is stated           | Accepted: three uses of time, the wall clock's start in each file, a step that moves it alone, and 15.10's word.                                                                  |
| The ceiling rests on a false premise about .NET, and the same long timeout meets three behaviours                        | Accepted: the ceiling is JavaScript's, kept for parity, refused everywhere, and _never_ is `Infinity` or `InfiniteTimeSpan`.                                                      |
| `time`, `ITime` and `timestamp()` break one word, one meaning                                                            | Accepted: the word is _clock_, a timestamp is the monotonic reading, and the reported instants are `lastActivity`.                                                                |
| The TypeScript clock copies a .NET type no JavaScript tool implements                                                    | Accepted: it is the globals' own shape, `globalThis` by default, and the test clock is `fake-timers`' `createClock()`, never installed.                                           |
| A façade's one clock cannot reach layers given already built, and the draft decides the builder's surface                | Accepted: one clock a stack, read upward, a differing one refused, and the generated code adds none.                                                                              |
| Bounding the WebSocket close at 5 seconds alike is a shared behaviour no clause states                                   | Accepted: 15.3 states the close timeout, 5 seconds by default, which both clients and both servers hold on the real clock ([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)) |
| What the clock reaches is drawn by an inventory, which misses a timer, with no gate                                      | Accepted: one rule, what the spec times against what bounds a platform's close, and the analyzers' gate.                                                                          |
| The record lands with no shared case of `advance`, and 0010 says the clock lands with it                                 | Accepted: `advance` has its step, its rule, both test clocks and a case in each file.                                                                                             |
| A timer-callback contract cannot be mirrored by a C side polling deadlines on a 1 kHz loop                               | Accepted: the shapes are the TypeScript and C# sides'; the contract every language plays is in readings and deadlines.                                                            |
| Randomness is left on the platform, yet a TypeScript test swaps `Math.random`                                            | Accepted: both sides check a drawn wait by its bounds, and the swaps go.                                                                                                          |
| The first cases close connections under exchanges cut after their head, which the clock does not order                   | Accepted in part: the clock does not order sockets, and such a case expects `orLost`, which the transports' file has; a lingering close is the transports' to weigh.              |

### The test clocks

| Objection                                                                                                                                                            | Answer                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bead does arm a timer for no time — a server given a connection inactivity timeout of 0 — and a millisecond counted for it describes `fake-timers`, neither platform | Accepted: one floor, a millisecond; a timeout under it is refused wherever one is taken, and a server's inactivity timeout of 0 on both sides; both test clocks refuse a timer for less, and no case pins what they would do with it.          |
| "A periodic timer is armed again last" is false of both test clocks once its own callback arms a timer due with its next firing                                      | Accepted: the rule is stated in Bead's terms — armed again as it is taken, before its callback — and a case pins the order its callback's timers take.                                                                                         |
| The ceiling is a gate on the C# test clock alone, where `fake-timers` fires a timer past it a millisecond later, as Node would                                       | Accepted: both test clocks refuse a timer past the ceiling, and an advance within another; a session that ends at an `exp` past the ceiling arms the ceiling, then what is left ([0010](0010-a-request-presents-a-credential-of-a-scheme.md)). |
| Fractional dues diverge: `fake-timers` and .NET truncate to whole milliseconds, the C# test clock kept ticks                                                         | Accepted: a due is counted in whole milliseconds, a fraction dropped, on both test clocks.                                                                                                                                                     |
| The record changes without this round's objections, and the other files restate a part of `advance`                                                                  | Accepted: the objections are kept here, and the other files refer to `spec/clocks.json` for what `advance` means.                                                                                                                              |

### The trace's instants

| Objection                                                                                                                                                           | Answer                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Timing" already means a policy of the application's, the pace of notifications (0002), and the W3C standard it borrows from reads its start on the monotonic clock | Accepted: no wrapper and no word for one; `startedAt` and `duration` sit flat on the event, as every other member, in the shape of an OpenTelemetry span.               |
| "When the call started" is false of a notification, whose steps each took a start of their own, a failed notify two                                                 | Accepted: one meaning for every step — a notification's is when it is sent or heard — and a failed notify tells its failure at its sent step's start, with a twin test. |
| On the C# side, 0007 decides the types: a `DateTimeOffset` and a `TimeSpan`, the statistics with them, the truncation to whole milliseconds kept                    | Accepted: `StartedAt` and `Duration` in the platform's types, the truncation explicit, a twin test advancing 30.6 ms and telling 30.                                    |
| The renaming leaves 0011, the changelog, the demo, an internal `event` and the matrix behind                                                                        | Accepted: the internal wall reading is `instant`, and the matrix's row names every instant a side reports.                                                              |
