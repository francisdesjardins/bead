using Bead.Codecs.V1;
using Google.Protobuf;

namespace Bead.Protobuf.Tests;

/// <summary>
/// <see cref="ProtoRecords"/>: a payload's records read against <c>Probe</c>, of
/// <c>spec/codecs.proto</c>, before Google.Protobuf reads them. The twin of the TypeScript side's
/// <c>records.test.ts</c>.
/// </summary>
public sealed class ProtoRecordsTests
{
    // helpers

    // bytes as the conformance files write them, in hexadecimal, a space between two
    private static byte[] BytesOf(string hexadecimal)
    {
        return Convert.FromHexString(hexadecimal.Replace(" ", "", StringComparison.Ordinal));
    }

    private static void Refuses(string hexadecimal)
    {
        Assert.Throws<FormatException>(() =>
        {
            ProtoRecords.Check(BytesOf(hexadecimal), Probe.Descriptor);
        });
    }

    // a record of field 'tag' given whole, its length before it
    private static byte[] Delimited(byte tag, byte[] payload)
    {
        var record = new byte[1 + CodedOutputStream.ComputeLengthSize(payload.Length) + payload.Length];

        using (var output = new CodedOutputStream(record))
        {
            output.WriteRawTag(tag);
            output.WriteLength(payload.Length);
        }

        payload.CopyTo(record.AsSpan(record.Length - payload.Length));

        return record;
    }

    // a Probe holding depth messages below it, each one's message given by nest
    private static byte[] Nested(int depth, Func<byte[], byte[]> nest)
    {
        var bytes = Array.Empty<byte>();

        for (var index = 0; index < depth; index++)
        {
            bytes = nest(bytes);
        }

        return bytes;
    }

    // a child holding the message given
    private static byte[] Child(byte[] message)
    {
        return Delimited(0x1A, message);
    }

    // a map's entry, its key empty and its value the message given: two messages below its own
    private static byte[] Entry(byte[] message)
    {
        return Delimited(0x62, Delimited(0x12, message));
    }

    // a group of delimited holding the message given
    private static byte[] Group(byte[] message)
    {
        return [0x6B, .. message, 0x6C];
    }

    // definition

    [Fact]
    public void Takes_every_record_a_message_holds_a_group_closed_by_its_own_end_group_a_map_of_messages_a_repeated_scalar_packed_or_not_and_an_unknown_field_of_each_wire_type_skipped()
    {
        var taken = new[]
        {
            // nothing at all, and text, number and a child
            "",
            "0A 01 61 10 07 1A 03 0A 01 62",
            // a group closed by its own end group, one in another
            "6B 0A 01 61 6C",
            "6B 6B 10 01 6C 6C",
            // a map of messages, its value before its key, and an entry with no field
            "62 07 0A 01 6B 12 02 10 01",
            "62 07 12 02 10 01 0A 01 6B",
            "62 00",
            // counts packed, unpacked, and both; stamps packed and unpacked
            "52 03 01 02 03",
            "50 01 52 02 02 03",
            "52 00",
            "5A 08 01 00 00 00 02 00 00 00",
            "5D 01 00 00 00",
            // an unknown field of each wire type, an unknown group holding one of each
            "21 01 02 03 04 05 06 07 08 2A 01 7A 35 01 02 03 04 20 96 01",
            "23 21 01 02 03 04 05 06 07 08 2A 01 7A 35 01 02 03 04 20 01 2B 2C 24",
            // ! an unknown length-delimited record is opaque: what it holds is no record
            "2A 02 FF FF",
            // a tag of 5 bytes within 32 bits, and a varint of 10 bytes
            "C8 80 80 80 00 01 0A 01 62",
            "10 FF FF FF FF FF FF FF FF FF 01",
        };

        foreach (var hexadecimal in taken)
        {
            var bytes = BytesOf(hexadecimal);

            ProtoRecords.Check(bytes, Probe.Descriptor);

            // * what the check takes, the library reads
            Probe.Parser.ParseFrom(bytes);
        }
    }

    // spec 17.9.1
    [Fact]
    public void Refuses_a_record_past_the_end_of_its_message_at_any_depth_its_field_known_or_not()
    {
        // a string past its child, at the top, two children down, in a map's value and in a group
        Refuses("1A 02 0A 03 61 62 63");
        Refuses("0A 03 61 62");
        Refuses("1A 05 1A 03 0A 02 61 62 63");
        Refuses("62 06 12 04 0A 03 61 62");
        Refuses("6B 0A 05 61 6C");

        // an unknown record of each wire type past its child
        Refuses("0A 01 61 1A 02 25 00 0A 01 62");
        Refuses("1A 02 21 00 00 00 00 00 00 00 00");
        Refuses("1A 02 2A 05 00 00 00 00 00");
        Refuses("1A 02 20 80 01");

        // a fixed value past the top message, its field known
        Refuses("5D 01 00");
    }

    // spec 17.9.1
    [Fact]
    public void Refuses_a_packed_record_whose_values_do_not_end_at_its_length()
    {
        // a fixed32 run whose length is no multiple of 4
        Refuses("5A 05 01 00 00 00 02");
        Refuses("5A 03 01 00 00");

        // a varint run whose last value runs past its record, a field after
        Refuses("52 02 05 81 01 10 07");
        Refuses("52 01 81");

        // a varint of more than 10 bytes in a run
        Refuses("52 0B 80 80 80 80 80 80 80 80 80 80 00");
    }

    // spec 17.9.1
    [Fact]
    public void Refuses_a_varint_of_more_than_10_bytes_its_field_known_or_not()
    {
        Refuses("10 80 80 80 80 80 80 80 80 80 80 00");
        Refuses("48 80 80 80 80 80 80 80 80 80 80 00");
        Refuses("1A 0C 20 80 80 80 80 80 80 80 80 80 80 00");
    }

    // spec 17.9.1
    [Fact]
    public void Refuses_a_tag_of_more_than_5_bytes_or_past_32_bits()
    {
        Refuses("90 80 80 80 80 00 07");
        Refuses("90 80 80 80 80 80 80 80 00 07");
        Refuses("90 80 80 80 40 07");
        Refuses("90 80 80 80 80 80 0F 07");
        Refuses("F8 FF FF FF 7F 01");
        Refuses("90 80 80 80 80 80 80 80 80 80 80 00 07");

        // and field number 0, wire types 6 and 7, a tag cut short
        Refuses("00 01");
        Refuses("0E");
        Refuses("0F");
        Refuses("90");
    }

    // spec 17.9.1
    [Fact]
    public void Refuses_a_length_past_the_bytes_that_follow_it_a_varint_past_32_bits_among_them()
    {
        Refuses("0A 05 61");
        Refuses("2A 05 61");
        Refuses("0A 80 80 80 80 10");
        Refuses("0A 80 80 80 80 10 10 07");
        Refuses("2A FF FF FF FF FF FF FF FF FF 01");
    }

    // spec 17.9.3
    [Fact]
    public void Refuses_a_message_nested_more_than_100_deep_below_the_top_one_groups_and_map_entries_counted()
    {
        // * by child, by group, by map's entry, which holds its value one deeper, and by unknown group
        ProtoRecords.Check(Nested(100, Child), Probe.Descriptor);
        Assert.Throws<FormatException>(() =>
        {
            ProtoRecords.Check(Nested(101, Child), Probe.Descriptor);
        });

        ProtoRecords.Check(Nested(100, Group), Probe.Descriptor);
        Assert.Throws<FormatException>(() =>
        {
            ProtoRecords.Check(Nested(101, Group), Probe.Descriptor);
        });

        ProtoRecords.Check(Nested(50, Entry), Probe.Descriptor);
        Assert.Throws<FormatException>(() =>
        {
            ProtoRecords.Check(Nested(51, Entry), Probe.Descriptor);
        });

        // ! an entry below 98 children holds its value at 100; below 99, at 101
        var entry = Entry([]);

        for (var index = 0; index < 98; index++)
        {
            entry = Child(entry);
        }

        ProtoRecords.Check(entry, Probe.Descriptor);
        Assert.Throws<FormatException>(() =>
        {
            ProtoRecords.Check(Child(entry), Probe.Descriptor);
        });

        ProtoRecords.Check([.. Enumerable.Repeat((byte)0x23, 100), .. Enumerable.Repeat((byte)0x24, 100)], Probe.Descriptor);
        Assert.Throws<FormatException>(() =>
        {
            ProtoRecords.Check([.. Enumerable.Repeat((byte)0x23, 101), .. Enumerable.Repeat((byte)0x24, 101)], Probe.Descriptor);
        });
    }

    [Fact]
    public void Builds_a_message_s_shape_once_from_its_descriptor_a_message_that_holds_itself_among_them()
    {
        var shape = ProtoRecords.ShapeOf(Probe.Descriptor);

        Assert.Same(shape, ProtoRecords.ShapeOf(Probe.Descriptor));

        // * child and delimited hold Probe itself, and a map's entry holds it as its value
        Assert.Same(shape, shape.FieldOf(3)!.Message);
        Assert.Same(shape, shape.FieldOf(13)!.Message);

        var entry = shape.FieldOf(12)!.Message!;

        Assert.True(entry.IsMapEntry);
        Assert.Same(entry, ProtoRecords.ShapeOf(Probe.Descriptor.FindFieldByNumber(12).MessageType));
        Assert.Same(shape, entry.FieldOf(2)!.Message);
        Assert.Null(shape.FieldOf(1)!.Message);
        Assert.Null(shape.FieldOf(4));
    }

    // spec 17.9.5
    [Fact]
    public void Refuses_a_field_at_a_wire_type_its_type_does_not_take_in_a_map_s_entry_too()
    {
        // text at the varint wire type, number at the length-delimited and the fixed32, child at the
        // varint, stamps at the varint, delimited at the length-delimited, child at the start group
        Refuses("08 61");
        Refuses("12 00");
        Refuses("15 01 02 03 04");
        Refuses("18 03 0A 05 61 62 63 64 65");
        Refuses("58 01");
        Refuses("6A 03 0A 01 61");
        Refuses("1B 1C");
        Refuses("51 01 00 00 00 00 00 00 00");

        // a map's key at the varint wire type, its value at the varint and the start group
        Refuses("62 04 08 02 12 00");
        Refuses("62 04 0A 00 10 01");
        Refuses("62 04 0A 00 13 14");
    }

    // spec 17.9.6
    [Fact]
    public void Refuses_a_map_s_entry_with_a_field_it_does_not_declare()
    {
        Refuses("62 0C 1A 0A 01 7A 12 06 0A 04 61 62 63 64");
        Refuses("62 05 0A 00 1A 01 7A");
        Refuses("62 04 0A 00 18 01");
        Refuses("62 04 0A 00 23 24");
    }
}
