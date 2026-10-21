using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// The fields <see cref="HttpTransportServer"/> reads and writes: a request's host, its
/// headers and a listen's counts, CORS, and what HTTP refuses of its own.
/// </summary>
public sealed partial class HttpTransportServerTests
{
    [Fact]
    public async Task Answers_a_request_without_a_Host_with_two_or_with_one_that_is_no_host_400_as_HTTP_does_unmarked()
    {
        // a connect with the Host field lines given: none, two in either order, or one that is no host
        var hosts = new[] { "", "Host: bead.test\r\nHost: elsewhere.test\r\n", "Host: elsewhere.test\r\nHost: bead.test\r\n", "Host: bad host\r\n" };

        // its head is the HTTP server's own, whether the server takes every host or names some
        foreach (var options in new[] { new HttpTransportServerOptions(), new HttpTransportServerOptions { Hosts = ["bead.test"] } })
        {
            await Start(options);

            foreach (var host in hosts)
            {
                using var wire = await Wire.Open(_port);

                await wire.Write($"POST /bead HTTP/1.1\r\n{host}Content-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n");

                var (head, body) = await wire.Read();

                Assert.Equal((host, 400, false, 0), (host, head.Status, head.Headers.ContainsKey(HttpTransport.RefusalHeader), body.Length));
            }
        }

        Assert.Empty(_connections);
    }

    [Fact]
    public async Task Reads_any_target_without_throwing_a_header_given_twice_by_its_first_and_HTTP_2_s_authority_as_the_host()
    {
        var options = new HttpTransportServerOptions { Hosts = ["bead.example"] };

        await Start(options);

        async Task<(int Status, string? Reason)> StatusOf(string target, string headers)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"POST {target}\r\n{headers}Content-Length: 0\r\n\r\n");

            var head = await wire.ReadHead();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        var bead = $"Host: bead.example\r\nContent-Type: {HttpTransport.MediaType}\r\n";
        var statuses = new[]
        {
            await StatusOf("/bead HTTP/1.1", $"Host: bead.example\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Type: text/plain\r\n"),
            await StatusOf("//:99999/bead HTTP/1.1", bead),
            await StatusOf("//[ HTTP/1.1", bead),
            await StatusOf("/bead?after=1 HTTP/1.1", bead),
            await StatusOf("/bead HTTP/1.1", $"{bead}Origin: not an origin\r\n"),
            await StatusOf("/bead HTTP/1.1", $"Host: rebound.example\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("/bead HTTP/1.1", $"Host:\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("/bead HTTP/1.1", "Host: bead.example\r\n"),
            // no host at all, where hosts are listed
            await StatusOf("/bead HTTP/1.0", $"Content-Type: {HttpTransport.MediaType}\r\n"),
            // the root, which is not the path: Kestrel takes no request without a target
            await StatusOf("/ HTTP/1.1", bead),
            // a target in absolute-form names the host, its Host ignored but for being one, or none
            // over HTTP/1.0
            await StatusOf("http://bead.example/bead HTTP/1.1", $"Host: rebound.example\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("http://localhost/bead?after=1 HTTP/1.1", $"Host: bad host\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("http://bead.example/bead HTTP/1.0", $"Content-Type: {HttpTransport.MediaType}\r\n"),
            // and HTTP refuses one that names no host, its authority read as it came, a colon with no
            // port and a userinfo among them, which Kestrel's Uri drops; another scheme's, or one
            // beside two Host lines
            await StatusOf("http:///bead HTTP/1.1", bead),
            await StatusOf("http://a%41.test/bead HTTP/1.1", bead),
            await StatusOf("http://127.0.0.1:/bead HTTP/1.1", bead),
            await StatusOf("http://user@bead.example/bead HTTP/1.1", bead),
            await StatusOf("HTTP://bead.example/bead HTTP/1.1", bead),
            await StatusOf("ftp://bead.example/bead HTTP/1.1", bead),
            await StatusOf("http://bead.example/bead HTTP/1.1", $"Host: bead.example\r\n{bead}"),
            await StatusOf("http://bead.example:8443/bead HTTP/1.1", bead),
            await StatusOf("https://bead.example/bead HTTP/1.1", $"Host: rebound.example\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("http://rebound.example/bead HTTP/1.1", bead),
            await StatusOf("http://bead.example HTTP/1.1", bead),
            await StatusOf("http://bead.example?after=1 HTTP/1.1", bead),
            await StatusOf("/bead HTTP/1.1", $"Content-Type: {HttpTransport.MediaType}\r\n"),
        };

        Assert.Equal(
            [
                (201, null),
                (404, HttpRefusals.Path),
                (404, HttpRefusals.Path),
                (201, null),
                (403, HttpRefusals.Origin),
                (403, HttpRefusals.Host),
                (403, HttpRefusals.Host),
                (415, HttpRefusals.Type),
                (403, HttpRefusals.Host),
                (404, HttpRefusals.Path),
                (201, null),
                (201, null),
                (201, null),
                (400, null),
                (400, null),
                (400, null),
                (400, null),
                (400, null),
                (400, null),
                (400, null),
                (201, null),
                (201, null),
                (403, HttpRefusals.Host),
                (404, HttpRefusals.Path),
                (404, HttpRefusals.Path),
                (400, null),
            ],
            statuses);


        foreach (var target in new[] { "http:///", "HTTP://127.0.0.1/" })
        {
            Assert.Equal((400, (string?)null), await StatusOf($"{target} HTTP/1.1", bead));
        }
        // HTTP/2 names its host by its authority, and a browser's origin matches it
        await Start(options with { Certificate = Certificate.Value });

        using var http2 = SecureClient();
        var request = Over(With(PostOf(SecureUrl, (null, null)), ("origin", "https://bead.example:8443")), HttpVersion.Version20);

        request.Headers.Host = "bead.example:8443";

        using var drew = await Fetch(http2, request);

        Assert.Equal((201, HttpVersion.Version20), ((int)drew.StatusCode, drew.Version));
        Assert.Equal(new TlsAnswer(201, null, null), await Http2Of((":authority", "bead.example"), ("host", "rebound.example"), ("content-type", HttpTransport.MediaType)));
        Assert.Equal(new TlsAnswer(403, HttpRefusals.Host, null), await Http2Of((":authority", "rebound.example"), ("host", "bead.example"), ("content-type", HttpTransport.MediaType)));
        Assert.Equal(new TlsAnswer(null, null, 0x1), await Http2Of((":authority", "localhost:"), ("content-type", HttpTransport.MediaType)));

    }

    [Fact]
    public async Task Tells_a_header_given_empty_from_one_absent_an_empty_token_is_malformed_an_empty_origin_or_encoding_refused_an_empty_listen_none()
    {
        await Start();

        var (connectionToken, _) = await Connect();

        async Task<(int Status, string? Reason)> StatusOf(string headers)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"POST /bead HTTP/1.1\r\nHost: {Host}\r\nContent-Type: {HttpTransport.MediaType}\r\n{headers}\r\nContent-Length: 0\r\n\r\n");

            var head = await wire.ReadHead();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        Assert.Equal(
            [(400, HttpRefusals.Malformed), (403, HttpRefusals.Origin), (415, HttpRefusals.Type), (400, HttpRefusals.Malformed)],
            [
                await StatusOf($"{HttpTransport.ConnectionTokenHeader}:"),
                await StatusOf("Origin:"),
                await StatusOf($"{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\nContent-Encoding:"),
                await StatusOf($"{HttpTransport.ListenHeader}:"),
            ]);
    }

    // spec 15.9
    [Fact]
    public async Task Reads_a_listen_s_counts_from_bead_after_and_bead_wait_a_field_given_as_several_lines_joined_and_refuses_400_a_listen_without_bead_after_whatever_its_target_holds()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = Timeout.InfiniteTimeSpan });

        var (connectionToken, connectionHandle) = await Connect(true);
        var envelope = EnvelopeOf(EnvelopeKind.Notification, 1);
        var batches = new List<(string? Sequence, byte[] Body)>();

        async Task<(int Status, string? Reason)> Listened((string Target, string Fields) listen)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"GET {listen.Target} HTTP/1.1\r\nHost: {Host}\r\n{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\n{listen.Fields}\r\n");
            var (head, body) = await wire.Read();

            if (head.Status == 200)
            {
                batches.Add((head.Headers.GetValueOrDefault(HttpTransport.SequenceHeader), body));
            }

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        foreach (var fields in new[]
        {
            $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n",
            $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n{HttpTransport.WaitHeader}: 1\r\n",
            $"{HttpTransport.AfterHeader}: 0, 0\r\n{HttpTransport.WaitHeader}: 0\r\n",
            $"{HttpTransport.AfterHeader}: \r\n",
            $"{HttpTransport.AfterHeader}: 1.0\r\n",
            $"{HttpTransport.AfterHeader}: \"1\"\r\n",
            $"{HttpTransport.AfterHeader}: -1\r\n",
            $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: ?1\r\n",
            $"{HttpTransport.AfterHeader}: 0;X=1\r\n",
            $"{HttpTransport.WaitHeader}: 0\r\n",
        })
        {
            Assert.Equal((400, HttpRefusals.Malformed), await Listened(("/bead", fields)));
        }

        Assert.Equal((400, HttpRefusals.Malformed), await Listened(("/bead?after=0&wait=0", "")));
        Assert.Equal((200, (string?)null), await Listened(("/bead?after=5&x=1", $"{HttpTransport.AfterHeader}: -0;x=1\r\n{HttpTransport.WaitHeader}: 0;y=\"a;b\"\r\n")));

        foreach (var target in new[] { "/bead?after=5&x=1", "/bead?", "/bead" })
        {
            Assert.Equal((200, (string?)null), await Listened((target, $"{HttpTransport.AfterHeader}: 0\r\n" + (target == "/bead" ? "" : $"{HttpTransport.WaitHeader}: 0\r\n"))));
        }

        Assert.Equal(4, batches.Count);
        Assert.All(batches, (batch) =>
        {
            Assert.Equal("1", batch.Sequence);
            Assert.Equal(BatchOf(envelope), batch.Body);
        });
        await Until(() =>
        {
            return _refusals.Count == 11;
        });

        Assert.Equal((204, (string?)null), await Listened(("/bead", $"{HttpTransport.AfterHeader}: 1;x=1\r\n{HttpTransport.WaitHeader}: 0;y=\"a;b\"\r\n")));
        var before = _time.Armed.Count;

        Assert.Equal((204, (string?)null), await Listened(("/bead?", $"{HttpTransport.AfterHeader}: 1\r\n")));
        Assert.Empty(DelaysSince(before));

        before = _time.Armed.Count;
        var held = ListenOf(connectionToken, new() { After = "1", Wait = "500" });

        await Until(() =>
        {
            return Count("listens") == 1;
        });
        Assert.False(held.IsCompleted);
        Assert.Equal([TimeSpan.FromMilliseconds(500)], DelaysSince(before));
        _time.Advance(TimeSpan.FromMilliseconds(500));
        using var ended = await held.WaitAsync(Patience, Cancelled);

        Assert.Equal(204, (int)ended.StatusCode);
        Assert.Empty(_closes);
    }

    [Fact]
    public async Task Answers_a_preflight_from_an_origin_it_names_204_naming_it_the_methods_Authorization_the_fields_it_asks_for_in_its_lines_joined_and_any_other_field_for_7200_seconds_and_tells_no_refusal()
    {
        await Start(new HttpTransportServerOptions { Origins = [Page] });

        // a preflight's answer, whatever method it asks for: its status, its body's length, and the
        // fields of CORS and of the path
        async Task<string> Preflighted((string Method, string? Fields) asked)
        {
            var request = With(With(new HttpRequestMessage(HttpMethod.Options, Url), ("origin", Page)), ("access-control-request-method", asked.Method));
            using var response = await Fetch(asked.Fields is { } fields ? With(request, ("access-control-request-headers", fields)) : request);

            return $"{(int)response.StatusCode} {(await BytesOf(response)).Length} {CorsOf(response)}";
        }

        // what it asks in two field lines, by hand: HttpClient writes a field's values in one
        async Task<string> PreflightedInLines(string method)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"OPTIONS /bead HTTP/1.1\r\nHost: {Host}\r\nOrigin: {Page}\r\nAccess-Control-Request-Method: {method}\r\nAccess-Control-Request-Headers: bead-after\r\nAccess-Control-Request-Headers: bead-wait\r\n\r\n");

            var (head, body) = await wire.Read();

            return $"{head.Status} {body.Length} {CorsOf(head.Headers)}";
        }

        string AnswerOf(string allowed)
        {
            return $"204 0 {Page} | * | none | GET, POST, DELETE | {allowed} | 7200 | no-store nosniff Origin | unmarked";
        }

        // Authorization, then what it asks as it came, its lines joined by ", ", then any other
        Assert.Equal(
            [
                AnswerOf("authorization, bead-listen,content-type,traceparent,sentry-trace,baggage, *"),
                AnswerOf("authorization, bead-after,bead-connection-token,bead-wait, *"),
                AnswerOf("authorization, bead-after, bead-wait, *"),
                AnswerOf("authorization, *"),
            ],
            [
                await Preflighted(("POST", "bead-listen,content-type,traceparent,sentry-trace,baggage")),
                await Preflighted(("GET", "bead-after,bead-connection-token,bead-wait")),
                await PreflightedInLines("GET"),
                await Preflighted(("PUT", null)),
            ]);
        Assert.Empty(_connections);
        Assert.Empty(_refusals);

        // an OPTIONS that is no preflight is still a method refused, and told
        using (var bare = await Fetch(With(new HttpRequestMessage(HttpMethod.Options, Url), ("origin", Page))))
        {
            Assert.Equal((405, HttpRefusals.Method), ((int)bare.StatusCode, HeaderOf(bare, HttpTransport.RefusalHeader)));
        }

        await Until(() =>
        {
            return !_refusals.IsEmpty;
        });
        Assert.Equal([HttpRefusals.Method], _refusals.Select((refusal) =>
        {
            return refusal.Reason;
        }));
    }

    [Fact]
    public async Task Names_an_origin_it_names_on_every_answer_it_writes_to_it_once_that_origin_is_judged_a_batch_and_a_refusal_among_them_and_exposes_every_field()
    {
        await Start(new HttpTransportServerOptions { Origins = [Page] });

        _server.Message += (message, connectionHandle) =>
        {
            if ((EnvelopeKind)message.Bytes.Span[1] == EnvelopeKind.Request && BinaryPrimitives.ReadUInt32BigEndian(message.Bytes.Span[4..]) == 3)
            {
                _ = _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 3), false), connectionHandle);
            }
        };
        var answers = new List<string>();

        async Task<HttpResponseMessage> Named(HttpRequestMessage request)
        {
            var response = await Fetch(With(request, ("origin", Page)));

            answers.Add($"{(int)response.StatusCode} {CorsOf(response)}");

            return response;
        }

        using var drawn = await Named(With(PostOf(null, null), (HttpTransport.ListenHeader, "?1")));
        var token = HeaderOf(drawn, HttpTransport.ConnectionTokenHeader) ?? "";
        var handle = _connections.Last();
        using var delayed = await Named(With(PostOf(token, EnvelopeOf(EnvelopeKind.Request, 1)), ("authorization", Bearer)));

        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 1), false), handle).WaitAsync(Patience, Cancelled);
        Assert.Equal(EnvelopeOf(EnvelopeKind.Result, 1), await BytesOf(delayed));

        foreach (var authorization in new string?[] { null, Bearer })
        {
            var asking = PostOf(token, EnvelopeOf(EnvelopeKind.Request, 3));
            using var response = await Named(authorization is null ? asking : With(asking, ("authorization", authorization)));

            Assert.Equal(EnvelopeOf(EnvelopeKind.Result, 3), await BytesOf(response));
        }

        using var result = await Named(PostOf(token, EnvelopeOf(EnvelopeKind.Result, 5)));
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, 1), false), handle).WaitAsync(Patience, Cancelled);
        using var batch = await Named(ListenRequestOf(token, new() { After = "0", Wait = "0" }));

        Assert.Equal("1", HeaderOf(batch, HttpTransport.SequenceHeader));
        Assert.Equal(BatchOf(EnvelopeOf(EnvelopeKind.Notification, 1)), await BytesOf(batch));
        using var empty = await Named(ListenRequestOf(token, new() { After = "1", Wait = "0" }));

        Assert.Empty(await BytesOf(empty));
        using var bare = await Named(new HttpRequestMessage(HttpMethod.Options, Url));
        using var emptyType = await Named(With(PostOf(token, null), ("content-type", "text/plain")));
        var plain = PostOf(token, EnvelopeOf(EnvelopeKind.Request, 7));

        plain.Content!.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
        using var bodyType = await Named(plain);
        using var method = await Named(new HttpRequestMessage(HttpMethod.Put, Url));
        using var malformedPost = await Named(PostOf("not-a-token", null));
        using var malformedDelete = await Named(RequestOf(HttpMethod.Delete, "not a token"));
        using var deleted = await Named(RequestOf(HttpMethod.Delete, token));
        using var gone = await Named(PostOf(token, null));
        using var goneBody = await Named(PostOf(token, EnvelopeOf(EnvelopeKind.Request, 9)));

        static string Answer(int status, string reason)
        {
            return $"{status} {Page} | * | none | none | none | none | no-store nosniff Origin | {reason}";
        }

        Assert.Equal(
            [
                Answer(201, "unmarked"), Answer(200, "unmarked"), Answer(200, "unmarked"), Answer(200, "unmarked"),
                Answer(204, "unmarked"), Answer(200, "unmarked"), Answer(204, "unmarked"),
                Answer(405, HttpRefusals.Method), Answer(415, HttpRefusals.Type), Answer(415, HttpRefusals.Type),
                Answer(405, HttpRefusals.Method), Answer(400, HttpRefusals.Malformed), Answer(400, HttpRefusals.Malformed),
                Answer(204, "unmarked"), Answer(404, HttpRefusals.ConnectionUnknown), Answer(404, HttpRefusals.ConnectionUnknown),
            ], answers);
        Assert.Equal("GET, POST, DELETE", HeaderOf(bare, "allow"));
        Assert.Equal(4, _messages.Count);
    }

    [Fact]
    public async Task Names_no_origin_to_its_own_to_a_request_with_none_to_one_it_does_not_take_nor_before_the_origin_is_judged_and_varies_every_answer_by_Origin_but_HTTP_s_own_400()
    {
        await Start(new HttpTransportServerOptions { Origins = [Page] });

        var own = $"{Host}:{_port}";

        // a head on a socket of its own: its status, and the fields of CORS and of the path
        async Task<string> Answered(string head)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(head);

            var (answer, _) = await wire.Read();

            return $"{answer.Status} {CorsOf(answer.Headers)}";
        }

        string ConnectWith(string fields)
        {
            return $"POST /bead HTTP/1.1\r\nHost: {own}\r\n{fields}Content-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n";
        }

        static string PreflightOf((string Target, string Host, string Origin) asked)
        {
            return $"OPTIONS {asked.Target} HTTP/1.1\r\nHost: {asked.Host}\r\nOrigin: {asked.Origin}\r\nAccess-Control-Request-Method: POST\r\n\r\n";
        }

        static string Unnamed(int status, string reason)
        {
            return $"{status} none | none | none | none | none | none | no-store nosniff Origin | {reason}";
        }

        const string Bare = "400 none | none | none | none | none | none | none none none | unmarked";

        Assert.Equal(
            [
                Unnamed(201, "unmarked"),
                Unnamed(201, "unmarked"),
                Unnamed(405, HttpRefusals.Method),
                Unnamed(405, HttpRefusals.Method),
                Unnamed(403, HttpRefusals.Origin),
                Unnamed(403, HttpRefusals.Origin),
                Unnamed(403, HttpRefusals.Host),
                Unnamed(404, HttpRefusals.Path),
                Unnamed(400, HttpRefusals.Malformed),
                Bare,
                Bare,
                Bare,
                Bare,
            ],
            [
                // its own origin, and none: a connect, and a preflight, which no browser sends of them
                await Answered(ConnectWith($"Origin: http://{own}\r\n")),
                await Answered(ConnectWith("")),
                await Answered(PreflightOf(("/bead", own, $"http://{own}"))),
                await Answered($"OPTIONS /bead HTTP/1.1\r\nHost: {own}\r\nAccess-Control-Request-Method: POST\r\n\r\n"),

                // an origin it does not take
                await Answered(ConnectWith("Origin: https://elsewhere.test\r\n")),
                await Answered(PreflightOf(("/bead", own, "https://elsewhere.test"))),

                // the page it names, before its origin is judged: by a host it does not take, and at
                // another path
                await Answered(PreflightOf(("/bead", "rebind.example", Page))),
                await Answered(PreflightOf(("/elsewhere", own, Page))),

                // a token that is none, refused of its own, from no page: marked, the path's fields kept
                await Answered($"POST /bead HTTP/1.1\r\nHost: {own}\r\n{HttpTransport.ConnectionTokenHeader}: short\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n"),

                await Answered(ConnectWith($"Origin: {Page}\r\nHost: {own}\r\n")),
                // HTTP's own 400, from the page it names: a control character, an octet past ASCII,
                // and an absolute-form target whose authority is no host
                await Answered(ConnectWith($"Origin: {Page}\r\nX-Other: a\u0007b\r\n")),
                await Answered(ConnectWith($"Origin: {Page}\r\nX-Other: café\r\n")),
                await Answered($"POST http://localhost:/bead HTTP/1.1\r\nHost: {own}\r\nOrigin: {Page}\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n"),
            ]);
        await Until(() => { return _refusals.Count == 7; });
        Assert.Equal([HttpRefusals.Method, HttpRefusals.Method, HttpRefusals.Origin, HttpRefusals.Origin, HttpRefusals.Host, HttpRefusals.Path, HttpRefusals.Malformed], _refusals.Select((refusal) => { return refusal.Reason; }));

    }

    [Fact]
    public async Task Answers_400_unmarked_with_none_of_the_path_s_fields_a_field_holding_a_control_character_other_than_HTAB_or_an_octet_past_ASCII_and_tells_nothing()
    {
        await Start();

        var own = $"{Host}:{_port}";

        // each a connect but for one field, over HTTP/1.1 by hand: the octets as given, each
        // character one octet, or, for the UTF-8 one, its two; its status, its mark, and the fields
        // of the path it carries
        async Task<(int Status, string? Reason, string Stamped)> Answered(string field)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"POST /bead HTTP/1.1\r\nHost: {own}\r\n{field}\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n");

            var (head, _) = await wire.Read();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader), StampedOf(head.Headers));
        }

        var answers = new List<(string Field, (int, string?, string) Answer)>();

        foreach (var field in new[]
        {
            "Origin: http://a.example\u001b[2J",
            "X-Other: a\u0007b",
            "Origin: http://a.example\u007f",
            "Origin: http://caf\u00e9.example",
            "X-Other: caf\u00e9",
            $"X-Other: {Encoding.Latin1.GetString(Encoding.UTF8.GetBytes("caf\u00e9"))}",
        })
        {
            answers.Add((field, await Answered(field)));
        }

        Assert.All(answers, (answer) =>
        {
            Assert.Equal((answer.Field, (400, (string?)null, "")), answer);
        });
        Assert.Empty(_refusals);
        Assert.Empty(_connections);

        // a tab is taken: the origin is refused as it is, with the path's fields, and told
        Assert.Equal((403, HttpRefusals.Origin, "cache-control x-content-type-options vary"), await Answered("Origin: http://a.example\tb"));
        await Until(() =>
        {
            return !_refusals.IsEmpty;
        });

        Assert.Equal(["http://a.example\tb"], _refusals.Select((refusal) =>
        {
            return refusal.Origin;
        }));
    }
}
