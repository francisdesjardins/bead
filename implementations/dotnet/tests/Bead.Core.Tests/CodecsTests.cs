using System.Globalization;
using System.Text;
using System.Text.Json;
using Bead.Codecs.V1;
using Bead.Protobuf;
using Google.Protobuf;

namespace Bead.Tests;

/// <summary>
/// Bead's codecs, <c>spec/codecs.json</c>, played whole through this side's (decisions 0016 and
/// 0031): each payload read in its encoding, then refused, or written back to the bytes given, the
/// value read equal by <see cref="JsonElement.DeepEquals"/> to the value read of those bytes and its
/// raw text those very bytes, so that the value handed on is the canonical form's; a <c>proto</c>
/// payload read as <c>Probe</c>, of <c>spec/codecs.proto</c>, through the runtime codec generated
/// code names, <see cref="ProtoCodecs"/>: its records checked first (decision 0028), a closed enum's
/// undeclared number set aside (17.9.8), its required fields judged once it is read (17.9.7,
/// decision 0042), then refused, or its fields those read; each value built from its form and
/// written, to its bytes or refused. An entry a row of the support matrix excuses this side from, a value no
/// <see cref="JsonElement"/> holds, is counted and not played. The TypeScript side plays the same
/// file.
/// </summary>
public sealed class CodecsTests
{
    // constants

    // the language a differs names to excuse this side
    private const string Language = "C#";

    // the encodings this side reads and writes, each through a codec of its own: an entry of any other
    // fails its test
    private static readonly string[] Encodings = ["json", "proto", "raw", "text"];

    private static readonly JsonElement Root = Load();

    // * the codec a generated proto binding names, the runtime's
    private static readonly IPayloadCodec<Probe> ProbeCodec = ProtoCodecs.Of<Probe>();

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "codecs.json")));

        return document.RootElement.Clone();
    }

    // whether an entry's differs names this side
    private static bool IsExcused(JsonElement entry)
    {
        return entry.TryGetProperty("differs", out var differs) && differs.EnumerateArray().Any((difference) =>
        {
            return difference.GetProperty("language").GetString() == Language;
        });
    }

    private static JsonElement EntryOf((string Group, string Name) entry)
    {
        foreach (var each in Root.GetProperty(entry.Group).EnumerateArray())
        {
            if (each.GetProperty("name").GetString() == entry.Name)
            {
                return each;
            }
        }

        throw new KeyNotFoundException($"no {entry.Group} entry \"{entry.Name}\"");
    }

    // the names of a group's entries this side plays
    private static TheoryData<string> PlayedOf(string group)
    {
        return new TheoryData<string>(Root.GetProperty(group).EnumerateArray().Where((entry) =>
        {
            return !IsExcused(entry);
        }).Select((entry) =>
        {
            return entry.GetProperty("name").GetString()!;
        }));
    }

    // bytes as the file writes them, in hexadecimal, a space between two
    private static byte[] BytesOf(JsonElement hexadecimal)
    {
        return Convert.FromHexString(hexadecimal.GetString()!.Replace(" ", "", StringComparison.Ordinal));
    }

    private static double DoubleOf(JsonElement bits)
    {
        return BitConverter.Int64BitsToDouble(long.Parse(bits.GetString()!, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
    }

    // a value given to a json writer, built from its form as the file's comment says
    private static JsonElement ElementOf(JsonElement value)
    {
        if (value.TryGetProperty("json", out var json))
        {
            return json.Clone();
        }

        if (value.TryGetProperty("double", out var bits))
        {
            return JsonSerializer.SerializeToElement(DoubleOf(bits));
        }

        if (value.TryGetProperty("number", out var number))
        {
            return JsonElement.Parse(number.GetString()!);
        }

        if (value.TryGetProperty("nested", out var nested))
        {
            var depth = nested.GetInt32();

            // * MaxDepth as deep, since 64, the default, refuses a 65th
            using var document = JsonDocument.Parse(new string('[', depth) + new string(']', depth), new JsonDocumentOptions { MaxDepth = depth });

            return document.RootElement.Clone();
        }

        return value.GetProperty("form").GetString() switch
        {
            "loneSurrogate" => JsonElement.Parse("\"a\\ud800b\""),
            "loneSurrogateName" => JsonElement.Parse("{\"a\\ud800b\":1}"),
            "nameTwice" => JsonElement.Parse("{\"a\":1,\"a\":2}"),
            _ => default,
        };
    }

    // a value given to a text writer
    private static string TextOf(JsonElement value)
    {
        return value.TryGetProperty("text", out var text) ? text.GetString()! : "a\ud800b";
    }

    // a string as the file writes it: its UTF-16 code units in hexadecimal, a space between two
    private static string StringOf(JsonElement codeUnits)
    {
        var text = codeUnits.GetString()!;

        return text.Length == 0
            ? ""
            : new string([.. text.Split(' ').Select((unit) =>
            {
                return (char)ushort.Parse(unit, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            })]);
    }

    // a string's UTF-16 code units, as the file writes them
    private static string CodeUnitsOf(string text)
    {
        return string.Join(' ', text.Select((unit) =>
        {
            return ((ushort)unit).ToString("X4", CultureInfo.InvariantCulture);
        }));
    }

    // a probe built from its form: one field, or none; needs of the fields it gives
    private static Probe ProbeOf(JsonElement form)
    {
        var probe = new Probe();

        if (form.TryGetProperty("needs", out var needs))
        {
            probe.Needs = new Needs();

            if (needs.TryGetProperty("must", out var must))
            {
                probe.Needs.Must = must.GetUInt32();
            }

            if (needs.TryGetProperty("shade", out var shade))
            {
                probe.Needs.Shade = (Shade)shade.GetInt32();
            }
        }

        if (form.TryGetProperty("text", out var text))
        {
            probe.Text = StringOf(text);
        }

        if (form.TryGetProperty("number", out var number))
        {
            probe.Number = number.GetUInt32();
        }

        if (form.TryGetProperty("child", out _))
        {
            probe.Child = new Probe();
        }

        return probe;
    }

    // how deep messages nest below a probe, through child, delimited and children, a map's entry
    // counting as a message and its value as another
    private static int NestedOf(Probe probe)
    {
        var nested = 0;

        foreach (var message in new[] { probe.Child, probe.Delimited })
        {
            if (message is not null)
            {
                nested = Math.Max(nested, 1 + NestedOf(message));
            }
        }

        foreach (var value in probe.Children.Values)
        {
            nested = Math.Max(nested, 2 + NestedOf(value));
        }

        return nested;
    }

    // what was read of a probe, as read gives it: its text, number and nested, and below the top
    // probe its counts, stamps, children and delimited, where it holds any, and its shade, where a
    // record set it
    private static JsonElement ReadOf((Probe Probe, bool IsTop) read)
    {
        var (probe, isTop) = read;
        var fields = new Dictionary<string, object>
        {
            ["text"] = CodeUnitsOf(probe.Text),
            ["number"] = probe.Number,
            ["nested"] = NestedOf(probe),
        };

        if (isTop && probe.Counts.Count != 0)
        {
            fields["counts"] = probe.Counts.ToArray();
        }

        if (isTop && probe.Stamps.Count != 0)
        {
            fields["stamps"] = probe.Stamps.ToArray();
        }

        if (isTop && probe.Children.Count != 0)
        {
            fields["children"] = probe.Children.ToDictionary(
                (child) =>
                {
                    return CodeUnitsOf(child.Key);
                },
                (child) =>
                {
                    return ReadOf((child.Value, false));
                },
                StringComparer.Ordinal);
        }

        if (isTop && probe.Delimited is not null)
        {
            fields["delimited"] = ReadOf((probe.Delimited, false));
        }

        if (isTop && probe.HasShade)
        {
            fields["shade"] = (int)probe.Shade;
        }

        return JsonSerializer.SerializeToElement(fields);
    }

    // what the writer of an encoding writes of a value given in its form
    private static ReadOnlyMemory<byte> WrittenOf(JsonElement entry)
    {
        var value = entry.GetProperty("value");

        return entry.GetProperty("encoding").GetString() switch
        {
            "json" => Payloads.WriteJson(ElementOf(value)),
            "text" => Payloads.WriteText(TextOf(value)),
            "proto" => ProbeCodec.Encode(ProbeOf(value.GetProperty("probe"))),
            "raw" => Payloads.WriteRaw(BytesOf(value.GetProperty("bytes"))),
            var encoding => throw new InvalidOperationException($"no codec of this side writes the encoding {encoding}"),
        };
    }

    // definition

    /// <summary>The names of every payload this side plays.</summary>
    public static TheoryData<string> PayloadRows { get; } = PlayedOf("payloads");

    /// <summary>The names of every value this side plays.</summary>
    public static TheoryData<string> ValueRows { get; } = PlayedOf("values");

    [Theory]
    [MemberData(nameof(PayloadRows))]
    public void Reads_each_payload_then_refuses_it_or_writes_back_its_bytes_handing_on_the_value_of_its_canonical_form(string name)
    {
        var entry = EntryOf(("payloads", name));
        var bytes = BytesOf(entry.GetProperty("bytes"));
        var isRefused = entry.TryGetProperty("refused", out _);

        switch (entry.GetProperty("encoding").GetString())
        {
            case "json":
                if (isRefused)
                {
                    Assert.Throws<FormatException>(() =>
                    {
                        return Payloads.ReadJson(bytes);
                    });

                    return;
                }

                var value = Payloads.ReadJson(bytes);
                var written = BytesOf(entry.GetProperty("written"));

                Assert.Equal(written, Payloads.WriteJson(value).ToArray());
                Assert.True(JsonElement.DeepEquals(Payloads.ReadJson(written), value));

                // ! DeepEquals tells neither 1.0 from 1 nor -0 from 0: the raw text tells an element
                // read as it came from one read as its canonical form
                Assert.Equal(written, Encoding.UTF8.GetBytes(value.GetRawText()));
                break;
            case "text":
                if (isRefused)
                {
                    Assert.Throws<FormatException>(() =>
                    {
                        return Payloads.ReadText(bytes);
                    });

                    return;
                }

                var text = Payloads.ReadText(bytes);
                var textWritten = BytesOf(entry.GetProperty("written"));

                Assert.Equal(textWritten, Payloads.WriteText(text).ToArray());
                Assert.Equal(Payloads.ReadText(textWritten), text);
                break;
            case "proto":
                if (isRefused)
                {
                    // * refused by the check or the walk, or past them by Google.Protobuf: a string
                    // that is not UTF-8 is the library's to refuse
                    var refusal = Assert.ThrowsAny<Exception>(() =>
                    {
                        return ProbeCodec.Decode(bytes);
                    });

                    Assert.True(refusal is FormatException or InvalidProtocolBufferException, refusal.ToString());

                    return;
                }

                var read = ReadOf((ProbeCodec.Decode(bytes), true));
                var expected = entry.GetProperty("read");

                Assert.True(JsonElement.DeepEquals(expected, read), $"read {read.GetRawText()}, where the file reads {expected.GetRawText()}");
                break;
            case "raw":
                Assert.False(isRefused);
                Assert.Equal(BytesOf(entry.GetProperty("written")), Payloads.WriteRaw(Payloads.ReadRaw(bytes)).ToArray());
                break;
            case var encoding:
                throw new InvalidOperationException($"no codec of this side reads the encoding {encoding}");
        }
    }

    [Theory]
    [MemberData(nameof(ValueRows))]
    public void Writes_each_value_given_in_its_form_to_its_bytes_or_refuses_it(string name)
    {
        var entry = EntryOf(("values", name));

        if (entry.TryGetProperty("refused", out _))
        {
            Assert.Throws<FormatException>(() =>
            {
                return WrittenOf(entry);
            });

            return;
        }

        Assert.Equal(BytesOf(entry.GetProperty("written")), WrittenOf(entry).ToArray());
    }

    [Fact]
    public void Plays_every_encoding_of_the_file_through_a_codec_of_its_own_and_no_other()
    {
        var encodings = Root.GetProperty("payloads").EnumerateArray().Concat(Root.GetProperty("values").EnumerateArray()).Select((entry) =>
        {
            return entry.GetProperty("encoding").GetString()!;
        });

        Assert.Equal(Encodings, encodings.Distinct().Order(StringComparer.Ordinal));
    }

    [Fact]
    public void A_proto_string_holding_a_surrogate_alone_as_Google_Protobuf_writes_it()
    {
        var probe = new Probe { Text = string.Concat("a", (char)0xD800, "b") };

        // * repaired, U+FFFD in its place, where text and json refuse it
        Assert.Equal(Convert.FromHexString("0A0561EFBFBD62"), ProbeCodec.Encode(probe).ToArray());
    }

    [Fact]
    public void A_proto_maps_entry_its_key_at_its_default_as_Google_Protobuf_writes_it()
    {
        var probe = new Probe { Children = { [""] = new Probe() } };

        // * the empty key left out, as any field at its default, where protobuf-es writes it
        Assert.Equal(Convert.FromHexString("62021200"), ProbeCodec.Encode(probe).ToArray());
    }

    [Fact]
    public void Plays_every_entry_of_the_file_but_those_a_row_of_the_matrix_excuses_this_side_from()
    {
        var payloads = Root.GetProperty("payloads").EnumerateArray().Where(IsExcused).ToList();
        var values = Root.GetProperty("values").EnumerateArray().Where(IsExcused).ToList();

        Assert.Equal(
            ["NaN", "Infinity"],
            payloads.Concat(values).Select((entry) =>
            {
                return entry.GetProperty("name").GetString()!;
            }));

        // * each value a double no number of JSON's holds, which JsonSerializer refuses to make an
        // element of
        foreach (var entry in values)
        {
            var given = DoubleOf(entry.GetProperty("value").GetProperty("double"));

            Assert.False(double.IsFinite(given));
            Assert.Throws<ArgumentException>(() =>
            {
                return JsonSerializer.SerializeToElement(given);
            });
        }
    }
}
