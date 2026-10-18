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
/// not write, is a <see cref="FormatException"/> saying why, in this side's words.
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
    // anything deeper is built
    private static readonly JsonDocumentOptions Strictly = new()
    {
        AllowDuplicateProperties = false,
        MaxDepth = Depth,
    };

    // what a json reader says of what it refuses, after the parse: its canonical write refuses it
    private static readonly Refusals Read = new()
    {
        SurrogateAlone = "a json payload holds a surrogate alone",
        NameTwice = "a json payload names a member twice",
        Nested = "a json payload nests deeper than 64",
        NotFinite = "a json payload holds a number past the largest double",
        NoValue = "a json payload holds no JSON value",
    };

    // what a json writer says of a value it refuses
    private static readonly Refusals Written = new()
    {
        SurrogateAlone = "a json value holds a surrogate alone",
        NameTwice = "a json value names a member twice",
        Nested = "a json value nests deeper than 64",
        NotFinite = "a json value holds a number that is not finite",
        NoValue = "a json value of kind Undefined is no JSON value",
    };

    private static ReadOnlySpan<byte> ByteOrderMark
    {
        get
        {
            return [0xEF, 0xBB, 0xBF];
        }
    }

    // helpers

    // what a strict parse refused, read again with nothing built: nested past 64 where a reader
    // meets a 65th level before anything else it refuses, a name twice where it meets nothing it
    // refuses, and not JSON otherwise
    private static string RefusalOf(ReadOnlySpan<byte> bytes)
    {
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = Depth + 1 });
        var isRead = false;

        try
        {
            while (reader.Read())
            {
                isRead = true;

                if (reader.CurrentDepth >= Depth && reader.TokenType is JsonTokenType.StartArray or JsonTokenType.StartObject)
                {
                    return Read.Nested;
                }
            }
        }
        catch (JsonException)
        {
            return "a json payload is not one JSON text";
        }

        return isRead ? Read.NameTwice : "a json payload is not one JSON text";
    }

    // definition

    /// <summary>
    /// The value of a <c>json</c> payload (17.5, 17.6), its canonical form's: the document read when
    /// its bytes are canonical already, otherwise the canonical bytes written of it, parsed again.
    /// Refused: bytes that are not UTF-8, a byte order mark, bytes that are not one JSON text, a
    /// name given twice, a surrogate alone, a number past the largest double, and nesting past 64.
    /// </summary>
    public static JsonElement ReadJson(ReadOnlyMemory<byte> payload)
    {
        // ! .NET's reader takes a byte that is not UTF-8 within a string, and writes it back as U+FFFD
        if (!Utf8.IsValid(payload.Span))
        {
            throw new FormatException("a json payload is not UTF-8");
        }

        if (payload.Span.StartsWith(ByteOrderMark))
        {
            throw new FormatException("a json payload starts with a byte order mark");
        }

        JsonDocument document;

        try
        {
            // ! the overload of memory: the one of a stream skips a byte order mark
            document = JsonDocument.Parse(payload, Strictly);
        }
        catch (JsonException reason)
        {
            throw new FormatException(RefusalOf(payload.Span), reason);
        }
        catch (InvalidOperationException reason)
        {
            // ! the check of names given twice reads each name, and one holding a surrogate alone
            // throws this, not a JsonException
            throw new FormatException(Read.SurrogateAlone, reason);
        }

        using (document)
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
            throw new FormatException("a text payload is not UTF-8", reason);
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
            throw new FormatException("a text value holds a surrogate alone", reason);
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

    // what a canonical write says of what it refuses: a reader's words, or a writer's
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
        private static string NumberOf(double value)
        {
            if (value == 0)
            {
                return "0";
            }

            if (value < 0)
            {
                return "-" + NumberOf(-value);
            }

            var shortest = value.ToString("R", CultureInfo.InvariantCulture);
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
                    throw new FormatException(refusals.NoValue);
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
            // ! never TryGetDouble nor GetDouble, which read some ties of many digits to the odd
            // neighbour: double.Parse of the raw digits reads each to the nearest, a tie to the even
            var number = double.Parse(JsonMarshal.GetRawUtf8Value(value), NumberStyles.Float, CultureInfo.InvariantCulture);

            if (!double.IsFinite(number))
            {
                throw new FormatException(refusals.NotFinite);
            }

            Append(Encoding.ASCII.GetBytes(NumberOf(number)));
        }

        // a string as JSON.stringify writes a well-formed one (17.7.3): each character as it is,
        // but " and \, five control characters as short escapes, and the others as \u in lower-case
        // hexadecimal
        private void WriteString(string text)
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
