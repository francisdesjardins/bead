using System.Diagnostics;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// The clock the conformance files' harnesses give the side under test (0011): a
/// <see cref="FakeTimeProvider"/> whose readings it steps from due to due, and the timers armed on
/// it, which it keeps itself — the fake fires each timer due within an advance with its readings at
/// the advance's end already, and those due at once in no order of its own. An advance settles the
/// side; takes the earliest timer live due by its end, the first armed among those due at once;
/// moves both readings to its due; fires it; settles; and so on; then moves the readings to its
/// end. A callback reads its own due, a periodic timer fires once for each period crossed, and a
/// timer due now fires at the next advance. The wall reading is the fake's, moved by a step of its
/// own, which moves it alone, forward or back.
/// </summary>
internal sealed class SteppingClock : TimeProvider
{
    // constants

    // how often a wait for a timer armed looks again, on the real clock
    private static readonly TimeSpan Polling = TimeSpan.FromMilliseconds(5);

    // its readings, which an advance alone moves
    private readonly FakeTimeProvider _readings;

    // the timers and the readings, together: the side arms its timers from its own threads while the
    // test advances
    private readonly Lock _gate = new();

    // the timers live — armed, neither fired nor disposed — in the order they were armed
    private readonly List<SteppedTimer> _live = [];

    // how far the wall reading stands from the fake's
    private TimeSpan _wall;

    /// <summary>A clock whose wall reading starts at <paramref name="wallClock"/>.</summary>
    public SteppingClock(DateTimeOffset wallClock)
    {
        _readings = new FakeTimeProvider(wallClock);
    }

    /// <summary>What settles the side on it: done once the side did all it can without the clock moving.</summary>
    public Func<Task> Settle { get; init; } = () =>
    {
        return Task.CompletedTask;
    };

    /// <inheritdoc/>
    public override long TimestampFrequency
    {
        get
        {
            return _readings.TimestampFrequency;
        }
    }

    /// <inheritdoc/>
    public override DateTimeOffset GetUtcNow()
    {
        lock (_gate)
        {
            return _readings.GetUtcNow() + _wall;
        }
    }

    /// <inheritdoc/>
    public override long GetTimestamp()
    {
        lock (_gate)
        {
            return _readings.GetTimestamp();
        }
    }

    /// <inheritdoc/>
    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new SteppedTimer(this, (callback, state));

        timer.Change(dueTime, period);

        return timer;
    }

    /// <summary>How far each timer live is due from now, in the order they were armed.</summary>
    public IReadOnlyList<TimeSpan> Dues()
    {
        lock (_gate)
        {
            var now = _readings.GetUtcNow();

            return [.. _live.Select((timer) =>
            {
                return timer.Due - now;
            })];
        }
    }

    /// <summary>
    /// Waits, on the real clock and for <paramref name="patience"/> at most, for a timer live due
    /// exactly <paramref name="due"/> from now; gives the dues it saw last.
    /// </summary>
    public async Task<IReadOnlyList<TimeSpan>> UntilArmed(TimeSpan due, TimeSpan patience)
    {
        var watch = Stopwatch.StartNew();
        var dues = Dues();

        while (!dues.Contains(due) && watch.Elapsed < patience)
        {
            await Task.Delay(Polling, TestContext.Current.CancellationToken);
            dues = Dues();
        }

        return dues;
    }

    /// <summary>
    /// Steps both readings <paramref name="by"/>, from due to due: each timer due within fires at
    /// its own, the side settled before it and after it.
    /// </summary>
    public async Task Advance(TimeSpan by)
    {
        DateTimeOffset end;

        lock (_gate)
        {
            end = _readings.GetUtcNow() + by;
        }

        await Settle();

        while (Next(end) is { } timer)
        {
            timer.Fire();
            await Settle();
        }
    }

    /// <summary>Moves the wall reading alone <paramref name="by"/>, forward or back: the monotonic one and the timers stay.</summary>
    public void Wall(TimeSpan by)
    {
        lock (_gate)
        {
            _wall += by;
        }
    }

    // the earliest timer live due by the end, the first armed among those due at once, its readings
    // moved to its due, and taken off, or due a period later; none once none is, the readings moved
    // to the end
    private SteppedTimer? Next(DateTimeOffset end)
    {
        lock (_gate)
        {
            SteppedTimer? next = null;

            foreach (var timer in _live)
            {
                if (timer.Due <= end && (next is null || timer.Due < next.Due))
                {
                    next = timer;
                }
            }

            _readings.SetUtcNow(next?.Due ?? end);

            if (next is null)
            {
                return null;
            }

            if (next.Period > TimeSpan.Zero)
            {
                next.Due += next.Period;
            }
            else
            {
                _live.Remove(next);
            }

            return next;
        }
    }

    // arms a timer anew, last among those armed, or disarms it for a due that is never; false once
    // it was disposed
    private bool Arm(SteppedTimer timer, (TimeSpan Due, TimeSpan Period) arming)
    {
        var (due, period) = arming;

        if ((due < TimeSpan.Zero && due != Timeout.InfiniteTimeSpan) || (period < TimeSpan.Zero && period != Timeout.InfiniteTimeSpan))
        {
            throw new ArgumentOutOfRangeException(nameof(arming), $"a timer is due in no negative time, nor repeats every one: {due}, {period}");
        }

        lock (_gate)
        {
            if (timer.IsDisposed)
            {
                return false;
            }

            _live.Remove(timer);

            if (due == Timeout.InfiniteTimeSpan)
            {
                return true;
            }

            timer.Due = _readings.GetUtcNow() + due;
            timer.Period = period == Timeout.InfiniteTimeSpan ? TimeSpan.Zero : period;
            _live.Add(timer);

            return true;
        }
    }

    private void Drop(SteppedTimer timer)
    {
        lock (_gate)
        {
            timer.IsDisposed = true;
            _live.Remove(timer);
        }
    }

    // a timer armed on it: its due, on the fake's reading, and its period, none for a timer that
    // fires once; touched under its clock's gate
    private sealed class SteppedTimer(SteppingClock clock, (TimerCallback Callback, object? State) fired) : ITimer
    {
        public DateTimeOffset Due { get; set; }

        public TimeSpan Period { get; set; }

        public bool IsDisposed { get; set; }

        public void Fire()
        {
            fired.Callback(fired.State);
        }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            return clock.Arm(this, (dueTime, period));
        }

        public void Dispose()
        {
            clock.Drop(this);
        }

        public ValueTask DisposeAsync()
        {
            Dispose();

            return ValueTask.CompletedTask;
        }
    }
}
