namespace Bead;

/// <summary>A result that comes as a transfer: the header of its opening, and its bytes as they come.</summary>
internal sealed record ResultReceiving(ResultHeader Header, Receiving Transfer);

/// <summary>
/// A request waiting for its response: where it went, for a failure to say so; whether the
/// transport has it; how long it was given, for its call id to stay reserved once it is cancelled;
/// the bytes its result holds at most; the timer that ends it; and what it sends and receives as a
/// transfer.
/// </summary>
internal sealed class PendingRequest
{
    private readonly TaskCompletionSource<RouterResult> _completion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public required uint? DestinationId { get; init; }

    public required int MaximumPayloadBytes { get; init; }

    public required ProcedureAddress ProcedureAddress { get; init; }

    public required TimeSpan Timeout { get; init; }

    public Action<bool>? OnSent { get; init; }

    /// <summary>How it was counted as it started; none for a router given no registry.</summary>
    public StartedCall? Counted { get; init; }

    /// <summary>What its transport carries beside its request, a call's presenting ELSEWHERE; none for any other.</summary>
    public string? Carried { get; init; }

    public bool IsSent { get; set; }

    public ITimer? Timer { get; set; }

    /// <summary>Which arming of its timer stands: one stopped since, whose end was on its way, ends nothing.</summary>
    public int TimerGeneration { get; set; }

    /// <summary>What it receives of its result as a transfer, once the result's opening came.</summary>
    public ResultReceiving? Receiving { get; set; }

    /// <summary>What it sends of its payload as a transfer.</summary>
    public Sending? Sending { get; set; }

    public Task<RouterResult> Task
    {
        get
        {
            return _completion.Task;
        }
    }

    // * the call ends as its router settles it (spec/debugging.md 9.1), counted once, whichever
    // way settles it first
    public void Resolve(RouterResult result)
    {
        if (_completion.TrySetResult(result))
        {
            Counted?.End((CallOutcome.Result, null));
        }
    }

    public void Reject(Exception reason)
    {
        if (_completion.TrySetException(reason))
        {
            Counted?.End(StartedCall.EndingOf(reason));
        }
    }
}

/// <summary>
/// The calls a side of a router opened, by connection and call id, from the moment their call id is
/// drawn until they settle; and the call ids it reserved once a call ended unanswered, so what comes
/// late on one is known for late, and no call drawn meanwhile takes it. Its <c>OnRemove</c> hears
/// each call as it leaves, once, whichever way it leaves, for what it holds to go with it. Touched
/// on its router's scheduler alone, where its reservations' timers come back.
/// </summary>
internal sealed class PendingCalls
{
    // constants

    // how long a call id stays reserved when its call gave no timeout
    private static readonly TimeSpan ReservationDefault = TimeSpan.FromSeconds(5);

    private readonly CallIdSequence _sequence;
    private readonly Func<uint, string, bool> _isCallIdInUse;
    private readonly TimeProvider _clock;
    private readonly Action<Action> _post;
    private readonly Action<PendingRequest>? _onRemove;
    private readonly Dictionary<string, Dictionary<uint, PendingRequest>> _pending = [];
    private readonly Dictionary<string, Dictionary<uint, Reservation>> _reservations = [];

    public PendingCalls(RouterSide side, PendingCallsOptions options)
    {
        _sequence = new CallIdSequence(side, options.LastCallId);
        _isCallIdInUse = options.IsCallIdInUse;
        _clock = options.Clock;
        _post = options.Post;
        _onRemove = options.OnRemove;
    }

    // helpers

    /// <summary>
    /// How long a call id stays reserved: its call's timeout, held, or the default for none or
    /// infinite.
    /// </summary>
    public static TimeSpan ReservationOf(TimeSpan? timeout)
    {
        return timeout is { } given && given != System.Threading.Timeout.InfiniteTimeSpan ? given : ReservationDefault;
    }

    /// <summary>
    /// A reservation held: rounded to the nearest whole millisecond, or none, for the default. One
    /// that is neither infinite — a call that waited on, which reserves for the default too, since
    /// nothing is reserved for ever — nor from 1 to <see cref="Clocks.LongestTimer"/> milliseconds,
    /// zero among them, is an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public static TimeSpan? AssertReservation(TimeSpan? timeout)
    {
        return timeout is { } given ? Clocks.AssertHeld(("a call id's reservation", nameof(timeout)), given) : null;
    }

    // definition

    public void Add(CallAddress call, PendingRequest pendingRequest)
    {
        EntriesOf(_pending, call.ConnectionHandle)[call.CallId] = pendingRequest;
    }

    /// <summary>
    /// A call id of this side's for a connection, skipping those waited on, reserved, or in use by
    /// the side; none once every one is.
    /// </summary>
    public uint? Draw(string connectionHandle)
    {
        return _sequence.Draw((candidate) =>
        {
            return Get(new CallAddress(candidate, connectionHandle)) is not null
                || IsReserved(candidate, connectionHandle)
                || _isCallIdInUse(candidate, connectionHandle);
        });
    }

    /// <summary>Takes a call out — only while <paramref name="only"/> is its request, when given.</summary>
    public void Forget(CallAddress call, PendingRequest? only = null)
    {
        if (!_pending.TryGetValue(call.ConnectionHandle, out var requests)
            || !requests.TryGetValue(call.CallId, out var pendingRequest)
            || (only is not null && !ReferenceEquals(pendingRequest, only)))
        {
            return;
        }

        requests.Remove(call.CallId);

        if (requests.Count == 0)
        {
            _pending.Remove(call.ConnectionHandle);
        }

        pendingRequest.Timer?.Dispose();
        _onRemove?.Invoke(pendingRequest);
    }

    /// <summary>What it holds: the calls waiting for their answer, the call ids reserved, and their connections.</summary>
    public Gauges Gauges()
    {
        return Bead.Gauges.Of(
            new Dictionary<string, long>
            {
                ["pendingCalls"] = _pending.Values.Sum((calls) =>
                {
                    return (long)calls.Count;
                }),
                ["reservedCallIds"] = _reservations.Values.Sum((calls) =>
                {
                    return (long)calls.Count;
                }),
            },
            _pending.Keys.Concat(_reservations.Keys));
    }

    public PendingRequest? Get(CallAddress call)
    {
        return _pending.TryGetValue(call.ConnectionHandle, out var requests)
            && requests.TryGetValue(call.CallId, out var pendingRequest)
            ? pendingRequest
            : null;
    }

    public bool IsReserved(uint callId, string connectionHandle)
    {
        return _reservations.TryGetValue(connectionHandle, out var reserved) && reserved.ContainsKey(callId);
    }

    /// <summary>
    /// Reserves a call id for <paramref name="timeout"/>, held as <see cref="AssertReservation"/>
    /// holds one, or for the default time for none or infinite; reserved twice, the later end stands,
    /// compared on the clock's monotonic reading.
    /// </summary>
    public void Reserve(CallAddress call, TimeSpan? timeout)
    {
        var lasts = ReservationOf(AssertReservation(timeout));
        var reserved = EntriesOf(_reservations, call.ConnectionHandle);

        if (reserved.TryGetValue(call.CallId, out var previous))
        {
            if (previous.Lasts - _clock.GetElapsedTime(previous.Started) >= lasts)
            {
                return;
            }

            previous.Timer.Dispose();
        }

        Reservation? reservation = null;
        var started = _clock.GetTimestamp();
        var timer = _clock.CreateTimer(
            (_) =>
            {
                _post(() =>
                {
                    ForgetReservation(call, reservation);
                });
            },
            null,
            lasts,
            System.Threading.Timeout.InfiniteTimeSpan);

        reservation = new Reservation(started, lasts, timer);
        reserved[call.CallId] = reservation;
    }

    /// <summary>
    /// Takes out every call waited on and every call id reserved — a connection's alone, when given
    /// — and gives the requests that were waiting, for the caller to reject.
    /// </summary>
    public List<PendingRequest> TakeAll(string? connectionHandle)
    {
        var handles = connectionHandle is null
            ? [.. _pending.Keys.Union(_reservations.Keys)]
            : new[] { connectionHandle };
        var waiting = new List<PendingRequest>();

        foreach (var handle in handles)
        {
            if (_pending.Remove(handle, out var requests))
            {
                waiting.AddRange(requests.Values);
            }

            if (_reservations.Remove(handle, out var reserved))
            {
                foreach (var reservation in reserved.Values)
                {
                    reservation.Timer.Dispose();
                }
            }
        }

        foreach (var pendingRequest in waiting)
        {
            pendingRequest.Timer?.Dispose();
            _onRemove?.Invoke(pendingRequest);
        }

        return waiting;
    }

    private static Dictionary<uint, T> EntriesOf<T>(Dictionary<string, Dictionary<uint, T>> calls, string connectionHandle)
    {
        if (!calls.TryGetValue(connectionHandle, out var entries))
        {
            entries = [];
            calls[connectionHandle] = entries;
        }

        return entries;
    }

    private void ForgetReservation(CallAddress call, Reservation? only)
    {
        if (!_reservations.TryGetValue(call.ConnectionHandle, out var reserved)
            || !reserved.TryGetValue(call.CallId, out var reservation)
            || !ReferenceEquals(reservation, only))
        {
            return;
        }

        reserved.Remove(call.CallId);

        if (reserved.Count == 0)
        {
            _reservations.Remove(call.ConnectionHandle);
        }
    }

    // a call id reserved: when, on the clock's monotonic reading, for how long, and what frees it
    private sealed record Reservation(long Started, TimeSpan Lasts, ITimer Timer);
}

/// <summary>How the pending calls of a router are built.</summary>
internal sealed record PendingCallsOptions
{
    public required Func<uint, string, bool> IsCallIdInUse { get; init; }

    public required TimeProvider Clock { get; init; }

    public required Action<Action> Post { get; init; }

    public uint? LastCallId { get; init; }

    /// <summary>Hears each call as it leaves, once.</summary>
    public Action<PendingRequest>? OnRemove { get; init; }
}
