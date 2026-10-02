namespace Bead;

/// <summary>A transfer this side sends: the call it belongs to, and its payload as the credit lets it go.</summary>
internal sealed class Sending(CallAddress call, OutgoingTransfer outgoing)
{
    /// <summary>The call it belongs to.</summary>
    public CallAddress Call { get; } = call;

    /// <summary>Its payload as the credit lets it go.</summary>
    public OutgoingTransfer Outgoing { get; } = outgoing;
}

/// <summary>
/// The transfers a router sends. The opening is the sender's own to send; this keeps each transfer
/// from then on, by its connection and its call id — this side's for a request, the peer's for a
/// result — and sends its chunks as the credit comes, until its sender closes it. They hold no
/// budget: the payload is the caller's. Touched on its router's scheduler alone.
/// </summary>
internal sealed class SendingTransfers
{
    // the transfer each call sends
    private readonly Dictionary<CallAddress, Held> _sent = [];

    /// <summary>
    /// Ends a transfer: nothing more of it goes, and a credit on its call is for none. Ending one
    /// that ended already, or one whose call another transfer took since, does nothing.
    /// </summary>
    public void Close(Sending sending)
    {
        if (!_sent.TryGetValue(sending.Call, out var held) || !ReferenceEquals(held.Sending, sending))
        {
            return;
        }

        held.IsOpen = false;
        _sent.Remove(sending.Call);
    }

    /// <summary>
    /// A credit received on <paramref name="call"/>: it raises the end of the transfer sent there,
    /// its <c>OnCredit</c> hears it when it did, then the chunks it lets go are sent. A credit that
    /// comes while chunks go out only raises the end, which the chunks going out take on; one for no
    /// transfer is dropped in silence.
    /// </summary>
    public void Credit(CallAddress call, long creditEnd)
    {
        if (!_sent.TryGetValue(call, out var held))
        {
            return;
        }

        var outgoing = held.Sending.Outgoing;
        var previous = outgoing.CreditEnd;

        outgoing.Grant(creditEnd);

        // late, repeated, or lower: it grants nothing
        if (outgoing.CreditEnd == previous)
        {
            return;
        }

        held.OnCredit();
        Pump(held);
    }

    /// <summary>What it holds: the transfers sent, and the connections they go to.</summary>
    public Gauges Gauges()
    {
        return Bead.Gauges.Of(
            new Dictionary<string, long> { ["sendingTransfers"] = _sent.Count },
            _sent.Keys.Select((call) =>
            {
                return call.ConnectionHandle;
            }));
    }

    /// <summary>
    /// Keeps a transfer of <paramref name="outgoing"/> on its call before its opening goes, so a
    /// credit that comes back as the opening goes finds it: <c>Send</c> hands each chunk to the
    /// transport, until the transfer is closed — once its last chunk went, or its call ended.
    /// </summary>
    public Sending Open(OutgoingTransfer outgoing, (CallAddress Call, Action OnCredit, Action<Chunk> Send) opened)
    {
        var sending = new Sending(opened.Call, outgoing);

        _sent[opened.Call] = new Held(sending, opened.OnCredit, opened.Send);

        return sending;
    }

    // sends the chunks the credit lets go, one after the other, while the transfer is open
    private static void Pump(Held held)
    {
        if (held.IsSending)
        {
            return;
        }

        held.IsSending = true;

        try
        {
            while (held.IsOpen && held.Sending.Outgoing.NextChunk() is { } chunk)
            {
                held.Send(chunk);
            }
        }
        finally
        {
            held.IsSending = false;
        }
    }

    // a transfer kept, and what it does besides its payload
    private sealed class Held(Sending sending, Action onCredit, Action<Chunk> send)
    {
        public Sending Sending { get; } = sending;

        public Action OnCredit { get; } = onCredit;

        public Action<Chunk> Send { get; } = send;

        // whether its chunks still go: none once it ended
        public bool IsOpen { get; set; } = true;

        // whether its chunks are going out now: a credit that comes meanwhile only raises its end
        public bool IsSending { get; set; }
    }
}
