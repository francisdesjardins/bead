namespace Bead;

/// <summary>How a transport client closes its connection.</summary>
public sealed record TransportDisconnectOptions
{
    /// <summary>What its close says of being clean; true unless told.</summary>
    public bool IsClean { get; init; } = true;

    /// <summary>Whether the socket is dropped at once instead of waiting for its close handshake.</summary>
    public bool IsQuick { get; init; }
}

/// <summary>
/// How long a reconnection waits after the attempt numbered <paramref name="attempt"/> failed,
/// from the wait before it: none before the first.
/// </summary>
/// <param name="previousDelay">The wait before, or none.</param>
/// <param name="attempt">The number of the attempt that failed, from 1.</param>
public delegate TimeSpan TransportReconnectDelay(TimeSpan? previousDelay, int attempt);

/// <summary>
/// A reconnection's delay, as every side takes one: a wait, the same after each failed attempt, or a
/// <see cref="TransportReconnectDelay"/> that resolves each, as the TypeScript side's
/// <c>TransportClientReconnectDelayOrDelayResolver</c> is a number or a function (0004). It holds
/// one of the two, and judges neither: the reconnection holds the wait it comes to.
/// </summary>
public sealed record TransportReconnectDelayOrResolver
{
    private TransportReconnectDelayOrResolver()
    {
    }

    /// <summary>The wait after each failed attempt; none where a resolver gives it.</summary>
    public TimeSpan? Fixed { get; private init; }

    /// <summary>What resolves the wait after each failed attempt; none where it is fixed.</summary>
    public TransportReconnectDelay? Resolver { get; private init; }

    /// <summary>The same wait after each failed attempt.</summary>
    public static TransportReconnectDelayOrResolver Of(TimeSpan delay)
    {
        return new TransportReconnectDelayOrResolver { Fixed = delay };
    }

    /// <summary>The wait <paramref name="resolver"/> resolves after each failed attempt.</summary>
    public static TransportReconnectDelayOrResolver Of(TransportReconnectDelay resolver)
    {
        ArgumentNullException.ThrowIfNull(resolver);

        return new TransportReconnectDelayOrResolver { Resolver = resolver };
    }

    /// <summary>The wait after the attempt numbered <paramref name="attempt"/> failed.</summary>
    internal TimeSpan After(TimeSpan? previousDelay, int attempt)
    {
        return Resolver is { } resolver ? resolver(previousDelay, attempt) : Fixed.GetValueOrDefault();
    }
}

/// <summary>How a transport client connects again.</summary>
public sealed record TransportReconnectOptions
{
    /// <summary>
    /// The wait after a failed attempt, before the next, or what resolves it from the wait before and
    /// the number of the attempt that failed: a second each unless told. The first attempt goes at
    /// once; a wait of zero is none, one from 1 to 2³¹ − 1 milliseconds is rounded to the nearest
    /// whole one, which its tap hears, and any other — <see cref="Timeout.InfiniteTimeSpan"/> among
    /// them — ends the reconnection with an <see cref="ArgumentOutOfRangeException"/>, before its tap
    /// hears it.
    /// </summary>
    public TransportReconnectDelayOrResolver? Delay { get; init; }

    /// <summary>The attempts before it gives up with a <see cref="ReconnectException"/>; there is always one at least.</summary>
    public int MaximumAttempts { get; init; } = 5;

    /// <summary>
    /// Cancelling it stops the attempts, the one connecting included, or disconnects a success,
    /// with an <see cref="OperationCanceledException"/>.
    /// </summary>
    public CancellationToken CancellationToken { get; init; }

    /// <summary>Told the wait and the number of the attempt that failed, before waiting.</summary>
    public Action<TimeSpan, int>? Tap { get; init; }
}
