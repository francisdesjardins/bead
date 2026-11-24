# 0056 — A WebSocket server holds a message partway to a budget and a rate, and every side reads its frames at their heads

- **Status**: accepted
- **Scope**: the protocol, and every side's WebSocket transports, server and client: in
  [`spec/spec.md`](../../spec/spec.md), 15.3's judgement of a frame at its head, its
  `maximumMessageFrames`, its 1009, 1008 and 1002, and the close that follows a failure; 15.12's
  rows `minimumBodyBytesPerSecond` and `bodyGracePeriod` over WebSocket, its row
  `messageBytesBudget`, and its paragraph on a message partway; the transports' cases of a frame
  judged at its head, a message's frames, its rate, its budget and its cast-off, the frame's
  `length` and the gauge `messageBytes` they take, and the place
  `webSocketTransportServer.bodyGracePeriod` of `spec/durations.json`; each side's frame meter, its
  budget, its rate and its close after a verdict; and the differential fuzz target
  `websocket-frames`. The rate's names and a body's rule, and what a side holds of a peer otherwise,
  are [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s; a connection paused by what its
  router has not taken
  [0046](0046-a-router-paces-each-connections-reads-by-what-it-has-not-taken.md)'s; the clock a
  side runs on [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)'s; one word for
  one thing [0003](0003-one-word-one-meaning.md)'s; one behaviour on every side
  [0004](0004-one-behaviour-in-every-language.md)'s and one surface
  [0047](0047-every-side-shows-one-public-surface.md)'s; the Rust side's lints
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)'s.

## Context

**A message partway holds a server's memory and its time.** Spec 15.3 bounds a message by
`maximumMessageBytes`, and its heartbeat drops a peer that sends nothing. A peer that sends a
fragment within each heartbeat is never pinged, since each head is a read, and holds its message
partway for as long as it likes. What each side's platform keeps of it, measured on Windows 11 with
a heartbeat of 2 s:

- **`ws` 8.23.0**, the TypeScript side's reader, keeps each fragment as a view of the read it came
  in until its message is whole (`receiver.js:140`, `:537`), each view an object of about 114 bytes
  of heap. Four connections that sent 240-byte fragments, each read filled with unsolicited pongs,
  held +256.7 MiB for 0.92 MiB of payload; the pongs alone, +7.9 MiB. One connection of 16,001
  writes held +999.7 MiB. A read pins only what came: four connections of 4,000 one-byte
  fragments, one a read and no pong, left `arrayBuffers` at 0.3 MiB.
- **tungstenite 0.30**, the Rust side's reader, reserves the length a head announces once the head
  passes its bound (`frame/mod.rs:189-191`): 50 heads alone held +802 MiB. It judges a
  continuation's head alone, so a continuation that takes its message past `maximumMessageBytes`
  draws no 1009, and 20 fragmented messages of 16 MiB held +965 MiB.
- **.NET 10's `ManagedWebSocket`** reads the C# side's frames, and the side judges a message only
  once its bytes pass its bound, never at a head, copying each read into the message under way: the
  same 20 messages held about 1 GiB. Its keep-alive counts a read only once `min(16 KiB, the rest of the
  frame)` came (`ManagedWebSocket.cs:931-940`).
- **A writer that doubles keeps its largest message**: a message sent fast, then nothing, left the
  Rust side holding its size and the C# side up to twice it.

**The standards and the practice.**
[RFC 6455 §10.4](https://www.rfc-editor.org/rfc/rfc6455#section-10.4): an implementation MUST
protect itself against "a single big frame" and "a long stream of small frames that are a part of a
fragmented message", and SHOULD limit a frame's size and a message's; it names no time and no
count. [§5.2](https://www.rfc-editor.org/rfc/rfc6455#section-5.2),
[§5.4](https://www.rfc-editor.org/rfc/rfc6455#section-5.4) and
[§5.5](https://www.rfc-editor.org/rfc/rfc6455#section-5.5) give a frame's grammar, and §5.4 lets an
intermediary split or coalesce frames when no extension is negotiated.
[§7.1.7](https://www.rfc-editor.org/rfc/rfc6455#section-7.1.7): an endpoint that fails a
connection SHOULD send a Close frame and MUST NOT continue to attempt to process data, "including a
responding Close frame"; §7.1.2's closing handshake, which reads the peer's close, is the other
road. [§7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1): 1002 for a protocol error,
1009 for a message too big, and 1008 for a policy, the code "when there is no other more suitable
status code".
[IANA's WebSocket Close Code Number Registry](https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number)
registers 1013, "Try Again Later": `ws` takes it, tungstenite names it `CloseCode::Again`, and
.NET 10 sends it, its `ValidateCloseStatus` refusing 0 to 999, 1006 and 1015 alone. Kestrel's
`MinRequestBodyDataRate`, 240 bytes a second past 5 s, is the practice 0033 follows for a body; it
holds no upgraded stream. Redis's client eviction, `maxmemory-clients`, "first attempts to
disconnect clients that use the most memory. It disconnects the minimal number of clients needed to
return below the maxmemory-clients threshold."
[RFC 7541 §4.1](https://www.rfc-editor.org/rfc/rfc7541#section-4.1) counts a header table's entry
as its octets and 32 more, and
[RFC 9113 §6.5.2](https://www.rfc-editor.org/rfc/rfc9113#section-6.5.2) a header list alike: a
fixed amount for each item beyond its bytes.

**The options weighed.**

- **A budget that pauses** a connection past it, as 0046 pauses one, is a hold and wait: paused
  holders keep their charge while they wait on a budget only another frees, and the heartbeat drops
  them all. 0046's release never waits on the peer.
- **A budget that refuses the newcomer**, as HTTP's 503 and a broker's CLOSE of 4000 do: sixteen
  connections that hold 16 MiB each at a rate the rule allows deny every other message for 19.4
  hours, and over a WebSocket a refusal costs the whole connection.
- **Casting off the slowest**, by the rate's own measure: no practice holds it. A message within
  its grace is measured over its grace, so one under 1,200 bytes falls below 240 bytes a second,
  and every small honest message goes before an attacker's holders that keep 240.
- **The most first, behind a step that casts off a message past its grace first.** It spares an
  honest message that ends within its grace; defeating it costs the budget's charge every 5 s, 12.0
  to 13.9 MB, 2.4 to 2.8 MB a second, a home link's; it follows no practice. Refused, on the user's
  word.
- **A share of the budget for each address**: 15.12 counts an address whole, so an IPv6 /64
  spreads across many.
- **A charge of payload alone** leaves `ws`'s pinned reads outside the budget, about 1 GiB a
  connection.
- **A charge of bytes alone**: a one-byte frame charges 7, where `ws` keeps those 7 and about 114 of
  heap. 268,435,456 / 7 is about 38 million fragments, some 4.6 GB, which about 2,340 connections
  reach at the frame cap. **32 a frame**, RFC 7541's number, leaves `ws` about three times its
  charge, 121 kept against 39 charged, some 0.8 GB at the budget.
- **A frame cap fixed in the spec, or a "Leveled down" row**: `ws`'s cap is an option Bead sets, so
  the bound is Bead's own, named as `maximumMessageBytes` is, which a case sets small.
- **A meter as a listener prepended to `ws`'s**: Node's `emit` calls a copy of its listeners, so a
  listener prepended cannot keep the read under way from `ws`, measured.
- **Reading on to the peer's Close after a verdict**, §7.1.2's road: `ws` and tungstenite assemble
  what they parse, which costs memory, and §7.1.7 forbids it after a failure.
- **`bodyBytesBudget` for a WebSocket's messages**: 0003 gives each transport its own words, and a
  WebSocket has messages, not bodies.
- **A C# receive buffer sized to `minimumBodyBytesPerSecond` × `heartbeat`**: the rate is
  cumulative, so a frame whose bytes come fast and then one a heartbeat keeps it, and .NET drops it
  whatever its buffer.
- **A wait asked of a client on 1013**, as a `Retry-After`: neither the registry nor RFC 6455 gives
  1013 more than its name.
- **Writers that grow by less than doubling**: the C# side's could; tungstenite's `Vec` is out of
  the Rust side's reach.
- **A budget or a rate on a client**: a client holds one connection, which it chose, and
  `maximumMessageBytes` bounds its message; a page's `WebSocket` could hold neither.

## Decision

### Every side reads its frames at their heads

Each connection has a **frame meter**, on a server and on a client. It is fed every raw read of the
upgraded socket before the platform's reader sees it, parses each frame's head as RFC 6455 §5.2
lays it out, 2 to 14 bytes that may be split across reads, and never unmasks a payload. It knows
the message under way: its first byte's time, its payload's bytes, its frames and the sum of the
lengths their heads announce. Each verdict is judged at the byte that draws it (spec 15.3):

- **1009**, at a head whose length takes its message's announced total past
  `maximumMessageBytes`, a continuation's among them, without waiting for its payload;
- **1008**, at the head of the frame that takes its message past `maximumMessageFrames`, 16,384
  by default and never without end, every frame counting, empty or not, the first among them, and
  a control frame not;
- **1002**, at a head that breaks §5.2, §5.4 or §5.5: a reserved bit set, since no extension is
  negotiated (spec 15.2); an opcode of 3 to 7 or 11 to 15; a control frame not final or longer than
  125; a continuation with no message under way; a data frame other than a continuation while a
  message is under way; a 64-bit length with its top bit set; and an unmasked frame on a server, a
  masked one on a client. A data frame's length not in its minimal form is taken, as `ws`, .NET and
  tungstenite take it. A control frame's is judged in its 7 bits, as `ws` judges it, so one whose
  length takes a longer form fails with 1002 whatever its value: §5.2 asks the minimal form, and
  every side refuses it alike.

**A verdict takes effect at its byte.** What a read brings before the head that draws it is read as
it would be, so a message whole ahead of that head in the same read is handed on; nothing from that
head on reaches the platform's reader. A verdict that comes from outside, a cast-off or the rate's
timer, takes effect at once, and what the side holds unhanded is dropped, as on any failure. A
frame's head is charged once whole, so a head that draws a verdict charges nothing, and what came
before it is charged first, a cast-off at an earlier byte winning. A verdict behind a message the
router paused on takes effect once that message is read, and what the pause holds is dropped.

**Each side reads below its platform.** The TypeScript server takes `ws`'s `data` listener at the
connection and owns the only one: it feeds the meter, then calls `ws`'s listener with the bytes
before any cut. The TypeScript client takes no meter: `ws` gives 1009 at a head, by its running
total (`receiver.js:440`), and 1002 and its failing close, and is given `maximumMessageFrames` as
`maxFragments`. `ws` counts that bound as a frame ends, and reads a 64-bit length with its top bit
set as one it does not take, 1009, so the TypeScript client fails both later than at the head, or
with another code. The C# and Rust clients take the meter, since their streams are their servers'.
A page's `WebSocket` and Node's global one fail a message as their platform does. The Rust side
splits a data frame past 64 KiB into frames of 64 KiB at most before tungstenite reads it, as §5.4
lets an intermediary, so a head reserves 64 KiB at most; the C# side gathers a message of several
reads in a buffer rented from the shared pool and gives it back once the message is whole. The C#
side's gate reads its socket into a buffer of its
own of 64 KiB, rented once bytes are there, and charges all that read brought at once, as the
TypeScript side charges a read and the Rust side a region. Below a paused connection's gate,
Kestrel's socket transport reads 64 KiB more at most, its `MaxReadBufferSize`, which nothing
charges; once that socket ended while paused, what the gate reads is dropped unmetered. Each side
holds the meter to its platform's reader with a differential fuzz target, `websocket-frames`: the
same bytes fed to both agree on each frame's bounds, on each message's end, and on whether the
stream fails and at which frame.

### A budget bounds the memory

A WebSocket server holds every message partway to **`messageBytesBudget`**, 268,435,456 by default
as `bodyBytesBudget` and `heldBytesBudget` are, across its connections: 15.12's last row, so that
no unit is renumbered. It is charged as bytes come, never as a head announces them, from the first
byte of a message's first head to the last byte of its last frame: each byte of payload as it is
read, the control frames' between its frames among them, and each head, its mask included, once
whole, its bytes and **128 more**.
128 is what the TypeScript side keeps for a fragment, about 114 bytes of object and its bytes; no
standard gives the number, as RFC 7541 gives its 32 for an entry of its own. A message's charge is
released once it is whole, or at once at its connection's verdict, whatever the verdict, and a
connection with a verdict charges nothing after it. A whole message a paused side holds is
charged nothing: 0046's `maximumUntakenBytes` bounds it. The gauge is `messageBytes`.

**A charge that would pass the budget casts off holders**, judged byte by byte:

1. What a server reads of a message partway is charged as it comes. Each payload byte is charged as
   it is read, a control frame's between the message's frames among them. Each frame's head, a
   control frame's included, is charged once it is whole: its bytes and 128 more, at its last byte.
   Nothing is charged of what a head announces.
2. A charge of _n_ decides as _n_ charges of one. Each one goes to the room left. When there is
   none, the order is judged for that one unit: the connection whose message holds the most, the
   asking one's sum counting that unit, then, among equal sums, the one whose message began first.
   The one that comes first is cast off with 1013 and its charge released at once; the asking
   connection is cast off only when it comes first. Then the next unit is judged.
3. So a message whose charge alone passes the budget casts off each holder that comes before it,
   then its own connection.
4. A head that draws a verdict is never whole, so nothing of its frame is charged (15.3: "nothing
   from that frame on is" read). Every byte a read brought before that frame is charged first, so a
   cast-off at an earlier byte wins over the verdict: the connection fails with 1013, not 1002.
5. A message's begin is its first frame's head's first byte, though that head charges nothing until
   whole. A holder with nothing charged is in no order.

The order is Redis's client eviction, `maxmemory-clients`: the clients that use the most memory
first, and the fewest needed. The asking connection is cast off only when it comes first. A message
whose charge alone passes the budget casts off each holder before it, then its own connection,
which can happen only where the budget is below one message's charge.

At a matched bandwidth, an attacker that fills the budget with _K_ holders of _B_ / _K_ each casts
off every honest message larger than that once it outgrows them; eight addresses of 64 connections
set that size at 512 KiB. One-byte fragments fill the budget's charge with 13.9 MB on the wire. Each
holder then grows 376 bytes a second at its rate, so the most first casts off one of the attacker's
own holders every 2.7 s, each refilled with 27.2 kB: holding the budget costs about 0.14 MB a
second.

A charge decides by the unit, so for a connection that reads, the same bytes cast off the same
connection however the peer cuts them, as `spec/generators/make_transports.py`'s `arriving` asserts
at every cut. A paused connection is charged what its read before the pause brought, its
platform's.

### A rate bounds the time

A message is held to `minimumBodyBytesPerSecond` once `bodyGracePeriod` passed since its first
byte, 15.12's body rule on the server's clock (0011), so a conformance case steps it. _R_ is the
payload a message has brought; its heads, masks and control frames count for nothing. A message
that brought _R_ bytes and none more by its first byte plus max(`bodyGracePeriod`, ⌈_R_ × 1,000 /
`minimumBodyBytesPerSecond`⌉) milliseconds fails its connection with 1008. Time is not counted
while the server reads nothing of the connection because its router paused it (0046); the C# side
reads a message partway to its end while paused, so its clock runs then, under the same rule. The
grace is a place of `spec/durations.json`, `webSocketTransportServer.bodyGracePeriod`
([0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)).

### The close after a verdict

Every verdict, a 1009, a 1008, a 1013 or a 1002, closes as RFC 6455 §7.1.7 fails a connection,
which 15.3 cites for its 1009. The side sends its close with the verdict's code, ends its writing
where its platform lets it, as `ws` does after its own failures and as the Rust side's
`Closing::Failing` does, and reads on, dropping what comes unparsed, the peer's close among it,
until the peer ends its stream or the close timeout passes. The close is unclean, and the verdict is
reported naming the bound and its value. It is the close in stages
[RFC 9112 §9.6](https://www.rfc-editor.org/rfc/rfc9112#section-9.6) describes over HTTP; and since
the side ends its writing at once, a peer that waits for the server to close TCP first
([§7.1.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.1.1)) is not held to the close timeout.

### Clients

A client holds the 1009 at a head, the frame cap, the 1002 and the close, where its platform lets
it, and no budget and no rate.

## Consequences

- **What a side holds above its charge** is outside the budget: a buffer that grows by doubling
  holds up to twice what it was charged. 15.12 says so, and the matrix's row `What a WebSocket
  message's frame costs a side beyond its bytes`.
- **The one read a message's first head shares** with what came before it escapes the charge, 64
  KiB at most on the TypeScript side.
- **A single slow frame on the C# side**: it keeps its receive buffer of 16 KiB, and .NET's
  keep-alive counts a read only once `min(16 KiB, the rest of the frame)` came, so a single frame
  slower than that each heartbeat is pinged, cannot answer within its frame, and is dropped at two
  to two and a half heartbeats, 546 bytes a second at the defaults, where the TypeScript and Rust
  sides hold it. The rate is cumulative, so no buffer size closes it: a platform row of the matrix,
  `A single WebSocket frame read slower than its heartbeat`.
- **`ws` fails with 1008 a frame whose payload waits on more than 262,144 reads**, its
  `maxBufferedChunks`; the C# and Rust sides have no such bound: a platform row, by reading.
- **The TypeScript client** fails the frame past `maximumMessageFrames` once its payload came, and
  a 64-bit length with its top bit set with 1009: an open row of the matrix, `The frame a WebSocket
  client fails at its head`, which a meter below `ws` on the client closes.
- **The C# side ends its writing only with its connection**: Kestrel's upgraded connection, and
  the stream .NET hands its client, end their writing only as they close. Its peer reads its close,
  then its end at the peer's own end or the close timeout: a platform row, `The end of a WebSocket
  side's writing once a verdict failed it`.
- **`maximumMessageFrames` bounds one connection's fragments**, not those across connections; the
  128 a frame does.
- **A connection cast off with 1013** reconnects as after any unclean close.
- **15.20's envelope in parts and a WebSocket's message in fragments** are held alike, each to a
  budget and a rate of its transport's; their cast-off alone differs.
- **Ahead**, by a decision of its own that meets the Tenth Man: the HTTP transport's
  `bodyBytesBudget` and a broker's `heldBytesBudget`, which refuse the newcomer, brought to this
  record's cast-off, the most first.
- **Its gates**: `spec/transports.json`'s cases over WebSocket, each named by its first words — a
  frame whose head would take its message past the side's own limit, a message of
  `maximumMessageFrames` frames, a message that comes slower than `minimumBodyBytesPerSecond`, a
  message's grace that grows with its payload, the charges that would pass `messageBytesBudget` (the
  connection whose message holds the most, a write's frames together, a message that alone passes
  it, and a charge ahead of a forbidden head), pongs between a message's frames, and a frame that
  breaks RFC 6455 — and `spec/durations.json`'s place, played by every side; `spec/units.txt`'s
  15.3, 15.12, 15.12.15, 15.12.16 and 15.12.19; the twins, on every side, held by
  `tools/check-twins.mjs`, the C# side's own test a row of `tools/twins.tsv`; and the differential
  fuzz target `websocket-frames` on every side ([0006](0006-a-rule-has-its-gate.md)).

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
two rounds at xhigh effort. In the first, each claim was checked against `ws`, .NET and tungstenite
and against probes of each side. Seven objections: six accepted, two of them carried further, and
one in part, none refused. One choice no standard settles: 128 a frame, over 32 and over none. The
cast-off order is Redis's, the most first. The second round, on the byte grain, the judged head, the
paused read and the cast-off order, is shared with
[0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md),
[0054](0054-a-client-connects-the-loopbacks-names-to-the-loopback-itself-through-no-resolver-and-no-proxy.md)
and [0055](0055-beadcs-image-is-published-at-each-release-under-its-version-attested-and-signed.md),
each of which keeps its own objections. Each claim was checked against each side's code and against
a model of the charge played at every cut of each write. Four objections here, each accepted. No
question went to the user, whose word had already removed the step that cast off a message past
its grace first. The objections, with the answers that hold:

### On a message held partway

| Objection                                                                                                                                                                                                                                                                                                                                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The budget does not bound the TypeScript side's memory. `ws` keeps each fragment as a view of the read it came in. A peer that puts one small fragment in each read, and fills the rest with unsolicited pongs, has `ws` hold every byte while the draft charges payload alone: about 1 GiB a connection at 16,384 frames, and about 68 such connections within the budget.       | **Accepted, and carried further.** Verified: `receiver.js:140` returns a view of the read and `:537` keeps it until the message's last frame; four connections held +256.7 MiB for 0.92 MiB of payload, one +999.7 MiB, where the Rust and C# sides copy. The budget charges every byte read from a message's first head to the end of its last frame, control frames among them; the rate counts payload alone. A case shows a pong between fragments charged, and the twin `charges a message partway every byte its frames bring and 128 a frame, pongs between them among it, never what a head announces` holds it on every side. A read pins only what came, so this charge bounds the pinned reads, all but the one read a message's first head shares with what came before, 64 KiB at most. What remains is the object kept for each fragment, about 114 bytes against 7 charged, some 4.6 GB at the budget; so each frame is charged 128 more at its head, as RFC 7541 §4.1 charges an entry a fixed amount. The matrix's row becomes `What a WebSocket message's frame costs a side beyond its bytes`. |
| Failing the newcomer turns the budget into a denial of the whole service from one address. Sixteen connections holding 16 MiB each, at a legal rate, hold the budget for 19.4 hours. A WebSocket refusal costs the whole connection, unlike HTTP's 503. Cast off the holders that hold the most, as few as needed, as Redis does.                                                 | **Accepted, and carried further.** Verified: Redis's text; 19.4 hours is 16 × 16,777,000 bytes at 240 a second within 268,435,456. A charge that would pass the budget casts off holders, its own holder's sum counted, each with 1013, its charge released at once: the one that holds the most first, and among equal sums the earliest message, so the order is one, the newcomer going only when it comes first, as Redis does. A step that cast off a message past its grace first was weighed and refused: it follows no practice, and the budget sent again every 5 s, 2.4 to 2.8 MB a second, defeats it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| On the TypeScript side, the meter judges after `ws` has handed the message on, since Bead's raw listener is added after `ws`'s. Add it with `prependListener`, fail on any head the meter does not take whole, and add a differential fuzz target on each side.                                                                                                                   | **In part.** Verified: `websocket-server.js:434`, `:453` and `websocket.js:274`, with `allowSynchronousEvents` at `true`, hand a message on at once. The requirement is accepted: the meter judges each read before `ws` parses it, and nothing more is handed on after a verdict. The mechanism is refused: Node's `emit` calls a copy of its listeners, so a listener prepended to `ws`'s cannot keep the read under way from `ws`, measured. Bead takes `ws`'s listener at the connection instead and owns the only `data` listener, feeding the meter, then `ws`'s listener with the bytes before any cut. A message whole ahead of the frame that draws a verdict, in the same read, is handed on, and nothing from that frame on is: a socket of the case `a frame whose head would take its message past the side’s own limit…`, and a twin. A head the meter does not take fails with 1002, the code its platform gives, at once. The differential fuzz targets are accepted, `websocket-frames` on every side.                                                                                           |
| The proposal keeps charging a failed connection until its close timeout ends it, since `ws` assembles on after a close Bead starts: a connection cast off frees nothing for 5 s. From a verdict on, a side should hand on and charge nothing more, and release the charge then. The record must choose its citation: §7.1.7, which forbids processing after a failure, or §7.1.2. | **Accepted.** Verified: `websocket.js:1244-1257` and `:323-360`; RFC 6455 §7.1.7 and §7.1.2. A charge is released at its connection's verdict, whatever the verdict, and nothing after it is charged or handed on. The record takes §7.1.7, which 15.3 cites for its 1009: the side sends its close, ends its writing where its platform lets it, and drops what comes, unparsed, until the peer ends or the close timeout passes, as `ws` does after its own failures and the Rust side's `Closing::Failing` does; RFC 9112 §9.6's close in stages. The FIN at once answers the dissenter's question: a peer that waits on the server's end of TCP (§7.1.1) is not held to the close timeout.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The 16,384-frame cap is no "Leveled down" row. `ws`'s `maxFragments` is an option, its `Receiver` holding none by default, so Bead chooses the bound. Its job is the TypeScript side's cost for each fragment, and its lifting condition misstates what it waits on.                                                                                                              | **Accepted.** Verified: `receiver.js:45`, `:62` and `:512`; `websocket-server.js:48`, `:75`; `websocket.js:672`, `:698`; and that `ws` keeps nothing of an empty frame (`receiver.js:531`). The cap is a limit 15.3 names, `maximumMessageFrames`, 16,384 by default and never without end, as `maximumMessageBytes` is named; `ws` is given it as `maxFragments` on its server and its client, and a case sets it to 4. The cost for each fragment is a row of the matrix's differences, and no row is "Leveled down". The cap does not bound fragments across connections; the 128 a frame of the first row's answer does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bodyBytesBudget` and its gauge `bodyBytes`, reused, give "body" a WebSocket meaning, against 0003. Each budget pairs with its transport's unit: name it `messageBytesBudget`, its gauge `messageBytes`.                                                                                                                                                                          | **Accepted.** Verified: 0003; 15.12's rows `bodyBytesBudget` and `maximumBodyBytes`; 15.23's `heldBytesBudget`. The budget is `messageBytesBudget`, "the bytes a WebSocket server holds of messages partway, across its connections", 15.12's last row, 15.12.19, so no unit is renumbered; its gauge is `messageBytes`. `messageBytes` names an AMQP 1.0 message's every byte in `spec/vectors.json` (15.37): both mean a message's bytes, each in its transport's place, as `maximumMessageBytes` stands beside AMQP's `maximumMessageSize`; 0003 lets an owner's word stand where its owner sits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The sentence "keeps nothing of a message once it is whole but what it handed on" speaks of memory, which no case observes, and what is handed on may itself hold its read. "1009 before any of that frame's payload is read" cannot be promised, since a head and its payload share a read.                                                                                       | **Accepted.** Verified: `receiver.js:140`, `buffer-util.js:19`, and tungstenite's `frame/mod.rs:200`, `split_to`. The sentence leaves the spec. The C# side's pooled buffer and the Rust split stay, each held by a unit test of its side, a row of `tools/twins.tsv`: `Gives_back_to_its_pool_the_buffer_of_a_message_of_several_reads_once_it_is_whole_renting_none_for_one_read` and `splits_a_data_frame_past_64_kib_into_frames_of_64_kib_at_most_each_masked_by_its_key_turned_by_its_offset`. The 1009 comes "at its head, without waiting for its payload".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### On the byte grain, the judged head, the paused read and the cast-off order

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The proposal charges every byte before the verdict's, on the ground that only that rule gives one outcome however reads cut a write. A third rule does too: a frame's head charged once whole, its bytes and 128 at its last byte, so a head that draws a verdict charges nothing. It keeps 15.3's "nothing from that frame on is", where charging every byte lets the judged head's first byte turn a 1002 into a 1013, and the Rust side's verdict arm stays as it is.                                                | **Accepted, its cost corrected.** Verified by the model of the charge played at every cut: the head once whole gives one outcome at each, a socket that charges 500 exactly before a ping whose head draws a 1002 failing with 1002, and keeps every other scenario's outcome. It is taken: it keeps 15.3 and RFC 6455 §7.1.7, and needs no exception in 15.3. The cost claim does not hold: the Rust side charges a partial head at a region's end and its verdict arm skips the region's earlier bytes, and the TypeScript side charges each byte of a head as it is read, so every side moves under either rule. The case's socket `edge` expects 1002.                                                    |
| The proposal both bounds Kestrel's pipe and adds a metered buffer of 64 KiB, neither run. The buffer leaves 64 KiB uncharged in the pipe, costs 64 KiB for each of 10,000 connections, and the C# side's close of a verdict behind a pause rests on it unsaid: without it, a verdict behind a second message past the 125 bytes .NET reads of a head still waits for the resume. The line on HTTP/2 is moot. Choose openly: keep the buffer with what it owes, or bound the pipe alone, with two rows of "Differences". | **Accepted.** Verified: the C# server listens with no TLS and no protocols, so Kestrel serves it HTTP/1.1 alone; each connection holds a buffer of 16 KiB, up to `MaximumConnections`, 10,000; a verdict behind a paused message waits for the resume. The buffer is kept, since it closes both differences, as parity asks of a difference that can close. It is rented from `ArrayPool<byte>.Shared` once bytes are there and returned once drained, so a connection waiting on its peer holds none. A paused C# connection then holds 128 KiB at most, half of it uncharged, which the matrix states. The test of a verdict behind a pause plays a second message past 125 bytes. The line on HTTP/2 goes. |
| "The same bytes cast off the same connection on every side" holds only for a connection that reads: a paused one is charged what its read before the pause brought, which differs by platform and by when its bytes arrived. The matrix's row and the page read as if the cast-off went byte by byte whatever the pause.                                                                                                                                                                                                | **Accepted.** Verified: a paused message's charge, measured, moves with its platform's read and with when its bytes came. This record, 15.12 and the changelog state the condition: for a connection that reads, a write's cut never chooses whom. The matrix's row reads "charged byte by byte, a frame's head once whole; holders cast off with 1013, the most first".                                                                                                                                                                                                                                                                                                                                      |
| "No order judged by bytes alone does better" is a ranking nothing tested: the same order judged by address would spare a ninth address up to 32 MiB. The cost of holding the budget stops short: each holder grows 376 bytes a second, so the most first casts off the attacker's own holders every 2.72 s, none reaches the frame cap, and holding the budget costs 0.137 MB a second.                                                                                                                                 | **Accepted.** Verified by the arithmetic, played out. This record states the cost, 13.9 MB to fill the budget, then about 0.14 MB a second, and no ranking of orders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
