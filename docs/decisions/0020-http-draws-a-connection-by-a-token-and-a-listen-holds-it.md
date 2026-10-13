# 0020 — HTTP draws a connection by a token, and a listen holds it

- **Status**: accepted
- **Scope**: the protocol, and every implementation's HTTP transport: the HTTP part of section 15 of
  [`spec/spec.md`](../../spec/spec.md). What every transport owes is
  [0001](0001-the-envelope-sits-at-fixed-offsets.md)'s, a connection's timeouts
  [0012](0012-a-listen-held-is-not-silence.md)'s, and the credential a transport carries
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s.

## Context

Bead's router, its sessions and its relays work on connections. A WebSocket and a Web Worker give
one, with its order and a single copy of each message. HTTP gives exchanges, which keep no
connection and race one another, and a server can send nothing its client did not ask for: what a
server sends of its own, a notification or a command, has no exchange to go on.

## Decision

**Over HTTP, the transport draws a connection.** It draws a 16-byte token from a cryptographic
source when a client connects, and the client presents it on every exchange. The router, the
sessions and the relays see a connection, as over a socket, and the token names the connection and
nothing else: a call presents its session or its credential in its own header, or in its exchange's
`Authorization` ([0010](0010-a-request-presents-a-credential-of-a-scheme.md)). The token is worth
the session its connection holds: it crosses what its exchanges cross, off the machine TLS being the
deployment's, and in the clear it gives away no more than the exchanges it rides on, the session
token they carry among them; no URL, handle, detail or log carries it.

**HTTP's transport reads three things of an envelope and nothing else**, its layout, its kind and
its call id, in the prefix every layout keeps ([0001](0001-the-envelope-sits-at-fixed-offsets.md)),
to hand an answer to the exchange that carried its request, as HTTP/2 hands a frame to its stream by
an id at a fixed offset (RFC 9113 §4.1). An exchange waits only for the answer to a request of the
peer's parity; any other ends at once and empty, a cancel's included, so a cancel is still never
answered. An exchange lost closes the connection at both ends, as a socket that drops does, and a
client's send settles on the head of its answer, so a relay still tells a request never tried,
refused by a status the transport marks as its own, from one lost after, which any other status is:
an intermediary's may come once the request ran.

**What the server sends of its own waits for a listen.** It waits, numbered, in the connection's
outbox, for its client to listen: to ask for it by an exchange of its own, at the connection's one
URL, its acknowledgement and its wait in fields of its own
([0029](0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md)), which the server
holds until something comes, long polling as RFC 6202 lays it out rather than a response held open.
Each listen acknowledges what its client heard whole; what it did not comes again, as a stream's
lost frames are sent again (RFC 9000 §13.3). The client reads a batch as it comes and bounds each
envelope alone, as HTTP/2 bounds its frames and never its streams (RFC 9113 §4.2).

**A client says at connect, once for the connection's life, whether it listens**, and the server
says it back, as a WebSocket subprotocol is chosen once (RFC 6455 §4.2.2): to one that does not
listen, a request that opens a subscription is refused, `SUBSCRIPTION_UNSUPPORTED`. A transfer,
whose credit would have to come back as its request goes, is not taken.

## Consequences

**A cancel that overtakes its request is HTTP's to bury**: exchanges race, so the transport of the
side that answers buries the call id for the least a requester reserves one, and drops the request
that comes under it ([0001](0001-the-envelope-sits-at-fixed-offsets.md)).

**A failure can come before the result its call waits for**: a failure that ends a subscription
comes in a listen's batch, the result that answered its call in a `POST`'s body, and the two race.
The client fails the call with the failure, and reports the result that follows as `CALL_UNKNOWN`
(spec 15.9). The failure withdraws no default: a call's own answer comes in its `POST`'s body alone
(spec 13.4, 15.9; the round in [0010](0010-a-request-presents-a-credential-of-a-scheme.md), Security
for 0.2.0).

**A connection lives as long as its client listens or speaks**: silence is counted between listens,
never while one is held ([0012](0012-a-listen-held-is-not-silence.md)).

**A stop draws no connection and holds none**: once its stop began, a server refuses a connect 503
`busy`, its `Retry-After` 1, and answers an exchange that presents a token the 404 marked
`connection-unknown`, as it answers each listen it holds (spec 15.7;
[0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)).

**A transport that keeps no connection states, in a record of its own, what stands for one there**:
what it reads of an envelope, and what it gives of order and copies.

**The rule is the HTTP part of section 15 of [`spec/spec.md`](../../spec/spec.md)**, and
`spec/transports.json` plays it over real sockets against every implementation's server
([0004](0004-one-behaviour-in-every-language.md)).

## The Tenth Man

The order of HTTP's outbox and of its exchanges, and a failure that comes before its call's result
(spec 15.9), met the Tenth Man with a transport's order and copies, whose round
[0001](0001-the-envelope-sits-at-fixed-offsets.md) keeps. That such a failure withdraws no default
met it with the transport's security, whose round
[0010](0010-a-request-presents-a-credential-of-a-scheme.md) keeps, Security for 0.2.0.
Section 15.6's rows at a WebSocket's address, and RFC 9112 §3.2 on both transports, met it with a
WebSocket's handshake, whose round [0010](0010-a-request-presents-a-credential-of-a-scheme.md)
keeps, On a WebSocket server's answer to a malformed handshake.
A stop crossed by an arrival, over HTTP and at a WebSocket's address, met it with a transport's
listener that throws, whose round
[0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md) keeps.
Where a listen names its acknowledgement and its wait met it with the listen's fields, whose round
[0029](0029-a-listen-names-its-cursor-and-its-wait-in-fields-of-its-own.md) keeps.
What the token is worth in the clear met it in a round of its own:

### On the token in the clear

| Objection                                                                                                                                                                                                                                                                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client opt-in for plaintext off the machine breaks every plaintext deployment to protect a session that 13.4 already keeps free of bearer credentials. RFC 6750 allows "equivalent transport security", which a scheme cannot show, 0020's sentence would stay false, and the gRPC precedent is misread | In part: no opt-in; the text says what holds. A connection's session can be opened by a procedure that checks credentials (spec 13.1), so it may carry authority, but the clear exposes it whatever the token: the session's `OPAQUE` token is announced and presented on the same exchanges (spec 13.3), and over `ws://` the socket is the connection, with no option at all. So an opt-in would guard nothing the clear does not already give away. Spec 15.4 and this record say what the token is worth in the clear, that TLS off the machine is the deployment's, and that every bearer credential crosses only TLS (spec 13.4) |
