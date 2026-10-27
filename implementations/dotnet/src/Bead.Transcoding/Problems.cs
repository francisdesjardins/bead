using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Google.Protobuf.Reflection;

namespace Bead.Transcoding;

/// <summary>Where a call's failure arose, which its status is keyed by (transcoding 7.5).</summary>
public enum FailureArising
{
    /// <summary>Its server answered it, of the request.</summary>
    Server,

    /// <summary>The gateway's client raised it before the call went.</summary>
    Client,

    /// <summary>The gateway's client raised it of a result or a notification: its server's answer it could not take.</summary>
    Answer,

    /// <summary>The gateway's own reading of the request: its body, its query or a variable.</summary>
    Gateway,
}

/// <summary>What a failure of the gateway's own is (transcoding 7.6's last rows).</summary>
public enum OwnFailure
{
    /// <summary>Its call's timeout passed, 504.</summary>
    Timeout,

    /// <summary>Its exchange's connection closed before its answer, 502.</summary>
    Closed,

    /// <summary>A result Bead's proto JSON form holds none of (5.7), 500.</summary>
    Unwritable,

    /// <summary>A <c>JWT</c> its request's block cannot hold, under <c>bearer-jwt</c>, 431.</summary>
    Jwt,

    /// <summary>An <c>authorization</c> of an auth-scheme but <c>Bearer</c>, under <c>bearer-jwt</c>, 401.</summary>
    Scheme,

    /// <summary>What no gate foresaw, 500, with no detail.</summary>
    Failed,
}

/// <summary>Where a failure is answered from, and what a gateway is given to answer it.</summary>
public sealed record ProblemContext
{
    /// <summary>Where it arose.</summary>
    public required FailureArising Arose { get; init; }

    /// <summary>The encoding of the request its server could not read, which keys its PAYLOAD_UNDECODABLE.</summary>
    public HttpEncoding Encoding { get; init; } = HttpEncoding.Proto;

    /// <summary>Whether its call presented a credential, which a <c>SESSION_REQUIRED</c>'s challenge tells.</summary>
    public bool Credential { get; init; }

    /// <summary>The gateway's challenge, a <c>SESSION_REQUIRED</c>'s <c>www-authenticate</c>.</summary>
    public string Challenge { get; init; } = "Bearer";

    /// <summary>The base its definitions give an application failure's problem type; none gives <c>about:blank</c>.</summary>
    public string? ProblemTypes { get; init; }

    /// <summary>Its service's catalogue, each application failure's name by its code.</summary>
    public IReadOnlyDictionary<string, int>? Failures { get; init; }

    /// <summary>Its request's message, which a <c>PAYLOAD_INVALID</c>'s pointers are named by.</summary>
    public MessageDescriptor? Request { get; init; }

    /// <summary>The route its request came by, whose variables and body a violation's field is placed by.</summary>
    public HttpRouteTemplate? Rule { get; init; }

    /// <summary>Where the gateway's reading met what it refuses, as 7.4 places one: a <c>PAYLOAD_UNDECODABLE</c> of its own.</summary>
    public RequestPlace? Place { get; init; }
}

/// <summary>A problem, as a gateway answers a failure: its status, the fields beside it, and its body.</summary>
public sealed record HttpProblem
{
    /// <summary>Its status.</summary>
    public required int Status { get; init; }

    /// <summary>The fields its response carries beside it: <c>www-authenticate</c>, <c>retry-after</c>.</summary>
    public required IReadOnlyDictionary<string, string> Fields { get; init; }

    /// <summary>Its body, <c>application/problem+json</c>, in the canonical form of spec 17.7.</summary>
    public required ReadOnlyMemory<byte> Body { get; init; }
}

/// <summary>
/// A failure answered as a problem of RFC 9457 (transcoding 7): its status by where its code arose,
/// its members in the canonical form of spec 17.7, its names sorted, so that one failure is one
/// sequence of bytes on every side; a <c>PAYLOAD_INVALID</c>'s violations as its <c>errors</c>,
/// each placed by a pointer into the body or a parameter (7.4).
/// </summary>
public static partial class HttpProblems
{
    /// <summary>A protocol code's problem type is this, then its name (transcoding 7.3).</summary>
    public const string Tag = "tag:francisdesjardins.ca,2026:bead/";

    /// <summary>The media type of a problem.</summary>
    public const string MediaType = "application/problem+json";

    private static readonly Dictionary<int, string> Phrases = new()
    {
        [400] = "Bad Request",
        [401] = "Unauthorized",
        [403] = "Forbidden",
        [404] = "Not Found",
        [405] = "Method Not Allowed",
        [408] = "Request Timeout",
        [413] = "Content Too Large",
        [415] = "Unsupported Media Type",
        [422] = "Unprocessable Content",
        [429] = "Too Many Requests",
        [431] = "Request Header Fields Too Large",
        [500] = "Internal Server Error",
        [501] = "Not Implemented",
        [502] = "Bad Gateway",
        [503] = "Service Unavailable",
        [504] = "Gateway Timeout",
    };

    private static readonly Dictionary<ushort, string> Names = new()
    {
        [1] = "ENVELOPE_MALFORMED",
        [2] = "LAYOUT_UNSUPPORTED",
        [3] = "KIND_UNSUPPORTED",
        [4] = "ENVELOPE_TOO_LARGE",
        [16] = "DESTINATION_UNKNOWN",
        [17] = "DESTINATION_UNREACHABLE",
        [18] = "SERVICE_UNKNOWN",
        [19] = "PROCEDURE_UNKNOWN",
        [20] = "CALL_UNKNOWN",
        [21] = "SUBSCRIPTION_UNKNOWN",
        [22] = "SUBSCRIPTION_UNSUPPORTED",
        [32] = "SESSION_REQUIRED",
        [33] = "ACCESS_DENIED",
        [34] = "PAYLOAD_TOO_LARGE",
        [35] = "CAPACITY_EXCEEDED",
        [36] = "CREDENTIAL_UNSUPPORTED",
        [48] = "CHUNK_INVALID",
        [49] = "CREDIT_EXCEEDED",
        [50] = "PAYLOAD_UNDECODABLE",
        [51] = "TRANSFER_STALLED",
        [52] = "PAYLOAD_INVALID",
        [64] = "PROCEDURE_FAILED",
        [65] = "DESTINATION_LOST",
    };

    /// <summary>The phrase RFC 9110 gives <paramref name="status"/>, which a problem of <c>about:blank</c> is titled by (RFC 9457 §4.2.1).</summary>
    public static string PhraseOf(int status)
    {
        return Phrases.TryGetValue(status, out var phrase) ? phrase : status.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>The status a protocol code answers where it arose (transcoding 7.6), the code a name or a number none names.</summary>
    public static int StatusOf(ushort code, ProblemContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        var arose = context.Arose;

        return (ProtocolCode)code switch
        {
            ProtocolCode.EnvelopeMalformed => 500,
            ProtocolCode.LayoutUnsupported or ProtocolCode.KindUnsupported => 502,
            ProtocolCode.EnvelopeTooLarge or ProtocolCode.PayloadTooLarge => arose == FailureArising.Answer ? 502 : 413,
            ProtocolCode.DestinationUnknown or ProtocolCode.CallUnknown or ProtocolCode.SubscriptionUnknown
                or ProtocolCode.SubscriptionUnsupported or ProtocolCode.ChunkInvalid or ProtocolCode.CreditExceeded => 500,
            ProtocolCode.DestinationUnreachable => 503,
            ProtocolCode.ServiceUnknown or ProtocolCode.ProcedureUnknown => 501,
            ProtocolCode.SessionRequired => 401,
            ProtocolCode.AccessDenied => 403,
            ProtocolCode.CapacityExceeded => 429,
            ProtocolCode.CredentialUnsupported => 500,
            ProtocolCode.PayloadUndecodable => arose switch
            {
                FailureArising.Gateway => 400,
                FailureArising.Server => context.Encoding == HttpEncoding.Proto ? 502 : 400,
                _ => 502,
            },
            ProtocolCode.TransferStalled => 504,
            ProtocolCode.PayloadInvalid => 422,
            ProtocolCode.ProcedureFailed => 500,
            ProtocolCode.DestinationLost => 502,
            _ => 500,
        };
    }

    /// <summary>
    /// <paramref name="failure"/> as a gateway answers it where it arose (transcoding 7.3 to 7.6): a
    /// protocol code's problem, its type its tag and its name, or an application failure's, 400,
    /// under its definitions' problem types.
    /// </summary>
    public static HttpProblem Of(Failure failure, ProblemContext context)
    {
        ArgumentNullException.ThrowIfNull(failure);
        ArgumentNullException.ThrowIfNull(context);

        var members = new Dictionary<string, object?>(StringComparer.Ordinal);
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var detail = failure.Detail;

        if (failure.Scope == FailureScope.Application)
        {
            var name = context.Failures?.FirstOrDefault((entry) =>
            {
                return entry.Value == failure.Code;
            }).Key ?? failure.Code.ToString(CultureInfo.InvariantCulture);

            members["type"] = context.ProblemTypes is { } types ? types + name : "about:blank";
            members["title"] = context.ProblemTypes is null ? PhraseOf(400) : name;
            members["status"] = 400;
            members["code"] = (int)failure.Code;
            members["scope"] = "application";

            if (detail.Length > 0)
            {
                members["detail"] = detail;
            }

            return new HttpProblem { Status = 400, Fields = fields, Body = Canonical(members) };
        }

        var status = StatusOf(failure.Code, context);
        var named = Names.GetValueOrDefault(failure.Code) ?? failure.Code.ToString(CultureInfo.InvariantCulture);

        members["type"] = Tag + named;
        members["title"] = named;
        members["status"] = status;
        members["code"] = (int)failure.Code;
        members["scope"] = "protocol";

        if (failure.Code == (ushort)ProtocolCode.PayloadInvalid)
        {
            ErrorsOf(members, (detail, context));
        }
        else if (detail.Length > 0 && failure.Code != (ushort)ProtocolCode.DestinationUnreachable)
        {
            // * but the gateway's own error between it and its server: its code alone (spec 9.0)
            members["detail"] = detail;
        }

        // * where the gateway's reading met what it refuses, as 7.4 places one
        if (context.Arose == FailureArising.Gateway && context.Place is { } place)
        {
            if (place.Parameter is { } parameter)
            {
                members["parameter"] = parameter;
            }

            if (place.Pointer is { } pointer)
            {
                members["pointer"] = pointer;
            }
        }

        if (status == 401)
        {
            fields["www-authenticate"] = ChallengeOf(context.Challenge, context.Credential ? "invalid_token" : null);
        }

        if (status is 429 or 503)
        {
            fields["retry-after"] = "1";
        }

        return new HttpProblem { Status = status, Fields = fields, Body = Canonical(members) };
    }

    /// <summary>
    /// A failure of the gateway's own (transcoding 7.6): <c>about:blank</c>, its status's phrase, its
    /// detail its words, none for what no gate foresaw.
    /// </summary>
    public static HttpProblem Own(OwnFailure failure, (string Detail, string Challenge) told)
    {
        var status = failure switch
        {
            OwnFailure.Timeout => 504,
            OwnFailure.Closed => 502,
            OwnFailure.Unwritable or OwnFailure.Failed => 500,
            OwnFailure.Jwt => 431,
            _ => 401,
        };
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);

        if (failure == OwnFailure.Scheme)
        {
            fields["www-authenticate"] = ChallengeOf(told.Challenge, "invalid_request");
        }

        return new HttpProblem { Status = status, Fields = fields, Body = Refusal(status, told.Detail) };
    }

    /// <summary>
    /// The body of a refusal or a failure of the gateway's own (transcoding 7.7): a problem of
    /// <c>about:blank</c>, titled by its status's phrase, its detail its own words.
    /// </summary>
    public static ReadOnlyMemory<byte> Refusal(int status, string detail)
    {
        ArgumentNullException.ThrowIfNull(detail);

        var members = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["status"] = status,
            ["title"] = PhraseOf(status),
            ["type"] = "about:blank",
        };

        if (detail.Length > 0)
        {
            members["detail"] = detail;
        }

        return Canonical(members);
    }

    // a challenge with an error after it: after a space, or after `, ` where it holds parameters
    private static string ChallengeOf(string challenge, string? error)
    {
        if (error is null)
        {
            return challenge;
        }

        return challenge + (challenge.Contains(' ', StringComparison.Ordinal) ? ", " : " ") + $"error=\"{error}\"";
    }

    // PAYLOAD_INVALID's errors, more and stopped, from its detail's lines (7.4)
    private static void ErrorsOf(Dictionary<string, object?> members, (string Detail, ProblemContext Context) of)
    {
        var (detail, context) = of;
        var read = Violations.Read(detail);
        var template = context.Rule is { } rule ? HttpTemplate.Parse(rule.Template) : null;
        var variables = template?.Variables.Select((variable) =>
        {
            return variable.FieldPath;
        }).ToHashSet(StringComparer.Ordinal) ?? [];
        var body = context.Rule?.Body;
        var errors = new List<object?>();

        foreach (var violation in read.Violations)
        {
            var error = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ruleId"] = violation.RuleId,
            };

            if (violation.Message is { } words)
            {
                error["detail"] = words;
            }

            if (violation.FieldPath is { } fieldPath)
            {
                error["fieldPath"] = fieldPath;
            }

            if (violation.Bounds is { } bounds)
            {
                error["bounds"] = bounds;
            }

            if (violation.ForKey)
            {
                error["forKey"] = true;
            }

            var elements = ElementsOf(violation.FieldPath ?? "");
            var names = string.Join('.', elements.Select((element) =>
            {
                return element.Name;
            }));

            if (context.Request is { } request)
            {
                if (elements.Count > 0 && variables.Contains(names))
                {
                    error["parameter"] = names;
                }
                else if (body == "*")
                {
                    error["pointer"] = Fragment(PointerOf(request, elements));
                }
                else if (body is not null && elements.Count > 0 && elements[0].Name == body)
                {
                    var field = request.FindFieldByName(body);

                    error["pointer"] = Fragment(field is not null && field.IsMessage() ? PointerOf(field.MessageType, elements.Skip(1).ToList()) : []);
                }
                else if (elements.Count > 0 && PointerOf(request, elements.Select((element) =>
                {
                    return (element.Name, (string?)null);
                }).ToList()) is { Count: > 0 } named)
                {
                    // * a path that names no field of the request is placed nowhere
                    error["parameter"] = string.Join('.', named);
                }
            }

            errors.Add(error);
        }

        members["errors"] = errors;

        if (read.More is > 0 and var more)
        {
            members["more"] = more;
        }

        if (read.Stopped)
        {
            members["stopped"] = true;
        }
    }

    // a violation's field path's elements (18.4): each name and its subscript, joined by `.`; none
    // for a path off that grammar, whatever of it reads
    private static List<(string Name, string? Subscript)> ElementsOf(string fieldPath)
    {
        var elements = new List<(string Name, string? Subscript)>();
        var at = 0;

        while (at < fieldPath.Length)
        {
            var found = FieldPathElement().Match(fieldPath, at);

            if (!found.Success || found.Index != at || found.Length == 0)
            {
                return [];
            }

            elements.Add((found.Groups[1].Value, found.Groups[2].Success ? found.Groups[2].Value : null));
            at = found.Index + found.Length;

            if (at == fieldPath.Length)
            {
                break;
            }

            // ! an element is followed by `.` and another, or by nothing
            if (fieldPath[at] != '.' || at + 1 == fieldPath.Length)
            {
                return [];
            }

            at += 1;
        }

        return elements;
    }

    // the tokens of a field's pointer by JSON names, its map's where its key was cut short, and
    // what holds a oneof (7.4, item 2)
    private static List<string> PointerOf(MessageDescriptor descriptor, List<(string Name, string? Subscript)> elements)
    {
        var tokens = new List<string>();
        MessageDescriptor? current = descriptor;

        foreach (var (name, subscript) in elements)
        {
            var field = current?.FindFieldByName(name);

            if (field is null)
            {
                return tokens;
            }

            tokens.Add(field.JsonName);

            if (subscript is not null)
            {
                if (subscript.EndsWith("...", StringComparison.Ordinal))
                {
                    return tokens;
                }

                tokens.Add(subscript.StartsWith('"') ? JsonSerializer.Deserialize<string>(subscript)! : subscript);
            }

            current = field.IsMessage() ? (field.IsMap ? field.MessageType.FindFieldByNumber(2) is { } value && value.IsMessage() ? value.MessageType : null : field.MessageType) : null;
        }

        return tokens;
    }

    // a JSON Pointer's URI fragment (RFC 6901 §6): each token escaped, then what a fragment does not
    // take percent-encoded from its UTF-8
    private static string Fragment(List<string> tokens)
    {
        return JsonPlaces.PointerOf(tokens.Select((token) =>
        {
            return new JsonToken(token, false);
        }));
    }

    // a problem's members in the canonical form of spec 17.7 (7.2): built as JSON, then written by it
    private static ReadOnlyMemory<byte> Canonical(Dictionary<string, object?> members)
    {
        using var document = JsonSerializer.SerializeToDocument(members);

        return Payloads.WriteJson(document.RootElement);
    }

    [GeneratedRegex("([A-Za-z_][A-Za-z0-9_]*)(?:\\[(-?[0-9]+|true|false|\"(?:[^\"\\\\]|\\\\.)*\"(?:\\.\\.\\.)?)\\])?", RegexOptions.CultureInvariant)]
    private static partial Regex FieldPathElement();
}
