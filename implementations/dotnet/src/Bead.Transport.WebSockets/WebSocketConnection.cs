using System.Buffers;
using System.Globalization;
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
    private readonly Pacing? _pace;
    private readonly SendPace? _sendPace;
    private readonly Channel<(ReadOnlyMemory<byte> Bytes, WebSocketCloseStatus? Close, TaskCompletionSource Done)> _outgoing =
        Channel.CreateUnbounded<(ReadOnlyMemory<byte>, WebSocketCloseStatus?, TaskCompletionSource)>(new UnboundedChannelOptions { SingleReader = true });
    private readonly TaskCompletionSource _ended = new(TaskCreationOptions.RunContinuationsAsynchronously);

    // what waits for the socket — handed it, in the channel or under SendAsync — and how this side
    // ended the connection of its own, when it did: dropped behind a bound, and why; failed with
    // 1009; aborted past its close timeout; and whether it ended, past which nothing drops it; under
    // the lock
    private readonly Lock _gate = new();
    private long _unsent;
    private string? _dropped;
    private bool _isTooBig;
    private bool _isAbandoned;
    private bool _isEnded;

    public WebSocketConnection(WebSocket socket, (int MaximumMessageBytes, TimeSpan CloseTimeout) bounds)
        : this(socket, new Bounds { MaximumMessageBytes = bounds.MaximumMessageBytes, CloseTimeout = bounds.CloseTimeout })
    {
    }

    // a connection whose bounds may hold what waits for its socket to a pace, a server's
    public WebSocketConnection(WebSocket socket, Bounds bounds)
    {
        Socket = socket;
        _bounds = (bounds.MaximumMessageBytes, bounds.CloseTimeout);
        _pace = bounds.Pace;
        _sendPace = bounds.Pace is { } pace
            ? new SendPace((Late, Unsent), new SendPaceOptions { MinimumSendBytesPerSecond = pace.MinimumSendBytesPerSecond, SendGracePeriod = pace.SendGracePeriod })
            : null;
        _ = Write();
    }

    public WebSocket Socket { get; }

    /// <summary>
    /// Why it was dropped behind a bound of its pace, naming the bound in the spec's spelling and its
    /// value, which its server reports; none while it was not.
    /// </summary>
    public string? Dropped
    {
        get
        {
            lock (_gate)
            {
                return _dropped;
            }
        }
    }

    /// <summary>Whether it was failed with 1009, a message past its bound, which its server reports.</summary>
    public bool IsTooBig
    {
        get
        {
            lock (_gate)
            {
                return _isTooBig;
            }
        }
    }

    /// <summary>
    /// Whether this side ended it of its own: dropped behind a bound, failed with 1009, or aborted
    /// past its close timeout. What its socket meets after says nothing more, and its close is
    /// unclean, whatever the peer answers.
    /// </summary>
    public bool IsEndedHere
    {
        get
        {
            lock (_gate)
            {
                return _dropped is not null || _isTooBig || _isAbandoned;
            }
        }
    }

    /// <summary>What waits for its socket right now, in bytes: what it was handed and the socket has not yet taken.</summary>
    public long UnsentBytes
    {
        get
        {
            lock (_gate)
            {
                return _unsent;
            }
        }
    }

    /// <summary>
    /// <paramref name="heartbeat"/> held: from 1 to <see cref="Clocks.LongestTimer"/> milliseconds,
    /// rounded to the nearest whole one, or <see cref="Timeout.InfiniteTimeSpan"/> for none; any
    /// other, zero among them, is an <see cref="ArgumentOutOfRangeException"/> naming the option
    /// <paramref name="option"/>.
    /// </summary>
    public static TimeSpan AssertHeartbeat(TimeSpan heartbeat, string option)
    {
        return Clocks.AssertHeld(("a heartbeat", option), heartbeat);
    }

    /// <summary>
    /// <paramref name="closeTimeout"/> held: from 1 to <see cref="Clocks.LongestTimer"/>
    /// milliseconds, rounded to the nearest whole one, or <see cref="Timeout.InfiniteTimeSpan"/> to
    /// wait on the peer without end; any other, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/> naming the option <paramref name="option"/>.
    /// </summary>
    public static TimeSpan AssertCloseTimeout(TimeSpan closeTimeout, string option)
    {
        return Clocks.AssertHeld(("a close timeout", option), closeTimeout);
    }

    // what goes out once the socket is not open goes nowhere, as a send to a socket closing does;
    // held to its pace and its bound, when the connection has one: one that would take what waits
    // past its bound drops the connection, and goes nowhere
    public Task Send(ReadOnlyMemory<byte> bytes)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        if (_pace is { } pace && !Hold((bytes.Length, pace)))
        {
            done.TrySetResult();

            return done.Task;
        }

        if (!_outgoing.Writer.TryWrite((bytes, null, done)))
        {
            Taken(bytes.Length);
            done.TrySetResult();
        }

        return done.Task;
    }

    // * what waits for the socket, held (spec 15.12): an envelope that would take it past its bound
    // drops the connection; any other is handed to its pace. False once dropped, or ended
    private bool Hold((int Bytes, Pacing Pace) handed)
    {
        var (bytes, pace) = handed;
        bool isPast;

        lock (_gate)
        {
            if (_dropped is not null || _isEnded)
            {
                return false;
            }

            isPast = _unsent + bytes > pace.MaximumUnsentBytes;

            if (isPast)
            {
                _dropped = string.Create(CultureInfo.InvariantCulture, $"what waits for its socket would pass maximumUnsentBytes, {pace.MaximumUnsentBytes} bytes");
            }
            else
            {
                _unsent += bytes;
            }
        }

        if (isPast)
        {
            Drop();

            return false;
        }

        _sendPace!.Hand(bytes);

        return true;
    }

    // what waits for its socket, as its pace reads it
    private long Unsent()
    {
        return UnsentBytes;
    }

    // what the socket took: what waits is less, and nothing waiting, its pace judges nothing
    private void Taken(int bytes)
    {
        if (_pace is null)
        {
            return;
        }

        lock (_gate)
        {
            _unsent -= bytes;
        }
    }

    // what waits past its deadline drops the connection, but one dropped, ended or gone already
    private void Late()
    {
        lock (_gate)
        {
            if (_dropped is not null || _isEnded || _unsent == 0)
            {
                return;
            }

            var pace = _pace!;

            _dropped = string.Create(
                CultureInfo.InvariantCulture,
                $"what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond {pace.MinimumSendBytesPerSecond} past sendGracePeriod {(long)pace.SendGracePeriod.TotalMilliseconds} ms");
        }

        Drop();
    }

    // ! dropped with no closing handshake, its close unclean: a peer that does not read would read
    // no close frame waiting behind what it does not read (RFC 6455 §7.1.7); its server reports it
    // once its read ends, before its close, so nothing a listener throws keeps it open
    private void Drop()
    {
        _sendPace?.Stop();
        Socket.Abort();
    }

    // sends a close behind what was sent before it, and drops the socket should the peer not
    // answer it within its timeout: on the real clock, since it bounds the platform's own close
    // against a peer that does not answer, never what Bead times
    public async Task Close(WebSocketCloseStatus status)
    {
        await Answer(status);

        // the wait is cancelled once the connection's end wins it: nothing lingers until the
        // timeout fires, and an endless timeout lingers nowhere
        using var elapsed = new CancellationTokenSource();
        var waiting = Task.Delay(_bounds.CloseTimeout, TimeProvider.System, elapsed.Token);

        if (await Task.WhenAny(_ended.Task, waiting) == waiting)
        {
            // marked before the abort the pending read meets: this side's own, no error
            lock (_gate)
            {
                _isAbandoned = true;
            }

            Socket.Abort();
        }
        else
        {
            await elapsed.CancelAsync();
        }
    }

    // a close sent on its own, nothing waiting on it: what its socket meets going says nothing
    public async Task CloseQuietly(WebSocketCloseStatus status)
    {
        try
        {
            await Close(status);
        }
        catch (Exception reason) when (reason is WebSocketException or ObjectDisposedException or InvalidOperationException or IOException)
        {
            // a socket already gone takes no close
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
    /// is read to its close and dropped. A message past the bound fails the connection with 1009
    /// (RFC 6455 §7.1.7): what comes after is read to the peer's close, or to the close timeout, and
    /// dropped. What breaks the socket throws; either way, the connection ends.
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

                    lock (_gate)
                    {
                        _isTooBig = true;
                    }

                    _ = CloseQuietly(WebSocketCloseStatus.MessageTooBig);

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
            End();
        }
    }

    // its end, told once, however it went: what still waits on the connection settles — the write
    // pump ends, and a close waiting on the peer's answer waits no timeout
    public void End()
    {
        lock (_gate)
        {
            _isEnded = true;
        }

        _outgoing.Writer.TryComplete();
        _ended.TrySetResult();
        _sendPace?.Stop();
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
                if (close is null)
                {
                    Taken(bytes.Length);
                }

                done.TrySetResult();
            }
        }
    }

    /// <summary>What a connection reads and closes within, and what holds what waits for its socket, a server's.</summary>
    internal sealed record Bounds
    {
        public required int MaximumMessageBytes { get; init; }

        public required TimeSpan CloseTimeout { get; init; }

        public Pacing? Pace { get; init; }
    }

    /// <summary>
    /// What holds what waits for a server's socket (spec 15.12): its pace past its grace, 0 holding
    /// none, and its bound.
    /// </summary>
    internal sealed record Pacing
    {
        public required int MinimumSendBytesPerSecond { get; init; }

        public required TimeSpan SendGracePeriod { get; init; }

        public required long MaximumUnsentBytes { get; init; }
    }
}
