# 0041 — Over MQTT 5, a participant is one clean link and a parcel one PUBLISH, each counted to its byte

- **Status**: accepted
- **Scope**: the protocol, and every implementation's MQTT 5 adapter: in
  [`spec/spec.md`](../../spec/spec.md), section 15's `### MQTT 5`, 15.25 to 15.31, and what it asks
  of the core in 15.18, 15.19, 15.21, 15.22 and 15.24; the cases of
  [`spec/transports.json`](../../spec/transports.json) over `mqtt`, the broker cases 37 to 45 that
  came with them, and its `brokers.mqtt`; the group `mqttPublishBounds` of
  [`spec/vectors.json`](../../spec/vectors.json); the places `mqttBrokerAdapter.keepAlive` and
  `mqttBrokerAdapter.connectTimeout` of [`spec/durations.json`](../../spec/durations.json);
  [`tools/mqtt-broker.mjs`](../../tools/mqtt-broker.mjs), the broker every run plays against; the
  adapters over MQTT.js and MQTTnet and their twins; the interop over MQTT 5 and its CI job. The
  core it binds is
  [0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)'s,
  [0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)'s
  and
  [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)'s;
  a broker as a transport [0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)'s;
  the bounds [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s; a duration
  [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s.

## Context

**What MQTT 5 gives, and what it lacks.** A PUBACK with a reason, 0x10 among them, No matching
subscribers (§3.4.2.1); a Maximum Packet Size each end announces (§3.1.2.11.4, §3.2.2.3.6); a
Receive Maximum, the quota of QoS 1 publications a client holds unacknowledged ([MQTT-3.3.4-7],
§4.9); Retain Handling and Retain As Published (§3.3.1.3); a Message Expiry Interval, deleted
before onward delivery once it passes ([MQTT-3.3.2-5]); Clean Start and a Session Expiry Interval
of 0, so no session outlives its network connection; a will of Delay 0, deleted by a DISCONNECT of
0x00 ([MQTT-3.14.4-3]); a shared subscription, `$share/<ShareName>/<filter>` (§4.8.2); a second
link of one Client Identifier that takes the first over, DISCONNECT 0x8E ([MQTT-3.1.4-3]). MQTT
3.1.1 has none of the PUBACK's reason, the Maximum Packet Size, Retain Handling, the Message Expiry
or the Session Expiry, each of which the binding stands on. Nothing in MQTT tells a publisher that
its subscriber's access control denies it what it publishes.

**What the libraries do of their own.** MQTT.js 5.16.1 reconnects, resubscribes, queues a QoS 1
PUBLISH asked while it is down with no option to turn it off, discards a PUBACK's reason on
success, applies a Server Keep Alive, and closes its link on a packet past its own CONNECT bound,
destroying its stream before it emits the error, so no DISCONNECT goes. MQTTnet 5.2.0.1603 refuses
what is asked while it is down, gives a PUBACK's reason, has no inbound bound of its own, reads a
Server Keep Alive only to start its loop, which pings on its own period, and bounds a call by its
`Timeout` only where its token cannot be cancelled, and always its transport's close.

**What the probes found**, against `eclipse-mosquitto:2.1.2-alpine` by its digest and a scripted
MQTT 5 peer:

- the research's count of a PUBLISH, `S = 1 + v(R) + R`, matched `mqtt-packet`'s own encoder on
  every row, and each largest payload encodes to its bound exactly, one byte more past it;
- Mosquitto counts a Remaining Length as one byte toward a subscriber and as none from a
  publisher: it sends a subscriber up to `v(R) − 1` bytes past its bound and takes up to `v(R)`
  bytes past its own;
- a subscriber its access control denies is granted its SUBACK, gets nothing, and its publisher
  reads PUBACK 0x00; a topic no one subscribes, 0x10; Mosquitto's word is exact at SUBACK and
  UNSUBACK, 50 of 50 each way;
- a shared subscription's messages reach its members through the name's own topic, which is what
  its access control grants;
- a group's member that dies holding a QoS 1 message has it handed to no other member, so
  Mosquitto 2.1.2 does not take §4.8.2's SHOULD; it PUBACKs each publication in the turn it takes
  it, and keeps one link's order on each topic, 3,000 of 3,000;
- neither library keeps its CONNACK's Receive Maximum: under a Receive Maximum of 2 and every
  PUBACK withheld, each put 5 of 5 PUBLISH packets on the wire, which a broker that counts them
  answers by ending the link, 0x93; Mosquitto's own receive maximum is `max_inflight_messages`, 20
  by default;
- MQTTnet's link is lost at 7.06 s under a Server Keep Alive of 4 and its own of 10, where MQTT.js
  holds;
- two holders of one id that each relink at once take each other over without end: 1,643 links
  in 3 s, each takeover publishing the former link's will.

The options weighed:

- **MQTT 3.1.1 beside 5.0**: none of the five properties the binding stands on.
- **The libraries' own reconnection, resubscription and offline queue**: a link would carry what
  another asked, which 15.21's incarnation forbids.
- **A takeover read as a link lost**, relinking at once: the probes' flap, a will and every
  connection dropped at each turn.
- **A relink after a takeover backed off**: two holders still take each other over, slower.
- **Taking a packet up to `v(R) − 1` bytes past its own bound**, as Mosquitto sends one, so that no
  publisher outside Bead's count ends a participant's link: the standard calls it a Protocol Error
  (§3.1.2.11.4) and MQTT.js already ends its link on it.
- **A received message's remaining life in the adapter's contract**: no part of the core reads it.

## Decision

**MQTT 5.0 alone, over TCP, TLS or a WebSocket of subprotocol `mqtt`** (spec 15.25,
[MQTT-6.0.0-3], [RFC 6455 §1.9](https://www.rfc-editor.org/rfc/rfc6455#section-1.9)). A parcel is
one PUBLISH's payload, a topic its tokens joined by `/`, and a name in a group the shared
subscription `$share/<name>/<root>/s/<name>`, its share name the server's name, so every
participant serving it, whichever side, joins one group. A broker whose CONNACK says Shared
Subscription Available 0, or whose SUBACK says 0x9E, offers no group, and a name over it is served
by one participant alone. Its handles' type is `MQTT`.

**A link is one network connection that keeps no session** (spec 15.26): Clean Start 1, Session
Expiry 0, the participant's id its Client Identifier, authenticated by a User Name and a Password,
asked anew at each link where it expires, or by a TLS client certificate its broker ties to the
id; Receive Maximum 65,535; Topic Alias Maximum 0; Maximum Packet Size its `maximumPacketSize`,
16,777,216 by default and never without end (0033); Keep Alive its `keepAlive`, 30 s by default and
never 0, so its will comes at 45 s, inside the 60 s a connection's heartbeat takes. A Server Keep
Alive replaces it: MQTT.js applies it, and the C# adapter sends a PINGREQ once nothing went for a
shorter one. A start waits `connectTimeout`, 30 s by default, for its CONNACK, which fails it on a
reason but 0x00 and on a Maximum QoS of 0. The will is the participant's GONE, QoS 1, RETAIN 0,
Delay 0; a stop is a DISCONNECT of 0x00, so no will goes.

**A link taken over is fenced** (spec 15.21): a DISCONNECT of 0x8E from its broker is its link
taken over by another of its id. The adapter tells its `down` so, `isTakenOver` / `IsTakenOver`,
and its participant closes each connection, unclean, reports it, and connects no more until its
application starts it again: its server's transports take no OPEN, its clients' connects fail
naming it. The later link keeps the id, as Kafka fences its older producer. Any other end of the
network connection is its link lost, after which the participant links anew as another
incarnation, as before.

**A subscription is QoS 1, No Local 0, Retain As Published 0, Retain Handling 2** (spec 15.27),
one filter a SUBSCRIBE, held once its SUBACK grants QoS 1, refused otherwise, a QoS 0 granted among
the refusals. A SUBACK proves no authorization.

**A publication is QoS 1, or QoS 0 at most once, RETAIN 0, and carries nothing but a Message Expiry
Interval** where the core asks one (spec 15.28): a parcel names its connection, an OPEN and an
ACCEPT their inbox (0040). The adapter keeps the send quota of its CONNACK's Receive Maximum
itself, per incarnation, later publications waiting in order, no other packet delayed; reads a
PUBACK under 0x80 but 0x10 as taken, 0x10 as no subscriber, 0x80 or more as refused; counts each
packet before it goes, refusing one past its CONNACK's bound; and refuses what is asked while its
link is down. **The PUBACK goes once the core took the message** (spec 15.29), always 0x00, since one
of 0x80 or more would discard it for every member of a group ([MQTT-4.8.2-6]); a message whose
RETAIN is 1 is dropped and acknowledged; a packet past its own bound closes its network connection.

**Every bound is counted to the byte by one formula** (spec 15.30): `S = 1 + v(R) + R`,
`R = 2 + T + Q + v(P) + P + N`, a Message Expiry Interval's five bytes counted whatever the
message, the largest payload found by a search since `v(R)` grows with N. The receive bound is
asked of the adapter by topic, its inbox's, since MQTT counts the topic in every packet; under the
default, `bead/i/server` takes 16,777,188 bytes.

**The core gives a life where its adapter offers `expiry`** (spec 15.18, 15.22): an OPEN its
connect's time left, so one no member took in time is deleted in its broker; a DATA that carries a
credential twice `heartbeat` on its first part, so a bearer credential waits there no longer than a
live connection may be silent ([RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750#section-5.3));
nothing else. The adapter writes it in whole seconds, rounded up, 1 at least.

**A server's names are its broker's word**: a server's transport starts once its broker holds each
name it serves, fails on one refused, and stops once it let each go; its gauge `names` counts a
name from its SUBACK to its UNSUBACK.

**A deployment's broker is half of the binding** (spec 15.31): it ties each Client Identifier to
the identity it authenticated; its access control, by that id, lets a participant alone read its
inbox and its will alone write its departure, every participant write any inbox and read any
departure, a server's participants alone read its name on the name's own topic and its clients
alone write it; its queues are lifted or sized to `maximumConnections` × `maximumUnsentBytes`; its
receive maximum is sized for a server's participant. No participant writes a retained message, and
a broker that serves Bead alone may refuse them. `tools/mqtt-broker.mjs` is its example: Mosquitto
by its digest, a password drawn per run, a container name and loopback ports of its own.

**The libraries' automation is off**: no reconnection, resubscription, offline queue or alias; a
new client each incarnation; every callback, closure, quota slot and PUBACK entry gated by the
incarnation it was made in; a call given up whose packet may have gone retires its link.

## Consequences

**The binding's other half is a deployment's configuration**, and a broker of the wrong access
control times connects out rather than refusing them: a publication whose every subscriber it
denies is taken, PUBACK 0x00, so a server's participant not granted its name's topic leaves its
clients' connects to wait their time.

**Every bound gives up five bytes** a publication may not use, a life's, so that a message that
comes with what is left of one still fits.

**A participant's link carries at most its broker's Receive Maximum a round trip**: about 667
publications a second at Mosquitto's default 20 and 30 ms, which the heartbeat of 10,000 idle
connections, 333 to 667 a second of a server's participant, can take whole. A deployment lifts it
for a server's participant; a broker beside it, under 1 ms, carries some 20,000.

**A takeover fences the earlier link without an epoch**: a draining process whose own link blips
after its successor linked takes the id back and leaves the successor down until it is started
again. A deployment gives each process its own id.

**Both sides close on a packet past their own bound without the DISCONNECT of 0x95** that MQTT 5
§4.13.1 says SHOULD go first, since MQTT.js gives its adapter no way to send it; the C# adapter
reads each received packet's size itself to match. A row of "Leveled down" in
[`docs/support.md`](../support.md). Neither library's check bounds memory: only the broker's
respect of [MQTT-3.1.2-24] does.

**A participant can end another's link through Mosquitto's undercount**, publishing a packet of
its own past the other's bound: a deployment's access control lets only its participants publish
to an inbox, so it is a participant's to do to another, as it could flood one. The count is
Mosquitto's to fix, which Bead does not wait on.

**The will hastens what the heartbeat finds** only under a Keep Alive of half the heartbeat at
most, 30 s against 60 s by default.

**What stays open**: an Authentication Method (MQTT 5 §4.12); EMQX; a page's own TLS options,
since no page chooses its client certificate, which the TypeScript adapter refuses there, a row of
"Differences"; TLS itself, which the fixture's broker, in clear on the loopback, does not play.

**Its gates**: the cases over `mqtt` and the broker cases 37 to 45 of `spec/transports.json`;
`mqttPublishBounds`; the places `mqttBrokerAdapter.keepAlive` and `mqttBrokerAdapter.connectTimeout`;
the adapters' twins, against a scripted MQTT 5 peer and against the fixture; the interop over MQTT
5 both ways, a name served by two in one group proven by no ACCEPT ever answered twice; and the CI
job `mqtt`, `BEAD_MQTT_REQUIRED=1`.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)):
eleven objections, each verified against its probe or its source before it was answered, ten
accepted, one in part, none refused. The dissent also checked and upheld the draft's reading of
§4.8.2's SHOULD for a dead member's QoS 1 message.

| Objection                                                                                                                                                                                                                                                                                                            | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neither library keeps the send quota of its CONNACK's Receive Maximum ([MQTT-3.3.4-7], [MQTT-4.9.0-1], [-2]), so a broker that holds back its PUBACK ends the link with 0x93; nothing reads Maximum QoS ([MQTT-3.2.2-11]); the cost of the quota, a link's rate, goes unstated.                                      | **Accepted.** Verified: a scripted broker of Receive Maximum 2 gets 5 of 5 PUBLISH packets from each library; MQTT.js's `_receiveMaximum` counts inbound QoS 2 alone; MQTTnet's `PublishAtLeastOnce` goes straight to `Request`; Mosquitto PUBACKs at once and its own check is compiled out. Each adapter keeps the quota per incarnation, 65,535 where the CONNACK names none, later publications waiting in order, no other packet delayed ([MQTT-3.3.4-8]); a waiting publication its signal aborts leaves unsent; 15.28 states it, 15.19's "pacing its link" names the adapter; a Maximum QoS of 0 fails the start; 15.31 has the deployment size its receive maximum; a twin test plays Receive Maximum 2 against the scripted peer. The rate is stated: at 20 and 30 ms, about 667 a second, which the heartbeat of 10,000 idle connections can take whole, at 333 to 667 a second of a server's participant, not the 1,333 the objection gives, which counts both ends' packets as the server's. |
| A takeover is handled as a link lost and the first relink does not wait, so two holders of one id take each other over without end, each takeover a will published and every connection dropped; on a broker that does not tie the Client Identifier to what it authenticated, any participant can do it to another. | **Accepted.** Verified: 1,643 links in 3 s against the pinned Mosquitto; both sides' first attempt goes at once. A DISCONNECT of 0x8E is the link taken over: the adapter's `down` carries it, and its participant reports it and connects no more until its application starts it again, a state of its own, since the state no reconnection leaves relinks at the next connect. The newer holder keeps the id, as Kafka fences its older producer. The in-memory adapter gains `takeOver()` beside `lose()`, keeping one adapter to an id; a case plays it on both transports. 15.31 makes the tie a MUST, its reason the will a forger would have published; the player stops every participant before the next case. The cost is stated: without an epoch, a process whose own link blips after its successor linked takes the id back; a deployment gives each process its own id.                                                                                                                  |
| MQTTnet does not apply a Server Keep Alive ([MQTT-3.2.2-21]); its `Options.Timeout` does not do what the draft says; `InspectPacketAsync` is settled by the sources and bounds no memory.                                                                                                                            | **Accepted.** Verified: MQTTnet reads the Server Keep Alive only to start its loop, which pings on its own period, and its link is lost at 7.06 s under a Server Keep Alive of 4, where MQTT.js holds. The C# adapter sends a PINGREQ once nothing went for a shorter Server Keep Alive, every sent packet seen by its inspector; a twin test plays it. Every MQTTnet call gets a cancellable token of its incarnation, the CONNECT's cancelled after `connectTimeout`. `Options.Timeout` then bounds only the transport's close, which MQTTnet awaits before `DisconnectedAsync`: set to 1 s, so a dead link's `down` is not held 100 s. `InspectPacketAsync` is raised before decode and dispatch, after the body is read: neither library's check bounds memory, only the broker's respect of [MQTT-3.1.2-24].                                                                                                                                                                                        |
| 15.29's DISCONNECT 0x95 is one the TypeScript adapter cannot send: MQTT.js destroys its stream, then emits the error.                                                                                                                                                                                                | **Accepted.** Verified in MQTT.js's handlers and client. 15.29 reads "it closes its network connection, its link lost"; the C# adapter closes alike, its incarnation retired and its client disposed; the DISCONNECT 0x95, §4.13.1's SHOULD, is a row of "Leveled down" with the renamed twin test, to lift by a guard on the adapter's own stream or a library that writes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A received message's remaining life widens the adapter's contract for one case that the core never reads, and a time window on a real broker times a shared runner.                                                                                                                                                  | **Accepted.** What 15.18 and 15.22 require is what the core asks of its adapter, and the adapter keeps to bytes at topics (0040). A case reads, through a recording adapter the player wraps around the side's, an OPEN asked 10,000 ms, a credential's DATA 60,000 and every other parcel none, exactly, on the clock given, over the in-memory broker and MQTT 5 alike; the MQTT adapter's writing it in seconds is its twin test's; forwarding what is left is Mosquitto's ([MQTT-3.3.2-6]). The member, its C# twin and the in-memory broker's handing on of a life are dropped.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The interop's "a name served by two" passes with no group and with two groups, since the client resets the second ACCEPT and each call is still answered.                                                                                                                                                            | **Accepted.** Verified against 15.18 and [MQTT-4.8.2-1], [-2]. The interop client's wrapped adapter counts the ACCEPTs it reads for an opener half already answered, zero over sixteen connects to `interop-both`, in both directions: that is what proves a TypeScript member and a C# member in one group.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Every run on a machine shares one container name, two fixed ports and one set of ids, so two runs at once collide, then take each other's links over.                                                                                                                                                                | **In part.** Accepted: `start` draws its container's name, lets Docker pick its loopback ports and reads them back, prints them with the URLs and `BEAD_MQTT_BROKER`, and `stop` takes that broker; the native mode finds two free ports; the ids stay as the file has them. Not taken as written: the suites do not start a broker themselves, which would put Docker inside the suites and blur the skip that says no broker is given; the tool gains `run -- <command>`, which gives each suite, terminal or worktree a broker of its own in one line. With the takeover fenced, a collision fails a case rather than flapping.                                                                                                                                                                                                                                                                                                                                                                       |
| 15.26 writes password authentication into the wire, though a broker may authenticate a link by its TLS client certificate alone.                                                                                                                                                                                     | **Accepted.** Verified: Mosquitto's `use_identity_as_username` leaves the password file unused on its listener, and `use_username_as_clientid` then ties the certificate's identity to the Client Identifier; MQTT 5 makes User Name and Password each optional (§3.1.2.8, §3.1.2.9). 15.26 has the link authenticated by the deployment's means, a User Name with a Password, or a client certificate its broker ties to the id; each adapter passes a certificate to its library in Node and .NET; a page cannot choose one, so the TypeScript adapter refuses it there, a row of "Differences", and TLS stays a "not tested" row, work to do.                                                                                                                                                                                                                                                                                                                                                         |
| 15.31's SHOULD refuse retained messages cannot be kept on a broker shared with clients that retain, since `retain_available` is broker-wide, and buys little.                                                                                                                                                        | **Accepted.** Verified: the option applies globally; Retain Handling 2 hands no retained copy and Retain As Published 0 forwards a live one as live. 15.31 states that no participant writes a retained message and none reaches one, a copy left on a Bead topic the deployment's to clear, and that a broker serving Bead alone MAY refuse them, as the fixture does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The WebSocket leg is played by a page alone, never by the C# side, nor by the TypeScript side in Node.                                                                                                                                                                                                               | **Accepted.** Each adapter's suite carries a link over the fixture's WebSocket listener, the TypeScript side in Node through MQTT.js's own `ws`. The C# adapter sets MQTTnet's `SubProtocols` to `mqtt` itself, since its sources show no default; the test settles it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Mosquitto's undercount is one byte outbound and none inbound, not one byte both ways.                                                                                                                                                                                                                                | **Accepted.** Verified: toward a subscriber of bound 1,052 a 1,053-byte packet (R 1,050) went and R 1,051 was dropped; from a publisher under 4,096, packets of 4,097 and 4,098 bytes were taken and R 4,096 drew 0x95. The finding reads: toward a subscriber it counts the Remaining Length as one byte, so it sends up to `v(R) − 1` bytes past the subscriber's bound; from a publisher as none, so it takes up to `v(R)` bytes past its own; so here, and in the report for Mosquitto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
