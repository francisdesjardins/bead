# 0049 — The Rust side's sockets are features of its core, HTTP on hyper and a WebSocket's head read by Bead, and a target is read as a page's browser writes it

- **Status**: proposed
- **Scope**: the Rust side's transports over WebSocket and HTTP, client and server, their facades,
  their TLS, their clocks and their interop with the TypeScript and C# sides, the stage of
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md) that brings
  them; a server's start and its life on the Rust side; and, on every side, the rule of
  [`spec/spec.md`](../../spec/spec.md)'s 15.12 on a request's target and
  [`spec/transcoding.md`](../../spec/transcoding.md)'s 3.6, which reads it, with the cases of
  `spec/transports.json` and `spec/transcoding.json` that play it. It moves the reading of an
  absolute-form target's scheme that
  [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md) states,
  and the `#` that
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md) keeps in
  a path; the hosts, the origins and the authority stay theirs. It settles the names the TypeScript
  and C# sides held apart, under [0047](0047-every-side-shows-one-public-surface.md)'s rule. One
  behaviour, and a difference a row of the matrix, are
  [0004](0004-one-behaviour-in-every-language.md)'s; the bounds a side keeps against a peer
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
and DEL there and taking the rest; and it reads `HTTP://`, `hTtP://` and `HTTPS://` as `http://` and
`https://`. 15.12 took every visible character a URI leaves out as it came, `#` among them as a
character of the path, and read an absolute-form target's scheme in lower case alone, as Kestrel
does. Node's parser hands every one of these targets on as it came, but an octet past US-ASCII
past a `#`, which it answers 400 itself; Kestrel hands on `<`, `"`,
`` ` ``, `{`, `^`, `|`, `\` and a `#` with what follows, which `RawTarget` and `Request.Path` both
keep, but answers 400 itself a `%00` or an octet past US-ASCII past a `#`, and an absolute-form
scheme not in lower case.

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
  malformed request's stream reset; §8.3.1, `:authority`.
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

| Crate                                                 | Carries                                                                        | Feature     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- |
| tokio 1.54.1, `net` and `io-util`                     | the sockets                                                                    | both        |
| httparse 1.x, the version the lock holds              | an HTTP/1.1 head, RFC 9112 §2-§5, the WebSocket server's and the fuzz targets' | always      |
| socket2 0.6.5                                         | `IPV6_V6ONLY` on a listener, `SO_LINGER` 0 on a drop                           | both        |
| http 1.5.0                                            | the request and response types                                                 | both        |
| tungstenite 0.30.0 and tokio-tungstenite 0.30.0       | RFC 6455's frames, its masking, ping and close, and the client's handshake     | `websocket` |
| hyper 1.12.0, `server`, `client`, `http1`, `http2`    | RFC 9112 and RFC 9113                                                          | `http`      |
| hyper-util 0.1.21, `server`, `client-legacy`, `http1` | tokio's IO adapter and the pooled client                                       | `http`      |
| h2 0.4.20                                             | a stream reset with its reason                                                 | `http`      |
| http-body-util 0.1.5, tower-service 0.3.3             | a body read whole under a bound; the connector the pool takes                  | `http`      |
| rustls 0.23.46 over aws-lc-rs, tokio-rustls 0.26.6    | RFC 8446 and RFC 7301, `X25519MLKEM768` first                                  | both        |
| rustls-platform-verifier 0.7.1                        | a server's certificate verified by the platform                                | both        |

**aws-lc-rs is C and assembly**, built by the platform's C compiler: the core with no feature stays
pure Rust, and a build with a socket feature needs that compiler, MSVC's on Windows. `deny.toml`
allows `ISC`, the licence of rustls-webpki, aws-lc-rs and aws-lc-sys, and one exception,
`webpki-root-certs`' `CDLA-Permissive-2.0`, which the platform's verifier takes on wasm32 alone.

### A target read as a page's browser writes it, on every side

15.12 changes on every side, each judging a target as it came: the raw `request.url` on the
TypeScript side, `IHttpRequestFeature.RawTarget` on the C# side, the head's own bytes at the Rust
side's WebSocket address, and hyper's `Uri` at its HTTP address, which has judged the first and the
fourth step already. In this order:

1. a control character, HTAB, a bare CR or DEL anywhere in the target, past a `#` too: 400 unmarked;
2. the target cut at its first `#`, what follows never judged again;
3. in what remains, a space or an octet past US-ASCII in its path or its query: 400 unmarked;
4. `"`, `<` or `>` in its path or its query, `^`, `` ` ``, `{` or `}` in its path: 400 unmarked;
5. a path whose percent-decoding holds NUL: 400 unmarked;
6. in absolute-form, `http` or `https` in any ASCII case, then `://` and an authority that is not
   empty and is a host; any other: 400 unmarked.

Over HTTP/2 each is a stream reset `PROTOCOL_ERROR`, nothing written. Three things change, each by
its standard:

- **What a page's browser always percent-encodes where it stands is an invalid request-line**
  (RFC 3986 §2, RFC 9112 §3): the URL Standard's path and query sets, less what a URI keeps, `'`
  among it, a sub-delim of RFC 3986 §2.2 that a request-line may hold. They cover every target hyper
  refuses, and Bead refuses the rest itself. `\`, `|`, and `^`, `` ` ``, `{` and `}` in a query are
  taken as they came, as a page sends them.
- **A target ends at its first `#`**, what follows neither its path nor its query, as a fragment is
  apart from both (RFC 3986 §3.5), though a request-target never carries one: a leveling, a row of
  the matrix's "Leveled down", since hyper keeps nothing past it. A control character there is still
  the request-line's and refused, which hyper and every other side can do. A `%00` or an octet past
  US-ASCII there is taken, judged by no rule of a path; Kestrel answers either 400 itself, and Node's
  parser the octet past US-ASCII, a row of the matrix's Differences, `What follows a # in a target`.
- **A scheme is read in any case** (RFC 3986 §3.1), as hyper reads it and Node hands it on. Kestrel
  answers any other than lower case 400 before the application runs: a row of Differences,
  `A target in absolute-form, its scheme's case`, which lifts the former leveling.

`spec/transports.json` gains nine cases, six over HTTP and three at a WebSocket's address, and
the case of `spec/transcoding.json` that reads a target reads `/v1/books/a#b` as `a` and refuses
`/v1/books/a"b`. A side plays them all but those a `differs` excuses it from.

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
HTTP/1.1 by hyper's `max_header_size` and `max_headers`, over HTTP/2 by `max_header_list_size`, and
at a WebSocket's address by its own read. hyper's default, 417,792 bytes, is 25 times Node's.
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
fetched as the platform fetches them (RFC 5280). An application's own `ClientConfig` is taken in its
place when given; a server's `tls` is the application's `ServerConfig`, Bead's copy of it offering
`h2` and `http/1.1` by ALPN. A client's trust roots per platform are a row of Differences,
`A client's trust roots`.

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

### The names the other sides settle

Each in a change of its own: the TypeScript side's `REFUSALS` is `HTTP_REFUSALS`, and its
`IHTTPPolicyInit` is `IHTTPPolicyOptions`; the C# side's `WebSocketTransportStartOptions` and
`HttpTransportStartOptions` are one `TransportServerStartOptions`, in `Bead.Core`; a WebSocket or
HTTP client's connect names its `host` and its `port` on the TypeScript side, as on the C# and Rust
sides; and a WebSocket client's `pathname` defaults to `/` there. The HTTP client's facade keeps its
three names, one row of `tools/names.tsv` rendered by its platform: `HTTPClient`, `BeadHttpClient`
beside .NET's own `System.Net.Http.HttpClient`, and `HttpClient`.

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
  sends `<` or `{` raw in a path, or `"` in a query, is answered 400; nothing a browser writes is.
- **What follows a `#` reaches no side's application**, where Kestrel and Node kept it in the path:
  a route that matched it no longer does.
- **The C# side keeps two rows of Differences**, Kestrel's refusals of an upper-case scheme and of a
  `%00` or an octet past US-ASCII past a `#`, and the TypeScript side one, Node's parser's refusal of
  an octet past US-ASCII past a `#`; a case's `differs` excuses its player from each.
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

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at
xhigh effort: fourteen objections, each checked against its probe or the code before it was
answered. Twelve were accepted, two in part, and none refused.

| Objection                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hyper reads every target as `http::Uri`: it 400s `<`, `>`, `` ` `` in a path and `"`, `<`, `>` in a query, and cuts a target at `#`, where 15.12 takes them as they came; no case sends them, so CI never sees it. Bead should read each request line itself, or level 15.12. | Accepted. The probes confirm it and add the tail past a `#` (control characters refused, the rest taken). Reading each head is refused: a pre-read reaches a connection's first head alone, and a second parser beside hyper's invites smuggling. 15.12 changes on every side instead, by standards: a character a URI leaves out that a page's browser always encodes where it stands is an invalid request-line, 400 unmarked (RFC 3986 §2, RFC 9112 §3, the URL Standard's path and query sets, a superset of hyper's refusals, Bead refusing the rest itself); a `#` ends the target, a leveling with its row, Kestrel's refusal of a `%00` or an octet past ASCII after it a row of Differences (probed); the scheme is read in any case (RFC 3986 §3.1). Eight generated cases hold each side's server to it. |
| The WebSocket server needs no hyper: an upgrade is one head, which httparse reads, keeping the target raw, giving Bead its own 408 and dropping the take-back after a 101.                                                                                                    | Accepted. The server reads its head with httparse under its bounds and its deadline, writes its 101 and its refusals, `connection: close` on each, and closes in stages. What it read past the head reaches tungstenite first, by `WebSocketStream::from_partially_read`: a frame written with the upgrade. The head's parse is pure and always built, so the fuzz target reaches it with no feature.                                                                                                                                                                                                                                                                                                                                                                                                               |
| hyper's head timer is also its idle timer: as written, every idle connection gets a 408 at 30 s; Node and Kestrel close idle connections silently. The client's pool keeps idle connections 90 s against Node's 5 s.                                                          | In part. A kept-alive connection gone idle closes without a word; but Node answers a silent new connection 408 at `headersTimeout` (probed), and `read_buf` is empty for both, so the rule follows the transport's own count of the responses written, not the buffer. The pool's idle timeout is 4 s, under Node's 5 s, on Bead's timer, without which hyper-util applies none. A row, "An idle connection's close", names the three platforms. The round found one more: under TLS, hyper's timer arms only after the handshake, so the handshake runs under `headers_timeout` on the platform's clock, closed without a word past it, as Node and Kestrel bound theirs.                                                                                                                                          |
| A head is bounded at hyper's 417,792 bytes, 25 times Node's, with no option, table or row naming it.                                                                                                                                                                          | Accepted. 16 KiB, the request line among it, and 100 fields, 431 past either, over HTTP/1.1, HTTP/2 and at a WebSocket's address; a row, "A request head's size". Not leveled in the spec: Kestrel's line and fields are bounded apart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Both of Q4's options contradict 15.12's text, so "no change to the spec" cannot stand; option (b) leaves C# the one side unable to meet the spec.                                                                                                                             | Accepted. The spec reads the scheme in any case, as RFC 3986 §3.1 does; the leveling breaks whichever way once the Rust side cannot hold it, and the standard decides which text the spec states. Kestrel's refusal is a row of Differences, lifted when Kestrel reads any case; a case with its `differs` holds it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rustls-native-certs`, which its own README advises against; `builder()`, which panics with both providers; no row on trust roots.                                                                                                                                            | Accepted. `rustls-platform-verifier` 0.7.1, one licence exception for its wasm32-only roots; every config built with its provider named; a row, "A client's trust roots", which says Linux reads its system store into webpki.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The server's life is core on both other sides, yet gated under the socket features and landed with the WebSocket server, while the in-memory and broker starts are rewritten by hand; the twin load is overcounted.                                                           | Accepted. `crate::life`, always built, lands with the start's change, the in-memory and broker servers its first callers, the 8 shared rows and `TransportServerLifeTests` there. The series is sized by about 515 tests a side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Happy Eyeballs on the transport's clock, where both other sides race on the platform's.                                                                                                                                                                                       | Accepted. Its 250 ms are the platform's `SystemClock`; the connect's timeout stays on the transport's clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Two features make four builds, and CI compiles two.                                                                                                                                                                                                                           | Accepted. The core's lib is linted with no feature, with `websocket` alone and with `http` alone, by three explicit steps, no new tool to pin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The draft settles names for Rust and leaves the TypeScript and C# sides split.                                                                                                                                                                                                | Accepted. `HTTP_REFUSALS`, `IHTTPPolicyOptions`, one `TransportServerStartOptions`, a connect's `host` and `port` required, a WebSocket's `pathname` `/`, each a commit of its own; the HTTP client's facade one row, `rendered`, beside .NET's own `HttpClient`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The service client is a stage of its own under 0044 and needs no socket.                                                                                                                                                                                                      | Accepted. It is its own branch, merged first; 0049 holds the sockets and the target rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A runtime without its IO driver panics at the first socket; hyper's `Timer` names `Instant`, a disallowed type.                                                                                                                                                               | Accepted. A socket transport is refused as it is built on such a runtime, a `ProgrammerError`; hyper's timer lives in `clock::native`, beside `SystemClock`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `interop-rust` starts the C# server cold and rebuilds what the `rust` job builds, on a runner that needs a Chromium.                                                                                                                                                          | Accepted. The `rust` job uploads the interop server and its test binary; `interop-rust` runs in the Playwright image, builds the C# server first, and needs no Rust toolchain; the binary finds the repository at run time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The HTTP client rests on `client-legacy`, a module named legacy, with no word on why, nor on its idle timeout and its retry.                                                                                                                                                  | In part. The choice stands, now stated: the pool the Rust ecosystem's clients run on, where `client::pool` gives layers and no client, and `conn::http1` would make Bead write a pool. Its idle timeout is 4 s on Bead's timer, and its re-send touches only a request none of whose bytes were written, which no server saw.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Refused besides, each weighed: Bead reading each HTTP/1.1 head by a pre-read rewound into hyper,
which reaches a connection's first head alone, and an HTTP/1.1 server of Bead's own over httparse,
a second parser beside hyper's; a connection per request, so that every head is a first; 15.12 kept
and the Rust side's erasures a row, a library choosing what the spec holds; leveling to exactly
what hyper refuses, `"` refused in a query and taken in a path; every character a URI leaves out
refused, which would refuse pages; the scheme kept in lower case, the Rust side a row; a `#` refused
on every side but the Rust HTTP server; one rule for what follows a `#`, which neither hyper nor
Kestrel can bend to; `'` refused in a query; the WebSocket server on hyper; a 408 only where hyper
buffered bytes, and a second timer for the idle close; hyper's head bound, Kestrel's 32 KiB, or a
bound in the spec; `rustls-native-certs`, `webpki-roots`, `ring`, `rustls-rustcrypto` and
`native-tls`; hyper-util's `client::pool` layers, `hyper::client::conn::http1` with a pool of Bead's
own, and reqwest; a crate per transport; a `tls` feature; `cargo hack --each-feature`; h2c; the
service client in this stage; and axum, fastwebsockets, `TokioExecutor` and `TokioTimer`.
