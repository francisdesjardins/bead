namespace Bead.Tests;

/// <summary>
/// The addresses a server listens on, and the forms it refuses (spec 15.12), as the TypeScript
/// side's tests hold them alike: a name; the short, hexadecimal, octal, padded and one-number forms;
/// a leading zero; a final dot; brackets; a zone; an IPv4-mapped address.
/// </summary>
internal static class Addresses
{
    /// <summary>The addresses a server listens on: the loopback and every interface, of each family.</summary>
    public static readonly string[] Listening = ["127.0.0.1", "0.0.0.0", "::1", "::"];

    /// <summary>The forms it refuses, each one the platform's parser takes but a name, a final dot and brackets.</summary>
    public static readonly string[] NotListening =
    [
        "localhost",
        "127.1",
        "0x7f.0.0.1",
        "0177.0.0.1",
        "127.000.000.001",
        "2130706433",
        "1",
        "0",
        "1.2.3.04",
        "127.0.0.1.",
        "[::1]",
        "fe80::1%4",
        "::ffff:127.0.0.1",
    ];

    /// <summary>
    /// The loopback address of each family the name <c>localhost</c> resolves to here: the IPv4 one,
    /// and the IPv6 one where the machine has IPv6 and its resolver answers it.
    /// </summary>
    public static IReadOnlyList<string> ReachedByLocalhost()
    {
        var resolved = System.Net.Dns.GetHostAddresses("localhost");

        return System.Net.Sockets.Socket.OSSupportsIPv6 && resolved.Contains(System.Net.IPAddress.IPv6Loopback) ? ["127.0.0.1", "::1"] : ["127.0.0.1"];
    }
}
