# 0031 — A `proto` payload is protobuf's binary format, read and written through each side's stock library, and Bead states only what is its own

- **Status**: accepted
- **Scope**: the protocol and every side's tests: in [`spec/spec.md`](../../spec/spec.md), 17.9 and
  the sentence of 17.1 that counts four encodings, 17.9.3's bound of a writer among them;
  `spec/codecs.proto`, its field 16 among them; `spec/codecs.json`'s `proto` rows, its schema's
  `proto` encoding, its `probe`'s chains and its reasons `not its message` and `nested past 100`;
  each side's `proto` writer, its depth pass and its records check over what it wrote;
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
([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)); and every language needs to
know what of the format is Bead's to state, and what is protobuf's.

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

**What a writer does with a deep value.** protobuf's readers bound their recursion, at 100 in C++'s
`CodedInputStream`, Java's `DEFAULT_RECURSION_LIMIT`, Google.Protobuf's `DefaultRecursionLimit` and
upb's `upb_DecodeOptions_MaxDepth`, at 10,000 in Go's `protowire`; its writers bound nothing. upb
writes 101 and 200 levels it then refuses to read, and overflows its stack at 10,000. Each stock
library writes a `Probe` 101 below the top, 239 bytes its own reader refuses, and a value 60 unknown
groups deep, kept from a reading, under 41 known levels. Past that, protobuf-es's `toBinary` throws
a `RangeError` at 10,000 levels; Google.Protobuf's `CalculateSize` recurses about 2,475 frames on a
1 MiB thread, and a C# `StackOverflowException` is never caught; Buffa's writer takes 10,000 levels.
RFC 1122 §1.2.2 ("be conservative in what you send") and RFC 9413 §4 say why a writer that emits
what every conforming reader refuses fails at the far end, after the call went out; the `json`
writer refuses past 64 for that reason (17.7).

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
>    its library rather than leaving it to the library's default. A writer MUST refuse a value so
>    nested (section 17.2).
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

What the codec runs, laid out here over lines, its depth pass, its required walk, its check of what
it wrote and the C# side's filter of a closed enum's record aside, which the paragraphs below and
[0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)
state:

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

**A writer refuses what its reader refuses for depth** (17.9.3, 17.2): a message nested more than
100 deep below the top one, counted as the reader counts on the wire, a group, a map's entry and an
unknown group each a message. The refusal is the writer's codec refusal, never a programmer error:
a `TypeError` on the TypeScript side, a `FormatException` on the C# side, a `CodecRefusal` on the
Rust side, its words `nested past 100`; 17.2 says what each place does with it, a request's value
failing its call before anything goes, an answer's answered `PROCEDURE_FAILED`, a notification's
going to no subscription. The writer runs, in this order:

1. **The depth pass, before anything is built or written.** Its job is to keep every recursion
   unreached, the library's and Bead's own: protobuf-es's `create` of a deep init and its
   `toBinary`, Google.Protobuf's `CalculateSize`, and the required walk on each side. It walks the
   value's known fields as the side holds them, bounded at 101 frames, and counts as the wire nests:
   a singular message field, a repeated field's item and a group, one each; a oneof's message
   member, as the message field it is, on the TypeScript side under the oneof's name as
   `{ case, value }`; every map's entry one, a scalar or enum map's among them, and its message
   value one more; and on the TypeScript side a `google.protobuf.Struct` held as a JSON object in a
   field, three a level (the `Struct`, its entry, the `Value`), and a JSON array two (`ListValue`,
   `Value`), the count the gateway makes, one module of `src/proto/` serving both. It may count less
   than the wire nests — kept unknown groups, an extension's message, an `Any`'s bytes — never more,
   so it never refuses what the reader takes. Each side's shape of a message holds, beside whether
   it reaches a required field, whether its known fields can nest past 100, a cycle or a path deeper
   than 100, computed once from the descriptor; the pass is skipped where they cannot. That flag is
   sound for this layer's job alone, never for the rule: any schema carries what a reading kept.
2. **The required walk**
   ([0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)),
   within 101 levels wherever the pass ran.
3. **The library writes.**
4. **The reader's own records check over the written bytes**
   ([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)),
   `checkProtoRecords`, `ProtoRecords.Checked`, `check_records`. A refusal there is the writer's
   refusal, its words the reader's reason. This layer is 17.2's judgment, for every rule of 17.9's
   records: depth through kept unknown groups and delimited extensions, and anything the pass
   counts short. It costs one linear pass over the bytes a write, the cost 0028 accepts for every
   read.

A value nested past the bound in its known fields that also leaves a required field unset is
refused for its depth, as the pass runs first. One residual is the application's: unknown fields it
builds by hand (Buffa's `UnknownFields` is public) deeper than its stack recurse in the library
before the check, as the drop of a deep owned message is the application's own recursion. The
public walks are bounded alike: the C# side's `ProtoRequired.Check` refuses past the bound with the
same `FormatException`, its `UnsetOf` internal; the Rust side's `check_required` with the same
`CodecRefusal`, its `unset_of`, `Unset`, `UnsetStep` and `Place` the crate's own, which only its
tests call; the TypeScript side exports no required walk. Every path that writes a `proto` value
an application gives goes through the codec's write: the typed and dynamic codecs and the generated
bindings. The HTTP gateway writes the request its JSON reader built, which that reader refuses past
the bound, counting as the wire nests, and which holds no unknown field, so its library writes it
directly. On the Rust side the pass rides in the required walk, which carries the depth, and guards
the walk itself; Buffa's own writer needs no guard.

A reading's required walk judges no depth: the records check held the wire to the bound before the
library read it. Each library gives a map's entry that held no value its value's default, a message
one deeper than the wire nests, so an entry 100 deep below the top one that holds no value reads,
and the message read is refused when written back, as each library writes the value it gave. The
`protobuf-conformance` differential found it, and every side holds it alike:
`reads a map’s entry 100 deep that holds no value, and refuses to write the value its library gives it`.

**A `proto` codec's refusal says its reason**, `not its message`, `nested past 100` or
`a required field unset`, in 17.2's words, as
[0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md) has every built-in codec's: its
library's own words, which differ by library and version, the record the check refused and the
required field's full name and path ride in the refusal's cause, for what the side reports, never
on the wire.

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
  map<string, uint32> tallies = 16;
}
```

Its first three fields are the ones the rows below read, beside fields it does not declare; 10 to
13, a packed record, a repeated fixed32, a map's entries and a group, are
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s;
7, 8 and 14, a message of fields protobuf requires, alone and repeated, and a closed enum, are
[0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)'s;
16, a map of scalars whose entry counts as a message, is this record's, for 17.9.3's bound read and
written; and implicit presence keeps `text` and `number` as proto3 reads them. A `proto` payload row pins an
outcome: taken, with the fields read (`read`: its `text` as UTF-16 code units, its `number`, how
deep messages nest below the top, and, where it holds them, its `counts`, its `stamps`, its
`children`, its `delimited` and its `shade`), or refused, with its reason. A `proto` value row pins written bytes
only where protobuf fixes them, one field at a time or a chain of `Probe`s nested to the bound, or
its refusal. The schema's `encoding` takes `proto`; its reasons `not its message` (17.9.1),
`nested past 100` (17.9.3) and `a required field unset` (17.9.7), derived by the regeneration and
checked by every harness as its refusal's words, as 0016's are. `make_codecs.py` reads each row's
bytes with a reader of `Probe` written with the standard library from protobuf's Encoding guide,
and Bead's 17.9.2 to 17.9.8. The rows, those
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)
states aside:

| Row                                                               | Bytes                                | Outcome                        | `differs`  |
| ----------------------------------------------------------------- | ------------------------------------ | ------------------------------ | ---------- |
| an empty payload                                                  | none                                 | taken: no field set            |            |
| a string and a number                                             | `0A 01 61 10 07`                     | taken: `a`, 7                  |            |
| a length past the bytes                                           | `0A 05 61 62`                        | refused: not its message       |            |
| a varint cut short                                                | `10 80`                              | refused: not its message       |            |
| a tag alone                                                       | `0A`                                 | refused: not its message       |            |
| a string that is not UTF-8                                        | `0A 01 FF`                           | refused: not its message       |            |
| an overlong form in a string                                      | `0A 02 C0 AF`                        | refused: not its message       |            |
| a surrogate in UTF-8                                              | `0A 03 ED A0 80`                     | refused: not its message       |            |
| a string's leading U+FEFF                                         | `0A 04 EF BB BF 61`                  | taken: U+FEFF `a`              | TypeScript |
| U+FEFF after a string's first character                           | `0A 04 61 EF BB BF`                  | taken: `a` U+FEFF              |            |
| a noncharacter, U+FFFF                                            | `0A 03 EF BF BF`                     | taken: U+FFFF                  |            |
| U+0000                                                            | `0A 01 00`                           | taken: U+0000                  |            |
| an unknown field after the known                                  | `0A 01 61 78 07`                     | taken: `a`                     |            |
| an unknown field before the known                                 | `78 07 0A 01 61`                     | taken: `a`                     |            |
| an unknown field of each wire type                                | `21 01 … 08 2A 01 7A 35 01 02 03 04` | taken: no field set            |            |
| a number given at its default                                     | `10 00`                              | taken: 0                       |            |
| a scalar given twice                                              | `10 01 10 02`                        | taken: 2                       |            |
| a message given twice                                             | `1A 02 1A 00 1A 02 10 01`            | taken: merged, 2 below the top |            |
| a message field set to the empty message                          | `1A 00`                              | taken: a child, no field set   |            |
| field number 0                                                    | `00 01`                              | refused: not its message       |            |
| a varint of 10 bytes                                              | `10 FF FF FF FF FF FF FF FF FF 01`   | taken: 4294967295              |            |
| a varint of 11 bytes                                              | `10 80 … 80 01`                      | refused: not its message       |            |
| an end group no group opened                                      | `24`                                 | refused: not its message       |            |
| an unknown group, closed                                          | `23 24`                              | taken: no field set            |            |
| an unknown group never closed                                     | `23`                                 | refused: not its message       |            |
| 99 messages below the top                                         | `1A E6 01 …`                         | taken: 99 below                |            |
| 100 messages below the top                                        | `1A E9 01 …`                         | taken: 100 below               |            |
| 101 messages below the top                                        | `1A EC 01 …`                         | refused: nested past 100       |            |
| 100 groups below the top                                          | `6B 6B … 6C 6C`                      | taken: 100 below               |            |
| 101 groups below the top                                          | `6B 6B … 6C 6C`                      | refused: nested past 100       |            |
| 99 messages below the top, the last holding a scalar map's entry  | `1A F2 01 … 82 01 05 0A 01 61 10 01` | taken: 100 below               |            |
| 100 messages below the top, the last holding a scalar map's entry | `1A F5 01 … 82 01 05 0A 01 61 10 01` | refused: nested past 100       |            |

A message given twice is merged, so its row gives the child of the first copy a child of its own:
a reader that merges reads 2 below the top, and one that keeps the last copy reads 1. Six values,
each one field or none: `text` `a`, written `0A 01 61`; `number` 7, written `10 07`; `number` 0,
written as nothing; no field set, written as nothing; `child` set to the empty message, written
`1A 00`; `text` U+FEFF `a`, written `0A 04 EF BB BF 61`. Then the writer's bound, `probe` given as
a chain of `Probe`s below the top, each with no field set but the one that holds the next, through
`child` (`nested`), through `children`'s entries under the key `""` (`entries`) or through the group
(`delimited`), the deepest holding `tallies {"a": 1}` where it is `tallied`: 100 through `child`,
written as the payload of 100 messages below the top; 101, refused; 51 maps deep, 102 messages
below the top, refused; 100 through the group, written as the payload of 100 groups; 101, refused;
99 through `child` and a scalar map's entry, written as its payload, the entry's key and value each
written; and 100 so, refused, `nested past 100` each. A chain of maps' entries has no written row,
since Google.Protobuf leaves an entry's key out at its default, so those bytes are each library's.
`tallies`, field 16, is the first number no row and no corpus writes as an unknown field, the rows
writing 4, 5, 6, 9 and 15, the differential's corpus 4, 5, 6, 9, 15, 20, 1,000 and 536,870,911.

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
which plays every row but those a `differs` excuses its language from, its refusal's type and words
among them; the generated `Probe` held to its generator by `yarn check`. The writer's bound has its
twins beside each side's codec, one sentence each: 100 written and 101 refused through a child, a
group and a map's entry; a message 101 deep that reaches no required field; a value 10,000 deep
refused before its library writes any of it; 41 messages above 60 unknown groups a reading kept,
their bytes one hex constant on every side; `spec/transcoding.proto`'s `Edges.extra`, a JSON object
33 deep written and 34 refused; a `google.protobuf.Value`, 50 lists written and 51 refused; and
the pass skipped where a message's fields cannot nest past the bound. The C# and Rust sides' public
required walks have a twin each, bounded.

## Consequences

**The tests of every side depend on a protobuf library**: on the TypeScript and C# sides each its
platform's stock one, and on the Rust side Buffa 0.9.2, which meets the five criteria
[0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md) holds a library
to. The TypeScript side's lockfile holds `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and
`@bufbuild/buf`, which carries a binary per platform and runs under the repository's Yarn with its
build scripts disabled, and `yarn check` runs it; the C# test project references Google.Protobuf and
Grpc.Tools, which carries protoc; the Rust side's `bead-protobuf` generates its tests' messages as
it builds, by Buffa's generator, from the set protoc writes at its pin, that set committed and held
to what protoc writes by `implementations/rust/tools/check-protobuf.mjs`. `Bead.Core` references no
protobuf library, the TypeScript side takes `@bufbuild/protobuf` as an optional peer, for its
`./proto` entry alone
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)),
and the Rust side's core, `bead`, depends on none, `bead-protobuf` holding the `proto` codec apart
from it: a user of `raw`, `text` or `json` carries none.

**A `proto` row tests a library's locked version through Bead's generated calls.** A library
upgrade that changes a pinned outcome fails the rows with nothing of Bead's changed, and is then
read: a library that moved against protobuf, or a row that pinned more than protobuf says. The rows
pin no whole message's bytes, so a library's order of fields is never one of them.

**A C# read of a `proto` payload costs a copy** of its bytes after their length, and a stream
around them, for the bound to be Bead's rather than the library's.

**The Rust side** plays the `proto` rows through Buffa
([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)) and the code
its generator writes, sets the bound in Buffa, `DecodeOptions::with_recursion_limit(100)`, and finds
its own outcome for the platform row, none, since a Rust `String` holds no surrogate alone; **each
language after it** plays them through its own library and its target's calls, sets the bound in its
library, and finds its own outcome for the platform row.

**The matrix's `proto` rows.** The feature "Payloads" counts `proto`; the open row "A string's
leading U+FEFF in a proto payload" holds the one `differs` of these rows, the TypeScript side's; the
platform row "A proto string no string holds, given to a writer" says what each library writes; and
[0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s
rows say where the libraries read or write apart, in "Leveled down" and as platform rows.

## The Tenth Man

The `proto` encoding met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in two rounds, each at xhigh
effort, each claim verified before its answer. The first was the round on the service layer's
draft, which
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md#the-tenth-man)
keeps, and the user chose where it asked, each way as the revised draft recommended; its rows on
`proto` are kept here. The second met a writer's depth, with the parcel reader and the `proto`
codecs fuzzed on every side, which [0006](0006-a-rule-has-its-gate.md#the-tenth-man) keeps, and a
codec's refusal said in its reason, which
[0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md#the-tenth-man) keeps: one
dissenter, eleven objections, ten accepted, one in part, none refused; its rows on a writer's depth
are kept here. Their objections, each with the answer that holds:

### On the service layer's draft

| Objection                                                                                                                                                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The draft's section on `proto` restates protobuf's binary format and gets it wrong three times: a field of explicit presence is written at its default, a packed field arrives at another wire type and is still the field, and the order of fields written is an implementation detail | Accepted: verified on protobuf.dev ("Explicitly set values are always serialized, including default values"; "parse repeated fields that were compiled as `packed` as if they were not packed, and vice versa"; "Do not assume the byte output of a serialized message is stable") and on both libraries (`1A 00` written as read). 17.9 names protobuf's format and restates none of it; it states four things of Bead's. A row pins taken or refused, and the fields read; a value row pins bytes one field at a time. `1A 00` joins the rows and the values                                                                                                                                                                                                                                                                                            |
| The draft turns two behaviours of Google.Protobuf into Bead's MUSTs, the nesting count and a known field at another wire type, excuses protobuf-es by `differs`, and tests a library version Bead does not ship; its probe ran under npm, not the repository's Yarn                     | Accepted: the bound is Bead's, 0016's reason, 100 below the top, set explicitly on both sides — `recursionLimit: 101`, and `CreateWithLimits(…, 101)` over the payload framed as a field, both probed to take 100 and refuse 101; protobuf's C++ default read at its source, protobuf-go's 10,000 noted. A known field at another wire type is a leveling of [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s, every side refusing it. The leading U+FEFF stays Bead's, 17.4.2's reason, its `differs` crossing an open row that says protobuf-es strips it, its only lever global and deprecated. What a side conforms to for `proto` is its target's calls over its locked library, said in the Consequences. buf from npm ran under Yarn 4.18.1, node-modules linker, and generated the same file |
| The draft's clause on a writer makes the writer's U+FFFD a MUST, false of protobuf-go, which refuses, and a third behaviour beside 0016's refusal                                                                                                                                       | Accepted: the clause goes. A writer refuses or repairs as its library does; a platform row says both stock libraries write U+FFFD, each side's test pinning it, no bytes in the file. Verified: golang/protobuf issue 1228; "A string must always contain UTF-8 encoded or 7-bit ASCII text" (protobuf.dev, proto 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### On a writer's depth

| Objection                                                                                                                                                                                                                                                                                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A walk of the schema's known fields, skipped by a flag of the descriptor, cannot keep 17.9.3's writer sentence: kept unknown groups (17.9.5) and delimited extensions nest on the wire, the reader counts them, and 60 of them under 41 known levels are written and refused on reading on every side | Accepted. Probed on every side: 239 bytes written, refused on reading; protobuf-es's writer skips an extension's message. The writer runs the reader's own records check over its bytes and refuses with its writer's refusal, 17.2's judgment for every rule, at 0028's cost a read. The bounded pass stays, for one job: no recursion reached; its flag is sound for that job alone. A twin on every side holds 40 written and 41 refused, the groups' bytes one hex constant. A conformance row reading bytes before it builds its value is not taken: it would be the one value form of its kind, and the twin holds the same case on every side |
| A pass by field names misses a `Struct` held as a JSON object on the TypeScript side, three messages a level, and a oneof's `{ case, value }`; every map's entry counts, a scalar map's too; no row goes through the group                                                                            | Accepted. Probed: a JSON object 34 deep in a `Struct` is refused on reading, inside `json`'s 64, and a `Value` 51 lists deep. The pass counts as the wire nests: the gateway's count of a `Struct` in one module both use, a oneof through the required walk's accessor, every entry one; the check over the bytes catches what it may still count short. Twins on every side: `Edges.extra` and `Value`. Rows: the group's chain, 100 written and 101 refused, and a scalar map's entry at the bound, for which `Probe` gains `tallies`                                                                                                             |
| The C# side's public `ProtoRequired.Check` stays unbounded and overflows near 2,500 levels, as Google.Protobuf's `CalculateSize` does; the Rust side's `unset_of` need not become a `Result`; the CHANGELOG claims more than holds                                                                    | Accepted. Probed: `ProtoRequired.Check` public and its walk internal, `unset_of` called by tests alone. `ProtoRequired.Check` refuses past the bound with the same `FormatException`, a twin beside it; `unset_of`, `Unset`, `UnsetStep` and `Place` become the crate's own; the CHANGELOG says the codec's write no longer overflows; the Context states about 2,500 levels for the C# side                                                                                                                                                                                                                                                         |
| Both spec changes are minors by 0008, not patches, and "before its library writes any of it" states a mechanism no peer observes                                                                                                                                                                      | Accepted. 0008's axis 2 counts a property added to a schema and an expectation changed; both are minors, which the round already owes. 17.9.3's sentence ends "A writer MUST refuse a value so nested (section 17.2)", the mechanism kept here                                                                                                                                                                                                                                                                                                                                                                                                       |
