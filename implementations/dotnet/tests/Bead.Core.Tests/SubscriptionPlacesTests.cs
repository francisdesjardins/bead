namespace Bead.Tests;

/// <summary>
/// <see cref="SubscriptionPlaces"/>: the one subscription a connection holds to a procedure, the call
/// in flight that holds it, the call that waits on it, and how the place is handed over.
/// </summary>
public sealed class SubscriptionPlacesTests
{
    // constants

    private const string First = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";
    private const string Second = "type=WS;ip=127.0.0.1;port=50002;ordinal=1";

    private static readonly ProcedureAddress News = new(2, 5);
    private static readonly ProcedureAddress Other = new(2, 7);

    // a success that subscribes, as a notification's resolver answers a request that opens one
    private static readonly (bool IsFailure, bool Notifies, ProcedureAddress Procedure) Subscribing = (false, true, News);

    // helpers

    // places over a notification manager of their own, with the connections open in `Open`
    private static (NotificationManager Notifications, SubscriptionPlaces Places, HashSet<string> Open) PlacesOf()
    {
        var notifications = new NotificationManager(PacingLimits.Default);
        var open = new HashSet<string> { First, Second };
        var places = new SubscriptionPlaces(notifications, (connectionHandle) =>
        {
            return open.Contains(connectionHandle);
        });

        return (notifications, places, open);
    }

    // the call ids a connection subscribed, in their order: a dictionary promises none
    private static List<uint> Held(NotificationManager notifications, string connectionHandle = First)
    {
        return [.. notifications.Subscriptions(connectionHandle).Select((subscription) =>
        {
            return subscription.CallId;
        }).Order()];
    }

    private static SubscribingCall SubscribingOf(uint callId, string connectionHandle = First, bool paced = false)
    {
        return new SubscribingCall(callId, connectionHandle, paced);
    }

    // the call ids of the subscriptions a drop gives, in its order
    private static List<uint> CallIdsOf(List<(uint CallId, ProcedureAddress Procedure)> dropped)
    {
        return [.. dropped.Select((each) =>
        {
            return each.CallId;
        })];
    }

    private static CallAddress CallOf(uint callId, string connectionHandle = First)
    {
        return new CallAddress(callId, connectionHandle);
    }

    // definition

    [Fact]
    public void Subscribe_puts_a_call_in_its_place_in_flight_and_gives_any_other_the_holder_s_call_id()
    {
        var (notifications, places, _) = PlacesOf();

        Assert.Equal(3u, places.Subscribe(SubscribingOf(3), News));
        Assert.Equal(3u, places.Subscribe(SubscribingOf(5), News));
        Assert.Equal(5u, places.Subscribe(SubscribingOf(5, Second), News));
        Assert.Equal([3u], Held(notifications));
    }

    [Fact]
    public void Settle_keeps_a_success_and_its_undo_takes_it_away_when_the_answer_does_not_go_out()
    {
        var (notifications, places, _) = PlacesOf();
        var call = SubscribingOf(3);

        places.Subscribe(call, News);

        var undo = places.Settle(call, Subscribing with { Notifies = false });

        Assert.Equal([3u], Held(notifications));
        Assert.NotNull(undo);

        undo();

        Assert.Empty(Held(notifications));
    }

    [Fact]
    public void Settle_subscribes_a_call_that_notifies_while_its_connection_holds_no_place_and_nothing_else()
    {
        var (notifications, places, _) = PlacesOf();

        Assert.NotNull(places.Settle(SubscribingOf(3), Subscribing));
        Assert.NotNull(places.Settle(SubscribingOf(5), Subscribing with { Procedure = Other }));

        // the place of `News` is held already, and nothing of it is in flight: no one waits
        Assert.Null(places.Settle(SubscribingOf(7), Subscribing));
        Assert.Null(places.Settle(SubscribingOf(9, Second), Subscribing with { Notifies = false }));
        Assert.Equal([3u, 5u], Held(notifications));
        Assert.Empty(Held(notifications, Second));
    }

    [Fact]
    public void A_failure_takes_the_holder_away_and_hands_its_place_to_the_first_call_answered_meanwhile()
    {
        var (notifications, places, _) = PlacesOf();
        var holder = SubscribingOf(3);

        places.Subscribe(holder, News);
        places.Settle(SubscribingOf(5), Subscribing);
        places.Settle(SubscribingOf(7), Subscribing);
        places.Settle(holder, Subscribing with { IsFailure = true });

        Assert.Equal([5u], Held(notifications));
    }

    [Fact]
    public void Paces_a_call_subscribed_settled_or_handed_its_place_as_its_own_request_asked()
    {
        var (notifications, places, _) = PlacesOf();

        places.Subscribe(SubscribingOf(3, First, paced: true), News);
        places.Settle(SubscribingOf(5, First, paced: false), Subscribing);
        places.Settle(SubscribingOf(7, First, paced: true), Subscribing with { Procedure = Other });
        places.Subscribe(SubscribingOf(3, Second), News);
        places.Settle(SubscribingOf(5, Second, paced: true), Subscribing);

        Assert.NotNull(notifications.PacingOf(3, First));
        Assert.NotNull(notifications.PacingOf(7, First));
        Assert.Null(notifications.PacingOf(3, Second));

        // each takes the place its holder falls from as it asked, whatever the holder asked
        places.Settle(SubscribingOf(3), Subscribing with { IsFailure = true });
        places.Cancel(CallOf(3, Second));

        Assert.Null(notifications.PacingOf(5, First));
        Assert.True(notifications.Has(5, First));
        Assert.NotNull(notifications.PacingOf(5, Second));
    }

    [Fact]
    public void A_failure_of_a_call_not_in_flight_takes_nothing_away()
    {
        var (notifications, places, _) = PlacesOf();

        places.Settle(SubscribingOf(3), Subscribing);
        places.Settle(SubscribingOf(3), Subscribing with { IsFailure = true });

        Assert.Equal([3u], Held(notifications));
    }

    [Fact]
    public void A_holder_answered_successfully_leaves_nothing_waiting_on_it()
    {
        var (notifications, places, _) = PlacesOf();
        var holder = SubscribingOf(3);

        places.Subscribe(holder, News);
        places.Settle(SubscribingOf(5), Subscribing);
        places.Settle(holder, Subscribing);
        places.Cancel(CallOf(3));

        Assert.Empty(Held(notifications));
    }

    [Fact]
    public void An_undo_hands_the_place_over_to_a_connection_still_open_that_holds_none()
    {
        // the TypeScript side runs the closed half alone; the open half, on places of its own, shows
        // the hand-over the closed one does not get
        var (stillOpenNotifications, stillOpenPlaces, _) = PlacesOf();

        stillOpenPlaces.Subscribe(SubscribingOf(3), News);
        stillOpenPlaces.Settle(SubscribingOf(5), Subscribing);
        stillOpenPlaces.Settle(SubscribingOf(3), Subscribing)?.Invoke();

        Assert.Equal([5u], Held(stillOpenNotifications));

        var (notifications, places, open) = PlacesOf();
        var holder = SubscribingOf(3);

        places.Subscribe(holder, News);
        places.Settle(SubscribingOf(5), Subscribing);

        var undo = places.Settle(holder, Subscribing);

        open.Clear();
        undo?.Invoke();

        Assert.Empty(Held(notifications));
    }

    [Fact]
    public void Cancel_takes_the_holder_away_and_hands_its_place_over_on_its_own_connection_alone()
    {
        var (notifications, places, _) = PlacesOf();

        places.Subscribe(SubscribingOf(3), News);
        places.Settle(SubscribingOf(5), Subscribing);
        places.Subscribe(SubscribingOf(3, Second), News);
        places.Cancel(CallOf(3));

        Assert.Equal([5u], Held(notifications));
        Assert.Equal([3u], Held(notifications, Second));
    }

    [Fact]
    public void A_call_that_waited_cancelled_or_unsubscribed_waits_no_more()
    {
        var (notifications, places, _) = PlacesOf();
        var holder = SubscribingOf(3);

        places.Subscribe(holder, News);
        places.Settle(SubscribingOf(5), Subscribing);
        places.Cancel(CallOf(5));
        places.Settle(SubscribingOf(7), Subscribing);

        Assert.False(places.Unsubscribe(CallOf(7)));

        places.Cancel(CallOf(3));

        Assert.Empty(Held(notifications));
    }

    [Fact]
    public void Unsubscribe_takes_a_subscription_away_and_says_whether_the_connection_held_it()
    {
        var (notifications, places, _) = PlacesOf();

        places.Settle(SubscribingOf(3), Subscribing);

        Assert.False(places.Unsubscribe(CallOf(3, Second)));
        Assert.True(places.Unsubscribe(CallOf(3)));
        Assert.Empty(Held(notifications));
    }

    [Fact]
    public void Holds_a_place_a_procedure_for_each_session_of_a_connection_and_drop_gives_a_session_s_own_its_connection_s_or_a_credential_s_by_its_identifier()
    {
        var (notifications, places, _) = PlacesOf();
        var grace = new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "grace" };
        var inGrace = (uint callId) =>
        {
            return SubscribingOf(callId) with { Session = new CallSession { Identifier = grace } };
        };

        places.Settle(SubscribingOf(1), Subscribing);
        places.Settle(inGrace(3), Subscribing);
        places.Settle(inGrace(5), Subscribing with { Procedure = Other });

        // a later call of a session that holds its place holds nothing more
        places.Settle(inGrace(7), Subscribing);
        Assert.Equal([1u, 3u, 5u], Held(notifications));

        Assert.Equal([1u], CallIdsOf(places.Drop(First)));
        Assert.Equal([3u, 5u], CallIdsOf(places.Drop(new Subscriber { ConnectionHandle = First, Identifier = grace with { } })));
        Assert.Empty(places.Drop(new Subscriber { ConnectionHandle = First, Identifier = grace with { Id = "Grace" } }));
    }

    [Fact]
    public void Drop_gives_the_established_and_the_waiting_never_one_in_flight_and_no_call_waits_after()
    {
        var (notifications, places, _) = PlacesOf();
        var holder = SubscribingOf(3);

        places.Subscribe(holder, News);
        places.Settle(SubscribingOf(5), Subscribing);
        places.Settle(SubscribingOf(7), Subscribing with { Procedure = Other });

        Assert.Equal([7u, 5u], CallIdsOf(places.Drop(First)));
        Assert.Empty(places.Drop(Second));

        places.Settle(holder, Subscribing with { IsFailure = true });

        Assert.Equal([7u], Held(notifications));
    }

    [Fact]
    public void Established_and_drop_give_each_subscription_answered_with_its_procedure_the_waiting_among_them_never_one_in_flight()
    {
        var (_, places, _) = PlacesOf();
        var holder = SubscribingOf(3);

        places.Subscribe(holder, News);
        places.Settle(SubscribingOf(5), Subscribing);
        places.Settle(SubscribingOf(7), Subscribing with { Procedure = Other });
        places.Settle(SubscribingOf(1, Second), Subscribing);

        // what a close ends, a connection's or every one's, each with the procedure it counts under
        Assert.Equal([(CallOf(7), Other), (CallOf(5), News)], places.Established(First));
        Assert.Equal([(CallOf(7), Other), (CallOf(1, Second), News), (CallOf(5), News)], places.Established(null));
        Assert.Equal([(7u, Other), (5u, News)], places.Drop(First));
    }

    [Fact]
    public void Clear_forgets_the_calls_in_flight_and_waiting_of_a_connection_or_of_every_one()
    {
        var (notifications, places, _) = PlacesOf();

        foreach (var connectionHandle in new[] { First, Second })
        {
            places.Subscribe(SubscribingOf(3, connectionHandle), News);
            places.Settle(SubscribingOf(5, connectionHandle), Subscribing);
        }

        places.Clear(First);

        // no longer in flight, the holder's failure takes nothing away, and no one waits on it
        places.Settle(SubscribingOf(3), Subscribing with { IsFailure = true });

        Assert.Equal([3u], Held(notifications));

        places.Clear();
        places.Settle(SubscribingOf(3, Second), Subscribing with { IsFailure = true });

        Assert.Equal([3u], Held(notifications, Second));
    }

    [Fact]
    public void Counts_the_subscribing_calls_in_flight_and_those_waiting_for_a_place_and_their_connections()
    {
        var (_, places, _) = PlacesOf();

        places.Subscribe(SubscribingOf(3), News);

        // in flight, nobody waiting on it: its connection is kept all the same
        Assert.Equal([First], places.Gauges().ConnectionHandles);
        places.Subscribe(SubscribingOf(5), News);
        places.Settle(SubscribingOf(5), Subscribing);
        Assert.Equal([First], places.Gauges().ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["subscriptionsInFlight"] = 1, ["subscriptionsWaiting"] = 1 }, places.Gauges().Counts);
        places.Clear(First);
        Assert.Empty(places.Gauges().ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["subscriptionsInFlight"] = 0, ["subscriptionsWaiting"] = 0 }, places.Gauges().Counts);
    }
}
