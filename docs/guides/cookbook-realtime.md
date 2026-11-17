# Real-time recipes

Recipes for the questions a team meets once [the getting-started project](getting-started.md)
runs: who may call, what happens when a connection drops, how to watch the server, and how to see
a page's calls. Each builds on `StationService` and its C# server over WebSocket.

> **Nothing is published yet.** The runtimes come from a clone of Bead at a pinned commit, and
> beadc's image is built from it, as [the getting-started guide](getting-started.md) shows.

## Authenticate calls with a JWT and admission hooks

Bead authenticates a **call**, not a connection: a request presents a credential in its own
envelope, the server verifies it, and the call runs in the session it resolves to. A `JWT` is
verified as an access token of RFC 9068's profile, by keys the server is given, each with its
issuer and its one algorithm, `ES256` or `HS256`, for the audience the server names.

**The server verifies.** `ServerOptions.Credentials` holds the keys and the audience. This compiles
against the pinned runtime, beside the getting-started project's `MetricsRegistry`:

```csharp
    public static ServerOptions Options(JsonElement jwk, MetricsRegistry metrics)
    {
        return new ServerOptions
        {
            MetricsRegistry = metrics,
            // * a JWT presented on a call is verified with these keys, for this audience
            Credentials = new Credentials
            {
                Audience = "https://station.example.com",
                Keys =
                [
                    new JwtKey { Issuer = "https://id.example.com", Algorithm = JwtAlgorithm.Es256, Jwk = jwk },
                ],
            },
        };
    }
```

A credential that does not hold, another token or an expired `JWT`, is refused `SESSION_REQUIRED`; a
request presenting a scheme the server was given nothing for is refused `CREDENTIAL_UNSUPPORTED`.

**The `.proto` says who is admitted.** Admission is `none`, `session` (a call in a session), or a
`hook` by name, set on the file, the service or the procedure, the nearest winning. Here is
[`examples/hello`](../../examples/hello)'s procedure that admits by a hook:

```proto
  rpc CountDown(CountDownRequest) returns (CountDownResponse) {
    option (bead.procedure) = {
      id: 2
      notifies: {message: "hello.v1.Tick"}
      admission: {hook: "greeted"}
    };
  }
```

beadc writes a member for each hook into the service's `<Name>Admissions`, and the generated
server class requires every hook its procedures name. hello's C# server gives it so:

```csharp
        var hello = new HelloServer<TData>(new ServiceServerOptions<HelloProcedures>
        {
            Admissions = new HelloAdmissions
            {
                Greeted = new AdmissionHook
                {
                    Admits = (request) =>
                    {
                        return greeted.ContainsKey(request.ConnectionHandle);
                    },
                    Detail = "say hello first",
                },
            },
        });
```

**A hook reads the call's session.** A hook is synchronous: it sees the request's connection and
header, never its payload, and its call's session, `request.Session`. A `JWT`'s session data is
its claims set, a `JsonElement`, so a hook admits on a claim; this one compiles against the pinned
runtime:

```csharp
    public static AdmissionHook Operators()
    {
        return new AdmissionHook
        {
            // a JWT's session data is its claims set
            Admits = (request) =>
            {
                return request.Session?.Data is JsonElement claims
                    && claims.TryGetProperty("role", out var role)
                    && role.ValueKind == JsonValueKind.String
                    && role.GetString() == "operator";
            },
            Detail = "operators only",
        };
    }
```

A call a hook refuses is answered `ACCESS_DENIED`, with the hook's `Detail`.

**The client presents.** A TypeScript client gives its default credential as it is built, and
renews it when a call is refused `SESSION_REQUIRED`: the router withdraws it, and every call that
would present it fails before it goes until the application gives it another. From the
[TypeScript side's README](../../implementations/typescript/README.md#the-service-layer):

```ts
const client = createWebSocketClient({ credential: { scheme: CredentialScheme.JWT, token } });

// the call that renews presents none: until a default is given again, a call that would present it fails
client.router.on('credentialWithdrawn', () => {
  void signIn({ credential: { scheme: CredentialScheme.NONE } }).then((renewed) => {
    client.router.credential = { scheme: CredentialScheme.JWT, token: renewed };
  });
});
```

`CredentialScheme` comes from `@francisdesjardins/bead/client`. On the C# side, a client sets
`client.Router.Credential = Credential.Jwt(…)` and listens to `client.Router.CredentialWithdrawn`.

What to know before shipping it:

- **A page presents its `JWT` in the envelope**, never on the upgrade: a page's `WebSocket` writes
  no `Authorization` header, and an upgrade that carries an `Origin` carries no credential.
- **A `JWT` crosses only a secure connection**, TLS or the loopback. Over `ws://` off the loopback
  the call fails before it goes, `DESTINATION_UNREACHABLE`, its token kept.
- **TLS stands in front of the server**: the transport listens in the clear, behind a proxy that
  terminates TLS. A server on the loopback counts as secure; one behind a proxy on the same machine
  that serves the network in the clear says `Secure = false`. Behind a proxy, `TrustedProxies` and
  `UnnamedProxies` say whose `X-Forwarded-For` the server believes
  ([the C# side's README](../../implementations/dotnet/README.md)).
- A token renewed that resolves to the same identifier, its issuer with its `sid` or its `sub`,
  keeps the subscriptions its session bounds.

## Survive a dropped connection

A connection's life, on the client:

- **No reconnection is automatic.** The application asks for one, `client.reconnect(…)`, from the
  transport's `close` event, whose first argument says whether the close was clean. A reconnection
  tries again after 1 s by default, 5 attempts for a transport client; `delay`, `maximumAttempts`,
  `signal` and `tap` change that. On the C# side, `Reconnect` takes `TransportClientReconnectOptions`
  with `Delay`, `MaximumAttempts`, `CancellationToken` and `Tap`.
- **A subscription does not survive its connection.** The client drops its notifications when its
  connection closes or is replaced, and tells each through the services' `dropped` event, whose
  `failure` is `undefined` when the subscription went with its connection. A registration then asks
  anew: the application subscribes again, and reads the state anew.
- **A command resolver stays.** What `station.on('promptOperator', …)` registered answers on the
  new connection too.
- **A peer gone without a word** ends within two heartbeats: each WebSocket end pings every 30 s by
  default. A browser's socket cannot ping, and answers the server's pings by itself, so the
  server's heartbeat covers a page.

This client, run against the getting-started server on port 8080 while that server was killed and
started again, reconnected, subscribed again, and answered the server's command on the new
connection:

```ts
await using client = createWebSocketClient();
const station = new StationClient(client, { windows: { watchTelemetry: 1 } });

station.on('promptOperator', async (request, response) => {
  say(`client: promptOperator asked "${request.payload.question}"`);
  await response({ acknowledged: true, note: 'after a reconnection' });
});

let registration: INotificationRegistration | undefined;
let received = 0;
const second = Promise.withResolvers<void>();

const watch = async (): Promise<void> => {
  registration = await station.notifications.watchTelemetry(
    { stationId: 'ST-001', samples: 20 },
    (sample) => {
      received += 1;

      if (sample.sequence === 20) {
        say(`client: watchTelemetry reached #20 (${received} received so far)`);
      }
    }
  )();
};

// * a subscription does not outlive its connection: the client drops it, and says so
client.services.on('dropped', (procedure, failure) => {
  say(
    `client: dropped ${procedure.procedureName}, ${failure === undefined ? 'with its connection' : 'by the server'}`
  );
  registration = undefined;
});

// ! no reconnection is automatic: the application asks for it, then subscribes again
client.transport.on('close', (clean) => {
  if (!clean) {
    say('client: connection lost, reconnecting');
    client
      .reconnect({ maximumAttempts: 10, signal: AbortSignal.timeout(30_000) })
      .then(async () => {
        say('client: reconnected');
        await watch();
        say('client: subscribed again');

        const status = await station.getStationStatus({ stationId: 'ST-002' })();

        say(`client: getStationStatus ST-002 answered operatorAnswer="${status.operatorAnswer}"`);
        second.resolve();
      })
      .catch((reason: unknown) => {
        say(`client: reconnection failed: ${String(reason)}`);
        second.reject(reason);
      });
  }
});

await client.connect({ host: '127.0.0.1', port });
await watch();
say('client: subscribed');

await second.promise;
```

```text
client: subscribed
client: watchTelemetry reached #20 (20 received so far)
client: dropped watchTelemetry, with its connection
client: connection lost, reconnecting
client: reconnected
client: subscribed again
client: promptOperator asked "Read ST-002's status?"
client: getStationStatus ST-002 answered operatorAnswer="acknowledged: after a reconnection"
```

`INotificationRegistration` comes from `@francisdesjardins/bead/service`. A subscription the
**server** ends is dropped too, with its failure: past its queue's bounds (64 notifications or
1 MiB waiting, the server's pacing limits), it ends `CAPACITY_EXCEEDED`, and the client subscribes
again and reads the state anew.

On the server, a connection's end is its transport's `Close` event, which hello's C# server uses to
forget what it kept for that connection:

```csharp
        server.Transport.Close += (_, connectionHandle) =>
        {
            greeted.TryRemove(connectionHandle, out _);
        };
```

A server keeps a subscriber's connection and identifier, never the request that subscribed it: a
notifier outside a resolver keeps its own map from connection to what each subscribed to. A page
that goes can tell the server at once rather than leave its connection to time out, as Bead's demo
does on `pagehide` with `client.transport.disconnect()`.

## Expose Prometheus metrics from .NET

Bead counts calls and notifications into a registry you give it, and opens no port: the
application serves the text where it likes. The getting-started host gives the server a
`MetricsRegistry` and serves it from a small ASP.NET Core application on a port of its own:

```csharp
var metrics = new MetricsRegistry();

await using var webSocket = new WebSocketTransportServer(new WebSocketTransportServerOptions
{
    // ! a page's upgrade is refused 403 unless its Origin is listed here, exactly; a client
    // outside a browser sends none
    Origins = ["http://localhost:5173"],
});
await using var server = new Server<string>(webSocket, new ServerOptions { MetricsRegistry = metrics });
```

```csharp
// * Bead opens no port for its metrics: the application serves the registry's text where it likes
var builder = WebApplication.CreateSlimBuilder();

builder.WebHost.UseUrls("http://127.0.0.1:0");
// its first line on the standard output is the ports', not the host's log
builder.Logging.ClearProviders();

await using var application = builder.Build();

application.MapGet("/metrics", () =>
{
    var exposition = metrics.Exposition();

    return Results.Text(exposition.Text, exposition.ContentType);
});
await application.StartAsync();
```

ASP.NET Core comes with `Bead.Transport.WebSockets`, which references its framework, so a
`Microsoft.NET.Sdk` project writes its `using` lines itself: `Microsoft.AspNetCore.Builder`,
`.Hosting`, `.Http`, and `Microsoft.Extensions.Logging` for `ClearProviders`.

`Exposition()` gives the text in Prometheus's text format 0.0.4 with its content type,
`text/plain; version=0.0.4; charset=utf-8`, which a Prometheus 3 scrape requires. The walkthrough's
host binds `http://127.0.0.1:0`, a free port on the loopback drawn at each start, which its first
line reports; a deployment gives `UseUrls` the fixed address its Prometheus scrapes. The families, each labelled by `service` (its id in decimal) and
`procedure`, a call's by `type` (`request` or `command`), an ended one's by `outcome` and a
failure's by `code`:

| Family                              | Counts                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| `bead_client_call_duration_seconds` | how long each call this side made took (a histogram)         |
| `bead_client_call_handled_total`    | each call this side made, as it ended                        |
| `bead_client_call_started_total`    | each call this side made, as its router took it              |
| `bead_notifications_heard_total`    | each notification heard under a subscription this side holds |
| `bead_notifications_sent_total`     | each notification for one subscription, `sent` or `failed`   |
| `bead_server_call_duration_seconds` | how long each call this side answered took (a histogram)     |
| `bead_server_call_handled_total`    | each call this side answered, as it ended                    |
| `bead_server_call_started_total`    | each call this side answered, as its request opened it       |
| `bead_subscriptions_dropped_total`  | each subscription ended other than by its client's cancel    |

`bead_client_*` counts the calls a side makes, so a server's commands are there; `bead_server_*`
counts those it answers. What is under way is a series' started count less its handled counts.
Beside it, `await server.Health()` gives the verdict on the server's gauges, its `Status`
`HealthStatus.Pass`, `Warn` or `Fail`, and `await server.Gauges()` the gauges themselves, which
the application serves at a `/health` of its own; the library opens no endpoint for either.

A TypeScript client or server counts alike: `createMetricsRegistry()`, from
`@francisdesjardins/bead/client` or `/server`, given as `metricsRegistry`, and `exposition()`
gives `{ contentType, text }`
([Debugging and metrics](../../implementations/typescript/README.md#debugging-and-metrics)).

## Inspect a page's client in Chrome's DevTools

Bead's DevTools extension adds a **Bead** panel to Chrome's DevTools, which shows each client a
page builds: its calls and their envelopes, the server's commands among them, its subscriptions
and their credit, and what its metrics registry counts. It is built from the clone, as nothing is
published:

```sh
cd bead-pinned/implementations/typescript
node .yarn/releases/yarn-4.18.1.cjs install --immutable
node .yarn/releases/yarn-4.18.1.cjs devtools:build   # unpacked, into devtools/dist/
```

The clone's Yarn 4 is vendored under `.yarn/releases/`; where `yarn` is installed, `yarn install
--immutable` and `yarn devtools:build` are the same. Then, in Chrome, open `chrome://extensions`,
turn on developer mode, choose **Load unpacked**, and pick `devtools/dist/`.

The panel shows what came after it opened, and the getting-started page makes its calls as it
loads: open DevTools on the page, show the Bead tab, then reload the page. The panel's views:

- **Calls**: a row a call, a command the server made read the right way round; a
  `PAYLOAD_INVALID`'s violations as a table, a row each with its field, its rule and its bounds; a
  subscription keeps its last 50 notifications.
- **State**: what the client's connection held at a moment, the subscriptions and their credit
  among it.
- **Timeline**: every call on one axis of time, a notification a ring, a credit a tick.
- **Metrics**: what the client's registry counts. A client given none says so; one is given
  as its `metricsRegistry` option, made by `createMetricsRegistry()`.
- **Wire**: for a page whose clients announce nothing, the HTTP transport's exchanges, read with
  the package's codec.

What to know:

- A client built in a page announces itself to the panel unless its options say
  `devtools: false`; a client that announces builds nothing for the panel until one opens.
- A page opened before the extension was installed shows nothing until it reloads, which the
  panel offers.
- The panel reads a TypeScript client in the page; the C# server shows through the calls that
  client makes and answers. A server in a Web Worker of the page shows through its client.
- The extension is Chrome's; Firefox's is ahead.

For traces outside the panel, a client's `client.services.on('debug', …)` and its router's
`client.router.on('debug', …)` tell each call's steps and envelopes, kept by `filterDebug` and
`filterEnvelopeDebug`; the C# side has `RouterServer.Debug` and `DebugFilters.FilterDebug`
([Debugging and metrics](../../implementations/typescript/README.md#debugging-and-metrics)).
