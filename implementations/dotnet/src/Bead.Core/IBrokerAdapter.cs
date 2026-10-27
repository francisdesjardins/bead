using System.Diagnostics.CodeAnalysis;

namespace Bead;

/// <summary>What an adapter's broker gives its publications (spec 15.19).</summary>
public enum BrokerDelivery
{
    /// <summary>
    /// At least once: its broker acknowledges each publication it took, and its adapter holds what it
    /// publishes to the quota its broker gives (MQTT QoS 1, AMQP settled).
    /// </summary>
    AtLeastOnce,

    /// <summary>At most once: nothing is acknowledged, and nothing paces the link (MQTT QoS 0, core NATS).</summary>
    AtMostOnce,
}

/// <summary>What a broker said of a publication (spec 15.24).</summary>
public enum BrokerPublished
{
    /// <summary>Taken: at least once, its broker acknowledged it; at most once, it went.</summary>
    Taken,

    /// <summary>Refused for want of a subscriber, where its adapter offers <see cref="BrokerCapabilities.NoSubscriber"/>, as MQTT 5's PUBACK <c>0x10</c>.</summary>
    NoSubscriber,
}

/// <summary>What an adapter offers besides what every one offers (spec 15.24).</summary>
[Flags]
public enum BrokerCapabilities
{
    /// <summary>Nothing besides.</summary>
    None = 0,

    /// <summary>A subscription in a group, its broker handing each message to one member: a name served by several participants needs it.</summary>
    Groups = 1,

    /// <summary>A will, published by its broker once it loses the link without a clean end.</summary>
    Will = 2,

    /// <summary>A publication refused when no subscriber takes it, as MQTT 5's PUBACK <c>0x10</c>.</summary>
    NoSubscriber = 4,

    /// <summary>A message's life in its broker, past which it is deleted unsent (MQTT 5's Message Expiry).</summary>
    Expiry = 8,
}

/// <summary>A publication: its payload, to a topic, and how long it may wait in its broker.</summary>
public sealed record BrokerPublication
{
    /// <summary>
    /// The topic it goes to, by its tokens (spec 15.16): <c>bead</c>, <c>i</c>, <c>ada</c>, a
    /// participant's inbox; each adapter writes it as its broker's binding says.
    /// </summary>
    public required IReadOnlyList<string> Topic { get; init; }

    /// <summary>The message's payload: one parcel, its bytes the adapter's no more.</summary>
    public required ReadOnlyMemory<byte> Payload { get; init; }

    /// <summary>How long it may wait in its broker before it is deleted unsent, where the adapter offers <see cref="BrokerCapabilities.Expiry"/>; none when none.</summary>
    public TimeSpan? ExpiresAfter { get; init; }

    /// <summary>What gives up on the publication.</summary>
    public CancellationToken CancellationToken { get; init; }
}

/// <summary>How a link starts: its will, where the adapter offers one.</summary>
public sealed record BrokerStart
{
    /// <summary>What its broker publishes once it loses the link without a clean end; none when none.</summary>
    public BrokerPublication? Will { get; init; }

    /// <summary>What gives up on the start.</summary>
    public CancellationToken CancellationToken { get; init; }
}

/// <summary>How a topic is subscribed: alone, or in a group.</summary>
public sealed record BrokerSubscription
{
    /// <summary>
    /// The group it is held in, its broker handing each message to one of its members, where the
    /// adapter offers <see cref="BrokerCapabilities.Groups"/>; none for one held alone.
    /// </summary>
    public string? Group { get; init; }

    /// <summary>What gives up on the subscription.</summary>
    public CancellationToken CancellationToken { get; init; }
}

/// <summary>How a link went down: lost, or taken over by another link of its identity (spec 15.21).</summary>
public sealed record BrokerDown
{
    /// <summary>
    /// Whether another link of its identity took it over, MQTT 5's DISCONNECT of 0x8E: its
    /// participant connects no more until its application starts it again.
    /// </summary>
    public bool IsTakenOver { get; init; }
}

/// <summary>
/// One message an adapter received: the topic it came to, its payload, whether its broker kept it
/// retained, and its acknowledgement, which its participant gives as it takes it (spec 15.19).
/// </summary>
public sealed class BrokerMessage
{
    private readonly Action _settle;
    private int _isSettled;

    /// <summary>A message, and what acknowledges it to its broker.</summary>
    public BrokerMessage(BrokerPublication publication, BrokerMessageOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(publication);

        Topic = publication.Topic;
        Payload = publication.Payload;
        IsRetained = options?.IsRetained ?? false;
        _settle = options?.Settle ?? (() =>
        {
        });
    }

    /// <summary>The topic it came to, by its tokens.</summary>
    public IReadOnlyList<string> Topic { get; }

    /// <summary>Its payload.</summary>
    public ReadOnlyMemory<byte> Payload { get; }

    /// <summary>Whether its broker handed it on as one it kept retained, which no parcel is (spec 15.23).</summary>
    public bool IsRetained { get; }

    /// <summary>Acknowledges it to its broker, once: a second call does nothing.</summary>
    public void Settle()
    {
        if (Interlocked.Exchange(ref _isSettled, 1) == 0)
        {
            _settle();
        }
    }
}

/// <summary>How an adapter hands a message on.</summary>
public sealed record BrokerMessageOptions
{
    /// <summary>Whether its broker kept it retained.</summary>
    public bool IsRetained { get; init; }

    /// <summary>What acknowledges it to its broker; nothing when none, as at most once.</summary>
    public Action? Settle { get; init; }
}

/// <summary>
/// One broker's client, as its participant takes it (spec 15.24): the identity its broker
/// authenticates its link by; a link that keeps no broker session; publications said taken or
/// refused; subscriptions said held; each message with the topic it came to and its
/// acknowledgement; its link lost, and whether another link of its identity took it over; the
/// largest payload a message to a topic carries, its inbox among them; the delivery it gives;
/// whether its leg is secure; and what it offers besides. It depends on no part of Bead's but this
/// contract, so a broker's library stays its adapter's.
/// </summary>
public interface IBrokerAdapter
{
    /// <summary>The type its handles begin with: <see cref="TransportTypes.Broker"/> in memory, <c>MQTT</c>, <c>AMQP</c>, <c>NATS</c>.</summary>
    string Type { get; }

    /// <summary>The identity its broker authenticates its link by, a token (spec 15.16): never one Bead draws.</summary>
    string Id { get; }

    /// <summary>What it offers besides what every adapter offers.</summary>
    BrokerCapabilities Capabilities { get; }

    /// <summary>The delivery its broker gives its publications.</summary>
    BrokerDelivery Delivery { get; }

    /// <summary>Whether its leg is secure: its connection under TLS, its broker on the loopback, or in memory (spec 15.22).</summary>
    bool IsSecure { get; }

    /// <summary>
    /// The largest payload a message to <paramref name="topic"/>, its own inbox, carries whole: the
    /// receive bound its participant announces, asked once, as it is built.
    /// </summary>
    long ReceiveBound(IReadOnlyList<string> topic);

    /// <summary>Each message it received, in the order its broker handed them.</summary>
    event Action<BrokerMessage>? Message;

    /// <summary>
    /// Its link down, once an incarnation: lost, its participant closes each connection and starts it
    /// again; or taken over, and its participant connects no more until it is started again.
    /// </summary>
    event Action<BrokerDown>? Down;

    /// <summary>
    /// Connects a link that keeps no broker session, its will set where it offers one; settles once
    /// its broker took it.
    /// </summary>
    Task Start(BrokerStart? start = null);

    /// <summary>Holds a subscription to <paramref name="topic"/>, alone or in a group; settles once its broker holds it.</summary>
    Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null);

    /// <summary>Lets the subscription to <paramref name="topic"/> go.</summary>
    Task Unsubscribe(IReadOnlyList<string> topic);

    /// <summary>
    /// Publishes a payload; settles once its broker took it, at least once, or as it goes, at most
    /// once, <see cref="BrokerPublished.Taken"/>; or <see cref="BrokerPublished.NoSubscriber"/> when
    /// no subscriber takes it, where its broker says so.
    /// </summary>
    Task<BrokerPublished> Publish(BrokerPublication publication);

    /// <summary>The largest payload a message it publishes to <paramref name="topic"/> carries whole, its own bytes deducted.</summary>
    long MaximumPayloadBytes(IReadOnlyList<string> topic);

    /// <summary>Ends its link cleanly, so its broker publishes no will.</summary>
    [SuppressMessage(
        "Naming",
        "CA1716:Identifiers should not match keywords",
        Justification = "an adapter's stop is every transport's Stop and the TypeScript side's stop: one word, one meaning (0003)")]
    Task Stop();
}
