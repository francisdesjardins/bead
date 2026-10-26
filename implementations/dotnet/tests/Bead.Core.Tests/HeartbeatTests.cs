using System.Diagnostics;

namespace Bead.Tests;

/// <summary>
/// A broker connection's heartbeat (spec 15.21), the twin of the TypeScript side's: on the
/// platform's timer, in real time, whatever clock the side is given (0011).
/// </summary>
public sealed class HeartbeatTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static async Task Until(Func<bool> holds)
    {
        var watch = Stopwatch.StartNew();

        while (!holds() && watch.Elapsed < Patience)
        {
            await Task.Delay(5, Cancelled);
        }
    }

    [Fact]
    public async Task Pings_a_connection_silent_for_its_heartbeat_on_the_platform_s_timer_and_drops_one_that_answered_nothing_by_the_next()
    {
        var beat = TimeSpan.FromMilliseconds(200);
        var (pings, drops) = (0, 0);
        var watch = Stopwatch.StartNew();
        var heartbeat = new Heartbeat(beat, new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref pings);
            },
            Drop = () =>
            {
                Interlocked.Increment(ref drops);
            },
        });

        // silent for a heartbeat: pinged, no sooner
        await Until(() =>
        {
            return Volatile.Read(ref pings) == 1;
        });
        Assert.Equal(1, Volatile.Read(ref pings));
        Assert.True(watch.Elapsed >= beat - TimeSpan.FromMilliseconds(20), $"pinged at {watch.Elapsed}");

        // answered nothing by the next: dropped, and beats no more
        await Until(() =>
        {
            return Volatile.Read(ref drops) == 1;
        });
        await Task.Delay(beat * 3, Cancelled);
        Assert.Equal((1, 1), (pings, drops));

        // a connection heard from every tenth of its heartbeat is never pinged: a margin a loaded run
        // keeps, as the WebSocket's heartbeat tests wait theirs within a patience
        var heard = 0;
        var talking = new Heartbeat(beat * 10, new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref heard);
            },
            Drop = () =>
            {
                Interlocked.Increment(ref heard);
            },
        });

        for (var index = 0; index < 10; index += 1)
        {
            await Task.Delay(beat, Cancelled);
            talking.Heard();
        }

        talking.Stop();
        Assert.Equal(0, heard);

        // without end, it arms nothing
        var never = new Heartbeat(Timeout.InfiniteTimeSpan, new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref heard);
            },
            Drop = () =>
            {
                Interlocked.Increment(ref heard);
            },
        });

        await Task.Delay(beat * 2, Cancelled);
        never.Stop();
        Assert.Equal(0, heard);
    }

    [Fact]
    public async Task Beats_no_more_once_its_own_ping_stopped_it()
    {
        var (pings, drops) = (0, 0);
        Heartbeat? heartbeat = null;

        // * a ping that ends its connection, as one past what may wait for its broker does
        heartbeat = new Heartbeat(TimeSpan.FromMilliseconds(100), new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref pings);
                heartbeat?.Stop();
            },
            Drop = () =>
            {
                Interlocked.Increment(ref drops);
            },
        });

        await Until(() =>
        {
            return Volatile.Read(ref pings) == 1;
        });
        await Task.Delay(TimeSpan.FromMilliseconds(300), Cancelled);
        Assert.Equal((1, 0), (pings, drops));
    }
}
