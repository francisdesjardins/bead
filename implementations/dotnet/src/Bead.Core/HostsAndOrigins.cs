namespace Bead;

/// <summary>
/// The hosts and origins a server takes a request from, over HTTP as on a WebSocket's upgrade
/// (spec 15.2, 15.12). A request names its authority by its target in absolute-form, else by its
/// <c>Host</c>, which Kestrel fills from HTTP/2's <c>:authority</c>; an authority is a host and an
/// optional port, of 15.12's grammar, a restriction of RFC 3986 §3.2.2. Its host, the port aside,
/// is taken when every server takes it — <c>localhost</c>, a name under <c>.localhost</c>, an IPv6
/// address in brackets, an IPv4 address — or when the server's hosts list it, compared ASCII
/// case-insensitively (RFC 9110 §4.2.3), as the request carries it; <c>*</c> takes every host. A
/// request with no <c>Origin</c>, or one from its own origin, or from one among those it takes, is
/// taken. An origin is read as the serialized origin the field carries (RFC 6454 §6.2), compared as
/// a string, never parsed as a URL, as the TypeScript side compares it.
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

    /// <summary>The one entry of a server's hosts that takes every host, an empty one and none.</summary>
    public const string AnyHost = "*";

    /// <summary>What may stand around a field's value, and is not of it (RFC 9110 §5.5): SP and HTAB.</summary>
    public static readonly char[] FieldWhitespace = [' ', '\t'];

    // the localhost names' own domain (RFC 6761 §6.3)
    private const string Localhost = "localhost";

    // the characters a name holds besides letters and digits: RFC 3986's unreserved, and the
    // sub-delims no HTTP server refuses (spec 15.12)
    private const string NameMarks = "-._~!$&'()";

    // the schemes whose origin a browser serializes with its host in lower case and its default
    // port left out (RFC 6454 §6.2; the URL Standard's special schemes)
    private static readonly Dictionary<string, int> DefaultPorts = new(StringComparer.Ordinal)
    {
        ["http"] = 80,
        ["https"] = 443,
        ["ws"] = 80,
        ["wss"] = 443,
    };

    // helpers

    // whether a string is 15.12's name: letters, digits and the marks above, empty among them
    private static bool IsName(string text)
    {
        return text.All((character) =>
        {
            return char.IsAsciiLetterOrDigit(character) || NameMarks.Contains(character, StringComparison.Ordinal);
        });
    }

    // whether what stands between an IP-literal's brackets is RFC 3986's IPv6address
    private static bool IsIPv6Address(string text)
    {
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

    // whether a string is RFC 3986's dec-octet: 0 to 255, with no leading zero
    private static bool IsDecOctet(string text)
    {
        return text.Length is > 0 and < 4
            && text.All(char.IsAsciiDigit)
            && (text.Length == 1 || text[0] != '0')
            && int.Parse(text, System.Globalization.CultureInfo.InvariantCulture) <= 255;
    }

    // whether a port is one as a browser serializes it: a number of 0 to 65535, with no leading zero
    private static bool IsSerializedPort(string port)
    {
        return port.Length < 6
            && (port.Length == 1 || port[0] != '0')
            && int.Parse(port, System.Globalization.CultureInfo.InvariantCulture) <= 65_535;
    }

    // an authority read by 15.12's grammar, its host and its port apart: an IPv6 address in
    // brackets, or a name, then a colon and one digit at least, or nothing; none when it is not of it
    private static (string Host, string? Port)? PartsOf(string authority)
    {
        string host;
        string rest;

        if (authority.StartsWith('['))
        {
            var close = authority.IndexOf(']', StringComparison.Ordinal);

            if (close < 0 || !IsIPv6Address(authority[1..close]))
            {
                return null;
            }

            host = authority[..(close + 1)];
            rest = authority[(close + 1)..];
        }
        else
        {
            var colon = authority.IndexOf(':', StringComparison.Ordinal);

            host = colon < 0 ? authority : authority[..colon];
            rest = colon < 0 ? "" : authority[colon..];

            if (!IsName(host))
            {
                return null;
            }
        }

        if (rest.Length == 0)
        {
            return (host, null);
        }

        return rest[0] == ':' && rest.Length > 1 && rest[1..].All(char.IsAsciiDigit) ? (host, rest[1..]) : null;
    }

    // the error naming an entry of a server's option that is refused as it is built
    private static ArgumentException Refused((string Name, string Entry) option, string why)
    {
        return new ArgumentException($"{option.Name} cannot hold \"{option.Entry}\": {why}", option.Name);
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
    /// Whether a string is an authority of 15.12's grammar: a host — an IPv6 address in brackets, an
    /// IPv4 address, or a name of letters, digits and <c>-._~!$&amp;'()</c>, empty among them, with
    /// no percent-encoded octet — then a colon and one digit at least, or nothing.
    /// </summary>
    public static bool IsAuthority(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        return PartsOf(text) is not null;
    }

    /// <summary>
    /// Whether a request's <c>Host</c> is one HTTP takes (RFC 9112 §3.2), from its field lines as
    /// they came: one line at most, none only where <paramref name="isRequired"/> is false, as in an
    /// HTTP/1.0 request; its value, without the whitespace around it, an authority of 15.12's
    /// grammar, so none of a percent-encoded octet, <c>*+,;=</c> in a name, an <c>IPvFuture</c>
    /// literal or a colon with no port. An empty value is one, and so is a name of invalid punycode,
    /// which <see cref="IsTakenHost"/> judges.
    /// </summary>
    public static bool IsWellFormedHost(IReadOnlyList<string?> lines, bool isRequired)
    {
        ArgumentNullException.ThrowIfNull(lines);

        if (lines.Count == 0)
        {
            return !isRequired;
        }

        return lines.Count == 1 && IsAuthority((lines[0] ?? "").Trim(FieldWhitespace));
    }

    /// <summary>
    /// Whether an HTTP/1 request's <c>Host</c> and target are what HTTP takes: its <c>Host</c> as
    /// <see cref="IsWellFormedHost(IReadOnlyList{string?}, bool)"/> judges it; or, its target in
    /// absolute-form, that target's authority, judged in place of the <c>Host</c>'s value, which
    /// Kestrel ignores beside one (RFC 9112 §3.2.2), the <c>Host</c>'s lines counted alone.
    /// </summary>
    public static bool IsWellFormedHost(IReadOnlyList<string?> lines, (bool IsRequired, string? TargetAuthority) request)
    {
        ArgumentNullException.ThrowIfNull(lines);

        if (request.TargetAuthority is not { } authority)
        {
            return IsWellFormedHost(lines, request.IsRequired);
        }

        return (lines.Count == 1 || (lines.Count == 0 && !request.IsRequired)) && IsAuthority(authority);
    }

    /// <summary>
    /// The authority an HTTP/1 request's target names when it is in absolute-form (RFC 9112 §3.2.2,
    /// §3.3): what follows its <c>http://</c> or <c>https://</c> up to its path, its query, its
    /// fragment or its end, as it came; none for a target of another form.
    /// </summary>
    public static string? TargetAuthorityOf(string? target)
    {
        // ! Kestrel reads a target as absolute-form by its scheme in lower case alone, and refuses
        // 400 any other it is given
        var scheme = target is null ? -1 : target.StartsWith("http://", StringComparison.Ordinal) ? 7 : target.StartsWith("https://", StringComparison.Ordinal) ? 8 : -1;

        if (scheme < 0)
        {
            return null;
        }

        var rest = target![scheme..];
        var end = rest.IndexOfAny(['/', '?', '#']);

        return end < 0 ? rest : rest[..end];
    }

    /// <summary>
    /// The authority a request names (spec 15.12): its absolute-form target's, given, the
    /// <c>Host</c> beside it ignored; otherwise its <c>Host</c>'s, from the field lines given,
    /// without the whitespace around it; none when it has none.
    /// </summary>
    public static string? AuthorityOf(IReadOnlyList<string?> lines, string? targetAuthority)
    {
        ArgumentNullException.ThrowIfNull(lines);

        return targetAuthority ?? (lines.Count == 0 ? null : (lines[0] ?? "").Trim(FieldWhitespace));
    }

    /// <summary>
    /// An authority's host, its port aside: the IPv6 address in its brackets, or what stands
    /// before its first colon.
    /// </summary>
    public static string HostPartOf(string authority)
    {
        ArgumentNullException.ThrowIfNull(authority);

        if (authority.StartsWith('['))
        {
            var close = authority.IndexOf(']', StringComparison.Ordinal);

            return close < 0 ? authority : authority[..(close + 1)];
        }

        var colon = authority.IndexOf(':', StringComparison.Ordinal);

        return colon < 0 ? authority : authority[..colon];
    }

    /// <summary>
    /// Whether a string is RFC 3986's <c>IPv4address</c>: four <c>dec-octet</c> joined by dots, each
    /// 0 to 255 with no leading zero — never as the platform's parser reads one, which takes
    /// <c>127.1</c>, octal, hexadecimal and a single number.
    /// </summary>
    public static bool IsIPv4Address(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var octets = text.Split('.');

        return octets.Length == 4 && octets.All(IsDecOctet);
    }

    /// <summary>
    /// Whether a string is an IP address a server listens on (spec 15.12): RFC 3986's
    /// <c>IPv4address</c>, or its <c>IPv6address</c> written bare, with no brackets and no zone, and
    /// not IPv4-mapped (<c>::ffff:0:0/96</c>, RFC 4291 §2.5.5.2), whose node's address is written as
    /// the IPv4 one — never as the platform's parser reads one, which takes <c>0</c> for
    /// <c>0.0.0.0</c>, <c>127.1</c>, octal, hexadecimal and a zone.
    /// </summary>
    public static bool IsIpAddress(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        return IsIPv4Address(text)
            || (IsIPv6Address(text) && !System.Net.IPAddress.Parse(text).IsIPv4MappedToIPv6);
    }

    /// <summary>
    /// The address a server is to listen on, as it starts: one <see cref="IsIpAddress"/> refuses is
    /// an <see cref="ArgumentException"/> naming the option, which tells how to write an IPv6
    /// address given in brackets.
    /// </summary>
    public static void AssertAddress(string address, string name)
    {
        ArgumentNullException.ThrowIfNull(address, name);

        if (IsIpAddress(address))
        {
            return;
        }

        var bare = address.Length > 2 && address.StartsWith('[') && address.EndsWith(']') ? address[1..^1] : null;
        var hint = bare is not null && IsIpAddress(bare) ? $": write {bare}, not {address}" : "";

        throw new ArgumentException($"a server listens on an IP address, not \"{address}\"{hint}", name);
    }

    /// <summary>
    /// Whether a field's value is one a server reads (spec 15.12): HTAB, SP and visible ASCII alone,
    /// so never a control character but HTAB, DEL among them, which RFC 9110 §5.5 calls invalid, nor
    /// a character past ASCII, which it keeps out of every field defined since, and which no origin
    /// holds (RFC 6454 §6.2); and neither SP nor HTAB at either end, which RFC 9113 §8.2.1 calls
    /// malformed, and which HTTP/1.1's parser strips before (RFC 9110 §5.5).
    /// </summary>
    public static bool IsVisibleField(string value)
    {
        ArgumentNullException.ThrowIfNull(value);

        if (value.Length > 0 && (FieldWhitespace.Contains(value[0]) || FieldWhitespace.Contains(value[^1])))
        {
            return false;
        }

        return value.All((character) =>
        {
            return character == '\t' || character is >= ' ' and <= '~';
        });
    }

    /// <summary>
    /// A request's <c>Origin</c> as a refusal tells it (spec 15.1): its field lines as they came,
    /// joined by <c>", "</c> (RFC 9110 §5.3); none when it sends none.
    /// </summary>
    public static string? OriginOf(IReadOnlyList<string?> lines)
    {
        ArgumentNullException.ThrowIfNull(lines);

        return lines.Count == 0 ? null : string.Join(", ", lines.Select((line) =>
        {
            return line ?? "";
        }));
    }

    /// <summary>
    /// Whether every server takes a host, whatever its hosts: <c>localhost</c>, a name that ends in
    /// <c>.localhost</c>, in any ASCII case, which a resolver answers with the loopback itself
    /// (RFC 6761 §6.3); an IPv6 address in brackets, and an IPv4 address, which no name a browser
    /// fetches is written as, so no page rebinds its name to one.
    /// </summary>
    public static bool IsTakenByEveryServer(string host)
    {
        ArgumentNullException.ThrowIfNull(host);

        if (host.StartsWith('[') && host.EndsWith(']'))
        {
            return IsIPv6Address(host[1..^1]);
        }

        return IsIPv4Address(host)
            || IsAsciiEqual(host, Localhost)
            || (host.Length > Localhost.Length && IsAsciiEqual(host[^(Localhost.Length + 1)..], $".{Localhost}"));
    }

    /// <summary>
    /// Whether a request naming <paramref name="authority"/> is taken: every one when
    /// <paramref name="hosts"/> is <c>*</c> alone, an empty one and none among them; otherwise one
    /// whose host, its port aside, every server takes, or one among <paramref name="hosts"/>, in any
    /// ASCII case; never an empty host, nor a request that names none.
    /// </summary>
    public static bool IsTakenHost(string? authority, IReadOnlyList<string>? hosts)
    {
        if (hosts is [AnyHost])
        {
            return true;
        }

        if (authority is null)
        {
            return false;
        }

        var host = HostPartOf(authority);

        if (host.Length == 0)
        {
            return false;
        }

        return IsTakenByEveryServer(host) || (hosts ?? []).Any((taken) =>
        {
            return IsAsciiEqual(taken, host);
        });
    }

    /// <summary>
    /// Whether a request from <paramref name="origin"/> is taken: one with no <c>Origin</c> comes
    /// from no page, and is; one among <c>Origins</c>, exactly; or the server's own, <c>http://</c>
    /// or <c>https://</c> followed by the request's authority as it carries it, in any ASCII case.
    /// Any other, <c>null</c> and every other scheme among them, or a request without a host, is
    /// none of its own.
    /// </summary>
    public static bool IsTakenOrigin(string? origin, (string? Authority, IReadOnlyList<string> Origins) taken)
    {
        ArgumentNullException.ThrowIfNull(taken.Origins);

        if (origin is null || taken.Origins.Contains(origin, StringComparer.Ordinal))
        {
            return true;
        }

        // the field read as the serialized origin a browser writes from the URL it writes its Host
        // from, so neither is parsed: a default port, a path or another scheme is another origin
        return !string.IsNullOrEmpty(taken.Authority)
            && (IsAsciiEqual(origin, $"http://{taken.Authority}") || IsAsciiEqual(origin, $"https://{taken.Authority}"));
    }

    /// <summary>
    /// Whether <paramref name="origin"/> is among the pages an HTTP server answers CORS to (spec
    /// 15.12): an <c>Origin</c> among <paramref name="origins"/>, exactly, as
    /// <see cref="IsTakenOrigin"/> compares them, <c>null</c> among them; none is never listed, and
    /// the server's own origin only when named.
    /// </summary>
    public static bool IsListedOrigin(string? origin, IReadOnlyList<string> origins)
    {
        ArgumentNullException.ThrowIfNull(origins);

        return origin is not null && origins.Contains(origin, StringComparer.Ordinal);
    }

    /// <summary>
    /// A server's hosts, as it is built: none, or entries each a host without its port, or
    /// <c>*</c> alone. An entry with a port, an empty one, one that is no host by 15.12's grammar — a
    /// Unicode name among them, which the field never carries — and <c>*</c> beside another are an
    /// <see cref="ArgumentException"/> naming the option and the entry.
    /// </summary>
    public static void AssertHosts(IReadOnlyList<string>? entries, string name)
    {
        if (entries is null)
        {
            return;
        }

        foreach (var entry in entries)
        {
            ArgumentNullException.ThrowIfNull(entry, name);

            if (entry == AnyHost)
            {
                if (entries.Count > 1)
                {
                    throw Refused((name, entry), "* takes every host, and stands alone");
                }

                continue;
            }

            if (entry.Length == 0)
            {
                throw Refused((name, entry), "an empty host is taken under * alone");
            }

            if (PartsOf(entry) is not { } parts || parts.Host.Length == 0)
            {
                throw Refused((name, entry), "it is no host, as a request's Host carries one, an IDN in its punycode");
            }

            if (parts.Port is not null)
            {
                throw Refused((name, entry), "a host is taken on any port, and is given without one");
            }
        }
    }

    /// <summary>
    /// A server's origins, as it is built: each <c>null</c>, or an origin as RFC 6454 §6.2
    /// serializes it — a scheme in lower case, <c>://</c>, a host of 15.12's grammar and a port
    /// with no leading zero, nothing after; for <c>http</c>, <c>https</c>, <c>ws</c> and
    /// <c>wss</c>, the host in lower case and no port where it is the scheme's default. <c>*</c>, and
    /// any other entry, is an <see cref="ArgumentException"/> naming the option and the entry.
    /// </summary>
    public static void AssertOrigins(IReadOnlyList<string>? entries, string name)
    {
        foreach (var entry in entries ?? [])
        {
            ArgumentNullException.ThrowIfNull(entry, name);

            if (entry == "null")
            {
                continue;
            }

            if (entry == AnyHost)
            {
                throw Refused((name, entry), "no wildcard of origins exists; each entry is null or one origin, and a page of any other is refused");
            }

            var separator = entry.IndexOf("://", StringComparison.Ordinal);
            var scheme = separator < 0 ? "" : entry[..separator];
            var isScheme = scheme.Length > 0
                && char.IsAsciiLetterLower(scheme[0])
                && scheme.All((character) =>
                {
                    return char.IsAsciiLetterLower(character) || char.IsAsciiDigit(character) || character is '+' or '-' or '.';
                });

            if (!isScheme || PartsOf(entry[(separator + 3)..]) is not { } parts || parts.Host.Length == 0)
            {
                throw Refused((name, entry), "it is no origin as a browser serializes one, a scheme, :// and a host, with an optional port and nothing after");
            }

            if (parts.Port is { } port && !IsSerializedPort(port))
            {
                throw Refused((name, entry), "a browser writes a port as a number of 0 to 65535 with no leading zero");
            }

            if (DefaultPorts.TryGetValue(scheme, out var defaultPort))
            {
                if (parts.Host.Any(char.IsAsciiLetterUpper))
                {
                    throw Refused((name, entry), "a browser writes the host of an origin in lower case");
                }

                if (parts.Port is { } given && int.Parse(given, System.Globalization.CultureInfo.InvariantCulture) == defaultPort)
                {
                    throw Refused((name, entry), "a browser leaves the scheme's default port out of an origin");
                }
            }
        }
    }
}
