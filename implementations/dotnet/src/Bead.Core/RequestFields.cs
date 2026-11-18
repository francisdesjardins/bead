namespace Bead;

/// <summary>
/// What HTTP refuses of a request's fields that Kestrel hands on (spec 15.12): a
/// <c>Content-Length</c> beside a <c>Transfer-Encoding</c> over HTTP/1.x, and the
/// connection-specific fields over HTTP/2, which every server judges before anything else of the
/// request.
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
}
