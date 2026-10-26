using System.Buffers;
using System.Collections.Frozen;
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

    /// <summary>The bytes a writer keeps for its closing line: its line feed, and <c>{"more":N}</c> at its longest, N at 2⁵³ − 1.</summary>
    public const int ClosingBytes = 26;

    // the largest count a closing line writes and reads, the largest integer an I-JSON number holds
    // exactly (RFC 7493 §2.2)
    private const long LargestCount = 9_007_199_254_740_991;

    // a string key's subscript holds 64 bytes of its UTF-8 at most (18.4)
    private const int KeyBytes = 64;

    private static readonly byte[] Stopped = "{\"stopped\":true}"u8.ToArray();

    private static readonly SearchValues<char> Base64Alphabet = SearchValues.Create("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");

    // the twelve number types of validate.proto's rules
    private static readonly string[] NumberTypes =
    [
        "float", "double", "int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64",
    ];

    // a number's bounds, its upper ones then its lower ones, each with its words
    private static readonly (string Member, string Words)[] BoundWords =
    [
        ("lt", "less than"), ("lte", "less than or equal to"), ("gt", "greater than"), ("gte", "greater than or equal to"),
    ];

    // * the templates of the rules beadc compiles: a reader gives words to these alone (18.8.6)
    private static readonly FrozenDictionary<string, Template> Templates = TemplatesOf();

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
    // units, bounds, fieldPath, forKey, message, ruleId, none empty (18.6); the value that broke it never
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

        if (kept.Bounds && violation.Bounds is { ValueKind: JsonValueKind.Object } bounds && bounds.GetPropertyCount() > 0)
        {
            Member("\"bounds\":"u8, Payloads.WriteJson(bounds).Span);
        }

        if (violation.FieldPath is { Length: > 0 } fieldPath)
        {
            Member("\"fieldPath\":"u8, Payloads.WriteJsonString(fieldPath).Span);
        }

        if (violation.ForKey)
        {
            Member("\"forKey\":"u8, "true"u8);
        }

        if (kept.Message && violation.Message is { Length: > 0 } message)
        {
            Member("\"message\":"u8, Payloads.WriteJsonString(message).Span);
        }

        Member("\"ruleId\":"u8, Payloads.WriteJsonString(violation.RuleId).Span);
        written.Write("}"u8);

        return written.WrittenMemory;
    }

    // the violation a line reads as, or none: an object of 18.3's members alone, each of its type, a
    // member empty taken as absent, a fieldPath or a message of "", a bounds of {}, a forKey of false,
    // as protovalidate drops an empty field path or message (18.7)
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
                "ruleId" => IdOf(value, out ruleId),
                "fieldPath" => TextOf(value, out fieldPath),
                "message" => TextOf(value, out message),
                "bounds" => BoundsOf(value, out bounds),
                "forKey" => FlagOf(value, out forKey),
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

    // a rule's id: any string, "" an id-less CEL rule's
    private static bool IdOf(JsonElement value, out string? id)
    {
        id = value.ValueKind == JsonValueKind.String ? value.ToString() : null;

        return id is not null;
    }

    // a string member: absent where it is empty
    private static bool TextOf(JsonElement value, out string? text)
    {
        if (value.ValueKind != JsonValueKind.String)
        {
            text = null;

            return false;
        }

        var held = value.ToString();

        text = held.Length > 0 ? held : null;

        return true;
    }

    // the bounds: an object, absent where it holds no member
    private static bool BoundsOf(JsonElement value, out JsonElement? bounds)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            bounds = null;

            return false;
        }

        bounds = value.GetPropertyCount() > 0 ? value : null;

        return true;
    }

    private static bool FlagOf(JsonElement value, out bool flag)
    {
        flag = value.ValueKind == JsonValueKind.True;

        return flag || value.ValueKind == JsonValueKind.False;
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

        if (!line.TryGetProperty("more", out var more) || more.ValueKind != JsonValueKind.Number)
        {
            return (false, null, false);
        }

        // * a count is an integer from 0 to 2⁵³ − 1, its number read as the double nearest it (17.6,
        // 18.7); any other leaves the detail uncounted
        var count = more.GetDouble();

        return double.IsInteger(count) && count is >= 0 and <= LargestCount ? (true, (long)count, false) : (false, null, false);
    }

    // a number or a string of a rule's bounds as its words write it, `%s`: a string as it is, a
    // number as section 17.7.4 writes the double it is, a literal; none for anything else
    private static string? WordOf(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.String => value.ToString(),
            JsonValueKind.Number => Encoding.UTF8.GetString(Payloads.WriteJson(value).Span),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null,
        };
    }

    // a list as its words write it: `[`, its items by `, `, `]`; none where an item is no scalar
    private static string? ListWordsOf(JsonElement list)
    {
        if (list.ValueKind != JsonValueKind.Array)
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

    // base64 as RFC 4648 §4 writes it: its standard alphabet, by fours, padded to the last
    private static bool IsBase64(string text)
    {
        if (text.Length % 4 != 0)
        {
            return false;
        }

        var padding = text.EndsWith("==", StringComparison.Ordinal) ? 2 : text.EndsWith('=') ? 1 : 0;

        return !text.AsSpan(0, text.Length - padding).ContainsAnyExcept(Base64Alphabet);
    }

    // bytes, given in base64 as the mapping writes them, in lower-case hexadecimal: `%x`; none in any
    // other form
    private static string? HexOf(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String || !IsBase64(value.ToString()))
        {
            return null;
        }

        return Convert.ToHexStringLower(Convert.FromBase64String(value.ToString()));
    }

    // a member's words, as its placeholder writes it: bytes in hexadecimal, `in` and `not_in` as a
    // list of scalars, any other a scalar; none where it is missing or of another shape
    private static string? MemberWordsOf(Placeholder placeholder, JsonElement? bounds)
    {
        if (bounds is not { ValueKind: JsonValueKind.Object } held || !held.TryGetProperty(placeholder.Name, out var value))
        {
            return null;
        }

        if (placeholder.IsBytes)
        {
            return HexOf(value);
        }

        return placeholder.Name is "in" or "not_in" ? ListWordsOf(value) : WordOf(value);
    }

    // the template of `words`, each of its placeholders, `%s`, `%d` or `%x`, written from the member
    // of `members` beside it, the words after it up to the next its tail
    private static Template TemplateOf(string words, string[] members)
    {
        var placeholders = new List<Placeholder>(members.Length);
        var at = words.IndexOf('%', StringComparison.Ordinal);
        var head = at < 0 ? words : words[..at];

        foreach (var member in members)
        {
            var next = words.IndexOf('%', at + 2);
            var tail = next < 0 ? words[(at + 2)..] : words[(at + 2)..next];

            placeholders.Add(new Placeholder(member, words[at + 1] == 'x', tail));
            at = next;
        }

        return new Template(head, placeholders);
    }

    // the templates of the rules beadc compiles, by their ids, each its rule's in validate.proto: a
    // number type's by its members, its ranges reversed or not among them, then every other type's
    private static FrozenDictionary<string, Template> TemplatesOf()
    {
        var rules = new List<(string RuleId, string Words, string[] Members)>();

        foreach (var type in NumberTypes)
        {
            rules.Add(($"{type}.const", "must equal %s", ["const"]));

            foreach (var (member, words) in BoundWords)
            {
                rules.Add(($"{type}.{member}", $"must be {words} %s", [member]));
            }

            foreach (var (lower, lowerWords) in BoundWords[2..])
            {
                foreach (var (upper, upperWords) in BoundWords[..2])
                {
                    rules.Add(($"{type}.{lower}_{upper}", $"must be {lowerWords} %s and {upperWords} %s", [lower, upper]));
                    rules.Add(($"{type}.{lower}_{upper}_exclusive", $"must be {lowerWords} %s or {upperWords} %s", [lower, upper]));
                }
            }

            rules.Add(($"{type}.in", "must be in list %s", ["in"]));
            rules.Add(($"{type}.not_in", "must not be in list %s", ["not_in"]));
        }

        rules.AddRange(
        [
            ("float.finite", "must be finite", []),
            ("double.finite", "must be finite", []),
            ("bool.const", "must equal %s", ["const"]),
            ("string.const", "must equal `%s`", ["const"]),
            ("string.len", "must be %s characters", ["len"]),
            ("string.min_len", "must be at least %s characters", ["min_len"]),
            ("string.max_len", "must be at most %s characters", ["max_len"]),
            ("string.len_bytes", "must be %s bytes", ["len_bytes"]),
            ("string.min_bytes", "must be at least %s bytes", ["min_bytes"]),
            ("string.max_bytes", "must be at most %s bytes", ["max_bytes"]),
            ("string.pattern", "does not match regex pattern `%s`", ["pattern"]),
            ("string.prefix", "does not have prefix `%s`", ["prefix"]),
            ("string.suffix", "does not have suffix `%s`", ["suffix"]),
            ("string.contains", "does not contain substring `%s`", ["contains"]),
            ("string.not_contains", "contains substring `%s`", ["not_contains"]),
            ("string.in", "must be in list %s", ["in"]),
            ("string.not_in", "must not be in list %s", ["not_in"]),
            ("bytes.const", "must be %x", ["const"]),
            ("bytes.len", "must be %s bytes", ["len"]),
            ("bytes.min_len", "must be at least %s bytes", ["min_len"]),
            ("bytes.max_len", "must be at most %s bytes", ["max_len"]),
            ("bytes.prefix", "does not have prefix %x", ["prefix"]),
            ("bytes.suffix", "does not have suffix %x", ["suffix"]),
            ("bytes.contains", "does not contain %x", ["contains"]),
            ("enum.const", "must equal %s", ["const"]),
            ("enum.defined_only", "value must be one of the defined enum values", []),
            ("enum.in", "must be in list %s", ["in"]),
            ("enum.not_in", "must not be in list %s", ["not_in"]),
            ("repeated.min_items", "must contain at least %d item(s)", ["min_items"]),
            ("repeated.max_items", "must contain no more than %s item(s)", ["max_items"]),
            ("repeated.unique", "repeated value must contain unique items", []),
            ("map.min_pairs", "map must be at least %d entries", ["min_pairs"]),
            ("map.max_pairs", "map must be at most %d entries", ["max_pairs"]),
        ]);

        return rules.ToFrozenDictionary(
            (rule) =>
            {
                return rule.RuleId;
            },
            (rule) =>
            {
                return TemplateOf(rule.Words, rule.Members);
            },
            StringComparer.Ordinal);
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
    /// The words spec 18.8.6 gives <paramref name="violation"/>'s rule, from its id and its bounds,
    /// for the rules beadc compiles alone, by their templates in <c>validate.proto</c>: none for
    /// another id, as <c>required</c>'s and <c>message.oneof</c>'s, which depend on what was judged,
    /// or a CEL rule's, nor where a member its template takes is missing or of another shape.
    /// </summary>
    public static string? WordsOf(Violation violation)
    {
        ArgumentNullException.ThrowIfNull(violation);

        if (!Templates.TryGetValue(violation.RuleId, out var template))
        {
            return null;
        }

        var words = new StringBuilder(template.Head);

        foreach (var placeholder in template.Placeholders)
        {
            if (MemberWordsOf(placeholder, violation.Bounds) is not { } word)
            {
                return null;
            }

            words.Append(word).Append(placeholder.Tail);
        }

        return words.ToString();
    }

    // a template's placeholder: the member it is written from, whether as bytes, and the words after it
    private sealed record Placeholder(string Name, bool IsBytes, string Tail);

    // a rule's template (18.8.6): its words before its first placeholder, then its placeholders
    private sealed record Template(string Head, IReadOnlyList<Placeholder> Placeholders);
}
