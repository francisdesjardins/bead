namespace Bead;

/// <summary>
/// The hosts and origins a server takes a request from, over HTTP as on a WebSocket's upgrade
/// (spec 15.2, 15.12): a host among those it takes, every host when given none; a request with no
/// <c>Origin</c>, or one from its own origin, or from one among those it takes. A host is compared
/// ASCII case-insensitively (RFC 9110 §4.2.3), as the request's field carries it. An origin is read
/// as the serialized origin the field carries (RFC 6454 §6.2), compared as a string, never parsed
/// as a URL, as the TypeScript side compares it.
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

    // helpers

    // whether two strings are one but for the case of A to Z: every other character as it is
    private static bool IsAsciiEqual(string text, string other)
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
