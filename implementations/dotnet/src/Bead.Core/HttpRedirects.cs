namespace Bead;

/// <summary>The HTTP transport's handler policy (spec 15.6), shared with the transcoding caller.</summary>
internal static class HttpRedirects
{
    /// <summary>Refuses a platform handler that follows redirects, through any delegating handlers.</summary>
    public static void AssertHandler(HttpMessageHandler? handler, string parameter)
    {
        // one of another kind cannot be read, and is taken: each answer is judged behind it
        while (handler is DelegatingHandler { InnerHandler: { } inner })
        {
            handler = inner;
        }

        if (handler is HttpClientHandler { AllowAutoRedirect: true } or SocketsHttpHandler { AllowAutoRedirect: true })
        {
            throw new ArgumentException("a handler given would follow a redirect, which the client follows none of: its AllowAutoRedirect is true (spec 15.6)", parameter);
        }
    }
}
