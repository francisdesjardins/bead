namespace Bead.Tests;

/// <summary>
/// <see cref="NotificationManager"/>: who is subscribed to which procedure, under which call id, the
/// pacing a subscription holds when its request asked, and what goes when a connection does.
/// </summary>
public sealed class NotificationManagerTests
{
    // constants

    private const string First = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";
    private const string Second = "type=WS;ip=127.0.0.1;port=50002;ordinal=1";
    private const string Unknown = "type=WS;ip=127.0.0.1;port=1;ordinal=1";

    // helpers

    private static ProcedureAddress ProcedureOf(ushort serviceId, ushort procedureId)
    {
        return new ProcedureAddress(serviceId, procedureId);
    }

    private static SubscribingCall CallOf(uint callId, string connectionHandle, bool paced = false)
    {
        return new SubscribingCall(callId, connectionHandle, paced);
    }

    // definition

    [Fact]
    public void Holds_one_subscription_a_procedure_for_each_session_of_a_connection_its_connection_s_and_each_credential_s_by_its_identifier_octet_for_octet()
    {
        var notifications = new NotificationManager(PacingLimits.Default);
        var grace = new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = "https://a.example", Sub = "grace" };
        var inSession = (uint callId, SessionIdentifier identifier) =>
        {
            return CallOf(callId, First) with { Session = new CallSession { Identifier = identifier } };
        };

        Assert.Equal(1u, notifications.Register(ProcedureOf(10, 1), CallOf(1, First)));
        Assert.Equal(3u, notifications.Register(ProcedureOf(10, 1), inSession(3, grace)));
        Assert.Equal(5u, notifications.Register(ProcedureOf(10, 1), inSession(5, grace with { Issuer = "https://b.example" })));
        Assert.Equal(7u, notifications.Register(ProcedureOf(10, 1), inSession(7, grace with { Sub = "Grace" })));

        // one identifier, given anew, is one session, which holds its place already
        Assert.Throws<InvalidOperationException>(() =>
        {
            return notifications.Register(ProcedureOf(10, 1), inSession(9, grace with { }));
        });

        Assert.Equal(1u, notifications.SubscriptionOf(ProcedureOf(10, 1), First));
        Assert.Equal(3u, notifications.SubscriptionOf(ProcedureOf(10, 1), new Subscriber { ConnectionHandle = First, Identifier = grace with { } }));
        Assert.Equal([(First, 1u), (First, 3u), (First, 5u), (First, 7u)], notifications.Candidates(ProcedureOf(10, 1)));
        Assert.Equal(grace, notifications.SubscriptionAt(3, First)!.Value.Session);
        Assert.Null(notifications.SubscriptionAt(1, First)!.Value.Session);

        // the one of a credential's session taken away, every other place stays
        notifications.Unregister(3, First);

        Assert.Equal(
            [1u, null, 5u, 7u],
            new SessionIdentifier?[] { null, grace, grace with { Issuer = "https://b.example" }, grace with { Sub = "Grace" } }.Select((identifier) =>
            {
                return notifications.SubscriptionOf(ProcedureOf(10, 1), new Subscriber { ConnectionHandle = First, Identifier = identifier });
            }));
    }

    [Fact]
    public void Registers_each_subscription_under_the_call_id_of_the_request_that_made_it()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        Assert.Equal(1u, notifications.Register(ProcedureOf(10, 1), CallOf(1, First)));
        Assert.Equal(3u, notifications.Register(ProcedureOf(10, 2), CallOf(3, Second)));
        Assert.Equal(5u, notifications.Register(ProcedureOf(20, 1), CallOf(5, First)));

        Assert.Equal(
            [new Subscription(1, First, ProcedureOf(10, 1)), new Subscription(5, First, ProcedureOf(20, 1))],
            notifications.Subscriptions(First));
        Assert.Equal([new Subscription(3, Second, ProcedureOf(10, 2))], notifications.Subscriptions(Second));
        Assert.Equal(
            [new Subscription(1, First, ProcedureOf(10, 1)), new Subscription(5, First, ProcedureOf(20, 1)), new Subscription(3, Second, ProcedureOf(10, 2))],
            notifications.Subscriptions());
        Assert.Equal([(First, 1u)], notifications.Candidates(ProcedureOf(10, 1)));
        Assert.Equal([(Second, 3u)], notifications.Candidates(ProcedureOf(10, 2)));
        Assert.Equal([(First, 5u)], notifications.Candidates(ProcedureOf(20, 1)));
    }

    [Fact]
    public void Keeps_its_subscriptions_and_candidates_in_the_order_they_were_made_one_taken_away_between()
    {
        // the order the wire sees — the failures a session's end sends, the connections a notification
        // goes to — where a .NET dictionary would reuse the place of an entry gone
        const string third = "type=WS;ip=127.0.0.1;port=50003;ordinal=1";

        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First));
        notifications.Register(ProcedureOf(10, 2), CallOf(3, First));
        notifications.Register(ProcedureOf(10, 1), CallOf(7, Second));
        notifications.Unregister(1, First);
        notifications.Register(ProcedureOf(10, 3), CallOf(5, First));
        notifications.Register(ProcedureOf(10, 1), CallOf(9, third));

        Assert.Equal([3u, 5u], notifications.Subscriptions(First).Select((subscription) =>
        {
            return subscription.CallId;
        }));
        Assert.Equal([(Second, 7u), (third, 9u)], notifications.Candidates(ProcedureOf(10, 1)));
    }

    [Fact]
    public void Takes_the_same_call_id_on_two_connections_as_two_subscriptions()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(13, First));
        notifications.Register(ProcedureOf(10, 1), CallOf(13, Second));

        Assert.Equal([(First, 13u), (Second, 13u)], notifications.Candidates(ProcedureOf(10, 1)));
        Assert.True(notifications.Has(13, First));
        Assert.True(notifications.Has(13, Second));

        notifications.Unregister(13, First);

        Assert.False(notifications.Has(13, First));
        Assert.True(notifications.Has(13, Second));
    }

    [Fact]
    public void Lists_the_candidates_of_one_procedure_as_a_copy()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First));
        notifications.Register(ProcedureOf(10, 1), CallOf(3, Second));
        notifications.Register(ProcedureOf(10, 2), CallOf(5, Second));

        var candidates = notifications.Candidates(ProcedureOf(10, 1));

        Assert.Equal([(First, 1u), (Second, 3u)], candidates);

        candidates.Clear();

        Assert.Equal(2, notifications.Candidates(ProcedureOf(10, 1)).Count);
        Assert.Empty(notifications.Candidates(ProcedureOf(10, 3)));
        Assert.Empty(notifications.Candidates(ProcedureOf(99, 1)));
    }

    [Fact]
    public void Refuses_a_second_subscription_of_a_connection_to_a_procedure_and_a_call_id_it_holds_registering_nothing()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(7, First));

        Assert.Throws<InvalidOperationException>(() =>
        {
            return notifications.Register(ProcedureOf(10, 1), CallOf(9, First));
        });
        Assert.Throws<InvalidOperationException>(() =>
        {
            return notifications.Register(ProcedureOf(20, 2), CallOf(7, First));
        });
        Assert.Equal([new Subscription(7, First, ProcedureOf(10, 1))], notifications.Subscriptions(First));

        // nothing of what was refused is held
        Assert.False(notifications.Has(9, First));
        Assert.Empty(notifications.Candidates(ProcedureOf(20, 2)));
        Assert.Null(notifications.SubscriptionOf(ProcedureOf(20, 2), First));
    }

    [Fact]
    public void Cleans_a_connection_s_subscriptions_everywhere_and_prunes_what_empties()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First));
        notifications.Register(ProcedureOf(10, 1), CallOf(3, Second));
        notifications.Register(ProcedureOf(10, 2), CallOf(5, First));
        notifications.Register(ProcedureOf(20, 1), CallOf(7, First));

        notifications.Clean(First);
        notifications.Clean(First);
        notifications.Clean(Unknown);

        Assert.Empty(notifications.Subscriptions(First));
        Assert.Equal([new Subscription(3, Second, ProcedureOf(10, 1))], notifications.Subscriptions(Second));
        Assert.Equal([(Second, 3u)], notifications.Candidates(ProcedureOf(10, 1)));
        Assert.Empty(notifications.Candidates(ProcedureOf(10, 2)));
        Assert.Empty(notifications.Candidates(ProcedureOf(20, 1)));
        Assert.False(notifications.Has(1, First));
    }

    // a subscription is a value here: the list alone is there to change
    [Fact]
    public void Hands_out_copies_of_its_subscriptions()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First));
        notifications.Subscriptions().Clear();
        notifications.Subscriptions(First).Clear();

        Assert.Equal([new Subscription(1, First, ProcedureOf(10, 1))], notifications.Subscriptions());
        Assert.True(notifications.Has(1, First));
    }

    [Fact]
    public void Unregisters_one_subscription_of_its_own_connection_pruning_what_empties_any_other_is_none()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First));
        notifications.Register(ProcedureOf(20, 1), CallOf(3, Second));

        // no connection takes another's
        Assert.Null(notifications.Unregister(3, First));
        Assert.Equal(3u, notifications.Unregister(3, Second));
        Assert.Null(notifications.Unregister(3, Second));
        Assert.Null(notifications.Unregister(99, First));
        Assert.Empty(notifications.Candidates(ProcedureOf(20, 1)));
        Assert.Equal([new Subscription(1, First, ProcedureOf(10, 1))], notifications.Subscriptions(First));
        Assert.Empty(notifications.Subscriptions(Second));

        // a call id let go of may subscribe again
        notifications.Register(ProcedureOf(20, 1), CallOf(3, Second));

        Assert.Equal(3u, notifications.SubscriptionOf(ProcedureOf(20, 1), Second));
    }

    [Fact]
    public void Finds_the_subscription_a_connection_has_to_a_procedure_among_its_own_only()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First));
        notifications.Register(ProcedureOf(10, 2), CallOf(3, First));
        notifications.Register(ProcedureOf(20, 1), CallOf(5, First));
        notifications.Register(ProcedureOf(10, 1), CallOf(7, Second));

        Assert.Equal(1u, notifications.SubscriptionOf(ProcedureOf(10, 1), First));
        Assert.Equal(5u, notifications.SubscriptionOf(ProcedureOf(20, 1), First));
        Assert.Equal(7u, notifications.SubscriptionOf(ProcedureOf(10, 1), Second));
        Assert.Null(notifications.SubscriptionOf(ProcedureOf(20, 2), First));
        Assert.Null(notifications.SubscriptionOf(ProcedureOf(10, 2), Second));
        Assert.Null(notifications.SubscriptionOf(ProcedureOf(10, 1), Unknown));
    }

    [Fact]
    public void Counts_the_subscriptions_it_notifies_and_their_connections_until_each_is_cleaned()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First));
        notifications.Register(ProcedureOf(10, 2), CallOf(3, First));
        notifications.Register(ProcedureOf(10, 1), CallOf(5, Second));
        Assert.Equal([First, Second], notifications.Gauges().ConnectionHandles.Order());
        Assert.Equal(3, notifications.Gauges().Counts["notifiedSubscriptions"]);
        notifications.Clean(First);
        Assert.Equal([Second], notifications.Gauges().ConnectionHandles);
        Assert.Equal(1, notifications.Gauges().Counts["notifiedSubscriptions"]);
    }

    [Fact]
    public void Paces_a_subscription_whose_request_asked_and_no_other()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First, paced: true));
        notifications.Register(ProcedureOf(10, 2), CallOf(3, First, paced: false));

        // a call that says nothing of its pacing
        notifications.Register(ProcedureOf(10, 3), new SubscribingCall { CallId = 5, ConnectionHandle = First });

        Assert.Equal(PacingOutcome.Send, notifications.PacingOf(1, First)?.Offer(new byte[1], null));
        Assert.Null(notifications.PacingOf(3, First));
        Assert.Null(notifications.PacingOf(5, First));

        // another connection's call id, and one no connection holds
        Assert.Null(notifications.PacingOf(1, Second));
        Assert.Null(notifications.PacingOf(7, First));
    }

    [Fact]
    public void Lets_a_pacing_go_with_its_subscription_however_it_goes()
    {
        var notifications = new NotificationManager(PacingLimits.Default);

        (long Paused, long Queued) Paused()
        {
            var counts = notifications.Gauges().Counts;

            return (counts["pausedSubscriptions"], counts["queuedNotifications"]);
        }

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First, paced: true));
        notifications.Register(ProcedureOf(10, 2), CallOf(3, First, paced: true));

        // each its first credit spent, and one queued: a pacing kept would queue what comes next
        foreach (var callId in new uint[] { 1, 1, 3, 3 })
        {
            notifications.PacingOf(callId, First)?.Offer(new byte[1], null);
        }

        Assert.Equal((2, 2), Paused());

        notifications.Unregister(1, First);

        Assert.Null(notifications.PacingOf(1, First));
        Assert.Equal((1, 1), Paused());

        notifications.Clean(First);

        Assert.Null(notifications.PacingOf(3, First));
        Assert.Equal((0, 0), Paused());

        // registered again, it starts anew
        notifications.Register(ProcedureOf(10, 1), CallOf(1, First, paced: true));

        Assert.Equal(PacingOutcome.Send, notifications.PacingOf(1, First)?.Offer(new byte[1], null));
    }

    [Fact]
    public void Queues_a_paced_subscription_up_to_the_limits_it_was_built_with()
    {
        var notifications = new NotificationManager(new PacingLimits { MaximumQueuedNotifications = 1 }.Validate());

        notifications.Register(ProcedureOf(10, 1), CallOf(1, First, paced: true));

        var pacing = notifications.PacingOf(1, First);
        var payload = new byte[1];

        Assert.Equal(
            [PacingOutcome.Send, PacingOutcome.Queued, PacingOutcome.Exceeded],
            [pacing?.Offer(payload, null), pacing?.Offer(payload, null), pacing?.Offer(payload, null)]);
    }

    [Fact]
    public void Counts_what_paced_subscriptions_queue_all_together_and_the_fullest_at_their_limits()
    {
        var notifications = new NotificationManager(new PacingLimits { MaximumQueuedNotificationBytes = 100, MaximumQueuedNotifications = 5 }.Validate());

        // registered paced, and what its credit let go at once
        void Register(uint callId, string connectionHandle)
        {
            notifications.Register(ProcedureOf(10, (ushort)callId), CallOf(callId, connectionHandle, paced: true));
            notifications.PacingOf(callId, connectionHandle)?.Offer(new byte[1], null);
        }

        void Queue((uint CallId, string ConnectionHandle) call, int[] sizes)
        {
            foreach (var size in sizes)
            {
                notifications.PacingOf(call.CallId, call.ConnectionHandle)?.Offer(new byte[size], null);
            }
        }

        Assert.Equal(
            new Dictionary<string, long> { ["largestQueuedNotificationBytes"] = 100, ["largestQueuedNotifications"] = 5 },
            notifications.Gauges().Ceilings);
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["largestQueuedNotificationBytes"] = 0,
                ["largestQueuedNotifications"] = 0,
                ["notifiedSubscriptions"] = 0,
                ["pausedSubscriptions"] = 0,
                ["queuedNotificationBytes"] = 0,
                ["queuedNotifications"] = 0,
            },
            notifications.Gauges().Counts);
        Register(1, First);
        Register(3, First);
        Register(5, Second);
        notifications.Register(ProcedureOf(10, 7), CallOf(7, First));
        notifications.Register(ProcedureOf(10, 9), CallOf(9, First, paced: true));
        Queue((1, First), [10, 20]);
        Queue((3, First), [40]);
        Queue((5, Second), [5, 5, 5]);
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["largestQueuedNotificationBytes"] = 40,
                ["largestQueuedNotifications"] = 3,
                ["notifiedSubscriptions"] = 5,

                // the fourth paced one still has its first credit
                ["pausedSubscriptions"] = 3,
                ["queuedNotificationBytes"] = 85,
                ["queuedNotifications"] = 6,
            },
            notifications.Gauges().Counts);
        notifications.PacingOf(5, Second)?.Credit(10);

        Assert.Equal(
            new Dictionary<string, long>
            {
                ["largestQueuedNotificationBytes"] = 40,
                ["largestQueuedNotifications"] = 2,
                ["notifiedSubscriptions"] = 5,
                ["pausedSubscriptions"] = 2,
                ["queuedNotificationBytes"] = 70,
                ["queuedNotifications"] = 3,
            },
            notifications.Gauges().Counts);
    }

    [Fact]
    public void Queues_at_the_defaults_when_its_options_say_nothing_and_refuses_a_limit_that_is_none()
    {
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["largestQueuedNotificationBytes"] = PacingLimits.Default.MaximumQueuedNotificationBytes,
                ["largestQueuedNotifications"] = PacingLimits.Default.MaximumQueuedNotifications,
            },
            new NotificationManager(PacingLimits.Default).Gauges().Ceilings);
        Assert.Throws<ArgumentException>(() =>
        {
            return new NotificationManager(new PacingLimits { MaximumQueuedNotifications = 0 });
        });
    }
}
