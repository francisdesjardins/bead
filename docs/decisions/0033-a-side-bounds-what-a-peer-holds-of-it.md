# 0033 — A side bounds what a peer holds of it: the calls it answers on a connection, a request's bytes, a WebSocket server's connections, what waits for a socket, and a request that trickles

- **Status**: accepted
- **Scope**: the protocol, every implementation's routers and server transports: in
  [`spec/spec.md`](../../spec/spec.md), 9.1's requester held to the calls its peer answers, 9.2's
  step 3, 12.2's request held to `chunkBytes` and its `maximumAnsweringCalls`, 15.2's step 8, the
  pace and the bound beside 15.3's heartbeat, 15.6's 408 and 503, 15.7's answer that could not be
  written, 15.9's outbox reported, and 15.12's bounds, the transports each holds on, its pace and
  its head and body; in [`spec/debugging.md`](../../spec/debugging.md), 9.4's call past those its
  connection has it answer and 9.6's requester; the conversations of 9.2's step 3, the transports'
  cases of a WebSocket server's connections, a body's rate and a head's time, and the durations of
  the bounds it adds. The heartbeat is 15.3's own; the client's address a bound per address reads,
  [0030](0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md)'s; the 503
  a stop answers,
  [0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)'s;
  HTTP's draw of a connection and its outbox,
  [0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)'s; an access refused,
  told, [0034](0034-a-server-tells-each-access-it-refuses-never-the-credential.md)'s.

## Context

**A peer that holds a side costs it memory, sockets and time.** Measured with each side's servers as
the interop builds them, on Windows 11, Node 26.5.0 with `ws` 8.22.0 and .NET 10.0.402: 300
upgrades from `127.0.0.1` taken and held, on each side; 2,000 calls to `slow`, 32 KiB each, held on
one WebSocket, the working set from 67 to 268 MiB on the TypeScript side and from 72 to 210 MiB on
the C# side, an `echo` after them answered; 120 results of 512 KiB to a client whose socket stops
reading, 59 MiB in `bufferedAmount` on the TypeScript side, the C# side's working set from 48 to
346 MiB; a head that never ends answered 408 at 60.0 s by Node, its `headersTimeout` checked every
30 s, and at 31.2 s by Kestrel; a body a byte a second held to Node's `requestTimeout`, 300 s, and
failed at 6 s by Kestrel's `MinRequestBodyDataRate`, an abort that names no bound of Bead's.

**The heartbeat already drops a reader that stops**: its ping waits behind the backlog and goes
unanswered. Paused 75 s, the client is closed by both servers before it resumes, within two beats on
the TypeScript side, by `KeepAliveTimeout` on the C# side. What it leaves unbounded is the bytes
held within a beat, and everything where the heartbeat is never.

**A byte bound judged at once drops an honest reader.** 100 results of 1 MiB, the answers to calls a
peer may hold, fill `bufferedAmount` with 102,761,428 bytes in one turn and are read whole in 97 ms;
a cap of twice `maximumEnvelopeBytes`, 33,556,480, the HTTP outbox's, drops that client at the 35th.
**A reset erases an early answer**: a 408 written while its client still sends, its socket
destroyed once the end is written, reaches `node:http` as `ECONNRESET` 5 times in 5, and `fetch` 19
in 20; left to Node's own close on `connection: close`, it is read 5 in 5, and 20 in 20.

**The standards and the practice.**
[RFC 9113 §5.1.2](https://www.rfc-editor.org/rfc/rfc9113#section-5.1.2): an endpoint limits the
streams its peer opens at once, counting those open or half-closed, and "Endpoints MUST NOT exceed
the limit set by their peer"; a stream past it is refused, `REFUSED_STREAM`, which
[§8.7](https://www.rfc-editor.org/rfc/rfc9113#section-8.7) makes say that no application
processing occurred; its bytes are bounded apart, a frame by `SETTINGS_MAX_FRAME_SIZE`, what is in
flight by flow control. [RFC 9000 §4.6](https://www.rfc-editor.org/rfc/rfc9000#section-4.6)'s
`MAX_STREAMS` alike. Kestrel and Apache httpd take 100 streams, nginx 128; gRPC has
`MaxConcurrentStreams`, SignalR `MaximumParallelInvocationsPerClient`. A slow reader is judged by
its progress: Kestrel's `MinResponseDataRate`, 240 bytes a second past a grace of 5 s, gives each
write the time its bytes take at that rate, and IIS's `minBytesPerSecond` alike; a depth mark only
signals a writer, Netty's `WriteBufferWaterMark` and SignalR's `TransportMaxBufferSize`, and Bead's
routers hand an envelope and go on (`debugging.md` 10.1).
[RFC 6455 §7.1.7](https://www.rfc-editor.org/rfc/rfc6455#section-7.1.7): an endpoint that fails a
connection SHOULD log the problem, and a close frame waits behind what its peer does not read. A
head and a body are timed: Kestrel's and IIS's 30 s for a head, 240 bytes a second past 5 s for a
body; Apache's `mod_reqtimeout`; Node's `headersTimeout`, which slowloris brought (CVE-2018-12122);
nginx's `client_body_timeout` judges the time between two reads, which a byte a minute defeats. [RFC
9110 §15.5.9](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.9) answers 408 with the `close`
option, and [RFC 9112 §9.6](https://www.rfc-editor.org/rfc/rfc9112#section-9.6) has a server that
closes while its client may still send close its write side first, reading on, since a reset can
erase an answer not yet read: Apache httpd's lingering close reads on for 2 seconds.

**The options weighed.** Announcing the bound on the calls, as `SETTINGS` does, needs a place on
every transport — the 101, HTTP's 201, a first message on a Web Worker, which has no handshake — or
a kind of its own, which changes the wire's identity
([0001](0001-the-envelope-sits-at-fixed-offsets.md)), and it would be the first limit announced. A
constant no application sets fits neither a relay's leg B, which carries many requesters' calls on
one connection ([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)), nor a
constrained side that holds a few. A bound on the bytes of the calls being answered, as HTTP/2's
connection window, is a second accounting beside the transfers' budget. A whole request's time cuts
an honest large body on a slow link — Node's 300 s cuts 16 MiB under 56 KB/s — and no practice
cited holds one. A depth bound alone on a socket drops an honest burst.

## Decision

**The calls a connection has its side answer at once are a limit of the protocol's**,
`maximumAnsweringCalls`, `MaximumAnsweringCalls`, 64 (spec 12.2), set alike at both ends and
announced by nothing, as every limit of 12.2 is, so a requester knows its peer's number: its own.
Both of HTTP/2's halves hold. **A requester holds its calls waiting on a connection to it**, failing
one past it before it goes, `CAPACITY_EXCEEDED`, drawing no call id, as it fails a call with no call
id free (spec 9.1). **A receiver answers a request past it `CAPACITY_EXCEEDED`** at 9.2's step 3:
after steps 1 and 2, which must stay first since a request on the receiver's parity or on a call id
open is never answered, and before its route, its credential's resolution and a transfer's first
credit, so nothing of it is held. Its refusal stays for a peer that does not keep the rule, or whose
count runs ahead of the receiver's: over HTTP, a request that overtakes the cancel of an earlier
call (spec 15.1, 15.5). A relay's leg B is a requester as any other, so a refusal past its number is
the relay's own (spec 14.5), never the destination's. A call counts from the turn its request opens
it until its answer is wholly sent — a whole answer handed to its transport, a result's transfer by
its last chunk — its cancel comes or its connection closes, its credential resolving and its
transfer coming among it, as HTTP/2 counts a half-closed stream. A subscription once answered, a
call id reserved and a call abandoned take no place, which 11.3, 11.10 and 12.9 bound: counting a
subscription would cap a client's subscriptions at 64 and block its calls behind them. The name is
the set both sides gauge, `answeringCalls`; "open" is not its word, since 9.2's step 2 calls a held
subscription's call id open. Each side gauges `largestAnsweringCalls`, its busiest connection's,
under its ceiling, beside the sum, as `largestOutboxBytes` stands beside `outboxBytes`.

**Its default is 64**, Bead's number for "so many at once from one peer", HTTP's
`maximumWaitingExchanges` and 13.9's `maximumWaitingCalls`. An HTTP server's
`maximumWaitingExchanges` follows its router's `maximumAnsweringCalls`, as its `maximumBodyBytes`
follows `maximumEnvelopeBytes`: one number for one thing, so an honest HTTP client, holding itself
to 64, never meets the transport's 429, which comes first at the same count. RFC 9113 §6.5.2's "no
smaller than 100" advises a number announced to a peer that then never passes it. A requester's
queue past the number, as an HTTP/2 client queues streams, would make each call's timeout count a
wait it cannot see.

**A request, whole or an opening, is held to `chunkBytes`** (spec 12.2), the measure of what 12.1
has an honest requester send whole, answered `ENVELOPE_TOO_LARGE` at 9.6's gate before anything of
it is held, as `SETTINGS_MAX_FRAME_SIZE` bounds a frame. Any other envelope keeps
`maximumEnvelopeBytes`: a result answers the receiver's own call, and a notification and a failure
go whole whatever their size. HTTP, whose `chunkBytes` is its `maximumEnvelopeBytes`, takes what it
took. What Bead itself holds of a connection's calls is then bounded in bytes: over a WebSocket or a
Web Worker, 64 × 1 MiB = 64 MiB at the defaults while their credentials resolve and before they are
dispatched, and the transfers' share of `bufferedBytesBudget`, 256 MiB for the side; over HTTP, the
bodies `bodyBytesBudget` bounds.

**A WebSocket server bounds its connections by an HTTP server's two bounds**,
`maximumConnections`, 10,000, and `maximumConnectionsPerAddress`, 64, the client's address read as
15.12 reads it, judged at 15.2's step 8 beside its stop: an upgrade past them is refused 503 `busy`,
its `Retry-After` 1, marked and told, before its 101
([RFC 9110 §15.6.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4),
[RFC 6455 §4.2.2](https://www.rfc-editor.org/rfc/rfc6455#section-4.2.2)). An upgrade takes its
place as it is judged — under a lock of its own on the C# side, in the one turn Node runs the
judgement, the upgrade and `connection` in on the TypeScript side — and gives it back as its
connection closes or its handshake fails, so upgrades that cross take no more places than are left.
An HTTP server's and a WebSocket server's are counted apart, each by its own server. Node's
`maxConnections`, which drops a socket without a word, is not used.

**What waits for a server's socket is held to a pace**, Kestrel's rule, on every server's answers: a
WebSocket's every envelope, an HTTP exchange's answer, a listen's batch. Each envelope of _S_ bytes
handed moves its connection's deadline to the later of now plus max(`sendGracePeriod`,
_S_ / `minimumSendBytesPerSecond`) and the deadline before plus _S_ / `minimumSendBytesPerSecond`;
checked each second while anything waits, a socket that holds something past its deadline drops its
connection, over HTTP its exchange lost, a `POST`'s answer and a listen's batch alike, which closes
the connection at both ends (spec 15.7). Kestrel's numbers, 240 bytes a second past 5 s,
give a burst of 100 MiB days and a reader stopped behind a small backlog its grace. **At a
WebSocket's address a bound besides**, `maximumUnsentBytes`, above what a peer that keeps every rule
can be owed at once — the answers to the calls it has answered and the server's own commands to it,
`maximumAnsweringCalls` × `chunkBytes` each, the transfers it receives, `maximumTransfers` ×
`windowBytes`, and two envelopes of the server's own, as an HTTP outbox holds: 2 × 64 × 1,048,576 +
4 × 4,194,304 + 2 × 16,778,240 = 184,551,424 at the defaults, the WebSocket facades deriving it from
their router's limits as they derive the message limit. An envelope that would take what waits past
it drops the connection. The heartbeat stays as 15.3 has it, the judge of a reader stopped behind a
large backlog, whose allowance at the pace runs long; the pace and the bound stand beside it, since
the heartbeat is the platform's ping, .NET's `KeepAliveTimeout` on the C# side, which Bead cannot
make finer, and may be never. **Each drop is reported**, naming its connection and its bound, on the
transport's `error` before its `close`, so an operator tells it from a network that failed (RFC 6455
§7.1.7), and an HTTP outbox's overflow alike; a WebSocket so dropped closes with no closing
handshake, unclean, since a peer that does not read would read no close frame waiting behind its
backlog. The three run on the platform's clock, as the heartbeat does, since each bounds what the
platform's socket does ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)'s
exception). The C# HTTP transport sets Kestrel's `MinResponseDataRate` to none, Bead's rule in its
place: Kestrel's would abort unreported, its bound unnamed.

**A head is held to `headersTimeout`, 30 s**, never without end, on both transports' servers, by the
platform's parser, which alone sees a head before it is whole: its 408 is HTTP's own, unmarked and
told by none, and comes past its time and within 2 seconds of it, on the platform's clock. The
TypeScript transport sets `headersTimeout`, `requestTimeout` 0 and `connectionsCheckingInterval`
1,000 on every server it listens on, its WebSocket server's own and each one an application's
`createServer` builds, before the `listen` it calls itself, so Node's 408 comes at its check each
second, within a second of its time: 2,051 ms for a `headersTimeout` of 2,000 with the interval set,
30,013 ms without. The C# transports set Kestrel's `RequestHeadersTimeout`, whose deadline
`TimeoutControl.AssignTimeout` sets a heartbeat past its time and `CheckForTimeout` meets on the
first heartbeat after it, each second: a connection's first head is answered 1 to 2 seconds past its
time, a kept connection's 0 to 2. That timing is the platform's, a row of the Differences: the
heartbeat is internal, a timeout shortened by a heartbeat would refuse a kept connection's head up
to a second early, and a timer of the transport's own would parse the head this record leaves to the
platform's parser. **A body is held to `minimumBodyBytesPerSecond`, 240, past `bodyGracePeriod`,
5 s**, never without end, Bead's own, on the server's clock
([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)), alike on both sides: one that
brought _R_ bytes and none more by its head's reading plus max(`bodyGracePeriod`,
⌈_R_ × 1,000 / `minimumBodyBytesPerSecond`⌉) ms is refused 408 `too-slow`, marked and told as a 413
counted as it comes is
([0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)), its
Bead connection kept. A trickle charges `bodyBytesBudget` as it comes, never as declared. Kestrel's
`MinRequestBodyDataRate` is set to none and Node's `requestTimeout` to 0, Bead's rate in their
place. **Every answer written before its body is whole closes its socket in stages** — the 408, a
413, a 503 of the budget, the 404 `connection-unknown` — `connection: close`, its write side first,
reading on and dropping what comes until the client closes or 2 seconds pass, never by a reset, so
its client reads the answer and its Bead connection stands.

## Consequences

**What a dispatched call holds is the application's**: 64 × `maximumPayloadBytes`, 1 GiB at the
defaults, over every transport, as an HTTP/2 server's application holds what it read of its streams;
a procedure that takes large payloads sets its own limit (spec 12.2).

**A relay deployment raises `maximumAnsweringCalls` at both ends of leg B**, its client's and its
destination's, the destination's raise reaching every connection it takes.

**A WebSocket server behind a proxy names it**, `trustedProxies` or `unnamedProxies`, as an HTTP
server does: behind one it neither names nor counts, every client is the proxy's address, and the
65th is refused 503, which `largestAddressConnections` warns of on `/health` at 80% of its ceiling.
The bound counts the users behind one NAT as one and an IPv6 network's addresses as many, on both
transports alike.

**What every socket holds together is 10,000 × 176 MiB at most.** Within a beat, a reader stopped
behind a large burst holds its backlog until the heartbeat drops it; where the heartbeat is never,
the bound alone holds it. A body at exactly 240 bytes a second holds its socket and its place as
long as it keeps the rate, as Kestrel's, IIS's and Apache's rules let it; the bound per address
bounds how many. A client's own queue toward a server that stops reading is its application's. Over
HTTP/2, a head is HEADERS and CONTINUATION frames, which nghttp2 and Kestrel bound their own way,
and no test holds.

**Ahead, each by a decision of its own that meets the Tenth Man**: a bound on the payload bytes of
the calls a connection has answered, as HTTP/2's connection window; a raise of
`maximumAnsweringCalls` for one trusted connection; a requester's queue past it; a budget of what
waits for every socket together, as `bodyBytesBudget` is for bodies; and 0030's fit of the bound per
address, an IPv6 client keyed by its prefix and a value fit for a NAT, landing for both transports
at once.

**The gate.** `spec/conversations.json`, played by both sides: a request past the calls its
connection has its side answer refused while the others go on, and one taken once a call ends; a
cancel freeing its place at once; a call whose credential resolves, and a result going as a transfer
until its last chunk, holding theirs; a subscription once answered holding none; the refusal before
the route, the credential and a transfer's credit; a request on a call id open reported first; the
server's commands past the bound failing before they go, and going once one is answered; and a
request past `chunkBytes` refused, nothing of it held, its generator holding every other
conversation's requests within their `chunkBytes`. `spec/transports.json`: a WebSocket server's
connections, in all and behind a proxy it names, refused 503 and told, its origin judged first; a
body slower than its rate refused 408, its socket's end read and its Bead connection answering
after; and a head that does not come whole answered 408 at either transport, on the real clock, its
`after` 100 ms short of its time and its `within` 4 seconds past it. `spec/durations.json`:
`sendGracePeriod`, `headersTimeout` and `bodyGracePeriod`, each refused for never;
`spec/metrics.json`, the exit of a request past the bound. Twins by the same sentence
([0004](0004-one-behaviour-in-every-language.md)) hold what no runner plays: each router's `answers
CAPACITY_EXCEEDED a request past the calls its peer has it answer on its connection, before its
route, its credential or its transfer, and takes one once a call ends` and `answers
ENVELOPE_TOO_LARGE a request that came whole past chunkBytes, and holds nothing of it`, its
requester's `fails before it goes a call past the calls its peer answers at once, and sends one once
a call is answered`, its client's `answers CAPACITY_EXCEEDED a command past the calls its server has
it answer`, its limits' `refuses a maximumAnsweringCalls that is not a whole number above 0`, and
`gauges largestAnsweringCalls under its ceiling maximumAnsweringCalls, which health warns at`; each
WebSocket server's `bounds its connections, and those of one address, refusing an upgrade past them
503 busy before its 101, with Retry-After, and takes one once a connection closes`, `takes no more
upgrades than its places when they cross` and `refuses a maximumConnections or a
maximumConnectionsPerAddress that is not a whole number above 0`; the pace and the bound, `keeps a
client that reads through a burst of answers to the calls it has it answer, each of chunkBytes`,
`drops a client that stops reading once its socket holds what waits for it past its deadline, and
reports it`, `drops a client once what waits for it would pass maximumUnsentBytes, the bytes it
holds never past them, its close unclean, and reports it`, each HTTP server's `loses an answer whose
client reads slower than minimumSendBytesPerSecond, its connection closed at both ends, and reports
it` and `reports an outbox that passes maximumOutboxBytes as it closes its connection`, and the
relay's `answers leg A DESTINATION_LOST when its leg B over WebSocket is dropped behind its socket`;
the head and the body, `refuses 408 too-slow a body that comes slower than its rate once its grace
passed, its client reading the 408 as it goes on sending, and keeps its connection; a body at its
rate taken`, `closes in stages every answer written before its body is whole, so a client that sends
at full speed reads it, and its connection then answers a POST`, `answers 408 a head that does not
come whole within headersTimeout, at its address and its WebSocket’s, past it and within 2 seconds
of it`, and the TypeScript side's `sets headersTimeout, no requestTimeout and a
connectionsCheckingInterval of a second on every server createServer builds, its 408 within a second
of its time`, beside the C# side's
`Sets_its_HeadersTimeout_and_no_body_rate_of_Kestrel_s_on_every_listener`, so a change of the
platform's fails a test. `docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at
xhigh effort, in one round with
[0034](0034-a-server-tells-each-access-it-refuses-never-the-credential.md)'s, whose rows on an
access refused that record keeps. It met ten objections on the bounds, each claim checked against
the code and against probes of its own, rerun where an answer reads a number: six accepted, four in
part, none refused. The user decided what no standard settles: the bound on the calls is 9.2's
third step, before the route; the bounds are this record's, an access refused 0034's; 0030's fit of
the bound per address stays ahead, its own round, for both transports at once; and a head's 408
comes past its time and within 2 seconds of it, its cases held to a floor. Each objection, with the
answer that holds:

### On the bounds against a peer that holds a side

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A byte bound judged instantly, `maximumOutboxBytes` at twice `maximumEnvelopeBytes`, drops a client that reads at full speed: 100 answers of 1 MiB fill 102,761,428 bytes in one turn and drain in under 100 ms, while the bound on the calls, drafted at 100, lets a peer hold 100 calls; "as the HTTP server does" is a false analogy, HTTP's outbox holding only the server's own sends. Judge progress, as Kestrel's `MinResponseDataRate` does, keep a backstop above what an honest peer is owed, tell the drop, and play an honest burst.                                                                                                                                                                                                      | Accepted. Rerun: 102,761,428 bytes at the end of the turn, the 35th send past the cap, all read in 97 ms. What waits for a socket is held to `minimumSendBytesPerSecond`, 240, past `sendGracePeriod`, 5 s, by Kestrel's own rule, on every server's answers, the HTTP servers' among them, which closes the difference of a slow reader's answers between the sides; `maximumUnsentBytes`, 184,551,424 by default, above what a peer that keeps every rule can be owed, is a backstop. HTTP's outbox keeps its name and its bound; the WebSocket's is another thing and takes another name. Each drop is reported, its bound named (RFC 6455 §7.1.7). A twin keeps a reader through a burst of answers to every call it may hold.                        |
| The draft's "never closed" comes from a 25 s run: both servers drop a client that stops reading by the heartbeat, before 75 s, so what is unbounded is the bytes within that window, and everything where the heartbeat is never. Correct what is said of a reader that stops; build the stall rule as the heartbeat's own judgement, made finer.                                                                                                                                                                                                                                                                                                                                                                                                     | In part. The finding is right and corrects the measures: a reader that stops is bounded in time by the heartbeat, unbounded in bytes within a beat, without end where the heartbeat is never. The pace is not built into the heartbeat: the heartbeat is the platform's ping — .NET's `KeepAliveTimeout` on the C# side, which Bead cannot make finer — and may be never; the pace and the backstop stand beside it, each on the platform's clock, and the heartbeat stays as 15.3 has it, the judge of a reader stopped behind a large backlog.                                                                                                                                                                                                          |
| A TypeScript 408 whose socket is destroyed while the client still sends is lost to a reset: the client counts the exchange lost and its Bead connection closes at both ends, against "the connection kept". RFC 9112 §9.6 has a server close its write side first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Accepted. Rerun: destroyed, `ECONNRESET` 5 of 5; left to Node's own close, 408 read 5 of 5. Every answer written before its body is whole, on both sides, writes `connection: close` and closes in stages, reading on for up to 2 seconds (RFC 9112 §9.6, Apache httpd's lingering close), never a destroy; 15.12 says so; twins on both sides play a client sending at full speed that reads the 408 and whose connection then answers a `POST`. The TypeScript 404 `connection-unknown` is aligned on it.                                                                                                                                                                                                                                               |
| A count bounds no bytes, yet stands as the whole bound on the calls a peer holds open, while what a connection's calls hold is memory: 1.6 GiB a connection. HTTP/2 pairs its count with flow control. A receiver takes a whole request of 16 MiB that no honest requester sends. Hold a whole request to `chunkBytes`, or bound a connection's payload bytes.                                                                                                                                                                                                                                                                                                                                                                                        | In part. A request, whole or an opening, is held to `chunkBytes`, 12.1's own measure, answered `ENVELOPE_TOO_LARGE` at 9.6's gate before anything of it is held, as `SETTINGS_MAX_FRAME_SIZE` bounds a frame; HTTP loses nothing, its `chunkBytes` being `maximumEnvelopeBytes`. What Bead holds of a connection's calls is then 64 MiB plus the transfers' budget: the count and `chunkBytes` bound together the calls a peer holds open. The figure "back to 100 MiB" does not hold: a payload that came as a transfer is the resolver's once whole, up to 64 × 16 MiB, as an HTTP/2 server's application holds what it read of its streams; the record states it, a procedure's limit narrows it, and a per-connection byte bound on it is kept ahead. |
| A requester that does not hold itself to the bound breaks honest peers: 12.2 sets limits alike at both ends, so the requester knows the number, and HTTP/2's peers MUST NOT exceed it. Nothing retries a refused call, and a relay's leg B pays first, its refusal passed to leg A as the destination's. Hold the requester to it; put a queue to the user; weigh a raise for one trusted connection.                                                                                                                                                                                                                                                                                                                                                 | In part. A requester holds its calls on a connection to its own `maximumAnsweringCalls` and fails one past it before it goes, `CAPACITY_EXCEEDED`, as 9.1 fails a call with no call id free, so a relay's refusal on leg B is its own (14.5). Queuing is kept ahead, not put to the user: 9.1 already fails, and a queue would have a call's timeout count a wait it cannot see. A raise for one connection is kept ahead: 12.2's limits are a router's, and a relay deployment sets the number at both ends of leg B.                                                                                                                                                                                                                                    |
| "Open" contradicts 9.2's step 2, which calls a held subscription open; `largestOpenCalls` doubles the gauge `answeringCalls`; and "handed to its transport" frees a result's transfer at its opening. Name it `maximumAnsweringCalls`, and end the count at the transfer's last chunk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | In part. The bound is `maximumAnsweringCalls`, `MaximumAnsweringCalls`, after the set both sides gauge; its count ends when its answer is wholly sent, the last chunk of a result's transfer among it, as the code keeps it (`router/shared/router-core.ts`), with a conversation for a result transfer. The gauge is not a double: `answeringCalls` sums every connection, and the bound is a connection's, so the busiest connection's count stands beside the sum as `largestOutboxBytes` stands beside `outboxBytes`, renamed `largestAnsweringCalls`.                                                                                                                                                                                                |
| The WebSocket server's bound per address breaks every proxied WebSocket server and is filed as Added: the 65th client behind a proxy with no `trustedProxies` is refused 503, the failure 0030 measured over HTTP; and 0030 keeps the bound's fit for a NAT and an IPv6 network ahead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Accepted. It is a change, not an addition: a proxied WebSocket server needs `trustedProxies` or `unnamedProxies`, as the READMEs' WebSocket setup and the matrix say, its health warning at 80% of its busiest address. 0030's fit stays ahead for both transports at once, as the user decided.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The TypeScript HTTP server's 408 need not come 30 s late: `connectionsCheckingInterval`, set as a property before `listen`, governs it, and the transport calls `listen` itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Accepted. Rerun: 408 at 2,051 ms with it set. The transport sets it to 1,000 on every server it listens on, beside `headersTimeout` and `requestTimeout`; a twin holds the 408 within a second of its time on a server the application's `createServer` built, so a change of Node's, which documents it as a constructor option, fails a test. No platform row.                                                                                                                                                                                                                                                                                                                                                                                          |
| Raising `maximumWaitingExchanges` from 64 to 100 loosens HTTP's bound in a round meant to tighten — 8,192 sockets an address become 12,800 — and RFC 9113 §6.5.2's 100 is advice for an announced number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Accepted. `maximumAnsweringCalls` is 64, as `maximumWaitingExchanges` and 13.9's `maximumWaitingCalls` are; HTTP's bound does not move, and an honest HTTP client, holding itself to 64, never meets the 429.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A head's 408 case holds `within` 3,000 ms for a `headersTimeout` of 1,000, which is Kestrel's latest by construction: `AssignTimeout` sets the deadline at the connection's last timestamp plus the timeout plus a heartbeat, and `CheckForTimeout` fires on the first heartbeat past it, so a head that comes before its connection's first heartbeat is answered between 2,000 and 3,000 ms after the connect, then a hop of the thread pool; the case fails on any machine, at the rate its overhead passes a second, and failed once in two runs of the Linux replay. 15.12's "within a second of its time" says what Kestrel never does there, the C# twin allows 500 ms over the same maximum, the number is bare, and the case holds no floor. | Accepted, as the user decided. 15.12 says a head's 408 comes past its time and within 2 seconds of it, on the platform's clock: Node's at its check each second, Kestrel's 1 to 2 seconds past it on a connection's first head, a platform row of the Differences, as the C# transports' own comments say. Each case's `within` is its `headersTimeout` plus those 2 seconds plus 2 for the real clock, 5,000 ms, and its `after`, its `headersTimeout` less 100 ms, holds the floor; the twins, `… past it and within 2 seconds of it`, hold the C# side to both. A runner that misses a `within` tells when the response came, or that it never did. Kestrel's timing stays the platform's, its heartbeat internal, as the decision says.               |

### On a 1009 and what a transport's `error` tells

What a side does with a message past its `maximumMessageBytes` (15.3), and what a transport's
`error` reports (15.1), met the Tenth Man at xhigh effort in two rounds of their own. The servers'
came first: eight objections, all accepted, one of them by what it keeps ahead.

| Objection                                                                                                                                                                                                                                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The C# server tells its close clean when the peer answers its 1009 with 1000: it reads `CloseStatus`, the peer's code, and `Closes_with_1009_a_message_past_its_bound` answers 1000 and hides it, where the TypeScript side, whose `ws` reads nothing past its error, tells 1006. | Accepted. A connection a server ends of its own — failed with 1009, dropped behind a bound, or aborted past its close timeout — closes unclean on both sides, whatever the peer answers; the test, `Fails_with_1009_a_message_past_its_bound_…`, answers 1000 and holds the close unclean, beside its twin over a socket of its own. A peer's close with no status code stays a platform row of `docs/support.md`: .NET reads it as 1000, `ws` as 1005.                                                                                                                                                                                                             |
| The C# server raises two errors where `ws` emits one: its own abort past `CloseTimeout` throws `OperationCanceledException` into the pending read, and a read error after the 1009 or after a drop is told besides.                                                               | Accepted. The C# side tells at most one `Error` a connection, from one place, once its read ended: its own abort past the close timeout, a read error after its 1009 or its drop, and its heartbeat's drop, which reaches the read as Kestrel's `ConnectionAbortedException`, tell none, as on the TypeScript side. Twins hold one error for a 1009 peer that never answers, and none for a close that times out or a peer its heartbeat drops.                                                                                                                                                                                                                     |
| Reporting before the close lets a listener that throws stop it: both sides report a drop before its abort, and an `Error?.Invoke` in the C# read before its close would escape the read's catch, its 1009 never sent.                                                             | Accepted. Each side reports a connection's error once its close or its drop began — the TypeScript side as its socket closes, the C# side as its read ends — and tells its close in a `finally`, so a listener's throw, its platform's, keeps nothing open (spec 15.1); a twin closes with 1009, and drops behind `maximumUnsentBytes`, a connection whose `error` listener throws.                                                                                                                                                                                                                                                                                 |
| The TypeScript 1009 names no bound — `ws`'s `RangeError`, `Max payload size exceeded` — and the drops' reports differ: `the client fell behind: …` with its value on one side, `… is dropped behind its MaximumUnsentBytes`, no value, on the other.                              | Accepted. Both sides write one shape: the handle, what this side did, then the bound in the spec's spelling and its value — `… is closed with 1009: a message past its maximumMessageBytes, N bytes`; `… is dropped: what waits for its socket would pass maximumUnsentBytes, N bytes`, or `was not taken by its deadline, at minimumSendBytesPerSecond N past sendGracePeriod M ms`. The TypeScript side's are `GenericError`s, the 1009's keeping `ws`'s error as its `cause`; the C# side's 1009 is an `InvalidDataException`, as SignalR reports a message past its own bound, its drop an `IOException`, its socket aborted. The twins compare the text whole. |
| `error` is the wrong channel: a 1009 is how the connection ended, which its `close` should tell.                                                                                                                                                                                  | Accepted, as it stands: the report stays on `error`, since `close` carries a boolean alone and a 1009 must be told from a peer gone. Carrying the close code on `close` (RFC 6455 §7.1.5, §7.4.1) is ahead, by a round of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A 1009 is no closing handshake: RFC 6455 §7.1.7 has a side fail the connection and process nothing more of it, the peer's close among it; yet the TypeScript side waits `ws`'s own 30 s on a peer that never answers, and the C# side its `CloseTimeout`.                         | Accepted. 15.3 says a side fails the connection with 1009 (RFC 6455 §7.1.7, §7.4.1, §10.4): it drains until the peer's close or its close timeout, its close unclean whatever code the peer answers with. The TypeScript side gives `ws` its `closeTimeout`, an option since ws 8.22, the longest timer for `Infinity`, so both sides wait one bound, 5 s by default; twins drop a 1009 peer that never answers once a close timeout of 200 ms passed.                                                                                                                                                                                                              |
| The spec never says what a server transport's `error` reports, so no side's tests can hold to it.                                                                                                                                                                                 | Accepted. 15.1 states it: a protocol error on a connection, a drop or a 1009, each naming its bound and its value, and what a listener throws; a connection's own once, as it ends, its close or its drop begun, before its unclean close; never a peer that drops without its closing handshake, nor one its heartbeat drops, nor the server's own drop of a peer that never answered a close. Both sides' `error` doc comments say the same.                                                                                                                                                                                                                      |
| The clients diverge too: what a WebSocket client tells of a 1009 differs between the sides.                                                                                                                                                                                       | Accepted. The clients follow the servers' rule, one sentence of 15.1 for a side's transport, by the round below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The clients' round met a proposal to keep the C# WebSocket client to the TypeScript one's `close`
alone. Twelve objections, probed over `ws`, Node's global `WebSocket`, Chromium, Firefox, WebKit and
the C# client, refused it, and their verdict is taken: a client's transport `error` follows the
servers' rule.

| Objection                                                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The parity rule does not pick the TypeScript client's `close` alone: it lets the sides come back to one, or bring the other to all of them by a decision that meets the Tenth Man, which this round is; and a Leveled-down row is the wrong place, since the global `WebSocket` forces neither `ws` nor .NET. | Accepted. This round brings the servers' rule to every client that can carry it: over `ws` and .NET, a WebSocket client tells what a server tells. The global `WebSocket` is a platform row of `docs/support.md`'s Differences, "A WebSocket client's error once open", beside the upgrade's refusal and its credential, not Leveled down.                                                                                                                                                                                                                                  |
| The WHATWG premise, that a protocol error cannot be told from a drop, holds for the global `WebSocket` alone: Chromium fires `error` on a failure only, and `ws` emits it once, for a protocol error or its own 1009, never for a FIN or a reset.                                                             | Accepted. Over `ws`, the client tells an error whose `code` starts with `WS_ERR_`, its receiver's, which `ws` emits once; its sender's are left out. The global's bare `error`, which undici fires on every unclean close and Firefox and WebKit on a reset, tells nothing, its close alone.                                                                                                                                                                                                                                                                                |
| Keeping the clients to `close` alone makes each the inverse of the server it was just aligned with: 15.1 has a server report a protocol error and its own 1009, and RFC 6455 §7.1.7 lets a client report the problem to its user.                                                                             | Accepted. 15.1 states one rule for a side's transport, a client's as a server's, and 15.3 says a side reports its 1009.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The close-code round cannot give it back: a side that fails its connection reads 1006 (RFC 6455 §7.1.5, §7.1.7), `ws` and every browser alike, so no close code tells a protocol error or a client's own 1009 from a drop.                                                                                    | Accepted. The close code, ahead by a round of its own, carries what the peer said, 1000, 1001 or 4xxx; `error` is where a side's own failure is told.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `close` does not carry enough: the C# client's is (false, false) for a server's 1000 as for a reset, and the TypeScript client's whatever the code.                                                                                                                                                           | Accepted. `close` stays its pair of booleans; what tells a side's own failure from a drop is its `error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Nothing in the repository reads a client transport's `error`, so the diagnostic lost is an application's; but a client whose limits are lower than its server's fails each reconnection on the same message, with nothing logged at either end.                                                               | Accepted. A client's own 1009 names its bound and its value, `the connection is closed with 1009: a message past its maximumMessageBytes, N bytes`, the one line that explains such a loop; the router clients read `close` alone, as they do.                                                                                                                                                                                                                                                                                                                              |
| The C# client tells more than its 1009: its own abort past `CloseTimeout`, a heartbeat's drop and a FIN or a reset, which the servers tell none of.                                                                                                                                                           | Accepted. The C# client's `Follow` tells a `WebSocketException` whose code is `Faulted`, and its own 1009, and nothing once its connection ended here; twins hold a FIN or a reset and a heartbeat's drop by their close alone, and a 1009 left unanswered by one error.                                                                                                                                                                                                                                                                                                    |
| A throwing `Error` listener leaves the C# client's `Close` untold: `Follow` invokes it unguarded before its close, in a task no one awaits, so the router's close never runs.                                                                                                                                 | Accepted. Each client tells its error, then its close in a `finally`, as the servers do; what the listener threw is its platform's, Node's uncaught exception or the task no one awaits. A twin fails a connection on a protocol error whose `error` listener throws and holds its close told.                                                                                                                                                                                                                                                                              |
| The rule must reach HTTP: both HTTP clients lose their connection, its close alone, on HTTP's 1009 and protocol error, an answer past `maximumBodyBytes` and a batch that does not read.                                                                                                                      | Accepted, in this round. Both HTTP clients tell, before their close, what they close a connection for of their own: an envelope past `maximumBodyBytes`, an answer's or a batch's, `the connection is closed: an envelope past its maximumBodyBytes, N bytes`; a batch that does not read, `the connection is closed: a batch that does not read, …`, saying what of it does not. A server gone, a refusal of its own, a redirect, an answer of another type, an exchange lost and the inactivity timeout tell their close alone; the C# HTTP client's `Error` doc says so. |
| The spec says nothing of a client's `error`: 15.1 covers a client through the guard on its listeners alone, 15.3 says a server reports its 1009, and no file would hold the clients to one form.                                                                                                              | Accepted. 15.1 states what a side's transport reports on its `error`, and what it does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| No test asserts either form: the clients' `Error` is subscribed for a listener's throw alone, so neither direction breaks a test.                                                                                                                                                                             | Accepted. Each case is a twin, one title on both sides: a FIN or a reset, a heartbeat's drop, a protocol error, its own 1009 answered and unanswered, and an `error` listener that throws; over HTTP, an envelope past its bound and a batch that does not read. A test over Node's global `WebSocket` holds that it tells none.                                                                                                                                                                                                                                            |
| The TypeScript client keeps the platform's error where it has a channel for it: before open, an error event's is its `ConnectError`'s cause; once open, it sets `onerror` to nothing because nothing carries it.                                                                                              | Accepted. Once open, the TypeScript client keeps its `onerror` and tells `ws`'s error, the 1009's as the `cause` of its own `GenericError`, as its connect keeps an error event's.                                                                                                                                                                                                                                                                                                                                                                                          |
