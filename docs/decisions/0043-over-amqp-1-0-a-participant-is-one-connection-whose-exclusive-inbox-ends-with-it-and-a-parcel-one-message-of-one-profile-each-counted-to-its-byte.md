# 0043 — Over AMQP 1.0, a participant is one connection whose exclusive inbox ends with it, and a parcel one message of one profile, each counted to its byte

- **Status**: accepted
- **Scope**: the protocol, and every implementation's AMQP 1.0 adapter: in
  [`spec/spec.md`](../../spec/spec.md), section 15's `### AMQP 1.0 on RabbitMQ 4`, 15.32 to 15.38,
  over the core 15.16 to 15.24 unchanged; the cases of
  [`spec/transports.json`](../../spec/transports.json) over `amqp`, and its `brokers.amqp`; the
  groups `amqpMessages` and `amqpPublishBounds` of [`spec/vectors.json`](../../spec/vectors.json),
  written by `spec/generators/amqp_messages.py`, the profile's reference writer; the places
  `amqpBrokerAdapter.idleTimeout` and `amqpBrokerAdapter.connectTimeout` of
  [`spec/durations.json`](../../spec/durations.json); `tools/amqp-broker.mjs`, the broker every run
  plays against, on `tools/broker-fixture.mjs`, which `tools/mqtt-broker.mjs` shares; the adapters
  over rhea and AMQPNetLite and their twins; the interop over AMQP 1.0 and its CI job. The core it
  binds is
  [0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)'s,
  [0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)'s
  and
  [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)'s;
  the first binding, MQTT 5's,
  [0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md)'s;
  the bounds [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s; a duration
  [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s.

## Context

**What AMQP 1.0 gives, and what it lacks.** Outcomes on an unsettled transfer: `accepted`,
`released` — "the message was not and will not be acted upon" — `rejected` and `modified`
(Messaging §3.4); link credit, the receiver's to grant (Transport §2.6.7); a refused link, an ATTACH
with a null source or target and a DETACH (§2.6.3); a `max-message-size` on each ATTACH, past which a
delivery is a `message-size-exceeded` link error, unset meaning none (§2.7.3); an idle-time-out each
end announces as half what it enforces (§2.4.5); a header `ttl` in milliseconds (Messaging §3.2.1);
the anonymous terminus, a sender whose messages each name their destination by `to`. A value has
several valid encodings, and a reader takes any (Types §1.6). AMQP 1.0 has no will, no takeover and
no group name: what a broker does with queues and exchanges is its own.

**What RabbitMQ 4 gives.** Addresses v2, `/exchanges/<exchange>/<routing-key>` and
`/queues/<queue>`; a management over a link pair (Link Pairing v1.0, HTTP over AMQP), which declares
a queue and binds it in two requests, none doing both; exclusive queues, owned by their declaring
connection and deleted with it; topic permissions on topic exchanges alone, so `amq.default` is
narrowed by no key; per-message TTL, an expired message never delivered; a `max_message_size`, 16 MiB
by default, on every publisher's ATTACH; `session_max_per_connection`, 64 by default; a `heartbeat`,
60 s by default, a client silent for three of it called dead; a `user-id` checked against the
authenticated user. It answers an access it refuses by ending the session, not the link. The
open-source RabbitMQ 4.4 ships no AMQP over a WebSocket.

**What the libraries do of their own.** rhea 3.0.5 reconnects by default; a receiver accepts on its
own and restores a window of 1,000 credits as messages arrive; a sender transfers past its credit if
asked, which RabbitMQ answers by detaching the link; its own encoder writes an empty header and a
`list32` of properties, so a message's size is no formula; it keys a session's links by name alone,
so a paired receiver opened beside its sender of one name replaces it in the index; and it batches
adjacent dispositions of mixed outcomes under the first. AMQPNetLite 2.5.4 has no reconnection of
its connection factory; `Start(credit, …)` and `SetCredit(n)` restore credit on their own, where
`SetCredit(n, CreditMode.Manual)` does not; `SendAsync` treats `released` as an exception; it writes
every message through section encoders that are `internal abstract`, so no message goes already
written. RabbitMQ.AMQP.Client 1.4.1 exposes neither a peer's `max-message-size` nor manual credit,
recovers on its own by default, and is licensed `Apache-2.0 AND MPL-2.0`.

**What the probes found**, against `rabbitmq:4.4.0-management` by its digest, Erlang/OTP 29.1.2,
through rhea 3.0.5 and AMQPNetLite 2.5.4:

- the profile's writer and AMQPNetLite 2.5.4's `Message.Encode()` wrote the same bytes on 120 of
  120 rows — three addresses, five payloads across `vbin8` and `vbin32`, eight ttls across `uint0`,
  `smalluint` and `uint` — and the count `S` matched every one;
- an inbox declared exclusive on its owner's connection, 201 then 200, bound, 204, stays exclusive
  once its management's session ends: the connection owns it, not the session; a second connection
  of the id declaring it is answered 400, "cannot obtain exclusive access to locked queue", and its
  receiver is detached `amqp:resource-locked`;
- a delivery carries the bare message as published, byte for byte, behind RabbitMQ's own header, 11
  to 15 bytes, and its `x-routing-key` and `x-exchange` annotations: 64 bytes past what was published
  without a life, 55 with one;
- a receiver's `max-message-size` of 4,096 takes a delivery of 4,096 bytes and answers one of 4,097
  by ending the receiver's session, `amqp:link:message-size-exceeded`, while its publisher reads
  `accepted`;
- a topic that reaches no queue is `released`, the session kept; a malformed `to` is `rejected`
  `amqp:precondition-failed`; an exchange or a topic the user may not write, or `amq.default`, ends
  the session `amqp:unauthorized-access`, another session of the same connection publishing still;
  a receiver of a missing queue is attached with a null source and detached `amqp:not-found`; one of
  a queue the user may not read ends its session;
- an inbox ends within 2 to 3 ms of its owner's close or reset; 3 runs of 10 took one publication
  `accepted` meanwhile;
- a message of a ttl of 200 ms behind a live one, or at the head with no credit given, is never
  delivered once its life passed;
- an owner gone silent — its process reading nothing, its socket held open — is called dead after
  three of its broker's `heartbeat` and its socket closed at four: 30 s and 40 s at a `heartbeat` of
  10, 180 s and 210 s at the default 60, its inbox declared anew at once after, every declaration
  before it answered 400; the owner's own idle-time-out, 0 or 30,000, shortens none of it, and a
  publication to the dead inbox meanwhile is taken and queued;
- a connection's OPEN names a `channel-max` of 63, 64 sessions; a publisher's first credit is 170;
- a receiver detached holding an unsettled delivery has it handed back on the same connection,
  `delivery-count` 1, and a `released` copy comes behind later deliveries on one link: 1, 2, 3, 1, 4.

The options weighed:

- **One session for everything**: each access refused ends it, so a participant serving a name its
  broker denies would lose its link at each subscription, relink a second later and lose it again,
  every connection dropped each turn.
- **One session for every name, the others attached again after a refusal**: a denied subscription
  ends the session under every pending one, which the adapter cannot tell apart without reading
  RabbitMQ's description, so subscriptions would go one at a time.
- **A sending session per name for OPENs**: a denied OPEN would fail no other, at a session each
  against the same 64, for a misconfiguration whose collateral is one round trip.
- **The inbox a receiver-scoped, auto-delete queue**: one declared and not yet consumed outlives a
  link that died before its ATTACH, any user its permissions grant may consume a non-exclusive one,
  and a second link of the id would join it, splitting a connection's parcels.
- **An inbox per incarnation**, `<root>.i.<id>.<n>`, so that no dead connection locks the id's next
  link: two live links of one id would each read every parcel, which nothing in AMQP prevents.
- **A pre-provisioned, durable inbox per id**: no `released` would ever tell a peer gone, a dead
  participant's inbox would grow without end, and two processes of one id would share it.
- **Publishing to `/queues/<topic>`**: it goes through `amq.default`, which no topic permission
  narrows, so any participant could write any queue.
- **A held name's loss ending the link**: the whole participant reconnecting, every connection
  dropped, for a loss the name's queue makes harmless to attach again.
- **A finite receiver `max-message-size`**, its receive bound counted from what RabbitMQ 4.4 adds to
  a delivery: any participant could end another's link with one message, and a broker that adds
  more would end it on honest parcels at its bound.
- **A fixed allowance for what a broker adds**: a number of no standard.
- **`released` or `modified` as a retry, or a hold for copies past the next**: RabbitMQ's requeue
  moves backwards on one link, which the core's sequence would have to reorder.
- **`noSubscriber` false**: `released` is, for an inbox, exactly MQTT 5's 0x10, and what tells a
  peer gone without a will; a refused OPEN fails a connect at once all the same, so the flag off
  would change the reason a connect names, not its time.
- **Name queues a server's participant declares, auto-delete**: one loses every OPEN it holds as its
  last member detaches, which a full server does while full, and needs configure on names.
- **The C# side writing the profile itself**: AMQPNetLite takes no message already written.
- **RabbitMQ.AMQP.Client**: no manual credit, no peer bound, recovery on, and a second licence.
- **AMQP over a WebSocket in a page**, and the demo over AMQP from Node: no open-source RabbitMQ 4
  offers the first, and without it the second is the interop again.
- **A publisher's identity from RabbitMQ's validated `user-id`**: properties' second field, so it
  changes the profile and its count; a capability no other binding gives; and a use of the core's
  of its own, an OPEN's id or an `ELSEWHERE` judged against it, which is a change of 15.18 and 15.22.

## Decision

**AMQP 1.0 on RabbitMQ 4 alone, over TCP or TLS** (spec 15.32): its management, its addresses and
its permissions are RabbitMQ 4's, so the binding names its broker. A parcel is one message's Data
section; a topic is its tokens joined by `.`; a participant reads a topic at `/queues/<topic>` and
writes one through the topic exchange named its root, at `/exchanges/<root>/<topic>`. A server's
name is its queue, which the deployment provisions: every participant serving it, alone or in a
group, whatever its side, consumes it, its broker handing each message to one. Its handles' type is
`AMQP`.

**A link is one fresh connection, and its incarnation ends with it** (spec 15.33). Its OPEN names
the id as its container-id, its virtual host as `vhost:<it>` and its `idleTimeout`, 30 s by default,
as its idle-time-out, the link lost once nothing came for twice that. It authenticates by SASL PLAIN,
the id its user, the password asked anew at each link where it is a function, or by SASL EXTERNAL
under a client certificate RabbitMQ maps to the id's user. Its inbox is an exclusive, classic, not
durable queue of its name, declared through the management on that connection, 201 or 200, then
bound to the root's exchange by its own name, 204: so it ends with the connection, and a start that
fails between the two leaves no queue, since it closes its connection. While another connection of
the id holds the inbox, the start fails on the 400 and the participant's reconnection tries again:
the earlier link keeps the id, where MQTT 5's later one does. A link is up once its inbox's receiver
attached; the end of its connection, of its inbox's session or of its receiver is its link lost,
and its inbox is never attached again in place, since a receiver detached hands its unsettled
messages back on the same connection, which the core would read behind later parcels.

**Sessions are the walls** (spec 15.33): one for the inbox's receiver, one for each name served,
one sending to inboxes and one sending to names, each to the anonymous terminus, and the management
pair's only while a request is under way. A name its broker denies ends its own session and is
refused; a held name's receiver its broker ends is attached again once, in place, on a fresh
session, the core told nothing, since what its queue hands again is an OPEN the core drops as a
copy or resets as a second acceptor's (15.18); that refused, or the name lost a second time on the
same link, is its link lost, so the core's next link wants the name again and reports it unserved
where its broker still refuses it. A sending session that ends refuses each publication it held, the
link kept, and the next publication begins another; on the sending side the wall is per session: an
OPEN to a name its client may not call fails each OPEN in flight beside it. A subscription past the
OPEN's `channel-max` is refused, naming it, before it begins a session.

**A subscription is a receiver of its queue, unsettled, `first`, with no `max-message-size`, under
credit of its own** (spec 15.34): the inbox's `linkCredit`, 1,000 by default, and a name's 1, granted
as it attaches, one more as each message is settled, never as one arrives. A name's 1 is the
receiver-paced flow of Transport §2.6.7, which RabbitMQ's fair dispatch among competing consumers
plays at a prefetch of 1: its queue hands each member one OPEN at a time, so that one with room for
one takes it and the others wait for whichever member reads next, none prefetched by a member that
would refuse it 503; it costs a round trip per OPEN, on a connection's establishment alone. It is
held once its ATTACH named its source, and refused on an ATTACH that names none and a DETACH, or on
its session's end, naming the condition; one asked again while it is under way waits for it. A name
is let go once each message its receiver handed on was settled and then its DETACH came, none handed
on after it is asked, all within one `connectTimeout`, past which the link is lost, since a broker
that answers heartbeats and not a DETACH is broken: RabbitMQ requeues a message detached unsettled,
and an OPEN whose connection its server took and has since closed would be answered anew, its pair
gone. A name whose subscription is under way as it is let go is let go once its ATTACH is answered,
never held. An inbox, a test's peer's alone, is let go once the management deleted it, answered
within `connectTimeout`, what comes meanwhile handed on and credited, since its messages end with
it. No departure is subscribed: the adapter offers no will.

**A publication is one message of format 0, of one profile** (spec 15.35): a header only where the
core asks a life, its `ttl` alone, in whole milliseconds rounded up, 1 at least; properties whose
`to` alone is set; one Data section; each value in the smallest of its encodings, so that a
message's size is one formula on every side. It goes within its sender's credit, later ones waiting
in their order, the TypeScript adapter keeping that queue itself on `sendable`. `accepted` is taken;
`released` is no subscriber, its exchange routing its topic to no queue: an inbox its broker ended,
or a name no deployment provisioned; `rejected`, or any other outcome, refuses it, naming its error.
A publication past its sender's ATTACH `max-message-size`, counted, is refused as it is asked. The
TypeScript side writes the profile itself and hands rhea the bytes; the C# side has AMQPNetLite
2.5.4 write them, whose encodings are the profile's, pinned by the lockfile and
`Directory.Packages.props` and held to the profile by `amqpMessages`. The reference is the spec's
writer, `spec/generators/amqp_messages.py`, which both sides play.

**A received message is settled `accepted` once the core took or dropped it, and never otherwise**
(spec 15.36), on the receiver it came on, never on its successor; `released` or `modified` would
have RabbitMQ hand it again behind later ones. A message whose body is other than one Data section,
or whose payload passes the receive bound of the topic it came to, is handed on as no parcel, its
link kept. Its header, annotations and properties are read for nothing, so nothing a broker adds to
a delivery bounds what a participant takes.

**Every bound is counted to the byte by one formula** (spec 15.37): `S = L + 10 + D + 3 + w(N) + N`,
L the header's 13 bytes counted whatever the message, D the address's bytes, w(N) 2 under 256 and 5
otherwise, the largest payload found by a search. What a participant publishes is held within its
sender's ATTACH `max-message-size`; its receive bound is the same count within its own
`maximumMessageSize`, 16,777,216 by default: `bead.i.server` takes 16,777,156 bytes, and under 4,096
a message to `bead.i.peer` carries 4,038. The receive bound is asked of the adapter by its inbox's
topic: nothing of the core changes.

**No receiver names a `max-message-size`** (spec 15.34, 15.36): RabbitMQ answers a delivery past one
by ending the receiver's session while its publisher reads `accepted`, and every participant may
write every inbox, so a finite one would let any peer end any participant's link with one message.
What a library holds of one message is bounded by the broker's `max_message_size` instead, which
every publisher's ATTACH carries and RabbitMQ enforces, `linkCredit` of them at most on their way to
the inbox's receiver.

**A deployment's broker is half of the binding** (spec 15.38): the user it authenticates is the id;
it provisions the root's topic exchange and each name's queue, bound by the name, and no participant
declares either; its permissions, anchored, let a participant alone configure, bind and read its
inbox, every participant write the exchange and by its topic permissions any inbox, a server's
participants alone read its name's queue and its clients alone write its name, and no one write the
default exchange; its queues are unbounded or hold `maximumConnections` × `maximumUnsentBytes`, one
that drops losing connections by their gaps and one that rejects ending them; it sizes its
`max_message_size` and its `session_max_per_connection` for its participants. `tools/amqp-broker.mjs`
is its example: RabbitMQ by its digest, definitions and a password drawn per run, a container name
and loopback ports of its own, its `heartbeat` 10.

**The libraries' automation is off**: no reconnection or recovery, receivers that accept nothing on
their own and restore no credit, a sender checked for credit before each transfer, every link,
session and connection given its closed callback before its first operation, every callback and
outcome gated by the incarnation it was made in. The management helper is code of Bead's own beside
rhea's two defects: it opens its pair one link after the other on its own session and ends that
session after each request, so no evicted index entry outlives it, settles nothing but `accepted`,
so no batch mixes outcomes, and fails a request under way on its link's DETACH, its session's end or
its connection's loss, matching no answer of an ended pair to a later request.

## Consequences

**An id's next link after a silent loss waits for its broker**: no link of an id takes another over,
so after its own connection went silent, the id's next link is refused until its broker reaps the
dead connection, three of its `heartbeat` and its close, 210 s by default and 40 s at a `heartbeat`
of 10. The participant's reconnection, an attempt a second without end by default, links once it is
reaped; a `maxAttempts` an application sets outlasts that, or the reconnection ends first. A
deployment that wants a short lockout lowers its broker's `heartbeat`, at the cost of an empty frame
from every client each half of it. During it, the dead inbox still takes parcels: Bead's heartbeat
(15.21) is the only word on a peer gone silent, as for every binding without a will. A row of
"Differences" in [`docs/support.md`](../support.md).

**A connect to a provisioned name with no member waits its time**, its OPEN held in the name's queue
for its life, where over MQTT 5 0x10 fails it at once; `released` has two causes, an inbox its broker
ended and a name no deployment provisioned, and never a provisioned name with no member. A row of
"Differences".

**A participant serves 60 names under RabbitMQ's default** of 64 sessions a connection, its inbox's,
the two sending ones and the management's taking four; a deployment that needs more raises
`session_max_per_connection`, at most 65,535, each session a process of its broker's. A row of
"Differences".

**A denied OPEN fails those in flight beside it**, each connect failing at once and the next OPEN
going on a fresh session: a denied name is a misconfiguration, and the binding does not spend a
session per name against the 64.

**No receiver limit**: what a library holds of a message is its broker's `max_message_size`, not the
participant's own bound, where over MQTT 5 it is the participant's Maximum Packet Size; a deployment
sizes the one against `linkCredit`, as over MQTT 5 a Receive Maximum against a Maximum Packet Size. A
row of "Differences".

**A held name's receiver is attached again once**, so an operator's withdrawn grant or deleted queue
costs a name its subscription and, at a second loss, the link; a contract that let an adapter tell
one subscription lost, the link kept, would serve it better, and stays unwritten while AMQP 1.0
alone would use it.

**The C# side's bytes are AMQPNetLite 2.5.4's**: an upgrade that writes another encoding fails
`amqpMessages` before anything ships. The TypeScript side writes its own and is held by the same
group.

**A participant's publications go under its broker's credit**: 170 at a time on RabbitMQ 4.4, about
5,700 a second at 30 ms a round trip.

**Order and copies hold unchanged**: a parcel past the next awaited is still a loss (15.19), with no
hold, but only under the accept-only settlement and an inbox never attached again in place, which
the binding states both.

**What stays open**: a publisher's identity RabbitMQ vouches for by its validated `user-id`,
standing for an `ELSEWHERE`, weighed here and left open
([0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md));
AMQP 1.0 in a page, which no open-source RabbitMQ 4 carries, a row of "Differences"; TLS and SASL
EXTERNAL, which the fixture's broker, in clear on the loopback, does not play.

**Its gates**: the cases over `amqp` of `spec/transports.json` and its `brokers.amqp`;
`amqpMessages` and `amqpPublishBounds`; the places `amqpBrokerAdapter.idleTimeout` and
`amqpBrokerAdapter.connectTimeout`; the adapters' twins, against a scripted AMQP 1.0 peer and
against the fixture, and the management helper's; the interop over AMQP 1.0 both ways, a name served
by two in one group proven by no ACCEPT ever answered twice; and the CI job `amqp`,
`BEAD_AMQP_REQUIRED=1`.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)):
ten objections, each verified against its probe or its source before it was answered, five
accepted, five in part, none refused. The dissent also checked and upheld the draft's counts — 4,038
bytes a message to `bead.i.peer` under 4,096 — rhea's transfer already written split across frames,
and the idle-time-out each library announces against the one it enforces.

| Objection                                                                                                                                                                                                                                                                                                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The exclusive inbox's lock is read only as takeover prevention: after a silent loss, the id's next link is refused until RabbitMQ reaps the dead connection, about 60 s, where MQTT's takeover is immediate; not among the draft's open points.                                                                                                   | **Accepted, and worse than claimed.** Measured: three of the broker's `heartbeat` to call the client silent, then its close — 40.2 s at a `heartbeat` of 10, 210.0 s at the default 60 — whatever idle-time-out the owner announced, 0 or 30,000. It also falsifies two lines the objection did not name: the broker's heartbeat finding a peer dead at 60 s, and `released` hastening a gone peer, since the dead inbox takes parcels until it is reaped. The binding states the lockout (15.33, 15.38), the reconnection that outlasts it and `heartbeat` as the deployment's lever; a row of "Differences" against MQTT 5's 0x8E; the twin `fails its start on a declaration answered other than 200 or 201, naming it, and while another connection of its id holds the inbox, its participant linking once it is let go (spec 15.33)` against the fixture at a `heartbeat` of 10. An inbox per incarnation, which would lift the lock, is weighed and not taken: two live links of one id would each read every parcel.                                                                                                                                       |
| A held name's receiver loss is a link loss in one place and the inbox's alone in another; the link-fatal reading drops every name and connection for a loss a name's queue makes harmless to attach again, and the contract offers no signal for one subscription.                                                                                | **In part.** The contradiction is resolved one way, everywhere (15.33, its twins `tells its link lost once on the end of its connection, or of its inbox’s session or receiver, closes its connection, and lets nothing of a lost link reach the next (spec 15.33)` and `attaches a held name’s receiver again once, on a fresh session, when its broker ends it, telling no loss, and tells its link lost when that is refused or the name is lost again, never attaching a name it lets go (spec 15.33)`): only the connection and the inbox's session or receiver end the link; a held name's receiver is attached again once, in place, on a fresh session, its unsettled OPENs coming back as copies the core drops (15.18). Where that is refused, or the name is lost again on the link, the link is lost, so that the core's next link reports the name unserved — not reported unserved with the link kept, which the contract cannot say. Widening 15.24 for it was put to the user and not taken while AMQP 1.0 alone would use it. Dropping the receiver limit removes the oversize cause, leaving the operator's: a queue deleted, a grant withdrawn. |
| A finite receiver `max-message-size` and a receive bound counted from RabbitMQ 4.4's delivery weld one broker build's annotations into a conformance number, and a broker that adds more ends the inbox on honest parcels; the research recommended the receiver unlimited and a local bound.                                                     | **Accepted, for a reason the objection did not give.** Verified: RabbitMQ ends the receiver's session past its limit while the publisher reads `accepted`; unset means unlimited (§2.7.3); and 15.38 lets every participant write every inbox — so a finite limit is a lever any peer pulls to end any participant's link, under the defaults with one 16 MiB message, delivered 64 bytes past it. MQTT 5's broker discards instead (§3.1.2.11.4). No receiver names a limit (15.34); the receive bound is the publish formula within `maximumMessageSize` (15.37: 16,777,156 by default), the adapter dropping a payload past it as no parcel (15.36); a count of what the broker adds, and the vectors of it, leave; what a library holds of a message is the broker's `max_message_size`, which 15.38 states. A row of "Differences", by the standards, not of "Leveled down".                                                                                                                                                                                                                                                                                  |
| One session per served name caps a participant at about 60 names under RabbitMQ's default of 64 sessions, with no MQTT analogue and no row of the matrix.                                                                                                                                                                                         | **Accepted.** A `channel-max` of 63 measured: 64 sessions, 60 names beside the inbox's, the two sending ones and the management's. The ceiling is stated (15.33, 15.38), a subscription past `channel-max` refused naming it (the twin `refuses a name whose ATTACH names no source and is detached, whose session its broker ends, or past its broker’s channel-max, naming it, and keeps every other (spec 15.34)`), `session_max_per_connection` named as the deployment's lever, at most 65,535, and a row of "Differences". With a held name's loss now staying the name's, the session a name costs is no longer paid for and then discarded. One shared session for names was weighed again and not taken: a denied subscription would fail every pending one beside it.                                                                                                                                                                                                                                                                                                                                                                                    |
| Byte identity between a hand-written TypeScript encoder and AMQPNetLite's has no standard behind it and makes AMQPNetLite the reference; both sides should write the profile, AMQPNetLite a cross-check.                                                                                                                                          | **In part.** The reference is the spec: 15.35's rule, each value in the smallest of its encodings (Types §1.6), and the generator's writer, `amqp_messages.py`, which both sides play through `amqpMessages`; the byte identity serves 15.37's formula, which RabbitMQ holds to the byte, 4,096 against 4,097. The C# side cannot write the profile itself: AMQPNetLite's section encoders are `internal abstract` and its sender always encodes. So its bytes are AMQPNetLite 2.5.4's, pinned by the lockfile and `Directory.Packages.props`, `amqpMessages` the gate that fails on a drift at an upgrade, as this record and `docs/support.md` say.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `noSubscriber` over AMQP fires for a name never provisioned and not for a provisioned name whose server is down, so a connect to a down server waits its time where MQTT's fails at once; perhaps the flag should be false.                                                                                                                       | **In part.** The difference is stated where a reader meets it: 15.35 gives `released`'s two causes, 15.38 the wait, `docs/support.md` a row of "Differences" with the case `a server that stops closes each connection with 1001 and lets its name go: an OPEN after it waits in its name's queue` over `amqp`. The flag stays: `released` is Messaging §3.4.4's "not and will not be acted upon", for an inbox exactly MQTT 5's 0x10, and what tells a peer gone without a will; a refused OPEN fails a connect at once all the same, so `false` would change the reason named, not the time. 15.31 already has MQTT 5 wait for a name no participant may read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The management helper is new code beside rhea's two defects, the path the research would not call ready, with no twin for a request cut by a remote detach or a loss between declaration and binding, which leaves a queue declared and unbound.                                                                                                  | **In part.** The twins are added on both sides: `fails its start and closes its connection when its management’s link is detached, its session ended or its connection lost between its inbox’s declaration and its binding, and leaves no queue of its id behind (spec 15.33)`, against the fixture too, the queue's end read by management; and the helper's `fails each request under way when its link is detached, its session ends or its connection is lost, and matches no answer of an ended pair to a later request`. This record names the helper Bead's own code and the two defects of rhea's it works around. The unbound queue cannot outlive the start: the inbox is exclusive to the connection, and a failed start closes the connection, the queue ending with it. RabbitMQ's management offers no request that declares and binds at once.                                                                                                                                                                                                                                                                                                     |
| The sending side's wall is coarser than "a session per name" says: one denied OPEN ends the session for names and fails every OPEN in flight on it to names the client may call.                                                                                                                                                                  | **Accepted.** Stated in 15.33 and here, with the session for inboxes alike, and against the fixture in the twin `refuses each publication a sending session held as it ends, keeps its link, and begins another for the next (spec 15.33)`. A sending session per name is weighed and not taken: it spends what the session ceiling counts for a misconfiguration whose collateral is one round trip, each connect failing at once and the next OPEN going on a fresh session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The demo over AMQP never runs in the demo: no page offers `?transport=amqp`, so it is the interop again under the demo's name.                                                                                                                                                                                                                    | **Accepted.** The demo's leg over AMQP is dropped, with its CI step and the fixture's queue for it. The demo, the site and DevTools align where a feature touches them, and AMQP 1.0 touches none: no page reaches the broker, and DevTools shows a handle's type as it comes. `docs/support.md`'s row `AMQP 1.0 in a page` says why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| (a) The examples of the count change subject silently, `bead.i.peer` then `bead.i.server`; (b) the 20 bytes of a broker's header are an upper bound, not a width seen; (c) a publisher's identity is deferred again though RabbitMQ validates `user-id`; (d) 1,000 credits × 16 MiB is an exposure in flight MQTT's smaller packets do not reach. | **In part.** (a) Accepted: each example names its inbox (15.37). (b) Accepted: the 20 bytes are an upper bound over RabbitMQ's redelivery fields, now counted in no bound. (c) In part: [0010](0010-a-request-presents-a-credential-of-a-scheme.md) and [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md) have it weighed with this binding, and it is: `user-id` is properties' second field, so it changes the profile and its count, and it gives the core a use of its own under 15.18 and 15.22; left open, `docs/support.md` naming `user-id` the way, the choice put to the user and left open. (d) In part: the sentence goes in (15.38, the deployment sizing `max_message_size` against `linkCredit`); the default stays — MQTT 5's Receive Maximum of 65,535 × a Maximum Packet Size of 16 MiB is the larger exposure, so the comparison is refused.                                                                                                                                                                                                                                      |

After the round, the integration's changes met a dissent of their own, each point verified against
the code: its third, the link up once the inbox's receiver attached, upheld them as they were, and
every other was accepted.

| Objection                                                                                                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A name's receiver granted `linkCredit` prefetches the OPENs waiting in its queue, which a member with room for one refuses 503 rather than leave there.                                        | **Accepted.** A name's credit is 1 (15.34), Transport §2.6.7's receiver-paced flow and RabbitMQ's fair dispatch at a prefetch of 1; the twin `grants a name’s receiver a credit of 1, so that of the OPENs its broker holds for a member with room for one it hands on one, the others left in the name’s queue, none refused (spec 15.34)`. |
| (1) `a_group_at_its_bound` over AMQP blames RabbitMQ for its dropped gauge, and one waiting OPEN proves too little.                                                                            | **Accepted.** Its comment says the gauge holds 1 for less than a poll; the case waits two OPENs, frees the second by a RESET of its pair and reads the third's ACCEPT, citing 15.38, and failed on a REFUSE 503 before the credit of 1.                                                                                                      |
| (2) The let-go's bound is the code's, not the spec's, the sides diverging past it; the TypeScript side settles on an ended link; 15.34 names another member as the reason.                     | **Accepted.** One `connectTimeout` bounds the settlement and the DETACH, the link lost past it on both sides (15.34, 15.37); a receiver that ended settles and counts nothing; 15.34 carries this record's reason, an OPEN answered anew.                                                                                                    |
| (4) A name subscribed while its subscription is under way is held before its ATTACH on one side and attaches a second receiver on the other, and one an unsubscription meets is held after it. | **Accepted.** One under way is waited for, and one an unsubscription met is let go once attached, never held (15.34), on both sides.                                                                                                                                                                                                         |
| (5) A refused inbox deletion leaves what came meanwhile unsettled and its credit spent, and the TypeScript deletion has no bound.                                                              | **Accepted.** The flag marks only the inbox's DETACH as asked, so it hands on and credits during the DELETE; each side's deletion is bounded by `connectTimeout`.                                                                                                                                                                            |
| (6) The bounds' ranges are stated nowhere, the "Leveled down" row cites 15.34, and the twins assert different things.                                                                          | **Accepted.** 15.37 states both, `maximumMessageSize`'s from a Data section's `vbin32` and an OPEN's 4-byte receive bound; the row cites 15.37; the twin of the receive bound is widened to the ranges and plays the same assertions on both sides.                                                                                          |
