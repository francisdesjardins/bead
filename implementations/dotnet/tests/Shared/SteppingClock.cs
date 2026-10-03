using System.Diagnostics;
using System.Globalization;
using System.Runtime.ExceptionServices;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// The clock the conformance files' harnesses give the side under test (0011): a
/// <see cref="FakeTimeProvider"/> whose readings it steps from due to due, and the timers armed on
/// it, which it keeps itself — the fake fires each timer due within an advance with its readings at
/// the advance's end already, and those due at once in no order of its own. An advance settles the
/// side; takes the earliest timer live due by its end; moves both readings to its due; fires it;
/// settles; and so on; then moves the readings to its end. Timers due at once fire in the order they
/// were armed. A callback reads its own due, and a timer it arms counts from there. A periodic timer
/// fires once for each period crossed, armed again as it is taken, before its callback runs, last
/// among those armed. A due is in whole milliseconds, a fraction dropped, from 1 to
/// <see cref="Clocks.LongestTimer"/>, so an advance always ends; a period is as many, or none for a
/// timer that fires once. It refuses a timer for less or for more, and an advance within another,
/// as Bead arms none. The wall reading is the fake's, moved by a step of its own, which moves it
/// alone, forward or back.
/// </summary>
internal sealed class SteppingClock : TimeProvider
{
    // constants

    // how often a wait for a timer armed looks again, on the real clock
    private static readonly TimeSpan Polling = TimeSpan.FromMilliseconds(5);

    // the shortest a timer waits, and the shortest period it repeats by
    private static readonly TimeSpan Millisecond = TimeSpan.FromMilliseconds(1);

    // its readings, which an advance alone moves
    private readonly FakeTimeProvider _readings;

    // the timers and the readings, together: the side arms its timers from its own threads while the
    // test advances
    private readonly Lock _gate = new();

    // the timers live — armed, neither fired nor disposed — in the order they were armed
    private readonly List<SteppedTimer> _live = [];

    // how far the wall reading stands from the fake's
    private TimeSpan _wall;

    // an advance under way, which a second one would move back
    private bool _isAdvancing;

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
        ArgumentNullException.ThrowIfNull(callback);

        // its callback runs in the context it was armed in, as the system's timers run theirs
        var timer = new SteppedTimer(this, (callback, state, ExecutionContext.Capture()));

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
    /// its own, the side settled before it and after it. A callback that throws stops none of the
    /// others; the first thrown is thrown again once the advance is done. One advance at a time.
    /// </summary>
    public async Task Advance(TimeSpan by)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(by, TimeSpan.Zero);

        DateTimeOffset end;

        lock (_gate)
        {
            if (_isAdvancing)
            {
                throw new InvalidOperationException("a test clock advances once at a time: an advance within another would move it back");
            }

            _isAdvancing = true;
            end = _readings.GetUtcNow() + by;
        }

        ExceptionDispatchInfo? thrown = null;

        try
        {
            await Settle();

            while (Next(end) is { } timer)
            {
                try
                {
                    timer.Fire();
                }
                catch (Exception reason)
                {
                    thrown ??= ExceptionDispatchInfo.Capture(reason);
                }

                await Settle();
            }
        }
        finally
        {
            lock (_gate)
            {
                _isAdvancing = false;
            }
        }

        thrown?.Throw();
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
    // moved to its due, and taken off, or due a period later and last among those armed; none once
    // none is, the readings moved to the end
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

            _live.Remove(next);

            if (next.Period > TimeSpan.Zero)
            {
                next.Due += next.Period;
                _live.Add(next);
            }

            return next;
        }
    }

    // arms a timer anew, last among those armed, or disarms it for a due that is never; false once
    // it was disposed. Its arguments are checked before it is touched, as given, against what Bead
    // arms on every side (0011): a due from a millisecond to the longest timer, and a period as
    // long, or none; then each is held in whole milliseconds, a fraction dropped
    private bool Arm(SteppedTimer timer, (TimeSpan Due, TimeSpan Period) arming)
    {
        var (due, period) = arming;
        var isOnce = period == TimeSpan.Zero || period == Timeout.InfiniteTimeSpan;

        foreach (var (time, isArmed) in new[] { (due, due != Timeout.InfiniteTimeSpan), (period, !isOnce) })
        {
            if (isArmed && !IsHeld(time))
            {
                throw new ArgumentOutOfRangeException(
                    nameof(arming),
                    string.Create(CultureInfo.InvariantCulture, $"a test clock arms a timer for 1 to {Clocks.LongestTimer.TotalMilliseconds} milliseconds, as Bead does, not {time.TotalMilliseconds}"));
            }
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

            timer.Due = _readings.GetUtcNow() + WholeOf(due);
            timer.Period = isOnce ? TimeSpan.Zero : WholeOf(period);
            _live.Add(timer);

            return true;
        }
    }

    // a due or a period a timer takes: from a millisecond to the longest timer
    private static bool IsHeld(TimeSpan time)
    {
        return time >= Millisecond && time <= Clocks.LongestTimer;
    }

    // a time in whole milliseconds, a fraction dropped, as the system's timers read it
    private static TimeSpan WholeOf(TimeSpan time)
    {
        return TimeSpan.FromTicks(time.Ticks - (time.Ticks % TimeSpan.TicksPerMillisecond));
    }

    // takes a timer off for good: a change after it arms nothing
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
    private sealed class SteppedTimer(SteppingClock clock, (TimerCallback Callback, object? State, ExecutionContext? Context) fired) : ITimer
    {
        public DateTimeOffset Due { get; set; }

        public TimeSpan Period { get; set; }

        public bool IsDisposed { get; set; }

        public void Fire()
        {
            if (fired.Context is not { } context)
            {
                fired.Callback(fired.State);

                return;
            }

            ExecutionContext.Run(
                context,
                (_) =>
                {
                    fired.Callback(fired.State);
                },
                null);
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
