namespace Bead;

/// <summary>
/// A call the peer opened that this side still owes an answer: its source of cancellation — the
/// resolver's signal, and what tells one call from another on the same call id — whether its answer
/// is going out, and what it receives of its payload, while it does.
/// </summary>
internal sealed class AnsweringCall
{
    public required CancellationTokenSource Source { get; init; }

    public bool IsAnswered { get; set; }

    /// <summary>Whether its call ended, said at once on the router's scheduler; its signal follows.</summary>
    public bool IsAborted { get; set; }

    /// <summary>What it receives of its payload as a transfer; none once the call leaves.</summary>
    public RequestReceiving? Receiving { get; set; }

    /// <summary>The call's session, once its credential resolved; none for a call in none.</summary>
    public CallSession? Session { get; set; }

    /// <summary>What hears, on the router's scheduler, that the call ended before its answer went: a result going as a transfer.</summary>
    public Action<Exception>? OnAbort { get; set; }
}

/// <summary>
/// A request whose payload comes as a transfer: where it is answered, and the resolver it goes to
/// once whole.
/// </summary>
internal sealed record RequestReceiving(AnswerTarget Target, AnsweringCall Answering, IRequestHandler Resolver, Receiving Transfer);

/// <summary>How the calls a router answers are built.</summary>
internal sealed record AnsweringCallsOptions
{
    /// <summary>The transfers a connection receives at once, and how long a call abandoned stays.</summary>
    public required RouterLimits Limits { get; init; }

    /// <summary>Runs what a timer hears on the router's scheduler.</summary>
    public required Action<Action> Post { get; init; }

    /// <summary>What its timers run on.</summary>
    public required TimeProvider Clock { get; init; }

    /// <summary>Hears what a call received of its payload as the call leaves, once.</summary>
    public Action<RequestReceiving>? OnRemove { get; init; }
}

/// <summary>
/// The calls the peer opened and this side still owes an answer, by connection and call id. A
/// request is found again by its header, the very object dispatched: an answer given a copy of it
/// finds no call, and goes out whatever became of the call it was for.
///
/// What a call receives of its payload leaves with the call, whichever way the call leaves. A call
/// that received a transfer and ends — answered, refused, cancelled — stays abandoned for the
/// inactivity a transfer is allowed, since what its credit let the peer send may still come, a copy
/// or out of order; the oldest of a connection's yields once it keeps
/// <see cref="RouterLimits.MaximumTransfers"/>. A call that goes with its connection is abandoned by
/// none. Touched on its router's scheduler alone.
/// </summary>
internal sealed class AnsweringCalls(AnsweringCallsOptions options)
{
    private readonly Dictionary<string, Dictionary<uint, AnsweringCall>> _answering = [];
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<RequestHeader, AnsweringCall> _dispatched = [];

    // the calls whose transfer ended, oldest first, and the end their credit reached
    private readonly Dictionary<string, OrderedDictionary<uint, Abandoned>> _abandoned = [];

    /// <summary>
    /// The end the credit of a call abandoned reached: what comes under it is late, what comes past
    /// it was never granted. None for a call not abandoned.
    /// </summary>
    public long? AbandonedEndOf(CallAddress call)
    {
        return _abandoned.TryGetValue(call.ConnectionHandle, out var calls) && calls.TryGetValue(call.CallId, out var abandoned)
            ? abandoned.CreditEnd
            : null;
    }

    /// <summary>
    /// Marks the call of a request answered as its answer goes out: a second answer goes nowhere,
    /// and the call stays until that answer closes it.
    /// </summary>
    public void Answer(AnswerTarget request)
    {
        var entry = Get(new CallAddress(request.Header.CallId, request.ConnectionHandle));

        if (entry is not null && _dispatched.TryGetValue(request.Header, out var dispatched) && ReferenceEquals(entry, dispatched))
        {
            entry.IsAnswered = true;
        }
    }

    /// <summary>Gives a call what it receives of its payload, until the call leaves.</summary>
    public void Attach(CallAddress call, RequestReceiving receiving)
    {
        if (Get(call) is { } entry)
        {
            entry.Receiving = receiving;
        }
    }

    /// <summary>Takes out the call <paramref name="call"/> names — only while it is <paramref name="only"/>.</summary>
    public void Close(CallAddress call, AnsweringCall only)
    {
        Forget(call, only);
    }

    /// <summary>The call of the request dispatched with <paramref name="header"/>; none for one never dispatched.</summary>
    public AnsweringCall? CallOf(RequestHeader header)
    {
        return _dispatched.TryGetValue(header, out var call) ? call : null;
    }

    /// <summary>What it holds: the calls being answered, those abandoned, and their connections.</summary>
    public Gauges Gauges()
    {
        return Bead.Gauges.Of(
            new Dictionary<string, long>
            {
                ["abandonedCalls"] = _abandoned.Values.Sum((calls) =>
                {
                    return (long)calls.Count;
                }),
                ["answeringCalls"] = _answering.Values.Sum((calls) =>
                {
                    return (long)calls.Count;
                }),
            },
            _answering.Keys.Concat(_abandoned.Keys));
    }

    /// <summary>Whether the peer's call is open on a call id, whichever request opened it.</summary>
    public bool Has(CallAddress call)
    {
        return Get(call) is not null;
    }

    /// <summary>
    /// Whether the call of a request is still to be answered; a request never dispatched is taken
    /// as one to answer.
    /// </summary>
    public bool IsAnswering(AnswerTarget request)
    {
        if (!_dispatched.TryGetValue(request.Header, out var dispatched))
        {
            return true;
        }

        var entry = Get(new CallAddress(request.Header.CallId, request.ConnectionHandle));

        return entry is not null && ReferenceEquals(entry, dispatched) && !entry.IsAnswered;
    }

    /// <summary>Opens the call of a request as it is dispatched; a call abandoned on its call id is forgotten.</summary>
    public AnsweringCall Open(AnswerTarget request)
    {
        var call = new AnsweringCall { Source = new CancellationTokenSource() };

        if (!_answering.TryGetValue(request.ConnectionHandle, out var calls))
        {
            calls = [];
            _answering[request.ConnectionHandle] = calls;
        }

        ForgetAbandoned(new CallAddress(request.Header.CallId, request.ConnectionHandle), null);
        calls[request.Header.CallId] = call;
        _dispatched.AddOrUpdate(request.Header, call);

        return call;
    }

    /// <summary>What a call receives of its payload; none for a call that receives none.</summary>
    public RequestReceiving? ReceivingOf(CallAddress call)
    {
        return Get(call)?.Receiving;
    }

    /// <summary>Takes a call out, and gives it.</summary>
    public AnsweringCall? Take(CallAddress call)
    {
        return Forget(call, null);
    }

    /// <summary>
    /// Takes out every call — a connection's alone, when given — and gives them, for the caller to
    /// abort; the calls abandoned go with them, and none is abandoned.
    /// </summary>
    public List<AnsweringCall> TakeAll(string? connectionHandle)
    {
        var handles = connectionHandle is null ? [.. _answering.Keys.Union(_abandoned.Keys)] : new[] { connectionHandle };
        var taken = new List<AnsweringCall>();

        foreach (var handle in handles)
        {
            if (_answering.TryGetValue(handle, out var calls))
            {
                foreach (var callId in calls.Keys.ToList())
                {
                    taken.Add(Forget(new CallAddress(callId, handle), null)!);
                }
            }

            if (_abandoned.TryGetValue(handle, out var abandoned))
            {
                foreach (var callId in abandoned.Keys.ToList())
                {
                    ForgetAbandoned(new CallAddress(callId, handle), null);
                }
            }
        }

        return taken;
    }

    private AnsweringCall? Get(CallAddress call)
    {
        return _answering.TryGetValue(call.ConnectionHandle, out var calls) && calls.TryGetValue(call.CallId, out var entry)
            ? entry
            : null;
    }

    // takes a call out — only while it is `only`, when given — and its connection's map once empty;
    // what it received leaves with it, its call abandoned
    private AnsweringCall? Forget(CallAddress call, AnsweringCall? only)
    {
        if (!_answering.TryGetValue(call.ConnectionHandle, out var calls)
            || !calls.TryGetValue(call.CallId, out var entry)
            || (only is not null && !ReferenceEquals(entry, only)))
        {
            return null;
        }

        calls.Remove(call.CallId);

        if (calls.Count == 0)
        {
            _answering.Remove(call.ConnectionHandle);
        }

        if (entry.Receiving is { } receiving)
        {
            entry.Receiving = null;
            Abandon(call, receiving.Transfer.Incoming.CreditEnd);
            options.OnRemove?.Invoke(receiving);
        }

        return entry;
    }

    // keeps a call abandoned until its timer fires, the oldest of its connection's yielding
    private void Abandon(CallAddress call, long creditEnd)
    {
        if (!_abandoned.TryGetValue(call.ConnectionHandle, out var calls))
        {
            calls = [];
            _abandoned[call.ConnectionHandle] = calls;
        }

        ForgetAbandoned(call, null);

        while (calls.Count > 0 && calls.Count >= options.Limits.MaximumTransfers)
        {
            ForgetAbandoned(new CallAddress(calls.GetAt(0).Key, call.ConnectionHandle), null);
        }

        // the connection's map may have gone with the last call it forgot
        _abandoned[call.ConnectionHandle] = calls;

        Abandoned? abandoned = null;
        var timer = options.Clock.CreateTimer(
            (_) =>
            {
                options.Post(() =>
                {
                    ForgetAbandoned(call, abandoned);
                });
            },
            null,
            options.Limits.TransferInactivityTimeout,
            Timeout.InfiniteTimeSpan);

        abandoned = new Abandoned(creditEnd, timer);
        calls[call.CallId] = abandoned;
    }

    // forgets a call abandoned — only while it is `only`, when given — and its timer
    private void ForgetAbandoned(CallAddress call, Abandoned? only)
    {
        if (!_abandoned.TryGetValue(call.ConnectionHandle, out var calls)
            || !calls.TryGetValue(call.CallId, out var abandoned)
            || (only is not null && !ReferenceEquals(abandoned, only)))
        {
            return;
        }

        abandoned.Timer.Dispose();
        calls.Remove(call.CallId);

        if (calls.Count == 0)
        {
            _abandoned.Remove(call.ConnectionHandle);
        }
    }

    // a call whose transfer ended: the end its credit reached, and what forgets it
    private sealed record Abandoned(long CreditEnd, ITimer Timer);
}
