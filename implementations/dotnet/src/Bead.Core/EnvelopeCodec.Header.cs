using System.Buffers.Binary;

namespace Bead;

/// <summary>
/// An envelope's bytes, read and written: its prefix, its header, its failure's record, and the
/// envelope whole. <c>spec/spec.md</c> states what it reads and refuses, in which order.
/// </summary>
public static partial class EnvelopeCodec
{
    // constants

    // the prefix: layout, kind, flags, header words, then the call id at bytes 4 to 7
    private const int PrefixBytes = 8;

    // the first byte of an envelope, from the one this layout is to the last one to come
    private const byte LastLayout = 0xAF;

    // below the first, never a kind; from the advisory one on, skipped
    private const byte FirstKind = (byte)EnvelopeKind.Request;
    private const byte FirstAdvisoryKind = 0x80;

    // the largest value a 64-bit field holds: 2⁵³ − 1, the largest integer a double holds exactly
    private const long Uint53Maximum = (1L << 53) - 1;

    // what a request refused for its layout is told: the layouts this peer reads
    private const string LayoutsRead = "0xA1";

    // helpers

    // what follows the prefix before the blocks: a request's service and procedure, a chunk's
    // offset, a credit's end
    private static int KindPartBytesOf(EnvelopeKind kind)
    {
        return kind switch
        {
            EnvelopeKind.Request => 4,
            EnvelopeKind.Chunk or EnvelopeKind.Credit => 8,
            _ => 0,
        };
    }

    // the flags each kind may carry; any other bit makes the envelope malformed
    private static EnvelopeFlags AllowedFlagsOf(EnvelopeKind kind)
    {
        return kind switch
        {
            EnvelopeKind.Request => EnvelopeFlags.Session
                | EnvelopeFlags.Destination
                | EnvelopeFlags.Transfer
                | EnvelopeFlags.Subscription
                | EnvelopeFlags.Paced,

            // an answer names its call alone: a destination means something to its relay only
            EnvelopeKind.Result => EnvelopeFlags.Session | EnvelopeFlags.Transfer,
            EnvelopeKind.Failure => EnvelopeFlags.Session,
            EnvelopeKind.Chunk => EnvelopeFlags.More,

            // a credit counts a subscription's notifications, or a transfer's bytes
            EnvelopeKind.Credit => EnvelopeFlags.Paced,
            _ => EnvelopeFlags.None,
        };
    }

    // how long a header of `kind` with `flags` is: the prefix, the kind's own part, then each block
    private static int SizeOf(EnvelopeKind kind, EnvelopeFlags flags)
    {
        var bytes = PrefixBytes + KindPartBytesOf(kind);

        if ((flags & EnvelopeFlags.Session) != 0)
        {
            bytes += SessionToken.Bytes;
        }

        if ((flags & EnvelopeFlags.Destination) != 0)
        {
            bytes += 4;
        }

        if ((flags & EnvelopeFlags.Transfer) != 0)
        {
            bytes += 8;
        }

        return bytes;
    }

    private static string HexadecimalOf(int value)
    {
        return $"0x{value:x2}";
    }

    private static FailureException MalformedOf(RouterSide side, string detail)
    {
        return FailureException.OfProtocol(ProtocolCode.EnvelopeMalformed, side, detail);
    }

    // a 64-bit field, its high word first; none for 2⁵³ or more
    private static long? ReadUint53(ReadOnlySpan<byte> bytes)
    {
        var value = BinaryPrimitives.ReadUInt64BigEndian(bytes);

        return value > Uint53Maximum ? null : (long)value;
    }

    private static void AssertField(string field, long value, long maximum)
    {
        if (value < 1 || value > maximum)
        {
            throw new ArgumentOutOfRangeException(
                nameof(value),
                $"{field} is an integer from 1 to {maximum}, got {value}");
        }
    }

    private static void AssertUint53(string field, long value)
    {
        if (value is < 0 or > Uint53Maximum)
        {
            throw new ArgumentOutOfRangeException(
                nameof(value),
                $"{field} is a whole number from 0 to 2⁵³ − 1, got {value}");
        }
    }

    // the flags `header` writes: its blocks, whether it opens a subscription, whether it is paced,
    // and, for a chunk, whether more follow it
    private static EnvelopeFlags FlagsOf(IEnvelopeHeader header)
    {
        return header switch
        {
            RequestHeader request => FlagsOfRequest(request),
            ResultHeader result => (result.Session is null ? 0 : EnvelopeFlags.Session)
                | (result.Total is null ? 0 : EnvelopeFlags.Transfer),
            FailureHeader failure => failure.Session is null ? 0 : EnvelopeFlags.Session,
            ChunkHeader chunk => chunk.IsLast ? 0 : EnvelopeFlags.More,
            CreditHeader credit => credit.Paced ? EnvelopeFlags.Paced : 0,
            NotificationHeader or CancelHeader => EnvelopeFlags.None,
            _ => throw new ArgumentException(
                $"{HexadecimalOf((int)header.Kind)} is not a kind this layout writes",
                nameof(header)),
        };
    }

    private static EnvelopeFlags FlagsOfRequest(RequestHeader request)
    {
        var flags = (request.SessionToken is null ? 0 : EnvelopeFlags.Session)
            | (request.DestinationId is null ? 0 : EnvelopeFlags.Destination)
            | (request.Total is null ? 0 : EnvelopeFlags.Transfer)
            | (request.OpensSubscription ? EnvelopeFlags.Subscription : 0);

        if (request.Paced)
        {
            if (!request.OpensSubscription)
            {
                throw new ArgumentException(
                    "a request paces nothing unless it opens a subscription",
                    nameof(request));
            }

            flags |= EnvelopeFlags.Paced;
        }

        return flags;
    }

    // the prefix of an envelope of this layout, of a kind this peer takes; none for an advisory
    // kind, skipped. Throws, in this order, for a layout to come, a byte that is never a kind, a
    // kind to come, and a call id of 0
    private static (uint CallId, EnvelopeKind Kind)? CheckPrefix(
        ReadOnlySpan<byte> bytes,
        RouterSide side)
    {
        var (callId, kind, layout) = ReadPrefix(bytes, side);

        if (layout != (byte)EnvelopeLayout.First)
        {
            throw FailureException.OfProtocol(ProtocolCode.LayoutUnsupported, side, LayoutsRead);
        }

        if (kind >= FirstAdvisoryKind)
        {
            return null;
        }

        if (kind < FirstKind)
        {
            throw MalformedOf(side, $"{HexadecimalOf(kind)} is never a kind");
        }

        if (!Enum.IsDefined((EnvelopeKind)kind))
        {
            throw FailureException.OfProtocol(
                ProtocolCode.KindUnsupported,
                side,
                $"{HexadecimalOf(kind)} is not a kind this peer takes");
        }

        if (callId == 0)
        {
            throw MalformedOf(side, "a call id is never 0");
        }

        return (callId, (EnvelopeKind)kind);
    }

    // the flags of a header of `kind`, and its length. Throws for a flag its kind does not carry,
    // then for a length that is not its blocks', or that runs past the message
    private static (EnvelopeFlags Flags, int HeaderBytes) CheckLength(
        ReadOnlySpan<byte> bytes,
        (EnvelopeKind Kind, RouterSide Side) reading)
    {
        var (kind, side) = reading;
        var flags = (EnvelopeFlags)bytes[2];
        var refused = flags & ~AllowedFlagsOf(kind);

        if (refused != 0)
        {
            throw MalformedOf(
                side,
                $"a {HexadecimalOf((int)kind)} envelope carries no flag {HexadecimalOf((int)refused)}");
        }

        var headerBytes = bytes[3] * 4;
        var expected = SizeOf(kind, flags);

        if (headerBytes != expected || headerBytes > bytes.Length)
        {
            throw MalformedOf(
                side,
                $"a {HexadecimalOf((int)kind)} header of flags {HexadecimalOf((int)flags)} is {expected} bytes, not {headerBytes} of {bytes.Length}");
        }

        return (flags, headerBytes);
    }

    // the header of `kind`: its call, its kind's own part, and its blocks, in the order of their
    // bits. Throws for the end of a session on a request, a destination of 0, a total of 2⁵³ or
    // more, a procedure of 0, a request paced that opens no subscription, and an offset or an end
    // of 2⁵³ or more
    private static IEnvelopeHeader HeaderOf(ReadOnlySpan<byte> bytes, HeaderReading reading)
    {
        var (callId, kind, flags, side) = reading;
        var offset = PrefixBytes + KindPartBytesOf(kind);
        SessionAnnouncement? session = null;
        uint? destinationId = null;
        long? total = null;

        if ((flags & EnvelopeFlags.Session) != 0)
        {
            var token = bytes.Slice(offset, SessionToken.Bytes);

            // 16 zero bytes announce that a session ended, which only an answer does
            if (!token.ContainsAnyExcept((byte)0))
            {
                if (kind == EnvelopeKind.Request)
                {
                    throw MalformedOf(side, "a request presents no ended session");
                }

                session = SessionAnnouncement.Ended;
            }
            else
            {
                session = SessionToken.FromBytes(token);
            }

            offset += SessionToken.Bytes;
        }

        if ((flags & EnvelopeFlags.Destination) != 0)
        {
            destinationId = BinaryPrimitives.ReadUInt32BigEndian(bytes[offset..]);

            if (destinationId == 0)
            {
                throw MalformedOf(side, "a destination id is never 0");
            }

            offset += 4;
        }

        if ((flags & EnvelopeFlags.Transfer) != 0)
        {
            total = ReadUint53(bytes[offset..]) ?? throw MalformedOf(side, "a total is below 2⁵³");
        }

        switch (kind)
        {
            case EnvelopeKind.Request:
                {
                    var procedureId = BinaryPrimitives.ReadUInt16BigEndian(bytes[(PrefixBytes + 2)..]);

                    if (procedureId == 0)
                    {
                        throw MalformedOf(side, "a procedure id is never 0");
                    }

                    // pacing is a subscription's: a request that opens none has nothing to pace
                    if ((flags & EnvelopeFlags.Paced) != 0 && (flags & EnvelopeFlags.Subscription) == 0)
                    {
                        throw MalformedOf(side, "a request paced opens a subscription");
                    }

                    return new RequestHeader
                    {
                        CallId = callId,
                        ServiceId = BinaryPrimitives.ReadUInt16BigEndian(bytes[PrefixBytes..]),
                        ProcedureId = procedureId,
                        DestinationId = destinationId,
                        OpensSubscription = (flags & EnvelopeFlags.Subscription) != 0,
                        Paced = (flags & EnvelopeFlags.Paced) != 0,

                        // a request's token is never the end of a session, refused above
                        SessionToken = session?.Token,
                        Total = total,
                    };
                }

            // an answer carries no destination: its flag is refused with the others
            case EnvelopeKind.Result:
                return new ResultHeader { CallId = callId, Session = session, Total = total };
            case EnvelopeKind.Failure:
                return new FailureHeader { CallId = callId, Session = session };
            case EnvelopeKind.Notification:
                return new NotificationHeader { CallId = callId };
            case EnvelopeKind.Chunk:
                return new ChunkHeader
                {
                    CallId = callId,
                    Offset = ReadUint53(bytes[PrefixBytes..])
                        ?? throw MalformedOf(side, "a chunk's offset is below 2⁵³"),
                    IsLast = (flags & EnvelopeFlags.More) == 0,
                };
            case EnvelopeKind.Credit:
                return new CreditHeader
                {
                    CallId = callId,
                    CreditEnd = ReadUint53(bytes[PrefixBytes..])
                        ?? throw MalformedOf(side, "a credit's end is below 2⁵³"),
                    Paced = (flags & EnvelopeFlags.Paced) != 0,
                };
            case EnvelopeKind.Cancel:
                return new CancelHeader { CallId = callId };
            default:
                throw new InvalidOperationException($"{HexadecimalOf((int)kind)} passed the check of kinds");
        }
    }

    // definition

    /// <summary>
    /// The first 8 bytes of an envelope, which every layout keeps where they are. Throws a
    /// <see cref="FailureException"/> of <see cref="ProtocolCode.EnvelopeMalformed"/>, raised by
    /// <paramref name="side"/>, for fewer bytes, or a first byte no layout is.
    /// </summary>
    public static EnvelopePrefix ReadPrefix(ReadOnlySpan<byte> bytes, RouterSide side)
    {
        if (bytes.Length < PrefixBytes)
        {
            throw MalformedOf(side, $"an envelope is at least {PrefixBytes} bytes, not {bytes.Length}");
        }

        var layout = bytes[0];

        if (layout is < (byte)EnvelopeLayout.First or > LastLayout)
        {
            throw MalformedOf(side, $"{HexadecimalOf(layout)} is not an envelope's first byte");
        }

        return new EnvelopePrefix(BinaryPrimitives.ReadUInt32BigEndian(bytes[4..]), bytes[1], layout);
    }

    /// <summary>
    /// An envelope's header, as a router of <paramref name="side"/> reads it, and where the payload
    /// starts; none for an advisory kind, which is skipped. Throws a <see cref="FailureException"/>
    /// for the first check it fails, in the order of section 5 of the spec.
    /// </summary>
    public static (IEnvelopeHeader Header, int HeaderBytes)? ReadHeader(
        ReadOnlySpan<byte> bytes,
        RouterSide side)
    {
        if (CheckPrefix(bytes, side) is not var (callId, kind))
        {
            return null;
        }

        var (flags, headerBytes) = CheckLength(bytes, (kind, side));

        return (HeaderOf(bytes, new HeaderReading(callId, kind, flags, side)), headerBytes);
    }

    /// <summary>
    /// How long <paramref name="header"/> is once written. Throws as <see cref="WriteHeader"/> does
    /// for a header no kind of this layout is.
    /// </summary>
    public static int HeaderBytesOf(IEnvelopeHeader header)
    {
        ArgumentNullException.ThrowIfNull(header);

        return SizeOf(header.Kind, FlagsOf(header));
    }

    /// <summary>
    /// Writes <paramref name="header"/> at the start of <paramref name="bytes"/>, and gives its
    /// length. Throws an <see cref="ArgumentException"/>, before anything is written, for a field
    /// that is not from 1 to its maximum — from 0 to 2⁵³ − 1 for an offset, an end or a total — a
    /// request paced that opens no subscription, a token that is no token, or too few bytes.
    /// </summary>
    public static int WriteHeader(IEnvelopeHeader header, Span<byte> bytes)
    {
        ArgumentNullException.ThrowIfNull(header);

        var flags = FlagsOf(header);
        var headerBytes = SizeOf(header.Kind, flags);
        var offset = PrefixBytes;

        AssertField("callId", header.CallId, uint.MaxValue);

        switch (header)
        {
            case RequestHeader request:
                AssertField("serviceId", request.ServiceId, ushort.MaxValue);
                AssertField("procedureId", request.ProcedureId, ushort.MaxValue);

                if (request.DestinationId is { } destinationId)
                {
                    AssertField("destinationId", destinationId, uint.MaxValue);
                }

                break;
            case ChunkHeader chunk:
                AssertUint53("offset", chunk.Offset);
                break;
            case CreditHeader credit:
                AssertUint53("creditEnd", credit.CreditEnd);
                break;
        }

        var (session, total) = header switch
        {
            RequestHeader request => (request.SessionToken is { } token ? token : (SessionAnnouncement?)null, request.Total),
            ResultHeader result => (result.Session, result.Total),
            FailureHeader failure => (failure.Session, null),
            _ => ((SessionAnnouncement?)null, (long?)null),
        };

        if (total is { } declared)
        {
            AssertUint53("total", declared);
        }

        if (session is { Token: { IsDefault: true } })
        {
            throw new ArgumentException("a session token is 16 bytes, not all zero", nameof(header));
        }

        if (bytes.Length < headerBytes)
        {
            throw new ArgumentException(
                $"a {headerBytes}-byte header does not fit in {bytes.Length} bytes",
                nameof(bytes));
        }

        bytes[0] = (byte)EnvelopeLayout.First;
        bytes[1] = (byte)header.Kind;
        bytes[2] = (byte)flags;
        bytes[3] = (byte)(headerBytes / 4);
        BinaryPrimitives.WriteUInt32BigEndian(bytes[4..], header.CallId);

        switch (header)
        {
            case RequestHeader request:
                BinaryPrimitives.WriteUInt16BigEndian(bytes[offset..], request.ServiceId);
                BinaryPrimitives.WriteUInt16BigEndian(bytes[(offset + 2)..], request.ProcedureId);
                offset += 4;
                break;
            case ChunkHeader chunk:
                BinaryPrimitives.WriteUInt64BigEndian(bytes[offset..], (ulong)chunk.Offset);
                offset += 8;
                break;
            case CreditHeader credit:
                BinaryPrimitives.WriteUInt64BigEndian(bytes[offset..], (ulong)credit.CreditEnd);
                offset += 8;
                break;
        }

        if (session is { } announced)
        {
            var block = bytes.Slice(offset, SessionToken.Bytes);

            if (announced.Token is { } token)
            {
                token.CopyTo(block);
            }
            else
            {
                block.Clear();
            }

            offset += SessionToken.Bytes;
        }

        if (header is RequestHeader { DestinationId: { } destination })
        {
            BinaryPrimitives.WriteUInt32BigEndian(bytes[offset..], destination);
            offset += 4;
        }

        if (total is { } length)
        {
            BinaryPrimitives.WriteUInt64BigEndian(bytes[offset..], (ulong)length);
        }

        return headerBytes;
    }

    // what reading a header knows once its prefix and its length are checked
    private readonly record struct HeaderReading(
        uint CallId,
        EnvelopeKind Kind,
        EnvelopeFlags Flags,
        RouterSide Side);
}
