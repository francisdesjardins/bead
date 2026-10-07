namespace Bead.Tests;

/// <summary>
/// <see cref="Transfer"/>, <see cref="OutgoingTransfer"/> and <see cref="IncomingTransfer"/>: a
/// payload's sizes, how its sender lets it go, and how its receiver puts it together.
/// </summary>
public sealed class TransferTests
{
    // constants

    // as much as a credit could take: the budget, unbounded
    private const long Unbounded = long.MaxValue;

    // a chunk's header, as long as any: the prefix and its offset
    private static readonly int ChunkHeaderBytes = EnvelopeCodec.HeaderBytesOf(new ChunkHeader { CallId = 1, IsLast = true, Offset = 0 });

    // helpers

    // the hexadecimal of bytes, spaced by byte
    private static string HexadecimalOf(ReadOnlySpan<byte> bytes)
    {
        return string.Join(' ', bytes.ToArray().Select((value) =>
        {
            return value.ToString("X2", System.Globalization.CultureInfo.InvariantCulture);
        }));
    }

    // bytes that differ from one to the next, so a byte out of place shows
    private static byte[] PatternOf(int length)
    {
        return [.. Enumerable.Range(0, length).Select((index) =>
        {
            return (byte)(((index * 7) + (index >> 8)) % 251);
        })];
    }

    // a transfer received, failing the test when it does not open; its chunks before the last carry
    // a byte, exactly, unless the options say more
    private static IncomingTransfer IncomingOf(
        ReadOnlyMemory<byte> opening,
        (long Total, int PayloadBytesPerChunk, int WindowBytes, int MaximumChunkRuns) options)
    {
        var limits = new RouterLimits { MaximumChunkRuns = options.MaximumChunkRuns, WindowBytes = options.WindowBytes };
        var (transfer, refusal) = IncomingTransfer.Open(opening, (limits, options.PayloadBytesPerChunk, options.Total));

        Assert.Null(refusal);

        return transfer!;
    }

    private static IncomingTransfer IncomingOf(ReadOnlyMemory<byte> opening, long total)
    {
        return IncomingOf(opening, (total, 1, 8, 1_024));
    }

    // the code of the failure a placement gave, or its outcome
    private static object CodeOf((ChunkOutcome Outcome, Failure? Refusal) placed)
    {
        return placed.Refusal is { } refusal ? (ProtocolCode)refusal.Code : placed.Outcome;
    }

    // definition

    [Fact]
    public void Sizes_a_chunk_as_what_an_envelope_of_the_chunk_size_holds_past_its_header_an_envelope_at_most()
    {
        var limits = new RouterLimits { ChunkBytes = 1_048_576, MaximumEnvelopeBytes = 16_778_240 };

        Assert.Equal(16, ChunkHeaderBytes);
        Assert.Equal(1_048_560, Transfer.ChunkPayloadBytes(limits, ChunkHeaderBytes));
        Assert.Equal(1_008, Transfer.ChunkPayloadBytes(limits with { ChunkBytes = 1_024 }, ChunkHeaderBytes));

        // an opening: a request, without and with a destination, and a result announcing a session
        IEnvelopeHeader[] openingHeaders =
        [
            new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Total = 0 },
            new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, DestinationId = 1, Total = 0 },
            new ResultHeader { CallId = 2, Total = 0, Credential = SessionToken.Parse("AAECAwQFBgcICQoLDA0ODw") },
        ];
        var openings = openingHeaders.Select((header) =>
        {
            return EnvelopeCodec.HeaderBytesOf(header);
        }).ToArray();

        Assert.Equal([20, 24, 36], openings);
        Assert.Equal(
            [1_048_556, 1_048_552, 1_048_540],
            openings.Select((bytes) =>
            {
                return Transfer.ChunkPayloadBytes(limits, bytes);
            }));
        Assert.Equal(1_008, Transfer.ChunkPayloadBytes(new RouterLimits { ChunkBytes = 4_096, MaximumEnvelopeBytes = 1_024 }, 16));
    }

    [Fact]
    public void Lays_the_spec_s_20_MiB_out_byte_by_byte_its_opening_a_credit_a_chunk_with_more_the_last()
    {
        const int total = 20_971_520;

        var limits = RouterLimits.Default;
        var payload = PatternOf(total);
        var openingHeader = new RequestHeader { CallId = 7, ServiceId = 2, ProcedureId = 5, Total = total };
        var outgoing = new OutgoingTransfer(
            payload,
            (Transfer.ChunkPayloadBytes(limits, EnvelopeCodec.HeaderBytesOf(openingHeader)), Transfer.ChunkPayloadBytes(limits, ChunkHeaderBytes)));
        var incoming = IncomingOf(outgoing.Opening, (total, 1, limits.WindowBytes, 1_024));
        var opening = EnvelopeCodec.WriteEnvelope(new Envelope { Header = openingHeader, Payload = outgoing.Opening });

        Assert.Equal(1_048_576, opening.Length);
        Assert.Equal("A1 10 04 05 00 00 00 07 00 02 00 05 00 00 00 00 01 40 00 00", HexadecimalOf(opening.AsSpan(0, 20)));

        var creditEnd = incoming.CreditToGrant(Unbounded) ?? 0;

        Assert.Equal(5_242_860, creditEnd);
        Assert.Equal(
            "A1 15 00 04 00 00 00 07 00 00 00 00 00 4F FF EC",
            HexadecimalOf(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new CreditHeader { CallId = 7, CreditEnd = creditEnd } })));

        outgoing.Grant(creditEnd);

        var offsets = new List<long>();
        var first = outgoing.NextChunk();

        for (var chunk = first; chunk is { } going; chunk = outgoing.NextChunk())
        {
            offsets.Add(going.Offset);
        }

        // four full chunks under the credit; the fifth would pass it, so it waits
        Assert.Equal([1_048_556, 2_097_116, 3_145_676, 4_194_236], offsets);
        Assert.Equal(
            "A1 14 40 04 00 00 00 07 00 00 00 00 00 0F FF EC",
            HexadecimalOf(EnvelopeCodec.WriteEnvelope(new Envelope
            {
                Header = new ChunkHeader { CallId = 7, IsLast = false, Offset = first!.Value.Offset },
                Payload = first.Value.Bytes,
            }).AsSpan(0, 16)));

        outgoing.Grant(total);

        var last = outgoing.NextChunk();
        var count = 4;

        while (last is { IsLast: false })
        {
            count += 1;
            last = outgoing.NextChunk();
        }

        // 19 full chunks after the opening, then 324 bytes
        Assert.Equal(19, count);
        Assert.Equal(20_971_196, last!.Value.Offset);
        Assert.Equal(324, last.Value.Bytes.Length);
        Assert.Equal(
            "A1 14 00 04 00 00 00 07 00 00 00 00 01 3F FE BC",
            HexadecimalOf(EnvelopeCodec.WriteEnvelope(new Envelope
            {
                Header = new ChunkHeader { CallId = 7, IsLast = true, Offset = 20_971_196 },
                Payload = last.Value.Bytes,
            }).AsSpan(0, 16)));
        Assert.True(outgoing.IsComplete);
        Assert.Null(outgoing.NextChunk());
    }

    [Fact]
    public void Sends_no_small_chunk_a_full_one_or_the_last_and_waits_for_the_credit_either_needs()
    {
        var outgoing = new OutgoingTransfer(PatternOf(25), (4, 6));

        Assert.Equal(PatternOf(25)[..4], outgoing.Opening.ToArray());
        Assert.Equal((4L, 25L, false), (outgoing.CreditEnd, outgoing.Total, outgoing.IsComplete));
        Assert.Null(outgoing.NextChunk());

        // 5 bytes of credit: a full chunk of 6 does not fit
        outgoing.Grant(9);
        Assert.Null(outgoing.NextChunk());
        outgoing.Grant(10);

        var full = outgoing.NextChunk();

        Assert.Equal((false, 4L), (full!.Value.IsLast, full.Value.Offset));
        Assert.Null(outgoing.NextChunk());
        outgoing.Grant(100);

        var sizes = new List<int>();

        for (var chunk = outgoing.NextChunk(); chunk is { } going; chunk = outgoing.NextChunk())
        {
            sizes.Add(going.Bytes.Length);
        }

        // ⌈15 ÷ 6⌉ chunks for what is left, the last one short
        Assert.Equal([6, 6, 3], sizes);
        Assert.True(outgoing.IsComplete);
    }

    [Fact]
    public void Keeps_the_highest_credit_the_total_at_most_a_credit_late_or_repeated_grants_nothing()
    {
        var outgoing = new OutgoingTransfer(PatternOf(20), (2, 4));

        outgoing.Grant(14);
        outgoing.Grant(6);
        Assert.Equal(14, outgoing.CreditEnd);
        outgoing.Grant(14);
        Assert.Equal(14, outgoing.CreditEnd);
        outgoing.Grant(1_000);
        Assert.Equal(20, outgoing.CreditEnd);
    }

    [Fact]
    public void Refuses_an_opening_that_holds_its_whole_total_and_one_without_a_byte_of_its_payload()
    {
        var limits = new RouterLimits { MaximumChunkRuns = 4, WindowBytes = 8 };
        var (whole, wholeRefusal) = IncomingTransfer.Open(PatternOf(4), (limits, 1, 4));
        var (empty, emptyRefusal) = IncomingTransfer.Open(ReadOnlyMemory<byte>.Empty, (limits, 1, 4));
        var one = IncomingOf(PatternOf(1), 4);

        Assert.Null(whole);
        Assert.Null(empty);
        Assert.Equal(
            [((ushort)ProtocolCode.ChunkInvalid, FailureScope.Protocol), ((ushort)ProtocolCode.ChunkInvalid, FailureScope.Protocol)],
            new[] { wholeRefusal!, emptyRefusal! }.Select((refusal) =>
            {
                return (refusal.Code, refusal.Scope);
            }));
        Assert.Equal((1L, 1L, 4L), (one.Contiguous, one.CreditEnd, one.Total));
    }

    [Fact]
    public void Checks_a_chunk_in_order_its_bounds_its_bytes_its_last_then_its_credit_then_whether_it_came()
    {
        var incoming = IncomingOf(PatternOf(2), (10, 2, 8, 1_024));

        // past the total, even without credit, then without a byte, then with a last that lies
        Assert.Equal(ProtocolCode.ChunkInvalid, CodeOf(incoming.Place(PatternOf(3), (true, 10))));
        Assert.Equal(ProtocolCode.ChunkInvalid, CodeOf(incoming.Place(PatternOf(9), (true, 2))));
        Assert.Equal(ProtocolCode.ChunkInvalid, CodeOf(incoming.Place(ReadOnlyMemory<byte>.Empty, (false, 5))));
        Assert.Equal(ProtocolCode.ChunkInvalid, CodeOf(incoming.Place(PatternOf(3), (true, 2))));
        Assert.Equal(ProtocolCode.ChunkInvalid, CodeOf(incoming.Place(PatternOf(8), (false, 2))));

        // within the total, past the credit of the opening's 2 bytes
        Assert.Equal(ProtocolCode.CreditExceeded, CodeOf(incoming.Place(PatternOf(2), (false, 2))));

        // what came already comes as a duplicate
        Assert.Equal(ChunkOutcome.Duplicate, CodeOf(incoming.Place(PatternOf(2), (false, 0))));
    }

    [Fact]
    public void Joins_the_whole_out_of_order_once_and_gives_the_same_whole_when_asked_again()
    {
        var whole = PatternOf(28);
        var incoming = IncomingOf(whole.AsMemory(0, 4), (28, 5, 60, 1_024));

        int[] offsets = [19, 9, 24, 4, 14];

        incoming.CreditToGrant(Unbounded);

        Assert.Equal(
            [ChunkOutcome.Placed, ChunkOutcome.Placed, ChunkOutcome.Placed, ChunkOutcome.Placed, ChunkOutcome.Complete],
            offsets.Select((offset) =>
            {
                return incoming.Place(whole.AsMemory(offset, Math.Min(5, 28 - offset)), (offset + 5 >= 28, offset)).Outcome;
            }));
        Assert.Equal(28, incoming.Contiguous);

        var joined = incoming.Payload();

        Assert.Equal(whole, joined.ToArray());
        Assert.True(incoming.Payload().Equals(joined));
    }

    [Fact]
    public void Refuses_a_chunk_before_the_last_that_is_not_full_and_one_over_bytes_received_in_part()
    {
        var whole = PatternOf(19);
        var incoming = IncomingOf(whole.AsMemory(0, 4), (19, 4, 40, 1_024));

        object Place(int offset, int length)
        {
            return CodeOf(incoming.Place(whole.AsMemory(offset, length), (offset + length == 19, offset)));
        }

        incoming.CreditToGrant(Unbounded);

        Assert.Equal(
            [
                ProtocolCode.ChunkInvalid,
                ChunkOutcome.Placed,
                ProtocolCode.ChunkInvalid,
                ProtocolCode.ChunkInvalid,
                ChunkOutcome.Duplicate,
                ChunkOutcome.Duplicate,
                ChunkOutcome.Placed,
                ChunkOutcome.Placed,
                ChunkOutcome.Complete,
            ],
            new object[]
            {
                // 3 bytes, though more follow
                Place(4, 3),
                Place(8, 4),

                // over the opening, then over the chunk at 8, each in part
                Place(2, 4),
                Place(6, 4),

                // received whole already, the opening's bytes too: a duplicate
                Place(8, 4),
                Place(0, 4),

                // the last carries what is left, however little
                Place(16, 3),
                Place(4, 4),
                Place(12, 4),
            });
        Assert.Equal(whole, incoming.Payload().ToArray());
    }

    [Fact]
    public void Refuses_a_chunk_past_full_before_the_last_or_the_last_CHUNK_INVALID_and_places_a_full_one_and_a_last_one_full_at_most()
    {
        var whole = PatternOf(16);
        var incoming = IncomingOf(whole.AsMemory(0, 4), (16, 4, 40, 1_024));

        Assert.Equal(16, incoming.CreditToGrant(Unbounded));

        // a byte past full, before the last and as the last: no CHUNK's envelope passes chunkBytes
        var (_, before) = incoming.Place(PatternOf(5), (false, 4));
        var (_, last) = incoming.Place(PatternOf(5), (true, 11));

        Assert.Equal(
            [
                (ProtocolCode.ChunkInvalid, "a chunk before the last carries 4 bytes, not 5"),
                (ProtocolCode.ChunkInvalid, "a last chunk carries 4 bytes at most, not 5"),
            ],
            new[] { before!, last! }.Select((refusal) =>
            {
                return ((ProtocolCode)refusal.Code, refusal.Detail);
            }));

        // full, then the last, full at most
        Assert.Equal(ChunkOutcome.Placed, CodeOf(incoming.Place(whole.AsMemory(4, 4), (false, 4))));
        Assert.Equal(ChunkOutcome.Placed, CodeOf(incoming.Place(whole.AsMemory(8, 4), (false, 8))));
        Assert.Equal(ChunkOutcome.Complete, CodeOf(incoming.Place(whole.AsMemory(12, 4), (true, 12))));
        Assert.Equal(whole, incoming.Payload().ToArray());
    }

    [Fact]
    public void Refuses_more_runs_of_bytes_apart_than_its_bound_one_byte_at_a_time()
    {
        var incoming = IncomingOf(PatternOf(1), (20, 1, 40, 3));

        incoming.CreditToGrant(Unbounded);

        Assert.Equal(ChunkOutcome.Placed, CodeOf(incoming.Place(new byte[] { 1 }, (false, 2))));
        Assert.Equal(ChunkOutcome.Placed, CodeOf(incoming.Place(new byte[] { 1 }, (false, 4))));
        Assert.Equal(ProtocolCode.ChunkInvalid, CodeOf(incoming.Place(new byte[] { 1 }, (false, 6))));
    }

    [Fact]
    public void Grants_a_window_past_the_bytes_received_once_half_of_it_can_go_the_rest_at_the_end()
    {
        var incoming = IncomingOf(PatternOf(4), (22, 2, 8, 1_024));

        Assert.Equal(12, incoming.CreditToGrant(Unbounded));

        // nothing received since: nothing more to grant
        Assert.Null(incoming.CreditToGrant(Unbounded));
        Assert.Equal(ChunkOutcome.Placed, CodeOf(incoming.Place(PatternOf(2), (false, 4))));

        // 6 received: 14 would grant 2 more, less than half a window
        Assert.Null(incoming.CreditToGrant(Unbounded));

        foreach (var offset in new[] { 6, 8, 10 })
        {
            Assert.Equal(ChunkOutcome.Placed, CodeOf(incoming.Place(PatternOf(2), (false, offset))));
        }

        Assert.Equal(20, incoming.CreditToGrant(Unbounded));

        foreach (var offset in new[] { 12, 14, 16, 18 })
        {
            Assert.Equal(ChunkOutcome.Placed, CodeOf(incoming.Place(PatternOf(2), (false, offset))));
        }

        // 2 bytes are left, less than half a window: granted all the same
        Assert.Equal(22, incoming.CreditToGrant(Unbounded));
        Assert.Null(incoming.CreditToGrant(Unbounded));
        Assert.Equal(ChunkOutcome.Complete, CodeOf(incoming.Place(PatternOf(2), (true, 20))));
    }

    [Fact]
    public void Grants_no_more_than_the_bytes_it_is_told_are_available()
    {
        var incoming = IncomingOf(PatternOf(4), (30, 1, 8, 1_024));

        // 2 bytes available: less than half a window, so nothing
        Assert.Null(incoming.CreditToGrant(2));
        Assert.Equal(9, incoming.CreditToGrant(5));
        Assert.Equal(9, incoming.CreditEnd);
    }

    [Fact]
    public void Halves_an_odd_window_exactly_as_the_TypeScript_side_does()
    {
        // a window of 129: 64 more bytes are short of half of it, 65 are not
        var incoming = IncomingOf(PatternOf(1), (1_000, 1, 129, 1_024));

        Assert.Null(incoming.CreditToGrant(64));
        Assert.Equal(66, incoming.CreditToGrant(65));
    }

    [Fact]
    public void Carries_100_KiB_through_envelopes_of_1024_bytes_and_a_window_of_8_KiB_a_few_credits_apart()
    {
        const int total = 102_400;

        var limits = new RouterLimits { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_024, WindowBytes = 8_192 };
        var payload = PatternOf(total);
        var payloadBytesPerChunk = Transfer.ChunkPayloadBytes(limits, ChunkHeaderBytes);
        var outgoing = new OutgoingTransfer(payload, (Transfer.ChunkPayloadBytes(limits, 20), payloadBytesPerChunk));
        var incoming = IncomingOf(outgoing.Opening, (total, payloadBytesPerChunk, limits.WindowBytes, 1_024));
        var credits = 0;
        var chunks = 0;

        while (true)
        {
            if (incoming.CreditToGrant(Unbounded) is { } granted)
            {
                credits += 1;
                outgoing.Grant(granted);
            }

            if (outgoing.NextChunk() is not { } chunk)
            {
                break;
            }

            chunks += 1;
            Assert.True(chunk.Bytes.Length + ChunkHeaderBytes <= 1_024);
            incoming.Place(chunk.Bytes, (chunk.IsLast, chunk.Offset));
        }

        Assert.True(outgoing.IsComplete);
        Assert.Equal(total, incoming.Contiguous);
        Assert.Equal(payload, incoming.Payload().ToArray());

        // 101 chunks after the opening of 1,004 bytes; a credit each half window, not each chunk
        Assert.Equal(101, chunks);
        Assert.InRange(credits, 2, (chunks / 2) - 1);
    }
}
