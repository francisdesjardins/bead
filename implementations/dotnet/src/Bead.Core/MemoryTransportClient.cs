using System.Globalization;

namespace Bead;

/// <summary>How an in-memory transport client is built.</summary>
public sealed record MemoryTransportClientOptions
{
    /// <summary>
    /// What the stack built on it runs on, a connect's timeout and a reconnection's waits among
    /// them; the system's clock when none.
    /// </summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>
    /// Where it tells what comes to it, each in a turn of its own and in order: one of its own when
    /// none; the tests' way to settle on what it delivered.
    /// </summary>
    internal SerialScheduler? Scheduler { get; init; }
}

/// <summary>
/// Where an in-memory client connects — a server of the same process — who it says it is there,
/// and how long it waits.
/// </summary>
public sealed record MemoryConnectOptions
{
    /// <summary>The server it connects to.</summary>
    public required MemoryTransportServer Server { get; init; }

    /// <summary>
    /// The address its server hands with each envelope it sends, and names its connection by (spec
    /// 15.13): a gateway's caller's, say; <c>local</c> when none. Visible ASCII but <c>;</c>, which
    /// ends a handle's part, at least one character; any other is an <see cref="ArgumentException"/>
    /// as the connect is asked, nothing changed.
    /// </summary>
    public string? Address { get; init; }

    /// <summary>
    /// The port its server hands with each envelope it sends; none when none. From 0 to 65,535; any
    /// other is an <see cref="ArgumentOutOfRangeException"/> as the connect is asked, nothing changed.
    /// </summary>
    public int? Port { get; init; }

    /// <summary>
    /// How long the connect may take before it throws a <see cref="TimeoutException"/>: 10 seconds
    /// unless told, as a server in the same process answers at once or not at all; from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one, or
    /// <see cref="System.Threading.Timeout.InfiniteTimeSpan"/>, which never times out; zero is
    /// refused.
    /// </summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(10);
}

/// <summary>
/// A transport client in memory (spec 15.13), to a <see cref="MemoryTransportServer"/> of the same
/// process: each envelope copied as it is sent, and handed on whole, once and in order, in a later
/// turn than its send, with the credential its router gives beside it, any field value, as
/// <c>POST /bead</c> carries one; what comes back carries none. It never leaves the process, so it
/// is secure (spec 13.4), and holds no bound, heartbeat or timeout of its own but its connect's. It
/// goes from <see cref="ReadyState.Uninitialized"/> through Connecting and Open to Closing and
/// Closed, and connects again once Closed — or reconnects, with the options of its last connect.
/// </summary>
public sealed class MemoryTransportClient : IRouterClientTransport, IAsyncDisposable
{
    private readonly TimeProvider _clock;
    // where what comes to it is told, one turn at a time, in order
    private readonly SerialScheduler _scheduler;
    // what every move from one state to another decides by
    private readonly Lock _gate = new();
    private volatile ReadyState _readyState = ReadyState.Uninitialized;
    // the options of the last connect its guard let through, which a reconnection connects with
    private MemoryConnectOptions? _lastConnectOptions;
    // what a dispose cancels the connect under way by
    private CancellationTokenSource? _connecting;
    // the open connection; one this side let go of is none, and its end tells nothing
    private volatile MemoryConnection? _connection;
    private Action? _reconnect;
    // how its events are told: what a listener throws is reported through Error
    private readonly ListenerGuard _listeners;

    /// <summary>A transport client, not yet connected.</summary>
    public MemoryTransportClient(MemoryTransportClientOptions? options = null)
    {
        _clock = options?.Clock ?? TimeProvider.System;
        _scheduler = options?.Scheduler ?? new SerialScheduler();
        _listeners = new ListenerGuard((reason, _) =>
        {
            Error?.Invoke(reason);
        });
    }

    /// <inheritdoc/>
    public event Action<TransportMessage>? Message;

    /// <summary>
    /// The connection closed: clean when this side's close was told so, never when its server closed
    /// it, which is told in a later turn than that close; quick when this side's close was told so. A
    /// connection a dispose lets go of, or a reconnection replaces, tells none.
    /// </summary>
    public event Action<bool, bool>? Close;

    /// <summary>
    /// What a listener of its messages, its close or its reconnection threw, the client going on as
    /// if it returned (spec 15.1): nothing else goes wrong in memory.
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

    /// <summary>It is secure: it never leaves the process (spec 13.4).</summary>
    public bool IsSecure
    {
        get
        {
            return true;
        }
    }

    /// <summary>
    /// Connects to its server; settles once its server drew the connection and told it, in a turn
    /// of the server's own. Refused with an <see cref="ArgumentOutOfRangeException"/> for a timeout
    /// <see cref="MemoryConnectOptions.Timeout"/> does not take, zero among them, or a port past its
    /// range, and with an <see cref="ArgumentException"/> for an address
    /// <see cref="MemoryConnectOptions.Address"/> does not take, each of which leaves the state, and
    /// the target a reconnection replays, as they were; with an
    /// <see cref="InvalidOperationException"/> unless Uninitialized or Closed; and with an
    /// <see cref="OperationCanceledException"/>, nothing changed, when its token is cancelled
    /// already. Then it throws a <see cref="ConnectException"/> when its server is not open, or a
    /// dispose gave up on it, a <see cref="TimeoutException"/> past its timeout, and an
    /// <see cref="OperationCanceledException"/> once its token is cancelled, ending Closed.
    /// </summary>
    public Task Connect(MemoryConnectOptions options, CancellationToken cancellationToken = default)
    {
        return Connecting(options, (cancellationToken, false));
    }

    /// <summary>
    /// It carries any credential a field can hold beside an envelope (spec 15.13), as
    /// <c>POST /bead</c> does (spec 15.5): visible ASCII, spaces and tabs, none first or last.
    /// </summary>
    public bool Carries(string credential)
    {
        ArgumentNullException.ThrowIfNull(credential);

        return HostsAndOrigins.IsVisibleField(credential);
    }

    /// <summary>
    /// Hands a copy of the bytes of <paramref name="message"/> to its server, with the credential
    /// beside them, in a later turn, after what went before; refused with a
    /// <see cref="DisconnectException"/> unless Open, and with an <see cref="ArgumentException"/>,
    /// its connection kept, for a text message, which is no envelope, or a credential no field
    /// carries.
    /// </summary>
    public Task Send(TransportMessage message)
    {
        MemoryConnection? connection;
        ReadyState readyState;

        lock (_gate)
        {
            connection = _connection;
            readyState = _readyState;
        }

        if (readyState != ReadyState.Open || connection is null)
        {
            return Task.FromException(new DisconnectException($"the transport client is {NameOf(readyState)}, not open"));
        }

        if (message.IsText)
        {
            return Task.FromException(new ArgumentException(MemoryTransportServer.TextRefused, nameof(message)));
        }

        // refused before it goes, the connection kept, as over HTTP: a field could not carry it as
        // it is (RFC 9110 §5.5)
        if (message.Credential is { } credential && !HostsAndOrigins.IsVisibleField(credential))
        {
            return Task.FromException(new ArgumentException("a credential holds visible ASCII, spaces and tabs alone, none first or last", nameof(message)));
        }

        // * copied as it is sent: the sender's buffer stays its own, as a socket's does
        connection.Server.Receive(connection, new TransportMessage(message.Bytes.ToArray(), message.IsText) { Credential = message.Credential });

        return Task.CompletedTask;
    }

    /// <summary>
    /// Closes the connection and raises its close, which says it was clean as
    /// <see cref="TransportDisconnectOptions.IsClean"/> does, and quick as
    /// <see cref="TransportDisconnectOptions.IsQuick"/> does, both alike in memory, where no
    /// handshake waits; its server is told in a later turn, after what was sent before. Refused with
    /// a <see cref="DisconnectException"/> unless Open. It ends Closed.
    /// </summary>
    public Task CloseConnection(TransportDisconnectOptions? options = null)
    {
        var isClean = options?.IsClean ?? true;
        var isQuick = options?.IsQuick ?? false;
        MemoryConnection connection;

        lock (_gate)
        {
            if (_readyState != ReadyState.Open || _connection is null)
            {
                return Task.FromException(new DisconnectException($"the transport client is {NameOf(_readyState)}, not open"));
            }

            connection = _connection;
            _connection = null;
            _readyState = ReadyState.Closing;
        }

        if (connection.CloseAtClient())
        {
            connection.Server.Released(connection, isClean);
        }

        lock (_gate)
        {
            _readyState = ReadyState.Closed;
        }

        _listeners.Tell(Close, (isClean, isQuick));

        return Task.CompletedTask;
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
        MemoryConnectOptions target;
        MemoryConnection? replaced;
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

            // before the release below, so a token cancelled already leaves an open connection alone
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
    /// lets go of what it holds, telling nothing: a connect under way fails with a
    /// <see cref="ConnectException"/>. A reconnection under way is not stopped by it, only the
    /// attempt it is making: cancel its token.
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

        Drop();
    }

    // a state as a message words it: "open", "closing"…
    private static string NameOf(ReadyState readyState)
    {
        return readyState.ToString().ToLowerInvariant();
    }

    // who a connect says its client is, refused before anything moves: an address a handle can
    // name, and a port of the range
    private static void AssertClient(MemoryConnectOptions options)
    {
        if (options.Address is { } address && !IsHandlePart(address))
        {
            throw new ArgumentException("an in-memory connect's address is visible ASCII but ';', at least one character", nameof(options));
        }

        if (options.Port is { } port && port is < 0 or > 65_535)
        {
            throw new ArgumentOutOfRangeException(nameof(options), string.Create(CultureInfo.InvariantCulture, $"a port is from 0 to 65535, not {port}"));
        }
    }

    // an address a handle can name: visible ASCII but `;`, which ends a handle's part
    private static bool IsHandlePart(string address)
    {
        return address.Length > 0 && address.All((character) =>
        {
            return character is >= '!' and <= '~' and not ';';
        });
    }

    // a connection this side let go of without a close of its own: its server told, unclean
    private static void Release(MemoryConnection connection)
    {
        if (connection.CloseAtClient())
        {
            connection.Server.Released(connection, false);
        }
    }

    // a connect, or a reconnection's attempt, which its guard alone tells apart: an attempt passes
    // only while the client reconnects, and leaves the state to its reconnection when it fails
    private async Task Connecting(MemoryConnectOptions given, (CancellationToken Token, bool IsAttempt) call)
    {
        ArgumentNullException.ThrowIfNull(given);
        ArgumentNullException.ThrowIfNull(given.Server, nameof(given));
        AssertClient(given);

        // held before anything moves or is kept, so a reconnection connects again with it held
        var options = given with
        {
            Timeout = Clocks.AssertHeld(("a connect's timeout", nameof(MemoryConnectOptions.Timeout)), given.Timeout),
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

            // honoured before anything moves, so one cancelled already leaves the state as it was
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

        try
        {
            using var timeout = options.Timeout > TimeSpan.Zero ? new CancellationTokenSource(options.Timeout, _clock) : null;
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, connecting.Token, timeout?.Token ?? CancellationToken.None);
            // what its server sent before this end opened, and its end, heard once it has, in its
            // order; each touched on its scheduler alone
            var early = new List<TransportMessage>();
            var isOpened = false;
            var isEndedEarly = false;
            var peer = new MemoryPeer
            {
                Address = options.Address,
                Port = options.Port,
                Deliver = (connection, message) =>
                {
                    _scheduler.Post(() =>
                    {
                        if (isOpened)
                        {
                            Told(connection, message);
                        }
                        else
                        {
                            early.Add(message);
                        }
                    });
                },
                Ended = (connection) =>
                {
                    _scheduler.Post(() =>
                    {
                        if (isOpened)
                        {
                            Ended(connection);
                        }
                        else
                        {
                            isEndedEarly = true;
                        }
                    });
                },
            };
            MemoryConnection connection;

            try
            {
                connection = await options.Server.Accept(peer, linked.Token);

                // * a cancel or a timeout holds until the connect settles: one met as its server drew
                // the connection gives the connect up, what was drawn let go of unclean
                if (!connecting.IsCancellationRequested && linked.IsCancellationRequested)
                {
                    Release(connection);
                    linked.Token.ThrowIfCancellationRequested();
                }
            }
            catch (OperationCanceledException reason) when (connecting.IsCancellationRequested)
            {
                throw new ConnectException($"the transport client was disposed as it connected: {reason.Message}");
            }
            catch (OperationCanceledException reason) when (timeout is { IsCancellationRequested: true } && !token.IsCancellationRequested)
            {
                throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"timed out after {options.Timeout.TotalMilliseconds}ms"), reason);
            }

            var isClosedEarly = false;
            var isOpen = false;

            lock (_gate)
            {
                // a dispose as it opened let go of it: there is nothing to keep; nor when its server
                // closed it before it opened, whose end then tells nothing here
                if (_connecting == connecting)
                {
                    _connecting = null;
                    isClosedEarly = connection.IsClosedAtServer;

                    if (!isClosedEarly)
                    {
                        _connection = connection;
                        _readyState = ReadyState.Open;
                        isOpen = true;
                    }
                }
            }

            if (isOpen)
            {
                // * after every delivery posted before it, in order, then each as it comes
                _scheduler.Post(() =>
                {
                    isOpened = true;

                    foreach (var message in early)
                    {
                        Told(connection, message);
                    }

                    early.Clear();

                    if (isEndedEarly)
                    {
                        Ended(connection);
                    }
                });

                return;
            }

            Release(connection);

            throw new ConnectException(isClosedEarly ? "the in-memory transport server closed the connection as it opened" : "the transport client was disposed as it connected");
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

    // * in a turn of its own: what its server sent, copied already; nothing more is heard once a
    // close began here, nor from a connection let go of
    private void Told(MemoryConnection connection, TransportMessage message)
    {
        if (_connection != connection || connection.IsClosedAtClient)
        {
            return;
        }

        _listeners.Tell(Message, message);
    }

    // * in a turn of its own: its server ended the connection, after what it sent before; told
    // unclean, as a close of the peer's, unless this side let go of it first
    private void Ended(MemoryConnection connection)
    {
        if (!connection.CloseAtClient())
        {
            return;
        }

        lock (_gate)
        {
            if (_connection != connection)
            {
                return;
            }

            _connection = null;
            _readyState = ReadyState.Closed;
        }

        _listeners.Tell(Close, (false, false));
    }

    // lets go of what it holds, telling nothing: a connect under way fails, an open client ends Closed
    private void Drop()
    {
        CancellationTokenSource? connecting;
        MemoryConnection? connection;

        lock (_gate)
        {
            connecting = _connecting;
            connection = _connection;
            _connecting = null;
            _connection = null;

            if (_readyState == ReadyState.Open)
            {
                _readyState = ReadyState.Closed;
            }
        }

        try
        {
            connecting?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // the connect ended meanwhile: there is nothing left to cancel
        }

        if (connection is not null)
        {
            Release(connection);
        }
    }
}
