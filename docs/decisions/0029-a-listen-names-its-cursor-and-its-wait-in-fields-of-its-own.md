# 0029 — A listen names its cursor and its wait in fields of its own, at the connection's one URL

- **Status**: accepted
- **Scope**: the protocol, and every implementation's HTTP transport: in
  [`spec/spec.md`](../../spec/spec.md), the listen's fields and their reading (15.9, and 15.6's 400
  row), `bead-listen`'s and `bead-sequence`'s parameters (15.8, 15.9), and a field value's ends
  (15.12). What a listen is stays
  [0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)'s; what CORS answers,
  the preflight's `Access-Control-Allow-Headers` among it,
  [0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)'s; the rest of
  the field rule
  [0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)'s. This
  change's Tenth Man is kept here for the four.

## Context

**A browser keys its CORS-preflight cache by the request's URL**
([Fetch §4.9](https://fetch.spec.whatwg.org/#cors-preflight-cache)), and every request a Bead client
writes is preflighted: none of `bead-connection-token`, `bead-listen` or any `bead-*` field is a
CORS-safelisted request-header
([Fetch §2.2.2](https://fetch.spec.whatwg.org/#cors-safelisted-request-header)). A listen whose URL
carries its cursor moves its URL with every batch, and matches no entry. Measured in Chromium 153,
Firefox 155 and WebKit 26.6, a page of another origin against a server answering the preflight 204,
`GET, POST, DELETE`, 7,200 s, each engine launched fresh:

| The answer's `allow-headers`, the sequence                                                                                                        | Chromium 153 | Firefox 155          | WebKit 26.6 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------- | ----------- |
| `authorization, *`, the cursor in the URL, 40 listens                                                                                             | 41           | 43, every exchange   | 41          |
| `authorization, *`, the cursor in fields, 40 listens                                                                                              | 1            | 43, every exchange   | 1           |
| the preflight's own names, no `*`, three methods in turn                                                                                          | every one    | 4, then none: merged | every one   |
| `authorization`, the names the preflight asks, `*`: the client's connect, listen, send, listen, send with `Authorization`, listen, send, `DELETE` | 1            | 3                    | 1           |
| Bead's six request fields named, the names asked, `*`: the same sequence                                                                          | 1            | 2                    | 1           |

**The engines' caches part from each other.** Chromium and WebKit keep one entry per origin and URL,
replaced by the last answer's lists, and match `*`; Chromium's source says it
(`services/network/cors/preflight_cache.cc`), and bounds the cache at 32 entries per top-frame site,
purging 4 at random past it. Firefox keeps
[Fetch §4.8](https://fetch.spec.whatwg.org/#cors-preflight-fetch)'s entry per name, merging the
names its answers list, and stores `*` as a literal token nothing matches
(`netwerk/protocol/http/nsCORSListenerProxy.cpp`, `CORSCacheEntry::CheckRequest`). Firefox also
preflights its first two exchanges at a URL, whatever their methods, then holds the answer, past a
pause of 3 s and a simple request to the host first; the cause is not established, one candidate in
its source, `CORSCacheEntry::CheckDNSCache`, dooming an entry whose host was resolved after it was
made.

**A stale client** — a page of an earlier bundle, served from a cache across a redeploy — writes
its counts where its bundle put them, and no field. A listen read as `after` 0 and `wait` 0
acknowledges nothing and is answered at once, and a client whose `pause` is 0, the default, listens
again at once: a loop at network speed; with something in the outbox, the batch numbered from the
first unacknowledged, its `bead-sequence` disagreeing with the client's cursor.

**[RFC 9651](https://www.rfc-editor.org/rfc/rfc9651)**, Structured Field Values.
[§3.3.1](https://www.rfc-editor.org/rfc/rfc9651#section-3.3.1): an Integer is `["-"] 1*15DIGIT`.
[§2.3](https://www.rfc-editor.org/rfc/rfc9651#section-2.3): a field is an Item, a List or a
Dictionary; one "erroneously defined as another type (e.g., Integer)" is assumed an Item that allows
parameters, and specifications "are discouraged from defining the presence of an unrecognized
parameter as an error condition". [§4.2](https://www.rfc-editor.org/rfc/rfc9651#section-4.2): a
field's lines are combined before parsing, and a value that fails to parse is either ignored whole
or makes the message malformed. [§2.2](https://www.rfc-editor.org/rfc/rfc9651#section-2.2): a field
whose value violates its definition's constraints is ignored, unless the definition gives other
handling. [§4.2.4](https://www.rfc-editor.org/rfc/rfc9651#section-4.2.4): `-0` parses to the
Integer 0.

**HTTP.** [RFC 9110 §5.1](https://www.rfc-editor.org/rfc/rfc9110#section-5.1): a proxy forwards a
field it does not recognize. [§5.3](https://www.rfc-editor.org/rfc/rfc9110#section-5.3): a sender
writes a field in two lines only for a list, and a recipient may combine them.
[§5.5](https://www.rfc-editor.org/rfc/rfc9110#section-5.5): the whitespace around a field value is
no part of it. [§9.3.7](https://www.rfc-editor.org/rfc/rfc9110#section-9.3.7): responses to
`OPTIONS` are not cacheable. [RFC 9111 §4.1](https://www.rfc-editor.org/rfc/rfc9111#section-4.1):
`Vary` selects among stored responses, and
[§5.2.2.5](https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.5) `no-store` stores none.
[RFC 9113 §8.2.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.2.1): a field value "MUST NOT
start or end with an ASCII whitespace character (ASCII SP or HTAB)", beside NUL, CR and LF, and such
a request is malformed, a stream error `PROTOCOL_ERROR`
([§8.1.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.1.1)).

**The platforms' reading of a field**, measured on Node 26.5 and Kestrel on .NET 10: a field in two
lines reads `1, 2` on Node and `1,2` through Kestrel's `StringValues.ToString()`; a padded value
over HTTP/1.1 reads stripped on both. Over HTTP/2, Node's parser, nghttp2, drops a padded field
before the transport reads the request, unless `http2.createServer` is given
`strictFieldWhitespaceValidation: false` (Node 24.2.0 on), which hands it on padded; Kestrel hands
it on padded, and the C# side would present a padded `Authorization`, take a padded `Content-Type`
and refuse a padded `Origin` 403.

The options weighed:

- **The cursor and the wait in the listen's URL**: a preflight per batch in every engine, two round
  trips where a page of the server's own origin pays one, a cache entry per batch never reused.
- **`Last-Event-ID`**
  ([HTML Standard §9.2](https://html.spec.whatwg.org/multipage/server-sent-events.html)): an
  `EventSource`'s resume point, any UTF-8 string, sent on a reconnection alone and acknowledging
  nothing; the precedent for a cursor in a field, not a name to borrow, which would claim its meaning
  for a framework's `EventSource` handling to act on.
- **`Prefer: wait`** ([RFC 7240 §4.3](https://www.rfc-editor.org/rfc/rfc7240#section-4.3)): seconds
  against section 1.4's milliseconds, a preference a server MUST ignore when it cannot read it where
  15.9 refuses, the first of two winning, `Vary: Prefer` a MUST, and a list a page's wrapper or a
  gateway may add to.
- **A listen as a `POST`**: a `content-type`, 15.6's order and every case for no cache that stores a
  `no-store` answer; a listen's acknowledgement is unchanged by its method
  ([RFC 9110 §9.2.1](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.1)).
- **Refusing a listen whose target holds a query**: the same refusal for the same stale client, at
  the cost of a URL rule on one exchange in four, and of every connection of a deployment whose path
  carries a query on every request.
- **A parameter refused**, the counts one to fifteen ASCII digits: no Item parser on either side, at
  the cost of departing from RFC 9651 §2.3 on fields both ends of which Bead owns and versions
  ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).

## Decision

**A listen carries its cursor in `bead-after` and its wait in `bead-wait`, at the connection's one
URL** (spec 15.9), beside `bead-connection-token`, `bead-listen` and `bead-sequence` in Bead's own
field namespace: `after` keeps its one word
([0003](0003-one-word-one-meaning.md)), and `bead-wait` its milliseconds (section 1.4). Connect,
send, listen and `DELETE` then share one URL, one cache entry per origin.

**Each is an Item of RFC 9651 whose bare item is an Integer, 0 or more, its parameters ignored**, as
§2.3 advises, and so are `bead-listen`, a Boolean, and `bead-sequence`, an Integer of 1 or more,
which the client reads. Each side parses an Item as §4.2 does, its field lines combined first,
through one parser shared by the four fields. A listen without `bead-after`, a count that does not
parse (empty, `+0`, sixteen digits, a key in upper case, two lines, a list), whose bare item is no
Integer (`0.0`, `"0"`) or one below 0 is malformed, 400 `malformed`, marked and told: a parse
failure is §4.2's second branch, a violated constraint §2.2's other handling, since an ignored
`bead-after` reads as a listen without it and an ignored `bead-wait` as one answered at once. `-0`
is 0. A `bead-wait` left out is 0, as 15.10's `wait` of 0 is.

**No exchange's query is read**: a listen's target, like every exchange's, is read for its path
alone. A stale client sends no `bead-after`, is refused 400, loses its connection and reconnects
under its delays, with no loop; every Bead client writes `bead-after` on every listen.

**A field value that starts or ends with a space or a tab is malformed** (spec 15.12; RFC 9113
§8.2.1), judged with the rest of
[0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md)'s field
rule, before anything else of the request, on every field: over HTTP/2 both sides reset its stream
`PROTOCOL_ERROR`, as for a control character. Over HTTP/1.1 and at a WebSocket's address the parsers
strip that whitespace first, no part of the value (RFC 9110 §5.5), so the rule changes nothing
there.

**`Vary` stays `Origin` alone**: `cache-control: no-store` stands on every response on the path, so
no cache stores a listen's answer for `Vary` to select among, and `bead-connection-token` already
selects every answer unlisted. A proxy forwards the two fields as it forwards the token; one that
strips `bead-*` strips the token too, and no Bead connection works through it. HTTP/2 and HTTP/3
carry them in lower case as any other field, HPACK and QPACK indexing the token once and coding a
moving `bead-after` in a few bytes.

## Consequences

**A page of another origin preflights its connection's opening, then pays one round trip per
exchange**: 1 preflight in Chromium and WebKit, 3 in Firefox (measured, under 0027's answer),
renewed when its browser's cached answer expires, after 7,200 s in Chromium and 600 s in WebKit.
Whether a Firefox entry outlives its host's DNS TTL is unmeasured, a hostname of short TTL its check
(`docs/support.md`).

**A stale client is refused, loses its connection and reconnects**, under its reconnection policy's
delays; a tab of an earlier bundle meets the 400 once per connection.

**Each side carries an RFC 9651 Item parser**, `parseItem` on the TypeScript side and
`StructuredFields.ParseItem` on the C# side, tested on httpwg's `structured-field-tests` for Items,
their bare items and their parameters, and shared by the client's reading of `bead-listen` and
`bead-sequence`. A parameter on any of the four fields is free for a later version to give a
meaning.

**Over HTTP/2, Node's default parser drops a padded field where the C# side resets the stream**, a
platform row of `docs/support.md` beside the control character's: an application gives
`createServer` `strictFieldWhitespaceValidation: false` for the TypeScript side to reset as the C#
side does. Neither request is taken past what one without the field would be: a dropped
`bead-after` leaves a listen refused 400, a dropped `Authorization` an anonymous request, a dropped
`Origin` a request that names none.

**`Prefer` stays free** for an application's own use, and `Last-Event-ID` for an `EventSource`'s.

**The gate.** `spec/transports.json`, played by both sides: every listen writes its counts in
fields; the case of a `bead-after` that does not parse, is no Integer or is below 0, its parameters
ignored; the case of a count in two lines or as a list; the case of a listen without `bead-after`,
whatever its target holds, and of a `bead-wait` left out; `bead-listen`'s parameter ignored at
connect. Twins by the same sentence ([0004](0004-one-behaviour-in-every-language.md)) hold what no
step reaches: each side's Item parser, the counts read from several lines, the client listening at
its connection's URL alone, the field predicate's ends and the HTTP/2 reset of a padded value; the
Playwright project, a page of another origin listening through a stream of batches on one preflight
in Chromium, against both servers. `docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, which [0027](0027-an-http-server-answers-cors-to-the-origins-it-names-and-to-no-other.md)
shares for the preflight's `Access-Control-Allow-Headers`,
[0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md) for a
field value's ends, and [0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)
for the listen. Its objections, each with the answer that holds:

### The listen's fields, 0.4.0

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The padded HTTP/2 value is not a fixed platform difference: "Node gives no hook" is false, since `http2.createServer({ strictFieldWhitespaceValidation: false })` hands a padded value on as Kestrel does, and the transport takes `createServer` from the application; and the C# side already resets a control character, a violation of RFC 9113 §8.2.1, while the draft answers another violation of the same clause, whitespace around a value, with a 400 from the count's own grammar | Accepted. Measured on Node 26.5; the option came with Node 24.2.0, so the CI's 24.9 and 26 carry it. RFC 9113 §8.2.1 lists the ends beside NUL, CR and LF, and §8.1.1 makes the request a stream error `PROTOCOL_ERROR`. 15.12's field rule gains the ends: `isVisibleField` and `IsVisibleField` refuse a value with SP or HTAB at either end, judged first on every field; both sides reset over HTTP/2, as for a control character. Over HTTP/1.1 and at a WebSocket's address the parsers strip the padding (RFC 9110 §5.5), so nothing changes there and no case can play it. The control character's platform row is widened rather than a row added: Node's default drops the field, the option lets the TypeScript side reset as the C# side does, and the TypeScript README names it. Twin tests, the TypeScript one with the option set |
| The drafted row's "which no padding can make pass on either side" is false over HTTP/2: a padded `authorization` is presented and a padded `content-type` taken on the C# side (`CredentialOf`, `IsBeadBody` trim), absent on the TypeScript side; a padded `origin` is refused 403 on the C# side and read as no origin on the TypeScript side; and a padded count read as 0 renumbers a batch                                                                                              | Accepted. Verified in `CredentialOf` and `IsBeadBody`, and by the probe of the three fields across Node's default, Node with the option, and Kestrel. The first objection's rule closes the four fields at once: the C# side resets before reading any of them. What remains is the platform row, Node's default dropping the field, and the row says only what holds: a dropped `bead-after` leaves a listen without it, which this round refuses 400, so no batch is renumbered; a dropped `Authorization` leaves an anonymous request; a dropped `Origin` a request that names none. The general claim goes                                                                                                                                                                                                                                    |
| Firefox merges its preflight cache entries; it does not replace them. "Every engine keeps one entry per origin and URL, the last answer's lists" holds only for Chromium and WebKit; Firefox keeps Fetch §4.9's entry per name and departs only on `*`, stored as a literal token. With merging, the six named fields buy one Firefox preflight per cache lifetime, at the cost of an enumeration 15.12, both servers and the generator must keep current                                    | Accepted. Verified by the probes (Firefox four preflights then hits, Chromium and WebKit alternating), by `nsCORSListenerProxy.cpp`, and by the client's sequence: 3/1/1 without the names, 2/1/1 with them. The context of 0027 and of this record and the matrix say it engine by engine: Chromium and WebKit replace and match `*`, Firefox merges and never matches `*`. The value is `authorization`, then the preflight's `Access-Control-Request-Headers` joined by `", "`, then `*`, each part answering one engine; a stale enumeration would break nothing, so it bought only the one preflight. The value was put to the user against 0027's and the draft's; the user took this one                                                                                                                                                   |
| "One preflight per method's first use per Max-Age" in Firefox is false: Firefox preflights the exchange after its first preflight, whatever its method, for a reason the probes do not establish, so "Firefox 2 per 7200 s" rests on an unexplained cause; one candidate, `CheckDNSCache`, would make an entry last until the host's DNS TTL, not Max-Age                                                                                                                                    | Accepted. Verified by the probes: PP, PWP, SPP and SWPP preflight twice; PPP and PWPWP hit on the third; P DELETE G hits on G. Every "per method's first use" goes: the records and the matrix state what was measured, the first two exchanges at a URL preflighted whatever their methods, then the answer held, merging. The DNS candidate is not asserted: the matrix's "What no entry plays" names it, a hostname of short TTL its check. The move stands either way                                                                                                                                                                                                                                                                                                                                                                         |
| The draft reads RFC 9651 loosely: "an Integer with no sign and no parameter" is the definition §2.3 calls erroneous; it cites §2.3 and then makes a parameter an error against §2.3's guidance; it grounds the 400 in §2 rather than §4.2 and §2.2; and `bead-listen`, its precedent, departs from §2.3 alike, silently                                                                                                                                                                      | Accepted. Each count is an Item whose bare item is an Integer of §3.3.1, 0 or more. A parse failure (empty, `+0`, sixteen digits, two lines, a list, a key in upper case) is §4.2's second branch, the message malformed; a violated constraint (a Decimal, a String, `-1`) §2.2's other handling; `-0` parses to 0 and is taken. Parameters are ignored on `bead-after`, `bead-wait`, `bead-listen` and `bead-sequence` alike, as §2.3 advises, through an RFC 9651 Item parser per side tested on httpwg's structured-field-tests; the conformance case widens to `0;x=1` and `?1;x` taken, `0;X=1` refused. Since §2.3 discourages rather than forbids, ignoring against refusing was put to the user, who took ignoring                                                                                                                       |
| Refusing a listen whose target holds a query, while connect, send and `DELETE` take one, is a URL rule added to catch one way a client can be stale; a rule on the fields, a listen without `bead-after` is malformed, gives the same told 400 and no loop, and the server then reads no query on any exchange                                                                                                                                                                               | Accepted. The stale client writes no `bead-after` and is refused 400 `malformed`, told, loses its connection and reconnects under its delays; every Bead client writes `bead-after` on every listen. 15.9: a listen carries `bead-after`, a `bead-wait` left out is 0; no exchange's query is read. The added case is "a listen without `bead-after` is refused 400, marked, whatever its target holds", its listens with a query and with `/bead?` taken                                                                                                                                                                                                                                                                                                                                                                                         |
| Two records own the allow-headers value: this record's scope takes it while 0027, revised in place, holds it, and the objection that changes 0027 would sit in this record's table; the draft also offers to fold the value into 0027's own change, which the subject rules out                                                                                                                                                                                                              | In part. The value is 0027's alone: its Decision, its Context (the engines' caches as measured), its Consequences; this record's Scope holds the listen's fields, the field rule's ends and the parameters of `bead-listen` and `bead-sequence`, and links to 0027. The fold option goes: 0027 lands as designed, and this change revises it. Refused, the row in 0027's table: [the records' README](README.md) keeps a change's round in the first record it names, the others pointing to it, so the round stays whole here and 0027's Tenth Man points to it, which says why its decision changed                                                                                                                                                                                                                                             |
| Express's `cors`, cited as precedent for reflecting `Access-Control-Request-Headers`, writes `Vary: Access-Control-Request-Headers` when it reflects, and ASP.NET Core does not; having written `Vary: Origin` because the answer turns on `Origin`, the round does not say why an answer that turns on what the preflight asks needs no `Vary`                                                                                                                                              | Accepted. A preflight's answer is an `OPTIONS` response, which no cache stores (RFC 9110 §9.3.7); `Vary` only selects among stored responses (RFC 9111 §4.1). 15.12 and 0027 say it in one sentence, naming Express's `Vary` as the precedent not taken                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
