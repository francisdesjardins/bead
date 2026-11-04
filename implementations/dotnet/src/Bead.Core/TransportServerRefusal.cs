namespace Bead;

/// <summary>
/// A refusal a transport server judged of its own (spec 15.1): a request it refused as it arrived,
/// in the order spec 15.6 states, or whose body it refused as it came, marked in
/// <c>bead-refusal</c>. Never the 404 that ends an exchange or a listen it had taken as their
/// connection closes (spec 15.7), which its close tells, nor what HTTP refuses of its own, unmarked.
/// It carries nothing else of the request: never its target, where a page's WebSocket puts what it
/// cannot put in a field, nor its connection's token, nor a credential, nor its body; and it names
/// no connection, since a refusal is a request's. Every string it carries is visible ASCII, SP and
/// HTAB, as a server takes a field (spec 15.12).
/// </summary>
public sealed record TransportServerRefusal
{
    /// <summary>
    /// The client's address, as <c>Clients</c> reports it (spec 15.12): the <c>X-Forwarded-For</c>
    /// entry reached past the proxies its <c>TrustedProxies</c> names, a WebSocket's from its
    /// upgrade's, else the socket's; in its one form, an IPv4 address an IPv6 socket carries mapped
    /// read as IPv4. None when the platform gives no socket's address.
    /// </summary>
    public string? Address { get; init; }

    /// <summary>
    /// The request's authority as it came, its port included (spec 15.12): an absolute-form
    /// target's, else its <c>Host</c>'s; empty for an empty <c>Host</c>, none when it names none. Its
    /// host, the port aside, is the name to add to a server's hosts.
    /// </summary>
    public string? Authority { get; init; }

    /// <summary>
    /// The request's <c>Origin</c> as it came, its field lines joined by <c>", "</c> (RFC 9110 §5.3);
    /// none when it sends none. The page to add to a server's origins.
    /// </summary>
    public string? Origin { get; init; }

    /// <summary>
    /// The port of the socket the request came on, as <c>Clients</c> reports it: behind a proxy it
    /// trusts, the nearest proxy's connection's; 0 when it gave none.
    /// </summary>
    public int Port { get; init; }

    /// <summary>The mark it was refused with, as its <c>bead-refusal</c> carries it.</summary>
    public required string Reason { get; init; }

    /// <summary>The status it was refused with.</summary>
    public required int Status { get; init; }
}
