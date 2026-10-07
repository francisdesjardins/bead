namespace Bead.Transport.WebSockets;

/// <summary>A WebSocket client's options: its transport's, and its router's limits.</summary>
public sealed record WebSocketClientOptions
{
    /// <summary>The transport's options: its clock is every layer's.</summary>
    public WebSocketTransportClientOptions? Transport { get; init; }

    /// <summary>What its router reads, writes and holds by.</summary>
    public RouterLimits? Limits { get; init; }
    /// <summary>
    /// The credential every call presents by default, which its router keeps as its
    /// <see cref="RouterClient.Credential"/>: a JWT, or an ELSEWHERE with what its transport carries
    /// beside each request; none when not given.
    /// </summary>
    public Credential? Credential { get; init; }

    /// <summary>What its router resolves a command presenting a JWT or an ELSEWHERE with, as a server does.</summary>
    public Credentials? Credentials { get; init; }

    /// <summary>
    /// What its router counts its calls and its notifications into, as its own option of that name
    /// says; none counts nothing.
    /// </summary>
    public MetricsRegistry? MetricsRegistry { get; init; }
}

/// <summary>
/// A client over WebSocket: its three layers, bottom up — the transport, the router built on it,
/// the services built on the router — each one Bead's TypeScript client has, all on its
/// transport's clock. What an application
/// starts from.
/// </summary>
public sealed class WebSocketClient : IClient
{
    // ends with the client: a reconnection it started must not outlive it
    private readonly CancellationTokenSource _lifetime = new();

    /// <summary>
    /// A client, not yet connected. A message is an envelope at most — its limits' — unless its
    /// transport's options say more; a message limit below its envelope limit is an
    /// <see cref="ArgumentException"/>: the socket would cut off envelopes the router takes.
    /// </summary>
    public WebSocketClient(WebSocketClientOptions? options = null)
    {
        var limits = options?.Limits ?? RouterLimits.Default;
        var transport = options?.Transport ?? new WebSocketTransportClientOptions();
        var maximumMessageBytes = transport.MaximumMessageBytes ?? limits.MaximumEnvelopeBytes;

        if (maximumMessageBytes < limits.MaximumEnvelopeBytes)
        {
            throw new ArgumentException(
                $"a message is an envelope's limit at least, {limits.MaximumEnvelopeBytes} bytes, not {maximumMessageBytes}",
                nameof(options));
        }

        Transport = new WebSocketTransportClient(transport with { MaximumMessageBytes = maximumMessageBytes });
        Router = new RouterClient(Transport, new RouterClientOptions
        {
            Credential = options?.Credential,
            Credentials = options?.Credentials,
            Limits = limits,
            MetricsRegistry = options?.MetricsRegistry,
        });
        Services = new ServiceManager(Router);
    }

    /// <summary>Its transport.</summary>
    public WebSocketTransportClient Transport { get; }

    /// <summary>Its router.</summary>
    public RouterClient Router { get; }

    /// <summary>Its services.</summary>
    public ServiceManager Services { get; }

    /// <summary>Connects its transport, as <see cref="WebSocketTransportClient.Connect"/> does.</summary>
    public Task Connect(WebSocketConnectOptions options, CancellationToken cancellationToken = default)
    {
        return Transport.Connect(options, cancellationToken);
    }

    /// <summary>Closes its transport's connection, as <see cref="WebSocketTransportClient.CloseConnection"/> does.</summary>
    public Task Disconnect(TransportDisconnectOptions? options = null)
    {
        return Transport.CloseConnection(options);
    }

    /// <summary>
    /// Reconnects its transport, as <see cref="WebSocketTransportClient.Reconnect"/> does; a dispose
    /// cancels it, as the token given does.
    /// </summary>
    public async Task Reconnect(TransportReconnectOptions? options = null)
    {
        var reconnect = options ?? new TransportReconnectOptions();

        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token, reconnect.CancellationToken);

        await Transport.Reconnect(reconnect with { CancellationToken = cancelling.Token });
    }

    /// <summary>
    /// Cancels a reconnection under way, so none reopens a connection nothing owns; then takes its
    /// layers apart in the reverse of the order they were built in: the router rejects what still
    /// waits, as disposed, then the transport closes.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        await _lifetime.CancelAsync();
        Router.Dispose();
        await Transport.DisposeAsync();
    }
}
