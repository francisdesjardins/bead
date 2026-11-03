namespace Bead;

/// <summary>How a transport client closes its connection.</summary>
public sealed record TransportClientDisconnectOptions
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
public delegate TimeSpan TransportClientReconnectDelayResolver(TimeSpan? previousDelay, int attempt);

/// <summary>
/// A reconnection's delay, as every side takes one: a wait, the same after each failed attempt, or a
/// <see cref="TransportClientReconnectDelayResolver"/> that resolves each, as the TypeScript side's
/// <c>TransportClientReconnectDelay</c> is a number or a function (0004). It holds one of the two,
/// built by the constructor of each, and judges neither: the reconnection holds the wait it comes to.
/// </summary>
public sealed record TransportClientReconnectDelay
{
    /// <summary>The same wait after each failed attempt.</summary>
    public TransportClientReconnectDelay(TimeSpan delay)
    {
        Fixed = delay;
    }

    /// <summary>The wait <paramref name="resolver"/> resolves after each failed attempt.</summary>
    public TransportClientReconnectDelay(TransportClientReconnectDelayResolver resolver)
    {
        ArgumentNullException.ThrowIfNull(resolver);

        Resolver = resolver;
    }

    /// <summary>The wait after each failed attempt; none where a resolver gives it.</summary>
    public TimeSpan? Fixed { get; }

    /// <summary>What resolves the wait after each failed attempt; none where it is fixed.</summary>
    public TransportClientReconnectDelayResolver? Resolver { get; }

    /// <summary>The wait after the attempt numbered <paramref name="attempt"/> failed.</summary>
    internal TimeSpan After(TimeSpan? previousDelay, int attempt)
    {
        return Resolver is { } resolver ? resolver(previousDelay, attempt) : Fixed.GetValueOrDefault();
    }
}

/// <summary>How a transport client connects again.</summary>
public sealed record TransportClientReconnectOptions
{
    /// <summary>
    /// The wait after a failed attempt, before the next, or what resolves it from the wait before and
    /// the number of the attempt that failed: a second each unless told. The first attempt goes at
    /// once; a wait of zero is none, one from 1 to 2³¹ − 1 milliseconds is rounded to the nearest
    /// whole one, which its tap hears, and any other — <see cref="Timeout.InfiniteTimeSpan"/> among
    /// them — ends the reconnection with an <see cref="ArgumentOutOfRangeException"/>, before its tap
    /// hears it.
    /// </summary>
    public TransportClientReconnectDelay? Delay { get; init; }

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
