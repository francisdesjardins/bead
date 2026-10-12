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
/// <param name="Address">
/// The client's address, as <c>Clients</c> reports it (spec 15.12): over HTTP, the last
/// <c>X-Forwarded-For</c> entry behind a proxy trusted, when it is an address, else the socket's; at a
/// WebSocket's address, the socket's; an IPv4 address an IPv6 socket carries mapped read as IPv4.
/// None when the platform gives no socket's address.
/// </param>
/// <param name="Authority">
/// The request's authority as it came, its port included (spec 15.12): an absolute-form target's,
/// else its <c>Host</c>'s; empty for an empty <c>Host</c>, none when it names none. Its host, the port
/// aside, is the name to add to a server's hosts.
/// </param>
/// <param name="Origin">
/// The request's <c>Origin</c> as it came, its field lines joined by <c>", "</c> (RFC 9110 §5.3); none
/// when it sends none. The page to add to a server's origins.
/// </param>
/// <param name="Port">
/// The port of the socket the request came on, as <c>Clients</c> reports it: behind a proxy trusted,
/// the proxy's connection's; 0 when it gave none.
/// </param>
/// <param name="Reason">The mark it was refused with, as its <c>bead-refusal</c> carries it.</param>
/// <param name="Status">The status it was refused with.</param>
public sealed record TransportServerRefusal(string? Address, string? Authority, string? Origin, int Port, string Reason, int Status);
