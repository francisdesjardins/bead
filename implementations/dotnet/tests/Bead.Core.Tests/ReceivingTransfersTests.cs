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

    // definition

    [Fact]
    public void Refuses_an_opening_by_its_own_failure_and_holds_nothing_of_one_refused()
    {
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 64, MaximumPayloadBytes = 50 });
        var call = CallOf(1, "a");

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a transfer declares its total, not 0"), RefusalOf(receiving.Open(new byte[1], (call, null, 0))));
        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a payload is 50 bytes at most, not 51"), RefusalOf(receiving.Open(new byte[1], (call, null, 51))));
        Assert.Equal(((ushort)ProtocolCode.ChunkInvalid, "an opening of 4 bytes holds its whole total of 4"), RefusalOf(receiving.Open(new byte[4], (call, null, 4))));
        Assert.Equal(64, receiving.Available);

        var (_, none, _) = ReceivingOf(LimitsOf() with { MaximumTransfers = 0 });

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "this peer takes no transfer"), RefusalOf(none.Open(new byte[1], (call, null, 8))));
    }

    [Fact]
    public void Takes_as_many_transfers_on_a_connection_as_it_may_and_one_on_another_all_the_same()
    {
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { MaximumTransfers = 2 });

        (Receiving? Receiving, Failure? Refusal) Open(uint callId, string connectionHandle)
        {
            return receiving.Open(new byte[1], (CallOf(callId, connectionHandle), null, 8));
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
    public void Holds_an_opening_to_the_last_byte_of_its_budget_and_refuses_one_byte_more()
    {
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 64, MaximumPayloadBytes = 64 });

        OpenedOf(receiving.Open(new byte[60], (CallOf(1, "a"), null, 64)));
        Assert.Equal(4, receiving.Available);
        Assert.Equal(
            ((ushort)ProtocolCode.CapacityExceeded, "the transfers received hold the budget but 4 bytes"),
            RefusalOf(receiving.Open(new byte[5], (CallOf(3, "a"), null, 64))));
        OpenedOf(receiving.Open(new byte[4], (CallOf(3, "a"), null, 64)));
        Assert.Equal(0, receiving.Available);
    }

    [Fact]
    public void Reserves_what_each_credit_it_sends_opens_within_the_budget_left()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 100 });
        var opened = OpenedOf(receiving.Open(new byte[4], (CallOf(1, "a"), null, 40)));

        receiving.Grant(opened);

        // nothing came since: nothing more to grant
        receiving.Grant(opened);
        Assert.Equal(["a 1 20"], credits);
        Assert.Equal(80, receiving.Available);
    }

    [Fact]
    public void Gives_a_transfer_s_bytes_back_as_its_payload_goes_on_whole_and_all_it_holds_once_closed()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 100 });
        var opened = OpenedOf(receiving.Open(new byte[] { 1, 2 }, (CallOf(1, "a"), null, 4)));

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
        var closed = OpenedOf(receiving.Open(new byte[] { 1 }, (CallOf(3, "a"), null, 40)));

        receiving.Close(closed);
        receiving.Grant(closed);
        Assert.Equal(["a 1 4"], credits);
        Assert.Equal(100, receiving.Available);
    }

    [Fact]
    public void Grants_a_transfer_the_budget_starved_once_another_gives_its_bytes_back()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 21, MaximumPayloadBytes = 20 });
        var first = OpenedOf(receiving.Open(new byte[4], (CallOf(1, "a"), null, 20)));

        receiving.Grant(first);

        var second = OpenedOf(receiving.Open(new byte[1], (CallOf(1, "b"), null, 20)));

        receiving.Grant(second);
        Assert.Equal(["a 1 20"], credits);
        Assert.Equal(0, receiving.Available);
        receiving.Close(first);
        Assert.Equal(["a 1 20", "b 1 17"], credits);
        Assert.Equal(4, receiving.Available);
    }

    [Fact]
    public void Ends_every_transfer_of_a_connection_or_of_every_one_before_it_grants_the_budget_given_back()
    {
        var (credits, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 28, MaximumPayloadBytes = 24 });

        Receiving Open(uint callId, string connectionHandle)
        {
            return OpenedOf(receiving.Open(new byte[4], (CallOf(callId, connectionHandle), null, 24)));
        }

        var first = Open(1, "a");

        receiving.Grant(first);
        Open(3, "a");

        var starved = Open(1, "b");

        receiving.Grant(starved);
        Assert.Equal(["a 1 20"], credits);

        // the budget first gives back goes to 'b' alone: no credit goes to 'a' 3, which ends too
        receiving.CloseAll("a");
        Assert.Equal(["a 1 20", "b 1 20"], credits);
        Assert.Equal(8, receiving.Available);

        // its place came back: 'a' receives again
        Open(5, "a");
        receiving.CloseAll();
        Assert.Equal(28, receiving.Available);
        Assert.Equal(["a 1 20", "b 1 20"], credits);
    }

    [Fact]
    public void Stalls_a_transfer_nothing_comes_for_its_timer_set_going_again_by_bytes_placed_alone()
    {
        var (_, receiving, time) = ReceivingOf(LimitsOf() with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) });
        var stalled = new List<uint>();
        var opened = OpenedOf(receiving.Open(new byte[1], (CallOf(1, "a"), () =>
        {
            stalled.Add(1);
        }, 8)));

        // without one to hear it, no transfer stalls
        OpenedOf(receiving.Open(new byte[1], (CallOf(3, "a"), null, 8)));
        receiving.Grant(opened);
        time.Advance(TimeSpan.FromMilliseconds(200));
        receiving.Place(opened, new Chunk(new byte[] { 2 }, false, 1));

        // a duplicate is no progress: the stall counts from the last bytes placed, not from the opening
        time.Advance(TimeSpan.FromMilliseconds(100));
        receiving.Place(opened, new Chunk(new byte[] { 2 }, false, 1));
        time.Advance(TimeSpan.FromMilliseconds(100));
        Assert.Empty(stalled);
        time.Advance(TimeSpan.FromMilliseconds(50));
        Assert.Equal([1u], stalled);
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

        var whole = OpenedOf(receiving.Open(new byte[] { 1 }, (CallOf(1, "a"), OnStall, 2)));

        receiving.Grant(whole);
        receiving.Place(whole, new Chunk(new byte[] { 2 }, true, 1));
        receiving.Complete(whole);
        receiving.Close(OpenedOf(receiving.Open(new byte[] { 1 }, (CallOf(3, "a"), OnStall, 2))));
        Assert.Equal(3, time.Armed.Count);
        Assert.All(time.Armed, (timer) => { Assert.True(timer.IsCleared); });
        Assert.DoesNotContain(time.Armed, (timer) => { return !timer.IsCleared; });
        time.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(0, stalled);
    }

    [Fact]
    public void Hears_no_stall_of_a_timer_stopped_as_it_fired_on_its_way_to_the_scheduler()
    {
        var limits = LimitsOf() with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) };
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
        var opened = OpenedOf(receiving.Open(new byte[1], (CallOf(1, "a"), () =>
        {
            stalled += 1;
        }, 8)));

        // the timer fires, and before the scheduler runs what it posted, bytes come
        receiving.Grant(opened);
        time.Advance(TimeSpan.FromMilliseconds(250));
        receiving.Place(opened, new Chunk(new byte[] { 2 }, false, 1));
        posted.ForEach((action) =>
        {
            action();
        });
        Assert.Equal(0, stalled);
    }

    [Fact]
    public void Counts_the_transfers_received_and_the_bytes_of_the_budget_they_hold_under_its_ceiling()
    {
        var (_, receiving, _) = ReceivingOf(LimitsOf() with { BufferedBytesBudget = 64, MaximumPayloadBytes = 64 });
        var opened = OpenedOf(receiving.Open(new byte[4], (CallOf(1, "a"), null, 8)));

        receiving.Grant(opened);

        var gauges = receiving.Gauges();

        Assert.Empty(gauges.Anomalies);
        Assert.Equal(new Dictionary<string, long> { ["bufferedBytes"] = 64 }, gauges.Ceilings);
        Assert.Equal(["a"], gauges.ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["bufferedBytes"] = 64 - receiving.Available, ["receivingTransfers"] = 1 }, gauges.Counts);
        Assert.True(receiving.Available < 64);
        receiving.CloseAll();
        Assert.Empty(receiving.Gauges().ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["bufferedBytes"] = 0, ["receivingTransfers"] = 0 }, receiving.Gauges().Counts);
    }
}
