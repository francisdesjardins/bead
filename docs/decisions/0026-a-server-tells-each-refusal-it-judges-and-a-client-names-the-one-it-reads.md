# 0026 — A server tells each refusal it judges of its own, a client names the one it reads, and a request's fields are visible ASCII

- **Status**: accepted
- **Scope**: the protocol, and every implementation's server transports and clients, over HTTP and
  at a WebSocket's address: in [`spec/spec.md`](../../spec/spec.md), the refusal a server's
  transport tells (15.1, and 15.2's refusals told), what a client names of a refusal it reads
  (15.6), and the octets a request's field may hold (15.12). The marks and their order are 15.6's; a
  server's hosts and the address it listens on are
  [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)'s; the
  guard a listener is called within is
  [0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)'s;
  what a transport carries of a credential is
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s.

## Context

**A refusal no one tells is a default no one can diagnose.** A server reached by a name it does not
list refuses it 403 `host-refused`
([0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)), its body
empty (spec 15.6). [RFC 9110 §15.5.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.4) lets
a server describe why it refuses in the response's content; Bead keeps the reason in `bead-refusal`
and the body empty, so the operator's side of it is the server's own matter. A client may read a
refused upgrade's response:
[RFC 6455 §4.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.1), "If the status code received
from the server is not 101, the client handles the response per HTTP procedures". A page cannot:
the [WHATWG WebSockets Standard](https://websockets.spec.whatwg.org/) fails the connection on any
status but 101 with a bare `error` and a close 1006. So a page's tell can only be its server's.

**What each client reads of a refused upgrade**, a server of each side on `127.0.0.1` refusing 403
`host-refused`, Node 26.5.0 and .NET 10.0.12 on Windows 11: `ws` with no listener for the response
carries "Unexpected server response: 403" and closes 1006; with `unexpected-response`, it reads the
status and `bead-refusal`, and `terminate()` then ends it, where a request destroyed leaves the
socket connecting, no error and no close after 3 s; Node's global `WebSocket`, a browser's API, an
error with an empty message and a close 1006; .NET's `ClientWebSocket` a `WebSocketException` of
`NotAWebSocket`, and with `CollectHttpResponseDetails` its `HttpStatusCode` 403 and its
`HttpResponseHeaders` holding `bead-refusal`, read before the socket is disposed. Both HTTP
clients' connects drop the mark, "the server drew no connection: 403", where their exchanges name
it.

**HTTP's own close looks like a refusal.** Spec 15.6's 404 `connection-unknown` says "the connection
is gone — closed, or its server stopping", and 15.7 makes it close the connection at both ends as a
socket that drops does. A graceful `DELETE` with a listen held, an exchange's timeout, an outbox past
its bound, a request dropped mid-body, the application's close and a stop each answer an exchange or
a held listen that 404, marked, on both servers, measured; both HTTP clients read it as gone, never
as refused. The WebSocket transport tells the same lifecycle by `close` alone.

**The two HTTP servers mirror each other on a field's octets**, on every field, the ones a transport
never reads among them, over HTTP and at a WebSocket's address, each byte sent as itself:

| A field value holding                                     | Node's parser (TypeScript side) | Kestrel (C# side)                             |
| --------------------------------------------------------- | ------------------------------- | --------------------------------------------- |
| ESC, BS, BEL or DEL, in a field no transport reads        | 400, unmarked                   | taken: 201, or 101 at a WebSocket's address   |
| the same, in `Origin`                                     | 400, unmarked                   | 403 `origin-refused`, the bytes in the origin |
| an octet past ASCII (0xE9), in a field no transport reads | taken                           | 400, unmarked                                 |
| the same, in `Origin`                                     | 403 `origin-refused`            | 400, unmarked                                 |
| either, in `Host`                                         | 400, unmarked                   | 400, unmarked, by 15.12's grammar             |
| HTAB inside `Origin`                                      | 403 `origin-refused`            | 403 `origin-refused`                          |

[RFC 9110 §5.5](https://www.rfc-editor.org/rfc/rfc9110#section-5.5): a recipient MUST reject a field
value holding CR, LF or NUL, or replace them; the other control characters are "also invalid", and
MAY be retained "within a safe context"; an octet past ASCII, `obs-text`, is still allowed, opaque
data, and newly defined fields SHOULD keep to visible US-ASCII.
[RFC 6454 §6.2](https://www.rfc-editor.org/rfc/rfc6454#section-6.2): a serialized origin is ASCII.
No browser sends either in a field it writes. A host or an origin a request wrote is the client's
text, which a listener may write to a log (CWE-117, CWE-150).

**The practice tells each refusal, none deduplicated**: Node's `http.Server` raises `clientError`
for each request it cannot parse, `ws` `wsClientError` for each handshake it refuses; ASP.NET Core's
Host Filtering logs each at Information, "The host '{Host}' does not match an allowed host."; Django
logs each `DisallowedHost`; webpack-dev-server and Vite answer the page's developer in the 403's
body, which a page's WebSocket never reads. OpenTelemetry's HTTP server conventions count by status
and `error.type`, never by host; firewalls, proxies and gRPC's peer name a connection by its address
and its port.

The options weighed:

- **An event per refusal**, beside `connection`, `listen` and `close`, under 15.1's guard.
- **A debug event** (`debugging.md` 2): the companion traces calls and envelopes, and a constrained
  profile may build without it; a refusal is neither, and the router never sees one (15.1). The
  diagnosis of a security default cannot be a thing a build leaves out.
- **A counter in the registry** (`debugging.md` 7.1): the registry is a router's, which never sees a
  refusal, and no label may be a host, an attacker's unbounded cardinality, so it says that something
  is refused and never what to add to `hosts`.
- **One event per distinct host**: a set the attacker grows, which needs a bound, an eviction and a
  reset, and hides how often.
- **The `error` event, a refusal as an error**: a refusal is the server working as told, and the
  router reports every `error`, so each scanner's probe would land in the application's error path.
- **A message in the refusal's body**, Vite's and webpack-dev-server's: 15.6's empty body is
  released behaviour both sides and the conformance hold, the mark carries the reason, and a page's
  WebSocket reads no body.

## Decision

**A server's transport tells each refusal it judges of its own** (spec 15.1), one event per refusal,
`refusal` on the TypeScript side and `Refusal` on the C# side, its record `ITransportServerRefusal`
and `TransportServerRefusal`: a request it refuses as it arrives, in 15.6's order, the bounds' and a
stop's 503 among them, a token's 400 and its 404 when no connection holds it; or a body it refuses
as it comes; each marked. It never tells the 404 `connection-unknown` that ends an exchange or a
listen it had taken as their connection closes, which `close` tells, nor HTTP's own unmarked 400. One
writer per side holds the line: the TypeScript side's `finish` tells, `endWith` and `answer` never;
the C# side's `Finish` tells, `EndWith` never, a held listen ended as its connection goes written
through `EndWith` as every other close's 404 is. At a WebSocket's address every refusal is an
upgrade's as it arrives, so each is told.

**It carries six members**, named alike on both sides: `address`, the client's as 15.12 states it,
the one `clients` reports; `authority`, the request's as it came, its port included, `""` for an
empty `Host`, none when it names none; `origin`, the `Origin` as it came, its lines joined ", "
([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)), none when absent; `port`,
the socket's peer port, the proxy's connection's behind a trusted proxy; `reason`, the mark; and
`status`. Never the target, where a page's WebSocket URL puts a token since its socket cannot set a
field, nor the connection's token (15.4), a credential, any other field or the body. It names no
connection: a refusal is a request's, and at a WebSocket's address none exists yet. Its record is
built only when a listener listens.

**A listener's throw is reported with no connection**: the TypeScript guard reports the last
argument as the handle when it is a string, `''` otherwise, as the C# guard reads a one-argument
event's argument `as string`; the C# `Error` carries the empty handle for a `Refusal` listener's
throw alone, never for the server's own failure.

**A request's field values are visible ASCII, spaces and tabs** (spec 15.12): one that holds a
control character other than HTAB, DEL among them, or an octet past ASCII is answered 400 unmarked
over HTTP/1.1, its stream reset over HTTP/2, before the transport judges anything else of it, at
both transports. Under [0004](0004-one-behaviour-in-every-language.md)'s rule, where one side takes
Y and the other Y and Z, every one takes Y: Y is what both servers take. Each side writes the 400
its server does not, the C# side for a control character Kestrel took, the TypeScript side for an
octet past ASCII Node took, as its server writes its own, with none of the fields every response on
the path carries
([0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)). So
every string a refusal carries is printable, and the same on both sides.

**A client names the status and the reason of a refusal it reads** (spec 15.6): the HTTP connect,
"the server drew no connection: {status} {reason}", an unmarked status by its number alone; the
WebSocket connect, "the server refused the upgrade: {status} {reason}", over `ws` through
`unexpected-response` and on the C# side through `CollectHttpResponseDetails`, its error's type and
cause kept. Over the global `WebSocket` it reads nothing past its close 1006, a platform row of
`docs/support.md`.

## Consequences

**Every server transport gains a public event and a record type**, on both sides, and both
`IServerTransport` and the TypeScript event map carry it.

**`spec/transports.json` checks each marked refusal's tell**: every marked `expect` holds `told`,
computed by its generator from the request its step sent, its port `{port}`, which each runner fills
with the local port of the socket the step sent from; the 404 a close writes is told by none, a case
holding a listen and then sending `DELETE`; and two cases, over HTTP and at a WebSocket's address,
send each octet past the rule in `Origin` and in a field no transport reads, answered 400 unmarked
and told by none, a tab taken.

**A scanner's every probe is an event**, its rate the listener's to bound. After a restart, each
client that listened comes back once with a token no longer held, a burst of arrival 404s, told,
since a token guessed is a request refused; the operator reads the restart's echo by its reason.

**A request holding a control character in a field, which the C# side took, or an octet past ASCII,
which the TypeScript side took, is refused 400 on both.**

**Over HTTP/2, each platform answers part of it before its transport reads the request**:
Node's HTTP/2 parser, nghttp2, drops a field whose value holds a control character, so the
TypeScript side's transport judges the request without it, where the C# side's resets the stream;
Kestrel ends the session, `GOAWAY`, on an octet that is no UTF-8, where the TypeScript side's
transport resets the stream. A platform row of `docs/support.md` names both; neither takes a
request past what one without the field would be.

**A page's WebSocket still learns nothing but its close**: its server's tell is what says why.

**What a listener costs is held by inspection**: no record is built while none listens.
[0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s measured gates are a call's, and a
refusal is no call.

**The gate.** `spec/transports.json`, played by both sides; twins by the same sentence
([0004](0004-one-behaviour-in-every-language.md)) for what no step reaches: each HTTP transport
server's
`tells each refusal it judges of its own, its status, its reason, the request's authority and origin and the client's address and port, and nothing of HTTP's own`
and its `tells no refusal of the 404 that ends an exchange or a listen as its connection closes, …`;
each WebSocket transport server's sentence at its address; each side's field predicate,
`isVisibleField` and `IsVisibleField`, over one table; each transport server's
`refuses as it would though a refusal listener throws, the throw reported with no connection`; each
WebSocket client's `names the status and the reason of an upgrade refused`, and each HTTP client's
connect named with its reason. `docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, which
[0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md) shares for
the address a server listens on. Its objections, each with the answer that holds:

### On a refusal told and the default listening address

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telling every marked response tells the HTTP transport's own close: the 404 `connection-unknown` that 15.7 writes to an exchange or a held listen as its connection ends, on every graceful `DELETE`, timeout, outbox overflow, application close and stop, beside the `close` the same event already tells, where a WebSocket tells `close` alone; no case plays that 404                                                   | Accepted: measured on both servers, a `DELETE` or a stop with a listen held answers it 404 marked, and both clients read it as gone. 15.6 and 15.7 already call that 404 a close. A refusal is told when the transport judges a request as it arrives, by 15.6's order, the bounds' and a stop's 503 among them, or its body as it comes; the 404 that ends an exchange or a listen already taken is told by `close` alone, as is the mid-body close. One writer per side holds the line: `finish` on the TypeScript side and `Finish` on the C# side, a held listen's 404 written through `EndWith` as every other close's is. A case holds a listen, sends `DELETE`, and reads the 404 marked and nothing told; this record names the restart's burst of arrival 404s that stays told, a token guessed being a request refused |
| "An address given is an IP address" has no definition, and `isIP` and `IPAddress.TryParse` disagree on nine forms, `0` among them, which the C# side would bind to every interface; 13.4 still judges a server by a host the URL parser reads and lists `127.1`, `127.0.0.1.` and the localhost names as on the loopback                                                                                                     | Accepted: measured on both runtimes. 15.12 defines an address as RFC 3986's `IPv4address` or `IPv6address`, bare, with no zone, and not IPv4-mapped, an IPv4 node's address being written as one (RFC 4291 §2.5.5.2); both sides test it with 0024's matchers extracted to a bare form, never a platform's parser. 13.4's server half reads that address alone, on the loopback in 127.0.0.0/8 or `::1`, and the forms the URL parser normalizes stay the client's. Twins on both sides over every form of the table, `0` and `[::1]` refused                                                                                                                                                                                                                                                                                    |
| The draft credits Happy Eyeballs for every client reaching `127.0.0.1` by `localhost`, but .NET does not race: both C# clients wait about two seconds a connect on Windows, as they do against a server on `0.0.0.0`; another process on `[::1]` and the same port answers every client by `localhost`; the draft's alternative, both loopbacks, has a cost it does not name, Kestrel refusing a dynamic port on `localhost` | Accepted: measured, .NET 2012–2054 ms by `localhost` against Node's and the browsers' milliseconds, the capture by `fetch`, `ws` and `HttpClient`, and Kestrel's refusal. The claim is corrected. Both C# clients race the families as RFC 8305 asks, through a `ConnectCallback`, which closes a client divergence from Node and the browsers against any one-family server, whatever the default. One loopback family or both was put to the user with its costs named either way, who chose `127.0.0.1`; the residual capture is named in 15.12 and 0024                                                                                                                                                                                                                                                                      |
| The draft's ground that HTTP's own refusals exclude the same things on both sides was never probed: its probe sent the characters `\x01`; with the bytes, a control character in `Origin` is Node's unmarked 400 and the C# side's marked 403, a byte past ASCII the reverse, so one request would be told on one side alone, the C# side's told origin carrying terminal escapes the draft's example prints as they are     | Accepted, and wider: re-probed, the mirror holds on every field, one the transport never reads included, and not on `Host`, which 0024's grammar holds on both. By the parity rule both sides take what both take, visible ASCII, SP and HTAB, and answer any other field value 400 unmarked before judging the request: RFC 9110 §5.5 calls the control characters invalid and keeps octets past ASCII out of every field defined since, and RFC 6454 §6.2 makes an origin ASCII; 15.12 says it. So every string a refusal carries is printable, and the READMEs' examples still quote what they print. Two cases, over HTTP and at a WebSocket's address, each told by neither side; the draft's sentence goes, the measured table in its place                                                                                |
| The record keeps three of the client record's five members and drops `Port` without a word, though 0024's round kept the peer's port in the handle as the tie to a proxy's or a firewall's log, which a refusal needs more than a connection                                                                                                                                                                                 | Accepted: `port`, the socket's peer port as `clients` reports it, the proxy's connection's behind a trusted proxy, on both sides. The conformance writes it `{port}`, which each runner fills with the local port of the socket its step sent from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
