namespace Bead;

/// <summary>A call that subscribes: where it is, and whether its request asked it paced.</summary>
/// <param name="CallId">Its call id.</param>
/// <param name="ConnectionHandle">Its connection.</param>
/// <param name="Paced">Whether it is paced.</param>
internal readonly record struct SubscribingCall(uint CallId, string ConnectionHandle, bool Paced);

/// <summary>One subscription: which procedure, which connection, under which call id.</summary>
/// <param name="CallId">The call id it travels on.</param>
/// <param name="ConnectionHandle">Its connection.</param>
/// <param name="Procedure">The procedure it is to.</param>
internal readonly record struct Subscription(uint CallId, string ConnectionHandle, ProcedureAddress Procedure);

/// <summary>
/// Who asked to be notified of which procedure, each subscription under the call id of the request
/// that made it — two connections may each hold the same one. A subscription whose request asked to
/// be paced holds its pacing, which goes with it, queue and all, however it goes. Touched on its
/// router's scheduler alone.
/// </summary>
internal sealed class NotificationManager(PacingLimits limits)
{
    // in the order they were made, as a JavaScript map keeps them: a session's end fails them, and a
    // notification goes to them, in that order
    private readonly Dictionary<ProcedureAddress, OrderedDictionary<string, uint>> _candidates = [];
    private readonly Dictionary<string, OrderedDictionary<uint, Target>> _targets = [];

    /// <summary>The connections subscribed to <paramref name="procedure"/>, each with its call id; a copy.</summary>
    public List<(string ConnectionHandle, uint CallId)> Candidates(ProcedureAddress procedure)
    {
        return _candidates.TryGetValue(procedure, out var candidates)
            ? [.. candidates.Select((candidate) =>
            {
                return (candidate.Key, candidate.Value);
            })]
            : [];
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
        if (SubscriptionOf(procedure, call.ConnectionHandle) is { } holder)
        {
            throw new InvalidOperationException(
                $"{call.ConnectionHandle} is subscribed to {procedure.ServiceId}/{procedure.ProcedureId} under call {holder} already");
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

        candidates[call.ConnectionHandle] = call.CallId;
        targets[call.CallId] = new Target(
            new Subscription(call.CallId, call.ConnectionHandle, procedure),
            call.Paced ? new NotificationPacing(limits) : null);

        return call.CallId;
    }

    /// <summary>The call id a connection holds its subscription to <paramref name="procedure"/> under.</summary>
    public uint? SubscriptionOf(ProcedureAddress procedure, string connectionHandle)
    {
        return _candidates.TryGetValue(procedure, out var candidates) && candidates.TryGetValue(connectionHandle, out var callId)
            ? callId
            : null;
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
            candidates.Remove(connectionHandle);

            if (candidates.Count == 0)
            {
                _candidates.Remove(procedure);
            }
        }
    }

    // one subscription, and its pacing when its request asked for one
    private sealed record Target(Subscription Subscription, NotificationPacing? Pacing);
}
