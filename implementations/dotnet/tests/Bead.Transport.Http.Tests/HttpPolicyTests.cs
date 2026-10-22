namespace Bead.Transport.Http.Tests;

/// <summary>
/// <see cref="HttpPolicy"/>: one object of an HTTP server's hosts, origins, proxies and bounds,
/// checked once and given alike to the HTTP transport and a gateway (decision 0037). The twins of
/// the TypeScript side's <c>http-policy.test.ts</c>.
/// </summary>
public sealed class HttpPolicyTests
{
    [Fact]
    public void Builds_a_policy_of_its_members_checked_once_and_frozen_and_refuses_one_that_does_not_hold()
    {
        var hosts = new List<string> { "api.example" };
        var policy = HttpPolicy.Of(new HttpPolicyOptions
        {
            BodyGracePeriod = TimeSpan.FromSeconds(1),
            Hosts = hosts,
            MaximumConnectionsPerAddress = 8,
            MinimumSendBytesPerSecond = 0,
            Origins = ["https://app.example"],
            TrustedProxies = ["10.0.0.1"],
            UnnamedProxies = 1,
        });

        // * its lists copied as it is built: what changes the list it was given changes nothing of it
        hosts.Add("evil.example");
        Assert.Equal(["api.example"], policy.Hosts);
        Assert.Null(policy.MaximumBodyBytes);

        foreach (var given in new[]
        {
            new HttpPolicyOptions { Hosts = ["https://api.example"] },
            new HttpPolicyOptions { Origins = ["app.example"] },
            new HttpPolicyOptions { TrustedProxies = ["not an address"] },
            new HttpPolicyOptions { UnnamedProxies = 9 },
            new HttpPolicyOptions { MaximumBodyBytes = 0 },
            new HttpPolicyOptions { MinimumBodyBytesPerSecond = -1 },
            new HttpPolicyOptions { HeadersTimeout = Timeout.InfiniteTimeSpan },
        })
        {
            Assert.ThrowsAny<ArgumentException>(() =>
            {
                HttpPolicy.Of(given);
            });
        }
    }

    [Fact]
    public async Task Gives_a_listener_its_members_from_its_policy_and_refuses_one_given_in_it_and_beside_it()
    {
        var policy = HttpPolicy.Of(new HttpPolicyOptions { Hosts = ["api.example"], MaximumBodyBytes = 1_024 });
        var applied = new HttpTransportServerOptions { Pathname = "/bead", Policy = policy }.PolicyApplied();

        Assert.Equal(["api.example"], applied.Hosts);
        Assert.Equal((1_024, "/bead"), (applied.MaximumBodyBytes, applied.Pathname));

        // a member the policy gives none of is the listener's own
        Assert.Equal(["https://app.example"], new HttpTransportServerOptions { Origins = ["https://app.example"], Policy = policy }.PolicyApplied().Origins);
        Assert.Equal(
            "Hosts is given in the policy and beside it: give it once (Parameter 'Hosts')",
            Assert.Throws<ArgumentException>(() =>
            {
                new HttpTransportServerOptions { Hosts = ["other.example"], Policy = policy }.PolicyApplied();
            }).Message);

        // a member given beside its policy is given, at its default as at any other value
        var proxied = HttpPolicy.Of(new HttpPolicyOptions { UnnamedProxies = 1 });

        Assert.Equal(1, new HttpTransportServerOptions { Policy = proxied }.PolicyApplied().UnnamedProxies);
        Assert.Equal(
            "UnnamedProxies is given in the policy and beside it: give it once (Parameter 'UnnamedProxies')",
            Assert.Throws<ArgumentException>(() =>
            {
                new HttpTransportServerOptions { UnnamedProxies = 0, Policy = proxied }.PolicyApplied();
            }).Message);

        // a list written as none is none given
        var hosted = HttpPolicy.Of(new HttpPolicyOptions { Hosts = ["api.example"] });

        Assert.Equal(["api.example"], new HttpTransportServerOptions { Hosts = null, Policy = hosted }.PolicyApplied().Hosts);

        // * the HTTP transport takes one, as a gateway does
        await using var transport = new HttpTransportServer(new HttpTransportServerOptions { Policy = policy });

        Assert.Equal(TransportTypes.Http, transport.Type);
        Assert.Throws<ArgumentException>(() =>
        {
            _ = new HttpTransportServer(new HttpTransportServerOptions { MaximumBodyBytes = 2_048, Policy = policy });
        });
    }
}
