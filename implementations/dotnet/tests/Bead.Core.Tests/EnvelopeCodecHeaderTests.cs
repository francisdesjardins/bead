namespace Bead.Tests;

/// <summary>
/// <see cref="EnvelopeCodec"/>'s prefix and header, read and written: every vector of
/// <c>headers</c>, <c>reads</c>, <c>prefixes</c>, <c>prefixRefusals</c> and <c>headerRefusals</c>,
/// then what a writer refuses, which no vector holds.
/// </summary>
public sealed class EnvelopeCodecHeaderTests
{
    // constants

    private static readonly SessionToken Token = SessionToken.Parse("AAECAwQFBgcICQoLDA0ODw");

    // what a writer refuses of a header's fields: one out of its range, a flag its header does not
    // hold together with
    private static readonly Dictionary<string, IEnvelopeHeader> Unwritable = new()
    {
        ["a call id of 0"] = new ResultHeader { CallId = 0 },
        ["a service id of 0"] = new RequestHeader { CallId = 3, ServiceId = 0, ProcedureId = 1 },
        ["a procedure id of 0"] = new RequestHeader { CallId = 3, ServiceId = 2, ProcedureId = 0 },
        ["a destination id of 0"] =
            new RequestHeader { CallId = 3, ServiceId = 2, ProcedureId = 1, DestinationId = 0 },
        ["a request paced that opens no subscription"] =
            new RequestHeader { CallId = 3, ServiceId = 2, ProcedureId = 1, Paced = true },
        ["a negative offset"] = new ChunkHeader { CallId = 7, Offset = -1, IsLast = true },
        ["an offset of 2^53"] = new ChunkHeader { CallId = 7, Offset = 1L << 53, IsLast = true },
        ["an end of 2^53"] = new CreditHeader { CallId = 7, CreditEnd = 1L << 53 },
        ["a total of 2^53"] = new ResultHeader { CallId = 3, Total = 1L << 53 },
        ["a negative total"] =
            new RequestHeader { CallId = 3, ServiceId = 2, ProcedureId = 1, Total = -1 },
    };

    // what a writer refuses of a credential, and sizing alike: a scheme its kind does not take, or
    // what its scheme does not hold, a header past 1,020 bytes among it
    private static readonly Dictionary<string, IEnvelopeHeader> UnwritableCredentials = new()
    {
        ["an OPAQUE token of 16 zero bytes on a request"] =
            new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Credential = Credential.Opaque(default) },
        ["an OPAQUE token of 16 zero bytes on a result"] =
            new ResultHeader { CallId = 2, Credential = Credential.Opaque(default) },
        ["NONE on a request"] =
            new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Credential = Credential.None },
        ["a JWT on a result"] = new ResultHeader { CallId = 2, Credential = Credential.Jwt("a") },
        ["ELSEWHERE on a failure"] = new FailureHeader { CallId = 2, Credential = Credential.Elsewhere() },
        ["a scheme to come on a result"] =
            new ResultHeader { CallId = 2, Credential = Credential.Of((CredentialScheme)4, []) },
        ["a JWT of no character"] =
            new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Credential = Credential.Jwt("") },
        ["a JWT of a character past U+00FF"] =
            new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Credential = Credential.Jwt("aĀ") },
        ["a JWT of 1,005 characters"] =
            new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Credential = Credential.Jwt(new string('a', 1_005)) },
    };

    // definition

    /// <summary>The names of every vector of the <c>headers</c> group.</summary>
    public static TheoryData<string> Headers { get; } = Vectors.NamesOf("headers");

    /// <summary>The names of every vector of the <c>reads</c> group.</summary>
    public static TheoryData<string> Reads { get; } = Vectors.NamesOf("reads");

    /// <summary>The names of every vector of the <c>prefixes</c> group.</summary>
    public static TheoryData<string> Prefixes { get; } = Vectors.NamesOf("prefixes");

    /// <summary>The names of every vector of the <c>prefixRefusals</c> group.</summary>
    public static TheoryData<string> PrefixRefusals { get; } = Vectors.NamesOf("prefixRefusals");

    /// <summary>The names of every vector of the <c>headerRefusals</c> group.</summary>
    public static TheoryData<string> HeaderRefusals { get; } = Vectors.NamesOf("headerRefusals");

    /// <summary>The names of the headers a writer refuses for a field.</summary>
    public static TheoryData<string> UnwritableNames { get; } = new(Unwritable.Keys);

    /// <summary>The names of the headers a writer refuses for their credential.</summary>
    public static TheoryData<string> UnwritableCredentialNames { get; } = new(UnwritableCredentials.Keys);

    [Theory]
    [MemberData(nameof(Headers))]
    public void Reads_a_header_and_writes_it_back(string name)
    {
        var vector = Vectors.Of("headers", name);
        var bytes = Vectors.BytesOf(vector, "bytes");
        var expected = Vectors.HeaderOf(vector.GetProperty("header"));
        var written = new byte[bytes.Length];

        Assert.Equal((expected, bytes.Length), EnvelopeCodec.ReadHeader(bytes, RouterSide.Server));
        Assert.Equal(bytes.Length, EnvelopeCodec.HeaderBytesOf(expected));
        Assert.Equal(bytes.Length, EnvelopeCodec.WriteHeader(expected, written));
        Assert.Equal(bytes, written);
    }

    [Theory]
    [MemberData(nameof(Reads))]
    public void Reads_what_a_writer_need_not_write(string name)
    {
        var vector = Vectors.Of("reads", name);
        var bytes = Vectors.BytesOf(vector, "bytes");
        var read = EnvelopeCodec.ReadHeader(bytes, Vectors.SideOf(vector));
        var header = vector.GetProperty("header");

        if (header.ValueKind == System.Text.Json.JsonValueKind.Null)
        {
            Assert.Null(read);
        }
        else
        {
            Assert.Equal(Vectors.HeaderOf(header), read?.Header);
        }
    }

    [Theory]
    [MemberData(nameof(Prefixes))]
    public void Reads_the_prefix_of_any_layout(string name)
    {
        var vector = Vectors.Of("prefixes", name);
        var prefix = vector.GetProperty("prefix");

        Assert.Equal(
            new EnvelopePrefix(
                prefix.GetProperty("callId").GetUInt32(),
                prefix.GetProperty("kind").GetByte(),
                prefix.GetProperty("layout").GetByte()),
            EnvelopeCodec.ReadPrefix(Vectors.BytesOf(vector, "bytes"), RouterSide.Client));
    }

    [Theory]
    [MemberData(nameof(PrefixRefusals))]
    public void Refuses_a_prefix(string name)
    {
        var vector = Vectors.Of("prefixRefusals", name);
        var bytes = Vectors.BytesOf(vector, "bytes");
        var failure = Assert.Throws<FailureException>(() =>
        {
            EnvelopeCodec.ReadPrefix(bytes, RouterSide.Client);
        });

        Assert.Equal(vector.GetProperty("code").GetUInt16(), failure.Code);
        Assert.Equal(RouterSide.Client, failure.Side);
    }

    [Theory]
    [MemberData(nameof(PrefixRefusals))]
    [MemberData(nameof(HeaderRefusals))]
    public void Refuses_a_header(string name)
    {
        var group = PrefixRefusals.Any((row) =>
        {
            return row.Data == name;
        })
            ? "prefixRefusals"
            : "headerRefusals";
        var vector = Vectors.Of(group, name);
        var bytes = Vectors.BytesOf(vector, "bytes");
        var failure = Assert.Throws<FailureException>(() =>
        {
            EnvelopeCodec.ReadHeader(bytes, RouterSide.Server);
        });

        Assert.Equal(vector.GetProperty("code").GetUInt16(), failure.Code);
        Assert.Equal(FailureScope.Protocol, failure.Scope);
        Assert.Equal(FailureOrigin.Local, failure.Origin);
        Assert.Equal(RouterSide.Server, failure.Side);

        if (vector.TryGetProperty("detail", out var detail))
        {
            Assert.Equal(detail.GetString(), failure.Detail);
        }
    }

    [Fact]
    public void Raises_its_failures_as_the_side_it_is_given()
    {
        var bytes = Vectors.FromHexadecimal("A1 11 00 02  00 00 00 00");

        Assert.Equal(
            RouterSide.Client,
            Assert.Throws<FailureException>(() =>
            {
                EnvelopeCodec.ReadHeader(bytes, RouterSide.Client);
            }).Side);
    }

    [Theory]
    [MemberData(nameof(UnwritableNames))]
    public void Refuses_to_write_a_header_and_writes_nothing(string name)
    {
        // room for any header, so what is refused is the header, never the room
        var written = new byte[1_024];

        Assert.ThrowsAny<ArgumentException>(() =>
        {
            EnvelopeCodec.WriteHeader(Unwritable[name], written);
        });
        Assert.All(written, (value) =>
        {
            Assert.Equal(0, value);
        });
    }

    // a platform's shape: what the TypeScript twin refuses besides, given by a caller without types,
    // no value here holds. A token that is no session token's 16 bytes: SessionToken.Parse refuses
    // it. Bytes beside ELSEWHERE: Credential.Of refuses a scheme from 0 to 3, its init accessors
    // private. A scheme to come without its bytes: a ReadOnlyMemory<byte> is empty at the least, and
    // empty is a scheme to come's. A scheme past 65535, or no integer: CredentialScheme is a ushort.
    // No credential at all, null: a Credential? of null is no block, the TypeScript side's undefined
    [Theory]
    [MemberData(nameof(UnwritableCredentialNames))]
    public void Refuses_a_credential_its_kind_does_not_take_or_its_scheme_does_not_hold(string name)
    {
        // room for any header, so what is refused is the header, never the room
        var written = new byte[1_024];
        var header = UnwritableCredentials[name];

        Assert.Throws<ArgumentException>(() =>
        {
            EnvelopeCodec.WriteHeader(header, written);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            EnvelopeCodec.HeaderBytesOf(header);
        });
        Assert.All(written, (value) =>
        {
            Assert.Equal(0, value);
        });
    }

    [Fact]
    public void Refuses_to_write_past_the_bytes_it_is_given()
    {
        var header = new RequestHeader { CallId = 3, ServiceId = 2, ProcedureId = 1, Credential = Token };

        Assert.Throws<ArgumentException>(() =>
        {
            EnvelopeCodec.WriteHeader(header, new byte[31]);
        });
    }

    [Fact]
    public void Writes_a_session_announced_as_the_token_it_was_given()
    {
        var written = new byte[28];

        EnvelopeCodec.WriteHeader(new FailureHeader { CallId = 3, Credential = Token }, written);

        Assert.Equal(
            Vectors.FromHexadecimal("A1 12 08 07  00 00 00 03  00 01 00 10  00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F"),
            written);
    }

    [Fact]
    public void Reads_a_JWT_byte_0xE9_as_U00E9_and_writes_it_back_as_the_same_byte()
    {
        var bytes = Vectors.FromHexadecimal("A1 10 08 05  00 00 00 03  00 02 00 01  00 02 00 01  E9 00 00 00");
        IEnvelopeHeader header = new RequestHeader { CallId = 3, ServiceId = 2, ProcedureId = 1, Credential = Credential.Jwt("é") };
        var written = new byte[bytes.Length];

        Assert.Equal((header, bytes.Length), EnvelopeCodec.ReadHeader(bytes, RouterSide.Server));
        Assert.Equal(bytes.Length, EnvelopeCodec.WriteHeader(header, written));
        Assert.Equal(bytes, written);
    }

    [Fact]
    public void Writes_the_padding_over_whatever_the_bytes_held()
    {
        var written = Enumerable.Repeat((byte)0xFF, 20).ToArray();

        EnvelopeCodec.WriteHeader(
            new RequestHeader { CallId = 3, ServiceId = 2, ProcedureId = 1, Credential = Credential.Jwt("a") },
            written);

        Assert.Equal(
            Vectors.FromHexadecimal("A1 10 08 05  00 00 00 03  00 02 00 01  00 02 00 01  61 00 00 00"),
            written);
    }

    [Fact]
    public void Refuses_a_header_of_no_kind_it_writes()
    {
        Assert.Throws<ArgumentException>(() =>
        {
            EnvelopeCodec.HeaderBytesOf(new Stranger());
        });
    }

    // a header of no kind this layout writes, which only a caller outside the assembly makes
    private sealed class Stranger : IEnvelopeHeader
    {
        public uint CallId
        {
            get
            {
                return 3;
            }
        }

        public EnvelopeKind Kind
        {
            get
            {
                return (EnvelopeKind)0x17;
            }
        }
    }
}
