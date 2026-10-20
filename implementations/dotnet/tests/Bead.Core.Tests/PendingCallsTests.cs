using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="PendingCalls"/>: the calls a side waits on, the call ids it reserved, and what leaves
/// with each.
/// </summary>
public sealed class PendingCallsTests
{
    // helpers

    // a request waiting, which settles nowhere a test reads
    private static PendingRequest RequestOf()
    {
        return new PendingRequest
        {
            DestinationId = null,
            MaximumPayloadBytes = 1_024,
            ProcedureAddress = new ProcedureAddress(2, 1),
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }

    private static PendingCalls CallsOf(RouterSide side, PendingCallsOptions? options = null)
    {
        return new PendingCalls(side, options ?? OptionsOf(new FakeTimeProvider()));
    }

    private static PendingCallsOptions OptionsOf(TimeProvider time)
    {
        return new PendingCallsOptions
        {
            IsCallIdInUse = (_, _) =>
            {
                return false;
            },
            Post = (action) =>
            {
                action();
            },
            Clock = time,
        };
    }

    // definition

    [Fact]
    public void Draws_call_ids_of_its_side_skipping_those_waited_on_reserved_or_in_use_by_the_side()
    {
        var client = CallsOf(RouterSide.Client, OptionsOf(new FakeTimeProvider()) with
        {
            IsCallIdInUse = (callId, _) =>
            {
                return callId is 5;
            },
            LastCallId = 9,
        });
        var server = CallsOf(RouterSide.Server);

        client.Add(new CallAddress(1, "a"), RequestOf());
        client.Reserve(new CallAddress(3, "a"), TimeSpan.FromSeconds(5));
        Assert.Equal([7u, 9u, 7u], new[] { client.Draw("a"), client.Draw("a"), client.Draw("a") });

        // another connection waits on nothing, and reserved nothing
        Assert.Equal(9u, client.Draw("b"));
        Assert.Equal([2u, 4u], new[] { server.Draw("a"), server.Draw("a") });
    }

    [Fact]
    public void Forgets_a_call_only_while_it_is_the_request_given_when_one_is()
    {
        var calls = CallsOf(RouterSide.Client);
        var call = new CallAddress(1, "a");
        var waiting = RequestOf();

        calls.Add(call, waiting);
        calls.Forget(call, RequestOf());
        Assert.Same(waiting, calls.Get(call));
        calls.Forget(call, waiting);
        calls.Forget(call);
        Assert.Null(calls.Get(call));
    }

    [Fact]
    public void Reserves_a_call_id_until_its_timer_fires_the_later_end_of_two_standing()
    {
        var time = new RouterCoreTests.RequesterClock();
        var calls = CallsOf(RouterSide.Client, OptionsOf(time));

        calls.Reserve(new CallAddress(1, "a"), TimeSpan.FromMilliseconds(40));
        calls.Reserve(new CallAddress(1, "a"), TimeSpan.FromMilliseconds(10));
        calls.Reserve(new CallAddress(3, "a"), TimeSpan.FromMilliseconds(10));
        calls.Reserve(new CallAddress(3, "a"), TimeSpan.FromMilliseconds(40));
        Assert.Equal([TimeSpan.FromMilliseconds(40), TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(40)], time.Armed.Select((timer) => { return timer.Delay; }));
        Assert.Equal([time.Armed[1]], time.Armed.Where((timer) => { return timer.IsCleared; }));
        Assert.Equal((true, true, false), (calls.IsReserved(1, "a"), calls.IsReserved(3, "a"), calls.IsReserved(1, "b")));

        // the timer replaced frees nothing
        time.Advance(TimeSpan.FromMilliseconds(10));
        Assert.Equal((true, true), (calls.IsReserved(1, "a"), calls.IsReserved(3, "a")));
        time.Advance(TimeSpan.FromMilliseconds(29));
        Assert.Equal((true, true), (calls.IsReserved(1, "a"), calls.IsReserved(3, "a")));
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal((false, false), (calls.IsReserved(1, "a"), calls.IsReserved(3, "a")));
    }

    [Fact]
    public void Refuses_a_reservation_longer_than_a_timer_holds_or_under_a_millisecond_and_reserves_nothing()
    {
        var time = new FakeTimeProvider();
        var calls = CallsOf(RouterSide.Client, OptionsOf(time));

        // 2³¹ ms, one past what JavaScript's timers hold
        foreach (var timeout in new[] { Clocks.LongestTimer + TimeSpan.FromMilliseconds(1), TimeSpan.FromMilliseconds(0.5) })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                calls.Reserve(new CallAddress(1, "a"), timeout);
            });
        }

        Assert.False(calls.IsReserved(1, "a"));

        calls.Reserve(new CallAddress(1, "a"), Clocks.LongestTimer);
        calls.Reserve(new CallAddress(3, "a"), TimeSpan.FromMilliseconds(1));
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal((true, false), (calls.IsReserved(1, "a"), calls.IsReserved(3, "a")));
        time.Advance(Clocks.LongestTimer - TimeSpan.FromMilliseconds(2));
        Assert.True(calls.IsReserved(1, "a"));
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.False(calls.IsReserved(1, "a"));
    }

    // a deadline of its own: a wall clock that leaps an hour at each reading moves no reservation
    [Fact]
    public void Keeps_the_later_end_of_two_reservations_by_the_monotonic_reading_never_the_wall_clock()
    {
        var time = new FakeTimeProvider();
        var calls = CallsOf(RouterSide.Client, OptionsOf(new LeapingClock(time)));

        calls.Reserve(new CallAddress(1, "a"), TimeSpan.FromMilliseconds(40));
        calls.Reserve(new CallAddress(1, "a"), TimeSpan.FromMilliseconds(10));
        time.Advance(TimeSpan.FromMilliseconds(39));
        Assert.True(calls.IsReserved(1, "a"));
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.False(calls.IsReserved(1, "a"));
    }

    // -1 ms is .NET's infinite: a call that waited without end
    [Theory]
    [InlineData(null)]
    [InlineData(-1L)]
    public void Reserves_a_call_id_5_s_when_its_call_gave_no_time_or_waited_without_end(long? milliseconds)
    {
        var time = new FakeTimeProvider();
        var calls = CallsOf(RouterSide.Client, OptionsOf(time));

        calls.Reserve(new CallAddress(1, "a"), milliseconds is { } given ? TimeSpan.FromMilliseconds(given) : null);
        time.Advance(TimeSpan.FromSeconds(4.9));
        Assert.True(calls.IsReserved(1, "a"));
        time.Advance(TimeSpan.FromSeconds(0.1));
        Assert.False(calls.IsReserved(1, "a"));
    }

    [Fact]
    public void Takes_out_every_call_of_a_connection_or_of_every_one_freeing_the_call_ids_it_reserved()
    {
        var calls = CallsOf(RouterSide.Client);
        var first = RequestOf();
        var second = RequestOf();

        calls.Add(new CallAddress(1, "a"), first);
        calls.Add(new CallAddress(1, "b"), second);
        calls.Reserve(new CallAddress(3, "a"), TimeSpan.FromSeconds(5));
        Assert.Equal([first], calls.TakeAll("a"));
        Assert.False(calls.IsReserved(3, "a"));
        Assert.Same(second, calls.Get(new CallAddress(1, "b")));
        Assert.Equal([second], calls.TakeAll(null));
        Assert.Empty(calls.TakeAll(null));

        // nothing is settled: the caller rejects what it took
        Assert.False(first.Task.IsCompleted || second.Task.IsCompleted);
    }

    [Fact]
    public void Count_the_calls_waited_on_and_the_call_ids_reserved_and_the_connections_they_belong_to()
    {
        var calls = CallsOf(RouterSide.Client);

        calls.Add(new CallAddress(1, "a"), RequestOf());
        calls.Add(new CallAddress(3, "a"), RequestOf());
        calls.Reserve(new CallAddress(5, "b"), TimeSpan.FromSeconds(5));
        Assert.Equal(["a", "b"], calls.Gauges().ConnectionHandles.Order());
        Assert.Equal(new Dictionary<string, long> { ["pendingCalls"] = 2, ["reservedCallIds"] = 1 }, calls.Gauges().Counts);
        calls.TakeAll(null);
        Assert.Empty(calls.Gauges().ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["pendingCalls"] = 0, ["reservedCallIds"] = 0 }, calls.Gauges().Counts);
    }

    [Fact]
    public void Hears_each_call_leave_once_whichever_way_it_leaves()
    {
        var removed = new List<PendingRequest>();
        var calls = CallsOf(RouterSide.Client, OptionsOf(new FakeTimeProvider()) with { OnRemove = removed.Add });

        PendingRequest Add(uint callId, string connectionHandle)
        {
            var pendingRequest = RequestOf();

            calls.Add(new CallAddress(callId, connectionHandle), pendingRequest);

            return pendingRequest;
        }

        var first = Add(1, "a");

        // another request takes nothing out
        calls.Forget(new CallAddress(1, "a"), RequestOf());
        calls.Forget(new CallAddress(1, "a"), first);
        calls.Forget(new CallAddress(1, "a"), first);

        var second = Add(3, "a");

        calls.Forget(new CallAddress(3, "a"));
        Assert.Equal([first, second], removed);

        var third = Add(5, "a");
        var fourth = Add(7, "b");

        calls.TakeAll("a");
        Assert.Equal([first, second, third], removed);
        calls.TakeAll(null);
        Assert.Equal([first, second, third, fourth], removed);
    }

    // the test's clock, its wall reading an hour later at each reading, as a clock set by hand moves
    private sealed class LeapingClock(TimeProvider clock) : TimeProvider
    {
        private long _readings;

        public override long TimestampFrequency
        {
            get
            {
                return clock.TimestampFrequency;
            }
        }

        public override DateTimeOffset GetUtcNow()
        {
            return clock.GetUtcNow() + TimeSpan.FromHours(Interlocked.Increment(ref _readings));
        }

        public override long GetTimestamp()
        {
            return clock.GetTimestamp();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            return clock.CreateTimer(callback, state, dueTime, period);
        }
    }
}
