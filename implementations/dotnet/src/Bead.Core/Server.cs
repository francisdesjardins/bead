namespace Bead;

/// <summary>What a server needs of its transport, beyond its router's needs: closing a connection, and stopping.</summary>
public interface IServerTransport : IRouterServerTransport
{
    /// <summary>Closes a connection; false when the transport held none by that handle.</summary>
    Task<bool> CloseConnection(string connectionHandle);

    /// <summary>Closes every connection, and stops listening: the TypeScript side's <c>stop</c>.</summary>
    Task Shutdown();

    /// <summary>
    /// What it holds, the connections first; none by default, for a transport that counts nothing:
    /// the server's own connections then stand for them.
    /// </summary>
    Gauges? Gauges()
    {
        return null;
    }
}

/// <summary>How a server is built.</summary>
public sealed record ServerOptions
{
    /// <summary>What its router reads, writes and holds by.</summary>
    public RouterLimits? Limits { get; init; }

    /// <summary>What each paced subscription queues at most.</summary>
    public PacingLimits? Pacing { get; init; }

    /// <summary>
    /// How long a connection without a session may stay silent before it is closed; infinite when
    /// none, unless a facade says otherwise. A negative one, or one longer than
    /// <see cref="Clocks.LongestTimer"/>, is an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public TimeSpan? ConnectionInactivityTimeout { get; init; }

    /// <summary>How its sessions are built: on the server's clock, which a clock of their own must be.</summary>
    public SessionManagerOptions? Sessions { get; init; }

    /// <summary>
    /// How the router relays a request that names a destination registered in it. Its
    /// <see cref="RelayOptions.BeforeRoute"/> is <see cref="Server{TData}.RequireSession"/> when none:
    /// a relay is a door to what is behind it.
    /// </summary>
    public RelayOptions? Relay { get; init; }

    /// <summary>
    /// Whether a command the server asks, unanswered in time, closes the connection it went to —
    /// unless the command's own options say otherwise; none closes nothing.
    /// </summary>
    public bool? CloseOnCommandTimeout { get; init; }

    /// <summary>
    /// What its timers run on: its transport's clock when none; another is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>Where resolvers run: the thread pool when none.</summary>
    internal TaskScheduler? ResolverScheduler { get; init; }

    /// <summary>The scheduler the router runs on; one of its own when none.</summary>
    internal SerialScheduler? Scheduler { get; init; }
}

/// <summary>
/// A server from its layers, bottom up: the transport, the router built on it, the services built on
/// the router, and the sessions whose tokens the router announces to their connections as they
/// change. A session is made by a request: the resolver of the procedure that opens one stores it,
/// and the others take <see cref="RequireSession"/>, which refuses with SESSION_REQUIRED. A procedure
/// that closes a session deletes it before it answers, so the next answer announces the end. Each
/// message is activity. Past a session's connection timeout, its connection is closed; past its
/// session timeout, the session ends — each subscription of its connection with SESSION_REQUIRED —
/// and the connection stays, its silence counted afresh. A connection that closes takes its session,
/// and a session stored for a connection already closed goes at once.
/// </summary>
/// <typeparam name="TData">What a session keeps.</typeparam>
public sealed class Server<TData> : IAsyncDisposable
{
    private readonly Lock _gate = new();
    private readonly TimeSpan _connectionInactivityTimeout;
    private readonly TimeProvider _clock;

    // the connections the transport holds: only these keep a session; this server hears of each
    // before its router does, and forgets it first
    private readonly HashSet<string> _connections = [];

    // the connections being closed, so each is asked to close once
    private readonly HashSet<string> _closing = [];

    // a connection with no session: how long it may stay silent, and the timer that closes it
    private readonly Dictionary<string, (TimeSpan Timeout, ITimer? Timer)> _idle = [];

    /// <summary>
    /// A server over <paramref name="transport"/>, its layers built in order, all on its transport's
    /// clock: one given that differs, to the server or to its sessions, is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public Server(IServerTransport transport, ServerOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(transport);

        Transport = transport;
        _connectionInactivityTimeout = options?.ConnectionInactivityTimeout ?? Timeout.InfiniteTimeSpan;

        // refused here rather than as the first connection opens, where its timer would throw
        if (_connectionInactivityTimeout < TimeSpan.Zero && _connectionInactivityTimeout != Timeout.InfiniteTimeSpan)
        {
            throw new ArgumentOutOfRangeException(
                nameof(options),
                $"a connection's inactivity timeout cannot be negative, got {_connectionInactivityTimeout}");
        }

        if (_connectionInactivityTimeout > Clocks.LongestTimer)
        {
            throw new ArgumentOutOfRangeException(
                nameof(options),
                $"a connection's inactivity timeout is {Clocks.LongestTimer.TotalMilliseconds} milliseconds at most, as a timer holds, got {_connectionInactivityTimeout.TotalMilliseconds}");
        }

        _clock = Clocks.Of((options?.Clock, transport.Clock), ("a server", "its transport"));

        var sessions = options?.Sessions ?? new SessionManagerOptions();

        Sessions = new SessionManager<TData>(sessions with
        {
            Clock = Clocks.Of((sessions.Clock, _clock), ("a server's sessions", "their server")),
        });
        RequireSession = new BeforeRequest(
            (request) =>
            {
                return Sessions.Has(request.ConnectionHandle);
            },
            Failure.OfProtocol(ProtocolCode.SessionRequired));

        // before the router's own, in the order handlers run: a resolver that stores a session as
        // the router reads the envelope finds its connection open already
        transport.Connection += OnConnection;
        transport.Message += OnMessage;
        transport.Close += OnClose;

        // limits that do not hold together refuse the router: the server lets go of its transport
        try
        {
            Router = new RouterServer(
                transport,
                new RouterServerOptions
                {
                    Limits = options?.Limits,
                    Pacing = options?.Pacing,
                    Relay = (options?.Relay ?? new RelayOptions()) with { BeforeRoute = options?.Relay?.BeforeRoute ?? RequireSession },
                    ResolverScheduler = options?.ResolverScheduler,
                    Scheduler = options?.Scheduler,
                    SessionTokenOf = Sessions.SessionTokenOf,
                    Clock = _clock,
                });
        }
        catch
        {
            transport.Connection -= OnConnection;
            transport.Message -= OnMessage;
            transport.Close -= OnClose;
            Sessions.Dispose();

            throw;
        }

        Services = new ServiceManager(
            Router,
            new ServiceManagerOptions
            {
                CloseConnection = Close,
                Defaults = new RequestDefaults { CloseOnTimeout = options?.CloseOnCommandTimeout },
            });
        Sessions.Created += OnSessionCreated;
        Sessions.Deleted += OnSessionDeleted;
        Sessions.ConnectionInactivityTimeoutReached += OnConnectionInactive;
        Sessions.SessionInactivityTimeoutReached += OnSessionInactive;
    }

    /// <summary>Its transport.</summary>
    public IServerTransport Transport { get; }

    /// <summary>What its timers run on, and every layer's: its transport's clock.</summary>
    public TimeProvider Clock
    {
        get
        {
            return _clock;
        }
    }

    /// <summary>Its router.</summary>
    public RouterServer Router { get; }

    /// <summary>Its services.</summary>
    public ServiceManager Services { get; }

    /// <summary>Its sessions.</summary>
    public SessionManager<TData> Sessions { get; }

    /// <summary>
    /// What each layer holds, set against the connections the transport holds — the server's own,
    /// when it counts nothing; one being closed is counted, and stands for no connection until its
    /// close ends.
    /// </summary>
    public async Task<ServerGauges> Gauges()
    {
        var router = await Router.Gauges();
        Gauges own;
        Gauges held;

        lock (_gate)
        {
            own = Bead.Gauges.Of(
                new Dictionary<string, long> { ["closing"] = _closing.Count, ["connections"] = _connections.Count, ["idle"] = _idle.Count },
                _connections.Concat(_idle.Keys));
            held = Transport.Gauges() ?? Bead.Gauges.Of(new Dictionary<string, long>(), _connections);
        }

        return new ServerGauges(
            LayerGauges.Of(router, held.ConnectionHandles),
            LayerGauges.Of(own, held.ConnectionHandles),
            LayerGauges.Of(Sessions.Gauges(), held.ConnectionHandles),
            LayerGauges.Of(held, held.ConnectionHandles));
    }

    /// <summary>
    /// The verdict on its gauges: a fail for a connection kept that the transport no longer holds, or
    /// an anomaly; a warning for a count near its ceiling. A timer held by a closure — a socket's
    /// heartbeat, its close timeout, a transfer's stall — counts in no gauge.
    /// </summary>
    public async Task<Health> Health()
    {
        return Bead.Health.Of(await Gauges());
    }

    /// <summary>The admission of a procedure that needs a session: refused with SESSION_REQUIRED without one.</summary>
    public BeforeRequest RequireSession { get; }

    /// <summary>Follows its transport no more, disposes its router and its sessions, then stops its transport.</summary>
    public async ValueTask DisposeAsync()
    {
        Transport.Connection -= OnConnection;
        Transport.Message -= OnMessage;
        Transport.Close -= OnClose;
        Sessions.Created -= OnSessionCreated;
        Sessions.Deleted -= OnSessionDeleted;
        Sessions.ConnectionInactivityTimeoutReached -= OnConnectionInactive;
        Sessions.SessionInactivityTimeoutReached -= OnSessionInactive;

        lock (_gate)
        {
            foreach (var (_, timer) in _idle.Values)
            {
                timer?.Dispose();
            }

            _idle.Clear();
            _connections.Clear();
        }

        // the reverse of the order they were built in
        Router.Dispose();
        Sessions.Dispose();
        await Transport.Shutdown();
    }

    private void StopWaiting(string connectionHandle)
    {
        lock (_gate)
        {
            if (_idle.Remove(connectionHandle, out var idle))
            {
                idle.Timer?.Dispose();
            }
        }
    }

    // a connection that was never opened or is gone keeps nothing
    private void ForgetConnection(string connectionHandle)
    {
        lock (_gate)
        {
            _connections.Remove(connectionHandle);
        }

        StopWaiting(connectionHandle);
        Sessions.Delete(connectionHandle);
    }

    // a close that fails is the router's to report; one the transport no longer holds tells no
    // close, so what it left goes now
    private void Close(string connectionHandle)
    {
        lock (_gate)
        {
            if (!_closing.Add(connectionHandle))
            {
                return;
            }
        }

        _ = Closing(connectionHandle);
    }

    private async Task Closing(string connectionHandle)
    {
        try
        {
            if (!await Transport.CloseConnection(connectionHandle))
            {
                ForgetConnection(connectionHandle);
            }
        }
        catch (Exception reason)
        {
            Router.Report(reason, connectionHandle);
        }
        finally
        {
            lock (_gate)
            {
                _closing.Remove(connectionHandle);
            }
        }
    }

    // a connection without a session is closed once silent for its own timeout
    private void Wait(string connectionHandle, TimeSpan timeout)
    {
        lock (_gate)
        {
            var (kept, timer) = _idle.GetValueOrDefault(connectionHandle, (timeout, null));

            timer?.Dispose();
            _idle[connectionHandle] = (kept, kept == Timeout.InfiniteTimeSpan
                ? null
                : _clock.CreateTimer(
                    (_) =>
                    {
                        Close(connectionHandle);
                    },
                    null,
                    kept,
                    Timeout.InfiniteTimeSpan));
        }
    }

    private void OnConnection(string connectionHandle)
    {
        lock (_gate)
        {
            _connections.Add(connectionHandle);
        }

        Wait(connectionHandle, _connectionInactivityTimeout);
    }

    // each message is activity, whatever the router makes of it; a connection that speaks is open
    private void OnMessage(TransportMessage message, string connectionHandle)
    {
        lock (_gate)
        {
            _connections.Add(connectionHandle);
        }

        if (!Sessions.Touch(connectionHandle))
        {
            Wait(connectionHandle, _connectionInactivityTimeout);
        }
    }

    private void OnClose(bool wasClean, string connectionHandle)
    {
        ForgetConnection(connectionHandle);
    }

    // a session stored once its connection was gone would outlive it; the session's own timers take
    // over from the idle one
    private void OnSessionCreated(Session<TData> session)
    {
        bool isConnected;

        lock (_gate)
        {
            isConnected = _connections.Contains(session.ConnectionHandle);
        }

        if (!isConnected)
        {
            Sessions.Delete(session.ConnectionHandle);

            return;
        }

        StopWaiting(session.ConnectionHandle);
    }

    // a session that ended takes with it what its connection subscribed to — each subscription with
    // SESSION_REQUIRED — and leaves the connection its connection timeout; the drop goes to the
    // router at once, ahead of the answer of the procedure that ended the session
    private void OnSessionDeleted(Session<TData> session)
    {
        bool isConnected;

        lock (_gate)
        {
            isConnected = _connections.Contains(session.ConnectionHandle);
        }

        if (!isConnected)
        {
            return;
        }

        _ = Router.DropSubscriptions(session.ConnectionHandle, Failure.OfProtocol(ProtocolCode.SessionRequired));
        Wait(session.ConnectionHandle, session.ConnectionInactivityTimeout);
    }

    // a connection silent too long is gone: closing it ends its session too
    private void OnConnectionInactive(Session<TData> session)
    {
        Close(session.ConnectionHandle);
    }

    // a session unused too long ends; its connection stays, to open another
    private void OnSessionInactive(Session<TData> session)
    {
        Sessions.Delete(session.ConnectionHandle);
    }
}
