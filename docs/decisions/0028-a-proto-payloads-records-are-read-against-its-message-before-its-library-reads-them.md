# 0028 — A `proto` payload's records are read against its message before its library reads them

- **Status**: accepted
- **Scope**: the protocol and both runtimes: in [`spec/spec.md`](../../spec/spec.md), 17.9.3's count
  of a group and a map's entry, 17.9.5 and 17.9.6; the check of a `proto` payload's records, the
  TypeScript side's `@francisdesjardins/bead/proto` and the C# side's `Bead.Protobuf` assembly; the
  contract of generated code from 3, whose code first calls the check; `spec/codecs.proto`,
  `spec/codecs.json`'s `proto` rows, its schema and its generator; protobuf's conformance suite and
  the differential, through `tools/protobuf-conformance.mjs`, its pin, each side's testee and
  failure list, and their CI job; the support matrix's `proto` rows. What section 17 states of
  `proto`, and why it restates none of protobuf's format, is
  [0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)'s; the codec of
  two functions,
  [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s;
  the generated codec, and what a target writes beside what a runtime does,
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s;
  the runtime codec of a schema that calls the check, its required walk and, on the C# side, its
  filter of a closed enum's record, and generated code's contract 6, [0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)'s; the root's
  tools, [0005](0005-a-toolchain-per-language.md)'s.

## Context

**Each stock library reads bytes that are no encoding of the message**, against protobuf's own
rules, and spec 17.9.1 says they do not read. protobuf-es 2.16.0 reads a record that runs past the
end of its message, since its reader never checks that the last ended there, and a varint of more
than 10 bytes where its field is unknown. Google.Protobuf 3.36.2 reads a tag of more than 5 bytes
or past 32 bits, keeping its low 32 bits, where the
[Encoding](https://protobuf.dev/programming-guides/encoding/) guide's reference card gives a tag
"encoded as uint32 varint" and protobuf's conformance suite refuses one in its REQUIRED `BadTag_*`
tests, which protobuf's own failure list for C# keeps. Both read a length whose varint sets bits
past 32, which the guide gives as "size encoded as int32 varint" and the suite's
`BadLength_Varint32BitOverflow` refuses. Without a check, each is an open row of the support matrix,
its entries of `spec/codecs.json` excused for the side that reads them.

**Probed on `TestAllTypesProto3`, the two libraries part on more**, where Google.Protobuf is right
by protobuf's guide or no rule settles it:

| Bytes                                                        | What                                                  | protobuf-es                                          | Google.Protobuf |
| ------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------- | --------------- |
| `AA 02 05 01 00 00 00 02 08 87 01 08 09`                     | a packed fixed32 of 5 bytes                           | `repeatedFixed32: [1, 25626626]`, `optionalInt32: 9` | refused         |
| `DA 04 02 05 81 0D 08 00 08 09`                              | a packed int32 whose last varint runs past its record | `packedInt32: [5, 1665]`                             | refused         |
| `AA 04 1A 0A 01 61 12 01 78 1A 12 01 7A 0A 0E` and 14 × `7A` | a map's entry with a field it does not declare        | `{"zzzzzzzzzzzzzz": "z"}`                            | `{"a": "x"}`    |
| `AA 04 05 08 03 12 01 78`                                    | a map's key at the varint wire type                   | `{"\u0012\u0001x": ""}`                              | `{"": "x"}`     |

protobuf-es reads a packed record's values while its reader is short of the record's end and never
checks that the last ended there; it reads a map's entry by `switch (fieldNo) { case 1: case 2: }`,
with no default and no wire type, so it skips no field the entry does not declare and reads a key
by its declared type whatever its wire type; and it never counts an entry toward its recursion
limit, where Google.Protobuf counts it as the message it is on the wire. So through
`map_string_nested_message`, from 34 cycles to 50 of an entry, a `NestedMessage` and its
`corecursive`, Google.Protobuf refuses what protobuf-es reads. And a known field at a wire type its
type does not take is kept as an unknown field by protobuf's C++ and Go parsers and by
Google.Protobuf, and read as its declared type by protobuf-es: `18 03 0A 05 61 62 63 64 65`, a
message field at the varint wire type, reads `03` as the child's length and takes the text after it
as the child's, its five bytes past the child's three.

**What protobuf says.** The guide: a varint is "between one and ten bytes"; a packed repeated field
is one `LEN` record of its values, and "Protobuf parsers must be able to parse repeated fields that
were compiled as `packed` as if they were not packed, and vice versa"; a map is a repeated message
of its entries, the key at field 1 and the value at field 2 ("Maps"); a group is delimited by
`SGROUP` and `EGROUP` records of its number; "When a message is serialized, there is no guaranteed
order for how its known or unknown fields will be written". It says nothing of a known field at
another wire type, nor of a field an entry does not declare. Its conformance suite at v36.2, the
release both libraries pin (Google.Protobuf 3.36.2 belongs to it, and protobuf-es 2.16.0's own
`packages/protobuf-conformance` pins `protobuf-conformance` 36.2.0 and runs
`--maximum_edition MAX --enforce_recommended`), reaches none of the parts above but the tag: its
submessage case cuts at the buffer's end, and it sends no bad packed record nor map's entry. Buf's
`WIRE` rules, which `beadc breaking` runs, flag every change between singular and repeated and
between types of different wire types, so no evolution beadc passes makes a field arrive at a wire
type its type does not take, packed and unpacked aside.

**The suite through each side's codec**, binary, recommended enforced, at `MAX`: the TypeScript side
runs 2,833 tests, 2,832 passed and 1 failed,
`Recommended.Editions.ProtobufInput.RejectInvalidUtf8.String.Extension`, with the check or without;
the C# side 2,816 passed and 17 failed without it, the 12 `BadTag_*` tests among them, and 2,828
and 5 with it: the 4 `UnknownOrdering.ProtobufOutput` and the extension's. Both match protobuf's
own failure list for C# and protobuf-es's empty one; the extension fails because Bead's codec gives
no extension registry, so an extension reads as an unknown field. The check refuses nothing the
suite takes, with the wire-type rule or without.

**A `Probe` of a string, a uint32 and a message of its own kind would reach none of it**: with no
repeated field, no map and no group, no entry would hold a packed record, a map's entry or a group.

The options weighed:

- **Each library's fix, reported upstream.** The parts are protobuf-es's but the tag; the reports
  wait, by the user's word, and Bead does not wait on them.
- **A shape beadc writes as data, a table per message.** A second copy of the descriptor: stale
  under `messages: external`, its editions' features and map entries resolved again, its format
  frozen at the contract, and no tie to the library generated code already has.
- **beadc's table, checked against the descriptor**: it reads the descriptor too, and adds a table.
- **The runtime reads the library's own descriptor, once, cached by it. Chosen.**

## Decision

**Each side checks a `proto` payload's records against its message before its stock library reads
them, and refuses what protobuf refuses where a library reads on.** One check, the same on both
sides, refuses what each stock library reads past protobuf's rules, and the parts above, and guards
each side against its library regressing on what the other's gets right.

**A side narrows what reads; it never changes what its stock library reads or writes.** The check
refuses a payload before the library sees it, as 17.9.1 has it of bytes that are no encoding of the
message; where protobuf states no rule and the libraries read apart, a refusal is a
leveling, put to the user. On the C# side, a record of a singular closed enum whose number its enum
declares no value of is dropped before Google.Protobuf reads, which treats every enum as open, so
that it reads what protobuf-es reads and what protobuf keeps among the unknown fields (spec 17.9.8,
[0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)): a record set aside, never a value read. It never reads in the library's place, and
nothing writes in its place:
a difference in what a library writes, the order of unknown fields and a map's entry's key at its
default among them, is a platform row.

**The check reads the message's own descriptor**, the one its library and the generated code already
hold: protobuf-es's `DescMessage`, the `…Schema` a generated file imports, and Google.Protobuf's
`MessageDescriptor`, `Foo.Descriptor`. Under `messages: external` it is the descriptor of the code
the project's own build compiles, so it cannot go stale, and the library that reads resolves
editions' features and map entries, so the check sees what it reads. Each message's shape is built
once, at first use, and cached by its descriptor, in a `WeakMap` and a `ConditionalWeakTable`: each
field number to what its records take, and the shapes of the messages it holds, so a message holds
itself.

- **TypeScript**: the subpath `@francisdesjardins/bead/proto`, `src/proto/proto.ts`, and its
  `checkProtoRecords(bytes, schema)`, in `src/proto/records.ts`, which throws a `SyntaxError`, as
  the other codecs do for bytes that do not read. `schema` is a `DescMessage` by `import type` from
  `@bufbuild/protobuf`, nothing imported at run time; `@bufbuild/protobuf` is an optional peer
  dependency, in the range generated code needs, and stays a development dependency. The check reads
  `fields`, `number`, `fieldKind`, `scalar`, `listKind`, `mapKey`, `mapKind`, `message` and
  `delimitedEncoding`, a scalar's kind as `descriptor.proto`'s type number, which `ScalarType`
  carries; a change of that shape fails the generated code's type-check.
- **C#**: the assembly `Bead.Protobuf`, `src/Bead.Protobuf/`, in `Bead.slnx`, which references
  Google.Protobuf at its central pin and nothing else,
  `ProtoRecords.Check(ReadOnlySpan<byte> bytes, MessageDescriptor message)`, which throws a
  `FormatException`, as `Payloads` does; its tests in `tests/Bead.Protobuf.Tests/`. `Bead.Core`
  references no Google.Protobuf: a project that binds `proto` references `Bead.Protobuf`, which
  carries the library its generated messages need.

The two map name for name, `./proto` and `checkProtoRecords`, `Bead.Protobuf` and
`ProtoRecords.Check`; the router answers a throw from either `PAYLOAD_UNDECODABLE`, as it answers
any decoder's. The target still writes data and types, the call and the descriptor its library
gives, and the check is the runtime's behaviour
([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).

**What the check refuses**, in one walk of the payload that allocates nothing per record:

- a tag of more than 5 bytes or past 32 bits, and field number 0;
- a varint of more than 10 bytes, its field known or not;
- a length whose varint runs past 10 bytes or that runs past the bytes after it, a length past
  2³¹ − 1 among them, which also passes every payload Bead carries;
- a fixed value past its message;
- a record past the end of its message, at every depth, its field known or not: a known message
  walked by its shape, an unknown `LEN` record kept opaque, as protobuf keeps it;
- a packed record of a known repeated scalar of a numeric type whose values do not end at its
  length: a fixed width that does not divide it, or a last varint that runs past it (17.9.1), as
  Google.Protobuf refuses it;
- in a map's entry, walked as the message it is on the wire, its key at 1 and its value at 2, a
  value message by its shape, what it refuses in a message;
- a group not closed by an end group of its own number, an unknown group walked as an unknown
  message; the wire types 6 and 7, and an end group that closes no group;
- a message nested more than 100 deep below the top one, a group and a map's entry each counting as
  a message (17.9.3): Google.Protobuf counts them so, and the check refuses first where protobuf-es,
  which does not count an entry, would read on;
- a field the message declares, at a wire type its type does not take, in a map's entry too, a
  repeated scalar of a numeric type taking its own and the length-delimited (17.9.5);
- a field a map's entry does not declare (17.9.6).

**Two levelings, the user's choice, both as recommended**: 17.9.5 and 17.9.6. No
standard settles either: protobuf states no rule of them, and the reference parsers keep the first
as an unknown field and skip the second. The parity rule settles the direction
([0004](0004-one-behaviour-in-every-language.md)): where one library reads Y and the other Y and Z,
every side reads Y, and refuses the rest, each a row of the matrix's "Leveled down". Without the
first, protobuf-es still takes a record past its message through a message field at the varint wire
type, and the two sides read a map's key at another wire type apart; without the second, they read
an entry with an undeclared field apart. `WIRE` makes the first break no evolution beadc passes.

**17.9.3 counts a group and a map's entry as a message**, as each is one on the wire ("Maps"), and
as Google.Protobuf counts them.

**The runtime codec calls the check, for generated code.** A generated codec is the runtime's
codec of its message's schema, `protoCodecOf(FooSchema)` of `@francisdesjardins/bead/proto` and
`global::Bead.Protobuf.ProtoCodecs.Of<global::Foo>()`, whose read checks the records before the
library reads them, then reads at 17.9.3's bound and judges the message's required fields
([0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)). 3 is the contract whose code first called the check, since generated code that
calls it needs an export a runtime without it lacks, which is what moves the counter. **The runtimes
hold 5 and 6**, on both sides, 5 for a route table ([0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)) and 6 since a service's
generated file calls the runtime codec ([0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)), and none older: they hold no
`GENERATED_CODE_SUPPORTS_VERSION_2`, `_3` or `_4` and no `GeneratedCode.SupportsVersion2`,
`SupportsVersion3` or `SupportsVersion4`, so code that names 2, 3 or 4, an earlier beadc's, fails its
type-check and its build until it is regenerated.
A runtime keeps a constant while it still serves the code that names it, and one that would run
version-2 code unchecked no longer serves it as Bead conforms: before 1.0.0, an older constant goes
once the code that names it no longer conforms through the runtime; from 1.0.0, it stays for the
whole major.

**`spec/codecs.proto` is edition 2023, protobuf's current form, and `Probe` reaches each record**:

```proto
edition = "2023";

package bead.codecs.v1;

option features.field_presence = IMPLICIT;

message Probe {
  string text = 1;
  uint32 number = 2;
  Probe child = 3;
  repeated uint32 counts = 10;
  repeated fixed32 stamps = 11;
  map<string, Probe> children = 12;
  Probe delimited = 13 [features.message_encoding = DELIMITED];
}
```

Implicit presence keeps `text` and `number` as proto3 has them, so the entries on the first three
fields read and write as they would under proto3; `counts` is packed, edition 2023's default;
`delimited` is a group on the wire. The fields of these records take 10 to 13, since entries read 4
to 6, 9 and 15 as fields `Probe` does not declare, and a message field's name is never `nested`,
which a row's `read` gives as a depth. protoc 36.2, protoc-gen-es 2.16.0 under buf, and Grpc.Tools
2.84.0 each compile it. A row's `read` gives, beside the top `Probe`'s text, number and depth, its
`counts` and `stamps`, each key of `children` to its value's text, number and depth, and
`delimited`'s, each where it holds any.

**The entries.** The entries of what a stock library reads past protobuf's rules — a tag of more
than 5 bytes or past 32 bits, a length past 32 bits, an unknown varint of more than 10 bytes, a
record past the end of its message — are played by every side, none excused. Each part has its
entries, each citing its unit, none excused, every reading confirmed on both libraries, the check
in front:

- read: `counts packed`, `counts unpacked and packed, in one message`, `stamps unpacked`,
  `stamps packed`, `a map's entry, its value before its key`, `a group closed by its own end group`
  (17.9), and `50 maps deep, 100 messages below the top, each entry counted` (17.9.3);
- refused, not its message: `a packed fixed32 whose length is no multiple of 4`,
  `a packed uint32 whose last varint runs past its record, a field after`,
  `a group closed by another number's end group`, `a group never closed` (17.9.1);
- refused, nested past 100: `51 maps deep, 102 messages below the top, each entry counted`, which
  protobuf-es alone reads (17.9.3);
- refused under 17.9.5: `a string at the varint wire type`,
  `a uint32 at the length-delimited wire type`, `a uint32 at the fixed32 wire type`,
  `a message at the varint wire type, a string after`, `stamps at the varint wire type`,
  `delimited at the length-delimited wire type`, and `a map's key at the varint wire type`,
  `62 04 08 02 12 00`, which protobuf-es reads as the key `"\u0012\u0000"` and Google.Protobuf as
  `""`;
- refused under 17.9.6: `a map's entry with a field it does not declare`,
  `62 0C 1A 0A 01 7A 12 06 0A 04 61 62 63 64`, which protobuf-es reads as `z` to the text `abcd` and
  Google.Protobuf as `""` to an empty `Probe`.

**Protobuf's conformance suite is a gate every side answers to**, through each side's generated
codec, the check in front:

- **The runner is fetched by its pin, as protoc is.** `tools/protobuf-conformance/runner.json` pins
  `protobuf-conformance` 36.2.0: its tarball's registry URL, its `upstreamVersion`, `v36.2`, and
  npm's `dist.integrity`, a sha512, as `builder/protoc.json` pins protoc.
  `tools/protobuf-conformance.mjs` fetches it, checks its sha512 before it reads a byte, and unpacks
  it into `tools/protobuf-conformance/.runner/`, which git ignores and CI caches by the pin's hash.
  No manifest and no lockfile go at the root, whose tools are Node scripts without dependencies
  ([0005](0005-a-toolchain-per-language.md)), and no install of a side carries it. It ships
  linux-x64 and darwin-x64 binaries alone, so the gate runs in CI, and on Windows in Docker.
- **`tools/protobuf-conformance.mjs <typescript|csharp|differential>`** ejects the pinned package's
  test protos into a scratch folder, runs `beadc generate` over
  `tools/protobuf-conformance/service.proto`, which binds the five test messages, proto3, proto2,
  edition 2023 and the two editions variants, and `Probe`, for the side's target, builds its testee,
  and runs
  `conformance_test_runner --enforce_recommended --maximum_edition MAX --failure_list <the side's list> <testee>`.
  **Its floor**: a side's successes and its expected failures are 5,601, and its skips 48, its JSON
  tests answered through Bead's mapping of protobuf's JSON
  ([0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md));
  the runner closes a text-format suite after it, whose 909 tests a testee skips, since Bead's
  `proto` carries no text form. Each count moves only with the pin, or with a form the testees
  answer. Rust, and each language after it, adds its testee's command.
- **The testees**, `implementations/typescript/tools/protobuf-conformance/` on the TypeScript side's
  own install, type-checked by its own `tsconfig.json` once its code is generated, since the side's
  type-check and lint cannot read it without that code, and `implementations/dotnet/tools/Bead.ProtobufConformance/`, outside `Bead.slnx`
  since its generated code exists only at run time, under `Directory.Build.props`, with its own
  `packages.lock.json`, restored locked, and its format run by name. Nothing of protobuf's is
  committed: its test protos, under BSD-3-Clause, are ejected at run time from the pinned package,
  and the code generated from them is written at run time.
- **A skip never hides a test**: a testee answers `skipped` only for a text or JSPB request or
  output, for a JSON test that asks an unknown member ignored, which Bead's mapping refuses and
  takes no option to ignore, and for `protobuf_test_messages.edition_unstable`'s message, an
  unstable edition no stock generator compiles; and a binary request for any other message it lacks
  with `runtime_error`, which fails it.
- **The failure lists**, `failing.txt` beside each testee, each line the test and the runner's
  message, its reason on the comment line above; the runner fails a listed test that passes, so the
  list is held both ways. The TypeScript side's names
  `Recommended.Editions.ProtobufInput.RejectInvalidUtf8.String.Extension`, an extension read as an
  unknown field since the generated codec gives no registry; the C# side's, the same and
  `Required.*.ProtobufInput.UnknownOrdering.ProtobufOutput`, since Google.Protobuf writes a
  message's unknown fields back by number and wire type, a platform row; and each names besides the
  two JSON tests of an extension's JSON name, which Bead's mapping reads as no field of its message
  ([0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)).

**How the pin moves.** One runner serves both libraries. The tool fails when `runner.json`'s
`upstreamVersion` and Google.Protobuf's pin name different protobuf releases, `v36` and `3.36`
alike. A bump of `@bufbuild/protobuf` reads the `protobuf-conformance` version its
`packages/protobuf-conformance/package.json` pins at the new tag. A bump of either library moves
`runner.json`, both failure lists and the floor in one commit. Where the two libraries pin different
releases, the runner follows the older, and the newer library's bump waits for the other.

**The differential.** `tools/protobuf-conformance.mjs differential` feeds each side's testee the
same 10,000 payloads from a fixed seed: `Probe`'s own records, mutated by cuts, lengths, wire types
and nesting, maps and groups among them. It compares each side's verdict, read or refused, and the
bytes each writes back as what they read, at every depth, the choices protobuf leaves to a writer
aside: the order of unknown fields, the order of a map's entries, and an entry's key at its
default, which protobuf-es writes and Google.Protobuf leaves out. The first and the last are the
platform rows; any other parting fails it.

## Consequences

**The matrix holds no open row for a stock library reading past protobuf's rules**, both sides
playing those entries. Its "Leveled down" holds "A known proto field at a wire type its type does
not take, a map's entry's included" and "A proto map's entry with a field other than its key and
its value"; two platform rows, "A proto message's unknown fields, written back" and "A proto map's
entry, its key at its default, written back", say what each library writes; "A string's leading
U+FEFF in a proto payload" is open, as it says why, and "A proto string no string holds, given to a
writer" is a platform row
([0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)).

**Code that names contract 2, 3 or 4 is regenerated**, on both sides, before it builds against
the runtime.
A C# project that binds `proto` references `Bead.Protobuf`; a TypeScript one carries
`@bufbuild/protobuf` for its messages, which `./proto` takes as a peer.

**The cost is a walk beside the read**, linear and bounded by `maximumPayloadBytes`. Measured with
each message's shape cached and the packed walk included, on `TestAllTypesProto3`: protobuf-es
2.16.0 under Node 26.5.0, the highest ratio of three runs, and Google.Protobuf 3.36.2 under .NET 10,
Release:

| Payload               | Bytes   | TypeScript's read | its check | ratio | C#'s read | its check | ratio |
| --------------------- | ------- | ----------------- | --------- | ----- | --------- | --------- | ----- |
| 2,000 nested messages | 11,870  | 228.68 µs         | 191.53 µs | 84%   | 119.47 µs | 64.45 µs  | 54%   |
| 2,000 strings         | 14,890  | 275.00 µs         | 94.24 µs  | 34%   | 90.03 µs  | 31.56 µs  | 35%   |
| 2,000 packed int64    | 9,730   | 30.18 µs          | 12.37 µs  | 41%   | 61.17 µs  | 23.20 µs  | 38%   |
| one string of 64 KiB  | 65,540  | 21.28 µs          | 0.08 µs   | 0%    | 98.53 µs  | 0.05 µs   | 0%    |
| a few fields          | 9–12    | 5.61 µs           | 0.09 µs   | 2%    | 2.80 µs   | 0.05 µs   | 2%    |
| 90 messages deep      | 313–317 | 558.90 µs         | 4.68 µs   | 1%    | 123.61 µs | 1.94 µs   | 2%    |

Under the read on every row, on both sides; most on a payload of many small messages, where
TypeScript's ratio ran from 47% to 84% across runs, and close to nothing otherwise. A packed
record's walk counts its varints' bytes without decoding a value, which keeps it under the library's
decoding of each. The bound each runtime holds: on each row, the check costs no more than its
library's read, the packed walk included, and allocates nothing per record; the C# side's allocates
no byte over 1,000 checks of each payload.

**The gate.** [0006](0006-a-rule-has-its-gate.md)'s table holds the suite and the differential, a
job of their own, `protobuf-conformance`; `spec/codecs.json`'s entries hold the parts the suite at
v36.2 does not reach; each side's twin tests of the check, `src/proto/__tests__/records.test.ts` and
`tests/Bead.Protobuf.Tests/ProtoRecordsTests.cs`, one sentence each pair, hold what no entry of
`Probe` reaches.

**Rust, and each language after it,** checks a payload's records by its own library's descriptor,
plays the entries, and adds its testee to the suite.

**Out of scope**: the U+FEFF row, which stays open; the writer's surrogate; and the upstream
reports, protobuf-es's points, its packed reading, its map entries, its depth count and its wire
types, which wait, by the user's word. Google.Protobuf's unknown ordering is tracked by protobuf
already.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, at xhigh effort, which [0004](0004-one-behaviour-in-every-language.md) shares for the
ledger of units; its two levelings were the user's, each as recommended. Its objections, each with
the answer that holds:

### On the check of a payload's records, and protobuf's suite

| Objection                                                                                                                                                                                                                                                                                                                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A packed record whose values do not end at its length passes the walk. protobuf-es reads on past it and swallows a record, while Google.Protobuf refuses it. So "the four rows close" and "refuses what protobuf refuses" are false, and the shape must carry each field's wire types whether or not the leveling is taken | Accepted: the probe reproduces both cases, and protobuf-es's list reader never checks the record's end. The check refuses a packed record whose values do not end exactly at its length (a fixed width that does not divide it, or a varint that runs past it), whatever the leveling, under 17.9.1, since Google.Protobuf refuses it. Each field's wire kind is read from its descriptor, always. Two entries and a pair of twins hold it.                                                                                                                                                                          |
| The check never enters a map's entry. protobuf-es reads an entry by field number alone, ignoring the wire type and skipping no undeclared field, so the two sides read some entries apart; and the two prototypes differ                                                                                                   | Accepted: protobuf-es's `compileMapFieldReader` has no default case and reads no wire type. The check walks an entry as the message it is on the wire, its key at 1 and its value at 2, by the descriptor on both sides. A key at another wire type is refused under the first leveling, which reaches into entries. An undeclared field is legal protobuf, so refusing it is a second leveling, put to the user, who took it.                                                                                                                                                                                       |
| "The library refuses the same" is false through a map. Google.Protobuf counts a map's entry toward its depth and protobuf-es does not, so from 34 to 50 cycles the sides part, with no row and no entry                                                                                                                    | Accepted: both depth probes show it. 17.9.3 says that a group and a map's entry each count as a message, since a map is a repeated entry message on the wire (Encoding, "Maps") and Google.Protobuf counts it so. The check counts them on both sides, and refuses before protobuf-es would read on. Two entries, 50 and 51 maps deep, pin it. The sentence is struck.                                                                                                                                                                                                                                               |
| Probe has no map, no repeated field and no group, so no entry, nor the review's corpus, can reach the cases above, which is why they slipped past all three proofs                                                                                                                                                         | Accepted: `spec/codecs.proto` is edition 2023, with field presence implicit so that the earlier entries keep their readings. `Probe` holds a packed `repeated uint32`, a `repeated fixed32`, a `map<string, Probe>` and a delimited `Probe`, which is a group on the wire; protoc, protoc-gen-es and Grpc.Tools each compile it. `make_codecs.py` writes the entries. The review's corpus, pointed at the widened `Probe`, is played through both generated readers, and stays a gate, as `tools/protobuf-conformance.mjs differential`.                                                                             |
| A shape written by beadc is a second copy of the descriptor. It goes stale under external messages, re-resolves features and map entries, freezes a table format at contract 3, and avoids a tie to the libraries that generated code already has. C#'s double walk is unmeasured                                          | Accepted, as (a): the runtime builds each message's shape from the library's own descriptor, once, cached by the descriptor. TypeScript does it in the subpath `./proto`, by `import type` with an optional peer dependency; C# in the `Bead.Protobuf` assembly, so `Bead.Core` still references no Google.Protobuf. No table exists to go stale or to freeze, and the library resolves features and entries itself. (b) is refused: it reads the descriptor too, and adds a table to check against it. C#'s cost is measured, at most 54% of the read, and the check is held under the library's read on every row. |
| The user's decision is too narrow: it covers the wire-type rule on Probe's fields, not whether the rule reaches into map entries, nor the second leveling an entry's undeclared field needs                                                                                                                                | Accepted: two levelings were put to the user, each with its Leveled down row and its entries, and the user took both. The wire-type rule reaches into entries. The point the dissenter checked and did not press, that buf's `WIRE` flags every change between singular and repeated, is the reason the first breaks no evolution beadc passes.                                                                                                                                                                                                                                                                      |
| The CI floor of 2,832 successes fails the C# run, which has 2,828 successes and 5 expected failures                                                                                                                                                                                                                        | Accepted: the floor is the side's successes plus its expected failures, the same on both sides, beside its skips; both move only with the pin, or with a form the testees answer, as protobuf's JSON ([0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md))                                                                                                                                                                                                                                                                                                    |
| The suite's location crosses the toolchains: a 10 MB runner in the TypeScript lockfile installed everywhere, the C# gate on the TypeScript install, a C# testee whose place under the solution's gates is unsaid, and no procedure for moving the pin                                                                      | In part: the goal is taken, but not the location. A root `package.json` would break 0005 ("The root's tools are Node scripts without dependencies"), so the runner is fetched by its pinned sha512, as `builder/protoc.json` and its fetch script do for protoc, into an ignored, cached folder, with no lockfile. The TypeScript lockfile does not carry it. The C# testee sits under `Directory.Build.props`, outside `Bead.slnx`, with its own lock file, and its format is run by name. This record states how the pin moves with either library.                                                                |
| Keeping version 2 lets code generated before the check run unchecked on a runtime that claims to refuse those payloads                                                                                                                                                                                                     | Accepted: the runtime holds contract 3 alone, on both sides, so code that names 2 fails its type-check and build until it is regenerated. The reason is the runtime's own rule ("while the runtime still serves the code that names it"): a runtime that would run version-2 code unchecked no longer serves it as Bead conforms. `generated-code.ts` and its C# twin state the rule before and after 1.0.0.                                                                                                                                                                                                         |
| Filing the unknown ordering as `open` contradicts the matrix's own kinds, 17.9 and the row's own text, and the draft gives no criterion for when a side may go past its library                                                                                                                                            | Accepted: the row is `platform`, lifting when Google.Protobuf keeps the order. This record states the criterion: a side may narrow what reads before its library, never read or write in its place. The check is a refusal before a read. Reordering a write would replace the library's writer, which 17.9 does not allow.                                                                                                                                                                                                                                                                                          |
| The U+FEFF row's "the decoder strips it before any check could" passes over `configureTextEncoding`                                                                                                                                                                                                                        | In part: the row already names `configureTextEncoding` and why it is not taken (global to the library's copy, and deprecated), so the row stands as it is. The out-of-scope sentence points at the row.                                                                                                                                                                                                                                                                                                                                                                                                              |
