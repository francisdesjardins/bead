using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>The shared reconnection loop's defaults.</summary>
public sealed class TransportReconnectionTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task Waits_each_delay_on_its_clock_telling_its_tap_first_and_gives_up_past_its_attempts_the_last_failure_its_cause()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        var attempts = 0;
        var taps = new List<(TimeSpan Delay, int Attempt)>();
        var reconnecting = TransportReconnection.Attempting((_) =>
        {
            attempts += 1;
            return Task.FromException(new ConnectException($"refused {attempts}"));
        }, (new TransportClientReconnectOptions
        {
            MaximumAttempts = 3,
            Delay = new TransportClientReconnectDelay((previous, attempt) =>
            {
                return (previous ?? TimeSpan.Zero) + TimeSpan.FromMilliseconds(attempt * 10);
            }),
            Tap = (delay, attempt) =>
            {
                taps.Add((delay, attempt));
            },
        }, clock));

        foreach (var (attempt, milliseconds) in new[] { (1, 10), (2, 30) })
        {
            var delay = TimeSpan.FromMilliseconds(milliseconds);
            Assert.Equal([delay], await clock.UntilArmed(delay, Patience));
            Assert.Equal(attempt, attempts);
            Assert.Equal((delay, attempt), taps[^1]);
            await clock.Advance(delay);
        }

        var failure = await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnecting.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal("attempt 3 reached", failure.Message);
        Assert.Equal("refused 3", Assert.IsType<ConnectException>(failure.InnerException).Message);
        Assert.Equal(3, attempts);
        Assert.Equal([(TimeSpan.FromMilliseconds(10), 1), (TimeSpan.FromMilliseconds(30), 2)], taps);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Reads_its_signal_before_each_attempt_the_first_included_and_hands_it_to_each()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        var signals = new List<CancellationToken>();
        var failure = await Assert.ThrowsAsync<OperationCanceledException>(() =>
        {
            return TransportReconnection.Attempting((token) =>
            {
                signals.Add(token);
                return Task.CompletedTask;
            }, (new TransportClientReconnectOptions
            {
                Delay = new TransportClientReconnectDelay(TimeSpan.Zero),
                MaximumAttempts = 5,
                CancellationToken = cancelled.Token,
            }, clock));
        });
        Assert.Equal(TransportReconnection.Cancelled, failure.Message);
        Assert.Equal(cancelled.Token, failure.CancellationToken);
        Assert.Empty(signals);

        using var cancelling = new CancellationTokenSource();
        failure = await Assert.ThrowsAsync<OperationCanceledException>(() =>
        {
            return TransportReconnection.Attempting((token) =>
            {
                signals.Add(token);
                return Task.FromException(new ConnectException("refused 1"));
            }, (new TransportClientReconnectOptions
            {
                Delay = new TransportClientReconnectDelay(TimeSpan.FromMinutes(1)),
                MaximumAttempts = 5,
                CancellationToken = cancelling.Token,
                Tap = (_, _) =>
                {
                    cancelling.Cancel();
                },
            }, clock)).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal(TransportReconnection.Cancelled, failure.Message);
        Assert.Equal(cancelling.Token, failure.CancellationToken);
        Assert.Equal(cancelling.Token, Assert.Single(signals));
        Assert.True(signals[0].IsCancellationRequested);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Ends_at_once_on_a_misuse_an_attempt_meets_a_functions_answer_out_of_bounds_or_what_its_tap_throws()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        var attempts = 0;
        var misuse = new ArgumentException("a misuse");
        var failure = await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return TransportReconnection.Attempting((_) =>
            {
                attempts += 1;
                return Task.FromException(misuse);
            }, (new TransportClientReconnectOptions
            {
                Delay = new TransportClientReconnectDelay(TimeSpan.Zero),
                MaximumAttempts = int.MaxValue,
            }, clock));
        });
        Assert.Same(misuse, failure);
        Assert.Equal(1, attempts);

        attempts = 0;
        var taps = 0;
        var bounds = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
        {
            return TransportReconnection.Attempting((_) =>
            {
                attempts += 1;
                return Task.FromException(new ConnectException("refused 1"));
            }, (new TransportClientReconnectOptions
            {
                Delay = new TransportClientReconnectDelay((_, _) =>
                {
                    return Timeout.InfiniteTimeSpan;
                }),
                MaximumAttempts = int.MaxValue,
                Tap = (_, _) =>
                {
                    taps += 1;
                },
            }, clock));
        });
        Assert.Equal("Delay", bounds.ParamName);
        Assert.Equal(1, attempts);
        Assert.Equal(0, taps);

        attempts = 0;
        var thrown = new InvalidOperationException("its tap broke");
        var tapFailure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return TransportReconnection.Attempting((_) =>
            {
                attempts += 1;
                return Task.FromException(new ConnectException("refused 1"));
            }, (new TransportClientReconnectOptions
            {
                Delay = new TransportClientReconnectDelay(TimeSpan.FromSeconds(1)),
                MaximumAttempts = int.MaxValue,
                Tap = (_, _) =>
                {
                    throw thrown;
                },
            }, clock));
        });
        Assert.Same(thrown, tapFailure);
        Assert.Equal(1, attempts);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Reconnects_five_times_a_second_apart_by_default()
    {
        var clock = new FakeTimeProvider();
        var attempts = 0;
        var waits = new List<TimeSpan>();
        var defaults = new TransportClientReconnectOptions();

        Assert.Null(defaults.MaximumAttempts);
        Assert.Null(defaults.Delay);
        Assert.Null(defaults.Tap);
        Assert.False(defaults.CancellationToken.CanBeCanceled);
        Assert.Equal(5, TransportReconnection.Attempts);

        var reconnecting = TransportReconnection.Attempting((_) =>
        {
            attempts += 1;

            return Task.FromException(new IOException("refused"));
        }, (defaults with
        {
            Tap = (delay, _) =>
            {
                waits.Add(delay);
                clock.Advance(delay);
            },
        }, clock));

        Assert.Equal("attempt 5 reached", (await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnecting;
        })).Message);
        Assert.Equal(5, attempts);
        Assert.Equal(Enumerable.Repeat(TimeSpan.FromSeconds(1), 4), waits);
    }
}
