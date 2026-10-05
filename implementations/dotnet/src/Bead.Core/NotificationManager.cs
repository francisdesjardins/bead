namespace Bead;

/// <summary>
/// A call that subscribes: where it is, whether its request asked it paced, and the session it runs
/// in, which bounds what it subscribes.
/// </summary>
/// <param name="CallId">Its call id.</param>
/// <param name="ConnectionHandle">Its connection.</param>
/// <param name="Paced">Whether it is paced.</param>
internal readonly record struct SubscribingCall(uint CallId, string ConnectionHandle, bool Paced)
{
    /// <summary>Its call's session: a credential's, by its identifier, or none for its connection's.</summary>
    public CallSession? Session { get; init; }

    /// <summary>Where it subscribes: its connection, and its session's identifier, none for its connection's.</summary>
    public SubscriptionPlace Place
    {
        get
        {
            return new SubscriptionPlace(ConnectionHandle, Session?.Identifier);
        }
    }
}

/// <summary>
/// Where a subscription is held (spec 11.3): its connection, and the session of its calls — a
/// credential's, by its identifier, or none for the connection's, which a call presenting none or
/// OPAQUE counts as.
/// </summary>
/// <param name="ConnectionHandle">Its connection.</param>
/// <param name="Session">Its credential's session's identifier; none for its connection's session.</param>
internal readonly record struct SubscriptionPlace(string ConnectionHandle, SessionIdentifier? Session);

/// <summary>One subscription: which procedure, which connection, under which call id.</summary>
/// <param name="CallId">The call id it travels on.</param>
/// <param name="ConnectionHandle">Its connection.</param>
/// <param name="Procedure">The procedure it is to.</param>
internal readonly record struct Subscription(uint CallId, string ConnectionHandle, ProcedureAddress Procedure)
{
    /// <summary>The credential's session that bounds it, by its identifier; none for its connection's.</summary>
    public SessionIdentifier? Session { get; init; }
}

/// <summary>
/// Who asked to be notified of which procedure, each subscription under the call id of the request
/// that made it — two connections may each hold the same one, and two sessions of one connection
/// each their own (spec 11.3). A subscription whose request asked to be paced holds its pacing,
/// which goes with it, queue and all, however it goes. Touched on its router's scheduler alone.
/// </summary>
internal sealed class NotificationManager(PacingLimits limits)
{
    // in the order they were made, as a JavaScript map keeps them: a session's end fails them, and a
    // notification goes to them, in that order
    private readonly Dictionary<ProcedureAddress, OrderedDictionary<SubscriptionPlace, uint>> _candidates = [];
    private readonly Dictionary<string, OrderedDictionary<uint, Target>> _targets = [];

    /// <summary>What hears each subscription as it goes, however it goes.</summary>
    public Action<Subscription>? OnRemove { get; set; }

    /// <summary>What hears each call as it subscribes, however it came to.</summary>
    public Action<SubscribingCall>? OnRegister { get; set; }

    /// <summary>
    /// The series a procedure's notifications count into, asked once as a subscription to it is
    /// made, so each notification reaches them through the subscription it goes under; none counts
    /// nothing.
    /// </summary>
    public Func<ProcedureAddress, NotifyingSeries?>? SeriesOf { get; set; }

    /// <summary>The connections subscribed to <paramref name="procedure"/>, each with its call id; a copy.</summary>
    public List<(string ConnectionHandle, uint CallId)> Candidates(ProcedureAddress procedure)
    {
        return _candidates.TryGetValue(procedure, out var candidates)
            ? [.. candidates.Select((candidate) =>
            {
                return (candidate.Key.ConnectionHandle, candidate.Value);
            })]
            : [];
    }

    /// <summary>The subscription a connection holds under <paramref name="callId"/>; none for none.</summary>
    public Subscription? SubscriptionAt(uint callId, string connectionHandle)
    {
        return _targets.TryGetValue(connectionHandle, out var targets) && targets.TryGetValue(callId, out var target)
            ? target.Subscription
            : null;
    }

    /// <summary>Forgets every subscription of a connection.</summary>
    public void Clean(string connectionHandle)
    {
        if (!_targets.TryGetValue(connectionHandle, out var targets))
        {
            return;
        }

        foreach (var target in targets.Values.ToList())
        {
            Remove(target);
        }
    }

    /// <summary>Forgets every subscription.</summary>
    public void CleanAll()
    {
        _candidates.Clear();
        _targets.Clear();
    }

    /// <summary>
    /// What it holds: the subscriptions it notifies and their connections, and what the paced ones
    /// queue — all together, and the fullest, which says how near its limits they are.
    /// </summary>
    public Gauges Gauges()
    {
        var counts = new Dictionary<string, long>
        {
            ["largestQueuedNotificationBytes"] = 0,
            ["largestQueuedNotifications"] = 0,
            ["pausedSubscriptions"] = 0,
            ["queuedNotificationBytes"] = 0,
            ["queuedNotifications"] = 0,
            ["notifiedSubscriptions"] = 0,
        };

        foreach (var targets in _targets.Values)
        {
            counts["notifiedSubscriptions"] += targets.Count;

            foreach (var pacing in targets.Values.Select((target) =>
            {
                return target.Pacing;
            }).OfType<NotificationPacing>())
            {
                counts["largestQueuedNotificationBytes"] = Math.Max(counts["largestQueuedNotificationBytes"], pacing.QueuedNotificationBytes);
                counts["largestQueuedNotifications"] = Math.Max(counts["largestQueuedNotifications"], pacing.QueuedNotifications);
                counts["pausedSubscriptions"] += pacing.IsPaused ? 1 : 0;
                counts["queuedNotificationBytes"] += pacing.QueuedNotificationBytes;
                counts["queuedNotifications"] += pacing.QueuedNotifications;
            }
        }

        // a subscription queues up to its limits, so the fullest one says how near they are
        return Bead.Gauges.Of(counts, _targets.Keys) with
        {
            Ceilings = new Dictionary<string, long>
            {
                ["largestQueuedNotificationBytes"] = limits.MaximumQueuedNotificationBytes,
                ["largestQueuedNotifications"] = limits.MaximumQueuedNotifications,
            },
        };
    }

    /// <summary>Whether a connection holds a subscription under <paramref name="callId"/>.</summary>
    public bool Has(uint callId, string connectionHandle)
    {
        return _targets.TryGetValue(connectionHandle, out var targets) && targets.ContainsKey(callId);
    }

    /// <summary>
    /// The subscription under <paramref name="callId"/>, as a notification goes under it: its pacing,
    /// when it is paced, and the series it counts into; none of either for none.
    /// </summary>
    public (NotificationPacing? Pacing, NotifyingSeries? Series) TargetOf(uint callId, string connectionHandle)
    {
        return _targets.TryGetValue(connectionHandle, out var targets) && targets.TryGetValue(callId, out var target)
            ? (target.Pacing, target.Series)
            : (null, null);
    }

    /// <summary>The pacing of the subscription under <paramref name="callId"/>, when it is paced.</summary>
    public NotificationPacing? PacingOf(uint callId, string connectionHandle)
    {
        return _targets.TryGetValue(connectionHandle, out var targets) && targets.TryGetValue(callId, out var target)
            ? target.Pacing
            : null;
    }

    /// <summary>
    /// Subscribes a call to a procedure — paced, when it asked — and gives its call id. A connection
    /// that holds the procedure already, or the call id, is an <see cref="InvalidOperationException"/>:
    /// the first subscription wins.
    /// </summary>
    public uint Register(ProcedureAddress procedure, SubscribingCall call)
    {
        if (SubscriptionOf(procedure, call.Place) is { } holder)
        {
            throw new InvalidOperationException(
                $"{call.ConnectionHandle} is subscribed to {procedure.ServiceId}/{procedure.ProcedureId} under call {holder} already, in that session");
        }

        if (Has(call.CallId, call.ConnectionHandle))
        {
            throw new InvalidOperationException($"{call.ConnectionHandle} holds call {call.CallId} already");
        }

        if (!_candidates.TryGetValue(procedure, out var candidates))
        {
            candidates = [];
            _candidates[procedure] = candidates;
        }

        if (!_targets.TryGetValue(call.ConnectionHandle, out var targets))
        {
            targets = [];
            _targets[call.ConnectionHandle] = targets;
        }

        candidates[call.Place] = call.CallId;
        targets[call.CallId] = new Target(
            new Subscription(call.CallId, call.ConnectionHandle, procedure) { Session = call.Session?.Identifier },
            call.Paced ? new NotificationPacing(limits) : null)
        {
            Series = SeriesOf?.Invoke(procedure),
        };
        OnRegister?.Invoke(call);

        return call.CallId;
    }

    /// <summary>
    /// The call id a connection holds its subscription to <paramref name="procedure"/> under, for its
    /// connection's session.
    /// </summary>
    public uint? SubscriptionOf(ProcedureAddress procedure, string connectionHandle)
    {
        return SubscriptionOf(procedure, new SubscriptionPlace(connectionHandle, null));
    }

    /// <summary>The call id a place holds its subscription to <paramref name="procedure"/> under.</summary>
    public uint? SubscriptionOf(ProcedureAddress procedure, SubscriptionPlace place)
    {
        return _candidates.TryGetValue(procedure, out var candidates) && candidates.TryGetValue(place, out var callId)
            ? callId
            : null;
    }

    /// <summary>Every subscription, of every connection.</summary>
    public List<Subscription> Subscriptions()
    {
        return [.. _targets.Values.SelectMany((targets) =>
        {
            return targets.Values.Select((target) =>
            {
                return target.Subscription;
            });
        })];
    }

    /// <summary>The subscriptions a connection holds.</summary>
    public List<Subscription> Subscriptions(string connectionHandle)
    {
        return _targets.TryGetValue(connectionHandle, out var targets)
            ? [.. targets.Values.Select((target) =>
            {
                return target.Subscription;
            })]
            : [];
    }

    /// <summary>Takes a subscription away, and gives its call id; none for one not held.</summary>
    public uint? Unregister(uint callId, string connectionHandle)
    {
        if (!_targets.TryGetValue(connectionHandle, out var targets) || !targets.TryGetValue(callId, out var target))
        {
            return null;
        }

        Remove(target);

        return callId;
    }

    private void Remove(Target target)
    {
        var (callId, connectionHandle, procedure) = target.Subscription;
        var place = new SubscriptionPlace(connectionHandle, target.Subscription.Session);

        if (_targets.TryGetValue(connectionHandle, out var targets))
        {
            targets.Remove(callId);

            if (targets.Count == 0)
            {
                _targets.Remove(connectionHandle);
            }
        }

        if (_candidates.TryGetValue(procedure, out var candidates))
        {
            candidates.Remove(place);

            if (candidates.Count == 0)
            {
                _candidates.Remove(procedure);
            }
        }

        OnRemove?.Invoke(target.Subscription);
    }

    // one subscription, its pacing when its request asked for one, and the series its
    // notifications count into
    private sealed record Target(Subscription Subscription, NotificationPacing? Pacing)
    {
        public NotifyingSeries? Series { get; init; }
    }
}
