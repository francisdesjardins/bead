namespace Bead;

/// <summary>
/// The hosts and origins a server takes a request from, over HTTP as on a WebSocket's upgrade
/// (spec 15.2, 15.12): a host among those it takes, every host when given none; a request with no
/// <c>Origin</c>, or one from its own origin, or from one among those it takes. A host is compared
/// ASCII case-insensitively (RFC 9110 §4.2.3), as the request's field carries it. An origin is read
/// as the serialized origin the field carries (RFC 6454 §6.2), compared as a string, never parsed
/// as a URL, as the TypeScript side compares it. Before either, the request's <c>Host</c> is one
/// HTTP takes (RFC 9112 §3.2).
/// </summary>
internal static class HostsAndOrigins
{
    // constants

    /// <summary>The field that marks a refusal of the transport's own, beside its status.</summary>
    public const string RefusalHeader = "bead-refusal";

    /// <summary>A host the server does not take: 403.</summary>
    public const string HostRefusal = "host-refused";

    /// <summary>
    /// A request whose <c>Origin</c> is neither the server's own nor among those it takes: 403.
    /// </summary>
    public const string OriginRefusal = "origin-refused";

    /// <summary>What may stand around a field's value, and is not of it (RFC 9110 §5.5): SP and HTAB.</summary>
    public static readonly char[] FieldWhitespace = [' ', '\t'];

    // helpers

    // the characters a reg-name holds besides a percent-encoded octet: RFC 3986's unreserved and
    // sub-delims (§2.2, §2.3)
    private const string RegNameMarks = "-._~!$&'()*+,;=";

    // whether a character is one of RFC 3986's unreserved or sub-delims
    private static bool IsRegNameCharacter(char character)
    {
        return char.IsAsciiLetterOrDigit(character) || RegNameMarks.Contains(character, StringComparison.Ordinal);
    }

    // whether a string is RFC 3986's reg-name, an IPv4 address among them (§3.2.2): each character
    // unreserved, a sub-delim, or a percent-encoded octet; empty among them
    private static bool IsRegName(string text)
    {
        for (var index = 0; index < text.Length; index += 1)
        {
            if (text[index] == '%')
            {
                if (index + 2 >= text.Length || !char.IsAsciiHexDigit(text[index + 1]) || !char.IsAsciiHexDigit(text[index + 2]))
                {
                    return false;
                }

                index += 2;
            }
            else if (!IsRegNameCharacter(text[index]))
            {
                return false;
            }
        }

        return true;
    }

    // whether what stands between an IP-literal's brackets is RFC 3986's IPv6address or IPvFuture
    // (§3.2.2): "v", hexadecimal digits, a dot, then unreserved, sub-delims or colons
    private static bool IsIpLiteral(string text)
    {
        if (text.StartsWith('v') || text.StartsWith('V'))
        {
            var dot = text.IndexOf('.', StringComparison.Ordinal);

            return dot > 1
                && dot < text.Length - 1
                && text[1..dot].All(char.IsAsciiHexDigit)
                && text[(dot + 1)..].All((character) =>
                {
                    return character == ':' || IsRegNameCharacter(character);
                });
        }

        // ! the platform's parser takes a zone or a prefix length, which RFC 3986 does not: hex
        // digits, colons and dots alone reach it
        return text.Length > 0
            && text.All((character) =>
            {
                return char.IsAsciiHexDigit(character) || character == ':' || character == '.';
            })
            && System.Net.IPAddress.TryParse(text, out var address)
            && address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6;
    }

    // whether a string is RFC 9110's Host value, uri-host and an optional port (§7.2): an
    // IP-literal in brackets or a reg-name, then a colon and digits, or nothing
    private static bool IsHostValue(string value)
    {
        string port;

        if (value.StartsWith('['))
        {
            var close = value.IndexOf(']', StringComparison.Ordinal);

            if (close < 0 || !IsIpLiteral(value[1..close]))
            {
                return false;
            }

            port = value[(close + 1)..];
        }
        else
        {
            var colon = value.IndexOf(':', StringComparison.Ordinal);

            if (!IsRegName(colon < 0 ? value : value[..colon]))
            {
                return false;
            }

            port = colon < 0 ? "" : value[colon..];
        }

        return port.Length == 0 || (port[0] == ':' && port[1..].All(char.IsAsciiDigit));
    }

    /// <summary>Whether two strings are one but for the case of A to Z: every other character as it is.</summary>
    public static bool IsAsciiEqual(string text, string other)
    {
        if (text.Length != other.Length)
        {
            return false;
        }

        for (var index = 0; index < text.Length; index += 1)
        {
            if (AsciiLowerOf(text[index]) != AsciiLowerOf(other[index]))
            {
                return false;
            }
        }

        return true;
    }

    // a character in ASCII lower case: A to Z alone, any other as it is
    private static char AsciiLowerOf(char character)
    {
        return char.IsAsciiLetterUpper(character) ? (char)(character + ('a' - 'A')) : character;
    }

    // definition

    /// <summary>
    /// Whether a request's <c>Host</c> is one HTTP takes (RFC 9112 §3.2), from its field lines as
    /// they came: one line at most, none only where <paramref name="isRequired"/> is false, as in an
    /// HTTP/1.0 request; its value, without the whitespace around it, <c>uri-host</c> and an
    /// optional port (RFC 9110 §7.2, RFC 3986 §3.2.2–3.2.3). An empty value is one, and so is a name
    /// of invalid punycode, which <see cref="IsTakenHost"/> judges.
    /// </summary>
    public static bool IsWellFormedHost(IReadOnlyList<string?> lines, bool isRequired)
    {
        ArgumentNullException.ThrowIfNull(lines);

        if (lines.Count == 0)
        {
            return !isRequired;
        }

        return lines.Count == 1 && IsHostValue((lines[0] ?? "").Trim(FieldWhitespace));
    }

    /// <summary>
    /// Whether a request naming <paramref name="host"/> is taken: every one when
    /// <paramref name="hosts"/> is none; otherwise one among them, in any ASCII case, and never a
    /// request that names none.
    /// </summary>
    public static bool IsTakenHost(string? host, IReadOnlyList<string>? hosts)
    {
        if (hosts is null)
        {
            return true;
        }

        return !string.IsNullOrEmpty(host) && hosts.Any((taken) =>
        {
            return IsAsciiEqual(taken, host);
        });
    }

    /// <summary>
    /// Whether a request from <paramref name="origin"/> is taken: one with no <c>Origin</c> comes
    /// from no page, and is; one among <c>Origins</c>, exactly; or the server's own, <c>http://</c>
    /// or <c>https://</c> followed by the request's <c>Host</c> as its field carries it, in any ASCII
    /// case. Any other, <c>null</c> and every other scheme among them, or a request without a host,
    /// is none of its own.
    /// </summary>
    public static bool IsTakenOrigin(string? origin, (string? Host, IReadOnlyList<string> Origins) taken)
    {
        ArgumentNullException.ThrowIfNull(taken.Origins);

        if (origin is null || taken.Origins.Contains(origin, StringComparer.Ordinal))
        {
            return true;
        }

        // the field read as the serialized origin a browser writes from the URL it writes its Host
        // from, so neither is parsed: a default port, a path or another scheme is another origin
        return !string.IsNullOrEmpty(taken.Host)
            && (IsAsciiEqual(origin, $"http://{taken.Host}") || IsAsciiEqual(origin, $"https://{taken.Host}"));
    }
}
