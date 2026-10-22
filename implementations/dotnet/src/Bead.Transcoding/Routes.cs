using Google.Protobuf.Reflection;

namespace Bead.Transcoding;

/// <summary>How a payload goes over HTTP: protobuf's JSON mapping, or one of Bead's encodings as it is (transcoding 5.1).</summary>
public enum HttpEncoding
{
    /// <summary>A message, <c>application/json</c> by Bead's mapping of protobuf's JSON.</summary>
    Proto,

    /// <summary>A <c>json</c> payload, <c>application/json</c>, its bytes as they are.</summary>
    Json,

    /// <summary>A <c>text</c> payload, <c>text/plain</c>, its bytes as they are.</summary>
    Text,

    /// <summary>A <c>raw</c> payload, <c>application/octet-stream</c>, its bytes as they are.</summary>
    Raw,
}

/// <summary>
/// A payload as a route reads and writes it over HTTP: a message, by its descriptor, which Bead's
/// mapping reads and writes its JSON by; or one of Bead's encodings, whose bytes go as they are.
/// </summary>
public sealed class HttpPayload
{
    private HttpPayload(HttpEncoding encoding, MessageDescriptor? descriptor)
    {
        Encoding = encoding;
        Descriptor = descriptor;
    }

    /// <summary>A <c>json</c> payload.</summary>
    public static HttpPayload Json { get; } = new(HttpEncoding.Json, null);

    /// <summary>A <c>text</c> payload.</summary>
    public static HttpPayload Text { get; } = new(HttpEncoding.Text, null);

    /// <summary>A <c>raw</c> payload.</summary>
    public static HttpPayload Raw { get; } = new(HttpEncoding.Raw, null);

    /// <summary>How it goes.</summary>
    public HttpEncoding Encoding { get; }

    /// <summary>Its message's descriptor, for a <see cref="HttpEncoding.Proto"/> payload; none otherwise.</summary>
    public MessageDescriptor? Descriptor { get; }

    /// <summary>A message's payload, by its descriptor.</summary>
    public static HttpPayload Of(MessageDescriptor descriptor)
    {
        ArgumentNullException.ThrowIfNull(descriptor);

        return new HttpPayload(HttpEncoding.Proto, descriptor);
    }
}

/// <summary>
/// One route of a procedure (transcoding 3): its method, <c>GET</c>, <c>PUT</c>, <c>POST</c>,
/// <c>DELETE</c> or <c>PATCH</c>; its template, <c>http.proto</c>'s; its body, <c>*</c> or a
/// top-level field's name, none for a route that takes none; and its response body, a top-level
/// field of its result, none for the result whole.
/// </summary>
public sealed record HttpRouteTemplate
{
    /// <summary>Its method, in upper case.</summary>
    public required string Method { get; init; }

    /// <summary>Its template, as <c>http.proto</c>'s grammar writes one.</summary>
    public required string Template { get; init; }

    /// <summary>What its body binds: <c>*</c>, the request whole, or a top-level field's name; none takes no body.</summary>
    public string? Body { get; init; }

    /// <summary>The top-level field of its result its body is (transcoding 5.8); none for the result whole.</summary>
    public string? ResponseBody { get; init; }
}

/// <summary>
/// A procedure a client calls, as an output's route table holds it (decision 0037): its descriptor,
/// its messages, whether its method is marked <c>NO_SIDE_EFFECTS</c>, its service's catalogue, and
/// its routes, its default ones first, then its <c>google.api.http</c> rules in their order.
/// </summary>
public sealed record HttpRoute
{
    /// <summary>The procedure, as its service's descriptors name it.</summary>
    public required Procedure Procedure { get; init; }

    /// <summary>Its request's payload.</summary>
    public required HttpPayload Request { get; init; }

    /// <summary>Its result's payload.</summary>
    public required HttpPayload Result { get; init; }

    /// <summary>Its notification's payload, for a procedure that notifies; none otherwise.</summary>
    public HttpPayload? Notification { get; init; }

    /// <summary>Whether its method is marked <c>idempotency_level = NO_SIDE_EFFECTS</c>.</summary>
    public bool NoSideEffects { get; init; }

    /// <summary>Its service's catalogue: each application failure's name and code.</summary>
    public required IReadOnlyDictionary<string, int> Failures { get; init; }

    /// <summary>Its routes, its default ones first, then its rules in their order.</summary>
    public required IReadOnlyList<HttpRouteTemplate> Routes { get; init; }
}
