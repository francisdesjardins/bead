using System.Text.Json;
using Bead.Transport.WebSockets;

namespace Hello;

/// <summary>HelloService's C# server, over WebSocket on 127.0.0.1.</summary>
public static class Serving
{
    /// <summary>
    /// Serves HelloService on <paramref name="port"/>, any free one when 0: its first line on the
    /// standard output says its port, as <c>{"port":n}</c>; it serves until its standard input
    /// closes.
    /// </summary>
    public static async Task<int> Serve(int port)
    {
        await using var server = new WebSocketServer<string>();

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

        var address = await server.Transport.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", Port = port, FindOpenPort = port == 0 });

        // LF, as the TypeScript server writes it, on every platform
        Console.Out.Write($"{JsonSerializer.Serialize(new Dictionary<string, int> { ["port"] = address.Port })}\n");
        await Console.Out.FlushAsync();

        // served until whoever started it lets go of its input
        await Console.In.ReadToEndAsync();

        return 0;
    }
}
