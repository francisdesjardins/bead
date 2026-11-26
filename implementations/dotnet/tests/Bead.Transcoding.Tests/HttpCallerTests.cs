using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Bead.Transcoding.Http;
using Bead.Transcoding.V1;
using Google.Protobuf.WellKnownTypes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Https;
using Microsoft.Extensions.Logging;

namespace Bead.Transcoding.Tests;

/// <summary>The generated HTTP client and its caller, twins of http-caller.test.ts.</summary>
public sealed partial class HttpCallerTests
{
    [Fact]
    public void Refuses_a_URL_of_another_scheme_or_with_user_information_a_query_or_a_fragment_and_a_bound_of_0()
    {
        foreach (var url in new[] { "http://user:secret@localhost", "http://localhost?x=1", "http://localhost/#fragment", "ftp://localhost" })
        {
            var refused = Assert.Throws<ArgumentException>(() => { return new TranscodingHttpClient(new Uri(url)); });
            Assert.StartsWith("an HTTP client URL uses HTTP or HTTPS without user information, query or fragment", refused.Message, StringComparison.Ordinal);
            Assert.Equal("url", refused.ParamName);
        }
        foreach (var url in new[] { "localhost", "http://" })
        {
            Assert.Throws<UriFormatException>(() => { return new Uri(url, UriKind.Absolute); });
        }
        Assert.Throws<ArgumentOutOfRangeException>(() => { return new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { MaximumBodyBytes = 0 }); });
        using var accepted = new TranscodingHttpClient(new Uri("HTTPS://Example.COM"));
    }

    [Fact]
    public async Task Presents_its_credential_or_the_call_s_own_and_none_when_empty_or_omitted()
    {
        var presented = new List<string?>();
        using var handler = new StubHandler((request, _) =>
        {
            presented.Add(request.Headers.TryGetValues("Authorization", out var values) ? values.Single() : null);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("ok", Encoding.UTF8, "text/plain") });
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler, Authorization = "Bearer default" });
        foreach (var options in new HttpCallOptions?[] { null, new() { Authorization = "Bearer own" }, new() { Authorization = "" }, new() { Authorization = "Bearer own", WithoutAuthorization = true } })
        {
            Assert.Equal("ok", await client.Text("", options));
        }
        Assert.Equal(["Bearer default", "Bearer own", null, null], presented);
    }

    [Fact]
    public async Task Bounds_a_body_and_refuses_a_result_of_another_media_type()
    {
        var answers = new[] { ("12345", "text/plain"), ("ok", "text/html"), ("1234", "Text/Plain; charset=utf-8") };
        var index = 0;
        using var handler = new StubHandler((request, _) =>
        {
            var (body, type) = answers[index++];
            var content = new StringContent(body);
            content.Headers.ContentType = MediaTypeHeaderValue.Parse(type);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler, MaximumBodyBytes = 4 });
        var large = await Assert.ThrowsAsync<FailureException>(() => { return client.Text(""); });
        var other = await Assert.ThrowsAsync<FailureException>(() => { return client.Text(""); });

        Assert.Equal((ProtocolCode.PayloadTooLarge, FailureOrigin.Local, "the HTTP body passes maximumBodyBytes"), ((ProtocolCode)large.Code, large.Origin, large.Detail));
        Assert.Equal((ProtocolCode.PayloadUndecodable, "the HTTP result has another media type"), ((ProtocolCode)other.Code, other.Detail));
        Assert.Equal("1234", await client.Text(""));
        Assert.Equal(3, index);
    }

    [Fact]
    public async Task Refuses_a_credential_in_the_clear_or_of_no_field_value_before_anything_goes()
    {
        var sent = 0;
        using var handler = new StubHandler((request, _) =>
        {
            sent += 1;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("ok", Encoding.UTF8, "text/plain") });
        });
        using var unsafeClient = new TranscodingHttpClient(new Uri("http://example.com"), new HttpCallerOptions { Authorization = "Bearer good", Handler = handler });
        var failure = await Assert.ThrowsAsync<FailureException>(() => { return unsafeClient.Text(""); });
        Assert.Equal((ProtocolCode.DestinationUnreachable, FailureOrigin.Local, RouterSide.Client, ""), ((ProtocolCode)failure.Code, failure.Origin, failure.Side!.Value, failure.Detail));
        var malformed = await Assert.ThrowsAsync<ArgumentException>(() => { return unsafeClient.Text("", new HttpCallOptions { Authorization = "Bearer\nsplit" }); });
        Assert.StartsWith("a credential holds visible ASCII, spaces and tabs alone, none first or last", malformed.Message, StringComparison.Ordinal);
        Assert.Equal(0, sent);
        foreach (var url in new[] { "https://example.com", "http://LOCALHOST", "http://127.1", "http://[::1]" })
        {
            using var client = new TranscodingHttpClient(new Uri(url), new HttpCallerOptions { Authorization = "Bearer good", Handler = handler });
            Assert.Equal("ok", await client.Text(""));
        }
        Assert.Equal(4, sent);
    }


    [Fact]
    public async Task Reads_a_problem_as_its_Bead_failure_or_a_gateway_s_own_by_its_refusal_then_its_status()
    {
        var answers = new[]
        {
            (422, "{\"code\":1e0,\"scope\":\"application\",\"detail\":\"by choice\"}", "", "", 1, FailureScope.Application, FailureOrigin.Peer, "by choice"),
            (503, "{\"type\":\"about:blank\",\"detail\":\"by the gate\"}", "busy", "7", 35, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 503; Retry-After: 7; by the gate"),
            (401, "", "", "3", 32, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 401; Retry-After: 3"),
            (307, "", "", "", 65, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 307"),
            (500, "{\"code\":\"7\"}", "", "", 50, FailureScope.Protocol, FailureOrigin.Local, "the HTTP problem holds no Bead failure"),
            (408, "{\"status\":408}", "", "", 17, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 408"),
        };
        foreach (var (status, body, refusal, retry, code, scope, origin, detail) in answers)
        {
            var sent = 0;
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var response = new HttpResponseMessage((HttpStatusCode)status) { RequestMessage = request, Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body)) };
                if (status != 401 && status != 307) { response.Content.Headers.ContentType = new MediaTypeHeaderValue("Application/Problem+JSON"); }
                if (refusal.Length > 0) { response.Headers.Add("bead-refusal", refusal); }
                if (retry.Length > 0) { response.Headers.Add("retry-after", retry); }
                if (status == 307) { response.Headers.Location = new Uri("/elsewhere", UriKind.Relative); }
                return Task.FromResult(response);
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failure = await Assert.ThrowsAsync<FailureException>(() => { return client.Text(""); });
            Assert.Equal((code, scope, origin, detail), ((int)failure.Code, failure.Scope, failure.Origin, failure.Detail));
            Assert.Equal(1, sent);
        }
    }

    [Fact]
    public async Task Reads_a_stream_s_result_then_its_notifications_then_the_failure_that_ends_it()
    {
        var route = HttpRoutes.All.Single((entry) => { return entry.Procedure.ProcedureName == "watch"; }) with { Result = HttpPayload.Text, Notification = HttpPayload.Text };
        var bodies = new[]
        {
            "\uFEFF: a comment\r\nevent: result\r\nid: 0\r\ndata: \"op\r\n\r\ndata:\"next\"\r\n\r\nevent: message\ndata: \"two\"\n\nevent: failure\rdata: {\"code\":65,\rdata: \"scope\":\"protocol\"}\r\r",
            "event: result\ndata: \"open\"\n\n",
            "data: \"early\"\n\n",
            "\uFEFF: a comment\r\nevent: result\r\nid: 0\r\ndata: \"open\"\r\n\r\ndata:\"next\"\r\n\r\nevent: message\ndata: \"two\"\n\nevent: failure\rdata: {\"code\":65,\rdata: \"scope\":\"protocol\"}\r\r",
        };
        var expected = new[]
        {
            (50, FailureOrigin.Local, "the HTTP payload cannot be decoded", Array.Empty<(bool, string)>()),
            (65, FailureOrigin.Local, "the HTTP event stream ends without a failure", new[] { (true, "open") }),
            (50, FailureOrigin.Local, "the HTTP event stream holds one result then notifications", Array.Empty<(bool, string)>()),
            (65, FailureOrigin.Peer, "", new[] { (true, "open"), (false, "next"), (false, "two") }),
        };
        for (var i = 0; i < bodies.Length; i++)
        {
            using var handler = new StubHandler((request, _) =>
            {
                Assert.Equal("text/event-stream", Assert.Single(request.Headers.Accept).MediaType);
                var content = new StreamContent(new FragmentedStream(Encoding.UTF8.GetBytes(bodies[i]), null));
                content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var caller = new HttpCaller([route], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var received = new List<(bool, string)>();
            var failure = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var entry in caller.Subscribe<string, string>(route, new Empty()))
                {
                    received.Add((entry.IsResult, entry.IsResult ? entry.Result! : entry.Notification!));
                }
            });
            var (code, origin, detail, events) = expected[i];
            Assert.Equal((code, origin, detail), ((int)failure.Code, failure.Origin, failure.Detail));
            Assert.Equal(events, received);
        }
    }

    [Fact]
    public async Task Reads_raw_event_data_in_standard_padded_base64_alone_and_bounds_each_event()
    {
        var route = HttpRoutes.All.Single((entry) => { return entry.Procedure.ProcedureName == "watch"; }) with { Result = HttpPayload.Raw, Notification = HttpPayload.Raw };
        foreach (var (body, detail, count) in new[]
        {
            ("event: result\ndata: \"AAE=\"\n\ndata: \"AAE\"\n\n", "an HTTP raw event holds standard padded base64", 1),
            ("event: result\ndata: \"%%\"\n\n", "an HTTP raw event holds standard padded base64", 0),
            ("event: result\ndata: \"AAF=\"\n\n", "an HTTP raw event holds standard padded base64", 0),
            ("event: result\ndata: \"A AE=\"\n\n", "an HTTP raw event holds standard padded base64", 0),
            ("event: result\ndata: \"AA-_\"\n\n", "an HTTP raw event holds standard padded base64", 0),
            ("event: result\ndata: null\n\n", "an HTTP text or raw event holds a JSON string", 0),
            ("event: result\ndata: \"AAE=\"\n\ndata: \"0123456789012345678901234567\"\n\n", "the HTTP event passes maximumBodyBytes", 1),
        })
        {
            using var handler = Stub(body, ("text/event-stream", HttpStatusCode.OK, null));
            using var caller = new HttpCaller([route], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler, MaximumBodyBytes = 32 });
            var received = new List<HttpEvent<ReadOnlyMemory<byte>, ReadOnlyMemory<byte>>>();
            var failure = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var entry in caller.Subscribe<ReadOnlyMemory<byte>, ReadOnlyMemory<byte>>(route, new Empty())) { received.Add(entry); }
            });
            Assert.Equal(detail, failure.Detail);
            Assert.Equal(count, received.Count);
            if (count == 1)
            {
                Assert.True(received[0].IsResult);
                Assert.Equal(new byte[] { 0, 1 }, received[0].Result.ToArray());
            }
        }
    }

    [Fact]
    public async Task Frames_events_across_chunks_by_any_line_end_and_refuses_a_line_of_no_UTF_8()
    {
        var route = HttpRoutes.All.Single((entry) => { return entry.Procedure.ProcedureName == "watch"; }) with { Result = HttpPayload.Text };
        foreach (var end in new[] { "\r\n", "\n", "\r" })
        {
            using var handler = Stub($"event: result{end}data: \"été\"{end}{end}", ("text/event-stream", HttpStatusCode.OK, null));
            using var caller = new HttpCaller([route], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler, MaximumBodyBytes = 64 });
            await using var stream = caller.Subscribe<string, Tick>(route, new Empty()).GetAsyncEnumerator(Cancelled);
            Assert.True(await stream.MoveNextAsync());
            Assert.True(stream.Current.IsResult);
            Assert.Equal("été", stream.Current.Result);
        }
        foreach (var (bytes, detail) in new[]
        {
            (new byte[] { 100, 97, 116, 97, 58, 32, 255, 10 }, "the HTTP payload cannot be decoded"),
            (Array.Empty<byte>(), "the HTTP event stream ends without a failure"),
        })
        {
            using var handler = new StubHandler((request, _) =>
            {
                var content = new StreamContent(new FragmentedStream(bytes, null));
                content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var caller = new HttpCaller([route], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler, MaximumBodyBytes = 64 });
            var failure = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var entry in caller.Subscribe<string, Tick>(route, new Empty())) { _ = entry; }
            });
            Assert.Equal(detail, failure.Detail);
        }
    }

    [Fact]
    public async Task Ends_a_call_and_a_stream_its_signal_gives_up_as_cancelled()
    {
        using var abort = new CancellationTokenSource();
        using var handler = new StubHandler(async (_, signal) =>
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, signal);
            throw new InvalidOperationException("the call is cancelled");
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var options = new HttpCallOptions { CancellationToken = abort.Token };
        var call = client.Text("", options);
        await using var stream = client.SubscribeWatch(new Empty(), options).GetAsyncEnumerator(Cancelled);
        var reading = stream.MoveNextAsync().AsTask();
        await abort.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => { return call; });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => { return reading; });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => { return client.Text("", options); });
        Assert.True(abort.IsCancellationRequested);
    }


    [Fact]
    public async Task Resolves_each_default_route_under_its_base_path_and_refuses_another_procedure_s_or_no_default_one()
    {
        var generated = HttpRoutes.All.Single((entry) => { return entry.Procedure.ProcedureName == "text"; });
        var route = generated with { Routes = [new HttpRouteTemplate { Method = "POST", Template = "/api/S/echo", Body = "*" }] };
        foreach (var path in new[] { "/proxy", "/proxy/" })
        {
            var sent = 0;
            using var handler = new StubHandler(async (request, signal) =>
            {
                sent++;
                Assert.Equal("http://localhost/proxy/api/S/echo", request.RequestUri!.AbsoluteUri);
                Assert.Equal(HttpMethod.Post, request.Method);
                Assert.Equal("text/plain", request.Content!.Headers.ContentType!.MediaType);
                Assert.Equal("hi", await request.Content.ReadAsStringAsync(signal));
                return new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("ok", Encoding.UTF8, "text/plain") };
            });
            using var caller = new HttpCaller([route], new Uri("http://localhost" + path), new HttpCallerOptions { Handler = handler });
            Assert.Equal("ok", await caller.Call<string>(route, "hi"));
            Assert.Equal(1, sent);
        }
        var ruled = generated with { Routes = [new HttpRouteTemplate { Method = "GET", Template = "/v1/echo/{text}" }] };
        var dispatched = 0;
        using var refusedHandler = new StubHandler((request, _) =>
        {
            dispatched++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request });
        });
        using var refusedCaller = new HttpCaller([ruled], new Uri("http://localhost/a/b"), new HttpCallerOptions { Handler = refusedHandler });
        var refused = await Assert.ThrowsAsync<ArgumentException>(() => { return refusedCaller.Call<string>(ruled, "hi"); });
        Assert.StartsWith("an HTTP client calls a default POST route with a whole body and result", refused.Message, StringComparison.Ordinal);
        Assert.Equal(0, dispatched);
    }


    [Fact]
    public async Task Calls_a_text_a_raw_and_a_JSON_route_and_reads_a_stream_through_a_gateway()
    {
        static Procedure ProcedureOf(string name, ushort id)
        {
            return new Procedure { ProcedureName = name, ProcedureId = id, ServiceId = 7, ServiceRevision = 1 };
        }
        var echo = new RequestProcedure<HttpCallerTests, string, string, NoFailure>(ProcedureOf("echo", 1), new ProcedureBindings<string, string> { Admission = AdmissionRule.None, Request = PayloadCodecs.Text, Result = PayloadCodecs.Text });
        var raw = new RequestProcedure<HttpCallerTests, ReadOnlyMemory<byte>, ReadOnlyMemory<byte>, NoFailure>(ProcedureOf("raw", 2), new ProcedureBindings<ReadOnlyMemory<byte>, ReadOnlyMemory<byte>> { Admission = AdmissionRule.None, Request = PayloadCodecs.Raw, Result = PayloadCodecs.Raw });
        var json = new RequestProcedure<HttpCallerTests, JsonElement, JsonElement, NoFailure>(ProcedureOf("json", 3), new ProcedureBindings<JsonElement, JsonElement> { Admission = AdmissionRule.None, Request = PayloadCodecs.Json, Result = PayloadCodecs.Json });
        var news = new RequestProcedure<HttpCallerTests, string, string, string, NoFailure>(ProcedureOf("news", 4), new ProcedureBindings<string, string, string> { Admission = AdmissionRule.None, Request = PayloadCodecs.Text, Result = PayloadCodecs.Text, Notification = PayloadCodecs.Text });
        await using var memory = new MemoryTransportServer();
        await using var server = new Server<string>(memory);
        var service = new ServiceServer<HttpCallerTests, string>([echo, raw, json, news]);
        service.On(echo, (request, response) => { return response.Answer(request.Payload + "!"); });
        service.On(raw, (request, response) => { return response.Answer(request.Payload); });
        service.On(json, (request, response) => { return response.Answer(request.Payload); });
        service.On(news, (_, response) => { return response.Answer("open"); });
        service.Offer(server);
        await memory.Start();
        static HttpRoute Route(Procedure procedure, HttpPayload payload)
        {
            return new HttpRoute { Procedure = procedure, Request = payload, Result = payload, Failures = new Dictionary<string, int>(), Routes = [new HttpRouteTemplate { Method = "POST", Body = "*", Template = "/api/S/" + procedure.ProcedureName }] };
        }
        var echoRoute = Route(echo.Procedure, HttpPayload.Text);
        var rawRoute = Route(raw.Procedure, HttpPayload.Raw);
        var jsonRoute = Route(json.Procedure, HttpPayload.Json);
        var newsRoute = Route(news.Procedure, HttpPayload.Text) with { Notification = HttpPayload.Text };
        HttpRoute[] routes = [echoRoute, rawRoute, jsonRoute, newsRoute];
        await using var gateway = new HttpGateway(new HttpGatewayOptions { Transport = memory, Routes = routes });
        var address = await gateway.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true, CancellationToken = Cancelled });
        using var caller = new HttpCaller(routes, new Uri($"http://127.0.0.1:{address.Port}"));
        Assert.Equal("hi!", await caller.Call<string>(echoRoute, "hi"));
        Assert.Equal(new byte[] { 0, 255, 7 }, (await caller.Call<ReadOnlyMemory<byte>>(rawRoute, new ReadOnlyMemory<byte>([0, 255, 7]))).ToArray());
        Assert.Equal("{\"a\":[1,\"b\",null]}", (await caller.Call<JsonElement>(jsonRoute, Json("{\"a\":[1,\"b\",null]}"))).GetRawText());
        await using var stream = caller.Subscribe<string, string>(newsRoute, "").GetAsyncEnumerator(Cancelled);
        Assert.True(await stream.MoveNextAsync());
        Assert.True(stream.Current.IsResult);
        Assert.Equal("open", stream.Current.Result);
        await service.NotifierOf(news)("first");
        Assert.True(await stream.MoveNextAsync());
        Assert.False(stream.Current.IsResult);
        Assert.Equal("first", stream.Current.Notification);
    }


    [Fact]
    public async Task Calls_its_gateway_over_the_client_config_it_is_given()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=localhost", key, HashAlgorithmName.SHA256);
        var names = new SubjectAlternativeNameBuilder();
        names.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(names.Build());
        using var ephemeral = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        using var certificate = X509CertificateLoader.LoadPkcs12(ephemeral.Export(X509ContentType.Pkcs12), null);
        await using var service = await TranscodingService.Start();
        await using var gateway = new HttpGateway(Exchanges.OptionsOf(service.Memory, null));
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel((kestrel) =>
        {
            kestrel.Listen(IPAddress.Loopback, 0, (listen) =>
            {
                listen.UseHttps((https) =>
                {
                    https.ServerCertificate = certificate;
                    https.ClientCertificateMode = ClientCertificateMode.RequireCertificate;
                    https.AllowAnyClientCertificate();
                });
            });
        });
        await using var application = builder.Build();
        application.Use(async (context, next) =>
        {
            Assert.Equal(certificate.Thumbprint, context.Connection.ClientCertificate?.Thumbprint);
            await next(context);
        });
        application.MapBeadGateway(gateway);
        await application.StartAsync(Cancelled);
        var policy = new X509ChainPolicy { TrustMode = X509ChainTrustMode.CustomRootTrust, RevocationMode = X509RevocationMode.NoCheck };
        policy.CustomTrustStore.Add(certificate);
        using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, SslOptions = new SslClientAuthenticationOptions { CertificateChainPolicy = policy, ClientCertificateContext = SslStreamCertificateContext.Create(certificate, null) } };
        using var caller = new TranscodingHttpClient(new Uri(application.Urls.Single()), new HttpCallerOptions { Handler = handler });
        Assert.Equal("hi!", await caller.Text("hi!"));
        await application.StopAsync(Cancelled);
    }

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
        var address = await gateway.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true, CancellationToken = Cancelled });

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
    public void Prints_no_authorization_in_its_options()
    {
        var given = new HttpCallerOptions { Authorization = "Bearer good", MaximumBodyBytes = 64 };

        Assert.DoesNotContain("good", given.ToString(), StringComparison.Ordinal);
        Assert.Equal("HttpCallerOptions { Handler = , Authorization = set, MaximumBodyBytes = 64 }", given.ToString());
        Assert.Contains("Authorization = none", new HttpCallerOptions().ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Prints_no_authorization_in_a_call_s_options()
    {
        var given = new HttpCallOptions { Authorization = "Bearer good" };

        Assert.DoesNotContain("good", given.ToString(), StringComparison.Ordinal);
        Assert.StartsWith("HttpCallOptions { Authorization = set, WithoutAuthorization = False, CancellationToken = ", given.ToString(), StringComparison.Ordinal);
        Assert.Contains("Authorization = none, WithoutAuthorization = True", new HttpCallOptions { WithoutAuthorization = true }.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Refuses_a_given_handler_that_would_follow_a_redirect_AllowAutoRedirect_named_before_any_exchange()
    {
        using var sockets = new SocketsHttpHandler();
        using var platform = new HttpClientHandler();
        using var wrapped = new Wrapper(new Wrapper(new SocketsHttpHandler()));
        foreach (var handler in new HttpMessageHandler[] { sockets, platform, wrapped })
        {
            var caller = Assert.Throws<ArgumentException>(() => { return new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler }); });
            Assert.Equal("a handler given would follow a redirect, which the client follows none of: its AllowAutoRedirect is true (spec 15.6) (Parameter 'options')", caller.Message);
            Assert.Equal("options", caller.ParamName);
            Assert.Contains("AllowAutoRedirect", caller.Message, StringComparison.Ordinal);
        }
        using var accepted = new Wrapper(new SocketsHttpHandler { AllowAutoRedirect = false });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = accepted });
    }

    [Fact]
    public async Task Refuses_an_answer_from_a_supplied_executor_that_follows_a_redirect()
    {
        var disposed = 0;
        using var handler = new StubHandler((_, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                RequestMessage = new HttpRequestMessage(HttpMethod.Post, "http://elsewhere.example"),
                Content = new StreamContent(new FragmentedStream("null"u8.ToArray(), () => { disposed++; })),
            };
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var failure = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
        Assert.Equal((ushort)ProtocolCode.DestinationLost, failure.Code);
        Assert.Equal(1, disposed);
    }

    // transcoding 12.1
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

    // transcoding 12.4 and 12.4.1
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

    // transcoding 12.3
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

    // transcoding 12.5
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

    // transcoding 12.6
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


    // transcoding 12.4.3
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


    // transcoding 12.4.2
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

    // transcoding 12.2
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
    public async Task Refuses_non_string_and_noncanonical_raw_event_data_and_releases_its_reader()
    {
        var route = HttpRoutes.All.Single((entry) => { return entry.Procedure.ProcedureName == "watch"; }) with { Result = HttpPayload.Raw };

        foreach (var (data, detail) in new[]
        {
            ("null", "an HTTP text or raw event holds a JSON string"),
            ("\"AB==\"", "an HTTP raw event holds standard padded base64"),
        })
        {
            var disposed = 0;
            var sent = 0;
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var content = new StreamContent(new FragmentedStream(Encoding.UTF8.GetBytes($"event: result\ndata: {data}\n\n"), () => { disposed++; }));
                content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var caller = new HttpCaller([route], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var received = new List<HttpEvent<ReadOnlyMemory<byte>, Tick>>();
            var failed = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var entry in caller.Subscribe<ReadOnlyMemory<byte>, Tick>(route, new Empty()))
                {
                    received.Add(entry);
                }
            });

            Assert.Equal((ProtocolCode.PayloadUndecodable, FailureScope.Protocol, FailureOrigin.Local, detail), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
            Assert.Empty(received);
            Assert.Equal(1, sent);
            Assert.True(disposed > 0);
        }
    }

    [Fact]
    public async Task Refuses_invalid_result_media_and_malformed_JSON_without_another_call()
    {
        foreach (var (body, type, detail) in new[]
        {
            ("null", "text/plain", "the HTTP result has another media type"),
            ("{", "application/json", "the HTTP payload cannot be decoded"),
        })
        {
            var disposed = 0;
            var sent = 0;
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var content = new StreamContent(new FragmentedStream(Encoding.UTF8.GetBytes(body), () => { disposed++; }));
                content.Headers.ContentType = new MediaTypeHeaderValue(type);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });

            Assert.Equal((ProtocolCode.PayloadUndecodable, FailureScope.Protocol, FailureOrigin.Local, detail), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
            Assert.Equal(1, sent);
            Assert.True(disposed > 0);
        }
    }

    [Fact]
    public async Task Maps_failed_response_reads_to_destination_lost_and_releases_their_readers()
    {
        foreach (var streaming in new[] { false, true })
        {
            var broken = new IOException("the response reader broke");
            var sent = 0;
            using var stream = new FailedReadStream(Encoding.UTF8.GetBytes(streaming ? "event: result\ndata: " : "nu"), broken);
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var content = new StreamContent(stream);
                content.Headers.ContentType = new MediaTypeHeaderValue(streaming ? "text/event-stream" : "application/json");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var received = 0;
            var failed = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                if (streaming)
                {
                    await foreach (var entry in client.SubscribeWatch(new Empty()))
                    {
                        _ = entry;
                        received++;
                    }
                }
                else
                {
                    await client.Json(Json("null"));
                }
            });

            Assert.Equal((ProtocolCode.DestinationLost, FailureScope.Protocol, FailureOrigin.Local, "the HTTP body ends before its answer"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
            Assert.Same(broken, failed.InnerException);
            Assert.Equal(0, received);
            Assert.Equal(1, sent);
            Assert.Equal(2, stream.Reads);
            Assert.False(stream.CanRead);
        }
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

    [Fact]
    public async Task Refuses_invalid_low_level_call_inputs_before_HTTP_dispatch()
    {
        var generated = HttpRoutes.All.Single((route) => { return route.Procedure.ProcedureName == "json"; });
        var template = generated.Routes[0];
        var sent = 0;
        using var handler = new StubHandler((request, _) =>
        {
            sent++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("null") });
        });
        HttpRouteTemplate[][] choices =
        [
            [],
            [template with { Method = "GET" }],
            [template with { Body = null }],
            [template with { ResponseBody = "field" }],
            [template with { Template = "/items/{name}" }],
        ];
        foreach (var routes in choices)
        {
            var route = generated with { Routes = routes };
            using var caller = new HttpCaller([route], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<ArgumentException>(() => { return caller.Call<JsonElement>(route, Json("null")); });
            Assert.Equal("an HTTP client calls a default POST route with a whole body and result (Parameter 'route')", failed.Message);
            Assert.Equal("route", failed.ParamName);
        }
        var elsewhere = generated with { Routes = [template with { Template = "https://elsewhere.example/call" }] };
        using var valid = new HttpCaller([generated, elsewhere], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var moved = await Assert.ThrowsAsync<ArgumentException>(() => { return valid.Call<JsonElement>(elsewhere, Json("null")); });
        Assert.Equal("an HTTP route stays on its gateway origin (Parameter 'route')", moved.Message);
        foreach (var authorization in new[] { " Bearer x", "Bearer x ", "Bearer\nx", "\t", "É" })
        {
            var refused = await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return valid.Call<JsonElement>(generated, Json("null"), new HttpCallOptions { Authorization = authorization });
            });
            Assert.Equal("a credential holds visible ASCII, spaces and tabs alone, none first or last (Parameter 'options')", refused.Message);
            Assert.Equal("options", refused.ParamName);
        }
        var subscription = await Assert.ThrowsAsync<ArgumentException>(async () =>
        {
            await foreach (var entry in valid.Subscribe<JsonElement, JsonElement>(generated, Json("null")))
            {
                Assert.Fail($"a non-notifying call yielded {entry}");
            }
        });
        Assert.Equal("only a notifying HTTP procedure opens a stream (Parameter 'call')", subscription.Message);
        Assert.Equal("call", subscription.ParamName);
        Assert.Equal(0, sent);
    }

    [Fact]
    public async Task Refuses_invalid_UTF_8_on_a_terminated_event_line_and_releases_its_reader()
    {
        var disposed = 0;
        var sent = 0;
        byte[] bytes = [.. Encoding.UTF8.GetBytes("event: result\ndata: "), 255, 10, 10];
        using var stream = new FragmentedStream(bytes, () => { disposed++; });
        using var handler = new StubHandler((request, _) =>
        {
            sent++;
            var content = new StreamContent(stream);
            content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
        var received = 0;
        var failed = await Assert.ThrowsAsync<FailureException>(async () =>
        {
            await foreach (var entry in client.SubscribeWatch(new Empty()))
            {
                _ = entry;
                received++;
            }
        });
        Assert.Equal((ProtocolCode.PayloadUndecodable, FailureOrigin.Local, FailureScope.Protocol, "the HTTP payload cannot be decoded"), ((ProtocolCode)failed.Code, failed.Origin, failed.Scope, failed.Detail));
        Assert.IsType<DecoderFallbackException>(failed.InnerException);
        Assert.Equal(0, received);
        Assert.Equal(1, sent);
        Assert.True(disposed > 0);
        Assert.False(stream.CanRead);
    }

    [Fact]
    public async Task Propagates_a_response_read_error_after_cancellation_without_mapping_it_to_a_failure()
    {
        foreach (var streaming in new[] { false, true })
        {
            using var abort = new CancellationTokenSource();
            var broken = new IOException("the cancelled response reader broke");
            var sent = 0;
            using var stream = new FailedReadStream(Encoding.UTF8.GetBytes(streaming ? "event: result\ndata: " : "nu"), broken) { BeforeFailure = abort.Cancel };
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var content = new StreamContent(stream);
                content.Headers.ContentType = new MediaTypeHeaderValue(streaming ? "text/event-stream" : "application/json");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var received = 0;
            var failed = await Assert.ThrowsAsync<IOException>(async () =>
            {
                var options = new HttpCallOptions { CancellationToken = abort.Token };
                if (streaming)
                {
                    await foreach (var entry in client.SubscribeWatch(new Empty(), options))
                    {
                        _ = entry;
                        received++;
                    }
                }
                else
                {
                    await client.Json(Json("null"), options);
                }
            });
            Assert.Same(broken, failed);
            Assert.True(abort.IsCancellationRequested);
            Assert.Equal(0, received);
            Assert.Equal(1, sent);
            Assert.Equal(2, stream.Reads);
            Assert.False(stream.CanRead);
        }
    }

    [Fact]
    public async Task Refuses_malformed_JSON_in_native_stream_data_before_delivering_an_event()
    {
        var generated = HttpRoutes.All.Single((entry) => { return entry.Procedure.ProcedureName == "watch"; });
        foreach (var result in new[] { HttpPayload.Text, HttpPayload.Raw })
        {
            var route = generated with { Result = result };
            var disposed = 0;
            var sent = 0;
            using var stream = new FragmentedStream("event: result\ndata: {\n\n"u8.ToArray(), () => { disposed++; });
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var content = new StreamContent(stream);
                content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var caller = new HttpCaller([route], new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var received = 0;
            var failed = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var entry in caller.Subscribe<object, Tick>(route, new Empty()))
                {
                    _ = entry;
                    received++;
                }
            });
            Assert.Equal((ProtocolCode.PayloadUndecodable, FailureScope.Protocol, FailureOrigin.Local, "the HTTP payload cannot be decoded"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
            Assert.NotNull(failed.InnerException);
            Assert.Equal(0, received);
            Assert.Equal(1, sent);
            Assert.True(disposed > 0);
            Assert.False(stream.CanRead);
        }
    }

    [Fact]
    public async Task Reads_an_empty_raw_result_and_maps_an_empty_non_problem_refusal_by_status()
    {
        foreach (var status in new[] { HttpStatusCode.OK, HttpStatusCode.ServiceUnavailable })
        {
            var sent = 0;
            var disposed = 0;
            using var stream = new FragmentedStream([], () => { disposed++; });
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var content = new StreamContent(stream);
                content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                var response = new HttpResponseMessage(status) { RequestMessage = request, Content = content };
                response.Headers.TryAddWithoutValidation("retry-after", "7");
                return Task.FromResult(response);
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            if (status == HttpStatusCode.OK)
            {
                Assert.True((await client.Raw(ReadOnlyMemory<byte>.Empty)).IsEmpty);
            }
            else
            {
                var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Raw(ReadOnlyMemory<byte>.Empty); });
                Assert.Equal((ProtocolCode.DestinationUnreachable, FailureScope.Protocol, FailureOrigin.Peer, "the HTTP call answers 503; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
            }
            Assert.Equal(1, sent);
            Assert.True(disposed > 0);
            Assert.False(stream.CanRead);
        }
    }

    [Fact]
    public async Task Rejects_empty_responses_with_no_required_media_type_and_releases_their_content()
    {
        foreach (var (streaming, status, code, detail) in new[]
        {
            (false, HttpStatusCode.OK, ProtocolCode.PayloadUndecodable, "the HTTP result has another media type"),
            (true, HttpStatusCode.OK, ProtocolCode.PayloadUndecodable, "the HTTP subscription answers no event stream"),
            (false, HttpStatusCode.ServiceUnavailable, ProtocolCode.DestinationUnreachable, "the HTTP call answers 503"),
        })
        {
            var sent = 0;
            var disposed = 0;
            using var stream = new FragmentedStream([], () => { disposed++; });
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                return Task.FromResult(new HttpResponseMessage(status) { RequestMessage = request, Content = new StreamContent(stream) });
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var received = 0;
            var failed = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                if (streaming)
                {
                    await foreach (var entry in client.SubscribeWatch(new Empty()))
                    {
                        _ = entry;
                        received++;
                    }
                }
                else
                {
                    await client.Json(Json("null"));
                }
            });
            Assert.Equal((code, detail, FailureScope.Protocol, status == HttpStatusCode.OK ? FailureOrigin.Local : FailureOrigin.Peer), ((ProtocolCode)failed.Code, failed.Detail, failed.Scope, failed.Origin));
            Assert.Equal(0, received);
            Assert.Equal(1, sent);
            Assert.True(disposed > 0);
            Assert.False(stream.CanRead);
        }
    }

    [Fact]
    public async Task Refuses_an_empty_event_stream_from_a_supplied_executor_and_over_HTTP()
    {
        foreach (var wire in new[] { false, true })
        {
            var sent = 0;
            var disposed = 0;
            var builder = WebApplication.CreateSlimBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            await using var host = builder.Build();
            host.Run(async (context) =>
            {
                Interlocked.Increment(ref sent);
                context.Response.StatusCode = StatusCodes.Status200OK;
                context.Response.ContentType = "text/event-stream";
                context.Response.ContentLength = 0;
                await context.Response.CompleteAsync();
            });
            await host.StartAsync(Cancelled);
            using var stream = new FragmentedStream([], () => { disposed++; });
            using var handler = new StubHandler((request, _) =>
            {
                Interlocked.Increment(ref sent);
                var content = new StreamContent(stream);
                content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var client = new TranscodingHttpClient(new Uri(host.Urls.Single()), wire ? null : new HttpCallerOptions { Handler = handler });
            var received = 0;
            var failure = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var _ in client.SubscribeWatch(new Empty()))
                {
                    received++;
                }
            });
            Assert.Equal((ushort)ProtocolCode.DestinationLost, failure.Code);
            Assert.Equal("the HTTP event stream ends without a failure", failure.Detail);
            Assert.Equal(FailureScope.Protocol, failure.Scope);
            Assert.Equal(FailureOrigin.Local, failure.Origin);
            Assert.Equal(0, received);
            Assert.Equal(1, sent);
            if (!wire)
            {
                Assert.True(disposed > 0);
                Assert.False(stream.CanRead);
            }
        }
    }

    [Fact]
    public async Task Maps_unmarked_HTTP_statuses_without_treating_an_intermediary_as_its_gateway()
    {
        foreach (var (status, code) in new[]
        {
            (201, ProtocolCode.DestinationLost), (204, ProtocolCode.DestinationLost),
            (299, ProtocolCode.DestinationLost), (300, ProtocolCode.DestinationLost),
            (304, ProtocolCode.DestinationLost), (399, ProtocolCode.DestinationLost),
            (400, ProtocolCode.DestinationLost), (401, ProtocolCode.SessionRequired),
            (403, ProtocolCode.AccessDenied), (404, ProtocolCode.DestinationUnreachable),
            (405, ProtocolCode.DestinationLost), (408, ProtocolCode.DestinationLost),
            (413, ProtocolCode.PayloadTooLarge), (415, ProtocolCode.DestinationLost),
            (422, ProtocolCode.DestinationLost), (429, ProtocolCode.CapacityExceeded),
            (431, ProtocolCode.DestinationLost), (500, ProtocolCode.DestinationLost),
            (501, ProtocolCode.DestinationLost), (502, ProtocolCode.DestinationLost),
            (503, ProtocolCode.DestinationUnreachable), (504, ProtocolCode.DestinationLost),
            (599, ProtocolCode.DestinationLost),
        })
        {
            var sent = 0;
            var disposed = 0;
            using var stream = new FragmentedStream([], () => { disposed++; });
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var response = new HttpResponseMessage((HttpStatusCode)status) { RequestMessage = request, Content = new StreamContent(stream) };
                response.Headers.TryAddWithoutValidation("retry-after", "7");
                return Task.FromResult(response);
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var failed = await Assert.ThrowsAsync<FailureException>(() => { return client.Json(Json("null")); });
            Assert.Equal((code, FailureScope.Protocol, FailureOrigin.Peer, $"the HTTP call answers {status}; Retry-After: 7"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
            Assert.Equal(1, sent);
            Assert.True(disposed > 0);
            Assert.False(stream.CanRead);
        }
    }

    [Fact]
    public async Task Refuses_a_stream_failure_with_an_invalid_HTTP_problem_status_and_no_Bead_code()
    {
        foreach (var data in new[] { "null", "{}", "{\"status\":99}", "{\"status\":600}", "{\"status\":1.5}", "{\"status\":\"502\"}", "{\"status\":null}" })
        {
            var disposed = 0;
            var sent = 0;
            using var stream = new FragmentedStream(Encoding.UTF8.GetBytes($"event: failure\ndata: {data}\n\n"), () => { disposed++; });
            using var handler = new StubHandler((request, _) =>
            {
                sent++;
                var content = new StreamContent(stream);
                content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
            });
            using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });
            var received = 0;
            var failed = await Assert.ThrowsAsync<FailureException>(async () =>
            {
                await foreach (var entry in client.SubscribeWatch(new Empty()))
                {
                    _ = entry;
                    received++;
                }
            });
            Assert.Equal((ProtocolCode.PayloadUndecodable, FailureScope.Protocol, FailureOrigin.Local, "the HTTP problem holds no Bead failure"), ((ProtocolCode)failed.Code, failed.Scope, failed.Origin, failed.Detail));
            Assert.Equal(0, received);
            Assert.Equal(1, sent);
            Assert.True(disposed > 0);
            Assert.False(stream.CanRead);
        }
    }

    private sealed class Wrapper : DelegatingHandler
    {
        public Wrapper(HttpMessageHandler inner) : base(inner)
        {
        }
    }

    [Fact]
    public async Task Fails_a_request_whose_value_leaves_a_required_field_unset_before_anything_goes_with_the_codec_s_refusal()
    {
        var sent = 0;
        using var handler = new StubHandler((request, _) =>
        {
            Interlocked.Increment(ref sent);

            var response = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StringContent("{}") };

            response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");

            return Task.FromResult(response);
        });
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });

        // * the codec's writer's refusal, its reason, thrown before the request is built (spec 17.2,
        // 17.9.7), the field it leaves unset in its inner exception
        var refused = await Assert.ThrowsAsync<FormatException>(() =>
        {
            return client.Require(new Requiring { Needs = new Needs { Count = 1 } });
        });

        Assert.Equal("a required field unset", refused.Message);
        Assert.Equal("a proto message leaves bead.transcoding.v1.Needs.name unset", refused.InnerException?.Message);
        Assert.Equal(0, sent);
    }

    [Fact]
    public async Task Fails_a_result_that_leaves_a_required_field_unset_with_PAYLOAD_UNDECODABLE()
    {
        using var handler = Stub("{\"count\":1}", ("application/json", HttpStatusCode.OK, null));
        using var client = new TranscodingHttpClient(new Uri("http://localhost"), new HttpCallerOptions { Handler = handler });

        // * its result read by 5.2 whole, step 4 among it
        var failed = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Require(new Requiring());
        });

        Assert.Equal(((ushort)ProtocolCode.PayloadUndecodable, FailureOrigin.Local, "the HTTP payload cannot be decoded"), (failed.Code, failed.Origin, failed.Detail));
        Assert.Equal("a required field unset", Assert.IsType<JsonFormException>(failed.InnerException).Message);
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

    private sealed class FailedReadStream(byte[] bytes, IOException failure) : MemoryStream(bytes)
    {
        public int Reads { get; private set; }

        public Action? BeforeFailure { get; init; }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Reads++;
            if (Reads > 1)
            {
                BeforeFailure?.Invoke();
                return ValueTask.FromException<int>(failure);
            }
            return base.ReadAsync(buffer, cancellationToken);
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
