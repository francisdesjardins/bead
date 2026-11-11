using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>The shared reconnection loop's defaults.</summary>
public sealed class TransportReconnectionTests
{
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
