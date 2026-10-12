using System.Collections.Concurrent;
using System.Globalization;
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

    /// <summary>
    /// What stands in front of it, which it cannot tell (spec 13.4): true for TLS terminated before
    /// it, which makes its connections secure; false for a proxy that serves the network in the
    /// clear, which leaves them in the clear; none to judge by the address it listens on. Believed
    /// whatever it listens on.
    /// </summary>
    public bool? Secure { get; init; }

    /// <summary>
    /// The hosts a request may name besides those every server takes — <c>localhost</c>, a name
    /// under <c>.localhost</c>, an IPv6 address in brackets and an IPv4 address — each a host
    /// without its port, taken on any port, in any ASCII case, in the form the field carries, an IDN
    /// host in punycode, checked before anything else of the request but its authority's form: none
    /// besides when none or empty. A request names its host by its authority: an absolute-form
    /// target's, else its <c>Host</c> (spec 15.12). <c>*</c>, alone, takes every host, an empty one
    /// and none, and so takes a page that rebinds its name to the server's address again: the server
    /// judges its own origin by the request's authority, so this is what refuses one, whatever it
    /// sends. An entry with a port, an empty one, one that is no host, and <c>*</c> beside another
    /// are an <see cref="ArgumentException"/> as the transport is built. A server reached by a name,
    /// a public one, one behind a proxy that keeps the <c>Host</c>, a service reached by its name in
    /// a cluster, names it here, or refuses it 403, <c>host-refused</c>, which the server reports
    /// nowhere and a page's WebSocket cannot read.
    /// </summary>
    public IReadOnlyList<string>? Hosts { get; init; }

    /// <summary>
    /// The origins an upgrade that sends an <c>Origin</c> may come from besides the server's own,
    /// <c>http://</c> or <c>https://</c> followed by its request's authority, each compared exactly,
    /// checked once its version and its form are a handshake's: none by default. <c>null</c> among
    /// them takes every upgrade that sends it. No same-origin policy guards an upgrade, so a page of
    /// an origin named here is served outright. Each is <c>null</c> or an origin as RFC 6454 §6.2
    /// serializes it; <c>*</c>, which no origin is, and any other entry are an
    /// <see cref="ArgumentException"/> as the transport is built.
    /// </summary>
    public IReadOnlyList<string> Origins { get; init; } = [];
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
/// and starts again once Closed. A request it does not upgrade it refuses in the order spec 15.2
/// states, each refusal of its own marked as <see cref="WebSocketRefusals"/> names it: a host not
/// taken, 403; a method but GET or HEAD, 405; a request that asks no WebSocket, or a version but
/// 13, 426; a malformed upgrade, 400; an origin not taken, 403; and, once its stop began, one it
/// would take, 503, busy.
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

    // whether its connections are secure: as its application says what stands in front of it, or,
    // when it says nothing, bound to the loopback as it starts, since it takes no TLS of its own
    private volatile bool _isSecure;
    // how many connections came, which ranks each: the dictionary keeps no order
    private long _arrivals;
    // how its events are told: what a listener throws is reported through Error, with its connection
    private readonly ListenerGuard _listeners;

    /// <summary>
    /// A transport server, not yet listening, its heartbeat and close timeout held: one no timer
    /// holds is an <see cref="ArgumentOutOfRangeException"/>; an entry of its hosts or origins
    /// neither takes, an <see cref="ArgumentException"/> naming it.
    /// </summary>
    public WebSocketTransportServer(WebSocketTransportServerOptions? options = null)
    {
        var given = options ?? new WebSocketTransportServerOptions();

        HostsAndOrigins.AssertHosts(given.Hosts, nameof(WebSocketTransportServerOptions.Hosts));
        HostsAndOrigins.AssertOrigins(given.Origins, nameof(WebSocketTransportServerOptions.Origins));
        _options = given with
        {
            Heartbeat = WebSocketConnection.AssertHeartbeat(given.Heartbeat, nameof(WebSocketTransportServerOptions.Heartbeat)),
            CloseTimeout = WebSocketConnection.AssertCloseTimeout(given.CloseTimeout, nameof(WebSocketTransportServerOptions.CloseTimeout)),
        };
        _clock = _options.Clock ?? TimeProvider.System;
        _isSecure = _options.Secure ?? false;
        _listeners = new ListenerGuard((reason, connectionHandle) =>
        {
            Error?.Invoke(reason, connectionHandle ?? "");
        });
    }

    /// <inheritdoc/>
    public event Action<string>? Connection;

    /// <inheritdoc/>
    public event Action<TransportMessage, string>? Message;

    /// <inheritdoc/>
    public event Action<bool, string>? Close;

    /// <summary>
    /// What went wrong on a connection, with its handle: its socket's failure, or what a listener of
    /// its events threw, the transport going on as if it returned (spec 15.1). Never the server's
    /// own, with an empty handle, as the TypeScript side's can be: Kestrel tells a failure after it
    /// listens only to its logs.
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

                // * an origin server MUST take an absolute-form target's authority over its Host (RFC
                // 9112 §3.2.2), where Kestrel refuses 400 a Host that differs from it by default
                kestrel.AllowHostHeaderOverride = true;
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
            _isSecure = _options.Secure ?? TransportSecurity.IsSecure((false, start.Address));
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

    /// <summary>
    /// A WebSocket carries no credential beside an envelope (spec 15.2): a command presenting
    /// <see cref="CredentialScheme.Elsewhere"/> fails before it goes.
    /// </summary>
    public bool CarriesCredential(string connectionHandle)
    {
        return false;
    }

    /// <summary>
    /// Whether a connection is secure (spec 13.4): as <see cref="WebSocketTransportServerOptions.Secure"/>
    /// says, when given; otherwise judged from its listener, never from what a name resolves to,
    /// bound to a loopback address, since it takes no TLS of its own.
    /// </summary>
    public bool IsSecure(string connectionHandle)
    {
        return _isSecure;
    }

    /// <inheritdoc/>
    public Task Send(TransportMessage message, string connectionHandle)
    {
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

    // a refusal written: its status, its fields, its mark when it has one, its date from the
    // server's clock, and an empty body whose length is written, a HEAD's as its GET's would be
    private void Refuse(HttpResponse response, HandshakeRefusal refusal)
    {
        response.StatusCode = refusal.Status;

        foreach (var (name, value) in refusal.Fields)
        {
            response.Headers[name] = value;
        }

        if (refusal.Refusal is { } reason)
        {
            response.Headers[HostsAndOrigins.RefusalHeader] = reason;
        }

        // ! Kestrel keeps the date and the length the application writes: without the length it
        // leaves it out of a HEAD's answer
        response.Headers.Date = _clock.GetUtcNow().ToString("r", CultureInfo.InvariantCulture);
        response.ContentLength = 0;
    }

    // a request: one that upgrades becomes a connection, until its socket closes; any other is
    // refused in the order spec 15.2 states, the connection going with the refusal, as the
    // TypeScript side's does, and one it would take once a stop began is refused busy
    private async Task Accept(HttpContext context)
    {
        if (WebSocketHandshake.RefusalOf(context.Request, _options) is { } refusal)
        {
            Refuse(context.Response, refusal);

            return;
        }

        // ! a guard: what the judgement takes Kestrel upgrades, and its accept throws on any other
        if (!context.WebSockets.IsWebSocketRequest)
        {
            Refuse(context.Response, WebSocketHandshake.Malformed);

            return;
        }

        if (_life.IsStopping)
        {
            Refuse(context.Response, WebSocketHandshake.Busy);

            return;
        }

        var accepted = await context.WebSockets.AcceptWebSocketAsync();
        var address = context.Connection.RemoteIpAddress;
        var ip = (address is { IsIPv4MappedToIPv6: true } ? address.MapToIPv4() : address)?.ToString() ?? "";
        var port = context.Connection.RemotePort;
        var peerHandle = $"type={TransportTypes.WebSocket};ip={ip};port={port}";
        var (socket, connectionHandle) = Accepted?.Invoke(accepted, peerHandle) ?? (accepted, peerHandle);
        var connection = new WebSocketConnection(socket, (MaximumMessageBytes, _options.CloseTimeout));
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new Held
        {
            Arrival = Interlocked.Increment(ref _arrivals),
            Client = new TransportServerClient(ip, connectionHandle, null, port, TransportTypes.WebSocket),
            Closed = closed.Task,
            Connection = connection,
        };

        _connections[connectionHandle] = held;

        // ! a stop that began as this registered, past its snapshot, closes it with its own, going
        // away: its close is sent on its own, the read below driving the handshake to its end, and
        // the host's stop waits on this request until it ends, within its shutdown timeout
        if (_life.IsStopping)
        {
            _ = connection.CloseQuietly(WebSocketCloseStatus.EndpointUnavailable);
        }

        try
        {
            _listeners.Tell(Connection, connectionHandle);
            await connection.Read((message) =>
            {
                held.Client = held.Client with { LastActivity = _clock.GetUtcNow() };
                _listeners.Tell(Message, (message, connectionHandle));
            });
        }
        catch (Exception reason) when (reason is WebSocketException or OperationCanceledException or IOException)
        {
            Error?.Invoke(reason, connectionHandle);
        }
        finally
        {
            // its end told however its read went: nothing it holds, the write pump or a close, waits
            // on it forever
            connection.End();

            try
            {
                // a socket whose handle a newer one took closes no connection: the handle names the newer one
                if (_connections.TryRemove(new KeyValuePair<string, Held>(connectionHandle, held)))
                {
                    _listeners.Tell(Close, (socket.CloseStatus == WebSocketCloseStatus.NormalClosure, connectionHandle));
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
