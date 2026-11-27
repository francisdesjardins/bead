using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="Payloads"/>: what <c>spec/codecs.json</c> leaves to the twins — each refusal's reason,
/// in spec 17.2's words, and what its inner exception holds; a reader that refuses past 64 before it
/// builds anything deeper; and
/// what a <see cref="JsonElement"/> an application builds holds before the codec sees it, which
/// the support matrix's row "A value a side's type cannot hold" names.
/// </summary>
public sealed class PayloadsTests
{
    [Fact]
    public void Refuses_non_finite_numbers_in_each_JSON_number_formatter()
    {
        foreach (var value in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
        {
            Assert.Equal("not a finite number", RefusalOf(() => { return Payloads.NumberText(value); }));
        }
        foreach (var value in new[] { float.NaN, float.PositiveInfinity, float.NegativeInfinity })
        {
            Assert.Equal("not a finite number", RefusalOf(() => { return Payloads.NumberText(value); }));
        }
    }

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

    [Fact]
    public void Builds_a_payload_whose_name_holds_an_escape_as_JSON_parse_builds_one_a_member_named_proto_its_own()
    {
        var text = """{"__prot\u006f__":{"a":[1,-0,1E2,"\n",true,null]},"2":false,"1":0}""";
        var read = PayloadCodecs.Json.Decode(Encoding.UTF8.GetBytes(text));

        Assert.True(read.TryGetProperty("__proto__", out _));
        Assert.Equal(["1", "2", "__proto__"], NamesOf(text));
        Assert.Equal(
            """{"1":0,"2":false,"__proto__":{"a":[1,0,100,"\n",true,null]}}""",
            Encoding.UTF8.GetString(PayloadCodecs.Json.Encode(read).Span));
    }

    [Fact]
    public void Writes_an_object_of_no_prototype_and_a_member_named_proto_as_a_member()
    {
        var value = JsonElement.Parse("""{"b":true,"__proto__":"x"}""");

        Assert.Equal("""{"__proto__":"x","b":true}""", Encoding.UTF8.GetString(PayloadCodecs.Json.Encode(value).Span));
    }

    [Fact]
    public void Refuses_a_value_nested_deeper_than_64_a_cycle_among_them()
    {
        foreach (var depth in new[] { 64, 65 })
        {
            var text = new string('[', depth) + "1" + new string(']', depth);
            using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 65 });

            if (depth == 64)
            {
                Assert.Equal(text, Encoding.UTF8.GetString(PayloadCodecs.Json.Encode(document.RootElement).Span));
            }
            else
            {
                Assert.Equal("nested past 64", RefusalOf(() =>
                {
                    return PayloadCodecs.Json.Encode(document.RootElement);
                }));
            }
        }
    }


    [Fact]
    public void Refuses_a_string_never_closed_as_not_JSON_its_scan_bounded_by_the_text()
    {
        Assert.Equal("not JSON", RefusalOf(() =>
        {
            return Payloads.ReadJson(Encoding.UTF8.GetBytes("\"" + new string('x', 1_000)));
        }));
    }

    [Fact]
    public void Writes_each_objects_names_sorted_by_their_UTF_16_code_units_an_array_indexs_among_them()
    {
        foreach (var (text, expected) in new[]
        {
            ("{\"b\":1,\"10\":2,\"9\":3,\"1a\":4}", "{\"10\":2,\"1a\":4,\"9\":3,\"b\":1}"),
            ("{\"z\":[{\"b\":1,\"a\":2}],\"a\":null}", "{\"a\":null,\"z\":[{\"a\":2,\"b\":1}]}"),
        })
        {
            using var document = JsonDocument.Parse(text);

            Assert.Equal(expected, Encoding.UTF8.GetString(Payloads.WriteJson(document.RootElement).Span));
        }
    }

    [Fact]
    public void Reads_UTF_8_strictly_a_leading_U_FEFF_kept_and_writes_a_string()
    {
        Assert.Equal("not UTF-8", RefusalOf(() =>
        {
            return PayloadCodecs.Text.Decode(new byte[] { 0xC3 });
        }));
        Assert.Equal("\uFEFF1", PayloadCodecs.Text.Decode(new byte[] { 0xEF, 0xBB, 0xBF, 0x31 }));
        Assert.Equal(new byte[] { 0x6F, 0x6B }, PayloadCodecs.Text.Encode("ok").ToArray());
    }

    [Fact]
    public void Tells_whether_each_object_names_each_member_once_by_a_well_formed_name_its_escapes_read()
    {
        foreach (var (text, held) in new[]
        {
            ("[{\"a\":1},{\"a\":{\"a\":2}},\"a\",\"a\"]", true),
            ("{\"a\":1,\"b\":{\"c\":1,\"c\":2}}", false),
            ("{\"a\":1,\"\\u0061\":2}", false),
            ("{\"\\ud800\":1}", false),
        })
        {
            var refusal = Record.Exception(() =>
            {
                PayloadCodecs.Json.Decode(Encoding.UTF8.GetBytes(text));
            });

            Assert.Equal(held, refusal is null);
            if (!held)
            {
                Assert.IsType<FormatException>(refusal);
            }
        }
    }

    [Fact]
    public void Reads_0_as_0_at_every_depth_and_a_member_named_proto_as_a_member()
    {
        var read = PayloadCodecs.Json.Decode("[-0,{\"a\":-0}]"u8.ToArray());

        Assert.Equal(0, BitConverter.DoubleToInt64Bits(read[0].GetDouble()));
        Assert.Equal(0, BitConverter.DoubleToInt64Bits(read[1].GetProperty("a").GetDouble()));

        var member = PayloadCodecs.Json.Decode("{\"__proto__\":{\"a\":1},\"b\":2}"u8.ToArray());

        Assert.True(member.TryGetProperty("__proto__", out _));
        Assert.Equal("{\"__proto__\":{\"a\":1},\"b\":2}", Encoding.UTF8.GetString(PayloadCodecs.Json.Encode(member).Span));
    }

    /// <summary>Bytes a json reader refuses, in hexadecimal, and the reason it refuses them for (spec 17.2).</summary>
    public static TheoryData<string, string> Unread { get; } = new()
    {
        { "22ff22", "not UTF-8" },
        { "efbbbf31", "a byte order mark" },
        { "", "not JSON" },
        { "5b312c5d", "not JSON" },
        { "7b2261223a312c2261223a327d", "a name twice" },
        { "22616263", "not JSON" },
        { "225c756438303022", "a surrogate alone" },
        { "7b225c7564633030223a317d", "a surrogate alone" },
        { "3145343030", "a number past a double" },
        { Convert.ToHexString(Encoding.ASCII.GetBytes(new string('[', 65) + new string(']', 65))), "nested past 64" },
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

        Assert.Equal("a surrogate alone", RefusalOf(() =>
        {
            return Payloads.WriteJson(JsonElement.Parse("\"a\\ud800b\""));
        }));
        Assert.Equal("a surrogate alone", RefusalOf(() =>
        {
            return Payloads.WriteJson(JsonElement.Parse("{\"a\\ud800b\":1}"));
        }));
        Assert.Equal("a name twice", RefusalOf(() =>
        {
            return Payloads.WriteJson(JsonElement.Parse("{\"b\":1,\"a\":2,\"b\":3}"));
        }));
        Assert.Equal("nested past 64", RefusalOf(() =>
        {
            return Payloads.WriteJson(deep.RootElement);
        }));

        // * what the value is, in its inner exception
        var undefined = Assert.Throws<FormatException>(() =>
        {
            return Payloads.WriteJson(default);
        });

        Assert.Equal("no JSON value", undefined.Message);
        Assert.Equal("a json value of kind Undefined is no JSON value", undefined.InnerException?.Message);
        Assert.Equal("not UTF-8", RefusalOf(() =>
        {
            return Payloads.ReadText(new byte[] { 0xC3 });
        }));
        Assert.Equal("a surrogate alone", RefusalOf(() =>
        {
            return Payloads.WriteText("a\ud800b");
        }));
    }

    [Fact]
    public void Refuses_a_number_past_the_largest_double_that_an_element_parsed_leniently_holds_as_it_is_written()
    {
        using var document = JsonDocument.Parse("[1E400]");

        Assert.Equal("not a finite number", RefusalOf(() =>
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

        Assert.Equal("nested past 64", refusal.Message);
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
    public void Normalizes_negative_zero_before_a_JSON_payload_is_given_to_its_type()
    {
        // * this side's type is the JsonElement read: each spelling of -0 reaches it as 0
        foreach (var text in new[] { "-0", "-0.0", "-0e0" })
        {
            var read = PayloadCodecs.Json.Decode(Encoding.UTF8.GetBytes(text));

            Assert.Equal("0", read.GetRawText());
            Assert.Equal(BitConverter.DoubleToInt64Bits(0.0), BitConverter.DoubleToInt64Bits(read.GetDouble()));
            Assert.Equal(0, read.GetInt64());
        }

        var array = PayloadCodecs.Json.Decode("[-0,-0.0,-0e0]"u8.ToArray());

        Assert.Equal("[0,0,0]", array.GetRawText());
        Assert.All(array.EnumerateArray(), (value) =>
        {
            Assert.Equal(BitConverter.DoubleToInt64Bits(0.0), BitConverter.DoubleToInt64Bits(value.GetDouble()));
        });
    }

    [Fact]
    public void Writes_a_string_as_written_when_it_holds_no_escape_and_is_UTF_8_and_from_its_characters_otherwise()
    {
        // * the first as its bytes are, the second its escapes read; the third holds a byte that is
        // not UTF-8, which .NET's reader takes, and is refused as its characters are read
        using var document = JsonDocument.Parse(Convert.FromHexString("5b22c3a93c7f222c225c75303034315c7530303365222c22ff225d"));

        Assert.Equal("22C3A93C7F22", Convert.ToHexString(Payloads.WriteJson(document.RootElement[0]).Span));
        Assert.Equal("22413E22", Convert.ToHexString(Payloads.WriteJson(document.RootElement[1]).Span));
        Assert.Equal("a surrogate alone", RefusalOf(() =>
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
    [Fact]
    public void Writes_a_json_value_in_its_canonical_form_and_a_type_through_it()
    {
        var value = JsonElement.Parse("""{"b":1,"a":[true,null,"x"]}""");
        var written = PayloadCodecs.Json.Encode(value);

        Assert.Equal("""{"a":[true,null,"x"],"b":1}""", Encoding.UTF8.GetString(written.Span));
        Assert.Equal("""{"a":[true,null,"x"],"b":1}""", PayloadCodecs.Json.Decode(written).GetRawText());

        var reading = new Reading { Name = "t", Value = 0.5 };
        var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        var encoded = PayloadCodecs.Json.Encode(JsonSerializer.SerializeToElement(reading, options));

        Assert.Equal("""{"name":"t","value":0.5}""", Encoding.UTF8.GetString(encoded.Span));
        Assert.Equal(reading, PayloadCodecs.Json.Decode(encoded).Deserialize<Reading>(options));
    }

    private sealed record Reading
    {
        public required string Name { get; init; }

        public required double Value { get; init; }
    }

    [Fact]
    public void Refuses_what_it_does_not_read_each_in_its_own_words_with_a_syntax_error()
    {
        (byte[] Bytes, string Words)[] cases =
        [
            ([0x22, 0xff, 0x22], "not UTF-8"),
            ([0xef, 0xbb, 0xbf, 0x31], "a byte order mark"),
            (Encoding.UTF8.GetBytes(new string('[', 65) + new string(']', 65)), "nested past 64"),
            ("""{"a":1,"a":2}"""u8.ToArray(), "a name twice"),
            ("\"\\ud800\""u8.ToArray(), "a surrogate alone"),
            ("{\"\\udc00\":1}"u8.ToArray(), "a surrogate alone"),
            ("1E400"u8.ToArray(), "a number past a double"),
        ];

        foreach (var (bytes, words) in cases)
        {
            Assert.Equal(words, RefusalOf(() =>
            {
                return PayloadCodecs.Json.Decode(bytes);
            }));
        }

        foreach (var text in new[] { "", "[1,]" })
        {
            var refused = Assert.Throws<FormatException>(() =>
            {
                return PayloadCodecs.Json.Decode(Encoding.UTF8.GetBytes(text));
            });

            Assert.Equal("not JSON", refused.Message);
            Assert.IsAssignableFrom<JsonException>(refused.InnerException);
        }
    }

    [Fact]
    public void Refuses_what_json_has_no_value_for_each_in_its_own_words_with_a_type_error()
    {
        Assert.Equal("no JSON value", RefusalOf(() =>
        {
            return PayloadCodecs.Json.Encode(default);
        }));

        foreach (var text in new[] { "1E400", "[-1E400]" })
        {
            Assert.Equal("not a finite number", RefusalOf(() =>
            {
                return PayloadCodecs.Json.Encode(JsonElement.Parse(text));
            }));
        }
    }

    [Fact]
    public void Refuses_what_does_not_write_within_an_object_one_of_whose_names_may_be_an_array_index()
    {
        Assert.Equal("not a finite number", RefusalOf(() =>
        {
            return PayloadCodecs.Json.Encode(JsonElement.Parse("""{"1":1E400}"""));
        }));
    }

}
