namespace Bead.Transport.WebSockets;

/// <summary>
/// What a WebSocket server holds of its messages partway, across its connections, under
/// <c>messageBytesBudget</c> (spec 15.12, decision 0056): each holder's charge as its bytes come,
/// released once its message is whole or its connection fails. A charge that would pass the budget
/// casts off holders, as few as fit it: those past their grace first, then the one that holds the
/// most, then the one whose message began first, the asking one's charge counted in its own sum. A
/// holder cast off charges nothing more, and hears it outside the budget's lock.
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
            each.Hooks.CastOff();
        }

        return isTaken;
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

    // * the charge taken, or whom it casts off (spec 15.12): as few as fit it, in the order those past
    // their grace, then the most, then the first begun; the asking one alone when it comes first,
    // or when nothing but its own cast-off fits it; under the lock
    private bool Take((Holder Holder, long Bytes) charge, List<Holder> gone)
    {
        var (holder, bytes) = charge;

        if (holder.IsGone)
        {
            return false;
        }

        if (!holder.IsHolding)
        {
            _began += 1;
            holder.Began = _began;
            holder.IsHolding = true;
            _holding.Add(holder);
        }

        var total = _charged + bytes;

        if (total <= Budget)
        {
            holder.Sum += bytes;
            _charged = total;

            return true;
        }

        // ! a charge its own holder could not hold with every other gone casts it off alone, which
        // always fits: what was held before it was within the budget
        if (holder.Sum + bytes > Budget)
        {
            CastOff(holder);

            return false;
        }

        var order = _holding.Select((each) =>
        {
            return (Holder: each, IsPastGrace: each.Hooks.IsPastGrace(), Sum: each == holder ? each.Sum + bytes : each.Sum);
        }).OrderByDescending((each) =>
        {
            return each.IsPastGrace;
        }).ThenByDescending((each) =>
        {
            return each.Sum;
        }).ThenBy((each) =>
        {
            return each.Holder.Began;
        }).ToList();

        if (order[0].Holder == holder)
        {
            CastOff(holder);

            return false;
        }

        foreach (var (each, _, _) in order)
        {
            if (total <= Budget)
            {
                break;
            }

            if (each == holder)
            {
                continue;
            }

            total -= each.Sum;
            CastOff(each);
            gone.Add(each);
        }

        holder.Sum += bytes;
        _charged += bytes;

        return true;
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
    /// One connection's share of a budget: what tells whether its message is past its grace, what it
    /// hears once it is cast off, and, under the budget's lock, its sum, the rank its message began
    /// at, and whether it was cast off.
    /// </summary>
    internal sealed class Holder
    {
        internal Holder((Func<bool> IsPastGrace, Action CastOff) hooks)
        {
            Hooks = hooks;
        }

        internal (Func<bool> IsPastGrace, Action CastOff) Hooks { get; }

        internal long Sum { get; set; }

        internal long Began { get; set; }

        internal bool IsHolding { get; set; }

        internal bool IsGone { get; set; }
    }
}
