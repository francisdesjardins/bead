# Bead, on the TypeScript side

Bead is a binary wire protocol: the envelopes of a request, its result or failure, the notifications
of a subscription and the commands a server sends back, written at fixed offsets. This project is
its TypeScript implementation — a WebSocket, an HTTP, a Web Worker and an in-memory transport, each
a client and a server, a server's transports joined into one, a client and a server router over
them, the service, session and notification managers, the client and server that put the three
layers together, the service layer a service is served and called through, and a gateway that
answers its procedures over HTTP and JSON, beside the caller of the HTTP client beadc generates.
Nothing in it imports a framework at run time. The specification and the conformance files both
sides play are in [`spec/`](../../spec/).

```ts
import { createWSTransportClient } from '@francisdesjardins/bead/ws-transport-client';
import { createWSTransportServer } from '@francisdesjardins/bead/ws-transport-server';
import { createHTTPTransportClient } from '@francisdesjardins/bead/http-transport-client';
import { createHTTPTransportServer } from '@francisdesjardins/bead/http-transport-server';
```

## The transport

`transport-client`, `ws-transport-client`, `transport-server` and `ws-transport-server` are the
first layer of a transport → router → service stack, which is why they sit together under
`src/transport/`, split the way the rest is: `client/`, `server/`, and the `shared/` both stand on.

Each end — client or server — has a shared half and a transport. The shared half owns the events and the guards
around the life of the connection — `reconnect` and the drop behind `await using` for a client, `start` and `stop`
and the connection registry for a server. The transport supplies what only it knows: how to open,
close and send on the wire. WebSocket, HTTP, a Web Worker and memory each supply theirs — see
[HTTP](#http) and [In memory](#in-memory-and-a-servers-transports-joined); another transport
supplies its own.

The client runs on the global `WebSocket` — every browser, and Node 24.9, the package's floor — or
on any constructor passed as `WebSocket`, which is how `ws` plugs in; its suite runs on both. The
server has no global to fall back on, so it always takes `ws`'s `WebSocketServer`, and its suite
talks to it through the client, on both.

Each WebSocket end beats: every `heartbeat` milliseconds — 30,000 by default, `Infinity` for none —
it sends WebSocket's own PING control frame (RFC 6455 §5.5.2), and drops a connection that left the
one before unanswered, whose `close` then says it was not clean. A peer gone without a word — a
cable pulled, a machine asleep, a NAT that forgot — ends in a `close` within two beats rather than
never. A browser's socket cannot ping, but answers the server's pings by itself, so the server's
heartbeat covers it; the client beats over `ws`. A heartbeat keeps nothing of a session alive: a
session's timers count what the peer says, not that it answers. Bead has no ping of its own: whether
a connection is alive is its transport's to know.

Each end takes a message of an envelope's limit, 16,778,240 bytes, `MAXIMUM_MESSAGE_BYTES`, unless
its `maxPayload` says otherwise, and fails a connection that sends a larger one with 1009; over the
global `WebSocket`, its platform's bound applies. Each end drains it until the peer's close or its
`closeTimeout`, its close unclean whatever the peer answers, and reports it on `error`, naming
`maximumMessageBytes` and its value, as it reports a protocol error, before its close; a client over
the global `WebSocket`, whose `error` cannot be told from a drop, tells its close alone (spec 15.1,
15.3). The `closeTimeout` of each end, 5 seconds, `CLOSE_TIMEOUT`, bounds each close it begins, and
`ws` is given it; over the global `WebSocket`, the client's close is its platform's to bound. A
WebSocket server judges a request at its address in the order of spec 15.2: 400 as HTTP answers it
to a field holding a control character but a tab or an octet past ASCII, to a target holding an
octet other than visible ASCII or a path whose percent-decoding holds NUL, to a `Host` missing,
repeated or no host, or to a target in absolute-form that names none; 403 to a host it does not
take, whatever the request; 405 to a method but `GET` or `HEAD`; 426 to a request that asks no
WebSocket, a `HEAD` and an `HTTP/1.0` request among them, and to a version but 13, the one it
speaks; 400 to a malformed upgrade, two `Authorization` lines among it; 403 to an `Origin` neither
its own nor among `origins`; 503 `busy`, its `Retry-After` 1, to an upgrade it would take past
`maximumConnections`, 10,000, or `maximumConnectionsPerAddress`, 64, or once its stop began. Each
refusal but HTTP's own is marked, its body empty, closes its connection, and is told, `refusal`; an
`Upgrade` listing `websocket` among other protocols is taken — see [HTTP](#http). An upgrade takes
its place as it is judged, after its origin, and holds it until its socket closes, so upgrades that
cross take no more places than there are; behind a proxy, every client is the proxy's address unless
`trustedProxies` or `unnamedProxies` names it, and its health warns once its busiest address holds
80% of `maximumConnectionsPerAddress`, before the first 503, gauged `largestAddressConnections`. A
head that does not come whole within `headersTimeout`, 30 seconds, is answered 408 by Node's own
parser.

What waits for a client's socket — what the server handed it that the socket has not taken — is
held to a pace, as Kestrel holds a response to its `MinResponseDataRate`: each envelope moves the
connection's deadline by the time its bytes take at `minimumSendBytesPerSecond`, 240, its grace
`sendGracePeriod`, 5 seconds, at least, and a socket that still holds something past it, judged
each second on the real clock, is dropped. An envelope that would take what waits past
`maximumUnsentBytes` drops it too: what a peer that keeps every rule can be owed at once,
184,551,424 bytes under the limits by default, which `createWSServer` derives from its router's.
Each drop is reported on `error` as its connection closes, naming its bound and its value, and its
close is not clean; the heartbeat drops a reader that stops behind a large backlog besides. A paced
subscription queues on the server what a client that falls behind has not credited.

A server listens on `localhost` unless `start` is given an `address`: both loopbacks, `127.0.0.1`
and `::1`, on one port, as Kestrel's `ListenLocalhost` does, so no other process can answer a client
that reaches it by `localhost` on the family it tries first (spec 15.12). `127.0.0.1` binds first,
on the port given or one drawn there, then `::1` on that port; a port another socket holds on either
fails the start, and a drawn one is drawn again, eight times at most. Where the IPv6 loopback is
absent — a container with IPv6 off — it listens on `127.0.0.1` alone and reports `127.0.0.1`, its
`address` and its `start`'s, where Kestrel would say `localhost`. An `address` given is
`localhost`, both loopbacks as above, or an IP address written bare, as RFC 3986 writes one, which
it listens on alone: a container, or any server another machine reaches, says `0.0.0.0` or `::`,
and names its hosts. Any other name — `LOCALHOST`,
`localhost.`, `a.localhost` — `[::1]`, `127.1` or `0` fails the start, a `ProgrammerError`. On the
loopback it is secure (spec 13.4); behind a proxy on the same machine that serves the network in the
clear, it says `secure: false`. A client that connects by `localhost` reaches it whichever family it
tries first, Node's and the browsers' racing them (RFC 8305); a server given one loopback,
`127.0.0.1` or `::1`, leaves the other's port to any process that listens there, which then answers
a client that tries that family first. A server meant for other machines and given no address is
refused there by the network, its connection reset or refused, never by a Bead refusal: no socket
opens, so nothing is told.

Each refusal a server judges of its own it tells, `refusal`, once written: its status, its reason,
the request's authority and its `Origin` as they came, and the client's address and port — never
the target, a token or a credential: what to add to `hosts` or `origins`, or who is refused. The 404
that ends a listen or an exchange as its connection closes is told by `close`; what HTTP refuses of
its own, unmarked, by nothing. A client names the status and the reason it was refused with, but
over the global `WebSocket`, a page's, which reads nothing past its close, 1006. Each string a
refusal carries is the client's, visible ASCII, spaces and tabs: a log quotes it.

```ts
server.on('refusal', ({ address, authority, origin, port, reason, status }) => {
  console.warn(
    `refused ${String(status)} ${reason}: authority ${JSON.stringify(authority)}, origin ${JSON.stringify(origin)}, from ${String(address)}:${String(port)}`
  );
});
```

```ts
import { WebSocketServer } from 'ws';

const server = createWSTransportServer({ WebSocketServer });
server.on('message', ({ data }, connectionHandle) => {
  void server.send({ data }, connectionHandle);
});
const { port } = await server.start({ findOpenPort: true });

const client = createWSTransportClient();
client.on('close', (clean) => {
  if (!clean) {
    client.reconnect({ signal: AbortSignal.timeout(30_000) }).catch((reason: unknown) => {
      console.error(reason);
    });
  }
});
await client.connect({ host: 'localhost', port });
await client.send({ data: 'hello' });
```

Each listener of a transport's events is called within a guard: what one throws goes to the
transport's `error`, the next listener is called all the same, and the transport goes on as if it
returned (spec 15.1). It awaits nothing a listener returns, so a listener's rejection is Node's, as
what a listener of `error` throws is: an unhandled rejection ends the process, and a listener
catches its own, as the `reconnect` above does. Neither client reads a `Retry-After`, which a
server's 503 `busy` carries and spec 15.7 lets a client wait for: a reconnection waits its own
schedule, whatever the field asks.

What a transport carries, both ways, is a message, `{ data, credential }`: an envelope, and the
credential the transport carries beside it, which a request presenting `ELSEWHERE` stands for. Over
HTTP it is the `Authorization` of the `POST` that carries a request — see [HTTP](#http); over a
WebSocket, the `Authorization` of an upgrade that carries no `Origin`, beside every envelope of its
connection, toward its server alone — see below; a Web Worker carries none, either way. Each end
says what it can carry, so its router fails before it goes a call whose credential it cannot: a
client's `carries(credential)` — over HTTP any field value, over a WebSocket the bytes its upgrade
carried alone, compared in constant time — a server's `carriesCredential(connectionHandle)`, none
toward a client, and `isSecure`, judged by what the end was given, never by what a name resolves to
— a client by the URL of its connect, under TLS (`wss`, `https`) or to a loopback host (`localhost`,
a name in `.localhost`, 127.0.0.0/8, `::1`, the host as the WHATWG URL Standard's host parser reads
it: `127.0.0.1.` is on the loopback, a host followed by a space is not); a server, per connection,
by what it listens on — an address in 127.0.0.0/8, `::1` or `localhost`, or, over HTTP, a server
under TLS — unless its application tells it what stands in front of it, `secure`: `true` for TLS
terminated before it, which makes each connection secure, `false` for a proxy that serves the
network in the clear, which leaves each in the clear; a worker always, since it never leaves the
machine.

A WebSocket client writes the credential its connect is given in its upgrade's `Authorization`: a
string, `credential`, or `credentialProvider`, whose value each attempt awaits, a reconnection's
included, with the attempt's `signal` — where a credential past its end is renewed, as SignalR's
`accessTokenFactory` is (spec 15.2, decision 0032). A client has one call of its provider under way
at a time: an attempt that comes while one is waits for its outcome, and one that meets a call no
attempt waits on any more lets it settle before it calls again, each within its own bounds, its
cancellation, its timeout and the client's dispose, which end it at once whatever the provider does.
A value that comes late is handed only to an attempt still waiting for it, and a failure that comes
late is observed, never left unhandled. The attempt's `signal` is aborted once the attempt ends, in
a later turn than its connect settles, so what a listener of it throws never takes the place of the
connect's outcome; a provider that cancels itself while that `signal` is still live fails its
attempt as any failure of its does. The server hands it beside every envelope of that connection, as
it came, trimmed, so a request presenting `ELSEWHERE` stands for it, resolved per request by the
verifier, as over HTTP: one that no longer holds, or whose end has come, is refused on the request
that presents it, and the connection stays. One connection carries one credential: a client presents
another by connecting again, its provider handing the new one, and gives its router's default
`ELSEWHERE` the same bytes, from one source; between the two, a call fails before it goes,
`DESTINATION_UNREACHABLE`. A connect refuses, a `ProgrammerError`, nothing moved: a credential and a
provider together; one that is no field value — anything but visible ASCII, spaces and tabs, or a
space or a tab first or last; one over `ws://` off the loopback, its upgrade crossing in the clear;
and one over a `WebSocket` without `ws`'s shape — a page's, Node's global — which writes no field of
its caller's choosing: a page presents a `JWT`, in the envelope. A value the provider hands that is
no field value fails its attempt the same way, which a reconnection does not try again; what it
throws fails that attempt, its cause. An upgrade that carries an `Origin` carries none, whatever its
`Authorization`: a page's browser writes its own authentication on it, as it sends its cookies, so
any page the server takes would present its user's credential. Two `Authorization` lines on an
upgrade are refused 400, `malformed`. No client follows a redirect: a 3xx answered to an upgrade
fails its connect, its status named over `ws`, "the server refused the upgrade: 302". The
`connection` event shows an upgrade as the HTTP server shows a connect, headers aside — its method,
its target and its peer — so no event carries its credential.

```ts
import { WebSocket } from 'ws';

// one source for the upgrade's credential and the router's default, renewed together
let token = await signIn();
const elsewhere = () => {
  return { carried: `Bearer ${token}`, scheme: CredentialScheme.ELSEWHERE } as const;
};
const client = createWSClient({ credential: elsewhere(), transport: { WebSocket } });

client.router.on('credentialWithdrawn', () => {
  void signIn().then(async (renewed) => {
    token = renewed;
    client.router.credential = elsewhere();
    // a new connection, whose upgrade the provider gives the new credential
    await client.reconnect();
  });
});
await client.connect({
  credentialProvider: () => {
    return elsewhere().carried;
  },
  host: 'localhost',
  port,
});
```

Each end takes its time from a `clock`: the part of the globals Bead calls — `setTimeout`,
`clearTimeout`, `setInterval`, `clearInterval`, `Date.now` and `performance.now` — in their own
shape, so the platform's, `globalThis`, is the default, and `@sinonjs/fake-timers`' `createClock()`,
never installed on the globals, is a test's. A stack has one clock, set where it starts and read
upward: a router or a server built on a transport runs on the transport's, a server's sessions on
the server's, a service manager on its router's, and one given that differs is a `ProgrammerError`.
Each transport, router and session manager exposes the one it runs on as `clock`. What bounds a
platform's own close stays on the real clock — a ping, a WebSocket's close handshake, its client's
and its server's, the HTTP client's disconnect. A timeout past `LONGEST_TIMER`, 2³¹ − 1
milliseconds, is refused wherever one is taken; never is `Infinity`, which arms nothing of
Bead's own: a close over `ws` still arms `ws`'s timer, held to `LONGEST_TIMER`.

The router's layer sits under `src/router/`. Both sides build on one core, under `shared/`: it
writes the envelopes that go out and reads those that come in, pairs each result and failure with
its request by call id, sends a payload too large for one envelope as a transfer and puts one that
comes as a transfer together, and hands each request to the resolver registered for it. A side is
what it adds, and the failures it raises: each router carries its own table, `CLIENT_FAILURES` or
`SERVER_FAILURES`, both made by `failureTableOf(side)`, so a refusal says which side refused.

### The Bead envelope

The router's protocol is called Bead, after Baily's beads — the points of light that break through
along the edge of the Moon at an eclipse. Its unit is the envelope: a fixed 8-byte prefix, in network
byte order, then a part of the kind's own, then optional blocks, then the payload. There is no
length field: each transport delimits the envelope, as WebSocket does with its messages.

```text
A1 10 00 03   00 00 00 03   00 02 00 01 | 68 69
│  │  │  │    └─ call id ┘  └ svc ┘└proc┘  payload "hi"
│  │  │  └ header words (3 × 4 = 12 bytes)
│  │  └ flags: DESTINATION 0x02 (4 bytes), TRANSFER 0x04 (8 bytes), CREDENTIAL 0x08 (last);
│  │          SUBSCRIPTION 0x10, PACED 0x20, MORE 0x40 (on a chunk), which add none
│  └ kind: REQUEST 0x10, RESULT 0x11, FAILURE 0x12, NOTIFICATION 0x13, CHUNK 0x14, CREDIT 0x15,
│          CANCEL 0x16
└ layout: 0xA1
```

A request is 12 bytes of header, a result 8, a chunk and a credit 16, a cancel 8 and nothing after
it. The flags of the low nibble each add a block, in the order of their bits, CREDENTIAL last, and
0x01 is kept for a block to come; those of the high nibble add none, and 0x80 is kept: a reader knows
a header's length from `flags & 0x0F`, and with CREDENTIAL from the length its block states — its
credential scheme on 2 bytes, its length on 2, its bytes padded to a word. A flag its kind does not take makes the envelope malformed. The kinds 0x17 to 0x7F are the ones to come, and are reported; those from 0x80 are advisory, and
skipped. A first byte outside 0xA1–0xAF is not an envelope at all, and is refused as malformed. A
call id is odd when a client opened the call and even when a server did, as HTTP/2 numbers its
streams, so the two sides never draw the same one; a subscription's notifications carry the call id
of the request that made it.

What does not read goes through one gate: a request whose prefix reads, of the peer's parity, on a
call id that is neither open nor held, is answered with a failure on that call id — a layout to come
with `LAYOUT_UNSUPPORTED` and the layouts this peer reads; an answer of this layout ends the call it
answers, and a chunk the transfer it was for, while its payload is not whole. Anything else is
reported, never answered, save an answer or a chunk that comes late on a call id reserved, or a
chunk on a call abandoned, dropped in silence. An answer goes out only while its call is open: one
whose connection closed, whose requester cancelled it, or whose call id the peer has opened again,
goes nowhere, since it would settle a call it does not belong to.

A requester that ends a call it holds open — its timeout passed, its signal aborted, its answer
unreadable, a transfer refused, a subscription unregistered — sends a cancel: the prefix alone, on
that call id, never answered. The other end forgets the call, takes away what it subscribed, then
aborts the signal its resolver holds, so nothing more goes out on that call id; a cancel for no call
has crossed its answer, and is dropped in silence. The requester reserves the call id as long as the
call was given, 5 s when it was given no time or waited without end — and, once a result came to it
as a transfer, as long as the other end keeps the call abandoned, should that be longer: its draws
skip it, and what comes late on it is dropped in silence.

A failure travels once, in a failure's payload: its code on two bytes, the relays it crossed, whether
the code is the procedure's own, and a readable detail — `maximumDetailBytes` at most, 1,024 by
default, and never past what its envelope holds. The protocol's codes come in blocks of 16, by how
far a request went:

| Code | Name                       | Raised when                                                                                                                                                                               |
| ---- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `ENVELOPE_MALFORMED`       | the bytes are not an envelope this layout reads                                                                                                                                           |
| 2    | `LAYOUT_UNSUPPORTED`       | the layout is one to come                                                                                                                                                                 |
| 3    | `KIND_UNSUPPORTED`         | the kind is one to come, or one this side does not take                                                                                                                                   |
| 4    | `ENVELOPE_TOO_LARGE`       | the envelope is larger than this peer reads                                                                                                                                               |
| 16   | `DESTINATION_UNKNOWN`      | the request names a destination its relay has none of — or its router relays nothing                                                                                                      |
| 17   | `DESTINATION_UNREACHABLE`  | the relay could not hand the request to its destination, or a transport cannot carry its credential — leg B's, or the requester's own: nothing was tried                                  |
| 18   | `SERVICE_UNKNOWN`          | no resolver is registered for the service                                                                                                                                                 |
| 19   | `PROCEDURE_UNKNOWN`        | the service is known, the procedure is not                                                                                                                                                |
| 20   | `CALL_UNKNOWN`             | an answer or a chunk belongs to no call, nor to a call id reserved or a call abandoned                                                                                                    |
| 21   | `SUBSCRIPTION_UNKNOWN`     | a notification comes under no subscription, nor a call id reserved                                                                                                                        |
| 22   | `SUBSCRIPTION_UNSUPPORTED` | the request opens a subscription on a path that carries no notification back: a relay, a connection over HTTP whose client does not listen                                                |
| 32   | `SESSION_REQUIRED`         | the procedure needs a session the call has not, or the credential the request presents does not hold                                                                                      |
| 33   | `ACCESS_DENIED`            | `beforeRequest` refused the request, on its header and the call's session                                                                                                                 |
| 34   | `PAYLOAD_TOO_LARGE`        | a payload or an envelope going out passes its limit, a transfer declares no bytes, or a payload needs a transfer it cannot have                                                           |
| 35   | `CAPACITY_EXCEEDED`        | every call id of the side is in use or reserved, or the transfers received hold every place or the budget                                                                                 |
| 36   | `CREDENTIAL_UNSUPPORTED`   | the request presents a credential of a scheme the side takes none of, and its detail names those it takes                                                                                 |
| 48   | `CHUNK_INVALID`            | a chunk runs past the total or past full, is empty, does not read, is short with MORE set, says wrongly if it is the last, overlaps bytes received in part, or leaves too many runs apart |
| 49   | `CREDIT_EXCEEDED`          | a chunk runs past the credit granted                                                                                                                                                      |
| 50   | `PAYLOAD_UNDECODABLE`      | the procedure's serializer cannot read the payload                                                                                                                                        |
| 51   | `TRANSFER_STALLED`         | nothing came for a transfer through its inactivity timeout                                                                                                                                |
| 52   | `PAYLOAD_INVALID`          | the payload reads, and its procedure's rules refuse it: its violations in its detail (spec 18)                                                                                            |
| 64   | `PROCEDURE_FAILED`         | the resolver failed before it answered, its admission threw or a verifier failed, or its result could not go out: past what its side sends, or past what leg A of a relay carries         |
| 65   | `DESTINATION_LOST`         | the relay handed the request on, then lost its destination: the procedure may have run                                                                                                    |

A requester catches a `FailureError`: `isProtocol(codes, side?)` for the protocol's codes,
`isApplication(codes?)` for the procedure's own, so a service's code 19 never passes for
`PROCEDURE_UNKNOWN`. Which side raised it is deduced, never sent; through a relay, it is not known,
so `isProtocol(codes)` passes and `isProtocol(codes, side)` never does.
[0001](../../docs/decisions/0001-the-envelope-sits-at-fixed-offsets.md) records why the envelope
is laid out this way.

`router-client` runs over any transport that meets `IRouterClientTransportLike`, and learns the
session the server announces — only when it changes, on an answer. A request presents the
credential its options give, or the client's default, in its header's CREDENTIAL block. The
default, `credential` among a client's options, is a `JWT`, `{ scheme: CredentialScheme.JWT,
token }`, or an `ELSEWHERE`, `{ scheme: CredentialScheme.ELSEWHERE, carried }`, whose value the
transport carries beside each request; a request's own `credential` wins over it, and `{ scheme:
CredentialScheme.NONE }` presents none. The session the client learned is presented only when a
request's options ask, `credential: { scheme: CredentialScheme.OPAQUE }`, never by default: that
call is bound to that session, and refused `SESSION_REQUIRED` should it have ended or been opened
anew, rather than run in another; one that asks before any session fails before it goes. A call
presenting none runs in whatever session its connection holds.

A default is withdrawn once a call that presented it is refused `SESSION_REQUIRED`, whatever relays
the refusal crossed: the router emits `credentialWithdrawn` with the credential's scheme alone,
never its bytes, so the application renews it, and from then on, until the application gives it a
default again — a credential, or `undefined`, which says "anonymous" in writing — every call that
would present it fails before it goes, `SESSION_REQUIRED`, nothing sent and nothing withdrawn, so no
call falls to its connection's session, or to none, in silence; `isCredentialWithdrawn` says so. A
call that gives its own credential, `{ scheme: CredentialScheme.NONE }` among them, goes: a call
that needs no identity presents none, and so does the call that renews. A refusal withdraws only the
credential its call presented, never a default given anew since, and a failure that ends a
subscription its server had answered withdraws nothing, over HTTP even when it overtakes that answer
in a listen's batch, which the failure says, `mayOvertake`. A call whose credential its transport
cannot carry fails before it goes, `DESTINATION_UNREACHABLE`, nothing tried and its credential kept:
an `ELSEWHERE` over a transport that carries none, or, over a WebSocket, other bytes than its
upgrade carried, a `JWT` or an `ELSEWHERE` over one that is not secure, since a bearer credential
crosses only TLS off the machine (RFC 6750 §5.3). A credential no call presents — a `JWT` with no
token, an `ELSEWHERE` with nothing to carry, a scheme to come — is a `ProgrammerError`, before the
call starts.

```ts
const client = createWSClient({ credential: { scheme: CredentialScheme.JWT, token } });

// the call that renews presents none: until a default is given again, a call that would present it fails
client.router.on('credentialWithdrawn', () => {
  void signIn({ credential: { scheme: CredentialScheme.NONE } }).then((renewed) => {
    client.router.credential = { scheme: CredentialScheme.JWT, token: renewed };
  });
});
```

A request may name a `destinationId`, what it is for behind the peer, which a server's relay passes
on to it — see [Relays](#relays). `router-server` runs over any transport server that meets
`IRouterServerTransportLike`: it sends its own requests to the connection their options name — the
types require one — and notifies the connections subscribed to a procedure, those a filter among
`notify`'s options keeps: it is handed each subscriber, `{ connectionHandle, identifier }`, the
identifier the credential's session's it is held in, none for its connection's, and keeps those it
returns `true` for.

A subscription is the call that made it, left open. The request says it opens one: a client sets the
SUBSCRIPTION flag on a call that subscribes a notification, and a server subscribes the requester of
no other request. A notification's resolver subscribes its requester with
`response.registerNotification()`, which gives the call id of the subscription — the request's own
when it is its session's first subscription to that procedure on the connection, and the one that
session holds otherwise; a successful answer subscribes it all the same, a failure undoes it, and
`unsubscribe({ connectionHandle, callId })` takes it away. A connection holds one subscription per
procedure and per session: its connection's session, which a call presenting none shares, and each
credential's, by its identifier; the first subscription is the one kept. An ordinary
request to the same procedure gets its answer and subscribes nothing, on either side; a callback
that calls `registerNotification()` for one throws a `ProgrammerError`, so its requester is answered
as failed. A client that unregisters a subscription with no `unsubscribe` acknowledged — none given,
one that failed, or a subscribing answer it could not read — cancels its call, so the server ends it
too; `unregisterNotification(notification, { cancel: false })` says the server ended it already; its
call id is reserved all the same, so what was on its way is dropped in silence. A subscription
answered while another call of the connection is still subscribing to that procedure waits for it:
should that call fail, be cancelled, or its answer not go out, the first one answered meanwhile
takes its place. The client drops its notifications when its connection closes or is replaced, since
the server forgets them then, and when the server ends a subscription with a failure — its session
ended, its queue past its bounds — and tells each through `dropped`, with that failure.

A client may ask for a subscription at its own pace: `getNotification(procedure, { serializer,
window: 1 })` sets PACED beside SUBSCRIPTION, and the server then sends a notification only while
the client has credited one, the first by asking. The client credits the next once every callback of
the one before has settled, the promises they return included, so a callback that fetches hears
nothing meanwhile, then the latest; a `window` of more lets that many be under way, renewed at half,
as a transfer's credit is. A service manager holds one notification per procedure, at one window:
asked for again at another, or with none against one, it is a `ProgrammerError`. The credit is a CREDIT with PACED on the subscription's call id: the
count of notifications the server may have sent, absolute, as RSocket's `REQUEST_N` counts its
demand; PACED tells it apart from a transfer's credit, in bytes, which a subscription's result may
share the call id with. Past its credit, a notification waits in its subscription's queue. The code
that notifies may give it a key, the server's own and never sent — `notify(payload, { key })` — and
one of the same key replaces the one waiting, in its place; one with none is queued last. A state
keyed by its entity keeps its latest, as a compacted log keeps a key's last value, and an event keeps
every one: forty-five changes to one article during one fetch come as two notifications. A queue past
`maximumQueuedNotifications` (64) or `maximumQueuedNotificationBytes` (1 MiB) — the server's
`pacing` option — ends its subscription with `CAPACITY_EXCEEDED`, since nothing is dropped in
silence; the client subscribes again and reads the state anew. For a paced subscription, `notify`
resolves once its notification is sent or queued. A callback that never settles holds its
subscription, which is why pacing is asked for, not given. Timing — at most one every half second —
stays the application's, around `notify`; a signal with no data, "it changed", merges around its own
handler, one fetch at a time and one more if something came meanwhile — the demo's `mergedOf`, in
`demo/page.ts`, a dozen lines of the application's.

```text
A1 10 30 03  00 00 00 07  00 02 00 05
   REQUEST, SUBSCRIPTION and PACED: the first notification credited by asking
A1 15 20 04  00 00 00 07  00 00 00 00 00 00 00 02
   CREDIT, PACED: two notifications sent at most, the first one's callbacks settled
```

The service manager — one for both sides — makes what a requester calls and what answers it, over
any router that meets `IRouterLike`: a request is answered once, and as `PROCEDURE_FAILED` when its
resolver fails first. A resolver answers the procedure's own failure, `response(null, { code: 21 })`
with a code from 1 to 65,535, or a refusal of admission from its router's table. The types refuse
the protocol's other failures; a code out of that range, or a refusal from the other side's table,
fails the resolver, and the request is answered as `PROCEDURE_FAILED`, with no detail: the error is
reported, never the peer's to read (spec 9.0). A `beforeRequest` admits a request only by returning
`true`: anything else refuses it, with the `refusal` the function carries, or with `ACCESS_DENIED`.
It is synchronous, and sees the request's header, its connection and the call's session, `session`,
never its payload: its router asks it through the resolver's `admit` once the request's credential
resolved and before the payload is read — or comes, for a transfer — so a request refused is never
decoded, and a resolver called by a router that asked nothing asks it itself, first. An admission of
the application's own reads the session's data — a token's claims, say — and a callback receives
the same session, as `request.session`. The header a resolver, its `admit`, its callback and a
`beforeRequest` are handed, a relay's `beforeRoute` among them, is an `IHandedRequestHeader`: the
header as it came, but for its credential, a `HandedCredential`, which says of a `JWT` its scheme
alone. No procedure is handed a bearer credential its call came with: a `JWT`'s token, and what a
transport carried beside an `ELSEWHERE`, reach the side's verifier, its `credentials`, and a relay,
which forwards them to leg B, alone (spec 13.1). A callback's
`request.signal` is aborted when its call ends before its answer — a `CancelError` when its
requester cancels it, a `DisconnectError` when its connection closes — so it may stop: its answer
would go nowhere, and what it throws then is not reported. A listener of that signal that throws is
an uncaught exception, which a peer's cancel can set off. Under `server/`, the session manager
keeps each connection's session — its token, 16 bytes drawn from `crypto`, its data and two
inactivity timers — the notification manager who is subscribed to what, by connection, call id and
session, and `credential-sessions.ts` each credential's session that bounds a subscription, its end
timed on the router's clock.

`client` puts the three layers together, bottom up — the transport, the router built on it, the
services built on the router — each replaceable on its own. `ws-client` is that over WebSocket, and
is what an application starts from:

```ts
const client = createWSClient();

client.services.on('debug', (error, info) => {
  console.log(info.direction, info.procedureName, error);
});
await client.connect({ host: 'localhost', port });
```

`debug` tells each step of each call, and each router's own `debug` each envelope, at no cost while
nobody listens; a metrics registry counts the calls and the notifications of the routers it is
given — see [Debugging and metrics](#debugging-and-metrics).

`server` does the same on the other side, and adds the sessions. A call runs in a session of one of
two kinds. A connection's session is made by a request — the resolver that opens one, a procedure
that checks credentials say, stores it — and every message of its connection is activity for it.
Its token is announced to the connection on the next answer after it changes, and its end the same
way: a procedure that closes a session deletes it before it answers. Its connection timeout closes
the connection, its session timeout ends the session — the connection takes the server's own
timeout, counted from that end, and each subscription the session bounds is ended with
`SESSION_REQUIRED`, which its client hears as `dropped` — and a connection that closes takes its
sessions; a session stored once its connection closed goes at once. A session stored without its
timeouts holds both without end: the application gives its own, OWASP ASVS 4.0.3 V3.3.2's for one
that authenticates, 30 minutes of inactivity at level 2, 15 at level 3. A connection without a
connection's session — none yet, or its session ended, whatever credentials its calls present — is
closed once silent for the server's `connectionInactivityTimeout`, when it has one. Over HTTP a
listen held is no silence: no connection timeout runs while one is, and each counts anew from its
end, while a session timeout counts messages alone.

A credential's session is what the server's `credentials` make of a credential a request presents, a
`JWT` or an `ELSEWHERE`: its identifier, a record — `{ scheme, issuer, sid }`, else
`{ scheme, issuer, sub }`, for a `JWT`, `{ scheme, id }` for an `ELSEWHERE` — the data of the
credential the call presented, and its end, in milliseconds since the epoch; it is never announced.
`credentials` holds a `JWT`'s `keys`, each a JWK with its issuer and its one algorithm, `ES256` or
`HS256`, and its `audience`; `keySet`, `{ issuers, ask(issuer, signal) }`, asked for the issuers it
names alone, when no key of a token's issuer names its `kid`, once a minute at most for that issuer,
with a signal its deadline aborts, its answer held ten minutes, a `kid` that comes while the minute
runs waiting for the ask its deadline lets go, a token without a `kid` waiting on its issuer's keys
while none serve, keys of one issuer and one material, by their RFC 7638 thumbprint, counting as one
key, the first in the order searched — the application's keys as given, then a key set's as it
answered them — and `maximumWaitingCalls`, 64 by default, the calls that may wait for an issuer's
deadline at once, one past them refused `CAPACITY_EXCEEDED`; and an `ELSEWHERE`'s
`verify(carried, signal)`, given what the transport carried, which settles with `{ id, data, end }`,
or with none when the credential does not hold. The server verifies a `JWT` one way, as an access
token of RFC 9068's profile (spec 13.8), on its own clock, and takes the schemes it is given
something for: a request presenting another is refused `CREDENTIAL_UNSUPPORTED`, whose detail names
those it takes. A credential's session has no inactivity timeout: no message, listen or silence
moves its end, and it ends at its end, with its connection, or by
`server.router.endSession(identifier)`, which ends it and the subscriptions it bounds on every
connection that keeps it, or by `server.router.endSessionsOf(issuer)`, every session of an issuer,
as when a key of its leaks; a credential that still holds opens it anew. The server keeps one, and
times its end, only while it bounds a subscription, and a call whose credential resolves to the same
identifier moves that end to the later of the two: a credential renewed keeps its subscriptions.

Each request runs in its call's session, which its admission reads and its callback receives as
`session`: its connection's, its data a copy the call keeps, when it presents none or that session's
token as `OPAQUE`, compared in constant time; a credential's, with its own credential's data — a
`JWT`'s claims set, frozen — when it presents a `JWT` or an `ELSEWHERE`, never its connection's, and
never the bearer bytes the call came with, which its verifier alone reads (spec 13.1). A credential
that does not hold — another token, an expired `JWT` — is refused `SESSION_REQUIRED`, whatever its
procedure requires, and a verifier that fails `PROCEDURE_FAILED`, reported. A server's router
resolves it once per request, its call id held, before `beforeRequest`: none and `OPAQUE` by its
`sessionOf(request, signal)`, handed the connection and the header alone, nothing its transport
carried — the server's gives the connection's session from its sessions — in the turn the request
came; a `JWT` or an `ELSEWHERE` by its `credentials`, in a later turn,
whether its verifier waits or not. A cancel, or its connection's close, meanwhile aborts the signal
its verifier holds, and what it settles to then is dropped. `requireSession` is the `beforeRequest`
of every other procedure: it tests the call's session, never the connection's, and refuses a call in
none with `SESSION_REQUIRED`; an admission's `SESSION_REQUIRED` to a call that presented a
credential goes out `ACCESS_DENIED`, so its client keeps a credential that may hold; composed with
`&&`, it loses that refusal and the composition refuses with `ACCESS_DENIED` — a caller that wants
to keep it puts `refusal` on its own function.

The server asks a client with a command, `getCommand`, which names the connection; the client runs
it with `getCommandResolver`, and resolves the command's credential as a server does, by the
`credentials` among its own options, the session it learned standing for its connection's. None of
this package's server transports carries a credential beside an envelope it sends, so a command
presenting `ELSEWHERE` fails before it goes, `DESTINATION_UNREACHABLE`, as a `JWT` command does
over a connection that is not secure. A command left unanswered past its timeout closes its
connection when the server's `closeOnCommandTimeout` says so, or the command's own
`closeOnTimeout`. `ws-server` is the server over WebSocket. A server hears what goes wrong where
each layer tells it: a call's on its router's `error`, and its transport's — a socket's, or what a
listener of its events threw — on the transport's `error`, beside each refusal it tells, both on
`server.transport` whichever transport it was built on
([decision 0023](../../docs/decisions/0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)):

```ts
const server = createWSServer({
  credentials: {
    audience: 'https://api.example.com',
    keys: [{ algorithm: 'ES256', issuer: 'https://id.example.com', jwk }],
  },
  transport: { WebSocketServer },
});

server.router.on('error', (error, connectionHandle) => {
  console.error(connectionHandle ?? 'no connection', error);
});
server.transport.on('error', (error, connectionHandle) => {
  console.error(connectionHandle === '' ? 'the transport' : connectionHandle, error);
});
server.transport.on('refusal', ({ reason, status }) => {
  console.warn(`refused ${String(status)} ${reason}`);
});
await server.transport.start({ port });
```

`http-client` and `http-server` are the same over HTTP — see [HTTP](#http).

### The service layer

`@francisdesjardins/bead/service` is the layer a service is served and called through, and the
entry generated code imports, beside `./proto` where a file binds `proto`
([0018](../../docs/decisions/0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)).
A service is its procedures, each a typed descriptor — `requestOf` for a request, `notification`
given for one that notifies, `commandOf` for a command — holding its procedure, who may call it, the
failures it lists, and its payloads' codecs; its failures are a catalogue, `failuresOf`:

```ts
const { text } = PAYLOAD_CODECS;

export const GreeterFailures = failuresOf({ codes: { NOBODY_TO_GREET: 1 }, serviceId: 7 });

export const GreeterProcedures = Object.freeze({
  clock: commandOf({
    admission: 'none',
    failures: {},
    procedure: { procedureId: 9, procedureName: 'clock', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  news: requestOf({
    admission: 'session',
    failures: {},
    notification: text,
    procedure: { procedureId: 2, procedureName: 'news', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  sayHello: requestOf({
    admission: { hook: 'polite' },
    failures: { NOBODY_TO_GREET: 1 },
    procedure: { procedureId: 1, procedureName: 'sayHello', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
});
```

A descriptor sets its procedure's kind, `procedureKind` — `request`, `notifies` or `command` — and
each router checks it as the procedure is declared, by the way it is declared (spec 16.11): a
requester on a client's router takes a request, and one that notifies; on a server's, a command; a
resolver on a server's, a request where it notifies nothing and one that notifies where it
notifies; on a client's, a command; a notification, one that notifies. A procedure written by hand
may state its `procedureKind`, and one that states none is taken every way. A procedure's kind is
never its envelopes': every call opens with a `REQUEST`, a command's too. A procedure the runtime
hands out is a function that carries its procedure's members, read bare.

The codecs are spec 17's, `PAYLOAD_CODECS.raw`, `.text` and `.json`, the last reading a `JsonValue`
and writing what section 17.7 takes; `payloadCodecOf({ decode, encode })` makes one of two
functions, a protobuf message's from protobuf-es's `fromBinary(schema, bytes, { recursionLimit:
101 })` and `toBinary` — 101, since protobuf-es counts the top message, and section 17.9 bounds a
message 100 deep below it
([0031](../../docs/decisions/0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)).
Before it reads, generated code calls `checkProtoRecords(bytes, schema)`
from `@francisdesjardins/bead/proto`, which reads the payload's records against the message's own
descriptor and throws a `SyntaxError` where they are no encoding of it and protobuf-es would read on,
or where sections 17.9.5 and 17.9.6 refuse them: a field at a wire type its type does not take, and
a map's entry with a field other than its key and its value
([0028](../../docs/decisions/0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).
Each message's shape is built once, from its descriptor; `./proto` takes `@bufbuild/protobuf` as an
optional peer, the check by its types alone, the validators by its `create`. Protobuf's conformance
suite plays the generated codec, the check in front, through the testee in
`tools/protobuf-conformance/`, which the root's `tools/protobuf-conformance.mjs` generates its code
into and runs, with its failure list, `failing.txt`.

A `proto` request's rules are protovalidate's options on its message, which beadc compiles into
each side's validator ([0035](../../docs/decisions/0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md)):
`validatorOf(schema, rules)` of `./proto` makes the descriptor's `validate` of the rules it
generates, which judge the message into a sink. The sink holds the violations a detail of
`maximumBytes` carries, each sized as its writer writes it, and counts the rest without building
their path, so a judging holds a detail's worth whatever the request breaks; under `failFast` it
stops at the first. A `pattern` is a table beadc builds ahead of time, `matchesPattern` walking it a
cell a code point. `judgeRules` judges rules written by hand alike, a `json` binding's. Every
verdict of `spec/validations.json` plays through the validators beadc generates for
`spec/validations.proto`, in `src/proto/__tests__/generated/`, which `yarn validations:check` holds
to beadc and `yarn validations:generate` writes, builder/ installed, through the root's
`tools/check-validations.mjs`; the root's `tools/protovalidate-differential.mjs` plays them against
protovalidate-es through the testee in `tools/protovalidate-differential/`.

```ts
const greeter = createServiceServer<typeof GreeterProcedures, string>(GreeterProcedures, {
  admissions: {
    polite: {
      admits: ({ session }) => {
        return session !== undefined;
      },
      detail: 'a greeting needs a session',
    },
  },
});

greeter.on('sayHello', (request, response) => {
  return request.payload === ''
    ? response(null, GreeterFailures.of('NOBODY_TO_GREET', 'a name is needed'))
    : response(`Hello, ${request.payload}!`);
});
greeter.offer(server);

await greeter.notify.news('a new greeting', { key: 'latest' });
await greeter.command.clock('now')({ connectionHandle });
```

The server side's `on` registers a resolver, before or after `offer`, once a procedure; `offer`
binds every resolver, now and later, to one Bead server, once; `command.<name>` is a command's
requester, made as the service is offered, a `ProgrammerError` called before; `notify.<name>`
notifies a procedure's subscribers, and sends nothing before the service is offered; and
`proceduresWithoutResolver()` lists what no `on` answers, which the router answers
`PROCEDURE_UNKNOWN`. An admission rule is `none`; `session`, the server's `requireSession`; or a
hook by name, `{ admits, detail }`, synchronous, refused `ACCESS_DENIED` with its detail: the
options give every hook the procedures name, and a hook they lack, one no procedure names, or one
that is no hook, is a `ProgrammerError` as the server side is made. A resolver answers a result, a
failure its procedure lists, `GreeterFailures.of(name, detail)`, or a refusal of admission; a code
its procedure does not list, which only a cast reaches, goes as written and is reported through the
router's `error` event.

```ts
const greeter = createServiceClient(GreeterProcedures, client, { windows: { news: 1 } });

greeter.on('clock', (_request, response) => {
  return response('noon');
});

const greeting = await greeter.request
  .sayHello('Ada')({ timeout: 2_000 })
  .catch((error: unknown) => {
    return GreeterFailures.is(error, 'NOBODY_TO_GREET') ? 'nobody' : Promise.reject(error);
  });

await using news = await greeter.notifications.news('subscribe', (item) => {
  render(item);
})();
```

The client side takes its Bead client and, after it, its options, `IServiceClientOptions`. It makes
a requester of each procedure its server answers, `request.<name>`, and a notification of each that
notifies, `notifications.<name>`, at the window its caller gives, unpaced by default; a request to a
procedure that notifies opens no subscription. Its `on` answers a command, its `session` admission
refused with the client router's own `SESSION_REQUIRED`; a client side is given no hooks, so a
command a hook admits is a `ProgrammerError` there. Each requester and resolver is declared once. A
call stays curried, `request.sayHello(payload)(options)`: what the payload gives is a bound call,
`IBoundCall`, or `IRegistrar` for a notification, whose `then` no promise matches, so
`await greeter.request.sayHello('Ada')`, its options' call forgotten, does not compile. A descriptor
may carry `validate`, its request's rules (spec 18), which beadc generates: the side that answers
judges every request once it reads, before its resolver, and answers one its rules refuse
`PAYLOAD_INVALID`, its violations in its detail, lines of canonical JSON that `violationsOf` reads
back; a client whose options say `validates: true`, or a server's for its commands, judges the value
before it is written, and a value its rules refuse fails its call before anything goes, with the
same failure, counted and traced as a call refused before it goes. `failFast: true` stops a judging
at its first violation. A `validate` that throws is its side's own error, `PROCEDURE_FAILED`.

### Transfers

A payload whose envelope would pass `chunkBytes` — 1 MiB by default — goes as a transfer, in the same
layout. The REQUEST or RESULT that opens it carries the TRANSFER block, the payload's total on eight
bytes, and its first bytes, sent without credit. The receiver answers with a CREDIT: the offset
below which the sender may send, absolute, so a credit repeated, late or out of order never grants
too much, as QUIC's `MAX_STREAM_DATA` does. The sender sends CHUNKs — each its offset on eight bytes,
MORE on all but the last — full ones only, exactly, the last reaching the total and full at most,
and waits for credit when a full one does not fit. The receiver places them in any order, drops what
it has, refuses a chunk before the last that is not exactly full, a last one past full, or one over
bytes it holds in part — so it holds each byte once, in whole chunks, and no CHUNK's envelope passes
`chunkBytes` — grants a window past what it holds from the start each time half of the last one
is used, and hands the payload on once whole: to the resolver, or to the caller as the call's
result.

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

A transfer is refused before its bulk crosses. Its opening is routed, its credential resolved,
admitted — `beforeRequest` sees the header and the call's session, never the payload — and held to
its procedure's limit and the router's before anything is granted: a refusal falls on the opening,
and no chunk follows it. An opening carries one byte of its payload at least, and one that holds its
whole total needed no transfer: either is refused with `CHUNK_INVALID`. A requester whose header,
its TRANSFER block added, passes 1,020 bytes or leaves its opening no byte fails the call before it
goes, with `PAYLOAD_TOO_LARGE`: a `JWT` of 997 bytes or more, 993 beside a destination, goes whole
only. A receiver holds `maximumTransfers` transfers per connection at once, each until its call
ends, and all of them together hold at most `bufferedBytesBudget` bytes, reserved as each credit
grants them; an opening past either is refused with `CAPACITY_EXCEEDED`, and a transfer the budget
cannot credit waits until the budget frees, or its inactivity ends it.

The requester ends a transfer with a cancel, the side that answers with a failure:
`TRANSFER_STALLED` when nothing came for `transferInactivityTimeout`, `CHUNK_INVALID` or
`CREDIT_EXCEEDED` for a chunk that breaks its rules. While a payload or its result goes as a
transfer, that inactivity governs the call; the call's `timeout` counts the wait for the answer,
afresh once the payload went. A call that received a transfer keeps its call id a while once it
ends — the side that answers holds it abandoned for `transferInactivityTimeout`, the requester
reserved as long, or for its timeout when longer — so a late copy of a chunk under the credit
granted is dropped in silence. A notification, a failure, and the result of a call
that opens a subscription always go in one envelope.

| Limit                       | By default  | Bounds                                                                                                                                                                                                                                                                     |
| --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maximumEnvelopeBytes`      | 16,778,240  | an envelope, as it comes in and as it goes out; the WebSocket transports' `maxPayload` follows it in `createWSServer` and `createWSClient`, never below; built alone, a transport takes 16,778,240, `MAXIMUM_MESSAGE_BYTES`, raised by hand for a router whose envelope is |
| `chunkBytes`                | 1,048,576   | a chunk's envelope, and the largest a payload goes whole in: a request that comes whole past it, or an opening, is refused `ENVELOPE_TOO_LARGE`, nothing of it held                                                                                                        |
| `windowBytes`               | 4,194,304   | how far past what it received, from the start, a receiver lets its sender send                                                                                                                                                                                             |
| `maximumPayloadBytes`       | 16,777,216  | a payload, whole or as a transfer; a procedure's own `maximumPayloadBytes` narrows it                                                                                                                                                                                      |
| `bufferedBytesBudget`       | 268,435,456 | the bytes every transfer a router receives holds together                                                                                                                                                                                                                  |
| `maximumTransfers`          | 4           | the transfers a connection receives at once; 0 takes none, and sends none                                                                                                                                                                                                  |
| `maximumChunkRuns`          | 1,024       | the runs of bytes apart a transfer received holds before it is whole                                                                                                                                                                                                       |
| `transferInactivityTimeout` | 30,000      | the milliseconds a transfer waits for its next chunk or credit, and a call that received one keeps its call id                                                                                                                                                             |
| `maximumDetailBytes`        | 1,024       | a failure's detail                                                                                                                                                                                                                                                         |
| `maximumAnsweringCalls`     | 64          | the calls a connection's peer has a router answer at once — a request past them is refused `CAPACITY_EXCEEDED` before its route, its credential or its transfer — and the calls a requester has wait on a connection, one past them failed before it goes                  |

The limits are options of each router and each facade — `createClient(layers, { limits })`,
`createWSClient({ limits })`, `createServer(layers, { limits })`, `createWSServer({ limits })` — and
must hold together, or the router is a `ProgrammerError`: an envelope of 64 bytes at least, a chunk
from 64 bytes to an envelope, a window of two chunks, a payload within the budget, a call at once at
least, a timeout a timer holds; and, on a side that takes or presents a `JWT`, a chunk and an
envelope of 1,024 bytes at least, since its header holds 1,020. Nothing announces them: both ends of
a connection are set alike. A transport that carries transfers delimits its messages, knows the
envelope's size at both ends, delivers every chunk and credit — in any order, a copy tolerated — and
carries both ways. WebSocket does all four. The router copies every payload it reads, so a
transport may use its buffers again once `receive` returns.

What comes late is dropped in silence where it is known for late, and reported elsewhere:

| Late         | On a call id reserved | On a call abandoned                                 | On none                                                           |
| ------------ | --------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| RESULT       | dropped               | —                                                   | `CALL_UNKNOWN`                                                    |
| FAILURE      | dropped               | —                                                   | ending a subscription, taken; `CALL_UNKNOWN` otherwise            |
| NOTIFICATION | dropped               | —                                                   | `SUBSCRIPTION_UNKNOWN`                                            |
| CHUNK        | dropped               | dropped under its credit, `CREDIT_EXCEEDED` past it | `CALL_UNKNOWN`; `ENVELOPE_MALFORMED` on a call without one        |
| CREDIT       | dropped               | dropped                                             | dropped: it may have crossed its transfer's or subscription's end |
| CANCEL       | —                     | dropped                                             | dropped: it may have crossed its answer                           |

### Relays

A server's router relays a request that names a destination registered in it, as a gateway does for
what stands behind it: each destination answers the same procedures, and the requester picks one by
its destination — `getRequest(procedure, …)(payload)({ destinationId })`.
`registerDestination(target, { audience?, destinationId?, label?, replaces?, timeout? })` names a
client router the relay calls through, or `{ connectionHandle }`, a connection of its own it asks by
a command, and gives the destination: given, or drawn, never 0. Its `audience` is the one the
destination verifies, as a resource is named for a token (RFC 8707); a destination registered with
none takes no credential the relay forwards. `destinations()` lists them, each saying whether its
connection closed, for the application to publish. A destination on a connection dies with it: once
that connection closes, it is unreachable until it is registered anew, on another connection: no
connection takes a handle its transport gave before, and one the router no longer holds is
registered closed. Its id stays taken, closed or not: the application unregisters it, or registers
the next connection in its place at once by `replaces`, the registration it holds, so no request
meanwhile finds the destination unknown. Who may register which destination is the application's
to decide (spec 14.1): the relay checks nobody.

The relay terminates each leg. Leg A, from the requester, and leg B, to the target, each have their
own call ids, limits and session; what crosses is the payload's bytes, undecoded, the answer, and a
bearer credential, which the relay forwards and its destination verifies:

| Leg A presents | The relay                                                                                                        | Leg B presents                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| none, `OPAQUE` | refuses it by default; where its admission takes leg A's connection's session, resolves it to that session       | none: it runs in leg B's session at the target                                                      |
| `JWT`          | forwards it to a destination whose audience its `aud` names, read without verifying it unless the relay verifies | the same bytes                                                                                      |
| `ELSEWHERE`    | forwards it to a destination registered with an audience, over a leg B whose transport carries its bytes         | `ELSEWHERE`, what leg A's transport carried moved to leg B's as it came: over HTTP, `Authorization` |

A request is taken in this order, on its opening. Its credential first: a scheme the relay neither
resolves nor forwards is refused `CREDENTIAL_UNSUPPORTED`, and an `OPAQUE` that does not hold, or an
`ELSEWHERE` that carried nothing, `SESSION_REQUIRED`; a `JWT`, and an `ELSEWHERE` its transport
carried, go on unresolved, unless the relay's `verifies` has it verify them besides, with its
router's `credentials` — a `JWT` against the audiences its destinations were registered with — so
that one that does not hold is refused `SESSION_REQUIRED` there. Then `beforeRoute`, on its header
and the call's session: a server's `requireCredential` by default, which admits a call presenting a
`JWT` or an `ELSEWHERE`, by its scheme alone unless the relay verifies, and refuses any other — one
that presents none or `OPAQUE`, in leg A's connection's session or in none — `ACCESS_DENIED`, its
detail `a relay admits by default only a credential it forwards`, since leg A's session opens
nothing at the destination; `requireSession` in its place refuses, `ACCESS_DENIED`, every credential
the relay forwards without verifying, and a router's relay admits nobody without one. Then its
destination is looked up. Then its credential is held to what leg B carries: a `JWT` whose `aud`
does not name its destination's audience, a destination registered with none, an `ELSEWHERE` over a
leg B that cannot carry what leg A's transport carried — one that carries none, or a WebSocket whose
upgrade carried the relay's own credential, which it never presents for a requester's — a `JWT` or
an `ELSEWHERE` over a leg B that leaves the machine in the clear, each refused
`DESTINATION_UNREACHABLE`, nothing tried. Then it is held to the smaller of the two legs' limits,
leg B's header counted with its credential, call by call. Every refusal falls on the opening. A
requester presenting none or `OPAQUE` that is not admitted learns only whether the relay has any
destination; a `JWT` passes the default admission of a relay that does not verify on its scheme
alone, whatever its bytes. A cancel on leg A, or its connection gone, cancels leg B, which waits as
long as its destination says, the relay's `timeout` at most — by default, on: the requester's own
timeout governs, end to end, by its cancel.

| Leg B                                                                        | Leg A answers                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| a result                                                                     | that result                                    |
| a failure of the target's                                                    | that failure, one relay more                   |
| a limit of leg B's, a payload or a capacity, before its transport had it     | that refusal, the relay's own                  |
| any other error before, or the transport refusing the request                | `DESTINATION_UNREACHABLE`: nothing was tried   |
| any error once the transport had it: a limit, a timeout, the connection gone | `DESTINATION_LOST`: the procedure may have run |
| nothing: leg A ended first                                                   | nothing                                        |

The relay's own failures name no address behind it: why leg B failed goes to the router's `error`
event, with leg A's connection.

A failure through a relay counts the relays it crossed, and its side is not known. A requester
behind a relay that presents none or `OPAQUE`, and that its `beforeRoute` admits, shares its leg B:
one session at the target, one space of call ids, and the target's transfer places. A server's
relay admits none by default: sharing leg B's session is the application's choice, written as a
`beforeRoute` of its own, which sees the procedure and the destination and is where each such
requester's rights are checked — its session names the destinations it may reach:

```ts
// a requester reaches a destination its session names, or forwards a credential its destination verifies
const isAdmitted = (request: IAdmissionRequest<TransportServerConnectionHandle>): boolean => {
  const { header, session } = request;

  return (
    requireCredential(request) ||
    (session !== undefined &&
      header.destinationId !== undefined &&
      devicesOf(session).includes(header.destinationId))
  );
};

const server = createWSServer({ relay: { beforeRoute: isAdmitted } });
```

A composition by `||` answers `ACCESS_DENIED` without the default's detail. `shareLegBSession`, in
its place, lends leg B's session to every requester in a session at the relay, at every
destination: it reads none, so a requester in any session acts at every destination with leg B's
rights, as a deputy that lends its own authority (CWE-441). One that presents a `JWT` or an
`ELSEWHERE` shares leg B's call ids and transfer places alike, and runs at the target in the session
its own credential resolves to there, never in leg B's. An answer names its call alone: a
destination, which means something to its relay only, is malformed on a RESULT or a FAILURE. A relay
carries no subscription — a request that opens one is refused, `SUBSCRIPTION_UNSUPPORTED`, a relay
that carries one being a decision of its own — and forms no chain: leg B names no destination, so no
loop can form.

### HTTP

`http-transport-server` and `http-transport-client` carry Bead over HTTP, whose exchanges keep no
connection — so the transport draws one. A `POST /bead` with no body connects: the server draws 16
bytes from `crypto` and answers 201 with them, in base64url, in `bead-connection-token`; each
exchange after presents that token, and a `DELETE` ends the connection. The router, the sessions and
the relays see a connection, as over a socket. The connection's token names the connection and
nothing else — no session, no credential — and is a secret that enters no handle —
`type=HTTP;ip=…;ordinal=…` names the connection by the rank it was drawn at, as
`type=WS;ip=…;port=…;ordinal=…` names a WebSocket's by its peer's port and the rank it was taken at,
so no two connections share a handle — no event and no report. `createHTTPTransportServer({
createServer })` takes the server's factory — `node:http`'s, `node:https`'s, or `node:http2`'s with
`allowHTTP1` — as the WebSocket one takes `WebSocketServer`, and the application sets its timeouts.
It is called once per address bound, told it, `createServer(listener, { address })`: on `localhost`,
twice, `127.0.0.1` then `::1`, so an application that configures its server after building it — a
certificate rotated by `setSecureContext`, an SNI context added, a timeout — configures each; a port
drawn again listens again on the servers built.

Each `POST` carries one envelope, of type `application/prs.bead`, and its answer comes back in the
body of a 200 — a FAILURE too, since a failure travels once, in its envelope. The transport reads
three things of an envelope and nothing else, in the prefix every layout from 0xA1 to 0xAF keeps —
the layout, the kind and the call id — to hand an answer to the exchange that carried its request,
as HTTP/2 hands a frame to its stream. A request's exchange waits from its first 8 bytes; any other
ends 204 at once. Exchanges keep no order between them, so a cancel may come before its request: the
transport buries that call id for 5 seconds, the least a requester reserves one, and drops the
request that comes under it — a client's call ids alone, and so many of them; a cancel that comes
while its upload is still coming ends that exchange empty once its body is in, never handed on.

A request's credential crosses in the `Authorization` of the `POST` that carries it (RFC 9110
§11.6.2). The client writes the credential its router gives, as it is given, and refuses before it
goes one that is no field value — anything but visible ASCII, spaces and tabs, or a space or a tab
first or last, which the server would read trimmed — its connection kept. The server hands the
router the field's value with the request, as it came, whole, its auth-scheme included and its
surrounding spaces and tabs removed; an empty field carries none. No other exchange's is read, so
two calls of one connection may present two credentials, and a token is renewed without connecting
again; a `POST` with two `Authorization` fields is refused 400, `malformed`, before its body is
read, since the field is no list to combine (RFC 9110 §5.3). An answer, and what a listen brings
back, carry none: a server's command presenting `ELSEWHERE` fails before it goes. A relay that calls
a destination through an HTTP client writes in its `POST`, for a request presenting `ELSEWHERE`, the
`Authorization` leg A carried, as it came; what came beside any other request stays at the relay.
The client is secure under `https` or to a loopback host, by the URL of its connect; the server
under TLS — built on `node:https`'s server, or `node:http2`'s `createSecureServer` — or on a
loopback address it listens on.

A client's `send` settles on the head of its answer, so a caller — a relay, say — knows whether the
server had the envelope: a 2xx resolves, the server sending its head as it hands the request on.
Each refusal of the transport's own is marked in `bead-refusal`, and rejects: nothing was tried. A
status nothing marked — a gateway's 502, a proxy's 404 — may come after the request ran, so it
counts as the exchange lost. An exchange lost — a network that failed, an answer that could not be
written, a request unanswered past `exchangeTimeout`, 5 minutes — closes the connection at both
ends, as a socket that drops does, and the exchanges it handed on are cut, never answered; so does
the 404 marked `connection-unknown`, which says the connection is gone. Idleness tells a client gone
from one alive, as a WebSocket's heartbeat does: a connection with no exchange under way for 5
minutes closes, and, by `createHTTPServer`'s default, one without a session silent for 30 seconds,
a listen held being no silence: the transport emits `listen` as it holds one and as it ends.

No client follows a redirect: one answered to a connect or an upgrade fails it, its status named,
and one answered to a send or a listen is lost, its `bead-refusal` unread (spec 15.6), since no
refusal of the transport's own is one; a listen so answered is listened again, as after any status
nothing marked. Following it would carry the connection's token, and a send's envelope, where they
were not judged. Each fetch is handed `redirect: 'manual'`: on Node, a connect names the status,
"the server drew no connection: 302"; a page's fetch reads no status of a redirect, an opaque one of
status 0, "the server drew no connection: a redirect", or, from another origin, a network error, its
preflight failing. A `fetch` given follows no redirect; one that follows all the same says so in its
answer's `redirected`, and is caught there: the connect fails, "the server drew no connection: a
redirect followed", and a send or a listen loses its connection, nothing of the answer read.

| Status | `bead-refusal`                        | Says                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    |                                       | the request is with the router; its answer is the body — or, to a listen, a batch                                                                                                                                                                                           |
| 201    |                                       | a connection drawn, its token in `bead-connection-token`                                                                                                                                                                                                                    |
| 204    |                                       | handed on, nothing to come back: a cancel, anything but a request, a request held off; a `DELETE` done; a listen that brought nothing; a preflight from an origin `origins` names                                                                                           |
| 400    | `malformed`                           | a connect with a body, no token or a malformed one, not an envelope, a request on the server's parity, a `POST` with two `Authorization` fields; a listen without `bead-after`, a count that is none, or a `bead-after` past what was sent; a WebSocket's upgrade malformed |
| 403    | `host-refused`, `origin-refused`      | a host neither every server's nor among `hosts`, or none, whatever the request; an exchange, or a WebSocket's upgrade, whose `Origin` is neither the server's own nor among `origins`                                                                                       |
| 404    | `path-unknown`, `connection-unknown`  | not the path; the connection is gone                                                                                                                                                                                                                                        |
| 405    | `method-refused`                      | neither `GET`, `POST` nor `DELETE`, which `Allow` names; at a WebSocket's address, neither `GET` nor `HEAD`, which `Allow` names                                                                                                                                            |
| 408    | `too-slow`                            | a body that came slower than `minimumBodyBytesPerSecond` once `bodyGracePeriod` passed                                                                                                                                                                                      |
| 409    | `call-waiting`, `listen-undeclared`   | a request on a call id already waiting; a listen whose client did not say at connect it listens                                                                                                                                                                             |
| 413    | `too-large`                           | a body past the envelope's limit                                                                                                                                                                                                                                            |
| 415    | `type-refused`                        | not `application/prs.bead`, or encoded                                                                                                                                                                                                                                      |
| 426    | `upgrade-required`, `version-refused` | at a WebSocket's address, a request that asks no WebSocket, `Upgrade: websocket`; an upgrade of a version but 13, or of none, `Sec-WebSocket-Version: 13` beside it                                                                                                         |
| 429    | `busy`                                | too many requests waiting on one connection, or exchanges under way                                                                                                                                                                                                         |
| 503    | `busy`                                | too many connections — all, or one address's — bytes of body being read, or a connect or a WebSocket's upgrade once the server's stop began; `Retry-After`                                                                                                                  |

The server bounds what its clients hold: `maximumConnections`, 10 000, and 64 per address;
`maximumWaitingExchanges`, 64 requests waiting on one connection, its router's
`maximumAnsweringCalls` in `createHTTPServer`; `bodyBytesBudget`, 256 MiB of body read at once
across them all. A head comes whole within `headersTimeout`, 30 seconds, or Node's own parser
answers it 408: the transport sets `headersTimeout`, a `requestTimeout` of 0 and a
`connectionsCheckingInterval` of a second on every server `createServer` builds, before it listens.
A body comes at `minimumBodyBytesPerSecond`, 240, once `bodyGracePeriod`, 5 seconds, passed since
its head, on the server's clock, or is refused 408 `too-slow`, its Bead connection kept. An answer
written before its body is whole carries `connection: close`, and its socket closes in stages, its
write side first, reading on and dropping what still comes until its client closes or 2 seconds
pass, so a client that goes on sending reads it (RFC 9112 §9.6). An answer, and a listen's batch,
are held to `minimumSendBytesPerSecond` past `sendGracePeriod`, as at a WebSocket's address: one
past its deadline is an exchange lost, its connection dropped at both ends, reported on `error` as
its connection closes, naming its bounds and their values.

A request names its authority by its target when the target is in absolute-form, `http://` or
`https://` in lower case, read as it came, its `Host` judged as one field line alone, which an
HTTP/1.0 request may leave out (RFC 9112 §3.2.2); over HTTP/2, by its `:authority`, a `host` beside
it ignored (RFC 9113 §8.3.1); otherwise by its `Host`. An authority is a host and an optional port
of spec 15.12's grammar, RFC 3986's narrowed: no userinfo, no percent-encoded octet, no `*`, `+`,
`,`, `;` or `=` in a name, no `IPvFuture` literal, no colon without a port. An HTTP/1.1 request
without a `Host`, and one with two `Host` fields or an authority that is none, is answered 400 as
HTTP answers it, unmarked, before anything else of it is read (RFC 9112 §3.2); over HTTP/2, its
stream is reset, `PROTOCOL_ERROR`, nothing written (RFC 9113 §8.1.1). An empty `Host` is a host, and
so is a name of invalid punycode. So is a request answered whose field holds a control character but
a tab, or an octet past ASCII: RFC 9110 §5.5 calls the first invalid and keeps the second out of
every field defined since, and Node's parser answers the first itself. So is one whose target holds
an octet other than visible ASCII, in its path or its query, or whose path's percent-decoding holds
NUL, `%00`: a target holds a URI's characters (RFC 3986 §2); Node's parser answers each such octet
itself over HTTP/1.1, and nghttp2 resets a control character in `:path`, the transport the rest;
`%00` in a query, and every other octet percent-encoded, are taken. So is one whose field value
starts or ends with a space or a tab, which RFC 9113 §8.2.1 calls malformed over HTTP/2; over
HTTP/1.1 the parser strips it first (RFC 9110 §5.5). Node's HTTP/2 parser drops a field whose value
starts or ends with a space or a tab, and a control character's, so the request is judged without
it; a server created with `strictFieldWhitespaceValidation: false` hands the padded value to the
transport, which resets the stream `PROTOCOL_ERROR`, as the C# side does.

Every server takes `localhost`, a name under `.localhost`, an IPv6 address in brackets and an IPv4
address, by the request's host, its port aside: no name a browser fetches is written as an IP
literal, and a localhost name resolves to the loopback, so a page cannot rebind its name to any of
them. `hosts` names the hosts it takes besides, each a host without its port, compared in any ASCII
case (RFC 9110 §4.2.3) as the field carries it, an IDN host in the punycode a browser sends:
`hosts: ['bead.example']` takes `bead.example` and `bead.example:8443` alike. Any other host, an
empty one and none are refused 403 `host-refused`, whatever the request, a page that rebinds its
name to the server's address among them. So a server reached by a name names it in `hosts`: a public
one, one behind a proxy that keeps the `Host`, as Caddy and Traefik do by default, and a service
reached by its in-cluster name, a docker-compose service's or a Kubernetes Service's; behind a proxy
that writes its upstream's address, as nginx does by default, none is needed. `hosts: ['*']` takes
every host and makes none of their origins the server's own: a page that rebinds its name to the
server's address passes the host's test, and is refused by the origin's, 403 `origin-refused`, so a
page is then taken only when `origins` names it, and an application under `*` that serves its own
page names that page's host in `hosts` or its origin in `origins`. A client that is no browser and
writes its target as its `Origin` — Python's `websocket-client` does by default — is refused alike
under `*` by a name `hosts` does not list: list that name, or have the client write no `Origin`, as
a Bead client writes none. An entry with a port, an empty one, one that is no host, or `*` beside
another throws a `ProgrammerError` as the transport is built; so does an `origins` entry that is
`*`, since no origin wildcard exists, `null`, or anything but an origin as a browser serializes it. A refused host is told on the wire, 403 and `bead-refusal: host-refused`, which
`curl -i` and a browser's network panel show; by the HTTP client, "the server drew no connection:
403 host-refused", and the WebSocket client over `ws`, "the server refused the upgrade: 403
host-refused", each in its `ConnectError`; and by the
server's `refusal`, which names the authority to add to `hosts`. A page's WebSocket sees its close
alone, 1006.

`origins` names the origins a request may come from besides the server's own, none when not given,
compared exactly; a WebSocket server takes both alike,
`hosts` on any request at its address, `origins` on an upgrade, after its version and its form. Any
client that sends an `Origin` is judged by it, a browser's page or not: it gets in by sending none,
by sending the server's own, or by being named in `origins`. The server's own is `http://` or
`https://` followed by the request's authority, when its host is one the server takes by name —
one every server takes, or one `hosts` lists — never by `*`, compared in any ASCII case, the field read as the
serialized origin it carries (RFC 6454 §6.2), never parsed as a URL: a browser writes both from one
URL alike, and a client that writes a default port, a path or another form on one side alone is
refused. Any other `Origin` is none of its own, whatever host it names: `null`, an extension's, a
`blob:` URL's, any scheme but `http` and `https`. So `hosts` is what refuses a page that rebinds its
name to the server's address, and under `*` the origin's test. Over HTTP, the server answers CORS to the
origins `origins` names and to no other (spec 15.12): their preflight is answered, allowing
`Authorization`, the fields it asks for and any other field — `access-control-allow-headers`
naming `authorization`, then its `Access-Control-Request-Headers` as they came, then `*`, so a
browser that caches names and no wildcard keeps the answer too — and every answer to them names
their origin and exposes every field, so a page of a listed origin connects, calls, listens and
presents `ELSEWHERE` in `Authorization`. Every exchange of a connection goes to its one URL, which a
browser's preflight cache keys, so a page preflights its connection's opening and not each listen. No answer carries `Access-Control-Allow-Credentials`: no cookie goes across
origins, and a `fetch` given to the client must not use `credentials: 'include'`. A gateway in
front that answers CORS for the path stops, or replaces the fields rather than appends them, once
the server lists the origin: two `Access-Control-Allow-Origin` fail the browser's check. A page of
the public network reaching a server on the loopback or a private address needs besides its user's
permission, which the browser asks (Local Network Access), in a secure context alone; a secure page
reaching `http://` on a private address by a hostname passes the browser's mixed-content block only
with `targetAddressSpace: 'local'`, which a `fetch` given to the client adds. The server writes
nothing for either. Over WebSocket no CORS stands in the way, so a listed origin's page is served
outright, a page of another port of the same machine — a development server — among them. `null` is
refused as the transport is built: a browser sends it for every page with no origin of its own — a
sandboxed frame of any site, a `file:` or a `data:` page, one whose origin it withholds — so naming
it would let any site drive the server and read every answer; serve the page from an origin, a local
development server's or the Bead server's own, and name that one.

Behind a proxy, a server, over HTTP or over WebSocket alike, believes `X-Forwarded-For` — at a
WebSocket's address, its upgrade's — from the proxies `trustedProxies` names, each an IP address or
a network, `10.0.0.0/8` say, or the compose network's, and as many more as `unnamedProxies` counts:
while the address reached is one they hold, or one they do not while fewer than `unnamedProxies`
such addresses were passed, the field's next entry from the right is the client's, so what a client
wrote to the left of the first address past the count that none of them holds is never read. An
entry is read in RFC 7239's node forms, `192.0.2.7`, `192.0.2.7:51234`, `2001:db8::1` or
`[2001:db8::1]:443`, its port dropped, and held in one form, IPv4-mapped as IPv4 and IPv6 as RFC
5952 writes it; any other, `unknown` or a zone among them, ends the walk at the proxy that wrote it.
None trusts no proxy, the loopback among them; a name, a network whose bits past its prefix are set,
and a network of prefix 0, which would trust what every client writes, throw a `ProgrammerError` as
the transport is built. `Forwarded` is never read. The address reached is what a connection's handle
and `clients` name and what a refusal tells; its port stays the socket's. A proxy neither listed nor
counted is a client as any other: every client behind it is its address. Over HTTP,
`maximumConnectionsPerAddress` counts it, so a told `busy` whose `address` is your proxy's, or a
`largestAddressConnections` near its ceiling on `/health`, is a proxy to list; a WebSocket server
counts it alike, at its upgrade. A proxy
whose platform publishes its addresses is listed: Google Cloud's global load balancer by
`130.211.0.0/22`, `35.191.0.0/16` and the forwarding rule's own address, Cloudflare by its ranges,
an AWS ALB by its VPC's network. One whose addresses its platform does not publish — Heroku's
router, a serverless backend behind a load balancer — is counted, `unnamedProxies`, one each, from 0
to 8, 0 by default: a listed proxy costs none of the count, wherever it stands, so a count is of the
proxies the list does not name alone, unlike Envoy's `xff_num_trusted_hops` and Express's `trust
proxy` n, which count every hop — a proxy both listed and counted hands the client an entry it
wrote. A count is believed as told: a request that reaches the server past a counted proxy, straight
to its socket, is read by entries its client wrote, so a server so reachable lists its proxies
instead
([decision 0030](../../docs/decisions/0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md)).
A bound by address counts as one the users behind one NAT, and as many the addresses of one IPv6
network.

```ts
// a sidecar on the loopback, listed, and Heroku's router before it, its addresses unpublished, counted
const server = createHTTPTransportServer({
  createServer: (listener) => {
    return createServer(listener);
  },
  trustedProxies: ['127.0.0.1'],
  unnamedProxies: 1,
});
```

What the server sends of its own — a subscription's notifications, a command, a request relayed to
the connection, a cancel — reaches a client that listens. The client says so at connect,
`bead-listen: ?1` (an Item of RFC 9651 whose bare item is a Boolean, its parameters ignored), and
the server's 201 says it back when it takes the
listen, as a WebSocket server names the subprotocol it chose: a client whose header something on the
way dropped never listens where it would be refused. It holds for the connection's life, and
`isTwoWay` says it of the connection; to a client that does not listen, a request that opens a
subscription is refused, `SUBSCRIPTION_UNSUPPORTED`, a command rejects, and a relay passes no
request. The server numbers each such envelope into the connection's outbox. A listen, a
`GET /bead` carrying `bead-after` and `bead-wait`, acknowledges what `bead-after` names, which goes,
and brings back all that is left in a batch of type `application/prs.bead-batch`: each envelope
after its length in 4 bytes, the number of the first in `bead-sequence`, the others following one
by one. Nothing left, the server holds the listen up to its `bead-wait` milliseconds, 0 when left
out, no longer than `maximumWait` — 30 seconds — and ends it 204; a second listen takes the first's
place. Each count is an Item of RFC 9651 whose bare item is an Integer of 0 or more, its parameters
ignored; a listen without `bead-after`, or with a count that does not read so, is refused 400
`malformed`, and no exchange's query is read. The client reads a batch as it comes and hears each envelope as it
comes whole, bounded alone by its envelope limit, as a socket's frames are: no batch is bounded as a
whole, and none is declared, as HTTP/2 bounds its frames and never its streams. What a listen lost
or cut carried past what was heard comes again to the next, so nothing is lost and nothing heard
twice. An outbox past `maximumOutboxBytes`, two envelopes' worth, drops its connection, reported on
`error` as it closes, naming the bound and its value; a paced subscription queues on the server
what its client has not credited, so that never reaches the outbox. The client listens from its
connect on, asking a `wait` of 25 seconds; a listen lost is listened again from where it was, as
EventSource reconnects:
at once, then after 1, 2, 4 seconds and on to 30, each wait drawn between half of it and all of
it, so the clients one restart dropped come back apart. A listen that reaches the server ends the
losses; a short outage costs nothing — the same connection, its session, its subscriptions, and
what came meanwhile, in order. Past `inactivityTimeout` of losses — 5 minutes, the server's own —
the client counts the connection lost; the server's marked 404 says it sooner.
A listen held is an exchange under way, so a client that listens is never idle; `pause` spaces the
listens that bring nothing, and must stay under the server's idleness. Long polling, rather than a
response held open for ever: no heartbeat, nothing an intermediary buffers, and a batch lost comes
again.

Nor does HTTP carry a transfer: a request's body is in before its answer goes, so no
credit could come back, and `createHTTPServer` and `createHTTPClient` fix the limits — no transfer
either way, a payload what one envelope holds. An upload is one envelope, held in memory, and one
refused at its admission has crossed first, where over WebSocket its transfer is refused at its
opening. The token is readable by script, where a socket is not: off the machine, HTTPS.

One port for WebSocket and HTTP comes from a proxy in front, never from a transport that shares
another's server — see the demo's `relay.ts`. A browser holds 6 HTTP/1.1 connections per origin, a
listen held taking one, so calls past that wait, a cancel among them; HTTP/2 lifts it.
`node:http2`'s `createSecureServer` with `allowHTTP1` serves HTTP/2 and HTTP/1.1 on one port. A
browser speaks HTTP/2 over TLS alone, so the demo, on this machine, stays on HTTP/1.1. An intermediary cuts a call longer than
its own timeout — 60 seconds for nginx's, 100 for .NET's `HttpClient` — and the exchange, lost,
closes the connection.

### A server in a Web Worker

`worker-transport-client` and `worker-transport-server` carry Bead between a page and a Web Worker,
for a server that runs beside its page with no backend — a demo, a playground, a test. A client
connects by posting `bead-connect` to the worker with one end of a `MessageChannel`; that port is
the connection, `type=WORKER;ip=local;ordinal=n`, which the server accepts with `bead-open`.
Envelopes go both ways as bytes, each copied and its buffer transferred, so no one else's is taken;
either end ends the connection with `bead-close`, since a port does not tell its close, and a
client whose close is not clean with `bead-lost`, which its server tells unclean; a client tells
its server's close unclean, as every client tells a close it did not ask for. It is two-way, in
order, and carries transfers, as a socket does. It carries no credential beside an envelope, and
never leaves the machine: a `JWT` crosses it, and an `ELSEWHERE` fails before it goes. The server's
`start` listens at once, before anything is awaited, so a connect the worker hears as its script
runs is not lost; the worker's other messages are left to it. A worker's `error` — an exception its
script did not catch, or a script that failed to load — fails a connect under way at once with a
`ConnectError`, and ends an open connection of the client's own (spec 15.1): told once on `error`,
its message and where it was thrown, then its close, unclean at both ends. A worker terminated
without a word is not heard.
`createWorkerServer({ transport: { scope: self } })` in the worker and `createWorkerClient({
transport: { worker } })` in the page are the facades. This one is a page's own: a server in C# has
no counterpart to mirror.

### In memory, and a server's transports joined

`memory-transport-client` and `memory-transport-server` join a client's router and a server's
router of one process (spec 15.13): a gateway that calls its application's own server, a core
before it has a socket, a test. `createMemoryTransportClient({ server })` connects to a
`createMemoryTransportServer()` with the address and port its caller gives, `local` and none by
default; the server draws the connection `type=MEMORY;ip=<address>;ordinal=n` and hands that
address and port with each envelope, so a refusal told names them. Each envelope crosses as a copy,
whole, once and in order, in a later turn than its send, never within it, so no router is entered
from its own call. A request's credential crosses beside it, any field value, as `POST /bead`
carries one; none goes toward a client, so a command presenting `ELSEWHERE` fails before it goes.
It never leaves the process, so it is secure and a bearer credential crosses it; it carries
transfers under its routers' limits and holds no bound or heartbeat of its own. Either end closes a
connection, the other told in a later turn; a server that stops closes each and takes no connect.

`joinTransports([memory, webSocket])`, of `joined-transport-server`, is one server transport over
several (spec 15.14), so one server — one router, one admission, one session manager, each service
offered once — takes its connections from all of them. Each handle stays the one its transport drew,
and its flags, sends and closes go to that transport; each transport's events are told on with
their handles, each listener within its guard; its stop stops each, and its gauges are their sum.
Two transports of one type, whose handles might be one, are refused as the join is built: one
transport binds both addresses. The join starts nothing: each transport is started where it
listens, and one port for two still comes from a proxy in front.

### HTTP/JSON transcoding, a gateway

`http-gateway`'s `createHTTPGateway` answers a service's procedures as routes of HTTP
([`spec/transcoding.md`](../../spec/transcoding.md), decision 0037), beside the wire, never in its
place: each call goes through one more Bead client of the application's own server, across an
in-memory transport that server joined beside its WebSocket or HTTP one, so it meets the same
router, admission, sessions and services, each offered once. It reads everything from the route
table beadc writes in an output with `http: true`, `bead_http.ts`, whose `HTTP_ROUTES`,
`OPENAPI_DOCUMENT` and `HTTP_PROBLEM_TYPES` it is given; `transcoding` is the layer it reads them
with, together with the generated HTTP client's caller.

```ts
const memory = createMemoryTransportServer();
const server = createServer({ transport: joinTransports([memory, webSocket]) });
const gateway = createHTTPGateway({
  createServer: (listener) => createNodeServer(listener),
  document: OPENAPI_DOCUMENT,
  problemTypes: HTTP_PROBLEM_TYPES,
  routes: HTTP_ROUTES,
  transport: memory,
});

await memory.start();
await gateway.start({ port: 8080 });
```

Every procedure a client calls answers `POST /api/<Service>/<procedure>`, its body the request
whole; one marked `option idempotency_level = NO_SIDE_EFFECTS` answers `GET` and `HEAD` there too,
its request from the query, unless the query cannot carry a field of it; and each `google.api.http`
rule is served as written, a path matched raw, by the peers' precedence, a literal before `*`
before `**`. A multi-segment variable keeps each `%2F` as it came, so its resolver reads three
characters where the path held an encoded `/`.

**The route is no guard.** A procedure answers its default route whatever rules map it, so a
proxy's rule on a rule's path guards nothing the default route leaves open: what guards a procedure
is its admission, which every route meets alike.

A `proto` body is read by Bead's own mapping of protobuf's JSON over its message's schema, and a
result written in Bead's proto JSON form, one sequence of bytes on both sides: fields in their
numbers' order, a map's entries sorted, a `float` at its shortest, each well-known type in its one
form; protobuf-es's `fromJson` and `toJson` are never called, and the binary payload stays its
own. A failure is an `application/problem+json`, its status by where its code arose:
`PAYLOAD_INVALID` 422 with each violation's `pointer` or `parameter`, `SESSION_REQUIRED` 401 with
`www-authenticate`, a server's answer the gateway could not take 502. A request whose `accept`
names `text/event-stream` to a procedure that notifies is a stream of Server-Sent Events: its
result, each notification a `message`, the failure that ends it, each an `id`, paced by what its
response takes, 16 at once; one that carries `Last-Event-ID` is answered 204, so an `EventSource`
stops rather than calls again.

Every body the gateway writes meets `maximumUnsentBytes` and its send pace,
`minimumSendBytesPerSecond` after `sendGracePeriod`: whole answers, problems, the document and
stream events. Whole bodies go in slices of at most 64 KiB, paced one slice at a time. A drop
reports the bound on `error`, releases the exchange's place and socket, and cancels a stream's call.

Each exchange draws one Bead connection, closed as its response ends: a connection's session, a
subscription, a bound of the calls it answers, are one caller's, never every caller's. Its
`authorization` is presented whole as `ELSEWHERE`, or under `authorization: 'bearer-jwt'` its
`Bearer` token as a `JWT`; a command its server sends is answered `SERVICE_UNKNOWN`, and a
connection's session ends with its exchange. It judges a request in the order of `transcoding.md`
10.1 by the HTTP transport's own gates — hosts, origins and CORS, Fetch Metadata, its bounds, calls
and streams counted apart — from one policy object, `httpPolicyOf`, which
`createHTTPTransportServer` takes too, so two listeners never keep two lists alike; a member given
in the policy and beside it is refused. It listens on its own port, or answers as `listener` on a
server the application builds; one origin for `/bead` and `/api/…` comes from a proxy in front. It
serves the document at `/openapi.json`, byte for byte, with its `etag`; Swagger UI is the
application's to serve.

The same `bead_http.ts` exports a client of each service, `<Service>HttpClient`, which calls its
gateway through `fetch` (`transcoding.md` 12): `new HelloHttpClient(url, options?)` takes the
gateway's base URL, `http` or `https` with no userinfo, query or fragment, whose path prefixes each
route, and its options a `fetch`, a default `authorization` and `maximumBodyBytes`, 16,778,240 by
default. Each procedure a client calls is a method, `hello.sayHello(request, options?)`, on its
default `POST` route alone, whatever rules map it, and one that notifies is also
`hello.subscribeCountDown(request, options?)`, an async iterable of its result first,
`{ kind: 'result', value }`, then each notification, `{ kind: 'notification', value }`; breaking out
of it releases its response. A call's options take a `signal`, an `authorization` of its own and
`withoutAuthorization: true`, which presents none, its client's default either. An authorization is
held to the transport's check of a field value, a `ProgrammerError` otherwise, an empty one
presenting none; one that would leave the machine in the clear fails `DESTINATION_UNREACHABLE`
before anything is encoded or sent, by spec 13.4's rule on a URL. Each fetch is handed
`redirect: 'manual'` and `credentials: 'same-origin'`, a `fetch` given among them, so the client
follows no redirect and a page's sends nothing its browser adds beyond its own origin's; a redirect
answered, or one a `fetch` followed all the same, which its `redirected` says, fails the call,
`DESTINATION_LOST`. A problem throws a `FailureError` of its code, its scope and its detail, and so
does the failure that ends a stream; a problem of the gateway's own, which carries no code, is read
by its `bead-refusal`, then by its status, and a status an intermediary answers by whether the
procedure may have run, the status and its `Retry-After` kept in the failure's detail. Each whole
answer and each event is held to `maximumBodyBytes`, `PAYLOAD_TOO_LARGE` past it; a body that does
not read is `PAYLOAD_UNDECODABLE`, and a stream cut before its failure `DESTINATION_LOST`, never
reconnected.

### What a server holds

`server.gauges()` counts what each layer holds right now: the server's connections, the transport's
— and over HTTP its exchanges waiting, its listens held, its outboxes, the bodies being read, over
a WebSocket what waits for its sockets, `largestUnsentBytes` the most one holds, and on both the
connections its busiest address holds, `largestAddressConnections` — the router's calls waited on
and answered, the busiest connection's, `largestAnsweringCalls`, the call ids it reserved, its
transfers and the bytes they hold, its subscriptions in flight, waiting or notified, those paced
whose credit is spent and what they queue — all together, and the fullest queue, at its bounds — its
destinations, and the credentials' sessions it keeps and those of them timed, `credentialSessions`
and `timedCredentialSessions` — and the connections' sessions.
Nothing of it names a connection: no handle, token or address leaves the process. Each layer also
says how many connections it keeps anything for that the transport no longer holds — an orphan,
which is a leak — and what it found that should never be, such as timers kept through
`sessions.timers` for a connection with no session.

`server.health()` is the verdict, as the IETF draft "Health Check Response Format for HTTP APIs"
writes one, and as ASP.NET Core's health checks read it: `pass`, `warn` or `fail`, each check under
`layer:measure` with its `observedValue`. An orphan or an anomaly fails; a count at 80 % of its
ceiling warns. The library opens no endpoint for it: the application serves it where it wants — the
demo on `/health`, on this machine alone, 503 when it fails. A relay's destination outlives its
connection on purpose, and is counted for none. What timers hold in closures — a heartbeat's, a
stalled transfer's — no gauge sees; the tests' timer spies do. Every end-to-end test ends at rest:
each layer back to nothing once its clients are gone, and a health that passes.

A server's router tells each call it refuses as its credential resolves or as it is admitted,
`accessRefused` (spec 13.12): its `stage`, `credential` or `admission`; the `code` answered; why, in
one word — for a `JWT` the step of section 13.8 that refused it, for an `OPAQUE` `session`, for an
`ELSEWHERE` `nothing-carried`, `verifier` or `end`, for a scheme it takes none of `scheme`, for an
admission the one Bead gives that refused it, `requireSession`, `requireCredential`,
`shareLegBSession`, or `no-before-route` for a relay with none, and none for the application's own;
the credential's scheme, what was called, the connection, and the `address` and `port` of the
request as its transport handed them — over HTTP its exchange's, not its connect's. Never the
credential, any part of it, a claim, or an admission's detail, as OWASP's ASVS logs authentication
and authorization failures. A verifier or an admission that fails is reported on `error` instead,
and a call refused as it would wait for its issuer is neither. The record is built only while a
listener listens; what one throws is reported with its connection, and the refusal stands.

### Debugging and metrics

What a side traces, filters and counts beside the wire is stated by
[`spec/debugging.md`](../../spec/debugging.md), the spec's companion, which both sides play from
`spec/debug-filters.json` and `spec/metrics.json`: none of it goes on the wire, and a peer never
knows whether anyone listens.

A service manager's `debug` tells each step of each call (section 4): its direction, `tx` out and
`rx` in; its type, `request`, `command` or `notification`; its procedure and its service;
`startedAt`, on the wall clock, and, once it answered, its `duration`, in whole milliseconds of the
monotonic reading; its options, their defaults applied and its credential left out; what went out
and came in, decoded and copied; and what it failed with, a failure by its code, its scope and its
detail. A call made and its answer, a request received once admitted and decoded and the answer it
sends, a notification sent or heard: each is a step. An error on a `tx` step says its `tx` did not
go out, and why: a notification that could not go; an answer its router could not send, told again
at its start with what its router refused it with; an answer to a request its router already
answered in its resolver's place, as its subscription's queue went past its bounds, told once with
the failure its router answered, which its router's `answeredOf` gives the manager; or none, from a
resolver that failed before it answered, with what it failed with. The `PROCEDURE_FAILED` that goes
in their place is the envelopes' to tell, and a call answered nothing — cancelled, gone with its
connection, its router disposed — tells no failure. Each router's own `debug` tells each envelope
(section 5), out once it is written within its bound, in once it reads: its direction, its
connection — `server` on a client — and a copy of its header, which carries its credential's scheme
in place of its credential.

Neither costs anything while nobody listens (section 3). `isDebugging` says whether anyone does;
until someone does, a call reads no clock and builds nothing for its trace — no step, no copy of its
options or its payloads — and an envelope no redacted header: one check a call, and one an envelope.

A listener's error never changes a call (section 2). What a listener throws — the trace's, or the
one a filter wraps — goes to its router's `error` event, with the call's connection on a server,
and the next listener is called all the same: the call keeps its outcome, its answer and what goes
on the wire, as if nobody listened.

`filterDebug(listener, filter)` keeps what a call's listener hears, and `filterEnvelopeDebug` what
an envelope's does, in the words of the `DEBUG` variable of the `debug` package, read in ASCII alone
(section 6): words parted by commas or ASCII white space — space, tab, line feed, vertical tab, form
feed and carriage return, nothing outside ASCII — `*` for any run of characters, line terminators
among them, `-` before a name to leave it out, and the exclusions winning. A name is a procedure's,
matched whole: an ASCII letter matches itself in either case, and every other character itself
alone, so a name outside ASCII is compared as it is. A selector's letter and its values are read in
either case too, in ASCII alone: `D(RX)` holds.

| Word                                                                                                                    | Keeps                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `d(rx)`, `d(tx)`, `d(rx\|tx)`                                                                                           | the events going that way, calls and envelopes alike                                   |
| `t(request)`, `t(command)`, `t(notification)`, `t(r)`, `t(c)`, `t(n)`, `t(r\|c)`                                        | the requests, commands or notifications, by the trace's words or by their first letter |
| `e(request)`, `e(result)`, `e(failure)`, `e(notification)`, `e(chunk)`, `e(credit)`, `e(cancel)`, `e(request\|failure)` | the envelopes of that kind, by its name: `request` and `result` share a first letter   |
| `get*`                                                                                                                  | the procedures whose name matches                                                      |
| `-getStatus`                                                                                                            | every procedure but those whose name matches                                           |

One filter serves both listeners, as one `DEBUG` serves every namespace: a call's listener does not
ask the kinds, and an envelope, which carries no procedure's name and no call's type, is asked its
direction and its kind alone. With no name to keep, every name is kept; an empty filter keeps
everything. A filter that does not hold is a `ProgrammerError`, which names its first word that
does not, or that word's value, as it was written, quoted as JSON writes a string —
`a debug filter takes a direction among rx, tx, not "UP"`: a selector empty, `d()`, or with a value
left empty, `d(rx|)`; a value that names none of its letter's, `d(UP)`; any other word holding a
parenthesis, `d(rx,tx)` being two such words. `parseDebugFilter` reads a filter's words into its
parts, and a filter given whole, as those parts, is refused in the grammar's names. A filter given
as a function is asked at each event — an environment variable read afresh, say — and compiled
again only when it changed; one that gives none, a variable unset, keeps every event, as an empty
filter does. The first must hold, or the listener's wrapper throws a `ProgrammerError` as it is set
up; one that stops holding later, or a function that throws, leaves the last that held, reported to
no one, since a trace never fails a call. The package reads no variable of its own,
since it runs in a browser too; the examples name theirs `DEBUG_CALLS`, as it filters calls and
their envelopes both:

```ts
const filter = () => {
  return process.env['DEBUG_CALLS'];
};

client.services.on(
  'debug',
  filterDebug((error, info) => {
    console.log(info.direction, info.procedureName, error);
  }, filter)
);
client.router.on(
  'debug',
  filterEnvelopeDebug(({ connectionHandle, direction, header }) => {
    console.log(connectionHandle, direction, header);
  }, filter)
);
```

A metrics registry counts calls and notifications (sections 7 to 12). `createMetricsRegistry()`
makes one, and a router given it as its `metricsRegistry` — an option of every client and server,
which pass it on to the router they build — counts at its gates, on a path no listener runs on: a
call it answers, from its request's arrival to its answer handed to its transport; a call it makes,
from its `request` to its settling; a notification, as it is handed to its transport or heard; a
subscription, as either of its ends drops it. A router given none counts nothing, and one registry
given to two routers sums them. It counts what its side declares: each resolver registered, each
notification registered, and each requester made — `getRequest`'s, `getCommand`'s, a
notification's — which the service manager declares to its router through `declareRequester` as it
makes it, each of its calls carrying the series the declaration gave back. The registry keys a
procedure by its address and holds one name for it; a service declared at another revision counts
into the same series, which no label tells apart. A declaration of an address it holds under
another name, or of a name its service holds at another address — two names one when they are equal
once their ASCII letters are read in one case (spec 16.6) — is a `ProgrammerError` as it is made,
never on a call, and so is one past `maximumProcedures`, the procedures each group of families names
at most, 1,000 by default. Its router refuses first, whatever its registry, a declaration off
section 16: an id or a revision out of its range, a procedure's name off its form, or a procedure
whose kind the way it is declared does not take, against its kind. A call it has no declaration
for — a service or a procedure unknown, a request whose header does not read, a relayed call —
counts under `_OTHER`.
Each series is made at 0 as its procedure is declared, so an alert reads it from its start and a
rate sees the first call.

| Family                              | Type      | Counts                                                                            |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `bead_client_call_duration_seconds` | histogram | how long each call this side made took, from its start to its end                 |
| `bead_client_call_handled_total`    | counter   | each call this side made, as it ended, by `outcome` and `code`                    |
| `bead_client_call_started_total`    | counter   | each call this side made, as its router took it                                   |
| `bead_notifications_heard_total`    | counter   | each notification heard under a subscription this side holds                      |
| `bead_notifications_sent_total`     | counter   | each notification for one subscription, `sent` to its transport or `failed`       |
| `bead_server_call_duration_seconds` | histogram | how long each call this side answered took, from its arrival to its end           |
| `bead_server_call_handled_total`    | counter   | each call this side answered, as it ended, by `outcome` and `code`                |
| `bead_server_call_started_total`    | counter   | each call this side answered, as its request opened it                            |
| `bead_subscriptions_dropped_total`  | counter   | each subscription ended other than by its client's cancel, at this end, by `code` |

Client and server are a call's roles: `bead_client_*` counts the calls a side makes, a server's
commands among them, and `bead_server_*` those it answers. A series is labelled by `service`, its
service's id in decimal, and `procedure`, its name; a call's, by its `type`, `request` or
`command`; a call ended, by its `outcome` — `result`, `failure`, `timeout`, `cancelled`, `closed` or
`error` — and a failure by its `code`: the protocol's name for it, `application` for a procedure's
own, `_OTHER` for one the protocol names none of. What is under way is a series' started count less
its handled counts, each series written from one reading of its counts, so the difference never
reads below 0 and its `_count` is the sum of its handled counts; no gauge is kept besides. A
duration is whole microseconds, in the 42 buckets of gRPC's A66, from 0 to 100 s, each bound written
as Prometheus 3 stores it. Node reads its monotonic clock finer than a microsecond; a browser
coarsens it to 100 µs, or 5 µs once cross-origin isolated, and the buckets under that hold zeros.

`exposition()` writes every series the registry holds in the Prometheus text format 0.0.4, and gives
its media type with it: `{ contentType, text }`, `contentType` being `METRICS_CONTENT_TYPE`,
`text/plain; version=0.0.4; charset=utf-8`, which Prometheus 3 requires of a target. Bead opens no
port: an application serves the text where it likes, at `/metrics` beside its `/health`, or appends
it to its own exposition when that one is 0.0.4 too, Bead's families being `bead_*` alone, each one
group. One whose exposition is OpenMetrics serves Bead's at a path of its own, a second target. A
mean reads from a histogram's `_sum` and `_count`, and a quantile as Prometheus's
`histogram_quantile` estimates one, within a bucket.

```ts
import { createServer } from 'node:http';

const metricsRegistry = createMetricsRegistry();
const server = createWSServer({ metricsRegistry, transport: { WebSocketServer } });

createServer((request, reply) => {
  if (request.url === '/metrics') {
    const { contentType, text } = metricsRegistry.exposition();

    reply.writeHead(200, { 'content-type': contentType });
    reply.end(text);
  } else {
    reply.writeHead(404);
    reply.end();
  }
}).listen(9_464);
await server.transport.start({ port });
```

A client built in a page announces itself to the page's DevTools hook, when it has one
([decision 0015](../../docs/decisions/0015-a-pages-client-announces-itself-to-a-devtools-hook.md)).
Bead's extension, in [`devtools/`](devtools/), defines it before the page's scripts run, under
`DEVTOOLS_HOOK_KEY`, `Symbol.for('@francisdesjardins/bead/devtools-hook')`, and `createClient`,
which every client of a transport goes through, hands it a source of protocol 1: its `debug` events
while the extension watches, and its registry's exposition — never the client, its router or its
credential. Announced, a client builds no `debug` event until a panel opens; `devtools: false` among
its options refuses, and a router built alone announces nothing.

### The parts of the core, the manager and the HTTP server

The router's core, the service manager and the HTTP transport server are each built of parts: here
a module of its own under `src/`, on the C# side a private nested type of its owner, in a partial
file named after both under `src/`, the type named after the module. Each part has its twin; one
row names no part: `router-limits.ts`, whose twin is the public `RouterLimits`, outside the owner.
The C# side's README holds the same table. A part's tests sit in the file named after it: those
that go through the owner, under the owner's describe, and those of the part's own factory or
functions, under theirs.

| TypeScript module                           | C# file                                                      | What it holds                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router/shared/router-requester.ts`         | `Bead.Core/RouterCore.Requester.cs`                          | The calls this side starts: their request, its credential, its header and its payload, whole or as a transfer; their call ids, held among the pending calls; their timers, their cancel and its reservation; an answer paired with its call, a result received in a transfer; the pending calls' gauges                               |
| `router/shared/router-writer.ts`            | `Bead.Core/RouterCore.Writer.cs`                             | What goes to the transport: an envelope under the payload's and the envelope's limits, a failure's detail cut to its envelope, traced, handed over with its transport's credential; the session announced to each connection, again when its answer does not go out, and forgotten with it; the announcements' gauges                 |
| `router/shared/payload-placement.ts`        | `Bead.Core/RouterCore.PayloadPlacement.cs`                   | How a payload goes: whole, as a transfer, or refused `PAYLOAD_TOO_LARGE`; the largest envelope a payload goes whole in, the bytes a chunk carries, a procedure's limit within the router's, a chunk's envelope                                                                                                                        |
| `router/shared/router-limits.ts`            | `Bead.Core/RouterLimits.cs`                                  | The router's limits over their defaults, checked whole and held together: `limitsOf`, whose twin is no part but the public `RouterLimits` and its `Validate`, outside the owner                                                                                                                                                       |
| `router/shared/service-trace.ts`            | `Bead.Core/ServiceManager.Trace.cs`                          | The steps a call tells `debug`: whether anyone listens, a call's start and a notification's, each step with its connection, its duration, its failure and its payloads, handed to the manager, which guards each listener                                                                                                             |
| `router/shared/service-requester.ts`        | `Bead.Core/ServiceManager.Requester.cs`                      | The calls the manager makes: their options over its defaults, their requester declared to the router, their value written, traced, `deprecated` raised, the close on timeout, their answer decoded                                                                                                                                    |
| `router/shared/service-resolver.ts`         | `Bead.Core/ServiceManager.Resolver.cs`                       | The resolver of a procedure, which the manager registers: a request admitted on its header, its payload decoded, its callback run with its signal, its one answer, or a refusal or a failure in its place, each step traced                                                                                                           |
| `transport/server/http-request-exchange.ts` | `Bead.Transport.Http/HttpTransportServer.RequestExchange.cs` | One envelope's exchange: its body read into one buffer under its limits, its prefix checked, the request handed on, a cancel's 204, the body's bytes charged and given back; its answer awaited and written here on the C# side, by the server's `send` on the TypeScript side, where Node pushes it to the response the server holds |
| `transport/server/http-server-fields.ts`    | `Bead.Transport.Http/HttpTransportServer.ServerFields.cs`    | The fields a request carries, read: its target, its authority, its counts, its listen, its body's type; the fields of a preflight and of every answer; an end written once; a malformed request refused as HTTP refuses it                                                                                                            |

What stays in each owner: in `router-core.ts` and `RouterCore.cs`, what comes in, read, traced
and dispatched, the peer's requests, their credential's session, their answers and the results
sent as transfers, the transfers a request comes in, the registrations, the teardown and the gauges
merged; in `service-manager.ts` and `ServiceManager.cs`, the manager, its events and its
notifications, a resolver's registration and the guard on each `debug` listener; in
`http-transport-server.ts` and `HttpTransportServer.cs`, the connections and their tokens checked,
the listens, the outboxes and the server's life, under one lock on the C# side.

### Following a call

Three paths cross the stack. Each step names its file under `src/` and the function that takes the
call there.

**A request, from a client to a server, and back.**

1. `services.getRequest(procedure, dependencies)(payload)(options)` —
   `router/shared/service-requester.ts`, `callOf`, the body every requester shares: its declaration
   to the router, its value written — one that does not write fails the call before anything goes,
   nothing traced —, the trace, the `deprecated` event, `router.request` with the series the
   declaration gave, the close on timeout, the decoding of the answer.
2. `request` — `router/client/router-client.ts`: refuses a programmer's error first, binds the
   notification a call subscribes, when it subscribes one, and hands the rest to the core.
3. `request` — `router/shared/router-requester.ts`: refuses a programmer's error or an aborted
   signal, uncounted, then starts the call, counted when the router has a registry, draws an odd
   call id and waits under it (`pending-calls.ts`), then `deliver`s the envelope through
   `router-writer.ts` — written by `envelope.ts` and `header.ts`, traced, handed to the
   transport. A payload too large for one envelope goes as a transfer (`transfer.ts`,
   `sending-transfers.ts`): its opening first, then each chunk the server's credit lets go, the
   call waiting on the transfer's inactivity until the last is handed off.
4. On the server, `server/server.ts` counts the message as its session's activity, and
   `router/server/router-server.ts` notes the connection open. `receive`, in the core, reads the
   prefix and the envelope — what does not read goes through `gate` — and `receiveRequest` checks
   the call id, opens the call and its controller (`answering-calls.ts`), routes it, resolves its
   credential to the call's session — `sessionOf`, in the turn it came for none and `OPAQUE`, in a
   later one for `JWT` and `ELSEWHERE` — asks the resolver's `admit` on that session, and calls the
   resolver with it and the controller's `signal`. An opening is held first
   (`receiving-transfers.ts`), credited, and its chunks put together — `receiveChunk` — until the
   payload is whole.
5. The resolver — `createResolver`, in `router/shared/service-resolver.ts` — decodes the payload,
   its admission asked already, runs the callback, and its `response` calls `router.respond`, then
   the core's `respond`: an answer to a call no longer answered goes nowhere; `beforeAnswer` lets
   the server settle what the call subscribed; the answer carries the session when it changed
   (`announcements.ts`); the call closes as the transport takes the answer. A result too large for
   one envelope goes as a transfer — `sendResult` — its chunks under the client's credit, and the
   call closes once the last is handed off.
6. Back on the client, `receiveAnswer`, in `router/shared/router-requester.ts`, pairs the answer
   with its call by call id, and settles it. A result that opens a transfer is credited as a
   request's is, and the core's `receiveChunk` hands each chunk to the requester's
   `receiveResultChunk`, which settles the call once the result is whole, its call id reserved a
   while. A call its timeout or its signal ends sends a CANCEL first, and its call id stays reserved
   a while.

```mermaid
sequenceDiagram
  participant M as Service manager
  participant C as Client's router
  participant S as Server's router
  participant R as Resolver
  M->>C: request(payload)
  Note over C: call id 5 drawn,<br/>waited on
  C->>S: REQUEST · 5
  Note over S: call 5 opened,<br/>its controller made
  S->>R: resolver(request, signal)
  Note over C: its timeout passes
  C->>S: CANCEL · 5
  Note over C: 5 reserved: what comes<br/>late on it is dropped
  Note over S: call 5 forgotten,<br/>what it subscribed taken away,<br/>then its signal aborted
  R-->>S: response(…) goes nowhere
```

A request whose payload goes as a transfer, then one refused at its opening:

```mermaid
sequenceDiagram
  participant C as Client's router
  participant S as Server's router
  C->>S: REQUEST · 7 · TRANSFER of 20 MiB, its first MiB
  Note over S: routed, admitted,<br/>held within the budget
  S-->>C: CREDIT · 7 · up to 5 MiB
  C->>S: CHUNK · 7 · from 1 MiB, MORE
  C->>S: CHUNK · 7 · …
  S-->>C: CREDIT · 7 · further on
  C->>S: CHUNK · 7 · the last
  Note over S: whole: its resolver runs
  S-->>C: RESULT · 7
  C->>S: REQUEST · 9 · TRANSFER, its first MiB
  S-->>C: FAILURE · 9 · ACCESS_DENIED
  Note over C,S: refused at its opening:<br/>no credit, no chunk
```

**A subscription.**

1. `services.getNotification(procedure, dependencies)(payload, callback)()` — the service manager
   makes one notification per procedure (`router/shared/notification.ts`), which registers itself
   with the router before its request goes out, since a notification can come in the same read as
   the answer, then sends the request through the service requester's `callOf`, with the
   notification it `subscribes`.
2. The client's router binds the call id to the notification as the core draws it, and the request
   carries the SUBSCRIPTION flag — and PACED, when the notification has a `window`.
3. On the server, the resolver's `response.registerNotification()` calls `subscribe`, which puts
   the call in its place, in flight (`router/server/subscription-places.ts`); without it, a
   notification's successful answer subscribes the call all the same, as `beforeAnswer` settles it.
   Once the answer goes out, the subscription is established; the notification manager
   (`notification-manager.ts`) keeps who is subscribed to what.
4. `resolver.notify(payload)` sends one NOTIFICATION per connection subscribed, under the call id
   of its subscription. The client's core hands it to `onNotification`, which triggers the
   notification bound to that call id, and its callbacks. A paced subscription past its credit
   queues it instead, in its pacing (`notification-pacing.ts`), which goes with the subscription;
   the client, once the callbacks settled, sends a CREDIT with PACED, which the server's core hands
   to `onSubscriptionCredit`, and the queue lets go what it reaches.
5. The last callback taken away calls the notification's `unsubscribe`, the application's own
   request, then `router.unregisterNotification`: the call id is reserved, and cancelled unless
   `unsubscribe` was acknowledged. On the server, `unsubscribe` or the cancel takes the
   subscription away. A session that ends sends `SESSION_REQUIRED` on each subscription it bounds
   — a connection's session through `dropSubscriptions`, a credential's at its end or by
   `endSession` — and the client's `onUnpairedFailure` drops the notification, and tells its
   callbacks through `dropped`.

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  Note over C: call id 7 bound<br/>to the notification
  C->>S: REQUEST · 7 · SUBSCRIPTION
  Note over S: 7 in flight
  S-->>C: RESULT · 7
  Note over S: 7 established
  S-->>C: NOTIFICATION · 7
  Note over S: the session ends
  S-->>C: FAILURE · 7 · SESSION_REQUIRED
  Note over C: the notification dropped,<br/>its callbacks told
```

A paced subscription, its callback fetching:

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  C->>S: REQUEST · 7 · SUBSCRIPTION, PACED
  S-->>C: RESULT · 7
  S-->>C: NOTIFICATION · 7 · article 7, change 1
  Note over C: its callback fetches
  Note over S: changes 2 to 45 queued<br/>under one key: the latest kept
  Note over C: the fetch done
  C->>S: CREDIT · 7 · PACED · 2
  S-->>C: NOTIFICATION · 7 · article 7, change 45
```

A place is the one subscription a connection holds to a procedure in one session: its connection's,
or a credential's. The first call to take it keeps it; one answered while the holder is still in
flight waits, and takes the place should the holder fall:

```mermaid
stateDiagram-v2
  [*] --> InFlight: subscribe
  [*] --> Waiting: answered while the holder is in flight
  InFlight --> Established: its answer goes out
  InFlight --> [*]: a failure, an answer that does not go out, a cancel, a close
  Waiting --> Established: the holder falls
  Waiting --> [*]: the holder answered, a cancel, an unsubscribe, the session ends, a close
  Established --> [*]: a cancel, an unsubscribe, the session ends, a close
```

**A command**, the server's request of one client: `server.services.getCommand(procedure,
dependencies)(payload)({ connectionHandle })` goes through `callOf` to `request` in
`router-server.ts`, which needs the connection named and open, then to the core's requester, which
draws an even call id. The client runs it with the resolver `getCommandResolver` made, and answers
through its router's `respond`.

**The names, and the words they are chosen over.** Every name says one thing, and none is
abbreviated ([0003](../../docs/decisions/0003-one-word-one-meaning.md)).

| Not                           | Bead says                                    | Why                                                                                                                                             |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| message id                    | `callId`                                     | one number pairs a request, its answer, its cancel and its notifications: odd from a client, even from a server                                 |
| frame, frame type             | envelope, `kind`                             | a frame is what WebSocket carries the envelope in                                                                                               |
| header version                | the layout byte, `0xA1`                      | the first byte says how the rest is laid out                                                                                                    |
| error info beside the payload | a FAILURE, whose payload is the failure      | a failure travels once                                                                                                                          |
| function id, function name    | `procedureId`, `procedureName`               | no abbreviation                                                                                                                                 |
| service version               | `serviceRevision`                            | the version is the protocol's                                                                                                                   |
| device id                     | `destinationId`                              | what is behind the peer, which a relay passes the call on to                                                                                    |
| session id                    | an `OPAQUE` `credential`                     | 16 bytes, announced only when it changes                                                                                                        |
| auth type, token type         | a credential scheme, `credentialScheme`      | a type is a media type's or a language's, and a bare scheme a URI's: the credential scheme names a format, as HTTP's authentication scheme does |
| notification id               | the subscribing call's `callId`              | nothing of it travels in a payload                                                                                                              |
| req, res, err                 | `request`, `response`, `failure`             | no abbreviation                                                                                                                                 |
| exclude self                  | `exclude`                                    | it names the connection to leave out                                                                                                            |
| procedure type                | `procedureKind`                              | a type is a debug event's step; a procedure's kind is how it is called, never its envelopes'                                                    |
| API server, API client        | `createServiceServer`, `createServiceClient` | each serves or calls one service, and _API_ is an abbreviation                                                                                  |
| an error with a code          | `FailureError`                               | it says its side, its scope and where it was raised                                                                                             |

Four names mean exactly this, and no more. `hasNotification` asks whether the router holds this very
notification, not any of its procedure's. `registerNotification` holds a notification on a client's
router, before its request goes out, and subscribes the requester on a server's `response`.
`notify` sends to every connection subscribed, not to one. `unregisterNotification` unbinds the
call, and cancels it unless told the server ended it.

## A demo

`yarn demo` builds a page and a server with esbuild, into `demo/dist/`, and starts them on one port,
http://localhost:8080 — `DEMO_PORT` moves it. Two Bead servers, one over WebSocket and one over
HTTP, each listen on a local port of their own; the page's HTTP server passes each upgrade to
`/bead` on to the first, byte for byte, and each exchange on `/bead` to the second, through
`demo/relay.ts`, a small proxy that neither the protocol nor the transports know of. The page goes
over WebSocket, or over HTTP with `?transport=http`, where what the server sends of its own comes
back by a listen; `/health` gives both servers' health, and `/metrics` what both count into their
one metrics registry, in the Prometheus text format 0.0.4. With `?transport=worker`, the Bead
server and the identity provider run in a Web Worker of the page — `demo/worker.ts`, built to
`dist/worker.js` beside `dist/page.js` — and no backend answers anything but the files: that pair is
what a playground takes. `yarn playground:build:file` builds it, with the page, into
`demo/dist/playground/`, every path relative and nothing started — the site publishes it at
`/playground/bead/`, where the page, served as files alone, is its worker's and hides what needs a
server. In the console, `localStorage.setItem('bead:debug', 'd(rx), read')` sends the calls that filter
keeps to the console — and the envelopes, when it asks for them by `e(…)` — with no reload, and
`removeItem` stops it (`demo/debug.ts`). A listener only queues: the console is written when the
page is idle, in one collapsed group, since an open console rendering an object per event is what
slows a page through a burst. Every second, over whichever transport, the page reads the server it
is connected to by two calls like any other, which the logs and the counts it shows leave out:
`stats`, its health and what each layer holds, and `metrics`, its registry's exposition, the text
`/metrics` serves — so a server in a Web Worker, which no scraper reaches, shows what it counts
too. A Server panel shows the first, and the calls answered, how many, their mean and a median
estimated within its bucket; a Metrics panel shows, beside the server's registry, the one the page's
client counts into, a line a procedure — the calls made or answered, those in flight, their median
and p95, and what did not end in a result — and each exposition as a scrape reads it, which
`devtools/exposition.ts`, the DevTools panel's reader too, reads. The procedures, in `demo/offer.ts`, and the tokens, in `demo/token.ts`,
stand on Web Crypto alone, so the worker offers what Node's servers do. There is a button per kind of call — a read, a write, a subscription and its notifications, a
glyph drawn at random that crosses as a transfer either way and is shown, a slow call cancelled or timed out, a procedure's own failure, a command the
server sends back — and two logs, the calls and their envelopes, as the client sees them. A burst of
five changes, once subscribed, shows the two ways to follow one: the counter's state, paced, comes
as two notifications, the first and the latest; its signal, "it changed", comes five times, and the
page merges it into two reads.

A form signs up for a workshop through a service of its own, `SignUpService`, which beadc generates
from the demo's `.proto`, [`demo/proto/demo/v1/sign_up.proto`](demo/proto/demo/v1/sign_up.proto),
as [`demo/beadc.yaml`](demo/beadc.yaml) says, into `demo/gen/`: its request holds protovalidate's
rules — a name of 1 to 63 characters in a DNS label's shape, 1 to 10 seats, an email or a phone,
exactly one — which every server judges before its resolver, answering a request they refuse
`PAYLOAD_INVALID` (spec 18). The page reads the detail with `violationsOf`: each violation under the
field its path names, the field marked `aria-invalid` and described by it, the first focused, one of
no field above the form. "Validate before sending" calls through a client side whose options say
`validates`, which refuses the same request before anything goes on the wire. `yarn test:demo` runs
the demo's tests, in a Playwright config of their own: its procedures in Node, a server and a client
joined in memory, and the form in Chromium, against the static build `yarn playground:build:file`
makes.

The internal demo mounts beside the page a gateway of beadc's route table for that service,
`POST /api/SignUp/signUp` and `/openapi.json`, over a third Bead server on the in-memory transport;
the page shows the same sign-up as a `curl` and the gateway's answer, a refusal as RFC 9457's
problem, written by the runtime's own mapping where its server is a Web Worker. It lays its parts
out in scenes, one a tab, as `demo/scenes.ts` mounts them: the calls, the payload rules beside that
HTTP form, the sign-up's OpenAPI document, the server and its metrics, and `examples/hello` on both
sides, its TypeScript file beside its C# one (`demo/sides.ts`). The address's fragment names the
scene shown, `#rules`, and the logs stay in a rail beside the scenes, which a visitor folds away.
Each tablist follows the WAI-ARIA tabs pattern, in `demo/tabs.ts`. The page's type scale, spacing
and radii are penumbra's, the DevTools panel's copy of its two sheets, which the internal demo
serves and the static build writes into the page.

Its security is the library's. The demo's tokens are access tokens of RFC 9068's profile: the page
presents its token as a `JWT` on every call, its client's default `credential`, and the server
verifies it through its `credentials`, its key and its audience, so each call runs in its
credential's session. What a procedure admits reads that session, never the payload: a read needs a
session, by `requireSession`; a write needs a token whose `scope` holds `write`, by a
`beforeRequest` that reads `session.data`. A token that does not hold — its signature no longer
matching, its time past — is refused `SESSION_REQUIRED`, which withdraws it: `credentialWithdrawn`
tells the page, which asks to log in again, and until then a call that would present it fails
before it goes; the page's public reads, its stats and its metrics, present none. Each log-in is a session of its own, its token's `sid`:
`whoami` answers the call's session, its claims and its end, and `logout` ends that session alone,
by `endSession`, whoever else logged in under the same name. The key is drawn at each start, or
given by `DEMO_KEY`, in base64url, 32 bytes at least; a key published with its RFC is refused before
anything listens. Both servers time a connection's silence themselves, 120 s, since a session of the
demo's is a credential's and has no timeout of its own. A reader's glyph upload, 8 MiB, is refused
at its opening over WebSocket — one REQUEST, one FAILURE, and no chunk; over HTTP, its body crosses
first.

## The DevTools extension

`devtools/` is Bead's DevTools extension, Chrome's first
([decision 0015](../../docs/decisions/0015-a-pages-client-announces-itself-to-a-devtools-hook.md)).
`yarn devtools:build` builds it, unpacked, into `devtools/dist/`, which Chrome loads from
`chrome://extensions`, its developer mode on, by "Load unpacked". It adds a Bead panel to DevTools:

- **Calls**: a row a call the page's clients make or answer, newest first, as their `debug` events
  tell them, its steps and its envelopes met by its call id on its connection — its status by an
  icon and a colour, its procedure, its type, when it started, how long it took, how it ended in
  words (`ACCESS_DENIED, beyond 1 relay`, `procedure code 7`, `cancelled`), a command the server
  made read the right way round, and its bar on a waterfall. A row unfolds into its envelopes, in
  words (`CREDIT · up to 2.5 MiB`, `CHUNK · at 1 MiB · more`); a subscription keeps its last 50
  notifications and counts the others. Its **Envelopes** mode lists every envelope on its own. A
  call selected shows its **Overview**, its failure whole — where it was raised, the relays it
  crossed, its destination, and a PAYLOAD_INVALID's violations as a table, read by the package's own
  reader of its detail, a row each with its field, its rule, its words and its bounds, then the more
  its closing line counts, that its side stopped, or that the detail was cut; its **Payload**, as a
  tree where it reads as one; its **Exchange**, its envelopes as beads on its thread, a third lane
  for a destination behind a relay, a transfer's bytes against its credit; its **Diff**, a
  notification against the one before it, an answer against its procedure's last; and its **Trace**,
  the stack that made it, each frame opened in Sources.
- **State**: what a client's connection held at the moment a cursor stands on, rebuilt from the
  panel's records — its session, the calls in flight, the subscriptions and their credit, the
  transfers and how far they went. It replays nothing, and sends nothing to the page.
- **Timeline**: every call shown on one axis of time, a notification a ring, a chunk, a credit or a
  cancel a tick; dragging across it bounds the Calls list to that span.
- **Metrics**: what each client's registry counts, a row a procedure, read by
  `devtools/exposition.ts`, the demo's reader too: its calls, those that failed or are in flight, a
  median and a p95, its calls a second over the last minute, and its exposition as a scrape reads
  it; a procedure's name shows its calls alone, and a client given no registry says so.
- **Wire**: for a page whose clients announce nothing, the HTTP transport's exchanges the Network
  panel saw, read with the package's codec, a line an exchange and its envelopes beneath, each
  procedure named where a client of the page told its name, a PAYLOAD_INVALID summed up on one line
  by its first violation and their count; an exchange copies as the skeleton of an entry of
  `spec/conversations.json`.

The bar filters by client and by the package's own filter, as `bead:debug` reads one
(`d(rx), -token, e(request)`), the last filter that held kept while one is refused, with its
reason; Requests, Commands and Notifications write their selector into it, and Failed shows the
calls that failed. It pauses the panel's recording (`Ctrl+E`), clears it (`Ctrl+L`), keeps it
across a reload with Preserve log, and exports its records as JSON, `bead-devtools-log` at version
1, which Import reads back, pausing the recording so the page's records do not mix with the file's.
The keyboard moves through the calls (`↑`, `↓`), unfolds them (`→`,
`←`) and reaches the filter (`/`); a call's context menu copies its request, its answer, or a
snippet that makes it again by the page's own service manager, and hides or shows its procedure
alone. `←`, `→`, `Home` and `End` move across the view tabs and a call's tabs, and the `?` beside
the filter opens its syntax, which `Escape` closes. Its status bar's Detail choice puts a call's
detail right of the list, under it, or, at Auto, as DevTools' Elements panel places its sidebar:
beside a split wider than 680 px, under it otherwise. The splitter between them follows the
pointer, or, focused, `←` and `→` (`↑` and `↓` when stacked), `Home` and `End` to its limits, and
`Enter`, which collapses the list to its least and, pressed again, restores it. The list keeps its
least first, eight rows when stacked, and the detail its whole tab bar where the panel holds both;
the panel's page keeps both choices.

A client announces itself as it is built, so a page opened before the extension was installed shows
nothing until it reloads, which the panel offers; and the hook watches only while a panel is open —
from the first time the Bead tab is shown until DevTools closes — so the panel shows what came after
it opened, and a page nobody inspects pays nothing. While it watches, the hook takes, for each call
made, the stack that made it, and keeps an envelope's time to a fraction of a millisecond. A server
in a Web Worker of the page shows through its client, whose messages the Network panel does not show.

The panel, the hook and what they read are every browser's alike; each browser has its own glue.
Shared: `hook.ts`, in the page's world at `document_start`; `panel.ts` and `panel.html`, with the
model they draw from in `model/` and their views in `views/`, which ask of the browser only what
`host.ts` names; `records.ts`, `preview.ts` and `stack.ts`, which make each event plain before it
leaves the page; `wire.ts` and `exposition.ts`; and what the parts say to each other, in
`messages.ts`, JSON alone. Chrome's, in `chrome/`: its manifest; `bridge.ts`, beside the hook in the
extension's world, which alone may open a runtime port; `background.ts`, which pairs each tab's
page with the panel open on it; `devtools.ts`, which adds the panel; `panel.ts`, which makes the
panel's host of Chrome's API; and `api.ts`, the part of that API they use, typed. Its type scale
and spacing are penumbra's, its two sheets copied whole into `devtools/penumbra/` with the commit
they came from; the panel's skin over them, in `panel.html`, sets every colour the panel draws with,
DevTools' own.

`yarn test:devtools` runs its tests, in a Playwright config of their own, apart from the package's
unit project: its pure modules in Node, the panel's model among them, fed one traffic of the demo's
procedures, `__tests__/traffic.ts`; the extension loaded in Chromium against the demo's static
build, the page's calls followed to the panel and the watch stopped as the panel closes —
`hook.test.ts`, which holds the hook, the bridge and the background, since they run only together;
and the panel as a page on a fake DevTools API, for what only DevTools gives it.
`yarn devtools:build` and `yarn playground:build:file` make what they load.
