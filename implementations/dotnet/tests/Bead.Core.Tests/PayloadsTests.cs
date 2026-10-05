using System.Text;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="Payloads"/>: what <c>spec/codecs.json</c> leaves to the twins — the words of each
/// refusal, this side's own; a reader that refuses past 64 before it builds anything deeper; and
/// what a <see cref="JsonElement"/> an application builds holds before the codec sees it, which
/// the support matrix's row "A value a side's type cannot hold" names.
/// </summary>
public sealed class PayloadsTests
{
    // constants

    private static readonly TimeSpan Second = TimeSpan.FromSeconds(1);

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static string RefusalOf(Func<object> coding)
    {
        return Assert.Throws<FormatException>(coding).Message;
    }

    // definition

    /// <summary>Bytes a json reader refuses, in hexadecimal, and the words it refuses them with.</summary>
    public static TheoryData<string, string> Unread { get; } = new()
    {
        { "22ff22", "a json payload is not UTF-8" },
        { "efbbbf31", "a json payload starts with a byte order mark" },
        { "", "a json payload is not one JSON text" },
        { "5b312c5d", "a json payload is not one JSON text" },
        { "7b2261223a312c2261223a327d", "a json payload names a member twice" },
        { "22616263", "a json payload is not one JSON text" },
        { "225c756438303022", "a json payload holds a surrogate alone" },
        { "7b225c7564633030223a317d", "a json payload holds a surrogate alone" },
        { "3145343030", "a json payload holds a number past the largest double" },
        { Convert.ToHexString(Encoding.ASCII.GetBytes(new string('[', 65) + new string(']', 65))), "a json payload nests deeper than 64" },
    };

    [Theory]
    [MemberData(nameof(Unread))]
    public void Refuses_what_a_json_payload_does_not_read_in_its_own_words(string read, string words)
    {
        Assert.Equal(words, RefusalOf(() =>
        {
            return Payloads.ReadJson(Convert.FromHexString(read));
        }));
    }

    [Fact]
    public void Refuses_a_json_value_that_does_not_write_and_a_text_either_way_in_its_own_words()
    {
        using var deep = JsonDocument.Parse(new string('[', 65) + new string(']', 65), new JsonDocumentOptions { MaxDepth = 65 });

        Assert.Equal("a json value holds a surrogate alone", RefusalOf(() =>
        {
            return Payloads.WriteJson(JsonElement.Parse("\"a\\ud800b\""));
        }));
        Assert.Equal("a json value holds a surrogate alone", RefusalOf(() =>
        {
            return Payloads.WriteJson(JsonElement.Parse("{\"a\\ud800b\":1}"));
        }));
        Assert.Equal("a json value names a member twice", RefusalOf(() =>
        {
            return Payloads.WriteJson(JsonElement.Parse("{\"b\":1,\"a\":2,\"b\":3}"));
        }));
        Assert.Equal("a json value nests deeper than 64", RefusalOf(() =>
        {
            return Payloads.WriteJson(deep.RootElement);
        }));
        Assert.Equal("a json value of kind Undefined is no JSON value", RefusalOf(() =>
        {
            return Payloads.WriteJson(default);
        }));
        Assert.Equal("a text payload is not UTF-8", RefusalOf(() =>
        {
            return Payloads.ReadText(new byte[] { 0xC3 });
        }));
        Assert.Equal("a text value holds a surrogate alone", RefusalOf(() =>
        {
            return Payloads.WriteText("a\ud800b");
        }));
    }

    [Fact]
    public void Refuses_a_number_past_the_largest_double_that_an_element_parsed_leniently_holds_as_it_is_written()
    {
        using var document = JsonDocument.Parse("[1E400]");

        Assert.Equal("a json value holds a number that is not finite", RefusalOf(() =>
        {
            return Payloads.WriteJson(document.RootElement);
        }));
    }

    [Fact]
    public void Writes_an_integer_past_2_to_the_53_from_its_digits_as_the_double_nearest_them()
    {
        Assert.Equal("9007199254740992", Encoding.UTF8.GetString(Payloads.WriteJson(JsonSerializer.SerializeToElement(9007199254740993L)).Span));
    }

    [Fact]
    public async Task Refuses_16_MiB_of_nested_arrays_within_a_second_building_nothing_past_64()
    {
        var half = 8 * 1024 * 1024;
        var payload = new byte[2 * half];

        payload.AsSpan(0, half).Fill((byte)'[');
        payload.AsSpan(half).Fill((byte)']');

        var refusal = await Assert.ThrowsAsync<FormatException>(() =>
        {
            return Task.Run(() =>
            {
                return Payloads.ReadJson(payload);
            }).WaitAsync(Second, Cancelled);
        });

        Assert.Equal("a json payload nests deeper than 64", refusal.Message);
    }

    [Fact]
    public void Hands_on_the_document_it_read_when_canonical_and_the_canonical_form_s_otherwise()
    {
        Assert.Equal("{\"a\":1,\"b\":[-1.5,\"x\"]}", Payloads.ReadJson("{\"a\":1,\"b\":[-1.5,\"x\"]}"u8.ToArray()).GetRawText());
        Assert.Equal("1", Payloads.ReadJson("1.0"u8.ToArray()).GetRawText());
        Assert.Equal("0", Payloads.ReadJson("-0"u8.ToArray()).GetRawText());
        Assert.Equal("12345678901234567000", Payloads.ReadJson("12345678901234567890"u8.ToArray()).GetRawText());
        Assert.Equal(1, Payloads.ReadJson("1.0"u8.ToArray()).GetInt32());
    }

    [Fact]
    public void Is_given_by_JsonSerializer_no_NaN_and_no_infinity_and_a_surrogate_alone_as_U_FFFD_before_it_writes()
    {
        // * what the support matrix's row says of this side: its type holds no number JSON has not,
        // and its serializer replaces a surrogate alone before the codec could refuse it
        foreach (var given in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return JsonSerializer.SerializeToElement(given);
            });
        }

        Assert.Equal("\"a\uFFFDb\"", Encoding.UTF8.GetString(Payloads.WriteJson(JsonSerializer.SerializeToElement("a\ud800b")).Span));
    }
}
