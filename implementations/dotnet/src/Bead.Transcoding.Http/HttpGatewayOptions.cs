namespace Bead.Transcoding.Http;

/// <summary>What a call presents of a request's <c>authorization</c> (transcoding 2.4).</summary>
public enum GatewayAuthorization
{
    /// <summary><c>ELSEWHERE</c>, the field's value carried beside the request, as <c>POST /bead</c> carries one.</summary>
    Elsewhere,

    /// <summary>A <c>JWT</c>, the token of a <c>Bearer</c> field, in the request's <c>CREDENTIAL</c> block.</summary>
    BearerJwt,
}

/// <summary>
/// How a gateway is built (transcoding 2 to 11): where its calls go, what it answers, and the
/// bounds it holds, each by the name the companion gives it and its default there. The hosts, the
/// origins, the proxies and the bounds spec 15.12 names come from <see cref="Policy"/> where it
/// gives them, as an HTTP transport takes the same one; a member given in it and beside it is an
/// <see cref="ArgumentException"/>.
/// </summary>
public sealed record HttpGatewayOptions
{
    /// <summary>
    /// The in-memory server transport its application's server takes through its join (spec 15.13,
    /// 15.14): each exchange connects a client of its own to it, one Bead connection per exchange.
    /// </summary>
    public required MemoryTransportServer Transport { get; init; }

    /// <summary>The route table its output generated, <c>HttpRoutes.All</c>: each procedure a client calls, and its routes.</summary>
    public required IReadOnlyList<HttpRoute> Routes { get; init; }

    /// <summary>The document its builder wrote, <c>HttpRoutes.OpenApiDocument</c>, served at <c>/openapi.json</c>; none serves none.</summary>
    public ReadOnlyMemory<byte>? Document { get; init; }

    /// <summary>The base its definitions give an application failure's problem type, <c>HttpRoutes.ProblemTypes</c>; none gives <c>about:blank</c>.</summary>
    public string? ProblemTypes { get; init; }

    /// <summary>The policy its application's listeners share: its hosts, origins, proxies and bounds.</summary>
    public HttpPolicy? Policy { get; init; }

    /// <summary>The hosts it takes beside the loopbacks' names and IP literals, as an HTTP transport's.</summary>
    public IReadOnlyList<string>? Hosts { get; init; }

    /// <summary>The origins it answers CORS to beside its own, as an HTTP transport's.</summary>
    public IReadOnlyList<string> Origins { get; init; } = [];

    /// <summary>The proxies whose <c>X-Forwarded-For</c> it believes, as an HTTP transport's.</summary>
    public IReadOnlyList<string>? TrustedProxies { get; init; }

    /// <summary>The proxies in front of it unnamed, as an HTTP transport's.</summary>
    public int UnnamedProxies { get; init; }

    /// <summary>What a call presents of its request's <c>authorization</c>: <c>ELSEWHERE</c> by default.</summary>
    public GatewayAuthorization Authorization { get; init; } = GatewayAuthorization.Elsewhere;

    /// <summary>Its challenge, the <c>www-authenticate</c> of a 401: <c>Bearer</c> by default.</summary>
    public string Challenge { get; init; } = "Bearer";

    /// <summary>How long a call waits for its answer, 5 s by default, a stream's until its result; infinite waits without end.</summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>The notifications a stream's subscription is credited ahead of what its response took, 16 by default (transcoding 8.8).</summary>
    public int Window { get; init; } = 16;

    /// <summary>How often a quiet stream writes a comment, 30 s by default (transcoding 8.7); infinite writes none.</summary>
    public TimeSpan Heartbeat { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>The calls it holds at once, of every caller (transcoding 10.3).</summary>
    public int MaximumExchanges { get; init; } = 10_000;

    /// <summary>The calls one caller's address holds at once (transcoding 10.3).</summary>
    public int MaximumExchangesPerAddress { get; init; } = 256;

    /// <summary>The streams it holds at once, of every caller, by spec 15.12's name.</summary>
    public int MaximumConnections { get; init; } = 10_000;

    /// <summary>The streams one caller's address holds at once, by spec 15.12's name.</summary>
    public int MaximumConnectionsPerAddress { get; init; } = 64;

    /// <summary>The bytes of body every request together holds at once (spec 15.12).</summary>
    public long BodyBytesBudget { get; init; } = 268_435_456;

    /// <summary>The bytes one request's body holds at most (spec 15.12).</summary>
    public int MaximumBodyBytes { get; init; } = LimitDefaults.MaximumEnvelopeBytes;

    /// <summary>How long a request's head may take to come whole (spec 15.12).</summary>
    public TimeSpan HeadersTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>The slowest a body may come once its grace passed, in bytes a second (spec 15.12); 0 holds none.</summary>
    public int MinimumBodyBytesPerSecond { get; init; } = 240;

    /// <summary>How long a body comes before its rate is held (spec 15.12).</summary>
    public TimeSpan BodyGracePeriod { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>The slowest a socket may take an answer or a stream once its grace passed, in bytes a second (spec 15.12); 0 holds none.</summary>
    public int MinimumSendBytesPerSecond { get; init; } = 240;

    /// <summary>The least time what goes is given to be taken (spec 15.12).</summary>
    public TimeSpan SendGracePeriod { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>The bytes a stream's response holds unsent before it is dropped, a WebSocket's bound (spec 15.12).</summary>
    public long MaximumUnsentBytes { get; init; } = 184_551_424;

    /// <summary>What its timers run on, its calls' among them; the system's clock when none.</summary>
    public TimeProvider? Clock { get; init; }
}

/// <summary>Where a gateway's own listener listens.</summary>
public sealed record HttpGatewayStartOptions
{
    /// <summary>The address it listens on: an IP literal, or <c>localhost</c>, both loopbacks, by default.</summary>
    public string Address { get; init; } = "localhost";

    /// <summary>The port it listens on, 80 by default.</summary>
    public int Port { get; init; } = 80;

    /// <summary>Whether it takes any free port, the one it took given back.</summary>
    public bool FindOpenPort { get; init; }
}
