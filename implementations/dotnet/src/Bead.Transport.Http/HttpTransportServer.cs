using System.Buffers.Binary;
using System.Buffers.Text;
using System.IO.Pipelines;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Bead.Transport.Http;

/// <summary>How an HTTP transport server holds its connections, and what it bounds.</summary>
public sealed record HttpTransportServerOptions
{
    /// <summary>The bytes of body the exchanges under way may hold together: 256 MiB by default; past it, 503.</summary>
    public long BodyBytesBudget { get; init; } = 268_435_456;

    /// <summary>
    /// How long a request handed on waits for its answer: 5 minutes by default; from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one, or infinite
    /// for none; zero is refused.
    /// </summary>
    public TimeSpan ExchangeTimeout { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>
    /// The hosts a request may name besides those every server takes — <c>localhost</c>, a name
    /// under <c>.localhost</c>, an IPv6 address in brackets and an IPv4 address — each a host
    /// without its port, taken on any port, in any ASCII case, in the form the field carries, an IDN
    /// host in punycode: none besides when none or empty. A request names its host by its
    /// authority: an absolute-form target's, else its <c>Host</c>, which carries HTTP/2's
    /// <c>:authority</c> (spec 15.12). <c>*</c>, alone, takes every host, an empty one and none,
    /// and so takes a page that rebinds its name to the server's address again: the server judges
    /// its own origin by the request's authority, so this is what refuses one. An entry with a
    /// port, an empty one, one that is no host, and <c>*</c> beside another are an
    /// <see cref="ArgumentException"/> as the transport is built. A server reached by a name, a
    /// public one, one behind a proxy that keeps the <c>Host</c>, a service reached by its name in a
    /// cluster, names it here, or refuses it 403, <c>host-refused</c>, which the transport tells
    /// through <see cref="HttpTransportServer.Refusal"/>.
    /// </summary>
    public IReadOnlyList<string>? Hosts { get; init; }

    /// <summary>
    /// How long a connection may go with no exchange under way: 5 minutes by default; from 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one, or infinite
    /// for none; zero is refused.
    /// </summary>
    public TimeSpan InactivityTimeout { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Whether a proxy on this machine is trusted: the last address it forwards in
    /// <c>x-forwarded-for</c> is then the client's, which the bound per address counts.
    /// </summary>
    public bool IsProxyTrusted { get; init; }

    /// <summary>The largest body: a router's largest envelope by default; past it, 413.</summary>
    public int MaximumBodyBytes { get; init; } = LimitDefaults.MaximumEnvelopeBytes;

    /// <summary>The connections drawn at once: 10,000 by default.</summary>
    public int MaximumConnections { get; init; } = 10_000;

    /// <summary>The connections one address holds at once: 64 by default.</summary>
    public int MaximumConnectionsPerAddress { get; init; } = 64;

    /// <summary>The bytes one connection's outbox holds: two of the largest envelopes by default; past it, the connection closes.</summary>
    public long MaximumOutboxBytes { get; init; } = 2L * LimitDefaults.MaximumEnvelopeBytes;

    /// <summary>
    /// The longest a listen waits for something to bring back: 30 seconds by default, under an
    /// intermediary's 60; from 1 to <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the
    /// nearest whole one; zero and infinite are refused.
    /// </summary>
    public TimeSpan MaximumWait { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>The requests one connection has waiting at once: 64 by default; the exchanges under way on it, twice that.</summary>
    public int MaximumWaitingExchanges { get; init; } = 64;

    /// <summary>
    /// The origins an exchange that sends an <c>Origin</c> may come from besides the server's own,
    /// <c>http://</c> or <c>https://</c> followed by its request's authority, each compared exactly:
    /// none by default. It serves a proxy that rewrites the host, and a page of another origin, to
    /// which the server answers CORS (spec 15.12): its preflight 204, and on every answer once its
    /// origin is judged <c>Access-Control-Allow-Origin</c> and every field exposed, never
    /// <c>Access-Control-Allow-Credentials</c>. <c>null</c> among them takes, and lets read every
    /// answer, every page that sends it. Each is <c>null</c> or an origin as RFC 6454 §6.2
    /// serializes it; <c>*</c>, which no origin is, and any other entry are an
    /// <see cref="ArgumentException"/> as the transport is built.
    /// </summary>
    public IReadOnlyList<string> Origins { get; init; } = [];

    /// <summary>The path the transport answers on.</summary>
    public string Pathname { get; init; } = HttpTransport.Pathname;

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
}

/// <summary>Where an HTTP transport server listens.</summary>
public sealed record HttpTransportStartOptions
{
    /// <summary>
    /// The address it listens on (spec 15.12), an IP address written bare: <c>127.0.0.1</c>, the
    /// loopback, by default; <c>0.0.0.0</c> or <c>::</c> for every interface, which a container, or any
    /// server another machine reaches, needs, its hosts named beside. RFC 3986's <c>IPv4address</c> or
    /// <c>IPv6address</c>, with no brackets, no zone, and not IPv4-mapped; a name or any other form is
    /// an <see cref="ArgumentException"/> as it starts, which ends Closed.
    /// </summary>
    public string Address { get; init; } = "127.0.0.1";

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
public sealed class HttpTransportServer : IServerTransport, IAsyncDisposable
{
    private const int TokenBytes = 16;
    private const int LengthBytes = 4;
    private const int ReadBytes = 65_536;

    // the error a stream of a malformed request is reset with over HTTP/2 (RFC 9113 §7)
    private const int ProtocolError = 0x1;

    // what a cancel that came before its request buries that call id for: the least a requester
    // reserves one for
    private static readonly TimeSpan Burial = TimeSpan.FromSeconds(5);

    // how long a stop lets the exchanges under way write their end before it cuts them, at most: an
    // end its closes wrote is a few bytes, where the TypeScript side's go out as they are written,
    // and a client that does not read holds the stop back no longer than this
    private static readonly TimeSpan EndsGrace = TimeSpan.FromSeconds(1);

    // the addresses of this machine, from which a proxy in front of the transport comes
    private static readonly HashSet<string> Loopback = ["127.0.0.1", "::1"];

    private static readonly End Nothing = new(StatusCodes.Status204NoContent);
    private static readonly End Malformed = new(StatusCodes.Status400BadRequest, HttpRefusals.Malformed);
    private static readonly End Unknown = new(StatusCodes.Status404NotFound, HttpRefusals.ConnectionUnknown);
    private static readonly End Busy = new(StatusCodes.Status503ServiceUnavailable, HttpRefusals.Busy, new Dictionary<string, string> { ["retry-after"] = "1" });

    private readonly HttpTransportServerOptions _options;
    private readonly TimeProvider _clock;

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

    // whether its connections are secure: as its application says what stands in front of it, or,
    // when it says nothing, under TLS, wherever it listens, or bound to the loopback as it starts
    private volatile bool _isSecure;

    /// <summary>
    /// A transport server, not yet listening, its durations held. A bound not above 0, or a timeout
    /// that is not from 1 to <see cref="Clocks.LongestTimer"/> milliseconds — infinite aside, but for
    /// the longest wait — is an <see cref="ArgumentOutOfRangeException"/> naming it; an entry of its
    /// hosts or origins neither takes, an <see cref="ArgumentException"/> naming it.
    /// </summary>
    public HttpTransportServer(HttpTransportServerOptions? options = null)
    {
        var given = options ?? new HttpTransportServerOptions();

        HostsAndOrigins.AssertHosts(given.Hosts, nameof(HttpTransportServerOptions.Hosts));
        HostsAndOrigins.AssertOrigins(given.Origins, nameof(HttpTransportServerOptions.Origins));
        AssertWhole((nameof(HttpTransportServerOptions.BodyBytesBudget), given.BodyBytesBudget));

        var exchangeTimeout = Clocks.AssertHeld((nameof(HttpTransportServerOptions.ExchangeTimeout), nameof(HttpTransportServerOptions.ExchangeTimeout)), given.ExchangeTimeout);
        var inactivityTimeout = Clocks.AssertHeld((nameof(HttpTransportServerOptions.InactivityTimeout), nameof(HttpTransportServerOptions.InactivityTimeout)), given.InactivityTimeout);

        AssertWhole((nameof(HttpTransportServerOptions.MaximumBodyBytes), given.MaximumBodyBytes));
        AssertWhole((nameof(HttpTransportServerOptions.MaximumConnections), given.MaximumConnections));
        AssertWhole((nameof(HttpTransportServerOptions.MaximumConnectionsPerAddress), given.MaximumConnectionsPerAddress));
        AssertWhole((nameof(HttpTransportServerOptions.MaximumOutboxBytes), given.MaximumOutboxBytes));

        var maximumWait = Clocks.AssertHeldFinite((nameof(HttpTransportServerOptions.MaximumWait), nameof(HttpTransportServerOptions.MaximumWait)), given.MaximumWait);

        AssertWhole((nameof(HttpTransportServerOptions.MaximumWaitingExchanges), given.MaximumWaitingExchanges));
        _options = given with { ExchangeTimeout = exchangeTimeout, InactivityTimeout = inactivityTimeout, MaximumWait = maximumWait };
        _isSecure = _options.Secure ?? _options.Certificate is not null;
        _clock = _options.Clock ?? TimeProvider.System;
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
    /// What a listener of its events threw, with the handle of the connection it was told of: the
    /// transport went on as if it returned (spec 15.1). With an empty handle for a throw of a
    /// <see cref="Refusal"/> listener alone, which names no connection; never the server's own
    /// failure, as the TypeScript side's can be: Kestrel tells a failure of its own only to its logs.
    /// </summary>
    public event Action<Exception, string>? Error;

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
    /// What it keeps of its connections, at the ceilings it has: the connections, the addresses, the
    /// bytes of body being read, the call ids buried, the listens held, what the outboxes hold and the
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

    // builds its application and starts it; what a failed start built goes with it
    private async Task<TransportServerAddress> Starting((HttpTransportStartOptions Start, CancellationToken Token) call)
    {
        var (start, cancellationToken) = call;
        WebApplication? application = null;
        TransportServerAddress bound;

        // ! an IP address by RFC 3986's grammar before the platform's parser reads it: it takes 0 for
        // 0.0.0.0, every interface, and 127.1, octal, hexadecimal and a zone besides
        HostsAndOrigins.AssertAddress(start.Address, nameof(HttpTransportStartOptions.Address));

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

                // the transport counts each body against its own limit and budget
                kestrel.Limits.MaxRequestBodySize = null;
                kestrel.Listen(IPAddress.Parse(start.Address), start.FindOpenPort ? 0 : start.Port, (listen) =>
                {
                    if (_options.Certificate is { } certificate)
                    {
                        listen.Protocols = HttpProtocols.Http1AndHttp2;
                        listen.UseHttps(certificate);
                    }
                });
            });
            application = builder.Build();
            application.Run(Exchanging);
            await application.StartAsync(cancellationToken);

            var addresses = application.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()
                ?? throw new InvalidOperationException("Kestrel says nothing of where it listens");

            bound = new TransportServerAddress(start.Address, new Uri(addresses.Addresses.First()).Port);
            _isSecure = _options.Secure ?? TransportSecurity.IsSecure((_options.Certificate is not null, start.Address));
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

        if (overflowing is not null)
        {
            CloseDrawn(overflowing, false);
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
        if (bound.Value < 1)
        {
            throw new ArgumentOutOfRangeException(bound.Name, $"{bound.Name} is a whole number above 0, not {bound.Value}");
        }
    }

    // whether the request says it has a body: a length above 0, or a transfer coding, as its headers
    // say it and as the TypeScript side reads them — never whether HTTP/2's end of stream has come
    // in yet, which an empty body's last frame races
    private static bool HasBody(HttpContext context)
    {
        return context.Request.ContentLength is > 0 || context.Request.Headers.ContainsKey(HeaderNames.TransferEncoding);
    }

    // a body of Bead's media type, parameters aside, sent as it is
    private static bool IsBeadBody(HttpRequest request)
    {
        var types = request.Headers.ContentType;
        var type = (types.Count == 0 ? null : types[0])?.Split(';')[0].Trim().ToLowerInvariant();
        var encoding = HeaderOf(request, HeaderNames.ContentEncoding)?.Trim().ToLowerInvariant();

        return type == HttpTransport.MediaType && encoding is null or "identity";
    }

    // whether a connect says its client listens: an Item whose bare item is a Boolean, its
    // parameters ignored (RFC 9651 §2.3), absent being ?0; anything else is none
    private static bool? ListeningOf(HttpRequest request)
    {
        return StructuredFields.ParseItem(HeaderOf(request, HttpTransport.ListenHeader) ?? "?0")?.BareItem as bool?;
    }

    // a CORS preflight's answer from an origin the server lists, whatever method it asks for: the
    // browser judges its request against it (Fetch §4.8). Authorization is named, since no wildcard
    // covers it; then the names the preflight asks, its lines joined by ", " (RFC 9110 §5.3), since
    // a browser may cache a name where it caches no wildcard; then `*`, a wildcard for a request
    // without credentials (Fetch §3.3.4), which every request to the server is. No Vary names what
    // it asked: no cache stores an answer to OPTIONS (RFC 9110 §9.3.7)
    private static End PreflightOf(HttpRequest request)
    {
        // ! joined by ", " here, as Node joins them: StringValues.ToString() joins by ","
        var asked = string.Join(", ", request.Headers.AccessControlRequestHeaders.AsEnumerable());
        string[] allowed = asked.Length == 0 ? ["authorization", "*"] : ["authorization", asked, "*"];

        return new End(StatusCodes.Status204NoContent, null, new Dictionary<string, string>
        {
            ["access-control-allow-methods"] = "GET, POST, DELETE",
            ["access-control-allow-headers"] = string.Join(", ", allowed),
            ["access-control-max-age"] = "7200",
        });
    }

    // a header as the request gives it, given twice as one; none when absent, which is not empty
    private static string? HeaderOf(HttpRequest request, string name)
    {
        var values = request.Headers[name];

        return values.Count == 0 ? null : values.ToString();
    }

    // the credential a request's Authorization carries: its value whole, without the spaces and tabs
    // around it (RFC 9110 §5.5); none when nothing is left
    private static string? CredentialOf(HttpRequest request)
    {
        var values = request.Headers.Authorization;
        var value = values.Count == 0 ? "" : (values[0] ?? "").Trim(' ', '\t');

        return value.Length == 0 ? null : value;
    }

    // a count a listen gives in its field (spec 15.9): an Item whose bare item is an Integer of 0 or
    // more, its parameters ignored (RFC 9651 §2.3), its lines joined, so two lines never parse.
    // Absent, it is 0, or none where it is required; anything else is none
    private static long? CountOf(HttpRequest request, string name, CountOptions? options = null)
    {
        if (HeaderOf(request, name) is not { } value)
        {
            return options is { IsRequired: true } ? null : 0;
        }

        return StructuredFields.ParseItem(value)?.BareItem is long count and >= 0 ? count : null;
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
        if (!context.Response.HasStarted && end.Status >= 400 && HasBody(context))
        {
            CloseBehind(context);
        }

        await EndWith(context, end);

        // * built only when a listener listens
        if (end.Reason is { } reason && Refusal is { } listeners)
        {
            var refusal = new TransportServerRefusal(
                AddressOf(context),
                AuthorityOf(context),
                HostsAndOrigins.OriginOf(context.Request.Headers.Origin),
                context.Connection.RemotePort,
                reason,
                end.Status);

            _listeners.Tell(listeners, refusal);
        }
    }

    // the authority a request names, as it came (spec 15.12): an HTTP/1 request's absolute-form
    // target's, else its Host's; none when it names none
    private static string? AuthorityOf(HttpContext context)
    {
        return HostsAndOrigins.AuthorityOf(context.Request.Headers.Host, TargetAuthorityOf(context));
    }

    // the authority an HTTP/1 request's target names in absolute-form; none for another form, and
    // over HTTP/2, whose :authority Kestrel has put in the Host
    private static string? TargetAuthorityOf(HttpContext context)
    {
        var request = context.Request;
        var isHttp1 = HttpProtocol.IsHttp10(request.Protocol) || HttpProtocol.IsHttp11(request.Protocol);

        return isHttp1 ? HostsAndOrigins.TargetAuthorityOf(context.Features.Get<IHttpRequestFeature>()?.RawTarget) : null;
    }

    // whether every field value of a request is one a server reads (spec 15.12): visible ASCII, SP
    // and HTAB alone, neither SP nor HTAB at either end
    private static bool HasVisibleFields(HttpRequest request)
    {
        return request.Headers.All((field) =>
        {
            return field.Value.All((value) =>
            {
                return HostsAndOrigins.IsVisibleField(value ?? "");
            });
        });
    }

    // closes an HTTP/1 socket behind its exchange, whose body is not read: what follows would read as
    // the next request
    private static void CloseBehind(HttpContext context)
    {
        if (!HttpProtocol.IsHttp2(context.Request.Protocol) && !HttpProtocol.IsHttp3(context.Request.Protocol))
        {
            context.Response.Headers.Connection = "close";
        }
    }

    // writes an exchange's end, once: its status and headers, marked when it is a refusal
    // ! never told: the 404 of a connection that closes is 15.7's close, told by Close, never a
    // refusal; Finish tells what the transport judges
    private static async Task EndWith(HttpContext context, End end)
    {
        var response = context.Response;

        if (!response.HasStarted)
        {
            response.StatusCode = end.Status;
            StampOf(response);

            foreach (var (name, value) in end.Headers ?? new Dictionary<string, string>())
            {
                response.Headers[name] = value;
            }

            if (end.Reason is { } reason)
            {
                response.Headers[HttpTransport.RefusalHeader] = reason;
            }
        }

        await response.CompleteAsync();
    }

    // what every response on the path carries: never stored, never sniffed, and which one a request
    // gets turns on its Origin (RFC 9110 §12.5.5)
    private static void StampOf(HttpResponse response)
    {
        response.Headers.CacheControl = "no-store";
        response.Headers.XContentTypeOptions = "nosniff";
        response.Headers.Vary = "Origin";
    }

    // what HTTP refuses of its own, as Kestrel answers it: 400, unmarked, none of the path's fields,
    // its socket closed behind it, nothing told (spec 15.12)
    private static async Task RefuseMalformed(HttpContext context)
    {
        var response = context.Response;

        if (!response.HasStarted)
        {
            response.StatusCode = StatusCodes.Status400BadRequest;
            response.Headers.Connection = "close";
        }

        await response.CompleteAsync();
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

    // the client's address: the socket's, or, behind a proxy on this machine the transport trusts,
    // the last one it forwarded — an address, or nothing of it is taken
    private string? AddressOf(HttpContext context)
    {
        if (context.Connection.RemoteIpAddress is not { } remote)
        {
            return null;
        }

        var address = (remote.IsIPv4MappedToIPv6 ? remote.MapToIPv4() : remote).ToString();
        var forwarded = context.Request.Headers["x-forwarded-for"].ToString().Split(',')[^1].Trim();

        // an address written as one, as isIP reads it: an IPv4 one in its four numbers alone
        var isAddress = IPAddress.TryParse(forwarded, out var parsed)
            && (parsed.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 || parsed.ToString() == forwarded);

        return _options.IsProxyTrusted && Loopback.Contains(address) && isAddress ? forwarded : address;
    }

    // an exchange from the server's own origin, its request's authority under http or https, or one
    // it was told; one with no Origin comes from anywhere, and any client that sends one is judged by it
    private bool IsAllowedOrigin((HttpRequest Request, string? Authority) exchange)
    {
        return HostsAndOrigins.IsTakenOrigin(HeaderOf(exchange.Request, HeaderNames.Origin), (exchange.Authority, _options.Origins));
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
    }

    private async Task Exchange(HttpContext context)
    {
        var request = context.Request;

        // * a field HTTP would call malformed before anything else is judged (spec 15.12): Kestrel
        // refuses 400 an octet that is no UTF-8, and decodes the rest, a character past ASCII among
        // them, and takes a control character, or a value with a space or a tab at either end over
        // HTTP/2 (RFC 9113 §8.2.1), which this refuses as HTTP refuses a malformed field — over
        // HTTP/2 by resetting the stream, PROTOCOL_ERROR, as Kestrel resets one of its own
        if (!HasVisibleFields(request))
        {
            if (HttpProtocol.IsHttp2(request.Protocol) && context.Features.Get<IHttpResetFeature>() is { } reset)
            {
                reset.Reset(ProtocolError);

                return;
            }

            await RefuseMalformed(context);

            return;
        }

        // ! the authority as it came, which a browser writes as it writes its Origin, an IDN in
        // punycode: Request.Host turns punycode into Unicode, and throws on what decodes to none.
        // Kestrel has put HTTP/2's :authority in the Host; an absolute-form target's it reads
        // through a Uri, which lowers its case and drops a default or an empty port and a userinfo,
        // so it is read from the target as it came, and judged as HTTP judges a Host
        var targetAuthority = TargetAuthorityOf(context);

        if (targetAuthority is not null && !HostsAndOrigins.IsAuthority(targetAuthority))
        {
            await RefuseMalformed(context);

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

        var origin = HeaderOf(request, HeaderNames.Origin);
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
            await EndWith(context, PreflightOf(request));

            return;
        }

        if (!HttpMethods.IsGet(request.Method) && !HttpMethods.IsPost(request.Method) && !HttpMethods.IsDelete(request.Method))
        {
            await Finish(context, new End(StatusCodes.Status405MethodNotAllowed, HttpRefusals.Method, new Dictionary<string, string> { ["allow"] = "GET, POST, DELETE" }));

            return;
        }

        var connectionToken = HeaderOf(request, HttpTransport.ConnectionTokenHeader);

        if (connectionToken is null && HttpMethods.IsPost(request.Method))
        {
            await (IsBeadBody(request) ? Connect(context) : Finish(context, new End(StatusCodes.Status415UnsupportedMediaType, HttpRefusals.Type)));

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

        await (IsBeadBody(request) ? Receive(context, connection) : Finish(context, new End(StatusCodes.Status415UnsupportedMediaType, HttpRefusals.Type)));
    }

    // a connect: a connection drawn, registered before its client has its token
    private async Task Connect(HttpContext context)
    {
        var address = AddressOf(context);
        var isListening = ListeningOf(context.Request);

        // a connect carries no body, and says whether it listens in the one way
        if (HasBody(context) || address is null || isListening is not { } listens)
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

        await Finish(context, new End(StatusCodes.Status201Created, null, headers));
    }

    // one envelope: read into one buffer, its prefix checked from its first 8 bytes, then handed on;
    // a request waits for its answer
    private async Task Receive(HttpContext context, Drawn connection)
    {
        // ! a field that is no list is not combined (RFC 9110 §5.3): two are refused before either
        // could be taken for the other
        if (context.Request.Headers.Authorization.Count > 1)
        {
            await Finish(context, Malformed);

            return;
        }

        if (context.Request.ContentLength > _options.MaximumBodyBytes)
        {
            await Finish(context, new End(StatusCodes.Status413PayloadTooLarge, HttpRefusals.TooLarge));

            return;
        }

        var waiting = new Waiting { Reading = context.Request.BodyReader };

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

        if (waiting is null)
        {
            await Finish(context, new End(StatusCodes.Status429TooManyRequests, HttpRefusals.Busy));

            return;
        }

        // closed before the transport ended it: lost, as a dropped socket's frames are
        using var lost = context.RequestAborted.Register(() =>
        {
            Lose((connection, waiting));
        });

        try
        {
            var (envelope, end) = await BodyOf(context, (connection, waiting));

            // handed on; or ended as it came — answered, by an answer no request handed on was owed,
            // or its connection closed — and so never handed on
            if (end is null)
            {
                // its body still coming, which is not read on: its socket closes behind its end
                if (waiting.Reading is not null)
                {
                    CloseBehind(context);
                }

                end = envelope is { } bytes ? await Hand(context, (connection, waiting, bytes)) : await Reply(context, waiting);
            }

            if (end is not null)
            {
                EndEarly((connection, waiting));

                // told its connection is gone, and nothing more: what it read whole keeps its socket
                await (end == Unknown ? EndWith(context, end) : Finish(context, end));
            }
        }
        catch (Exception reason) when (reason is IOException or OperationCanceledException or Microsoft.AspNetCore.Http.BadHttpRequestException)
        {
            // the client went: lost, as its abort says — which may have resumed this exchange, and
            // ended its registration, before that one ran
            Lose((connection, waiting));
        }
        finally
        {
            waiting.Written.TrySetException(new IOException("the exchange closed before its answer went out"));

            lock (_gate)
            {
                connection.Open -= 1;

                if (_drawn.GetValueOrDefault(connection.ConnectionHandle) == connection)
                {
                    Rest(connection);
                }
            }
        }
    }

    // the body, read whole and counted against the limit and the budget as it comes; or how its
    // exchange ends early, no more of it read
    private async Task<(byte[]? Envelope, End? End)> BodyOf(HttpContext context, (Drawn Connection, Waiting Waiting) call)
    {
        var (connection, waiting) = call;
        var declared = context.Request.ContentLength;
        var body = new byte[(int)Math.Min(declared ?? ReadBytes, ReadBytes)];
        var read = new byte[ReadBytes];
        var length = 0;
        long charged = 0;
        var isClassified = false;

        try
        {
            while (true)
            {
                int count;

                try
                {
                    count = await context.Request.Body.ReadAsync(read, context.RequestAborted);
                }
                catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
                {
                    // its read ended as it waited under its call id, its body still coming: its
                    // connection closed, or its answer came; its client learns it at once
                    return (null, null);
                }

                if (count == 0)
                {
                    break;
                }

                bool isOverBudget;

                lock (_gate)
                {
                    _bodyBytes += count;
                    charged += count;
                    isOverBudget = _bodyBytes > _options.BodyBytesBudget;
                }

                // past the limit, it is refused, and then no more of it is read
                if (charged > _options.MaximumBodyBytes)
                {
                    return (null, new End(StatusCodes.Status413PayloadTooLarge, HttpRefusals.TooLarge));
                }

                if (isOverBudget)
                {
                    return (null, Busy);
                }

                // a cancel came for it while it came: read to its end, and dropped
                if (waiting.IsCancelled)
                {
                    continue;
                }

                if (length + count > body.Length)
                {
                    Array.Resize(ref body, Math.Min(Math.Max(length + count, 2 * body.Length), _options.MaximumBodyBytes));
                }

                read.AsSpan(0, count).CopyTo(body.AsSpan(length));
                length += count;

                if (!isClassified && length >= HttpTransport.PrefixBytes)
                {
                    isClassified = true;

                    if (Classify(body.AsSpan(0, HttpTransport.PrefixBytes), (connection, waiting)) is { } refused)
                    {
                        return (null, refused);
                    }
                }
            }
        }
        finally
        {
            lock (_gate)
            {
                _bodyBytes -= charged;
            }
        }

        lock (_gate)
        {
            waiting.Reading = null;

            // its connection closed while its body came: its client learns it is gone
            if (_drawn.GetValueOrDefault(connection.ConnectionHandle) != connection)
            {
                waiting.IsEnded = true;

                return (null, Unknown);
            }

            // answered while its body came: never handed on
            if (waiting.IsEnded)
            {
                return (null, null);
            }
        }

        if (waiting.Prefix is null)
        {
            return (null, Malformed);
        }

        // its cancel came first, or while it came: dropped, and ended empty
        return waiting.IsCancelled ? (null, Nothing) : (body.AsSpan(0, length).ToArray(), null);
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

    // an envelope whole, handed on: a request waits for its answer, its head going now so its client
    // knows the router has it; a cancel ends the exchange of its call, or buries its call id; any
    // other ends empty
    private async Task<End?> Hand(HttpContext context, (Drawn Connection, Waiting Waiting, byte[] Envelope) call)
    {
        var (connection, waiting, envelope) = call;
        var (callId, kind) = waiting.Prefix!.Value;

        if (kind != EnvelopeKind.Request)
        {
            _listeners.Tell(Message, (new TransportMessage(envelope, false), connection.ConnectionHandle));

            if (kind == EnvelopeKind.Cancel)
            {
                Cancel((connection, callId));
            }

            return Nothing;
        }

        bool isAnswered;

        lock (_gate)
        {
            isAnswered = waiting.IsEnded;
            waiting.IsDelivered = !isAnswered;
        }

        if (isAnswered)
        {
            return await Reply(context, waiting);
        }

        // a request is handed on with the credential its exchange carried; no other envelope is
        _listeners.Tell(Message, (new TransportMessage(envelope, false) { Credential = CredentialOf(context.Request) }, connection.ConnectionHandle));

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

        if (isWaiting)
        {
            await SendHead(context);
        }

        return await Reply(context, waiting);
    }

    // a request's head, a 200 of Bead's type, which says the router has it: once, before its answer
    private static async Task SendHead(HttpContext context)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            StampOf(context.Response);
            context.Response.ContentType = HttpTransport.MediaType;
            await context.Response.StartAsync(context.RequestAborted);
            await context.Response.Body.FlushAsync(context.RequestAborted);
        }
    }

    // a request's answer, once it comes: written, or how its exchange ends instead — its connection
    // gone once its request was handed on, its head goes before its exchange is cut: a request
    // handed on ran, which no refusal may deny
    private async Task<End?> Reply(HttpContext context, Waiting waiting)
    {
        var ending = await waiting.Ended.Task.WaitAsync(context.RequestAborted);

        if (ending.IsGone)
        {
            if (ending.IsDelivered)
            {
                await SendHead(context);
            }

            if (context.Response.HasStarted)
            {
                context.Abort();

                return null;
            }

            return Unknown;
        }

        if (ending.End is { } end)
        {
            return end;
        }

        if (Answering is { } answering)
        {
            await answering(context.RequestAborted);
        }

        try
        {
            if (!context.Response.HasStarted)
            {
                context.Response.StatusCode = StatusCodes.Status200OK;
                StampOf(context.Response);
                context.Response.ContentType = HttpTransport.MediaType;
                context.Response.ContentLength = ending.Bytes.Length;
            }

            await context.Response.Body.WriteAsync(ending.Bytes, context.RequestAborted);

            // Kestrel drops a write to a client gone without a word, before its abort is told: a
            // flush that finds nothing reading says the answer never went out whole
            if ((await context.Response.BodyWriter.FlushAsync(context.RequestAborted)).IsCompleted)
            {
                throw new IOException("the exchange closed before its answer went out");
            }

            await context.Response.CompleteAsync();
            waiting.Written.TrySetResult();
        }
        catch (Exception reason) when (reason is IOException or OperationCanceledException)
        {
            waiting.Written.TrySetException(new IOException("the exchange closed before its answer went out", reason));
        }

        return null;
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
    // something comes within its wait. One listen at a time: a second ends the first, which brings
    // back nothing, and takes its place. A listen lost closes nothing: what it carried comes again.
    private async Task Hold(HttpContext context, Drawn connection)
    {
        Holding?.Invoke(connection.ConnectionHandle);

        var after = CountOf(context.Request, HttpTransport.AfterHeader, new CountOptions { IsRequired = true });
        var wait = CountOf(context.Request, HttpTransport.WaitHeader);
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
            else if (HasBody(context) || after is null || wait is null || after > connection.Sequence)
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

            var ending = await listening.Ended.Task.WaitAsync(context.RequestAborted);

            if (ending.Sequence is { } sequence)
            {
                var response = context.Response;

                response.StatusCode = StatusCodes.Status200OK;
                StampOf(response);
                response.ContentType = HttpTransport.BatchMediaType;
                response.ContentLength = ending.Bytes.Length;
                response.Headers[HttpTransport.SequenceHeader] = sequence.ToString(System.Globalization.CultureInfo.InvariantCulture);
                await response.Body.WriteAsync(ending.Bytes, context.RequestAborted);
                await response.CompleteAsync();
            }
            else
            {
                // ! a listen ended as its connection closes is 15.7's close, never told
                await (ending.IsGone ? EndWith(context, Unknown) : Finish(context, ending.End ?? Nothing));
            }
        }
        catch (Exception reason) when (reason is IOException or OperationCanceledException)
        {
            // a listen lost closes nothing: what it carried comes again to the next
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

    // out of the registry before its close is told; each exchange still waiting learns its connection
    // is gone — by the marked 404 until its request is handed on, then by its exchange cut after its
    // head, as a lost one is: a request handed on ran, which no refusal may deny
    private void CloseDrawn(Drawn connection, bool isClean)
    {
        // the bodies still coming of the requests waiting, whose reads are ended, so each is answered
        // the marked 404 now, its head not out
        var interrupted = new List<PipeReader>();

        lock (_gate)
        {
            if (_drawn.GetValueOrDefault(connection.ConnectionHandle) != connection)
            {
                return;
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

        _listeners.Tell(Close, (isClean, connection.ConnectionHandle));
    }

    // how the transport ends an exchange of its own: its status, the refusal it is marked with, and
    // its headers
    private sealed record End(int Status, string? Reason = null, IReadOnlyDictionary<string, string>? Headers = null);

    // how a listen's count is read: whether its field is required, or 0 when left out
    private sealed record CountOptions
    {
        public bool IsRequired { get; init; }
    }

    // what an exchange waiting on the transport ends with: an answer's envelope or a listen's batch,
    // the number of a batch's first, an end of the transport's own, or its connection gone — after
    // its request was handed on, or before
    private sealed record Ending
    {
        public ReadOnlyMemory<byte> Bytes { get; init; }

        public long? Sequence { get; init; }

        public End? End { get; init; }

        public bool IsGone { get; init; }

        // its request went on to the router before its connection went: its head goes, then its
        // exchange is cut
        public bool IsDelivered { get; init; }
    }

    // an exchange of an envelope, from its first 8 bytes to its end; touched under the lock
    private sealed class Waiting
    {
        // what its first 8 bytes said, once they came
        public (uint CallId, EnvelopeKind Kind)? Prefix { get; set; }

        // a cancel came for it while its body was still coming: it is read to its end, then 204
        public bool IsCancelled { get; set; }

        // its request went on to the router, which owes it an answer
        public bool IsDelivered { get; set; }

        // the transport ended it — an answer, a 204, a refusal, its connection closed — so its close is no loss
        public bool IsEnded { get; set; }

        // ends its connection, as lost, once its request waited past the exchange timeout
        public ITimer? Timer { get; set; }

        // what reads its body, while it still comes: its connection's close ends the read
        public PipeReader? Reading { get; set; }

        public TaskCompletionSource<Ending> Ended { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        // its answer, once written: what its send settles on
        public TaskCompletionSource Written { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    // a listen held until something comes for it, or its wait is over; touched under the lock
    private sealed class Listening(Drawn connection)
    {
        public Drawn Connection { get; } = connection;

        public ITimer? Timer { get; set; }

        public TaskCompletionSource<Ending> Ended { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
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
