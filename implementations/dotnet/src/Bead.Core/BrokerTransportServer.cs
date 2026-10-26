using System.Globalization;

namespace Bead;

/// <summary>How a broker's server transport is built (spec 15.12, 15.18, 15.23).</summary>
public sealed record BrokerTransportServerOptions
{
    /// <summary>The names it serves, each a token, a server's as a host name is (spec 15.16): its clients' OPENs go to them; one at least.</summary>
    public required IReadOnlyList<string> Names { get; init; }

    /// <summary>
    /// Whether it serves its names in a group, its broker handing each OPEN to one of the
    /// participants serving it, as a name served by several needs (spec 15.18); while it holds
    /// <see cref="MaximumConnections"/> it then leaves its names, and serves them again once it holds
    /// fewer. False unless told, a name served by this participant alone.
    /// </summary>
    public bool IsInGroup { get; init; }

    /// <summary>The connections it holds at once, half-open ones among them, past which an OPEN is refused 503 (spec 15.12): 10,000 unless told.</summary>
    public int MaximumConnections { get; init; } = 10_000;

    /// <summary>The connections one participant's id holds at once (spec 15.12): 64 unless told.</summary>
    public int MaximumConnectionsPerAddress { get; init; } = 64;

    /// <summary>
    /// What may wait for its broker on a connection (spec 15.23), past which the connection is lost,
    /// a CLOSE of 4000; what a peer keeping every rule can be owed under the router's limits unless told.
    /// </summary>
    public long? MaximumUnsentBytes { get; init; }

    /// <summary>
    /// How long a half-open connection waits for its client's first parcel naming both halves (spec
    /// 15.23): 30 seconds unless told, on its participant's clock; never is refused.
    /// </summary>
    public TimeSpan AcceptTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Whether its own leg is secure, as its application says of what stands in front of it (spec
    /// 15.22); its adapter's word when none.
    /// </summary>
    public bool? Secure { get; init; }
}

/// <summary>
/// A server's transport over a broker's participant (spec 15.18): it serves its names, judges each
/// OPEN that comes to them in order — a layout to come refused 426, an id that is no token or a
/// receive bound under 1,024 refused 400, past its bounds or once its stop began 503 — and answers
/// any other with an ACCEPT, its connection then half-open, holding its place and telling nothing;
/// it tells its router the connection, drawing its handle
/// <c>type=…;participant=…;ordinal=…</c>, once the client's first parcel naming both halves proves
/// it reads its inbox, and forgets one whose third leg did not come within its accept timeout. It
/// hands its router each envelope with its peer participant's id as its address and no port, the
/// credential its DATA carried beside it; it carries none toward its client.
/// </summary>
public sealed class BrokerTransportServer : IServerTransport, IAsyncDisposable, IBrokerConnectionOwner
{
    // the layouts this side reads, which a 426 names
    private static readonly byte[] Layouts = [BrokerParcels.Layout];

    private readonly BrokerParticipant _participant;
    private readonly BrokerTransportServerOptions _options;
    private readonly long _maximumUnsentBytes;
    private readonly bool _isSecure;
    private readonly TransportServerLife _life = new();
    private readonly ListenerGuard _listeners;
    private readonly Lock _gate = new();
    // the connections its router was told of, by their handle, and every one held, half-open among them
    private readonly Dictionary<string, BrokerConnection> _connections = new(StringComparer.Ordinal);
    private readonly HashSet<BrokerConnection> _held = [];
    // the accept timeout of each half-open connection
    private readonly Dictionary<BrokerConnection, ITimer> _accepting = [];
    // the names it holds a subscription to
    private readonly HashSet<string> _subscribed = new(StringComparer.Ordinal);
    // whether it left its names while it holds its bound, served in a group
    private bool _isFull;
    private long _arrivals;

    internal BrokerTransportServer(BrokerParticipant participant, BrokerTransportServerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(options.Names, nameof(options));

        if (options.Names.Count == 0 || options.Names.Any((name) =>
        {
            return !BrokerParcels.IsToken(name);
        }))
        {
            throw new ArgumentException("a broker's server transport serves one name at least, each a token of base64url's alphabet, 1 to 64 characters", nameof(options));
        }

        if (options.IsInGroup && (participant.Adapter.Capabilities & BrokerCapabilities.Groups) == 0)
        {
            throw new ArgumentException("a name served in a group needs an adapter that offers groups", nameof(options));
        }

        ServerBounds.AssertCount((nameof(BrokerTransportServerOptions.MaximumConnections), options.MaximumConnections));
        ServerBounds.AssertCount((nameof(BrokerTransportServerOptions.MaximumConnectionsPerAddress), options.MaximumConnectionsPerAddress));
        ServerBounds.AssertCount((nameof(BrokerTransportServerOptions.MaximumUnsentBytes), options.MaximumUnsentBytes ?? 1));

        _participant = participant;
        _options = options with
        {
            Names = [.. options.Names.Distinct(StringComparer.Ordinal)],

            // ! never without end: a half-open place held for ever is a place taken (spec 15.23)
            AcceptTimeout = Clocks.AssertHeldFinite((nameof(BrokerTransportServerOptions.AcceptTimeout), nameof(BrokerTransportServerOptions.AcceptTimeout)), options.AcceptTimeout),
        };
        _maximumUnsentBytes = options.MaximumUnsentBytes ?? ServerBounds.UnsentBytesOf(RouterLimits.Default);
        _isSecure = options.Secure ?? participant.Adapter.IsSecure;
        _listeners = new ListenerGuard((reason, connectionHandle) =>
        {
            Error?.Invoke(reason, connectionHandle ?? "");
        });
    }

    /// <inheritdoc/>
    public event Action<string>? Connection;

    /// <inheritdoc/>
    public event Action<TransportMessage, string>? Message;

    /// <summary>A connection closed, and its handle: clean when it closed with 1000, at either end (spec 15.21).</summary>
    public event Action<bool, string>? Close;

    /// <summary>
    /// Each OPEN it refused (spec 15.1, 15.18): its status, its reason, and the id the OPEN claims
    /// as its address; no authority, no origin, and port 0, since a broker names none.
    /// </summary>
    public event Action<TransportServerRefusal>? Refusal;

    /// <summary>
    /// What it ends a connection for of its own — a gap, a bound, a parcel that does not read —
    /// with its handle, and a message to its participant that is no parcel, with none (spec 15.1);
    /// and what a listener of its events threw.
    /// </summary>
    public event Action<Exception, string>? Error;

    /// <summary>Its handles' type: its adapter's.</summary>
    public string Type
    {
        get
        {
            return _participant.Adapter.Type;
        }
    }

    /// <summary>What its stack runs on: its participant's clock.</summary>
    public TimeProvider Clock
    {
        get
        {
            return _participant.Clock;
        }
    }

    /// <summary>The names it serves.</summary>
    public IReadOnlyList<string> Names
    {
        get
        {
            return _options.Names;
        }
    }

    /// <summary>Where it is in its life: Uninitialized until its first start.</summary>
    public ReadyState ReadyState
    {
        get
        {
            return _life.ReadyState;
        }
    }

    /// <summary>
    /// The connections its router was told of, in the order they came, as a copy: each its peer
    /// participant's id as its address, port 0, and when it last delivered an envelope.
    /// </summary>
    public IReadOnlyList<TransportServerClient> Clients
    {
        get
        {
            lock (_gate)
            {
                return [.. _connections.Values.OrderBy((connection) =>
                {
                    return connection.Arrival;
                }).Select((connection) =>
                {
                    return new TransportServerClient(connection.PeerId, connection.ConnectionHandle!, connection.LastActivity, 0, Type);
                })];
            }
        }
    }

    bool IBrokerConnectionOwner.IsOpener
    {
        get
        {
            return false;
        }
    }

    /// <summary>
    /// What it holds: <c>connections</c>, those its router was told of; <c>halfOpen</c>, those
    /// whose third leg has not come; <c>partsBytes</c>, what its participant holds in parts;
    /// <c>unsentBytes</c>, what waits for its broker on its connections; the largest of each one
    /// connection holds; <c>names</c>, the names it holds a subscription to; <c>departures</c>, the
    /// peers' departures its participant subscribes.
    /// </summary>
    public Gauges Gauges()
    {
        lock (_gate)
        {
            var held = _held.ToList();

            return new Gauges
            {
                ConnectionHandles = _connections.Keys.ToHashSet(StringComparer.Ordinal),
                Counts = new Dictionary<string, long>
                {
                    ["connections"] = _connections.Count,
                    ["departures"] = _participant.Departures,
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
                    ["names"] = _subscribed.Count,
                    ["partsBytes"] = _participant.PartsBytes,
                    ["unsentBytes"] = held.Sum((connection) =>
                    {
                        return connection.UnsentBytes;
                    }),
                },
                Ceilings = new Dictionary<string, long>
                {
                    ["connections"] = _options.MaximumConnections,
                    ["largestPartsBytes"] = _participant.PartsBounds.MaximumEnvelopePartsBytes,
                    ["largestUnsentBytes"] = _maximumUnsentBytes,
                    ["partsBytes"] = _participant.PartsBounds.Budget.Budget,
                },
            };
        }
    }

    /// <summary>
    /// Starts its participant where it was not, and serves its names, each subscribed, in its group
    /// where it serves in one; settles once its broker holds them, giving its participant's id and
    /// port 0. Refused with an <see cref="InvalidOperationException"/> unless Uninitialized or Closed.
    /// </summary>
    public Task<TransportServerAddress> Start()
    {
        return _life.Start(async () =>
        {
            await _participant.Start();
            await _participant.Scheduler.Run(Relink);

            return new TransportServerAddress(_participant.Id, 0);
        });
    }

    /// <summary>
    /// Takes no OPEN from now on, refusing 503 one that comes; lets its names go, and closes each
    /// connection with a CLOSE of 1001, its close told unclean; its participant's link is kept (spec
    /// 15.21). It ends Closed.
    /// </summary>
    public Task Stop()
    {
        return _life.Stop(() =>
        {
            return _participant.Scheduler.Run(async () =>
            {
                var names = _subscribed.ToList();

                lock (_gate)
                {
                    _subscribed.Clear();
                }

                foreach (var connection in _held.ToList())
                {
                    connection.Close((1001, false));
                }

                foreach (var name in names)
                {
                    await _participant.Unsubscribe(name);
                }
            });
        });
    }

    /// <summary>As <see cref="Stop"/>: a server's facade stops its transport with it.</summary>
    public Task Shutdown()
    {
        return Stop();
    }

    /// <summary>As <see cref="Stop"/>.</summary>
    public async ValueTask DisposeAsync()
    {
        await Stop();
    }

    /// <summary>Closes a connection with a CLOSE of 1000, its close told clean; false when it held none by that handle.</summary>
    public async Task<bool> CloseConnection(string connectionHandle)
    {
        return await _participant.Scheduler.Run(() =>
        {
            BrokerConnection? connection;

            lock (_gate)
            {
                connection = _connections.GetValueOrDefault(connectionHandle);
            }

            connection?.Close((1000, true));

            return Task.FromResult(connection is not null);
        });
    }

    /// <summary>
    /// Sends an envelope on a connection, in DATA parcels, at once, after what went before; what
    /// goes to a connection not open goes nowhere. A text message, which is no envelope, is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public Task Send(TransportMessage message, string connectionHandle)
    {
        if (message.IsText)
        {
            return Task.FromException(new ArgumentException("a broker's connection carries envelopes, as bytes", nameof(message)));
        }

        // * copied as it is sent: the sender's buffer stays its own
        var copy = new TransportMessage(message.Bytes.ToArray(), false);

        _participant.Scheduler.Post(() =>
        {
            BrokerConnection? connection;

            lock (_gate)
            {
                connection = _connections.GetValueOrDefault(connectionHandle);
            }

            connection?.Send(copy);
        });

        return Task.CompletedTask;
    }

    /// <summary>Nothing is carried toward a client (spec 15.22): a command presenting ELSEWHERE fails before it goes.</summary>
    public bool CarriesCredential(string connectionHandle)
    {
        return false;
    }

    /// <summary>Whether a connection is secure: its own leg and its peer's, as its OPEN said (spec 15.22).</summary>
    public bool IsSecure(string connectionHandle)
    {
        lock (_gate)
        {
            return _isSecure && _connections.TryGetValue(connectionHandle, out var connection) && connection.IsPeerSecure;
        }
    }

    void IBrokerConnectionOwner.Opened(BrokerConnection connection)
    {
        if (_accepting.Remove(connection, out var timer))
        {
            timer.Dispose();
        }

        // * the handle drawn at the third leg, by the proven id and the rank it came at, never
        // given twice (spec 15.1, 0025)
        var arrival = Interlocked.Increment(ref _arrivals);

        connection.Arrival = arrival;
        connection.ConnectionHandle = string.Create(CultureInfo.InvariantCulture, $"type={Type};participant={connection.PeerId};ordinal={arrival}");

        lock (_gate)
        {
            _connections[connection.ConnectionHandle] = connection;
        }

        connection.Open();
        _listeners.Tell(Connection, connection.ConnectionHandle);
    }

    void IBrokerConnectionOwner.Delivered(BrokerConnection connection, TransportMessage message)
    {
        _listeners.Tell(Message, (message, connection.ConnectionHandle!));
    }

    void IBrokerConnectionOwner.Ended(BrokerConnection connection, (bool IsClean, Exception? Reported, bool IsQuick) end)
    {
        if (_accepting.Remove(connection, out var timer))
        {
            timer.Dispose();
        }

        var handle = connection.ConnectionHandle;

        lock (_gate)
        {
            _held.Remove(connection);

            if (handle is not null)
            {
                _connections.Remove(handle);
            }
        }

        // a half-open connection lost is reported with no handle, as its router was never told it
        if (end.Reported is { } reported)
        {
            Error?.Invoke(reported, handle ?? "");
        }

        if (handle is not null)
        {
            _listeners.Tell(Close, (end.IsClean, handle));
        }

        Rejoin();
    }

    /// <summary>In its participant's turn: an OPEN, or what came to one of its names, judged in the order spec 15.18 states.</summary>
    internal void TakeOpen(BrokerParcelReading reading)
    {
        if (reading.Verdict == BrokerParcelVerdict.NoParcel || reading is { Verdict: BrokerParcelVerdict.DoesNotRead, Parcel.Kind: BrokerParcelKinds.Open })
        {
            _participant.Report(new InvalidDataException($"a message to a name served by {_participant.Id} is dropped: {reading.Why}"));

            return;
        }

        var open = reading.Parcel!;

        if (reading.Verdict != BrokerParcelVerdict.Parcel || open.Kind != BrokerParcelKinds.Open)
        {
            return;
        }

        if (open.Layout != BrokerParcels.Layout)
        {
            Refuse((open, 426, "layout-refused"));

            return;
        }

        if (!BrokerParcels.IsToken(open.Id) || open.Bound < BrokerParcels.LeastBound)
        {
            Refuse((open, 400, "malformed"));

            return;
        }

        // ! an OPEN whose id and half name a connection held is a copy, dropped in silence
        if (_held.Any((connection) =>
        {
            return connection.PeerId == open.Id && connection.Pair.Opener == open.Opener;
        }))
        {
            return;
        }

        if (_life.ReadyState != ReadyState.Open || _held.Count >= _options.MaximumConnections || _held.Count((connection) =>
        {
            return connection.PeerId == open.Id;
        }) >= _options.MaximumConnectionsPerAddress)
        {
            Refuse((open, 503, "busy"));

            return;
        }

        Accept(open);
    }

    /// <summary>In its participant's turn: its names subscribed, as it starts and as its participant's link connects again.</summary>
    internal async Task Relink()
    {
        if (_life.ReadyState is not (ReadyState.Open or ReadyState.Connecting) || _isFull)
        {
            return;
        }

        await Join();
    }

    /// <summary>In its participant's turn: its link lost, its names held no more.</summary>
    internal void Unlinked()
    {
        lock (_gate)
        {
            _subscribed.Clear();
        }
    }

    /// <summary>What its participant ends no connection for, reported with none.</summary>
    internal void Report(Exception reason)
    {
        Error?.Invoke(reason, "");
    }

    // in its participant's turn: an OPEN answered with an ACCEPT, its connection half-open, holding
    // its place, its accept timeout armed on the clock given
    private void Accept(BrokerParcel open)
    {
        var connection = new BrokerConnection(_participant, new BrokerConnectionSetup
        {
            Owner = this,
            Opener = open.Opener,
            Acceptor = _participant.DrawHalf(),
            PeerId = open.Id!,
            PeerIncarnation = open.Incarnation!.Value,
            PeerBound = open.Bound!.Value,
            IsPeerSecure = open.Has(BrokerParcelFlags.Secure),
            Sent = 1,
            Awaited = 2,
            MaximumUnsentBytes = _maximumUnsentBytes,
            IsHalfOpen = true,
        });

        lock (_gate)
        {
            _held.Add(connection);
        }

        _participant.Hold(connection);
        _accepting[connection] = _participant.Clock.CreateTimer(
            (_) =>
            {
                _participant.Scheduler.Post(() =>
                {
                    // * forgotten, nothing told and nothing sent (spec 15.18)
                    if (connection.State == BrokerConnectionState.HalfOpen)
                    {
                        connection.Drop();
                    }
                });
            },
            null,
            _options.AcceptTimeout,
            Timeout.InfiniteTimeSpan);

        _ = _participant.Publish(new BrokerPublication
        {
            Topic = _participant.InboxOf(open.Id!),
            Payload = BrokerParcels.Write(new BrokerParcel
            {
                Kind = BrokerParcelKinds.Accept,
                Flags = _isSecure ? BrokerParcelFlags.Secure : (byte)0,
                Opener = open.Opener,
                Acceptor = connection.Pair.Acceptor,
                Sequence = 1,
                Id = _participant.Id,
                Incarnation = _participant.Incarnation,
                Bound = _participant.ReceiveBound,
            }),
        });
        Leave();
    }

    // in its participant's turn: an OPEN refused, to the inbox it names, and told (spec 15.1)
    private void Refuse((BrokerParcel Open, int Status, string Reason) refusal)
    {
        var (open, status, reason) = refusal;

        // what names no inbox, nor a half, is answered nowhere
        if (open.Id is not { Length: > 0 } id || open.Opener == 0)
        {
            return;
        }

        _ = _participant.Publish(new BrokerPublication
        {
            Topic = _participant.InboxOf(id),
            Payload = BrokerParcels.Write(new BrokerParcel
            {
                Kind = BrokerParcelKinds.Refuse,
                Opener = open.Opener,
                Sequence = 1,
                Status = status,
                Layouts = status == 426 ? Layouts : null,
            }),
        });
        _listeners.Tell(Refusal, new TransportServerRefusal(id, null, null, 0, reason, status));
    }

    // in its participant's turn: its names subscribed, alone or in its group
    private async Task Join()
    {
        foreach (var name in _options.Names)
        {
            await _participant.Subscribe((name, _options.IsInGroup));

            lock (_gate)
            {
                _subscribed.Add(name);
            }
        }
    }

    // * served in a group: its names left while it holds its bound, so its capacity is its broker's
    // placement (spec 15.18)
    private void Leave()
    {
        if (!_options.IsInGroup || _isFull || _held.Count < _options.MaximumConnections)
        {
            return;
        }

        _isFull = true;

        foreach (var name in _options.Names)
        {
            lock (_gate)
            {
                _subscribed.Remove(name);
            }

            _ = _participant.Unsubscribe(name);
        }
    }

    // served in a group: its names served again once it holds fewer than its bound
    private void Rejoin()
    {
        if (!_isFull || _held.Count >= _options.MaximumConnections)
        {
            return;
        }

        _isFull = false;

        if (_life.ReadyState == ReadyState.Open && _participant.IsLinked)
        {
            _participant.Scheduler.Cover(Join());
        }
    }
}
