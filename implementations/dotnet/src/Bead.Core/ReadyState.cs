namespace Bead;

/// <summary>
/// Where a transport end is in its life. The first four keep the WebSocket's numbering, so a
/// socket's own state reads as one of them; the last two are Bead's.
/// </summary>
public enum ReadyState
{
    /// <summary>Opening: a client's connect, or a server's start, under way.</summary>
    Connecting = 0,

    /// <summary>Open: a client's connection, or a server listening.</summary>
    Open = 1,

    /// <summary>Closing: a client's close handshake, or a server's stop, under way.</summary>
    Closing = 2,

    /// <summary>Closed, and ready to open again.</summary>
    Closed = 3,

    /// <summary>Never opened.</summary>
    Uninitialized = 4,

    /// <summary>A client connecting again with the options of its last connect.</summary>
    Reconnecting = 5,
}
