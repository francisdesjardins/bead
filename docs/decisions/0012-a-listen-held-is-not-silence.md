# 0012 — A listen held is not silence, and a connection without a session is its server's

- **Status**: accepted
- **Scope**: spec 13.7, 15.1 and 15.12; every implementation's server layer, HTTP transport and session
  manager; the interop service's `login` and `register`; the conformance cases that advance a clock

## Context

The cases that advance a clock ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md))
needed an inventory of every timed rule, and three of them did not hold:

- **A listen was silence.** The server layer's own connection timeout, 30 s on an HTTP server, was
  started anew by envelopes alone. A client that only listens, as section 15.10 asks of one, was
  closed at 30 s; a listen held to `maximumWait`'s 30 s was due with that close and ended 404
  `connection-unknown`, not 204; and with the client's own wait of 25 s, the second listen was cut 5 s
  in.
- **A session's end kept its connection timeout.** Once a session ended, both sides armed its
  connection with the ended session's connection timeout — never, for one opened by `login` — where
  13.7 gives a connection without a session the server's own: a `login` then a `logout` escaped every
  bound a server sets.
- **A session's defaults defeated each other.** A session stored without its timeouts held 600 ms for
  its connection and 30 s for itself. Both restart on the same messages, so only the shorter ever
  fired, and 600 ms cut every HTTP listen and every WebSocket client between two messages.

Counting a listen at its start was weighed and set aside: a listen held longer than a connection
timeout was still cut, and two timers due at one instant raced, in no order on .NET's thread pool.
Keeping the ended session's timeout, as the code did, was weighed against 13.7, and set aside for the
escape above. For the defaults, 10 minutes and 30 s, 10 minutes and 30 minutes, and never for both
were weighed: no connection-level standard closes an idle connection by default (RFC 6455 has none;
gRPC's `MAX_CONNECTION_IDLE` is infinite), and a session's idle limit, where one exists, is minutes,
and a re-authentication policy of the application's (OWASP ASVS 4.0.3 V3.3.2: 30 minutes at level 2,
15 at level 3).

## Decision

**A listen held is not silence.** Over HTTP, while a listen is held on a connection, none of its
connection timeouts runs — the server's own, a session's connection timeout — and silence counts
anew from its end, as the Bayeux long poll counts its interval from the end of a poll, and as the
transport's own `inactivityTimeout` already counted. The transport tells a listen taken, past its
refusals, and its end (15.1): `listen` on the TypeScript side, `Listen` on the C# side, an optional
event of the transport's contract that a transport without listens never raises. A session's
session timeout, and its `lastActivity`, count messages alone: a session idles out alike over every
transport. Over WebSocket, a peer that only hears is silent: it speaks now and then, or is given a
connection timeout without end.

**A connection without a session is its server's.** None yet, or its session ended, it takes the
server's own connection timeout, counted afresh from its session's end. Section 15.12 names that
timeout for an HTTP server, `connectionInactivityTimeout`, 30 s, so a server drawn connections by any
`POST` lets one never used go.

**A timeout not given is without end.** A session stored without its timeouts holds both without
end, as one made by `create` does; an application that authenticates gives its own, and the session
manager's documentation names ASVS's values. With the typed credential
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)), a session also ends with its token.

**The interop service follows.** `login` takes `sessionTimeout` and `connectionTimeout`, in
milliseconds, and `register` its timeout, each held as spec 1.4 holds a duration, by the assertion of
each side; a value refused fails the procedure, `PROCEDURE_FAILED`, and opens or registers nothing.

## Consequences

**The defaults change, which breaks an application that relied on them**: 600 ms and 30 s become
never; a connection whose session ended takes the server's own timeout, where it kept the session's.
The changelog says each.

**Every server carries one more count**, the listens a connection holds, `listening` among its gauges
on both sides, which a health check reads as it reads the others; the C# session manager gains the
TypeScript one's two resets, which closes that row of the support matrix.

**One order differs, and the count absorbs it.** The TypeScript transport tells a listen that takes
another's place before the end of the one it replaces; the C# transport tells them on their requests'
threads, in no order. The server counts both alike; the support matrix has the row.

**One more order differs, and the cases wait it out.** The C# transport arms a listen's wait before it
tells the listen, the TypeScript one after; in the transports' file, an `until timer` waits for the
earliest timer armed to be the one it names, and alone so due, so a timer the listen is about to
clear never fires first.

**A WebSocket peer that only hears needs to speak**, or a connection timeout without end: its pings
are the platform's, and reach no layer (0011).

**The cases that advance a clock play all of it**, and three more besides: a listen held for its wait
and for the server's bound, a session ending during a held listen, and a session's connection
restarted by its messages.

## The Tenth Man

The design met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)), which
was also asked to weigh the two questions the user left open, the timeout after a session's end and
the defaults: it recommended what the decision holds. Its objections, each with its answer:

| Objection                                                                                                                                              | Answer                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Counting a listen at its start leaves a listen longer than a connection timeout cut, and two dues at one instant racing                                | Accepted: a listen held holds the connection timeouts, silence counting anew from its end.                            |
| A listen restarting the session timeout makes a session's life depend on its transport, and the C# side lacks a way to hold a connection's timer alone | Accepted: a session timeout counts messages alone, and the C# side gains the two resets.                              |
| Over WebSocket, a peer that only hears is closed and nothing says so                                                                                   | Accepted: 13.7 says what silence is on each transport.                                                                |
| The transfers' cases pass with a stale timer left beside the new one                                                                                   | Accepted: each restart is shown by an advance across the old due, then a send.                                        |
| A conversation cannot see a connection stay                                                                                                            | Accepted: the session's end plays over WebSocket, where a close is a frame.                                           |
| No case pins the timeout after a session's end                                                                                                         | Accepted: a case over HTTP, the server's own counted from the session's end.                                          |
| The HTTP server's own 30 s is a default no clause states                                                                                               | Accepted: a row of 15.12, a default of the transports' file, an option of its cases.                                  |
| Over a socket, an advance past its timer's due lets what the timer causes read the clock anywhere in between                                           | Accepted: in the transports' file, an advance ends at most on the due its `until` named, which `spec/check.py` holds. |
| `login`'s timeouts would be read two ways, as `register`'s were                                                                                        | Accepted: both through each side's duration assertion.                                                                |
| The schemas take durations past the ceiling, and refuse keys the harnesses read                                                                        | Accepted: every duration from 1 to 2³¹ − 1, and the keys read allowed.                                                |
| The idle and exchange cases show a close, not the rule they cite                                                                                       | Accepted: a listen held holds the idle timer off, and the exchange's cut stands behind its 404.                       |

The cases as written met the Tenth Man again, which brought only what would flake or prove less
than a case's name:

| Objection                                                                                                                                                           | Answer                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| On the C# side, a listen's wait is armed before the listen is told, so an `until` that finds the wait lets the advance fire the timer the listen was about to clear | Accepted: an `until timer` in the transports' file waits for the earliest timer armed, alone so due.                  |
| The session's end case passes with the server's own timeout left running beside a live session                                                                      | Accepted: the session outlives that due, a message crossing it, before its end gives the connection the server's own. |
| No case shows that a session timeout counts messages alone                                                                                                          | Accepted: a listen ended before the one held shows the session's timeout restarted by none.                           |
| The listen cases cannot tell silence counted anew from a timer paused and resumed                                                                                   | Accepted: the clock moves before the listen, so the two give different dues.                                          |
