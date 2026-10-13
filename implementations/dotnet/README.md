# Bead, on the C# side

Bead is a binary wire protocol: the envelopes of a request, its result or failure, the notifications
of a subscription and the commands a server sends back, written at fixed offsets. This solution is
its C# implementation, at parity with the TypeScript side: the same behaviour, played from the same
conformance files in [`spec/`](../../spec/), and proven against the other side in the interop. The
rules its code keeps — interfaces and composition, every body a block, two parameters then an
options record, every warning an error, one serial scheduler a router, and how the surface maps in
.NET's terms — are [decision
0007](../../docs/decisions/0007-csharp-interfaces-blocks-two-parameters-no-warning.md)'s.

## Build and test

The .NET 10 SDK, as `global.json` pins it, with the test runner, Microsoft.Testing.Platform. From
this folder:

```sh
dotnet format Bead.slnx --verify-no-changes --exclude ../../builder/test/golden/csharp interop/Bead.Interop/Generated
dotnet build Bead.slnx
dotnet test --solution Bead.slnx
```

`dotnet format` leaves the generated code to its generator. `dotnet build` builds every project,
the builder's C# goldens among them, which `dotnet test` does not: it builds the test projects
alone. With `CI=true`, a restore that would change a `packages.lock.json` fails. The interop against
the TypeScript server needs that side installed; with `BEAD_INTEROP_REQUIRED=1`, an interop that
would skip fails instead.

## Layout

One solution, `Bead.slnx`:

```
src/
  Bead.Core/                    the codec, the router's core, both sides' routers, the service,
                                session and notification managers, the relay, the server over
                                them, and the service layer a service is served and called through
  Bead.Protobuf/                the check of a proto payload's records against its message's
                                descriptor, which a generated proto codec calls before
                                Google.Protobuf reads them: Bead.Core references no Google.Protobuf
  Bead.Transport.WebSockets/    the server on Kestrel and the client on ClientWebSocket, one
                                connection class for both
  Bead.Transport.Http/          the server on Kestrel and the client on HttpClient
  BannedSymbols.txt             what the banned-API analyzer refuses: the clock is given
interop/
  Bead.Interop/                 the interop service, which both sides serve alike
    Generated/                  its server and client, what beadc generates from the interop's
                                blueprint
    InteropHandlers.cs          its resolvers, written
    InteropCredentials.cs       its credentials: the key set and the verifier
  BannedSymbols.txt             what the banned-API analyzer refuses there: the service manager,
                                called through the generated server and client
  Bead.Interop.Server/          its server, which the TypeScript side's interop and its page of
                                another origin call
tests/
  Bead.*.Tests/                 a project's tests, beside it by name
  Bead.Goldens/                 the builder's C# goldens, builder/test/golden/csharp, compiled
                                under this side's rules as a consumer compiles them
  Shared/                       what several test projects link: the test clock, the durations'
                                helper, the JSON payloads, the addresses a server listens on
tools/
  Bead.ProtobufConformance/     protobuf's conformance testee, outside the solution: its
                                Generated/ is what tools/protobuf-conformance.mjs generates at run
                                time; failing.txt, its failure list (decision 0028)
```

A transport that needs a framework has a project of its own. Each transport server is a Kestrel
application of its own: one port for both comes from a proxy in front, never from a server they
share.

## Modules

- **Transfers** are `Transfer`, `ReceivingTransfers` and `SendingTransfers`, wired in the router's
  core.
- **The relay** is `Relay`, its registrations under a lock, since they are registered from any
  thread and read on the router's scheduler; a destination is a `ConnectionTarget` or an
  `IRouterTarget`, which a client's router meets.
- **HTTP's transport** sets the shared behaviour where Kestrel's defaults would differ: no body
  limit of Kestrel's, so a body past the limit is the marked 413 and one past the budget the marked
  503; a refusal of HTTP/1 whose body it does not read says `connection: close`; `x-forwarded-for`
  is read by one rule of its own. `BeadHttpClient` is its client, as .NET's own is `HttpClient`.
- **The transports** hold the same ready states on both sides, and the client reconnects alike, its
  delay, attempts, token and tap, its router rejecting what waited on the connection replaced. A
  server listens on `127.0.0.1` unless `Start` is given an `Address`, an IP address written bare,
  RFC 3986's grammar and not the platform's parser's: a container, or any server another machine
  reaches, says `0.0.0.0` or `::`, and names its hosts; a name, `[::1]`, `127.1` or `0` is an
  `ArgumentException` as it starts. On the loopback it is secure (spec 13.4); behind a proxy on the
  same machine that serves the network in the clear, it says `Secure = false`. Both clients race
  the address families of a name, as RFC 8305 asks and Node's clients and the browsers do, through
  `HappyEyeballs`, a `SocketsHttpHandler.ConnectCallback`: a connect by `localhost` to a server on
  one family never waits out the other's refusal; an HTTP client given a `Handler` keeps the
  handler's behaviour.
- **A `proto` payload** is read by the codec beadc generates over Google.Protobuf, which calls
  `ProtoRecords.Check`, of `Bead.Protobuf`, first: it walks the payload's records by the message's
  own descriptor, its shape built once and cached by it, and refuses what protobuf refuses where a
  stock library reads on, a field at a wire type its type does not take and a map's entry with a
  field it does not declare among them (spec 17.9, [decision
  0028](../../docs/decisions/0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).
  A project that binds `proto` references `Bead.Protobuf`, which carries Google.Protobuf with it.
- **The clock** is a `TimeProvider`, named `Clock`, which every layer takes and exposes ([decision
  0011](../../docs/decisions/0011-every-side-takes-its-time-from-a-clock-it-is-given.md)).

## Hosts and origins

Both transport servers judge a request's host and origin alike, by spec 15.12, through
`HttpTransportServerOptions` and `WebSocketTransportServerOptions`: `Hosts` before anything else of
a request but its form, `Origins` on an exchange, and on a WebSocket's upgrade once its version and
its form are a handshake's.

A field value that holds a control character other than HTAB, or a character past ASCII, is
answered 400 unmarked before anything else of the request is judged, at both transports, as HTTP
answers a malformed field (spec 15.12): Kestrel refuses an octet that is no UTF-8 and takes a
control character, which the transport refuses; over HTTP/2, its stream reset, `PROTOCOL_ERROR`.

A request names its authority by its target when the target is in absolute-form, `http://` or
`https://` in lower case, its `Host` judged as one field line alone, which an HTTP/1.0 request may
leave out (RFC 9112 §3.2.2), for which both servers set Kestrel's `AllowHostHeaderOverride` and read
the authority from the target as it came, never as Kestrel's `Uri` normalizes it; over HTTP/2, by its `:authority`, a `host` beside it
ignored (RFC 9113 §8.3.1), which Kestrel puts in the `Host`; otherwise by its `Host`. An authority
is a host and an optional port of 15.12's grammar, RFC 3986's narrowed: no userinfo, no
percent-encoded octet, no `*`, `+`, `,`, `;` or `=` in a name, no `IPvFuture` literal, no colon
without a port. Kestrel
answers an HTTP/1.1 request without a `Host`, or with two, or with an authority that is none, 400
before the application runs, unmarked, and resets the stream of such an HTTP/2 request,
`PROTOCOL_ERROR`, nothing written; the transport answers alike what Kestrel reads past.

Every server takes `localhost`, a name under `.localhost`, an IPv6 address in brackets and an IPv4
address, by the request's host, its port aside: no name a browser fetches is written as an IP
literal, and a localhost name resolves to the loopback, so a page cannot rebind its name to any of
them. `Hosts` names the hosts it takes besides, each a host without its port, compared in any ASCII
case as the field carries it, an IDN host in the punycode a browser sends: `["bead.example"]` takes
`bead.example` and `bead.example:8443` alike; none and `[]` take no other. Any other host, an empty
one and none are refused 403 `host-refused`, whatever the request, a page that rebinds its name to
the server's address among them. So a server reached by a name names it in `Hosts`: a public one,
one behind a proxy that keeps the `Host`, as Caddy and Traefik do by default, and a service reached
by its in-cluster name, a docker-compose service's or a Kubernetes Service's; behind a proxy that
writes its upstream's address, as nginx does by default, none is needed. `["*"]` takes every host,
and so reopens what the check closes: a page that rebinds its name to the server's address is then
its own origin.

`Origins` names the origins a request may come from besides the server's own, `http://` or
`https://` followed by the request's authority, none by default, each compared exactly, `null` among
them taking every page that sends it and, over HTTP, letting each read every answer. A request with
no `Origin` comes from no page, and is taken.

Over HTTP, the server answers CORS to the origins `Origins` names and to no other (spec 15.12):
their preflight is answered, allowing `Authorization` and any other field, and every answer to them
names their origin and exposes every field, so a page of a listed origin connects, calls, listens
and presents `ELSEWHERE` in `Authorization`. No answer carries `Access-Control-Allow-Credentials`:
no cookie goes across origins, and a `fetch` given to the TypeScript side's client must not use
`credentials: 'include'`. A gateway in front that answers CORS for the path stops, or replaces the
fields rather than appends them, once the server lists the origin: two `Access-Control-Allow-Origin`
fail the browser's check. A page of the public network reaching a server on the loopback or a
private address needs besides its user's permission, which the browser asks (Local Network Access),
in a secure context alone; a secure page reaching `http://` on a private address by a hostname
passes the browser's mixed-content block only with `targetAddressSpace: 'local'`, which a `fetch`
given to the TypeScript side's client adds. The server writes nothing for either. A WebSocket
answers no CORS, which no browser asks of an upgrade.

A server is refused as it is built, an `ArgumentException` naming the option and the entry, a
`Hosts` entry with a port, an empty one, one that is no host, or `*` beside another; and an
`Origins` entry that is `*`, since no origin wildcard exists, or neither `null` nor an origin as a
browser serializes it (RFC 6454 §6.2): a scheme in lower case, a host, a port with no leading
zero, nothing after; for `http`, `https`, `ws` and `wss`, the host in lower case and no default
port.

A refused host is told on the wire, 403 and `bead-refusal: host-refused`, which `curl -i` and a
browser's network panel show. Each refusal the server judges of its own it tells, the event
`Refusal`, a `TransportServerRefusal` of its status, its reason, the request's authority and origin
as they came and the client's address and port, never the target, a token or a credential: what to
add to `Hosts` or `Origins`. The 404 that ends a listen or an exchange as its connection closes is
told by `Close` alone. A client names the status and the reason it was refused with:
`BeadHttpClient` and `HttpTransportClient`'s connect, and `WebSocketTransportClient`'s, through
`CollectHttpResponseDetails`, "the server refused the upgrade: 403 host-refused"; a page's
WebSocket reads nothing past its close, 1006, and its server's tell is then what says why.

```csharp
server.Transport.Refusal += (refusal) =>
{
    Console.Error.WriteLine($"refused {refusal.Status} {refusal.Reason}: authority {JsonSerializer.Serialize(refusal.Authority)}, origin {JsonSerializer.Serialize(refusal.Origin)}, from {refusal.Address}:{refusal.Port}");
};
```

Where the platform makes the sides differ, or a difference is still open, the [support
matrix](../../docs/support.md) has the row and its test.
