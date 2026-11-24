using System.Collections.Concurrent;
using System.Net;
using System.Threading.Channels;
using Bead.Tests;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Logging;

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
            using var closed = new ClosedPort();
            await using var client = new HttpTransportClient(NotListening);
            var refused = await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                return client.Connect(new HttpTransportClientConnectOptions { Host = "bead-probe.localhost", Port = closed.Port, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
            });

            // * the platform's failure kept as its cause, the sentence in its message
            Assert.Contains(LoopbackFailures.Sentence, refused.Message, StringComparison.Ordinal);
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.Empty(resolver.Asked);
        }

        // spec 13.4
        [Fact]
        public async Task Connects_a_host_written_127_0_0_1_or_127_1_to_the_loopback_asking_no_resolver_and_names_it_127_0_0_1()
        {
            using var resolver = new StandInResolver();

            foreach (var host in new[] { "127.0.0.1.", "127.1" })
            {
                await using var listener = new HeadListener();
                await using var client = new HttpTransportClient(NotListening);

                // * it reaches the listener on 127.0.0.1, which answers nothing
                await Assert.ThrowsAnyAsync<Exception>(() =>
                {
                    return client.Connect(new HttpTransportClientConnectOptions { Host = host, Port = listener.Port, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
                });

                Assert.All(await listener.Next(), (head) =>
                {
                    Assert.Contains($"Host: 127.0.0.1:{listener.Port}\r\n", head, StringComparison.Ordinal);
                });
            }

            Assert.Empty(resolver.Asked);
        }

        // spec 13.4; RFC 3696 §2
        [Fact]
        public async Task Refuses_a_host_the_URL_Standard_fails_on_foo_123_or_x_20_localhost_before_any_socket_opens()
        {
            using var resolver = new StandInResolver();
            await using var proxy = new StandInProxy();

            foreach (var host in new[] { "foo.123", "x%20.localhost" })
            {
                await using var client = new HttpTransportClient(NotListening);
                var refused = await Assert.ThrowsAsync<ConnectException>(() =>
                {
                    return client.Connect(new HttpTransportClientConnectOptions { Host = host, Port = 9, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
                });

                Assert.Equal($"{host} is no host a URL can name", refused.Message);
                Assert.Equal(ReadyState.Uninitialized, client.ReadyState);
            }

            Assert.Empty(resolver.Asked);
            Assert.Empty(proxy.Asked);
            Assert.Empty(proxy.Listener.Heads);
        }

        // spec 13.4; RFC 7301
        [Fact]
        public async Task Negotiates_the_HTTP_version_with_a_localhost_name_that_it_negotiates_with_127_0_0_1()
        {
            // * a server that offers h2 and http/1.1 by ALPN, its certificate naming both, which tells
            // each request's name, method and version
            var versions = new ConcurrentQueue<(string Named, string Request)>();
            using var certificate = Pki.Serving("server");
            var builder = WebApplication.CreateSlimBuilder();

            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel((kestrel) =>
            {
                kestrel.Listen(IPAddress.Loopback, 0, (listen) =>
                {
                    listen.Protocols = HttpProtocols.Http1AndHttp2;
                    listen.UseHttps(certificate);
                });
            });

            await using var application = builder.Build();

            application.Run(async (context) =>
            {
                var isConnect = !context.Request.Headers.ContainsKey(HttpTransport.ConnectionTokenHeader);

                versions.Enqueue((context.Request.Host.Host, $"{context.Request.Method} {context.Request.Protocol}"));
                await context.Request.Body.CopyToAsync(Stream.Null, Cancelled);
                context.Response.StatusCode = isConnect && context.Request.Method == "POST" ? 201 : 204;

                if (isConnect)
                {
                    context.Response.Headers[HttpTransport.ConnectionTokenHeader] = new string('T', 22);
                }
            });
            await application.StartAsync(Cancelled);

            var port = new Uri(application.Urls.First()).Port;

            foreach (var named in new[] { "127.0.0.1", "localhost" })
            {
                await using var client = new HttpTransportClient(NotListening with { Tls = new TlsOptions { Authorities = Pki.Read("root.pem") } });

                await client.Connect(new HttpTransportClientConnectOptions { Host = named, Port = port, Secured = true, CancellationToken = Cancelled }).WaitAsync(Patience, Cancelled);
                await client.CloseConnection(new TransportClientDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);

                // ! a quick close sends its DELETE without waiting on it: wait until the server took it
                await WaitUntilDeleted(named).WaitAsync(Patience, Cancelled);
            }

            await application.StopAsync(Cancelled);

            async Task WaitUntilDeleted(string named)
            {
                while (!versions.Any((each) =>
                {
                    return each.Named == named && each.Request.StartsWith("DELETE ", StringComparison.Ordinal);
                }))
                {
                    await Task.Delay(10, Cancelled);
                }
            }

            // * the same requests in the same version under either name
            string[] RequestsOf(string named)
            {
                return [.. versions.Where((each) =>
                {
                    return each.Named == named;
                }).Select((each) =>
                {
                    return each.Request;
                }).Order(StringComparer.Ordinal)];
            }

            Assert.NotEmpty(RequestsOf("127.0.0.1"));
            Assert.Equal(RequestsOf("127.0.0.1"), RequestsOf("localhost"));
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
