using System.Globalization;
using System.Net.WebSockets;

namespace Bead.Transport.WebSockets;

/// <summary>How a WebSocket transport client holds its connection.</summary>
public sealed record WebSocketTransportClientOptions
{
    /// <summary>
    /// The largest message it reads, in bytes: one larger closes its connection with 1009. A
    /// router's envelope limit at least; an envelope's limit by default, as the TypeScript side's
    /// <c>maxPayload</c> is ws's own when not given.
    /// </summary>
    public int? MaximumMessageBytes { get; init; }

    /// <summary>
    /// How often the connection is pinged, and how long its pong may take: a server gone without a
    /// word ends in a close rather than never. From 1 to 2³¹ − 1 milliseconds, rounded to the
    /// nearest whole one, or <see cref="Timeout.InfiniteTimeSpan"/> for none; the transport refuses
    /// any other, zero among them, with an <see cref="ArgumentOutOfRangeException"/> as it is built.
    /// The platform's, on the real clock.
    /// </summary>
    public TimeSpan Heartbeat { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How long a close handshake may take: a server that never answers is dropped after it. From 1
    /// to 2³¹ − 1 milliseconds, rounded to the nearest whole one, or
    /// <see cref="Timeout.InfiniteTimeSpan"/> to wait without end; the transport refuses any other,
    /// zero among them, with an <see cref="ArgumentOutOfRangeException"/> as it is built. It bounds
    /// the platform's close, on the real clock.
    /// </summary>
    public TimeSpan CloseTimeout { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// What the stack built on it runs on, a connect's timeout and a reconnection's waits among
    /// them; the system's clock when none.
    /// </summary>
    public TimeProvider? Clock { get; init; }
}

/// <summary>
/// Where a client connects — <c>ws://host:port/pathname</c>, or <c>wss://</c> when secured — what
/// it offers there, and how long it waits.
/// </summary>
public sealed record WebSocketConnectOptions
{
    /// <summary>The server's host.</summary>
    public required string Host { get; init; }

    /// <summary>The server's port.</summary>
    public required int Port { get; init; }

    /// <summary>Whether the connection is over TLS.</summary>
    public bool Secured { get; init; }

    /// <summary>The path the server listens on, prefixed with a single leading slash.</summary>
    public string Pathname { get; init; } = "/";

    /// <summary>The subprotocols offered in the handshake; none when not given.</summary>
    public IReadOnlyList<string>? Protocols { get; init; }

    /// <summary>
    /// How long the connect may take before it throws a <see cref="TimeoutException"/>: 30 seconds
    /// unless told, from 1 to <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest
    /// whole one, or <see cref="System.Threading.Timeout.InfiniteTimeSpan"/>, which never times out;
    /// zero is refused.
    /// </summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(30);
}

/// <summary>
/// A transport client over one WebSocket connection: one envelope per binary message, what goes out
/// in order, one message at a time, and the connection pinged every
/// <see cref="WebSocketTransportClientOptions.Heartbeat"/>. It goes from
/// <see cref="ReadyState.Uninitialized"/> through Connecting and Open to Closing and Closed, and
/// connects again once Closed — or reconnects, with the options of its last connect.
/// </summary>
public sealed class WebSocketTransportClient : IRouterClientTransport, IAsyncDisposable
{
    // constants

    private readonly WebSocketTransportClientOptions _options;
    private readonly TimeProvider _clock;
    // what every move from one state to another decides by
    private readonly Lock _gate = new();
    private volatile ReadyState _readyState = ReadyState.Uninitialized;
    // the options of the last connect its guard let through, which a reconnection connects with
    private WebSocketConnectOptions? _lastConnectOptions;
    // the socket of a connect under way, taken before anything is awaited: a dispose aborts it
    private ClientWebSocket? _connecting;
    // the open connection; a connection this side dropped is none, and its end tells nothing
    private volatile WebSocketConnection? _connection;
    // the close handshake under way on the open connection, told whether a dispose dropped it
    private (WebSocketConnection Connection, TaskCompletionSource<bool> Closed)? _disconnecting;
    private Action? _reconnect;

    /// <summary>
    /// A transport client, not yet connected, its heartbeat and close timeout held: one no timer
    /// holds is an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public WebSocketTransportClient(WebSocketTransportClientOptions? options = null)
    {
        var given = options ?? new WebSocketTransportClientOptions();

        _options = given with
        {
            Heartbeat = WebSocketConnection.AssertHeartbeat(given.Heartbeat, nameof(WebSocketTransportClientOptions.Heartbeat)),
            CloseTimeout = WebSocketConnection.AssertCloseTimeout(given.CloseTimeout, nameof(WebSocketTransportClientOptions.CloseTimeout)),
        };
        _clock = _options.Clock ?? TimeProvider.System;
    }

    /// <inheritdoc/>
    public event Action<TransportMessage>? Message;

    /// <summary>
    /// The connection closed: clean when this side's close was told so, as the TypeScript side's
    /// <c>disconnect</c> says it was told, never when the server or the network closed it; quick
    /// when this side dropped it without a handshake. A connection a dispose drops, or a
    /// reconnection replaces, tells none.
    /// </summary>
    public event Action<bool, bool>? Close;

    /// <summary>What broke the connection, before its close.</summary>
    public event Action<Exception>? Error;

    /// <summary>
    /// A reconnection starts: what was sent on the connection it replaces will not be answered
    /// there, and an open one it replaces tells no close, so this is the one sign of it. Reached
    /// through <see cref="IRouterClientTransport"/>: <see cref="Reconnect"/> names the method here.
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

    /// <summary>
    /// Each connect that opened, as it opens: the tests' way to act right after one, as the
    /// TypeScript side's tests replace <c>connect</c>.
    /// </summary>
    internal event Action? Opened;

    /// <summary>Where it is in its life: Uninitialized until its first connect.</summary>
    public ReadyState ReadyState
    {
        get
        {
            return _readyState;
        }
    }

    /// <summary>What the stack built on it runs on: the clock its options gave, the system's when none.</summary>
    public TimeProvider Clock
    {
        get
        {
            return _clock;
        }
    }

    /// <summary>
    /// Connects to the server; settles once the connection is open. Refused with an
    /// <see cref="ArgumentOutOfRangeException"/> for a timeout
    /// <see cref="WebSocketConnectOptions.Timeout"/> does not take, zero among them, which leaves the state, and the target a
    /// reconnection replays, as they were; with an <see cref="InvalidOperationException"/> unless
    /// Uninitialized or Closed; and with an <see cref="OperationCanceledException"/>, nothing
    /// changed, when its token is cancelled already. Then it throws a <see cref="TimeoutException"/> past its timeout, an
    /// <see cref="OperationCanceledException"/> once its token is cancelled, and the
    /// <see cref="WebSocketException"/> its socket throws, a dispose under way included, ending
    /// Closed.
    /// </summary>
    public Task Connect(WebSocketConnectOptions options, CancellationToken cancellationToken = default)
    {
        return Connecting(options, (cancellationToken, false));
    }

    /// <summary>
    /// A WebSocket carries no credential beside an envelope (spec 15.2): a call presenting
    /// <see cref="CredentialScheme.Elsewhere"/> over it fails before it goes.
    /// </summary>
    public bool CarriesCredential
    {
        get
        {
            return false;
        }
    }

    /// <summary>
    /// Whether it is secure, judged from the options of its last connect, never from what its host
    /// resolves to (spec 13.4): <c>wss</c>, or a host on the loopback. None before its first connect.
    /// </summary>
    public bool IsSecure
    {
        get
        {
            lock (_gate)
            {
                return _lastConnectOptions is { } given && TransportSecurity.IsSecure((given.Secured, given.Host));
            }
        }
    }

    /// <summary>
    /// Hands the bytes of <paramref name="message"/> to the connection, as binary; refused with a
    /// <see cref="DisconnectException"/> unless Open, as the TypeScript side's ReadyStateError. A
    /// WebSocket carries no credential: one given is not carried, as its router fails a call
    /// presenting one before it goes.
    /// </summary>
    public Task Send(TransportMessage message)
    {
        WebSocketConnection? connection;
        ReadyState readyState;

        lock (_gate)
        {
            connection = _connection;
            readyState = _readyState;
        }

        return readyState == ReadyState.Open && connection is not null
            ? connection.Send(message.Bytes)
            : Task.FromException(new DisconnectException($"the transport client is {NameOf(readyState)}, not open"));
    }

    /// <summary>
    /// Closes the connection and raises its close, which says it was clean as
    /// <see cref="TransportDisconnectOptions.IsClean"/> does: with 1000, settling once the server
    /// answered or its close timeout passed; or, <see cref="TransportDisconnectOptions.IsQuick"/>,
    /// at once, the socket dropped, its close going out going away, 1001, unwaited. Refused with a
    /// <see cref="DisconnectException"/> unless Open, as the TypeScript side's ReadyStateError. A
    /// dispose meanwhile drops the socket, and no close is raised. It ends Closed.
    /// </summary>
    public async Task CloseConnection(TransportDisconnectOptions? options = null)
    {
        var isClean = options?.IsClean ?? true;
        var isQuick = options?.IsQuick ?? false;
        var closed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        WebSocketConnection connection;

        lock (_gate)
        {
            if (_readyState != ReadyState.Open || _connection is null)
            {
                throw new DisconnectException($"the transport client is {NameOf(_readyState)}, not open");
            }

            _readyState = ReadyState.Closing;
            connection = _connection;

            // a connection dropped tells nothing of its end: this close tells it
            if (isQuick)
            {
                _connection = null;
            }
            else
            {
                _disconnecting = (connection, closed);
            }
        }

        var isDropped = false;

        if (isQuick)
        {
            Release(connection);
        }
        else
        {
            // its end settles it, which the close timeout bounds, unless a dispose settles it first
            _ = connection.Close(WebSocketCloseStatus.NormalClosure);
            isDropped = await closed.Task;
        }

        lock (_gate)
        {
            _readyState = ReadyState.Closed;
        }

        // a dispose dropped the socket meanwhile, without a handshake: it tells no close, as a
        // dispose never does
        if (!isDropped)
        {
            Close?.Invoke(isClean, isQuick);
        }
    }

    /// <summary>
    /// Connects again with the options of the last connect its guard let through, replacing an open
    /// connection without a close, and raises <see cref="IRouterClientTransport.Reconnect"/> as it
    /// starts. The first attempt goes at once, each next one after its
    /// <see cref="TransportReconnectOptions.Delay"/>. Attempts that run out end Closed without a
    /// close, with a <see cref="ReconnectException"/>; a cancel stops them with an
    /// <see cref="OperationCanceledException"/>, ending Closed, and one after a success disconnects,
    /// which raises a close. A reconnection under way, never connected, connecting or closing is an
    /// <see cref="InvalidOperationException"/>, and so is a delay that throws, ending Closed; a misuse
    /// or a token cancelled already leaves the state as it was. What its tap throws passes through.
    /// </summary>
    public async Task Reconnect(TransportReconnectOptions? options = null)
    {
        var reconnect = options ?? new TransportReconnectOptions();
        var token = reconnect.CancellationToken;
        WebSocketConnectOptions target;
        WebSocketConnection? replaced;
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

            // before the drop below, so a token cancelled already leaves an open connection alone
            if (token.IsCancellationRequested)
            {
                throw new OperationCanceledException(TransportReconnection.Cancelled, token);
            }

            // taken out as the state turns to reconnecting, so its end, however soon, tells nothing
            target = _lastConnectOptions;
            replaced = _connection;
            _connection = null;
            _readyState = ReadyState.Reconnecting;
            starting = _reconnect;
        }

        try
        {
            // the connection replaced goes whatever a listener does
            try
            {
                starting?.Invoke();
            }
            finally
            {
                if (replaced is not null)
                {
                    Release(replaced);
                }
            }

            await TransportReconnection.Attempting(
                (token) =>
                {
                    return Connecting(target, (token, true));
                },
                (reconnect, _clock));

            // the last attempt opened as the token was cancelled: what it opened goes with it
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
    /// drops the socket — a connect under way fails, a close under way settles without its close.
    /// A reconnection under way is not stopped by it, only the attempt it is making: cancel its
    /// token.
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
                // closed or replaced meanwhile: what is left is dropped below
            }
        }

        Drop();
    }

    // ws://host:port/pathname, or wss://; an IPv6 literal bracketed, or its colons would read as the
    // port's
    private static Uri UriOf(WebSocketConnectOptions options)
    {
        var host = options.Host.Contains(':') && !options.Host.StartsWith('[') ? $"[{options.Host}]" : options.Host;
        var path = options.Pathname.StartsWith('/') ? options.Pathname : $"/{options.Pathname}";

        return new Uri($"{(options.Secured ? "wss" : "ws")}://{host}:{options.Port}{path}");
    }

    // a state as a message words it: "open", "closing"…
    private static string NameOf(ReadyState readyState)
    {
        return readyState.ToString().ToLowerInvariant();
    }

    // closes a connection this side let go of, without waiting on it: its close goes out going
    // away, 1001, where a browser's close() sends none, which this socket cannot; the server says it
    // was not clean either way, and the close timeout drops one that never answers
    private static void Release(WebSocketConnection connection)
    {
        _ = connection.Close(WebSocketCloseStatus.EndpointUnavailable);
    }

    // a connect, or a reconnection's attempt, which its guard alone tells apart: an attempt passes
    // only while the client reconnects, and leaves the state to its reconnection when it fails
    private async Task Connecting(WebSocketConnectOptions given, (CancellationToken Token, bool IsAttempt) call)
    {
        ArgumentNullException.ThrowIfNull(given);

        // held before anything moves or is kept, so a reconnection connects again with it held
        var options = given with
        {
            Timeout = Clocks.AssertHeld(("a connect's timeout", nameof(WebSocketConnectOptions.Timeout)), given.Timeout),
        };
        var (token, isAttempt) = call;
        ClientWebSocket socket;

        lock (_gate)
        {
            if (isAttempt ? _readyState != ReadyState.Reconnecting : _readyState is not (ReadyState.Uninitialized or ReadyState.Closed))
            {
                throw new InvalidOperationException($"the transport client is already {NameOf(_readyState)}");
            }

            _lastConnectOptions = options;

            // honoured before anything moves, so one cancelled already leaves the state as it was
            token.ThrowIfCancellationRequested();

            if (!isAttempt)
            {
                _readyState = ReadyState.Connecting;
            }

            socket = _connecting = new ClientWebSocket();
        }

        WebSocketConnection connection;

        try
        {
            socket.Options.KeepAliveInterval = _options.Heartbeat;
            socket.Options.KeepAliveTimeout = _options.Heartbeat;

            foreach (var protocol in options.Protocols ?? [])
            {
                socket.Options.AddSubProtocol(protocol);
            }

            using var timeout = options.Timeout > TimeSpan.Zero ? new CancellationTokenSource(options.Timeout, _clock) : null;
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, timeout?.Token ?? CancellationToken.None);

            try
            {
                await socket.ConnectAsync(UriOf(options), linked.Token);
            }
            catch (OperationCanceledException reason) when (timeout is { IsCancellationRequested: true } && !token.IsCancellationRequested)
            {
                throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"timed out after {options.Timeout.TotalMilliseconds}ms"), reason);
            }

            lock (_gate)
            {
                // a dispose as it opened took its socket: there is nothing to keep
                if (_connecting != socket)
                {
                    throw new WebSocketException(WebSocketError.InvalidState, "the transport client was disposed as it connected");
                }

                _connecting = null;
                _connection = connection = new WebSocketConnection(socket, (_options.MaximumMessageBytes ?? LimitDefaults.MaximumEnvelopeBytes, _options.CloseTimeout));
                _readyState = ReadyState.Open;
            }
        }
        catch
        {
            socket.Dispose();

            lock (_gate)
            {
                if (_connecting == socket)
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

        _ = Follow(connection);
        Opened?.Invoke();
    }

    // drops the socket without waiting on a handshake, and tells nothing of it: a connect under way
    // fails, a close under way settles; an open client ends Closed
    private void Drop()
    {
        ClientWebSocket? connecting;
        WebSocketConnection? connection;
        TaskCompletionSource<bool>? disconnecting;

        lock (_gate)
        {
            connecting = _connecting;
            connection = _connection;
            disconnecting = _disconnecting?.Closed;
            _connecting = null;
            _connection = null;
            _disconnecting = null;

            if (_readyState == ReadyState.Open)
            {
                _readyState = ReadyState.Closed;
            }
        }

        // an abort, not a dispose: only an abort ends the handshake under way
        connecting?.Abort();
        disconnecting?.TrySetResult(true);

        if (connection is not null)
        {
            Release(connection);
        }
    }

    // reads the connection until it ends, then tells its end: to the close under way, which tells
    // it, or as a close of the server's or the network's; a connection dropped tells nothing
    private async Task Follow(WebSocketConnection connection)
    {
        Exception? broken = null;

        try
        {
            await connection.Read((message) =>
            {
                // nothing more is heard once a close began, nor from a connection dropped
                if (_connection == connection && _readyState != ReadyState.Closing)
                {
                    Message?.Invoke(message);
                }
            });
        }
        catch (Exception reason) when (reason is WebSocketException or OperationCanceledException or IOException)
        {
            broken = reason;
        }

        connection.Socket.Dispose();

        TaskCompletionSource<bool>? disconnecting = null;

        lock (_gate)
        {
            if (_connection != connection)
            {
                return;
            }

            _connection = null;

            if (_disconnecting is { } closing && closing.Connection == connection)
            {
                disconnecting = closing.Closed;
                _disconnecting = null;
            }
            else
            {
                _readyState = ReadyState.Closed;
            }
        }

        if (disconnecting is not null)
        {
            disconnecting.TrySetResult(false);

            return;
        }

        if (broken is not null)
        {
            Error?.Invoke(broken);
        }

        Close?.Invoke(false, false);
    }
}
