using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Bead;

/// <summary>
/// A violation, the breach of one rule of a procedure's request (spec 18.3): its path, its rule's
/// id, the bounds its rule takes, its words and whether it is a map key's. The value that broke it
/// stays on the side that judged, in <see cref="Value"/>, and never travels.
/// </summary>
public sealed record Violation
{
    /// <summary>The path from the request's message to the field (18.4); none for a rule of the message itself.</summary>
    public string? FieldPath { get; init; }

    /// <summary>The rule's id, protovalidate's <c>rule_id</c>: <c>string.min_len</c>, <c>required</c>, say.</summary>
    public required string RuleId { get; init; }

    /// <summary>
    /// The members its rule takes, a JSON object as protobuf's JSON mapping writes them; none for a
    /// rule that takes none.
    /// </summary>
    public JsonElement? Bounds { get; init; }

    /// <summary>Its words (18.8.6); none for a violation read without them that its rule and bounds give none of.</summary>
    public string? Message { get; init; }

    /// <summary>Whether it is a map key's.</summary>
    public bool ForKey { get; init; }

    /// <summary>The value that broke it, held by the side that judged; never written in a detail (decision 0035).</summary>
    public object? Value { get; init; }
}

/// <summary>
/// What a judging gives: the violations a detail can carry, in spec 18.5's order, the count of the
/// rest, and whether it stopped at its first violation (failFast).
/// </summary>
public sealed record Judged
{
    /// <summary>A judging that found nothing.</summary>
    public static Judged None { get; } = new() { Violations = [] };

    /// <summary>The violations it kept, in their order.</summary>
    public required IReadOnlyList<Violation> Violations { get; init; }

    /// <summary>The violations it judged and kept no more of than their count.</summary>
    public long More { get; init; }

    /// <summary>Whether it stopped at its first violation.</summary>
    public bool Stopped { get; init; }

    /// <summary>Whether its request is refused: a violation kept, or one counted.</summary>
    public bool Refuses
    {
        get
        {
            return Violations.Count > 0 || More > 0;
        }
    }
}

/// <summary>What a validator is given: whether it stops at its first violation, and its detail's bound.</summary>
public sealed record ValidateOptions
{
    /// <summary>Whether it stops at its first violation, protovalidate's <c>failFast</c>; it judges every rule when false.</summary>
    public bool FailFast { get; init; }

    /// <summary>
    /// The bound of the detail its violations are written in, in bytes: it keeps the violations a
    /// detail of this bound carries, and counts the rest (18.6). No bound when none is given.
    /// </summary>
    public int MaximumBytes { get; init; } = int.MaxValue;
}

/// <summary>
/// What judges a request's value by its procedure's rules (spec section 18): its violations, the
/// count of those it keeps no more of, and whether it stopped. One that throws is a side's own error,
/// answered <see cref="ProtocolCode.ProcedureFailed"/> and reported.
/// </summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
public delegate Judged RequestValidator<in TRequest>(TRequest request, ValidateOptions options);

/// <summary>
/// What a reader reads of a <see cref="ProtocolCode.PayloadInvalid"/>'s detail (spec 18.7): its
/// violations, the count its closing line gives, none where it has none, and whether its side
/// stopped.
/// </summary>
public sealed record ViolationsRead
{
    /// <summary>A detail that gives nothing.</summary>
    public static ViolationsRead None { get; } = new() { Violations = [] };

    /// <summary>Its violations, in their order.</summary>
    public required IReadOnlyList<Violation> Violations { get; init; }

    /// <summary>The violations its detail left out, by its closing line; none where it carries no count.</summary>
    public long? More { get; init; }

    /// <summary>Whether its closing line says its side stopped at its first violation.</summary>
    public bool Stopped { get; init; }
}

/// <summary>
/// A <see cref="ProtocolCode.PayloadInvalid"/>'s detail (spec 18.6, 18.7): lines of canonical JSON,
/// a violation a line in their order, then a closing line, <c>{"more":N}</c> or
/// <c>{"stopped":true}</c>, written under a bound and read back, each whole line kept; and a rule's
/// words, 18.8.6's, from its id and its bounds.
/// </summary>
public static class Violations
{
    // constants

    /// <summary>The bytes a writer keeps for its closing line: its line feed, and <c>{"more":N}</c> at its longest, N below 2⁵³.</summary>
    public const int ClosingBytes = 26;

    // the largest count a closing line writes, as I-JSON holds an integer (RFC 7493 §2.2)
    private const long LargestCount = 9_007_199_254_740_991;

    // a string key's subscript holds 64 bytes of its UTF-8 at most (18.4)
    private const int KeyBytes = 64;

    private const string Hexadecimal = "0123456789abcdef";

    // the rules protovalidate plays itself, and whose words their bounds do not give (18.8.6)
    private const string DefinedOnlyWords = "value must be one of the defined enum values";
    private const string UniqueWords = "repeated value must contain unique items";

    private static readonly byte[] Stopped = "{\"stopped\":true}"u8.ToArray();

    // the types whose rules compare numbers, by their rules' message's name
    private static readonly HashSet<string> NumberTypes = new(StringComparer.Ordinal)
    {
        "float", "double", "int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64",
    };

    // helpers

    // a violation's line, whole, without its message, or without its bounds too: none past the room
    private static ReadOnlyMemory<byte>? LineOf(Violation violation, int room)
    {
        var whole = Written(violation, (true, true));

        if (whole.Length <= room)
        {
            return whole;
        }

        if (violation.Message is not null)
        {
            var bare = Written(violation, (false, true));

            if (bare.Length <= room)
            {
                return bare;
            }
        }

        if (violation.Bounds is not null)
        {
            var shortest = Written(violation, (false, false));

            if (shortest.Length <= room)
            {
                return shortest;
            }
        }

        return null;
    }

    // a violation as one JSON text in section 17.7's form: its members by their names' UTF-16 code
    // units, bounds, fieldPath, forKey, message, ruleId; the value that broke it never
    private static ReadOnlyMemory<byte> Written(Violation violation, (bool Message, bool Bounds) kept)
    {
        var written = new ArrayBufferWriter<byte>(128);
        var isFirst = true;

        void Member(ReadOnlySpan<byte> name, ReadOnlySpan<byte> value)
        {
            written.Write(isFirst ? "{"u8 : ","u8);
            isFirst = false;
            written.Write(name);
            written.Write(value);
        }

        if (kept.Bounds && violation.Bounds is { } bounds)
        {
            Member("\"bounds\":"u8, Payloads.WriteJson(bounds).Span);
        }

        if (violation.FieldPath is { } fieldPath)
        {
            Member("\"fieldPath\":"u8, Payloads.WriteJsonString(fieldPath).Span);
        }

        if (violation.ForKey)
        {
            Member("\"forKey\":"u8, "true"u8);
        }

        if (kept.Message && violation.Message is { } message)
        {
            Member("\"message\":"u8, Payloads.WriteJsonString(message).Span);
        }

        Member("\"ruleId\":"u8, Payloads.WriteJsonString(violation.RuleId).Span);
        written.Write("}"u8);

        return written.WrittenMemory;
    }

    // the violation a line reads as, or none: an object of 18.3's members alone, each of its type
    private static Violation? ViolationOf(JsonElement line)
    {
        if (line.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        string? ruleId = null;
        string? fieldPath = null;
        string? message = null;
        JsonElement? bounds = null;
        var forKey = false;

        foreach (var member in line.EnumerateObject())
        {
            var value = member.Value;
            var isHeld = member.Name switch
            {
                "ruleId" => TextOf(value, out ruleId),
                "fieldPath" => TextOf(value, out fieldPath),
                "message" => TextOf(value, out message),
                "bounds" => BoundsOf(value, out bounds),
                "forKey" => forKey = value.ValueKind == JsonValueKind.True,
                _ => false,
            };

            if (!isHeld)
            {
                return null;
            }
        }

        if (ruleId is null)
        {
            return null;
        }

        var read = new Violation { Bounds = bounds, FieldPath = fieldPath, ForKey = forKey, Message = message, RuleId = ruleId };

        // * a violation written without its words takes those its rule and bounds give (18.7)
        return message is null ? read with { Message = WordsOf(read) } : read;
    }

    private static bool TextOf(JsonElement value, out string? text)
    {
        text = value.ValueKind == JsonValueKind.String ? value.GetString() : null;

        return !string.IsNullOrEmpty(text);
    }

    private static bool BoundsOf(JsonElement value, out JsonElement? bounds)
    {
        var isHeld = value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Any();

        bounds = isHeld ? value : null;

        return isHeld;
    }

    // what a closing line says: its count, that its side stopped, or that it is none
    private static (bool IsClosing, long? More, bool Stopped) ClosingOf(JsonElement line)
    {
        if (line.ValueKind != JsonValueKind.Object || line.GetPropertyCount() != 1)
        {
            return (false, null, false);
        }

        if (line.TryGetProperty("stopped", out var stopped))
        {
            return stopped.ValueKind == JsonValueKind.True ? (true, null, true) : (false, null, false);
        }

        if (line.TryGetProperty("more", out var more)
            && more.ValueKind == JsonValueKind.Number
            && more.TryGetInt64(out var count)
            && count is >= 0 and <= LargestCount)
        {
            return (true, count, false);
        }

        return (false, null, false);
    }

    // a number or a string of a rule's bounds as its words write it, `%s`: a string as it is, a
    // number as section 17.7.4 writes the double it is; none for anything else
    private static string? WordOf(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => Encoding.UTF8.GetString(Payloads.WriteJson(value).Span),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null,
        };
    }

    private static string? MemberWordOf(JsonElement bounds, string name)
    {
        return bounds.TryGetProperty(name, out var value) ? WordOf(value) : null;
    }

    // a list as its words write it: `[`, its items by `, `, `]`
    private static string? ListWordsOf(JsonElement bounds, string name)
    {
        if (!bounds.TryGetProperty(name, out var list) || list.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var words = new List<string>();

        foreach (var item in list.EnumerateArray())
        {
            if (WordOf(item) is not { } word)
            {
                return null;
            }

            words.Add(word);
        }

        return "[" + string.Join(", ", words) + "]";
    }

    // bytes, given in base64 as the mapping writes them, in lower-case hexadecimal: `%x`
    private static string? HexOf(JsonElement bounds, string name)
    {
        if (MemberWordOf(bounds, name) is not { } base64)
        {
            return null;
        }

        byte[] bytes;

        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return null;
        }

        var hex = new StringBuilder(bytes.Length * 2);

        foreach (var value in bytes)
        {
            hex.Append(Hexadecimal[value >> 4]).Append(Hexadecimal[value & 0xF]);
        }

        return hex.ToString();
    }

    private static string? Words(string? word, Func<string, string> words)
    {
        return word is null ? null : words(word);
    }

    // a number's rule's words, by its member: a bound, a range, a constant, a list
    private static string? NumberWordsOf(string rule, JsonElement bounds)
    {
        switch (rule)
        {
            case "const":
                return Words(MemberWordOf(bounds, "const"), (word) =>
                {
                    return $"must equal {word}";
                });
            case "lt" or "lte":
                return Words(MemberWordOf(bounds, rule), (word) =>
                {
                    return $"must be {LessOf(rule)}{word}";
                });
            case "gt" or "gte":
                return Words(MemberWordOf(bounds, rule), (word) =>
                {
                    return $"must be {GreaterOf(rule)}{word}";
                });
            case "in" or "not_in":
                return Words(ListWordsOf(bounds, rule), (word) =>
                {
                    return $"must {(rule == "in" ? "" : "not ")}be in list {word}";
                });
            default:
                return RangeWordsOf(rule, bounds);
        }
    }

    private static string LessOf(string member)
    {
        return member == "lte" ? "less than or equal to " : "less than ";
    }

    private static string GreaterOf(string member)
    {
        return member == "gte" ? "greater than or equal to " : "greater than ";
    }

    // a range's words: `gt_lt`, `gte_lte_exclusive` and their kin, the reversed one taken outside
    private static string? RangeWordsOf(string rule, JsonElement bounds)
    {
        var exclusive = rule.EndsWith("_exclusive", StringComparison.Ordinal);
        var members = (exclusive ? rule[..^"_exclusive".Length] : rule).Split('_');

        if (members is not [var lower and ("gt" or "gte"), var upper and ("lt" or "lte")]
            || MemberWordOf(bounds, lower) is not { } low
            || MemberWordOf(bounds, upper) is not { } high)
        {
            return null;
        }

        return $"must be {GreaterOf(lower)}{low} {(exclusive ? "or" : "and")} {LessOf(upper)}{high}";
    }

    // a string's rule's words
    private static string? StringWordsOf(string rule, JsonElement bounds)
    {
        string? Quoted(string words)
        {
            return Words(MemberWordOf(bounds, rule), (word) =>
            {
                return $"{words} `{word}`";
            });
        }

        string? Counted(Func<string, string> words)
        {
            return Words(MemberWordOf(bounds, rule), words);
        }

        return rule switch
        {
            "const" => Quoted("must equal"),
            "min_len" => Counted((count) => { return $"must be at least {count} characters"; }),
            "max_len" => Counted((count) => { return $"must be at most {count} characters"; }),
            "len" => Counted((count) => { return $"must be {count} characters"; }),
            "min_bytes" => Counted((count) => { return $"must be at least {count} bytes"; }),
            "max_bytes" => Counted((count) => { return $"must be at most {count} bytes"; }),
            "len_bytes" => Counted((count) => { return $"must be {count} bytes"; }),
            "pattern" => Quoted("does not match regex pattern"),
            "prefix" => Quoted("does not have prefix"),
            "suffix" => Quoted("does not have suffix"),
            "contains" => Quoted("does not contain substring"),
            "not_contains" => Quoted("contains substring"),
            "in" or "not_in" => Words(ListWordsOf(bounds, rule), (word) =>
            {
                return $"must {(rule == "in" ? "" : "not ")}be in list {word}";
            }),
            _ => null,
        };
    }

    // bytes' rule's words
    private static string? BytesWordsOf(string rule, JsonElement bounds)
    {
        string? Hexed(string words)
        {
            return Words(HexOf(bounds, rule), (hex) =>
            {
                return $"{words} {hex}";
            });
        }

        string? Counted(Func<string, string> words)
        {
            return Words(MemberWordOf(bounds, rule), words);
        }

        return rule switch
        {
            "const" => Hexed("must be"),
            "min_len" => Counted((count) => { return $"must be at least {count} bytes"; }),
            "max_len" => Counted((count) => { return $"must be at most {count} bytes"; }),
            "len" => Counted((count) => { return $"must be {count} bytes"; }),
            "prefix" => Hexed("does not have prefix"),
            "suffix" => Hexed("does not have suffix"),
            "contains" => Hexed("does not contain"),
            _ => null,
        };
    }

    // a repeated field's or a map's rule's words
    private static string? CountWordsOf(string ruleId, JsonElement bounds)
    {
        var (member, words) = ruleId switch
        {
            "repeated.min_items" => ("min_items", "must contain at least {0} item(s)"),
            "repeated.max_items" => ("max_items", "must contain no more than {0} item(s)"),
            "map.min_pairs" => ("min_pairs", "map must be at least {0} entries"),
            "map.max_pairs" => ("max_pairs", "map must be at most {0} entries"),
            _ => ((string?)null, ""),
        };

        return member is null
            ? null
            : Words(MemberWordOf(bounds, member), (count) =>
            {
                return string.Format(CultureInfo.InvariantCulture, words, count);
            });
    }

    // definition

    /// <summary>
    /// The detail of a <see cref="ProtocolCode.PayloadInvalid"/> that <paramref name="judged"/>
    /// answers, under <paramref name="maximumBytes"/> (spec 18.6): its violations' lines in their
    /// order while they hold with <see cref="ClosingBytes"/> kept, each whole, or without its
    /// message, then without its bounds too, the first that holds in none ending them and counted
    /// with every one after it; then the closing line. A bound that holds no closing line gives an
    /// empty detail.
    /// </summary>
    public static string DetailOf(Judged judged, int maximumBytes)
    {
        ArgumentNullException.ThrowIfNull(judged);
        ArgumentOutOfRangeException.ThrowIfNegative(maximumBytes);

        var written = new ArrayBufferWriter<byte>(Math.Min(Math.Max(maximumBytes, 1), 1_024));
        var lines = 0;
        var more = judged.More;
        var isFull = false;

        foreach (var violation in judged.Violations)
        {
            var room = maximumBytes - written.WrittenCount - (lines > 0 ? 1 : 0) - ClosingBytes;

            if (isFull || LineOf(violation, room) is not { } line)
            {
                isFull = true;
                more += 1;

                continue;
            }

            if (lines > 0)
            {
                written.Write("\n"u8);
            }

            written.Write(line.Span);
            lines += 1;
        }

        var closing = judged.Stopped
            ? Stopped
            : Encoding.ASCII.GetBytes(string.Create(CultureInfo.InvariantCulture, $"{{\"more\":{Math.Min(more, LargestCount)}}}"));

        if (written.WrittenCount + (lines > 0 ? 1 : 0) + closing.Length > maximumBytes)
        {
            return "";
        }

        if (lines > 0)
        {
            written.Write("\n"u8);
        }

        written.Write(closing);

        return Encoding.UTF8.GetString(written.WrittenSpan);
    }

    /// <summary>
    /// The bytes of the line a detail writes of <paramref name="violation"/> within
    /// <paramref name="room"/> bytes: whole, or without its message, then without its bounds too
    /// (spec 18.6); -1 where none holds. What a validator's sink sizes a violation by, as the
    /// writer will.
    /// </summary>
    public static int LineBytesOf(Violation violation, int room)
    {
        ArgumentNullException.ThrowIfNull(violation);

        return LineOf(violation, room) is { } line ? line.Length : -1;
    }

    /// <summary>
    /// A string key's subscript in a field's path (spec 18.4): the key in section 17.7's form when
    /// its UTF-8 holds in 64 bytes; otherwise its first 64 bytes, back to the start of the character
    /// the cut fell in, then <c>...</c> outside its quotation marks. A surrogate alone is written as
    /// U+FFFD, as its UTF-8 would carry it.
    /// </summary>
    public static string KeySubscriptOf(string key)
    {
        ArgumentNullException.ThrowIfNull(key);

        var kept = new StringBuilder(key.Length);
        var bytes = 0;
        var isCut = false;

        for (var index = 0; index < key.Length;)
        {
            Rune.DecodeFromUtf16(key.AsSpan(index), out var rune, out var consumed);

            if (bytes + rune.Utf8SequenceLength > KeyBytes)
            {
                isCut = true;

                break;
            }

            kept.Append(rune.ToString());
            bytes += rune.Utf8SequenceLength;
            index += consumed;
        }

        var written = Encoding.UTF8.GetString(Payloads.WriteJsonString(kept.ToString()).Span);

        return isCut ? written + "..." : written;
    }

    /// <summary>
    /// The violations <paramref name="failure"/> carries: its detail read (spec 18.7) when it is a
    /// <see cref="ProtocolCode.PayloadInvalid"/>, none otherwise.
    /// </summary>
    public static ViolationsRead Of(Failure failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return failure.Scope == FailureScope.Protocol && failure.Code == (ushort)ProtocolCode.PayloadInvalid
            ? Read(failure.Detail)
            : ViolationsRead.None;
    }

    /// <summary>
    /// A <see cref="ProtocolCode.PayloadInvalid"/>'s detail read line by line (spec 18.7), each line
    /// as a <c>json</c> payload is read (17.5): the lines that read as violations, up to the first
    /// that does not, then a closing line's count or its stop. A detail cut keeps its whole lines,
    /// and one with no closing line counts nothing; a violation without its words takes those its
    /// rule and bounds give, where they give them.
    /// </summary>
    public static ViolationsRead Read(string detail)
    {
        ArgumentNullException.ThrowIfNull(detail);

        var violations = new List<Violation>();

        foreach (var text in detail.Split('\n'))
        {
            JsonElement line;

            try
            {
                line = Payloads.ReadJson(Encoding.UTF8.GetBytes(text));
            }
            catch (FormatException)
            {
                break;
            }

            if (ClosingOf(line) is (true, var more, var stopped))
            {
                return new ViolationsRead { More = more, Stopped = stopped, Violations = violations };
            }

            if (ViolationOf(line) is not { } violation)
            {
                break;
            }

            violations.Add(violation);
        }

        return violations.Count == 0 ? ViolationsRead.None : new ViolationsRead { Violations = violations };
    }

    /// <summary>
    /// The words spec 18.8.6 gives <paramref name="violation"/>'s rule, from its id and its bounds:
    /// none for a rule whose words depend on what was judged, <c>required</c> and
    /// <c>message.oneof</c>, a CEL rule's, or one whose bounds lack what its words need.
    /// </summary>
    public static string? WordsOf(Violation violation)
    {
        ArgumentNullException.ThrowIfNull(violation);

        var ruleId = violation.RuleId;

        switch (ruleId)
        {
            case "enum.defined_only":
                return DefinedOnlyWords;
            case "repeated.unique":
                return UniqueWords;
        }

        var dot = ruleId.IndexOf('.', StringComparison.Ordinal);

        if (dot < 0)
        {
            return null;
        }

        var (type, rule) = (ruleId[..dot], ruleId[(dot + 1)..]);

        if (rule == "finite" && type is "float" or "double")
        {
            return "must be finite";
        }

        if (violation.Bounds is not { ValueKind: JsonValueKind.Object } bounds)
        {
            return null;
        }

        return type switch
        {
            "string" => StringWordsOf(rule, bounds),
            "bytes" => BytesWordsOf(rule, bounds),
            "bool" when rule == "const" => Words(MemberWordOf(bounds, "const"), (word) => { return $"must equal {word}"; }),
            "enum" when rule is "const" or "in" or "not_in" => NumberWordsOf(rule, bounds),
            "repeated" or "map" => CountWordsOf(ruleId, bounds),
            _ when NumberTypes.Contains(type) => NumberWordsOf(rule, bounds),
            _ => null,
        };
    }
}
