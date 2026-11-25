using System.Buffers.Binary;
using System.Globalization;
using System.Net.WebSockets;

namespace Bead.Transport.WebSockets;

/// <summary>
/// One connection's frame meter (spec 15.3, 15.12, decision 0056): fed every raw read of its upgraded
/// socket before .NET's reader sees it, it parses each frame's head (RFC 6455 §5.2), its bytes as
/// they come across reads, and never unmasks a payload. It judges each frame at its head: past
/// <c>maximumMessageBytes</c>, 1009; past <c>maximumMessageFrames</c>, 1008; a head RFC 6455 forbids,
/// 1002. A server's charges a message partway to its budget as it comes, each byte of payload as it
/// is read and each head once whole, its bytes and 128 more, and holds the message to its rate, 1008
/// past it. A verdict cuts its read at the first byte of the frame that draws it, what came before
/// handed on and charged first; from it on, nothing more is handed on or charged.
/// </summary>
internal sealed class FrameMeter
{
    /// <summary>The frames a message takes at most by default, <c>maximumMessageFrames</c>.</summary>
    public const int MaximumMessageFrames = 16_384;

    /// <summary>What each head of a message partway is charged once whole, beyond its bytes (spec 15.12).</summary>
    public const int PerFrame = 128;

    // a WebSocket's opcodes (RFC 6455 §5.2)
    private const int Continuation = 0x0;
    private const int Text = 0x1;
    private const int Binary = 0x2;
    private const int FirstControl = 0x8;
    private const int LastControl = 0xA;

    private readonly MeterOptions _options;
    private readonly MessageBudget.Holder? _holder;

    // the verdict, the rate's state and the sink a verdict is told to, under the lock: a cast-off
    // and the rate's timer come from other threads
    private readonly Lock _gate = new();
    private FrameVerdict? _verdict;
    private bool _isTold;
    private bool _isEnded;
    private Action<FrameVerdict>? _sink;
    private ITimer? _timer;
    private bool _isTimed;
    private long _began;
    private long? _heldSince;
    private long _payload;

    // ! the parse, its reader's alone: one read at a time
    // the head under way, its bytes so far, and how long it is once its second byte came
    private readonly byte[] _head = new byte[14];
    private int _headCount;
    private int _headLength = 2;
    private int _lengthEnd = 2;
    private int _opcode;
    private bool _isFinal;
    private long _length;
    private bool _isCharged;
    // the payload of the frame under way, once its head is whole
    private long _payloadLeft;
    private bool _isInPayload;
    // the message under way: its announced total and its frames
    private bool _isUnderWay;
    private long _announced;
    private int _frames;
    // every byte it read, which places a frame for the tests and the fuzz target
    private long _offset;
    private long _frameStart;

    /// <summary>A meter held to <paramref name="options"/>.</summary>
    public FrameMeter(MeterOptions options)
    {
        _options = options;
        _holder = options.Budget is null ? null : new MessageBudget.Holder(CastOff);
    }

    /// <summary>Its verdict, once one is drawn; none before.</summary>
    public FrameVerdict? Verdict
    {
        get
        {
            lock (_gate)
            {
                return _verdict;
            }
        }
    }

    /// <summary>
    /// Binds what a verdict is told to, its connection's failure: a verdict drawn before it and due
    /// is told now. Once.
    /// </summary>
    public void Bind(Action<FrameVerdict> sink)
    {
        FrameVerdict? due;

        lock (_gate)
        {
            _sink = sink;
            due = _isTold ? _verdict : null;
        }

        if (due is not null)
        {
            sink(due);
        }
    }

    /// <summary>
    /// Reads <paramref name="bytes"/>, one read of the socket: how many of them, from the first, are
    /// handed on to .NET's reader. All of them but past a verdict, which cuts them at the first byte
    /// of the frame that draws it; none once a verdict was drawn before.
    /// </summary>
    public int Read(ReadOnlySpan<byte> bytes)
    {
        lock (_gate)
        {
            if (_verdict is not null || _isEnded)
            {
                return _verdict is null ? bytes.Length : 0;
            }
        }

        var charge = 0L;
        var chargedFrom = -1;
        var isMoved = false;
        var at = 0;

        while (at < bytes.Length)
        {
            if (!_isInPayload)
            {
                if (_headCount == 0)
                {
                    _frameStart = _offset + at;
                }

                var drawn = Head(bytes[at]);

                // * a head that draws a verdict is never whole, so nothing of it is charged; what the
                // read brought before it is, first, and a cast-off there wins over the verdict
                if (drawn is not null)
                {
                    if (charge > 0 && !_options.Budget!.Charge((_holder!, charge)))
                    {
                        return Cut((FrameVerdict.CastOff(_options.Budget.Budget), chargedFrom));
                    }

                    return Cut((drawn, StartIn()));
                }

                // * a head charged once whole, at its last byte: its bytes and 128 (spec 15.12)
                if (_isInPayload && _isCharged)
                {
                    chargedFrom = chargedFrom < 0 ? StartIn() : chargedFrom;
                    charge += _headLength + PerFrame;
                }

                at += 1;

                // its head whole, its bounds known
                if (_isInPayload)
                {
                    _options.Framed?.Invoke(new MeteredFrame(SumOf(_offset + at, _length), _opcode, _isFinal, _length));
                }
            }
            else
            {
                var taken = (int)Math.Min(bytes.Length - at, _payloadLeft);

                if (_isCharged)
                {
                    chargedFrom = chargedFrom < 0 ? at : chargedFrom;
                    charge += taken;
                }

                if (!IsControl(_opcode))
                {
                    isMoved = true;

                    lock (_gate)
                    {
                        _payload += taken;
                    }
                }

                _payloadLeft -= taken;
                at += taken;
            }

            if (_isInPayload && _payloadLeft == 0)
            {
                // * each frame charged as it ends, what came of it in this read; a message whole,
                // its charge taken, then released at once (spec 15.12)
                var isWhole = FrameEnded();

                if (charge > 0)
                {
                    if (!_options.Budget!.Charge((_holder!, charge)))
                    {
                        return Cut((FrameVerdict.CastOff(_options.Budget.Budget), chargedFrom));
                    }

                    charge = 0;
                    chargedFrom = -1;
                }

                if (isWhole)
                {
                    _options.Budget?.Release(_holder!);
                    Whole();
                    isMoved = false;
                }
            }
        }

        // ! its timer armed at its new due before its charge shows, which a test reads as it was read
        if (isMoved)
        {
            Arm();
        }

        if (charge > 0 && !_options.Budget!.Charge((_holder!, charge)))
        {
            return Cut((FrameVerdict.CastOff(_options.Budget.Budget), chargedFrom));
        }

        _offset += bytes.Length;

        // a cast-off of another's as it read: nothing of it is handed on
        return Verdict is null ? bytes.Length : 0;
    }

    /// <summary>
    /// Tells its verdict to what it is bound to, once: at once for a verdict from outside, and for
    /// one drawn within a read, once what that read handed on before it was read.
    /// </summary>
    public void Tell()
    {
        FrameVerdict? verdict;
        Action<FrameVerdict>? sink;

        lock (_gate)
        {
            if (_verdict is null || _isTold)
            {
                return;
            }

            _isTold = true;
            verdict = _verdict;
            sink = _sink;
        }

        sink?.Invoke(verdict);
    }

    /// <summary>A verdict from outside it, the rate's or a cast-off: drawn and told at once, its first one alone.</summary>
    public void Fail(FrameVerdict verdict)
    {
        if (Draw(verdict))
        {
            Tell();
        }
    }

    /// <summary>
    /// Its socket's read waits on its gate, its router behind: the rate's clock stops for a message
    /// under way (spec 15.12).
    /// </summary>
    public void Hold()
    {
        lock (_gate)
        {
            if (_isTimed && _heldSince is null && _verdict is null)
            {
                _heldSince = Clock.GetTimestamp();
                _timer?.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            }
        }
    }

    /// <summary>Its socket's read goes on: the rate's clock runs again from where it stopped.</summary>
    public void Unhold()
    {
        lock (_gate)
        {
            if (_heldSince is not { } since)
            {
                return;
            }

            _began += Clock.GetTimestamp() - since;
            _heldSince = null;
            ArmLocked();
        }
    }

    /// <summary>Its connection ended: its charge released, its timer gone, and nothing more charged. Idempotent.</summary>
    public void End()
    {
        ITimer? timer;

        lock (_gate)
        {
            _isEnded = true;
            timer = _timer;
            _timer = null;
            _isTimed = false;
        }

        timer?.Dispose();

        if (_holder is not null)
        {
            _options.Budget!.Leave(_holder);
        }
    }

    private TimeProvider Clock
    {
        get
        {
            return _options.Rate?.Clock ?? TimeProvider.System;
        }
    }

    private static bool IsControl(int opcode)
    {
        return opcode >= FirstControl;
    }

    // where the frame under way began in this read: at none when it began in an earlier one
    private int StartIn()
    {
        return _frameStart > _offset ? (int)(_frameStart - _offset) : 0;
    }

    // the read cut at a verdict drawn within it: what came before the frame that draws it, its first
    // byte in an earlier read cutting it at none
    private int Cut((FrameVerdict Verdict, int At) cut)
    {
        Draw(cut.Verdict);

        return Math.Max(0, cut.At);
    }

    // * a verdict drawn, its first alone: its charge released at once, its timer gone, and nothing
    // more charged; true for the first
    private bool Draw(FrameVerdict verdict)
    {
        ITimer? timer;

        lock (_gate)
        {
            if (_verdict is not null || _isEnded)
            {
                return false;
            }

            _verdict = verdict;
            timer = _timer;
            _timer = null;
            _isTimed = false;
        }

        timer?.Dispose();

        if (_holder is not null)
        {
            _options.Budget!.Leave(_holder);
        }

        return true;
    }

    // its holder cast off by another's charge: 1013
    private void CastOff()
    {
        Fail(FrameVerdict.CastOff(_options.Budget!.Budget));
    }

    // a byte of a head, judged at the byte that draws a verdict (spec 15.3): its verdict, or none
    private FrameVerdict? Head(byte octet)
    {
        _head[_headCount] = octet;
        _headCount += 1;

        if (_headCount == 1)
        {
            return First(octet);
        }

        if (_headCount == 2)
        {
            var isMasked = (octet & 0x80) != 0;
            var short7 = octet & 0x7F;

            if (isMasked != _options.IsServer)
            {
                return FrameVerdict.Forbidden(_options.IsServer ? "an unmasked frame" : "a masked frame");
            }

            // ! a control frame's length is judged in its 7 bits: a longer form, whatever its value,
            // breaks RFC 6455 §5.2's minimal form, and every side refuses it alike
            if (IsControl(_opcode) && short7 > 125)
            {
                return FrameVerdict.Forbidden("a control frame longer than 125 bytes");
            }

            _lengthEnd = 2 + (short7 == 126 ? 2 : short7 == 127 ? 8 : 0);
            _headLength = _lengthEnd + (isMasked ? 4 : 0);

            if (_lengthEnd == 2)
            {
                _length = short7;

                if (Announced() is { } tooBig)
                {
                    return tooBig;
                }
            }
        }
        else if (_headCount == 3 && _lengthEnd == 10 && (octet & 0x80) != 0)
        {
            // a 64-bit length's top bit is judged at its first byte, the head's third (RFC 6455 §5.2)
            return FrameVerdict.Forbidden("a 64-bit length with its top bit set");
        }
        else if (_headCount == _lengthEnd)
        {
            var length = _head.AsSpan(2, _lengthEnd - 2);

            // a data frame's length not in its minimal form is taken, as ws, .NET and tungstenite take it
            _length = length.Length == 2 ? BinaryPrimitives.ReadUInt16BigEndian(length) : (long)BinaryPrimitives.ReadUInt64BigEndian(length);

            if (Announced() is { } tooBig)
            {
                return tooBig;
            }
        }

        if (_headCount == _headLength)
        {
            // * the head whole: its frame counted, and its payload read on
            if (!IsControl(_opcode))
            {
                _announced = SumOf(_announced, _length);
                _frames += 1;
            }

            _headCount = 0;
            _payloadLeft = _length;
            _isInPayload = true;
        }

        return null;
    }

    // the head's first byte: a rule of RFC 6455 §5.2, §5.4 or §5.5 it breaks, or a frame past
    // maximumMessageFrames, its count drawn as its frame begins; a message begins at its first frame
    private FrameVerdict? First(byte octet)
    {
        _opcode = octet & 0x0F;
        _isFinal = (octet & 0x80) != 0;
        _headLength = 2;
        _lengthEnd = 2;

        // ! no extension is negotiated (spec 15.2): every reserved bit is 0
        if ((octet & 0x70) != 0)
        {
            return FrameVerdict.Forbidden("a reserved bit set");
        }

        if (_opcode is > Binary and < FirstControl or > LastControl)
        {
            return FrameVerdict.Forbidden(string.Create(CultureInfo.InvariantCulture, $"a reserved opcode, {_opcode}"));
        }

        if (IsControl(_opcode))
        {
            _isCharged = _isUnderWay && _holder is not null;

            return _isFinal ? null : FrameVerdict.Forbidden("a control frame not final");
        }

        if (_opcode == Continuation && !_isUnderWay)
        {
            return FrameVerdict.Forbidden("a continuation with no message under way");
        }

        if (_opcode != Continuation && _isUnderWay)
        {
            return FrameVerdict.Forbidden("a data frame that is not a continuation while a message is under way");
        }

        if (_frames >= _options.MaximumMessageFrames)
        {
            return FrameVerdict.TooManyFrames(_options.MaximumMessageFrames);
        }

        if (_opcode != Continuation)
        {
            Begin();
        }

        _isCharged = _holder is not null;

        return null;
    }

    // a frame's announced length taking its message past maximumMessageBytes: 1009 at its head
    private FrameVerdict? Announced()
    {
        if (IsControl(_opcode) || SumOf(_announced, _length) <= _options.MaximumMessageBytes)
        {
            return null;
        }

        return FrameVerdict.TooBig(_options.MaximumMessageBytes);
    }

    // ! a sum that saturates: a 64-bit length can take it past what a long holds
    private static long SumOf(long sum, long length)
    {
        return length > long.MaxValue - sum ? long.MaxValue : sum + length;
    }

    // a frame's payload read whole: true where it ends its message
    private bool FrameEnded()
    {
        _isInPayload = false;

        return !IsControl(_opcode) && _isFinal;
    }

    // a message begins, at its first frame's first byte: its rank among equal sums taken, and its
    // rate's clock started
    private void Begin()
    {
        _isUnderWay = true;
        _announced = 0;
        _frames = 0;

        if (_holder is not null)
        {
            _options.Budget!.Begin(_holder);
        }

        lock (_gate)
        {
            _payload = 0;

            if (_options.Rate is null)
            {
                return;
            }

            _began = Clock.GetTimestamp();
            _heldSince = null;
            _isTimed = true;
            ArmLocked();
        }
    }

    // a message whole: nothing under way, and its rate's timer stopped
    private void Whole()
    {
        _isUnderWay = false;
        _announced = 0;
        _frames = 0;

        lock (_gate)
        {
            _isTimed = false;
            _heldSince = null;
            _timer?.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        }
    }

    // its message brought payload: its timer armed again
    private void Arm()
    {
        lock (_gate)
        {
            ArmLocked();
        }
    }

    // * the rate's timer armed at its message's due (spec 15.12): its first byte plus the longer of
    // its grace and its payload at the rate, the time its gate held it not counted; a millisecond
    // at least, Bead arming no timer for less; under the lock
    private void ArmLocked()
    {
        if (_options.Rate is not { } rate || !_isTimed || _heldSince is not null || _verdict is not null || _isEnded)
        {
            return;
        }

        var left = AllowedOf(rate) - ElapsedLocked();
        var due = TimeSpan.FromMilliseconds(Math.Clamp(Math.Ceiling(left.TotalMilliseconds), 1, Clocks.LongestTimer.TotalMilliseconds));

        if (_timer is null)
        {
            _timer = rate.Clock.CreateTimer(
                (_) =>
                {
                    Due();
                },
                null,
                due,
                Timeout.InfiniteTimeSpan);
        }
        else
        {
            _timer.Change(due, Timeout.InfiniteTimeSpan);
        }
    }

    // how long its message may take for what it brought: the longer of its grace and its payload at
    // the rate, in whole milliseconds; under the lock
    private TimeSpan AllowedOf(RateOptions rate)
    {
        var owed = ((_payload * 1_000) + rate.MinimumBodyBytesPerSecond - 1) / rate.MinimumBodyBytesPerSecond;

        return TimeSpan.FromMilliseconds(Math.Max((long)rate.BodyGracePeriod.TotalMilliseconds, owed));
    }

    // its message's time on the rate's clock, what its gate held not counted; under the lock
    private TimeSpan ElapsedLocked()
    {
        return Clock.GetElapsedTime(_began, _heldSince ?? Clock.GetTimestamp());
    }

    // the rate's timer fired: past its due, 1008; a message whole, held or failed meanwhile is
    // nothing, and one that brought more since is timed again
    private void Due()
    {
        FrameVerdict? verdict = null;

        lock (_gate)
        {
            if (_options.Rate is not { } rate || !_isTimed || _heldSince is not null || _verdict is not null || _isEnded)
            {
                return;
            }

            if (ElapsedLocked() < AllowedOf(rate))
            {
                ArmLocked();

                return;
            }

            verdict = FrameVerdict.TooSlow(rate);
        }

        Fail(verdict);
    }

    /// <summary>What a meter holds a connection's frames to.</summary>
    internal sealed record MeterOptions
    {
        /// <summary>The largest message, <c>maximumMessageBytes</c>, by what its heads announce.</summary>
        public required int MaximumMessageBytes { get; init; }

        /// <summary>The frames a message takes at most, <c>maximumMessageFrames</c>.</summary>
        public int MaximumMessageFrames { get; init; } = FrameMeter.MaximumMessageFrames;

        /// <summary>Whether it is a server's, whose peer masks every frame; a client's peer masks none.</summary>
        public required bool IsServer { get; init; }

        /// <summary>The budget a server charges its messages partway to; none for a client.</summary>
        public MessageBudget? Budget { get; init; }

        /// <summary>The rate a server holds its messages partway to; none for a client.</summary>
        public RateOptions? Rate { get; init; }

        /// <summary>What hears each frame as its head is read whole, the fuzz target's; none hears by default.</summary>
        public Action<MeteredFrame>? Framed { get; init; }
    }

    /// <summary>The rate a server holds a message partway to, on its clock (spec 15.12).</summary>
    internal sealed record RateOptions
    {
        /// <summary>The slowest a message may come once its grace passed, <c>minimumBodyBytesPerSecond</c>.</summary>
        public required int MinimumBodyBytesPerSecond { get; init; }

        /// <summary>How long a message comes before its rate is held, <c>bodyGracePeriod</c>.</summary>
        public required TimeSpan BodyGracePeriod { get; init; }

        /// <summary>The server's clock, which the rate is judged on (decision 0011).</summary>
        public required TimeProvider Clock { get; init; }
    }
}

/// <summary>
/// A frame whose head a meter read whole: where its last byte stands in all it reads, by its
/// announced length, its opcode, whether it ends its message, and its payload's length.
/// </summary>
internal sealed record MeteredFrame(long End, int Opcode, bool IsFinal, long Length);

/// <summary>
/// A meter's verdict: the code its connection fails with, and why, naming the bound and its value
/// or the rule broken, as its side reports it (spec 15.1, 15.3).
/// </summary>
internal sealed record FrameVerdict
{
    // what a verdict's report is: a protocol error, as .NET raises its own; data the side does not
    // take; or a bound of the server's own, its I/O cut short
    private enum Kind
    {
        Protocol,
        Data,
        Bound,
    }

    private Kind Of { get; init; }

    /// <summary>The code its connection fails with.</summary>
    public required WebSocketCloseStatus Code { get; init; }

    /// <summary>Why, in the spec's spelling.</summary>
    public required string Why { get; init; }

    /// <summary>1013, Try Again Later in IANA's registry, which .NET has no name for.</summary>
    public const WebSocketCloseStatus TryAgainLater = (WebSocketCloseStatus)1013;

    /// <summary>A head RFC 6455 forbids: 1002.</summary>
    public static FrameVerdict Forbidden(string rule)
    {
        return new FrameVerdict { Of = Kind.Protocol, Code = WebSocketCloseStatus.ProtocolError, Why = $"a frame head RFC 6455 forbids, {rule}" };
    }

    /// <summary>A message past <c>maximumMessageBytes</c>: 1009.</summary>
    public static FrameVerdict TooBig(int maximumMessageBytes)
    {
        return new FrameVerdict { Of = Kind.Data, Code = WebSocketCloseStatus.MessageTooBig, Why = $"a message past its maximumMessageBytes, {FailureException.ByteCountOf(maximumMessageBytes)}" };
    }

    /// <summary>A message past <c>maximumMessageFrames</c>: 1008.</summary>
    public static FrameVerdict TooManyFrames(int maximumMessageFrames)
    {
        var frames = maximumMessageFrames == 1 ? "1 frame" : string.Create(CultureInfo.InvariantCulture, $"{maximumMessageFrames} frames");

        return new FrameVerdict { Of = Kind.Data, Code = WebSocketCloseStatus.PolicyViolation, Why = $"a message past its maximumMessageFrames, {frames}" };
    }

    /// <summary>A message slower than <c>minimumBodyBytesPerSecond</c> past <c>bodyGracePeriod</c>: 1008.</summary>
    public static FrameVerdict TooSlow(FrameMeter.RateOptions rate)
    {
        return new FrameVerdict
        {
            Of = Kind.Bound,
            Code = WebSocketCloseStatus.PolicyViolation,
            Why = string.Create(CultureInfo.InvariantCulture, $"a message came slower than minimumBodyBytesPerSecond, {FailureException.ByteCountOf(rate.MinimumBodyBytesPerSecond)} a second, past bodyGracePeriod, {(long)rate.BodyGracePeriod.TotalMilliseconds} ms"),
        };
    }

    /// <summary>A message cast off by <c>messageBytesBudget</c>: 1013.</summary>
    public static FrameVerdict CastOff(long messageBytesBudget)
    {
        return new FrameVerdict { Of = Kind.Bound, Code = TryAgainLater, Why = $"the messages partway would pass messageBytesBudget, {FailureException.ByteCountOf(messageBytesBudget)}" };
    }

    /// <summary>
    /// The verdict as its side reports it of <paramref name="subject"/>, a server's handle or a
    /// client's connection: a protocol error as .NET raises its own, a <see cref="WebSocketException"/>
    /// of <see cref="WebSocketError.Faulted"/>; data it does not take, an
    /// <see cref="InvalidDataException"/>, as SignalR reports a message past its own; a bound of the
    /// server's, an <see cref="IOException"/>, as a drop behind one is.
    /// </summary>
    public Exception ExceptionOf(string subject)
    {
        var message = string.Create(CultureInfo.InvariantCulture, $"{subject} is closed with {(int)Code}: {Why}");

        return Of switch
        {
            Kind.Protocol => new WebSocketException(WebSocketError.Faulted, message),
            Kind.Data => new InvalidDataException(message),
            _ => new IOException(message),
        };
    }
}
