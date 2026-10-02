namespace Bead;

/// <summary>One chunk to send: its bytes, where they start in the whole payload, and whether they end it.</summary>
internal readonly record struct Chunk(ReadOnlyMemory<byte> Bytes, bool IsLast, long Offset);

/// <summary>
/// What placing a chunk did: placed its bytes, placed none since it had them, completed the payload,
/// or refused the chunk, with the failure that says why.
/// </summary>
internal enum ChunkOutcome
{
    /// <summary>Its bytes placed; the payload is not whole yet.</summary>
    Placed,

    /// <summary>Its bytes received already, whole: nothing placed.</summary>
    Duplicate,

    /// <summary>Its bytes placed, and every byte came.</summary>
    Complete,

    /// <summary>Refused: <c>CHUNK_INVALID</c> or <c>CREDIT_EXCEEDED</c>.</summary>
    Refused,
}

/// <summary>What a transfer's sizes are, by the limits both ends of a connection set alike.</summary>
internal static class Transfer
{
    /// <summary>
    /// The payload bytes an envelope of <paramref name="headerBytes"/> carries, as a chunk or an
    /// opening, under <paramref name="limits"/>.
    /// </summary>
    public static int ChunkPayloadBytes(RouterLimits limits, int headerBytes)
    {
        return Math.Min(limits.ChunkBytes, limits.MaximumEnvelopeBytes) - headerBytes;
    }
}

/// <summary>
/// A payload as its sender sends it: the opening carries its first bytes, without credit; each chunk
/// after carries a full chunk of it, or the last of it, as the receiver's credit allows. Touched on
/// its router's scheduler alone.
/// </summary>
internal sealed class OutgoingTransfer
{
    private readonly ReadOnlyMemory<byte> _payload;
    private readonly int _openingBytes;
    private readonly int _payloadBytesPerChunk;
    private long _creditEnd;
    private long _sent;

    /// <summary>
    /// A transfer of <paramref name="payload"/>, its opening of <c>OpeningBytes</c>, its chunks of
    /// <c>PayloadBytesPerChunk</c>.
    /// </summary>
    public OutgoingTransfer(ReadOnlyMemory<byte> payload, (int OpeningBytes, int PayloadBytesPerChunk) sizes)
    {
        _payload = payload;
        _openingBytes = sizes.OpeningBytes;
        _payloadBytesPerChunk = sizes.PayloadBytesPerChunk;
        _creditEnd = sizes.OpeningBytes;
        _sent = sizes.OpeningBytes;
    }

    /// <summary>The end below which the receiver lets it send, from the highest credit received.</summary>
    public long CreditEnd
    {
        get
        {
            return _creditEnd;
        }
    }

    /// <summary>Whether every byte went out.</summary>
    public bool IsComplete
    {
        get
        {
            return _sent == Total;
        }
    }

    /// <summary>The bytes the opening carries: the payload's first, sent without credit.</summary>
    public ReadOnlyMemory<byte> Opening
    {
        get
        {
            return _payload[.._openingBytes];
        }
    }

    /// <summary>The whole payload's length.</summary>
    public long Total
    {
        get
        {
            return _payload.Length;
        }
    }

    /// <summary>
    /// Raises the end the receiver granted, to <paramref name="creditEnd"/> — the total at most. A
    /// credit lower than one received already, come late or out of order, grants nothing.
    /// </summary>
    public void Grant(long creditEnd)
    {
        _creditEnd = Math.Max(_creditEnd, Math.Min(creditEnd, Total));
    }

    /// <summary>
    /// The next chunk the credit lets go out: a full one, or the last, which reaches the total; none
    /// when neither fits under the credit, so no small chunk ever goes.
    /// </summary>
    public Chunk? NextChunk()
    {
        var end = Math.Min(_sent + _payloadBytesPerChunk, Total);

        // a full chunk, or the last one, and only under the credit
        if (_sent == Total || end > _creditEnd)
        {
            return null;
        }

        var chunk = new Chunk(_payload[(int)_sent..(int)end], end == Total, _sent);

        _sent = end;

        return chunk;
    }
}

/// <summary>
/// A payload as its receiver receives it: its total, the opening's first bytes, each chunk after
/// placed at its offset, in any order, and joined once whole. Credit is granted a window at a time;
/// <see cref="RouterLimits.MaximumChunkRuns"/> bounds the runs of bytes apart it holds. A chunk before
/// the last carries a full chunk at least, as its sender sends them, and a chunk comes whole again or
/// not at all over bytes received: each piece it holds is a chunk's own bytes, never a sliver of
/// them. Touched on its router's scheduler alone.
/// </summary>
internal sealed class IncomingTransfer
{
    // the runs of bytes received, apart and in order, each [start, end)
    private readonly List<(long Start, long End)> _runs = [];

    // the bytes themselves, each received once, where they go, until they are joined
    private readonly List<(ReadOnlyMemory<byte> Bytes, long Offset)> _pieces = [];
    private readonly RouterLimits _limits;
    private readonly int _payloadBytesPerChunk;
    private byte[]? _whole;
    private long _creditEnd;

    private IncomingTransfer(ReadOnlyMemory<byte> opening, (RouterLimits Limits, int PayloadBytesPerChunk, long Total) options)
    {
        _limits = options.Limits;
        _payloadBytesPerChunk = options.PayloadBytesPerChunk;
        Total = options.Total;

        // the opening came without credit: its own bytes are its credit
        _creditEnd = opening.Length;

        if (!opening.IsEmpty)
        {
            Receive(opening, 0);
        }
    }

    /// <summary>The bytes received from the start, one after the other.</summary>
    public long Contiguous
    {
        get
        {
            return _runs.Count > 0 && _runs[0].Start == 0 ? _runs[0].End : 0;
        }
    }

    /// <summary>The end below which it lets its sender send, from the credits it granted.</summary>
    public long CreditEnd
    {
        get
        {
            return _creditEnd;
        }
    }

    /// <summary>The whole payload's length, as the opening declared it.</summary>
    public long Total { get; }

    /// <summary>
    /// A transfer received from <paramref name="opening"/>, or the failure that refuses it: an
    /// opening that holds its whole total opens no transfer, and is <c>CHUNK_INVALID</c>. A total
    /// past what an array holds is an <see cref="ArgumentOutOfRangeException"/>: the limits refuse it
    /// before.
    /// </summary>
    public static (IncomingTransfer? Transfer, Failure? Refusal) Open(
        ReadOnlyMemory<byte> opening,
        (RouterLimits Limits, int PayloadBytesPerChunk, long Total) options)
    {
        ArgumentOutOfRangeException.ThrowIfGreaterThan(options.Total, Array.MaxLength, nameof(options));

        if (opening.Length >= options.Total)
        {
            return (null, Invalid($"an opening of {opening.Length} bytes holds its whole total of {options.Total}"));
        }

        return (new IncomingTransfer(opening, options), null);
    }

    /// <summary>
    /// The end of a credit to grant now, and granted: a window past the bytes received, once its
    /// sender has used half of the last — or the rest, when less is left — and no more than
    /// <paramref name="available"/> bytes past the last end granted. None when there is none to grant.
    /// </summary>
    public long? CreditToGrant(long available)
    {
        var reach = Math.Min(Total, Contiguous + _limits.WindowBytes);
        var next = _creditEnd + Math.Min(reach - _creditEnd, available);

        // a credit waits until half a window can go at once — or the rest of the payload, when less;
        // doubled, so an odd window halves as exactly as it does in JavaScript
        if (2 * (next - _creditEnd) < Math.Min(_limits.WindowBytes, 2 * (Total - _creditEnd)) || next == _creditEnd)
        {
            return null;
        }

        _creditEnd = next;

        return _creditEnd;
    }

    /// <summary>The whole payload, once every byte came: each byte copied once, and its pieces let go.</summary>
    public ReadOnlyMemory<byte> Payload()
    {
        // joined once: the pieces go, and the whole stays what a second ask gets
        if (_whole is null)
        {
            _whole = new byte[Total];

            foreach (var (bytes, offset) in _pieces)
            {
                bytes.CopyTo(_whole.AsMemory((int)offset));
            }

            _pieces.Clear();
        }

        return _whole;
    }

    /// <summary>
    /// Places a chunk's bytes, checked in this order: within the total, not empty, last when it
    /// reaches the total and only then, full when it does not — or <c>CHUNK_INVALID</c>; within the
    /// credit — or <c>CREDIT_EXCEEDED</c>; received already, whole — a duplicate; clear of every byte
    /// received — or <c>CHUNK_INVALID</c>. Too many runs of bytes apart is <c>CHUNK_INVALID</c> too.
    /// </summary>
    public (ChunkOutcome Outcome, Failure? Refusal) Place(ReadOnlyMemory<byte> bytes, (bool IsLast, long Offset) chunk)
    {
        var (isLast, offset) = chunk;

        // bounds written as differences, so no sum runs past what an integer holds
        if (offset >= Total || bytes.Length > Total - offset)
        {
            return Refused(Invalid($"bytes from {offset} run past the total of {Total}"));
        }

        if (bytes.IsEmpty)
        {
            return Refused(Invalid("a chunk carries one byte at least"));
        }

        if (isLast != (bytes.Length == Total - offset))
        {
            return Refused(Invalid(isLast
                ? $"a last chunk from {offset} ends before the total of {Total}"
                : $"a chunk from {offset} reaches the total, yet says more follow"));
        }

        // one before the last is full, as its sender sends them, so no small chunk is held
        if (!isLast && bytes.Length < _payloadBytesPerChunk)
        {
            return Refused(Invalid($"a chunk before the last carries {_payloadBytesPerChunk} bytes at least, not {bytes.Length}"));
        }

        if (bytes.Length > _creditEnd - offset)
        {
            return Refused(Failure.OfProtocol(
                ProtocolCode.CreditExceeded,
                $"bytes from {offset} run past the credit's end of {_creditEnd}"));
        }

        var end = offset + bytes.Length;

        if (_runs.Exists((run) =>
        {
            return run.Start <= offset && end <= run.End;
        }))
        {
            return (ChunkOutcome.Duplicate, null);
        }

        // in part over bytes received, it would hold its whole buffer for a sliver of new bytes
        if (_runs.Exists((run) =>
        {
            return run.Start < end && offset < run.End;
        }))
        {
            return Refused(Invalid($"bytes from {offset} overlap bytes received in part"));
        }

        Receive(bytes, offset);

        if (_runs.Count > _limits.MaximumChunkRuns)
        {
            return Refused(Invalid($"more than {_limits.MaximumChunkRuns} runs of bytes apart"));
        }

        return (Contiguous == Total ? ChunkOutcome.Complete : ChunkOutcome.Placed, null);
    }

    private static Failure Invalid(string detail)
    {
        return Failure.OfProtocol(ProtocolCode.ChunkInvalid, detail);
    }

    private static (ChunkOutcome Outcome, Failure? Refusal) Refused(Failure refusal)
    {
        return (ChunkOutcome.Refused, refusal);
    }

    // bytes clear of every byte received, placed, and the runs joined around them
    private void Receive(ReadOnlyMemory<byte> bytes, long offset)
    {
        _pieces.Add((bytes, offset));
        _runs.Add((offset, offset + bytes.Length));
        _runs.Sort();

        // the runs, in order, those that touch joined into one
        var joined = new List<(long Start, long End)>();

        foreach (var run in _runs)
        {
            if (joined.Count > 0 && run.Start <= joined[^1].End)
            {
                joined[^1] = (joined[^1].Start, Math.Max(joined[^1].End, run.End));
            }
            else
            {
                joined.Add(run);
            }
        }

        _runs.Clear();
        _runs.AddRange(joined);
    }
}
