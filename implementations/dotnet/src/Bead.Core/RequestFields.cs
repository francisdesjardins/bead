using System.Globalization;

namespace Bead;

/// <summary>
/// What HTTP refuses of a request's fields that Kestrel hands on (spec 15.12): a
/// <c>Content-Length</c> beside a <c>Transfer-Encoding</c> over HTTP/1.x, a
/// <c>Transfer-Encoding</c> that lists anything after its first <c>chunked</c> or that an HTTP/1.0
/// request carries, and the connection-specific fields over HTTP/2, which every server judges before
/// anything else of the request.
/// </summary>
internal static class RequestFields
{
    /// <summary>
    /// The connection-specific fields that make a request over HTTP/2 malformed (RFC 9113 §8.2.2)
    /// and that Kestrel hands on: a <c>connection</c>, and a <c>te</c> but <c>trailers</c>, it
    /// refuses itself.
    /// </summary>
    public static readonly string[] ConnectionSpecific = ["transfer-encoding", "keep-alive", "proxy-connection", "upgrade"];

    /// <summary>
    /// Whether a request over HTTP/1.x carried a <c>Content-Length</c> beside its
    /// <c>Transfer-Encoding</c>, as Kestrel hands it on: its <c>Transfer-Encoding</c>'s lines and its
    /// <c>X-Content-Length</c>'s, both there.
    /// </summary>
    public static bool HasLengthBesideTransferEncoding(IReadOnlyList<string?> transferEncoding, IReadOnlyList<string?> xContentLength)
    {
        ArgumentNullException.ThrowIfNull(transferEncoding);
        ArgumentNullException.ThrowIfNull(xContentLength);

        // ! Kestrel's Http1MessageBody.For removes a Content-Length beside a Transfer-Encoding,
        // keeps its value in an X-Content-Length and reads the body by the Transfer-Encoding alone,
        // so that field is all that is left of it. A client's own X-Content-Length beside a
        // Transfer-Encoding reads alike, and is refused with it: a false positive. Kestrel closes
        // such a connection itself only since dotnet/aspnetcore#66671, in 10.0.10, and not under
        // its switch AllowKeepAliveAfterCLTE, so the refusal's own connection: close closes it
        return transferEncoding.Count > 0 && xContentLength.Count > 0;
    }

    /// <summary>
    /// Whether a request's <c>Transfer-Encoding</c>, its field lines as they came, frames its body
    /// as spec 15.12 takes it: none at all; or, over HTTP/1.1, a list whose final coding is
    /// <c>chunked</c>, in any ASCII case (RFC 9112 §6.3 item 4), and whose first <c>chunked</c> is
    /// that last element. An empty element before it is ignored (RFC 9110 §5.6.1.2); anything after
    /// it, another <c>chunked</c> or an empty element among it, is not. One an HTTP/1.0 request
    /// carries is none either, its framing faulty (RFC 9112 §6.1).
    /// </summary>
    public static bool IsTransferEncodingFramed(string protocol, IReadOnlyList<string?> transferEncoding)
    {
        ArgumentNullException.ThrowIfNull(protocol);
        ArgumentNullException.ThrowIfNull(transferEncoding);

        if (transferEncoding.Count == 0)
        {
            return true;
        }

        var elements = transferEncoding.SelectMany((line) =>
        {
            return (line ?? "").Split(',');
        }).Select((element) =>
        {
            return element.Trim(HostsAndOrigins.FieldWhitespace);
        }).ToList();
        var first = elements.FindIndex((element) =>
        {
            return HostsAndOrigins.IsAsciiEqual(element, "chunked");
        });

        return !string.Equals(protocol, "HTTP/1.0", StringComparison.OrdinalIgnoreCase) && first == elements.Count - 1;
    }

    /// <summary>
    /// Whether a <c>Content-Length</c>'s value, one field line as it came, is a length spec 15.12
    /// counts: digits alone, at least one, with no sign and no space, whose number is 2⁶³ − 1 at
    /// most, read by value, its leading zeros counting for nothing (RFC 9110 §8.6).
    /// </summary>
    public static bool IsCountedLength(string? value)
    {
        if (string.IsNullOrEmpty(value) || !value.All(char.IsAsciiDigit))
        {
            return false;
        }

        return long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out _);
    }
}
