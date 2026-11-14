using System.Globalization;
using System.Text;

namespace Bead.Transport.Amqp;

/// <summary>How an adapter over a broker of AMQP 1.0 that is RabbitMQ 4 is built (spec 15.32 to 15.38).</summary>
public sealed record AmqpBrokerAdapterOptions
{
    /// <summary>Its broker: <c>amqp://</c>, or <c>amqps://</c> over TLS.</summary>
    public required Uri Uri { get; init; }

    /// <summary>Its participant's id: the user its broker authenticates it as, and its OPEN's container-id.</summary>
    public required string Id { get; init; }

    /// <summary>
    /// Its password, SASL PLAIN's under its id, as given: UTF-8 text, never empty and holding no NUL
    /// (spec 15.33, RFC 4616 §2). Refused with an <see cref="ArgumentException"/> as it is built when
    /// it is not, beside a <see cref="PasswordProvider"/>, and beside a TLS client certificate, but
    /// taken beside a <see cref="Tls"/> that names its authorities alone; and so is its adapter given
    /// neither it, its provider nor a certificate, whatever its authorities, since its link never
    /// authenticates as ANONYMOUS. None when none.
    /// </summary>
    public string? Password { get; init; }

    /// <summary>
    /// What hands its password at each link's start, before its connection opens, with a token
    /// cancelled as its start's own token is, as its link is stopped, as its
    /// <see cref="ConnectTimeout"/> passes, and once its start ends, linked or not: so that one that
    /// expires renews with each incarnation. Refused as <see cref="Password"/> is, and beside it. Its
    /// start fails as it outlives that <see cref="ConnectTimeout"/>, a <see cref="TimeoutException"/>,
    /// or as a stop meets it, an <see cref="IOException"/>, whether or not it hears its token, a later
    /// answer serving nothing; what it throws fails its start, an <see cref="IOException"/> its cause;
    /// an answer that is no password fails it with an <see cref="ArgumentException"/> (spec 15.33).
    /// None when none.
    /// </summary>
    public Func<CancellationToken, ValueTask<string>>? PasswordProvider { get; init; }

    /// <summary>
    /// Its leg's TLS, over <c>amqps</c> alone (spec 15.33, 15.39): its client certificate with its
    /// key, which its broker maps to the user its id names, its SASL then EXTERNAL; and the
    /// authorities its broker's certificate chains to, in place of the system's. Refused with an
    /// <see cref="ArgumentException"/> as it is built over any other URL, and as
    /// <see cref="TlsOptions"/> says. The system's when none.
    /// </summary>
    public TlsOptions? Tls { get; init; }

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
    /// How long its start waits, from its call, for its password, where it asks its
    /// <see cref="PasswordProvider"/>, its broker's OPEN, its sessions and its inbox, and its inbox's
    /// deletion; how long a name's let-go waits for what it handed on to be settled and its DETACH
    /// answered, past which its link is lost; and its stop: 30 seconds unless told, never without end
    /// (spec 15.34, 15.37).
    /// </summary>
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>At least once unless told, each transfer unsettled; at most once, each settled as it goes (spec 15.35).</summary>
    public BrokerDelivery Delivery { get; init; } = BrokerDelivery.AtLeastOnce;

    /// <summary>Its broker's virtual host, its OPEN's hostname <c>vhost:</c> and it; its broker's default when none.</summary>
    public string? VirtualHost { get; init; }

    // every member as the compiler writes it, but its password and its provider, of which whether one is set
    private bool PrintMembers(StringBuilder builder)
    {
        // ! a password reaches no log, no exception's message and no debugger (spec 15.1)
        builder.Append(CultureInfo.InvariantCulture, $"Uri = {Uri}, Id = {Id}, Password = {(Password is null ? "none" : "set")}, PasswordProvider = {(PasswordProvider is null ? "none" : "set")}, Tls = {Tls}, MaximumMessageSize = {MaximumMessageSize}, LinkCredit = {LinkCredit}, IdleTimeout = {IdleTimeout}, ConnectTimeout = {ConnectTimeout}, Delivery = {Delivery}, VirtualHost = {VirtualHost}");

        return true;
    }
}
