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
  `install()` does, changes no surface. It also moves with Bead whatever else reads the globals:
  `ws`'s close, `undici`'s timeouts, a turn Bead defers, and the test runner's own waits, which it
  freezes. A `TimeProvider` never reaches any of these on the C# side.
- **Short timeouts on the real clock, and bounded waits**, keeps every case at the mercy of a
  runner's load, its durations bent to fit.
- **A clock given to every stack, in each platform's own shape**, reaches Bead's timers and nothing
  else, alike on every side, and lets an application advance its own.

What bounds a platform's own close or socket runs on the platform's clock. A test that waits on such
a bound in real time passes or fails with the machine's load as well. A test can step it only where
the side holds the platform's clock as a value.

## Decision

**What the spec times takes the clock; what bounds a platform's own close, or its socket, takes the
platform's.** The clock times everything the spec times — a call's timeout and a relay's leg B among
it — the bounds of section 15.12, a body's rate among them, but not those it holds a platform's
socket and parser to, and a client's connect and its waits. The platform's clock times, alike on
every side, what bounds a platform's close or stop against a peer that does not answer — a close
handshake, a stop's grace, a disconnect's `DELETE`, a lingering close's 2 seconds — and a heartbeat:
a WebSocket's ping, which the C# side's platform library times, and a broker's, which each side
times on its stack's platform clock, `heartbeat.ts`, `Heartbeat.cs` and `broker/heartbeat.rs`, a
ping on a connection silent for its `heartbeat` (spec 15.21;
[0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)),
each played in real time by the conformance files ([0004](0004-one-behaviour-in-every-language.md)).
What the spec times over a broker beside it takes the clock: a half-open connection's
`acceptTimeout`, and the rate of an envelope's parts (spec 15.18, 15.20). It times as well what
15.12 holds a platform's socket and parser to: what waits for a socket, its pace and its bound,
since each bounds what the platform's socket does; and a head's `headersTimeout`, since the
platform's parser alone sees a head before it is whole, and its check, Kestrel's heartbeat or Node's
`connectionsCheckingInterval`, is internal ([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)).
These run on the platforms' own timers, `node:http`'s, `undici`'s, `ws`'s, Kestrel's,
`SocketsHttpHandler`'s, hyper's, or on a side's own timer on its stack's platform clock.

**Time has three uses.** A duration runs on a timer. A deadline of Bead's own, a call id's
reservation, is compared on the monotonic reading. An instant from outside, a token's `exp` or
`nbf`, is compared against the wall clock, with its leeway; a credential's session a side keeps is
a timer armed for its credential's end less the wall clock's reading as it comes to be kept, at
each step's due, and again when a renewal moves it. Section 15.10 times a client's inactivity "on a
timer of the client's, never on a reading of its wall clock".

**A stack has one clock, set where it starts and read upward.** The transports, the session manager
and a router built alone take one — `clock` on the TypeScript side, `Clock` on the C# side, `clock`
on the Rust side — and each layer exposes the clock it runs on, a transport given none its
platform's. A layer built on another runs on that layer's clock, and refuses one that differs; a
facade given a transport already built takes that transport's clock, and builds its sessions on it.
On the TypeScript side their builder is given it, and a session manager it builds on another is
disposed of, then refused; on the C# and Rust sides their options' clock must be it, and options on
another are refused before any session manager is built. The code the builder generates adds none:
it runs on its transport's clock.

**A stack holds its platform's clock beside it, and a test may replace it.** The platform's clock is
`PLATFORM_CLOCK`, the globals, on the TypeScript side; `TimeProvider.System` on the C# side; and on
the Rust side a runtime's `SystemClock`: two on one runtime are one clock, which read one monotonic
origin, the process's, and a layer takes either for the other. A stack holds it as one value, set
where it starts. Bead's own timers that bound a platform run on it, and a stack given no clock runs
on it. A test replaces it through a seam outside the public surface:

- on the Rust side, the private `on_platform`;
- on the TypeScript side, the option keyed by the symbol `PLATFORM`, which no entry of the package
  exports;
- on the C# side, the internal `Platform` of the options, which `InternalsVisibleTo` opens to the
  tests.

No clock is installed on the globals. A replaced platform clock is named "one of its own", as any
clock that is not the platform's. A platform library's own timers stay on the real clock whatever
the stack holds: `ws`'s close, the header and keep-alive timers of `node:http`, `undici`, Kestrel
and hyper, .NET's WebSocket keep-alive, and the broker clients' own. So does a deferral to the next
turn, which no clock times.

**The clock has each platform's shape.** On the C# side it is a `TimeProvider`. On the Rust side it
is a `Clock` trait, its monotonic reading, its wall clock and a timer armed, `SystemClock` the
platform's on a runtime's timers, the core telling it from any other `Clock`, which is `Any`, and a
router built on a runtime without tokio's time driver refused as it is built, never failing at its
first timer ([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)).
On the TypeScript side it is the part of the globals Bead calls — `setTimeout`, `clearTimeout`,
`setInterval`, `clearInterval`, `Date.now` and `performance.now` — which `globalThis` is by default,
so its timers keep the platform's handle, `unref` included where it has one. The pair is a row of
each side's list of terms ([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)). The
word is _clock_ ([0003](0003-one-word-one-meaning.md)): `clock`, `Clock`, `IClock`; a _timestamp_ is
the monotonic reading alone, and the instants a side reports are `lastActivity`, and a trace's
`startedAt`, beside its `duration` — the shape of an OpenTelemetry span: a start on the wall clock,
a duration on the monotonic one.

**One ceiling, JavaScript's: 2³¹ − 1 milliseconds**, which the C# and Rust sides keep for parity,
though their timers reach further. Every option and method that takes a timeout refuses a longer one
— a session manager's reset and a server's connection timeout among them — and _never_ is
`Infinity`, `Timeout.InfiniteTimeSpan` and `Duration::MAX`, which arm nothing. One constant a side,
beside its clock. **And one floor: a millisecond, counted whole.** Bead arms no timer for less on
the clock it is given, where Node waits a millisecond at least and .NET fires at once, nor for a
fraction, which both drop. How a side holds a duration an application gives it, between that floor
and that ceiling, is [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s.

**A timer its clock refuses leaves the side as it was.** What arms a timer prepares it before it
commits anything: a session manager stores a session, or changes a timeout, only once every timer it
needs is armed, and a reset arms the successor before it stops the timer it replaces, so a refusal
stores nothing and tells nothing. A wait the timer would bound fails at once, its cause the clock's
error: a key set's deadline (spec 13.9.3). A session's activity stamps before it restarts its
timers, on every side alike. The round that settled it is
[0004](0004-one-behaviour-in-every-language.md)'s, on the converse twins' six divergences.

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
([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)). The
platform's clock is read where a stack starts and nowhere else: oxlint's `no-restricted-properties`
refuses a member of `PLATFORM_CLOCK`, the banned-API analyzer refuses `TimeProvider.System`, and
clippy's `disallowed-methods` refuses `SystemClock::on`. Each exception is suppressed where it
stands, with its reason, as [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)
overrules an analyzer.

## Consequences

**The TypeScript side's tests take a development dependency**, `@sinonjs/fake-timers`, through its
own lockfile ([0005](0005-a-toolchain-per-language.md)), never installed on the globals.

**Advancing a clock is deterministic for the timers on the clocks a side holds.** A test that
waits on a bound of Bead's own over a platform may step a test clock in the platform's place. It is
deterministic when each step waits on what its due depends on, a timer armed, a frame or a pong
read, never on a rest. A conformance case marked `realTime` plays on the platform's clock
unreplaced, on every side: a head's 408, its `after` and its `within` around its time
([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)), a WebSocket's ping, a broker's heartbeat.
So does a test of a library's own timer, or of the default itself, each bounded generously. Where a
heartbeat is its platform library's, the C# side's WebSocket keep-alive, its tests play it in real
time: a platform row of the support matrix ("A WebSocket's heartbeat and close timeout, stepped by
a test").

**Every WebSocket end bounds its close on its platform's clock.** Each closing handshake it begins
waits its close timeout at most, 5 seconds by default (spec 15.3,
[0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s place
`webSocketTransport.closeTimeout`), the TypeScript client handing it to `ws`; a client over the
global `WebSocket` leaves its close to its platform, a platform row of the support matrix ("A
WebSocket client's message limit, its ping and its close timeout"). The TypeScript client's is
`ws`'s own timer, which stays real.

## The Tenth Man

A broker's heartbeat on the platform's timer, and what the spec times over a broker on the clock met
the round of the broker's core, which
[0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md) keeps.

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
six rounds here, and in two more on durations, which
[0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md) holds. Its objections, each
with the answer that holds:

### The clock

| Objection                                                                                                                | Answer                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `advance` has no semantics, and the two test clocks already disagree on every timer armed or repeated within one advance | Accepted: `advance` steps from due to due on both sides, and both test clocks pass one shared table of clock cases.                                                                                                |
| Across a socket, an `advance` can run before the server arms the timer it means to fire                                  | Accepted: each test clock counts its timers armed, `until` waits for one, and the check refuses an `advance` that none precedes.                                                                                   |
| The TypeScript ping on the clock creates a difference, and drops its connections on any advance of two heartbeats        | Accepted: both pings run on the platform's clock, never the clock given, and the conformance files play them in real time; a side's own tests may step its platform's clock (see "The platform's clock in tests"). |
| The wall clock is not read "for what is reported alone": 0010 compares `exp` and `nbf`, and no start is stated           | Accepted: three uses of time, the wall clock's start in each file, a step that moves it alone, and 15.10's word.                                                                                                   |
| The ceiling rests on a false premise about .NET, and the same long timeout meets three behaviours                        | Accepted: the ceiling is JavaScript's, kept for parity, refused everywhere, and _never_ is `Infinity` or `InfiniteTimeSpan`.                                                                                       |
| `time`, `ITime` and `timestamp()` break one word, one meaning                                                            | Accepted: the word is _clock_, a timestamp is the monotonic reading, and the reported instants are `lastActivity`.                                                                                                 |
| The TypeScript clock copies a .NET type no JavaScript tool implements                                                    | Accepted: it is the globals' own shape, `globalThis` by default, and the test clock is `fake-timers`' `createClock()`, never installed.                                                                            |
| A façade's one clock cannot reach layers given already built, and the draft decides the builder's surface                | Accepted: one clock a stack, read upward, a differing one refused, and the generated code adds none.                                                                                                               |
| Bounding the WebSocket close at 5 seconds alike is a shared behaviour no clause states                                   | Accepted: 15.3 states the close timeout, 5 seconds by default, which both clients and both servers hold on the real clock ([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md))                                  |
| What the clock reaches is drawn by an inventory, which misses a timer, with no gate                                      | Accepted: one rule, what the spec times against what bounds a platform's close, and the analyzers' gate.                                                                                                           |
| The record lands with no shared case of `advance`, and 0010 says the clock lands with it                                 | Accepted: `advance` has its step, its rule, both test clocks and a case in each file.                                                                                                                              |
| A timer-callback contract cannot be mirrored by a C side polling deadlines on a 1 kHz loop                               | Accepted: the shapes are the TypeScript and C# sides'; the contract every language plays is in readings and deadlines.                                                                                             |
| Randomness is left on the platform, yet a TypeScript test swaps `Math.random`                                            | Accepted: both sides check a drawn wait by its bounds, and the swaps go.                                                                                                                                           |
| The first cases close connections under exchanges cut after their head, which the clock does not order                   | Accepted in part: the clock does not order sockets, and such a case expects `orLost`, which the transports' file has; a lingering close is the transports' to weigh.                                               |

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

### On the words of a layer's clock

| Objection                                                                                                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A clock is still named apart on the C# side, by its type or as "the system's", so twins that pin the whole refusal would pin two strings          | Accepted: every side names a clock "the platform's" or "one of its own"; a clock's type, if it is wanted, comes to every side at once, by a decision. The prose that calls `TimeProvider.System` the system's clock stays: it names the platform's in its platform's own word.                                                                                                                               |
| One side alone pins the refusal: the Rust side asserts its end and the C# side its exception's type                                               | Accepted: each side's twin asserts the whole message.                                                                                                                                                                                                                                                                                                                                                        |
| The twins' titles do not pair: the Rust side plays two versions of the refusal, and each other side lacks one of them                             | Accepted: one title on every side, the TypeScript side's, which names the sessions, its cases joined under it; the TypeScript side gains the twin of a server's sessions built with their own options.                                                                                                                                                                                                       |
| The joined twin holds a case the TypeScript side alone can play, a router a builder made on another clock, and nothing says why                   | Accepted: a facade's layers built by the application are an open row of the support matrix's differences, which places the TypeScript side's `IServerLayers` and `IClientLayers`.                                                                                                                                                                                                                            |
| No side is the reference, so "the TypeScript side's words" are no ground, and every sentence that states the rule says "sessions"                 | Accepted: the noun rests on a rule. One object holds the clock, the session manager, one concept on every side, which the family names as it names "a service manager" and "a server's router", and the template's verbs are singular. The sentences that state this refusal with the layer as subject take that noun; "sessions" stays where it names the member, the option, the gauges or the collection. |
| A plural layer, "a server's sessions", is left unweighed                                                                                          | Accepted, and the plural refused: it asks the template for a number its verbs agree with, on every side and in every assertion of it, for one caller, and makes its subject the sessions, which hold no clock.                                                                                                                                                                                               |
| Nothing tells a caller the layer is named in the singular, and a facade's other layer, its services, is plural on every side                      | Accepted: each side's documentation of a layer's name says it is named in the singular, which the refusal's verbs agree with.                                                                                                                                                                                                                                                                                |
| The C# side changes two words, the layer and the one beneath, where the Rust side changes the layer alone                                         | Accepted: the change is stated as it is.                                                                                                                                                                                                                                                                                                                                                                     |
| A message released on two sides changes, and the changelog says nothing                                                                           | Accepted: the changelog's fixes say it.                                                                                                                                                                                                                                                                                                                                                                      |
| The record states a builder given the clock, the TypeScript side's mechanism, as every side's, though it is why the thing refused differs in kind | Accepted: the record states both, a session manager built then refused and disposed of on the TypeScript side, its options refused before any is built on the C# and Rust sides.                                                                                                                                                                                                                             |

### The platform's clock in tests

| Objection                                                                                                                                                                                                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A simpler design was passed over: the Rust side passes the platform's clock through a private constructor, and the TypeScript side's equivalent is a seam outside the surface, not the globals installed | Accepted: the probes reproduce. The twin passes on installed globals, but an `expect.poll` inside the window breaks Playwright's runner and hangs the run. A stack holds its platform's clock as one value, set where it starts. A test replaces it through `on_platform` on the Rust side, the option keyed by `PLATFORM` on the TypeScript side and the internal `Platform` of the options on the C# side. Nothing is installed on the globals.                                                                        |
| What an install reaches is not what 0011 says: not `node:http`'s timeouts, but `ws`, `undici`, `AbortSignal.timeout` by load order, and Bead's own deferrals to the next turn                            | Accepted: the reach is stated by ownership. Bead's own bounds of a platform run on the platform's clock the stack holds, and a library's timers stay real. The `DELETE`'s `AbortSignal.timeout` becomes a timer on that clock. Bead's deferrals to the next turn stay on the globals. The Context's list is corrected.                                                                                                                                                                                                   |
| An install works only under a contract no gate keeps, and breaking it hangs the run rather than failing a test                                                                                           | Accepted: with the seam there is no install, so no contract. "Never installed on the globals" stays true in 0011 and in the code.                                                                                                                                                                                                                                                                                                                                                                                        |
| The proposal leaves the conformance files' `realTime` cases undecided: one case cannot be stepped on two sides and real-time on the third                                                                | Accepted: the conformance files keep `realTime` on every side, and the players build their stacks on the platform's clock unreplaced. A replaced platform clock is for each side's own tests.                                                                                                                                                                                                                                                                                                                            |
| "Rust shows it works" overstates: a stepping test still rests 50 ms on the real clock, Rust's broker heartbeat has no seam, and hyper's header timer is tokio's                                          | Accepted in part. Accepted: a stepped test is deterministic only when each step waits on what its due depends on, never on a rest; the rest before the next beat in the Rust twin becomes a wait on the pong being read; the broker's participant and the MQTT adapter gain `on_platform`; hyper's header timer is a library's and stays real, as Node's and Kestrel's do. Refused: the other rests cited do not precede a step. One is a poll within patience, and the rest prove that nothing comes within their time. |
| "As its platform allows" brings back a per-side, per-timer inventory with no gate, which 0011's own round refused                                                                                        | Accepted: one rule by ownership, and its gate. oxlint refuses a member of `PLATFORM_CLOCK`; the banned-API analyzer refuses `TimeProvider.System`; clippy refuses `SystemClock::on`. Each read where a stack starts is suppressed with its reason. The record lists what stays real, the libraries' timers.                                                                                                                                                                                                              |
| The C# cost is left out, and the seam's shape is not named under 0007                                                                                                                                    | Accepted: the seam is an `internal` init member `Platform` on each options record of a component that arms a platform's bound. Every one of Bead's own bounds of a platform moves to it in one stage. The keep-alive alone stays .NET's, a row of the support matrix.                                                                                                                                                                                                                                                    |
| A replaced platform clock is named differently on each side, and "the real clock" becomes wrong once it can be replaced                                                                                  | Accepted in part. Accepted: the record says "the platform's clock". A stack given no clock runs on its platform's clock on every side, so a replaced one is named "one of its own" everywhere, as on the Rust side. Refused: renaming the `realTime` mark, or the titles that say "on the real clock". Each plays the platform's clock unreplaced, which is the real one.                                                                                                                                                |
| The install turns many statements false, so the revision must bring every one along                                                                                                                      | Accepted: under the seam, the "never installed" sentences stay true. The revision changes 0011's Context, Decision, Consequences and the answer about both pings; 0004's paragraph on the heartbeats; 0044's sentence on the platform's socket; the TypeScript README; and the heartbeats' doc comments on every side. 0038, 0040, 0014 and 0033 still hold.                                                                                                                                                             |
| The support row belongs in Differences, kind platform, not in Leveled down, and its cells depend on the mechanism                                                                                        | Accepted: a Differences row of kind platform, "A WebSocket's heartbeat and close timeout, stepped by a test", as "A session manager's timers" is. The TypeScript and Rust sides cite their stepped twins. The C# side cites its real-time twin and names .NET's keep-alive. The TypeScript client's close timeout is `ws`'s own timer, which no seam reaches.                                                                                                                                                            |

### A transport's clock on the Rust side

The Rust side's transports exposing their clock met the Tenth Man in one round. Its objections,
each with the answer that holds:

| Objection                                                                                                                                                                                                                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Rust platform's clock has no identity: each transport given none builds its own `SystemClock`, its own origin, and the join compares by pointer, so exposing it refuses a join of two transports given none, and `examples/hello/rust` stops starting | Accepted: two `SystemClock`s on one runtime are one clock, read from one monotonic origin, the process's, and `clock_of` and the join take either for the other. A per-runtime registry was refused: a reused runtime id could hand a new runtime a dead clock. Each side gains the twin `joins two transports given no clock, on the platform’s`; hello starts unchanged, probed. Decision 0011 states the Rust platform's clock as a runtime's.    |
| No twin asserts the router's refusal: TypeScript's transport twin makes two checks, C#'s three, none a refusal, and no C# test refuses a layer given its own clock over a transport on the platform's                                                     | Accepted: the Rust twin makes C#'s three checks, the router's clock by identity; the refusal over a Bead transport given none goes into `runs_on_its_transports_clock_and_refuses_another`, over an in-memory transport, as TypeScript's twin does over a WebSocket one; C#'s `Runs_on_its_transport_s_clock_and_refuses_another` gains the same case. The row closes, so no cell cites it: the twins hold it.                                       |
| A required `clock()` moves Rust from TypeScript's router contract to C#'s, drops the `on_own` case, and opens a difference no row holds                                                                                                                   | Accepted: the traits keep `Option<SharedClock>` and its default `None`, as TypeScript's `clock?`; Bead's eight transports return `Some`. The existing split, an application's transport that may name no clock on the TypeScript and Rust sides and must on the C# side, becomes an open row of the Differences; its closing is a decision of its own.                                                                                               |
| A required `clock()` compared by pointer needs the same `Arc` on every call, which the proposal does not say, and an application's transport returning a fresh platform clock is refused in words that name the platform's twice                          | Accepted in part: the traits stay optional, so no application's transport must name one; equality removes the trap, a fresh `SystemClock` on the same runtime being the same clock (probe 3 accepted); one on another runtime is another clock, still refused in words that name the platform's twice. The doc comments say "the same on every call", which a test clock needs.                                                                      |
| The inventory misses most of what the change touches: 29 implementors, the tests built on `Clockless`, the facades' own checks, hello, and the break users meet                                                                                           | Accepted: with the traits unchanged, the ten implementors on the default and the tests on `Clockless` stay as they are; the design lists the eight transports, the fields that go, and every test that changes or is added. The facades' checks go, the server refusing in the other sides' words; hello is held by CI's pairs. The CHANGELOG names the break: a server or a router given another clock over a Rust transport given none is refused. |
| A router built on its own runtime over a transport given none moves its timers to the transport's runtime, silently                                                                                                                                       | Accepted: the doc comments of the routers', the server's and the client's `runtime` say the owner runs there and the timers on its clock's runtime. A refusal was refused: it would be Rust's alone, and the same holds today for a transport given a clock.                                                                                                                                                                                         |
