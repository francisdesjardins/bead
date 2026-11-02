using System.Text.RegularExpressions;
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
/// the read, and the walk of a required field unset both ways (spec 17.9.7), a closed enum's
/// undeclared number (17.9.8) and a writer's bound (17.2, 17.9.3), on <c>spec/codecs.proto</c>'s
/// <c>Probe</c>, <c>spec/transcoding.proto</c>'s <c>Requiring</c> and <c>Edges</c>, and
/// <c>Protos/codec.proto</c>, a proto2 file of what neither reaches. The twin of the TypeScript
/// side's <c>codec.test.ts</c> and the Rust side's <c>codec/tests.rs</c>, sentence for sentence.
/// </summary>
public sealed partial class ProtoCodecsTests
{
    // constants

    // 60 groups of field 4, which Probe does not declare, one in another: what a reading keeps among
    // its unknown fields, the same bytes on every side
    private static readonly string Groups = string.Join(' ', Enumerable.Repeat("23", 60).Concat(Enumerable.Repeat("24", 60)));

    // helpers

    /// <summary>
    /// Runs <paramref name="run"/> on a thread of 1 MiB, the stack a recursion past the bound would
    /// overflow, and throws what it throws.
    /// </summary>
    internal static void OnAThreadOf1MiB(Action run)
    {
        Exception? thrown = null;
        var thread = new Thread(
            () =>
            {
                try
                {
                    run();
                }
                catch (Exception reason)
                {
                    thrown = reason;
                }
            },
            1 << 20);

        thread.Start();
        thread.Join();

        if (thrown is not null)
        {
            throw new InvalidOperationException("the run on a thread of 1 MiB threw", thrown);
        }
    }

    // `count` messages above `deepest`, each holding the one below as `link` does, built from the
    // deepest up, so no recursion builds it
    private static THeld Wrapped<THeld>(THeld deepest, (int Count, Func<THeld, THeld> Link) above)
    {
        var held = deepest;

        for (var index = 0; index < above.Count; index += 1)
        {
            held = above.Link(held);
        }

        return held;
    }

    // a Probe that holds `inner` as its child
    private static Probe ChildOf(Probe inner)
    {
        return new Probe { Child = inner };
    }

    // holds that `codec` writes `value` and reads back what it wrote
    private static void Written<T>(IPayloadCodec<T> codec, (T Value, string What) given)
    {
        var (value, what) = given;
        var thrown = Record.Exception(() =>
        {
            return codec.Decode(codec.Encode(value));
        });

        Assert.True(thrown is null, $"{what}: {thrown?.Message}");
    }

    // holds that `codec` refuses to write `value` for its depth: a FormatException of nested past 100
    private static FormatException NestedPast<T>(IPayloadCodec<T> codec, (T Value, string What) given)
    {
        var (value, what) = given;
        var thrown = Record.Exception(() =>
        {
            return codec.Encode(value);
        });

        // ! by its type and its message alone: a message this deep is never shown, whose text recurses
        if (thrown is FormatException { Message: "nested past 100" } refused)
        {
            return refused;
        }

        throw new InvalidOperationException($"{what}: not refused for its depth, {thrown?.GetType().Name} {thrown?.Message}", thrown);
    }

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

    // what a refusal says: its reason, then the field its inner exception names where it names one
    private static string SaidOf(Exception thrown)
    {
        var inner = thrown.InnerException?.Message ?? "";
        var named = UnsetName().Match(inner);

        return $"{thrown.Message}: {(named.Success ? named.Groups["name"].Value : inner)}";
    }

    // what the refusal of a message that leaves the field `name` unset says, as SaidOf has it
    private static string WordsOf(string name)
    {
        return $"a required field unset: {name}";
    }

    [GeneratedRegex(@"^a proto message leaves (?<name>\S+) unset$")]
    private static partial Regex UnsetName();

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

            Assert.Equal(WordsOf(name), SaidOf(thrown));
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

        Assert.Equal(WordsOf("bead.transcoding.v1.Needs.name"), SaidOf(read));
        Assert.Equal(SaidOf(read), SaidOf(written));

        // * a closed enum's number its enum does not declare is no value of a required field
        Assert.Equal(WordsOf("bead.codecs.v1.Needs.shade"), SaidOf(Assert.Throws<FormatException>(() =>
        {
            return ProtoCodecs.Of<Probe>().Encode(new Probe { Needs = new ProbeNeeds { Must = 0, Shade = (Shade)5 } });
        })));
    }

    [Fact]
    public void Refuses_bytes_its_library_cannot_read_as_every_reader_refuses_the_library_s_error_as_its_cause()
    {
        // a text of one byte that is not UTF-8, which Google.Protobuf reads, past the records' check
        var thrown = Assert.Throws<FormatException>(() =>
        {
            return ProtoCodecs.Of<Probe>().Decode(BytesOf("0A 01 FF"));
        });

        // * its reason 17.2's words, Google.Protobuf's error its inner exception
        Assert.Equal("not its message", thrown.Message);
        Assert.IsType<InvalidProtocolBufferException>(thrown.InnerException);
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
        // where the message holds no other
        Assert.Equal("70 01", HexOf(probe.Encode(kept)));
    }

    [Fact]
    public void Echoes_a_closed_enum_s_undeclared_number_beside_another_unknown_field_and_a_wide_one_as_its_library_keeps_them()
    {
        var probe = ProtoCodecs.Of<Probe>();
        var beside = probe.Decode(BytesOf("70 05 20 01"));
        var wide = probe.Decode(BytesOf("70 FF FF FF FF 0F"));

        Assert.False(beside.HasShade);
        Assert.False(wide.HasShade);

        // ! a matrix row: dropped before Google.Protobuf reads, beside another unknown field and past
        // 31 bits alike, the other unknown field kept
        Assert.Equal("20 01", HexOf(probe.Encode(beside)));
        Assert.Equal("", HexOf(probe.Encode(wide)));
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

        Assert.Equal(words, SaidOf(Assert.Throws<FormatException>(() =>
        {
            return update.Decode(BytesOf(""));
        })));
        Assert.Equal(words, SaidOf(Assert.Throws<FormatException>(() =>
        {
            return update.Encode(new NeedsUpdate());
        })));

        // its mask given, empty
        Assert.Equal("12 00", HexOf(update.Encode(update.Decode(BytesOf("12 00")))));
    }

    // ── Writing within the bound (spec 17.2, 17.9.3) ──────────────────────────────

    [Fact]
    public void Refuses_to_write_a_message_nested_more_than_100_deep_below_the_top_one_through_a_child_a_group_and_a_map_s_entry()
    {
        var probe = ProtoCodecs.Of<Probe>();
        var links = new (string Name, int Per, Func<Probe, Probe> Link)[]
        {
            ("a child", 1, ChildOf),
            ("a group", 1, (inner) =>
            {
                return new Probe { Delimited = inner };
            }),
            ("a map's entry", 2, (inner) =>
            {
                return new Probe { Children = { [""] = inner } };
            }),
        };

        foreach (var (name, per, link) in links)
        {
            var count = 100 / per;

            Written(probe, (Wrapped(new Probe(), (count, link)), $"{count} through {name}"));
            NestedPast(probe, (Wrapped(new Probe(), (count + 1, link)), $"{count + 1} through {name}"));
        }

        // * a map of scalars' entry is a message on the wire: 99 below the top, then its entry
        Written(probe, (Wrapped(new Probe { Tallies = { ["a"] = 1 } }, (99, ChildOf)), "a scalar map's entry at 100"));
        NestedPast(probe, (Wrapped(new Probe { Tallies = { ["a"] = 1 } }, (100, ChildOf)), "a scalar map's entry at 101"));
    }

    [Fact]
    public void Refuses_to_write_a_message_101_deep_that_reaches_no_required_field()
    {
        var alone = ProtoCodecs.Of<Alone>();
        static Alone Link(Alone inner)
        {
            return new Alone { Alone_ = inner };
        }

        // * the required walk's shortcut skips Alone: the bound holds all the same
        Assert.False(ProtoRecords.ShapeOf(Alone.Descriptor).ReachesRequired);
        Assert.True(ProtoRecords.ShapeOf(Alone.Descriptor).NestsPast);
        Written(alone, (Wrapped(new Alone(), (100, Link)), "100"));
        NestedPast(alone, (Wrapped(new Alone(), (101, Link)), "101"));
    }

    [Fact]
    public void Refuses_a_value_10000_deep_before_its_library_writes_any_of_it()
    {
        // ! neither the required walk nor Google.Protobuf's CalculateSize reached: either overflows a
        // stack of 1 MiB from about 2,500 deep, which no handler catches
        static Loop Looped(Loop inner)
        {
            return new Loop { Back = new Back { Loop = inner } };
        }

        static Alone Above(Alone inner)
        {
            return new Alone { Alone_ = inner };
        }

        OnAThreadOf1MiB(() =>
        {
            NestedPast(ProtoCodecs.Of<Probe>(), (Wrapped(new Probe(), (10_000, ChildOf)), "a message"));
            NestedPast(ProtoCodecs.Of<Loop>(), (Wrapped(new Loop(), (5_000, Looped)), "a message that reaches a required field"));
            NestedPast(ProtoCodecs.Of<Alone>(), (Wrapped(new Alone(), (10_000, Above)), "a message that reaches no required field"));
        });
    }

    [Fact]
    public void Refuses_to_write_41_messages_above_60_unknown_groups_a_reading_kept()
    {
        var probe = ProtoCodecs.Of<Probe>();
        var read = probe.Decode(BytesOf(Groups));

        // * the depth pass sees none of them: the check over the written bytes refuses, the reader's
        // refusal its inner exception
        Written(probe, (Wrapped(read, (40, ChildOf)), "40"));

        var refused = NestedPast(probe, (Wrapped(read, (41, ChildOf)), "41"));

        Assert.IsType<FormatException>(refused.InnerException);
        Assert.Equal("nested past 100", refused.InnerException.Message);
    }

    [Fact]
    public void Reads_a_map_s_entry_100_deep_that_holds_no_value_and_refuses_to_write_the_value_its_library_gives_it()
    {
        var probe = ProtoCodecs.Of<Probe>();

        // `inner` as the bytes of a Probe's child, its field 3's record
        static byte[] ChildBytes(byte[] inner)
        {
            var bytes = new byte[1 + CodedOutputStream.ComputeLengthSize(inner.Length) + inner.Length];

            using (var output = new CodedOutputStream(bytes))
            {
                output.WriteTag(3, WireFormat.WireType.LengthDelimited);
                output.WriteLength(inner.Length);
            }

            inner.CopyTo(bytes.AsSpan(bytes.Length - inner.Length));

            return bytes;
        }

        // * 99 children below the top, the last holding an entry of children with no key and no
        // value: 100 deep on the wire, which a reader takes; its library gives the entry its value's
        // default, a message 101 deep, which its writer refuses
        var deepest = Wrapped(new byte[] { 0x62, 0x00 }, (99, ChildBytes));
        var read = probe.Decode(deepest);
        var held = (Probe)ProtoCodecs.Read(Probe.Descriptor, deepest);

        NestedPast(probe, (read, "the codec's reading"));
        NestedPast(probe, (held, "ProtoCodecs.Read's"));

        var deeper = Assert.Throws<FormatException>(() =>
        {
            return probe.Decode(ChildBytes(deepest));
        });

        Assert.Equal("nested past 100", deeper.Message);
    }

    [Fact]
    public void Refuses_to_write_a_Struct_nested_past_the_bound_a_member_three_messages_deep()
    {
        var edges = ProtoCodecs.Of<Edges>();

        // a JSON object `levels` deep, its innermost {"leaf": 1}: each level a Struct, its entry and a
        // Value, three messages
        static Struct Above(Struct inner)
        {
            return new Struct { Fields = { ["k"] = Value.ForStruct(inner) } };
        }

        static Struct ObjectOf(int levels)
        {
            return Wrapped(new Struct { Fields = { ["leaf"] = Value.ForNumber(1) } }, (levels - 1, Above));
        }

        Written(edges, (new Edges { Extra = ObjectOf(33) }, "a JSON object 33 deep"));
        NestedPast(edges, (new Edges { Extra = ObjectOf(34) }, "a JSON object 34 deep"));
    }

    [Fact]
    public void Refuses_to_write_a_Value_nested_past_the_bound_through_its_lists()
    {
        var value = ProtoCodecs.Of<Value>();

        // a Value of a list of one Value, that many lists deep, its innermost the number 1: each list
        // two messages, a ListValue and a Value
        static Value Listing(Value inner)
        {
            return Value.ForList(inner);
        }

        static Value Listed(int lists)
        {
            return Wrapped(Value.ForNumber(1), (lists, Listing));
        }

        Written(value, (Listed(50), "50 lists deep"));
        NestedPast(value, (Listed(51), "51 lists deep"));
    }
}
