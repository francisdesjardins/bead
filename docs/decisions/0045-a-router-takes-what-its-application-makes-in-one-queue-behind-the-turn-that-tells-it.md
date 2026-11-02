# 0045 — A router takes what its application makes in one queue, behind the turn that tells it

- **Status**: accepted
- **Scope**: the protocol, and every side's routers: what an application does with its side from
  within a telling, in section 9.0 of [`spec/spec.md`](../../spec/spec.md), a call made before a
  dispose and one made after, in 9.1, and the order a publisher's messages keep in the in-memory
  broker, in 15.24; each side's queue of turns, the deferral at its public surface, a dispose's two
  marks, and the conversations of `spec/conversations.json` that carry a `listener`. The Rust
  side's owner, its jobs, its panic and its handles are
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)'s; the
  in-memory transport's later turn
  [0036](0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md)'s;
  a broker adapter's offer
  [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)'s;
  a debug listener's guard and its error
  [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s; the C# side's types and
  parameters [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)'s.

## Context

**A side tells its application things within a turn, and the application answers within the
telling.** A router reports an error with its connection (spec 9.0), traces each envelope it reads
and sends to a debug listener (`debugging.md` 2), and asks its client's application of a failure
that pairs no call. Within each, the application may use the side: call a command, notify, cancel,
dispose. Each side runs a router's turns one at a time, so a telling sits inside a turn that has
not finished, and what the application makes there must go somewhere relative to what that turn
sends and to what it defers.

**Three orders are at stake, and each is observable on the wire:**

- **The report case.** A resolver throws; the turn answers `PROCEDURE_FAILED` and reports the
  error; the report listener calls a command on the same connection. The command goes before the
  failure, or after it.
- **The read case.** A turn tells its debug listener that it read an `ELSEWHERE` whose transport
  carried nothing, and defers that request's `SESSION_REQUIRED` to a later turn (spec 15.1); the
  listener calls a command on the same connection. The command goes before the deferred refusal, or
  after it.
- **A dispose within a telling, or just after a call.** A call made before a dispose either goes or
  fails unsent, and a turn whose listener disposes of the router either sends its own answer or
  does not.

The in-memory broker meets the same question from the other side: a listener that publishes within
the broker's turn, after its publisher queued an earlier publish, either keeps 15.24's order "in
the order its publisher published it to that topic" or overtakes it.

**The standards point one way.**

- **One FIFO of jobs.** ECMAScript runs a job to completion before the next starts, from a FIFO
  queue ([ECMA-262, Jobs](https://tc39.es/ecma262/#sec-jobs)); HTML drains one microtask queue in
  order at each checkpoint
  ([HTML, "perform a microtask checkpoint"](https://html.spec.whatwg.org/multipage/webappapis.html#perform-a-microtask-checkpoint)).
  The TypeScript side's later turns are microtasks, and so are its in-memory transport's hand-offs;
  a promise reaction queues at the tail of that same queue, behind a hand-off already there. No
  microtask jumps one queued before it.
- **The actor's mailbox.** An actor takes one message at a time from one mailbox, and a message it
  sends itself goes to that mailbox's tail. The order guaranteed is per sender and receiver
  ([Erlang/OTP Reference Manual, "Processes"](https://www.erlang.org/doc/system/ref_man_processes.html):
  "if an entity sends multiple signals to the same destination entity, the order is preserved";
  [Akka, "Message Delivery Reliability"](https://doc.akka.io/docs/akka/current/general/message-delivery-reliability.html):
  "for a given pair of actors", "not transitive"). The owner of
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md) is that
  actor, and its queue the mailbox.
- **Linearizability.** One FIFO whose post is atomic orders two operations by their posts: where
  one happens before the other (Lamport, "Time, Clocks, and the Ordering of Events in a Distributed
  System", CACM 21(7), 1978), it goes first, and the queue is linearizable (Herlihy & Wing,
  "Linearizability", ACM TOPLAS 12(3), 1990). No conversation can tell it, so the spec does not
  state it.
- **A stop that is an ordinary message.** Akka's `PoisonPill` "is enqueued as an ordinary message
  and will be handled after messages that were already queued in the mailbox", and what is sent
  after it goes to dead letters
  ([Akka, "Actors"](https://doc.akka.io/docs/akka/current/actors.html#poisonpill)).
- **A dispose at once, for its caller.** After `Dispose`, a member throws `ObjectDisposedException`
  (.NET's Dispose pattern), and `[Symbol.dispose]` is synchronous
  ([TC39 Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management)).
  Both ask that what is made after the dispose fail; neither asks that what was made before it be
  dropped.
- **Not TCP.** RFC 9293's CLOSE is graceful, and its ABORT (§3.10.5) gives queued SENDs "connection
  reset" and flushes them. Bead's dispose rejects every pending call at once and lets what was made
  before it go: it is neither, and neither is cited for it.

**The options weighed:**

- **F, one FIFO of turns per router**, what the application makes from within a telling joining its
  tail: the decision below.
- **L, a lane of the turn's own for everyone**: what a turn defers and what its application makes
  within it run as that turn ends, ahead of the queue. It lets a publish made within the broker's
  turn overtake one its publisher made before it, against 15.24; it lets a call made later by
  happens-before overtake one made earlier, against 0044's "draws the call id and sends in the order
  calls are made"; and it is not the TypeScript side's queue, where no microtask jumps one before
  it. Mending it takes a sequence drawn at each call and a reorder buffer on two sides.
- **Two queues on the Rust side**: the application's operations at the tail and the router's own
  continuations on the lane. In the read case, the Rust side alone would then send the refusal
  before the listener's call, where the TypeScript and C# sides, each one FIFO, send the call first.
- **K, a dispose at once with a permit per call**: one mark set at once, and each call made before
  the dispose carrying its right to go. The turn's own answer is made after the listener returns,
  so it carries no permit, and K still refuses it, against spec 9.0's "a report never changes what
  its turn answers". A permit is needed on every kind of job — an answer, a notification, a cancel,
  an inbound refusal, a timer's — which is a sequence by another name.
- **A call made before a dispose does not go**, as ABORT flushes. The TypeScript side would need a
  queue outside any turn to hold its hand-off, or keep a row of the matrix open for good, and the
  certainty bought, that a call never ran, covers only calls not yet sent: a call already sent when
  a dispose comes is as uncertain on every side.
- **Defer the telling instead of the operations**, as WHATWG's WebSocket fires its events from
  queued tasks. Some tellings are asked, not told: a client's unpaired failure is read for its
  return within the turn, on every side, and cannot come later. The design would split listeners
  into told later and asked now, the classification it meant to avoid; it changes spec 9.0's first
  half for every listener, costs a queued job per traced envelope while someone listens, and loses
  the turn a trace was raised in, which the debug trace and DevTools read. WHATWG queues `onclose`
  because nothing reads its return; Node's `EventEmitter`, whose listeners run synchronously, is the
  model of Bead's tellings.
- **Calls inline on every side**: a Rust turn borrows its state and cannot run a call within it,
  and a report would change what its turn sends first.

## Decision

**F: one FIFO of turns per router, on every side.** Spec 9.0 states the rule, the conversations
under `listener` and the twins below hold it. Each side keeps four rules.

1. **One FIFO.** A router runs its turns one at a time, from one queue, in the order they were
   queued: on the Rust side, the owner's queue alone, with no lane; on the C# side, the
   `SerialScheduler`'s queue, which `Post`, a posted continuation and the deferral below all join;
   on the TypeScript side, the microtask queue, which its later turns, its in-memory transport's
   hand-offs and the deferral below all join.
2. **From within a telling.** What the application makes from within a telling never runs within
   the turn that tells. It joins the FIFO's tail when it is made: behind what that turn sends at
   once, and in its place among what that turn and others defer. This is run to completion as
   ECMA-262's jobs define it, and a self-send as the actor model defines it. The order is defined
   by what each side takes, not by when the application asks.
3. **From outside.** An operation made from outside any turn takes effect when it is made, as 0044
   has it: on the Rust and C# sides it is posted to the FIFO at the call; on the TypeScript side it
   runs at once, since no turn runs then. What a transport hands its side enters where its platform
   hands it over: on the TypeScript side a WebSocket's message and a timer are HTML tasks, and enter
   when their task runs, those platform queues being outside the side as HTML's task queue is
   outside a script.
4. **A dispose, in two steps.** The handle's mark is set at once, so an operation made after it
   fails unsent — a `DisconnectError`, a `DisconnectException`, a `CallError::Disconnected` — "the
   router was disposed", a reason kept apart from "the router was disposed before the answer". The
   state's mark is set by the dispose's own job in the FIFO, the first thing that job does, with the
   pending calls rejected. What came before the dispose goes, the turn it was made in included.

**The outcomes.**

- **The report case** sends `[FAILURE call 1 PROCEDURE_FAILED, REQUEST call 2]`: the call goes
  behind what the turn answers.
- **The read case** sends `[REQUEST call 2, FAILURE call 1 SESSION_REQUIRED]`: the call goes in the
  order deferred, ahead of the refusal its turn deferred after the telling.
- **The in-memory broker** routes a publish made within its turn to the FIFO's tail, behind one its
  publisher made before it, as 15.24 says: `["P1", "P2"]` on every side. The Rust broker's `run`
  posts to the tail; the C# broker's public adapter operations queue behind; the TypeScript broker
  routes a publish at the call into each link's FIFO, which keeps the order.
- **A call made before a dispose goes**, on every side and in every turn, and one made after fails
  unsent. A dispose made within a telling lets that turn send its answer: a report listener that
  disposes of its router as it hears a failed resolver sees the turn's `PROCEDURE_FAILED` go, and
  no second report "the router was disposed".
- **Across threads**, on the Rust and C# sides, two operations made on two threads go in the order
  of their posts: where one happens before the other, it goes first. The spec says nothing of
  threads.

**Where the deferral sits.** On the Rust side, nowhere: the FIFO alone orders every caller, with no
count of tellings and no classification. A listener's `request` posts to the tail as any caller's
does, and the facade's own steps on the state stay inline. On the TypeScript and C# sides, the
deferral sits at the public surface the application calls, one hop:

- **TypeScript.** One telling scope, `createTelling()`, which the core and its facades share, wraps
  every emit to an application listener: each facade's emitter whole, so the core's callbacks, the
  facade's own events and what the service layer emits through it all run within it, as the Rust
  side's `Listened::guarded` and the C# side's `ListenerGuard` sit at the facade; `isTelling()`
  reads it. The facades' public operations — the server's `request`, `respond`, `notify`,
  `dropSubscriptions`, `endSession` and `endSessionsOf`, the client's `request`, `respond`,
  `registerNotification` and `unregisterNotification`, and each one's dispose — check their
  arguments at once, then, within a telling, run the rest in a later microtask, a reaction job at
  the queue's tail. That job runs outside any telling, so a public method it calls runs at once.
  The service layer adds no deferral of its own: it reaches its router through those methods, one
  hop. `subscribe`, `unsubscribe` and `gauges` stay at once.
- **C#.** `SerialScheduler` holds `RunBehind<T>(Func<Task<T>>)` and `RunBehind(Func<Task>)`, which
  always queue and never run inline, the FIFO `Post` joins. The public operations of `RouterServer`
  — `Request`, `Respond`, `Notify`, `DropSubscriptions`, `EndSession` and `EndSessionsOf` — and of
  `RouterClient` — `Request`, `Respond`, `RegisterNotification` and `UnregisterNotification` — and
  the in-memory broker's turn check their arguments at once, then call `RunBehind`, and each
  facade's dispose queues its job on the same FIFO; the router's own calls reach the internal `…OnLoop` form, so there is never a
  `RunBehind` within a `RunBehind`. `ServiceServer` and `ServiceClient` add none of their own: they
  reach their router through those methods, one hop. `Subscribe`, `Unsubscribe` and `Gauges` stay
  on `Run`, as the TypeScript side's stay at once. `Run` stays, inline when current, for the
  router's own calls. A turn hands over its own answer before an await that yields, so that no
  queued job runs between the turn and its answer.

**The router's own calls stay inline.** A facade's handler of its core's callbacks, and its own
steps within a turn, call the core directly and never defer; what a transport's event hands the
core is taken in a later turn when it comes within a telling, as spec 9.0 has it:

| Side       | Site                                                                                                     | Stays                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| C#         | `RouterClient.UnregisterNotification`'s job cancels or reserves an unbound subscription's call           | `RouterCore.Cancel` and `Reserve`, inline                       |
| C#         | `RouterClient.OnCallId` cancels the call bound before, ahead of its send                                 | inline: CANCEL before REQUEST, as on the other sides            |
| C#         | `RouterClient.Renew` sends its credit                                                                    | `RouterCore.Send`, inline                                       |
| C#         | `RouterClient.OnUnpairedFailure` reserves the call its server ended                                      | `RouterCore.Reserve`, inline                                    |
| C#         | `RouterServer.SendNotification` sends what a fan-out offers                                              | `RouterCore.SendNotification`, inline                           |
| C#         | `RouterServer.EndSubscription` sends its failure                                                         | `RouterCore.Send`, inline                                       |
| C#         | `RouterServer.Exceed` answers its failure                                                                | `RouterCore.Respond`, inline                                    |
| C#         | the relay's leg B, and its answers on leg A                                                              | `RouterServer.RequestOnLoop` and `RouterCore.Respond`, inline   |
| C#         | `RegisterResolver`, on each facade                                                                       | `RouterCore.RegisterResolver`, at once                          |
| TypeScript | `router-client.ts`'s `onUnpairedFailure` reserves, its return read in turn                               | `core.reserve`, inline                                          |
| TypeScript | `router-client.ts`'s `onCallId` cancels the call bound before                                            | `core.cancel`, inline                                           |
| TypeScript | `router-client.ts`'s `renew` sends its credit                                                            | `core.send`, inline                                             |
| TypeScript | `router-server.ts`'s `sendNotification`, `endSubscription` and `exceed`                                  | `core.sendNotification`, `core.send` and `core.respond`, inline |
| TypeScript | the relay's leg B, and its answers on leg A                                                              | the router's own `request` and `core.respond`, inline           |
| TypeScript | `registerResolver`, on each facade                                                                       | `core.registerResolver`, at once                                |
| Rust       | `router/client.rs` binds a subscription's call as its call id is drawn, cancelling the call bound before | inline, ahead of its `REQUEST`, as on the other sides           |

**The dispose's two marks.** The handle's mark is read only where an operation enters from the
application and where a transport's telling enters the router, and once, at the call: the deferred
remainder of an operation, the TypeScript side's microtask, the C# side's `RunBehind` job and the
Rust side's posted job, reads only the state's. The skip of an answer to a call no longer answering
and the send gate read the same mark, the state's, so the two always agree, and no `RESULT` goes on
a cancelled call between a dispose and its job. A call made after the dispose is refused before it
starts, on every side: it draws no call id and is never counted. On the Rust side it fails in its
future, `Err(CallError::Disconnected("the router was disposed"))`, `request`'s own `Result`
unchanged.

| Site                                   | Rust                                                                                               | TypeScript                                                      | C#                                                              | Mark   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- | ------ |
| an operation made, at its entry        | each handle method that acts: a call, a cancel, an unregistration, a notification, a session ended | `request` and `respond`; the rest runs behind the dispose's job | `Request` and `Respond`; the rest runs behind the dispose's job | handle |
| a transport's telling dropped          | the client's and server's bridges                                                                  | `router-server.ts` takes its listeners off at once              | `RouterServer.Dispose` unsubscribes                             | handle |
| the public "is disposed"               | `Core`'s `Debug`                                                                                   | the core's `isDisposed` getter                                  | `RouterCore.IsDisposed`                                         | handle |
| the core's own reading                 | `Core::is_disposed`                                                                                | the core's own                                                  | the core's own                                                  | state  |
| an answer skipped, or going on to fail | `respond`'s check                                                                                  | the core's answer                                               | `RespondOnLoop`                                                 | state  |
| an answer refused                      | through the gate                                                                                   | the core's answer                                               | through the gate                                                | state  |
| the writer's gate                      | `deliver`                                                                                          | `router-writer.ts`                                              | the writer's `HandOver`                                         | state  |
| a cancel sent                          | the requester's cancel                                                                             | `router-requester.ts`'s cancel                                  | `RouterCore.Requester.cs`'s cancel                              | state  |
| a resolution still its call's          | through `is_answering`                                                                             | through the signal                                              | `IsResolving`                                                   | state  |
| a rejection's reason                   | —                                                                                                  | —                                                               | `RouterCore.Requester.cs`'s rejection                           | state  |

On the Rust side, `Disposal` is the handle's mark, set at once by `dispose`, and the state holds its
own, set first by the dispose's job and by `end`. The ending state's own deferrals, once its owner
panics, go to a buffer of the state's own that the owner runs next, each job within a guard, the
owner having closed its queue and counted what it held as unrun; what a listener makes while the
router ends meets the closed queue and fails `Disconnected`. On the TypeScript side the core holds
both: the handle's, set at once by its `[Symbol.dispose]` and given by its `isDisposed` getter, and
the state's, set at once outside a telling and within one in the dispose's later turn, with
`rejectPending`; each facade holds a handle's mark of its own, set at once by its
`[Symbol.dispose]` and read by its `request` and `respond`. On the C# side `_isDisposed` is the
handle's mark, set at once, and the state's is set first in the job the dispose queues, with
`RejectPending`.

**The conformance.** Two conversations of `spec/conversations.json` carry a `listener`,
`{"telling": "report" | "read", "command": "clock"}`, the corpus's scripted listeners: the
application, on the first telling of its kind on a connection and once, calls the interop service's
`clock` on that connection and lets its answer go. The report case is held by
`a call the report listener makes goes behind what the reporting turn answers`, and the read case
by `a call made as a request is read goes before the refusal its turn defers`. Each player
compares what goes out per connection. The read case tells the two orders apart on every side. The
report case, played through the interop service, holds the outcome; where a service answers
`PROCEDURE_FAILED` before it reports, its order is the same either way, and the twin on the router,
a resolver registered on the router itself, tells the two orders apart. `spec/check.py` holds
the key by its schema, and its command a procedure of kind `command` of the interop blueprint.

The twins, named alike on every side, hold what a conversation cannot reach — the client's side,
threads, the dispose and the broker, each cited by the matrix's row of these behaviours:

- a call its report listener makes goes behind what that turn answers;
- a call a listener makes goes among what its turn defers, in the order deferred;
- a call a listener makes within a turn goes behind every call made before it, on the TypeScript
  side one made before the turn, on the C# side one another thread makes while the listener
  waits;
- a call made before its router’s dispose goes, and one made after it fails unsent;
- a call then a dispose its report listener makes go behind that turn’s answer, the call before
  the dispose;
- lets its connections go after the turn its report listener disposes it in, behind the failed
  resolver’s answer;
- an answer its resolver gives after a dispose queued behind it sends nothing on a cancelled call;
- a subscription’s call cancels the one bound before it ahead of its own request;
- a publish a listener makes within the broker’s turn comes behind one its publisher made before
  it.

## Consequences

- **One order on every side**, and no row of the matrix for it: a call from within a telling, a
  call made before a dispose and a publish within the broker's turn each behave alike, as the
  conversations and the twins show. Nothing is leveled down: a FIFO is the standard chosen, and
  every side reaches it.
- **The Rust side's continuations run behind what was queued before them**, as a microtask does
  on the TypeScript side and a posted continuation on the C# side: about 80 call lines of `post`,
  `offer`, `run` and `Core::later` take that meaning within a turn, each held to assume nothing of
  the state between its turn and itself — `held` in the server, `deliver`'s `then`, `respond`'s
  `done`, the resolutions, a participant's and the in-memory transport's later jobs.
- **Two marks kept coherent on three sides**, by the table above, which every change to a dispose
  answers to.
- **A dispose within a fan-out completes it**: a listener that disposes of its router as a notify
  goes to N subscriptions still sees the whole fan-out go. It is run to completion's price, the
  turn completing.
- **At the peer**, a call queued before the dispose reaches it, and its resolver runs, while the
  requester hears "the router was disposed before the answer" and cannot tell whether it ran, as
  for every call already sent when a dispose comes. The call made after the dispose is the one that
  cannot have run, and its reason says so.
- **A queued job per deferred operation** on the TypeScript and C# sides, a microtask or a
  scheduler's job, paid only within a telling.
- **What the spec does not state**: the order across threads and its linearizability, which no
  conversation can tell, are this record's and the twins'.
- **Not a row**: the TypeScript platform's HTML tasks, a WebSocket's messages and timers, enter the
  side when their task runs, rule 3, as each side's transport enters where its platform hands it
  over; the router behaves the same once they are in.

**Its gates**: the two conversations under `listener`, played by every side; `spec/check.py`, which
holds the key and its command; and the twins above, on every side.
