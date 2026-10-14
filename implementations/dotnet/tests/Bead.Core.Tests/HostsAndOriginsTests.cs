namespace Bead.Tests;

/// <summary>
/// <see cref="HostsAndOrigins"/>: the hosts and origins a server takes a request from, over HTTP
/// as on a WebSocket's upgrade (spec 15.2, 15.12), by the rows the TypeScript side judges alike.
/// </summary>
public sealed class HostsAndOriginsTests
{
    // constants

    private static readonly string[] Hosts = ["bead.test", "xn--bad-bma.test"];

    private static readonly string[] Origins = ["https://bead.example"];

    // hosts listed, taken by the host alone, the request's port aside, a default one among them
    private static readonly string[] ListedHosts = ["bead.test", "Bead.Test", "BEAD.TEST:8443", "bead.test:80", "bead.test:443", "XN--BAD-BMA.test:8080"];

    // an origins entry no browser writes as an origin: a wildcard, a URL in place of an origin, a
    // form a browser does not serialize, no origin at all
    private static readonly string[] OtherOrigins =
    [
        "*",
        "null",
        "http://*.bead.test",
        "http://bead.test/",
        "http://bead.test/path",
        "http://bead.test?query",
        "http://user@bead.test",
        "HTTP://bead.test",
        "http://Bead.Test",
        "http://bead.test:80",
        "https://bead.test:443",
        "ws://bead.test:80",
        "wss://bead.test:443",
        "http://bead.test:",
        "https://bead.test:0443",
        "http://bead.test:080",
        "http://bead.test:65536",
        "http://",
        "http://béad.test",
        "http://a*b.test",
        "https://[::1",
        "bead.test",
        "//bead.test",
        "http:bead.test",
        "1http://bead.test",
        " http://bead.test",
        "Null",
        "",
    ];

    // the long forms of an IPv6 address, the loopback's and another, and a mapped one's, then one
    // that ends in a colon
    private static readonly string[] LongIPv6Forms = ["0:0:0:0:0:0:0:1", "FE80::A", "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "::1:"];

    // RFC 3986's IPv4address, four dec-octet
    private static readonly string[] IPv4Addresses = ["0.0.0.0", "127.0.0.1", "192.0.2.1", "10.0.0.255", "255.255.255.255", "1.22.199.249"];

    // what the platform's parser takes and RFC 3986's dec-octet does not: fewer parts, octal,
    // hexadecimal, a single number, a leading zero; and an octet past 255, a part too many or
    // empty, a sign, a space
    private static readonly string[] OtherIPv4Addresses = ["127.1", "127.0.1", "0177.0.0.1", "0x7f.0.0.1", "2130706433", "127.0.0.01", "00.0.0.0", "256.0.0.1", "1.2.3.4.5", "1.2.3.", ".1.2.3", "1..2.3", "+1.2.3.4", "1.2.3.4 ", "", "localhost"];

    // the hosts every server takes, each by its host on any port or none: localhost and the names
    // under .localhost in any ASCII case, an IPv6 address in brackets, an IPv4 address
    private static readonly string[] TakenByEveryServer =
    [
        "localhost",
        "LocalHost:8080",
        "localhost:80",
        "bead.localhost",
        "Bead.LocalHost:8443",
        "a.b.localhost",
        ".localhost",
        "127.0.0.1",
        "127.0.0.1:8080",
        "192.0.2.1:80",
        "0.0.0.0",
        "255.255.255.255",
        "[::1]",
        "[::1]:8443",
        "[2001:db8::7]",
        "[::ffff:127.0.0.1]:8080",
    ];

    // and those it does not: a name, one that holds localhost or ends in it otherwise, an IPv4
    // address as no URL writes one, an empty host and none
    private static readonly string?[] NotTakenByEveryServer =
    [
        "elsewhere.test",
        "rebind.example:8080",
        "localhost.",
        "localhost.:8080",
        "localhost.example",
        "notlocalhost",
        "bead-localhost",
        "localhost.localhost.example",
        "127.0.0.1.example",
        "127.1",
        "0177.0.0.1",
        "0x7f.0.0.1",
        "2130706433",
        "127.0.0.01",
        "256.0.0.1",
        "1.2.3.4.5",
        "",
        ":8080",
        null,
    ];

    // a Host's value HTTP takes (RFC 9110 §7.2), as 15.12's grammar narrows it: a name, an IPv4
    // address or an IPv6 address in brackets, and an optional port of one digit at least, whitespace
    // around it; empty, and a name of invalid punycode, among them
    private static readonly string[] WellFormedHosts =
    [
        "bead.test",
        "bead.test:8080",
        "BEAD.test:8080",
        "bead.test:0",
        "bead.test:080",
        "bead.test:65536",
        "BEAD.TEST",
        "",
        ":8080",
        "127.0.0.1",
        "127.0.0.1:8080",
        "[::1]",
        "[::1]:8080",
        "[2001:db8::7]",
        "[::ffff:127.0.0.1]",
        "[::ffff:192.0.2.1]",
        "xn--a",
        "xn---bad-cpa.test",
        "bead_test~",
        "!$&'()",
        "a-._~!$&'()b",
        " bead.test\t",
    ];

    // and one it does not: a space, a userinfo, a path, a port not of digits or twice, an
    // IP-literal unclosed, followed by what is no port, or of what is no IPv6 address, a zone among
    // them, a percent-encoded octet, *+,;= in a name, an IPvFuture literal, a colon with no port, a
    // character past ASCII
    private static readonly string[] OtherHostValues =
    [
        "a%41.test",
        "bead%2Etest",
        "b%C3%A9ad.test",
        "a*b.test",
        "a+b.test",
        "a,b.test",
        "a;b=c",
        "a=b.test",
        "!$&'()*+,;=",
        "[v1.bead]",
        "[v1.fe80::a+en1]",
        "localhost:",
        "bead.test:",
        "[::1]:",
        "bad host",
        "user@bead.test",
        "bead/test",
        "bead.test/path",
        "bead.test?query",
        "bead.test#fragment",
        "bead.test:80x",
        "bead.test:80a",
        "bead.test:80:80",
        "bead.test:8080:1",
        "bead.test:-1",
        "[::1",
        "[::1]x",
        "[::1]:a",
        "[]",
        "[bead.test]",
        "[127.0.0.1]",
        "[::1%eth0]",
        "[::1%25eth0]",
        "[fe80::1%25eth0]",
        "[::1/64]",
        "[v.x]",
        "[v1.]",
        "bead%2test",
        "%zz.test",
        "bead.test%",
        "béad.test",
        "::1",
    ];

    // an origin, and the Host of a request that comes from it: the server's own, http:// or https://
    // followed by its Host, in any ASCII case, as a browser writes both from one URL first
    private static readonly (string Origin, string Host)[] Own =
    [
        ("http://bead.test", "bead.test"),
        ("https://bead.test", "bead.test"),
        ("http://bead.test:8080", "bead.test:8080"),
        ("https://bead.test:8443", "bead.test:8443"),
        ("http://127.0.0.1:8080", "127.0.0.1:8080"),
        ("http://[::1]:8080", "[::1]:8080"),
        ("http://localhost:8080", "localhost:8080"),
        ("http://xn--bad-bma.test", "xn--bad-bma.test"),
        ("https://xn--bad-bma.test:8443", "xn--bad-bma.test:8443"),
        ("http://bead.test", "Bead.Test"),
        ("HTTPS://BEAD.test", "bead.test"),
        ("http://XN--BAD-BMA.test", "xn--bad-bma.test"),
        ("http://xn--a.test", "xn--a.test"),
        ("http://bead.test:80", "bead.test:80"),
        ("http://bead.test.", "bead.test."),
    ];

    private static readonly (string Origin, string? Host)[] NotOwn =
    [
        ("http://bead.test", "bead.test:8080"),
        ("http://bead.test:8080", "bead.test"),
        ("https://elsewhere.test", "bead.test"),
        ("http://bead.test", null),
        ("http://", ""),
        ("null", "bead.test"),
        ("not an origin", "bead.test"),

        // the same origin written otherwise than the Host, which no browser sends: a default port on
        // one side alone, a host not in its canonical form, a path, a userinfo, a space
        ("http://bead.test:80", "bead.test"),
        ("https://bead.test:443", "bead.test"),
        ("http://bead.test", "bead.test:80"),
        ("https://bead.test:80", "bead.test"),
        ("http://127.1", "127.0.0.1"),
        ("http://[0:0::1]:8080", "[::1]:8080"),
        ("http://béad.test", "xn--bad-bma.test"),
        ("http://bead%2Etest", "bead.test"),
        ("http://bead.test.", "bead.test"),
        ("http://bead.test:", "bead.test"),
        ("http:bead.test", "bead.test"),
        ("http://bead.test/", "bead.test"),
        ("http://bead.test/path?query#fragment", "bead.test"),
        ("http://user@bead.test", "bead.test"),
        (" http://bead.test", "bead.test"),
        ("http://bead.test:8080x", "bead.test:8080"),
        ("http://[::1]x", "[::1]"),

        // any scheme but http and https, whatever host it names
        ("ws://bead.test", "bead.test"),
        ("wss://bead.test", "bead.test"),
        ("ftp://bead.test", "bead.test"),
        ("file://bead.test", "bead.test"),
        ("foo://bead.test", "bead.test"),
        ("chrome-extension://bead.test", "bead.test"),
        ("blob:http://bead.test", "bead.test"),
    ];

    // definition

    [Fact]
    public void Takes_a_Host_HTTP_takes_one_line_none_in_a_request_that_needs_none_its_value_uri_host_and_an_optional_port_without_the_whitespace_around_it_and_none_of_a_percent_encoded_octet_star_plus_comma_semicolon_or_equals_in_a_name_an_IPvFuture_literal_or_a_colon_with_no_port()
    {
        Assert.All(WellFormedHosts, (host) =>
        {
            Assert.True(HostsAndOrigins.IsWellFormedHost([host], true), host);
        });
        Assert.All(OtherHostValues, (host) =>
        {
            Assert.False(HostsAndOrigins.IsWellFormedHost([host], true), host);
        });

        // none, which an HTTP/1.1 request must send and an HTTP/1.0 one need not; two, even alike
        Assert.False(HostsAndOrigins.IsWellFormedHost([], true));
        Assert.True(HostsAndOrigins.IsWellFormedHost([], false));
        Assert.False(HostsAndOrigins.IsWellFormedHost(["bead.test", "bead.test"], true));
        Assert.False(HostsAndOrigins.IsWellFormedHost(["bead.test", "elsewhere.test"], false));
    }

    [Fact]
    public void Takes_whatever_its_hosts_localhost_the_names_under_localhost_and_IP_literals_each_by_its_host_on_any_port_and_no_other_host_nor_an_empty_one_nor_none_but_under_a_star()
    {
        string[]?[] every = [null, [], ["bead.test"], ["xn--bad-bma.test", "elsewhere.example"]];

        Assert.All(every, (hosts) =>
        {
            Assert.All(TakenByEveryServer, (host) =>
            {
                Assert.True(HostsAndOrigins.IsTakenHost(host, hosts), host);
            });
        });
        Assert.All(NotTakenByEveryServer, (host) =>
        {
            Assert.False(HostsAndOrigins.IsTakenHost(host, null), host);
            Assert.False(HostsAndOrigins.IsTakenHost(host, []), host);
            Assert.True(HostsAndOrigins.IsTakenHost(host, ["*"]), host);
        });
        Assert.Equal(("host-refused", "origin-refused"), (HostsAndOrigins.HostRefusal, HostsAndOrigins.OriginRefusal));
    }

    [Fact]
    public void Takes_the_hosts_given_besides_each_by_its_host_on_any_port_in_any_ASCII_case_and_every_host_and_none_under_a_star()
    {
        Assert.All(ListedHosts, (host) =>
        {
            Assert.True(HostsAndOrigins.IsTakenHost(host, Hosts), host);
        });

        // and no other: a name besides, one that holds a listed one, its Unicode form, an empty one, none
        Assert.All(new[] { "elsewhere.test", "bead.test.", "sub.bead.test", "bead.testing", "béad.test", "xn--a.test", "", ":8080", null }, (host) =>
        {
            Assert.False(HostsAndOrigins.IsTakenHost(host, Hosts), host);
        });

        // every host under * alone, an empty one and none among them
        Assert.All(new[] { "elsewhere.test", "rebind.example:8080", "xn--a", "", ":8080", null }, (host) =>
        {
            Assert.True(HostsAndOrigins.IsTakenHost(host, ["*"]), host);
        });
    }

    [Fact]
    public void Refuses_a_hosts_entry_with_a_port_an_empty_one_one_that_is_no_host_and_a_star_beside_another()
    {
        Assert.All(new string[]?[] { null, [], ["*"], ["bead.test"], ["Bead.Test", "xn--bad-bma.test", "127.0.0.1", "[::1]", "localhost"] }, (hosts) =>
        {
            HostsAndOrigins.AssertHosts(hosts, "Hosts");
        });

        // each refused naming the option and the entry
        Assert.All(new (string[] Hosts, string Entry)[]
        {
            (["bead.test:8080"], "bead.test:8080"),
            (["bead.test:"], "bead.test:"),
            (["127.0.0.1:8080"], "127.0.0.1:8080"),
            (["[::1]:8443"], "[::1]:8443"),
            ([""], ""),
            (["bead.test", ""], ""),
            ([":8080"], ":8080"),
            (["béad.test"], "béad.test"),
            (["bad host"], "bad host"),
            (["a*b.test"], "a*b.test"),
            (["bead.test/"], "bead.test/"),
            (["http://bead.test"], "http://bead.test"),
            (["[v1.bead]"], "[v1.bead]"),
            (["*.bead.test"], "*.bead.test"),
            (["*", "bead.test"], "*"),
            (["bead.test", "*"], "*"),
            (["*", "*"], "*"),
        }, (refusal) =>
        {
            var refused = Assert.Throws<ArgumentException>(() =>
            {
                HostsAndOrigins.AssertHosts(refusal.Hosts, "Hosts");
            });

            Assert.Equal("Hosts", refused.ParamName);
            Assert.Contains($"\"{refusal.Entry}\"", refused.Message, StringComparison.Ordinal);
        });
    }

    // spec 15.12
    [Fact]
    public void Refuses_an_origins_entry_that_is_a_star_or_null_or_not_an_origin_as_RFC_6454_serializes_it()
    {
        HostsAndOrigins.AssertOrigins(null, "Origins");
        HostsAndOrigins.AssertOrigins(
            [
                "http://bead.test",
                "https://bead.test",
                "http://bead.test:8080",
                "https://bead.test:8443",
                "https://bead.test:80",
                "ws://bead.test:443",
                "http://127.0.0.1:8080",
                "http://[::1]:8080",
                "http://localhost:0",
                "https://xn--bad-bma.test",
                "chrome-extension://abcdefghijklmnop",
                "tauri://localhost",
                "app://Bead.Test",
            ],
            "Origins");

        Assert.All(OtherOrigins, (origin) =>
        {
            var refused = Assert.Throws<ArgumentException>(() =>
            {
                HostsAndOrigins.AssertOrigins(["https://bead.example", origin], "Origins");
            });

            Assert.Equal("Origins", refused.ParamName);
            Assert.Contains($"\"{origin}\"", refused.Message, StringComparison.Ordinal);
        });

        // * told that no wildcard of origins exists
        Assert.Contains("no wildcard of origins", Assert.Throws<ArgumentException>(() =>
        {
            HostsAndOrigins.AssertOrigins(["*"], "Origins");
        }).Message, StringComparison.Ordinal);

        // null names every page with no origin of its own, and the message the better path
        Assert.EndsWith("serve the page from an origin, and name that one (Parameter 'Origins')", Assert.Throws<ArgumentException>(() =>
        {
            HostsAndOrigins.AssertOrigins(["https://bead.example", "null"], "Origins");
        }).Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Reads_an_IPv4_address_by_RFC_3986_s_grammar_never_as_the_platform_s_parser_reads_one()
    {
        Assert.All(IPv4Addresses, (address) =>
        {
            Assert.True(HostsAndOrigins.IsIPv4Address(address), address);
        });

        Assert.All(OtherIPv4Addresses, (address) =>
        {
            Assert.False(HostsAndOrigins.IsIPv4Address(address), address);
        });
        Assert.True(System.Net.IPAddress.TryParse("127.1", out _));
    }

    [Fact]
    public void IsIpAddress_takes_a_bare_IP_address_by_RFC_3986_s_grammar_and_refuses_a_name_every_other_form_brackets_a_zone_and_an_IPv4_mapped_address()
    {
        Assert.Equal(Addresses.Listening, Addresses.Listening.Where(HostsAndOrigins.IsIpAddress));
        Assert.DoesNotContain(Addresses.NotListening, HostsAndOrigins.IsIpAddress);

        // the long forms of an IPv6 address are its own, and a mapped one is refused in any of them
        Assert.Equal([true, true, false, false, false], LongIPv6Forms.Select(HostsAndOrigins.IsIpAddress));
    }

    [Fact]
    public void Refuses_to_listen_on_an_address_that_is_no_bare_IP_address_nor_localhost_naming_it_and_tells_a_bracketed_one_how_to_write_itself()
    {
        // localhost, exactly, both loopbacks: a keyword, never resolved, and no IP address
        foreach (var address in Addresses.Listening.Concat(Addresses.NamedListening))
        {
            HostsAndOrigins.AssertAddress(address, "Address");
        }

        Assert.DoesNotContain(Addresses.NamedListening, HostsAndOrigins.IsIpAddress);

        foreach (var name in new[] { "LOCALHOST", "localhost.", "a.localhost" })
        {
            var named = Assert.Throws<ArgumentException>(() =>
            {
                HostsAndOrigins.AssertAddress(name, "Address");
            });

            Assert.Equal(($"a server listens on an IP address, or on localhost, both loopbacks, not \"{name}\" (Parameter 'Address')", "Address"), (named.Message, named.ParamName));
        }

        var bracketed = Assert.Throws<ArgumentException>(() =>
        {
            HostsAndOrigins.AssertAddress("[::1]", "Address");
        });

        Assert.Equal("a server listens on an IP address, or on localhost, both loopbacks, not \"[::1]\": write ::1, not [::1] (Parameter 'Address')", bracketed.Message);
    }

    [Fact]
    public void IsVisibleField_takes_HTAB_SP_and_visible_ASCII_and_refuses_each_other_control_character_DEL_and_0x80_to_0xFF_none_at_either_end()
    {
        var visible = new string([.. Enumerable.Range(0x20, 0x7F - 0x20).Select((code) =>
        {
            return (char)code;
        })]);
        var others = Enumerable.Range(0, 0x20).Where((code) =>
        {
            return code != '\t';
        }).Concat(Enumerable.Range(0x7F, 0x100 - 0x7F)).Select((code) =>
        {
            return (char)code;
        }).ToList();

        // visible runs from SP, so it opens on a letter
        Assert.True(HostsAndOrigins.IsVisibleField($"a\t{visible}"));
        Assert.True(HostsAndOrigins.IsVisibleField(""));

        // neither SP nor HTAB at either end (RFC 9113 §8.2.1)
        Assert.Equal(
            [false, false, false, false, false, true],
            [
                HostsAndOrigins.IsVisibleField(" x"),
                HostsAndOrigins.IsVisibleField("x\t"),
                HostsAndOrigins.IsVisibleField("\tx"),
                HostsAndOrigins.IsVisibleField(" "),
                HostsAndOrigins.IsVisibleField("\t"),
                HostsAndOrigins.IsVisibleField("x \ty"),
            ]);
        Assert.DoesNotContain(others, (character) =>
        {
            return HostsAndOrigins.IsVisibleField($"a{character}b");
        });
        Assert.Equal(31 + 129, others.Count);
    }

    [Fact]
    public void Tells_a_request_s_Origin_as_it_came_its_field_lines_joined_by_a_comma_and_a_space_and_none_when_it_sends_none()
    {
        Assert.Equal(
            [null, "null", "https://a.test, null"],
            [HostsAndOrigins.OriginOf([]), HostsAndOrigins.OriginOf(["null"]), HostsAndOrigins.OriginOf(["https://a.test", "null"])]);
    }

    [Fact]
    public void Takes_a_request_with_no_Origin_one_among_those_given_and_the_server_s_own_http_or_https_followed_by_its_Host_in_any_ASCII_case_nothing_parsed()
    {
        // no page, or one among those given, exactly
        Assert.True(HostsAndOrigins.IsTakenOrigin(null, ("bead.test", Origins)));
        Assert.True(HostsAndOrigins.IsTakenOrigin("https://bead.example", ("bead.test", Origins)));
        Assert.False(HostsAndOrigins.IsTakenOrigin("null", ("bead.test", Origins)));
        Assert.False(HostsAndOrigins.IsTakenOrigin("https://Bead.Example", ("bead.test", Origins)));

        Assert.All(Own, (own) =>
        {
            Assert.True(HostsAndOrigins.IsTakenOrigin(own.Origin, (own.Host, [])), own.Origin);
        });
        Assert.All(NotOwn, (other) =>
        {
            Assert.False(HostsAndOrigins.IsTakenOrigin(other.Origin, (other.Host, [])), other.Origin);
        });
    }

    // spec 15.12
    [Fact]
    public void OwnAuthorityOf_gives_the_authority_of_a_host_taken_by_name_every_server_s_or_one_listed_and_none_of_one_only_a_star_takes()
    {
        string?[] authorities = ["localhost:8080", "127.0.0.1:8080", "[::1]:8080", "Bead.Test:8443", "rebind.example:8080", "", null];

        // by name, every server's or one listed, whether * is there or not
        Assert.Equal(
            ["localhost:8080", "127.0.0.1:8080", "[::1]:8080", "Bead.Test:8443", null, null, null],
            authorities.Select((authority) =>
            {
                return HostsAndOrigins.OwnAuthorityOf(authority, ["bead.test"]);
            }));

        // * takes every host, and vouches for none of them: the rebound page names its own Host
        Assert.Equal(
            ["localhost:8080", "127.0.0.1:8080", "[::1]:8080", null, null, null, null],
            authorities.Select((authority) =>
            {
                return HostsAndOrigins.OwnAuthorityOf(authority, ["*"]);
            }));
        Assert.Null(HostsAndOrigins.OwnAuthorityOf("bead.test", null));

        // and so the rebound page is none of the server's own under *, though * took its host
        Assert.True(HostsAndOrigins.IsTakenHost("rebind.example:8080", ["*"]));
        Assert.False(HostsAndOrigins.IsTakenOrigin("http://rebind.example:8080", (HostsAndOrigins.OwnAuthorityOf("rebind.example:8080", ["*"]), [])));
    }

    // spec 15.12
    [Fact]
    public void IsListedOrigin_takes_an_Origin_that_origins_names_exactly_the_server_s_own_only_when_named_and_never_none()
    {
        Assert.True(HostsAndOrigins.IsListedOrigin("https://bead.example", Origins));
        Assert.False(HostsAndOrigins.IsListedOrigin("null", Origins));
        Assert.False(HostsAndOrigins.IsListedOrigin("https://Bead.Example", Origins));
        Assert.False(HostsAndOrigins.IsListedOrigin("https://bead.example:443", Origins));
        Assert.False(HostsAndOrigins.IsListedOrigin("Null", Origins));
        Assert.False(HostsAndOrigins.IsListedOrigin(null, Origins));
        Assert.False(HostsAndOrigins.IsListedOrigin(null, ["null"]));

        // the server's own, taken by IsTakenOrigin, is listed only when named
        Assert.All(Own, (own) =>
        {
            Assert.False(HostsAndOrigins.IsListedOrigin(own.Origin, []), own.Origin);
            Assert.True(HostsAndOrigins.IsListedOrigin(own.Origin, [own.Origin]), own.Origin);
        });
    }

    [Fact]
    public void Folds_ASCII_alone_a_host_that_differs_past_ASCII_is_another()
    {
        // the Kelvin sign and a dotted capital I, which a fold past ASCII would take for a k and an
        // i; an i without its dot and an É, which it would take for an I and an é
        Assert.False(HostsAndOrigins.IsTakenHost("Key.test", ["key.test"]));
        Assert.False(HostsAndOrigins.IsTakenHost("İtem.test", ["item.test"]));
        Assert.False(HostsAndOrigins.IsTakenHost("bead.ıo", ["bead.io"]));
        Assert.False(HostsAndOrigins.IsTakenHost("bÉad.test", ["béad.test"]));
        Assert.True(HostsAndOrigins.IsTakenHost("BéAD.test", ["béad.test"]));
        Assert.False(HostsAndOrigins.IsTakenOrigin("http://key.test", ("Key.test", [])));
        Assert.False(HostsAndOrigins.IsTakenOrigin("http://item.test", ("İtem.test", [])));
        Assert.False(HostsAndOrigins.IsTakenOrigin("http://bead.io", ("BEAD.ıO", [])));
    }
}
