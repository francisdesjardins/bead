using System.Buffers.Binary;
using System.Text;

namespace Bead;

/// <summary>What reading an envelope refuses with, and how much it reads.</summary>
public sealed record EnvelopeReadOptions
{
    /// <summary>The side that reads: the failures it raises say so.</summary>
    public required RouterSide Side { get; init; }

    /// <summary>A whole envelope, its header included, in bytes.</summary>
    public int MaximumEnvelopeBytes { get; init; } = LimitDefaults.MaximumEnvelopeBytes;

    /// <summary>A failure's detail, in bytes, cut at a character's boundary.</summary>
    public int MaximumDetailBytes { get; init; } = LimitDefaults.MaximumDetailBytes;
}

public static partial class EnvelopeCodec
{
    // constants

    // a failure's record: its code, the relays it crossed, its flags, then its detail
    private const int RecordBytes = 4;

    // the one flag of a failure's record this layout reads: the code is the procedure's own
    private const byte Application = 0x01;

    // helpers

    // a failure of `envelopeMalformed` for bytes after the header of a kind that carries none, a
    // credit or a cancel: they are bytes this layout does not define
    private static void AssertNothingAfter(ReadOnlySpan<byte> body, (string What, RouterSide Side) reading)
    {
        if (body.Length > 0)
        {
            throw MalformedOf(reading.Side, $"a {reading.What} carries no payload, not {body.Length} bytes");
        }
    }

    // whether `bytes[index]` continues a UTF-8 character rather than starts one; past the end there
    // is nothing to continue
    private static bool IsContinuation(ReadOnlySpan<byte> bytes, int index)
    {
        return index < bytes.Length && (bytes[index] & 0xC0) == 0x80;
    }

    // definition

    /// <summary>
    /// A failure's record, from a failure envelope's payload: its code, the relays it crossed as
    /// they came, its scope, and its detail — cut to
    /// <see cref="EnvelopeReadOptions.MaximumDetailBytes"/>, back to the start of the character
    /// the cut fell in, a leading U+FEFF kept, and bytes that are not UTF-8 read as U+FFFD. Throws
    /// a <see cref="FailureException"/> of <see cref="ProtocolCode.EnvelopeMalformed"/> for fewer
    /// than 4 bytes, a code of 0, or a flag other than the application's.
    /// </summary>
    public static Failure ReadFailure(ReadOnlySpan<byte> payload, EnvelopeReadOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (payload.Length < RecordBytes)
        {
            throw MalformedOf(options.Side, $"a failure's record is {RecordBytes} bytes at least");
        }

        var code = BinaryPrimitives.ReadUInt16BigEndian(payload);
        var flags = payload[3];

        if (code == 0)
        {
            throw MalformedOf(options.Side, "a failure is never of code 0");
        }

        if ((flags & ~Application) != 0)
        {
            throw MalformedOf(
                options.Side,
                $"a failure's record carries no flag 0x{flags & ~Application:x}");
        }

        var end = Math.Min(payload.Length, RecordBytes + options.MaximumDetailBytes);

        // a cut inside a character drops the whole character
        while (end > RecordBytes && IsContinuation(payload, end))
        {
            end -= 1;
        }

        return new Failure
        {
            Code = code,

            // GetString keeps a leading U+FEFF, and reads what is not UTF-8 as U+FFFD
            Detail = Encoding.UTF8.GetString(payload[RecordBytes..end]),
            Relays = payload[2],
            Scope = (flags & Application) == 0 ? FailureScope.Protocol : FailureScope.Application,
        };
    }

    /// <summary>
    /// An envelope, as a router of <see cref="EnvelopeReadOptions.Side"/> reads it from
    /// <paramref name="bytes"/>: none for an advisory kind. Its payload is a copy, so the
    /// transport's buffer is not held. Throws a <see cref="FailureException"/> for bytes that are
    /// not an envelope, one larger than <see cref="EnvelopeReadOptions.MaximumEnvelopeBytes"/>, or
    /// one it does not read.
    /// </summary>
    public static Envelope? ReadEnvelope(ReadOnlySpan<byte> bytes, EnvelopeReadOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var side = options.Side;

        // the first byte says whether these are an envelope's at all, whatever their length
        ReadPrefix(bytes, side);

        if (bytes.Length > options.MaximumEnvelopeBytes)
        {
            throw FailureException.OfProtocol(
                ProtocolCode.EnvelopeTooLarge,
                side,
                $"an envelope is {options.MaximumEnvelopeBytes} bytes at most, not {bytes.Length}");
        }

        if (ReadHeader(bytes, side) is not var (header, headerBytes))
        {
            return null;
        }

        var body = bytes[headerBytes..];

        switch (header.Kind)
        {
            case EnvelopeKind.Failure:
                return new Envelope { Header = header, Failure = ReadFailure(body, options) };
            case EnvelopeKind.Chunk when body.IsEmpty:
                // a chunk carries the next bytes of its payload: without any, it moves nothing on
                throw MalformedOf(side, "a chunk carries one byte at least");
            case EnvelopeKind.Credit:
                AssertNothingAfter(body, ("credit", side));

                return new Envelope { Header = header };
            case EnvelopeKind.Cancel:
                AssertNothingAfter(body, ("cancel", side));

                return new Envelope { Header = header };
            default:
                return new Envelope { Header = header, Payload = body.ToArray() };
        }
    }

    /// <summary>
    /// A failure's record, to send: its code, the relays it crossed, its scope, and its detail cut
    /// to <paramref name="maximumDetailBytes"/> at a character's boundary, a lone surrogate written
    /// as U+FFFD. Throws an <see cref="ArgumentException"/> for a code of 0 or a scope that is
    /// neither.
    /// </summary>
    public static byte[] WriteFailure(
        Failure failure,
        int maximumDetailBytes = LimitDefaults.MaximumDetailBytes)
    {
        ArgumentNullException.ThrowIfNull(failure);

        if (failure.Code == 0)
        {
            throw new ArgumentException("a failure's code is an integer from 1 to 65535, not 0", nameof(failure));
        }

        if (!Enum.IsDefined(failure.Scope))
        {
            throw new ArgumentException("a failure's scope is the protocol's or the application's", nameof(failure));
        }

        var detailBytes = 0;

        // the characters that fit whole, a lone surrogate counted as the U+FFFD it is written as
        foreach (var rune in failure.Detail.EnumerateRunes())
        {
            if (detailBytes + rune.Utf8SequenceLength > maximumDetailBytes)
            {
                break;
            }

            detailBytes += rune.Utf8SequenceLength;
        }

        var record = new byte[RecordBytes + detailBytes];
        var written = RecordBytes;

        BinaryPrimitives.WriteUInt16BigEndian(record, failure.Code);
        record[2] = failure.Relays;
        record[3] = failure.Scope == FailureScope.Application ? Application : (byte)0;

        foreach (var rune in failure.Detail.EnumerateRunes())
        {
            if (written == record.Length)
            {
                break;
            }

            written += rune.EncodeToUtf8(record.AsSpan(written));
        }

        return record;
    }

    /// <summary>
    /// An envelope's bytes: its header, then its payload — a failure's record, its detail cut to
    /// <paramref name="maximumDetailBytes"/>, for a failure. Throws an
    /// <see cref="ArgumentException"/> as its header and its failure do, for a failure envelope
    /// without its failure or another kind with one, or for a chunk without a byte.
    /// </summary>
    public static byte[] WriteEnvelope(
        Envelope envelope,
        int maximumDetailBytes = LimitDefaults.MaximumDetailBytes)
    {
        ArgumentNullException.ThrowIfNull(envelope);

        var header = envelope.Header;

        if ((header.Kind == EnvelopeKind.Failure) != (envelope.Failure is not null))
        {
            throw new ArgumentException("a failure envelope, and it alone, carries a failure", nameof(envelope));
        }

        if (header.Kind == EnvelopeKind.Chunk && envelope.Payload.IsEmpty)
        {
            throw new ArgumentException("a chunk carries one byte at least", nameof(envelope));
        }

        if (header.Kind is EnvelopeKind.Credit or EnvelopeKind.Cancel && !envelope.Payload.IsEmpty)
        {
            throw new ArgumentException($"a {HexadecimalOf((int)header.Kind)} carries no payload", nameof(envelope));
        }

        var body = envelope.Failure is { } failure
            ? WriteFailure(failure, maximumDetailBytes)
            : envelope.Payload.Span;
        var headerBytes = HeaderBytesOf(header);
        var bytes = new byte[headerBytes + body.Length];

        WriteHeader(header, bytes);
        body.CopyTo(bytes.AsSpan(headerBytes));

        return bytes;
    }
}
