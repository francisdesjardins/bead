# 0038 — Over a broker, a connection is placed once at its open, and named by both its ends

- **Status**: accepted
- **Scope**: the protocol, and every implementation's core: in [`spec/spec.md`](../../spec/spec.md),
  the participant, its inbox, its id and a server's names, in 15.16; the open in three legs, its
  refusals, a half-open connection, a second acceptor and a name served in a group, in 15.18; a
  connection's end, a link that keeps no broker session, its incarnation, its will and a stop, in
  15.21; the address 15.1 hands over a broker; the broker cases of
  [`spec/transports.json`](../../spec/transports.json) of the open and the end, in both roles; the
  place `brokerTransportServer.acceptTimeout` of [`spec/durations.json`](../../spec/durations.json).
  Each binding is in its own record, MQTT 5's
  [0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md)
  and AMQP 1.0's
  [0043](0043-over-amqp-1-0-a-participant-is-one-connection-whose-exclusive-inbox-ends-with-it-and-a-parcel-one-message-of-one-profile-each-counted-to-its-byte.md).
  A parcel, its sequence and its parts are
  [0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)'s;
  the adapter, the pace, the credential and the heartbeat
  [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)'s;
  a broker as a transport, and Bead never a network,
  [0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)'s; a handle
  [0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md)'s; the bounds
  [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s. This record keeps the round of the Tenth
  Man of the broker's core, which the other two point to.

## Context

**A broker gives no connection, and Bead's routers need one.** A client knows its connection's
session and presents it (spec 13.3, 13.4); a client router has one connection to close (9.10, 15.1);
a cancel, a chunk and a credit follow their call; and no session's state is shared between servers
([0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)). A broker reaches every
participant, authenticates each to itself, and hands a message published to a name many serve to
one of them: MQTT 5's shared subscription, `$share`, and RabbitMQ's competing consumers and a NATS
queue group alike. One message can still reach two: a shared subscription's message whose member's
session ends unacknowledged SHOULD go to another member (MQTT 5.0 §4.8.2).

**A copy and a second acceptor are what a broker does, not faults.** MQTT 5's QoS 1 is at least
once (§4.3.2), and a message is resent only into a session resumed with Clean Start 0, "at no other
time" ([MQTT-4.4.0-1]); a will waits its delay or the session's end, whichever comes first, and goes
as the network connection closes when its delay is 0 ([MQTT-3.1.3-9]); a second link under one
Client Identifier takes the first one's over ([MQTT-3.1.4-3]).

The options weighed:

- **A request placed by itself**, to its procedure's topic, a group handing each to one member,
  its answers and what follows it on the client's own topic, as AMQP 0-9-1's `reply-to` and
  `correlation-id` carry a reply. Played against the routers in a probe of the round, a client
  presented one server's session token to the other, and every other call that asked its session
  was refused `SESSION_REQUIRED`; a cancel, a chunk or a credit has no member certain to reach; and
  a member lost would have its transport fail its calls by call id, forging failures 15.1 and a
  relay's place (section 14) refuse.
- **A connection named by its opener alone**, 16 bytes in its OPEN: two acceptors of one OPEN share
  that name, and in 2 of the 6 interleavings MQTT 5 §4.6 allows, the opener hands its router the
  command of the acceptor it reset and drops the one it took as a copy, as a probe of the round
  played them; and the whole name goes out on the server's name, which every member reads.
- **A participant's id a side draws**: no access control can name it, so a bound per address, a
  handle and a refusal would name a claim the opener writes.
- **A broker session kept across a link's drop**, MQTT's Clean Start 0 with a Session Expiry: calls
  and subscriptions through a short outage, at the price of a will delayed past the heartbeat's own
  close, a crashed participant's inbox held for the session's expiry, and copies to drop after
  every resume.

## Decision

**A connection over a broker is placed once, at its open, and then runs inbox to inbox** (spec
15.16). A participant is one link of a side to its broker, which holds an inbox, the topic every
parcel of its connections reaches, subscribed as its link starts, before anything of it goes. A
server's transport serves names, each a topic its participants share, as a host name stands for the
servers behind it. A client's OPEN goes to a server's name, the broker hands it to one participant,
which ACCEPTs it from its own inbox, and every parcel after it goes from one inbox to the other. A
request never goes to a name, so a call, its cancel, its chunks, its credits, its notifications and
its server's commands reach the participant that took its connection: its session stays one
connection's, no group hands a request again to a second member, and admission happens once, as
HTTP/2's calls behind a connection-level balancer go to one server
([RFC 9113 §5.1](https://www.rfc-editor.org/rfc/rfc9113#section-5.1)).

**A topic is a sequence of tokens**, each 1 to 64 characters of base64url's alphabet
([RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648#section-5)), which every broker writes as a
name: an inbox, `<root>`, `i`, `<id>`; a server's name, `<root>`, `s`, `<name>`; a participant's
departure, `<root>`, `d`, `<id>`; the root `bead` unless an application gives another. A server's
name is its application's, like a host: no procedure is routed by the broker, so no topic is derived
from one. Each binding writes the tokens as its broker does.

**A participant's id is the identity its broker authenticates it by**, a token its adapter gives,
never one a side draws: its username, or a client identifier its broker ties to one, the RabbitMQ
user, the NATS user. A participant whose adapter's id is no token is refused as it is built. The
deployment's access control names each inbox and departure by it, so each participant has an
identity of its own, and three members of one server are three.

**A connection is named by both its ends**, as a TCP connection is a pair of sockets
([RFC 9293 §3.4.1](https://www.rfc-editor.org/rfc/rfc9293#section-3.4.1)): 8 bytes its opener draws
in its OPEN, 8 its acceptor draws in its ACCEPT, each from a cryptographic source, every later
parcel naming the pair.

**The open has three legs**, TCP's handshake
([RFC 9293 §3.5](https://www.rfc-editor.org/rfc/rfc9293#section-3.5)): the OPEN, the ACCEPT or the
REFUSE, and the opener's first parcel naming both halves, a PING of sequence 2 its acceptor answers
(spec 15.18). The acceptor tells its router nothing, and draws no handle, before that third leg: the
connection is half-open, holds its place in `maximumConnections` and in its id's count, and is
forgotten, nothing told and nothing sent, once `acceptTimeout` passes, 30 s on the clock given, or a
RESET names it. The acceptor's half reaches only the inbox the OPEN named, which only its
participant reads, so the third leg proves the id the OPEN claims, as TCP's handshake proves a
source address and QUIC's token validates one
([RFC 9000 §8.1](https://www.rfc-editor.org/rfc/rfc9000#section-8.1)): the router is handed that id
as the address of every envelope, with no port, `maximumConnectionsPerAddress` counts it, and the
handle names it (15.1, 13.12).

**An OPEN is judged as it comes**, in 15.18's order: an OPEN of a layout to come is refused 426
`layout-refused`, naming the layouts read, as 15.2's step 5 answers a WebSocket version it does not
read ([RFC 9110 §15.5.22](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.22)); an id that is
no token or a receive bound under 1,024, 400 `malformed`; past the server's bounds, or once its stop
began, 503 `busy`. A refusal goes to the inbox the OPEN names and is told as 15.1 tells one, the id
the OPEN claims its address, no port. An OPEN whose id and half name a connection held already is a
copy, dropped in silence.

**A second acceptor is reset.** An ACCEPT naming the opener's half for a connect that took another,
ended or never was — a second member the broker handed the OPEN again, a member of a name served by
several without a group, one past its connect's end — is answered with a RESET of its pair, to the
inbox it names: its acceptor forgets its half-open connection, and its router never hears of it. A
REFUSE that comes after an ACCEPT names no pair the opener holds, and is dropped.

**A name served by several participants is served in a group**: without one, each member takes
every OPEN, and a busy member's REFUSE can end a connect another would take. It is the deployment's
rule, stated in 15.24 and in each binding, since no participant sees another process subscribe. A
member served in a group that holds `maximumConnections` unsubscribes its names, and subscribes them
again once it holds fewer, so its capacity is its broker's placement; an OPEN that crossed its
unsubscribe is refused 503. A participant serving a name alone stays subscribed at its bound and
refuses 503, which tells its client more than an OPEN no one takes.

**No connection outlives its participant's link.** Each time its link connects, a participant draws
an incarnation, 16 bytes from a cryptographic source, and its link keeps no broker session: MQTT's
Clean Start 1 and Session Expiry 0, an AMQP inbox that ends with its link, core NATS, which keeps
none. Each connection is bound to its peer's incarnation, named in its OPEN or its ACCEPT. A link
that goes down closes each of its connections, unclean, told to its router as a dropped socket is;
the participant connects again by its own reconnection, another incarnation, its inbox and its names
subscribed anew before anything goes, then sends a RESET to each peer it held a connection with. A
library's own reconnection, resubscription and offline queue are off. So no broker resends into a
session that was not kept, nothing of a former incarnation reaches a new one, and a will is prompt.

**A will, where the adapter leaves one**: the broker publishes the participant's GONE, of its
incarnation, to its departure once it loses the link without a clean end, MQTT's Will with a delay of
0 (§3.1.3.2.2). A participant subscribes the departure of each peer it holds a connection with,
while it holds one, and closes, unclean, each connection bound to the id and incarnation a GONE
names, never one of another incarnation. AMQP and NATS, which leave no will, keep the heartbeat
alone ([0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)).

**A connection ends by a CLOSE or a RESET** (spec 15.21). A CLOSE is sequenced, ends the connection
once all before it was handed on, 1000 clean and any other unclean, a WebSocket's codes
([RFC 6455 §7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1)), 4000 lost and 4001
unanswered of the private range; no close answers a close, so no close timeout. A RESET ends it at
once, whatever its order
([RFC 9293 §3.5.2](https://www.rfc-editor.org/rfc/rfc9293#section-3.5.2),
[RFC 9000 §10.3](https://www.rfc-editor.org/rfc/rfc9000#section-10.3)), and names the pair, so only
who read the acceptor's half can send one. A parcel of a pair its receiver does not hold is dropped
in silence, as a cancel for no call is (10.2), but an ACCEPT, which is reset. A server's transport
that stops unsubscribes its names, refuses 503 an OPEN that comes, and closes each connection with
1001; its participant then ends its link cleanly, MQTT's DISCONNECT of reason 0, so no will goes.

## Consequences

The trace of parcels (debugging 13) never hands on a connection's acceptor's half: the pair is
the connection's capability. A log names the connection by a participant's ordinal and, from
the third leg, its server's handle, never by that pair.

**Calls spread across a name's participants by connection, not by call**, as HTTP/2's behind a
connection-level balancer: a client that wants its calls spread holds several connections. A member
added takes none of the connections already placed, and over a broker devices and services hold
theirs for days; a member that stops ends every call and subscription of its connections at once,
1001, and its clients' reconnections place them anew. HTTP/2 drains a connection by `GOAWAY`
([RFC 9113 §6.8](https://www.rfc-editor.org/rfc/rfc9113#section-6.8)) and gRPC re-spreads long-lived
ones by `MAX_CONNECTION_AGE` and a grace (gRFC A9); Bead's WebSocket has neither. A connection's age
and a graceful drain are ahead, for every long-lived transport at once, a WebSocket's and a
broker's, by a record of their own.

**Each participant needs a broker identity of its own**: participants that shared one login would
share one inbox, and a second MQTT link under one Client Identifier takes the first one's over.

**The open costs a round trip**: one parcel and its PONG a connection, the acceptor's tell waiting
for them.

**A claimed id costs one exchange**: an OPEN naming another's id draws one ACCEPT to that inbox and
one RESET back, no amplification; a refusal judged at the OPEN names the id it claims, one a
refusal; and OPENs naming ids no one reads hold half-open places until `acceptTimeout`, which the
broker's control of who publishes to a name and its rate limits bound, as a SYN flood's are its
network's.

**A link's outage ends its connections**: calls fail as over a dropped socket, and clients
reconnect, a new pair, possibly to another member. A will makes a crashed participant's end known
at once where its broker leaves one; elsewhere the heartbeat finds it.

**Who may accept is the broker's access control** on subscribing a server's name, as a DNS name and
its certificate place a socket's server. An acceptor that proves itself to its opener is ahead.

**Its gates**: the broker cases of `spec/transports.json`, both roles — an OPEN accepted and its
third leg, a half-open connection past `acceptTimeout`, each refusal and what it tells, an OPEN
copied, a second acceptor's ACCEPT reset and one past its connect, a RESET, a GONE of each
incarnation, a stop, a group at its bound — played by both sides' players over each side's
in-memory broker; the place `brokerTransportServer.acceptTimeout` of `spec/durations.json`; and
what no case plays, a participant's link lost and its incarnation anew, by twins named by one
sentence on both sides ([`docs/support.md`](../support.md)).

## The Tenth Man

The broker's core met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md))
at xhigh effort, on its draft, which this record and
[0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)
and
[0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)
state. Sixteen objections, each claim checked against MQTT 5.0's text, the code and the probes
before it was answered: thirteen accepted, three in part, none refused. Two choices no standard
settles went to the user, who took both: placement at the open, and no connection outliving its
participant's link. The objections, with the answers that hold:

### On the broker's core

| Objection                                                                                                                                                                                                                                                                                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two acceptors of one OPEN share its connection's name, and the opener cannot tell their parcels apart: in 2 of the 6 interleavings MQTT 5 §4.6 allows, it hands on the reset acceptor's command and drops the taken one's as a copy; and the whole name goes out on the server's name, where every member reads it | Accepted: verified by a probe of the six interleavings. A connection is named by both its ends, as a TCP connection is a pair of sockets (RFC 9293 §3.4.1): 8 bytes the opener draws in its OPEN, 8 the acceptor draws in its ACCEPT, every later parcel naming the pair, the prefix still 28 bytes and only the opener's half on the name. The open gains TCP's third leg (RFC 9293 §3.5): the acceptor tells its router nothing before the opener's first parcel naming both halves, so a second acceptor is reset and never reaches its router. The client's half of the open plays from `spec/transports.json`, two acceptors of one OPEN among its cases.                                                                                                                                                                                                                                                                  |
| A participant's id is a claim the OPEN writes, yet it is the client's address, its bound per address and its handle, and may be drawn at random where no access control can name it: a client evades the bound, sends ACCEPTs into a victim's inbox, and anyone publishes a GONE to a server's departure           | Accepted in part. Accepted: a participant's id is the identity its broker authenticates it by, given by its adapter, never drawn; each binding names the access control by it — who reads an inbox, whose will writes a departure, who serves a name; the handle is `participant=`, not `ip=`; the residue is named, one ACCEPT and one RESET per OPEN that names another's inbox. Refused: handing no address and dropping `maximumConnectionsPerAddress`. The third leg proves the id an OPEN claims, since the acceptor's half reaches only the inbox it names and only that participant reads it, as TCP's handshake validates a source address and QUIC's token an address (RFC 9000 §8.1): the bound counts a proven identity, and a refusal told at the OPEN names the id it claims, one a refusal. A client's fresh claims hold half-open places until `acceptTimeout` at most, bounded by who may publish to the name. |
| A kind to come opens a gap no broker fills, ending the connection later as a broker's loss; an OPEN of a layout to come is dropped unanswered; [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) names a single layout axis                                                                    | Accepted: a parcel's first 28 bytes, an OPEN's id at its body's head and a REFUSE whole are kept by every layout, as 2.1 keeps an envelope's prefix. A kind to come, taken in its order, closes its connection with 1002, as 3.3 refuses an envelope's; an advisory kind is skipped in its order. An OPEN of a layout to come is refused 426 `layout-refused`, naming the layouts read, as 15.2's step 5 answers a WebSocket version (RFC 9110 §15.5.22). 0008's first axis names the parcel's layout beside the envelope's, revised in place until the wire is published.                                                                                                                                                                                                                                                                                                                                                      |
| Running the broker's heartbeat on the side's clock contradicts [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md), 15.12 and the draft itself, which reuses `heartbeat.ts` on the platform's timers                                                                                                | Accepted: verified in `heartbeat.ts` and 0011's Decision. The broker's heartbeat runs on the platform's timer on both sides, as the WebSocket's does, the C# side's `Heartbeat.cs` the twin of `heartbeat.ts` on `TimeProvider.System`; its case plays in real time, its `heartbeat` 500. 0011's Decision names the broker's heartbeat beside the WebSocket's ping. `acceptTimeout` and the parts' rate, which the spec times, run on the clock given; no gap has a timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| On MQTT a gap past the next parcel never fills, so a hold and its bounds wait for what cannot come                                                                                                                                                                                                                 | Accepted: verified in MQTT 5 §4.4 and §4.6 ([MQTT-4.4.0-1], [MQTT-4.6.0-1], [-5], [-6]). A parcel past the next one awaited loses its connection at once, a CLOSE of 4000, reported; nothing is held, so no bound on what is held and no gap timeout. Core NATS keeps a publisher's order alike, an AMQP inbox ends with its link, and the AMQP 1.0 binding settles `accepted` alone and never attaches its inbox again in place ([0043](0043-over-amqp-1-0-a-participant-is-one-connection-whose-exclusive-inbox-ends-with-it-and-a-parcel-one-message-of-one-profile-each-counted-to-its-byte.md)), so no requeue reaches a live connection and nothing is held.                                                                                                                                                                                                                                                              |
| A broker session kept across a link's drop and a prompt will cannot both hold: at the draft's defaults a GONE comes after the heartbeat's own close, while a crashed server's inbox is kept 60 s                                                                                                                   | Accepted: verified in [MQTT-3.1.3-9]. No connection outlives its participant's link: Clean Start 1, Session Expiry 0 and Will Delay 0 on every link, a new incarnation each time, its connections lost as a WebSocket's are with its socket, a library's own reconnection, resubscription and offline queue off. The GONE then comes as the broker sees the link close, and no copy reaches an inbox on MQTT. Whether a connection should outlive its link is no standard's to settle; the user took this way.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| "At least once" holds only within the broker's queue, a server participant's fan-in fills that queue first, and the in-memory broker has none, so no case sees the loss                                                                                                                                            | Accepted, the brokers' bounds read from Mosquitto's man page and EMQX's schema: an adapter's at least once holds within its broker's queue; each binding states the queue settings a server participant needs, lifted or sized to `maximumConnections` × `maximumUnsentBytes`, and that overrunning them loses connections; the in-memory broker gains a queue bound per subscriber, and a case shows the loss told.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| "Secure by its own leg" lets a bearer credential cross the far leg in the clear, though that leg is another participant's, which knows its own security; a credential waits in the broker's queue; [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s "broker's word" is replaced rather than answered  | Accepted: an OPEN and an ACCEPT carry `SECURE` for their sender's own leg, and a broker's transport is secure only while both legs are, its `isSecure` read per call; the flag is on the OPEN too, since a server's command presenting a `JWT` crosses its client's leg. A binding sets a message's life on a DATA that carries a credential, and states that a broker's persistence may hold it at rest. 0010's paragraph says it: `ELSEWHERE` stands for the bearer credential the DATA carries, and the broker's word is no capability MQTT 5 or core NATS gives, RabbitMQ's validated `user-id` weighed by [0043](0043-over-amqp-1-0-a-participant-is-one-connection-whose-exclusive-inbox-ends-with-it-and-a-parcel-one-message-of-one-profile-each-counted-to-its-byte.md), and ahead.                                                                                                                                    |
| A broker's binding is the wire itself, so it belongs in section 15, not in a companion with a version of its own                                                                                                                                                                                                   | Accepted: a binding is where two sides' bytes meet, which the spec's preamble puts in sections 1 to 15. Each binding is a subsection of section 15, on the spec's version, its cases in `spec/transports.json` under its own `transport`; a side without one has a row of `docs/support.md`, as the Web Worker has. No companion and no fourth version axis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An envelope in parts has no time bound, and a budget shared across connections lets one peer's unfinished envelope cost another its connection                                                                                                                                                                     | Accepted: parts are held to 15.12's body rule, `minimumBodyBytesPerSecond` once `bodyGracePeriod` passed since an envelope's first part, on the clock given, at both ends, or the connection is lost, reported naming the bound. `heldBytesBudget` bounds parts alone, and a part that would pass it loses its own connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The parcel is a wire format both sides write, yet no shared bytes hold them to it, and the client's half of the open is covered by twins alone                                                                                                                                                                     | Accepted: `spec/vectors.json` gains `parcels` and `parcelRefusals`, bytes to fields and back, each kind and each refusal of 15.17, played by both codecs. The client's half plays from `spec/transports.json` by a client role, the test's peers as one acceptor or two, a case reading what the client publishes to the name and to their inboxes: one file both sides read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A REFUSE ends a connect the group could have placed: without a group every member answers every OPEN, and one busy member's REFUSE wins; with a group the member the broker picked refuses while others have room                                                                                                  | Accepted in part. Accepted: a name served by several participants is served in a group; a member served in a group that holds `maximumConnections` unsubscribes its names until it holds fewer, so its capacity is its broker's placement, a REFUSE left for an OPEN that raced it; and the third leg takes the extra ACCEPTs off the routers, no handle drawn and no router told for an acceptor reset. Refused: refusing a second participant as it is built, which no participant can see in another process; it is the deployment's rule, stated. A participant serving a name alone stays subscribed and refuses 503, which tells its client more than an OPEN no one takes.                                                                                                                                                                                                                                               |
| Placement by connection copies HTTP/2's and gRPC's model without their cure for long-lived connections, a drain and a maximum age                                                                                                                                                                                  | Accepted in part. Accepted: both costs, a member added taking no connection already placed and a member stopped ending every call of its own, are stated here and in `docs/support.md`. Refused: a `maximumConnectionAge` for the broker alone. A WebSocket's connections have the same costs and neither cure, and a bound one transport gains comes to all at once (CLAUDE.md, Parity), so a connection's age and a graceful drain (RFC 9113 §6.8, gRFC A9) are ahead, for every long-lived transport at once, by a record of their own.                                                                                                                                                                                                                                                                                                                                                                                      |
| Names ([0003](0003-one-word-one-meaning.md)): "address" takes three meanings, `maximumMessageBytes` bounds no single message, and `ip=` holds no IP                                                                                                                                                                | Accepted: a broker's destination is a topic, 0021's word, with `publish({ topic })` and `subscribe(topic)` on the adapter; "address" keeps 15.1's meaning, what the router is handed, a participant's id over a broker; the bound on one envelope's parts is `maximumEnvelopePartsBytes`; the handle is `type=BROKER;participant=<id>;ordinal=n`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The heartbeat costs twice what the draft counts, and a PING is owed only on a silent connection                                                                                                                                                                                                                    | Accepted: four parcels a connection a beat, each acknowledged on both legs, about 1,333 a second through a server participant's link at 10,000 connections and 30 s. Each end PINGs a connection only once nothing of it has come for `heartbeat`, any parcel answering, as TCP's keep-alive (RFC 9293 §3.8.4); on an idle connection a PING still finds a peer that dropped it, and a WebSocket's heartbeat stays as 15.3 has it. A peer that keeps sending while it reads nothing is found by its own queue's overrun, a gap, as TCP's keep-alive finds none.                                                                                                                                                                                                                                                                                                                                                                 |
| 15.15 holds of every transport, yet the draft places it under the joined transport and stages the broker around it                                                                                                                                                                                                 | Accepted: 15.15 takes a heading of its own, `### A connect`, its number kept, and the broker's core follows it as it stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
