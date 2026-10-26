using System.Text.Json;
using Bead;
using Bead.Transcoding.Http;
using Bead.Transport.WebSockets;
using Hello.V1;

namespace Hello;

/// <summary>
/// HelloService's C# server, over WebSocket on 127.0.0.1, and its gateway beside it: one server,
/// HelloService offered on it once, which takes its connections from its WebSocket transport and
/// from an in-memory one, joined, the gateway's calls crossing the second (decision 0037).
/// </summary>
public static class Serving
{
    /// <summary>
    /// Serves HelloService on <paramref name="port"/>, any free one when 0, and its gateway on any
    /// free port: its first line on the standard output says both, as <c>{"port":n,"gateway":m}</c>;
    /// it serves until its standard input closes.
    /// </summary>
    public static async Task<int> Serve(int port)
    {
        // its bounds by default, a WebSocket server's under the router's default limits
        await using var webSocket = new WebSocketTransportServer();
        await using var memory = new MemoryTransportServer();
        await using var server = new Server<string>(new JoinedServerTransport([webSocket, memory]));

        server.Router.Error += (reason, connectionHandle) =>
        {
            Console.Error.Write($"{connectionHandle ?? "no connection"}: {reason.Message}\n");
        };

        // what a socket or a listener of the transport's events threw, and each request it refused
        // of its own, which no router forwards
        server.Transport.Error += (reason, connectionHandle) =>
        {
            Console.Error.Write($"{(connectionHandle.Length == 0 ? "no connection" : connectionHandle)}: {reason.Message}\n");
        };
        server.Transport.Refusal += (refusal) =>
        {
            Console.Error.Write($"refused {refusal.Status} {refusal.Reason}\n");
        };
        Resolvers.OfferHello(server);

        // * the gateway answers each procedure's routes as one more client of this server, one
        // connection an exchange, over the in-memory transport the server takes beside WebSocket
        await using var gateway = new HttpGateway(new HttpGatewayOptions
        {
            Transport = memory,
            Routes = HttpRoutes.All,
            Document = HttpRoutes.OpenApiDocument.ToArray(),
            ProblemTypes = HttpRoutes.ProblemTypes,
        });

        gateway.Error += (reason) =>
        {
            Console.Error.Write($"gateway: {reason.Message}\n");
        };

        await memory.Start();

        var address = await webSocket.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", Port = port, FindOpenPort = port == 0 });
        var gatewayAddress = await gateway.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true });

        // LF, as the TypeScript server writes it, on every platform
        await Console.Out.WriteAsync($"{JsonSerializer.Serialize(new Dictionary<string, int> { ["port"] = address.Port, ["gateway"] = gatewayAddress.Port })}\n");
        await Console.Out.FlushAsync();

        // served until whoever started it lets go of its input
        await Console.In.ReadToEndAsync();

        return 0;
    }
}
