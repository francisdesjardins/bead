using System.Reflection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

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
        // tokens, in any case, in two field lines; no content; whitespace inside a list; a key of
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
        (101, null, "GET / HTTP/1.1", ["Upgrade: h2c ,\twebsocket"]),
        (101, null, "GET / HTTP/1.1", ["Connection: keep-alive\t, upgrade"]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA=="]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Key: abcdefghijklmnopqrstuw=="]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead, chat"]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Protocol: bead", "Sec-WebSocket-Protocol: chat"]),
        (101, null, "GET / HTTP/1.1", ["Sec-WebSocket-Extensions: ;;;"]),
        (101, null, "GET / HTTP/1.1", ["Origin: http://bead.test"]),
        (101, null, "GET / HTTP/1.1", ["Origin: https://bead.example"]),
        (101, null, "GET / HTTP/1.1", ["Host: BEAD.TEST"]),

        // a host taken by its host alone, the port aside, and those every server takes
        (101, null, "GET / HTTP/1.1", ["Host: bead.test:8080"]),
        (101, null, "GET / HTTP/1.1", ["Host: localhost"]),
        (101, null, "GET / HTTP/1.1", ["Host: 127.0.0.1:8080"]),

        // an absolute-form target names the authority, the Host beside it ignored, as Kestrel ignores
        // its form (RFC 9112 §3.2.2), and the page of its own with it
        (101, null, "GET http://bead.test/ HTTP/1.1", ["Host: elsewhere.test"]),
        (101, null, "GET http://bead.test/ HTTP/1.1", ["Host: bad host"]),
        (101, null, "GET https://bead.test:8443/path?query HTTP/1.1", ["Origin: https://bead.test:8443"]),

        // 0: HTTP's own, unmarked, before the host is judged
        (400, null, "GET / HTTP/1.1", ["Host"]),
        (400, null, "GET / HTTP/1.1", ["Host: bead.test", "Host: elsewhere.test"]),
        (400, null, "GET / HTTP/1.1", ["Host: bad host"]),
        (400, null, "GET / HTTP/1.1", ["Host: bead.test:80x"]),
        (400, null, "GET / HTTP/1.1", ["Host: [::1%25eth0]"]),
        (400, null, "POST / HTTP/1.1", ["Host: elsewhere.test", "Host: bead.test"]),
        (400, null, "GET / HTTP/1.0", ["Host: bead.test", "Host: bead.test"]),
        (400, null, "GET / HTTP/1.1", ["Host: a%41.test"]),
        (400, null, "GET / HTTP/1.1", ["Host: a*b.test"]),
        (400, null, "GET / HTTP/1.1", ["Host: a;b=c"]),
        (400, null, "GET / HTTP/1.1", ["Host: [v1.bead]"]),
        (400, null, "GET / HTTP/1.1", ["Host: localhost:"]),
        (400, null, "GET / HTTP/1.1", ["Host: [::1]:"]),
        (400, null, "GET http://bead.test:/ HTTP/1.1", []),
        (400, null, "GET http://user@bead.test/ HTTP/1.1", []),
        (400, null, "GET http://a*b.test/ HTTP/1.1", []),
        (400, null, "GET http://bead.test/ HTTP/1.1", ["Host"]),
        (400, null, "POST http://bead.test/ HTTP/1.1", ["Host: bead.test", "Host: bead.test"]),

        // 1: a host not taken, whatever else the request holds; none, where HTTP asks none
        (403, WebSocketRefusals.Host, "GET / HTTP/1.1", ["Host: elsewhere.test"]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.0", ["Host"]),
        (403, WebSocketRefusals.Host, "GET / HTTP/1.1", ["Host: localhost.example"]),
        (403, WebSocketRefusals.Host, "GET http://elsewhere.test/ HTTP/1.1", []),
        (403, WebSocketRefusals.Host, "GET http://elsewhere.test/ HTTP/1.0", ["Host"]),
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
        (426, WebSocketRefusals.Upgrade, "GET http://bead.test/ HTTP/1.0", ["Host"]),

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
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Content-Length: abc"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Content-Length: 0", "Content-Length: 5"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Transfer-Encoding: chunked"]),
        (400, WebSocketRefusals.Malformed, "GET / HTTP/1.1", ["Sec-WebSocket-Key: dGVzdA==", "Origin: https://elsewhere.test"]),

        // 6: an origin neither its own nor among those it takes, last
        (403, WebSocketRefusals.Origin, "GET / HTTP/1.1", ["Origin: https://elsewhere.test"]),
        (403, WebSocketRefusals.Origin, "GET / HTTP/1.1", ["Origin: http://bead.test:80"]),
        (403, WebSocketRefusals.Origin, "GET / HTTP/1.1", ["Origin: null"]),
        (403, WebSocketRefusals.Origin, "GET / HTTP/1.1", ["Origin: http://bead.test", "Origin: http://bead.test"]),
        (403, WebSocketRefusals.Origin, "GET http://bead.test/ HTTP/1.1", ["Host: elsewhere.test", "Origin: http://elsewhere.test"]),
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
        request.HttpContext.Features.Get<IHttpRequestFeature>()!.RawTarget = parts[1];

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
    public void Names_each_refusal_of_its_own_as_spec_15_6_marks_it()
    {
        var named = typeof(WebSocketRefusals)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .ToDictionary((field) =>
            {
                return field.Name;
            }, (field) =>
            {
                return (string?)field.GetValue(null);
            });

        Assert.Equal(new Dictionary<string, string?>
        {
            ["Busy"] = "busy",
            ["Host"] = "host-refused",
            ["Malformed"] = "malformed",
            ["Method"] = "method-refused",
            ["Origin"] = "origin-refused",
            ["Upgrade"] = "upgrade-required",
            ["Version"] = "version-refused",
        }, named);
    }

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
    public void Refuses_first_unmarked_a_field_holding_a_control_character_but_a_tab_or_an_octet_past_ASCII_or_whose_value_starts_or_ends_with_a_space_or_a_tab_whatever_else_the_request_holds()
    {
        // in Origin, in a field it never reads, in its Host; from a host it does not take, under
        // another method, with no upgrade
        (string Start, string[] Fields)[] requests =
        [
            ("GET / HTTP/1.1", ["Origin: http://café.example"]),
            ("GET / HTTP/1.1", ["X-Other: café"]),
            ("GET / HTTP/1.1", ["X-Other: a\u0007b"]),
            ("GET / HTTP/1.1", ["X-Other: a\u007fb"]),
            ("GET / HTTP/1.1", ["Host: béad.test", "Origin: https://elsewhere.test"]),
            ("POST / HTTP/1.1", ["X-Other: café", "Upgrade"]),

            // padded, which HTTP/1.1's parser strips before any request reaches the transport
            ("GET / HTTP/1.1", ["Sec-WebSocket-Key:  dGhlIHNhbXBsZSBub25jZQ==\t"]),
            ("GET / HTTP/1.1", ["Sec-WebSocket-Version: \t13 "]),
        ];

        Assert.All(requests, (request) =>
        {
            Assert.Equal((400, (string?)null), AnswerOf(request, Options));
        });

        // a tab is taken, and the origin judged as any other
        Assert.Equal((403, WebSocketRefusals.Origin), AnswerOf(("GET / HTTP/1.1", ["Origin: http://a.example\tb"]), Options));
    }

    [Fact]
    public void Tells_a_request_s_authority_its_port_included_and_its_Origin_its_lines_joined_by_a_comma_and_a_space_as_the_judgement_reads_them_or_none()
    {
        // an empty Host the wire's cases hold, a request no socket carries dropping an empty field
        (string Start, string[] Fields)[] requests =
        [
            ("GET / HTTP/1.1", ["Origin: http://rebind.example:8080", "Origin: null"]),
            ("GET / HTTP/1.1", ["Host: rebind.example:8080"]),
            ("GET http://elsewhere.test:81/ HTTP/1.1", []),
            ("GET / HTTP/1.0", ["Host"]),
            ("GET / HTTP/1.1", ["Host"]),
        ];
        (string?, string?)[] told =
        [
            ("bead.test", "http://rebind.example:8080, null"),
            ("rebind.example:8080", null),
            ("elsewhere.test:81", null),
            (null, null),

            // what HTTP refuses of its own, which nothing tells
            (null, null),
        ];

        Assert.Equal(told, requests.Select((request) =>
        {
            return WebSocketHandshake.ToldOf(RequestOf(request.Start, request.Fields));
        }));
    }

    // spec 15.12
    [Fact]
    public void Takes_whatever_its_hosts_the_hosts_every_server_takes_and_any_page_of_its_own_by_a_host_it_takes_by_name_and_refuses_403_any_other_host_an_empty_one_and_none_before_its_method_and_its_upgrade()
    {
        WebSocketTransportServerOptions[] every = [new(), new() { Hosts = [] }, new() { Hosts = ["bead.test"] }];

        Assert.All(every, (options) =>
        {
            // those every server takes, on any port, and a page of its own on them
            Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: localhost:8080"]), options));
            Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: A.LocalHost"]), options));
            Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: 127.0.0.1:8080"]), options));
            Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: [::1]"]), options));
            Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: localhost:8080", "Origin: http://localhost:8080"]), options));
            Assert.Equal((403, WebSocketRefusals.Origin), AnswerOf(("GET / HTTP/1.1", ["Host: localhost:8080", "Origin: https://bead.example"]), options));

            // any other, an empty one and none, whatever the method and the upgrade, HTTP/2's among them;
            // an empty Host the wire's cases hold, a request no socket carries dropping an empty field
            Assert.Equal((403, WebSocketRefusals.Host), AnswerOf(("GET / HTTP/1.1", ["Host: elsewhere.test", "Origin: http://elsewhere.test"]), options));
            Assert.Equal((403, WebSocketRefusals.Host), AnswerOf(("POST / HTTP/1.1", ["Host: elsewhere.test", "Upgrade", "Connection"]), options));
            Assert.Equal((403, WebSocketRefusals.Host), AnswerOf(("GET / HTTP/1.1", ["Host: localhost."]), options));
            Assert.Equal((403, WebSocketRefusals.Host), AnswerOf(("GET / HTTP/1.1", ["Host: :8080"]), options));
            Assert.Equal((403, WebSocketRefusals.Host), AnswerOf(("GET / HTTP/1.0", ["Host"]), options));
            Assert.Equal((403, WebSocketRefusals.Host), AnswerOf(("POST / HTTP/2", ["Host"]), options));

            // never a Host HTTP refuses
            Assert.Equal((400, null), AnswerOf(("GET / HTTP/1.1", ["Host"]), options));
            Assert.Equal((400, null), AnswerOf(("GET / HTTP/1.1", ["Host: [::1"]), options));
        });

        // * takes every host, an empty one and none, and judges the rest as it would; a page of its
        // own by a host every server takes, and none by a host * alone takes: the page that rebinds
        // its name
        var any = new WebSocketTransportServerOptions { Hosts = ["*"] };

        Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: rebind.example:8080"]), any));
        Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: a.localhost:8080", "Origin: http://a.localhost:8080"]), any));
        Assert.Equal((403, WebSocketRefusals.Origin), AnswerOf(("GET / HTTP/1.1", ["Host: rebind.example:8080", "Origin: http://rebind.example:8080"]), any));
        Assert.Equal((403, WebSocketRefusals.Origin), AnswerOf(("GET / HTTP/1.1", ["Host: xn---bad-cpa.test", "Origin: http://xn---bad-cpa.test"]), any));
        Assert.Equal((101, null), AnswerOf(("GET / HTTP/1.1", ["Host: :8080"]), any));
        Assert.Equal((403, WebSocketRefusals.Origin), AnswerOf(("GET / HTTP/1.1", ["Host: elsewhere.test", "Origin: https://bead.example"]), any));
        Assert.Equal((426, WebSocketRefusals.Upgrade), AnswerOf(("GET / HTTP/1.0", ["Host"]), any));
        Assert.Equal((405, WebSocketRefusals.Method), AnswerOf(("POST / HTTP/2", ["Host"]), any));
        Assert.Equal((400, null), AnswerOf(("GET / HTTP/1.1", ["Host"]), any));
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
