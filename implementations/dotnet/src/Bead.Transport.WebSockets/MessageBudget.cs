namespace Bead.Transport.WebSockets;

/// <summary>
/// What a WebSocket server holds of its messages partway, across its connections, under
/// <c>messageBytesBudget</c> (spec 15.12, decision 0056): each holder's charge as its bytes come,
/// released once its message is whole or its connection fails. A charge of <c>n</c> decides as
/// <c>n</c> charges of one: each goes to the room left, and when none is left, the order is judged
/// for that unit, the holder whose message holds the most first, the asking one's sum counting that
/// unit, then, among equal sums, the one whose message began first, as Redis casts off its clients
/// past <c>maxmemory-clients</c>. The first is cast off with 1013, its charge released at once; the
/// asking one only when it comes first. A holder cast off charges nothing more, and hears it outside
/// the budget's lock.
/// </summary>
internal sealed class MessageBudget
{
    private readonly Lock _gate = new();
    private readonly List<Holder> _holding = [];
    private long _charged;

    // how many messages began, which ranks each, the clock giving two that begin at once one time
    private long _began;

    /// <summary>A budget of <paramref name="budget"/> bytes.</summary>
    public MessageBudget(long budget)
    {
        Budget = budget;
    }

    /// <summary>The bytes it holds at most, <c>messageBytesBudget</c>.</summary>
    public long Budget { get; }

    /// <summary>What it holds right now, in bytes, the gauge <c>messageBytes</c>.</summary>
    public long Charged
    {
        get
        {
            lock (_gate)
            {
                return _charged;
            }
        }
    }

    /// <summary>
    /// Charges <c>Bytes</c> to <c>Holder</c>'s message: true once taken, casting off what it must;
    /// false when its holder is cast off itself, or was, its charge not taken.
    /// </summary>
    public bool Charge((Holder Holder, long Bytes) charge)
    {
        var (holder, bytes) = charge;
        List<Holder> gone = [];
        bool isTaken;

        lock (_gate)
        {
            isTaken = Take((holder, bytes), gone);
        }

        // ! told outside the lock: a holder cast off fails its connection, which takes locks of its own
        foreach (var each in gone)
        {
            each.CastOff();
        }

        return isTaken;
    }

    /// <summary>
    /// Its message began, at its first frame's first byte: the rank it holds among equal sums, though
    /// it holds nothing until its first charge.
    /// </summary>
    public void Begin(Holder holder)
    {
        lock (_gate)
        {
            _began += 1;
            holder.Began = _began;
        }
    }

    /// <summary>Its message whole: its charge released, and it holds nothing until its next message.</summary>
    public void Release(Holder holder)
    {
        lock (_gate)
        {
            Drop(holder);
        }
    }

    /// <summary>Its connection failed or ended: its charge released, and it charges nothing ever again.</summary>
    public void Leave(Holder holder)
    {
        lock (_gate)
        {
            holder.IsGone = true;
            Drop(holder);
        }
    }

    // * the charge taken unit by unit, or whom it casts off (spec 15.12): what fits the room left
    // is taken; past it, the next unit is judged against the other holders that hold the most, then
    // the first begun, and the first of them is cast off, or the asking one when it comes first;
    // under the lock
    private bool Take((Holder Holder, long Bytes) charge, List<Holder> gone)
    {
        var (holder, bytes) = charge;

        if (holder.IsGone)
        {
            return false;
        }

        if (!holder.IsHolding)
        {
            holder.IsHolding = true;
            _holding.Add(holder);
        }

        // ! the others' order is taken once: their sums stay as they are while this charge decides
        var others = new Queue<Holder>(_holding.Where((each) =>
        {
            return each != holder && each.Sum > 0;
        }).OrderByDescending((each) =>
        {
            return each.Sum;
        }).ThenBy((each) =>
        {
            return each.Began;
        }));
        var left = bytes;

        while (true)
        {
            var taken = Math.Min(Math.Max(Budget - _charged, 0), left);

            holder.Sum += taken;
            _charged += taken;
            left -= taken;

            if (left == 0)
            {
                return true;
            }

            // the next unit, the asking holder's sum counting it, against the first of the others
            if (!others.TryPeek(out var top) || holder.Sum + 1 > top.Sum || (holder.Sum + 1 == top.Sum && holder.Began < top.Began))
            {
                CastOff(holder);

                return false;
            }

            others.Dequeue();
            CastOff(top);
            gone.Add(top);
        }
    }

    // a holder cast off: its charge released, and nothing more taken of it; under the lock
    private void CastOff(Holder holder)
    {
        holder.IsGone = true;
        Drop(holder);
    }

    // a holder's charge released; under the lock
    private void Drop(Holder holder)
    {
        _charged -= holder.Sum;
        holder.Sum = 0;

        if (holder.IsHolding)
        {
            holder.IsHolding = false;
            _holding.Remove(holder);
        }
    }

    /// <summary>
    /// One connection's share of a budget: what it hears once it is cast off, and, under the budget's
    /// lock, its sum, the rank its message began at, and whether it was cast off.
    /// </summary>
    internal sealed class Holder
    {
        internal Holder(Action castOff)
        {
            CastOff = castOff;
        }

        internal Action CastOff { get; }

        internal long Sum { get; set; }

        internal long Began { get; set; }

        internal bool IsHolding { get; set; }

        internal bool IsGone { get; set; }
    }
}
