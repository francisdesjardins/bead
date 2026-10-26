using System.Buffers.Binary;
using System.Globalization;
using System.Text;

namespace Bead;

/// <summary>
/// The kinds of a parcel, its byte 1 (spec 15.17): 0x00 is never one, 0x0A to 0x7F are the kinds
/// to come, and 0x80 to 0xFF are advisory, taken in their order and skipped.
/// </summary>
internal static class BrokerParcelKinds
{
    /// <summary>A client's, to a server's name: the connection's first leg.</summary>
    public const byte Open = 0x01;

    /// <summary>A server's, to the client's inbox: the second leg.</summary>
    public const byte Accept = 0x02;

    /// <summary>A server's, to the client's inbox: the OPEN refused.</summary>
    public const byte Refuse = 0x03;

    /// <summary>Either end's: an envelope, or a part of one.</summary>
    public const byte Data = 0x04;

    /// <summary>Either end's: the heartbeat's ping, and the client's third leg.</summary>
    public const byte Ping = 0x05;

    /// <summary>Either end's: a ping answered.</summary>
    public const byte Pong = 0x06;

    /// <summary>Either end's: the connection's end, sequenced.</summary>
    public const byte Close = 0x07;

    /// <summary>Either end's: the connection's end at once, unsequenced.</summary>
    public const byte Reset = 0x08;

    /// <summary>A broker's, as a participant's will: its incarnation gone.</summary>
    public const byte Gone = 0x09;

    /// <summary>Whether a kind is advisory: taken in its order and skipped, whatever it holds.</summary>
    public static bool IsAdvisory(byte kind)
    {
        return kind >= 0x80;
    }

    /// <summary>Whether a kind is one to come: a parcel of one, taken in its order, closes its connection with 1002.</summary>
    public static bool IsToCome(byte kind)
    {
        return kind is >= 0x0A and < 0x80;
    }
}

/// <summary>The flags of a parcel, its byte 2 (spec 15.17).</summary>
internal static class BrokerParcelFlags
{
    /// <summary>On a DATA: another part of its envelope comes after it.</summary>
    public const byte More = 0x01;

    /// <summary>On a DATA: a credential comes before its envelope.</summary>
    public const byte Credential = 0x02;

    /// <summary>On an OPEN and an ACCEPT: its sender's own leg is secure (spec 15.22).</summary>
    public const byte Secure = 0x04;
}

/// <summary>
/// One parcel, by its fields (spec 15.17): its prefix — layout, kind, flags, the opener's half, the
/// acceptor's, its sequence — and its body's fields, each of the kinds that have it. A field its
/// kind has no part for is left out.
/// </summary>
internal sealed record BrokerParcel
{
    /// <summary>Its layout, <c>0xB1</c>; <c>0xB2</c> to <c>0xBF</c> the layouts to come, which a side reads to their prefix.</summary>
    public byte Layout { get; init; } = BrokerParcels.Layout;

    /// <summary>Its kind, one of <see cref="BrokerParcelKinds"/>.</summary>
    public required byte Kind { get; init; }

    /// <summary>Its flags, of <see cref="BrokerParcelFlags"/>.</summary>
    public byte Flags { get; init; }

    /// <summary>The opener's half, its 8 bytes big-endian; zero on a GONE.</summary>
    public ulong Opener { get; init; }

    /// <summary>The acceptor's half; zero on an OPEN, a REFUSE and a GONE.</summary>
    public ulong Acceptor { get; init; }

    /// <summary>Its sequence, from 1 in each direction, at most 2⁵³ − 1; 0 on a RESET and a GONE.</summary>
    public ulong Sequence { get; init; }

    /// <summary>An OPEN's, an ACCEPT's or a GONE's: its participant's id, a character a byte.</summary>
    public string? Id { get; init; }

    /// <summary>An OPEN's, an ACCEPT's or a GONE's: its participant's incarnation, its 16 bytes big-endian.</summary>
    public UInt128? Incarnation { get; init; }

    /// <summary>An OPEN's or an ACCEPT's: the largest parcel its sender's inbox takes whole.</summary>
    public long? Bound { get; init; }

    /// <summary>A REFUSE's: 400 malformed, 426 layout-refused or 503 busy.</summary>
    public int? Status { get; init; }

    /// <summary>A REFUSE 426's: the layouts its sender reads, a byte each.</summary>
    public IReadOnlyList<byte>? Layouts { get; init; }

    /// <summary>A DATA's: the credential it carries beside its envelope, on the first part alone.</summary>
    public string? Credential { get; init; }

    /// <summary>A DATA's: the envelope it carries, or the part of one.</summary>
    public ReadOnlyMemory<byte> Carried { get; init; }

    /// <summary>A PONG's: the sequence of the PING it answers.</summary>
    public ulong? Answers { get; init; }

    /// <summary>A CLOSE's: its code, a WebSocket's (RFC 6455 §7.4.1).</summary>
    public int? Code { get; init; }

    /// <summary>Whether it is marked <paramref name="flag"/>.</summary>
    public bool Has(byte flag)
    {
        return (Flags & flag) != 0;
    }
}

/// <summary>What a message read as a parcel is (spec 15.17).</summary>
internal enum BrokerParcelVerdict
{
    /// <summary>A parcel that reads, of its layout or read to its prefix.</summary>
    Parcel,

    /// <summary>No parcel: under 28 bytes, or a first byte outside 0xB1 to 0xBF; dropped and reported.</summary>
    NoParcel,

    /// <summary>A parcel that does not read: its connection closed with 1002, reported.</summary>
    DoesNotRead,
}

/// <summary>
/// A message read as a parcel: what it is; its parcel, whole, or, where it does not read, its prefix
/// alone, which names the connection it closes; and why it does not read.
/// </summary>
internal readonly record struct BrokerParcelReading(BrokerParcelVerdict Verdict, BrokerParcel? Parcel, string? Why);

/// <summary>
/// The parcel's codec (spec 15.17): its 28 bytes of prefix, which every layout keeps, then its body
/// by its kind. It reads every parcel a side reads, a layout to come to its prefix and, of an OPEN,
/// its id, and refuses each that does not read, saying why; it writes none it would refuse.
/// </summary>
internal static class BrokerParcels
{
    /// <summary>The layout this side writes and reads whole.</summary>
    public const byte Layout = 0xB1;

    /// <summary>The bytes of every parcel's prefix.</summary>
    public const int PrefixBytes = 28;

    /// <summary>The largest sequence (spec 1.2): 2⁵³ − 1.</summary>
    public const ulong LargestSequence = (1UL << 53) - 1;

    /// <summary>The least receive bound an OPEN or an ACCEPT announces.</summary>
    public const long LeastBound = 1_024;

    /// <summary>The largest receive bound its field holds.</summary>
    public const long LargestBound = uint.MaxValue;

    /// <summary>The longest a token is, in characters (spec 15.16).</summary>
    public const int LongestToken = 64;

    // the codes a CLOSE carries, a WebSocket's (RFC 6455 §7.4.1), and the private two
    private static readonly int[] Codes = [1000, 1001, 1002, 1009, 4000, 4001];

    // why a body does not read as its kind's, by its length
    private const string Shorter = "a body shorter than its kind's";

    private const string Longer = "a body longer than its kind's";

    /// <summary>Whether <paramref name="text"/> is a token: 1 to 64 characters of base64url's alphabet (RFC 4648 §5).</summary>
    public static bool IsToken(string? text)
    {
        return text is { Length: > 0 and <= LongestToken } && text.All((character) =>
        {
            return character is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-' or '_';
        });
    }

    /// <summary>Whether <paramref name="layout"/> is one a parcel's first byte may be: 0xB1 to 0xBF.</summary>
    public static bool IsLayout(byte layout)
    {
        return layout is >= 0xB1 and <= 0xBF;
    }

    /// <summary>
    /// Reads a message as a parcel: no parcel, under 28 bytes or of a first byte outside 0xB1 to
    /// 0xBF; a layout to come read to its prefix, an OPEN's id beside it and a REFUSE whole; an
    /// advisory kind read to its prefix, whatever its flags, its kept byte and its body; any other
    /// read whole, or refused, its prefix kept.
    /// </summary>
    public static BrokerParcelReading Read(ReadOnlyMemory<byte> message)
    {
        var bytes = message.Span;

        if (bytes.Length < PrefixBytes)
        {
            return new BrokerParcelReading(BrokerParcelVerdict.NoParcel, null, string.Create(CultureInfo.InvariantCulture, $"{bytes.Length} bytes, under a parcel's {PrefixBytes}"));
        }

        if (!IsLayout(bytes[0]))
        {
            return new BrokerParcelReading(BrokerParcelVerdict.NoParcel, null, $"a first byte of {HexOf(bytes[0])}, outside 0xB1 to 0xBF");
        }

        var prefix = new BrokerParcel
        {
            Layout = bytes[0],
            Kind = bytes[1],
            Flags = bytes[2],
            Opener = BinaryPrimitives.ReadUInt64BigEndian(bytes[4..]),
            Acceptor = BinaryPrimitives.ReadUInt64BigEndian(bytes[12..]),
            Sequence = BinaryPrimitives.ReadUInt64BigEndian(bytes[20..]),
        };
        var body = message[PrefixBytes..];

        if (prefix.Layout != Layout)
        {
            return ReadToCome((prefix, body, bytes[3]));
        }

        return ReadOfLayout((prefix, body, bytes[3]));
    }

    /// <summary>
    /// Writes <paramref name="parcel"/>'s bytes; one this codec would refuse, or would read
    /// otherwise, is an <see cref="ArgumentException"/>: no parcel is written that a side refuses.
    /// </summary>
    public static byte[] Write(BrokerParcel parcel)
    {
        ArgumentNullException.ThrowIfNull(parcel);

        // ! what a side reads and no writer writes: a layout to come, an advisory kind, and an OPEN
        // its acceptor refuses 400 (spec 15.18)
        if (parcel.Layout != Layout || parcel.Kind is 0 or > BrokerParcelKinds.Gone)
        {
            throw new ArgumentException($"a parcel of the layout {HexOf(parcel.Layout)} and the kind {HexOf(parcel.Kind)} is read, never written", nameof(parcel));
        }

        if (parcel.Kind is BrokerParcelKinds.Open or BrokerParcelKinds.Accept && (!IsToken(parcel.Id) || parcel.Bound < LeastBound))
        {
            throw new ArgumentException($"{KindNamed(parcel.Kind)} names a token and a receive bound of 1,024 bytes at least", nameof(parcel));
        }

        var bytes = Encode(parcel);

        // ! read back: what does not read as written is no parcel this side may send
        var reading = Read(bytes);

        if (reading.Verdict != BrokerParcelVerdict.Parcel || reading.Parcel!.Layout != Layout)
        {
            throw new ArgumentException($"a parcel this side refuses is never written: {reading.Why}", nameof(parcel));
        }

        return bytes;
    }

    /// <summary>
    /// <paramref name="parcel"/>'s bytes, by its fields, held to nothing: what a test's own peer
    /// writes, a parcel this side refuses among them; <see cref="Write"/> holds what a side sends.
    /// </summary>
    internal static byte[] Encode(BrokerParcel parcel)
    {
        ArgumentNullException.ThrowIfNull(parcel);

        var body = BodyOf(parcel);
        var bytes = new byte[PrefixBytes + body.Length];

        bytes[0] = parcel.Layout;
        bytes[1] = parcel.Kind;
        bytes[2] = parcel.Flags;
        BinaryPrimitives.WriteUInt64BigEndian(bytes.AsSpan(4), parcel.Opener);
        BinaryPrimitives.WriteUInt64BigEndian(bytes.AsSpan(12), parcel.Acceptor);
        BinaryPrimitives.WriteUInt64BigEndian(bytes.AsSpan(20), parcel.Sequence);
        body.CopyTo(bytes.AsSpan(PrefixBytes));

        return bytes;
    }

    /// <summary>A kind's name, as a reader of a report reads it: OPEN, DATA…, or its byte.</summary>
    public static string NameOf(byte kind)
    {
        return kind switch
        {
            BrokerParcelKinds.Open => "OPEN",
            BrokerParcelKinds.Accept => "ACCEPT",
            BrokerParcelKinds.Refuse => "REFUSE",
            BrokerParcelKinds.Data => "DATA",
            BrokerParcelKinds.Ping => "PING",
            BrokerParcelKinds.Pong => "PONG",
            BrokerParcelKinds.Close => "CLOSE",
            BrokerParcelKinds.Reset => "RESET",
            BrokerParcelKinds.Gone => "GONE",
            _ => string.Create(CultureInfo.InvariantCulture, $"0x{kind:X2}"),
        };
    }

    /// <summary>A byte as a report writes it, as the spec does: <c>0xB1</c>, two digits in capitals.</summary>
    public static string HexOf(byte value)
    {
        return string.Create(CultureInfo.InvariantCulture, $"0x{value:X2}");
    }

    /// <summary>A kind as a report names it, its article before it: <c>an OPEN</c>, <c>a DATA</c>; <c>a parcel</c> for none.</summary>
    public static string KindNamed(byte kind)
    {
        if (kind is 0 or > BrokerParcelKinds.Gone)
        {
            return "a parcel";
        }

        var name = NameOf(kind);

        return $"{(name[0] is 'A' or 'E' or 'I' or 'O' or 'U' ? "an" : "a")} {name}";
    }

    // the flags each kind takes
    private static byte FlagsOf(byte kind)
    {
        return kind switch
        {
            BrokerParcelKinds.Data => BrokerParcelFlags.More | BrokerParcelFlags.Credential,
            BrokerParcelKinds.Open or BrokerParcelKinds.Accept => BrokerParcelFlags.Secure,
            _ => 0,
        };
    }

    // a parcel of layout 0xB1, read whole: an advisory kind to its prefix, whatever its flags, its
    // kept byte and its body; any other by its kind, its flags, its kept byte, its prefix, then its body
    private static BrokerParcelReading ReadOfLayout((BrokerParcel Prefix, ReadOnlyMemory<byte> Body, byte Kept) parcel)
    {
        var (prefix, body, kept) = parcel;

        if (BrokerParcelKinds.IsAdvisory(prefix.Kind))
        {
            return prefix.Sequence is 0 or > LargestSequence
                ? Refused(prefix, "an advisory parcel with no sequence")
                : new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Flags = 0 }, null);
        }

        if (prefix.Kind == 0 || BrokerParcelKinds.IsToCome(prefix.Kind))
        {
            return Refused(prefix, prefix.Kind == 0 ? "a kind of 0x00, never one" : $"a kind to come, {HexOf(prefix.Kind)}");
        }

        if ((prefix.Flags & ~FlagsOf(prefix.Kind)) != 0)
        {
            return Refused(prefix, $"a flag {KindNamed(prefix.Kind)} does not take");
        }

        if (kept != 0)
        {
            return Refused(prefix, "a kept byte that is not 0");
        }

        if (PrefixFaultOf(prefix) is { } fault)
        {
            return Refused(prefix, fault);
        }

        return ReadBody((prefix, body));
    }

    // why a prefix of layout 0xB1 does not read as its kind's: its sequence, then its halves; or none
    private static string? PrefixFaultOf(BrokerParcel prefix)
    {
        if (prefix.Sequence > LargestSequence)
        {
            return "a sequence past 2⁵³ − 1";
        }

        var isUnsequenced = prefix.Kind is BrokerParcelKinds.Reset or BrokerParcelKinds.Gone;

        if (isUnsequenced != (prefix.Sequence == 0))
        {
            return isUnsequenced ? $"{KindNamed(prefix.Kind)} with a sequence" : "a sequence of 0";
        }

        if (prefix.Kind == BrokerParcelKinds.Gone)
        {
            return prefix.Opener == 0 && prefix.Acceptor == 0 ? null : "a GONE naming a half";
        }

        if (prefix.Opener == 0)
        {
            return "an opener's half all zero";
        }

        var namesNoAcceptor = prefix.Kind is BrokerParcelKinds.Open or BrokerParcelKinds.Refuse;

        if (namesNoAcceptor != (prefix.Acceptor == 0))
        {
            return namesNoAcceptor ? "an acceptor's half where it names none" : "an acceptor's half all zero";
        }

        return null;
    }

    private static BrokerParcelReading Refused(BrokerParcel prefix, string why)
    {
        return new BrokerParcelReading(BrokerParcelVerdict.DoesNotRead, prefix, why);
    }

    // a layout to come, read as every layout keeps it: its prefix; an OPEN's id at the head of its
    // body; a REFUSE whole
    private static BrokerParcelReading ReadToCome((BrokerParcel Prefix, ReadOnlyMemory<byte> Body, byte Kept) parcel)
    {
        var (prefix, body, kept) = parcel;

        if (prefix.Kind == BrokerParcelKinds.Open)
        {
            var span = body.Span;

            if (span.Length >= 1 && span.Length >= 1 + span[0])
            {
                return new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Flags = 0, Id = Encoding.Latin1.GetString(span.Slice(1, span[0])) }, null);
            }

            return Refused(prefix, "an OPEN whose id runs past its bytes");
        }

        if (prefix.Kind != BrokerParcelKinds.Refuse)
        {
            return new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Flags = 0 }, null);
        }

        // * a REFUSE every layout keeps: read as its own, its layout kept
        var whole = ReadOfLayout((prefix with { Layout = Layout }, body, kept));

        return whole with { Parcel = whole.Parcel! with { Layout = prefix.Layout } };
    }

    private static BrokerParcelReading ReadBody((BrokerParcel Prefix, ReadOnlyMemory<byte> Body) parcel)
    {
        var (prefix, body) = parcel;
        var span = body.Span;

        switch (prefix.Kind)
        {
            case BrokerParcelKinds.Open:
            case BrokerParcelKinds.Accept:
                {
                    if (span.Length < 1 || span.Length < 1 + span[0] + 16 + 4)
                    {
                        return Refused(prefix, Shorter);
                    }

                    var id = Encoding.Latin1.GetString(span.Slice(1, span[0]));
                    var bound = (long)BinaryPrimitives.ReadUInt32BigEndian(span[(1 + span[0] + 16)..]);

                    // ! an OPEN's id that is no token, or its bound under 1,024, is its acceptor's to
                    // refuse 400 (spec 15.18); an ACCEPT's does not read
                    if (prefix.Kind == BrokerParcelKinds.Accept && !IsToken(id))
                    {
                        return Refused(prefix, "an id that is no token");
                    }

                    if (prefix.Kind == BrokerParcelKinds.Accept && bound < LeastBound)
                    {
                        return Refused(prefix, "a receive bound under 1,024 bytes");
                    }

                    if (span.Length > 1 + span[0] + 16 + 4)
                    {
                        return Refused(prefix, Longer);
                    }

                    return new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with
                    {
                        Id = id,
                        Incarnation = BinaryPrimitives.ReadUInt128BigEndian(span.Slice(1 + span[0], 16)),
                        Bound = bound,
                    }, null);
                }

            case BrokerParcelKinds.Refuse:
                {
                    var status = span.Length < 2 ? -1 : (int)BinaryPrimitives.ReadUInt16BigEndian(span);

                    if (status is not (400 or 426 or 503))
                    {
                        return Refused(prefix, "a status a REFUSE does not name");
                    }

                    var layouts = span[2..].ToArray();

                    if (status != 426)
                    {
                        return layouts.Length == 0
                            ? new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Status = status }, null)
                            : Refused(prefix, Longer);
                    }

                    return layouts.Length > 0 && layouts.All(IsLayout)
                        ? new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Status = status, Layouts = layouts }, null)
                        : Refused(prefix, "a 426 that names no layout it reads");
                }

            case BrokerParcelKinds.Data:
                {
                    string? credential = null;
                    var at = 0;

                    if (prefix.Has(BrokerParcelFlags.Credential))
                    {
                        var length = span.Length < 2 ? 0 : BinaryPrimitives.ReadUInt16BigEndian(span);

                        if (length == 0 || span.Length < 2 + length)
                        {
                            return Refused(prefix, "a credential that runs past its bytes, or is empty");
                        }

                        credential = Encoding.Latin1.GetString(span.Slice(2, length));
                        at = 2 + length;

                        // a credential is any field value (spec 15.5)
                        if (!HostsAndOrigins.IsVisibleField(credential))
                        {
                            return Refused(prefix, "a credential that is no field value");
                        }
                    }

                    return span.Length > at
                        ? new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Credential = credential, Carried = body[at..] }, null)
                        : Refused(prefix, "a DATA that carries nothing");
                }

            case BrokerParcelKinds.Ping:
            case BrokerParcelKinds.Reset:
                return span.Length == 0 ? new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix, null) : Refused(prefix, Longer);

            case BrokerParcelKinds.Pong:
                {
                    // ! what it answers is a sequence, 2⁵³ − 1 at most (spec 1.2)
                    if (span.Length < 8 || BinaryPrimitives.ReadUInt64BigEndian(span) > LargestSequence)
                    {
                        return Refused(prefix, "a PONG that answers no sequence");
                    }

                    return span.Length == 8
                        ? new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Answers = BinaryPrimitives.ReadUInt64BigEndian(span) }, null)
                        : Refused(prefix, Longer);
                }

            case BrokerParcelKinds.Close:
                {
                    var code = span.Length < 2 ? -1 : BinaryPrimitives.ReadUInt16BigEndian(span);

                    if (!Codes.Contains(code))
                    {
                        return Refused(prefix, "a code a CLOSE does not name");
                    }

                    return span.Length == 2
                        ? new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Code = code }, null)
                        : Refused(prefix, Longer);
                }

            default:
                {
                    // a GONE: its incarnation, then its id, a token
                    if (span.Length < 17 || span.Length < 17 + span[16])
                    {
                        return Refused(prefix, Shorter);
                    }

                    var id = Encoding.Latin1.GetString(span.Slice(17, span[16]));

                    if (!IsToken(id))
                    {
                        return Refused(prefix, "an id that is no token");
                    }

                    return span.Length == 17 + span[16]
                        ? new BrokerParcelReading(BrokerParcelVerdict.Parcel, prefix with { Incarnation = BinaryPrimitives.ReadUInt128BigEndian(span), Id = id }, null)
                        : Refused(prefix, Longer);
                }
        }
    }

    // a parcel's body, by its kind, as ReadBody reads it
    private static byte[] BodyOf(BrokerParcel parcel)
    {
        switch (parcel.Kind)
        {
            case BrokerParcelKinds.Open:
            case BrokerParcelKinds.Accept:
                {
                    var id = Latin1Of((parcel.Id ?? "", "an id"));

                    if (id.Length > byte.MaxValue || parcel.Bound is < 0 or > LargestBound)
                    {
                        throw new ArgumentException("an OPEN's or an ACCEPT's id is 255 bytes at most, and its bound one of 4 bytes", nameof(parcel));
                    }

                    var body = new byte[1 + id.Length + 16 + 4];

                    body[0] = (byte)id.Length;
                    id.CopyTo(body, 1);
                    BinaryPrimitives.WriteUInt128BigEndian(body.AsSpan(1 + id.Length), parcel.Incarnation ?? 0);
                    BinaryPrimitives.WriteUInt32BigEndian(body.AsSpan(1 + id.Length + 16), (uint)(parcel.Bound ?? 0));

                    return body;
                }

            case BrokerParcelKinds.Refuse:
                {
                    var layouts = parcel.Layouts ?? [];
                    var body = new byte[2 + layouts.Count];

                    BinaryPrimitives.WriteUInt16BigEndian(body, (ushort)(parcel.Status ?? 0));

                    for (var index = 0; index < layouts.Count; index += 1)
                    {
                        body[2 + index] = layouts[index];
                    }

                    return body;
                }

            case BrokerParcelKinds.Data:
                {
                    var credential = parcel.Credential is null ? [] : Latin1Of((parcel.Credential, "a credential"));
                    var at = parcel.Credential is null ? 0 : 2 + credential.Length;
                    var body = new byte[at + parcel.Carried.Length];

                    if (parcel.Credential is not null)
                    {
                        BinaryPrimitives.WriteUInt16BigEndian(body, (ushort)credential.Length);
                        credential.CopyTo(body, 2);
                    }

                    parcel.Carried.Span.CopyTo(body.AsSpan(at));

                    return body;
                }

            case BrokerParcelKinds.Pong:
                {
                    var body = new byte[8];

                    BinaryPrimitives.WriteUInt64BigEndian(body, parcel.Answers ?? 0);

                    return body;
                }

            case BrokerParcelKinds.Close:
                {
                    var body = new byte[2];

                    BinaryPrimitives.WriteUInt16BigEndian(body, (ushort)(parcel.Code ?? 0));

                    return body;
                }

            case BrokerParcelKinds.Gone:
                {
                    var id = Latin1Of((parcel.Id ?? "", "an id"));
                    var body = new byte[17 + id.Length];

                    BinaryPrimitives.WriteUInt128BigEndian(body, parcel.Incarnation ?? 0);
                    body[16] = (byte)Math.Min(id.Length, byte.MaxValue);
                    id.CopyTo(body, 17);

                    return body;
                }

            default:
                return [];
        }
    }

    // ! a string a character a byte, as an id and a credential are written: one past U+00FF is
    // refused, never written as Latin-1's stand-in
    private static byte[] Latin1Of((string Text, string What) written)
    {
        var (text, what) = written;

        if (text.Any((character) =>
        {
            return character > '\u00FF';
        }))
        {
            throw new ArgumentException($"{what} is written a character a byte, not \"{text}\"");
        }

        return Encoding.Latin1.GetBytes(text);
    }
}
