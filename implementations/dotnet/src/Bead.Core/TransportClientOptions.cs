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
/// <c>TransportClientReconnectDelay</c> is a number or a function (0047). It holds one of the two,
/// built by the constructor of each; its owner holds a fixed wait where it is given, as a transport
/// client's reconnection is called or a broker participant is built, and a resolver's answer at each
/// attempt (spec 1.4).
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

/// <summary>How a transport client connects again, or a broker participant's link.</summary>
public sealed record TransportClientReconnectOptions
{
    /// <summary>
    /// The wait after a failed attempt, before the next, or what resolves it from the wait before and
    /// the number of the attempt that failed: a second each unless told. The first attempt goes at
    /// once; a wait of zero is none, one from 1 to 2³¹ − 1 milliseconds is rounded to the nearest
    /// whole one, which its tap hears, and any other — <see cref="Timeout.InfiniteTimeSpan"/> among
    /// them — is an <see cref="ArgumentOutOfRangeException"/>: a fixed one where it is given, as a
    /// transport client's reconnection is called or a broker participant is built, and a resolver's
    /// answer at its attempt, before its tap hears it, ending the reconnection (spec 1.4). After a wait
    /// of zero, its next attempt comes in a later turn of the scheduler or context its reconnection
    /// runs on, never within the one its last attempt failed in.
    /// </summary>
    public TransportClientReconnectDelay? Delay { get; init; }

    /// <summary>
    /// The attempts before it gives up with a <see cref="ReconnectException"/>, there being always one
    /// at least: its owner's default when none, 5 for a transport client's reconnection, without end
    /// for a broker participant's.
    /// </summary>
    public int? MaximumAttempts { get; init; }

    /// <summary>
    /// Read before each attempt, the first included, and during each wait: cancelling it stops the
    /// attempts with an <see cref="OperationCanceledException"/>, a transport client's attempt under
    /// way included, where a broker participant's is not cut short, or disconnects a transport
    /// client's success.
    /// </summary>
    public CancellationToken CancellationToken { get; init; }

    /// <summary>Told the wait and the number of the attempt that failed, before waiting.</summary>
    public Action<TimeSpan, int>? Tap { get; init; }
}
