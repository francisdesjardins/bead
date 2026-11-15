using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="ReceivingTransfers"/>: the budget the transfers a router receives share, the places
/// they take on their connection, the credit they grant, and how long each waits.
/// </summary>
public sealed class ReceivingTransfersTests
{
    // helpers

    // receiving transfers under limits, their chunks before the last of a byte, exactly, which record
    // each credit they send
    private static (List<string> Credits, ReceivingTransfers Receiving, FakeTimeProvider Time) ReceivingOf(RouterLimits limits, FakeTimeProvider? clock = null)
    {
        var credits = new List<string>();
        var time = clock ?? new FakeTimeProvider();
        var receiving = new ReceivingTransfers(new ReceivingTransfersOptions
        {
            Limits = limits,
            PayloadBytesPerChunk = 1,
            Post = (action) =>
            {
                action();
            },
            SendCredit = (call, creditEnd) =>
            {
                credits.Add($"{call.ConnectionHandle} {call.CallId} {creditEnd}");
            },
            Clock = time,
        });

        return (credits, receiving, time);
    }

    // the limits by default, with a window of 16 bytes and the transfers this side will take by default
    private static RouterLimits LimitsOf()
    {
        return RouterLimits.Default with { MaximumTransfers = 4, WindowBytes = 16 };
    }

    // the transfer opened, failing the test when it is refused
    private static Receiving OpenedOf((Receiving? Receiving, Failure? Refusal) opened)
    {
        Assert.Null(opened.Refusal);

        return opened.Receiving!;
    }

    private static (ushort Code, string Detail) RefusalOf((Receiving? Receiving, Failure? Refusal) opened)
    {
        Assert.Null(opened.Receiving);

        return (opened.Refusal!.Code, opened.Refusal.Detail);
    }

    private static CallAddress CallOf(uint callId, string connectionHandle)
    {
        return new CallAddress(callId, connectionHandle);
    }

    // an opening on a call, of a total, which nothing hears stall, refused or admitted
    private static TransferOpening OpeningOf(CallAddress call, long total)
    {
        return new TransferOpening { Call = call, Total = total };
    }

    // definition

    [Fact]
    public void Refuses_an_opening_by_its_own_failure_and_holds_nothing_of_one_refused()
    {
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 64, MaximumPayloadBytes = 50 });
        var call = CallOf(1, "a");

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a transfer declares its total, not 0"), RefusalOf(receiving.Open(new byte[1], OpeningOf(call, 0))));
        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a payload is 50 bytes at most, not 51"), RefusalOf(receiving.Open(new byte[1], OpeningOf(call, 51))));
        Assert.Equal(((ushort)ProtocolCode.ChunkInvalid, "an opening of 4 bytes holds its whole total of 4"), RefusalOf(receiving.Open(new byte[4], OpeningOf(call, 4))));
        Assert.Equal(((ushort)ProtocolCode.ChunkInvalid, "an opening carries 3 bytes of its payload, not 2"), RefusalOf(receiving.Open(new byte[2], OpeningOf(call, 8) with { OpeningBytes = 3 })));
        Assert.Equal(64, receiving.Available);

        var (_, none, _) = ReceivingOf(LimitsOf() with { MaximumTransfers = 0 });

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "this peer takes no transfer"), RefusalOf(none.Open(new byte[1], OpeningOf(call, 8))));
    }

    [Fact]
    public void Takes_as_many_transfers_on_a_connection_as_it_may_and_one_on_another_all_the_same()
    {
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { MaximumTransfers = 2 });

        (Receiving? Receiving, Failure? Refusal) Open(uint callId, string connectionHandle)
        {
            return receiving.Open(new byte[1], OpeningOf(CallOf(callId, connectionHandle), 8));
        }

        var first = OpenedOf(Open(1, "a"));

        OpenedOf(Open(3, "a"));
        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, RefusalOf(Open(5, "a")).Code);
        OpenedOf(Open(1, "b"));

        // its place comes back once closed, and not before
        receiving.Complete(first);
        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, RefusalOf(Open(5, "a")).Code);
        receiving.Close(first);
        OpenedOf(Open(5, "a"));
    }

    [Fact]
    public void Admits_an_opening_whose_total_the_budget_left_holds_to_its_last_byte_and_has_one_a_byte_past_it_wait()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 64, MaximumPayloadBytes = 64 });

        OpenedOf(receiving.Open(new byte[4], OpeningOf(CallOf(1, "a"), 40)));
        Assert.Equal(24, receiving.Available);

        // a byte past the budget left: it waits, holding none of it, and is granted nothing
        var past = OpenedOf(receiving.Open(new byte[4], OpeningOf(CallOf(3, "a"), 25)));

        receiving.Grant(past);
        Assert.Empty(credits);
        Assert.Equal(24, receiving.Available);
        Assert.Equal(1, receiving.Gauges().Counts["waitingTransfers"]);
        receiving.Close(past);
        OpenedOf(receiving.Open(new byte[4], OpeningOf(CallOf(5, "a"), 24)));
        Assert.Equal(0, receiving.Available);
        Assert.Equal(0, receiving.Gauges().Counts["waitingTransfers"]);
    }

    [Fact]
    public void Reserves_a_transfer_s_whole_total_as_it_admits_it_and_nothing_more_as_it_credits_it()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 100 });
        var opened = OpenedOf(receiving.Open(new byte[4], OpeningOf(CallOf(1, "a"), 40)));

        Assert.Equal(60, receiving.Available);
        receiving.Grant(opened);

        // nothing came since: nothing more to grant
        receiving.Grant(opened);

        for (var offset = 4; offset < 12; offset += 1)
        {
            receiving.Place(opened, new Chunk(new byte[] { (byte)offset }, false, offset));
        }

        receiving.Grant(opened);
        Assert.Equal(["a 1 20", "a 1 28"], credits);
        Assert.Equal(60, receiving.Available);
    }

    [Fact]
    public void Gives_a_transfer_s_bytes_back_as_its_payload_goes_on_whole_and_all_it_holds_once_closed()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 100 });
        var opened = OpenedOf(receiving.Open(new byte[] { 1, 2 }, OpeningOf(CallOf(1, "a"), 4)));

        Assert.Equal(96, receiving.Available);
        receiving.Grant(opened);
        Assert.Equal(ChunkOutcome.Placed, receiving.Place(opened, new Chunk(new byte[] { 3 }, false, 2)).Outcome);
        Assert.Equal(ChunkOutcome.Complete, receiving.Place(opened, new Chunk(new byte[] { 4 }, true, 3)).Outcome);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, receiving.Complete(opened).ToArray());
        Assert.Equal(100, receiving.Available);

        // closed twice, it gives nothing back twice
        receiving.Close(opened);
        receiving.Close(opened);
        Assert.Equal(100, receiving.Available);

        // a transfer closed grants nothing, though it has credit to grant still
        var closed = OpenedOf(receiving.Open(new byte[] { 1 }, OpeningOf(CallOf(3, "a"), 40)));

        Assert.Equal(60, receiving.Available);
        receiving.Close(closed);
        receiving.Grant(closed);
        Assert.Equal(["a 1 4"], credits);
        Assert.Equal(100, receiving.Available);
    }

    [Fact]
    public void Admits_the_openings_that_wait_in_the_order_they_opened_one_that_fits_waiting_behind_one_before_it()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 60, MaximumPayloadBytes = 60 });

        Receiving Open(uint callId, (string ConnectionHandle, long Total) opened)
        {
            return OpenedOf(receiving.Open(new byte[1], OpeningOf(CallOf(callId, opened.ConnectionHandle), opened.Total)));
        }

        var first = Open(1, ("a", 40));

        // 'b' 1 waits for 30 bytes, and 'b' 3 behind it, though the 20 left hold it to its last byte
        Open(1, ("b", 30));

        var third = Open(3, ("b", 20));

        Assert.Empty(credits);
        Assert.Equal(20, receiving.Available);

        // the budget given back admits both, in the order they opened, each credited as it is
        receiving.Close(first);
        Assert.Equal(["b 1 17", "b 3 17"], credits);
        Assert.Equal(10, receiving.Available);

        // the 10 left hold 'a' 5, which waits behind 'a' 3 all the same
        Open(3, ("a", 20));
        Open(5, ("a", 5));
        Assert.Equal(2, credits.Count);
        receiving.Close(third);
        Assert.Equal(["b 1 17", "b 3 17", "a 3 17", "a 5 5"], credits);
        Assert.Equal(5, receiving.Available);
        Assert.Equal(0, receiving.Gauges().Counts["waitingTransfers"]);
    }

    [Fact]
    public void Ends_every_transfer_of_a_connection_or_of_every_one_waiting_or_admitted_before_it_admits_an_opening_the_budget_given_back_holds()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 48, MaximumPayloadBytes = 24 });

        Receiving Open(uint callId, string connectionHandle)
        {
            return OpenedOf(receiving.Open(new byte[4], OpeningOf(CallOf(callId, connectionHandle), 24)));
        }

        var first = Open(1, "a");

        receiving.Grant(first);
        Open(3, "a");

        // 'b' 1 waits, and 'a' 5 behind it
        Open(1, "b");
        Open(5, "a");
        Assert.Equal(["a 1 20"], credits);
        Assert.Equal(2, receiving.Gauges().Counts["waitingTransfers"]);

        // the budget given back admits 'b' alone: 'a' 5, which waited before it, ends too
        receiving.CloseAll("a");
        Assert.Equal(["a 1 20", "b 1 20"], credits);
        Assert.Equal(24, receiving.Available);
        Assert.Equal(0, receiving.Gauges().Counts["waitingTransfers"]);

        // its place came back: 'a' receives again
        Open(7, "a");
        receiving.CloseAll();
        Assert.Equal(48, receiving.Available);
        Assert.Equal(["a 1 20", "b 1 20"], credits);
    }

    [Fact]
    public void Refuses_an_opening_still_waiting_at_half_the_inactivity_allowed_CAPACITY_EXCEEDED_and_admits_the_one_behind_it()
    {
        TimeSpan WaitOf(int milliseconds)
        {
            return ReceivingTransfers.BudgetWaitOf(RouterLimits.Default with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(milliseconds) });
        }

        Assert.Equal(
            (TimeSpan.FromMilliseconds(15_000), TimeSpan.FromMilliseconds(1), TimeSpan.Zero),
            (WaitOf(30_000), WaitOf(3), WaitOf(1)));

        var (credits, receiving, time) = ReceivingOf(LimitsOf() with
        {
            BufferedBytesBudget = 48,
            MaximumPayloadBytes = 48,
            TransferInactivityTimeout = TimeSpan.FromMilliseconds(250),
        });
        var refused = new List<(ushort Code, string Detail)>();

        void Open(uint callId, long total)
        {
            OpenedOf(receiving.Open(new byte[1], OpeningOf(CallOf(callId, "a"), total) with
            {
                OnRefused = (failure) =>
                {
                    refused.Add((failure.Code, failure.Detail));
                },
            }));
        }

        Open(1, 40);
        Open(3, 24);
        time.Advance(TimeSpan.FromMilliseconds(60));

        // 'a' 5 fits the 8 bytes left, and waits behind 'a' 3, its own wait counted from its opening
        Open(5, 8);
        time.Advance(TimeSpan.FromMilliseconds(64));
        Assert.Empty(refused);
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([((ushort)ProtocolCode.CapacityExceeded, "a total of 24 bytes waited 125 milliseconds for the budget")], refused);
        Assert.Equal(["a 5 8"], credits);
        Assert.Equal((2L, 0L), (receiving.Gauges().Counts["receivingTransfers"], receiving.Gauges().Counts["waitingTransfers"]));

        // a wait of 0 refuses at once an opening that would wait, and holds nothing of it
        var (_, once, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 8, TransferInactivityTimeout = TimeSpan.FromMilliseconds(1) });

        OpenedOf(once.Open(new byte[1], OpeningOf(CallOf(1, "a"), 8)));
        Assert.Equal(
            ((ushort)ProtocolCode.CapacityExceeded, "a total of 8 bytes waited 0 milliseconds for the budget"),
            RefusalOf(once.Open(new byte[1], OpeningOf(CallOf(3, "a"), 8))));
        Assert.Equal((1L, 0L), (once.Gauges().Counts["receivingTransfers"], once.Gauges().Counts["waitingTransfers"]));
    }

    [Fact]
    public void Sets_a_transfer_s_timer_going_as_it_admits_it_never_while_it_waits()
    {
        var time = new RouterCoreTests.RequesterClock();
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 16, TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) }, time);
        var stalled = new List<uint>();
        var refused = new List<Failure>();

        Receiving Open(uint callId, long total)
        {
            return OpenedOf(receiving.Open(new byte[1], OpeningOf(CallOf(callId, "a"), total) with
            {
                OnAdmitted = () =>
                {
                    credits.Add($"admitted {callId}");
                },
                OnRefused = refused.Add,
                OnStall = () =>
                {
                    stalled.Add(callId);
                },
            }));
        }

        var first = Open(1, 16);

        Open(3, 8);

        // the first's inactivity, and the second's wait for the budget: no inactivity of its own
        Assert.Equal([TimeSpan.FromMilliseconds(250), TimeSpan.FromMilliseconds(125)], time.Armed.Select((timer) => { return timer.Delay; }));
        time.Advance(TimeSpan.FromMilliseconds(100));
        receiving.Close(first);

        // admitted, its wait stopped, its inactivity set going, then its first credit sent
        Assert.Equal(["admitted 3", "a 3 8"], credits);
        Assert.True(time.Armed[1].IsCleared);
        Assert.Equal(TimeSpan.FromMilliseconds(250), time.Armed[^1].Delay);
        Assert.Single(time.Armed, (timer) => { return !timer.IsCleared; });
        time.Advance(TimeSpan.FromMilliseconds(249));
        Assert.Equal((0, 0), (stalled.Count, refused.Count));
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([3u], stalled);
        Assert.Empty(refused);
    }

    [Fact]
    public void Stalls_a_transfer_nothing_comes_for_its_timer_set_going_again_by_bytes_placed_alone()
    {
        foreach (var (progressAt, duplicateAfter) in new[] { (100, 0), (200, 100) })
        {
            var time = new RouterCoreTests.RequesterClock();
            var (_, receiving, _) = ReceivingOf(LimitsOf() with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) }, time);
            var stalled = new List<uint>();
            var opened = OpenedOf(receiving.Open(new byte[1], OpeningOf(CallOf(1, "a"), 8) with
            {
                OnStall = () =>
                {
                    stalled.Add(1);
                },
            }));

            // without one to hear it, no transfer stalls
            OpenedOf(receiving.Open(new byte[1], OpeningOf(CallOf(3, "a"), 8)));
            receiving.Grant(opened);
            time.Advance(TimeSpan.FromMilliseconds(progressAt));
            receiving.Place(opened, new Chunk(new byte[] { 2 }, false, 1));

            // a duplicate is no progress: the stall counts from the last bytes placed, not from the opening
            time.Advance(TimeSpan.FromMilliseconds(duplicateAfter));
            receiving.Place(opened, new Chunk(new byte[] { 2 }, false, 1));
            Assert.Equal([TimeSpan.FromMilliseconds(250), TimeSpan.FromMilliseconds(250)], time.Armed.Select((timer) => { return timer.Delay; }));
            Assert.True(time.Armed[0].IsCleared);
            Assert.False(time.Armed[1].IsCleared);
            time.Advance(TimeSpan.FromMilliseconds(249 - duplicateAfter));
            Assert.Empty(stalled);
            time.Advance(TimeSpan.FromMilliseconds(1));
            Assert.Equal([1u], stalled);
        }
    }

    [Fact]
    public void Stops_a_transfer_s_timer_once_its_payload_is_whole_and_once_it_is_closed()
    {
        var time = new RouterCoreTests.RequesterClock();
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) }, time);
        var stalled = 0;

        void OnStall()
        {
            stalled += 1;
        }

        var whole = OpenedOf(receiving.Open(new byte[] { 1 }, OpeningOf(CallOf(1, "a"), 2) with { OnStall = OnStall }));

        receiving.Grant(whole);
        receiving.Place(whole, new Chunk(new byte[] { 2 }, true, 1));

        // the chunk that made it whole stopped its timer, and set none going
        Assert.Single(time.Armed);
        Assert.True(time.Armed[0].IsCleared);

        receiving.Complete(whole);
        receiving.Close(OpenedOf(receiving.Open(new byte[] { 1 }, OpeningOf(CallOf(3, "a"), 2) with { OnStall = OnStall })));

        // the opening's and the second transfer's: none left
        Assert.Equal(2, time.Armed.Count);
        Assert.All(time.Armed, (timer) => { Assert.True(timer.IsCleared); });
        Assert.DoesNotContain(time.Armed, (timer) => { return !timer.IsCleared; });
        time.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(0, stalled);
    }

    [Fact]
    public void Hears_no_stall_of_a_timer_stopped_as_it_fired_on_its_way_to_the_scheduler()
    {
        var limits = LimitsOf() with { BufferedBytesBudget = 16, TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) };
        var time = new FakeTimeProvider();
        var posted = new List<Action>();
        var receiving = new ReceivingTransfers(new ReceivingTransfersOptions
        {
            Limits = limits,
            PayloadBytesPerChunk = 1,
            Post = posted.Add,
            SendCredit = (_, _) =>
            {
            },
            Clock = time,
        });
        var stalled = 0;
        var refused = new List<Failure>();

        void RunPosted()
        {
            posted.ForEach((action) =>
            {
                action();
            });
            posted.Clear();
        }

        var opened = OpenedOf(receiving.Open(new byte[1], OpeningOf(CallOf(1, "a"), 8) with
        {
            OnStall = () =>
            {
                stalled += 1;
            },
        }));

        // the timer fires, and before the scheduler runs what it posted, bytes come
        receiving.Grant(opened);
        time.Advance(TimeSpan.FromMilliseconds(250));
        receiving.Place(opened, new Chunk(new byte[] { 2 }, false, 1));
        RunPosted();
        Assert.Equal(0, stalled);

        // a wait for the budget fires, and before the scheduler runs what it posted, the budget admits
        // its opening: it is refused nothing
        OpenedOf(receiving.Open(new byte[1], OpeningOf(CallOf(3, "a"), 16) with { OnRefused = refused.Add }));
        time.Advance(TimeSpan.FromMilliseconds(125));
        receiving.Close(opened);
        RunPosted();
        Assert.Empty(refused);
        Assert.Equal(0, receiving.Gauges().Counts["waitingTransfers"]);
    }

    [Fact]
    public void Counts_the_transfers_received_and_those_waiting_the_bytes_of_the_budget_they_reserve_under_its_ceiling_and_the_bytes_they_hold()
    {
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 64, MaximumPayloadBytes = 64 });
        var opened = OpenedOf(receiving.Open(new byte[4], OpeningOf(CallOf(1, "a"), 40)));

        receiving.Grant(opened);
        receiving.Place(opened, new Chunk(new byte[] { 4 }, false, 4));

        // a duplicate holds nothing more
        receiving.Place(opened, new Chunk(new byte[] { 4 }, false, 4));

        // past the 24 bytes left: it waits, its opening's bytes held all the same
        OpenedOf(receiving.Open(new byte[2], OpeningOf(CallOf(1, "b"), 30)));

        var gauges = receiving.Gauges();

        Assert.Empty(gauges.Anomalies);
        Assert.Equal(new Dictionary<string, long> { ["reservedBytes"] = 64 }, gauges.Ceilings);
        Assert.Equal(["a", "b"], gauges.ConnectionHandles.Order());
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["bufferedBytes"] = 7,
                ["outlivingTransfers"] = 0,
                ["receivingTransfers"] = 2,
                ["reservedBytes"] = 40,
                ["waitingTransfers"] = 1,
            },
            gauges.Counts);
        receiving.CloseAll();
        Assert.Empty(receiving.Gauges().ConnectionHandles);
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["bufferedBytes"] = 0,
                ["outlivingTransfers"] = 0,
                ["receivingTransfers"] = 0,
                ["reservedBytes"] = 0,
                ["waitingTransfers"] = 0,
            },
            receiving.Gauges().Counts);
    }

    [Fact]
    public void Holds_a_received_transfer_s_place_while_its_call_s_resolver_outlives_the_call_among_twice_maximumTransfers_and_gives_it_back_as_that_resolver_settles()
    {
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 64, MaximumTransfers = 1 });
        const string PastBoth = "the transfers a connection receives and those its resolvers outlive are 2 at most";

        (Receiving? Receiving, Failure? Refusal) Open(uint callId, string connectionHandle = "a")
        {
            return receiving.Open(new byte[1], OpeningOf(CallOf(callId, connectionHandle), 2));
        }

        Receiving Whole(Receiving opened)
        {
            receiving.Grant(opened);
            receiving.Place(opened, new Chunk(new byte[1], true, 1));
            receiving.Complete(opened);

            return opened;
        }

        // its call ends while its resolver runs on, as its router ends it: told it outlives the call,
        // then closed
        void Outlive(Receiving opened)
        {
            receiving.Outlive(opened);
            receiving.Close(opened);
        }

        var first = Whole(OpenedOf(Open(1)));

        // its bytes go back, its place among the transfers the connection receives too, but not
        // among those and the ones its resolvers outlive
        Outlive(first);
        Assert.Equal(["a"], receiving.Gauges().ConnectionHandles);
        Assert.Equal(
            new Dictionary<string, long> { ["bufferedBytes"] = 0, ["outlivingTransfers"] = 1, ["receivingTransfers"] = 0, ["reservedBytes"] = 0, ["waitingTransfers"] = 0 },
            receiving.Gauges().Counts);

        var second = OpenedOf(Open(3));

        // * past maximumTransfers first, then past twice as many with those its resolvers outlive,
        // checked first, its detail its own; another connection's are its own
        Assert.Equal(((ushort)ProtocolCode.CapacityExceeded, PastBoth), RefusalOf(Open(5)));
        Outlive(Whole(second));
        Assert.Equal(((ushort)ProtocolCode.CapacityExceeded, PastBoth), RefusalOf(Open(5)));
        Assert.Equal(2, receiving.Gauges().Counts["outlivingTransfers"]);
        OpenedOf(Open(1, "b"));

        // the resolver settles: its place goes back, once, and the next opening is taken
        receiving.Settle(first);
        receiving.Settle(first);
        Assert.Equal(1, receiving.Gauges().Counts["outlivingTransfers"]);

        var third = OpenedOf(Open(5));

        Assert.Equal(((ushort)ProtocolCode.CapacityExceeded, PastBoth), RefusalOf(Open(7)));
        receiving.Settle(second);
        Assert.Equal(((ushort)ProtocolCode.CapacityExceeded, "the transfers a connection receives at once are 1 at most"), RefusalOf(Open(7)));

        // its connection closes: the places its resolvers outlive end with it, and settle to nothing
        Outlive(third);
        receiving.CloseAll("a");
        Assert.Equal(["b"], receiving.Gauges().ConnectionHandles);
        Assert.Equal((0L, 1L), (receiving.Gauges().Counts["outlivingTransfers"], receiving.Gauges().Counts["receivingTransfers"]));
        receiving.Settle(third);
        OpenedOf(Open(9));
    }
}
