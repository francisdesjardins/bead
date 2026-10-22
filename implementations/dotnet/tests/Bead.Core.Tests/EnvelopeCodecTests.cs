using System.Text;

namespace Bead.Tests;

/// <summary>
/// <see cref="EnvelopeCodec"/>'s envelopes and failure records, read and written: every vector of
/// <c>envelopes</c>, <c>envelopeRefusals</c>, <c>failures</c> and <c>failureRefusals</c>, then the
/// cuts a writer makes, which no vector holds.
/// </summary>
public sealed class EnvelopeCodecTests
{
    // constants

    // the bound the vectors are read within when they name none, as the TypeScript tests read them
    private static readonly EnvelopeReadOptions Options =
        new() { Side = RouterSide.Server, MaximumEnvelopeBytes = 64 };

    // helpers

    private static byte[] RecordOf(string detail)
    {
        return [0x00, 0x13, 0x00, 0x00, .. Encoding.UTF8.GetBytes(detail)];
    }

    // definition

    /// <summary>The names of every vector of the <c>envelopes</c> group.</summary>
    public static TheoryData<string> Envelopes { get; } = Vectors.NamesOf("envelopes");

    /// <summary>The names of every vector of the <c>envelopeRefusals</c> group.</summary>
    public static TheoryData<string> EnvelopeRefusals { get; } = Vectors.NamesOf("envelopeRefusals");

    /// <summary>The names of every vector of the <c>failures</c> group.</summary>
    public static TheoryData<string> Failures { get; } = Vectors.NamesOf("failures");

    /// <summary>The names of every vector of the <c>failureRefusals</c> group.</summary>
    public static TheoryData<string> FailureRefusals { get; } = Vectors.NamesOf("failureRefusals");

    [Theory]
    [MemberData(nameof(Envelopes))]
    public void Reads_an_envelope_and_writes_it_back(string name)
    {
        var vector = Vectors.Of("envelopes", name);
        var bytes = Vectors.BytesOf(vector, "bytes");
        var expected = vector.GetProperty("envelope");
        var payload = expected.TryGetProperty("payload", out var hexadecimal)
            ? Vectors.FromHexadecimal(hexadecimal.GetString()!)
            : [];
        var failure = expected.TryGetProperty("failure", out var record) ? Vectors.FailureOf(record) : null;
        var envelope = EnvelopeCodec.ReadEnvelope(bytes, Options);

        Assert.NotNull(envelope);
        Assert.Equal((EnvelopeKind)expected.GetProperty("kind").GetByte(), envelope.Kind);
        Assert.Equal(Vectors.HeaderOf(expected.GetProperty("header")), envelope.Header);
        Assert.Equal(payload, envelope.Payload.ToArray());
        Assert.Equal(failure, envelope.Failure);
        Assert.Equal(bytes, EnvelopeCodec.WriteEnvelope(envelope));
    }

    [Theory]
    [MemberData(nameof(EnvelopeRefusals))]
    public void Refuses_an_envelope(string name)
    {
        var vector = Vectors.Of("envelopeRefusals", name);
        var bytes = Vectors.BytesOf(vector, "bytes");
        var options = vector.TryGetProperty("maximumEnvelopeBytes", out var maximum)
            ? Options with { MaximumEnvelopeBytes = maximum.GetInt32() }
            : Options;
        var failure = Assert.Throws<FailureException>(() =>
        {
            EnvelopeCodec.ReadEnvelope(bytes, options);
        });

        Assert.Equal(vector.GetProperty("code").GetUInt16(), failure.Code);
        Assert.Equal(RouterSide.Server, failure.Side);

        if (vector.TryGetProperty("detail", out var detail))
        {
            Assert.Equal(detail.GetString(), failure.Detail);
        }
    }

    [Fact]
    public void Skips_an_advisory_envelope()
    {
        Assert.Null(EnvelopeCodec.ReadEnvelope(Vectors.FromHexadecimal("A1 80 00 02  00 00 00 03 | 01"), Options));
    }

    [Fact]
    public void Takes_an_envelope_of_the_largest_size_and_refuses_one_byte_more()
    {
        var exact = new byte[64];

        Vectors.FromHexadecimal("A1 11 00 02  00 00 00 03").CopyTo(exact, 0);

        Assert.Equal(EnvelopeKind.Result, EnvelopeCodec.ReadEnvelope(exact, Options)?.Kind);

        var larger = new byte[65];

        Vectors.FromHexadecimal("A1 11 00 02  00 00 00 03").CopyTo(larger, 0);

        var failure = Assert.Throws<FailureException>(() =>
        {
            EnvelopeCodec.ReadEnvelope(larger, Options);
        });

        Assert.Equal(((ushort)ProtocolCode.EnvelopeTooLarge, RouterSide.Server), (failure.Code, failure.Side));

        // what is not an envelope is malformed, however large
        larger[0] = 0x0A;

        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, Assert.Throws<FailureException>(() =>
        {
            EnvelopeCodec.ReadEnvelope(larger, Options);
        }).Code);
    }

    [Fact]
    public void Cuts_a_failure_s_detail_to_the_bytes_it_is_given_a_character_whole()
    {
        var bytes = EnvelopeCodec.WriteEnvelope(
            new Envelope
            {
                Header = new FailureHeader { CallId = 3 },
                Failure = new Failure { Code = 1, Detail = "abcdéf", Scope = FailureScope.Protocol },
            },
            5);

        Assert.Equal("abcd", EnvelopeCodec.ReadEnvelope(bytes, Options)?.Failure?.Detail);
    }

    [Fact]
    public void Copies_the_payload_out_of_the_bytes_it_read()
    {
        var bytes = Vectors.FromHexadecimal("A1 11 00 02  00 00 00 03 | 01 02");
        var envelope = EnvelopeCodec.ReadEnvelope(bytes, Options);

        bytes[8] = 0xFF;

        Assert.Equal(new byte[] { 0x01, 0x02 }, envelope!.Payload.ToArray());
    }

    [Theory]
    [MemberData(nameof(Failures))]
    public void Reads_a_failure(string name)
    {
        var vector = Vectors.Of("failures", name);
        var options = vector.TryGetProperty("maximumDetailBytes", out var maximum)
            ? Options with { MaximumDetailBytes = maximum.GetInt32() }
            : Options;

        Assert.Equal(
            Vectors.FailureOf(vector.GetProperty("failure")),
            EnvelopeCodec.ReadFailure(Vectors.BytesOf(vector, "record"), options));
    }

    [Theory]
    [MemberData(nameof(FailureRefusals))]
    public void Refuses_a_failure(string name)
    {
        var vector = Vectors.Of("failureRefusals", name);
        var record = Vectors.BytesOf(vector, "record");

        Assert.Equal(
            vector.GetProperty("code").GetUInt16(),
            Assert.Throws<FailureException>(() =>
            {
                EnvelopeCodec.ReadFailure(record, Options);
            }).Code);
    }

    [Fact]
    public void Cuts_a_long_detail_at_the_default_limit_back_to_the_start_of_the_character_cut()
    {
        var kept = $"{new string('a', 1_020)}😀";
        var cut = $"{new string('a', 1_021)}😀";

        Assert.Equal(new string('a', 1_024), EnvelopeCodec.ReadFailure(RecordOf(new string('a', 1_025)), Options).Detail);
        Assert.Equal(kept, EnvelopeCodec.ReadFailure(RecordOf(kept), Options).Detail);
        Assert.Equal(new string('a', 1_021), EnvelopeCodec.ReadFailure(RecordOf(cut), Options).Detail);
    }

    // spec 7.4
    [Fact]
    public void Cuts_the_detail_at_the_limit_at_a_character_s_boundary()
    {
        static string DetailOf(string detail)
        {
            var record = EnvelopeCodec.WriteFailure(new Failure { Code = 1, Detail = detail, Scope = FailureScope.Protocol });

            return Encoding.UTF8.GetString(record.AsSpan(4));
        }

        static string Letters(int count)
        {
            return new string('a', count);
        }

        Assert.Equal(1_024, LimitDefaults.MaximumDetailBytes);
        Assert.Equal(Letters(1_024), DetailOf(Letters(1_100)));
        Assert.Equal($"{Letters(1_022)}é", DetailOf($"{Letters(1_022)}é"));
        Assert.Equal(Letters(1_023), DetailOf($"{Letters(1_023)}é"));
        Assert.Equal(Letters(1_022), DetailOf($"{Letters(1_022)}€"));
        Assert.Equal(Letters(1_021), DetailOf($"{Letters(1_021)}😀"));
        Assert.Equal($"{Letters(1_020)}😀", DetailOf($"{Letters(1_020)}😀"));
        Assert.Equal("", DetailOf(""));
        Assert.Equal(
            Vectors.FromHexadecimal("00 01 00 00  61 62 63"),
            EnvelopeCodec.WriteFailure(new Failure { Code = 1, Detail = "abcdef", Scope = FailureScope.Protocol }, 3));
    }

    // spec 7.4
    [Fact]
    public void Writes_a_lone_surrogate_as_U_FFFD()
    {
        var record = EnvelopeCodec.WriteFailure(
            new Failure { Code = 19, Detail = "a\uD800b", Scope = FailureScope.Protocol });

        Assert.Equal(Vectors.FromHexadecimal("00 13 00 00  61 EF BF BD 62"), record);
    }

    [Fact]
    public void Writes_the_relays_and_the_scope_of_an_application_failure()
    {
        var record = EnvelopeCodec.WriteFailure(
            new Failure { Code = 21, Relays = 2, Scope = FailureScope.Application });

        Assert.Equal(Vectors.FromHexadecimal("00 15 02 01"), record);

        // the relays a failure crossed, from 0 to 255, which a byte holds alone; none by default
        foreach (var relays in new byte[] { 0, 1, 255 })
        {
            var crossed = EnvelopeCodec.WriteFailure(new Failure { Code = 19, Relays = relays, Scope = FailureScope.Protocol });

            Assert.Equal(relays, crossed[2]);
            Assert.Equal(relays, EnvelopeCodec.ReadFailure(crossed, Options).Relays);
        }

        Assert.Equal(0, EnvelopeCodec.WriteFailure(new Failure { Code = 19, Scope = FailureScope.Protocol })[2]);
    }

    [Fact]
    public void Refuses_to_write_a_failure_of_code_0_or_of_no_scope()
    {
        Assert.Throws<ArgumentException>(() =>
        {
            EnvelopeCodec.WriteFailure(new Failure { Code = 0, Scope = FailureScope.Protocol });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            EnvelopeCodec.WriteFailure(new Failure { Code = 19, Scope = (FailureScope)2 });
        });
        Assert.Equal(
            Vectors.FromHexadecimal("10 00 00 01"),
            EnvelopeCodec.WriteFailure(new Failure { Code = 0x1000, Scope = FailureScope.Application }));
        Assert.Equal(
            Vectors.FromHexadecimal("FF FF 00 00"),
            EnvelopeCodec.WriteFailure(new Failure { Code = 0xFFFF, Scope = FailureScope.Protocol }));
    }

    [Fact]
    public void Refuses_to_write_an_envelope_whose_body_is_not_its_kind_s()
    {
        Envelope[] envelopes =
        [
            new() { Header = new ChunkHeader { CallId = 7, Offset = 0, IsLast = true } },
            new() { Header = new FailureHeader { CallId = 3 } },
            new()
            {
                Header = new ResultHeader { CallId = 3 },
                Failure = new Failure { Code = 19, Scope = FailureScope.Protocol },
            },
            new() { Header = new CancelHeader { CallId = 5 }, Payload = new byte[] { 0x00 } },
        ];

        Assert.All(envelopes, (envelope) =>
        {
            Assert.Throws<ArgumentException>(() =>
            {
                EnvelopeCodec.WriteEnvelope(envelope);
            });
        });
    }
}
