using System.Text;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="Violations"/>: a PAYLOAD_INVALID's detail written and read, by the <c>details</c> of
/// <c>spec/validations.json</c>, and what a reader keeps of one cut, or of another form; the twins
/// of the TypeScript side's <c>violations.test.ts</c>.
/// </summary>
public sealed class ViolationsTests
{
    // constants

    private static readonly JsonElement Root = Load();

    private static readonly JsonElement MinLen = JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["min_len"] = "1" });

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "validations.json")));

        return document.RootElement.Clone();
    }

    private static JsonElement DetailOf(string name)
    {
        foreach (var each in Root.GetProperty("details").EnumerateArray())
        {
            if (each.GetProperty("name").GetString() == name)
            {
                return each;
            }
        }

        throw new KeyNotFoundException($"no details entry \"{name}\"");
    }

    // a violation as the file writes it: 18.3's members
    private static Violation ViolationOf(JsonElement written)
    {
        string? TextOf(string member)
        {
            return written.TryGetProperty(member, out var value) ? value.GetString() : null;
        }

        return new Violation
        {
            Bounds = written.TryGetProperty("bounds", out var bounds) ? bounds : null,
            FieldPath = TextOf("fieldPath"),
            ForKey = written.TryGetProperty("forKey", out var forKey) && forKey.GetBoolean(),
            Message = TextOf("message"),
            RuleId = TextOf("ruleId")!,
        };
    }

    // a violation as one line of text, its members compared whatever their kind: its bounds in their
    // canonical form
    private static string Shown(Violation violation)
    {
        var bounds = violation.Bounds is { } held ? Encoding.UTF8.GetString(PayloadCodecs.Json.Encode(held).Span) : "-";

        return $"{violation.RuleId} | {violation.FieldPath ?? "-"} | {violation.ForKey} | {violation.Message ?? "-"} | {bounds}";
    }

    private static string WrittenOf(string[] violations, int maximumBytes)
    {
        return Violations.DetailOf(
            new Judged
            {
                Violations = [.. violations.Select((fieldPath) =>
                {
                    return new Violation { Bounds = MinLen, FieldPath = fieldPath, Message = "must be at least 1 characters", RuleId = "string.min_len" };
                })],
            },
            maximumBytes);
    }

    // definition

    /// <summary>The names of every entry of <c>details</c>.</summary>
    public static TheoryData<string> Details { get; } = new(Root.GetProperty("details").EnumerateArray().Select((entry) =>
    {
        return entry.GetProperty("name").GetString()!;
    }));

    [Theory]
    [MemberData(nameof(Details))]
    public void The_details(string name)
    {
        var entry = DetailOf(name);
        var detail = entry.GetProperty("detail").GetString()!;

        if (entry.TryGetProperty("write", out var write))
        {
            var judged = new Judged
            {
                More = write.TryGetProperty("more", out var more) ? more.GetInt64() : 0,
                Stopped = write.TryGetProperty("stopped", out var stopped) && stopped.GetBoolean(),
                Violations = [.. write.GetProperty("violations").EnumerateArray().Select(ViolationOf)],
            };

            Assert.Equal(detail, Violations.DetailOf(judged, write.GetProperty("maximumBytes").GetInt32()));

            return;
        }

        var expected = entry.GetProperty("read");
        var read = Violations.Read(detail);

        Assert.Equal([.. expected.GetProperty("violations").EnumerateArray().Select(ViolationOf).Select(Shown)], read.Violations.Select(Shown));
        Assert.Equal(expected.TryGetProperty("more", out var count) ? count.GetInt64() : null, read.More);
        Assert.Equal(expected.TryGetProperty("stopped", out var told) && told.GetBoolean(), read.Stopped);
    }

    [Fact]
    public void Keeps_the_whole_lines_of_a_detail_its_reader_cut()
    {
        var detail = WrittenOf(["names[0]", "names[1]", "names[2]"], 1_024);
        var whole = Violations.Read(detail);

        Assert.Equal(["names[0]", "names[1]", "names[2]"], whole.Violations.Select((violation) =>
        {
            return violation.FieldPath;
        }));
        Assert.Equal(0, whole.More);

        // * cut within its third line, as a reader's lower bound cuts it (spec 7.3): the two lines
        // before it kept, and what it left out not counted
        var cut = detail[..(detail.IndexOf("names[2]", StringComparison.Ordinal) + 4)];
        var kept = Violations.Read(cut);

        Assert.Equal(["names[0]", "names[1]"], kept.Violations.Select((violation) =>
        {
            return violation.FieldPath;
        }));
        Assert.Null(kept.More);
        Assert.False(kept.Stopped);

        // and cut after a whole line, its line kept, its count still missing
        var atLine = Violations.Read(detail[..detail.IndexOf('\n', StringComparison.Ordinal)]);

        Assert.Equal("names[0]", Assert.Single(atLine.Violations).FieldPath);
        Assert.Null(atLine.More);
    }

    [Fact]
    public void Reads_no_violations_from_a_detail_empty_cut_or_of_another_form()
    {
        var detail = WrittenOf(["names[0]"], 1_024);

        string[] none =
        [
            "",
            "the request is invalid",
            detail[..10],
            "{\"error\":\"invalid\"}\n" + detail,
            "[1,2,3]",
        ];

        foreach (var each in none)
        {
            var read = Violations.Read(each);

            Assert.Empty(read.Violations);
            Assert.Null(read.More);
            Assert.False(read.Stopped);
        }

        // * a failure of another code carries none, whatever its detail
        Assert.Empty(Violations.Of(Failure.OfProtocol(ProtocolCode.PayloadUndecodable, detail)).Violations);
        Assert.Empty(Violations.Of(Failure.OfApplication(52, detail)).Violations);
        Assert.Single(Violations.Of(Failure.OfProtocol(ProtocolCode.PayloadInvalid, detail)).Violations);
    }
}
