using System.Buffers.Binary;
using System.Text;

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

    // the most a header holds: the 255 words byte 3 counts
    private const int MaximumHeaderBytes = 1_020;

    // the last character a JWT's token is written in: a byte a character
    private const char LastLatin1 = '\u00FF';

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
            EnvelopeKind.Request => EnvelopeFlags.Destination
                | EnvelopeFlags.Transfer
                | EnvelopeFlags.Credential
                | EnvelopeFlags.Subscription
                | EnvelopeFlags.Paced,

            // an answer names its call alone: a destination means something to its relay only
            EnvelopeKind.Result => EnvelopeFlags.Transfer | EnvelopeFlags.Credential,
            EnvelopeKind.Failure => EnvelopeFlags.Credential,
            EnvelopeKind.Chunk => EnvelopeFlags.More,

            // a credit counts a subscription's notifications, or a transfer's bytes
            EnvelopeKind.Credit => EnvelopeFlags.Paced,
            _ => EnvelopeFlags.None,
        };
    }

    // where the CREDENTIAL block of a header of `kind` with `flags` starts, and where one without
    // it ends: the prefix, the kind's own part, then each block of a fixed length
    private static int FixedBytesOf(EnvelopeKind kind, EnvelopeFlags flags)
    {
        var bytes = PrefixBytes + KindPartBytesOf(kind);

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

    // a CREDENTIAL block holding `length` bytes: its head, its bytes, then zero bytes to the next
    // word, as a TLS extension is laid out (RFC 8446 §4.2), its padding aside
    private static int BlockBytesOf(int length)
    {
        return Credential.HeadBytes + ((length + 3) & ~3);
    }

    // the bytes a credential's block holds, its head and its padding aside
    private static int LengthOf(Credential credential)
    {
        return credential.Scheme switch
        {
            CredentialScheme.None or CredentialScheme.Elsewhere => 0,
            CredentialScheme.Opaque => SessionToken.Bytes,
            CredentialScheme.Jwt => credential.Token!.Length,
            _ => credential.Bytes.Length,
        };
    }

    // the credential a header carries in its block; none without one
    private static Credential? CredentialOf(IEnvelopeHeader header)
    {
        return header switch
        {
            RequestHeader request => request.Credential,
            ResultHeader result => result.Credential,
            FailureHeader failure => failure.Credential,
            _ => null,
        };
    }

    // how long `header` is, with `flags`: to its CREDENTIAL block, then the block
    private static int SizeOf(IEnvelopeHeader header, EnvelopeFlags flags)
    {
        var bytes = FixedBytesOf(header.Kind, flags);

        return CredentialOf(header) is { } credential ? bytes + BlockBytesOf(LengthOf(credential)) : bytes;
    }

    // how `header` is laid out: its flags, and its length to the end of its credential's padding.
    // Throws for a header no kind of this layout is, a request paced that opens no subscription, a
    // credential its kind does not take or that is not its scheme's, and a header past 1,020 bytes
    private static (EnvelopeFlags Flags, int HeaderBytes) LayoutOf(IEnvelopeHeader header)
    {
        var flags = FlagsOf(header);

        if (CredentialOf(header) is { } credential)
        {
            AssertCredential(credential, header.Kind);
        }

        var headerBytes = SizeOf(header, flags);

        if (headerBytes > MaximumHeaderBytes)
        {
            throw new ArgumentException(
                $"a header is {MaximumHeaderBytes} bytes at most, not {headerBytes}",
                nameof(header));
        }

        return (flags, headerBytes);
    }

    private static string HexadecimalOf(int value)
    {
        return $"0x{value:x2}";
    }

    /// <summary>A credential scheme's name, for a detail; its number for a scheme to come.</summary>
    internal static string SchemeNameOf(CredentialScheme scheme)
    {
        return scheme switch
        {
            CredentialScheme.None => "NONE",
            CredentialScheme.Opaque => "OPAQUE",
            CredentialScheme.Jwt => "JWT",
            CredentialScheme.Elsewhere => "ELSEWHERE",
            _ => $"scheme {(ushort)scheme}",
        };
    }

    // why a header of `kind` carries no credential of `scheme`: a request presents one, which NONE
    // is not; an answer announces its connection's session, or its end, and nothing else. None
    // when it carries one
    private static string? KindRefusalOf(EnvelopeKind kind, CredentialScheme scheme)
    {
        return (kind, scheme) switch
        {
            (EnvelopeKind.Request, CredentialScheme.None) => "a request presents a credential, never NONE",
            (not EnvelopeKind.Request, not (CredentialScheme.None or CredentialScheme.Opaque)) =>
                $"an answer announces OPAQUE or NONE, not {SchemeNameOf(scheme)}",
            _ => null,
        };
    }

    // why `held`, the bytes of a credential of `scheme`, are not its scheme's: a length not its own,
    // or an OPAQUE token of 16 zero bytes; none when they are
    private static string? BrokenRuleOf(CredentialScheme scheme, ReadOnlySpan<byte> held)
    {
        return scheme switch
        {
            CredentialScheme.None or CredentialScheme.Elsewhere when !held.IsEmpty =>
                $"{SchemeNameOf(scheme)} holds no byte, not {held.Length}",
            CredentialScheme.Opaque when held.Length != SessionToken.Bytes =>
                $"an OPAQUE token is {SessionToken.Bytes} bytes, not {held.Length}",
            CredentialScheme.Opaque when !held.ContainsAnyExcept((byte)0) => "an OPAQUE token is never all zero",
            CredentialScheme.Jwt when held.IsEmpty => "a JWT is 1 byte at least",
            _ => null,
        };
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
            ResultHeader result => (result.Total is null ? 0 : EnvelopeFlags.Transfer)
                | (result.Credential is null ? 0 : EnvelopeFlags.Credential),
            FailureHeader failure => failure.Credential is null ? 0 : EnvelopeFlags.Credential,
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
        var flags = (request.DestinationId is null ? 0 : EnvelopeFlags.Destination)
            | (request.Total is null ? 0 : EnvelopeFlags.Transfer)
            | (request.Credential is null ? 0 : EnvelopeFlags.Credential)
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
    // then for a length that is not its blocks', to the end of its credential's padding, or that
    // runs past the message; with a credential, for one past the message, then for one that does
    // not hold the head of its CREDENTIAL block
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
        var expected = FixedBytesOf(kind, flags);

        if ((flags & EnvelopeFlags.Credential) != 0)
        {
            if (headerBytes > bytes.Length)
            {
                throw MalformedOf(
                    side,
                    $"a {HexadecimalOf((int)kind)} header of {headerBytes} bytes runs past its message of {bytes.Length}");
            }

            // ! the block's head states the block's length: a header that does not hold the head is
            // refused before the head is read, which might lie past the header, or the message
            if (headerBytes < expected + Credential.HeadBytes)
            {
                throw MalformedOf(
                    side,
                    $"a {HexadecimalOf((int)kind)} header of flags {HexadecimalOf((int)flags)} holds its credential's head: {expected + Credential.HeadBytes} bytes at least, not {headerBytes}");
            }

            expected += BlockBytesOf(BinaryPrimitives.ReadUInt16BigEndian(bytes[(expected + 2)..]));
        }

        if (headerBytes != expected || headerBytes > bytes.Length)
        {
            throw MalformedOf(
                side,
                $"a {HexadecimalOf((int)kind)} header of flags {HexadecimalOf((int)flags)} is {expected} bytes, not {headerBytes} of {bytes.Length}");
        }

        return (flags, headerBytes);
    }

    // the credential of the block at `offset`, whose length the header's already holds. Throws
    // for padding that is not zero, a scheme its kind does not take, a length that is not its
    // scheme's, and an OPAQUE token of 16 zero bytes
    private static Credential CredentialAt(ReadOnlySpan<byte> bytes, (int Offset, HeaderReading Header) reading)
    {
        var (offset, (_, kind, _, side)) = reading;
        var scheme = (CredentialScheme)BinaryPrimitives.ReadUInt16BigEndian(bytes[offset..]);
        var length = BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 2)..]);
        var credential = bytes.Slice(offset + Credential.HeadBytes, length);

        if (bytes[(offset + Credential.HeadBytes + length)..(offset + BlockBytesOf(length))].ContainsAnyExcept((byte)0))
        {
            throw MalformedOf(side, "a credential's padding is zero bytes");
        }

        if (KindRefusalOf(kind, scheme) is { } kindRefusal)
        {
            throw MalformedOf(side, kindRefusal);
        }

        if (BrokenRuleOf(scheme, credential) is { } brokenRule)
        {
            throw MalformedOf(side, brokenRule);
        }

        return scheme switch
        {
            CredentialScheme.None => Credential.None,
            CredentialScheme.Elsewhere => Credential.Elsewhere,
            CredentialScheme.Opaque => Credential.Opaque(SessionToken.FromBytes(credential)),

            // a byte a character, whatever the byte: a relay passes on the very bytes it read
            CredentialScheme.Jwt => Credential.Jwt(Encoding.Latin1.GetString(credential)),
            _ => Credential.Of(scheme, credential),
        };
    }

    // the header of `kind`: its call, its kind's own part, and its blocks, in the order of their
    // bits. Throws for a destination of 0, a total of 2⁵³ or more, a credential its kind does not
    // take or that is not its scheme's, a procedure of 0, a request paced that opens no
    // subscription, and an offset or an end of 2⁵³ or more
    private static IEnvelopeHeader HeaderOf(ReadOnlySpan<byte> bytes, HeaderReading reading)
    {
        var (callId, kind, flags, side) = reading;
        var offset = PrefixBytes + KindPartBytesOf(kind);
        uint? destinationId = null;
        long? total = null;
        Credential? credential = null;

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
            offset += 8;
        }

        if ((flags & EnvelopeFlags.Credential) != 0)
        {
            credential = CredentialAt(bytes, (offset, reading));
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
                        Total = total,
                        Credential = credential,
                    };
                }

            // an answer carries no destination: its flag is refused with the others
            case EnvelopeKind.Result:
                return new ResultHeader { CallId = callId, Total = total, Credential = credential };
            case EnvelopeKind.Failure:
                return new FailureHeader { CallId = callId, Credential = credential };
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
    /// How long <paramref name="header"/> is once written. Throws an
    /// <see cref="ArgumentException"/> as <see cref="WriteHeader"/> does for a header no kind of this
    /// layout is, a request paced that opens no subscription, a credential its kind does not take or
    /// that is not its scheme's, or a header past 1,020 bytes.
    /// </summary>
    public static int HeaderBytesOf(IEnvelopeHeader header)
    {
        ArgumentNullException.ThrowIfNull(header);

        return LayoutOf(header).HeaderBytes;
    }

    /// <summary>
    /// Writes <paramref name="header"/> at the start of <paramref name="bytes"/>, and gives its
    /// length. Throws an <see cref="ArgumentException"/>, before anything is written, for a field
    /// that is not from 1 to its maximum — from 0 to 2⁵³ − 1 for an offset, an end or a total — a
    /// request paced that opens no subscription, a credential its kind does not take or that is not
    /// its scheme's, a header past 1,020 bytes, or too few bytes.
    /// </summary>
    public static int WriteHeader(IEnvelopeHeader header, Span<byte> bytes)
    {
        ArgumentNullException.ThrowIfNull(header);

        var (flags, headerBytes) = LayoutOf(header);
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

        var total = header switch
        {
            RequestHeader request => request.Total,
            ResultHeader result => result.Total,
            _ => null,
        };
        var credential = CredentialOf(header);

        if (total is { } declared)
        {
            AssertUint53("total", declared);
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

        if (header is RequestHeader { DestinationId: { } destination })
        {
            BinaryPrimitives.WriteUInt32BigEndian(bytes[offset..], destination);
            offset += 4;
        }

        if (total is { } length)
        {
            BinaryPrimitives.WriteUInt64BigEndian(bytes[offset..], (ulong)length);
            offset += 8;
        }

        if (credential is { } written)
        {
            WriteCredential(written, bytes[offset..headerBytes]);
        }

        return headerBytes;
    }

    // a credential a header of `kind` may carry, as section 4.10 of the spec has a writer write it:
    // a scheme its kind takes, and a length its scheme's
    private static void AssertCredential(Credential credential, EnvelopeKind kind)
    {
        if (KindRefusalOf(kind, credential.Scheme) is { } kindRefusal)
        {
            throw new ArgumentException(kindRefusal, nameof(credential));
        }

        if (credential.SessionToken is { IsDefault: true })
        {
            throw new ArgumentException("a session token is 16 bytes, not all zero", nameof(credential));
        }

        // a call's options' OPAQUE stands for a session its side fills in, and goes out with its token
        if (credential is { Scheme: CredentialScheme.Opaque, SessionToken: null })
        {
            throw new ArgumentException("an OPAQUE carries its session's token", nameof(credential));
        }

        if (credential.Token is not { } token)
        {
            return;
        }

        if (token.Length == 0)
        {
            throw new ArgumentException("a JWT is one character at least", nameof(credential));
        }

        // ! a JWT is written a byte a character: one past U+00FF has no byte, and Latin-1 would
        // write a question mark for it
        if (token.AsSpan().ContainsAnyExceptInRange('\0', LastLatin1))
        {
            throw new ArgumentException(
                "a JWT is written a byte a character, from U+0000 to U+00FF",
                nameof(credential));
        }
    }

    // writes `credential`'s CREDENTIAL block over `block`, its padding included
    private static void WriteCredential(Credential credential, Span<byte> block)
    {
        var length = LengthOf(credential);
        var bytes = block.Slice(Credential.HeadBytes, length);

        BinaryPrimitives.WriteUInt16BigEndian(block, (ushort)credential.Scheme);
        BinaryPrimitives.WriteUInt16BigEndian(block[2..], (ushort)length);
        block[Credential.HeadBytes..].Clear();

        switch (credential.Scheme)
        {
            case CredentialScheme.Opaque:
                credential.SessionToken!.Value.CopyTo(bytes);
                break;
            case CredentialScheme.Jwt:
                Encoding.Latin1.GetBytes(credential.Token, bytes);
                break;
            default:
                credential.Bytes.Span.CopyTo(bytes);
                break;
        }
    }

    // what reading a header knows once its prefix and its length are checked
    private readonly record struct HeaderReading(
        uint CallId,
        EnvelopeKind Kind,
        EnvelopeFlags Flags,
        RouterSide Side);
}
