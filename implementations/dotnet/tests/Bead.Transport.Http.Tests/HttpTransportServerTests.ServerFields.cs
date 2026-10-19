using System.Buffers.Binary;
using System.Globalization;
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
            ],
            statuses);

        // HTTP/2 names its host by its authority, and a browser's origin matches it
        await Start(options with { Certificate = Certificate.Value });

        using var http2 = SecureClient();
        var request = Over(With(PostOf(SecureUrl, (null, null)), ("origin", "https://bead.example:8443")), HttpVersion.Version20);

        request.Headers.Host = "bead.example:8443";

        using var drew = await Fetch(http2, request);

        Assert.Equal((201, HttpVersion.Version20), ((int)drew.StatusCode, drew.Version));
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
        await Start();

        var (connectionToken, connectionHandle) = await Connect(true);
        var envelope = EnvelopeOf(EnvelopeKind.Notification, 1);

        // a listen by hand, its target and its fields as given: its status and its mark
        async Task<(int Status, string? Reason)> Listened((string Target, string Fields) listen)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"GET {listen.Target} HTTP/1.1\r\nHost: {Host}\r\n{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\n{listen.Fields}\r\n");

            var (head, _) = await wire.Read();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [
                // its lines joined, as RFC 9110 §5.3 combines them, parse as no Item, alike or not
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                // no bead-after, whatever its target holds: the query is never read
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                // with it, whatever its query, a bead-wait left out 0: brought back at once
                (200, null),
                (200, null),
                (200, null),
            ],
            [
                await Listened(("/bead", $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead", $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n{HttpTransport.WaitHeader}: 1\r\n")),
                await Listened(("/bead", $"{HttpTransport.AfterHeader}: 0, 0\r\n{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead?after=0&wait=0", "")),
                await Listened(("/bead", $"{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead?after=5&x=1", $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead?", $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead", $"{HttpTransport.AfterHeader}: 0\r\n")),
            ]);
        await Until(() =>
        {
            return _refusals.Count == 5;
        });

        // its parameters ignored (RFC 9651 §2.3): what it acknowledges goes, and nothing is left
        Assert.Equal((204, null), await Listened(("/bead", $"{HttpTransport.AfterHeader}: 1;x=1\r\n{HttpTransport.WaitHeader}: 0;y=\"a;b\"\r\n")));
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

        // each request answered by its result, as a router would
        _server.Message += (message, connectionHandle) =>
        {
            if ((EnvelopeKind)message.Bytes.Span[1] == EnvelopeKind.Request)
            {
                _ = _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, BinaryPrimitives.ReadUInt32BigEndian(message.Bytes.Span[4..])), false), connectionHandle);
            }
        };

        // a request from the page: its status, and the fields of CORS and of the path
        async Task<string> Answered(HttpRequestMessage request)
        {
            using var response = await Fetch(With(request, ("origin", Page)));

            await BytesOf(response);

            return $"{(int)response.StatusCode} {CorsOf(response)}";
        }

        HttpRequestMessage ListenAfter(string connectionToken, int after)
        {
            return ListenRequestOf(connectionToken, new() { After = after.ToString(CultureInfo.InvariantCulture), Wait = "0" });
        }

        using var drawn = await Fetch(With(With(PostOf(null, null), (HttpTransport.ListenHeader, "?1")), ("origin", Page)));
        var connectionToken = HeaderOf(drawn, HttpTransport.ConnectionTokenHeader) ?? "";

        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, 1), false), _connections.Last()).WaitAsync(Patience, Cancelled);

        var plain = PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 7));

        plain.Content!.Headers.ContentType = new MediaTypeHeaderValue("text/plain");

        // a connect, a request with its Authorization answered, an envelope handed on, a batch and
        // a listen that brought nothing, a type, a method and a token refused, a DELETE, and a
        // connection gone
        string[] answers =
        [
            $"{(int)drawn.StatusCode} {CorsOf(drawn)}",
            await Answered(With(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 3)), ("authorization", Bearer))),
            await Answered(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Result, 5))),
            await Answered(ListenAfter(connectionToken, 0)),
            await Answered(ListenAfter(connectionToken, 1)),
            await Answered(plain),
            await Answered(new HttpRequestMessage(HttpMethod.Put, Url)),
            await Answered(RequestOf(HttpMethod.Delete, "not a token")),
            await Answered(RequestOf(HttpMethod.Delete, connectionToken)),
            await Answered(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 9))),
        ];

        // each naming the page, every field exposed, no credential allowed
        string Named(int status, string reason)
        {
            return $"{status} {Page} | * | none | none | none | none | no-store nosniff Origin | {reason}";
        }

        Assert.Equal(
            [
                Named(201, "unmarked"),
                Named(200, "unmarked"),
                Named(204, "unmarked"),
                Named(200, "unmarked"),
                Named(204, "unmarked"),
                Named(415, HttpRefusals.Type),
                Named(405, HttpRefusals.Method),
                Named(400, HttpRefusals.Malformed),
                Named(204, "unmarked"),
                Named(404, HttpRefusals.ConnectionUnknown),
            ],
            answers);
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

                // HTTP's own 400, from the page it names: a control character, an octet past ASCII,
                // and an absolute-form target whose authority is no host
                await Answered(ConnectWith($"Origin: {Page}\r\nX-Other: a\u0007b\r\n")),
                await Answered(ConnectWith($"Origin: {Page}\r\nX-Other: café\r\n")),
                await Answered($"POST http://localhost:/bead HTTP/1.1\r\nHost: {own}\r\nOrigin: {Page}\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n"),
            ]);
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
