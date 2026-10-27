using System.Net;
using System.Net.Sockets;

namespace Bead.Tests;

/// <summary>
/// A relay on the loopback between one participant's adapter and its broker, which a case's
/// <c>lose</c> cuts: each network connection through it piped both ways, and, cut, each reset at
/// both its ends, so that the adapter sees its link lost and the broker a link that ended without a
/// clean end, its will published where it left one. Silenced, each network connection through it
/// forwards nothing more either way and holds both its sockets open, reading what each end writes,
/// as a host whose process reads nothing does, while a connection that comes after it is piped as
/// before. It keeps listening, so that a participant that links anew links through it again. MQTT
/// 5's tests and AMQP 1.0's take it alike; the TypeScript side's <c>link-relay</c> cuts alike.
/// </summary>
internal sealed class LinkRelay : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly (string Host, int Port) _broker;
    private readonly List<Pair> _pairs = [];
    private readonly CancellationTokenSource _closing = new();
    private Task? _accepting;

    private LinkRelay(Uri broker)
    {
        _broker = (broker.Host.Trim('[', ']'), broker.Port);
    }

    /// <summary>Where an adapter links through it, of its broker's scheme: <c>mqtt://127.0.0.1:…</c>, <c>amqp://127.0.0.1:…</c>.</summary>
    public Uri Uri { get; private set; } = new("mqtt://127.0.0.1");

    /// <summary>A relay to the broker at <paramref name="broker"/>, listening.</summary>
    public static LinkRelay To(Uri broker)
    {
        ArgumentNullException.ThrowIfNull(broker);

        var relay = new LinkRelay(broker);

        relay._listener.Start();
        relay.Uri = new Uri($"{broker.Scheme}://127.0.0.1:{((IPEndPoint)relay._listener.LocalEndpoint).Port}");
        relay._accepting = relay.Accepting();

        return relay;
    }

    /// <summary>Resets each network connection through it, at both its ends, silenced ones among them; it keeps listening.</summary>
    public void Cut()
    {
        List<Pair> pairs;

        lock (_pairs)
        {
            pairs = [.. _pairs];
            _pairs.Clear();
        }

        foreach (var pair in pairs)
        {
            Reset(pair.Near);
            Reset(pair.Far);
        }
    }

    /// <summary>Silences each network connection through it as it stands: nothing more forwarded either way, each socket held open and read.</summary>
    public void Silence()
    {
        lock (_pairs)
        {
            foreach (var pair in _pairs)
            {
                pair.IsSilent = true;
            }
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

    // what comes on one socket, written to the other, until either ends; then both end, unless
    // its pair is silenced
    private static async Task Pipe((Pair Pair, Socket From, Socket To) pipe)
    {
        var buffer = new byte[65_536];

        try
        {
            while (true)
            {
                var read = await pipe.From.ReceiveAsync(buffer, SocketFlags.None);

                if (read == 0)
                {
                    // ! silenced, an end that closes is not told the other: its socket stays open
                    if (!pipe.Pair.IsSilent)
                    {
                        pipe.To.Shutdown(SocketShutdown.Send);
                    }

                    return;
                }

                // * silenced: what comes is read and dropped, so that its writer's socket stays open
                if (!pipe.Pair.IsSilent)
                {
                    await pipe.To.SendAsync(buffer.AsMemory(0, read), SocketFlags.None);
                }
            }
        }
        catch (Exception reason) when (reason is SocketException or ObjectDisposedException)
        {
            if (!pipe.Pair.IsSilent)
            {
                Reset(pipe.From);
                Reset(pipe.To);
            }
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

            var pair = new Pair(near, far);

            lock (_pairs)
            {
                _pairs.Add(pair);
            }

            _ = Pipe((pair, near, far));
            _ = Pipe((pair, far, near));
        }
    }

    // one network connection through it: its two sockets, and whether it is silenced
    private sealed class Pair(Socket near, Socket far)
    {
        public Socket Near { get; } = near;

        public Socket Far { get; } = far;

        public volatile bool IsSilent;
    }
}
