using System.Security.Cryptography.X509Certificates;

namespace Bead.Transport.Amqp;

/// <summary>How an adapter over a broker of AMQP 1.0 that is RabbitMQ 4 is built (spec 15.32 to 15.38).</summary>
public sealed record AmqpBrokerAdapterOptions
{
    /// <summary>Its broker: <c>amqp://</c>, or <c>amqps://</c> over TLS.</summary>
    public required Uri Uri { get; init; }

    /// <summary>Its participant's id: the user its broker authenticates it as, and its OPEN's container-id.</summary>
    public required string Id { get; init; }

    /// <summary>Its password, SASL PLAIN's under its id; none where its TLS client certificate authenticates it, or its provider gives it.</summary>
    public string? Password { get; init; }

    /// <summary>Its password asked at each link's start, so that one that expires renews with each incarnation; none when none.</summary>
    public Func<CancellationToken, Task<string>>? PasswordProvider { get; init; }

    /// <summary>Its leg's TLS, over <c>amqps</c>: its client certificate, SASL EXTERNAL's, and the authorities it trusts; the system's when none.</summary>
    public AmqpBrokerTlsOptions? Tls { get; init; }

    /// <summary>
    /// The largest message, as its publisher writes it, whose payload it takes: its receive bound's,
    /// 16,777,216 bytes unless told, a whole number from 1 to 4,294,967,295 (spec 15.37). No
    /// receiver it attaches names it: a message past it is dropped as no parcel (spec 15.36).
    /// </summary>
    public long MaximumMessageSize { get; init; } = AmqpMessages.MaximumMessageSize;

    /// <summary>
    /// The messages its broker may deliver its inbox's receiver before it settles one: 1,000 unless
    /// told, from 1 to 2,147,483,647, granted as that receiver attaches, a name's being 1; one more on
    /// each as each message is settled (spec 15.34, 15.37).
    /// </summary>
    public int LinkCredit { get; init; } = 1_000;

    /// <summary>
    /// Its OPEN's idle-time-out: 30 seconds unless told, from 1 ms to 1,073,741,823 ms, never
    /// without end; it counts its link lost once nothing came for twice it (spec 15.33, 15.37).
    /// </summary>
    public TimeSpan IdleTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How long its start waits for its broker's OPEN, its sessions and its inbox, and its inbox's
    /// deletion; how long a name's let-go waits for what it handed on to be settled and its DETACH
    /// answered, past which its link is lost; and its stop: 30 seconds unless told, never without end
    /// (spec 15.34, 15.37).
    /// </summary>
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>At least once unless told, each transfer unsettled; at most once, each settled as it goes (spec 15.35).</summary>
    public BrokerDelivery Delivery { get; init; } = BrokerDelivery.AtLeastOnce;

    /// <summary>Its broker's virtual host, its OPEN's hostname <c>vhost:</c> and it; its broker's default when none.</summary>
    public string? VirtualHost { get; init; }
}

/// <summary>An AMQP 1.0 adapter's TLS (spec 15.33, 15.38).</summary>
public sealed record AmqpBrokerTlsOptions
{
    /// <summary>
    /// Its TLS client certificates, which its broker maps to the user its id names, its SASL then
    /// EXTERNAL; carried over <c>amqps</c> alone; none when none.
    /// </summary>
    public X509Certificate2Collection? ClientCertificates { get; init; }

    /// <summary>The authorities its broker's certificate chains to, in place of the system's; the system's when none.</summary>
    public X509Certificate2Collection? TrustChain { get; init; }
}
