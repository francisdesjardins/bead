namespace Bead.Transport.Http;

/// <summary>What Bead over HTTP names: its media types and its headers, as section 15 of the spec says.</summary>
public static class HttpTransport
{
    /// <summary>The type of a body that is one envelope.</summary>
    public const string MediaType = "application/prs.bead";

    /// <summary>The type of a listen's batch: each envelope after its length on 4 bytes, big-endian.</summary>
    public const string BatchMediaType = "application/prs.bead-batch";

    /// <summary>The header a connection's token travels in: the 201 that draws it, and each exchange after.</summary>
    public const string ConnectionTokenHeader = "bead-connection-token";

    /// <summary>
    /// The header a client says at connect that it listens in, <c>?1</c>, and the 201 says back: an
    /// Item of RFC 9651 whose bare item is a Boolean, its parameters ignored.
    /// </summary>
    public const string ListenHeader = "bead-listen";

    /// <summary>
    /// The header a listen acknowledges in: the number of the last envelope its client heard whole;
    /// an Item whose bare item is an Integer of RFC 9651, 0 or more.
    /// </summary>
    public const string AfterHeader = "bead-after";

    /// <summary>The header a listen asks the server to hold it in, in milliseconds; 0 when left out.</summary>
    public const string WaitHeader = "bead-wait";

    /// <summary>
    /// The header a batch names the number of its first envelope in, the others following one by
    /// one: an Item of RFC 9651 whose bare item is an Integer, 1 or more.
    /// </summary>
    public const string SequenceHeader = "bead-sequence";

    /// <summary>The header each refusal of the transport's own is marked in.</summary>
    public const string RefusalHeader = HostsAndOrigins.RefusalHeader;

    /// <summary>The path the transport answers on, by default.</summary>
    public const string Pathname = "/bead";

    // what the transport reads of an envelope, and nothing else, in the prefix every layout from
    // 0xA1 to 0xAF keeps: the layout in its first byte, the kind in its second, the call id in its
    // fifth to eighth
    internal const int PrefixBytes = 8;
    internal const byte FirstLayout = 0xa1;
    internal const byte LastLayout = 0xaf;
}

/// <summary>The reasons each refusal of the transport's own is marked with, in <see cref="HttpTransport.RefusalHeader"/>.</summary>
public static class HttpRefusals
{
    /// <summary>Too many connections, requests waiting, exchanges under way, or bytes of body read: 429 or 503.</summary>
    public const string Busy = "busy";

    /// <summary>A request on a call id already waiting: 409.</summary>
    public const string CallWaiting = "call-waiting";

    /// <summary>The connection is gone: 404.</summary>
    public const string ConnectionUnknown = "connection-unknown";

    /// <summary>A host the server does not take: 403.</summary>
    public const string Host = HostsAndOrigins.HostRefusal;

    /// <summary>A listen whose client did not say at connect it listens: 409.</summary>
    public const string ListenUndeclared = "listen-undeclared";

    /// <summary>A connect with a body, a token missing or malformed, no envelope, a request on the server's parity, a listen without <c>bead-after</c>, or a count that is none: 400.</summary>
    public const string Malformed = "malformed";

    /// <summary>Neither GET, POST nor DELETE: 405.</summary>
    public const string Method = "method-refused";

    /// <summary>A browser's exchange from an origin the server does not take: 403.</summary>
    public const string Origin = HostsAndOrigins.OriginRefusal;

    /// <summary>Not the path: 404.</summary>
    public const string Path = "path-unknown";

    /// <summary>A body past the envelope's limit: 413.</summary>
    public const string TooLarge = "too-large";

    /// <summary>A body that came slower than its rate once its grace passed: 408 (spec 15.12).</summary>
    public const string TooSlow = "too-slow";

    /// <summary>Not Bead's media type, or encoded: 415.</summary>
    public const string Type = "type-refused";
}
