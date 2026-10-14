using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Primitives;

namespace Bead.Transport.WebSockets;

/// <summary>
/// The reasons each refusal of a WebSocket server's own is marked with, in its
/// <c>bead-refusal</c> field (spec 15.2, 15.6).
/// </summary>
public static class WebSocketRefusals
{
    /// <summary>An upgrade the server would take once its stop began: 503, with its <c>Retry-After</c>.</summary>
    public const string Busy = "busy";

    /// <summary>A host the server does not take, whatever the request: 403.</summary>
    public const string Host = HostsAndOrigins.HostRefusal;

    /// <summary>
    /// An upgrade of version 13 whose key, version, subprotocols or content are not a handshake's: 400.
    /// </summary>
    public const string Malformed = "malformed";

    /// <summary>Neither GET nor HEAD: 405.</summary>
    public const string Method = "method-refused";

    /// <summary>An upgrade from an origin neither the server's own nor among those it takes: 403.</summary>
    public const string Origin = HostsAndOrigins.OriginRefusal;

    /// <summary>A request that asks no WebSocket: 426.</summary>
    public const string Upgrade = "upgrade-required";

    /// <summary>An upgrade of a version but 13, or of none: 426.</summary>
    public const string Version = "version-refused";
}

/// <summary>
/// What a WebSocket server answers a request it does not upgrade: its status, its mark, none for a
/// refusal HTTP makes of its own, and its fields by their names in lower case, the mark, its date
/// and its length aside.
/// </summary>
internal sealed record HandshakeRefusal(int Status, string? Refusal, IReadOnlyDictionary<string, string> Fields);

/// <summary>
/// How a WebSocket server judges a request at its address, in the order spec 15.2 states: the first
/// that applies answers, and the rest is not read.
/// </summary>
internal static class WebSocketHandshake
{
    // constants

    // the one version of the protocol the server speaks (RFC 6455 §4.2.2)
    private const string Version = "13";

    // a token's characters besides letters and digits (RFC 9110 §5.6.2)
    private const string TokenMarks = "!#$%&'*+-.^_`|~";

    // the fields of every refusal of the transport's own: never stored nor sniffed, and the connection
    // goes with it
    private static readonly Dictionary<string, string> Refused = new()
    {
        ["cache-control"] = "no-store",
        ["x-content-type-options"] = "nosniff",
        ["connection"] = "close",
    };

    /// <summary>
    /// What the transport answers a request Kestrel cannot upgrade that the judgement took, and a
    /// version 13 upgrade the judgement refuses for its form: 400, malformed.
    /// </summary>
    public static readonly HandshakeRefusal Malformed = new(StatusCodes.Status400BadRequest, WebSocketRefusals.Malformed, Refused);

    /// <summary>
    /// What the transport answers an upgrade it would take once its stop began: 503, busy, to come
    /// back in a second (RFC 9110 §15.6.4, §10.2.3).
    /// </summary>
    public static readonly HandshakeRefusal Busy = new(StatusCodes.Status503ServiceUnavailable, WebSocketRefusals.Busy, new Dictionary<string, string>(Refused)
    {
        ["retry-after"] = "1",
    });

    // a refusal HTTP makes of its own, unmarked (RFC 9112 §3.2), of a malformed field among them
    // (RFC 9110 §5.5)
    private static readonly HandshakeRefusal BadRequest = new(StatusCodes.Status400BadRequest, null, new Dictionary<string, string> { ["connection"] = "close" });

    private static readonly HandshakeRefusal HostRefused = new(StatusCodes.Status403Forbidden, WebSocketRefusals.Host, Refused);

    private static readonly HandshakeRefusal OriginRefused = new(StatusCodes.Status403Forbidden, WebSocketRefusals.Origin, Refused);

    // the address serves GET and HEAD alone (RFC 9110 §15.5.6)
    private static readonly HandshakeRefusal MethodRefused = new(StatusCodes.Status405MethodNotAllowed, WebSocketRefusals.Method, new Dictionary<string, string>(Refused)
    {
        ["allow"] = "GET, HEAD",
    });

    // a 426 names the protocol to upgrade to, and a sender of Upgrade names it in its Connection
    // (RFC 9110 §15.5.22, §7.8)
    private static readonly HandshakeRefusal UpgradeRequired = new(StatusCodes.Status426UpgradeRequired, WebSocketRefusals.Upgrade, new Dictionary<string, string>(Refused)
    {
        ["connection"] = "upgrade, close",
        ["upgrade"] = "websocket",
    });

    // and the one version the server speaks (RFC 6455 §4.2.2)
    private static readonly HandshakeRefusal VersionRefused = new(StatusCodes.Status426UpgradeRequired, WebSocketRefusals.Version, new Dictionary<string, string>(Refused)
    {
        ["connection"] = "upgrade, close",
        ["upgrade"] = "websocket",
        ["sec-websocket-version"] = Version,
    });

    // helpers

    // a field's value without the whitespace around it (RFC 9110 §5.5)
    private static string ValueOf(string? value)
    {
        return (value ?? "").Trim(HostsAndOrigins.FieldWhitespace);
    }

    // the elements of a list field across its field lines, each without the whitespace around it
    // (RFC 9110 §5.6.1), the empty ones kept
    private static IEnumerable<string> ElementsOf(StringValues lines)
    {
        return lines.SelectMany((line) =>
        {
            return (line ?? "").Split(',');
        }).Select(ValueOf);
    }

    // whether a list field names a token, in any ASCII case
    private static bool Names(StringValues lines, string token)
    {
        return ElementsOf(lines).Any((element) =>
        {
            return HostsAndOrigins.IsAsciiEqual(element, token);
        });
    }

    // whether a string is a token (RFC 9110 §5.6.2)
    private static bool IsToken(string text)
    {
        return text.Length > 0 && text.All((character) =>
        {
            return char.IsAsciiLetterOrDigit(character) || TokenMarks.Contains(character, StringComparison.Ordinal);
        });
    }

    // whether a Sec-WebSocket-Protocol, across its field lines, is a list of distinct tokens: its
    // elements MUST be non-empty, which an empty element or an empty field breaks (RFC 6455 §4.1
    // item 10, §11.3.4)
    private static bool IsSubprotocolList(StringValues lines)
    {
        var elements = ElementsOf(lines).ToList();

        return elements.All(IsToken)
            && elements.Distinct(StringComparer.Ordinal).Count() == elements.Count;
    }

    // whether a Sec-WebSocket-Key is one field line of 16 bytes in base64 (RFC 6455 §4.2.1 item 5,
    // §11.3.1): 22 characters of the alphabet, then two pads
    private static bool IsKey(StringValues lines)
    {
        if (lines.Count != 1)
        {
            return false;
        }

        var key = ValueOf(lines[0]);

        return key.Length == 24 && key.EndsWith("==", StringComparison.Ordinal) && key[..22].All((character) =>
        {
            return char.IsAsciiLetterOrDigit(character) || character == '+' || character == '/';
        });
    }

    // whether a request's method is the one named: a method is case-sensitive (RFC 9110 §9.1), which
    // HttpMethods is not
    private static bool IsMethod(HttpRequest request, string method)
    {
        return string.Equals(request.Method, method, StringComparison.Ordinal);
    }

    // whether a request asks a WebSocket of HTTP (RFC 9110 §7.8, RFC 6455 §4.2.1 items 3 and 4): an
    // HTTP/1.1 request, never a HEAD, whose Upgrade names websocket and whose Connection names upgrade
    private static bool AsksWebSocket(HttpRequest request)
    {
        // ! an HTTP/1.0 request's Upgrade is ignored, a MUST; a HEAD cannot switch
        return HttpProtocol.IsHttp11(request.Protocol)
            && !IsMethod(request, "HEAD")
            && Names(request.Headers.Upgrade, "websocket")
            && Names(request.Headers.Connection, "upgrade");
    }

    // whether an upgrade of version 13 holds the rest of a handshake's form: one key, a list of
    // distinct subprotocols when any, and no content
    private static bool IsWellFormed(HttpRequest request)
    {
        var headers = request.Headers;

        // * two Authorization lines are no list to combine (RFC 9110 §5.3), refused whether the
        // upgrade carries an Origin or not: a form fault, as a key is
        return IsKey(headers.SecWebSocketKey)
            && (headers.SecWebSocketProtocol.Count == 0 || IsSubprotocolList(headers.SecWebSocketProtocol))
            && headers.Authorization.Count <= 1
            && headers.ContentLength is null or 0
            && headers.TransferEncoding.Count == 0;
    }

    // the authority an HTTP/1 request's target names in absolute-form; none for another form, and
    // over HTTP/2, whose :authority Kestrel has put in the Host
    private static string? TargetAuthorityOf(HttpRequest request)
    {
        var isHttp1 = HttpProtocol.IsHttp10(request.Protocol) || HttpProtocol.IsHttp11(request.Protocol);

        return isHttp1 ? HostsAndOrigins.TargetAuthorityOf(request.HttpContext.Features.Get<IHttpRequestFeature>()?.RawTarget) : null;
    }

    // definition

    /// <summary>
    /// What a refusal tells of a request (spec 15.1), as the judgement reads it: the authority it
    /// names, as it came (spec 15.12), an HTTP/1 request's absolute-form target's, else its
    /// <c>Host</c>'s, without the whitespace around it, or none; and its <c>Origin</c>, its field
    /// lines joined by <c>", "</c>, or none.
    /// </summary>
    public static (string? Authority, string? Origin) ToldOf(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        return (HostsAndOrigins.AuthorityOf(request.Headers.Host, TargetAuthorityOf(request)), HostsAndOrigins.OriginOf(request.Headers.Origin));
    }

    /// <summary>
    /// What the server answers a request at its WebSocket's address, or none when it upgrades it:
    /// what HTTP refuses of its own, a field value that holds a control character but HTAB or a
    /// character past ASCII, a <c>Host</c> missing or repeated, or an authority that is no host, 400
    /// unmarked; a host not taken, 403; a method but GET or HEAD, 405; a request that asks no WebSocket, 426;
    /// a version but 13, 426, and one in two field lines, 400; a malformed upgrade, two
    /// <c>Authorization</c> lines among it, 400; an origin not taken, 403.
    /// </summary>
    public static HandshakeRefusal? RefusalOf(HttpRequest request, WebSocketTransportServerOptions options)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(options);

        var headers = request.Headers;

        // * a field HTTP would call malformed before anything else is judged (spec 15.12): Kestrel
        // refuses 400 an octet that is no UTF-8, and decodes the rest, a character past ASCII among
        // them, and takes a control character, which this refuses as HTTP refuses a malformed field
        var isVisible = headers.All((field) =>
        {
            return field.Value.All((value) =>
            {
                return HostsAndOrigins.IsVisibleField(value ?? "");
            });
        });

        if (!isVisible)
        {
            return BadRequest;
        }

        // HTTP's own, which Kestrel answers before the application runs: a Host's lines, and the
        // authority of an absolute-form target judged in place of a Host's form, which Kestrel
        // ignores beside one (RFC 9112 §3.2.2); over HTTP/2, Kestrel resets the stream of an
        // authority that is no host before the application runs
        var isHttp1 = HttpProtocol.IsHttp10(request.Protocol) || HttpProtocol.IsHttp11(request.Protocol);
        var targetAuthority = TargetAuthorityOf(request);

        if (isHttp1 && !HostsAndOrigins.IsWellFormedHost(headers.Host, (HttpProtocol.IsHttp11(request.Protocol), targetAuthority)))
        {
            return BadRequest;
        }

        // ! the authority as it came, which a browser writes as it writes its Origin, an IDN in
        // punycode: Request.Host turns punycode into Unicode, and throws on what decodes to none
        var authority = HostsAndOrigins.AuthorityOf(headers.Host, targetAuthority);

        // * the host before anything else is read: a page that rebinds its name reaches the address
        // with any method and no upgrade, and hosts refuses it on every transport alike
        if (!HostsAndOrigins.IsTakenHost(authority, options.Hosts))
        {
            return HostRefused;
        }

        if (!IsMethod(request, "GET") && !IsMethod(request, "HEAD"))
        {
            return MethodRefused;
        }

        if (!AsksWebSocket(request))
        {
            return UpgradeRequired;
        }

        // the version before the rest of the form, so an older client learns the one to speak
        // (RFC 6455 §4.4); two field lines are no version at all (§11.3.5)
        var versions = headers.SecWebSocketVersion;

        if (versions.Count > 1)
        {
            return Malformed;
        }

        if (versions.Count == 0 || ValueOf(versions[0]) != Version)
        {
            return VersionRefused;
        }

        if (!IsWellFormed(request))
        {
            return Malformed;
        }

        var origin = headers.Origin;

        // ! the own origin by a host taken by name alone: under *, a page that rebinds its name is
        // its own origin by the very Host * did not check
        var own = HostsAndOrigins.OwnAuthorityOf(authority, options.Hosts);

        if (!HostsAndOrigins.IsTakenOrigin(origin.Count == 0 ? null : origin.ToString(), (own, options.Origins)))
        {
            return OriginRefused;
        }

        return null;
    }
}
