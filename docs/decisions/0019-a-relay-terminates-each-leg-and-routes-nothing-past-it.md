# 0019 — A relay terminates each leg between two transports, and routes nothing past it

- **Status**: accepted
- **Scope**: the protocol, and every implementation's relay: section 14 of
  [`spec/spec.md`](../../spec/spec.md). What a relay does with a credential is
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s.

## Context

A relay stands between two transports, each a leg of its own: a requester's on leg A, a destination
behind it on leg B, each destination answering the same procedures. It passes a payload on
undecoded, and reads the header alone ([0001](0001-the-envelope-sits-at-fixed-offsets.md)).

A relay could also pass a request on to another relay, and so on: a request on its way further would
need a count or a list of the relays it crossed, as IP's TTL counts the hops a packet crossed and
HTTP's `Via` lists the intermediaries a message crossed (RFC 9110 §7.6.3).

## Decision

**A relay terminates each leg**, as a gateway does for what stands behind it. A request that names a
destination is asked the relay's admission on its header, then whether its destination exists, then
the smaller of both legs' limits; every refusal falls on the opening, and a requester not admitted
learns only whether the relay has any destination. It then goes on to its target as a request of the
relay's own, its payload's bytes undecoded, under a call id of that leg. The answer comes back under
the requester's call id: a result as it came, a failure of the target's one relay more.

**What the relay raises itself says how far the request went**, as every code does:
`DESTINATION_UNREACHABLE` (17) while the relay's transport was never handed the request, or refused
it, so nothing was tried, and `DESTINATION_LOST` (65) once that transport had it and the target was
lost, the procedure run or not: HTTP's gateway 502 against its 504, and what gRPC's retry rules turn
on. Those failures name no address behind the relay: why leg B failed is reported where the relay
runs.

**An answer leg A cannot carry is the relay's own `PROCEDURE_FAILED`, with no detail**, whatever
refused it: the relay terminates leg A, so a result past leg A's limit is a result its side cannot
send, which spec 12.1 answers so, and why it did not go out is reported with leg A's connection.
`PAYLOAD_TOO_LARGE` (34) would say the request was refused at its admission, while the destination's
procedure ran, and invite its requester to send a procedure that is not idempotent again; with no
relay crossed, it would besides mean what spec 14.3's sixth step refuses, one code with two meanings
([0003](0003-one-word-one-meaning.md)). An answer leg A's transport did not take goes nowhere again:
a call is answered once (spec 9.3, 9.4, 14.5).

**A cancel on leg A cancels leg B.** A destination on a connection of the relay's own dies with that
connection, and stays unreachable until it is registered anew, on another connection, since no
connection takes a handle its transport gave before
([0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md)); one registered
on a connection its router no longer holds is closed from its registration. An answer names its call
alone, so no RESULT or FAILURE carries a destination: an id means something to its relay only.

**A destination's id is the application's to give, and the relay checks nobody.** It stays taken
until its registration takes it out, its connection closed or not, and a second registration of it
is refused; each destination the relay lists says whether its connection closed, and a registration
that `replaces` the one it names takes its id in its place at once, so that no request meanwhile
finds the destination unknown. Who may register which destination is the application's, as who may
reach one is its `beforeRoute`'s (spec 14.1, 14.7).

**A relay carries no subscription**: it refuses a request that opens one with
`SUBSCRIPTION_UNSUPPORTED` (22), the code of any path that carries no notification back. One that
carries a subscription is ahead, by a decision of its own, which a page across a broker needs.

**It forms no chain**: leg B names no destination, so no loop can form, and nothing is routed past
the relay.

## Consequences

**A requester behind a relay shares its leg B's session only where its admission says so.** Every
requester shares leg B's call ids and transfer places. A server's relay admits by default only a
credential it forwards, `requireCredential`: one that presents none or `OPAQUE` is refused
`ACCESS_DENIED`, its detail naming the default, since leg A's session opens nothing at the target,
and a relay that lent leg B's session to any session of leg A's would be the deputy that lends its
own authority (Hardy, 1988; [CWE-441](https://cwe.mitre.org/data/definitions/441.html)). Sharing it
is written: a `beforeRoute` of the application's, which sees the procedure and the destination and
checks the one against the requester's session; or `shareLegBSession`, which lends it to every
session at every destination, and is named for it. A requester so admitted shares leg B's session at
the target, which sees the relay alone. One that presents a `JWT` or an `ELSEWHERE` runs at the
target in the session its own credential resolves to, which the target verifies
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)).

**A client behind a relay subscribes to nothing**: what it would be notified of stops at the relay,
and so does a paced subscription ([0002](0002-a-subscription-goes-at-its-clients-pace.md)).

**A relay is played as a conversation across connections**, against each side's own relay, and a
relay across languages in the interop, one side's relay in front of the other's destination, is
ahead, in the twin tests' place: until the interop plays one, a relay's two legs' limits and the
session its requesters share are held by each side's twin tests
([0004](0004-one-behaviour-in-every-language.md)).

**The rule is section 14 of [`spec/spec.md`](../../spec/spec.md)**, and `spec/conversations.json`
plays it against every implementation's relay.

## The Tenth Man

The decision meets the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md))
in two rounds: one on the answer leg A cannot carry, which
[0001](0001-the-envelope-sits-at-fixed-offsets.md) points here for the rule of spec 9.0 it states: a
failure a side answers for an error of its own carries none of that error; and one on a destination
whose connection closed, at xhigh effort. Their objections, each with the answer that holds:

### On the answer leg A cannot carry

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The case named, a transport that refuses the answer or a socket that closed, never sends a second answer: the router marks the call answered before its transport has the answer, and a second answer on it goes nowhere (spec 9.4); twin tests that stand a mock in the router's place pin an envelope the router forbids                                                                                                                    | Accepted: the twin tests play the real router, whose leg A's transport refuses the relayed result: one result handed over, nothing after it, the reason reported with leg A's connection. Spec 14.5 says that an answer its transport did not take goes nowhere again, and is reported |
| A result past leg A's limit is answered `PAYLOAD_TOO_LARGE` through a relay and `PROCEDURE_FAILED` by a server's own resolver, the same situation; 34 says the request was refused at its admission (spec 8.1) though the procedure ran, inviting a requester to send a procedure that is not idempotent again, and with no relay crossed it also means spec 14.3's sixth step: one code, two meanings ([0003](0003-one-word-one-meaning.md)) | Accepted, and decisive: the relay answers it `PROCEDURE_FAILED` with no detail, whatever refused it, as spec 12.1 answers a result its side cannot send, its reason reported; a conversation plays it, a result that fits crossing beside it                                           |
| "With no detail", written in spec 14.5 alone, invites the reading a contrario for spec 9.5, 11.6, 12.1, 9.2's sixth step and 17.2's fifth item, and no case pins an empty detail                                                                                                                                                                                                                                                              | Accepted: the rule is stated once, in spec 9.0, beside what a side reports and what it answers, and the conversations of 9.5, 11.6 and 12.1 pin an empty detail                                                                                                                        |
| An envelope's codec that throws other than a refusal has its message put in `ENVELOPE_MALFORMED`'s detail on the TypeScript side, a message a peer's bytes reach, where the C# side puts none                                                                                                                                                                                                                                                 | Accepted: nothing of the error in the failure, both sides alike, the error reported, and a twin test on each                                                                                                                                                                           |
| "The failure that refused it" calls a closed socket a refusal, which the spec's words never do (spec 15.6, [0003](0003-one-word-one-meaning.md))                                                                                                                                                                                                                                                                                              | Accepted: spec 14.5 says why the answer did not go out                                                                                                                                                                                                                                 |

### On a destination whose connection closed

| Objection                                                                                                                                                                                                                                                                                                                                                                 | Answer                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A destination behind a connection that closed can never come back on a real transport: its id stays taken, and the interop service and the conversation of a destination dead with its connection rely on a connection opened again taking its old handle back, which spec 15.1 and [0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md) forbid | Accepted: the conversation opens the device again as a new connection, under a handle never given, as each side's scripted player draws one when a name opens again, and that connection registers the destination anew and takes the next relayed call; it is among the conversations played in memory, 170 of the 175 |
| The relay should free the id of a destination whose connection closed, or let any register take it                                                                                                                                                                                                                                                                        | Refused: registering an id that is taken stays refused, closed or not, and the policy stays the application's: it decides who may register which destination, as its `beforeRoute` decides who may reach one; spec 14.1 says so, and that the relay checks nobody                                                       |
| An application that holds the policy cannot see which destinations are dead: the relay counts them, its `closedDestinations` gauge, and lists none of them as such                                                                                                                                                                                                        | Accepted: each destination the router lists says whether its connection closed, `IDestination.isClosed` and `Destination.IsClosed`, its registration's as it is now; spec 14.4 says so                                                                                                                                  |
| Unregistering then registering again leaves a window in which a relayed call is answered `DESTINATION_UNKNOWN`, and on the C# side another thread's register in between                                                                                                                                                                                                   | Accepted: an opt-in `replaces` on `registerDestination` takes the registration the caller holds, and the new one takes its id at once, under the relay's one lock on the C# side; a `replaces` that is not the registration of that id now is a programmer error, which the doc comments state                          |
| A registration on a handle the router no longer holds is forwarded to: a closed handle registered again is asked as if its connection were open                                                                                                                                                                                                                           | Accepted: such a registration is created closed, unreachable at once and never forwarded to, from what the router holds; spec 14.4 says so                                                                                                                                                                              |
| A register that lands before the router has heard the close finds the destination open                                                                                                                                                                                                                                                                                    | Accepted as the rule stands: it is refused as any id taken, and a registration that replaced it in that window is closed with the close, which twin tests pin on both sides                                                                                                                                             |
| The interop service keeps each connection's last destination past its close, for whichever connection takes its handle next, a bookkeeping that holds only of a handle given twice                                                                                                                                                                                        | Accepted: it keeps its registrations by destination id; `register` checks nobody, refuses `REGISTERED_ALREADY` only a destination whose connection is open or one that is no connection's, and replaces one whose connection closed; `unregister` takes out its caller's own; `spec/interop-service.json` says so       |

### On an exchange whose outcome is unknown

The round on an HTTP exchange whose outcome is unknown
([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)) bounds "nothing was tried": a leg whose
executor was called and failed may have reached its destination, so its send counts as handed over
and the relay answers `DESTINATION_LOST`, never `DESTINATION_UNREACHABLE`.
