# 0030 — A server believes `X-Forwarded-For` from the proxies it names alone

- **Status**: accepted
- **Scope**: the protocol, and every implementation's HTTP server transport: in
  [`spec/spec.md`](../../spec/spec.md), 15.12's client address — `trustedProxies`, an entry of
  `X-Forwarded-For` and its one form — which `maximumConnectionsPerAddress`, a connection's handle
  and every refusal told read. The bound itself is 15.12's table; the refusal told,
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)'s; the
  listening address and the form of an IP literal,
  [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)'s.

## Context

**A proxy in front hides the client's address.** `maximumConnectionsPerAddress`, 64 by default
(spec 15.12), counts the connections of one address, and every refusal a server tells names the
address it came from. Behind a proxy, every client is the proxy's address: past 64 users, the site
is refused 503 `busy`, and every told refusal names the proxy. The proxy says who its client is in
`X-Forwarded-For`, a field any client can write too: an address read from it is a claim, believed
only from a proxy the server is told of
([CWE-348](https://cwe.mitre.org/data/definitions/348.html),
[CWE-290](https://cwe.mitre.org/data/definitions/290.html);
[RFC 7239 §8.1](https://www.rfc-editor.org/rfc/rfc7239#section-8.1)).

**A boolean that trusts a proxy on "this machine" serves no deployment that puts one in front.**
Measured on both sides with a server on `0.0.0.0`, a bound of 1 and a proxy that connects from the
LAN, as a container's nginx or an ingress does: two clients behind it are one address, the second
refused 503 `busy`, the option taken and doing nothing; from `127.0.0.1` the same two are two. Such
a "this machine" is `127.0.0.1` and `::1` alone, besides, where 13.4 calls the loopback
127.0.0.0/8.

**Practice names the proxies, by address or network, and walks the field from the right.** nginx's
`set_real_ip_from` with `real_ip_recursive on`; Express's `trust proxy`, computed by `proxy-addr`;
ASP.NET Core's `KnownProxies` and `KnownNetworks`, its `ForwardLimit` the hops it walks; Caddy's
`trusted_proxies`; Traefik's `forwardedHeaders.trustedIPs`. A network is written as
[RFC 4632 §3.1](https://www.rfc-editor.org/rfc/rfc4632#section-3.1) and
[RFC 4291 §2.3](https://www.rfc-editor.org/rfc/rfc4291#section-2.3) write a prefix. Python's
`ipaddress.ip_network` refuses one whose bits past the prefix are set; Node's `net.BlockList` and
.NET's `IPNetwork.TryParse` mask them in silence, `10.1.2.3/8` taken as `10.0.0.0/8` on both.

**The platforms read an entry apart.** `IPAddress.TryParse` takes `[2001:db8::1]:443`, a bracketed
address with its port, and a zone; Node's `isIP` takes none of them. Azure Application Gateway
writes an address with its port by default. An IPv4-mapped address, or an IPv6 one written in
another case or uncompressed, would be a second key of the bound and a second form in what is told.

The options weighed:

- **A hop count alone**, ASP.NET Core's `ForwardLimit` or Express's `trust proxy: n`: it serves a
  proxy of unknown address, and a wrong count is the spoofing hole Express's own documentation warns
  of. Ahead, beside the list, by a decision of its own.
- **The loopback by name**, as Express's `loopback`: `127.0.0.0/8` and `::1` say it in the form every
  entry takes.
- **`Forwarded`** ([RFC 7239](https://www.rfc-editor.org/rfc/rfc7239)): reading both fields lets the
  one a proxy does not write pass as its client wrote it (§8.1), and the proxies operators put in
  front — nginx, HAProxy's `option forwardfor`, Envoy, Caddy, Traefik, every cloud load balancer —
  write `X-Forwarded-For`, and ASP.NET Core's own middleware reads no `Forwarded`. Both platforms
  could parse it: a choice, not a platform's limit, so no row of `docs/support.md`'s "Leveled
  down".
- **An event for a field from a socket not trusted**: per request, it fires on every direct client
  that writes the field; once per address, it is a set a peer grows, which
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md) refuses
  for the same reason.

## Decision

**`trustedProxies`, `TrustedProxies`, names the proxies an HTTP server believes** (spec 15.12):
addresses and networks in one list, as nginx, Express, Caddy and Traefik take them; each an IP
address in the form a server listens on
([0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)), or that
address, `/` and its prefix's length, its bits past the prefix zero ("write 10.0.0.0/8, not
10.1.2.3/8", as Python's strict parse; each side tests the bits itself, since neither platform
does). None by default; the loopback is trusted only when listed. Any other entry is refused as the
transport is built, `ProgrammerError` and `ArgumentException`, naming it: a name, which another host
resolves otherwise, a prefix past its family's bits, and **a network of prefix 0**, `0.0.0.0/0` or
`::/0`, which would trust what every client writes. That refusal is a tripwire for the line copied
from a forum, as `origins` refuses `*`, not a wall: two halves written on purpose are the same
hole.

**The walk goes from the right** (nginx's `real_ip_recursive`, Express's `proxy-addr`): from the
socket's address, while the address reached is one the list holds and the field, its lines joined
by ", ", has an entry left, the next entry from the right is taken when it is an address. The client
is the address so reached: the rightmost entry no trusted proxy wrote. Entries to the left of the
first untrusted one, which a client may write, are never read. The walk is unbounded in hops, as
nginx's and `proxy-addr`'s, and safe while no listed network holds a client's address.

**An entry's grammar is stated, not left to a platform's parser**: one of
[RFC 7239 §6](https://www.rfc-editor.org/rfc/rfc7239#section-6)'s node forms, unquoted and not
obfuscated — a bare IPv4 address, a bare IPv6 address with no zone, `IPv4:port`, `[IPv6]` or
`[IPv6]:port` — its port dropped. A zone, a name, `unknown`, an obfuscated node or an empty entry is
no address, and ends the walk where it is. **Every address is held in one form**, read from the
field or from the socket, for matching, counting and telling: an IPv4-mapped address as its IPv4
address ([RFC 4291 §2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2)), any other
IPv6 address in [RFC 5952 §4](https://www.rfc-editor.org/rfc/rfc5952#section-4)'s text, lowercase
and compressed, hexadecimal throughout, so one client is one key whether it came direct or through
a proxy. ASP.NET Core's `ForwardedHeadersMiddleware` reads an entry as an endpoint and unmaps it
before checking its known proxies; this is the same reading, stated.

**`X-Forwarded-For` alone is read**; `Forwarded` is not, and 15.12 says so. **A WebSocket server
reads neither**: it bounds no address, so a proxy in front costs it only the address its handles
and refusals name.

**No event; a gauge.** Each side's HTTP transport gauges `largestAddressConnections`, the
connections its busiest address holds, under its ceiling `maximumConnectionsPerAddress`, as
`largestOutboxBytes` sits under `maximumOutboxBytes`. One count, no set a peer grows. The health
check warns at 80% of any ceiling, so a proxy left off the list shows `warn` on `/health` at 52
connections from one address, before any 503. A gauge is no part of the spec: twins by the same
sentence hold it.

## Consequences

**A deployment names its proxy's network**: a container's nginx or a Kubernetes ingress lists the
compose network's or the cluster's (`10.0.0.0/8`, say), and a proxy on the same machine lists
`127.0.0.1`. **One it cannot name**, a PaaS router or a cloud load balancer on public addresses,
counts one address per proxy until a hop bound is decided; a told `busy` whose address is the
proxy's, and `largestAddressConnections` near its ceiling, tell it.

**A bound keyed by address counts the users of one NAT as one and an IPv6 network's addresses as
many**: behind a carrier-grade or a corporate NAT, the 65th user is refused 503 whatever the list
says; an IPv6 host holds a /64 or more ([RFC 6177](https://www.rfc-editor.org/rfc/rfc6177),
[RFC 7421](https://www.rfc-editor.org/rfc/rfc7421)) and walks out of a bound keyed by one address.
15.12 names both.

**Ahead, each by a decision of its own**: `Forwarded`, once a proxy that writes it alone is met; a
hop bound for proxies of unknown address; the same list on the WebSocket server, reusing the walk,
for the address its handles and refusals name; IPv6 keyed by a prefix; a per-address value fit for
a NAT.

**The gate.** `spec/transports.json`, played by both sides over HTTP: the bound behind a proxy
named; a field from a socket no entry holds, not read; the walk past two networks, what a client
wrote to the left never read; an entry that is no address ending the walk at its proxy; a refusal
behind a proxy telling the client's address and the proxy's port; an entry's node forms and its one
form. The generator reads an entry by the same grammar, with Python's `ipaddress` for the networks.
Twins by the same sentence ([0004](0004-one-behaviour-in-every-language.md)) hold what no step
reaches: the build refusals, the walk and the grammar function by function, the dual-stack socket,
and the gauge with the health it warns on. `docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
the round on the footguns before 0.4.0, told in
[0010](0010-a-request-presents-a-credential-of-a-scheme.md); its rows on the client's address are
kept here, each with the answer that holds. The user took the hop bound later, and `trustedProxies`
on the HTTP server alone for now.

### On the footguns before 0.4.0

| Objection                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The walk takes an entry "when it is an address", a grammar left to each platform: the two sides already read `[2001:db8::1]:443` apart, an `IP:port` entry — Azure Application Gateway's default — ends the walk at the proxy, and an IPv4-mapped or upper-case IPv6 entry is a second key of the bound (T1) | Accepted: 15.12 states an entry's grammar, RFC 7239 §6's node forms unquoted, a bare or bracketed IPv6 address and an IPv4 one, each with or without its port, which is dropped; a zone, a name or `unknown` ends the walk. Every address read, and the socket's, is held in one form, IPv4-mapped as IPv4 and IPv6 as RFC 5952 §4 writes it, hexadecimal throughout, for matching, counting and telling. One transports case plays the forms on both sides, the generator reading them by the same grammar, and the C# divergence closes in the change. |
| Prefix 0 trusts what every client writes, the walk unbounded: `0.0.0.0/0` hands every client its own address, out of the bound and into every told refusal; ASP.NET Core keeps that case safe by `ForwardLimit` (T5)                                                                                         | Accepted: a network of prefix 0 is refused as built, its message saying it trusts what every client writes, a tripwire for the copied line as `origins` refuses `*`. The hop bound for proxies of unknown address was put to the user, who took it later; until then, the READMEs say, such a deployment counts one address per proxy.                                                                                                                                                                                                                   |
| The tell arrives only as a 503 under load, in production, this footgun's signature; a gauge of the busiest address under its ceiling would warn first, on machinery both sides have (T4)                                                                                                                     | Accepted: each side's HTTP transport gauges `largestAddressConnections`, its ceiling `maximumConnectionsPerAddress`, which the health check warns on at 80%: 52 connections from one address, before any 503. One count, no set a peer grows, so 0026's reason does not reach it; both READMEs name it beside the told `busy`.                                                                                                                                                                                                                           |
| A bound keyed by one address still refuses the 65th user behind a NAT, and lets an IPv6 host with a /64 escape it; the record that defines the client's address should say so (T8)                                                                                                                           | Accepted: 15.12, this record's Consequences and both READMEs name both limits. Keying IPv6 by a prefix and a per-address value fit for a NAT are each ahead, by a decision of their own; no wire or case changes now.                                                                                                                                                                                                                                                                                                                                    |
