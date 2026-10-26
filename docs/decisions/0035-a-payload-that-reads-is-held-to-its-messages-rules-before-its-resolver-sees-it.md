# 0035 — A payload that reads is held to its message's rules before its resolver sees it

- **Status**: accepted
- **Scope**: the protocol, both runtimes and the builder: in [`spec/spec.md`](../../spec/spec.md),
  8.1's `PAYLOAD_INVALID`, 9.2's step 9, 9.5, 17.2's first item and section 18; in
  [`spec/debugging.md`](../../spec/debugging.md), 4.2 to 4.4, 7.6, 7.7, 9.4's and 9.6's rows of a
  request its rules refuse; `spec/validations.proto`, `spec/validations.json`, their schema and
  their generator, `spec/generators/make_validations.py`, with the pin of Unicode's files,
  `spec/generators/ucd.json`; the interop's `checked`, its conversations and its exit; the
  blueprint's feature `validate`, beadc's rules on payload rules, its pattern compiler and its
  Unicode tables, and `beadc breaking`'s `PROCEDURE_RULES_TIGHTENED`; both runtimes' service
  managers, service layers and `proto` modules; the differential against protovalidate-es. The
  descriptor's `validate` and the options of the layer that hands it on are
  [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s;
  the blueprint's form and its features,
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s; the
  bounds a side keeps against a peer, [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s, whose
  terms this record holds its own in. The rules written in CEL are ahead, by a round of their own.

## Context

**A procedure's request is often held to more than its encoding**: a count of 10 at most, a name of
1 to 63 characters, one of two fields set. Written in each resolver, a rule is written once a
language, judged after the call reached the application, and answered with a failure of the
procedure's own, which no client tells from any other. The ecosystem's norm for such rules in a
`.proto` is protovalidate, `buf/validate/validate.proto` at
[v1.2.2](https://github.com/bufbuild/protovalidate/blob/v1.2.2/proto/protovalidate/buf/validate/validate.proto)
(Apache-2.0): `(buf.validate.field)`, `(buf.validate.oneof)` and `(buf.validate.message)`, each
standard rule a member of its type's rules message whose meaning is a CEL expression of its own, a
few played natively, `required`, `ignore`, `enum.defined_only` and a oneof's `required`. Buf ships
protovalidate for Go, Java, Python, C++ and ES, none for .NET; its conformance runner is a Go
program, released as no binary.

**No order and no words are the standard's.** protovalidate's conformance sorts violations by
`rule_id`, then path, and compares a message only under `strict_message`. Probed on one message:
protovalidate-es 1.3.0 orders by declaration and, within a field, by its own code, `string.len`
before `string.min_len`, `enum.defined_only` before `enum.const`, map entries in their insertion
order; protovalidate-python 2.0.0 by a third order, other words, `0.30000000000000004` written
`0.3`, and its Windows wheel aborted the process on a map. A float's bound widens to a double in
protovalidate-es's words, `0.10000000149011612`.

**A pattern is a peer's input to a regular expression.** RE2's syntax is the rule's, a match linear
in the input. JavaScript's `RegExp` took 16.6 s on `^(a+)+$` and 29 bytes, and parts from RE2 on
`.`, `\s` and inline flags; .NET's `Regex` on `\d`, `\w` and `$`; a backtracking engine fed a peer's
input is [CWE-1333](https://cwe.mitre.org/data/definitions/1333.html). A Thompson simulation is
linear but costs the input's length times the program's size, which buf lets reach thousands of
instructions: 1,438 ms on 64 KiB of `[a-z]{1,1000}[0-9]`. A DFA built ahead of time by subset
construction holds about as many states as the program has instructions for every pattern a field's
rules hold in practice, `^\pL{1,1000}$` 10,025 cells, and passes 200,000 states only for an
unanchored counted `.`, `a.{20}`. `@bufbuild/re2` builds a `\p` class from the running Node's
`RegExp`, so Node 24 and 26 already put U+10940, a letter of Unicode 17.0, in `^\pL$`.

**What other RPCs answer**: gRPC's `INVALID_ARGUMENT` with `google.rpc.BadRequest`'s field
violations ([AIP-193](https://google.aip.dev/193)), and Connect's validation interceptor its
`buf.validate.Violations`, each beside the code as structured data. A detail cut anywhere is no JSON
object; JSON Lines, a text a line, keep every whole line a cut leaves, and
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)'s text never holds a raw line feed.

**What a judging holds, unbounded**: a validator that keeps every violation holds 267 MiB more for
1,000,000 empty items of a 1.91 MiB request, where the detail carries about nine.

## Decision

**A `proto` request's rules are protovalidate's, as `validate.proto` states them; beadc compiles a
first set and refuses every other.** The first set: `required` and `ignore` on every field; on a
number, `const`, each bound and each range, a range given reversed included, `in`, `not_in`, and
`finite` on a float; on a bool, `const`; on a string, `const`, the lengths in code points and in
UTF-8 bytes, `pattern`, `prefix`, `suffix`, `contains`, `not_contains`, `in`, `not_in`; on bytes,
`const`, the lengths, `prefix`, `suffix`, `contains`; on an enum, `const`, `defined_only`, `in`,
`not_in`; on a repeated field, its counts, `unique` and its items' rules; on a map, its counts and
its keys' and values' rules; a oneof's `required` and the message's own `oneof`; a scalar's rules on
its wrapper, judged on its value once set; every `example` carried to the blueprint and never
judged.
`beadc check` refuses any other member, `VALIDATE_RULE_UNSUPPORTED`, never ignores one: a rule
written and not played lets through what a protovalidate server refuses. A rule on a message no
request reaches is `VALIDATE_RULES_UNPLAYED`, a warning: Bead judges requests alone. buf's own
`PROTOVALIDATE` lint rule judges the rules' coherence, a minimum above its maximum and a pattern
that does not compile among them, at the builder's pin; a numeric range given reversed is
protovalidate's range outside, taken. beadc vendors `validate.proto`, `VALIDATE_COPY` refusing a
project's, and takes its options out of what protoc-gen-es and protoc are handed, unless a project
keeps them.

**The side that answers judges every request**, once its payload reads and before its resolver,
as a step of its service manager beside the decode that answers `PAYLOAD_UNDECODABLE`, so the
payload block's two answers come from one place: a request its rules refuse is answered
`PAYLOAD_INVALID`, 52, the payload block's next, and its resolver never sees it (spec 9.5, 18.2); a
rule that fails to judge is `PROCEDURE_FAILED`, reported. **A requester judges its value when its
options say so**, `validates`, a client's requests and subscribing requests and a server's
commands: a refusal fails its call before anything goes, `PAYLOAD_INVALID` with the same detail,
traced and counted as a call refused before it goes, started and ended in its turn (debugging 4.4,
9.6). A result and a notification are never judged. `failFast` stops a judging at its first
violation, protovalidate's own name for it.

**The violations go in the detail, as lines of canonical JSON** (spec 18.6): a violation a line,
its members `bounds`, `fieldPath`, `forKey`, `message` and `ruleId` (18.3), then a closing line,
`{"more":N}` or `{"stopped":true}`. A writer writes them in order while they hold in the detail's
bound with 26 bytes kept for the closing line, each whole, then without its `message`, then without
its `bounds`, and counts the rest; a reader keeps every whole line a cut leaves, and a missing
closing line tells it that what was left out is not counted (18.7). No byte of the wire moves: the
envelope, its layout and every vector stay. The offending value stays off the wire, on the
violation the side that judged holds: the requester holds what it sent, and a value may be a
secret, or past the detail's bound.

**A path and an order are Bead's own**, since protovalidate fixes neither: a path renders its
fields' names, an item's index and an entry's key, a string key in RFC 8785's form, cut at 64
bytes and marked `...` (18.4); the order is the fields by their numbers, each by its `required`,
its `cel`, then its type's rules by their members' numbers, then its items by index and its
entries by key, then the message it holds, and the message's own rules last (18.5). A field's number
is its identity for life, and so is a rules message's member's.

**A judging holds no more than its detail carries.** Its sink adds each violation's line as the
writer will count it and keeps those the detail can carry; past them it counts the rest without
building their paths or words. Every rule is still judged and the count stays exact: what a judging
holds is bounded by the detail's bound, its time by the payload, in
[0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s terms. A validator gives
`{ violations, more, stopped }` on both sides.

**A pattern is a table beadc builds; each runtime walks it.** beadc compiles a pattern with
`@bufbuild/re2` into RE2's program, its Unicode classes rewritten first as the ranges of its own
tables of Unicode 17.0.0, generated from the UCD files `spec/generators/ucd.json` pins by their
sha256, then builds the DFA of `matches`'s unanchored search by subset construction, minimized, and
refuses one whose table passes 16,384 cells, `VALIDATE_PATTERN_LARGE`. The generated file writes
each class once, as its ranges' bounds, and the transitions as one table; a runtime finds a
character's class by a binary search and reads one cell: a constant per character whatever the
pattern, the memory the table's, nothing of it the peer's choice. One Unicode version on every
side, whatever the platform's.

**The blueprint carries the rules under the feature `validate`**: `proto.messages` lists every
message a request binding reaches through fields that hold a rule or lead to one, each field's
`(buf.validate.field)` in protobuf's JSON mapping by proto names, and its message's and oneofs'
rules ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
Each target declares the features it generates, and `beadc generate` refuses one that lacks a
feature its blueprint requires, `FEATURE_UNGENERATED`: a rule is never declared and played by one
side alone. `beadc breaking` reports `PROCEDURE_RULES_TIGHTENED`, a `WIRE` rule, for a request an
earlier peer sends that the current refuses; a rule loosened moves the revision alone. The generated
code's contract is 4, `GENERATED_CODE_SUPPORTS_VERSION_4` and `GeneratedCode.SupportsVersion4`,
beside 5 for a route table
([0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)),
and no runtime holds 3: code that names 3 judges no request by its rules, so it conforms through no
runtime.

**The words are protovalidate-es 1.3.0's**, byte for byte (18.8.6): they travel as protovalidate's
`Violation.message` and `google.rpc.BadRequest`'s description do, and a reader renders them from
`ruleId` and `bounds` where a line went without them.

## Consequences

**A request is refused before its resolver at the cost of one pass over its message**, its patterns
a constant per character, what a judging holds bounded by the detail's bound. A procedure's own
failure stays for what needs data or a call's context; `examples/hello`'s count past 10 is a rule of
its `.proto`, its failure retired.

**The order has no outside oracle**: `spec/validations.json` alone fixes it, its verdicts holding
the cases where Bead's order and protovalidate-es's part. The differential sorts as protovalidate's
conformance does, so it holds the verdicts and the words, never the order. buf's rule refuses two
rules of one field that would part on the order as protovalidate-es reads them, `len` beside
`min_len` and `const` beside another enum rule; the verdicts hold the pairs it takes, a pattern
beside `len`, a prefix beside `len_bytes` and `bytes.len`, `in` beside `not_contains`.

**A third language generates the same validators from the same blueprint, or beadc refuses to
generate it.** HTTP/JSON transcoding's OpenAPI document reads the same rules: JSON Schema's
keywords where they mean the same, a reversed range as `anyOf` its halves, a pattern translated to
ECMA-262's dialect where beadc can write one that means RE2's, what no keyword holds said in words,
and `PAYLOAD_INVALID` in a 422 `application/problem+json` whose `errors` are the violations its
detail's reader reads (transcoding 7.4, 11.7).

**Ahead, by a round of its own that meets the Tenth Man**: the rules written in CEL, a total subset
beadc compiles into each side, typed against the message, by cel-spec's semantics where cel-es
parts from it; then the well-known string formats, `bytes.pattern`, `bytes.in`, `any`, `duration`,
`timestamp`, `field_mask` and `predefined` rules, each refused until it lands; and protovalidate's
Go runner as a gate beside the differential.

**The gate.** `spec/validations.json`, played by both sides through the validators beadc generates
for `spec/validations.proto`: its verdicts, every rule of the first set on both sides of its bound,
the traps of code points, UTF-8 bytes, a float at its bound, 64-bit integers past 2⁵³, a reversed
range, NaN, the infinities and `-0.0`, a number its enum does not declare, wrappers, presence and
each `ignore`, messages held, map keys of every type in their order, a key cut, the orders where
the readings part, a request of 100,000 breaking items held to its bound and counted exactly, and
RE2's classes, anchors and folding, a backtracking engine's two worst inputs and a letter of Unicode
17.0.0; its details, the writer under its bounds and the reader of what a cut leaves. The verdicts'
patterns are judged by RE2 itself, `google-re2`, pinned with its hashes in
`spec/requirements.txt`, and their Unicode classes by the pinned UCD files. The differential plays
every verdict, and payloads mutated from them, through each side's validator and protovalidate-es,
the paths compared by their elements. `spec/conversations.json`: the interop's `checked`, its rules
each server writes by hand, refused `PAYLOAD_INVALID` with its violations, a detail that counts the
rest, a request taken and one that does not read; `spec/metrics.json`, its exit. Twins by the same
sentence ([0004](0004-one-behaviour-in-every-language.md)) hold what no runner plays, and
`docs/support.md` names them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at
xhigh effort, in two rounds, the second on what a detail's writer and reader make of its members,
its words and its count. It met eighteen objections, each claim checked against the code, the
packages it names and the probes before it was answered: seventeen accepted, one in part, none
refused. The user decided what no standard settles: the violations in the detail, as lines of
canonical JSON, their words on the wire; the offending value off it; beadc's DFA, bounded at 16,384
cells; beadc's own tables of Unicode 17.0.0, `\p{…}` taken; and the rules written in CEL compiled as
a total subset, by cel-spec's semantics, in a round of their own. Each objection, with the answer
that holds:

### On payload rules

| Objection                                                                                                                                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "All violations by default" builds every violation where the detail carries about nine: judging every rule and building every violation are two steps, and a validator that returns every violation holds 1,000,000 of them, +267 MiB, for a request of 1.91 MiB; about 140 MiB for one at `chunkBytes`, 8.7 GiB for 64 of them on one connection, beyond 0033's every bound.                 | Accepted. The sink keeps the violations the detail can carry, sizing each as the writer will, and counts the rest without building their path or words; every rule is still judged and `more` stays exact. A validator returns `{ violations, more, stopped }` on both sides, given its bound. A `verdicts` case of 100,000 breaking items gives the detail's first violations and the exact count, and a twin bounds what the judging holds.                                                                                                                                                                                                                                                                                                                             |
| "Linear in the input" is the input's length times the program's size for a Thompson simulation, and buf takes programs of thousands of instructions: `[a-z]{1,1000}[0-9]` takes 1,438 ms on 64 KiB, about 23 s on 1 MiB, where `@bufbuild/re2`'s DFA stays flat.                                                                                                                              | Accepted, by the remedy's third way. beadc builds the DFA ahead of time and each runtime walks its table, one class search and one cell a character, whatever the pattern; a pattern whose table passes 16,384 cells is `VALIDATE_PATTERN_LARGE`. A probe finds about as many states as instructions for every pattern a field's rules hold in practice (`^\pL{1,1000}$`, 10,025 cells), and an exponential count for an unanchored counted `.` alone (`a.{20}`). 0035 states the cost in 0033's terms: a constant per character, the memory the table's, nothing of it the peer's choice. A bound on the program's size alone was weighed and refused: it bounds the constant without removing it, and a few hundred instructions refuse the email-shaped pattern (641). |
| A program written as data per instruction copies its class into every instruction a counted repetition makes: `^\pL{1,64}$` is 492.1 KiB, `^\pL{1,1000}$`, which buf takes, 7,691 KiB, in each generated file.                                                                                                                                                                                | Accepted. The generated file writes each class once, as the bounds of its ranges, and the transitions as one table of cells; `^\pL{1,64}$` is 133 × 5 cells and its one class. The goldens hold a `\p` pattern under a counted repetition, so the file's size shows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The Unicode tables are not "Unicode 16.0": `@bufbuild/re2` sweeps the running Node's `RegExp` for each `\p` class, and Node 24.14.1 and 26.5.0 both already put U+10940, a Unicode 17.0 letter, in `^\pL$`; beadc runs on two Node versions in CI, so one blueprint can give two programs.                                                                                                    | Accepted. beadc carries its own tables, generated from Unicode 17.0.0's UCD files pinned by their sha256, and rewrites `\p{…}` into their ranges before RE2's compiler sees a pattern, so the sweep never runs; a builder test holds the bundled case orbit to the tables' `CaseFolding.txt`. Spec 18.8.5 names 17.0.0, the `\p` verdicts come from the same pinned files, and a golden over a `\p` class runs on both CI legs. Refusing `\p` until the tables land was the user's other way, not taken.                                                                                                                                                                                                                                                                  |
| The order within a field is not protovalidate-es's, as the draft wrote: protovalidate-es runs its checks in its code's order (`string.len` 19 before `min_len` 2, `enum.defined_only` before `const`), and the differential sorts, so no gate can see the order the user fixed.                                                                                                               | Accepted. The order is stated as Bead's own: `required`, `cel`, then the type's members by their numbers, which are a member's for life. The `verdicts` hold the cases where the readings part that buf's `PROTOVALIDATE` takes: a `pattern` beside `len`, a `prefix` beside `len_bytes` and beside `bytes.len`, `in` beside `not_contains`; the pairs it refuses, `len` beside `min_len` and `const` beside another enum rule, no `.proto` beadc takes can hold. 0035 names the cost: the order has no outside oracle, `spec/validations.json` alone fixes it. Following protovalidate-es's code order was refused: it is one library's, not its standard's, and moves with its releases.                                                                                |
| One JSON object, cut anywhere, is no JSON: a reader at its own `maximumDetailBytes`, or a relay writing the failure again on a leg with a lower bound, gets no violation at all from a server raised to carry more.                                                                                                                                                                           | Accepted. The detail is lines of canonical JSON, a violation a line, then a closing line; RFC 8785's text never holds a raw line feed. A cut keeps every whole line, and a missing closing line tells the reader that what was left out is not counted. RFC 7464's text sequences were weighed: their record separator resynchronizes a stream within, which a detail cut only at its end never needs. A `details` case cuts inside the second line and keeps the first violation.                                                                                                                                                                                                                                                                                        |
| Each violation carries its bounds twice, in `bounds` and in `message`; a long `pattern` makes one violation pass the bound alone (1,029 bytes), so the writer sends no violation; words on the wire make 18.8.6's formatting wire content; and under `failFast`, `"more":0` says nothing else is wrong where nothing else was judged.                                                         | In part. The words stay on the wire, as protovalidate's `Violation.message` and `google.rpc.BadRequest`'s `description` carry them, and as the user settled a violation's data "not only text"; 18.8.6 binds the words whether a writer or a reader renders them. A violation that does not hold whole goes without its `message`, which the reader renders from `ruleId` and `bounds`, then without its `bounds`, so its path and rule always reach. Under `failFast` the closing line is `{"stopped":true}`, never a count.                                                                                                                                                                                                                                             |
| A path's string key is "RFC 8785's form" and "as protovalidate renders a `FieldPath`", which part on a tab or U+0001, and the differential compares every word; a key is the peer's data, unbounded, which a 2,000-character key shows by passing the bound alone.                                                                                                                            | Accepted. 18.4's rendering is Bead's own, section 17.7's string form, and the differential compares paths by their elements, from `violationsToProto`. A string key is written whole within 64 bytes, else cut on a character's boundary and marked `...` outside its quotation marks, which no key's own characters can write; `details` cases hold the cut and the escapes.                                                                                                                                                                                                                                                                                                                                                                                             |
| A requester's `PAYLOAD_INVALID` is neither traced nor counted, "as a value that does not write", where debugging 9.6 counts every protocol failure a requester raises before its call goes; turning `validates` on would make the failure vanish from a client's metrics.                                                                                                                     | Accepted. A value its rules refuse is the application's input refused under a protocol code, as `PAYLOAD_TOO_LARGE` is: a 9.6 row, counted as started and ended in its turn, its `tx` step told as refused with no call id (debugging 4.4). The judging runs inside the span the router counts on both sides; the matrix's metrics row gains its twin and `spec/metrics.json` an exit.                                                                                                                                                                                                                                                                                                                                                                                    |
| protovalidate takes a scalar's rules on its wrapper and judges the value when set; the first set neither lists nor refuses wrappers, so `VALIDATE_RULE_FIT` would refuse what buf takes, or the rule would pass unjudged.                                                                                                                                                                     | Accepted. Wrappers join step 1: explicit presence, `required` while unset, the scalar's rules on the value once set, the path naming the field. The blueprint's `type` is `{"wrapper": <scalar>}`, which `VALIDATE_RULE_FIT` reads as its scalar; three `verdicts` cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Generating `validate.proto`'s messages beside a project's makes every `_pb.ts` with a rule import `validate_pb` and four well-known files the runtime never reads, +72.6 KB minified and +13 KB gzipped in every bundle, and every C# project compile its classes.                                                                                                                            | Accepted. beadc takes `buf.validate`'s options and import out of the descriptors it hands protoc-gen-es and protoc; the import stays where a message names a `buf.validate` type itself, and a project that runs protovalidate on its own keeps them by `messages.keepValidateOptions`. The editor's copy stays.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| "A third language generates the same validators, or a row of the matrix" writes into the record the footgun the draft refuses rules to avoid: a rule declared and played by one side alone.                                                                                                                                                                                                   | Accepted. Each target declares the features it generates, and `beadc generate` refuses a target that lacks one its blueprint requires (`FEATURE_UNGENERATED`). 0035 reads: a third language generates them, or beadc refuses to generate it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Step 2's two levelings are none, since neither JavaScript nor .NET keeps a side from comparing code points or numbers of two types exactly; and the subset is not total: `.` on a map is an index that fails on an absent key, and `==` of lists or messages answers otherwise on NaN.                                                                                                        | Accepted, by its other way. Neither is a row of the matrix: what beadc compiles is the boundary, its limits in the builder's README. The subset refuses `.` on a map and `==`, `!=` and `in` on lists, maps and messages, which keeps it total. Where cel-es parts from cel-spec, Bead follows cel-spec's text — strings by their code points, numbers across types exactly — rather than refusing the comparison, since a rule comparing two strings is common; the differential leaves those cases out by name. Step 2 meets its own round.                                                                                                                                                                                                                             |
| An empty member parts the sides: one reader refuses a line whose `fieldPath`, `message` or `ruleId` is `""` or whose `bounds` is `{}`, the other keeps it, and both writers write `""` and `{}` where a validator gives them. protovalidate normalizes empties away, its `error.js` dropping an empty field path and message, and its `Rule.id` is optional, an id-less CEL rule giving `""`. | Accepted. A member empty is absent, protovalidate's own normalization: a reader takes a `fieldPath` or a `message` of `""`, a `bounds` of `{}` and a `forKey` of `false` as absent and keeps the line, an empty `message` taking its rule's words; a `ruleId` of `""` is an id. A writer writes none of them (18.6, 18.7). `details` cases read and write each.                                                                                                                                                                                                                                                                                                                                                                                                           |
| The readers give words to different sets: one renders a member of any kind, so `bool.in`, `enum.lt` and `repeated.const`, which `validate.proto` does not define, take words, and `bytes.pattern` takes the string rule's; the other keeps to a list of its own. Words a reader writes for an id no validator writes are no standard's.                                                       | Accepted. A reader gives words to the ids of the rules beadc compiles alone, each by the template its rule formats in `validate.proto`, which 18.8.6 lists; any other id takes none: `bytes.pattern`, outside the first set, rather than its own `must match regex pattern`, and `bytes.in` and `bytes.not_in`, whose `%s` of bytes waits for the round that compiles them. The generator reads each template from the vendored `validate.proto`; a `details` case per type reads every id of the set, and cases read ids that take none.                                                                                                                                                                                                                                 |
| A bound's shape goes unchecked: a list is written for any member, so `{"lte":[1]}` takes `must be less than or equal to [1]`, a nested list is written out, and a scalar `in` takes words on one side.                                                                                                                                                                                        | Accepted. `in` and `not_in` take a list of scalars, and only a list; every other member takes a scalar, a string, a number, `true` or `false`. A nested list, a list for a scalar member or a scalar for `in` gives no words, the line kept; a `details` case holds each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `atob` takes base64 unpadded and with white space, `Convert.FromBase64String` with white space, so one `%x` bound takes words on one side and none on the other.                                                                                                                                                                                                                              | Accepted. A `%x` member takes base64 as protobuf's JSON mapping writes bytes, RFC 4648 §4's: its standard alphabet, padded, no white space, each side checking that form itself before it decodes; anything else gives no words. A last character whose bits past the bytes are not zero, which §3.5 lets a decoder take, is taken on every side, and a `details` case holds it beside the forms refused.                                                                                                                                                                                                                                                                                                                                                                 |
| The closing count parts the sides: one writer writes a count past 2^53 − 1, which an I-JSON number does not hold exactly, where the other clamps it; one reader takes such a count, the other does not; and `1e2`, an integer as section 17.6 reads a number, counts on one side alone.                                                                                                       | Accepted. A writer writes N at most 2^53 − 1, RFC 7493 §2.2's bound, a count past it written as 2^53 − 1; a reader takes a count past it, or a number whose double is no integer, as no count, the detail uncounted. N is the value its number reads as (17.6), so `1e2` counts a hundred on every side; `details` cases write the clamp and read each.                                                                                                                                                                                                                                                                                                                                                                                                                   |
