using System.Security.Cryptography;

namespace Bead;

/// <summary>
/// A connection's session: its token, which the router announces to the connection, its data, and
/// the two inactivity timeouts that tell the server when to drop it. A record: it is copied, never
/// shared, and its data is best immutable, as the TypeScript side stores a clone.
/// </summary>
/// <typeparam name="TData">What the server keeps about the session.</typeparam>
public sealed record Session<TData>
{
    /// <summary>The connection the session is.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>
    /// How long without activity before its connection is closed: from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, stored rounded to the nearest whole one, or
    /// infinite for never; zero is refused. Left out, or none, it is stored as the manager's default; a
    /// session handed out always holds one.
    /// </summary>
    public TimeSpan? ConnectionInactivityTimeout { get; init; }

    /// <summary>What the server keeps about the session.</summary>
    public TData? Data { get; init; }

    /// <summary>When its connection last spoke, on its manager's clock.</summary>
    public DateTimeOffset LastActivity { get; init; }

    /// <summary>As <see cref="ConnectionInactivityTimeout"/>, before the session ends.</summary>
    public TimeSpan? SessionInactivityTimeout { get; init; }

    /// <summary>What the router announces to the connection; none until <c>Set</c> draws one.</summary>
    public SessionToken? SessionToken { get; init; }
}

/// <summary>How a session manager is built.</summary>
public sealed record SessionManagerOptions
{
    /// <summary>
    /// The connection timeout a session set with none takes: 600 ms, as the TypeScript side's. From
    /// 1 to <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one, or
    /// infinite for never; any other, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/> as the manager is built.
    /// </summary>
    public TimeSpan ConnectionInactivityTimeout { get; init; } = TimeSpan.FromMilliseconds(600);

    /// <summary>As <see cref="ConnectionInactivityTimeout"/>, for the session timeout: 30 s.</summary>
    public TimeSpan SessionInactivityTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// What its timers run on; the system's clock when none. A server's sessions run on the server's
    /// clock, and one given that differs is an <see cref="ArgumentException"/>.
    /// </summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>
    /// Whether a session's data and another are alike, so storing one changes nothing: the TypeScript
    /// side compares them by their structure, this side by the data's own <c>Equals</c> when none is
    /// given — a record's, by its values; a list's, by reference.
    /// </summary>
    public System.Collections.IEqualityComparer? DataComparer { get; init; }

    /// <summary>What fills a token's bytes as it is drawn: a cryptographic source when none, a test's own to draw what it says.</summary>
    internal Action<Span<byte>>? Fill { get; init; }
}

/// <summary>
/// The sessions of a server, by connection: each one's token, its data, and its two inactivity
/// timers. Called from any thread — a resolver, a timer — it holds one lock, and raises its events
/// once it let go of it, so a handler may call it back.
/// </summary>
/// <typeparam name="TData">What the server keeps about a session.</typeparam>
public sealed class SessionManager<TData> : IDisposable
{
    private readonly Lock _gate = new();
    private readonly TimeSpan _connectionTimeoutDefault;
    private readonly TimeSpan _sessionTimeoutDefault;
    private readonly TimeProvider _clock;
    private readonly Action<Span<byte>> _fill;
    private readonly System.Collections.IEqualityComparer? _dataComparer;

    // by token, so a draw or a check costs nothing, and by connection through the token each holds
    private readonly Dictionary<SessionToken, Session<TData>> _sessions = [];
    private readonly Dictionary<string, SessionToken> _tokens = [];
    private readonly Dictionary<string, (ITimer? Connection, ITimer? Session)> _timers = [];
    private bool _isDisposed;

    /// <summary>
    /// A session manager, its default timeouts held: one neither infinite nor from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public SessionManager(SessionManagerOptions? options = null)
    {
        _connectionTimeoutDefault = Clocks.AssertHeld(
            (nameof(SessionManagerOptions.ConnectionInactivityTimeout), nameof(SessionManagerOptions.ConnectionInactivityTimeout)),
            options?.ConnectionInactivityTimeout ?? TimeSpan.FromMilliseconds(600));
        _sessionTimeoutDefault = Clocks.AssertHeld(
            (nameof(SessionManagerOptions.SessionInactivityTimeout), nameof(SessionManagerOptions.SessionInactivityTimeout)),
            options?.SessionInactivityTimeout ?? TimeSpan.FromSeconds(30));
        _clock = options?.Clock ?? TimeProvider.System;
        _fill = options?.Fill ?? RandomNumberGenerator.Fill;
        _dataComparer = options?.DataComparer;
    }

    /// <summary>What its timers run on, and its sessions' activity is read from.</summary>
    public TimeProvider Clock
    {
        get
        {
            return _clock;
        }
    }

    /// <summary>A session stored for a connection that had none.</summary>
    public event Action<Session<TData>>? Created;

    /// <summary>A session stored anew, different from the one it replaced.</summary>
    public event Action<Session<TData>>? Updated;

    /// <summary>A session forgotten.</summary>
    public event Action<Session<TData>>? Deleted;

    /// <summary>A session's data changed: the session, the new data, and the old.</summary>
    public event Action<Session<TData>, TData?, TData?>? DataChanged;

    /// <summary>A session's connection timeout changed: the session, the new timeout, and the old.</summary>
    public event Action<Session<TData>, TimeSpan, TimeSpan>? ConnectionInactivityTimeoutChanged;

    /// <summary>A session's activity moved to a later millisecond: the session, the new instant, and the old.</summary>
    public event Action<Session<TData>, DateTimeOffset, DateTimeOffset>? LastActivityChanged;

    /// <summary>A session's session timeout changed: the session, the new timeout, and the old.</summary>
    public event Action<Session<TData>, TimeSpan, TimeSpan>? SessionInactivityTimeoutChanged;

    /// <summary>A session's connection went silent past its connection timeout.</summary>
    public event Action<Session<TData>>? ConnectionInactivityTimeoutReached;

    /// <summary>A session went unused past its session timeout.</summary>
    public event Action<Session<TData>>? SessionInactivityTimeoutReached;

    /// <summary>The connections that hold a session.</summary>
    public IReadOnlyList<string> ConnectionHandles()
    {
        lock (_gate)
        {
            return [.. _tokens.Keys];
        }
    }

    /// <summary>
    /// A new session for a connection, not stored: its timeouts infinite, no data, and no token
    /// until <c>Set</c>.
    /// </summary>
    public Session<TData> Create(string connectionHandle)
    {
        return new Session<TData>
        {
            ConnectionHandle = connectionHandle,
            ConnectionInactivityTimeout = Timeout.InfiniteTimeSpan,
            LastActivity = _clock.GetUtcNow(),
            SessionInactivityTimeout = Timeout.InfiniteTimeSpan,
        };
    }

    /// <summary>Forgets a session and stops its timers; false when there was none.</summary>
    public bool Delete(string connectionHandle)
    {
        Session<TData>? deleted;

        lock (_gate)
        {
            deleted = StoredOf(connectionHandle);

            if (deleted is null)
            {
                return false;
            }

            _tokens.Remove(connectionHandle);
            _sessions.Remove(deleted.SessionToken!.Value);
            StopTimers(connectionHandle);
            _timers.Remove(connectionHandle);
        }

        Deleted?.Invoke(deleted);

        return true;
    }

    /// <summary>The session of a connection; none when it has none.</summary>
    public Session<TData>? Get(string connectionHandle)
    {
        lock (_gate)
        {
            return StoredOf(connectionHandle);
        }
    }

    /// <summary>Every session.</summary>
    public IReadOnlyList<Session<TData>> GetAll()
    {
        lock (_gate)
        {
            return [.. _sessions.Values];
        }
    }

    /// <summary>The session of a connection, stored first when it has none.</summary>
    public Session<TData> GetOrElseSet(string connectionHandle)
    {
        return Get(connectionHandle) ?? Set(Create(connectionHandle));
    }

    /// <summary>
    /// What it holds: its sessions, and the connections that keep a timer. Its timers are its own,
    /// where the TypeScript side's are public, so none can outlive its session: no anomaly to tell.
    /// </summary>
    public Gauges Gauges()
    {
        lock (_gate)
        {
            return Bead.Gauges.Merge(
            [
                Bead.Gauges.Of(new Dictionary<string, long> { ["sessions"] = _sessions.Count }, _tokens.Keys),
                Bead.Gauges.Of(new Dictionary<string, long> { ["timedConnections"] = _timers.Count }, _timers.Keys),
            ]);
        }
    }

    /// <summary>Whether a connection holds a session.</summary>
    public bool Has(string connectionHandle)
    {
        lock (_gate)
        {
            return _tokens.ContainsKey(connectionHandle);
        }
    }

    /// <summary>The token of a connection's session, which the router announces; none for none.</summary>
    public SessionToken? SessionTokenOf(string connectionHandle)
    {
        lock (_gate)
        {
            return _tokens.TryGetValue(connectionHandle, out var token) ? token : null;
        }
    }

    /// <summary>
    /// Stores a session, and gives it as stored. One without a token draws one — a new session, its
    /// timers started over, even over a session the connection held; one with a token keeps it,
    /// which must be no other connection's. A timeout is stored rounded to the nearest whole
    /// millisecond, and none takes the default; one neither infinite nor from 1 to
    /// <see cref="Clocks.LongestTimer"/>, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/>. Once disposed, a
    /// <see cref="DisconnectException"/>: a resolver that finishes once its server is gone has
    /// nowhere left to store a session.
    /// </summary>
    public Session<TData> Set(Session<TData> session)
    {
        ArgumentNullException.ThrowIfNull(session);

        Session<TData> next;
        Action? raise = null;

        lock (_gate)
        {
            if (_isDisposed)
            {
                throw new DisconnectException("the sessions were disposed");
            }

            var connectionHandle = session.ConnectionHandle;
            var stored = StoredOf(connectionHandle);
            var isNew = session.SessionToken is null;

            // everything that can throw runs before anything is stored
            if (session.SessionToken is { } given)
            {
                if (given.IsDefault)
                {
                    throw new ArgumentException("a session token is 16 bytes, not all zero", nameof(session));
                }

                if (_sessions.TryGetValue(given, out var holder) && holder.ConnectionHandle != connectionHandle)
                {
                    throw new ArgumentException("this session token belongs to another connection", nameof(session));
                }
            }

            var connectionTimeout = Resolve((session.ConnectionInactivityTimeout, _connectionTimeoutDefault), nameof(Session<TData>.ConnectionInactivityTimeout));
            var sessionTimeout = Resolve((session.SessionInactivityTimeout, _sessionTimeoutDefault), nameof(Session<TData>.SessionInactivityTimeout));

            next = session with
            {
                ConnectionInactivityTimeout = connectionTimeout,
                SessionInactivityTimeout = sessionTimeout,
                SessionToken = session.SessionToken ?? Draw(),
            };

            if (stored?.SessionToken is { } replaced)
            {
                _sessions.Remove(replaced);
            }

            _sessions[next.SessionToken!.Value] = next;
            _tokens[connectionHandle] = next.SessionToken.Value;

            // the timers follow what is stored: a new session starts over, a timeout that changed
            // restarts its own
            if (isNew)
            {
                StopTimers(connectionHandle);
            }

            if (isNew || stored?.ConnectionInactivityTimeout != connectionTimeout)
            {
                ArmConnectionTimer(connectionHandle, connectionTimeout);
            }

            if (isNew || stored?.SessionInactivityTimeout != sessionTimeout)
            {
                ArmSessionTimer(connectionHandle, sessionTimeout);
            }

            var created = next;

            if (stored is null)
            {
                raise = () =>
                {
                    Created?.Invoke(created);
                };
            }
            else if (!IsAlike(stored, next))
            {
                raise = () =>
                {
                    Updated?.Invoke(created);
                };
            }
        }

        raise?.Invoke();

        return next;
    }

    /// <summary>
    /// As <see cref="UpdateLastActivity"/>, by connection, for every message; whether it holds a
    /// session.
    /// </summary>
    public bool Touch(string connectionHandle)
    {
        return Stamp(connectionHandle) is not null;
    }

    /// <summary>Stores a session's data; raises <see cref="DataChanged"/> when it is not equal to the last.</summary>
    public Session<TData>? UpdateData(Session<TData> session)
    {
        ArgumentNullException.ThrowIfNull(session);

        Session<TData> updated;
        TData? old;

        lock (_gate)
        {
            if (StoredOf(session.ConnectionHandle) is not { } stored)
            {
                return null;
            }

            old = stored.Data;
            updated = stored with { Data = session.Data };
            _sessions[updated.SessionToken!.Value] = updated;

            if (IsAlike(old, updated.Data))
            {
                return updated;
            }
        }

        DataChanged?.Invoke(updated, updated.Data, old);

        return updated;
    }

    /// <summary>
    /// Stores a session's connection timeout, rounded to the nearest whole millisecond — the default
    /// for none — restarting its timer and raising <see cref="ConnectionInactivityTimeoutChanged"/>
    /// when it changed; the same timeout restarts nothing, since activity is what does. One neither
    /// infinite nor from 1 to <see cref="Clocks.LongestTimer"/>, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public Session<TData>? UpdateConnectionInactivityTimeout(Session<TData> session)
    {
        ArgumentNullException.ThrowIfNull(session);

        Session<TData> updated;
        TimeSpan held;
        TimeSpan old;

        lock (_gate)
        {
            if (StoredOf(session.ConnectionHandle) is not { } stored)
            {
                return null;
            }

            held = Resolve((session.ConnectionInactivityTimeout, _connectionTimeoutDefault), nameof(Session<TData>.ConnectionInactivityTimeout));
            old = stored.ConnectionInactivityTimeout!.Value;
            updated = stored with { ConnectionInactivityTimeout = held };
            _sessions[updated.SessionToken!.Value] = updated;

            if (held == old)
            {
                return updated;
            }

            ArmConnectionTimer(session.ConnectionHandle, held);
        }

        ConnectionInactivityTimeoutChanged?.Invoke(updated, held, old);

        return updated;
    }

    /// <summary>
    /// Stamps a session's activity now, on its clock, and starts both its timers anew; raises
    /// <see cref="LastActivityChanged"/> when its last activity moved to a later millisecond.
    /// </summary>
    public Session<TData>? UpdateLastActivity(Session<TData> session)
    {
        ArgumentNullException.ThrowIfNull(session);

        return Stamp(session.ConnectionHandle);
    }

    /// <summary>As <see cref="UpdateConnectionInactivityTimeout"/>, for the session timeout.</summary>
    public Session<TData>? UpdateSessionInactivityTimeout(Session<TData> session)
    {
        ArgumentNullException.ThrowIfNull(session);

        Session<TData> updated;
        TimeSpan held;
        TimeSpan old;

        lock (_gate)
        {
            if (StoredOf(session.ConnectionHandle) is not { } stored)
            {
                return null;
            }

            held = Resolve((session.SessionInactivityTimeout, _sessionTimeoutDefault), nameof(Session<TData>.SessionInactivityTimeout));
            old = stored.SessionInactivityTimeout!.Value;
            updated = stored with { SessionInactivityTimeout = held };
            _sessions[updated.SessionToken!.Value] = updated;

            if (held == old)
            {
                return updated;
            }

            ArmSessionTimer(session.ConnectionHandle, held);
        }

        SessionInactivityTimeoutChanged?.Invoke(updated, held, old);

        return updated;
    }

    /// <summary>Stops every timer and forgets every session; a session set after is a <see cref="DisconnectException"/>.</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            _isDisposed = true;

            foreach (var connectionHandle in _timers.Keys.ToList())
            {
                StopTimers(connectionHandle);
            }

            _timers.Clear();
            _sessions.Clear();
            _tokens.Clear();
        }
    }

    // whether two data are alike, by the comparer given or by their own Equals
    private bool IsAlike(TData? data, TData? other)
    {
        return _dataComparer?.Equals(data, other) ?? EqualityComparer<TData?>.Default.Equals(data, other);
    }

    // whether two sessions are alike: their data by IsAlike, all else by its value
    private bool IsAlike(Session<TData> session, Session<TData> other)
    {
        return session with { Data = default } == other with { Data = default } && IsAlike(session.Data, other.Data);
    }

    // an inactivity timeout as stored, under the session's option it names: held, or the default for
    // none
    private static TimeSpan Resolve((TimeSpan? Given, TimeSpan Fallback) timeout, string option)
    {
        return timeout.Given is { } given ? Clocks.AssertHeld(("an inactivity timeout", option), given) : timeout.Fallback;
    }

    // 16 bytes from its fill — a cryptographic source unless a test gives its own — drawn again when
    // all zero or held by another session
    private SessionToken Draw()
    {
        Span<byte> bytes = stackalloc byte[SessionToken.Bytes];

        while (true)
        {
            _fill(bytes);

            if (bytes.ContainsAnyExcept((byte)0) && !_sessions.ContainsKey(SessionToken.FromBytes(bytes)))
            {
                return SessionToken.FromBytes(bytes);
            }
        }
    }

    private Session<TData>? StoredOf(string connectionHandle)
    {
        return _tokens.TryGetValue(connectionHandle, out var token) ? _sessions[token] : null;
    }

    // activity now: both timers start anew, even within the same millisecond, and the change is
    // said once a millisecond, as activity comes with every message
    private Session<TData>? Stamp(string connectionHandle)
    {
        Session<TData> stamped;
        DateTimeOffset old;

        lock (_gate)
        {
            if (StoredOf(connectionHandle) is not { } stored)
            {
                return null;
            }

            old = stored.LastActivity;
            stamped = stored with { LastActivity = _clock.GetUtcNow() };
            _sessions[stamped.SessionToken!.Value] = stamped;
            ArmConnectionTimer(connectionHandle, stamped.ConnectionInactivityTimeout!.Value);
            ArmSessionTimer(connectionHandle, stamped.SessionInactivityTimeout!.Value);

            if (stamped.LastActivity.ToUnixTimeMilliseconds() == old.ToUnixTimeMilliseconds())
            {
                return stamped;
            }
        }

        LastActivityChanged?.Invoke(stamped, stamped.LastActivity, old);

        return stamped;
    }

    private void StopTimers(string connectionHandle)
    {
        if (_timers.TryGetValue(connectionHandle, out var timers))
        {
            timers.Connection?.Dispose();
            timers.Session?.Dispose();
            _timers[connectionHandle] = (null, null);
        }
    }

    private void ArmConnectionTimer(string connectionHandle, TimeSpan timeout)
    {
        var (connection, session) = _timers.GetValueOrDefault(connectionHandle);

        connection?.Dispose();
        _timers[connectionHandle] = (ArmOf(connectionHandle, (timeout, true)), session);
    }

    private void ArmSessionTimer(string connectionHandle, TimeSpan timeout)
    {
        var (connection, session) = _timers.GetValueOrDefault(connectionHandle);

        session?.Dispose();
        _timers[connectionHandle] = (connection, ArmOf(connectionHandle, (timeout, false)));
    }

    // a timer that fires the session as it is then, not as it was when the timer was set
    private ITimer? ArmOf(string connectionHandle, (TimeSpan Timeout, bool IsConnection) timer)
    {
        if (!_tokens.ContainsKey(connectionHandle) || timer.Timeout == Timeout.InfiniteTimeSpan)
        {
            return null;
        }

        return _clock.CreateTimer(
            (_) =>
            {
                Session<TData>? reached;

                lock (_gate)
                {
                    reached = StoredOf(connectionHandle);
                }

                if (reached is null)
                {
                    return;
                }

                if (timer.IsConnection)
                {
                    ConnectionInactivityTimeoutReached?.Invoke(reached);
                }
                else
                {
                    SessionInactivityTimeoutReached?.Invoke(reached);
                }
            },
            null,
            timer.Timeout,
            Timeout.InfiniteTimeSpan);
    }
}
