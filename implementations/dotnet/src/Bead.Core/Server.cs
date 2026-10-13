using System.Diagnostics.CodeAnalysis;

namespace Bead;

/// <summary>
/// What a server needs of its transport, beyond its router's needs: closing a connection, stopping,
/// and, over HTTP, being told when a listen is held and when it ends.
/// </summary>
public interface IServerTransport : IRouterServerTransport
{
    /// <summary>
    /// A listen held on a connection, true, once its refusals passed, and its end, false, while the
    /// connection stands: over HTTP alone, whose listen is no silence (spec 13.7). A transport that
    /// has no listen never raises it, as this default.
    /// </summary>
    event Action<bool, string>? Listen
    {
        add
        {
        }

        remove
        {
        }
    }

    /// <summary>
    /// Each refusal the transport judges of its own (spec 15.1), within the guard its other events
    /// are told in, a listener's throw reported with no connection: what to add to its hosts or
    /// origins. A transport that refuses nothing of its own never raises it, as this default.
    /// </summary>
    event Action<TransportServerRefusal>? Refusal
    {
        add
        {
        }

        remove
        {
        }
    }

    /// <summary>
    /// What went wrong on a connection, with its handle, as spec 9.0 reports an error: what a
    /// listener of its events threw, the transport going on as if it returned (spec 15.1), or what
    /// broke a connection's socket; with the empty handle for a throw of a <see cref="Refusal"/>
    /// listener, which names no connection. The routers forward none of it to their own error, so
    /// an application hears it here, whichever transport it built. A transport that reports nothing
    /// never raises it, as this default.
    /// </summary>
    [SuppressMessage(
        "Naming",
        "CA1716:Identifiers should not match keywords",
        Justification = "each transport's event is Error, as every router's and the TypeScript side's error: one word, one meaning (0003)")]
    event Action<Exception, string>? Error
    {
        add
        {
        }

        remove
        {
        }
    }

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
    /// How long a connection without a session may stay silent before it is closed — one that never
    /// opened a session, or one whose session ended, counted from that end; over HTTP, a listen held
    /// is no silence, and the count starts anew at its end. Infinite when none, unless a facade says
    /// otherwise. From 1 to <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest
    /// whole one; one neither infinite nor in that range, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public TimeSpan? ConnectionInactivityTimeout { get; init; }

    /// <summary>How its sessions are built: on the server's clock, which a clock of their own must be.</summary>
    public SessionManagerOptions? Sessions { get; init; }

    /// <summary>
    /// What its router resolves a request's <see cref="CredentialScheme.Jwt"/> and
    /// <see cref="CredentialScheme.Elsewhere"/> with, on the server's clock; it takes no other when
    /// none (spec 9.2, step 5).
    /// </summary>
    public Credentials? Credentials { get; init; }

    /// <summary>
    /// How the router relays a request that names a destination registered in it. Its
    /// <see cref="RelayOptions.BeforeRoute"/> is <see cref="Server{TData}.RequireCredential"/> when
    /// none: a relay is a door to what is behind it, and admits by default only a credential it
    /// forwards, for its destination to verify. A relay whose requesters log in at it gives one that
    /// checks the destination against the requester's session;
    /// <see cref="Server{TData}.ShareLegBSession"/> lends leg B's session to every requester in a
    /// session of leg A's, at every destination: a choice to write.
    /// </summary>
    public RelayOptions? Relay { get; init; }

    /// <summary>
    /// Whether a command the server asks, unanswered in time, closes the connection it went to —
    /// unless the command's own options say otherwise; none closes nothing.
    /// </summary>
    public bool? CloseOnCommandTimeout { get; init; }

    /// <summary>
    /// What it counts its calls and its notifications into, given to its router (spec/debugging.md
    /// 7.1); none counts nothing.
    /// </summary>
    public MetricsRegistry? MetricsRegistry { get; init; }

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
/// and the others take <see cref="RequireSession"/>, which refuses a call in none that presented no
/// credential with SESSION_REQUIRED, and one that presented a credential with ACCESS_DENIED. A
/// request presenting none runs in its connection's session, with its data, and one presenting
/// OPAQUE in that session when it carries its token. A procedure that closes a session deletes it
/// before it answers, so the next answer announces the end. Each
/// message is activity. Past a session's connection timeout, its connection is closed; past its
/// session timeout, the session ends — each subscription of its connection with SESSION_REQUIRED —
/// and the connection stays, its silence counted afresh against the server's own timeout. A listen
/// held over HTTP is no silence: no connection timeout runs while one is, and each counts anew from
/// its end; a session timeout counts messages alone (spec 13.7). A connection that closes takes its
/// session, and a session stored for a connection already closed goes at once.
/// </summary>
/// <typeparam name="TData">What a session keeps.</typeparam>
public sealed class Server<TData> : IBeadServer<TData>
{
    // what a relay's default admission tells a call it refuses, the same bytes on every side, so a
    // hub whose requesters present none finds the default by its own words
    private const string RelayAdmitsCredentialsAlone = "a relay admits by default only a credential it forwards";

    private readonly Lock _gate = new();
    private readonly TimeSpan _connectionInactivityTimeout;
    private readonly TimeProvider _clock;

    // the connections the transport holds: only these keep a session; this server hears of each
    // before its router does, and forgets it first
    private readonly HashSet<string> _connections = [];

    // the connections being closed, so each is asked to close once
    private readonly HashSet<string> _closing = [];

    // the connections with no session, each with the timer that closes it once silent, when one runs
    private readonly Dictionary<string, ITimer?> _idle = [];

    // the listens each connection holds: a second comes before the first it replaces ends
    private readonly Dictionary<string, int> _listens = [];

    /// <summary>
    /// A server over <paramref name="transport"/>, its layers built in order, all on its transport's
    /// clock: one given that differs, to the server or to its sessions, is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public Server(IServerTransport transport, ServerOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(transport);

        Transport = transport;

        // held here rather than refused as the first connection opens, where its timer would throw
        _connectionInactivityTimeout = Clocks.AssertHeld(
            ("a connection's inactivity timeout", nameof(ServerOptions.ConnectionInactivityTimeout)),
            options?.ConnectionInactivityTimeout ?? Timeout.InfiniteTimeSpan);

        _clock = Clocks.Of((options?.Clock, transport.Clock), ("a server", "its transport"));

        var sessions = options?.Sessions ?? new SessionManagerOptions();

        Sessions = new SessionManager<TData>(sessions with
        {
            Clock = Clocks.Of((sessions.Clock, _clock), ("a server's sessions", "their server")),
        });
        RequireSession = new BeforeRequest(
            (request) =>
            {
                return request.Session is not null;
            },
            Failure.OfProtocol(ProtocolCode.SessionRequired));
        RequireCredential = new BeforeRequest(
            (request) =>
            {
                return request.Header.Credential?.Scheme is CredentialScheme.Jwt or CredentialScheme.Elsewhere;
            },
            Failure.OfProtocol(ProtocolCode.AccessDenied, RelayAdmitsCredentialsAlone));
        ShareLegBSession = new BeforeRequest(
            (request) =>
            {
                return request.Session is not null || request.Header.Credential?.Scheme is CredentialScheme.Jwt or CredentialScheme.Elsewhere;
            },
            Failure.OfProtocol(ProtocolCode.SessionRequired));

        // before the router's own, in the order handlers run: a resolver that stores a session as
        // the router reads the envelope finds its connection open already
        transport.Connection += OnConnection;
        transport.Message += OnMessage;
        transport.Listen += OnListen;
        transport.Close += OnClose;

        // limits that do not hold together refuse the router: the server lets go of its transport
        try
        {
            Router = new RouterServer(
                transport,
                new RouterServerOptions
                {
                    Credentials = options?.Credentials,
                    Limits = options?.Limits,
                    MetricsRegistry = options?.MetricsRegistry,
                    Pacing = options?.Pacing,
                    Relay = (options?.Relay ?? new RelayOptions()) with { BeforeRoute = options?.Relay?.BeforeRoute ?? RequireCredential },
                    ResolverScheduler = options?.ResolverScheduler,
                    Scheduler = options?.Scheduler,
                    SessionTokenOf = Sessions.SessionTokenOf,
                    SessionOf = (request, _) =>
                    {
                        // in the turn it came: its token read at once with its data, so a session
                        // drawn anew meanwhile never lends its data to another's token
                        var session = Sessions.Get(request.ConnectionHandle);

                        return ValueTask.FromResult(CallSession.ConnectionSessionOf(
                            request.Header.Credential,
                            session is null ? (null, null) : (session.SessionToken, session.Data)));
                    },
                    Clock = _clock,
                });
        }
        catch
        {
            transport.Connection -= OnConnection;
            transport.Message -= OnMessage;
            transport.Listen -= OnListen;
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
        Sessions.Updated += OnSessionStored;
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
                new Dictionary<string, long> { ["closing"] = _closing.Count, ["connections"] = _connections.Count, ["idle"] = _idle.Count, ["listening"] = _listens.Count },
                _connections.Concat(_idle.Keys).Concat(_listens.Keys));
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

    /// <summary>
    /// The admission of a procedure that needs a session: a call in none — its call's session, never
    /// its connection's — is refused with SESSION_REQUIRED, which a call that presented a credential
    /// is answered ACCESS_DENIED in place of (spec 9.2, step 5). A relay's in its place so refuses
    /// every credential it forwards without verifying, which resolves to no session there, and a call
    /// in none that presented none with SESSION_REQUIRED.
    /// </summary>
    public BeforeRequest RequireSession { get; }

    /// <summary>
    /// A relay's admission by default (spec 14.3, step 1): a call whose header presents a
    /// <see cref="CredentialScheme.Jwt"/>, or an <see cref="CredentialScheme.Elsewhere"/> its
    /// transport carried, read from its credential scheme alone unless the relay
    /// <see cref="RelayOptions.Verifies"/> — a credential it forwards, which its destination
    /// verifies. Any other, one that presents none or OPAQUE, in leg A's connection's session or in
    /// none, is refused with ACCESS_DENIED, its detail "a relay admits by default only a credential
    /// it forwards": leg A's session opens nothing at the destination, and a relay that lent leg B's
    /// session to it would lend its own authority (CWE-441).
    /// </summary>
    public BeforeRequest RequireCredential { get; }

    /// <summary>
    /// A relay's admission that lends leg B's session (spec 14.3, step 1, 14.7): a call in any
    /// session of leg A's connection's, whatever its destination, which then runs in leg B's session
    /// there, or one whose header presents a <see cref="CredentialScheme.Jwt"/> or an
    /// <see cref="CredentialScheme.Elsewhere"/>, read from its scheme alone; a call in none that
    /// presented none is refused with SESSION_REQUIRED. It reads no destination: a
    /// <see cref="RelayOptions.BeforeRoute"/> that checks the destination against the session is
    /// the one to write.
    /// </summary>
    public BeforeRequest ShareLegBSession { get; }

    /// <summary>Follows its transport no more, disposes its router and its sessions, then stops its transport.</summary>
    public async ValueTask DisposeAsync()
    {
        Transport.Connection -= OnConnection;
        Transport.Message -= OnMessage;
        Transport.Listen -= OnListen;
        Transport.Close -= OnClose;
        Sessions.Created -= OnSessionCreated;
        Sessions.Updated -= OnSessionStored;
        Sessions.Deleted -= OnSessionDeleted;
        Sessions.ConnectionInactivityTimeoutReached -= OnConnectionInactive;
        Sessions.SessionInactivityTimeoutReached -= OnSessionInactive;

        lock (_gate)
        {
            foreach (var timer in _idle.Values)
            {
                timer?.Dispose();
            }

            _idle.Clear();
            _listens.Clear();
            _connections.Clear();
            _closing.Clear();
        }

        // the reverse of the order they were built in; the router's teardown, posted to its
        // scheduler, has run before the transport stops: what it forgot keeps no timer past it. The
        // transport stops whatever that teardown does
        Router.Dispose();
        Sessions.Dispose();

        try
        {
            await Router.WhenDisposed;
        }
        finally
        {
            await Transport.Shutdown();
        }
    }

    private void StopWaiting(string connectionHandle)
    {
        lock (_gate)
        {
            if (_idle.Remove(connectionHandle, out var timer))
            {
                timer?.Dispose();
            }
        }
    }

    // a connection that was never opened or is gone keeps nothing
    private void ForgetConnection(string connectionHandle)
    {
        lock (_gate)
        {
            _connections.Remove(connectionHandle);
            _listens.Remove(connectionHandle);
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

    // a connection without a session is closed once silent for the server's own timeout, counted
    // afresh; ! none runs while a listen is held, whose end arms it
    private void Wait(string connectionHandle)
    {
        lock (_gate)
        {
            _idle.GetValueOrDefault(connectionHandle)?.Dispose();
            _idle[connectionHandle] = _connectionInactivityTimeout == Timeout.InfiniteTimeSpan || _listens.ContainsKey(connectionHandle)
                ? null
                : _clock.CreateTimer(
                    (_) =>
                    {
                        Close(connectionHandle);
                    },
                    null,
                    _connectionInactivityTimeout,
                    Timeout.InfiniteTimeSpan);
        }
    }

    // a session's connection timer, stopped while a listen is held; its session timer runs on
    private void HoldSession(string connectionHandle)
    {
        Sessions.ResetConnectionInactivityTimeout(new Session<TData> { ConnectionHandle = connectionHandle }, Timeout.InfiniteTimeSpan);
    }

    // the end of the last listen held: the connection's silence counts anew from it
    private void Resume(string connectionHandle)
    {
        if (Sessions.Get(connectionHandle) is { } session)
        {
            Sessions.ResetConnectionInactivityTimeout(session, session.ConnectionInactivityTimeout ?? Timeout.InfiniteTimeSpan);

            return;
        }

        Wait(connectionHandle);
    }

    private void OnConnection(string connectionHandle)
    {
        lock (_gate)
        {
            _connections.Add(connectionHandle);
        }

        Wait(connectionHandle);
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
            Wait(connectionHandle);

            return;
        }

        lock (_gate)
        {
            if (_listens.ContainsKey(connectionHandle))
            {
                HoldSession(connectionHandle);
            }
        }
    }

    // the first listen held stops the connection's timers, and the end of the last arms them afresh;
    // a listen of a connection the server does not hold counts nothing. Under the lock, so a listen
    // that ends and the one taking its place, told on two threads, leave what the count says
    private void OnListen(bool isHeld, string connectionHandle)
    {
        lock (_gate)
        {
            var before = _listens.GetValueOrDefault(connectionHandle);
            var after = before + (isHeld ? 1 : -1);

            if (!_connections.Contains(connectionHandle) || after < 0)
            {
                return;
            }

            if (after == 0)
            {
                _listens.Remove(connectionHandle);
                Resume(connectionHandle);

                return;
            }

            _listens[connectionHandle] = after;

            if (before == 0 && _idle.ContainsKey(connectionHandle))
            {
                Wait(connectionHandle);
            }
            else if (before == 0)
            {
                HoldSession(connectionHandle);
            }
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
        OnSessionStored(session);
    }

    // a session stored anew restarts its connection timer, which a listen held keeps stopped
    private void OnSessionStored(Session<TData> session)
    {
        lock (_gate)
        {
            if (_listens.ContainsKey(session.ConnectionHandle))
            {
                HoldSession(session.ConnectionHandle);
            }
        }
    }

    // a session that ended takes with it what its connection subscribed to — each subscription with
    // SESSION_REQUIRED — and leaves the connection the server's own timeout, counted from the end;
    // the drop goes to the router at once, ahead of the answer of the procedure that ended the
    // session
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
        Wait(session.ConnectionHandle);
    }

    // a connection silent too long is gone: closing it ends its session too. ! One whose listen is
    // held is not silent, whatever armed its timer meanwhile — the listen's end arms it afresh
    private void OnConnectionInactive(Session<TData> session)
    {
        bool isListening;

        lock (_gate)
        {
            isListening = _listens.ContainsKey(session.ConnectionHandle);
        }

        if (!isListening)
        {
            Close(session.ConnectionHandle);
        }
    }

    // a session unused too long ends; its connection stays, to open another
    private void OnSessionInactive(Session<TData> session)
    {
        Sessions.Delete(session.ConnectionHandle);
    }
}
