namespace Bead;

/// <summary>
/// A client transport's send while it is not open, refused by its state as the send reaches it
/// (debugging 9.7): before its open, uninitialized or connecting, by its ready state; once its
/// state is a close's, closing, closed or reconnecting, however it came to be so, as a
/// disconnection, the type a call pending when the close came fails with.
/// </summary>
internal static class NotOpen
{
    /// <summary>What a send refused in <paramref name="readyState"/> fails with.</summary>
    public static Exception Of(ReadyState readyState)
    {
        if (readyState is ReadyState.Uninitialized or ReadyState.Connecting)
        {
            return new ReadyStateException(readyState, ReadyState.Open);
        }

        return new DisconnectException($"the transport client is {NameOf(readyState)}, not open");
    }

    /// <summary>A state as a message words it: "open", "closing"…</summary>
    public static string NameOf(ReadyState readyState)
    {
        return readyState.ToString().ToLowerInvariant();
    }
}
