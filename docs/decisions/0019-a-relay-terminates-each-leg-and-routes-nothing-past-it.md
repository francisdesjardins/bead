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
connection, so a newcomer under the same handle is never taken for it. An answer names its call
alone, so no RESULT or FAILURE carries a destination: an id means something to its relay only.

**A relay carries no subscription**: it refuses a request that opens one with
`SUBSCRIPTION_UNSUPPORTED` (22), the code of any path that carries no notification back. A relay
that carries one is a decision of its own.

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
relay across languages, one side's relay in front of the other's destination, is open work: until
the interop plays one, a relay's two legs' limits and the session its requesters share are held by
each side's twin tests ([0004](0004-one-behaviour-in-every-language.md)).

**The rule is section 14 of [`spec/spec.md`](../../spec/spec.md)**, and `spec/conversations.json`
plays it against every implementation's relay.

## The Tenth Man

The decision meets the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md))
in one round, on the answer leg A cannot carry, which
[0001](0001-the-envelope-sits-at-fixed-offsets.md) points here for the rule of spec 9.0 it states: a
failure a side answers for an error of its own carries none of that error. Its objections, each
with the answer that holds:

### On the answer leg A cannot carry

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The case named, a transport that refuses the answer or a socket that closed, never sends a second answer: the router marks the call answered before its transport has the answer, and a second answer on it goes nowhere (spec 9.4); twin tests that stand a mock in the router's place pin an envelope the router forbids                                                                                                                    | Accepted: the twin tests play the real router, whose leg A's transport refuses the relayed result: one result handed over, nothing after it, the reason reported with leg A's connection. Spec 14.5 says that an answer its transport did not take goes nowhere again, and is reported |
| A result past leg A's limit is answered `PAYLOAD_TOO_LARGE` through a relay and `PROCEDURE_FAILED` by a server's own resolver, the same situation; 34 says the request was refused at its admission (spec 8.1) though the procedure ran, inviting a requester to send a procedure that is not idempotent again, and with no relay crossed it also means spec 14.3's sixth step: one code, two meanings ([0003](0003-one-word-one-meaning.md)) | Accepted, and decisive: the relay answers it `PROCEDURE_FAILED` with no detail, whatever refused it, as spec 12.1 answers a result its side cannot send, its reason reported; a conversation plays it, a result that fits crossing beside it                                           |
| "With no detail", written in spec 14.5 alone, invites the reading a contrario for spec 9.5, 11.6, 12.1, 9.2's sixth step and 17.2's fifth item, and no case pins an empty detail                                                                                                                                                                                                                                                              | Accepted: the rule is stated once, in spec 9.0, beside what a side reports and what it answers, and the conversations of 9.5, 11.6 and 12.1 pin an empty detail                                                                                                                        |
| An envelope's codec that throws other than a refusal has its message put in `ENVELOPE_MALFORMED`'s detail on the TypeScript side, a message a peer's bytes reach, where the C# side puts none                                                                                                                                                                                                                                                 | Accepted: nothing of the error in the failure, both sides alike, the error reported, and a twin test on each                                                                                                                                                                           |
| "The failure that refused it" calls a closed socket a refusal, which the spec's words never do (spec 15.6, [0003](0003-one-word-one-meaning.md))                                                                                                                                                                                                                                                                                              | Accepted: spec 14.5 says why the answer did not go out                                                                                                                                                                                                                                 |
