using System.Buffers.Binary;
using System.Buffers.Text;
using System.Globalization;
using System.IO.Pipelines;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Bead.Transport.Http;

/// <summary>How an HTTP transport server holds its connections, and what it bounds.</summary>
public sealed record HttpTransportServerOptions
{
    private readonly long _bodyBytesBudget = 268_435_456;

    /// <summary>The bytes of body the exchanges under way may hold together: 256 MiB by default; past it, 503.</summary>
    public long BodyBytesBudget
    {
        get
        {
            return _bodyBytesBudget;
        }
        init
        {
            _bodyBytesBudget = value;
            _given |= HttpPolicyMembers.BodyBytesBudget;
        }
    }

    /// <summary>
    /// How long a request handed on waits for its answer: 5 minutes by default; from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one, or infinite
    /// for none; zero is refused.
    /// </summary>
    public TimeSpan ExchangeTimeout { get; init; } = TimeSpan.FromMinutes(5);

    private readonly IReadOnlyList<string>? _hosts;

    /// <summary>
    /// The hosts a request may name besides those every server takes — <c>localhost</c>, a name
    /// under <c>.localhost</c>, an IPv6 address in brackets and an IPv4 address — each a host
    /// without its port, taken on any port, in any ASCII case, in the form the field carries, an IDN
    /// host in punycode: none besides when none or empty. A request names its host by its
    /// authority: an absolute-form target's, else its <c>Host</c>, which carries HTTP/2's
    /// <c>:authority</c> (spec 15.12). <c>*</c>, alone, takes every host, an empty one and none,
    /// but over HTTP/2 a request with neither <c>:authority</c> nor <c>host</c>, whose stream is
    /// reset, <c>PROTOCOL_ERROR</c>, under any hosts (RFC 9113 §8.3.1),
    /// and makes none of their origins its own: the server's own origin is its request's authority
    /// only when its host is taken by name, one every server takes or one listed here, so under
    /// <c>*</c> a page that rebinds its name to the server's address is refused 403,
    /// <c>origin-refused</c>, and a page of the application's own is taken only when
    /// <see cref="Origins"/> names it. An entry with a port, an empty one, one that is no host, and <c>*</c> beside another are an
    /// <see cref="ArgumentException"/> as the transport is built. A server reached by a name, a
    /// public one, one behind a proxy that keeps the <c>Host</c>, a service reached by its name in a
    /// cluster, names it here, or refuses it 403, <c>host-refused</c>, which the transport tells
    /// through <see cref="HttpTransportServer.Refusal"/>.
    /// </summary>
    public IReadOnlyList<string>? Hosts
    {
        get
        {
            return _hosts;
        }
        init
        {
            _hosts = value;

            // null is none given, as an option left out is
            if (value is not null)
            {
                _given |= HttpPolicyMembers.Hosts;
            }
        }
    }

    /// <summary>
    /// How long a connection may go with no exchange under way: 5 minutes by default; from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one, or infinite
    /// for none; zero is refused.
    /// </summary>
    public TimeSpan InactivityTimeout { get; init; } = TimeSpan.FromMinutes(5);

    private readonly int _maximumBodyBytes = LimitDefaults.MaximumEnvelopeBytes;

    /// <summary>The largest body: a router's largest envelope by default; past it, 413.</summary>
    public int MaximumBodyBytes
    {
        get
        {
            return _maximumBodyBytes;
        }
        init
        {
            _maximumBodyBytes = value;
            _given |= HttpPolicyMembers.MaximumBodyBytes;
        }
    }

    private readonly int _maximumConnections = 10_000;

    /// <summary>The connections drawn at once: 10,000 by default.</summary>
    public int MaximumConnections
    {
        get
        {
            return _maximumConnections;
        }
        init
        {
            _maximumConnections = value;
            _given |= HttpPolicyMembers.MaximumConnections;
        }
    }

    private readonly int _maximumConnectionsPerAddress = 64;

    /// <summary>The connections one address holds at once: 64 by default.</summary>
    public int MaximumConnectionsPerAddress
    {
        get
        {
            return _maximumConnectionsPerAddress;
        }
        init
        {
            _maximumConnectionsPerAddress = value;
            _given |= HttpPolicyMembers.MaximumConnectionsPerAddress;
        }
    }

    /// <summary>
    /// The bytes one connection's outbox holds: two of the largest envelopes by default; past it, the
    /// connection is dropped, reported through <see cref="HttpTransportServer.Error"/> naming
    /// <c>maximumOutboxBytes</c> and its value (spec 15.9).
    /// </summary>
    public long MaximumOutboxBytes { get; init; } = 2L * LimitDefaults.MaximumEnvelopeBytes;

    private readonly int _minimumSendBytesPerSecond = ServerBounds.MinimumSendBytesPerSecond;

    /// <summary>
    /// The slowest a client may take an answer, or a listen's batch, in bytes a second, once
    /// <see cref="SendGracePeriod"/> passed: 240 by default, Kestrel's <c>MinResponseDataRate</c>,
    /// which this replaces (spec 15.12). Each answer of <i>S</i> bytes is given the longer of the grace
    /// and <i>S</i> at this rate; one its socket still holds past that is lost, its connection dropped
    /// at both ends and reported through <see cref="HttpTransportServer.Error"/>, naming the bound and
    /// its grace with their values (spec 15.7). 0 holds none, on a network the application trusts;
    /// below 0 is an <see cref="ArgumentOutOfRangeException"/> as the transport is built. On the real
    /// clock, as what it bounds is the platform's socket.
    /// </summary>
    public int MinimumSendBytesPerSecond
    {
        get
        {
            return _minimumSendBytesPerSecond;
        }
        init
        {
            _minimumSendBytesPerSecond = value;
            _given |= HttpPolicyMembers.MinimumSendBytesPerSecond;
        }
    }

    private readonly TimeSpan _sendGracePeriod = ServerBounds.SendGracePeriod;

    /// <summary>
    /// The least time an answer is given to be taken by its socket: 5 seconds by default; from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one; zero and
    /// infinite are refused (spec 15.12). On the real clock.
    /// </summary>
    public TimeSpan SendGracePeriod
    {
        get
        {
            return _sendGracePeriod;
        }
        init
        {
            _sendGracePeriod = value;
            _given |= HttpPolicyMembers.SendGracePeriod;
        }
    }

    private readonly TimeSpan _headersTimeout = ServerBounds.HeadersTimeout;

    /// <summary>
    /// How long a request's head may take to come whole: 30 seconds by default, Kestrel's
    /// <c>RequestHeadersTimeout</c>, which holds it and answers 408, unmarked, on its heartbeat, past
    /// it and within 2 seconds of it (spec 15.12). From 1 to <see cref="Clocks.LongestTimer"/>
    /// milliseconds, rounded to the nearest whole one; zero and infinite are refused. On the real
    /// clock, as the platform's parser holds it.
    /// </summary>
    public TimeSpan HeadersTimeout
    {
        get
        {
            return _headersTimeout;
        }
        init
        {
            _headersTimeout = value;
            _given |= HttpPolicyMembers.HeadersTimeout;
        }
    }

    private readonly int _minimumBodyBytesPerSecond = ServerBounds.MinimumBodyBytesPerSecond;

    /// <summary>
    /// The slowest a body may come, in bytes a second, once <see cref="BodyGracePeriod"/> passed since
    /// its head: 240 by default, Kestrel's <c>MinRequestBodyDataRate</c>, which this replaces. One
    /// that has brought <i>R</i> bytes, and none more, by its head plus the longer of the grace and
    /// <i>R</i> at this rate is refused 408, <c>too-slow</c>, its socket closed in stages and its
    /// connection kept (spec 15.12). A whole number above 0; any other is an
    /// <see cref="ArgumentOutOfRangeException"/> as the transport is built.
    /// </summary>
    public int MinimumBodyBytesPerSecond
    {
        get
        {
            return _minimumBodyBytesPerSecond;
        }
        init
        {
            _minimumBodyBytesPerSecond = value;
            _given |= HttpPolicyMembers.MinimumBodyBytesPerSecond;
        }
    }

    private readonly TimeSpan _bodyGracePeriod = ServerBounds.BodyGracePeriod;

    /// <summary>
    /// How long a body comes before its rate is held: 5 seconds by default; from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one; zero and
    /// infinite are refused (spec 15.12). On the server's clock.
    /// </summary>
    public TimeSpan BodyGracePeriod
    {
        get
        {
            return _bodyGracePeriod;
        }
        init
        {
            _bodyGracePeriod = value;
            _given |= HttpPolicyMembers.BodyGracePeriod;
        }
    }

    /// <summary>
    /// The longest a listen waits for something to bring back: 30 seconds by default, under an
    /// intermediary's 60; from 1 to <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the
    /// nearest whole one; zero and infinite are refused.
    /// </summary>
    public TimeSpan MaximumWait { get; init; } = TimeSpan.FromSeconds(30);

    private readonly int _maximumWaitingExchanges = LimitDefaults.MaximumAnsweringCalls;

    /// <summary>The requests one connection has waiting at once: 64 by default; the exchanges under way on it, twice that.</summary>
    public int MaximumWaitingExchanges
    {
        get
        {
            return _maximumWaitingExchanges;
        }
        init
        {
            _maximumWaitingExchanges = value;
            IsMaximumWaitingExchangesGiven = true;
        }
    }

    // whether MaximumWaitingExchanges was given, its default 64 among what may be, so the HTTP server
    // takes its router's number for none given alone
    internal bool IsMaximumWaitingExchangesGiven { get; private init; }

    private readonly IReadOnlyList<string> _origins = [];

    /// <summary>
    /// The origins an exchange that sends an <c>Origin</c> may come from besides the server's own,
    /// <c>http://</c> or <c>https://</c> followed by its request's authority when its host is taken
    /// by name, never by <c>*</c>, each compared exactly:
    /// none by default. It serves a proxy that rewrites the host, and a page of another origin, to
    /// which the server answers CORS (spec 15.12): its preflight 204, and on every answer once its
    /// origin is judged <c>Access-Control-Allow-Origin</c> and every field exposed, never
    /// <c>Access-Control-Allow-Credentials</c>. Each is an origin as RFC 6454 §6.2 serializes it;
    /// <c>*</c>, which no origin is, <c>null</c>, which a browser sends for every page with no origin
    /// of its own, a sandboxed frame of any site among them, and any other entry are an
    /// <see cref="ArgumentException"/> as the transport is built: a page that sends <c>null</c> is
    /// served from an origin, which is named here.
    /// </summary>
    public IReadOnlyList<string> Origins
    {
        get
        {
            return _origins;
        }
        init
        {
            _origins = value;
            _given |= HttpPolicyMembers.Origins;
        }
    }

    /// <summary>The path the transport answers on.</summary>
    public string Pathname { get; init; } = HttpTransport.Pathname;

    private readonly IReadOnlyList<string>? _trustedProxies;

    /// <summary>
    /// The proxies it believes <c>X-Forwarded-For</c> from (spec 15.12): none by default, the
    /// loopback among them. Each is an IP address written bare, as a server listens on one, or a
    /// network, that address, <c>/</c> and its prefix's length (RFC 4632 §3.1, RFC 4291 §2.3), from
    /// 1, its bits past the prefix zero: <c>10.0.0.0/8</c>, or a compose network's, for a proxy in a
    /// container or an ingress; <c>127.0.0.1</c> for one on this machine. A name, a network of prefix
    /// 0, which would trust what every client writes, and any other entry are an
    /// <see cref="ArgumentException"/> as the transport is built. While the address reached is one
    /// they hold, the next entry of the field from the right is the client's, when it is an address,
    /// bare or in RFC 7239 §6's node forms, its port dropped; any other entry ends the walk, so what a
    /// client wrote to the left of its own proxy is never read. No <c>Forwarded</c> is read. A proxy
    /// it neither names nor counts (<see cref="UnnamedProxies"/>) is a client as any other: every
    /// client behind it is its address, which the bound per
    /// address counts, a told <c>busy</c> names, and the gauge <c>largestAddressConnections</c> shows
    /// near its ceiling. A bound by address counts as one the users behind one NAT, and as many the
    /// addresses of one IPv6 network.
    /// </summary>
    public IReadOnlyList<string>? TrustedProxies
    {
        get
        {
            return _trustedProxies;
        }
        init
        {
            _trustedProxies = value;

            // null is none given, as an option left out is
            if (value is not null)
            {
                _given |= HttpPolicyMembers.TrustedProxies;
            }
        }
    }

    private readonly int _unnamedProxies;

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
    public int UnnamedProxies
    {
        get
        {
            return _unnamedProxies;
        }
        init
        {
            _unnamedProxies = value;
            _given |= HttpPolicyMembers.UnnamedProxies;
        }
    }

    /// <summary>The certificate it serves TLS with, HTTP/2 and HTTP/1.1 on one port; plain HTTP/1.1 when none.</summary>
    public X509Certificate2? Certificate { get; init; }

    /// <summary>
    /// What stands in front of it, which it cannot tell (spec 13.4): true for TLS terminated before
    /// it, which makes its connections secure; false for a proxy that serves the network in the
    /// clear, which leaves them in the clear; none to judge by its certificate and the address it
    /// listens on. Believed whatever it listens on.
    /// </summary>
    public bool? Secure { get; init; }

    /// <summary>
    /// What the stack built on it runs on, its timers among them; the system's clock when none. A
    /// stop's grace bounds the platform's own, on the real clock.
    /// </summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>
    /// The policy every listener of its application judges by (decision 0037): its hosts, its
    /// origins, its proxies and its bounds, given once to this transport and a gateway alike, each
    /// member it gives taken in place of this record's of its name, which it leaves ungiven. A
    /// member given in it and beside it, whatever its value, its default among them, is an
    /// <see cref="ArgumentException"/>; none, this record's members alone.
    /// </summary>
    public HttpPolicy? Policy { get; init; }

    // ! the members a policy may give that this record was given, each init marking its own: a with
    // expression copies them, so a record built from another keeps what that one was given
    private readonly HttpPolicyMembers _given;

    // whether a member a policy may give was given here, whatever its value
    internal bool IsGiven(HttpPolicyMembers member)
    {
        return (_given & member) == member;
    }

    // the policy's members in place of this record's, where it is given: one given in it and beside
    // it refused, so that a listener never takes one value of two in silence
    internal HttpTransportServerOptions PolicyApplied()
    {
        if (Policy is not { } policy)
        {
            return this;
        }

        return this with
        {
            Policy = null,
            Hosts = HttpPolicy.Taken(nameof(Hosts), (Hosts, IsGiven(HttpPolicyMembers.Hosts), policy.Hosts)),
            Origins = HttpPolicy.Taken(nameof(Origins), (Origins, IsGiven(HttpPolicyMembers.Origins), policy.Origins)) ?? [],
            TrustedProxies = HttpPolicy.Taken(nameof(TrustedProxies), (TrustedProxies, IsGiven(HttpPolicyMembers.TrustedProxies), policy.TrustedProxies)),
            UnnamedProxies = HttpPolicy.Taken(nameof(UnnamedProxies), (UnnamedProxies, IsGiven(HttpPolicyMembers.UnnamedProxies), policy.UnnamedProxies)),
            BodyBytesBudget = HttpPolicy.Taken(nameof(BodyBytesBudget), (BodyBytesBudget, IsGiven(HttpPolicyMembers.BodyBytesBudget), policy.BodyBytesBudget)),
            MaximumBodyBytes = HttpPolicy.Taken(nameof(MaximumBodyBytes), (MaximumBodyBytes, IsGiven(HttpPolicyMembers.MaximumBodyBytes), policy.MaximumBodyBytes)),
            HeadersTimeout = HttpPolicy.Taken(nameof(HeadersTimeout), (HeadersTimeout, IsGiven(HttpPolicyMembers.HeadersTimeout), policy.HeadersTimeout)),
            MinimumBodyBytesPerSecond = HttpPolicy.Taken(nameof(MinimumBodyBytesPerSecond), (MinimumBodyBytesPerSecond, IsGiven(HttpPolicyMembers.MinimumBodyBytesPerSecond), policy.MinimumBodyBytesPerSecond)),
            BodyGracePeriod = HttpPolicy.Taken(nameof(BodyGracePeriod), (BodyGracePeriod, IsGiven(HttpPolicyMembers.BodyGracePeriod), policy.BodyGracePeriod)),
            MinimumSendBytesPerSecond = HttpPolicy.Taken(nameof(MinimumSendBytesPerSecond), (MinimumSendBytesPerSecond, IsGiven(HttpPolicyMembers.MinimumSendBytesPerSecond), policy.MinimumSendBytesPerSecond)),
            SendGracePeriod = HttpPolicy.Taken(nameof(SendGracePeriod), (SendGracePeriod, IsGiven(HttpPolicyMembers.SendGracePeriod), policy.SendGracePeriod)),
            MaximumConnections = HttpPolicy.Taken(nameof(MaximumConnections), (MaximumConnections, IsGiven(HttpPolicyMembers.MaximumConnections), policy.MaximumConnections)),
            MaximumConnectionsPerAddress = HttpPolicy.Taken(nameof(MaximumConnectionsPerAddress), (MaximumConnectionsPerAddress, IsGiven(HttpPolicyMembers.MaximumConnectionsPerAddress), policy.MaximumConnectionsPerAddress)),
        };
    }
}

/// <summary>Where an HTTP transport server listens.</summary>
public sealed record HttpTransportStartOptions
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
/// A transport server over HTTP, on Kestrel, which keeps no connection and so draws one. A
/// <c>POST</c> with no body and no token connects: the server draws a 16-byte token, raises
/// <see cref="Connection"/>, and answers 201 with it in <see cref="HttpTransport.ConnectionTokenHeader"/>;
/// each exchange after presents it, and a <c>DELETE</c> ends the connection, which is named
/// <c>type=HTTP;ip=…;ordinal=…</c> — the token, a secret, enters no handle and no event.
/// </summary>
/// <remarks>
/// Each <c>POST</c> carries one envelope, of type <see cref="HttpTransport.MediaType"/>; the
/// transport reads its layout, kind and call id, and nothing else. A request waits under its call id
/// for the answer the router sends on it, its head going out as it is handed on; any other envelope
/// ends 204. A request is handed on with its credential, the <c>Authorization</c> field of its
/// <c>POST</c> as it came, its surrounding whitespace removed, and none when the field is empty or
/// absent; no other exchange's is read, and a <c>POST</c> with two is refused 400. An answer, and
/// what a listen brings back, carry none. A cancel ends the exchange of its call; one before its
/// request buries that call id for 5 seconds. Each refusal of its own is marked in
/// <see cref="HttpTransport.RefusalHeader"/>. To a page of an origin
/// <see cref="HttpTransportServerOptions.Origins"/> names, it answers CORS (spec 15.12): its
/// preflight 204, and every answer once its origin is judged naming it and exposing every field, no
/// credential allowed. An exchange lost — its client gone before the transport ended it — closes the
/// connection, as a socket that drops does; so do a request unanswered past its exchange timeout and
/// a connection idle past its inactivity timeout. What the server sends of its
/// own waits, numbered, in the outbox of a connection whose client said at connect that it listens,
/// until a <c>GET</c> listen brings it back in a batch; each listen held, once past its refusals,
/// raises <see cref="Listen"/> with true, and its end, while its connection stands, with false. Each
/// exchange waits in its own request, on Kestrel's thread, for what ends it; what the transport holds
/// is kept under one lock, and its events are raised outside it, each listener within a guard: what
/// one throws is reported through <see cref="Error"/>, and changes nothing the transport does.
/// </remarks>
public sealed partial class HttpTransportServer : IServerTransport, IAsyncDisposable
{
    private const int TokenBytes = 16;
    private const int LengthBytes = 4;

    // what a cancel that came before its request buries that call id for: the least a requester
    // reserves one for
    private static readonly TimeSpan Burial = TimeSpan.FromSeconds(5);

    // how long a stop lets the exchanges under way write their end before it cuts them, at most: an
    // end its closes wrote is a few bytes, where the TypeScript side's go out as they are written,
    // and a client that does not read holds the stop back no longer than this
    private static readonly TimeSpan EndsGrace = TimeSpan.FromSeconds(1);

    private const int LingerReadBytes = 65_536;

    private static readonly End Nothing = new(StatusCodes.Status204NoContent);
    private static readonly End Malformed = new(StatusCodes.Status400BadRequest, HttpRefusals.Malformed);
    private static readonly End Unknown = new(StatusCodes.Status404NotFound, HttpRefusals.ConnectionUnknown);
    private static readonly End TooSlow = new(StatusCodes.Status408RequestTimeout, HttpRefusals.TooSlow);
    private static readonly End Busy = new(StatusCodes.Status503ServiceUnavailable, HttpRefusals.Busy) { Headers = new Dictionary<string, string> { ["retry-after"] = "1" } };

    private readonly HttpTransportServerOptions _options;
    private readonly TimeProvider _clock;

    // the networks of the proxies it believes X-Forwarded-For from
    private readonly ProxyTrust _proxyTrust;

    // what the transport holds, under its lock: the connections by handle and by token, how many
    // each address holds, the exchanges under way, and the bytes of body being read
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Drawn> _drawn = [];
    private readonly Dictionary<string, Drawn> _byToken = [];
    private readonly Dictionary<string, int> _perAddress = [];
    private readonly HashSet<Task> _exchanging = [];
    private long _bodyBytes;
    private long _ordinal;

    // its ready state, and the guards around its start and its stop, as every transport server's
    private readonly TransportServerLife _life = new();
    private WebApplication? _application;

    // how its events are told: what a listener throws is reported through Error, with its connection
    private readonly ListenerGuard _listeners;
    private readonly HttpRequestExchange<Drawn> _exchange;

    // whether its connections are secure: as its application says what stands in front of it, or,
    // when it says nothing, under TLS, wherever it listens, or bound to the loopback as it starts
    private volatile bool _isSecure;

    /// <summary>
    /// A transport server, not yet listening, its durations held. A bound not above 0, or a timeout
    /// that is not from 1 to <see cref="Clocks.LongestTimer"/> milliseconds — infinite aside, but for
    /// the longest wait — is an <see cref="ArgumentOutOfRangeException"/> naming it; an entry of its
    /// hosts, origins or trusted proxies none takes, an <see cref="ArgumentException"/> naming it.
    /// </summary>
    public HttpTransportServer(HttpTransportServerOptions? options = null)
    {
        var given = (options ?? new HttpTransportServerOptions()).PolicyApplied();

        HostsAndOrigins.AssertHosts(given.Hosts, nameof(HttpTransportServerOptions.Hosts));
        HostsAndOrigins.AssertOrigins(given.Origins, nameof(HttpTransportServerOptions.Origins));
        _proxyTrust = Bead.TrustedProxies.TrustOf(
            (given.TrustedProxies, nameof(HttpTransportServerOptions.TrustedProxies)),
            (given.UnnamedProxies, nameof(HttpTransportServerOptions.UnnamedProxies)));
        AssertWhole((nameof(HttpTransportServerOptions.BodyBytesBudget), given.BodyBytesBudget));

        var exchangeTimeout = Clocks.AssertHeld((nameof(HttpTransportServerOptions.ExchangeTimeout), nameof(HttpTransportServerOptions.ExchangeTimeout)), given.ExchangeTimeout);
        var inactivityTimeout = Clocks.AssertHeld((nameof(HttpTransportServerOptions.InactivityTimeout), nameof(HttpTransportServerOptions.InactivityTimeout)), given.InactivityTimeout);

        AssertWhole((nameof(HttpTransportServerOptions.MaximumBodyBytes), given.MaximumBodyBytes));
        AssertWhole((nameof(HttpTransportServerOptions.MaximumConnections), given.MaximumConnections));
        AssertWhole((nameof(HttpTransportServerOptions.MaximumConnectionsPerAddress), given.MaximumConnectionsPerAddress));
        AssertWhole((nameof(HttpTransportServerOptions.MaximumOutboxBytes), given.MaximumOutboxBytes));

        var maximumWait = Clocks.AssertHeldFinite((nameof(HttpTransportServerOptions.MaximumWait), nameof(HttpTransportServerOptions.MaximumWait)), given.MaximumWait);

        AssertWhole((nameof(HttpTransportServerOptions.MaximumWaitingExchanges), given.MaximumWaitingExchanges));
        AssertWhole((nameof(HttpTransportServerOptions.MinimumBodyBytesPerSecond), given.MinimumBodyBytesPerSecond));

        ServerBounds.AssertCountOrNone((nameof(HttpTransportServerOptions.MinimumSendBytesPerSecond), given.MinimumSendBytesPerSecond));

        // ! never refused: a head, a body or an answer bounded by nothing would hold its socket for
        // ever (spec 15.12)
        var sendGracePeriod = Clocks.AssertHeldFinite((nameof(HttpTransportServerOptions.SendGracePeriod), nameof(HttpTransportServerOptions.SendGracePeriod)), given.SendGracePeriod);
        var headersTimeout = Clocks.AssertHeldFinite((nameof(HttpTransportServerOptions.HeadersTimeout), nameof(HttpTransportServerOptions.HeadersTimeout)), given.HeadersTimeout);
        var bodyGracePeriod = Clocks.AssertHeldFinite((nameof(HttpTransportServerOptions.BodyGracePeriod), nameof(HttpTransportServerOptions.BodyGracePeriod)), given.BodyGracePeriod);

        _options = given with
        {
            ExchangeTimeout = exchangeTimeout,
            InactivityTimeout = inactivityTimeout,
            MaximumWait = maximumWait,
            SendGracePeriod = sendGracePeriod,
            HeadersTimeout = headersTimeout,
            BodyGracePeriod = bodyGracePeriod,
        };
        _isSecure = _options.Secure ?? _options.Certificate is not null;
        _clock = _options.Clock ?? TimeProvider.System;
        _listeners = new ListenerGuard((reason, connectionHandle) =>
        {
            Error?.Invoke(reason, connectionHandle ?? "");
        });
        _exchange = new HttpRequestExchange<Drawn>(new HttpRequestExchange<Drawn>.Port
        {
            BeginExchange = BeginExchange,
            EndExchange = EndExchange,
            ChargeBody = ChargeBody,
            ReleaseBody = ReleaseBody,
            Classify = Classify,
            FinishBody = FinishBody,
            BeginHandOff = BeginHandOff,
            WaitAfterHandOff = WaitAfterHandOff,
            Finish = Finish,
            EndEarly = EndEarly,
            Lose = Lose,
            Cancel = Cancel,
            Message = (message, connection) =>
            {
                _listeners.Tell(Message, (message, connection.ConnectionHandle));
            },
            AddressOf = AddressOf,
            Drop = Drop,
            Answering = () =>
            {
                return Answering;
            },
        }, new HttpRequestExchange<Drawn>.Bounds
        {
            MaximumBodyBytes = _options.MaximumBodyBytes,
            MinimumBodyBytesPerSecond = _options.MinimumBodyBytesPerSecond,
            BodyGracePeriod = _options.BodyGracePeriod,
            MinimumSendBytesPerSecond = _options.MinimumSendBytesPerSecond,
            SendGracePeriod = _options.SendGracePeriod,
            Clock = _clock,
        });
    }

    /// <inheritdoc/>
    public event Action<string>? Connection;

    /// <inheritdoc/>
    public event Action<TransportMessage, string>? Message;

    /// <inheritdoc/>
    public event Action<bool, string>? Close;

    /// <inheritdoc/>
    public event Action<bool, string>? Listen;

    /// <summary>
    /// Each refusal it judges of its own (spec 15.1): a request it refuses as it arrives, in the order
    /// spec 15.6 states, a stop's 503 and a token no connection holds among them, or whose body it
    /// refuses as it comes, each marked; never the 404 that ends an exchange or a listen it had taken
    /// as their connection closes (spec 15.7), which <see cref="Close"/> tells, nor what HTTP refuses
    /// of its own, unmarked. Told once the refusal is written, and built only when a listener listens.
    /// </summary>
    public event Action<TransportServerRefusal>? Refusal;

    /// <summary>
    /// What went wrong on a connection, with its handle (spec 15.1): a bound it is dropped behind,
    /// <see cref="HttpTransportServerOptions.MaximumOutboxBytes"/> or
    /// <see cref="HttpTransportServerOptions.MinimumSendBytesPerSecond"/> past
    /// <see cref="HttpTransportServerOptions.SendGracePeriod"/>, an <see cref="IOException"/> naming
    /// the bound in the spec's spelling and its value, told once, as its connection ends, its end
    /// begun, before its unclean <see cref="Close"/>, so a listener that throws keeps nothing open; or
    /// what a listener of its events threw, as it threw, the transport going on as if it returned.
    /// Never a client gone, an exchange lost, or a connection closed past its exchange or inactivity
    /// timeout, which its unclean <see cref="Close"/> tells. With an empty handle for a throw of a
    /// <see cref="Refusal"/> listener alone, which names no connection; never the server's own
    /// failure, as the TypeScript side's can be: Kestrel tells a failure of its own only to its logs.
    /// </summary>
    public event Action<Exception, string>? Error;

    /// <summary>Each application a start builds, as it is built: the tests' way to read what it set on Kestrel.</summary>
    internal event Action<WebApplication>? Built;

    /// <summary>
    /// What each connection Kestrel takes goes through before its exchanges: the tests' way to stall
    /// a socket's writes, as a client that stops reading stalls them where its platform's buffers
    /// fill, which a platform that takes every write never does.
    /// </summary>
    internal Func<Microsoft.AspNetCore.Connections.ConnectionDelegate, Microsoft.AspNetCore.Connections.ConnectionDelegate>? Connecting { get; init; }

    /// <summary>
    /// Each listen, its connection found by its token, before it is held: the tests' way to close
    /// its connection in between.
    /// </summary>
    internal event Action<string>? Holding;

    /// <summary>
    /// Each answer, before it is written, with its exchange's abort: the tests' way to drop its
    /// socket in between and to wait until the server is told, where a socket that takes the
    /// answer whole at once would win the race.
    /// </summary>
    internal Func<CancellationToken, Task>? Answering { get; set; }

    /// <summary>
    /// How a start on <c>localhost</c> draws its port and binds the IPv6 loopback: the tests' way to
    /// draw a port another socket holds there, and to start where it is absent.
    /// </summary>
    internal LoopbackBinding Loopback { get; init; } = new();

    /// <summary>Where it is in its life: Uninitialized until its first start.</summary>
    public ReadyState ReadyState
    {
        get
        {
            return _life.ReadyState;
        }
    }

    /// <summary>Its type, <see cref="TransportTypes.Http"/>, which every handle it draws begins with.</summary>
    public string Type
    {
        get
        {
            return TransportTypes.Http;
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

    /// <summary>The handles of the connections drawn right now.</summary>
    public IReadOnlyCollection<string> ConnectionHandles
    {
        get
        {
            lock (_gate)
            {
                return [.. _drawn.Keys];
            }
        }
    }

    /// <summary>
    /// The connections drawn right now, in the order they were drawn, as a copy: each what its
    /// connection looked like then, without its token or anything else the transport keeps of it.
    /// </summary>
    public IReadOnlyList<TransportServerClient> Clients
    {
        get
        {
            lock (_gate)
            {
                // by their ordinal: a dictionary that removed one puts the next where it was
                return [.. _drawn.Values.OrderBy((connection) =>
                {
                    return connection.Ordinal;
                }).Select((connection) =>
                {
                    return new TransportServerClient(connection.Address, connection.ConnectionHandle, connection.LastActivity, connection.Port, TransportTypes.Http);
                })];
            }
        }
    }

    /// <summary>
    /// What it keeps of its connections, at the ceilings it has: the connections, the addresses and
    /// the connections the busiest one holds, which its health warns on before a proxy it was not
    /// told of is refused <c>busy</c>, the bytes of body being read, the call ids buried, the listens held, what the outboxes hold and the
    /// fullest one, and the requests waiting. Kestrel shows no HTTP/2 session, which the TypeScript
    /// side counts.
    /// </summary>
    public Gauges Gauges()
    {
        lock (_gate)
        {
            var connections = _drawn.Values;

            return Bead.Gauges.Of(
                new Dictionary<string, long>
                {
                    ["addresses"] = _perAddress.Count,
                    ["bodyBytes"] = _bodyBytes,
                    ["buriedCallIds"] = connections.Sum((connection) =>
                    {
                        return (long)connection.Buried.Count;
                    }),
                    ["connections"] = _drawn.Count,
                    ["largestAddressConnections"] = _perAddress.Values.DefaultIfEmpty().Max(),
                    ["largestOutboxBytes"] = connections.Select((connection) =>
                    {
                        return connection.OutboxBytes;
                    }).DefaultIfEmpty().Max(),
                    ["listens"] = connections.Count((connection) =>
                    {
                        return connection.Listen is not null;
                    }),
                    ["outboxBytes"] = connections.Sum((connection) =>
                    {
                        return connection.OutboxBytes;
                    }),
                    ["outboxEnvelopes"] = connections.Sum((connection) =>
                    {
                        return (long)connection.Outbox.Count;
                    }),
                    ["waitingExchanges"] = connections.Sum((connection) =>
                    {
                        return (long)connection.Waiting.Count;
                    }),
                },
                _drawn.Keys) with
            {
                Ceilings = new Dictionary<string, long>
                {
                    ["bodyBytes"] = _options.BodyBytesBudget,
                    ["connections"] = _options.MaximumConnections,
                    ["largestAddressConnections"] = _options.MaximumConnectionsPerAddress,
                    ["largestOutboxBytes"] = _options.MaximumOutboxBytes,
                },
            };
        }
    }

    /// <summary>
    /// Listens, and gives where. Refused with an <see cref="InvalidOperationException"/> unless
    /// Uninitialized or Closed; one that fails ends Closed, ready to start again.
    /// </summary>
    public Task<TransportServerAddress> Start(HttpTransportStartOptions? options = null, CancellationToken cancellationToken = default)
    {
        var start = options ?? new HttpTransportStartOptions();

        return _life.Start(() =>
        {
            return Starting((start, cancellationToken));
        });
    }

    /// <summary>
    /// Closes every connection, each exchange still waiting learning its connection is gone, then
    /// stops listening; it ends Closed. From its start it draws no connection and holds none: a
    /// connect is refused 503, busy, and an exchange that presents a token is answered the 404 marked
    /// connection-unknown (spec 15.7). It settles at once when Uninitialized or Closed; a second
    /// stop shares the stop under way; one while starting is an <see cref="InvalidOperationException"/>.
    /// </summary>
    public Task Stop()
    {
        return _life.Stop(Stopping);
    }

    // listens where it is told, localhost on both loopbacks, and gives where
    private async Task<TransportServerAddress> Starting((HttpTransportStartOptions Start, CancellationToken Token) call)
    {
        var (start, cancellationToken) = call;

        // ! an IP address by RFC 3986's grammar before the platform's parser reads it: it takes 0 for
        // 0.0.0.0, every interface, and 127.1, octal, hexadecimal and a zone besides
        HostsAndOrigins.AssertAddress(start.Address, nameof(HttpTransportStartOptions.Address));

        var ((application, port), address) = start.Address == Loopbacks.Localhost
            ? await Loopbacks.Bind(
                (listening) =>
                {
                    return Serving(listening, cancellationToken);
                },
                Loopback with { Port = start.Port, FindOpenPort = start.FindOpenPort })
            : (await Serving(([IPAddress.Parse(start.Address)], start.FindOpenPort ? 0 : start.Port), cancellationToken), start.Address);

        _isSecure = _options.Secure ?? TransportSecurity.IsSecure((_options.Certificate is not null, address));
        _application = application;

        return new TransportServerAddress(address, port);
    }

    // builds an application on the addresses and the port given and starts it, every address served
    // by one configuration, and gives the port it listens on; what a failed start built goes with it
    private async Task<(WebApplication Application, int Port)> Serving((IReadOnlyList<IPAddress> Addresses, int Port) listening, CancellationToken cancellationToken)
    {
        WebApplication? application = null;

        try
        {
            var builder = WebApplication.CreateSlimBuilder();

            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel((kestrel) =>
            {
                kestrel.AddServerHeader = false;

                // * an origin server MUST take an absolute-form target's authority over its Host (RFC
                // 9112 §3.2.2), where Kestrel refuses 400 a Host that differs from it by default
                kestrel.AllowHostHeaderOverride = true;

                // the transport counts each body against its own limit and budget, and holds it to
                // its own rate, as each answer to its own pace (spec 15.12): Kestrel's would abort
                // unreported, its bound unnamed, and answer a body it failed 200
                kestrel.Limits.MaxRequestBodySize = null;
                kestrel.Limits.MinRequestBodyDataRate = null;
                kestrel.Limits.MinResponseDataRate = null;

                // * a head is the platform's parser's, which no Bead code sees until it is whole:
                // answered 408 on Kestrel's heartbeat, which arms its deadline a heartbeat late, a
                // connection's first head 1 to 2 seconds past its time (spec 15.12)
                kestrel.Limits.RequestHeadersTimeout = _options.HeadersTimeout;
                foreach (var address in listening.Addresses)
                {
                    kestrel.Listen(address, listening.Port, (listen) =>
                    {
                        if (Connecting is { } connecting)
                        {
                            listen.Use(connecting);
                        }

                        if (_options.Certificate is { } certificate)
                        {
                            listen.Protocols = HttpProtocols.Http1AndHttp2;
                            listen.UseHttps(certificate);
                        }
                    });
                }
            });
            application = builder.Build();
            Built?.Invoke(application);
            application.Run(Exchanging);
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

    /// <summary>Closes every connection, as <see cref="CloseConnection"/> closes one, and gives what each close gave.</summary>
    public Task<bool[]> CloseAll()
    {
        return Task.WhenAll(ConnectionHandles.Select(CloseConnection));
    }

    /// <summary>Closes a connection cleanly, its close raised; false when it held none by that handle.</summary>
    public Task<bool> CloseConnection(string connectionHandle)
    {
        Drawn? connection;

        lock (_gate)
        {
            connection = _drawn.GetValueOrDefault(connectionHandle);
        }

        if (connection is null)
        {
            return Task.FromResult(false);
        }

        CloseDrawn(connection, true);

        return Task.FromResult(true);
    }

    /// <summary>As <see cref="Stop"/>: a server's facade stops its transport with it.</summary>
    public Task Shutdown()
    {
        return Stop();
    }

    /// <summary>Whether a connection carries the server's own envelopes: its client said at connect that it listens.</summary>
    public bool IsTwoWay(string connectionHandle)
    {
        lock (_gate)
        {
            return _drawn.TryGetValue(connectionHandle, out var connection) && connection.IsListening;
        }
    }

    /// <summary>
    /// What a listen brings back carries no credential beside its envelopes (spec 15.9): a command
    /// presenting <see cref="CredentialScheme.Elsewhere"/> fails before it goes.
    /// </summary>
    public bool CarriesCredential(string connectionHandle)
    {
        return false;
    }

    /// <summary>
    /// Whether a connection is secure (spec 13.4): as <see cref="HttpTransportServerOptions.Secure"/>
    /// says, when given; otherwise judged from its listener, never from what a name resolves to,
    /// under TLS, its certificate given, or bound to a loopback address.
    /// </summary>
    public bool IsSecure(string connectionHandle)
    {
        return _isSecure;
    }

    /// <summary>
    /// Hands an envelope to a connection: an answer ends the exchange of its request, settling once
    /// it went out; anything else — a late answer too — waits in the outbox of a connection whose
    /// client listens, and is refused with an <see cref="InvalidOperationException"/> on one whose
    /// client does not, but for an answer, which goes nowhere. A connection it does not hold takes
    /// nothing, and says nothing. Neither carries a credential.
    /// </summary>
    public Task Send(TransportMessage message, string connectionHandle)
    {
        // neither carries a credential: its router fails a command that presents one before it goes
        var bytes = message.Bytes;

        if (bytes.Length < HttpTransport.PrefixBytes)
        {
            return Task.FromException(new ArgumentException("an HTTP exchange carries one envelope, as bytes", nameof(message)));
        }

        var kind = (EnvelopeKind)bytes.Span[1];
        var callId = BinaryPrimitives.ReadUInt32BigEndian(bytes.Span[4..]);
        var isAnswer = kind is EnvelopeKind.Result or EnvelopeKind.Failure;
        Drawn? overflowing = null;
        Waiting? answered = null;
        PipeReader? interrupted = null;

        lock (_gate)
        {
            if (!_drawn.TryGetValue(connectionHandle, out var connection))
            {
                return Task.CompletedTask;
            }

            var waiting = isAnswer ? connection.Waiting.GetValueOrDefault(callId) : null;

            if (waiting is not null)
            {
                connection.Waiting.Remove(callId);
                waiting.IsEnded = true;
                waiting.Timer?.Dispose();
                waiting.Ended.TrySetResult(new Ending { Bytes = bytes.ToArray() });
                answered = waiting;
                interrupted = waiting.Reading;
            }
            else if (connection.IsListening)
            {
                overflowing = Enqueue(connection, bytes) ? null : connection;
            }
            else if (!isAnswer)
            {
                return Task.FromException(new InvalidOperationException(
                    $"this connection does not listen: an envelope of kind 0x{(byte)kind:x} goes nowhere"));
            }
        }

        // * dropped, its client behind, then reported naming its bound and its value (spec 15.9)
        if (overflowing is not null)
        {
            Drop((overflowing, string.Create(CultureInfo.InvariantCulture, $"its outbox would pass maximumOutboxBytes, {_options.MaximumOutboxBytes} bytes")));
        }

        // its body still coming: its answer goes now, and it is never handed on
        interrupted?.CancelPendingRead();

        return answered?.Written.Task ?? Task.CompletedTask;
    }

    /// <summary>As <see cref="Stop"/>.</summary>
    public async ValueTask DisposeAsync()
    {
        await Stop();
    }

    // a whole number above 0
    private static void AssertWhole((string Name, long Value) bound)
    {
        ServerBounds.AssertCount(bound);
    }

    // a token as the server draws it: 22 characters of base64url
    private static bool IsToken(string token)
    {
        return token.Length == 22 && token.All((character) =>
        {
            return char.IsAsciiLetterOrDigit(character) || character is '-' or '_';
        });
    }

    // ends an exchange the transport answers itself; one whose body it will not read is closed
    // behind a refusal, and a refusal marked is told once written: the one writer of every refusal
    // the transport judges (spec 15.1)
    private async Task Finish(HttpContext context, End end)
    {
        if (!context.Response.HasStarted && end.Status >= 400 && HttpServerFields.HasBody(context))
        {
            HttpServerFields.CloseBehind(context);
        }

        await HttpServerFields.EndWith(context, end);

        // * built only when a listener listens
        if (end.Reason is { } reason && Refusal is { } listeners)
        {
            var refusal = new TransportServerRefusal(
                AddressOf(context),
                HttpServerFields.AuthorityOf(context),
                HostsAndOrigins.OriginOf(context.Request.Headers.Origin),
                context.Connection.RemotePort,
                reason,
                end.Status);

            _listeners.Tell(listeners, refusal);
        }
    }

    // a stop: every connection closed, as lost, then the port freed
    private async Task Stopping()
    {
        List<Drawn> connections;

        lock (_gate)
        {
            connections = [.. _drawn.Values];
        }

        foreach (var connection in connections)
        {
            CloseDrawn(connection, false);
        }

        Task[] exchanging;

        lock (_gate)
        {
            exchanging = [.. _exchanging];
        }

        // one grace for the whole stop, in real time, since what it waits on is the network's: the
        // exchanges under way write their end, then Kestrel puts what they wrote on the wire before
        // it closes their connections — cut at once, a 404 just written can go as a reset instead
        using var grace = new CancellationTokenSource(EndsGrace, TimeProvider.System);

        try
        {
            await Task.WhenAll(exchanging).WaitAsync(grace.Token);
        }
        catch (Exception)
        {
            // failed, or still under way past its grace: what is left is cut with the rest
        }

        var application = Interlocked.Exchange(ref _application, null);

        if (application is not null)
        {
            try
            {
                // what Kestrel still holds when the grace runs out is cut: a body still coming, or a
                // head half sent, holds the stop back no longer than that
                await application.StopAsync(grace.Token);
            }
            finally
            {
                await application.DisposeAsync();
            }
        }
    }

    // the client's address, in its one form: the socket's, walked past each proxy it trusts through
    // X-Forwarded-For, its lines joined by commas, from the right
    private string? AddressOf(HttpContext context)
    {
        if (context.Connection.RemoteIpAddress is not { } remote)
        {
            return null;
        }

        var forwarded = context.Request.Headers["x-forwarded-for"];

        return Bead.TrustedProxies.ClientAddressOf(remote, (forwarded.Count == 0 ? null : forwarded.ToString(), _proxyTrust));
    }

    // an exchange from the server's own origin, its request's authority under http or https when its
    // host is taken by name, or one it was told; one with no Origin comes from anywhere, and any
    // client that sends one is judged by it
    private bool IsAllowedOrigin((HttpRequest Request, string? Authority) exchange)
    {
        // ! the own origin by a host taken by name alone: under *, a page that rebinds its name is
        // its own origin by the very Host * did not check
        var own = HostsAndOrigins.OwnAuthorityOf(exchange.Authority, _options.Hosts);

        return HostsAndOrigins.IsTakenOrigin(HttpServerFields.HeaderOf(exchange.Request, HeaderNames.Origin), (own, _options.Origins));
    }

    // an exchange: what it is, as its method, its path, its host, its origin and its token say
    // an exchange, kept among those under way until it ends, so a stop lets it write its end
    private async Task Exchanging(HttpContext context)
    {
        var exchange = Exchange(context);

        lock (_gate)
        {
            _exchanging.Add(exchange);
        }

        try
        {
            await exchange;
        }
        finally
        {
            lock (_gate)
            {
                _exchanging.Remove(exchange);
            }
        }

        await Linger(context);
    }

    // ! an answer written before its body is whole closes its socket in stages, its write side
    // first (RFC 9112 §9.6): what still comes is read and dropped until its client closes or 2
    // seconds pass, on the real clock, since what it waits on is the network's, so a reset never
    // erases an answer its client has not read yet. A body read whole ends at once
    private static async Task Linger(HttpContext context)
    {
        if (!HttpServerFields.IsLingering(context))
        {
            return;
        }

        using var lingering = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        var dropped = new byte[LingerReadBytes];

        lingering.CancelAfter(ServerBounds.Linger);

        try
        {
            while (await context.Request.Body.ReadAsync(dropped, lingering.Token) > 0)
            {
                // dropped
            }
        }
        catch (Exception reason) when (reason is IOException or OperationCanceledException or InvalidOperationException or Microsoft.AspNetCore.Http.BadHttpRequestException)
        {
            // its client gone, its 2 seconds passed, or its body no more to read
        }
    }

    // * an answer's bytes written at its pace (spec 15.12): given the longer of its grace and its
    // bytes at the rate, judged each second on the real clock, since what it bounds is the
    // platform's socket; its socket still holding them past that, its exchange is aborted, and
    // true. A rate of 0 holds none. Kestrel drops a write to a client gone without a word, before
    // its abort is told: a flush that finds nothing reading says the answer never went out whole,
    // an IOException
    private static async Task<bool> WritePaced(HttpContext context, (ReadOnlyMemory<byte> Bytes, (int BytesPerSecond, TimeSpan Grace) Pace) answer)
    {
        var (bytes, (bytesPerSecond, grace)) = answer;
        var isLate = false;
        long unsent = bytes.Length;

        void Late()
        {
            Volatile.Write(ref isLate, true);
            context.Abort();
        }

        long Unsent()
        {
            return Interlocked.Read(ref unsent);
        }

        var pace = new SendPace((Late, Unsent), new SendPaceOptions { MinimumSendBytesPerSecond = bytesPerSecond, SendGracePeriod = grace });

        pace.Hand(bytes.Length);

        try
        {
            await context.Response.Body.WriteAsync(bytes, context.RequestAborted);

            if ((await context.Response.BodyWriter.FlushAsync(context.RequestAborted)).IsCompleted)
            {
                throw new IOException("the exchange closed before its answer went out");
            }
        }
        catch (Exception reason) when (Volatile.Read(ref isLate) && reason is IOException or OperationCanceledException)
        {
            return true;
        }
        finally
        {
            Interlocked.Exchange(ref unsent, 0);
            pace.Stop();
        }

        return Volatile.Read(ref isLate);
    }

    // ! a connection dropped behind a bound of its own (spec 15.9, 15.12), its exchange lost, as an
    // answer that could not be written is (spec 15.7): its end begun, then reported, why naming the
    // bound in the spec's spelling and its value; once, as it ends, before its unclean close, which
    // is told even when a listener of Error throws, what it threw going on to its caller (spec 15.1)
    private void Drop((Drawn Connection, string Why) dropped)
    {
        var (connection, why) = dropped;

        if (!Take(connection))
        {
            return;
        }

        try
        {
            Error?.Invoke(ServerBounds.DroppedOf(connection.ConnectionHandle, why), connection.ConnectionHandle);
        }
        finally
        {
            _listeners.Tell(Close, (false, connection.ConnectionHandle));
        }
    }

    private async Task Exchange(HttpContext context)
    {
        var request = context.Request;

        // * a field HTTP would call malformed before anything else is judged (spec 15.12): Kestrel
        // refuses 400 an octet that is no UTF-8, and decodes the rest, a character past ASCII among
        // them, and takes a control character, or a value with a space or a tab at either end over
        // HTTP/2 (RFC 9113 §8.2.1), which this refuses as HTTP refuses a malformed field — over
        // HTTP/2 by resetting the stream, PROTOCOL_ERROR, as Kestrel resets one of its own
        if (!HttpServerFields.HasVisibleFields(request))
        {
            if (HttpServerFields.ResetMalformedFields(context))
            {
                return;
            }

            await HttpServerFields.RefuseAsHttp(context, StatusCodes.Status400BadRequest);

            return;
        }

        // ! the authority as it came, which a browser writes as it writes its Origin, an IDN in
        // punycode: Request.Host turns punycode into Unicode, and throws on what decodes to none.
        // Kestrel has put HTTP/2's :authority in the Host; an absolute-form target's it reads
        // through a Uri, which lowers its case and drops a default or an empty port and a userinfo,
        // so it is read from the target as it came, and judged as HTTP judges a Host
        var targetAuthority = HttpServerFields.TargetAuthorityOf(context);

        // ! an HTTP/2 request with neither :authority nor host is malformed (RFC 9113 §8.3.1), under
        // * as under any hosts: its stream reset, PROTOCOL_ERROR, as Node's HTTP/2 resets it before
        // any listener, where Kestrel hands it on with an empty Host
        if (HttpProtocol.IsHttp2(request.Protocol) && request.Headers.Host.Count == 0 && HttpServerFields.ResetMalformedFields(context))
        {
            return;
        }

        if (!HttpServerFields.IsTakenTarget(context))
        {
            await HttpServerFields.RefuseAsHttp(context, StatusCodes.Status400BadRequest);

            return;
        }

        var authority = HostsAndOrigins.AuthorityOf(request.Headers.Host, targetAuthority);

        if (!HostsAndOrigins.IsTakenHost(authority, _options.Hosts))
        {
            await Finish(context, new End(StatusCodes.Status403Forbidden, HttpRefusals.Host));

            return;
        }

        if (request.Path.Value != _options.Pathname)
        {
            await Finish(context, new End(StatusCodes.Status404NotFound, HttpRefusals.Path));

            return;
        }

        if (!IsAllowedOrigin((request, authority)))
        {
            await Finish(context, new End(StatusCodes.Status403Forbidden, HttpRefusals.Origin));

            return;
        }

        var origin = HttpServerFields.HeaderOf(request, HeaderNames.Origin);
        var isListed = HostsAndOrigins.IsListedOrigin(origin, _options.Origins);

        // * every answer a page Origins names can read carries it, a refusal's too, which its client
        // reads; a refusal judged before the origin answers a preflight no browser reads (Fetch
        // §4.8). EndWith and the head writers keep what is set here
        if (isListed)
        {
            context.Response.Headers.AccessControlAllowOrigin = origin;
            context.Response.Headers.AccessControlExposeHeaders = "*";
        }

        // a preflight is no refusal, so EndWith, never Finish: nothing told, no connection drawn
        if (isListed && HttpMethods.IsOptions(request.Method) && request.Headers.ContainsKey(HeaderNames.AccessControlRequestMethod))
        {
            await HttpServerFields.EndWith(context, HttpServerFields.PreflightOf(request));

            return;
        }

        if (!HttpMethods.IsGet(request.Method) && !HttpMethods.IsPost(request.Method) && !HttpMethods.IsDelete(request.Method))
        {
            await Finish(context, new End(StatusCodes.Status405MethodNotAllowed, HttpRefusals.Method) { Headers = new Dictionary<string, string> { ["allow"] = "GET, POST, DELETE" } });

            return;
        }

        var connectionToken = HttpServerFields.HeaderOf(request, HttpTransport.ConnectionTokenHeader);

        if (connectionToken is null && HttpMethods.IsPost(request.Method))
        {
            await (HttpServerFields.IsBeadBody(request) ? Connect(context) : Finish(context, new End(StatusCodes.Status415UnsupportedMediaType, HttpRefusals.Type)));

            return;
        }

        if (connectionToken is null || !IsToken(connectionToken))
        {
            await Finish(context, Malformed);

            return;
        }

        // once its stop began it holds no connection: the token is not looked up, and nothing of the
        // exchange is handed on, as the stop answers each listen it holds
        if (_life.IsStopping)
        {
            await Finish(context, Unknown);

            return;
        }

        Drawn? connection;

        lock (_gate)
        {
            connection = _byToken.GetValueOrDefault(connectionToken);
        }

        if (connection is null)
        {
            await Finish(context, Unknown);

            return;
        }

        if (HttpMethods.IsDelete(request.Method))
        {
            CloseDrawn(connection, true);
            await Finish(context, Nothing);

            return;
        }

        if (HttpMethods.IsGet(request.Method))
        {
            await Hold(context, connection);

            return;
        }

        await (HttpServerFields.IsBeadBody(request) ? Receive(context, connection) : Finish(context, new End(StatusCodes.Status415UnsupportedMediaType, HttpRefusals.Type)));
    }

    // a connect: a connection drawn, registered before its client has its token
    private async Task Connect(HttpContext context)
    {
        var address = AddressOf(context);
        var isListening = HttpServerFields.ListeningOf(context.Request);

        // a connect carries no body, and says whether it listens in the one way
        if (HttpServerFields.HasBody(context) || address is null || isListening is not { } listens)
        {
            await Finish(context, Malformed);

            return;
        }

        Drawn? connection = null;

        lock (_gate)
        {
            // ! judged under the lock, as a stop's snapshot of what it closes is taken under it: one
            // drawn as a stop began is refused, busy, never left registered and never closed
            if (!_life.IsStopping && _drawn.Count < _options.MaximumConnections && _perAddress.GetValueOrDefault(address) < _options.MaximumConnectionsPerAddress)
            {
                _ordinal += 1;
                connection = new Drawn(
                    (address, $"type={TransportTypes.Http};ip={address};ordinal={_ordinal}", Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(TokenBytes))),
                    listens)
                {
                    Ordinal = _ordinal,
                    Port = context.Connection.RemotePort,
                };
                _drawn[connection.ConnectionHandle] = connection;
                _byToken[connection.ConnectionToken] = connection;
                _perAddress[address] = _perAddress.GetValueOrDefault(address) + 1;
                Rest(connection);
            }
        }

        if (connection is null)
        {
            await Finish(context, Busy);

            return;
        }

        _listeners.Tell(Connection, connection.ConnectionHandle);

        // the listen taken, said back, so a client whose header something on the way dropped never
        // listens where it would be refused
        var headers = new Dictionary<string, string> { [HttpTransport.ConnectionTokenHeader] = connection.ConnectionToken };

        if (listens)
        {
            headers[HttpTransport.ListenHeader] = "?1";
        }

        await Finish(context, new End(StatusCodes.Status201Created) { Headers = headers });
    }

    // one envelope of a connection drawn, received by the exchange
    private Task Receive(HttpContext context, Drawn connection)
    {
        return _exchange.Receive(context, connection);
    }

    // an exchange under way on its connection, its idle timer stopped; none past the bound on what
    // one connection has under way
    private Waiting? BeginExchange(Drawn connection, PipeReader reading)
    {
        Waiting? waiting = new() { Reading = reading };

        lock (_gate)
        {
            // a bound on what one connection has under way, cancels included, well past what its
            // waiting requests may be: those are refused at their prefix
            if (connection.Open >= 2 * _options.MaximumWaitingExchanges)
            {
                waiting = null;
            }
            else
            {
                connection.Open += 1;
                connection.LastActivity = _clock.GetUtcNow();
                StopIdle(connection);
            }
        }

        return waiting;
    }

    // an exchange done, both its request and its response: its connection rests once it has none
    private void EndExchange(Drawn connection)
    {
        lock (_gate)
        {
            connection.Open -= 1;

            if (_drawn.GetValueOrDefault(connection.ConnectionHandle) == connection)
            {
                Rest(connection);
            }
        }
    }

    // a body read whole: whether its connection is gone, and whether its exchange ended as it came
    private (bool IsGone, bool IsEnded) FinishBody((Drawn Connection, Waiting Waiting) call)
    {
        var (connection, waiting) = call;

        lock (_gate)
        {
            waiting.Reading = null;

            // its connection closed while its body came: its client learns it is gone
            if (_drawn.GetValueOrDefault(connection.ConnectionHandle) != connection)
            {
                waiting.IsEnded = true;

                return (true, true);
            }

            // answered while its body came: never handed on
            if (waiting.IsEnded)
            {
                return (false, true);
            }
        }

        return (false, false);
    }

    // a request about to go on to the router: whether it was answered first, and handed on when not
    private bool BeginHandOff(Waiting waiting)
    {
        bool isAnswered;

        lock (_gate)
        {
            isAnswered = waiting.IsEnded;
            waiting.IsDelivered = !isAnswered;
        }

        return isAnswered;
    }

    // a request handed on: whether it still waits for its answer, its timer armed when it does
    private bool WaitAfterHandOff((Drawn Connection, Waiting Waiting, uint CallId) call)
    {
        var (connection, waiting, callId) = call;
        bool isWaiting;

        lock (_gate)
        {
            // still waiting — not answered as it came — it waits for its answer no longer than it may
            isWaiting = connection.Waiting.GetValueOrDefault(callId) == waiting;

            if (isWaiting && _options.ExchangeTimeout != Timeout.InfiniteTimeSpan)
            {
                waiting.Timer = _clock.CreateTimer(
                    (_) =>
                    {
                        CloseDrawn(connection, false);
                    },
                    null,
                    _options.ExchangeTimeout,
                    Timeout.InfiniteTimeSpan);
            }
        }

        return isWaiting;
    }

    // bytes of body charged against the server's budget: whether it is now past it
    private bool ChargeBody(int count)
    {
        lock (_gate)
        {
            _bodyBytes += count;

            return _bodyBytes > _options.BodyBytesBudget;
        }
    }

    // bytes of body given back to the server's budget
    private void ReleaseBody(long charged)
    {
        lock (_gate)
        {
            _bodyBytes -= charged;
        }
    }

    // what the first 8 bytes say: a request waits under its call id from now on; or how the
    // exchange is refused
    private End? Classify(ReadOnlySpan<byte> head, (Drawn Connection, Waiting Waiting) call)
    {
        var (connection, waiting) = call;
        var layout = head[0];
        var kind = (EnvelopeKind)head[1];
        var callId = BinaryPrimitives.ReadUInt32BigEndian(head[4..]);

        if (layout is < HttpTransport.FirstLayout or > HttpTransport.LastLayout)
        {
            return Malformed;
        }

        lock (_gate)
        {
            if (kind != EnvelopeKind.Request)
            {
                waiting.Prefix = (callId, kind);

                return null;
            }

            // a client's call ids are odd, and none is 0
            if (callId % 2 == 0)
            {
                return Malformed;
            }

            if (connection.Waiting.ContainsKey(callId))
            {
                return new End(StatusCodes.Status409Conflict, HttpRefusals.CallWaiting);
            }

            if (connection.Waiting.Count >= _options.MaximumWaitingExchanges)
            {
                return new End(StatusCodes.Status429TooManyRequests, HttpRefusals.Busy);
            }

            waiting.Prefix = (callId, kind);

            if (connection.Buried.Remove(callId, out var burial))
            {
                burial.Dispose();
                waiting.IsCancelled = true;
            }

            connection.Waiting[callId] = waiting;

            return null;
        }
    }

    // a cancel is never answered: the exchange of its call ends empty — a 200 with no body once its
    // head went — or, its body still coming, once whole; one that has not come is buried
    private void Cancel((Drawn Connection, uint CallId) call)
    {
        var (connection, callId) = call;

        lock (_gate)
        {
            if (!connection.Waiting.TryGetValue(callId, out var cancelled))
            {
                Bury(connection, callId);
            }
            else if (cancelled.IsDelivered)
            {
                connection.Waiting.Remove(callId);
                cancelled.IsEnded = true;
                cancelled.Timer?.Dispose();
                cancelled.Ended.TrySetResult(new Ending { End = Nothing });
            }
            else
            {
                cancelled.IsCancelled = true;
            }
        }
    }

    // ends an exchange now, before its body or its answer
    private void EndEarly((Drawn Connection, Waiting Waiting) call)
    {
        var (connection, waiting) = call;

        lock (_gate)
        {
            waiting.IsEnded = true;
            waiting.Timer?.Dispose();

            if (waiting.Prefix is { } prefix && connection.Waiting.GetValueOrDefault(prefix.CallId) == waiting)
            {
                connection.Waiting.Remove(prefix.CallId);
            }
        }
    }

    // an exchange closed before the transport ended it: lost, its connection with it
    private void Lose((Drawn Connection, Waiting Waiting) call)
    {
        bool isLost;

        lock (_gate)
        {
            isLost = !call.Waiting.IsEnded;
        }

        if (isLost)
        {
            CloseDrawn(call.Connection, false);
        }
    }

    // a cancel that came before its request: the request, when it comes, is dropped; only the
    // client's call ids, and so many as a connection has requests waiting
    private void Bury(Drawn connection, uint callId)
    {
        if (callId % 2 == 0 || connection.Buried.Count >= _options.MaximumWaitingExchanges)
        {
            return;
        }

        if (connection.Buried.Remove(callId, out var previous))
        {
            previous.Dispose();
        }

        ITimer? burial = null;

        burial = _clock.CreateTimer(
            (_) =>
            {
                lock (_gate)
                {
                    if (connection.Buried.GetValueOrDefault(callId) == burial)
                    {
                        connection.Buried.Remove(callId);
                    }
                }
            },
            null,
            Burial,
            Timeout.InfiniteTimeSpan);
        connection.Buried[callId] = burial;
    }

    // a listen: what it acknowledges goes, and it brings back what is left — at once, or once
    // something comes within its wait. One listen at a time: a second ends the first, empty, and
    // takes its place. A listen its client loses closes nothing: what it carried comes again.
    private async Task Hold(HttpContext context, Drawn connection)
    {
        Holding?.Invoke(connection.ConnectionHandle);

        var after = HttpServerFields.CountOf(context.Request, HttpTransport.AfterHeader, new CountOptions { IsRequired = true });
        var wait = HttpServerFields.CountOf(context.Request, HttpTransport.WaitHeader);
        var listening = new Listening(connection);
        End? refused = null;

        lock (_gate)
        {
            // its token looked up again, as it is held: a connection closed since is gone
            if (_byToken.GetValueOrDefault(connection.ConnectionToken) != connection)
            {
                refused = Unknown;
            }
            else if (!connection.IsListening)
            {
                refused = new End(StatusCodes.Status409Conflict, HttpRefusals.ListenUndeclared);
            }
            else if (HttpServerFields.HasBody(context) || after is null || wait is null || after > connection.Sequence)
            {
                refused = Malformed;
            }
            else
            {
                connection.Outbox.RemoveAll((outgoing) =>
                {
                    return outgoing.Sequence <= after;
                });
                connection.OutboxBytes = connection.Outbox.Sum((outgoing) =>
                {
                    return (long)outgoing.Bytes.Length;
                });
                connection.Open += 1;
                connection.LastActivity = _clock.GetUtcNow();
                StopIdle(connection);

                if (connection.Listen is { } replaced)
                {
                    replaced.Replacer = listening;
                    Answer(replaced, Nothing);
                }

                if (connection.Outbox.Count > 0 || wait == 0)
                {
                    Answer(listening, Nothing);
                }
                else
                {
                    connection.Listen = listening;
                    listening.Timer = _clock.CreateTimer(
                        (_) =>
                        {
                            lock (_gate)
                            {
                                Answer(listening, Nothing);
                            }
                        },
                        null,
                        TimeSpan.FromMilliseconds(Math.Min(wait.Value, (long)_options.MaximumWait.TotalMilliseconds)),
                        Timeout.InfiniteTimeSpan);
                }
            }
        }

        if (refused is not null)
        {
            await Finish(context, refused);

            return;
        }

        try
        {
            _listeners.Tell(Listen, (true, connection.ConnectionHandle));
            listening.Told.TrySetResult();

            var ending = await listening.Ended.Task.WaitAsync(context.RequestAborted);

            if (ending.Sequence is { } sequence)
            {
                var response = context.Response;

                response.StatusCode = StatusCodes.Status200OK;
                HttpServerFields.StampOf(response);
                response.ContentType = HttpTransport.BatchMediaType;
                response.ContentLength = ending.Bytes.Length;
                response.Headers[HttpTransport.SequenceHeader] = sequence.ToString(CultureInfo.InvariantCulture);

                // ! at its pace: past it, an answer that could not be written, its exchange lost, its
                // connection dropped at both ends, reported (spec 15.7, 15.12)
                if (await WritePaced(context, (ending.Bytes, (_options.MinimumSendBytesPerSecond, _options.SendGracePeriod))))
                {
                    Drop((connection, ServerBounds.LateOf((_options.MinimumSendBytesPerSecond, _options.SendGracePeriod))));

                    return;
                }

                await response.CompleteAsync();
            }
            else
            {
                // ! a listen ended as its connection closes is 15.7's close, never told
                await (ending.IsGone ? HttpServerFields.EndWith(context, Unknown) : Finish(context, ending.End ?? Nothing));
            }
        }
        catch (Exception reason) when (reason is IOException or OperationCanceledException)
        {
            // a listen its client loses closes nothing: what it carried comes again to the next
        }
        finally
        {
            bool isDrawn;

            lock (_gate)
            {
                listening.Timer?.Dispose();

                if (connection.Listen == listening)
                {
                    connection.Listen = null;
                }

                connection.Open -= 1;
                isDrawn = _drawn.GetValueOrDefault(connection.ConnectionHandle) == connection;

                if (isDrawn)
                {
                    Rest(connection);
                }
            }

            // ! a listen another replaced tells its end once its replacer told it is held, as one
            // thread tells them: so a count of the listens held never falls to 0 as one takes over
            if (listening.Replacer is { } replacer)
            {
                await replacer.Told.Task;
            }

            if (isDrawn)
            {
                _listeners.Tell(Listen, (false, connection.ConnectionHandle));
            }
        }
    }

    // a listen ends: with what waits for it, as a batch, or, nothing waiting, with `end`; under the lock
    private static void Answer(Listening listening, End end)
    {
        var connection = listening.Connection;

        if (connection.Listen == listening)
        {
            connection.Listen = null;
        }

        listening.Timer?.Dispose();

        if (connection.Outbox.Count == 0)
        {
            listening.Ended.TrySetResult(new Ending { End = end });

            return;
        }

        // what waits follows what was acknowledged, one by one: the first is the last minus the rest
        var batch = new byte[connection.Outbox.Sum((outgoing) =>
        {
            return LengthBytes + outgoing.Bytes.Length;
        })];
        var offset = 0;

        foreach (var (bytes, _) in connection.Outbox)
        {
            BinaryPrimitives.WriteUInt32BigEndian(batch.AsSpan(offset), (uint)bytes.Length);
            bytes.CopyTo(batch.AsSpan(offset + LengthBytes));
            offset += LengthBytes + bytes.Length;
        }

        listening.Ended.TrySetResult(new Ending { Bytes = batch, Sequence = connection.Sequence - connection.Outbox.Count + 1 });
    }

    // an envelope of the server's own waits in its connection's outbox, numbered, for a listen to
    // bring it back; false past the outbox's bound, its client having fallen behind; under the lock
    private bool Enqueue(Drawn connection, ReadOnlyMemory<byte> bytes)
    {
        if (connection.OutboxBytes + bytes.Length > _options.MaximumOutboxBytes)
        {
            return false;
        }

        connection.Sequence += 1;
        connection.Outbox.Add((bytes.ToArray(), connection.Sequence));
        connection.OutboxBytes += bytes.Length;

        if (connection.Listen is { } listening)
        {
            Answer(listening, Nothing);
        }

        return true;
    }

    // a connection idle — no exchange under way — closes past its timeout; under the lock
    private void Rest(Drawn connection)
    {
        StopIdle(connection);

        if (_options.InactivityTimeout == Timeout.InfiniteTimeSpan || connection.Open > 0)
        {
            return;
        }

        connection.Idle = _clock.CreateTimer(
            (_) =>
            {
                CloseDrawn(connection, false);
            },
            null,
            _options.InactivityTimeout,
            Timeout.InfiniteTimeSpan);
    }

    private static void StopIdle(Drawn connection)
    {
        connection.Idle?.Dispose();
        connection.Idle = null;
    }

    private void CloseDrawn(Drawn connection, bool isClean)
    {
        if (Take(connection))
        {
            _listeners.Tell(Close, (isClean, connection.ConnectionHandle));
        }
    }

    // a connection's end begun, false once begun already: out of the registry, each exchange still
    // waiting told by the marked 404 until its request is handed on, then by its exchange cut after
    // its head, as a lost one is: a request handed on ran, which no refusal may deny
    private bool Take(Drawn connection)
    {
        // the bodies still coming of the requests waiting, whose reads are ended, so each is answered
        // the marked 404 now, its head not out
        var interrupted = new List<PipeReader>();

        lock (_gate)
        {
            if (_drawn.GetValueOrDefault(connection.ConnectionHandle) != connection)
            {
                return false;
            }

            _drawn.Remove(connection.ConnectionHandle);
            _byToken.Remove(connection.ConnectionToken);

            var others = _perAddress.GetValueOrDefault(connection.Address) - 1;

            if (others == 0)
            {
                _perAddress.Remove(connection.Address);
            }
            else
            {
                _perAddress[connection.Address] = others;
            }

            StopIdle(connection);

            foreach (var burial in connection.Buried.Values)
            {
                burial.Dispose();
            }

            connection.Buried.Clear();

            foreach (var waiting in connection.Waiting.Values)
            {
                waiting.IsEnded = true;
                waiting.Timer?.Dispose();
                waiting.Ended.TrySetResult(new Ending { IsDelivered = waiting.IsDelivered, IsGone = true });

                if (waiting.Reading is { } reading)
                {
                    interrupted.Add(reading);
                }
            }

            connection.Waiting.Clear();
            connection.Outbox.Clear();
            connection.OutboxBytes = 0;

            if (connection.Listen is { } listening)
            {
                connection.Listen = null;
                listening.Timer?.Dispose();
                listening.Ended.TrySetResult(new Ending { IsGone = true });
            }
        }

        foreach (var reading in interrupted)
        {
            reading.CancelPendingRead();
        }

        return true;
    }

    // a listen held until something comes for it, or its wait is over; touched under the lock
    private sealed class Listening(Drawn connection)
    {
        public Drawn Connection { get; } = connection;

        public ITimer? Timer { get; set; }

        public TaskCompletionSource<Ending> Ended { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        // the listen that took its place, set under the lock as it does
        public Listening? Replacer { get; set; }

        // done once its own start is told
        public TaskCompletionSource Told { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    // a connection's own state, which nothing outside the transport reaches; touched under the lock
    private sealed class Drawn((string Address, string ConnectionHandle, string ConnectionToken) names, bool isListening)
    {
        public string Address { get; } = names.Address;

        public string ConnectionHandle { get; } = names.ConnectionHandle;

        public string ConnectionToken { get; } = names.ConnectionToken;

        // its client said at connect that it listens: the server may send of its own
        public bool IsListening { get; } = isListening;

        // the rank it was drawn at, which its handle ends with
        public required long Ordinal { get; init; }

        // its client's port at connect
        public required int Port { get; init; }

        // when an exchange of an envelope, or a listen, last began on it; none until one has
        public DateTimeOffset? LastActivity { get; set; }

        // the call ids of the client's a cancel came for before their request, each until it lapses
        public Dictionary<uint, ITimer> Buried { get; } = [];

        public ITimer? Idle { get; set; }

        // the listen held, when one is
        public Listening? Listen { get; set; }

        // the exchanges under way, listens included: the connection is idle at none
        public int Open { get; set; }

        // what the server sent of its own and no listen acknowledged yet, in order
        public List<(byte[] Bytes, long Sequence)> Outbox { get; } = [];

        public long OutboxBytes { get; set; }

        // the number of the last envelope put in the outbox; the first is 1
        public long Sequence { get; set; }

        // the exchanges of requests, by call id, from their first 8 bytes to their answer
        public Dictionary<uint, Waiting> Waiting { get; } = [];
    }
}
