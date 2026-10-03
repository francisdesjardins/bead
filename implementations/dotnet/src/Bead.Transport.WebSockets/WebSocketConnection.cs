using System.Buffers;
using System.Net.WebSockets;
using System.Threading.Channels;

namespace Bead.Transport.WebSockets;

/// <summary>
/// One WebSocket connection, either end's: what goes out on it, in order, one message at a time;
/// what comes in, each message whole and bounded; and its close — the peer's answered at once,
/// this side's waited for within its timeout, then dropped.
/// </summary>
internal sealed class WebSocketConnection
{
    private readonly (int MaximumMessageBytes, TimeSpan CloseTimeout) _bounds;
    private readonly Channel<(ReadOnlyMemory<byte> Bytes, WebSocketCloseStatus? Close, TaskCompletionSource Done)> _outgoing =
        Channel.CreateUnbounded<(ReadOnlyMemory<byte>, WebSocketCloseStatus?, TaskCompletionSource)>(new UnboundedChannelOptions { SingleReader = true });
    private readonly TaskCompletionSource _ended = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public WebSocketConnection(WebSocket socket, (int MaximumMessageBytes, TimeSpan CloseTimeout) bounds)
    {
        Socket = socket;
        _bounds = bounds;
        _ = Write();
    }

    public WebSocket Socket { get; }

    /// <summary>
    /// Throws an <see cref="ArgumentOutOfRangeException"/>, naming the option
    /// <paramref name="option"/>, unless <paramref name="heartbeat"/> is a whole number of
    /// milliseconds from 1 to <see cref="Clocks.LongestTimer"/>, or
    /// <see cref="Timeout.InfiniteTimeSpan"/> for none.
    /// </summary>
    public static void AssertHeartbeat(TimeSpan heartbeat, string option)
    {
        Clocks.AssertHeld(("a heartbeat", option), heartbeat);
    }

    /// <summary>
    /// Throws an <see cref="ArgumentOutOfRangeException"/>, naming the option
    /// <paramref name="option"/>, unless <paramref name="closeTimeout"/> is zero, which drops the
    /// connection without waiting on its close, a whole number of milliseconds from 1 to
    /// <see cref="Clocks.LongestTimer"/>, or <see cref="Timeout.InfiniteTimeSpan"/> to wait on the
    /// peer without end.
    /// </summary>
    public static void AssertCloseTimeout(TimeSpan closeTimeout, string option)
    {
        if (closeTimeout != TimeSpan.Zero)
        {
            Clocks.AssertHeld(("a close timeout", option), closeTimeout);
        }
    }

    // what goes out once the socket is not open goes nowhere, as a send to a socket closing does
    public Task Send(ReadOnlyMemory<byte> bytes)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        if (!_outgoing.Writer.TryWrite((bytes, null, done)))
        {
            done.TrySetResult();
        }

        return done.Task;
    }

    // sends a close behind what was sent before it, and drops the socket should the peer not
    // answer it within its timeout: on the real clock, since it bounds the platform's own close
    // against a peer that does not answer, never what Bead times
    public async Task Close(WebSocketCloseStatus status)
    {
        await Answer(status);

        if (await Task.WhenAny(_ended.Task, Task.Delay(_bounds.CloseTimeout, TimeProvider.System)) != _ended.Task)
        {
            Socket.Abort();
        }
    }

    // sends a close behind what was sent before it: the peer's close answered, or this side's own
    public async Task Answer(WebSocketCloseStatus status)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        if (_outgoing.Writer.TryWrite((ReadOnlyMemory<byte>.Empty, status, done)))
        {
            await done.Task;
        }
    }

    /// <summary>
    /// Reads each message whole, bounded, and hands it to <paramref name="deliver"/>, until the
    /// socket closes: a close from the peer is answered, and once this side closes, what still comes
    /// is read to its close and dropped. A message past the bound closes with 1009. What breaks the
    /// socket throws; either way, the connection ends.
    /// </summary>
    public async Task Read(Action<TransportMessage> deliver)
    {
        try
        {
            var buffer = new byte[16 * 1024];
            var message = new ArrayBufferWriter<byte>();
            var isClosing = false;

            while (Socket.State is WebSocketState.Open or WebSocketState.CloseSent)
            {
                var received = await Socket.ReceiveAsync(buffer.AsMemory(), CancellationToken.None);

                if (received.MessageType == WebSocketMessageType.Close)
                {
                    if (Socket.State == WebSocketState.CloseReceived)
                    {
                        await Answer(Socket.CloseStatus ?? WebSocketCloseStatus.NormalClosure);
                    }

                    return;
                }

                if (isClosing || Socket.State == WebSocketState.CloseSent)
                {
                    continue;
                }

                if (message.WrittenCount + received.Count > _bounds.MaximumMessageBytes)
                {
                    isClosing = true;
                    message.ResetWrittenCount();
                    _ = Close(WebSocketCloseStatus.MessageTooBig);

                    continue;
                }

                message.Write(buffer.AsSpan(0, received.Count));

                if (!received.EndOfMessage)
                {
                    continue;
                }

                var bytes = message.WrittenSpan.ToArray();

                message.ResetWrittenCount();
                deliver(new TransportMessage(bytes, received.MessageType == WebSocketMessageType.Text));
            }
        }
        finally
        {
            _outgoing.Writer.TryComplete();
            _ended.TrySetResult();
        }
    }

    private async Task Write()
    {
        await foreach (var (bytes, close, done) in _outgoing.Reader.ReadAllAsync())
        {
            try
            {
                if (close is { } status)
                {
                    if (Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    {
                        await Socket.CloseOutputAsync(status, null, CancellationToken.None);
                    }

                    _outgoing.Writer.TryComplete();
                }
                else if (Socket.State == WebSocketState.Open)
                {
                    await Socket.SendAsync(bytes, WebSocketMessageType.Binary, true, CancellationToken.None);
                }
            }
            catch (Exception reason) when (reason is WebSocketException or ObjectDisposedException or OperationCanceledException or IOException)
            {
                // a socket that went as this went out takes nothing more: its close says the rest; one
                // whose close threw has no handshake to wait on, and is dropped at once, as the
                // TypeScript side drops it
                if (close is not null)
                {
                    Socket.Abort();
                }
            }
            finally
            {
                done.TrySetResult();
            }
        }
    }
}
