# Getting started: a C# server and a TypeScript client

This guide builds one Bead service from an empty folder to a running C# (.NET 10) server and a
TypeScript client, in Node and in a browser page. Every file below is a file of a project built
and run this way outside the repository; every output quoted is what that project printed.

> **Nothing is published yet.** No Bead package is on npm, NuGet or crates.io, and beadc's image
> is on no registry. A team clones Bead at a commit it pins, builds beadc's image from that clone,
> and takes the runtimes from the same clone by path, so the generator and the runtimes are one
> commit. Publication is ahead; [the support matrix](../support.md) says what each side plays
> today and what is ahead.

## What you build

One service, `StationService`, with the three kinds of call that make Bead worth adopting:

1. **A request**, `GetStationStatus`, whose payload carries
   [protovalidate](https://github.com/bufbuild/protovalidate) rules: a request they refuse is
   answered `PAYLOAD_INVALID` before your resolver runs.
2. **A command**, `PromptOperator`: the server calls its client back, mid-call, and waits for the
   answer before it answers `GetStationStatus`.
3. **A paced subscription**, `WatchTelemetry`: the server notifies samples, and the client takes
   them at its own pace, by a window of credit; a sample that waits is replaced by a newer one of
   the same key, so a slow client reads the latest value, never a backlog.

The server is C#, over WebSocket. The client is TypeScript, run in Node and in a page.

## What you need

- Git, and Docker (or Podman) to run beadc's image.
- The .NET SDK 10.0.404 or later, for the server.
- Node 24.9 or later and npm, for the client.
- bash 3.2 or later, or PowerShell 7.6 or later (`pwsh`, not Windows PowerShell), for beadc's
  wrappers.

The layout this guide builds, Bead's clone beside your project:

```text
work/
├── bead-pinned/        Bead, cloned at the commit you pin
└── station/            your project
    ├── beadc.sh, beadc.ps1, beadc.yaml, buf.yaml
    ├── proto/station/v1/station.proto
    ├── gen/station.blueprint.json
    ├── dotnet/         the C# server; dotnet/gen/ is beadc's
    └── typescript/     the TypeScript client; typescript/gen/ is beadc's
```

## 1. Pin Bead and build beadc's image

Clone Bead and check out the commit you pin, then build beadc's image from that clone. The image
holds beadc with everything it runs (buf, protoc-gen-es, protoc), so your machine needs no
protobuf toolchain of its own ([the image](../../builder/README.md#the-image-and-its-wrappers)).

```sh
git clone https://github.com/francisdesjardins/bead bead-pinned
git -C bead-pinned checkout <commit>

cd bead-pinned
docker build -f builder/Dockerfile -t beadc:local .
cd ..
```

## 2. Start the project

beadc runs through two wrappers, `beadc.sh` and `beadc.ps1`, which the image prints. A project
commits both. Each runs the image `BEADC_IMAGE` names, here the one you just built.

```sh
mkdir station && cd station
docker run --rm beadc:local wrapper beadc.sh > beadc.sh
docker run --rm beadc:local wrapper beadc.ps1 > beadc.ps1
chmod +x beadc.sh
export BEADC_IMAGE=beadc:local

bash beadc.sh init station --language csharp --language typescript
```

```powershell
# in PowerShell 7.6 (pwsh); init writes beadc.sh beside it
mkdir station; cd station
docker run --rm beadc:local wrapper beadc.ps1 > beadc.ps1
$env:BEADC_IMAGE = 'beadc:local'

./beadc.ps1 init station --language csharp --language typescript
```

`init` writes `beadc.yaml`, `proto/station/v1/station.proto` with one service, `buf.yaml`, the
editor's copy of Bead's options and protovalidate's under `.beadc/include/`, and lines of
`.gitignore` (`.beadc/` is git's to ignore) and `.gitattributes`. It writes over no file: a
wrapper already there, byte for byte its own, it keeps. Without `--language`, it writes an output
for every language beadc targets, Rust's included; name the two you use. When you commit the
project, `git add --chmod=+x beadc.sh` keeps the wrapper executable, since git on Windows records
no mode.

Tagging the image under the name the wrappers carry, `docker tag beadc:local
ghcr.io/francisdesjardins/beadc:<version>` (`./beadc.sh version` prints it), runs it with no
`BEADC_IMAGE` at all. Where an execution policy refuses `beadc.ps1`, `pwsh -ExecutionPolicy Bypass
-File ./beadc.ps1 generate` runs it.

## 3. Write the contract

Replace `proto/station/v1/station.proto` with the service. Bead's options say what each `rpc` is:

- `option (bead.service)` gives the service its `id`, its `revision`, who is admitted (`none`
  here: anyone connected), and the enum of its own failures.
- `option (bead.procedure)` gives each procedure its `id`, which the wire carries instead of its
  name. With neither `command` nor `notifies`, it is a plain request. `command: {}` makes it a
  call the server makes to its client. `notifies: {message: …}` makes it a request that opens a
  subscription: its `rpc` returns its result message, the answer that subscribes, and the
  notifications are of the message it names.
- `buf.validate` rules on a request's fields are compiled by beadc into each side; the first set it
  compiles is listed in [Payload rules](../../builder/README.md#payload-rules).

```proto
syntax = "proto3";

package station.v1;

import "bead/options.proto";
import "buf/validate/validate.proto";

// A station's status, the operator it asks before it answers, and its telemetry, paced by its client.
service StationService {
  option (bead.service) = {
    id: 1
    revision: 1
    admission: {
      none: {}
    }
    failures: "StationFailure"
  };

  // Answers a station's status; asks the caller's operator to acknowledge first, by PromptOperator.
  rpc GetStationStatus(GetStationStatusRequest) returns (GetStationStatusResponse) {
    option (bead.procedure) = {
      id: 1
      failures: ["STATION_FAILURE_UNKNOWN_STATION"]
    };
  }

  // Asks the client's operator a question: a command the client answers, mid-call.
  rpc PromptOperator(PromptOperatorRequest) returns (PromptOperatorResponse) {
    option (bead.procedure) = {
      id: 2
      command: {}
    };
  }

  // Subscribes to a station's telemetry: answers the sampling period, then notifies each sample.
  rpc WatchTelemetry(WatchTelemetryRequest) returns (WatchTelemetryResponse) {
    option (bead.procedure) = {
      id: 3
      notifies: {message: "station.v1.TelemetrySample"}
    };
  }
}

// Which station, by its id: "ST-" and three digits.
message GetStationStatusRequest {
  string station_id = 1 [(buf.validate.field).string.pattern = "^ST-[0-9]{3}$"];
}

// The station's status, and what its operator answered.
message GetStationStatusResponse {
  string station_id = 1;
  bool online = 2;
  string operator_answer = 3;
}

// What the server asks the operator.
message PromptOperatorRequest {
  string question = 1;
}

// What the operator answered.
message PromptOperatorResponse {
  bool acknowledged = 1;
  string note = 2;
}

// Which station's telemetry, and how many samples, 1 to 20.
message WatchTelemetryRequest {
  string station_id = 1 [(buf.validate.field).string.pattern = "^ST-[0-9]{3}$"];
  int32 samples = 2 [(buf.validate.field).int32 = {
    gte: 1
    lte: 20
  }];
}

// The period between samples.
message WatchTelemetryResponse {
  int32 period_ms = 1;
}

// One sample of a station's telemetry.
message TelemetrySample {
  string station_id = 1;
  int32 sequence = 2;
  double temperature_celsius = 3;
}

// What a station call answers instead.
enum StationFailure {
  STATION_FAILURE_UNSPECIFIED = 0;
  // No station by that id.
  STATION_FAILURE_UNKNOWN_STATION = 1;
}
```

Bead keeps `stream` for its own, so an `rpc` that streams is refused, and so is one with no
`(bead.procedure)`, its id not to be guessed. `./beadc.sh check` says so, with the place:

```text
proto/station/v1/station.proto:36:3: error STREAM_RESERVED: station.v1.StationService.WatchTelemetry streams, which Bead keeps for its own streams
proto/station/v1/station.proto:28:3: error PROCEDURE_OPTIONS: station.v1.StationService.PromptOperator has no (bead.procedure): its id cannot be guessed
```

Every rule beadc holds a `.proto` to is in [The rules](../../builder/README.md#the-rules).

## 4. Say what each language gets

`beadc.yaml` names the outputs. Here the C# side serves and the TypeScript side calls, so each
output writes only its half: `server: {}` writes the server class and no client, `client: {}` the
client class and no server.

```yaml
# beadc.yaml: station's services, from its .proto, generated in each language. ./beadc.sh
# generate (or ./beadc.ps1 generate) writes them, and generate --check holds them there.
version: 1
source:
  proto: [proto]
blueprint: gen/station.blueprint.json
outputs:
  # the C# side serves: the server class alone, no StationClient
  - language: csharp
    out: dotnet/gen
    server: {}
  # the TypeScript side calls: the client class alone, no StationServer
  - language: typescript
    out: typescript/gen
    importExtension: ts
    client: {}
# the output folders are beadc's own: generate takes out what it no longer writes there
clean: true
```

Then check and generate. Both print nothing when all is well.

```sh
./beadc.sh check
./beadc.sh generate
./beadc.sh generate --check   # in CI: fails when a generated file is not what the .proto gives
```

`generate` writes the blueprint, `gen/station.blueprint.json`, and each output:

| Output                        | Files                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| C#, `dotnet/gen/`             | `Station/V1/StationBead.cs` (Bead's server code), `Station/V1/Station.cs` (protoc's messages), `Bead/Protobuf/Options.cs`      |
| TypeScript, `typescript/gen/` | `station/v1/station_bead.ts` (Bead's client code), `station/v1/station_pb.ts` (protoc-gen-es's messages), `bead/options_pb.ts` |

The names follow the `.proto`: the service is `Station`, its `Service` suffix taken off; a
procedure is its `rpc` with its first letter lowered, `getStationStatus`; a failure is its enum
value less the enum's prefix, `UNKNOWN_STATION`
([The names](../../builder/README.md#the-names)). What each output holds:

| C#, namespace `Station.V1`                                                                  | TypeScript                                                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `StationProcedures.GetStationStatus`, `.PromptOperator`, `.WatchTelemetry`, `.All`          | `StationProcedures.getStationStatus`, `.promptOperator`, `.watchTelemetry`   |
| `StationFailures.GetStationStatus.UnknownStation`, `StationFailures.Is(exception, failure)` | `StationFailures.is(error, 'UNKNOWN_STATION')`                               |
| `StationServer<TData>`: `On`, `Command`, `Notify`, `Offer`, `ProceduresWithoutResolver()`   | `StationClient`: `getStationStatus`, `watchTelemetry`, `notifications`, `on` |
| `StationCommands.PromptOperator`, `StationNotifiers.WatchTelemetry`, `StationAdmissions`    | `StationClientOptions`, `StationWindows`                                     |

Commit the generated files beside the `.proto`; `generate --check` holds them to it.

## 5. Write the C# server

The server is a console project that references two of Bead's C# projects in the clone, by path:
`Bead.Transport.WebSockets`, which brings the core, and `Bead.Protobuf`, which the generated
message codecs and validators call. `Google.Protobuf` is the version the generated header names as
its floor.

`dotnet/StationServer.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <!-- StationService's C# server, over WebSocket, generated by beadc into gen/ from ../proto. -->
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>StationHost</RootNamespace>
  </PropertyGroup>

  <ItemGroup>
    <!-- ! no package is published yet: the runtime comes from a clone of Bead at a pinned commit,
         beside this project, by path -->
    <ProjectReference Include="../../bead-pinned/implementations/dotnet/src/Bead.Transport.WebSockets/Bead.Transport.WebSockets.csproj" />
    <!-- the check a generated proto codec runs, and the validators of the .proto's rules -->
    <ProjectReference Include="../../bead-pinned/implementations/dotnet/src/Bead.Protobuf/Bead.Protobuf.csproj" />
    <!-- the version beadc's header names as the floor, "for Google.Protobuf 3.36.2 or later" -->
    <PackageReference Include="Google.Protobuf" Version="3.36.2" />
  </ItemGroup>
</Project>
```

`dotnet/global.json` and `dotnet/nuget.config`, which keeps a machine's own feeds out of the
restore:

```json
{
  "sdk": {
    "version": "10.0.404",
    "rollForward": "latestFeature"
  }
}
```

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- nuget.org alone, whatever the machine's own configuration adds: Google.Protobuf comes from there. -->
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
```

### The resolvers

The resolvers are the only service code you write. `GetStationStatus` refuses a station it does
not know with the service's own failure, then sends `PromptOperator` to the caller's own
connection and waits for its answer before it answers. A command waits 5 seconds when none is
given; a person answers slower, so this one waits 30. `WatchTelemetry` answers, which subscribes
the caller, then notifies its samples to that connection alone, each under the station's key.

`dotnet/StationResolvers.cs`:

```csharp
using Bead;
using Station.V1;

namespace StationHost;

/// <summary>StationService's resolvers: the only code its server writes, beside the generated <see cref="StationServer{TData}"/>.</summary>
public static class StationResolvers
{
    // the stations this server knows
    private static readonly HashSet<string> Known = ["ST-001", "ST-002"];

    // how long the server waits between two samples
    private const int PeriodMs = 10;

    /// <summary>StationService, offered on <paramref name="server"/>.</summary>
    public static StationServer<TData> Offer<TData>(IBeadServer<TData> server)
    {
        var station = new StationServer<TData>();

        station.On(StationProcedures.GetStationStatus, async (request, response) =>
        {
            var stationId = request.Payload.StationId;

            if (!Known.Contains(stationId))
            {
                await response.Fail(StationFailures.GetStationStatus.UnknownStation, $"no station {stationId}");

                return;
            }

            // * the command goes to the caller's own connection, mid-call: the call answers once the
            // operator has
            var answer = await station.Command.PromptOperator(new PromptOperatorRequest { Question = $"Read {stationId}'s status?" })(
                new CommandOptions
                {
                    ConnectionHandle = request.ConnectionHandle,
                    // ! 5 seconds when none is given: a person answers slower than that
                    Timeout = TimeSpan.FromSeconds(30),
                });

            Console.Error.Write($"server: promptOperator answered acknowledged={answer.Acknowledged} note=\"{answer.Note}\"\n");

            await response.Answer(new GetStationStatusResponse
            {
                StationId = stationId,
                Online = true,
                OperatorAnswer = answer.Acknowledged ? $"acknowledged: {answer.Note}" : "declined",
            });
        });

        station.On(StationProcedures.WatchTelemetry, async (request, response) =>
        {
            var connectionHandle = request.ConnectionHandle;
            var payload = request.Payload;

            // * the answer subscribes the caller; the notifications follow it
            await response.Answer(new WatchTelemetryResponse { PeriodMs = PeriodMs });

            for (var sequence = 1; sequence <= payload.Samples; sequence += 1)
            {
                await station.Notify.WatchTelemetry(
                    new TelemetrySample { StationId = payload.StationId, Sequence = sequence, TemperatureCelsius = 20 + (sequence / 10.0) },
                    new NotifyOptions
                    {
                        Filter = (subscriber) =>
                        {
                            return subscriber.ConnectionHandle == connectionHandle;
                        },
                        // a sample past the client's window replaces the one of the same station
                        // still waiting: the client reads the latest, never a backlog
                        Key = payload.StationId,
                    });
                await Task.Delay(PeriodMs);
            }
        });

        station.Offer(server);

        return station;
    }
}
```

A request its rules refuse never reaches these resolvers: the server answers it
`PAYLOAD_INVALID` first.

### The host

The WebSocket transport is a Kestrel application of its own, started on its own port; it is not
mapped into an ASP.NET Core pipeline. A page's upgrade is refused 403 unless its `Origin` is listed
in `Origins`, exactly; a client outside a browser sends none. Bead opens no port for its metrics,
so the host serves the registry's text on `/metrics`, from a small ASP.NET Core application on a
port apart.

`dotnet/Program.cs`:

```csharp
using System.Text.Json;
using Bead;
using Bead.Transport.WebSockets;
// ASP.NET Core comes with Bead.Transport.WebSockets, which references its framework
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using StationHost;

// StationService over WebSocket on 127.0.0.1, and its metrics on /metrics, a port apart: its first
// line on the standard output says both ports, {"port":n,"metrics":m}; it serves until its
// standard input closes. `dotnet run -- 8080` serves on 8080, no argument on any free port.
var port = args.Length > 0 ? ushort.Parse(args[0], System.Globalization.CultureInfo.InvariantCulture) : (ushort)0;

var metrics = new MetricsRegistry();

await using var webSocket = new WebSocketTransportServer(new WebSocketTransportServerOptions
{
    // ! a page's upgrade is refused 403 unless its Origin is listed here, exactly; a client
    // outside a browser sends none
    Origins = ["http://localhost:5173"],
});
await using var server = new Server<string>(webSocket, new ServerOptions { MetricsRegistry = metrics });

server.Router.Error += (reason, connectionHandle) =>
{
    Console.Error.Write($"server: {connectionHandle ?? "no connection"}: {reason.Message}\n");
};
server.Transport.Refusal += (refusal) =>
{
    Console.Error.Write($"server: refused {refusal.Status} {refusal.Reason}\n");
};

StationResolvers.Offer(server);

var address = await webSocket.Start(new TransportServerStartOptions { Address = "127.0.0.1", Port = port, FindOpenPort = port == 0 });

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

var metricsPort = new Uri(application.Urls.First()).Port;

await Console.Out.WriteAsync($"{JsonSerializer.Serialize(new Dictionary<string, int> { ["port"] = address.Port, ["metrics"] = metricsPort })}\n");
await Console.Out.FlushAsync();

await Console.In.ReadToEndAsync();
await application.StopAsync();
```

Build it, and start it on port 8080:

```sh
cd dotnet
dotnet build -c Release
dotnet run -c Release -- 8080
```

Its first line says its two ports, the metrics port chosen free:

```text
{"port":8080,"metrics":59546}
```

It serves until its standard input closes.

## 6. Write the TypeScript client

The client takes the runtime from the clone by npm's `file:` protocol. The runtime is its `.ts`
sources, so the project compiles them under its own options and bundles them with esbuild.
`@bufbuild/protobuf` is what the generated messages run on.

`typescript/package.json`:

```json
{
  "name": "station-client",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "esbuild src/main.ts --bundle --preserve-symlinks --platform=node --format=esm --target=node24 --outfile=dist/main.mjs",
    "build:page": "esbuild src/page.ts --bundle --preserve-symlinks --platform=browser --format=esm --target=es2024 --outfile=dist/page.js",
    "type-check": "tsc --noEmit",
    "start": "node dist/main.mjs"
  },
  "dependencies": {
    "@bufbuild/protobuf": "2.16.0",
    "@francisdesjardins/bead": "file:../../bead-pinned/implementations/typescript"
  },
  "devDependencies": {
    "@types/node": "^24.19.2",
    "esbuild": "0.28.2",
    "typescript": "7.0.2"
  },
  "engines": {
    "node": ">=24.9"
  }
}
```

`typescript/tsconfig.json`, what a consumer of the runtime's sources sets:

```jsonc
{
  // what a consumer of Bead's TypeScript runtime sets: the runtime is its .ts sources, compiled
  // under these options, and esbuild bundles them
  "compilerOptions": {
    "strict": true,
    // the runtime's imports name no extension: a bundler's resolution
    "module": "ESNext",
    "moduleResolution": "bundler",
    // beadc's imports name their .ts
    "allowImportingTsExtensions": true,
    "lib": ["ES2024", "ESNext.Disposable", "ESNext.Iterator", "DOM"],
    "types": ["node"],
    "skipLibCheck": true,
    // ! the runtime is a link to a clone: read through it, its imports resolve from this project
    "preserveSymlinks": true,
    "noEmit": true,
  },
  "include": ["src/**/*", "gen/**/*"],
}
```

### In Node

The client registers its answer to `promptOperator` before it connects, since the server may ask
as soon as a call is under way. A call stays curried, `station.getStationStatus(payload)()`: the
second call sends it, with its options when it has any. The window of 1 credits the next sample
only once the callback before it has settled, the promise it returns included.

`typescript/src/main.ts`:

```ts
// StationService's TypeScript client, in Node: it answers promptOperator, calls getStationStatus
// with a valid, an invalid and an unknown station, and follows watchTelemetry at a window of 1.
// `node dist/main.mjs <port>`.

import { setTimeout as sleep } from 'node:timers/promises';
import { FailureError, FailureScope, ProtocolCode } from '@francisdesjardins/bead/client';
import { createWebSocketClient } from '@francisdesjardins/bead/websocket-client';
import { StationClient, StationFailures } from '../gen/station/v1/station_bead.ts';

// how long each telemetry callback holds itself: longer than the server's period, so samples pile up
const HOLD_MS = 50;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const port = Number(process.argv[2]);

await using client = createWebSocketClient();
// * a window of 1: the next sample comes once the callback before it has settled
const station = new StationClient(client, { windows: { watchTelemetry: 1 } });

// ! registered before connect: the server may ask as soon as a call is under way
let prompts = 0;

station.on('promptOperator', async (request, response) => {
  prompts += 1;
  say(`client: promptOperator asked "${request.payload.question}"`);

  await response({ acknowledged: true, note: 'checked by Node' });
});

await client.connect({ host: '127.0.0.1', port });

// 1. a valid request: the server prompts the operator, then answers
const status = await station.getStationStatus({ stationId: 'ST-001' })();

say(
  `client: getStationStatus ST-001 answered online=${status.online} operatorAnswer="${status.operatorAnswer}" (prompts so far: ${prompts})`
);

// 2. a request its rules refuse: PAYLOAD_INVALID, before the resolver, so no prompt
try {
  await station.getStationStatus({ stationId: 'station one' })();
  say('client: getStationStatus "station one" answered, unexpectedly');
} catch (error) {
  if (
    error instanceof FailureError &&
    error.scope === FailureScope.PROTOCOL &&
    error.code === ProtocolCode.PAYLOAD_INVALID
  ) {
    say(
      `client: getStationStatus "station one" refused PAYLOAD_INVALID, detail: ${JSON.stringify(error.detail)} (prompts so far: ${prompts})`
    );
  } else {
    throw error;
  }
}

// 3. a station the server does not know: the service's own failure
try {
  await station.getStationStatus({ stationId: 'ST-999' })();
} catch (error) {
  if (StationFailures.is(error, 'UNKNOWN_STATION')) {
    say(
      `client: getStationStatus ST-999 failed UNKNOWN_STATION, detail: ${error.detail} (prompts so far: ${prompts})`
    );
  } else {
    throw error;
  }
}

// 4. the subscription, paced: one callback at a time, the latest sample after each
const SAMPLES = 20;
const received: number[] = [];
let inFlight = 0;
let most = 0;
const last = Promise.withResolvers<void>();

const registration = await station.notifications.watchTelemetry(
  { stationId: 'ST-001', samples: SAMPLES },
  async (sample) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    received.push(sample.sequence);
    await sleep(HOLD_MS);
    inFlight -= 1;

    if (sample.sequence === SAMPLES) {
      last.resolve();
    }
  }
)();

await last.promise;
await registration.unregister();

say(
  `client: watchTelemetry ST-001 received sequences ${received.join(' ')} of ${SAMPLES} sent, at most ${most} callback at a time`
);

// 5. a subscription its rules refuse
try {
  await station.notifications.watchTelemetry({ stationId: 'ST-001', samples: 50 }, () => {})();
} catch (error) {
  if (error instanceof FailureError && error.code === ProtocolCode.PAYLOAD_INVALID) {
    say(
      `client: watchTelemetry samples=50 refused PAYLOAD_INVALID, detail: ${JSON.stringify(error.detail)}`
    );
  } else {
    throw error;
  }
}

await client.disconnect();
```

Install, check and build, then run it against the server:

```sh
cd typescript
npm install
npm run type-check
npm run build
node dist/main.mjs 8080
```

It prints:

```text
client: promptOperator asked "Read ST-001's status?"
client: getStationStatus ST-001 answered online=true operatorAnswer="acknowledged: checked by Node" (prompts so far: 1)
client: getStationStatus "station one" refused PAYLOAD_INVALID, detail: "{\"bounds\":{\"pattern\":\"^ST-[0-9]{3}$\"},\"fieldPath\":\"station_id\",\"message\":\"does not match regex pattern `^ST-[0-9]{3}$`\",\"ruleId\":\"string.pattern\"}\n{\"more\":0}" (prompts so far: 1)
client: getStationStatus ST-999 failed UNKNOWN_STATION, detail: no station ST-999 (prompts so far: 1)
client: watchTelemetry ST-001 received sequences 1 5 9 13 17 20 of 20 sent, at most 1 callback at a time
client: watchTelemetry samples=50 refused PAYLOAD_INVALID, detail: "{\"bounds\":{\"gte\":1,\"lte\":20},\"fieldPath\":\"samples\",\"message\":\"must be greater than or equal to 1 and less than or equal to 20\",\"ruleId\":\"int32.gte_lte\"}\n{\"more\":0}"
```

What each line shows:

- **The request, valid.** The server's `promptOperator` reaches the client while
  `getStationStatus` waits, and the answer comes back into the resolver's result.
- **The request, refused by its rules.** `PAYLOAD_INVALID`, its detail a violation a line in
  canonical JSON, then `{"more":0}`. The prompt count stays 1: the resolver never ran. The
  TypeScript client judges no request by default, so the server judged it.
- **The service's own failure.** `StationFailures.is(error, 'UNKNOWN_STATION')`, with the detail
  the resolver wrote.
- **The paced subscription.** Twenty samples sent 10 ms apart, a 50 ms callback, a window of 1:
  never two callbacks at once, the last sample always, and the ones between replaced by newer ones
  of the same key while they waited. Which ones arrive varies from run to run.

### In a page

The page answers `promptOperator` with a dialog, so the operator answers while the server's call
waits, and shows the latest sample as it comes.

`typescript/src/page.ts`:

```ts
// StationService's TypeScript client, in a page: the operator answers promptOperator in a dialog,
// and the page shows the status and the latest telemetry. The server's port is the page's `?port=`.

import { FailureError, ProtocolCode } from '@francisdesjardins/bead/client';
import { createWebSocketClient } from '@francisdesjardins/bead/websocket-client';
import { StationClient } from '../gen/station/v1/station_bead.ts';

const log = (line: string): void => {
  const item = document.createElement('li');

  item.textContent = line;
  document.querySelector('#log')?.append(item);
};

const port = Number(new URLSearchParams(location.search).get('port') ?? '8080');
const client = createWebSocketClient();
const station = new StationClient(client, { windows: { watchTelemetry: 1 } });

// * the operator answers while the server's call waits for it
station.on('promptOperator', async (request, response) => {
  const acknowledged = window.confirm(request.payload.question);

  log(`promptOperator: "${request.payload.question}" answered ${acknowledged}`);
  await response({ acknowledged, note: 'from the page' });
});

// ! the page's own origin must be in the server's Origins, or the upgrade is refused 403
// ! `protocols: []`: without it, Chromium offers the subprotocol "undefined", which the C# server
// does not answer, and the upgrade fails
await client.connect({ host: '127.0.0.1', port, protocols: [] });

const status = await station.getStationStatus({ stationId: 'ST-001' })();

log(`getStationStatus: online=${status.online} operatorAnswer="${status.operatorAnswer}"`);

try {
  await station.getStationStatus({ stationId: 'station one' })();
} catch (error) {
  if (error instanceof FailureError && error.code === ProtocolCode.PAYLOAD_INVALID) {
    log(`getStationStatus "station one": PAYLOAD_INVALID`);
  } else {
    throw error;
  }
}

const latest = document.querySelector('#latest');
const done = Promise.withResolvers<void>();

await using registration = await station.notifications.watchTelemetry(
  { stationId: 'ST-001', samples: 20 },
  async (sample) => {
    if (latest !== null) {
      latest.textContent = `#${sample.sequence}: ${sample.temperatureCelsius.toFixed(1)} °C`;
    }

    // a frame's paint before the next sample: the window holds it until this settles
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });

    if (sample.sequence === 20) {
      done.resolve();
    }
  }
)();

await done.promise;
log(`watchTelemetry: last ${latest?.textContent ?? ''}`);
document.body.dataset.done = 'true';
```

`typescript/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Station</title>
  </head>
  <body>
    <p id="latest">no telemetry yet</p>
    <ul id="log"></ul>
    <script type="module" src="dist/page.js"></script>
  </body>
</html>
```

Two things a page needs that Node does not:

- **Its origin listed.** The server's `Origins` names `http://localhost:5173`, so the page is
  served from exactly that origin: the same page from `http://127.0.0.1:5173` is refused 403
  `origin-refused`, which the server's `Refusal` event reports, while the page's `WebSocket` reads
  nothing past its close, 1006.
- **`protocols: []` on `connect`.** Without it, Chromium (seen on 156) offers a WebSocket
  subprotocol named `undefined`, which the C# server does not choose, and the handshake fails:
  "Sent non-empty 'Sec-WebSocket-Protocol' header but no response was received". A client in Node
  needs nothing.

Build it and serve the `typescript/` folder from `http://localhost:5173` with any static server
that serves `index.html` and `dist/page.js`, then open `http://localhost:5173/?port=8080`:

```sh
npm run build:page
```

The dialog asks "Read ST-001's status?"; once it is accepted the page lists:

```text
promptOperator: "Read ST-001's status?" answered true
getStationStatus: online=true operatorAnswer="acknowledged: from the page"
getStationStatus "station one": PAYLOAD_INVALID
watchTelemetry: last #20: 22.0 °C
```

A page on the public network that reaches a server on the loopback or a private address needs its
user's permission first (Local Network Access); see [the support matrix](../support.md).

## 7. Read the metrics

The server counts what it answers and the commands it makes. Once the Node client and the page
have run, `GET /metrics` on its metrics port, the second of its first line's two, answers
`text/plain; version=0.0.4; charset=utf-8`, among its lines (the notifications sent vary by run, as
the samples received do):

```text
bead_client_call_handled_total{service="1",procedure="promptOperator",type="command",outcome="result"} 2
bead_notifications_sent_total{service="1",procedure="watchTelemetry",outcome="sent"} 26
bead_server_call_handled_total{service="1",procedure="getStationStatus",type="request",outcome="result"} 2
bead_server_call_handled_total{service="1",procedure="getStationStatus",type="request",outcome="failure",code="PAYLOAD_INVALID"} 2
bead_server_call_handled_total{service="1",procedure="getStationStatus",type="request",outcome="failure",code="application"} 1
```

The server's own commands count as `bead_client_*`: a role, not a side. A sample replaced while it
waited is never sent, and is not counted sent.

## Where to go next

- [Real-time recipes](cookbook-realtime.md): a `JWT` and admission hooks, a connection's life and
  its reconnection, Prometheus in .NET, and Chrome's DevTools on a page's client.
- [How Bead fits together](architecture-overview.md): from the `.proto` to what runs, and Bead
  beside gRPC-Web, Connect and SignalR.
- **Breaking changes in CI**: `./beadc.sh breaking --against-ref <ref>` compares the contract
  with the one at a git ref ([Breaking](../../builder/README.md#breaking)).
- **The same procedures over HTTP and JSON**: `gateway: {}` on an output, and `openapi.out` for
  the OpenAPI document ([HTTP and the OpenAPI document](../../builder/README.md#http-and-the-openapi-document)).
- [`examples/hello`](../../examples/hello): the same three kinds of call, served in TypeScript, C#
  and Rust, and [what a project outside the repository writes](../../examples/hello/README.md#what-a-project-outside-this-repository-writes-instead).
