# 0026 — A server tells each refusal it judges of its own, a client names the one it reads, and a request's fields are visible ASCII

- **Status**: accepted
- **Scope**: the protocol, and every implementation's server transports and clients, over HTTP and
  at a WebSocket's address: in [`spec/spec.md`](../../spec/spec.md), the refusal a server's
  transport tells (15.1, and 15.2's refusals told), what a client names of a refusal it reads
  (15.6), the octets a request's field and its target may hold (15.12, and transcoding 3.6), and how
  its method is compared (15.6, and 15.2's step 3). The marks and their order are 15.6's; which
  visible characters a target holds, by the sets a page's browser percent-encodes under the URL
  Standard, and a `#` anywhere, is
  [0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)'s;
  a server's hosts and the address it listens on are
  [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)'s; the
  guard a listener is called within is
  [0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)'s;
  what a transport carries of a credential is
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s; an access a server's router
  refuses, told, [0034](0034-a-server-tells-each-access-it-refuses-never-the-credential.md)'s.

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
`HttpResponseHeaders` holding `bead-refusal`, read before the socket is disposed.

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
`refusal` on the TypeScript side, `Refusal` on the C# side and a listener's `on_refusal` on the Rust
side, its record `ITransportServerRefusal`, and `TransportServerRefusal` on the C# and Rust sides: a
request it refuses as it arrives, in 15.6's order, the bounds' and a stop's 503 among them, a
token's 400 and its 404 when no connection holds it; or a body it refuses as it comes; each marked.
It never tells the 404 `connection-unknown` that ends an exchange or a listen it had taken as their
connection closes, which `close` tells, nor what HTTP answers of its own, unmarked: its 400, and its
408 to a head that does not come whole within `headersTimeout`, which the platform's parser writes
before the transport reads anything of the request
([0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)). One writer per side holds the line: the
TypeScript side's `finish` tells, `endWith` and `answer` never; the C# side's `Finish` tells,
`EndWith` never, a held listen ended as its connection goes written through `EndWith` as every other
close's 404 is; the Rust side's `finish` tells, its responder's `end` never, through which every
close's 404 is written, a held listen's among them. At a WebSocket's address every refusal is an
upgrade's as it arrives, so each is told.

**It carries six members**, named alike on every side: `address`, the client's as 15.12 states it,
the one `clients` reports; `authority`, the request's as it came, its port included, `""` for an
empty `Host`, none when it names none; `origin`, the `Origin` as it came, its lines joined ", "
([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)), none when absent; `port`, the
socket's peer port, the proxy's connection's behind a trusted proxy; `reason`, the mark; and
`status`. Never the target, where a page's WebSocket URL puts a token since its socket cannot set a
field, nor the connection's token (15.4), a credential, any other field or the body. It names no
connection: a refusal is a request's, and at a WebSocket's address none exists yet. Its record is
built only when a listener listens.

**A listener's throw is reported with no connection**: the TypeScript guard reports the last
argument as the handle when it is a string, `''` otherwise, as the C# guard reads a one-argument
event's argument `as string`; the C# `Error` carries the empty handle for a `Refusal` listener's
throw alone, never for the server's own failure; the Rust side catches a listener's panic and
reports it on `on_error` with no handle, `a listener panicked: …`.

**A request's field values are visible ASCII, spaces and tabs, and none at either end of a value**
(spec 15.12; [RFC 9113 §8.2.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.2.1)): one that
holds a control character other than HTAB, DEL among them, or an octet past ASCII is answered 400
unmarked over HTTP/1.1, its stream reset over HTTP/2, before the transport judges anything else of
it, at both transports; one that starts or ends with a space or a tab has its stream reset over
HTTP/2 alike, HTTP/1.1's parsers stripping that whitespace first
([0029](0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md)). Under
[0004](0004-one-behaviour-in-every-language.md)'s rule, where one side takes Y and the other Y and
Z, every one takes Y: Y is what every server takes. Each side writes the 400 its server does not,
the C# side for a control character Kestrel takes, the TypeScript side for an octet past ASCII Node
takes, the Rust side for an octet past ASCII httparse takes, under hyper and in its own read of a
WebSocket's head, as its server writes its own, with none of the fields every response on the path
carries ([0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)). So
every string a refusal carries is printable, and the same on every side.

**A request's target is visible ASCII, and its path's percent-decoding holds no NUL** (spec 15.12):
one that holds a control character, HTAB and a bare CR among them, a space, DEL or an octet past
US-ASCII, in its path or its query, in origin-form or absolute-form, or a path that decodes to NUL,
`%00`, is answered 400 unmarked over HTTP/1.1 and its stream reset `PROTOCOL_ERROR` over HTTP/2,
before anything else of it is judged, at both transports and at a gateway
([0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md),
transcoding 3.6), and told by none. A target holds a URI's characters
([RFC 9112 §3.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2),
[RFC 9113 §8.3.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.3.1)), which are visible ASCII
([RFC 3986 §2](https://www.rfc-editor.org/rfc/rfc3986#section-2)), and a request-line that holds
another is invalid ([RFC 9112 §3](https://www.rfc-editor.org/rfc/rfc9112#section-3), a bare CR
among them by [§2.2](https://www.rfc-editor.org/rfc/rfc9112#section-2.2)). Node's parser answers
every such octet over HTTP/1.1, and nghttp2 resets a control character, a space or DEL in `:path`;
Kestrel takes a control character, HTAB, a bare CR and DEL in an HTTP/1.1 target, and each but NUL,
an octet past ASCII in UTF-8 among them, in `:path`; httparse answers a control character in an
HTTP/1.1 target, and h2 resets a control character, a space, DEL or NUL in `:path`. Each side writes
what its server does not: the C# side through `HostsAndOrigins.IsVisibleTarget`, over every
protocol, beside its fields' predicate, the TypeScript side through `isVisibleTarget`, beside
`hasVisibleFields`, the Rust side through `is_visible_target`, beside `has_visible_fields`, over
HTTP and at a WebSocket's address. A NUL percent-encoded in a path is the one encoded octet refused,
since Kestrel refuses it before an application runs and RFC 3986 §2.1 allows it: every side keeps to
Kestrel's, a row of `docs/support.md`'s "Leveled down"; `%00` in a query, and every other octet
percent-encoded, are taken. Of the visible characters a URI leaves out, what a page's browser always
percent-encodes where it stands, `"`, `<` and `>` in a path or a query, and `^`, `` ` ``, `{` and
`}` in a path, is answered 400 unmarked, and a target that holds a `#` anywhere is answered alike;
`\`, `|`, and `^`, `` ` ``, `{` and `}` in a query are taken as they came, as a page sends them
([0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)).
The Rust side's HTTP address and its gateway serve a target that holds a `#` cut at it, hyper's
`http::Uri` cutting it before the transport or the gateway reads it: a platform row of
`docs/support.md`, `A # in a target`
([0052](0052-the-rust-sides-gateway-is-a-feature-of-its-core-its-json-mapping-a-feature-of-its-proto-codec-and-a-head-never-holds-a-stream.md)).

**A request's method is compared as it came** (spec 15.6, and 15.2's step 3): a case-sensitive
token ([RFC 9110 §9.1](https://www.rfc-editor.org/rfc/rfc9110#section-9.1)), so `get` is no `GET`.
Any method the path does not take, an extension method among them, is refused 405
`method-refused`, its `Allow` naming those it takes
([RFC 9110 §15.5.6](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.6)), in its place in
15.6's order, after the host, the path, the origin and a preflight; at a WebSocket's address, after
the host, a `head` is refused 405 where a `HEAD` is answered 426. §9.1's SHOULD, a 501 for a
method a server does not recognize
([§15.6.2](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.2)), is set aside: what a server
recognizes beyond its path's methods is its HTTP parser's, Node's llhttp a table of
upper-case methods, Kestrel and hyper none, so no reading of it is shared; and `Allow` tells a
client what to send, where a 501 tells nothing. Every side's judgement compares the method byte
for byte; on the TypeScript side Node's parser refuses a method its table does not hold 400,
unmarked, before the transport reads it, a platform row of `docs/support.md`,
`A method Node's HTTP parser does not know`.

**A client names the status and the reason of a refusal it reads** (spec 15.6): the HTTP connect,
"the server drew no connection: {status} {reason}", an unmarked status by its number alone; the
WebSocket connect, "the server refused the upgrade: {status} {reason}", over `ws` through
`unexpected-response` and on the C# side through `CollectHttpResponseDetails`, its error's type and
cause kept, and on the Rust side through the response tungstenite's `Error::Http` carries. Over the
global `WebSocket` it reads nothing past its close 1006, a platform row of `docs/support.md`.

## Consequences

**Every server transport carries a public event and a record type**, on every side, and
`IServerTransport`, `IServerTransportLike`, the TypeScript event map and the Rust side's
`ServerListener` carry it.

**`spec/transports.json` checks each marked refusal's tell**: every marked `expect` holds `told`,
computed by its generator from the request its step sent, its port `{port}`, which each runner fills
with the local port of the socket the step sent from; the 404 a close writes is told by none, a case
holding a listen and then sending `DELETE`; and two cases, over HTTP and at a WebSocket's address,
send each octet past the rule in `Origin` and in a field no transport reads, answered 400 unmarked
and told by none, a tab taken.

**A scanner's every probe is an event**, its rate the listener's to bound. After a restart, each
client that listened comes back once with a token no longer held, a burst of arrival 404s, told,
since a token guessed is a request refused; the operator reads the restart's echo by its reason.

**A request holding a control character in a field, or an octet past ASCII, is refused 400 on every
side**, each side writing the 400 its platform does not: the C# side for a control character Kestrel
takes, the TypeScript side for an octet past ASCII Node takes, the Rust side for an octet past ASCII
httparse takes, which refuses a control character first.

**A target past visible ASCII is refused on every side alike**: two cases of `spec/transports.json`,
over HTTP and at a WebSocket's address, send the octets the rule names in a path and in a query, in
absolute-form and from a host not taken, and `%00` in a path, each answered 400 unmarked and told by
none, one percent-encoded taken; an exchange of `spec/transcoding.json` pins it at a gateway, a path
no route matches answered 400, not 404. Over HTTP/2, Kestrel ends the session on NUL or on a lone
octet that is no UTF-8 in `:path`, as on a field, and h2 on such a lone octet, where Node resets the
stream: the platform row of `docs/support.md` names each.

**Over HTTP/2, each platform answers part of it before its transport reads the request**: Node's
HTTP/2 parser, nghttp2, drops a field whose value holds a control character, so the TypeScript
side's transport judges the request without it, where the C# side's resets the stream, and so does
it drop a value padded at either end unless the application's `createServer` is given
`strictFieldWhitespaceValidation: false`; Kestrel ends the session, `GOAWAY`, on an octet that is no
UTF-8, where the TypeScript side's transport resets the stream; and h2 ends the session, `GOAWAY`,
on a field holding a control character but a tab, as it decodes the head, where the C# side's
transport resets the stream. A platform row of `docs/support.md` names each; none takes a request
past what one without the field would be.

**A method's case is held by two cases of `spec/transports.json`**, each refusal told: over HTTP,
`get`, a `post` of Bead's type that would draw a connection were the method folded, and `BEAD`,
each 405; `get` at another path, 404, and from an origin not taken, 403; and an `options` that asks
a preflight from a listed origin, 405 with CORS's fields and no `Access-Control-Allow-Methods`. At a
WebSocket's address, `get`, `head` and `BEAD`, each 405, then `get` from a host not taken, 403.
Their schema takes a request's method as any token, in any case. The TypeScript side is excused
from both by their `differs`, its parser answering first; its twin over HTTP, beside the C# and
Rust sides', is the row's.

**A page's WebSocket still learns nothing but its close**: its server's tell is what says why.

**What a listener costs is held by inspection**: no record is built while none listens.
[0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s measured gates are a call's, and a
refusal is no call.

**The gate.** `spec/transports.json`, played by every side, a case's `differs` excusing a side by a
platform row of `docs/support.md`, the TypeScript side from a method's two cases and the Rust side's
HTTP address from a `#` among them; twins by the same sentence
([0004](0004-one-behaviour-in-every-language.md)) for what no step reaches: each HTTP transport
server's `tells each refusal it judges of its own, its status, its reason, the request’s authority
and origin and the client’s address and port, and nothing of HTTP’s own` and its `tells no refusal
of the 404 that ends an exchange or a listen as its connection closes, …`; each WebSocket transport
server's sentence at its address; each side's field predicate, `isVisibleField`, `IsVisibleField`
and `is_visible_field`, over one table, and its target predicate, `isVisibleTarget`,
`IsVisibleTarget` and `is_visible_target`, over another; each HTTP transport server's `resets over
HTTP/2 the stream of a request whose target holds a control character, a space, DEL or an octet past
ASCII, PROTOCOL_ERROR, and tells nothing`, each WebSocket handshake's `refuses first, unmarked, a
target holding an octet other than visible ASCII or a path whose percent-decoding holds NUL, …`, and
each gateway's `resets over HTTP/2 the stream of a request whose target or a field holds an octet
past visible ASCII, PROTOCOL_ERROR, nothing written`; each transport server's `refuses as it would
though a refusal listener throws, the throw reported with no connection`; each WebSocket client's
`names the status and the reason of an upgrade refused`, and each HTTP client's connect named with
its reason. `docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, which
[0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md) shares for
the address a server listens on; a field value's ends met it in
[0029](0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md)'s round, which keeps its
objections and answers; a request's target met it in a round of its own, at xhigh effort, beside
[0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)'s
rule on a target past US-ASCII at a gateway: ten objections, each accepted; and a method's case
met it in a round of its own, at xhigh effort: eight objections, each accepted. Its objections, each
with the answer that holds:

### On a refusal told and the default listening address

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telling every marked response tells the HTTP transport's own close: the 404 `connection-unknown` that 15.7 writes to an exchange or a held listen as its connection ends, on every graceful `DELETE`, timeout, outbox overflow, application close and stop, beside the `close` the same event already tells, where a WebSocket tells `close` alone; no case plays that 404                                                   | Accepted: measured on both servers, a `DELETE` or a stop with a listen held answers it 404 marked, and both clients read it as gone. 15.6 and 15.7 already call that 404 a close. A refusal is told when the transport judges a request as it arrives, by 15.6's order, the bounds' and a stop's 503 among them, or its body as it comes; the 404 that ends an exchange or a listen already taken is told by `close` alone, as is the mid-body close. One writer per side holds the line: `finish` on the TypeScript side and `Finish` on the C# side, a held listen's 404 written through `EndWith` as every other close's is. A case holds a listen, sends `DELETE`, and reads the 404 marked and nothing told; this record names the restart's burst of arrival 404s that stays told, a token guessed being a request refused |
| "An address given is an IP address" has no definition, and `isIP` and `IPAddress.TryParse` disagree on nine forms, `0` among them, which the C# side would bind to every interface; 13.4 still judges a server by a host the URL parser reads and lists `127.1`, `127.0.0.1.` and the localhost names as on the loopback                                                                                                     | Accepted: measured on both runtimes. 15.12 defines an address as `localhost`, both loopbacks, or RFC 3986's `IPv4address` or `IPv6address`, bare, with no zone, and not IPv4-mapped, an IPv4 node's address being written as one (RFC 4291 §2.5.5.2); both sides test it with 0024's matchers extracted to a bare form, never a platform's parser. 13.4's server half reads that address alone, on the loopback in 127.0.0.0/8, `::1` or `localhost`, and the forms the URL parser normalizes stay the client's. Twins on both sides over every form of the table, `0` and `[::1]` refused                                                                                                                                                                                                                                       |
| The draft credits Happy Eyeballs for every client reaching `127.0.0.1` by `localhost`, but .NET does not race: both C# clients wait about two seconds a connect on Windows, as they do against a server on `0.0.0.0`; another process on `[::1]` and the same port answers every client by `localhost`; the draft's alternative, both loopbacks, has a cost it does not name, Kestrel refusing a dynamic port on `localhost` | Accepted: measured, .NET 2012–2054 ms by `localhost` against Node's and the browsers' milliseconds, the capture by `fetch`, `ws` and `HttpClient`, and Kestrel's refusal. Both C# clients race the families as RFC 8305 asks, through a `ConnectCallback`, as Node and the browsers do, against any one-family server, whatever the default. One loopback family or both was put to the user with its costs named either way, who chose both: a server listens on `localhost`, `127.0.0.1` then `::1` on one port, a drawn port drawn again when the other family holds it, which leaves the capture no address, measured on Windows and Linux, and listens on `127.0.0.1` alone, reported, where the IPv6 loopback is absent (0024); a server given one family keeps the residual, named in 15.12                               |
| The draft's ground that HTTP's own refusals exclude the same things on both sides was never probed: its probe sent the characters `\x01`; with the bytes, a control character in `Origin` is Node's unmarked 400 and the C# side's marked 403, a byte past ASCII the reverse, so one request would be told on one side alone, the C# side's told origin carrying terminal escapes the draft's example prints as they are     | Accepted, and wider: re-probed, the mirror holds on every field, one the transport never reads included, and not on `Host`, which 0024's grammar holds on both. By the parity rule both sides take what both take, visible ASCII, SP and HTAB, and answer any other field value 400 unmarked before judging the request: RFC 9110 §5.5 calls the control characters invalid and keeps octets past ASCII out of every field defined since, and RFC 6454 §6.2 makes an origin ASCII; 15.12 says it. So every string a refusal carries is printable, and the READMEs' examples still quote what they print. Two cases, over HTTP and at a WebSocket's address, each told by neither side; the measured table stands in the Context in place of the draft's sentence                                                                 |
| The record keeps three of the client record's five members and drops `Port` without a word, though 0024's round kept the peer's port in the handle as the tie to a proxy's or a firewall's log, which a refusal needs more than a connection                                                                                                                                                                                 | Accepted: `port`, the socket's peer port as `clients` reports it, the proxy's connection's behind a trusted proxy, on both sides. The conformance writes it `{port}`, which each runner fills with the local port of the socket its step sent from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### On a request's target

| Objection                                                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The draft refuses a target at the HTTP transport alone, though a server reads one at its WebSocket's address too (15.2, step 1): `GET /` U+0001 and `GET /?a` U+0001 `b` upgrade 101 on the C# side, where Node answers 400                                                                                                                  | Accepted: 15.2's step 1 names the target, the C# handshake judges it with its fields, and a case of `spec/transports.json` at a WebSocket's address pins it beside the fields' case                                                                                                                                                                                      |
| `%00` in a path is answered unlike: Kestrel answers it 400, or resets its stream, before an application runs, where the TypeScript transport answers 404 marked and told, and its gateway binds `a` U+0000 `b` in a variable                                                                                                                 | Accepted: every side refuses a path whose percent-decoding holds NUL as HTTP refuses it, the TypeScript side by a check of its own. RFC 3986 §2.1 allows the octet, so the leveling is a row of `docs/support.md`'s "Leveled down", to lift once Kestrel takes it; `%00` in a query, and every other octet percent-encoded, are taken                                    |
| The draft answers 400 over every protocol, though a malformed HTTP/2 request has its stream reset (RFC 9113 §8.3, §8.3.1, §8.1.1), as 15.12 has a field's; the C# transport judges a target over HTTP/1 alone, though Kestrel gives `:path` as its `RawTarget`, and the C# gateway's first gate writes a 400 over HTTP/2, a field's among it | Accepted: over HTTP/2 the stream is reset `PROTOCOL_ERROR`, nothing written; the C# check runs over every protocol in the fields' branch, and the C# gateway resets as the TypeScript one does, for a field and a target alike. Kestrel ends the session on NUL, or on a lone octet that is no UTF-8, in `:path`: the fields' platform row of `docs/support.md` names it |
| The TypeScript side refuses nothing of its own and leans on Node's parser, which `insecureHTTPParser`, or another server `createServer` builds, relaxes                                                                                                                                                                                      | Accepted: an explicit `isVisibleTarget`, the NUL check with it, in the gate `hasVisibleFields` holds, at the transport, at a WebSocket's address and at a gateway's first gate, each leading into the same unmarked answer                                                                                                                                               |
| A refusal marked `malformed`, judged where the path is, would tell what Node's parser answers unmarked before any Bead code runs; the C# side already turns `/be` U+0001 `ad` into a 404 `path-unknown`, marked and told                                                                                                                     | Accepted: unmarked, as HTTP answers it, with none of the fields every response on the path carries, judged before any gate, and told by none; marking it is refused                                                                                                                                                                                                      |
| A gateway mounted on an application's server meets only what reaches its handler, so a rule stated for every request overreaches                                                                                                                                                                                                             | Accepted as written: a gateway refuses so every request it answers, and transcoding says no more than that                                                                                                                                                                                                                                                               |
| The octet set is drawn loosely: HTAB is no control character "other than HTAB" here, a space is one, and the visible characters a URI leaves out are taken by both servers and sent unencoded by a page's browser in a query                                                                                                                 | Accepted: every octet but 0x21 to 0x7E, in the path and the query, origin-form or absolute-form, HTAB among them and the space named; `"`, `#`, `<`, `>`, `\`, `^`, `` ` ``, `{`, `                                                                                                                                                                                      | `and`}`stay taken, a`#` opening no fragment, which both servers keep in the path |
| The draft cites RFC 3986 alone, which says what a URI holds and not what a server answers                                                                                                                                                                                                                                                    | Accepted: RFC 9112 §3, a request-line that is invalid answered 400, §2.2, a bare CR invalid, and §3.2, beside RFC 3986 §2 and RFC 9113 §8.3.1                                                                                                                                                                                                                            |
| `spec/transports.json`'s schema writes a target `\S+`, which under Python's `re` holds no HTAB, no bare CR and none of 0x1C to 0x1F                                                                                                                                                                                                          | Accepted: a target is any octet but a space and LF, a bare CR among them, and no character past U+00FF, which no octet writes; `transcoding.json`'s pattern stays                                                                                                                                                                                                        |
| A rule stated at the HTTP transport alone leaves the gateway and the WebSocket's address to infer it                                                                                                                                                                                                                                         | Accepted: 15.12 states it for every HTTP server, and 15.2's step 1 and transcoding 3.6 point to it                                                                                                                                                                                                                                                                       |

### On a method's case

The proposal: one case over HTTP and one at a WebSocket's address, each sending `get`, `Get`,
`post` and `BEAD`, refused 405 with its `Allow`, then a `GET` as a control, the TypeScript side
excused. Eight objections, each checked against every side's judgement and RFC 9110: all eight
accepted, the proposal amended. No side's code moves, every side's judgement comparing a method as
it came.

| Objection                                                                                                                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The spec states no rule on a method's case: it says where a token folds, `Upgrade` and `Connection`, an `Origin`, a host, and nothing where it does not, so a platform that folds, as ASP.NET's `HttpMethods.IsGet` does, reads a fold from its silence; a case would hold a rule the spec does not say | **Accepted.** 15.6 states it in one sentence after its order's 405, its 405 row reads "compared as they came", and 15.2's step 3 points to it; the cases cite 15.6 and 15.6.7.                                                                                                                                                                                                                                                                                                                                                                               |
| 405 for `get` and `BEAD` departs from RFC 9110 §9.1's SHOULD, a 501 for a method a server does not recognize (§15.6.2), unnamed; and the CHANGELOG cites §9.1 for a 405 it does not give                                                                                                                | **Accepted, 405 kept and its reason named.** What a server recognizes beyond its path's methods is its parser's: Node's table, Kestrel's none, hyper's none. A 501 would need the spec to carry a set and every side to hold it, for a status no client of Bead reads, where `Allow`, a MUST on a 405 (§15.5.6), tells a client what to send. Every side that reads the method answers 405; ASP.NET Core's endpoint routing, nginx and axum answer 405, Apache 501, so the spec picks one and says why. The CHANGELOG cites §9.1 for the token's case alone. |
| Four refusals and a control repeat the three twins the row cites; what a case alone holds, the refusal told, the method's place in 15.6's order and an `options` that is no preflight, is mostly left out                                                                                               | **Accepted.** The case over HTTP holds all three: each refusal told, by the generator's `tell`; `get /elsewhere` 404 and `get` from a foreign origin 403; an `options` with `Access-Control-Request-Method` from a listed origin, 405 with CORS's fields and no `Access-Control-Allow-Methods`. The Rust side gains through it the preflight and the order, which no unit test of its own holds.                                                                                                                                                             |
| The order should be proven with a lower-case method at both addresses, and one target kept out, `get /bead#x`, which Kestrel answers 400 and hyper cuts to `/bead`                                                                                                                                      | **Accepted.** Over HTTP, the path's and the origin's steps; at a WebSocket's address, `get` from a host not taken, 403. No `#` and no absolute-form target, each a row of its own.                                                                                                                                                                                                                                                                                                                                                                           |
| At a WebSocket's address `head` is the sharp step, a `HEAD` being 426; `Get` adds nothing `get` does not, and `post` repeats the `POST` step                                                                                                                                                            | **Accepted.** `get`, `head` and `BEAD`, then the host's step; over HTTP, `get`, a `post` of Bead's type that would draw a connection were the method folded, and `BEAD`. No `Get`.                                                                                                                                                                                                                                                                                                                                                                           |
| The excuse hides no refusal, but a `GET` control is the one step the TypeScript side could play; and that side's twin sends `BEAD` and `get` alone                                                                                                                                                      | **Accepted.** No control step: each step opens its own socket, and the next case proves the server standing. Two cases of their own rather than steps added to the 405 cases, since a `differs` excuses a whole case. The row says what holds of the rest: llhttp matches its method table byte for byte, in upper case alone.                                                                                                                                                                                                                               |
| The row, the counts and the gate that holds them are unsaid: `check_crossing` asks the row to name both titles, and `spec/check.py` holds the totals and the Rust side's count, not the TypeScript and C# sides' "but"                                                                                  | **Accepted.** The row names both titles; 268 cases, 91 over HTTP and 46 over WebSocket, the Rust side's 182 of 268, the README's 268; the TypeScript and C# sides' "all 268 but two" each, counted from the file's `differs`. The page's count follows the file, read at its build.                                                                                                                                                                                                                                                                          |
| The CHANGELOG's line is to be reworded and the cases told; the proposal's account of today misses the twins on every side; `BEAD` as the unknown method                                                                                                                                                 | **Accepted.** The line reworded, the cases told; this table answers the proposal as it stands, the three twins cited by the row; `BEAD` kept, a token no parser's table holds and no registered method.                                                                                                                                                                                                                                                                                                                                                      |
