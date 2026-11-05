using System.Collections.Concurrent;

namespace Bead.Tests;

/// <summary>
/// An adapter that writes down each call its participant makes of it, in order, and passes it on:
/// what it publishes to a topic bounded by <see cref="Room"/> when given; its leg secure as
/// <see cref="Secure"/> says when given; each start after its first <see cref="Starts"/> refused as
/// it returns when given; its first <see cref="Refuses"/> starts refused as a misuse, as an adapter
/// whose link is up already refuses one, when given; each start waiting for its stop's token, then
/// failing, where <see cref="GivesUp"/> says so; each start after its first
/// <see cref="HoldsStart"/> held, heeding no token, until the test releases it, when given, and each
/// one while <see cref="HoldingStarts"/> holds; and each
/// start refused as a misuse while <see cref="Refusing"/> holds, as its broker would refuse one while
/// a link of its id is up, decided before its participant hears a loss, so no thread races it; each
/// subscription to a server's name made at once, its broker's word held until the test grants it,
/// where <see cref="HoldsNames"/> says so; each unsubscription of a server's name held, unmade,
/// until the test settles it, made then or failed as it says, where
/// <see cref="HoldsUnsubscribes"/> says so; each stop held, until the test releases it, where
/// <see cref="HoldsStops"/> says so.
/// </summary>
internal sealed class CallingAdapter(MemoryBrokerAdapter inner) : IBrokerAdapter
{
    // the starts it holds, unreleased, the first asked first
    private readonly ConcurrentQueue<TaskCompletionSource> _held = new();

    // the stops it holds, unreleased, the first asked first
    private readonly ConcurrentQueue<TaskCompletionSource> _stops = new();

    // the subscriptions to a server's name it holds, ungranted, the first asked first
    private readonly ConcurrentQueue<TaskCompletionSource> _names = new();

    // the unsubscriptions of a server's name it holds, unsettled, the first asked first
    private readonly ConcurrentQueue<TaskCompletionSource> _unsubscribing = new();

    // whether a start is refused as a misuse, set by the test from its own thread
    private volatile bool _refusing;

    // whether each start is held, set by the test from its own thread
    private volatile bool _holdingStarts;

    // the listeners its participant holds on it, counted as they come and go
    private int _listening;

    public long? Room { get; init; }

    public bool? Secure { get; init; }

    public int? Starts { get; init; }

    public int? Refuses { get; init; }

    public bool GivesUp { get; init; }

    public int? HoldsStart { get; init; }

    public bool HoldsStops { get; init; }

    public bool HoldsNames { get; init; }

    public bool HoldsUnsubscribes { get; init; }

    /// <summary>The subscriptions to a server's name it holds, ungranted.</summary>
    public int Naming
    {
        get
        {
            return _names.Count;
        }
    }

    /// <summary>The unsubscriptions of a server's name it holds, unsettled.</summary>
    public int Unsubscribing
    {
        get
        {
            return _unsubscribing.Count;
        }
    }

    /// <summary>The stops it holds, unreleased.</summary>
    public int Stopping
    {
        get
        {
            return _stops.Count;
        }
    }

    /// <summary>The listeners its participant holds on it, of its messages and of its link's loss.</summary>
    public int Listening
    {
        get
        {
            return Volatile.Read(ref _listening);
        }
    }

    /// <summary>Whether each start is refused as a misuse, as a link of its id up already is.</summary>
    public bool Refusing
    {
        get
        {
            return _refusing;
        }

        set
        {
            _refusing = value;
        }
    }

    /// <summary>Whether each start is held, heeding no token, until the test releases it.</summary>
    public bool HoldingStarts
    {
        get
        {
            return _holdingStarts;
        }

        set
        {
            _holdingStarts = value;
        }
    }

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
            Interlocked.Increment(ref _listening);
            inner.Message += value;
        }

        remove
        {
            Interlocked.Decrement(ref _listening);
            inner.Message -= value;
        }
    }

    public event Action<BrokerDown>? Down
    {
        add
        {
            Interlocked.Increment(ref _listening);
            inner.Down += value;
        }

        remove
        {
            Interlocked.Decrement(ref _listening);
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

        if (_refusing || (Refuses is { } refuses && started <= refuses))
        {
            return Task.FromException(new InvalidOperationException($"the link of {Id} is up already"));
        }

        if (GivesUp)
        {
            return GivingUp(start);
        }

        if ((HoldsStart is { } holds && started > holds) || _holdingStarts)
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

    /// <summary>Releases the stop its participant asked first of those it holds.</summary>
    public bool ReleaseStop()
    {
        return _stops.TryDequeue(out var release) && release.TrySetResult();
    }

    /// <summary>Grants the subscription to a server's name its participant asked first, its broker's word.</summary>
    public bool GrantName()
    {
        return _names.TryDequeue(out var grant) && grant.TrySetResult();
    }

    /// <summary>
    /// Settles the unsubscription its participant asked first of those it holds: made then, or
    /// failed with <paramref name="failure"/> where one is given.
    /// </summary>
    public bool SettleUnsubscribe(Exception? failure = null)
    {
        if (!_unsubscribing.TryDequeue(out var settle))
        {
            return false;
        }

        return failure is null ? settle.TrySetResult() : settle.TrySetException(failure);
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

        if (HoldsNames && topic is [_, "s", _])
        {
            var grant = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            // * made as it is asked: its broker's word held until the test grants it
            var subscribing = inner.Subscribe(topic, subscription);

            _names.Enqueue(grant);

            return Granted((grant.Task, subscribing));
        }

        return inner.Subscribe(topic, subscription);
    }

    public Task Unsubscribe(IReadOnlyList<string> topic)
    {
        Calls.Enqueue($"unsubscribe {string.Join('/', topic)}");

        if (HoldsUnsubscribes && topic is [_, "s", _])
        {
            var settle = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            _unsubscribing.Enqueue(settle);

            return Unsubscribed((settle.Task, topic));
        }

        return inner.Unsubscribe(topic);
    }

    // its broker's word once the test granted it
    private static async Task Granted((Task Grant, Task Subscribing) granted)
    {
        await granted.Grant;
        await granted.Subscribing;
    }

    // * unread by its broker until the test settles it: made then, or failed as it says
    private async Task Unsubscribed((Task Settle, IReadOnlyList<string> Topic) unsubscribed)
    {
        await unsubscribed.Settle;
        await inner.Unsubscribe(unsubscribed.Topic);
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

        return HoldsStops ? HeldStop() : inner.Stop();
    }

    // * held as it is asked: it goes on once the test releases it
    private async Task HeldStop()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        _stops.Enqueue(release);
        await release.Task;
        await inner.Stop();
    }
}
