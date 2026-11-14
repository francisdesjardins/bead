# 0052 — The Rust side's gateway is a feature of its core and its JSON mapping a feature of its proto codec, met by one trait, and a `HEAD` never holds a stream

- **Status**: accepted
- **Scope**: the Rust side's HTTP/JSON gateway, the stage of
  [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md) that brings
  it: the core's features `transcoding` and `gateway`, `bead-protobuf`'s feature `transcoding`, the
  trait `MessageForm` between them, their names and their defaults; `HttpGateway` on its own listener
  and mounted by `answer`, what it judges of a body read before it, its two paces; `HttpCaller`; beadc's
  Rust target with `gateway`, `bead_http.rs`, and the contract 5 its runtime holds; `examples/hello`'s
  Rust gateway; the Rust side's player of `spec/transcoding.json`, its testee's JSON through Bead's
  mapping, and the interop both ways over its gateway. On every side: the companion's 8.1, a `HEAD`
  that would open a stream, and its 10.1.5, a navigation from another site, in
  [`spec/transcoding.md`](../../spec/transcoding.md); an exchange of `spec/transcoding.json` that a
  row excuses a side from, by its `differs`; a gateway's `limits` on the C# side; and the fuzz twin
  `json-form`. What a gateway is and how it answers stay
  [0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)'s,
  a required field
  [0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)'s,
  the sockets, their wire and a target's reading
  [0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)'s,
  beadc's Rust target
  [0051](0051-beadc-writes-rust-each-packages-typed-shells-beside-the-messages-buffa-writes.md)'s,
  the surface [0047](0047-every-side-shows-one-public-surface.md)'s, one behaviour and a difference a
  row [0004](0004-one-behaviour-in-every-language.md)'s. Mounting Bead and its gateway in a host, a
  framework among them, is a round of its own, ahead; this record closes nothing of it.

## Context

**The gateway needs the core's inside and Buffa's reflection.** The Rust side's gateway answers over
the HTTP transport's wire (`http/wire.rs`), paces by its `SendPace`, judges hosts, origins and
proxies by its judgements, and calls through the in-memory transport's connect given an address:
some 25 items of eight modules, reached by no crate but through `bead::internal`, outside SemVer.
Its JSON mapping reads a message by its descriptors through Buffa's `DynamicMessage`, which lives in
`bead-protobuf`, and `bead-protobuf` depends on the core. The other sides hold the same split:
the TypeScript side's `./transcoding` and its Node listener, the C# side's `Bead.Transcoding` and
`Bead.Transcoding.Http`, friends of `Bead.Core`. The core already re-exports `rustls` 0.23 and
tokio-util 0.7's `CancellationToken`, and depends on tower-service 0.3 under `http`; it holds a
private `mod http;` under that feature, beside which a `pub use http;` fails E0255 and E0365 once
both features are on.

**hyper shows a handler what it read, not what read before it.** Probed on hyper 1.12.0 and axum
0.8.9: a body of a declared length shows its count left by `size_hint().exact()`, and one read whole
`is_end_stream`; a chunked body over HTTP/1.1 shows `false` and no length whether it was read or not;
over HTTP/2 with no `content-length`, an ended empty body is what any request that carries none
shows; a wrapper such as `Body::from_stream` shows nothing before its first byte. hyper hands a
handler a target cut at its `#`, over HTTP/1.1 (`proto/h1/role.rs:225-229`) and in HTTP/2's `:path`
(h2's `server.rs:1748`), and no option of hyper's keeps the request line. A `HEAD` answered by a body
that never ends holds its HTTP/2 stream, hyper polling the body; one answered by an ended body that
sets no `content-length` writes none, and ends its HTTP/2 stream with its head. Over HTTP/1.1 hyper
polls a body's frames past a reader that reads nothing, and neither hyper nor axum arms a write
deadline.

**The two shipped gateways part on two units.** A `HEAD` that asks a stream holds its subscription
on both, writing nothing on the TypeScript side until it ends and its head alone on the C# side,
the next request on its socket unanswered meanwhile. A `HEAD` navigation from another site is
refused on the TypeScript side but to the document, and taken on the C# side; an `object` or an
`embed` navigation is taken on both. A gateway's `limits` is the TypeScript side's alone.

**Buffa's JSON is not Bead's mapping.** Buffa's own ProtoJSON parts from `spec/transcoding.json` on
31 of 192 readings and 20 of 78 writings, and none of its refusals carries the companion's words or
places; prost-reflect 0.16.5 panics on the corpus's edition 2023 file, and it and pbjson stand on a
second protobuf runtime; `bead::json` sorts an object's members and rounds past a double.

**The standards.**

- **gRPC transcoding**, `google/api/http.proto` at the pin 0037 cites, as grpc-gateway, Envoy's
  `grpc_json_transcoder` and Vanguard read it; [AIP-127](https://google.aip.dev/127) and
  [AIP-134](https://google.aip.dev/134).
- **protobuf's [JSON mapping](https://protobuf.dev/programming-guides/json/)** and its conformance
  suite at v36.2; protobuf Editions, edition 2023.
- **[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)**: §9.1, a method a case-sensitive token;
  **§9.3.2, `HEAD` "identical to GET except that the server MUST NOT send content in the response"**,
  its fields the same as a `GET`'s; §12.5.1, §13.1.2, §15.5.6, §15.6.3.
- **[RFC 9112](https://www.rfc-editor.org/rfc/rfc9112)**: §3, an invalid request-line answered 400,
  and "A recipient SHOULD NOT attempt to autocorrect and then process the request"; §3.2, no form of
  a request-target carries a fragment; **§6.3, a response to `HEAD` ends at its header section**;
  §7.1, a chunked body of its last chunk alone carries empty content.
- **[RFC 9113](https://www.rfc-editor.org/rfc/rfc9113)**: §5.2, flow control; §8.1, §8.1.1, a
  malformed request; §8.3.1, `:path`.
- **[RFC 3986](https://www.rfc-editor.org/rfc/rfc3986)** §3.5, §5.2, §6.2.2;
  **[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)**;
  **[RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)**; **[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750)**
  §2.1, §3.1; **[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)**;
  **[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)** §3.2.3.
- **WHATWG**: HTML's [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html);
  the URL Standard's `application/x-www-form-urlencoded` parser;
  [Fetch §3.1](https://fetch.spec.whatwg.org/#origin-header), a page's `Origin` on every request but
  a `GET` or a `HEAD` that is no CORS request.
- **Fetch Metadata**: web.dev's [resource isolation policy](https://web.dev/articles/fetch-metadata),
  whose allow rule takes `sec-fetch-mode == 'navigate' and method == 'GET' and sec-fetch-dest not in
  ('object', 'embed')`; the W3C's Fetch Metadata Request Headers, which define the fields and no
  policy; OWASP's CSRF cheat sheet.
- **OpenAPI 3.1.1**.
- **Rust practice**: `http` 1.x and `http-body` 1.x, the vocabulary hyper 1, axum 0.8, tower-http,
  reqwest and tonic share; hyper 1's `service_fn` and `serve_connection`; axum 0.8's
  `Router::fallback`, `ConnectInfo`, `into_make_service_with_connect_info` and `nest_service`;
  tower-service 0.3's `Service`; a codec's seam in a core crate filled by a codec crate, as tonic
  0.14's `Codec` and `tonic-prost`, and Bead's own `PayloadCodec`;
  [Cargo's features](https://doc.rust-lang.org/cargo/reference/features.html), additive; the
  [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)' C-FEATURE, C-CASE, C-GOOD-ERR
  and C-CTOR; tonic's generated client, a method a procedure.
- **Keep a Changelog** and **Conventional Commits**.

**The options not taken**, each with its reason:

- **A crate, `bead-transcoding` and `bead-transcoding-http`, over `bead::internal`** at an exact pin:
  some 25 internal items made a road for a crate that ships, against `internal`'s promise and 0047's
  rule, which 0049 and 0050 followed for a smaller reach; every change of `internal` a breaking
  release of the pair.
- **Buffa in the core, a feature `proto`, `bead-protobuf` re-exporting it**: the browser's check
  costs nothing, but the core would depend on protobuf, as `Bead.Core` never references
  `Bead.Protobuf`, the whole of `bead-protobuf` moving under a feature, every combination linted, and
  the ecosystem's direction run backwards, tonic 0.14 having moved its prost codec out behind
  `Codec`. It buys one crate fewer and no seam, and keeps the caller's hop, which comes of the seam's
  byte signature, not of where Buffa lives.
- **The handler as a `tower_service::Service` or a `hyper::service::Service`**: a host's caller's
  address reaches a `Service` only as a type of the host's, axum's `ConnectInfo`, which Bead cannot
  read without depending on axum, or as a bare `SocketAddr` in the extensions, which collides by
  type; hyper's `Service` is one a socket, and `service_fn` over `answer` is the same in one line.
- **`pub use http;` and `pub use http_body;` at the root**: E0255 and E0365 beside the private
  `mod http;`, and a route's method would take any token where transcoding 3.4 takes five.
- **Buffa's JSON, prost-reflect, pbjson, `serde_json` with `arbitrary_precision` and
  `preserve_order`, or `bead::json`** for the mapping: what the Context found, and `serde_json`'s
  two features change every number and map of the application's graph, its parser neither ordering
  its refusals as 5.2 does nor counting depth by descriptor.
- **A `HEAD` that asks a stream read as a call that subscribes nothing**: it would answer
  `application/json` with a `content-length` where its `GET`'s head is `text/event-stream`, against
  §9.3.2.
- **A gateway held until hyper refuses a `#`**, a date Bead does not hold; **the head read by Bead**,
  an HTTP/1.1 server of its own and none over HTTP/2, a mounted gateway seeing hyper's `Uri` alone;
  **the whole exchange of a `#` excused**, which would lose the one `%23` any side plays at a
  gateway.
- **A chunked body that gave no byte read as empty** at a mounted gateway over HTTP/1.1: one a host
  read whole before it would be called with an empty payload or blamed on its caller 400, nothing
  reported, against 7.6's "its call never made".

## Decision

### Two features of the core, and one of `bead-protobuf`, met at one trait

The Rust side's gateway is **two features of its core**, as its sockets (0049) and its broker
bindings (0050) are: `transcoding`, the templates, the route table, the problems and the events, a
route's method and the seam, with no new dependency and checked for `wasm32-unknown-unknown`; and
`gateway`, `transcoding` with `http` and `dep:http-body`: its own listener, its handler `answer`, its
paces and its caller. Protobuf's JSON mapping and the binding of a request are **`bead-protobuf`'s
feature `transcoding`**: Bead's own mapping over Buffa's descriptors and `DynamicMessage`, its own
strict JSON reader and writer, one `JsonForm` an output over the pool its messages embed. The two
meet at **`MessageForm`**, a trait the core declares and `bead-protobuf` fills, as `PayloadCodec`
joins them already: a message's full name, its request bound from a route (4), a JSON text read (5.2),
a payload written in Bead's proto JSON form, whole or its top-level field (5.6 to 5.8), and a
violation's place (7.4), each over the binary payload its stock library reads and writes.
`MessageFormError` tells the host what it answers by: `Form`, the mapping's words and place;
`Undecodable`, a payload its stock library does not read, 502, code 50, reported, never in a
problem; `Programmer`, a route its message does not hold. A method added to `MessageForm` comes with
a default body.

Every item is **at the root**, each under its feature's `cfg`, its module private. The root
re-exports neither `http` nor `http-body`: `answer`'s `http::Request`, `http::Response` and
`http_body::Body` are named by the application's own `http` 1.x and `http-body` 1.x, which hyper and
axum give it, one version by semver. A route's method is Bead's own closed `HttpMethod`, `Delete`,
`Get`, `Patch`, `Post` and `Put`, the TypeScript side's `HttpMethod`'s Rust cell, so `transcoding`
needs no `http`.

### The names

Under `transcoding`: `HttpMethod`; `HttpRouteInit`, a record of public fields a table writes as a
struct literal, as `DescriptorInit` is, and `route_of(init)`, which gives `Result<HttpRoute,
ProgrammerError>`; `HttpRoute`, read by accessors; `HttpRouteTemplate`; `HttpPayload`, `Message`,
`Json`, `Text` and `Raw`; `BindingOptions`; `JsonFormError`, its `reason()` and its `place()`;
`RequestPlace`, `Pointer` or `Parameter`; `ServerSentEvent`; `OwnFailure` and `OwnProblemOptions`;
and the Rust side's own `MessageForm` and `MessageFormError`. Under `gateway`: `HttpGateway`, `new`,
`start`, `stop`, `dispose`, `answer`, `on_error` and `off`, `Clone`, its state one task's;
`HttpGatewayOptions::new(transport, routes)`, its two required members, `#[non_exhaustive]`, not
`Copy`, no `Default`, every other field a public `Option`, `limits` and `policy` among them;
`HttpGatewayStartOptions`; `GatewayAuthorization`, `Elsewhere` or `BearerJwt`; `HttpCaller::new(url,
&options)`, `requester_of` and `subscriber_of`, each refusing a route of another procedure;
`HttpCallerOptions`, `HttpCallOptions`, `HttpRequester`, `HttpSubscriber`, `HttpEvent`; and the
Rust side's own `HttpGatewayBody`, `GatewayErrorListener` and `HttpSubscription`, a `Stream` of
events. The defaults `DOCUMENT_PATH`, `GATEWAY_TIMEOUT`, 5 s, `GATEWAY_WINDOW`, 16,
`MAXIMUM_EXCHANGES` and `MAXIMUM_EXCHANGES_PER_ADDRESS`; `HEARTBEAT` is the root's. Each is a row of
`tools/names.tsv`, beside the TypeScript and C# names it maps.

### The gateway, against the companion

It is the HTTP transport's wire, judgements and send pace beside one more client of its server, one
`HttpPolicy` for both, a member given in it and beside it refused. Each exchange draws one in-memory
client, its connect given the caller's address and port read behind the policy's proxies, `local`
where `answer` is given none, closed as its response ends, is dropped or its body is cut; its clients
take `limits`. Its own listener, `start`, is the HTTP transport's: HTTP/1.1, HTTP/2 under TLS by
ALPN, the head's bounds and its 408, a stream reset over HTTP/2. **Mounted**, `answer(request,
peer)` answers what its application routed to it, and a path no route matches 404 `path-unknown`, as
the endpoint the C# side maps answers it. It plays the companion's sections 2 to 12 as 0037 has every
gateway play them; the Rust side's forms:

- **A `#` in a target** is cut by `http::Uri` before Bead reads it: `GET /v1/books/a#b` binds and
  answers the route of `/v1/books/a`, on its own listener and mounted, a row of Differences, `A # in
  a target`, beside the Rust HTTP address's; `%23` is a path's octet, decoded into its variable. The
  row lifts when hyper's HTTP/1.1 server refuses a request-target that holds a `#` before it builds
  its `Uri`, and h2's server treats a `:path` that holds one as malformed (RFC 9112 §3.2, RFC 9113
  §8.1.1 and §8.3.1), the two changes asked of them; meanwhile what stands in front of a Rust gateway
  refuses a `#`, as Envoy's `http_reject_path_with_fragment` does by default.
- **A body read before a mounted gateway** (7.6.27, 10.1's step 10) is judged by hyper's hints before
  its first byte is awaited, and by its count at its end, before any binding, so its call is never
  made: before, a `content-length` body ended or short of it, a `transfer-encoding` body ended, and,
  over HTTP/2 to a route that takes a body, one with no `content-length` ended with no exact length;
  at its end, one short of its `content-length` whatever wrapped it, and, over HTTP/1.1, a
  `transfer-encoding` body that gave no byte, failing closed, since nothing tells a chunked body read
  whole before it from an untouched one that came empty. It is refused 500, a failure of its own,
  with no detail, reported, as on both other sides. A body put back whole with its length is read
  from its start, as the C# side reads one its server buffered; a `content-length: 0` body is the
  empty body. What hyper's request cannot show is two rows of Differences: a chunked body read in
  part over HTTP/1.1, read as what is left, and an HTTP/2 body read whole and replaced by an ended
  empty one, read as empty; and an untouched chunked body that came empty, refused over HTTP/1.1. On
  its own listener nothing reads before it.
- **The two paces** (10.2, 8.8): on its own listener the transport's, what its watched socket holds
  and the slice it would add against `maximum_unsent_bytes`; mounted, its body's frames alone, a frame
  taken as its host polls it, over HTTP/2 by the stream's window, over HTTP/1.1 by hyper's write
  queue and its host's socket, with no write deadline of hyper's: a row of Differences, `A mounted
  gateway's send pace`.
- **A lower-case method** reaches it, as on the C# side, and is refused 405 `method-refused`.

What a mounted gateway keeps and leaves to its host is 0037's: it keeps every gate of 10.1 from its
step 2, its problems, its pace and its bounds; its host owns what HTTP refuses of its own, its head's
bounds and timeouts, its socket's write deadline, a path its own router answers first, and whatever
reads the body before it.

### The caller

`HttpCaller` calls over the HTTP transport client's own hyper connector, RFC 8305's race and the
platform's verifier, with no executor supplied, so it follows no redirect: the row `A gateway
caller's executor that follows a redirect` is "not available" on the Rust side. Its URL is a base
(12.2), its credential held to the transports' check (12.3), its problems read by 12.4, its stream
by 12.5, never reconnecting, and its bounds by 12.6. It encodes a typed request by its codec and
writes it by its route's `MessageForm`, and reads a result the other way.

### beadc's Rust target with `gateway`

An output with `gateway` writes `bead_http.rs` at its root, `include!`d by its `mod.rs` beside
`bead_served.rs`: `HttpRoutes`, made once a process over the pool its messages embed, one `JsonForm`
for all; `OPENAPI_DOCUMENT`, a `&str` of the document's bytes; `HTTP_PROBLEM_TYPES`; and a flat
`<Service>HttpClient`, as transcoding 12.1 reads it and as the other targets write it, each procedure
a client calls a method by its name in snake case and each that notifies `subscribe_` and its name,
beside `new`. The target refuses, for such an output, a procedure that renders as a method its
client holds, `new`, `clone` or `fmt`, as 0051 refuses what would be one name of one module. The
file needs the contract 5, `GENERATED_CODE_SUPPORTS_VERSION_5`, which the Rust runtime holds under
`gateway` beside 7 and 8. Such an output depends on `bead` with `gateway` and `bead-protobuf` with
`transcoding`. `examples/hello`'s Rust half serves its gateway on its own listener.

### On every side

- **A `HEAD` that would open a stream** (transcoding 8.1) is answered as its `GET` begins: its call
  made as that `GET`'s, then that `GET`'s head, 200 `text/event-stream` and 6.2's fields, or its
  failure's problem, with no content (RFC 9110 §9.3.2); its response ends at its head (RFC 9112
  §6.3), which closes its exchange's connection and so ends its subscription. It is counted as its
  `GET`'s stream, and frees that place as it ends.
- **A navigation from another site** (transcoding 10.1.5) is taken only as a `GET` whose
  `sec-fetch-dest` is neither `object` nor `embed`, to `/openapi.json`, a default route's `GET` or a
  `get` rule on a method marked `NO_SIDE_EFFECTS`: web.dev's resource isolation policy whole. A
  `HEAD` navigation from another site is refused 403 `origin-refused`, to a route and to the
  document.
- **`spec/transcoding.json`'s exchange of a `#` is two**, the `#` and `%23` apart, and an exchange
  takes a `differs`, which `spec/check.py` crosses against its row as it crosses a case's of
  `spec/transports.json`; every player skips the one that excuses its own side. The fixture's
  `watch` gains a `get` rule, `/v1/watch`, and three exchanges pin 8.1 and 10.1.5.
- **A gateway's `limits`**, its exchanges' clients' router limits, comes to the C# side and the Rust
  side, a gap no row declared.
- **A ninth fuzz twin, `json-form`**: protobuf's JSON read by Bead's mapping over the `Transcoding`
  service's `Everything` and `Edges`. What reads is written; what was written reads; and it writes
  again to the same text, byte for byte. No message's bytes are compared: a map's entries read in the
  text's order are written in 17.7.6's, and a `-0` is written `0` or left out (5.6).

No wire change: `spec/spec.md` does not move, and the companion's next version is a minor.

### What the Rust side plays

`bead-protobuf/tests/transcoding.rs` plays `spec/transcoding.json` whole, every group and its
exchanges through an `HttpGateway` on its own listener over a real socket, but the exchange of a `#`
its `differs` excuses it from, over beadc's Rust output of `spec/transcoding.proto`; the gateway's
and the caller's twins are `bead/tests/gateway.rs` and `bead/tests/caller.rs`, the modules' beside
them; `bead/tests/durations.rs` plays the gateway's places and ways; the testee of
`tools/protobuf-conformance.mjs` reads and writes protobuf's JSON through `JsonForm`, its failure
list naming the two `FieldNameExtension.Validator` tests with the reason both other sides give; and
`bead-interop-server` serves the `Transcoding` service's gateway, the Rust client's five trials
calling each other side's and each other side's client calling it.

## Consequences

- **A build with `gateway` needs aws-lc-rs's C compiler**, as one with `http` does; one with
  `transcoding` alone does not, and checks for the browser's target.
- **The Rust side owns a second strict JSON reader**, beside `bead::json`, held by the 192 readings,
  the conformance suite's JSON tests and the fuzz twin `json-form`.
- **The caller hops through binary**: a typed request is encoded by its codec, then written by its
  form, and a result read the other way. Ahead: `JsonForm` writes a typed request's JSON in place
  through the reflection beadc's messages carry, the codec's refusals kept; the read's half stays, as
  Buffa generates no mutable reflection of an owned message. The bench measures the hop meanwhile.
- **Four rows of Differences, of kind platform**, name what hyper's request and response show a
  mounted gateway, and what the caller takes: `A mounted gateway's send pace`, `A body read before a
  mounted gateway that its request shows unread`, `An untouched chunked body that came empty at a
  mounted gateway` and `A gateway caller's executor that follows a redirect`.
- **The row `A # in a target`** holds the Rust HTTP address and gateway, until hyper and h2 take the
  two changes asked of them.
- **Ahead**: mounting Bead and its gateway in a host, a round of its own: who judges hosts and origins
  once a host read the request, a body already read, a host's CORS against
  [0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)'s, and how much
  of a framework's behaviour Bead's tests hold; a `Service` that reads its caller's address from an
  extension of Bead's, beside `answer`, when an application asks for one; the caller's typed write in
  place.

**Its gates**: `spec/transcoding.json` played by the Rust side but the exchange its `differs` excuses
it from; the gateway's and the caller's twins; the gateway's places of `spec/durations.json`;
protobuf's conformance suite's JSON tests through the Rust testee; `tools/check-transcoding.mjs rust`;
the Rust goldens of `bead_http.rs` compiled by `bead-goldens`; the interop both ways over the Rust
gateway; the core's library linted with `transcoding` and with `gateway`, `bead-protobuf`'s with
`transcoding`, and the browser's check with `transcoding`; and the fuzz target `json-form` on every
side.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, at xhigh effort. Nine objections, each checked against its probe or the code before it
was answered: all nine accepted. Three questions went to the user: mounting in a framework, taken to its own round; 10.1.5 folded here, in a commit of its own; and the two upstream asks of the row `A # in a target`, which the user makes.

| Objection                                                                                                                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The draft's commit 6 narrows `AHEAD` by groups and units "with no tooling change"; replayed, it is red: a side that reads a file one group of which is ahead must name each group it reads, and the Rust side's pattern names none of the transcoding's; the row's count and three units (12.4.1 to 12.4.3) are left out                                                                                     | Accepted, by the second remedy. No narrowing: `AHEAD`'s `Rust's gateway` keeps the file and its document whole until one commit lands the Rust player whole and deletes the row; the commits before it carry unit tests alone, none reading `transcoding.json` or naming a unit, and `SIDES`' patterns do not move. The tooling change this round does carry is the crossing of an exchange's `differs`, replayed at `d0cfad84`: the two problems the row `A # in a target` meets until it names the file and the exchange, nothing else; the count needs none, the Rust cell reading `all 501 but one, …` as the transports' row reads `all 268 but two, …`. Each commit's ledger gains the row's count; the units are thirteen, 2.3, 7.6.27, 7.7.6, 10.2 and 12.1 to 12.6 with 12.4.1 to 12.4.3, named in the player's commit                                                                                                                                                                                                                                                                                                          |
| The rule of a body read before a mounted Rust gateway parts from its own twin (a chunked body that came empty and was put back shows ended, so it is refused where the draft said "read from its start"), misses what hyper tells over HTTP/2 (a body polled to its end shows ended with no length), holds only while every wrapper forwards two optional hints, and its row does not say what the call gets | Accepted. The rule judges twice: before its first byte by hyper's hints, a `content-length` body ended or short, a `transfer-encoding` body ended, over HTTP/2, to a route that takes a body, a body with no `content-length` ended with no exact length; and at its end, a body short of its `content-length` whatever wrapped it, and over HTTP/1.1 a `transfer-encoding` body that gave no byte. The round weighed that last case: 500, failing closed, by 7.6's row ("a chunked one that came empty among them", "its call never made") and the row of Leveled down `A chunked body that came empty, read to its end before a mounted gateway`, against reading it as empty; its cost, an untouched chunked body that came empty refused, is a row. The Rust cell of `A chunked body that came empty, peeked before a mounted gateway` is the C# side's refusal; the row of Leveled down stays there, the Rust side keeping to it; what hyper's request cannot show, a chunked body read in part and an HTTP/2 body replaced by an empty one, is a row naming what the call gets. The twins name their readers and play the put-back |
| `pub use http;` at the root collides with the core's private `mod http;`: E0255 under `gateway`, red under `--all-features`; the other sides close the set of methods                                                                                                                                                                                                                                        | Accepted. No re-export of `http` nor of `http-body`. A route's method is Bead's own closed `HttpMethod` (`Delete`, `Get`, `Patch`, `Post`, `Put`), the TypeScript name's Rust cell; `transcoding` then needs no `http`; `answer`'s request and response are named by the application's own `http`, which hyper and axum give it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The generated HTTP client (`client.request().say_hello.call(…)`) parts from transcoding 12.1's letter, a twins unit, while the draft says 12.1 is played and its text does not move                                                                                                                                                                                                                          | Accepted. Flat, as 12.1 reads and as the TypeScript and C# targets write it: `say_hello(&self, request, options)` and `subscribe_count_down(&self, request, options)` on `<Service>HttpClient`, beside `new`; the Rust target refuses, for its own output, a procedure that renders as one of the client's methods (`new`, `clone`, `fmt`), as 0051 refuses what would be one name of one module. 12.1 does not move                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The draft prices the caller's double hop against the wrong form: it comes from `MessageForm`'s byte signature laid on the caller, not from where Buffa lives; beadc's messages already reflect in place                                                                                                                                                                                                      | Accepted. Form (c) stays; the table says where the hop comes from; form (b) loses the gain it does not hold, and the sentence offering it to the dissenter goes. The write's half can close in `bead-protobuf` through the reflection beadc's messages carry; since which of the codec's refusals a direct write keeps is not checked, it is stated ahead in 0052's Consequences, not designed here; the read's half stays, Buffa generating no mutable reflection of an owned message. The bench measures the hop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Recipes and "no record of its own" understate it: the trial's recipe is adapter-sized, two of its lines are security facts no test would hold, axum's `ConnectInfo` fails under a plain `serve`, and the plan already keeps a Tenth Man round for host adapters on the same questions                                                                                                                        | Accepted. Put to the user as it is: (a) recipes, (b) the lines that state what a host does in the gateway's place held by the trial's tests and an axum twin, (c) adapters, the recommendation (b) for those lines and (a) for the rest. Mounting Bead and its gateway in a host is a round of its own, which 0052 names instead of closing it. The user takes (b) for that round, not for this record's series: the axum twin and the framework recipes land with it, and a README says meanwhile how hyper's `service_fn` mounts `answer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The upstream ask sends hyper what h2 does: over HTTP/2 hyper is handed a `:path` already cut, and a refusal in `http` would break every client URI with a fragment                                                                                                                                                                                                                                           | Accepted. Two asks, each with its file and line: hyper's HTTP/1.1 server refusing a raw target that holds a `#` before `Uri::from_maybe_shared` (`proto/h1/role.rs:225-229`); h2's server treating a `:path` that holds one as malformed (`server.rs:1748`; RFC 9113 §8.1.1, §8.3.1). The row's lift names both and closes when both land                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The `Service` is refused on C-STABLE, while the core already re-exports `rustls` 0.23 and tokio-util 0.7's `CancellationToken`, depends on tower-service 0.3, and the gateway's options take a `rustls::ServerConfig`                                                                                                                                                                                        | Accepted. The `Service` is refused on the address alone; C-STABLE leaves 0052's reasons and its standards. A `Service` reading the peer from a Bead extension, beside `answer`, stays a step an application can ask for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Folding m29 is unforced (the re-pass filed it among the small rounds, not R33's), commit 2's "no split is green" speaks only of a split by side, and "a ninth fuzz target on every side" is wrong on two sides                                                                                                                                                                                               | Accepted. Put to the user, its cost named, a Rust record changing a security gate of two shipped gateways; the user folds it. 8.1 and 10.1.5 are two commits, one a topic, each with its exchanges, both gateways and its row; The CHANGELOG reads "a ninth fuzz twin": the tenth target on the TypeScript and Rust sides, the ninth on the C# side                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
