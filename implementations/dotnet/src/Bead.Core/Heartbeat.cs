namespace Bead;

/// <summary>What a heartbeat does of a silent connection: ping it, and drop it once it answered nothing.</summary>
internal sealed record HeartbeatHooks
{
    /// <summary>Pings the connection: nothing of it came for a heartbeat.</summary>
    public required Action Ping { get; init; }

    /// <summary>Drops the connection: nothing of it came for a heartbeat after its ping.</summary>
    public required Action Drop { get; init; }
}

/// <summary>
/// One connection's heartbeat over a broker (spec 15.21), the twin of the TypeScript side's
/// <c>heartbeat.ts</c>: it pings a connection once nothing of it has come for its heartbeat, and
/// drops it when nothing of it has come by a heartbeat after that ping; anything heard of it
/// answers, as TCP sends a keep-alive only when nothing came within its interval (RFC 9293 §3.8.4).
/// It runs on the platform's timer, never the clock a side is given, as a WebSocket's ping does on
/// either side (0011); without end, it arms nothing.
/// </summary>
internal sealed class Heartbeat
{
    private readonly TimeSpan _heartbeat;
    private readonly HeartbeatHooks _hooks;
    // the platform's: what a heartbeat plays on in real time
    private readonly TimeProvider _clock = TimeProvider.System;
    private readonly Lock _gate = new();
    private readonly ITimer? _timer;
    private long _lastHeard;
    private long? _pingedAt;
    private bool _isStopped;

    /// <summary>A heartbeat of <paramref name="heartbeat"/>, held already, its timer armed; none for <see cref="Timeout.InfiniteTimeSpan"/>.</summary>
    public Heartbeat(TimeSpan heartbeat, HeartbeatHooks hooks)
    {
        _heartbeat = heartbeat;
        _hooks = hooks;
        _lastHeard = _clock.GetTimestamp();

        if (heartbeat != Timeout.InfiniteTimeSpan)
        {
            _timer = _clock.CreateTimer(
                (_) =>
                {
                    Beat();
                },
                null,
                Timeout.InfiniteTimeSpan,
                Timeout.InfiniteTimeSpan);

            // armed once held, so a beat that comes at once finds it
            _timer.Change(heartbeat, Timeout.InfiniteTimeSpan);
        }
    }

    /// <summary>Something of the connection came: it is alive, and its silence starts again.</summary>
    public void Heard()
    {
        lock (_gate)
        {
            _lastHeard = _clock.GetTimestamp();
            _pingedAt = null;
        }
    }

    /// <summary>Nothing more is beaten: the connection ended.</summary>
    public void Stop()
    {
        lock (_gate)
        {
            _isStopped = true;
        }

        _timer?.Dispose();
    }

    // its timer's: a ping once silent for a heartbeat, a drop once silent for one past its ping,
    // else armed again for what is left of the silence it waits
    private void Beat()
    {
        Action? act = null;
        TimeSpan next;

        lock (_gate)
        {
            if (_isStopped)
            {
                return;
            }

            var silent = _clock.GetElapsedTime(_lastHeard);

            if (_pingedAt is { } pingedAt)
            {
                if (_clock.GetElapsedTime(pingedAt) >= _heartbeat)
                {
                    _isStopped = true;
                    act = _hooks.Drop;
                    next = Timeout.InfiniteTimeSpan;
                }
                else
                {
                    next = _heartbeat - _clock.GetElapsedTime(pingedAt);
                }
            }
            else if (silent >= _heartbeat)
            {
                _pingedAt = _clock.GetTimestamp();
                act = _hooks.Ping;
                next = _heartbeat;
            }
            else
            {
                next = _heartbeat - silent;
            }

            if (next != Timeout.InfiniteTimeSpan)
            {
                _timer?.Change(next, Timeout.InfiniteTimeSpan);
            }
        }

        act?.Invoke();
    }
}
