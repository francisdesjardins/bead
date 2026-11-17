using System.Buffers;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Unicode;

namespace Bead;

/// <summary>
/// The encodings of a payload, as spec section 17 states them (decision 0016): <c>raw</c>, its
/// bytes; <c>text</c>, a string in UTF-8, read strictly; <c>json</c>, one JSON text in UTF-8, read
/// as an I-JSON message is read but for its noncharacters, and written in the canonical form of
/// RFC 8785, so that one value has one form whichever side writes it. <see cref="PayloadCodecs"/>
/// gives them as codecs, and the interop's serializers delegate to them. What does not read, or does
/// not write, is a <see cref="FormatException"/> of its reason in spec 17.2's words, exactly, what
/// more this side knows in its inner exception.
/// </summary>
internal static class Payloads
{
    // constants

    // how deep an array or an object nests at most, the outermost at depth 1 (17.5.7)
    private const int Depth = 64;

    private const string Hexadecimal = "0123456789abcdef";

    // ! a writer emits no byte order mark, and a reader throws on bytes that are not UTF-8 and on a
    // surrogate alone, where the platform's defaults write U+FFFD; GetString keeps a leading U+FEFF
    private static readonly UTF8Encoding Strict = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    // ! a name given twice refuses the JSON, and the 65th level refuses it as it is read, before
    // anything deeper is built: a JWT's header and claims set (13.8 step 1), and a json payload's
    // quick read
    internal static readonly JsonDocumentOptions Strictly = new()
    {
        AllowDuplicateProperties = false,
        MaxDepth = Depth,
    };

    // ! a json payload's ordered read: every member kept, in its text's order, so the walk after the
    // parse meets a name twice where its text gives it (17.5, after item 7); 64 deep, which the count
    // before the parse holds already
    private static readonly JsonDocumentOptions AsWritten = new()
    {
        AllowDuplicateProperties = true,
        MaxDepth = Depth,
    };

    // * the reasons of spec 17.2, a refusal's message exactly, and a request's PAYLOAD_UNDECODABLE's
    // detail: a reader's, then a writer's own
    private const string NotUtf8 = "not UTF-8";

    private const string AByteOrderMark = "a byte order mark";

    private const string NotJson = "not JSON";

    private const string ASurrogateAlone = "a surrogate alone";

    private const string ANameTwice = "a name twice";

    private const string NestedPast64 = "nested past 64";

    // what a json reader refuses, after the parse: its canonical write refuses it
    private static readonly Refusals Read = new()
    {
        SurrogateAlone = ASurrogateAlone,
        NameTwice = ANameTwice,
        Nested = NestedPast64,
        NotFinite = "a number past a double",
        NoValue = "no JSON value",
    };

    // what a json writer refuses of a value
    private static readonly Refusals Written = Read with
    {
        NotFinite = "not a finite number",
    };

    private static ReadOnlySpan<byte> ByteOrderMark
    {
        get
        {
            return [0xEF, 0xBB, 0xBF];
        }
    }

    // helpers

    // whether the text opens an array or an object deeper than 64, counted over the whole text
    // before anything of it is read (17.5, after item 7): its strings skipped, a backslash escaping
    // the byte after it, a string never closed ending the count, the count free to fall below 0
    private static bool IsTooDeep(ReadOnlySpan<byte> text)
    {
        var depth = 0;

        for (var index = 0; index < text.Length; index += 1)
        {
            switch (text[index])
            {
                case (byte)'"':
                    index += 1;

                    while (index < text.Length && text[index] != (byte)'"')
                    {
                        index += text[index] == (byte)'\\' ? 2 : 1;
                    }

                    break;
                case (byte)'[' or (byte)'{':
                    depth += 1;

                    if (depth > Depth)
                    {
                        return true;
                    }

                    break;
                case (byte)']' or (byte)'}':
                    depth -= 1;
                    break;
                default:
                    break;
            }
        }

        return false;
    }

    // of 17.5's items 4, 5 and 6, the reason the value meets first, read in its text's order: a name
    // or a string holding a surrogate alone at that name or string, a name its object gave before at
    // that name, a number past a double at that number; null where it meets none. Recursive, as the
    // canonical write is, 64 deep at most
    private static string? FirstFault(JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                return IsWellFormed(value) ? null : ASurrogateAlone;
            case JsonValueKind.Number:
                return double.IsFinite(DoubleOf(value)) ? null : Read.NotFinite;
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray())
                {
                    if (FirstFault(item) is { } fault)
                    {
                        return fault;
                    }
                }

                return null;
            case JsonValueKind.Object:
                return FirstFaultOfMembers(value);
            default:
                return null;
        }
    }

    // an object's members in their text's order, each name before its value
    private static string? FirstFaultOfMembers(JsonElement value)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);

        foreach (var member in value.EnumerateObject())
        {
            string name;

            try
            {
                name = member.Name;
            }
            catch (InvalidOperationException)
            {
                // ! reading a name that holds a surrogate alone throws this
                return ASurrogateAlone;
            }

            if (!names.Add(name))
            {
                return ANameTwice;
            }

            if (FirstFault(member.Value) is { } fault)
            {
                return fault;
            }
        }

        return null;
    }

    // whether a string holds no surrogate alone, which only an escape writes
    private static bool IsWellFormed(JsonElement value)
    {
        if (!JsonMarshal.GetRawUtf8Value(value).Contains((byte)'\\'))
        {
            return true;
        }

        try
        {
            _ = value.GetString();

            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    // a number as a double, read from its digits
    private static double DoubleOf(JsonElement value)
    {
        // ! never TryGetDouble nor GetDouble, which read some ties of many digits to the odd
        // neighbour: double.Parse of the raw digits reads each to the nearest, a tie to the even
        return double.Parse(JsonMarshal.GetRawUtf8Value(value), NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    // * a json payload's value, read the quick way: a strict parse, then the canonical write, which
    // between them meet every fault 17.5 refuses. Null where either refuses anything, the ordered
    // read then naming the reason. What this read accepts, the ordered read accepts too, with the
    // same value
    private static JsonElement? ReadQuickly(ReadOnlyMemory<byte> payload)
    {
        JsonDocument document;

        try
        {
            // ! the overload of memory: the one of a stream skips a byte order mark
            document = JsonDocument.Parse(payload, Strictly);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            // ! the check of names given twice reads each name, and one holding a surrogate alone
            // throws this, not a JsonException
            return null;
        }

        using (document)
        {
            try
            {
                return CanonicalOf(document, payload);
            }
            catch (FormatException)
            {
                return null;
            }
        }
    }

    // a json payload's value, read in 17.5's order, so a payload of two faults is refused with the
    // first: nested past 64, then not JSON, then the first fault its text meets
    private static JsonElement ReadInOrder(ReadOnlyMemory<byte> payload)
    {
        // * before the parse, so a peer never chooses how deep it goes
        if (IsTooDeep(payload.Span))
        {
            throw new FormatException(NestedPast64);
        }

        JsonDocument document;

        try
        {
            // ! the overload of memory: the one of a stream skips a byte order mark
            document = JsonDocument.Parse(payload, AsWritten);
        }
        catch (JsonException reason)
        {
            throw new FormatException(NotJson, reason);
        }

        using (document)
        {
            if (FirstFault(document.RootElement) is { } fault)
            {
                throw new FormatException(fault);
            }

            return CanonicalOf(document, payload);
        }
    }

    // the value of a document read of a payload, its canonical form's
    private static JsonElement CanonicalOf(JsonDocument document, ReadOnlyMemory<byte> payload)
    {
        // the canonical form is about as long as the payload, so its buffer grows rarely
        var canonical = new Canonical(Read, Math.Max(payload.Length, 1));

        canonical.Write(document.RootElement, 0);

        // * the value handed on is the canonical form's: 1.0 is 1, and a number's digits past a
        // double's are gone, as on every side
        if (canonical.Bytes.Span.SequenceEqual(payload.Span))
        {
            return document.RootElement.Clone();
        }

        using var written = JsonDocument.Parse(canonical.Bytes);

        return written.RootElement.Clone();
    }

    // definition

    /// <summary>
    /// Whether every number <paramref name="value"/> holds, at any depth, reads as a finite double
    /// (17.5.6), each read as the canonical form reads it. A walk with a stack of its own, never a
    /// recursion.
    /// </summary>
    internal static bool IsFinite(JsonElement value)
    {
        var pending = new Stack<JsonElement>();

        pending.Push(value);

        while (pending.TryPop(out var item))
        {
            if (item.ValueKind == JsonValueKind.Number && !double.IsFinite(DoubleOf(item)))
            {
                return false;
            }

            if (item.ValueKind == JsonValueKind.Array)
            {
                foreach (var each in item.EnumerateArray())
                {
                    pending.Push(each);
                }
            }
            else if (item.ValueKind == JsonValueKind.Object)
            {
                foreach (var member in item.EnumerateObject())
                {
                    pending.Push(member.Value);
                }
            }
        }

        return true;
    }

    /// <summary>
    /// The value of a <c>json</c> payload (17.5, 17.6), its canonical form's: the document read when
    /// its bytes are canonical already, otherwise the canonical bytes written of it, parsed again.
    /// Refused with the first reason in 17.5's order: bytes that are not UTF-8, a byte order mark,
    /// nesting past 64, bytes that are not one JSON text, then of a name given twice, a surrogate
    /// alone and a number past the largest double the one its text meets first.
    /// </summary>
    public static JsonElement ReadJson(ReadOnlyMemory<byte> payload)
    {
        // ! .NET's reader takes a byte that is not UTF-8 within a string, and writes it back as U+FFFD
        if (!Utf8.IsValid(payload.Span))
        {
            throw new FormatException(NotUtf8);
        }

        if (payload.Span.StartsWith(ByteOrderMark))
        {
            throw new FormatException(AByteOrderMark);
        }

        // * only a payload refused pays for the read in 17.5's order
        return ReadQuickly(payload) ?? ReadInOrder(payload);
    }

    /// <summary>
    /// The canonical form of <paramref name="value"/> (17.7, RFC 8785 §3.2), in UTF-8. Refused: a
    /// number that is not finite, a string or a name holding a surrogate alone, an object naming a
    /// member twice, nesting past 64, and an element of kind <see cref="JsonValueKind.Undefined"/>.
    /// </summary>
    public static ReadOnlyMemory<byte> WriteJson(JsonElement value)
    {
        // about as long as the value as written, which an element of kind Undefined has none of
        var canonical = new Canonical(Written, value.ValueKind == JsonValueKind.Undefined ? 1 : Math.Max(JsonMarshal.GetRawUtf8Value(value).Length, 1));

        canonical.Write(value, 0);

        return canonical.Bytes;
    }

    /// <summary>
    /// The canonical form of the string <paramref name="text"/> (17.7.3), in UTF-8, its quotation
    /// marks included: one holding a surrogate alone is refused, a <see cref="FormatException"/>.
    /// </summary>
    public static ReadOnlyMemory<byte> WriteJsonString(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var canonical = new Canonical(Written, text.Length + 2);

        canonical.WriteString(text);

        return canonical.Bytes;
    }

    /// <summary>
    /// A number as ECMAScript's Number::toString writes its double (17.7.4), −0 as <c>0</c>; one that
    /// is not finite has none, a <see cref="FormatException"/>.
    /// </summary>
    public static string NumberText(double value)
    {
        if (!double.IsFinite(value))
        {
            throw new FormatException(Written.NotFinite);
        }

        return Canonical.NumberOf(value);
    }

    /// <summary>
    /// A 32-bit float as the shortest decimal that reads back to it, laid out as Number::toString
    /// lays out a number of those digits, −0 as <c>0</c>; one that is not finite has none, a
    /// <see cref="FormatException"/>.
    /// </summary>
    public static string NumberText(float value)
    {
        if (!float.IsFinite(value))
        {
            throw new FormatException(Written.NotFinite);
        }

        if (value == 0)
        {
            return "0";
        }

        var shortest = Canonical.NumberOfShortest(Math.Abs(value).ToString("R", CultureInfo.InvariantCulture));

        return value < 0 ? "-" + shortest : shortest;
    }

    /// <summary>
    /// The string of a <c>text</c> payload (17.4): its bytes read as UTF-8, a leading U+FEFF kept as a
    /// character; bytes that are not UTF-8 refused.
    /// </summary>
    public static string ReadText(ReadOnlyMemory<byte> payload)
    {
        try
        {
            return Strict.GetString(payload.Span);
        }
        catch (DecoderFallbackException reason)
        {
            throw new FormatException(NotUtf8, reason);
        }
    }

    /// <summary>A string in UTF-8, as a <c>text</c> payload (17.4); one holding a surrogate alone refused.</summary>
    public static ReadOnlyMemory<byte> WriteText(string value)
    {
        ArgumentNullException.ThrowIfNull(value);

        try
        {
            return Strict.GetBytes(value);
        }
        catch (EncoderFallbackException reason)
        {
            throw new FormatException(ASurrogateAlone, reason);
        }
    }

    /// <summary>The bytes of a <c>raw</c> payload (17.3), as they are: any, none included.</summary>
    public static ReadOnlyMemory<byte> ReadRaw(ReadOnlyMemory<byte> payload)
    {
        return payload;
    }

    /// <summary>Bytes, as a <c>raw</c> payload (17.3), as they are.</summary>
    public static ReadOnlyMemory<byte> WriteRaw(ReadOnlyMemory<byte> value)
    {
        return value;
    }

    // the reasons a canonical write refuses with: a reader's, or a writer's
    private sealed record Refusals
    {
        public required string SurrogateAlone { get; init; }

        public required string NameTwice { get; init; }

        public required string Nested { get; init; }

        public required string NotFinite { get; init; }

        public required string NoValue { get; init; }
    }

    // one canonical write (RFC 8785 §3.2), by hand into bytes: no Utf8JsonWriter and no encoder of
    // the platform's, whose escapes differ from release to release
    private sealed class Canonical(Refusals refusals, int capacity = 256)
    {
        private readonly ArrayBufferWriter<byte> _written = new(capacity);

        public ReadOnlyMemory<byte> Bytes
        {
            get
            {
                return _written.WrittenMemory;
            }
        }

        // a number as ECMAScript's Number::toString writes its double (17.7.4), from the shortest
        // digits that read back to it, -0 as 0
        internal static string NumberOf(double value)
        {
            if (value == 0)
            {
                return "0";
            }

            if (value < 0)
            {
                return "-" + NumberOf(-value);
            }

            return NumberOfShortest(value.ToString("R", CultureInfo.InvariantCulture));
        }

        // a positive number of the shortest digits given, as .NET's round-trip form writes them, laid
        // out as Number::toString lays out its digits
        internal static string NumberOfShortest(string shortest)
        {
            var at = shortest.IndexOf('E', StringComparison.Ordinal);
            var mantissa = at < 0 ? shortest : shortest[..at];
            var exponent = at < 0 ? 0 : int.Parse(shortest[(at + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            var point = mantissa.IndexOf('.', StringComparison.Ordinal);
            var whole = point < 0 ? mantissa : mantissa[..point];
            var all = point < 0 ? mantissa : whole + mantissa[(point + 1)..];
            var leading = all.Length - all.TrimStart('0').Length;
            var digits = all.Trim('0');

            // k digits, and n where the point falls among them, as Number::toString names them
            var k = digits.Length;
            var n = whole.Length + exponent - leading;

            if (k <= n && n <= 21)
            {
                return digits + new string('0', n - k);
            }

            if (0 < n && n <= 21)
            {
                return digits[..n] + "." + digits[n..];
            }

            if (-6 < n && n <= 0)
            {
                return "0." + new string('0', -n) + digits;
            }

            var e = n - 1;
            var sign = e >= 0 ? "+" : "-";
            var significand = k == 1 ? digits : digits[..1] + "." + digits[1..];

            return significand + "e" + sign + Math.Abs(e).ToString(CultureInfo.InvariantCulture);
        }

        public void Write(JsonElement value, int depth)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.Null:
                    Append("null"u8);
                    break;
                case JsonValueKind.True:
                    Append("true"u8);
                    break;
                case JsonValueKind.False:
                    Append("false"u8);
                    break;
                case JsonValueKind.Number:
                    WriteNumber(value);
                    break;
                case JsonValueKind.String:
                    WriteStringOf(value);
                    break;
                case JsonValueKind.Array:
                    WriteArray(value, depth);
                    break;
                case JsonValueKind.Object:
                    WriteObject(value, depth);
                    break;
                default:
                    throw new FormatException(refusals.NoValue, new FormatException($"a json value of kind {value.ValueKind} is no JSON value"));
            }
        }

        private void Append(ReadOnlySpan<byte> bytes)
        {
            _written.Write(bytes);
        }

        private void Append(byte value)
        {
            _written.GetSpan(1)[0] = value;
            _written.Advance(1);
        }

        // a string's text, or its refusal: GetString throws on a surrogate alone that an escape wrote
        private string TextOf(JsonElement value)
        {
            try
            {
                return value.GetString()!;
            }
            catch (InvalidOperationException reason)
            {
                throw new FormatException(refusals.SurrogateAlone, reason);
            }
        }

        private string NameOf(JsonProperty member)
        {
            try
            {
                return member.Name;
            }
            catch (InvalidOperationException reason)
            {
                throw new FormatException(refusals.SurrogateAlone, reason);
            }
        }

        // * a string whose bytes, as written, hold no escape and are UTF-8 is in its canonical form
        // already, its quotes included: a reader takes no control character unescaped, and the form
        // escapes nothing else
        private void WriteStringOf(JsonElement value)
        {
            var written = JsonMarshal.GetRawUtf8Value(value);

            if (!written.Contains((byte)'\\') && Utf8.IsValid(written))
            {
                Append(written);
            }
            else
            {
                WriteString(TextOf(value));
            }
        }

        private void WriteNumber(JsonElement value)
        {
            var number = DoubleOf(value);

            if (!double.IsFinite(number))
            {
                throw new FormatException(refusals.NotFinite);
            }

            Append(Encoding.ASCII.GetBytes(NumberOf(number)));
        }

        // a string as JSON.stringify writes a well-formed one (17.7.3): each character as it is,
        // but " and \, five control characters as short escapes, and the others as \u in lower-case
        // hexadecimal
        internal void WriteString(string text)
        {
            Append((byte)'"');

            for (var index = 0; index < text.Length; index += 1)
            {
                var character = text[index];

                if (char.IsHighSurrogate(character) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
                {
                    var pair = new Rune(character, text[index + 1]);

                    _written.Advance(pair.EncodeToUtf8(_written.GetSpan(4)));
                    index += 1;
                }
                else if (char.IsSurrogate(character))
                {
                    throw new FormatException(refusals.SurrogateAlone);
                }
                else if (character is '"' or '\\')
                {
                    Append((byte)'\\');
                    Append((byte)character);
                }
                else if (character < ' ')
                {
                    WriteControl(character);
                }
                else
                {
                    _written.Advance(new Rune(character).EncodeToUtf8(_written.GetSpan(4)));
                }
            }

            Append((byte)'"');
        }

        private void WriteControl(char character)
        {
            Append((byte)'\\');

            switch (character)
            {
                case '\b':
                    Append((byte)'b');
                    break;
                case '\t':
                    Append((byte)'t');
                    break;
                case '\n':
                    Append((byte)'n');
                    break;
                case '\f':
                    Append((byte)'f');
                    break;
                case '\r':
                    Append((byte)'r');
                    break;
                default:
                    Append("u00"u8);
                    Append((byte)Hexadecimal[character >> 4]);
                    Append((byte)Hexadecimal[character & 0xF]);
                    break;
            }
        }

        private void WriteArray(JsonElement value, int depth)
        {
            if (depth == Depth)
            {
                throw new FormatException(refusals.Nested);
            }

            Append((byte)'[');

            var isFirst = true;

            foreach (var item in value.EnumerateArray())
            {
                if (!isFirst)
                {
                    Append((byte)',');
                }

                isFirst = false;
                Write(item, depth + 1);
            }

            Append((byte)']');
        }

        private void WriteObject(JsonElement value, int depth)
        {
            if (depth == Depth)
            {
                throw new FormatException(refusals.Nested);
            }

            var members = new List<(string Name, JsonElement Value)>();

            foreach (var member in value.EnumerateObject())
            {
                members.Add((NameOf(member), member.Value));
            }

            // * RFC 8785 §3.2.3: names sorted by their UTF-16 code units, which an ordinal
            // comparison compares; two equal names then sit side by side
            members.Sort((one, other) =>
            {
                return string.CompareOrdinal(one.Name, other.Name);
            });
            Append((byte)'{');

            for (var index = 0; index < members.Count; index += 1)
            {
                if (index > 0)
                {
                    if (string.Equals(members[index - 1].Name, members[index].Name, StringComparison.Ordinal))
                    {
                        throw new FormatException(refusals.NameTwice);
                    }

                    Append((byte)',');
                }

                WriteString(members[index].Name);
                Append((byte)':');
                Write(members[index].Value, depth + 1);
            }

            Append((byte)'}');
        }
    }
}
