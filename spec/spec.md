# Bead

What every implementation of Bead does, stated once. The key words "MUST", "MUST NOT", "REQUIRED",
"SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
[BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)]
[[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all
capitals, as shown here.

Each file of entries is named, on a line of its own, by a section whose clauses it plays, a group
of [`vectors.json`](vectors.json) by its name, and each entry cites the units it checks:
[`units.txt`](units.txt) lists every unit, whether an entry cites it or why none does, and the hash
of its text. The clock cases of
[`clocks.json`](clocks.json) cite none, and no section names them: they hold every side's test clock
to one meaning of `advance`. The why of each rule is in the decisions:

- [0001](../docs/decisions/0001-the-envelope-sits-at-fixed-offsets.md): the envelope, its calls, its
  transfers, its cancel, and what a transport owes;
- [0002](../docs/decisions/0002-a-subscription-goes-at-its-clients-pace.md): pacing, section 11;
- [0010](../docs/decisions/0010-a-request-presents-a-credential-of-a-scheme.md): a credential and
  its session, section 13;
- [0011](../docs/decisions/0011-every-side-takes-its-time-from-a-clock-it-is-given.md): the clock a
  side runs on;
- [0012](../docs/decisions/0012-a-listen-held-is-not-silence.md): a connection's timeouts, sections
  13 and 15;
- [0014](../docs/decisions/0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md): a
  duration, section 1.4;
- [0016](../docs/decisions/0016-a-json-payload-has-one-form-whichever-side-writes-it.md): payloads,
  section 17;
- [0017](../docs/decisions/0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md):
  identities, section 16;
- [0018](../docs/decisions/0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md):
  a procedure's kind, section 16;
- [0019](../docs/decisions/0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md): relays,
  section 14;
- [0020](../docs/decisions/0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md): HTTP,
  section 15;
- [0021](../docs/decisions/0021-a-broker-is-a-transport-and-bead-is-never-a-network.md): a broker,
  section 15;
- [0022](../docs/decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md):
  the blueprint, the interop's files and their schema, sections 16 and 17;
- [0023](../docs/decisions/0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md):
  a transport's listener that throws, and its stop, section 15;
- [0024](../docs/decisions/0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md):
  a server's hosts, the address it listens on, and a request's authority, section 15;
- [0025](../docs/decisions/0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md): a
  connection's handle, section 15;
- [0026](../docs/decisions/0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md):
  a refusal a server tells, the fields it takes, and what a client names of one, section 15;
- [0027](../docs/decisions/0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md):
  CORS over HTTP, to the origins a server names, section 15;
- [0028](../docs/decisions/0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md):
  a `proto` payload's records, read against its message before its library, section 17.9;
- [0029](../docs/decisions/0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md): a
  listen's cursor and wait in fields, section 15.9;
- [0030](../docs/decisions/0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md):
  a client's address behind the proxies a server names and those it counts, section 15.12;
- [0031](../docs/decisions/0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md):
  the `proto` encoding, section 17.9;
- [0032](../docs/decisions/0032-a-websocket-upgrade-from-no-page-carries-its-credential-beside-every-envelope.md):
  a WebSocket upgrade's credential, and a client that follows no redirect, section 15.

**Version: 0.6.0**, of layout `0xA1`. Each of its conformance files repeats it as its
`specVersion`, and follows its schema in [`schemas/`](schemas/). The interop's blueprint,
[`interop-blueprint.json`](interop-blueprint.json), and what its service does,
[`interop-service.json`](interop-service.json), are files of this version, which the conversations
play. **Status: every section is written; one point is open, section 8.3.**

What a side traces, filters and counts beside the wire is stated apart, under a version of its own,
in its companion [`debugging.md`](debugging.md), whether a side builds those or leaves them out. A
side conforms to the wire by sections 1 to 15, to what it declares by section 16, and to what its
codecs write and read by section 17, for each encoding it offers: a relay, which reads no payload,
offers none. A side does what each entry of the files that play those sections says, the clock
cases holding `advance` to one meaning, but an entry whose `differs` names a row of the support
matrix, [`docs/support.md`](../docs/support.md), and the side's language. A unit no entry cites
binds it all the same.

## 1. Conventions

_Durations: `spec/durations.json`._

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
aside, and a value that is no number: NaN, or a string or a boolean, as a limit read from JSON may
be. A timeout or a bound is never 0, and may be without end but where its place says it is never
without end; one not given is its default. A delay — a wait before an act: a pause, a reconnection's
wait, the `wait` a client's listens ask (section 15.10) — is never without end, and takes 0 as at
once.

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
`TRANSFER`, it is the transfer's first bytes. Section 17 says how its procedure reads and writes a
payload.

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
for an issuer's deadline (section 13.9). A requester gives it, too, to a call of its own it has no
call id free for (section 9.1). It says nothing against the call's credential, and withdraws none
(section 13.4).

8.3. Open in this version: nothing bounds the calls a peer holds open to its receiver over a
transport that keeps its connection, a WebSocket or a Web Worker. The receiver holds each request it
took until it is answered, cancelled, or its connection closes (section 9.10), each with its payload
whole, a request whose credential still resolves among them (section 13.9), and refuses none of them
for their number. Over HTTP, `maximumWaitingExchanges` bounds them, a refusal of the transport's own
(section 15.12), not this code. A bound of the protocol's, refused with `CAPACITY_EXCEEDED` as a
receiver takes the request (section 9.2), as HTTP/2 bounds the streams a peer opens
([RFC 9113 §5.1.2](https://www.rfc-editor.org/rfc/rfc9113#section-5.1.2)), comes by a decision of
its own.

## 9. Calls and answers

_Conversations: `spec/conversations.json`._

9.0. What a side _reports_ it tells its application — an error it raises, with the connection it
came on — and puts nothing on the wire. What it _answers_ goes back on the wire, as a failure on
the call id. What it _drops in silence_ it does neither. A failure a side answers for an error of
its own — a resolver that throws, a verifier or an admission that fails, a result it cannot send,
an answer leg A cannot carry (section 14.5), a codec that throws other than a refusal — MUST NOT
carry any detail of that error, an exception's message least of all: the error is reported, and
`PROCEDURE_FAILED` so answered carries no detail. Its code alone tells the requester how far its
call went (section 8.1), as a generic message is all an unexpected error returns to its consumer in
OWASP's Application Security Verification Standard
([ASVS 5.0 §16.5.1](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md)).

9.1. A call is a request and its answer, under one call id on one connection. Either side opens
calls: a client its requests, a server its commands to a client. A requester draws its call ids in
its own parity (section 3.5), from the first again once past the last, and skips those it waits on,
those it reserved (section 10) and those it holds otherwise, a subscription's. A requester with no
call id free in its parity fails its call before it goes, with `CAPACITY_EXCEEDED`. What this
section says of a side receiving a request holds for a client receiving a command alike.

9.2. A side receiving a request of this layout MUST take these steps in this order, and stop at the
first that applies:

1. A call id of the receiver's own parity: the request would answer another call. It MUST NOT be
   answered, and is reported as `ENVELOPE_MALFORMED`.
2. A call id open already — a call still to be answered, or one held as a subscription: the same.
3. A destination, named to a receiver that relays nothing (section 14.1): answered with
   `DESTINATION_UNKNOWN`.
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
      (section 13.9) — is answered with `PROCEDURE_FAILED`, and reported, never with
      `SESSION_REQUIRED`, which would have its requester withdraw a credential that holds
      (section 13.4). A `JWT` that would wait for its issuer's deadline past the calls the
      receiver lets wait for it, as it comes or as an answer moves it there (section 13.9), is
      answered with `CAPACITY_EXCEEDED`, in the turn it would have waited, and not reported:
      nothing failed, and its requester withdraws nothing (section 8.2);
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

A receiver that relays takes, on a request that names a destination, section 14.3's steps in their
order in place of steps 3 to 7, its credential resolving as the paragraph above says, and goes on as
section 14.2 says in place of step 8. Steps 1 and 2 hold for it as for any request, and it asks
nothing of steps 3 to 7 first: a requester it does not admit learns of its destinations only what
section 14.3 says.

9.3. An answer — a result or a failure — names its call by its call id alone: never its procedure,
never a destination. A call is answered once.

9.4. An answer MUST go out only while its call is open. Once its requester cancelled it, once its
connection closed, or once a new request opened its call id again, the answer MUST NOT go out: it
would settle a call it does not belong to.

9.5. A resolver that fails before it answers MUST still answer, with `PROCEDURE_FAILED`, so its
requester does not wait out its timeout. A payload its procedure cannot read (section 17) is
answered with `PAYLOAD_UNDECODABLE`, before the resolver sees it. A procedure's own failure is an
application failure, with a code from 1 to 65,535 of the procedure's own numbering.

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
waiting, a failure a client receives on the call id of a subscription it holds ends it
(section 11.7, item 2); on a call id reserved, it is late, and dropped in silence; otherwise it is
reported as `CALL_UNKNOWN`. A result that comes once a result in a transfer answered the call is
reported as `ENVELOPE_MALFORMED`.

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
are of one credential's session, whatever token each presented (section 13.10). A later request of
the same session that opens a subscription to the same procedure is answered, and holds nothing;
one of another session takes one of its own. Should the later request be answered while the first
call is still unanswered, it waits: if the first call then fails, is cancelled, or its answer does
not go out, the waiting call holds the subscription in its place, while its connection is open.

11.4. A server MAY send a notification before the answer of the call it travels on: a client binds
its subscription to the call id as it draws it, before the request goes out.

11.5. A call id a subscription holds is in use: a server MUST refuse a request on it (section 9.2,
step 2), and a client MUST NOT draw it.

11.6. The result of a request that opens a subscription, its procedure notifying or not, goes in
one envelope, whether its side sends transfers or not: one that would need a transfer
(section 12.1) is answered with `PROCEDURE_FAILED`, and reported as `PAYLOAD_TOO_LARGE`, as
section 12.1 answers a result its side cannot send, a failure, which subscribes nothing
(section 11.2).

11.7. A subscription ends:

1. by a cancel on its call id, from the client, which the server answers by nothing, and after
   which it sends nothing more on that call id;
2. by a failure on its call id, from the server — its queue past its bounds, its session ended, or
   a failure its application ends it with — after which the server sends nothing more on it, and
   the client reserves the call id (section 10.3);
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

11.10. A server bounds each queue — 64 notifications and 1 MiB by default; an application MAY set
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
result's, a result's header counted with the 20 bytes of an announcement, whether it carries one or
not. A notification, a failure, and the result of a request that opens a subscription (section 11.6)
always go in one envelope. A side that sends no transfer fails a request whose payload would need
one with `PAYLOAD_TOO_LARGE`, before anything goes out, and answers such a result with
`PROCEDURE_FAILED`, reporting `PAYLOAD_TOO_LARGE`.

12.2. Both ends of a connection set their limits alike: nothing announces them. A receiver holds
`chunkBytes` to a CHUNK (section 12.6); an opening, and a payload that came whole, it holds to
`maximumEnvelopeBytes`.

| Limit                       | By default  | Bounds                                                                                                                 |
| --------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `maximumEnvelopeBytes`      | 16,778,240  | an envelope, as it comes in and as it goes out                                                                         |
| `chunkBytes`                | 1,048,576   | a chunk's envelope, and the largest a payload goes whole in                                                            |
| `windowBytes`               | 4,194,304   | how far past what it received from the start a receiver lets its sender send                                           |
| `maximumPayloadBytes`       | 16,777,216  | a payload, whole or as a transfer; a procedure's own limit narrows it                                                  |
| `bufferedBytesBudget`       | 268,435,456 | the bytes a side reserves for the transfers it receives, together: each opening's, and each credit it grants past them |
| `maximumTransfers`          | 4           | the transfers a connection receives at once; 0 takes none, and sends none                                              |
| `maximumChunkRuns`          | 1,024       | the runs of bytes apart a transfer received holds before it is whole                                                   |
| `transferInactivityTimeout` | 30 s        | how long a transfer waits for its next chunk or credit                                                                 |
| `maximumDetailBytes`        | 1,024       | a failure's detail                                                                                                     |

They MUST hold together: an envelope of 64 bytes at least; a chunk from 64 bytes to an envelope; a
window of two chunks at least, so a sender never waits for a credit it is owed; a payload within the
budget; a timeout section 1.4 allows, never without end, so a transfer's call id comes free. A side
that takes or presents a `JWT` — given its keys, or one to present by default — sets `chunkBytes`
and `maximumEnvelopeBytes` to 1,024 bytes at least besides, which a header of 1,020 bytes
(section 4.3) and the byte of payload an opening carries (section 12.3) need: its limits hold
together only so.

12.3. The opening is the request or the result itself, with the TRANSFER block: the payload's total
on 8 bytes, and its first bytes, one at least, as many as fill the envelope to `chunkBytes`, sent
without credit. A requester whose header, its TRANSFER block added, passes 1,020 bytes
(section 4.3) or leaves its opening no byte within `chunkBytes` fails its call before it goes, with
`PAYLOAD_TOO_LARGE`, as section 12.1 fails a payload its side sends no transfer of: a `JWT` of 997
bytes or more, 993 or more beside a destination, goes whole only. A side receiving an opening:

1. of a request, takes the steps of section 9.2 on it — its credential's resolution, its admission
   and the total it declares held to the procedure's limit included — before any credit goes: none
   goes until its resolution and its admission settle, a refusal answers the opening, and no chunk
   follows;
2. of a result, ends the call with `PAYLOAD_TOO_LARGE`, and cancels it, for a total past the
   call's limit;
3. refuses, in this order, a total of 0, and a total past what it takes, with `PAYLOAD_TOO_LARGE`;
   an opening past the transfers its connection receives at once, or past the budget left, with
   `CAPACITY_EXCEEDED`; an opening that carries no byte of its payload, or holds its whole total,
   which needed no transfer, with `CHUNK_INVALID`.

12.4. A CREDIT without PACED, on the call id of a transfer, carries the end below which its sender
may send: absolute, so a credit repeated, late or out of order never grants too much. A credit
lower than one received grants nothing. The receiver grants as far as `windowBytes` past the bytes
it holds from the start, once that is half a window past its last credit — or reaches the total,
when less is left — and never past the budget left. A transfer the budget cannot credit waits until
the budget frees, the transfers opened first credited first.

12.5. A CHUNK carries its offset on 8 bytes, and MORE on all but the last. A sender MUST send full
chunks only — `chunkBytes` less the chunk's own 16 bytes of header, exactly — and the last,
which reaches the total and is full at most; it waits for credit when a full one does not fit
under it.

12.6. A side receiving a chunk of a transfer places it in any order, checked in this order:

1. its bytes within the total, one at least; MORE clear when it reaches the total, and only then;
   full when it does not, and full at most when it does, so no CHUNK's envelope passes
   `chunkBytes`: otherwise `CHUNK_INVALID`;
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
  its call as timed out after as long, and cancels it; the side sending a result's transfer reports
  its stall as well.

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

13.4. A client learns its connection's session from the answers, and presents it, `OPAQUE`, only on
a call that asks for it, never by default: that call is bound to the session the client knows, so a
call made in a session that ended, or that was opened anew under a new token, is refused rather than
run in whatever session the connection holds. A call that asks for its session, `OPAQUE`, while the
client knows none fails before it goes, with `SESSION_REQUIRED`, and withdraws nothing. A client MAY
be given a credential to present by default: a `JWT`, or an `ELSEWHERE` with what its transport
carries beside each request (section 15.1). Every call presents it but one that gives its own, or
none: a call may present none, whatever the default. A default is withdrawn once a call that
presented it is refused `SESSION_REQUIRED`, whatever relays the refusal crossed: from then on, until
its application gives it a default again, or none, the client fails before it goes each call that
would present it, with `SESSION_REQUIRED`, and withdraws nothing, as it fails a call that asks for a
session it does not know; and it tells its application, by the credential's scheme alone. A call
that presents its own credential, or none, goes: a call that needs no identity presents none, given,
and so does the call that renews it. A refusal withdraws the default only while it is still the
credential its call presented, the same scheme and the same bytes: a default given other bytes since
is kept, and one set again to the same bytes is withdrawn with it; and a failure that ends a
subscription its server had answered (section 13.6) withdraws nothing, even one that comes before
that answer (section 15.9), since a session the application ended leaves a credential that may still
hold. A client receiving a command resolves its credential as a server does (section 9.2, step 5),
the session it learned standing for its connection's.

A call presents none, `NONE`, `OPAQUE`, a `JWT` with its token, or an `ELSEWHERE` with what its
transport is to carry beside it. Any other — an `ELSEWHERE` that gives nothing to carry, a `JWT`
with no token, a scheme to come — is the application's fault, refused before the call starts and
not counted (`debugging.md` 9.3), and no failure: nothing was asked of its transport.

A client fails a call before it goes, and a server a command alike, with `DESTINATION_UNREACHABLE`,
as a relay refuses a call its leg B cannot carry (section 14.3): nothing was tried, and its
credential stays. It does so for a call that presents `ELSEWHERE` over a transport that cannot carry
the credential it presents — a WebSocket whose upgrade carried other bytes, or none (section 15.2),
a Web Worker, whose messages carry an envelope alone, a server's over HTTP or over a WebSocket
(sections 15.9, 15.2) — and for one that presents a `JWT` or an `ELSEWHERE` over a transport that
leaves the machine in the clear, since a bearer credential crosses only TLS off the machine
([RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750#section-5.3)). A transport is judged by
what it is given, never by what a name resolves to. It is secure under TLS, its scheme `wss` or
`https`; on the loopback: a client by the host it names in its URL — `localhost` or a name that ends
in `.localhost`, compared in ASCII lower case, an IPv4 address in 127.0.0.0/8, or the IPv6 loopback,
`[::1]` in a URL — as the
[WHATWG URL Standard's host parser](https://url.spec.whatwg.org/#host-parsing) reads it, by which
the W3C's Secure Contexts reads an origin, and as
[Secure Contexts](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy) judges an origin
potentially trustworthy; a server by the address it listens on (section 15.12), in 127.0.0.0/8,
`::1`, or `localhost`, both; or when it never leaves the machine, a Web Worker or a router called in
process. Every client reads a host alike: `127.0.0.1.` and `127.1`, which the parser reads as
127.0.0.1, are on the loopback; a host it fails on, one followed by a space among them, is not, nor
is `localhost.`, which it keeps as given. A client takes a `localhost` name on the loopback without
resolving it, as Secure Contexts does where the platform resolves such names there alone
([RFC 6761 §6.3](https://www.rfc-editor.org/rfc/rfc6761#section-6.3)): on a platform whose resolver
sends one elsewhere, its application gives another host. Any other leaves the machine in the clear.
A server cannot tell what stands in front of it: its application MAY say so, and is then believed
whatever the server listens on — TLS terminated before it, which makes it secure, or a proxy that
serves the network in the clear, which leaves it in the clear.

13.5. A credential that does not hold is refused at its resolution, whatever the procedure
requires (section 9.2, step 5): a call never runs outside the session it presented. A procedure
that requires a session tests the call's session, never the connection's: it refuses a call in none
that presented no credential with `SESSION_REQUIRED`, and one that presented a credential it does
not run in — a `JWT` or an `ELSEWHERE` a relay forwards without verifying (section 14.3) — with
`ACCESS_DENIED`, since `SESSION_REQUIRED` would have its requester withdraw a credential that may
hold (section 9.2, step 5). A call that presented a `JWT` is not in its connection's session,
whatever that session holds. `ACCESS_DENIED` says that the call is not allowed as it came: a
session holds and is not allowed, a credential came that the admission does not take, or the
admission takes the call only with a credential — a server's relay by default (section 14.3, step
1). A procedure that ends its connection's session ends it before it answers, so its own answer —
or the failure of section 13.6, should one go out first — announces the end.

13.6. A session that ends ends the subscriptions it bounds (section 11.3): a connection's session,
those of its connection that no credential's session bounds; a credential's session, those its
calls hold on each connection that keeps it, at its end, or by its identifier or its issuer
(section 13.10). Each is answered with a failure on its call id, `SESSION_REQUIRED`; a call still
unanswered is left to its own answer. The connection stays, to open another session.

13.7. A connection's session has two inactivity timeouts: past its session timeout, the session
ends, and the connection stays; past its connection timeout, the connection is closed, and takes its
session. A credential's session has none: no message, listen or silence moves its end, and it ends
at its end, once the application ends it, or with its connection. A connection without a
connection's session — none yet, or its session ended, whatever credentials its calls present — is
closed once silent past the server's own connection timeout, when it has one, counted from its
session's end for one that had one. Each of these timeouts may be without end, and is when neither
the application nor its transport gives one: an HTTP server gives its own connection timeout, 30 s
(section 15.12). A message of its connection starts every one anew, whatever session its call runs
in; a session timeout counts messages alone. Over HTTP, a listen held is not silence: while one is
held, no connection timeout runs, and silence counts anew from its end (section 15.9). Over
WebSocket, a peer that only hears is silent: it speaks now and then, or is given a connection
timeout without end. A connection that closes takes its sessions; a session opened for a connection
already closed ends at once.

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
   has one key. Keys of one issuer whose thumbprints are equal (RFC 7638) — their `crv`, `kty`, `x`
   and `y` for an `EC` key, their `k` and `kty` for an `oct` one, octet for octet — are one key, the
   first of them in the order this step searches, which step 6 reads alone. So a key set that
   answers again a key the application gave refuses none of the tokens that name that key by its
   `kid`, nor one without a `kid` when it answers no other key of that issuer. A `kid` that names
   none is refused, never tried against the others, and so is one that leaves keys of two materials;
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
holds a surrogate alone names nothing, so a `sid`, a `sub` or an `aud` that holds one is no string,
and an `aud` array holding one is no array of strings. A claim is read as an IEEE 754 double, as
both sides' JSON readers read it, and the 60 s is a leeway for clock skew, a constant on every side,
never an option.
A token that holds gives its session: its identifier, `{ issuer, sid }`, its `iss` with its `sid`,
else `{ issuer, sub }`, its `iss` with its `sub`; its claims set; and its end, _E_ = _X_ + 60,000.
A key not shaped for its algorithm — an `ES256` one that is not `EC` on `P-256`, its `x` and `y` 32
bytes each, an `HS256` one that is not `oct`, its `k` 32 bytes at least (RFC 7518 §3.2) — is the
application's fault, never the token's: the verifier fails, and refuses nothing.

_Vectors: `jwtVerdicts`._

13.9. A side may be given a key set besides its keys, with the issuers it answers for, one at least,
and the most calls that wait for one issuer's deadline at once, `maximumWaitingCalls`, _M_: a whole
number from 1 to 2³¹ − 1, 64 when not given. A key set given with no issuer, or with an _M_ outside
those bounds, is the application's fault, refused as the side is built. Asked for one of its
issuers, with a signal, it answers that issuer's keys (RFC 7517 §5), each a JWK with its one
algorithm, and may wait. The side fetches nothing itself: the key set is the application's to fetch.
It asks the key set, holds the keys an answer gives, and has a call wait for them as follows:

1. The side asks it for no other issuer, compared octet for octet: a token whose `iss` it does not
   name is judged at once by the keys there are, asking nothing, so no peer has it asked for an
   issuer of the peer's choosing.
2. The side asks it once a minute at most for an issuer: an ask sets that issuer's deadline a minute
   past the reading at which it goes, on the side's monotonic reading (decision 0011), and its
   signal aborts as that deadline is reached. A deadline is reached once that reading is at it or
   past it, wherever the side reads that issuer's state — as a call of that issuer comes, as an
   answer comes, as the deadline's timer fires — whichever is first, and never as a call leaves its
   wait, which reads nothing of it: the timer, which may fire late, only makes sure it is reached
   when nothing else reads it.
3. An ask that fails — the key set throws or rejects, answers what is not keys shaped for their
   algorithms, or is unsettled as its deadline is reached, what it settles to at or past that
   deadline being dropped — fails the verifier of every call that waits on it (section 9.2, step 5),
   as a key set that cannot be reached does.
4. The keys an answer gave are held for its issuer, beside the application's, in place of those its
   last answer gave, ten minutes from that answer on the monotonic reading: they serve while that
   reading is before the answer's plus 600,000 ms, and an ask that fails replaces none of them. The
   application's own keys are held for good. Section 13.8's step 4 finds a key among the
   application's keys, in the order given, then the held keys that serve, an issuer's in the order
   its answer gave them.
5. A token the keys that serve verify waits for nothing. One of an issuer the key set names, which
   they do not verify, waits for that issuer's keys while its key does not serve: while its `kid`
   names none of its issuer's keys that serve, whatever another issuer's key names, as a verifier
   asks again for a `kid` it does not know (OpenID Connect Core 1.0 §10.1.1); or, without a `kid`,
   while none of its issuer's keys serve — none given, none answered yet, or all past their ten
   minutes — as a `kid` that names none waits, so a side that starts asks for them. It waits on its
   issuer's ask under way, when one is; otherwise, before that issuer's deadline, for the deadline
   and the ask that goes then, shared by every call that waits — at a deadline no call waits for,
   none goes; otherwise, on an ask that goes at once. A call that comes at or past its issuer's
   deadline on the reading, before the deadline's timer fired, reaches the deadline as it comes: an
   ask still unsettled has failed then, and the ask the deadline lets go goes then, for the calls
   that waited for it and for the call that comes, when it waits. An ask went after a token came
   unless the token found it under way: the ask a token sets off as it comes — at once, or at a
   deadline its coming reaches — and the ask that goes at a deadline it waited for each went after
   it came. As an ask answers, each call that waits on it is judged again: one whose key now serves,
   or whose ask went after its token came, is verified against the keys that serve, so a `kid` that
   answer did not name is refused then, at section 13.8's step 4 or past it; any other waits on, for
   the deadline and the ask then, since an ask that went before its token came might not know its
   key.
6. At most _M_ calls wait for one issuer's deadline at once, each issuer's apart. A call that waits
   on an ask is not counted: the key set's own latency bounds its wait, and the ask's deadline. A
   call is counted as it starts to wait for the deadline, and as an answer moves it there from an
   ask that went before its token came, the calls that answer moves taken in the order they came to
   that ask: one that would wait past _M_ is refused `CAPACITY_EXCEEDED` then, in the turn it would
   have waited, and not reported (section 9.2, step 5). A call holds its place while it waits for
   the deadline: at the deadline, the calls that waited for it wait on the ask that goes then, and
   hold none there, and a call that leaves frees its own. A peer that sends tokens whose `kid` no
   key names holds no more than _M_ calls, and what they carry, for an issuer's deadline, and any
   more no longer than an ask takes to settle, a minute at most.
7. A call's own signal — its cancel, which its requester's timeout sends as well (section 9.9), or
   its connection closing (section 9.10) — ends its own wait, never the ask.

13.10. A credential's session ends at its end, on a timer that reads the wall clock again at each
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
   `SESSION_REQUIRED` (section 13.11).

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

13.11. A side resolves an `ELSEWHERE` by its verifier, the application's: a side given none takes
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

| Leg A presents | The relay                                                                                                                                                                                            | Leg B presents                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| none, `OPAQUE` | refuses it by default; where its admission takes leg A's connection's session, resolves it to that session (section 14.3, step 1)                                                                    | none: it runs in leg B's session at the destination (section 14.7)     |
| `JWT`          | forwards it to a destination whose audience its `aud` names, read without verifying it unless it verifies                                                                                            | the same bytes                                                         |
| `ELSEWHERE`    | forwards it to a destination registered with an audience, over a leg B whose transport carries it, as section 13.4 judges a client's: an HTTP leg B, never a WebSocket whose upgrade carried another | `ELSEWHERE`, leg A's credential moved to leg B's transport, as it came |

A call that presents a credential never runs in leg B's session in place of its own. What leg A's
transport carried beside a call that presents anything but `ELSEWHERE` stays at the relay.

14.3. A relay takes these steps on a request that names a destination, in this order, on its
opening, before any of its payload crosses, in place of section 9.2's steps 3 to 7, its credential
resolving as section 9.2 says:

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
      credential scheme alone: they resolve to no session at the relay, in a later turn, as
      section 9.2 has a `JWT` and an `ELSEWHERE` resolve: a call presenting none that came after one
      may be taken first. With `verifies`, it verifies them besides, with its side's credentials, as
      section 9.2 does: a `JWT` as section 13.8 does, against the set of audiences its destinations
      were registered with. One that does not hold — a `JWT` that names none of those audiences,
      say — is answered with `SESSION_REQUIRED`, with the detail section 9.2 gives it; a verifier
      that fails, with `PROCEDURE_FAILED`, and reported; a `JWT` that would wait for its issuer's
      deadline past the calls the relay lets wait for it, with `CAPACITY_EXCEEDED`, not reported;
      one that holds resolves to its credential's session;
   3. `beforeRoute`, synchronous, on the call's session. A relay with no `beforeRoute` admits
      nobody: `ACCESS_DENIED`. A server's relay admits by default with `requireCredential`: a call
      whose header presents a `JWT`, or an `ELSEWHERE` its transport carried, read from its
      credential scheme alone unless the relay verifies, which the relay forwards for its
      destination to verify; any other — one that presents none or `OPAQUE`, in leg A's
      connection's session or in none — with `ACCESS_DENIED`, its detail
      `a relay admits by default only a credential it forwards`, since leg A's session opens
      nothing at the destination (section 14.7). `shareLegBSession` in its place admits besides a
      call in any session of leg A's connection's, whatever its destination, which then runs in leg
      B's session there, and refuses a call in none that presented none with `SESSION_REQUIRED`.
      `requireSession` tests the call's session (section 13.5), so it refuses every credential the
      relay forwards without verifying, with `ACCESS_DENIED`, as section 9.2 answers an admission's
      refusal of a call that presented a credential: the credential may hold, and this relay does
      not take it unverified.

   A requester not admitted learns only whether the relay has any destination (section 9.2, step 3),
   when it presents none or `OPAQUE`, or presents anything to a relay that verifies: a `JWT`, and an
   `ELSEWHERE` its transport carried, pass the default admission of a relay that does not verify on
   their scheme alone, and learn which destinations exist;

2. a destination not registered: `DESTINATION_UNKNOWN`;
3. a request that opens a subscription: `SUBSCRIPTION_UNSUPPORTED`, since a relay carries none;
4. a destination whose connection closed, or whose connection carries no request of the relay's:
   `DESTINATION_UNREACHABLE`;
5. a call its leg B cannot carry, its credential holding or not: a `JWT` to a destination whose
   audience its `aud` does not name — read as section 13.8's step 11 reads it, without verifying
   the token; with `verifies`, the `aud` verified at step 1 — or to a destination registered with
   none; an `ELSEWHERE` to a destination registered with no audience, or over a leg B whose
   transport cannot carry it (section 13.4): a WebSocket's, whose upgrade carried the relay's own
   credential or none, never leg A's; a `JWT` or an `ELSEWHERE` over a leg B that reaches off the
   machine in the clear, neither over TLS — `wss`, `https` — nor within the machine — the loopback,
   a Web Worker, a router called in process — since a bearer credential crosses only TLS off the
   machine ([RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750#section-5.3)), which its sender
   holds: `DESTINATION_UNREACHABLE`, since nothing was tried;
6. a payload, or a transfer's total, past the smaller of the two legs' limits, leg B's header
   counted with its credential, call by call — a destination that takes no transfer takes what one
   of its envelopes holds behind that header: `PAYLOAD_TOO_LARGE`.

14.4. A destination on a connection of the relay's own dies with that connection: once it closed,
the destination is unreachable until it is registered anew, on another connection: no connection
takes a handle its transport gave before (section 15.1). Leg B waits for its answer as long as its
destination says, and the relay's own timeout at most; by default, without end: the requester's own
timeout governs, end to end, by its cancel. A cancel on leg A, or leg A's connection gone, cancels
leg B, and leg A is answered nothing.

14.5. Leg A's answer follows leg B's:

| Leg B                                                                        | Leg A answers                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| a result                                                                     | that result                                    |
| a failure of the destination's                                               | that failure, one relay more                   |
| a limit of leg B's, a payload or a capacity, before its transport had it     | that refusal, the relay's own                  |
| any other error before, or the transport refusing the request                | `DESTINATION_UNREACHABLE`: nothing was tried   |
| any error once the transport had it: a limit, a timeout, the connection gone | `DESTINATION_LOST`: the procedure may have run |
| nothing: leg A ended first                                                   | nothing                                        |

An answer leg A cannot carry — a result past its limit — is answered with `PROCEDURE_FAILED`, why
it did not go out reported, as section 12.1 answers a result its side cannot send; one its
transport did not take goes nowhere again, and is reported (section 9.4).

14.6. A failure through a relay counts the relays it crossed, one more per relay, 255 at most
(section 7.5); its side is not known. The relay's own failures cross no relay, and name no address
behind it: why leg B failed is the relay's to report, with leg A's connection.

14.7. A requester behind a relay that presents none or `OPAQUE`, and that the relay's
`beforeRoute` admits, shares its leg B: one session at the destination, one space of call ids, its
transfers' capacity. A server's relay admits none by default (section 14.3, step 1): sharing leg
B's session is its application's choice, written as a `beforeRoute` of its own, which sees the
procedure and the destination and is where each such requester's rights are checked — a
requester's session names the destinations it may reach — or as `shareLegBSession`, which checks
neither. Without such a check, a requester in any session of leg A's acts at every destination
with leg B's rights, as a deputy that lends its own authority
([CWE-441](https://cwe.mitre.org/data/definitions/441.html)). A requester that presents a `JWT`
or an `ELSEWHERE` shares leg B's call ids and its transfers' capacity alike, and runs at the
destination in the session its own credential resolves to there, which the destination verifies.

## 15. Transports

_Transports: `spec/transports.json`._

15.1. A transport carries envelopes between two sides, each whole, and tells when a connection opens
and when it closes, and, over HTTP, when a listen is held and when it ends (section 13.7). On a
connection, it hands each envelope on once, in the order its side sent it, unless its section says
otherwise: HTTP keeps the outbox's order for what the server sends of its own (section 15.9), and
none between a client's exchanges, so that a CANCEL may come before its REQUEST (section 15.5). A
transport that keeps no order states what may overtake, and one that may hand an envelope on twice
states what a copy is, each with what the side that receives it does of it. A server's transport
names each connection it holds by a handle, which its router, its sessions and its relays name the
connection by, and what it reports (`debugging.md` 4.1, 5.1). It draws the handle as it takes the
connection, never from the peer's address alone, which another connection may share
([RFC 9293 §3.4.1](https://www.rfc-editor.org/rfc/rfc9293#section-3.4.1)), and gives none twice:
no two connections it holds are one, and its bounds, its gauges and its stop reach each. A server's
transport stops when its application stops it: from then on it takes nothing new (sections 15.2,
15.7) and it closes each connection it holds (sections 15.3, 15.7). A handle is no secret, and
carries none (section 15.4); its form is its implementation's, written for a reader of a trace, and
an application compares a handle whole. A transport reads nothing of an envelope but what this
section says; what it refuses of its own is no envelope, and the router never sees it. A side calls
each listener of its transport's events — a connection opened, an envelope, a listen, a close, a
refusal, a reconnection — within a guard, as it calls a debug listener (`debugging.md` 2.2, 2.3):
what one throws is reported, as section 9.0 reports an error, by its transport with the connection
it was told of; the listeners after it are called all the same, and the transport goes on as if it
returned. A side awaits nothing a listener returns: what it settles to later is its platform's, as
is what a listener of the transport's own `error` throws. A listener's throw refuses no connection,
fails no exchange and closes nothing. A server's transport tells each refusal it judges of its own:
a request it refuses as it arrives, in section 15.6's order, or whose body it refuses as it comes,
marked in `bead-refusal`. It never tells the 404 that ends an exchange or a listen it had taken as
their connection closes (section 15.7), which its close tells, nor what HTTP refuses of its own,
unmarked. A refusal told carries its status, its reason, the request's authority and its `Origin`,
each as it came, the field's lines joined by ", "
([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)), or none, and the client's
address and port (section 15.12); nothing else of the request, so neither its target, nor its
connection's token, nor a credential. It names no connection: a refusal is a request's, and a
listener's throw is reported with none. A connection that closes ends what was under way on it
(sections 9.4, 9.10, 12.10, 13.7). A transport may carry a credential beside an envelope, both ways:
it hands the router what it carried with an envelope it took, and carries what the router gives it
with one it sends. That credential is what a request presenting `ELSEWHERE` stands for (section 9.2,
step 5), and nothing else: a request that presents none, `OPAQUE` or a `JWT` resolves as its header
says, whatever its transport carried. Over HTTP, it is the `Authorization` field of a request's
`POST` (section 15.5), each request's own; over a WebSocket, the `Authorization` field of an upgrade
that carries no `Origin`, one for every envelope of the connection, toward its server alone (section
15.2). A transport says whether it carries the credential a call presents beside an envelope it
sends — a client's over HTTP any field value, over a WebSocket the one its upgrade carried,
compared in constant time; a Web Worker's none, nor a server's toward its client (sections 15.2,
15.9) — and whether it is secure — under TLS, on the loopback, or never leaving the machine — so
that a side fails before it goes a call whose credential it cannot carry (section 13.4). No
failure's detail, event, trace or log carries that credential, nor a header's: only its credential
scheme.

### WebSocket

15.2. Each envelope is one binary message ([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)), and
each binary message one envelope. A text message is no envelope: the receiver reports it as
`ENVELOPE_MALFORMED`, and answers nothing. No subprotocol is required. A WebSocket upgrade that
carries no `Origin` carries one credential, toward its server alone: its `Authorization` field
([RFC 9110 §11.6.2](https://www.rfc-editor.org/rfc/rfc9110#section-11.6.2),
[RFC 6455 §10.5](https://www.rfc-editor.org/rfc/rfc6455#section-10.5)), as it came, whole — its
auth-scheme included — its surrounding whitespace removed, none when the field is empty or absent.
An upgrade that carries an `Origin` carries none, whatever its `Authorization`: it comes from a
page, whose browser writes its own authentication on it as it sends its cookies
([Fetch](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch), credentials mode `include`),
so that a page of any origin the server takes would present its user's credential; a page presents
a `JWT`. The server hands the credential to the router beside every envelope of that connection, as
an HTTP server hands a `POST`'s beside its request (section 15.5): a request presenting `ELSEWHERE`
stands for it, resolved once per request (section 13.11), so a credential that no longer holds, or
whose end has come, is refused on the request that presents it, and the connection stays; a
request that presents none, `OPAQUE` or a `JWT` resolves as its header says (section 15.1). One
connection carries one credential: a client presents another by connecting again, or presents a
`JWT`, which its envelope carries and a renewal moves without a new connection (section 13.10). An
HTTP connection carries a credential per `POST`, so its connect's is read by no one (section 15.5);
a WebSocket carries one per connection, so its upgrade's is the one read. Nothing is carried toward
a client: a server's command that presents `ELSEWHERE` over a WebSocket fails before it goes,
`DESTINATION_UNREACHABLE`. A client writes on each upgrade the credential it is given for it, as
given, and none otherwise; it fails that upgrade before it goes for one that is no field value, as
section 15.5 says, and for one over a WebSocket that leaves the machine in the clear (section
13.4), its upgrade being where it would cross. No server reads a credential from its target's
query, which logs keep ([RFC 6750 §2.3](https://www.rfc-editor.org/rfc/rfc6750#section-2.3)), from
a cookie, which a page's browser sends on its own, or from a subprotocol. A client writes no
`Origin` on its upgrade: a page's browser writes its own, which the server judges (step 7). A server
judges a request at its WebSocket's address in this order, and answers the first that applies:

1. What HTTP refuses of its own, a `Host` missing or repeated, a target in absolute-form it does not
   read, an authority that is no host, or a field that holds a control character or an octet past
   US-ASCII (section 15.12), its HTTP server answers, unmarked.
2. A server takes an upgrade from the hosts an HTTP exchange is taken from (section 15.12): a
   request whose authority names a host it does not take, or none, is refused 403, its
   `bead-refusal` `host-refused`, whatever else it holds, since a page that rebinds its name to the
   server's address is its own origin by its authority, and `hosts` is what refuses it — under `*`,
   which takes it here, step 7 does, its origin none of the server's own (section 15.12).
3. A method other than `GET` or `HEAD` is refused 405, its `Allow` naming both
   ([RFC 9110 §15.5.6](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.6)).
4. A request that asks no WebSocket is answered 426, `upgrade-required`, its `Upgrade` naming
   `websocket` ([RFC 9110 §15.5.22](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.22)): a
   `HEAD`, which cannot switch; an `HTTP/1.0` request, whose `Upgrade` is ignored; one whose
   `Upgrade` lists no `websocket`, or whose `Connection` lists no `upgrade`, each token compared in
   any ASCII case, across the field's lines
   ([RFC 9110 §7.8](https://www.rfc-editor.org/rfc/rfc9110#section-7.8)).
5. An upgrade whose `Sec-WebSocket-Version` comes in more than one field line is malformed; one of
   any other `Sec-WebSocket-Version` but 13, or of none, is answered 426, `version-refused`, its own
   `Sec-WebSocket-Version` naming 13
   ([RFC 6455 §4.2.2](https://www.rfc-editor.org/rfc/rfc6455#section-4.2.2)), before any field its
   version shapes.
6. An upgrade of version 13 is malformed, and refused 400, `malformed`, whose `Sec-WebSocket-Key` is
   not one field of 16 bytes in base64, whose `Sec-WebSocket-Protocol` is not a list of distinct
   tokens, that carries more than one `Authorization` field line, which is no list to combine
   ([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)), or that has content
   ([RFC 6455 §4.2.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.2.1)).
7. An upgrade that carries an `Origin` neither its own nor among those it takes is then refused 403,
   `origin-refused`, so that the `Origin` it judges an upgrade by is the field it judges an exchange
   by; no same-origin policy guards an upgrade, and a page of any origin may ask for one
   ([RFC 6455 §10.2](https://www.rfc-editor.org/rfc/rfc6455#section-10.2)).
8. Once its stop began, a server takes no upgrade: one it would take is refused 503, `busy`, its
   `Retry-After` 1 ([RFC 9110 §15.6.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4),
   [§10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)).

Each of these refusals but HTTP's own is marked as section 15.6 says, and told (section 15.1), with
`cache-control: no-store` and `x-content-type-options: nosniff`, its body empty, and closes its
connection; a 426 names `upgrade` in its `Connection`.

15.3. A side MUST take a message of `maximumEnvelopeBytes` at least; past its own message limit,
`maximumMessageBytes` — `maximumEnvelopeBytes` by default — it closes the connection with 1009. A
side SHOULD ping its peer every `heartbeat` — 30 seconds by default, or never — and close a
connection that left a ping unanswered, so a peer gone without a word ends in a close. A side that
closes says 1000; a server that stops, 1001, to each connection it holds, one whose opening
handshake completes as its stop begins among them. A close with 1000 is the clean one.

### HTTP

15.4. HTTP's exchanges keep no connection, so the transport draws one. A `POST /bead` with no body —
no `Transfer-Encoding`, and no `Content-Length` or one whose number is 0, its digits read as a number
([RFC 9110 §8.6](https://www.rfc-editor.org/rfc/rfc9110#section-8.6)) —,
of type `application/prs.bead` as every `POST /bead` is, and no token, connects: the server draws 16
bytes from a cryptographic source and answers 201, the token in
`bead-connection-token`, in base64url without padding. Each exchange after presents that token in
the same header, and a `DELETE /bead` ends the connection. The router, the sessions and the relays
see a connection, as over a socket. The connection's token names the connection and nothing else —
no session, no credential, which a call presents in its own header or its `POST`'s
`Authorization` (section 15.5) — and is written nowhere but in its header: no handle, no event, no
report carries it. Off the machine, the token crosses what its exchanges cross. Under TLS it is kept
as they are. In the clear, an on-path observer reads it as it reads the exchanges and the session
token they carry (section 13.3), as over a WebSocket in the clear. TLS off the machine is the
deployment's, and every bearer credential crosses only TLS off the machine (section 13.4).

15.5. Each `POST /bead` carries one envelope, of type `application/prs.bead`. The transport reads its
layout, kind and call id, in the prefix every layout keeps (section 2), and nothing else:

1. a REQUEST waits for its answer, which comes back in the body of a 200 — a FAILURE too, since a
   failure travels once, in its envelope;
2. any other envelope ends 204 at once, handed on;
3. a REQUEST on the server's own parity is refused, 400; one on a call id already waiting, 409.

Exchanges keep no order between them, so a CANCEL may come before its REQUEST: the server buries
that call id for 5 seconds — what a requester reserves one for when its call was given no time
(section 10.3) — and ends the request that comes under it 204, never handed on.

A client writes the credential a request carries in the `Authorization` field of its `POST`
([RFC 9110 §11.6.2](https://www.rfc-editor.org/rfc/rfc9110#section-11.6.2)), as it is given, and
fails the send before it goes for one that is no field value
([RFC 9110 §5.5](https://www.rfc-editor.org/rfc/rfc9110#section-5.5)): anything but visible ASCII,
spaces and tabs, or a space or a tab first or last, which a field cannot keep. It writes no
`Origin`, on any exchange: a page's browser writes its own, which the server judges (section 15.12).
The server reads that field on a `POST` that carries a REQUEST, and no other exchange's: it hands
the router the field's value with the request, as it came, whole — its auth-scheme included — its
surrounding whitespace removed, and none when the field is empty or absent. Two calls of one
connection may so present two credentials, and a token is renewed without connecting again. A
`POST /bead` that presents a token with more than one `Authorization` field is refused, 400, before
its body is read: the field is no list to combine
([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)). A connect's is read by no
one.

15.6. A refusal of the transport's own has an empty body, and is marked in `bead-refusal`. A client
rejects a send on a marked refusal: nothing was tried. It names the status and the reason in what it
fails with, its connect's and its upgrade's among them, where its platform lets it read the response
([RFC 6455 §4.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.1)); a page's WebSocket reads
none, the [WHATWG WebSockets Standard](https://websockets.spec.whatwg.org/) failing its connection
with no detail, and its server's tell (section 15.1) is then what says why. A client follows no
redirect: a 3xx answered to its connect, to a send or to its upgrade fails it, its status named, as
a page's `fetch` under redirect mode `error` and a page's WebSocket fail
([WHATWG WebSockets Standard](https://websockets.spec.whatwg.org/)); a redirect would carry the
request where its credential and its security were not judged. Any other status that is not 2xx — a
gateway's 502, a proxy's 404 — may come after the request ran: the client counts the exchange lost.

| Status | `bead-refusal`                        | Says                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    |                                       | the request is with the router; its answer is the body — or, to a listen, a batch                                                                                                                                                                                            |
| 201    |                                       | a connection drawn, its token in `bead-connection-token`                                                                                                                                                                                                                     |
| 204    |                                       | handed on, nothing to come back: a cancel, anything but a request, a request held off; a `DELETE` done; a listen that brought nothing; a preflight from an origin the server lists (section 15.12)                                                                           |
| 400    | `malformed`                           | a connect with a body, no token or a malformed one, not an envelope, a request on the server's parity, two `Authorization` fields; a listen without `bead-after`, a count that is none, or a `bead-after` past what was sent; a WebSocket's upgrade malformed (section 15.2) |
| 403    | `host-refused`, `origin-refused`      | a host not among those the server takes, whatever the request at a WebSocket's address; an exchange, or a WebSocket's upgrade, from an origin neither the server's nor among those it takes                                                                                  |
| 404    | `path-unknown`, `connection-unknown`  | not the path; the connection is gone — closed, or its server stopping                                                                                                                                                                                                        |
| 405    | `method-refused`                      | neither `GET`, `POST` nor `DELETE`, which `Allow` names; at a WebSocket's address, neither `GET` nor `HEAD`, which `Allow` names                                                                                                                                             |
| 409    | `call-waiting`, `listen-undeclared`   | a request on a call id already waiting; a listen whose client did not say at connect it listens                                                                                                                                                                              |
| 413    | `too-large`                           | a body past the envelope's limit                                                                                                                                                                                                                                             |
| 415    | `type-refused`                        | not `application/prs.bead`, or encoded                                                                                                                                                                                                                                       |
| 426    | `upgrade-required`, `version-refused` | at a WebSocket's address, a request that asks no WebSocket, `Upgrade: websocket`; an upgrade of a version but 13, or of none, `Sec-WebSocket-Version: 13` beside it                                                                                                          |
| 429    | `busy`                                | too many requests waiting on one connection, or exchanges under way                                                                                                                                                                                                          |
| 503    | `busy`                                | too many connections — all, or one address's — bytes of body being read, or a connect or a WebSocket's upgrade once the server's stop began; `Retry-After`                                                                                                                   |

Every response on the path carries `cache-control: no-store`, `x-content-type-options: nosniff`
and `vary: Origin`, since which one a request gets turns on its `Origin`
([RFC 9110 §12.5.5](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.5)), but what HTTP refuses
of its own (section 15.12), which carries none of them; every refusal of a WebSocket server's own
carries the first two.

A server judges a request at its path in this order, and answers the first that applies. What HTTP
refuses of its own, its HTTP server answers, unmarked (section 15.12); then a host the server does
not take, 403; a path not its own, 404; an origin it does not take, 403; a preflight from an origin
it lists, answered 204 (section 15.12); a method but `GET`, `POST` or `DELETE`, 405. A `POST` that
presents no token connects: no type, or another than `application/prs.bead`, or a body encoded,
415; the connect's own 400; then, once its stop began, or past `maximumConnections` or
`maximumConnectionsPerAddress`, 503. Any other request is judged by its token: none, or one of
another form, 400; once the server's stop began, the 404 marked `connection-unknown`, the token not
looked up; a token it does not hold, the same 404. A `DELETE` then ends its connection. A listen is
refused 409 when its client did not say it listens, then 400 for a body or its counts (section
15.9). A `POST` is refused 415 for its type or its encoding, then 400 for two `Authorization`
fields, 413 for a length it declares past `maximumBodyBytes`, and 429 past what its connection has
under way, each before its body is read; what its body brings is judged as it comes (section 15.5).

15.7. A client's send settles on the head of its answer: a 2xx says the server had the envelope. An
exchange lost — a network that failed, an answer that could not be written, a request unanswered
past the exchange timeout, 5 minutes by default — closes the connection at both ends, as a socket
that drops does; the exchanges it handed on are cut, never answered. So does the 404 marked
`connection-unknown`. A request handed on is never refused: when its connection closes, its exchange
gets its 200 head and is cut, and a cut that overtakes the head on its way leaves the exchange
lost, which its client counts so. A connection with no exchange under way for its inactivity
timeout, 5 minutes by default, closes.

A server that stops closes every connection it holds, as lost: what was under way on each learns it
is gone as this section says. Once its stop began it draws no connection and holds none: a connect
it would take is refused 503, `busy`, its `Retry-After` 1
([RFC 9110 §15.6.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4),
[§10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)), and an exchange it would look up
by a well-formed token is answered the 404 marked `connection-unknown`, nothing of it handed on, in
section 15.6's order. A client MAY wait longer than its reconnection's delay (section 15.10), as a
`Retry-After` asks ([RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)).

15.8. What the server sends of its own — a notification, a request of its own, a cancel, the failure
that ends a subscription — reaches a client that listens. The client says so at connect,
`bead-listen: ?1`, an Item of [RFC 9651](https://www.rfc-editor.org/rfc/rfc9651#section-3.3.6) whose
bare item is a Boolean, its parameters ignored
([§2.3](https://www.rfc-editor.org/rfc/rfc9651#section-2.3)), and the server's 201 says it back when
it takes the listen. It holds for the connection's life. To a client that does not listen, a request
that opens a subscription is refused, `SUBSCRIPTION_UNSUPPORTED`, a request of the server's fails
before it goes, and a relay passes it no request (section 14.3).

15.9. The server numbers each such envelope into the connection's outbox, from 1. A listen, a `GET`
of the connection's path, acknowledges every envelope up to its `bead-after`, which leave the
outbox, and brings back all that is left in a batch of type `application/prs.bead-batch`: each
envelope after its length on 4 bytes, big-endian, the number of the first in `bead-sequence`, the
others following one by one. With nothing left, the server holds the listen up to its `bead-wait`
milliseconds — 30 seconds at most by default — and ends it 204; a second listen takes the first's
place. A `bead-wait` the server reads is its peer's, not an application's (section 1.4).
`bead-after` and `bead-wait` are each an Item whose bare item is an Integer of
[RFC 9651 §3.3.1](https://www.rfc-editor.org/rfc/rfc9651#section-3.3.1), 0 or more, its parameters
ignored ([§2.3](https://www.rfc-editor.org/rfc/rfc9651#section-2.3)), and so is `bead-sequence`, 1
or more. A listen carries its `bead-after`; a `bead-wait` left out is 0. A listen without
`bead-after`, or with a count that does not parse
([§4.2](https://www.rfc-editor.org/rfc/rfc9651#section-4.2), its field lines combined, two among
them), or whose bare item is no Integer of 0 or more
([§2.2](https://www.rfc-editor.org/rfc/rfc9651#section-2.2)), is malformed. A listen's target is
read for its path alone, as every exchange's is, so a listen has the one URL every exchange of its
connection has, which a browser's CORS-preflight cache keys
([Fetch §4.9](https://fetch.spec.whatwg.org/#cors-preflight-cache)). A `bead-wait` of 0 answers at
once, and one past the server's bound is held to it. A client reads a batch as it comes, and hears
each envelope as it comes whole; what a listen lost carried past what was heard comes again to the
next, so nothing is lost and nothing heard twice. A failure that ends a subscription, in a batch,
may come before the result that answered its call, in a `POST`'s body: the client pairs the failure
with the call still waiting, which fails with it (section 9.7), and reports the result that follows
as `CALL_UNKNOWN`. It withdraws no default (section 13.4): a request's own answer comes in its
`POST`'s body alone (section 15.5), so a failure a batch brings for a call still waiting ends a
subscription its server had answered. An outbox past its bound — two envelopes' worth by default —
closes its connection, its client having fallen behind. An envelope that would take its outbox past
that bound is one its transport had all the same, as a notification handed to it counts as sent
(`debugging.md` section 10.1): it is lost with the connection, and a relay whose request is so lost
answers leg A `DESTINATION_LOST` (section 14.5). A batch carries no credential beside its envelopes,
nor does an answer: a command of the server's that presents `ELSEWHERE` over HTTP fails before it
goes, `DESTINATION_UNREACHABLE`.

15.10. A client SHOULD listen from its connect on, asking a `wait` under the server's bound, and
listen again at once once a listen ends. A listen lost is listened again from where it was: at once,
then after 1, 2, 4 seconds and on to 30, each wait drawn between half of it and all of it. Its
inactivity timeout, `inactivityTimeout` (section 15.12), runs from its first loss, on a timer of the
client's, never on a reading of its wall clock: when it ends, it ends the wait under way, and the
listen after it is the last — lost too, the client counts the connection lost. A listen heard ends
the count.

15.11. HTTP carries no transfer: a request's body is in before its answer goes, so no credit could
come back. Both sides of an HTTP connection set `maximumTransfers` to 0, and a payload is what one
envelope holds.

15.12. A server bounds what its clients hold, and times what is under way, by these names; a client
times its own inactivity by `inactivityTimeout`, its default and whether it may be without end
alike (section 15.10):

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
`maximumWait` is never without end.

Past the first four it answers 429 or 503, as section 15.6's table says.

A request names its authority by its target when the target is in absolute-form, the `Host`
beside it ignored ([RFC 9112 §3.2.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2.2)); over
HTTP/2, by its `:authority`, a `host` beside it ignored
([RFC 9113 §8.3.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.3.1)); otherwise by its
`Host`. A request with none names no host. An authority is a host and an optional port, of this
grammar, a restriction of [RFC 3986 §3.2.2](https://www.rfc-editor.org/rfc/rfc3986#section-3.2.2)
([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)):

```abnf
authority = host [ ":" port ]
host      = "[" IPv6address "]" / IPv4address / name
name      = *( unreserved / "!" / "$" / "&" / "'" / "(" / ")" )
port      = 1*DIGIT
```

`IPv6address`, `IPv4address` and `unreserved` are RFC 3986's, and `DIGIT` is RFC 5234's core rule
([Appendix B.1](https://www.rfc-editor.org/rfc/rfc5234#appendix-B.1)). An authority that is not of
it is no host, a userinfo and a colon with no port among them. A target in absolute-form is read
when it is `http://` or `https://`, its scheme in lower case as HTTP servers read it, then an
authority that is not empty
([RFC 9110 §4.2.1](https://www.rfc-editor.org/rfc/rfc9110#section-4.2.1)). A server answers 400, as
HTTP does, an HTTP/1.1 request without a `Host`, and one with more than one `Host` field line, a
target in absolute-form it does not read, or an authority that is no host, before it reads anything
else of it ([RFC 9112 §3.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2)): no refusal of the
transport's own, unmarked. The `Host` beside a target in absolute-form is judged as one field line
alone, which an HTTP/1.0 request may leave out. Over HTTP/2, it resets the stream of a request whose
authority is no host, `PROTOCOL_ERROR`, no response written
([RFC 9113 §8.1.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.1.1)). A field value that holds
a control character other than HTAB, or an octet past US-ASCII, is answered alike, 400 unmarked over
HTTP/1.1, with none of the fields every response on the path carries, as an HTTP server writes its
own before the transport reads the request, and its stream reset over HTTP/2, before anything else
of the request is judged: [RFC 9110 §5.5](https://www.rfc-editor.org/rfc/rfc9110#section-5.5) calls
the first invalid, and keeps the second, historical ISO-8859-1 content, out of every field defined
since; an origin is ASCII ([RFC 6454 §6.2](https://www.rfc-editor.org/rfc/rfc6454#section-6.2)), and
so is every field Bead reads. A field value that starts or ends with a space or a tab is malformed
too ([RFC 9113 §8.2.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.2.1)): over HTTP/2 its
stream is reset `PROTOCOL_ERROR`, judged with the rest of this rule, before anything else of the
request; over HTTP/1.1 and at a WebSocket's address, the parser strips that whitespace first, no
part of the value ([RFC 9110 §5.5](https://www.rfc-editor.org/rfc/rfc9110#section-5.5)). An empty
`Host` is a host, and so is a name of invalid punycode. It takes the hosts a request may name
besides those every server takes, `hosts`, and the origins an exchange may come from besides its
own, `origins`, none when not given. Its own is its request's authority under `http` or `https`,
when its host is one the server takes by name — one every server takes, or one `hosts` lists —
never by `*`: an `Origin` that is `http://` or `https://` followed by that authority, compared ASCII
case-insensitively, the field read as the serialized origin it carries
([RFC 6454 §6.2](https://www.rfc-editor.org/rfc/rfc6454#section-6.2)), never parsed as a URL; a
browser writes both from one URL alike. Any other `Origin` is none of its own, whatever host it
names: `null`, which a browser sends for an opaque origin — a sandboxed frame's, a `file:` or a
`data:` page's — and in place of one it withholds, after a cross-origin redirect or under a referrer
policy; and any other scheme, an extension's or a `blob:` URL's among them. A server never takes
`null`: it is what every page that has no origin of its own sends, a sandboxed frame of any site
among them, so no `origins` names it. A request without an `Origin` comes from no page, and is
taken.

An HTTP server answers the CORS protocol
([Fetch Standard §3.3](https://fetch.spec.whatwg.org/#http-cors-protocol)) to the origins `origins`
names, and to no other. Once a request's origin is taken (section 15.6's order), every response it
writes to a request whose `Origin` `origins` names, whatever its status, carries
`access-control-allow-origin`, that `Origin` as it came, and `access-control-expose-headers: *`; a
refusal judged before the origin carries neither, since a browser reads no answer to a preflight
that is not ok ([Fetch §4.8](https://fetch.spec.whatwg.org/#cors-preflight-fetch)). None carries
`access-control-allow-credentials`: Bead's credential is no cookie but the request's own (section
15.5), so every request to it is one without credentials, for which the Fetch Standard reads `*` as
a wildcard ([§3.3.4](https://fetch.spec.whatwg.org/#http-new-header-syntax)). A preflight is an
`OPTIONS` that carries `Access-Control-Request-Method`: from an origin `origins` names, it is
answered 204, its body empty, with `access-control-allow-methods: GET, POST, DELETE`,
`access-control-allow-headers` naming `authorization`, then the preflight's
`Access-Control-Request-Headers`, its lines joined by ", "
([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)), when it asks any, then `*` —
`authorization` named since no wildcard covers it, the names asked since a browser may cache a name
where it caches no wildcard; no `Vary` names what was asked, since no cache stores an answer to
`OPTIONS` ([RFC 9110 §9.3.7](https://www.rfc-editor.org/rfc/rfc9110#section-9.3.7)) — and
`access-control-max-age: 7200`, whatever method it asks for: the browser judges its request against
them. A preflight is no refusal, draws no connection, and is told by none; any other `OPTIONS` is a
method the server does not take (section 15.6). A page of the server's own origin, its scheme the
server's, needs none; a page of its authority under the other scheme is another origin to its
browser, which the test above takes as the server's own, and is answered CORS only when `origins`
names it. Whether a page reaches a server on the loopback or a private address is its browser's to
judge, by its local network permission, never a field the server writes. A WebSocket server answers
no CORS: no same-origin policy guards an upgrade (section 15.2).

A request's host is its authority's `host`, its port aside, since a browser leaves a scheme's
default port out ([RFC 9110 §4.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-4.2.3)), in the
form the field carries it, an IDN host in its punycode, compared ASCII case-insensitively. Every
server takes `localhost`, a name that ends in `.localhost`, an IPv6 address in brackets and an
`IPv4address`: a page cannot rebind its name to an IP literal, since no name a browser fetches is
written as one, nor to a localhost name where its resolver answers it with the loopback itself, as
[RFC 6761 §6.3](https://www.rfc-editor.org/rfc/rfc6761#section-6.3) asks of resolvers and caching
servers; a user agent that sends one on to a resolver that does not is the residual. `hosts` takes
those it lists besides, each a host without its port, none when it lists none or is not given, and
`*`, alone in it, takes every host, an empty one and none, and makes none of their origins its own.
Any other host, an empty one and none are refused 403, `host-refused` (section 15.6). A server is
refused as it is built a `hosts` entry with a port, an empty one, one that is no host, or `*` beside
another; and an `origins` entry that is `*` or `null`, or not an origin as
[RFC 6454 §6.2](https://www.rfc-editor.org/rfc/rfc6454#section-6.2) serializes it. Since a page
that rebinds its name to the server's address names its own `Host`, `hosts` is what refuses it,
and, under `*`, the origin's test, which takes no origin as the server's own by a host it did not
name: a server a browser reaches by a name names it in `hosts`. A WebSocket server takes both alike
on an upgrade (section 15.2).

A client's address is its socket's, an IPv4 address an IPv6 socket carries mapped read as that IPv4
address ([RFC 4291 §2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2)). A server,
over HTTP or over WebSocket alike, may be told the proxies it trusts, `trustedProxies`, each an IP
address in the form a server listens on, or a network, that address followed by `/` and its
prefix's length ([RFC 4632 §3.1](https://www.rfc-editor.org/rfc/rfc4632#section-3.1),
[RFC 4291 §2.3](https://www.rfc-editor.org/rfc/rfc4291#section-2.3)), from 1, its bits past the
prefix zero; none when not given, the loopback among them. A server is refused as it is built any
other entry: a name, and a network of prefix 0, which would trust what every client writes. It may
be told besides how many proxies on every path to it `trustedProxies` does not name,
`unnamedProxies` — one each for a proxy whose addresses its platform does not publish; a proxy
whose addresses are published is named, never counted — a whole number from 0 to 8, 0 when not
given; any other is refused as it is built, the count of every hop among it. A proxy it names costs
none of the count, whatever the order, so a count is of the proxies it does not name alone: unlike
a count of every hop
([Envoy](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/http/original_ip_detection/xff/v3/xff.proto),
`trust proxy` n), a proxy both named and counted gives the client one entry it wrote. A count is
believed as told: a request that reaches the server by a path with fewer such proxies — straight to
its socket, or past a proxy it counts — brings entries its client wrote where those proxies' would
be, and is read by them, any address the list holds among them passed free; a server so reachable
names its proxies instead. The walk starts at the socket's address. While the address reached is
one `trustedProxies` holds, or one it does not while fewer than `unnamedProxies` such addresses
were passed, which then counts it, the next entry of the request's `X-Forwarded-For` — at a
WebSocket's address, its upgrade's — its lines joined by ", "
([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)) and read from the right, is
the client's, when that entry is an address: an IPv4 address, or an IPv6 address without a zone,
bare, or as [RFC 7239 §6](https://www.rfc-editor.org/rfc/rfc7239#section-6) writes a node unquoted
— an IPv4 address followed by `:` and a port, an IPv6 address in brackets, followed or not by `:`
and a port — its port dropped. Any other entry, a zone, a name or `unknown` among them, or the
field's end, ends the walk. Every address so read is held in one form, for its bound per address,
an HTTP server's, its handle and its refusals: an IPv4-mapped address as that IPv4 address, an IPv6
address in the text [RFC 5952 §4](https://www.rfc-editor.org/rfc/rfc5952#section-4) recommends,
hexadecimal throughout. Its port is the socket's, the nearest proxy's connection's behind one. A
server reads no `Forwarded` ([RFC 7239](https://www.rfc-editor.org/rfc/rfc7239)), which a proxy
that writes `X-Forwarded-For` would pass on as its client wrote it
([§8.1](https://www.rfc-editor.org/rfc/rfc7239#section-8.1)). A proxy it neither names nor counts
is a client as any other: its clients are its address, which its bound per address counts and its
refusals tell. A bound by address counts as one the users behind one NAT, and as many the addresses
of one IPv6 network. A WebSocket server bounds no address: the client's address is what its handle
and its refusals name.

A server listens on `localhost`, both loopbacks — the IPv4 one, `127.0.0.1`
([RFC 6890 §2.2.2](https://www.rfc-editor.org/rfc/rfc6890#section-2.2.2)), and the IPv6 one, `::1`
([RFC 4291 §2.5.3](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.3)), on one port — unless it
is given an address: `localhost`, which names both and is never resolved, as section 13.4 takes
it; or an `IPv4address` or an `IPv6address` of
[RFC 3986 §3.2.2](https://www.rfc-editor.org/rfc/rfc3986#section-3.2.2), bare, with no zone, and
not IPv4-mapped ([RFC 4291 §2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2)),
which it listens on alone; never another name, which another host would resolve otherwise. On
`localhost` it binds `127.0.0.1` first, on the port it is given or on one drawn there, then `::1` on
that port, taking no IPv4 there. A port another socket holds on either family fails its start; a
port drawn is drawn again, eight times at most. Where the IPv6 loopback is absent, its bind refused
for want of the address or of the family, it listens on `127.0.0.1` alone, and reports `127.0.0.1`
as its address in place of `localhost`. A server the network reaches is one its application opened
to it, `0.0.0.0` or `::` among them ([CWE-1327](https://cwe.mitre.org/data/definitions/1327.html)).
Its address keeps the network out, and `hosts` a page on its own machine that rebinds its name to
it; neither stands for the other. A client that connects by `localhost` reaches it on whichever
family it tries first, racing them ([RFC 8305](https://www.rfc-editor.org/rfc/rfc8305)); a server
given one loopback, `127.0.0.1` or `::1`, leaves the other's port to any process that listens
there, which then answers a client that tries that family first.

## 16. Services and procedures

_Identities: `spec/identities.json`._

16.1. A service and its procedures are known by ids and by names. Ids travel: a request names its
procedure by its service id and its procedure id (section 3.1). Names never do: a procedure's name
labels what a side traces and counts, beside its service's id, and is what a debug filter keeps or
leaves out (`debugging.md` sections 4, 6 and 8). This section binds what a side declares: a
resolver registered, a requester made, a notification registered. It changes no envelope: a
reader reads every id section 4 lets it read.

16.2. Each id, and a service's revision, is a whole number of this range:

| What                 | Range              | On the wire                               |
| -------------------- | ------------------ | ----------------------------------------- |
| A service's id       | 1 to 65,535        | in each request, on 2 bytes (section 3.1) |
| A procedure's id     | 1 to 65,535        | in each request, on 2 bytes (section 3.1) |
| A service's revision | 1 to 2,147,483,647 | never                                     |

16.3. Service 0 is the protocol's. No procedure of it is defined, so a side declares none, a writer
writes none (section 4.10), and a request that names it is refused by routing as `SERVICE_UNKNOWN`
(section 4.7). A decision that defines one of its procedures gives this section a table of them,
a row each, and section 4.10 then writes them.

16.4. A procedure's name is 1 to 63 characters of ASCII, in ABNF
([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)), each letter's case given by its range:

```abnf
procedure-name = lower 0*62( lower / upper / DIGIT )
lower          = %x61-7A
upper          = %x41-5A
```

`DIGIT` is RFC 5234's core rule
([Appendix B.1](https://www.rfc-editor.org/rfc/rfc5234#appendix-B.1)).

16.5. A name is read whole, character by character. A character outside these rules is in no name,
whatever a case mapping or a normalization makes of it: U+212A, the Kelvin sign, is no `K`. A line
terminator after a name leaves it no name, though a regular expression's `$` may let one by. So
`_OTHER`, the metrics' fallback (`debugging.md` section 8.3), is no procedure's name, and every
procedure's name is a pattern a debug filter reads (`debugging.md` section 6.1).

16.6. Two names are one when they are equal once each ASCII upper-case letter is read as its
lower-case one, compared character by character, and nothing else changed: `getHTTPStatus` and
`getHttpStatus` are one name; `café` and `cafÉ` are two strings, and no name.

16.7. A side SHOULD declare each address — a service id and a procedure id — under one name,
written the same each time, even where another spelling is one name by section 16.6; each name of a
service at one address, two names one by section 16.6; and each service at one revision, for as
long as it runs. A side that counts its calls MUST refuse a declaration of an address under another
name, or of a name of its service at another address (`debugging.md` section 7.3); one of a service
at another revision counts into its series, which no label tells apart (`debugging.md` section
8.1). A filter's word reaches the procedures of its name in every service (`debugging.md` section
6.5).

16.8. Within a service, an id or a name a release declared SHOULD stay its declaration's in every
later release, or be reserved, and never be declared for another: so a peer built against an earlier
release never calls an id that now means another procedure, and within a service a name never comes
to count another procedure. Between two releases of the definitions a builder generates a side from,
the builder's `beadc breaking` holds it, against the last release that carries them; nothing holds
it across definitions, nor on a side written by hand.

16.9. A service's revision counts the releases of its contract, from 1, and does not travel. It
SHOULD move once in a release whose contract differs from the release before, however much moved,
and never back; `beadc breaking` refuses one lowered, or left where the contract moved
(section 16.8). A side holds 0 for a procedure it knows no revision of, a relay's leg B
(section 14.2), and declares none at 0.

16.10. A side MUST refuse a declaration as it is made, never on a call, for the first of these
reasons that applies, before any reason of its own; a declaration refused declares nothing:

| Reason             | A declaration that names                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `out of its range` | a service id, a procedure id or a revision outside 16.2, service 0 (16.3), or one that is no whole number |
| `off its form`     | a procedure's name that is no `procedure-name` (16.4, 16.5)                                               |
| `against its kind` | a procedure whose kind the way it is declared does not take (16.11)                                       |

A side's sentences are its own; a C side reports a code. A side built without the trace and the
metrics (`debugging.md` section 1.2), which keeps no names, never refuses `off its form`, its names
those of the definitions its tables were generated from.

16.11. A procedure's definition may name its kind, how it is called: `request`, a request a client
makes of its server; `notifies`, such a request to a procedure that notifies, which may open a
subscription to it (section 11.2); or `command`, a request a server makes of a client (section
9.1). A procedure's kind is never its envelopes': every call opens with a `REQUEST` (sections 3.1,
9.1), a command's too; and the trace types a call to a procedure that notifies `request`
(`debugging.md` section 4.1). A requester made on a client's router takes `request` and
`notifies`, and one made on a server's takes `command`; a resolver registered on a server's router
takes `request` where it notifies nothing, and `notifies` where it notifies; one registered on a
client's router takes `command`; and a notification registered on a client's router takes
`notifies`. Every way takes a procedure whose definition names no kind.

## 17. Payloads

_Codecs: `spec/codecs.json`._

17.1. A payload is bytes to the envelope (section 6.1), and its procedure reads them: a procedure's
request, its result and its notifications are each of one encoding, which the procedure's definition
names and no envelope carries. This section states four, `raw`, `text`, `json` and `proto`. A side
reads a payload once it is whole (section 12.6), before its resolver or its caller sees it, and
writes one as its encoding says. A relay reads none (section 14.2).

17.2. A payload that does not read, or a value that does not write, fails where it is:

1. a request's payload is answered with `PAYLOAD_UNDECODABLE`, and its resolver never sees it
   (section 9.5);
2. a result's payload fails its call at the requester with `PAYLOAD_UNDECODABLE`;
3. a notification's payload is reported as `PAYLOAD_UNDECODABLE`, and no callback hears it;
4. a request's value fails its call before anything goes out, and no call is made;
5. an answer's value fails as a resolver that fails: the request is answered with
   `PROCEDURE_FAILED`, and the failure reported (section 9.5);
6. a notification's value goes to none of its subscriptions, and the failure is reported.

A writer MUST NOT write what a reader refuses, as section 4.10 has it of an envelope.

17.3. `raw`: the payload is its bytes, any of them, none included, read and written as they are.

17.4. `text`: the payload is a string in UTF-8 (RFC 3629), none included.

1. A reader MUST refuse bytes that are not UTF-8 — a byte no sequence takes, an overlong form, a
   surrogate's code point, a sequence cut short — where section 7.3 reads a detail's as U+FFFD.
2. A reader MUST keep a leading U+FEFF as a character of the string, never strip it as a signature
   (RFC 3629 §6), as section 7.3 keeps a detail's.
3. A writer MUST refuse a string holding a surrogate alone, where section 7.4 writes a detail's as
   U+FFFD.

17.5. `json`: the payload is one JSON text ([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)) in
UTF-8, read as an I-JSON message ([RFC 7493](https://www.rfc-editor.org/rfc/rfc7493)) is read, but
for its noncharacters (section 17.6), and written in the canonical form of the JSON Canonicalization
Scheme ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)), so that one value has one form,
whichever side writes it. Its value may be of any kind, an object, an array, a string, a number or a
literal. A reader MUST refuse:

1. bytes that are not UTF-8 (section 17.4.1);
2. a byte order mark, which RFC 8259 §8.1 lets a parser ignore;
3. bytes that are not one JSON text: none, two values, a comment, a trailing comma, `NaN`, a leading
   zero, or white space other than space, tab, line feed and carriage return;
4. an object that names a member twice, its names compared once their escapes are read (RFC 7493
   §2.3);
5. a name or a string holding a surrogate alone, which only an escape writes (RFC 7493 §2.1);
6. a number that rounds past the largest finite double, as `1E400` does;
7. an array or an object nested deeper than 64, the outermost at depth 1, as RFC 8259 §9 lets a
   parser bound it. A reader MUST refuse it before it builds anything deeper.

17.6. A reader reads a number as the IEEE 754 double nearest it, a tie to the even, as ECMAScript's
`JSON.parse` does: digits past a double's are rounded, an integer past 2⁵³ − 1 might not stay exact,
and a number whose magnitude is 2⁻¹⁰⁷⁵ or less, half the smallest positive double, 2⁻¹⁰⁷⁴,
reads as 0. A value that needs more travels as a string, as RFC 7493 §2.2 recommends. A reader
takes a noncharacter, which RFC 7493 §2.1 refuses and Unicode's Corrigendum #9 lets be
interchanged. What it hands its application is the value of the payload's canonical form
(section 17.7): `1.0` and `1` are one value, and `12345678901234567890` is `12345678901234567000`.

17.7. A writer writes a value's canonical form (RFC 8785 §3.2), and nothing else:

1. no white space between tokens;
2. `null`, `true` and `false`;
3. a string between quotation marks, each character as it is, but `"` and `\` written `\"` and
   `\\`; U+0008, U+0009, U+000A, U+000C and U+000D written `\b`, `\t`, `\n`, `\f`
   and `\r`; and the rest of U+0000 to U+001F written `\u` and four lower-case hexadecimal
   digits;
4. a number as ECMAScript's Number::toString writes its double, −0 as `0`;
5. an array's elements in their order;
6. an object's members sorted by their names, compared as sequences of UTF-16 code units, at every
   depth;
7. the whole in UTF-8.

A writer MUST refuse a value no reader takes: a number that is not finite, a name or a string holding
a surrogate alone, an object that names a member twice, an array or an object nested deeper than 64,
and anything else JSON has no value for, a language's own — JavaScript's `undefined`, a function, a
`BigInt` — among them.

17.8. A value a side writes reads back to the value of its canonical form, as section 17.6 reads it,
and a payload read and written again is its canonical form: an echo answers
`{ "b" : "Jos\u00e9", "a" : 1.0 }` with `{"a":1,"b":"José"}`:

```text
7B 22 61 22 3A 31 2C 22 62 22 3A 22 4A 6F 73 C3 A9 22 7D
```

17.9. `proto`: the payload is a protobuf message in protobuf's binary wire format, its message the
one the procedure's definition names. What that format takes, refuses and writes is protobuf's, as
its [Encoding](https://protobuf.dev/programming-guides/encoding/) guide and its
[Language Guide](https://protobuf.dev/programming-guides/proto3/) state it; this section restates
none of it, and a side reads and writes through its stock protobuf library and the code its
generator writes for the message. What is Bead's:

1. Bytes that are no encoding of the message do not read (section 17.2).
2. An empty payload is the message with no field set.
3. A reader MUST refuse a message nested more than 100 deep below the top one, a group and a map's
   entry each counting as a message, as a map's entry is one on the wire
   ([Encoding](https://protobuf.dev/programming-guides/encoding/), "Maps"), and sets that bound in
   its library rather than leaving it to the library's default.
4. A string's leading U+FEFF is a character of it (section 17.4.2).
5. A field the message declares, at a wire type its type does not take, does not read (section
   17.2), a map's entry's key and value among them, where protobuf's reference parsers keep it as
   an unknown field: one stock library reads it as its declared type, which may take a record past
   its message, so every side refuses it. A repeated scalar of a numeric type takes its own wire
   type and the length-delimited, packed or not
   ([Encoding](https://protobuf.dev/programming-guides/encoding/), "Packed Repeated Fields").
6. A map's entry with a field other than its key and its value does not read (section 17.2), where
   protobuf's reference parsers skip it: one stock library reads such an entry apart, so every side
   refuses it.

Where two stock libraries part on what protobuf states no rule of, the support matrix says what
each does. The `proto` rows of `spec/codecs.json` read and write `Probe`, the message of
`spec/codecs.proto`.
