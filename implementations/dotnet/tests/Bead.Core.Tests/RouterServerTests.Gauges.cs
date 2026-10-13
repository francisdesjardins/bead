namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer"/>'s gauges: what it and its parts hold, for the connections it follows,
/// and what its paced subscriptions queue, as the TypeScript side's router-server tests read them.
/// </summary>
public sealed partial class RouterServerTests
{
    // helpers

    private async Task<Gauges> GaugesOf()
    {
        return await Router.Gauges().WaitAsync(Patience, Cancelled);
    }

    // the queued counts of the router's gauges
    private async Task<(long PausedSubscriptions, long QueuedNotifications)> Queued()
    {
        var counts = (await GaugesOf()).Counts;

        return (counts["pausedSubscriptions"], counts["queuedNotifications"]);
    }

    // what `held` holds of the names `expected` gives, whatever else it holds; one it lacks, as
    // long.MinValue
    private static Dictionary<string, long> Among(IReadOnlyDictionary<string, long> held, Dictionary<string, long> expected)
    {
        return expected.Keys.ToDictionary(
            (name) =>
            {
                return name;
            },
            (name) =>
            {
                return held.GetValueOrDefault(name, long.MinValue);
            });
    }

    // definition

    [Fact]
    public async Task Counts_what_it_and_its_parts_hold_for_the_connections_it_follows_which_it_forgets_as_each_closes()
    {
        Start(new RouterServerOptions { Relay = Admitting });

        // a request its resolver never answers
        Router.RegisterResolver(new RawResolver(Echo, (_) =>
        {
            return new TaskCompletionSource().Task;
        }));
        _transport.Open(First);
        _transport.Open(Second);

        // followed, and kept by nothing else
        Assert.Equal([First, Second], (await GaugesOf()).ConnectionHandles.Order(StringComparer.Ordinal));

        Deliver(First, RequestOf(1));
        Router.RegisterDestination(new ConnectionTarget(Second), new DestinationOptions { DestinationId = 5 });
        _transport.Closed(Second);
        await Settle();

        var gauges = await GaugesOf();
        var expected = new Dictionary<string, long>
        {
            ["answeringCalls"] = 1,
            ["closedDestinations"] = 1,
            ["connections"] = 1,
            ["destinations"] = 1,
            ["notifiedSubscriptions"] = 0,
            ["pendingCalls"] = 0,
            ["subscriptionsInFlight"] = 0,
            ["subscriptionsWaiting"] = 0,
        };

        Assert.Empty(gauges.Anomalies);
        Assert.Equal([First], gauges.ConnectionHandles);
        Assert.Equal(expected, Among(gauges.Counts, expected));

        _transport.Closed(First);
        gauges = await GaugesOf();
        expected = new Dictionary<string, long>
        {
            ["answeringCalls"] = 0,
            ["closedDestinations"] = 1,
            ["connections"] = 0,
            ["destinations"] = 1,
        };

        // the destination stays, on purpose, for no connection
        Assert.Empty(gauges.ConnectionHandles);
        Assert.Equal(expected, Among(gauges.Counts, expected));
    }

    // the TypeScript side's sits with its paced tests: each of its assertions reads the gauges
    // spec 11.7.3
    [Fact]
    public async Task Lets_a_queue_go_with_its_subscription_unsubscribed_cancelled_its_session_ended_its_connection_closed()
    {
        string[] words = ["a", "b", "c"];
        var news = StartPaced();

        Deliver(First, PacedOf(3));
        Deliver(First, PacedOf(5, "other"));
        Deliver(Second, PacedOf(3));
        Deliver(Third, PacedOf(3));
        await Settle();

        // the first connection holds its place under 3, so 5, answered after it, subscribes nothing
        foreach (var word in words)
        {
            await news.Notify(word).WaitAsync(Patience, Cancelled);
        }

        Assert.Equal((3L, 6L), await Queued());

        await Router.Unsubscribe(new CallAddress(3, First)).WaitAsync(Patience, Cancelled);

        Assert.Equal((2L, 4L), await Queued());

        Deliver(Second, CancelOf(3));

        Assert.Equal((1L, 2L), await Queued());

        await Router.DropSubscriptions(Third, Failure.OfProtocol(ProtocolCode.SessionRequired)).WaitAsync(Patience, Cancelled);

        Assert.Equal((0L, 0L), await Queued());

        Deliver(Third, PacedOf(7));
        await Settle();
        await news.Notify("d").WaitAsync(Patience, Cancelled);
        await news.Notify("e").WaitAsync(Patience, Cancelled);

        Assert.Equal((1L, 1L), await Queued());

        _transport.Closed(Third);

        Assert.Equal((0L, 0L), await Queued());
    }

    [Fact]
    public async Task Tells_in_its_gauges_what_its_fullest_queue_holds_at_the_bounds_its_options_give()
    {
        string[] words = ["a", "bb", "ccc"];
        var news = StartPaced(new PacingLimits { MaximumQueuedNotificationBytes = 10, MaximumQueuedNotifications = 4 });

        using var defaults = new RouterServer(new ScriptedTransport());

        Deliver(First, PacedOf(3));
        await Settle();

        foreach (var word in words)
        {
            await news.Notify(word).WaitAsync(Patience, Cancelled);
        }

        var gauges = await GaugesOf();
        var ceilings = new Dictionary<string, long> { ["largestQueuedNotificationBytes"] = 10, ["largestQueuedNotifications"] = 4 };
        var counts = new Dictionary<string, long>
        {
            ["largestQueuedNotificationBytes"] = 5,
            ["largestQueuedNotifications"] = 2,
            ["queuedNotificationBytes"] = 5,
        };
        var defaulted = new Dictionary<string, long> { ["largestQueuedNotificationBytes"] = 1_048_576, ["largestQueuedNotifications"] = 64 };

        Assert.Equal(ceilings, Among(gauges.Ceilings, ceilings));
        Assert.Equal(counts, Among(gauges.Counts, counts));
        Assert.Equal(defaulted, Among((await defaults.Gauges().WaitAsync(Patience, Cancelled)).Ceilings, defaulted));
    }
}
