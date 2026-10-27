using System.Net;
using System.Net.Sockets;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// A relay on the loopback between one participant's adapter and its broker, which a case's
/// <c>lose</c> cuts: each network connection through it piped both ways, and, cut, each reset at
/// both its ends, so that the adapter sees its link lost and the broker a link that ended without a
/// DISCONNECT, its will published. It keeps listening, so that a participant that links anew links
/// through it again. The TypeScript side's <c>link-relay</c> cuts alike.
/// </summary>
internal sealed class LinkRelay : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly (string Host, int Port) _broker;
    private readonly List<(Socket Near, Socket Far)> _pairs = [];
    private readonly CancellationTokenSource _closing = new();
    private Task? _accepting;

    private LinkRelay(Uri broker)
    {
        _broker = (broker.Host.Trim('[', ']'), broker.Port);
    }

    /// <summary>Where an adapter links through it: <c>mqtt://127.0.0.1:…</c>.</summary>
    public Uri Uri { get; private set; } = new("mqtt://127.0.0.1");

    /// <summary>A relay to the broker at <paramref name="broker"/>, listening.</summary>
    public static LinkRelay To(Uri broker)
    {
        var relay = new LinkRelay(broker);

        relay._listener.Start();
        relay.Uri = new Uri($"mqtt://127.0.0.1:{((IPEndPoint)relay._listener.LocalEndpoint).Port}");
        relay._accepting = relay.Accepting();

        return relay;
    }

    /// <summary>Resets each network connection through it, at both its ends; it keeps listening.</summary>
    public void Cut()
    {
        List<(Socket Near, Socket Far)> pairs;

        lock (_pairs)
        {
            pairs = [.. _pairs];
            _pairs.Clear();
        }

        foreach (var (near, far) in pairs)
        {
            Reset(near);
            Reset(far);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _closing.CancelAsync();
        _listener.Stop();
        Cut();

        if (_accepting is not null)
        {
            try
            {
                await _accepting;
            }
            catch (Exception reason) when (reason is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                // its listener stopped
            }
        }

        _closing.Dispose();
    }

    // a socket ended at once, as a network that drops a link does
    private static void Reset(Socket socket)
    {
        try
        {
            socket.LingerState = new LingerOption(true, 0);
            socket.Close();
        }
        catch (Exception reason) when (reason is SocketException or ObjectDisposedException)
        {
            // closed already
        }
    }

    // what comes on one socket, written to the other, until either ends; then both end
    private static async Task Pipe((Socket From, Socket To) pipe)
    {
        var buffer = new byte[65_536];

        try
        {
            while (true)
            {
                var read = await pipe.From.ReceiveAsync(buffer, SocketFlags.None);

                if (read == 0)
                {
                    pipe.To.Shutdown(SocketShutdown.Send);

                    return;
                }

                await pipe.To.SendAsync(buffer.AsMemory(0, read), SocketFlags.None);
            }
        }
        catch (Exception reason) when (reason is SocketException or ObjectDisposedException)
        {
            Reset(pipe.From);
            Reset(pipe.To);
        }
    }

    private async Task Accepting()
    {
        while (!_closing.IsCancellationRequested)
        {
            var near = await _listener.AcceptSocketAsync(_closing.Token);
            var far = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };

            try
            {
                await far.ConnectAsync(_broker.Host, _broker.Port, _closing.Token);
            }
            catch (SocketException)
            {
                Reset(near);
                far.Dispose();

                continue;
            }

            near.NoDelay = true;

            lock (_pairs)
            {
                _pairs.Add((near, far));
            }

            _ = Pipe((near, far));
            _ = Pipe((far, near));
        }
    }
}
