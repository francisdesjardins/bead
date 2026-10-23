using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Bead.Transcoding.Http;
using Bead.Transcoding.V1;
using Google.Protobuf;
using Google.Protobuf.WellKnownTypes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using static Bead.Transcoding.Tests.TranscodingFile;

namespace Bead.Transcoding.Tests;

/// <summary>
/// <see cref="HttpGateway"/>: a gateway of the Transcoding service in process, its server joined,
/// called over a real socket: one Bead connection per exchange, the credential it presents, the
/// gates of Fetch Metadata and CORS, a stream's reconnection, an abort, a command, the document, the
/// bounds of calls and streams apart, and what it reports, none of its words in a problem
/// (transcoding 2 to 11, spec 9.0). The twins of the TypeScript side's
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
    private static async Task<Fixture> Started(Func<HttpGatewayOptions, HttpGatewayOptions>? change = null)
    {
        var service = await TranscodingService.Start();
        var options = Exchanges.OptionsOf(service.Memory, null);
        var gateway = new HttpGateway(change is null ? options : change(options));
        var address = await gateway.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true }, Cancelled);
        var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{address.Port}") };

        return new Fixture(service, gateway, client, address.Port);
    }

    private static async Task Stopped(Fixture started)
    {
        started.Client.Dispose();
        await started.Gateway.DisposeAsync();
        await started.Service.DisposeAsync();
    }

    private static HttpRequestMessage Json(string path, string body)
    {
        return new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(body, Encoding.UTF8, new MediaTypeHeaderValue("application/json")) };
    }

    // the messages of every error the gateway reports, as it reports them
    private static List<string> ReportedBy(HttpGateway gateway)
    {
        var reported = new List<string>();

        gateway.Error += (reason) =>
        {
            lock (reported)
            {
                reported.Add(reason.Message);
            }
        };

        return reported;
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
            var bodies = await Task.WhenAll(Enumerable.Range(1, 2).Select(async (value) =>
            {
                using var answered = await started.Client.SendAsync(Json("/api/Transcoding/echo", $"{{\"anInt32\":{value}}}"), Cancelled);

                return await answered.Content.ReadAsStringAsync(Cancelled);
            }));

            Assert.Equal(["{\"anInt32\":1}", "{\"anInt32\":2}"], bodies.Order(StringComparer.Ordinal));
            await Until(() =>
            {
                lock (closed)
                {
                    return closed.Count == 2;
                }
            });

            // * two exchanges, two connections, each of its caller's address, each closed
            Assert.Equal(2, drawn.Count);
            Assert.Equal(2, drawn.Distinct().Count());
            Assert.All(drawn, (handle) =>
            {
                Assert.StartsWith("type=MEMORY;ip=127.0.0.1;", handle, StringComparison.Ordinal);
            });
            Assert.Equal(drawn.Order(StringComparer.Ordinal), closed.Order(StringComparer.Ordinal));

            // a refusal of its own, or a body its reading refuses, draws none
            using var unread = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{\"nope\":1}"), Cancelled);
            using var unknown = await started.Client.GetAsync(new Uri("/nope", UriKind.Relative), Cancelled);

            Assert.Equal((HttpStatusCode.BadRequest, HttpStatusCode.NotFound), (unread.StatusCode, unknown.StatusCode));
            Assert.Equal(2, drawn.Count);
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

        static HttpRequestMessage WhoAmI(string? authorization)
        {
            var request = Json("/api/Transcoding/whoAmI", "{}");

            if (authorization is not null)
            {
                request.Headers.TryAddWithoutValidation("authorization", authorization);
            }

            return request;
        }

        try
        {
            using var who = await elsewhere.Client.SendAsync(WhoAmI(" Bearer good "), Cancelled);

            Assert.Equal((HttpStatusCode.OK, "{\"session\":\"ada\"}"), (who.StatusCode, await who.Content.ReadAsStringAsync(Cancelled)));

            using var none = await elsewhere.Client.SendAsync(WhoAmI(null), Cancelled);
            using var bad = await elsewhere.Client.SendAsync(WhoAmI("Bearer bad"), Cancelled);

            Assert.Equal((HttpStatusCode.Unauthorized, "Bearer"), (none.StatusCode, none.Headers.WwwAuthenticate.ToString()));
            Assert.Equal((HttpStatusCode.Unauthorized, "Bearer error=\"invalid_token\""), (bad.StatusCode, bad.Headers.WwwAuthenticate.ToString()));

            // under bearer-jwt, a token presented as a JWT, which a server with no JWT verifier refuses
            var reported = ReportedBy(jwt.Gateway);
            using var unsupported = await jwt.Client.SendAsync(WhoAmI("bearer a.b.c"), Cancelled);

            Assert.Equal(HttpStatusCode.InternalServerError, unsupported.StatusCode);

            using (var problem = JsonDocument.Parse(await unsupported.Content.ReadAsStringAsync(Cancelled)))
            {
                Assert.Equal((36, "CREDENTIAL_UNSUPPORTED"), (problem.RootElement.GetProperty("code").GetInt32(), problem.RootElement.GetProperty("title").GetString()));
            }

            Assert.StartsWith("the server takes none of the scheme this gateway presents: ", Assert.Single(reported), StringComparison.Ordinal);

            using var scheme = await jwt.Client.SendAsync(WhoAmI("Basic YTpi"), Cancelled);

            Assert.Equal(HttpStatusCode.Unauthorized, scheme.StatusCode);
            Assert.Equal("Bearer error=\"invalid_request\"", scheme.Headers.WwwAuthenticate.ToString());

            // a token its request's block holds, 1,004 bytes, and one past it
            using var held = await jwt.Client.SendAsync(WhoAmI($"Bearer {new string('a', 1_004)}"), Cancelled);
            using var past = await jwt.Client.SendAsync(WhoAmI($"Bearer {new string('a', 1_005)}"), Cancelled);

            Assert.Equal((HttpStatusCode.InternalServerError, HttpStatusCode.RequestHeaderFieldsTooLarge), (held.StatusCode, past.StatusCode));
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

        static HttpRequestMessage Fetched(string path, (string? Site, string? Mode, string? Origin) metadata)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, path);

            foreach (var (name, value) in new[] { ("sec-fetch-site", metadata.Site), ("sec-fetch-mode", metadata.Mode), ("origin", metadata.Origin) })
            {
                if (value is not null)
                {
                    request.Headers.TryAddWithoutValidation(name, value);
                }
            }

            return request;
        }

        try
        {
            // a navigation to what reads alone: the document, and a GET on a method marked NO_SIDE_EFFECTS
            using var document = await started.Client.SendAsync(Fetched("/openapi.json", ("cross-site", "navigate", null)), Cancelled);
            using var marked = await started.Client.SendAsync(Fetched("/v1/books/2", ("cross-site", "navigate", null)), Cancelled);

            Assert.Equal((HttpStatusCode.OK, HttpStatusCode.OK), (document.StatusCode, marked.StatusCode));

            // * an <img> of another site: no Origin, refused; a navigation to a get rule of a method
            // not marked NO_SIDE_EFFECTS: refused
            foreach (var (path, site, mode) in new[]
            {
                ("/v1/books/2", "cross-site", "no-cors"),
                ("/v1/shelves/s/books", "cross-site", "navigate"),
                ("/v1/shelves/s/books", "same-site", "navigate"),
                ("/v1/operations", "same-site", "navigate"),
            })
            {
                using var refused = await started.Client.SendAsync(Fetched(path, (site, mode, null)), Cancelled);

                Assert.Equal((HttpStatusCode.Forbidden, "origin-refused"), (refused.StatusCode, refused.Headers.GetValues("bead-refusal").Single()));
            }

            // its own origin's, and one from no browser, taken; an origin shown is judged by its own gate
            using var own = await started.Client.SendAsync(Fetched("/v1/shelves/s/books", ("same-origin", "no-cors", null)), Cancelled);
            using var browserless = await started.Client.SendAsync(Fetched("/v1/shelves/s/books", (null, null, null)), Cancelled);
            using var shown = await started.Client.SendAsync(Fetched("/v1/shelves/s/books", ("cross-site", "no-cors", Origin)), Cancelled);

            Assert.Equal((HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.OK), (own.StatusCode, browserless.StatusCode, shown.StatusCode));
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
            Assert.Empty(await answered.Content.ReadAsByteArrayAsync(Cancelled));
            Assert.Null(answered.Content.Headers.ContentType);
            Assert.Equal(0, Volatile.Read(ref drawn));

            // the same request, no stream asked: a call, which subscribes nothing
            var call = Json("/api/Transcoding/ticks", "{\"from\":2}");

            call.Headers.TryAddWithoutValidation("last-event-id", "3");

            using var result = await started.Client.SendAsync(call, Cancelled);

            Assert.Equal((HttpStatusCode.OK, "{\"ticks\":2}"), (result.StatusCode, await result.Content.ReadAsStringAsync(Cancelled)));
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_a_failed_stream_request_as_a_problem_before_writing_any_event()
    {
        var started = await Started((options) =>
        {
            return options with
            {
                MaximumConnections = 1,
                Routes = [.. options.Routes.Select((route) =>
                {
                    return route.Procedure == TranscodingProcedures.Watch.Procedure
                        ? route with { Procedure = route.Procedure with { ProcedureId = 99 } }
                        : route;
                })],
            };
        });
        var reported = ReportedBy(started.Gateway);
        var drawn = 0;
        var closed = 0;

        started.Service.Memory.Connection += (_) => { Interlocked.Increment(ref drawn); };
        started.Service.Memory.Close += (_, _) => { Interlocked.Increment(ref closed); };

        try
        {
            for (var count = 1; count <= 2; count += 1)
            {
                using var request = Json("/api/Transcoding/watch", "{}");

                request.Headers.TryAddWithoutValidation("accept", "text/event-stream");

                using var answered = await started.Client.SendAsync(request, Cancelled);

                Assert.Equal(HttpStatusCode.NotImplemented, answered.StatusCode);
                Assert.Equal("application/problem+json", answered.Content.Headers.ContentType!.MediaType);
                Assert.Equal("{\"code\":19,\"detail\":\"no procedure 99 in service 1\",\"scope\":\"protocol\",\"status\":501,\"title\":\"PROCEDURE_UNKNOWN\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PROCEDURE_UNKNOWN\"}", await answered.Content.ReadAsStringAsync(Cancelled));
                Assert.False(answered.Headers.Contains("bead-refusal"));
                await Until(() => { return Volatile.Read(ref closed) == count; });
                Assert.Equal(count, Volatile.Read(ref drawn));
                Assert.Equal(count, reported.Count);
            }
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
            Assert.Equal("7200", book.Headers.GetValues("access-control-max-age").Single());
            Assert.Equal("POST", echo.Headers.GetValues("access-control-allow-methods").Single());

            foreach (var (path, methods) in new[]
            {
                ("/v1/shelves/1/books/2:archive", "POST"),
                ("/api/Transcoding/getOperation", "GET, HEAD, POST"),
                ("/openapi.json", "GET, HEAD"),
            })
            {
                using var answered = await started.Client.SendAsync(Preflight(path), Cancelled);

                Assert.Equal(methods, answered.Headers.GetValues("access-control-allow-methods").Single());
            }

            // from an origin it does not name, refused before any preflight
            var other = new HttpRequestMessage(HttpMethod.Options, "/api/Transcoding/echo");

            other.Headers.TryAddWithoutValidation("origin", "https://other.example");
            other.Headers.TryAddWithoutValidation("access-control-request-method", "POST");

            using var refused = await started.Client.SendAsync(other, Cancelled);

            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
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

        // and a call past its timeout ends cancelled too, answered 504
        var timed = await Started((options) =>
        {
            return options with { Timeout = TimeSpan.FromMilliseconds(50) };
        });

        try
        {
            using var answered = await timed.Client.SendAsync(Json("/api/Transcoding/hang", "{}"), Cancelled);

            Assert.Equal(HttpStatusCode.GatewayTimeout, answered.StatusCode);
            await Until(() =>
            {
                return timed.Service.Cancelled == 1;
            });
        }
        finally
        {
            await Stopped(timed);
        }
    }

    [Fact]
    public async Task Answers_a_command_to_an_exchange_s_connection_SERVICE_UNKNOWN()
    {
        var started = await Started();

        try
        {
            using var asked = await started.Client.SendAsync(Json("/api/Transcoding/ask", "{}"), Cancelled);

            Assert.Equal((HttpStatusCode.OK, "{\"code\":18}"), (asked.StatusCode, await asked.Content.ReadAsStringAsync(Cancelled)));
            Assert.Equal(["no service 1"], started.Service.Refused);
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

            // * the file beadc wrote, which its route table embeds as it is; the TypeScript output
            // writes no file of it apart
            Assert.Equal(Document, bytes);
            Assert.Equal(HttpRoutes.OpenApiDocument.ToArray(), bytes);
            Assert.Equal("no-cache", served.Headers.CacheControl?.ToString());
            Assert.Equal("application/json", served.Content.Headers.ContentType?.ToString());
            Assert.Equal($"\"{Convert.ToHexStringLower(SHA256.HashData(Document))}\"", served.Headers.ETag?.ToString());

            var again = new HttpRequestMessage(HttpMethod.Get, "/openapi.json");

            again.Headers.TryAddWithoutValidation("if-none-match", served.Headers.ETag!.ToString());

            using var held = await started.Client.SendAsync(again, Cancelled);

            Assert.Equal(HttpStatusCode.NotModified, held.StatusCode);

            using var posted = await started.Client.SendAsync(Json("/openapi.json", "{}"), Cancelled);

            Assert.Equal("GET, HEAD", string.Join(", ", posted.Content.Headers.Allow));
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
            Assert.Equal(("busy", "1"), (second.Headers.GetValues("bead-refusal").Single(), second.Headers.RetryAfter?.ToString()));

            // a call that hangs holds its address's one call, and a stream still opens beside none
            using var aborting = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
            var hanging = started.Client.SendAsync(Json("/api/Transcoding/hang", "{}"), aborting.Token);

            await Until(() =>
            {
                return started.Service.Hanging == 1;
            });

            using var refused = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{}"), Cancelled);

            Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
            Assert.Equal(("busy", "1"), (refused.Headers.GetValues("bead-refusal").Single(), refused.Headers.RetryAfter?.ToString()));

            // both freed as their exchanges end
            await aborting.CancelAsync();
            stream.Dispose();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return hanging;
            });
            await Until(() =>
            {
                return started.Service.Cancelled == 1;
            });

            var freed = HttpStatusCode.ServiceUnavailable;

            for (var since = TimeProvider.System.GetTimestamp(); freed != HttpStatusCode.OK && TimeProvider.System.GetElapsedTime(since) < Patience;)
            {
                using var echoed = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{}"), Cancelled);

                freed = echoed.StatusCode;
            }

            Assert.Equal(HttpStatusCode.OK, freed);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_a_result_the_stock_library_refuses_502_reported_none_of_its_words_in_the_problem()
    {
        // * raw's route told its result is an Edges: the bytes its server echoes, `x`, a varint cut short
        var started = await Started((options) =>
        {
            return options with
            {
                Routes = [.. options.Routes.Select((route) =>
                {
                    return route.Procedure == TranscodingProcedures.Raw.Procedure ? route with { Result = HttpPayload.Of(Edges.Descriptor) } : route;
                })],
            };
        });
        var reported = ReportedBy(started.Gateway);

        try
        {
            var raw = new HttpRequestMessage(HttpMethod.Post, "/api/Transcoding/raw") { Content = new ByteArrayContent("x"u8.ToArray()) };

            raw.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

            using var answered = await started.Client.SendAsync(raw, Cancelled);
            var body = await answered.Content.ReadAsStringAsync(Cancelled);

            Assert.Equal(HttpStatusCode.BadGateway, answered.StatusCode);
            Assert.Equal("{\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}", body);
            Assert.DoesNotContain(Assert.Single(reported), body, StringComparison.Ordinal);

            // and one whose records its codec refuses first (spec 17.9.5): `at`, a message, as a varint
            var recorded = new HttpRequestMessage(HttpMethod.Post, "/api/Transcoding/raw") { Content = new ByteArrayContent([0x08, 0x00]) };

            recorded.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

            using var refused = await started.Client.SendAsync(recorded, Cancelled);

            Assert.Equal((HttpStatusCode.BadGateway, body), (refused.StatusCode, await refused.Content.ReadAsStringAsync(Cancelled)));
            Assert.Equal(2, reported.Count);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_503_DESTINATION_UNREACHABLE_when_its_connection_cannot_be_drawn_reported_none_of_its_words_in_the_problem()
    {
        var started = await Started();
        var reported = ReportedBy(started.Gateway);

        try
        {
            await started.Service.Memory.Stop();

            using var answered = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{}"), Cancelled);

            Assert.Equal(HttpStatusCode.ServiceUnavailable, answered.StatusCode);
            Assert.Equal("1", answered.Headers.RetryAfter?.ToString());
            Assert.Equal("{\"code\":17,\"scope\":\"protocol\",\"status\":503,\"title\":\"DESTINATION_UNREACHABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/DESTINATION_UNREACHABLE\"}", await answered.Content.ReadAsStringAsync(Cancelled));
            Assert.EndsWith(", not open", Assert.Single(reported), StringComparison.Ordinal);
        }
        finally
        {
            await Stopped(started);
        }
    }

    // transcoding 7.6.27
    [Fact]
    public async Task Answers_what_no_gate_foresaw_500_reported_none_of_its_words_in_the_problem()
    {
        // * a clock that breaks as a body is read, past every gate
        var started = await Started((options) =>
        {
            return options with { Clock = new BrokenClock() };
        });
        var reported = ReportedBy(started.Gateway);

        try
        {
            using var answered = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{}"), Cancelled);

            Assert.Equal(HttpStatusCode.InternalServerError, answered.StatusCode);
            Assert.Equal("{\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}", await answered.Content.ReadAsStringAsync(Cancelled));
            Assert.Equal(["the clock broke"], reported);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_500_a_connection_its_server_failed_to_draw_but_by_refusing_it_reported_with_no_detail()
    {
        await using var service = await TranscodingService.Start();
        await using var gateway = new HttpGateway(Exchanges.OptionsOf(service.Memory, null));
        var reported = ReportedBy(gateway);

        // * an exchange handed on with a port no connect takes: refused before its server sees it; the
        // TypeScript side's transport takes a stand-in that fails, which a sealed class takes none of
        var context = new DefaultHttpContext();
        var body = new MemoryStream();

        context.Request.Method = "GET";
        context.Request.Protocol = "HTTP/1.1";
        context.Request.Host = new HostString("127.0.0.1");
        context.Connection.RemotePort = 70_000;
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = "/v1/books/2";
        context.Response.Body = body;

        await gateway.Answer(context);

        Assert.Equal(StatusCodes.Status500InternalServerError, context.Response.StatusCode);
        Assert.Equal("{\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}", Encoding.UTF8.GetString(body.ToArray()));
        Assert.StartsWith("a port is from 0 to 65535, not 70000", Assert.Single(reported), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Reports_each_failure_it_answers_a_call_with_500_or_above_and_none_below()
    {
        // * a route of a procedure its server does not offer, 501; a call past its timeout, 504, on a
        // clock that moves only as the test moves it, so no call races its deadline
        var clock = new FakeTimeProvider();
        var started = await Started((options) =>
        {
            return options with
            {
                Clock = clock,
                Timeout = TimeSpan.FromMilliseconds(50),
                Routes = [.. options.Routes.Select((route) =>
                {
                    return route.Procedure == TranscodingProcedures.Raw.Procedure ? route with { Procedure = route.Procedure with { ProcedureId = 99 } } : route;
                })],
            };
        });
        var reported = ReportedBy(started.Gateway);

        try
        {
            var raw = new HttpRequestMessage(HttpMethod.Post, "/api/Transcoding/raw") { Content = new ByteArrayContent("x"u8.ToArray()) };

            raw.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

            using var unknown = await started.Client.SendAsync(raw, Cancelled);

            Assert.Equal(HttpStatusCode.NotImplemented, unknown.StatusCode);
            Assert.Single(reported);

            // its resolver holds it: its timeout passes as the clock moves
            var hanging = started.Client.SendAsync(Json("/api/Transcoding/hang", "{}"), Cancelled);

            await Until(() =>
            {
                return started.Service.Hanging == 1;
            });
            clock.Advance(TimeSpan.FromMilliseconds(50));

            using var hung = await hanging.WaitAsync(Patience, Cancelled);

            Assert.Equal(HttpStatusCode.GatewayTimeout, hung.StatusCode);
            Assert.Equal(2, reported.Count);

            // an application failure is the caller's, 400, and no session one, 401: reported none
            using var failed = await started.Client.SendAsync(Json("/api/Transcoding/fail", "{\"detail\":\"no\"}"), Cancelled);
            using var unknownSession = await started.Client.SendAsync(Json("/api/Transcoding/whoAmI", "{}"), Cancelled);

            Assert.Equal((HttpStatusCode.BadRequest, HttpStatusCode.Unauthorized), (failed.StatusCode, unknownSession.StatusCode));
            Assert.Equal(2, reported.Count);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_502_a_text_result_that_is_no_UTF_8_reported_none_of_its_words_in_the_problem()
    {
        // * raw's route told its result is a text: the bytes its server echoes, FF, no UTF-8
        var started = await Started((options) =>
        {
            return options with
            {
                Routes = [.. options.Routes.Select((route) =>
                {
                    return route.Procedure == TranscodingProcedures.Raw.Procedure ? route with { Result = HttpPayload.Text } : route;
                })],
            };
        });
        var reported = ReportedBy(started.Gateway);

        try
        {
            var raw = new HttpRequestMessage(HttpMethod.Post, "/api/Transcoding/raw") { Content = new ByteArrayContent([0xFF]) };

            raw.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

            using var answered = await started.Client.SendAsync(raw, Cancelled);

            Assert.Equal(HttpStatusCode.BadGateway, answered.StatusCode);
            Assert.Equal("{\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}", await answered.Content.ReadAsStringAsync(Cancelled));
            Assert.Single(reported);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Refuses_an_authorization_but_elsewhere_or_bearer_jwt_and_a_bound_that_is_no_whole_number_above_0()
    {
        await using var service = await TranscodingService.Start();
        var options = Exchanges.OptionsOf(service.Memory, null);

        Assert.StartsWith("a gateway's authorization is elsewhere or bearer-jwt", Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            _ = new HttpGateway(options with { Authorization = (GatewayAuthorization)7 });
        }).Message, StringComparison.Ordinal);
        Assert.StartsWith("MaximumBodyBytes is a whole number above 0, not 0", Assert.ThrowsAny<ArgumentException>(() =>
        {
            _ = new HttpGateway(options with { MaximumBodyBytes = 0 });
        }).Message, StringComparison.Ordinal);
        Assert.StartsWith("Window is a whole number above 0, not 0", Assert.ThrowsAny<ArgumentException>(() =>
        {
            _ = new HttpGateway(options with { Window = 0 });
        }).Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Reports_to_a_handler_until_it_is_off()
    {
        var started = await Started();
        var reported = ReportedBy(started.Gateway);
        var off = new List<Exception>();

        void Handler(Exception reason)
        {
            lock (off)
            {
                off.Add(reason);
            }
        }

        started.Gateway.Error += Handler;
        started.Gateway.Error -= Handler;

        try
        {
            await started.Service.Memory.Stop();

            using var answered = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{}"), Cancelled);

            Assert.Equal(HttpStatusCode.ServiceUnavailable, answered.StatusCode);
            Assert.Equal((1, 0), (reported.Count, off.Count));
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Words_each_refusal_of_its_gates_exactly_none_of_them_what_its_request_carried()
    {
        const string JsonType = "content-type: application/json";
        const string Book = "{\"aString\":\"0123456789\"}";
        var plain = await Started();
        var jwt = await Started((options) =>
        {
            return options with { Authorization = GatewayAuthorization.BearerJwt };
        });
        var small = await Started((options) =>
        {
            return options with { MaximumBodyBytes = 16 };
        });
        var parted = new List<string>();

        try
        {
            foreach (var (started, expected) in new (Fixture Started, OwnCase Case)[]
            {
                (plain, new(["GET /v1/books/2 HTTP/1.1", "host: evil.example"], 403, "a host it does not take") { Reason = "host-refused" }),
                (plain, new(["GET /nope HTTP/1.1"], 404, "a path no route matches") { Reason = "path-unknown" }),
                (plain, new(["GET /v1/books/2 HTTP/1.1", "origin: https://other.example"], 403, "an origin neither its own nor listed") { Reason = "origin-refused" }),
                (plain, new(["GET /v1/books/2 HTTP/1.1", "sec-fetch-site: cross-site", "sec-fetch-mode: no-cors"], 403, "a request from a page of another site that shows no origin") { Reason = "origin-refused" }),
                (plain, new(["PUT /v1/shelves/1/books/2 HTTP/1.1", JsonType], 405, "a method no route of its path takes") { Body = "{}", Reason = "method-refused" }),
                (plain, new(["POST /openapi.json HTTP/1.1", JsonType], 405, "a method the document takes none of") { Body = "{}", Reason = "method-refused" }),
                (plain, new(["GET /openapi.json HTTP/1.1", JsonType], 400, "content to the document") { Body = "{}", Reason = "malformed" }),
                (plain, new(["POST /api/Transcoding/echo HTTP/1.1", "content-type: text/plain"], 415, "this route's body is application/json, unencoded") { Body = "{}", Reason = "type-refused" }),
                (plain, new(["GET /v1/books/2 HTTP/1.1", JsonType], 400, "content to a route that takes none") { Body = "{}", Reason = "malformed" }),
                (plain, new(["POST /api/Transcoding/whoAmI HTTP/1.1", JsonType, "authorization: Bearer good", "authorization: Bearer good"], 400, "two authorization fields") { Body = "{}", Reason = "malformed" }),
                (jwt, new(["POST /api/Transcoding/whoAmI HTTP/1.1", JsonType, "authorization: Basic YTpi"], 401, "an auth-scheme but Bearer") { Body = "{}" }),
                (jwt, new(["POST /api/Transcoding/whoAmI HTTP/1.1", JsonType, $"authorization: Bearer {new string('a', 1_005)}"], 431, "a token past 1004 bytes") { Body = "{}" }),
                (small, new(["POST /api/Transcoding/echo HTTP/1.1", JsonType], 413, "a body declared past maximumBodyBytes 16") { Body = Book, Reason = "too-large" }),
                (small, new(["POST /api/Transcoding/echo HTTP/1.1", JsonType, "transfer-encoding: chunked"], 413, "a body past maximumBodyBytes 16") { Body = $"18\r\n{Book}\r\n0\r\n\r\n", Reason = "too-large" }),
                (plain, new(["POST /api/Transcoding/echo HTTP/1.1", JsonType, JsonType], 415, "this route's body is application/json, unencoded") { Body = "{}", Reason = "type-refused" }),
                (plain, new(["POST /api/Transcoding/echo HTTP/1.1", "content-type: application/json; boundary=x"], 415, "this route's body is application/json, unencoded") { Body = "{}", Reason = "type-refused" }),
                (plain, new(["POST /api/Transcoding/echo HTTP/1.1", "content-type: application/json; charset"], 415, "this route's body is application/json, unencoded") { Body = "{}", Reason = "type-refused" }),
                (plain, new(["POST /api/Transcoding/echo HTTP/1.1", "content-type: text/plain"], 415, "this route's body is application/json, unencoded") { Reason = "type-refused" }),
                (plain, new(["POST /api/Transcoding/echo HTTP/1.1", JsonType, "sec-fetch-site: cross-site", "sec-fetch-mode: navigate"], 403, "a request from a page of another site that shows no origin") { Body = "{}", Reason = "origin-refused" }),
                (jwt, new(["POST /api/Transcoding/whoAmI HTTP/1.1", JsonType, "authorization: Bearer"], 401, "an auth-scheme but Bearer") { Body = "{}" }),
            })
            {
                parted.AddRange(PartsOf(await Exchanged(started.Port, OctetsOf(started.Port, expected)), expected));
            }

            Assert.Empty(parted);
        }
        finally
        {
            await Stopped(plain);
            await Stopped(jwt);
            await Stopped(small);
        }
    }

    // transcoding 7.7.6
    [Fact]
    public async Task Words_each_refusal_of_its_bounds_exactly()
    {
        string[] echo = ["POST /api/Transcoding/echo HTTP/1.1", "content-type: application/json"];
        string[] hang = ["POST /api/Transcoding/hang HTTP/1.1", "content-type: application/json"];
        string[] watch = ["POST /api/Transcoding/watch HTTP/1.1", "content-type: application/json", "accept: text/event-stream"];
        var parted = new List<string>();

        // * a call that hangs holds its bound; a second is refused past it, every caller's or its address's
        foreach (var (change, words) in new (Func<HttpGatewayOptions, HttpGatewayOptions> Change, string Words)[]
        {
            ((options) =>
            {
                return options with { MaximumExchanges = 1 };
            }, "the calls under way hold maximumExchanges"),
            ((options) =>
            {
                return options with { MaximumExchangesPerAddress = 1 };
            }, "the calls of its address hold maximumExchangesPerAddress"),
        })
        {
            var started = await Started(change);

            try
            {
                using var held = await Opened(started.Port, OctetsOf(started.Port, new OwnCase(hang, 0, "") { Body = "{}" }));

                await Until(() =>
                {
                    return started.Service.Hanging == 1;
                });

                var expected = new OwnCase(echo, 503, words) { Body = "{}", Reason = "busy" };

                parted.AddRange(PartsOf(await Exchanged(started.Port, OctetsOf(started.Port, expected)), expected));
            }
            finally
            {
                await Stopped(started);
            }
        }

        // a stream that stays holds its own, apart from the calls
        foreach (var (change, words) in new (Func<HttpGatewayOptions, HttpGatewayOptions> Change, string Words)[]
        {
            ((options) =>
            {
                return options with { MaximumConnections = 1 };
            }, "the streams under way hold maximumConnections"),
            ((options) =>
            {
                return options with { MaximumConnectionsPerAddress = 1 };
            }, "the streams of its address hold maximumConnectionsPerAddress"),
        })
        {
            var started = await Started(change);

            try
            {
                using var held = await Opened(started.Port, OctetsOf(started.Port, new OwnCase(watch, 0, "") { Body = "{}" }));

                await held.ReceiveAsync(new byte[1], Cancelled).AsTask().WaitAsync(Patience, Cancelled);

                var expected = new OwnCase(watch, 503, words) { Body = "{}", Reason = "busy" };

                parted.AddRange(PartsOf(await Exchanged(started.Port, OctetsOf(started.Port, expected)), expected));
            }
            finally
            {
                await Stopped(started);
            }
        }

        foreach (var (change, expected) in new (Func<HttpGatewayOptions, HttpGatewayOptions> Change, OwnCase Case)[]
        {
            ((options) =>
            {
                return options with { BodyBytesBudget = 4 };
            }, new OwnCase(echo, 503, "the bodies under way hold bodyBytesBudget") { Body = "{\"anInt32\":1}", Reason = "busy" }),
            ((options) =>
            {
                return options with { BodyGracePeriod = TimeSpan.FromMilliseconds(100) };
            }, new OwnCase([.. echo, "content-length: 10"], 408, "a body slower than minimumBodyBytesPerSecond") { Reason = "too-slow" }),
            ((options) =>
            {
                return options with { Timeout = TimeSpan.FromMilliseconds(50) };
            }, new OwnCase(hang, 504, "no answer within 50 ms") { Body = "{}" }),
        })
        {
            var started = await Started(change);

            try
            {
                parted.AddRange(PartsOf(await Exchanged(started.Port, OctetsOf(started.Port, expected)), expected));
            }
            finally
            {
                await Stopped(started);
            }
        }

        Assert.Empty(parted);
    }

    [Fact]
    public async Task Takes_its_hosts_and_proxies_from_its_policy_or_beside_it_and_refuses_one_given_in_both()
    {
        var policy = HttpPolicy.Of(new HttpPolicyOptions { Hosts = ["api.example"], TrustedProxies = ["127.0.0.1"], UnnamedProxies = 0 });
        var fromPolicy = await Started((options) =>
        {
            return options with { Policy = policy };
        });
        var beside = await Started((options) =>
        {
            return options with { Hosts = ["api.example"], TrustedProxies = ["127.0.0.1"], UnnamedProxies = 0 };
        });

        try
        {
            foreach (var started in new[] { fromPolicy, beside })
            {
                var drawn = new List<string>();

                started.Service.Memory.Connection += (handle) =>
                {
                    lock (drawn)
                    {
                        drawn.Add(handle);
                    }
                };

                // * a host it takes, and its caller's address as the proxy it trusts forwards it
                var named = new HttpRequestMessage(HttpMethod.Get, "/v1/books/2");

                named.Headers.Host = "api.example";
                named.Headers.TryAddWithoutValidation("x-forwarded-for", "203.0.113.9");

                using var taken = await started.Client.SendAsync(named, Cancelled);
                var other = new HttpRequestMessage(HttpMethod.Get, "/v1/books/2");

                other.Headers.Host = "evil.example";

                using var refused = await started.Client.SendAsync(other, Cancelled);

                Assert.Equal((HttpStatusCode.OK, HttpStatusCode.Forbidden), (taken.StatusCode, refused.StatusCode));
                Assert.StartsWith("type=MEMORY;ip=203.0.113.9;", Assert.Single(drawn), StringComparison.Ordinal);
            }

            // a member given in its policy and beside it, whatever its value
            var options = Exchanges.OptionsOf(fromPolicy.Service.Memory, null);

            Assert.Equal(
                "Hosts is given in the policy and beside it: give it once (Parameter 'Hosts')",
                Assert.Throws<ArgumentException>(() =>
                {
                    _ = new HttpGateway(options with { Hosts = ["api.example"], Policy = policy });
                }).Message);
            Assert.Equal(
                "UnnamedProxies is given in the policy and beside it: give it once (Parameter 'UnnamedProxies')",
                Assert.Throws<ArgumentException>(() =>
                {
                    _ = new HttpGateway(options with { UnnamedProxies = 0, Policy = HttpPolicy.Of(new HttpPolicyOptions { UnnamedProxies = 1 }) });
                }).Message);
        }
        finally
        {
            await Stopped(fromPolicy);
            await Stopped(beside);
        }
    }

    [Fact]
    public async Task Refuses_a_route_off_its_template_s_grammar_and_listens_once()
    {
        await using var service = await TranscodingService.Start();
        var options = Exchanges.OptionsOf(service.Memory, null);
        var echo = RouteOf("echo");
        var crooked = echo with { Routes = [new HttpRouteTemplate { Method = "GET", Template = "/v1/{name" }] };

        // * a template off http.proto's grammar is refused as the gateway is built, naming its route
        Assert.StartsWith(
            "echo's route GET /v1/{name: a variable that does not close",
            Assert.Throws<ArgumentException>(() =>
            {
                _ = new HttpGateway(options with { Routes = [crooked] });
            }).Message,
            StringComparison.Ordinal);

        // one that listens on localhost, its loopbacks, listens once; one that listens on none stops at once
        await using var gateway = new HttpGateway(options);
        var address = await gateway.Start(new HttpGatewayStartOptions { FindOpenPort = true }, Cancelled);

        Assert.Equal("localhost", address.Address);
        Assert.Equal(
            "a gateway listens once",
            (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return gateway.Start(new HttpGatewayStartOptions { FindOpenPort = true }, Cancelled);
            })).Message);

        using (var client = new HttpClient { BaseAddress = new Uri($"http://localhost:{address.Port}") })
        {
            using var book = await client.GetAsync(new Uri("/v1/books/2", UriKind.Relative), Cancelled);

            Assert.Equal(HttpStatusCode.OK, book.StatusCode);
        }

        // a port another listener holds: its listen fails, and it listens on none
        await using var held = new HttpGateway(options);
        var port = (await held.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true }, Cancelled)).Port;
        await using var second = new HttpGateway(options);

        await Assert.ThrowsAnyAsync<IOException>(() =>
        {
            return second.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", Port = port }, Cancelled);
        });
        await second.Stop();
        await using var never = new HttpGateway(options);

        await never.Stop();
    }

    [Fact]
    public async Task Refuses_a_route_table_of_two_routes_of_one_method_that_tie_naming_both()
    {
        await using var service = await TranscodingService.Start();
        var options = Exchanges.OptionsOf(service.Memory, null);
        var echo = RouteOf("echo");
        var tying = echo with { Routes = [new HttpRouteTemplate { Method = "GET", Template = "/v1/books/{id}" }] };
        var beside = echo with { Routes = [new HttpRouteTemplate { Method = "POST", Template = "/v1/books/{id}", Body = "*" }] };

        // * two tables built apart and joined: the tie no builder saw is refused as the gateway is built
        Assert.Equal(
            "echo's route GET /v1/books/{id} ties getBook's route GET /v1/books/{name} (Parameter 'options')",
            Assert.Throws<ArgumentException>(() =>
            {
                _ = new HttpGateway(options with { Routes = [.. options.Routes, tying] });
            }).Message);

        // a route of another method at that template ties none
        await using var gateway = new HttpGateway(options with { Routes = [.. options.Routes, beside] });

        await gateway.Stop();
    }

    [Fact]
    public async Task Refuses_a_payload_of_no_schema_nor_encoding_a_notification_only_one_side_has_and_a_route_of_no_method_or_no_template()
    {
        await using var service = await TranscodingService.Start();
        var options = Exchanges.OptionsOf(service.Memory, null);
        var getBook = RouteOf("getBook");
        var ticks = RouteOf("ticks");

        string RefusalOf(HttpRoute route)
        {
            return Assert.Throws<ArgumentException>(() =>
            {
                _ = new HttpGateway(options with { Routes = [route] });
            }).Message;
        }

        // a payload of no schema nor encoding is the TypeScript side's alone: an HttpPayload is closed
        Assert.StartsWith("getBook's notification is its route's exactly where it notifies", RefusalOf(getBook with { Notification = HttpPayload.Of(Tick.Descriptor) }), StringComparison.Ordinal);
        Assert.StartsWith("ticks's notification is its route's exactly where it notifies", RefusalOf(ticks with { Notification = null }), StringComparison.Ordinal);
        Assert.StartsWith("getBook's route is a method of http.proto's and a template", RefusalOf(getBook with { Routes = [new HttpRouteTemplate { Method = "CUSTOM", Template = "/v1/books" }] }), StringComparison.Ordinal);
        Assert.StartsWith("getBook's route is a method of http.proto's and a template", RefusalOf(getBook with { Routes = [new HttpRouteTemplate { Method = "GET", Template = null! }] }), StringComparison.Ordinal);

        await using var taken = new HttpGateway(options with { Routes = [ticks] });
    }

    [Fact]
    public async Task Resets_over_HTTP_2_the_stream_of_a_request_whose_target_or_a_field_holds_an_octet_past_visible_ASCII_PROTOCOL_ERROR_nothing_written()
    {
        await using var service = await TranscodingService.Start();
        await using var gateway = new HttpGateway(Exchanges.OptionsOf(service.Memory, null));

        // an exchange over HTTP/2 as Kestrel hands it on, its :path its target as it came: a control
        // character, é, a NUL percent-encoded in its path, a path no route matches among them, and a
        // field past ASCII, each reset before its path is matched
        (string Target, string? Field)[] requests =
        [
            ("/v1/books/a\u0001b", null),
            ("/v1/books/é", null),
            ("/v1/books/a%00b", null),
            ("/nowhere%00", null),
            ("/v1/books/2", "café"),
        ];

        foreach (var (target, field) in requests)
        {
            var (status, reset, body) = await Http2Of(gateway, (target, field));

            Assert.Equal((StatusCodes.Status200OK, 0x1, ""), (status, reset, body));
        }

        // what its target percent-encodes is no octet of it
        Assert.Equal((StatusCodes.Status200OK, (int?)null, "{\"name\":\"a\\u0001b\",\"title\":\"A tale\"}"), await Http2Of(gateway, ("/v1/books/a%01b", null)));
    }

    // what the gateway answers an exchange over HTTP/2 of the target and the field given: its status,
    // the code its stream was reset with, none when it was not, and its body
    private static async Task<(int Status, int? Reset, string Body)> Http2Of(HttpGateway gateway, (string Target, string? Field) request)
    {
        var context = new DefaultHttpContext();
        var reset = new ResetFeature();
        var body = new MemoryStream();

        context.Request.Method = "GET";
        context.Request.Protocol = "HTTP/2";
        context.Request.Host = new HostString("127.0.0.1");
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = request.Target;
        context.Features.Set<IHttpResetFeature>(reset);
        context.Response.Body = body;

        if (request.Field is { } field)
        {
            context.Request.Headers["x-other"] = field;
        }

        await gateway.Answer(context);

        return (context.Response.StatusCode, reset.Code, Encoding.UTF8.GetString(body.ToArray()));
    }

    // a stream's reset, as Kestrel's feature takes it: the code it was reset with
    private sealed class ResetFeature : IHttpResetFeature
    {
        public int? Code { get; private set; }

        public void Reset(int errorCode)
        {
            Code = errorCode;
        }
    }

    [Fact]
    public async Task Answers_as_the_endpoint_an_application_maps_and_a_caller_of_no_address_as_local()
    {
        await using var service = await TranscodingService.Start();
        await using var gateway = new HttpGateway(Exchanges.OptionsOf(service.Memory, null));
        var drawn = new List<string>();

        service.Memory.Connection += (handle) =>
        {
            lock (drawn)
            {
                drawn.Add(handle);
            }
        };

        // * mapped as the application's fallback: what no other endpoint answers; a C# gateway may
        // listen on its own too, where the TypeScript side's built with no createServer listens on none
        var builder = WebApplication.CreateSlimBuilder();

        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel((kestrel) =>
        {
            kestrel.Listen(IPAddress.Loopback, 0);
        });

        await using var application = builder.Build();

        application.MapGet("/own", () =>
        {
            return "its own";
        });
        application.MapBeadGateway(gateway);
        await application.StartAsync(Cancelled);

        var port = new Uri(application.Urls.First()).Port;

        using (var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") })
        {
            using var own = await client.GetAsync(new Uri("/own", UriKind.Relative), Cancelled);
            using var book = await client.GetAsync(new Uri("/v1/books/2", UriKind.Relative), Cancelled);
            using var none = await client.GetAsync(new Uri("/nope", UriKind.Relative), Cancelled);

            Assert.Equal("its own", await own.Content.ReadAsStringAsync(Cancelled));
            Assert.Equal("{\"name\":\"2\",\"title\":\"A tale\"}", await book.Content.ReadAsStringAsync(Cancelled));
            Assert.Equal(("path-unknown", HttpStatusCode.NotFound), (none.Headers.GetValues("bead-refusal").Single(), none.StatusCode));
        }

        await application.StopAsync(Cancelled);

        // an exchange handed on with no remote address, as a test host's: its caller is local
        var context = new DefaultHttpContext();
        var body = new MemoryStream();

        context.Request.Method = "GET";
        context.Request.Protocol = "HTTP/1.1";
        context.Request.Host = new HostString("127.0.0.1");
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = "/v1/books/2";
        context.Response.Body = body;

        await gateway.Answer(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("{\"name\":\"2\",\"title\":\"A tale\"}", Encoding.UTF8.GetString(body.ToArray()));
        Assert.StartsWith("type=MEMORY;ip=local;", drawn[^1], StringComparison.Ordinal);

        // one given no document serves none: its path is one no route matches
        await using var silent = new HttpGateway(Exchanges.OptionsOf(service.Memory, null) with { Document = null });
        var asked = new DefaultHttpContext();

        asked.Request.Method = "GET";
        asked.Request.Protocol = "HTTP/1.1";
        asked.Request.Host = new HostString("127.0.0.1");
        asked.Features.Get<IHttpRequestFeature>()!.RawTarget = "/openapi.json";
        asked.Response.Body = new MemoryStream();

        await silent.Answer(asked);

        Assert.Equal((StatusCodes.Status404NotFound, "path-unknown"), (asked.Response.StatusCode, asked.Response.Headers["bead-refusal"].ToString()));
    }

    [Fact]
    public async Task Answers_each_request_at_the_edges_of_its_gates()
    {
        var started = await Started();

        try
        {
            // * a field of a control character: what HTTP refuses of its own, unmarked, its body empty
            var bell = await Exchanged(started.Port, OctetsOf(started.Port, new OwnCase(["GET /v1/books/2 HTTP/1.1", "x-other: a\u0007b"], 400, "")));

            Assert.Equal((400, false, ""), (bell.Status, bell.Fields.ContainsKey("bead-refusal"), bell.Body));

            // an absolute-form target: its path and query, its authority aside
            var absolute = await Exchanged(started.Port, OctetsOf(started.Port, new OwnCase([$"GET http://127.0.0.1:{started.Port}/v1/books/2?revision=3 HTTP/1.1"], 200, "")));

            Assert.Equal((200, "{\"name\":\"2\",\"title\":\"A tale\",\"pages\":\"3\"}"), (absolute.Status, absolute.Body));

            // a range of application/* weighed below text/event-stream: a stream; a weight it cannot read is 1
            foreach (var accept in new[] { "application/*;q=0.5, text/event-stream", "text/event-stream;q=x;level, application/json" })
            {
                using var stream = await Opened(started.Port, OctetsOf(started.Port, new OwnCase(["POST /api/Transcoding/watch HTTP/1.1", "content-type: application/json", $"accept: {accept}"], 200, "") { Body = "{}" }));

                Assert.Contains("event: result\nid: 1\ndata: {}\n\n", await ReadUntil(stream, "data: {}\n\n"), StringComparison.Ordinal);
            }

            // a raw route's query of empty parameters alone binds nothing, a charset quoted and an identity encoding are taken
            foreach (var lines in new[]
            {
                new[] { "POST /api/Transcoding/raw?& HTTP/1.1", "content-type: application/octet-stream" },
                ["POST /api/Transcoding/raw HTTP/1.1", "content-type: application/octet-stream; charset=\"UTF-8\"", "content-encoding: identity"],
            })
            {
                var raw = await Exchanged(started.Port, OctetsOf(started.Port, new OwnCase(lines, 200, "") { Body = "hi" }));

                Assert.Equal((200, "hi"), (raw.Status, raw.Body));
            }

            // a call that hangs and one beside it of the same address: each held, then each let go
            var hanging = started.Client.SendAsync(Json("/api/Transcoding/hang", "{}"), Cancelled);

            await Until(() =>
            {
                return started.Service.Hanging == 1;
            });

            using var echoed = await started.Client.SendAsync(Json("/api/Transcoding/echo", "{\"anInt32\":2}"), Cancelled);

            Assert.Equal("{\"anInt32\":2}", await echoed.Content.ReadAsStringAsync(Cancelled));
            _ = hanging;
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_304_a_request_for_the_document_under_an_if_none_match_of_any_entity_tag()
    {
        var started = await Started();

        try
        {
            using var served = await started.Client.GetAsync(new Uri("/openapi.json", UriKind.Relative), Cancelled);
            var etag = served.Headers.ETag!.Tag;

            // * any tag, among others or alone, and a weak tag of its own compared as its strong one
            foreach (var asked in new[] { " * ", "\"other\", *", $"W/{etag}" })
            {
                var again = new HttpRequestMessage(HttpMethod.Get, "/openapi.json");

                again.Headers.TryAddWithoutValidation("if-none-match", asked);

                using var held = await started.Client.SendAsync(again, Cancelled);

                Assert.Equal(HttpStatusCode.NotModified, held.StatusCode);
            }
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Serves_its_document_to_a_HEAD_and_to_a_preflight_that_asks_for_no_field()
    {
        var started = await Started();

        try
        {
            using var head = await started.Client.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/openapi.json"), Cancelled);

            Assert.Equal((HttpStatusCode.OK, Document.Length), (head.StatusCode, (int)head.Content.Headers.ContentLength!));
            Assert.Empty(await head.Content.ReadAsByteArrayAsync(Cancelled));

            // a preflight from an origin it lists that asks for no field: GET and HEAD, authorization and any other
            var preflight = new HttpRequestMessage(HttpMethod.Options, "/openapi.json");

            preflight.Headers.TryAddWithoutValidation("origin", Origin);
            preflight.Headers.TryAddWithoutValidation("access-control-request-method", "GET");

            using var answered = await started.Client.SendAsync(preflight, Cancelled);

            Assert.Equal(HttpStatusCode.NoContent, answered.StatusCode);
            Assert.Equal("GET, HEAD", answered.Headers.GetValues("access-control-allow-methods").Single());
            Assert.Equal("authorization, *", answered.Headers.GetValues("access-control-allow-headers").Single());
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Writes_a_text_or_a_raw_stream_s_data_as_a_JSON_string_and_a_result_it_cannot_read_as_a_call_s_failure()
    {
        // * ticks served thrice more, its result and its notifications told they are raw, text, or an Edges
        HttpRoute Streamed(string template, (HttpPayload Result, HttpPayload Notification) told)
        {
            return RouteOf("ticks") with
            {
                Result = told.Result,
                Notification = told.Notification,
                Routes = [new HttpRouteTemplate { Method = "POST", Template = template, Body = "*" }],
            };
        }

        var started = await Started((options) =>
        {
            return options with
            {
                Routes =
                [
                    .. options.Routes,
                    Streamed("/raw-ticks", (HttpPayload.Raw, HttpPayload.Raw)),
                    Streamed("/text-ticks", (HttpPayload.Text, HttpPayload.Text)),
                    Streamed("/edges-ticks", (HttpPayload.Of(Edges.Descriptor), HttpPayload.Of(Tick.Descriptor))),
                ],
            };
        });
        var reported = ReportedBy(started.Gateway);

        // a listener that throws: the exchange answers on
        started.Gateway.Error += (_) =>
        {
            throw new InvalidOperationException("a listener broke");
        };

        async Task<(int Status, string Body)> Ticks(string path, int from)
        {
            var answered = await Exchanged(started.Port, OctetsOf(started.Port, new OwnCase([$"POST {path} HTTP/1.1", "content-type: application/json", "accept: text/event-stream"], 200, "") { Body = $"{{\"from\":{from}}}" }));

            return (answered.Status, answered.Fields.ContainsKey("transfer-encoding") ? Dechunked(answered.Body) : answered.Body);
        }

        try
        {
            // a TicksResponse and each Tick, 08 02, 08 01 and none, as raw and as text
            Assert.StartsWith("event: result\nid: 1\ndata: \"CAI=\"\n\nid: 2\ndata: \"CAE=\"\n\nid: 3\ndata: \"\"\n\nevent: failure\nid: 4\n", (await Ticks("/raw-ticks", 2)).Body, StringComparison.Ordinal);
            Assert.StartsWith("event: result\nid: 1\ndata: \"\\b\\u0002\"\n\nid: 2\ndata: \"\\b\\u0001\"\n\nid: 3\ndata: \"\"\n\nevent: failure\nid: 4\n", (await Ticks("/text-ticks", 2)).Body, StringComparison.Ordinal);

            // * a subscription its server drops right behind its result: the result first, then the failure
            Assert.StartsWith("event: result\nid: 1\ndata: \"\"\n\nevent: failure\nid: 2\n", (await Ticks("/text-ticks", 0)).Body, StringComparison.Ordinal);
            Assert.Empty(reported);

            // a result its stock library refuses, or a text one not UTF-8: 502, nothing of the stream written, reported
            const string Undecodable = "{\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}";

            Assert.Equal((502, Undecodable), await Ticks("/edges-ticks", 2));
            Assert.Equal((502, Undecodable), await Ticks("/text-ticks", -1));
            Assert.Equal(2, reported.Count);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Answers_500_a_result_its_mapping_holds_no_form_of_reported_in_the_mapping_s_words()
    {
        // * raw's route told its result is an Edges: the bytes its server echoes, a Value of NaN, a mask of foo_
        var started = await Started((options) =>
        {
            return options with
            {
                Routes = [.. options.Routes.Select((route) =>
                {
                    return route.Procedure == TranscodingProcedures.Raw.Procedure ? route with { Result = HttpPayload.Of(Edges.Descriptor) } : route;
                })],
            };
        });
        var reported = ReportedBy(started.Gateway);

        try
        {
            var nan = new Edges { Value = Value.ForNumber(double.NaN) }.ToByteArray();
            var raw = new HttpRequestMessage(HttpMethod.Post, "/api/Transcoding/raw") { Content = new ByteArrayContent(nan) };

            raw.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

            using var answered = await started.Client.SendAsync(raw, Cancelled);

            Assert.Equal(HttpStatusCode.InternalServerError, answered.StatusCode);
            Assert.Equal("{\"detail\":\"a Value whose number is not finite\",\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}", await answered.Content.ReadAsStringAsync(Cancelled));
            Assert.Equal(["a Value whose number is not finite"], reported);

            var mask = new HttpRequestMessage(HttpMethod.Post, "/api/Transcoding/raw") { Content = new ByteArrayContent(new Edges { Mask = new FieldMask { Paths = { "foo_" } } }.ToByteArray()) };

            mask.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

            using var unwritable = await started.Client.SendAsync(mask, Cancelled);

            Assert.Equal(HttpStatusCode.InternalServerError, unwritable.StatusCode);
            Assert.Equal("{\"detail\":\"a FieldMask path whose lowerCamelCase does not read back\",\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}", await unwritable.Content.ReadAsStringAsync(Cancelled));
            Assert.Equal(["a Value whose number is not finite", "a FieldMask path whose lowerCamelCase does not read back"], reported);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Refuses_a_query_beside_a_body_of_a_json_text_or_raw_route_and_a_variable_that_does_not_decode_400()
    {
        var started = await Started();

        static string Undecodable(string detail)
        {
            return $"{{\"code\":50,\"detail\":\"{detail}\",\"scope\":\"protocol\",\"status\":400,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}}";
        }

        try
        {
            foreach (var (path, type, body) in new[] { ("raw", "application/octet-stream", "x"), ("text", "text/plain", "x"), ("json", "application/json", "1") })
            {
                var queried = await Exchanged(started.Port, OctetsOf(started.Port, new OwnCase([$"POST /api/Transcoding/{path}?a=1 HTTP/1.1", $"content-type: {type}"], 400, "") { Body = body }));

                Assert.Equal((400, Undecodable("a query beside a body of the whole request")), (queried.Status, queried.Body));
            }

            var undecoded = await Exchanged(started.Port, OctetsOf(started.Port, new OwnCase(["GET /v1/shelves/%FF/books/2 HTTP/1.1"], 400, "")));

            Assert.Equal((400, Undecodable("a value whose bytes are not UTF-8").Replace("\"scope\"", "\"parameter\":\"name\",\"scope\"", StringComparison.Ordinal)), (undecoded.Status, undecoded.Body));
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Ends_a_stream_whose_notification_its_stock_library_refuses_with_502_as_its_last_event()
    {
        // * ticks' notification told it is an Edges: a Tick's remaining, field 1 a varint, where an Edges' at is a message
        var started = await Started((options) =>
        {
            return options with
            {
                Routes = [.. options.Routes.Select((route) =>
                {
                    return route.Procedure == TranscodingProcedures.Ticks.Procedure ? route with { Notification = HttpPayload.Of(Edges.Descriptor) } : route;
                })],
            };
        });
        var reported = ReportedBy(started.Gateway);

        try
        {
            var ticks = await Exchanged(started.Port, OctetsOf(started.Port, new OwnCase(["POST /api/Transcoding/ticks HTTP/1.1", "content-type: application/json", "accept: text/event-stream"], 200, "") { Body = "{\"from\":2}" }));

            Assert.Equal(200, ticks.Status);
            Assert.StartsWith(
                "event: result\nid: 1\ndata: {\"ticks\":2}\n\nevent: failure\nid: 2\ndata: {\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}\n\n",
                Dechunked(ticks.Body),
                StringComparison.Ordinal);
            Assert.Single(reported);
        }
        finally
        {
            await Stopped(started);
        }
    }

    [Fact]
    public async Task Drops_a_late_notification_after_an_unreadable_notification_starts_ending_its_stream()
    {
        await using var service = await TranscodingService.Start();
        var options = Exchanges.OptionsOf(service.Memory, null);
        await using var gateway = new HttpGateway(options with
        {
            Window = 1,
            Routes = [.. options.Routes.Select((route) =>
            {
                return route.Procedure == TranscodingProcedures.Watch.Procedure
                    ? route with { Notification = HttpPayload.Of(Edges.Descriptor) }
                    : route;
            })],
        });
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        using var body = new HeldResponseBody { HoldFailure = true };
        var context = new DefaultHttpContext();
        var reported = ReportedBy(gateway);
        var firstCredited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var nextCredited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        service.Server.Router.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Rx && envelope.Header is CreditHeader { Paced: true } credit)
            {
                if (credit.CreditEnd >= 2) { firstCredited.TrySetResult(); }
                if (credit.CreditEnd >= 3) { nextCredited.TrySetResult(); }
            }
        };
        context.Request.Method = "POST";
        context.Request.Host = new HostString("127.0.0.1");
        context.Request.ContentType = "application/json";
        context.Request.Headers.Accept = "text/event-stream";
        context.Request.ContentLength = 2;
        context.Request.Body = new MemoryStream("{}"u8.ToArray());
        context.RequestAborted = cancelling.Token;
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = "/api/Transcoding/watch";
        context.Response.Body = body;
        var serving = gateway.Answer(context);

        try
        {
            await body.FirstWritten.Task.WaitAsync(Patience, Cancelled);
            await service.Watched(1);
            await body.Writing.Task.WaitAsync(Patience, Cancelled);
            await firstCredited.Task.WaitAsync(Patience, Cancelled);
            await service.Watched(0);
            await nextCredited.Task.WaitAsync(Patience, Cancelled);

            Assert.Equal(2, body.Writes);
            Assert.Single(reported);
            body.Released.TrySetResult();
            await serving.WaitAsync(Patience, Cancelled);

            Assert.Equal("event: result\nid: 1\ndata: {}\n\nevent: failure\nid: 2\ndata: {\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}\n\n", Encoding.UTF8.GetString(body.ToArray()));
            await Until(() => { return service.Memory.ConnectionHandles.Count == 0; });
        }
        finally
        {
            body.Released.TrySetResult();
            await cancelling.CancelAsync();
            await serving.WaitAsync(Patience, Cancelled);
        }
    }

    [Fact]
    public async Task Waits_for_a_stream_response_to_drain_before_writing_its_next_event()
    {
        await using var service = await TranscodingService.Start();
        await using var gateway = new HttpGateway(Exchanges.OptionsOf(service.Memory, null));
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        using var body = new HeldResponseBody();
        var context = new DefaultHttpContext();
        var reported = ReportedBy(gateway);

        context.Request.Method = "POST";
        context.Request.Host = new HostString("127.0.0.1");
        context.Request.ContentType = "application/json";
        context.Request.Headers.Accept = "text/event-stream";
        context.Request.ContentLength = 2;
        context.Request.Body = new MemoryStream("{}"u8.ToArray());
        context.RequestAborted = cancelling.Token;
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = "/api/Transcoding/watch";
        context.Response.Body = body;
        var serving = gateway.Answer(context);

        try
        {
            await body.Writing.Task.WaitAsync(Patience, Cancelled);
            var notifying = service.Watched(2);

            Assert.Equal(1, body.Writes);
            body.Released.TrySetResult();
            await notifying.WaitAsync(Patience, Cancelled);
            await body.SecondWritten.Task.WaitAsync(Patience, Cancelled);

            Assert.Equal("event: result\nid: 1\ndata: {}\n\nid: 2\ndata: {\"remaining\":2}\n\n", Encoding.UTF8.GetString(body.ToArray()));
            Assert.Equal(2, body.Writes);
            Assert.Empty(reported);
        }
        finally
        {
            body.Released.TrySetResult();
            await cancelling.CancelAsync();
            await serving.WaitAsync(Patience, Cancelled);
        }
    }

    [Fact]
    public async Task Releases_a_stream_closed_while_its_response_waits_for_drainage()
    {
        await using var service = await TranscodingService.Start();
        var clock = new FakeTimeProvider();
        await using var gateway = new HttpGateway(Exchanges.OptionsOf(service.Memory, null) with
        {
            Clock = clock,
            Heartbeat = TimeSpan.FromSeconds(1),
        });
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        using var body = new HeldResponseBody();
        var context = new DefaultHttpContext();
        var reported = ReportedBy(gateway);

        context.Request.Method = "POST";
        context.Request.Host = new HostString("127.0.0.1");
        context.Request.ContentType = "application/json";
        context.Request.Headers.Accept = "text/event-stream";
        context.Request.ContentLength = 2;
        context.Request.Body = new MemoryStream("{}"u8.ToArray());
        context.RequestAborted = cancelling.Token;
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = "/api/Transcoding/watch";
        context.Response.Body = body;
        var serving = gateway.Answer(context);

        try
        {
            await body.Writing.Task.WaitAsync(Patience, Cancelled);
            await cancelling.CancelAsync();
            var aborted = await body.Aborted.Task.WaitAsync(Patience, Cancelled);

            Assert.Equal(cancelling.Token, aborted);
            await serving.WaitAsync(Patience, Cancelled);
            await Until(() => { return service.Memory.ConnectionHandles.Count == 0; });
            await service.Watched(2);
            clock.Advance(TimeSpan.FromSeconds(1));

            Assert.Equal(1, body.Writes);
            Assert.Empty(body.ToArray());
            Assert.Empty(reported);
        }
        finally
        {
            body.Released.TrySetResult();
            await cancelling.CancelAsync();
            await serving.WaitAsync(Patience, Cancelled);
        }
    }

    private sealed class HeldResponseBody : MemoryStream
    {
        public bool HoldFailure { get; init; }

        public TaskCompletionSource Writing { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource FirstWritten { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Released { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource<CancellationToken> Aborted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource SecondWritten { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int Writes { get; private set; }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Writes += 1;

            if (HoldFailure
                ? Encoding.UTF8.GetString(buffer.Span).StartsWith("event: failure", StringComparison.Ordinal)
                : Writes == 1)
            {
                Writing.TrySetResult();
                try
                {
                    await Released.Task.WaitAsync(cancellationToken);
                }
                catch (OperationCanceledException reason)
                {
                    Aborted.TrySetResult(reason.CancellationToken);
                    throw;
                }
            }

            await base.WriteAsync(buffer, cancellationToken);

            if (Writes == 1)
            {
                FirstWritten.TrySetResult();
            }

            if (Writes == 2)
            {
                SecondWritten.TrySetResult();
            }
        }
    }

    [Fact]
    public async Task Writes_a_comment_on_a_quiet_stream_each_heartbeat_on_its_clock_and_drops_one_past_maximumUnsentBytes()
    {
        var clock = new FakeTimeProvider();
        var started = await Started((options) =>
        {
            return options with { Clock = clock, Heartbeat = TimeSpan.FromSeconds(1) };
        });

        try
        {
            using var stream = await Opened(started.Port, OctetsOf(started.Port, new OwnCase(["POST /api/Transcoding/watch HTTP/1.1", "content-type: application/json", "accept: text/event-stream"], 200, "") { Body = "{}" }));

            await ReadUntil(stream, "data: {}\n\n");

            // * nothing written for a heartbeat: a comment, which no EventSource dispatches
            clock.Advance(TimeSpan.FromSeconds(1));

            Assert.EndsWith(":\n\r\n", await ReadUntil(stream, ":\n\r\n"), StringComparison.Ordinal);
        }
        finally
        {
            await Stopped(started);
        }

        // a stream's write past what its response may hold unsent: dropped, its socket aborted, nothing written
        var bounded = await Started((options) =>
        {
            return options with { MaximumUnsentBytes = 1 };
        });

        try
        {
            var dropped = await Received(bounded.Port, OctetsOf(bounded.Port, new OwnCase(["POST /api/Transcoding/watch HTTP/1.1", "content-type: application/json", "accept: text/event-stream"], 0, "") { Body = "{}" }));

            Assert.Empty(dropped);
        }
        finally
        {
            await Stopped(bounded);
        }
    }

    [Fact]
    public async Task Writes_its_comment_a_heartbeat_after_its_last_write_and_none_while_writes_go()
    {
        var clock = new FakeTimeProvider();
        var started = await Started((options) =>
        {
            return options with { Clock = clock, Heartbeat = TimeSpan.FromSeconds(1) };
        });

        try
        {
            using var stream = await Opened(started.Port, OctetsOf(started.Port, new OwnCase(["POST /api/Transcoding/watch HTTP/1.1", "content-type: application/json", "accept: text/event-stream"], 200, "") { Body = "{}" }));

            await ReadUntil(stream, "data: {}\n\n");
            clock.Advance(TimeSpan.FromMilliseconds(600));
            await started.Service.Watched(2);
            await ReadUntil(stream, "\"remaining\":2");
            clock.Advance(TimeSpan.FromMilliseconds(600));

            // * 1.2 s after the result, 0.6 s after the notification: no comment came before this one
            await started.Service.Watched(1);
            Assert.DoesNotContain(":\n\r\n", await ReadUntil(stream, "\"remaining\":1"), StringComparison.Ordinal);

            clock.Advance(TimeSpan.FromSeconds(1));
            Assert.EndsWith(":\n\r\n", await ReadUntil(stream, ":\n\r\n"), StringComparison.Ordinal);
        }
        finally
        {
            await Stopped(started);
        }
    }

    // a socket's bytes, read until they hold `end`
    private static async Task<string> ReadUntil(Socket socket, string end)
    {
        var came = new List<byte>();
        var buffer = new byte[65_536];

        while (!Encoding.UTF8.GetString([.. came]).Contains(end, StringComparison.Ordinal))
        {
            var count = await socket.ReceiveAsync(buffer, Cancelled).AsTask().WaitAsync(Patience, Cancelled);

            if (count == 0)
            {
                throw new IOException($"the socket ended before {end}: {Encoding.UTF8.GetString([.. came])}");
            }

            came.AddRange(buffer.AsSpan(0, count));
        }

        return Encoding.UTF8.GetString([.. came]);
    }

    // `octets` written on a socket of its own, and every byte that came back to its end, or its reset
    private static async Task<byte[]> Received(int port, byte[] octets)
    {
        using var socket = await Opened(port, octets);
        var came = new List<byte>();
        var buffer = new byte[65_536];

        while (true)
        {
            int count;

            try
            {
                count = await socket.ReceiveAsync(buffer, Cancelled).AsTask().WaitAsync(Patience, Cancelled);
            }
            catch (SocketException)
            {
                break;
            }

            if (count == 0)
            {
                break;
            }

            came.AddRange(buffer.AsSpan(0, count));
        }

        return [.. came];
    }

    // a chunked body of ASCII, its chunks joined
    private static string Dechunked(string body)
    {
        var joined = new StringBuilder();
        var at = 0;

        while (at < body.Length)
        {
            var end = body.IndexOf("\r\n", at, StringComparison.Ordinal);
            var size = int.Parse(body[at..end], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

            if (size == 0)
            {
                break;
            }

            joined.Append(body, end + 2, size);
            at = end + 2 + size + 2;
        }

        return joined.ToString();
    }

    // a request's octets as a socket of the test's own writes them: its lines, a host of the
    // gateway's own where they name none, its length, its body
    private static byte[] OctetsOf(int port, OwnCase given)
    {
        var lines = new List<string> { given.Lines[0] };
        var fields = given.Lines.Skip(1).ToList();

        if (!fields.Any((field) =>
        {
            return field.StartsWith("host:", StringComparison.OrdinalIgnoreCase);
        }))
        {
            lines.Add($"host: 127.0.0.1:{port}");
        }

        lines.AddRange(fields);

        if (given.Body.Length > 0 && !fields.Any((field) =>
        {
            return field.StartsWith("transfer-encoding:", StringComparison.OrdinalIgnoreCase);
        }))
        {
            lines.Add($"content-length: {Encoding.UTF8.GetByteCount(given.Body)}");
        }

        lines.AddRange(["connection: close", "", given.Body]);

        return Encoding.UTF8.GetBytes(string.Join("\r\n", lines));
    }

    // a socket of the test's own to the gateway on `port`, `octets` written on it
    private static async Task<Socket> Opened(int port, byte[] octets)
    {
        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };

        await socket.ConnectAsync(IPAddress.Loopback, port, Cancelled);
        await socket.SendAsync(octets, Cancelled);

        return socket;
    }

    // `octets` written on a socket of its own, and the response read whole, to the socket's end
    private static async Task<(int Status, Dictionary<string, string> Fields, string Body)> Exchanged(int port, byte[] octets)
    {
        using var socket = await Opened(port, octets);
        var came = new List<byte>();
        var buffer = new byte[65_536];

        while (true)
        {
            int count;

            try
            {
                count = await socket.ReceiveAsync(buffer, Cancelled).AsTask().WaitAsync(Patience, Cancelled);
            }
            catch (SocketException)
            {
                break;
            }

            if (count == 0)
            {
                break;
            }

            came.AddRange(buffer.AsSpan(0, count));
        }

        var text = Encoding.UTF8.GetString([.. came]);
        var end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        var head = text[..end].Split("\r\n");
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var field in head.Skip(1))
        {
            var colon = field.IndexOf(':', StringComparison.Ordinal);

            fields[field[..colon].Trim()] = field[(colon + 1)..].Trim();
        }

        return (int.Parse(head[0].Split(' ')[1], CultureInfo.InvariantCulture), fields, text[(end + 4)..]);
    }

    // what a case's response parts from it: its status, its mark, and its problem's words exactly
    private static List<string> PartsOf((int Status, Dictionary<string, string> Fields, string Body) answered, OwnCase expected)
    {
        var parts = new List<string>();
        string? detail = null;

        if (answered.Body.Length > 0)
        {
            using var problem = JsonDocument.Parse(answered.Body);

            if (problem.RootElement.TryGetProperty("detail", out var given))
            {
                detail = given.GetString();
            }
        }

        if (answered.Status != expected.Status)
        {
            parts.Add($"{expected.Words}: status {answered.Status}");
        }

        if (answered.Fields.GetValueOrDefault("bead-refusal") != expected.Reason)
        {
            parts.Add($"{expected.Words}: bead-refusal {answered.Fields.GetValueOrDefault("bead-refusal")}");
        }

        if (detail != expected.Words)
        {
            parts.Add($"{expected.Words}: detail {detail}");
        }

        return parts;
    }

    // a gateway of the service started, its client, and the port it listens on
    private sealed record Fixture(TranscodingService Service, HttpGateway Gateway, HttpClient Client, int Port);

    // a refusal or a failure of the gateway's own, as a request meets it: its request's line and
    // fields, its status, its words; its body, and its mark, none for a failure of its own
    private sealed record OwnCase(string[] Lines, int Status, string Words)
    {
        public string Body { get; init; } = "";

        public string? Reason { get; init; }
    }

    // a clock whose time breaks as it is read
    private sealed class BrokenClock : TimeProvider
    {
        public override long GetTimestamp()
        {
            throw new InvalidOperationException("the clock broke");
        }
    }
}
