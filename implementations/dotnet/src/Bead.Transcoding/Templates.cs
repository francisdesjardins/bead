using System.Text;

namespace Bead.Transcoding;

/// <summary>What a segment of a template is: a literal, <c>*</c>, one segment, or <c>**</c>, zero or more.</summary>
public enum HttpSegmentKind
{
    /// <summary>A literal, matched by its text exactly.</summary>
    Literal,

    /// <summary><c>*</c>: one segment.</summary>
    Star,

    /// <summary><c>**</c>: zero or more segments, its template's last but its verb.</summary>
    Stars,
}

/// <summary>A segment of a template: its kind, and a literal's text.</summary>
/// <param name="Kind">What it is.</param>
/// <param name="Text">A literal's text; none for <c>*</c> and <c>**</c>.</param>
public readonly record struct HttpSegment(HttpSegmentKind Kind, string? Text);

/// <summary>A variable of a template: its field path, and the segments it takes, from <paramref name="Start"/> up to <paramref name="End"/>.</summary>
/// <param name="FieldPath">The field path it binds, by proto names.</param>
/// <param name="Start">The index of its first segment.</param>
/// <param name="End">The index past its last segment.</param>
public sealed record HttpVariable(string FieldPath, int Start, int End);

/// <summary>
/// A request's path, raw, split as transcoding 3.6 and 3.7 split one: its segments, and its verb,
/// what follows the last <c>:</c> of its last segment, which is matched without it.
/// </summary>
public sealed record HttpPath
{
    /// <summary>Its segments, raw: nothing decoded.</summary>
    public required IReadOnlyList<string> Segments { get; init; }

    /// <summary>Its verb; none where its last segment holds no <c>:</c>.</summary>
    public string? Verb { get; init; }

    /// <summary>
    /// A raw path split, or none where it matches no route: one that does not begin with <c>/</c>,
    /// or holds an empty segment, or a segment that is <c>.</c> or <c>..</c>, raw or once
    /// percent-decoded (transcoding 3.6).
    /// </summary>
    public static HttpPath? Of(string path)
    {
        ArgumentNullException.ThrowIfNull(path);

        if (!path.StartsWith('/'))
        {
            return null;
        }

        var segments = path[1..].Split('/');
        string? verb = null;
        var last = segments[^1];
        var colon = last.LastIndexOf(':');

        // * the last colon its last segment holds unencoded: a single-segment variable's value
        // encodes each of its own (3.7)
        if (colon >= 0)
        {
            segments[^1] = last[..colon];
            verb = last[(colon + 1)..];
        }

        foreach (var segment in segments)
        {
            if (HttpTemplate.IsDotOrEmpty(segment))
            {
                return null;
            }
        }

        return new HttpPath { Segments = segments, Verb = verb };
    }
}

/// <summary>
/// A template of <c>http.proto</c>'s grammar (transcoding 3), parsed: <c>"/" Segments [ Verb ]</c>,
/// a segment a literal, <c>*</c>, <c>**</c> or a variable, <c>{</c> a field path, then <c>=</c> and
/// its segments or none, <c>}</c>; its <c>**</c> last but its verb. Its matching takes a raw path,
/// its precedence orders the templates that match one (3.5), and its values decode as 3.8 has them.
/// </summary>
public sealed class HttpTemplate
{
    // a segment's rank under 3.5's precedence: a literal, then `*`, then `**`; a template that ends
    // where the path ends before a `**` that takes none
    private const int EndRank = -1;
    private const int LiteralRank = 0;
    private const int StarRank = 1;
    private const int StarsRank = 2;

    private readonly List<HttpSegment> _segments = [];
    private readonly List<HttpVariable> _variables = [];
    private int _position;

    private HttpTemplate(string text)
    {
        Text = text;
    }

    /// <summary>The template as it was written.</summary>
    public string Text { get; }

    /// <summary>Its segments, a variable's among them, in their order.</summary>
    public IReadOnlyList<HttpSegment> Segments
    {
        get
        {
            return _segments;
        }
    }

    /// <summary>Its variables, in their order.</summary>
    public IReadOnlyList<HttpVariable> Variables
    {
        get
        {
            return _variables;
        }
    }

    /// <summary>Its verb; none where it has none.</summary>
    public string? Verb { get; private set; }

    /// <summary>
    /// <paramref name="text"/> parsed, or a <see cref="FormatException"/> saying why it is off the
    /// grammar: one that does not begin with <c>/</c>, a <c>**</c> that is not its last segment, a
    /// variable within a variable or one that does not close, a literal that is no segment, a verb
    /// that is no literal (transcoding 3.9).
    /// </summary>
    public static HttpTemplate Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var template = new HttpTemplate(text);

        template.Read();

        return template;
    }

    /// <summary>
    /// The index of the template of <paramref name="templates"/> that answers <paramref name="path"/>
    /// among those that match it, by 3.5's precedence; none where none matches.
    /// </summary>
    public static int? Answering(IReadOnlyList<HttpTemplate> templates, HttpPath path)
    {
        ArgumentNullException.ThrowIfNull(templates);
        ArgumentNullException.ThrowIfNull(path);

        int? best = null;
        List<int>? bestRanks = null;

        for (var index = 0; index < templates.Count; index += 1)
        {
            if (!templates[index].Matches(path))
            {
                continue;
            }

            var ranks = templates[index].RanksOf(path.Segments.Count);

            if (bestRanks is null || Compare(ranks, bestRanks) < 0)
            {
                (best, bestRanks) = (index, ranks);
            }
        }

        return best;
    }

    /// <summary>Whether it ties <paramref name="other"/>: one template up to its variables' names (transcoding 3.9).</summary>
    public bool Ties(HttpTemplate other)
    {
        ArgumentNullException.ThrowIfNull(other);

        return string.Equals(Verb, other.Verb, StringComparison.Ordinal) && _segments.SequenceEqual(other._segments);
    }

    /// <summary>Whether it matches <paramref name="path"/>: its verb, then each literal its segment's text, <c>*</c> one, <c>**</c> the rest (3.6, 3.7).</summary>
    public bool Matches(HttpPath path)
    {
        ArgumentNullException.ThrowIfNull(path);

        if (!string.Equals(Verb, path.Verb, StringComparison.Ordinal))
        {
            return false;
        }

        var isOpen = _segments.Count > 0 && _segments[^1].Kind == HttpSegmentKind.Stars;
        var fixedCount = isOpen ? _segments.Count - 1 : _segments.Count;

        if (isOpen ? path.Segments.Count < fixedCount : path.Segments.Count != fixedCount)
        {
            return false;
        }

        for (var index = 0; index < fixedCount; index += 1)
        {
            if (_segments[index].Kind == HttpSegmentKind.Literal && !string.Equals(_segments[index].Text, path.Segments[index], StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Each variable's value of <paramref name="path"/>, which it matches, by its field path (3.8):
    /// the segments it takes, by <c>/</c>, a single-segment one's percent-decoded whole, a
    /// multi-segment one's but each <c>%2F</c> and <c>%2f</c>. A <c>%</c> that two hexadecimal
    /// digits do not follow, and bytes that are not UTF-8, are a <see cref="JsonFormException"/>
    /// placed at its variable's field path (7.4).
    /// </summary>
    public IReadOnlyDictionary<string, string> ValuesOf(HttpPath path)
    {
        ArgumentNullException.ThrowIfNull(path);

        var consumed = new List<IEnumerable<string>>();

        for (var index = 0; index < _segments.Count; index += 1)
        {
            consumed.Add(_segments[index].Kind == HttpSegmentKind.Stars ? path.Segments.Skip(index) : [path.Segments[index]]);
        }

        var values = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var variable in _variables)
        {
            var isMulti = variable.End - variable.Start > 1
                || Enumerable.Range(variable.Start, variable.End - variable.Start).Any((index) =>
                {
                    return _segments[index].Kind == HttpSegmentKind.Stars;
                });
            var raw = string.Join('/', Enumerable.Range(variable.Start, variable.End - variable.Start).SelectMany((index) =>
            {
                return consumed[index];
            }));

            try
            {
                values[variable.FieldPath] = PercentDecoded(raw, isMulti);
            }
            catch (JsonFormException refused)
            {
                throw new JsonFormException(refused.Message, new JsonFormExceptionOptions
                {
                    Place = new RequestPlace { Parameter = variable.FieldPath },
                    InnerException = refused.InnerException,
                });
            }
        }

        return values;
    }

    /// <summary>
    /// <paramref name="text"/> percent-decoded, each <c>%2F</c> and <c>%2f</c> kept as it came where
    /// <paramref name="keepsSlash"/>: a <c>%</c> that two hexadecimal digits do not follow, and
    /// bytes that are not UTF-8, are a <see cref="JsonFormException"/>.
    /// </summary>
    internal static string PercentDecoded(string text, bool keepsSlash)
    {
        if (!text.Contains('%', StringComparison.Ordinal))
        {
            return text;
        }

        var bytes = new List<byte>(text.Length);

        for (var at = 0; at < text.Length;)
        {
            if (text[at] != '%')
            {
                var end = at;

                while (end < text.Length && text[end] != '%')
                {
                    end += 1;
                }

                bytes.AddRange(Encoding.UTF8.GetBytes(text[at..end]));
                at = end;

                continue;
            }

            if (at + 2 >= text.Length || !Uri.IsHexDigit(text[at + 1]) || !Uri.IsHexDigit(text[at + 2]))
            {
                throw new JsonFormException("a % that two hexadecimal digits do not follow");
            }

            var value = Convert.ToByte(text.Substring(at + 1, 2), 16);

            if (keepsSlash && value == (byte)'/')
            {
                bytes.AddRange(Encoding.ASCII.GetBytes(text.Substring(at, 3)));
            }
            else
            {
                bytes.Add(value);
            }

            at += 3;
        }

        try
        {
            return Strict.GetString([.. bytes]);
        }
        catch (DecoderFallbackException reason)
        {
            throw new JsonFormException("a value whose bytes are not UTF-8", reason);
        }
    }

    // whether a raw segment is empty, `.` or `..`, raw or once percent-decoded (3.6)
    internal static bool IsDotOrEmpty(string segment)
    {
        if (segment is "" or "." or "..")
        {
            return true;
        }

        try
        {
            return PercentDecoded(segment, false) is "." or "..";
        }
        catch (JsonFormException)
        {
            return false;
        }
    }

    private static readonly UTF8Encoding Strict = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private static bool IsLiteralCharacter(char character)
    {
        return char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '~' or '-';
    }

    private static int Compare(List<int> one, List<int> other)
    {
        for (var index = 0; index < Math.Min(one.Count, other.Count); index += 1)
        {
            if (one[index] != other[index])
            {
                return one[index].CompareTo(other[index]);
            }
        }

        return one.Count.CompareTo(other.Count);
    }

    // its segments' ranks by 3.5's order, a template that ends where the path ends before a `**`
    // that takes none there
    private List<int> RanksOf(int count)
    {
        var ranks = _segments.Select((segment) =>
        {
            return segment.Kind switch
            {
                HttpSegmentKind.Literal => LiteralRank,
                HttpSegmentKind.Star => StarRank,
                _ => StarsRank,
            };
        }).ToList();

        if (_segments.Count == count)
        {
            ranks.Add(EndRank);
        }

        return ranks;
    }

    private void Read()
    {
        if (!Text.StartsWith('/'))
        {
            throw new FormatException("a template that does not begin with /");
        }

        _position = 1;
        ReadSegments(false);

        if (_position < Text.Length && Text[_position] == ':')
        {
            var start = _position + 1;
            var end = start;

            while (end < Text.Length && IsLiteralCharacter(Text[end]))
            {
                end += 1;
            }

            if (end == start || end != Text.Length)
            {
                throw new FormatException("a verb that is no literal");
            }

            Verb = Text[start..end];
            _position = end;
        }

        if (_position != Text.Length)
        {
            throw new FormatException("a literal that is no segment");
        }

        for (var index = 0; index < _segments.Count - 1; index += 1)
        {
            if (_segments[index].Kind == HttpSegmentKind.Stars)
            {
                throw new FormatException("a ** that is not its last segment");
            }
        }
    }

    private void ReadSegments(bool isInside)
    {
        while (true)
        {
            ReadSegment(isInside);

            if (_position < Text.Length && Text[_position] == '/')
            {
                _position += 1;

                continue;
            }

            return;
        }
    }

    private void ReadSegment(bool isInside)
    {
        if (string.CompareOrdinal(Text, _position, "**", 0, 2) == 0)
        {
            _segments.Add(new HttpSegment(HttpSegmentKind.Stars, null));
            _position += 2;
        }
        else if (_position < Text.Length && Text[_position] == '*')
        {
            _segments.Add(new HttpSegment(HttpSegmentKind.Star, null));
            _position += 1;
        }
        else if (_position < Text.Length && Text[_position] == '{')
        {
            ReadVariable(isInside);
        }
        else
        {
            var end = _position;

            while (end < Text.Length && IsLiteralCharacter(Text[end]))
            {
                end += 1;
            }

            if (end == _position)
            {
                throw new FormatException("a literal that is no segment");
            }

            _segments.Add(new HttpSegment(HttpSegmentKind.Literal, Text[_position..end]));
            _position = end;
        }
    }

    private void ReadVariable(bool isInside)
    {
        if (isInside)
        {
            throw new FormatException("a variable within a variable");
        }

        var fieldPath = FieldPathAt(_position + 1) ?? throw new FormatException("a variable that names no field path");
        var start = _segments.Count;

        _position += 1 + fieldPath.Length;

        if (_position < Text.Length && Text[_position] == '=')
        {
            _position += 1;
            ReadSegments(true);
        }
        else
        {
            _segments.Add(new HttpSegment(HttpSegmentKind.Star, null));
        }

        if (_position >= Text.Length || Text[_position] != '}')
        {
            throw new FormatException("a variable that does not close");
        }

        _position += 1;
        _variables.Add(new HttpVariable(fieldPath, start, _segments.Count));
    }

    // a field path at `at`, `[A-Za-z_][A-Za-z0-9_]*` by `.`, the longest there; none where none is
    private string? FieldPathAt(int at)
    {
        var end = at;

        while (true)
        {
            if (end >= Text.Length || !(char.IsAsciiLetter(Text[end]) || Text[end] == '_'))
            {
                break;
            }

            end += 1;

            while (end < Text.Length && (char.IsAsciiLetterOrDigit(Text[end]) || Text[end] == '_'))
            {
                end += 1;
            }

            var isDotted = end + 1 < Text.Length && Text[end] == '.' && (char.IsAsciiLetter(Text[end + 1]) || Text[end + 1] == '_');

            if (!isDotted)
            {
                return Text[at..end];
            }

            end += 1;
        }

        return end == at ? null : Text[at..end];
    }
}
