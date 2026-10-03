using System.Globalization;
using System.Text.Json;
using Bead.Interop;
using Bead.Transport.Http;
using Bead.Transport.WebSockets;

// The C# server of Bead's interop service, on 127.0.0.1, over WebSocket and over HTTP, each a server
// of its own: its first line on the standard output says their ports, as {"port":n,"httpPort":m};
// it serves until its standard input closes. A port given as its one argument is the WebSocket
// server's; none, any free one. The HTTP server takes any free one.

var port = args.Length > 0 ? int.Parse(args[0], CultureInfo.InvariantCulture) : 0;

await using var server = new WebSocketServer<string>();
await using var httpServer = new HttpServer<string>();

void Report(Exception reason, string connectionHandle)
{
    Console.Error.WriteLine($"{connectionHandle}: {reason.Message}");
}

server.Router.Error += Report;
httpServer.Router.Error += Report;
InteropService.Offer(server.Services, (server.Sessions, server.RequireSession, server.Router));
InteropService.Offer(httpServer.Services, (httpServer.Sessions, httpServer.RequireSession, httpServer.Router));

var address = await server.Transport.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", Port = port, FindOpenPort = port == 0 });
var httpAddress = await httpServer.Transport.Start(new HttpTransportStartOptions { Address = "127.0.0.1", FindOpenPort = true });

Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, int> { ["port"] = address.Port, ["httpPort"] = httpAddress.Port }));
await Console.Out.FlushAsync();

// served until whoever started it lets go of its input
await Console.In.ReadToEndAsync();
