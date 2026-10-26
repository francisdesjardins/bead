using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Bead.Transcoding.Http;
using Bead.Transcoding.V1;
using Google.Protobuf.WellKnownTypes;

namespace Bead.Transcoding.Tests;

/// <summary>The generated HTTP client and its caller, twins of http-caller.test.ts.</summary>
public sealed class HttpCallerTests
{
    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static async Task<Fixture> Started()
    {
        var service = await TranscodingService.Start();
        var gateway = new HttpGateway(Exchanges.OptionsOf(service.Memory, null));
        var address = await gateway.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true }, Cancelled);

        return new Fixture(service, gateway, new Uri($"http://127.0.0.1:{address.Port}"));
    }

    private static JsonElement Json(string text)
    {
        return PayloadCodecs.Json.Decode(Encoding.UTF8.GetBytes(text));
    }

    private static StubHandler Stub(string body, (string Type, HttpStatusCode Status, Action? Disposed) options)
    {
        return new StubHandler((request, _) =>
        {
            var content = new StreamContent(new FragmentedStream(Encoding.UTF8.GetBytes(body), options.Disposed));
            content.Headers.ContentType = new MediaTypeHeaderValue(options.Type);

            return Task.FromResult(new HttpResponseMessage(options.Status) { RequestMessage = request, Content = content });
        });
    }

    [Fact]
    public async Task Calls_default_routes_with_protobuf_JSON_and_every_native_encoding_through_its_gateway()
    {
        await using var fixture = await Started();
        using var client = new TranscodingHttpClient(fixture.Url);
        var book = await client.GetBook(new GetBookRequest { Name = "shelves/a/books/b", Revision = 7 });

        Assert.Equal(new Book { Name = "shelves/a/books/b", Pages = 7, Title = "A tale" }, book);
        Assert.Equal("Ada\r\nJosé", await client.Text("Ada\r\nJosé"));
        Assert.Equal(new byte[] { 0, 127, 255 }, (await client.Raw(new byte[] { 0, 127, 255 })).ToArray());
        Assert.Equal("{\"a\":\"José\",\"z\":[true,null]}", (await client.Json(Json("{\"z\":[true,null],\"a\":\"José\"}"))).GetRawText());
    }

    [Fact]
    public async Task Reads_application_and_protocol_problems_with_their_code_scope_and_detail()
    {
        await using var fixture = await Started();
        using var client = new TranscodingHttpClient(fixture.Url);
        var application = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Fail(new FailRequest { Detail = "by choice" });
        });
        var protocol = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.WhoAmI(new Empty());
        });

        Assert.Equal((1, FailureScope.Application, "by choice", FailureOrigin.Peer), ((int)application.Code, application.Scope, application.Detail, application.Origin));
        Assert.Equal((ProtocolCode.SessionRequired, FailureScope.Protocol, FailureOrigin.Peer), ((ProtocolCode)protocol.Code, protocol.Scope, protocol.Origin));
    }

    [Fact]
    public async Task Presents_a_default_authorization_or_its_override_and_omits_it_on_request()
    {
        await using var fixture = await Started();
        using var client = new TranscodingHttpClient(fixture.Url, new HttpCallerOptions { Authorization = "Bearer wrong" });

        Assert.Equal("ada", (await client.WhoAmI(new Empty(), new HttpCallOptions { Authorization = "Bearer good" })).Session);
        var defaulted = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.WhoAmI(new Empty());
        });
        var omitted = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.WhoAmI(new Empty(), new HttpCallOptions { Authorization = "Bearer good", WithoutAuthorization = true });
        });

        Assert.Equal((ushort)ProtocolCode.SessionRequired, defaulted.Code);
        Assert.Equal((ushort)ProtocolCode.SessionRequired, omitted.Code);
        Assert.Equal(JsonValueKind.Null, (await client.Json(Json("null"), new HttpCallOptions { WithoutAuthorization = true })).ValueKind);
    }

    [Fact]
    public async Task Refuses_a_credential_in_the_clear_before_encoding_or_HTTP_dispatch()
    {
        foreach (var host in new[] { "example.com", "localhost.", "128.0.0.1" })
        {
            var sent = 0;
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("null", Encoding.UTF8, "application/json") });
            });
            using var client = new TranscodingHttpClient(new Uri($"http://{host}"), new HttpCallerOptions { Handler = handler, Authorization = "Bearer good" });
            var refused = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return client.Json(default);
            });

            Assert.Equal((ProtocolCode.DestinationUnreachable, FailureScope.Protocol, FailureOrigin.Local), ((ProtocolCode)refused.Code, refused.Scope, refused.Origin));
            Assert.Equal(0, sent);
            Assert.Equal(JsonValueKind.Null, (await client.Json(Json("null"), new HttpCallOptions { WithoutAuthorization = true })).ValueKind);
            Assert.Equal(1, sent);
        }
    }

    [Fact]
    public async Task Takes_TLS_and_URL_loopback_forms_for_an_authorized_call()
    {
        foreach (var url in new[] { "https://example.com", "http://LOCALHOST", "http://app.localhost", "http://127.1", "http://127.0.0.1.", "http://[::1]" })
        {
            var sent = 0;
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                Assert.Equal("Bearer good", request.Headers.GetValues("Authorization").Single());
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("null", Encoding.UTF8, "application/json") });
            });
            using var client = new TranscodingHttpClient(new Uri(url), new HttpCallerOptions { Handler = handler, Authorization = "Bearer good" });

            Assert.Equal(JsonValueKind.Null, (await client.Json(Json("null"))).ValueKind);
            Assert.Equal(1, sent);
        }
    }

    [Fact]
    public async Task Reads_the_result_then_notifications_and_the_failure_ending_its_gateway_stream()
    {
        await using var fixture = await Started();
        using var client = new TranscodingHttpClient(fixture.Url);
        var received = new List<(bool IsResult, int Value)>();
        var failed = await Assert.ThrowsAsync<FailureException>(async () =>
        {
            await foreach (var entry in client.SubscribeTicks(new TicksRequest { From = 2 }))
            {
                received.Add((entry.IsResult, entry.IsResult ? entry.Result!.Ticks : entry.Notification!.Remaining));
            }
        });

        Assert.Equal((2, FailureScope.Application), ((int)failed.Code, failed.Scope));
        Assert.Equal([(true, 2), (false, 1), (false, 0)], received);
    }

    [Fact]
    public async Task Reads_fragmented_UTF_8_and_CRLF_events_and_releases_an_iteration_that_stops()
    {
        var disposed = 0;
        using var handler = Stub(": heartbeat\r\nevent: result\r\nid: 1\r\ndata: {}\r\n\r\nid: 2\r\ndata: {\"remaining\":7}\r\n\r\n", ("text/event-stream", HttpStatusCode.OK, () => { disposed++; }));
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var received = new List<HttpEvent<Empty, Tick>>();

        await foreach (var entry in client.SubscribeWatch(new Empty()))
        {
            received.Add(entry);

            if (received.Count == 2)
            {
                break;
            }
        }

        Assert.True(received[0].IsResult);
        Assert.False(received[1].IsResult);
        Assert.Equal(7, received[1].Notification!.Remaining);
        Assert.True(disposed > 0);
    }

    [Fact]
    public async Task Refuses_notifications_before_the_result_and_a_second_result_and_releases_the_stream()
    {
        foreach (var body in new[] { "data: {}\n\n", "event: result\ndata: {}\n\nevent: result\ndata: {}\n\n" })
        {
            var disposed = 0;
            using var handler = Stub(body, ("text/event-stream", HttpStatusCode.OK, () => { disposed++; }));
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var entry in client.SubscribeWatch(new Empty()))
                {
                    _ = entry;
                }
            });

            Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, failed.Code);
            Assert.True(disposed > 0);
        }
    }

    [Fact]
    public async Task Bounds_unary_bodies_and_events_and_refuses_redirects_without_following_them()
    {
        using var unaryHandler = Stub("null", ("application/json", HttpStatusCode.OK, null));
        using var unary = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = unaryHandler, MaximumBodyBytes = 2 });
        var body = await Assert.ThrowsAsync<FailureException>(() => { return unary.Json(Json("null")); });
        using var streamHandler = Stub("data: {}\n\n", ("text/event-stream", HttpStatusCode.OK, null));
        using var stream = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = streamHandler, MaximumBodyBytes = 2 });
        var events = await Assert.ThrowsAsync<FailureException>(async () =>
        {
            await foreach (var entry in stream.SubscribeWatch(new Empty()))
            {
                _ = entry;
            }
        });
        using var redirectHandler = Stub("", ("application/json", HttpStatusCode.TemporaryRedirect, null));
        using var redirect = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = redirectHandler });
        var moved = await Assert.ThrowsAsync<FailureException>(() => { return redirect.Json(Json("null")); });

        Assert.All(new[] { body, events }, (failure) => { Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, failure.Code); });
        Assert.Equal((ushort)ProtocolCode.DestinationLost, moved.Code);
        using var follows = new HttpClientHandler { AllowAutoRedirect = true };
        Assert.Throws<ArgumentException>(() => { return new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = follows }); });
    }

    [Fact]
    public async Task Passes_cancellation_to_HTTP_dispatch_and_rejects_a_URL_or_bound_outside_its_contract()
    {
        using var abort = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var seen = CancellationToken.None;
        using var handler = new StubHandler(async (_, cancellationToken) =>
        {
            seen = cancellationToken;
            entered.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("the call is cancelled");
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var waiting = client.Json(Json("null"), new HttpCallOptions { CancellationToken = abort.Token });
        await entered.Task.WaitAsync(Cancelled);
        await abort.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => { return waiting; });
        Assert.True(seen.IsCancellationRequested);

        foreach (var url in new[] { "http://user:secret@localhost", "http://localhost?x=1", "http://localhost/#fragment", "ftp://localhost" })
        {
            Assert.Throws<ArgumentException>(() => { return new TranscodingHttpClient(new Uri(url)); });
        }

        Assert.Throws<ArgumentOutOfRangeException>(() => { return new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { MaximumBodyBytes = 0 }); });
    }

    [Fact]
    public async Task Reads_text_and_raw_event_data_by_their_encodings()
    {
        var route = HttpRoutes.All.Single((route) => { return route.Procedure.ProcedureName == "watch"; }) with { Result = HttpPayload.Text, Notification = HttpPayload.Raw };
        using var handler = Stub("event: result\ndata: \"Ada\\rJosé\"\n\ndata: \"AAH/\"\n\nevent: failure\ndata: {\"code\":7,\"scope\":\"protocol\"}\n\n", ("text/event-stream", HttpStatusCode.OK, null));
        using var caller = new HttpCaller([route], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var received = new List<HttpEvent<string, ReadOnlyMemory<byte>>>();
        var failed = await Assert.ThrowsAsync<FailureException>(async () =>
        {
            await foreach (var entry in caller.Subscribe<string, ReadOnlyMemory<byte>>(route, new Empty())) { received.Add(entry); }
        });

        Assert.Equal((7, FailureScope.Protocol), ((int)failed.Code, failed.Scope));
        Assert.True(received[0].IsResult);
        Assert.Equal("Ada\rJosé", received[0].Result);
        Assert.False(received[1].IsResult);
        Assert.Equal(new byte[] { 0, 1, 255 }, received[1].Notification.ToArray());
    }

    [Fact]
    public async Task Refuses_a_truncated_stream_and_malformed_problems_without_another_call()
    {
        foreach (var (body, status, type, code, origin) in new[] {
            ("event: result\ndata: {}\n\n", HttpStatusCode.OK, "text/event-stream", ProtocolCode.DestinationLost, FailureOrigin.Local),
            ("{}", HttpStatusCode.BadRequest, "application/problem+json", ProtocolCode.PayloadUndecodable, FailureOrigin.Peer),
            ("{\"code\":0,\"scope\":\"protocol\"}", HttpStatusCode.BadRequest, "application/problem+json", ProtocolCode.PayloadUndecodable, FailureOrigin.Local),
            ("{}", HttpStatusCode.OK, "application/json", ProtocolCode.PayloadUndecodable, FailureOrigin.Local),
        })
        {
            var sent = 0;
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                return Task.FromResult(new HttpResponseMessage(status) { RequestMessage = request, Content = new StringContent(body, Encoding.UTF8, type) });
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var entry in client.SubscribeWatch(new Empty())) { _ = entry; }
            });

            Assert.Equal((code, origin), ((ProtocolCode)failed.Code, failed.Origin));
            Assert.Equal(1, sent);
        }
    }

    [Fact]
    public async Task Refuses_an_authorization_outside_HTTP_field_values_before_dispatch()
    {
        var sent = 0;
        using var handler = new StubHandler((request, _) =>
        {
            sent++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("null") });
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });

        foreach (var authorization in new[] { "Bearer bad\r\ninjected: value", "\u0001", "Bearer José", " Bearer good", "Bearer good ", "\tBearer good", "Bearer good\t" })
        {
            await Assert.ThrowsAsync<ArgumentException>(() => { return client.Json(Json("null"), new HttpCallOptions { Authorization = authorization }); });
        }
        Assert.Equal(0, sent);
    }

    [Fact]
    public async Task Reads_numeric_problem_codes_by_their_integer_value_and_refuses_another_JSON_kind()
    {
        foreach (var (body, code, scope, origin) in new[] {
            ("{\"code\":1.0,\"scope\":\"application\"}", 1, FailureScope.Application, FailureOrigin.Peer),
            ("{\"code\":1e0,\"scope\":\"application\"}", 1, FailureScope.Application, FailureOrigin.Peer),
            ("{\"code\":\"1\",\"scope\":\"application\"}", (int)ProtocolCode.PayloadUndecodable, FailureScope.Protocol, FailureOrigin.Local),
            ("{\"code\":1,\"scope\":1}", (int)ProtocolCode.PayloadUndecodable, FailureScope.Protocol, FailureOrigin.Local),
            ("{\"code\":1,\"scope\":\"application\",\"detail\":2}", (int)ProtocolCode.PayloadUndecodable, FailureScope.Protocol, FailureOrigin.Local),
        })
        {
            using var handler = Stub(body, ("application/problem+json", HttpStatusCode.BadRequest, null));
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });

            Assert.Equal((code, scope, origin), ((int)failed.Code, failed.Scope, failed.Origin));
        }
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_401_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)401) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.SessionRequired, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 401; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_403_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)403) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.AccessDenied, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 403; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_404_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)404) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.DestinationUnreachable, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 404; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_413_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)413) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.PayloadTooLarge, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 413; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_429_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)429) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.CapacityExceeded, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 429; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_503_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)503) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.DestinationUnreachable, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 503; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_502_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)502) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.DestinationLost, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 502; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_504_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)504) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.DestinationLost, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 504; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_307_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)307) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.DestinationLost, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 307; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Maps_an_unmarked_HTTP_418_and_keeps_its_status_and_Retry_After()
    {
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)418) { RequestMessage = request, Content = new StringContent("upstream") };
            response.Headers.TryAddWithoutValidation("retry-after", "7");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ProtocolCode.DestinationLost, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 418; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
    }


    [Fact]
    public async Task Reads_gateway_problems_by_their_refusal_before_their_status()
    {
        foreach (var (status, refusal, code) in new[] {
            (503, "busy", ProtocolCode.CapacityExceeded), (404, "path-unknown", ProtocolCode.DestinationUnreachable),
            (413, "too-large", ProtocolCode.PayloadTooLarge), (403, "host-refused", ProtocolCode.AccessDenied),
            (403, "origin-refused", ProtocolCode.AccessDenied), (405, "method-refused", ProtocolCode.DestinationUnreachable),
            (400, "malformed", ProtocolCode.PayloadUndecodable), (415, "type-refused", ProtocolCode.PayloadUndecodable),
            (408, "too-slow", ProtocolCode.DestinationUnreachable), (401, "", ProtocolCode.SessionRequired), (502, "", ProtocolCode.DestinationLost),
        })
        {
            using var handler = new StubHandler((request, _) =>
            {
                var response = new HttpResponseMessage((HttpStatusCode)status) { RequestMessage = request, Content = new StringContent("{\"type\":\"about:blank\",\"detail\":\"by the gateway\"}", Encoding.UTF8, "Application/Problem+JSON") };
                response.Headers.TryAddWithoutValidation("bead-refusal", refusal);
                response.Headers.TryAddWithoutValidation("retry-after", "7");
                return Task.FromResult(response);
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
            Assert.Equal((code, FailureOrigin.Peer, FailureScope.Protocol, $"the HTTP call answers {status}; Retry-After: 7; by the gateway"), ((ProtocolCode)failed.Code, failed.Origin, failed.Scope, failed.Detail));
        }
    }

    [Fact]
    public async Task Joins_a_base_URL_path_to_its_default_routes_and_treats_an_empty_authorization_as_none()
    {
        foreach (var path in new[] { "/proxy", "/proxy/" })
        {
            var sent = 0;
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                Assert.Equal("http://example.com/proxy/api/Transcoding/json", request.RequestUri!.AbsoluteUri);
                Assert.False(request.Headers.Contains("Authorization"));
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("null", Encoding.UTF8, "Application/JSON") });
            });
            using var client = new TranscodingHttpClient(new Uri($"http://example.com{path}"), new HttpCallerOptions { Handler = handler, Authorization = "" });
            Assert.Equal(JsonValueKind.Null, (await client.Json(Json("null"))).ValueKind);
            Assert.Equal(1, sent);
        }
    }

    [Fact]
    public async Task Reads_a_leading_stream_BOM_and_media_types_without_case()
    {
        using var handler = Stub("\uFEFFevent: result\r\ndata: {}\r\n\r\nevent: failure\r\ndata: {\"status\":502}\r\n\r\n", ("Text/Event-Stream", HttpStatusCode.OK, null));
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var events = new List<HttpEvent<Empty, Tick>>();
        var failed = await Assert.ThrowsAsync<FailureException>(async () => { await foreach (var entry in client.SubscribeWatch(new Empty())) { events.Add(entry); } });
        Assert.Equal(((ushort)ProtocolCode.DestinationLost, FailureOrigin.Peer), (failed.Code, failed.Origin));
        Assert.True(Assert.Single(events).IsResult);
        Assert.Equal(new Empty(), events[0].Result);
    }

    [Fact]
    public async Task Wraps_malformed_JSON_UTF_8_base64_and_event_framing_as_an_undecodable_payload()
    {
        var route = HttpRoutes.All.Single((entry) => { return entry.Procedure.ProcedureName == "watch"; });
        foreach (var (body, raw) in new[] { ("event: result\ndata: {\n\n", false), ("event: result\ndata: \"%%%\"\n\n", true), ("event: message\ndata: {}\n\n", false) })
        {
            var mapped = raw ? route with { Result = HttpPayload.Raw } : route;
            using var handler = Stub(body, ("text/event-stream", HttpStatusCode.OK, null));
            using var caller = new HttpCaller([mapped], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(async () => { await foreach (var entry in caller.Subscribe<object, Tick>(mapped, new Empty())) { _ = entry; } });
            Assert.Equal(((ushort)ProtocolCode.PayloadUndecodable, FailureOrigin.Local), (failed.Code, failed.Origin));
        }
        foreach (var type in new[] { "application/json", "application/problem+json", "text/event-stream" })
        {
            using var handler = new StubHandler((request, _) =>
            {
                var response = new HttpResponseMessage(type == "application/problem+json" ? HttpStatusCode.BadRequest : HttpStatusCode.OK) { RequestMessage = request, Content = new ByteArrayContent([255]) };
                response.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
                return Task.FromResult(response);
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                if (type == "text/event-stream") { await foreach (var entry in client.SubscribeWatch(new Empty())) { _ = entry; } }
                else { await client.Json(Json("null")); }
            });
            Assert.Equal(((ushort)ProtocolCode.PayloadUndecodable, FailureOrigin.Local, "the HTTP payload cannot be decoded"), (failed.Code, failed.Origin, failed.Detail));
            Assert.NotNull(failed.InnerException);
        }
    }

    [Fact]
    public async Task Disposes_its_client_without_disposing_a_supplied_handler()
    {
        var disposed = 0;
        using var handler = new StubHandler((request, _) => { return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("null", Encoding.UTF8, "application/json") }); }, () => { disposed++; });
        using (var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler })) { await client.Json(Json("null")); }
        Assert.Equal(0, disposed);
        using var other = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        Assert.Equal(JsonValueKind.Null, (await other.Json(Json("null"))).ValueKind);
    }

    [Fact]
    public async Task Bounds_the_decoded_message_even_when_the_body_bound_is_larger()
    {
        var maximumBodyBytes = LimitDefaults.MaximumEnvelopeBytes + 1;
        using var handler = new StubHandler((request, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new ByteArrayContent(new byte[maximumBodyBytes]) };
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { MaximumBodyBytes = maximumBodyBytes, Handler = handler });
        var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Raw(ReadOnlyMemory<byte>.Empty); });
        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, FailureOrigin.Local, "the HTTP payload passes maximumEnvelopeBytes"), (failed.Code, failed.Origin, failed.Detail));
    }

    [Fact]
    public async Task Maps_a_gateway_problem_without_a_refusal_by_its_status()
    {
        foreach (var (status, code) in new[] {
            (400, ProtocolCode.PayloadUndecodable), (401, ProtocolCode.SessionRequired),
            (403, ProtocolCode.AccessDenied), (404, ProtocolCode.DestinationUnreachable),
            (405, ProtocolCode.DestinationUnreachable), (408, ProtocolCode.DestinationUnreachable),
            (413, ProtocolCode.PayloadTooLarge), (415, ProtocolCode.PayloadUndecodable),
            (422, ProtocolCode.PayloadInvalid), (429, ProtocolCode.CapacityExceeded),
            (431, ProtocolCode.PayloadTooLarge), (500, ProtocolCode.DestinationLost),
            (501, ProtocolCode.ProcedureUnknown), (502, ProtocolCode.DestinationLost),
            (503, ProtocolCode.DestinationUnreachable), (504, ProtocolCode.DestinationLost),
        })
        {
            using var handler = new StubHandler((request, _) =>
            {
                return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) { RequestMessage = request, Content = new StringContent("{\"type\":\"about:blank\"}", Encoding.UTF8, "application/problem+json") });
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
            Assert.Equal((code, FailureOrigin.Peer, FailureScope.Protocol, $"the HTTP call answers {status}"), ((ProtocolCode)failed.Code, failed.Origin, failed.Scope, failed.Detail));
        }
    }

    private sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send, Action? disposed = null) : HttpMessageHandler
    {
        protected override void Dispose(bool disposing)
        {
            if (disposing) { disposed?.Invoke(); }
            base.Dispose(disposing);
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return send(request, cancellationToken);
        }
    }

    private sealed class FragmentedStream(byte[] bytes, Action? disposed) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            return base.ReadAsync(buffer[..Math.Min(1, buffer.Length)], cancellationToken);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                disposed?.Invoke();
            }

            base.Dispose(disposing);
        }
    }

    private sealed class Fixture(TranscodingService service, HttpGateway gateway, Uri url) : IAsyncDisposable
    {
        public Uri Url { get; } = url;

        public async ValueTask DisposeAsync()
        {
            await gateway.DisposeAsync();
            await service.DisposeAsync();
        }
    }
}
