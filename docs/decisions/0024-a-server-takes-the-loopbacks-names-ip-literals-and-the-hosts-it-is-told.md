# 0024 — A server listens on the loopback, takes the loopback's names, IP literals and the hosts it is told, each named by a request's authority

- **Status**: accepted
- **Scope**: the protocol, and every implementation's server transports, over HTTP and at a
  WebSocket's address: in section 15.12 of [`spec/spec.md`](../../spec/spec.md), a request's
  authority (an absolute-form target's, HTTP/2's `:authority`, the `Host`), the grammar of a host
  and what answers one that is none on each version of HTTP, `hosts`, the hosts every server takes,
  their comparison and `*`, and the refusal of a `hosts` or an `origins` entry as a server is built;
  the host's place in 15.2's order; the address a server listens on by default, `localhost`, both
  loopbacks, its form, which 13.4's server half reads, and what it reports; the TypeScript HTTP
  transport's `createServer`, called once per address bound; the C# clients' race of a name's
  address families. What `origins`
  takes, and a client's loopback (13.4), are
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s; a connection's handle is
  [0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md)'s; the refusal a
  server tells, and a request's fields,
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)'s.

## Context

**Rebinding needs a name.** A page on `rebind.example`, whose owner points the name's DNS record at
`127.0.0.1` once the page has loaded, asks the server on the loopback with
`Host: rebind.example:8080` and its own `Origin`, so the own origin's test of 15.12 takes it, and on
the loopback, which section 13.4 counts secure, it is presented what the server presents. A server
that takes every host answers it 201 over HTTP and 101 at a WebSocket's address, measured on both
sides and both transports. The attack costs a page nothing. What stops it is the host: the WHATWG
URL Standard's host parser reads a name whose last label is a number as IPv4 and refuses it when it
is none, and serializes every IPv4 form dotted-decimal and every IPv6 one compressed, so no name a
page is fetched by is written in `Host` as an IP literal. A localhost name is kept on the loopback by
resolution: [RFC 6761 §6.3](https://www.rfc-editor.org/rfc/rfc6761#section-6.3) asks name
resolution APIs and libraries to answer it with the loopback and not to send it to their caching
server (item 3), caching and authoritative servers to answer it so themselves (items 4, 5), and
registries never to grant one (item 7); Windows 11 resolves `bead-probe.localhost`, `a.b.localhost`
and `localhost.` to the loopback, measured. Items 3 to 5 are SHOULDs: a user agent that hands a
`.localhost` name to a resolver that sends it on, to a network whose resolver answers another
address, lets a page rebind it. W3C's Secure Contexts counts a localhost name trustworthy only where
its user agent keeps its resolution local.

**The practice that met rebinding**, each with its default and its opt-out:

- **Vite**'s `server.allowedHosts`, after CVE-2025-24010, in a patch: `localhost`, the names under
  `.localhost` and every IP address taken always, before the list, "DNS rebinding attacks does not
  happen with IP addresses"; `true` takes any host; a refusal is 403, its body naming the host and
  the option; under HTTPS no check, a rebinding page failing on the certificate;
- **webpack-dev-server**'s `allowedHosts`: an IP address, `localhost` and `.localhost` taken
  whatever the list; `'all'` takes any; "Invalid Host header";
- **the MCP TypeScript SDK**, after CVE-2025-66414: the loopback's names checked by default when it
  is bound to the loopback, a given list replacing them; 403;
- **Django**'s `ALLOWED_HOSTS` and **ASP.NET Core**'s Host Filtering, `AllowedHosts`: hosts matched
  without their port, `'*'` and `*` any, a given list replacing; `DisallowedHost` names the setting,
  the filter answers 400 and is off by default. Their threat is a `Host` injected into the absolute
  URLs they build, not rebinding alone.

**A request names its target in three places.**
[RFC 9112 §3.2.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2.2): an origin server that
receives an absolute-form target "MUST ignore the received Host header field (if any) and instead
use the host information of the request-target", and "MUST accept the absolute-form"; §3.3 makes
that target the target URI. [RFC 9113 §8.3.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.3.1):
the recipient of an HTTP/2 request "MUST NOT use the Host header field to determine the target URI
if ':authority' is present", and SHOULD treat as malformed a request whose `host` differs from it.
Kestrel, on .NET 10.0.401, answers 400 an absolute-form target whose `Host` differs, and with
`KestrelServerOptions.AllowHostHeaderOverride` takes the target's authority over the `Host`; it
reads `:authority` into `Headers.Host`, a `host` beside it never reaching the application. Node 26.5
hands both HTTP/2 fields through, and its HTTP/1.1 server hands the target through as it came.

**What Kestrel refuses of a host before the application**, at both transports: a percent-encoded
octet, `*`, `+`, `,`, `;` or `=` in a name, an `IPvFuture` literal and a colon with no port, 400 over
HTTP/1.1 and, over HTTP/2, the stream reset `PROTOCOL_ERROR` with no response, seven forms measured.
No `KestrelServerOptions` relaxes it (dotnet/aspnetcore#18522 asks for one). Node takes each. A port
of any length of digits, `0` and `080` among them, is taken by both. No browser writes a
percent-encoded name, which the URL Standard decodes, nor an `IPvFuture` literal, nor an empty port;
`*+,;=` in a name reaches no DNS record anyone serves. .NET's `IPAddress.TryParse` takes `127.1`,
`0177.0.0.1`, `0x7f.0.0.1` and `2130706433`, which
[RFC 3986 §3.2.2](https://www.rfc-editor.org/rfc/rfc3986#section-3.2.2)'s `IPv4address`, four
`dec-octet` with no leading zero, does not.

**Who reaches a server is its listening address's.**
[CWE-1327](https://cwe.mitre.org/data/definitions/1327.html), "Binding to an Unrestricted IP
Address": bind the address the service is meant for. The MCP specification's Streamable HTTP
warning, on Bead's threat: "When running locally, servers SHOULD bind only to localhost (127.0.0.1)
rather than all network interfaces (0.0.0.0)", beside the `Origin` check against rebinding. The
loopback is 127.0.0.0/8 ([RFC 6890 §2.2.2](https://www.rfc-editor.org/rfc/rfc6890#section-2.2.2))
and `::1` ([RFC 4291 §2.5.3](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.3)). The practice
splits by what a server is for: on the loopback by default, Vite's `localhost`, Kestrel's
`http://localhost:5000` on both families, Django's and Flask's `127.0.0.1`, the MCP SDKs; on every
interface, Next.js, webpack-dev-server through Node's `::`, Spring Boot, Go's `":8080"`. The
security guidance is not split.

**An address is read two ways by two platforms.** Node 26.5.0's `isIP` refuses `127.1`,
`0x7f.0.0.1`, `0177.0.0.1`, `127.000.000.001`, `2130706433`, `1`, `0`, `1.2.3.04`, `127.0.0.1.`
and `[::1]`, though its `listen` binds `[::1]`; .NET 10's `IPAddress.TryParse` takes all but
`127.0.0.1.`, `0` as `0.0.0.0`, every interface, and `1` as `0.0.0.1`; both take `::ffff:127.0.0.1`
and `fe80::1%4`. Node's `listen` resolves a name and binds its first answer, `localhost` to `::1`
alone on Windows; Kestrel's `IPAddress.Parse` throws on one, and its `ListenLocalhost(0)` refuses a
dynamic port: "You must either bind to 127.0.0.1:0 or [::1]:0, or both."

**A client by `localhost` meets one family.**
[RFC 8305](https://www.rfc-editor.org/rfc/rfc8305), Happy Eyeballs: a client given a name SHOULD
race its address families, an attempt every 250 ms by default (§5), the first to connect kept.
Node's clients and the browsers do; .NET's do not. Against a server on `127.0.0.1` alone, on
Windows 11, Node's `http.request`, `fetch`, `ws` and global `WebSocket` connect by `localhost` in
1–30 ms, Chromium 153 and Firefox 155 in 5–139 ms, and .NET's `HttpClient` and `ClientWebSocket` in
2012–2054 ms, against 0–81 ms by `127.0.0.1`: .NET tries `::1` first and waits out Windows'
refusal. The same holds against `0.0.0.0`, and none against `::`. A server on `127.0.0.1:p` and
another process on `[::1]:p`: `fetch`, `ws` and `HttpClient` by `localhost` all reach the other
process on Windows; in a Linux container, whose resolver orders `127.0.0.1` first, ours.

**Both loopbacks, measured** on Windows 11 and in Linux containers, IPv6 on and off, with Node 26.5
and .NET 10. A port drawn on `127.0.0.1`, then bound on `::1` with `ipv6Only`: in 3,000 pairs on
each, the IPv6 bind never found the port taken. With both bound, another process binding
`[::1]:p` is refused `EADDRINUSE` on both, and on Linux so is every wildcard, `[::]:p` and
`0.0.0.0:p`; on Windows a wildcard binds, and `localhost`, `127.0.0.1` and `[::1]` still reach the
server, the more specific socket taking the loopback's connections; and on Windows, under
`SO_REUSEADDR`, a bind of either loopback by another process of the same user is refused
`WSAEACCES`. Where IPv6 is off, a container with `disable_ipv6` set, Node's `::1` bind is
`EADDRNOTAVAIL` and `localhost` resolves to `127.0.0.1` alone; .NET's is `AddressNotAvailable`, and
`Socket.OSSupportsIPv6` still says `True`, so nothing but the bind detects it; a kernel booted
without IPv6 answers `EAFNOSUPPORT`, `AddressFamilyNotSupported`. Kestrel's `ListenLocalhost(0)`
throws as it is built; two `Listen` on one port bind both, reported
`http://127.0.0.1:p, http://[::1]:p`; with `[::1]:p` held by another socket, `ListenLocalhost(p)`
and the two `Listen`s fail, `AddressInUseException`, no fallback on a port taken; with IPv6 off,
`ListenLocalhost(p)` logs at Information that it is "Unable to bind to http://localhost:p on the
IPv6 loopback interface", starts on `127.0.0.1` alone and still reports `http://localhost:p`, where
two `Listen`s fail. Node serves both families from one `node:http`, `node:https` or `node:http2`
instance fed by two `net.Server`s, the HTTP/2 instances' `session` firing for each; but a fed
`node:http` instance never told `listening` answers no 408 to slow headers, its connection tracking
starting on its own `listening`.

The options weighed:

- **Every host by default, a list to opt in**: every server that forgets the list stays open, which
  is CVE-2025-66414's shape.
- **A given list replacing the default**, Django's, ASP.NET Core's and the MCP SDK's: `Host` is
  written by the client, so a client that reaches the socket writes the server's name, and a page
  cannot write an IP literal or a localhost name for a name it was fetched by; refusing them guards
  nothing, and refuses `curl localhost` on the server's machine, a sidecar, a probe by a pod's
  address and every client that connects by `127.0.0.1`. No Bead server builds anything from the
  `Host` but the host's test and the own origin's.
- **The loopback's addresses alone, not every IP literal**: refusing `192.168.1.5:8080` guards
  nothing, and refuses a server on `0.0.0.0` reached by its address on the network.
- **The opt-out spelled `['*']`**, Django's and ASP.NET Core's; Vite's `true`, a union type on both
  sides; a boolean beside `hosts`, a combination to refuse.
- **421**, a request misdirected
  ([RFC 9110 §15.5.20](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.20)), whose client "MAY
  retry … over a different connection", against 403, which
  [RFC 9110 §7.4](https://www.rfc-editor.org/rfc/rfc9110#section-7.4) lets a server answer a target
  it does not serve.
- **No check under TLS**, Vite's: a Bead server's TLS is mostly ended in front of it, `secure` the
  application's word, and the clear port behind the proxy is the one a page on that machine
  rebinds to.
- **`127.0.0.1` by default**: an IP literal, which 13.4 judges by itself and both sides bind alike;
  every client reaches it by `localhost` once it races; another process may listen on `[::1]` on
  the same port and answer a client that tries that family first, on Windows every one by
  `localhost`.
- **Both loopbacks**, Kestrel's `localhost`: no capture and no wait for any client, at the cost of
  two listeners per transport, a port drawn again when the other family holds it, and a start on
  one family where IPv6 is off. Taken, as the next options settle it.
- **What it is called and what it reports**: `localhost`, a keyword the start takes and never
  resolves, reported `localhost` when both are bound and `127.0.0.1` when the IPv6 loopback is
  absent, the report being what was bound: taken. No address by default, reported `127.0.0.1`, is
  one of two; a list, `addresses`, changes every transport's address for a value no caller needs.
  Kestrel's `ListenLocalhost` refuses a drawn port and misreports its fallback, so the C# side binds
  the two endpoints itself.
- **A port drawn**: refusing `findOpenPort` with both refuses how every test and README example
  starts; `127.0.0.1:0` bound first, then `::1` on its port, drawn again when the other family holds
  it, eight attempts, then the last error: taken. Kestrel cannot add an endpoint once started, so
  the C# side draws the port by a socket bound to `127.0.0.1:0` and closed, then binds both, a port
  taken in that gap drawn again within the same eight.
- **The IPv6 loopback absent**, `EADDRNOTAVAIL` or `EAFNOSUPPORT`, `AddressNotAvailable` or
  `AddressFamilyNotSupported`: listening on `127.0.0.1` alone and reporting it, since no process can
  take `::1` there either — a container with IPv6 off being where Bead's CI replays and where a
  sidecar on the loopback starts with its defaults — as Kestrel's `ListenLocalhost` falls back:
  taken. Refusing to start fails every default start in such a container, for a capture that cannot
  happen there. A port taken on `::1` is never a fallback: it is the capture itself, and the start
  fails, as Kestrel's does.
- **The TypeScript mechanism**: one instance fed by two `net.Server`s loses `node:http`'s guard
  against slow headers unless `listening` is emitted by hand, an internal the transport would lean
  on; two instances, each listening on one family itself, rely on no internals of Node. The HTTP
  transport's `createServer` is the application's, so calling it twice is a contract the option
  states: called once per address bound, told it as `{ address }`, every instance configured
  alike. The WebSocket transport's two `http.Server`s are its own, each with its
  `WebSocketServer`.
- **`::1` by default**: not reached by `127.0.0.1`, which the interop, the examples and every
  runner connect by, and no start where IPv6 is off.
- **An address required**: meets CWE-1327 too, but every other start option has a default, and
  `start()` with nothing is each README's first example.

## Decision

**A request's authority is one term, read once** (spec 15.12): an absolute-form target's, the `Host`
beside it ignored; over HTTP/2, `:authority`, a `host` beside it ignored; otherwise the `Host`; a
request with none names no host. It serves every place 15.12 judges a host and the server's own
origin, which is `http://` or `https://` followed by that authority, port included
([RFC 6454 §4](https://www.rfc-editor.org/rfc/rfc6454#section-4)). The C# side sets
`AllowHostHeaderOverride` on both transports, RFC 9112 §3.2.2's conforming form of Kestrel; the
TypeScript side reads the authority and the path from the target by hand, as it reads the rest of a
request, never through a URL parser. Both read it as it came, where Kestrel's `Uri` drops a userinfo
and an empty port: a target in absolute-form is read when it is `http://` or `https://`, its scheme
in lower case as Kestrel reads it though
[RFC 3986 §3.1](https://www.rfc-editor.org/rfc/rfc3986#section-3.1) reads a scheme in any case,
then an authority of 15.12's grammar that is not empty
([RFC 9110 §4.2.1](https://www.rfc-editor.org/rfc/rfc9110#section-4.2.1)), so a userinfo, which
[RFC 9110 §4.2.4](https://www.rfc-editor.org/rfc/rfc9110#section-4.2.4) has a recipient treat as an
error, and a colon with no port are none; any other is answered 400. The `Host` beside it is judged
as one field line, its form not, as Kestrel judges it under the option, and an HTTP/1.0 request
may leave it out. No browser sends an absolute-form target to an origin server,
and a client that writes the target writes the `Host` too, so taking the target's over a differing
`Host` reopens no rebinding. RFC 9113's SHOULD is followed by neither side: Kestrel hands the C#
application `:authority` alone, and a page cannot write `host`, a forbidden header name.

**A host is of 15.12's grammar**, a restriction of RFC 3986 §3.2.2 written in
[RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)'s ABNF: an IPv6 address in brackets, an
`IPv4address`, or a name of `unreserved` characters and `!$&'()`, and a port of one digit at least.
Kestrel's refusals are its source, under [0004](0004-one-behaviour-in-every-language.md)'s rule:
where one side does Y and another can do Y and Z, every one does Y; the spec gives no platform as
its reason. A host that is not of it is answered as its version of HTTP answers a malformed request:
400, unmarked, over HTTP/1.1; over HTTP/2 the stream reset `PROTOCOL_ERROR`, no response written
([RFC 9113 §8.1.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.1.1)), whose response first is
a MAY neither side takes.

**Every server takes `localhost`, a name that ends in `.localhost`, an IPv6 address in brackets and
an `IPv4address`**, written as its list, the rebinding argument its reason: an IP literal names no
DNS record to rebind and no fetched name is written as one, and a localhost name is answered with
the loopback by the resolvers RFC 6761 §6.3 asks it of. Nothing else: not an empty host, not none,
and not `localhost.`, which [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s choice of
the field as it comes refuses, not safety. A request's host is compared by its `uri-host` alone, its
port aside, since a browser leaves a scheme's default port out
([RFC 9110 §4.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-4.2.3)), ASCII
case-insensitively, in the form the field carries it.

**`hosts` takes the hosts it lists besides those**, each a host without its port: `hosts: []` is the
default alone, a list from a configuration that came empty meaning no more than none, and
`hosts: ['*']` takes every host, an empty one and none, the opt-out the user chose for keeping the
option's type on both sides, `readonly string[]` and `IReadOnlyList<string>`, and
`spec/transports.json`'s schema. `*` is no host under 15.12's grammar, so the entry means nothing
else. It takes a page that rebinds its name at the host's test, and makes no origin its own by a
host it did not name, so the origin's test refuses that page, 403 `origin-refused`, told with its
origin: every request a page makes without a token carries an `Origin`
([Fetch §3.1](https://fetch.spec.whatwg.org/#origin-header)). A server's own origin is its request's
authority only when that authority's host is taken by name, one every server takes or one `hosts`
lists (spec 15.12): a name the server checked, never the one a rebound page's browser resolved (RFC
6454 §5), as the `Host` test that defends against rebinding asks (Jackson et al., "Protecting
Browsers from DNS Rebinding Attacks", 2007). Refusing `*` at start on a loopback or private address
is not taken: it decides nothing for `0.0.0.0` and `::`, and behind the own-origin rule a rebound
page reaches no exchange.

**A server is refused as it is built a misconfigured list**, as Bead refuses a timeout of 0
(`ProgrammerError` on the TypeScript side, `ArgumentException` on the C# side, naming the entry): a
`hosts` entry with a port, an empty one, one that is no host (a Unicode IDN among them, which the
field never carries), or `*` beside another; an `origins` entry that is `*`, its message saying that
no origin wildcard exists and that taking every page is `hosts: ['*']`'s and an origin check's
absence; one that is `null`, its message saying that a browser sends it for every page with no
origin of its own, a sandboxed frame of any site among them, and to serve the page from an origin
and name that one (RFC 6454 §6.2; OWASP's HTML5 Security Cheat Sheet, CWE-942); or one that is not
an origin as
[RFC 6454 §6.2](https://www.rfc-editor.org/rfc/rfc6454#section-6.2) serializes it: its scheme and
host in lower case, the host ASCII and of 15.12's grammar, no port where it is the scheme's default
(`http` and `ws` 80, `https` and `wss` 443), nothing after. A scheme of another kind, an
extension's or an app shell's, is taken as written, since a browser serializes it so. CORS's
`Access-Control-Allow-Origin: *` is a response header, never a list a server compares against, and
one no Bead server writes
([0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)).

**403 `host-refused` stays**, on every listener, under TLS or not: 421 means "retry over a different
connection" to its client, which is meaningless at a WebSocket's address, and no MUST overrides it.
The host is judged first, over HTTP before the path and at a WebSocket's address right after HTTP's
own 400, before the method; the origin after. `origins` never widens `hosts`: a page named in
`origins` still asks the server by a host it takes.

**A server listens on `localhost`, both loopbacks, unless it is given an address** (spec 15.12),
on both transports of both sides, as Kestrel's `ListenLocalhost` does: `127.0.0.1` and `::1` on one
port, `localhost` a keyword the start takes and never resolves, as 13.4 takes it. It binds
`127.0.0.1` first, on the port it is given or on one drawn there, then `::1` on that port, IPv6
alone; a port another socket holds on either family fails the start, and a port drawn is drawn
again, eight times at most. **Where the IPv6 loopback is absent**, its bind refused for want of the
address or of the family, it listens on `127.0.0.1` alone **and reports `127.0.0.1`**, where Kestrel
reports `localhost`: told, never silent. Both loopbacks leave the capture by the other family no
address. The TypeScript HTTP transport calls the application's
`createServer(listener, { address })` once per address it binds, `127.0.0.1` then `::1`, and a port
drawn again listens again on the instances built; every instance is to be configured alike — a
certificate rotated, an SNI context added, a timeout, a `tlsClientError` listener — since an
application that keeps "the" server would reach one family. The C# side binds `IPAddress.Loopback`
and `IPAddress.IPv6Loopback` itself in one Kestrel application, its port drawn by a socket when
`FindOpenPort`, its fallback by rebuilding the application on `127.0.0.1` alone; never
`ListenLocalhost`. The shared listener that couples transports, once it comes, binds the pair once
for those it serves, by this rule. The address keeps the network out, and `hosts` a page on the
server's own machine that rebinds its name to the loopback, which the address cannot; neither
stands for the other. A server the network reaches is one its application opened, `0.0.0.0` or
`::`, and names its hosts.

**An address given is `localhost` or an IP address, by RFC 3986's grammar**: `localhost`, exactly,
no other case, no `localhost.` and no name under `.localhost`; or an `IPv4address` or an
`IPv6address` of [RFC 3986 §3.2.2](https://www.rfc-editor.org/rfc/rfc3986#section-3.2.2), written
bare, no brackets and no zone, and not IPv4-mapped, an IPv4 node's address being written as one
([RFC 4291 §2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2)), which it listens on
alone. Both sides test an IP address with the matchers this decision writes for a host, extracted
to a bare form, `isIPAddress` and `IsIpAddress`, which stay predicates of IP literals, never `isIP`
nor `TryParse` alone, so that `0` binds no interface on either. Any other is refused as the start
begins, `ProgrammerError` and `ArgumentException`, "a server listens on an IP address, or on
localhost, both loopbacks, not …", "write ::1, not [::1]" for a bracketed one, the transport ending
closed as a failed start does. The wildcards are IP addresses, and taken.

**13.4's server half reads that address alone**: a server is on the loopback when its address is in
127.0.0.0/8, is `::1`, or is `localhost`, both. The forms the URL parser normalizes, `127.1`,
`127.0.0.1.` and the localhost names, stay what a client's URL may name; an IPv4-mapped address is
refused, so 13.4 meets none.

**Both C# clients race the address families of a name**, as RFC 8305 asks and as Node's clients and
the browsers do: one connect resolves the name in the platform's order (RFC 6724), interleaves the
families, starts an attempt every 250 ms until one connects, and cancels the rest, under the HTTP
client's default handler and the WebSocket client's connect; a `Handler` the application gives keeps
its own behaviour. The TypeScript side has it from Node.

## Consequences

**A server reached by a name names it in `hosts`, or refuses it, 403 `host-refused`**: a public
server, one behind a proxy that keeps the `Host` (Caddy's and Traefik's default), and a service
reached by its in-cluster name, a docker-compose service or a Kubernetes Service. A proxy that
writes its upstream's address as the `Host`, nginx's default `$proxy_host`, sends an IP literal or
`localhost`, taken; so do a probe by a pod's address and `curl localhost`.

**A refused host is told on the wire, by the clients and by the server**, which tells each refusal
it judges of its own
([0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)). The
refusal is 403 with `bead-refusal: host-refused`, which `curl -i` and a browser's network panel
show; both HTTP clients and both WebSocket clients, over `ws` and on the C# side, name it; the
server's `refusal` event carries the authority to add to `hosts`. A page's WebSocket reads none, a
close 1006 and nothing more.

**A request that names no host is refused but under `*`**: an `HTTP/1.0` request without `Host`, and
an HTTP/2 one with neither `:authority` nor `host`. No browser sends one.

**`*` leaves rebinding to the origin's test**: an application under `*` that serves its own page
names that page's host in `hosts` or its origin in `origins`. A client that is no browser and writes
its target as its `Origin` — Python's `websocket-client` does by default — is refused under `*` by a
name `hosts` does not list: list that name, or have the client write no `Origin`, as a Bead client
writes none (spec 15.2, 15.5). The residual of a `.localhost` name a user agent sends on to a
resolver that does not keep it local stays, stated in 15.12.

**A container, or any server another machine reaches, says `0.0.0.0` or `::`**, and names its hosts:
a container's loopback is its own, which a published port never reaches. A deployment that relied on
listening on every interface without saying it meets a refused or reset connection from outside,
never a Bead refusal, since no socket opens: both READMEs say it where they say how to start a
server.

**A server on its defaults is secure by 13.4**, so a command of its own that presents a `JWT` goes;
a proxy on the same machine that serves the network in the clear says `secure: false`, as one does
behind any server it reaches on the loopback.

**An address that is a name, or a form outside the grammar, fails the start**, on both sides.

**A server on its defaults leaves no loopback port to another process**: no other process binds
`[::1]:p` beside it, on Windows or Linux, under `SO_REUSEADDR` on Windows too, nor any wildcard on
Linux, and on Windows a wildcard binds but takes no loopback client. **A server given one loopback
keeps the residual**: another process listening on the other family's loopback, on the same port,
answers every client by `localhost` that tries that family first, a bearer credential presented
there by default since 13.4 judges `ws://localhost` secure; 15.12 names it.

**Where the IPv6 loopback is absent**, a container with IPv6 off, a server on its defaults listens
on `127.0.0.1` alone and reports it, and no process can take `::1` there either.

**An application that configures the TypeScript HTTP transport's server after building it
configures each instance** its `createServer` is called for, `{ address }` telling them apart; a
factory that ignores the argument builds them alike.

**A client of another library that does not race** pays Windows' refusal of `::1`, about two
seconds a connect by `localhost`, against a server given `127.0.0.1` alone; every Bead client and
every browser races.

**The gate.** The cases of `spec/transports.json` that cite 15.12, played by both sides: the hosts
every server takes, a list adding to them, `[]`, `*` and the origins it makes none of its own, an
absolute-form target, over HTTP and at a WebSocket's address, and the forms a host is not, answered
400 as HTTP answers them. A build refusal and HTTP/2 are no step: twin tests hold them, by the same
sentence ([0004](0004-one-behaviour-in-every-language.md)), each side's `hosts and origins` tests
for the predicate, the grammar and the build refusals, and the HTTP transport servers' tests over
TLS for HTTP/2's `:authority` and its reset, which `docs/support.md` names among what no entry
plays. The listening address has no step, every runner starting on `127.0.0.1`: twins hold it, each
transport server's `listens on localhost when given no address, both loopbacks on one port, reached
by 127.0.0.1, by [::1] and by localhost, reports localhost, and is secure there`, `refuses to start
on localhost when another socket holds the other loopback's port, ending closed`, `draws a port on
localhost again when the IPv6 loopback holds the one drawn on IPv4`, `listens on 127.0.0.1 alone
where the IPv6 loopback is absent, and reports 127.0.0.1`, `refuses to start on an address that is
no bare IP address, ending closed` over the table of forms above, `localhost` taken, and `is secure
on the IPv6 loopback or an address in 127.0.0.0/8, and not on a wildcard`; the TypeScript HTTP
transport's `calls the application's createServer once per address it binds, 127.0.0.1 then ::1 on
localhost, each told its address`, held on the C# side, which builds no server of the
application's, by `serves every address it binds by one configuration`; each side's `isIPAddress`
and `IsIpAddress` over that table; each client's `connects by a name to a server that listens on
one loopback family alone, whichever it is`; and the C# side's race, `HappyEyeballsTests`.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
four rounds: the first below, which
[0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md) shares; the one on
the address a server listens on, which
[0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md) keeps, On
a refusal told and the default listening address; the one on the footguns before 0.4.0, whose row
on a server's hosts and origins is kept below, the round told in
[0010](0010-a-request-presents-a-credential-of-a-scheme.md); and the one on an upgrade's
credential, both loopbacks and the proxies a server counts, told in
[0032](0032-a-websocket-upgrade-from-no-page-carries-its-credential-beside-every-envelope.md), whose
row on both loopbacks is kept below. Each objection, with the answer that holds:

### On a server's hosts and a connection's handle

| Objection                                                                                                                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP/2 escapes the alignment: Kestrel reads `:authority` over `host` and resets the stream for each form it refuses, while the TypeScript side reads `host` first and judges no form over HTTP/2, against RFC 9113 §8.3.1's MUST NOT; under the draft it would take `localhost:` and `[v1.bead]` and take a pair the C# side refuses                                          | Accepted: measured over HTTP/2 in clear, Kestrel resets seven forms `PROTOCOL_ERROR` with no response and reads `:authority`; Node hands every form and both fields through. 15.12 names a request's authority, `:authority` before `host` over HTTP/2, writes the narrowing as an ABNF of its own instead of "a common HTTP server refuses them", and answers a form that is no host with 400 over HTTP/1.1 and a stream reset over HTTP/2 (RFC 9113 §8.1.1); this record names Kestrel as the grammar's source under the parity rule. The TypeScript side resets through the HTTP/2 compatibility response's stream. RFC 9113's SHOULD, a differing `host` treated as malformed, is followed by neither side, since Kestrel hands the C# application `:authority` alone; a page cannot write `host`. HTTP/2 twins on both sides, the C# ones writing their HEADERS frame by hand, since `HttpClient` derives `:authority` from its URI |
| An absolute-form target is a divergence under the sentence the draft rewrites: RFC 9112 §3.2.2 has an origin server accept it and use its authority; the TypeScript side answers it 404 and judges `Host` at a WebSocket's address, Kestrel answers 400 when `Host` differs                                                                                                   | Accepted: measured on both sides and on bare Kestrel. RFC 9112 §3.2.2 says outright that an origin server MUST ignore `Host` and use the target's host, and §3.3 makes the target the target URI: the standard settles it, and Kestrel's default 400 departs from it. The C# side sets `AllowHostHeaderOverride` on both transports; the TypeScript side reads the authority and the path from the target by hand. One term, a request's authority, serves HTTP/1.1 and HTTP/2 alike. No browser sends an absolute-form target to an origin server, and a client that writes the target writes `Host` too, so no rebinding reopens. Two cases, over HTTP and at a WebSocket's address, each with the own target, a rebinding target, and a target beside a differing `Host`                                                                                                                                                              |
| The breaking default ships without its diagnosis: every server reached by a name refuses it, in-cluster service names among them, which the draft does not name; Vite, webpack-dev-server and Django each tell the operator; Bead's refusal is empty-bodied, no event reports it, and neither WebSocket client reads a refused upgrade's response                             | In part: the wire carries the refusal, 403 and `bead-refusal: host-refused`, which the clients name; over the WHATWG `WebSocket`, a page's, nothing past close 1006, which no code can read further. So a tell that reaches every deployment is the server's, a public event on every server transport of every side, a design of its own: decided in a round of its own, [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md). This record and both READMEs, the C# one in its section on `Hosts` and `Origins`, say what a page's WebSocket learns, and name in-cluster service names among what breaks. With a list adding to the default (below), a probe by IP and `curl localhost` keep working                                                                                                                                                                                               |
| A given list should add to the default, not replace it: `Host` is client-written, so replacing protects nothing; Django and ASP.NET Core replace because they build URLs from `Host`, which Bead does not; Vite and webpack-dev-server, whose threat is Bead's, always take IP literals and localhost names; replacing refuses `curl localhost`, a sidecar, a probe by pod IP | Accepted: no server of either side builds anything from `Host` but the host's and the own origin's tests; a page can write neither an IP literal nor a localhost name for a name it was fetched by, so refusing them guards nothing. `hosts` takes what it lists besides what every server takes, `[]` is the default alone, `['*']` every host. The given-list cases assert that `localhost` and the IP literal are taken                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The build check stops at `hosts`: `origins: ['*']`, the reader's next guess after `hosts: ['*']`, matches nothing, as does an entry with a trailing slash, upper case or a default port, and `hosts: []` refuses everything                                                                                                                                                   | Accepted: an `origins` entry is an origin as RFC 6454 §6.2 serializes it, refused as built otherwise, `*` with a message that no origin wildcard exists, and `null` by the round on the footguns before 0.4.0 ([0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)). `hosts: []`, with a list adding to the default, means the default alone, and 15.12 says so. Twins on both sides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The drawn form `type=WS;ip=…;ordinal=n` drops the port, the one part that ties a connection to the network: the handle is the trace's only connection field, and the C# `Connection` event carries the handle alone; the TypeScript template type publishes a form 15.1 says nothing reads; 53 opaque C# fixtures need not change                                             | In part: the port stays, `type=WS;ip=…;port=…;ordinal=n`, unique by its ordinal, which settles the handle as the draw does, and traceable by its port; it costs no side a public event's change, where the C# event carrying the client record would. The TypeScript type stays a template literal, and 15.1 says a handle's form is its implementation's, compared whole by an application, so the spec and the type agree. The C# fixtures take the TypeScript ones' form: twin tests read one form, and a fixture in a form no transport writes would read as one it does                                                                                                                                                                                                                                                                                                                                                             |
| 15.12's ground for `.localhost` is not the one that holds: no registry granting a name stops nothing; resolution does (RFC 6761 §6.3 items 3 to 5); refusing `localhost.` is 0010's choice, not safety; "the hosts no page can rebind its name to" would take an empty host and none, which the same sentence refuses                                                         | Accepted: measured on Windows, `.localhost` names and `localhost.` resolve to the loopback. 15.12 and this record cite §6.3's resolution clauses and state the residual, a user agent that sends a localhost name to a resolver that does not keep it local; `localhost.` is refused for the field compared as it comes. The default is written as its list, the rebinding argument kept as its reason. No behaviour changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### On the footguns before 0.4.0

| Objection                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Under `*`, the own-origin rule refuses a non-browser client that writes its target as its `Origin` by a name `hosts` does not list — Python's `websocket-client` does by default — while the spec never says what a Bead client writes, so a third language would break under `*` alone (T6) | Accepted: the own-origin rule stays; 15.2 and 15.5 state that a client writes no `Origin`, a page's browser writing its own, which both sides already do and a twin per client transport holds; units 15.2 and 15.5 are acknowledged. The cost under `*` is named in the Consequences and both READMEs: list the name in `hosts`, or have the client write no `Origin`. |

### On both loopbacks

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On `localhost` the TypeScript HTTP transport calls the application's `createServer` twice, unsaid: an application that keeps "the" server rotates one family's certificate, adds one family's SNI context, sets one family's timeouts. And the draft's reason against one instance fed by two listeners is wrong: the feed reaches an `http2` server's sessions (measured); its trap is that `node:http` starts its slow-headers guard only on its own `listening` (O8) | Accepted: two instances stay, relying on no internals of Node, and the contract is stated: `createServer(listener, { address })`, called once per address bound, `127.0.0.1` then `::1`, every instance configured alike; a port drawn again listens again on the instances built. A twin counts the calls; the C# side, one Kestrel application binding both, holds `serves every address it binds by one configuration`. The reason against one instance fed by two listeners is the measured one, which holds as well against one `WebSocketServer` fed by both. |
