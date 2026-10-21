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
