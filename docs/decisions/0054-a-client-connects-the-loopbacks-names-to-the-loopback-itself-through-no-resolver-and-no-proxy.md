# 0054 — A client connects the loopback's names to the loopback itself, through no resolver and no proxy

- **Status**: accepted
- **Scope**: the protocol's 13.4, a client's connect of a host it judges on the loopback, that host
  read once, and the sentence of 15.12 on a client by `localhost`, in
  [`spec/spec.md`](../../spec/spec.md); every side's dialers, the table below written whole: the WebSocket and HTTP transport clients, the
  gateway's caller, the MQTT 5 and AMQP 1.0 adapters; the predicate of a localhost name, the C#
  side's proxy bypass and the TypeScript side's race, by their names below; and the twins that
  hold them. A client's judgement of a host, and RFC 6750 §5.3's rule, stay
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s; a server's hosts, its address and
  both loopbacks
  [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)'s; a
  client's TLS [0053](0053-a-client-presents-the-tls-certificate-and-trusts-the-authorities-its-application-names-in-one-shape-on-every-side.md)'s.

## Context

**A client judges a host on the loopback by its name, and a credential crosses on that
judgement.** Spec 13.4 takes `localhost`, a name that ends in `.localhost`, 127.0.0.0/8 and `[::1]`
as on the loopback, as the WHATWG URL Standard's host parser reads a URL, on every side alike, so a
`JWT` goes over `ws://api.localhost:p` in the clear. The judgement holds only while the connect
reaches the loopback.

**A resolver sends such a name elsewhere.** glibc's and musl's resolvers send a name under
`.localhost` on to the network's DNS server: in a Linux container, `api.localhost` answered
`192.0.2.7`, and a credential judged secure crossed there in the clear. Windows answers `localhost`
with `::1, 127.0.0.1` and `api.localhost` with `127.0.0.1` alone. A hosts file or a container's
`extra_hosts` maps any such name where it likes.

**A proxy takes the connect before any resolver.** Under an HTTP proxy the client's connect never
sees its target. Measured on Windows 11 (26300), Node 26.10.0 (its bundled undici 8.10.2, the
package 8.12.4) and .NET 10.0.15:

- .NET's `HttpClient.DefaultProxy`, which every `SocketsHttpHandler` reads while `UseProxy` keeps
  its default, takes `api.localhost`, `localhost`, `127.0.0.1`, `127.0.0.2` and `[::1]`, each with
  its `Authorization`; under `NO_PROXY=localhost,127.0.0.1,::1` it still takes `api.localhost`,
  `127.0.0.2` and `[::1]`. MQTTnet 5.2.0.1603 over a WebSocket builds a `ClientWebSocket` that sends
  `CONNECT api.localhost:p` to the platform's proxy.
- Node's global `fetch` and `WebSocket` under `NODE_USE_ENV_PROXY=1` take `127.0.0.1`, `localhost`
  and `api.localhost` to the environment's proxy.
- MQTT.js, over `mqtt` and `mqtts`, connects through the SOCKS proxy `MQTTJS_SOCKS_PROXY` names,
  and no option of its turns it off.
- `ws`, rhea, MQTTnet over TCP, AMQPNetLite and the Rust side read no proxy.

A check of the peer's address after the connect does not help: a proxy on the loopback, cntlm on
`127.0.0.1:3128`, passes it and forwards the absolute-form request off the machine.

**The hooks each library offers.** Each dialer a side builds has a public way to choose its own
connect:

- Node's global `fetch` and `WebSocket` take no `lookup`. Their one hook is an undici `Agent` as
  `dispatcher`, which Node does not export, and which its bundled undici refuses from the package.
  undici's own `fetch` and `WebSocket` (`new WebSocket(url, { protocols, dispatcher })`) take an
  `Agent({ connect: { lookup, autoSelectFamily } })`: probed, the upgrade and the `POST` reach the
  target with `Host: api.localhost:p`, and a proxy set under `NODE_USE_ENV_PROXY=1` receives
  nothing.
- `ws`, `tls.connect`, MQTT.js over TLS and over `ws` take `lookup`; MQTT.js over TCP drops it, both
  its streams go through its SOCKS proxy, and it takes a stream builder of the caller's; rhea's own connect in the clear drops its options, and
  takes a `connect` of the caller's.
- .NET's `SocketsHttpHandler` takes a `ConnectCallback` and a `Proxy`; MQTTnet takes a
  `StreamProvider` over TCP, on which it layers TLS, and an adapter factory, whose WebSocket channel
  can connect a `ClientWebSocket` through a handler of the caller's; AMQPNetLite 2.5.5 takes a
  `TransportProvider` for `AMQP` and `AMQPS`. Each was probed end to end, the listener reading
  `Host: api.localhost:p` where the protocol carries one.
- The Rust side's dialers all connect through one racing connector, which takes the resolver it
  asks.

**The race.** .NET refuses a closed loopback port in about two seconds on Windows. MQTTnet over TCP
and AMQPNetLite connect each address in turn: against a server on `127.0.0.1` alone, a connect by
`localhost` was accepted after 2116 ms and 2121 ms, `::1` tried first.

**The standards.**

- **[RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750#section-5.3)**: a bearer token MUST NOT
  leak. 13.4 serves it, and a resolver or a proxy that sends a connect judged secure elsewhere
  breaks it.
- **[draft-ietf-dnsop-let-localhost-be-localhost-02](https://datatracker.ietf.org/doc/html/draft-ietf-dnsop-let-localhost-be-localhost-02)**,
  an Internet-Draft expired in 2018, whose rules W3C Secure Contexts references normatively.
  Section 3, item 2: software that makes security decisions on the assumption that localhost names
  resolve to loopback addresses "MUST directly translate localhost names to a loopback address, and
  MUST NOT rely upon name resolution APIs to do so". Section 5.1: leaving resolution to the
  environment is safe only where its resolver is known to follow those rules.
- **[RFC 6761 §6.3](https://www.rfc-editor.org/rfc/rfc6761#section-6.3)**, item 2: application
  software MAY recognize localhost names as special. Its items 3 to 5 are resolvers' SHOULDs, which
  glibc and musl do not follow.
- **[W3C Secure Contexts §3.1](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy)**
  trusts a localhost name only where the user agent follows the draft's rules. It takes `localhost.`
  and a name that ends in `.localhost.`, which every Bead server refuses (15.12, 0024).
- **[RFC 8305](https://www.rfc-editor.org/rfc/rfc8305)**: race a name's families, an attempt every
  250 ms, each kept until one connects (§5), ordered by RFC 6724 (§4).
- **[RFC 6724 §2.1](https://www.rfc-editor.org/rfc/rfc6724#section-2.1)**: the default policy gives
  `::1/128` precedence 50 and IPv4 35, so `::1` first; a host may configure another.
- **[RFC 6066 §3](https://www.rfc-editor.org/rfc/rfc6066#section-3)** and
  **[RFC 9110 §7.2](https://www.rfc-editor.org/rfc/rfc9110#section-7.2)**: a request names its host
  in its TLS server name and its `Host`.

**The options not taken.**

- **Harden the connects in the clear alone.** 13.4 needs the loopback only in the clear. But the
  connectors that carry the rule take no scheme, a name whose destination hangs on its scheme
  surprises (`wss://api.localhost` reaching a container, `ws://api.localhost` the loopback), and
  every hook proven for the clear carries TLS too.
- **Hand the broker libraries the literal `127.0.0.1`.** It drops `::1` and the race, which the Rust
  side's MQTT 5 link has through its connector: the C# and TypeScript brokers would be narrower than
  the Rust one.
- **`UseProxy = false` on every C# handler.** It also stops the platform's proxy for a host off the
  machine, a behaviour this decision does not change.
- **Check the peer's address after the connect**, which a proxy on the loopback passes.
- **Rewrite the URL to the literal and keep the name in `Host`.** undici writes the URL's authority
  as `Host`, so the name is lost, and a local reverse proxy that routes by name, which is what a
  `.localhost` subdomain is for, breaks.
- **Reach the global dispatcher's constructor** through `Symbol.for('undici.globalDispatcher.1')`,
  which leans on Node's internals, as Bead does not (0024's reason for two `http.Server`s).
- **On the TypeScript side, undici's own dialers for localhost names alone**, IP literals left to
  Node's global ones, which the environment's proxy takes under `NODE_USE_ENV_PROXY=1`.
- **On the TypeScript side, a connect to the loopback in Node failing without undici**, naming the
  package. Every Node client in the clear without undici would fail, where the package runs in Node
  with nothing else installed.
- **undici a dependency of the TypeScript package.** It revises 0053's optional peer and the
  package's "no dependency".
- **Judge a localhost name in the clear over a dialer the application gives.** It refuses a
  credential over every handler, `fetch` or WebSocket an application gives for logging or for its
  own TLS, where Secure Contexts reads such a name by its name under the draft's section 5.1.
- **Take `localhost.` and `a.localhost.` on the client alone**, which every Bead server refuses: a
  client and a server would read two sets of names. **Take them on both**, as Secure Contexts does,
  which changes what every server takes and how it compares a host, on three sides and in
  `spec/transports.json`'s host cases: a change of 0024's decision that nothing here asks for.
- **An override**, as curl's `--resolve`. A host off the machine has its own name or address, and a
  dialer the application gives connects as the application likes.
- **A conformance case.** `spec/transports.json` plays a transport against a peer and injects no
  resolver and no proxy.

## Decision

### Every dialer a side owns connects the loopback itself

Spec 13.4 states the rule. A client connects a host it judges on the loopback to the loopback,
through no proxy, its own or its platform's, an IP literal included. It connects `localhost` and a
name that ends in `.localhost`, read as its side's URL host parser reads it, to `127.0.0.1` and
`::1`, and asks no resolver, whatever the platform's would answer: the draft's section 3, item 2,
asks it of software that makes the security decision 13.4 makes, and RFC 6761 §6.3 lets it. So the
condition on which Secure Contexts trusts such a name holds on every dialer Bead owns.

The host is read once, by the side's URL host parser, a broker's URL's host as a special scheme's;
the address read is connected and named, and a host the parser fails on is refused before any
socket opens.

The judgement does not change (0010): `localhost.` and a name that ends in `.localhost.` stay off
the loopback, the two departures from Secure Contexts named in 13.4, since a server compares a host
as it comes and refuses both (15.12), and a client and a server read one set of names.

### The race, `127.0.0.1` first

A client races the two addresses as RFC 8305 §5 races its attempts: `127.0.0.1` first, then `::1`
250 ms later, or at once when the first fails. Every attempt is kept until one connects, as RFC 8305
§5 keeps them; the first connected is kept and the other closed. The early start on a failure is
Bead's own. A connect given up ends every attempt. The TypeScript side runs the race itself, since
Node's `autoSelectFamily` closes an attempt at its delay, and hands the raced socket to the TLS and
HTTP code it would have used, so a localhost name negotiates what an IP literal does.

`127.0.0.1` first departs from RFC 6724's default policy, which puts `::1` first, and 13.4 names the
departure:

- a Bead server on its defaults listens on `127.0.0.1`, beside `::1` or alone where the IPv6
  loopback is absent (15.12);
- a server given `127.0.0.1` alone, the commoner single-family server, cannot be pre-empted by a
  process on `[::1]:p` for a Bead client over a dialer it owns while `127.0.0.1:p` accepts within
  the delay, as it is on Windows for every client by `localhost` that tries `::1` first; on a slower
  accept, a process on `[::1]:p` that accepts first wins on every side, as the race has it;
- the cost falls on a server given `::1` alone: 250 ms a connect by `localhost`, and a process on
  `127.0.0.1:p` pre-empts it for every Bead client over a dialer it owns.

### The name kept, whatever the scheme

The request names the host as its URL serializes it, in its `Host` (or `:authority`) and in its TLS
server name alike: only the address it connects to is Bead's own. The rule holds for `ws`, `wss`,
`http`, `https`, `mqtt`, `mqtts`, `amqp` and `amqps` alike, since a name's destination does not
depend on its scheme, and the connectors that carry it take none.

### A failed connect says why, and nothing points the name elsewhere

A client's failure for a localhost name whose every attempt failed carries, beside the platform's
cause, `<host> names the loopback: connected to 127.0.0.1 and ::1, no resolver asked`. The type of
the error each side raises stays what its callers read. Bead offers no option that points such a
name elsewhere: a host off the machine is named by its own name or address, under TLS when a
bearer credential goes.

### A dialer a side does not own

Over a dialer a side does not own, the connect is that dialer's, and the client judges a localhost
name by the name alone, as Secure Contexts reads one under the draft's section 5.1. 13.4 states the
residual: a resolver that sends a name under `.localhost` on to its DNS server, a proxy, or a user
agent that does not follow the draft's rules takes a credential judged secure wherever it answers,
in the clear. Such a dialer is one of three, and each option that takes one says so in a sentence
of its documentation:

- a handler, a `fetch` or a WebSocket constructor the application gives;
- a page's own `fetch` and `WebSocket`, which its user agent connects: in a page, in a Web Worker,
  and under MQTT 5 in a page;
- on the TypeScript side in Node, where undici does not resolve, Node's global `fetch` and
  `WebSocket`, which take no `lookup` and no `Agent` of the package's. undici stays an optional peer
  ([0053](0053-a-client-presents-the-tls-certificate-and-trusts-the-authorities-its-application-names-in-one-shape-on-every-side.md)),
  so the package runs in Node with nothing else installed; with it, the default dialers are Bead's
  own. The difference is two rows of [`docs/support.md`](../support.md)'s Differences: `A host on
  the loopback connected directly, a localhost name asking no resolver`, of kind platform, for the
  WebSocket client; and `A localhost name over the TypeScript HTTP client and caller in Node without
  undici`, of kind open, since `node:http` could carry a dialer of the side's own.

### Each side's dialers

| Side       | Dialer                                                          | Owned or not                                                           | What carries the rule                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust       | WebSocket client                                                | owned                                                                  | `net/racing.rs`'s `connect_racing`, through `net/dial.rs`'s `dial`                                                                                                                                             |
| Rust       | HTTP client, gateway caller                                     | owned                                                                  | `connect_racing`, through `http/client.rs`'s `Connector`                                                                                                                                                       |
| Rust       | MQTT 5 link, `mqtt`, `mqtts`, `ws`, `wss`                       | owned                                                                  | `connect_racing`, through `dial`                                                                                                                                                                               |
| C#         | WebSocket client, by `Racing` or its own TLS handler            | owned                                                                  | `HappyEyeballs.ConnectCallback` and `LoopbackBypassProxy` on the `SocketsHttpHandler`                                                                                                                          |
| C#         | HTTP client and `HttpCaller`, by their own handler              | owned                                                                  | `HappyEyeballs.ConnectCallback` and `LoopbackBypassProxy`                                                                                                                                                      |
| C#         | WebSocket client, HTTP client and `HttpCaller`, a handler given | not owned                                                              | none: judged by name, the residual stated                                                                                                                                                                      |
| C#         | MQTT adapter over TCP, `mqtt`, `mqtts`                          | owned, MQTTnet                                                         | `MqttClientTcpOptions.StreamProvider`, a provider of Bead's over `HappyEyeballs.ConnectAsync`, MQTTnet layering TLS on it                                                                                      |
| C#         | MQTT adapter over a WebSocket, `ws`, `wss`                      | owned, MQTTnet                                                         | `GuardedAdapterFactory`'s WebSocket channel, whose `ClientWebSocket` connects through a Bead handler                                                                                                           |
| C#         | AMQP adapter, `amqp`, `amqps`                                   | owned, AMQPNetLite                                                     | a `TransportProvider` of Bead's for `AMQP` and `AMQPS`, over `HappyEyeballs.ConnectAsync`, its TLS an `SslStream` of its own                                                                                   |
| TypeScript | WebSocket client, HTTP client and caller, the defaults in Node  | owned where undici resolves; Node's global dialers, not owned, without | undici's own `WebSocket` and `fetch` with the client's `Agent`, whose `connect` races the loopback and hands the socket to undici's own connector under TLS, the TLS path's `Agent` merged in                  |
| TypeScript | WebSocket client, `ws` given                                    | owned, its options Bead's                                              | a `createConnection` in its options that races the loopback, under `wss` handing the socket to `tls.connect` with the options `ws` built; `ws` reads no proxy                                                  |
| TypeScript | WebSocket client, another constructor given, or a page's        | not owned                                                              | none: judged by name, the residual stated                                                                                                                                                                      |
| TypeScript | HTTP client and caller, a `fetch` given, or a page's            | not owned                                                              | none: judged by name, the residual stated                                                                                                                                                                      |
| TypeScript | MQTT adapter in Node, `mqtt`, `mqtts`                           | owned, MQTT.js                                                         | a stream builder of Bead's given the socket the adapter's race wins, under `mqtts` handing the socket to its TLS, since MQTT.js's own TCP stream drops `lookup` and both of its own go through its SOCKS proxy |
| TypeScript | MQTT adapter in Node, `ws`, `wss`                               | owned, MQTT.js over `ws`                                               | a `createConnection` in `wsOptions` that races the loopback, as for a `ws` given                                                                                                                               |
| TypeScript | MQTT adapter in a page                                          | not owned, the browser's `WebSocket`                                   | none: judged by name, the residual stated                                                                                                                                                                      |
| TypeScript | AMQP adapter, `amqp`, `amqps`                                   | owned, rhea                                                            | rhea's `connect` option, given the socket the adapter's race wins, under `amqps` handing the socket to its TLS, since rhea's own connect in the clear drops its options                                        |

The relays dial nothing: a relay's leg B is a router over one of these clients. No side fetches a
key set. The Rust side's AMQP 1.0 binding is ahead, and carries the rule through `connect_racing`.

### The names

The predicate of a localhost name is `isLocalhostName` on the TypeScript side
(`src/transport/shared/loopback.ts`), `TransportSecurity.IsLocalhostName` on the C# side, internal,
and `is_localhost_name` on the Rust side (`judgement/security.rs`), `pub(crate)`. The C# side's
proxy bypass is `LoopbackBypassProxy`, internal to `Bead.Core`, which keeps the platform's proxy for
a host off the machine and bypasses it for every host judged on the loopback. The TypeScript side's
race is `raceLoopback`, beside the predicate. `loopbackConnector` is the `connect` of undici's
`Agent`, which `createUndiciDialer` builds. `loopbackCreateConnection` is the `createConnection`
handed to `ws` and to MQTT.js over `ws`. The MQTT 5 adapter, over `mqtt` and `mqtts`, and the AMQP
1.0 adapter call `raceLoopback` themselves. They hand the socket it wins to MQTT.js by a stream
builder of Bead's, and to rhea by its `connect` option. The TypeScript side reads a host once by `urlHostOf`, and the C# side by
`TransportSecurity.DialedHost`. No public member is added on any side
([0047](0047-every-side-shows-one-public-surface.md)).

## Consequences

- **A deployment that maps a `.localhost` name elsewhere** through a hosts file or a container's
  `extra_hosts` reaches the loopback instead, on every dialer a side owns, and its failure says that
  it went to the loopback and asked no resolver. It names its host by its own name or address.
- **A server given `::1` alone** pays 250 ms per connect by `localhost`, a Bead server given `::1`
  or Node's `listen('localhost')` on Windows among them (0024), and a process on `127.0.0.1:p`
  pre-empts it for every Bead client over a dialer it owns. 15.12 and 0024 state the residual of
  each single-family server.
- **The C# MQTT 5 and AMQP 1.0 adapters race a name's families**, as the C# WebSocket and HTTP
  clients do, through Bead's connect, and pay no two seconds a connect by `localhost`.
- **The TypeScript side in Node without undici** keeps Node's global `fetch` and `WebSocket` for its
  default dialers, and with them its platform's resolver for a localhost name and, under
  `NODE_USE_ENV_PROXY`, the environment's proxy for every host: the row `A host on the loopback
  connected directly, a localhost name asking no resolver`, and for its HTTP client and caller the
  open row `A localhost name over the TypeScript HTTP client and caller in Node without undici`.
  Ahead is a dialer of the TypeScript side's own over `node:http` and `node:https`, so that its HTTP
  client and caller connect the loopback themselves without undici, by a round of its own. A `ws`
  given, MQTT.js and rhea connect the loopback themselves, undici or not.
- **The platform's proxy, for a host off the machine** differs three ways: the C# side's handlers
  read `HttpClient.DefaultProxy`, Node's global dialers read the environment's under
  `NODE_USE_ENV_PROXY`, MQTT.js the SOCKS proxy `MQTTJS_SOCKS_PROXY` names, and the Rust side reads
  none. It is no matter of a credential: under TLS a
  proxy tunnels, and in the clear no credential leaves the machine. It is an open row of
  [`docs/support.md`](../support.md), `The platform's proxy, for a host off the machine`, which one
  behaviour on every side closes, by a decision of its own.
- **The twins**, each naming spec 13.4, on every side (`tools/twins.tsv` classing those one side
  alone has):
  - the connector: `connects a localhost name to the loopback, asking its resolver nothing`,
    `tries the IPv4 loopback first for a localhost name, then the IPv6 one an attempt delay after`,
    `asks its resolver for any other name, localhost with a trailing dot among them`, and
    `says that a localhost name it could not connect went to the loopback, no resolver asked`;
  - the race: `connects by the next family 250 ms after an attempt that has not connected`,
    `cancels the attempts left once one connects`, `keeps an attempt that has not connected by its
    delay while the next one starts, the first to connect winning and the other closed`, and `ends
    every attempt, leaving no socket, once its connect is given up`;
  - a host read once, on each client, caller and broker adapter: `connects a host written
    127.0.0.1. or 127.1 to the loopback, asking no resolver, and names it 127.0.0.1` and `refuses a
    host the URL Standard fails on, foo.123 or x%20.localhost, before any socket opens`; and the
    adapters' tests of a secure link over `mqtts` and `wss`, and over `amqps`, take `LOCALHOST`,
    `127.1` and a percent-escaped host. The C# side's .NET `Uri`, which the MQTT 5 and AMQP 1.0
    adapters' options and the caller take, refuses a percent-escaped host as it parses the URL: the
    platform row `A percent-escaped host in a broker adapter's or a caller's URL` of
    [`docs/support.md`](../support.md);
  - each WebSocket client, HTTP client, caller and broker adapter: `reaches a localhost name on the
    loopback whatever the platform’s resolver answers`, through a seam that stands for the
    platform's resolver, a listener on `127.0.0.1` receiving the connect by `bead-probe.localhost`;
  - on the TypeScript and C# sides' WebSocket clients, HTTP clients, callers and MQTT 5 adapters:
    `sends nothing through the platform’s proxy to a host on the loopback`, a recording proxy set as
    the platform's, or as MQTT.js's own, receiving nothing; on the C# side alone,
    `Sends_a_host_off_the_machine_through_the_platforms_proxy`;
  - on each side's HTTP client: `keeps a localhost name in its Host and its TLS server name while it
    connects the loopback`, under `spec/pki`'s `named-server`, and `negotiates the HTTP version with
    a localhost name that it negotiates with 127.0.0.1`;
  - on the TypeScript side alone: `answers a lookup of one family with that family’s loopback alone`,
    Node's `lookup` callback; `connects to a server on 127.0.0.1 alone with its event loop held past
    the attempt delay`, Node's event loop; in its WebSocket and HTTP clients, `reaches a host on the
    loopback through undici’s own dialer where undici resolves, and through Node’s global one where
    it does not`; and in its WebSocket client, `reaches a localhost name on the loopback whatever
    the platform’s resolver answers, over ws`, a `ws` given.
- **Its gates**: the twins on every side, the race's and a host's read once among them,
  `tools/check-twins.mjs`, and `spec/units.txt`'s 13.4 and 15.12, acknowledged where their text
  moves.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
two rounds at xhigh effort. The first also revised
[0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)'s answer to
its row on a client's `localhost`. Each claim was checked against each side's code and by probes of
Node, undici, .NET, MQTTnet and AMQPNetLite. Ten objections: eight accepted, two in part, none
refused. Two questions went to the user. The first, undici and the TypeScript package, was taken as
neither option drafted, a connect failing without the package or the package a dependency: undici
stays an optional peer, and without it Node's global dialers connect, judged by name. The second,
the platform's proxy for a host off the machine, was taken by its recommendation: an open row, its
closing a decision of its own. The second round, on the race kept and the host read once, is shared
with [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md),
[0055](0055-beadcs-image-is-published-at-each-release-under-its-version-attested-and-signed.md) and
[0056](0056-a-websocket-server-holds-a-message-partway-to-a-budget-and-a-rate-and-every-side-reads-its-frames-at-their-heads.md),
each of which keeps its own objections. Each claim was checked against each side's code, undici
8.12.4 and `ws` 8.23.0, and by probes. Four objections here: three accepted, one of them carried
further, and one in part, none refused. No question went to the user. The objections, with the
answers that hold:

### On a client's connect of the loopback's names

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1.** A proxy is the second way a loopback-judged connection leaves the machine. Under an HTTP proxy the connect never sees the target. .NET's default proxy took `api.localhost`, `localhost`, `127.0.0.1`, `127.0.0.2` and `[::1]` with their `Authorization`, and `NO_PROXY=localhost,127.0.0.1,::1` still proxied three of them. Node's global `fetch` under `NODE_USE_ENV_PROXY=1` did the same. The comment on the C# handler says "no proxy". Checking the peer address fails against a proxy on the loopback. | **Accepted**, as an invariant: a client connects a host it judges on the loopback directly, to the loopback, through no proxy and, for a localhost name, no resolver. The C# side sets a `LoopbackBypassProxy` on every `SocketsHttpHandler` it builds, the MQTT adapter's WebSocket among them. It keeps the platform's proxy for a host off the machine, since `UseProxy = false` would change that too. The comment is corrected. The TypeScript side reaches a host on the loopback through undici's own `fetch` and `WebSocket` with an `Agent` of its own where undici resolves, which goes direct under `NODE_USE_ENV_PROXY=1` (probed). A twin on each side holds it: a recording proxy set as the platform's receives nothing. The three-way divergence for a host off the machine is an open row of `docs/support.md`, closed by a decision of its own. |
| **O2.** The TypeScript side's default dialers in Node take no `lookup`. Their only hook is an undici `Agent`, which Node does not export and which comes from an optional peer loaded only under TLS. Rewriting to the literal loses the name.                                                                                                                                                                                                                                                                          | **Accepted.** Where undici resolves, the side uses undici's own `fetch` and `WebSocket` (`new WebSocket(url, { protocols, dispatcher })`) with an `Agent` of the client's, whose `connect` races the loopback and hands the socket to undici's own connector under TLS (O11), for every host judged on the loopback, as the TLS path does. Probed: the upgrade and the `POST` reach the target with `Host: api.localhost:p`, and the proxy sees nothing. undici stays an optional peer, as 0053 set it. Where it does not resolve, Node's global `fetch` and `WebSocket` connect, a dialer the side does not own, judged by name; 13.4 states the residual and a platform row of `docs/support.md` the difference, a twin showing each path taken.                                                                                                                |
| **O3.** "Every dialer Bead owns" splits three ways: Bead's own, libraries' with differing hooks, and the application's. The list misses the generated client's caller, counts the relays, which dial nothing, and says nothing of a dialer the application gives.                                                                                                                                                                                                                                                       | **Accepted.** This record lists every dialer with its hook, the C# `HttpCaller` and the TypeScript caller among them; the relays dial nothing. One claim is corrected: MQTTnet over a WebSocket has a hook. `IMqttClientAdapterFactory` is public, and the adapter already has one (`GuardedAdapterFactory`). A channel of Bead's that connects a `ClientWebSocket` through Bead's handler reached the listener with `Host: api.localhost:p` (probed). A dialer the application gives is judged by name, as Secure Contexts reads one under the draft's section 5.1, and so are Node's global dialers where undici does not resolve; 13.4 and each option's documentation state the residual. So 13.4's residual narrows to those dialers and does not go.                                                                                                        |
| **O4.** "The browser applies Secure Contexts itself" misreads Secure Contexts. It judges a page's origin, not a URL a page opens. Bead's client in a page judges `ws://api.localhost` secure by name, and Secure Contexts' own trust holds only for a user agent that follows the draft's resolution rules.                                                                                                                                                                                                             | **Accepted.** In a page, and in a Web Worker, the client keeps reading the name, under the draft's section 5.1. 13.4 states the residual for a user agent that does not follow those rules, a resolver that sends the name on, or a proxy. The browsers' behaviour the dissenter cites is not carried as fact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **O5.** "127.0.0.1 then ::1, or Happy Eyeballs" cannot stay an "or". A sequence costs two seconds on .NET under Windows. The C# broker libraries pay it, so "every Bead client races" is false. IPv4 first departs from RFC 6724 and reverses Windows' order.                                                                                                                                                                                                                                                           | **Accepted.** Every dialer races, as RFC 8305 asks, with an attempt every 250 ms. The C# broker adapters race too, through Bead's connect: MQTTnet's `StreamProvider` and a `TransportProvider` of AMQPNetLite's. `127.0.0.1` goes first because a Bead server on its defaults listens there, and a server given `127.0.0.1` alone cannot be pre-empted by a process on `[::1]:p` for a Bead client over a dialer it owns. The departure from RFC 6724's default table is named in 13.4 and here, and its cost is stated: 250 ms per connect against a server on `::1` alone. 0024's "every Bead client races" holds and cites this record. Its residual is revised in 0024 and 15.12: a server given `::1` alone is pre-empted by any process on `127.0.0.1:p`.                                                                                                  |
| **O6.** The standards are miscited. The draft is expired and is cited as a standard, RFC 6761 §6.3 item 2 is only a MAY, and Secure Contexts has two departures, not one.                                                                                                                                                                                                                                                                                                                                               | **Accepted.** 13.4 cites the draft as an expired Internet-Draft, for its section 3, item 2 (a MUST for software that makes a security decision on such a name) and its section 5.1. These are the rules Secure Contexts conditions its trust on. RFC 6761 §6.3 item 2 is cited as what permits it. Both departures, `localhost.` and a name ending in `.localhost.`, are named with 15.12's reason, so a client and a server read one set of names. Aligning both 13.4 and 15.12 with Secure Contexts would keep one set too, and 0024 says the refusal of `localhost.` is no safety; but it changes what every server takes and how it compares a host, on three sides and in the conformance's host cases, a change of 0024's decision that nothing here asks for. The departures are named.                                                                    |
| **O7.** The record changed is the wrong one. The client's loopback reading is 0010's, and 0024's scope says so. A change across many files belongs to a record.                                                                                                                                                                                                                                                                                                                                                         | **Accepted.** This record holds the connect and this table. 0010 keeps the judgement and points here. 0024 points its scope and its row on a client's `localhost` here, keeps its race, and revises its residual. 15.12's residual on a page's user agent stays: it is a page's rebinding, not a Bead dialer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **O8.** A test through the platform's resolver proves nothing on Windows, which answers `api.localhost` with the loopback, and a test of the connector alone does not reach the dialers that bypass it.                                                                                                                                                                                                                                                                                                                 | **Accepted.** Each side has a connector twin through its resolver seam (`RacingOptions.resolve`, `HappyEyeballsOptions.Resolve`, the lookup), asserting that a listener on `127.0.0.1` accepts and the seam is never asked. Each dialer has an end-to-end twin through a seam that stands for the platform's resolver: the TypeScript tests replace `dns.lookup`, which `net`, the global `fetch` and `ws` all ask; the C# side adds an internal `HappyEyeballs.PlatformResolve`; the Rust side hands each client its `RacingOptions`. The proxy twins run alike on every OS. Every seam is internal, so the public surface does not change (0047).                                                                                                                                                                                                               |
| **O9.** Deployments the change breaks must be told why. A `.localhost` name that a hosts file or `extra_hosts` maps elsewhere now reaches the loopback and fails with no reason. curl keeps an override, `--resolve`; Bead offers none.                                                                                                                                                                                                                                                                                 | **In part.** A changelog line says it. A failed connect by a localhost name says it went to the loopback and asked no resolver, and a twin holds that on each side. 13.4 says no option points such a name elsewhere: a host off the machine is named by its own name or address. That Bead offers no override is true of its own dialers only, since a handler, a `fetch` or a WebSocket the application gives connects as the application likes, under the residual stated.                                                                                                                                                                                                                                                                                                                                                                                     |
| **O10.** A simpler design was passed over. Only the clear needs the loopback for 13.4, and MQTT over TCP and AMQP carry no `Host`. So scope the hardening to the clear, hand those libraries the literal `127.0.0.1`, and judge in the clear where no hook exists.                                                                                                                                                                                                                                                      | **In part.** The premise holds: 13.4 needs the loopback only in the clear, and MQTT over TCP and AMQP carry no `Host`. The scheme split is refused. The connectors that carry the rule take no scheme, a name's destination should not depend on its scheme, and every hook proven for the clear carries TLS. The literal is refused: it drops `::1` and the race that the Rust side's MQTT 5 link gives, which would be a divergence, and the hooks are public, their connects probed end to end, what follows a connect held by each adapter's suite. No dialer Bead owns lacks a hook, so none is judged in the clear.                                                                                                                                                                                                                                         |

### On the race kept and the host read once

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O11.** The proposal's connector for a localhost name races the TCP socket, then lays TLS itself. That offers no ALPN, so every undici client speaks HTTP/1.1 to `localhost` and HTTP/2 to `127.0.0.1`, and it drops undici's session cache, keep-alive, `setNoDelay`, high-water mark and 10 s connect timer. Build on undici's own connector: on `https:`, `buildConnector(tls)` given the raced socket as `httpSocket`; on `http:`, keep-alive and `setNoDelay` set as undici sets them. | **Accepted, and carried further.** Verified: undici's `lib/core/connect.js` offers `h2` by ALPN (`:76`, `:98`), keeps a session cache (`:85-108`), sets keep-alive and `setNoDelay` (`:141-149`), and lays TLS over a socket it is given as `httpSocket` (`:99`), which it refuses on `http:` (`:110`); probed, a localhost name negotiates HTTP/2 through undici's connector and HTTP/1.1 through one that lays TLS itself. The race's attempts also take the 64 KiB high-water mark undici sets on `http:` (`:115`). The principle reaches every path: `ws`'s `wss` hands the raced socket to `tls.connect` with the options `ws` built, the MQTT 5 adapter to its own mirror of MQTT.js's TLS, and rhea to its own. A twin on every side: `negotiates the HTTP version with a localhost name that it negotiates with 127.0.0.1`. |
| **O12.** The race has no bound of its own, and the signal the proposal gives it cannot reach undici's or `ws`'s path. A connect given up leaves both attempts running until the kernel ends them, about two minutes on Linux by `tcp_syn_retries`. Give the race a timer: undici's 10 s, `ws`'s `options.timeout`, the brokers' remaining `connectTimeout`; fail with an error `isConnectFailure` reads; add a twin.                                                                         | **In part.** Verified: undici calls a connector with no signal (`connect.js:77`), and `ws` hands `createConnection` its request options. But Bead's WebSocket client passes `ws` no `handshakeTimeout`, so `options.timeout` is undefined there. That `createConnection` is built per connect, so it closes over that connect's own signal and the time its `timeout` leaves. The shared undici `Agent` takes a timer of 10 s, undici's own; the brokers, the time their `connectTimeout` leaves. At the bound every attempt still open counts a `connect ETIMEDOUT` of Node's shape, so 13.4's sentence comes. The twin is on every side: `ends every attempt, leaving no socket, once its connect is given up`.                                                                                                                   |
| **O13.** 13.4's "its client refuses it as it is built" is false on every side: a transport client gets its host at each connect, and the C# side refuses no such host. The C# side would also newly refuse hosts .NET dials, such as `ws://foo.123`, with no twin and no line of the changelog. Say where the refusal falls, refuse in the C# adapters' constructors, add a twin everywhere, and name the C# refusal.                                                                        | **Accepted.** Verified: the Rust side refuses at the connect of its WebSocket and HTTP clients, and its MQTT 5 adapter as it is built; the C# adapters judge a host and refuse none; probed, .NET's `Uri` takes `ws://foo.123` and `mqtt://foo.123` as names and keeps `127.0.0.1.` as given. 13.4 says where the refusal falls, by a broker adapter or a caller as it is built, by a transport client at its connect, each side raising its own kind of error. RFC 3696 §2 keeps a top-level label from being all numeric, so the C# refusal is sound, and the changelog names it. The twin: `refuses a host the URL Standard fails on, foo.123 or x%20.localhost, before any socket opens`.                                                                                                                                       |
| **O14.** The proposal rewrites the C# `Connects_by_the_next_family_…` and `Cancels_the_attempts_left_…` so that their earlier attempt connects late, and the cancellation test no longer pins a pending attempt cancelled. The TypeScript test of an attempt kept needs a seam to hold one attempt back, as the C# side's `Connect` and `Clock` give.                                                                                                                                        | **Accepted.** Verified: `HappyEyeballsOptions` takes its `Connect` and its `Clock`. Both C# bodies stay, and the test of an attempt kept goes beside them on every side: `keeps an attempt that has not connected by its delay while the next one starts, the first to connect winning and the other closed`. `raceLoopback` takes an `attempt` factory and a `clock`. The test of an event loop held past the delay stays the TypeScript side's own, a row of `tools/twins.tsv`.                                                                                                                                                                                                                                                                                                                                                   |
