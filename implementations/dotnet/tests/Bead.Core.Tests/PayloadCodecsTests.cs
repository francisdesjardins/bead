using System.Text;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="PayloadCodecs"/>: spec 17's codecs by their encoding's name, each the codec of the
/// internal payloads <c>spec/codecs.json</c> plays, and a codec made of two functions; the twins of
/// the TypeScript side's <c>payloads.test.ts</c> on <c>payloadCodecOf</c>.
/// </summary>
public sealed class PayloadCodecsTests
{
    [Fact]
    public void Gives_spec_17_s_codecs_by_their_encoding_s_name()
    {
        Assert.Equal([1, 2], PayloadCodecs.Raw.Encode(PayloadCodecs.Raw.Decode(new byte[] { 1, 2 })).ToArray());
        Assert.Equal("Josée", PayloadCodecs.Text.Decode("Josée"u8.ToArray()));
        Assert.Throws<FormatException>(() =>
        {
            return PayloadCodecs.Text.Decode(new byte[] { 0xFF });
        });
        Assert.Equal("{\"a\":1,\"b\":2}", Encoding.UTF8.GetString(PayloadCodecs.Json.Encode(JsonElement.Parse("{\"b\":2,\"a\":1}")).Span));
        Assert.Throws<FormatException>(() =>
        {
            return PayloadCodecs.Json.Decode("{\"a\":1,\"a\":2}"u8.ToArray());
        });
    }

    [Fact]
    public void Of_makes_a_codec_of_two_functions()
    {
        var codec = PayloadCodecs.Of(
            (bytes) =>
            {
                return bytes.Length;
            },
            (int length) =>
            {
                return new byte[length];
            });

        Assert.Equal(3, codec.Decode(new byte[3]));
        Assert.Equal(2, codec.Encode(2).Length);
    }

    [Fact]
    public void Of_refuses_a_function_missing()
    {
        Assert.Throws<ArgumentNullException>(() =>
        {
            return PayloadCodecs.Of<int>(null!, (length) =>
            {
                return new byte[length];
            });
        });
        Assert.Throws<ArgumentNullException>(() =>
        {
            return PayloadCodecs.Of((bytes) =>
            {
                return bytes.Length;
            }, null!);
        });
    }
}
