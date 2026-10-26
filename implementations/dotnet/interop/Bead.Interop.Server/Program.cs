using System.Globalization;
using System.Text.Json;
using Bead;
using Bead.Interop;
using Bead.Transcoding.Http;
using Bead.Transcoding.Tests;
using Bead.Transcoding.V1;
using Bead.Transport.Http;
using Bead.Transport.WebSockets;

// The C# server of Bead's interop service, on 127.0.0.1, over WebSocket and over HTTP, each a server
// of its own, given the service's credentials on the system's clock, which is theirs: its first
// line on the standard output says their ports, as {"port":n,"httpPort":m,"gatewayPort":g}; it serves until its
// standard input closes. A port given as its one argument is the WebSocket server's; none, any free
// one. The HTTP server takes any free one. Each names the origins `BEAD_INTEROP_ORIGINS` lists,
// separated by spaces, none when it is not set: a page of another origin calls them so. The
// TypeScript side's interop server does the same. The gateway serves the Transcoding fixture and its document.

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

Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, int> { ["port"] = address.Port, ["httpPort"] = httpAddress.Port, ["gatewayPort"] = gatewayAddress.Port }));
await Console.Out.FlushAsync();

// served until whoever started it lets go of its input
await Console.In.ReadToEndAsync();
