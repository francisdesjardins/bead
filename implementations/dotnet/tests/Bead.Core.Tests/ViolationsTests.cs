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

    private static readonly Violation Name = new()
    {
        Bounds = MinLen,
        FieldPath = "names[0]",
        Message = "must be at least 1 characters",
        RuleId = "string.min_len",
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

    // what a reader read, whole, as one line of text: its violations, its count and whether it stopped
    private static string Shown(ViolationsRead read)
    {
        var count = read.More?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-";

        return $"[{string.Join(", ", read.Violations.Select(Shown))}] more {count} stopped {read.Stopped}";
    }

    // what a reader reads of a detail, as a PAYLOAD_INVALID's, whole
    private static string ReadOf(string detail)
    {
        return Shown(Violations.Of(Failure.OfProtocol(ProtocolCode.PayloadInvalid, detail)));
    }

    // what a reader read, as Shown writes it, of the violations and the count given
    private static string ReadShown(Violation[] violations, long? more = null)
    {
        return Shown(new ViolationsRead { More = more, Violations = violations });
    }

    // definition

    [Fact]
    public void Keeps_a_full_violation_detail_closed_to_smaller_violations_after_the_first_refusal()
    {
        var small = new Violation { Bounds = BoundsOf("{}"), FieldPath = "a", Message = "", RuleId = "required" };
        var large = small with { FieldPath = new string('a', 200) };
        const string First = "{\"fieldPath\":\"a\",\"ruleId\":\"required\"}";

        Assert.Equal(First + "\n{\"more\":0}", Violations.DetailOf(new Judged { Violations = [small] }, 80));
        Assert.Equal(First + "\n{\"more\":1}", Violations.DetailOf(new Judged { Violations = [small, large] }, 80));
        Assert.Equal(First + "\n{\"more\":2}", Violations.DetailOf(new Judged { Violations = [small, large, small] }, 80));
    }

    /// <summary>The names of every entry of <c>details</c>.</summary>
    public static TheoryData<string> Details { get; } = new(Root.GetProperty("details").EnumerateArray().Select((entry) =>
    {
        return entry.GetProperty("name").GetString()!;
    }));

    [Fact]
    public void Plays_each_entry_as_a_writer_or_as_a_reader_never_both()
    {
        Assert.Empty(Root.GetProperty("details").EnumerateArray().Where((entry) =>
        {
            return entry.TryGetProperty("read", out _) == entry.TryGetProperty("write", out _);
        }).Select((entry) =>
        {
            return entry.GetProperty("name").GetString();
        }));
    }

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
        var detail = Violations.DetailOf(new Judged { More = 3, Violations = [From, Name] }, 1_024);
        var firstLine = detail.IndexOf('\n', StringComparison.Ordinal);

        Assert.Equal(ReadShown([From, Name], 3), ReadOf(detail));

        // cut inside its second line, as a reader's lower bound cuts it (spec 7.3), the first whole;
        // after the first, its line feed kept or not
        Assert.Equal(ReadShown([From]), ReadOf(detail[..(firstLine + 20)]));
        Assert.Equal(ReadShown([From]), ReadOf(detail[..(firstLine + 1)]));
        Assert.Equal(ReadShown([From]), ReadOf(detail[..firstLine]));

        // * no closing line: what it left out is not counted, and nothing says it stopped
        Assert.Equal(ReadShown([From, Name]), ReadOf(detail[..detail.LastIndexOf('\n')]));
    }

    [Fact]
    public void Reads_no_violations_from_a_detail_empty_cut_or_of_another_form()
    {
        string[] none =
        [
            "",
            "{\"bounds\":{\"lte\"",
            "the request is invalid",
            "{\"error\":\"invalid\"}\n{\"more\":0}",

            // a line of another form first: the lines after it are not read
            "{\"error\":\"invalid\"}\n{\"ruleId\":\"required\"}\n{\"more\":0}",
            "[1,2,3]",

            // a line of 18.3's members but its ruleId, which every violation has, or with one of another type
            "{\"fieldPath\":\"from\"}\n{\"more\":0}",
            "{\"bounds\":[10],\"ruleId\":\"int32.lte\"}\n{\"more\":0}",
            "{\"message\":10,\"ruleId\":\"int32.lte\"}\n{\"more\":0}",
            "{\"forKey\":\"true\",\"ruleId\":\"required\"}\n{\"more\":0}",
            "{\"stopped\":false}",
            "\uFEFF{\"ruleId\":\"required\"}",
        ];

        foreach (var each in none)
        {
            Assert.Equal($"{each}: {ReadShown([])}", $"{each}: {ReadOf(each)}");
        }

        // * a failure of another code carries none, whatever its detail
        var detail = "{\"ruleId\":\"required\"}\n{\"more\":0}";

        Assert.Equal(ReadShown([]), Shown(Violations.Of(Failure.OfProtocol(ProtocolCode.ProcedureFailed, detail))));
        Assert.Equal(ReadShown([]), Shown(Violations.Of(Failure.OfProtocol(ProtocolCode.PayloadUndecodable, detail))));
        Assert.Equal(ReadShown([]), Shown(Violations.Of(Failure.OfApplication((ushort)ProtocolCode.PayloadInvalid, detail))));
        Assert.Equal(ReadShown([new Violation { RuleId = "required" }], 0), ReadOf(detail));
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

        Assert.Equal(ReadShown([key], 0), ReadOf(Violations.DetailOf(new Judged { Violations = [key] }, 1_024)));

        // * without its words, it takes those its rule and bounds give, a key's as a value's
        Assert.Equal(
            ReadShown([key]),
            ReadOf("{\"bounds\":{\"min_len\":\"2\"},\"fieldPath\":\"labels[\\\"a\\\"]\",\"forKey\":true,\"ruleId\":\"string.min_len\"}"));
    }

    [Fact]
    public void Takes_a_member_empty_as_absent_its_line_kept_and_an_empty_ruleId_as_an_id()
    {
        Assert.Equal(
            ReadShown([new Violation { RuleId = "required" }], 0),
            ReadOf("{\"bounds\":{},\"fieldPath\":\"\",\"forKey\":false,\"message\":\"\",\"ruleId\":\"required\"}\n{\"more\":0}"));

        // * an empty message takes its rule's words, as an absent one does
        Assert.Equal(ReadShown([From]), ReadOf("{\"bounds\":{\"lte\":10},\"fieldPath\":\"from\",\"message\":\"\",\"ruleId\":\"int32.lte\"}"));
        Assert.Equal(
            ReadShown([new Violation { RuleId = "" }, new Violation { Message = "must be even", RuleId = "" }], 1),
            ReadOf("{\"ruleId\":\"\"}\n{\"message\":\"must be even\",\"ruleId\":\"\"}\n{\"more\":1}"));
    }

    [Fact]
    public void Reads_a_closing_count_from_0_to_the_largest_integer_I_JSON_holds_and_none_past_it_nor_of_a_fraction()
    {
        var line = "{\"bounds\":{\"lte\":10},\"fieldPath\":\"from\",\"message\":\"must be less than or equal to 10\",\"ruleId\":\"int32.lte\"}";

        Assert.Equal(ReadShown([From], 9_007_199_254_740_991), ReadOf(line + "\n{\"more\":9007199254740991}"));

        // * a number is read as the double nearest it (spec 17.6), so 1e2 counts a hundred
        Assert.Equal(ReadShown([From], 100), ReadOf(line + "\n{\"more\":1e2}"));

        foreach (var count in new[] { "9007199254740992", "1e300", "1.5", "-1", "\"3\"", "true", "null" })
        {
            Assert.Equal($"{count}: {ReadShown([From])}", $"{count}: {ReadOf(line + "\n{\"more\":" + count + "}")}");
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
    public void Bounds_a_detail_by_maximumDetailBytes_and_by_an_envelope_less_its_32_bytes_beside_it()
    {
        Assert.Equal(1_024, (RouterLimits.Default with { MaximumDetailBytes = 1_024, MaximumEnvelopeBytes = 16_778_240 }).DetailBytes);
        Assert.Equal(68, (RouterLimits.Default with { MaximumDetailBytes = 1_024, MaximumEnvelopeBytes = 100 }).DetailBytes);
        Assert.Equal(0, (RouterLimits.Default with { MaximumDetailBytes = 0, MaximumEnvelopeBytes = 64 }).DetailBytes);
    }

    [Fact]
    public void Refuses_a_request_a_violation_is_held_or_counted_of_and_takes_one_of_none()
    {
        Assert.False(new Judged { Violations = [] }.Refuses);
        Assert.True(new Judged { More = 1, Stopped = true, Violations = [] }.Refuses);
        Assert.True(new Judged { Violations = [From] }.Refuses);
    }
}
