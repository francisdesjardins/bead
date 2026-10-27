using System.Diagnostics.CodeAnalysis;
using System.Text;

namespace Bead.Transcoding;

/// <summary>
/// A refusal of Bead's mapping (transcoding 4 and 5): a request's body, query or variable it does
/// not read, which a gateway answers 400 <c>PAYLOAD_UNDECODABLE</c>, or a result it holds no form
/// of, 500. Its message is its own words, which a problem's <c>detail</c> carries and which name
/// nothing its request carried; where its reading met it, <see cref="At"/>, and where its request
/// carried it, <see cref="Place"/>, which a binding gives it (7.4). Thrown by the mapping alone, so
/// that no exception of the platform's puts its words there. The TypeScript side's
/// <c>JsonFormError</c>.
/// </summary>
public sealed class JsonFormException : Exception
{
    /// <summary>A refusal, saying why.</summary>
    public JsonFormException(string message)
        : base(message)
    {
    }

    /// <summary>A refusal, saying why, of what <paramref name="innerException"/> refused first.</summary>
    public JsonFormException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>A refusal, saying why, placed where <paramref name="options"/> says.</summary>
    public JsonFormException(string message, JsonFormExceptionOptions options)
        : base(message, options?.InnerException)
    {
        ArgumentNullException.ThrowIfNull(options);

        At = options.At;
        Place = options.Place;
        IsUnset = options.IsUnset;
    }

    /// <summary>The tokens of the place its reading met it, from the value read; none for its text's own.</summary>
    public IReadOnlyList<JsonToken>? At { get; }

    /// <summary>Where its request carried it, a parameter or a pointer of 7.4; none where nothing places it.</summary>
    public RequestPlace? Place { get; }

    /// <summary>
    /// Whether it is 5.2's step 4, a required field unset, which a binding places as a violation's
    /// field is (7.4): <see cref="At"/> is the member its object lacks.
    /// </summary>
    public bool IsUnset { get; }

    /// <summary>Its place's pointer, the value read the body whole; none where its reading met it nowhere.</summary>
    [SuppressMessage(
        "Naming",
        "CA1720:Identifier contains type name",
        Justification = "a problem's pointer, as RFC 9457 and transcoding 7.4 name it, and the TypeScript side's: one word, one meaning (0003)")]
    public string? Pointer
    {
        get
        {
            return At is null ? null : JsonPlaces.PointerOf(At);
        }
    }

    // the same refusal, met at `at`, where nothing below placed it
    internal JsonFormException Placed(JsonPlace at)
    {
        return new JsonFormException(Message, new JsonFormExceptionOptions { At = at.Tokens(), InnerException = InnerException });
    }
}

/// <summary>Where a <see cref="JsonFormException"/> lies, and what refused it first.</summary>
public sealed record JsonFormExceptionOptions
{
    /// <summary>The tokens of the place its reading met it, from the value read; none for its text's own.</summary>
    public IReadOnlyList<JsonToken>? At { get; init; }

    /// <summary>Where its request carried it; none where nothing places it.</summary>
    public RequestPlace? Place { get; init; }

    /// <summary>Whether it is 5.2's step 4, a required field unset.</summary>
    public bool IsUnset { get; init; }

    /// <summary>What refused it first; none.</summary>
    public Exception? InnerException { get; init; }
}

/// <summary>
/// A token of a place in a JSON value: a field's JSON name, an item's index, or a member's name or a
/// key the request carried, <see cref="IsGiven"/>, which a parameter cuts and a pointer stops
/// before past 64 bytes of UTF-8 (transcoding 7.4).
/// </summary>
public sealed record JsonToken(string Text, bool IsGiven);

/// <summary>
/// Where a request carried what its reading refuses (7.4): among its variables or in its query,
/// <see cref="Parameter"/>, or in its body, <see cref="Pointer"/>.
/// </summary>
public sealed record RequestPlace
{
    /// <summary>A variable's field path as its template writes it, or a query's by JSON names.</summary>
    public string? Parameter { get; init; }

    /// <summary>A JSON Pointer into its body, as a URI's fragment (RFC 6901 §6).</summary>
    [SuppressMessage(
        "Naming",
        "CA1720:Identifier contains type name",
        Justification = "a problem's pointer, as RFC 9457 and transcoding 7.4 name it, and the TypeScript side's: one word, one meaning (0003)")]
    public string? Pointer { get; init; }
}

// where a reading is in the value it reads: the value itself, the root, or a token below a place
internal sealed class JsonPlace
{
    private JsonPlace(JsonToken? token, JsonPlace? up)
    {
        Token = token;
        Up = up;
    }

    public static JsonPlace Root { get; } = new(null, null);

    public JsonToken? Token { get; }

    public JsonPlace? Up { get; }

    // a field's place below this one, by its JSON name
    public JsonPlace Field(string jsonName)
    {
        return new JsonPlace(new JsonToken(jsonName, false), this);
    }

    // a member's or a key's place, as the request named it
    public JsonPlace Given(string name)
    {
        return new JsonPlace(new JsonToken(name, true), this);
    }

    public JsonPlace Item(int index)
    {
        return new JsonPlace(new JsonToken(index.ToString(System.Globalization.CultureInfo.InvariantCulture), false), this);
    }

    // its tokens, from the value read
    public List<JsonToken> Tokens()
    {
        var tokens = new List<JsonToken>();

        for (var at = this; at?.Token is { } token; at = at.Up)
        {
            tokens.Add(token);
        }

        tokens.Reverse();

        return tokens;
    }
}

// a place's pointer, and a name or a key of the request cut as spec 18.4 cuts a key
internal static class JsonPlaces
{
    // the bytes of UTF-8 a key of the request is written whole within (spec 18.4)
    private const int KeyBytes = 64;

    // whole within 64 bytes of UTF-8, else its first 64, back to the start of the character the cut
    // fell in, and `...` after them
    public static string CutOf(string text)
    {
        if (Encoding.UTF8.GetByteCount(text) <= KeyBytes)
        {
            return text;
        }

        var kept = new StringBuilder();
        var bytes = 0;

        foreach (var rune in text.EnumerateRunes())
        {
            if (bytes + rune.Utf8SequenceLength > KeyBytes)
            {
                break;
            }

            kept.Append(rune.ToString());
            bytes += rune.Utf8SequenceLength;
        }

        return kept.Append("...").ToString();
    }

    // `#`, then each token after a `/`, escaped (RFC 6901 §6), up to the value that holds a name or a
    // key the request carried past 64 bytes of UTF-8, which a pointer never cuts (7.4)
    public static string PointerOf(IEnumerable<JsonToken> tokens)
    {
        var pointer = new StringBuilder("#");

        foreach (var token in tokens)
        {
            if (token.IsGiven && Encoding.UTF8.GetByteCount(token.Text) > KeyBytes)
            {
                break;
            }

            pointer.Append('/').Append(FragmentOf(TokenOf(token.Text)));
        }

        return pointer.ToString();
    }

    // a JSON Pointer's reference token, `~` and `/` escaped (RFC 6901 §4)
    public static string TokenOf(string text)
    {
        return text.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);
    }

    // `text` as a URI's fragment writes it: each character it does not take percent-encoded from its UTF-8
    public static string FragmentOf(string text)
    {
        var written = new StringBuilder(text.Length);
        Span<byte> bytes = stackalloc byte[4];

        foreach (var rune in text.EnumerateRunes())
        {
            if (rune.IsAscii && (char.IsAsciiLetterOrDigit((char)rune.Value) || "-._~!$&'()*+,;=:@/?".Contains((char)rune.Value, StringComparison.Ordinal)))
            {
                written.Append((char)rune.Value);

                continue;
            }

            var count = rune.EncodeToUtf8(bytes);

            foreach (var octet in bytes[..count])
            {
                written.Append('%').Append(octet.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        return written.ToString();
    }
}
