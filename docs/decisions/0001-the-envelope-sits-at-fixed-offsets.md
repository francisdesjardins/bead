# 0001 — The envelope sits at fixed big-endian offsets, behind an 8-byte prefix and its layout byte

- **Status**: accepted
- **Scope**: the protocol, and every implementation

## Context

Bead's routers need a unit to carry a call across a transport that already delimits its messages:
a WebSocket message, an HTTP body, a Web Worker's message. A peer may decode that unit by hand, on a
constrained device, where a field read at a fixed offset costs nothing and a parser costs code. A
transport that pairs an answer with its exchange, or a relay that passes a payload on undecoded,
wants to read a few fields and nothing else.

Four layouts were weighed. A header of fixed 32-bit words with an exact payload length keeps every
offset fixed, but its length caps a payload at 16 MiB, its fields share bits, and an error written
into the header says again what the payload says; a request costs 24 bytes before its payload. A
self-describing encoding, tags and varints, costs a decoder on every peer, and its offsets move with
the values. A text header in HTTP's style reads well and costs a parser. A payload wrapped by a
serialization framework ties every peer to that framework. None of them keeps the offsets fixed
while dropping the length and the double error.

## Decision

**An envelope is an 8-byte prefix at fixed offsets, in network byte order**: the layout byte
(`0xA1`), the kind, the flags, the header's length in 4-byte words, then the call id on four bytes.
A request adds its service and its procedure, two bytes each; a chunk adds its offset, and a credit
its end, eight bytes each. The payload runs to the end of the transport's message. There is no
length field: each transport delimits the envelope. It is called an envelope, not a frame: a frame
is what WebSocket carries it in. Every layout from `0xA1` to `0xAF` keeps the prefix where it is, so
a reader that does not read a layout still knows the call to refuse it on.

**The flags split on a nibble.** The low one adds blocks, laid out after the kind's own part in the
order of their bits: DESTINATION `0x02`, 4 bytes on a request; TRANSFER `0x04`, a payload's 8-byte
total; CREDENTIAL `0x08`, a credential of a scheme, the last block and the one whose length varies
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)); and `0x01` kept for a block to come.
The high one adds none: SUBSCRIPTION `0x10`, on a request that opens a subscription; PACED `0x20`
([0002](0002-a-subscription-goes-at-its-clients-pace.md)); MORE `0x40`, on a chunk that another
follows; and `0x80` kept. A reader knows a header's length from its kind, `flags & 0x0F`, and, with
CREDENTIAL, the length its block states, and a bit of the high nibble never moves an offset. Each
flag is allowed on its kinds alone, and any other makes the envelope malformed.

**A call id pairs everything.** It is odd when a client opened the call and even when a server did,
so the two sides never draw the same one, and a subscription's notifications carry the call id of
the request that opened it.

**A request says whether it opens a subscription**, and a server subscribes the requester of no
other: an ordinary request to a notification's procedure gets its answer and subscribes nothing, and
a resolver that subscribes it anyway fails, as a programming error. The intent is said, never
guessed, as a CoAP GET registers an observer only with its Observe option (RFC 7641) and a gRPC
method declares its server stream: a server that guessed from the procedure alone would let an
ordinary request, answered first, take the place of the subscription behind it.

**A failure travels once, in its envelope's payload**: a code on two bytes, the relays it crossed, a
flag for a procedure's own code, and a readable detail. The protocol's codes come in blocks of 16 by
how far a request went (envelope, route, admission, payload, procedure), so a peer that does not
know a code still knows the stage. Each router raises them as its own side, from the one list of
codes, so a refusal says which side refused without a side ever being sent: a failure received with
no relay is the peer's. Through a relay no side is known, and the scope alone tells the protocol's
codes from a procedure's.

**Every bit this layout does not define refuses the envelope as malformed**, and so do bytes after
the header of a kind that carries no payload, a credit's or a cancel's, and a chunk that carries
none.

**A payload larger than an envelope goes as a transfer, in this same layout**, as HTTP/2 splits a
stream into frames rather than sending one frame of a 64-bit length. The request or the result that
opens it declares the payload's total, eight bytes behind the TRANSFER flag, and carries its first
bytes without credit. The receiver answers with a credit: the offset below which the sender may
send, absolute, the highest one received counting, so a credit repeated, late or out of order never
grants too much, as QUIC's `MAX_STREAM_DATA` does (RFC 9000 §4.1). The sender sends chunks, an
eight-byte offset each and the MORE flag on all but the last, full ones only, the last reaching the
total, which is the simplest form of TCP's rule against silly windows (RFC 1122 §4.2.3.4). The
receiver places them in any order, drops what it has, and refuses a chunk before the last that is
not full, or one over bytes it holds in part, so a peer cannot make it hold a byte in slivers; it
grants a window past what it holds from the start each time half of the last one is used. A refusal
(route, admission, size, capacity) falls on the opening, before any credit, so the bulk of a refused
payload never crosses. The requester ends a transfer with a cancel, the side that answers with a
failure; a call that received a transfer keeps its call id a while once it ends, so a late copy of a
chunk under the credit granted is dropped in silence. A notification, a failure, and the result of a
call that opens a subscription are never split: nothing arrives ahead of a result still coming, and
no end of a session cuts one.

**A relay terminates each leg**, as a gateway does for what stands behind it, each destination
answering the same procedures. A request that names a destination is asked the relay's admission on
its header, then whether its destination exists, then the smaller of both legs' limits; every
refusal falls on the opening, and a requester not admitted learns only whether the relay has any
destination. It then goes on to its target as a request of the relay's own, its payload's bytes
undecoded, under a call id of that leg. The answer comes back under the requester's call id: a
result as it came, a failure of the target's one relay more. What the relay raises itself says how
far the request went, as every code does: `DESTINATION_UNREACHABLE` (17) while the relay's transport
was never handed the request, or refused it, so nothing was tried, and `DESTINATION_LOST` (65) once
that transport had it and the target was lost, the procedure run or not: HTTP's gateway 502 against
its 504, and what gRPC's retry rules turn on. Those failures name no address behind the relay: why
leg B failed is reported where the relay runs. A cancel on leg A cancels leg B. A destination on a
connection of the relay's own dies with that connection, so a newcomer under the same handle is
never taken for it. An answer names its call alone, so no RESULT or FAILURE carries a destination:
an id means something to its relay only. A relay carries no subscription yet: it refuses a request
that opens one with `SUBSCRIPTION_UNSUPPORTED` (22), the code of any path that carries no
notification back. It forms no chain: leg B names no destination, so no loop can form, and a request
on its way further would need a count of the relays it crossed, as IP's TTL and HTTP's `Via`
(RFC 9110 §7.6.3) have.

**The transports carry bytes**, and one that carries transfers owes four things: it delimits its
messages; it knows the envelope's size at both ends, since nothing announces it yet; it delivers
every chunk and every credit, in any order, a copy tolerated, since Bead retransmits nothing and a
loss ends in the transfer's inactivity; and it carries both ways, the credit against the chunks. The
router copies what it reads, so a transport may use its buffers again. Whether a connection is alive
is the transport's to know, not Bead's, which has no ping: over WebSocket, each end sends the
protocol's own PING control frame at an interval and drops a connection that leaves one unanswered
(RFC 6455 §5.5.2), so a peer gone without a word ends in a close, as every loss does.

**A transport that keeps no connection draws one.** Over HTTP, and over any such transport to come,
the transport draws a 16-byte token from a cryptographic source when a client connects, and the
client presents it on every exchange. The router, the sessions and the relays see a connection, as
over a socket, so a client still never presents its session. The token is worth the session it
holds: it crosses only TLS off the machine, and no URL, handle, detail or log carries it. Such a
transport reads three things of an envelope and nothing else, its layout, its kind and its call id,
in the prefix every layout keeps, to hand an answer to the exchange that carried its request, as
HTTP/2 hands a frame to its stream by an id at a fixed offset (RFC 9113 §4.1). An exchange waits
only for the answer to a request of the peer's parity; any other ends at once and empty, a cancel's
included, so a cancel is still never answered. An exchange lost closes the connection at both ends,
as a socket that drops does, and a client's send settles on the head of its answer, so a relay
still tells a request never tried, refused by a status the transport marks as its own, from one lost
after, which any other status is: an intermediary's may come once the request ran. What the server
sends of its own has no exchange to go on, so it waits, numbered, in the connection's outbox, for
its client to listen: to ask for it by an exchange of its own, which the server holds until
something comes, long polling as RFC 6202 lays it out rather than a response held open. Each listen
acknowledges what its client heard whole; what it did not comes again, as a stream's lost frames are
sent again (RFC 9000 §13.3). The client reads a batch as it comes and bounds each envelope alone, as
HTTP/2 bounds its frames and never its streams (RFC 9113 §4.2). A client says at connect, once for
the connection's life, whether it listens, and the server says it back, as a WebSocket subprotocol
is chosen once (RFC 6455 §4.2.2): to one that does not listen, a request that opens a subscription
is refused, `SUBSCRIPTION_UNSUPPORTED`. A transfer, whose credit would have to come back as its
request goes, is not taken.

**What does not read goes through one gate**: a request whose prefix reads, of the peer's parity, on
a call id neither open nor held, is answered with a failure on that call id; an answer of this
layout ends the call it answers, and a chunk the transfer it was for, while its payload is not
whole; anything else is reported, never answered, since an answer on any other call id could settle
someone else's call.

**A requester gives up a call with a cancel**: 8 bytes, the prefix alone, on a call it still holds
open (unanswered, a subscription, a transfer it refuses), never on one it holds complete. A cancel is
never answered, and one that names no call is dropped in silence, having crossed its answer. The
other end forgets the call, takes away what it subscribed, then stops what still works on it, so
nothing more goes out on that call id. The requester reserves the call id as long as the call was
given, 5 seconds when it was given no time, or, once a result came to it as a transfer, as long as
the other end keeps that call abandoned, should that be longer; it drops in silence what comes late
on it. This is HTTP/2's `RST_STREAM` narrowed to the requester, as a gRPC client cancels: the side
that answers ends a call with a failure, which carries a code, so a cancel needs none; and since
call ids come back, a cancel on an id that names no call is no error, where `RST_STREAM` on an idle
stream is one.

## Consequences

**A request is 12 bytes of header, and a result, a failure and a notification 8**, against 24 for
the layout of 32-bit words. A chunk and a credit are 16, and a cancel 8 with nothing after it.

**A 64-bit field holds 2⁵³ − 1 at most**, a chunk's offset, a credit's end or a transfer's total, so
an implementation whose numbers are IEEE 754 doubles reads every value exactly. A writer never
writes more, and a reader refuses it.

**A side cycles through its call ids in 2.5 days at 10,000 calls a second**, 2³¹ odd ids, and skips
the ones still in use or reserved, so an id comes back only once its call has ended and its
reservation has passed.

**A cancel can overtake its request on a transport that does not keep their order**, HTTP's or any
other whose exchanges race: the router would drop it as naming no call, and the request would run.
The transport of the side that answers buries such a call id for the least a requester reserves one,
5 seconds, and drops the request that comes under it; HTTP's does.

**A session is a 128-bit token drawn from a cryptographic source**, announced on an answer only when
it changes, and never presented by a client: over a connection, the connection is the session.

**Every requester behind a relay shares its leg B**: one session at the target, one space of call
ids, and the target's transfer places. The relay's admission, which sees the procedure and the
destination, is where each requester's rights are checked; the target sees the relay alone.

**A payload is bounded by the router's limits, not by the envelope**: 16,777,216 bytes by default,
and more when both ends are set so. One whose envelope would pass a chunk, 1 MiB, goes as a
transfer, which costs one round trip more than a whole envelope, its throughput bounded by the
window over the round trip: 4 MiB at 100 ms, some 40 MiB a second. A payload is whole in memory at
both ends, and what a router receives holds a budget of its own, 256 MiB by default, reserved as the
credit grants it: a transfer admitted may still stall should that budget not free. Payloads of
several gigabytes wait for streams.

**The why is here, the rule is in [`spec/spec.md`](../../spec/spec.md)**, sections 1 to 10 and 12 to
15, and the bytes are in `spec/vectors.json`, which every implementation reads
([0004](0004-one-behaviour-in-every-language.md)).
