namespace Bead;

/// <summary>How many durations debug statistics keep, unless told otherwise.</summary>
public sealed record DebugStatisticsOptions
{
    /// <summary>The options statistics are made with when given none: the last 1000 durations.</summary>
    public static DebugStatisticsOptions Default { get; } = new();

    /// <summary>How many durations are kept, the last ones; above 0.</summary>
    public int Size { get; init; } = 1_000;
}

/// <summary>How long the calls recorded took, in milliseconds; each measure none while none is.</summary>
/// <param name="Count">How many durations were recorded.</param>
/// <param name="Maximum">The longest.</param>
/// <param name="Mean">Their mean.</param>
/// <param name="Median">The middle one, or the mean of the two middle ones.</param>
/// <param name="Minimum">The shortest.</param>
public readonly record struct DurationSummary(int Count, long? Maximum, double? Mean, double? Median, long? Minimum);

/// <summary>
/// The durations of the last calls, from the debug events that carry one: a call's answer on the
/// side that asked — its round trip — and an answer on the side that resolved it — its handling.
/// The oldest leaves as each new one comes, past its size.
/// </summary>
/// <example>
/// <code>
/// var statistics = new DebugStatistics();
///
/// manager.Debug += DebugFilters.FilterDebug(statistics.Listener, "d(rx)");
/// Console.WriteLine(statistics.Durations().Median);
/// </code>
/// </example>
public sealed class DebugStatistics
{
    private readonly Lock _gate = new();

    // the last durations, the next one written over the oldest once full
    private readonly List<long> _durations = [];
    private readonly int _size;
    private int _next;

    /// <summary>Statistics of the last durations their options keep; a size not above 0 is an <see cref="ArgumentOutOfRangeException"/>.</summary>
    public DebugStatistics(DebugStatisticsOptions? options = null)
    {
        _size = (options ?? DebugStatisticsOptions.Default).Size;
        ArgumentOutOfRangeException.ThrowIfLessThan(_size, 1, "debug statistics keep a whole number of durations, above 0");
        Listener = Record;
    }

    /// <summary>
    /// What records each duration a debug event carries, for a manager's <c>Debug</c> — through
    /// <see cref="DebugFilters.FilterDebug(Action{Exception?, DebugEvent}, string)"/>, to count one
    /// side's calls alone. It never throws.
    /// </summary>
    public Action<Exception?, DebugEvent> Listener { get; }

    /// <summary>Forgets every duration recorded.</summary>
    public void Clear()
    {
        lock (_gate)
        {
            _durations.Clear();
            _next = 0;
        }
    }

    /// <summary>The durations recorded, summed up.</summary>
    public DurationSummary Durations()
    {
        long[] durations;

        lock (_gate)
        {
            durations = [.. _durations];
        }

        var count = durations.Length;

        if (count == 0)
        {
            return new DurationSummary(0, null, null, null, null);
        }

        Array.Sort(durations);

        // the middle one, or the mean of the two middle ones: the same one twice, for an odd count
        var median = (durations[((count + 1) / 2) - 1] + durations[count / 2]) / 2.0;

        return new DurationSummary(count, durations[^1], durations.Average(), median, durations[0]);
    }

    private void Record(Exception? error, DebugEvent debugEvent)
    {
        // a step that has not answered carries none
        if (debugEvent?.Timestamp.Duration is not { } duration || duration < 0)
        {
            return;
        }

        lock (_gate)
        {
            if (_durations.Count < _size)
            {
                _durations.Add(duration);
            }
            else
            {
                _durations[_next] = duration;
            }

            _next = (_next + 1) % _size;
        }
    }
}
