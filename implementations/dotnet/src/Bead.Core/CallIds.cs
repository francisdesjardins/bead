namespace Bead;

/// <summary>
/// The call ids each side draws: odd from a client, even from a server, as HTTP/2 numbers its
/// streams, so the two never draw the same one.
/// </summary>
public static class CallIds
{
    /// <summary>The first call id <paramref name="side"/> draws.</summary>
    public static uint FirstOf(RouterSide side)
    {
        return side == RouterSide.Client ? 1u : 2u;
    }

    /// <summary>The last call id <paramref name="side"/> draws before its first again.</summary>
    public static uint LastOf(RouterSide side)
    {
        return side == RouterSide.Client ? uint.MaxValue : uint.MaxValue - 1;
    }

    /// <summary>Which side opened the call <paramref name="callId"/> names: none for 0.</summary>
    public static RouterSide? SideOf(uint callId)
    {
        if (callId == 0)
        {
            return null;
        }

        return callId % 2 == 1 ? RouterSide.Client : RouterSide.Server;
    }

    /// <summary>The other end of a connection from <paramref name="side"/>.</summary>
    public static RouterSide PeerOf(RouterSide side)
    {
        return side == RouterSide.Client ? RouterSide.Server : RouterSide.Client;
    }
}

/// <summary>
/// A drawer of call ids from a side's first to its last, two apart, then from its first again:
/// each draw starts where the last one stopped and skips the ids in use, walking the range once at
/// most; none when every one is taken.
/// </summary>
internal sealed class CallIdSequence
{
    private readonly uint _first;
    private readonly uint _last;
    private readonly long _count;
    private uint _next;

    /// <summary>A sequence of <paramref name="side"/>'s call ids, up to <paramref name="last"/>.</summary>
    public CallIdSequence(RouterSide side, uint? last)
    {
        _first = CallIds.FirstOf(side);
        _last = last ?? CallIds.LastOf(side);

        if (_last < _first || (_last - _first) % 2 != 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(last),
                $"a {side} draws its call ids from {_first} to a last of its parity, not {_last}");
        }

        _count = ((long)_last - _first) / 2 + 1;
        _next = _first;
    }

    /// <summary>The next call id <paramref name="isInUse"/> does not hold; none once every one is.</summary>
    public uint? Draw(Func<uint, bool> isInUse)
    {
        for (long tries = 0; tries < _count; tries += 1)
        {
            var callId = _next;

            _next = callId == _last ? _first : callId + 2;

            if (!isInUse(callId))
            {
                return callId;
            }
        }

        return null;
    }
}
