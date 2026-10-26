using System.Globalization;

namespace Bead;

/// <summary>
/// A connect's refusal (spec 15.18), named as section 15.6 names a refusal: the REFUSE's status and
/// reason, and a 426's layouts its server reads; or <c>no-subscriber</c>, its broker saying no
/// participant serves the name.
/// </summary>
public sealed record BrokerRefusal
{
    /// <summary>The reason a broker that says nothing serves the name gives.</summary>
    public const string NoSubscriber = "no-subscriber";

    /// <summary><c>malformed</c>, <c>layout-refused</c>, <c>busy</c>, or <see cref="NoSubscriber"/>.</summary>
    public required string Reason { get; init; }

    /// <summary>The REFUSE's status: 400, 426 or 503; none for <see cref="NoSubscriber"/>.</summary>
    public int? Status { get; init; }

    /// <summary>The layouts a 426 names, those its server reads; none for any other.</summary>
    public IReadOnlyList<int>? Layouts { get; init; }
}

/// <summary>
/// A connect its server refused, or whose name no participant serves (spec 15.18), as the
/// TypeScript side's <c>BrokerRefusedError</c>: the <see cref="Exception.InnerException"/> of the
/// <see cref="ConnectException"/> the connect fails with.
/// </summary>
public sealed class BrokerRefusedException : Exception
{
    /// <summary>A connect refused as <paramref name="refusal"/> says.</summary>
    public BrokerRefusedException(BrokerRefusal refusal)
        : base(MessageOf(refusal))
    {
        Refusal = refusal;
    }

    /// <summary>What refused it.</summary>
    public BrokerRefusal Refusal { get; }

    /// <summary>A connect's failure, its refusal the inner exception (spec 15.18).</summary>
    internal static ConnectException ConnectOf(BrokerRefusal refusal)
    {
        var refused = new BrokerRefusedException(refusal);

        return new ConnectException(refused.Message, refused);
    }

    private static string MessageOf(BrokerRefusal refusal)
    {
        ArgumentNullException.ThrowIfNull(refusal);

        return refusal.Status is { } status
            ? string.Create(CultureInfo.InvariantCulture, $"the server refused the connection: {status} {refusal.Reason}")
            : $"no participant serves the name: {refusal.Reason}";
    }
}

/// <summary>How a broker's client transport is built.</summary>
public sealed record BrokerTransportClientOptions
{
    /// <summary>
    /// What may wait for its broker on its connection (spec 15.23), past which the connection is
    /// lost, a CLOSE of 4000; what a peer keeping every rule can be owed under the router's limits
    /// unless told.
    /// </summary>
    public long? MaximumUnsentBytes { get; init; }
}

/// <summary>Where a broker's client connects — a server's name — and how long it waits.</summary>
public sealed record BrokerConnectOptions
{
    /// <summary>The server's name its OPEN goes to, a token (spec 15.16).</summary>
    public required string Server { get; init; }

    /// <summary>
    /// How long the connect may take before it throws a <see cref="TimeoutException"/>, a link down
    /// waited for among it (spec 15.15): 10 seconds unless told; from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one, or
    /// <see cref="System.Threading.Timeout.InfiniteTimeSpan"/>, which never times out; zero is refused.
    /// </summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(10);
}

/// <summary>
/// A client's transport over a broker's participant (spec 15.18): one connection at a time, opened
/// by an OPEN to a server's name, its sequence 1, naming its half, its participant's id,
/// incarnation and receive bound; it takes the first ACCEPT naming its half, its connection then
/// named by both halves, and sends at once a PING of sequence 2 naming them, the third leg; it
/// resets any other ACCEPT naming its half, of a second acceptor or once its connect ended. It
/// carries the credential a request presents beside it, any field value, on the first part of its
/// DATA, and takes none from its server, closing with 1002 a connection whose server's DATA carries
/// one (spec 15.22). It is secure while its own leg and its server's are, as its ACCEPT said.
/// </summary>
public sealed class BrokerTransportClient : IRouterClientTransport, IAsyncDisposable, IBrokerConnectionOwner
{
    private readonly BrokerParticipant _participant;
    private readonly long _maximumUnsentBytes;
    private readonly ListenerGuard _listeners;
    private readonly Lock _gate = new();
    private volatile ReadyState _readyState = ReadyState.Uninitialized;
    // the options of the last connect its guard let through, which a reconnection connects with
    private BrokerConnectOptions? _lastConnectOptions;
    // what a dispose cancels the connect under way by
    private CancellationTokenSource? _connecting;
    // the open connection; one this side let go of is none, and its end tells nothing
    private BrokerConnection? _connection;
    // what came on it before its connect returned, told once it has, in order; touched in its
    // participant's turn alone
    private List<TransportMessage>? _early;
    private Action? _reconnect;

    internal BrokerTransportClient(BrokerParticipant participant, BrokerTransportClientOptions? options)
    {
        ServerBounds.AssertCount((nameof(BrokerTransportClientOptions.MaximumUnsentBytes), options?.MaximumUnsentBytes ?? 1));

        _participant = participant;
        _maximumUnsentBytes = options?.MaximumUnsentBytes ?? ServerBounds.UnsentBytesOf(RouterLimits.Default);
        _listeners = new ListenerGuard((reason, _) =>
        {
            Error?.Invoke(reason);
        });
    }

    /// <inheritdoc/>
    public event Action<TransportMessage>? Message;

    /// <summary>
    /// The connection closed: clean when its server closed it with 1000, or this side's close was
    /// told so; quick only as this side's close was told, a connection dropped — a RESET, its server
    /// gone, its link lost — telling it unclean and not quick, as a dropped socket. A connection its
    /// connect never returned, a dispose lets go of, or a reconnection replaces, tells none.
    /// </summary>
    public event Action<bool, bool>? Close;

    /// <summary>
    /// What it ends its connection for of its own — a gap, a bound, a parcel that does not read, a
    /// credential its server's DATA carried — a message to its participant that is no parcel, and
    /// what a listener of its events threw (spec 15.1).
    /// </summary>
    public event Action<Exception>? Error;

    /// <summary>
    /// A reconnection starts: what was sent on the connection it replaces will not be answered
    /// there, and an open one it replaces tells no close. Reached through
    /// <see cref="IRouterClientTransport"/>: <see cref="Reconnect"/> names the method here.
    /// </summary>
    event Action? IRouterClientTransport.Reconnect
    {
        add
        {
            lock (_gate)
            {
                _reconnect += value;
            }
        }

        remove
        {
            lock (_gate)
            {
                _reconnect -= value;
            }
        }
    }

    /// <summary>Where it is in its life: Uninitialized until its first connect.</summary>
    public ReadyState ReadyState
    {
        get
        {
            return _readyState;
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

    /// <summary>Whether it is secure: its own leg, and its server's as its ACCEPT said, read per call (spec 15.22).</summary>
    public bool IsSecure
    {
        get
        {
            lock (_gate)
            {
                return _participant.Adapter.IsSecure && _connection is { IsPeerSecure: true };
            }
        }
    }

    /// <summary>The pair its open connection is named by; none while it holds none.</summary>
    internal (ulong Opener, ulong Acceptor)? Pair
    {
        get
        {
            lock (_gate)
            {
                return _readyState == ReadyState.Open ? _connection?.Pair : null;
            }
        }
    }

    bool IBrokerConnectionOwner.IsOpener
    {
        get
        {
            return true;
        }
    }

    /// <summary>It carries any credential a field can hold beside an envelope (spec 15.22): visible ASCII, spaces and tabs, none first or last.</summary>
    public bool Carries(string credential)
    {
        ArgumentNullException.ThrowIfNull(credential);

        return HostsAndOrigins.IsVisibleField(credential);
    }

    /// <summary>
    /// Connects through a server's name; settles once the first ACCEPT naming its half came, its
    /// third leg sent. Refused with an <see cref="ArgumentOutOfRangeException"/> for a timeout
    /// <see cref="BrokerConnectOptions.Timeout"/> does not take, and an <see cref="ArgumentException"/>
    /// for a name that is no token, each leaving its state as it was; with an
    /// <see cref="InvalidOperationException"/> unless Uninitialized or Closed; with an
    /// <see cref="OperationCanceledException"/>, nothing changed, when its token is cancelled
    /// already. Then it throws a <see cref="ConnectException"/> naming the REFUSE it read, its
    /// status and its reason, or <c>no-subscriber</c> when its broker says nothing serves the name,
    /// or a dispose that gave up on it; a <see cref="TimeoutException"/> past its timeout; an
    /// <see cref="OperationCanceledException"/> once its token is cancelled; each ending Closed.
    /// </summary>
    public Task Connect(BrokerConnectOptions options, CancellationToken cancellationToken = default)
    {
        return Connecting(options, (cancellationToken, false));
    }

    /// <summary>
    /// Sends an envelope in DATA parcels, the credential beside it on the first, an empty one
    /// carrying none, at once, after what went before; refused with a
    /// <see cref="DisconnectException"/> unless Open, and with an <see cref="ArgumentException"/>,
    /// its connection kept, for a text message, which is no envelope, a credential no field carries,
    /// or one that leaves a parcel toward its server no byte of the envelope.
    /// </summary>
    public Task Send(TransportMessage message)
    {
        BrokerConnection? connection;

        lock (_gate)
        {
            connection = _readyState == ReadyState.Open ? _connection : null;
        }

        if (connection is null)
        {
            return Task.FromException(new DisconnectException($"the transport client is {NameOf(_readyState)}, not open"));
        }

        if (message.IsText)
        {
            return Task.FromException(new ArgumentException("a broker connection carries envelopes, as bytes", nameof(message)));
        }

        if (message.Credential is { } credential && !HostsAndOrigins.IsVisibleField(credential))
        {
            return Task.FromException(new ArgumentException("a credential holds visible ASCII, spaces and tabs alone, none first or last", nameof(message)));
        }

        // refused before it goes, the connection kept: a parcel toward its server that leaves no
        // byte of the envelope beside its credential (spec 15.20)
        if (!BrokerParts.Fits((connection.Room, string.IsNullOrEmpty(message.Credential) ? null : message.Credential)))
        {
            return Task.FromException(new ArgumentException(string.Create(CultureInfo.InvariantCulture, $"a parcel of {connection.Room} bytes leaves no byte of an envelope beside its credential"), nameof(message)));
        }

        // * copied as it is sent: the sender's buffer stays its own
        var copy = new TransportMessage(message.Bytes.ToArray(), false) { Credential = message.Credential };

        _participant.Scheduler.Post(() =>
        {
            connection.Send(copy);
        });

        return Task.CompletedTask;
    }

    /// <summary>
    /// Closes the connection with a CLOSE of 1000, or by a RESET, at once, where
    /// <see cref="TransportDisconnectOptions.IsClean"/> says it is not clean, and raises its close
    /// as its options say. Refused with a <see cref="DisconnectException"/> unless Open. It ends Closed.
    /// </summary>
    public Task CloseConnection(TransportDisconnectOptions? options = null)
    {
        var isClean = options?.IsClean ?? true;
        var isQuick = options?.IsQuick ?? false;
        BrokerConnection connection;

        lock (_gate)
        {
            if (_readyState != ReadyState.Open || _connection is null)
            {
                return Task.FromException(new DisconnectException($"the transport client is {NameOf(_readyState)}, not open"));
            }

            connection = _connection;
            _connection = null;
            _readyState = ReadyState.Closed;
        }

        _participant.Scheduler.Post(() =>
        {
            if (isClean)
            {
                connection.Close((1000, true));
            }
            else
            {
                connection.Reset();
            }
        });
        _listeners.Tell(Close, (isClean, isQuick));

        return Task.CompletedTask;
    }

    /// <summary>
    /// Connects again through the name of the last connect its guard let through, a pair drawn
    /// anew, replacing an open connection without a close, and raises
    /// <see cref="IRouterClientTransport.Reconnect"/> as it starts. The first attempt goes at once,
    /// each next one after its <see cref="TransportReconnectOptions.Delay"/>. Attempts that run out
    /// end Closed with a <see cref="ReconnectException"/>; a cancel stops them with an
    /// <see cref="OperationCanceledException"/>. A reconnection under way, never connected, or
    /// connecting is an <see cref="InvalidOperationException"/>.
    /// </summary>
    public async Task Reconnect(TransportReconnectOptions? options = null)
    {
        var reconnect = options ?? new TransportReconnectOptions();
        var token = reconnect.CancellationToken;
        BrokerConnectOptions target;
        BrokerConnection? replaced;
        Action? starting;

        lock (_gate)
        {
            if (_readyState == ReadyState.Reconnecting)
            {
                throw new InvalidOperationException("the transport client is already reconnecting");
            }

            if (_lastConnectOptions is null)
            {
                throw new InvalidOperationException("the transport client was never connected");
            }

            if (_readyState is ReadyState.Connecting or ReadyState.Closing)
            {
                throw new InvalidOperationException($"the transport client cannot reconnect while {NameOf(_readyState)}");
            }

            if (token.IsCancellationRequested)
            {
                throw new OperationCanceledException(TransportReconnection.Cancelled, token);
            }

            target = _lastConnectOptions;
            replaced = _connection;
            _connection = null;
            _readyState = ReadyState.Reconnecting;
            starting = _reconnect;
        }

        try
        {
            try
            {
                _listeners.Tell(starting);
            }
            finally
            {
                if (replaced is not null)
                {
                    _participant.Scheduler.Post(() =>
                    {
                        replaced.Reset();
                    });
                }
            }

            await TransportReconnection.Attempting(
                (token) =>
                {
                    return Connecting(target, (token, true));
                },
                (reconnect, _participant.Clock));

            if (token.IsCancellationRequested)
            {
                try
                {
                    await CloseConnection();
                }
                catch (DisconnectException)
                {
                    // closed meanwhile: there is nothing left to close
                }

                throw new OperationCanceledException(TransportReconnection.Cancelled, token);
            }
        }
        catch
        {
            lock (_gate)
            {
                _readyState = ReadyState.Closed;
            }

            throw;
        }
    }

    /// <summary>
    /// Closes an open connection as <see cref="CloseConnection"/> does, its close raised; otherwise
    /// lets go of what it holds, telling nothing: a connect under way fails with a <see cref="ConnectException"/>.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (_readyState == ReadyState.Open)
        {
            try
            {
                await CloseConnection();

                return;
            }
            catch (DisconnectException)
            {
                // closed or replaced meanwhile: what is left is let go of below
            }
        }

        CancellationTokenSource? connecting;

        lock (_gate)
        {
            connecting = _connecting;
            _connecting = null;
        }

        try
        {
            connecting?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // the connect ended meanwhile: there is nothing left to cancel
        }
    }

    void IBrokerConnectionOwner.Opened(BrokerConnection connection)
    {
        // a client's connection opens at its ACCEPT: it awaits no third leg of its own
    }

    void IBrokerConnectionOwner.Delivered(BrokerConnection connection, TransportMessage message)
    {
        if (_early is { } early)
        {
            early.Add(message);

            return;
        }

        lock (_gate)
        {
            if (_connection != connection)
            {
                return;
            }
        }

        _listeners.Tell(Message, message);
    }

    void IBrokerConnectionOwner.Ended(BrokerConnection connection, (bool IsClean, Exception? Reported) end)
    {
        lock (_gate)
        {
            if (_connection != connection)
            {
                return;
            }

            _connection = null;

            // * one its connect has not returned yet tells nothing: the connect fails instead
            if (_readyState != ReadyState.Open)
            {
                return;
            }

            _readyState = ReadyState.Closed;
        }

        _early = null;

        if (end.Reported is { } reported)
        {
            Error?.Invoke(reported);
        }

        _listeners.Tell(Close, (end.IsClean, false));
    }

    // a state as a message words it: "open", "closing"…
    private static string NameOf(ReadyState readyState)
    {
        return readyState.ToString().ToLowerInvariant();
    }

    // a connect, or a reconnection's attempt, which its guard alone tells apart
    private async Task Connecting(BrokerConnectOptions given, (CancellationToken Token, bool IsAttempt) call)
    {
        ArgumentNullException.ThrowIfNull(given);

        if (!BrokerParcels.IsToken(given.Server))
        {
            throw new ArgumentException($"a server's name is a token of base64url's alphabet, 1 to 64 characters, not \"{given.Server}\"", nameof(given));
        }

        var options = given with
        {
            Timeout = Clocks.AssertHeld(("a connect's timeout", nameof(BrokerConnectOptions.Timeout)), given.Timeout),
        };
        var (token, isAttempt) = call;
        var connecting = new CancellationTokenSource();

        lock (_gate)
        {
            if (isAttempt ? _readyState != ReadyState.Reconnecting : _readyState is not (ReadyState.Uninitialized or ReadyState.Closed))
            {
                connecting.Dispose();

                throw new InvalidOperationException($"the transport client is already {NameOf(_readyState)}");
            }

            _lastConnectOptions = options;

            if (token.IsCancellationRequested)
            {
                connecting.Dispose();
                token.ThrowIfCancellationRequested();
            }

            if (!isAttempt)
            {
                _readyState = ReadyState.Connecting;
            }

            _connecting = connecting;
        }

        var clock = _participant.Clock;

        try
        {
            using var timeout = options.Timeout == System.Threading.Timeout.InfiniteTimeSpan ? null : new CancellationTokenSource(options.Timeout, clock);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, connecting.Token, timeout?.Token ?? CancellationToken.None);

            try
            {
                var connection = await Opening(options, linked.Token);

                lock (_gate)
                {
                    if (_connecting == connecting && connection.State == BrokerConnectionState.Open)
                    {
                        _connecting = null;
                        _connection = connection;
                        _readyState = ReadyState.Open;
                    }
                }

                // * after what came before its connect returned, in order, then each as it comes
                _participant.Scheduler.Post(() =>
                {
                    var early = _early ?? [];

                    _early = null;

                    foreach (var message in early)
                    {
                        ((IBrokerConnectionOwner)this).Delivered(connection, message);
                    }
                });

                lock (_gate)
                {
                    if (_connection == connection)
                    {
                        return;
                    }
                }

                if (connection.State != BrokerConnectionState.Open)
                {
                    throw new ConnectException("the server closed the connection as it opened");
                }

                _participant.Scheduler.Post(() =>
                {
                    connection.Reset();
                });

                throw new ConnectException("the transport client was disposed as it connected");
            }
            catch (OperationCanceledException reason) when (connecting.IsCancellationRequested)
            {
                throw new ConnectException("the transport client was disposed as it connected", reason);
            }
            catch (OperationCanceledException reason) when (timeout is { IsCancellationRequested: true } && !token.IsCancellationRequested)
            {
                throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"timed out after {options.Timeout.TotalMilliseconds}ms"), reason);
            }
        }
        catch
        {
            lock (_gate)
            {
                if (_connecting == connecting)
                {
                    _connecting = null;
                }

                if (!isAttempt)
                {
                    _readyState = ReadyState.Closed;
                }
            }

            throw;
        }
        finally
        {
            connecting.Dispose();
        }
    }

    // its OPEN, once its link is up, to the server's name; its connection once the first ACCEPT
    // naming its half came, failed as its link goes down before its answer
    private async Task<BrokerConnection> Opening(BrokerConnectOptions options, CancellationToken cancellationToken)
    {
        await _participant.WhenLinked(cancellationToken);

        BrokerPendingConnect? pending = null;
        Task<BrokerPublished>? published = null;

        await _participant.Scheduler.Run(() =>
        {
            // ! given up as its link came up: no OPEN goes
            cancellationToken.ThrowIfCancellationRequested();

            pending = new BrokerPendingConnect
            {
                Opener = _participant.DrawHalf(),
                Accept = Accepted,
            };
            _participant.Await(pending);
            published = _participant.Publish(new BrokerPublication
            {
                Topic = _participant.NameOf(options.Server),
                Payload = BrokerParcels.Write(new BrokerParcel
                {
                    Kind = BrokerParcelKinds.Open,
                    Flags = _participant.Adapter.IsSecure ? BrokerParcelFlags.Secure : (byte)0,
                    Opener = pending.Opener,
                    Sequence = 1,
                    Id = _participant.Id,
                    Incarnation = _participant.Incarnation,
                    Bound = _participant.ReceiveBound,
                }),
            });

            return Task.CompletedTask;
        });

        try
        {
            // * a broker that says nothing serves the name fails the connect at once (spec 15.18)
            if (await published!.WaitAsync(cancellationToken) == BrokerPublished.NoSubscriber)
            {
                throw BrokerRefusedException.ConnectOf(new BrokerRefusal { Reason = BrokerRefusal.NoSubscriber });
            }

            return await pending!.Settled.WaitAsync(cancellationToken);
        }
        catch
        {
            // ! given up: its late ACCEPT is reset, its parcels no router's (spec 15.18)
            _participant.Scheduler.Post(() =>
            {
                _participant.GiveUp(pending!);
            });

            throw;
        }
    }

    // in its participant's turn: the first ACCEPT naming its half taken, its connection held and
    // opened, its third leg sent at once
    private BrokerConnection Accepted(BrokerParcel accept)
    {
        var connection = new BrokerConnection(_participant, new BrokerConnectionSetup
        {
            Owner = this,
            Opener = accept.Opener,
            Acceptor = accept.Acceptor,
            PeerId = accept.Id!,
            PeerIncarnation = accept.Incarnation!.Value,
            PeerBound = accept.Bound!.Value,
            IsPeerSecure = accept.Has(BrokerParcelFlags.Secure),
            Sent = 1,
            Awaited = 2,
            MaximumUnsentBytes = _maximumUnsentBytes,
            IsHalfOpen = false,
        });

        _early = [];
        lock (_gate)
        {
            _connection = connection;
        }

        _participant.Hold(connection);
        connection.Open();
        connection.Ping();

        return connection;
    }
}
