using System.Text;
using System.Text.Json;
using Bead.Validations.V1;

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
}
