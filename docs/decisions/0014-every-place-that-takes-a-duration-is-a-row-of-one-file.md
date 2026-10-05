# 0014 — Every place that takes a duration is a row of one file, which pins each outcome and its reason

- **Status**: accepted
- **Scope**: spec 1.4, 15.9, 15.10 and 15.12, and the line naming the file; `spec/durations.json`,
  its schema, its generator, `spec/check.py` and `spec/uncited.txt`; both implementations' harnesses
  and the tables they replace; the support matrix

## Context

Section 1.4 states how a side holds a duration an application gives it: a whole number of
milliseconds from 1 to 2³¹ − 1, a fraction rounded to the nearest, a half up; one under a
millisecond or past the ceiling, as given, refused, a delay's 0 aside; a timeout or a bound never 0,
and without end where its place allows it; one not given, its default. It is a MUST
([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)) that no conformance file checks.
[0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md) holds it by two tables made by
hand, `durationsOf` on the TypeScript side and `Durations.Of` on the C# side, until a file of its
own, and [0006](0006-a-rule-has-its-gate.md)'s table names them as its gate on that condition.

Twenty-one places take such a duration, from a call's timeout to a WebSocket server's close timeout,
and the two tables reach them through 17 loops on the TypeScript side and 16 on the C# side. What
they hold, they hold alike; what they miss, they miss on both sides:

- a session timeout's reset and the heartbeat are in neither table;
- the HTTP server's three bounds, the HTTP client's three durations and the close timeout check only
  whether an input is refused, never what is held;
- no input tells a half up from a half to the even, since 1.5 rounds to 2 either way; and none tells
  "as given" from "as rounded" at the ceiling, since 2,147,483,647.5 is past it either way;
- −1 ms is in neither, tested apart as a row of the matrix; NaN is in the TypeScript side's alone;
- a place reached more than one way — a reserve and a cancel, a relay's own timeout and a
  destination's, every transport's connect — is reached by whichever ways each loop chose.

A language that joins would copy two tables, and their gaps with them.

A file must not pin what the spec leaves to each side. A refusal's words are each side's: the C#
side's message carries .NET's ` (Parameter '…')`, which its tests skip; each side names an option in
its language's case, `exchangeTimeout` and `ExchangeTimeout`, as
[0004](0004-one-behaviour-in-every-language.md) has a name; and a C side would report a code, not
English. Nor may it pin a default no clause states: 9.9, 10.3, 12.2.8, 13.7, 14.4, 15.3 and 15.12
state theirs, but no clause gives a client's connect its 30 s, its `wait` its 25 s or its
reconnection its 1 s, nor a WebSocket server's close its 5 s, whose bound the transports' client part
aligns with the clients', a decision of its own (0004, 0011). And the two platforms are not given a
duration alike: a JavaScript number holds the milliseconds as written, where a .NET `TimeSpan` counts
ticks of 100 ns and truncates to them what it is given.

Four ways were weighed:

- **The twin tables kept**, as 0006 has them: free, and every gap above stays, held alike by two
  hands.
- **A file keyed by each refusal's words, the words pinned, every default the code has**: its keys
  change with a phrase, it pins English no clause states, and it states client defaults ahead of the
  client part.
- **A file of policies alone**, each place's kind, 0 and never, from which each harness derives
  every outcome: shorter, and every language then checks its own reading of 1.4 against itself.
- **A file of places keyed by a stable id, each with its ways, one table of inputs, and every
  outcome written out with its reason, the words left to each side.** Chosen.

## Decision

**One file, `spec/durations.json`, holds what every place makes of every input.** It is JSON
([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)) under its schema, JSON Schema 2020-12, with no
key twice ([RFC 7493](https://www.rfc-editor.org/rfc/rfc7493)), and repeats the spec's version, as
every conformance file does (0004). A generator, `spec/generators/make_durations.py`, writes it whole
from its inputs and its places, as `make_vectors.py` writes vectors: nothing in it is drawn at
random, and nothing advances a clock, so it states no wall clock.

```json
{
  "$schema": "schemas/durations.schema.json",
  "$comment": ["…its vocabulary, a sentence a field…"],
  "specVersion": "0.1.0",
  "inputs": [
    { "name": "0", "milliseconds": 0 },
    { "name": "2.5 ms", "milliseconds": 2.5 },
    { "name": "0.41 s, as written", "seconds": 0.41 },
    { "name": "never", "never": true },
    { "name": "-1 ms", "milliseconds": -1 },
    {
      "name": "NaN",
      "nan": true,
      "differs": [{ "row": "A duration that is not a number", "language": "C#" }]
    }
  ],
  "places": [
    {
      "id": "router.reservation",
      "name": "a call id's reservation, a reserve's or a cancel's",
      "clauses": ["1.4", "10.3"],
      "kind": "timeout",
      "never": "default",
      "neverClause": "10.3",
      "ways": [
        { "id": "reserve", "name": "a call id its router reserves" },
        { "id": "cancel", "name": "a call id its router cancels" }
      ],
      "default": {
        "milliseconds": 5000,
        "clause": "10.3",
        "ways": ["reserve", "cancel"],
        "state": "a reserve, or a cancel of a call id no call waits on: …"
      },
      "observed": "held",
      "outcomes": [
        { "input": "0", "outcome": "refused", "reason": "0 refused" },
        { "input": "2.5 ms", "outcome": "held", "held": 3 },
        { "input": "0.41 s, as written", "outcome": "held", "held": 410 },
        { "input": "never", "outcome": "default", "held": 5000 },
        {
          "input": "-1 ms",
          "outcome": "refused",
          "reason": "under the floor",
          "differs": [{ "row": "A duration of -1 ms", "language": "C#" }]
        },
        { "input": "NaN", "outcome": "refused", "reason": "not a number" }
      ]
    }
  ]
}
```

**A place is keyed by its id, which nothing but a decision changes.** The id is the place's owner and
its duration, in camelCase, parted by a dot, spelled out ([0003](0003-one-word-one-meaning.md)):
`call.timeout`, `httpTransportServer.maximumWait`. It names no words of a refusal, so the words move
and the key stays. A place carries besides:

- `name`, what it is, for a reader;
- `kind`: `delay`, a wait before an act, which takes 0 as at once, or `timeout`, any other — a
  timeout, a bound, the heartbeat's period — which 1.4 never lets be 0;
- `never`: `taken`, held without end, arming nothing; `refused`, where its clause says it may not be
  without end (12.2, 15.12), and at every delay, which 1.4 never lets be without end; or `default`,
  held as its default, which 10.3 gives a call id's reservation alone. `neverClause` names the clause
  that says so, where 1.4 does not alone;
- `ways`, each way its surface takes that duration, by an id stable in the place: a reserve and a
  cancel, each transport's connect, a reconnection's delay as a function and as a number. A way whose
  duration cannot be left out, an argument or an option its type requires, is `required`;
- `default`, where a clause states one: its milliseconds or never, its clause, the ways a harness
  builds with nothing given to read it, none of them `required`, and the `state` it holds in where it
  holds only so — a reserve or a cancel of no call, since a cancel of a call that waits, given none,
  reserves for that call's own timeout; a session under a manager given none of its defaults; the
  server layer over a transport that gives it none;
- `observed`: `held`, what the place holds is read, at every place on the clock a side is given;
  `refusal`, whether it refuses alone, at the two on the real clock (0011), the heartbeat and the
  close timeout, whose timers no test clock reaches. A place observed by its refusal has no default
  in the file, since nothing would read it;
- `clauses`, the units of the spec it checks, each for what it observes of it, and nothing else:
  1.4, which holds and refuses its durations; its `neverClause`; and its default's clause.

|   # | Id                                                | Ways                                                               | Clauses             | Kind    | Never   | Default        | Observed |
| --: | ------------------------------------------------- | ------------------------------------------------------------------ | ------------------- | ------- | ------- | -------------- | -------- |
|   1 | `call.timeout`                                    | `serviceManager`, `router` (required)                              | 1.4, 9.9            | timeout | taken   | 5 s, 9.9       | held     |
|   2 | `serviceManager.defaultTimeout`                   | `options`                                                          | 1.4, 9.9            | timeout | taken   | 5 s, 9.9       | held     |
|   3 | `router.reservation`                              | `reserve`, `cancel`                                                | 1.4, 10.3           | timeout | default | 5 s, 10.3      | held     |
|   4 | `router.transferInactivityTimeout`                | `limits`                                                           | 1.4, 12.2, 12.2.8   | timeout | refused | 30 s, 12.2.8   | held     |
|   5 | `relay.timeout`                                   | `relay`, `register`                                                | 1.4, 14.4           | timeout | taken   | never, 14.4    | held     |
|   6 | `sessionManager.connectionInactivityTimeout`      | `options`                                                          | 1.4, 13.7           | timeout | taken   | never, 13.7    | held     |
|   7 | `sessionManager.sessionInactivityTimeout`         | `options`                                                          | 1.4, 13.7           | timeout | taken   | never, 13.7    | held     |
|   8 | `session.inactivityTimeouts`                      | `setConnection`, `setSession`, `updateConnection`, `updateSession` | 1.4, 13.7           | timeout | taken   | never, 13.7    | held     |
|   9 | `sessionManager.resetConnectionInactivityTimeout` | `reset` (required)                                                 | 1.4, 13.7           | timeout | taken   | none           | held     |
|  10 | `sessionManager.resetSessionInactivityTimeout`    | `reset` (required)                                                 | 1.4, 13.7           | timeout | taken   | none           | held     |
|  11 | `server.connectionInactivityTimeout`              | `options`                                                          | 1.4, 13.7           | timeout | taken   | never, 13.7    | held     |
|  12 | `httpTransportServer.exchangeTimeout`             | `options`                                                          | 1.4, 15.12, 15.12.8 | timeout | taken   | 5 min, 15.12.8 | held     |
|  13 | `httpTransportServer.inactivityTimeout`           | `options`                                                          | 1.4, 15.12, 15.12.9 | timeout | taken   | 5 min, 15.12.9 | held     |
|  14 | `httpTransportServer.maximumWait`                 | `options`                                                          | 1.4, 15.12, 15.12.7 | timeout | refused | 30 s, 15.12.7  | held     |
|  15 | `httpTransportClient.inactivityTimeout`           | `options`                                                          | 1.4, 15.12, 15.12.9 | timeout | taken   | 5 min, 15.12.9 | held     |
|  16 | `httpTransportClient.wait`                        | `options`                                                          | 1.4                 | delay   | refused | left out       | held     |
|  17 | `httpTransportClient.pause`                       | `options`                                                          | 1.4                 | delay   | refused | left out       | held     |
|  18 | `webSocketTransport.heartbeat`                    | `client`, `server`                                                 | 1.4, 15.3           | timeout | taken   | none read      | refusal  |
|  19 | `transportClient.connectTimeout`                  | `http`, `webSocket`, `worker`                                      | 1.4                 | timeout | taken   | left out       | held     |
|  20 | `transportClient.reconnectionDelay`               | `function`, `number`                                               | 1.4                 | delay   | refused | left out       | held     |
|  21 | `webSocketTransportServer.closeTimeout`           | `options`                                                          | 1.4                 | timeout | taken   | none read      | refusal  |

Place 11 is the server layer's option, which 13.7 leaves without end when not given; an HTTP server
gives its own 30 s (15.12.10), which `spec/transports.json`'s `defaults` holds and both sides check,
and the place's `state` says so. Place 15 is the HTTP client's inactivity timeout, which 15.12 names
for both sides: 5 minutes by default, and without end if given so. Place 17's at once is 15.10's
"listen again at once", stated with a schedule no file checks: the file leaves it out, as it leaves
out the defaults no clause states. Place 21 is the server's alone: the C# client's close timeout is
the client part's to align with the TypeScript client, which has none, and stays an open row of the
matrix (0011).

**One table of inputs serves every place.** An input is given in one of five forms, each a value a
user writes on every platform:

- `milliseconds`, a JSON number: the TypeScript side gives it as it is, the C# side through
  `TimeSpan.FromMilliseconds`;
- `seconds`, a JSON number, as a user writes seconds: `seconds * 1000` and `TimeSpan.FromSeconds`,
  each platform's own arithmetic — 0.41 s is 410 ms in JavaScript and 409.9999 ms in .NET, 2.01 s
  2009.9999999999998 ms and 2009.9999 ms;
- `never`: `Infinity` and `Timeout.InfiniteTimeSpan`, which RFC 8259 §6 leaves JSON without;
- `nan`: IEEE 754's NaN, which JSON has no number for either;
- `json`: a value that is no number, a string or a boolean, as a limit read from JSON may be.

The table holds 19 inputs, each named: 0; 0.00001 ms, under a tick; half a millisecond; a
millisecond; 1.4 ms; 1.5 ms; 2.5 ms, which a half to the even would hold as 2; 0.41 s and 2.01 s as
written; the ceiling; 0.00001 ms past the ceiling, under a tick past it; 0.4 ms past the ceiling,
which would round into it, refused as given as half a millisecond is refused at the floor; half a
millisecond past the ceiling; never; −2 ms; −1 ms; NaN; `"1000"`, a string of digits; and `true`.

**Each place has an outcome for every input, written out.** An outcome is `held`, with the whole
milliseconds held; `at once`; `never`; `default`, with the milliseconds of the default it is held
as; `taken`, at a place observed by its refusal, for an input it does not refuse, with nothing held;
or `refused`, with its reason: `under the floor`, `past the ceiling`, `0 refused`, `never refused`, or
`not a number`. The rounding is a half away from zero, IEEE 754's roundTiesToAway, which ECMAScript's
`Math.round` and .NET's `MidpointRounding.AwayFromZero` both give on a positive value; the generator
rounds so, never with Python's `round`, which takes a half to the even.

**The reason is derived, and held by the regeneration alone.** The generator derives it from the
input, the place's kind and its never; no harness reads it. It pins why a duration is refused, never
the words that say so: a duration's refusal is thrown to the application, never sent, where the
vectors pin a refusal's detail because it goes on the wire; and
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) keeps a problem's type apart from its words alike.
A side that reports a refusal by a code checks the reason against that code. No surface changes for
it: the TypeScript and C# sides word one sentence for every reason.

**The generator plays both platforms.** Each outcome is 1.4 over the input's value as written. Beside
it, the generator plays each platform's conversion — JavaScript's arithmetic on a double, and .NET's
`TimeSpan`, the double multiplied into ticks and truncated — and runs 1.4 over what each reaches. It
fails on any outcome, held value or reason a platform reaches otherwise, unless that outcome, or its
input, crosses a row of the matrix for that language; on a row an input names that nothing crosses;
and on an input in seconds within a tick of a half, as written or as either platform computes it,
since a value so near a half rounds with its platform's error. JavaScript reaches 1.4's outcome at
every input. .NET reaches another at three: under a tick, 0.00001 ms is `TimeSpan.Zero`, at once at
a delay and refused as 0 elsewhere; 0.00001 ms past the ceiling is truncated onto the ceiling, and
held; and −1 ms is `Timeout.InfiniteTimeSpan`, never where never is taken, the default where never is
held as one, and refused as never where never is refused.

**A difference crosses its row, where it crosses.** A `differs` names a row of
`docs/support.md` and the language the row excuses, at three levels:

- on an input the language cannot be given at all: NaN, `"1000"` and `true` are no value a
  `TimeSpan` holds, and cross "A duration that is not a number", a platform row;
- on a way the language lacks: the Web Worker's connect, which crosses "The Web Worker transport",
  and a reconnection's delay given as a number, which crosses "A reconnection's delay given as a
  number", an open row;
- on an outcome the language reaches otherwise: −1 ms crosses "A duration of -1 ms" at every place,
  the five that refuse never among them, where the C# side refuses it as never rather than under the
  floor; the two inputs finer than a tick cross "A duration finer than a tick" at every place.

The row names `spec/durations.json` and what crosses it, between backticks: the input's name, or the
place's id and the way's. A harness plays every input at every place and way but those a `differs`
excuses its language from, at whichever level: the C# side plays 13 inputs a place and 29 of the 31
ways, the TypeScript side all.

**Each side plays the file in one harness, through one helper.** The helper reads the file whole,
from `spec/`, never a copy, and gives the inputs as its side is given them: on the TypeScript side
`transport/shared/__tests__/durations.ts`, on the C# side `tests/Shared/Durations.cs`, linked with the
file into each test project that uses it. The harness is the TypeScript side's
`server/__tests__/durations.test.ts`, in the folder whose tests already build every layer, and the
C# side's `DurationsTests`, in `Bead.Transport.Http.Tests`, which references every assembly holding a
place. Each keeps a table from each place and way to a function that builds the place on the side's
test clock, given one input or none, and reports:

- what it holds, at a place observed `held`: an option or a call's options read back, the due of the
  timer it arms on the test clock (`delaysOn`, `SteppingClock.Dues()`), or the `wait` a listen asks;
  at once, no timer armed and the act done; never, no timer armed;
- whether it refused, at a place observed `refusal`;
- a refusal: the side's refusal of a duration — a `ProgrammerError`, or an
  `ArgumentOutOfRangeException` whose parameter is the option — whose words are the whole sentence
  the side's words function builds from the place's phrase, its kind, its never and the input as
  written; and nothing moved, which each way checks of its own place.

A place with a default is built by each way its default names, with nothing given, in its state, and
holds it. Each harness fails when its table's places or ways are not the file's, one more or one
less. The TypeScript side plays a test a place, each way and input labelled; the C# side a theory
over the ids. The six HTTP places are observed `held`: the server's timers armed on the test clock,
the `wait` a client's listen asks, and the timers of its pause and its inactivity.

**Each way keeps what its loop asserted besides the outcome**, and a way no loop reached gains its
own. The C# side checks its refusal's parameter, the option, besides.

| Place                                   | Way                           | What it keeps                                                                                                                                                                                                             |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call.timeout`                          | `serviceManager`              | the timeout held, alike in the call's trace and in the request its router is handed; refused, no trace, no deprecation notice, nothing handed on                                                                          |
| `call.timeout`                          | `router`                      | no answer a millisecond short of the timeout, and the call ended at it, its timeout error telling it; never, waiting on past the ceiling; refused, no call id drawn, nothing sent                                         |
| `serviceManager.defaultTimeout`         | `options`                     | the timeout its router is handed for a call given none; refused as the manager is built                                                                                                                                   |
| `router.reservation`                    | `reserve`, `cancel`           | the call id reserved a millisecond short of what is held, free at it; refused, nothing reserved and no cancel sent                                                                                                        |
| `router.transferInactivityTimeout`      | `limits`                      | the limit read back from the router                                                                                                                                                                                       |
| `relay.timeout`                         | `relay`, `register`           | the timeout of leg B's request, each given with the other left out                                                                                                                                                        |
| `sessionManager.*InactivityTimeout`     | `options`                     | the timeout a session set with that timeout left out holds; refused as the manager is built                                                                                                                               |
| `session.inactivityTimeouts`            | each                          | the timeout the session returned holds; refused, nothing stored, the session as it was, its timers as they were                                                                                                           |
| `sessionManager.reset*`                 | `reset`                       | the due of the timer it arms beside the other timeout's; never, none armed; refused, the timers as they were                                                                                                              |
| `server.connectionInactivityTimeout`    | `options`                     | a silent connection open a millisecond short of what is held, closed at it; never, open past the ceiling; refused, nothing listening on its transport                                                                     |
| `httpTransportServer.*`                 | `options`                     | the due of the timer armed: an exchange handed on, a connection with none under way, a listen asking a longer wait; refused, no server built                                                                              |
| `httpTransportClient.*`                 | `options`                     | the `wait` its listen asks; the due of its pause's timer, none at once; the due of its inactivity's timer at a listen's first loss; refused, no client built                                                              |
| `webSocketTransport.heartbeat`          | `client`, `server`            | taken or refused, as the transport is built                                                                                                                                                                               |
| `transportClient.connectTimeout`        | `http`, `webSocket`, `worker` | connecting a millisecond short of what is held, timed out at it, its error telling it, then closed; never, connecting until aborted; refused, nothing sent or opened, the client uninitialized and a reconnection refused |
| `transportClient.reconnectionDelay`     | `function`, `number`          | the delay its tap hears, the due of its wait, the attempt at it and not before; refused, the tap hearing nothing, no attempt more, the client closed                                                                      |
| `webSocketTransportServer.closeTimeout` | `options`                     | taken or refused, as the transport is built                                                                                                                                                                               |

**The words stay with each side.** Each side keeps a phrase a place, in its own words and its
language's case, beside the table that builds it, and one words function, beside the helper, which
writes its sentence from a phrase, a kind, a never and an input: what it offers besides — 0 for at
once at a delay, never where never is taken — and the value written, a string quoted on the
TypeScript side; a fraction with a dot under any culture, and never as `infinite` rather than −1, on
the C# side. The twins of each side's assertion, `clock.test.ts` and `ClocksTests`, take the file's
inputs through the helper and hold the assertion's one sentence over every input, with one sentence
of each offer written out whole, so the words function answers to a sentence a reader can see. Each
platform's word for never, `Infinity` and `infinite`, is its side's: this record settles none.

**The spec states what the file checks.** Section 1 names its file,
`_Durations: spec/durations.json._`, as sections 9 to 14 name the conversations and 14 and 15 the
transports. 1.4 gains two sentences: a side MUST refuse a value that is no number — NaN, or a string
or a boolean, as a limit read from JSON may be; and a delay is a wait before an act — a pause, a
reconnection's wait, the `wait` a client's listens ask — never without end, which takes 0 as at
once. 15.12 says that a client times its own inactivity by `inactivityTimeout`, its default and
whether it may be without end alike, and 15.10 names the timer so; 15.9 says that the `wait` a
server reads is its peer's, where the `wait` a client's listens ask is its application's. The
defaults no clause states are left out of the file — a client's connect of 30 s, its `wait` of
25 s, its reconnection's 1 s, a WebSocket server's close of 5 s — with the pause's at once, and stay
with the tests of their place on each side; the client part states them, by its decision, and the
file gains them then, citing their clauses.

**The defaults two files state come from one table.** 15.12's defaults are `spec/transports.json`'s
`defaults` too: `make_durations.py` and `make_transports.py` read them from one module of the
generators, `spec/generators/bounds.py`, so the two files cannot disagree.

**The rule has its gate** (0006). `spec/check.py` holds:

- the file under its schema, and the spec's version;
- no two inputs of one name, no two places of one id, no two ways of one id in their place;
- every place an outcome for each input, once, in the inputs' order;
- every place citing 1.4, its `neverClause` and its default's clause, and nothing else, each a unit
  of the spec, counted against `spec/uncited.txt`;
- a default read by ways its place has, none of them `required`;
- a `differs`, on an input, a way or an outcome, naming a row of `docs/support.md` that names
  `spec/durations.json` and what crosses it between backticks; a transports' case's row names the
  case so too;
- a `_Durations:` line naming a file of `spec/`, as `_Conversations:` and `_Transports:` lines do;
- on each side, the helper alone reading the file, so a twin reads it through the helper, and the
  harness naming every place's id, so a harness gone, or one that plays fewer places, fails;
- its summary counting the places, the ways and the inputs.

Its schema says the rest: one form an input; `held` exactly for `held` and `default`; `reason`
exactly for `refused`; `taken` only, with `refused`, at a place observed by its refusal, which has no
default; no `at once` at a timeout; a default's milliseconds where never is held as the default; and
`differs`, which moves to `common.schema.json` for both files that use it. The check does not compute
1.4 again: the generator does, and the regeneration holds the file to it.

**1.4 and 12.2 leave `spec/uncited.txt`; 15.10 stays.** Every place cites 1.4; the transfer's
inactivity cites 12.2, which says it is never without end. 15.10's schedule and its last listen are
checked by no file, so no place cites it. The other units the places cite — 9.9, 10.3, 12.2.8, 13.7,
14.4, 15.3, 15.12 and 15.12.7 to 15.12.9 — are cited already.

## Consequences

**No surface changes.** The file holds what both sides do: no option, no type and no word moves.
Where a harness finds a place that does not hold 1.4 — at an input no table held, 2.5 ms, 0.4 ms past
the ceiling or `true`, or at a place none reached, a session timeout's reset, the heartbeat, the
values the HTTP places hold — the fix lands with it, and the changelog says so.

**Two tables and 33 loops give way to one harness a side.** What each loop asserted besides the
outcome moves into its way. Four loops stay, taking the file's inputs through the helper: the
assertions' twins, `clock.test.ts` and `ClocksTests`, which keep the words; the TypeScript
`createPromise`'s, a helper no application gives a duration to; and the C# client's close timeout,
which plays place 21's outcomes until the client part decides.

**A place added is a row of the file and a way in each table**, which the gate finds missing from a
harness. Nothing finds a place that calls the assertion with no row: review holds it, as a
preference (0006).

**Each side keeps a phrase a place and a words function**, and a C side that joins maps each reason to
its code.

**The spec's minor moves** with the release that carries the file and 1.4's two sentences: a file
added, which every implementation's tests must read, and a refusal stated
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).

**A client's durations are held by a file before its behaviour is.** The matrix's sentence that a
client is held to the other side by the interop alone gains its exception: what a client holds of a
duration it is given is the durations file's.

**The matrix gains three rows**: "A duration finer than a tick" and "A duration that is not a
number", platform, and "A reconnection's delay given as a number", open; "A duration of -1 ms" and
"The Web Worker transport" name the file's input and way.

## The Tenth Man

The draft met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)), and
the user chose where it asked: the defaults no clause states left out of the file, and the HTTP
transports' six places observed `held`, as the draft recommended. Its objections, each with its
answer:

| Objection                                                                                                                                                                                                        | Answer                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A duration finer than a tick reaches another outcome on the C# side, and neither the file nor the matrix says so                                                                                                 | Accepted: two inputs finer than a tick cross a platform row, "A duration finer than a tick"; the generator plays both conversions, and fails on an outcome either reaches otherwise that crosses no row, and on an input in seconds within a tick of a half. |
| The reason the file pins is read by no harness, and is false of the C# side at −1 ms where never is refused                                                                                                      | Accepted, the user's choice: the reason is derived, held by the regeneration alone, with no surface change; −1 ms crosses its row at every place, the five that refuse never among them; the twins hold one sentence over every input.                       |
| `spec/check.py`'s new lines pass for the wrong reason: the twins meet the read gate, `differs` matches inside words, names are unique where ids are the key, and `uncited.txt` stops telling what no file checks | Accepted: one helper a side alone reads the file, the twins through it, and the harness names every place; a row names the file and what crosses it between backticks; ids are unique; a place cites only what it observes; 15.10 stays uncited.             |
| The ways a place is reached are in no file, so nothing holds them alike, and three differences have no row                                                                                                       | Accepted: each place lists its ways by a stable id, each harness keys its table by place and way, and a way one language lacks crosses its row: the Web Worker's connect, and a reconnection's delay given as a number, an open row.                         |
| The file pins outcomes no clause states: the refusal of what is no number, and which places are delays                                                                                                           | Accepted, the user's choice: 1.4 states both, a value that is no number refused, and a delay a wait before an act — a pause, a reconnection's wait, the `wait` a client's listens ask.                                                                       |
| At each place, the harness checks less than the loops it replaces                                                                                                                                                | Accepted: each harness builds its side's whole sentence by a words function kept outside the file, and each way keeps what its loop asserted, listed above.                                                                                                  |
| 15.12 names its timeouts for both sides, yet the HTTP client's 5 minutes were left out                                                                                                                           | Accepted, the user's choice: 15.12 says a client times its inactivity by `inactivityTimeout` alike, 15.10 names the timer, and the client's place cites 15.12.9 and holds its 5 minutes.                                                                     |
| A default that depends on state or on the transport passes for the wrong reason when its place is built with nothing given                                                                                       | Accepted: a default names the ways that read it and the state it holds in, a way that cannot leave its duration out is `required`, and the server layer's default says an HTTP server gives its own 30 s.                                                    |
| The places observed by their refusal carry held values and defaults no harness reads                                                                                                                             | Accepted, the user's choice: such a place writes `taken`, with no `held`, and has no default in the file.                                                                                                                                                    |
