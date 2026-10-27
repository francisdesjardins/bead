using System.Net;

namespace Bead.Tests;

/// <summary>
/// <see cref="TrustedProxies"/>: the proxies an HTTP server believes <c>X-Forwarded-For</c> from,
/// and the client's address it reads past them (spec 15.12), by the rows the TypeScript side judges
/// alike.
/// </summary>
public sealed class TrustedProxiesTests
{
    [Fact]
    public void Trusts_only_the_two_addresses_of_an_uncompressed_IPv6_prefix_of_127_bits()
    {
        const string network = "2001:db8:1:2:3:4:5:6/127";
        var trust = TrustOf([network], 0);
        string[] addresses = ["2001:db8:1:2:3:4:5:5", "2001:db8:1:2:3:4:5:6", "2001:db8:1:2:3:4:5:7", "2001:db8:1:2:3:4:5:8"];

        Assert.Equal(
            ["2001:db8:1:2:3:4:5:5", "203.0.113.9", "203.0.113.9", "2001:db8:1:2:3:4:5:8"],
            addresses.Select((address) =>
            {
                return TrustedProxies.ClientAddressOf(IPAddress.Parse(address), ("203.0.113.9", trust));
            }));
        var refused = Assert.Throws<ArgumentException>(() =>
        {
            TrustedProxies.Assert(["2001:db8:1:2:3:4:5:7/127"], "trustedProxies");
        });
        Assert.Equal($"trustedProxies cannot hold \"2001:db8:1:2:3:4:5:7/127\": its bits past the prefix are set: write {network}, not 2001:db8:1:2:3:4:5:7/127 (Parameter 'trustedProxies')", refused.Message);
        Assert.Equal("trustedProxies", refused.ParamName);
    }

    // constants

    private static readonly IPAddress Loopback = IPAddress.Loopback;

    // what no trustedProxies entry is: a name, a bracketed, zoned, mapped or lenient address, a
    // prefix of 0, past its family's bits, with host bits set or no prefix at all, and no entry
    private static readonly string[] RefusedEntries =
    [
        "nginx",
        "localhost",
        "[::1]",
        "fe80::1%eth0",
        "[2001:db8::]/32",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::ffff:10.0.0.0/104",
        "127.1",
        "10.0.0.0/0",
        "0.0.0.0/0",
        "::/0",
        "10.0.0.0/33",
        "2001:db8::/129",
        "10.1.2.3/8",
        "192.0.2.1/24",
        "fd00::1/8",
        "2001:db8::1/32",
        "2001:db8::1/127",
        "10.0.0.0/",
        "10.0.0.0/08",
        "10.0.0.0/-8",
        "10.0.0.0/a",
        "10.0.0.0/8/8",
        "",
        "*",
    ];

    // an entry in each of RFC 7239's node forms, unquoted, and in every way an address is written
    private static readonly string[] NodeForms =
    [
        "192.0.2.7",
        " \t192.0.2.7 ",
        " 192.0.2.7:51234 ",
        "192.0.2.7:51234",
        "::ffff:192.0.2.7",
        "::FFFF:c000:207",
        "[::ffff:192.0.2.7]:80",
        "[2001:DB8::1]:443",
        "2001:db8:0:0:0:0:0:1",
        "2001:DB8::1",
        "[2001:db8::1]",
        "[2001:db8::3]",
        "::192.0.2.1",
        "[::192.0.2.1]:1",
        "2001:db8:0:0:1:0:0:1",
        "2001:0:0:1:0:0:0:1",
        "0:0:0:0:0:0:0:0",
        "::1",
        "fe80::5efe:192.0.2.1",
        "::ffff:0:192.0.2.1",
    ];

    // no address: a zone, a name, unknown, an obfuscated node, an IPv4 address in brackets, an IPv6
    // one with a port and no brackets, a port past 5 digits or none, a lenient form
    private static readonly string[] NoAddresses = ["2001:db8::2%eth0", "[fe80::1%25eth0]", "[fe80::1%25eth0]:80", "bead.test", "proxy.example", "unknown", "_hidden", "\"[2001:db8::1]:443\"", "[192.0.2.7]", "[2001:db8::1]:", "[2001:db8::1]:123456", "192.0.2.7:", "192.0.2.7:123456", "127.1", "010.0.0.1", "", "\"192.0.2.7\""];

    // a socket's own address, in each of its forms, a zone among them
    private static readonly string[] SocketAddresses = ["::ffff:127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::192.0.2.1", "127.0.0.1", "2001:DB8::1%3", "fe80::1%3", "::ffff:192.0.2.7"];

    // entries a proxy forwards, each read in its one form, a zone and unknown ending the walk
    private static readonly string[] BehindAProxy = ["192.0.2.7:51234", "::ffff:192.0.2.7", "[2001:DB8::1]:443", "2001:db8:0:0:0:0:0:1", "[2001:db8::3]", "2001:db8::2%eth0", "unknown"];

    // helpers

    // the client's address behind the socket's, the field as it came, past the proxies named
    private static string ClientOf(IPAddress remote, (string? Forwarded, string[] Proxies) given)
    {
        return TrustedProxies.ClientAddressOf(remote, (given.Forwarded, TrustOf(given.Proxies, 0)));
    }

    // a server's trust: the proxies it names, and how many it counts that they do not
    private static ProxyTrust TrustOf(string[] named, int unnamed)
    {
        return TrustedProxies.TrustOf((named, "TrustedProxies"), (unnamed, "UnnamedProxies"));
    }

    // definition

    // spec 15.12
    [Fact]
    public void Refuses_a_trustedProxies_entry_that_is_a_name_a_bracketed_or_zoned_address_an_IPv4_mapped_one_a_prefix_of_0_or_past_its_family_s_bits_or_a_network_whose_bits_past_its_prefix_are_set()
    {
        TrustedProxies.Assert(null, "TrustedProxies");
        TrustedProxies.Assert([], "TrustedProxies");
        TrustedProxies.Assert(
            ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.1.178", "192.0.2.0/24", "192.0.2.1/32", "192.0.2.7/32", "0.0.0.0/1", "fd00::/8", "2001:DB8::/32", "2001:db8::1/128", "::/1"],
            "TrustedProxies");

        // each refused naming the option and the entry
        Assert.All(
            RefusedEntries,
            (entry) =>
            {
                foreach (var entries in new[] { new[] { entry }, new[] { "127.0.0.1", entry } })
                {
                    var refused = Assert.Throws<ArgumentException>(() =>
                    {
                        TrustedProxies.Assert(entries, "TrustedProxies");
                    });

                    Assert.Equal("TrustedProxies", refused.ParamName);
                    Assert.Contains($"\"{entry}\"", refused.Message, StringComparison.Ordinal);
                }
            });

        // prefix 0 told that it trusts what every client writes; host bits, the network to write
        Assert.Contains("would trust what every client writes", Assert.Throws<ArgumentException>(() =>
        {
            TrustedProxies.Assert(["::/0"], "TrustedProxies");
        }).Message, StringComparison.Ordinal);
        Assert.Contains("write 10.0.0.0/8, not 10.1.2.3/8", Assert.Throws<ArgumentException>(() =>
        {
            TrustedProxies.Assert(["10.1.2.3/8"], "TrustedProxies");
        }).Message, StringComparison.Ordinal);
        Assert.Contains("write fd00::/8, not fd00::1/8", Assert.Throws<ArgumentException>(() =>
        {
            TrustedProxies.Assert(["fd00::1/8"], "TrustedProxies");
        }).Message, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() =>
        {
            TrustOf(["nginx"], 0);
        });
        Assert.Contains("write ::1, not [::1]", Assert.Throws<ArgumentException>(() =>
        {
            TrustedProxies.Assert(["[::1]"], "TrustedProxies");
        }).Message, StringComparison.Ordinal);
    }

    // spec 15.12
    [Fact]
    public void Refuses_an_unnamedProxies_that_is_not_a_whole_number_from_0_to_8_Infinity_among_it_as_the_server_is_built()
    {
        // an int holds no fraction, no NaN and no Infinity: its largest stands for the count of every hop
        foreach (var count in new[] { -1, 9, int.MaxValue, int.MinValue })
        {
            var refused = Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return TrustOf([], count);
            });

            Assert.Equal("UnnamedProxies", refused.ParamName);
            Assert.StartsWith(
                $"UnnamedProxies is a whole number of proxies from 0 to 8, those TrustedProxies does not name: not {count.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
                refused.Message,
                StringComparison.Ordinal);
        }

        Assert.Equal(8, TrustedProxies.MaximumUnnamedProxies);

        foreach (var count in new[] { 0, 1, 3, 8 })
        {
            Assert.Equal(count, TrustOf([], count).Unnamed);
        }
    }

    // spec 15.12
    [Fact]
    public void Spends_unnamedProxies_on_each_address_trustedProxies_does_not_hold_none_on_one_it_holds_and_stops_at_the_first_past_the_count()
    {
        string Walked((string[] Named, int Unnamed) trust, (string Forwarded, string Remote) request)
        {
            return TrustedProxies.ClientAddressOf(IPAddress.Parse(request.Remote), (request.Forwarded, TrustOf(trust.Named, trust.Unnamed)));
        }

        Assert.Equal(
            [
                // a count alone: that many hops from the socket, whatever their address
                "192.0.2.1",
                "198.51.100.7",

                // a named hop passes free, wherever it stands: before the unnamed one or after it
                "198.51.100.7",
                "198.51.100.8",
                "203.0.113.9",

                // past the count, the first address none holds is the client: what it wrote left is not read
                "198.51.100.7",

                // a proxy both named and counted gives the client an entry it wrote
                "192.0.2.66",

                // an entry that is no address ends the walk within the count, and so does the field's end
                "192.0.2.1",
                "192.0.2.1",

                // 0 counts none: an unnamed socket's field is not read
                "127.0.0.1",
            ],
            [
                Walked(([], 1), ("198.51.100.7, 192.0.2.1", "127.0.0.1")),
                Walked(([], 2), ("203.0.113.9, 198.51.100.7, 192.0.2.1", "127.0.0.1")),
                Walked((["10.0.0.0/8"], 1), ("198.51.100.7, 10.0.0.5", "127.0.0.1")),
                Walked((["10.0.0.0/8"], 1), ("198.51.100.8, 10.0.0.6, 10.0.0.5", "127.0.0.1")),
                Walked((["10.0.0.0/8"], 1), ("203.0.113.9, 10.0.0.5, 198.51.100.7", "10.0.0.1")),
                Walked((["10.0.0.0/8"], 1), ("203.0.113.9, 198.51.100.7", "127.0.0.1")),
                Walked((["127.0.0.1/32"], 2), ("192.0.2.66, 203.0.113.1, 198.51.100.7", "127.0.0.1")),
                Walked(([], 3), ("unknown, 192.0.2.1", "127.0.0.1")),
                Walked(([], 3), ("192.0.2.1", "127.0.0.1")),
                Walked(([], 0), ("192.0.2.1", "127.0.0.1")),
            ]);
    }

    // spec 15.12
    [Fact]
    public void Walks_X_Forwarded_For_from_the_right_past_each_proxy_it_names_and_stops_at_the_first_address_none_holds_or_at_an_entry_that_is_no_address()
    {
        string[] proxies = ["127.0.0.0/8", "10.0.0.0/8"];

        Assert.Equal(
            [
                // one proxy, then two: the rightmost entry none of them holds
                "198.51.100.7",
                // none named, none read: the socket's
                "127.0.0.1",
                // no field: the socket's
                "127.0.0.1",
                // the rightmost entry no proxy holds, what a client wrote to its left never read
                "198.51.100.7",
                "198.51.100.7",
                // the field's end, past every proxy: the leftmost one reached
                "10.0.0.5",
                "10.0.0.7",
                // an entry that is no address ends the walk at the proxy that wrote it
                "10.0.0.5",
                "127.0.0.1",
                "10.0.0.5",
                "127.0.0.1",
                "127.0.0.1",
                // its lines joined by commas, whitespace around each entry dropped
                "198.51.100.7",
            ],
            [
                ClientOf(Loopback, ("198.51.100.7", proxies)),
                ClientOf(Loopback, ("203.0.113.9", [])),
                ClientOf(Loopback, (null, proxies)),
                ClientOf(Loopback, ("198.51.100.7, 10.0.0.5", proxies)),
                ClientOf(Loopback, ("203.0.113.9, 198.51.100.7, 10.0.0.6", proxies)),
                ClientOf(Loopback, ("10.0.0.5", proxies)),
                ClientOf(IPAddress.Parse("127.0.0.2"), ("10.0.0.7, 10.0.0.6", proxies)),
                ClientOf(Loopback, ("evil, 10.0.0.5", proxies)),
                ClientOf(Loopback, ("198.51.100.7, unknown", proxies)),
                ClientOf(Loopback, ("198.51.100.7, , 10.0.0.5", proxies)),
                ClientOf(Loopback, ("", proxies)),
                ClientOf(Loopback, ("198.51.100.7, ", proxies)),
                ClientOf(Loopback, ("203.0.113.9,\t198.51.100.7 ,10.0.0.5", proxies)),
            ]);

        // a socket no proxy holds is the client, whatever it forwards
        Assert.Equal("192.0.2.9", ClientOf(IPAddress.Parse("192.0.2.9"), ("203.0.113.9", proxies)));
    }

    // spec 15.12
    [Fact]
    public void Reads_an_entry_in_RFC_7239_s_node_forms_its_port_dropped_and_holds_it_in_one_form_an_IPv4_mapped_one_as_IPv4_IPv6_as_RFC_5952_writes_it_hexadecimal_throughout_a_zone_ends_the_walk()
    {
        Assert.Equal(
            [
                "192.0.2.7",
                "192.0.2.7",
                "192.0.2.7",
                "192.0.2.7",
                "192.0.2.7",
                "192.0.2.7",
                "192.0.2.7",
                "2001:db8::1",
                "2001:db8::1",
                "2001:db8::1",
                "2001:db8::1",
                "2001:db8::3",
                "::c000:201",
                "::c000:201",
                "2001:db8::1:0:0:1",
                "2001:0:0:1::1",
                "::",
                "::1",
                "fe80::5efe:c000:201",
                "::ffff:0:c000:201",
            ],
            NodeForms.Select(TrustedProxies.AddressOfEntry));

        // no address
        Assert.All(
            NoAddresses,
            (entry) =>
            {
                Assert.Null(TrustedProxies.AddressOfEntry(entry));
            });

        // each so held behind a proxy, a zone ending the walk at the proxy
        string[] proxies = ["127.0.0.1"];

        Assert.Equal(
            ["192.0.2.7", "192.0.2.7", "2001:db8::1", "2001:db8::1", "2001:db8::3", "127.0.0.1", "127.0.0.1"],
            BehindAProxy.Select((forwarded) =>
            {
                return ClientOf(Loopback, (forwarded, proxies));
            }));

        // and the socket's own address, in the same form, its zone left out
        Assert.Equal(
            ["127.0.0.1", "::1", "::1", "::c000:201", "127.0.0.1", "2001:db8::1", "fe80::1", "192.0.2.7"],
            SocketAddresses.Select((address) =>
            {
                return TrustedProxies.FormOf(IPAddress.Parse(address));
            }));
    }

    // spec 15.12
    [Fact]
    public void Holds_an_IPv4_client_of_a_dual_stack_socket_by_its_IPv4_address_against_an_IPv4_network()
    {
        var mapped = IPAddress.Parse("::ffff:10.0.0.5");

        // the socket's address, IPv4 mapped into IPv6, is the IPv4 address an IPv4 network holds
        Assert.Equal("203.0.113.9", ClientOf(mapped, ("203.0.113.9", ["10.0.0.0/8"])));
        Assert.Equal("10.0.0.5", ClientOf(mapped, ("203.0.113.9", ["192.168.0.0/16"])));
        Assert.Equal("10.0.0.5", ClientOf(mapped, (null, ["10.0.0.0/8"])));
        Assert.Equal("198.51.100.7", ClientOf(IPAddress.Parse("::ffff:127.0.0.1"), ("198.51.100.7", ["127.0.0.0/8", "10.0.0.0/8"])));
        Assert.Equal("198.51.100.8", ClientOf(mapped, ("198.51.100.8", ["127.0.0.0/8", "10.0.0.0/8"])));
        Assert.Equal("192.0.2.1", ClientOf(IPAddress.Parse("::ffff:192.0.2.1"), ("198.51.100.9", ["127.0.0.0/8", "10.0.0.0/8"])));

        // an IPv6 network holds no IPv4 address, nor an IPv4 network an IPv6 one
        Assert.Equal("10.0.0.5", ClientOf(mapped, ("203.0.113.9", ["::/1"])));
        Assert.Equal("2001:db8::5", ClientOf(IPAddress.Parse("2001:db8::5"), ("203.0.113.9", ["0.0.0.0/1", "128.0.0.0/1"])));
    }
}
