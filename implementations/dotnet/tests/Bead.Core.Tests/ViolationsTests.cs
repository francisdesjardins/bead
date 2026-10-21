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
            "{\"forKey\":\"true\",\"ruleId\":\"required\"}\n{\"more\":0}",
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
    public void Takes_a_member_empty_as_absent_its_line_kept_and_an_empty_ruleId_as_an_id()
    {
        var empty = Violations.Read("{\"bounds\":{},\"fieldPath\":\"\",\"forKey\":false,\"message\":\"\",\"ruleId\":\"required\"}\n{\"more\":0}");

        Assert.Equal([Shown(new Violation { RuleId = "required" })], empty.Violations.Select(Shown));
        Assert.Equal(0, empty.More);

        // * an empty message takes its rule's words, as an absent one does
        var worded = Violations.Read("{\"bounds\":{\"lte\":10},\"fieldPath\":\"from\",\"message\":\"\",\"ruleId\":\"int32.lte\"}");

        Assert.Equal([Shown(From)], worded.Violations.Select(Shown));

        var idLess = Violations.Read("{\"ruleId\":\"\"}\n{\"message\":\"must be even\",\"ruleId\":\"\"}\n{\"more\":1}");

        Assert.Equal(
            [Shown(new Violation { RuleId = "" }), Shown(new Violation { Message = "must be even", RuleId = "" })],
            idLess.Violations.Select(Shown));
        Assert.Equal(1, idLess.More);
    }

    [Fact]
    public void Reads_a_closing_count_from_0_to_the_largest_integer_I_JSON_holds_and_none_past_it_nor_of_a_fraction()
    {
        var line = "{\"bounds\":{\"lte\":10},\"fieldPath\":\"from\",\"message\":\"must be less than or equal to 10\",\"ruleId\":\"int32.lte\"}";

        Assert.Equal(9_007_199_254_740_991, Violations.Read(line + "\n{\"more\":9007199254740991}").More);

        // * a number is read as the double nearest it (spec 17.6), so 1e2 counts a hundred
        Assert.Equal(100, Violations.Read(line + "\n{\"more\":1e2}").More);

        foreach (var count in new[] { "9007199254740992", "1e300", "1.5", "-1", "\"3\"", "true", "null" })
        {
            var read = Violations.Read(line + "\n{\"more\":" + count + "}");

            Assert.Equal($"{count}: {Shown(From)} -", $"{count}: {string.Join(", ", read.Violations.Select(Shown))} {read.More?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-"}");
        }
    }

    [Fact]
    public void Writes_no_member_empty_and_a_count_past_the_largest_integer_I_JSON_holds_as_it()
    {
        var empty = new Violation { Bounds = BoundsOf("{}"), FieldPath = "", Message = "", RuleId = "required" };

        Assert.Equal("{\"ruleId\":\"required\"}\n{\"more\":0}", Violations.DetailOf(new Judged { Violations = [empty] }, 1_024));
        Assert.Equal("{\"more\":9007199254740991}", Violations.DetailOf(new Judged { More = 1L << 60, Violations = [] }, 1_024));
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
    public void Gives_words_to_the_rules_beadc_compiles_alone_by_their_templates()
    {
        Assert.Equal("does not match regex pattern `^a$`", WordsOf("string.pattern", "{\"pattern\":\"^a$\"}"));
        Assert.Equal("must contain at least 2 item(s)", WordsOf("repeated.min_items", "{\"min_items\":\"2\"}"));
        Assert.Equal("must be finite", WordsOf("float.finite", null));

        // * bytes' pattern and lists, which beadc does not compile, take none, nor an id of no rule's
        (string RuleId, string Bounds)[] none =
        [
            ("bytes.pattern", "{\"pattern\":\"^a$\"}"),
            ("bytes.in", "{\"in\":[\"AQI=\"]}"),
            ("bytes.not_in", "{\"not_in\":[\"AQI=\"]}"),
            ("bool.in", "{\"in\":[true]}"),
            ("enum.gt_lt", "{\"gt\":1,\"lt\":3}"),
            ("repeated.const", "{\"const\":1}"),
            ("", "{\"lte\":1}"),
            ("constructor", "{\"lte\":1}"),
        ];

        foreach (var (ruleId, bounds) in none)
        {
            Assert.Equal($"{ruleId}: ", $"{ruleId}: {WordsOf(ruleId, bounds)}");
        }
    }

    [Fact]
    public void Takes_a_list_for_in_and_not_in_alone_and_a_scalar_for_every_other_member()
    {
        Assert.Equal("must be in list [1, a, true]", WordsOf("int32.in", "{\"in\":[1,\"a\",true]}"));
        Assert.Equal("must not be in list []", WordsOf("string.not_in", "{\"not_in\":[]}"));

        foreach (var bounds in new[] { "{\"in\":1}", "{\"in\":[[1]]}", "{\"in\":[1,[2]]}", "{\"in\":\"a\"}" })
        {
            Assert.Equal($"{bounds}: ", $"{bounds}: {WordsOf("int32.in", bounds)}");
        }

        foreach (var bounds in new[] { "{\"lte\":[1]}", "{\"lte\":{}}", "{\"lte\":null}" })
        {
            Assert.Equal($"{bounds}: ", $"{bounds}: {WordsOf("int32.lte", bounds)}");
        }
    }

    [Fact]
    public void Takes_bytes_in_base64_as_RFC_4648_writes_it_alone_padded_of_its_standard_alphabet()
    {
        Assert.Equal("must be 00ff", WordsOf("bytes.const", "{\"const\":\"AP8=\"}"));
        Assert.Equal("does not have suffix 01", WordsOf("bytes.suffix", "{\"suffix\":\"AQ==\"}"));
        Assert.Equal("does not contain 010203", WordsOf("bytes.contains", "{\"contains\":\"AQID\"}"));
        Assert.Equal("must be 01", WordsOf("bytes.const", "{\"const\":\"AR==\"}"));

        foreach (var text in new[] { "AP8", "-_8=", "AP 8=", "AP8=\\n", "A===", "AP8=AP8=", "!!!!", "AQ=" })
        {
            Assert.Equal($"{text}: ", $"{text}: {WordsOf("bytes.const", "{\"const\":\"" + text + "\"}")}");
        }
    }

    [Fact]
    public void Refuses_a_request_a_violation_is_held_or_counted_of_and_takes_one_of_none()
    {
        Assert.False(new Judged { Violations = [] }.Refuses);
        Assert.True(new Judged { More = 1, Stopped = true, Violations = [] }.Refuses);
        Assert.True(new Judged { Violations = [From] }.Refuses);
    }
}
