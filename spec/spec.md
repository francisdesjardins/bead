# Bead

What every implementation of Bead does, stated once. The key words MUST, MUST NOT, SHOULD and MAY
are to be read as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174), when in capitals.

Each section names the groups of [`vectors.json`](vectors.json) that check it. An implementation
conforms to the wire when it reads every vector as given, refuses each refusal with its code, and
writes every `headers` and `envelopes` vector back to its bytes. The why of each rule is in the
decisions: [0001](../docs/decisions/0001-the-envelope-sits-at-fixed-offsets.md) for the
envelope, [0002](../docs/decisions/0002-a-subscription-goes-at-its-clients-pace.md) for pacing.

**Version: 0.1.0**, of layout `0xA1`. Each conformance file repeats it as its `specVersion`, and
follows its schema in [`schemas/`](schemas/). **Status: every section is written.**

## 1. Conventions

1.1. Every integer is unsigned, in network byte order: its most significant byte first.

1.2. A 64-bit field — a chunk's offset, a credit's end, a transfer's total — MUST hold at most
2⁵³ − 1. A writer MUST NOT write more, and a reader MUST refuse more with `ENVELOPE_MALFORMED`: an
implementation whose numbers are IEEE 754 doubles then reads every value exactly.

1.3. An envelope carries no length of its own. Its transport delimits it, as WebSocket does a
message.

1.4. A duration an application gives a side, as an option or an argument — a call's timeout, a
limit, a session's or a transport's bound, a delay — is held as a whole number of milliseconds from
1 to 2³¹ − 1, as every platform's timers hold one alike, a fraction rounded to the nearest, a half
up. A side MUST refuse one that, as given, is under a millisecond or past 2³¹ − 1, a delay's 0
aside. A timeout or a bound is never 0, and may be without end but where its place says it may not;
one not given is its default. A delay takes 0 as at once.

## 2. The prefix

_Vectors: `prefixes`, `prefixRefusals`._

2.1. Every envelope starts with 8 bytes, which every layout keeps where they are: the layout
(byte 0), the kind (byte 1), the flags (byte 2), the header's length in 4-byte words (byte 3), and
the call id (bytes 4 to 7).

2.2. A message of fewer than 8 bytes, or whose first byte is outside 0xA1–0xAF, is not an envelope.
A reader MUST refuse it with `ENVELOPE_MALFORMED`.

2.3. This document describes layout 0xA1. 0xA2 to 0xAF are the layouts to come: a reader MUST refuse
one with `LAYOUT_UNSUPPORTED`, and SHOULD give the layouts it reads as the failure's detail —
`0xA1`.

2.4. A reader MUST read the prefix of a layout to come — its kind and its call id — since whether a
refusal is answered depends on them (section 9).

## 3. Kinds

_Vectors: `headers`, `reads`, `headerRefusals`._

3.1. The kinds of this layout, and the part of the header each has after the prefix:

| Kind           | Byte | Its own part                     | Header, without blocks |
| -------------- | ---- | -------------------------------- | ---------------------- |
| `REQUEST`      | 0x10 | service id u16, procedure id u16 | 12 bytes               |
| `RESULT`       | 0x11 | —                                | 8 bytes                |
| `FAILURE`      | 0x12 | —                                | 8 bytes                |
| `NOTIFICATION` | 0x13 | —                                | 8 bytes                |
| `CHUNK`        | 0x14 | offset u64                       | 16 bytes               |
| `CREDIT`       | 0x15 | credit end u64                   | 16 bytes               |
| `CANCEL`       | 0x16 | —                                | 8 bytes                |

3.2. 0x00 to 0x0F are never a kind: a reader MUST refuse them with `ENVELOPE_MALFORMED`.

3.3. 0x17 to 0x7F are the kinds to come: a reader MUST refuse them with `KIND_UNSUPPORTED`.

3.4. 0x80 to 0xFF are advisory: a reader MUST skip the envelope, whatever follows its kind, and MUST
NOT answer it.

3.5. A call id is never 0: a reader MUST refuse it with `ENVELOPE_MALFORMED`. A call id is odd when
a client opened the call and even when a server did, so the two sides never draw the same one. A
subscription's notifications carry the call id of the request that opened it.

## 4. Flags and blocks

_Vectors: `headers`, `reads`, `headerRefusals`._

4.1. The low nibble of the flags adds blocks, laid out after the kind's own part in the order of
their bits: `DESTINATION` 0x02 (4 bytes), `TRANSFER` 0x04 (8 bytes), then `CREDENTIAL` 0x08 (4 bytes
and its credential, to the next 4-byte word), the last block and the one whose length varies. 0x01
is kept for a block to come. The high nibble adds none: `SUBSCRIPTION` 0x10, `PACED` 0x20, `MORE`
0x40, and 0x80 is kept. A header's length follows from its kind, `flags & 0x0F`, and, with
`CREDENTIAL`, the length its block states.

4.2. Each kind takes these flags, and a reader MUST refuse any other with `ENVELOPE_MALFORMED`, kept
bits included:

| Kind           | Flags it takes                                                   |
| -------------- | ---------------------------------------------------------------- |
| `REQUEST`      | `DESTINATION`, `TRANSFER`, `CREDENTIAL`, `SUBSCRIPTION`, `PACED` |
| `RESULT`       | `TRANSFER`, `CREDENTIAL`                                         |
| `FAILURE`      | `CREDENTIAL`                                                     |
| `NOTIFICATION` | none                                                             |
| `CHUNK`        | `MORE`                                                           |
| `CREDIT`       | `PACED`                                                          |
| `CANCEL`       | none                                                             |

4.3. The header's length, byte 3 times 4, MUST be the prefix, the kind's own part and its blocks, to
the end of the `CREDENTIAL` block's padding, and MUST NOT run past the message: 1,020 bytes at most,
the 255 words byte 3 counts. A reader MUST refuse any other with `ENVELOPE_MALFORMED`, as it does a
header whose length does not hold the first 4 bytes of its `CREDENTIAL` block, which state that
block's length.

4.4. `CREDENTIAL`: a credential of a scheme, laid out as a TLS extension is
([RFC 8446 §4.2](https://www.rfc-editor.org/rfc/rfc8446#section-4.2)): its credential scheme on 2
bytes, its length on 2, the credential's bytes, then zero bytes to the next 4-byte word. A
credential scheme names a format, as HTTP's authentication scheme does
([RFC 9110 §11.1](https://www.rfc-editor.org/rfc/rfc9110#section-11.1)), so a side never reads the
bytes to learn what they are. A request presents a credential, and an answer announces its
connection's session (section 13.3):

| Scheme      | Name        | Its bytes                                   | Length                      | On a request | On a result or a failure              |
| ----------- | ----------- | ------------------------------------------- | --------------------------- | ------------ | ------------------------------------- |
| 0           | `NONE`      | none                                        | 0                           | malformed    | taken: its connection's session ended |
| 1           | `OPAQUE`    | a session's token (section 13.2)            | 16, never all zero          | taken        | taken                                 |
| 2           | `JWT`       | a token in JWS Compact Serialization        | 1 to what the header leaves | taken        | malformed                             |
| 3           | `ELSEWHERE` | none: its credential is not in the envelope | 0                           | taken        | malformed                             |
| 4 to 65,535 | to come     | a format to come's, read whole              | 0 to what the header leaves | taken        | malformed                             |

A `JWT`'s bytes are its token's characters, base64url and periods, as JWS Compact Serialization
writes them ([RFC 7515 §7.1](https://www.rfc-editor.org/rfc/rfc7515#section-7.1)). What the header
leaves a credential is its 1,020 bytes less all that comes before: 1,004 bytes on a request with no
other block, 992 on one with a destination and a total. A reader MUST refuse with
`ENVELOPE_MALFORMED` a scheme on a kind that does not take it, a length that is not its scheme's, an
`OPAQUE` of 16 zero bytes, padding that is not zero, and a block that runs past the header's length.

4.5. `DESTINATION`: what the request is for behind the peer that takes it, never 0. A reader MUST
refuse 0 with `ENVELOPE_MALFORMED`. An answer names its call alone, and carries none.

4.6. `TRANSFER`: the total of a payload sent in parts, which the envelope's own payload starts.
Section 12 states the rest.

4.7. A procedure id is never 0: a reader MUST refuse it with `ENVELOPE_MALFORMED`. A service id of 0
is read, and refused by routing as `SERVICE_UNKNOWN`.

4.8. `SUBSCRIPTION` says the request opens a subscription. `PACED` on a request asks for its
notifications at the client's pace, and MUST come with `SUBSCRIPTION`: a reader MUST refuse it alone
with `ENVELOPE_MALFORMED`. `PACED` on a credit says it counts notifications, not bytes.

4.9. `MORE` on a chunk says more chunks follow it; without it, the chunk is the last.

4.10. A writer MUST NOT write what a reader refuses: no call id, destination id, service id or
procedure id of 0, no flag a kind does not take, no credential of a scheme its kind does not take —
`NONE` on a request, any but `OPAQUE` and `NONE` on an answer — nor of a length not its scheme's, no
`OPAQUE` of 16 zero bytes, and no header past 1,020 bytes.

## 5. Reading an envelope

_Vectors: `headerRefusals`, `envelopeRefusals`, `reads`._

5.1. A reader MUST check an envelope in this order, and refuse it with the first check that fails:

1. 8 bytes at least, and a first byte from 0xA1 to 0xAF; else `ENVELOPE_MALFORMED`.
2. No more bytes than the reader takes; else `ENVELOPE_TOO_LARGE`.
3. Layout 0xA1; else `LAYOUT_UNSUPPORTED`.
4. A kind from 0x80: the envelope is skipped, and nothing after it is checked.
5. A kind from 0x10; else `ENVELOPE_MALFORMED`.
6. A kind of section 3.1; else `KIND_UNSUPPORTED`.
7. Everything else, the header's length among it, which its kind, its flags and its `CREDENTIAL`
   block's own length give; else `ENVELOPE_MALFORMED`.

5.2. Within step 7 the order is not observable, since every check refuses with the same code. The
failure's detail SHOULD say which check failed, and is informative.

## 6. What follows the header

_Vectors: `envelopes`, `envelopeRefusals`._

6.1. A request, a result and a notification carry their payload, which MAY be empty. With
`TRANSFER`, it is the transfer's first bytes.

6.2. A failure carries its record (section 7).

6.3. A chunk carries one byte at least: a reader MUST refuse it without one with
`ENVELOPE_MALFORMED`, and a writer MUST NOT write one.

6.4. A credit and a cancel carry nothing: a reader MUST refuse a byte after their header with
`ENVELOPE_MALFORMED`.

## 7. A failure's record

_Vectors: `failures`, `failureRefusals`, `envelopes`._

7.1. A failure's record is its code (u16), the relays it crossed (u8), its flags (u8), then its
detail, in UTF-8, to the end of the envelope.

7.2. A code is never 0. Flag 0x01 says the code is the procedure's own, an application failure;
without it, the code is the protocol's (section 8). A reader MUST refuse fewer than 4 bytes, a code
of 0, or any other flag, with `ENVELOPE_MALFORMED`.

7.3. A reader MUST cut the detail at `maximumDetailBytes` — 1,024 by default — back to the start of
the character the cut fell in. It MUST keep a leading U+FEFF as a character, and MUST read bytes
that are not UTF-8 as U+FFFD, as the WHATWG Encoding Standard decodes them, rather than refuse the
failure they explain.

7.4. A writer MUST cut the detail at `maximumDetailBytes`, and at `maximumEnvelopeBytes` less 32
bytes — its prefix, an announcement's block and its record — on a character's boundary, and write a
lone surrogate as U+FFFD.

7.5. A relay that passes a failure on writes one relay more than it received. The side that raised
a failure is deduced, never sent: a failure received with no relay is the peer's.

## 8. The protocol's codes

_Vectors: every refusal._

8.1. The protocol's codes come in blocks of 16, by how far a request went: the envelope (1 to 15),
its route (16 to 31), its admission (32 to 47), its payload (48 to 63), then its procedure (64 to
79). A code read that none of these names is kept as a number.

| Code | Name                       | Code | Name                     |
| ---- | -------------------------- | ---- | ------------------------ |
| 1    | `ENVELOPE_MALFORMED`       | 32   | `SESSION_REQUIRED`       |
| 2    | `LAYOUT_UNSUPPORTED`       | 33   | `ACCESS_DENIED`          |
| 3    | `KIND_UNSUPPORTED`         | 34   | `PAYLOAD_TOO_LARGE`      |
| 4    | `ENVELOPE_TOO_LARGE`       | 35   | `CAPACITY_EXCEEDED`      |
| 16   | `DESTINATION_UNKNOWN`      | 36   | `CREDENTIAL_UNSUPPORTED` |
| 17   | `DESTINATION_UNREACHABLE`  | 48   | `CHUNK_INVALID`          |
| 18   | `SERVICE_UNKNOWN`          | 49   | `CREDIT_EXCEEDED`        |
| 19   | `PROCEDURE_UNKNOWN`        | 50   | `PAYLOAD_UNDECODABLE`    |
| 20   | `CALL_UNKNOWN`             | 51   | `TRANSFER_STALLED`       |
| 21   | `SUBSCRIPTION_UNKNOWN`     | 64   | `PROCEDURE_FAILED`       |
| 22   | `SUBSCRIPTION_UNSUPPORTED` | 65   | `DESTINATION_LOST`       |

8.2. `CAPACITY_EXCEEDED` says that the receiver holds as much as a bound of its own lets it, and
takes no more: a notification past its subscription's queue (section 11.10), a transfer past those
its connection receives at once or past the budget left (section 12.3), a call past those that wait
for an issuer's keys (section 13.8). It says nothing against the call's credential, and withdraws
none (section 13.4).

## 9. Calls and answers

_Conversations: `spec/conversations.json`._

9.0. What a side _reports_ it tells its application — an error it raises, with the connection it
came on — and puts nothing on the wire. What it _answers_ goes back on the wire, as a failure on
the call id. What it _drops in silence_ it does neither.

9.1. A call is a request and its answer, under one call id on one connection. Either side opens
calls: a client its requests, a server its commands to a client. A requester draws its call ids in
its own parity (section 3.5), from the first again once past the last, and skips those it waits on,
those it reserved (section 10) and those it holds otherwise, a subscription's. What this section
says of a side receiving a request holds for a client receiving a command alike.

9.2. A side receiving a request of this layout MUST take these steps in this order, and stop at the
first that applies:

1. A call id of the receiver's own parity: the request would answer another call. It MUST NOT be
   answered, and is reported as `ENVELOPE_MALFORMED`.
2. A call id open already — a call still to be answered, or one held as a subscription: the same.
3. A destination the receiver has no handler for: answered with `DESTINATION_UNKNOWN`.
4. No resolver for its service: `SERVICE_UNKNOWN`; for its procedure in a service known:
   `PROCEDURE_UNKNOWN`.
5. Its credential, then its admission, in this order, which read its header, never its payload:
   1. a credential scheme the receiver takes none of — one to come, or one it has no verifier for:
      answered with `CREDENTIAL_UNSUPPORTED`, whose detail SHOULD name the schemes it takes, as a
      401 names its own in `WWW-Authenticate`
      ([RFC 9110 §11.6.1](https://www.rfc-editor.org/rfc/rfc9110#section-11.6.1)), so its requester
      presents another: their names, in the order of their numbers, a comma and a space between —
      `OPAQUE, JWT, ELSEWHERE` from a receiver that takes them all;
   2. its credential, resolved to the call's session (section 13.1): none, to its connection's
      session, or to none when the connection has none; `OPAQUE`, to its connection's session when
      the token is that session's, compared in constant time; `JWT`, to the session its claims carry
      once it verifies (section 13.8); `ELSEWHERE`, to the session the receiver's verifier makes of
      what its transport carried. A credential that does not resolve, or an `ELSEWHERE` whose
      transport carried nothing, is answered with `SESSION_REQUIRED`, whatever the procedure
      requires; its detail SHOULD say whether no credential came or one came and did not hold:
      `no credential came`, or `the credential does not hold`. A verifier that fails — it throws
      or rejects, its key set's ask fails, unreached or unsettled as its deadline is reached
      (section 13.8) — is answered with `PROCEDURE_FAILED`, and reported, never with
      `SESSION_REQUIRED`, which would have its requester withdraw a credential that holds
      (section 13.4). A `JWT` that would wait for its issuer's keys past the calls the receiver
      lets wait for them (section 13.8) is answered with `CAPACITY_EXCEEDED`, in the turn it would
      have waited, and not reported: nothing failed, and its requester withdraws nothing
      (section 8.2);
   3. its admission, synchronous, on the call's session: answered with the admission's failure —
      `SESSION_REQUIRED`, `ACCESS_DENIED`, or another of the admission's block; `PROCEDURE_FAILED`
      when the admission itself fails. An admission never answers `SESSION_REQUIRED` to a call that
      presented a credential: the receiver answers its `SESSION_REQUIRED` to such a call with
      `ACCESS_DENIED`, since the credential may hold and its requester would withdraw it.
      `SESSION_REQUIRED` stays for a credential that does not resolve, at the second step, and for
      a call that presented none, as an invalid token is answered 401 and a token short of its
      scope 403 ([RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750#section-3.1)).
6. A subscription opened on a connection that carries nothing back: `SUBSCRIPTION_UNSUPPORTED`.
7. A payload, or the total a transfer declares, past the procedure's limit or the receiver's:
   `PAYLOAD_TOO_LARGE`. A transfer the receiver takes none of: the same.
8. Otherwise the request is dispatched to its resolver once its payload is whole, with its call's
   session.

A credential's resolution MAY wait — a `JWT` verified by Web Crypto, a key set asked for a key, a
service asked whether a token holds — and the admission after it does not. A request presenting
none or `OPAQUE` resolves in the turn it came; one presenting `JWT` or `ELSEWHERE`, in a later turn,
whether its verifier waits or not. While it resolves, its call id is open (step 2); a cancel ends
it, answered by nothing (section 10.2), as its connection closing does (section 9.10), each telling
its verifier; a transfer's opening gets no credit (section 12.3); and the call runs in the session
it resolved to, whatever befell its connection's meanwhile. A resolution that settles once its call
ended opens no session, moves no session's end, and is dropped.

9.3. An answer — a result or a failure — names its call by its call id alone: never its procedure,
never a destination. A call is answered once.

9.4. An answer MUST go out only while its call is open. Once its requester cancelled it, once its
connection closed, or once a new request opened its call id again, the answer MUST NOT go out: it
would settle a call it does not belong to.

9.5. A resolver that fails before it answers MUST still answer, with `PROCEDURE_FAILED`, so its
requester does not wait out its timeout. A payload its procedure cannot read is answered with
`PAYLOAD_UNDECODABLE`, before the resolver sees it. A procedure's own failure is an application
failure, with a code from 1 to 65,535 of the procedure's own numbering.

9.6. What does not read goes through one gate. A side MUST:

1. report a message whose prefix does not read, and answer nothing;
2. answer a request whose prefix reads, of the peer's parity, on a call id neither open nor held,
   with the failure that refused it, on that call id: a layout to come with `LAYOUT_UNSUPPORTED`, a
   request too large with `ENVELOPE_TOO_LARGE`, any other with `ENVELOPE_MALFORMED`;
3. end the call an answer of this layout is for, when that call waits, with the failure that refused
   the answer, and cancel it (section 10);
4. end the transfer a chunk of this layout is for, while its payload is not whole, with
   `CHUNK_INVALID`;
5. drop in silence an answer or a chunk of this layout on a call id it reserved, or a chunk on a
   call it abandoned;
6. report anything else, and answer nothing.

9.7. A result or a failure received is paired with the call waiting on its call id. With no call
waiting, a failure MAY end a subscription (section 11); on a call id reserved, it is late, and
dropped in silence; otherwise it is reported as `CALL_UNKNOWN`. A result that comes once a result
in a transfer answered the call is reported as `ENVELOPE_MALFORMED`.

9.8. A side that takes no notification reports one as `KIND_UNSUPPORTED`. A side that sends no
notification reports a credit that counts notifications the same way; a side that sends them drops
one for a subscription it does not hold in silence, since it crossed that subscription's end. A
credit of bytes for no transfer the side sends is dropped in silence too.

9.9. A requester waits for its answer as long as its call was given: 5 s by default, a duration
section 1.4 allows, or without end. While a payload or its result goes as a transfer, the transfer's
inactivity counts instead. Past it, the call ends, and is cancelled.

9.10. A connection that closes ends every call on it: each call waiting fails, and each call to
answer is ended as cancelled — its resolver told, or, while its credential resolves (section 9.2),
its verifier, by the call's signal — and answered by nothing. What a verifier settles to then is
dropped in silence (section 10.2).

## 10. Cancel and reservation

_Conversations: `spec/conversations.json`._

10.1. A requester that ends a call it opened before its answer came whole — its timeout passed, its
caller cancelled it, its answer unreadable, a transfer refused, a subscription it no longer wants —
MUST send a cancel on that call id, unless the transport never had its request. A cancel is the
prefix alone, and is never answered.

10.2. A side receiving a cancel on a call id of its own parity MUST report it as
`ENVELOPE_MALFORMED`. Otherwise it forgets the call, takes away what the call subscribed, then
tells the resolver, so nothing more goes out on that call id. A call whose credential still
resolves (section 9.2) ends alike, at once: its verifier is told by the call's signal, its call id
is free again for a request that opens a new call, and whatever its verifier settles to after — a
session, none, or a failure of its own — is dropped in silence: it opens no session, answers
nothing, and reports nothing. A cancel for no call has crossed its answer, and is dropped in
silence.

10.3. A requester MUST reserve a call id in three cases: when it sends a cancel on it; when the last
chunk of a result that came as a transfer completes it; and when a failure ends a call whose result
was coming as a transfer. The reservation lasts as long as the call was given, 5 s when it was given
no time or waited without end; once a result came in part as a transfer, at least as long as the
transfer's inactivity, while the other end keeps the call abandoned. A call id reserved twice is
reserved until the later end. A requester's draws skip a call id reserved, and an answer, a chunk or
a notification on one is dropped in silence.

10.4. The reservation is made in the same step as the cancel is sent, so no call drawn meanwhile
takes the call id; and before the caller hears that its call ended, so a call made again in its
place goes out behind the cancel.

## 11. Subscriptions and pacing

_Conversations: `spec/conversations.json`._

11.1. A subscription is the call of a request that opens one — SUBSCRIPTION set — left open once
answered. Its notifications travel on that call id, from the server to the client, and are never
answered.

11.2. A server subscribes the requester of a request that opens a subscription, to a procedure that
notifies, when it answers it successfully; its resolver MAY subscribe it before it answers. A
request that does not open one subscribes nothing, whatever its procedure; one that opens one to a
procedure that notifies nothing is answered, and subscribes nothing. A failure subscribes nothing,
and takes away what the call subscribed before it.

11.3. A connection holds one subscription per procedure and per session, its calls'
(section 13.1), and the first call of a session to take it keeps it: notifications travel on that
call's id, and that session bounds it (section 13.6). A connection's session and a call presenting
none count as one session for this, the connection's, so a connection whose calls present no
credential holds one subscription per procedure; calls whose credentials resolve to one identifier
are of one credential's session, whatever token each presented (section 13.9). A later request of
the same session that opens a subscription to the same procedure is answered, and holds nothing;
one of another session takes one of its own. Should the later request be answered while the first
call is still unanswered, it waits: if the first call then fails, is cancelled, or its answer does
not go out, the waiting call holds the subscription in its place, while its connection is open.

11.4. A server MAY send a notification before the answer of the call it travels on: a client binds
its subscription to the call id as it draws it, before the request goes out.

11.5. A call id a subscription holds is in use: a server MUST refuse a request on it (section 9.2,
step 2), and a client MUST NOT draw it.

11.6. A subscription's result goes in one envelope: one that would need a transfer is
`PAYLOAD_TOO_LARGE`.

11.7. A subscription ends:

1. by a cancel on its call id, from the client, which the server answers by nothing, and after
   which it sends nothing more on that call id;
2. by a failure on its call id, from the server — its queue past its bounds, its session ended —
   after which the server sends nothing more on it, and the client reserves the call id
   (section 10.3);
3. with its connection, at both ends.

A client receiving a notification under no subscription reports it as `SUBSCRIPTION_UNKNOWN`; on a
call id it reserved, it drops it in silence.

11.8. A request that opens a subscription MAY ask for it paced, with PACED. The server then sends a
notification only while the count it sent on the subscription is below the count its client
credited. The request credits the first. Each CREDIT with PACED on the subscription's call id
carries the count the client credits so far: absolute, never taken back, the highest standing — a
lower one grants nothing.

11.9. Past its credit, a notification waits in its subscription's queue. The code that notifies MAY
give it a key, which never travels: one of the same key replaces the one waiting, in its place in
the queue; one with none is added last. A credit lets the queue go, in its order, as far as it
reaches.

11.10. A server bounds each queue — 64 notifications and 1 MiB by default; an implementation MAY set
others. A notification that takes a queue past its bounds ends its subscription with
`CAPACITY_EXCEEDED`: a failure on its call id once the subscription was answered; the answer of the
request itself while it is still unanswered.

11.11. A client SHOULD credit a notification once the callbacks of the one before it have settled.
With a window of _w_, it SHOULD credit as far as _w_ past the notifications settled, once that is
_w_ / 2 past its last credit, as a transfer's credit is renewed; the window opens once the answer
came.

## 12. Transfers

_Conversations: `spec/conversations.json`._

12.1. A payload whose envelope would pass `chunkBytes` goes as a transfer: a request's, or a
result's, whose header is counted with the 20 bytes of an announcement, whether it carries one or
not. A notification, a failure, and the result of a request that opens a subscription (section 11.6)
always go in one envelope. A side that sends no transfer fails a request whose payload would need
one with `PAYLOAD_TOO_LARGE`, before anything goes out, and answers such a result with
`PROCEDURE_FAILED`, reporting `PAYLOAD_TOO_LARGE`.

12.2. Both ends of a connection set their limits alike: nothing announces them.

| Limit                       | By default  | Bounds                                                                       |
| --------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `maximumEnvelopeBytes`      | 16,778,240  | an envelope, as it comes in and as it goes out                               |
| `chunkBytes`                | 1,048,576   | a chunk's envelope, and the largest a payload goes whole in                  |
| `windowBytes`               | 4,194,304   | how far past what it received from the start a receiver lets its sender send |
| `maximumPayloadBytes`       | 16,777,216  | a payload, whole or as a transfer; a procedure's own limit narrows it        |
| `bufferedBytesBudget`       | 268,435,456 | the bytes every transfer a side receives holds together                      |
| `maximumTransfers`          | 4           | the transfers a connection receives at once; 0 takes none, and sends none    |
| `maximumChunkRuns`          | 1,024       | the runs of bytes apart a transfer received holds before it is whole         |
| `transferInactivityTimeout` | 30 s        | how long a transfer waits for its next chunk or credit                       |
| `maximumDetailBytes`        | 1,024       | a failure's detail                                                           |

They MUST hold together: an envelope of 64 bytes at least; a chunk from 64 bytes to an envelope; a
window of two chunks at least, so a sender never waits for a credit it is owed; a payload within the
budget; a timeout section 1.4 allows, never without end, so a transfer's call id comes free. A side
that takes or presents a `JWT` — given its keys, or one to present by default — sets `chunkBytes`
and `maximumEnvelopeBytes` to 1,024 bytes at least besides, which a header of 1,020 bytes
(section 4.3) and the byte of payload an opening carries (section 12.3) need: its limits hold
together only so.

12.3. The opening is the request or the result itself, with the TRANSFER block: the payload's total
on 8 bytes, and its first bytes, one at least, as many as fill the envelope to `chunkBytes`, sent
without credit. A requester whose header leaves its opening no byte within `chunkBytes` fails its
call before it goes, with `ENVELOPE_TOO_LARGE`. A side receiving an opening:

1. of a request, takes the steps of section 9.2 on it — its credential's resolution, its admission
   and the total it declares held to the procedure's limit included — before any credit goes: none
   goes until its resolution and its admission settle, a refusal answers the opening, and no chunk
   follows;
2. of a result, ends the call with `PAYLOAD_TOO_LARGE`, and cancels it, for a total past the
   call's limit;
3. refuses a total of 0, and a total past what it takes, with `PAYLOAD_TOO_LARGE`; an opening that
   carries no byte of its payload, or holds its whole total, which needed no transfer, with
   `CHUNK_INVALID`; an opening past the transfers its connection receives at once, or past the
   budget left, with `CAPACITY_EXCEEDED`.

12.4. A CREDIT without PACED, on the call id of a transfer, carries the end below which its sender
may send: absolute, so a credit repeated, late or out of order never grants too much. A credit
lower than one received grants nothing. The receiver grants as far as `windowBytes` past the bytes
it holds from the start, once that is half a window past its last credit — or reaches the total,
when less is left — and never past the budget left. A transfer the budget cannot credit waits until
the budget frees, the transfers opened first credited first.

12.5. A CHUNK carries its offset on 8 bytes, and MORE on all but the last. A sender MUST send full
chunks only — `chunkBytes` less the chunk's own 16 bytes of header — and the last, which reaches the
total; it waits for credit when a full one does not fit under it.

12.6. A side receiving a chunk of a transfer places it in any order, checked in this order:

1. its bytes within the total, one at least; MORE clear when it reaches the total, and only then;
   full when it does not: otherwise `CHUNK_INVALID`;
2. its bytes within the credit: otherwise `CREDIT_EXCEEDED`;
3. its bytes received already, whole: dropped in silence;
4. its bytes clear of every byte received, so each byte is held once, in whole chunks: otherwise
   `CHUNK_INVALID`;
5. the runs of bytes apart it leaves, `maximumChunkRuns` at most: otherwise `CHUNK_INVALID`.

Once every byte came, the payload goes on whole: a request's to its resolver, a result's to its
caller.

12.7. A transfer ends, before its payload is whole, by its requester with a cancel (section 10),
and by the side that answers with a failure on its call id:

- a chunk refused (section 12.6): the side receiving a request's payload answers with that failure;
  the requester receiving a result's ends the call with it, and cancels it;
- `TRANSFER_STALLED`: the side receiving a request's payload, or sending a result's, answers with
  it once nothing came — no chunk, no credit — for `transferInactivityTimeout`; the requester ends
  its call as timed out after as long, and cancels it.

12.8. While a payload or its result goes as a transfer, the transfer's inactivity governs the call:
each chunk placed and each credit that grants sets it going again. The call's own timeout counts
the wait for its answer, afresh once the last chunk of its request went.

12.9. A call that received a transfer keeps its call id a while once it ends. The side that answered
holds it abandoned for `transferInactivityTimeout`, `maximumTransfers` per connection at most, the
oldest giving way; the requester reserves it (section 10.3). What comes late is dropped in silence
where it is known for late, and reported elsewhere:

| Late           | On a call id reserved | On a call abandoned                                 | On none                                                           |
| -------------- | --------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `RESULT`       | dropped               | —                                                   | `CALL_UNKNOWN`                                                    |
| `FAILURE`      | dropped               | —                                                   | ending a subscription, taken; `CALL_UNKNOWN` otherwise            |
| `NOTIFICATION` | dropped               | —                                                   | `SUBSCRIPTION_UNKNOWN`                                            |
| `CHUNK`        | dropped               | dropped under its credit, `CREDIT_EXCEEDED` past it | `CALL_UNKNOWN`; `ENVELOPE_MALFORMED` on a call open without one   |
| `CREDIT`       | dropped               | dropped                                             | dropped: it may have crossed its transfer's or subscription's end |
| `CANCEL`       | —                     | dropped                                             | dropped: it may have crossed its answer                           |

12.10. A connection that closes ends every transfer on it, at both ends; what they held of the
budget goes to the transfers it starved.

12.11. A transfer of 20 MiB, with the limits by default:

```text
A1 10 04 05  00 00 00 07  00 02 00 05  00 00 00 00 01 40 00 00 | <1,048,556 bytes>
   REQUEST, TRANSFER: a total of 20,971,520, its opening sent without credit
A1 15 00 04  00 00 00 07  00 00 00 00 00 4F FF EC
   CREDIT up to 5,242,860: what came, and a window of 4 MiB
A1 14 40 04  00 00 00 07  00 00 00 00 00 0F FF EC | <1,048,560 bytes>
   CHUNK, MORE, from 1,048,556
A1 14 00 04  00 00 00 07  00 00 00 00 01 3F FE BC | <324 bytes>
   the last CHUNK, from 20,971,196
```

## 13. Sessions

_Conversations: `spec/conversations.json`._

13.1. A session is what a call runs in, and comes in two kinds. A _connection's session_ belongs to
a server's connection: a request opens one — a procedure that checks credentials, say — and the
server keeps it with what it needs: its token, its data, and its timeouts, and announces it
(section 13.3). A _credential's session_ is what a verifier makes of a credential a request
presents, `JWT` or `ELSEWHERE`: its identifier, its data and its end, never announced. A call runs
in the session its credential resolves to (section 9.2, step 5), its _call's session_: a call
presenting none, in its connection's session, in none when the connection has none; one presenting
`OPAQUE`, in its connection's session, whose token it carries; one presenting `JWT` or `ELSEWHERE`,
in a credential's, with its own credential's data. Its admission reads that session, and its
resolver receives it.

13.2. A connection's session's token is 16 bytes, drawn from a cryptographic source, never all
zero, and held by no other connection.

13.3. A server announces a connection's session on the next answer — a result or a failure — that
goes out after it changed, in its `CREDENTIAL` block: `OPAQUE`, its token, once it opened or was
drawn anew; `NONE` once it ended. An answer announces no other scheme, and one that announces
nothing carries no `CREDENTIAL` block. An answer that did not go out announced nothing.

13.4. A client learns its connection's session from the answers, and presents it, `OPAQUE`, only
on a call that asks for it, never by default: that call is bound to the session the client knows,
so a call made in a session that ended, or that was opened anew under a new token, is refused
rather than run in whatever session the connection holds. A client MAY be given a credential to
present by default: a `JWT`, or an `ELSEWHERE` with what its transport carries beside each request
(section 15.1). Every call presents it but one that gives its own, or none: a call may present
none, whatever the default. A default is withdrawn once a call that presented it is refused
`SESSION_REQUIRED`, whatever relays the refusal crossed: the client presents none by default from
then on, and tells its application, by the credential's scheme alone, so the call that renews it
goes out without it. A refusal withdraws the default only while it is still the credential its call
presented, the same scheme and the same bytes: a default given other bytes since is kept, and one
set again to the same bytes is withdrawn with it; and a failure that ends a subscription once answered (section 13.6) withdraws
nothing, since a session the application ended leaves a credential that may still hold. A client
receiving a command resolves its credential as a server does (section 9.2, step 5), the session it
learned standing for its connection's.

A client fails a call before it goes, and a server a command alike, with
`DESTINATION_UNREACHABLE`, as a relay refuses a call its leg B cannot carry (section 14.3): nothing
was tried, and its credential stays. It does so for a call that presents `ELSEWHERE` over a
transport that carries no credential beside an envelope — a WebSocket, a Web Worker, a server's
over HTTP (sections 15.2, 15.9) — and for one that presents a `JWT` or an `ELSEWHERE` over a
transport that leaves the machine in the clear, since a bearer credential crosses only TLS off the
machine ([RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750#section-5.3)). A transport is
judged by what it is given, never by what a name resolves to. It is secure under TLS, its scheme
`wss` or `https`; on the loopback, its host — the one a client names in its URL, or the one a
server listens on — `localhost` or a name that ends in `.localhost`, compared in ASCII lower case,
an IPv4 address in 127.0.0.0/8, or `::1`, as the W3C's
[Secure Contexts](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy) judges an origin
potentially trustworthy; or when it never leaves the machine, a Web Worker or a router called in
process. Any other leaves the machine in the clear. A server cannot tell what stands in front of it:
its application MAY say so, and is then believed whatever the server listens on — TLS terminated
before it, which makes it secure, or a proxy that serves the network in the clear, which leaves it
in the clear.

13.5. A credential that does not hold is refused at its resolution, whatever the procedure
requires (section 9.2, step 5): a call never runs outside the session it presented. A procedure
that requires a session tests the call's session, never the connection's: it refuses a call in none
that presented no credential with `SESSION_REQUIRED`, and one that presented a credential it does
not run in — a `JWT` or an `ELSEWHERE` a relay forwards without verifying (section 14.3) — with
`ACCESS_DENIED`, since `SESSION_REQUIRED` would have its requester withdraw a credential that may
hold (section 9.2, step 5). A call that presented a `JWT` is not in its connection's session,
whatever that session holds. `ACCESS_DENIED` says that the call is not allowed as it came: a
session holds and is not allowed, or a credential came that the admission does not take. A
procedure that ends its connection's session ends it before it answers, so its own answer — or the
failure of section 13.6, should one go out first — announces the end.

13.6. A session that ends ends the subscriptions it bounds (section 11.3): a connection's session,
those of its connection that no credential's session bounds; a credential's session, those its
calls hold on each connection that keeps it, at its end, or by its identifier or its issuer
(section 13.9). Each is answered with a failure on its call id, `SESSION_REQUIRED`; a call still
unanswered is left to its own answer. The connection stays, to open another session.

13.7. A connection's session has two inactivity timeouts: past its session timeout, the session
ends, and the connection stays; past its connection timeout, the connection is closed, and takes its
session. A credential's session has none: no message, listen or silence moves its end, and it ends
at its end, once the application ends it, or with its connection. A connection without a
connection's session — none yet, or its session ended, whatever credentials its calls present — is
closed once silent past the server's own connection timeout, when it has one, counted from its
session's end for one that had one. Each of these timeouts may be without end, and is when not
given. A message of its connection starts every one anew, whatever session its call runs in; a
session timeout counts messages alone. Over HTTP, a listen held is not silence: while one is held,
no connection timeout runs, and silence counts anew from its end (section 15.9). Over WebSocket, a
peer that only hears is silent: it speaks now and then, or is given a connection timeout without
end. A connection that closes takes its sessions; a session opened for a connection already closed
ends at once.

13.8. A side verifies a `JWT` one way, as an access token of RFC 9068's profile in JWS Compact
Serialization (RFC 7515), as RFC 8725 recommends. The application gives its keys, each a JWK
(RFC 7517) with its issuer and its one algorithm, `ES256` or `HS256` (RFC 8725 §3.1), and its
audience; a relay that verifies holds a token it forwards to the set of its destinations' audiences
instead (section 14.3). Keys or a key set given without an audience are the application's fault,
refused as the side is built, whatever its relay does: a request to the side itself, naming no
destination, would hold its token to no audience, and refuse it. The side reads the wall clock,
_W_, a whole number of milliseconds since the epoch, once, as the token's signature has verified
(step 7), so a verification that waits is judged as it ends. It takes these steps in this order, and
the first that fails refuses the token for the reason it names:

1. `token`: the token is three parts apart by a period, each base64url without padding (RFC 4648
   §5) whose bits past its last byte are zero, and its header and its claims set are each a JSON
   object (RFC 8259) in UTF-8, without a byte order mark, naming each member once, by a name of
   well-formed Unicode;
2. `crit`: its header carries no `crit`. Its `jwk`, `jku`, `x5u` and `x5c` are never read
   (RFC 8725 §3.10): a token names no key of its own;
3. `typ`: its header's `typ` is `at+jwt` or `application/at+jwt`, as RFC 9068 §4 writes them, so a
   token of another kind from the same issuer, an ID token among them, is refused (RFC 8725 §3.12);
4. `kid`: its key is found among the keys alone: by its header's `kid`, the key of that `kid`, or,
   of several, the one whose issuer is its `iss`; without a `kid`, its `iss`'s key, when that issuer
   has one key. A `kid` that names none is refused, never tried against the others;
5. `alg`: its header's `alg` is its key's algorithm, so `none`, an algorithm no key takes, and an
   `HS256` token met by a public key are refused;
6. `key`: its key's JWK serves: its `alg`, when present, is its algorithm, its `use`, when present,
   is `sig`, and its `key_ops`, when present, include `verify` (RFC 7517 §4.2 to §4.4);
7. `signature`: its signature verifies over its first two parts as they came: an `ES256` one is 64
   bytes, _R_ then _S_ (RFC 7518 §3.4), never DER; an `HS256` one is 32 bytes, compared in constant
   time;
8. `iss`: its `iss` is its key's issuer, octet for octet (RFC 8725 §3.8);
9. `exp`: its `exp` is a JSON number, _X_ = ⌈`exp` × 1000⌉ and _X_ + 60,000 are each from
   −(2⁵³ − 1) to 2⁵³ − 1 (section 1.2), and _W_ < _X_ + 60,000 (RFC 7519 §4.1.4);
10. `nbf`: its `nbf`, when present, is a JSON number, _N_ = ⌈`nbf` × 1000⌉ is from −(2⁵³ − 1) to
    2⁵³ − 1, and _W_ ≥ _N_ − 60,000 (RFC 7519 §4.1.5);
11. `aud`: its `aud` is a string, or an array of strings, that names the audience, or one of the
    set (RFC 7519 §4.1.3);
12. `sid`: its `sid`, when present, is a string;
13. `sub`: without a `sid`, its `sub` is a string.

A string these steps read is of well-formed Unicode, which a JSON escape need not write: one that
holds a surrogate alone names nothing. A claim is read as an IEEE 754 double, as both sides' JSON
readers read it, and the 60 s is a leeway for clock skew, a constant on every side, never an option.
A token that holds gives its session: its identifier, `{ issuer, sid }`, its `iss` with its `sid`,
else `{ issuer, sub }`, its `iss` with its `sub`; its claims set; and its end, _E_ = _X_ + 60,000.
A key not shaped for its algorithm — an `ES256` one that is not `EC` on `P-256`, its `x` and `y` 32
bytes each, an `HS256` one that is not `oct`, its `k` 32 bytes at least (RFC 7518 §3.2) — is the
application's fault, never the token's: the verifier fails, and refuses nothing.

A side may be given a key set besides its keys, with the issuers it answers for, one at least, and
the most calls that wait for one issuer's keys at once, `maximumWaitingCalls`, _N_: a whole number
from 1 to 2³¹ − 1, 64 when not given. A key set given with no issuer, or with an _N_ outside those
bounds, is the application's fault, refused as the side is built. Asked for one of its issuers, with
a signal, it answers that issuer's keys (RFC 7517 §5), each a JWK with its one algorithm, and may
wait. The side asks it for no other issuer, compared octet for octet: a token whose `iss` it does
not name is judged at once by the keys there are, asking nothing, so no peer has it asked for an
issuer of the peer's choosing. The side asks it once a minute at most for an issuer: an ask sets
that issuer's deadline a minute past the reading at which it goes, on the side's monotonic reading
(decision 0011), and its signal aborts as that deadline is reached. A deadline is reached once that
reading is at it or past it, wherever the side reads that issuer's state — as a call of that issuer
comes, as an answer comes, as the deadline's timer fires — whichever is first, and never as a call
leaves its wait, which reads nothing of it: the timer, which may fire late, only makes sure it is
reached when nothing else reads it. An ask that fails — the key set throws or rejects, answers what
is not keys shaped for their algorithms, or is unsettled as its deadline is reached, what it settles
to at or past that deadline being dropped — fails the verifier of every call that waits on it
(section 9.2, step 5), as a key set that cannot be reached does.

The keys an answer gave are held for its issuer, beside the application's, in place of those its
last answer gave, ten minutes from that answer on the monotonic reading: they serve while that
reading is before the answer's plus 600,000 ms, and an ask that fails replaces none of them. The
application's own keys are held for good. Step 4 finds a key among the application's keys and the
held keys that serve.

A token the keys that serve verify waits for nothing. One of an issuer the key set names, which they
do not verify, waits for that issuer's keys while its key does not serve: while its `kid` names none
of its issuer's keys that serve, whatever another issuer's key names, as a verifier asks again for a
`kid` it does not know (OpenID Connect Core 1.0 §10.1.1); or, without a `kid`, while none of its
issuer's keys serve — none given, none answered yet, or all past their ten minutes — as a `kid` that
names none waits, so a side that starts asks for them. It waits on its issuer's ask under way, when
one is; otherwise, before that issuer's deadline, for the deadline and the ask that goes then,
shared by every call that waits — at a deadline no call waits for, none goes; otherwise, on an ask
that goes at once. A call that comes at or past its issuer's deadline on the reading, before the
deadline's timer fired, reaches the deadline as it comes: an ask still unsettled has failed then,
and the ask the deadline lets go goes then, for the calls that waited for it and for the call that
comes, when it waits. An ask went after a token came unless the token found it under way: the ask a
token sets off as it comes — at once, or at a deadline its coming reaches — and the ask that goes at
a deadline it waited for each went after it came. As an ask answers, each call that waits on it is
judged again: one whose key now serves, or whose ask went after its token came, is verified against
the keys that serve, so a `kid` that answer did not name is refused then, at step 4 or past it; any
other waits on, for the deadline and the ask then, since an ask that went before its token came may
not know its key.

At most _N_ calls wait for one issuer's keys at once, on its ask under way and for its deadline
counted together, each issuer's apart. A call that would wait past them is refused
`CAPACITY_EXCEEDED`, in the turn it would have waited, and not reported (section 9.2, step 5): a
peer that sends tokens whose `kid` no key names holds no more than _N_ calls, and what they carry,
through an issuer's minute. A call keeps its place while it waits, from an ask to the deadline after
it and onto the ask then, and one that leaves frees it. A call's own signal — its cancel, which its
requester's timeout sends as well (section 9.9), or its connection closing (section 9.10) — ends its
own wait, never the ask. The side fetches nothing itself: the key set is the application's to fetch.

_Vectors: `jwtVerdicts`._

13.9. A credential's session ends at its end, on a timer that reads the wall clock again at each
step, on the clock its side runs on (decision 0011):

1. its end, _E_, is a whole number of milliseconds since the epoch: for a `JWT`, _X_ + 60,000, _X_
   its `exp` in milliseconds rounded up (section 13.8, RFC 7519 §4.1.4), since a skew moves an end
   as much as a start; for an `ELSEWHERE`, the end its verifier gives, rounded up to a
   millisecond, or none, for a session no timer ends;
2. the wall clock's reading, _W_, is a whole number of milliseconds since the epoch, a fraction
   dropped, so no fraction reaches a timer;
3. as its session comes to be kept, by a reading of its own apart from the one its verdict took, as
   a renewal moves _E_, and at its timer's due, the side reads _W_ again, never counting down, and
   takes _R_ = _E_ − _W_: at _R_ ≤ 0 the session ends in a turn of its own, past the answer that kept
   it, with no timer armed; otherwise it arms a timer of min(_R_, 2³¹ − 1) ms in place of the one
   before, so an end is never refused for its distance, and a wall clock set by hand takes effect at
   the next due;
4. an `ELSEWHERE` whose end _W_ has reached when its verification settles does not hold:
   `SESSION_REQUIRED` (section 13.10).

A side keeps a credential's session, per connection and identifier, only while it bounds a
subscription (section 11.3): its end, the later of those its calls resolved to, and the
subscriptions it bounds. Two identifiers are one when their credential scheme, their claim's name
and their values are equal, octet for octet — a `JWT`'s `{ issuer, sid }` or `{ issuer, sub }`, an
`ELSEWHERE`'s verifier's `id` — so one `sub` under two issuers names two sessions. A call whose
credential resolves to the identifier of a session its connection keeps moves that end to the later
of the two, in whatever order resolutions settle, and runs with it: a credential renewed keeps its
subscriptions. One that resolves to a session not kept runs with its own end, and keeps it once it
subscribes. The application ends a credential's session by its identifier: that session ends on
every connection that keeps it, and the subscriptions it bounds with it, and nothing else. It ends
every credential's session of an issuer alike, by that issuer, as when a key of that issuer's leaks:
each `JWT`'s session whose identifier's issuer it is, octet for octet, whatever its `sid` or `sub`,
on every connection that keeps one, and the subscriptions they bound with them, and nothing else —
an `ELSEWHERE`'s identifier names no issuer. Ending a session refuses no credential, so a credential
that still holds opens it anew — a call that resolved to it before it ended, and subscribes as it is
answered after, among them (section 13.6), and a token a leaked key signed, while that key serves
(section 13.8). A session that ends — at its end, by its identifier or its issuer, or with its
connection — ends the subscriptions it bounds (section 13.6). A token under a subscription, its
`exp` an hour past the reading that times its session, arms 3,660,000 ms; one 30 days past,
2,147,483,647 ms, then 444,576,353.

13.10. A side resolves an `ELSEWHERE` by its verifier, the application's: a side given none takes
no `ELSEWHERE` (section 9.2, step 5). It asks the verifier once per request that presents one and
whose transport carried a credential, in a later turn, with what that transport carried, whole
(section 15.1), and the call's signal, aborted once the call ends while it resolves (sections 9.10,
10.2). The verifier makes of the credential what the application trusts — a session service asked
whether a token holds, a broker's word for the client it authenticated — and settles with a
credential's session, or with none when the credential does not hold. The session gives its `id`,
a string, its identifier being the record of `ELSEWHERE` and that `id`, two of which are one when
their `id`s are equal, octet for octet; its data, which the call carries; and its end, in
milliseconds since the epoch, or none for a session without one. The side holds that end rounded up
to a whole millisecond, _E_, and reads the wall clock, _W_, as the verifier settles: a session whose
end _W_ has reached, _W_ ≥ _E_, does not hold, `SESSION_REQUIRED`. A verifier that throws or
rejects fails, `PROCEDURE_FAILED`, reported, as does one that settles with a session whose `id` is
no string, or whose end is not a number from −(2⁵³ − 1) to 2⁵³ − 1 (section 1.2): the application's
fault, never the credential's.

## 14. Relays

_Conversations: `spec/conversations.json`._

_Transports: `spec/transports.json`._

14.1. A server MAY relay. It registers destinations — each from 1 to 2³² − 1, given or drawn, never
0 — each with the audience it verifies, as a resource is named for a token
([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)), or with none, and a request whose
`DESTINATION` names one goes on to what stands behind it: a router it calls through, or a connection
of its own, asked by a request of the server's. Each destination answers the same procedures; the
requester picks one by its destination. A side with no destination registered relays nothing: it
answers a request that names any with `DESTINATION_UNKNOWN` (section 9.2).

14.2. The relay terminates each leg: leg A, from the requester, and leg B, to the destination, each
with its own call ids, limits and session. What crosses is the payload's bytes, undecoded, and the
answer; a payload that came as a transfer is whole at the relay before leg B's request goes, as a
transfer of its own when it needs one. Leg B's request names no destination, so a relay forms no
chain, and no loop can form. A relay forwards a bearer credential, and its destination verifies it:
leg B's request presents what leg A's does, by its credential scheme, as section 14.3 lets it.

| Leg A presents | The relay                                                                                                 | Leg B presents                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| none, `OPAQUE` | resolves it to leg A's connection's session, which its admission checks                                   | none: it runs in leg B's session at the destination (section 14.7)     |
| `JWT`          | forwards it to a destination whose audience its `aud` names, read without verifying it unless it verifies | the same bytes                                                         |
| `ELSEWHERE`    | forwards it to a destination registered with an audience, over a leg B whose transport carries one        | `ELSEWHERE`, leg A's credential moved to leg B's transport, as it came |

A call that presents a credential never runs in leg B's session in place of its own. What leg A's
transport carried beside a call that presents anything but `ELSEWHERE` stays at the relay.

14.3. A relay takes these steps on a request that names a destination, in this order, on its
opening, before any of its payload crosses — as section 9.2's credential, admission and limit:

1. its credential, then its admission, `beforeRoute`, asked on its header, its destination
   included, before the destination is looked up, in this order:
   1. a credential scheme the relay neither resolves nor forwards — one to come, or, when it
      verifies, one its side has no verifier for: `CREDENTIAL_UNSUPPORTED`, whose detail names the
      schemes it takes as section 9.2's does — `OPAQUE, JWT, ELSEWHERE` from a relay that takes
      them all;
   2. its credential: none and `OPAQUE` resolve to leg A's connection's session as section 9.2
      resolves them. An `OPAQUE` that does not hold, and an `ELSEWHERE` whose transport carried
      nothing, are answered with `SESSION_REQUIRED`, with the detail section 9.2 gives each. A
      `JWT`, and an `ELSEWHERE` its transport carried, the relay forwards, read from the header's
      credential scheme alone: they resolve to no session at the relay. With `verifies`, it verifies them besides, with its side's
      credentials, as section 9.2 does: a `JWT` as section 13.8 does, against the set of audiences
      its destinations were registered with. One that does not hold — a `JWT` that names none of
      those audiences, say — is answered with `SESSION_REQUIRED`, with the detail section 9.2 gives
      it; a verifier that fails, with `PROCEDURE_FAILED`, and reported; a `JWT` that would wait for
      its issuer's keys past the calls the relay lets wait for them, with `CAPACITY_EXCEEDED`, not
      reported; one that holds resolves to its credential's session;
   3. `beforeRoute`, synchronous, on the call's session. A relay with no `beforeRoute` admits
      nobody: `ACCESS_DENIED`. A server's relay admits by default with `requireSessionOrCredential`:
      a call in leg A's connection's session, or one whose header presents a `JWT`, or an
      `ELSEWHERE` its transport carried, read from its credential scheme alone; any other, a call
      in none that presented none, with `SESSION_REQUIRED`. `requireSession` in its place tests the
      call's session (section 13.5), so it refuses every credential the relay forwards without
      verifying, with `ACCESS_DENIED`, as section 9.2 answers an admission's refusal of a call that
      presented a credential: the credential may hold, and this relay does not take it unverified.

   A requester not admitted learns only whether the relay has any destination, when it presents
   none or `OPAQUE`, or presents anything to a relay that verifies: a `JWT` passes the default
   admission of a relay that does not verify on its scheme alone, whatever its bytes;

2. a destination not registered: `DESTINATION_UNKNOWN`;
3. a request that opens a subscription: `SUBSCRIPTION_UNSUPPORTED`, since a relay carries none;
4. a destination whose connection closed, or whose connection carries no request of the relay's:
   `DESTINATION_UNREACHABLE`;
5. a call its leg B cannot carry, its credential holding or not: a `JWT` to a destination whose
   audience its `aud` does not name — read as section 13.8's step 11 reads it, without verifying
   the token; with `verifies`, the `aud` verified at step 1 — or to a destination registered with
   none; an `ELSEWHERE` to a destination registered with no audience, or over a leg B whose
   transport carries no credential beside an envelope (section 15.1); a `JWT` or an `ELSEWHERE`
   over a leg B that reaches off the machine in the clear, neither over TLS — `wss`, `https` — nor
   within the machine — the loopback, a Web Worker, a router called in process — since a bearer
   credential crosses only TLS off the machine
   ([RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750#section-5.3)), which its sender holds:
   `DESTINATION_UNREACHABLE`, since nothing was tried;
6. a payload, or a transfer's total, past the smaller of the two legs' limits, leg B's header
   counted with its credential, call by call — a destination that takes no transfer takes what one
   of its envelopes holds behind that header: `PAYLOAD_TOO_LARGE`.

14.4. A destination on a connection of the relay's own dies with that connection: once it closed,
the destination is unreachable, whoever connects under the same handle next, until it is registered
anew. Leg B waits for its answer as long as its destination says, and the relay's own timeout at
most; by default, without end: the requester's own timeout governs, end to end, by its cancel. A
cancel on leg A, or leg A's connection gone, cancels leg B, and leg A is answered nothing.

14.5. Leg A's answer follows leg B's:

| Leg B                                                                        | Leg A answers                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| a result                                                                     | that result                                    |
| a failure of the destination's                                               | that failure, one relay more                   |
| a limit of leg B's, a payload or a capacity, before its transport had it     | that refusal, the relay's own                  |
| any other error before, or the transport refusing the request                | `DESTINATION_UNREACHABLE`: nothing was tried   |
| any error once the transport had it: a limit, a timeout, the connection gone | `DESTINATION_LOST`: the procedure may have run |
| nothing: leg A ended first                                                   | nothing                                        |

An answer leg A cannot carry — a result past its limit — is answered with the failure that refused
it, or `PROCEDURE_FAILED`.

14.6. A failure through a relay counts the relays it crossed, one more per relay, 255 at most
(section 7.5); its side is not known. The relay's own failures cross no relay, and name no address
behind it: why leg B failed is the relay's to report, with leg A's connection.

14.7. Every requester behind a relay that presents none or `OPAQUE` shares its leg B: one session
at the destination, one space of call ids, its transfers' capacity. `beforeRoute`, which sees the
procedure and the destination, is where each such requester's rights are checked. A requester that
presents a `JWT` or an `ELSEWHERE` shares leg B's call ids and its transfers' capacity alike, and
runs at the destination in the session its own credential resolves to there, which the destination
verifies.

## 15. Transports

_Transports: `spec/transports.json`._

15.1. A transport carries envelopes between two sides, whole and in order on each connection, and
tells when a connection opens and when it closes, and, over HTTP, when a listen is held and when it
ends (section 13.7). It reads nothing of an envelope but what this section says; what it refuses of
its own is no envelope, and the router never sees it. A connection that closes ends what was under
way on it (sections 9.4, 12.10, 13.7). A transport may carry a credential beside an envelope, both
ways: it hands the router what it carried with an envelope it took, and carries what the router
gives it with one it sends. That credential is what a request presenting `ELSEWHERE` stands for
(section 9.2, step 5), and nothing else: a request that presents none, `OPAQUE` or a `JWT` resolves
as its header says, whatever its transport carried. Over HTTP, it is the `Authorization` field of a
request's `POST` (section 15.5); over a WebSocket, none (section 15.2). A transport says whether it
carries a credential beside an envelope it sends, and whether it is secure — under TLS, on the
loopback, or never leaving the machine — so that a side fails before it goes a call whose
credential it cannot carry (section 13.4). No failure's detail, event, trace or log carries that
credential, nor a header's: only its credential scheme.

### WebSocket

15.2. Each envelope is one binary message ([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)), and
each binary message one envelope. A text message is no envelope: the receiver reports it as
`ENVELOPE_MALFORMED`, and answers nothing. No subprotocol is required. A WebSocket carries no
credential beside an envelope, either way: a request that presents `ELSEWHERE` on one is refused
`SESSION_REQUIRED` (section 9.2, step 5), and a side fails a call that would present it over one
before it goes, `DESTINATION_UNREACHABLE`. Nor does its upgrade: what the opening handshake
carried, its `Authorization` among it, is no credential beside an envelope, and never stands for
`ELSEWHERE`.

15.3. A side MUST take a message of `maximumEnvelopeBytes` at least; past its own message limit,
`maximumMessageBytes` — `maximumEnvelopeBytes` by default — it closes the connection with 1009. A
side SHOULD ping its peer every `heartbeat` — 30 seconds by default, or never — and close a
connection that left a ping unanswered, so a peer gone without a word ends in a close. A side that
closes says 1000; a server that stops, 1001. A close with 1000 is the clean one.

### HTTP

15.4. HTTP's exchanges keep no connection, so the transport draws one. A `POST /bead` with no body,
of type `application/prs.bead` as every `POST /bead` is, and no token, connects: the server draws 16
bytes from a cryptographic source and answers 201, the token in
`bead-connection-token`, in base64url without padding. Each exchange after presents that token in
the same header, and a `DELETE /bead` ends the connection. The router, the sessions and the relays
see a connection, as over a socket. The connection's token names the connection and nothing else —
no session, no credential, which a call presents in its own header or its `POST`'s
`Authorization` (section 15.5) — and is written nowhere but in its header: no handle, no event, no
report carries it.

15.5. Each `POST /bead` carries one envelope, of type `application/prs.bead`. The transport reads its
layout, kind and call id, in the prefix every layout keeps (section 2), and nothing else:

1. a REQUEST waits for its answer, which comes back in the body of a 200 — a FAILURE too, since a
   failure travels once, in its envelope;
2. any other envelope ends 204 at once, handed on;
3. a REQUEST on the server's own parity is refused, 400; one on a call id already waiting, 409.

Exchanges keep no order between them, so a CANCEL may come before its REQUEST: the server buries
that call id for 5 seconds — the least a requester reserves one (section 10.3) — and ends the request
that comes under it 204, never handed on.

A client writes the credential a request carries in the `Authorization` field of its `POST`
([RFC 9110 §11.6.2](https://www.rfc-editor.org/rfc/rfc9110#section-11.6.2)), as it is given, and
fails the send before it goes for one no field can carry: anything but visible ASCII, spaces and
tabs. The server reads that field on a `POST` that carries a REQUEST, and no other exchange's: it
hands the router the field's value with the request, as it came, whole — its auth-scheme included —
its surrounding whitespace removed, and none when the field is empty or absent. Two calls of one
connection may so present two credentials, and a token is renewed without connecting again. A
`POST /bead` with more than one `Authorization` field is refused, 400, before its body is read: the
field is no list to combine ([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)).

15.6. A refusal of the transport's own has an empty body, and is marked in `bead-refusal`. A client
rejects a send on a marked refusal: nothing was tried. Any other status that is not 2xx — a
gateway's 502, a proxy's 404 — may come after the request ran: the client counts the exchange
lost.

| Status | `bead-refusal`                       | Says                                                                                                                                                                                               |
| ------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    |                                      | the request is with the router; its answer is the body — or, to a listen, a batch                                                                                                                  |
| 201    |                                      | a connection drawn, its token in `bead-connection-token`                                                                                                                                           |
| 204    |                                      | handed on, nothing to come back: a cancel, anything but a request, a request held off; a `DELETE` done; a listen that brought nothing                                                              |
| 400    | `malformed`                          | a connect with a body, no token or a malformed one, not an envelope, a request on the server's parity, two `Authorization` fields; a listen's count that is none, or an `after` past what was sent |
| 403    | `host-refused`, `origin-refused`     | a host not among those the server takes; a browser's exchange from an origin neither the server's nor among those it takes                                                                         |
| 404    | `path-unknown`, `connection-unknown` | not the path; the connection is gone                                                                                                                                                               |
| 405    | `method-refused`                     | neither `GET`, `POST` nor `DELETE`, which `Allow` names                                                                                                                                            |
| 409    | `call-waiting`, `listen-undeclared`  | a request on a call id already waiting; a listen whose client did not say at connect it listens                                                                                                    |
| 413    | `too-large`                          | a body past the envelope's limit                                                                                                                                                                   |
| 415    | `type-refused`                       | not `application/prs.bead`, or encoded                                                                                                                                                             |
| 429    | `busy`                               | too many requests waiting on one connection, or exchanges under way                                                                                                                                |
| 503    | `busy`                               | too many connections — all, or one address's — or bytes of body being read; `Retry-After`                                                                                                          |

Every response on the path carries `cache-control: no-store` and `x-content-type-options: nosniff`.

15.7. A client's send settles on the head of its answer: a 2xx says the server had the envelope. An
exchange lost — a network that failed, an answer that could not be written, a request unanswered
past the exchange timeout, 5 minutes by default — closes the connection at both ends, as a socket
that drops does; the exchanges it handed on are cut, never answered. So does the 404 marked
`connection-unknown`. A request handed on is never refused: when its connection closes, its exchange
gets its 200 head and is cut, and a cut that overtakes the head on its way leaves the exchange
lost, which its client counts so. A connection with no exchange under way for its inactivity
timeout, 5 minutes by default, closes.

15.8. What the server sends of its own — a notification, a request of its own, a cancel, the failure
that ends a subscription — reaches a client that listens. The client says so at connect,
`bead-listen: ?1` (the boolean of [RFC 9651](https://www.rfc-editor.org/rfc/rfc9651)), and the
server's 201 says it back when it takes the listen. It holds for the connection's life. To a client
that does not listen, a request that opens a subscription is refused, `SUBSCRIPTION_UNSUPPORTED`, a
request of the server's fails before it goes, and a relay passes it no request (section 14.3).

15.9. The server numbers each such envelope into the connection's outbox, from 1. A listen,
`GET /bead?after=&wait=`, acknowledges every envelope up to `after`, which leave the outbox, and
brings back all that is left in a batch of type `application/prs.bead-batch`: each envelope after
its length on 4 bytes, big-endian, the number of the first in `bead-sequence`, the others following
one by one. With nothing left, the server holds the listen up to `wait` milliseconds — 30 seconds at
most by default — and ends it 204; a second listen takes the first's place. A `wait` is a peer's,
not an application's (section 1.4): fifteen digits at most, a `wait` left out being 0, which answers
at once, and one past the server's bound held to it. A client reads a batch as it comes, and hears
each envelope as it comes whole; what a listen lost carried past what was heard comes again to the
next, so nothing is lost and nothing heard twice. An outbox past its bound — two envelopes' worth by
default — closes its connection, its client having fallen behind. A batch carries no credential
beside its envelopes, nor does an answer: a command of the server's that presents `ELSEWHERE` over
HTTP fails before it goes, `DESTINATION_UNREACHABLE`.

15.10. A client SHOULD listen from its connect on, asking a `wait` under the server's bound, and
listen again at once once a listen ends. A listen lost is listened again from where it was: at once,
then after 1, 2, 4 seconds and on to 30, each wait drawn between half of it and all of it. Its
inactivity timeout runs from its first loss, on a timer of the client's, never on a reading of its
wall clock: when it ends, it ends the wait under way, and the listen after it is the last — lost too,
the client counts the connection lost. A listen heard ends the count.

15.11. HTTP carries no transfer: a request's body is in before its answer goes, so no credit could
come back. Both sides of an HTTP connection set `maximumTransfers` to 0, and a payload is what one
envelope holds.

15.12. A server bounds what its clients hold, and both sides time what is under way, by these names:

| Bound                          | By default                   | Bounds                                                                            |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| `maximumConnections`           | 10,000                       | the connections a server holds, all of them                                       |
| `maximumConnectionsPerAddress` | 64                           | the connections one address holds                                                 |
| `maximumWaitingExchanges`      | 64                           | the requests waiting on one connection; the exchanges under way on it, twice that |
| `bodyBytesBudget`              | 268,435,456                  | the bytes of body a server reads at once, across its exchanges                    |
| `maximumBodyBytes`             | `maximumEnvelopeBytes`       | a body                                                                            |
| `maximumOutboxBytes`           | twice `maximumEnvelopeBytes` | what one connection's outbox holds                                                |
| `maximumWait`                  | 30 s                         | the longest a server holds a listen                                               |
| `exchangeTimeout`              | 5 min                        | how long an exchange handed on waits for its answer, at both ends                 |
| `inactivityTimeout`            | 5 min                        | how long a connection with no exchange under way stays                            |
| `connectionInactivityTimeout`  | 30 s                         | the server's own connection timeout (section 13.7)                                |

`exchangeTimeout`, `inactivityTimeout` and `connectionInactivityTimeout` may be without end;
`maximumWait` may not.

Past the first four it answers 429 or 503, as section 15.6's table says. It takes the hosts a request
may name, `hosts`, against a page that rebinds its name to the server's address, and the origins a
browser's exchange may come from besides its own, `origins`. A client's address is its socket's;
behind a proxy on the same machine, which the server is told to trust, `isProxyTrusted`, it is the
last entry of the proxy's `X-Forwarded-For`, when that entry is an address.
