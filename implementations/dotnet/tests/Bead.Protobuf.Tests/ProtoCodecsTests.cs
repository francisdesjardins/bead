using Bead.Codecs.V1;
using Bead.Protobuf.Tests.Codec;
using Bead.Transcoding.V1;
using Google.Protobuf;
using Google.Protobuf.Reflection;
using Google.Protobuf.WellKnownTypes;
using Needs = Bead.Transcoding.V1.Needs;
using ProbeNeeds = Bead.Codecs.V1.Needs;
using Shade = Bead.Codecs.V1.Shade;

namespace Bead.Protobuf.Tests;

/// <summary>
/// <see cref="ProtoCodecs"/>: the runtime's codec of a <c>proto</c> message, its records, its bound,
/// the read, and the walk of a required field unset both ways (spec 17.9.7) and a closed enum's
/// undeclared number (17.9.8), on <c>spec/codecs.proto</c>'s <c>Probe</c>,
/// <c>spec/transcoding.proto</c>'s <c>Requiring</c>, and <c>Protos/codec.proto</c>, a proto2 file of
/// what neither reaches. The twin of the TypeScript side's <c>codec.test.ts</c>, sentence for sentence.
/// </summary>
public sealed class ProtoCodecsTests
{
    // helpers

    private sealed record EditionOptions
    {
        public FeatureSet.Types.EnumType? File { get; init; }

        public FeatureSet.Types.EnumType? Outer { get; init; }

        public FeatureSet.Types.EnumType? Inner { get; init; }

        public int Holder { get; init; }
    }

    // * no generated parser: the same record check and filtering that ReadInto runs before parsing
    private static void CheckEdition(bool closed, EditionOptions options)
    {
        var inner = new DescriptorProto
        {
            Name = "Inner",
            Options = options.Inner is { } own ? new MessageOptions { Features = new FeatureSet { EnumType = own } } : null,
            EnumType =
            {
                new EnumDescriptorProto
                {
                    Name = "Tone",
                    Value = { new EnumValueDescriptorProto { Name = "LOW", Number = 0 }, new EnumValueDescriptorProto { Name = "HIGH", Number = 1 } },
                },
            },
            Field =
            {
                new FieldDescriptorProto { Name = "tone", Number = 1, Label = FieldDescriptorProto.Types.Label.Optional, Type = FieldDescriptorProto.Types.Type.Enum, TypeName = ".edition.Outer.Holder.Inner.Tone" },
            },
        };
        var file = new FileDescriptorProto
        {
            Name = "edition.proto",
            Package = "edition",
            Syntax = "editions",
            Edition = Edition._2023,
            Options = options.File is { } filed ? new Google.Protobuf.Reflection.FileOptions { Features = new FeatureSet { EnumType = filed } } : options.Holder switch
            {
                1 => new Google.Protobuf.Reflection.FileOptions(),
                2 => new Google.Protobuf.Reflection.FileOptions { Features = new FeatureSet() },
                _ => null,
            },
            MessageType =
            {
                new DescriptorProto
                {
                    Name = "Outer",
                    Options = options.Outer is { } held ? new MessageOptions { Features = new FeatureSet { EnumType = held } } : null,
                    NestedType =
                    {
                        new DescriptorProto
                        {
                            Name = "Holder",
                            Options = options.Holder switch
                            {
                                1 => new MessageOptions(),
                                2 => new MessageOptions { Features = new FeatureSet() },
                                _ => null,
                            },
                            NestedType = { inner },
                        },
                    },
                },
            },
        };
        var message = FileDescriptor.BuildFromByteStrings([file.ToByteString()])[0].MessageTypes[0].NestedTypes[0].NestedTypes[0];

        foreach (var hex in new[] { "08 05", "08 01 08 05" })
        {
            var bytes = BytesOf(hex);
            var filtered = ProtoRecords.Checked(bytes, message);

            Assert.Equal(closed, filtered);
            Assert.Equal(closed ? (hex == "08 05" ? "" : "08 01") : hex, HexOf(filtered ? ProtoRecords.Filtered(bytes, message) : bytes));
        }

        Assert.False(ProtoRecords.Checked(BytesOf("08 01"), message));
    }

    // bytes as the conformance files write them, in hexadecimal, a space between two
    private static byte[] BytesOf(string hexadecimal)
    {
        return Convert.FromHexString(hexadecimal.Replace(" ", "", StringComparison.Ordinal));
    }

    // bytes as BytesOf reads them
    private static string HexOf(ReadOnlyMemory<byte> bytes)
    {
        return Convert.ToHexString(bytes.Span).Chunk(2).Aggregate("", (written, pair) =>
        {
            return written.Length == 0 ? new string(pair) : $"{written} {new string(pair)}";
        });
    }

    // the reader of the runtime codec of T, as a message
    private static Func<ReadOnlyMemory<byte>, IMessage> DecoderOf<T>()
        where T : IMessage<T>, new()
    {
        var codec = ProtoCodecs.Of<T>();

        return (bytes) =>
        {
            return codec.Decode(bytes);
        };
    }

    // the words of the refusal of a message that leaves the field `name` unset
    private static string WordsOf(string name)
    {
        return $"a proto message leaves {name} unset";
    }

    // definition

    [Fact]
    public void Resolves_an_edition_enum_from_its_nearest_message_before_its_file()
    {
        CheckEdition(false, new EditionOptions { File = FeatureSet.Types.EnumType.Closed, Outer = FeatureSet.Types.EnumType.Closed, Inner = FeatureSet.Types.EnumType.Open });
        CheckEdition(true, new EditionOptions { File = FeatureSet.Types.EnumType.Open, Outer = FeatureSet.Types.EnumType.Open, Inner = FeatureSet.Types.EnumType.Closed });

        foreach (var holder in new[] { 0, 1, 2 })
        {
            CheckEdition(true, new EditionOptions { File = FeatureSet.Types.EnumType.Open, Outer = FeatureSet.Types.EnumType.Closed, Holder = holder });
            CheckEdition(false, new EditionOptions { File = FeatureSet.Types.EnumType.Closed, Outer = FeatureSet.Types.EnumType.Open, Holder = holder });
        }
    }

    [Fact]
    public void Resolves_an_edition_enum_from_its_file_when_no_message_sets_its_type()
    {
        foreach (var holder in new[] { 0, 1, 2 })
        {
            CheckEdition(true, new EditionOptions { File = FeatureSet.Types.EnumType.Closed, Holder = holder });
            CheckEdition(false, new EditionOptions { File = FeatureSet.Types.EnumType.Open, Holder = holder });
        }
    }

    [Fact]
    public void Opens_an_edition_enum_when_no_message_or_file_sets_its_type()
    {
        foreach (var holder in new[] { 0, 1, 2 })
        {
            CheckEdition(false, new EditionOptions { Holder = holder });
        }
    }

    [Fact]
    public void Refuses_a_message_that_leaves_a_required_field_unset_at_every_depth_a_proto3_root_s_message_an_item_a_map_s_value_a_group_and_a_delimited_field()
    {
        var requiring = DecoderOf<Requiring>();
        var probe = DecoderOf<Probe>();

        foreach (var (decode, hexadecimal, name) in new (Func<ReadOnlyMemory<byte>, IMessage> Decode, string Hexadecimal, string Name)[]
        {
            // its needs, {count: 1}
            (requiring, "0A 02 10 01", "bead.transcoding.v1.Needs.name"),

            // an item of many, the second, {name: "a"}
            (requiring, "12 04 0A 00 10 00 12 03 0A 01 61", "bead.transcoding.v1.Needs.count"),

            // a value of by_key, at "k", {count: 1}
            (requiring, "1A 07 0A 01 6B 12 02 10 01", "bead.transcoding.v1.Needs.name"),

            // Probe's delimited, a group, whose needs is {must: 0}
            (probe, "6B 3A 02 08 00 6C", "bead.codecs.v1.Needs.shade"),

            // its needs' delimited, {count: 1}
            (requiring, "0A 09 0A 01 61 10 01 23 10 01 24", "bead.transcoding.v1.Needs.name"),
        })
        {
            var thrown = Assert.Throws<FormatException>(() =>
            {
                return decode(BytesOf(hexadecimal));
            });

            Assert.Equal(WordsOf(name), thrown.Message);
        }
    }

    [Fact]
    public void Refuses_a_payload_and_a_value_with_a_FormatException_in_the_same_words()
    {
        var needs = ProtoCodecs.Of<Needs>();
        var read = Assert.Throws<FormatException>(() =>
        {
            return needs.Decode(BytesOf("10 01"));
        });
        var written = Assert.Throws<FormatException>(() =>
        {
            return needs.Encode(new Needs { Count = 1 });
        });

        Assert.Equal(WordsOf("bead.transcoding.v1.Needs.name"), read.Message);
        Assert.Equal(read.Message, written.Message);

        // * a closed enum's number its enum does not declare is no value of a required field
        Assert.Equal(WordsOf("bead.codecs.v1.Needs.shade"), Assert.Throws<FormatException>(() =>
        {
            return ProtoCodecs.Of<Probe>().Encode(new Probe { Needs = new ProbeNeeds { Must = 0, Shade = (Shade)5 } });
        }).Message);
    }

    [Fact]
    public void Takes_a_required_field_set_at_its_default_and_one_a_message_given_twice_sets_in_either_record()
    {
        var needs = ProtoCodecs.Of<Needs>();
        var requiring = ProtoCodecs.Of<Requiring>();
        var read = needs.Decode(BytesOf("0A 00 10 00"));

        Assert.Equal((true, "", true, 0), (read.HasName, read.Name, read.HasCount, read.Count));
        Assert.Equal("0A 00 10 00", HexOf(needs.Encode(new Needs { Count = 0, Name = "" })));

        foreach (var hexadecimal in new[] { "0A 04 0A 00 10 00 0A 00", "0A 00 0A 04 0A 00 10 00", "0A 02 0A 00 0A 02 10 00" })
        {
            var held = requiring.Decode(BytesOf(hexadecimal)).Needs;

            Assert.True((held.HasName, held.Name, held.HasCount, held.Count) == (true, "", true, 0), hexadecimal);
        }
    }

    [Fact]
    public void Reads_a_closed_enum_s_undeclared_number_as_setting_nothing_its_last_declared_number_kept_a_oneof_s_other_member_too()
    {
        var probe = ProtoCodecs.Of<Probe>();
        var nothing = probe.Decode(BytesOf("70 05"));
        var kept = probe.Decode(BytesOf("70 01 70 05"));
        var toned = ProtoCodecs.Of<Toned>().Decode(BytesOf("12 01 61 08 05"));

        Assert.False(nothing.HasShade);
        Assert.Equal(Shade.Light, kept.Shade);
        Assert.Equal((Toned.PickOneofCase.Word, "a"), (toned.PickCase, toned.Word));

        // ! a matrix row: dropped before Google.Protobuf reads, which keeps a known field's record in
        // no unknown set a caller fills, where protobuf-es writes it back among the unknown fields
        Assert.Equal("70 01", HexOf(probe.Encode(kept)));
    }

    [Fact]
    public void Looks_into_no_extension_and_no_Any_s_message()
    {
        var requiring = ProtoCodecs.Of<Requiring>();
        var holder = ProtoCodecs.Of<Holder>();
        var partial = new Requiring
        {
            Any = new Any { TypeUrl = "type.googleapis.com/bead.transcoding.v1.Needs", Value = ByteString.CopyFrom(BytesOf("10 01")) },
        };

        // its any, a Needs of {count: 1}
        const string Packed = "22 33 0A 2D 74 79 70 65 2E 67 6F 6F 67 6C 65 61 70 69 73 2E 63 6F 6D 2F 62 65 61 64 2E 74 72 61 6E 73 63 6F 64 69 6E 67 2E 76 31 2E 4E 65 65 64 73 12 02 10 01";

        Assert.Equal(Packed, HexOf(requiring.Encode(partial)));
        Assert.Equal(BytesOf("10 01"), requiring.Decode(BytesOf(Packed)).Any.Value.ToByteArray());

        // an extension's Must of no field, which every side reads as an unknown field
        var read = holder.Decode(BytesOf("A2 06 00"));

        Assert.False(read.HasExtension(CodecExtensions.Inner));
        Assert.Equal("A2 06 00", HexOf(holder.Encode(read)));

        // ! a matrix row: Google.Protobuf lists no extension a message holds, so the walk writes such
        // a message, where protobuf-es refuses it as it sets it
        var set = new Holder();

        set.SetExtension(CodecExtensions.Inner, new Must());

        Assert.Equal("A2 06 00", HexOf(holder.Encode(set)));
    }

    [Fact]
    public void Walks_nothing_of_a_message_that_reaches_no_required_field_cycles_included()
    {
        // * Edges holds itself, and Alone too: neither reaches one
        Assert.False(ProtoRecords.ShapeOf(Edges.Descriptor).ReachesRequired);
        Assert.False(ProtoRecords.ShapeOf(Alone.Descriptor).ReachesRequired);
        Assert.Null(ProtoRequired.UnsetOf(new Edges { Child = new Edges { Child = new Edges() } }));

        // * searched from Back first, through Loop and back: each reaches Must
        Assert.Equal(["loop", "must"], ProtoRecords.ShapeOf(Back.Descriptor).Holding.Select((field) =>
        {
            return field.Name;
        }));
        Assert.Equal(["back"], ProtoRecords.ShapeOf(Loop.Descriptor).Holding.Select((field) =>
        {
            return field.Name;
        }));

        var unset = ProtoRequired.UnsetOf(new Loop { Back = new Back { Loop = new Loop { Back = new Back { Must = new Must() } } } });

        Assert.NotNull(unset);
        Assert.Equal(["back", "loop", "back", "must", "must"], [.. unset.Steps.Select((step) =>
        {
            return step.Field.Name;
        }), unset.Field.Name]);
    }

    [Fact]
    public void Refuses_a_message_that_leaves_an_edition_s_required_message_field_unset_reading_and_writing()
    {
        var update = ProtoCodecs.Of<NeedsUpdate>();
        var words = WordsOf("bead.transcoding.v1.NeedsUpdate.update_mask");

        Assert.Equal(words, Assert.Throws<FormatException>(() =>
        {
            return update.Decode(BytesOf(""));
        }).Message);
        Assert.Equal(words, Assert.Throws<FormatException>(() =>
        {
            return update.Encode(new NeedsUpdate());
        }).Message);

        // its mask given, empty
        Assert.Equal("12 00", HexOf(update.Encode(update.Decode(BytesOf("12 00")))));
    }
}
