namespace Bead;

/// <summary>Where a transport server listens: over WebSocket as over HTTP.</summary>
public sealed record TransportServerStartOptions
{
    /// <summary>
    /// The address it listens on (spec 15.12): <c>localhost</c> by default, both loopbacks,
    /// <c>127.0.0.1</c> and <c>::1</c> on one port, as Kestrel's <c>ListenLocalhost</c> binds them, so
    /// no other process answers a client that reaches it by <c>localhost</c> on the other family; a
    /// port another socket holds on either fails the start, and a port drawn is drawn again, eight
    /// times at most. Where the IPv6 loopback is absent it listens on <c>127.0.0.1</c> alone, and
    /// reports it. Or an IP address written bare, which it listens on alone: <c>0.0.0.0</c> or
    /// <c>::</c> for every interface, which a container, or any server another machine reaches,
    /// needs, its hosts named beside. RFC 3986's <c>IPv4address</c> or <c>IPv6address</c>, with no
    /// brackets, no zone, and not IPv4-mapped; another name or any other form is an
    /// <see cref="ArgumentException"/> as it starts, which ends Closed.
    /// </summary>
    public string Address { get; init; } = Loopbacks.Localhost;

    /// <summary>The port it listens on.</summary>
    public int Port { get; init; } = 80;

    /// <summary>Whether it takes any free port instead.</summary>
    public bool FindOpenPort { get; init; }

    /// <summary>What gives up on the start.</summary>
    public CancellationToken CancellationToken { get; init; }
}
