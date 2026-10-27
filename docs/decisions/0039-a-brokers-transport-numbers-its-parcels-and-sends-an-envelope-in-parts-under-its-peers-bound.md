# 0039 — A broker's transport numbers its parcels, and sends an envelope in parts under its peer's bound

- **Status**: accepted
- **Scope**: the protocol, and every implementation's core: in [`spec/spec.md`](../../spec/spec.md),
  the parcel, its prefix, its kinds, its flags and what does not read, in 15.17; a parcel's sequence,
  a copy, a loss, the delivery an adapter gives and its acknowledgement, in 15.19; an envelope in
  parts under its peer's bound, and the bounds on parts, in 15.20; the order 15.1 keeps over a
  broker; the groups `parcels` and `parcelRefusals` of
  [`spec/vectors.json`](../../spec/vectors.json); the broker cases of
  [`spec/transports.json`](../../spec/transports.json) of copies, gaps and parts; the place
  `brokerParticipant.bodyGracePeriod` of [`spec/durations.json`](../../spec/durations.json). The
  layout's axis is [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)'s; the
  family of bounds [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s; placement, the open
  and the end
  [0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)'s,
  which keeps this record's round of the Tenth Man.

## Context

**The envelope gives a transport nothing to write in it**
([0001](0001-the-envelope-sits-at-fixed-offsets.md)), and a broker's transport needs an identity of
its own: the connection a message belongs to and its place in it, as HTTP's transport keeps its
token (15.4) and its `bead-sequence` (15.9) beside the envelope.

**A broker repeats, and the router cannot tell a copy.** A request delivered twice while its call is
open is reported `ENVELOPE_MALFORMED` and answered nothing (9.2, step 2); delivered twice once its
call ended, it runs again and answers twice; once its call id is drawn again, its copy is answered
on the new call. A probe of the round played the first two against the routers.

**A broker keeps a publisher's order on a topic.** MQTT 5 hands a non-shared subscription's messages
for the same topic and QoS in the order received from any one client ([MQTT-4.6.0-5], [-6]), resends
only into a resumed session ([MQTT-4.4.0-1]) and then in the original order ([MQTT-4.6.0-1]); core
NATS keeps a publisher's order alike; an AMQP inbox ends with its link. A message past the next one
awaited means one dropped for good.

**A broker bounds a message, often below Bead's envelope.** With a parcel's 28 bytes of prefix,
one message carries an envelope of about 268 MB on Mosquitto 2.1.2, the protocol's, its
`max_packet_size` without a limit by default, 1,048,510 on EMQX 6.3.2 (1 MiB), about 16,777,124 on
RabbitMQ 4.4.0 (16 MiB) and 1,048,548 on nats-server 2.15.1 (`max_payload` 1 MiB): a chunk of
1,048,576 bytes needs two parts on EMQX and NATS, and an envelope of `maximumEnvelopeBytes`,
16,778,240, seventeen. A packet past its receiver's Maximum Packet Size is discarded by its broker,
a loss ([MQTT-3.1.2-25]), and one a broker sends all the same ends its receiver's link (MQTT 5.0
§3.1.2.11.4, §4.13.1), as [0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md) counts it.

The options weighed:

- **The identity in the broker's properties**, MQTT 5's user properties or AMQP's
  `correlation-id`: core NATS carries none on a plain PUB, a bridge that drops MQTT 5 properties
  loses them, and the core would read a property of each broker.
- **A set of the ids seen**, against copies: state kept per message, which a publisher's order
  makes needless.
- **A hold past a gap**, with bounds on what it holds and a gap timeout: on MQTT it waits for what
  cannot come.
- **A connect refused** where a broker's bound is under the router's: every default deployment
  would lower `maximumEnvelopeBytes` to its broker's, and `chunkBytes` on EMQX and NATS, and a
  router's limits would differ by broker (12.2).
- **Exactly once**, MQTT's QoS 2: four packets a message, where a sequence drops a copy already.

## Decision

**A parcel frames each envelope**, one broker message a parcel and one parcel a message, its bytes
the message's payload (spec 15.17): its layout on a byte, `0xB1`, `0xB2` to `0xBF` the layouts to
come, never `0xA1` to `0xAF`, an envelope's, so neither is read for the other; its kind, its flags,
a byte kept, the opener's half and the acceptor's, and its sequence, 28 bytes; then its body. In
the payload, it is read alike by every binding, and the inbox an OPEN and an ACCEPT name is in it
too, so the core reads no property of a broker. Every layout keeps a parcel's first 28 bytes, an
OPEN's id at the head of its body, and a REFUSE whole, as 2.1 keeps an envelope's prefix
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)). A kind to come, taken in
its order, closes its connection with 1002, as 3.3 refuses an envelope's kind to come; 0x80 to 0xFF
are advisory, taken in their order and skipped, as 3.4 skips an envelope's. A message that is no
parcel is dropped in silence and reported; a parcel that does not read closes its connection with
1002, reported. "Parcel" is its word ([0003](0003-one-word-one-meaning.md)): a frame is a
WebSocket's and an AMQP connection's, a message a broker's.

**Each end numbers what it sends on a connection, from 1** (spec 15.19), one more each parcel but a
RESET and a GONE, and its receiver hands each on in that order, once. The window against copies is
one number a direction, the next sequence awaited: a parcel below it is a copy — a broker's
redelivery, an OPEN delivered twice, a copy a test asks of the in-memory broker — dropped in silence
and acknowledged, so a request's copy never reaches the router, whether its call is open, ended or
its call id drawn again. No set of ids is kept, since a broker keeps a publisher's order on one
topic. A parcel past the next one awaited is a loss: its connection is lost at once, a CLOSE of
4000, unclean, reported naming the sequence awaited and the one that came. Nothing is held past a
gap, and nothing overtakes on a connection: a cancel numbered after its request never comes before
it, so 15.1's default order holds over a broker.

**The stale horizon is the pair**: a parcel of a pair its receiver does not hold matches nothing — a
closed connection's, a former incarnation's, a second acceptor's
([0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)) —
and no drawer draws a half twice while it holds it.

**An adapter delivers at least once or at most once.** At least once by default: its broker
acknowledges a publication it took, MQTT's QoS 1 and its PUBACK, AMQP's settlement `accepted`, and
its link's flow control holds a participant's publications to what its broker takes, Receive
Maximum being a quota on QoS 1 and 2 alone ([MQTT-4.9.0-2]). At most once where an application asks
it, nothing acknowledged: MQTT's QoS 0, AMQP pre-settled, core NATS. Either holds within its
broker's queue alone, and a message the broker drops is a loss. An application that requires at
least once of an adapter that gives at most once is refused as it is built. No binding uses exactly
once.

**A participant acknowledges a message as it takes it**, handed on or dropped as a copy, never once
its router or a callback is done with it: an acknowledgement held to pace one call would stall every
connection of the link, MQTT 5 §4.9's quota being the network connection's, and Bead's credit paces
([0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)).

**An envelope goes in parts under the bound its peer announced at the open** (spec 15.20). An OPEN
and an ACCEPT carry each end's receive bound, the largest parcel its inbox takes whole, 1,024 bytes
at least, as TCP's SYN announces its MSS
([RFC 9293 §3.7.1](https://www.rfc-editor.org/rfc/rfc9293#section-3.7.1)) and AMQP's OPEN its
`max-frame-size`. A parcel toward a peer never passes the smaller of that bound and the largest its
own adapter publishes to the peer's inbox. An envelope past it goes in parts: consecutive DATA
parcels, each as large as the bound lets it but the last, `MORE` on each but the last, a credential
on the first alone, nothing else of that direction between them, so a connection holds one envelope
in parts each way at most, handed on once its last part came, as a WebSocket's message in fragments
is one ([RFC 6455 §5.4](https://www.rfc-editor.org/rfc/rfc6455#section-5.4)). A broker's bound so
bounds a parcel, never an envelope, and a router's limits are the same over every broker (12.2).

**Parts are bounded as a body is** ([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)): one
envelope's parts by `maximumEnvelopePartsBytes`, past which its connection closes with 1009; what a
participant holds in parts across its connections by `heldBytesBudget`, a part that would pass it
losing its own connection; and an envelope's parts to a body's rate, `minimumBodyBytesPerSecond`
once `bodyGracePeriod` passed since its first part, on the clock given, or its connection is lost;
each reported, naming the bound and its value.

## Consequences

**A message costs 28 bytes**, and an envelope past its peer's bound a parcel a part: at EMQX's and
NATS's defaults a chunk goes in two, which the router never sees.

**A broker's queue overrun loses connections**: a server participant's queue fills first, every
client's parcels crossing its one link, and a parcel past the gap it leaves ends its connection,
told; a dropped tail shows at the connection's next heartbeat. Each binding states the queue
settings a server participant needs.

**A reorder within one link would lose a connection**: should the AMQP 1.0 binding measure a
RabbitMQ requeue that reorders past the next parcel, it brings a hold then, with its case.

**One envelope in parts each way**: a large result holds its direction until its last part, as a
WebSocket's fragmented message does; the transfers of 12.4 stay the way to interleave large payloads
with calls.

**Its gates**: the groups `parcels` and `parcelRefusals` of `spec/vectors.json`, each kind read and
written back and each refusal of 15.17, played by both codecs; the broker cases of
`spec/transports.json` of an OPEN and a DATA delivered twice, a cancel before its request, a result
and a request in parts, parts past their bound, their budget and their rate, and a queue overrun's
gap; the place `brokerParticipant.bodyGracePeriod`; and the sequence's twins, named by one sentence
on both sides ([`docs/support.md`](../support.md)).

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
the round of the broker's core, which
[0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md) keeps:
its objections on the layout to come and a kind to come, on a gap no broker fills, on parts with no
time bound and on the bytes both sides write are answered there.
