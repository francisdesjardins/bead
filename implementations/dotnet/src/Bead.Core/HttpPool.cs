namespace Bead;

/// <summary>What every HTTP client Bead builds keeps of its pool.</summary>
internal static class HttpPool
{
    /// <summary>
    /// How long a pooled connection goes unused before its pool closes it: 4 seconds, as undici
    /// keeps, under Node's 5 s <c>keepAliveTimeout</c> and a server's <c>HeadersTimeout</c> at its
    /// default. A server whose <c>HeadersTimeout</c> is under 5 s races it, since Kestrel and hyper
    /// send no <c>Keep-Alive</c> hint.
    /// </summary>
    public static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(4);
}
