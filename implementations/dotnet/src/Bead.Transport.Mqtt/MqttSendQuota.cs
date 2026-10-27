namespace Bead.Transport.Mqtt;

/// <summary>
/// The send quota of one incarnation of a link (MQTT 5.0 §4.9, [MQTT-3.3.4-7], [-8]; spec 15.28):
/// at most its CONNACK's Receive Maximum of its PUBLISH packets of QoS 1 unacknowledged, each PUBACK
/// replenishing it, later ones waiting in their order and sent as it frees; no other packet waits
/// for it. MQTTnet keeps none of its own (the round's T1), so the adapter keeps it. A publication
/// that waits and is given up leaves the queue, nothing sent; the incarnation's end fails every one
/// that waits.
/// </summary>
internal sealed class MqttSendQuota
{
    private readonly Lock _gate = new();
    private readonly LinkedList<Waiting> _waiting = [];
    private readonly int _receiveMaximum;
    private int _inFlight;
    private Exception? _ended;

    /// <summary>A quota of <paramref name="receiveMaximum"/> PUBLISH packets unacknowledged: 65,535 where the CONNACK names none.</summary>
    public MqttSendQuota(int receiveMaximum)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(receiveMaximum, 1);

        _receiveMaximum = receiveMaximum;
    }

    /// <summary>The PUBLISH packets sent and not yet acknowledged.</summary>
    public int InFlight
    {
        get
        {
            lock (_gate)
            {
                return _inFlight;
            }
        }
    }

    /// <summary>The publications that wait for the quota to free.</summary>
    public int Queued
    {
        get
        {
            lock (_gate)
            {
                return _waiting.Count;
            }
        }
    }

    /// <summary>
    /// Sends by <c>Send</c> once the quota has room: at once where it has and nothing waits before
    /// it, in its order otherwise; settles once sent. A cancel of <c>Token</c> while it waits takes it
    /// out of the queue, nothing sent, an <see cref="OperationCanceledException"/>; the quota's end
    /// while it waits fails it with that end's exception.
    /// </summary>
    public Task Enqueue((Action Send, CancellationToken Token) publication)
    {
        var (send, token) = publication;
        Waiting waiting;

        lock (_gate)
        {
            if (_ended is { } ended)
            {
                return Task.FromException(ended);
            }

            if (token.IsCancellationRequested)
            {
                return Task.FromCanceled(token);
            }

            if (_waiting.Count == 0 && _inFlight < _receiveMaximum)
            {
                _inFlight += 1;
                send();

                return Task.CompletedTask;
            }

            waiting = new Waiting(send);
            waiting.Node = _waiting.AddLast(waiting);
        }

        // * given up while it waits: out of the queue, nothing sent, its link kept
        var registration = token.Register(() =>
        {
            lock (_gate)
            {
                if (waiting.Node?.List is null)
                {
                    return;
                }

                _waiting.Remove(waiting.Node);
            }

            waiting.Sent.TrySetCanceled(token);
        });

        _ = waiting.Sent.Task.ContinueWith(
            (_) =>
            {
                registration.Dispose();
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        return waiting.Sent.Task;
    }

    /// <summary>A PUBACK came: one more of room, and the next that waits sent, in its order.</summary>
    public void Release()
    {
        var sent = new List<Waiting>();

        lock (_gate)
        {
            if (_ended is not null)
            {
                return;
            }

            _inFlight = Math.Max(0, _inFlight - 1);

            // ! sent under the gate, so that two PUBACKs that free two places send in their order
            while (_inFlight < _receiveMaximum && _waiting.First is { } next)
            {
                _waiting.RemoveFirst();
                _inFlight += 1;
                next.Value.Send();
                sent.Add(next.Value);
            }
        }

        foreach (var waiting in sent)
        {
            waiting.Sent.TrySetResult();
        }
    }

    /// <summary>The incarnation ended: every publication that waits fails with <paramref name="reason"/>, and none goes after it.</summary>
    public void End(Exception reason)
    {
        List<Waiting> failed;

        lock (_gate)
        {
            if (_ended is not null)
            {
                return;
            }

            _ended = reason;
            failed = [.. _waiting];
            _waiting.Clear();
        }

        foreach (var waiting in failed)
        {
            waiting.Sent.TrySetException(reason);
        }
    }

    // a publication that waits for room: what sends it, and what settles once it went
    private sealed class Waiting(Action send)
    {
        public Action Send { get; } = send;

        public TaskCompletionSource Sent { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public LinkedListNode<Waiting>? Node { get; set; }
    }
}
