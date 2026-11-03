namespace Bead;

/// <summary>
/// The attempts of a reconnection, a transport client's whatever the transport and a broker
/// participant's link's, as the TypeScript side's <c>attemptReconnection</c> makes them for each:
/// until one opens, each failed one waiting its delay, armed before the tap is told, so whoever
/// moves the clock once told moves it past the wait.
/// </summary>
internal static class TransportReconnection
{
    /// <summary>What a reconnection a cancel stopped says, whatever stopped where.</summary>
    public const string Cancelled = "the reconnection was cancelled";

    /// <summary>The attempts a transport client's reconnection makes, unless told; a broker participant's goes without end.</summary>
    public const int Attempts = 5;

    // what a reconnection waits after a failed attempt, unless told
    private static readonly TimeSpan Delay = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Holds the delay <paramref name="options"/> gives where it is given (spec 1.4): a fixed one
    /// neither zero nor from 1 to <see cref="Clocks.LongestTimer"/> milliseconds is an
    /// <see cref="ArgumentOutOfRangeException"/> naming <see cref="TransportClientReconnectOptions.Delay"/>;
    /// a resolver's answer is held at each attempt instead.
    /// </summary>
    public static void Held(TransportClientReconnectOptions options)
    {
        if (options.Delay?.Fixed is { } delay)
        {
            Clocks.AssertHeldDelay(("a delay", nameof(TransportClientReconnectOptions.Delay)), delay);
        }
    }

    /// <summary>
    /// Attempts until one opens: the first at once, each next one after its delay, the token read
    /// before each, the first included, and during each wait; an attempt under way is cut short only
    /// where <paramref name="attempt"/> reads the token it is handed. Attempts that run out, at the
    /// options' <see cref="TransportClientReconnectOptions.MaximumAttempts"/> or <see cref="Attempts"/>
    /// when none, are a <see cref="ReconnectException"/>, the last one's exception inside; a cancel is
    /// an <see cref="OperationCanceledException"/>; a delay that throws, an
    /// <see cref="InvalidOperationException"/>; one neither zero nor from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, infinite among them, an
    /// <see cref="ArgumentOutOfRangeException"/> before the tap hears it, no attempt made after it;
    /// one held is rounded to the nearest whole millisecond, which the tap hears.
    /// What the tap throws passes through, and so does an <see cref="ArgumentException"/> an attempt
    /// throws, a programmer's error no attempt after it would mend: a credential provider's value
    /// that is no field value among them.
    /// </summary>
    public static async Task Attempting(Func<CancellationToken, Task> attempt, (TransportClientReconnectOptions Options, TimeProvider Clock) reconnection)
    {
        var (reconnect, clock) = reconnection;
        var token = reconnect.CancellationToken;
        // ! resolved once: a comparison with none is false, and would attempt without end
        var maximumAttempts = reconnect.MaximumAttempts ?? Attempts;
        TimeSpan? previousDelay = null;

        for (var number = 1; ; number += 1)
        {
            // * read before each attempt, the first included: an attempt that ignores the token it is
            // handed makes none once it is cancelled
            if (token.IsCancellationRequested)
            {
                throw new OperationCanceledException(Cancelled, token);
            }

            try
            {
                await attempt(token);

                return;
            }
            catch (Exception reason) when (reason is not ArgumentException)
            {
                if (token.IsCancellationRequested)
                {
                    throw new OperationCanceledException(Cancelled, reason, token);
                }

                if (number >= maximumAttempts)
                {
                    throw new ReconnectException($"attempt {maximumAttempts} reached", reason);
                }
            }

            TimeSpan nextDelay;

            try
            {
                nextDelay = reconnect.Delay is { } delay ? delay.After(previousDelay, number) : Delay;
            }
            catch (Exception reason)
            {
                throw new InvalidOperationException(reason.Message, reason);
            }

            // held before its tap hears it: zero waits none; never, refused, would wait for ever
            // between two attempts
            nextDelay = Clocks.AssertHeldDelay(("a delay", nameof(TransportClientReconnectOptions.Delay)), nextDelay);

            using var pausing = CancellationTokenSource.CreateLinkedTokenSource(token);
            var waiting = Task.Delay(nextDelay, clock, pausing.Token);

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
