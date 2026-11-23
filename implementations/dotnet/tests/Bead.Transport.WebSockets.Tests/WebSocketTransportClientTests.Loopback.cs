using Bead.Tests;

namespace Bead.Transport.WebSockets.Tests;

public sealed partial class WebSocketTransportClientTests
{
    /// <summary>
    /// Its connect of a host on the loopback, to the loopback itself, through no proxy, a localhost
    /// name asking no resolver (spec 13.4): the platform's resolver and proxy stood in for, each
    /// process-wide, so these run alone.
    /// </summary>
    [Collection(PlatformSeams.Name)]
    public sealed class OnTheLoopback
    {
        // spec 13.4
        [Fact]
        public async Task Reaches_a_localhost_name_on_the_loopback_whatever_the_platforms_resolver_answers()
        {
            using var resolver = new StandInResolver();
            await using var server = new WebSocketTransportServer();
            var port = (await server.Start(new TransportServerStartOptions { Address = "127.0.0.1", FindOpenPort = true, CancellationToken = Cancelled })).Port;
            await using var client = new WebSocketTransportClient();

            await client.Connect(new WebSocketTransportClientConnectOptions { Host = "bead-probe.localhost", Port = port, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);

            Assert.Equal(ReadyState.Open, client.ReadyState);
            Assert.Empty(resolver.Asked);
        }

        // spec 13.4
        [Fact]
        public async Task Sends_nothing_through_the_platforms_proxy_to_a_host_on_the_loopback()
        {
            await using var proxy = new StandInProxy();

            foreach (var host in new[] { "bead-probe.localhost", "127.0.0.1" })
            {
                await using var listener = new HeadListener();
                await using var client = new WebSocketTransportClient();

                // * its upgrade, its credential in it, reaches the listener, which answers nothing
                await Assert.ThrowsAnyAsync<Exception>(() =>
                {
                    return client.Connect(new WebSocketTransportClientConnectOptions { Host = host, Port = listener.Port, Credential = Bearer, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
                });

                // the platform sends an upgrade again on a connection closed unanswered
                Assert.All(await listener.Next(), (head) =>
                {
                    Assert.Contains($"Host: {host}:{listener.Port}\r\n", head, StringComparison.Ordinal);
                    Assert.Contains($"Authorization: {Bearer}\r\n", head, StringComparison.Ordinal);
                });
            }

            Assert.Empty(proxy.Asked);
            Assert.Empty(proxy.Listener.Heads);
        }

        // spec 13.4
        [Fact]
        public async Task Says_that_a_localhost_name_it_could_not_connect_went_to_the_loopback_no_resolver_asked()
        {
            using var resolver = new StandInResolver();
            using var closed = new ClosedPort();
            await using var client = new WebSocketTransportClient();
            var refused = await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                return client.Connect(new WebSocketTransportClientConnectOptions { Host = "bead-probe.localhost", Port = closed.Port, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
            });

            // * the platform's failure kept as its cause, the sentence in its message
            Assert.Contains(LoopbackFailures.Sentence, refused.Message, StringComparison.Ordinal);
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.Empty(resolver.Asked);
        }
    }
}
