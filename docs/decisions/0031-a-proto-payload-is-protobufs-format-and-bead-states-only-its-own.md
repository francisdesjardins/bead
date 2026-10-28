# 0031 — A `proto` payload is protobuf's binary format, read and written through each side's stock library, and Bead states only what is its own

- **Status**: accepted
- **Scope**: the protocol and both sides' tests: in [`spec/spec.md`](../../spec/spec.md), 17.9 and
  the sentence of 17.1 that counts four encodings; `spec/codecs.proto`; `spec/codecs.json`'s `proto`
  rows, its schema's `proto` encoding and its reasons `not its message` and `nested past 100`;
  `spec/generators/make_codecs.py`'s reader of `Probe`, and `spec/check.py` over those rows; each
  side's tests' protobuf toolchain; the support matrix's `proto` rows. The codec of two functions a
  `proto` binding is made with, `payloadCodecOf` and `PayloadCodecs.Of`, is
  [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s;
  what a target writes,
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s;
  the check of a payload's records, 17.9.3's count of a group and a map's entry, 17.9.5, 17.9.6,
  `Probe`'s fields 10 to 13 and protobuf's conformance suite,
  [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s;
  17.9's items 7 and 8, a message that leaves a required field unset and a closed enum's undeclared
  number, the runtime codec generated code calls, `Probe`'s fields 7, 8 and 14 and the reason
  `a required field unset`, [0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)'s

## Context

A procedure's payload is a protobuf message wherever its definition binds one, in a `.proto` any
message but `bead.Raw`, `bead.Text` and `bead.Json`
([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)), and
the code beadc generates reads and writes it through a codec the runtime makes of its stock
library's two functions
([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)).
Every side needs one answer to a protobuf message that does not decode, and a conformance file that
pins it, as `spec/codecs.json` pins `raw`, `text` and `json`
([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)); and Rust, and each language
after it, needs to know what of the format is Bead's to state, and what is protobuf's.

**What the stock libraries do.** Probed on 2026-10-05: protobuf-es 2.16.0 and Google.Protobuf 3.36.2
agree on every outcome a protobuf payload's reader meets first — a premature end, a string that is
not UTF-8, an unknown field, an empty payload — and on a message field set to the empty message,
written `1A 00` on both. They part on a string's leading U+FEFF, on a field they know arriving at
another wire type, and on where they count nesting from: protobuf-es counts the top message,
Google.Protobuf the nested ones alone; each takes its bound as an option, and with one set
explicitly both take 100 messages below the top and refuse 101.

### The options weighed

How a protobuf message's codec is made — the runtime depending on each language's protobuf
library, a module of its own, a codec written whole in each generated file, or two functions the
runtime makes a codec of — is
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s,
which takes the two functions, as gRPC's C# runtime does. What a payload is, read through them:

**What section 17 says of `proto`.** A restatement of protobuf's binary format gets it wrong three
times: "a writer writes no field at its default" is false of every field of explicit presence,
which protobuf writes at its default ("Explicitly set values are always serialized, including
default values", protobuf.dev, "Application Note: Field Presence"; a singular message field has
explicit presence in proto3); "a field it knows, at a wire type not its own, as a field it does not
know" contradicts protobuf's packed fields ("Protocol buffer parsers must be able to parse repeated
fields that were compiled as `packed` as if they were not packed, and vice versa", protobuf.dev,
"Encoding"); and an order of unknown fields written back pins what protobuf calls an implementation
detail ("Do not assume the byte output of a serialized message is stable", the same page).
**Chosen, the user's choice: section 17 names protobuf's format, and states only what is Bead's:**

- what does not decode is answered as any payload that does not read (17.2);
- an empty payload is the message with no field set, where an empty `json` payload is refused;
- a reader refuses a message nested more than 100 deep below the top one, a bound each side sets
  explicitly in its library;
- a string's leading U+FEFF is a character of it, as 17.4.2 keeps a `text` payload's.

**The bound.** It is Bead's, not a library's default: protobuf's C++ reads 100 by default
(`src/google/protobuf/io/coded_stream.h`, "Sets the maximum recursion depth. The default is 100."),
protobuf-go 10,000 (`DefaultRecursionLimit = 10000`, `encoding/protowire`), and the two stock
libraries count from different places. Its reason is 0016's for 64 in `json`: a peer never chooses
how deep a reader goes. Its number is protobuf's C++ default, which a protobuf user meets first,
counted below the top message, as Google.Protobuf counts. Each side sets it in the code that calls
its library, as the C# side sets `MaxDepth` for `json` rather than leaning on .NET's default, the
user's choice over leaving the C# side on its library's default with the rows for its gate:
protobuf-es takes `fromBinary(schema, bytes, { recursionLimit: 101 })`, since it counts the top
message; Google.Protobuf takes `CodedInputStream.CreateWithLimits(stream, int.MaxValue, 101)` over
the payload framed as a message field holds one, after its length, and reads it with
`ReadMessage`, which counts the top message too. Read so, the library refuses a message that ends
before its bytes do, a stray end group among them, as its parse of bytes does and its parse of a
stream does not; and an empty payload reads as the message with no field set, where a size limit of
its length, 0, would be refused. Probed: both then take 100 below the top and refuse 101.

**The leading U+FEFF.** It is Bead's rule, with 17.4.2's reason, RFC 3629 §6: protobuf says a
string holds UTF-8 text, and U+FEFF is a character of it. protobuf-es strips it: its strict decoder
is `new TextDecoder("utf-8", { fatal: true })`, whose `ignoreBOM` is false (WHATWG Encoding), and
the only lever is `configureTextEncoding`, global to the library's copy and deprecated. The
TypeScript side's row is a `differs`, crossing an open row of the matrix.

**Where a stock library reads on.** Each side reads a payload's records against its message before
its library does, and refuses what protobuf refuses, where a stock library reads on
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).
That check also holds the two levelings, where the libraries read apart and protobuf states no rule:
a field the message declares at a wire type its type does not take, and a map's entry with a field
other than its key and its value, each refused on every side (17.9.5, 17.9.6).

**A string no string holds, given to a writer.** Where Bead has no reason of its own, it states no
rule, and the matrix holds what each library does, each side's test pinning its own: a surrogate
alone. Both stock libraries write U+FFFD in its place; protobuf-go's `proto.Marshal` refuses it,
"string field contains invalid UTF-8" (golang/protobuf issue 1228); protobuf's guide says "A string
must always contain UTF-8 encoded or 7-bit ASCII text" (protobuf.dev, "Language Guide (proto 3)"). A
writer of `proto` refuses it or repairs it, as its library does: the runtime reads no field of the
message it is given, and 0016's refusal in `text` and `json` is a rule Bead can keep there because
its own codec writes every character.

**What a side conforms to, for `proto`**: its target's generated code over its stock library, at the
version its tests lock. A consumer whose messages are its own build's decodes with its own library's
version, which the generated file's header names the oldest of.

_Conformance:_ 17.9; `spec/codecs.json`'s `proto` rows, its schema's encoding, two reasons and the
fields read; its generator's reader of `Probe`, written with the standard library from protobuf's
Encoding guide ([0005](0005-a-toolchain-per-language.md)); `spec/check.py` over them. _Matrix:_ the
feature "Payloads" counts `proto`; an open row, "A string's leading U+FEFF in a proto payload"; a
platform row, "A proto string no string holds, given to a writer"; and the rows
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)
keeps, a known field at a wire type its type does not take among them, a row of "Leveled down".

## Decision

**Section 17 states a fourth encoding, `proto`**, and its first clause counts four:

> 17.9. `proto`: the payload is a protobuf message in protobuf's binary wire format, its message the
> one the procedure's definition names. What that format takes, refuses and writes is protobuf's, as
> its [Encoding](https://protobuf.dev/programming-guides/encoding/) guide and its
> [Language Guide](https://protobuf.dev/programming-guides/proto3/) state it; this section restates
> none of it, and a side reads and writes through its stock protobuf library and the code its
> generator writes for the message. What is Bead's:
>
> 1. Bytes that are no encoding of the message do not read (section 17.2).
> 2. An empty payload is the message with no field set.
> 3. A reader MUST refuse a message nested more than 100 deep below the top one, a group and a map's
>    entry each counting as a message, as a map's entry is one on the wire
>    ([Encoding](https://protobuf.dev/programming-guides/encoding/), "Maps"), and sets that bound in
>    its library rather than leaving it to the library's default.
> 4. A string's leading U+FEFF is a character of it (section 17.4.2).
> 5. A field the message declares, at a wire type its type does not take, does not read (section
>    17.2), a map's entry's key and value among them, where protobuf's reference parsers keep it as
>    an unknown field: one stock library reads it as its declared type, which may take a record past
>    its message, so every side refuses it. A repeated scalar of a numeric type takes its own wire
>    type and the length-delimited, packed or not
>    ([Encoding](https://protobuf.dev/programming-guides/encoding/), "Packed Repeated Fields").
> 6. A map's entry with a field other than its key and its value does not read (section 17.2), where
>    protobuf's reference parsers skip it: one stock library reads such an entry apart, so every side
>    refuses it.
>
> Where two stock libraries part on what protobuf states no rule of, the support matrix says what
> each does. The `proto` rows of `spec/codecs.json` read and write `Probe`, the message of
> `spec/codecs.proto`.

Its items 1 to 4 are this record's; 3's count of a group and a map's entry, and items 5 and 6, the
levelings of a field at a wire type its type does not take and of a map's entry with a field it
does not declare, are
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s;
items 7 and 8, a message that leaves a required field unset and a closed enum's undeclared number,
are [0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)'s.

**The runtime codec sets the bound, in both languages.** What a target writes of a `proto` binding
is the runtime's codec of its message's schema, which reads through the stock library with Bead's
bound, the payload's records checked against its message before the library reads them
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md))
and its required fields judged once it is read ([0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)):

```ts
request: protoCodecOf(SayHelloRequestSchema),
```

```csharp
global::Bead.Protobuf.ProtoCodecs.Of<global::Hello.V1.SayHelloRequest>()
```

What the codec runs, laid out here over lines, its required walk and the C# side's filter of a
closed enum's record aside:

```ts
payloadCodecOf<SayHelloRequest, MessageInitShape<typeof SayHelloRequestSchema>>({
  decode: (bytes) => {
    checkProtoRecords(bytes, SayHelloRequestSchema);
    return fromBinary(SayHelloRequestSchema, bytes, { recursionLimit: 101 });
  },
  encode: (given) => {
    return toBinary(SayHelloRequestSchema, create(SayHelloRequestSchema, given));
  },
});
```

```csharp
global::Bead.PayloadCodecs.Of<global::Hello.V1.SayHelloRequest>(
    (bytes) =>
    {
        // ! the check first, by the descriptor Google.Protobuf reads with: it refuses what protobuf
        // refuses where a stock library reads on (decision 0028)
        global::Bead.Protobuf.ProtoRecords.Check(bytes.Span, global::Hello.V1.SayHelloRequest.Descriptor);

        // ! spec 17.9's bound, set here rather than left to the library's default. The payload is
        // read as a message field holds one, after its length, and the top message counts: 101 is
        // 100 below it
        var framed = new byte[global::Google.Protobuf.CodedOutputStream.ComputeLengthSize(bytes.Length) + bytes.Length];

        using (var output = new global::Google.Protobuf.CodedOutputStream(framed))
        {
            output.WriteLength(bytes.Length);
        }

        bytes.Span.CopyTo(framed.AsSpan(framed.Length - bytes.Length));

        using var stream = new global::System.IO.MemoryStream(framed, writable: false);
        using var input = global::Google.Protobuf.CodedInputStream.CreateWithLimits(stream, int.MaxValue, 101);
        var message = new global::Hello.V1.SayHelloRequest();

        input.ReadMessage(message);

        return message;
    },
    (message) =>
    {
        return global::Google.Protobuf.MessageExtensions.ToByteArray(message);
    })
```

protobuf-es counts the top message, so its 101 is 17.9.3's 100 below it; Google.Protobuf reads the
payload framed as a message field, whose read counts the top message too.

**`spec/codecs.json` holds `proto` rows, played through each side's stock library.** The fixed
message is `spec/codecs.proto`:

```proto
edition = "2023";

package bead.codecs.v1;

option features.field_presence = IMPLICIT;

message Probe {
  string text = 1;
  uint32 number = 2;
  Probe child = 3;
  Needs needs = 7;
  repeated Needs needs_items = 8;
  repeated uint32 counts = 10;
  repeated fixed32 stamps = 11;
  map<string, Probe> children = 12;
  Probe delimited = 13 [features.message_encoding = DELIMITED];
  Shade shade = 14 [features.field_presence = EXPLICIT];
}
```

Its first three fields are the ones the rows below read, beside fields it does not declare; 10 to
13, a packed record, a repeated fixed32, a map's entries and a group, are
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s;
7, 8 and 14, a message of fields protobuf requires, alone and repeated, and a closed enum, are
[0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)'s; and implicit presence keeps `text` and `number` as proto3 reads them. A `proto` payload row pins an
outcome: taken, with the fields read (`read`: its `text` as UTF-16 code units, its `number`, how
deep messages nest below the top, and, where it holds them, its `counts`, its `stamps`, its
`children`, its `delimited` and its `shade`), or refused, with its reason. A `proto` value row pins written bytes
only where protobuf fixes them, one field at a time. The schema's `encoding` takes `proto`; its
reasons `not its message` (17.9.1), `nested past 100` (17.9.3) and `a required field unset`
(17.9.7), derived by the regeneration alone, as 0016's are. `make_codecs.py` reads each row's bytes
with a reader of `Probe` written with the standard library from protobuf's Encoding guide, and
Bead's 17.9.2 to 17.9.8. The rows, those
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)
states aside:

| Row                                      | Bytes                                | Outcome                        | `differs`  |
| ---------------------------------------- | ------------------------------------ | ------------------------------ | ---------- |
| an empty payload                         | none                                 | taken: no field set            |            |
| a string and a number                    | `0A 01 61 10 07`                     | taken: `a`, 7                  |            |
| a length past the bytes                  | `0A 05 61 62`                        | refused: not its message       |            |
| a varint cut short                       | `10 80`                              | refused: not its message       |            |
| a tag alone                              | `0A`                                 | refused: not its message       |            |
| a string that is not UTF-8               | `0A 01 FF`                           | refused: not its message       |            |
| an overlong form in a string             | `0A 02 C0 AF`                        | refused: not its message       |            |
| a surrogate in UTF-8                     | `0A 03 ED A0 80`                     | refused: not its message       |            |
| a string's leading U+FEFF                | `0A 04 EF BB BF 61`                  | taken: U+FEFF `a`              | TypeScript |
| U+FEFF after a string's first character  | `0A 04 61 EF BB BF`                  | taken: `a` U+FEFF              |            |
| a noncharacter, U+FFFF                   | `0A 03 EF BF BF`                     | taken: U+FFFF                  |            |
| U+0000                                   | `0A 01 00`                           | taken: U+0000                  |            |
| an unknown field after the known         | `0A 01 61 78 07`                     | taken: `a`                     |            |
| an unknown field before the known        | `78 07 0A 01 61`                     | taken: `a`                     |            |
| an unknown field of each wire type       | `21 01 … 08 2A 01 7A 35 01 02 03 04` | taken: no field set            |            |
| a number given at its default            | `10 00`                              | taken: 0                       |            |
| a scalar given twice                     | `10 01 10 02`                        | taken: 2                       |            |
| a message given twice                    | `1A 02 1A 00 1A 02 10 01`            | taken: merged, 2 below the top |            |
| a message field set to the empty message | `1A 00`                              | taken: a child, no field set   |            |
| field number 0                           | `00 01`                              | refused: not its message       |            |
| a varint of 10 bytes                     | `10 FF FF FF FF FF FF FF FF FF 01`   | taken: 4294967295              |            |
| a varint of 11 bytes                     | `10 80 … 80 01`                      | refused: not its message       |            |
| an end group no group opened             | `24`                                 | refused: not its message       |            |
| an unknown group, closed                 | `23 24`                              | taken: no field set            |            |
| an unknown group never closed            | `23`                                 | refused: not its message       |            |
| 99 messages below the top                | `1A E6 01 …`                         | taken: 99 below                |            |
| 100 messages below the top               | `1A E9 01 …`                         | taken: 100 below               |            |
| 101 messages below the top               | `1A EC 01 …`                         | refused: nested past 100       |            |

A message given twice is merged, so its row gives the child of the first copy a child of its own:
a reader that merges reads 2 below the top, and one that keeps the last copy reads 1. Six values,
each one field or none: `text` `a`, written `0A 01 61`; `number` 7, written `10 07`; `number` 0,
written as nothing; no field set, written as nothing; `child` set to the empty message, written
`1A 00`; `text` U+FEFF `a`, written `0A 04 EF BB BF 61`.

Beside them, the file holds the entries
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)
states, every side playing them: a tag, a length and an unknown varint at protobuf's bounds and past
them, a record past the end of its message, a known field at a wire type its type does not take
(`08 61`, `12 00`, `15 01 02 03 04` on the first three fields among them, under 17.9.5), and the
records of fields 10 to 13. What the file leaves to the matrix, each side's test pinning its own
library: a string holding a surrogate alone, given to a writer.

**Each side's tests generate `Probe` with their stock generator**: the TypeScript side with
protoc-gen-es run by buf, both from npm (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`,
`@bufbuild/buf`, development dependencies), its output,
`src/router/shared/__tests__/codecs_pb.ts`, committed and held to what buf writes by `yarn check`;
the C# side with Grpc.Tools' `<Protobuf Include>` in `Bead.Core.Tests`, beside Google.Protobuf,
generated at each build. Each plays the rows through the runtime codec generated code calls,
`protoCodecOf` and `ProtoCodecs.Of`, the check of the records, the bound and the required walk
included:
`codecs.test.ts` and `CodecsTests`.

**The rule has its gate** ([0006](0006-a-rule-has-its-gate.md)): `spec/check.py` over the `proto`
rows, their `differs` and their schema, and over the `.proto` the spec names; each side's harness,
which plays every row but those a `differs` excuses its language from; the generated `Probe` held to
its generator by `yarn check`.

## Consequences

**The tests of both sides depend on a protobuf library**, each its platform's stock one: the
TypeScript side's lockfile holds `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and
`@bufbuild/buf`, which carries a binary per platform and runs under the repository's Yarn with its
build scripts disabled, and `yarn check` runs it; the C# test project references Google.Protobuf
and Grpc.Tools, which carries protoc. `Bead.Core` references no protobuf library, and the TypeScript
side takes `@bufbuild/protobuf` as an optional peer, for its `./proto` entry alone
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)):
a user of `raw`, `text` or `json` carries neither.

**A `proto` row tests a library's locked version through Bead's generated calls.** A library
upgrade that changes a pinned outcome fails the rows with nothing of Bead's changed, and is then
read: a library that moved against protobuf, or a row that pinned more than protobuf says. The rows
pin no whole message's bytes, so a library's order of fields is never one of them.

**A C# read of a `proto` payload costs a copy** of its bytes after their length, and a stream
around them, for the bound to be Bead's rather than the library's.

**Rust, and each language after it,** plays the `proto` rows through its own stock library and its
target's calls, sets the bound in its library, and finds its own outcome for the platform row.

**The matrix's `proto` rows.** The feature "Payloads" counts `proto`; the open row "A string's
leading U+FEFF in a proto payload" holds the one `differs` of these rows, the TypeScript side's; the
platform row "A proto string no string holds, given to a writer" says what each library writes; and
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s
rows say where the libraries read or write apart, in "Leveled down" and as platform rows.

## The Tenth Man

The `proto` encoding met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at xhigh effort in the round on
the service layer's draft, which
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md#the-tenth-man)
keeps; each claim was verified before its answer, and the user chose where it asked, each way as
the revised draft recommended. Its rows on `proto` are kept here, each with its answer:

| Objection                                                                                                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The draft's section on `proto` restates protobuf's binary format and gets it wrong three times: a field of explicit presence is written at its default, a packed field arrives at another wire type and is still the field, and the order of fields written is an implementation detail | Accepted: verified on protobuf.dev ("Explicitly set values are always serialized, including default values"; "parse repeated fields that were compiled as `packed` as if they were not packed, and vice versa"; "Do not assume the byte output of a serialized message is stable") and on both libraries (`1A 00` written as read). 17.9 names protobuf's format and restates none of it; it states four things of Bead's. A row pins taken or refused, and the fields read; a value row pins bytes one field at a time. `1A 00` joins the rows and the values                                                                                                                                                                                                                                                                                            |
| The draft turns two behaviours of Google.Protobuf into Bead's MUSTs, the nesting count and a known field at another wire type, excuses protobuf-es by `differs`, and tests a library version Bead does not ship; its probe ran under npm, not the repository's Yarn                     | Accepted: the bound is Bead's, 0016's reason, 100 below the top, set explicitly on both sides — `recursionLimit: 101`, and `CreateWithLimits(…, 101)` over the payload framed as a field, both probed to take 100 and refuse 101; protobuf's C++ default read at its source, protobuf-go's 10,000 noted. A known field at another wire type is a leveling of [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s, every side refusing it. The leading U+FEFF stays Bead's, 17.4.2's reason, its `differs` crossing an open row that says protobuf-es strips it, its only lever global and deprecated. What a side conforms to for `proto` is its target's calls over its locked library, said in the Consequences. buf from npm ran under Yarn 4.18.1, node-modules linker, and generated the same file |
| The draft's clause on a writer makes the writer's U+FFFD a MUST, false of protobuf-go, which refuses, and a third behaviour beside 0016's refusal                                                                                                                                       | Accepted: the clause goes. A writer refuses or repairs as its library does; a platform row says both stock libraries write U+FFFD, each side's test pinning it, no bytes in the file. Verified: golang/protobuf issue 1228; "A string must always contain UTF-8 encoded or 7-bit ASCII text" (protobuf.dev, proto 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
