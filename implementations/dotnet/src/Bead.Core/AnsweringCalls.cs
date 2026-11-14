namespace Bead;

/// <summary>
/// A call the peer opened that this side still owes an answer: its source of cancellation — the
/// resolver's signal, and what tells one call from another on the same call id — whether its answer
/// is going out, and what it receives of its payload, while it does.
/// </summary>
internal sealed class AnsweringCall
{
    // how its resolver runs — or its verifier, while its credential resolves: ! read and written by
    // Interlocked alone, as the turn that starts it, off the router's scheduler, races its call's end
    private int _run;

    // its resolver's run: waiting for its turn, running, handed nothing as its call ended first, or
    // settled once its call ended
    private enum ResolverRun
    {
        Queued,
        Running,
        Ended,
        Settled,
    }

    public required CancellationTokenSource Source { get; init; }

    /// <summary>The connection its request came on.</summary>
    public string ConnectionHandle { get; init; } = string.Empty;

    /// <summary>
    /// What its call received of its payload as a transfer, while its resolver outlives the call:
    /// none for one that received none, or settled.
    /// </summary>
    public Receiving? OutlivingTransfer { get; set; }

    public bool IsAnswered { get; set; }

    /// <summary>Whether its call ended, said at once on the router's scheduler, as its signal is; its signal's callbacks follow.</summary>
    public bool IsAborted { get; set; }

    /// <summary>What it receives of its payload as a transfer; none once the call leaves.</summary>
    public RequestReceiving? Receiving { get; set; }

    /// <summary>The call's session, once its credential resolved; none for a call in none.</summary>
    public CallSession? Session { get; set; }

    /// <summary>
    /// What its transport carried beside its request, kept for one presenting ELSEWHERE that names a
    /// destination alone, which its relay checks and moves to leg B; none for a procedure's call.
    /// </summary>
    public string? TransportCredential { get; set; }

    /// <summary>What hears, on the router's scheduler, that the call ended before its answer went: a result going as a transfer.</summary>
    public Action<Exception>? OnAbort { get; set; }

    /// <summary>How it was counted as it started; none once it ended, and for a router given no registry.</summary>
    public StartedCall? Counted { get; set; }

    /// <summary>
    /// Marks its resolver running as its turn comes, unless its call ended first: whether it runs.
    /// Safe on any thread.
    /// </summary>
    public bool TryRun()
    {
        return Interlocked.CompareExchange(ref _run, (int)ResolverRun.Running, (int)ResolverRun.Queued) == (int)ResolverRun.Queued;
    }

    /// <summary>
    /// Marks its call ended: whether its resolver was running then, which outlives it. One whose turn
    /// had not come is handed nothing.
    /// </summary>
    public bool End()
    {
        return Interlocked.CompareExchange(ref _run, (int)ResolverRun.Ended, (int)ResolverRun.Queued) == (int)ResolverRun.Running;
    }

    /// <summary>
    /// Its resolver settled while its call is open: it waits for a turn again, as the call of a
    /// verifier that settled waits for its resolver's.
    /// </summary>
    public void Rest()
    {
        Interlocked.CompareExchange(ref _run, (int)ResolverRun.Queued, (int)ResolverRun.Running);
    }

    /// <summary>Its resolver, which outlived its call, settled: nothing of it runs any more.</summary>
    public void Settle()
    {
        Interlocked.Exchange(ref _run, (int)ResolverRun.Settled);
    }
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

    /// <summary>
    /// Hears what a call received of its payload as the call leaves while its resolver runs, before
    /// <see cref="OnRemove"/>: that transfer outlives the call with its resolver.
    /// </summary>
    public Action<Receiving>? OnOutlive { get; init; }

    /// <summary>Hears a transfer that outlived its call as that call's resolver settles, once.</summary>
    public Action<Receiving>? OnSettle { get; init; }
}

/// <summary>
/// The calls the peer opened and this side still owes an answer, by connection and call id. A
/// request is found again by its header, the very object dispatched: an answer given a copy of it
/// finds no call, and is refused.
///
/// What a call receives of its payload leaves with the call, whichever way the call leaves. A call
/// that received a transfer and ends — answered, refused, cancelled — stays abandoned for the
/// inactivity a transfer is allowed, since what its credit let the peer send may still come, a copy
/// or out of order; the oldest of a connection's yields once it keeps
/// <see cref="RouterLimits.MaximumTransfers"/>. A call that goes with its connection is abandoned by
/// none.
///
/// A call whose resolver, or verifier, still runs as the call ends, answered or cancelled, outlives
/// it: it counts on its connection until that resolver settles, and the two counts together are
/// held to twice <see cref="RouterLimits.MaximumAnsweringCalls"/> (spec 9.2, step 3), as Go's
/// HTTP/2 server counts a handler until it returns. One its connection outlives counts side-wide
/// alone. Touched on its router's scheduler alone, but for <see cref="Run"/>.
/// </summary>
internal sealed class AnsweringCalls(AnsweringCallsOptions options)
{
    private readonly Dictionary<string, Dictionary<uint, AnsweringCall>> _answering = [];
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<RequestHeader, AnsweringCall> _dispatched = [];

    // by connection, the calls whose resolvers outlive them, until each settles
    private readonly Dictionary<string, HashSet<AnsweringCall>> _outliving = [];

    // the calls whose resolvers outlive a connection closed, side-wide, until each settles
    private readonly HashSet<AnsweringCall> _outlivingClosed = [];

    // by connection, the requests in a row refused past the calls it answers and those its
    // resolvers outlive
    private readonly Dictionary<string, int> _refusals = [];

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

    /// <summary>The calls a connection's peer has this side answer right now.</summary>
    public int CountOn(string connectionHandle)
    {
        return _answering.TryGetValue(connectionHandle, out var calls) ? calls.Count : 0;
    }

    /// <summary>
    /// What it holds: the calls being answered, the most on one connection under its ceiling,
    /// <see cref="RouterLimits.MaximumAnsweringCalls"/>, those abandoned, the resolvers that outlive
    /// their call over the whole side, those of connections closed among them, with no ceiling, the
    /// busiest connection's calls answered and outlived together under twice that bound, and their
    /// connections.
    /// </summary>
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
                ["largestAnsweringCalls"] = _answering.Values.Select((calls) =>
                {
                    return (long)calls.Count;
                }).DefaultIfEmpty().Max(),
                ["largestTrackedCalls"] = _answering.Keys.Union(_outliving.Keys).Select((connectionHandle) =>
                {
                    return (long)TrackedOn(connectionHandle);
                }).DefaultIfEmpty().Max(),
                ["outlivingResolvers"] = _outlivingClosed.Count + _outliving.Values.Sum((calls) =>
                {
                    return (long)calls.Count;
                }),
            },
            _answering.Keys.Concat(_abandoned.Keys).Concat(_outliving.Keys)) with
        {
            Ceilings = new Dictionary<string, long>
            {
                ["largestAnsweringCalls"] = options.Limits.MaximumAnsweringCalls,
                ["largestTrackedCalls"] = 2L * options.Limits.MaximumAnsweringCalls,
            },
        };
    }

    /// <summary>Whether the peer's call is open on a call id, whichever request opened it.</summary>
    public bool Has(CallAddress call)
    {
        return Get(call) is not null;
    }

    /// <summary>
    /// Whether the call of a request is still to be answered; a request never dispatched is open to
    /// none.
    /// </summary>
    public bool IsAnswering(AnswerTarget request)
    {
        if (!_dispatched.TryGetValue(request.Header, out var dispatched))
        {
            return false;
        }

        var entry = Get(new CallAddress(request.Header.CallId, request.ConnectionHandle));

        return entry is not null && ReferenceEquals(entry, dispatched) && !entry.IsAnswered;
    }

    /// <summary>Opens the call of a request as it is dispatched; a call abandoned on its call id is forgotten.</summary>
    public AnsweringCall Open(AnswerTarget request)
    {
        var call = new AnsweringCall { Source = new CancellationTokenSource(), ConnectionHandle = request.ConnectionHandle };

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

    /// <summary>
    /// Counts a request refused past the calls its connection answers and those its resolvers
    /// outlive, and gives how many came so in a row there, this one among them.
    /// </summary>
    public int RefusedPast(string connectionHandle)
    {
        var refusals = _refusals.GetValueOrDefault(connectionHandle) + 1;

        _refusals[connectionHandle] = refusals;

        return refusals;
    }

    /// <summary>
    /// Sets a connection's refusals in a row back to none: a request reached step 3 of spec 9.2 there
    /// and was not refused past the second count, admitted or refused at the first.
    /// </summary>
    public void Admitted(string connectionHandle)
    {
        _refusals.Remove(connectionHandle);
    }

    /// <summary>
    /// Marks a call's resolver running as its turn comes — or its verifier, as its credential starts
    /// to resolve — unless its call ended first: whether it runs. Safe on any thread: it touches the
    /// call alone.
    /// </summary>
    public static bool Run(AnsweringCall call)
    {
        ArgumentNullException.ThrowIfNull(call);

        return call.TryRun();
    }

    /// <summary>
    /// A call's resolver, or its verifier, settled — resolved, rejected or threw: one that outlived
    /// its call gives its place back, and what its call received with it; one whose call is open
    /// leaves it waiting for its next turn.
    /// </summary>
    public void Settle(AnsweringCall call)
    {
        ArgumentNullException.ThrowIfNull(call);

        if (_outliving.TryGetValue(call.ConnectionHandle, out var calls) && calls.Remove(call))
        {
            if (calls.Count == 0)
            {
                _outliving.Remove(call.ConnectionHandle);
            }

            Settled(call);

            return;
        }

        if (_outlivingClosed.Remove(call))
        {
            Settled(call);

            return;
        }

        call.Rest();
    }

    /// <summary>The calls a connection's peer has this side answer right now, and those its resolvers outlive.</summary>
    public int TrackedOn(string connectionHandle)
    {
        return CountOn(connectionHandle) + (_outliving.TryGetValue(connectionHandle, out var calls) ? calls.Count : 0);
    }

    /// <summary>Takes a call out, and gives it.</summary>
    public AnsweringCall? Take(CallAddress call)
    {
        return Forget(call, null);
    }

    /// <summary>
    /// Takes out every call — a connection's alone, when given — and gives them, for the caller to
    /// abort, then the calls whose resolvers outlive them there and were not told yet, as a
    /// connection that closes tells every resolver still running on it (spec 9.10); the calls
    /// abandoned go with them, and none is abandoned. Each resolver still running then counts
    /// side-wide alone, until it settles, and the connection's counts end with it.
    /// </summary>
    public List<AnsweringCall> TakeAll(string? connectionHandle)
    {
        var handles = connectionHandle is null
            ? [.. _answering.Keys.Union(_abandoned.Keys).Union(_outliving.Keys).Union(_refusals.Keys)]
            : new[] { connectionHandle };
        var taken = new List<AnsweringCall>();

        foreach (var handle in handles)
        {
            // the resolvers outliving their call there already, told unless their call's end told them
            var untold = _outliving.TryGetValue(handle, out var outlived)
                ? outlived.Where((call) =>
                {
                    return !call.IsAborted;
                }).ToList()
                : [];

            if (_answering.TryGetValue(handle, out var calls))
            {
                foreach (var callId in calls.Keys.ToList())
                {
                    taken.Add(Forget(new CallAddress(callId, handle), null)!);
                }
            }

            taken.AddRange(untold);

            // * the connection's counts end with it: what still runs counts side-wide alone
            if (_outliving.Remove(handle, out var outliving))
            {
                _outlivingClosed.UnionWith(outliving);
            }

            _refusals.Remove(handle);

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

        // * its resolver still running, it outlives the call, and keeps a place on its connection
        // until it settles (spec 9.2, step 3); one whose turn had not come is handed nothing
        var outlives = entry.End();

        if (outlives)
        {
            if (!_outliving.TryGetValue(call.ConnectionHandle, out var outliving))
            {
                outliving = [];
                _outliving[call.ConnectionHandle] = outliving;
            }

            outliving.Add(entry);
        }

        if (entry.Receiving is { } receiving)
        {
            entry.Receiving = null;
            Abandon(call, receiving.Transfer.Incoming.CreditEnd);

            if (outlives)
            {
                entry.OutlivingTransfer = receiving.Transfer;
                options.OnOutlive?.Invoke(receiving.Transfer);
            }

            options.OnRemove?.Invoke(receiving);
        }

        return entry;
    }

    // a resolver that outlived its call settled: what its call received gives its place back with it
    private void Settled(AnsweringCall call)
    {
        call.Settle();

        if (call.OutlivingTransfer is { } transfer)
        {
            call.OutlivingTransfer = null;
            options.OnSettle?.Invoke(transfer);
        }
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
