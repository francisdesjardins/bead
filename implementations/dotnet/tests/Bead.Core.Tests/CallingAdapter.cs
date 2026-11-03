using System.Collections.Concurrent;

namespace Bead.Tests;

/// <summary>
/// An adapter that writes down each call its participant makes of it, in order, and passes it on:
/// what it publishes to a topic bounded by <see cref="Room"/> when given; its leg secure as
/// <see cref="Secure"/> says when given; each start after its first <see cref="Starts"/> refused as
/// it returns when given; its first <see cref="Refuses"/> starts refused as a misuse, as an adapter
/// whose link is up already refuses one, when given; each start waiting for its stop's token, then
/// failing, where <see cref="GivesUp"/> says so; and each start after its first
/// <see cref="HoldsStart"/> held, heeding no token, until the test releases it, when given.
/// </summary>
internal sealed class CallingAdapter(MemoryBrokerAdapter inner) : IBrokerAdapter
{
    // the starts it holds, unreleased, the first asked first
    private readonly ConcurrentQueue<TaskCompletionSource> _held = new();

    public long? Room { get; init; }

    public bool? Secure { get; init; }

    public int? Starts { get; init; }

    public int? Refuses { get; init; }

    public bool GivesUp { get; init; }

    public int? HoldsStart { get; init; }

    /// <summary>The starts it holds, unreleased.</summary>
    public int Holding
    {
        get
        {
            return _held.Count;
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

    /// <summary>Each call its participant made of it, in order.</summary>
    public ConcurrentQueue<string> Calls { get; } = new();

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
            return Secure ?? inner.IsSecure;
        }
    }

    public long ReceiveBound(IReadOnlyList<string> topic)
    {
        return inner.ReceiveBound(topic);
    }

    public Task Start(BrokerStart? start = null)
    {
        Calls.Enqueue("start");

        var started = Calls.Count((call) =>
        {
            return call == "start";
        });

        if (Starts is { } starts && started > starts)
        {
            return Task.FromException(new IOException("refused at once"));
        }

        if (Refuses is { } refuses && started <= refuses)
        {
            return Task.FromException(new InvalidOperationException($"the link of {Id} is up already"));
        }

        if (GivesUp)
        {
            return GivingUp(start);
        }

        if (HoldsStart is { } holds && started > holds)
        {
            return Held(start);
        }

        return inner.Start(start);
    }

    /// <summary>Releases the start its participant asked first of those it holds.</summary>
    public bool Release()
    {
        return _held.TryDequeue(out var release) && release.TrySetResult();
    }

    // * it waits for its stop's token, then fails, saying so
    private static async Task GivingUp(BrokerStart? start)
    {
        var stopping = start?.CancellationToken ?? CancellationToken.None;

        await Task.Delay(Timeout.InfiniteTimeSpan, stopping).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);

        throw new IOException("the adapter gave up its start");
    }

    // * held as it is asked, its token unheard: it goes on once the test releases it
    private async Task Held(BrokerStart? start)
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        _held.Enqueue(release);
        await release.Task;
        await inner.Start(start);
    }

    public Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null)
    {
        Calls.Enqueue($"subscribe {string.Join('/', topic)}");

        return inner.Subscribe(topic, subscription);
    }

    public Task Unsubscribe(IReadOnlyList<string> topic)
    {
        Calls.Enqueue($"unsubscribe {string.Join('/', topic)}");

        return inner.Unsubscribe(topic);
    }

    public Task<BrokerPublished> Publish(BrokerPublication publication)
    {
        Calls.Enqueue($"publish {string.Join('/', publication.Topic)}");

        return inner.Publish(publication);
    }

    public long MaximumPayloadBytes(IReadOnlyList<string> topic)
    {
        return Room ?? inner.MaximumPayloadBytes(topic);
    }

    public Task Stop()
    {
        Calls.Enqueue("stop");

        return inner.Stop();
    }
}
