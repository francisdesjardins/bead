namespace Bead;

/// <summary>
/// The subscription places of a server's connections. A place is the one subscription a connection
/// holds to a procedure, and the first call to take it keeps it. A call in a place is in flight, from
/// its subscribe until its answer goes out; established, once its answer went out; or waiting, when
/// it was answered while another call, still in flight, held the place: the first one answered
/// waits, and takes the place should the holder fall — its answer a failure, its answer not gone
/// out, or its call cancelled — while its connection is open and holds none. Touched on its router's
/// scheduler alone.
/// </summary>
internal sealed class SubscriptionPlaces(NotificationManager notifications, Func<string, bool> isConnected)
{
    // by connection, the calls subscribed that their answer still has to settle
    private readonly Dictionary<string, HashSet<uint>> _inFlight = [];

    // by connection, for each holder in flight, the first call answered meanwhile for its place, in
    // the order they came
    private readonly Dictionary<string, OrderedDictionary<uint, Waiting>> _waiting = [];

    /// <summary>
    /// The place's holder cancelled: its subscription goes, it waits for no place any more, and the
    /// call that waited on it takes the place.
    /// </summary>
    public void Cancel(CallAddress call)
    {
        TakeInFlight(call);
        notifications.Unregister(call.CallId, call.ConnectionHandle);
        LeaveWaiting(call);
        HandOver(TakeWaiting(call), call.ConnectionHandle);
    }

    /// <summary>
    /// The calls a session's end ends on a connection: each established subscription, and each call
    /// waiting, which no longer waits. A call in flight is left to its own answer.
    /// </summary>
    public List<uint> Drop(string connectionHandle)
    {
        // a call waiting on one in flight already believes it is subscribed: it ends as one that is
        var successors = _waiting.Remove(connectionHandle, out var waiting) ? waiting.Values.ToList() : [];

        return
        [
            .. notifications.Subscriptions(connectionHandle).Where((subscription) =>
            {
                return !IsInFlight(new CallAddress(subscription.CallId, connectionHandle));
            }).Select((subscription) =>
            {
                return subscription.CallId;
            }),
            .. successors.Select((successor) =>
            {
                return successor.CallId;
            }),
        ];
    }

    /// <summary>Forgets every call in flight and every call waiting — a connection's alone, when given.</summary>
    public void Clear(string? connectionHandle = null)
    {
        if (connectionHandle is null)
        {
            _inFlight.Clear();
            _waiting.Clear();

            return;
        }

        _inFlight.Remove(connectionHandle);
        _waiting.Remove(connectionHandle);
    }

    /// <summary>What it holds: the subscribing calls in flight, those waiting for a place, and their connections.</summary>
    public Gauges Gauges()
    {
        // a call waits only on a holder in flight on its own connection
        return Bead.Gauges.Of(
            new Dictionary<string, long>
            {
                ["subscriptionsInFlight"] = _inFlight.Values.Sum((calls) =>
                {
                    return (long)calls.Count;
                }),
                ["subscriptionsWaiting"] = _waiting.Values.Sum((calls) =>
                {
                    return (long)calls.Count;
                }),
            },
            _inFlight.Keys);
    }

    /// <summary>
    /// An answer about to go out for a call: a failure takes away what the call subscribed, and hands
    /// its place over; a success subscribes the call — paced, when it asked — when it
    /// <paramref name="answer"/> notifies and its connection holds no place for the procedure, or
    /// has it wait on a holder still in flight. What it returns undoes the success, should the answer
    /// not go out.
    /// </summary>
    public Action? Settle(SubscribingCall call, (bool IsFailure, bool Notifies, ProcedureAddress Procedure) answer)
    {
        var (callId, connectionHandle, paced) = call;
        var address = new CallAddress(callId, connectionHandle);
        var isSubscribed = TakeInFlight(address);

        // a failure subscribes nobody, whatever its resolver did before it, and leaves its place to
        // the call that waited on it
        if (answer.IsFailure)
        {
            if (isSubscribed)
            {
                notifications.Unregister(callId, connectionHandle);
                HandOver(TakeWaiting(address), connectionHandle);
            }

            return null;
        }

        var holder = answer.Notifies ? notifications.SubscriptionOf(answer.Procedure, connectionHandle) : null;

        // a notification's successful answer subscribes the connection under the request's call id,
        // before it goes out, so no notification sent once the requester has its answer can miss it
        if (answer.Notifies && holder is null)
        {
            notifications.Register(answer.Procedure, call);
            isSubscribed = true;
        }

        // answered while another call, still in flight, holds the place: the first answered waits
        if (holder is { } held
            && held != callId
            && IsInFlight(new CallAddress(held, connectionHandle))
            && !(_waiting.TryGetValue(connectionHandle, out var calls) && calls.ContainsKey(held)))
        {
            if (!_waiting.TryGetValue(connectionHandle, out var waiting))
            {
                waiting = [];
                _waiting[connectionHandle] = waiting;
            }

            waiting[held] = new Waiting(callId, paced, answer.Procedure);
        }

        if (!isSubscribed)
        {
            return null;
        }

        // answered, the call keeps its place: what waited on it waits no more, unless the answer does
        // not go out, which takes away what it subscribed and hands the place over
        var successor = TakeWaiting(address);

        return () =>
        {
            notifications.Unregister(callId, connectionHandle);
            HandOver(successor, connectionHandle);
        };
    }

    /// <summary>
    /// Subscribes a call to a procedure — paced, when it asked — in flight until its answer settles
    /// it, and gives its call id; a connection that holds the place already gives the holder's.
    /// </summary>
    public uint Subscribe(SubscribingCall call, ProcedureAddress procedure)
    {
        if (notifications.SubscriptionOf(procedure, call.ConnectionHandle) is { } holder)
        {
            return holder;
        }

        notifications.Register(procedure, call);

        if (!_inFlight.TryGetValue(call.ConnectionHandle, out var calls))
        {
            calls = [];
            _inFlight[call.ConnectionHandle] = calls;
        }

        calls.Add(call.CallId);

        return call.CallId;
    }

    /// <summary>Takes a subscription away, as its requester asks; whether the connection held it.</summary>
    public bool Unsubscribe(CallAddress call)
    {
        LeaveWaiting(call);

        return notifications.Unregister(call.CallId, call.ConnectionHandle) is not null;
    }

    private bool IsInFlight(CallAddress call)
    {
        return _inFlight.TryGetValue(call.ConnectionHandle, out var calls) && calls.Contains(call.CallId);
    }

    private bool TakeInFlight(CallAddress call)
    {
        if (!_inFlight.TryGetValue(call.ConnectionHandle, out var calls) || !calls.Remove(call.CallId))
        {
            return false;
        }

        if (calls.Count == 0)
        {
            _inFlight.Remove(call.ConnectionHandle);
        }

        return true;
    }

    // takes out the call waiting on the place `holder` holds
    private Waiting? TakeWaiting(CallAddress holder)
    {
        if (!_waiting.TryGetValue(holder.ConnectionHandle, out var calls) || !calls.Remove(holder.CallId, out var successor))
        {
            return null;
        }

        if (calls.Count == 0)
        {
            _waiting.Remove(holder.ConnectionHandle);
        }

        return successor;
    }

    // a call that leaves before the place it waits for is free waits no more
    private void LeaveWaiting(CallAddress call)
    {
        if (!_waiting.TryGetValue(call.ConnectionHandle, out var calls))
        {
            return;
        }

        foreach (var holder in calls.Where((entry) =>
        {
            return entry.Value.CallId == call.CallId;
        }).Select((entry) =>
        {
            return entry.Key;
        }).ToList())
        {
            calls.Remove(holder);
        }

        if (calls.Count == 0)
        {
            _waiting.Remove(call.ConnectionHandle);
        }
    }

    // the place goes to the call that waited on it, while its connection is open and holds none
    private void HandOver(Waiting? successor, string connectionHandle)
    {
        if (successor is { } waiting
            && isConnected(connectionHandle)
            && notifications.SubscriptionOf(waiting.Procedure, connectionHandle) is null)
        {
            notifications.Register(waiting.Procedure, new SubscribingCall(waiting.CallId, connectionHandle, waiting.Paced));
        }
    }

    // a call answered while another holds its place, the procedure, and whether it asked to be paced
    private sealed record Waiting(uint CallId, bool Paced, ProcedureAddress Procedure);
}
