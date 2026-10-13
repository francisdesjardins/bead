using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Bead;

/// <summary>
/// The proxies a server believes <c>X-Forwarded-For</c> from, over HTTP or over WebSocket alike, and
/// the client's address it reads past them (spec 15.12): each an IP address in the form a server
/// listens on, or a network, that address, <c>/</c> and its prefix's length (RFC 4632 §3.1, RFC
/// 4291 §2.3), from 1, its bits past the prefix zero. While the address reached is one they hold,
/// the next entry from the right is the client's, when it is an address in one of RFC 7239 §6's
/// node forms, unquoted, its port dropped; any other entry ends the walk, as nginx's
/// <c>real_ip_recursive</c> and Express's <c>trust proxy</c> walk it. Every address so read, and the
/// socket's, is held in one form: an IPv4-mapped one as its IPv4 address (RFC 4291 §2.5.5.2), an
/// IPv6 one in RFC 5952 §4's text, hexadecimal throughout, written here rather than by the
/// platform, which writes some IPv6 addresses with a dotted IPv4 tail.
/// </summary>
internal static class TrustedProxies
{
    // constants

    // the bits of each family's address
    private const int IPv4Bits = 32;
    private const int IPv6Bits = 128;

    // helpers

    // the error naming an entry of the option that is refused as it is built
    private static ArgumentException Refused((string Name, string Entry) option, string why)
    {
        return new ArgumentException($"{option.Name} cannot hold \"{option.Entry}\": {why}", option.Name);
    }

    // whether a string is a port as RFC 7239 §6 writes a node's: 1 to 5 digits
    private static bool IsPort(string text)
    {
        return text.Length is > 0 and < 6 && text.All(char.IsAsciiDigit);
    }

    // an address with no zone: what a network holds, and what the one form writes
    private static IPAddress Unzoned(IPAddress address)
    {
        return address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : new IPAddress(address.GetAddressBytes());
    }

    // an IPv6 address as RFC 5952 §4 writes it: each group in lower-case hexadecimal without its
    // leading zeros, the longest run of two zero groups or more, the first of equals, as "::"
    private static string IPv6TextOf(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        var groups = new int[8];

        for (var index = 0; index < groups.Length; index += 1)
        {
            groups[index] = (bytes[2 * index] << 8) | bytes[(2 * index) + 1];
        }

        var (runStart, runLength) = (-1, 0);

        for (var index = 0; index < groups.Length; index += 1)
        {
            var length = 0;

            while (index + length < groups.Length && groups[index + length] == 0)
            {
                length += 1;
            }

            if (length > runLength && length > 1)
            {
                (runStart, runLength) = (index, length);
            }

            index += length;
        }

        var text = new StringBuilder();

        for (var index = 0; index < groups.Length; index += 1)
        {
            if (index == runStart)
            {
                text.Append("::");
                index += runLength - 1;

                continue;
            }

            if (text.Length > 0 && text[^1] != ':')
            {
                text.Append(':');
            }

            text.Append(groups[index].ToString("x", CultureInfo.InvariantCulture));
        }

        return text.ToString();
    }

    // an entry read by RFC 7239 §6's node forms, unquoted: an IPv4 address, bare or with its port;
    // an IPv6 address without a zone, bare, or in brackets with or without its port; none for any
    // other, a zone, a name or unknown among them
    private static IPAddress? ParsedEntry(string entry)
    {
        var text = entry.Trim(HostsAndOrigins.FieldWhitespace);

        // ! read by its grammar, never by IPAddress.TryParse or IPEndPoint.TryParse alone, which take
        // a zone, brackets and a port, and more forms than RFC 3986 holds
        if (text.StartsWith('['))
        {
            var close = text.IndexOf(']', StringComparison.Ordinal);

            if (close < 0)
            {
                return null;
            }

            var rest = text[(close + 1)..];
            var isNode = rest.Length == 0 || (rest[0] == ':' && IsPort(rest[1..]));

            return isNode && HostsAndOrigins.IsIPv6Address(text[1..close]) ? Unzoned(IPAddress.Parse(text[1..close])) : null;
        }

        var colon = text.LastIndexOf(':');

        if (colon > 0 && HostsAndOrigins.IsIPv4Address(text[..colon]) && IsPort(text[(colon + 1)..]))
        {
            return IPAddress.Parse(text[..colon]);
        }

        if (HostsAndOrigins.IsIPv4Address(text))
        {
            return IPAddress.Parse(text);
        }

        return HostsAndOrigins.IsIPv6Address(text) ? Unzoned(IPAddress.Parse(text)) : null;
    }

    // whether one of the proxies holds an address, of its own family alone
    private static bool IsTrusted(IPAddress address, IReadOnlyList<IPNetwork> proxies)
    {
        return proxies.Any((network) =>
        {
            return network.BaseAddress.AddressFamily == address.AddressFamily && network.Contains(address);
        });
    }

    // an entry read as its network, or refused naming the option and the entry
    private static IPNetwork NetworkOf((string Name, string Entry) option)
    {
        var entry = option.Entry;
        var slash = entry.IndexOf('/', StringComparison.Ordinal);
        var text = slash < 0 ? entry : entry[..slash];

        if (!HostsAndOrigins.IsIpAddress(text))
        {
            var bare = text.Length > 2 && text.StartsWith('[') && text.EndsWith(']') ? text[1..^1] : null;
            var hint = bare is not null && HostsAndOrigins.IsIpAddress(bare) ? $"; write {bare}, not {text}" : "";

            throw Refused(option, $"a proxy is an IP address written bare, as a server listens on one, or a network of one{hint}");
        }

        var address = IPAddress.Parse(text);
        var bits = address.AddressFamily == AddressFamily.InterNetwork ? IPv4Bits : IPv6Bits;

        if (slash < 0)
        {
            return new IPNetwork(address, bits);
        }

        var prefix = entry[(slash + 1)..];

        if (prefix.Length is 0 or > 3 || !prefix.All(char.IsAsciiDigit) || (prefix.Length > 1 && prefix[0] == '0'))
        {
            throw Refused(option, "a network is an address, / and its prefix's length, in decimal");
        }

        var length = int.Parse(prefix, CultureInfo.InvariantCulture);

        if (length == 0)
        {
            throw Refused(option, "a network of prefix 0 would trust what every client writes");
        }

        if (length > bits)
        {
            throw Refused(option, $"a prefix is at most {bits} bits long");
        }

        var bytes = address.GetAddressBytes();
        var masked = bytes.Select((value, index) =>
        {
            var kept = Math.Clamp(length - (8 * index), 0, 8);

            return (byte)(value & (0xFF00 >> kept));
        }).ToArray();

        // ! the platform's parser masks bits set past the prefix in silence, and would trust a
        // network other than the one written
        if (!masked.SequenceEqual(bytes))
        {
            throw Refused(option, $"its bits past the prefix are set: write {FormOf(new IPAddress(masked))}/{length}, not {entry}");
        }

        return new IPNetwork(address, length);
    }

    // definition

    /// <summary>
    /// An address in its one form (spec 15.12): an IPv4-mapped one, or an IPv4 one, as its IPv4
    /// address in four decimal numbers; any other IPv6 one as RFC 5952 §4 writes it, its zone left
    /// out.
    /// </summary>
    public static string FormOf(IPAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);

        var unzoned = Unzoned(address);

        return unzoned.AddressFamily == AddressFamily.InterNetwork ? unzoned.ToString() : IPv6TextOf(unzoned);
    }

    /// <summary>
    /// An <c>X-Forwarded-For</c> entry read as an address in its one form, its surrounding
    /// whitespace removed: an IPv4 address, or an IPv6 address without a zone, bare, or as RFC 7239
    /// §6 writes a node unquoted — an IPv4 address followed by <c>:</c> and a port, an IPv6 address
    /// in brackets, followed or not by <c>:</c> and a port — its port dropped; none for any other.
    /// </summary>
    public static string? AddressOfEntry(string entry)
    {
        ArgumentNullException.ThrowIfNull(entry);

        return ParsedEntry(entry) is { } address ? FormOf(address) : null;
    }

    /// <summary>
    /// A server's trusted proxies, as it is built: none, or entries each an IP address in the form a
    /// server listens on, or a network, that address followed by <c>/</c> and its prefix's length,
    /// from 1 to its family's bits, written with no leading zero, its bits past the prefix zero. A
    /// name, an address in brackets, with a zone or IPv4-mapped, a network of prefix 0, which would
    /// trust what every client writes, and any other entry are an <see cref="ArgumentException"/>
    /// naming the option and the entry.
    /// </summary>
    public static void Assert(IReadOnlyList<string>? entries, string name)
    {
        _ = NetworksOf(entries, name);
    }

    /// <summary>
    /// The networks a server's trusted proxies name, as <see cref="Assert"/> takes them: an address
    /// alone is a network of its family's bits.
    /// </summary>
    public static IReadOnlyList<IPNetwork> NetworksOf(IReadOnlyList<string>? entries, string name)
    {
        return [.. (entries ?? []).Select((entry) =>
        {
            ArgumentNullException.ThrowIfNull(entry, name);

            return NetworkOf((name, entry));
        })];
    }

    /// <summary>
    /// The client's address (spec 15.12): the socket's, then, while the address reached is one the
    /// proxies hold, the next entry of <c>X-Forwarded-For</c> from the right, its lines joined by
    /// commas, when that entry is an address; any other entry, or the field's end, ends the walk.
    /// Its one form, as <see cref="FormOf"/> writes it.
    /// </summary>
    public static string ClientAddressOf(IPAddress remote, (string? Forwarded, IReadOnlyList<IPNetwork> Proxies) given)
    {
        ArgumentNullException.ThrowIfNull(remote);
        ArgumentNullException.ThrowIfNull(given.Proxies);

        var address = Unzoned(remote);
        var entries = given.Forwarded is null ? [] : given.Forwarded.Split(',');
        var index = entries.Length;

        // * from the right, past each proxy it names: what a client wrote to the left of the first
        // address none of them holds is never read
        while (index > 0 && IsTrusted(address, given.Proxies))
        {
            index -= 1;

            if (ParsedEntry(entries[index]) is not { } read)
            {
                break;
            }

            address = read;
        }

        return FormOf(address);
    }
}
