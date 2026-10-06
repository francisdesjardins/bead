namespace Bead;

/// <summary>
/// A client of Bead: its layers, and what every client's transport does but connect, which each
/// client keeps its own, its transport's options its own.
/// </summary>
public interface IClient : IAsyncDisposable
{
    /// <summary>Its router.</summary>
    RouterClient Router { get; }

    /// <summary>Its services.</summary>
    ServiceManager Services { get; }

    /// <summary>Closes its transport's connection.</summary>
    Task Disconnect(TransportDisconnectOptions? options = null);

    /// <summary>Reconnects its transport; a dispose cancels it, as the token given does.</summary>
    Task Reconnect(TransportReconnectOptions? options = null);
}
