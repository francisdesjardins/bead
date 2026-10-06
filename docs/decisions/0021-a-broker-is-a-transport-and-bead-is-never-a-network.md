# 0021 — A topic-based publish/subscribe broker is one more transport, and Bead is never a network of its own

- **Status**: accepted
- **Scope**: every implementation, and the spec's section 15. What a broker's transport owes is
  decided by records of its own, under this one; a relay is
  [0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)'s.

## Context

Bead is typed two-way RPC, with notifications at the client's pace, transfers under credit and
sessions, alike in a tab, a Web Worker and a server. Where it goes, a topic-based publish/subscribe
broker often joins the services and the devices already: it reaches every participant, authenticates
each client, and carries what a topic is given. A call across such a system needs what topics alone
lack — an answer bound to its request, a failure and its code, a cancel, each client's own pace, a
payload past a message's bound — and that is what Bead carries.

Two ways reach many participants.

- **A network of Bead's own**: nodes that route envelopes between them, find each other, share a
  session's state across servers, and pass a request on through as many relays as it takes. It
  needs no broker, and costs what a broker already does, written again in every language: discovery,
  membership, routes, and a guard against a loop, as IP's TTL counts the hops a packet crossed and
  HTTP's `Via` lists the intermediaries a message crossed
  ([RFC 9110 §7.6.3](https://www.rfc-editor.org/rfc/rfc9110#section-7.6.3)). Its conformance is a
  topology, which no exchange of two sides plays. A federated network, in this record's one sense:
  nodes of Bead that take each other's routes and sessions as their own.
- **A broker as a transport**: the broker carries envelopes as a WebSocket does, and what makes Bead
  stays at each end. A request goes to a topic its procedure names, and what answers it comes back
  on the client's own channel, as AMQP 0-9-1's `reply-to` and `correlation-id` properties carry a
  reply. JSON-RPC 2.0 is transport agnostic in the same way, used "within the same process, over
  sockets, over http, or in many various message passing environments". It costs what a broker does
  not give a socket: no connection, a fan-out with no credit per client, a delivery that may repeat
  and a message it bounds, no order across topics, and a client the server never sees, which the
  broker vouches for.

The end-to-end argument (Saltzer, Reed and Clark, 1984) weighs between them: what the ends must hold
anyway — Bead's router, at each end of a call — gains nothing from being done again between them.

## Decision

**A topic-based publish/subscribe broker is one more transport.** It carries envelopes as a
transport does (section 15.1): each whole, and each handed on to its router once, what may overtake
stated in its section. It reads of an envelope only what its section states. The envelope, the
router, the sessions, the transfers, the notifications and the relays stay as they are at each end
of what stands for a connection, and an application's API is the same over a broker as over a
WebSocket, generated or written by hand.

**Bead is never a network of its own.** It routes nothing past one relay, finds no peer, and shares
no session's state between servers: a credential's session is resolved where its call runs. A
request crosses one relay at most: a relay terminates each leg, and leg B names no destination
([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)). A call that must reach a
participant no connection of its side reaches goes through a broker that reaches it.

**A relay joins a broker to another transport**, as it joins any two
([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)): a page on a WebSocket
reaches a participant behind a broker through one.

**One core, and one adapter a broker.** What a broker's transport does that depends on no broker is
one core in each implementation; an adapter brings one broker's client, and names the capabilities
it has, some of them optional. What the core holds, point by point, is decided with the transport.

**What a broker's transport owes is decided with it**, each point by a record of its own: what
stands for a connection, its session and its end; several participants that offer one procedure, and
where a call's cancel, chunks and credits then go; pacing, where a broker's fan-out has no credit per
client, and whether a notification goes to each subscriber's channel, or once to a topic many read;
delivery, how its transport hands the router each request once when the broker repeats one, and the
bound a broker sets on a message; the topics, their tree and their names; and the contract an
adapter meets. Its credential is [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s:
`ELSEWHERE` is the case it is made for, and what carries it over a broker is decided with the
transport.

## Consequences

**Bead has no topology.** No discovery, no membership, no routes, no count or list of hops: a
deployment that needs many nodes brings its broker, and the spec states two sides and at most one
relay between them. What a federated network would add is refused here, not left for later.

**Every behaviour holds over a broker, or is a row.** A subscription at its client's pace, a
transfer under credit, a cancel and a session play over a broker's transport as over any other, or
the support matrix says which broker leaves which out, and why
([0004](0004-one-behaviour-in-every-language.md)): a capability one broker lacks is never a
difference of the protocol.

**A relay bridges calls, not subscriptions.** A page behind a relay to a broker subscribes to
nothing while a relay carries no subscription, which is open
([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)); and a participant behind a
second relay, past the broker, is out of its reach, since leg B names no destination.

**A broker's transport states what may overtake, and keeps a request's copy from the router.** A
broker keeps no order across topics: a request goes to its procedure's topic and what follows it to
the participant's own, so a cancel can overtake its request, as over HTTP (section 15.5), and its
section says what may overtake and what the side that answers does of it. A broker that delivers at
least once repeats a message, and a request's copy is what the router cannot tell from a new
request: one that comes while its call is open, or held as a subscription, is reported (section 9.2,
step 2); one that comes once its call ended runs again; one that comes once its requester drew that
call id again is answered on the new call, which takes another procedure's result as its own
(sections 9.1, 9.7). So the transport hands its router each request once, and how is its delivery
record's.

**The broker's transport plays the conformance files and the interop**, as HTTP's and the
WebSocket's do ([0004](0004-one-behaviour-in-every-language.md)): named connections and a clock
advanced are there to start from, and its own part of the files is decided with it.

**One word keeps one meaning** ([0003](0003-one-word-one-meaning.md)): "federation" names the network
this record refuses, and nothing else; services that trust one issuer are named so
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)).

## The Tenth Man

The course met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) as
the records were realigned, and again with this record. Its objections, each with the answer that
holds:

### On the course

| Objection                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions shared across servers, a direction the course withdrew, are stated as live in [0010](0010-a-request-presents-a-credential-of-a-scheme.md)                                                                           | Accepted: the clause is gone from 0010, and this record refuses it: no session's state is shared between servers.                                                                                                                                                                                                                           |
| The record cites 15.1 as asking what a broker does, while 15.1 asks "in order on each connection", which a broker does not keep                                                                                              | Accepted: 15.1 changes first, its round in [0001](0001-the-envelope-sits-at-fixed-offsets.md): order and a single copy are a connection's default, which a transport's section may lift, stating what may overtake and what a copy is.                                                                                                      |
| A request's copy: a subscription's call stays open once answered, so its copy is reported; and one that comes once its call id is drawn again answers the new call with another's result, which no dedupe by call id catches | Accepted in part: the Consequences name each case, the wrong answer among them, and the Decision has the transport hand its router each request once, as 15.1 asks of every transport. Refused: deciding here how, by the identity a broker gives a message: that is the delivery record's.                                                 |
| "Carries envelopes between two sides" decides a pacing mode left open, a notification published once to a topic many read                                                                                                    | Accepted: the Decision says "as a transport does (section 15.1)", and the pacing point names both modes open. One published once would meet 11.1, which binds a notification to one call id, and is the pacing record's to weigh.                                                                                                           |
| The relay the record names as the bridge carries no subscription and forms no chain, and the record states neither cost                                                                                                      | Accepted: **A relay bridges calls, not subscriptions** states both, and the decisions' README names a relay that carries a subscription, open, under the broker's transport.                                                                                                                                                                |
| One core and one adapter a broker were taken with the course, yet the record leaves them out while it lists the adapter's contract as open                                                                                   | Accepted in part: the record states the split in one paragraph, as the user chose. What the core holds, point by point, stays the transport's records', since the topics and the reply channel wait on them.                                                                                                                                |
| "Routes nothing between nodes" is false of a relay, and "keeps no session across servers" reads against a credential's session, one identifier across servers                                                                | Accepted: Bead routes nothing past one relay, finds no peer, and shares no session's state between servers, a credential's session resolved where its call runs.                                                                                                                                                                            |
| "As every transport does" is false of the Web Worker, which plays neither the transports' cases nor the interop                                                                                                              | Accepted: the broker's transport plays them as HTTP's and the WebSocket's do.                                                                                                                                                                                                                                                               |
| `Via` is a list, not a count, `Max-Forwards` is HTTP's count, and "pub/sub" is an abbreviation                                                                                                                               | Accepted in part: IP's TTL counts and `Via` lists, here and in [0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md); "publish/subscribe" is written whole ([0003](0003-one-word-one-meaning.md)). Refused: `Max-Forwards`, defined for TRACE and OPTIONS alone (RFC 9110 §7.6.2), which guards no request against a loop. |
| 0010's "whichever server takes its procedure" decides how several participants share one, which stays open                                                                                                                   | Accepted: 0010 says "a server that takes its procedure", and points here.                                                                                                                                                                                                                                                                   |
