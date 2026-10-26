using System.Text;
using Bead.Transport.WebSockets;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Bead.Fuzz;

/// <summary>
/// Raw bytes as an upgrade, judged as the WebSocket transport's server judges a request at its
/// address before its 101 (spec 15.2). The first byte picks what the rest is, modulo the twelve
/// below: the whole head, its lines parted by line feeds, each carriage return that ends one
/// dropped, to its first empty line; or, in RFC 6455 §1.3's handshake to a host the server takes,
/// its request line, or one field's lines in place of that field's, each line feed parting two of
/// them. The rest is one character an octet, in Latin-1, as the TypeScript side reads what Node
/// hands on. What HTTP's parser refuses before the judgement reads it is not judged: a request line
/// not of a token, a target and <c>HTTP/1.0</c> or <c>HTTP/1.1</c>, a field line with no name that
/// is a token before its colon. Each value is trimmed of its spaces and tabs, as Kestrel trims it,
/// and each line is one value of its field, as Kestrel keeps a field's lines. The judgement answers
/// a refusal, or none; the refusal tells of the request, and an upgrade it takes carries its
/// credential: any exception is a finding. The TypeScript side's <c>tools/fuzz/ws-handshake.ts</c>
/// is its twin, slot for slot, with the same server.
/// </summary>
internal sealed class WsHandshakeTarget : IFuzzTarget
{
    // the parts, by the first byte's slot: the head, its request line, then each field by its name
    private const int HeadSlot = 0;
    private const int RequestLineSlot = 1;

    // RFC 6455 §1.3's handshake, to a host the server takes
    private const string RequestLine = "GET / HTTP/1.1";

    private static readonly string[] Fields =
    [
        "host",
        "upgrade",
        "connection",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "origin",
        "authorization",
        "content-length",
        "transfer-encoding",
    ];

    private static readonly int SlotCount = 2 + Fields.Length;

    private static readonly string[] Handshake =
    [
        "host: bead.test",
        "upgrade: websocket",
        "connection: Upgrade",
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version: 13",
    ];

    // the server the upgrade comes to: the host it takes, besides those every server takes, and an
    // origin of another's it takes
    private static readonly WebSocketTransportServerOptions Server = new() { Hosts = ["bead.test"], Origins = ["https://bead.test"] };

    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "ws-handshake";
        }
    }

    // a token's characters besides letters and digits (RFC 9110 §5.6.2)
    private const string TokenMarks = "!#$%&'*+-.^_`|~";

    // helpers

    // whether a string is a token (RFC 9110 §5.6.2)
    private static bool IsToken(string text)
    {
        return text.Length > 0 && text.All((character) =>
        {
            return char.IsAsciiLetterOrDigit(character) || TokenMarks.Contains(character, StringComparison.Ordinal);
        });
    }

    // the head the bytes stand for: its request line and its field lines
    private static (string RequestLine, string[] FieldLines) HeadOf(ReadOnlySpan<byte> data)
    {
        var value = Encoding.Latin1.GetString(data.IsEmpty ? data : data[1..]);
        var slot = (data.IsEmpty ? 0 : data[0]) % SlotCount;

        if (slot == HeadSlot)
        {
            var lines = value.Split('\n').Select((line) =>
            {
                return line.EndsWith('\r') ? line[..^1] : line;
            }).ToArray();
            var end = Array.IndexOf(lines, "", 1);

            return (lines[0], lines[1..(end < 0 ? lines.Length : end)]);
        }

        if (slot == RequestLineSlot)
        {
            return (value, Handshake);
        }

        var name = Fields[slot - 2];
        var kept = Handshake.Where((line) =>
        {
            return !line.StartsWith($"{name}:", StringComparison.Ordinal);
        });

        return (RequestLine, [.. kept, .. value.Split('\n').Select((line) =>
        {
            return $"{name}: {line}";
        })]);
    }

    // the request HTTP's parser hands on for the head, as the judgement reads it; none for one it
    // refuses
    private static HttpRequest? RequestOf((string RequestLine, string[] FieldLines) head)
    {
        var parts = head.RequestLine.Split(' ');

        // the versions HTTP's parser reads
        if (parts.Length != 3 || !IsToken(parts[0]) || parts[1].Length == 0 || parts[2] is not ("HTTP/1.0" or "HTTP/1.1"))
        {
            return null;
        }

        var request = new DefaultHttpContext().Request;

        request.Method = parts[0];
        request.Protocol = parts[2];
        request.HttpContext.Features.Get<IHttpRequestFeature>()!.RawTarget = parts[1];

        foreach (var line in head.FieldLines)
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);

            if (colon <= 0 || !IsToken(line[..colon]))
            {
                return null;
            }

            request.Headers.Append(line[..colon], line[(colon + 1)..].Trim(HostsAndOrigins.FieldWhitespace));
        }

        return request;
    }

    // definition

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        if (RequestOf(HeadOf(data)) is not { } request)
        {
            return;
        }

        var refusal = WebSocketHandshake.RefusalOf(request, Server);

        WebSocketHandshake.ToldOf(request);

        // an upgrade the judgement takes carries its credential, but from a page
        if (refusal is null && request.Headers.Origin.Count == 0)
        {
            HostsAndOrigins.CredentialOf(request.Headers.Authorization);
        }
    }
}
