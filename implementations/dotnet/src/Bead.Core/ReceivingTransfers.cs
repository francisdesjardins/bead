using System.Globalization;

namespace Bead;

/// <summary>A transfer this side receives: the call it belongs to, and its bytes as they come.</summary>
internal sealed class Receiving(CallAddress call, IncomingTransfer incoming)
{
    /// <summary>The call it belongs to.</summary>
    public CallAddress Call { get; } = call;

    /// <summary>Its bytes as they come.</summary>
    public IncomingTransfer Incoming { get; } = incoming;
}

/// <summary>How the transfers a router receives are held, credited and timed.</summary>
internal sealed record ReceivingTransfersOptions
{
    /// <summary>The limits they hold by: the budget, the transfers at once, the window, the runs, the payload, the inactivity.</summary>
    public required RouterLimits Limits { get; init; }

    /// <summary>The bytes a chunk before the last carries, exactly, and the last at most.</summary>
    public required int PayloadBytesPerChunk { get; init; }

    /// <summary>Sends a credit a transfer is granted, on its call.</summary>
    public required Action<CallAddress, long> SendCredit { get; init; }

    /// <summary>Runs what a timer hears on the scheduler the transfers are touched on.</summary>
    public required Action<Action> Post { get; init; }

    /// <summary>What their timers run on.</summary>
    public required TimeProvider Clock { get; init; }
}

/// <summary>What a transfer's opening tells the transfers received of it, besides its bytes.</summary>
internal sealed record TransferOpening
{
    /// <summary>The call it belongs to.</summary>
    public required CallAddress Call { get; init; }

    /// <summary>The whole payload's length, as the opening declares it.</summary>
    public required long Total { get; init; }

    /// <summary>
    /// The bytes of its payload its sender places in its opening, which it carries exactly; none, for
    /// an opening held to no count.
    /// </summary>
    public int? OpeningBytes { get; init; }

    /// <summary>What hears it stall once admitted; none, for a transfer no timer of its own governs.</summary>
    public Action? OnStall { get; init; }

    /// <summary>What hears it refused, once it waited for the budget past its bound.</summary>
    public Action<Failure>? OnRefused { get; init; }

    /// <summary>What hears it admitted to the budget once it waited, before its first credit goes.</summary>
    public Action? OnAdmitted { get; init; }
}

/// <summary>
/// The transfers a router receives, on every connection. Each is admitted to one budget by its whole
/// total, which it reserves until its payload is whole or it ends, so no credit waits on the budget.
/// An opening the budget left cannot hold, or one behind another that waits, on any connection,
/// waits in its turn, the openings opened first admitted first: it holds its place and its opening's
/// bytes, none of the budget, and is granted nothing; one still waiting at half the inactivity
/// allowed is refused <c>CAPACITY_EXCEEDED</c> (spec 12.4). Each connection receives
/// <see cref="RouterLimits.MaximumTransfers"/> at once, and twice as many with those whose call's
/// resolver outlives the call, each counted from its call's end until that resolver settles (spec
/// 12.3). Touched on its router's scheduler alone.
/// </summary>
internal sealed class ReceivingTransfers(ReceivingTransfersOptions options)
{
    // the transfers open, in the order they opened, and what each holds
    private readonly OrderedDictionary<Receiving, Held> _held = [];

    // the transfers each connection receives at once
    private readonly Dictionary<string, Counted> _connections = [];
    private readonly RouterLimits _limits = options.Limits;

    // by connection, the transfers whose call's resolver outlives the call, until it settles or its
    // connection closes
    private readonly Dictionary<string, HashSet<Receiving>> _outliving = [];

    // the bytes of the budget the transfers admitted reserve, and the bytes received and held
    private long _reserved;
    private long _buffered;

    // the openings that wait for the budget
    private int _waiting;

    /// <summary>The bytes of the budget no transfer reserves.</summary>
    public long Available
    {
        get
        {
            return _limits.BufferedBytesBudget - _reserved;
        }
    }

    /// <summary>
    /// How long an opening waits for the budget: half the inactivity allowed, in whole milliseconds
    /// rounded down (spec 12.4).
    /// </summary>
    public static TimeSpan BudgetWaitOf(RouterLimits limits)
    {
        ArgumentNullException.ThrowIfNull(limits);

        return TimeSpan.FromMilliseconds((long)limits.TransferInactivityTimeout.TotalMilliseconds / 2);
    }

    /// <summary>
    /// Ends a transfer, admitted or waiting: its bytes, its budget and its place go back, its timer
    /// stops, and the openings that wait are admitted as the budget left holds them. Ending one that
    /// ended already does nothing.
    /// </summary>
    public void Close(Receiving receiving)
    {
        if (!_held.TryGetValue(receiving, out var state))
        {
            return;
        }

        End(receiving, state);
        AdmitWaiting();
    }

    /// <summary>
    /// Ends every transfer — <paramref name="connectionHandle"/>'s alone, when given — waiting or
    /// admitted, before the openings that wait are admitted, so no opening about to end with them is.
    /// </summary>
    public void CloseAll(string? connectionHandle = null)
    {
        foreach (var (receiving, state) in _held.ToList())
        {
            if (connectionHandle is null || receiving.Call.ConnectionHandle == connectionHandle)
            {
                End(receiving, state);
            }
        }

        // * the places its resolvers outlive end with its connection
        if (connectionHandle is null)
        {
            _outliving.Clear();
        }
        else
        {
            _outliving.Remove(connectionHandle);
        }

        AdmitWaiting();
    }

    /// <summary>
    /// The payload of a transfer placed whole: its bytes and its total leave the budget as they leave
    /// the router, its timer stops, and the openings that wait are admitted as the budget left holds
    /// them. Its place on its connection stays until it is closed.
    /// </summary>
    public ReadOnlyMemory<byte> Complete(Receiving receiving)
    {
        var payload = receiving.Incoming.Payload();

        if (_held.TryGetValue(receiving, out var state))
        {
            state.IsComplete = true;
            Stop(state);
            Drain(state);
            AdmitWaiting();
        }

        return payload;
    }

    /// <summary>
    /// What it holds: the transfers received, and the openings among them that wait; the bytes of the
    /// budget they reserve, under its ceiling; the bytes they hold, the openings' and each chunk's
    /// placed, with no ceiling; those whose call's resolver outlives the call; and their connections.
    /// </summary>
    public Gauges Gauges()
    {
        return Bead.Gauges.Of(
            new Dictionary<string, long>
            {
                ["bufferedBytes"] = _buffered,
                ["outlivingTransfers"] = _outliving.Values.Sum((outliving) =>
                {
                    return (long)outliving.Count;
                }),
                ["receivingTransfers"] = _held.Count,
                ["reservedBytes"] = _reserved,
                ["waitingTransfers"] = _waiting,
            },
            _connections.Keys.Concat(_outliving.Keys)) with
        {
            Ceilings = new Dictionary<string, long> { ["reservedBytes"] = _limits.BufferedBytesBudget },
        };
    }

    /// <summary>Grants the credit an admitted transfer may, and sends it; one that waits is granted nothing.</summary>
    public void Grant(Receiving receiving)
    {
        if (!_held.TryGetValue(receiving, out var state) || state.IsComplete || !state.IsAdmitted)
        {
            return;
        }

        if (receiving.Incoming.CreditToGrant() is not { } creditEnd)
        {
            return;
        }

        options.SendCredit(receiving.Call, creditEnd);
    }

    /// <summary>Whether a transfer waits for the budget, admitted to none of it yet.</summary>
    public bool IsWaiting(Receiving receiving)
    {
        return _held.TryGetValue(receiving, out var state) && !state.IsAdmitted;
    }

    /// <summary>
    /// Opens a transfer on its call from its opening, or gives the failure that refuses it, in this
    /// order: <c>PAYLOAD_TOO_LARGE</c> when this side takes no transfer, for a total of 0 or past the
    /// payload's limit; <c>CAPACITY_EXCEEDED</c> when the connection holds twice its transfers with
    /// those its resolvers outlive, or its transfers already; <c>CHUNK_INVALID</c> for an opening that
    /// carries no byte of its payload, holds its whole total, or carries other than its
    /// <c>OpeningBytes</c>, when given. Then the budget: admitted when no
    /// opening waits and the budget left holds its total, or waiting, its <c>OnRefused</c> told past
    /// half the inactivity allowed and its <c>OnAdmitted</c> once admitted — or refused
    /// <c>CAPACITY_EXCEEDED</c> at once, when that half is 0. Given <c>OnStall</c>, a timer hears the
    /// transfer admitted stall when nothing comes for the inactivity allowed.
    /// </summary>
    public (Receiving? Receiving, Failure? Refusal) Open(ReadOnlyMemory<byte> opening, TransferOpening opened)
    {
        ArgumentNullException.ThrowIfNull(opened);

        var connectionHandle = opened.Call.ConnectionHandle;
        var connection = _connections.GetValueOrDefault(connectionHandle) ?? new Counted();

        if (_limits.MaximumTransfers == 0)
        {
            return Refused(ProtocolCode.PayloadTooLarge, "this peer takes no transfer");
        }

        if (opened.Total == 0)
        {
            return Refused(ProtocolCode.PayloadTooLarge, "a transfer declares its total, not 0");
        }

        if (opened.Total > _limits.MaximumPayloadBytes)
        {
            return Refused(ProtocolCode.PayloadTooLarge, $"a payload is {_limits.MaximumPayloadBytes} bytes at most, not {opened.Total}");
        }

        // * the second ceiling first: the transfers received and those whose call's resolver outlives
        // the call (spec 12.3)
        if (connection.Transfers + OutlivingOn(connectionHandle) >= 2L * _limits.MaximumTransfers)
        {
            return Refused(
                ProtocolCode.CapacityExceeded,
                $"the transfers a connection receives and those its resolvers outlive are {2L * _limits.MaximumTransfers} at most");
        }

        if (connection.Transfers >= _limits.MaximumTransfers)
        {
            return Refused(
                ProtocolCode.CapacityExceeded,
                $"the transfers a connection receives at once are {_limits.MaximumTransfers} at most");
        }

        var (incoming, refusal) = IncomingTransfer.Open(opening, (_limits, options.PayloadBytesPerChunk, opened.Total));

        if (incoming is null)
        {
            return (null, refusal);
        }

        // ! an opening carries exactly what its sender places in it, so what it holds outside the
        // budget is bounded as a chunk is (spec 12.3)
        if (opened.OpeningBytes is { } openingBytes && opening.Length != openingBytes)
        {
            return Refused(ProtocolCode.ChunkInvalid, $"an opening carries {openingBytes} bytes of its payload, not {opening.Length}");
        }

        // * admitted at once only when no opening waits, on any connection, and the budget left holds
        // its whole total; one that would wait no time at all is refused at once (spec 12.4)
        var isAdmitted = _waiting == 0 && opened.Total <= Available;

        if (!isAdmitted && BudgetWaitOf(_limits) <= TimeSpan.Zero)
        {
            return (null, WaitedOf(opened.Total));
        }

        var receiving = new Receiving(opened.Call, incoming);
        var state = new Held(connection, opened) { Received = opening.Length };

        _held.Add(receiving, state);
        connection.Transfers += 1;
        _connections[connectionHandle] = connection;
        _buffered += opening.Length;

        if (isAdmitted)
        {
            Admit(state);
        }
        else
        {
            _waiting += 1;
            AwaitBudget(receiving, state);
        }

        return (receiving, null);
    }

    /// <summary>
    /// Places a chunk; what places bytes is progress, and sets the timer going again, unless it makes
    /// the payload whole, which stops it.
    /// </summary>
    public (ChunkOutcome Outcome, Failure? Refusal) Place(Receiving receiving, Chunk chunk)
    {
        var placed = receiving.Incoming.Place(chunk.Bytes, (chunk.IsLast, chunk.Offset));

        if (!_held.TryGetValue(receiving, out var state))
        {
            return placed;
        }

        if (placed.Outcome is ChunkOutcome.Placed or ChunkOutcome.Complete)
        {
            state.Received += chunk.Bytes.Length;
            _buffered += chunk.Bytes.Length;
        }

        // * the chunk that makes the payload whole leaves nothing to wait for (spec 12.6, 12.7)
        if (placed.Outcome is ChunkOutcome.Complete)
        {
            Stop(state);
        }
        else if (placed.Outcome is ChunkOutcome.Placed)
        {
            Touch(state);
        }

        return placed;
    }

    /// <summary>
    /// A transfer whose call ended while its resolver runs outlives the call: it keeps its place on
    /// its connection until <see cref="Settle"/>, or until that connection closes. Told before the
    /// transfer is closed; one no longer held, gone with its connection, keeps none.
    /// </summary>
    public void Outlive(Receiving receiving)
    {
        ArgumentNullException.ThrowIfNull(receiving);

        if (!_held.ContainsKey(receiving))
        {
            return;
        }

        var connectionHandle = receiving.Call.ConnectionHandle;

        if (!_outliving.TryGetValue(connectionHandle, out var outliving))
        {
            outliving = [];
            _outliving[connectionHandle] = outliving;
        }

        outliving.Add(receiving);
    }

    /// <summary>
    /// The resolver a transfer outlived its call with settled: it gives its place back. Settling one
    /// that outlives nothing, or whose connection closed, does nothing.
    /// </summary>
    public void Settle(Receiving receiving)
    {
        ArgumentNullException.ThrowIfNull(receiving);

        var connectionHandle = receiving.Call.ConnectionHandle;

        if (_outliving.TryGetValue(connectionHandle, out var outliving) && outliving.Remove(receiving))
        {
            if (outliving.Count == 0)
            {
                _outliving.Remove(connectionHandle);
            }
        }
    }

    private static (Receiving? Receiving, Failure? Refusal) Refused(ProtocolCode code, string detail)
    {
        return (null, Failure.OfProtocol(code, detail));
    }

    // the transfers a connection's resolvers outlive their call with
    private int OutlivingOn(string connectionHandle)
    {
        return _outliving.TryGetValue(connectionHandle, out var outliving) ? outliving.Count : 0;
    }

    // stops a transfer's timer: one that fired already, on its way to the scheduler, hears nothing
    private static void Stop(Held state)
    {
        state.Generation += 1;
        state.Timer?.Dispose();
        state.Timer = null;
    }

    // the failure of an opening that waited for the budget past its bound
    private Failure WaitedOf(long total)
    {
        return Failure.OfProtocol(
            ProtocolCode.CapacityExceeded,
            string.Create(CultureInfo.InvariantCulture, $"a total of {total} bytes waited {(long)BudgetWaitOf(_limits).TotalMilliseconds} milliseconds for the budget"));
    }

    // sets a transfer's timer going again, when one governs it
    private void Touch(Held state)
    {
        Stop(state);

        if (state.Opened.OnStall is not { } onStall)
        {
            return;
        }

        var generation = state.Generation;

        state.Timer = options.Clock.CreateTimer(
            (_) =>
            {
                options.Post(() =>
                {
                    if (state.Generation == generation)
                    {
                        onStall();
                    }
                });
            },
            null,
            _limits.TransferInactivityTimeout,
            Timeout.InfiniteTimeSpan);
    }

    // sets a waiting opening's timer going: still waiting at its bound, it is refused, and the
    // openings behind it are admitted as the budget left holds them
    private void AwaitBudget(Receiving receiving, Held state)
    {
        var generation = state.Generation;

        state.Timer = options.Clock.CreateTimer(
            (_) =>
            {
                options.Post(() =>
                {
                    if (state.Generation != generation)
                    {
                        return;
                    }

                    // ! ended before it hears its refusal, and walked after: its refusal goes out
                    // before any credit the walk sends, and the close that refusal brings about
                    // finds nothing left to end
                    End(receiving, state);
                    state.Opened.OnRefused?.Invoke(WaitedOf(state.Opened.Total));
                    AdmitWaiting();
                });
            },
            null,
            BudgetWaitOf(_limits),
            Timeout.InfiniteTimeSpan);
    }

    // admits a transfer by its total, which it reserves until its payload is whole or it ends: its
    // wait stops, and its inactivity goes
    private void Admit(Held state)
    {
        state.IsAdmitted = true;
        state.Reserved = state.Opened.Total;
        _reserved += state.Reserved;
        Touch(state);
    }

    // gives back a transfer's bytes, and what it reserved of the budget
    private void Drain(Held state)
    {
        _reserved -= state.Reserved;
        state.Reserved = 0;
        _buffered -= state.Received;
        state.Received = 0;
    }

    // * the budget given back admits the openings that wait, in the order they opened, each as the
    // budget left holds its total: its wait stopped, its inactivity set going, its owner told, then
    // its first credit sent; the walk stops at the first it does not hold, so no opening passes one
    // before it (spec 12.4)
    private void AdmitWaiting()
    {
        foreach (var (receiving, state) in _held.ToList())
        {
            // what an admission before it told may have ended it, or admitted it in a walk of its own
            if (state.IsAdmitted || !_held.ContainsKey(receiving))
            {
                continue;
            }

            if (state.Opened.Total > Available)
            {
                return;
            }

            _waiting -= 1;
            Admit(state);
            state.Opened.OnAdmitted?.Invoke();
            Grant(receiving);
        }
    }

    // ends a transfer, and gives back what it holds: its bytes, its budget, its place, its timer
    private void End(Receiving receiving, Held state)
    {
        _held.Remove(receiving);
        Stop(state);
        Drain(state);

        if (!state.IsAdmitted)
        {
            _waiting -= 1;
        }

        state.Connection.Transfers -= 1;

        if (state.Connection.Transfers == 0)
        {
            _connections.Remove(receiving.Call.ConnectionHandle);
        }
    }

    // the transfers a connection receives at once, shared by each of them
    private sealed class Counted
    {
        public int Transfers { get; set; }
    }

    // what a receiving transfer holds, besides its bytes
    private sealed class Held(Counted connection, TransferOpening opened)
    {
        // the transfers its connection receives at once, itself among them
        public Counted Connection { get; } = connection;

        // what its opening told: its call, its total, and what hears it stall, refused or admitted
        public TransferOpening Opened { get; } = opened;

        // whether the budget admitted it: until then it waits, and is granted nothing
        public bool IsAdmitted { get; set; }

        // whether its payload went on, whole: it holds no byte of the budget any more
        public bool IsComplete { get; set; }

        // the bytes of the budget it reserves: its total, from its admission
        public long Reserved { get; set; }

        // the bytes of its payload it holds: its opening's, then each chunk's placed
        public long Received { get; set; }

        // its wait for the budget, then its inactivity once admitted
        public ITimer? Timer { get; set; }

        // which arming of its timer stands: one stopped since hears nothing
        public int Generation { get; set; }
    }
}
