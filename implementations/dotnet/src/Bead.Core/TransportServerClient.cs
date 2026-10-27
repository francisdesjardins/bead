namespace Bead;

/// <summary>The type of each transport, which the handles of its connections begin with.</summary>
public static class TransportTypes
{
    /// <summary>Over HTTP: a connection the transport draws, <c>type=HTTP;ip=…;ordinal=…</c>.</summary>
    public const string Http = "HTTP";

    /// <summary>
    /// Over a WebSocket: <c>type=WS;ip=…;port=…;ordinal=…</c>, a connection taken, by its peer's
    /// port and its rank.
    /// </summary>
    public const string WebSocket = "WS";

    /// <summary>
    /// In memory: <c>type=MEMORY;ip=…;ordinal=…</c>, a connection a connect draws, by the address its
    /// client gave, or <c>local</c>, and its rank (spec 15.13).
    /// </summary>
    public const string Memory = "MEMORY";

    /// <summary>
    /// Over the in-memory broker (spec 15.24): <c>type=BROKER;participant=…;ordinal=…</c>, a
    /// connection its third leg proved, by its peer participant's id and its rank; a broker's
    /// adapter of another names its own type, which its handles begin with.
    /// </summary>
    public const string Broker = "BROKER";

    /// <summary>
    /// Over a broker of MQTT 5 (spec 15.25): <c>type=MQTT;participant=…;ordinal=…</c>, a connection
    /// its third leg proved, by its peer participant's id and its rank.
    /// </summary>
    public const string Mqtt = "MQTT";
}

/// <summary>
/// One connection, as a transport server's <c>Clients</c> lists it: who is on the other end, and
/// when it was last heard from — never its socket, nor anything else its transport keeps of it.
/// </summary>
/// <param name="Address">The address of who is on the other end.</param>
/// <param name="ConnectionHandle">The handle the connection is named by.</param>
/// <param name="LastActivity">
/// When it was last heard from, on its server's clock: a message over a WebSocket; an exchange of an
/// envelope, or a listen, begun over HTTP. None until then.
/// </param>
/// <param name="Port">The port of who is on the other end, as it connected; 0 when it gave none.</param>
/// <param name="Type">Its transport's type, one of <see cref="TransportTypes"/>.</param>
public sealed record TransportServerClient(string Address, string ConnectionHandle, DateTimeOffset? LastActivity, int Port, string Type);
