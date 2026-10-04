using System.Net;
using System.Net.Sockets;

namespace Bead;

/// <summary>
/// Whether a transport is secure (spec 13.4), judged by what it is given, never by what a name
/// resolves to: under TLS, its scheme <c>wss</c> or <c>https</c>; or on the loopback, its host — the
/// one a client names, or the one a server listens on — <c>localhost</c> or a name that ends in
/// <c>.localhost</c>, compared in ASCII lower case, an IPv4 address in 127.0.0.0/8, or <c>::1</c>, as
/// the W3C's Secure Contexts judges an origin potentially trustworthy. Any other leaves the machine
/// in the clear, which a bearer credential never crosses (RFC 6750 §5.3).
/// </summary>
internal static class TransportSecurity
{
    /// <summary>Whether a transport given these is secure: under TLS, or its host on the loopback.</summary>
    public static bool IsSecure((bool IsTls, string? Host) given)
    {
        return given.IsTls || (given.Host is { } host && IsLoopback(host));
    }

    /// <summary>
    /// Whether a host is on the loopback: <c>localhost</c>, a name that ends in <c>.localhost</c>, an
    /// IPv4 address in 127.0.0.0/8, or <c>::1</c>, bracketed or not; never an IPv4 address mapped
    /// into IPv6, which no origin names so.
    /// </summary>
    public static bool IsLoopback(string host)
    {
        ArgumentNullException.ThrowIfNull(host);

        var name = AsciiLowerOf(host.StartsWith('[') && host.EndsWith(']') ? host[1..^1] : host);

        if (name == "localhost" || name.EndsWith(".localhost", StringComparison.Ordinal))
        {
            return true;
        }

        if (!IPAddress.TryParse(name, out var address))
        {
            return false;
        }

        return address.AddressFamily == AddressFamily.InterNetwork
            ? address.GetAddressBytes()[0] == 127
            : address.Equals(IPAddress.IPv6Loopback);
    }

    // a name in ASCII lower case: A to Z alone, every other character as it is
    private static string AsciiLowerOf(string name)
    {
        return string.Create(name.Length, name, (lowered, given) =>
        {
            for (var index = 0; index < given.Length; index += 1)
            {
                lowered[index] = char.IsAsciiLetterUpper(given[index]) ? (char)(given[index] + ('a' - 'A')) : given[index];
            }
        });
    }
}
