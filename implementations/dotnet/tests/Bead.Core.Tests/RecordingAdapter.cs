using System.Collections.Concurrent;

namespace Bead.Tests;

/// <summary>
/// An adapter around another, passing every call on, that writes down what its participant asked
/// of each publication's life (spec 15.18, 15.22): an OPEN's, a DATA's that carries a credential,
/// and every other parcel's, as a case's <c>lives</c> reads them, whatever broker is beneath.
/// </summary>
internal sealed class RecordingAdapter(IBrokerAdapter inner) : IBrokerAdapter
{
    /// <summary>
    /// What each publication asked: <c>open</c>, <c>credential</c> or <c>other</c>, and its life,
    /// none when none, in the order they were published.
    /// </summary>
    public ConcurrentQueue<(string Kind, TimeSpan? ExpiresAfter)> Lives { get; } = new();

    /// <summary>The adapter beneath.</summary>
    public IBrokerAdapter Inner
    {
        get
        {
            return inner;
        }
    }

    public event Action<BrokerMessage>? Message
    {
        add
        {
            inner.Message += value;
        }

        remove
        {
            inner.Message -= value;
        }
    }

    public event Action<BrokerDown>? Down
    {
        add
        {
            inner.Down += value;
        }

        remove
        {
            inner.Down -= value;
        }
    }

    public string Type
    {
        get
        {
            return inner.Type;
        }
    }

    public string Id
    {
        get
        {
            return inner.Id;
        }
    }

    public BrokerCapabilities Capabilities
    {
        get
        {
            return inner.Capabilities;
        }
    }

    public BrokerDelivery Delivery
    {
        get
        {
            return inner.Delivery;
        }
    }

    public bool IsSecure
    {
        get
        {
            return inner.IsSecure;
        }
    }

    public long ReceiveBound(IReadOnlyList<string> topic)
    {
        return inner.ReceiveBound(topic);
    }

    public Task Start(BrokerStart? start = null)
    {
        return inner.Start(start);
    }

    public Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null)
    {
        return inner.Subscribe(topic, subscription);
    }

    public Task Unsubscribe(IReadOnlyList<string> topic)
    {
        return inner.Unsubscribe(topic);
    }

    public Task<BrokerPublished> Publish(BrokerPublication publication)
    {
        ArgumentNullException.ThrowIfNull(publication);

        var parcel = BrokerParcels.Read(publication.Payload).Parcel;
        var kind = parcel switch
        {
            { Kind: BrokerParcelKinds.Open } => "open",
            { Kind: BrokerParcelKinds.Data, Credential: not null } => "credential",
            _ => "other",
        };

        Lives.Enqueue((kind, publication.ExpiresAfter));

        return inner.Publish(publication);
    }

    public long MaximumPayloadBytes(IReadOnlyList<string> topic)
    {
        return inner.MaximumPayloadBytes(topic);
    }

    public Task Stop()
    {
        return inner.Stop();
    }
}
