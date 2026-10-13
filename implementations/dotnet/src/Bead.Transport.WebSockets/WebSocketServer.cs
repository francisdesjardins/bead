namespace Bead.Transport.WebSockets;

/// <summary>A WebSocket server's options: its transport's, and the rest as a server takes them.</summary>
public sealed record WebSocketServerOptions
{
    /// <summary>
    /// The transport's options. A message is an envelope at most — the server's limits' — unless
    /// they say more; less is an <see cref="ArgumentException"/>: the socket would cut off envelopes
    /// the router takes. Its clock is every layer's: the server's own options give none, or the
    /// same.
    /// </summary>
    public WebSocketTransportServerOptions? Transport { get; init; }

    /// <summary>The server's options: its limits, its pacing, its relay, its sessions and its timeouts.</summary>
    public ServerOptions? Server { get; init; }
}

/// <summary>
/// A server over WebSocket: a <see cref="Server{TData}"/> with a WebSocket transport server, not yet
/// started, as its bottom layer — its layers, each one Bead's TypeScript server has. What an
/// application starts from.
/// </summary>
/// <example>
/// <code>
/// await using var server = new WebSocketServer&lt;string&gt;(new WebSocketServerOptions
/// {
///     Server = new ServerOptions { CloseOnCommandTimeout = true },
/// });
///
/// await server.Transport.Start(new WebSocketTransportStartOptions { Port = port });
/// </code>
/// </example>
/// <typeparam name="TData">What a session keeps.</typeparam>
public sealed class WebSocketServer<TData> : IBeadServer<TData>
{
    private readonly Server<TData> _server;

    /// <summary>A server, not yet started; its options as <see cref="WebSocketServerOptions"/> says.</summary>
    public WebSocketServer(WebSocketServerOptions? options = null)
    {
        var server = options?.Server ?? new ServerOptions();
        var limits = server.Limits ?? RouterLimits.Default;
        var transport = options?.Transport ?? new WebSocketTransportServerOptions();
        var maximumMessageBytes = transport.MaximumMessageBytes ?? limits.MaximumEnvelopeBytes;

        if (maximumMessageBytes < limits.MaximumEnvelopeBytes)
        {
            throw new ArgumentException(
                $"a message is an envelope's limit at least, {limits.MaximumEnvelopeBytes} bytes, not {maximumMessageBytes}",
                nameof(options));
        }

        Transport = new WebSocketTransportServer(transport with { MaximumMessageBytes = maximumMessageBytes });
        _server = new Server<TData>(Transport, server);
    }

    /// <summary>Its transport, which the application starts.</summary>
    public WebSocketTransportServer Transport { get; }

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

    /// <summary>A relay's admission by default, as <see cref="Server{TData}.RequireCredential"/> says.</summary>
    public BeforeRequest RequireCredential
    {
        get
        {
            return _server.RequireCredential;
        }
    }

    /// <summary>A relay's admission that lends leg B's session, as <see cref="Server{TData}.ShareLegBSession"/> says.</summary>
    public BeforeRequest ShareLegBSession
    {
        get
        {
            return _server.ShareLegBSession;
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
