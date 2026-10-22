using System.Text;
using Bead.Transcoding.V1;
using Google.Protobuf;
using Google.Protobuf.WellKnownTypes;
using static Bead.Transcoding.Tests.TranscodingFile;

namespace Bead.Transcoding.Tests;

/// <summary>
/// <see cref="JsonForm"/>: Bead's own mapping of protobuf's JSON, a <c>proto</c> request's body read
/// by its message's descriptor and a result written in Bead's proto JSON form (transcoding 5). The
/// twins of the TypeScript side's <c>json-form.test.ts</c>.
/// </summary>
public sealed class JsonFormTests
{
    private static IMessage Read<TMessage>(string body)
        where TMessage : IMessage<TMessage>, new()
    {
        return Form.Read(new TMessage().Descriptor, Encoding.UTF8.GetBytes(body));
    }

    private static string Written(IMessage message)
    {
        return Encoding.UTF8.GetString(Form.Write(message));
    }

    private static void Refused<TMessage>(string body)
        where TMessage : IMessage<TMessage>, new()
    {
        Assert.Throws<JsonFormException>(() =>
        {
            Read<TMessage>(body);
        });
    }

    [Fact]
    public void Reads_a_proto_body_by_Bead_s_mapping_each_scalar_and_well_known_form_as_pinned()
    {
        // * a field by either name, a 64-bit integer exactly from its digits, base64 of either alphabet
        Assert.Equal(
            new Edges { AnInt32 = 100, AnInt64 = 9_007_199_254_740_993, SomeBytes = ByteString.CopyFrom(0x01, 0xFB), At = new Timestamp { Seconds = 1 } },
            Read<Edges>("{\"an_int32\":1e2,\"anInt64\":9007199254740993,\"someBytes\":\"Afs\",\"at\":\"1970-01-01T08:00:01+08:00\"}"));
        Assert.Equal(new Edges { Took = new Duration { Nanos = -500_000_000 }, Mask = new FieldMask { Paths = { "foo_bar", "f_o_o" } } }, Read<Edges>("{\"took\":\"-0.5s\",\"mask\":\"fooBar,fOO\"}"));
        Assert.Equal(new Edges { NullMember = NullValue.NullValue }, Read<Edges>("{\"nullMember\":null}"));
        Assert.Equal(new Everything { ChoiceInner = new Inner() }, Read<Everything>("{\"choiceText\":null,\"choiceInner\":{}}"));

        // what the two stock libraries part on, refused on both sides
        Refused<Edges>("{\"anInt32\":1,\"anInt32\":2}");
        Refused<Edges>("{\"anInt32\":1,\"an_int32\":2}");
        Refused<Edges>("{\"anInt64\":\"1e3\"}");
        Refused<Edges>("{\"wrappedInt64\":\"1e3\"}");
        Refused<Edges>("{\"byInt32\":{\"01\":\"a\"}}");
        Refused<Edges>("{\"someBytes\":\"+_8=\"}");
        Refused<Edges>("{\"someBytes\":\"AQ=\"}");
        Refused<Edges>("{\"at\":\"2026-02-30T00:00:00Z\"}");
        Refused<Edges>("{\"took\":\"01s\"}");
        Refused<Edges>("{\"took\":\"1.0000000001s\"}");
        Refused<Edges>("{\"mask\":\"FooBar\"}");
        Refused<Edges>("{\"mask\":\"a,,b\"}");
        Refused<Edges>("{\"any\":{\"x\":1}}");
        Refused<Edges>("{\"nope\":1}");
        Refused<Everything>("{\"aBool\":\"true\"}");
    }

    [Fact]
    public void Counts_a_body_s_depth_by_its_message_a_Value_nested_past_100_refused_before_it_is_built()
    {
        static string Lists(int count, string inner)
        {
            return "{\"value\":" + new string('[', count) + inner + new string(']', count) + "}";
        }

        static string Children(int count)
        {
            return string.Concat(Enumerable.Repeat("{\"child\":", count)) + "{}" + new string('}', count);
        }

        // * a Value and its ListValue each a message: 50 arrays are 100 deep, a number in them 101
        Assert.IsType<Edges>(Read<Edges>(Lists(50, "")));
        Refused<Edges>(Lists(50, "1"));

        // a message 100 deep below the request, past the 64 of a json payload, is taken; 101 is not
        Assert.IsType<Edges>(Read<Edges>(Children(100)));
        Refused<Edges>(Children(101));

        // a repeated field's array counts nothing
        Assert.IsType<Edges>(Read<Edges>(string.Concat(Enumerable.Repeat("{\"children\":[", 80)) + "{}" + string.Concat(Enumerable.Repeat("]}", 80))));
    }

    [Fact]
    public void Writes_a_proto_result_in_Bead_s_proto_JSON_form_its_fields_by_number_its_maps_sorted_type_first()
    {
        var edges = new Edges
        {
            AnInt32 = 1,
            At = new Timestamp { Seconds = 1, Nanos = 1_000 },
            Labels = { ["b"] = 1, ["10"] = 2, ["a"] = 3, ["é"] = 4, ["Z"] = 5 },
            ByInt64 = { [10] = "x", [2] = "y", [-1] = "z" },
            Any = Any.Pack(new Duration { Seconds = 1 }),
            WrappedUint64 = ulong.MaxValue,
        };

        Assert.Equal(
            "{\"at\":\"1970-01-01T00:00:01.000001Z\",\"any\":{\"@type\":\"type.googleapis.com/google.protobuf.Duration\",\"value\":\"1s\"},\"wrappedUint64\":\"18446744073709551615\",\"byInt64\":{\"-1\":\"z\",\"10\":\"x\",\"2\":\"y\"},\"labels\":{\"10\":2,\"Z\":5,\"a\":3,\"b\":1,\"é\":4},\"anInt32\":1}",
            Written(edges));
        Assert.Equal("{\"any\":{\"@type\":\"type.googleapis.com/bead.transcoding.v1.Inner\",\"name\":\"a\",\"count\":2}}", Written(new Edges { Any = Any.Pack(new Inner { Name = "a", Count = 2 }) }));

        // 5.7: what Bead's proto JSON form holds none of is refused, a gateway's own 500
        Assert.Throws<JsonFormException>(() =>
        {
            Form.Write(new Edges { Value = Value.ForNumber(double.NaN) });
        });
        Assert.Throws<JsonFormException>(() =>
        {
            Form.Write(new Edges { Mask = new FieldMask { Paths = { "foo_" } } });
        });
    }

    [Fact]
    public void Refuses_a_value_its_field_s_type_holds_none_of_each_by_its_reason()
    {
        var parted = new List<string>();

        foreach (var (descriptor, body, words) in new (Google.Protobuf.Reflection.MessageDescriptor Descriptor, string Body, string Words)[]
        {
            (Edges.Descriptor, "{\"labels\":[]}", "a map that is no object"),
            (Edges.Descriptor, "{\"labels\":1}", "a map that is no object"),
            (Edges.Descriptor, "{\"anInt32\":\"0.5\"}", "an int32 that is no integer"),
            (Edges.Descriptor, "{\"anInt32\":1e30}", "an int32 past its range"),
            (Edges.Descriptor, "{\"extra\":1}", "a Struct that is no object"),
            (Edges.Descriptor, "{\"any\":{\"@type\":\"type.googleapis.com/google.protobuf.ListValue\",\"value\":1}}", "a ListValue that is no array"),
            (Edges.Descriptor, "{\"ints\":1}", "a repeated field that is no array"),
            (Edges.Descriptor, "{\"ints\":[null]}", "a null item"),
            (Edges.Descriptor, "{\"labels\":{\"a\":null}}", "a null value in a map"),
            (Edges.Descriptor, "{\"aliased\":1.5}", "an enum number that is no integer"),
            (Edges.Descriptor, "{\"aliased\":2147483648}", "an enum number past its range"),
            (Edges.Descriptor, "{\"aliased\":true}", "no Aliased"),
            (Edges.Descriptor, "{\"aliased\":\"NOPE\"}", "no value of Aliased of that name"),
            (Edges.Descriptor, "{\"aDouble\":\"abc\"}", "no double"),
            (Edges.Descriptor, "{\"aDouble\":true}", "no double"),
            (Edges.Descriptor, "{\"aDouble\":\"1e400\"}", "a double past its range"),
            (Edges.Descriptor, "{\"aFloat\":\"1e400\"}", "a float past its range"),
            (Edges.Descriptor, "{\"someBytes\":1}", "no bytes"),
            (Edges.Descriptor, "{\"someBytes\":\"AAAAA\"}", "bytes padded wrongly"),
            (Edges.Descriptor, "{\"byUint32\":{\"4294967296\":\"a\"}}", "a uint32 key past its range"),
            (Edges.Descriptor, "{\"byInt64\":{\"1\":\"a\",\"01\":\"b\"}}", "an int64 key off -?(0|[1-9][0-9]*)"),
            (Everything.Descriptor, "{\"flags\":{\"maybe\":\"a\"}}", "a bool key that is neither true nor false"),
            (Edges.Descriptor, "{\"anInt32\":1e41}", "an int32 past its range"),
            (Edges.Descriptor, "{\"anInt32\":1e-41}", "an int32 that is no integer"),
            (Edges.Descriptor, "{\"anInt32\":true}", "no int32"),
            (Everything.Descriptor, "{\"aUint64\":\"18446744073709551616\"}", "a uint64 past its range"),
            (Everything.Descriptor, "{\"aFixed64\":-1}", "a fixed64 past its range"),
            (Everything.Descriptor, "{\"aSint64\":\"1.5\"}", "an sint64 string off -?(0|[1-9][0-9]*)"),
            (Everything.Descriptor, "{\"aString\":1}", "no string"),
            (Edges.Descriptor, "{\"extra\":[]}", "a Struct that is no object"),
            (Everything.Descriptor, "{\"list\":{}}", "a ListValue that is no array"),
            (Edges.Descriptor, "{\"any\":1}", "an Any that is no object"),
            (Edges.Descriptor, "{\"any\":{\"@type\":1}}", "an Any whose @type is no URL"),
            (Edges.Descriptor, "{\"any\":{\"@type\":\"type.googleapis.com/bead.transcoding.v1.Nope\"}}", "an Any of a type its definitions do not hold"),
            (Edges.Descriptor, "{\"any\":{\"@type\":\"type.googleapis.com/google.protobuf.Duration\",\"seconds\":1}}", "an Any of a well-known type whose members are not its value alone"),
            (Edges.Descriptor, "{\"child\":1}", "a Edges that is no object"),
            (Edges.Descriptor, "{\"at\":1}", "a Timestamp that is no string"),
            (Edges.Descriptor, "{\"at\":\"yesterday\"}", "a Timestamp off RFC 3339"),
            (Edges.Descriptor, "{\"at\":\"2026-01-01T24:00:00Z\"}", "a Timestamp of no instant"),
            (Edges.Descriptor, "{\"at\":\"2026-04-31T00:00:00Z\"}", "a Timestamp of no instant"),
            (Edges.Descriptor, "{\"at\":\"1900-02-29T00:00:00Z\"}", "a Timestamp of no instant"),
            (Edges.Descriptor, "{\"at\":\"2026-01-01T00:00:00+24:00\"}", "a Timestamp of no offset"),
            (Edges.Descriptor, "{\"at\":\"0000-01-01T00:00:00Z\"}", "a Timestamp past its range"),
            (Edges.Descriptor, "{\"took\":1}", "a Duration off its form"),
            (Edges.Descriptor, "{\"took\":\"315576000001s\"}", "a Duration past its range"),
            (Edges.Descriptor, "{\"mask\":1}", "a FieldMask that is no string"),
        })
        {
            try
            {
                Form.Read(descriptor, Encoding.UTF8.GetBytes(body));
                parted.Add($"{body}: taken, where {words}");
            }
            catch (JsonFormException refused) when (refused.Message != words)
            {
                parted.Add($"{body}: {refused.Message}, where {words}");
            }
            catch (JsonFormException)
            {
                // refused in its own words
            }
        }

        Assert.Empty(parted);
    }

    [Fact]
    public void Refuses_a_text_that_is_no_JSON_a_string_left_open_or_wrongly_escaped_a_comma_or_a_colon_missing()
    {
        foreach (var text in new[] { "{\"a", "{\"a\":\"\\q\"}", "[1 2]", "{\"a\" 1}", "{\"a\":1 \"b\":2}" })
        {
            Assert.Equal("not JSON", Assert.Throws<JsonFormException>(() =>
            {
                JsonText.Read(Encoding.UTF8.GetBytes(text));
            }).Message);
        }

        Assert.Equal(JsonNodeKind.Object, JsonText.Read("{\"a\":[1,2],\"b\":{}}"u8).Kind);
    }

    [Fact]
    public void Reads_each_well_known_form_at_its_edges()
    {
        // * a leap day of a year that 400 divides, the earliest instant, an Empty, a Value of each kind
        Assert.Equal(new Edges { At = new Timestamp { Seconds = 951_782_400 } }, Read<Edges>("{\"at\":\"2000-02-29T00:00:00Z\"}"));
        Assert.Equal(new Edges { At = new Timestamp { Seconds = -62_135_596_800 } }, Read<Edges>("{\"at\":\"0001-01-01T00:00:00Z\"}"));
        Assert.Equal(new Edges { Nothing = new Empty() }, Read<Edges>("{\"nothing\":{}}"));
        Assert.Equal(new Edges { Value = Value.ForBool(false) }, Read<Edges>("{\"value\":false}"));
        Assert.Equal(new Edges { Value = Value.ForStruct(new Struct { Fields = { ["a"] = Value.ForList(Value.ForNull(), Value.ForString("b")) } }) }, Read<Edges>("{\"value\":{\"a\":[null,\"b\"]}}"));
        Assert.Equal(new Everything { List = new ListValue { Values = { Value.ForNumber(1) } }, WrappedBool = true, WrappedString = "" }, Read<Everything>("{\"list\":[1],\"wrappedBool\":true,\"wrappedString\":\"\"}"));

        // a map of each key's form, bytes of the URL-safe alphabet, the empty Any
        Assert.Equal(
            new Everything { Flags = { [true] = "t", [false] = "f" }, ById = { [-1] = "a" }, SomeBytes = ByteString.CopyFrom(0xFB, 0xFF) },
            Read<Everything>("{\"flags\":{\"true\":\"t\",\"false\":\"f\"},\"byId\":{\"-1\":\"a\"},\"someBytes\":\"-_8\"}"));
        Assert.Equal(new Edges { ByUint32 = { [4_294_967_295] = "a" } }, Read<Edges>("{\"byUint32\":{\"4294967295\":\"a\"}}"));
        Assert.Equal(new Edges { Any = new Any() }, Read<Edges>("{\"any\":{}}"));
    }

    [Fact]
    public void Reads_and_writes_an_Any_of_a_wrapper_by_its_value_and_a_wrapper_alone_as_its_scalar()
    {
        const string Packed = "{\"any\":{\"@type\":\"type.googleapis.com/google.protobuf.Int32Value\",\"value\":3}}";

        // * a wrapper in an Any under value, as its scalar
        Assert.Equal(new Edges { Any = Any.Pack(new Int32Value { Value = 3 }) }, Read<Edges>(Packed));
        Assert.Equal(Packed, Written(new Edges { Any = Any.Pack(new Int32Value { Value = 3 }) }));

        // a wrapper alone, read and written as its scalar, at its default too
        Assert.Equal(new Int32Value { Value = 3 }, Form.Read(Int32Value.Descriptor, "3"u8));
        Assert.Equal("3", Written(new Int32Value { Value = 3 }));
        Assert.Equal("\"a\"", Written(new StringValue { Value = "a" }));
        Assert.Equal("0", Written(new Int32Value()));
    }

    [Fact]
    public void Writes_each_kind_of_Value_and_a_Struct_within_a_Struct_in_its_own_form()
    {
        var inner = new Struct { Fields = { ["b"] = Value.ForNumber(1.5), ["a"] = Value.ForNull() } };
        var outer = new Struct
        {
            Fields =
            {
                ["s"] = Value.ForStruct(inner),
                ["l"] = Value.ForList(Value.ForString("x"), Value.ForBool(true), Value.ForBool(false)),
            },
        };

        // * each kind, a Struct's members sorted, one within another
        Assert.Equal("{\"value\":false}", Written(new Edges { Value = Value.ForBool(false) }));
        Assert.Equal("{\"value\":null}", Written(new Edges { Value = Value.ForNull() }));
        Assert.Equal("{\"extra\":{\"l\":[\"x\",true,false],\"s\":{\"a\":null,\"b\":1.5}}}", Written(new Edges { Extra = outer }));
        Assert.Equal("{\"value\":{\"a\":[null,\"b\",true]}}", Written(new Edges { Value = Value.ForStruct(new Struct { Fields = { ["a"] = Value.ForList(Value.ForNull(), Value.ForString("b"), Value.ForBool(true)) } }) }));

        // a Value of no kind, which its form holds none of
        Assert.Equal("a Value that holds no kind", Assert.Throws<JsonFormException>(() =>
        {
            Form.Write(new Edges { Value = new Value() });
        }).Message);
    }

    [Fact]
    public void Writes_a_message_nested_100_deep_and_refuses_one_nested_past_100()
    {
        static Edges Nested(int count)
        {
            var top = new Edges();
            var deepest = top;

            for (var depth = 0; depth < count; depth += 1)
            {
                deepest.Child = new Edges();
                deepest = deepest.Child;
            }

            return top;
        }

        // * 100 below the result written; 101 refused, a Struct's members counted as a message's
        Assert.StartsWith("{\"child\":{\"child\":", Written(Nested(100)), StringComparison.Ordinal);
        Assert.Equal("a message nested past 100", Assert.Throws<JsonFormException>(() =>
        {
            Form.Write(Nested(101));
        }).Message);

        var structured = Nested(99);
        var deepest = structured;

        while (deepest.Child is { } child)
        {
            deepest = child;
        }

        deepest.Extra = new Struct { Fields = { ["a"] = Value.ForNumber(1) } };

        Assert.Equal("a message nested past 100", Assert.Throws<JsonFormException>(() =>
        {
            Form.Write(structured);
        }).Message);
    }

    [Fact]
    public void Writes_each_well_known_form_at_its_edges_and_refuses_what_its_form_holds_none_of()
    {
        // * a second before the epoch, an Any of an Empty, the empty Any, a map of bool keys
        Assert.Equal("{\"at\":\"1969-12-31T23:59:59.500Z\"}", Written(new Edges { At = new Timestamp { Seconds = -1, Nanos = 500_000_000 } }));
        Assert.Equal("{\"any\":{\"@type\":\"type.googleapis.com/google.protobuf.Empty\"}}", Written(new Edges { Any = Any.Pack(new Empty()) }));
        Assert.Equal("{\"any\":{}}", Written(new Edges { Any = new Any() }));
        Assert.Equal("{\"took\":\"-1.000000001s\"}", Written(new Edges { Took = new Duration { Seconds = -1, Nanos = -1 } }));
        Assert.Equal("{\"took\":\"0.000001s\"}", Written(new Edges { Took = new Duration { Nanos = 1_000 } }));
        Assert.Equal("{\"flags\":{\"false\":\"f\",\"true\":\"t\"}}", Written(new Everything { Flags = { [true] = "t", [false] = "f" } }));

        var parted = new List<string>();

        foreach (var (message, words) in new (IMessage Message, string Words)[]
        {
            (new Edges { At = new Timestamp { Nanos = -1 } }, "a Timestamp outside its range"),
            (new Edges { At = new Timestamp { Seconds = 253_402_300_800 } }, "a Timestamp outside its range"),
            (new Edges { Took = new Duration { Seconds = 1, Nanos = -1 } }, "a Duration outside its range"),
            (new Edges { Took = new Duration { Seconds = 315_576_000_001 } }, "a Duration outside its range"),
            (new Edges { Any = new Any { TypeUrl = "nope" } }, "an Any whose type its definitions do not hold"),
            (new Edges { Any = new Any { TypeUrl = "type.googleapis.com/bead.transcoding.v1.Inner", Value = ByteString.CopyFrom(0xFF) } }, "an Any whose bytes do not read as its type"),
        })
        {
            try
            {
                Form.Write(message);
                parted.Add($"{message}: written, where {words}");
            }
            catch (JsonFormException refused) when (refused.Message != words)
            {
                parted.Add($"{message}: {refused.Message}, where {words}");
            }
            catch (JsonFormException)
            {
                // refused in its own words
            }
        }

        Assert.Empty(parted);
    }

    [Fact]
    public void Writes_a_response_body_s_field_at_its_default_where_its_oneof_holds_another_member_or_none()
    {
        static string Field(IMessage message, string name)
        {
            return Encoding.UTF8.GetString(Form.WriteField(message, name));
        }

        // * a message field unset is its empty message, a wrapper's its value's zero, a scalar its zero
        Assert.Equal("{}", Field(new Edges(), "child"));
        Assert.Equal("0", Field(new Edges(), "wrapped_float"));
        Assert.Equal("\"0\"", Field(new Edges(), "wrapped_int64"));
        Assert.Equal("false", Field(new Everything(), "wrapped_bool"));
        Assert.Equal("\"\"", Field(new Everything(), "wrapped_string"));
        Assert.Equal("[]", Field(new Edges(), "ints"));
        Assert.Equal("{}", Field(new Edges(), "labels"));
        Assert.Equal("0", Field(new Edges(), "an_int32"));
        Assert.Equal("{\"name\":\"a\"}", Field(new Everything { Inner = new Inner { Name = "a" } }, "inner"));

        // a oneof's member set, another of it at its default, and each of none at its default
        var chosen = new Everything { ChoiceText = "x" };

        Assert.Equal("\"x\"", Field(chosen, "choice_text"));
        Assert.Equal("{}", Field(chosen, "choice_inner"));
        Assert.Equal("\"\"", Field(new Everything(), "choice_text"));
        Assert.Equal("{}", Field(new Everything(), "inner"));
        Assert.Equal("null", Field(new Edges(), "null_member"));
        Assert.Equal("0", Field(new Value(), "number_value"));
        Assert.Equal("false", Field(new Value(), "bool_value"));
        Assert.Throws<ArgumentException>(() =>
        {
            Form.WriteField(new Edges(), "nope");
        });
    }

    [Fact]
    public void Writes_an_aliased_enum_by_its_first_name_a_float_at_its_shortest_and_a_minus_0_left_out()
    {
        Assert.Equal("{\"aliased\":\"ALIASED_FIRST\"}", Written(new Edges { Aliased = Aliased.Second }));
        Assert.Equal("{\"aliased\":7}", Written(new Edges { Aliased = (Aliased)7 }));
        Assert.Equal("{\"wrappedFloat\":0.1,\"aFloat\":3.4028235e+38}", Written(new Edges { WrappedFloat = 0.1F, AFloat = float.MaxValue }));
        Assert.Equal("{}", Written(new Edges { ADouble = -0.0, AFloat = -0.0F }));

        // a field of its own presence at -0 is written, 0
        Assert.Equal("{\"maybeDouble\":0}", Written(new Edges { MaybeDouble = -0.0 }));
    }
}
