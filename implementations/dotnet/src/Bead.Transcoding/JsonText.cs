using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Unicode;

namespace Bead.Transcoding;

/// <summary>What a JSON value is.</summary>
internal enum JsonNodeKind
{
    Null,
    True,
    False,
    Number,
    String,
    Array,
    Object,
}

/// <summary>
/// A JSON value as Bead's mapping reads it (transcoding 5.2, step 1): a number by its digits as they
/// came, beside nothing else, so that a 64-bit integer reads exactly; an object's members in their
/// order, none named twice.
/// </summary>
internal sealed class JsonNode
{
    public static JsonNode Null { get; } = new(JsonNodeKind.Null);

    public static JsonNode True { get; } = new(JsonNodeKind.True);

    public static JsonNode False { get; } = new(JsonNodeKind.False);

    private JsonNode(JsonNodeKind kind)
    {
        Kind = kind;
    }

    public JsonNodeKind Kind { get; }

    /// <summary>A number's digits as they came, or a string's text.</summary>
    public string Text { get; private init; } = "";

    public List<JsonNode> Items { get; private init; } = [];

    public List<KeyValuePair<string, JsonNode>> Members { get; private init; } = [];

    public static JsonNode NumberOf(string digits)
    {
        return new JsonNode(JsonNodeKind.Number) { Text = digits };
    }

    public static JsonNode StringOf(string text)
    {
        return new JsonNode(JsonNodeKind.String) { Text = text };
    }

    public static JsonNode ArrayOf(List<JsonNode> items)
    {
        return new JsonNode(JsonNodeKind.Array) { Items = items };
    }

    public static JsonNode ObjectOf(List<KeyValuePair<string, JsonNode>> members)
    {
        return new JsonNode(JsonNodeKind.Object) { Members = members };
    }
}

/// <summary>
/// One JSON text read as spec 17.5 reads a <c>json</c> payload — UTF-8, no byte order mark, one JSON
/// text, no member named twice, no surrogate alone, no number past the largest double — but for its
/// depth, which Bead's mapping counts by the message's descriptor, and the digits of each number,
/// which it keeps (transcoding 5.2, step 1). A refusal is a <see cref="FormatException"/>.
/// </summary>
internal static class JsonText
{
    // ! a message nested 100 deep below the request is 202 levels of JSON at most, a repeated
    // field's array and its item's object each a level: past this, no message holds the text, and
    // nothing deeper is built
    public const int Depth = 256;

    private static ReadOnlySpan<byte> ByteOrderMark
    {
        get
        {
            return [0xEF, 0xBB, 0xBF];
        }
    }

    public static JsonNode Read(ReadOnlySpan<byte> text)
    {
        if (!Utf8.IsValid(text))
        {
            throw new FormatException("not UTF-8");
        }

        if (text.StartsWith(ByteOrderMark))
        {
            throw new FormatException("a byte order mark");
        }

        var reader = new Utf8JsonReader(text, new JsonReaderOptions { MaxDepth = Depth });

        try
        {
            if (!reader.Read())
            {
                throw new FormatException("not JSON");
            }

            var value = ValueOf(ref reader);

            if (reader.Read())
            {
                throw new FormatException("not JSON");
            }

            return value;
        }
        catch (JsonException reason)
        {
            throw new FormatException("not JSON", reason);
        }
    }

    // a string's text, or the refusal of one holding a surrogate alone, which GetString throws on
    private static string StringOf(ref Utf8JsonReader reader)
    {
        try
        {
            return reader.GetString()!;
        }
        catch (InvalidOperationException reason)
        {
            throw new FormatException("a surrogate alone", reason);
        }
    }

    private static JsonNode ValueOf(ref Utf8JsonReader reader)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.Null:
                return JsonNode.Null;
            case JsonTokenType.True:
                return JsonNode.True;
            case JsonTokenType.False:
                return JsonNode.False;
            case JsonTokenType.Number:
                var digits = Encoding.ASCII.GetString(reader.ValueSpan);

                if (!double.IsFinite(double.Parse(digits, NumberStyles.Float, CultureInfo.InvariantCulture)))
                {
                    throw new FormatException("a number past a double");
                }

                return JsonNode.NumberOf(digits);
            case JsonTokenType.String:
                return JsonNode.StringOf(StringOf(ref reader));
            case JsonTokenType.StartArray:
                var items = new List<JsonNode>();

                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
                {
                    items.Add(ValueOf(ref reader));
                }

                return JsonNode.ArrayOf(items);
            case JsonTokenType.StartObject:
                var members = new List<KeyValuePair<string, JsonNode>>();
                var names = new HashSet<string>(StringComparer.Ordinal);

                while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
                {
                    var name = StringOf(ref reader);

                    // * named twice once its escapes are read: "anInt32" is "anInt32"
                    if (!names.Add(name))
                    {
                        throw new FormatException("a member named twice");
                    }

                    reader.Read();
                    members.Add(new KeyValuePair<string, JsonNode>(name, ValueOf(ref reader)));
                }

                return JsonNode.ObjectOf(members);
            default:
                throw new FormatException("not JSON");
        }
    }
}
