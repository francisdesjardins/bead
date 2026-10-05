using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Bead's codecs, <c>spec/codecs.json</c>, played whole through this side's (decision 0016): each
/// payload read in its encoding, then refused, or written back to the bytes given, the value read
/// equal by <see cref="JsonElement.DeepEquals"/> to the value read of those bytes and its raw text
/// those very bytes, so that the value handed on is the canonical form's; each value built from its
/// form and written, to its bytes or refused. A row a row of the support matrix excuses this side
/// from, a value no <see cref="JsonElement"/> holds, is counted and not played. The TypeScript side
/// plays the same file.
/// </summary>
public sealed class CodecsTests
{
    // constants

    // the language a differs names to excuse this side
    private const string Language = "C#";

    private static readonly JsonElement Root = Load();

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

    // what the writer of an encoding writes of a value given in its form
    private static ReadOnlyMemory<byte> WrittenOf(JsonElement entry)
    {
        var value = entry.GetProperty("value");

        return entry.GetProperty("encoding").GetString() switch
        {
            "json" => Payloads.WriteJson(ElementOf(value)),
            "text" => Payloads.WriteText(TextOf(value)),
            _ => Payloads.WriteRaw(BytesOf(value.GetProperty("bytes"))),
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
            default:
                Assert.False(isRefused);
                Assert.Equal(BytesOf(entry.GetProperty("written")), Payloads.WriteRaw(Payloads.ReadRaw(bytes)).ToArray());
                break;
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
    public void Plays_every_row_but_NaN_and_Infinity_which_no_JsonElement_holds_as_a_number()
    {
        var excused = Root.GetProperty("payloads").EnumerateArray().Concat(Root.GetProperty("values").EnumerateArray()).Where(IsExcused).ToList();

        Assert.Equal(
            ["NaN", "Infinity"],
            excused.Select((entry) =>
            {
                return entry.GetProperty("name").GetString()!;
            }));

        // * each a double no number of JSON's holds, which JsonSerializer refuses to make an element of
        foreach (var entry in excused)
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
