# 0010 — A request presents a credential of a scheme, in the header's last block, and runs in the session it resolves to

- **Status**: accepted
- **Scope**: the protocol, every implementation, the relays and the transports

## Context

A call reaches sides that never drew its session. A relay passes it to a destination behind it; an
HTTP façade takes it from a client whose `Authorization` field holds its credential; a broker hands
it to whichever server takes its procedure; a node of a federation runs it on a token it verifies
alone. Each of them has to know from the header whether the call presents a credential and of what
kind, since admission reads the header and never the payload (spec, section 9.2, step 5), and a
relay passes the payload on undecoded (section 14.2).

A block of 16 bytes holds a token a server draws and announces on an answer, and serves a connection
that is its session. It cannot hold a signed token, nor say that the transport holds the credential:
a relay cannot tell a call that presents a credential from one that does not, and a call whose
credential its next transport cannot carry crosses without it, in silence.

Five shapes were weighed:

- **A block of its own for a signed token, beside the 16 bytes**, spends the last free bit of the low
  nibble on a second block that says what the first says, who the call is for, and leaves the
  transport's credential a third.
- **The credential at the head of the payload** keeps the header's length fixed, but admission would
  read the payload, a relay would decode what it passes on, and a transfer's first bytes would carry
  it.
- **The credential in the transport alone**, as HTTP carries `Authorization`, leaves the wire silent:
  a relay cannot tell a call that presents one from one that does not, and moves one onto a
  transport that carries nothing.
- **A block of variable length first of the blocks** moves DESTINATION and TRANSFER, which every
  reader finds at offsets the flags give ([0001](0001-the-envelope-sits-at-fixed-offsets.md)).
- **A length on one byte** holds 255 bytes, short of a signed token: a JWT signed by HMAC-SHA256 with
  a few claims is some 200 to 300 bytes, one signed by RSA some 500 to 900.

**RS256 in the block**, for a provider's access token as it was issued, was weighed too, since
RFC 9068 §2.1 requires it of every resource server. Under a key of 2,048 bits its signature is 342
characters, against 86 for ES256, and with RFC 9068's header, its `kid` a thumbprint of 43
characters (RFC 7638), it leaves some 403 bytes of claims where ES256 leaves some 595: a token with
the required claims alone fits, at some 760 characters, and one with `scope`, `sid`, `email` and
`name` besides does not, at some 1,016, so a provider that adds a claim would move every call of its
users from taken to refused. It brings RSA's keys besides, whose bounds the platforms check each
their own way, and a verdict they do not give alike: .NET on Windows takes a DigestInfo without its
NULL that every other platform refuses, and three platforms take a forgery under an exponent of 1.

## Decision

**The CREDENTIAL block carries a credential of a scheme, and it is the header's last block.**
CREDENTIAL takes bit `0x08`, the last of the low nibble, and `0x01` is kept for a block to come:
DESTINATION (`0x02`) and TRANSFER (`0x04`) stay at the offsets the flags give, and the one block
whose length varies comes after every other. The block is laid out as a TLS extension is (RFC 8446
§4.2): its credential scheme on 2 bytes, its length on 2, the credential's bytes, then zero bytes to
the next 4-byte word, since byte 3 counts the header in words. A header's length follows from its
kind, its flags, and, with CREDENTIAL, the length its block states.

**A credential scheme names a format**, as HTTP's authentication scheme does (RFC 9110 §11.1), so a
side never reads the bytes to learn what they are. It is a _credential scheme_: _type_ belongs to
media types and to each language's types, byte 1 is the _kind_, and a bare _scheme_ is a URI's
([0003](0003-one-word-one-meaning.md)). Its 0 names nothing, as a call id or a procedure id of 0
does.

| Scheme      | Name        | Length                      | On a request                                                         | On a result or a failure                      |
| ----------- | ----------- | --------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| 0           | `NONE`      | 0                           | malformed                                                            | the connection's session ended                |
| 1           | `OPAQUE`    | 16, never all zero          | the token of its connection's session                                | its connection's session's token, newly drawn |
| 2           | `JWT`       | 1 to what the header leaves | an access token of RFC 9068, in JWS Compact Serialization (RFC 7515) | malformed                                     |
| 3           | `ELSEWHERE` | 0                           | the credential its transport carried with it                         | malformed                                     |
| 4 to 65,535 | to come     | 0 to what the header leaves | read whole, then refused at admission, `CREDENTIAL_UNSUPPORTED`      | malformed                                     |

A length that is not its scheme's, padding that is not zero, or a block that runs past the header's
length makes the envelope malformed: `ENVELOPE_MALFORMED`, at step 7 of section 5.1.

**A header carries it as `credential`, `Credential`**, on a request, a result and a failure alike,
one field of one type on both sides: `{ scheme, … }`, its credential scheme and its bytes.

**The header holds 1,020 bytes**, the 255 words byte 3 counts, and a credential has what the rest
leaves: 992 bytes on a request that names a destination and opens a transfer (28 bytes of prefix,
service and procedure, destination, total and the block's own head), 1,004 on one that does
neither. The limits hold such a header: a side that takes or presents a `JWT` sets `chunkBytes` and
`maximumEnvelopeBytes` to 1,024 bytes at least (section 12.2), and a transfer's opening carries one
byte of its payload at least (section 12.3). A writer whose header leaves its payload no room fails
the call before it goes, with `ENVELOPE_TOO_LARGE`, the code its reader would answer. A token past
what the header holds is exchanged at the edge for one that fits, or for a session of the server's,
as OAuth's token exchange does (RFC 8693).

**A session is what a call runs in, and comes in two kinds.** A _connection's session_ belongs to a
server's connection: a request opens one — a procedure that checks credentials, say — and the server
keeps it with its token, its data and its timeouts, and announces it (section 13.3). A _credential's
session_ is what a verifier makes of a credential a request presents, `JWT` or `ELSEWHERE`: an
identifier, its data and its end, kept per connection and identifier for the calls and the
subscriptions it admitted, never announced. A call presenting none runs in its connection's session,
in none when the connection has none; one presenting `OPAQUE`, in its connection's session, whose
token it carries; one presenting `JWT` or `ELSEWHERE`, in a credential's.

**The inactivity timeouts of section 13.7 are a connection's session's.** A credential's session has
none: no message, listen or silence moves its end, and it ends when its end comes, once the
application ends it, or with its connection. A message of the connection starts its connection's
session's timeouts anew, whatever session its call runs in. A connection without a connection's
session — none yet, or its session ended, whatever credentials its calls present — takes the
server's own connection timeout ([0012](0012-a-listen-held-is-not-silence.md)).

**A request runs in its call's session, which its admission reads and its resolver receives.**
Within step 5 of section 9.2, in this order:

1. **a credential scheme the side takes none of** — one to come, or one it has no verifier for — is
   refused `CREDENTIAL_UNSUPPORTED`, the admission block's code 36, whose detail SHOULD name the
   schemes the side takes, as a 401 names its own in `WWW-Authenticate` (RFC 9110 §11.6.1): the
   requester presents another, where `SESSION_REQUIRED` would send it to authenticate again;
2. **the credential resolves to a session**: none, to its connection's session if it has one;
   `OPAQUE`, to its connection's session when the token is that session's, compared in constant
   time; `JWT`, to the session its claims carry once it verifies (below); `ELSEWHERE`, to the
   session the side's verifier makes of what the transport carried. A credential that does not
   resolve, or an `ELSEWHERE` whose transport carried nothing, is refused `SESSION_REQUIRED`, whose
   detail SHOULD say whether no credential came or one came and did not hold. A verifier that fails
   — it throws or rejects, its key set cannot be reached — refuses with `PROCEDURE_FAILED`,
   reported, as an admission that fails does, and never with `SESSION_REQUIRED`, which would
   withdraw a credential that holds;
3. **its admission**, `beforeRequest`, synchronous, decides on the call's session.

`requireSession`, and a relay's default admission, test the call's session, never the connection's:
a call that presented a `JWT` is not in its connection's session, whatever that session holds.

**Resolution may wait.** A `JWT` verified by Web Crypto, a key set asked for a `kid` not yet seen, a
session service asked whether a token holds: a verifier settles later, a `PromiseLike` on the
TypeScript side, a `ValueTask` on the C# side. While it does, its request holds its call id (step 2
of section 9.2 refuses another on it); a cancel ends it, answered by nothing, and tells its verifier
by its signal (section 10.2), as its connection closing does; a transfer's opening gets no credit
until resolution and admission settle (section 12.3); and the call runs in the session it resolved
to, whatever befell its connection's meanwhile. A request that presents none or `OPAQUE` resolves in
the turn it came, so a call that waits on no verifier keeps its order.

**A credential that does not hold is refused, whatever the procedure requires**, with
`SESSION_REQUIRED`, as a bearer token found invalid is answered 401 (RFC 6750 §3.1); `ACCESS_DENIED`
says that a session holds and is not allowed. A call never runs outside the session it presented.
The client's side keeps that from refusing the calls that renew a credential:

- a client presents `OPAQUE` only on a call that asks for it, never by default: it binds that call
  to the session the client knows, so a call made in a session that ended, or that was opened anew
  under a new token, is refused rather than run in whatever session the connection holds;
- a credential a client presents by default, `JWT` or `ELSEWHERE`, is withdrawn once a call that
  presented it is refused `SESSION_REQUIRED`, and the client tells its application, so the call that
  renews it goes out without it; a call may present none, whatever the default;
- a client fails a call presenting `ELSEWHERE` before it goes when its transport carries no
  credential, and a server a command alike, with `DESTINATION_UNREACHABLE`, as a relay refuses a
  call its leg B cannot carry: nothing was tried, and the credential stays.

A client that receives a command resolves the command's credential the same way, the session it
learned standing for its connection's.

**A `JWT` is an access token of RFC 9068's profile, verified one way on every side**, as RFC 8725
recommends:

- **its type**: its `typ` is `at+jwt` (RFC 9068 §4, RFC 8725 §3.11), so a token of another kind
  from the same issuer is refused (RFC 8725 §3.12): an ID token, which an issuer signs with the same
  key and sends inside a URL (OpenID Connect Core 1.0 §3.1.2.1);
- **its key**: the application gives each key with its issuer and its one algorithm (RFC 8725 §3.1):
  ES256, for keys a federation shares by their public half, or HS256, for one trust domain. A
  token's `alg` is its key's, so `none`, an algorithm no key takes, and an HS256 token keyed with a
  public key's bytes are refused. A key is found by the token's `kid` among the application's keys:
  without a `kid`, only when its issuer has one key; for a `kid` they do not name, the runtime asks
  the issuer's key set, when the application gives one, once a minute at most for that issuer, a
  deadline on the monotonic reading
  ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)), and a `kid` still unnamed is
  refused, never tried against the others. The runtime fetches nothing itself: a token's `jwk`,
  `jku`, `x5u` and `x5c` are never read (RFC 8725 §3.10), and a token that carries `crit` is
  refused. A JWK serves only when its `alg` is its key's algorithm, or is absent and the application
  names it, its `use` is `sig` or absent, and its `key_ops`, when present, include `verify`
  (RFC 7517 §4.2 to §4.4);
- **its claims**: `iss` required and equal, octet for octet, to its key's issuer (RFC 8725 §3.8);
  `exp` required, the token holding while the wall clock is before `exp` plus 60 s, and `nbf` read
  when present, the token holding from `nbf` less 60 s (RFC 7519 §4.1.4, §4.1.5); `aud` required,
  naming the receiver's audience (RFC 7519 §4.1.3). The 60 s is a leeway for clock skew, a constant
  on every side that the verdict vectors pin, never an option;
- **its session**: its identifier is the pair of its `iss` and its `sid`, else of its `iss` and its
  `sub`, since a subject is unique within its issuer alone (RFC 7519 §4.1.2), and its end is `exp`
  plus 60 s, the instant its verdict uses, since a skew moves an end as much as a start.

The keys and the audience are the application's; the verifying is the runtime's. Another format, a
CWT (RFC 8392) for a constrained peer, takes a scheme to come.

**A credential's session ends on a timer that reads the wall clock again at each step**
(section 13.8), on the clock its side runs on
([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)):

- its end, _E_, is a whole number of milliseconds since the epoch: for a `JWT`, _X_ + 60,000, where
  _X_ = ⌈`exp` × 1000⌉, the claim read as an IEEE 754 double, as both sides' JSON readers read it;
  for an `ELSEWHERE`, the end its verifier gives, rounded up to a millisecond. `nbf` is held alike,
  _N_ = ⌈`nbf` × 1000⌉, and a claim that is not a JSON number, or whose milliseconds pass 2⁵³ − 1
  (section 1.2), does not hold;
- the wall clock's reading, _W_, is a whole number of milliseconds since the epoch, a fraction
  dropped, so a comparison with _X_ or _N_ is exact — _W_ is before `exp` × 1000 exactly when it is
  before _X_ — and no fraction reaches a timer;
- as its credential resolves, as a renewal moves _E_, and at each step's due, the side reads _W_
  again, never counting down, and takes _R_ = _E_ − _W_: at _R_ ≤ 0 the session ends then, with no
  timer armed; otherwise a timer of min(_R_, 2³¹ − 1) ms is armed, so an end is never refused for
  its distance;
- a `JWT` holds while _W_ < _E_, and _W_ ≥ _N_ − 60,000 when it carries `nbf`, by one reading of _W_
  taken once its signature verifies, which also arms its first timer, so a token that holds arms
  1 ms at least;
- an `ELSEWHERE` whose end _W_ has reached when its verification settles does not hold:
  `SESSION_REQUIRED`.

A token whose `exp` lies an hour past its verdict arms 3,660,000 ms; one 30 days past,
2,147,483,647 ms, then 444,576,353. A wall clock set by hand takes effect at the next step's due.

**An answer announces its connection's session, `OPAQUE` or `NONE`**, on the next answer after it
changed (section 13.3). The announcement takes 20 bytes, and a side counts them where it sizes an
answer before knowing whether one rides on it: a result that would need a transfer is counted with
those 20 bytes, whether it carries them or not (section 12.1), and a failure's detail is cut to fit
behind 32 bytes of prefix, block and record (section 7.4).

**A credential's session bounds the subscriptions it admitted.** A subscription opened under a `JWT`
or an `ELSEWHERE` credential ends when its session ends — at its end, or once the application ends
it — with a failure on its call id, `SESSION_REQUIRED`, as a connection's session ends the
subscriptions of its connection that no credential's session bounds (section 13.6). A call on the
same connection whose credential resolves to the same identifier moves the session's end to the
later of the two, in whatever order resolutions settle: a credential renewed keeps its
subscriptions. Ending a credential's session by its identifier ends it on every connection that
keeps it, and a credential that still holds opens it anew.

**A transport may carry a credential beside an envelope, both ways**: it hands the router what it
carried with an envelope it took, and carries what the router gives it with one it sends. Over HTTP,
it is the `Authorization` field of the `POST /bead` that carries a request (RFC 9110 §11.6.2), and
no other exchange's is read: two calls of one connection may present two credentials, and a token is
renewed without connecting again, while the connection's token names the connection and nothing
else. A WebSocket and a Web Worker carry none, nor does what a listen brings back over HTTP, a
server's command among it, and a request that presents `ELSEWHERE` on them is refused
`SESSION_REQUIRED`. On a broker, `ELSEWHERE` is the case it is made for: a client authenticates to
the broker, the server never sees that client's connection, and each message reaches it on the
broker's word, carried by the authentication of the connection its client publishes on, or by a
property of the message. A relay that publishes for many requesters carries each one's credential in
its message's property, never in its own connection's authentication, which is the relay's. A
connection the server itself terminates — a WebSocket's upgrade — holds one credential for every
call on it: it opens that connection's session when it connects, by the decision that brings it, and
never stands for `ELSEWHERE`.

**A bearer credential crosses only TLS off the machine.** A side presents a `JWT`, and carries an
`ELSEWHERE`, only over TLS — `wss`, `https` — or within the machine: the loopback, a Web Worker, a
router called in process, as RFC 6750 §5.3 requires of every bearer token. The sender holds it, the
client and a relay's leg B alike, since a server behind a terminator of TLS cannot tell.

**A relay forwards a credential, and its destination verifies it**:

| Leg A presents | The relay                                                                               | Leg B presents                                         |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| none, `OPAQUE` | resolves it to leg A's connection's session, which its admission checks                 | none: leg B's session at the destination (14.7)        |
| `JWT`          | forwards it to a destination whose audience its `aud` names, read without verifying it  | the same bytes                                         |
| `ELSEWHERE`    | forwards it to a destination registered with an audience, over a leg B that carries one | `ELSEWHERE`, its credential moved to leg B's transport |

A destination is registered with the audience it verifies, as a resource is named for a token
(RFC 8707). A relay's default admission admits a call in leg A's connection's session, or one whose
`JWT` or `ELSEWHERE` it may forward; the relay verifies what it forwards besides when its options
ask it to, with its side's `credentials`, a `JWT` against its destination's audience. At step 1 of
section 14.3, a scheme the relay neither resolves nor forwards is refused `CREDENTIAL_UNSUPPORTED`,
and an `ELSEWHERE` that carried nothing `SESSION_REQUIRED`. A call the relay cannot forward — to a
destination of another audience or of none, over a leg B that carries no credential, or in the clear
off the machine — is refused `DESTINATION_UNREACHABLE`, at a step of its own, section 14.3's fifth,
before the limits' step, the sixth: its credential may hold, and its route does not. A call that
presents a credential never runs in leg B's session in place of its own. Leg B's header counts its
credential, call by call, against the smaller of the two legs' limits (section 14.3, step 6).

**A credential stays out of everything a side reports**: no detail, event, trace or log carries its
bytes, nor the transport's field; only its scheme, `credentialScheme`, `CredentialScheme`.

**The surface is named alike on both sides**, the TypeScript side's name before the C# side's:

- `credentials`, `Credentials`, among a server's options, and a client's for the commands it
  receives: a `JWT`'s keys, each with its issuer and its algorithm, and its audience; the key set
  the runtime asks for a `kid` the keys do not name, `keySet`, `KeySet`, which may wait; and an
  `ELSEWHERE`'s verifier, `verify`, `Verify`, given what the transport carried and its call's
  signal, which settles with a credential's session — its identifier, its data, and its end, none
  for a session without one — or with none, when the credential does not hold. The side builds its
  `JWT` verifier from them, as data, on the clock its stack runs on, so no verifier brings a clock
  of its own;
- the call's session, `session`, `Session`, on the request admission reads and on the request a
  resolver receives: none when the call runs in none; its data; and, for a credential's session, its
  identifier and its end;
- `sessionOf`, `SessionOf`, the router's hook asked once per request, with its call's signal,
  between holding its call id and the synchronous `beforeRequest`: it may wait, never for a request
  that presents none or `OPAQUE`. `sessionTokenOf`, `SessionTokenOf`, stays beside it, asked per
  answer and never waiting, for the announcement of section 13.3;
- `requireSession`, `RequireSession`, tests the call's session;
- `endSession(id)`, `EndSession(id)`, ends a credential's session by its identifier;
- `verifies`, `Verifies`, among a relay's options, has it verify what it forwards besides.

**The builder binds to the call's session once resolved.** Its admission vocabulary maps to no
`beforeRequest`, to `requireSession` over `session`, or to a named `beforeRequest`, synchronous,
that reads the session's data. The waiting all happens upstream, in `credentials`: the code the
builder generates never names it, as it adds no clock
([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)).

**The interop service answers from its call's session.** `whoami` admits a call with a session, its
call's, and answers the name that session holds: the name `login` gave its connection's session, or
its credential's `sub`, which RFC 9068 §2.2 requires. `login` opens its connection's session
whatever its call presents, announced `OPAQUE`, its `sessionTimeout` and `connectionTimeout` that
session's alone. `logout` ends its connection's session; it refuses a call in a credential's session
`ACCESS_DENIED`, since `SESSION_REQUIRED` would have its client withdraw a credential that holds,
and a call in none `SESSION_REQUIRED`. `register` takes the audience its destination verifies, and
the service's relay admits what a server's relay admits by default. Its verifier is the runtime's,
under the published test key.

## Consequences

**A request is 32 bytes of header with `OPAQUE`, 16 with `ELSEWHERE`, and 16 plus its token rounded
up to a word with a `JWT`: 316 bytes for a token of 300.** An answer that announces a session is 28
bytes, one that announces its end 12.

**A provider's token enters by exchange, or `ELSEWHERE`.** The block takes the federation's
algorithms alone, ES256 and HS256. A provider's access token, signed with RS256, is exchanged at the
edge for an ES256 one of the federation's (RFC 8693), whose 992 bytes leave some 595 of claims under
RFC 9068's header, or it goes `ELSEWHERE`, whatever its size. The HTTP façade turns
`Authorization: Bearer` into a `JWT` in the block when the token is the federation's, and exchanges a
provider's, or keeps it `ELSEWHERE`. RS256 can come back by a decision of its own, which revises
`0xA1` in place while nothing is published
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).

**One block of variable length, and only one.** It takes the last bit; a second would need a layout
of its own ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)). A credential
past 992 bytes never travels in the header, and an answer announces no `JWT`: a federation that
hands one out on an answer changes this record.

**A destination receives a bearer credential that is not its own**, worth whatever its audience
allows: the relay forwards a `JWT` to its audience alone, and the destination verifies it. Tokens
bound to their sender (RFC 9449, RFC 8705) are the federation's to weigh.

**A page presents `ELSEWHERE` to its own origin only.** `Authorization` is not a header CORS lets
through without a preflight, and the HTTP transport answers none.

**A connection whose calls all present a `JWT` or an `ELSEWHERE` is its server's to time.** It has
no connection's session to give it timeouts of its own: over HTTP it holds by listening, silence
counting against the server's own 30 s only between listens (section 15.12); over a WebSocket, by
speaking now and then, unless the server's own timeout is without end.

**A verifier slower than a transfer's inactivity times out the opening it holds.** While its
credential resolves, a transfer's opening gets no credit, and its requester counts the transfer's
inactivity meanwhile (section 12.8): a verifier slower than 30 s, by default, ends the call at its
requester.

**Resolution waits on both sides**: the order of section 9.2, a cancel during resolution and a
transfer's first credit are stated, and played by a conversation whose verifier settles late.
Verifying a `JWT` costs no dependency: Web Crypto on the TypeScript side, in Node and in a browser
alike; `ECDsa` and `HMACSHA256` on the C# side; a key imported from its JWK, JSON and base64url on
both; and a key set is the application's to fetch.

**The relays' table plays in the conversations, and `Authorization` in the transports' file**
([0004](0004-one-behaviour-in-every-language.md)): a conversation carries a relay across its
connections, and what turns on leg B's transport — `Authorization` over HTTP, none over a WebSocket
— plays over real sockets, since a rule that a side's own tests alone check is the weak one.

**What lands with this record**, in one change:

- the spec: sections 4.1 to 4.4 and 4.10; 7.4; 8, its code 36; 9.2; 10.2; 12.1 to 12.3; 13.1, which
  states the two sessions, and 13.3 to 13.8, 13.8 the end of a credential's session; 14.1 to 14.3,
  14.3 with a step more, and 14.7; 15.1, 15.2, 15.4 and 15.5; each unit they add or move cited by a
  case, or in `spec/uncited.txt`. Its version stays 0.1.0, and moves to 0.2.0 in the release commit
  ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md));
- the vectors: every one that carries the block, its flag and its block written again; a header of
  each scheme on the kinds that take it, padding included, and a `JWT` behind a destination and a
  total; the refusals of each scheme where it is malformed, of a length not its scheme's, of padding
  not zero, of a block past the header, of a header a word longer than the block's padded end and of
  a block whose stated length leaves byte 3 a word short; the verdicts of `JWT`s — a token, a key, a
  time and an audience, taken or refused and why — among them `exp` plus 60 s and `nbf` less 60 s,
  each a millisecond either side, one of them a fraction, an ID token typed `JWT` refused and its
  twin typed `at+jwt` taken, the right key and audience under a foreign `iss`, a token carrying its
  own key in `jwk`, a token under a key set's encryption key, a `kid` that names no key while
  another would verify, a token with `crit`, an RS256 token, an ES256 token met by an HS256 key and
  the reverse, and an HS256 token keyed with an ES256 key's public bytes in each encoding a library
  takes (its PEM, its DER, its JWK's JSON). The generator writes the HS256 ones with Python's own
  `hmac`, and keeps the ES256 ones as constants, signed once under a published test key, which
  RFC 6979's deterministic ECDSA would also let it sign itself. No configuration outside `spec/` and
  the tests names a test key, and the demo's verifier refuses one. A header names its credential as
  `{ "scheme", "token" | "bytes" }`, and the three schemas follow;
- the conversations: each one sized by the announcement, with 20 bytes; a request presenting its
  connection's session, another's, and one ended; a `JWT` taken, expired, of another audience,
  renewed under a subscription, and one whose end lies past a timer's ceiling, timed in two steps;
  two issuers presenting the same `sub`, the second moving nothing of the first's subscriptions; a
  credential's session ended by its identifier; `ELSEWHERE` carried and not; a scheme to come; a
  verifier that settles late, with a cancel meanwhile, and one that fails; `logout` in a
  credential's session. A step may say what its transport carried with its envelope, and another
  advances the server's clock. `interop-service.json` says what the interop service does;
- both implementations: the codec and its types, `credential` on the headers and `credentialScheme`
  in what a side reports; the call's session, handed to admission and to the resolver; resolution
  that waits, `sessionOf`; the `JWT` verifier, its key set, and the timer toward a credential's
  session's end; the subscriptions a credential's session bounds, and `endSession`; the client's
  credential, per call and by default, its withdrawal, and an `ELSEWHERE` failed before it goes; the
  transport contract and `Authorization` at both ends of HTTP; the relay's table, its destinations'
  audiences, and `verifies`; and their tests, twin for twin
  ([0004](0004-one-behaviour-in-every-language.md)), on the clock
  [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md) gives every side;
- [0001](0001-the-envelope-sits-at-fixed-offsets.md), changed where it states the SESSION block, a
  header's length from its kind and its flags alone, every value a layout does not define refused as
  malformed, a session never presented by a client, and one session at the target for every
  requester behind a relay; [0004](0004-one-behaviour-in-every-language.md), where a relay that
  passes on a session fails and the interop's relay asks for a session, its example's `session` key,
  and its counts; [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md), where an
  answer's session is a `SessionAnnouncement` and a header's two sessions are named by their type;
  the TypeScript side's README; the sessions' row of `docs/support.md`; this record's row in the
  decisions' index; the demo, whose tokens become access tokens of RFC 9068's profile and pass as
  `JWT`; the CHANGELOG; and the Bead page, rebuilt.

## The Tenth Man

The draft met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). Its
objections, each with its answer:

| Objection                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The call's session reaches neither admission nor the resolver, and `requireSession` tests the connection's, so a `JWT` call runs in the connection's session | Accepted: every request resolves to its call's session, which admission and the resolver receive and `requireSession` tests; the transport contract carries a credential beside an envelope, both ways.                                                                                                                                                                                                                                                                                                                                                   |
| A relay that resolves with its own verifier holds every destination's keys, and its table refuses a call from HTTP to a WebSocket                            | Accepted in part: a relay forwards and its destination verifies; a connection the server terminates, a WebSocket's upgrade, opens a session at connect; a route that cannot carry the credential is `DESTINATION_UNREACHABLE`. Refused: a broker's connection treated so, since the server never sees it and its authentication is what `ELSEWHERE` stands for; and the runtime choosing between the block and `Authorization` for a token, since a `JWT` travels in the block on every transport and `ELSEWHERE` leaves the credential to its transport. |
| `SIGNED` names a property, not a format, so the two languages cannot verify each other's tokens                                                              | Accepted: scheme 2 is `JWT`, in JWS Compact Serialization, verified one way on every side, with vectors of verdicts; a CWT takes a scheme to come.                                                                                                                                                                                                                                                                                                                                                                                                        |
| A synchronous verifier leaves out Web Crypto, the demo's worker and the session service, and binds the builder to an answer that 6B changes                  | Accepted: resolution may wait, and its order is stated now; admission after it stays synchronous.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SESSION_REQUIRED` answers three failures that need three remedies                                                                                           | Accepted: `CREDENTIAL_UNSUPPORTED` for a scheme the side takes none of, as code 36 of the admission block since the side knows what it takes only there, not 5 of the envelope's. Refused: that refusing at admission leaks the routing table, which a request without a credential learns as well.                                                                                                                                                                                                                                                       |
| A `JWT` forwarded unchanged, in the clear, to a destination registered by a boolean, is replayable wherever its audience reaches                             | Accepted: a bearer credential crosses only TLS off the machine, held by its sender; a destination registers its audience, and a `JWT` goes to its audience alone; sender-bound tokens are the federation's. Refused: a credential the registration mints for leg B, which leg B's own session already is.                                                                                                                                                                                                                                                 |
| A subscription bounded by its token's lifetime breaks at every renewal and misses a session ended early                                                      | Accepted: it is bounded by its credential's session, which a renewal under the same identifier extends and the side may end.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Refusing a credential that does not hold refuses the call that renews it, and an `OPAQUE` presented by default fails every call in flight across a rotation  | Accepted: `OPAQUE` is presented per call only, and a default credential is withdrawn once refused, the application told.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The conformance files cannot play a transport's credential, a relay's table or a lifetime                                                                    | Accepted: a step says what the transport carried, another advances the server's clock, `JWT` verdicts are vectors, and two vectors of header length are added; the relays play in the conversations and `Authorization` in the transports' file, which land first.                                                                                                                                                                                                                                                                                        |
| A header of 1,020 bytes passes the limits: the writer's code, 12.2's minimum and the relay's fixed header                                                    | Accepted: `ENVELOPE_TOO_LARGE` at the writer, limits of 1,024 bytes at least with a `JWT`, an opening of one byte at least, and leg B's header counted call by call.                                                                                                                                                                                                                                                                                                                                                                                      |
| `SESSION` flags what is often no session, `ENDED` is no scheme, and a bare scheme is a URI's                                                                 | Accepted: the flag is `CREDENTIAL`, its first field the credential scheme, 0 is `NONE`, 2 is `JWT`, and section 13.1 names the two sessions.                                                                                                                                                                                                                                                                                                                                                                                                              |
| The spec's version moves in this change, against 0008, and the list misses what the change contradicts                                                       | Accepted: the version moves in the release commit, and the list names 12.2, 14.1, 0001's sentences, 0004's counts, the demo and the CHANGELOG.                                                                                                                                                                                                                                                                                                                                                                                                            |

Adding RS256 met the Tenth Man again, and RS256 was withdrawn. Its objections, each with its answer:

| Objection                                                                                                                                             | Answer                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenID Connect requires RS256 of a provider signing ID tokens, and the verification takes an ID token as a bearer credential                          | Accepted: a `JWT` is an access token typed `at+jwt`, its ID token twin a vector refused; RS256, which the citation was for, is withdrawn.                                                                   |
| A provider's key signs for many issuers, the verification reads no `iss`, and `sub` alone names a session                                             | Accepted: each key comes with its issuer, `iss` equals it octet for octet, and a session is named by `iss` with `sid`, else with `sub`.                                                                     |
| The platforms' RSA verifiers disagree: .NET on Windows takes a DigestInfo without its NULL, and three take a forgery under an exponent of 1           | Accepted: RS256 is withdrawn, so no side gives an RSA verdict.                                                                                                                                              |
| The key's floor is enforced by no runtime, measured each its own way, with no exponent and no ceiling, and refuses tokens for a configuration's fault | Accepted, and settled by RS256's withdrawal: the block takes no RSA key.                                                                                                                                    |
| The draft says how a key refuses an algorithm, not how a key is found, and a token can name its own                                                   | Accepted: a key is found by `kid` among the application's alone, `jwk`, `jku`, `x5u` and `x5c` are never read, `crit` is refused, and a JWK serves by its `alg`, `use` and `key_ops`, each with its vector. |
| A provider's token fits only with RFC 9068's required claims, so RS256 buys little that the exchange does not                                         | Accepted: RS256 is withdrawn; a provider's token is exchanged at the edge, or goes `ELSEWHERE`, and the numbers stand in the Context.                                                                       |
| A signer written by hand has no check that it is right, and its error becomes the spec                                                                | Accepted, and settled by RS256's withdrawal: the generator signs HS256 alone, with Python's own `hmac`, and keeps ES256 as constants.                                                                       |
| PKCS #1 v1.5 enters a new protocol without being confined to compatibility, and nothing says why not PS256                                            | Accepted, and settled by RS256's withdrawal.                                                                                                                                                                |
| Determinism is no reason to add RS256, and ECDSA signs anew only by choice (RFC 6979)                                                                 | Accepted: determinism is no longer a reason, and the generator's sentence says the ES256 vectors stay constants by choice.                                                                                  |
