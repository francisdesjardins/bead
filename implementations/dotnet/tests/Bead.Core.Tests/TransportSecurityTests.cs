namespace Bead.Tests;

/// <summary>
/// <see cref="TransportSecurity"/>: whether a transport is secure, judged by what it is given (spec
/// 13.4), by the rows the TypeScript side judges alike.
/// </summary>
public sealed class TransportSecurityTests
{
    // constants

    // the rows both sides judge alike (spec 13.4): under TLS, or on the loopback by the host given
    private static readonly string[] Secure =
    [
        "wss://bead.example",
        "https://bead.example",
        "ws://localhost:8080",
        "ws://LOCALHOST",
        "http://a.localhost",
        "ws://127.0.0.1",
        "ws://127.255.255.254",
        "ws://[::1]:8080",
        "ws://[0:0:0:0:0:0:0:1]",
    ];

    private static readonly string[] InTheClear =
    [
        "ws://bead.example",
        "http://192.0.2.1",
        "ws://128.0.0.1",
        "ws://localhost.example",
        "ws://127.0.0.1.example",
        "ws://[::2]",
        "ws://[::ffff:127.0.0.1]",
    ];

    // the hosts a server may listen on, on the loopback and not
    private static readonly string[] LoopbackHosts = ["127.0.0.1", "localhost", "a.LOCALHOST", "::1", "[::1]", "0:0:0:0:0:0:0:1"];

    private static readonly string[] OtherHosts = ["0.0.0.0", "::", "192.0.2.1", "bead.example", "::ffff:127.0.0.1"];

    // helpers

    // a URL as a client of the TypeScript side is given it, read as this side's clients are: its
    // scheme under TLS or not, and its host
    private static bool IsSecureUrl(string url)
    {
        return Uri.TryCreate(url, UriKind.Absolute, out var uri)
            && TransportSecurity.IsSecure((uri.Scheme is "wss" or "https", uri.Host));
    }

    // definition

    [Fact]
    public void Judges_a_URL_secure_under_TLS_or_on_the_loopback_by_the_host_it_is_given_and_any_other_in_the_clear()
    {
        Assert.Equal(Secure, Secure.Where(IsSecureUrl));
        Assert.DoesNotContain(InTheClear, IsSecureUrl);
        Assert.False(IsSecureUrl("not a URL"));
    }

    [Fact]
    public void Judges_the_host_a_server_listens_on_as_a_URL_s_an_IPv6_one_bare_or_bracketed()
    {
        Assert.All(LoopbackHosts, (host) =>
        {
            Assert.True(TransportSecurity.IsLoopback(host), host);
        });
        Assert.DoesNotContain(OtherHosts, TransportSecurity.IsLoopback);
    }
}
