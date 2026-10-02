namespace Bead;

/// <summary>
/// The attempts of a transport client's reconnection, whatever the transport, as the TypeScript
/// side's <c>createTransportClient</c> makes them for each: until one opens, each failed one
/// waiting its delay, armed before the tap is told, so whoever moves the clock once told moves it
/// past the wait.
/// </summary>
internal static class TransportReconnection
{
    /// <summary>What a reconnection a cancel stopped says, whatever stopped where.</summary>
    public const string Cancelled = "the reconnection was cancelled";

    // what a reconnection waits after a failed attempt, unless told
    private static readonly TimeSpan Delay = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Attempts until one opens: the first at once, each next one after its delay. Attempts that run
    /// out are a <see cref="ReconnectException"/>, the last one's exception inside; a cancel is an
    /// <see cref="OperationCanceledException"/>; a delay that throws, an
    /// <see cref="InvalidOperationException"/>. What the tap throws passes through.
    /// </summary>
    public static async Task Attempting(Func<CancellationToken, Task> attempt, (TransportReconnectOptions Options, TimeProvider Time) reconnection)
    {
        var (reconnect, time) = reconnection;
        var token = reconnect.CancellationToken;
        TimeSpan? previousDelay = null;

        // a cancel between attempts needs no check of its own: the next attempt is handed the token,
        // and throws at once
        for (var number = 1; ; number += 1)
        {
            try
            {
                await attempt(token);

                return;
            }
            catch (Exception reason)
            {
                if (token.IsCancellationRequested)
                {
                    throw new OperationCanceledException(Cancelled, reason, token);
                }

                if (number >= reconnect.MaximumAttempts)
                {
                    throw new ReconnectException($"attempt {reconnect.MaximumAttempts} reached", reason);
                }
            }

            TimeSpan nextDelay;

            try
            {
                nextDelay = reconnect.Delay is { } delay ? delay(previousDelay, number) : Delay;
            }
            catch (Exception reason)
            {
                throw new InvalidOperationException(reason.Message, reason);
            }

            using var pausing = CancellationTokenSource.CreateLinkedTokenSource(token);
            var waiting = Task.Delay(nextDelay > TimeSpan.Zero ? nextDelay : TimeSpan.Zero, time, pausing.Token);

            try
            {
                reconnect.Tap?.Invoke(nextDelay, number);
            }
            catch
            {
                await pausing.CancelAsync();

                throw;
            }

            previousDelay = nextDelay;

            try
            {
                await waiting;
            }
            catch (OperationCanceledException reason) when (token.IsCancellationRequested)
            {
                throw new OperationCanceledException(Cancelled, reason, token);
            }
        }
    }
}
