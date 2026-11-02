# 0046 — A router paces each connection's reads by what it has not taken

- **Status**: accepted
- **Scope**: the protocol, and every side's routers and transports, server and client: in
  [`spec/spec.md`](../../spec/spec.md), 15.5's item 2, 15.6's resend of a non-request refused
  `busy` and its 429's `Retry-After`, 15.7's exchange lost past `exchangeTimeout`, 15.12's opening
  sentence, its two rows `maximumUntakenEnvelopes` and `maximumUntakenBytes`, its `exchangeTimeout`
  row and its paragraph on what waits to come in, 15.19's message held for a paused connection, and
  15.23's paragraph and its row `maximumHeldEnvelopeBytes`; each side's `IntakeLimits`, its
  bridge's count, the transports' required `pause` and `resume` and their hold, a broker
  participant's held queue, and the HTTP client's resend. What a side holds of a peer otherwise —
  the calls it answers, a request's bytes, what waits for a socket — is
  [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s; the one queue of a router's turns and
  what an application makes within a telling
  [0045](0045-a-router-takes-what-its-application-makes-in-one-queue-behind-the-turn-that-tells-it.md)'s;
  the Rust side's owner, its jobs and its panic
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)'s; the
  in-memory transport and the joined transport
  [0036](0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md)'s;
  a broker's parcels, their parts and `heldBytesBudget`
  [0039](0039-a-brokers-transport-numbers-its-parcels-and-sends-an-envelope-in-parts-under-its-peers-bound.md)'s;
  the C# side's types and parameters [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)'s.

## Context

**A router takes each envelope in a turn of its own, and a transport hands it envelopes as its
peer sends them.** What the router's turns have not taken yet waits between the two. Bead's own
bounds — an envelope's size, `maximumAnsweringCalls`, credit and a transfer's window (spec 12.2) —
judge the work a turn takes, as it takes it; none bounds what waits for that turn. A peer that sends
faster than the turns take is held, then, by whatever its transport and its platform hold.

**Measured with a router that counts nothing:**

- **The Rust side**, its server's router driven from a reader thread: 256 requests of 1 MiB held
  whole, 256.0 MiB, before the first turn; 289,664 requests waiting behind the reader. A reader
  that pauses at 64 and resumes at 32 against one that never pauses: another connection's answer
  0.08–0.10 ms late against 339–363 ms, nothing held over the start against 137.6–143.1 MiB, and
  everything answered sooner, 880–896 ms against 904–984 ms.
- **The C# side**, its real `RouterServer`: another connection's answer 358–554 ms late, 200–208 MiB
  managed; paced at 64, 0.01–0.02 ms late, at the collector's floor. Each message goes to its
  router's `SerialScheduler` whole, and a WebSocket connection reads its next message once it handed
  one. The C# side has untrusted peers: WebSocket, HTTP, MQTT 5 and AMQP 1.0.
- **The TypeScript side**, on Windows: its memory is its platform's, what its router cannot take
  staying in the kernel's buffer under TCP's window, but one flooding connection kept the event
  loop for 14–15 s; another's request, sent at 0.35 s, was answered 13.6–15.4 s later, and no timer
  ran. `ws` 8.22.0 emits every message of a socket read in one callback, its default
  `allowSynchronousEvents: true`, and the router takes each within it.
- **Its remedies**, a handler of 30 µs, 100,000 messages of 14 bytes, another connection sending one
  at 300 ms:

  | `ws`'s events and the transport               | A's messages taken in | B waited       | Most held in the transport |
  | --------------------------------------------- | --------------------- | -------------- | -------------------------- |
  | synchronous, no pause                         | 3,056–3,088 ms        | 2,752–2,783 ms | 0                          |
  | `allowSynchronousEvents: false`               | 3,287–3,331 ms        | 0.64–0.84 ms   | 0                          |
  | synchronous, paused at 64 a task, a read held | 3,099 ms              | 1.22–1.23 ms   | 3,269–3,276 (one read)     |

  `ws` pays 0.27–0.28 µs a message synchronous and 1.34–1.80 µs deferred, five to six times. Its
  maintainers shipped the deferred mode as its default and reverted it in 8.17.0 for that cost
  ([ws PR #2218](https://github.com/websockets/ws/pull/2218),
  [#2221](https://github.com/websockets/ws/pull/2221)).

**The standards bound what a receiver holds by pacing its sender.**

- **TCP**, [RFC 9293 §3.8.6](https://www.rfc-editor.org/rfc/rfc9293#section-3.8.6): an
  application that stops reading closes the window, and the sender stops.
- **HTTP/2**, [RFC 9113 §5.2](https://www.rfc-editor.org/rfc/rfc9113#section-5.2): a window per
  stream and per connection; [§5.2.2](https://www.rfc-editor.org/rfc/rfc9113#section-5.2.2): "the
  receiver MUST read from the TCP receive buffer in a timely fashion", or a `WINDOW_UPDATE` left
  unread deadlocks — the hazard a pause must never meet, and why a link that carries many
  connections is never paused.
- **HTTP's busy**, [RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4)'s 429 with
  [RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)'s `Retry-After`: how
  HTTP paces a client between exchanges.
- **.NET's System.IO.Pipelines**: `PauseWriterThreshold`, 65,536, and `ResumeWriterThreshold`,
  32,768, a pause and a resume with their hysteresis at half; Kestrel's `MaxRequestBufferSize`,
  1,048,576, its pause threshold, a fixed default.
- **Credits**, granted across a wire or between tasks: Tokio's bounded `mpsc`, Reactive Streams'
  `request(n)`, MQTT 5's Receive Maximum, AMQP's prefetch and link credit.
- **A reader's pause and resume**, the in-process form the transports are built on: Node's
  streams, `ws`, Netty's `autoRead`.
- **The [WHATWG WebSockets Standard](https://websockets.spec.whatwg.org/)** queues a task per
  message received. It governs a user agent's client API, not a server; `ws` uses one class for
  both, and its maintainers found that following it on a server "adds a very big performance
  penalty".

**The options weighed:**

- **A future, a `Task` or a `Promise` returned by a listener**: it rewrites spec 15.1's "a side
  awaits nothing a listener returns" for every listener, the application's among them, and turns
  the C# side's `event Action<…>` into a multicast whose results cannot be combined.
- **A readiness the transport polls**, WHATWG Streams' `desiredSize`: the same pair, asked instead
  of told, and an object per connection besides.
- **A credit the router grants**, HTTP/2's `WINDOW_UPDATE` in process: its first window must reach
  each transport before its first hand, by a grant from within `on_connection`, under the same kind
  of lock — the C# HTTP server tells under `connection.Telling` — or by a new pull on the listener,
  a second change of the seam on three sides. The readers the transports are built on offer a
  level, and its one hazard is a rule the project already keeps with `!`.
- **A bounded queue per router alone**, which
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md) refuses: it
  moves the wait into a transport that cannot learn its router is behind.
- **A count alone, or bytes alone**: a count alone lets 64 envelopes of 16 MiB wait; bytes alone
  let 75,000 envelopes of 14 bytes wait, each a turn another connection waits behind. HTTP/2 pairs
  a window with `SETTINGS_MAX_CONCURRENT_STREAMS`, AMQP 0-9-1 a prefetch count with a prefetch size,
  spec 11.10 a queue's count with its bytes.
- **A budget across a router's connections**, HTTP/2's connection window: it pauses the connections
  that behave for the one that floods.
- **Pausing a broker's link by holding its acknowledgements**, MQTT 5's Receive Maximum, AMQP 1.0's
  link credit: the link carries every connection of its participant; MQTT-4.6.0-2 orders PUBACKs,
  so one connection's hold is everyone's; an adapter at most once acknowledges nothing; and it is
  the multiplexed pause RFC 9113 §5.2.2 warns of.
- **A participant's hold charged to `heldBytesBudget`**: one connection's hold loses another's
  parts, and four connections that keep every rule, each bursting 64 requests of 1 MiB, fill it.
- **The TypeScript side by its platform alone**: its memory holds, but one connection's flood keeps
  every other connection and every timer waiting.
- **`ws`'s deferred events**, `allowSynchronousEvents: false`: five to six times `ws`'s cost a
  message, which its maintainers reverted, for 0.6–0.8 ms where a hold gives 1.2 ms; and the hold
  is the participant's own mechanism, so the side keeps one.
- **The bounds in `RouterLimits`**: that is 12.2's table, set alike at both ends, where these are a
  side's own and announced to no one.
- **A count that follows `maximumAnsweringCalls`**: it counts cancels, credits, answers and
  notifications besides requests, so it would tie a bound on fairness to a bound on concurrent calls
  for no reason that holds.

## Decision

**Every side bounds what one connection's transport has handed its router that no turn took yet,
and pauses that connection past the bound, on every transport. A paused transport hands nothing
more; what it already received it holds, in order, until it is resumed.** Spec 15.12 states the
rule beside its outbound twin, the send pace; each transport's share is in 15.5, 15.6, 15.7, 15.19
and 15.23.

**What is counted.** Each envelope a transport hands its router, as it is handed: one envelope, its
bytes. It is released once a turn of its router took it, and no sooner than the side could take
another connection's. Two bounds, either of which pauses: `maximumUntakenEnvelopes`, 64, and
`maximumUntakenBytes`, 1,048,576, fixed defaults, as Kestrel's `MaxRequestBufferSize`, Pipelines'
thresholds and 11.10's 64 and 1 MiB are; an application MAY set others, each 1 at least. The
connection resumes once both counts are at half or below, as `ResumeWriterThreshold` is half of
`PauseWriterThreshold`; with a bound of 1, half is 0.

- **The word.** 15.12's `maximumUnsentBytes` bounds what a side handed its socket that the socket
  has not taken; these bound what a transport handed its router that a turn has not taken. "Taken"
  is the spec's verb for a turn
  ([0045](0045-a-router-takes-what-its-application-makes-in-one-queue-behind-the-turn-that-tells-it.md)).
  "Queued" is 11.10's, whose bound ends a subscription where this one pauses, and one word keeps one
  meaning ([0003](0003-one-word-one-meaning.md)); "waiting" is a call's, waiting for its answer.
- **The envelope that reaches a bound is taken**, and only what comes after it waits, as a pipe's
  write past its threshold is accepted and its flush waits. An envelope larger than the byte bound
  is handed, taken and released.
- **Counted at the bridge, released by the turn.** The Rust side's `Bridge`, server and client;
  the C# side's `RouterServer.OnMessage` and `RouterClient.OnMessage`, once per message; the
  TypeScript side's `core.receive`. The job a message posts subtracts it once `receive` returned,
  whatever the turn did: on the C# side in a `finally` of the `Receive` job and of the text
  message's `Error` job, server and client, since `SerialScheduler` goes on past a throw and the
  `Error` job runs the application's handler; on the Rust side a job that panics ends the owner,
  which resumes every connection; on the TypeScript side the next task's release clears every
  count, whatever a turn threw.
- **An envelope handed within a telling is counted.** It is a transport's hand, which 0045's rule 3
  places where its platform hands it over; rule 2 only defers its turn. It is released by the
  deferred turn that takes it.
- **What is never counted: the router's own jobs** — a timer, a resolution, a dispose, a deferral
  of 0045's, a transport's `Sent::Later`, a connection opened or closed. They are posted through
  `Owner::post`, `offer`, `WeakOwner::after` and `Deferral::offer` on the Rust side, `Post`, `Run`
  and `RunBehind` on the C# side, a microtask or a timer on the TypeScript side, and never meet the
  count. 0045's one queue keeps its order: an envelope a bound held back joins the tail when its
  transport hands it, with less ahead of it.
- **On one thread**, the TypeScript side's, the router takes each envelope within the task that
  hands it, so the count is what a connection handed within one task. A helper of its own,
  `transport/shared/later-task.ts` — `setImmediate` under Node, a `MessageChannel`'s message in a
  page — clears every count and resumes every connection paused, in the next task: never a
  microtask, which runs before the loop turns, and never a timer, which Node holds to 1 ms.

**Where the bounds live: `IntakeLimits`**, an options type of its own beside `PacingLimits`, with
`IntakeLimitsOptions` on the Rust side, given to a server's router and a client's alike, as `intake`
beside `pacing`:

| TypeScript                | C#                        | Rust                        | By default |
| ------------------------- | ------------------------- | --------------------------- | ---------- |
| `maximumUntakenEnvelopes` | `MaximumUntakenEnvelopes` | `maximum_untaken_envelopes` | 64         |
| `maximumUntakenBytes`     | `MaximumUntakenBytes`     | `maximum_untaken_bytes`     | 1,048,576  |

They are not 11.10's queue bounds: those bound what a server queues for a paced subscription, a
queue of its own making, and end the subscription past them, `CAPACITY_EXCEEDED`; these bound what
a transport handed and the router has not taken, and pause the reads past them, ending nothing.
What a router holds across its connections is `maximumConnections` × (`maximumUntakenBytes` + one
envelope being read).

**The seam: a `pause` and a `resume`, required on every transport**, with no default body, so each
transport states what it pauses, and one to come cannot skip the bound in silence:

| Side       | A server's transport                                                                   | A client's transport                                        |
| ---------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Rust       | `pause(&self, connection_handle: &ConnectionHandle)`, `resume(…)` on `ServerTransport` | `pause(&self)`, `resume(&self)` on `ClientTransport`        |
| C#         | `void Pause(string connectionHandle)`, `void Resume(…)` on `IRouterServerTransport`    | `void Pause()`, `void Resume()` on `IRouterClientTransport` |
| TypeScript | `pause(connectionHandle)`, `resume(connectionHandle)` on `IRouterServerTransportLike`  | `pause()`, `resume()` on the client's                       |

- **Their contract.** Paused, a transport hands nothing more of that connection: what it already
  received, whole or still arriving, it holds, in order, until it is resumed. On resume it hands
  what it holds, in order, from a later step of its own, never within the call, and checks before
  each hand whether it was paused again. While it holds anything, it holds what comes next behind
  it, paused or not, so nothing overtakes what is held. Each call is idempotent, never blocks, and
  never tells a listener within it. What a transport throws as it pauses or resumes, or panics
  with, is reported as its router's error, with the connection, and what the count decided holds.
- **The lock order.** The bridge decides and calls under the lock that guards its counts, so a
  `pause` from a reader's thread and a `resume` from the owner's turn reach the transport in the
  order decided. A transport's `pause` and `resume` take no lock that transport holds while it
  tells a listener: the C# HTTP server, which tells under `connection.Telling`, takes only its
  gate's own lock in them. Marked `!` at the bridge and at each transport's pair.
- **A router that ends resumes what it paused**, disposed or its owner ended by a panic: a
  transport outlives its router.
- **The listener seam is unchanged**, so 15.1's "a side awaits nothing a listener returns" holds: a
  pause is a call, not a return.

**What each transport does.**

- **WebSocket.** The C# side's `WebSocketConnection.Read` awaits a gate of its connection at each
  message's boundary, before the `ReceiveAsync` that starts a message; a message partway when the
  pause comes is read to its end and held, one envelope at most. The TypeScript side keeps `ws`'s
  synchronous events: `pause` calls `ws`'s `pause()`, which stops the socket, and what `ws` still
  emits from the read it parsed is held in order, one socket read at most, 64 KiB; on resume the
  transport hands what it holds from a microtask, the router pausing it again at the bound, and
  resumes `ws` once nothing is held, so at most the bound is handed per task. A WebSocket client
  with no pause, a page's or Node's global one, hands one message per task, so the count never
  reaches a bound and its platform paces it, reading on; it still implements the pair, holding
  while paused. **A connection that closes reads on**: one this side closes, or one of a stop under
  way, opens its gate and reads to its peer's Close, dropping what comes
  ([RFC 6455 §7.1.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.1.1),
  [§7.1.2](https://www.rfc-editor.org/rfc/rfc6455#section-7.1.2)); what it held is dropped with
  the connection. TCP's window then paces the peer.
- **HTTP's server** awaits its connection's gate before it tells an exchange's envelope, outside
  `connection.Telling`. The exchange is under way meanwhile, counted under twice
  `maximumWaitingExchanges`, past which an exchange is refused 429 `busy`, with a `Retry-After` of
  1 second; its body, read whole, stays charged to `bodyBytesBudget` until handed on, past which
  503 `busy`. A non-request ends 204 once handed on: at once, unless its connection is paused.
- **HTTP's client** asks no listen while paused or holding; a batch already read, bounded by
  `maximumBodyBytes`, is handed in order until a pause, and its rest held. **It sends again a
  non-request refused `busy`**, 429 or 503, once its `Retry-After` passed: nothing of it was tried
  (spec 15.6), and exchanges keep no order (spec 15.5). One still refused past `exchangeTimeout`
  from its first send is an exchange lost, and the connection with it (spec 15.7). A request
  refused `busy` still rejects its send: its application decides.
- **A broker's participant holds; it never pauses its link.** `pause` and `resume` set a flag of
  the connection's that the participant shares, and `resume` posts a `release` turn to the
  participant's owner. The participant holds whenever the flag is set or anything is held:
  `take_data`, `Take` and their TypeScript twin push a whole envelope onto the connection's held
  queue instead of handing it, and only the `release` turn hands from a queue that is not empty, in
  order, until the flag is set again or nothing is held, so a `take_data` queued ahead of `release`
  never hands ahead of what is held. **A CLOSE waits behind what is held**, since 15.21 ends a
  connection by its CLOSE "once all before it was handed on"; a RESET ends it at once, whatever its
  order, and what is held is lost with it; a PING is answered at once, the participant reading on.
  It acknowledges a held message to its broker once held (spec 15.19), so no other connection of
  the link waits for this one. **What it holds of one connection is bounded by
  `maximumHeldEnvelopeBytes`**, by default `maximumUnsentBytes` — the most a peer that keeps every
  rule has under way on a connection, the bound the spec already keeps at the broker's other end —
  charged to no budget shared with parts: an envelope that would take it past loses that connection
  alone, a CLOSE of 4000, reported naming the bound. Nothing of a pause reaches the peer over a
  broker, its parcels taken by the broker, so there the bound paces nothing: the participant holds,
  then loses. Across its connections a participant holds at most `maximumConnections` ×
  `maximumHeldEnvelopeBytes`, the outbound bound's own product.
- **In memory**, on every side, each end holds what its pipe hands while paused, in the pipe's
  state of that connection, and `resume` posts a turn to the pipe's owner that hands it on. Its
  peer is the application's own code in the same process, so nothing bounds the hold (spec 15.13
  holds no bound of its own): it brings fairness among connections, not memory, and it gives every
  side's twins a real transport. The TypeScript side's hands by microtask, many within one task, so
  the count reaches it.
- **The Web Worker**, the TypeScript side's: both its ends are the application's own script, loaded
  by its own page, so it is no untrusted peer. A `MessagePort` has no pause and hands each message
  as its own task, so the count never reaches a bound there; the transport still holds what
  `onmessage` brings while paused, without bound, as in memory.
- **Joined**: `pause` and `resume` go to the transport that drew the handle, the Rust side by its
  `told` sets, the C# and TypeScript sides by the handle's type, unique within a join (spec 15.14).
- **A relay** adds no transport: leg B's answers come on its destination's connection and are
  counted there, and a relay's turn awaits nothing, so leg A's answer never waits on a paused
  leg B.
- **The test kit**, the Rust side's `ScriptedServer` and `ScriptedClient` and their C# and
  TypeScript twins, keeps the contract: it holds while paused, records each call, and says whether
  a connection is paused.

**Why a pause always ends.**

1. **The release never waits on the peer.** A count is released when a router's turn takes its
   envelope, and a turn awaits nothing
   ([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md); the C#
   side's turns run from await to await on its scheduler, the TypeScript side's within their
   task). The owner drains what waits without any further read, and the connection resumes. A
   peer's CREDIT, its CANCEL, a transfer's chunks, leg B's answer: each is next in its connection's
   order, and arrives once the turns took what is ahead of it. What a turn starts — a resolver, a
   transfer, an answer — is bounded by the limits that refuse or withhold credit, never by a pause
   of reads. This is RFC 9113 §5.2.2's hazard, answered.
2. **No threshold falls below the frame a reader needs whole.** A transport hands whole envelopes
   alone, assembled under `maximumMessageBytes`, `maximumBodyBytes` and
   `maximumEnvelopePartsBytes`, and the bound pauses after the envelope that reached it, never
   before.
3. **No close waits behind a pause.** A connection that closes reads on to its peer's Close.

A multiplexed link, which is never paused, and a router stalled for good, a bug the bound does not
create whose connections its peers' own bounds end, are no deadlock of the bound's.

**No conformance case holds it.** A pause is observable only in time and in TCP's window, and a
player cannot hold a router's turn from the wire, as 15.12's pace rows, 15.12.11 to 15.12.13, are
held by twins for the same reason. The new units 15.12.17, 15.12.18 and 15.23.5 are of reason
`twins`, which `spec/check.py` holds to a test on every side naming each. The twins, named alike on
every side, the Rust side's over HTTP and WebSocket ahead with its transports:

- pauses a connection once its untaken envelopes reach a bound, and resumes it once they are at
  half;
- takes the envelope that reaches a bound;
- an envelope of one connection waits behind no more than the bound of another that floods;
- counts nothing the router does of its own: a timer, a resolution, a dispose, a deferred call;
- counts an envelope handed within a telling, and releases it by its deferred turn;
- resumes a connection whose envelope a throwing listener heard;
- resumes every connection it paused as it is disposed;
- reports what its transport throws as it pauses or resumes a connection, and takes the envelope all
  the same;
- a client pauses its transport while what its server sent is untaken past a bound;
- a result sent as a transfer completes while its credits come on a paused connection;
- the intake limits refuse a bound below 1, and default to 64 and 1 MiB;
- a paused in-memory transport holds what it is sent, in order, and hands it on once resumed;
- reads no message of a paused connection, holds the rest of its read, and hands it in order once
  resumed;
- a paused connection closes cleanly;
- hands on no envelope of a paused connection, its 204 going once handed on, and 429 busy with
  Retry-After past the exchanges under way;
- tells an exchange held at the gate of a paused connection that its connection is gone as it
  closes;
- a client sends again a non-request refused busy once its Retry-After passed;
- a non-request waiting its Retry-After as its connection goes is sent no more;
- a paused HTTP client asks no listen and holds the rest of a batch;
- a paused HTTP client whose connection goes while it holds a batch asks no listen after it;
- holds what comes for a paused connection, in order, and loses it alone past
  maximumHeldEnvelopeBytes;
- a resume with a hand already queued keeps the order of what is held;
- a CLOSE behind held envelopes comes after them, and a RESET drops them;
- one connection held to its bound fails the parts of no other connection;
- paused before its connect opened, holds what its server sent, and hands it in order once resumed;
- a joined transport pauses the connection on the transport that drew it;
- the TypeScript side's alone: a Web Worker transport paused directly holds what its port brings,
  and hands it in order once resumed.

## Consequences

- **The release never waits on the peer**: every change to what releases a count answers to the
  three reasons above that a pause always ends.
- **A pause costs the peer what a reader that stops costs it.** Past the peer's own bounds the
  peer loses the connection: a client whose router is paused, over WebSocket, is dropped by its
  server's send pace as soon as `sendGracePeriod` after the server's socket stops taking, or past
  `maximumUnsentBytes` (spec 15.12); a server whose router is paused, over WebSocket, is dropped by
  no Bead client's pace, since no client keeps one, but its paused read takes no pong, so its own
  heartbeat closes the connection as one that left its ping unanswered; over HTTP, a client whose
  router is paused asks no listen, and its server's outbox past `maximumOutboxBytes` closes the
  connection (spec 15.9); over a broker, the receiving participant's `maximumHeldEnvelopeBytes`
  loses it. The TypeScript side, its event loop held by its router, already behaves so.
- **Over HTTP, the resend**: a non-request refused `busy` is sent again once its `Retry-After`
  passed, until `exchangeTimeout` from its first send loses the exchange.
- **Over HTTP, a paused connection's bodies hold `bodyBytesBudget`** until handed on: twice
  `maximumWaitingExchanges` exchanges of `maximumBodyBytes` pass the budget, and another
  connection's body is then refused 503 `busy`, as a slow body can make it be. The resend covers a
  non-request so refused; a request's send rejects.
- **A transport that hands one message per task** — a page's WebSocket, Node's global one, the Web
  Worker's port — is paused by no count, its platform pacing it.
- **Over a broker, a hold that buffers, then loses**: nothing of a pause reaches the peer.
- **In memory and over the Web Worker, a hold without bound**, its sender the application's own
  code.
- **On the Rust side**, the bound reaches the broker's and the in-memory transports now, and its
  transports over sockets as they land, which the required pair makes them implement: until they
  do, no untrusted peer reaches a Rust router, and the matrix's row
  `Rust's transports over HTTP and WebSocket` keeps their pause among what it brings.
- **The TypeScript side holds one socket read** of a paused `ws` connection beyond the count, 64
  KiB, and pays 0.4–1.4 % of throughput on a flood of small envelopes: the platform's row of the
  matrix, with its test.

**Its gates**: the twins above, on every side, which name the units 15.12.17, 15.12.18 and 15.23.5,
held by `spec/check.py`.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at
xhigh effort: ten objections, each checked against its probe or the code before it was answered.
Seven were accepted, three in part, and none refused.

| Objection                                                                                                                                                                                                                                                                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws`'s deferred events, `allowSynchronousEvents: false`, are the wrong remedy: `ws` measured 3 to 30 times its cost a message and reverted them in 8.17.0; the WHATWG rule governs a client; the draft probed Windows alone. A hold in the transport gives about 1.2 ms at about 1 %.                                                                          | **Accepted.** Verified: `receiver.js` defaults the option to `true` in 8.22.0 and defers each message by `setImmediate` when it is `false`; the probe shows five to six times a message; a hold gives the other connection 1.22–1.23 ms at +0.4–1.4 %, against 0.64–0.84 ms at +7.5–7.9 % for the deferred events. `ws`'s default is kept on the server and the Node client; the `ws` transports pause their socket and hold the rest of the read, handing it from a microtask until the router pauses them again. The seam's contract becomes "a paused transport hands nothing more; what it already received it holds in order until resumed", one mechanism with the participant's. The twin "emits one message per task" is replaced by "reads no message of a paused connection, holds the rest of its read, and hands it in order once resumed"; the read held beyond the count is the matrix's platform row.                                                                                                       |
| The participant's hold: (a) a resume races a queued `take_data` and reorders; (b) a CLOSE overtakes held DATA, against 15.21; (c) held envelopes charged to `heldBytesBudget` lose other connections' parts; (d) over a broker the pause is a buffer, then a loss.                                                                                             | **Accepted, all four.** Verified: the participant ends a connection as its CLOSE comes; 15.21 orders the CLOSE after all before it; 15.23.4's budget is shared across connections. (a) It holds whenever the flag is set or anything is held; only the `release` turn hands from a queue that is not empty. (b) A CLOSE is held behind held envelopes; a RESET drops them, ending at once as 15.21 says; a PING is answered at once. (c) Held envelopes are charged to no shared budget: each connection holds to its own `maximumHeldEnvelopeBytes`, by default `maximumUnsentBytes`, the most a peer that keeps every rule has under way and the bound the spec already keeps at the other end; past it, that connection alone is lost. `heldBytesBudget` keeps to parts and 15.23.4 is unchanged. (d) 15.23 and this record say it plainly: over a broker the hold buffers, then loses. Three twins are added.                                                                                                          |
| "Nothing is ever refused or dropped" is false over HTTP: a paused connection's exchanges count under the exchanges under way, past which 429 `busy`, which a client rejects; a slow router then refuses a conforming client's CANCELs, answers and CREDITs.                                                                                                    | **Accepted, the first remedy, widened to 503.** Verified: 15.12 bounds the exchanges under way at twice `maximumWaitingExchanges`, 15.6 has a client reject a marked refusal, the TypeScript HTTP client does so, and 15.6's 429 row named no `Retry-After`. The 429 carries `Retry-After: 1` (RFC 6585 §4, RFC 9110 §10.2.3), and every side's client sends a non-request refused `busy` — 429, or 503 past `bodyBytesBudget` — again once it passed, until `exchangeTimeout` loses the exchange, which 15.7 and that timeout's row say. A paused connection's bodies hold `bodyBytesBudget` until handed on, which this record states as a consequence. It is safe: nothing of it was tried, and exchanges keep no order (15.5). A request refused `busy` still rejects its send. "Never refuses" leaves the recommendation, the spec's text and the changelog; the matrix's row of a `Retry-After` is revised. Refused: counting the exchanges held at the gate apart, which still needs a bound and a refusal past it. |
| On the TypeScript side the two bounds govern nothing a WebSocket does with deferred events, the `ws` twin tests a path that cannot run, and the draft writes an event loop into the wire's spec while it adds a platform row for the same thing.                                                                                                               | **Accepted.** Verified: the probe's deferred events hand two at most per task, so a count of 64 is never reached. With the first objection's hold, `ws` keeps its synchronous read and the count governs it: its twin tests a live path. The spec states the rule without an event loop, "released once a turn took it, and no sooner than the side could take another connection's" (15.12), and the TypeScript side's release in the next task, with its socket read held, is one platform row of the matrix with its test. On the heap: the probe's model let `ws` emit the whole read past the pause; under the hold what a paused connection keeps is one socket read, 3,269–3,276 envelopes of 14 bytes.                                                                                                                                                                                                                                                                                                             |
| The draft contradicts itself on an envelope handed within a telling: one bullet puts it among the jobs never counted, the next counts it.                                                                                                                                                                                                                      | **Accepted.** Verified in the draft. It is counted, as a transport's hand that 0045's rule 3 places where its platform hands it over, and released by the deferred turn that takes it; it leaves the list of the router's own jobs and the spec's "of its own". A twin on every side; 0045's rule 2 says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| On the C# side a count released as the last step of the `Receive` job or the `Error` job leaks on a throw: the scheduler goes on, and the connection stays paused while its router lives.                                                                                                                                                                      | **Accepted.** Verified: `SerialScheduler.Post` catches and goes on, and `RouterServer` runs the application's `Error` handler in the posted job. The release is in a `finally` of its job, on the server and the client. The Rust side needs none, since a panicking job ends the owner, which resumes every connection; nor the TypeScript side, whose next-task release clears every count whatever a turn threw. The twin "resumes a connection whose envelope a throwing listener heard" runs on every side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The Rust side ships none of the measured behaviour: no network transport, the in-memory transport's pause doing nothing, the reproducer unchanged; the Web Worker is called untrusted, then "its own process"; the matrix's row cannot close.                                                                                                                  | **In part.** Verified: the reproducer drives `ScriptedServer` from a reader thread; no Rust transport reads a network. Accepted: the in-memory transport holds while paused on every side, so every side's twins run on a real transport, and the Rust broker transports pause now; the test kit holds too; this record says the Rust side's memory finding closes for an untrusted peer as its socket transports land, which the required pair makes them implement. The Web Worker is settled as no untrusted peer, both its ends being the application's own script, and holds as in memory. Refused: keeping the row open. In memory and the Worker behave alike wherever they exist, a hold without bound whose sender is the application, so they are no difference; the Rust socket transports are already ahead under their own row, `Rust's transports over HTTP and WebSocket`, which keeps their pause. What still differs is the platform row.                                                                 |
| The pause's cost lands on the peer's send pace, as soon as 5 s, not at the 30 s heartbeat, and both WebSocket ends keep that pace; and "reads nothing more" would block the read of a close handshake.                                                                                                                                                         | **In part.** Verified: 15.12's pace is a server's; the C# WebSocket client builds its connection with no pace, and the TypeScript `ws` client holds none, so "both ends keep the pace" is wrong. Accepted: a client whose router is paused is dropped by its server's pace as soon as `sendGracePeriod` after the server's socket stops taking, or past `maximumUnsentBytes`; over HTTP, by its server's outbox bound (15.9); a server whose router is paused loses its connection only to its own heartbeat, its paused read taking no pong. This record and 15.12 state these drops as a reader that stops, and the heartbeat's drop is corrected. Accepted: a connection that closes, or a stop under way, opens its gate and reads to its peer's Close, dropping what comes (RFC 6455 §7.1.1–7.1.2), with the twin "a paused connection closes cleanly".                                                                                                                                                               |
| (A preference of design.) A level forces foreign calls under a lock; a credit, as TCP, HTTP/2, Reactive Streams, Tokio, MQTT 5 and AMQP grant, would not. Default bodies that do nothing let any transport skip the bound.                                                                                                                                     | **In part.** Refused: the credit. Its first window must reach each transport before its first hand, by a grant from within `on_connection`, under the same kind of lock (the C# HTTP server tells under `connection.Telling`), or by a new pull on the listener: a second change of the seam on three sides for a hazard the project already keeps with `!`. The credits cited are across a wire or between tasks; the readers the transports are built on (Node's streams, `ws`, Netty, Pipelines) offer a level. Accepted: the pair is required, no default body on any side, so each transport states what it pauses and the Rust socket transports to come cannot skip it; the lock order is named in the seam's contract and marked `!` at the bridge and at each transport's pair.                                                                                                                                                                                                                                   |
| (A preference of design.) (a) `RouterLimits` is 12.2's table, set alike at both ends, while these bounds are a side's own: a type of its own, as `PacingLimits`; (b) the rule belongs in section 15, beside 15.12's bounds, and the draft's closing sentence is false; (c) the count's default follows `maximumAnsweringCalls` on a reason that does not hold. | **Accepted, all three.** Verified: `RouterLimits` holds 12.2's ten fields, and `PacingLimits` is its own type on every side. (a) `IntakeLimits`, beside `PacingLimits`, given as `intake` to a server and a client; this record says how it differs from 11.10's queued bound, which ends a subscription where this pauses. The names move from "queued" to "untaken", the inbound twins of `maximumUnsentBytes`, so 11.10's word keeps its meaning (0003). (b) Two rows of 15.12's table and a paragraph after its send pace; the closing sentence is bounded: "beyond one read of its socket or one batch". (c) A fixed default of 64, as Kestrel's and Pipelines' thresholds and 11.10's are; the draft's open point on `maximumAnsweringCalls` of 1 goes with it.                                                                                                                                                                                                                                                      |
