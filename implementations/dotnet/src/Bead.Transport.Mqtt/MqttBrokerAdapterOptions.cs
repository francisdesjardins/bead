using System.Globalization;
using System.Text;

namespace Bead.Transport.Mqtt;

/// <summary>How an adapter over a broker of MQTT 5 is built (spec 15.25 to 15.31).</summary>
public sealed record MqttBrokerAdapterOptions
{
    /// <summary>Its broker: <c>mqtt://</c>, <c>mqtts://</c>, or a WebSocket, <c>ws://</c> or <c>wss://</c>, of subprotocol <c>mqtt</c>.</summary>
    public required Uri Uri { get; init; }

    /// <summary>Its participant's id: its Client Identifier, and the User Name it authenticates by.</summary>
    public required string Id { get; init; }

    /// <summary>
    /// Its Password, under its id as User Name, as given: UTF-8 text, never empty and holding no NUL
    /// (spec 15.26). Refused with an <see cref="ArgumentException"/> as it is built when it is not,
    /// beside a <see cref="PasswordProvider"/>, and beside a TLS client certificate; taken beside a
    /// <see cref="Tls"/> that names its authorities alone. With neither, its CONNECT carries its User
    /// Name alone; none when none.
    /// </summary>
    public string? Password { get; init; }

    /// <summary>
    /// What hands its Password at each link's start, before its network connection opens, with a
    /// token cancelled as its start's own token is, as its link is stopped, as its
    /// <see cref="ConnectTimeout"/> passes, and once its start ends, linked or not: so that one that
    /// expires renews with each incarnation. Refused as <see cref="Password"/> is, and beside it. Its
    /// start fails as it outlives that <see cref="ConnectTimeout"/>, a <see cref="TimeoutException"/>,
    /// or as a stop meets it, an <see cref="IOException"/>, whether or not it hears its token, a later
    /// answer serving nothing; what it throws fails its start, an <see cref="IOException"/> its cause;
    /// an answer that is no password fails it with an <see cref="ArgumentException"/> (spec 15.26).
    /// None when none.
    /// </summary>
    public Func<CancellationToken, ValueTask<string>>? PasswordProvider { get; init; }

    /// <summary>
    /// Its leg's TLS, over <c>mqtts</c> or <c>wss</c> alone (spec 15.26, 15.39): its client
    /// certificate with its key, whose identity its broker ties to its id, its CONNECT then naming
    /// neither User Name nor Password; and the authorities its broker's certificate chains to, in
    /// place of the system's. Refused with an <see cref="ArgumentException"/> as it is built over any
    /// other URL, and as <see cref="TlsOptions"/> says. The system's when none.
    /// </summary>
    public TlsOptions? Tls { get; init; }

    /// <summary>
    /// Its CONNECT's Maximum Packet Size, the largest packet its broker sends it: 16,777,216 bytes
    /// unless told, a whole number up to 268,435,460 (spec 15.30).
    /// </summary>
    public long MaximumPacketSize { get; init; } = MqttPackets.MaximumPacketSize;

    /// <summary>
    /// Its CONNECT's Keep Alive, sent in whole seconds rounded up: 30 seconds unless told, from 1 ms
    /// to 65,535 seconds, never without end. Its link runs it unless its CONNACK names a shorter
    /// Server Keep Alive, and loses itself on a PINGREQ unanswered for half of it; its broker counts
    /// its link lost silent for half again as long where its CONNACK names none (spec 15.26, 15.30).
    /// </summary>
    public TimeSpan KeepAlive { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How long it waits: its start, from its call, for its Password, where it asks its
    /// <see cref="PasswordProvider"/>, and its CONNACK; a subscription let go, from its UNSUBSCRIBE,
    /// for its UNSUBACK; and its stop, from its call, for what it was handed and its UNSUBACKs, then
    /// for its DISCONNECT: 30 seconds unless told, never without end (spec 15.26, 15.27, 15.30).
    /// </summary>
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>At least once unless told, each publication of QoS 1; at most once, of QoS 0 (spec 15.28).</summary>
    public BrokerDelivery Delivery { get; init; } = BrokerDelivery.AtLeastOnce;

    /// <summary>False where its broker is known to offer no shared subscription (spec 15.25): true unless told, MQTT 5's default.</summary>
    public bool Groups { get; init; } = true;

    // every member as the compiler writes it, but its password and its provider, of which whether one is set
    private bool PrintMembers(StringBuilder builder)
    {
        // ! a password reaches no log, no exception's message and no debugger (spec 15.1)
        builder.Append(CultureInfo.InvariantCulture, $"Uri = {Uri}, Id = {Id}, Password = {(Password is null ? "none" : "set")}, PasswordProvider = {(PasswordProvider is null ? "none" : "set")}, Tls = {Tls}, MaximumPacketSize = {MaximumPacketSize}, KeepAlive = {KeepAlive}, ConnectTimeout = {ConnectTimeout}, Delivery = {Delivery}, Groups = {Groups}");

        return true;
    }
}
