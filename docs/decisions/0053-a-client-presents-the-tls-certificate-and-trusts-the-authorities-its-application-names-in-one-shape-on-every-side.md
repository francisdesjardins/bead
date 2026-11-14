# 0053 — A client presents the TLS certificate and trusts the authorities its application names, in one shape on every side

- **Status**: accepted
- **Scope**: the protocol's 15.39 in [`spec/spec.md`](../../spec/spec.md), and every side's
  WebSocket and HTTP transport clients and broker adapters: one TLS type per side, `ITlsOptions` on
  the TypeScript side and `TlsOptions` on the C# and Rust sides, its members `authorities`,
  `certificate` and `key`, and the option `tls` that takes it; what a client refuses of it as it is
  built; what it does over TLS, in the clear, beside a transport's credential and beside a broker's
  password; the platform's own TLS each direct client keeps beside it; `spec/pki/`, the test PKI
  every side's tests read, and the gate of `spec/check.py` that holds its keys; each side's TLS
  front, the twins' peer. A transport's credential stays
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s, a broker link's authentication
  [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)'s,
  [0041](0041-over-mqtt-5-a-participant-is-one-clean-link-and-a-parcel-one-publish-each-counted-to-its-byte.md)'s
  and
  [0043](0043-over-amqp-1-0-a-participant-is-one-connection-whose-exclusive-inbox-ends-with-it-and-a-parcel-one-message-of-one-profile-each-counted-to-its-byte.md)'s,
  the Rust side's sockets
  [0049](0049-the-rust-sides-sockets-are-features-of-its-core-and-a-target-is-read-as-a-pages-browser-writes-it.md)'s
  and its MQTT 5 client
  [0050](0050-the-rust-sides-broker-bindings-are-features-of-its-core-and-mqtt-5-a-client-of-its-own-over-its-sockets.md)'s,
  each pointing here for its TLS; how a server tells an access it refuses stays
  [0034](0034-a-server-tells-each-access-it-refuses-never-the-credential.md)'s. A server that judges
  its peer's certificate is ahead, by a decision of its own.

## Context

**A server that authenticates its peers by certificate needs a client that presents one.** Mutual
TLS stands in front of many services, a private authority behind it, and a client that reaches one
names the authority it trusts its server by and the certificate it presents, over a WebSocket, over
HTTP and over a broker, where a link authenticates by its certificate through SASL EXTERNAL or by
the id MQTT 5's broker ties to it. Each platform carries one its own way:

- **Node's `ws`** presents a certificate given in its options, a leaf and its intermediate in one
  PEM among them. Node's global `WebSocket` takes no TLS option at all.
- **Node's global `fetch`** presents one only through an undici `Agent` as its `dispatcher`, and
  Node exports none. Node's bundled undici and the npm one differ by major, and the bundled one's
  global dispatcher refuses a foreign one. **undici's own `fetch` with its own
  `Agent({ connect })`** presents a chain under TLS 1.2 and 1.3, follows `redirect: 'manual'` as
  given, and fails on a root its store does not hold where no `ca` is given.
- **Node's `tls.createSecureContext`** throws on a mismatched key, on a PEM with no start line and on
  an encrypted key, and builds silently from `ca: 'nope'` and from a `cert` without its `key`.
- **.NET on Windows**, through a `ClientCertificates` collection, presents no leaf under an
  intermediate from a clean store, nor a certificate its store does not trust.
  `SslStreamCertificateContext.Create(leaf, [intermediate], offline: true)` presents both, and
  writes the intermediate into the user's `CA` store. `ClientWebSocketOptions.ClientCertificates`
  and a `RemoteCertificateValidationCallback` throw beside an `HttpMessageInvoker`. MQTTnet 5.2 and
  AMQP.Net Lite 2.5.5 take a collection, and no context.
- **rustls** presents the chain `with_client_auth_cert` is given, and has neither renegotiation nor
  post-handshake authentication.

**The standards.**

- **[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446) §4.3.2 and §4.4.2**: a client sends its
  certificate when its server asks for one, its own first, each following one certifying the one
  before. **§4.4.2.4**: a server may abort with `certificate_required`, under TLS 1.3 after the
  client's Finished, so a client's request may be written before it learns. **§4.6.2**,
  post-handshake authentication; **[RFC 9113](https://www.rfc-editor.org/rfc/rfc9113) §9.2.1** and
  **[RFC 8740](https://www.rfc-editor.org/rfc/rfc8740)**, neither TLS 1.2's renegotiation nor TLS
  1.3's post-handshake authentication under HTTP/2.
- **[RFC 5280](https://www.rfc-editor.org/rfc/rfc5280) §6.1.1(d)**, the trust anchors a path is
  validated from: Node's `ca`, .NET's `CustomRootTrust` and webpki over a `RootCertStore` each
  replace the platform's roots, and none adds to them.
- **[RFC 7468](https://www.rfc-editor.org/rfc/rfc7468)**, PEM; **[RFC 5958](https://www.rfc-editor.org/rfc/rfc5958)**,
  PKCS #8; **[RFC 5915](https://www.rfc-editor.org/rfc/rfc5915)**, SEC1's EC keys. Every platform
  reads them: Node, `X509Certificate2.CreateFromPem` and `rustls::pki_types::PemObject`. librdkafka
  holds the same three in every binding, `ssl.ca.pem`, `ssl.certificate.pem` and `ssl.key.pem`.
- **[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) §5.3** holds a bearer token to TLS. A client
  certificate is no bearer credential.
- **[RFC 8705](https://www.rfc-editor.org/rfc/rfc8705) §3**, an access token bound to its client's
  certificate, `cnf` and `x5t#S256`; **[RFC 9440](https://www.rfc-editor.org/rfc/rfc9440)**, the
  `Client-Cert` and `Client-Cert-Chain` fields a proxy that terminates TLS writes.
- **The [Fetch Standard](https://fetch.spec.whatwg.org/)**: a credential is a cookie, a TLS client
  certificate or an authentication entry, and with credentials excluded no TLS client certificate is
  sent. A page's HTTP client is `same-origin`
  ([0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)), and a
  page's upgrade is in credentials mode `include`.
- **[RFC 8305](https://www.rfc-editor.org/rfc/rfc8305)**, Happy Eyeballs, which the C# side's own
  handler races by, and an application's handler does not.

**The options not taken**, each with its reason:

- **The platform's object through the seams alone**: a `ws` subclass, a `fetch`, a C# `Handler`
  made public on WebSocket, Rust's `ClientConfig`. No shape is the same on two sides; on the
  TypeScript side's HTTP, undici is the application's dependency under no rule; on the C# side,
  RFC 8305's racing is lost, Bead's `HappyEyeballs` being internal. The seams stay, refused beside
  `tls`.
- **The brokers' shapes, copied**: three shapes of one concept, `cert` and `key` required and `ca`
  beside them, two C# collections, a Rust config; copied, they ship two TypeScript `tls` types under
  different rules and two more C# names of one side alone against
  [0047](0047-every-side-shows-one-public-surface.md)'s pin.
- **Node's `ca`, `cert` and `key` for the members**, the Node.js driver of Cassandra's names among
  them: RFC 5280 names trust anchors, of which a "CA" is one; the brokers' doc comments say "the
  authority its broker's certificate is trusted by"; and C#'s `Ca` reads as no word
  ([0003](0003-one-word-one-meaning.md)).
- **A C# `ClientCertificates` collection** on the direct clients: from a clean Windows store it
  presents no leaf's intermediates, nor a certificate its store does not trust, and its result hangs
  on what ran before it.
- **A `RemoteCertificateValidationCallback` for trust**: it throws beside an invoker. The
  `X509ChainPolicy` of `CustomRootTrust` is .NET's own, and keeps the name's check apart.
- **Node's global `fetch` with an npm `Agent` as its dispatcher**: the two undicis differ by major,
  and the global one refuses a foreign dispatcher. The npm undici's `fetch` and `Agent` are one
  version together.
- **A second HTTP stack over `node:https`**: it duplicates the redirect, the streaming and the abort
  `fetch` gives.
- **No `tls` on the TypeScript HTTP client, the application's `fetch` documented**: Y off one client
  of one side, a difference that can close, and undici as an optional peer has mqtt's and rhea's
  precedent ([0004](0004-one-behaviour-in-every-language.md)).
- **Rust keeping a `ClientConfig` under `tls`**: Y and Z under one name, `tls` meaning another thing
  on one side ([0003](0003-one-word-one-meaning.md), [0047](0047-every-side-shows-one-public-surface.md)).
- **Rust's MQTT adapter keeping its `ClientConfig`**: no other side's broker adapter takes its
  library's TLS object, so it would be Z on one side.
- **`string | Uint8Array` on the TypeScript brokers**: PEM is text, and one type a side holds one
  member type on every side; a file is read as UTF-8.
- **An encrypted key and its passphrase**: every platform could take one, and no request asks for
  it. The key is unencrypted on every side, an encrypted one refused, and the record says so.
- **A unit inside "A connect"**: it would renumber 15.16 to 15.38 and every citation of them. 15.39,
  under a heading of its own at the end of section 15, renumbers nothing.
- **A revision of 0034**, which is how a server tells the accesses it refuses: the decision reaches
  0010, 0040, 0041, 0043, 0049 and 0050 at once, so it is one record, each of them pointing here.
- **The interop over mutual TLS now**: the interop listens in the clear on every side, and TLS across
  it at all is the last step of the row `A client over HTTP/2`. The twins prove each side's client
  and its own server through a TLS front under the one PKI, and the interop with a certificate is a
  row of kind open.

## Decision

### One type, one name, three members

**Every side has one TLS type, which its direct clients and its broker adapters take alike**, as
`tls`: `ITlsOptions` on the TypeScript side, in `src/transport/shared/types.ts`, its rules in
`src/transport/shared/tls.ts`; `TlsOptions` on the C# side, a sealed record of `Bead.Core`; and
`TlsOptions` on the Rust side, `#[non_exhaustive]`, `Default` and `Clone`, in `net/tls.rs`, at the
crate's root under `websocket`, `http` or `mqtt`. It is one `same` row of `tools/names.tsv`. The
options that take it are the WebSocket and HTTP transport clients', and the MQTT 5 and AMQP 1.0
adapters', the Rust side's AMQP 1.0 binding being ahead. Its three members, each optional, each PEM
text, a `string` and a `String`:

- **`authorities`**: one or more `CERTIFICATE` blocks, the trust anchors the server's certificate
  chains to, in place of the platform's roots and never added to them. Given none, the platform's
  roots and verifier judge the server, as the row `A client's trust roots` of
  [`docs/support.md`](../support.md) states.
- **`certificate`**: the client's certificate first, then the intermediates that certify it, each
  certifying the one before (RFC 8446 §4.4.2).
- **`key`**: the certificate's private key, unencrypted: PKCS #8 (`PRIVATE KEY`), SEC1
  (`EC PRIVATE KEY`) or PKCS #1 (`RSA PRIVATE KEY`). An encrypted key (`ENCRYPTED PRIVATE KEY`) is
  refused, and no side takes a passphrase.

A `tls` that gives no member is taken as none. Rendered, the key is never printed: the C# record's
`PrintMembers` and the Rust side's `Debug`, written by hand, write `<redacted>` for a key given.

### What a client refuses as it is built

Each refusal is a programmer's error, `ProgrammerError` on the TypeScript and Rust sides and
`ArgumentException`, its `ParamName` `options`, on the C# side, in this order:

1. `tls` in a page, on the TypeScript side: `a page chooses no TLS client certificate, its browser
   does`, the MQTT 5 adapter going on with its own `…: authenticate it by a password`;
2. `tls` beside the platform's own TLS the client is given:
   `tls is refused beside {what}, which keeps a TLS of its own`, `{what}` a `WebSocket` that is not
   ws-shaped, by the credential's own check, the global one among them, and a `fetch` on the
   TypeScript side; a `Handler`, over HTTP and over WebSocket, on the C# side; a `client_config` on
   the Rust side. A ws-shaped `WebSocket` takes `tls`;
3. a `certificate` without its `key`, or a `key` without its `certificate`:
   `a TLS client certificate is given with its key, and a key with its certificate`;
4. `authorities` or a `certificate` that holds no certificate that reads, a `key` that does not read
   or is encrypted, and a `key` of another certificate: `{member} reads as no {certificate|key}`, or
   `the key is not the certificate's`. Node builds a context from a `ca` that reads as nothing and
   from a `cert` alone, so the TypeScript side checks both itself.

### What `tls` does

**Over TLS, a secured connect presents `certificate` where its server asks for one at the
handshake, and judges its server under `authorities`.** A handshake its server refuses fails the
connect, on every side, its error carrying its platform's cause and naming no refusal, since a TLS
alert is no refusal of Bead's
([0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)). Under
TLS 1.3 a client's first request may already be written as its server's refusal comes; over HTTP
that connect fails as a connect all the same, never as a connection drawn and then lost, since it
awaits its answer and none comes.

**In the clear, a client holds `tls` and uses it on a secured connect alone**, on every side:
`secured` is a connect's, `tls` its client's. A client certificate is no bearer credential, so 13.4
refuses nothing of it in the clear. A broker's adapter, whose URL and `tls` are one record, refuses
a `tls` over a URL that is not TLS: `a TLS client certificate is carried over mqtts or wss, not
{url}`, and its AMQP 1.0 twin over `amqps`.

**Beside the transport's credential, `tls` is taken**: the certificate authenticates the TLS peer to
whatever terminates TLS, the credential the call to the router, two layers Bead binds neither to
the other. RFC 8705 §3's certificate-bound token is the binding a server that judges its peer's
certificate would check.

**Beside a broker's password, a password or its provider is refused beside a `certificate` alone**,
and taken beside `authorities` alone, on every side, MQTT 5 and AMQP 1.0 alike. An AMQP 1.0 adapter
given neither a password nor a `certificate` is refused whatever its `authorities`, since it never
falls to ANONYMOUS.

### The platform's own TLS

**Each direct client keeps one public way to its platform's own TLS, refused beside `tls`**: on the
TypeScript side its `WebSocket`, a `ws` subclass, and its `fetch`; on the C# side its `Handler`, an
`HttpMessageHandler?`, over HTTP and over WebSocket, where it is held in an
`HttpMessageInvoker(handler, disposeHandler: false)`; on the Rust side its `client_config`, an
`Option<Arc<rustls::ClientConfig>>`. It is the way for a key no PEM carries: one held in a store, a
smart card or a hardware module, or one that cannot be exported. The broker adapters take `tls`
alone, on every side: neither MQTT.js's nor rhea's, MQTTnet's nor AMQP.Net Lite's, nor rustls's own
object reaches one. A platform's TLS object for the brokers comes to every side at once, by a
decision of its own.

### Each side

- **TypeScript**: over a WebSocket, `tls` goes to a ws-shaped constructor's options as `ca`, `cert`
  and `key`. Over HTTP, undici is an optional peer dependency, `^8`, as mqtt and rhea are: given
  `tls`, the client calls undici's own `fetch` through its own `Agent({ connect: { ca, cert, key }
  })`, never an npm `Agent` inside Node's global `fetch`. Where undici does not resolve, by
  `createRequire(import.meta.url).resolve` reached through `process.getBuiltinModule`, the client is
  refused as it is built, naming the package; it is imported at the first connect by a specifier
  bundlers leave alone, so that no page's bundle carries it. The broker adapters' `tls` is the same
  type, its members a `string` alone.
- **C#**: a client given `Tls` builds its own `SocketsHttpHandler`, with the four settings of the
  shared `Racing` handler and `SslOptions` from `Tls`, disposed with the client; a client without
  `Tls` keeps `Racing`. Its certificate is read from PEM, its leaf through a PKCS #12 round trip,
  since Windows' TLS presents no key held in memory alone, into an `SslStreamCertificateContext`
  with its intermediates, and its server judged by a `CertificateChainPolicy` of `CustomRootTrust`, its
  revocation mode `NoCheck`. The broker adapters take the same `TlsOptions`, and build the
  collection MQTTnet and AMQP.Net Lite take from it.
- **Rust**: Bead builds a client's `ClientConfig` from `tls`, on the platform's verifier where no
  `authorities` are given and on webpki over them where they are, the certificate by
  `with_client_auth_cert`, so a certificate with the platform's roots works; an application's own
  `ClientConfig` is a client's `client_config`. The MQTT 5 adapter takes `tls: Option<TlsOptions>`
  alone.

### The test PKI and the TLS front

**Every side's tests read one PKI, `spec/pki/`**, which `spec/pki/make.sh`, an openssl script,
writes, run once and again only to renew it: a root, an intermediate under it of path length 0, a
client's leaf under the intermediate for `clientAuth`, `client-chain.pem` holding that leaf then the
intermediate, a server's leaf under the root for `serverAuth`, for `localhost` and `127.0.0.1`, and
a stranger root with a client's and a server's leaf of its own, every leaf `CA:FALSE`; P-256 keys
in PKCS #8, unencrypted, about a hundred years of validity. Its keys are published test keys:
`spec/check.py`'s `TEST_PKI_KEYS` finds each by the first full line of its PEM's body, refuses any
file git lists outside `spec/`, the tests and the interop service that names one, and fails where
a key's file does not hold its own line, so that a gate matching nothing fails
([0006](0006-a-rule-has-its-gate.md)).

**Each side's test kit has a TLS front**, the small local proxy that stands in front of a side's
plain WebSocket and HTTP transport servers: it listens on the loopback under `server.pem` or
`stranger-server.pem`, asks for a client certificate under `root.pem` or for none, as its test
says, holds its highest TLS version at 1.2 or 1.3, and pipes the bytes to the server. The
TypeScript side's is `node:tls`; the C# side's an `SslStream` over a `TcpListener`,
`ClientCertificateRequired`, its chain judged by `CustomRootTrust`; the Rust side's a
`tokio_rustls::TlsAcceptor` under a `WebPkiClientVerifier` over the root, then
`copy_bidirectional`. A twin's accepted connect opens a session and sends one envelope each way, so
it proves Bead's client and Bead's server through TLS.

## Consequences

- **The twins**, each naming spec 15.39, on every side's WebSocket client and HTTP client: a
  certificate under an intermediate presented to a server that requires one, the server trusted by
  the authorities given, under TLS 1.2 and TLS 1.3; a connect that fails presenting a certificate
  its server does not trust, or none, under both; one that fails to a server under no authority it
  trusts, given or of its platform; one in the clear with `tls` given; and `tls` refused beside the
  platform's own TLS. Once a side, its type's refusals as built; on the brokers, a password taken
  beside a `tls` of authorities alone, built over `mqtts` or `amqps` and never started. On the
  TypeScript side in a page, under Playwright, `tls` refused, naming why. A refused connect's twin
  asserts its failure alone, its cause unnamed, since TLS versions and stacks fail it each their way.
- **A broker takes PEM alone, on every side**: a key no PEM carries, held in a store, a smart card
  or a hardware module, reaches a direct client through its platform's TLS, and no broker's
  adapter.
- **The C# side's leaf's intermediates on Windows** are written to the user's `CA` store by the
  context that presents them, and the brokers' libraries, taking a collection, present a leaf's
  intermediates only once that store holds them, and on Linux the leaf alone, so the AMQP 1.0
  twin's leaf is issued by its fixture's own CA: a row of Differences, `A client certificate's intermediates on Windows`.
- **Rows of Differences, of kind platform**: `A client certificate in a page`, which a page's
  browser chooses over a WebSocket, presents none to another origin over HTTP, and chooses to its
  own origin; `A certificate a server asks for after the handshake`, never on the Rust side and none
  over HTTP/2; `A client certificate over HTTP in Node`, undici's. **Of kind open**:
  `A client certificate across the interop`.
- **A password beside authorities alone is taken on every side**, so the matrix holds no row for
  it.
- **Ahead**, each by a decision of its own: a server that takes its peer's certificate as an
  identity at its admission, the C# HTTP server's client-certificate mode, RFC 9440's fields over a
  WebSocket and over a believed proxy as
  [0030](0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md) believes
  `X-Forwarded-For`, and RFC 8705 §3's binding between a `JWT` and the certificate; a platform's
  TLS object for the brokers, on every side at once; the interop over TLS, each side's client
  presenting `spec/pki`'s certificate to the others' servers through a TLS front.

**Its gates**: the twins on every side, the TLS fronts under `spec/pki/`; `spec/check.py`'s test
PKI's keys; and `tools/names.tsv`'s one `same` row of the type.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, at xhigh effort, against a proposal of the brokers' shape on every client. Each claim was
checked against each side's code and against probes of `ws`, of undici's own `fetch`, of Node's
secure context, of .NET on Windows and of rustls. Thirteen objections: eleven accepted, two in part,
none refused. Two questions went to the user, each taken by its recommendation: the members'
names, `authorities`, `certificate` and `key`, by RFC 5280's trust anchors; and the brokers taking
PEM alone on every side, a platform's TLS object for them ahead, to every side at once. The
objections, with the answers that hold:

### On a client's TLS certificate and the authorities it trusts

| Objection                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1.** The premise is half wrong. The TypeScript WebSocket (`WebSocket`, a `ws` subclass), the TypeScript HTTP (`fetch`) and the C# HTTP (`Handler`) clients already take a certificate through a public option, and only the C# WebSocket has none. A new `tls` beside them needs a rule for each pairing. | **Accepted.** Verified in each side's client types and the C# HTTP side's shipped API. The decision starts from these seams. The seams-only design is weighed and refused: racing lost on C#, undici left to the application on TypeScript. The pairings: `tls` beside a given `fetch` is refused; beside a `WebSocket` that is not ws-shaped, refused; beside a ws-shaped `WebSocket`, given in its options; C# `Tls` beside `Handler`, refused; Rust `tls` beside `client_config`, refused. A twin holds them.                                                                                                                                                                                                                                         |
| **O2.** "The broker adapters' shape" is three shapes. TypeScript would ship two `tls` types with different rules, and two more C# records would break 0047's falling `alone` count.                                                                                                                          | **Accepted.** One type per side under one name: `ITlsOptions`, `TlsOptions` in Bead.Core, `TlsOptions` in Rust. The brokers and the direct clients share it. One `same` row of `tools/names.tsv` replaces two `alone` rows, and the C# pin falls from 56 to 54. The matrix's row of a password beside authorities closes: `authorities` alone, `certificate` and `key` together or not at all, a password refused beside a certificate only, a twin on every side.                                                                                                                                                                                                                                                                                       |
| **O3.** A C# `ClientCertificates` collection presents no leaf under an intermediate from a clean Windows store. The context does, but it writes the intermediate into the user's `CA` store. The brokers use the collection. Linux was not probed.                                                           | **In part.** The direct clients take PEM, built into an `SslStreamCertificateContext` with its intermediates, and trust by `CertificateChainPolicy` (`CustomRootTrust`, `RevocationMode = NoCheck`). The Windows side effect is a platform row, `A client certificate's intermediates on Windows`, and the tests remove the intermediate before and after. The leaf under an intermediate is a twin on every direct client. It does not extend to the brokers: MQTTnet 5.2 and AMQP.Net Lite 2.5.5 take a collection and no context. So the broker twins keep a leaf issued by the root, and the row says so. Linux is probed by the C# side's stage first, which stops where the context fails there.                                                   |
| **O4.** `ClientCertificates` and `RemoteCertificateValidationCallback` throw beside an `HttpMessageInvoker`, and every connect goes through the static `Racing`. A per-client handler is a cost left out.                                                                                                    | **Accepted.** Verified in the C# WebSocket client. A client given `Tls` builds its own `SocketsHttpHandler` with `Racing`'s four settings and `SslOptions` from `Tls`, disposed with the client. A client without `Tls` keeps `Racing`. No client asks for HTTP/2 (the row `A client over HTTP/2`). A `SocketsHttpHandler` that did would present the certificate at its handshake, as the probe found, and the doc comment says so.                                                                                                                                                                                                                                                                                                                     |
| **O5.** In Node, `fetch` takes a certificate only through an undici `Agent` as `dispatcher`. Node exports none, undici is no dependency, and the client's `fetch` init has no `dispatcher`.                                                                                                                  | **Accepted, (a).** undici is an optional peer dependency (`^8`), as mqtt and rhea are. Given `tls`, the client uses undici's own `fetch` with its own `Agent({ connect: { ca, cert, key } })`, never an npm Agent inside Node's global `fetch`. Probed: undici 8.12.4 presented the chain under TLS 1.2 and 1.3 and honoured `redirect: 'manual'`. Where undici does not resolve (`createRequire(import.meta.url).resolve`, reached through `process.getBuiltinModule`), the client is refused as it is built, naming the package. It is imported on the first connect by a specifier bundlers leave alone, so no page's bundle carries it.                                                                                                              |
| **O6.** For the TypeScript WebSocket, "in Node" means "over `ws`". Node's default is the global WebSocket, which takes no TLS through the transport's third argument.                                                                                                                                        | **Accepted.** `tls` is refused beside a `WebSocket` that is not ws-shaped, by the credential's own check (`isWsShaped`), in words of the same form. In a page it is refused as the MQTT adapter refuses it, "a page chooses no TLS client certificate, its browser does". A twin holds the first, and `refuses tls in a page, naming why` the second.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **O7.** The platforms refuse nothing for a `cert` without its `key` (Node) or a certificate without its private key (.NET), and nothing says what `tls` does in the clear.                                                                                                                                   | **Accepted.** Every side refuses as built a certificate without its key, a key without its certificate, a key of another certificate, an encrypted key, and a PEM that reads as no certificate, a twin on every side. Node's `createSecureContext` builds silently from `cert` alone and from `ca: 'nope'` (probe), so the TypeScript side checks both itself. In the clear, `tls` is held and used on secured connects alone, on every side, as the Rust side does: `secured` belongs to a connect, `tls` to the client. A broker keeps its refusal over a URL that is not TLS, its URL and its `tls` being one record.                                                                                                                                 |
| **O8.** The twins are not one sentence. The failure differs by TLS version and stack, the collection makes "untrusted" and "none" one case, and three generators would make three PKIs. The transports' TLS fixture is a CA that webpki refuses as an end entity.                                            | **Accepted.** The refused connects' twins read "fails its connect", with no cause, under TLS 1.2 and TLS 1.3 by the front's highest version. Over HTTP, a refusal after a request was written still fails the connect, never a connection drawn. A refused certificate goes unnamed, as spec 15.39 says, since a TLS alert is no Bead refusal (0026). The collection's case closes through O3's context. One PKI is committed under `spec/pki/` by one openssl script: a root, an intermediate, a clientAuth leaf under it, a serverAuth leaf for localhost and 127.0.0.1, and a stranger root with its two leaves, every leaf CA:FALSE. `spec/check.py` holds its keys as it holds the JWT verdicts' keys.                                              |
| **O9.** Rust keeping `ClientConfig` is Y and Z with no row, and the proposal mixes Kafka's named PEM members with Cassandra's platform object. Rust cannot do "my certificate with the platform's authorities" without rustls-platform-verifier.                                                             | **Accepted.** Y on every side, Rust included: one shape, one set of names (`authorities`, `certificate`, `key`, PEM, Kafka's precedent), carried to the brokers by a renaming. Bead builds Rust's config on the platform verifier when no authorities are given and on webpki when they are, so a certificate with the platform's authorities works. Z comes to every direct client at once: TypeScript's `WebSocket` and `fetch`, C#'s `Handler` on HTTP and on WebSocket, and Rust's `ClientConfig` as `client_config`. Rust MQTT comes back to Y, since no other broker adapter takes its library's object. The key is unencrypted on every side. 0049's TLS and 0050's options point here.                                                           |
| **O10.** In a page, "the browser choosing" is wrong for HTTP. Fetch counts a TLS client certificate as a credential, and 0027 leaves a page's credentials `same-origin`.                                                                                                                                     | **Accepted.** The platform row `A client certificate in a page` has three cases: over a WebSocket, the browser's choice, a prompt among it (credentials mode `include`); over HTTP to another origin, none, by Fetch and 0027; over HTTP to its own origin, the browser's choice. The second is for the server that judges a peer's certificate to carry: a cross-origin page cannot be identified by a certificate over HTTP while 0027 stands.                                                                                                                                                                                                                                                                                                         |
| **O11.** 0034 is the wrong record. The transports' credentials and TLS are 0010's, 0049's and 0050's, and the brokers' are 0041's and 0043's. "A JWT beside a certificate is fine" needs its reason and its standard.                                                                                        | **Accepted.** 0034 is how a server tells refusals. The decision is this record, since it reaches 0010, 0040, 0041, 0043, 0049 and 0050 at once, and each points here. 0010's `A transport's credential and TLS` holds the two layers: the certificate authenticates the TLS peer to what terminates TLS (RFC 8446 §4.3.2, §4.4.2), the credential the call to the router; RFC 8705 §3 is the binding a server that judges its peer's certificate would check. A broker's password and certificate are one link's (SASL PLAIN or EXTERNAL; MQTT ties the id to the certificate), hence "never both" there (0040). A client certificate is no bearer credential, so 13.4 does not refuse it in the clear.                                                  |
| **O12.** The twins' peer is a test-only server, so they prove each platform's TLS but never Bead across languages. The TypeScript and Rust HTTP servers can already require a certificate, C#'s cannot, no WebSocket server terminates TLS, and the interop listens in the clear.                            | **In part.** Verified in each side's HTTP server and the C# interop, which listens on `127.0.0.1` in the clear. The twins' peer is each side's TLS front, the small local proxy the repository's design names, before the side's own plain WebSocket and HTTP servers, under the one shared PKI. So a twin proves Bead's client and Bead's server through TLS. The interop over TLS with a certificate is refused for this decision, since the interop serves no TLS at all (the row `A client over HTTP/2`): it is a row of kind open, `A client certificate across the interop`. The C# HTTP server's client-certificate mode, and RFC 9440 over WebSocket, belong to the server that judges a peer's certificate, named here as its way, with no row. |
| **O13.** A certificate asked for after the handshake (TLS 1.2 renegotiation, TLS 1.3 post-handshake authentication) is a missing platform row. rustls supports neither, and HTTP/2 forbids both.                                                                                                             | **Accepted.** Verified: rustls 0.23.46 lists renegotiation among its non-features. The row `A certificate a server asks for after the handshake` is of kind platform, not tested. On the Rust side never; Node and .NET as their platforms; over HTTP/2 none (RFC 9113 §9.2.1, RFC 8740). The twins hold a certificate asked for at the handshake.                                                                                                                                                                                                                                                                                                                                                                                                       |
