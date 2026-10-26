using System.Globalization;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;

namespace Bead.Transport.WebSockets;

/// <summary>How a WebSocket transport client holds its connection.</summary>
public sealed record WebSocketTransportClientOptions
{
    /// <summary>
    /// The largest message it reads, in bytes: one larger closes its connection with 1009. A
    /// router's envelope limit at least; an envelope's limit by default, as the TypeScript side's
    /// <c>maxPayload</c> is.
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

    /// <summary>
    /// What sends its opening handshakes, one of its own when none, which races the address families
    /// of a name (RFC 8305): the tests' way to open a socket from an address and a port of their own,
    /// as the TypeScript side's tests give their <c>WebSocket</c>.
    /// </summary>
    internal HttpMessageInvoker? Invoker { get; init; }
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

    /// <summary>
    /// The credential its upgrade carries, written as given in its <c>Authorization</c> (spec 15.2),
    /// which its server hands beside every envelope of the connection, a call presenting
    /// <see cref="CredentialScheme.Elsewhere"/> standing for it; none when not given, and an empty one
    /// is none. Visible ASCII, spaces and tabs, none first or last (RFC 9110 §5.5), over <c>wss</c>
    /// or to a host on the loopback (spec 13.4): any other, or one given beside
    /// <see cref="CredentialProvider"/>, is an <see cref="ArgumentException"/> as the connect is
    /// asked, nothing changed. A reconnection writes it again: a credential that renews is given by
    /// <see cref="CredentialProvider"/>.
    /// </summary>
    public string? Credential { get; init; }

    /// <summary>
    /// What hands the credential its upgrade carries, as <see cref="Credential"/> is written, called
    /// at each attempt — the connect's, and each of a reconnection's — before its upgrade goes, with
    /// the attempt's token, as SignalR's <c>AccessTokenProvider</c> is: a renewed credential reaches
    /// the next connection. What it throws fails that attempt, its cause; a value that is no field
    /// value fails it with an <see cref="ArgumentException"/>, which a reconnection does not try
    /// again. Held to the rules of <see cref="Credential"/> as the connect is asked.
    /// One call is pending per client; another attempt joins its outcome within its own bound.
    /// Cancellation, timeout and disposal end the wait; provider callbacks run outside that ending.
    /// The provider's own cancellation is its failure while the attempt's token stays live.
    /// </summary>
    public Func<CancellationToken, ValueTask<string>>? CredentialProvider { get; init; }
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

    // what sends every client's opening handshake: the platform's handler for a socket with no
    // proxy, cookie, credential or certificate of its own, as a ClientWebSocket builds it, but for
    // its connect, which races the address families of a name, as RFC 8305 asks, where the
    // platform's tries each address in turn and waits out a family's refusal, two seconds on Windows.
    // ! It follows no redirect (spec 15.6): a 3xx answered to the upgrade fails the connect, its
    // status named, as a page's WebSocket fails; followed, it would carry the upgrade where its
    // credential and its security were never judged
    private static readonly HttpMessageInvoker Racing = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectCallback = HappyEyeballs.ConnectCallback,
        PooledConnectionLifetime = TimeSpan.Zero,
        UseCookies = false,
    });

    private readonly WebSocketTransportClientOptions _options;
    private readonly TimeProvider _clock;
    // what every move from one state to another decides by
    private readonly Lock _gate = new();
    private volatile ReadyState _readyState = ReadyState.Uninitialized;
    // the options of the last connect its guard let through, which a reconnection connects with
    private WebSocketConnectOptions? _lastConnectOptions;
    // the socket of a connect under way, taken before anything is awaited: a dispose aborts it
    private ClientWebSocket? _connecting;
    // what ends a connect when its client is disposed
    private CancellationTokenSource? _connectDisposed;
    // the provider's one pending call, which another attempt joins within its own bound
    private Task<string>? _credentialPending;
    // the open connection; a connection this side dropped is none, and its end tells nothing
    private volatile WebSocketConnection? _connection;
    // the credential the upgrade of a connection carried, which it carries alone; none for one whose
    // upgrade carried none
    private (WebSocketConnection Connection, string Credential)? _carried;
    // the close handshake under way on the open connection, told whether a dispose dropped it
    private (WebSocketConnection Connection, TaskCompletionSource<bool> Closed)? _disconnecting;
    private Action? _reconnect;
    // how its events are told: what a listener throws is reported through Error
    private readonly ListenerGuard _listeners;

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
        _listeners = new ListenerGuard((reason, _) =>
        {
            Error?.Invoke(reason);
        });
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

    /// <summary>
    /// What this side failed its open connection for of its own, once, as it ends, before its
    /// unclean close (spec 15.1): a protocol error, the <see cref="WebSocketException"/> its socket
    /// threw, or a message past <see cref="WebSocketTransportClientOptions.MaximumMessageBytes"/>, an
    /// <see cref="InvalidDataException"/>, "the connection is closed with 1009: a message past its
    /// maximumMessageBytes, N bytes"; a listener that throws keeps the close told. A server gone
    /// without its closing handshake, the heartbeat's drop and this side's own abort past its close
    /// timeout tell their close alone. And what a listener of its messages, its close or its
    /// reconnection threw, the client going on as if it returned.
    /// </summary>
    public event Action<Exception>? Error;

    /// <summary>
    /// A reconnection starts: what was sent on the connection it replaces will not be answered
    /// there, and an open one it replaces tells no close, so this is the one sign of it. Each
    /// listener is told within its guard, its throw reported through <see cref="Error"/>, and the
    /// reconnection goes on. Reached through <see cref="IRouterClientTransport"/>:
    /// <see cref="Reconnect"/> names the method here.
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

    /// <summary>
    /// The largest message its connections read: the option given, or a router's largest envelope
    /// by default, which a transport built alone takes, its router unknown to it.
    /// </summary>
    internal int MaximumMessageBytes
    {
        get
        {
            return _options.MaximumMessageBytes ?? LimitDefaults.MaximumEnvelopeBytes;
        }
    }

    /// <summary>
    /// The close timeout its connections are built with: the option given, rounded to the nearest
    /// whole millisecond, or <see cref="Timeout.InfiniteTimeSpan"/> to wait on the server without end.
    /// </summary>
    internal TimeSpan CloseTimeout
    {
        get
        {
            return _options.CloseTimeout;
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
    /// <see cref="WebSocketConnectOptions.Timeout"/> does not take, zero among them, and with an
    /// <see cref="ArgumentException"/> for a credential <see cref="WebSocketConnectOptions.Credential"/>
    /// does not take, each of which leaves the state, and the target a reconnection replays, as they
    /// were; with an <see cref="InvalidOperationException"/> unless
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
    /// Whether it carries <paramref name="credential"/> beside an envelope (spec 15.2): only the
    /// bytes the upgrade of its open connection carried, compared in constant time, time telling at
    /// most their length; none before its first connect, nor once its connection is gone. A call
    /// presenting <see cref="CredentialScheme.Elsewhere"/> with any other fails before it goes.
    /// </summary>
    public bool Carries(string credential)
    {
        ArgumentNullException.ThrowIfNull(credential);

        (WebSocketConnection Connection, string Credential)? carried;
        WebSocketConnection? connection;

        lock (_gate)
        {
            carried = _carried;
            connection = _connection;
        }

        // ! a visible field alone: ASCII's encoder writes any other character as '?', which would
        // equal a '?' carried
        if (carried is not { } held || held.Connection != connection || !HostsAndOrigins.IsVisibleField(credential))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(held.Credential), Encoding.ASCII.GetBytes(credential));
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
    /// <see cref="DisconnectException"/> unless Open, as the TypeScript side's ReadyStateError. Its
    /// credential is not sent beside it: the connection carries its upgrade's alone, as its router
    /// fails before it goes a call presenting another.
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
            _listeners.Tell(Close, (isClean, isQuick));
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
            // each listener within its guard, its throw reported through Error; the connection
            // replaced goes whatever a listener of Error does
            try
            {
                _listeners.Tell(starting);
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
        var wasOpen = _readyState == ReadyState.Open;

        if (wasOpen)
        {
            try
            {
                await CloseConnection();
            }
            catch (DisconnectException)
            {
                // closed or replaced meanwhile: what is left is dropped below
            }
        }

        Drop();

        if (wasOpen)
        {
            lock (_gate)
            {
                _readyState = ReadyState.Closed;
            }
        }
    }

    // ws://host:port/pathname, or wss://; an IPv6 literal bracketed, or its colons would read as the
    // port's
    private static Uri UriOf(WebSocketConnectOptions options)
    {
        var host = options.Host.Contains(':') && !options.Host.StartsWith('[') ? $"[{options.Host}]" : options.Host;
        var path = options.Pathname.StartsWith('/') ? options.Pathname : $"/{options.Pathname}";

        return new Uri($"{(options.Secured ? "wss" : "ws")}://{host}:{options.Port}{path}");
    }

    // what a refused upgrade is named by: its status, then its mark where it has one
    private static string RefusalOf(ClientWebSocket socket)
    {
        var mark = (socket.HttpResponseHeaders ?? new Dictionary<string, IEnumerable<string>>())
            .Where((field) =>
            {
                return string.Equals(field.Key, HostsAndOrigins.RefusalHeader, StringComparison.OrdinalIgnoreCase);
            })
            .SelectMany((field) =>
            {
                return field.Value;
            })
            .FirstOrDefault();

        return mark is null ? $"{(int)socket.HttpStatusCode}" : $"{(int)socket.HttpStatusCode} {mark}";
    }

    // a state as a message words it: "open", "closing"…
    private static string NameOf(ReadyState readyState)
    {
        return readyState.ToString().ToLowerInvariant();
    }

    // the credential a connect is given, refused before anything moves: one a field cannot carry as
    // it is, one beside a provider, and one its upgrade would carry off the machine in the clear
    // (spec 13.4), the upgrade being where it would cross
    private static void AssertCredential(WebSocketConnectOptions options)
    {
        if (options.Credential is not null && options.CredentialProvider is not null)
        {
            throw new ArgumentException("a connect takes a credential or a credential provider, not both", nameof(options));
        }

        if (options.Credential is { } credential)
        {
            AssertFieldValue(credential);
        }

        if ((options.Credential is not null || options.CredentialProvider is not null) && !TransportSecurity.IsSecure((options.Secured, options.Host)))
        {
            throw new ArgumentException(
                "a credential never crosses off the machine in the clear: connect over wss, or to a host on the loopback",
                nameof(options));
        }
    }

    // a credential its upgrade's Authorization can carry as it is (RFC 9110 §5.5): one with a space
    // or a tab first or last the server would read trimmed, another than the one a call presents
    private static void AssertFieldValue(string credential)
    {
        if (!HostsAndOrigins.IsVisibleField(credential))
        {
            throw new ArgumentException("a credential holds visible ASCII, spaces and tabs alone, none first or last", nameof(credential));
        }
    }

    // the credential an attempt's upgrade carries: the one given, or one pending provider call's
    // outcome within this attempt's bound; its failure as cause, none for an empty credential
    private async ValueTask<string?> CredentialOf(WebSocketConnectOptions options, (CancellationToken Wait, CancellationToken Provider) tokens)
    {
        var credential = options.Credential;

        if (options.CredentialProvider is { } provider)
        {
            Task<string> pending;
            TaskCompletionSource<string>? source = null;
            lock (_gate)
            {
                if (_credentialPending is { IsCompleted: false } waiting)
                {
                    pending = waiting;
                }
                else
                {
                    source = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                    pending = _credentialPending = source.Task;
                    _ = pending.ContinueWith((completed) =>
                    {
                        _ = completed.Exception;
                        lock (_gate)
                        {
                            if (_credentialPending == completed) { _credentialPending = null; }
                        }
                    }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                }
            }

            // the pending call is published before user code runs, outside the client's lock
            if (source is not null)
            {
                _ = Providing(source);
            }

            async Task Providing(TaskCompletionSource<string> answer)
            {
                try
                {
                    answer.TrySetResult(await provider(tokens.Provider).ConfigureAwait(false));
                }
                catch (Exception reason)
                {
                    answer.TrySetException(reason);
                }
            }

            try
            {
                credential = await pending.WaitAsync(tokens.Wait).ConfigureAwait(false);
                tokens.Wait.ThrowIfCancellationRequested();
            }
            catch (Exception reason) when (!tokens.Wait.IsCancellationRequested)
            {
                throw new WebSocketException(WebSocketError.Faulted, "the credential provider failed", reason);
            }
        }

        if (credential is null)
        {
            return null;
        }

        AssertFieldValue(credential);

        return credential.Length == 0 ? null : credential;
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
        AssertCredential(given);

        // held before anything moves or is kept, so a reconnection connects again with it held
        var options = given with
        {
            Timeout = Clocks.AssertHeld(("a connect's timeout", nameof(WebSocketConnectOptions.Timeout)), given.Timeout),
        };
        var (token, isAttempt) = call;
        ClientWebSocket socket;
        CancellationTokenSource disposed;

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
            disposed = _connectDisposed = new CancellationTokenSource();
        }

        WebSocketConnection connection;
        var attempt = new CancellationTokenSource();

        try
        {
            socket.Options.KeepAliveInterval = _options.Heartbeat;
            socket.Options.KeepAliveTimeout = _options.Heartbeat;

            // a refused upgrade's status and fields, read before the socket goes
            socket.Options.CollectHttpResponseDetails = true;

            foreach (var protocol in options.Protocols ?? [])
            {
                socket.Options.AddSubProtocol(protocol);
            }

            using var timeout = options.Timeout > TimeSpan.Zero ? new CancellationTokenSource(options.Timeout, _clock) : null;
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, timeout?.Token ?? CancellationToken.None, disposed.Token);

            // the provider's token, cancelled once its attempt is over, an open one's included
            string? credential;

            try
            {
                // * an attempt joins the pending provider within its own cancellation bound
                credential = await CredentialOf(options, (linked.Token, attempt.Token));

                if (credential is not null)
                {
                    socket.Options.SetRequestHeader("Authorization", credential);
                }

                linked.Token.ThrowIfCancellationRequested();
                var opening = socket.ConnectAsync(UriOf(options), _options.Invoker ?? Racing, linked.Token);
                _ = opening.ContinueWith((completed) => { _ = completed.Exception; }, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                await opening.WaitAsync(linked.Token);
            }
            catch (OperationCanceledException reason) when (timeout is { IsCancellationRequested: true } && !token.IsCancellationRequested)
            {
                throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"timed out after {options.Timeout.TotalMilliseconds}ms"), reason);
            }
            catch (OperationCanceledException reason) when (disposed.IsCancellationRequested && !token.IsCancellationRequested)
            {
                throw new WebSocketException(WebSocketError.InvalidState, "the transport client was disposed as it connected", reason);
            }
            catch (WebSocketException reason) when (socket.HttpStatusCode is not (0 or HttpStatusCode.SwitchingProtocols))
            {
                // named by its status, and by its mark where it is a refusal of the transport's own
                // (spec 15.6), as the platform's message, "The server returned status code…", never
                // names the mark
                throw new WebSocketException(reason.WebSocketErrorCode, $"the server refused the upgrade: {RefusalOf(socket)}", reason);
            }

            lock (_gate)
            {
                // a dispose as it opened took its socket: there is nothing to keep
                if (_connecting != socket)
                {
                    throw new WebSocketException(WebSocketError.InvalidState, "the transport client was disposed as it connected");
                }

                _connecting = null;
                _connectDisposed = null;
                _connection = connection = new WebSocketConnection(socket, (MaximumMessageBytes, CloseTimeout));
                _carried = credential is null ? null : (connection, credential);
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
        finally
        {
            lock (_gate)
            {
                if (_connectDisposed == disposed) { _connectDisposed = null; }
            }
            EndAttempt(attempt);
            disposed.Dispose();
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
        CancellationTokenSource? disposed;

        lock (_gate)
        {
            connecting = _connecting;
            disposed = _connectDisposed;
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
        if (disposed is not null)
        {
            try { _ = disposed.CancelAsync().ContinueWith((completed) => { _ = completed.Exception; }, TaskScheduler.Default); }
            catch (ObjectDisposedException) { /* the connect's own ending releases its source */ }
        }
        connecting?.Abort();
        disconnecting?.TrySetResult(true);

        if (connection is not null)
        {
            Release(connection);
        }
    }

    // the attempt ends and its callbacks are scheduled by CancelAsync: neither their throw nor
    // their completion holds the connect; the callback task owns its source until it settles
    private static void EndAttempt(CancellationTokenSource attempt)
    {
        _ = attempt.CancelAsync().ContinueWith((completed) =>
        {
            _ = completed.Exception;
            attempt.Dispose();
        }, TaskScheduler.Default);
    }

    // reads the connection until it ends, then tells its end: to the close under way, which tells
    // it, or as a close of the server's or the network's, with the one error this side failed it
    // for of its own first, when it did; a connection dropped tells nothing
    private async Task Follow(WebSocketConnection connection)
    {
        Exception? failure = null;

        try
        {
            await connection.Read((message) =>
            {
                // nothing more is heard once a close began, nor from a connection dropped
                if (_connection == connection && _readyState != ReadyState.Closing)
                {
                    _listeners.Tell(Message, message);
                }
            });
        }
        catch (Exception reason) when (reason is WebSocketException or OperationCanceledException or IOException)
        {
            // ! a protocol error alone, which .NET 10 raises as Faulted: a server gone without its
            // closing handshake, its TCP connection ended or reset, is ConnectionClosedPrematurely; its
            // heartbeat's drop an OperationCanceledException around the KeepAliveTimeout's; and once
            // this side ended it of its own, failed with 1009 or aborted past its close timeout, what
            // its socket meets says nothing more (spec 15.1)
            if (!connection.IsEndedHere && reason is WebSocketException { WebSocketErrorCode: WebSocketError.Faulted })
            {
                failure = reason;
            }
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

        // * its end: its one error, a message past its bound named by it and its value, then its
        // close, told even when a listener of Error throws, which goes on to the task no one awaits,
        // the platform's (spec 15.1)
        failure ??= connection.IsTooBig ? connection.TooBigOf("the connection") : null;

        try
        {
            if (failure is not null)
            {
                Error?.Invoke(failure);
            }
        }
        finally
        {
            _listeners.Tell(Close, (false, false));
        }
    }
}
