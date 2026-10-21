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

    // the rules whose words depend on what was judged, which their id and bounds do not give (18.8.6)
    private static readonly HashSet<string> JudgedWords = new(StringComparer.Ordinal) { "message.oneof", "required" };

    private static readonly Violation From = new()
    {
        Bounds = BoundsOf("{\"lte\":10}"),
        FieldPath = "from",
        Message = "must be less than or equal to 10",
        RuleId = "int32.lte",
    };

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

    private static JsonElement BoundsOf(string json)
    {
        using var document = JsonDocument.Parse(json);

        return document.RootElement.Clone();
    }

    // the words of a rule, by its id and its bounds' JSON text, none for a rule without bounds
    private static string? WordsOf(string ruleId, string? bounds)
    {
        return Violations.WordsOf(new Violation { Bounds = bounds is null ? null : BoundsOf(bounds), RuleId = ruleId });
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
            "{\"bounds\":{\"lte\"",
            "the request is invalid",
            detail[..10],
            "{\"error\":\"invalid\"}\n" + detail,
            "{\"error\":\"invalid\"}\n{\"more\":0}",
            "[1,2,3]",

            // a line of 18.3's members but its ruleId, which every violation has, or with one of another type
            "{\"fieldPath\":\"from\"}\n{\"more\":0}",
            "{\"bounds\":[10],\"ruleId\":\"int32.lte\"}\n{\"more\":0}",
            "{\"message\":10,\"ruleId\":\"int32.lte\"}\n{\"more\":0}",
            "{\"forKey\":false,\"ruleId\":\"required\"}\n{\"more\":0}",
            "{\"stopped\":false}",
            "﻿{\"ruleId\":\"required\"}",
        ];

        foreach (var each in none)
        {
            var read = Violations.Read(each);

            Assert.Empty(read.Violations);
            Assert.Null(read.More);
            Assert.False(read.Stopped);
        }

        // * a failure of another code carries none, whatever its detail
        Assert.Empty(Violations.Of(Failure.OfProtocol(ProtocolCode.ProcedureFailed, detail)).Violations);
        Assert.Empty(Violations.Of(Failure.OfProtocol(ProtocolCode.PayloadUndecodable, detail)).Violations);
        Assert.Empty(Violations.Of(Failure.OfApplication(52, detail)).Violations);
        Assert.Single(Violations.Of(Failure.OfProtocol(ProtocolCode.PayloadInvalid, detail)).Violations);
    }

    [Fact]
    public void Reads_forKey_on_the_violation_of_a_map_key_its_other_members_beside_it()
    {
        var key = new Violation
        {
            Bounds = BoundsOf("{\"min_len\":\"2\"}"),
            FieldPath = "labels[\"a\"]",
            ForKey = true,
            Message = "must be at least 2 characters",
            RuleId = "string.min_len",
        };
        var whole = Violations.Read(Violations.DetailOf(new Judged { Violations = [key] }, 1_024));

        Assert.Equal([Shown(key)], whole.Violations.Select(Shown));
        Assert.Equal(0, whole.More);

        // * without its words, it takes those its rule and bounds give, a key's as a value's
        var bare = Violations.Read("{\"bounds\":{\"min_len\":\"2\"},\"fieldPath\":\"labels[\\\"a\\\"]\",\"forKey\":true,\"ruleId\":\"string.min_len\"}");

        Assert.Equal([Shown(key)], bare.Violations.Select(Shown));
        Assert.Null(bare.More);
    }

    [Fact]
    public void Leaves_the_value_a_violation_broke_on_the_side_that_judged()
    {
        var judged = new Judged { Violations = [From with { Value = 11 }] };

        Assert.Equal(
            "{\"bounds\":{\"lte\":10},\"fieldPath\":\"from\",\"message\":\"must be less than or equal to 10\",\"ruleId\":\"int32.lte\"}\n{\"more\":0}",
            Violations.DetailOf(judged, 1_024));
    }

    [Fact]
    public void Gives_a_rule_s_words_from_its_id_and_its_bounds_and_none_where_they_depend_on_what_was_judged()
    {
        Assert.Equal("must be greater than or equal to 0 and less than or equal to 10", WordsOf("int32.gte_lte", "{\"gte\":0,\"lte\":10}"));
        Assert.Equal("must be greater than 10 or less than 5", WordsOf("double.gt_lt_exclusive", "{\"gt\":10,\"lt\":5}"));
        Assert.Equal("must be in list [a, b]", WordsOf("string.in", "{\"in\":[\"a\",\"b\"]}"));
        Assert.Equal("does not have prefix 89504e47", WordsOf("bytes.prefix", "{\"prefix\":\"iVBORw==\"}"));
        Assert.Equal("value must be one of the defined enum values", WordsOf("enum.defined_only", null));
        Assert.Null(WordsOf("required", null));
        Assert.Null(WordsOf("message.oneof", "{\"fields\":[\"x\",\"y\"]}"));
        Assert.Null(WordsOf("int32.lte", "{}"));
    }

    [Fact]
    public void Gives_every_violation_of_the_verdicts_the_words_of_its_rule_and_its_bounds_and_none_where_they_depend_on_what_was_judged()
    {
        var violations = Root.GetProperty("verdicts").EnumerateArray().SelectMany((verdict) =>
        {
            return verdict.GetProperty("violations").EnumerateArray().Select(ViolationOf);
        }).ToList();

        Assert.NotEmpty(violations);

        foreach (var violation in violations)
        {
            var expected = JudgedWords.Contains(violation.RuleId) ? null : violation.Message;

            Assert.Equal($"{violation.RuleId}: {expected}", $"{violation.RuleId}: {Violations.WordsOf(violation with { Message = null })}");
        }
    }

    [Fact]
    public void Gives_no_words_where_the_bounds_lack_what_its_rule_needs_or_its_rule_is_none_it_renders()
    {
        (string RuleId, string Bounds)[] none =
        [
            // a member its words need, missing
            ("string.const", "{}"),
            ("string.min_len", "{}"),
            ("string.prefix", "{}"),
            ("string.in", "{}"),
            ("bytes.const", "{}"),
            ("bytes.max_len", "{}"),
            ("bool.const", "{}"),
            ("enum.in", "{}"),
            ("int32.const", "{}"),
            ("int32.gt", "{}"),
            ("int32.not_in", "{}"),
            ("repeated.min_items", "{}"),
            ("map.max_pairs", "{}"),
            ("int32.gte_lte", "{\"gte\":0}"),
            ("double.gt_lt_exclusive", "{\"lt\":5}"),

            // a member its words cannot write: a list's item, bytes that are no base64, a null
            ("int32.in", "{\"in\":[1,{}]}"),
            ("string.not_in", "{\"not_in\":[null]}"),
            ("bytes.prefix", "{\"prefix\":\"!!!\"}"),
            ("bytes.const", "{\"const\":\"!!!\"}"),
            ("uint64.lte", "{\"lte\":null}"),
            ("string.const", "{\"const\":{\"value\":1}}"),

            // a rule it renders none of: an unknown member, an unknown kind, a rule of no kind
            ("string.email", "{\"email\":true}"),
            ("bytes.ip", "{\"ip\":true}"),
            ("repeated.items", "{\"items\":{\"min_len\":\"1\"}}"),
            ("map.keys", "{\"keys\":{\"min_len\":\"1\"}}"),
            ("int32.finite", "{\"finite\":true}"),
            ("int32.lt_gt", "{\"lt\":1,\"gt\":2}"),
            ("duration.gt", "{\"gt\":\"1s\"}"),
            ("timestamp.lt_now", "{\"lt_now\":true}"),
            ("oneof", "{\"fields\":[\"x\"]}"),
            ("bool.in", "{}"),
            ("enum.lt", "{}"),
        ];

        foreach (var (ruleId, bounds) in none)
        {
            Assert.Equal($"{ruleId}: ", $"{ruleId}: {WordsOf(ruleId, bounds)}");
        }

        // * a bound of a scalar is written as `%s` writes it, a flag among them
        Assert.Equal("must be less than or equal to true", WordsOf("int32.lte", "{\"lte\":true}"));
        Assert.Equal("must equal false", WordsOf("bool.const", "{\"const\":false}"));
    }

    [Fact]
    public void Refuses_a_request_a_violation_is_held_or_counted_of_and_takes_one_of_none()
    {
        Assert.False(new Judged { Violations = [] }.Refuses);
        Assert.True(new Judged { More = 1, Stopped = true, Violations = [] }.Refuses);
        Assert.True(new Judged { Violations = [From] }.Refuses);
    }
}
