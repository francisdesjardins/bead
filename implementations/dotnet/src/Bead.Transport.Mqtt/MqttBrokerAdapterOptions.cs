using System.Security.Cryptography.X509Certificates;

namespace Bead.Transport.Mqtt;

/// <summary>How an adapter over a broker of MQTT 5 is built (spec 15.25 to 15.31).</summary>
public sealed record MqttBrokerAdapterOptions
{
    /// <summary>Its broker: <c>mqtt://</c>, <c>mqtts://</c>, or a WebSocket, <c>ws://</c> or <c>wss://</c>, of subprotocol <c>mqtt</c>.</summary>
    public required Uri Uri { get; init; }

    /// <summary>Its participant's id: its Client Identifier, and the User Name it authenticates by.</summary>
    public required string Id { get; init; }

    /// <summary>Its Password, under its id as User Name; none where its TLS client certificate authenticates it, or its provider gives it.</summary>
    public string? Password { get; init; }

    /// <summary>Its Password asked at each link's start, so that one that expires renews with each incarnation; none when none.</summary>
    public Func<CancellationToken, Task<string>>? PasswordProvider { get; init; }

    /// <summary>Its leg's TLS, over <c>mqtts</c> or <c>wss</c>: its client certificate and the authorities it trusts; the system's when none.</summary>
    public MqttBrokerTlsOptions? Tls { get; init; }

    /// <summary>
    /// Its CONNECT's Maximum Packet Size, the largest packet its broker sends it: 16,777,216 bytes
    /// unless told, a whole number up to 268,435,460 (spec 15.30).
    /// </summary>
    public long MaximumPacketSize { get; init; } = MqttPackets.MaximumPacketSize;

    /// <summary>
    /// Its CONNECT's Keep Alive, sent in whole seconds rounded up: 30 seconds unless told, from 1 ms
    /// to 65,535 seconds, never without end; its broker counts its link lost silent for half again
    /// as long (spec 15.30).
    /// </summary>
    public TimeSpan KeepAlive { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>How long its start waits for its CONNACK: 30 seconds unless told, never without end (spec 15.30).</summary>
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>At least once unless told, each publication of QoS 1; at most once, of QoS 0 (spec 15.28).</summary>
    public BrokerDelivery Delivery { get; init; } = BrokerDelivery.AtLeastOnce;

    /// <summary>False where its broker is known to offer no shared subscription (spec 15.25): true unless told, MQTT 5's default.</summary>
    public bool Groups { get; init; } = true;
}

/// <summary>An MQTT 5 adapter's TLS (spec 15.26, 15.31).</summary>
public sealed record MqttBrokerTlsOptions
{
    /// <summary>
    /// Its TLS client certificates, whose identity its broker ties to its id, its CONNECT then naming
    /// neither User Name nor Password; carried over <c>mqtts</c> or <c>wss</c> alone; none when none.
    /// </summary>
    public X509Certificate2Collection? ClientCertificates { get; init; }

    /// <summary>The authorities its broker's certificate chains to, in place of the system's; the system's when none.</summary>
    public X509Certificate2Collection? TrustChain { get; init; }
}
