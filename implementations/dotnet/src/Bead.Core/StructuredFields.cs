using System.Globalization;
using System.Text;
using System.Text.Unicode;

namespace Bead;

/// <summary>
/// A field's value read as an Item of RFC 9651, Structured Field Values for HTTP: a bare item and
/// its parameters, parsed as §4.2 parses one, the field's lines combined first, as its caller gives
/// them. What a field of Bead's holds is one constraint on that Item, judged by its reader; a
/// parameter it does not know it ignores (§2.3). The TypeScript side's <c>parseItem</c> is its twin.
/// </summary>
internal static class StructuredFields
{
    // constants

    // the longest an Integer is, its sign aside, and a Decimal, its point among them (§3.3.1, §3.3.2)
    private const int IntegerDigits = 15;
    private const int DecimalCharacters = 16;
    private const int DecimalIntegerDigits = 12;
    private const int DecimalFractionDigits = 3;

    // what a Token holds past its first character, besides letters and digits: tchar's others
    // (RFC 9110 §5.6.2), ':' and '/' (§3.3.4)
    private const string TokenCharacters = "!#$%&'*+-.^_`|~:/";

    // what a key holds past its first character, besides lower-case letters and digits (§3.1.2)
    private const string KeyCharacters = "_-.*";

    // what a Byte Sequence's base64 holds, besides letters and digits (§3.3.5, RFC 4648 §4)
    private const string Base64Characters = "+/=";

    /// <summary>
    /// The Item a field's value is, its leading and trailing spaces discarded; none when it does not
    /// parse, anything left over after it among the failures (§4.2). A <c>-0</c> is the Integer 0
    /// (§4.2.4).
    /// </summary>
    public static Item? ParseItem(string value)
    {
        ArgumentNullException.ThrowIfNull(value);

        var reader = new Reader(value);

        reader.SkipSpaces();

        var item = reader.Item();

        reader.SkipSpaces();

        return reader.IsAtEnd ? item : null;
    }

    /// <summary>
    /// An Item (§3.3): its bare item — a <see cref="long"/> Integer, a <see cref="decimal"/>
    /// Decimal, a <see cref="string"/> String, a <see cref="Token"/>, a <see cref="ByteSequence"/>,
    /// a <see cref="bool"/> Boolean, a <see cref="Date"/> or a <see cref="DisplayString"/> — and
    /// its parameters, in the order they came, a key given twice holding its last value at its first
    /// place (§4.2.3.2).
    /// </summary>
    public sealed record Item(object BareItem, IReadOnlyDictionary<string, object> Parameters);

    /// <summary>A Token (§3.3.4), told apart from a String.</summary>
    public sealed record Token(string Value);

    /// <summary>A Byte Sequence (§3.3.5): the octets its base64 spells, in base64 again.</summary>
    public sealed record ByteSequence(string Base64);

    /// <summary>A Date (§3.3.7): seconds since the Unix epoch, an Integer.</summary>
    public sealed record Date(long Seconds);

    /// <summary>A Display String (§3.3.8): Unicode text, told apart from a String.</summary>
    public sealed record DisplayString(string Value);

    // reads an Item, one character after the other, as §4.2's algorithms do: each read gives none
    // where parsing fails
    private sealed class Reader(string input)
    {
        private int _position;

        public bool IsAtEnd
        {
            get
            {
                return _position == input.Length;
            }
        }

        // the leading spaces, SP alone, never HTAB (§4.2)
        public void SkipSpaces()
        {
            while (Peek() == ' ')
            {
                _position += 1;
            }
        }

        // §4.2.3
        public Item? Item()
        {
            if (BareItem() is not { } bareItem)
            {
                return null;
            }

            return Parameters() is { } parameters ? new Item(bareItem, parameters) : null;
        }

        // the next character, or none at the end
        private char? Peek()
        {
            return IsAtEnd ? null : input[_position];
        }

        // takes the next character when it is the one given
        private bool Take(char character)
        {
            if (Peek() != character)
            {
                return false;
            }

            _position += 1;

            return true;
        }

        // §4.2.3.1: told by its first character
        private object? BareItem()
        {
            return Peek() switch
            {
                '-' or (>= '0' and <= '9') => Number(),
                '"' => String(),
                '*' or (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') => Token(),
                ':' => ByteSequence(),
                '?' => Boolean(),
                '@' => Date(),
                '%' => DisplayString(),
                _ => null,
            };
        }

        // §4.2.3.2: each `;`, a key, and its value, true when it has none
        private OrderedDictionary<string, object>? Parameters()
        {
            var parameters = new OrderedDictionary<string, object>(StringComparer.Ordinal);

            while (Take(';'))
            {
                SkipSpaces();

                if (Key() is not { } key)
                {
                    return null;
                }

                object value = true;

                if (Take('='))
                {
                    if (BareItem() is not { } bareItem)
                    {
                        return null;
                    }

                    value = bareItem;
                }

                parameters[key] = value;
            }

            return parameters;
        }

        // §4.2.3.3: a lower-case letter or `*`, then lower-case letters, digits and `_-.*`
        private string? Key()
        {
            var start = _position;

            if (Peek() is not ((>= 'a' and <= 'z') or '*'))
            {
                return null;
            }

            _position += 1;

            while (Peek() is { } character && (char.IsAsciiLetterLower(character) || char.IsAsciiDigit(character) || KeyCharacters.Contains(character, StringComparison.Ordinal)))
            {
                _position += 1;
            }

            return input[start.._position];
        }

        // §4.2.4: an Integer of 15 digits at most, or a Decimal of 12 before its point and 3 after
        private object? Number()
        {
            var isNegative = Take('-');

            if (Peek() is not { } first || !char.IsAsciiDigit(first))
            {
                return null;
            }

            var start = _position;
            var isDecimal = false;

            while (Peek() is { } character)
            {
                if (char.IsAsciiDigit(character))
                {
                    _position += 1;
                }
                else if (!isDecimal && character == '.')
                {
                    if (_position - start > DecimalIntegerDigits)
                    {
                        return null;
                    }

                    isDecimal = true;
                    _position += 1;
                }
                else
                {
                    break;
                }

                if (_position - start > (isDecimal ? DecimalCharacters : IntegerDigits))
                {
                    return null;
                }
            }

            var number = input[start.._position];

            if (!isDecimal)
            {
                var integer = long.Parse(number, NumberStyles.None, CultureInfo.InvariantCulture);

                return isNegative ? -integer : integer;
            }

            var point = number.IndexOf('.', StringComparison.Ordinal);

            if (point == number.Length - 1 || number.Length - point - 1 > DecimalFractionDigits)
            {
                return null;
            }

            var decimalNumber = decimal.Parse(number, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);

            return isNegative ? -decimalNumber : decimalNumber;
        }

        // §4.2.5: printable ASCII between quotes, `"` and `\` escaped by `\`
        private string? String()
        {
            Take('"');

            var text = new StringBuilder();

            while (Peek() is { } character)
            {
                _position += 1;

                if (character == '\\')
                {
                    if (Peek() is not ('"' or '\\'))
                    {
                        return null;
                    }

                    text.Append(input[_position]);
                    _position += 1;
                }
                else if (character == '"')
                {
                    return text.ToString();
                }
                else if (character is < ' ' or > '~')
                {
                    return null;
                }
                else
                {
                    text.Append(character);
                }
            }

            return null;
        }

        // §4.2.6: a letter or `*`, then tchar, `:` and `/`
        private Token Token()
        {
            var start = _position;

            _position += 1;

            while (Peek() is { } character && (char.IsAsciiLetterOrDigit(character) || TokenCharacters.Contains(character, StringComparison.Ordinal)))
            {
                _position += 1;
            }

            return new Token(input[start.._position]);
        }

        // §4.2.7: base64 between colons; its padding left out whole is taken, as §4.2.7 lets a parser
        private ByteSequence? ByteSequence()
        {
            Take(':');

            var end = input.IndexOf(':', _position);

            if (end < 0)
            {
                return null;
            }

            var base64 = input[_position..end];

            _position = end + 1;

            if (!base64.All((character) =>
            {
                return char.IsAsciiLetterOrDigit(character) || Base64Characters.Contains(character, StringComparison.Ordinal);
            }))
            {
                return null;
            }

            // * padded whole, or not at all: a padding given in part, or past its length, is refused
            var padded = base64.Contains('=', StringComparison.Ordinal) ? base64 : base64.PadRight((base64.Length + 3) / 4 * 4, '=');
            var bytes = new byte[padded.Length / 4 * 3];

            return Convert.TryFromBase64String(padded, bytes, out var written) ? new ByteSequence(Convert.ToBase64String(bytes, 0, written)) : null;
        }

        // §4.2.8: `?1` or `?0`
        private bool? Boolean()
        {
            Take('?');

            if (Take('1'))
            {
                return true;
            }

            if (Take('0'))
            {
                return false;
            }

            return null;
        }

        // §4.2.9: `@` and an Integer
        private Date? Date()
        {
            Take('@');

            return Number() is long seconds ? new Date(seconds) : null;
        }

        // §4.2.10: `%`, then printable ASCII between quotes, each octet past it as `%` and two
        // lower-case hex digits, the whole read as UTF-8
        private DisplayString? DisplayString()
        {
            Take('%');

            if (!Take('"'))
            {
                return null;
            }

            var octets = new List<byte>();

            while (Peek() is { } character)
            {
                _position += 1;

                if (character is < ' ' or > '~')
                {
                    return null;
                }

                if (character == '"')
                {
                    var utf8 = octets.ToArray();

                    return Utf8.IsValid(utf8) ? new DisplayString(Encoding.UTF8.GetString(utf8)) : null;
                }

                if (character != '%')
                {
                    octets.Add((byte)character);

                    continue;
                }

                if (_position + 2 > input.Length || !IsLowerHex(input[_position]) || !IsLowerHex(input[_position + 1]))
                {
                    return null;
                }

                octets.Add(byte.Parse(input.AsSpan(_position, 2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture));
                _position += 2;
            }

            return null;
        }

        private static bool IsLowerHex(char character)
        {
            return char.IsAsciiDigit(character) || character is >= 'a' and <= 'f';
        }
    }
}
