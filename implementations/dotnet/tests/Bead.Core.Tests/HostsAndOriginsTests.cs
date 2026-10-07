namespace Bead.Tests;

/// <summary>
/// <see cref="HostsAndOrigins"/>: the hosts and origins a server takes a request from, over HTTP
/// as on a WebSocket's upgrade (spec 15.2, 15.12), by the rows the TypeScript side judges alike.
/// </summary>
public sealed class HostsAndOriginsTests
{
    // constants

    private static readonly string[] Hosts = ["bead.test", "127.0.0.1:8080", "xn--bad-bma.test"];

    private static readonly string[] TakenHosts = ["bead.test", "Bead.Test", "BEAD.TEST", "127.0.0.1:8080", "XN--BAD-BMA.test"];

    private static readonly string?[] OtherHosts = [null, "", "elsewhere.test", "bead.test:8080", "127.0.0.1", "béad.test", "xn--a.test"];

    private static readonly string[] Origins = ["https://bead.example", "null"];

    // a Host's value HTTP takes (RFC 9110 §7.2): a reg-name, an IPv4 address or an IP-literal, and
    // an optional port, whitespace around it; empty, and a name of invalid punycode, among them
    private static readonly string[] WellFormedHosts =
    [
        "bead.test",
        "bead.test:8080",
        "BEAD.test:8080",
        "bead.test:",
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
        "[v1.fe80::a+en1]",
        "xn--a",
        "xn---bad-cpa.test",
        "bead%2Etest",
        "b%C3%A9ad.test",
        "bead_test~",
        "!$&'()*+,;=",
        "a-._~!$&'()*+,;=b",
        " bead.test\t",
    ];

    // and one it does not: a space, a userinfo, a path, a port not of digits or twice, an
    // IP-literal unclosed, followed by what is no port, or of what is no IPv6 address, a zone among
    // them, a percent that encodes nothing, a character past ASCII
    private static readonly string[] OtherHostValues =
    [
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
    public void Takes_a_Host_HTTP_takes_one_field_line_of_a_host_and_an_optional_port_none_where_the_request_asks_none()
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
    public void Takes_every_host_when_given_none_and_among_those_given_in_any_ASCII_case()
    {
        Assert.All(new[] { "elsewhere.test", "xn--a", null }, (host) =>
        {
            Assert.True(HostsAndOrigins.IsTakenHost(host, null), host);
        });
        Assert.All(TakenHosts, (host) =>
        {
            Assert.True(HostsAndOrigins.IsTakenHost(host, Hosts), host);
        });
        Assert.All(OtherHosts, (host) =>
        {
            Assert.False(HostsAndOrigins.IsTakenHost(host, Hosts), host);
        });
        Assert.Equal(("host-refused", "origin-refused"), (HostsAndOrigins.HostRefusal, HostsAndOrigins.OriginRefusal));
    }

    [Fact]
    public void Takes_a_request_with_no_Origin_one_among_those_given_and_the_server_s_own_http_or_https_followed_by_its_Host_in_any_ASCII_case_nothing_parsed()
    {
        // no page, or one among those given, exactly
        Assert.True(HostsAndOrigins.IsTakenOrigin(null, ("bead.test", Origins)));
        Assert.True(HostsAndOrigins.IsTakenOrigin("https://bead.example", ("bead.test", Origins)));
        Assert.True(HostsAndOrigins.IsTakenOrigin("null", ("bead.test", Origins)));
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
