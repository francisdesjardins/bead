namespace Bead.Tests;

/// <summary><see cref="DebugStatistics"/>: the durations a manager's debug events carry, summed up.</summary>
public sealed class DebugStatisticsTests
{
    // helpers

    // a debug event that took a duration, going a direction
    private static DebugEvent EventOf(long? duration, DebugDirection direction = DebugDirection.Rx)
    {
        return new DebugEvent
        {
            Direction = direction,
            ProcedureId = 1,
            ProcedureName = "echo",
            ServiceId = 2,
            ServiceRevision = 1,
            Timestamp = new DebugTimestamp(duration, 0),
            Type = DebugType.Request,
        };
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

        foreach (var duration in new long?[] { 30, null, 10, 20, -5, 40 })
        {
            statistics.Listener(null, EventOf(duration));
        }

        Assert.Equal(new DurationSummary(4, 40, 25, 25, 10), statistics.Durations());

        statistics.Listener(null, EventOf(5));

        Assert.Equal((5, 20.0), (statistics.Durations().Count, statistics.Durations().Median));
    }

    [Fact]
    public void Keeps_the_last_size_durations_alone_the_oldest_leaving_first()
    {
        var statistics = new DebugStatistics(new DebugStatisticsOptions { Size = 3 });

        foreach (var duration in new long[] { 100, 1, 2, 3, 4 })
        {
            statistics.Listener(null, EventOf(duration));
        }

        Assert.Equal(new DurationSummary(3, 4, 3, 3, 2), statistics.Durations());
    }

    [Fact]
    public void Forgets_every_duration_on_clear_and_keeps_recording_after()
    {
        var statistics = new DebugStatistics(new DebugStatisticsOptions { Size = 3 });

        // cleared part way through, so the next is written at the start again
        statistics.Listener(null, EventOf(10));
        statistics.Listener(null, EventOf(20));
        statistics.Clear();
        statistics.Listener(null, EventOf(7));

        Assert.Equal(new DurationSummary(1, 7, 7, 7, 7), statistics.Durations());
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

        listener(null, EventOf(10, DebugDirection.Rx));
        listener(null, EventOf(99, DebugDirection.Tx));

        Assert.Equal(new DurationSummary(1, 10, 10, 10, 10), statistics.Durations());
    }
}
