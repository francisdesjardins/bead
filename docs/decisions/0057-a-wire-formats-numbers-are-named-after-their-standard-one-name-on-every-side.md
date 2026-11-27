# 0057 — A wire format's numbers are named after their standard, one name on every side

- **Status**: accepted
- **Scope**: every side's code that reads or writes a wire format's header by hand, in the modules
  [`tools/wire-names.tsv`](../../tools/wire-names.tsv) lists, and the gates that hold them. One
  word, one meaning stays [0003](0003-one-word-one-meaning.md)'s; one behaviour in every language
  [0004](0004-one-behaviour-in-every-language.md)'s; each language's toolchain
  [0005](0005-a-toolchain-per-language.md)'s; the gates' table [0006](0006-a-rule-has-its-gate.md)'s;
  the public names and their table, `tools/names.tsv`,
  [0047](0047-every-side-shows-one-public-surface.md)'s.

## Context

Bead's sides read and write several formats' headers by hand: a WebSocket frame's head, an MQTT 5
fixed header and its Variable Byte Integer, an AMQP 1.0 message's sections, a protobuf record's
tag and varint, UTF-8's and UTF-16's units, and JSON's characters. Each number of those headers is
one a standard defines. Written bare, it reads as a value and not as a meaning: `0x80` is nine
different things across these formats, and `126` and `0x7E` are one. Three sides that each name a
concept in their own words make two readers disagree without either being wrong, which
[0003](0003-one-word-one-meaning.md) refuses.

A gate on notation alone, one file at a time, misses both: a decimal spelling passes it, and it
cannot see two sides naming one concept differently. A gate that reads every source turns a rule
about standards into a ban on hex in library code.

The options weighed, and not taken: one root script reading the three languages by a hand-written
lexer, which a regex holding a bracket or a quote leaves blind for the rest of a file, when each
side already has a parser; reading every source with a list of allowed functions, which blesses
what it lists by name and reads what the gate does not own; a notation rule alone; the test kits
named after the codecs, or one module they share, which carries a wrong value into codec and
oracle alike; Table 1-1's widths written as `DIGIT_RADIX ** n`, which C# cannot write; names of
the Rust side's own for the reserved opcodes; a name for each key of MQTT 5's Tables 2-6 and 3-1,
which would repeat its value; Bead's own names aligned with these; and an exception form
for the notation rule, which neither the parameter rule nor any side's parser holds alike.

## Decision

### What the names reach

**Every number one of these standards defines is a named constant on every side that reads it**:
a bit, a mask, a field's shift, a code of one of its tables, a bound and an escape value, whatever
its notation:

- RFC 6455 [§5.2](https://www.rfc-editor.org/rfc/rfc6455#section-5.2),
  [§5.5](https://www.rfc-editor.org/rfc/rfc6455#section-5.5) and
  [§7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1), with IANA's
  [WebSocket Close Code Number Registry](https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number)
  for 1013;
- [OASIS MQTT 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) §1.5.5, §2.1,
  §2.4 and §3;
- [OASIS AMQP 1.0](https://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-overview-v1.0-os.html)
  Part 1 §1.2 and §1.6, and Part 3 §3.2;
- the [Protocol Buffers encoding](https://protobuf.dev/programming-guides/encoding/);
- [RFC 3629](https://www.rfc-editor.org/rfc/rfc3629) §3 and §4, and
  [RFC 2781](https://www.rfc-editor.org/rfc/rfc2781) §2.1 and §2.2;
- [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) §2, §7 and §8.1.

A number is classed by its meaning, never by its notation or its value. RFC 6455 §7.4.1's close
codes are in. The parcel's CLOSE codes are WebSocket's (spec 15.17), so its 1000, 1001, 1002 and
1009 take the same names; its 4000 and 4001, `LOST` and `UNANSWERED`, stay Bead's own.

**Out**, each outside the record's standards or not a field of a header the sides read:

- HTTP's status codes ([RFC 9110 §15](https://www.rfc-editor.org/rfc/rfc9110#section-15));
- base64's sextets ([RFC 4648 §4](https://www.rfc-editor.org/rfc/rfc4648#section-4)), base16's
  nibbles (§8), a URL host's radixes (the WHATWG URL Standard), a CIDR prefix's mask
  ([RFC 4632](https://www.rfc-editor.org/rfc/rfc4632)) and SEC 1's point prefix, which are
  arithmetic over a standard's alphabet or address;
- Bead's own numbers (spec 3, 15.17), which keep their names in their constants modules; inside a
  module the table lists, a bare one takes a name, since the notation rule reads there;
- the builder, `spec/generators/`, the DevTools extension and the demo;
- the test kits and the fuzz targets, which read and write their own bytes so as to stay
  independent oracles. They print their bytes as the standards print them and cite their tables.
  The one name they take is RFC 6455's masking key, `MASKING_KEY` (`MaskingKey`), and a fuzz
  target that cannot read the core's `pub(crate)` items takes the codec's words for its own
  constants, `LONGEST_HEAD_BYTES` and `LONGEST_CONTROL_PAYLOAD`.

### One name on every side

**A constant is named after the standard's own words, under one name across the three sides**,
each in its language's case: `SCREAMING_SNAKE` on the TypeScript and Rust sides, `PascalCase` on
the C# side. Two renderings are one name when they agree with underscores removed, case ignored, so
`PUBACK` and `PubAck` are one name, and so are `SGROUP` and `SGroup`. A hyphen of the standard's
name becomes an underscore (`str8-utf8`, `STR8_UTF8`), and an abbreviation in a registry's name is
spelled out (IANA's "No Status Rcvd", `NO_STATUS_RECEIVED`), as
[0003](0003-one-word-one-meaning.md) asks. A name's form says what it names:

| Form                               | Name                                                                         | Example                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| a code of a family                 | the standard's name                                                          | `TEXT`, `PUBACK`, `LEN`, `STR8_UTF8`, `MESSAGE_TOO_BIG`          |
| one bit                            | its field, then `_FLAG` where the standard calls it a flag, `_BIT` otherwise | `FIN_BIT`, `MASK_BIT`, `DUP_FLAG`, `RETAIN_FLAG`, `WILL_FLAG`    |
| a field of several bits            | its field, then `_MASK`                                                      | `OPCODE_MASK`, `RESERVED_MASK`, `DIGIT_MASK`, `WIRE_TYPE_MASK`   |
| a field's position                 | its field, then `_SHIFT`                                                     | `PACKET_TYPE_SHIFT`, `FIELD_NUMBER_SHIFT`, `QOS_SHIFT`           |
| a field's width in bits            | its field, then `_BITS`                                                      | `DIGIT_BITS`                                                     |
| the bits a byte holds under a mask | its kind, then `_PREFIX`                                                     | `CONTINUATION_PREFIX`                                            |
| a range's ends                     | `FIRST_`, `LAST_`                                                            | `FIRST_TWO_BYTE_LEAD`, `LAST_LOW_SURROGATE`, `FIRST_FAILURE`     |
| a bound                            | `LARGEST_` for a value, `LONGEST_` for a length                              | `LONGEST_CONTROL_PAYLOAD`, `LARGEST_SMALLUINT`, `LONGEST_VARINT` |
| a count of bytes                   | `_BYTES`                                                                     | `MASKING_KEY_BYTES`, `LONGEST_HEAD_BYTES`                        |

**One word means one thing.** Protobuf's and MQTT 5's base-128 digit is `DIGIT_*` on both, never
`PAYLOAD_*`, since a payload is Bead's own word; its continuation bit is `CONTINUATION_BIT` on
both. WebSocket's masking key is `MASKING_KEY`, and its Mask field `MASK_BIT`. The C# side takes the
Encoding page's wire types, `Len`, `SGroup` and the others, over Google.Protobuf's
`LengthDelimited`, so that one name holds on every side.

**A family may stand in a holder** where a side already holds one: a TypeScript frozen object, a C#
static class, a Rust module, as `CODE.UINT`, `ACKNOWLEDGEMENT_TYPES.PUBACK`,
`BrokerParcelCodes.NormalClosure` and `codes::NORMAL_CLOSURE`. The name is the member's, and a
holder's name is not held across sides. A name inside a holder of its kind takes no suffix that
repeats the holder: `kinds::FIRST_ADVISORY`, `KINDS.advisory` and `BrokerParcelKinds.FirstAdvisory`.

**A name exists only where its side reads it.** A side that does not read a concept has no constant
for it, and its cell of the table says why: the platform writes it (MQTT.js, MQTTnet, AMQPNetLite),
or names it already, as .NET's `WebSocketCloseStatus` names the close codes the C# side hands its
platform, 1013 aside, which the enum lacks. Each constant carries a doc comment naming its standard
and its section, a private one included, and each is private to its package: module-internal on
the TypeScript side, `internal` on the C# side, `pub(crate)` on the Rust side. No public name moves.

**A form follows its standard's.** A control frame is the opcode's top bit,
`(opcode & CONTROL_BIT) != 0`, as RFC 6455 §5.5 states it, on every side, and an opcode is reserved
when it is none of the six §5.2 defines, each read by its name. Table 1-1's widths stay as
it prints them, `< 128`, `< 16_384` and `< 2_097_152`, citing it. The last place a varint or a tag
reads is `LONGEST_VARINT - 1` or `LONGEST_TAG - 1` on every side. MQTT 5's acknowledgements' tables
are keyed by their types' names, and its Tables 2-6 and 3-1 are a constant table a function reads,
each code beside its name. AMQP 1.0's uint and a parcel's `u16` are written in network byte order
through the platform's byte-order API, a `DataView` on the TypeScript side.

### The modules

**One module per format and package holds a format's names**
([0003](0003-one-word-one-meaning.md); [0005](0005-a-toolchain-per-language.md), never across
packages): the reader's own module where one reads the format, a module of its own where several
do.

| Format        | TypeScript                                | C#                                                                                                                     | Rust                                                                        |
| ------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| WebSocket     | `src/transport/shared/websocket-frame.ts` | `Bead.Transport.WebSockets/WebSocketFrame.cs`; the parcel's codes in `Bead.Core/BrokerParcel.cs`'s `BrokerParcelCodes` | `bead/src/websocket_frame.rs`, each item gated by the features that read it |
| MQTT 5        | `src/transport/shared/mqtt-packets.ts`    | `Bead.Transport.Mqtt/MqttPackets.cs`                                                                                   | `bead/src/mqtt/packets.rs`                                                  |
| AMQP 1.0      | `src/transport/shared/amqp-messages.ts`   | `Bead.Transport.Amqp/AmqpMessages.cs`, where it bounds                                                                 | -                                                                           |
| Protobuf      | `src/proto/records.ts`                    | `Bead.Protobuf/ProtoRecords.cs`                                                                                        | `bead-protobuf/src/records.rs`                                              |
| UTF-8, UTF-16 | `src/router/shared/unicode.ts`            | `Bead.Core/EnvelopeCodec.cs`; `Bead.Protobuf/Validators.cs`                                                            | `bead/src/envelope.rs`; `bead-protobuf/src/json_form/text.rs`               |
| JSON          | `src/router/shared/payloads.ts`           | -                                                                                                                      | `bead/src/json.rs`; `bead-protobuf/src/json_form/text.rs`                   |

The table's `@reads` rows list each format's readers beside these modules, and the notation rule
reads them too. The Rust side has no AMQP 1.0 binding, and the C# side reads JSON through
`System.Text.Json`.

### The gates

**`tools/wire-names.tsv` holds one row per concept**: its format, its name, its standard and
section, its value, and its cell on each side, the module that holds the name or `-: ` and why the
side reads no such number. Its head states its form. **`tools/check-wire-names.mjs`** holds the
table to the sources, in the commits job: each name agrees with its concept under the case rule;
each module exists; each name is defined exactly once in its module, by its side's declaration
form, with a literal equal to the row's value; each `-` gives a reason; and no side's column is
empty. It reads definitions alone and fails safe: a name it cannot find, finds twice or finds
holding no literal fails, so nothing it misreads lets a missing name pass. `--self` runs its own
cases.

**The notation rule is held by each side's own parser** ([0005](0005-a-toolchain-per-language.md)),
over every module the table names for that side, holders and readers alike, read from the table:
`bead/wire-literal` in the TypeScript side's oxlint plugin, its cases run by
`tools/check-oxlint-plugin.mjs`; `bead-house` on `syn` on the Rust side; and `WireLiteralTests` on
Roslyn in `Bead.Goldens.Tests` on the C# side. It has two clauses:

1. **A hex or binary integer literal stands only in a definition**, a BigInt's and a suffixed one's
   included. A definition is a TypeScript module-level `const` whose name begins with a capital, a
   frozen object's members among them; a C# `const` or `static readonly` field, an enum member's
   value, or a `static ReadOnlySpan<byte>` property whose getter returns literals; a Rust `const`
   or `static` item at module level, an associated `const` or an enum discriminant, an item under
   `#[cfg(test)]` skipped. No function, lambda or closure stands between the literal and its
   declaration.
2. **Outside a definition, no `&`, `|` or `^`, a compound form included, takes an integer literal
   above 1 as an operand.** A union type or a pattern, `1002 | 1008`, is no expression.

Comments and strings are never code, since each parser reads them as its language does: a regex, a
template's text, a raw or a verbatim string; a template's or an interpolation's hole is code. A
module the table lists that is missing fails the rule, and so does a table that gives a side no
module. **The rule has no exception form**, as the parameter rule has none
([0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md),
[0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)): a number of
no standard that it refuses takes another form, the platform's byte-order API, a constant table, or
a module of its own outside the table.

The C# and Rust sides' tests of the rule are twins by title,
`every_hex_or_binary_literal_of_a_wire_module_stands_in_a_definition` and
`the_wire_literal_rule_refuses_exactly_what_its_cases_mark`, held by `tools/check-twins.mjs`. Each
rule's cases cover a regex holding a bracket, a quote and a backquote followed by a refused
literal, a template hole, a raw string, a verbatim and an interpolated string, a BigInt, a
definition, a frozen object's member, a literal inside an arrow function a capitalized `const`
holds, a `#[cfg(test)]` item, `tag & 7`, `digit | 128`, and a union type or a pattern that is no
expression, and each keeps a floor of marked cases.

### What review holds

A wire format's number written in decimal, or by a shift, where the table names it: no notation
rule sees a decimal, and a shift by a literal stands in Bead's own bounds too. Review refuses an
`oxlint-disable` comment that turns `bead/wire-literal` off.

## Consequences

- **Nothing on the wire changes**, nor any conformance file, generator, public name, row of the
  support matrix or text of the spec. Each rewrite behaves as the code it replaces, held by the
  conformance players, each codec's tests and each side's fuzz targets.
- **The gates read the table's modules and nothing else.** A hex literal outside them is no
  concern of this record, and a module that comes to read a format's names is a row of the table,
  its `@reads` among them, before the rule reaches it.
- **A side that comes to read a concept its cell marks `-`** writes its module in the cell, and the
  check then holds the name; a `-` whose reason no longer holds is review's to find.
- **The test kits and fuzz targets keep their own bytes**, so a value a codec names wrongly fails
  against an oracle that does not share it.
- **Its gates**: `tools/check-wire-names.mjs` and its tests in the commits job; `bead/wire-literal`
  in the TypeScript job; `WireLiteralTests` in the C# job; `bead-house` in the Rust job; a change of
  `tools/wire-names.tsv` reaching all four by `tools/ci-scope.mjs`
  ([0006](0006-a-rule-has-its-gate.md)).

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, at xhigh effort. Each claim was checked against develop at `e70af4ac` and against the
dissenter's probes. Each sentence of a standard that a name rests on was read in its published
text: IANA's close-code registry, OASIS MQTT 5.0, RFC 2781 and .NET's `WebSocketCloseStatus` in
the revision, the others by the draft or the dissenter. Eight objections: six accepted,
two in part, none refused. No question went to the user.

| Objection                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The criterion counts a code from a standard's table, but the inventory counts only hex and binary literals: it leaves out RFC 6455 §7.4.1's close codes, which the three sides write three ways (bare on TypeScript, the platform's enum and a bare 1013 on C#, names of its own on Rust), and the parcel's CLOSE codes, which spec 15.17 calls WebSocket's, are bare on C# and named twice in Rust's core. HTTP's statuses are left unsaid, and the draft gives two counts. | **Accepted.** The record states its reach in words, by standard, whatever the notation. The close codes take IANA's names on every side, the parcel's 1000-1009 among them. `LOST` and `UNANSWERED` stay Bead's own. The C# side keeps `WebSocketCloseStatus` where it hands a code to its platform, and names 1013 and the parcel's codes. Rust holds one definition per crate, in an ungated module, its transport-only codes gated by `websocket`. The TypeScript meter's verdict type reads the names. HTTP's statuses (RFC 9110 §15) are out, said so: they are not among the record's standards. The count is 336, 200 of them in the gate's modules.                                                                                                                                                                                                                                                                                                                                                                                                             |
| The gate is called sound, but its cases hold no regex, template hole, raw string or BigInt. A regex holding a bracket or a quote leaves the rest of a file unread at five places on develop, which is 0006's worst failure. Each side has a real parser.                                                                                                                                                                                                                     | **Accepted.** The notation rule is held by each side's parser: `bead/wire-literal` in the oxlint plugin, `wire_literals_of` in `bead-house` on `syn`, and `WireLiteralTests` on Roslyn in `Bead.Goldens.Tests`. Each takes its modules from the table, fails on a module missing or a column empty, and has the cases named (regex, template hole, raw, verbatim and interpolated strings, BigInt) with a floor. The C# and Rust tests are twins by title. The root script that stays, `check-wire-names.mjs`, reads definition lines alone and fails safe: a name it cannot find is a failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A gate on notation, one file at a time, passes decimal spellings of the same masks and cannot see two sides naming a concept differently. The draft's own lists differ: the varint's last byte, the Variable Byte Integer's four bytes on Rust, the surrogates' end, Rust-only range names, and the acknowledgement types frozen on one side and flat on another.                                                                                                            | **Accepted.** `tools/wire-names.tsv` holds one row per concept: its standard, its value, and its name and module on each side, or `-` with a reason. `check-wire-names.mjs` holds each module to each name and value, and the notation rule's modules come from it. The five differences are aligned: `LONGEST_VARINT` and `LONGEST_TAG` on every side; `LONGEST_VARIABLE_BYTE_INTEGER` on Rust; `LAST_LOW_SURROGATE` for the surrogates' end everywhere; no range names; a family in a holder as an allowed rendering, its members' names held. 0006's row says what the gates hold, and a decimal used for a name is among its review rows. Rule 2 stays, on `&`, `\|` and `^`, which the parsers tell from a union type or a pattern.                                                                                                                                                                                                                                                                                                                                |
| Reading every source turns a rule about standards into a ban on hex in library code. It buys one standard's number for about fifteen functions `ALLOWED` in a root tool, calls base64, base16, URL hosts and CIDR "arithmetic" against its own test, and reads what its precedent does not read.                                                                                                                                                                             | **Accepted.** The rules read the table's modules and nothing else. The record names base64 (RFC 4648), base16, the URL host (WHATWG URL), CIDR (RFC 4632) and SEC 1 as outside its reach. The duplicated base64 codecs are a note for the plan. The TypeScript `unicode.ts` stands, one module per package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The kits carry 89 rows and are held to more than the tests they serve. Naming their bytes copies the codec's names without making the oracle more independent: a value copied under the same name is wrong on both ends.                                                                                                                                                                                                                                                     | **Accepted.** The kits and fuzz targets are outside the gate, as the tests are. They keep their scripted bytes and tables as the standards print them, with a citation. The record makes no claim about their names, but for the masking key, which takes RFC 6455's word on every side (`MASKING_KEY`, `MaskingKey`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Three rewrites serve the gate, not a meaning: Table 1-1's widths, written alike on all three sides, as `DIGIT_RADIX ** n`, which C# cannot write; the AMQP byte splits; and Rust's four reserved-range names.                                                                                                                                                                                                                                                                | **In part.** Table 1-1's widths stay as it prints them, citing it. Every side reads the six opcodes RFC 6455 §5.2 defines by their names, with no reserved-range names. The parcel's `u16` goes through a `DataView`. The AMQP byte splits do not stay `ALLOWED`. The native rules have no exception form, as the parameter rule has none, and AMQP 1.0's uint is in network byte order, which one helper writes through a `DataView`, the platform's byte-order API. For the same reason, three more rewrites take the place of the draft's `ALLOWED`: Table 2-6's names (`reason_name_of`) and Table 3-1's (`ConnAckNameOf`) become a `const` and a `static readonly` table, which the rule reads as definitions, and the TypeScript base64 helpers leave `json-form.ts` for `transcoding/base64.ts`, as the Rust side holds `json_form/base64.rs`. Each rewrite is named in the design with the tests that hold it. The control-bit test, the varint's continuation bit, the acknowledgement tables keyed by type and the field bounds as their type's largest stay. |
| Keeping `OPCODE_MASK` and `LONGEST_CONTROL_PAYLOAD` twice in Rust's core, to spare an `expect(dead_code)`, is a false choice: the crate gates items one by one inside shared modules without one.                                                                                                                                                                                                                                                                            | **Accepted, its gating carried further by the first objection.** One module, `bead/src/websocket_frame.rs`, holds RFC 6455's names. It is declared with no feature, since the parcel's codes it holds are read by `broker`, which has none. Each item is gated by the features that read it: `any(websocket, mqtt)` for what MQTT over WebSocket reads, `websocket` for the meter's and the transport's, none for the parcel's. Every lint run CLAUDE.md lists holds it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Several names give a word Bead uses a second job, against 0003, or paraphrase the standard: `PAYLOAD_MASK` beside Bead's payload, and `DATA_MASK` beside `DIGIT_RADIX`; `DUP_BIT` and `RETAIN_BIT` for what the standard calls flags; the masking key named `MASK`; 126 and 127 against the figure's "Extended payload length"; `kinds::FIRST_ADVISORY_KIND` stuttering; the fuzz files' second names; C#'s wire types said to be Google.Protobuf's.                         | **In part.** `DIGIT_MASK`, `CONTINUATION_BIT` and `DIGIT_RADIX` on MQTT and protobuf, the last where a side reads it, since a constant nothing reads is dead code on two sides. The reason is 0003, not the Encoding page, which writes "payload". `DUP_FLAG` and `RETAIN_FLAG` are adopted; `WILL_RETAIN_BIT` and `CLEAN_START_BIT` stay. `MASKING_KEY`, `EXTENDED_LENGTH_16` and `EXTENDED_LENGTH_64` are adopted. A name in a holder of its kind takes no suffix that repeats it: `kinds::FIRST_ADVISORY` and `KINDS.advisory` keep theirs, and C#'s new name is `BrokerParcelKinds.FirstAdvisory`. The fuzz test and target cannot read a `pub(crate)` item, so they take the codec's words, `LONGEST_HEAD_BYTES` and `LONGEST_CONTROL_PAYLOAD`, as their own constants. C#'s names are corrected: Google.Protobuf writes `LengthDelimited`, `TagTypeBits` and `TagTypeMask`, and the C# side takes the Encoding page's names instead.                                                                                                                              |
