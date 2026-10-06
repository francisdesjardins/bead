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

**A cancel on leg A cancels leg B.** A destination on a connection of the relay's own dies with that
connection, so a newcomer under the same handle is never taken for it. An answer names its call
alone, so no RESULT or FAILURE carries a destination: an id means something to its relay only.

**A relay carries no subscription**: it refuses a request that opens one with
`SUBSCRIPTION_UNSUPPORTED` (22), the code of any path that carries no notification back. A relay
that carries one is a decision of its own.

**It forms no chain**: leg B names no destination, so no loop can form, and nothing is routed past
the relay.

## Consequences

**Every requester behind a relay shares its leg B**: one space of call ids, and the target's
transfer places. One that presents none or `OPAQUE` shares its session at the target too: the
relay's admission, which sees the procedure and the destination, is where its rights are checked,
and the target sees the relay alone. One that presents a `JWT` or an `ELSEWHERE` runs at the target
in the session its own credential resolves to, which the target verifies
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)).

**A client behind a relay subscribes to nothing**: what it would be notified of stops at the relay,
and so does a paced subscription ([0002](0002-a-subscription-goes-at-its-clients-pace.md)).

**A relay is played as a conversation across connections**, against each side's own relay, and a
relay across languages, one side's relay in front of the other's destination, is open work: until
the interop plays one, a relay's two legs' limits and the session its requesters share are held by
each side's twin tests ([0004](0004-one-behaviour-in-every-language.md)).

**The rule is section 14 of [`spec/spec.md`](../../spec/spec.md)**, and `spec/conversations.json`
plays it against every implementation's relay.
