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

    /// <summary>
    /// What it holds of the envelopes of one connection its router paused, past which it loses that
    /// connection, a CLOSE of 4000 (spec 15.12, 15.23): a whole number above 0, charged to no budget
    /// of its parts. Each connection's <c>maximumUnsentBytes</c>, its transport's, unless told: the
    /// most a conforming peer has under way on it.
    /// </summary>
    public long? MaximumHeldEnvelopeBytes { get; init; }

    /// <summary>One envelope's parts together (spec 15.23): the router's <c>maximumEnvelopeBytes</c> unless told, at its default.</summary>
    public long MaximumEnvelopePartsBytes { get; init; } = RouterLimits.Default.MaximumEnvelopeBytes;

    /// <summary>The slowest parts may come, in bytes a second, once the grace passed since an envelope's first (spec 15.12): 240 unless told; a whole number above 0.</summary>
    public int MinimumBodyBytesPerSecond { get; init; } = ServerBounds.MinimumBodyBytesPerSecond;

    /// <summary>How long an envelope's parts come before their rate is held (spec 15.12): 5 seconds unless told; never is refused.</summary>
    public TimeSpan BodyGracePeriod { get; init; } = ServerBounds.BodyGracePeriod;

    /// <summary>The delivery its application requires: an adapter that gives less is refused as it is built (spec 15.19); none when none.</summary>
    public BrokerDelivery? RequireDelivery { get; init; }

    /// <summary>
    /// How its link connects again once lost, each time a new incarnation (spec 15.21), as a
    /// transport client's reconnection takes it: a second between attempts unless told, a fixed
    /// delay held as it is built whatever <see cref="Reconnects"/>; its attempts without end unless
    /// <see cref="TransportClientReconnectOptions.MaximumAttempts"/> bounds them; its token read
    /// before each attempt and during each wait, an attempt under way not cut short; a wait of zero
    /// none, its next attempt in a later turn of its scheduler; its tap told each wait. A stop ends
    /// it at once, in a wait or once its attempt under way failed, no wait told after it, the stop its
    /// cause. Once it ends it is reported through <see cref="BrokerParticipant.Error"/>, what ended it
    /// the inner exception, and the next start or connect links it anew.
    /// </summary>
    public TransportClientReconnectOptions? Reconnect { get; init; }

    /// <summary>
    /// Whether its link connects again once lost, as <see cref="Reconnect"/> says: true unless told;
    /// false leaves it down, reported, until a start or a connect links it anew.
    /// </summary>
    public bool Reconnects { get; init; } = true;

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
/// goes, then resets each peer it held a connection with; when another link of its id takes its
/// link over, it closes each connection alike, reports it, and connects no more until it is started
/// again, so that two holders of one id never take each other over without end. Its stop ends its
/// link in place, each connection closed with 1001 and no will gone, and what is under way with it;
/// its next link, at its application's word, is another incarnation, its transports kept. Its
/// dispose is final.
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
    // the receive bound its inbox takes, asked of its adapter once, as it is built
    private readonly long _receiveBound;
    private Task? _starting;
    // its link taken over by another of its id: fenced, until its application starts it again
    private bool _isTakenOver;
    // its link went down as it connected: that attempt fails, rather than call it linked
    private bool _isDownAsItLinks;
    // what gives up the reconnection under way, as its link is taken over
    private CancellationTokenSource? _relinking;
    private TaskCompletionSource _live = new(TaskCreationOptions.RunContinuationsAsynchronously);
    // ! the current stop's record, which each operation captures at its call; renewed under its gate
    // as its stop settles, the former never disposed, an operation holding it still
    private BrokerStopRecord _current = new();
    // its stop under way, and its dispose come: a start in either is its application's misuse
    private bool _isStopping;
    private bool _isDisposed;
    // its adapter's start under way, which its stop awaits before it stops its adapter; touched in its turn alone
    private Task? _adapterStart;
    // its last stop's end, which a stop called before its next link's start shares; set under its gate
    private Task? _stopped;
    // its dispose's end, which every later dispose shares; set under its gate
    private Task? _disposed;
    // each peer whose CLOSE its broker did not take as it last stopped, reset at its next link; touched in its turn alone
    private readonly List<(string PeerId, (ulong Opener, ulong Acceptor) Pair)> _unreset = [];
    // what hears its adapter, let go of as it is disposed
    private readonly Action<BrokerMessage> _hearMessage;
    private readonly Action<BrokerDown> _hearDown;
    private long _ordinal;
    private UInt128 _incarnation;
    private readonly Dictionary<string, string?> _heldNames = new(StringComparer.Ordinal);
    private long _linkEpoch;

    /// <summary>
    /// A participant over <paramref name="adapter"/>, not yet started. An adapter whose id is no
    /// token, a root that is none, or an adapter that delivers at most once where at least once is
    /// required, is an <see cref="ArgumentException"/>; a bound out of its range, or a fixed
    /// reconnection delay out of bounds, an <see cref="ArgumentOutOfRangeException"/> naming it.
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

        if (given.MaximumHeldEnvelopeBytes is { } maximumHeldEnvelopeBytes)
        {
            ServerBounds.AssertCount((nameof(BrokerParticipantOptions.MaximumHeldEnvelopeBytes), maximumHeldEnvelopeBytes));
        }

        ServerBounds.AssertCount((nameof(BrokerParticipantOptions.MaximumEnvelopePartsBytes), given.MaximumEnvelopePartsBytes));
        ServerBounds.AssertCount((nameof(BrokerParticipantOptions.MinimumBodyBytesPerSecond), given.MinimumBodyBytesPerSecond));

        // * asked by its inbox's topic, which a broker that counts a packet's every byte needs
        var receiveBound = Math.Min(adapter.ReceiveBound([given.Root, "i", adapter.Id]), BrokerParcels.LargestBound);

        if (receiveBound < BrokerParcels.LeastBound)
        {
            throw new ArgumentException(string.Create(CultureInfo.InvariantCulture, $"a participant's inbox takes a parcel of 1,024 bytes at least, and the adapter of {adapter.Id} takes {receiveBound}"), nameof(adapter));
        }

        // * a fixed delay held as it is given, whether or not it reconnects (spec 1.4)
        TransportReconnection.Held(given.Reconnect ?? new TransportClientReconnectOptions());

        _options = given with
        {
            Heartbeat = Clocks.AssertHeld(("a heartbeat", nameof(BrokerParticipantOptions.Heartbeat)), given.Heartbeat),
            BodyGracePeriod = Clocks.AssertHeldFinite((nameof(BrokerParticipantOptions.BodyGracePeriod), nameof(BrokerParticipantOptions.BodyGracePeriod)), given.BodyGracePeriod),
        };
        _adapter = adapter;
        _receiveBound = receiveBound;
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
        _hearMessage = (message) =>
        {
            _scheduler.Post(() =>
            {
                Take(message);
            });
        };
        _hearDown = (down) =>
        {
            _scheduler.Post(() =>
            {
                LinkDown(down);
            });
        };
        adapter.Message += _hearMessage;
        adapter.Down += _hearDown;
    }

    /// <summary>What it reports of its own: a message to it that is no parcel, which it drops, its link given up on, or its link taken over.</summary>
    public event Action<Exception>? Error;

    /// <summary>The trace of parcels (debugging 13), synchronous on its scheduler, each listener guarded.</summary>
    public event Action<ParticipantDebugEvent>? Debug;

    /// <summary>Whether anyone listens to the trace.</summary>
    public bool IsDebugging
    {
        get
        {
            return Debug is not null;
        }
    }

    /// <summary>The names its broker holds, read by pull.</summary>
    public IReadOnlySet<string> Names
    {
        get
        {
            lock (_gate)
            {
                return new HashSet<string>(_heldNames.Keys, StringComparer.Ordinal);
            }
        }
    }

    // ! called only behind IsDebugging: no record or listener snapshot while nobody watches
    internal void Trace(ParticipantDebugEvent debugEvent)
    {
        var listeners = Debug;

        if (listeners is null)
        {
            return;
        }

        foreach (var listener in listeners.GetInvocationList())
        {
            try
            {
                ((Action<ParticipantDebugEvent>)listener)(debugEvent);
            }
            catch (Exception reason)
            {
                // a debug listener's own error never becomes another report event
                TellError(reason);
            }
        }
    }

    private void TellError(Exception reason)
    {
        var listeners = Error;

        if (listeners is null)
        {
            return;
        }

        foreach (var listener in listeners.GetInvocationList())
        {
            try
            {
                ((Action<Exception>)listener)(reason);
            }
            catch (Exception)
            {
                // an error listener cannot fail its participant
            }
        }
    }

    internal long DrawOrdinal()
    {
        return ++_ordinal;
    }

    internal void TraceParcel(BrokerParcel? parcel, ParticipantDebugEvent debugEvent)
    {
        if (parcel is null)
        {
            Trace(debugEvent);
            return;
        }

        var kind = parcel.Kind;
        var readsBody = debugEvent.Verdict != ParcelVerdict.DoesNotRead;
        var isOpening = readsBody && kind is BrokerParcelKinds.Open or BrokerParcelKinds.Accept;
        var isData = readsBody && parcel.Layout == BrokerParcels.Layout && kind == BrokerParcelKinds.Data;
        var namesIdentity = readsBody && (isOpening || kind == BrokerParcelKinds.Gone);
        Trace(debugEvent with
        {
            Layout = parcel.Layout,
            Kind = kind >= 0x80 ? string.Create(CultureInfo.InvariantCulture, $"advisory {kind}") : BrokerParcels.NameOf(kind),
            Flags = debugEvent.Flags ?? parcel.Flags,
            Sequence = parcel.Sequence,
            Opener = parcel.Opener.ToString("x16", CultureInfo.InvariantCulture),
            Id = namesIdentity ? parcel.Id : null,
            Incarnation = namesIdentity ? parcel.Incarnation?.ToString("x32", CultureInfo.InvariantCulture) : null,
            Bound = isOpening ? parcel.Bound : null,
            Secure = isOpening && parcel.Bound is not null ? parcel.Has(BrokerParcelFlags.Secure) : null,
            Status = readsBody && kind == BrokerParcelKinds.Refuse ? parcel.Status : null,
            CarriedBytes = isData ? parcel.Carried.Length : null,
            More = isData ? parcel.Has(BrokerParcelFlags.More) : null,
            HasCredential = isData ? parcel.Has(BrokerParcelFlags.Credential) : null,
            Answers = readsBody && kind == BrokerParcelKinds.Pong ? parcel.Answers : null,
            Code = readsBody && kind == BrokerParcelKinds.Close ? parcel.Code : null,
        });
    }

    private void Transition(string state, IReadOnlyList<long>? ended = null)
    {
        if (IsDebugging)
        {
            Trace(new ParticipantDebugEvent { Event = "link", State = state, Ended = ended, Incarnation = Incarnation.ToString("x32", CultureInfo.InvariantCulture) });
        }
    }

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

    /// <summary>In its turn: whether its link went down as it connects, so that what failed then is its loss, not a refusal.</summary>
    internal bool IsDownAsItLinks
    {
        get
        {
            return _isDownAsItLinks;
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

    // what one connection its router paused holds at most; its own maximumUnsentBytes when none
    internal long? MaximumHeldEnvelopeBytes
    {
        get
        {
            return _options.MaximumHeldEnvelopeBytes;
        }
    }

    internal TimeSpan HeartbeatPeriod
    {
        get
        {
            return _options.Heartbeat;
        }
    }

    /// <summary>Its incarnation, drawn as its link last connected.</summary>
    public UInt128 Incarnation
    {
        get
        {
            lock (_gate) { return _incarnation; }
        }
        private set
        {
            lock (_gate) { _incarnation = value; }
        }
    }

    /// <summary>The receive bound it announces: what its adapter's inbox takes whole, as its field holds it.</summary>
    internal long ReceiveBound
    {
        get
        {
            return _receiveBound;
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
    /// What it holds: <c>connections</c>, those of its transports open, and <c>halfOpen</c>, those
    /// whose third leg has not come; <c>partsBytes</c>, what it holds in parts, and
    /// <c>unsentBytes</c>, what waits for its broker, with the largest of each one connection holds;
    /// <c>departures</c>, the peers' departures it subscribes.
    /// </summary>
    public Gauges Gauges()
    {
        // * counts read as they stand, from any thread: each one its turn's last word
        lock (_gate)
        {
            var held = _connections.Values.ToList();
            var ceilings = new Dictionary<string, long>
            {
                ["largestPartsBytes"] = PartsBounds.MaximumEnvelopePartsBytes,
                ["partsBytes"] = _budget.Budget,
            };
            long unsentCeiling = 0;
            BrokerConnection? largest = null;
            foreach (var connection in held)
            {
                unsentCeiling = unsentCeiling > long.MaxValue - connection.MaximumUnsentBytes ? long.MaxValue : unsentCeiling + connection.MaximumUnsentBytes;
                if (largest is null || connection.UnsentBytes >= largest.UnsentBytes)
                {
                    largest = connection;
                }
            }
            if (largest is not null)
            {
                ceilings["unsentBytes"] = unsentCeiling;
                ceilings["largestUnsentBytes"] = largest.MaximumUnsentBytes;
            }

            return new Gauges
            {
                Counts = new Dictionary<string, long>
                {
                    ["connections"] = held.Count((connection) =>
                    {
                        return connection.State == BrokerConnectionState.Open;
                    }),
                    ["departures"] = Departures,
                    ["halfOpen"] = held.Count((connection) =>
                    {
                        return connection.State == BrokerConnectionState.HalfOpen;
                    }),
                    ["largestPartsBytes"] = held.Select((connection) =>
                    {
                        return connection.PartsBytes;
                    }).DefaultIfEmpty().Max(),
                    ["largestUnsentBytes"] = held.Select((connection) =>
                    {
                        return connection.UnsentBytes;
                    }).DefaultIfEmpty().Max(),
                    ["partsBytes"] = PartsBytes,
                    ["unsentBytes"] = held.Sum((connection) =>
                    {
                        return connection.UnsentBytes;
                    }),
                },
                Ceilings = ceilings,
            };
        }
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
    /// of it is held. A second start shares the first, or starts anew once the first failed, once its
    /// link went down and stays down, once its link was taken over, its application's start lifting
    /// the fence a takeover set, or once its stop settled: another incarnation, its transports kept,
    /// each peer whose CLOSE its broker did not take as it stopped reset (spec 15.21). Refused with
    /// an <see cref="InvalidOperationException"/> while its stop is under way, and with an
    /// <see cref="ObjectDisposedException"/> once it is disposed, before anything moves.
    /// </summary>
    public Task Start()
    {
        return Starting(null);
    }

    // its start; for a connect, given the stop's record it captured, failed once that stop came, so
    // that a connect a stop overtook links nothing after it
    private Task Starting(BrokerStopRecord? captured)
    {
        lock (_gate)
        {
            if (_isDisposed)
            {
                return Task.FromException(DisposedRefusal());
            }

            if (_isStopping)
            {
                return Task.FromException(new InvalidOperationException($"the participant {Id} is stopping"));
            }

            if (captured is { IsMarked: true })
            {
                return Task.FromException(StoppedAsItStarted());
            }

            // * its application's start lifts the fence a takeover set
            _isTakenOver = false;

            // * one attempt shared; one that failed is let go, so the next starts another
            if (_starting is null || _starting.IsFaulted || _starting.IsCanceled)
            {
                var record = _current;

                // * a link starts: the last stop is shared no more, and a stop called from now on
                // stops this link
                _stopped = null;
                _starting = _scheduler.Run(() =>
                {
                    return Link(record);
                });
            }

            return _starting;
        }
    }

    /// <summary>
    /// Ends its link in place, and with it what is under way as it is called (spec 15.21): gives up
    /// its link's start under way and awaits it, closes each of its connections with a CLOSE of
    /// 1001, then stops its adapter, which sends those CLOSEs, then has its broker let go of each
    /// subscription of its link, before it ends the link, so its broker publishes no will of a link
    /// it held and hands it nothing once it settled; a connect awaiting its link or its answer
    /// fails, stopped as it connected, and a reconnection, its own or a client's, ends at once, the
    /// stop its cause.
    /// Once it settled, its start, a server's start over it, or a client's connect or reconnection
    /// over it links it anew as another incarnation, its transports kept, and resets each peer whose
    /// CLOSE its broker did not take. A stop called again before its next link's start settles with
    /// the first, and tells nothing; a participant no longer in use is disposed.
    /// </summary>
    public Task Stop()
    {
        BrokerStopRecord record;
        TaskCompletionSource ending;

        lock (_gate)
        {
            // * a stop under way, or one settled with no link started since: this one settles with it
            if (_stopped is not null)
            {
                return _stopped;
            }

            record = _current;
            record.Mark();

            if (!_isDisposed)
            {
                _isStopping = true;
            }

            // ! a start shared no more, and its link down at once: a link up before the stop is the
            // next start's to make anew
            _starting = null;
            _live.TrySetCanceled();
            _live = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            ending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _stopped = ending.Task;
        }

        // * outside its gate: no callback of its signals runs under it
        _ = Ending((ending, record));

        return ending.Task;
    }

    // its stop's body: its signals cancelled right after its mark, its start under way given up, its
    // connections closed, its link ended; its record renewed, unless it is disposed, then its end
    // settled whatever the turn did, so that no later stop waits for ever and a start made as it
    // settles links anew
    private async Task Ending((TaskCompletionSource Ended, BrokerStopRecord Record) stop)
    {
        var (ended, record) = stop;

        try
        {
            await record.Cancel();
            await Unlinking();
            Renew();
            ended.SetResult();
        }
        catch (Exception reason)
        {
            Renew();
            ended.SetException(reason);
        }
    }

    // its stop settled: a record of its own for the next, unless it is disposed
    private void Renew()
    {
        lock (_gate)
        {
            if (!_isDisposed)
            {
                _isStopping = false;
                _current = new BrokerStopRecord();
            }
        }
    }

    // in its turn: its connections closed with 1001, each CLOSE handed to its adapter before its
    // stop, its connects failed, its adapter's start under way awaited, then its adapter stopped
    // once; each peer whose CLOSE its broker did not take kept for its next link, and its server
    // transports kept, their names held no more
    private Task Unlinking()
    {
        return _scheduler.Run(async () =>
        {
            _linkEpoch += 1;

            var ended = IsDebugging ? _connections.Values.Select((connection) => { return connection.Ordinal; }).ToArray() : null;
            var closing = new List<(string PeerId, (ulong Opener, ulong Acceptor) Pair, Task<BrokerPublished> Published)>();

            foreach (var connection in _connections.Values.ToList())
            {
                if (connection.Close((1001, false)) is { } published)
                {
                    closing.Add((connection.PeerId, connection.Pair, published));
                }
            }

            foreach (var pending in _connects.Values.ToList())
            {
                pending.Down(StoppedAsItConnected().Message);
            }

            _connects.Clear();

            // * its adapter's start under way, given up, settles before its stop: the two never
            // overlap, and what that start brought up after the stop ends with it
            if (_adapterStart is { IsCompleted: false } started)
            {
                await started.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing | ConfigureAwaitOptions.ContinueOnCapturedContext);
            }

            // * its stop sends what it was handed before it, each CLOSE among it, within a bound of
            // its own, and fails what has not gone by then (spec 15.24)
            await _adapter.Stop();

            foreach (var (peerId, pair, published) in closing)
            {
                await ((Task)published).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing | ConfigureAwaitOptions.ContinueOnCapturedContext);

                if (!published.IsCompletedSuccessfully || published.Result != BrokerPublished.Taken)
                {
                    _unreset.Add((peerId, pair));
                }
            }

            // ! an OPEN its link took as it ended, after its CLOSEs went, holds a connection on a link
            // ended: dropped, unclean
            foreach (var connection in _connections.Values.ToList())
            {
                connection.Drop();
            }

            List<BrokerTransportServer> servers;

            lock (_gate)
            {
                _heldNames.Clear();
                servers = [.. _servers];
            }

            // * its server transports kept, their names wanted and held no more
            foreach (var server in servers)
            {
                server.Unlinked();
            }

            if (!_isTakenOver)
            {
                Transition("stopped", ended);
            }
        });
    }

    /// <summary>
    /// Stops it, then ends it for good (spec 15.21; decision 0003): its listeners on its adapter let
    /// go of, its adapter the application's to dispose. Its start, and a client's connect or
    /// reconnection or a server's start over it, made after it, is its application's misuse, an
    /// <see cref="ObjectDisposedException"/>, refused before anything moves; a stop or a dispose
    /// after it settles with it.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        var disposing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        BrokerStopRecord? record = null;
        Task disposed;

        lock (_gate)
        {
            if (_disposed is null)
            {
                _disposed = disposing.Task;
                _isDisposed = true;

                // ! what is under way as it is called ends with it, though a stop settled before it
                record = _current;
                record.Mark();
            }

            disposed = _disposed;
        }

        if (record is not null)
        {
            try
            {
                await record.Cancel();
                await Stop();
                _adapter.Message -= _hearMessage;
                _adapter.Down -= _hearDown;
                record.Dispose();
                disposing.SetResult();
            }
            catch (Exception reason)
            {
                disposing.SetException(reason);
            }
        }

        await disposed;
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

    /// <summary>
    /// Settles once its link is up, started, connected again, or linked anew once its stop settled;
    /// a cancel ends the wait. The stop <paramref name="captured"/> names, the one current as its
    /// connect was called, fails it at once with a <see cref="ConnectException"/>, stopped as it
    /// connected, whether it awaits its link or its start, before its takeover is read; its link
    /// taken over, with one naming it: a connect never lifts the fence, which its application's start
    /// alone does. What its link's start fails with fails the connect: its adapter's misuse a
    /// <see cref="ConnectException"/> with it inside, which another attempt may mend (spec 15.21).
    /// </summary>
    internal async Task WhenLinked(BrokerStopRecord captured, CancellationToken cancellationToken)
    {
        // ! the stop first: a connect it overtook fails as one, never the takeover's words
        if (captured.IsMarked)
        {
            throw StoppedAsItConnected();
        }

        lock (_gate)
        {
            if (_isTakenOver)
            {
                throw new ConnectException($"{TakenOver}, and connects no more until it is started again");
            }
        }

        // * its stop at once, its link's own end awaited by the stop alone (spec 15.21)
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, captured.Ending);

        try
        {
            await Starting(captured).WaitAsync(waiting.Token);

            Task live;

            lock (_gate)
            {
                live = _live.Task;
            }

            await live.WaitAsync(waiting.Token);
        }
        catch (Exception reason) when (captured.IsMarked)
        {
            // * its stop met as it linked, the stop's own refusal racing this check among it: a
            // connect it overtook, what its link failed with inside
            throw StoppedAsItConnected(reason);
        }
        catch (Exception reason) when (reason is (InvalidOperationException and not ObjectDisposedException) or ArgumentException)
        {
            // * its adapter's misuse, a failure of this connect another attempt may mend; a
            // disposed object's never one of its link's
            throw new ConnectException(reason.Message, reason);
        }
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
    internal Task<BrokerPublished> Publish(BrokerPublication publication, BrokerParcel? parcel = null)
    {
        if (IsDebugging && parcel is not null)
        {
            var connection = _connections.GetValueOrDefault((parcel.Opener, parcel.Acceptor));
            TraceParcel(parcel, new ParticipantDebugEvent { Event = "parcel", Direction = "tx", Topic = publication.Topic, Bytes = publication.Payload.Length, Connection = connection?.Ordinal, ConnectionHandle = connection?.TraceHandle });
        }
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
        // ! under its gate, as its gauges read them from any thread
        lock (_gate)
        {
            _connections[connection.Pair] = connection;
        }
    }

    /// <summary>In its turn: a connection that ended, held no more.</summary>
    internal void Forget(BrokerConnection connection)
    {
        if (_connections.TryGetValue(connection.Pair, out var held) && held == connection)
        {
            lock (_gate)
            {
                _connections.Remove(connection.Pair);
            }
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

        var parcel = new BrokerParcel { Kind = BrokerParcelKinds.Reset, Opener = opener, Acceptor = acceptor };
        _ = Publish(new BrokerPublication
        {
            Topic = InboxOf(reset.PeerId),
            Payload = BrokerParcels.Write(parcel),
        }, parcel);
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
    internal async Task Subscribe((string Name, bool IsInGroup) name)
    {
        var epoch = _linkEpoch;
        var record = Captured();
        await _adapter.Subscribe(NameOf(name.Name), new BrokerSubscription { Group = name.IsInGroup ? name.Name : null });
        if (epoch != _linkEpoch || record.IsMarked)
        {
            return;
        }
        lock (_gate)
        {
            _heldNames[name.Name] = name.IsInGroup ? name.Name : null;
        }
        if (IsDebugging)
        {
            Trace(new ParticipantDebugEvent { Event = "names", Name = name.Name, IsHeld = true, Group = name.IsInGroup ? name.Name : null });
        }
    }

    /// <summary>Lets a name go.</summary>
    internal async Task Unsubscribe(string name)
    {
        var group = _heldNames.GetValueOrDefault(name);
        var epoch = _linkEpoch;
        await _adapter.Unsubscribe(NameOf(name));
        if (epoch != _linkEpoch)
        {
            return;
        }
        lock (_gate)
        {
            _heldNames.Remove(name);
        }
        if (IsDebugging)
        {
            Trace(new ParticipantDebugEvent { Event = "names", Name = name, IsHeld = false, Group = group });
        }
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

        if (IsDebugging)
        {
            Trace(new ParticipantDebugEvent { Event = "report", Report = reason.Message });
        }
        TellError(reason);

        foreach (var server in servers)
        {
            server.Report(reason, isParticipantReport: true);
        }
    }

    // what its link taken over is reported by, and fails its connects with
    private string TakenOver
    {
        get
        {
            return $"the link of {Id} was taken over by another link of its id";
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
    // anything goes, then each peer whose CLOSE its broker did not take as it last stopped reset; the
    // stop `record` names, which the operation that links it captured, met as it connects fails it,
    // stopped as it started, nothing of it going on
    private async Task Link(BrokerStopRecord record)
    {
        // ! stopped between its caller's check and this turn: nothing of it goes
        if (record.IsMarked)
        {
            throw StoppedAsItStarted();
        }

        _isDownAsItLinks = false;
        _linkEpoch += 1;

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

        try
        {
            // * its stop's token to its start alone: a SUBSCRIBE given up by a token retires its link
            // with no DISCONNECT, so its will would go; its adapter's stop ends that one cleanly
            var started = _adapter.Start(new BrokerStart { Will = will, CancellationToken = record.Starting });

            _adapterStart = started;
            await started;

            if (!record.IsMarked)
            {
                await _adapter.Subscribe(InboxOf(Id));
            }
        }
        catch (Exception reason) when (record.IsMarked)
        {
            throw StoppedAsItStarted(reason);
        }

        // ! stopped as it started: its inbox never subscribed, no name, no up; its stop ends what
        // this start brought up
        if (record.IsMarked)
        {
            throw StoppedAsItStarted();
        }

        List<BrokerTransportServer> servers;

        lock (_gate)
        {
            servers = [.. _servers];
        }

        foreach (var server in servers)
        {
            await server.Relink();
        }

        // ! a link that went down as it connected is none: this attempt fails, and the next links
        // anew, rather than call it up and miss its loss
        if (_isDownAsItLinks)
        {
            throw new IOException($"the link of {Id} went down as it connected");
        }

        lock (_gate)
        {
            // ! stopped as it started: what its stop let go of stays let go, and this link goes no further
            if (record.IsMarked)
            {
                throw StoppedAsItStarted();
            }

            _live.TrySetResult();
        }
        Transition("up");

        // * each peer whose CLOSE its broker did not take as it last stopped, reset once its names
        // are subscribed again (spec 15.21): one that let its pair go drops it in silence
        foreach (var peer in _unreset)
        {
            Reset(peer);
        }

        _unreset.Clear();
    }

    // in its turn: its link lost: each connection closed, unclean, each connect to send its OPEN
    // again once linked, then its link connected again as another incarnation, and each peer it held
    // a connection with reset; or taken over: each connection closed alike, reported, and fenced
    private void LinkDown(BrokerDown down)
    {
        BrokerStopRecord record;

        lock (_gate)
        {
            // * a stop under way, or its dispose, ends the link itself
            if (_isStopping || _isDisposed)
            {
                return;
            }

            // ! the stop current as it went down, which its reconnection captures
            record = _current;

            if (!_live.Task.IsCompleted)
            {
                // * down as it connects: the attempt under way fails; taken over, none follows it
                _isDownAsItLinks = true;

                if (down.IsTakenOver)
                {
                    Fence();
                }

                return;
            }

            _live = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        var ended = IsDebugging ? _connections.Values.Select((connection) => { return connection.Ordinal; }).ToArray() : null;
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
            pending.Down(down.IsTakenOver ? $"{TakenOver} as it connected" : $"the link of {Id} went down as it connected");
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

        lock (_gate)
        {
            _heldNames.Clear();
        }
        _linkEpoch += 1;
        Transition(down.IsTakenOver ? "taken-over" : "down", ended);

        // * taken over: it connects no more, its server's transports taking no OPEN and its
        // clients' connects failing, until its application starts it again (spec 15.21)
        if (down.IsTakenOver)
        {
            lock (_gate)
            {
                Fence();
            }

            return;
        }

        // * no reconnection: it stays down, said so, and the next start or connect links it anew
        if (!_options.Reconnects)
        {
            lock (_gate)
            {
                _starting = null;
            }

            Report(new IOException($"the link of {Id} went down"));

            return;
        }

        _scheduler.Cover(Relinking((peers, record)));
    }

    // under its gate: its link taken over, reported once, its reconnection under way given up and
    // its next start a link anew
    private void Fence()
    {
        if (_isTakenOver)
        {
            return;
        }

        _isTakenOver = true;
        _starting = null;
        _relinking?.Cancel();
        _scheduler.Post(() =>
        {
            Report(new IOException(TakenOver));
        });
    }

    // its link connected again, as its reconnection says, without end unless its application bounds
    // it; ended, reported, what ended it inside, and its next start or connect links it anew. The
    // stop `record` names ends it at once, in a wait or once its attempt under way failed, no wait
    // told after it, the stop its cause (spec 15.21)
    private async Task Relinking((List<(string PeerId, (ulong Opener, ulong Acceptor) Pair)> Peers, BrokerStopRecord Record) relinked)
    {
        var (peers, record) = relinked;
        var reconnect = _options.Reconnect ?? new TransportClientReconnectOptions();
        using var fenced = new CancellationTokenSource();
        // cancelled by an attempt that failed with its stop come, so that none follows it
        using var stopping = new CancellationTokenSource();
        // * ended by its application's token, by a takeover, or at once by its stop
        using var relinking = CancellationTokenSource.CreateLinkedTokenSource([reconnect.CancellationToken, fenced.Token, stopping.Token, record.Ending]);
        // the attempts made, which its end's words count
        var attempts = 0;

        lock (_gate)
        {
            _relinking = fenced;
        }

        try
        {
            await TransportReconnection.Attempting(
                async (_) =>
                {
                    attempts += 1;

                    try
                    {
                        await _scheduler.Run(() =>
                        {
                            return Link(record);
                        });
                    }
                    catch (Exception reason) when (record.IsMarked)
                    {
                        // ! its stop is marked before its signal is cancelled: an attempt that failed
                        // with its stop come ends it itself, so no wait is told after it
                        await stopping.CancelAsync();

                        throw new OperationCanceledException(TransportReconnection.Cancelled, reason, stopping.Token);
                    }
                    catch (ArgumentException reason)
                    {
                        // * a failure another attempt may mend, an adapter's misuse among them
                        throw new IOException(reason.Message, reason);
                    }
                },
                (reconnect with { CancellationToken = relinking.Token, MaximumAttempts = reconnect.MaximumAttempts ?? int.MaxValue }, _clock));
        }
        catch (Exception) when (record.IsMarked)
        {
            // * ended by its stop, which let go of its start already: the stop its cause, in the
            // other sides' words (spec 15.21)
            Report(new IOException(
                $"the link of {Id} went down, and its reconnection ended: {TransportReconnection.Cancelled}",
                new OperationCanceledException(TransportReconnection.Cancelled, BrokerStopRecord.CauseOf(Id))));

            return;
        }
        catch (OperationCanceledException) when (fenced.IsCancellationRequested)
        {
            // taken over as it connected again: its fence reported it, and let go of its start
            return;
        }
        catch (ReconnectException reason)
        {
            Ended(new IOException(string.Create(CultureInfo.InvariantCulture, $"the link of {Id} went down, and {attempts} attempts did not bring it back"), reason));

            return;
        }
        catch (Exception reason)
        {
            // a delay refused or that threw, a tap that threw, or a cancel
            Ended(new IOException($"the link of {Id} went down, and its reconnection ended: {reason.Message}", reason));

            return;
        }
        finally
        {
            lock (_gate)
            {
                if (_relinking == fenced)
                {
                    _relinking = null;
                }
            }
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

    /// <summary>Whether it is disposed: a call made since is its application's misuse (spec 15.21).</summary>
    internal bool IsDisposed
    {
        get
        {
            lock (_gate)
            {
                return _isDisposed;
            }
        }
    }

    /// <summary>
    /// The current stop's record, which an operation that links it as it needs, a client's connect
    /// or reconnection, captures at its call: a stop called from then on stops what it links, never
    /// settles with the last one, so that what is under way as a stop is called ends with it, though
    /// its link has not started yet.
    /// </summary>
    internal BrokerStopRecord Linking()
    {
        lock (_gate)
        {
            if (!_isStopping && !_isDisposed && !_isTakenOver)
            {
                _stopped = null;
            }

            return _current;
        }
    }

    // the current stop's record, read under its gate
    private BrokerStopRecord Captured()
    {
        lock (_gate)
        {
            return _current;
        }
    }

    /// <summary>
    /// What a call made after its dispose is refused with, its application's misuse (spec 15.21):
    /// an <see cref="ObjectDisposedException"/>, the side's own words alone.
    /// </summary>
    internal ObjectDisposedException DisposedRefusal()
    {
        return new ObjectDisposedException(null, $"the participant {Id} is disposed");
    }

    /// <summary>A connect its stop met before that stop settled, awaiting its link or its answer: a failure of that connect's, never the misuse a call made once disposed is.</summary>
    internal ConnectException StoppedAsItConnected(Exception? reason = null)
    {
        var words = $"the participant {Id} stopped as it connected";

        return reason is null ? new ConnectException(words) : new ConnectException(words, reason);
    }

    // a link its stop met as it connected: a failure of that link's, what its adapter failed with inside
    private IOException StoppedAsItStarted(Exception? reason = null)
    {
        return new IOException($"the participant {Id} stopped as it started", reason);
    }

    // its reconnection ended: it stays down, said so, and the next start or connect links it anew
    private void Ended(IOException report)
    {
        lock (_gate)
        {
            _starting = null;
        }

        Report(report);
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
                TraceIncoming(null, (message, ParcelVerdict.Retained));
                return;
            }

            // a topic of its root: an inbox, a server's name, a departure, by its second token
            if (message.Topic is not [var root, var place, var name] || root != _options.Root)
            {
                TraceIncoming(null, (message, ParcelVerdict.OffTopic));
                return;
            }

            if (place == "i" && name == Id)
            {
                TakeInbox(message);
            }
            else if (place == "s")
            {
                BrokerTransportServer? server;

                lock (_gate)
                {
                    server = _names.GetValueOrDefault(name);
                }

                if (server is null)
                {
                    TraceIncoming(null, (message, ParcelVerdict.OffTopic));
                    return;
                }
                var read = BrokerParcels.Read(message.Payload);
                TraceIncoming(read.Parcel, (message, read.Verdict == ParcelVerdict.Taken && read.Parcel?.Kind >= 0x80 ? ParcelVerdict.Advisory : read.Verdict));
                server?.TakeOpen(name, read);
            }
            else if (place == "d")
            {
                if (!_departures.ContainsKey(name))
                {
                    TraceIncoming(null, (message, ParcelVerdict.OffTopic));
                    return;
                }
                var read = BrokerParcels.Read(message.Payload);
                TraceIncoming(read.Parcel, (message, read.Verdict == ParcelVerdict.Taken && read.Parcel?.Kind >= 0x80 ? ParcelVerdict.Advisory : read.Verdict));
                TakeGone(read);
            }
            else
            {
                TraceIncoming(null, (message, ParcelVerdict.OffTopic));
            }
        }
        finally
        {
            message.Settle();
        }
    }

    // what reaches its inbox: each parcel of its connections, an ACCEPT or a REFUSE among them
    private void TraceIncoming(BrokerParcel? parcel, (BrokerMessage Message, ParcelVerdict Verdict) incoming)
    {
        if (IsDebugging)
        {
            TraceParcel(parcel, new ParticipantDebugEvent { Event = "parcel", Direction = "rx", Topic = incoming.Message.Topic, Bytes = incoming.Message.Payload.Length, Verdict = incoming.Verdict, Flags = parcel is null ? null : incoming.Message.Payload.Span[2] });
        }
    }

    private void TakeInbox(BrokerMessage message)
    {
        var reading = BrokerParcels.Read(message.Payload);

        if (reading.Verdict == ParcelVerdict.NoParcel)
        {
            TraceIncoming(null, (message, ParcelVerdict.NoParcel));
            Report(new InvalidDataException($"a message to the inbox of {Id} is no parcel: {reading.Why}"));

            return;
        }

        var parcel = reading.Parcel!;
        var held = _connections.GetValueOrDefault((parcel.Opener, parcel.Acceptor));

        if (reading.Verdict == ParcelVerdict.DoesNotRead)
        {
            if (held is null)
            {
                TraceIncoming(parcel, (message, ParcelVerdict.DoesNotRead));
            }
            else
            {
                held.TakeUnread((parcel, reading.Why!), message.Payload.Length);
            }

            return;
        }

        if (held is not null)
        {
            held.Take(parcel, IsDebugging ? (message.Payload.Length, message.Payload.Span[2]) : default);

            return;
        }

        TraceIncoming(parcel, (message, _connects.ContainsKey(parcel.Opener) && parcel.Kind is BrokerParcelKinds.Accept or BrokerParcelKinds.Refuse ? ParcelVerdict.Taken : ParcelVerdict.PairNotHeld));
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
        if (reading is not { Verdict: ParcelVerdict.Taken, Parcel: { Kind: BrokerParcelKinds.Gone } gone })
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
