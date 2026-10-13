# 0027 — An HTTP server answers CORS to the origins it names, and to no other

- **Status**: accepted
- **Scope**: the protocol, and every implementation's HTTP server transport: in
  [`spec/spec.md`](../../spec/spec.md), 15.12's CORS paragraph, 15.6's preflight in its order, its
  204 row and `vary: Origin`, and HTTP's own 400 carrying none of the path's fields (15.6, 15.12).
  What `origins` takes is [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s; its check
  as a server is built,
  [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)'s; the
  refusal told and the fields rule,
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)'s.

## Context

**A page of an origin `origins` lists passes the server's test, and its browser sends nothing
without CORS.** Every request a Bead client writes needs a preflight: the connect, since
`application/prs.bead` is no CORS-safelisted type and `bead-listen` no safelisted field; the listen,
for `bead-connection-token`; the send, for `authorization` and the token; the `DELETE`. A server
that answers no preflight refuses it 405 `method-refused`, tells it, and the page's connect fails as
a network error: `Failed to fetch` in Chromium 153, `NetworkError when attempting to fetch resource`
in Firefox 155, `Load failed` in WebKit 26.6, measured against both sides, a page on
`http://localhost:47801` and the server on `127.0.0.1`. A simple cross-origin request, which a
browser sends without a preflight, does nothing: a `POST` of `text/plain` is 415 `type-refused`, a
bare `GET` 400 `malformed`. So CORS for Bead is the preflight and the fields after it.

**The other way, a page of another origin on the WebSocket transport alone**, costs it its one
bearer path: `ELSEWHERE` rides `Authorization` (15.5), which a page cannot set on an upgrade.

**The Fetch Standard.** [§3.3](https://fetch.spec.whatwg.org/#http-cors-protocol): a preflight is an
`OPTIONS` carrying `Access-Control-Request-Method`, answered with an ok status;
`Access-Control-Allow-Origin` is the `Origin` as it came, `null` among them, or `*`.
[§3.3.4](https://fetch.spec.whatwg.org/#http-new-header-syntax): for
`Access-Control-Expose-Headers`, `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`,
`*` is a wildcard for a request without credentials.
[§4.8](https://fetch.spec.whatwg.org/#cors-preflight-fetch): a preflight whose status is not ok is a
network error, whatever it carries, and `Authorization`, the one CORS non-wildcard request-header
name, must be named. [§4.9](https://fetch.spec.whatwg.org/#cors-preflight-cache): a preflight's
cache entry is keyed by its URL. [§4.10](https://fetch.spec.whatwg.org/#cors-check): the CORS check
compares the combined `Access-Control-Allow-Origin` with the origin, so two such fields fail it. The
safelisted response fields are `Cache-Control`, `Content-Language`, `Content-Length`,
`Content-Type`, `Expires`, `Last-Modified` and `Pragma`: every `bead-*` field a client reads needs
exposing. Its caching note asks for `Vary` when an answer turns on `Origin`
([RFC 9110 §12.5.5](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.5)).

**Measured, in Chromium 153, Firefox 155 and WebKit 26.6**, the HTTP client bundled for a page:

- a page whose `fetch` adds what its tracing adds, W3C Trace Context's `traceparent`, Sentry's
  `sentry-trace` and `baggage`, fails its connect against a fixed allow list
  (`authorization, bead-connection-token, bead-listen, content-type`): "Request header field baggage
  is not allowed by Access-Control-Allow-Headers in preflight response", the server's log holding
  only preflights answered 204 and no refusal; under `authorization, *` and an expose `*`, it
  connects, calls, listens, disconnects, and reads `date`, no safelisted field;
- without `Access-Control-Expose-Headers`, the 201 is read and its token is not, "the server drew
  no connection: 201", and a refusal reads with no mark, which the client counts as an exchange
  lost;
- a preflighted `POST` at another path fails as a network error in every engine, whatever its 404
  carries;
- Chromium and WebKit keep one cache entry per origin and URL, replaced by the last answer's lists,
  and match `*`; Firefox keeps an entry per name, as Fetch §4.8 does, merging the names its answers
  list, stores `*` as a literal token nothing matches, and preflights its first two exchanges at a
  URL whatever their methods, then holds the answer. Under `authorization, *`, Firefox preflights
  every exchange; under `authorization`, the names the preflight asks and `*`, the client's opening
  (connect, listen, send, listen, send with `Authorization`, listen, send, `DELETE`) costs 1
  preflight in Chromium and WebKit and 3 in Firefox, then none while the answer holds
  ([0029](0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md));
- a keepalive `DELETE` fired as its page goes, the cache cold, is preflighted after the page has
  gone, and both reach the server; refused 405, the `DELETE` never follows;
- Max-Age is capped at 7,200 s by Chromium, 86,400 s by Firefox, 600 s by WebKit.

**Local Network Access**, which supersedes Private Network Access's preflight
(`Access-Control-Request-Private-Network`): a request from the public address space to the loopback
or a private one waits on its user's permission, asked in a secure context alone; measured, with
the page's address overridden to the public space, Chromium 153 denies it until granted, then CORS
alone applies, and no request carries `Access-Control-Request-Private-Network`. A page at a private
address, not secure, reaches a server on `127.0.0.1` in all three engines, granted nothing. A secure
page's request to `http://` on a private address passes mixed-content blocking only for a private
IP literal, a `.local` name, or a `fetch` given `targetAddressSpace: 'local'`.

**HTTP's own 400.** Node's parser answers a control character before the transport reads the
request, and Kestrel an octet that is no UTF-8, each with no field of the path's, and neither can
be made to write one: a transport that stamps the 400s it writes itself, for the fields rule or an
absolute-form authority, answers one request two ways by which layer refused it, measured on the
C# side's. [RFC 9111 §4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2): a 400 is not
heuristically cacheable.

**The practice.** ASP.NET Core's CORS middleware reads a preflight as Fetch does, echoes the origin,
writes `Vary: Origin` and offers `AllowAnyHeader()`; Express's `cors` reflects
`Access-Control-Request-Headers` and writes `Vary: Origin`; rs/cors takes `"*"` for headers;
`connectrpc/cors-go` gives a protocol's fixed lists, which an application merges its own fields
into; gRPC-Web, through Envoy's CORS filter, exposes `grpc-status` and `grpc-message`; Spring Cloud
Gateway ships `DedupeResponseHeader`, `Access-Control-Allow-Origin` its documented example, for a
gateway and a server that both answer. OWASP's HTML5 Security Cheat Sheet and WSTG-CLNT-07, with
PortSwigger's research, name a reflected origin and a trusted `null` as dangerous **with**
`Access-Control-Allow-Credentials: true`.

The options weighed:

- **A page of another origin on the WebSocket transport alone**: no `ELSEWHERE` from a page, and
  `origins` meaning one thing over WebSocket and half of it over HTTP.
- **Fixed allow and expose lists**, the protocol's fields: they fail every exchange of a page whose
  `fetch` adds a field, silently to the operator, and protect nothing a server does not judge again
  on the exchange.
- **An option naming extra fields, or a told refusal of a preflight asking a field outside the
  list**: surface on both sides for no protection.
- **RFC 9110 §9.3.7's `OPTIONS` served**, 204 with `Allow: GET, POST, DELETE, OPTIONS` to any taken
  request: a method no Bead client sends, for no consumer named.
- **ASP.NET Core's `CorsMiddleware`**: its preflight answer would precede the host's and the
  origin's judgement, and part from 15.6's order and from the TypeScript side.
- **`credentials: 'omit'` in the client**: it breaks a page served with its server on one origin
  behind an authenticating proxy, and protects nothing across origins.

## Decision

**An HTTP server answers CORS to the origins `origins` names, and to no other** (spec 15.12).
`origins` is the operator naming the pages it trusts, over HTTP as over WebSocket, where it already
grants them everything; HTTP is the transport that carries a bearer beside an envelope.

**A preflight is Fetch's**: an `OPTIONS` that carries `Access-Control-Request-Method`. It is judged
in 15.6's order, after HTTP's own refusals, the host, the path and the origin, and before the
method: from an origin `origins` names, it is answered 204, its body empty,
`access-control-allow-methods: GET, POST, DELETE`, what `Allow` names;
`access-control-allow-headers` naming `authorization`, then the preflight's
`Access-Control-Request-Headers`, its lines joined by `", "`, when it asks any, then `*`; and
`access-control-max-age: 7200`, the longest Chromium keeps, a preflight granting nothing the server
does not judge again on the exchange. `authorization` is named since no wildcard covers it, and
Chromium and WebKit replace their entry with the last answer, so a name only reflected would leave
the entry when a preflight that did not ask it answers last. The names asked are reflected since
Firefox caches the names an answer lists and never `*`: reflected, it caches every name a page's
requests carry, a tracing field among them, as ASP.NET Core's `AllowAnyHeader` and Express's `cors`
answer. `*` stays since Chromium and WebKit cache it, and keep covering every name with it. The
reflected value has passed the field rule before it is echoed, and grants nothing `*` did not: a
reflected name is one the browser would send. Joined by `", "` explicitly, both servers write one
value for one preflight, Node handing two lines as `a, b` and Kestrel's `StringValues.ToString()` as
`a,b`. No `Vary` names `Access-Control-Request-Headers`: the answer is an `OPTIONS` response, which
no cache stores ([RFC 9110 §9.3.7](https://www.rfc-editor.org/rfc/rfc9110#section-9.3.7)), and
`Vary` only selects among stored responses; Express's `Vary` is the precedent not taken. Bead's
request fields named besides, which save Firefox one preflight of the opening, are not taken: an
enumeration 15.12, both servers and the generator keep current with every field Bead adds, which
stale breaks nothing and buys only that preflight. The answer is the same whatever method the
preflight asks: the browser judges its request against it, and the server keeps no state. A
preflight is no refusal: nothing marks it, nothing tells it, it draws no connection and counts
against no bound. A preflight from an origin not taken is 403 `origin-refused` as any request is,
told, which names the page to add. Any other `OPTIONS`, from a listed origin with no
`Access-Control-Request-Method`, from the server's own origin or from none, is 405 `method-refused`
as any method but `GET`, `POST` and `DELETE`.

**Every response written to a request whose `Origin` `origins` names, once that origin is judged,
whatever its status, carries `access-control-allow-origin`**, the `Origin` as it came, and
**`access-control-expose-headers: *`**: a page's client reads a refusal's mark to know what failed,
and a field it or its application starts to read later reads as nothing under a list. A refusal
judged before the origin, `host-refused` or `path-unknown`, carries neither: every request a Bead
client writes is preflighted, and a browser reads no answer to a preflight that is not ok. Each side
sets both in one place, once the origin's 403 has passed, before every writer.

**`vary: Origin` on every response on the path** beside `cache-control: no-store` and
`x-content-type-options: nosniff` (spec 15.6), since which one a request gets turns on its
`Origin`, **but HTTP's own 400, which carries none of the three, on every side**: Node's parser and
Kestrel answer some of it before any transport reads the request, so none is the one rule every
server keeps. The C# side writes its own 400 as the TypeScript side's `refuseMalformed` does.

**No answer carries `Access-Control-Allow-Credentials`.** Bead's credential is in the envelope's
block or in the `Authorization` a client's script writes (15.5), never a cookie, a TLS client
certificate or the browser's own HTTP authentication: every request to a Bead server is one without
credentials, which is what makes the wildcards hold, and no listed page reads what a user's cookies
would open on the server's domain.

**`null` is never taken**: it serializes every opaque origin alike
([RFC 6454 §6.2](https://www.rfc-editor.org/rfc/rfc6454#section-6.2), the HTML Standard), so naming
it would take a sandboxed frame of any site, which reads every answer (OWASP's HTML5 Security Cheat
Sheet, WSTG-CLNT-07, CWE-942); a page that sends it has an origin to serve it from instead, a local
development server's, the Bead server's own, or an app shell's custom scheme. `origins` refuses it
as the transport is built
([0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)), so no
answer names it.

**Nothing for Private Network Access**: no browser asks it. Whether a page reaches the loopback or a
private address is its browser's and its user's.

**No client changes**: the TypeScript client leaves `fetch`'s `credentials` at `same-origin`, and a
`fetch` given to it must not use `credentials: 'include'`, which no Bead answer allows.

**A WebSocket server answers no CORS**: no browser asks it of an upgrade (15.2).

## Consequences

**A page of an origin `origins` names reaches an HTTP server**, connects, calls, listens and
presents `ELSEWHERE` in `Authorization`
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)); its tracing or its wrapper may add
any field but credentials. Its preflight is answered and told by none; a method the server does not
take is refused by its browser against `Access-Control-Allow-Methods`, never reaching the server, so
no listed page is told `method-refused`.

**A refusal judged before the origin stays unreadable to a page**, as a refused preflight is.

**Every response on the path but HTTP's own 400 carries `vary`**, and the C# side's own 400 carries
none of the path's fields
([0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)).

**On the TypeScript side, `IHTTPResponseLike` requires `setHeader`**, which `node:http`,
`node:https` and `node:http2`'s responses have.

**A gateway in front that answers CORS for the Bead path stops, or replaces the fields rather than
appends them**, once the server lists the origin: two `Access-Control-Allow-Origin` fail Fetch's
CORS check. A gateway that appends, nginx's `add_header` among them, breaks every listed page.

**A page of the public network needs its user's local network permission besides**, which no server
answers, asked in a secure context alone; a page of a private address reaches the loopback ungated
in the engines measured, which their stated intent is to gate; a secure page reaching `http://` on a
private address by a hostname passes `targetAddressSpace: 'local'` through the client's `fetch`
option.

**A page of another origin preflights its connection's opening**, once in Chromium and WebKit and
three times in Firefox (measured), then pays one round trip per exchange until its browser's cached
answer expires: every exchange of a connection is at one URL
([0029](0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md)), which every engine
keys its preflight cache by.

**The gate.** `spec/transports.json`'s four CORS cases, played by both sides: a listed origin's
preflight; every answer to it once judged; a preflight judged as every request before its origin; an
`OPTIONS` that is no preflight and an exchange from the server's own origin or from none.
`unmarked()` holds HTTP's own 400 to none of the path's fields over HTTP and at a WebSocket's
address, and the WebSocket upgrade from a taken origin to none of CORS's. Twins by the same sentence
([0004](0004-one-behaviour-in-every-language.md)) hold what no step reaches: the preflight over
HTTP/2, the fields on each writer, the listed origin's predicate, `isListedOrigin` and
`IsListedOrigin`. A Playwright configuration of its own, the TypeScript side's
`playwright.browser.config.ts`, runs the HTTP client in Chromium from a page of another origin
against both servers, in CI's .NET job, the one proof that a browser reads the answer; Firefox's and
WebKit's reading of the answer and of `*`, and their preflight caches, are this record's
measurement. `docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, its `Access-Control-Allow-Headers` in a second, and its `null` in a third. Its
objections, each with the answer that holds:

### On CORS over HTTP

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The fixed `Access-Control-Allow-Headers` list (`authorization, bead-connection-token, bead-listen, content-type`), with no option, breaks every exchange of a page whose `fetch` adds a field (W3C `traceparent` from OpenTelemetry, `sentry-trace` and `baggage` from Sentry, any wrapper given as the client's `fetch`), silently to the operator: the preflight is answered 204, nothing is told, the browser never sends the request. A preflight grants nothing the server does not judge again, so the list protects nothing; the fixed expose list fails the same way for any field read later | Accepted. Measured: the traced page fails its connect in Chromium 153, Firefox 155 and WebKit 26.6 against the lists, the server's log holding only preflights answered 204; with `authorization, *` and `*` it connects, calls, listens, disconnects and reads `date`. The Fetch Standard reads `*` as a wildcard for a request without credentials (§3.3.4), which every request to a Bead server is, since no answer allows credentials, and requires `Authorization` named (§4.8). The one field Bead reads that a page could forge, `X-Forwarded-For`, is read only as the entry a trusted proxy appends. The preflight answers `access-control-allow-headers: authorization, *`, every answer to a listed origin `access-control-expose-headers: *`; `allow-methods` stays `GET, POST, DELETE`. No public constant and no client twin pair: both READMEs say a `fetch` given to the client must not use `credentials: 'include'`. An option naming extra fields was weighed and not taken: surface for no protection |
| The CORS fields set before the host, path and origin tests buy nothing: every request a Bead client writes is preflighted, and a preflight answered with a status not ok is a network error whatever it carries; the early placement departs from 15.6's order. `isListedOrigin`'s "never the own origin" can exclude an own origin that is listed, and the server's own-origin test is scheme-blind where the browser's is not                                                                                                                                                                       | Accepted. Measured: a preflighted `POST` at another path fails in all three engines though its 404 carries the fields (Fetch §4.8, §3.3.3); only a simple request, which no Bead client writes, reads it. The fields are set once the origin's 403 has passed: still one place before every writer, 15.6's order kept, and every answer a listed page can read carries them. The conformance case expects no origin named from a listed origin under a host not taken and at another path, folded with the origin not taken. `isListedOrigin` is membership in `origins`, exactly; 15.12 says a page of the server's authority under the other scheme is another origin to its browser, answered CORS only when `origins` names it                                                                                                                                                                                                                                                                                         |
| HTTP's own 400 differs between the sides: the C# side stamps the 400s it writes (`Cache-Control`, `X-Content-Type-Options`, and with `Vary`), where the TypeScript side, Node's parser and Kestrel's own 400 carry none; `unmarked()` asserts only `bead-refusal` absent, so no case sees it, and "every response on the path gains `Vary`" is not held                                                                                                                                                                                                                                               | Accepted. Measured on both servers, three kinds of field. Node's parser and Kestrel answer some of these before the transport reads the request, so none is the one rule every server keeps: the C# side writes its own 400 through a writer that stamps nothing, the twin of the TypeScript side's `refuseMalformed`; `unmarked()` asserts `cache-control`, `x-content-type-options`, `vary` and `access-control-allow-origin` absent, over HTTP and at a WebSocket's address, where both sides write none. 15.6 reads "every response on the path … but what HTTP refuses of its own"; 15.12's field rule and 0026 say the 400 carries none of the path's fields. Nothing is lost: the 400 has no body to sniff and no cache stores it by default (RFC 9111 §4.2.2). A fix, so no matrix row                                                                                                                                                                                                                             |
| The preflight per listen is certain, not "if someone measures it": the client builds each listen's URL from its cursor and Fetch keys the preflight cache by URL, so a page of another origin pays two round trips per batch where a same-origin page pays one. The cure is a 15.9 wire change, cheapest before 1.0, and a decision for the user now                                                                                                                                                                                                                                                  | Accepted. Verified: the URL carries `after` and `wait`, Fetch §4.9 keys an entry by URL, and every engine preflights the listen even under the wildcard answer. This record states the cost as two round trips per batch, a listen that brought nothing hitting the cache. Moving `after` and `wait` into request fields is a 15.9 round of its own, crossing the languages, `Last-Event-ID` the precedent for a cursor in a field and RFC 7240's `Prefer: wait` the standard to weigh; the user puts it before 0.4.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The deployment text is incomplete: a gateway that already answers CORS in front, its origin listed, sends a second `Access-Control-Allow-Origin` and the browser fails; Local Network Access from a private page to the loopback is not gated in the engines, which the text must state as measured; a secure page reaching `http://` on a private address by a hostname is blocked as mixed content unless its `fetch` carries `targetAddressSpace`, which the client's `IFetchInit` lacks                                                                                                           | Accepted, in the text alone. Fetch's CORS check compares the combined field with the origin, so two fail it (§4.10); Spring Cloud Gateway ships a filter for the case. Measured: a page at a private address, not secure, reaches the loopback in Chromium 153, Firefox 155 and WebKit 26.6, granted nothing. Both READMEs and this record say a gateway in front stops answering CORS or replaces the fields once the server lists the origin; the matrix's platform row states LNA as measured, from a public and from a private page, and the mixed-content exemptions, naming the client's `fetch` option as the way to pass `targetAddressSpace`. No code: the member is a Chromium one and no C# client runs in a page                                                                                                                                                                                                                                                                                               |
| The browser evidence ran a shim that answers a listed preflight at any path and host, before the server judges it, which is not the designed order; and the keepalive transcript was not produced by the script beside it, which leaves the cache cold where the transcript's was warm                                                                                                                                                                                                                                                                                                                | Accepted. The ordered shim answers a preflight at the path alone, after the host, the path and the origin, and gives the same connect, call, listen and disconnect in all three engines; the cold case, the token drawn with no `Origin`, has the page's keepalive `DELETE` preflight after the page has gone, and both reach the server in all three. They stand as the evidence, and this record's context names the cold case, the one a page meets once WebKit's 600 s or Chromium's 7,200 s has expired its cached answer. The conclusions stand                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### The allow-headers value, revised

The allow-headers value was revised by
[0029](0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md)'s round; its objections
and answers are kept there.

### `null`, refused

`null` left `origins` in the round on the footguns before 0.4.0, told in
[0010](0010-a-request-presents-a-credential-of-a-scheme.md); none of its objections was on `null`,
which OWASP's HTML5 Security Cheat Sheet and WSTG-CLNT-07 settle, and the option it would have kept,
one named for every site, `opaqueOrigins`, was weighed and not taken: no page that sends `null` lacks
an origin to be served from.
