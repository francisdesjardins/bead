using System.Security.Cryptography;
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

    // the names of an object read, in the order it holds them
    private static string[] NamesOf(string json)
    {
        return [.. Payloads.ReadJson(Encoding.UTF8.GetBytes(json)).EnumerateObject().Select((member) =>
        {
            return member.Name;
        })];
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
    public void Reads_a_name_that_holds_an_escape_as_its_escapes_say_whatever_an_object_of_its_shape_held_before()
    {
        // * the TypeScript twin's shape, its first name drawn for this run: V8's JSON.parse can read
        // the second name as an earlier object's, each of two characters once read, the first
        // holding a backslash
        var drawn = $"onTheLedge{Convert.ToHexString(RandomNumberGenerator.GetBytes(8))}";

        Assert.Equal([drawn, "q\\"], NamesOf($$"""{"{{drawn}}":1,"q\\":1}"""));
        Assert.Equal([drawn, "q\""], NamesOf($$"""{"{{drawn}}":2,"q\"":2}"""));
        Assert.Equal([drawn, "q\""], NamesOf($$"""{"{{drawn}}":3,"\u0071\"":3}"""));
    }

    [Fact]
    public void Hands_on_the_document_it_read_when_canonical_and_the_canonical_form_s_otherwise()
    {
        Assert.Equal("{\"a\":1,\"b\":[-1.5,\"x\"]}", Payloads.ReadJson("{\"a\":1,\"b\":[-1.5,\"x\"]}"u8.ToArray()).GetRawText());
        Assert.Equal("1", Payloads.ReadJson("1.0"u8.ToArray()).GetRawText());
        Assert.Equal("0", Payloads.ReadJson("-0"u8.ToArray()).GetRawText());
        Assert.Equal("[0,{\"a\":0}]", Payloads.ReadJson("[-0,{\"a\":-0}]"u8.ToArray()).GetRawText());
        Assert.Equal("12345678901234567000", Payloads.ReadJson("12345678901234567890"u8.ToArray()).GetRawText());
        Assert.Equal(1, Payloads.ReadJson("1.0"u8.ToArray()).GetInt32());

        // a name that holds an escape, __proto__ among them, read as its escapes say and written in
        // its place among the canonical form's names
        var escaped = """{"__prot\u006f__":{"a":[1,-0,1E2,"\n",true,null]},"2":false,"1":0}""";

        Assert.Equal(["1", "2", "__proto__"], NamesOf(escaped));
        Assert.Equal(
            """{"1":0,"2":false,"__proto__":{"a":[1,0,100,"\n",true,null]}}""",
            Payloads.ReadJson(Encoding.UTF8.GetBytes(escaped)).GetRawText());
    }

    [Fact]
    public void Writes_a_string_as_written_when_it_holds_no_escape_and_is_UTF_8_and_from_its_characters_otherwise()
    {
        // * the first as its bytes are, the second its escapes read; the third holds a byte that is
        // not UTF-8, which .NET's reader takes, and is refused as its characters are read
        using var document = JsonDocument.Parse(Convert.FromHexString("5b22c3a93c7f222c225c75303034315c7530303365222c22ff225d"));

        Assert.Equal("22C3A93C7F22", Convert.ToHexString(Payloads.WriteJson(document.RootElement[0]).Span));
        Assert.Equal("22413E22", Convert.ToHexString(Payloads.WriteJson(document.RootElement[1]).Span));
        Assert.Equal("a json value holds a surrogate alone", RefusalOf(() =>
        {
            return Payloads.WriteJson(document.RootElement[2]);
        }));
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
