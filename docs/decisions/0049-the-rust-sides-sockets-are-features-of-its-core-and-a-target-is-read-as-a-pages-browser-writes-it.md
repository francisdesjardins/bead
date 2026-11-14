# 0049 — The Rust side's sockets are features of its core, HTTP on hyper and a WebSocket's head read by Bead, and a target is read as a page's browser writes it

- **Status**: accepted
- **Scope**: the Rust side's transports over WebSocket and HTTP, client and server, their facades,
  their TLS, their clocks and their interop with the TypeScript and C# sides, the stage of
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md) that brings
  them; a server's start and its life on the Rust side; and, on every side, the rule of
  [`spec/spec.md`](../../spec/spec.md)'s 15.12 on a request's target and
  [`spec/transcoding.md`](../../spec/transcoding.md)'s 3.6, which reads it, with the cases of
  `spec/transports.json` and `spec/transcoding.json` that play it; a text message over WebSocket at
  its router, spec 15.2, and one that is no UTF-8, spec 15.3, on every side; and a transport
  server that ends its connections stops,
  with no `closeAll`, on every side. It holds the reading of an absolute-form target's scheme and a
  `#` in a target, which
  [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md) and
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md) cite;
  the hosts, the origins and the authority stay theirs. It names the transports' surface alike on
  every side, under [0047](0047-every-side-shows-one-public-surface.md)'s rule. One behaviour, and
  a difference a row of the matrix, are [0004](0004-one-behaviour-in-every-language.md)'s; the
  bounds a side keeps against a peer
  [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s; the clocks
  [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)'s; a duration
  [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)'s. Ahead: a Rust client in
  a page, the open row `The core in a page and in a worker`; the Rust bench's loopback layers.

## Context

**The sockets join a core that holds everything else.** The Rust side's routers, its managers, its
sessions, the in-memory transport and the broker's core play the conformance files they reach
([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)) with no
socket; the cases over HTTP and over WebSocket, the HTTP and WebSocket places of
`spec/durations.json` and the interop need one. The TypeScript side's `createTransportServer` and
the C# side's `TransportServerLife` hold one life for every server, which a socket's server takes
as the in-memory and broker servers do. Spawning and time go through `crate::platform` and the
clock alone, and the core compiles for `wasm32-unknown-unknown`, where no socket builds.

**hyper reads a target before any code of Bead's does.** hyper, the HTTP implementation the Rust
ecosystem's servers and clients run on, parses every HTTP/1.1 target and HTTP/2 `:path` into
`http::Uri`. Probed, it answers 400 itself `<`, `>` and `` ` `` in a path, and `"`, `<` and `>` in a
query; it cuts a target at its `#` and keeps nothing of what follows, refusing a control character
and DEL there and taking the rest, so that `/a#b` and `/a` are one `Uri` (`http` 1.5.0's
`PathAndQuery::from_shared`, where its `from_static` refuses a fragment); and it reads `HTTP://`,
`hTtP://` and `HTTPS://` as `http://` and `https://`. No option of hyper's keeps or shows the request
line, and `OnUpgrade` gives the socket after a 101, never the head. Node's parser hands every one of
these targets on as it came, a `#` and what follows among them, but an octet past US-ASCII past a
`#`, which it answers 400 itself; over HTTP/2, nghttp2 takes a `#` in `:path`. Kestrel hands on `<`,
`"`, `` ` ``, `{`, `^`, `|` and `\`, which `RawTarget` and `Request.Path` both keep, and answers 400
itself an absolute-form scheme not in lower case and, since .NET 10.0.15, a literal `#` in an
HTTP/1.x target, resetting an HTTP/2 or HTTP/3 stream whose `:path` holds one `PROTOCOL_ERROR`
(dotnet/dotnet `a804e66777`), unless the process-wide `AppContext` switch
`Microsoft.AspNetCore.Server.Kestrel.AllowFragmentInRequestTarget` says otherwise (`c5a167a856`).

**What a page's browser sends.** A page writes a request's target from a URL it parsed, and the URL
Standard percent-encodes, before any byte goes out, the C0 controls, the space, `"`, `#`, `<` and
`>` in a query, and those and `?`, `^`, `` ` ``, `{` and `}` in a path. A page sends `\`, `|`, and
`^`, `` ` ``, `{` and `}` in a query, as they are.

**The standards.**

- **[RFC 9112 §3](https://www.rfc-editor.org/rfc/rfc9112#section-3)**: "Recipients of an invalid
  request-line SHOULD respond with either a 400 (Bad Request) error or a 301 (Moved Permanently)
  redirect with the request-target properly encoded. A recipient SHOULD NOT attempt to autocorrect
  and then process the request". [§3.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2): a
  request-target's four forms, none with a fragment; §3.2.2, absolute-form, which an origin server
  accepts.
- **[RFC 3986](https://www.rfc-editor.org/rfc/rfc3986)**: §2, a URI's characters; §3.1, a scheme
  case-insensitive, which "should only produce lowercase" and "should accept uppercase"; §3.5, a
  fragment set apart from the path and the query by `#`.
- **The [URL Standard](https://url.spec.whatwg.org/#percent-encoded-bytes)**: the query
  percent-encode set and the path percent-encode set, read on 2026-11-09.
- **[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)**: §5.5, a field's value; §7.2, `Host`;
  §15.5.9, 408, which a server may send on a connection it closes; §15.5.20, 431.
- **[RFC 9112 §9.6](https://www.rfc-editor.org/rfc/rfc9112#section-9.6)**: a close in stages.
- **[RFC 9113](https://www.rfc-editor.org/rfc/rfc9113)**: §3.3, HTTP/2 over TLS by ALPN; §8.1.1, a
  malformed request's stream reset; §8.3.1, `:authority` and `:path`.
- **[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)**: §4.1-4.2, the opening handshake; §5.5,
  ping and pong; §7.1.1 and §7.4.1, the closing handshake and its codes; §10.5, a client's
  authentication.
- **[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446)** and
  **[RFC 7301](https://www.rfc-editor.org/rfc/rfc7301)**: TLS 1.3 and ALPN.
- **[RFC 5280 §6](https://www.rfc-editor.org/rfc/rfc5280#section-6)** and §4.2.2.1: a certificate
  path validated, its intermediates fetched by AIA, which a platform's verifier does and a snapshot
  of roots does not.
- **[RFC 8305](https://www.rfc-editor.org/rfc/rfc8305)** §4-5: Happy Eyeballs, a socket's timing.
- **[Cargo's features](https://doc.rust-lang.org/cargo/reference/features.html)**: additive, each
  combination a build.

## Decision

### The features and the modules

The Rust side's sockets are **two features of its core**, `websocket` and `http`, additive and off
by default, since a transport reaches the core's inside
([0047](0047-every-side-shows-one-public-surface.md)): `websocket` builds the WebSocket server and
client and their facades, `http` the HTTP server and client and their facades. What judges a request
is pure and always built, in `crate::judgement`, the head's reader among it: a request's host, its
target, its origin and its proxies, the policy's Items
([RFC 9651](https://www.rfc-editor.org/rfc/rfc9651)), the WebSocket handshake, so the fuzz targets
`http-fields` and `ws-handshake` and the players reach them through `bead::internal` with no
feature. A server's life, `crate::life`, is core and always built, the in-memory, broker, WebSocket
and HTTP servers each holding it, as `TransportServerLife` is the C# side's. No crate is named for
either transport.

### The libraries

Each a version past its cooldown on 2026-11-09, each pinned by the lock:

| Crate                                                | Carries                                                                             | Feature     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------- |
| tokio 1.54.1, `net` and `io-util`                    | the sockets                                                                         | both        |
| httparse 1.10.1                                      | an HTTP/1.1 head, RFC 9112 §2-§5, the WebSocket server's and the fuzz targets'      | always      |
| socket2 0.6.5                                        | `IPV6_V6ONLY` on a listener, `SO_LINGER` 0 on a drop                                | both        |
| futures-util 0.3.34, `sink` and `std`                | a WebSocket's stream and sink, Happy Eyeballs' race, a facade's wait on two futures | both        |
| http 1.5.0                                           | the request and response types                                                      | both        |
| tungstenite 0.30.0 and tokio-tungstenite 0.30.0      | RFC 6455's frames, its masking, ping and close, and the client's handshake          | `websocket` |
| hyper 1.12.0, `server`, `client`, `http1`, `http2`   | RFC 9112 and RFC 9113                                                               | `http`      |
| hyper-util 0.1.21, `tokio`, `client-legacy`, `http1` | tokio's IO adapter and the pooled client                                            | `http`      |
| h2 0.4.20                                            | a stream reset with its reason                                                      | `http`      |
| tower-service 0.3.3                                  | the connector the pool takes                                                        | `http`      |
| rustls 0.23.46 over aws-lc-rs, tokio-rustls 0.26.6   | RFC 8446 and RFC 7301, `X25519MLKEM768` first                                       | both        |
| rustls-platform-verifier 0.7.1                       | a server's certificate verified by the platform                                     | both        |
| httpdate 1.0.3                                       | an HTTP-date (RFC 9110 §5.6.7): a `retry-after` read, a refusal's `date` written    | both        |

**aws-lc-rs is C and assembly**, built by the platform's C compiler: the core with no feature stays
pure Rust, and a build with a socket feature needs that compiler, MSVC's on Windows. A body is
read frame by frame through hyper's own `Body`, under its bound, by Bead's code. `deny.toml`
allows `ISC`, the licence of rustls-webpki, aws-lc-rs and aws-lc-sys, and one exception,
`webpki-root-certs`' `CDLA-Permissive-2.0`, which the platform's verifier takes on wasm32 alone.

### A target read as a page's browser writes it, on every side

Every side judges a target as it came, by 15.12: the raw `request.url` on the TypeScript side, an
HTTP/2 `:path` among it, `IHttpRequestFeature.RawTarget` on the C# side, the head's own bytes at the
Rust side's WebSocket address, and hyper's `Uri` at its HTTP address. One predicate refuses a
target, 400 unmarked, its stream reset `PROTOCOL_ERROR` over HTTP/2, nothing written, when it holds:

- a control character, HTAB, a bare CR, DEL, a space or an octet past US-ASCII, anywhere;
- a `#`, anywhere; `"`, `<` or `>` in its path or its query; `^`, `` ` ``, `{` or `}` in its path;
- a path whose percent-decoding holds NUL.

Its refusals are one answer, so no order among them shows. A target it takes is then read apart in
absolute-form, since that form yields the authority: `http` or `https` in any ASCII case, then `://`
and an authority that is not empty and is a host; any other, 400 unmarked. Three things hold, each
by its standard:

- **What a page's browser always percent-encodes where it stands is an invalid request-line**
  (RFC 3986 §2, RFC 9112 §3): the URL Standard's path and query sets, less what a URI keeps, `'`
  among it, a sub-delim of RFC 3986 §2.2 that a request-line may hold. They cover every target hyper
  refuses, and Bead refuses the rest itself. `\`, `|`, and `^`, `` ` ``, `{` and `}` in a query are
  taken as they came, as a page sends them.
- **A target that holds a `#` anywhere is an invalid request-line** (RFC 9112 §3.2, §3): no form of
  a request-target carries a fragment, and serving a target cut at its `#` is the autocorrection §3
  tells a recipient not to make. A page's browser never sends one, since the URL Standard reads a
  `#` as a fragment's start, which fetch never sends, and every client of Bead's builds its target
  with a URL parser; a hand-written client that sends one is refused, never served another
  resource. `%23` is an octet the target encodes, a character of its path or its query. Each side
  judges the `#` itself, never by its platform's patch level: Kestrel refuses it first since 10.0.15,
  and the C# side's judgement of `RawTarget` refuses it alike on an earlier runtime. The Rust side's
  HTTP address and its gateway cannot: hyper's `Uri` has cut the `#` before Bead reads the target,
  over HTTP/1.1 and in HTTP/2's `:path` alike, so each serves the target cut, a row of Differences,
  `A # in a target`, lifted when hyper's HTTP/1.1 server refuses a request-target that holds a `#`
  before it builds its `Uri` and h2's server treats a `:path` that holds one as malformed, the two
  changes asked of them
  ([0052](0052-the-rust-sides-gateway-is-a-feature-of-its-core-its-json-mapping-a-feature-of-its-proto-codec-and-a-head-never-holds-a-stream.md)).
- **A scheme is read in any case** (RFC 3986 §3.1), as hyper reads it and Node hands it on. Kestrel
  answers any other than lower case 400 before the application runs: a row of Differences,
  `A target in absolute-form, its scheme's case`.

`spec/transports.json` holds seven cases of these, four over HTTP and three at a WebSocket's
address, beside those of a control character; `spec/transcoding.json` refuses `/v1/books/a"b` in the
exchange that reads a target, and `/v1/books/a#b` in one of its own, beside the one that reads
`/v1/books/a%23b` as `a#b`. A side plays them all but those a `differs` excuses it from: the C# side
the two of a scheme's case, and the Rust side's HTTP address and its gateway the ones of a `#`.

### The WebSocket server reads its own head

An upgrade is one GET head with no body. The WebSocket server reads it with httparse, hyper's own
tokenizer, under the head's bounds and its deadline, judges it by 15.2's steps, writes its 101 or
its refusal itself, every refusal saying `connection: close` and its socket closed in stages, and
hands the socket to `tokio_tungstenite::WebSocketStream::from_partially_read`, what it read past the
head given first, so a frame written with the upgrade reaches tungstenite. No hyper serves it: the
target stays as it came, a silent socket is told from a head under way, and no socket is taken back
from hyper after a 101.

### The head's bounds, the 408 and the idle close

A head is bounded to **16 KiB, its request line among it, and 100 fields**, 431 past either, over
HTTP/1.1 by hyper's `max_header_size` and `max_headers`, and at a WebSocket's address by its own
read; over HTTP/2, by `max_header_list_size` alone, 16 KiB as RFC 9113 §6.5.2 counts it, 32 bytes
more a field, which bounds no count of fields. hyper's default, 417,792 bytes, is 25 times Node's.
Kestrel bounds its line apart from its fields, so the spec states no figure: a row of Differences,
`A request head's size`.

A head under way, or nothing on a connection that has answered nothing yet, is answered **408 by
the transport** past `headers_timeout`, as Node answers a silent new connection; a kept-alive
connection idle that long is **closed without a word**, as Node and Kestrel close one. hyper's head
timer is also its idle timer, so the transport tells the two by its own count of the responses it
wrote, not by what hyper buffered. Under TLS, hyper's timer starts once the handshake is done, so
the handshake runs under `headers_timeout` too, closed without a word past it. Each platform's figures
are a row of Differences, `An idle connection's close`.

### TLS

Every `rustls` config is built by `builder_with_provider(aws_lc_rs::default_provider())`, never
`builder()` nor `install_default`, which panic where an application's graph enables both of rustls's
providers. A client verifies by **`rustls-platform-verifier`**, on that builder: Windows' and
macOS's chain engines, on Linux the system's store read into webpki, so a path's intermediates are
fetched as the platform fetches them (RFC 5280). Where the platform checks revocation, Windows and
macOS, it checks the end certificate's, and rustls calls the verifier within its handshake, so a
slow OCSP responder or CRL holds a thread of the runtime while it fetches, up to 10 s on Windows;
neither other side's HTTP or WebSocket transport sets a revocation mode, leaving its platform's
default. A client takes `tls`, a `TlsOptions`
([0053](0053-a-client-presents-the-tls-certificate-and-trusts-the-authorities-its-application-names-in-one-shape-on-every-side.md)), from which Bead builds its config: webpki over the authorities given, the platform's
verifier otherwise, the certificate by `with_client_auth_cert`; an application's own `ClientConfig`
is its `client_config`, refused beside `tls`. A server's `tls` is
the application's `ServerConfig`, Bead's copy of it offering `h2` and `http/1.1` by ALPN. A client's
trust roots per platform are a row of Differences, `A client's trust roots`.

### The clocks

A socket's timings run on the platform's `SystemClock`, whatever clock the transport is given: a
head's `headers_timeout`, a close's `close_timeout`, a WebSocket's heartbeat, the send pace's check,
the close in stages, Happy Eyeballs' 250 ms between attempts, the HTTP client's pool's idle reaper.
What the protocol times runs on the transport's clock: an HTTP connection's inactivity, an
exchange's timeout, a listen's wait, a body's rate past its grace, a connect's timeout and a
reconnection's delays ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)). hyper's
`rt::Timer`, which names `Instant`, lives in `clock::native` beside `SystemClock`, and its executor
is Bead's over `platform::spawn`. A socket transport is refused as it is built on a runtime without
tokio's IO driver, a `ProgrammerError`, as one without its time driver is.

### A server starts itself

`start` leaves `ServerTransport`: each server's `start` gives the `TransportServerAddress` it
listens at, the in-memory server `local` and 0, a broker's its participant's id and 0, a socket's
its address and port. `stop` stays on the trait. `TransportServerStartOptions` holds `address`,
both loopbacks by default, `port`, 80, `find_open_port` and `signal`, the one record the C# side
takes too.

### The surface and its defaults

`WebSocketTransportServer`, `WebSocketTransportClient`, `WebSocketServer`, `WebSocketClient`,
`HttpTransportServer`, `HttpTransportClient`, `HttpServer`, `HttpClient` and `HttpPolicy`, each
with its options, the twins of the other sides' by name; `WEBSOCKET_REFUSALS` and `HTTP_REFUSALS`;
the defaults the other sides export, by the same names in Rust's case; and `bead::rustls`, the
rustls the features build. A client's connect names its `host` and its `port`, a WebSocket
client's `pathname` is `/`, the HTTP client follows no redirect, asks HTTP/1.1, and keeps an idle
connection 4 s, under Node's 5 s, on Bead's timer, re-sending only a request none of whose bytes
were written. Every duration a `Duration`, `NEVER` where the others take `Infinity`.

### The names every side shares

The transports' surface takes one name a concept on every side, in its language's case, as
[0047](0047-every-side-shows-one-public-surface.md) has it: an HTTP server's refusals are
`HTTP_REFUSALS` and a WebSocket server's `WEBSOCKET_REFUSALS`; an HTTP policy's options are
`IHTTPPolicyOptions`, `HttpPolicyOptions` on the C# and Rust sides; a server's start takes one
`TransportServerStartOptions`, whatever its transport, the C# side's in `Bead.Core`; a WebSocket or
HTTP client's connect names its `host` and its `port`, required on every side; and a WebSocket
client's `pathname` is `/` by default. The HTTP client's facade keeps its three names, one row of
`tools/names.tsv` rendered by its platform: `HTTPClient`, `BeadHttpClient` beside .NET's own
`System.Net.Http.HttpClient`, and `HttpClient`.

### A text message reaches its router

A WebSocket transport, server and client, on every side, hands a text message to its router as it
hands a binary one, marked text, its connection's activity stamped as it is read, before anything
judges it; the router counts it against what its connection has not taken by **its bytes as the
wire carried them, UTF-8** ([RFC 6455 §5.6](https://www.rfc-editor.org/rfc/rfc6455#section-5.6),
spec 15.12), then reports it `ENVELOPE_MALFORMED`, "an envelope is binary, not a string", through
its own `error` event with its connection (none on a client), releases its count in that turn, and
hands nothing on (spec 15.2). The transport reports nothing of it: what a transport reports on its
`error` is what it ends a connection for of its own (spec 15.1), and a text ends nothing. The mark
is the C# side's `TransportMessage.IsText` and the Rust side's `TransportMessage::is_text`; on the
TypeScript side a text is the string the WebSocket API gives (`MessageEvent.data`, a DOMString),
counted by its UTF-8 length, since a page's client receives nothing else. An in-memory or broker
transport refuses to send a text, before anything goes, the connection kept: "an in-memory
connection carries envelopes, as bytes", "a broker connection carries envelopes, as bytes"
(TypeScript `ProgrammerError`, C# `ArgumentException`, Rust a `ProgrammerError`). A WebSocket or
HTTP transport sends what it is given as binary, the mark unread.

A text message that is no UTF-8 never reaches its router: every side's transport fails its
connection with 1007, "Invalid frame payload data" (spec 15.3,
[RFC 6455 §8.1](https://www.rfc-editor.org/rfc/rfc6455#section-8.1),
[§7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1)), a page's client as its browser
does; the Rust side reads tungstenite's `Error::Utf8` so, its `Failed::InvalidPayload`. A close
whose reason is no UTF-8 closes as each platform does, `ws` with 1007 and .NET with 1002, a row of
the matrix, the Rust side with 1007 since tungstenite raises the same error for it; no standard
picks that code, and none is worth a second framer under `ws` or under .NET. A text message in
fragments fails at the first that breaks it on the C# and Rust sides, and once its last came on the
TypeScript side, `ws` judging a text message whole: a row of the matrix too.

### A server that ends its connections stops

A transport server that ends its connections stops (spec 15.1), each closed going away, 1001
([RFC 6455 §7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1)); one connection closes by
`close` (TypeScript, Rust) or `CloseConnection` (C#), on the server's transport on every side
(`IServerTransportLike`, `IServerTransport`, `ServerTransport`). No transport server closes every
connection it holds while it listens on: the TypeScript side's `ITransportServer` and
`createTransportServer` carry no `closeAll`, the C# side's `HttpTransportServer` and
`WebSocketTransportServer` no `CloseAll`, and the Rust side's servers no twin of them. A `closeAll`
beside the stop is refused: no caller needs one, and it would close a snapshot of the connections
by `Promise.all`, each with 1000, where a stop sends 1001. `clients` is on each concrete transport
server, every side, a copy without the sockets, which twin tests hold on the Rust WebSocket and
HTTP servers as on the others'.

### The interop

The interop runs both ways with the Rust side, over WebSocket and over HTTP: its client against the
TypeScript and C# servers of the interop service, and their clients against its server,
`francisdesjardins-bead-interop-server`. CI's `rust` job builds that server and its test binary
once and hands them on; a job of its own, `interop-rust`, runs them in the image the browser's tests
run in, with no Rust toolchain, the binary finding the repository at run time.

The Rust HTTP client sends each envelope in an exchange of its own, as the other sides' do, so two
envelopes reach the server in no guaranteed order (spec 15.1, 15.5): a CANCEL may overtake the
REQUEST it cancels. The interop's trials keep their order by a guard of the tests' own, `InOrder`,
which lets an envelope go once the server answered the head of the one before, as the TypeScript
side's `fetchInOrder` and the C# side's `InOrder` keep theirs; the transport orders nothing.

## Consequences

- **Every side refuses what a page never sends**, and takes what it does: a hand-written client that
  sends `<`, `{` or `#` raw in a path, or `"` in a query, is answered 400; nothing a browser writes
  is.
- **No application sees a `#` in a target**: every side refuses it, but the Rust side's HTTP
  address and its gateway, which serve the target cut at it, its application never seeing what
  followed.
- **The C# side keeps one row of Differences**, Kestrel's refusal of an upper-case scheme, and the
  Rust side one, its HTTP address and its gateway serving a target cut at its `#`; a case's or an
  exchange's `differs` excuses its player from each.
- **A build with a socket feature needs a C compiler**, aws-lc-rs's; the core with no feature does
  not.
- **CI lints the core's library four ways**, with no feature, with `websocket` alone, with `http`
  alone and with all, and checks the browser's target by its features, no socket among them.
- **Ahead**: a Rust client in a page, over the page's `WebSocket` and `fetch`, with the open row
  `The core in a page and in a worker`; the Rust bench's loopback layers, beside the in-memory one.

**Its gates**: the cases over HTTP and over WebSocket of `spec/transports.json` and their places of
`spec/durations.json`, played by every side; the twins of 15.10 and 15.12; the fuzz targets
`http-fields` and `ws-handshake`; the interop both ways; the core's lib linted under each feature.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
four rounds, each at xhigh effort. Their objections, each with the answer that holds:

### On the sockets and a target's reading

Fourteen objections, each checked against its probe or the code before it was answered. Twelve
were accepted, two in part, and none refused.

| Objection                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hyper reads every target as `http::Uri`: it 400s `<`, `>`, `` ` `` in a path and `"`, `<`, `>` in a query, and cuts a target at `#`, where 15.12 takes them as they came; no case sends them, so CI never sees it. Bead should read each request line itself, or level 15.12. | Accepted. The probes confirm it and add the tail past a `#` (control characters refused, the rest taken). Reading each head is refused: a pre-read reaches a connection's first head alone, and a second parser beside hyper's invites smuggling. 15.12 holds every side instead, by standards: a character a URI leaves out that a page's browser always encodes where it stands is an invalid request-line, 400 unmarked (RFC 3986 §2, RFC 9112 §3, the URL Standard's path and query sets, a superset of hyper's refusals, Bead refusing the rest itself); a `#`, as the third round answers it; the scheme is read in any case (RFC 3986 §3.1). The cases the Decision counts hold each side's server to it. |
| The WebSocket server needs no hyper: an upgrade is one head, which httparse reads, keeping the target raw, giving Bead its own 408 and dropping the take-back after a 101.                                                                                                    | Accepted. The server reads its head with httparse under its bounds and its deadline, writes its 101 and its refusals, `connection: close` on each, and closes in stages. What it read past the head reaches tungstenite first, by `WebSocketStream::from_partially_read`: a frame written with the upgrade. The head's parse is pure and always built, so the fuzz target reaches it with no feature.                                                                                                                                                                                                                                                                                                            |
| hyper's head timer is also its idle timer: as written, every idle connection gets a 408 at 30 s; Node and Kestrel close idle connections silently. The client's pool keeps idle connections 90 s against Node's 5 s.                                                          | In part. A kept-alive connection gone idle closes without a word; but Node answers a silent new connection 408 at `headersTimeout` (probed), and `read_buf` is empty for both, so the rule follows the transport's own count of the responses written, not the buffer. The pool's idle timeout is 4 s, under Node's 5 s, on Bead's timer, without which hyper-util applies none. A row, "An idle connection's close", names the three platforms. The round found one more: under TLS, hyper's timer arms only after the handshake, so the handshake runs under `headers_timeout` on the platform's clock, closed without a word past it, as Node and Kestrel bound theirs.                                       |
| A head is bounded at hyper's 417,792 bytes, 25 times Node's, with no option, table or row naming it.                                                                                                                                                                          | Accepted. 16 KiB, the request line among it, and 100 fields, 431 past either, over HTTP/1.1 and at a WebSocket's address, and 16 KiB alone, as h2 counts it, over HTTP/2; a row, "A request head's size". Not leveled in the spec: Kestrel's line and fields are bounded apart.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Both of Q4's options contradict 15.12's text, so "no change to the spec" cannot stand; option (b) leaves C# the one side unable to meet the spec.                                                                                                                             | Accepted. The spec reads the scheme in any case, as RFC 3986 §3.1 does; the leveling breaks whichever way once the Rust side cannot hold it, and the standard decides which text the spec states. Kestrel's refusal is a row of Differences, lifted when Kestrel reads any case; a case with its `differs` holds it.                                                                                                                                                                                                                                                                                                                                                                                             |
| `rustls-native-certs`, which its own README advises against; `builder()`, which panics with both providers; no row on trust roots.                                                                                                                                            | Accepted. `rustls-platform-verifier` 0.7.1, one licence exception for its wasm32-only roots; every config built with its provider named; a row, "A client's trust roots", which says Linux reads its system store into webpki.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The server's life is core on both other sides, yet gated under the socket features and landed with the WebSocket server, while the in-memory and broker starts are rewritten by hand; the twin load is overcounted.                                                           | Accepted. `crate::life` is core and always built, the in-memory and broker servers holding it as the WebSocket and HTTP servers do, the 8 shared rows and `TransportServerLifeTests` with it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Happy Eyeballs on the transport's clock, where both other sides race on the platform's.                                                                                                                                                                                       | Accepted. Its 250 ms are the platform's `SystemClock`; the connect's timeout stays on the transport's clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Two features make four builds, and CI compiles two.                                                                                                                                                                                                                           | Accepted. The core's lib is linted with no feature, with `websocket` alone and with `http` alone, by three explicit steps, no new tool to pin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The draft settles names for Rust and leaves the TypeScript and C# sides split.                                                                                                                                                                                                | Accepted. `HTTP_REFUSALS`, `IHTTPPolicyOptions`, one `TransportServerStartOptions`, a connect's `host` and `port` required, a WebSocket's `pathname` `/`; the HTTP client's facade one row, `rendered`, beside .NET's own `HttpClient`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The service client is a stage of its own under 0044 and needs no socket.                                                                                                                                                                                                      | Accepted. It is 0044's stage, apart; 0049 holds the sockets and the target rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A runtime without its IO driver panics at the first socket; hyper's `Timer` names `Instant`, a disallowed type.                                                                                                                                                               | Accepted. A socket transport is refused as it is built on such a runtime, a `ProgrammerError`; hyper's timer lives in `clock::native`, beside `SystemClock`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `interop-rust` starts the C# server cold and rebuilds what the `rust` job builds, on a runner that needs a Chromium.                                                                                                                                                          | Accepted. The `rust` job uploads the interop server and its test binary; `interop-rust` runs in the Playwright image, builds the C# server first, and needs no Rust toolchain; the binary finds the repository at run time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The HTTP client rests on `client-legacy`, a module named legacy, with no word on why, nor on its idle timeout and its retry.                                                                                                                                                  | In part. The choice stands, now stated: the pool the Rust ecosystem's clients run on, where `client::pool` gives layers and no client, and `conn::http1` would make Bead write a pool. Its idle timeout is 4 s on Bead's timer, and its re-send touches only a request none of whose bytes were written, which no server saw.                                                                                                                                                                                                                                                                                                                                                                                    |

Refused besides, each weighed: Bead reading each HTTP/1.1 head by a pre-read rewound into hyper,
which reaches a connection's first head alone, and an HTTP/1.1 server of Bead's own over httparse,
a second parser beside hyper's; a connection per request, so that every head is a first; 15.12 kept
and the Rust side's erasures a row, a library choosing what the spec holds; leveling to exactly
what hyper refuses, `"` refused in a query and taken in a path; every character a URI leaves out
refused, which would refuse pages; the scheme kept in lower case, the Rust side a row; `'` refused
in a query; the WebSocket server on hyper; a 408 only where hyper
buffered bytes, and a second timer for the idle close; hyper's head bound, Kestrel's 32 KiB, or a
bound in the spec; `rustls-native-certs`, `webpki-roots`, `ring`, `rustls-rustcrypto` and
`native-tls`; hyper-util's `client::pool` layers, `hyper::client::conn::http1` with a pool of Bead's
own, and reqwest; a crate per transport; a `tls` feature; `cargo hack --each-feature`; h2c; the
service client in this stage; and axum, fastwebsockets, `TokioExecutor` and `TokioTimer`.

### On the four divergences between the sides

Two of the four, what a listener of an `error` event throws and a call to a client whose transport
is not open, are
[0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)'s
and [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s, whose rounds answer their
objections; a text message at its router and `closeAll` are this record's. Five objections, each
checked against the code before it was answered: two accepted, three in part, none refused.

| Objection                                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "As TS and C# do" is two behaviours: TypeScript hands a decoded string and counts it in UTF-16 units, C# bytes marked text counted in UTF-8 bytes; and the Rust radius is larger — a public field on a `#[non_exhaustive]` type with a hand-written `Debug`, 36 construction sites, the in-memory and broker sends' refusals | In part: the count's unit is named, the bytes the wire carried, UTF-8 (RFC 6455 §5.6), and the TypeScript side counts a string by its UTF-8 length; the Rust radius is listed — the field, its `Debug`, every construction, the in-memory and broker refusals as the other sides', and their twins; and hearing the router alone also stops the Rust player hearing the transport's 1009 report the case does not list. Handing bytes marked text on the TypeScript side is refused: the WebSocket API delivers a text as a string, which a page's client receives and nothing else |
| A fourth state: the Rust server stamps no activity on a text, and its twin cannot tell, its clock frozen and a binary following                                                                                                                                                                                              | Accepted: the activity is stamped as a message is read, before anything judges it; the Rust twin steps its clock between the text and the binary and asserts the stamp after each, as the TypeScript twin does                                                                                                                                                                                                                                                                                                                                                                      |
| The parity rule names removal first, and nobody calls `closeAll`: it is `Promise.all` over a snapshot, closes with 1000 where a stop sends 1001, and may go before 1.0.0                                                                                                                                                     | Accepted: no side's transport server carries a `closeAll`, nor its tests, the CHANGELOG telling its removal; the Rust side has none                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The level differs for `clients`, `close` and `closeAll` alike — interface on one side, inherent on another, a trait on the third — and the names check cannot see an instance method                                                                                                                                         | In part: with no `closeAll`, nothing is added at any level. `close` stands on the server's transport on every side, `IServerTransport.CloseConnection` among them (`Server.cs` 74), where the objection read none; `clients` stands on each concrete transport server on every side and on no joined one. One level each; the matrix and the twins hold it, and the Rust WebSocket and HTTP servers hold their `clients` twins                                                                                                                                                      |
| The round is undersized: an error listener's throw revises a record and 15.1, a call to a client not open the companion and a count, a text message a public Rust type; that is the full round's size, and the first two should go through it with their records                                                             | In part: the size is accepted, and this round is the full one, its rules 15.1, 15.2 and debugging 2.2, 9.6 and 9.7, its records 0023, 0013 and this one. The split into rounds of their own is refused: each behaviour stands on its own, none waiting on another                                                                                                                                                                                                                                                                                                                   |

### On a # in a target

Kestrel answers a literal `#` in a target 400 since .NET 10.0.15, before any code of Bead's runs, so
no leveling ends a target at its `#` on every side; the standard picks which way it breaks, and RFC
9112 §3.2 and §3 refuse it. The proposal: a `#` anywhere in a target is an invalid request-line on
every side that can see it, the Rust side's HTTP address a row. Ten objections, each checked
against the code, the crates the lock pins, nghttp2 and the two Kestrel commits: all ten accepted,
none refused.

| Objection                                                                                                                                           | Answer                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This record refused this design by name, a `#` refused on every side but the Rust HTTP server, and the proposal does not say why the refusal falls. | Accepted. What moved is Kestrel's refusal of a literal `#`, dotnet/dotnet `a804e66777` (PR 66712 of dotnet/dotnet), and its process-wide switch, `c5a167a856`, which this round's opening states.                                                                      |
| Two cases, their `differs` and the matrix's rows die with the cut, unnamed.                                                                         | Accepted. One case over HTTP refuses every `#` and takes `%23` in a query and in a path; the control character past a `#` is a step of the case of a control character over HTTP, which every side plays. `A # in a target` is a row of Differences, of kind platform. |
| `orLost` tolerates a socket lost, not another status, and a mark per address is a new shape of the files.                                           | Accepted. The case over HTTP carries a `differs` for the Rust side, the shape every player reads; the case at a WebSocket's address carries none, which the Rust side plays.                                                                                           |
| `spec/transcoding.json` has no `differs`, and its `#` is one step of an exchange of eleven, which the Rust gateway would fail whole.                | Accepted. The `#` is an exchange of its own, `/v1/books/a#b` refused and `/v1/books/a%23b` read as `a#b`, so that one exchange takes the excuse when that gateway comes; transcoding 3.6 refuses a `#` anywhere with the rest.                                         |
| No test sends a `#` in `:path` over HTTP/2, and nghttp2 lets one through.                                                                           | Accepted. A twin on the TypeScript and C# sides resets a `:path` of `/bead#x` `PROTOCOL_ERROR`, nothing written, and serves one that holds `%23`; on the TypeScript side it holds Bead's own judgement, since nghttp2 hands the `#` on.                                |
| The twins that take a `#` flip on every side, and the Rust HTTP twin cannot.                                                                        | Accepted. Every twin refuses a `#`, its title saying so; the Rust side's test of `Fields::target` keeps asserting hyper's cut, and a server test over a raw socket that sends `POST /bead#x` and reads 201 is the row's test.                                          |
| The row's lift is a wish.                                                                                                                           | Accepted. It names the change: `http`'s `PathAndQuery::from_shared` refusing a fragment as its `from_static` does, hyper then answering 400 itself, and h2 alike for `:path`.                                                                                          |
| Where a `!` goes, and where it does not.                                                                                                            | Accepted. On the Rust side's `Fields::target`, where 15.12 cannot be held; a plain note on the C# side's `IsVisibleTarget`, which Kestrel reaches first since 10.0.15.                                                                                                 |
| The CHANGELOG's bullet is rewritten, not added to.                                                                                                  | Accepted. The CHANGELOG's one Breaking bullet on a target read as a page's browser writes it names the `#`, answered 400 by the transport, at an upgrade and by the gateway.                                                                                           |
| With nothing cut, the six ordered steps are one predicate, and a `#` belongs beside `"`, `<` and `>`.                                               | Accepted. One predicate over the target, then the reading of absolute-form apart, since it yields the authority; a `#` stands beside `"`, `<` and `>`, on its own ground, a fragment no request-target carries.                                                        |

Refused besides, each weighed: the C# server setting `AllowFragmentInRequestTarget`, a switch of
the host's whole process that loosens every endpoint it serves, and only before its
`KestrelServerOptions` are read; the C# side alone refusing, a row by patch level, which on an
earlier runtime still needs its own judgement; every side cutting, which Kestrel no longer lets the
C# side do without that switch; a pre-read or a wrapper of the socket that finds each request line,
the second parser this record refuses; and a mark per address, or `orLost`, in the conformance
files.

### On a text message, and a close's reason, that is no UTF-8

Seven objections, each checked against its probe, the code or the source it cites: six accepted,
one in part, none refused.

| Objection                                                                                                                                                                                                                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No single code for a close's reason is reachable at the cost stated: ws and .NET pick and send theirs before Bead reads anything, so the reason is a row of kind platform, neither open nor leveled down, and no side moves.                       | Accepted. ws sends 1007 and .NET 1002, each before its error reaches Bead (`ManagedWebSocket.cs:1106-1108, 1271-1273`, re-read); the levers exist, but a stream under either is a second framer. The reason is the row `A close whose reason is no UTF-8`, of kind platform: TypeScript 1007, C# 1002, Rust 1007. The proposal's leveled-down fallback and the C# side's move are dropped.                                                              |
| The Rust mechanism does not exist: tungstenite raises one identical `Error::Utf8` for both and writes nothing, Bead's catch-all sends the 1002, and one arm for 1007 brings a `Failed` variant, its reports, its docs and the Rust client with it. | Accepted. Re-read at 0.30.0: both go through `From<str::Utf8Error>`. The arm `Some(Err(error @ WsError::Utf8(_)))` fails with `INVALID_PAYLOAD`, 1007, as `Failed::InvalidPayload`, after RFC 6455 §11.7's name; the reports say "closed with 1007", the server's and client's docs and `Ended`'s name it; the Rust client moves and gets its twin. The row and the three test comments stop blaming tungstenite. No check of its own, no upstream ask. |
| Neither citation for 1007 on the reason holds, and no norm picks a code: a close is a control frame, not a message; §5.5.1 calls nothing a violation; Autobahn 7.5.1 lists 1002 first; implementations split.                                      | Accepted. §7.4.1 names 1007 for a text message's data alone; §5.5.1 leaves the reason's interpretation undefined; 7.5.1 takes either. The record says both codes conform and the tie breaks on cost. One correction: §8.1 binds the libraries under Bead, which decode the reason, and that is why they fail it; it does not bind the Rust MQTT link, which does not.                                                                                   |
| "Every side" cannot hold for clients, not even for text: a page's `WebSocket` gives no lever, Chromium sends 1002 for both, no client side has a test, and no Bead peer branches on the code.                                                      | Accepted. Spec 15.3's sentence leaves a page's client to its browser, as 15.3 already leaves it its close timeout; the row `A text message that is no UTF-8 at a page's client` holds it, Chromium 1002 and Firefox 1007 by reading. Every other client gets a twin: Node's ws and global `WebSocket` 1007 for both (probed), C# 1007 and 1002, Rust 1007 for both. The matrix's MQTT row that said "a browser alike" is corrected.                     |
| The text half is a shared behaviour, so it belongs in the spec and `spec/transports.json`, at the cost of a spec version and regenerated files.                                                                                                    | In part. One unfragmented case, `a text message that is not UTF-8 fails its connection with 1007`, frames `{1, true, FF FE}`, expecting `close: 1007`, written by `make_transports.py`, and a sentence in 15.3, its unit's hash moved. The cost is refused: the release moves the version and every `specVersion`, and the spec already holds unreleased changes under 0.14.0.                                                                          |
| The sides agree on the code but not on the moment: ws judges a text message whole, so one in fragments fails at its last; .NET and tungstenite at the first bad one.                                                                               | Accepted. The case is unfragmented. The row `A text message that is no UTF-8 in fragments`, of kind platform, states the moment, and each side's server twin plays it: a first fragment `FF` and a ping, ws answering the pong and failing at the continuation, .NET and tungstenite failing at once.                                                                                                                                                   |
| The Rust MQTT 5 link now answers a broker's close with a close of no body, its reason not judged: a third answer, which no row holds.                                                                                                              | Accepted. The link's code stays; the row `An MQTT 5 WebSocket's close whose reason is no UTF-8`, of kind platform: ws 1007, .NET 1002, the Rust link a close of no body, which §5.5.1 allows and §8.1 does not reach. A Rust test pins it.                                                                                                                                                                                                              |

Refused besides, each weighed: a stream under `ManagedWebSocket` or ws to send one code for a
close's reason, a second framer for a code no side reads; a Rust sniffer beside tungstenite, or an
upstream variant of its error, which only a split of the two codes would need; ws's
`skipUTF8Validation`, which fails nothing; the spec stating a close's reason's code; and the spec's
version moved before its release.
