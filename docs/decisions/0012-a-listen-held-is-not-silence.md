# 0012 — A listen held is not silence, and a connection without a session is its server's

- **Status**: accepted
- **Scope**: spec 13.7, 15.1, 15.9 and 15.12: the inactivity timeouts of a connection and of its
  connection's session, on every transport; every implementation's server layer, HTTP transport and
  session manager; the interop service's `login` and `register`. A credential's session is
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s.

## Context

A connection and its connection's session end once silent, by the server's timeouts and the
session's (13.7). Over HTTP, a client that only listens, as section 15.10 asks of one, sends no
envelope while its listen is held, up to `maximumWait`'s 30 s, its own wait 25 s: a timeout
restarted by envelopes alone closes it. Two timers due at one instant run in no order on .NET's
thread pool. A connection left without a connection's session must still be bounded, or a `login`
then a `logout` escapes every bound a server sets. And a default that ends an idle connection is a
policy: no connection-level standard closes one by default (RFC 6455 has none; gRPC's
`MAX_CONNECTION_IDLE` is infinite), and a session's idle limit, where one exists, is minutes, and a
re-authentication policy of the application's (OWASP ASVS 4.0.3 V3.3.2: 30 minutes at level 2, 15 at
level 3).

Counting a listen at its start was weighed: a listen held longer than a connection timeout is still
cut, and two timers due at one instant race. Keeping an ended session's connection timeout for its
connection was weighed, against 13.7, which gives a connection without a session the server's own:
it lets a `login` then a `logout` escape. For the defaults, 10 minutes and 30 s, 10 minutes and 30
minutes, and never for both were weighed.

## Decision

**A listen held is not silence.** Over HTTP, while a listen is held on a connection, none of its
connection timeouts runs — the server's own, a session's connection timeout — and silence counts
anew from its end, as the Bayeux long poll counts its interval from the end of a poll, and as the
HTTP transport's own `inactivityTimeout` counts. The transport tells a listen taken, past its
refusals, and its end (15.1; a listen is 15.9's): `listen` on the TypeScript side, `Listen` on the
C# side, an optional event of the transport's contract that a transport without listens never
raises. A connection's session's session timeout, and its `lastActivity`, count messages alone: a
connection's session idles out alike over every transport. Over WebSocket, and over a Web Worker
alike, a peer that only hears is silent: it speaks now and then, or is given a connection timeout
without end. A transport that keeps no connection of its own states what silence is on it, with what
stands for a connection there
([0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)).

**A connection without a session is its server's.** With no connection's session yet, or its
connection's session ended, it takes the server's own connection timeout, counted afresh from that
session's end. Section 15.12 names that timeout for an HTTP server, `connectionInactivityTimeout`,
30 s, so a server drawn connections by any `POST` lets one never used go.

**A timeout not given is without end.** A connection's session stored without its timeouts holds
both without end, as one made by `create` does; an application that authenticates gives its own, and
the session manager's documentation names ASVS's values. A credential's session has no timeout: it
ends at its end, when the application ends it, or with its connection
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)).

**The interop service follows.** `login` takes `sessionTimeout` and `connectionTimeout`, in
milliseconds, and `register` its timeout, each held as spec 1.4 holds a duration, by the assertion
of each side; a value refused fails the procedure, `PROCEDURE_FAILED`, and opens or registers
nothing.

## Consequences

**An application that wants an idle connection or session closed gives its timeouts**: none ends one
by default, and the session manager's documentation names ASVS's values.

**Every server counts the listens a connection holds**, `listening` among its gauges on both sides,
which a health check reads as it reads the others; both session managers reset either timeout alone.

**One order differs, and the count absorbs it.** The TypeScript transport tells a listen that takes
another's place before the end of the one it replaces; the C# transport tells them on their
requests' threads, in no order. The server counts both alike; the support matrix has the row.

**One more order differs, and the cases wait it out.** The C# transport arms a listen's wait before
it tells the listen, the TypeScript one after; in the transports' file, an `until timer` waits for
the earliest timer armed to be the one it names, and alone so due, so a timer the listen is about to
clear never fires first.

**A WebSocket peer that only hears needs to speak**, or a connection timeout without end: its pings
are the platform's, and reach no layer (0011).

**The transports' file and the conversations play each rule here**, the clock advanced: among them,
a listen held for its wait and for the server's bound, a session ending during a held listen, and a
session's connection restarted by its messages.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)),
which weighed the timeout after a session's end and the defaults too. Its objections, each with the
answer that holds:

### On the timeouts

| Objection                                                                                                                                              | Answer                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Counting a listen at its start leaves a listen longer than a connection timeout cut, and two dues at one instant racing                                | Accepted: a listen held holds the connection timeouts, silence counting anew from its end.                            |
| A listen restarting the session timeout makes a session's life depend on its transport, and the C# side lacks a way to hold a connection's timer alone | Accepted: a session timeout counts messages alone, and both session managers reset either timeout alone.              |
| Over WebSocket, a peer that only hears is closed and nothing says so                                                                                   | Accepted: 13.7 says what silence is on each transport.                                                                |
| The transfers' cases pass with a stale timer left beside the new one                                                                                   | Accepted: each restart is shown by an advance across the old due, then a send.                                        |
| A conversation cannot see a connection stay                                                                                                            | Accepted: the session's end plays over WebSocket, where a close is a frame.                                           |
| No case pins the timeout after a session's end                                                                                                         | Accepted: a case over HTTP, the server's own counted from the session's end.                                          |
| The HTTP server's own 30 s is a default no clause states                                                                                               | Accepted: a row of 15.12, a default of the transports' file, an option of its cases.                                  |
| Over a socket, an advance past its timer's due lets what the timer causes read the clock anywhere in between                                           | Accepted: in the transports' file, an advance ends at most on the due its `until` named, which `spec/check.py` holds. |
| `login`'s timeouts would be read two ways, as `register`'s were                                                                                        | Accepted: both through each side's duration assertion.                                                                |
| The schemas take durations past the ceiling, and refuse keys the harnesses read                                                                        | Accepted: every duration from 1 to 2³¹ − 1, and the keys read allowed.                                                |
| The idle and exchange cases show a close, not the rule they cite                                                                                       | Accepted: a listen held holds the idle timer off, and the exchange's cut stands behind its 404.                       |

### On the cases

| Objection                                                                                                                                                           | Answer                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| On the C# side, a listen's wait is armed before the listen is told, so an `until` that finds the wait lets the advance fire the timer the listen was about to clear | Accepted: an `until timer` in the transports' file waits for the earliest timer armed, alone so due.                  |
| The session's end case passes with the server's own timeout left running beside a live session                                                                      | Accepted: the session outlives that due, a message crossing it, before its end gives the connection the server's own. |
| No case shows that a session timeout counts messages alone                                                                                                          | Accepted: a listen ended before the one held shows the session's timeout restarted by none.                           |
| The listen cases cannot tell silence counted anew from a timer paused and resumed                                                                                   | Accepted: the clock moves before the listen, so the two give different dues.                                          |
