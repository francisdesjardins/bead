# Bead: transcoding

What a gateway of Bead answers over HTTP of a service's procedures, stated once. The key words
"MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED",
"NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
[BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)]
[[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all
capitals, as shown here.

This document is a companion of [`spec.md`](spec.md), which states the wire, as
[`debugging.md`](debugging.md) is: a gateway is beside the wire, never in place of it, one more
client of a server, and a side may offer none. Sections 2 to 10 each name the conformance file that
checks them, [`transcoding.json`](transcoding.json), whose entries play the messages and the service
of `spec/transcoding.proto`, and the messages it imports from `spec/transcoding-required.proto`, of
edition 2023, whose fields protobuf requires; sections 11 and 12 name none: the builder's tests hold
the document it writes, and each side's twin tests its client. Each entry cites the units it checks,
which [`transcoding-units.txt`](transcoding-units.txt) lists, each cited or why no entry cites it,
with the hash of its text. The why of each rule is in the decisions:

- [0037](../docs/decisions/0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md):
  the whole of it;
- [0036](../docs/decisions/0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md):
  the in-memory transport and the joined transport a gateway calls through (2.2);
- [0010](../docs/decisions/0010-a-request-presents-a-credential-of-a-scheme.md): the credential a
  call presents (2.4, 2.5);
- [0016](../docs/decisions/0016-a-json-payload-has-one-form-whichever-side-writes-it.md): the
  tokens a gateway writes (5.6, 7.2);
- [0031](../docs/decisions/0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md):
  the binary payload, its stock library's (5.2, 5.6);
- [0035](../docs/decisions/0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md):
  a request its rules refuse, answered with its violations (7.4);
- [0042](../docs/decisions/0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md):
  a request that leaves a required field unset, refused where its server would refuse it, and where
  it is placed (4.5, 5.2, 5.6, 7.4, 11);
- [0002](../docs/decisions/0002-a-subscription-goes-at-its-clients-pace.md): a stream at its
  reader's pace (8.8);
- [0024](../docs/decisions/0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md),
  [0027](../docs/decisions/0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)
  and [0030](../docs/decisions/0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md):
  the hosts, the origins and the proxies its gates take (10.1);
- [0022](../docs/decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md):
  the blueprint its routes come from, and the document its builder writes (3.9, 11).

**Version: 0.2.0**. Its conformance file repeats it as its `transcodingVersion`, and follows its
schema in [`schemas/`](schemas/). It moves by `spec.md`'s rule, under a version of its own
([0008](../docs/decisions/0008-three-version-axes-and-names-qualified-by-their-owner.md)): the minor
when a gateway that conforms to its last version must change to conform to this one, the patch when
one that conforms passes unchanged. **Status: every section is written.**

## 1. Conformance

1.1. A _gateway_ is an HTTP server that answers a service's procedures as routes of HTTP, each call
it takes made through a client of `spec.md`, one more client of the server that answers it. A side
that offers a gateway conforms to this document for it; a side that offers none conforms to
`spec.md` alone, and the support matrix, [`docs/support.md`](../docs/support.md), says so.

1.2. A gateway is beside the wire: what it answers over HTTP never changes what goes on a Bead
connection, and its server holds its calls to every section of `spec.md` as any client's — their
admission, their sessions, their bounds, their payload's rules (section 18 of `spec.md`), their
trace and their counts (`debugging.md`).

1.3. This document names what `spec.md` states by its sections, "section 13.4 of `spec.md`", and
what it states itself by its own, "section 3.5"; a code by its name, as section 8.1 of `spec.md`
writes it; an HTTP status by its number, and a field by its name in lower case, as HTTP/2 writes
one. What a gateway answers comes from its service's definitions: its procedures, their kinds,
their bindings and their admissions, and each method's `google.api.http` rules and
`idempotency_level`, as a builder reads them into its blueprint and the route table it generates;
what a gateway is given at run time is what this document names its options.

## 2. Connections

_Transcoding: `spec/transcoding.json`._

2.1. A gateway MUST draw one Bead connection for each HTTP exchange it takes, as the exchange's
request passes the gates of section 10.1, and MUST close it once its response ended: written whole,
cut, or its client gone. It MUST NOT carry the calls of two exchanges on one connection: what
`spec.md` binds to a connection — its session (section 13.1), a subscription by procedure and
session (section 11.3), the calls it answers at once (section 12.2), its transfers, the address a
refusal tells (section 13.12) — is so one caller's.

2.2. In process, a gateway's connections cross an in-memory transport (section 15.13 of `spec.md`)
into its application's own server, which takes them beside its other transports through a joined
transport (section 15.14), so its calls meet that server's router, admission, sessions and service
manager, each service offered once. A gateway MAY instead connect to its server over another
transport, as a proxy apart; this document states what either answers.

2.3. A gateway's client MUST hand its transport, with each request, the address and the port of
its exchange's client, the address read as section 15.12 of `spec.md` reads a client's behind
`trustedProxies` and `unnamedProxies`, so that what its server tells of a refusal names them
(section 13.12).

2.4. A gateway reads a request's `authorization` field as section 15.5 of `spec.md` reads a `POST
/bead`'s: whole, its auth-scheme included, its surrounding white space removed, and none when it is
empty or absent. Its option `authorization` says what a call presents of it:

| `authorization`         | What a call presents                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elsewhere`, by default | `ELSEWHERE`, the field's value carried beside the request, as `POST /bead` carries one (section 15.5 of `spec.md`); its server's verifier makes of it what its application trusts (section 13.11)                                                                                                                            |
| `bearer-jwt`            | a `JWT`, the token of a `Bearer` field ([RFC 6750 §2.1](https://www.rfc-editor.org/rfc/rfc6750#section-2.1)), its auth-scheme in any case, in the request's `CREDENTIAL` block, which its server verifies (section 13.8); a field of any other auth-scheme is answered 401, a token the block cannot hold (section 4.4), 431 |

A gateway never reads a token to choose between them: its application chooses, once.

2.5. A request with no credential presents none, and its call runs in its connection's session,
which a connection drawn for one exchange never holds: a procedure whose admission needs a session
answers `SESSION_REQUIRED`. A gateway MUST NOT present `OPAQUE`: a connection's session that an
answer announces (section 13.3 of `spec.md`) is the gateway's to keep, never written to its HTTP
client, and ends as its exchange's connection closes (section 13.7). A gateway reads no credential
from a cookie or from a request's query, as section 15.2 has every server read none from them.

2.6. A gateway's client offers no command: a command its server sends on an exchange's connection
is answered `SERVICE_UNKNOWN` (section 9.2, step 5, of `spec.md`), since that client declares no
resolver of any service, so step 5 stops at the service. The code follows what the gateway's client
declares: a gateway that offers a command of a service has that service's other commands answered
`PROCEDURE_UNKNOWN`, by the same step.

## 3. Routes

_Transcoding: `spec/transcoding.json`._

A route is a method and a template, `http.proto`'s
([googleapis](https://github.com/googleapis/googleapis/blob/14a161a98ef045be80c12ab69d924504a756f109/google/api/http.proto)):
a template is a path of segments, each a literal, `*`, `**` or a variable, and an optional verb
after a `:`.

3.1. A gateway answers each procedure of its definitions that a client calls, of the kind
`request` or `notifies` (section 16.11 of `spec.md`), and no `command`.

3.2. A gateway MUST answer, for each procedure a client calls, `POST` at its default route: its
prefix, `/`, its service's name, `/`, its procedure's name, as its definitions write them, matched
exactly; and `GET` and `HEAD` there for a procedure whose definition gives it `idempotency_level`
`NO_SIDE_EFFECTS`, unless its request holds a field the query cannot carry (section 4.3). It MUST
answer each route its definition's `google.api.http` rules give, as `http.proto` states them, a
`custom` rule excepted.

3.3. A default route's prefix is `/api` unless its definitions give another: `/` and one or more
segments of letters, digits, `-`, `.`, `_` and `~`, none empty, `.` or `..`, with no `/` at its end.
A path is case-sensitive
([RFC 3986 §6.2.2.1](https://www.rfc-editor.org/rfc/rfc3986#section-6.2.2.1)), and since
section 16.6 of `spec.md` makes two names one by their ASCII case, no two default routes part by
case alone. A default route's body is its request whole, as `body: "*"` has it, and its `GET`'s
query every field of its request.

3.4. A rule's pattern is `get`, `put`, `post`, `delete` or `patch`, its method that name in upper
case, and each of its `additional_bindings` is a rule of its own, in their order. A rule is served
beside its procedure's default routes, never in place of them. A `get` rule is served as written,
whatever its method's `idempotency_level`, its author's word that its method reads
([RFC 9110 §9.2.1](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.1)), and the gate of section
10.1, step 5, holds it where its method is not marked so. A gateway MUST answer `HEAD` at each route
it answers `GET` at, as that `GET`, without its content
([RFC 9110 §9.3.2](https://www.rfc-editor.org/rfc/rfc9110#section-9.3.2)).

3.5. Where more than one route of one method matches a path, a gateway MUST answer by the one that
comes first when their templates are compared segment by segment from the first: at the first
segment where they differ, a literal before `*`, and `*` before `**`; a template that ends where the
path ends before one whose `**` takes no segment there. A gateway MUST refuse, as it is built, a
route table that holds two routes of one method that tie under this order, one template up to its
variables' names, naming both: a table is a list, which two tables built apart may join with a tie
no builder saw (section 3.9).

3.6. A gateway MUST read a request's target raw: its path as it came, its query apart after the
first `?`, never normalized, no dot segment removed and nothing percent-decoded before the match
([RFC 3986 §6.2.2](https://www.rfc-editor.org/rfc/rfc3986#section-6.2.2)). A path with an empty
segment, `/` alone among them, which is one, or a segment that is `.` or `..`, raw or once
percent-decoded, matches no route, a `**` of none among them. A literal matches a segment that is
its text exactly, `*` one segment, and `**` zero or more, as `http.proto` has it, its template's
last but its verb. A target that holds an octet other than visible ASCII, or a path whose
percent-decoding holds NUL, is what HTTP refuses of its own (section 10.1, step 1), answered as
section 15.12 of `spec.md` answers it — 400 unmarked over HTTP/1.1, its stream reset over HTTP/2 —
before anything else of it is judged; `#` and the other visible characters a URI leaves out are
characters of its path or its query, matched and decoded as any other.

3.7. A path's verb is what follows the last `:` of its last segment that is not percent-encoded, and
that segment is matched without it; a path whose last segment holds no such `:` has none. A route
with a verb matches a path of that verb alone, and a route without one a path that has none, so a
single-segment variable's value encodes each `:` it holds, as `http.proto` has it.

3.8. A variable takes the segments its pattern matches, `*` where it gives none, by `/`. A
single-segment variable's value is its segment percent-decoded whole; a multi-segment variable's —
one whose pattern holds more than one segment, or `**` — is its segments percent-decoded but each
`%2F` and `%2f`, which stays as it came, as `http.proto` has it. A gateway MUST refuse, 400
`PAYLOAD_UNDECODABLE`, a value whose decoded bytes are not UTF-8, and a `%` that two hexadecimal
digits do not follow.

3.9. A builder of a gateway's routes MUST refuse, each by its rule, a template off `http.proto`'s
grammar — a `**` that is not its last segment, a variable within a variable, one that takes the
leading `/`, a literal that is no segment —; a variable whose field path names no field, passes a
repeated field, or ends at a repeated, a map or a message field; a `body` that names no top-level
field or one a variable binds, or that comes on a `get` or a `delete`; a `response_body` that names
no top-level field of its result; a `custom` rule, and an `additional_bindings` within one; a rule
on a `command`; a variable, a `body` other than `*`, a `get` or a `delete` on a request that is not
`proto`, and a `response_body` on a result that is not; two routes of one method that tie under
section 3.5, one template up to its variables' names; and a rule at `/openapi.json`, at the path of
its HTTP transport, or at a default route's template.

3.10. A gateway MUST answer 404, `path-unknown`, a request whose path no route matches, and 405,
`method-refused`, one whose path only routes of other methods match, its `allow` naming the methods
its path's routes take ([RFC 9110 §15.5.6](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.6)),
each once, in this order, by ", ": `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`.

## 4. Binding

_Transcoding: `spec/transcoding.json`._

4.1. A gateway binds a request from its route's variables, its query and its body into one JSON
value of its request's message, each value made first the JSON that section 5's mapping reads, then
read with the body's, so that one reader judges every field wherever it came from. A field set by
two of them is refused, 400 `PAYLOAD_UNDECODABLE`, as is every refusal of this section but the one
section 10.1 judges first.

4.2. A variable binds the field its field path names, by its proto names through non-repeated
message fields, a scalar field that is not repeated, its value made the field's JSON:

1. a string's, a JSON string of its value;
2. a number's, a JSON string of its value, which section 5.3 reads as it reads a number given so;
3. a `bool`'s, `true` or `false` where its value is that word, a JSON string of it otherwise;
4. an enum's, a JSON number where its value is of `-?(0|[1-9][0-9]*)`, a JSON string of it
   otherwise;
5. `bytes`', a JSON string of its value, which section 5.3 reads as base64.

4.3. A route's query binds every field its variables and its body leave, when it has no body or
one that names a field; under `body: "*"`, a gateway MUST refuse a request with any parameter. It
reads the query as the WHATWG URL Standard's `application/x-www-form-urlencoded` parser reads one —
its sequences by `&`, an empty one skipped, a name and its value at the first `=`, `+` a space, then
percent-decoded — and refuses a name or a value whose decoded bytes are not UTF-8. A parameter's
name is a field path of the request's message, each field by its JSON name or its proto name, by
`.`, through non-repeated message fields; its value, the field's JSON as section 4.2 makes it:

1. a scalar field takes one parameter, and a repeated scalar field one an item, in their order;
2. a `Timestamp`, a `Duration` or a `FieldMask` (section 5.4) takes one parameter, a JSON string
   of its value, as section 5.4 reads its form, and a wrapper one, its value made as section 4.2
   makes its scalar's;
3. a gateway MUST refuse a name that is no such field path, a field named twice, by one name or by
   its two, but a repeated scalar, and a parameter that names a map, a repeated message, any other
   message, or a field its variables or its body bind.

4.4. A route's body: under `body: "*"`, the request's JSON, less the fields its variables bind,
which a member naming one refuses but where it is `null`, which sets nothing (section 5.2, item 2);
under a field's name, that field's JSON, an array for a repeated one, a `null` that field unset, so
that a `null` body is refused only where it is the request whole. A route with no body takes no
content: a gateway MUST refuse a request to it that carries any, 400 `malformed`, as section 10.1's
step 8 judges it. A `proto` body is one JSON text, read whole, so an empty one is refused.

4.5. Where a `patch` rule's `body` names a message field of its request, and that request has a
field `update_mask` of `google.protobuf.FieldMask` that neither its query nor its body sets, a
gateway MUST set it to the paths of the members its body's object holds, none where its body is
`null`, as [AIP-134](https://google.aip.dev/134) has an omitted mask stand for what was sent: a mask
set on the message once its value is read (section 5.2), by proto names, never read back through
section 5.4's form; each member by the proto name of the field it names, in the body's order; a
member whose value is an object of a message field that is not a well-known type, by its own
members' paths in turn, behind its name and a `.`, or by its own path where it holds none; a member
of any other field, a map, a repeated field, a well-known type or a `null` among them, by its own
path. A field of `LEGACY_REQUIRED` presence of the body's message is among its paths whenever
section 5.2 takes the request, since that section refuses a body that leaves one unset. A caller
keeps such a field unchanged only by an `update_mask` of its own ([AIP-203](https://google.aip.dev/203)
marks a field required by `field_behavior`, not by protobuf's presence, for this reason).

## 5. The JSON form

_Transcoding: `spec/transcoding.json`._

5.1. Each binding's payload is, on HTTP, of its encoding's media type:

| Encoding | A request's body                                                                                        | A result's body                                            | An event's data (section 8.4)        |
| -------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `proto`  | `application/json`: protobuf's JSON mapping, read as sections 5.2 to 5.4 say                            | `application/json`, written as section 5.6 says            | the same JSON                        |
| `json`   | `application/json`: the payload's bytes as they are, which its server reads (section 17.5 of `spec.md`) | `application/json`: the payload's bytes, canonical already | the payload                          |
| `text`   | `text/plain`: the payload's bytes as they are, which its server reads (section 17.4)                    | `text/plain;charset=utf-8`: the payload's bytes            | the text as a JSON string (17.7.3)   |
| `raw`    | `application/octet-stream`: the payload's bytes                                                         | `application/octet-stream`: the payload's bytes            | the bytes as a JSON string in base64 |

A gateway MUST refuse, 415 `type-refused`, a request to a route that takes a body, whether a body
comes or none, whose `content-type` is absent or in two fields, or whose type, compared
case-insensitively, is not its route's, or which carries a parameter but `charset`, or a `charset`
but `utf-8` in any case, a token or a quoted string, or whose `content-encoding` is not `identity`,
as section 15.6 of `spec.md` refuses a `POST` of no type. A `json`, `text` or `raw` request has no
field: its route's body is `*`, and no variable or query binds it. `bead.Json`, `bead.Text` and
`bead.Raw` are those encodings, never messages that section 5.6 writes.

5.2. A gateway MUST read a `proto` request's body as section 4 binds it, and refuse it, 400
`PAYLOAD_UNDECODABLE`, at the first refusal it meets, in this order:

- its text, by step 1;
- section 4's own refusals, as it binds the request's value from its body, its variables and its
  query (section 4.1), but for a body of the request whole that is no object, which steps 2 and 3
  refuse as the message's, with nothing bound beside it;
- that value, by steps 2 and 3, in one walk: each object's members in the order the value holds
  them, which is its body's as its text writes them, then what its variables bind, then its
  query's parameters in their order, with a repeated scalar's items after all of them; each
  member, and all it holds, is read before the member after it;
- its `update_mask`, where section 4.5 derives one;
- step 4, then step 5:

1. the text, as section 17.5 of `spec.md` reads a `json` payload — UTF-8, no byte order mark, one
   JSON text, no member named twice, no surrogate alone, no number past the largest double — but for
   its depth, and keeping the digits of each number beside its double: its depth is counted by the
   message's descriptor, as section 17.9.3 counts a message's, each message's object, an `Any`'s
   message's among them, each map's entry and each `Struct`, `Value` and `ListValue` a message, an
   array none, and a message nested more than 100 deep below the request is refused before anything
   deeper is built;
2. its value, an object of the message's fields, or the field's JSON where a `body` names one, and
   each of its members by the message's fields: each by its JSON name or its proto name, never by
   both, as protobuf's JSON mapping has its parsers take both; a member that names no field
   refused; `null` leaving its field unset, as at its default, but where it is a value of its own,
   a `google.protobuf.Value`'s, whose `null_value` it sets, or a `google.protobuf.NullValue`'s; an
   item of a repeated field, and a map's value, that is `null`, refused, but where it is a `Value`;
   a `oneof`'s member that is `null` beside another that sets it, taken, and two members of one
   `oneof` that set it, refused;
3. each scalar by section 5.3, and each well-known type by section 5.4;
4. the message so built, as section 17.9.7 of `spec.md` judges a payload: the first field of
   `LEGACY_REQUIRED` presence that its walk finds unset (no member names it, or one names it
   `null`), an `Any`'s message never looked into;
5. the message, encoded by its stock library, read as section 17.9 of `spec.md` reads a payload.

5.3. A scalar's JSON, where protobuf's JSON mapping takes more than one form, is one of these, and
a gateway MUST refuse any other:

1. a 32-bit integer: a JSON number, or a JSON string that is a JSON number, whose value, read
   exactly from its digits, is an integer of its type's range: `1e2`, `5.0` and `"1e5"` among them;
2. a 64-bit integer: a JSON string of `-?(0|[1-9][0-9]*)` whose value is in its type's range, or a
   JSON number whose value, read exactly from its digits, is an integer of its range;
3. a `float` or a `double`: a JSON number, or a JSON string that is a JSON number, read as the
   double nearest it (section 17.6 of `spec.md`), then, for a `float`, as the 32-bit float nearest
   that double, a tie to the even; or `"NaN"`, `"Infinity"` or `"-Infinity"`; a number past the
   largest finite double refused, as section 17.5 refuses one, and a `float` its rounding takes past
   its largest finite value;
4. a `bool`: `true` or `false`;
5. a string: a JSON string, as it is;
6. `bytes`: a JSON string of base64 of one alphabet, the standard's or the URL-safe one, padded
   correctly or not at all ([RFC 4648 §4, §5](https://www.rfc-editor.org/rfc/rfc4648#section-4)),
   the bits its last character holds past its bytes whatever they are;
7. an enum: a JSON string that is the name of one of its values, as it is written, or a JSON number,
   an integer of the 32-bit range, that one of its values numbers, or any such where the enum is
   open, as every enum of `proto3` is;
8. a map's key: a JSON string, its key's form — a string as it is; a `bool`'s `true` or `false`; an
   integer's `-?(0|[1-9][0-9]*)`, its value in its type's range — two keys of one value refused.

5.4. A well-known type's JSON is its form in protobuf's JSON mapping, held exactly, and a gateway
MUST refuse any other:

1. a `Timestamp`: RFC 3339's `date-time`
   ([§5.6](https://www.rfc-editor.org/rfc/rfc3339#section-5.6)), a four-digit year, upper-case `T`
   and `Z`, its fraction 1 to 9 digits or none, `Z` or an offset `+hh:mm` or `-hh:mm` of `hh` from
   `00` to `23` and `mm` from `00` to `59`, `-00:00` among them; a day its month holds, an hour from
   `00` to `23`, a minute and a second from `00` to `59`; its instant, in UTC, from
   `0001-01-01T00:00:00Z` to `9999-12-31T23:59:59.999999999Z`;
2. a `Duration`: `-?(0|[1-9][0-9]*)(\.[0-9]{1,9})?s`, from −315,576,000,000.999999999 to
   315,576,000,000.999999999 seconds;
3. a `FieldMask`: its paths by `,`, none empty, each its segments by `.`, each segment in
   lowerCamelCase — a lower-case letter first, then letters and digits — read to snake case, each
   upper-case letter `_` and its lower case; a path whose snake case, written back, is not the
   text it came from refused;
4. a wrapper: its value's form, as section 5.3 has it;
5. a `Struct`, a `Value` and a `ListValue`: JSON itself, an object, any value and an array, a
   `Value`'s number as a `double`'s;
6. an `Any`: an object whose `@type` is a string, a `/` in it, that names after its last `/` a
   message its definitions hold or a well-known type, in any place among its members: its other
   members, for a well-known type of a form of its own — a `Timestamp`, a `Duration`, a
   `FieldMask`, a wrapper, a `Struct`, a `Value`, a `ListValue` or an `Any` — one alone, `value`,
   its form; for any other message, an `Empty` among them, that message's members; and `{}` alone,
   the empty `Any`;
7. an `Empty`: `{}`.

5.5. Where protobuf's JSON mapping takes more than one reading, this document takes, in this order:
the expectation of protobuf's conformance suite where it has a test of it, its `Recommended` tests
among them; the mapping's text, where it speaks; and otherwise the reading the text allows that
refuses the most, so that what one side takes the other takes too.

5.6. A gateway MUST write a `proto` result in Bead's proto JSON form, one sequence of bytes on every
side:

1. the tokens of section 17.7 of `spec.md`, 1 to 4 and 7: no white space, its strings' escapes, a
   number as ECMAScript's Number::toString writes its double, −0 as `0`;
2. a message's members by their JSON names, in the order of their fields' numbers, a `oneof`'s
   member in its own place; an `Any`'s `@type` first, its type's URL as it holds it, then its
   message's members, or its `value`, as section 5.4 places them;
3. a field with no presence of its own left out at its default, `-0` among them, and a repeated
   field or a map that holds nothing; a field with presence written where it is set, at its default
   too;
4. a map's entries and a `Struct`'s members sorted by their keys, as section 17.7.6 sorts an
   object's members;
5. an enum by the name of its value declared first for its number, as protobuf's C++ and Go
   libraries name one, and by its number where no value numbers it; a `NullValue` as `null`;
6. a `float`, and a `FloatValue`'s value, as the shortest decimal that reads back to it as a 32-bit
   float, written as Number::toString writes a number of those digits; a 64-bit integer as a JSON
   string of its decimal; `bytes` in standard base64, padded; a value not finite as `"NaN"`,
   `"Infinity"` or `"-Infinity"`;
7. a `Timestamp` in UTC, with `Z`, and a `Duration` with `s`, each with 0, 3, 6 or 9 fraction
   digits, the fewest that hold it, as protobuf's own libraries write them; a `FieldMask`'s paths
   in lowerCamelCase by `,`; a wrapper as its value; a `Struct`, a `Value` and a `ListValue` as the
   JSON they hold; an `Empty` as `{}`; an `Any` that holds nothing as `{}`.

A field of `LEGACY_REQUIRED` presence is set in every message it writes but an `Any`'s, since
section 17.9.7 of `spec.md` reads no result that leaves one unset. An `Any`'s message is written as
it holds it, such a field left out where it is unset, as protobuf's C++ and Go libraries write one.

5.7. A gateway MUST refuse to write a result, a failure of its own (section 7.6), where Bead's proto
JSON form holds none of it: a `Timestamp` outside section 5.4's range, or whose nanoseconds are not
from 0 to 999,999,999; a `Duration` outside its range, whose nanoseconds pass ±999,999,999, or
whose seconds and nanoseconds part by their signs; a `FieldMask` path whose lowerCamelCase does not
read back to it; a `Value` whose number is not finite, or that holds no kind; an `Any` whose type
its definitions do not hold, whose bytes do not read as it, or that holds bytes and no type; and a
message nested more than 100 deep below the result, as section 17.9.3 of `spec.md` counts one.

5.8. A route's `response_body` names a top-level field of its result, and its body is that field's
JSON, written as section 5.6 writes a field: at its default too, so that a body is always there.

## 6. Answers

_Transcoding: `spec/transcoding.json`._

6.1. A gateway answers a call's result 200, its body of section 5's form, its `content-type` its
encoding's (section 5.1), and its `content-length` where its body is whole before its head goes. A
result with no field set is `{}`, 200, never 204: one form for every result.

6.2. Every response a gateway writes but what HTTP refuses of its own (section 15.12 of `spec.md`)
MUST carry `x-content-type-options: nosniff` and `vary: Origin`, and `cache-control: no-store`
but its document's (section 11.1), since an answer depends on the credential that asked it; and,
once its origin is taken (section 10.1), every response to a request whose `origin` its `origins`
names, `access-control-allow-origin`, that `origin` as it came, and
`access-control-expose-headers: *`, as section 15.12 writes them.

## 7. Failures

_Transcoding: `spec/transcoding.json`._

7.1. A gateway answers every failure with a problem of
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457), `application/problem+json`, its status the
response's ([§3.1.2](https://www.rfc-editor.org/rfc/rfc9457#section-3.1.2)), of these members:

| Member      | What it holds                                                                                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`      | its identity (section 7.3)                                                                                                                                                                                                                                                                                             |
| `title`     | its name (section 7.3)                                                                                                                                                                                                                                                                                                 |
| `status`    | its status                                                                                                                                                                                                                                                                                                             |
| `detail`    | the failure's detail as the gateway's client read it (section 7.3 of `spec.md`), or the gateway's own words, which this document gives (sections 5, 7.6 and 7.7) and which never repeat what its request carried; absent where it is empty, for `PAYLOAD_INVALID`, and for an error of the gateway's own (section 7.6) |
| `code`      | its code, as the wire carries it, 1 to 65,535; absent for a failure of the gateway's own                                                                                                                                                                                                                               |
| `scope`     | `protocol` or `application`, as the flag of section 7.2 of `spec.md` says; absent for a failure of the gateway's own                                                                                                                                                                                                   |
| `errors`    | `PAYLOAD_INVALID`'s violations (section 7.4)                                                                                                                                                                                                                                                                           |
| `more`      | the count its detail's closing line gives of the violations it left out (section 18.6 of `spec.md`), where it gives one that is not 0                                                                                                                                                                                  |
| `stopped`   | `true`, where its detail's closing line says its judging stopped at its first violation                                                                                                                                                                                                                                |
| `parameter` | where a `PAYLOAD_UNDECODABLE` of the gateway's reading lies among its route's variables or in its query (section 7.4)                                                                                                                                                                                                  |
| `pointer`   | where it lies in its body (section 7.4)                                                                                                                                                                                                                                                                                |

7.2. A gateway MUST write a problem's members in the canonical form of section 17.7 of `spec.md`,
their names sorted, so that one failure is one sequence of bytes on every side.

7.3. A problem's `type` is a protocol code's `tag:francisdesjardins.ca,2026:bead/` followed by its
name, or by its number where section 8.1 of `spec.md` names none, a URI that names and locates
nothing ([RFC 9457 §3.1.1](https://www.rfc-editor.org/rfc/rfc9457#section-3.1.1)); an application
failure's, the `problemTypes` its definitions give followed by its name in its service's catalogue,
or by its number where the catalogue names none; and `about:blank` for an application failure whose
definitions give no `problemTypes`, and for a failure of the gateway's own. Its `title` is the name
or the number its `type` ends with, and the phrase RFC 9110 gives its status where its `type` is
`about:blank` ([RFC 9457 §4.2.1](https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1)).

7.4. `PAYLOAD_INVALID`'s problem holds, in `errors`, each violation its detail's reader reads
(section 18.7 of `spec.md`), in their order, each an object of `detail`, its `message`, or the
words section 18.8.6 gives its rule where it went without one; `ruleId`; `fieldPath`, `bounds` and
`forKey` where the violation holds them; and where its field is:

1. `parameter`, where its field is one a variable of its route binds, the variable's field path as
   its template writes it; or one its query binds, its field path by JSON names, an item's index
   and a map's key left out;
2. `pointer`, where its field lies in the body: its path by JSON names from the body, the field a
   `body` names its root, as [RFC 6901 §6](https://www.rfc-editor.org/rfc/rfc6901#section-6)
   writes a fragment — `#`, then each name or index after a `/`, `~` and `/` escaped `~0` and `~1`,
   a character a fragment does not take percent-encoded from its UTF-8; a map's key as its string,
   and a `oneof` pointing at the message that holds it; `#` for a rule of the message itself where
   the body is the request whole;
3. neither, for a rule of the message itself where the body is not the request whole, and for a
   field path that names no field of the request.

A `PAYLOAD_UNDECODABLE` of the gateway's reading (section 7.6) holds, so placed, where its reading
met what it refuses: `parameter`, a variable's field path, or a query's by JSON names, or the name
of a parameter that names no field; `pointer`, the value of its body it met, by the JSON name of
each field, and each member that names none, each map's key and each `Struct`'s member as its body
wrote it, `#` the body itself; a field step 4 of section 5.2 finds unset, as items 1 and 2 place a
violation's field: `parameter`, its field path by JSON names, where the route's query would bind it
(section 4.3); `pointer`, its path by JSON names from the body, where the body holds its object;
neither for its text, its query whole, or a query whose bytes are not
UTF-8. Its `detail` is its mapping's own words, which name no member or key of the request, `a
required field unset` for step 4's: a problem's `detail` never repeats what its request carried, and
where its place helps, it goes in its `parameter` or its `pointer`.

A `pointer`, of a violation or of a reading, is a JSON Pointer into the body as its request wrote
it, by the JSON name of each field ([RFC 6901 §6](https://www.rfc-editor.org/rfc/rfc6901#section-6)).
It resolves there ([RFC 6901 §4](https://www.rfc-editor.org/rfc/rfc6901#section-4)) where the
body names each field on its way by its JSON name and holds it. It names a field left unset (step
4 of section 5.2) as the member its object lacks, an evaluation RFC 6901 makes an error, which is
its meaning here. A name or a key past 64 bytes of UTF-8 is never written into it, and it points at
the value that holds that name or key, a violation's key cut short (section 18.4 of `spec.md`)
alike. A `parameter`, which is no pointer, writes such a name as section 18.4 cuts a key, its first
64 bytes, back to the start of the character the cut fell in, then `...`.

7.5. A gateway answers each failure by where it arose, since it is a requester, and raises some
codes of its server's answer, which its HTTP client cannot mend:

1. the caller's: a failure its server answered of the request, or that its client raised before the
   call went (section 17.2, item 4, of `spec.md`): 400, 413 or 422;
2. the server's answer it could not take: a failure its client raised of a result or of a
   notification (section 17.2, items 2 and 3): 502
   ([RFC 9110 §15.6.3](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.3));
3. its own configuration: a credential scheme its server takes none of, where the scheme is the
   gateway's choice (section 2.4), never its caller's: 500;
4. between it and its server alone: 500, 502, 503 or 504, as section 7.6 says.

7.6. A gateway MUST answer each failure with this status, and what this table gives beside it:

| Code, or what failed                                                                                                          | Where it arose                                                 | Status | Beside it                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENVELOPE_MALFORMED`                                                                                                          | its server, of what the gateway wrote                          |    500 |                                                                                                                                                                                                                                                      |
| `LAYOUT_UNSUPPORTED`, `KIND_UNSUPPORTED`                                                                                      | its server                                                     |    502 |                                                                                                                                                                                                                                                      |
| `ENVELOPE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`                                                                                     | its server, of the request, or its client before the call went |    413 |                                                                                                                                                                                                                                                      |
| `ENVELOPE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`                                                                                     | its client, of a result or a notification                      |    502 |                                                                                                                                                                                                                                                      |
| `DESTINATION_UNKNOWN`, `CALL_UNKNOWN`, `SUBSCRIPTION_UNKNOWN`, `SUBSCRIPTION_UNSUPPORTED`, `CHUNK_INVALID`, `CREDIT_EXCEEDED` | between it and its server                                      |    500 |                                                                                                                                                                                                                                                      |
| `DESTINATION_UNREACHABLE`                                                                                                     | its client                                                     |    503 | `retry-after: 1`, its code alone                                                                                                                                                                                                                     |
| `SERVICE_UNKNOWN`, `PROCEDURE_UNKNOWN`                                                                                        | its server                                                     |    501 |                                                                                                                                                                                                                                                      |
| `SESSION_REQUIRED`                                                                                                            | its server                                                     |    401 | `www-authenticate`, its challenge, `Bearer` by default, and `error="invalid_token"` where a credential came, after a space, or after `, ` where the challenge holds parameters ([RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750#section-3.1)) |
| `ACCESS_DENIED`                                                                                                               | its server                                                     |    403 |                                                                                                                                                                                                                                                      |
| `CAPACITY_EXCEEDED`                                                                                                           | its server, or its client before the call went                 |    429 | `retry-after: 1` ([RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4))                                                                                                                                                                   |
| `CREDENTIAL_UNSUPPORTED`                                                                                                      | its server, of the scheme it presents                          |    500 | its detail                                                                                                                                                                                                                                           |
| `PAYLOAD_UNDECODABLE`                                                                                                         | the gateway's reading of a body, a query or a variable         |    400 |                                                                                                                                                                                                                                                      |
| `PAYLOAD_UNDECODABLE`                                                                                                         | its server, of a `json`, `text` or `raw` request               |    400 |                                                                                                                                                                                                                                                      |
| `PAYLOAD_UNDECODABLE`                                                                                                         | its server, of a `proto` request                               |    502 |                                                                                                                                                                                                                                                      |
| `PAYLOAD_UNDECODABLE`                                                                                                         | its client, of a result or a notification                      |    502 |                                                                                                                                                                                                                                                      |
| `TRANSFER_STALLED`                                                                                                            | between it and its server                                      |    504 |                                                                                                                                                                                                                                                      |
| `PAYLOAD_INVALID`                                                                                                             | its server, or its client before the call went                 |    422 | `errors`, `more`, `stopped` (section 7.4)                                                                                                                                                                                                            |
| `PROCEDURE_FAILED`                                                                                                            | its server                                                     |    500 |                                                                                                                                                                                                                                                      |
| `DESTINATION_LOST`                                                                                                            | its client                                                     |    502 |                                                                                                                                                                                                                                                      |
| a protocol code section 8.1 of `spec.md` names none of                                                                        | its server                                                     |    500 |                                                                                                                                                                                                                                                      |
| an application failure                                                                                                        | its server                                                     |    400 |                                                                                                                                                                                                                                                      |
| its call's timeout (section 9.2)                                                                                              | the gateway                                                    |    504 | a failure of its own, its detail `no answer within <timeout> ms`, its option in milliseconds                                                                                                                                                         |
| its exchange's connection closed before its answer                                                                            | the gateway                                                    |    502 | a failure of its own, its detail `the connection closed`                                                                                                                                                                                             |
| a result section 5.7 refuses to write                                                                                         | the gateway                                                    |    500 | a failure of its own, its detail the words its mapping gives what it holds no form of                                                                                                                                                                |
| a `JWT` its request's block cannot hold                                                                                       | the gateway, under `bearer-jwt`                                |    431 | a failure of its own, its detail `a token past 1004 bytes`, 1004 the bytes of a `JWT` its block holds ([RFC 6585 §5](https://www.rfc-editor.org/rfc/rfc6585#section-5))                                                                              |
| an `authorization` of an auth-scheme but `Bearer`                                                                             | the gateway, under `bearer-jwt`                                |    401 | a failure of its own, its detail `an auth-scheme but Bearer`; `www-authenticate`, its challenge and `error="invalid_request"` after it                                                                                                               |
| what no gate foresaw                                                                                                          | the gateway                                                    |    500 | a failure of its own, with no detail                                                                                                                                                                                                                 |

A gateway MUST report on its `error` (section 9.0 of `spec.md`) each failure it answers a call
with a status of 500 or above, but `PROCEDURE_FAILED`, which its server reported as its
application's: a code between it and its server, its server's answer it could not take, a scheme
its server takes none of, its call's timeout, its exchange's connection closed, a result section 5.7
refuses, what no gate foresaw. What it reports no problem's member carries, and an answer for an
error of its own carries its code alone, as section 9.0 has one: `DESTINATION_UNREACHABLE` and what
no gate foresaw, with no detail.

7.7. A refusal of the gateway's own is marked in `bead-refusal`, as section 15.6 of `spec.md` marks
a transport's, so that a client tells it from a call's answer, and a gateway MUST write its body as
a problem of its own, `about:blank`, its `detail` the words this table gives it, byte for byte on
every side, so that a person reading it reads why:

| `bead-refusal`   | Status | Its words                                                                                                                                                                                                                                                                            |
| ---------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `malformed`      |    400 | `content to a route that takes none`; `content to the document`; `two authorization fields`                                                                                                                                                                                          |
| `host-refused`   |    403 | `a host it does not take`                                                                                                                                                                                                                                                            |
| `origin-refused` |    403 | `an origin neither its own nor listed`, at section 10.1's step 4; `a request from a page of another site that shows no origin`, at its step 5                                                                                                                                        |
| `path-unknown`   |    404 | `a path no route matches`                                                                                                                                                                                                                                                            |
| `method-refused` |    405 | `a method no route of its path takes`; `a method the document takes none of`                                                                                                                                                                                                         |
| `too-slow`       |    408 | `a body slower than minimumBodyBytesPerSecond`                                                                                                                                                                                                                                       |
| `too-large`      |    413 | `a body declared past maximumBodyBytes <n>`, at step 9; `a body past maximumBodyBytes <n>`, at step 10; `<n>` its bound in decimal                                                                                                                                                   |
| `type-refused`   |    415 | `this route's body is <type>, unencoded`, `<type>` its route's request media type (section 5.1)                                                                                                                                                                                      |
| `busy`           |    503 | `the calls under way hold maximumExchanges`; `the calls of its address hold maximumExchangesPerAddress`; `the streams under way hold maximumConnections`; `the streams of its address hold maximumConnectionsPerAddress` (section 10.3); `the bodies under way hold bodyBytesBudget` |

A `PAYLOAD_UNDECODABLE` of the gateway's reading is a call's failure, unmarked, its words its
mapping's. A preflight's 204, and what HTTP refuses of its own (section 15.12), keep their empty
bodies.

## 8. Notifications

_Transcoding: `spec/transcoding.json`._

Notifications go as Server-Sent Events,
[WHATWG HTML §9.2](https://html.spec.whatwg.org/multipage/server-sent-events.html).

8.1. A request to a procedure that notifies, on any of its routes, opens a subscription (section
11.1 of `spec.md`) where its `accept` names `text/event-stream` itself, of a weight above 0 and at
least the weight it gives `application/json`
([RFC 9110 §12.5.1](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.1)), each by the first range
that names it most specifically, a weight off RFC 9110's `qvalue` grammar (§12.4.2) as none
given, 1: never through `*/*` or `text/*`, which a `fetch` sends by default. Any other request to it
is a call as any other, which subscribes nothing (section 11.2), its result 200 and of section 5's
form.

8.2. A gateway MUST write nothing of a stream before its call is answered: a failure is a problem
of its status, as any call's (section 7); a result opens the stream, 200 `text/event-stream`, and
goes as its first event. A notification that comes before the answer, as section 11.4 of `spec.md`
lets a server send one, is held until then: written after the result, in its order, or dropped with
the subscription a failure takes away (section 11.2).

8.3. A gateway MUST write an `id` on each event, its count in the stream from 1, and MUST answer a
request that carries `Last-Event-ID` with 204 and no call, so that an `EventSource` stops rather
than calls again.

8.4. An event's data is one JSON text in the tokens of section 17.7 of `spec.md`, which hold no
line feed, so one `data` line carries it whole: a `proto` result or notification as section 5.6
writes it, a `json` one as it is, a `text` one as a JSON string of its text, a `raw` one as a JSON
string of its bytes in standard base64, padded, and a failure as its problem (section 7).

8.5. Each event is its lines, each ended by a line feed, then an empty line: `event: result` for the
result and `event: failure` for the failure that ends the stream; then `id: `, its count; then
`data: `, its data. A notification has no `event` line, so that an `EventSource` dispatches it as
`message` (§9.2.6) and its `onmessage` hears it.

8.6. A stream ends with a failure event, then the response's end: the failure that ends its
subscription (section 11.7, item 2, of `spec.md`) — its queue past its bounds, `CAPACITY_EXCEEDED`;
its session ended, `SESSION_REQUIRED`; a failure its application ends it with — as its problem; or
the gateway's own, 502, where its exchange's connection closed before it. A stream whose client goes
ends as its exchange's connection closes, which ends its subscription (section 11.7, item 3).

8.7. While nothing else goes, a gateway writes a comment, `:` and a line feed, every `heartbeat`, 30
seconds by default, a duration of section 1.4 of `spec.md`, which may be without end, so that an
intermediary's idle timeout does not cut a quiet stream.

8.8. A gateway MUST ask its subscription paced (section 11.8 of `spec.md`), and credit each
notification once the event before it was taken by its response — written whole to its socket, or
taken as its stream's flow control lets it
([RFC 9113 §5.2](https://www.rfc-editor.org/rfc/rfc9113#section-5.2)) — within a window, `window`,
16 by default, as section 11.11 has a client credit; so a reader that falls behind holds its
server's queue (sections 11.9 and 11.10), never the gateway's memory.

## 9. Cancel, timeouts and size

_Transcoding: `spec/transcoding.json`._

9.1. A request aborted before its response ended — its socket closed, its HTTP/2 stream reset —
closes its exchange's connection, so its server ends every call on it as cancelled (section 9.10 of
`spec.md`), its resolver told, and frees its subscription and its transfers in the same step.

9.2. A gateway's call waits for its answer as long as its option `timeout`, 5 seconds by default, a
duration of section 1.4 of `spec.md`, which may be without end; past it, the call ends as timed out
(section 9.9), answered 504. A stream's call counts it until its result alone. No field of a request
sets it: what a peer writes is not an application's (section 1.4), so Connect's
`connect-timeout-ms` and gRPC's `grpc-timeout` are not read.

9.3. A body past `maximumBodyBytes` is refused 413, `too-large`, as it is declared or as it comes,
as section 15.6 of `spec.md` refuses one. A payload whose envelope would pass `chunkBytes` goes to
its server as a transfer (section 12.1), which the in-memory transport carries and HTTP's own does
not (section 15.11): a gateway reads a JSON body whole, and the transfer carries its payload's bytes
to its server under credit.

## 10. Gates and bounds

_Transcoding: `spec/transcoding.json`._

10.1. A gateway MUST judge a request in this order, by the gates and the options of section 15.12 of
`spec.md`, and answer the first that applies:

1. what HTTP refuses of its own, unmarked (section 15.12), a body HTTP cannot frame among it,
   whenever it comes;
2. a host it does not take, 403 `host-refused` (`hosts`);
3. a path no route matches, 404 `path-unknown` (section 3.10);
4. an `origin` neither its own nor one `origins` names, 403 `origin-refused`;
5. a request with no `origin` whose `sec-fetch-site` is `same-site` or `cross-site`, 403
   `origin-refused`, unless its `sec-fetch-mode` is `navigate` and it asks `/openapi.json`, a
   default route's `GET`, or a `get` rule on a method marked `NO_SIDE_EFFECTS`: a page of another
   origin shows its `origin` on every request but a `GET` or a `HEAD` that is no CORS request
   ([Fetch §3.1](https://fetch.spec.whatwg.org/#origin-header)), so what comes from one without it
   is a subresource or a navigation, which
   [Fetch Metadata](https://www.w3.org/TR/fetch-metadata/)'s resource isolation policy refuses but
   a navigation; a request with no `sec-fetch-site` is taken;
6. a preflight, an `OPTIONS` that carries `access-control-request-method`, from an origin `origins`
   names: 204, its `access-control-allow-methods` the methods its path's routes take in section
   3.10's order, and its `access-control-allow-headers` and `access-control-max-age` as section
   15.12 writes them;
7. a method no route of its path takes, 405 `method-refused` (section 3.10);
8. a request to a route that takes a body of no type, or of a type or an encoding that is not its
   route's, whether a body comes or none, 415 `type-refused` (section 5.1); a body, a
   `content-length` past 0 or a `transfer-encoding`, to a route that takes none, 400 `malformed`
   (section 4.4);
9. two `authorization` fields, 400 `malformed`; a `content-length` past `maximumBodyBytes`, 413
   `too-large`; a request past its bounds (section 10.3), 503 `busy`, `retry-after: 1`; a
   request that would open a stream and carries `Last-Event-ID`, 204 (section 8.3);
10. its body as it comes: past `maximumBodyBytes`, 413 `too-large`; past `bodyBytesBudget`, 503
    `busy`; slower than its rate, 408 `too-slow`, as section 15.12 holds one;
11. its binding (section 4), its reading (section 5), then its call.

10.2. A gateway holds what comes and what goes by the bounds of section 15.12 of `spec.md`, by their
names and their defaults: `bodyBytesBudget`, `maximumBodyBytes`, `headersTimeout`,
`minimumBodyBytesPerSecond` and `bodyGracePeriod` for what comes; `minimumSendBytesPerSecond`,
`sendGracePeriod` and `maximumUnsentBytes` for an answer and a stream that go out, a stream's
response dropped past either as a WebSocket's connection is, which closes its exchange's connection.

10.3. A gateway counts its calls and its streams apart, each holding one Bead connection while it
lasts: a call, which lives one request, by `maximumExchanges`, 10,000, those of every caller, and
`maximumExchangesPerAddress`, 256, those of one caller's address; a stream, which lives as long as
its reader stays, by `maximumConnections` and `maximumConnectionsPerAddress` of section 15.12,
10,000 and 64. Each address is read as section 15.12 reads one behind `trustedProxies` and
`unnamedProxies`. A request past one of them is refused 503 `busy`, `retry-after: 1`.

10.4. A procedure is reached by its default route whatever rules map it (section 3.2), so a proxy's
rule on a rule's path guards nothing its default route leaves open: what guards a procedure is its
admission, which every route meets alike.

## 11. The document

11.1. A builder writes one OpenAPI document of a blueprint, once, in the blueprint's own form —
its members sorted as RFC 8785 sorts them, two spaces of indentation, a final line feed, in UTF-8 —
so that one blueprint gives one sequence of bytes, whatever writes it. A gateway MUST serve the
bytes its builder wrote, as they are, at `/openapi.json`, to a `GET` and a `HEAD`, through the gates
of section 10.1, unless its options say it serves none: `application/json`, `cache-control:
no-cache`, and an `etag` of their sha256, its 64 lower-case hexadecimal digits between quotation
marks; a request whose `if-none-match` holds that tag, compared weakly, or `*`, is answered 304
([RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.2)).

11.2. The document is of OpenAPI 3.1.1, its `jsonSchemaDialect` the OpenAPI base dialect,
`https://spec.openapis.org/oas/3.1/dialect/base`; its `info.title` the one its definitions give, or
its services' names, and its `info.version` its services' names and revisions, `Hello.2`, which
moves as a contract does (section 16.9 of `spec.md`).

11.3. Each route is a path of the document, and its operation's `operationId` is
`<serviceName>.<procedureName>` for the default `POST`, followed by `.get` for its `GET` and by
`.http`, `.http1` and on for its rules in their order; its `x-bead` names the service and the
procedure, their ids and the procedure's kind; its `deprecated`, `summary` and `description` are
its definitions'.

11.4. A variable is a parameter `in: path`; a multi-segment variable is written expanded into the
path, each `*` a parameter named by the literal before it, and a `**` one parameter of
`x-bead-segments: true`, since a path parameter's value holds no unescaped `/`. A query's fields are
parameters by their JSON field paths, a repeated one `explode: true`. A query's parameter is
`required: true` where its field is of `LEGACY_REQUIRED` presence and each message field on its path
is too, or is held present by a variable of the route, since section 5.2 refuses a request that
leaves it unset. Its `description` says its proto name, which the gateway also reads (section 4.3),
as section 11.9 says a field's.

11.5. An operation's body is its request's schema less what its variables bind — which keeps each
rule of what remains, and whose `required` lists a message field that a variable binds into where a
field of `LEGACY_REQUIRED` presence of its message is left to the body — or its `body` field's, of
its encoding's media type; its 200 is its result's schema, or its `response_body`
field's, and, for a procedure that notifies, `text/event-stream` beside it, its events' schemas in
`x-bead-events`; its `default` is a `Problem`, its 422 a `ValidationProblem` where its request holds
rules, and its 401 carries `WWW-Authenticate` where its admission is not `none`.

11.6. The document's one security scheme is its definitions', `{type: http, scheme: bearer}` where
they give none; an operation whose admission is `none` takes it optionally, `[{}, <scheme>]`, since
a credential that comes is resolved and refused when it does not hold (section 9.2, step 6, of
`spec.md`), and any other requires it.

11.7. A message's schema is by its full name, its fields by their JSON names in the order of their
numbers, each the one form section 5.6 writes, which section 5.2 reads: a 32-bit integer an
`integer` of its range; a 64-bit integer a `string` of its digits' pattern and its `format`; a
`float` or a `double` a `number` or one of `"NaN"`, `"Infinity"` and `"-Infinity"`; `bytes` a
`string` of `contentEncoding: base64`; an enum its names; a repeated field an `array`; a map an
`object` whose `propertyNames` its key's form; a `oneof` its members, two never `required`
together; in its `required`, each field of `LEGACY_REQUIRED` presence beside those its rules
require, by number, each once, since section 5.2 refuses a message that leaves one unset;
`additionalProperties: false`; and its rules as JSON Schema 2020-12's validation
vocabulary states them, from the same blueprint.

11.8. A form whose `format` or `contentEncoding` the base dialect only annotates carries a
`pattern` beside it, of exactly what section 5 reads, in ECMA-262's dialect with no lookaround: a
`Timestamp`'s, a `Duration`'s, a `FieldMask`'s paths' and base64's of one alphabet.

11.9. What no schema carries is said in its `description`: a day past its month's end, a 64-bit
integer's range past its digits and a `Duration`'s range; and what section 5 reads beside the form
a schema states: a field's proto name, an enum's number and a 64-bit integer as a number.

## 12. The generated client

12.1. An output with `http: true` writes, beside its route table, a typed `<Service>HttpClient`
that calls each procedure of its service by its default `POST` route (section 3.1), its request
whole and its result whole, whatever `google.api.http` rules the procedure also serves; a command,
which no exchange answers, has none. Its surface maps name for name: on the TypeScript side
`new HelloHttpClient(url, options?)`, `hello.sayHello(request, options?)` and, for a procedure that
notifies, `hello.subscribeCountDown(request, options?)`; on the C# side `new HelloHttpClient(uri,
options)`, `hello.SayHello(request, options)` and `hello.SubscribeCountDown(request, options)`. The
names `<Service>HttpClient` and `subscribe<Procedure>`, or `Subscribe<Procedure>`, are a target's
own, which beadc keeps a blueprint's names from (its rule `NAME_TARGET`).

12.2. Its URL is HTTP's or HTTPS's, with no user information, no query and no fragment; it may end
in a path, a prefix under which each route resolves as [RFC 3986
§5.2](https://www.rfc-editor.org/rfc/rfc3986#section-5.2) resolves a reference against a base
whose path ends in `/`, on its origin.

12.3. It writes each request and reads each result by section 5's mapping and the encoding of
section 5.1, as its gateway reads and writes them. Each call presents the credential its options
give, or its client's, or none: an `Authorization` field that the transports' own check judges,
shape first, then whether it leaves the machine in the clear, which fails the call before anything
is written with `DESTINATION_UNREACHABLE`, as section 13.4 of `spec.md` has every client fail it.
Section 13.4's withdrawal of a default credential on `SESSION_REQUIRED` does not apply: an HTTP
call holds no session to end. It follows no redirect, presents no cookie and, from a page, nothing
the browser would add beyond its own origin's (`credentials: 'same-origin'`).

12.4. A problem is a Bead failure, raised as its side raises one, `FailureError` on the TypeScript
side and `FailureException` on the C# side, its detail its problem's:

1. one that holds a `code` and a `scope` (section 7.1) is that failure, the peer's: its code an
   integer of 1 to 65,535, `1.0` and `1e0` code 1, a member of another JSON kind a malformed
   problem;
2. one that holds neither, `about:blank`, is the gateway's own: by its `bead-refusal` (section 7.7),
   `busy` `CAPACITY_EXCEEDED`, `host-refused` and `origin-refused` `ACCESS_DENIED`, `path-unknown`
   and `method-refused` `DESTINATION_UNREACHABLE`, `too-large` `PAYLOAD_TOO_LARGE`, `malformed` and
   `type-refused` `PAYLOAD_UNDECODABLE`; with none, by its status, read back from section 7.6's
   table, every status its table names none of `DESTINATION_LOST`;
3. a status that carries no problem, from what stands in front of a gateway, is read by the line
   section 9 of `spec.md` draws between a call never tried and a call that may have run: 503
   `DESTINATION_UNREACHABLE` and 429 `CAPACITY_EXCEEDED`, which [RFC
   9110](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4) has processed nothing; 404
   `DESTINATION_UNREACHABLE`, which no route took; 401 `SESSION_REQUIRED`, 403 `ACCESS_DENIED` and
   413 `PAYLOAD_TOO_LARGE`, as a gateway's own; 502, 504, a redirect and any other status
   `DESTINATION_LOST`. Its status, and its `retry-after`, stay in its detail.

A problem whose members break section 7.1, an answer of another media type than its route's (media
types compared without regard to case, [RFC 9110
§8.3.1](https://www.rfc-editor.org/rfc/rfc9110#section-8.3.1)), and a body section 5 cannot read,
whatever the platform throws for it, are `PAYLOAD_UNDECODABLE`.

12.5. A subscription reads its stream (section 8) through `fetch` or `HttpClient`, so that a page
presents its credential, which `EventSource` cannot: an async sequence of its result, then its
notifications, then its end, a failure raised as section 12.4 raises one; a leading byte order
mark is taken away, as
[the HTML standard](https://html.spec.whatwg.org/multipage/server-sent-events.html) decodes a
stream. A stream cut before its end is `DESTINATION_LOST`, since its procedure may have run. Ending
the sequence, or cancelling it, releases its exchange. A client MUST NOT reconnect or send
`Last-Event-ID` of its own; a replacement subscription is its application's.

12.6. It bounds the body of each answer and each event of a stream by `maximumBodyBytes`, by
default `maximumEnvelopeBytes`, as its gateway bounds a request's (section 10.2), and the message it
reads by the envelope's bound: past either, `PAYLOAD_TOO_LARGE`. It counts a stream's bytes as they
come. A call's cancellation is its platform's, an `AbortSignal` or a `CancellationToken`; on the C#
side, a handler it is given is the application's, which it never disposes, and it judges each
answer whatever the handler does; the handler it makes is the transports', which connects as [RFC
8305](https://www.rfc-editor.org/rfc/rfc8305) does.
