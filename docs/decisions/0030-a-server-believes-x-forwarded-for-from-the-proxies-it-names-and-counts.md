# 0030 — A server believes `X-Forwarded-For` from the proxies it names and as many unnamed ones as it counts

- **Status**: accepted
- **Scope**: the protocol, and every implementation's HTTP and WebSocket server transports: in
  [`spec/spec.md`](../../spec/spec.md), 15.12's client address — `trustedProxies`,
  `unnamedProxies`, the walk they bound, an entry of `X-Forwarded-For` and its one form — which an
  HTTP server's `maximumConnectionsPerAddress`, a connection's handle and every refusal told read.
  The bound itself is 15.12's table; the refusal told,
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)'s;
  the listening address and the form of an IP literal,
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

**Some proxies cannot be named.** Heroku's router appends "the originating IP address of the client
connecting to the Heroku router", its own addresses unpublished. Google Cloud's global external
Application Load Balancer appends two entries, `<client-ip>,<load-balancer-ip>`, and "does not
verify any IP addresses that precede" them; it connects to instance-group, zonal and hybrid
network endpoint group backends from `130.211.0.0/22` and `35.191.0.0/16`, the regional one from
the operator's proxy-only subnet, and the second entry is the forwarding rule's address, the
operator's own; its serverless backends, Cloud Run behind it, are reached from no fixed range
([External Application Load Balancer overview](https://docs.cloud.google.com/load-balancing/docs/https)).
AWS's Application Load Balancer appends one entry by default, from inside the VPC, whose network a
list names; Cloudflare publishes its ranges; nginx's `real_ip_recursive` has no count. A path that
holds one proxy a list cannot name, Heroku's router or Cloud Run's front, reads its client as that
proxy until the server counts it.

**The peers compose a count and a list four ways**, read for this decision. Envoy's
`xff_num_trusted_hops` is "the number of additional ingress proxy hops from the right side of the
x-forwarded-for HTTP header", and "Only one of `xff_num_trusted_hops` and `xff_trusted_cidrs` can
be set" ([Envoy, `xff.v3`](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/http/original_ip_detection/xff/v3/xff.proto)).
Traefik's `ipStrategy`: "If `depth` is specified, `excludedIPs` is ignored"
([Traefik, IPAllowList](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ipallowlist/)).
ASP.NET Core's `ForwardedHeadersMiddleware` ANDs `ForwardLimit` with its lists, measured on .NET 10,
every request from `127.0.0.1`: at its defaults, a limit of 1, `KnownProxies` `[::1]` and
`KnownIPNetworks` 127.0.0.0/8, `198.51.100.7, 10.0.0.5, 10.0.0.6` reads `10.0.0.6`; with
10.0.0.0/8 known and a limit of 1, still `10.0.0.6`, the second known proxy taken for the client;
with the limit `null`, `198.51.100.7`; its lists cleared, a limit of n reads n entries whatever
their address. A hop must be known and within the count, and an unknown hop is never passed while a
list is set. Express (`proxy-addr` 2.0.7, read) trusts the address at index `i < n` of the socket
and the entries from the right, whatever it is, a number and a list combining only through a
function; its guide warns that where a client can be fewer than n hops away "it may be possible
for the client to provide any value". Envoy
and Express call a count of every hop by one name, the trusted hops. None spends a count on the
addresses a list does not hold alone.

**The platforms read an entry apart.** `IPAddress.TryParse` takes `[2001:db8::1]:443`, a bracketed
address with its port, and a zone; Node's `isIP` takes none of them. Azure Application Gateway
writes an address with its port by default. An IPv4-mapped address, or an IPv6 one written in
another case or uncompressed, would be a second key of the bound and a second form in what is told.

The options weighed:

- **A count alone**, Express's `n`, Envoy's hops, ASP.NET Core's limit with its lists cleared: it
  serves a proxy of unknown address, not a path that mixes a proxy the list names and one it cannot.
- **A count or a list, never both**, Envoy's rule: no reading to confuse, but a path that mixes them
  falls back to the count of every hop. Cloudflare's ranges in front of a router at the socket whose
  addresses are unknown then need a count of 2, and a request sent straight to the router, past
  Cloudflare, has its client write the entry the count takes for Cloudflare's: spoofed. Put to the
  user, under Envoy's name; not taken.
- **A count bounding the list**, ASP.NET Core's AND: it bounds what the list already bounds, takes
  the second named proxy for the client at its default, and never passes an unknown hop beside a
  list, the case a count is for.
- **A count by index beside the list**, `i < n` or listed, Express's function form: the nearest n
  hops whatever their address, the list past them, so a sidecar the list names in front of an
  unknown router needs n = 2, the sidecar counted though named.
- **A count of the proxies the list does not name**: taken. A hop whose address the list holds
  costs nothing, any other one of n, and the walk stops at the first address that is neither. n is
  the operator's reading: how many proxies on every path to the server the list cannot name, one
  each. Heroku's router at the socket counts one; so does a sidecar on `127.0.0.1`, listed, before
  Heroku's router; so do Cloudflare's ranges listed before an unnamed router at the socket, and a
  request sent straight to the router is read by the entry the router appended, never by what its
  client wrote. Cloud Run behind Google Cloud's load balancer counts one too, the socket unnamed and
  the forwarding rule's address listed, read from the overview's two entries, to confirm against
  the header the platform writes there, as every count is.
- **The list first, wherever a platform publishes its addresses.** Google Cloud's global load
  balancer serves with `130.211.0.0/22`, `35.191.0.0/16` and the forwarding rule's address, and no
  count — the socket in a listed range, the rightmost entry the listed forwarding rule, the next the
  client; Cloudflare with its published ranges; an AWS ALB with its VPC's network. A list checks
  who connected; a count believes whatever address connects.
- **Its name**: `trustedHops` is Envoy's and Express's word for a count of every hop, so an operator
  reading it their way counts "two proxies", sidecar and router, beside a list naming the sidecar —
  one too many, which hands the client the address it writes. `unnamedProxies`, named for what it
  counts.
- **Its maximum**: none, or 2³¹ − 1, or `Infinity`, would be every client's own word by another
  name; a small one, refusing that count as prefix 0 is refused, is a tripwire and not a wall. 8,
  past any path a platform documents, one unnamed proxy and the ones that publish their ranges
  listed.
- **The loopback by name**, as Express's `loopback`: `127.0.0.0/8` and `::1` say it in the form
  every entry takes.
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

**`trustedProxies`, `TrustedProxies`, names the proxies a server believes**, over HTTP and over
WebSocket alike (spec 15.12):
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

**`unnamedProxies`, `UnnamedProxies`, counts the proxies on every path to the server that
`trustedProxies` does not name**, one for each proxy whose addresses its platform does not publish,
over HTTP and over WebSocket alike (spec 15.12): a whole number from 0 to 8, 0 by default, refused
as the transport is built otherwise, `ProgrammerError` and `ArgumentException` naming
`unnamedProxies` — a fraction, `NaN` and `Infinity` among it, the count of every hop, which would
trust what every client writes. A proxy whose addresses are published is listed, never counted.
**The composition is Bead's own**, and departs from each peer's: Envoy refuses a count beside a
list, Traefik ignores the list once a depth is set, ASP.NET Core ANDs its limit with its lists, and
Express counts by index; here a listed proxy costs none of the count, wherever it stands, so the
count serves the path no peer's serves, a listed proxy in front of an unnamed one, and a proxy both
named and counted gives the client one entry it wrote, which a case pins. **A count is believed as
told**: a request that reaches the server by a path with fewer such proxies, straight to its socket
or past a proxy it counts, is read by entries its client wrote; a server so reachable names its
proxies instead, and 15.12 says so.

**The walk goes from the right** (nginx's `real_ip_recursive`, Express's `proxy-addr`): from the
socket's address, while the address reached is one the list holds, or one it does not while fewer
than `unnamedProxies` such addresses were passed, which then counts it, and the field, its lines
joined by ", ", has an entry left, the next entry from the right is taken when it is an address. The
client is the address so reached. Entries to the left of where the walk stops, which a client may
write, are never read. Through the proxies the list holds, the walk is unbounded in hops, as
nginx's and `proxy-addr`'s, and safe while no listed network holds a client's address; past them,
it goes as far as the count. One walk module per side reads both, for both transports.

**An entry's grammar is stated, not left to a platform's parser**: one of
[RFC 7239 §6](https://www.rfc-editor.org/rfc/rfc7239#section-6)'s node forms, unquoted and not
obfuscated — a bare IPv4 address, a bare IPv6 address with no zone, `IPv4:port`, `[IPv6]` or
`[IPv6]:port` — its port dropped. A zone, a name, `unknown`, an obfuscated node or an empty entry is
no address, and ends the walk where it is, within the count as within the list. **Every address is
held in one form**, read from the field or from the socket, for matching, counting and telling: an
IPv4-mapped address as its IPv4 address
([RFC 4291 §2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2)), any other IPv6
address in [RFC 5952 §4](https://www.rfc-editor.org/rfc/rfc5952#section-4)'s text, lowercase and
compressed, hexadecimal throughout, so one client is one key whether it came direct or through a
proxy. ASP.NET Core's `ForwardedHeadersMiddleware` reads an entry as an endpoint and unmaps it
before checking its known proxies; this is the same reading, stated.

**`X-Forwarded-For` alone is read**; `Forwarded` is not, and 15.12 says so. **A WebSocket server
takes the same list and the same count, refuses the same entries and counts as it is built, and
walks the field of the request that asks its upgrade**, by the module the HTTP transport walks it
with, on each side. It bounds no address, so what the walk moves is the address its handles and its
refusals name: behind the proxies it names and counts, the client's, where the proxy's would be.
One option of each on both transports, as `hosts` and `origins` are, so a deployment that puts both
behind one proxy tells each alike.

**No event; a gauge.** Each side's HTTP transport gauges `largestAddressConnections`, the
connections its busiest address holds, under its ceiling `maximumConnectionsPerAddress`, as
`largestOutboxBytes` sits under `maximumOutboxBytes`. One count, no set a peer grows. The health
check warns at 80% of any ceiling, so a proxy left off the list or uncounted shows `warn` on
`/health` at 52 connections from one address, before any 503. A gauge is no part of the spec: twins
by the same sentence hold it.

## Consequences

**A deployment names its proxy's network**: a container's nginx or a Kubernetes ingress lists the
compose network's or the cluster's (`10.0.0.0/8`, say), a proxy on the same machine lists
`127.0.0.1`, and a platform that publishes its ranges is named by them — Google Cloud's global load
balancer by `130.211.0.0/22`, `35.191.0.0/16` and its forwarding rule's address, Cloudflare by its
ranges, an AWS ALB by its VPC's network. **One it cannot name is counted**, a PaaS router such as
Heroku's, `unnamedProxies: 1`, beside a list of the proxies it can name. A count one too high shows
its client's own address where a proxy's was expected, in a told refusal and in `clients`; one too
low, the proxy's, which `largestAddressConnections` near its ceiling warns of. Both READMEs show the
list first and the count for the router.

**A bound keyed by address counts the users of one NAT as one and an IPv6 network's addresses as
many**: behind a carrier-grade or a corporate NAT, the 65th user is refused 503 whatever the list
says; an IPv6 host holds a /64 or more ([RFC 6177](https://www.rfc-editor.org/rfc/rfc6177),
[RFC 7421](https://www.rfc-editor.org/rfc/rfc7421)) and walks out of a bound keyed by one address.
15.12 names both.

**Ahead, each by a decision of its own**: `Forwarded`, once a proxy that writes it alone is met;
IPv6 keyed by a prefix; a per-address value fit for a NAT.

**The gate.** `spec/transports.json`, played by both sides. Over HTTP: the bound behind a proxy
named; a field from a socket no entry holds, not read; the walk past two networks, what a client
wrote to the left never read; an entry that is no address ending the walk at its proxy; a refusal
behind a proxy telling the client's address and the proxy's port; an entry's node forms and its one
form; behind the proxies it counts, the client that many hops from the socket; a count spent on the
addresses the list does not hold alone; a listed socket and a count of 2 reading the entry its
client wrote; an entry that is no address, and the field's end, ending the walk within the count;
and 0 counting none. Over WebSocket: an upgrade's refusals behind proxies named, telling the client
the walk reaches, in the node forms and the one form, and the proxy's port; a field from a socket
no entry holds, not read; and a refusal behind the proxies it counts. The generator walks the field
by the same rule, with Python's `ipaddress` for the networks. Twins by the same sentence
([0004](0004-one-behaviour-in-every-language.md)) hold what no step reaches: the build refusals, on
each server transport, `refuses as it is built a trustedProxies entry that is a name or a network
of prefix 0, or an unnamedProxies past 8`, and in each side's walk module `refuses an
unnamedProxies that is not a whole number from 0 to 8, Infinity among it, as the server is built`;
the walk and the grammar function by function, `spends unnamedProxies on each address
trustedProxies does not hold, none on one it holds, and stops at the first past the count` among
them; the dual-stack socket; a WebSocket connection's handle named by its client's address; and the
gauge with the health it warns on. `docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
two rounds. The first, on the footguns before 0.4.0, is told in
[0010](0010-a-request-presents-a-credential-of-a-scheme.md); its rows on the client's address are
kept here, and the user put `trustedProxies` on both server transports. The second, on an upgrade's
credential, both loopbacks and the proxies a server counts, is told in
[0032](0032-a-websocket-upgrade-from-no-page-carries-its-credential-beside-every-envelope.md); its
rows on the count are kept here, and the user chose the count of the proxies the list does not
name, `unnamedProxies`, over Envoy's rule, a count or a list. Each objection, with the answer that
holds:

### On the footguns before 0.4.0

| Objection                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The walk takes an entry "when it is an address", a grammar left to each platform: the two sides already read `[2001:db8::1]:443` apart, an `IP:port` entry — Azure Application Gateway's default — ends the walk at the proxy, and an IPv4-mapped or upper-case IPv6 entry is a second key of the bound (T1) | Accepted: 15.12 states an entry's grammar, RFC 7239 §6's node forms unquoted, a bare or bracketed IPv6 address and an IPv4 one, each with or without its port, which is dropped; a zone, a name or `unknown` ends the walk. Every address read, and the socket's, is held in one form, IPv4-mapped as IPv4 and IPv6 as RFC 5952 §4 writes it, hexadecimal throughout, for matching, counting and telling. One transports case plays the forms on both sides, the generator reading them by the same grammar, and both sides read an entry alike. |
| Prefix 0 trusts what every client writes, the walk unbounded: `0.0.0.0/0` hands every client its own address, out of the bound and into every told refusal; ASP.NET Core keeps that case safe by `ForwardLimit` (T5)                                                                                         | Accepted: a network of prefix 0 is refused as built, its message saying it trusts what every client writes, a tripwire for the copied line as `origins` refuses `*`. A deployment whose proxies cannot be named counts them, `unnamedProxies`, at most 8, a count of every hop refused as built alike.                                                                                                                                                                                                                                           |
| The tell arrives only as a 503 under load, in production, this footgun's signature; a gauge of the busiest address under its ceiling would warn first, on machinery both sides have (T4)                                                                                                                     | Accepted: each side's HTTP transport gauges `largestAddressConnections`, its ceiling `maximumConnectionsPerAddress`, which the health check warns on at 80%: 52 connections from one address, before any 503. One count, no set a peer grows, so 0026's reason does not reach it; both READMEs name it beside the told `busy`.                                                                                                                                                                                                                   |
| A bound keyed by one address still refuses the 65th user behind a NAT, and lets an IPv6 host with a /64 escape it; the record that defines the client's address should say so (T8)                                                                                                                           | Accepted: 15.12, this record's Consequences and both READMEs name both limits. Keying IPv6 by a prefix and a per-address value fit for a NAT are each ahead, by a decision of their own, which neither the wire nor a case holds.                                                                                                                                                                                                                                                                                                                |

### On the proxies it counts

| Objection                                                                                                                                                                                                                                                                                                                                                                        | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trustedHops` composes with the list as no peer does — Envoy refuses both, Traefik drops the list, ASP.NET Core ANDs them, Express counts by index — under the name Envoy and Express give a count of every hop: an operator reading it their way sets 2 for "sidecar and load balancer" beside a list naming the sidecar, one too many, and the client's own entry is read (O4) | Accepted: the composition stays, for the path no peer's serves — a listed proxy in front of an unnamed one, where a request sent straight to the unnamed one is read by its own entry — and it is named for what it counts, `unnamedProxies`, `UnnamedProxies`; 15.12 and this record name the departure from the four peers and add that a proxy both named and counted gives the client an entry it wrote; a case pins the reading, a listed socket and a count of 2 reading the entry its client wrote. Envoy's rule, a count or a list, was the alternative put to the user, who kept the count of the proxies the list does not name. |
| Google Cloud's load balancer is a case for the list — its front ends connect from published ranges and the second entry is the operator's forwarding rule — yet the draft steers it to the count, "two for a proxy that writes two entries"; the same holds for Cloudflare and an AWS ALB's VPC; the count serves only a router whose addresses are unpublished (O5)             | In part: 15.12, the doc and the READMEs say "one for each proxy whose addresses its platform does not publish", drop the two-entry example, and show Google Cloud's global load balancer by its list, `130.211.0.0/22`, `35.191.0.0/16` and the forwarding rule's address, with Cloudflare and an AWS ALB beside it. Not all of Google Cloud: its serverless backends, Cloud Run behind the load balancer, have no fixed ranges (its overview), so the socket stays unnamed there and is counted, the forwarding rule listed beside it, its count to confirm against the header written there. The maximum stays 8.                        |
