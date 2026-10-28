# 0042 — A `proto` message that leaves a required field unset neither reads nor writes, and a gateway refuses it where its server would

- **Status**: accepted
- **Scope**: the protocol, both runtimes and beadc: in [`spec/spec.md`](../../spec/spec.md), 17.9.7
  and 17.9.8; in [`spec/transcoding.md`](../../spec/transcoding.md), 4.5's derived mask, 5.2's order
  and its step 4, 5.6's sentence of an `Any`'s message, 7.4's place of a field left unset and its
  pointer, and the `required` of 11.4, 11.5 and 11.7; each side's runtime codec of a schema,
  `protoCodecOf` of `./proto` and `ProtoCodecs` of `Bead.Protobuf`, its required walk, and on the C#
  side its filter of a closed enum's record and `ProtoRequired.Check`; generated code's contract 6;
  `spec/codecs.proto`'s `Needs`, `Shade` and fields 7, 8 and 14, `spec/codecs.json`'s rows of 17.9.7
  and 17.9.8 and the reason `a required field unset`; `spec/transcoding-required.proto`,
  `Requiring` and the procedures `require`, `getNeeds` and `updateNeeds` of
  `spec/transcoding.proto`, and their entries in `spec/transcoding.json`; the blueprint's
  `legacyRequired` under the feature `legacy-required`, beadc's document, and its rules
  `HTTP_REQUIRED_UNBOUND` and `HTTP_PATCH_REQUIRED`; the support matrix's rows of an extension's
  required field given to a writer, a closed enum's echo, and a repeated closed enum's leveling.
  What 17.9 restates of protobuf, and its items 1 to 4, are
  [0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)'s; the check of a
  payload's records, 17.9.5 and 17.9.6,
  [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s;
  the mapping of protobuf's JSON and its D-table,
  [0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)'s;
  the blueprint's format and its features,
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s;
  the counter of generated code's contract,
  [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s.

## Context

**protobuf requires such a field for parsing and for serialization.** Its
[Feature Settings](https://protobuf.dev/editions/features/#field_presence): "`LEGACY_REQUIRED`: The
field is required for parsing and serialization." Its
[Language Guide (proto 2)](https://protobuf.dev/programming-guides/proto2/): "a well-formed message
must have exactly one of this field", and, under "Required Is Forever", "the unrecognized enum value
is treated as if it were missing, which also causes the required value check to fail". Its
[Enum Behavior](https://protobuf.dev/programming-guides/enum/): a closed enum's undeclared number is
stored "in the message's unknown field set", and "C# treats all enums as open". ProtoJSON says
nothing of a required field. Protobuf's conformance suite at v36.2 holds no test of one left unset.

**The libraries, each as it is**, read at their sources:

| Library                | Binary read                              | Binary write                                                                                         | JSON read, a message                                          | JSON, an `Any`'s message                                                                                                                            |
| ---------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| C++ 36.2               | refuses (`message_lite.cc:204-212`)      | `ABSL_DCHECK(IsInitialized())`, then `SerializePartial…` (`:521-525`): refuses in a debug build only | takes (`parser.cc:1347-1367`)                                 | takes both ways: packs with `SerializePartialAsString` (`parser_traits.h:135,138`), unpacks with `ParsePartialFromString` (`unparser_traits.h:283`) |
| Java                   | refuses (`AbstractParser.java:41-49,63`) | the builder's `build()` refuses; the serializer writes a `buildPartial` message                      | nested refused (`JsonFormat.java:2016`)                       | refuses (`:1544`, `:886`)                                                                                                                           |
| Go                     | refuses (`proto/decode.go:135`)          | refuses (`proto/encode.go:209`)                                                                      | refuses after the whole reading (`protojson/decode.go:93-96`) | takes both ways: "never check required fields inside an Any" (`well_known_types.go:137,228`)                                                        |
| Python upb 7.36.2      | takes                                    | refuses                                                                                              | takes                                                         | refuses on reading                                                                                                                                  |
| protobuf-es 2.16.0     | takes                                    | refuses (`to-binary.js:103-117`), with no option to skip                                             | takes                                                         | `anyUnpack` takes                                                                                                                                   |
| Google.Protobuf 3.36.2 | takes                                    | writes                                                                                               | takes                                                         | takes                                                                                                                                               |

**Through Bead's codec of two functions, the two stock libraries part.** protobuf-es's `toBinary`
throws on a message that leaves one unset and Google.Protobuf's `ToByteArray` writes it, so the two
sides part at every write: a requester's value (17.2.4), a resolver's result (17.2.5), a gateway's
bound request, which one side answers 500 and the other 200, an `Any`'s message packed by the
mapping, both directions of the HTTP caller, and an extension's message. Both take one on decode.
Google.Protobuf's `IsInitialized()` cannot stand in for a walk: a proto3 root reads initialized
whatever it holds, and a group or a delimited field throws.

**Beside it, probed on `@bufbuild/protobuf` 2.16.0 and Google.Protobuf 3.36.2:**

| Place                                                       | TypeScript                                                                                                       | C#                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A singular closed enum given `01` then `05`                 | protobuf-es keeps `1`, and moves `05` among the unknown fields (`from-binary.js:197-223`)                        | Google.Protobuf holds `5`, its last record                   |
| A repeated closed enum's or a map value's undeclared number | kept (`from-binary.js:267-281`, `:306-309`)                                                                      | kept                                                         |
| A PATCH's mask set in the JSON draft, before the reading    | goes through 5.4's form: a body naming `line_1`, JSON `line1`, is refused, `a FieldMask path off lowerCamelCase` | set on the message once it is read, by proto names: it binds |
| A member named by its proto name, refused                   | placed `#/anInt32` for `{"an_int32":"x"}`                                                                        | the same                                                     |

So 7.4's "which resolves there" is false of a member named by its proto name, and a mask set before
the reading refuses what 4.5 binds.

**The cost of a walk**, measured on a prototype (Release, one machine): over 1,000 items it took
0.37 ms on the TypeScript side and 0.51 ms on the C# side, beside 0.20 ms for `toBinary` and
0.41 ms for `ToByteArray`; a message that reaches no required field costs one lookup, 0.04 µs on the
C# side.

The options weighed:

- **Refuse on writing alone.** It leaves a reader taking what protobuf's C++, Java and Go parsers
  refuse, and Feature Settings' "parsing" unheld.
- **A check inside 0028's walk of a payload's records.** It would refuse a message given twice that
  sets its required fields in either record, which every reference parser reads.
- **`IsInitialized()`.** Unusable on the C# side, as above.
- **At each object's close in the mapping, Java's way.** Needed only while an `Any`'s message is
  packed in the middle of the reading.
- **An `Any`'s message judged in the mapping, Java's and upb's way.** Two verdicts for one message,
  where C++ and Go take it both ways.
- **A call at every site that reads or writes.** One more site missed is one more divergence.
- **One runtime codec of a schema, its walk after the parse, an `Any`'s message never judged, the
  mask set on the message: Go's way. Chosen.**

## Decision

**A message that leaves a required field unset neither reads nor writes** (spec 17.9.7), at any
depth, but never inside an extension or an `Any`'s message, as protobuf has such a field "required
for parsing and serialization" and as its C++, Java and Go parsers read. A read is answered
`PAYLOAD_UNDECODABLE`, and a write fails with its writer's refusal (17.2). The walk runs after the
parse, so a message given twice sets its required fields in either record, and its order is
17.9.7's, by field number and depth first, a map's entries by 18.5's order of their keys.

**A closed enum's undeclared number sets nothing on a singular field** (spec 17.9.8), as Enum
Behavior has it: the field holds the last declared number its records give, or none. protobuf-es
reads so already; the C# side's runtime reader drops such a record before Google.Protobuf reads,
which narrows what reads and never reads in the library's place
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).
A repeated field's items and a map's values keep the number on both sides: a row of "Leveled down".
What each writes back of a singular field's number is a platform row.

**One runtime codec of a schema on each side holds 17.9 once**: `protoCodecOf(schema)` of
`@francisdesjardins/bead/proto` and `ProtoCodecs.Of<T>()` with `ProtoCodecs.Read(descriptor,
bytes)` of `Bead.Protobuf`. Its read runs the records check, then, on the C# side, 17.9.8's filter,
then the parse at 17.9.3's bound, then the walk; its write runs the walk, then the stock writer.
The TypeScript side throws a `SyntaxError` when it reads and a `TypeError` when it writes, as its
other codecs do; the C# side a `FormatException` both ways, its codecs' type; the words are the
same, `a proto message leaves <full name> unset`, naming a field of the schema and never a key the
peer sent. The walk is Bead's own on both sides, its facts in the one shape per descriptor
`ProtoRecords` holds, weakly held as long as its descriptor is: each message's required fields, the
message fields that reach one, and on the C# side its singular closed enums. Reachability is one
search over the descriptor's closure, cycles included, with no flag cached mid-search. Generated
code, the gateway's result reader, `HttpEvents.DataOf`, an `Any`'s bytes on writing, both HTTP
callers and every test codec read and write through it; an `Any`'s bytes are read with the records
check, the bound and the filter, and no walk.

**Generated code's contract moves to 6.** A service's generated file calls the runtime codec, which
a runtime without it lacks, so it names `GENERATED_CODE_SUPPORTS_VERSION_6` and
`GeneratedCode.SupportsVersion6`. 4 goes from both runtimes, since code that names it checks no
required field and no longer conforms through the runtime. 5, the route table's, stays: a route
table holds descriptors and calls no codec, so code that names it still conforms, and by 0028's rule
before 1.0.0 it stays.

**A gateway refuses such a request after its reading** (transcoding 5.2, step 4), as its server's
codec would, since a gateway is one more client of its server and beside the wire (transcoding 1.1,
1.2): once the request is bound, read by steps 1 to 3 and its derived `update_mask` set, the message
is judged by 17.9.7's walk, 400 `PAYLOAD_UNDECODABLE` at the first required field unset. 5.2's lead
states the order a refusal is met in, so every refusal of steps 1 to 3 and of section 4 comes before
step 4's, whatever the order of the members. An `Any`'s message is not looked into, as 17.9.7 does
not look into its bytes and as C++ and Go do in their JSON mapping.

**The field's place is a violation's** (transcoding 7.4): `parameter`, its field path by JSON names,
where the route's query would bind it; `pointer` naming the member its object lacks, where the body
holds its object, which RFC 6901 §4 makes an error to evaluate and which is its meaning here. The
words are fixed, `a required field unset`, and name no member of the request. 7.4 states its
pointer once: by JSON names, resolving where the body names each field so.

**A gateway's writing meets one only inside an `Any`** (transcoding 5.6): a result that leaves one
unset does not read at the gateway, 502 (7.5.2), and an `Any`'s message is written as it holds it,
the field left out, as C++ and Go write one.

**A PATCH's derived mask is set on the message**, by proto names, after steps 1 to 3 and before step
4, on both sides, never read back through 5.4's form, so a required `update_mask` binds and a body
naming `line_1` binds. A required field of the body's message is always among the derived paths, so
a caller keeps one unchanged only by an `update_mask` of its own, as
[AIP-203](https://google.aip.dev/203) has a required field marked by `field_behavior` and not by
protobuf's presence; beadc warns of such a rule.

**beadc's document promises what the gateway refuses, and nothing it takes** (transcoding 11.4,
11.5, 11.7). The blueprint marks such a field `legacyRequired: true`, under the feature
`legacy-required`, named after the member and protobuf's term, so it never reads as protovalidate's
or JSON Schema's `required`; its schema requires `presence: explicit`, no `label` and no `oneof`
beside it, and the feature where a field carries it. Every target that generates the feature
declares it, and one that does not is refused, `FEATURE_UNGENERATED`. A message's schema lists such
fields in its `required`; a query's parameter is `required: true` where its field is required and
each message field on its path is required or held present by a variable, its proto name in its
description; a body's schema requires a message field a variable binds into where its message keeps
a required field left to the body. `HTTP_REQUIRED_UNBOUND`, an error, refuses a route whose required
field no part of its request can set, since every call to it would be refused;
`HTTP_PATCH_REQUIRED`, a warning, as `HTTP_UPDATE_MASK` is, marks a `patch` rule whose body's
message holds one. buf's cardinality rules already judge a field made required or optional, so
`breaking` adds none.

## Consequences

**Every file generated before contract 6 fails its build until it is regenerated**, on both sides,
beadc's goldens, `examples/hello`'s and the demo's `gen/` among them; both sides and every gateway
must change to conform.

**A PATCH of a message that holds a required field names that field on every call** whose mask is
derived: a caller that would keep it unchanged sends its own `update_mask`, which beadc's
`HTTP_PATCH_REQUIRED` tells a `.proto`'s author.

**Two platform rows and a leveling.** An extension's message that leaves a required field unset,
given to a writer: refused on the TypeScript side, as protobuf-es's `toBinary` checks it, written on
the C# side, since Google.Protobuf lists no extension a message holds; reading is at parity. A
singular closed enum's undeclared number, echoed: protobuf-es writes it back among the unknown
fields, the C# side has dropped it before its library read; what each reads is at parity. A
repeated closed enum's item, or a map's value, of an undeclared number: kept on both sides, where
Enum Behavior moves it among the unknown fields, a row of "Leveled down" that lifts when the
TypeScript side can move it to `$unknown` and the C# side can drop it in its filter, together.

**The cost is the walk**, linear in the messages a payload holds that reach a required field, and
one lookup for a message that reaches none; the floor of protobuf's conformance suite, 5,601 tests
and 48 skipped, stays, played through the runtime codecs.

**The gate.** `spec/codecs.json`'s rows of 17.9.7 and 17.9.8 through each side's runtime codec;
`spec/transcoding.json`'s readings, bindings, writings and exchanges of 5.2's step 4, 5.6, 7.4 and
17.9.8, each player reading a writing's payload through its side's runtime reader; the twin tests
of the codec, the service client and server, the gateway and the HTTP caller, one sentence each
pair; beadc's tests of the blueprint, the document and the two rules.

**Out of scope**: a pointer written by the name the body used, so that one resolves in a body that
named a member by its proto name, which would change both sides' readers and the 422's
placement.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
two rounds, each at xhigh effort, the second against the revised design. Its objections, each with
the answer that holds:

### The first dissent

| Objection                                                            | Answer                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The divergence is in 17.9's codecs, not in the gateway               | Accepted: 17.9.7 states it, reading and writing, on Feature Settings' "required for parsing and serialization". In part: one Bead failure for a request the HTTP caller cannot write; 17.2.4 names no code, and a value that does not write throws its writer's refusal on every encoding. The two sides throw it from one walk, in one layer, in the same words. |
| `IsInitialized()` is unusable on C#                                  | Accepted, confirmed: a proto3 root reads initialized; a group or a delimited field throws. Each runtime has its own walk, run after the parse, its facts in `ProtoRecords`' shape.                                                                                                                                                                                |
| The check belongs inside the mapping's reading, at each object's end | In part: it is a step of 5.2, step 4, with its order stated and pinned by two-fault cases. But it runs after steps 1 to 3 and the derived mask, as Go's `protojson` does, not at each object's close. The close was needed only while an `Any`'s message was packed mid-reading, which the second dissent's first objection removes.                              |
| A detail naming the field's JSON path breaks 7.4                     | Accepted: fixed words, `a required field unset`, with the place in `parameter` or `pointer`. The pointer is the absent member, the place protovalidate's `required` already gives. 7.4 is restated once.                                                                                                                                                          |
| The OpenAPI document would promise what the gateway refuses          | Accepted, and widened by the second dissent's fifth and ninth objections.                                                                                                                                                                                                                                                                                         |
| The stated reason does not hold                                      | Accepted: the binary rule rests on Feature Settings, the Language Guide and the C++, Java and Go parsers. The mapping's step rests on transcoding 1.1 and 1.2: a gateway refuses what its server's codec would refuse, and nothing more. 5.5 is not its ground.                                                                                                   |

### The second dissent

| Objection                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An `Any`'s message gets two verdicts, for a reason the libraries contradict                             | Accepted. Confirmed in the sources: Go "never check[s] required fields inside an Any" both ways (`well_known_types.go:137,228`); C++ packs and unpacks one partially (`parser_traits.h:135,138`, `unparser_traits.h:283`). The probe confirms that protobuf-es can pack one through a twin schema. One rule holds: an `Any`'s message is not judged, on the wire as in the mapping. This follows transcoding 1.1 and 1.2: the gateway takes what its server takes. The reading case reads, with upb's refusal as its `upb` part. No 5.7 clause, no writing case of a 500 and no change of 7.6 come of it, and it removes the reason for checking at each object's close.                                                                                                                                                                                                                                                        |
| The generated code's contract is not moved                                                              | In part. Contract 6 holds on both sides, with its doc, the generated reference, the goldens, `examples/hello`'s and the demo's `gen/`, and the text of 0028 and 0031. 4 goes, since code that names it checks no required field and so no longer conforms through the runtime. Refused: that 5 goes. A route table holds descriptors and calls no codec, so code that names 5 still conforms, and by 0028's own rule it stays. The CHANGELOG says that every generated file must be regenerated.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PATCH (4.5) is never met, and the two sides place the derived mask apart                                | In part. Accepted: 4.5 states that a required field of the body's message is always among the derived paths, and that a caller keeps one only by an `update_mask` of its own (AIP-203). `HTTP_PATCH_REQUIRED` warns. The mask is placed once, before step 4, so a required `update_mask` binds; a binding case pins it. The `line_1` divergence is closed with its own binding case, so no matrix row is needed. Refused: its direction, that C# set the mask in the draft before the reading. 4.5 sets paths by proto names, and the draft's JSON round trip is what refuses `line_1`. So the TypeScript side keeps to C#'s way: the mask is set on the message after steps 2 and 3. With step 4 after the walk, that order is enough.                                                                                                                                                                                         |
| The HTTP callers refuse in different layers, types and words; the walk throws a writer's type on a read | Accepted. C#'s `HttpCaller.Write` calls `ProtoRequired.Check` before `_form.Write`, as the TypeScript side encodes before it writes. The TypeScript codec throws a `SyntaxError` when reading and a `TypeError` when writing, as its other codecs do. The C# side throws a `FormatException` both ways, its own codecs' type. The twins assert the type and the words.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The document promises what the gateway refuses, and refuses what it takes                               | In part. Accepted: a parameter is required where a variable holds its parent present; a body schema requires a message field that a variable binds into where it keeps a required field; `HTTP_REQUIRED_UNBOUND` is an error, since no call satisfies such a route (`HTTP_QUERY_UNBINDABLE` is a warning because some calls do); and the inline path keeps its rules, a fix. Refused: that `required: true` holds only where a parameter's JSON name is its proto name. The document already holds every body by JSON names alone under `additionalProperties: false` (11.7), and says a field's proto name in a description (11.9). A proxy that validates against it already refuses a body in proto names. The parameter keeps the same form: required by its JSON name, its proto name said in its description. Doing otherwise would leave a multi-word required field's requirement out of the machine-readable document. |
| One runtime codec of a schema, not one call at every site                                               | Accepted. `protoCodecOf(schema)` in `./proto` and `ProtoCodecs.Of<T>()` with `ProtoCodecs.Read` in `Bead.Protobuf` hold 17.9 once. Generated code, the gateway's result reader, `HttpEvents.DataOf`, an `Any`'s bytes on writing, both callers and every test codec go through them. `DataOf` thereby gains 0028's check and 17.9.3's bound, a fix. The required fields, reachability and closed enums join `ProtoRecords`' weakly held shape, and its `ConcurrentDictionary` goes. The contract moves once, and the next item of 17.9 moves none.                                                                                                                                                                                                                                                                                                                                                                              |
| Closed enums: a known divergence deferred, which breaks 5.6's one sequence of bytes                     | In part. Accepted: 17.9.8 states it, with codecs rows, transcoding writings, a twin, a platform row for the echo, and a row of "Leveled down". Corrected: clearing the field after the parse would not match. protobuf-es keeps the last declared number (`01` then `05` reads `1`), and Google.Protobuf holds `5`. So the C# reader drops such records before the parse, in `ProtoRecords`' walk, and reads what protobuf-es reads. Narrowed: protobuf-es moves the number aside for a singular field only. A repeated field's items and a map's values keep it on both sides (`from-binary.js:267-281`, `:306-309`), so that part is at parity. It is a row of "Leveled down" against Enum Behavior, not a difference.                                                                                                                                                                                                        |
| 7.4 and 5.2's lead each carve one exception from a sentence already false                               | Accepted. 7.4 states its pointer once: JSON names, resolving where the body names each field so, and naming an unset field as the absent member. 5.2's lead orders the text, section 4's refusals, the walk of steps 2 and 3 in the draft's member order with the repeated scalars after, the derived mask, then step 4. With step 4 after the walk, the order between a member's refusal and an unset field no longer depends on member order. Two binding cases pin section 4's refusal (`?nope=1`) and a query scalar's (`?child.name=b&count=x`) before an unset field. Writing the pointer by the name the body used is left out of scope.                                                                                                                                                                                                                                                                                 |
| `bead-blueprint/1` cannot take `legacyRequired` as drafted                                              | Accepted. The member comes under the feature `legacy-required`, named after the member and protobuf's term, which keeps it apart from protovalidate's and JSON Schema's `required`. It is coupled at the top as `validate` is. `fieldEntry` gains an `if`/`then`: `presence` `explicit`, no `label`, no `oneof`. The flag is kept rather than a third `presence` value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P1 overstates the writers; P9 writes versions the release tool owns                                     | Accepted. 17.9.7 and this record name each writer as it is: C++ checks only in a debug build, Java's builder refuses, and Go's, upb's and protobuf-es's writers refuse. The record writes no version: they are the release's. The CHANGELOG says that both sides and every gateway must change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
