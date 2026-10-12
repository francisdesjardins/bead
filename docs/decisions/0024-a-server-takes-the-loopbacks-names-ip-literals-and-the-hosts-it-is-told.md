# 0024 — A server takes the loopback's names, IP literals and the hosts it is told, each named by a request's authority

- **Status**: accepted
- **Scope**: the protocol, and every implementation's server transports, over HTTP and at a
  WebSocket's address: in section 15.12 of [`spec/spec.md`](../../spec/spec.md), a request's
  authority (an absolute-form target's, HTTP/2's `:authority`, the `Host`), the grammar of a host
  and what answers one that is none on each version of HTTP, `hosts`, the hosts every server takes,
  their comparison and `*`, and the refusal of a `hosts` or an `origins` entry as a server is built;
  the host's place in 15.2's order. What `origins` takes, and a credential's loopback (13.4), are
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s; a connection's handle is
  [0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md)'s.

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
else. It reopens rebinding: both sides' doc comments and READMEs say so, as Vite's danger callout
does.

**A server is refused as it is built a misconfigured list**, as Bead refuses a timeout of 0
(`ProgrammerError` on the TypeScript side, `ArgumentException` on the C# side, naming the entry): a
`hosts` entry with a port, an empty one, one that is no host (a Unicode IDN among them, which the
field never carries), or `*` beside another; an `origins` entry that is `*`, its message saying that
no origin wildcard exists and that taking every page is `hosts: ['*']`'s and an origin check's
absence, or that is neither `null` nor an origin as
[RFC 6454 §6.2](https://www.rfc-editor.org/rfc/rfc6454#section-6.2) serializes it: its scheme and
host in lower case, the host ASCII and of 15.12's grammar, no port where it is the scheme's default
(`http` and `ws` 80, `https` and `wss` 443), nothing after. A scheme of another kind, an
extension's or an app shell's, is taken as written, since a browser serializes it so. CORS's
`Access-Control-Allow-Origin: *` is a response header, never a list a server compares against.

**403 `host-refused` stays**, on every listener, under TLS or not: 421 means "retry over a different
connection" to its client, which is meaningless at a WebSocket's address, and no MUST overrides it.
The host is judged first, over HTTP before the path and at a WebSocket's address right after HTTP's
own 400, before the method; the origin after. `origins` never widens `hosts`: a page named in
`origins` still asks the server by a host it takes.

## Consequences

**A server reached by a name names it in `hosts`, or refuses it, 403 `host-refused`**: a public
server, one behind a proxy that keeps the `Host` (Caddy's and Traefik's default), and a service
reached by its in-cluster name, a docker-compose service or a Kubernetes Service. A proxy that
writes its upstream's address as the `Host`, nginx's default `$proxy_host`, sends an IP literal or
`localhost`, taken; so do a probe by a pod's address and `curl localhost`.

**A refused host is told on the wire and by the HTTP clients, and the server tells nothing.** The
refusal is 403 with `bead-refusal: host-refused`, which `curl -i` and a browser's network panel
show, and both HTTP clients name it ("the server refused the exchange: 403 host-refused"). A
WebSocket client names the status where its platform lets it read one: .NET's `ConnectAsync`
throws a `WebSocketException` naming it, and the TypeScript client over `ws` carries
"Unexpected server response: 403" in its `ConnectError`'s cause; over the WHATWG `WebSocket`, a
page's, a refused upgrade is a close 1006 and nothing more. The refusal's body is empty (spec 15.6)
and no event of a server reports it. A server's tell of the refusals it answers itself, a public
event on every server transport of every side, is a decision of its own, which meets the Tenth Man.

**A request that names no host is refused but under `*`**: an `HTTP/1.0` request without `Host`, and
an HTTP/2 one with neither `:authority` nor `host`. No browser sends one.

**`*` reopens rebinding**, and the residual of a `.localhost` name a user agent sends on to a
resolver that does not keep it local stays, stated in 15.12.

**The address a server listens on by default** is no part of this decision, and comes by a decision
of its own.

**The gate.** The cases of `spec/transports.json` that cite 15.12, played by both sides: the hosts
every server takes, a list adding to them, `[]`, `*`, an absolute-form target, over HTTP and at a
WebSocket's address, and the forms a host is not, answered 400 as HTTP answers them. A build
refusal and HTTP/2 are no step: twin tests hold them, by the same sentence
([0004](0004-one-behaviour-in-every-language.md)), each side's `hosts and origins` tests for the
predicate, the grammar and the build refusals, and the HTTP transport servers' tests over TLS for
HTTP/2's `:authority` and its reset, which `docs/support.md` names among what no entry plays.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, which [0025](0025-a-transport-draws-each-connections-handle-and-gives-none-twice.md)
shares. Its objections, each with the answer that holds:

### On a server's hosts and a connection's handle

| Objection                                                                                                                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP/2 escapes the alignment: Kestrel reads `:authority` over `host` and resets the stream for each form it refuses, while the TypeScript side reads `host` first and judges no form over HTTP/2, against RFC 9113 §8.3.1's MUST NOT; under the draft it would take `localhost:` and `[v1.bead]` and take a pair the C# side refuses                                          | Accepted: measured over HTTP/2 in clear, Kestrel resets seven forms `PROTOCOL_ERROR` with no response and reads `:authority`; Node hands every form and both fields through. 15.12 names a request's authority, `:authority` before `host` over HTTP/2, writes the narrowing as an ABNF of its own instead of "a common HTTP server refuses them", and answers a form that is no host with 400 over HTTP/1.1 and a stream reset over HTTP/2 (RFC 9113 §8.1.1); this record names Kestrel as the grammar's source under the parity rule. The TypeScript side resets through the HTTP/2 compatibility response's stream. RFC 9113's SHOULD, a differing `host` treated as malformed, is followed by neither side, since Kestrel hands the C# application `:authority` alone; a page cannot write `host`. HTTP/2 twins on both sides, the C# ones writing their HEADERS frame by hand, since `HttpClient` derives `:authority` from its URI |
| An absolute-form target is a divergence under the sentence the draft rewrites: RFC 9112 §3.2.2 has an origin server accept it and use its authority; the TypeScript side answers it 404 and judges `Host` at a WebSocket's address, Kestrel answers 400 when `Host` differs                                                                                                   | Accepted: measured on both sides and on bare Kestrel. RFC 9112 §3.2.2 says outright that an origin server MUST ignore `Host` and use the target's host, and §3.3 makes the target the target URI: the standard settles it, and Kestrel's default 400 departs from it. The C# side sets `AllowHostHeaderOverride` on both transports; the TypeScript side reads the authority and the path from the target by hand. One term, a request's authority, serves HTTP/1.1 and HTTP/2 alike. No browser sends an absolute-form target to an origin server, and a client that writes the target writes `Host` too, so no rebinding reopens. Two cases, over HTTP and at a WebSocket's address, each with the own target, a rebinding target, and a target beside a differing `Host`                                                                                                                                                              |
| The breaking default ships without its diagnosis: every server reached by a name refuses it, in-cluster service names among them, which the draft does not name; Vite, webpack-dev-server and Django each tell the operator; Bead's refusal is empty-bodied, no event reports it, and neither WebSocket client reads a refused upgrade's response                             | In part: the wire carries the refusal, 403 and `bead-refusal: host-refused`, and the HTTP clients name it; the WebSocket clients name the status, not the refusal (.NET's exception; the TypeScript client's cause over `ws`), and over the WHATWG `WebSocket`, a page's, nothing past close 1006, which no code can read further. So a tell that reaches every deployment is the server's, a public event on every server transport of every side, a design of its own: put to the user, who gives it a round of its own before 0.4.0 is cut. This record, both READMEs (the C# one gaining a section on `Hosts` and `Origins`) and the CHANGELOG say the silence outright, and name in-cluster service names among what breaks. With a list adding to the default (below), a probe by IP and `curl localhost` keep working                                                                                                             |
| A given list should add to the default, not replace it: `Host` is client-written, so replacing protects nothing; Django and ASP.NET Core replace because they build URLs from `Host`, which Bead does not; Vite and webpack-dev-server, whose threat is Bead's, always take IP literals and localhost names; replacing refuses `curl localhost`, a sidecar, a probe by pod IP | Accepted: no server of either side builds anything from `Host` but the host's and the own origin's tests; a page can write neither an IP literal nor a localhost name for a name it was fetched by, so refusing them guards nothing. `hosts` takes what it lists besides what every server takes, `[]` is the default alone, `['*']` every host. 0.2.0's "exactly these" yields before 1.0.0. The given-list cases assert that `localhost` and the IP literal are taken                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The build check stops at `hosts`: `origins: ['*']`, the reader's next guess after `hosts: ['*']`, matches nothing, as does an entry with a trailing slash, upper case or a default port, and `hosts: []` refuses everything                                                                                                                                                   | Accepted: an `origins` entry is `null` or an origin as RFC 6454 §6.2 serializes it, refused as built otherwise, `*` with a message that no origin wildcard exists. `hosts: []`, with a list adding to the default, means the default alone, and 15.12 says so. Twins on both sides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The drawn form `type=WS;ip=…;ordinal=n` drops the port, the one part that ties a connection to the network: the handle is the trace's only connection field, and the C# `Connection` event carries the handle alone; the TypeScript template type publishes a form 15.1 says nothing reads; 53 opaque C# fixtures need not change                                             | In part: the port stays, `type=WS;ip=…;port=…;ordinal=n`, unique by its ordinal, which settles the handle as the draw does, and traceable by its port; it costs no side a public event's change, where the C# event carrying the client record would. The TypeScript type stays a template literal, and 15.1 says a handle's form is its implementation's, compared whole by an application, so the spec and the type agree. The C# fixtures move with the TypeScript ones, in one mechanical commit: twin tests read one form, and a fixture in a form no transport writes would read as one it does                                                                                                                                                                                                                                                                                                                                    |
| 15.12's ground for `.localhost` is not the one that holds: no registry granting a name stops nothing; resolution does (RFC 6761 §6.3 items 3 to 5); refusing `localhost.` is 0010's choice, not safety; "the hosts no page can rebind its name to" would take an empty host and none, which the same sentence refuses                                                         | Accepted: measured on Windows, `.localhost` names and `localhost.` resolve to the loopback. 15.12 and this record cite §6.3's resolution clauses and state the residual, a user agent that sends a localhost name to a resolver that does not keep it local; `localhost.` is refused for the field compared as it comes. The default is written as its list, the rebinding argument kept as its reason. No behaviour changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
