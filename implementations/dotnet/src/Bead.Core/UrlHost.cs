using System.Globalization;
using System.Text;

namespace Bead;

/// <summary>
/// A host as the WHATWG URL Standard's host parser reads it for a special scheme's URL, by which
/// the W3C's Secure Contexts reads an origin, and as that standard serializes it: a domain in ASCII
/// lower case, an IPv4 address in its four decimal numbers, an IPv6 one bracketed and compressed.
/// The TypeScript side reads a host by its platform's URL parser, which is that standard's.
/// </summary>
internal static class UrlHost
{
    // constants

    // the largest an IPv4 number need be told from: past it, every address it is part of fails
    private const long Past = 1L << 40;

    // what no host holds, and what no domain holds besides (URL Standard, "forbidden host code
    // point", "forbidden domain code point")
    private const string ForbiddenInAHost = "\0\t\n\r #/:<>?@[\\]^|";

    private static readonly IdnMapping Idna = new() { UseStd3AsciiRules = false };

    // helpers

    private static bool IsForbiddenInADomain(char character)
    {
        return ForbiddenInAHost.Contains(character, StringComparison.Ordinal) || character is <= '\u001f' or '%' or '\u007f';
    }

    // the bytes of text's UTF-8, each %XX of two hex digits read as the byte it spells, read back
    // as UTF-8, what does not read as UTF-8 replaced
    private static string PercentDecodedOf(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        var decoded = new List<byte>(bytes.Length);

        for (var index = 0; index < bytes.Length; index += 1)
        {
            if (bytes[index] == '%'
                && index + 2 < bytes.Length
                && char.IsAsciiHexDigit((char)bytes[index + 1])
                && char.IsAsciiHexDigit((char)bytes[index + 2]))
            {
                decoded.Add(byte.Parse(Encoding.ASCII.GetString(bytes, index + 1, 2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture));
                index += 2;
            }
            else
            {
                decoded.Add(bytes[index]);
            }
        }

        return Encoding.UTF8.GetString([.. decoded]);
    }

    // a domain in ASCII, as UTS #46's ToASCII gives it, its checks those the URL Standard asks when
    // it is not strict; none when it fails. An ASCII domain with no label in xn-- is lowercased alone
    private static string? AsciiDomainOf(string domain)
    {
        var labels = domain.Split('.');
        var isPlain = Ascii.IsValid(domain) && !labels.Any((label) =>
        {
            return label.StartsWith("xn--", StringComparison.OrdinalIgnoreCase);
        });
        string ascii;

        if (isPlain)
        {
            ascii = string.Create(domain.Length, domain, (lowered, given) =>
            {
                for (var index = 0; index < given.Length; index += 1)
                {
                    lowered[index] = char.IsAsciiLetterUpper(given[index]) ? (char)(given[index] + ('a' - 'A')) : given[index];
                }
            });
        }
        else
        {
            try
            {
                ascii = Idna.GetAscii(domain);
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        return ascii.Length == 0 || ascii.Any(IsForbiddenInADomain) ? null : ascii;
    }

    // a part of an IPv4 address: decimal, hexadecimal after 0x, octal after 0; none when it is not
    // a number, and past every address beyond Past
    private static long? NumberOf(string part)
    {
        if (part.Length == 0)
        {
            return null;
        }

        var radix = 10;
        var digits = part;

        if (digits.Length >= 2 && digits[0] == '0' && digits[1] is 'x' or 'X')
        {
            (radix, digits) = (16, digits[2..]);
        }
        else if (digits.Length >= 2 && digits[0] == '0')
        {
            (radix, digits) = (8, digits[1..]);
        }

        long value = 0;

        foreach (var digit in digits)
        {
            var weight = char.IsAsciiDigit(digit) ? digit - '0' : char.IsAsciiHexDigit(digit) ? (digit | 0x20) - 'a' + 10 : radix;

            if (weight >= radix)
            {
                return null;
            }

            value = Math.Min((value * radix) + weight, Past);
        }

        return value;
    }

    // whether a domain ends in a number, which makes it an IPv4 address or nothing
    private static bool EndsInANumber(string domain)
    {
        var parts = domain.Split('.').ToList();

        if (parts[^1].Length == 0)
        {
            if (parts.Count == 1)
            {
                return false;
            }

            parts.RemoveAt(parts.Count - 1);
        }

        var last = parts[^1];

        return (last.Length > 0 && last.All(char.IsAsciiDigit)) || (last.Length >= 2 && last[0] == '0' && last[1] is 'x' or 'X' && NumberOf(last) is not null);
    }

    // an IPv4 address of one to four numbers, the last filling what the others leave, one dot after
    // them taken; none when it is not one
    private static string? IPv4Of(string domain)
    {
        var parts = domain.Split('.').ToList();

        if (parts[^1].Length == 0 && parts.Count > 1)
        {
            parts.RemoveAt(parts.Count - 1);
        }

        if (parts.Count > 4)
        {
            return null;
        }

        var numbers = new List<long>();

        foreach (var part in parts)
        {
            if (NumberOf(part) is not { } number)
            {
                return null;
            }

            numbers.Add(number);
        }

        if (numbers.Take(numbers.Count - 1).Any((number) =>
        {
            return number > 255;
        }) || numbers[^1] >= 1L << (8 * (5 - numbers.Count)))
        {
            return null;
        }

        var address = numbers[^1];

        for (var index = 0; index < numbers.Count - 1; index += 1)
        {
            address += numbers[index] << (8 * (3 - index));
        }

        return string.Join('.', Enumerable.Range(0, 4).Select((index) =>
        {
            return ((address >> (8 * (3 - index))) & 0xff).ToString(CultureInfo.InvariantCulture);
        }));
    }

    // an IPv6 address, its eight pieces, as the URL Standard's IPv6 parser reads one: hexadecimal
    // pieces, one :: at most, an IPv4 address of four decimal numbers in its last 32 bits; none when
    // it is not one
    private static ushort[]? IPv6Of(string text)
    {
        var address = new ushort[8];
        var pieceIndex = 0;
        int? compress = null;
        var pointer = 0;
        var at = (int index) =>
        {
            return index < text.Length ? text[index] : '￿';
        };

        if (at(pointer) == ':')
        {
            if (at(pointer + 1) != ':')
            {
                return null;
            }

            pointer += 2;
            pieceIndex += 1;
            compress = pieceIndex;
        }

        while (pointer < text.Length)
        {
            if (pieceIndex == 8)
            {
                return null;
            }

            if (at(pointer) == ':')
            {
                if (compress is not null)
                {
                    return null;
                }

                pointer += 1;
                pieceIndex += 1;
                compress = pieceIndex;

                continue;
            }

            var value = 0;
            var length = 0;

            while (length < 4 && char.IsAsciiHexDigit(at(pointer)))
            {
                value = (value * 0x10) + Convert.ToInt32(at(pointer).ToString(), 16);
                pointer += 1;
                length += 1;
            }

            if (at(pointer) == '.')
            {
                if (length == 0 || pieceIndex > 6)
                {
                    return null;
                }

                pointer -= length;

                var numbersSeen = 0;

                while (pointer < text.Length)
                {
                    int? piece = null;

                    if (numbersSeen > 0)
                    {
                        if (at(pointer) != '.' || numbersSeen >= 4)
                        {
                            return null;
                        }

                        pointer += 1;
                    }

                    if (!char.IsAsciiDigit(at(pointer)))
                    {
                        return null;
                    }

                    while (char.IsAsciiDigit(at(pointer)))
                    {
                        var number = at(pointer) - '0';

                        if (piece == 0)
                        {
                            return null;
                        }

                        piece = ((piece ?? 0) * 10) + number;

                        if (piece > 255)
                        {
                            return null;
                        }

                        pointer += 1;
                    }

                    address[pieceIndex] = (ushort)((address[pieceIndex] * 0x100) + piece!.Value);
                    numbersSeen += 1;

                    if (numbersSeen is 2 or 4)
                    {
                        pieceIndex += 1;
                    }
                }

                if (numbersSeen != 4)
                {
                    return null;
                }

                break;
            }

            if (at(pointer) == ':')
            {
                pointer += 1;

                if (pointer >= text.Length)
                {
                    return null;
                }
            }
            else if (pointer < text.Length)
            {
                return null;
            }

            address[pieceIndex] = (ushort)value;
            pieceIndex += 1;
        }

        if (compress is { } compressed)
        {
            var swaps = pieceIndex - compressed;

            pieceIndex = 7;

            while (pieceIndex != 0 && swaps > 0)
            {
                (address[pieceIndex], address[compressed + swaps - 1]) = (address[compressed + swaps - 1], address[pieceIndex]);
                pieceIndex -= 1;
                swaps -= 1;
            }
        }
        else if (pieceIndex != 8)
        {
            return null;
        }

        return address;
    }

    // an IPv6 address as the URL Standard serializes it: bracketed, its pieces in lower-case hex,
    // the first longest run of two zero pieces or more written ::
    private static string SerializedOf(ushort[] address)
    {
        var (start, length) = (-1, 1);

        for (var index = 0; index < 8; index += 1)
        {
            var run = 0;

            while (index + run < 8 && address[index + run] == 0)
            {
                run += 1;
            }

            if (run > length)
            {
                (start, length) = (index, run);
            }
        }

        var text = new StringBuilder("[");

        for (var index = 0; index < 8; index += 1)
        {
            if (index == start)
            {
                text.Append(index == 0 ? "::" : ":");
                index += length - 1;

                continue;
            }

            text.Append(address[index].ToString("x", CultureInfo.InvariantCulture));

            if (index < 7)
            {
                text.Append(':');
            }
        }

        return text.Append(']').ToString();
    }

    // definition

    /// <summary>
    /// The host <paramref name="input"/> is, as the URL Standard's host parser reads it for a special
    /// scheme's URL and serializes it; none where that parser fails: a host that holds a space, say.
    /// </summary>
    public static string? Parse(string input)
    {
        ArgumentNullException.ThrowIfNull(input);

        if (input.StartsWith('['))
        {
            return input.EndsWith(']') && IPv6Of(input[1..^1]) is { } address ? SerializedOf(address) : null;
        }

        if (input.Length == 0 || AsciiDomainOf(PercentDecodedOf(input)) is not { } domain)
        {
            return null;
        }

        return EndsInANumber(domain) ? IPv4Of(domain) : domain;
    }
}
