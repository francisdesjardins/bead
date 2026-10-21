using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Bead.Transcoding.Http;
using Bead.Transcoding.V1;
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
            var reported = ReportedBy(jwt.Gateway);
            var token = Json("/api/Transcoding/whoAmI", "{}");

            token.Headers.TryAddWithoutValidation("authorization", "bearer a.b.c");

            using var unsupported = await jwt.Client.SendAsync(token, Cancelled);

            Assert.Equal(HttpStatusCode.InternalServerError, unsupported.StatusCode);
            Assert.Contains("\"code\":36", await unsupported.Content.ReadAsStringAsync(Cancelled), StringComparison.Ordinal);
            Assert.StartsWith("the server takes none of the scheme this gateway presents: ", Assert.Single(reported), StringComparison.Ordinal);

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
    public async Task Answers_a_command_to_an_exchange_s_connection_SERVICE_UNKNOWN()
    {
        var started = await Started();

        try
        {
            using var asked = await started.Client.SendAsync(Json("/api/Transcoding/ask", "{}"), Cancelled);

            Assert.Equal("{\"code\":18}", await asked.Content.ReadAsStringAsync(Cancelled));
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
            Assert.Equal("{\"code\":17,\"detail\":\"the connection is gone\",\"scope\":\"protocol\",\"status\":503,\"title\":\"DESTINATION_UNREACHABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/DESTINATION_UNREACHABLE\"}", await answered.Content.ReadAsStringAsync(Cancelled));
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
            Assert.Equal("{\"detail\":\"the gateway failed\",\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}", await answered.Content.ReadAsStringAsync(Cancelled));
            Assert.Equal(["the clock broke"], reported);
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
