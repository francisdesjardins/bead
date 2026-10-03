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

    /// <summary>The bytes a chunk before the last carries at least.</summary>
    public required int PayloadBytesPerChunk { get; init; }

    /// <summary>Sends a credit a transfer is granted, on its call.</summary>
    public required Action<CallAddress, long> SendCredit { get; init; }

    /// <summary>Runs what a timer hears on the scheduler the transfers are touched on.</summary>
    public required Action<Action> Post { get; init; }

    /// <summary>What their timers run on.</summary>
    public required TimeProvider Clock { get; init; }
}

/// <summary>
/// The transfers a router receives, on every connection. Their bytes share one budget, reserved as
/// each credit grants them — the opening's first — so an opening holds only what its peer sends, and
/// a transfer the budget cannot credit waits until another gives some back. Each connection receives
/// <see cref="RouterLimits.MaximumTransfers"/> at once. Touched on its router's scheduler alone.
/// </summary>
internal sealed class ReceivingTransfers(ReceivingTransfersOptions options)
{
    // the transfers open, in the order they opened, and what each holds
    private readonly OrderedDictionary<Receiving, Held> _held = [];

    // the transfers each connection receives at once
    private readonly Dictionary<string, Counted> _connections = [];
    private readonly RouterLimits _limits = options.Limits;
    private long _buffered;

    /// <summary>The bytes of the budget no transfer holds.</summary>
    public long Available
    {
        get
        {
            return _limits.BufferedBytesBudget - _buffered;
        }
    }

    /// <summary>
    /// Ends a transfer: its bytes and its place go back, its timer stops, and the transfers the
    /// budget starved of credit are granted theirs. Ending one that ended already does nothing.
    /// </summary>
    public void Close(Receiving receiving)
    {
        if (!_held.TryGetValue(receiving, out var state))
        {
            return;
        }

        End(receiving, state);
        GrantStarved();
    }

    /// <summary>
    /// Ends every transfer — <paramref name="connectionHandle"/>'s alone, when given — before the
    /// transfers the budget starved are granted theirs, so no credit goes to a transfer about to end
    /// with them.
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

        GrantStarved();
    }

    /// <summary>
    /// The payload of a transfer placed whole: its bytes leave the budget as they leave the router,
    /// and its timer stops. Its place on its connection stays until it is closed.
    /// </summary>
    public ReadOnlyMemory<byte> Complete(Receiving receiving)
    {
        var payload = receiving.Incoming.Payload();

        if (_held.TryGetValue(receiving, out var state))
        {
            state.IsComplete = true;
            Stop(state);
            Drain(state);
            GrantStarved();
        }

        return payload;
    }

    /// <summary>What it holds: the transfers received, the bytes of the budget they hold under its ceiling, and their connections.</summary>
    public Gauges Gauges()
    {
        return Bead.Gauges.Of(
            new Dictionary<string, long> { ["bufferedBytes"] = _buffered, ["receivingTransfers"] = _held.Count },
            _connections.Keys) with
        {
            Ceilings = new Dictionary<string, long> { ["bufferedBytes"] = _limits.BufferedBytesBudget },
        };
    }

    /// <summary>Grants the credit a transfer may, within the budget left, and sends it.</summary>
    public void Grant(Receiving receiving)
    {
        if (!_held.TryGetValue(receiving, out var state) || state.IsComplete)
        {
            return;
        }

        var previous = receiving.Incoming.CreditEnd;

        if (receiving.Incoming.CreditToGrant(Available) is not { } creditEnd)
        {
            return;
        }

        _buffered += creditEnd - previous;
        state.Reserved += creditEnd - previous;
        options.SendCredit(receiving.Call, creditEnd);
    }

    /// <summary>
    /// Opens a transfer on its call from its opening, or gives the failure that refuses it:
    /// <c>PAYLOAD_TOO_LARGE</c> when this side takes no transfer, for a total of 0 or past the
    /// payload's limit; <c>CAPACITY_EXCEEDED</c> when the connection holds its transfers already, or
    /// the budget cannot hold the opening; <c>CHUNK_INVALID</c> for an opening that holds its whole
    /// total. Given <c>OnStall</c>, a timer hears the transfer stall when nothing comes for the
    /// inactivity allowed.
    /// </summary>
    public (Receiving? Receiving, Failure? Refusal) Open(
        ReadOnlyMemory<byte> opening,
        (CallAddress Call, Action? OnStall, long Total) opened)
    {
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

        if (connection.Transfers >= _limits.MaximumTransfers)
        {
            return Refused(
                ProtocolCode.CapacityExceeded,
                $"the transfers a connection receives at once are {_limits.MaximumTransfers} at most");
        }

        if (opening.Length > Available)
        {
            return Refused(ProtocolCode.CapacityExceeded, $"the transfers received hold the budget but {Available} bytes");
        }

        var (incoming, refusal) = IncomingTransfer.Open(opening, (_limits, options.PayloadBytesPerChunk, opened.Total));

        if (incoming is null)
        {
            return (null, refusal);
        }

        var receiving = new Receiving(opened.Call, incoming);
        var state = new Held(connection, opened.OnStall) { Reserved = opening.Length };

        _held.Add(receiving, state);
        connection.Transfers += 1;
        _connections[connectionHandle] = connection;
        _buffered += opening.Length;
        Touch(state);

        return (receiving, null);
    }

    /// <summary>Places a chunk; what places bytes is progress, and sets the timer going again.</summary>
    public (ChunkOutcome Outcome, Failure? Refusal) Place(Receiving receiving, Chunk chunk)
    {
        var placed = receiving.Incoming.Place(chunk.Bytes, (chunk.IsLast, chunk.Offset));

        if (_held.TryGetValue(receiving, out var state) && placed.Outcome is ChunkOutcome.Placed or ChunkOutcome.Complete)
        {
            Touch(state);
        }

        return placed;
    }

    private static (Receiving? Receiving, Failure? Refusal) Refused(ProtocolCode code, string detail)
    {
        return (null, Failure.OfProtocol(code, detail));
    }

    // stops a transfer's timer: one that fired already, on its way to the scheduler, hears nothing
    private static void Stop(Held state)
    {
        state.Generation += 1;
        state.Timer?.Dispose();
        state.Timer = null;
    }

    // sets a transfer's timer going again, when one governs it
    private void Touch(Held state)
    {
        Stop(state);

        if (state.OnStall is not { } onStall)
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

    // gives a transfer's bytes back to the budget
    private void Drain(Held state)
    {
        _buffered -= state.Reserved;
        state.Reserved = 0;
    }

    // what the budget gave back goes to the transfers it starved, in the order they opened
    private void GrantStarved()
    {
        foreach (var receiving in _held.Keys.ToList())
        {
            Grant(receiving);
        }
    }

    // ends a transfer, and gives back what it holds: its bytes, its place, its timer
    private void End(Receiving receiving, Held state)
    {
        _held.Remove(receiving);
        Stop(state);
        Drain(state);
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
    private sealed class Held(Counted connection, Action? onStall)
    {
        // the transfers its connection receives at once, itself among them
        public Counted Connection { get; } = connection;

        // what hears that it stalled; none, for a transfer no timer governs
        public Action? OnStall { get; } = onStall;

        // whether its payload went on, whole: it holds no byte of the budget any more
        public bool IsComplete { get; set; }

        // the bytes of the budget it holds: its opening's, then each credit's
        public long Reserved { get; set; }

        public ITimer? Timer { get; set; }

        // which arming of its timer stands: one stopped since hears nothing
        public int Generation { get; set; }
    }
}
