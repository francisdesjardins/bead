# 0032 — A WebSocket upgrade from no page carries its credential beside every envelope of its connection, and a client follows no redirect

- **Status**: accepted
- **Scope**: the protocol, every implementation's WebSocket transports, both HTTP clients' check of
  a credential's form, and the routers' check of what a transport carries: in
  [`spec/spec.md`](../../spec/spec.md), 15.1's transport credential, 15.2's credential of an upgrade
  and its step 6, 15.5's field value, 15.6's redirect, 13.4's call failed before it goes, and
  14.2's and 14.3's leg B; the cases of `spec/transports.json` on an upgrade's credential; the
  interop's pair on `ELSEWHERE`. What a request presents and how its credential resolves are
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s; the hosts and origins an upgrade
  is judged by,
  [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)'s; a
  refusal told and what a client names of one,
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)'s.

## Context

**One header, two transports.** Over HTTP a call presents `ELSEWHERE` and its client writes the
credential in the `Authorization` of its `POST`
([RFC 9110 §11.6.2](https://www.rfc-editor.org/rfc/rfc9110#section-11.6.2)), so an opaque bearer —
an API key, a token its issuer introspects
([RFC 7662](https://www.rfc-editor.org/rfc/rfc7662)), a session service's — goes as
[RFC 6750 §2.1](https://www.rfc-editor.org/rfc/rfc6750#section-2.1) has a resource server take
one. A WebSocket is opened by an HTTP request, its upgrade
([RFC 6455 §4.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.1)), and the protocol prescribes
no client authentication of its own: a server may use "any client authentication mechanism
available to a generic HTTP server, such as cookies, HTTP authentication, or TLS authentication"
([§10.5](https://www.rfc-editor.org/rfc/rfc6455#section-10.5)), and may refuse 401 with its
`WWW-Authenticate` ([§4.2.2](https://www.rfc-editor.org/rfc/rfc6455#section-4.2.2), item 2). A
transport that reads no `Authorization` on its upgrade leaves such a bearer no way but a payload,
and an operator's proxy that authenticates at the edge — Envoy's `ext_authz`, an API gateway — and
passes `Authorization` upstream reaches a server that reads none of it.

**A page's upgrade carries its browser's authentication.** The
[WHATWG WebSockets Standard](https://websockets.spec.whatwg.org/) gives a page a constructor that
takes a URL and protocols and writes no field of the script's choosing, and builds the upgrade with
credentials mode `include` and redirect mode `error`: the browser sends the page's cookies, and
[Fetch](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)'s HTTP-network-or-cache fetch
appends the request's authentication entry as `Authorization` when the request has none. Measured
in Chromium 153 and Firefox 155: a user authenticates once, Basic, to a server's
`http://127.0.0.1:p/private`; a page of that origin and a page of another each open a WebSocket to
the server, and the browser writes `Authorization: Basic …` on all four upgrades, no script writing
it. No CORS guards an upgrade, so a page of any origin a server takes would present its user's
credential, the cross-site WebSocket hijacking a cookie brings, which a server judges by the
`Origin` alone ([RFC 6455 §10.2](https://www.rfc-editor.org/rfc/rfc6455#section-10.2)). An HTTP
`POST` from another origin carries no credential unless its server answers
`access-control-allow-credentials`, which no Bead server writes
([0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)).

**What each client writes, probed.** `ws` writes one `Authorization` line from its `headers`
option, and reads a refusal's status and challenge through `unexpected-response`. Node's global
`WebSocket`, undici's, writes nothing through the WHATWG constructor; it takes a `{ headers }`
second argument of its own, which no page has. .NET's `ClientWebSocket` writes one line through
`Options.SetRequestHeader`, with an `HttpMessageInvoker` or without, refuses a value holding CR LF
with an `ArgumentException` before anything goes, and reads a refusal through
`CollectHttpResponseDetails`.

**Redirects.** `ClientWebSocket`, through an invoker whose handler leaves `AllowAutoRedirect` as it
comes, follows a 302 answered to its upgrade, to the same host and to `localhost`, and drops
`Authorization` on the way: the origin reads `Bearer secret`, the target nothing, and the
connection opens at a place its client never judged. With `AllowAutoRedirect = false` it
fails, `WebSocketException`, status `Found`. `ws` as the TypeScript side builds it fails on
`unexpected-response`, and a page's `WebSocket` fails under redirect mode `error`. Both HTTP clients
follow none: the C# handler sets `AllowAutoRedirect = false`, every TypeScript `fetch` passes
`redirect: 'error'`.

**The practice.** Kubernetes' API server takes `Authorization` on an upgrade and, for a browser, a
bearer in a subprotocol. ASP.NET Core SignalR takes a browser's token in the query,
`access_token`, and documents that it is logged; its clients take the token from a function
"called before every HTTP request made by SignalR", where a renewal happens, and its .NET 11
authentication refresh replaces a live connection's credential without connecting again
([SignalR authentication](https://learn.microsoft.com/aspnet/core/signalr/authn-and-authz)). AWS
API Gateway's WebSocket APIs authorize the `$connect` route once, from a header or the query, and
keep the connection past the token. graphql-ws and Socket.IO carry the credential in a first
message of the application's, whose Bead analogue is a call that opens a connection's session, or
a `JWT` in each envelope. A token in the query "SHOULD NOT be used unless it is impossible" to send
it in the header, for "the high likelihood that the URL containing the access token will be logged"
([RFC 6750 §2.3](https://www.rfc-editor.org/rfc/rfc6750#section-2.3)), and "Clients MUST NOT pass
access tokens in a URI query parameter"
([RFC 9700 §4.3.2](https://www.rfc-editor.org/rfc/rfc9700#section-4.3.2)).

### The options weighed

- **No credential on a WebSocket but the envelope's.** A `JWT` works on every transport, a page's
  included, and a client off a browser opens a connection's session by a call (spec 13.1). It
  leaves an opaque bearer to a payload, and reads none of what an edge proxy passes on, for no
  reason RFC 6455 gives.
- **The upgrade's `Authorization` carried beside every envelope of its connection**, as an HTTP
  server carries a `POST`'s beside its request: taken, from an upgrade of no page. 15.1 already
  defines a transport's credential as what `ELSEWHERE` stands for, and both servers' messages carry
  one; the router resolves it per request, by its one verifier, so a credential's end
  ([0010](0010-a-request-presents-a-credential-of-a-scheme.md), 13.11), its verifier's revocation,
  a default withdrawn (13.4) and a credential's session bounding its subscriptions (13.10) hold as
  over HTTP. Its cost: one connection, one credential, which a client renews by connecting again.
- **An upgrade from a page reads its `Authorization` too**, the server's own origin at least, as a
  same-origin `fetch` carries its ambient credential: not taken. A page's browser writes its user's
  cached Basic, Digest or Negotiate authentication on every upgrade it opens, whatever the page's
  origin, and the `Origin` is the one guard; the server's own origin is judged by the `Host` it is
  reached by; a page presents a `JWT` whatever its origin; and one rule with no exception is the
  one a reader holds.
- **A hook that verifies at the upgrade**, `ws`'s `verifyClient` or a Kestrel middleware, refusing
  401 or 403 before the 101 and keeping a verified `ELSEWHERE`, or a session, for the connection:
  not taken, kept ahead by the user. It is a second path to a session, verified once where 13.11
  verifies per call, so a verifier's revocation goes unseen until the end it gave, and ending a
  session by its identifier (13.10) refuses nothing that would be asked again; its end needs a
  timer of its own and a close 1008
  ([RFC 6455 §7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1)); the transport would
  call the router's verifier, across a layer; Node's `shouldUpgradeCallback` is synchronous, so the
  TypeScript server would move to `noServer`; every anonymous upgrade would ask the verifier before
  any socket opens; and a 401 MUST carry a challenge
  ([RFC 9110 §15.5.2](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2)) whose scheme is the
  application's. What it buys, no socket for a credential that does not hold, an operator's edge
  proxy buys before Bead.
- **A 401 for an upgrade that carries no `Authorization`**, nothing verified: it judges nothing a
  101 and a `SESSION_REQUIRED` on the first call do not, refuses every page, and needs its
  challenge as an option. Not taken.
- **A connection's session opened at the upgrade**, `OPAQUE`: its timeouts are 13.7's, not the
  credential's end, so a credential would outlive itself, and the server would announce a session
  its client never asked for. Not taken.
- **The client's credential a string fixed at the connect**, which every reconnection replays at
  the moment it is likeliest past its end: the upgrade verifies nothing, so the reconnection
  succeeds, every `ELSEWHERE` on it is refused `SESSION_REQUIRED`, which withdraws the default
  (13.4), and a reconnection takes no target. A provider called at each attempt, as SignalR's
  `accessTokenFactory` and `AccessTokenProvider` are, renews it where the renewal happens: both are
  taken, a string or a provider. A credential replaced in place on a live connection, SignalR's
  refresh, would need a message of its own on the wire and a second resolution.
- **A cookie, a token in the query, a bearer in a subprotocol**: a cookie is the ambient authority
  of a page's upgrade, guarded by the `Origin` and SameSite alone, and Bead's credential is no
  cookie; a token in the query is what RFC 6750 §2.3 and RFC 9700 §4.3.2 refuse, and every refusal
  a Bead server tells leaves the target out for that reason
  ([0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)); a
  subprotocol is logged by proxies as freely as the URL, and needs a server to select one it does
  not speak. None taken: **a page presents a `JWT`**.

## Decision

**A WebSocket upgrade that carries no `Origin` carries one credential, toward its server alone**
(spec 15.2): its `Authorization`, as it came, whole, its auth-scheme included, its surrounding
whitespace removed, none when the field is empty or absent — the form 15.5 reads a `POST`'s in. The
server hands it to the router beside every envelope of the connection; a request presenting
`ELSEWHERE` stands for it and resolves once per request (spec 13.11), so a credential that no
longer holds, or whose end has come, is refused on the request that presents it, and the connection
stays. Nothing else resolves it: no session at the upgrade, no timer, no close. **An upgrade that
carries an `Origin` carries none, whatever its `Authorization`**: it comes from a page (spec 15.12,
"a request without an `Origin` comes from no page"), and Bead's own clients write no `Origin`.
**An upgrade with two `Authorization` field lines is malformed**, step 6, 400 `malformed`: the field
is no list to combine ([RFC 9110 §5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3)), and
the form is judged before the origin, whether the upgrade carries one or not. Nothing is carried
toward a client: a server's command that presents `ELSEWHERE` over a WebSocket fails before it
goes, `DESTINATION_UNREACHABLE`. No server reads a credential from a target's query, a cookie or a
subprotocol.

**Each side's servers read the field by one function**, `credentialOf` and `CredentialOf`, across
its lines as `X-Forwarded-For` is read, where both server transports reach it; the WebSocket server
adds the `Origin` rule, the HTTP server keeping its own, since 15.12's CORS keeps a page's
credential off another origin's `POST`. The per-connection `carriesCredential(handle)` of a server
is false. Since the upgrade's `Authorization` is a credential, 15.1's "no event … carries that
credential" reaches it: **the TypeScript `connection` event shows the upgrade headers aside**, a
frozen copy of its method, target and remote address and port, as the HTTP server shows a connect;
the C# event carries the handle alone.

**A client writes the credential its connect is given, a string or a provider**: `credential` and
`credentialProvider` on the TypeScript side, `Credential` and `CredentialProvider` on the C# side,
two members of one name on both, not a TypeScript union a C# record cannot mirror
([0004](0004-one-behaviour-in-every-language.md)); both given are refused as the connect is asked.
The provider is called at each attempt, the first connect's and every reconnection's, before its
upgrade goes, with the attempt's signal or token; a provider that throws fails that attempt, its
throw the cause, counted as a refused connect; a value that is no field value fails it as a string
would, never tried again. Written through `ws`'s `headers` and `SetRequestHeader`. **A credential is
refused before it goes**, `ProgrammerError` and `ArgumentException`, the state untouched: one that
is no field value — anything but visible ASCII, spaces and tabs, or a space or a tab first or last
([RFC 9110 §5.5](https://www.rfc-editor.org/rfc/rfc9110#section-5.5)), which both HTTP clients
refuse too (spec 15.5), so both ends compare one form; one over a URL in the clear off the loopback
(spec 13.4), its upgrade being where it would cross; and, on the TypeScript side, one given to a
client whose `WebSocket` constructor has not `ws`'s shape, its prototype without `ping`,
`terminate` and `on` as functions, judged of the constructor before the socket is built and before
a provider is called — a page's `WebSocket`, a wrapper or a subclass of it, and Node's global among
them — its message naming `ws` and the envelope's `JWT`.

**A client follows no redirect** (spec 15.6): a 3xx answered to its connect, to a send or to its
upgrade fails it, its status named, as a page's `fetch` under redirect mode `error` and a page's
WebSocket fail. The C# WebSocket client's handler sets `AllowAutoRedirect = false`, on `Racing` and
every invoker it builds, as the HTTP client's does; the TypeScript client passes `ws` no
`followRedirects`, a `// !` comment saying why. What 13.4 judges of the URL given is then where the
socket is, and a connection carries only bytes its server read.

**A call is checked against what its connection carries**: the client transport's predicate over
the credential, `carries(credential)` and `Carries(credential)`, named as no boolean is, so that no
truthiness test reads the function as true. Over HTTP it holds for a field value; over a Web
Worker, never; over a WebSocket, when the upgrade of its current connection carried those bytes,
and not before its first connect. It compares **in constant time**,
as 9.2 step 5 compares a session token and 13.8 step 7 an `HS256` signature: on the TypeScript side
every character of the carried credential read whatever the two differ in, the lengths folded in,
synchronous and free of `node:crypto`, since the module loads in a page; on the C# side
`CryptographicOperations.FixedTimeEquals` over the two ASCII spellings. Time tells at most the
carried credential's length. A client's call presenting `ELSEWHERE` over a WebSocket whose upgrade
carried other bytes, or none, fails before it goes, `DESTINATION_UNREACHABLE`, its detail naming
the scheme alone (spec 13.4); a relay's leg B over a WebSocket asks the same predicate, so it never
presents its own upgrade's credential for a requester's
([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md), spec 14.3 step 5), and the
comparison tells a requester nothing of the relay's credential by its time.

**A renewal over a WebSocket connects again**, the provider handing the new credential, and the
application gives the router's default `ELSEWHERE` the same bytes, both from one source, its token
store, which each README shows. Between the two, a call fails before it goes, told by its scheme;
a default withdrawn by a credential that no longer holds stays withdrawn until the application
gives another, as over HTTP.

## Consequences

**One connection, one credential.** A credential renewed over a WebSocket is a new connection: the
subscriptions of the one it leaves end, so a long-lived subscriber presents a `JWT`, which renews in
its envelope and keeps them (spec 13.10). The application keeps the router's default and the
provider in step, and a call between them is told.

**A page presents a `JWT`.** A page's upgrade carries no credential Bead takes, so a browser's user
authenticated at an edge proxy — one that writes `Authorization` from its cookie — gains nothing
below it. A server's DevTools panel masks nothing new: the trace shows a header's scheme alone
(`debugging.md` 5.1), and the credential never enters an envelope.

**An HTTP connect's `Authorization` stays read by no one** (spec 15.5), each `POST` carrying its
own, where a WebSocket's upgrade is the one place its connection carries one; the case that proves
the connect's ignored stands beside those that prove the upgrade's read.

**A server that moved is reached by its new URL alone**: a client given the old one fails its
connect on the 3xx, and its application gives the connect the URL the server moved to.

**Ahead, each by a decision of its own that meets the Tenth Man**: a hook that verifies at the
upgrade and refuses before the 101, which the user kept ahead, bound by this record's rule on an
upgrade that carries an `Origin` should it come; and a credential replaced in place on a live
connection, SignalR's refresh.

**The gate.** `spec/transports.json`, over WebSocket, played by both sides: the upgrade's
credential beside every envelope, as it came and trimmed, standing for nothing but `ELSEWHERE`;
none from an upgrade without one or with an empty one; none from an upgrade that carries an
`Origin` the server takes; two `Authorization` fields refused 400 before the origin; an end the
wall clock reached as the verifier settles, the connection staying. Twins by the same sentence
([0004](0004-one-behaviour-in-every-language.md)) hold what no runner plays, a client's above all:
each WebSocket server's `hands every envelope of a connection its upgrade's Authorization, as it
came and trimmed, and carries none toward its client` and `carries no credential from an upgrade
that carries an Origin, its own or one it takes, whatever its Authorization`; each WebSocket
client's `writes the credential it is given on its upgrade, and carries those bytes alone`, `calls
its credential provider at each attempt, a reconnection's included, and carries the bytes it
handed`, `refuses a credential that is no field value, a space or a tab first or last among them,
or over a URL in the clear off the loopback, before its upgrade goes`, `refuses a credential and a
credential provider given together` and `fails its connect on a redirect answered to its upgrade,
naming its status`, and the TypeScript one's `refuses a credential over a WebSocket constructor
without ws's shape, a page's and Node's global among them`, a platform row of `docs/support.md`;
each HTTP client's `refuses a credential with a space or a tab first or last before its send goes`;
each router client's `fails an ELSEWHERE over a transport that carries none before it goes, …`, or
over a WebSocket whose upgrade carried other bytes; and each relay's `answers an ELSEWHERE
DESTINATION_UNREACHABLE over a leg B whose upgrade carried the relay's own credential`. The interop
pair, `an ELSEWHERE goes in each POST's Authorization over HTTP and in its upgrade's over a
WebSocket: whoami answers the sub it names`, is the one test in which one side's client writes the
field and the other side's server reads it.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at
xhigh effort in the round on an upgrade's credential, both loopbacks and the proxies a server
counts, whose rows are kept by the record whose Scope holds each change: both loopbacks in
[0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md), the
proxies a server counts in
[0030](0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md), and here
the upgrade's credential. It met nine objections, each claim checked against the code and the
sources it cites, its probes in Chromium 153, Firefox 155 and .NET 10 read again: eight accepted,
one in part, none refused. The user decided what no standard settles: the hook that verifies at the
upgrade stays ahead, by a decision of its own, the upgrade's credential resolved at each request as
an HTTP one is; and a server counts the proxies its list does not name
([0030](0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md)). Each
objection, with the answer that holds:

### On the upgrade's credential

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A page's upgrade carries an `Authorization` after all: WHATWG builds it with credentials mode `include`, and Fetch appends the browser's cached Basic, Digest or Negotiate authentication; measured in Chromium 153 and Firefox 155 from the server's origin and from another. The server would take a user's ambient HTTP authentication as `ELSEWHERE` for every page step 7 takes, the cross-site WebSocket hijacking a cookie brings, which CORS keeps off an HTTP `POST` (O1) | Accepted: an upgrade that carries an `Origin` carries no credential, whatever its `Authorization`; only one from no page does (15.12), and Bead's clients write no `Origin`. 15.2 states it, citing Fetch. A case plays a taken origin with `authorization`, `ELSEWHERE` answered `SESSION_REQUIRED`, no credential came, and a twin on each server plays the server's own origin. Taking the server's own origin besides: not taken — one rule with no exception, and a page presents a `JWT`. The rule binds the verifying hook, should it come.                                                                                                         |
| The C# WebSocket client follows a 3xx answered to its upgrade (`Racing` leaves `AllowAutoRedirect` true), dropping `Authorization` on the way, where the TypeScript client and both HTTP clients refuse redirects: `carries` would hold for bytes the server never read, and `IsSecure`, judged from the URL given, could say secure of a socket taken off the machine (O2)                                                                                                        | Accepted: `Racing` sets `AllowAutoRedirect = false`, the one invoker an application reaches, `Invoker` being the tests'; 15.6 states that a client follows no redirect, a 3xx answered to its connect, a send or its upgrade failing it, its status named, as WHATWG's redirect mode `error` does; a twin on both clients.                                                                                                                                                                                                                                                                                                                                 |
| A credential fixed at the connect is replayed by every reconnection, the moment it is likeliest dead: the reconnection succeeds, every `ELSEWHERE` is refused and the default withdrawn, `reconnect` takes no target, and only a disconnect and a connect recover, ending every subscription (O3)                                                                                                                                                                                  | Accepted: the connect takes `credential`, a string, or `credentialProvider`, a function called at each attempt, a reconnection's included, with the attempt's signal or token, on both sides, name for name, both together refused. A provider's throw fails its attempt; a value that is no field value fails it as a programmer's error, never tried again. The READMEs show the renewal: connect again, the provider handing the new credential, the router's default given the same bytes from one source; a call between the two is told. A credential replaced in place on a live connection, SignalR's refresh, is ahead, by a decision of its own. |
| The interop pair, the one place one side's client meets the other side's server, and two doc comments still state the rule reversed: "an ELSEWHERE goes over HTTP alone … over a WebSocket it fails before it goes" (O6)                                                                                                                                                                                                                                                           | Accepted: the pair is "an ELSEWHERE goes in each POST's Authorization over HTTP and in its upgrade's over a WebSocket: whoami answers the sub it names", each client given the credential at its connect against the other language's interop server; each side's `send` documents the rule.                                                                                                                                                                                                                                                                                                                                                               |
| The TypeScript refusal over the platform's global `WebSocket` tests identity: a wrapper or a subclass of a page's passes, the browser ignores the third argument, and `carries` holds for bytes never written, a silent fallback; it also levels Node's global down without naming it (O7)                                                                                                                                                                                         | Accepted: a credential is refused unless the constructor has `ws`'s shape, its prototype with `ping`, `terminate` and `on`, the test the client makes of a socket's beat, checked before the socket is built and before a provider is called, a `ProgrammerError` naming `ws` and the envelope's `JWT`. The platform row reads "written over a `ws`-shaped constructor; refused over any other, a page's and Node's global among them"; undici's call shape is no standard, so no "Leveled down" row follows.                                                                                                                                              |
| On a relay, `carries` compares bytes a requester chose with the relay's own upgrade credential octet for octet, where 13.8 holds secrets to constant time; and the client compares the untrimmed string where the server trims, so `' Bearer x'` beside a default `'Bearer x'` fails calls the server would take (O9)                                                                                                                                                              | Accepted: the comparison is in constant time on both sides, every character of the carried credential read wherever the two differ, as 9.2 step 5 compares a session token (TypeScript, free of `node:crypto` since the module loads in a page) and `CryptographicOperations.FixedTimeEquals` (C#), time telling at most the length. A credential with a space or a tab first or last is no field value (RFC 9110 §5.5): every client refuses it before it goes, the HTTP clients too (15.5), so both ends compare one form.                                                                                                                               |
