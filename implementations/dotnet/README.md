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
                                them, the service layer a service is served and called through,
                                the in-memory transport and the joined server transport
  Bead.Protobuf/                the check of a proto payload's records against its message's
                                descriptor, which a generated proto codec calls before
                                Google.Protobuf reads them, and what the validators beadc generates
                                are made of: Bead.Core references no Google.Protobuf
  Bead.Transport.WebSockets/    the server on Kestrel and the client on ClientWebSocket, one
                                connection class for both
  Bead.Transport.Http/          the server on Kestrel and the client on HttpClient
  Bead.Transcoding/             the transcoding layer, pure, no socket: a route table's types, its
                                templates matched raw, a request bound from its route, Bead's own
                                mapping of protobuf's JSON over a message's descriptor, a
                                failure's problem and a stream's events
  Bead.Transcoding.Http/        the gateway on Kestrel, which answers a service's procedures as
                                HTTP routes, one more client of the application's server
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
  Bead.Fuzz/                    the fuzz targets, the TypeScript side's one for one, which
                                tools/fuzz.mjs runs under libFuzzer (README, Fuzzing)
  Bead.ProtobufConformance/     protobuf's conformance testee, outside the solution: its
                                Generated/ is what tools/protobuf-conformance.mjs generates at run
                                time; failing.txt, its failure list (decision 0028)
  Bead.ProtovalidateDifferential/
                                the protovalidate differential's testee, outside the solution: its
                                Generated/ is what tools/protovalidate-differential.mjs generates
                                at run time (decision 0035)
```

A transport that needs a framework has a project of its own. Each transport server is a Kestrel
application of its own: one port for both comes from a proxy in front, never from a server they
share. The in-memory transport needs none, and lives in `Bead.Core`: `MemoryTransportClient` and
`MemoryTransportServer`, two routers of one process, each envelope copied and handed on in a later
turn, a credential and the client's address beside each request (spec 15.13). One server takes
its connections from several transports through `JoinedServerTransport`, each handle its own
transport's, two of one type refused (spec 15.14): an in-memory transport beside a WebSocket one,
say, its service offered once.

### HTTP/JSON transcoding, a gateway

`HttpGateway`, in `Bead.Transcoding.Http`, answers a service's procedures as routes of HTTP
([`spec/transcoding.md`](../../spec/transcoding.md), decision 0037), beside the wire, never in its
place: each call goes through one more Bead client of the application's own server, across a
`MemoryTransportServer` that server joined beside its WebSocket or HTTP one, so it meets the same
router, admission, sessions and services, each offered once. It reads everything from the route
table beadc writes in an output with `http: true`, `BeadHttp.cs`, whose `HttpRoutes.All`,
`OpenApiDocument` and `ProblemTypes` it is given; `Bead.Transcoding` is the layer it reads them
with.

```csharp
await using var memory = new MemoryTransportServer();
await using var server = new Server<string>(new JoinedServerTransport([memory, webSocket]));
await using var gateway = new HttpGateway(new HttpGatewayOptions
{
    Transport = memory,
    Routes = HttpRoutes.All,
    Document = HttpRoutes.OpenApiDocument.ToArray(),
    ProblemTypes = HttpRoutes.ProblemTypes,
});

await memory.Start();
await gateway.Start(new HttpGatewayStartOptions { Port = 8080 });
```

It routes, binds, reads and writes as the TypeScript side's gateway does, one form of every body
on both sides, and its README says it whole: every procedure a client calls at
`POST /api/<Service>/<procedure>`, one marked `NO_SIDE_EFFECTS` at `GET` and `HEAD` there too
where the query carries its request, each `google.api.http` rule as written; Bead's own mapping of
protobuf's JSON, never `JsonParser` or `JsonFormatter`; failures as `application/problem+json`;
notifications as Server-Sent Events, paced by what the response takes. **The route is no guard**:
a procedure answers its default route whatever rules map it, and what guards it is its admission.
Each exchange draws one Bead connection, closed as its response ends. It judges a request by the
HTTP transport's own gates from one `HttpPolicy`, which `HttpTransportServerOptions.Policy` takes
too; a member given in the policy and beside it, at its default as at any value, is refused.
It listens on its own port, or answers in the application's own Kestrel pipeline,
`endpoints.MapBeadGateway(gateway)`, its fallback endpoint; one origin for `/bead` and `/api/…`
comes from a proxy in front. It serves the document at `/openapi.json`, byte for byte, with its
`etag`; Swagger UI is the application's to serve.

Every body the gateway writes meets `MaximumUnsentBytes` and its send pace,
`MinimumSendBytesPerSecond` after `SendGracePeriod`: whole answers, problems, the document and
stream events. Whole bodies go in slices of at most 64 KiB, paced one slice at a time. A drop
reports the bound on `Error`, releases the exchange's place and socket, and cancels a stream's call.

The same `BeadHttp.cs` exports `<Service>HttpClient`, built with the gateway base URL as a `Uri`
and optional `HttpCallerOptions` from `Bead.Transcoding`: `Handler`, default `Authorization` and
`MaximumBodyBytes` (16,778,240). Its typed `<Procedure>(request, options)` methods call only the default
POST routes; `Subscribe<Procedure>(request, options)` returns an async sequence of `HttpEvent`
for a notifying procedure, its `IsResult` entry carrying `Result` first, then `Notification`.
The TypeScript client uses the same surface with lower-camel names: `client.sayHello(request)`
and `client.subscribeCountDown(request)`, with its gateway URL first in the constructor too.
A problem throws `FailureException` with its code, scope and detail. A stream's failure throws
too; an incomplete stream fails and never reconnects. Ending its iteration releases its response.
`HttpCallOptions` takes `CancellationToken`, an `Authorization` override and `WithoutAuthorization`
to omit any default. A credential destined off the machine in the clear fails
`DestinationUnreachable` before encoding or dispatch, by spec 13.4's URL rule. The client owns its
`HttpClient` and is disposed with `using`; its handler follows no redirect, and one given with
`AllowAutoRedirect` true is refused at construction. A supplied handler belongs to the application;
the client disposes only the handler it makes, whose connect follows RFC 8305. A base URL path
prefixes the default routes. Authorization uses the transport's field check; an empty field presents
no credential. The body bound applies to each unary answer and each event; exceeding it raises
`PayloadTooLarge`. A malformed body raises `PayloadUndecodable`, a truncated stream `DestinationLost`.
A gateway problem without a code maps by `bead-refusal`, then by status. Intermediary statuses map
by whether the procedure may have run; status and Retry-After stay in the failure's detail.

### The parts of the core, the manager and the HTTP server

`RouterCore`, `ServiceManager` and `HttpTransportServer` are each built of parts: a private nested
type of its owner, in a partial file named after both under `src/`, the type named after the
TypeScript module it is the twin of, in PascalCase (`RouterRequester`, `ServiceTrace`,
`HttpRequestExchange<TConnection>`); nothing of a part is reachable from outside its owner. One
row names no part: `router-limits.ts`, whose twin is the public `RouterLimits`, outside the owner.
The TypeScript side's README holds the same table:

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

## Modules

- **Transfers** are `Transfer`, `ReceivingTransfers` and `SendingTransfers`, wired in the router's
  core.
- **The relay** is `Relay`, its registrations under a lock, since they are registered from any
  thread and read on the router's scheduler; a destination is a `ConnectionTarget` or an
  `IRouterTarget`, which a client's router meets. Each `Destination` it lists says whether its
  connection closed; one registered on a connection the router no longer holds is closed at once,
  and `DestinationOptions.Replaces`, the registration the application holds, takes its id in its
  place under that lock, so no request meanwhile finds it unknown (spec 14.1, 14.4). A server's relay admits by default only a
  credential it forwards, `RequireCredential`: a call presenting a `JWT` or an `ELSEWHERE`, by its
  scheme alone unless the relay verifies, for its destination to verify; any other, one that
  presents none or `OPAQUE`, in leg A's connection's session or in none, is refused
  `ACCESS_DENIED`, its detail `a relay admits by default only a credential it forwards`, since leg
  A's session opens nothing at the destination (spec 14.3, 14.7). A relay whose requesters log in at
  it gives a `BeforeRoute` of its own, which checks the destination against the requester's session:

  ```csharp
  // a requester reaches a destination its session names, or forwards a credential its
  // destination verifies
  var isAdmitted = new BeforeRequest((request) =>
  {
      var forwards = request.Header.Credential?.Scheme is CredentialScheme.Jwt or CredentialScheme.Elsewhere;

      return forwards || (request.Session?.Data is Account account && account.Reaches(request.Header.DestinationId));
  });

  await using var server = new WebSocketServer<Account>(new WebSocketServerOptions
  {
      Server = new ServerOptions { Relay = new RelayOptions { BeforeRoute = isAdmitted } },
  });
  ```

  Its refusal is `ACCESS_DENIED`, without the default's detail. `ShareLegBSession`, in its place,
  lends leg B's session to every requester in a session at the relay, at every destination: it
  reads none, so a requester in any session acts at every destination with leg B's rights, as a
  deputy that lends its own authority (CWE-441).

- **The client's router** presents its `Credential` on every call that gives none of its own. A
  default is withdrawn once a call that presented it is refused `SESSION_REQUIRED`, whatever relays
  the refusal crossed: `CredentialWithdrawn` tells the application its scheme alone, never its
  bytes, and from then on, until the application gives it a default again — a credential, or
  `null`, which says "anonymous" in writing — every call that would present it fails before it
  goes, `SESSION_REQUIRED`, nothing sent and nothing withdrawn, so no call falls to its connection's
  session, or to none, in silence; `IsCredentialWithdrawn` says so (spec 13.4). A call that gives
  its own credential, `Credential.None` among them, goes: a call that needs no identity presents
  none, and so does the call that renews.

  ```csharp
  // the call that renews presents none: until a default is given again, a call that would
  // present it fails
  client.Router.CredentialWithdrawn += async (_) =>
  {
      var renewed = await SignIn(new RequestOptions { Credential = Credential.None });

      client.Router.Credential = Credential.Jwt(renewed);
  };
  ```

- **HTTP's transport** sets the shared behaviour where Kestrel's defaults would differ: no body
  limit of Kestrel's, so a body past the limit is the marked 413 and one past the budget the marked
  503; a refusal of HTTP/1 whose body it does not read says `connection: close`; `X-Forwarded-For`,
  on both transports, is read by one rule of its own, `TrustedProxies`, as the section below says.
  Kestrel's `MinRequestBodyDataRate` and `MinResponseDataRate` are none, Bead's own rules in their
  place (spec 15.12): a body that comes slower than `MinimumBodyBytesPerSecond`, 240, once
  `BodyGracePeriod`, 5 s, passed is refused 408 `too-slow`, marked and told, its connection kept;
  an answer, or a listen's batch, its socket still holds past the longer of `SendGracePeriod` and
  its bytes at `MinimumSendBytesPerSecond` is lost, its connection dropped at both ends and
  reported through `Error` as its connection ends, naming the bound and its value, as an outbox past
  `MaximumOutboxBytes` is. A head is Kestrel's
  `RequestHeadersTimeout`, the transport's `HeadersTimeout`, 30 s, on both transports, answered 408
  as HTTP answers it. Every answer written before its body is whole closes its socket in stages
  (RFC 9112 §9.6): its end flushed, what still comes read and dropped until its client closes or 2
  seconds pass, so a reset never erases it.
- **A WebSocket server** bounds its connections as an HTTP server does, `MaximumConnections`,
  10,000, and `MaximumConnectionsPerAddress`, 64, an upgrade past them refused 503 `busy` before its
  101, its place taken as it is judged (spec 15.2, step 8), so behind a proxy it needs
  `TrustedProxies` or `UnnamedProxies`, its health warning once its busiest address holds 80% of
  `MaximumConnectionsPerAddress`, gauged `largestAddressConnections`, before the first 503; and
  holds what waits for a client's socket to `MinimumSendBytesPerSecond` past `SendGracePeriod` and
  to `MaximumUnsentBytes`, the facade's drawn from its router's limits, a client behind either
  dropped, its close unclean, and reported through `Error` as its connection ends, naming the bound
  and its value. A message past `MaximumMessageBytes` fails its connection with 1009, drained until
  the peer's close or `CloseTimeout`, its close unclean whatever the peer answers, and reported
  through `Error` the same way (spec 15.3).
  `BeadHttpClient` is its client, as .NET's own is `HttpClient`.
  The connection's token, in `bead-connection-token`, is readable by script, where a socket is not:
  off the machine, HTTPS.
- **The transports** hold the same ready states on both sides, and the client reconnects alike, its
  delay, attempts, token and tap, its router rejecting what waited on the connection replaced.
  Neither client reads a `Retry-After`: a reconnection waits its own schedule, whatever a refusal's
  `Retry-After` asks (spec 15.7). A server listens on `localhost` unless `Start` is given an
  `Address`: both loopbacks, `127.0.0.1` and `::1`, on one port, so no other process can answer a
  client that reaches it by `localhost` on the family it tries first (spec 15.12). It binds each by
  a `Listen` of its own in one Kestrel application, as `ListenLocalhost` binds both, which it never
  calls: `ListenLocalhost` refuses a drawn port and reports `localhost` where it bound `127.0.0.1`
  alone. Under `FindOpenPort` the port is drawn on `127.0.0.1`; a port another socket holds on
  either loopback fails the start, and a drawn one is drawn again, eight times at most. Where the
  IPv6 loopback is absent — a container with IPv6 off — it listens on `127.0.0.1` alone and reports
  `127.0.0.1`. An `Address` given is `localhost`, both loopbacks as above, or an IP address written
  bare, RFC 3986's grammar and not the platform's parser's, which it listens on alone: a container,
  or any server another machine reaches, says `0.0.0.0` or `::`, and names its hosts; any other
  name — `LOCALHOST`, `localhost.`, `a.localhost` — `[::1]`, `127.1` or `0` is an
  `ArgumentException` as it starts. On the loopback
  it is secure (spec 13.4); behind a proxy on the same machine that serves the network in the
  clear, it says `Secure = false`. Both clients race the address families of a name, as RFC 8305 asks and Node's
  clients and the browsers do, through `HappyEyeballs`, a `SocketsHttpHandler.ConnectCallback`: a
  connect by `localhost` to a server on one family never waits out the other's refusal; an HTTP
  client given a `Handler` keeps the handler's behaviour. Neither follows a redirect: one
  answered to a connect or an upgrade fails it, its status named, and one answered to a send or a
  listen is lost, its `bead-refusal` unread (spec 15.6), each client's own handler built with
  `AllowAutoRedirect = false`. A `Handler` given follows none either: an `HttpClientHandler` or a
  `SocketsHttpHandler`, innermost of the `DelegatingHandler`s given, whose `AllowAutoRedirect` is
  true is an `ArgumentException` naming it as the client is built, where the TypeScript side,
  which cannot read a `fetch` before it answers, catches one at its first answer; a handler of
  another kind that follows all the same is caught by its answer's `RequestMessage`, gone to
  another URL than the one asked, which fails the connect, and loses the connection of a send or a
  listen.
- **The credential a transport carries** beside an envelope, which a call presenting `ELSEWHERE`
  stands for: over HTTP, each `POST`'s `Authorization`; over a WebSocket, its upgrade's, for every
  envelope of the connection, toward its server alone (spec 15.2, [decision
  0032](../../docs/decisions/0032-a-websocket-upgrade-from-no-page-carries-its-credential-beside-every-envelope.md)).
  `WebSocketConnectOptions` takes it as `Credential`, a string, or as `CredentialProvider`, called
  at each attempt, a reconnection's included, with the attempt's token, as SignalR's
  `AccessTokenProvider` is: where a credential past its end is renewed. A connect refuses, an
  `ArgumentException`, nothing moved: both given; one that is no field value — anything but visible
  ASCII, spaces and tabs, or a space or a tab first or last (RFC 9110 §5.5), which the HTTP client
  refuses alike before a send goes; one over `ws://` off the loopback. A value the provider hands
  that is no field value fails its attempt alike, which a reconnection does not try again; what it
  throws fails the attempt, a `WebSocketException` whose inner exception it is. `Carries` says what
  a call may present: over HTTP any field value, over a WebSocket the bytes its upgrade carried
  alone, compared by `CryptographicOperations.FixedTimeEquals`. An upgrade that carries an `Origin`
  carries none, whatever its `Authorization`: a page's browser writes its own authentication on it.
  One connection carries one credential: a client presents another by connecting again, and gives
  its router's default the same bytes, from one source; between the two, a call fails before it
  goes, `DESTINATION_UNREACHABLE`. A call's options present `Credential.Elsewhere(carried)`: the
  header's `Credential.Elsewhere()`, nothing to carry, a JWT with no token and a scheme to come are
  an `ArgumentException`, before the call starts (spec 13.4).

  ```csharp
  // one source for the upgrade's credential and the router's default, renewed together
  var token = await SignIn();
  client.Router.Credential = Credential.Elsewhere($"Bearer {token}");
  client.Router.CredentialWithdrawn += async (_) =>
  {
      token = await SignIn();
      client.Router.Credential = Credential.Elsewhere($"Bearer {token}");

      // a new connection, whose upgrade the provider gives the new credential
      await client.Reconnect();
  };
  await client.Connect(new WebSocketConnectOptions
  {
      Host = "localhost",
      Port = port,
      CredentialProvider = (_) =>
      {
          return ValueTask.FromResult($"Bearer {token}");
      },
  });
  ```

  No procedure is handed a bearer credential its call came with (spec 13.1). The `RequestHeader` a
  resolver, its callback and a `BeforeRequest` are handed, a relay's `BeforeRoute` among them,
  carries a `Credential` whose `Token` is none for a `JWT`, its scheme alone; what the transport
  carried beside an `ELSEWHERE`, and a `JWT`'s token, reach the side's verifier, its `Credentials`,
  and a relay, which moves them to leg B, alone. A server's `SessionOf`, asked for a call presenting
  none or `OPAQUE`, is handed a `SessionRequest` of its connection and its header, which carries no
  transport credential.

- **A `proto` payload** is read by the codec beadc generates over Google.Protobuf, which calls
  `ProtoRecords.Check`, of `Bead.Protobuf`, first: it walks the payload's records by the message's
  own descriptor, its shape built once and cached by it, and refuses what protobuf refuses where a
  stock library reads on, a field at a wire type its type does not take and a map's entry with a
  field it does not declare among them (spec 17.9, [decision
  0028](../../docs/decisions/0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).
  A project that binds `proto` references `Bead.Protobuf`, which carries Google.Protobuf with it.
- **A `proto` request's rules** are protovalidate's options on its message, which beadc compiles
  into each side's validator ([decision
  0035](../../docs/decisions/0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md)):
  `Validators.Of(rules)`, of `Bead.Protobuf`, makes the bindings' `Validate` of the rules it
  generates, which judge the message into an `IViolationSink`. The sink holds the violations a
  detail of `MaximumBytes` carries, each sized as its writer writes it, and counts the rest without
  building their path, so a judging holds a detail's worth whatever the request breaks; under
  `FailFast` it stops at the first. A `pattern` is a table beadc builds ahead of time,
  `Pattern.Matches` walking it a cell a code point. Rules written by hand, a `json` binding's, are
  judged alike through `Validators.Of`. The side that answers judges every request once it reads,
  before its resolver, and answers one its rules refuse `PAYLOAD_INVALID`, its violations in its
  detail, lines of canonical JSON that `Violations.Of` reads back; a client whose options say
  `Validates`, or a server's for its commands, judges the value before it is written. Every verdict
  of `spec/validations.json` plays through the validators beadc generates for
  `spec/validations.proto`, in `tests/Bead.Protobuf.Tests/Generated/`, which the root's
  `tools/check-validations.mjs` holds to beadc; the root's `tools/protovalidate-differential.mjs`
  plays them against protovalidate-es through the testee in
  `tools/Bead.ProtovalidateDifferential/`.
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
So is a request whose target holds an octet other than visible ASCII, in its path or its query, or
whose path's percent-decoding holds NUL, `%00`: Kestrel takes a control character, HTAB, a bare CR
and DEL in a target, which the transports and the gateway refuse over every protocol through
`HostsAndOrigins.IsVisibleTarget`, and refuses `%00` in a path itself; `%00` in a query, and every
other octet percent-encoded, are taken.
So is one whose value starts or ends with a space or a tab, which RFC 9113 §8.2.1 calls malformed
over HTTP/2, where Kestrel hands it on and the transport resets its stream; over HTTP/1.1 the parser
strips it first (RFC 9110 §5.5).

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
writes its upstream's address, as nginx does by default, none is needed. `["*"]` takes every host
and makes none of their origins the server's own: a page that rebinds its name to the server's
address passes the host's test, and is refused by the origin's, 403 `origin-refused`, so a page is
then taken only when `Origins` names it, and an application under `*` that serves its own page
names that page's host in `Hosts` or its origin in `Origins`. A client that is no browser and
writes its target as its `Origin` — Python's `websocket-client` does by default — is refused
alike under `*` by a name `Hosts` does not list: list that name, or have the client write no
`Origin`, as a Bead client writes none (spec 15.2, 15.5).

`Origins` names the origins a request may come from besides the server's own, `http://` or
`https://` followed by the request's authority when its host is one the server takes by name — one
every server takes, or one `Hosts` lists — never by `*`, none by default, each compared exactly. A
request with no `Origin` comes from no page, and is taken. `null` is refused as the transport is
built: a browser sends it for every page with no origin of its own — a sandboxed frame of any
site, a `file:` or a `data:` page, one whose origin it withholds — so naming it would let any site
drive the server and read every answer; serve the page from an origin, a local development
server's or the Bead server's own, and name that one.

Over HTTP, the server answers CORS to the origins `Origins` names and to no other (spec 15.12):
their preflight is answered, allowing `Authorization`, the fields it asks for and any other
field — `access-control-allow-headers` naming `authorization`, then its
`Access-Control-Request-Headers` as they came, its lines joined by `", "`, then `*`, so a browser
that caches names and no wildcard keeps the answer too — and every answer to them names their
origin and exposes every field, so a page of a listed origin connects, calls, listens and presents
`ELSEWHERE` in `Authorization`. Every exchange of a connection goes to its one URL, a listen's
cursor and wait in `bead-after` and `bead-wait`, which a browser's preflight cache keys, so a page
preflights its connection's opening and not each listen. No answer carries `Access-Control-Allow-Credentials`:
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
`Origins` entry that is `*`, since no origin wildcard exists, `null`, or anything but an origin as a
browser serializes it (RFC 6454 §6.2): a scheme in lower case, a host, a port with no leading
zero, nothing after; for `http`, `https`, `ws` and `wss`, the host in lower case and no default
port.

Behind a proxy, a server, over HTTP or over WebSocket alike, believes `X-Forwarded-For` from the
proxies `TrustedProxies` names, each an IP address or a network, `10.0.0.0/8` say, or the compose
network's, and as many more as `UnnamedProxies` counts: while the address reached is one they hold,
or one they do not while fewer than `UnnamedProxies` such addresses were passed, the field's next
entry from the right is the client's, so what a client wrote to the left of the first address past
the count that none of them holds is never read (spec 15.12). An entry is read in RFC 7239's node forms, `192.0.2.7`, `192.0.2.7:51234`,
`2001:db8::1` or `[2001:db8::1]:443`, its port dropped, and held in one form, IPv4-mapped as IPv4
and IPv6 as RFC 5952 writes it, hexadecimal throughout, by the transport's own reading rather than
`IPAddress.TryParse`'s; any other, `unknown` or a zone among them, ends the walk at the proxy that
wrote it. None trusts no proxy, the loopback among them; a name, a network whose bits past its
prefix are set, and a network of prefix 0, which would trust what every client writes, are an
`ArgumentException` as the transport is built. `Forwarded` is never read. The client's address so
read names its connection, `ip=` in its handle, and its refusals; its port is the socket's, the
nearest proxy's connection's behind one. A proxy neither listed nor counted is a client as any
other: every client behind it is its address, which names them on either transport and which
either server's `MaximumConnectionsPerAddress` counts, so a told `busy` whose `Address` is your
proxy's, or a `largestAddressConnections` near its ceiling on `/health`, is a proxy to list. A
proxy whose platform publishes its addresses is listed: Google Cloud's global load balancer by
`130.211.0.0/22`, `35.191.0.0/16` and the forwarding rule's own address, Cloudflare by its ranges,
an AWS ALB by its VPC's network. One whose addresses its platform does not publish — Heroku's
router, a serverless backend behind a load balancer — is counted, `UnnamedProxies`, one each, from 0
to 8, 0 by default, any other an `ArgumentOutOfRangeException` as the transport is built: a listed
proxy costs none of the count, wherever it stands, so a count is of the proxies the list does not
name alone, unlike Envoy's `xff_num_trusted_hops` and Express's `trust proxy` n, which count every
hop — a proxy both listed and counted hands the client an entry it wrote. A count is believed as
told: a request that reaches the server past a counted proxy, straight to its socket, is read by
entries its client wrote, so a server so reachable lists its proxies instead
([decision 0030](../../docs/decisions/0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md)).
A bound by address counts as one the users behind one NAT, and as many the addresses of one IPv6
network.

```csharp
// a sidecar on the loopback, listed, and Heroku's router before it, its addresses unpublished, counted
var server = new HttpTransportServer(new HttpTransportServerOptions
{
    TrustedProxies = ["127.0.0.1"],
    UnnamedProxies = 1,
});
```

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

A server's router tells each access it refuses, `AccessRefused`, an `AccessRefusal` of its stage,
`Credential` or `Admission`, the code answered, its reason — a `JWT`'s step of section 13.8, an
`OPAQUE`'s `session`, an `ELSEWHERE`'s `nothing-carried`, `verifier` or `end`, `scheme` for a scheme
the server takes none of, or the admission of Bead's own that refused, `requireSession`,
`requireCredential`, `shareLegBSession`, `no-before-route` — the scheme, what was called, the
connection, and the refused request's own address and port, over HTTP its exchange's, never its
connect's; never the credential, a claim of a token nor an admission's detail (spec 13.12). A
scanner's every token is an event: what the listener writes, and at what rate, is the
application's.

```csharp
server.Router.AccessRefused += (refusal) =>
{
    Console.Error.WriteLine($"access refused {refusal.Stage} {refusal.Code} {refusal.Reason}: {refusal.ServiceId}/{refusal.ProcedureId} from {refusal.Address}:{refusal.Port}");
};
```

A transport goes on through what its listener throws, a reconnection's listener among them, and
awaits nothing it returns (spec 15.1): what one throws is reported through the transport's `Error`,
which no router forwards to its own. A server gives its transport as `IServerTransport`, which
carries `Error` and `Refusal` alike, so an application hears both through `server.Transport`,
whichever transport it built, beside its router's; a client's, through the client transport it
built. An `async` lambda given to one of its events is `async void`, whose exception ends the
process, so a listener catches its own. The threading analyzers'
[VSTHRD101](https://microsoft.github.io/vs-threading/analyzers/VSTHRD101.html) says where one is
given, at build: Bead's own projects hold it, and an application's may, by
`Microsoft.VisualStudio.Threading.Analyzers`.

An error of a side's own, a resolver that throws or a result it cannot send, is reported through its
router's `Error` and answered `PROCEDURE_FAILED` with no detail: an exception's message is the
side's, never the peer's to read (spec 9.0).

```csharp
server.Router.Error += (reason, connectionHandle) =>
{
    Console.Error.WriteLine($"router, {connectionHandle ?? "no connection"}: {reason.Message}");
};
server.Transport.Error += (reason, connectionHandle) =>
{
    Console.Error.WriteLine($"transport, {(connectionHandle.Length == 0 ? "no connection" : connectionHandle)}: {reason.Message}");
};
```

Where the platform makes the sides differ, or a difference is still open, the [support
matrix](../../docs/support.md) has the row and its test.
