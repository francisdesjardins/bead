namespace Bead.Transport.Http;

/// <summary>An HTTP client's options: its transport's, and its router's limits.</summary>
public sealed record BeadHttpClientOptions
{
    /// <summary>
    /// The transport's options; the largest answer is the limits' envelope, which they set. Its
    /// clock is every layer's.
    /// </summary>
    public HttpTransportClientOptions? Transport { get; init; }

    /// <summary>What its router reads, writes and holds by: whole envelopes, and no transfer (see <see cref="RouterLimits.WholeEnvelopeOf"/>).</summary>
    public RouterLimits? Limits { get; init; }
    /// <summary>
    /// The credential every call presents by default, which its router keeps as its
    /// <see cref="RouterClient.Credential"/>: a JWT, or an ELSEWHERE with what its transport carries
    /// beside each request; none when not given.
    /// </summary>
    public Credential? Credential { get; init; }

    /// <summary>What its router resolves a command presenting a JWT or an ELSEWHERE with, as a server does.</summary>
    public Credentials? Credentials { get; init; }
}

/// <summary>
/// A client over HTTP: its three layers, bottom up — the transport, the router built on it, the
/// services built on the router — all on its transport's clock, one envelope per exchange. It sends no transfer, and a payload is
/// what one envelope holds. It listens for what the server sends of its own — a subscription's
/// notifications, a command — unless its transport is told not to. The TypeScript side's
/// <c>createHTTPClient</c>, named apart from .NET's own <see cref="System.Net.Http.HttpClient"/>.
/// </summary>
/// <example>
/// <code>
/// await using var client = new BeadHttpClient();
///
/// await client.Connect(new HttpConnectOptions { Host = host, Port = port });
/// </code>
/// </example>
public sealed class BeadHttpClient : IAsyncDisposable
{
    // ends with the client: a reconnection it started must not outlive it
    private readonly CancellationTokenSource _lifetime = new();

    /// <summary>A client, not yet connected.</summary>
    public BeadHttpClient(BeadHttpClientOptions? options = null)
    {
        var limits = RouterLimits.WholeEnvelopeOf(options?.Limits);

        Transport = new HttpTransportClient((options?.Transport ?? new HttpTransportClientOptions()) with
        {
            MaximumBodyBytes = limits.MaximumEnvelopeBytes,
        });
        Router = new RouterClient(Transport, new RouterClientOptions { Credential = options?.Credential, Credentials = options?.Credentials, Limits = limits });
        Services = new ServiceManager(Router);
    }

    /// <summary>Its transport.</summary>
    public HttpTransportClient Transport { get; }

    /// <summary>Its router.</summary>
    public RouterClient Router { get; }

    /// <summary>Its services.</summary>
    public ServiceManager Services { get; }

    /// <summary>Connects its transport, as <see cref="HttpTransportClient.Connect"/> does.</summary>
    public Task Connect(HttpConnectOptions options, CancellationToken cancellationToken = default)
    {
        return Transport.Connect(options, cancellationToken);
    }

    /// <summary>Closes its transport's connection, as <see cref="HttpTransportClient.CloseConnection"/> does.</summary>
    public Task Disconnect(TransportDisconnectOptions? options = null)
    {
        return Transport.CloseConnection(options);
    }

    /// <summary>
    /// Reconnects its transport, as <see cref="HttpTransportClient.Reconnect"/> does; a dispose
    /// cancels it, as the token given does.
    /// </summary>
    public async Task Reconnect(TransportReconnectOptions? options = null)
    {
        var reconnect = options ?? new TransportReconnectOptions();

        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token, reconnect.CancellationToken);

        await Transport.Reconnect(reconnect with { CancellationToken = cancelling.Token });
    }

    /// <summary>
    /// Cancels a reconnection under way, then takes its layers apart in the reverse of the order they
    /// were built in: the router rejects what still waits, as disposed, then the transport closes.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        await _lifetime.CancelAsync();
        Router.Dispose();
        await Transport.DisposeAsync();
    }
}
