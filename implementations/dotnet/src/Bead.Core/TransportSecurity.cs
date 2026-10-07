namespace Bead;

/// <summary>
/// Whether a transport is secure (spec 13.4), judged by what it is given, never by what a name
/// resolves to: under TLS, its scheme <c>wss</c> or <c>https</c>; or on the loopback, its host — the
/// one a client names, or the one a server listens on — as the WHATWG URL Standard's host parser
/// reads it, <see cref="UrlHost"/>: <c>localhost</c> or a name that ends in <c>.localhost</c>,
/// compared in ASCII lower case, an IPv4 address in 127.0.0.0/8, or <c>::1</c>, as the W3C's Secure
/// Contexts judges an origin potentially trustworthy. Any other leaves the machine in the clear,
/// which a bearer credential never crosses (RFC 6750 §5.3).
/// </summary>
internal static class TransportSecurity
{
    /// <summary>Whether a transport given these is secure: under TLS, or its host on the loopback.</summary>
    public static bool IsSecure((bool IsTls, string? Host) given)
    {
        return given.IsTls || (given.Host is { } host && IsLoopback(host));
    }

    /// <summary>
    /// Whether a host is on the loopback as the URL Standard's host parser reads it, an IPv6 one
    /// bracketed first when it is bare: <c>localhost</c>, a name that ends in <c>.localhost</c>, an
    /// IPv4 address in 127.0.0.0/8, <c>127.0.0.1.</c> and <c>127.1</c> among them, or <c>::1</c>;
    /// never <c>localhost.</c>, which the parser keeps as given, nor a host it fails on, one
    /// followed by a space among them, nor an IPv4 address mapped into IPv6, which no origin names
    /// so.
    /// </summary>
    public static bool IsLoopback(string host)
    {
        ArgumentNullException.ThrowIfNull(host);

        var bracketed = host.Contains(':', StringComparison.Ordinal) && !host.StartsWith('[') ? $"[{host}]" : host;

        if (UrlHost.Parse(bracketed) is not { } parsed)
        {
            return false;
        }

        var parts = parsed.Split('.');
        var isIPv4 = parts.Length == 4 && parts.All((part) =>
        {
            return part.Length is >= 1 and <= 3 && part.All(char.IsAsciiDigit);
        });

        return parsed == "localhost"
            || parsed.EndsWith(".localhost", StringComparison.Ordinal)
            || parsed == "[::1]"
            || (isIPv4 && parts[0] == "127");
    }
}
