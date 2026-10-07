# 0010 — A request presents a credential of a scheme, in the header's last block, and runs in the session it resolves to

- **Status**: accepted
- **Scope**: the protocol, every implementation, the relays and the transports

## Context

A call reaches sides that never drew its session. A relay passes it to a destination behind it;
HTTP/JSON transcoding takes it from a client whose `Authorization` field holds its credential; a
broker hands it to a server that takes its procedure
([0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)); a server that never issued
its token runs it on a token it verifies alone. Each of them has to know from the header whether the
call presents a credential and of what kind, since admission reads the header and never the payload
(spec, section 9.2, step 5), and a relay passes the payload on undecoded (section 14.2).

Six shapes were weighed:

- **The 16-byte block a server draws and announces**, which serves a connection that is its session:
  it holds no signed token, and cannot say that the transport holds the credential, so a relay
  cannot tell a call that presents one from one that does not, and a call whose credential its next
  transport cannot carry crosses without it, in silence.
- **A block of its own for a signed token, beside the 16 bytes**, spends the last free bit of the
  low nibble on a second block that says what the first says, who the call is for, and leaves the
  transport's credential a third.
- **The credential at the head of the payload** keeps the header's length fixed, but admission would
  read the payload, a relay would decode what it passes on, and a transfer's first bytes would carry
  it.
- **The credential in the transport alone**, as HTTP carries `Authorization`, leaves the wire
  silent: a relay cannot tell a call that presents one from one that does not, and moves one onto a
  transport that carries nothing.
- **A block of variable length first of the blocks** moves DESTINATION and TRANSFER, which every
  reader finds at offsets the flags give ([0001](0001-the-envelope-sits-at-fixed-offsets.md)).
- **A length on one byte** holds 255 bytes, short of a signed token: a JWT signed by HMAC-SHA256
  with a few claims is some 200 to 300 bytes, one signed by RSA some 500 to 900.

**RS256 in the block**, for a provider's access token as it was issued, was weighed too, since RFC
9068 §2.1 requires it of every resource server. Under a key of 2,048 bits its signature is 342
characters, against 86 for ES256, and with RFC 9068's header, its `kid` a thumbprint of 43
characters (RFC 7638), it leaves some 403 bytes of claims where ES256 leaves some 595: a token with
the required claims alone fits, at some 760 characters, and one with `scope`, `sid`, `email` and
`name` besides does not, at some 1,016, so a provider that adds a claim would move every call of its
users from taken to refused. It brings RSA's keys besides, whose bounds the platforms check each
their own way, and a verdict they do not give alike: .NET on Windows takes a DigestInfo without its
NULL that every other platform refuses, and three platforms take a forgery under an exponent of 1.

## Decision

### The block and its schemes

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

Four schemes are defined (spec 4.4): `NONE`, 0, which on an answer says the connection's session
ended; `OPAQUE`, 1, the 16 bytes of a connection's session's token, never all zero; `JWT`, 2, an
access token of RFC 9068 in JWS Compact Serialization (RFC 7515), on a request alone; and
`ELSEWHERE`, 3, empty, the credential its transport carried with it, on a request alone. A scheme
from 4 to 65,535 is read whole, then refused at admission, `CREDENTIAL_UNSUPPORTED`.

**A header carries it as `credential`, `Credential`**, on a request, a result and a failure alike,
one field of one type on both sides: `{ scheme, … }`, its credential scheme and its bytes.

**The header holds 1,020 bytes**, the 255 words byte 3 counts, and a credential has what the rest
leaves: 992 bytes on a request that names a destination and opens a transfer (28 bytes of prefix,
service and procedure, destination, total and the block's own head), 1,004 on one that does neither.
The limits hold such a header: a side that takes or presents a `JWT` sets `chunkBytes` and
`maximumEnvelopeBytes` to 1,024 bytes at least (section 12.2), and a transfer's opening carries one
byte of its payload at least (section 12.3). A writer whose payload needs a transfer, and whose
header, its TRANSFER block added, passes 1,020 bytes or leaves the opening no byte, fails the call
before it goes with `PAYLOAD_TOO_LARGE`, as a side that sends no transfer fails one (section 12.1):
its payload is too large for the one envelope its header leaves it. A credential no header of its
request holds is a programmer's error, before the call starts. A token past what the header holds
is exchanged at the edge for one that fits, or for a session of the server's, as OAuth's token
exchange does (RFC 8693).

### Two sessions, and the one a call runs in

**A session is what a call runs in, and comes in two kinds.** A _connection's session_ belongs to a
server's connection: a request opens one — a procedure that checks credentials, say — and the server
keeps it with its token, its data and its timeouts, and announces it (section 13.3). A _credential's
session_ is what a verifier makes of a credential a request presents, `JWT` or `ELSEWHERE`: an
identifier, its data and its end, never announced. A call presenting none runs in its connection's
session, in none when the connection has none; one presenting `OPAQUE`, in its connection's session,
whose token it carries; one presenting `JWT` or `ELSEWHERE`, in a credential's.

**A credential's session is named by a record, and a call carries its own credential's data.** Its
identifier is a record of its credential scheme and its claim: a `JWT`'s, `{ issuer, sid }` or
`{ issuer, sub }` (below); an `ELSEWHERE`'s, its verifier's `id`. Two identifiers are one when their
scheme, their claim's name and their values are equal, octet for octet. A call's session carries the
data of the credential it presented, never another call's under the same identifier: for a `JWT`,
its claims set as each side's JSON reader gives it, a frozen object on the TypeScript side, a
`JsonElement` on the C# side; for an `ELSEWHERE`, what its verifier gave. A credential's session is
kept, and its end timed, only while it bounds a subscription: what a side keeps, per connection and
identifier, is its end, the later of those resolved, and the subscriptions it bounds. A call that
resolves to one not kept runs with its own end, and keeps it once it subscribes.

**The inactivity timeouts of section 13.7 are a connection's session's**; a credential's session has
none, and ends at its end, when the application ends it, or with its connection
([0012](0012-a-listen-held-is-not-silence.md)).

### Resolution

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

`requireSession`, `RequireSession`, tests the call's session, never the connection's: a call that
presented a `JWT` is not in its connection's session, whatever that session holds. It refuses a call
in none that presented no credential with `SESSION_REQUIRED`, and one that presented a credential it
does not run in — a relay forwarding it without verifying — with `ACCESS_DENIED`: an admission never
answers `SESSION_REQUIRED` to a call that presented a credential, which would have its client
withdraw one that may hold.

**Resolution may wait.** A `JWT` verified by Web Crypto, a key set asked for a `kid` not yet seen, a
session service asked whether a token holds: a verifier settles later, a `PromiseLike` on the
TypeScript side, a `ValueTask` on the C# side. While it does, its request holds its call id (step 2
of section 9.2 refuses another on it); a cancel ends it, answered by nothing, and tells its verifier
by its signal (section 10.2), as its connection closing does; a transfer's opening gets no credit
until resolution and admission settle (section 12.3); and the call runs in the session it resolved
to, whatever befell its connection's meanwhile. A request that presents none or `OPAQUE` resolves in
the turn it came; one that presents `JWT` or `ELSEWHERE` resolves in a later turn, on every side,
whether its verifier waits or not, or a relay forwards it unverified, resolving it to no session. A
resolution that settles once its call ended, cancelled or its connection closed, opens no session,
moves no end, and is dropped.

**A credential that does not hold is refused, whatever the procedure requires**, with
`SESSION_REQUIRED`, as a bearer token found invalid is answered 401 (RFC 6750 §3.1); `ACCESS_DENIED`
says that a session holds and is not allowed. A call never runs outside the session it presented.
The client's side keeps that from refusing the calls that renew a credential:

- a client presents `OPAQUE` only on a call that asks for it, never by default: it binds that call
  to the session the client knows, so a call made in a session that ended, or that was opened anew
  under a new token, is refused rather than run in whatever session the connection holds;
- a credential a client presents by default, `JWT` or `ELSEWHERE`, is withdrawn once a call that
  presented it is refused `SESSION_REQUIRED`, while it is still, by value, the credential that call
  presented, and the client tells its application, so the call that renews it goes out without it; a
  call may present none, whatever the default;
- a client fails a call before it goes, and a server a command alike, with
  `DESTINATION_UNREACHABLE`, as a relay refuses a call its leg B cannot carry, when it presents
  `ELSEWHERE` over a transport that carries none, or `JWT` or `ELSEWHERE` in the clear off the
  machine, judged by its transport's scheme (`wss`, `https`), a loopback host, or a transport that
  never leaves the machine, a Web Worker or a router called in process: nothing was tried, and the
  credential stays.

A client that receives a command resolves the command's credential the same way, the session it
learned standing for its connection's.

### The `JWT` profile

**A `JWT` is an access token of RFC 9068's profile, verified one way on every side** (section 13.8),
as RFC 8725 recommends:

- **its type**: its `typ` is `at+jwt`, or `application/at+jwt`, as RFC 9068 §4 writes them (RFC 8725
  §3.11), so a token of another kind from the same issuer is refused (RFC 8725 §3.12): an ID token,
  which an issuer signs with the same key and sends inside a URL (OpenID Connect Core 1.0 §3.1.2.1);
- **its key**: the application gives each key with its issuer and its one algorithm (RFC 8725 §3.1):
  ES256, for keys the services that trust one issuer share by their public half, or HS256, for one
  trust domain. A token's `alg` is its key's, so `none`, an algorithm no key takes, and an HS256
  token keyed with a public key's bytes are refused. A key is found by the token's `kid` among the
  application's keys and those its issuer's key set answered: without a `kid`, only when its issuer
  has one key. The application gives the key set with the issuers it answers for, and the runtime
  asks it for those alone, when no key of the token's issuer names the `kid`, once a minute at most
  for that issuer, a deadline on the monotonic reading
  ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)): a token of an issuer the set
  does not name asks nothing, so no peer has the set fetch at its will (RFC 8725 §3.10). An ask is
  given a signal its deadline aborts; one unsettled then has failed, and the next may go. A call
  that finds an ask under way waits on it, and its own signal leaves that ask to the others; a call
  whose `kid` comes while its issuer's minute runs waits for the deadline and the ask that goes
  then, and one without a `kid` waits on its issuer's keys while none of them serve, a cold start
  included. So many calls at most wait for an issuer's deadline at once, `maximumWaitingCalls`, 64
  by default, a call on an ask under way never counted: one past them is refused
  `CAPACITY_EXCEEDED`, which withdraws nothing and is not reported, since a `kid` is looked up
  before any signature is checked. A deadline is reached on the monotonic reading wherever a side
  reads it, whenever its timer fires. The keys an answer gave are held ten minutes, beside the
  application's, held for good: past them, a token whose `kid` they name waits on a new ask before
  they serve, so a key its issuer withdrew stops verifying. A `kid` still unnamed by an answer to an
  ask that went after its token came is refused `SESSION_REQUIRED`, never tried against the others;
  a call that waited on an ask that failed is refused `PROCEDURE_FAILED`, as a key set that cannot
  be reached is. The runtime fetches nothing itself: a token's `jwk`, `jku`, `x5u` and `x5c` are
  never read (RFC 8725 §3.10), and a token that carries `crit` is refused. A JWK serves only when
  its `alg` is its key's algorithm, or is absent and the application names it, its `use` is `sig` or
  absent, and its `key_ops`, when present, include `verify` (RFC 7517 §4.2 to §4.4);
- **its claims**: `iss` required and equal, octet for octet, to its key's issuer (RFC 8725 §3.8);
  `exp` required, the token holding while the wall clock is before `exp` plus 60 s, and `nbf` read
  when present, the token holding from `nbf` less 60 s (RFC 7519 §4.1.4, §4.1.5); `aud` required,
  naming the receiver's audience (RFC 7519 §4.1.3). The 60 s is a leeway for clock skew, a constant
  on every side that the verdict vectors pin, never an option;
- **its session**: its identifier is `{ issuer, sid }`, its `iss` with its `sid`, else
  `{ issuer, sub }`, its `iss` with its `sub`, since a subject is unique within its issuer alone
  (RFC 7519 §4.1.2), and its end is `exp` plus 60 s, the instant its verdict uses, since a skew
  moves an end as much as a start.

The keys and the audience are the application's, and keys given without an audience are refused as
the side is built; the verifying is the runtime's. Another format, a CWT (RFC 8392) for a
constrained peer, takes a scheme to come.

**A credential's session ends on a timer that reads the wall clock again at each step** (section
13.9), on the clock its side runs on
([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)):

- its end, _E_, is a whole number of milliseconds since the epoch: for a `JWT`, _X_ + 60,000, where
  _X_ = ⌈`exp` × 1000⌉, the claim read as an IEEE 754 double, as both sides' JSON readers read it;
  for an `ELSEWHERE`, the end its verifier gives, rounded up to a millisecond. `nbf` is held alike,
  _N_ = ⌈`nbf` × 1000⌉, and a claim that is not a JSON number, or whose milliseconds pass 2⁵³ − 1
  (section 1.2), does not hold;
- the wall clock's reading, _W_, is a whole number of milliseconds since the epoch, a fraction
  dropped, so a comparison with _X_ or _N_ is exact — _W_ is before `exp` × 1000 exactly when it is
  before _X_ — and no fraction reaches a timer;
- as its session comes to be kept, as a renewal moves _E_, and at each step's due, the side reads
  _W_ again, never counting down, and takes _R_ = _E_ − _W_: at _R_ ≤ 0 the session ends in a turn
  of its own, past the answer that kept it, with no timer armed; otherwise a timer of min(_R_,
  2³¹ − 1) ms is armed, so an end is never refused for its distance;
- a `JWT` holds while _W_ < _E_, and _W_ ≥ _N_ − 60,000 when it carries `nbf`, by one reading of _W_
  taken once its signature verifies; its session's first timer takes a reading of its own, once the
  session is kept;
- an `ELSEWHERE` whose end _W_ has reached when its verification settles does not hold:
  `SESSION_REQUIRED`.

A wall clock set by hand takes effect at the next step's due.

### Announcements and subscriptions

**An answer announces its connection's session, `OPAQUE` or `NONE`**, on the next answer after it
changed (section 13.3). The announcement takes 20 bytes, and a side counts them where it sizes an
answer before knowing whether one rides on it: a result that would need a transfer is counted with
those 20 bytes, whether it carries them or not (section 12.1), and a failure's detail is cut to fit
behind 32 bytes of prefix, block and record (section 7.4).

**A credential's session bounds the subscriptions its calls hold.** A connection holds one
subscription per procedure and per session (section 11.3): the first call of a session to take it
keeps it, on its call id, bounded by that session (section 13.6); a call of another session takes
one of its own. A connection's session and a call presenting none count as one session for this, the
connection's, so a connection whose calls present no credential holds one subscription per
procedure. A subscription held in a `JWT`'s or an `ELSEWHERE`'s session ends when that session ends
— at its end, or once the application ends it — with a failure on its call id, `SESSION_REQUIRED`,
as a connection's session ends the subscriptions of its connection that no credential's session
bounds (section 13.6). A call on the same connection whose credential resolves to the identifier of
a session kept moves its end to the later of the two, in whatever order resolutions settle: a
credential renewed keeps its subscriptions. Ending a credential's session by its identifier ends it,
and the subscriptions it bounds, on every connection that keeps it, and nothing else: a credential
that still holds opens it anew, so ending a session is no revocation. The application may end every
credential's session of an issuer alike, as when a key of its leaks.

### A transport's credential and TLS

**A transport may carry a credential beside an envelope, both ways**: it hands the router what it
carried with an envelope it took, and carries what the router gives it with one it sends. Over HTTP,
it is the `Authorization` field of the `POST /bead` that carries a request (RFC 9110 §11.6.2), and
no other exchange's is read
([0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)): two calls of one
connection may present two credentials, and a token is renewed without connecting again, while the
connection's token names the connection and nothing else. The credential is the field's value as it
came, whole, its auth-scheme included, its surrounding whitespace removed; an empty field carries
none; a `POST /bead` with more than one `Authorization` field is refused 400, `malformed`, since the
field is no list to combine (RFC 9110 §5.3); and a relay writes the value to leg B as it came. A
WebSocket and a Web Worker carry none, nor does what a listen brings back over HTTP, a server's
command among it, and a request that presents `ELSEWHERE` on them is refused `SESSION_REQUIRED`. On
a broker ([0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)), `ELSEWHERE` is the
case it is made for: a client authenticates to the broker, the server never sees that client's
connection, and each message reaches it on the broker's word. What carries that word, the
authentication of the connection its client publishes on or a property of the message, is open, and
is decided with the broker's transport. A relay that publishes for many requesters carries each
one's credential with that requester's message, never in its own connection's authentication, which
is the relay's. A connection the server itself terminates — a WebSocket's upgrade — holds one
credential for every call on it: it opens that connection's session when it connects, by the
decision that brings it, and never stands for `ELSEWHERE`.

**A bearer credential crosses only TLS off the machine.** A side presents a `JWT`, and carries an
`ELSEWHERE`, only over TLS — `wss`, `https` — or within the machine: the loopback, a Web Worker, a
router called in process, as RFC 6750 §5.3 requires of every bearer token. The sender holds it, the
client and a relay's leg B alike, since a server behind a terminator of TLS cannot tell. A server's
transport judges a connection by what it listens on, unless its application says what stands in
front of it, `secure`, `Secure`: TLS terminated before it, or a proxy that serves the network in the
clear, believed whatever it listens on.

### Through a relay

**A relay forwards a credential, and its destination verifies it** (spec 14.3, 14.7; the relay is
[0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)'s):

| Leg A presents | The relay                                                                                                   | Leg B presents                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| none, `OPAQUE` | resolves it to leg A's connection's session, which its admission checks                                     | none: leg B's session at the destination (14.7)        |
| `JWT`          | forwards it to a destination whose audience its `aud` names, read without verifying it unless it `verifies` | the same bytes                                         |
| `ELSEWHERE`    | forwards it to a destination registered with an audience, over a leg B that carries one                     | `ELSEWHERE`, its credential moved to leg B's transport |

A destination is registered with the audience it verifies, as a resource is named for a token (RFC
8707). A relay's default admission, `requireSessionOrCredential`, `RequireSessionOrCredential`,
admits a call in leg A's connection's session, or one whose header presents a `JWT`, or an
`ELSEWHERE` its transport carried, read from the header's scheme; a `beforeRoute` given as
`requireSession` refuses every credential the relay forwards without verifying, `ACCESS_DENIED`.
With `verifies`, the relay verifies what it forwards besides, with its side's `credentials`, at step
1 of section 14.3, before `beforeRoute`: a `JWT` against the set of audiences its registrations
hold. A credential that does not hold, or a `JWT` that names none of those audiences, is refused
`SESSION_REQUIRED` there, and `beforeRoute` reads the credential's session. At step 1, a scheme the
relay neither resolves nor forwards is refused `CREDENTIAL_UNSUPPORTED`, and an `ELSEWHERE` that
carried nothing `SESSION_REQUIRED`. A call the relay cannot forward — to a destination of another
audience or of none, over a leg B that carries no credential, or in the clear off the machine — is
refused `DESTINATION_UNREACHABLE`, at a step of its own, section 14.3's fifth, before the limits'
step, the sixth: its credential may hold, and its route does not; with `verifies`, that step holds a
verified `aud` to its destination's own audience. A call that presents a credential never runs in
leg B's session in place of its own. Leg B's header counts its credential, call by call, against the
smaller of the two legs' limits (section 14.3, step 6).

### What a side reports, and the names

**A credential stays out of everything a side reports**: no detail, event, trace or log carries its
bytes, nor the transport's field; only its scheme, `credentialScheme`, `CredentialScheme`.

**The surface is named alike on both sides**, the TypeScript side's name before the C# side's:

- `credentials`, `Credentials`, among a server's options, and a client's for the commands it
  receives: a `JWT`'s keys, each with its issuer and its algorithm, and its audience; the key set,
  `keySet`, `KeySet`, given with the issuers it answers for, which the runtime asks for a `kid` no
  key of the token's issuer names, with a signal its deadline aborts, which may wait, and whose
  answer it holds ten minutes, and the calls that may wait for an issuer's deadline at once,
  `maximumWaitingCalls`, `MaximumWaitingCalls`; and an `ELSEWHERE`'s verifier, `verify`, `Verify`,
  given what the transport carried and its call's signal, which settles with a credential's session
  — its identifier, its data, and its end, none for a session without one — or with none, when the
  credential does not hold. The side builds its `JWT` verifier from them, as data, on the clock its
  stack runs on, so no verifier brings a clock of its own;
- the call's session, `session`, `Session`, on the request admission reads and on the request a
  resolver receives: none when the call runs in none; its data; and, for a credential's session, its
  identifier, the record above, and its end;
- `sessionOf`, `SessionOf`, the router's hook asked once per request, with its call's signal,
  between holding its call id and the synchronous `beforeRequest`: it may wait, never for a request
  that presents none or `OPAQUE`. `sessionTokenOf`, `SessionTokenOf`, stays beside it, asked per
  answer and never waiting, for the announcement of section 13.3;
- `requireSession`, `RequireSession`, tests the call's session;
- `requireSessionOrCredential`, `RequireSessionOrCredential`, a relay's default admission: a call in
  leg A's connection's session, or one presenting a credential the relay may forward;
- `endSession(id)`, `EndSession(id)`, ends a credential's session by its identifier, that record,
  and the subscriptions it bounds; `endSessionsOf(issuer)`, `EndSessionsOf(issuer)`, every
  credential's session of an issuer, on every connection that keeps one;
- `verifies`, `Verifies`, among a relay's options, has it verify what it forwards besides, at step 1
  of section 14.3;
- `credential`, `Credential`, among a client's options for its default, and among a request's
  options for that call alone: a call may present none whatever the default, and `OPAQUE` stands for
  the session the client learned;
- `credentialWithdrawn`, `CredentialWithdrawn`, the client's event that tells its application a
  default credential was withdrawn;
- the credential a transport carries travels with its envelope, as one argument: on the TypeScript
  side, the message event's first argument and `send`'s are `{ data, credential }`; on the C# side,
  `TransportMessage` has its `Credential`; each keeps its other parameter.

**The builder binds to the call's session once resolved.** Its admission vocabulary maps to no
`beforeRequest`, to `requireSession` over `session`, or to a named `beforeRequest`, synchronous,
that reads the session's data. The waiting all happens upstream, in `credentials`: the code the
builder generates never names it, as it adds no clock
([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)).

**The interop service answers from its call's session.** `whoami` admits a call with a session, its
call's, and answers the name that session holds: the name `login` gave its connection's session, or
the `sub` of its own call's claims, which RFC 9068 §2.2 requires, or of what its `ELSEWHERE`
verifier gave. `login` opens its connection's session whatever its call presents, announced
`OPAQUE`, its `sessionTimeout` and `connectionTimeout` that session's alone. `logout` ends its
connection's session; it refuses a call in a credential's session `ACCESS_DENIED`, since
`SESSION_REQUIRED` would have its client withdraw a credential that holds, and a call in none
`SESSION_REQUIRED`. `endSession` ends a credential's session by its identifier, and nothing else,
and `endSessionsOf` every credential's session of an issuer. `register` takes the audience its
destination verifies, and the service's relay, its `relay.admits`, admits in the same words what a
server's relay admits by default. Its `credentials` hold two issuers' published test keys, one ES256
and one HS256, one audience, a key set, named with the issuers it answers for, that names a third
key, and an `ELSEWHERE` verifier that holds a carried value naming a `sub`, settles one that asks to
settle after so many milliseconds then, on the server's clock, rejects one that asks to fail, and
holds nothing else; its `JWT` verifier is the runtime's. Its clients are given the published keys
and their audience, for the commands they receive.

## Consequences

**A request is 32 bytes of header with `OPAQUE`, 16 with `ELSEWHERE`, and 16 plus its token rounded
up to a word with a `JWT`: 316 bytes for a token of 300.** An answer that announces a session is 28
bytes, one that announces its end 12.

**A provider's token enters by exchange, or `ELSEWHERE`.** The block takes ES256 and HS256 alone. A
provider's access token, signed with RS256, is exchanged at the edge for an ES256 one the services
that trust one issuer take (RFC 8693), whose 992 bytes leave some 595 of claims under RFC 9068's
header, or it goes `ELSEWHERE`, whatever its size. HTTP/JSON transcoding turns
`Authorization: Bearer` into a `JWT` in the block when its services trust the token, and exchanges a
provider's, or keeps it `ELSEWHERE`. A side is no conforming RFC 9068 resource server: §2.1 asks
RS256 of every one, and the block takes none. RS256 can come back by a decision of its own, which
revises `0xA1` in place while nothing is published
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).

**One block of variable length, and only one.** It takes the last bit; a second would need a layout
of its own ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)). A credential
past 992 bytes never travels in the header, and an answer announces no `JWT`: an issuer that hands
one out on an answer changes this record.

**A destination receives a bearer credential that is not its own**, worth whatever its audience
allows: the relay forwards a `JWT` to its audience alone, and the destination verifies it. Tokens
bound to their sender (RFC 9449, RFC 8705) are a decision of their own.

**A relay's default admission lets any `JWT`, and any `ELSEWHERE` its transport carried, past its
first step.** It reads the header's scheme, never the credential, so a requester that writes any
bytes in the block, or has its transport carry any value, passes step 1 of section 14.3 and learns
from `DESTINATION_UNKNOWN` which destinations exist: that step's promise, that a requester not
admitted learns only whether the relay has any destination, holds for a call presenting none or
`OPAQUE` alone, unless the relay `verifies`.

**A page presents `ELSEWHERE` to its own origin only.** `Authorization` is not a header CORS lets
through without a preflight, and the HTTP transport answers none.

**A connection whose calls all present a `JWT` or an `ELSEWHERE` is its server's to time.** It has
no connection's session to give it timeouts of its own: it holds by what silence is on its transport
([0012](0012-a-listen-held-is-not-silence.md)).

**A verifier slower than a transfer's inactivity times out the opening it holds.** While its
credential resolves, a transfer's opening gets no credit, and its requester counts the transfer's
inactivity meanwhile (section 12.8): a verifier slower than 30 s, by default, ends the call at its
requester.

**Resolution waits on both sides**, a `JWT`'s and an `ELSEWHERE`'s in a later turn even when its
verifier does not: a call presenting none, sent after one presenting a `JWT`, may be answered first,
on every side alike, and a conversation awaits a `JWT` call's answer before it sends anything that
could overtake it. The order of section 9.2, a cancel during resolution and a transfer's first
credit are stated, and played by a conversation whose verifier settles late, on the server's clock.
Verifying a `JWT` costs no dependency: Web Crypto on the TypeScript side, in Node and in a browser
alike; `ECDsa` and `HMACSHA256` on the C# side; a key imported from its JWK, JSON and base64url on
both; and a key set is the application's to fetch.

**The relays' table plays in the conversations, and `Authorization` in the transports' file**
([0004](0004-one-behaviour-in-every-language.md)): a conversation carries a relay across its
connections, and what turns on leg B's transport — `Authorization` over HTTP, none over a WebSocket
— plays over real sockets, since a rule that a side's own tests alone check is the weak one.

**No configuration outside `spec/`, the tests and the interop service holds a published test key**,
nor its thumbprint (RFC 7638): `spec/check.py` refuses one, over the files git lists, and the demo's
verifier refuses one ([0006](0006-a-rule-has-its-gate.md)).

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
six rounds, a later one answering an earlier one's answers; the round on a forwarded credential's
turn and on a credential that leaves a transfer no room is kept in
[0001](0001-the-envelope-sits-at-fixed-offsets.md), At the wire's edges, and the round on the
`ELSEWHERE` its default admission passes in [0004](0004-one-behaviour-in-every-language.md), On the
text of 0.2.0. The decision's objections, each with the answer that holds:

### The block and the sessions

| Objection                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The call's session reaches neither admission nor the resolver, and `requireSession` tests the connection's, so a `JWT` call runs in the connection's session | Accepted: every request resolves to its call's session, which admission and the resolver receive and `requireSession` tests; the transport contract carries a credential beside an envelope, both ways.                                                                                                                                                                                                                                                                                                                                                   |
| A relay that resolves with its own verifier holds every destination's keys, and its table refuses a call from HTTP to a WebSocket                            | Accepted in part: a relay forwards and its destination verifies; a connection the server terminates, a WebSocket's upgrade, opens a session at connect; a route that cannot carry the credential is `DESTINATION_UNREACHABLE`. Refused: a broker's connection treated so, since the server never sees it and its authentication is what `ELSEWHERE` stands for; and the runtime choosing between the block and `Authorization` for a token, since a `JWT` travels in the block on every transport and `ELSEWHERE` leaves the credential to its transport. |
| `SIGNED` names a property, not a format, so the two languages cannot verify each other's tokens                                                              | Accepted: scheme 2 is `JWT`, in JWS Compact Serialization, verified one way on every side, with vectors of verdicts; a CWT takes a scheme to come.                                                                                                                                                                                                                                                                                                                                                                                                        |
| A synchronous verifier leaves out Web Crypto, the demo's worker and the session service, and binds the builder to a synchronous answer                       | Accepted: resolution may wait, and its order is stated now; admission after it stays synchronous.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SESSION_REQUIRED` answers three failures that need three remedies                                                                                           | Accepted: `CREDENTIAL_UNSUPPORTED` for a scheme the side takes none of, as code 36 of the admission block since the side knows what it takes only there, not 5 of the envelope's. Refused: that refusing at admission leaks the routing table, which a request without a credential learns as well.                                                                                                                                                                                                                                                       |
| A `JWT` forwarded unchanged, in the clear, to a destination registered by a boolean, is replayable wherever its audience reaches                             | Accepted: a bearer credential crosses only TLS off the machine, held by its sender; a destination registers its audience, and a `JWT` goes to its audience alone; sender-bound tokens are a decision of their own. Refused: a credential the registration mints for leg B, which leg B's own session already is.                                                                                                                                                                                                                                          |
| A subscription bounded by its token's lifetime breaks at every renewal and misses a session ended early                                                      | Accepted: it is bounded by its credential's session, which a renewal under the same identifier extends and the side may end.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Refusing a credential that does not hold refuses the call that renews it, and an `OPAQUE` presented by default fails every call in flight across a rotation  | Accepted: `OPAQUE` is presented per call only, and a default credential is withdrawn once refused, the application told.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The conformance files cannot play a transport's credential, a relay's table or a lifetime                                                                    | Accepted: a step says what the transport carried, another advances the server's clock, `JWT` verdicts are vectors, and two vectors of header length are added; the relays play in the conversations and `Authorization` in the transports' file.                                                                                                                                                                                                                                                                                                          |
| A header of 1,020 bytes passes the limits: the writer's code, 12.2's minimum and the relay's fixed header                                                    | Accepted: `PAYLOAD_TOO_LARGE` at the writer, limits of 1,024 bytes at least with a `JWT`, an opening of one byte at least, and leg B's header counted call by call.                                                                                                                                                                                                                                                                                                                                                                                       |
| `SESSION` flags what is often no session, `ENDED` is no scheme, and a bare scheme is a URI's                                                                 | Accepted: the flag is `CREDENTIAL`, its first field the credential scheme, 0 is `NONE`, 2 is `JWT`, and section 13.1 names the two sessions.                                                                                                                                                                                                                                                                                                                                                                                                              |
| The spec's version moves in this change, against 0008, and the list misses what the change contradicts                                                       | Accepted: the version moves in the release commit ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                |

### RS256, weighed and withdrawn

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

### With the clock and the timeouts ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md), [0012](0012-a-listen-held-is-not-silence.md))

| Objection                                                                                                                          | Answer                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The relay's default admission is stated two ways, and the code's default, `requireSession`, refuses every `JWT` it forwards        | Accepted: `requireSession` tests the call's session alone; the relay's default, under one name on both sides, admits leg A's connection's session, a `JWT` or a carried `ELSEWHERE` by its scheme, and lets any `JWT` past step 1, a cost stated. |
| `verifies` checks a `JWT` against its destination's audience at a step that runs before the destination is known                   | Accepted: the relay verifies at step 1, before `beforeRoute`, against the audiences its registrations hold, and step 5 holds `aud` to its destination's own.                                                                                      |
| Which data a call's session carries is unstated once two calls resolve to one identifier                                           | Accepted: a call carries its own credential's data, a `JWT`'s claims set; a side keeps per identifier the later end and the subscriptions.                                                                                                        |
| A `JWT` call's order turns on whether a platform's crypto is synchronous, and the two sides' crypto differs                        | Accepted: a `JWT` or an `ELSEWHERE` resolves in a later turn on every side, and a resolution that settles once its call ended is dropped.                                                                                                         |
| With one subscription per procedure and per connection, a second session on the connection subscribes to nothing and is never told | Accepted, per session: section 11.3 holds one subscription per procedure and per session, a connection's session and a call presenting none counting as one.                                                                                      |
| The interop service cannot play the conversations listed, and the identifier that ending a session takes has no form               | Accepted: an identifier is a record of its scheme and its claim, compared octet for octet; the service has two issuers, a key set, an `ELSEWHERE` verifier of stated words, and a procedure that ends a credential's session.                     |
| What the client and the transport add is named nowhere, against the record's rule that the surface is named alike                  | Accepted: `credential` among the client's and a request's options, `credentialWithdrawn`, and the transport's credential carried with its envelope as one argument.                                                                               |
| Nothing says which string of `Authorization` reaches the verifier, and the two HTTP servers read a repeated field differently      | Accepted: the field's value whole, its whitespace removed; an empty one carries none, two are refused 400, `malformed`, and a relay writes it as it came, each a case of the transports' file.                                                    |
| What lands gives a `JWT`'s verification no section of the spec, and misses places the record changes                               | Accepted: 13.8 verifies a `JWT` and names its verdicts, and 13.9 ends a credential's session.                                                                                                                                                     |
| A credential's session that bounds no subscription is still kept and timed, a timer for every `JWT` call                           | Accepted: a credential's session is kept, and its end timed, only while it bounds a subscription.                                                                                                                                                 |
| A client that sends a bearer credential in the clear off the machine is given no code                                              | Accepted: it fails the call before it goes, `DESTINATION_UNREACHABLE`, and the credential stays.                                                                                                                                                  |

### Implemented whole

| Objection                                                                                                                                             | Answer                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A session whose end has passed as a subscribing call keeps it is ended inside that call, its failure before its result, on one side                   | Accepted: such an end is taken in a turn of its own, past the answer that kept it, and a call still owed its answer is never ended under it, on both sides.                                                       |
| A relay whose `beforeRoute` is `requireSession` answers a forwarded credential `SESSION_REQUIRED`, and every client withdraws a credential that holds | Accepted: an admission never answers `SESSION_REQUIRED` to a call that presented a credential; `requireSession` refuses it `ACCESS_DENIED`.                                                                       |
| The key set is asked for any `iss` an unauthenticated peer writes, before a signature is checked                                                      | Accepted: it is given with the issuers it answers for, and asked for those alone.                                                                                                                                 |
| A `kid` another issuer's key names keeps the key set from being asked for the token's own issuer                                                      | Accepted: the key set is asked when no key of the token's issuer names its `kid`.                                                                                                                                 |
| A key set's ask that never settles blocks its issuer for good                                                                                         | Accepted: an ask is given a signal its deadline aborts, and one unsettled then has failed; a call's cancel leaves the ask it waits on.                                                                            |
| The keys a key set answered are held until its next answer, so a key its issuer withdrew verifies for good                                            | Accepted: they are held ten minutes, past which a token waits on a new ask before they serve.                                                                                                                     |
| Keys given without an audience refuse every `JWT`, the application's fault charged to the token                                                       | Accepted: they are refused as the side is built.                                                                                                                                                                  |
| A server cannot say that TLS stands in front of it                                                                                                    | Accepted: its application says so, `secure`, `Secure`, and is believed whatever the server listens on.                                                                                                            |
| Any peer can spend an issuer's minute, and a new `kid` is then refused and its credential withdrawn                                                   | Accepted: a `kid` that comes while the minute runs waits for the ask its deadline lets go, and only an answer to an ask that went after the token came refuses it.                                                |
| Ending a session by its identifier is cited as a revocation, while the token is taken again at once                                                   | Accepted, as an end: it ends the session and its subscriptions and nothing else, the citation of RFC 7009 goes, and the interop service's procedure is `endSession`; a revocation would be a decision of its own. |
| A default set again to the same token is withdrawn on one side and kept on the other                                                                  | Accepted, the other way than proposed: the token was just found not to hold, so both sides withdraw a default while it is still, by value, the credential the refused call presented.                             |
| A resolution that settles once its router is disposed runs a resolver on one side                                                                     | Refused for its premise: both sides abort every call that resolves as their router is disposed, which a twin test holds.                                                                                          |

### The answers to the fourth round

| Objection                                                                                                                                                                             | Answer                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `kid` that waits for its issuer's deadline holds its call and its payload a minute at any peer's will, since step 4 comes before the signature, and nothing bounds how many         | Accepted: at most so many calls wait for an issuer's deadline at once, given with the key set, 64 by default; one past them is refused `CAPACITY_EXCEEDED`, which withdraws nothing and is not reported. |
| The rule that an admission never answers `SESSION_REQUIRED` to a call that presented a credential lives in two wrappers, not in the router, so a resolver registered on it escapes it | Accepted: each router applies it where it answers an admission, whatever the handler.                                                                                                                    |
| One side reaches a key set's deadline when its timer fires, the other when the monotonic reading passes it, so a late timer gives two answers                                         | Accepted: a deadline is reached on the reading wherever a side reads the state, and section 13.8 says which ask a call that comes past it is judged by.                                                  |
| A token without a `kid` never has the key set asked while nothing is held for its issuer, so at a cold start it is refused and its credential withdrawn                               | Accepted: it waits on its issuer's keys while none of them serve, as an unnamed `kid` does.                                                                                                              |
| A call that leaves a key set's wait is removed from a list under one lock, so many leaves stall every verification                                                                    | Accepted: the waiters leave in constant time, on both sides.                                                                                                                                             |
| The conversations that pin the minute pass a side that asks at once for every `kid` it does not know                                                                                  | Accepted: a call answered at once inside each wait, and the minute pinned by an issuer whose second ask answers no key.                                                                                  |
| A session verified under a key its issuer withdrew lasts until the `exp` whoever holds the key chose                                                                                  | Accepted: the application ends every credential's session of an issuer, on every connection that keeps one, as when a key of its leaks.                                                                  |

### The bound on waiting calls

| Objection                                                                                                                            | Answer                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The bound counts the calls on an ask under way as well, so valid tokens are refused at every start, and every ten minutes under load | Accepted: only the calls that wait for a deadline count, checked as a call starts to wait for it or an answer moves it there; a call on an ask under way waits as long as the key set takes, its deadline bounding it. |
