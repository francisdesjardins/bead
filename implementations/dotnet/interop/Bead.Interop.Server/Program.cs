using System.Globalization;
using System.Text.Json.Nodes;
using Bead;
using Bead.Interop;
using Bead.Transcoding.Http;
using Bead.Transcoding.Tests;
using Bead.Transcoding.V1;
using Bead.Transport.Amqp;
using Bead.Transport.Http;
using Bead.Transport.Mqtt;
using Bead.Transport.WebSockets;

// The C# server of Bead's interop service, on 127.0.0.1, over WebSocket and over HTTP, each a server
// of its own, over MQTT 5 where `BEAD_MQTT_URL` names a broker and over AMQP 1.0 where
// `BEAD_AMQP_URL` names a RabbitMQ, its participant on each `cs-server`, serving `interop-cs` alone
// and `interop-both` in a group with the TypeScript side's; each given the service's credentials on
// the system's clock, which is theirs: its first line on the standard output says their ports and
// those names, as {"port":n,"httpPort":m,"gatewayPort":g,"mqtt":[…],"amqp":[…]};
// it serves until its standard input closes. A port given as its one argument is the WebSocket
// server's; none, any free one. The HTTP server takes any free one. Each names the origins
// `BEAD_INTEROP_ORIGINS` lists, separated by spaces, none when it is not set: a page of another
// origin calls them so. The TypeScript side's interop server does the same. The gateway serves the
// Transcoding fixture and its document.

var port = args.Length > 0 ? int.Parse(args[0], CultureInfo.InvariantCulture) : 0;
var origins = (Environment.GetEnvironmentVariable("BEAD_INTEROP_ORIGINS") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
var credentials = InteropCredentials.Of(TimeProvider.System);

await using var server = new WebSocketServer<string>(new WebSocketServerOptions
{
    Server = new ServerOptions { Credentials = credentials },
    Transport = new WebSocketTransportServerOptions { Origins = origins },
});
await using var httpServer = new HttpServer<string>(new HttpServerOptions
{
    Server = new ServerOptions { Credentials = credentials },
    Transport = new HttpTransportServerOptions { Origins = origins },
});

void Report(Exception reason, string? connectionHandle)
{
    Console.Error.WriteLine($"{connectionHandle ?? "no connection"}: {reason.Message}");
}

server.Router.Error += Report;
httpServer.Router.Error += Report;
InteropHandlers.Offer(server);
InteropHandlers.Offer(httpServer);

// * over MQTT 5, a participant of its own: its name alone, and the one both sides serve in a group
string[] brokerNames = ["interop-cs", "interop-both"];
var mqttUrl = Environment.GetEnvironmentVariable("BEAD_MQTT_URL");
await using var participant = mqttUrl is { Length: > 0 }
    ? new BrokerParticipant(new MqttBrokerAdapter(new MqttBrokerAdapterOptions
    {
        Id = "cs-server",
        Password = Environment.GetEnvironmentVariable("BEAD_MQTT_PASSWORD"),
        Uri = new Uri(mqttUrl),
    }))
    : null;

// * over AMQP 1.0, a participant of its own alike, on its own broker
var amqpUrl = Environment.GetEnvironmentVariable("BEAD_AMQP_URL");
await using var amqpParticipant = amqpUrl is { Length: > 0 }
    ? new BrokerParticipant(new AmqpBrokerAdapter(new AmqpBrokerAdapterOptions
    {
        Id = "cs-server",
        Password = Environment.GetEnvironmentVariable("BEAD_AMQP_PASSWORD"),
        Uri = new Uri(amqpUrl),
    }))
    : null;
List<BrokerTransportServer> brokerTransports = [.. new[] { participant, amqpParticipant }.OfType<BrokerParticipant>().SelectMany((each) =>
{
    return new[]
    {
        each.Server(new BrokerTransportServerOptions { Names = [brokerNames[0]] }),
        each.Server(new BrokerTransportServerOptions { Names = [brokerNames[1]], IsInGroup = true }),
    };
})];
var brokerServers = brokerTransports.Select((transport) =>
{
    return new Server<string>(transport, new ServerOptions { Credentials = credentials });
}).ToList();

foreach (var each in brokerServers)
{
    each.Router.Error += Report;
    InteropHandlers.Offer(each);
}

foreach (var transport in brokerTransports)
{
    await transport.Start();
}

var address = await server.Transport.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", Port = port, FindOpenPort = port == 0 });
var httpAddress = await httpServer.Transport.Start(new HttpTransportStartOptions { Address = "127.0.0.1", FindOpenPort = true });
await using var transcoding = await TranscodingService.Start();
await using var gateway = new HttpGateway(new HttpGatewayOptions
{
    Transport = transcoding.Memory,
    Routes = HttpRoutes.All,
    Document = HttpRoutes.OpenApiDocument.ToArray(),
    ProblemTypes = HttpRoutes.ProblemTypes,
    Origins = origins,
    MaximumBodyBytes = 1024,
    MaximumConnectionsPerAddress = 1,
});
var gatewayAddress = await gateway.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true });

var said = new JsonObject { ["port"] = address.Port, ["httpPort"] = httpAddress.Port, ["gatewayPort"] = gatewayAddress.Port };

if (participant is not null)
{
    said["mqtt"] = new JsonArray([.. brokerNames.Select((name) =>
    {
        return (JsonNode)JsonValue.Create(name);
    })]);
}

if (amqpParticipant is not null)
{
    said["amqp"] = new JsonArray([.. brokerNames.Select((name) =>
    {
        return (JsonNode)JsonValue.Create(name);
    })]);
}

Console.WriteLine(said.ToJsonString());
await Console.Out.FlushAsync();

// served until whoever started it lets go of its input
await Console.In.ReadToEndAsync();

foreach (var each in brokerServers)
{
    await each.DisposeAsync();
}
