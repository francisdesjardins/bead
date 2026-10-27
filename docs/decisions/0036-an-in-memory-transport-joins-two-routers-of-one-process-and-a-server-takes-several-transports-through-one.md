# 0036 — An in-memory transport joins two routers of one process, and a server takes several transports through one

- **Status**: accepted
- **Scope**: the protocol, and every implementation's transports: the in-memory transport, its
  client and its server, in section 15.13 of [`spec/spec.md`](../../spec/spec.md), and the joined
  server transport, in 15.14; what 13.4, 14.3's step 5 and 15.1 count of the in-memory transport;
  its connect's timeout, the way `memory` of `transportClient.connectTimeout` in
  [`spec/durations.json`](../../spec/durations.json). A connection's handle is
  [0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md)'s, a listener's
  guard and a stop
  [0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)'s,
  the credential a transport carries beside an envelope
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s, and what a gateway of HTTP/JSON
  transcoding answers through them
  [0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)'s.

## Context

**Three parts call a router of the same process, and a test is a fourth.** HTTP/JSON
transcoding's gateway calls each procedure as one more client of the application's own server, its
admission, sessions, service manager, metrics and trace the server's, one Bead connection per HTTP
exchange, each with its caller's credential and address. Rust's core plays its conformance before
it has a socket. A side's tests link a server and a client in memory, a service's and a
conversation's.

**What carries an envelope in a process is a Web Worker's port alone**, on the TypeScript side: a
`MessagePort` carries an envelope and nothing beside it, so no credential and no address
(`worker-transport-server.ts`, a credential "is not carried", the address `local`), and the C#
side has no port.

**A server is built on one transport, and a service is offered on one server, once**: TypeScript's
`IServer.transport` and its router built on it, `offer` throwing "a service is offered on one
server, once"; C#'s `Server(IServerTransport transport, …)` and `RouterServer`, `Offer` throwing
"this service's server side is offered already". A second transport given a server of its own is a
second server: a second router, session manager and service manager, every service offered twice, a
notification reaching the server it was offered on, a credential's session ended by its identifier
(13.10) on one. The interop serves WebSocket and HTTP so, two servers and two offers. What a joining
needs is per connection already: `carriesCredential(handle)` and `isSecure(handle)`,
`CarriesCredential` and `IsSecure`, and every event of a server's transport keyed by its handle.

**A handle tells two types apart, never two transports of one type**: every handle reads
`type=…;ip=…;` and ends `ordinal=n`, each transport counting its ranks from 1
([0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md)), so two WebSocket
transports draw `type=WS;ip=…;port=…;ordinal=1` alike for two sockets from one address and port,
0025's own case.

The options weighed:

- **A `MessagePort` pair**, the Web Worker's transport within one thread: no credential and no
  address beside an envelope, so a gateway's caller would present nothing and be told by no address,
  and no C# twin.
- **A pool of ports**: the same two lacks.
- **Test doubles**, each side's own, a link between a service's server and client or a scripted
  transport under a conversation: no behaviour the spec states, none the other side shares, and
  nothing a gateway or Rust's core can run on.
- **A server of its own for the gateway**: two offers of each service, two session managers, two
  sets of gauges, which the application keeps in step by hand.
- **The gateway mounted on the HTTP transport's listener**: a transport coupled to a gateway,
  against one port for two coming from a proxy in front
  ([0004](0004-one-behaviour-in-every-language.md)), and no router gained, since the transport's
  router is still one server's.
- **One server transport over several**, each handle its own transport's: one router, one admission,
  one session manager, each service offered once, and nothing changed in the router, the server or
  `offer`.

## Decision

**One in-memory transport in each core** (spec 15.13), beside WebSocket, HTTP and the Web Worker: on
the TypeScript side `memory-transport-client.ts` and `memory-transport-server.ts` over the
transports' own bases, on the C# side `MemoryTransportClient` and `MemoryTransportServer`, each end
telling what comes to it on a serial scheduler, one turn at a time. It is the same transport in both
cores, and a cleaner split than a Worker's port made to carry what it does not; the Web Worker
transport keeps its messages, an envelope alone across a thread.

- **A connect draws a connection** on the server's side, its handle
  `type=MEMORY;ip=<address>;ordinal=n`, drawn as 0025 has every handle drawn, the address the
  client gave as it connected, or `local`: visible ASCII but `;`, which ends a handle's part, as
  each side refuses any other before anything moves.
- **Each envelope is copied as it is sent**, and handed on whole, once, in the order sent, **in a
  later turn than its send, never within it**, so no router is entered again from its own call, as a
  socket's delivery never is; the copy keeps a sender's buffer its own, as a socket's does.
- **A credential is carried beside a request**, any field value, as `POST /bead` carries one (15.5),
  and handed to the router with the envelope it came with, so a request presenting `ELSEWHERE`
  stands for it; **none toward a client**, as no server's transport carries one: a server's command
  presenting `ELSEWHERE` over it fails before it goes, `DESTINATION_UNREACHABLE` (13.4).
- **The address and the port its client gave as it connected** are handed with each envelope
  (15.1), so a refusal told names them (13.12): a gateway gives its HTTP caller's.
- **Secure at both ends**: it never leaves the process (13.4, 14.3's step 5), so a bearer credential
  crosses it.
- **Transfers taken**, under its routers' limits, and no bound, heartbeat or timeout of its own, as
  a Web Worker has none; its connect's timeout is every transport client's,
  `transportClient.connectTimeout`, by the way `memory`.
- **Either end closes a connection**, the other told in a later turn, the closer's close clean. A
  server's transport that stops closes each connection it holds and takes no connect; a connect then
  fails before anything goes.

**The Web Worker transport closes as the in-memory one does**, on the TypeScript side alone, the
C# side having no Web Worker client: a client's close is clean at its server as its `disconnect`
says, `bead-close`, or `bead-lost` for one that is not clean, and a server's close is unclean at
its client, as every client tells a close it did not ask for; a worker's `error`, an exception its
script did not catch, which ends no worker, ends the connection of the client's own, told once on
its `error` with the error's message and where it was thrown, before its close, unclean at both
ends (spec 15.1); and one before the connection opens, a script that fails to load, fails the
connect with a `ConnectError` at once.

**A joined server transport in each core** (spec 15.14): `joinTransports` on the TypeScript side,
`joined-transport-server.ts`, one `IServerTransportLike` over several; `JoinedServerTransport` on
the C# side, one `IServerTransport` over several. Nothing changes in the router, the server or
`offer`:

- **each handle is its own transport's**: the join keeps the handle each transport drew, and
  refuses, as it is built, two transports of one type, whose handles might be one; a server that
  serves two WebSocket listeners binds them in one transport, as each binds several addresses
  already;
- **each connection's flags are its owner's**: whether it carries a credential and whether it is
  secure are asked of the transport that drew its handle, and its `send` and `close` go to it;
- **its events are each transport's, forwarded**: a connection, a message, a listen, a close, a
  refusal and an error, each with its handle, in the order its transport told them, each listener
  called within 15.1's guard;
- **its stop stops every one**, and settles once all have; its gauges are their sum, each count and
  each ceiling, so 15.1's "its bounds, its gauges and its stop reach each" holds of the join;
- **its start is none of its own**: an application starts each transport it joined, at its own
  address; the join serves no port, and one port for two transports comes from a proxy in front of
  them, as the README has it.

## Consequences

**A connection costs a router client and a handle wherever a caller draws one**: a gateway that
draws one per HTTP exchange opens and closes a connection in the trace and the connections' gauge
for each, which is what HTTP is. Each side's bench measures a connection drawn, called once and
closed over the in-memory transport against calls on one connection kept, so that cost is a number
and a regression shows ([Measurement](../../README.md#measurement)).

**Two transports of one type are never joined**: an application with two WebSocket listeners gives
one transport both addresses. The join refuses the pair as it is built, before any handle could be
given twice.

**No conformance case holds either**: `spec/transports.json` plays real sockets alone, and no step
of it names what a process does within itself. Each side's twin tests hold them, by the same
sentence ([0004](0004-one-behaviour-in-every-language.md)), naming spec 15.13 and 15.14, which
`spec/units.txt` gives `twins`, and `docs/support.md`'s rows In memory and Joined name them. The
in-memory transport's:
`hands each envelope on whole, once and in order, in a later turn than its send`,
`carries the credential a request presents beside it, and none toward its client`,
`hands its router the address and the port its client gave as it connected`,
`draws a handle of type MEMORY for each connect, and gives none twice`,
`tells the other end of a close in a later turn, the closer’s clean`,
`closes each connection as it stops, and takes no connect after` and
`carries a transfer under its routers’ credit`. The joined transport's:
`hands on each transport’s events with the handle it drew`,
`asks each connection’s flags of the transport that drew it, and sends and closes through it`,
`refuses to join two transports of one type`,
`stops every transport it joined, and sums their gauges` and
`serves one service offered once to a client of each transport`. Beside them, each side's
conversation player plays, through a real pair of it, the conversations whose connections it can
stand for, so the transport carries what they need — a credential beside `ELSEWHERE`, the address a
tell names, a transfer — and the C# side's service tests link a server and a client through it,
`ServiceLink.cs` built on it. Its connect's timeout is a way of `spec/durations.json`, played by
each side's harness.

**Rust's core carries the in-memory transport first**, and plays its conformance over it before it
has a socket; the joined transport is a gateway's, and its core needs none.

**A broker in memory is a broker**, which repeats, reorders and delays on purpose
([0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)): it shares this transport's
delivery, a message copied and handed on in a later turn than its publish, never its guarantees,
copying, holding back, dropping and handing again to another member of a group as a test asks, and
past a subscriber's queue bound dropping as a broker whose queue is full does (spec 15.24;
[0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)).

## The Tenth Man

The in-memory broker met the round of the broker's core, which
[0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md) keeps.

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at
xhigh effort, in the round of HTTP/JSON transcoding, whose draft held the in-memory transport and
the join. The round met nine objections, each claim checked against the code, the texts it cites and
the probes before it was answered: eight accepted, one in part, none refused. Its objection on the
in-memory connection is this record's; the others are
[0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)'s.
A round of its own, on the Web Worker client's error, holds the other in-process transport to the
same close. The objections, with the answers that hold:

### On the in-memory connection

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The in-process gateway reaches no "same router": a server is built on one transport, its router on it, and a service is offered on one server, once (`IServer.transport`, `Server(IServerTransport …)`, "a service is offered on one server, once", "this service's server side is offered already"), so the in-memory transport is a second server's, with its own router, sessions, gauges and service manager, every service offered twice, a notification reaching one, a session ended by its identifier on one. The draft treats the joining as done and names no piece that does it, though its flags are per connection already. | Accepted, by its first way. Each core gains a joined server transport, `joinTransports` and `JoinedServerTransport`: each handle its own transport's, each connection's flags, sending and closing asked of the transport that drew it, the events forwarded within 15.1's guard, stop and gauges over all, two transports of one type refused as the join is built, since 0025's handle tells two types apart and may not tell two of one type; nothing changes in the router, the server or `offer`. Spec 15.14 states it, and this record keeps it beside the in-memory transport, with its twins and its rows of the matrix. A server of its own for the gateway was weighed and refused: two offers, two session managers, the application keeping them in step. A mount on the HTTP transport buys the router nothing once the join exists, and couples a transport to a gateway against the README's rule: a gateway answers on its own listener or as a handler an application mounts. |

### On the Web Worker client's error

| Objection                                                                                                                                                                                                                                                                             | Answer                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Web Worker client turns its worker's `error`, an exception the worker's script did not catch, which by HTML's "report an exception" ends no worker, into an unclean close, and tells no `error`, though spec 15.1 has a transport report what it ends a connection for of its own | Accepted: the client ends the connection of its own, so it tells one `error` as the connection ends, before its close, unclean, naming the error's message and its `filename:lineno:colno` where given; `IWorkerLike`'s listener takes the event, and spec 15.1 names the case |
| Its server hears that close clean, since the client posts `bead-close` whatever ended it, where spec 15.13 has the in-memory transport's server hear a client's close as clean as the client says                                                                                     | Accepted: a close the client sends after its worker's error posts `bead-lost`, beside `bead-close`, which its server tells unclean, as it does a `disconnect` that is not clean; a plain `disconnect` stays clean, so the two in-process transports agree                      |
| A worker whose script fails to load fires its `error` before the connection opens, HTML's "run a worker", and the connect waits out its timeout                                                                                                                                       | Accepted: a worker that errs before the connection opens fails the connect with a `ConnectError` at once, its words the error's                                                                                                                                                |
| A behaviour of the TypeScript side alone, with no twin, breaks the rule that both sides play one behaviour                                                                                                                                                                            | Refused: the C# side has no Web Worker client, as `docs/support.md` states; there is nothing to twin                                                                                                                                                                           |
