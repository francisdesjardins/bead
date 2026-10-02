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

/// <summary>How a transport client connects again.</summary>
public sealed record TransportReconnectOptions
{
    /// <summary>
    /// The wait after a failed attempt, before the next: a second each unless told. The first
    /// attempt goes at once; a wait of zero or less is none.
    /// </summary>
    public TransportReconnectDelay? Delay { get; init; }

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
