# 0016 — A JSON payload is read as I-JSON, its noncharacters aside, and written in RFC 8785's canonical form, the same bytes from every language

- **Status**: accepted
- **Scope**: spec section 17, and the lines that point to it; debugging 4.3 and 10.1;
  `spec/codecs.json`, its gate, and nine conversations of `spec/conversations.json`; both runtimes'
  payload codecs, public
  ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)),
  and the interop's serializers, which use them; both service managers, where a value does not
  write; the support matrix

## Context

The builder gives a procedure's payloads one of the encodings `raw`, `text` and `json`, or `proto`,
which is [0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)'s, and the
code it generates in every language reads and writes them through its runtime's codecs
([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)).
Spec section 17 states those payloads, with `spec/codecs.json` beside it.

**What each platform's default reader and writer do.** Probed on Node 26.5.0 (V8 14.6) and .NET
10.0.12, `JSON.parse` with `JSON.stringify`, and `JsonDocument.Parse` with `JsonSerializer`, part on
every row below. RFC 7493 does not refuse a byte order mark: RFC 8259 §8.1 forbids a writer to add
one, and lets a parser ignore one.

| Bytes read                                                             | `JSON.parse`, then `JSON.stringify`                                     | `JsonDocument.Parse`, then `JsonSerializer`              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `22 4A 6F 73 C3 A9 20 61 2B 62 20 3C 78 3E 22`, a string outside ASCII | as read                                                                 | `"Jos\u00E9 a\u002Bb \u003Cx\u003E"`                     |
| `"\u00e9\/"`                                                           | `22 C3 A9 2F 22`, the character in UTF-8                                | `"\u00E9/"`                                              |
| `1.0`, `1E2`, `-0`, `1e21`                                             | `1`, `100`, `0`, `1e+21`                                                | as read                                                  |
| `12345678901234567890`                                                 | `12345678901234567000`                                                  | as read                                                  |
| `1E400`                                                                | `null`                                                                  | as read                                                  |
| `{"a":1,"a":2}`                                                        | `{"a":2}`                                                               | as read                                                  |
| `{"b":1,"1":2,"0":3}`                                                  | `{"0":3,"1":2,"b":1}`                                                   | as read                                                  |
| `"\ud800"`, a surrogate alone                                          | as read                                                                 | nothing: `JsonSerializer` throws `JsonException`         |
| `22 FF 22`, a byte that is not UTF-8                                   | `22 EF BF BD 22`, U+FFFD in UTF-8                                       | `"\uFFFD"`                                               |
| `EF BB BF 31`, a byte order mark                                       | `1`                                                                     | refused                                                  |
| 65 arrays nested                                                       | as read: `JSON.parse` and `JSON.stringify` take 1,000,000 under Node 26 | refused: `JsonDocumentOptions.MaxDepth` is 64 by default |

And of a value JSON has no form for, given to its writer: `JSON.stringify` writes `NaN` as `null`,
drops a member whose value is `undefined`, and writes `undefined` as an empty payload, 0 bytes,
which no JSON reader takes (`JSON.stringify(undefined)` is `undefined`, and `TextEncoder` encodes it
as `""`). `JsonSerializer` takes a `JsonElement`, which holds no `NaN` and no infinity, but can hold
what no reader takes: a `default(JsonElement)`, of kind `Undefined`, on which `JsonSerializer`
throws `InvalidOperationException`; and an object naming a member twice, which `JsonDocument.Parse`
and `JsonElement.Parse` build with their defaults and `JsonSerializer` writes back.

Four inputs reach another outcome, not only other bytes: a byte order mark, a surrogate alone, 65
arrays nested, and `1E400`.

Bead asks one behaviour of every language ([0004](0004-one-behaviour-in-every-language.md)): the
codecs agree, so that the clients the builder generates send one form, and a third language copies
one form, not one of two.

What had to be settled, and the ways weighed for each:

**The order of an object's members.** Four ways:

- **Each platform's own**: free, and two forms of one value, a third with a C side.
- **In the order the value holds them**: the author's order kept on the wire. But an ECMAScript
  object holds a name that is an array index — a canonical decimal from 0 to 2³² − 2 — before every
  other, in ascending numeric order (ECMA-262, OrdinaryOwnPropertyKeys): the TypeScript side reads
  `{"b":1,"1":2,"0":3}` and holds `{"0":3,"1":2,"b":1}`, `"4294967294"` moved and `"4294967295"`,
  `"-1"` and `"01"` not. This way holds on the sides whose objects keep the order they are given,
  and fails on the TypeScript side for ever: a row of the matrix no work closes.
- **In ECMA-262's order of an object's names**, the order `JSON.stringify` writes
  (`SerializeJSONObject` takes `EnumerableOwnProperties`, whose order `OrdinaryOwnPropertyKeys`
  defines): the array-index names first, ascending, then every other name in the order it was given.
  It is the standard RFC 8785 itself takes its strings and numbers from (RFC 8785 §3.2.2), and keeps
  the author's order for every name that is not an array index. The TypeScript writer is a walk that
  refuses what JSON has no value for, then `JSON.stringify`: 3.0 to 4.2 ms on a payload of 770,886
  bytes, 9,000 objects of five members, against 1.3 to 1.7 for `JSON.stringify` alone. The C# side
  and the generator move each object's array-index names ahead, a stable partition. What it gives
  up: one form for one value whatever order it was built in — `{a, b}` built by one side and
  `{b, a}` by the other are two forms; and RFC 8785's conformance, to anyone who checks it.
- **RFC 8785 whole, the JSON Canonicalization Scheme**: each object's members sorted by their names'
  UTF-16 code units (RFC 8785 §3.2.3). One value has one form, built in whatever order; the scheme
  is a standard with test data (its Appendix B) and implementations in many languages, which a third
  language takes as it is, where the third way has every language copy an engine's rule for its
  objects. What it gives up: the author's order on the wire, which RFC 8259 §4 and RFC 7493 §2.3 say
  carries no meaning; and `JSON.stringify` on the TypeScript writer, since every ordinary object
  holds its array-index names first again: the writer writes such an object by hand, and is 7.7 to
  12.5 ms on the payload as tuned (below), against 3.0 to 4.2 for the third way.
- **Chosen: RFC 8785 whole.**

**A string.** RFC 8785 §3.2.2.2 writes a string as ECMAScript's `JSON.stringify` writes a
well-formed one: each character as it is, but `"` and `\`, five control characters as short escapes,
and the other control characters as `\u` with lower-case hexadecimal. .NET writes none of its forms
of this: its default encoder escapes every character outside ASCII and the HTML-sensitive ones, `"`
as `\u0022`; `JavaScriptEncoder.UnsafeRelaxedJsonEscaping` still escapes U+007F, U+2028, U+2029,
U+FEFF, every character past U+FFFF and the unassigned ones, in upper-case hexadecimal; and
Microsoft's documentation calls the encoders' global block list "an implementation detail that has
changed in every release of .NET" ("How to customize character encoding with System.Text.Json"). So
the C# side writes a string by hand.

A string holding a surrogate alone, given to a writer, has three answers: refused, as RFC 8785
§3.2.2.2's note requires; written as U+FFFD, as spec 7.4 writes a detail's and the metrics registry
a name's (0013); or escaped, `\ud800`, as `JSON.stringify` writes it since ECMAScript 2019.
**Chosen: refused.** A payload is data its procedure reads, where a detail is words a person reads;
and the escape writes what every reader refuses (RFC 7493 §2.1).

**A number.** RFC 8785 §3.2.2.3 writes a number as ECMAScript's Number::toString writes its double.
.NET's `Utf8JsonWriter` writes `1E+21`, `1E-07` and `-0` where ECMAScript writes `1e+21`, `1e-7` and
`0`, so the C# side lays out the shortest digits `double.ToString("R")` gives as ECMAScript does:
the two agree on 2,009,225 doubles. A number that is not finite — `NaN`, an infinity — is refused,
as RFC 8785 §3.2.2.3's note requires, where `JSON.stringify` writes `null`.

Reading a number's text into its double is the other half, and the platforms part on it.
`JSON.parse`, Python's `float` and .NET's `double.Parse` read each of 299,886 decimal texts at and
beside the midpoint of two neighbouring doubles alike, an exact tie to the even neighbour;
`JsonElement.TryGetDouble` and `GetDouble` read 34 of them otherwise, each an exact tie of 768
significant digits near 1e-308, which they read to the odd neighbour. One of them: `JSON.parse` and
`double.Parse` read `000793e270fc0ae4`, `GetDouble` `000793e270fc0ae5`. So the C# side reads a
number's raw UTF-8 with `double.Parse`, which `JsonMarshal.GetRawUtf8Value` hands with no string
made, and reads all 299,886 as Python does; it costs 0.8 ms on the payload's 18,000 numbers, against
0.6 for `TryGetDouble`. `double.Parse` reads `1E400` as `Infinity`, so the test of a finite double
stays after it.

**What a reader refuses.** RFC 8785 §3.1 takes its input as I-JSON (RFC 7493), and I-JSON is what a
reader refuses besides what is not JSON. Each item, with what each platform does:

- **Bytes that are not UTF-8** (RFC 7493 §2.1, RFC 8259 §8.1): `TextDecoder` refuses them with
  `fatal: true`; .NET's reader takes a byte that is not UTF-8 within a string and writes it back as
  `\uFFFD`, so `Utf8.IsValid` runs first, as each side's JWT verifier does (13.8).
- **A byte order mark**: RFC 8259 §8.1 lets a parser ignore one. Ignored, it is what `TextDecoder`'s
  default and `JsonDocument.Parse(Stream)` do; refused, what
  `JsonDocument.Parse(ReadOnlyMemory<byte>)` does — its documentation: "Because the input is
  considered to be text, a UTF-8 Byte-Order-Mark (BOM) must not be present" — and what spec 13.8,
  step 1, does with a token's parts. **Chosen: refused**, as 13.8 refuses it: a writer never adds
  one, and a reader that skips one reads two forms of one value. `TextDecoder` keeps it with
  `ignoreBOM: true` (`implementations/typescript/src/router/shared/payloads.ts`).
- **A name given twice** (RFC 7493 §2.3): `JSON.parse` keeps its last value, with no check to turn
  on; `JsonDocument` keeps both unless `JsonDocumentOptions.AllowDuplicateProperties` is `false`, an
  option .NET 10 brings, documented: "If set to `false`, JsonException is thrown when a duplicate
  property name is encountered". Both verifiers check it: `namesOnce` (`payloads.ts`) and
  `AllowDuplicateProperties = false` (`JwtVerifier.cs`).
- **A surrogate alone**, which only an escape writes (RFC 7493 §2.1): `JSON.parse` takes `"\ud800"`;
  `JsonDocument.Parse` takes it and `GetString` throws `InvalidOperationException`; with
  `AllowDuplicateProperties = false`, a name holding one throws `InvalidOperationException` from the
  parse itself, not `JsonException`, which the JWT verifier catches (`JwtVerifier.cs`).
- **A noncharacter**, U+FFFF and the 65 others: RFC 7493 §2.1 says a string MUST NOT hold one;
  Unicode's Corrigendum #9 (2013) says one may be interchanged, and the RFC came after it. Neither
  platform's reader refuses one, nor spec 13.8's, nor a `text` payload (17.4) — but `JSON.parse`
  refuses no name given twice either, and this record refuses it: what a platform takes is no reason
  here. Refusing one costs the TypeScript reader a test of each string and name against
  `/\p{Noncharacter_Code_Point}/u`, which Node 26 supports: 2.2 to 4.2 ms on the payload as a walk
  of its own, less within the walk that runs already; and the C# side a comparison of each UTF-16
  unit within the loop its writer runs already. **Chosen: taken**, so that a string is any sequence
  of Unicode scalar values in every encoding Bead states, `text` and 13.8's claims as `json`; a
  departure from RFC 7493 the spec names, and the title says.
- **How deep**: RFC 8259 §9 lets a parser limit nesting. `JSON.parse` sets no limit, and a peer then
  chooses how deep a reader goes: 16 MiB of nested arrays, the default `maximumPayloadBytes`, take
  it 1.1 s and 487 MB of heap. `JsonDocumentOptions.MaxDepth` is 64 by default ("the default (that
  is, 0) indicating a maximum depth of 64"), and refuses the 65th level as it reads;
  `Utf8JsonWriter`'s own bound, 1,000, refuses to write past it even when the reader was told more;
  a C side parses on a stack it sizes as it is built. **Chosen: 64**, the bound .NET's reader holds
  by default, refused before anything deeper is built: the TypeScript reader counts the depth over
  the decoded text before `JSON.parse`, its strings skipped and every loop bounded by the text's
  length, and refuses the 16 MiB in 2.6 to 3.1 ms, with no heap taken.
- **A number past a double**: RFC 7493 §2.2 says a sender SHOULD NOT write one. `JSON.parse` reads
  `1E400` as `Infinity`, which `JSON.stringify` then writes `null`; `JsonDocument` keeps its text,
  and `GetDouble` gives `Infinity`. **Refused**: no double holds it.
- **Digits past a double's precision**: refused, every number that is not exactly a double — `0.1`
  among them, which no reader wants; refused, every integer past 2⁵³ − 1, as spec 1.2 refuses a
  64-bit field — which refuses `1e300` and reads two spellings of one double two ways; or **rounded
  to the nearest double, chosen**, as RFC 8785 §3.1 and `JSON.parse` do, RFC 7493 §2.2's strings
  carrying what needs more.
- **A value that is not an object or an array at the top**: RFC 7493 §4.1 says protocol designers
  SHOULD NOT use one. Bead's payloads are `null`, a string or a number at the top
  (`spec/conversations.json`'s `6E 75 6C 6C` and `22 78 22`). **Taken**: a payload's shape is its
  procedure's to choose, not its codec's.

**The value a reader hands on.** `JsonElement` keeps a number's digits: a C# resolver that calls
`GetInt64` on `9007199254740993` gets a value a TypeScript resolver cannot, `GetInt32` on `1.0`
throws where a TypeScript resolver reads 1, and `GetDouble` on `-0` gives −0 where the TypeScript
reader gives 0 — as the interop's own resolvers call them. The element may be handed on as read,
cheaper, and the C# side then does Y and Z where the TypeScript side does Y, which the rule of
parity refuses; or as the value of its canonical form, which costs the C# reader its canonical write
and, when the bytes read are not canonical already, a second parse. **Chosen: the canonical
form's.** The `JsonElement`'s exact digits are then no argument against `google.protobuf.Value`: the
writer rounds them on the wire anyway.

**What a language holds that JSON has no value for.** `JSON.stringify` converts: `undefined` dropped
in an object, `null` in an array, an empty payload alone; `NaN` as `null`; a `Date` through its
`toJSON`; a `Map` as `{}`. Kept, the TypeScript writer writes what no C# `JsonElement` can hold, and
an empty payload no reader takes. **Chosen: refused**: the writer takes JSON data — `null`, `true`,
`false`, a finite number, a well-formed string, an array without holes, an object of the plain kind
— as the `JsonValue` type has it. On the C# side, an `Undefined` element and an object naming a
member twice are refused alike.

**A value that does not write.** Refusing `NaN`, a `Date`, a member `undefined` and a surrogate
alone makes it ordinary. For a notification: the throw handed to the code that notifies, which
breaks the rule both sides keep that notifying never fails its caller; or **reported, as its router
reports a notification that does not go, and counted `failed` for each subscription it was for,
chosen**, as a notification too large for one envelope is (`spec/debugging.md` 10.1). For a request:
its failure told as its `rx`; or **its value written before its trace and its deprecation, chosen**,
so that a call whose value does not write is no call made: nothing traced, nothing deprecated,
nothing counted, as a request whose payload does not decode is not traced (debugging 4.3).

**`text` and `raw`.** A `text` payload that is not UTF-8 can be read as spec 7.3 reads a detail, its
bytes U+FFFD, or refused; **refused**, since a payload is data. A leading U+FEFF can be stripped, as
`TextDecoder`'s default does, or kept as a character, as RFC 3629 §6 recommends ("It is therefore
RECOMMENDED to avoid stripping an initial U+FEFF interpreted as a signature without a good reason")
and as spec 7.3 keeps a detail's; **kept**: `text` takes any string, and a string may start with
one. A `text` writer refuses a surrogate alone, as `json`'s does. `raw` is its bytes, and settles
nothing.

**Where the codecs live.** In the interop's serializers alone, where `codecs.json`'s `text` and
`raw` rows would have no codec to play; or in each runtime, the interop's serializers delegating to
them. **Chosen: the runtimes**: the code is written once, where it stays, and
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)
makes it public.

**Where it is stated.** Spec section 17. Not the companion, `spec/debugging.md`, whose reason is
that what it states never crosses the wire (0013): a payload does. The preamble's sentence "a side
conforms to the wire by sections 1 to 15" stays: a relay reads no payload (14.2), and a side may
offer `raw` alone. The sentence goes on, as
[0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md) has it too: a side
conforms to what it declares by section 16, and to what its codecs write and read by section 17, for
each encoding it offers.

## Decision

**A `json` payload has one form, whichever side writes it.** It is one JSON text (RFC 8259) in
UTF-8, read as an I-JSON message (RFC 7493) but for its noncharacters, and written in the canonical
form of the JSON Canonicalization Scheme (RFC 8785, section 3.2): one value, one sequence of bytes.
Spec section 17 states it.

**A reader refuses what I-JSON refuses, a noncharacter aside**, each with `PAYLOAD_UNDECODABLE`:
bytes that are not UTF-8; a byte order mark; bytes that are not one JSON text; an object that names
a member twice, its names compared once their escapes are read; a name or a string holding a
surrogate alone; a number that rounds past the largest finite double; an array or an object nested
deeper than 64, refused before anything deeper is built. It takes a noncharacter, and a value of any
kind at the top.

**A number is a double.** A reader reads each as the IEEE 754 double nearest it, a tie to the even,
as `JSON.parse` and `double.Parse` do and `JsonElement`'s own reading does not: digits past a
double's are rounded, and an integer past 2⁵³ − 1 may not stay exact. A value that needs more
travels as a string, as RFC 7493 §2.2 recommends.

**A writer writes RFC 8785's canonical form, and refuses what no reader takes.** No white space;
`null`, `true`, `false`; a string as ECMAScript's `JSON.stringify` writes a well-formed one; a
number as ECMAScript's Number::toString writes its double, `-0` as `0`; an array's elements in their
order; an object's members sorted by their names' UTF-16 code units, at every depth; the whole in
UTF-8. It refuses a number that is not finite, a string or a name holding a surrogate alone, an
object naming a member twice, a value nested deeper than 64, and whatever a language holds that JSON
has no value for: JavaScript's `undefined`, a C# `JsonElement` of kind `Undefined`.

**The value a reader hands on is its canonical form's.** `1.0` and `1` are one value on every side,
and `12345678901234567890` is `12345678901234567000` on every side: the C# reader hands on the
document it read when its bytes are the canonical form's already, and otherwise parses the canonical
bytes it writes of it; the TypeScript reader turns `-0` into `0`.

**`text` is UTF-8, read strictly, its leading U+FEFF kept; `raw` is its bytes.** A `text` reader
refuses bytes that are not UTF-8, and a `text` writer a string holding a surrogate alone.

**What does not read, or does not write, fails where it is**, the same on both sides:

- a request's payload that does not read is answered `PAYLOAD_UNDECODABLE`, before its resolver sees
  it (`service-resolver.ts`; `ServiceManager.Resolver.cs`);
- a result's fails its call `PAYLOAD_UNDECODABLE` at the requester (`service-requester.ts`;
  `ServiceManager.Requester.cs`);
- a notification's is reported `PAYLOAD_UNDECODABLE`, and no callback hears it (`notification.ts`,
  `Notification.cs`);
- a request's value that does not write fails its call before anything goes, written before its
  trace and its deprecation: no call is made, and nothing is traced;
- an answer's, as a resolver that fails: `PROCEDURE_FAILED`, reported (`service-resolver.ts`;
  `ServiceManager.Resolver.cs`);
- a notification's goes to none of its subscriptions: reported, and counted `failed` for each.

**Where Bead departs from the standards it names, it says so:**

| Standard      | It says                                                                           | Bead                                                                                           | Why                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| RFC 7493 §2.1 | a string MUST NOT hold a noncharacter                                             | takes one                                                                                      | a string is any sequence of Unicode's scalar values, in `json` as in `text` and 13.8; Corrigendum #9 lets noncharacters be interchanged |
| RFC 7493 §4.1 | a protocol SHOULD NOT use a top-level text that is neither an object nor an array | takes and writes any value at the top                                                          | a payload's shape is its procedure's to choose, not its codec's                                                                         |
| RFC 8259 §8.1 | a parser MAY ignore a byte order mark                                             | refuses one                                                                                    | a writer never adds one, 13.8 refuses one, and one value keeps one form                                                                 |
| RFC 8259 §9   | a parser may limit nesting                                                        | at 64, before anything deeper is built                                                         | a peer never chooses how deep a reader goes; .NET's default                                                                             |
| RFC 7493 §2.2 | a sender SHOULD NOT write a number past a double                                  | a reader refuses one that rounds past the largest double, and rounds digits past its precision | no double holds the first; the second is what every JSON reader of doubles does                                                         |
| RFC 8785      | —                                                                                 | none: its form is written whole                                                                | —                                                                                                                                       |

**One file pins it: `spec/codecs.json`**, written whole by `spec/generators/make_codecs.py` from
Python tables, with the standard library alone ([0005](0005-a-toolchain-per-language.md)), its
schema saying its shape. Two groups: `payloads`, bytes read in an encoding, and either the bytes
written back of what was read, or `refused` and its reason; and `values`, a value given to a writer,
in a form a file can hold, a named form among them for what no JSON text holds, and either the bytes
written, or `refused` and its reason.

**A reason is derived, and held by the regeneration alone**, as a duration's is
([0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md)): `not UTF-8`,
`a byte order mark`, `not JSON`, `a name twice`, `a surrogate alone`, `a number past a double`,
`nested past 64`, `not a finite number`, `no JSON value`. No harness reads it: a refusal answers
`PAYLOAD_UNDECODABLE` whatever the reason, and its words are each side's.

**Each side plays the file in one harness.** For a payload, its reader reads the bytes, and the
harness checks the refusal, or that its writer writes back the bytes given and that the value read
equals the value its reader reads of those bytes: through Playwright's `expect(…).toStrictEqual` on
the TypeScript side, which tells `-0` from `0` within a value; on the C# side through
`JsonElement.DeepEquals`, which compares numbers by their value and tells neither `1.0` from `1` nor
`-0` from `0`, and so also through the element's `GetRawText()`, which must be the bytes its writer
writes of it: an element read as it came, not as its canonical form, fails there. For a value, its
writer writes the value built from its form, and the harness checks the bytes or the refusal. A
harness plays every row but those a `differs` excuses its language from, and fails otherwise.

**A difference crosses its row.** A `differs` names a row of `docs/support.md` that names
`spec/codecs.json` and the row's name between backticks, as in every file of entries
([0004](0004-one-behaviour-in-every-language.md)), and as `spec/check.py` checks. One platform
row: "A value a side's type cannot hold". The C# side cannot be given `NaN` or an infinity, which no
`JsonElement` holds as a number; the TypeScript side cannot be given an object naming a member
twice, which no JavaScript object holds.

**Nine conversations play it over the wire**, each a request to `echo`: what `codecs.json` cannot
hold, which code a server answers and that the refusal comes at the read and not at the write, and
that a name holding an escape is read as its escapes say, whatever a payload of its shape read on
another connection held.

**Each runtime holds the codecs**, public under the names
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)
gives them: the TypeScript side's in `src/router/shared/payloads.ts`, the C# side's in
`Bead.Core/Payloads.cs`. The interop's serializers delegate to them.

**The rule has its gate** ([0006](0006-a-rule-has-its-gate.md)): `spec/check.py` holds the file in
the frame of every file of entries ([0004](0004-one-behaviour-in-every-language.md)), as its header says.

## Consequences

**A peer that relies on a platform's leniency is refused**: a byte order mark, a name twice, bytes
that are not UTF-8, a surrogate alone, a number past a double, nesting past 64. A C# peer writes
outside ASCII as it is, and its numbers in ECMAScript's form.

**The TypeScript side reads a payload, and a token's header and claims, whose member name holds an
escape through a reader of its own**: `JSON.parse` holds the text to JSON's grammar, and the value
is built name by name, each scalar read by `JSON.parse` alone. V8's `JSON.parse` can hand such a
name over as the name of an earlier object of the same shape, one holding a backslash and as long
once read, from any connection of the process. A peer that escapes a name costs its payload's read
up to about three times, linear in its bytes and bounded by `maximumBodyBytes`.

**The author's order of members does not reach the wire.** A `curl`, a log of bytes and the DevTools
panel's Wire view read `{"id":…,"type":…}` where the code wrote `{type, id}`; the trace of the side
that sends keeps the value it was given, in its order (debugging 4.1, `tx`). RFC 8259 §4 says an
object is unordered; a reader that leans on the order was wrong already.

**An integer past 2⁵³ − 1 is exact on no side**, the C# side's resolvers among them. An application
that needs one sends a string.

**Reading and writing JSON cost more**, measured on the prototypes the decision weighed, not tuned,
on a payload of 770,886 bytes, each a range over three runs of one noisy machine, the C# side in
Release and warmed past the JIT's tiers:

| Side              | Platform's default                                   | The prototype                                     | Times      | The parts                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript, read  | 2.9 to 4.5 ms: `TextDecoder` and `JSON.parse`        | 10.6 to 19.2 ms                                   | 2.6 to 4.3 | the depth before the parse, 1.8 to 3.1; the names given twice after it, a `Set` an object, 5.2 to 9.3; a walk for surrogates alone, numbers past a double and `-0`                                          |
| TypeScript, write | 1.3 to 1.7 ms: `JSON.stringify` and `TextEncoder`    | 7.8 to 12.5 ms                                    | 6 to 7.5   | one pass that refuses and copies each object sorted into one of a `null` prototype, then `JSON.stringify`; by hand when a name is an array index. ECMA-262's order would cost 3.0 to 4.2 ms, 2.2 to 3 times |
| C#, read          | 2.2 to 3.6 ms: `JsonDocument.Parse` and `Clone`      | 12.6 to 15.3 ms canonical; 14.6 to 26.7 otherwise | 4 to 7.5   | the check of UTF-8, the strict parse, the canonical write; a second parse when the bytes read are not canonical                                                                                             |
| C#, write         | 4.3 to 5.3 ms: `JsonSerializer.SerializeToUtf8Bytes` | 8.2 to 12.3 ms                                    | 1.6 to 2.8 | a sort per object, each string and number by hand                                                                                                                                                           |

`raw` and `text` pay nothing more than a check of UTF-8. The TypeScript reader's scan for names
given twice is where tuning starts: counting names against the parsed value's members, and holding
them only when the counts part, leaves a `Set` out of every object that names each member once. The
C# writer writes into an `ArrayBufferWriter<byte>`, where its prototype built a string before its
bytes.

**A canonical form can be about five times its payload.** `1e20`, 4 bytes, is written
`100000000000000000000`, 21. A C# reader given 16 MiB of `[9e20,9e20,…]` writes about 74 MB of
canonical bytes before it parses them again, and on both sides an echo of a payload within
`maximumPayloadBytes` can answer one past it, which then fails as a result its side cannot send
(spec 12.1, 12.2): answered `PROCEDURE_FAILED`, reporting `PAYLOAD_TOO_LARGE`. Every other token is
written as long as it came, or shorter.

**A JavaScript value JSON has no value for is refused, not converted.** `undefined`, a function, a
`BigInt`, a `Date`, a `Map`, an object of a class, an array with a hole: the TypeScript writer
throws, a request fails before it goes, an answer is answered `PROCEDURE_FAILED`, a notification
goes to none and is reported. Code that relied on `JSON.stringify`'s conversions writes JSON first.
On the C# side, a string holding a surrogate alone that an application gives `JsonSerializer` to
make a `JsonElement` is written there as U+FFFD, before the codec sees it: the platform row says so.

**Two JSON readers on each side.** A token's parts keep spec 13.8's reading, which sets no depth and
lets a claim's string hold a surrogate alone that "names nothing"; a payload is read by section 17.
The two share the strict decoder and the scan for names given twice; making 13.8 read as 17 does is
a decision of its own.

**A third language pays for two algorithms**: the shortest digits of a double, laid out as
ECMAScript lays them out — Ryū, or Grisu with a fallback, as RFC 8785 §3.2.2.3 points to — and the
nearest double of a number's text, a tie to the even, which its platform's JSON reader may not give,
as .NET's does not; and names compared by UTF-16 code units, which a C side with UTF-8 strings
converts, or compares in UTF-8 where no name holds a character past U+FFFF together with one from
U+E000 to U+FFFF (RFC 8785 §3.2.3's note).

**A value a side's type cannot hold** is a platform row of the matrix.

**The layout, `0xA1`, does not move**: no envelope changes.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)),
and the user chose where it asked: RFC 8785 whole, a noncharacter taken, 64 deep, the canonical
form's value, what JSON has no value for refused, the codecs in the runtimes, sections 16 and 17 in
one release of the spec, and a value that does not write settled alike. Its objections, each with
the answer that holds:

| Objection                                                                                                                                                                                                                                                        | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The C# reader takes a number from `TryGetDouble`, which reads a tie of 768 digits to the odd neighbour, so 17.6's "a tie to the even" is false on the C# side, and the two million doubles tested writing alone                                                  | Accepted: the C# side reads a number with `double.Parse` of its raw UTF-8, `// !` saying why, the finite test after it; that overload reads all 299,886 midpoint texts as Python and `JSON.parse` do; two payload rows hold the tie and the digit past it, and a value row the tie given as its digits, for the C# writer; the Context says what tested reading                                                                                                                                       |
| A `JsonElement` can be `default`, of kind `Undefined`, or name a member twice, which the planned writer writes, against 17.2; the C# side is excused from the `undefined` row it can play                                                                        | Accepted: the C# writer refuses an `Undefined` element, `no JSON value`, and a name twice, two equal names side by side once sorted; the `undefined` row is played by C# as `default(JsonElement)`, with no `differs`; a value row "an object naming a member twice" excuses the TypeScript side; the platform row states what each side cannot be given; C# plays every value row but two, TypeScript every one but one                                                                              |
| The TypeScript reader runs `JSON.parse` before the scan that refuses past 64, so a peer still chooses how deep it goes, up to 16 MiB; and the scan loops for ever on a string never closed                                                                       | Accepted: the depth is counted over the decoded text before `JSON.parse`, strings skipped, every loop bounded by the text's length; 16 MiB of nested arrays is refused in 2.6 to 3.1 ms with no heap taken, and a string never closed is refused as not JSON; a twin test on each side refuses the 16 MiB within a second                                                                                                                                                                             |
| 17.2.4 says a notification's value that does not write fails the code that notifies, and a request's fails before anything goes; on both sides the first is dropped, neither reported nor counted, and the second is traced and deprecated before the encode     | Accepted: both sides settle one behaviour, chosen in the Context: a request's value written before its trace and its deprecation, so no call is made and nothing is traced (debugging 4.3 says so); a notification's reported as its router reports one that does not go, and counted `failed` for each subscription it was for (10.1 has the case); twin tests on both sides                                                                                                                         |
| Three outcomes that change on the wire have no conversation: a surrogate alone, 65 arrays nested and `1E400`; `codecs.json` cannot hold which code a server answers, nor that the refusal comes at the read                                                      | Accepted: three echo conversations, each answered `PAYLOAD_UNDECODABLE`; the interop's comments say what its codec does                                                                                                                                                                                                                                                                                                                                                                               |
| "Three to four times" is false for the TypeScript side, and the price of sorted members on the TypeScript writer goes unstated: a sorted object cannot be handed to `JSON.stringify`                                                                             | Accepted: each side's ratio as measured, by its parts; the tuned writer the objection names was measured and held byte-equal to the hand writer, `__proto__` and array-index names among the rows: 7.8 to 12.5 ms, against 3.0 to 4.2 for ECMA-262's order and 1.3 to 1.7 for `JSON.stringify` alone. The Context states it                                                                                                                                                                           |
| The third way of ordering members is dismissed as no standard, yet ECMA-262's order is the standard RFC 8785 copies for strings and numbers, the closest way to the builder's design as first taken and the cheapest; what it gives up is a goal the draft added | Accepted in part: the third way is described as ECMA-262's order, its cost measured on each side, and what each way gives up stated in the Context. The recommendation stays RFC 8785 whole, and the user takes it: one value one form, built in whatever order, is what "canonical" means and what a third language takes ready-made, where ECMA-262's order has every language copy one engine's rule for its objects                                                                               |
| `JsonElement.DeepEquals` tells neither `1.0` from `1` nor `-0` from `0`, so the C# harness barely holds the canonical form's value                                                                                                                               | Accepted: the C# harness also holds the handed-on element's `GetRawText()` to the bytes its writer writes of it, which an element read as it came fails                                                                                                                                                                                                                                                                                                                                               |
| The preamble goes from "1 to 15" to "1 to 17" against the builder's design, which the user took, and would stop a relay or a side with `raw` alone from conforming to the wire                                                                                   | Accepted: the preamble keeps "1 to 15", and adds that a side conforms to section 17 for each encoding it offers; sections 16 and 17 land in one release of the spec, neither depending on the other                                                                                                                                                                                                                                                                                                   |
| The reasons to take a noncharacter do not hold: both sides check every character of every string already, and "no platform's reader refuses it" is not held elsewhere                                                                                            | Accepted in part: the choice is put as RFC 7493 §2.1 against Corrigendum #9, the cost measured where it falls — a test against `\p{Noncharacter_Code_Point}` on the TypeScript side, where `isWellFormed` runs natively and no character loop runs in JavaScript; a comparison a unit in the C# writer's loop — and the title says "its noncharacters aside". The recommendation stays, and the user takes it: taken, so that a string is any sequence of scalar values in every encoding Bead states |
| A canonical form can be five times its payload, so the C# reader's copy and second parse let a peer make it allocate several times the payload, and an echo can answer past `maximumPayloadBytes`                                                                | Accepted: both are in the Consequences; the C# reader hands on the document it read when its bytes are canonical already, as every conversation's are, and writes into an `ArrayBufferWriter<byte>`                                                                                                                                                                                                                                                                                                   |
| No row holds a member named `__proto__`, which the faster sorted copy the draft names would lose                                                                                                                                                                 | Accepted: a payload row and a value row, played on both sides; the tuned writer copies into objects of a `null` prototype, which keep `__proto__` as a member, and is byte-equal to the hand writer on it                                                                                                                                                                                                                                                                                             |
| The departures table leaves out RFC 7493 §4.1, which advises against a top-level value other than an object or an array                                                                                                                                          | Accepted: a row, any value taken and written at the top, since a payload's shape is its procedure's to choose                                                                                                                                                                                                                                                                                                                                                                                         |
