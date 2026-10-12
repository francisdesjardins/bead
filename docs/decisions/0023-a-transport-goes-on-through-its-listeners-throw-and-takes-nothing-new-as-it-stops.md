# 0023 — A transport goes on through its listener's throw, and takes nothing new once its stop began

- **Status**: accepted
- **Scope**: the protocol, and every implementation's transports, server and client: the guard on a
  transport's listeners in section 15.1 of [`spec/spec.md`](../../spec/spec.md), and what a stop
  answers what arrives as it runs, 15.2, 15.3, 15.6 and 15.7. HTTP's draw of a connection is
  [0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)'s, and a debug listener's
  throw [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s.

## Context

**A listener of a transport's event runs the application's code inside the transport.** A transport
tells a connection opened, an envelope, a listen and a close to whoever listens: its router first,
then any listener the application adds. What one of them throws lands where its platform puts an
error nobody caught, and the two platforms put it at the two ends of the range. On Node 26.5, a
listener that throws out of a socket's callback reaches `uncaughtException`, and the process ends:
measured for a `connection` and a `message` listener over HTTP and over a WebSocket, each ending the
process. On .NET 10.0.401, a throw out of a Kestrel request is ASP.NET's unhandled exception, a 500
its logger alone hears, and the process goes on; out of a timer callback, an idle connection's or an
exchange's, the process ends. One bug of an application's ends a server on one side and vanishes on
the other.

Three reactions were weighed:

- **The connection closed as lost, or the exchange answered 500**: a reaction of the transport's own
  to its listener. The router listens first, so a listener that throws after it is the
  application's, and the router's answer then finds its exchange gone, or a 500 written over it; a
  client counts an unmarked 500 lost and drops a connection its server keeps.
- **The throw told uncaught**, on a microtask or as an unobserved task: Node's `uncaughtException`
  ends the process, and .NET's `UnobservedTaskException` fires when a collection finalizes the task
  and ends nothing. One word for a crash on one side and a silence on the other, against
  [0003](0003-one-word-one-meaning.md) and [0004](0004-one-behaviour-in-every-language.md).
- **The throw reported, and the next listener called**, as the DOM Standard's "inner invoke" (§2.10)
  does: each listener in turn, and "if this throws an exception, then report the exception", which
  HTML fires as the global's `error` event, never a throw into the dispatcher and never an end of
  the page. Bead holds that rule for a debug listener (`debugging.md` 2.2, 2.3;
  [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)): each within a guard, its throw
  reported as spec 9.0 reports an error, through an `error` event, with the connection.

Where it is told was weighed too: through the transport's own `error`, where a socket's error goes,
which every TypeScript transport, server and client, carries, and C#'s WebSocket transports carry as
`Error`; or through the router's, its interfaces `IRouterServerTransport` and
`IRouterClientTransport` each gaining an `error` its router re-emits with the connection, so that
one listener hears everything. The second widens two public interfaces for every transport.

**A stop races what arrives.** Kestrel delivers exchanges and accepts on its own threads until its
host's `StopAsync`, so an exchange or an upgrade arrives once a stop began. Node's HTTP stop closes
every connection, its server and its idle sockets in one turn, and an HTTP/2 session's close sends
GOAWAY and refuses new streams. At a WebSocket's address, `ws` 8.22's `close()` removes its
`upgrade` listener; an upgrade whose head ends after that reaches Node's `shouldUpgradeCallback`,
which says true, and Node destroys the socket unanswered, since nobody listens to `upgrade`.
Measured on a real socket, the head in two writes, one each side of the stop: the socket destroyed,
no answer. With the callback false, Node raises `request`, and the transport's own listener answers
it. A connection drawn, or a socket kept, once a stop began is one nothing closes: the stop has
taken its snapshot.

**A Bead stop is no drain.** HTTP/2's GOAWAY
([RFC 9113 §6.8](https://www.rfc-editor.org/rfc/rfc9113#section-6.8)) stops new streams and lets
established ones finish; a Bead stop closes every connection it holds as lost (spec 15.7), so
GOAWAY is not its standard. A refusal while a server stops is HTTP's 503
([RFC 9110 §15.6.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4)), "temporary overload or
scheduled maintenance", with a `Retry-After` in delay-seconds
([§10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)); a WebSocket's refusal before its
handshake is HTTP's ([RFC 6455 §4.2.2](https://www.rfc-editor.org/rfc/rfc6455#section-4.2.2)), and
its close as a server goes down is 1001, going away
([§7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1)).

## Decision

**A transport goes on through its listener's throw** (spec 15.1). Each listener of a transport's
event, a connection opened, an envelope, a listen or a close, is called within its own guard, on
every transport, server and client, on both sides: what one throws is reported, as spec 9.0 reports
an error, through its transport's `error` event with the connection it was told of; the listeners
after it are called all the same; and the transport goes on as if it returned. Its connection is
drawn and its 201 written, or its socket kept; its envelope is handed on, and the router's answer
written; its close is done. A listener's throw refuses no connection, fails no exchange and closes
nothing. It is [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s rule for a debug
listener, carried to the transports, and the DOM's inner invoke is its standard. A listener of the
transport's `error` that throws is its platform's, as a listener of a router's `error` is.

**The transport's `error` is where it is told.** Every TypeScript transport carries one, and its
emitter returns `false` for an `error` nobody listens to, so a report ends nothing. On the C# side,
`HttpTransportServer` and `HttpTransportClient` carry `Error` in their WebSocket siblings' shapes,
`Action<Exception, string>` on a server, the connection's handle last, and `Action<Exception>` on a
client. The routers listen to a transport's `connection`, `message` and `close` alone, and forward
none of its errors to their own: an application hears its transport's on the transport it built,
`server.transport.on('error', …)`, the concrete transport's `Error` on the C# side, where a socket's
error already goes.

**Once its stop began, a server takes nothing new** (spec 15.2, 15.6, 15.7). Over HTTP it draws no
connection, a connect it would take refused 503 `busy`, its `Retry-After` 1, judged where
`maximumConnections` is judged, after the connect's own 400 and 415; and it holds none, an exchange
that presents a well-formed token answered the 404 marked `connection-unknown`, unlooked-up and
nothing of it handed on, as the stop answers each listen it holds, and as the exchange is answered
once the stop closed its connection. At a WebSocket's address, an upgrade it would take is refused
503 `busy`, its `Retry-After` 1, marked and stamped as 15.6 says, after 15.2's refusals. A request
refused for what it is, its host, its path, its origin, its method, its type, its token's form, is
refused so whether or not a stop began: what a request is comes before when it came, as the
connect's own 400 comes before its 503. On the TypeScript side, Node's `shouldUpgradeCallback` says
false once the HTTP server that received the request no longer serves, and the transport's `request`
listener answers the refusal.

**A connection that registers as the stop begins is closed going away, 1001** (spec 15.3), by a
guard at registration. No pass of the stop looks again for one: on the C# side, the host's
`StopAsync` waits on the request the guard closes, bounded by the close timeout; on the TypeScript
side, `ws` takes no upgrade once closed, and the guard is reached by an injected `WebSocketServer`
that delivers a connection after its `close()`.

## Consequences

**A throw nobody listens for is unseen, on both sides alike**: the cost
[0013](0013-every-language-debugs-alike-at-no-cost-when-off.md) takes for a debug listener. Neither
process ends for it. A listener of Bead's own that throws, its router's or its server's, is reported
the same way, and a connection it leaves untracked lives until its transport closes it, over HTTP at
its `inactivityTimeout`.

**An application listens for errors in two places**: on its router, for what spec 9.0 reports, and
on its transport, for a socket's error and a listener's throw. A router that re-emits its
transport's `error` widens `IRouterServerTransport` and `IRouterClientTransport` for every
transport, and is a decision of its own, which meets the Tenth Man.

**A transport server's error with no connection stays a row of the support matrix**: Kestrel's own
late errors go to its logger alone, so the C# side raises `Error` for a listener's throw and none
for those.

**No platform row for a stop crossed by an arrival**: both sides answer it alike, the TypeScript
side through Node's `shouldUpgradeCallback` and `request`, which are the transport's own. The
matrix's row for a stop at the WebSocket server names what each side waits on.

**An event iterator keeps what its loop has not read, without bound**, as Node's `events.on` does by
default: a transport delivers a burst in one synchronous turn, so a bound on what waits between two
reads ends a loop that is not behind. A bound that tells its loop of a lag and lets it go on, as
tokio's `broadcast` tells `Lagged` or .NET's `BoundedChannelFullMode.DropOldest` drops, comes to
both sides at once with a C# iterator, a decision of its own, which meets the Tenth Man.

**No conformance case holds it.** No step of `spec/transports.json` installs a listener of the
application's, and both runners play a `stop` to its end before the next step, so no step sends into
a stop's window. Twin tests hold it on each side, by the same sentence, each window opened by a
listener the stop calls, a head written in two halves or a scripted `WebSocketServer`:
`draws a connection whose connection listener throws, the next listener told, the throw reported with it`;
`hands on a request whose message listener throws, its answer still written, the throw reported with its connection`;
`refuses a connect that comes as it stops, busy, told when to come back, drawing nothing`;
`answers the 404 marked connection-unknown an exchange that comes as it stops, its connection not yet closed, nothing handed on`;
`refuses an upgrade that comes as it stops, 503 busy, told when to come back`;
`closes going away a connection whose accept a stop crossed`; and the clients'
`hears the next message after a message listener throws, the throw reported`
([0004](0004-one-behaviour-in-every-language.md)).

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round. Its objections, each with the answer that holds:

### On a transport's listener that throws, and a stop crossed by an arrival

| Objection                                                                                                                                                                                                                                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bound on `events()` ends a consumer that is not behind: a transport delivers a burst in one synchronous turn, so any burst past 1,024 ends the loop or throws in it, and Node's `events.on` and tokio's `Lagged` end nothing                        | Accepted: measured over a real `ws`, 2,000 sent and 1,025 read, then the end. No bound, as Node's default; the iterator's doc comment says how a loop ends. A bound that tells its loop of a lag and lets it go on comes to both sides at once, by a decision of its own, with a C# iterator that closes the matrix's row for an iterator of every event. That a silent end hides a loss is accepted; an error once the iterator drained, refused: it rejects a loop nobody awaits, which ends Node                                                                                                                                                                                                                                                                                                                  |
| The TypeScript side can refuse an upgrade a stop crossed as the C# side does: Node calls the transport's `shouldUpgradeCallback` and `request` listener before `ws`, and destroys the socket unanswered because `ws`'s `close()` removed its listener | Accepted: measured, no `upgrade` listener left once `ws` closed, the socket destroyed unanswered; with the callback refusing, the `request` listener answers 503 `busy`, marked. Both sides refuse it 503 `busy`, `retry-after: 1`, marked, after 15.2's refusals, and twin tests open the window on a real socket. No platform row. The TypeScript 1001 guard stays, commented as an injected `WebSocketServer`'s, its scripted test made to open the window, twin of the C# side's                                                                                                                                                                                                                                                                                                                                 |
| A throw "told uncaught" still ends the Node process, is silence on .NET under the same word, and reverses Bead's rule for a listener's throw                                                                                                          | In part: the rule accepted whole, its claim that the matrix's row for a transport server's error with no connection closes refused. `debugging.md` 2.2 and [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md) report a listener's throw through an `error` event with its connection, and [0003](0003-one-word-one-meaning.md) and [0004](0004-one-behaviour-in-every-language.md) rule out one word for a crash and a silence. Each listener within a guard, its throw reported through its transport's `error`, server and client; no throw is told uncaught; the C# side's HTTP transport server and client carry `Error`. The row narrows and stays: Kestrel's own error with no connection still goes to its logger alone. A router that forwards its transport's `error` is a decision of its own |
| A stop that looks again for connections until none are left never looks twice on the TypeScript side and adds nothing on the C# side                                                                                                                  | Accepted: on the TypeScript side no upgrade crosses a stop once `ws` closed; on the C# side the host's `StopAsync` waits on the request the registration guard closes, bounded by the close timeout. No second look; the guard stays, commented so                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A conformance case holding a listen across a stop and asserting its 404 contradicts the matrix's row for a stop over HTTP, whose C# grace may cut that 404 before the wire                                                                            | Accepted: no case. With `orLost` it would prove only that the stop ends the listen; that row's twin tests stay the proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Citing RFC 9113 §6.8, GOAWAY, a drain, for a stop that closes every connection as lost                                                                                                                                                                | Accepted: 15.7 and 15.2 cite RFC 9110 §15.6.4 and §10.2.3 for the 503 and its `Retry-After`, and nothing for "holds none", which is Bead's own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
