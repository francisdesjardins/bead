using System.Text.Json;
using Bead.Tests;
using Bead.Transcoding.V1;

namespace Bead.Transcoding.Tests;

public sealed partial class HttpCallerTests
{
    /// <summary>
    /// Its connect of a host on the loopback, to the loopback itself, through no proxy, a localhost
    /// name asking no resolver (spec 13.4): the platform's resolver and proxy stood in for, each
    /// process-wide, so these run alone.
    /// </summary>
    [Collection(PlatformSeams.Name)]
    public sealed class OnTheLoopback
    {
        // a gateway's answer of JSON null, its connection closed after it
        private const string Answer = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull";

        private const string Bearer = "Bearer mF_9.B5f-4.1JqM";

        // spec 13.4.2
        [Fact]
        public async Task Reaches_a_localhost_name_on_the_loopback_whatever_the_platforms_resolver_answers()
        {
            using var resolver = new StandInResolver();
            await using var listener = new HeadListener(Answer);
            using var client = new TranscodingHttpClient(new Uri($"http://bead-probe.localhost:{listener.Port}"));

            Assert.Equal(JsonValueKind.Null, (await client.Json(Json("null"))).ValueKind);

            var head = Assert.Single(listener.Heads);

            Assert.Contains($"Host: bead-probe.localhost:{listener.Port}\r\n", head, StringComparison.Ordinal);
            Assert.Empty(resolver.Asked);
        }

        // spec 13.4.2
        [Fact]
        public async Task Sends_nothing_through_the_platforms_proxy_to_a_host_on_the_loopback()
        {
            await using var proxy = new StandInProxy();

            foreach (var host in new[] { "bead-probe.localhost", "127.0.0.1" })
            {
                await using var listener = new HeadListener(Answer);
                using var client = new TranscodingHttpClient(new Uri($"http://{host}:{listener.Port}"), new HttpCallerOptions { Authorization = Bearer });

                Assert.Equal(JsonValueKind.Null, (await client.Json(Json("null"))).ValueKind);

                // * its credential reached the listener on the loopback
                var head = Assert.Single(listener.Heads);

                Assert.Contains($"Host: {host}:{listener.Port}\r\n", head, StringComparison.Ordinal);
                Assert.Contains($"Authorization: {Bearer}\r\n", head, StringComparison.Ordinal);
            }

            Assert.Empty(proxy.Asked);
            Assert.Empty(proxy.Listener.Heads);
        }

        // spec 13.4.2
        [Fact]
        public async Task Says_that_a_localhost_name_it_could_not_connect_went_to_the_loopback_no_resolver_asked()
        {
            using var resolver = new StandInResolver();
            using var closed = new ClosedPort();
            using var client = new TranscodingHttpClient(new Uri($"http://bead-probe.localhost:{closed.Port}"));
            var refused = await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                return client.Json(Json("null"));
            });

            // * the platform's failure kept as its cause, the sentence in its message
            Assert.Contains(LoopbackFailures.Sentence, refused.Message, StringComparison.Ordinal);
            Assert.Empty(resolver.Asked);
        }

        // spec 13.4.2
        [Fact]
        public async Task Connects_a_host_written_127_0_0_1_or_127_1_to_the_loopback_asking_no_resolver_and_names_it_127_0_0_1()
        {
            using var resolver = new StandInResolver();

            foreach (var host in new[] { "127.0.0.1.", "127.1" })
            {
                await using var listener = new HeadListener(Answer);
                using var client = new TranscodingHttpClient(new Uri($"http://{host}:{listener.Port}"), new HttpCallerOptions { Authorization = Bearer });

                Assert.Equal(JsonValueKind.Null, (await client.Json(Json("null"))).ValueKind);

                // * named 127.0.0.1, and judged on the loopback: its credential went
                var head = Assert.Single(listener.Heads);

                Assert.Contains($"Host: 127.0.0.1:{listener.Port}\r\n", head, StringComparison.Ordinal);
                Assert.Contains($"Authorization: {Bearer}\r\n", head, StringComparison.Ordinal);
            }

            Assert.Empty(resolver.Asked);
        }

        // spec 13.4; RFC 3696 §2; docs/support.md, a percent-escaped host in a URL the C# side is given
        [Fact]
        public void Refuses_a_host_the_URL_Standard_fails_on_foo_123_or_x_20_localhost_before_any_socket_opens()
        {
            using var resolver = new StandInResolver();
            var refused = Assert.Throws<ArgumentException>(() =>
            {
                return new TranscodingHttpClient(new Uri("http://foo.123:9"));
            });

            // * in the words of any URL a caller refuses, as the other sides' callers word it
            Assert.Equal("url", refused.ParamName);
            Assert.StartsWith("an HTTP client URL uses HTTP or HTTPS without user information, query or fragment", refused.Message, StringComparison.Ordinal);

            // ! .NET's Uri, which a caller is given, refuses a percent-escaped host as it parses it
            Assert.Throws<UriFormatException>(() =>
            {
                return new Uri("http://x%20.localhost:9");
            });
            Assert.Empty(resolver.Asked);
        }
    }
}
