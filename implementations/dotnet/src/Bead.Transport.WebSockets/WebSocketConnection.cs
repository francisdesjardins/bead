using System.Buffers;
using System.Globalization;
using System.Net.WebSockets;
using System.Threading.Channels;

namespace Bead.Transport.WebSockets;

/// <summary>
/// One WebSocket connection, either end's: what goes out on it, in order, one message at a time;
/// what comes in, each message whole and bounded, no message read while its router paused it; and
/// its close — the peer's answered at once, this side's waited for within its timeout, then
/// dropped.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Design",
    "CA1001:Types that own disposable fields should be disposable",
    Justification = "its read's source holds no timer, no wait handle and no link: cancelled once at most, it needs no dispose")]
internal sealed class WebSocketConnection
{
    private readonly (int MaximumMessageBytes, TimeSpan CloseTimeout) _bounds;
    // * the platform's clock its stack holds, which its close timeout and its pace run on
    private readonly TimeProvider _platform;
    private readonly Pacing? _pace;
    private readonly SendPace? _sendPace;
    private readonly Channel<(ReadOnlyMemory<byte> Bytes, WebSocketCloseStatus? Close, TaskCompletionSource Done)> _outgoing =
        Channel.CreateUnbounded<(ReadOnlyMemory<byte>, WebSocketCloseStatus?, TaskCompletionSource)>(new UnboundedChannelOptions { SingleReader = true });
    private readonly TaskCompletionSource _ended = new(TaskCreationOptions.RunContinuationsAsynchronously);

    // cancelled once its socket's abort threw, since that socket may never end its read
    private readonly CancellationTokenSource _reading = new();

    // what waits for the socket — handed it, in the channel or under SendAsync — and how this side
    // ended the connection of its own, when it did: dropped behind a bound, and why; failed by a
    // verdict, its meter's or a message past its bound; aborted past its close timeout; what its
    // abort threw; and whether it ended, past which nothing drops it; under the lock
    private readonly Lock _gate = new();
    private long _unsent;
    private string? _dropped;
    private FrameVerdict? _verdict;
    private bool _isAbandoned;
    private Exception? _abortFailure;
    private bool _isEnded;

    // * its read's gate (spec 15.12, decision 0046): shut while its router paused it, what its read
    // awaits then, and each read of its socket's stream where its side gated it; opened for good
    // once the connection closes, which reads on to its peer's Close (RFC 6455 §7.1.1)
    private readonly ReadGate _read;

    // the message its read holds partway, its read's alone: a buffer rented from the shared pool once
    // a message takes more than one read, given back once the message is whole, and its bytes so far
    private byte[]? _message;
    private int _messageBytes;

    // a connection whose bounds may hold what waits for its socket to a pace, a server's
    public WebSocketConnection(WebSocket socket, Bounds bounds)
    {
        Socket = socket;
        _bounds = (bounds.MaximumMessageBytes, bounds.CloseTimeout);
        _platform = bounds.Platform;
        _pace = bounds.Pace;
        _read = bounds.Gate ?? new ReadGate();

        // * a verdict of its meter fails it, from whatever thread draws it: its own read, the rate's
        // timer, or another connection's charge that casts it off
        _read.Meter?.Bind(Fail);
        _sendPace = bounds.Pace is { } pace
            ? new SendPace((Late, Unsent), new SendPaceOptions { MinimumSendBytesPerSecond = pace.MinimumSendBytesPerSecond, SendGracePeriod = pace.SendGracePeriod, Clock = _platform })
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
                return _verdict?.Code == WebSocketCloseStatus.MessageTooBig;
            }
        }
    }

    /// <summary>
    /// The verdict it was failed by, its meter's or a message past its bound, as its side reports it
    /// through its <c>Error</c> (spec 15.1, 15.3): <paramref name="subject"/>, a server's handle or a
    /// client's connection, then the bound in the spec's spelling and its value, or the rule broken;
    /// none while it was failed by none.
    /// </summary>
    public Exception? FailureOf(string subject)
    {
        lock (_gate)
        {
            return _verdict?.ExceptionOf(subject);
        }
    }

    /// <summary>
    /// Fails it with <paramref name="verdict"/>, its first alone, from any thread (spec 15.3, RFC
    /// 6455 §7.1.7): its close sent with the verdict's code, then what still comes dropped until
    /// its peer ends or its close timeout passes, its close unclean whatever the peer answers.
    /// Nothing once it ended.
    /// </summary>
    public void Fail(FrameVerdict verdict)
    {
        lock (_gate)
        {
            if (_verdict is not null || _isEnded)
            {
                return;
            }

            _verdict = verdict;
        }

        _ = Close(verdict.Code);
    }

    /// <summary>
    /// What its socket threw as this side aborted it, which its side reports as the connection's
    /// error when nothing came before it; none while its abort threw nothing.
    /// </summary>
    public Exception? AbortFailure
    {
        get
        {
            lock (_gate)
            {
                return _abortFailure;
            }
        }
    }

    /// <summary>
    /// Whether this side ended it of its own: dropped behind a bound, failed with 1009, aborted
    /// past its close timeout, or aborted by a socket that threw. What its socket meets after says
    /// nothing more, and its close is unclean, whatever the peer answers.
    /// </summary>
    public bool IsEndedHere
    {
        get
        {
            lock (_gate)
            {
                return _dropped is not null || _verdict is not null || _isAbandoned || _abortFailure is not null;
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
                _dropped = string.Create(CultureInfo.InvariantCulture, $"what waits for its socket would pass maximumUnsentBytes, {FailureException.ByteCountOf(pace.MaximumUnsentBytes)}");
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

            _dropped = ServerBounds.LateOf((pace.MinimumSendBytesPerSecond, pace.SendGracePeriod));
        }

        Drop();
    }

    // ! dropped with no closing handshake, its close unclean: a peer that does not read would read
    // no close frame waiting behind what it does not read (RFC 6455 §7.1.7); its server reports it
    // once its read ends, before its close, so nothing a listener throws keeps it open
    private void Drop()
    {
        _sendPace?.Stop();
        OpenGate(true);
        Abort();
    }

    // ! a drop always completes: what its socket throws as it is aborted is kept, the connection's
    // error, and its read is cancelled, since that socket may never end it
    private void Abort()
    {
        try
        {
            Socket.Abort();
        }
        catch (Exception reason)
        {
            lock (_gate)
            {
                _abortFailure ??= reason;
            }

            // its task observed, as a client's dispose observes its own cancel
            _ = _reading.CancelAsync().ContinueWith((completed) => { _ = completed.Exception; }, TaskScheduler.Default);
        }
    }

    /// <summary>
    /// Reads no message more, its router behind (spec 15.12): a message partway is read to its end
    /// and held, one at most, until <see cref="Resume"/>; a read already waiting on its socket's
    /// gated stream reads nothing more of it. Nothing once it closes, which reads on. Idempotent; it
    /// takes its gate's lock alone, never held as it delivers.
    /// </summary>
    public void Pause()
    {
        _read.Pause();
    }

    /// <summary>
    /// Reads again: what it held delivered, then each message as it comes, from its read's own
    /// step, never within this call. Idempotent.
    /// </summary>
    public void Resume()
    {
        OpenGate(false);
    }

    // its read's gate opened: for a resume; or for good, the connection closing, which reads on to
    // its peer's Close
    private void OpenGate(bool isForGood)
    {
        _read.Open(isForGood);
    }

    // whether its gate opened for good, this side closing it
    private bool IsReadingOn()
    {
        return _read.IsReadingOn;
    }

    // settles once its read may go on: at once unless its router paused it, the rate's clock of a
    // message its meter read the start of stopped meanwhile, since nothing of it is read (spec 15.12)
    private async Task Resumed()
    {
        var resumed = _read.Resumed();

        if (resumed.IsCompleted)
        {
            return;
        }

        // * a verdict drawn behind the message its router paused on fails it at once (spec 15.3): its
        // close goes, its gate opens for good, and what the pause holds is dropped
        if (_read.Meter is { Verdict: not null } meter)
        {
            meter.Tell();

            return;
        }

        _read.Meter?.Hold();

        try
        {
            await resumed;
        }
        finally
        {
            _read.Meter?.Unhold();
        }
    }

    // sends a close behind what was sent before it, and drops the socket should the peer not
    // answer it within its timeout: on its platform's clock, since it bounds the platform's own
    // close against a peer that does not answer, never what Bead times
    public async Task Close(WebSocketCloseStatus status)
    {
        // ! a connection this side closes reads on to its peer's Close, whatever its router paused:
        // its close handshake never waits on its own pause
        OpenGate(true);
        await Answer(status);

        // the wait is cancelled once the connection's end wins it: nothing lingers until the
        // timeout fires, and an endless timeout lingers nowhere
        using var elapsed = new CancellationTokenSource();
        var waiting = Task.Delay(_bounds.CloseTimeout, _platform, elapsed.Token);

        if (await Task.WhenAny(_ended.Task, waiting) == waiting)
        {
            // marked before the abort the pending read meets: this side's own, no error
            lock (_gate)
            {
                _isAbandoned = true;
            }

            Abort();
        }
        else
        {
            await elapsed.CancelAsync();
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
    /// is read to its close and dropped. A verdict of its meter fails the connection (RFC 6455
    /// §7.1.7), what comes after dropped unparsed until the peer ends or the close timeout passes; a
    /// message past the bound on a socket no meter reads fails it with 1009, what comes after read
    /// to the peer's close and dropped. What breaks the socket throws; either way, the connection
    /// ends.
    /// </summary>
    public async Task Read(Action<TransportMessage> deliver)
    {
        try
        {
            // ! 16 KiB, by which .NET's keep-alive counts a read: a single frame slower than that a
            // heartbeat is dropped (docs/support.md)
            var buffer = new byte[16 * 1024];
            var isClosing = false;

            while (Socket.State is WebSocketState.Open or WebSocketState.CloseSent)
            {
                // * no message started while its router paused it (spec 15.12)
                if (_messageBytes == 0 && !isClosing)
                {
                    await Resumed();

                    if (Socket.State is not (WebSocketState.Open or WebSocketState.CloseSent))
                    {
                        break;
                    }
                }

                var received = await Socket.ReceiveAsync(buffer.AsMemory(), _reading.Token);

                if (received.MessageType == WebSocketMessageType.Close)
                {
                    if (Socket.State == WebSocketState.CloseReceived)
                    {
                        await Answer(Socket.CloseStatus ?? WebSocketCloseStatus.NormalClosure);
                    }

                    return;
                }

                // ! once this side closes, what still comes is dropped, its gate opened as it began,
                // before its close frame went
                if (isClosing || Socket.State == WebSocketState.CloseSent || IsReadingOn())
                {
                    continue;
                }

                // a backstop for a socket no meter reads: a meter judges this at each head
                if (_messageBytes + received.Count > _bounds.MaximumMessageBytes)
                {
                    isClosing = true;
                    Release();
                    Fail(FrameVerdict.TooBig(_bounds.MaximumMessageBytes));

                    continue;
                }

                // a message partway is read to its end, paused or not
                _read.Partway(!received.EndOfMessage);

                if (!received.EndOfMessage)
                {
                    Append(buffer.AsSpan(0, received.Count));

                    continue;
                }

                byte[] bytes;

                // * a message of one read is copied whole, no buffer rented
                if (_messageBytes == 0)
                {
                    bytes = buffer.AsSpan(0, received.Count).ToArray();
                }
                else
                {
                    Append(buffer.AsSpan(0, received.Count));
                    bytes = _message.AsSpan(0, _messageBytes).ToArray();
                    Release();
                }

                // * a message read whole past a pause is held until resumed, one at most; one this
                // side closed meanwhile, or whose socket ended while paused, is dropped with its
                // connection
                await Resumed();

                if (Socket.State != WebSocketState.Open || _read.IsDropping)
                {
                    continue;
                }

                deliver(new TransportMessage(bytes, received.MessageType == WebSocketMessageType.Text));
            }
        }
        finally
        {
            Release();
            End();
        }
    }

    // adds a read to the message partway, its buffer rented anew where it holds too little, twice as
    // large up to the message's bound, what it held copied over and the old one given back
    private void Append(ReadOnlySpan<byte> read)
    {
        var needed = _messageBytes + read.Length;

        if (_message is null || _message.Length < needed)
        {
            var grown = Math.Min((_message?.Length ?? 0) * 2L, _bounds.MaximumMessageBytes);
            var rented = ArrayPool<byte>.Shared.Rent(Math.Max(needed, (int)grown));

            if (_message is not null)
            {
                _message.AsSpan(0, _messageBytes).CopyTo(rented);
                ArrayPool<byte>.Shared.Return(_message);
            }

            _message = rented;
        }

        read.CopyTo(_message.AsSpan(_messageBytes));
        _messageBytes = needed;
    }

    // ! the message's buffer goes back to the pool once its message is whole or dropped: kept, it
    // would hold what the connection's largest message took for its life
    private void Release()
    {
        if (_message is not null)
        {
            ArrayPool<byte>.Shared.Return(_message);
            _message = null;
        }

        _messageBytes = 0;
    }

    // its end, told once, however it went: what still waits on the connection settles — the write
    // pump ends, and a close waiting on the peer's answer waits no timeout
    public void End()
    {
        lock (_gate)
        {
            _isEnded = true;
        }

        OpenGate(true);
        _read.Meter?.End();

        _outgoing.Writer.TryComplete();
        _ended.TrySetResult();
        _sendPace?.Stop();
    }

    /// <summary>What its read's buffer holds room for right now, in bytes: the tests' way to see it let go.</summary>
    internal int HeldCapacity
    {
        get
        {
            return _message?.Length ?? 0;
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
                    Abort();
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

    /// <summary>
    /// What a connection reads and closes within, the platform's clock its close and its pace run
    /// on, what holds what waits for its socket, a server's, and the gate its socket's stream is
    /// read through.
    /// </summary>
    internal sealed record Bounds
    {
        public required int MaximumMessageBytes { get; init; }

        public required TimeSpan CloseTimeout { get; init; }

        public required TimeProvider Platform { get; init; }

        public Pacing? Pace { get; init; }

        public ReadGate? Gate { get; init; }
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
