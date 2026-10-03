namespace Bead.Tests;

/// <summary><see cref="DebugStatistics"/>: the durations a manager's debug events carry, summed up.</summary>
public sealed class DebugStatisticsTests
{
    // helpers

    // a debug event that took a duration, going a direction
    private static DebugEvent EventOf(TimeSpan? duration, DebugDirection direction = DebugDirection.Rx)
    {
        return new DebugEvent
        {
            Direction = direction,
            Duration = duration,
            ProcedureId = 1,
            ProcedureName = "echo",
            ServiceId = 2,
            ServiceRevision = 1,
            StartedAt = DateTimeOffset.UnixEpoch,
            Type = DebugType.Request,
        };
    }

    // a duration of so many milliseconds
    private static TimeSpan Milliseconds(long milliseconds)
    {
        return TimeSpan.FromMilliseconds(milliseconds);
    }

    // definition

    [Fact]
    public void Keeps_the_last_thousand_durations_by_default()
    {
        Assert.Equal(1_000, DebugStatisticsOptions.Default.Size);
        Assert.Equal(1_000, new DebugStatisticsOptions().Size);
    }

    [Fact]
    public void Says_nothing_of_durations_it_has_none_of_rather_than_infinities()
    {
        Assert.Equal(new DurationSummary(0, null, null, null, null), new DebugStatistics().Durations());
    }

    [Fact]
    public void Sums_up_the_durations_recorded_and_passes_over_a_step_that_carries_none()
    {
        var statistics = new DebugStatistics();

        foreach (var duration in new TimeSpan?[] { Milliseconds(30), null, Milliseconds(10), Milliseconds(20), Milliseconds(-5), Milliseconds(40) })
        {
            statistics.Listener(null, EventOf(duration));
        }

        Assert.Equal(
            new DurationSummary(4, Milliseconds(40), Milliseconds(25), Milliseconds(25), Milliseconds(10)),
            statistics.Durations());

        statistics.Listener(null, EventOf(Milliseconds(5)));

        Assert.Equal((5, (TimeSpan?)Milliseconds(20)), (statistics.Durations().Count, statistics.Durations().Median));
    }

    [Fact]
    public void Keeps_the_last_size_durations_alone_the_oldest_leaving_first()
    {
        var statistics = new DebugStatistics(new DebugStatisticsOptions { Size = 3 });

        foreach (var duration in new long[] { 100, 1, 2, 3, 4 })
        {
            statistics.Listener(null, EventOf(Milliseconds(duration)));
        }

        Assert.Equal(
            new DurationSummary(3, Milliseconds(4), Milliseconds(3), Milliseconds(3), Milliseconds(2)),
            statistics.Durations());
    }

    [Fact]
    public void Forgets_every_duration_on_clear_and_keeps_recording_after()
    {
        var statistics = new DebugStatistics(new DebugStatisticsOptions { Size = 3 });

        // cleared part way through, so the next is written at the start again
        statistics.Listener(null, EventOf(Milliseconds(10)));
        statistics.Listener(null, EventOf(Milliseconds(20)));
        statistics.Clear();
        statistics.Listener(null, EventOf(Milliseconds(7)));

        Assert.Equal(
            new DurationSummary(1, Milliseconds(7), Milliseconds(7), Milliseconds(7), Milliseconds(7)),
            statistics.Durations());
    }

    [Fact]
    public void Refuses_a_size_that_is_not_a_whole_number_of_durations_above_0()
    {
        foreach (var size in new[] { 0, -1 })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return new DebugStatistics(new DebugStatisticsOptions { Size = size });
            });
        }
    }

    [Fact]
    public void Counts_one_side_of_the_calls_alone_through_a_debug_filter()
    {
        var statistics = new DebugStatistics();
        var listener = DebugFilters.FilterDebug(statistics.Listener, "d(rx)");

        listener(null, EventOf(Milliseconds(10), DebugDirection.Rx));
        listener(null, EventOf(Milliseconds(99), DebugDirection.Tx));

        Assert.Equal(
            new DurationSummary(1, Milliseconds(10), Milliseconds(10), Milliseconds(10), Milliseconds(10)),
            statistics.Durations());
    }
}
