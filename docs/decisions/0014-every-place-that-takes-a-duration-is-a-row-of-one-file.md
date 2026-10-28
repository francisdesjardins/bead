# 0014 — A side holds a duration an application gives it as whole milliseconds from 1 to 2³¹ − 1, and every place that takes one is a row of one file

- **Status**: accepted
- **Scope**: spec 1.4, 15.9, 15.10 and 15.12, and the line naming the file; `spec/durations.json`,
  its schema, its generator and its gate; both implementations' harnesses; the support matrix. The
  clock a duration runs on, its floor and its ceiling are
  [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)'s.

## Context

A duration an application gives a side runs on a timer of the clock it is given, which arms none for
less than a millisecond nor past 2³¹ − 1, and none for a fraction
([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)). The values users write do not
reach a timer alike: 0.41 s is 410 ms in JavaScript and 409.9999 ms in .NET.

Thirty-four places take such a duration, by 51 ways, from a call's timeout to a gateway's heartbeat
and a broker's: its participant's heartbeat and `bodyGracePeriod`, its server transport's
`acceptTimeout`, and its MQTT 5 and AMQP 1.0 adapters' keep-alive, idle-time-out and connect
timeout. Some are reached more than one way: a reserve and a cancel, a relay's own timeout and a
destination's, every transport's connect, the in-memory client's and the broker client's among them,
a client and its server over HTTP and over WebSocket, and an HTTP server and a gateway at three of
15.12's places. Few inputs tell two readings of 1.4 apart — a half up from a half to the even, a
value as given from as rounded at the ceiling, −1 ms, NaN — and a table of inputs that misses them
proves neither reading.

A file must not pin what the spec leaves to each side. A refusal's words are each side's: the C#
side's message carries .NET's ` (Parameter '…')`, which its tests skip; each side names an option in
its language's case, `exchangeTimeout` and `ExchangeTimeout`, as
[0004](0004-one-behaviour-in-every-language.md) has a name; and a C side would report a code, not
English. Nor may it pin a default no clause states: 9.9, 10.3, 12.2.8, 13.7, 14.4, 15.3 and 15.12
state theirs, but no clause gives a client's connect its 30 s, its `wait` its 25 s or its
reconnection its 1 s. Nor does a place observed by its refusal alone carry the default its clause
states, which nothing in the file would read: a WebSocket's heartbeat, 30 s, and its close timeout,
5 s (15.3), each side's tests hold. And the two platforms are not given a duration alike: a
JavaScript number holds the milliseconds as written, where a .NET `TimeSpan` counts ticks of 100 ns
and truncates to them what it is given.

Four ways were weighed:

- **Twin tables of inputs, one a side**: free, and every gap held alike by two hands.
- **A file keyed by each refusal's words, the words pinned, every default the code has**: its keys
  change with a phrase, it pins English no clause states, and it states client defaults that no
  client part over HTTP and a WebSocket holds.
- **A file of policies alone**, each place's kind, 0 and never, from which each harness derives
  every outcome: shorter, and every language then checks its own reading of 1.4 against itself.
- **A file of places keyed by a stable id, each with its ways, one table of inputs, and every
  outcome written out with its reason, the words left to each side.** Chosen.

## Decision

**A side holds a duration an application gives it as a whole number of milliseconds from 1 to 2³¹ −
1** (spec 1.4), a fraction rounded to the nearest, a half up, so that the values users write are
held alike; one under a millisecond or past the ceiling is refused, by one assertion a side, in the
same words. A timeout or a bound refuses 0, and is never only where its place takes never; one left
out is its default. A delay takes 0 as at once, and a delay that reaches 0 acts at once, with no
timer.

**One file, `spec/durations.json`, holds what every place makes of every input.** It is JSON ([RFC
8259](https://www.rfc-editor.org/rfc/rfc8259)) under its schema, JSON Schema 2020-12, with no key
twice ([RFC 7493](https://www.rfc-editor.org/rfc/rfc7493)), and repeats the spec's version, as every
conformance file does (0004). A generator, `spec/generators/make_durations.py`, writes it whole from
its inputs and its places, as `make_vectors.py` writes vectors: nothing in it is drawn at random,
and nothing advances a clock, so it states no wall clock.

**A place is keyed by its id, which nothing but a decision changes.** The id is the place's owner
and its duration, in camelCase, parted by a dot, spelled out ([0003](0003-one-word-one-meaning.md)):
`call.timeout`, `httpTransportServer.maximumWait`. It names no words of a refusal, so the words move
and the key stays. A place carries besides:

- `name`, what it is, for a reader;
- `kind`: `delay`, a wait before an act, which takes 0 as at once, or `timeout`, any other — a
  timeout, a bound, the heartbeat's period — which 1.4 never lets be 0;
- `never`: `taken`, held without end, arming nothing; `refused`, where its clause says it may not be
  without end (12.2, 15.12), and at every delay, which 1.4 never lets be without end; or `default`,
  held as its default, which 10.3 gives a call id's reservation alone. `neverClause` names the
  clause that says so, where 1.4 does not alone;
- `ways`, each way its surface takes that duration, by an id stable in the place: a reserve and a
  cancel, each transport's connect, a reconnection's delay as a function and as a number. A way
  whose duration cannot be left out, an argument or an option its type requires, is `required`;
- `default`, where a clause states one: its milliseconds or never, its clause, the ways a harness
  builds with nothing given to read it, none of them `required`, and the `state` it holds in where
  it holds only so — a reserve or a cancel of no call, since a cancel of a call that waits, given
  none, reserves for that call's own timeout; a session under a manager given none of its defaults;
  the server layer over a transport that gives it none;
- `observed`: `held`, what the place holds is read, at every place on the clock a side is given;
  `refusal`, whether it refuses alone, at those on the real clock (0011), whose timers no test clock
  reaches: a WebSocket's heartbeat and its close timeout, its client's and its server's, and each
  server's `sendGracePeriod` and `headersTimeout`, a gateway's among them
  ([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)); at a gateway's heartbeat; and over a
  broker, at its participant's heartbeat and at each adapter's keep-alive or idle-time-out and
  connect timeout. A place observed by its refusal has no default in the file, since nothing would
  read it;
- `clauses`, the units of the spec it checks, each for what it observes of it, and nothing else:
  1.4, which holds and refuses its durations; its `neverClause`; and its default's clause.

**Two owners share a place, as its ways, when the spec names one option for both and every column
the file holds agrees**: its kind, its never and that clause, its default and its clause, what is
observed of it, and so its outcomes. The place's owner is then what both are, and its ways `client`
and `server`: `httpTransport.inactivityTimeout` (15.12), `webSocketTransport.heartbeat` and
`webSocketTransport.closeTimeout` (15.3). A place's ways share what the file observes, not
everything the duration bounds: an HTTP client's inactivity ends its listens and a server's a
connection drawn, and each way's harness reads its own side's timer. Where one column differs, each
owner keeps a place of its own.

`server.connectionInactivityTimeout` is the server layer's option, which 13.7 leaves without end
when not given; an HTTP server gives its own 30 s (15.12.10), which `spec/transports.json`'s
`defaults` holds and both sides check, and the place's `state` says so.
`httpTransport.inactivityTimeout` is an HTTP connection's inactivity timeout, which 15.12 names for
both sides: 5 minutes by default, and without end if given so, its client's and its server's alike.
`httpTransportClient.pause`'s at once is 15.10's "listen again at once", stated with a schedule no
file checks: the file leaves it out, as it leaves out the defaults no clause states.
`webSocketTransport.closeTimeout` is a WebSocket's close timeout by two ways, its client's and its
server's, as `webSocketTransport.heartbeat` is: each harness plays both, and each WebSocket client's
tests play its client's way besides.

**One table of inputs serves every place.** An input is given in one of five forms, each a value a
user writes on every platform:

- `milliseconds`, a JSON number: the TypeScript side gives it as it is, the C# side through
  `TimeSpan.FromMilliseconds`, the Rust side through `Duration::from_secs_f64` of `ms / 1000.0`;
- `seconds`, a JSON number, as a user writes seconds: `seconds * 1000`, `TimeSpan.FromSeconds` and
  `Duration::from_secs_f64`, each platform's own arithmetic — 0.41 s is 410 ms in JavaScript,
  409.9999 ms in .NET and 410 ms in Rust, which rounds to the nanosecond, 2.01 s
  2009.9999999999998 ms, 2009.9999 ms and 2010 ms;
- `never`: `Infinity`, `Timeout.InfiniteTimeSpan` and `Duration::MAX`, which RFC 8259 §6 leaves
  JSON without ([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md));
- `nan`: IEEE 754's NaN, which JSON has no number for either;
- `json`: a value that is no number, a string or a boolean, as a limit read from JSON may be.

**Each place has an outcome for every input, written out.** An outcome is `held`, with the whole
milliseconds held; `at once`; `never`; `default`, with the milliseconds of the default it is held
as; `taken`, at a place observed by its refusal, for an input it does not refuse, with nothing held;
or `refused`, with its reason: `under the floor`, `past the ceiling`, `0 refused`, `never refused`,
or `not a number`. The rounding is a half away from zero, IEEE 754's roundTiesToAway, which
ECMAScript's `Math.round` and .NET's `MidpointRounding.AwayFromZero` both give on a positive value;
the generator rounds so, never with Python's `round`, which takes a half to the even.

**The reason is derived, and held by the regeneration alone.** The generator derives it from the
input, the place's kind and its never; no harness reads it. It pins why a duration is refused, never
the words that say so: a duration's refusal is thrown to the application, never sent, where the
vectors pin a refusal's detail because it goes on the wire; and [RFC
9457](https://www.rfc-editor.org/rfc/rfc9457) keeps a problem's type apart from its words alike. A
side that reports a refusal by a code checks the reason against that code. No surface changes for
it: the TypeScript and C# sides word one sentence for every reason, and the Rust side reports a
refusal by a code, `DurationRefusal`, which its harness checks against the reason.

**The generator plays every platform.** Each outcome is 1.4 over the input's value as written.
Beside it, the generator plays each platform's conversion — JavaScript's arithmetic on a double,
.NET's `TimeSpan`, the double multiplied into ticks and truncated, and Rust's `Duration`, the
double's exact value rounded to the nearest nanosecond — and runs 1.4 over what each reaches. It
fails on any outcome, held value or reason a platform reaches otherwise, unless that outcome, or its
input, crosses a row of the matrix for that language; on a row an input names that nothing crosses;
and on an input in seconds within a platform's error of a half, a tick as written and on the
platforms that count one, half a nanosecond on Rust's, since a value so near a half rounds with its
platform's error. Rust reaches 1.4's outcome at every input it can be given. JavaScript
reaches 1.4's outcome at every input. .NET reaches another at three: under a tick, 0.00001 ms is
`TimeSpan.Zero`, at once at a delay and refused as 0 elsewhere; 0.00001 ms past the ceiling is
truncated onto the ceiling, and held; and −1 ms is `Timeout.InfiniteTimeSpan`, never where never is
taken, the default where never is held as one, and refused as never where never is refused.

**A difference crosses its row, where it crosses.** A `differs` names a row of `docs/support.md` and
the language the row excuses, as in every file of entries
([0004](0004-one-behaviour-in-every-language.md)), at three levels:

- on an input the language cannot be given at all: NaN, `"1000"` and `true` are no value a
  `TimeSpan` or a `Duration` holds, and cross "A duration that is not a number", a platform row;
  −2 ms and −1 ms are no `Duration`, and cross "A duration under zero" for the Rust side;
- on a way the language lacks: the Web Worker's connect, which crosses "The Web Worker transport"
  for the C# and the Rust sides, and a reconnection's delay given as a number, which crosses "A
  reconnection's delay given as a number" for the C# side, an open row, since the Rust side takes
  both ways;
- on an outcome the language reaches otherwise: −1 ms crosses "A duration of -1 ms" at every place,
  the ten that refuse never among them, where the C# side refuses it as never rather than under the
  floor; the two inputs finer than a tick cross "A duration finer than a tick" at every place.

The row names `spec/durations.json` and what crosses it, between backticks: the input's name, or the
place's id and the way's. A harness plays every input at every place and way but those a `differs`
excuses its language from, at whichever level.

**Each side plays the file in one harness, through one helper.** The helper reads the file whole,
from `spec/`, never a copy, and gives the inputs as its side is given them: on the TypeScript side
`transport/shared/__tests__/durations.ts`, on the C# side `tests/Shared/Durations.cs`, linked with
the file into each test project that uses it, on the Rust side its test kit's
`src/testing/durations.rs`. The harness is the TypeScript side's
`server/__tests__/durations.test.ts`, in the folder whose tests already build every layer, the C#
side's `DurationsTests`, in `Bead.Transport.Http.Tests`, which references every assembly holding
a place, and the Rust side's `crates/bead/tests/durations.rs`, its core's, which plays the places
its core holds, each other one ahead with the step or the stage that brings it. Each keeps a table from each place and way to a function that builds the place on the
side's test clock, given one input or none, and fails when its table's places or ways are not the
file's, one more or one less; each way keeps what its loop asserted besides the outcome.

**The words stay with each side.** Each side keeps a phrase a place, in its own words and its
language's case, beside the table that builds it, and one words function, beside the helper, which
writes its sentence from a phrase, a kind, a never and an input: what it offers besides — 0 for at
once at a delay, never where never is taken — and the value written, a string quoted on the
TypeScript side; a fraction with a dot under any culture, and never as `infinite` rather than −1, on
the C# side. The twins of each side's assertion, `clock.test.ts` and `ClocksTests`, take the file's
inputs through the helper and hold the assertion's one sentence over every input, with one sentence
of each offer written out whole, so the words function answers to a sentence a reader can see. Each
platform's word for never, `Infinity` and `infinite`, is its side's: this record settles none.

**The spec states what the file checks**: section 1 names it; 1.4 refuses a value that is no number
and says what a delay is; 15.12 says how a client times its own inactivity; 15.9 parts a peer's
`wait` from an application's. The defaults no clause states — a client's connect, its `wait`, its
reconnection's delay — stay out of the file, and so do those 15.3 states for the places observed by
their refusal alone, a WebSocket's heartbeat and its close timeout, and the 30 s transcoding 8.7
states for a gateway's heartbeat: each side's tests hold them.

**The defaults two files state come from one table.** 15.12's defaults are `spec/transports.json`'s
`defaults` too: `make_durations.py` and `make_transports.py` read them from one module of the
generators, `spec/generators/bounds.py`, so the two files cannot disagree.

**The rule has its gate** ([0006](0006-a-rule-has-its-gate.md)): `spec/check.py` holds the file
under its schema and the spec's version, every place an outcome for each input, every place citing
only what it observes, every `differs` naming a row that names the file and what crosses it, and, on
each side, the helper alone reading the file and the harness naming every place's id. The check does
not compute 1.4 again: the generator does, and the regeneration holds the file to it.

## Consequences

**A place added is a row of the file and a way in each table**, which the gate finds missing from a
harness. Nothing finds a place that calls the assertion with no row: review holds it, as a
preference (0006).

**Each side keeps a phrase a place and a words function**, and a language that reports codes maps
each reason to one.

**A client's durations are held by a file before its behaviour is.** The matrix's sentence that a
client is held to the other side by the interop alone has its exception: what a client holds of a
duration it is given is the durations file's.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
four rounds: two on the rule; one on the file, where the user chose what it asked — the defaults no
clause states left out of the file, and the HTTP transports' places on the clock a side is given
observed `held`; and one on the places two owners share. Its objections, each with the answer that
holds:

### On durations

| Objection                                                                                                                         | Answer                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A transfer's inactivity was aligned onto the side that took a fraction, which no timer honours and the wire then printed two ways | Accepted: every duration is a whole number of milliseconds, on both sides, as spec 1.4 states.                                   |
| One side's reconnection told its tap before arming its wait, the other after                                                      | Accepted: both arm the wait first, with a twin test whose tap moves the clock past it.                                           |
| The breaking changes went untold                                                                                                  | Accepted: the changelog says each, and the TypeScript connect's doc says that a refused timeout leaves its state and its target. |
| A reconnection's delay of never retried at once                                                                                   | Accepted: refused on both sides, before the tap hears it.                                                                        |
| The C# side wrote milliseconds in the current culture, on the wire too                                                            | Accepted: the invariant culture everywhere, with a test under fr-CA.                                                             |
| A limit loaded from JSON could be a string or a boolean on the TypeScript side                                                    | Accepted: the one assertion refuses a non-number.                                                                                |
| Nothing said which durations take a fraction, nor the floor, where a third language would read it                                 | Accepted: spec 1.4, which 9.9 and 12.2 cite.                                                                                     |
| The twin tests probed two inputs                                                                                                  | Accepted: one table of inputs at every place, on both sides; -1 ms, which .NET reads as never, is a row of the matrix.           |

### On durations and their places

| Objection                                                                                                                | Answer                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Refusing a fraction refused the values users write — 0.41 s is 409.9999 ms in .NET — and not the same ones on both sides | Accepted: a fraction is rounded to the nearest, a half up; only one under a millisecond or past the ceiling, as given, is refused. |
| Spec 1.4 is a MUST no tool checks, kept as two tables made by hand                                                       | Accepted: `spec/durations.json` holds it at every place.                                                                           |
| "A duration a side is given" reached a peer's `wait` and a token's `exp`                                                 | Accepted: 1.4 is an application's durations; 15.9 states the `wait`; a token's expiry is 0010's, with its code.                    |
| 1.4 allowed never where both sides refuse it                                                                             | Accepted: never may be but where its place says it may not, as 12.2 and 15.12 do.                                                  |
| 0 meant three things, one the opposite of another, and a close timeout of 0 differed                                     | Accepted: a timeout or a bound refuses 0, a delay takes it as at once, and a default is had by giving none.                        |
| A service manager's default timeout was checked at each call                                                             | Accepted: as the manager is built, and a call's own where the defaults are applied, so its trace shows the duration held.          |
| The TypeScript session manager's resets have no C# twin                                                                  | Accepted: both session managers reset either timeout alone ([0012](0012-a-listen-held-is-not-silence.md)).                         |
| A promise's delay of never meant at once                                                                                 | Accepted: refused.                                                                                                                 |
| A C# session left without its timeouts held never, a TypeScript one the defaults                                         | Accepted: one left out is the manager's default on both sides, and a session made by `create` holds never.                         |
| 15.9 said a `wait` is never refused for its length                                                                       | Accepted: fifteen digits at most, one left out being 0.                                                                            |

### On the file

| Objection                                                                                                                                                                                                        | Answer                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A duration finer than a tick reaches another outcome on the C# side, and neither the file nor the matrix says so                                                                                                 | Accepted: two inputs finer than a tick cross a platform row, "A duration finer than a tick"; the generator plays both conversions, and fails on an outcome either reaches otherwise that crosses no row, and on an input in seconds within a tick of a half.                            |
| The reason the file pins is read by no harness, and is false of the C# side at −1 ms where never is refused                                                                                                      | Accepted: the reason is derived, held by the regeneration alone, with no surface change; −1 ms crosses its row at every place, the ten that refuse never among them; the twins hold one sentence over every input.                                                                      |
| `spec/check.py`'s new lines pass for the wrong reason: the twins meet the read gate, `differs` matches inside words, names are unique where ids are the key, and `uncited.txt` stops telling what no file checks | Accepted: one helper a side alone reads the file, the twins through it, and the harness names every place; a row names the file and what crosses it between backticks; ids are unique; a place cites only what it observes; 15.10, which no place cites, the ledger holds by its twins. |
| The ways a place is reached are in no file, so nothing holds them alike, and three differences have no row                                                                                                       | Accepted: each place lists its ways by a stable id, each harness keys its table by place and way, and a way one language lacks crosses its row: the Web Worker's connect, and a reconnection's delay given as a number, an open row.                                                    |
| The file pins outcomes no clause states: the refusal of what is no number, and which places are delays                                                                                                           | Accepted: 1.4 states both, a value that is no number refused, and a delay a wait before an act — a pause, a reconnection's wait, the `wait` a client's listens ask.                                                                                                                     |
| At each place, the harness checks less than the loops it replaces                                                                                                                                                | Accepted: each harness builds its side's whole sentence by a words function kept outside the file, and each way keeps what its loop asserted, listed above.                                                                                                                             |
| 15.12 names its timeouts for both sides, yet the HTTP client's 5 minutes were left out                                                                                                                           | Accepted: 15.12 says a client times its inactivity by `inactivityTimeout` alike, 15.10 names the timer, and the client's place cites 15.12.9 and holds its 5 minutes.                                                                                                                   |
| A default that depends on state or on the transport passes for the wrong reason when its place is built with nothing given                                                                                       | Accepted: a default names the ways that read it and the state it holds in, a way that cannot leave its duration out is `required`, and the server layer's default says an HTTP server gives its own 30 s.                                                                               |
| The places observed by their refusal carry held values and defaults no harness reads                                                                                                                             | Accepted: such a place writes `taken`, with no `held`, and has no default in the file.                                                                                                                                                                                                  |

### On the places two owners share

| Objection                                                                                                         | Answer                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The close timeout's default was said to be out of the file because no clause states it, where 15.3 states its 5 s | Accepted: it is out because its place is observed by its refusal alone, as the heartbeat's 30 s is, and each side's tests hold both.                                                    |
| Comments and the TypeScript README named a WebSocket server's close timeout alone, the clients' bounded too       | Accepted: each names a WebSocket's close timeout, its client's and its server's.                                                                                                        |
| The C# client's twin promised a rounding it did not check                                                         | Accepted: it reads the close timeout its connections are built with, as the TypeScript twin reads what `ws` is handed.                                                                  |
| The clients' never differed unseen: the TypeScript client hands `ws` 2³¹ − 1 ms, the C# client waits without end  | Accepted: a twin pair waits on a server without end for an infinite close timeout, and the matrix states the TypeScript side's cap.                                                     |
| No rule said when two owners share a place                                                                        | Accepted: when the spec names one option for both and every column the file holds agrees; `httpTransport.inactivityTimeout` is the HTTP client's and server's, whose columns all agree. |
| A place renamed changes what a conforming harness answers to, and was told as a test                              | Accepted: the HTTP place shared is a feature of the spec; no alias and no version: both sides' harnesses read the file in the repository, and move with the name.                       |
| The C# twin played every input of a place, whichever way it plays                                                 | Accepted: `Durations.Played(place, way)` plays nothing of a way this side is excused from, as the TypeScript twin skips it.                                                             |
| The close timeout's place sat apart from the heartbeat's, its twin in shape                                       | Accepted: beside it, in the generator, the file and both harnesses.                                                                                                                     |
