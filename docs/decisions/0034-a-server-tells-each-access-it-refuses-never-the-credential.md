# 0034 — A server tells each access it refuses, never the credential

- **Status**: accepted
- **Scope**: the protocol, and every implementation's server routers, relays and server transports:
  in [`spec/spec.md`](../../spec/spec.md), 13.12, which 9.2's step 6 and 14.3's step 1 cite, and
  15.1's address and port handed beside each envelope; `spec/vectors.json`'s `credentialRefusals`.
  What a request presents and how its credential resolves are
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s; a refusal a server's transport
  judges of its own, and what it tells of one,
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)'s; the
  guard a listener is called within,
  [0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)'s.

## Context

**A refusal judged on a request's header is the router's alone to tell.** A credential's verdict
knows why it does not hold — the step of 13.8 that refused a `JWT`, a verifier that made no session
of an `ELSEWHERE` — and the wire carries the code alone, `SESSION_REQUIRED`, `ACCESS_DENIED` or
`CREDENTIAL_UNSUPPORTED`. The admissions Bead ships refuse on the application's behalf, with no
place for it to log them: `requireSession`, `requireCredential`, every server relay's admission by
default, `shareLegBSession`, and a relay with no `beforeRoute`, which admits nobody. Without an
event, an operator reads a count, `bead_server_handled_total{code="SESSION_REQUIRED"}`, and a trace
that names the scheme alone, so a scanner's tokens, a stolen token replayed and an admission that
refuses a whole tenant pass unseen. A client tells its own side, its default withdrawn, by its
scheme alone (spec 13.4).

**The standards.** OWASP's ASVS 5.0,
[V16](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md):
§16.3.1 has every authentication operation logged, successful and unsuccessful; §16.3.2, failed
authorization attempts; §16.2.1, each entry with when, where, who and what; and credentials never
logged. OWASP's Logging Cheat Sheet keeps session identifiers, access tokens and passwords out of a
log; CWE-117 neutralizes what a log is given, CWE-532 keeps sensitive information out of it.

**Where a refusal came from, over HTTP.** `clients` names a connection's connect, its address and
its port, while each `POST` of that connection may come by another socket or another proxy's walk, a
stolen token among them; a transport's own refusal names its exchange's
([0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)).

**The options weighed.** Widening 0026's tell: its refusals are the transport's, judged before any
envelope, where these are the router's, judged on a request's header, and the two are told by
different parts, with different fields. Leaving an admission's refusal untold as the application's
own verdict misses the admissions Bead ships, which an application has nowhere to log. Telling a
refused token's `iss` and `sub`: they are the requester's text, and personal data.

## Decision

**A server's router tells each access it refuses**, `accessRefused` on the TypeScript side
(`RouterServerEventMap`), `AccessRefused` on the C# side (`RouterServer`), its record
`IAccessRefusal`, `AccessRefusal`, named alike (spec 13.12):

| Member                                      | What it holds                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `stage`                                     | `credential` (9.2's step 6.1 or 6.2, 14.3's step 1.1 or 1.2) or `admission` (9.2's step 6.3, 14.3's step 1.3)                              |
| `code`                                      | the failure answered: `CREDENTIAL_UNSUPPORTED`, `SESSION_REQUIRED`, `ACCESS_DENIED`, or another of the admission's block                   |
| `reason`                                    | at the credential's stage, one word of a closed list; at the admission's, the Bead admission that refused; absent for an application's own |
| `credentialScheme`                          | the scheme its header named, a number to come among them                                                                                   |
| `serviceId`, `procedureId`, `destinationId` | what was called, numbers of its header; the destination's for a relayed call                                                               |
| `connectionHandle`                          | the connection the request came on                                                                                                         |
| `address`, `port`                           | the refused request's own: over HTTP its exchange's, read as 15.12 reads it; over a WebSocket its connection's; none over a Web Worker     |

**Why is one word of a closed list, which both sides read from `spec/vectors.json`.** For a `JWT`,
the step of 13.8 that refused it — `token`, `crit`, `typ`, `kid`, `alg`, `key`, `signature`, `iss`,
`exp`, `nbf`, `aud`, `sid`, `sub` — as `jwtVerdicts` give them; for an `OPAQUE`, `session`; for an
`ELSEWHERE`, `nothing-carried`, `verifier`, its verifier having made no session of it, or `end`, its
end come as it settled; for a scheme the side takes none of, `scheme`. At the admission's stage, the
admission the spec names that refused, `requireSession`, `requireCredential` or `shareLegBSession`,
or `no-before-route` for a relay that has none, and none for the application's own. Each
credential's resolution hands its verdict's reason on to the router. `credentialRefusals` gives
every refusing situation but a `JWT`'s with its reason, shaped as `jwtVerdicts` are: the scheme, the
situation both sides' tests set up, the code and the word.

**Never the credential**, any part of it, nor a claim of a token, nor an admission's detail, which
is the application's text (CWE-117, CWE-532). **Never a success**: every call that resolves reaches
its admission and its resolver with its session, which is where an application's own record of it
belongs.

**Told in the turn the refusal is answered**, under 15.1's guard
([0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)),
its record built only while a listener listens
([0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md),
[0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)): a listener that throws is reported
with its connection, and the refusal answered as it would be. Not for a verifier or an admission
that fails, `PROCEDURE_FAILED`, which is reported (spec 9.0), nor for a call past those let wait for
an issuer, `CAPACITY_EXCEEDED` (spec 13.9): nothing was refused there. A client's router tells none.

**The transport hands the address.** Each envelope a server's transport hands on carries, beside
what it carried of a credential, the address and port of what brought it — over HTTP its exchange's,
read as 15.12 reads it, whichever socket or proxy brought its connect; over a WebSocket its
connection's; none over a Web Worker — on the TypeScript side's `ITransportMessage` and the C#
side's `TransportMessage` alike, and 15.1 says so.

## Consequences

**An application chooses what it writes, and at what rate**: a scanner's every token is an event, as
0026 accepted of every refused request, and a listener that writes each to a log bounds its own
rate. **Every envelope a server's transport hands on is wider by an address and a port**, which a
Web Worker leaves empty. **A `JWT` refused names the step that refused it**, which tells an operator
a key rotated from a clock skewed, and tells a scanner nothing it is answered.

**The gate.** `spec/vectors.json`'s `credentialRefusals`, which both sides' twins play as they play
`jwtVerdicts`, and `jwtVerdicts` themselves for a `JWT`'s reasons; no step of
`spec/conversations.json` tells it, the event being no part of the wire. Twins by the same
sentence ([0004](0004-one-behaviour-in-every-language.md)): each server router's `tells each access
it refuses, its stage, its code, its reason and what was called, with the connection and the
request’s address and port, never the credential`, `tells a JWT refused by the step of section 13.8
that refused it, for every verdict of spec/vectors.json that refuses`, `tells each credential
refused by the reason spec/vectors.json’s credentialRefusals gives it`, `tells the admission a relay
or a procedure refused with, by its name, no-before-route for a relay with none, never its detail`,
`tells nothing of a verifier or an admission that fails, or of a call past those let wait for an
issuer` and `refuses as it would though an accessRefused listener throws, the throw reported with
its connection`; and each HTTP server's `tells over HTTP the address and port of the exchange
refused, not its connect’s`. `docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at
xhigh effort, in one round with [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s, whose rows
on the bounds that record keeps. It met three objections on an access refused, each claim checked
against the code and ASVS 5.0's text: three accepted, none refused. The user decided that the event
is a record of its own rather than a widening of
[0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md). Each
objection, with the answer that holds:

### On an access refused, told

| Objection                                                                                                                                                                                                                                                                                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaving an admission's refusal untold as "the application's own verdict" misses the admissions Bead ships — `requireSession`, `requireCredential`, `shareLegBSession`, a relay with no `beforeRoute` — which an application has nowhere to log; ASVS 5.0 §16.3.2 asks for failed authorization attempts, and §16.3.1 for every authentication operation, successes among them. | Accepted. The event is `accessRefused` / `AccessRefused`, its `stage` `credential` or `admission`, its `code`, and for a Bead admission its name as `reason`, never its detail nor a claim; it carries what was called, the "what" of §16.2.1. 13.12 cites §16.3.1 and §16.3.2 and says a success is the application's to log, since every call that resolves reaches its admission and its resolver with its session. |
| Over HTTP the address and port the event reads from `clients` are the connect's, while each `POST` may come by another socket or another proxy's walk, a stolen token among them: the "where" is not the refused request's, and differs from 0026's.                                                                                                                           | Accepted. A server's transport hands each envelope on with the address and port of what brought it — over HTTP its exchange's, read as 15.12 reads it; over a WebSocket its connection's — beside what it carried of a credential (`ITransportMessage`, `TransportMessage`), and the event names those; 15.1 says so; a twin holds an exchange's address apart from its connect's.                                     |
| The reasons outside a `JWT`'s steps — `session`, `nothing-carried`, `verifier`, `end`, `scheme` — live in no file both sides read, so twins pass when the spellings differ. Name each refusing input and its reason in `spec/vectors.json`.                                                                                                                                    | Accepted. `spec/vectors.json` holds `credentialRefusals`, shaped as `jwtVerdicts`, each situation and its reason, which both sides' twins play; the `JWT` reasons stay `jwtVerdicts`'.                                                                                                                                                                                                                                 |
