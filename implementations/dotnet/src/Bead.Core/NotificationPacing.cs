namespace Bead;

/// <summary>What a paced subscription queues at most, unless its router says otherwise.</summary>
public sealed record PacingLimits
{
    /// <summary>The limits a server holds by when its options say nothing: 64 notifications, 1 MiB.</summary>
    public static PacingLimits Default { get; } = new();

    /// <summary>The notifications a paced subscription queues at most, above 0.</summary>
    public int MaximumQueuedNotifications { get; init; } = 64;

    /// <summary>The bytes they hold together at most, above 0.</summary>
    public int MaximumQueuedNotificationBytes { get; init; } = 1_048_576;

    /// <summary>These limits, checked: an <see cref="ArgumentException"/> naming the first not above 0.</summary>
    public PacingLimits Validate()
    {
        (string Name, int Value)[] limits =
        [
            (nameof(MaximumQueuedNotifications), MaximumQueuedNotifications),
            (nameof(MaximumQueuedNotificationBytes), MaximumQueuedNotificationBytes),
        ];

        foreach (var (name, value) in limits)
        {
            if (value < 1)
            {
                throw new ArgumentException($"{name} is a whole number above 0, not {value}");
            }
        }

        return this;
    }
}

/// <summary>What a paced subscription does with a notification offered to it.</summary>
internal enum PacingOutcome
{
    /// <summary>Credited: it goes now.</summary>
    Send,

    /// <summary>Past the credit: it waits in the queue.</summary>
    Queued,

    /// <summary>Past the credit, and the queue past its bounds: the subscription ends.</summary>
    Exceeded,
}

/// <summary>
/// One paced subscription's credit and queue. Its client credited the first notification by asking;
/// each credit after raises the count it may have been sent. Past it, a notification is queued: one
/// with a key takes the place of the one queued under that key, which keeps its place in the queue,
/// so none waits forever behind newer ones; one without is queued last, under a key of its own that
/// no other matches. Touched on its router's scheduler alone.
/// </summary>
internal sealed class NotificationPacing(PacingLimits limits)
{
    private readonly OrderedDictionary<object, ReadOnlyMemory<byte>> _queue = [];
    private long _creditEnd = 1;
    private long _sent;
    private long _queuedBytes;

    public bool IsPaused
    {
        get
        {
            return _sent >= _creditEnd;
        }
    }

    public int QueuedNotifications
    {
        get
        {
            return _queue.Count;
        }
    }

    public long QueuedNotificationBytes
    {
        get
        {
            return _queuedBytes;
        }
    }

    /// <summary>Raises the credit to <paramref name="end"/>, the highest standing, and gives what it lets go.</summary>
    public List<ReadOnlyMemory<byte>> Credit(long end)
    {
        var released = new List<ReadOnlyMemory<byte>>();

        _creditEnd = Math.Max(_creditEnd, end);

        while (_sent < _creditEnd && _queue.Count > 0)
        {
            var payload = _queue.GetAt(0).Value;

            _queue.RemoveAt(0);
            _queuedBytes -= payload.Length;
            _sent += 1;
            released.Add(payload);
        }

        return released;
    }

    /// <summary>A notification offered: sent, queued, or past the queue's bounds.</summary>
    public PacingOutcome Offer(ReadOnlyMemory<byte> payload, object? key)
    {
        // credit left means nothing is queued: what the credit let go went at once
        if (_sent < _creditEnd)
        {
            _sent += 1;

            return PacingOutcome.Send;
        }

        var slot = key ?? new object();

        _queuedBytes += payload.Length - (_queue.TryGetValue(slot, out var replaced) ? replaced.Length : 0);
        _queue[slot] = payload;

        return _queue.Count > limits.MaximumQueuedNotifications || _queuedBytes > limits.MaximumQueuedNotificationBytes
            ? PacingOutcome.Exceeded
            : PacingOutcome.Queued;
    }
}
