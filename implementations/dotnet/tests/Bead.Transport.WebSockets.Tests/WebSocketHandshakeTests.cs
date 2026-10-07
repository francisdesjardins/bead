using Microsoft.AspNetCore.Http;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// <see cref="WebSocketHandshake"/>: what a WebSocket server answers a request at its address, step
/// by step and in the order between the steps, as spec 15.2 states it, over requests no socket
/// carries.
/// </summary>
public sealed class WebSocketHandshakeTests
{
    // constants

    // RFC 6455 §1.3's handshake, at a host the server takes
    private static readonly string[] Handshake =
    [
        "Host: bead.test",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
    ];

    private static readonly WebSocketTransportServerOptions Options = new() { Hosts = ["bead.test"], Origins = ["https://bead.example"] };

    // what each request is answered: its status and its mark, a 101 and none when it upgrades
    private static readonly (int Status, string? Refusal, string Start, string[] Fields)[] Answers =
    [
        // taken: an Upgrade in any case, in a list, in two field lines; a Connection among other
        // tokens, in any case, in two field lines; no content; whitespace around a value; a key of
        // lower-case base64; a list of subprotocols; an origin of its own or among those it takes
        (101, null, "GET / HTTP/1.1", []),
        (101, null, "GET /any/path?query HTTP/1.1", []),
        (101, null, "GET / HTTP/1.1", ["Upgrade: WebSocket"]),
        (101, null, "GET / HTTP/1.1", ["Upgrade: h2c, websocket"]),
        (101, null, "GET / HTTP/1.1", ["Upgrade: h2c", "Upgrade: websocket"]),
        (101, null, "GET / HTTP/1.1", ["Connection: keep-alive, upgrade"]),
        (101, null, "GET / HTTP/1.1", ["Connection: UPGRADE"]),
        (101, null, "GET / HTTP/1.1", ["Connection: keep-alive", "Connection: upgrade"]),
        (101, null, "GET / HTTP/1.1", ["Content-Length: 0"]),
        (101, null, "GET / HTTP/1.1", ["Content-Length: 00"]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Key:  dGhlIHNhbXBsZSBub25jZQ==\t", "Sec-WebSocket-Version: \t13 "]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA=="]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Key: abcdefghijklmnopqrstuw=="]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead, chat"]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead", "Sec-WebSocket-Protocol: chat"]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Extensions: ;;;"]),
        (101, null, "GET / HTTP/1.1", ["Origin: http://bead.test"]),
        (101, null, "GET / HTTP/1.1", ["Origin: https://bead.example"]),
        (101, null, "GET / HTTP/1.1", ["Host: BEAD.TEST"]),

        // 0: HTTP's own, unmarked, before the host is judged
        (400, null, "GET / HTTP/1.1", ["Host"]),
        (400, null, "GET / HTTP/1.1", ["Host: bead.test", "Host: elsewhere.test"]),
        (400, null, "GET / HTTP/1.1", ["Host: bad host"]),
        (400, null, "GET / HTTP/1.1", ["Host: bead.test:80x"]),
        (400, null, "GET / HTTP/1.1", ["Host: [::1%25eth0]"]),
        (400, null, "POST / HTTP/1.1", ["Host: elsewhere.test", "Host: bead.test"]),
        (400, null, "GET / HTTP/1.0", ["Host: bead.test", "Host: bead.test"]),

        // 1: a host not taken, whatever else the request holds; none, where HTTP asks none
        (403, WebSocketRefusals.Host, "GET / HTTP/1.1", ["Host: elsewhere.test"]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.0", ["Host"]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.1", ["Host: bead.test:8080"]),
        (403, WebSocketRefusals.Host, "POST / HTTP/1.1", ["Host: elsewhere.test"]),
        (403, WebSocketRefusals.Host, "CONNECT elsewhere.test:80 HTTP/1.1", ["Host: elsewhere.test:80"]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.1", ["Host: elsewhere.test", "Upgrade", "Connection"]),
        (403, WebSocketRefusals.Host, "HEAD / HTTP/1.1", ["Host: elsewhere.test"]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.0", ["Host: elsewhere.test"]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.1", ["Host: elsewhere.test", "Sec-WebSocket-Version: 8"]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.1", ["Host: elsewhere.test", "Sec-WebSocket-Key: dGVzdA=="]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.1", ["Host: elsewhere.test", "Origin: https://elsewhere.test"]),

        // 2: a method but GET and HEAD, before the upgrade is read
        (405, WebSocketRefusals.Method, "POST / HTTP/1.1", []),
        (405, WebSocketRefusals.Method, "PUT / HTTP/1.1", []),
        (405, WebSocketRefusals.Method, "OPTIONS / HTTP/1.1", []),
        (405, WebSocketRefusals.Method, "DELETE / HTTP/1.1", ["Upgrade", "Connection"]),
        (405, WebSocketRefusals.Method, "CONNECT bead.test:80 HTTP/1.1", []),
        (405, WebSocketRefusals.Method, "POST / HTTP/1.1", ["Sec-WebSocket-Version: 8"]),
        (405, WebSocketRefusals.Method, "POST / HTTP/1.0", []),
        (405, WebSocketRefusals.Method, "get / HTTP/1.1", []),
        (405, WebSocketRefusals.Method, "TRACE / HTTP/1.1", []),

        // 3: no WebSocket asked, before the version is read
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Upgrade"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Upgrade: h2c"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Upgrade: websocket/13"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Upgrade: web socket"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Connection"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Connection: keep-alive"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Connection: upgraded"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Upgrade: h2c", "Sec-WebSocket-Version: 8"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.1", ["Upgrade", "Sec-WebSocket-Key: dGVzdA=="]),
        (426, WebSocketRefusals.Upgrade, "HEAD / HTTP/1.1", []),
        (426, WebSocketRefusals.Upgrade, "HEAD / HTTP/1.1", ["Sec-WebSocket-Version: 8"]),
        (426, WebSocketRefusals.Upgrade, "HEAD / HTTP/1.1", ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"]),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.0", []),
        (426, WebSocketRefusals.Upgrade, "GET / HTTP/1.0", ["Upgrade: websocket, h2c"]),

        // 4: a version but 13, or none, before the key and the origin are judged; two field lines
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 8"]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 14"]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version"]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: "]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 013"]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 13, 8"]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 8, 13"]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 8", "Sec-WebSocket-Key: dGVzdA=="]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 8", "Origin: https://elsewhere.test"]),
        (426, WebSocketRefusals.Version, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 8", "Content-Length: 5"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 13", "Sec-WebSocket-Version: 13"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Version: 8", "Sec-WebSocket-Version: 13"]),

        // 5: the rest of version 13's form, before the origin is judged
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: "]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: not a key at all!!!!!=="]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: dGVzdA=="]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZSE="]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAAA="]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: dGhlIHNhbXBs ZSBub25jZQ=="]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: a b"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead, bead"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead", "Sec-WebSocket-Protocol: bead"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead/1"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead,,chat"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead,"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Content-Length: 5"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Transfer-Encoding: chunked"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: dGVzdA==", "Origin: https://elsewhere.test"]),

        // 6: an origin neither its own nor among those it takes, last
        (403, WebSocketRefusals.Origin, "GET / HTTP/1.1", ["Origin: https://elsewhere.test"]),
        (403, WebSocketRefusals.Origin, "GET / HTTP/1.1", ["Origin: http://bead.test:80"]),
        (403, WebSocketRefusals.Origin, "GET / HTTP/1.1", ["Origin: null"]),
        (403, WebSocketRefusals.Origin, "GET / HTTP/1.1", ["Origin: http://bead.test", "Origin: http://bead.test"]),
    ];

    // helpers

    // RFC 6455 §1.3's handshake under the start line given: each field line given in place of those
    // of its name, which a name alone leaves out, each line one value of its field, as Kestrel keeps
    // a field's lines
    private static HttpRequest RequestOf(string start, string[] fields)
    {
        var parts = start.Split(' ');
        var request = new DefaultHttpContext().Request;
        var named = fields.Select(NameOf).ToHashSet(StringComparer.OrdinalIgnoreCase);

        request.Method = parts[0];
        request.Protocol = parts[2];

        foreach (var line in Handshake.Where((line) =>
        {
            return !named.Contains(NameOf(line));
        }).Concat(fields.Where((field) =>
        {
            return field.Contains(':', StringComparison.Ordinal);
        })))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);

            request.Headers.Append(line[..colon], line[(colon + 1)..].TrimStart(' '));
        }

        return request;
    }

    // a field line's name, or the name given alone
    private static string NameOf(string field)
    {
        var colon = field.IndexOf(':', StringComparison.Ordinal);

        return colon < 0 ? field : field[..colon];
    }

    // the status and the mark a request is answered with: 101 and none when it upgrades
    private static (int Status, string? Refusal) AnswerOf((string Start, string[] Fields) request, WebSocketTransportServerOptions options)
    {
        var refusal = WebSocketHandshake.RefusalOf(RequestOf(request.Start, request.Fields), options);

        return refusal is null ? (101, null) : (refusal.Status, refusal.Refusal);
    }

    // definition

    [Fact]
    public void Answers_each_request_by_the_first_step_that_applies_in_the_order_spec_15_2_states()
    {
        Assert.All(Answers, (answer) =>
        {
            var asked = $"{answer.Start} | {string.Join(" | ", answer.Fields)}";

            var (status, refusal) = AnswerOf((answer.Start, answer.Fields), Options);

            Assert.Equal((asked, answer.Status, answer.Refusal), (asked, status, refusal));
        });
    }

    [Fact]
    public void Takes_every_host_and_any_origin_s_page_of_its_own_when_given_no_hosts_but_never_a_Host_HTTP_refuses()
    {
        var none = new WebSocketTransportServerOptions();

        Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: elsewhere.test"]), none));
        Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: xn---bad-cpa.test", "Origin: http://xn---bad-cpa.test"]), none));
        Assert.Equal((403, WebSocketRefusals.Origin), AnswerOf(("GET / HTTP/1.1", ["Host: elsewhere.test", "Origin: https://bead.example"]), none));
        Assert.Equal((400, null), AnswerOf(("GET / HTTP/1.1", ["Host"]), none));
        Assert.Equal((426, WebSocketRefusals.Upgrade), AnswerOf(("GET / HTTP/1.0", ["Host"]), none));
        Assert.Equal((400, null), AnswerOf(("GET / HTTP/1.1", ["Host: [::1"]), none));

        // HTTP/2's authority is its server's
        Assert.Equal((405, WebSocketRefusals.Method), AnswerOf(("POST / HTTP/2", ["Host"]), none));
    }

    [Fact]
    public void Gives_each_refusal_its_fields_never_stored_nor_sniffed_its_connection_closed_a_426_naming_websocket_and_upgrade()
    {
        // the fields of a refusal by its status and its mark, each in name order
        static string FieldsOf((string Start, string[] Fields) request)
        {
            var refusal = WebSocketHandshake.RefusalOf(RequestOf(request.Start, request.Fields), Options);

            Assert.NotNull(refusal);

            return string.Join("; ", refusal.Fields.OrderBy((field) =>
            {
                return field.Key;
            }, StringComparer.Ordinal).Select((field) =>
            {
                return $"{field.Key}: {field.Value}";
            }));
        }

        const string Refused = "cache-control: no-store; connection: close; x-content-type-options: nosniff";

        Assert.Equal("connection: close", FieldsOf(("GET / HTTP/1.1", ["Host"])));
        Assert.Equal(Refused, FieldsOf(("GET / HTTP/1.1", ["Host: elsewhere.test"])));
        Assert.Equal($"allow: GET, HEAD; {Refused}", FieldsOf(("POST / HTTP/1.1", [])));
        Assert.Equal(
            "cache-control: no-store; connection: upgrade, close; upgrade: websocket; x-content-type-options: nosniff",
            FieldsOf(("HEAD / HTTP/1.1", [])));
        Assert.Equal(
            "cache-control: no-store; connection: upgrade, close; sec-websocket-version: 13; upgrade: websocket; x-content-type-options: nosniff",
            FieldsOf(("GET / HTTP/1.1", ["Sec-WebSocket-Version: 8"])));
        Assert.Equal(Refused, FieldsOf(("GET / HTTP/1.1", ["Sec-WebSocket-Key: dGVzdA=="])));
        Assert.Equal(Refused, FieldsOf(("GET / HTTP/1.1", ["Origin: https://elsewhere.test"])));
        Assert.Equal(
            (400, WebSocketRefusals.Malformed, Refused),
            (WebSocketHandshake.Malformed.Status, WebSocketHandshake.Malformed.Refusal, FieldsOf(("GET / HTTP/1.1", ["Content-Length: 5"]))));
        Assert.Equal(
            ("host-refused", "malformed", "method-refused", "origin-refused", "upgrade-required", "version-refused"),
            (WebSocketRefusals.Host, WebSocketRefusals.Malformed, WebSocketRefusals.Method, WebSocketRefusals.Origin, WebSocketRefusals.Upgrade, WebSocketRefusals.Version));
    }
}
