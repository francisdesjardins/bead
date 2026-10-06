namespace Bead.Transport.Http;

/// <summary>An HTTP server's options: its transport's, and the rest as a server takes them.</summary>
public sealed record HttpServerOptions
{
    /// <summary>
    /// How long a connection with no session may stay silent over HTTP, when the server's options say
    /// nothing: a connection is drawn by any <c>POST</c>, so one never used goes within 30 s.
    /// </summary>
    public static TimeSpan ConnectionInactivityTimeoutDefault { get; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// The transport's options; the largest body is the limits' envelope, which they set. Its clock
    /// is every layer's: the server's own options give none, or the same.
    /// </summary>
    public HttpTransportServerOptions? Transport { get; init; }

    /// <summary>
    /// The server's options. Its limits carry whole envelopes and no transfer (see
    /// <see cref="RouterLimits.WholeEnvelopeOf"/>); its connection inactivity timeout is
    /// <see cref="ConnectionInactivityTimeoutDefault"/> when it gives none.
    /// </summary>
    public ServerOptions? Server { get; init; }
}

/// <summary>
/// A server over HTTP: a <see cref="Server{TData}"/> with an HTTP transport server, not yet started,
/// as its bottom layer, one envelope per exchange. Its router takes no transfer — a request's body
/// reaches it before its answer goes, so no credit could come back — and a payload is what one
/// envelope holds. What it sends of its own reaches a client that listens; a client that does not
/// is refused a subscription, and a command to it fails.
/// </summary>
/// <example>
/// <code>
/// await using var server = new HttpServer&lt;string&gt;();
///
/// await server.Transport.Start(new HttpTransportStartOptions { Port = port });
/// </code>
/// </example>
/// <typeparam name="TData">What a session keeps.</typeparam>
public sealed class HttpServer<TData> : IBeadServer<TData>
{
    private readonly Server<TData> _server;

    /// <summary>A server, not yet started; its options as <see cref="HttpServerOptions"/> says.</summary>
    public HttpServer(HttpServerOptions? options = null)
    {
        var server = options?.Server ?? new ServerOptions();
        var limits = RouterLimits.WholeEnvelopeOf(server.Limits);

        Transport = new HttpTransportServer((options?.Transport ?? new HttpTransportServerOptions()) with
        {
            MaximumBodyBytes = limits.MaximumEnvelopeBytes,
        });
        _server = new Server<TData>(Transport, server with
        {
            ConnectionInactivityTimeout = server.ConnectionInactivityTimeout ?? HttpServerOptions.ConnectionInactivityTimeoutDefault,
            Limits = limits,
        });
    }

    /// <summary>Its transport, which the application starts.</summary>
    public HttpTransportServer Transport { get; }

    /// <summary>Its router.</summary>
    public RouterServer Router
    {
        get
        {
            return _server.Router;
        }
    }

    /// <summary>Its services.</summary>
    public ServiceManager Services
    {
        get
        {
            return _server.Services;
        }
    }

    /// <summary>Its sessions.</summary>
    public SessionManager<TData> Sessions
    {
        get
        {
            return _server.Sessions;
        }
    }

    /// <summary>The admission of a procedure that needs a session: refused with SESSION_REQUIRED without one.</summary>
    public BeforeRequest RequireSession
    {
        get
        {
            return _server.RequireSession;
        }
    }

    /// <summary>A relay's admission by default, as <see cref="Server{TData}.RequireSessionOrCredential"/> says.</summary>
    public BeforeRequest RequireSessionOrCredential
    {
        get
        {
            return _server.RequireSessionOrCredential;
        }
    }

    // its transport as every server's, beside its own type, which the application starts
    IServerTransport IBeadServer<TData>.Transport
    {
        get
        {
            return Transport;
        }
    }

    /// <summary>What each layer holds, as <see cref="Server{TData}.Gauges"/> gives it.</summary>
    public Task<ServerGauges> Gauges()
    {
        return _server.Gauges();
    }

    /// <summary>The verdict on its gauges, as <see cref="Server{TData}.Health"/> gives it.</summary>
    public Task<Health> Health()
    {
        return _server.Health();
    }

    /// <summary>Lets go of its layers in the reverse of the order they were built in, then stops its transport.</summary>
    public ValueTask DisposeAsync()
    {
        return _server.DisposeAsync();
    }
}
