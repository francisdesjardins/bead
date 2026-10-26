using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;

namespace Bead;

/// <summary>How a broker's participant is built (spec 15.21, 15.23).</summary>
public sealed record BrokerParticipantOptions
{
    /// <summary>The first token of every topic, one for every participant of a deployment: <c>bead</c> unless told; a token.</summary>
    public string Root { get; init; } = "bead";

    /// <summary>What its stack runs on, the rate of parts and a server's accept timeout among them; the system's clock when none.</summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>
    /// How long a connection is silent before it is pinged, and a ping unanswered before it is
    /// closed with 4001 (spec 15.21): 30 seconds unless told, or
    /// <see cref="Timeout.InfiniteTimeSpan"/>, never; on the platform's timer, whatever clock it is
    /// given (0011).
    /// </summary>
    public TimeSpan Heartbeat { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>What it holds in parts across its connections (spec 15.23): 268,435,456 bytes unless told.</summary>
    public long HeldBytesBudget { get; init; } = 268_435_456;

    /// <summary>One envelope's parts together (spec 15.23): the router's <c>maximumEnvelopeBytes</c> unless told, at its default.</summary>
    public long MaximumEnvelopePartsBytes { get; init; } = RouterLimits.Default.MaximumEnvelopeBytes;

    /// <summary>The slowest parts may come, in bytes a second, once the grace passed since an envelope's first (spec 15.12): 240 unless told; 0 holds none.</summary>
    public int MinimumBodyBytesPerSecond { get; init; } = ServerBounds.MinimumBodyBytesPerSecond;

    /// <summary>How long an envelope's parts come before their rate is held (spec 15.12): 5 seconds unless told; never is refused.</summary>
    public TimeSpan BodyGracePeriod { get; init; } = ServerBounds.BodyGracePeriod;

    /// <summary>The delivery its application requires: an adapter that gives less is refused as it is built (spec 15.19); none when none.</summary>
    public BrokerDelivery? RequireDelivery { get; init; }

    /// <summary>How its link connects again once lost, each time a new incarnation (spec 15.21): a second between attempts, without end, unless told.</summary>
    public TransportReconnectOptions? Reconnect { get; init; }

    /// <summary>
    /// Whether its link connects again once lost, as <see cref="Reconnect"/> says: true unless told;
    /// false leaves it down, reported, until a start or a connect links it anew.
    /// </summary>
    public bool IsReconnecting { get; init; } = true;

    /// <summary>Where its state is touched, one turn at a time: one of its own when none; the tests' way to share one with a broker in memory.</summary>
    internal SerialScheduler? Scheduler { get; init; }
}

/// <summary>
/// One link of a side to a broker (spec 15.16, 15.21), over its adapter: its inbox, the topic every
/// parcel of its connections reaches, subscribed as its link starts, before anything of it goes;
/// its incarnation, 16 bytes drawn from a cryptographic source each time its link connects, which
/// keeps no broker session; the connections of its client and server transports, by the pair of
/// halves their ends drew; its will, a GONE its broker publishes where its adapter offers one; and
/// the heartbeat of each connection. When its link goes down it closes each connection, unclean,
/// and connects again as another incarnation, its inbox and names subscribed anew before anything
/// goes, then resets each peer it held a connection with.
/// </summary>
public sealed class BrokerParticipant : IAsyncDisposable
{
    private readonly IBrokerAdapter _adapter;
    private readonly BrokerParticipantOptions _options;
    private readonly TimeProvider _clock;
    // where its state is touched, one turn at a time
    private readonly SerialScheduler _scheduler;
    private readonly Lock _gate = new();
    // the connections held, by their pair
    private readonly Dictionary<(ulong Opener, ulong Acceptor), BrokerConnection> _connections = [];
    // the connects awaiting their ACCEPT or REFUSE, by their opener's half
    private readonly Dictionary<ulong, BrokerPendingConnect> _connects = [];
    // the server transports over it, by each name they serve
    private readonly Dictionary<string, BrokerTransportServer> _names = new(StringComparer.Ordinal);
    private readonly List<BrokerTransportServer> _servers = [];
    // the peers' departures it holds a subscription to, by the peer's id, and the connections each counts
    private readonly Dictionary<string, int> _departures = new(StringComparer.Ordinal);
    private readonly BrokerBudget _budget;
    // how many connections it holds, read from any thread
    private int _held;
    private Task? _starting;
    private TaskCompletionSource _live = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _isStopped;

    /// <summary>
    /// A participant over <paramref name="adapter"/>, not yet started. An adapter whose id is no
    /// token, a root that is none, or an adapter that delivers at most once where at least once is
    /// required, is an <see cref="ArgumentException"/>; a bound out of its range, an
    /// <see cref="ArgumentOutOfRangeException"/> naming it.
    /// </summary>
    public BrokerParticipant(IBrokerAdapter adapter, BrokerParticipantOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(adapter);

        var given = options ?? new BrokerParticipantOptions();

        if (!BrokerParcels.IsToken(adapter.Id))
        {
            throw new ArgumentException($"a participant's id is a token of base64url's alphabet, 1 to 64 characters, not \"{adapter.Id}\"", nameof(adapter));
        }

        if (!BrokerParcels.IsToken(given.Root))
        {
            throw new ArgumentException($"a participant's root is a token of base64url's alphabet, 1 to 64 characters, not \"{given.Root}\"", nameof(options));
        }

        if (given.RequireDelivery == BrokerDelivery.AtLeastOnce && adapter.Delivery == BrokerDelivery.AtMostOnce)
        {
            throw new ArgumentException($"its application requires delivery at least once, and the adapter of {adapter.Id} gives it at most once", nameof(options));
        }

        ServerBounds.AssertCount((nameof(BrokerParticipantOptions.HeldBytesBudget), given.HeldBytesBudget));
        ServerBounds.AssertCount((nameof(BrokerParticipantOptions.MaximumEnvelopePartsBytes), given.MaximumEnvelopePartsBytes));
        ServerBounds.AssertCountOrNone((nameof(BrokerParticipantOptions.MinimumBodyBytesPerSecond), given.MinimumBodyBytesPerSecond));

        var receiveBound = Math.Min(adapter.ReceiveBound, BrokerParcels.LargestBound);

        if (receiveBound < BrokerParcels.LeastBound)
        {
            throw new ArgumentException(string.Create(CultureInfo.InvariantCulture, $"a participant's inbox takes a parcel of 1,024 bytes at least, and the adapter of {adapter.Id} takes {receiveBound}"), nameof(adapter));
        }

        _options = given with
        {
            Heartbeat = Clocks.AssertHeld(("a heartbeat", nameof(BrokerParticipantOptions.Heartbeat)), given.Heartbeat),
            BodyGracePeriod = Clocks.AssertHeldFinite((nameof(BrokerParticipantOptions.BodyGracePeriod), nameof(BrokerParticipantOptions.BodyGracePeriod)), given.BodyGracePeriod),
        };
        _adapter = adapter;
        _clock = _options.Clock ?? TimeProvider.System;
        _scheduler = _options.Scheduler ?? new SerialScheduler();
        _budget = new BrokerBudget(_options.HeldBytesBudget);
        PartsBounds = new BrokerPartsBounds
        {
            MaximumEnvelopePartsBytes = _options.MaximumEnvelopePartsBytes,
            MinimumBodyBytesPerSecond = _options.MinimumBodyBytesPerSecond,
            BodyGracePeriod = _options.BodyGracePeriod,
            Budget = _budget,
            Clock = _clock,
        };
        adapter.Message += (message) =>
        {
            _scheduler.Post(() =>
            {
                Take(message);
            });
        };
        adapter.Down += () =>
        {
            _scheduler.Post(LinkDown);
        };
    }

    /// <summary>What it reports of its own: a message to it that is no parcel, which it drops, or its link given up on.</summary>
    public event Action<Exception>? Error;

    /// <summary>The identity its broker authenticates its link by: its adapter's.</summary>
    public string Id
    {
        get
        {
            return _adapter.Id;
        }
    }

    /// <summary>The first token of each of its topics.</summary>
    public string Root
    {
        get
        {
            return _options.Root;
        }
    }

    /// <summary>What its stack runs on: the clock its options gave, the system's when none.</summary>
    public TimeProvider Clock
    {
        get
        {
            return _clock;
        }
    }

    /// <summary>Whether its link is up: started, and not lost since, or connected again.</summary>
    public bool IsLinked
    {
        get
        {
            lock (_gate)
            {
                return _live.Task.IsCompletedSuccessfully;
            }
        }
    }

    internal SerialScheduler Scheduler
    {
        get
        {
            return _scheduler;
        }
    }

    internal IBrokerAdapter Adapter
    {
        get
        {
            return _adapter;
        }
    }

    internal BrokerPartsBounds PartsBounds { get; }

    internal TimeSpan HeartbeatPeriod
    {
        get
        {
            return _options.Heartbeat;
        }
    }

    /// <summary>Its incarnation, drawn as its link last connected.</summary>
    internal UInt128 Incarnation { get; private set; }

    /// <summary>The receive bound it announces: what its adapter's inbox takes whole, as its field holds it.</summary>
    internal long ReceiveBound
    {
        get
        {
            return Math.Min(_adapter.ReceiveBound, BrokerParcels.LargestBound);
        }
    }

    /// <summary>What it holds in parts across its connections.</summary>
    internal long PartsBytes
    {
        get
        {
            return _budget.Held;
        }
    }

    /// <summary>The peers' departures it holds a subscription to.</summary>
    internal int Departures
    {
        get
        {
            return _departures.Count;
        }
    }

    /// <summary>
    /// What it holds: <c>connections</c>, those of its transports, half-open among them;
    /// <c>partsBytes</c>, what it holds in parts; <c>departures</c>, the peers' departures it
    /// subscribes.
    /// </summary>
    public Gauges Gauges()
    {
        // * counts read as they stand, from any thread: each one its turn's last word
        return new Gauges
        {
            Counts = new Dictionary<string, long>
            {
                ["connections"] = Volatile.Read(ref _held),
                ["departures"] = Departures,
                ["partsBytes"] = PartsBytes,
            },
            Ceilings = new Dictionary<string, long> { ["partsBytes"] = _budget.Budget },
        };
    }

    /// <summary>
    /// A server transport over it, serving <see cref="BrokerTransportServerOptions.Names"/>; a name
    /// another of its server transports serves is an <see cref="ArgumentException"/>.
    /// </summary>
    public BrokerTransportServer Server(BrokerTransportServerOptions options)
    {
        var server = new BrokerTransportServer(this, options);

        lock (_gate)
        {
            foreach (var name in server.Names)
            {
                if (_names.ContainsKey(name))
                {
                    throw new ArgumentException($"the name {name} is served already by a server transport of this participant", nameof(options));
                }
            }

            foreach (var name in server.Names)
            {
                _names[name] = server;
            }

            _servers.Add(server);
        }

        return server;
    }

    /// <summary>A client transport over it, of one connection at a time.</summary>
    public BrokerTransportClient Client(BrokerTransportClientOptions? options = null)
    {
        return new BrokerTransportClient(this, options);
    }

    /// <summary>
    /// Starts its link: its incarnation drawn, its adapter started, its will set where it offers
    /// one, its inbox subscribed and the names of its server transports that serve; settles once all
    /// of it is held. A second start shares the first.
    /// </summary>
    public Task Start()
    {
        lock (_gate)
        {
            if (_isStopped)
            {
                return Task.FromException(new InvalidOperationException($"the participant {Id} is stopped"));
            }

            _starting ??= _scheduler.Run(Link);

            return _starting;
        }
    }

    /// <summary>Closes each connection with a CLOSE of 1001, then ends its link cleanly, so its broker publishes no will (spec 15.21).</summary>
    public async Task Stop()
    {
        lock (_gate)
        {
            if (_isStopped)
            {
                return;
            }

            _isStopped = true;
        }

        await _scheduler.Run(async () =>
        {
            // ! unlinked first: what its connections' ends set going — a name served again among
            // them — finds no link to subscribe on
            lock (_gate)
            {
                _live = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            }

            foreach (var connection in _connections.Values.ToList())
            {
                connection.Close((1001, false));
            }

            foreach (var pending in _connects.Values.ToList())
            {
                pending.Down($"the participant {Id} stopped as it connected");
            }

            _connects.Clear();
            await _adapter.Stop();
        });
    }

    /// <summary>As <see cref="Stop"/>.</summary>
    public async ValueTask DisposeAsync()
    {
        await Stop();
    }

    /// <summary>A participant's inbox: its root, <c>i</c> and its id (spec 15.16).</summary>
    internal IReadOnlyList<string> InboxOf(string id)
    {
        return [_options.Root, "i", id];
    }

    /// <summary>A server's name: its root, <c>s</c> and the name.</summary>
    internal IReadOnlyList<string> NameOf(string name)
    {
        return [_options.Root, "s", name];
    }

    /// <summary>A participant's departure: its root, <c>d</c> and its id.</summary>
    internal IReadOnlyList<string> DepartureOf(string id)
    {
        return [_options.Root, "d", id];
    }

    /// <summary>The largest payload its adapter publishes to <paramref name="topic"/>, as a receive bound's field holds it.</summary>
    internal long MaximumPayloadBytes(IReadOnlyList<string> topic)
    {
        return Math.Min(_adapter.MaximumPayloadBytes(topic), BrokerParcels.LargestBound);
    }

    /// <summary>Settles once its link is up, started or connected again; a cancel ends the wait.</summary>
    internal async Task WhenLinked(CancellationToken cancellationToken)
    {
        await Start().WaitAsync(cancellationToken);

        Task live;

        lock (_gate)
        {
            live = _live.Task;
        }

        await live.WaitAsync(cancellationToken);
    }

    /// <summary>A half drawn from a cryptographic source, never all zero, none it holds already (spec 15.17).</summary>
    internal ulong DrawHalf()
    {
        var bytes = new byte[8];

        while (true)
        {
            RandomNumberGenerator.Fill(bytes);

            var half = BinaryPrimitives.ReadUInt64BigEndian(bytes);

            if (half != 0 && !_connects.ContainsKey(half) && !_connections.Keys.Any((pair) =>
            {
                return pair.Opener == half || pair.Acceptor == half;
            }))
            {
                return half;
            }
        }
    }

    /// <summary>A publication of its adapter's, its parcel in its payload.</summary>
    internal Task<BrokerPublished> Publish(BrokerPublication publication)
    {
        var expires = publication.ExpiresAfter is { } life && (_adapter.Capabilities & BrokerCapabilities.Expiry) != 0 ? life : (TimeSpan?)null;

        try
        {
            return _adapter.Publish(publication with { ExpiresAfter = expires });
        }
        catch (Exception reason) when (reason is not ArgumentException)
        {
            return Task.FromException<BrokerPublished>(reason);
        }
    }

    /// <summary>In its turn: a connection held by its pair.</summary>
    internal void Hold(BrokerConnection connection)
    {
        _connections[connection.Pair] = connection;
        Volatile.Write(ref _held, _connections.Count);
    }

    /// <summary>In its turn: a connection that ended, held no more.</summary>
    internal void Forget(BrokerConnection connection)
    {
        if (_connections.TryGetValue(connection.Pair, out var held) && held == connection)
        {
            _connections.Remove(connection.Pair);
            Volatile.Write(ref _held, _connections.Count);
        }
    }

    /// <summary>In its turn: a connect awaiting the first ACCEPT or REFUSE naming its half.</summary>
    internal void Await(BrokerPendingConnect pending)
    {
        _connects[pending.Opener] = pending;
    }

    /// <summary>In its turn: a connect that ended, awaiting nothing more, so a late ACCEPT of it is reset.</summary>
    internal void GiveUp(BrokerPendingConnect pending)
    {
        if (_connects.TryGetValue(pending.Opener, out var held) && held == pending)
        {
            _connects.Remove(pending.Opener);
        }
    }

    /// <summary>In its turn: a RESET of a pair, to its peer's inbox.</summary>
    internal void Reset((string PeerId, (ulong Opener, ulong Acceptor) Pair) reset)
    {
        var (opener, acceptor) = reset.Pair;

        _ = Publish(new BrokerPublication
        {
            Topic = InboxOf(reset.PeerId),
            Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Reset, Opener = opener, Acceptor = acceptor }),
        });
    }

    /// <summary>
    /// In its turn: a connection to a peer opened, or ended, by <c>Count</c>: its departure
    /// subscribed while it holds one, where its adapter offers a will (spec 15.21), never awaited.
    /// </summary>
    internal void Depart((string PeerId, int Count) departing)
    {
        if ((_adapter.Capabilities & BrokerCapabilities.Will) == 0)
        {
            return;
        }

        var (peerId, count) = departing;
        var held = _departures.GetValueOrDefault(peerId) + count;
        var topic = DepartureOf(peerId);

        if (held > 0)
        {
            if (!_departures.ContainsKey(peerId))
            {
                Quietly(_adapter.Subscribe(topic));
            }

            _departures[peerId] = held;
        }
        else if (_departures.Remove(peerId))
        {
            Quietly(_adapter.Unsubscribe(topic));
        }
    }

    /// <summary>Subscribes a name served, alone or in its group; settles once its broker holds it.</summary>
    internal Task Subscribe((string Name, bool IsInGroup) name)
    {
        return _adapter.Subscribe(NameOf(name.Name), new BrokerSubscription { Group = name.IsInGroup ? name.Name : null });
    }

    /// <summary>Lets a name go.</summary>
    internal Task Unsubscribe(string name)
    {
        return _adapter.Unsubscribe(NameOf(name));
    }

    /// <summary>
    /// What it ends no connection for, reported on its own and by each of its server's transports
    /// with no handle: a message that is no parcel, or an OPEN that does not read, which it drops
    /// (spec 15.1, 15.17).
    /// </summary>
    internal void Report(Exception reason)
    {
        List<BrokerTransportServer> servers;

        lock (_gate)
        {
            servers = [.. _servers];
        }

        Error?.Invoke(reason);

        foreach (var server in servers)
        {
            server.Report(reason);
        }
    }

    // a task whose failure is the link's to find: its loss tells it
    private static void Quietly(Task task)
    {
        _ = task.ContinueWith(
            (failed) =>
            {
                _ = failed.Exception;
            },
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    // in its turn: its link connected, a new incarnation, its inbox and its names subscribed before
    // anything goes; then each peer of a former incarnation reset
    private async Task Link()
    {
        var bytes = new byte[16];

        RandomNumberGenerator.Fill(bytes);
        Incarnation = BinaryPrimitives.ReadUInt128BigEndian(bytes);

        var will = (_adapter.Capabilities & BrokerCapabilities.Will) == 0
            ? null
            : new BrokerPublication
            {
                Topic = DepartureOf(Id),
                Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Gone, Incarnation = Incarnation, Id = Id }),
            };

        await _adapter.Start(new BrokerStart { Will = will });
        await _adapter.Subscribe(InboxOf(Id));

        List<BrokerTransportServer> servers;

        lock (_gate)
        {
            servers = [.. _servers];
        }

        foreach (var server in servers)
        {
            await server.Relink();
        }

        lock (_gate)
        {
            _live.TrySetResult();
        }
    }

    // in its turn: its link lost: each connection closed, unclean, each connect to send its OPEN
    // again once linked, then its link connected again as another incarnation, and each peer it held
    // a connection with reset
    private void LinkDown()
    {
        lock (_gate)
        {
            if (_isStopped || !_live.Task.IsCompleted)
            {
                return;
            }

            _live = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        var peers = _connections.Values.Select((connection) =>
        {
            return (connection.PeerId, connection.Pair);
        }).ToList();

        foreach (var connection in _connections.Values.ToList())
        {
            connection.Drop();
        }

        foreach (var pending in _connects.Values.ToList())
        {
            pending.Down($"the link of {Id} went down as it connected");
        }

        _connects.Clear();
        _departures.Clear();

        List<BrokerTransportServer> servers;

        lock (_gate)
        {
            servers = [.. _servers];
        }

        foreach (var server in servers)
        {
            server.Unlinked();
        }

        // * no reconnection: it stays down, said so, and the next start or connect links it anew
        if (!_options.IsReconnecting)
        {
            lock (_gate)
            {
                _starting = null;
            }

            Report(new IOException($"the link of {Id} went down"));

            return;
        }

        _scheduler.Cover(Relinking(peers));
    }

    private async Task Relinking(List<(string PeerId, (ulong Opener, ulong Acceptor) Pair)> peers)
    {
        try
        {
            await TransportReconnection.Attempting(
                (_) =>
                {
                    return _scheduler.Run(Link);
                },
                (_options.Reconnect ?? new TransportReconnectOptions { MaximumAttempts = int.MaxValue }, _clock));
        }
        catch (ReconnectException reason)
        {
            var attempts = (_options.Reconnect ?? new TransportReconnectOptions { MaximumAttempts = int.MaxValue }).MaximumAttempts;

            Report(new IOException(string.Create(CultureInfo.InvariantCulture, $"the link of {Id} went down, and {attempts} attempts did not bring it back"), reason));

            return;
        }
        catch (Exception reason) when (reason is OperationCanceledException or InvalidOperationException)
        {
            Report(new IOException($"the link of {Id} went down, and its reconnection ended: {reason.Message}", reason));

            return;
        }

        await _scheduler.Run(() =>
        {
            foreach (var peer in peers)
            {
                Reset(peer);
            }

            return Task.CompletedTask;
        });
    }

    // in its turn: a message its adapter received, taken, then acknowledged — never once its
    // router is done with it (spec 15.19)
    private void Take(BrokerMessage message)
    {
        try
        {
            // ! no parcel is retained: one that comes so is dropped in silence (spec 15.23)
            if (message.IsRetained)
            {
                return;
            }

            // a topic of its root: an inbox, a server's name, a departure, by its second token
            if (message.Topic is not [var root, var place, var name] || root != _options.Root)
            {
                return;
            }

            if (place == "i" && name == Id)
            {
                TakeInbox(message.Payload);
            }
            else if (place == "s")
            {
                BrokerTransportServer? server;

                lock (_gate)
                {
                    server = _names.GetValueOrDefault(name);
                }

                server?.TakeOpen(name, BrokerParcels.Read(message.Payload));
            }
            else if (place == "d")
            {
                TakeGone(BrokerParcels.Read(message.Payload));
            }
        }
        finally
        {
            message.Settle();
        }
    }

    // what reaches its inbox: each parcel of its connections, an ACCEPT or a REFUSE among them
    private void TakeInbox(ReadOnlyMemory<byte> payload)
    {
        var reading = BrokerParcels.Read(payload);

        if (reading.Verdict == BrokerParcelVerdict.NoParcel)
        {
            Report(new InvalidDataException($"a message to the inbox of {Id} is no parcel: {reading.Why}"));

            return;
        }

        var parcel = reading.Parcel!;
        var held = _connections.GetValueOrDefault((parcel.Opener, parcel.Acceptor));

        if (reading.Verdict == BrokerParcelVerdict.DoesNotRead)
        {
            held?.TakeUnread((parcel, reading.Why!));

            return;
        }

        if (held is not null)
        {
            held.Take(parcel);

            return;
        }

        switch (parcel.Kind)
        {
            case BrokerParcelKinds.Accept when parcel.Layout == BrokerParcels.Layout:
                if (_connects.TryGetValue(parcel.Opener, out var pending))
                {
                    _connects.Remove(parcel.Opener);
                    pending.Accepted(parcel);
                }
                else
                {
                    // * an ACCEPT of a connect that took another, ended or never was (spec 15.18)
                    Reset((parcel.Id!, (parcel.Opener, parcel.Acceptor)));
                }

                break;

            case BrokerParcelKinds.Refuse:
                if (_connects.TryGetValue(parcel.Opener, out var refused))
                {
                    _connects.Remove(parcel.Opener);
                    refused.Refused(parcel);
                }

                break;

            default:
                // a parcel of a pair it does not hold matches nothing (spec 15.21)
                break;
        }
    }

    // a GONE to a peer's departure: each connection bound to the id and the incarnation it names
    // closed, unclean, never one bound to another (spec 15.21)
    private void TakeGone(BrokerParcelReading reading)
    {
        if (reading is not { Verdict: BrokerParcelVerdict.Parcel, Parcel: { Kind: BrokerParcelKinds.Gone } gone })
        {
            return;
        }

        foreach (var connection in _connections.Values.Where((connection) =>
        {
            return connection.PeerId == gone.Id && connection.PeerIncarnation == gone.Incarnation;
        }).ToList())
        {
            connection.Drop();
        }
    }
}

/// <summary>
/// A connect of a client transport, awaiting the first ACCEPT or REFUSE naming its half: what takes
/// one, in its participant's turn, and what fails it as its link goes down or its participant stops.
/// </summary>
internal sealed class BrokerPendingConnect
{
    private readonly TaskCompletionSource<BrokerConnection> _settled = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public required ulong Opener { get; init; }

    /// <summary>Takes an ACCEPT naming its half: its connection made, held and opened, in that turn.</summary>
    public required Func<BrokerParcel, BrokerConnection> Accept { get; init; }

    /// <summary>The connection it opened; failed with a <see cref="ConnectException"/> when refused, its <see cref="BrokerRefusedException"/> inner, or as its link went down.</summary>
    public Task<BrokerConnection> Settled
    {
        get
        {
            return _settled.Task;
        }
    }

    public void Accepted(BrokerParcel accept)
    {
        _settled.TrySetResult(Accept(accept));
    }

    public void Refused(BrokerParcel refuse)
    {
        var reason = refuse.Status switch
        {
            400 => "malformed",
            426 => "layout-refused",
            _ => "busy",
        };

        _settled.TrySetException(BrokerRefusedException.ConnectOf(new BrokerRefusal
        {
            Reason = reason,
            Status = refuse.Status,
            Layouts = refuse.Layouts?.Select((layout) =>
            {
                return (int)layout;
            }).ToList(),
        }));
    }

    /// <summary>Fails it, saying why: what it opened toward is the former link's.</summary>
    public void Down(string why)
    {
        _settled.TrySetException(new ConnectException(why));
    }
}
