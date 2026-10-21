using System.Text;
using System.Text.Json;
using Bead.Validations.V1;
using Google.Protobuf;

namespace Bead.Protobuf.Tests;

/// <summary>
/// <see cref="Validators"/>: the validators beadc generates for <c>spec/validations.proto</c>,
/// into <c>Generated/</c>, played by the <c>verdicts</c> of <c>spec/validations.json</c>; what a
/// judging holds, and where it stops. The twins of the TypeScript side's <c>validate.test.ts</c>.
/// </summary>
public sealed class ValidatorsTests
{
    // constants

    private static readonly JsonElement Root = Load();

    private static readonly ViolationRule Empty = new()
    {
        Bounds = Validators.BoundsOf("{\"min_len\":\"1\"}"),
        Message = "must be at least 1 characters",
        RuleId = "string.min_len",
    };

    // * each message of the verdicts, judged as a server judges a request: its payload read by its
    // binding's codec, then its rules
    private static readonly Dictionary<string, Func<byte[], ValidateOptions, Judged>> Judges = new(StringComparer.Ordinal)
    {
        ["bead.validations.v1.Numbers"] = JudgeOf(ValidationsProcedures.JudgeNumbers),
        ["bead.validations.v1.Floats"] = JudgeOf(ValidationsProcedures.JudgeFloats),
        ["bead.validations.v1.Strings"] = JudgeOf(ValidationsProcedures.JudgeStrings),
        ["bead.validations.v1.Bytes"] = JudgeOf(ValidationsProcedures.JudgeBytes),
        ["bead.validations.v1.Enums"] = JudgeOf(ValidationsProcedures.JudgeEnums),
        ["bead.validations.v1.Repeated"] = JudgeOf(ValidationsProcedures.JudgeRepeated),
        ["bead.validations.v1.Maps"] = JudgeOf(ValidationsProcedures.JudgeMaps),
        ["bead.validations.v1.Presence"] = JudgeOf(ValidationsProcedures.JudgePresence),
        ["bead.validations.v1.Wrappers"] = JudgeOf(ValidationsProcedures.JudgeWrappers),
        ["bead.validations.v1.Oneofs"] = JudgeOf(ValidationsProcedures.JudgeOneofs),
        ["bead.validations.v1.Nested"] = JudgeOf(ValidationsProcedures.JudgeNested),
        ["bead.validations.v1.Order"] = JudgeOf(ValidationsProcedures.JudgeOrder),
        ["bead.validations.v1.Patterns"] = JudgeOf(ValidationsProcedures.JudgePatterns),
    };

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(System.IO.File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "validations.json")));

        return document.RootElement.Clone();
    }

    private static Func<byte[], ValidateOptions, Judged> JudgeOf<TRequest>(RequestProcedure<ValidationsProcedures, TRequest, Taken, NoFailure> procedure)
    {
        return (payload, options) =>
        {
            return procedure.Bindings.Validate!(procedure.Bindings.Request.Decode(payload), options);
        };
    }

    private static byte[] BytesOf(string hexadecimal)
    {
        return Convert.FromHexString(hexadecimal.Replace(" ", "", StringComparison.Ordinal));
    }

    // a verdict's payload: its bytes, or its runs end to end
    private static byte[] PayloadOf(JsonElement verdict)
    {
        if (verdict.TryGetProperty("payload", out var payload))
        {
            return BytesOf(payload.GetString()!);
        }

        var written = new List<byte>();

        foreach (var run in verdict.GetProperty("runs").EnumerateArray())
        {
            var bytes = BytesOf(run.GetProperty("bytes").GetString()!);

            for (var time = 0; time < run.GetProperty("times").GetInt32(); time += 1)
            {
                written.AddRange(bytes);
            }
        }

        return [.. written];
    }

    // a violation as one line of text, its bounds in their canonical form, the value that broke it aside
    private static string Shown(Violation violation)
    {
        var bounds = violation.Bounds is { } held ? Encoding.UTF8.GetString(PayloadCodecs.Json.Encode(held).Span) : "-";

        return $"{violation.RuleId} | {violation.FieldPath ?? "-"} | {violation.ForKey} | {violation.Message ?? "-"} | {bounds}";
    }

    private static string Shown(JsonElement written)
    {
        string TextOf(string member)
        {
            return written.TryGetProperty(member, out var value) ? value.GetString()! : "-";
        }

        var bounds = written.TryGetProperty("bounds", out var held) ? Encoding.UTF8.GetString(PayloadCodecs.Json.Encode(held).Span) : "-";
        var forKey = written.TryGetProperty("forKey", out var key) && key.GetBoolean();

        return $"{TextOf("ruleId")} | {TextOf("fieldPath")} | {forKey} | {TextOf("message")} | {bounds}";
    }

    private static Judged JudgedBy<TMessage>(RequestProcedure<ValidationsProcedures, TMessage, Taken, NoFailure> procedure, (TMessage Message, ValidateOptions Options) judging)
    {
        return procedure.Bindings.Validate!(judging.Message, judging.Options);
    }

    private static string[] PathsOf(Judged judged)
    {
        return [.. judged.Violations.Select((violation) =>
        {
            return $"{violation.FieldPath ?? "-"} {violation.RuleId}";
        })];
    }

    // definition

    /// <summary>The names of every verdict.</summary>
    public static TheoryData<string> Verdicts { get; } = new(Root.GetProperty("verdicts").EnumerateArray().Select((entry) =>
    {
        return entry.GetProperty("name").GetString()!;
    }));

    [Theory]
    [MemberData(nameof(Verdicts))]
    public void The_verdicts(string name)
    {
        var verdict = Root.GetProperty("verdicts").EnumerateArray().First((entry) =>
        {
            return entry.GetProperty("name").GetString() == name;
        });
        var options = new ValidateOptions
        {
            FailFast = verdict.TryGetProperty("failFast", out var failFast) && failFast.GetBoolean(),
            MaximumBytes = verdict.TryGetProperty("maximumBytes", out var maximumBytes) ? maximumBytes.GetInt32() : int.MaxValue,
        };
        var judged = Judges[verdict.GetProperty("message").GetString()!](PayloadOf(verdict), options);

        Assert.Equal([.. verdict.GetProperty("violations").EnumerateArray().Select(Shown)], judged.Violations.Select(Shown));
        Assert.Equal(verdict.TryGetProperty("more", out var more) ? more.GetInt64() : 0, judged.More);
        Assert.Equal(verdict.TryGetProperty("stopped", out var stopped) && stopped.GetBoolean(), judged.Stopped);
    }

    [Fact]
    public void Stops_at_the_first_violation_with_FailFast_the_first_of_its_order()
    {
        var order = new Order { Early = 1, Inner = new Inner(), Late = "" };
        var whole = JudgedBy(ValidationsProcedures.JudgeOrder, (order, new ValidateOptions()));
        var first = JudgedBy(ValidationsProcedures.JudgeOrder, (order, new ValidateOptions { FailFast = true }));

        // * fields by their numbers, then the message's own rules
        Assert.Equal(["inner.name string.min_len", "early int32.gt", "late string.min_len", "- message.oneof", "choice required"], PathsOf(whole));
        Assert.False(whole.Stopped);
        Assert.Equal([PathsOf(whole)[0]], PathsOf(first));
        Assert.True(first.Stopped);
        Assert.Equal(0, first.More);
        Assert.EndsWith("\n{\"stopped\":true}", Violations.DetailOf(first, 1_024), StringComparison.Ordinal);
    }

    [Fact]
    public void Judges_a_request_that_breaks_nothing_and_allocates_no_path()
    {
        Repeated TakenOf(int count)
        {
            var taken = new Repeated { Names = { "a" } };

            taken.Many.AddRange(Enumerable.Repeat("x", count));

            return taken;
        }

        long AllocatedBy(Repeated message)
        {
            var before = GC.GetAllocatedBytesForCurrentThread();

            Assert.Same(Judged.None, JudgedBy(ValidationsProcedures.JudgeRepeated, (message, new ValidateOptions())));

            return GC.GetAllocatedBytesForCurrentThread() - before;
        }

        var one = TakenOf(1);
        var many = TakenOf(10_000);

        AllocatedBy(one);
        AllocatedBy(many);

        // * a step into each of 10,000 items allocates nothing: what the judging holds is the same
        // whatever it walks, and nothing of a path
        Assert.Equal(AllocatedBy(one), AllocatedBy(many));
    }

    [Fact]
    public void Holds_no_more_than_its_bound_of_a_request_that_breaks_every_item_and_counts_the_rest()
    {
        var breaking = new Repeated { Names = { "a" } };

        breaking.Many.AddRange(Enumerable.Repeat("", 100_000));

        var options = new ValidateOptions { MaximumBytes = 1_024 };

        JudgedBy(ValidationsProcedures.JudgeRepeated, (breaking, options));

        var before = GC.GetAllocatedBytesForCurrentThread();
        var judged = JudgedBy(ValidationsProcedures.JudgeRepeated, (breaking, options));
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        var detail = Violations.DetailOf(judged, 1_024);

        // * the violations a detail of 1,024 bytes carries, every one of the rest counted, and what
        // the judging holds a detail's worth, not 100,000 violations'
        Assert.InRange(judged.Violations.Count, 1, 10);
        Assert.Equal(100_000, judged.Violations.Count + judged.More);
        Assert.InRange(Encoding.UTF8.GetByteCount(detail), 1, 1_024);
        Assert.EndsWith($"\n{{\"more\":{judged.More}}}", detail, StringComparison.Ordinal);
        Assert.InRange(allocated, 0, 256 * 1_024);
    }

    [Fact]
    public void Judges_a_wrapper_s_value_once_set_and_its_required_while_unset()
    {
        var unset = JudgedBy(ValidationsProcedures.JudgeWrappers, (new Wrappers(), new ValidateOptions()));
        var set = JudgedBy(ValidationsProcedures.JudgeWrappers, (new Wrappers { Count = 0, Title = "", Port = 65_536 }, new ValidateOptions()));
        var taken = JudgedBy(ValidationsProcedures.JudgeWrappers, (new Wrappers { Count = 1, Title = "a" }, new ValidateOptions()));

        // * unset, a wrapper is judged by its required alone; set, by its scalar's rules on its value,
        // its path the field, never its value
        Assert.Equal(["title required"], PathsOf(unset));
        Assert.Equal(["count int32.gt", "title string.min_len", "port uint32.lte"], PathsOf(set));
        Assert.Equal((object)0, set.Violations[0].Value);
        Assert.Same(Judged.None, taken);
    }

    [Fact]
    public void Keeps_the_value_a_violation_broke_on_the_side_that_judged()
    {
        var judged = JudgedBy(ValidationsProcedures.JudgeNumbers, (new Numbers { AtMostTen = 11 }, new ValidateOptions()));
        var violation = Assert.Single(judged.Violations);

        Assert.Equal("int32.lte | at_most_ten | False | must be less than or equal to 10 | {\"lte\":10}", Shown(violation));
        Assert.Equal((object)11, violation.Value);
    }

    [Fact]
    public void Holds_every_violation_without_a_bound_and_stops_where_its_rules_say_so_under_FailFast()
    {
        bool Rules(object request, IViolationSink sink)
        {
            foreach (var index in new[] { 0, 1, 2 })
            {
                sink.EnterIndex("names", index);

                if (sink.Add(Empty, ""))
                {
                    return true;
                }

                sink.Leave();
            }

            return false;
        }

        var validate = Validators.Of<object>(Rules);
        var stopped = validate(new object(), new ValidateOptions { FailFast = true });

        Assert.Equal(["names[0] string.min_len", "names[1] string.min_len", "names[2] string.min_len"], PathsOf(validate(new object(), new ValidateOptions())));
        Assert.Equal(["names[0] string.min_len"], PathsOf(stopped));
        Assert.Equal(0, stopped.More);
        Assert.True(stopped.Stopped);

        // a bound that holds no line of it: counted, and stopped all the same
        var counted = validate(new object(), new ValidateOptions { FailFast = true, MaximumBytes = 0 });

        Assert.Empty(counted.Violations);
        Assert.Equal(1, counted.More);
        Assert.True(counted.Stopped);
    }

    [Fact]
    public void Renders_a_key_as_spec_18_4_does_whole_within_64_bytes_else_cut_on_a_character_and_marked()
    {
        string? PathOf(Action<IViolationSink> enter)
        {
            var validate = Validators.Of<object>((request, sink) =>
            {
                enter(sink);

                return sink.Add(Empty, null);
            });

            return validate(new object(), new ValidateOptions()).Violations[0].FieldPath;
        }

        Assert.Equal("keyed[\"a\\tb\\u0001\"]", PathOf((sink) =>
        {
            sink.EnterKey("keyed", "a\tb\u0001");
        }));
        Assert.Equal("keyed[-1]", PathOf((sink) =>
        {
            sink.EnterKey("keyed", -1L);
        }));
        Assert.Equal("keyed[18446744073709551615]", PathOf((sink) =>
        {
            sink.EnterKey("keyed", ulong.MaxValue);
        }));
        Assert.Equal("keyed[true]", PathOf((sink) =>
        {
            sink.EnterKey("keyed", true);
        }));
        Assert.Equal($"keyed[\"{new string('k', 63)}\"...]", PathOf((sink) =>
        {
            sink.EnterKey("keyed", new string('k', 63) + "é");
        }));
        Assert.Equal("keyed[\"�\"]", PathOf((sink) =>
        {
            sink.EnterKey("keyed", "\uD800");
        }));
    }

    [Fact]
    public void Counts_a_string_in_code_points_and_in_UTF_8_bytes()
    {
        Assert.Equal(3, Validators.CodePointLength("😀ab"));
        Assert.Equal(6, Validators.Utf8Length("😀ab"));
        Assert.Equal(3, Validators.Utf8Length("\uD800"));
    }

    [Fact]
    public void Holds_items_unique_as_equals_equals_compares_them_0_and_minus_0_one_two_NaN_two_bytes_by_their_bytes()
    {
        Assert.False(Validators.IsUnique([0d, -0d]));
        Assert.True(Validators.IsUnique([double.NaN, double.NaN]));
        Assert.False(Validators.IsUnique([double.NaN, double.NaN, 1d, 1d]));
        Assert.False(Validators.IsUnique([0f, -0f]));
        Assert.True(Validators.IsUnique([float.NaN, float.NaN]));
        Assert.False(Validators.IsUnique([float.NaN, float.NaN, 1f, 1f]));
        Assert.False(Validators.IsUnique<long>([1L, 1L]));
        Assert.False(Validators.IsUnique([ByteString.CopyFrom(1), ByteString.CopyFrom(1)]));
        Assert.True(Validators.IsUnique([ByteString.CopyFrom(1), ByteString.CopyFrom(2)]));
    }

    [Fact]
    public void Orders_a_map_s_entries_by_key_integers_ascending_false_before_true_strings_by_code_points()
    {
        IEnumerable<TKey> KeysOf<TKey>(Dictionary<TKey, int> map)
            where TKey : notnull
        {
            return Validators.ByKey(map).Select((entry) =>
            {
                return entry.Key;
            });
        }

        Assert.Equal([-1L, 3L, 10L], KeysOf(new Dictionary<long, int> { [10] = 0, [3] = 0, [-1] = 0 }));
        Assert.Equal([false, true], KeysOf(new Dictionary<bool, int> { [true] = 0, [false] = 0 }));
        Assert.Equal(["a", "zz", "", "😀"], KeysOf(new Dictionary<string, int> { [""] = 0, ["😀"] = 0, ["zz"] = 0, ["a"] = 0 }));
        Assert.Empty(KeysOf(new Dictionary<string, int>()));
    }
}
