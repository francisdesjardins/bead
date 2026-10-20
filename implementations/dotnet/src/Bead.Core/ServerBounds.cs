namespace Bead;

/// <summary>
/// What every server's transport bounds alike (spec 15.12): its defaults, the counts it is given,
/// held as it is built, and the pace it holds what waits for a socket to.
/// </summary>
internal static class ServerBounds
{
    /// <summary>
    /// The slowest, by default, a socket may take what waits for it once its grace passed: 240
    /// bytes a second, Kestrel's <c>MinResponseDataRate</c>.
    /// </summary>
    public const int MinimumSendBytesPerSecond = 240;

    /// <summary>The slowest, by default, a request's body may come once its grace passed: 240 bytes a second, Kestrel's <c>MinRequestBodyDataRate</c>.</summary>
    public const int MinimumBodyBytesPerSecond = 240;

    /// <summary>The least time, by default, an envelope is given to be taken by its socket.</summary>
    public static readonly TimeSpan SendGracePeriod = TimeSpan.FromSeconds(5);

    /// <summary>How long, by default, a body comes before its rate is held.</summary>
    public static readonly TimeSpan BodyGracePeriod = TimeSpan.FromSeconds(5);

    /// <summary>How long, by default, a request's head may take to come whole.</summary>
    public static readonly TimeSpan HeadersTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How long a socket closed in stages reads on and drops what still comes once its answer is
    /// written, unless its client closes first: 2 seconds, as Apache httpd lingers (RFC 9112 §9.6).
    /// </summary>
    public static readonly TimeSpan Linger = TimeSpan.FromSeconds(2);

    /// <summary>How often what waits for a socket is judged against its deadline.</summary>
    public static readonly TimeSpan Check = TimeSpan.FromSeconds(1);

    /// <summary>
    /// <paramref name="count"/> held: a whole number above 0; any other is an
    /// <see cref="ArgumentOutOfRangeException"/> naming its option.
    /// </summary>
    public static long AssertCount((string Name, long Value) count)
    {
        if (count.Value < 1)
        {
            throw new ArgumentOutOfRangeException(count.Name, $"{count.Name} is a whole number above 0, not {count.Value}");
        }

        return count.Value;
    }

    /// <summary>
    /// <paramref name="count"/> held where 0 holds none: a whole number from 0; any other is an
    /// <see cref="ArgumentOutOfRangeException"/> naming its option.
    /// </summary>
    public static long AssertCountOrNone((string Name, long Value) count)
    {
        if (count.Value < 0)
        {
            throw new ArgumentOutOfRangeException(count.Name, $"{count.Name} is a whole number, not {count.Value}");
        }

        return count.Value;
    }
}

/// <summary>What a socket's pace is held to: the slowest it may take what waits, past a grace, on a clock.</summary>
internal sealed record SendPaceOptions
{
    /// <summary>The slowest, in bytes a second, a socket may take what waits for it; 0 holds none.</summary>
    public required int MinimumSendBytesPerSecond { get; init; }

    /// <summary>The least time an envelope is given to be taken.</summary>
    public required TimeSpan SendGracePeriod { get; init; }

    /// <summary>
    /// What it is judged on: the platform's clock, whatever clock the server is given, since it
    /// bounds what the platform's socket does, as the heartbeat does (decision 0011).
    /// </summary>
    public TimeProvider Clock { get; init; } = TimeProvider.System;
}

/// <summary>
/// Holds what waits for one socket to a pace, as Kestrel holds a response to its
/// <c>MinResponseDataRate</c> (spec 15.12): each envelope of <i>S</i> bytes handed moves the deadline
/// to the later of now plus the longer of the grace and <i>S</i> at the rate, and the deadline
/// before plus that time. While what it is told waits is more than none, it is judged each second,
/// and it hears, once, that what waits is past its deadline; nothing waiting, no deadline runs. A
/// rate of 0 holds none.
/// </summary>
internal sealed class SendPace
{
    private readonly (Action Late, Func<long> Unsent) _hooks;
    private readonly SendPaceOptions _options;
    private readonly Lock _gate = new();
    private long? _deadline;
    private ITimer? _timer;

    /// <summary>A pace that hears <c>Late</c> once what <c>Unsent</c> says waits is past its deadline.</summary>
    public SendPace((Action Late, Func<long> Unsent) hooks, SendPaceOptions options)
    {
        _hooks = hooks;
        _options = options;
    }

    /// <summary>An envelope of <paramref name="bytes"/> handed to the socket: its deadline moved, its check armed.</summary>
    public void Hand(int bytes)
    {
        var bytesPerSecond = _options.MinimumSendBytesPerSecond;

        if (bytesPerSecond == 0)
        {
            return;
        }

        var clock = _options.Clock;
        var takes = TimeSpan.FromMilliseconds(bytes * 1_000d / bytesPerSecond);
        var now = clock.GetTimestamp();
        var earliest = Later(now, takes > _options.SendGracePeriod ? takes : _options.SendGracePeriod);

        lock (_gate)
        {
            _deadline = _deadline is { } before ? Math.Max(earliest, Later(before, takes)) : earliest;
            _timer ??= clock.CreateTimer(
                (_) =>
                {
                    Judge();
                },
                null,
                ServerBounds.Check,
                ServerBounds.Check);
        }
    }

    /// <summary>Nothing more is judged: the socket is gone, or done.</summary>
    public void Stop()
    {
        lock (_gate)
        {
            _timer?.Dispose();
            _timer = null;
            _deadline = null;
        }
    }

    // a timestamp of the pace's clock, a span later
    private long Later(long timestamp, TimeSpan later)
    {
        return timestamp + (long)(later.TotalSeconds * _options.Clock.TimestampFrequency);
    }

    // each second while it runs: nothing waiting, it stops; what waits past its deadline is late
    private void Judge()
    {
        if (_hooks.Unsent() == 0)
        {
            Stop();

            return;
        }

        bool isLate;

        lock (_gate)
        {
            isLate = _deadline is { } deadline && _options.Clock.GetTimestamp() > deadline;
        }

        if (isLate)
        {
            Stop();
            _hooks.Late();
        }
    }
}
