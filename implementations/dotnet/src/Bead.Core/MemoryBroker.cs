using System.Globalization;

namespace Bead;

/// <summary>How an in-memory broker is built.</summary>
public sealed record MemoryBrokerOptions
{
    /// <summary>The largest payload a message carries, a publication past it an <see cref="ArgumentException"/>; none when none.</summary>
    public long? MaximumMessageBytes { get; init; }

    /// <summary>
    /// The messages it holds for each subscriber, published to it and not yet handed on, past which
    /// it drops the one published, as a broker whose queue is full does (Mosquitto's
    /// <c>max_queued_messages</c>); none when none.
    /// </summary>
    public int? MaximumQueuedMessages { get; init; }

    /// <summary>What every adapter gives but one given its own: <see cref="BrokerDelivery.AtLeastOnce"/> unless told.</summary>
    public BrokerDelivery Delivery { get; init; } = BrokerDelivery.AtLeastOnce;

    /// <summary>What a message's life runs on; the system's clock when none.</summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>Where it hands each message on, in a turn of its own and in order: one of its own when none.</summary>
    internal SerialScheduler? Scheduler { get; init; }
}

/// <summary>Who an in-memory broker's adapter is, and what it offers.</summary>
public sealed record MemoryBrokerAdapterOptions
{
    /// <summary>The identity its link is taken by, as a broker takes any name; its participant refuses one that is no token.</summary>
    public required string Id { get; init; }

    /// <summary>What it offers of the optional capabilities: every one but a publisher's identity unless told.</summary>
    public BrokerCapabilities? Capabilities { get; init; }

    /// <summary>What it gives: its broker's unless told.</summary>
    public BrokerDelivery? Delivery { get; init; }
}

/// <summary>What befalls the next message published, as a test asks.</summary>
public enum MemoryBrokerFault
{
    /// <summary>Copied: it is handed on twice.</summary>
    Copy,

    /// <summary>Held behind the one after it on its topic: the next one published to that topic is handed on first.</summary>
    Hold,

    /// <summary>Dropped: it is handed on to none.</summary>
    Drop,

    /// <summary>Handed again to another member of its group, as a broker whose member's session ended unacknowledged does (MQTT 5 §4.8.2).</summary>
    Redeliver,
}

/// <summary>Which message a fault befalls.</summary>
public sealed record MemoryBrokerFaultOptions
{
    /// <summary>The topic of the next message it befalls; the next published to any when none.</summary>
    public IReadOnlyList<string>? Topic { get; init; }
}

/// <summary>
/// A broker in memory, in the core (spec 15.24): what its adapters link to, a participant over each,
/// in one process. It offers every capability but a publisher's identity — groups, wills,
/// publications refused when no subscriber takes them, a message's life — and hands each message on
/// copied as it is published, whole, in a later turn than its publish, in the order its publisher
/// published it to that topic, once; or, as a test asks, again, behind the next, never, or to
/// another member of its group. It holds a queue for each subscriber, bounded as it is given, past
/// which it drops a message, and publishes a link's will as the link is lost or taken over, never at
/// a stop. Its
/// handles' type is <see cref="TransportTypes.Broker"/>, and it never leaves the process, so its
/// legs are secure.
/// </summary>
public sealed class MemoryBroker
{
    private readonly MemoryBrokerOptions _options;
    private readonly TimeProvider _clock;
    // where its state is touched, one turn at a time, and each message handed on
    private readonly SerialScheduler _scheduler;
    private readonly List<MemoryBrokerAdapter> _adapters = [];
    // by a topic and its group, the member the next message goes to
    private readonly Dictionary<(string Topic, string Group), int> _turns = [];
    // what befalls the next messages, each with the topic it waits for, or none for any
    private readonly List<(string? Topic, MemoryBrokerFault Fault)> _faults = [];
    // by a topic, the message held behind the next one
    private readonly Dictionary<string, BrokerPublication> _held = new(StringComparer.Ordinal);

    /// <summary>A broker, holding no link yet; a bound under 1 is an <see cref="ArgumentOutOfRangeException"/>.</summary>
    public MemoryBroker(MemoryBrokerOptions? options = null)
    {
        _options = options ?? new MemoryBrokerOptions();

        ServerBounds.AssertCount((nameof(MemoryBrokerOptions.MaximumMessageBytes), _options.MaximumMessageBytes ?? 1));
        ServerBounds.AssertCount((nameof(MemoryBrokerOptions.MaximumQueuedMessages), _options.MaximumQueuedMessages ?? 1));

        _clock = _options.Clock ?? TimeProvider.System;
        _scheduler = _options.Scheduler ?? new SerialScheduler();
    }

    internal long? MaximumMessageBytes
    {
        get
        {
            return _options.MaximumMessageBytes;
        }
    }

    internal int? MaximumQueuedMessages
    {
        get
        {
            return _options.MaximumQueuedMessages;
        }
    }

    internal BrokerDelivery Delivery
    {
        get
        {
            return _options.Delivery;
        }
    }

    internal SerialScheduler Scheduler
    {
        get
        {
            return _scheduler;
        }
    }

    /// <summary>
    /// An adapter of the broker, its link known by its id: a second adapter of one id is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public MemoryBrokerAdapter Adapter(MemoryBrokerAdapterOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(options.Id, nameof(options));

        var adapter = new MemoryBrokerAdapter(this, options);

        lock (_adapters)
        {
            if (_adapters.Any((other) =>
            {
                return other.Id == options.Id;
            }))
            {
                throw new ArgumentException($"an adapter of this broker is {options.Id} already", nameof(options));
            }

            _adapters.Add(adapter);
        }

        return adapter;
    }

    /// <summary>
    /// What befalls the next message published, to its topic where one is given, as a test asks:
    /// copied, held behind the one after it on its topic, dropped, or handed again to another member
    /// of its group. Each fault asked befalls one message, in the order they were asked.
    /// </summary>
    public void Fault(MemoryBrokerFault fault, MemoryBrokerFaultOptions? options = null)
    {
        var topic = options?.Topic is { } tokens ? KeyOf(tokens) : null;

        _scheduler.Post(() =>
        {
            _faults.Add((topic, fault));
        });
    }

    /// <summary>A topic's key, its tokens joined: what the broker matches a subscription by.</summary>
    internal static string KeyOf(IReadOnlyList<string> topic)
    {
        ArgumentNullException.ThrowIfNull(topic);

        return string.Join('/', topic);
    }

    /// <summary>
    /// Runs <paramref name="action"/> in one turn of the broker's: what it publishes is published in
    /// that turn, each in its order, none handed on before it ends.
    /// </summary>
    internal Task Turn(Action action)
    {
        return _scheduler.Run(() =>
        {
            // ! a refusal is the call's task, never a throw into the turn that called
            try
            {
                action();
            }
            catch (Exception reason)
            {
                return Task.FromException(reason);
            }

            return Task.CompletedTask;
        });
    }

    /// <summary>As <see cref="Turn"/>, giving what <paramref name="action"/> gives.</summary>
    internal Task<T> Turn<T>(Func<T> action)
    {
        return _scheduler.Run(() =>
        {
            try
            {
                return Task.FromResult(action());
            }
            catch (Exception reason)
            {
                return Task.FromException<T>(reason);
            }
        });
    }

    /// <summary>
    /// In a turn of the broker's: a publication routed to each subscription that matches its topic —
    /// each alone, and one member of each group, in turn — as the fault asked of it says. False when
    /// no subscription took it.
    /// </summary>
    internal bool Route((BrokerPublication Publication, bool IsRetained) published)
    {
        var (publication, isRetained) = published;
        var topic = KeyOf(publication.Topic);
        var targets = TargetsOf(topic);

        if (targets.Count == 0)
        {
            return false;
        }

        var at = _faults.FindIndex((asked) =>
        {
            return asked.Topic is null || asked.Topic == topic;
        });
        MemoryBrokerFault? fault = null;

        if (at >= 0)
        {
            fault = _faults[at].Fault;
            _faults.RemoveAt(at);
        }

        if (fault == MemoryBrokerFault.Drop)
        {
            return true;
        }

        if (fault == MemoryBrokerFault.Hold)
        {
            _held[topic] = publication;

            return true;
        }

        var expires = publication.ExpiresAfter is { } life ? _clock.GetUtcNow() + life : (DateTimeOffset?)null;

        foreach (var (adapter, group) in targets)
        {
            adapter.Enqueue((publication, isRetained, expires));

            if (fault == MemoryBrokerFault.Copy)
            {
                adapter.Enqueue((publication, isRetained, expires));
            }

            // * again to another member of its group: the next in turn
            if (fault == MemoryBrokerFault.Redeliver && group is not null && MemberOf((topic, group)) is { } other && other != adapter)
            {
                other.Enqueue((publication, isRetained, expires));
            }
        }

        // what was held behind this one, handed on after it
        if (_held.Remove(topic, out var held))
        {
            HandHeld(held);
        }

        return true;
    }

    /// <summary>Whether a message whose life ends at <paramref name="expires"/> is still alive.</summary>
    internal bool IsAlive(DateTimeOffset? expires)
    {
        return expires is not { } end || _clock.GetUtcNow() < end;
    }

    // a message held behind the next one, handed on after it to each subscription of its topic
    private void HandHeld(BrokerPublication held)
    {
        var expires = held.ExpiresAfter is { } life ? _clock.GetUtcNow() + life : (DateTimeOffset?)null;

        foreach (var (adapter, _) in TargetsOf(KeyOf(held.Topic)))
        {
            adapter.Enqueue((held, false, expires));
        }
    }

    // each subscription a message to a topic goes to: every one held alone, and, of each group, its
    // member in turn
    private List<(MemoryBrokerAdapter Adapter, string? Group)> TargetsOf(string topic)
    {
        List<MemoryBrokerAdapter> adapters;

        lock (_adapters)
        {
            adapters = [.. _adapters];
        }

        var targets = new List<(MemoryBrokerAdapter, string?)>();
        var groups = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var adapter in adapters)
        {
            if (adapter.SubscriptionOf(topic) is not { } subscribed)
            {
                continue;
            }

            if (subscribed.Group is { } group)
            {
                groups.Add(group);
            }
            else
            {
                targets.Add((adapter, null));
            }
        }

        foreach (var group in groups)
        {
            if (MemberOf((topic, group)) is { } member)
            {
                targets.Add((member, group));
                _turns[(topic, group)] = _turns.GetValueOrDefault((topic, group)) + 1;
            }
        }

        return targets;
    }

    // the member of a group whose turn it is
    private MemoryBrokerAdapter? MemberOf((string Topic, string Group) group)
    {
        List<MemoryBrokerAdapter> members;

        lock (_adapters)
        {
            members = [.. _adapters.Where((adapter) =>
            {
                return adapter.SubscriptionOf(group.Topic) is { Group: { } held } && held == group.Group;
            })];
        }

        return members.Count == 0 ? null : members[_turns.GetValueOrDefault(group) % members.Count];
    }
}

/// <summary>
/// One link to a <see cref="MemoryBroker"/> (spec 15.24): the adapter its participant is built
/// over, its acknowledgements counted, and, on a test's word, its link lost or taken over.
/// </summary>
public sealed class MemoryBrokerAdapter : IBrokerAdapter
{
    private readonly MemoryBroker _broker;
    private readonly BrokerCapabilities _capabilities;
    private readonly BrokerDelivery _delivery;
    // its subscriptions, by topic, each with its group or none; touched on its broker's scheduler
    private readonly Dictionary<string, BrokerSubscription> _subscriptions = new(StringComparer.Ordinal);
    // what its broker routed to it and has not handed on yet, in order
    private readonly Queue<(BrokerPublication Publication, bool IsRetained, DateTimeOffset? Expires)> _queue = new();
    private BrokerPublication? _will;
    private volatile bool _isLinked;
    private int _unsettled;

    internal MemoryBrokerAdapter(MemoryBroker broker, MemoryBrokerAdapterOptions options)
    {
        _broker = broker;
        Id = options.Id;
        _capabilities = options.Capabilities ?? (BrokerCapabilities.Groups | BrokerCapabilities.Will | BrokerCapabilities.NoSubscriber | BrokerCapabilities.Expiry);
        _delivery = options.Delivery ?? broker.Delivery;
    }

    /// <inheritdoc/>
    public event Action<BrokerMessage>? Message;

    /// <inheritdoc/>
    public event Action<BrokerDown>? Down;

    /// <summary>Its handles' type, <see cref="TransportTypes.Broker"/>.</summary>
    public string Type
    {
        get
        {
            return TransportTypes.Broker;
        }
    }

    /// <inheritdoc/>
    public string Id { get; }

    /// <summary>What it offers: every capability but a publisher's identity unless told.</summary>
    public BrokerCapabilities Capabilities
    {
        get
        {
            return _capabilities;
        }
    }

    /// <summary>What it gives: its broker's unless told.</summary>
    public BrokerDelivery Delivery
    {
        get
        {
            return _delivery;
        }
    }

    /// <summary>It is secure: it never leaves the process.</summary>
    public bool IsSecure
    {
        get
        {
            return true;
        }
    }

    /// <summary>Its broker's bound on a message, whatever its inbox's topic, or the largest a receive bound's field holds when none: it has no packet to count.</summary>
    public long ReceiveBound(IReadOnlyList<string> topic)
    {
        return _broker.MaximumMessageBytes ?? BrokerParcels.LargestBound;
    }

    /// <summary>Whether its link is up: started, and neither stopped nor lost.</summary>
    public bool IsLinked
    {
        get
        {
            return _isLinked;
        }
    }

    /// <summary>The messages handed it, at least once, that it has not acknowledged.</summary>
    public int Unsettled
    {
        get
        {
            return Volatile.Read(ref _unsettled);
        }
    }

    /// <summary>Its broker's bound on a message, whatever its topic, or none.</summary>
    public long MaximumPayloadBytes(IReadOnlyList<string> topic)
    {
        return _broker.MaximumMessageBytes ?? long.MaxValue;
    }

    /// <summary>
    /// Links, its will kept for a loss, no subscription held from a link before: a link keeps no
    /// session. Refused while linked, and given a will where it offers none.
    /// </summary>
    public Task Start(BrokerStart? start = null)
    {
        return _broker.Turn(() =>
        {
            if (_isLinked)
            {
                throw new InvalidOperationException($"the link of {Id} is up already");
            }

            if (start?.Will is not null && (_capabilities & BrokerCapabilities.Will) == 0)
            {
                throw new ArgumentException($"the adapter of {Id} takes no will", nameof(start));
            }

            _subscriptions.Clear();
            _queue.Clear();
            _will = start?.Will;
            _isLinked = true;
        });
    }

    /// <summary>Holds a subscription to <paramref name="topic"/>, alone or in its group, from the next message published to it.</summary>
    public Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null)
    {
        var key = MemoryBroker.KeyOf(topic);

        return _broker.Turn(() =>
        {
            AssertLinked();

            if (subscription?.Group is not null && (_capabilities & BrokerCapabilities.Groups) == 0)
            {
                throw new ArgumentException($"the adapter of {Id} offers no groups", nameof(subscription));
            }

            _subscriptions[key] = subscription ?? new BrokerSubscription();
        });
    }

    /// <summary>Lets the subscription go: what was routed to it before is handed on all the same.</summary>
    public Task Unsubscribe(IReadOnlyList<string> topic)
    {
        var key = MemoryBroker.KeyOf(topic);

        return _broker.Turn(() =>
        {
            _subscriptions.Remove(key);
        });
    }

    /// <summary>
    /// Publishes, routed in a turn of the broker's, copied as it is published; settles once routed:
    /// <see cref="BrokerPublished.Taken"/>, or <see cref="BrokerPublished.NoSubscriber"/> when no
    /// subscription takes it and it offers that refusal. A payload past its broker's bound is an
    /// <see cref="ArgumentException"/>, a link down an <see cref="InvalidOperationException"/>, and
    /// one given up on before it goes an <see cref="OperationCanceledException"/>.
    /// </summary>
    public Task<BrokerPublished> Publish(BrokerPublication publication)
    {
        return Publishing((publication, false));
    }

    /// <summary>As <see cref="Publish"/>, handed on marked retained, as a broker hands a message it kept, as a test asks.</summary>
    public Task<BrokerPublished> PublishRetained(BrokerPublication publication)
    {
        return Publishing((publication, true));
    }

    /// <summary>Ends its link cleanly: its subscriptions and its queue let go of, no will published.</summary>
    public Task Stop()
    {
        return _broker.Turn(() =>
        {
            _isLinked = false;
            _will = null;
            _subscriptions.Clear();
            _queue.Clear();
        });
    }

    /// <summary>
    /// Its link lost, as a test asks: its subscriptions and its queue let go of, its will
    /// published, then <see cref="Down"/> raised, in a later turn of its broker's.
    /// </summary>
    public void Lose()
    {
        _broker.Scheduler.Post(() =>
        {
            Lost(new BrokerDown());
        });
    }

    /// <summary>
    /// Its link taken over by another link of its id, as a test asks: as <see cref="Lose"/>, its
    /// subscriptions dropped, since the link that takes it over holds none, and its will published,
    /// then <see cref="Down"/> raised telling it taken over. Its broker keeps one adapter to an id.
    /// </summary>
    public void TakeOver()
    {
        _broker.Scheduler.Post(() =>
        {
            Lost(new BrokerDown { IsTakenOver = true });
        });
    }

    /// <summary>In a turn of its broker's: its link lost or taken over, its will published, <see cref="Down"/> raised.</summary>
    internal void Lost(BrokerDown down)
    {
        if (!_isLinked)
        {
            return;
        }

        _isLinked = false;
        _subscriptions.Clear();
        _queue.Clear();

        var will = _will;

        _will = null;

        if (will is not null)
        {
            _broker.Route((will, false));
        }

        Down?.Invoke(down);
    }

    /// <summary>The subscription it holds to <paramref name="topic"/>'s key, or none.</summary>
    internal BrokerSubscription? SubscriptionOf(string topic)
    {
        return _isLinked ? _subscriptions.GetValueOrDefault(topic) : null;
    }

    /// <summary>In a turn of its broker's: a message routed to it, queued and handed on in a later turn, or dropped past its queue's bound.</summary>
    internal void Enqueue((BrokerPublication Publication, bool IsRetained, DateTimeOffset? Expires) routed)
    {
        if (_broker.MaximumQueuedMessages is { } bound && _queue.Count >= bound)
        {
            return;
        }

        _queue.Enqueue(routed);
        _broker.Scheduler.Post(HandOne);
    }

    private Task<BrokerPublished> Publishing((BrokerPublication Publication, bool IsRetained) published)
    {
        ArgumentNullException.ThrowIfNull(published.Publication);

        return _broker.Turn(() =>
        {
            AssertLinked();

            if (_broker.MaximumMessageBytes is { } bound && published.Publication.Payload.Length > bound)
            {
                throw new ArgumentException(string.Create(CultureInfo.InvariantCulture, $"a payload of {published.Publication.Payload.Length} bytes, past the broker's maximumMessageBytes, {bound} bytes"), nameof(published));
            }

            if (published.Publication.CancellationToken.IsCancellationRequested)
            {
                throw new OperationCanceledException("the publication was given up on", published.Publication.CancellationToken);
            }

            // * copied as it is published: the publisher's buffer stays its own
            var copy = published.Publication with
            {
                Topic = [.. published.Publication.Topic],
                Payload = published.Publication.Payload.ToArray(),
            };
            var isRouted = _broker.Route((copy, published.IsRetained));

            return !isRouted && (_capabilities & BrokerCapabilities.NoSubscriber) != 0 ? BrokerPublished.NoSubscriber : BrokerPublished.Taken;
        });
    }

    private void AssertLinked()
    {
        if (!_isLinked)
        {
            throw new InvalidOperationException($"the link of {Id} is not up");
        }
    }

    // in a turn of its own: the next message queued, handed on while its link stands and its life
    // lasts, its acknowledgement counted until given, at least once
    private void HandOne()
    {
        if (!_queue.TryDequeue(out var next) || !_isLinked || !_broker.IsAlive(next.Expires))
        {
            return;
        }

        var isCounted = _delivery == BrokerDelivery.AtLeastOnce;

        if (isCounted)
        {
            Interlocked.Increment(ref _unsettled);
        }

        var message = new BrokerMessage(next.Publication, new BrokerMessageOptions
        {
            IsRetained = next.IsRetained,
            Settle = () =>
            {
                if (isCounted)
                {
                    Interlocked.Decrement(ref _unsettled);
                }
            },
        });

        Message?.Invoke(message);
    }
}
