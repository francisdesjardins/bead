# 0040 — A broker's adapter offers bytes at topics, and Bead keeps its own credit, credential and heartbeat

- **Status**: accepted
- **Scope**: the protocol, and every implementation's core: in [`spec/spec.md`](../../spec/spec.md),
  the credential a broker's transport carries, its security and who may serve a name, in 15.22; a
  broker that paces no call, what waits for it, nothing retained, and the bounds of a participant and
  its server's transport, in 15.23; the adapter's contract and the in-memory broker, in 15.24; the
  heartbeat of 15.21, and its participant fenced once its link is taken over; the life the core
  gives an OPEN, in 15.18, and a DATA that carries a credential, in 15.22; what 13.4, 13.7 and
  14.3's step 5 count of a broker; the broker cases of
  [`spec/transports.json`](../../spec/transports.json) of a credential, security, notifications, a
  transfer, a retained message, the heartbeat, a queue's overrun, the lives a client asks and a
  link taken over; the place
  `brokerParticipant.heartbeat` and the way `broker` of `transportClient.connectTimeout` in
  [`spec/durations.json`](../../spec/durations.json); the twins of the participant, the in-memory
  broker and the heartbeat. A credential's scheme is
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s; the clock
  [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)'s; placement and the open
  [0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)'s,
  which keeps this record's round of the Tenth Man; parcels and parts
  [0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)'s;
  the in-memory transport beside the in-memory broker
  [0036](0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md)'s.

## Context

**A broker paces its links, never a call.** MQTT 5's Receive Maximum (§4.9), AMQP 1.0's link credit
(§2.6.7) and a NATS subscription's pending bytes hold what one link has in flight, shared by every
connection of a participant. A notification published once to a topic many read would carry one
call id for many (spec 11.1), one session for many (11.3, 13.6) and one pace for many
([0002](0002-a-subscription-goes-at-its-clients-pace.md)).

**A broker tells no subscriber who published.** MQTT 5 and core NATS give a subscriber a message and
its topic; AMQP 1.0's `user-id` "MAY be authenticated by intermediaries" (Messaging §3.2.4), which
RabbitMQ validates. A broker authenticates each participant to itself: by a username and password,
MQTT 5's authentication exchange (§4.12), SASL, an NKey or a user JWT.

**No broker pings a connection of Bead's.** A link's keep-alive, MQTT's `PINGREQ` among them, says
the link lives, not the peer at the other end of one connection.

**A broker's queue for a subscriber is bounded, and a full one drops**: Mosquitto 2.1.2 holds 20
QoS 1 messages in flight a client and queues 1,000 above them (`max_inflight_messages`,
`max_queued_messages`), and past `max_queued_bytes` a message is "silently dropped"; EMQX 6.3.2's
`max_inflight` is 32 and `max_mqueue_len` 1,000. Every client's parcels to a server cross its
participant's one link, so a server participant's queue fills first.

The options weighed:

- **A notification once to a topic many read**: 11.1, 11.3 and 0002 refuse it.
- **The broker's word as `ELSEWHERE`**, a publisher's identity it vouches for: no capability MQTT 5
  or core NATS gives.
- **Secure by a sender's own leg**: a bearer credential would cross the far leg in the clear, though
  that leg is another participant's, which knows its own security.
- **A heartbeat every interval, whatever comes**: four parcels a connection a beat, where one owed
  on a silent connection alone does.
- **The heartbeat on the clock a side is given**: against
  [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md), which runs a WebSocket's ping
  on the real clock, its platform timing it on the C# side, so that every side's heartbeat plays
  alike.
- **AMQP as the core**: its model of exchanges and queues would become Bead's; it is one binding
  among others, which proves the core common.

## Decision

**An adapter brings one broker's client and offers bytes at topics** (spec 15.24), the same members
on every side, name for name, each in its language's case: its handles' type, `BROKER` in memory;
the id its broker authenticates its link by; to start a link that keeps no broker session, with its
will where it takes one; to subscribe a topic, alone or in a group, said held once its broker holds
it; to let one go, said let go once its broker did; to publish a payload to a topic, said taken once
its broker took it, or as it goes at most once, or refused, `no-subscriber` where its broker says
so; each message, with its topic, its payload and its acknowledgement; its link lost, and whether
another link of its id took it over; the largest payload a message to a topic carries, asked by the
topic, its inbox's among them, since a binding counts a topic in each message; the delivery it
gives, at least once, its broker acknowledging each publication it took and the adapter itself, not
its library, holding what it publishes to the quota its broker gives, or at most once; whether its
leg is secure; and to end its link cleanly, so no will goes. It names its optional capabilities:
`groups`, `will`, `noSubscriber` and `expiry`, a message's life in its broker; a name served by
several participants needs `groups`. So a broker's library stays in its adapter, and the core
depends on none. The Rust side's handles' type is `transport_type`, and its messages and its link
down come to a `BrokerListener` it hands `listen`.

**Each side's core holds an in-memory broker** of that contract, with every optional capability:
topics and subscriptions, alone and in groups, a group's members chosen in turn; each message copied
as it is published and handed on in a later turn than its publish, in the order its publisher
published to that topic, once; a bound per message and a queue bound per subscriber it is given,
none by default, past which a message is dropped as a full broker queue drops one; a delivery level
it is given, at least once by default; `noSubscriber` refusals; expiry on its clock; wills published
as a link is lost, never at a stop; and, on a test's word, the next message copied, held behind the
one after it, dropped, or handed again to another member of its group, and a participant's link
lost, or taken over by another of its id, its subscriptions dropped and its will published as a
real takeover's are. It never leaves the process, so it is secure. A broker in memory is a broker,
which repeats, reorders and drops on purpose, and plays the conformance with no broker's binding.

**Bead keeps its own credit, end to end** (spec 15.23): a paced subscription's notifications by
their count (11.8 to 11.11), a transfer's chunks by their bytes (12.4), over the connection like any
envelope. A notification goes to its subscriber's inbox, on its connection and its call id, and
never once to a topic many read. The broker's own flow control is its link's, and paces no call.

**What waits for its broker is bounded at both ends** by `maximumUnsentBytes`, 15.12's formula: a
parcel its adapter has not had taken that would pass it loses its connection, a CLOSE of 4000,
reported naming the bound. **Nothing is retained**: a side subscribes so that its broker hands it
nothing retained, MQTT's Retain Handling 2, and drops in silence a retained message that comes all
the same.

**The credential a request presents is carried in its DATA, toward the server alone** (spec 15.22):
a client's transport carries any field value (15.5) on the first part of the DATA that carries the
request, and a request presenting `ELSEWHERE` stands for it, never for the broker's authentication
of the participant that published it; a credential renews without a new connection, as over HTTP. A
server's transport carries none, so a server's command presenting `ELSEWHERE` over a broker fails
before it goes, `DESTINATION_UNREACHABLE` (13.4), and a client closes with 1002 a connection whose
server's DATA carries one.

**A broker's transport is secure while its own leg and its peer's are**: an OPEN and an ACCEPT carry
`SECURE` when their sender's own leg is, its adapter's connection under TLS, its broker on the
loopback as 13.4 judges a URL, or in memory; a client's `isSecure` follows its connection, read per
call. So a bearer credential, a `JWT` or an `ELSEWHERE`, crosses only legs under TLS or within a
machine ([RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750#section-5.3)). The broker reads what
crosses it, as a proxy that terminates TLS does, which is the deployment's trust; a credential waits
in its broker's queue, so the core gives the first part of a DATA that carries one a life in its
broker, twice `heartbeat`, where its adapter offers `expiry`, so that it waits there no longer than
a live connection may be silent, and each binding states that a broker's persistence may hold it at
rest. An OPEN lives its connect's time left alike, so that one no participant took in time is
deleted in its broker rather than taken late; no other parcel has a life, a parcel deleted unsent
being a loss the heartbeat finds.

**A server's transport serves by its broker's word**: it starts once its broker holds each name
it serves, a name refused failing its start, and stops once it let each go; its gauge `names`
counts a name from its broker's acknowledgement of the subscription to its acknowledgement of the
unsubscription, MQTT's SUBACK and UNSUBACK, AMQP 1.0's ATTACH that names its source and its
DETACH.

**A participant whose link is taken over is fenced** (spec 15.21): its adapter says its link went
down for another link of its id, and the participant closes each connection, unclean, reports it,
and connects no more until its application starts it again, so that two holders of one id never
take each other over without end; the later link keeps the id. MQTT 5 says it by a DISCONNECT of
0x8E, and its will is the link's Will of Delay 0
([0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md)).

**Who may serve a name is the broker's access control**, by the id it authenticates: a participant
alone subscribes its inbox, its will alone writes its departure, the server's participants alone
subscribe its name, and its clients publish to it, each binding naming the patterns its broker writes
them in, as a DNS name and its certificate place a socket's server. A participant allowed to serve
a name receives the bearer credentials its clients present.

**A heartbeat of Bead's own, on a silent connection** (spec 15.21): each end PINGs a connection once
nothing of it has come for `heartbeat`, 30 s by default or never, and closes it with 4001 when
nothing of it has come by `heartbeat` after that PING; any parcel answers, as TCP sends a keep-alive
only when nothing came within its interval
([RFC 9293 §3.8.4](https://www.rfc-editor.org/rfc/rfc9293#section-3.8.4)), and a PING waits behind
what was sent before it. It runs on the platform's timer on every side, as a WebSocket's does: the
TypeScript side's `heartbeat.ts` on `globalThis`, the C# side's `Heartbeat.cs`, its twin, on
`TimeProvider.System`'s timer, and the Rust side's `broker/heartbeat.rs` on its `SystemClock`, never
the clock its participant is given. A PING, a PONG and a CLOSE are no messages for 13.7's timeouts,
so over a broker, as over a WebSocket, a peer that only hears is silent.

## Consequences

**The heartbeat costs four parcels a connection a beat** on an idle one, each acknowledged on both
legs: about 1,333 a second through a server participant's link at 10,000 connections and 30 s. A
peer that keeps sending while it reads nothing is not found by it, as TCP's keep-alive finds none:
its own broker's queue overruns, its gap loses the connection
([0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)),
and its CLOSE of 4000 tells the other end.

**A broker's link is shared**: one participant's acknowledgements go as it takes each message, so a
slow call never stalls the others on its link; what paces a call is Bead's credit.

**A server's bearer credentials are its broker's to read**, and its persistence's to hold for a
message's life: the deployment's to weigh, each binding stating it.

**Ahead**: an acceptor that proves itself to its opener
([0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)); a
publisher's identity a broker vouches for, standing for an `ELSEWHERE`, RabbitMQ's validated
`user-id` its way over AMQP 1.0
([0043](0043-over-amqp-1-0-a-participant-is-one-connection-whose-exclusive-inbox-ends-with-it-and-a-parcel-one-message-of-one-profile-each-counted-to-its-byte.md));
and a relay that carries a subscription, which a page across a broker needs
([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)).

**No interop over the in-memory broker**: it joins no two processes, so the interop over a broker
is each binding's, against a real broker in CI, MQTT 5's
([0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md))
and AMQP 1.0's ([0043](0043-over-amqp-1-0-a-participant-is-one-connection-whose-exclusive-inbox-ends-with-it-and-a-parcel-one-message-of-one-profile-each-counted-to-its-byte.md)), each a row of [`docs/support.md`](../support.md).

**Its gates**: the broker cases of `spec/transports.json` of a request presenting `ELSEWHERE` with
its DATA's credential and without, a client not secure by its acceptor's leg, a client refusing a
server's credential, notifications to two subscribers at their own credit, a transfer under credit,
a retained message, the heartbeat in real time and a queue's overrun; the place
`brokerParticipant.heartbeat` and the way `broker` of `transportClient.connectTimeout`; and the
twins of the participant, the in-memory broker and the heartbeat, those holding 15.24 naming it,
each named by one sentence on every side.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
the round of the broker's core, which
[0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md) keeps:
its objections on a security by both legs, on the heartbeat's clock and its cost, on a broker's
queue the in-memory broker lacked and on the broker's word are answered there.
