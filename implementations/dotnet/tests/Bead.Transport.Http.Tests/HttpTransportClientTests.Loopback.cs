using System.Threading.Channels;
using Bead.Tests;

namespace Bead.Transport.Http.Tests;

public sealed partial class HttpTransportClientTests
{
    /// <summary>
    /// Its connect of a host on the loopback, to the loopback itself, through no proxy, a localhost
    /// name asking no resolver (spec 13.4), and of a host off the machine through the platform's
    /// proxy: the platform's resolver and proxy stood in for, each process-wide, so these run alone.
    /// </summary>
    [Collection(PlatformSeams.Name)]
    public sealed class OnTheLoopback
    {
        // spec 13.4
        [Fact]
        public async Task Reaches_a_localhost_name_on_the_loopback_whatever_the_platforms_resolver_answers()
        {
            using var resolver = new StandInResolver();
            await using var started = await Started.Start();
            await using var client = new HttpTransportClient(NotListening);

            await client.Connect(new HttpTransportClientConnectOptions { Host = "bead-probe.localhost", Port = started.Port, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);

            Assert.Equal(ReadyState.Open, client.ReadyState);
            await Next(started.Connections);
            Assert.Empty(resolver.Asked);
        }

        // spec 13.4
        [Fact]
        public async Task Sends_nothing_through_the_platforms_proxy_to_a_host_on_the_loopback()
        {
            await using var proxy = new StandInProxy();
            await using var started = await Started.Start();
            var taken = Channel.CreateUnbounded<string?>();

            started.Server.Message += (message, _) =>
            {
                taken.Writer.TryWrite(message.Credential);
            };

            foreach (var host in new[] { "bead-probe.localhost", "127.0.0.1" })
            {
                await using var client = new HttpTransportClient(NotListening);

                await client.Connect(new HttpTransportClientConnectOptions { Host = host, Port = started.Port, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
                await client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false) { Credential = Bearer }).WaitAsync(Patience, Cancelled);

                // * its credential reached the server on the loopback
                Assert.Equal((host, Bearer), (host, await Next(taken)));
                await client.CloseConnection().WaitAsync(Patience, Cancelled);
            }

            Assert.Empty(proxy.Asked);
            Assert.Empty(proxy.Listener.Heads);
        }

        // spec 13.4
        [Fact]
        public async Task Sends_a_host_off_the_machine_through_the_platforms_proxy()
        {
            using var resolver = new StandInResolver();
            await using var proxy = new StandInProxy();
            await using var client = new HttpTransportClient(NotListening);

            // * the proxy reads the request and answers nothing, so the connect fails
            await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                return client.Connect(new HttpTransportClientConnectOptions { Host = "bead-probe.test", Port = 9, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
            });

            Assert.Contains(new Uri("http://bead-probe.test:9/bead"), proxy.Asked);
            Assert.All(await proxy.Listener.Next(), (head) =>
            {
                Assert.StartsWith("POST http://bead-probe.test:9/bead HTTP/1.1\r\n", head, StringComparison.Ordinal);
            });
            Assert.Empty(resolver.Asked);
        }

        // spec 13.4
        [Fact]
        public async Task Says_that_a_localhost_name_it_could_not_connect_went_to_the_loopback_no_resolver_asked()
        {
            using var resolver = new StandInResolver();
            await using var client = new HttpTransportClient(NotListening);
            var refused = await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                return client.Connect(new HttpTransportClientConnectOptions { Host = "bead-probe.localhost", Port = LoopbackFailures.Unheard(), CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
            });

            // * the platform's failure kept as its cause, the sentence in its message
            Assert.Contains(LoopbackFailures.Sentence, refused.Message, StringComparison.Ordinal);
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.Empty(resolver.Asked);
        }

        // spec 13.4, 15.39
        [Fact]
        public async Task Keeps_a_localhost_name_in_its_Host_and_its_TLS_server_name_while_it_connects_the_loopback()
        {
            using var resolver = new StandInResolver();
            await using var listener = new HeadListener();

            // * a certificate that names localhost alone: its handshake passes only under that server name
            await using var front = TlsFront.Start(listener.Port, new TlsFrontOptions { IsRequiring = false, Serving = "named-server" });
            await using var client = new HttpTransportClient(NotListening with { Tls = new TlsOptions { Authorities = Pki.Read("root.pem") } });

            await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                return client.Connect(new HttpTransportClientConnectOptions { Host = "localhost", Port = front.Port, Secured = true, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
            });

            Assert.All(await listener.Next(), (head) =>
            {
                Assert.Contains($"Host: localhost:{front.Port}\r\n", head, StringComparison.Ordinal);
            });
            Assert.Empty(resolver.Asked);
        }
    }
}
