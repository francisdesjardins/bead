using System.Buffers.Binary;
using System.Globalization;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// The parcel's codec (spec 15.17) against <c>spec/vectors.json</c>'s <c>parcels</c> and
/// <c>parcelRefusals</c>, which the TypeScript side's codec plays alike: each parcel read to its
/// fields and written back to its bytes, but those no writer writes, and each refusal told apart as
/// no parcel or a parcel that does not read.
/// </summary>
public sealed class BrokerParcelTests
{
    // helpers

    // a parcel's fields as a vector writes them: its hexadecimal halves and incarnation, a DATA's
    // carried bytes; each field the vector names, in its order, the read parcel's own beside it
    private static string FieldOf((string Name, BrokerParcel Parcel) field)
    {
        var (name, parcel) = field;

        return name switch
        {
            "layout" => parcel.Layout.ToString(CultureInfo.InvariantCulture),
            "kind" => parcel.Kind.ToString(CultureInfo.InvariantCulture),
            "flags" => parcel.Flags.ToString(CultureInfo.InvariantCulture),
            "opener" => HalfOf(parcel.Opener),
            "acceptor" => HalfOf(parcel.Acceptor),
            "sequence" => parcel.Sequence.ToString(CultureInfo.InvariantCulture),
            "id" => parcel.Id ?? "none",
            "incarnation" => parcel.Incarnation is { } incarnation ? IncarnationOf(incarnation) : "none",
            "bound" => parcel.Bound?.ToString(CultureInfo.InvariantCulture) ?? "none",
            "status" => parcel.Status?.ToString(CultureInfo.InvariantCulture) ?? "none",
            "layouts" => parcel.Layouts is { } layouts ? string.Join(",", layouts) : "none",
            "credential" => parcel.Credential ?? "none",
            "carried" => Convert.ToHexString(parcel.Carried.Span),
            "answers" => parcel.Answers?.ToString(CultureInfo.InvariantCulture) ?? "none",
            "code" => parcel.Code?.ToString(CultureInfo.InvariantCulture) ?? "none",
            _ => throw new ArgumentException($"a vector's parcel says what no test reads: {name}", nameof(field)),
        };
    }

    // a field of a vector's parcel, written as FieldOf writes the read one's
    private static string ExpectedOf(JsonProperty field)
    {
        return field.Name switch
        {
            "opener" or "acceptor" or "incarnation" or "carried" => Convert.ToHexString(Vectors.FromHexadecimal(field.Value.GetString()!)),
            "layouts" => string.Join(",", field.Value.EnumerateArray().Select((layout) =>
            {
                return layout.GetInt32();
            })),
            _ => field.Value.ValueKind == JsonValueKind.String ? field.Value.GetString()! : field.Value.GetRawText(),
        };
    }

    private static string HalfOf(ulong half)
    {
        var bytes = new byte[8];

        BinaryPrimitives.WriteUInt64BigEndian(bytes, half);

        return Convert.ToHexString(bytes);
    }

    private static string IncarnationOf(UInt128 incarnation)
    {
        var bytes = new byte[16];

        BinaryPrimitives.WriteUInt128BigEndian(bytes, incarnation);

        return Convert.ToHexString(bytes);
    }

    // definition

    /// <summary>Every parcel and every refusal of the vectors, by its group and its name.</summary>
    public static TheoryData<string, string> Entries { get; } = new([
        .. Vectors.NamesOf("parcels").Select((row) =>
        {
            return ("parcels", row.Data);
        }),
        .. Vectors.NamesOf("parcelRefusals").Select((row) =>
        {
            return ("parcelRefusals", row.Data);
        }),
    ]);

    [Theory]
    [MemberData(nameof(Entries))]
    public void Writes_and_reads_each_kind_of_parcel_byte_for_byte_reads_a_layout_to_come_by_its_prefix_and_refuses_a_parcel_that_does_not_read(string group, string name)
    {
        var vector = Vectors.Of(group, name);
        var bytes = Vectors.BytesOf(vector, "bytes");
        var reading = BrokerParcels.Read(bytes);

        if (group == "parcelRefusals")
        {
            var refused = vector.GetProperty("refused").GetString();

            Assert.Equal(refused, reading.Verdict switch
            {
                BrokerParcelVerdict.NoParcel => "no-parcel",
                BrokerParcelVerdict.DoesNotRead => "does-not-read",
                _ => "a parcel",
            });
            Assert.NotNull(reading.Why);

            return;
        }

        Assert.True(reading.Verdict == BrokerParcelVerdict.Parcel, reading.Why);

        var expected = vector.GetProperty("parcel").EnumerateObject().ToList();

        Assert.Equal(
            expected.Select((field) =>
            {
                return $"{field.Name} {ExpectedOf(field)}";
            }),
            expected.Select((field) =>
            {
                return $"{field.Name} {FieldOf((field.Name, reading.Parcel!))}";
            }));

        // * written back byte for byte, but what a side reads and no writer writes
        if (!vector.TryGetProperty("written", out var written) || written.GetBoolean())
        {
            Assert.Equal(Convert.ToHexString(bytes), Convert.ToHexString(BrokerParcels.Write(reading.Parcel!)));
        }
        else
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return BrokerParcels.Write(reading.Parcel!);
            });
        }
    }

    [Fact]
    public void Writes_no_parcel_a_side_refuses_nor_one_of_a_kind_no_writer_writes()
    {
        const ulong Opener = 0x1112131415161718;
        const ulong Acceptor = 0x2122232425262728;
        var open = new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = Opener, Sequence = 1, Id = "peer", Incarnation = 1, Bound = 1_024 };
        var ping = new BrokerParcel { Kind = BrokerParcelKinds.Ping, Opener = Opener, Acceptor = Acceptor, Sequence = 2 };
        var unfielded = ping with { Kind = BrokerParcelKinds.Data, Flags = BrokerParcelFlags.Credential, Credential = " Bearer x", Carried = new byte[] { 1 } };
        var refused = new (string What, BrokerParcel Parcel)[]
        {
            ("a DATA whose credential is no field value", unfielded),
            ("an advisory kind", ping with { Kind = 0x80 }),
            ("a kind to come", ping with { Kind = 0x0A }),
            ("a kind of 0x00", ping with { Kind = 0 }),
            ("a layout to come", ping with { Layout = 0xB2 }),
            ("an OPEN whose id is no token", open with { Id = "a/b" }),
            ("an OPEN whose receive bound is under 1,024", open with { Bound = 1_023 }),
            ("an OPEN naming an acceptor's half", open with { Acceptor = Acceptor }),
            ("an ACCEPT whose receive bound is under 1,024", open with { Kind = BrokerParcelKinds.Accept, Acceptor = Acceptor, Bound = 1_023 }),
            ("a PING marked SECURE", ping with { Flags = BrokerParcelFlags.Secure }),
            ("a PING whose acceptor's half is zero", ping with { Acceptor = 0 }),
            ("a PING of sequence 0", ping with { Sequence = 0 }),
            ("a PING past 2⁵³ − 1", ping with { Sequence = BrokerParcels.LargestSequence + 1 }),
            ("a RESET with a sequence", ping with { Kind = BrokerParcelKinds.Reset }),
            ("a DATA carrying nothing", ping with { Kind = BrokerParcelKinds.Data }),
            ("a CLOSE of 1003", ping with { Kind = BrokerParcelKinds.Close, Code = 1_003 }),
        };

        Assert.All(refused, (each) =>
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return BrokerParcels.Write(each.Parcel);
            });
        });

        // a credential that is no field value does not read (spec 15.5)
        var reading = BrokerParcels.Read(BrokerParcels.Encode(unfielded));

        Assert.Equal((BrokerParcelVerdict.DoesNotRead, "a credential that is no field value"), (reading.Verdict, reading.Why));

        // what a side sends reads back as it was written
        Assert.Equal(BrokerParcelVerdict.Parcel, BrokerParcels.Read(BrokerParcels.Write(open)).Verdict);
        Assert.Equal(BrokerParcelVerdict.Parcel, BrokerParcels.Read(BrokerParcels.Write(ping)).Verdict);
    }

    [Fact]
    public void Takes_a_token_of_1_to_64_characters_of_base64url_s_alphabet_and_nothing_else()
    {
        Assert.All(["a", "Z", "0", "-", "_", "peer", new string('x', 64), "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"], (token) =>
        {
            Assert.True(BrokerParcels.IsToken(token), token);
        });
        Assert.All(["", new string('x', 65), "a/b", "a.b", "a b", "a+b", "a#b", "$share", "a*", "a>", "é", "a=", null], (text) =>
        {
            Assert.False(BrokerParcels.IsToken(text), text);
        });
    }
}
