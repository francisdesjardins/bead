using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>A frame a client sent: whether it ends its message, its opcode, and its payload's length.</summary>
internal sealed record RecordedFrame(bool Fin, int Opcode, long Length);

/// <summary>
/// A relay on the loopback in front of a broker's WebSocket, which passes every byte through as it
/// comes and records the frame of each message a client sends after its upgrade (RFC 6455 §5.2), so
/// that a test reads how a participant frames what it sends, whatever its broker does with it. The
/// TypeScript side's <c>frame-relay</c> records alike.
/// </summary>
internal sealed class FrameRelay : IAsyncDisposable
{
    // where a client's upgrade request ends (RFC 9112 §2.1)
    private static readonly byte[] HeadEnd = "\r\n\r\n"u8.ToArray();

    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly Uri _target;
    private readonly List<RecordedFrame> _frames = [];
    private readonly List<Socket> _sockets = [];
    private readonly CancellationTokenSource _closing = new();
    private Task? _accepting;

    private FrameRelay(Uri target)
    {
        _target = target;
    }

    /// <summary>Where a client links through it, its path the target's.</summary>
    public Uri Uri { get; private set; } = new("ws://127.0.0.1");

    /// <summary>Every frame of every client, in their order.</summary>
    public IReadOnlyList<RecordedFrame> Frames
    {
        get
        {
            lock (_frames)
            {
                return [.. _frames];
            }
        }
    }

    /// <summary>A relay to the broker's WebSocket at <paramref name="target"/>, on a port of its own.</summary>
    public static FrameRelay Start(Uri target)
    {
        var relay = new FrameRelay(target);

        relay._listener.Start();
        relay.Uri = new Uri($"ws://127.0.0.1:{((IPEndPoint)relay._listener.LocalEndpoint).Port}{target.AbsolutePath}");
        relay._accepting = relay.Accepting();

        return relay;
    }

    /// <summary>The frames of <paramref name="frames"/> that are no whole binary message: one that ends no message, a continuation, or text (RFC 6455 §5.2, §5.4).</summary>
    public static RecordedFrame[] UnwholeOf(IEnumerable<RecordedFrame> frames)
    {
        return [.. frames.Where((frame) =>
        {
            return !frame.Fin || frame.Opcode is 0x0 or 0x1;
        })];
    }

    public async ValueTask DisposeAsync()
    {
        await _closing.CancelAsync();
        _listener.Stop();

        lock (_sockets)
        {
            foreach (var socket in _sockets)
            {
                socket.Dispose();
            }
        }

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

    private async Task Accepting()
    {
        while (!_closing.IsCancellationRequested)
        {
            var client = await _listener.AcceptSocketAsync(_closing.Token);
            var broker = new Socket(SocketType.Stream, ProtocolType.Tcp);

            lock (_sockets)
            {
                _sockets.Add(client);
                _sockets.Add(broker);
            }

            await broker.ConnectAsync(_target.Host, _target.Port, _closing.Token);

            var record = Reader();

            _ = Pump((client, broker), record);
            _ = Pump((broker, client), null);
        }
    }

    // one way of a link, each chunk read on to the other end, the link cut both ways at its end
    private async Task Pump((Socket From, Socket To) leg, Action<byte[]>? read)
    {
        var buffer = new byte[65_536];

        try
        {
            while (true)
            {
                var count = await leg.From.ReceiveAsync(buffer, SocketFlags.None, _closing.Token);

                if (count == 0)
                {
                    break;
                }

                read?.Invoke(buffer[..count]);
                await leg.To.SendAsync(buffer.AsMemory(0, count), SocketFlags.None, _closing.Token);
            }
        }
        catch (Exception reason) when (reason is OperationCanceledException or SocketException or ObjectDisposedException)
        {
            // a leg cut, or the relay closed
        }

        leg.From.Dispose();
        leg.To.Dispose();
    }

    // what reads a client's bytes, its request first and its frames after, into the relay's frames
    private Action<byte[]> Reader()
    {
        var pending = new List<byte>();
        var isUpgraded = false;

        return (chunk) =>
        {
            pending.AddRange(chunk);

            if (!isUpgraded)
            {
                var end = pending.ToArray().AsSpan().IndexOf(HeadEnd);

                if (end < 0)
                {
                    return;
                }

                pending.RemoveRange(0, end + HeadEnd.Length);
                isUpgraded = true;
            }

            while (FrameOf(pending.ToArray()) is { } read)
            {
                lock (_frames)
                {
                    _frames.Add(read.Frame);
                }

                pending.RemoveRange(0, (int)read.Size);
            }
        };
    }

    // the first frame of bytes and the bytes it takes, or none until all of it came
    private static (RecordedFrame Frame, long Size)? FrameOf(byte[] bytes)
    {
        if (bytes.Length < 2)
        {
            return null;
        }

        long length = bytes[1] & 0x7F;
        var offset = 2;

        if (length == 126)
        {
            if (bytes.Length < 4)
            {
                return null;
            }

            length = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(2));
            offset = 4;
        }
        else if (length == 127)
        {
            if (bytes.Length < 10)
            {
                return null;
            }

            length = (long)BinaryPrimitives.ReadUInt64BigEndian(bytes.AsSpan(2));
            offset = 10;
        }

        // * a client masks every frame it sends (RFC 6455 §5.3)
        offset += (bytes[1] & 0x80) == 0 ? 0 : 4;

        if (bytes.Length < offset + length)
        {
            return null;
        }

        return (new RecordedFrame((bytes[0] & 0x80) != 0, bytes[0] & 0x0F, length), offset + length);
    }
}
