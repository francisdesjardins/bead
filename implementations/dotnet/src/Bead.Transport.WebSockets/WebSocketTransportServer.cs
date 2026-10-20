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
    /// and none, and makes none of their origins its own: the server's own origin is its request's
    /// authority only when its host is taken by name, one every server takes or one listed here, so
    /// under <c>*</c> a page that rebinds its name to the server's address is refused 403,
    /// <c>origin-refused</c>, and a page of the application's own is taken only when
    /// <see cref="Origins"/> names it. An entry with a port, an empty one, one that is no host, and <c>*</c> beside another
    /// are an <see cref="ArgumentException"/> as the transport is built. A server reached by a name,
    /// a public one, one behind a proxy that keeps the <c>Host</c>, a service reached by its name in
    /// a cluster, names it here, or refuses it 403, <c>host-refused</c>, which a page's WebSocket
    /// cannot read and the transport tells through <see cref="WebSocketTransportServer.Refusal"/>.
    /// </summary>
    public IReadOnlyList<string>? Hosts { get; init; }

    /// <summary>
    /// The origins an upgrade that sends an <c>Origin</c> may come from besides the server's own,
    /// <c>http://</c> or <c>https://</c> followed by its request's authority when its host is taken
    /// by name, never by <c>*</c>, each compared exactly,
    /// checked once its version and its form are a handshake's: none by default. No same-origin
    /// policy guards an upgrade, so a page of an origin named here is served outright. A WebSocket
    /// answers no CORS, which no browser asks of an upgrade. Each is an origin as RFC 6454 §6.2
    /// serializes it; <c>*</c>, which no origin is, <c>null</c>, which a browser sends for every page
    /// with no origin of its own, a sandboxed frame of any site among them, and any other entry are
    /// an <see cref="ArgumentException"/> as the transport is built.
    /// </summary>
    public IReadOnlyList<string> Origins { get; init; } = [];

    /// <summary>
    /// The proxies it believes an upgrade's <c>X-Forwarded-For</c> from (spec 15.12): none by
    /// default, the loopback among them. Each is an IP address written bare, as a server listens on
    /// one, or a network, that address, <c>/</c> and its prefix's length (RFC 4632 §3.1, RFC 4291
    /// §2.3), from 1, its bits past the prefix zero: <c>10.0.0.0/8</c>, or a compose network's, for a
    /// proxy in a container or an ingress; <c>127.0.0.1</c> for one on this machine. A name, a
    /// network of prefix 0, which would trust what every client writes, and any other entry are an
    /// <see cref="ArgumentException"/> as the transport is built. While the address reached is one
    /// they hold, the next entry of the field from the right is the client's, when it is an address,
    /// bare or in RFC 7239 §6's node forms, its port dropped; any other entry ends the walk, so what a
    /// client wrote to the left of its own proxy is never read. No <c>Forwarded</c> is read. The
    /// client's address so read names its connection, <c>ip=</c> in its handle, and its refusals; its
    /// port is the socket's, the nearest proxy's connection's behind one. A proxy it neither names
    /// nor counts (<see cref="UnnamedProxies"/>) is a client as any other: every client behind it is
    /// named by its address.
    /// </summary>
    public IReadOnlyList<string>? TrustedProxies { get; init; }

    /// <summary>
    /// How many proxies on every path to it <see cref="TrustedProxies"/> does not name (spec 15.12):
    /// one each for a proxy whose addresses its platform does not publish, a PaaS router among them;
    /// a proxy whose addresses are published — Google Cloud's global load balancer, Cloudflare, an
    /// AWS ALB's VPC — is named, never counted. From 0, by default, to 8; any other is an
    /// <see cref="ArgumentOutOfRangeException"/> as the transport is built. The walk spends one on an
    /// address the list does not hold, none on one it holds, wherever it stands, and stops where
    /// neither remains: unlike a count of every hop, Envoy's <c>xff_num_trusted_hops</c> or
    /// Express's <c>trust proxy</c> n, a proxy both named and counted gives the client an entry it
    /// wrote. A count is believed as told: a request that reaches the server by a path with fewer
    /// such proxies, straight to its socket or past one it counts, is read by entries its client
    /// wrote, so a server so reachable names its proxies instead.
    /// </summary>
    public int UnnamedProxies { get; init; }

    /// <summary>
    /// The connections it holds at once, an upgrade taking its place as it is judged, before its
    /// handshake completes: 10,000 by default; past them, an upgrade is refused 503, <c>busy</c>
    /// (spec 15.2, step 8). A whole number above 0; any other is an
    /// <see cref="ArgumentOutOfRangeException"/> as the transport is built.
    /// </summary>
    public int MaximumConnections { get; init; } = 10_000;

    /// <summary>
    /// The connections one address holds at once, the client's address read as
    /// <see cref="TrustedProxies"/> says: 64 by default; past them, an upgrade is refused 503,
    /// <c>busy</c> (spec 15.2, step 8; 15.12). Behind a proxy it neither names nor counts, every
    /// client is the proxy's address, and the 65th is refused. A whole number above 0; any other is
    /// an <see cref="ArgumentOutOfRangeException"/> as the transport is built.
    /// </summary>
    public int MaximumConnectionsPerAddress { get; init; } = 64;

    /// <summary>
    /// The slowest a client may take what waits for its socket, in bytes a second, once
    /// <see cref="SendGracePeriod"/> passed: 240 by default, Kestrel's <c>MinResponseDataRate</c>
    /// (spec 15.12). Each envelope of <i>S</i> bytes moves the connection's deadline to the later of
    /// now plus the longer of the grace and <i>S</i> at this rate, and the deadline before plus
    /// <i>S</i> at this rate; a socket that still holds anything past it, checked each second, drops
    /// the connection, its close unclean, reported through
    /// <see cref="WebSocketTransportServer.Error"/> naming the bound. 0 holds none, on a network the
    /// application trusts; below 0 is an <see cref="ArgumentOutOfRangeException"/> as the transport is
    /// built. On the real clock, as what it bounds is the platform's socket.
    /// </summary>
    public int MinimumSendBytesPerSecond { get; init; } = ServerBounds.MinimumSendBytesPerSecond;

    /// <summary>
    /// The least time an envelope is given to be taken by its socket: 5 seconds by default; from 1
    /// to 2³¹ − 1 milliseconds, rounded to the nearest whole one; zero and infinite are refused (spec
    /// 15.12). On the real clock.
    /// </summary>
    public TimeSpan SendGracePeriod { get; init; } = ServerBounds.SendGracePeriod;

    /// <summary>
    /// What waits for a client's socket at most, in bytes: an envelope that would take it past this
    /// drops the connection, its close unclean, reported through
    /// <see cref="WebSocketTransportServer.Error"/> naming the bound (spec 15.12). A backstop above
    /// what a peer that keeps every rule can be owed at once — the answers to the calls it has
    /// answered, the server's commands to it, the transfers it receives, two envelopes of the
    /// server's own — which a server's facade draws from its router's limits; a transport built
    /// alone takes the default limits', 184,551,424. A whole number above 0; any other is an
    /// <see cref="ArgumentOutOfRangeException"/> as the transport is built.
    /// </summary>
    public long? MaximumUnsentBytes { get; init; }

    /// <summary>
    /// How long an upgrade's head may take to come whole: 30 seconds by default, Kestrel's
    /// <c>RequestHeadersTimeout</c>, which holds it and answers 408, unmarked, on its heartbeat, past
    /// it and within 2 seconds of it (spec 15.12). From 1 to 2³¹ − 1 milliseconds, rounded to the
    /// nearest whole one; zero and infinite are refused. On the real clock, as the platform's parser
    /// holds it.
    /// </summary>
    public TimeSpan HeadersTimeout { get; init; } = ServerBounds.HeadersTimeout;
}

/// <summary>Where a transport server listens.</summary>
public sealed record WebSocketTransportStartOptions
{
    /// <summary>
    /// The address it listens on (spec 15.12): <c>localhost</c> by default, both loopbacks,
    /// <c>127.0.0.1</c> and <c>::1</c> on one port, as Kestrel's <c>ListenLocalhost</c> binds them, so
    /// no other process answers a client that reaches it by <c>localhost</c> on the other family; a
    /// port another socket holds on either fails the start, and a port drawn is drawn again, eight
    /// times at most. Where the IPv6 loopback is absent it listens on <c>127.0.0.1</c> alone, and
    /// reports it. Or an IP address written bare, which it listens on alone: <c>0.0.0.0</c> or
    /// <c>::</c> for every interface, which a container, or any server another machine reaches,
    /// needs, its hosts named beside. RFC 3986's <c>IPv4address</c> or <c>IPv6address</c>, with no
    /// brackets, no zone, and not IPv4-mapped; another name or any other form is an
    /// <see cref="ArgumentException"/> as it starts, which ends Closed.
    /// </summary>
    public string Address { get; init; } = Loopbacks.Localhost;

    /// <summary>The port it listens on.</summary>
    public int Port { get; init; } = 80;

    /// <summary>Whether it takes any free port instead.</summary>
    public bool FindOpenPort { get; init; }
}

/// <summary>
/// A transport server over WebSocket connections, on Kestrel: one envelope per binary message, a
/// connection named <c>type=WS;ip=…;port=…;ordinal=…</c>, by its client's address, read past the
/// proxies it trusts (<see cref="WebSocketTransportServerOptions.TrustedProxies"/>), its peer's port
/// and the rank it was taken at, from 1, never reset, so no handle is given twice (spec 15.1); a
/// client over IPv4 to a dual-stack listener named by its IPv4 address; each pinged every <see
/// cref="WebSocketTransportServerOptions.Heartbeat"/>. A text message is delivered as text, which
/// a router reports. What goes out to one connection goes in order, one message at a time. It goes
/// from <see cref="ReadyState.Uninitialized"/> through Connecting and Open to Closing and Closed,
/// and starts again once Closed. A request it does not upgrade it refuses in the order spec 15.2
/// states, each refusal of its own marked as <see cref="WebSocketRefusals"/> names it: a host not
/// taken, 403; a method but GET or HEAD, 405; a request that asks no WebSocket, or a version but
/// 13, 426; a malformed upgrade, 400; an origin not taken, 403; and, past its connections in all
/// or of its address, or once its stop began, one it would take, 503, busy. An upgrade that carries no <c>Origin</c> carries its <c>Authorization</c>,
/// trimmed, beside every envelope of its connection, which a request presenting
/// <see cref="CredentialScheme.Elsewhere"/> stands for (spec 15.2); one that carries an
/// <c>Origin</c>, a page's, carries none; nothing is carried toward a client.
/// </summary>
public sealed class WebSocketTransportServer : IServerTransport, IAsyncDisposable
{
    private readonly WebSocketTransportServerOptions _options;
    private readonly TimeProvider _clock;
    // the networks of the proxies it believes X-Forwarded-For from
    private readonly ProxyTrust _proxyTrust;
    // each connection, and its end as the server tells it: gone from the handles, its close raised
    private readonly ConcurrentDictionary<string, Held> _connections = new();
    // its ready state, and the guards around its start and its stop, as every transport server's
    private readonly TransportServerLife _life = new();
    private WebApplication? _application;

    // whether its connections are secure: as its application says what stands in front of it, or,
    // when it says nothing, bound to the loopback as it starts, since it takes no TLS of its own
    private volatile bool _isSecure;
    // how many connections were taken, which ranks each, its handle by it: the dictionary keeps no order
    private long _arrivals;
    // how its events are told: what a listener throws is reported through Error, with its connection
    private readonly ListenerGuard _listeners;

    // the places its connections hold, in all and by address, each taken as its upgrade is judged and
    // given back as its connection ends; touched under the lock
    private readonly Lock _gate = new();
    private readonly Dictionary<string, int> _perAddress = [];
    private int _places;

    /// <summary>
    /// A transport server, not yet listening, its heartbeat and close timeout held: one no timer
    /// holds is an <see cref="ArgumentOutOfRangeException"/>; an entry of its hosts, origins or
    /// trusted proxies none takes, an <see cref="ArgumentException"/> naming it.
    /// </summary>
    public WebSocketTransportServer(WebSocketTransportServerOptions? options = null)
    {
        var given = options ?? new WebSocketTransportServerOptions();

        ServerBounds.AssertCount((nameof(WebSocketTransportServerOptions.MaximumConnections), given.MaximumConnections));
        ServerBounds.AssertCount((nameof(WebSocketTransportServerOptions.MaximumConnectionsPerAddress), given.MaximumConnectionsPerAddress));
        ServerBounds.AssertCountOrNone((nameof(WebSocketTransportServerOptions.MinimumSendBytesPerSecond), given.MinimumSendBytesPerSecond));
        ServerBounds.AssertCount((nameof(WebSocketTransportServerOptions.MaximumUnsentBytes), given.MaximumUnsentBytes ?? 1));
        HostsAndOrigins.AssertHosts(given.Hosts, nameof(WebSocketTransportServerOptions.Hosts));
        HostsAndOrigins.AssertOrigins(given.Origins, nameof(WebSocketTransportServerOptions.Origins));
        _proxyTrust = Bead.TrustedProxies.TrustOf(
            (given.TrustedProxies, nameof(WebSocketTransportServerOptions.TrustedProxies)),
            (given.UnnamedProxies, nameof(WebSocketTransportServerOptions.UnnamedProxies)));
        _options = given with
        {
            Heartbeat = WebSocketConnection.AssertHeartbeat(given.Heartbeat, nameof(WebSocketTransportServerOptions.Heartbeat)),
            CloseTimeout = WebSocketConnection.AssertCloseTimeout(given.CloseTimeout, nameof(WebSocketTransportServerOptions.CloseTimeout)),

            // ! never refused: what waits for a socket, and a head, bounded by nothing would hold
            // their socket for ever (spec 15.12)
            SendGracePeriod = Clocks.AssertHeldFinite(
                (nameof(WebSocketTransportServerOptions.SendGracePeriod), nameof(WebSocketTransportServerOptions.SendGracePeriod)),
                given.SendGracePeriod),
            HeadersTimeout = Clocks.AssertHeldFinite(
                (nameof(WebSocketTransportServerOptions.HeadersTimeout), nameof(WebSocketTransportServerOptions.HeadersTimeout)),
                given.HeadersTimeout),
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
    /// Each refusal it judges of its own at its address (spec 15.1), every one an upgrade's as it
    /// arrives, in the order spec 15.2 states, a stop's 503 among them, each marked; never what HTTP
    /// refuses of its own, unmarked. Told as the refusal is written, and built only when a listener
    /// listens.
    /// </summary>
    public event Action<TransportServerRefusal>? Refusal;

    /// <summary>
    /// What went wrong on a connection, with its handle: a protocol error on it, before its
    /// <see cref="Close"/>; a bound it is dropped behind; or what a listener of its events threw, the
    /// transport going on as if it returned (spec 15.1). Never a peer that drops without its closing
    /// handshake, its TCP connection ended or reset, which its unclean <see cref="Close"/> tells. With
    /// an empty handle for a throw of a <see cref="Refusal"/> listener alone, which names no
    /// connection; never the server's own failure, as the TypeScript side's can be: Kestrel tells a
    /// failure after it listens only to its logs.
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
    /// What a connection is made of, from the socket accepted and the handle drawn for it: the
    /// tests' way to give one a socket of theirs.
    /// </summary>
    internal Func<WebSocket, string, (WebSocket Socket, string ConnectionHandle)>? Accepted { get; init; }

    /// <summary>
    /// How a start on <c>localhost</c> draws its port and binds the IPv6 loopback: the tests' way to
    /// draw a port another socket holds there, and to start where it is absent.
    /// </summary>
    internal LoopbackBinding Loopback { get; init; } = new();

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
    /// What waits for a client's socket at most: the option given, or what a peer that keeps every
    /// rule can be owed at once under the default limits, which a transport built alone takes.
    /// </summary>
    internal long MaximumUnsentBytes
    {
        get
        {
            return _options.MaximumUnsentBytes ?? UnsentBytesOf(RouterLimits.Default);
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
    /// What it holds, at the ceilings it has: the connections, counted, and the connections the
    /// busiest address holds, which its health warns on before a proxy it was not told of is refused
    /// <c>busy</c>; and their handles — never to leave the process — which a server sets its own
    /// layers against.
    /// </summary>
    public Gauges Gauges()
    {
        var connectionHandles = _connections.Keys;
        long largest;

        lock (_gate)
        {
            largest = _perAddress.Values.DefaultIfEmpty().Max();
        }

        var unsent = _connections.Values.Select((held) =>
        {
            return held.Connection.UnsentBytes;
        }).ToList();

        return Bead.Gauges.Of(
            new Dictionary<string, long>
            {
                ["connections"] = connectionHandles.Count,
                ["largestAddressConnections"] = largest,
                ["largestUnsentBytes"] = unsent.DefaultIfEmpty().Max(),
                ["unsentBytes"] = unsent.Sum(),
            },
            connectionHandles) with
        {
            Ceilings = new Dictionary<string, long>
            {
                ["connections"] = _options.MaximumConnections,
                ["largestAddressConnections"] = _options.MaximumConnectionsPerAddress,
                ["largestUnsentBytes"] = MaximumUnsentBytes,
            },
        };
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

    // listens where it is told, localhost on both loopbacks, and gives where
    private async Task<TransportServerAddress> Starting((WebSocketTransportStartOptions Start, CancellationToken Token) call)
    {
        var (start, cancellationToken) = call;

        // ! an IP address by RFC 3986's grammar before the platform's parser reads it: it takes 0 for
        // 0.0.0.0, every interface, and 127.1, octal, hexadecimal and a zone besides
        HostsAndOrigins.AssertAddress(start.Address, nameof(WebSocketTransportStartOptions.Address));

        var ((application, port), address) = start.Address == Loopbacks.Localhost
            ? await Loopbacks.Bind(
                (listening) =>
                {
                    return Serving(listening, cancellationToken);
                },
                Loopback with { Port = start.Port, FindOpenPort = start.FindOpenPort })
            : (await Serving(([IPAddress.Parse(start.Address)], start.FindOpenPort ? 0 : start.Port), cancellationToken), start.Address);

        _isSecure = _options.Secure ?? TransportSecurity.IsSecure((false, address));
        _application = application;

        return new TransportServerAddress(address, port);
    }

    // builds an application on the addresses and the port given and starts it, and gives the port
    // it listens on; what a failed start built goes with it
    private async Task<(WebApplication Application, int Port)> Serving((IReadOnlyList<IPAddress> Addresses, int Port) listening, CancellationToken cancellationToken)
    {
        WebApplication? application = null;

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
                foreach (var address in listening.Addresses)
                {
                    kestrel.Listen(address, listening.Port);
                }

                kestrel.AddServerHeader = false;

                // * an origin server MUST take an absolute-form target's authority over its Host (RFC
                // 9112 §3.2.2), where Kestrel refuses 400 a Host that differs from it by default
                kestrel.AllowHostHeaderOverride = true;

                // * a head is the platform's parser's, which no Bead code sees until it is whole:
                // answered 408 on Kestrel's heartbeat, which arms its deadline a heartbeat late, a
                // connection's first head 1 to 2 seconds past its time (spec 15.12)
                kestrel.Limits.RequestHeadersTimeout = _options.HeadersTimeout;
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

            return (application, new Uri(addresses.Addresses.First()).Port);
        }
        catch
        {
            if (application is not null)
            {
                await application.DisposeAsync();
            }

            throw;
        }
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
    /// Nothing is carried toward a client (spec 15.2): a command presenting
    /// <see cref="CredentialScheme.Elsewhere"/> fails before it goes. What its upgrade carried goes
    /// the other way alone, beside every envelope its client sends.
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

    /// <summary>
    /// What a peer that keeps every rule can be owed at once on a connection under
    /// <paramref name="limits"/> (spec 15.12): the answers to the calls it has answered, each of a
    /// chunk, the server's own commands to it, as many, the transfers it receives, each a window, and
    /// two envelopes of the server's own besides, as an HTTP outbox holds.
    /// </summary>
    internal static long UnsentBytesOf(RouterLimits limits)
    {
        return (2L * limits.MaximumAnsweringCalls * limits.ChunkBytes) + ((long)limits.MaximumTransfers * limits.WindowBytes) + (2L * limits.MaximumEnvelopeBytes);
    }


    // * a place taken as an upgrade is judged, before its handshake completes, under the lock, so
    // upgrades that cross take no more places than are left; none past either bound, nor once a stop
    // began (spec 15.2, step 8)
    private bool TakePlace(string address)
    {
        lock (_gate)
        {
            if (_life.IsStopping || _places >= _options.MaximumConnections || _perAddress.GetValueOrDefault(address) >= _options.MaximumConnectionsPerAddress)
            {
                return false;
            }

            _places += 1;
            _perAddress[address] = _perAddress.GetValueOrDefault(address) + 1;

            return true;
        }
    }

    // a place given back, as its upgrade failed or its connection ended
    private void GivePlaceBack(string address)
    {
        lock (_gate)
        {
            _places -= 1;

            if (_perAddress[address] == 1)
            {
                _perAddress.Remove(address);
            }
            else
            {
                _perAddress[address] -= 1;
            }
        }
    }

    // the client's address, in its one form: the socket's, walked past each proxy it trusts through
    // the upgrade's X-Forwarded-For, its lines joined by commas, from the right
    private string? AddressOf(HttpContext context)
    {
        if (context.Connection.RemoteIpAddress is not { } remote)
        {
            return null;
        }

        var forwarded = context.Request.Headers["x-forwarded-for"];

        return Bead.TrustedProxies.ClientAddressOf(remote, (forwarded.Count == 0 ? null : forwarded.ToString(), _proxyTrust));
    }

    // a refusal written: its status, its fields, its mark when it has one, its date from the
    // server's clock, and an empty body whose length is written, a HEAD's as its GET's would be;
    // then, marked, told (spec 15.1)
    private void Refuse(HttpContext context, HandshakeRefusal refusal)
    {
        var response = context.Response;

        response.StatusCode = refusal.Status;

        foreach (var (name, value) in refusal.Fields)
        {
            response.Headers[name] = value;
        }

        if (refusal.Refusal is { } mark)
        {
            response.Headers[HostsAndOrigins.RefusalHeader] = mark;
        }

        // ! Kestrel keeps the date and the length the application writes: without the length it
        // leaves it out of a HEAD's answer
        response.Headers.Date = _clock.GetUtcNow().ToString("r", CultureInfo.InvariantCulture);
        response.ContentLength = 0;

        // * built only when a listener listens
        if (refusal.Refusal is { } reason && Refusal is { } listeners)
        {
            var (authority, origin) = WebSocketHandshake.ToldOf(context.Request);
            var told = new TransportServerRefusal(
                AddressOf(context),
                authority,
                origin,
                context.Connection.RemotePort,
                reason,
                refusal.Status);

            _listeners.Tell(listeners, told);
        }
    }

    // a request: one that upgrades becomes a connection, until its socket closes; any other is
    // refused in the order spec 15.2 states, the connection going with the refusal, as the
    // TypeScript side's does, and one it would take once a stop began is refused busy
    private async Task Accept(HttpContext context)
    {
        if (WebSocketHandshake.RefusalOf(context.Request, _options) is { } refusal)
        {
            Refuse(context, refusal);

            return;
        }

        // ! a guard: what the judgement takes Kestrel upgrades, and its accept throws on any other
        if (!context.WebSockets.IsWebSocketRequest)
        {
            Refuse(context, WebSocketHandshake.Malformed);

            return;
        }

        var address = AddressOf(context);
        var ip = address ?? "";

        if (!TakePlace(ip))
        {
            Refuse(context, WebSocketHandshake.Busy);

            return;
        }

        try
        {
            await Upgrade(context, (address, ip));
        }
        finally
        {
            GivePlaceBack(ip);
        }
    }

    // an upgrade judged and given its place: its connection, until its socket closes
    private async Task Upgrade(HttpContext context, (string? Address, string Ip) client)
    {
        var (address, ip) = client;

        // ! an upgrade that carries an Origin is a page's, whose browser writes its own
        // authentication on it as it sends its cookies (Fetch, credentials mode include): it carries
        // none, whatever its Authorization; one from no page carries its Authorization beside every
        // envelope of its connection (spec 15.2)
        var headers = context.Request.Headers;
        var credential = headers.Origin.Count == 0 ? HostsAndOrigins.CredentialOf(headers.Authorization) : null;
        var accepted = await context.WebSockets.AcceptWebSocketAsync();
        var port = context.Connection.RemotePort;

        // * the handle drawn as the connection is taken, by the rank it came at: the client's
        // address and the peer's port, which another connection may share (RFC 9293 §3.4.1), never
        // name it alone, and its port ties it to the network's records
        var arrival = Interlocked.Increment(ref _arrivals);
        var drawnHandle = $"type={TransportTypes.WebSocket};ip={ip};port={port};ordinal={arrival}";
        var (socket, connectionHandle) = Accepted?.Invoke(accepted, drawnHandle) ?? (accepted, drawnHandle);
        var connection = new WebSocketConnection(socket, new WebSocketConnection.Bounds
        {
            MaximumMessageBytes = MaximumMessageBytes,
            CloseTimeout = _options.CloseTimeout,
            Pace = new WebSocketConnection.Pacing
            {
                MinimumSendBytesPerSecond = _options.MinimumSendBytesPerSecond,
                SendGracePeriod = _options.SendGracePeriod,
                MaximumUnsentBytes = MaximumUnsentBytes,
                Dropped = (bound) =>
                {
                    // * reported before its close, naming the bound it is dropped behind (RFC 6455
                    // §7.1.7, "SHOULD log")
                    Error?.Invoke(new IOException($"{connectionHandle} is dropped behind its {bound}"), connectionHandle);
                },
            },
        });
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new Held
        {
            Arrival = arrival,
            Client = new TransportServerClient(ip, connectionHandle, null, port, TransportTypes.WebSocket),
            Closed = closed.Task,
            Connection = connection,
        };

        // ! no handle is given twice: one already held is a bug of the draw, and the socket goes
        if (!_connections.TryAdd(connectionHandle, held))
        {
            socket.Abort();

            throw new InvalidOperationException($"the handle {connectionHandle} names a connection already held");
        }

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
                // * each envelope with its credential, and the address and port of its connection (spec 15.1)
                _listeners.Tell(Message, (message with { Credential = credential, Address = address, Port = port }, connectionHandle));
            });
        }
        catch (Exception reason) when (reason is WebSocketException or OperationCanceledException or IOException)
        {
            // a socket dropped behind a bound was reported as it was: its abort says nothing more
            if (!connection.IsDropped && !IsPeerGone(reason))
            {
                Error?.Invoke(reason, connectionHandle);
            }
        }
        finally
        {
            // its end told however its read went: nothing it holds, the write pump or a close, waits
            // on it forever
            connection.End();

            try
            {
                // a connection the registry no longer holds tells no close: the stop's clear took it
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

    // ! a peer gone without its closing handshake, its TCP connection ended or reset, is no error on
    // its connection: its unclean close tells it, as the TypeScript side's does. .NET 10 raises each
    // as ConnectionClosedPrematurely, nothing inside it, on Windows as on Linux; a protocol error as
    // Faulted, which is told
    private static bool IsPeerGone(Exception reason)
    {
        return reason is WebSocketException { WebSocketErrorCode: WebSocketError.ConnectionClosedPrematurely };
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
