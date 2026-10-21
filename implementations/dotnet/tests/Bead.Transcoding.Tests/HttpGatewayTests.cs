using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Bead.Transcoding.Http;
using Bead.Transcoding.V1;
using static Bead.Transcoding.Tests.TranscodingFile;

namespace Bead.Transcoding.Tests;

/// <summary>
/// <see cref="HttpGateway"/>: a gateway of the Transcoding service in process, its server joined,
/// called over a real socket: one Bead connection per exchange, the credential it presents, the
/// gates of Fetch Metadata and CORS, a stream's reconnection, an abort, a command, the document, and
/// the bounds of calls and streams apart (transcoding 2 to 11). The twins of the TypeScript side's
/// <c>http-gateway.test.ts</c>.
/// </summary>
public sealed class HttpGatewayTests
{
    private const string Origin = "https://app.example";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // a gateway of the service on a free port, built of the file's defaults and the changes given,
    // and a client of it
    private static async Task<(TranscodingService Service, HttpGateway Gateway, HttpClient Client)> Started(Func<HttpGatewayOptions, HttpGatewayOptions>? change = null)
    {
        var service = await TranscodingService.Start();
        var options = Exchanges.OptionsOf(service.Memory, null);
        var gateway = new HttpGateway(change is null ? options : change(options));
        var address = await gateway.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true }, Cancelled);
        var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{address.Port}") };

        return (service, gateway, client);
    }

    private static async Task Stopped((TranscodingService Service, HttpGateway Gateway, HttpClient Client) started)
    {
        started.Client.Dispose();
        await started.Gateway.DisposeAsync();
        await started.Service.DisposeAsync();
    }

    private static HttpRequestMessage Json(string path, string body)
    {
        return new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(body, Encoding.UTF8, new MediaTypeHeaderValue("application/json")) };
    }

    private static async Task Until(Func<bool> condition)
    {
        var since = TimeProvider.System.GetTimestamp();

        while (!condition())
        {
            if (TimeProvider.System.GetElapsedTime(since) > Patience)
            {
                throw new TimeoutException("what the test waits on never came");
            }

            await Task.Delay(TimeSpan.FromMilliseconds(5), TimeProvider.System, Cancelled);
        }
    }

    [Fact]
    public async Task Draws_one_Bead_connection_per_exchange_and_closes_it_as_its_response_ends()
    {
        var started = await Started();
        var drawn = new List<string>();
        var closed = new List<string>();

        started.Service.Memory.Connection += (handle) =>
        {
            lock (drawn)
            {
                drawn.Add(handle);
            }
        };
        started.Service.Memory.Close += (_, handle) =>
        {
            lock (closed)
            {
                closed.Add(handle);
            }
        };

        try
        {
            for (var call = 0; call < 3; call += 1)
            {
                using var answered = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{\"anInt32\":1}"), Cancelled);

                Assert.Equal(HttpStatusCode.OK, answered.StatusCode);
                Assert.Equal("{\"anInt32\":1}", await answered.Content.ReadAsStringAsync(Cancelled));
            }

            await Until(() =>
            {
                lock (closed)
                {
                    return closed.Count == 3;
                }
            });

            // * three exchanges, three connections, each of its caller's address, each closed
            Assert.Equal(3, drawn.Distinct().Count());
            Assert.All(drawn, (handle) =>
            {
                Assert.StartsWith("type=MEMORY;ip=127.0.0.1;", handle, StringComparison.Ordinal);
            });
            Assert.Equal(drawn.Order(StringComparer.Ordinal), closed.Order(StringComparer.Ordinal));
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Presents_the_Authorization_field_ELSEWHERE_or_as_a_JWT_under_bearer_jwt()
    {
        var elsewhere = await Started();
        var jwt = await Started((options) =>
        {
            return options with { Authorization = GatewayAuthorization.BearerJwt };
        });

        try
        {
            var asked = Json("/api/Transcoding/whoAmI", "{}");

            asked.Headers.TryAddWithoutValidation("authorization", "Bearer good");

            using var who = await elsewhere.Client.SendAsync(asked, Cancelled);

            Assert.Equal("{\"session\":\"ada\"}", await who.Content.ReadAsStringAsync(Cancelled));

            // under bearer-jwt, a token presented as a JWT, which a server with no JWT verifier refuses
            var token = Json("/api/Transcoding/whoAmI", "{}");

            token.Headers.TryAddWithoutValidation("authorization", "bearer a.b.c");

            using var unsupported = await jwt.Client.SendAsync(token, Cancelled);

            Assert.Equal(HttpStatusCode.InternalServerError, unsupported.StatusCode);
            Assert.Contains("\"code\":36", await unsupported.Content.ReadAsStringAsync(Cancelled), StringComparison.Ordinal);

            var basic = Json("/api/Transcoding/whoAmI", "{}");

            basic.Headers.TryAddWithoutValidation("authorization", "Basic YTpi");

            using var scheme = await jwt.Client.SendAsync(basic, Cancelled);

            Assert.Equal(HttpStatusCode.Unauthorized, scheme.StatusCode);
            Assert.Equal("Bearer error=\"invalid_request\"", scheme.Headers.WwwAuthenticate.ToString());
        }
        finally
        {
            await Stopped(elsewhere);
            await Stopped(jwt);
        }
    }

    [Fact]
    public async Task Refuses_a_request_with_no_Origin_from_a_page_of_another_site_and_a_navigation_to_an_unmarked_get_rule()
    {
        var started = await Started();

        static HttpRequestMessage Fetched(string path, (string Site, string Mode) metadata)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, path);

            request.Headers.TryAddWithoutValidation("sec-fetch-site", metadata.Site);
            request.Headers.TryAddWithoutValidation("sec-fetch-mode", metadata.Mode);

            return request;
        }

        try
        {
            // * an <img> of another site: no Origin, refused
            using var subresource = await started.Client.SendAsync(Fetched("/v1/books/2", ("cross-site", "no-cors")), Cancelled);

            Assert.Equal(HttpStatusCode.Forbidden, subresource.StatusCode);
            Assert.Equal("origin-refused", subresource.Headers.GetValues("bead-refusal").Single());

            // a navigation to a get rule of a method not marked NO_SIDE_EFFECTS: refused
            using var unmarked = await started.Client.SendAsync(Fetched("/v1/shelves/s/books", ("same-site", "navigate")), Cancelled);

            Assert.Equal(HttpStatusCode.Forbidden, unmarked.StatusCode);

            // a navigation to a get rule of a marked one, and a request of its own origin: taken
            using var marked = await started.Client.SendAsync(Fetched("/v1/books/2", ("cross-site", "navigate")), Cancelled);
            using var own = await started.Client.SendAsync(Fetched("/v1/shelves/s/books", ("same-origin", "no-cors")), Cancelled);

            Assert.Equal((HttpStatusCode.OK, HttpStatusCode.OK), (marked.StatusCode, own.StatusCode));
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_a_stream_s_request_that_carries_Last_Event_ID_with_204_and_no_call()
    {
        var started = await Started();
        var drawn = 0;

        started.Service.Memory.Connection += (_) =>
        {
            Interlocked.Increment(ref drawn);
        };

        try
        {
            var reconnection = Json("/api/Transcoding/ticks", "{\"from\":2}");

            reconnection.Headers.Accept.ParseAdd("text/event-stream");
            reconnection.Headers.TryAddWithoutValidation("last-event-id", "3");

            using var answered = await started.Client.SendAsync(reconnection, Cancelled);

            Assert.Equal(HttpStatusCode.NoContent, answered.StatusCode);
            Assert.Equal(0, Volatile.Read(ref drawn));

            // the same request, no stream asked: a call, which subscribes nothing
            var call = Json("/api/Transcoding/ticks", "{\"from\":2}");

            call.Headers.TryAddWithoutValidation("last-event-id", "3");

            using var result = await started.Client.SendAsync(call, Cancelled);

            Assert.Equal("{\"ticks\":2}", await result.Content.ReadAsStringAsync(Cancelled));
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_a_preflight_with_the_methods_its_URL_s_routes_take()
    {
        var started = await Started();

        static HttpRequestMessage Preflight(string path)
        {
            var request = new HttpRequestMessage(HttpMethod.Options, path);

            request.Headers.TryAddWithoutValidation("origin", Origin);
            request.Headers.TryAddWithoutValidation("access-control-request-method", "PATCH");
            request.Headers.TryAddWithoutValidation("access-control-request-headers", "content-type");

            return request;
        }

        try
        {
            using var book = await started.Client.SendAsync(Preflight("/v1/shelves/1/books/2"), Cancelled);
            using var echo = await started.Client.SendAsync(Preflight("/api/Transcoding/echo"), Cancelled);

            Assert.Equal(HttpStatusCode.NoContent, book.StatusCode);
            Assert.Equal("GET, HEAD, PATCH", book.Headers.GetValues("access-control-allow-methods").Single());
            Assert.Equal("authorization, content-type, *", book.Headers.GetValues("access-control-allow-headers").Single());
            Assert.Equal(Origin, book.Headers.GetValues("access-control-allow-origin").Single());
            Assert.Equal("POST", echo.Headers.GetValues("access-control-allow-methods").Single());
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Cancels_the_call_of_a_request_aborted()
    {
        var started = await Started();

        try
        {
            using var aborting = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
            var hanging = started.Client.SendAsync(Json("/api/Transcoding/hang", "{}"), aborting.Token);

            await Until(() =>
            {
                return started.Service.Hanging == 1;
            });
            await aborting.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return hanging;
            });

            // * its connection closed, its server ended its call as cancelled, its resolver told
            using var cancels = await started.Client.GetAsync(new Uri("/api/Transcoding/cancels?atLeast=1", UriKind.Relative), Cancelled);

            Assert.Equal("{\"count\":1}", await cancels.Content.ReadAsStringAsync(Cancelled));
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_a_command_to_an_exchange_s_connection_PROCEDURE_UNKNOWN()
    {
        var started = await Started();

        try
        {
            using var asked = await started.Client.SendAsync(Json("/api/Transcoding/ask", "{}"), Cancelled);

            Assert.Equal("{\"code\":19}", await asked.Content.ReadAsStringAsync(Cancelled));
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Serves_the_document_beadc_wrote_byte_for_byte()
    {
        var started = await Started();

        try
        {
            using var served = await started.Client.GetAsync(new Uri("/openapi.json", UriKind.Relative), Cancelled);
            var bytes = await served.Content.ReadAsByteArrayAsync(Cancelled);

            // * the file beadc wrote, which its route table embeds as it is
            Assert.Equal(Document, bytes);
            Assert.Equal(HttpRoutes.OpenApiDocument.ToArray(), bytes);
            Assert.Equal("no-cache", served.Headers.CacheControl?.ToString());

            var again = new HttpRequestMessage(HttpMethod.Get, "/openapi.json");

            again.Headers.TryAddWithoutValidation("if-none-match", served.Headers.ETag!.ToString());

            using var held = await started.Client.SendAsync(again, Cancelled);

            Assert.Equal(HttpStatusCode.NotModified, held.StatusCode);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Holds_each_caller_s_calls_and_streams_to_bounds_of_their_own()
    {
        var started = await Started((options) =>
        {
            return options with { MaximumExchangesPerAddress = 1, MaximumConnectionsPerAddress = 1 };
        });

        HttpRequestMessage Watch()
        {
            var request = Json("/api/Transcoding/watch", "{}");

            request.Headers.Accept.ParseAdd("text/event-stream");

            return request;
        }

        try
        {
            // * a stream holds one of its address's streams, and none of its calls
            using var stream = await started.Client.SendAsync(Watch(), HttpCompletionOption.ResponseHeadersRead, Cancelled);
            using var second = await started.Client.SendAsync(Watch(), HttpCompletionOption.ResponseHeadersRead, Cancelled);
            using var call = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{}"), Cancelled);

            Assert.Equal((HttpStatusCode.OK, HttpStatusCode.ServiceUnavailable, HttpStatusCode.OK), (stream.StatusCode, second.StatusCode, call.StatusCode));
            Assert.Equal("1", second.Headers.RetryAfter?.ToString());

            // a call that hangs holds its address's one call, and a stream still opens beside none
            var hanging = started.Client.SendAsync(Json("/api/Transcoding/hang", "{}"), Cancelled);

            await Until(() =>
            {
                return started.Service.Hanging == 1;
            });

            using var refused = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{}"), Cancelled);

            Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
            _ = hanging;
        }
        finally
        {
            await Stopped(started);
        }
    }
}
