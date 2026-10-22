using System.Collections.Concurrent;

namespace Bead;

/// <summary>How an in-memory transport server is built.</summary>
public sealed record MemoryTransportServerOptions
{
    /// <summary>
    /// What the stack built on it runs on, and what tells when a connection last delivered an
    /// envelope; the system's clock when none.
    /// </summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>
    /// Where it tells what comes to it, each in a turn of its own and in order: one of its own when
    /// none; the tests' way to settle on what it delivered.
    /// </summary>
    internal SerialScheduler? Scheduler { get; init; }

    /// <summary>
    /// What each connect waits on, with its token, before the server draws its connection: the
    /// tests' way to hold one, as a peer that never answers holds a socket's.
    /// </summary>
    internal Func<CancellationToken, Task>? Accepting { get; init; }
}

/// <summary>
/// A transport server in memory (spec 15.13): what a <see cref="MemoryTransportClient"/> of the same
/// process connects to, a router called in process on each side. A connect draws a connection named
/// <c>type=MEMORY;ip=…;ordinal=…</c>, by the address its client gave as it connected, or
/// <c>local</c>, and the rank it was taken at, from 1, never reset, so no handle is given twice
/// (spec 15.1). Each envelope is copied as it is sent, and handed on whole, once and in the order it
/// was sent, in a later turn than its send, never within it, so no router is entered again from its
/// own call; one its client sends comes with the credential the client handed beside it and the
/// address and the port the client gave as it connected; nothing is carried toward a client. It
/// never leaves the process, so its connections are secure (spec 13.4), and it holds no bound,
/// heartbeat or timeout of its own: its routers' limits bound what it carries. It goes from
/// <see cref="ReadyState.Uninitialized"/> through Connecting and Open to Closing and Closed, and
/// starts again once Closed; a connect to it while it is not open fails before anything goes.
/// </summary>
public sealed class MemoryTransportServer : IServerTransport, IAsyncDisposable
{
    // constants

    // what names a connection whose client gave no address, and the server's own place
    private const string Local = "local";

    // what refuses a text message at either end, as the TypeScript side words it
    internal const string TextRefused = "an in-memory connection carries envelopes, as bytes";

    private readonly TimeProvider _clock;
    // where what comes to it is told, one turn at a time, in order
    private readonly SerialScheduler _scheduler;
    private readonly Func<CancellationToken, Task>? _accepting;
    // its ready state, and the guards around its start and its stop, as every transport server's
    private readonly TransportServerLife _life = new();
    // each connection held, by its handle; drawn and ended on its scheduler alone
    private readonly ConcurrentDictionary<string, MemoryConnection> _connections = new();
    // how its events are told: what a listener throws is reported through Error, with its connection
    private readonly ListenerGuard _listeners;
    // how many connections were drawn, which ranks each, its handle by it
    private long _arrivals;

    /// <summary>A transport server, not yet started.</summary>
    public MemoryTransportServer(MemoryTransportServerOptions? options = null)
    {
        _clock = options?.Clock ?? TimeProvider.System;
        _scheduler = options?.Scheduler ?? new SerialScheduler();
        _accepting = options?.Accepting;
        _listeners = new ListenerGuard((reason, connectionHandle) =>
        {
            Error?.Invoke(reason, connectionHandle ?? "");
        });
    }

    /// <inheritdoc/>
    public event Action<string>? Connection;

    /// <inheritdoc/>
    public event Action<TransportMessage, string>? Message;

    /// <summary>
    /// A connection closed, and its handle: clean when the server closed it, as its client's close
    /// said when its client did, told in a later turn than that close.
    /// </summary>
    public event Action<bool, string>? Close;

    /// <summary>
    /// What a listener of its events threw, with its connection's handle, the transport going on as if
    /// it returned (spec 15.1): nothing else goes wrong in memory.
    /// </summary>
    public event Action<Exception, string>? Error;

    /// <summary>Its type, <see cref="TransportTypes.Memory"/>, which every handle it draws begins with.</summary>
    public string Type
    {
        get
        {
            return TransportTypes.Memory;
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

    /// <summary>Where it is in its life: Uninitialized until its first start.</summary>
    public ReadyState ReadyState
    {
        get
        {
            return _life.ReadyState;
        }
    }

    /// <summary>The handles of the connections open right now.</summary>
    public IReadOnlyCollection<string> ConnectionHandles
    {
        get
        {
            return [.. _connections.Keys];
        }
    }

    /// <summary>
    /// The connections open right now, in the order they came, as a copy: each its client's address,
    /// <c>local</c> when it gave none, its port, 0 when it gave none, and when it last delivered an
    /// envelope.
    /// </summary>
    public IReadOnlyList<TransportServerClient> Clients
    {
        get
        {
            return [.. _connections.Values.OrderBy((connection) =>
            {
                return connection.Arrival;
            }).Select((connection) =>
            {
                return new TransportServerClient(
                    connection.Address ?? Local,
                    connection.ConnectionHandle,
                    connection.LastActivity,
                    connection.Port ?? 0,
                    TransportTypes.Memory);
            })];
        }
    }

    /// <summary>
    /// What it holds: its connections, counted, at no ceiling, since it holds no bound of its own;
    /// and their handles — never to leave the process — which a server sets its own layers against.
    /// </summary>
    public Gauges Gauges()
    {
        var connectionHandles = _connections.Keys;

        return Bead.Gauges.Of(new Dictionary<string, long> { ["connections"] = connectionHandles.Count }, connectionHandles);
    }

    /// <summary>
    /// Takes connects from now on, and gives where: <c>local</c>, port 0, since it serves no port.
    /// Refused with an <see cref="InvalidOperationException"/> unless Uninitialized or Closed — a
    /// second start even while the first is under way.
    /// </summary>
    public Task<TransportServerAddress> Start()
    {
        return _life.Start(() =>
        {
            return Task.FromResult(new TransportServerAddress(Local, 0));
        });
    }

    /// <summary>
    /// Takes no connect from now on, and closes every connection, each told, clean, and its client
    /// told in a turn of its own; it ends Closed. It settles at once when Uninitialized or Closed; a
    /// second stop, or one from a close listener, shares the stop under way; one while starting is an
    /// <see cref="InvalidOperationException"/>.
    /// </summary>
    public Task Stop()
    {
        return _life.Stop(Stopping);
    }

    /// <summary>As <see cref="Stop"/>: a server's facade stops its transport with it.</summary>
    public Task Shutdown()
    {
        return Stop();
    }

    /// <summary>
    /// Closes a connection and settles once its close was told, clean, in a later turn than this
    /// call, its client told in a turn of its own; what it sent before still reaches its client, and
    /// what its client sent is heard no more. False when it held none by that handle.
    /// </summary>
    public async Task<bool> CloseConnection(string connectionHandle)
    {
        if (!_connections.TryGetValue(connectionHandle, out var connection))
        {
            return false;
        }

        var ended = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        _scheduler.Post(() =>
        {
            try
            {
                End(connection);
            }
            finally
            {
                ended.TrySetResult();
            }
        });
        await ended.Task;

        return true;
    }

    /// <summary>
    /// Nothing is carried toward a client (spec 15.13): a command presenting
    /// <see cref="CredentialScheme.Elsewhere"/> fails before it goes, DESTINATION_UNREACHABLE.
    /// </summary>
    public bool CarriesCredential(string connectionHandle)
    {
        return false;
    }

    /// <summary>Every connection is secure: it never leaves the process (spec 13.4).</summary>
    public bool IsSecure(string connectionHandle)
    {
        return true;
    }

    /// <summary>
    /// Hands a copy of the bytes of <paramref name="message"/> to its connection's client, in a later
    /// turn, after what went before; nothing is carried beside them. What goes to a connection not
    /// open goes nowhere, and says nothing, for the router refuses what is for a connection it does
    /// not hold itself. A text message, which is no envelope, is an <see cref="ArgumentException"/>.
    /// </summary>
    public Task Send(TransportMessage message, string connectionHandle)
    {
        if (message.IsText)
        {
            return Task.FromException(new ArgumentException(TextRefused, nameof(message)));
        }

        if (_connections.TryGetValue(connectionHandle, out var connection) && !connection.IsClosedAtServer)
        {
            // * copied as it is sent: the sender's buffer stays its own, as a socket's does
            connection.Peer.Deliver(connection, new TransportMessage(message.Bytes.ToArray(), message.IsText));
        }

        return Task.CompletedTask;
    }

    /// <summary>As <see cref="Stop"/>.</summary>
    public async ValueTask DisposeAsync()
    {
        await Stop();
    }

    /// <summary>
    /// A connect: refused with a <see cref="ConnectException"/> unless open, before anything goes;
    /// then, in a turn of the server's own, its connection drawn and told, refused all the same when
    /// a stop began meanwhile, and dropped when <paramref name="cancellationToken"/> was cancelled.
    /// </summary>
    internal async Task<MemoryConnection> Accept(MemoryPeer peer, CancellationToken cancellationToken)
    {
        if (_life.ReadyState != ReadyState.Open)
        {
            throw new ConnectException($"the in-memory transport server is {NameOf(_life.ReadyState)}, not open");
        }

        if (_accepting is { } holding)
        {
            await holding(cancellationToken);
        }

        var drawn = new TaskCompletionSource<MemoryConnection>(TaskCreationOptions.RunContinuationsAsynchronously);

        _scheduler.Post(() =>
        {
            if (cancellationToken.IsCancellationRequested)
            {
                drawn.TrySetCanceled(cancellationToken);

                return;
            }

            // ! judged in the turn it is drawn in, as a stop closes what it holds in a turn of its
            // own: none drawn once a stop began outlives it
            if (_life.ReadyState != ReadyState.Open)
            {
                drawn.TrySetException(new ConnectException($"the in-memory transport server is {NameOf(_life.ReadyState)}, not open"));

                return;
            }

            // * the handle drawn as the connection is taken, by the rank it came at and the address
            // its client gave, which another connection may share, never name it alone
            var arrival = Interlocked.Increment(ref _arrivals);
            var connection = new MemoryConnection
            {
                Address = peer.Address,
                Arrival = arrival,
                ConnectionHandle = $"type={TransportTypes.Memory};ip={peer.Address ?? Local};ordinal={arrival}",
                Peer = peer,
                Port = peer.Port,
                Server = this,
            };

            // ! no handle is given twice: one already held is a bug of the draw
            if (!_connections.TryAdd(connection.ConnectionHandle, connection))
            {
                drawn.TrySetException(new InvalidOperationException($"the handle {connection.ConnectionHandle} names a connection already held"));

                return;
            }

            _listeners.Tell(Connection, connection.ConnectionHandle);
            drawn.TrySetResult(connection);
        });

        return await drawn.Task;
    }

    /// <summary>
    /// What a client sent on its connection, copied already, with the credential it handed beside
    /// it: told in a later turn, after what it sent before, with the address and the port its client
    /// gave, or <c>local</c> and none (spec 15.1); heard by nobody once the server ended the
    /// connection.
    /// </summary>
    internal void Receive(MemoryConnection connection, TransportMessage message)
    {
        _scheduler.Post(() =>
        {
            if (connection.IsClosedAtServer)
            {
                return;
            }

            connection.LastActivity = _clock.GetUtcNow();
            _listeners.Tell(Message, (message with { Address = connection.Address ?? Local, Port = connection.Port }, connection.ConnectionHandle));
        });
    }

    /// <summary>
    /// A client let its connection go: its close told in a later turn, after what it sent before,
    /// clean as the client's close said; nothing when the server ended it first.
    /// </summary>
    internal void Released(MemoryConnection connection, bool isClean)
    {
        _scheduler.Post(() =>
        {
            if (!connection.CloseAtServer())
            {
                return;
            }

            _connections.TryRemove(new KeyValuePair<string, MemoryConnection>(connection.ConnectionHandle, connection));
            _listeners.Tell(Close, (isClean, connection.ConnectionHandle));
        });
    }

    // a state as a message words it: "open", "closing"…
    private static string NameOf(ReadyState readyState)
    {
        return readyState.ToString().ToLowerInvariant();
    }

    // * in a turn of the server's: a connection it ends, gone from its handles, its client told in
    // a turn of the client's own, then its close told, clean; nothing when it ended already
    private void End(MemoryConnection connection)
    {
        if (!connection.CloseAtServer())
        {
            return;
        }

        _connections.TryRemove(new KeyValuePair<string, MemoryConnection>(connection.ConnectionHandle, connection));
        connection.Peer.Ended(connection);
        _listeners.Tell(Close, (true, connection.ConnectionHandle));
    }

    // every connection ended in one turn of the server's, in the order they came, so none drawn in a
    // turn before it is left open, and none is drawn after it
    private async Task Stopping()
    {
        var ended = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        _scheduler.Post(() =>
        {
            try
            {
                foreach (var connection in _connections.Values.OrderBy((held) =>
                {
                    return held.Arrival;
                }).ToList())
                {
                    End(connection);
                }
            }
            finally
            {
                ended.TrySetResult();
            }
        });
        await ended.Task;
    }
}

/// <summary>
/// The client's end of an in-memory connection, as its server reaches it: who it said it was as it
/// connected, and where what the server sends and its close are handed, each in a turn of the
/// client's own.
/// </summary>
internal sealed record MemoryPeer
{
    /// <summary>The address its client gave as it connected; none for <c>local</c>.</summary>
    public required string? Address { get; init; }

    /// <summary>The port its client gave as it connected; none for none.</summary>
    public required int? Port { get; init; }

    /// <summary>Hands what the server sent, copied already, to the client, in a turn of its own.</summary>
    public required Action<MemoryConnection, TransportMessage> Deliver { get; init; }

    /// <summary>Tells the client its server ended the connection, in a turn of its own.</summary>
    public required Action<MemoryConnection> Ended { get; init; }
}

/// <summary>
/// One in-memory connection: its handle, its client's end, and each end's close, taken once, so
/// what one end sent before it closed still reaches the other, and nothing after.
/// </summary>
internal sealed class MemoryConnection
{
    private readonly Lock _gate = new();
    private bool _isClosedAtServer;
    private bool _isClosedAtClient;
    private DateTimeOffset? _lastActivity;

    /// <summary>Its handle.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>The address its client gave as it connected; none for <c>local</c>.</summary>
    public required string? Address { get; init; }

    /// <summary>The port its client gave as it connected; none for none.</summary>
    public required int? Port { get; init; }

    /// <summary>The rank it was drawn at, from 1.</summary>
    public required long Arrival { get; init; }

    /// <summary>Its client's end.</summary>
    public required MemoryPeer Peer { get; init; }

    /// <summary>Its server.</summary>
    public required MemoryTransportServer Server { get; init; }

    /// <summary>When it last delivered an envelope to its server, on its server's clock; none until then.</summary>
    public DateTimeOffset? LastActivity
    {
        get
        {
            lock (_gate)
            {
                return _lastActivity;
            }
        }

        set
        {
            lock (_gate)
            {
                _lastActivity = value;
            }
        }
    }

    /// <summary>Whether its server's end closed: what comes to it is heard no more.</summary>
    public bool IsClosedAtServer
    {
        get
        {
            lock (_gate)
            {
                return _isClosedAtServer;
            }
        }
    }

    /// <summary>Whether its client's end closed: what comes to it is heard no more.</summary>
    public bool IsClosedAtClient
    {
        get
        {
            lock (_gate)
            {
                return _isClosedAtClient;
            }
        }
    }

    /// <summary>Closes its server's end; false when it was closed already.</summary>
    public bool CloseAtServer()
    {
        lock (_gate)
        {
            var wasOpen = !_isClosedAtServer;

            _isClosedAtServer = true;

            return wasOpen;
        }
    }

    /// <summary>Closes its client's end; false when it was closed already.</summary>
    public bool CloseAtClient()
    {
        lock (_gate)
        {
            var wasOpen = !_isClosedAtClient;

            _isClosedAtClient = true;

            return wasOpen;
        }
    }
}
