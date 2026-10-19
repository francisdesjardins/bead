# 0001 — The envelope sits at fixed big-endian offsets, behind an 8-byte prefix and its layout byte

- **Status**: accepted
- **Scope**: the protocol, and every implementation: the envelope, its calls, its transfers, its
  cancel, and what a connection's close ends of them. A relay is
  [0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)'s, and the connection HTTP
  draws [0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)'s.

## Context

Bead's routers need a unit to carry a call across a transport that already delimits its messages: a
WebSocket message, an HTTP body, a Web Worker's message, or whatever message a transport delimits. A
peer may decode that unit by hand, on a constrained device, where a field read at a fixed offset
costs nothing and a parser costs code. A transport that pairs an answer with its exchange, or a
relay that passes a payload on undecoded, wants to read a few fields and nothing else.

Four layouts were weighed. A header of fixed 32-bit words with an exact payload length keeps every
offset fixed, but its length caps a payload at 16 MiB, its fields share bits, and an error written
into the header says again what the payload says; a request costs 24 bytes before its payload. A
self-describing encoding, tags and varints, costs a decoder on every peer, and its offsets move with
the values. A text header in HTTP's style reads well and costs a parser. A payload wrapped by a
serialization framework ties every peer to that framework. None of them keeps the offsets fixed
while dropping the length and the double error.

## Decision

### The envelope

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

**A failure answered for an error of the side's own carries none of that error**: a resolver that
throws, a verifier or an admission that fails, a result the side cannot send, an answer a relay's
leg A cannot carry, a codec that throws other than a refusal. Its code says how far the call went,
which is all its requester acts on; the error, an exception's message above all, is reported where
the side runs, since its internals tell a peer nothing it can use and tell an attacker what to try
next, as OWASP's Application Security Verification Standard returns a generic message to the
consumer of an unexpected error (ASVS 5.0, 16.5.1). `PROCEDURE_FAILED` so answered carries no
detail at all, the one form every language writes alike (spec 9.0).

**Every bit this layout does not define refuses the envelope as malformed**, and so do bytes after
the header of a kind that carries no payload, a credit's or a cancel's, and a chunk that carries
none. A credential scheme to come is no bit: its block is read whole, by the length it states, and
the request is refused at admission, `CREDENTIAL_UNSUPPORTED`, which names the schemes the side
takes ([0010](0010-a-request-presents-a-credential-of-a-scheme.md)).

**What does not read goes through one gate**: a request whose prefix reads, of the peer's parity, on
a call id neither open nor held, is answered with a failure on that call id; an answer of this
layout ends the call it answers, and a chunk the transfer it was for, while its payload is not
whole; anything else is reported, never answered, since an answer on any other call id could settle
someone else's call.

### Transfers

**A payload larger than an envelope goes as a transfer, in this same layout**, as HTTP/2 splits a
stream into frames rather than sending one frame of a 64-bit length. The request or the result that
opens it declares the payload's total, eight bytes behind the TRANSFER flag, and carries its first
bytes without credit. The receiver answers with a credit: the offset below which the sender may
send, absolute, the highest one received counting, so a credit repeated, late or out of order never
grants too much, as QUIC's `MAX_STREAM_DATA` does (RFC 9000 §4.1). The sender sends chunks, an
eight-byte offset each and the MORE flag on all but the last, full ones only, exactly, the last
reaching the total and full at most, which is the simplest form of TCP's rule against silly windows
(RFC 1122 §4.2.3.4). The receiver places them in any order, drops what it has, and refuses a chunk
before the last that is not exactly full, a last one past full, or one over bytes it holds in part,
so a peer cannot make it hold a byte in slivers, nor send a CHUNK whose envelope passes
`chunkBytes`; an opening, and a payload sent whole, it holds to `maximumEnvelopeBytes`. It grants a
window past what it holds from the start each time half of the last one is used. A refusal
(route, admission, size, capacity) falls on the opening, before any credit, so the bulk of a refused
payload never crosses. The requester ends a transfer with a cancel, the side that answers with a
failure; a call that received a transfer keeps its call id a while once it ends, so a late copy of a
chunk under the credit granted is dropped in silence. A notification, a failure, and the result of a
call that opens a subscription are never split: nothing arrives ahead of a result still coming, and
no end of a session cuts one.

### What a transport owes

**The transports carry bytes**, and one that carries transfers owes four things: it delimits its
messages; it knows the envelope's size at both ends, since nothing announces it; it delivers every
chunk and every credit, in any order, a copy tolerated, since Bead retransmits nothing and a loss
ends in the transfer's inactivity; and it carries both ways, the credit against the chunks. The
router copies what it reads, so a transport may use its buffers again. Whether a connection is alive
is the transport's to know, not Bead's, which has no ping: over WebSocket, each end sends the
protocol's own PING control frame at an interval and drops a connection that leaves one unanswered
(RFC 6455 §5.5.2), so a peer gone without a word ends in a close, as every loss does.

**A transport carries each envelope whole, and once.** Order is what its connection gives, a
WebSocket's and HTTP's outbox's, and not HTTP's exchanges, and the router needs none: a chunk and a
credit are placed by their offset and their absolute end, a copy of either is dropped, and a cancel
that overtakes its request is buried by the transport of the side that answers (below). A request's
copy the router cannot tell from a new request, so a transport hands each envelope on once, as
HTTP's outbox hears nothing twice, or its section states what a copy is
([spec 15.1](../../spec/spec.md)). A transport that keeps no connection draws one, as HTTP's does
([0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)).

### The cancel

**A requester gives up a call with a cancel**: 8 bytes, the prefix alone, on a call it still holds
open (unanswered, a subscription, a transfer it refuses), never on one it holds complete. A cancel
is never answered, and one that names no call is dropped in silence, having crossed its answer. The
other end forgets the call, takes away what it subscribed, then stops what still works on it, so
nothing more goes out on that call id. The requester reserves the call id as long as the call was
given, 5 seconds when it was given no time or waited without end, or, once a result came to it as a
transfer, as long as the other end keeps that call abandoned, should that be longer; it drops in
silence what comes late on it. This is HTTP/2's `RST_STREAM` narrowed to the requester, as a gRPC
client cancels: the side that answers ends a call with a failure, which carries a code, so a cancel
needs none; and since call ids come back, a cancel on an id that names no call is no error, where
`RST_STREAM` on an idle stream is one.

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

**A connection that closes is torn down in one order on every side**, application code last: what
it holds is released first, every transfer on it, the receiving ones before the sending ones so that
the budget they give back grants no credit to one about to go, then the calls it made, its session's
announcements, and the calls it answers, taken out; each call it answers then ends, counted
`closed`, none while another of the connection is held; then each call it made is rejected as
closed and counted so, and each call it answers has its signal aborted, so that a resolver finds its
signal aborted as it hears its own call's rejection. No standard orders the calls
a connection answers against the calls it made; what grpc-go's transport and Kestrel share is the
rule this keeps, state detached before application code runs, and application code off the
transport's thread. The spec states no order between them, which no peer observes (sections 9.10
and 12.10); the support matrix keeps when each side's resolvers hear their signal.

**A payload is bounded by the router's limits, not by the envelope**: 16,777,216 bytes by default,
and more when both ends are set so. One whose envelope would pass a chunk, 1 MiB, goes as a
transfer, which costs one round trip more than a whole envelope, its throughput bounded by the
window over the round trip: 4 MiB at 100 ms, some 40 MiB a second. A payload is whole in memory at
both ends, and what a router receives holds a budget of its own, 256 MiB by default, reserved as the
credit grants it: a transfer admitted may still stall should that budget not free. A payload of
several gigabytes needs a stream, a decision of its own.

**The why is here, the rule is in [`spec/spec.md`](../../spec/spec.md)**, sections 1 to 10, 12 and
15, and the bytes are in `spec/vectors.json`, which every implementation reads
([0004](0004-one-behaviour-in-every-language.md)).

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md))
in three rounds. A transport's order and copies met it with sections 15.1 and 15.9 of the spec,
which [0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md) points here for; the
wire's edges met it with sections 7.3, 9.5, 12 and 14.3, a round
[0010](0010-a-request-presents-a-credential-of-a-scheme.md) points here for; a closing connection's
teardown met it with sections 9.10 and 12.10, and with debugging 9.7 and an exit of
`spec/metrics.json`, which [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md) points
here for. A failure's detail for an error of the side's own met it in
[0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)'s round, on the answer leg A
cannot carry, which keeps its objections and answers. Their objections, each with the answer that
holds:

### On a transport's order and copies

| Objection                                                                                                                                                                                                            | Answer                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Its section states its order" unbinds the Web Worker and a router called in process, which have no section and are bound by "in order on each connection"                                                           | Accepted: order is the default on a connection, and a transport's section may lift it, stating what may overtake.                                                                                                                              |
| 15.1 says nothing of copies, which a router needs for a request                                                                                                                                                      | Accepted: a single copy is the default too, a section stating otherwise and what a copy is. Every transport Bead ships keeps it: neither HTTP client sends a `POST` again, and HTTP's outbox hears nothing twice.                              |
| Over HTTP, a failure that ends a subscription may come before its call's result, and both clients already decide alike, the call failing and the result reported `CALL_UNKNOWN`: the change should state the outcome | Accepted in part: 15.9 states that outcome, as HTTP's cost. Refused: a client that reserves the call id of a subscribing call a failure ends, which still fails the call and only silences the report, at the cost of both clients and a case. |
| "What its server does of it" narrows "the side that answers": a client answers commands                                                                                                                              | Accepted: the text says the side that receives it, the one that answers for a cancel that overtakes, the requester for a copy of an answer.                                                                                                    |

### At the wire's edges

A forwarded credential's turn, a credential that leaves a transfer no room, a chunk's bounds, a
resolver's failure answered, the cut of a failure's detail (section 7.3), and the order of an
opening's refusals (section 12.3.3). The user chose where it asked: a forwarded credential's turn
held by the twin tests alone, `PAYLOAD_TOO_LARGE` for a header that leaves a transfer no room, an
opening past `chunkBytes` taken, and the cut and the order in this round.

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.3's "a call presenting none that came behind one in the same turn is taken first", and a step that sends several messages to play it, make a scheduler's turn a guarantee and a shape of the files. No peer observes a turn: over a WebSocket the TypeScript side takes one read's frames in one turn and two reads' in two, the C# side posts each message as it reads it, and each player would have to build the turn by hand. 0010 decided "may be answered first", and 0004 holds the files to races whose outcome is the same in either order. The sentence also says the relay resolves what it resolves to no session. | Accepted: 14.3 says "in a later turn, as section 9.2 has a `JWT` and an `ELSEWHERE` resolve: a call presenting none that came after one may be taken first". The C# side posts the admission of a forwarded credential, as it posts an uncarried `ELSEWHERE`'s, and each side's twin test builds one turn by hand, as 9.2's own do. No conversation, and no change to the files' shape or their players; `docs/support.md` names the twin tests among what no entry plays.                                     |
| The changelog's lines for a forwarded credential's turn and a credential that leaves a transfer no room tell of fixes to what no release held, and one line mixes new rules with released ones                                                                                                                                                                                                                                                                                                                                                                                                                                    | Accepted: each goes into the entry that adds what it changes, the relay's and the opening's. A chunk's bounds split: the chunk before the last past full, which 12.6.1 refused already, is a fix; the last chunk's bound is a change. A resolver's failure answered stays a fix.                                                                                                                                                                                                                               |
| A last chunk full at most ends a tolerance unsaid: a sender whose `chunkBytes` is larger than its receiver's fails every transfer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Accepted: the changelog says so, and that both ends set `chunkBytes` alike (section 12.2); a smaller sender's chunks were refused already. The refusal's detail names both sizes, and a twin test of two cores whose `chunkBytes` differ, both ways, pins it.                                                                                                                                                                                                                                                  |
| 12.6.1's "so no CHUNK's envelope passes `chunkBytes`" reads as a bound the receiver keeps on every envelope, though an opening and a payload sent whole pass `chunkBytes` unrefused.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Accepted in part: the reason holds for a CHUNK, which a last chunk full at most delivers, and stays. 12.2 says what the receiver keeps for the rest, `maximumEnvelopeBytes` for an opening and a payload that came whole, as both sides do and a conversation plays; this record says it too. Refused: refusing an opening past `chunkBytes`, a new refusal, which the user declined.                                                                                                                          |
| `ENVELOPE_TOO_LARGE` is the wrong code for a header that leaves a transfer no room: no reader answers it to a header past 1,020 bytes, which byte 3 cannot express, so 0010's "the code its reader would answer" fails; 12.1's `PAYLOAD_TOO_LARGE` is the class; and a relay reports `ENVELOPE_TOO_LARGE` from leg B and answers `DESTINATION_UNREACHABLE`, where it passes `PAYLOAD_TOO_LARGE` on as its own.                                                                                                                                                                                                                    | Accepted: an opening with no byte is refused `CHUNK_INVALID`, so 0010's reason failed for its own case too. Both of 12.3's cases fail `PAYLOAD_TOO_LARGE`, counted once started, as the companion's 9.6 counts that code; a credential no header of its request holds is a programmer's error before the start, since it fails whatever the payload. 14.5's third row covers the relay, unreported, with no change to 14.3's sixth step: leg B fails before its transport has it. A relay's twin test pins it. |
| 7.3's cut, which steps back past the character the cut fell in, and 12.3.3's order, which its text does not state, are the same edges, and are left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Accepted: 12.3.3 states its order, and a conversation plays what none played; the cut steps back over one character at most, and two vectors of `failures` pin it.                                                                                                                                                                                                                                                                                                                                             |
| A resolver that throws before it returns is answered `PROCEDURE_FAILED` with no test that asserts it; the pair that registers one asserts the reports alone, and passes by timing on the TypeScript side.                                                                                                                                                                                                                                                                                                                                                                                                                         | Accepted: the pair asserts both answers, the throwing resolver's subscribing call among them, and the TypeScript one passes by order: the thrown call's answer goes out inside its delivery, before the send error is set. Both sides reach the same path.                                                                                                                                                                                                                                                     |

### On a closing connection's teardown

The order a connection's close ends its calls in, both sides first made to take the C# side's, its
calls answered aborted before its calls made are rejected. The dissent set that aside: each side
keeps its notices last, the detach closes every transfer, the C# side sets its tokens in the
teardown's turn by `CancelAsync`, and the twin tests,
`detach calls before settling an incoming resolver awaiting an outgoing call, and count its incoming close once`
and
`Detaches_calls_before_settling_an_incoming_resolver_awaiting_an_outgoing_call_and_counts_its_incoming_close_once`,
make the same assertions. The user chose that order, with `CancelAsync`.

| Objection                                                                                                                                                                                                                                                                                                                                                        | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done on the TypeScript side, aborting the calls a connection answers before rejecting the calls it made fails a resolver's own call, given its signal, as a cancel, `CancelError`, while it counts `closed`, and the C# side fails it `DisconnectException`: the first proposal makes the divergence it means to close, in a scenario its twin tests do not play | Accepted: the TypeScript side keeps its abort last; the twin tests take a variant whose outgoing call is given the incoming call's signal, which fails it closed on both sides, never as a cancel, and debugging 9.7 states it                                                                                                                                                                                                           |
| Each side's order serves its own signal: the TypeScript side's abort runs its listeners as it is aborted (the DOM's _signal abort_), the C# side's cancel is posted; the C# side moved alone to the TypeScript order lets leg B's rejection reach the relay before its cancel, which reports an answer into a disposed router                                    | Accepted: neither side moves its statement order alone; the C# side writes the TypeScript side's once its token is set in the teardown's turn, by `CancelAsync`                                                                                                                                                                                                                                                                          |
| On the thread pool, where resolvers run by default, the C# side's posted cancel races its call's rejection, and under load loses it every time: a resolver catches `DisconnectException` with its token not cancelled, a relay builds a failure answer, and a service manager tells a failed step for a call answered nothing                                    | Accepted, by the user's decision: the C# side cancels each incoming call's token by `CancelAsync`, which sets it within the teardown's turn and runs its callbacks after it, off the core's scheduler, the task it returns kept for the loop's idle wait, which the tests that await leg B's cancel wait on, unchanged. The matrix's row on when the resolvers hear their signal is a platform's, and no open row takes the race's place |
| The first proposal aligns a gauge read inside a test's clock and pays for it in what a resolver hears, where the detach can close the sending transfers with the receiving ones, as section 12.10 states and both cores' comments mean                                                                                                                           | Accepted: each side's sending transfers take a `closeAll` of a connection, called right after the receiving transfers', each with its own test; a later `stop` finds its transfer closed, and does nothing                                                                                                                                                                                                                               |
| No standard orders the calls a connection answers against the calls it made: grpc-go's server transport carries calls one way, HTTP/2's GOAWAY orders no completion, and Kestrel's posted cancel is the precedent for the C# side's post, not for its order                                                                                                      | Accepted: no standard is cited for that order; the record states the principle both sides keep, release, count, then settle and notify, application code last                                                                                                                                                                                                                                                                            |
| "Release, then settle" puts an abort under the release, though an abort is the core's state and the application's notice at once, and the TypeScript side's transfer closes in a listener of the signal                                                                                                                                                          | Accepted: the release is the detach and every transfer on the connection; an abort is a notice, and comes last                                                                                                                                                                                                                                                                                                                           |
| With two incoming calls, the C# side counts and aborts each in turn, the TypeScript side counts all, then aborts all: at the second call's count, one side has closed the first call's transfer and the other has not                                                                                                                                            | Accepted: the detach closes every transfer before any count, whatever the interleaving; the twin tests take a variant of two incoming calls, each answering as a transfer                                                                                                                                                                                                                                                                |
| The spec orders nothing between the two, and should not: a sentence ordering them binds the C# side to what it cannot keep at a resolver's level without its token set in the turn                                                                                                                                                                               | Accepted: no sentence on the order; debugging 9.7 states the property the first proposal would break, a call made on a connection that closes failing as closed even when given the signal of a call the close ends                                                                                                                                                                                                                      |
| Neither order counts an incoming call twice, both detaching first; the first proposal's risk is TypeScript listeners running while the calls a connection made are detached and unsettled                                                                                                                                                                        | Accepted: the twin tests keep their second close and its counts, and add the requester's                                                                                                                                                                                                                                                                                                                                                 |
| The C# test's marker, a task posted from inside the clock's read, has no TypeScript counterpart and nothing an application does at that instant                                                                                                                                                                                                                  | Accepted: on both sides, the marker gives way to what it stands for, a resolver finding its signal aborted as it catches its outgoing call's rejection                                                                                                                                                                                                                                                                                   |
| Conformance can carry neither the order nor the gauges, a counted step seeing both ends at once, but it can carry the outcomes and the count once, which no exit holds for a call and the command its resolver made                                                                                                                                              | Accepted: an exit of `spec/metrics.json`, a call awaiting its command as their connection closes, each counted `closed` once (debugging 9.4.18, 9.6.10); the order and the gauges stay with the twin tests                                                                                                                                                                                                                               |
