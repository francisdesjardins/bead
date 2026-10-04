using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Bead.Transport.WebSockets;

/// <summary>How a WebSocket transport server holds its connections.</summary>
public sealed record WebSocketTransportServerOptions
{
    /// <summary>
    /// The largest message it reads, in bytes: one larger closes its connection with 1009. A
    /// router's envelope limit at least, as the TypeScript side's <c>maxPayload</c> is; an
    /// envelope's limit by default.
    /// </summary>
    public int? MaximumMessageBytes { get; init; }

    /// <summary>
    /// How often each connection is pinged, and how long its pong may take: a peer gone without a
    /// word ends in a close rather than never. From 1 to 2³¹ − 1 milliseconds, rounded to the
    /// nearest whole one, or <see cref="Timeout.InfiniteTimeSpan"/> for none; the transport refuses
    /// any other, zero among them, with an <see cref="ArgumentOutOfRangeException"/> as it is built.
    /// The platform's, on the real clock.
    /// </summary>
    public TimeSpan Heartbeat { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How long a close handshake may take: a peer that never answers is dropped after it. From 1 to
    /// 2³¹ − 1 milliseconds, rounded to the nearest whole one, or
    /// <see cref="Timeout.InfiniteTimeSpan"/> to wait without end; the transport refuses any other,
    /// zero among them, with an <see cref="ArgumentOutOfRangeException"/> as it is built. It bounds
    /// the platform's close, on the real clock.
    /// </summary>
    public TimeSpan CloseTimeout { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// What the stack built on it runs on, and what tells when a connection last delivered a
    /// message; the system's clock when none.
    /// </summary>
    public TimeProvider? Clock { get; init; }
}

/// <summary>Where a transport server listens.</summary>
public sealed record WebSocketTransportStartOptions
{
    /// <summary>The address it listens on.</summary>
    public string Address { get; init; } = "0.0.0.0";

    /// <summary>The port it listens on.</summary>
    public int Port { get; init; } = 80;

    /// <summary>Whether it takes any free port instead.</summary>
    public bool FindOpenPort { get; init; }
}

/// <summary>
/// A transport server over WebSocket connections, on Kestrel: one envelope per binary message, a
/// connection named <c>type=WS;ip=…;port=…</c>, each pinged every <see
/// cref="WebSocketTransportServerOptions.Heartbeat"/>. A text message is delivered as text, which
/// a router reports. What goes out to one connection goes in order, one message at a time. It goes
/// from <see cref="ReadyState.Uninitialized"/> through Connecting and Open to Closing and Closed,
/// and starts again once Closed.
/// </summary>
public sealed class WebSocketTransportServer : IServerTransport, IAsyncDisposable
{
    private readonly WebSocketTransportServerOptions _options;
    private readonly TimeProvider _clock;
    // each connection, and its end as the server tells it: gone from the handles, its close raised
    private readonly ConcurrentDictionary<string, Held> _connections = new();
    // its ready state, and the guards around its start and its stop, as every transport server's
    private readonly TransportServerLife _life = new();
    private WebApplication? _application;
    // how many connections came, which ranks each: the dictionary keeps no order
    private long _arrivals;

    /// <summary>
    /// A transport server, not yet listening, its heartbeat and close timeout held: one no timer
    /// holds is an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public WebSocketTransportServer(WebSocketTransportServerOptions? options = null)
    {
        var given = options ?? new WebSocketTransportServerOptions();

        _options = given with
        {
            Heartbeat = WebSocketConnection.AssertHeartbeat(given.Heartbeat, nameof(WebSocketTransportServerOptions.Heartbeat)),
            CloseTimeout = WebSocketConnection.AssertCloseTimeout(given.CloseTimeout, nameof(WebSocketTransportServerOptions.CloseTimeout)),
        };
        _clock = _options.Clock ?? TimeProvider.System;
    }

    /// <inheritdoc/>
    public event Action<string>? Connection;

    /// <inheritdoc/>
    public event Action<TransportMessage, string>? Message;

    /// <inheritdoc/>
    public event Action<bool, string>? Close;

    /// <summary>
    /// What went wrong on a connection, with its handle. Never the server's own, with an empty
    /// handle, as the TypeScript side's can be: Kestrel tells a failure after it listens only to its
    /// logs.
    /// </summary>
    public event Action<Exception, string>? Error;

    /// <summary>Each application a start builds, as it is built: the tests' way to see it disposed.</summary>
    internal event Action<WebApplication>? Built;

    /// <summary>
    /// Each stop, once its application is gone: the tests' way to make one throw, as the TypeScript
    /// side's tests make their transport's stop throw.
    /// </summary>
    internal event Action? Stopped;

    /// <summary>
    /// What a connection is made of, from the socket accepted and the handle its peer gives: the
    /// tests' way to give one a socket of theirs, or a handle another holds.
    /// </summary>
    internal Func<WebSocket, string, (WebSocket Socket, string ConnectionHandle)>? Accepted { get; init; }

    /// <summary>Where it is in its life: Uninitialized until its first start.</summary>
    public ReadyState ReadyState
    {
        get
        {
            return _life.ReadyState;
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

    /// <summary>The handles of the connections open right now.</summary>
    public IReadOnlyCollection<string> ConnectionHandles
    {
        get
        {
            return [.. _connections.Keys];
        }
    }

    /// <summary>
    /// The connections open right now, in the order they came, as a copy: each what its connection
    /// looked like then, without its socket.
    /// </summary>
    public IReadOnlyList<TransportServerClient> Clients
    {
        get
        {
            return [.. _connections.Values.OrderBy((held) =>
            {
                return held.Arrival;
            }).Select((held) =>
            {
                return held.Client;
            })];
        }
    }

    /// <summary>
    /// What it holds: the connections, counted, and their handles — never to leave the process —
    /// which a server sets its own layers against.
    /// </summary>
    public Gauges Gauges()
    {
        var connectionHandles = _connections.Keys;

        return Bead.Gauges.Of(new Dictionary<string, long> { ["connections"] = connectionHandles.Count }, connectionHandles);
    }

    /// <summary>
    /// Listens, and gives where. Refused with an <see cref="InvalidOperationException"/> unless
    /// Uninitialized or Closed — a second start even while the first is under way; one that fails
    /// ends Closed, ready to start again.
    /// </summary>
    public Task<TransportServerAddress> Start(WebSocketTransportStartOptions? options = null, CancellationToken cancellationToken = default)
    {
        var start = options ?? new WebSocketTransportStartOptions();

        return _life.Start(() =>
        {
            return Starting((start, cancellationToken));
        });
    }

    /// <summary>
    /// Closes every connection with 1001, going away, each within its close timeout and its close
    /// raised, then stops listening; it ends Closed, even when it throws. It settles at once when
    /// Uninitialized or Closed; a second stop, or one from a close listener, shares the stop under
    /// way; one while starting is an <see cref="InvalidOperationException"/>.
    /// </summary>
    public Task Stop()
    {
        return _life.Stop(Stopping);
    }

    // builds its application and starts it; what a failed start built goes with it
    private async Task<TransportServerAddress> Starting((WebSocketTransportStartOptions Start, CancellationToken Token) call)
    {
        var (start, cancellationToken) = call;
        WebApplication? application = null;
        TransportServerAddress bound;

        try
        {
            var builder = WebApplication.CreateSlimBuilder();

            builder.Logging.ClearProviders();
            builder.Services.Configure<HostOptions>((host) =>
            {
                host.ShutdownTimeout = _options.CloseTimeout;
            });
            builder.WebHost.ConfigureKestrel((kestrel) =>
            {
                kestrel.Listen(IPAddress.Parse(start.Address), start.FindOpenPort ? 0 : start.Port);
                kestrel.AddServerHeader = false;
            });
            application = builder.Build();
            Built?.Invoke(application);
            application.UseWebSockets(new WebSocketOptions
            {
                KeepAliveInterval = _options.Heartbeat,
                KeepAliveTimeout = _options.Heartbeat,
            });
            application.Run(Accept);
            await application.StartAsync(cancellationToken);

            var addresses = application.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()
                ?? throw new InvalidOperationException("Kestrel says nothing of where it listens");

            bound = new TransportServerAddress(start.Address, new Uri(addresses.Addresses.First()).Port);
        }
        catch
        {
            if (application is not null)
            {
                await application.DisposeAsync();
            }

            throw;
        }

        _application = application;

        return bound;
    }

    /// <summary>
    /// Closes every connection with 1000, as <see cref="CloseConnection"/> closes one, and gives what
    /// each close gave; none without a connection.
    /// </summary>
    public Task<bool[]> CloseAll()
    {
        return Task.WhenAll(_connections.Keys.Select(CloseConnection));
    }

    /// <summary>
    /// Closes a connection with 1000, within its close timeout, and settles once it is gone, its
    /// close raised; false when it held none by that handle.
    /// </summary>
    public async Task<bool> CloseConnection(string connectionHandle)
    {
        if (!_connections.TryGetValue(connectionHandle, out var held))
        {
            return false;
        }

        await Closing(held, WebSocketCloseStatus.NormalClosure);

        return true;
    }

    /// <summary>As <see cref="Stop"/>: a server's facade stops its transport with it.</summary>
    public Task Shutdown()
    {
        return Stop();
    }

    /// <inheritdoc/>
    public Task Send(TransportMessage message, string connectionHandle)
    {
        // TODO a credential given here is not carried: the router fails a command that presents one
        // its transport cannot carry before it goes, DESTINATION_UNREACHABLE (decision 0010)

        // as the TypeScript side's: what goes to a connection not open goes nowhere, and says nothing,
        // for the router refuses what is for a connection it does not hold itself
        return _connections.TryGetValue(connectionHandle, out var held) && held.Connection.Socket.State == WebSocketState.Open
            ? held.Connection.Send(message.Bytes)
            : Task.CompletedTask;
    }

    /// <summary>As <see cref="Stop"/>.</summary>
    public async ValueTask DisposeAsync()
    {
        await Stop();
    }

    // closes a connection, and settles once the server told its end, as the TypeScript side's close
    // resolves once the server's own close listener ran
    private static async Task Closing(Held held, WebSocketCloseStatus status)
    {
        await held.Connection.Close(status);
        await held.Closed;
    }

    // every connection closed, going away, then its application stopped
    private async Task Stopping()
    {
        try
        {
            var application = Interlocked.Exchange(ref _application, null);

            await Task.WhenAll(_connections.Values.Select((held) =>
            {
                return Closing(held, WebSocketCloseStatus.EndpointUnavailable);
            }));

            if (application is not null)
            {
                try
                {
                    await application.StopAsync();
                }
                finally
                {
                    await application.DisposeAsync();
                }
            }

            Stopped?.Invoke();
        }
        finally
        {
            _connections.Clear();
        }
    }

    // a request: one that upgrades becomes a connection, until its socket closes; none is taken once
    // a stop began
    private async Task Accept(HttpContext context)
    {
        var isStopping = _life.IsStopping;

        if (!context.WebSockets.IsWebSocketRequest || isStopping)
        {
            context.Response.StatusCode = isStopping ? StatusCodes.Status503ServiceUnavailable : StatusCodes.Status426UpgradeRequired;

            return;
        }

        var accepted = await context.WebSockets.AcceptWebSocketAsync();
        var address = context.Connection.RemoteIpAddress;
        var ip = (address is { IsIPv4MappedToIPv6: true } ? address.MapToIPv4() : address)?.ToString() ?? "";
        var port = context.Connection.RemotePort;
        var peerHandle = $"type={TransportTypes.WebSocket};ip={ip};port={port}";
        var (socket, connectionHandle) = Accepted?.Invoke(accepted, peerHandle) ?? (accepted, peerHandle);
        var connection = new WebSocketConnection(socket, (_options.MaximumMessageBytes ?? LimitDefaults.MaximumEnvelopeBytes, _options.CloseTimeout));
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new Held
        {
            Arrival = Interlocked.Increment(ref _arrivals),
            Client = new TransportServerClient(ip, connectionHandle, null, port, TransportTypes.WebSocket),
            Closed = closed.Task,
            Connection = connection,
        };

        _connections[connectionHandle] = held;

        // a listener that throws still leaves the connection's end told, so nothing waits on it forever
        try
        {
            Connection?.Invoke(connectionHandle);
            await connection.Read((message) =>
            {
                held.Client = held.Client with { LastActivity = _clock.GetUtcNow() };
                Message?.Invoke(message, connectionHandle);
            });
        }
        catch (Exception reason) when (reason is WebSocketException or OperationCanceledException or IOException)
        {
            Error?.Invoke(reason, connectionHandle);
        }
        finally
        {
            try
            {
                // a socket whose handle a newer one took closes no connection: the handle names the newer one
                if (_connections.TryRemove(new KeyValuePair<string, Held>(connectionHandle, held)))
                {
                    Close?.Invoke(socket.CloseStatus == WebSocketCloseStatus.NormalClosure, connectionHandle);
                }
            }
            finally
            {
                closed.TrySetResult();
            }
        }
    }

    // a connection as the server holds it: its socket's, its end as the server tells it, the rank it
    // came at, and what Clients shows of it
    private sealed class Held
    {
        public required WebSocketConnection Connection { get; init; }

        public required Task Closed { get; init; }

        public required long Arrival { get; init; }

        // replaced whole at each message, never changed: a reader on another thread takes all of it
        public required volatile TransportServerClient Client;
    }
}
