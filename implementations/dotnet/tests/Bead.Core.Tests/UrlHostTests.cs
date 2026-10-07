namespace Bead.Tests;

/// <summary>
/// <see cref="UrlHost"/>: a host as the WHATWG URL Standard's host parser reads it, by the rows the
/// TypeScript side's twin reads alike through its platform's parser, <c>URL</c>, by which it reads a
/// host.
/// </summary>
public sealed class UrlHostTests
{
    // constants

    // a host, and what the parser reads it as: none where it fails; an xn-- label that does not decode
    // is left out, its answer moving with the IDNA version a parser follows
    private static readonly (string Host, string? Parsed)[] Hosts =
    [
        ("127.0.0.1.", "127.0.0.1"),
        ("127.1", "127.0.0.1"),
        ("0x7f.1", "127.0.0.1"),
        ("0X7F.0.0.1", "127.0.0.1"),
        ("2130706433", "127.0.0.1"),
        ("0177.0.0.1", "127.0.0.1"),
        ("127.0.0.0x1", "127.0.0.1"),
        ("127.65535", "127.0.255.255"),
        ("127.0.0.1..", "127.0.0.1.."),
        ("127.0.0.256", null),
        ("127.0.0.1.1", null),
        ("1.2.3.4.5", null),
        ("127.0.0.09", null),
        ("4294967296", null),
        ("0x", "0.0.0.0"),
        ("0x.0x.0x.1", "0.0.0.1"),
        ("127.0.0.1 ", null),
        ("LOCALHOST", "localhost"),
        ("localhost.", "localhost."),
        ("A.LocalHost", "a.localhost"),
        ("loc%61lhost", "localhost"),
        ("%6c%6f%63%61%6c%68%6f%73%74", "localhost"),
        ("%zz", null),
        ("a%", null),
        ("a%2520", null),
        ("\uFF11\uFF12\uFF17\uFF0E\uFF10\uFF0E\uFF10\uFF0E\uFF11", "127.0.0.1"),
        ("\uFF4C\uFF4F\uFF43\uFF41\uFF4C\uFF48\uFF4F\uFF53\uFF54", "localhost"),
        ("b\u00FCcher.example", "xn--bcher-kva.example"),
        ("a..b", "a..b"),
        ("[::1]", "[::1]"),
        ("[0:0:0:0:0:0:0:1]", "[::1]"),
        ("[0:0::1]", "[::1]"),
        ("[::0.0.0.1]", "[::1]"),
        ("[::1%1]", null),
        ("[::1:]", null),
        ("[::01.0.0.1]", null),
        ("[::ffff:127.0.0.1]", "[::ffff:7f00:1]"),
        ("[1:0:0:2:0:0:0:3]", "[1:0:0:2::3]"),
        ("[1::]", "[1::]"),
        ("[::]", "[::]"),
        ("[1:2:3:4:5:6:7:8]", "[1:2:3:4:5:6:7:8]"),
        ("[1:2:3:4:5:6:7:8:9]", null),
        ("[::1", null),
        ("[FE80::A]", "[fe80::a]"),
        ("bead.test^", null),
        ("a|b", null),
        ("a<b", null),
        ("a b", null),
    ];

    // definition

    [Fact]
    public void Reads_a_host_as_the_URL_Standard_s_host_parser_does_and_serializes_it_alike()
    {
        Assert.Equal(Hosts, Hosts.Select((row) =>
        {
            return (row.Host, UrlHost.Parse(row.Host));
        }));
    }
}
