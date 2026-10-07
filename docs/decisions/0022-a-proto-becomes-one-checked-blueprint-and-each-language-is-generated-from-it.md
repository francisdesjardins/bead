# 0022 — A `.proto` becomes one checked blueprint, and each language's server and client are generated from it alone

- **Status**: accepted
- **Scope**: the builder, `beadc`, in `builder/`: its input, its front end, `bead/options.proto`,
  its rules, `beadc check` and `beadc breaking`, its targets, its CLI, its image and its wrappers;
  the format of its blueprint, `bead-blueprint/1`, and its schema,
  `spec/schemas/bead-blueprint.schema.json`; the interop's API, `spec/interop-blueprint.json` and its
  schema, and what `spec/interop-service.json` states of the same procedures; the generators that
  read them and `spec/check.py`; both sides' interop, generated, and the handlers written beside it;
  `examples/hello`; the CI's `builder` job. The identity rules a blueprint is held to are
  [0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)'s, and the layer the
  generated code stands on is
  [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s;
  the files of `spec/` read whole are [0004](0004-one-behaviour-in-every-language.md)'s, the
  builder's place among the toolchains [0005](0005-a-toolchain-per-language.md)'s, its gates
  [0006](0006-a-rule-has-its-gate.md)'s, its names and its options' number
  [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)'s

## Context

A service is declared once and served and called in every language: a server where only resolvers
are written, a client that matches it, both over the layer
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)
gives each runtime, over any transport, a broker's among them
([0021](0021-a-broker-is-a-transport-and-bead-is-never-a-network.md)). A declaration written
apart in each language drifts as copies do ([0004](0004-one-behaviour-in-every-language.md)); one
written in a language of Bead's own costs every user a grammar. Protobuf's is the one most of them
know, and its tools compile a `.proto` to descriptors, `google.protobuf.FileDescriptorSet`, and
hand a generator a `CodeGeneratorRequest` (`google/protobuf/compiler/plugin.proto`): the stock
generators of each language read the same.

**What the compilers do, measured.** protoc 36.2, protoc 35.1 and buf 1.73.0 give the same services,
methods, types, options and enum values from the same files, on Windows and Linux, in every line
ending. They part on comments and positions: a block comment before a declaration on its own line
is its leading comment in protoc and nothing in buf; protoc on Windows reads a file in text mode and
drops a carriage return (`compiler/importer.cc`:581 at v36.2), where buf and protoc on Linux keep
it; a tab is 8 columns in protoc and 4 in buf, a column a byte in protoc and a terminal cell in buf.
protoc keeps the last of two members of a `oneof` set by two option statements, and drops the first
from the bytes in silence (`descriptor.cc`:9565-9581 at v35.1), where buf refuses every such form
(protocompile's `experimental/ir/lower_options.go`:631-638). protoc reads the first of two copies of
an imported file across its roots, and buf refuses the build. protoc writes a language's code from a
set it did not parse, `--descriptor_set_in`, as it writes it from the `.proto`, the embedded
descriptor aside, which then carries `json_name`. buf 1.73.0 compiles through protocompile's
`experimental` packages at an untagged commit (buf's `go.mod`:22,
`v0.14.2-0.20260910151042-7436f7c76201`), so how it attaches a comment is a version's, not a
standard's.

**What a generator must not do again.** A generator that parses a `.proto` itself, or names a
message by rules of its own in each language, drifts from the stock generators that write the
messages beside it. protoc-gen-es names a message by rules that depend on every name of its file
(`@bufbuild/protoplugin`'s `names.js`:89-111 at 2.16.0): a nested name taken by a top-level
message, a keyword, a name the runtime reserves.

**Where the options' number comes from.** `descriptor.proto` gives custom options two ways: 50000 to
99999 "within a single application or organization, or for experimental options", where nothing
keeps two organizations apart, and a number of protobuf's global registry for options "published
and used publicly by multiple independent entities" (`descriptor.proto`:422-432 at v36.2), which
the registry gives on a pull request or an issue naming the project (`docs/options.md` in
protocolbuffers/protobuf). An organization whose own option holds 58500 on `MethodOptions` cannot
compile a file that imports Bead's at the same number: protoc 36.2 exits 1, `Option "(…)" was
already set.`, and buf 1.73.0 exits 100, `field number 58500 used more than once`.

**Where it reaches.** The constrained C side reads tables generated from a declaration, never a
`.proto` (0017's "a side that keeps no names"). HTTP/JSON transcoding writes one OpenAPI document
for every language from the same declaration, and the validation of payloads carries protovalidate's
rules through it: each joins as a feature a reader must know.

### The options weighed

- **A protoc plugin per language**, each with its own front end: the front end written once per
  language, and two languages' readings of one option to keep alike.
- **A front end in C# over Google.Protobuf's descriptors, or in Go over `protogen`**: a toolchain the
  TypeScript side does not have, for the tool both sides use.
- **A front end over protobufjs's parser**, which does not follow protoc's grammar.
- **One front end, TypeScript on Node, over `@bufbuild/protobuf`'s descriptors, writing one blueprint
  every target reads. Chosen.** Node is every contributor's already, for the TypeScript side and the
  root's tools; `@bufbuild/protobuf` reads a set and its options; `@bufbuild/protoplugin` names a
  message as protoc-gen-es does.

Which compiler:

- protoc in the image and buf from npm on Node, a test holding the two to one blueprint: the test
  fails on a same-line block comment, which no rule recovers, and the two paths differ on columns,
  on a copy of `bead/options.proto` and on a `oneof` set twice.
- protoc alone: no binary on npm for every platform, so the repository's own work needs Docker.
- buf alone, and a set another compiler built taken whole: the second compiler comes back as an
  input, with its descriptions, its columns and its `oneof` set twice.
- **buf alone, from the same lockfile on every path, and no set another compiler built; protoc
  writing C# messages from buf's set. Chosen.** One compiler gives one blueprint, one column and one
  refusal wherever beadc runs.

How a procedure's kind and an admission are written in `bead/options.proto`:

- Plain fields, one each held by a rule of `check`: what a set from protoc needs, which beadc does
  not read; a protobuf tool reading the options then sees two optional messages, and a comment says
  the rest.
- **A `oneof`, as `google.api.HttpRule` writes its `pattern` (`google/api/http.proto`:317-338 at
  googleapis `794ca79`). Chosen**: buf refuses a second member in every form, a literal, two
  statements, a literal and a statement, and says "one of" to every protobuf tool that reads the
  file.

How the interop's API is written:

- `interop.proto` alone, beadc writing the blueprint into `spec/`: the spec's input written by the
  product's tool, against [0005](0005-a-toolchain-per-language.md)'s generators of the standard
  library.
- **The blueprint written by hand in `spec/`, `interop.proto` a fixture of the front end whose
  blueprint gives it. Chosen**: the spec keeps its layering, and the interop proves the targets on
  the bytes the conversations play.

Where the format's schema lives:

- In `builder/`, the interop's file referring to it: `spec/check.py`'s rule of one schema a file in
  `spec/schemas/` crossed, and the spec's input held by a schema outside it.
- **In `spec/schemas/`, the format speaking no language. Chosen**: no file option, no rpc name, no
  message a native binding implies; what a front end read of a `.proto` in members a blueprint
  written by hand leaves out. A language that joins changes no schema of the spec's.

## Decision

**beadc compiles with buf, and every decision of Bead's comes from one blueprint.** It compiles a
project's `.proto` roots with buf, `--as-file-descriptor-set`, its imports and source info included,
its own `bead/options.proto` first among the roots, and takes no set another tool built; a blueprint
is taken alone when every binding is native. The front end resolves the set into a blueprint,
`bead-blueprint/1`, and checks it; every target reads its decisions from the blueprint alone, and an
official target reads the set besides for the names of the messages it imports and their files'
options. protoc writes a C# message from buf's set alone, `--descriptor_set_in`, and compiles no
`.proto`.

**A comment becomes a description by one rule.** The leading comment of a service, an rpc or a
failure's value: each line's text after its marker, one space taken off, its end trimmed, carriage
returns read as line feeds; a paragraph's lines joined by one space, paragraphs by a blank line.
Trailing and detached comments are no description, and a comment kept out is written detached. A
target writes a description as its language's documentation escapes it, whatever it holds: the
TypeScript target through protoplugin's `f.jsDoc`, a line a line and `*/` written `*\/`; the C#
target one `///` a line, `&`, `<` and `>` escaped as XML, a paragraph a `<para>`.

**`bead/options.proto` is the builder's contract.** Package `bead`, C# namespace `Bead.Protobuf`,
one extension on each of `FileOptions`, `ServiceOptions` and `MethodOptions`, at the one number
protobuf's global registry gives the project
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)). `(bead.file)` holds a
file's default admission and its package's retired services; `(bead.service)` a service's id, its
revision, its default admission, its failures' enum, its deprecation's message and its
reservations; `(bead.procedure)` a procedure's id, its kind, its admission, its payload's limit, its
deprecation's message and the failures it lists. A procedure's kind is `oneof procedure_kind`,
`notifies` or `command`, neither meaning a plain request; protobuf-es writes its local name
`procedureKind`, the blueprint's and the runtime's word
([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)).
An admission is `oneof rule`, `none`, `session` or `hook`, and one that states none is refused
(`ADMISSION_EMPTY`). `bead.Raw`, `bead.Text` and `bead.Json` are the payload types whose bytes are
the payload itself, `raw`, `text` and `json`; any other message is `proto` (spec 17). A payload's
encoding is its message's, and no option names one.

**The blueprint is the runtime's words, resolved, in no language's.** A service's `serviceName`,
`serviceId`, `serviceRevision`, description, deprecation, failures by code and reservations; each
procedure's `procedureId`, `procedureName`, `procedureKind`, its `request` and `result` bindings, a
`notification` binding exactly when it notifies, its `admission` as
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s
`AdmissionRule` writes it, the failures it lists, its `maximumPayloadBytes` and its deprecation when
it has them. A binding is its encoding, and for `proto` alone its message's full name. What a front
end read of a `.proto` — its files and packages, the messages a `proto` binding names, a service's
file and full name — sits in `proto` members, which a blueprint written by hand leaves out. No
language's option and no rpc's name: a C# namespace is the set's `csharp_namespace`, or, for a
blueprint alone, the output's `namespace` in `beadc.yaml`, and an rpc's name is its procedure's with
the first letter raised. No default and no inheritance: a file's and a service's admission is
resolved into each procedure. Nothing of configuration: no credential, no window, no limit of a
router's, no topic. `format` names the major, which a reader refuses when it does not know it;
`requires` lists the features a blueprint uses beyond its major, which a reader refuses when it does
not know one, as JOSE's `crit` does
([RFC 7515 §4.1.11](https://www.rfc-editor.org/rfc/rfc7515#section-4.1.11)); removing a member, or
changing its meaning, makes `/2`. `specVersion` names the version of `spec/spec.md` whose sections
16 and 17 its producer follows. Its schema, `spec/schemas/bead-blueprint.schema.json`, is the format,
a description on every member.

**A blueprint has one form.** Its members sorted as RFC 8785 sorts them, by their names' UTF-16 code
units; its strings escaped as RFC 8785 escapes them
([§3.2.2.2](https://www.rfc-editor.org/rfc/rfc8785#section-3.2.2.2)), never a surrogate alone,
which I-JSON forbids ([RFC 7493 §2.1](https://www.rfc-editor.org/rfc/rfc7493#section-2.1)); its
numbers integers, never with a fraction or an exponent; two spaces of indentation, a final line feed,
UTF-8 without a byte order mark; its arrays sorted by identity: files by path, messages by full name,
services by id, procedures by id, failures by code, a procedure's failures in their codes' order,
ranges ascending, names in their code points' order. beadc writes every blueprint in its form,
and `spec/check.py` holds the interop's to it.

**The unit of generation is the service**, and one blueprint is one id space. A service gives
`<Name>Procedures`, `<Name>Failures`, `<Name>Server` and its `<Name>ServerOptions`, and
`<Name>Client`, its name its `.proto` name with a trailing `Service` taken off; on the C# side, a
procedure that lists failures gives a class of them, nested in `<Name>Failures` under its rpc's
name, and every type that holds a member a procedure or a hook names is a sealed class of `init`
properties, which synthesizes no member. A procedure's name is its rpc's, the first letter lowered
(spec 16.4); a failure's is its enum value's, the enum's prefix taken off. A name that collides with
a member any official target generates, or with the class it sits in, or a class name a message or a
public type of the runtime holds, is refused, never escaped (`NAME_TARGET`): the rule runs on the
blueprint, over every official target, so one blueprint has one verdict whatever targets a project
names.

**A target writes data and types; behaviour is the runtime's.** A generated file holds the
service's descriptors, made by `requestOf` and `commandOf`, `RequestProcedure` and
`CommandProcedure`; its catalogue; and a server class and a client class, each a thin shell over
`createServiceServer` and `createServiceClient`, `ServiceServer<TService, TData>` and
`ServiceClient<TService>`. A server class is offered on one Bead server; it takes the layer's
options always, as one `<Name>ServerOptions`, required when a procedure names a hook and optional
otherwise. A client class holds a requester of each procedure its server answers, under the
procedure's name, its notifications under `notifications`, at the windows its caller gives, unpaced
by default ([0002](0002-a-subscription-goes-at-its-clients-pace.md)), and `on` for the commands it
answers. A file names the contract it needs, `GENERATED_CODE_SUPPORTS_VERSION_1`, and imports
nothing of Bead's but `./service`, from a path relative to its output's folder or a package's name;
the C# it writes qualifies every type as `global::Bead.` and `global::`. The TypeScript target runs
on `@bufbuild/protoplugin`, in beadc's process, its `target=ts`, its header printed rather than
protoplugin's preamble, its imports printed as symbols; a service a `.proto` declares is written at
its file's path, one a blueprint alone declares at the output's root, under its name. The C# target
names a message from its descriptor. Messages are the stock generators' — protoc-gen-es with
`erasable_syntax=true`, run in beadc's process, and protoc's C# generator over buf's set — or
`external`, a project's own generator writing them.

**Generated code passes its language's gates but its formatter.** `*_bead.ts` passes oxlint, its
type-aware half included, and the types, and stays out of oxfmt; the C# passes the build's
analyzers, code style and doc comments, and `dotnet format` leaves its folder out. The C# is marked
generated, `<auto-generated>` and `#nullable enable`, where a consumer's analyzers must not judge
it, and unmarked where Bead's gates judge it; it writes a doc comment on every public member either
way.

**`beadc check` refuses by rule name**, at three levels: on a `.proto` input, on any blueprint, a
hand-written one included, and in each target. A finding prints as
`file:line:column: severity RULE: message`, in text, JSON or GitHub's format, a blueprint's at its
JSON Pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)); a warning is left out by its
name, an error never is. The rules, their levels and their reasons are `builder/README.md`'s, each
with its cases in `builder/`.

**`beadc breaking` compares two blueprints by id**, against the last release
([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)), in two categories,
`WIRE` within `API`: `WIRE`, a peer built from the last release still talks with one built from
this one; `API`, besides, code written against the last release's generated API still compiles and
means the same, and so do the metrics and filters that name a procedure. A hook a service's
procedures name, added or gone, is `API`, since its server's options name each. buf's own rules
compare the messages of the two sets. A finding is waived by its rule's name, where a reviewer reads
it.

**The interop's API is its blueprint, and its behaviour `interop-service.json`'s.**
`spec/interop-blueprint.json` is written by hand, in the blueprint's form, under `specVersion`: the
service's id and revision, and each procedure's id, kind, bindings, admission, failures and one line
of description; `tools/release.mjs` moves its `specVersion` as it moves every conformance file's
that repeats one ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)). Its schema,
`spec/schemas/interop-blueprint.schema.json`, is the format's with `requires` empty and one service:
the generators and both sides' interop read that one service and no feature, and the day one reads a
feature, it lifts the pin.
`spec/interop-service.json` states, for each of those procedures by its name and in
their order, what it takes, what it answers, what it admits where its admission is not `none` and
what it notifies where it notifies, beside its relay and its credentials. `spec/check.py` holds the
blueprint to its schema and its form, and the two files to one list, and `--write-blueprints` lays the
blueprint out in its form, its arrays sorted, which an author edits as they like; it writes nothing
when a string holds a surrogate alone, and it never shortens the file it fails to write. The fixture
`builder/test/fixtures/bead/interop/v1/interop.proto` gives a blueprint whose projection, its `proto`
members left out, is the spec's byte for byte, which beadc's tests hold. Each side's interop code is
generated from the blueprint; the handlers and the credentials are written.

**Where each lives.** The builder in `builder/`, with a toolchain of its own
([0005](0005-a-toolchain-per-language.md)); `bead/options.proto` in `builder/proto/`; the format's
schema and the interop's blueprint in `spec/`; the rules, the name rules of a blueprint that section 16
leaves to the builder, and what each option means, in `builder/README.md`; the repository's own
`beadc.yaml` at the root. beadc ships as an image, `ghcr.io/francisdesjardins/beadc`, for
linux/amd64 and linux/arm64, holding Node, beadc, buf, protoc and `bead/options.proto`, no SDK,
run without a network, through the wrappers `beadc.sh` and `beadc.ps1` a project commits; and runs
from `builder/` on Node, which is how the repository uses it.

**What a peer receives does not change.** No envelope, no code, no conversation: ids travel, names
never; a payload's bytes are its encoding's (spec 17).

## Consequences

**A `.proto` is compiled by buf, whatever compiler its team uses.** buf refuses what protoc lets by:
a member of a `oneof` set twice, a copy of an import in two roots. A team whose build runs protoc
hands beadc its `.proto` roots, never its set; a set taken whole is an addition, under `requires`
if it reaches the blueprint, and a buf image alone.

**A buf upgrade can move a description.** Descriptions are part of a blueprint, and buf attaches a
comment through an `experimental` package; the comments fixture, leading, trailing, detached and
multi-paragraph comments, CRLF and a byte order mark, is beadc's golden test of buf's attachment, so
an upgrade that moves one fails it before a user's blueprint moves.

**Two copies of the options' C#, loaded in one process, clash** through Google.Protobuf's extension
cache, keyed by file name (`FileDescriptor.cs`:529-548 at v3.36.2): two libraries, each built with
generated messages and its own copy, make the second's `GetExtension` over Bead's options throw.
Generated code reads no option at run time, so only a user's own reflection meets it. The way out —
one public copy in a package of its own, `DisableExtensionCaching`, or edition 2024's `import option`
— is decided with the options' freeze.

**The interop is stated in two files and declared in a third.** Its API in the blueprint, its
behaviour in `interop-service.json`, which `check.py` holds to one list of names; the fixture
declares the API again, each description a one-line comment, held equal by beadc's tests. Adding a
procedure is three edits.

**The spec's axis carries the builder's format, and no language's.** Its schema is under
`spec/schemas/`, so a change to the format moves the spec's version as any file's does
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)); a target's option, a C#
namespace or a Go package, is `beadc.yaml`'s or the set's, never the format's.

**A blueprint is laid out by `spec/check.py`, never by the root's formatter.** oxfmt 0.71.0 writes a
short array on one line, where the form writes one member a line, so the root's format step and a
release's leave `spec/interop-blueprint.json` out, and `check.py` holds its form instead.

**A blueprint is refused for a target it does not use.** `NAME_TARGET` reads every official target's
names, so a project that generates TypeScript alone is refused a procedure named `all`, a C#
collision; the names a target reserves are listed in `builder/README.md`, and a target that joins
adds its own to every blueprint's verdict.

**Adding a hook breaks every construction of its server**, as a required option does in any API:
`beadc breaking` names it, and the release says it.

**One toolchain more.** `builder/` has its own lockfile, its own vendored Yarn and its own CI job,
on Linux and Windows; its install fetches buf's binary for its platform, about 105 MiB on Windows.

**`erasable_syntax` is protoc-gen-es's experimental option**, and its output needs
`@bufbuild/protobuf` 2.13.0 or later, which the header names; the image pins protoc-gen-es, and
beadc's golden tests catch a change of it.

**Its gates** ([0006](0006-a-rule-has-its-gate.md)): the `spec` job holds the interop's blueprint to
its schema and its form, and `interop-service.json` to its procedures; the `builder` job runs
beadc's tests on Linux and Windows, `beadc check` over the interop's blueprint, `beadc generate
--check` over the repository, `buf lint` and `buf format` over `builder/proto` and the fixtures, the
image's test stage and the wrappers' tests; each side's job holds its generated code to its gates
and the interop both ways; the `examples` job builds `examples/hello` both ways, its C# messages
generated and external; the `commits` job holds `tools/release.mjs`'s move of its version, through
the root's tools' tests. A gate here that does not run is among 0006's gates owed.

## The Tenth Man

The builder's design met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at xhigh effort, and its
decisions were the user's, each as recommended; its MVP's design met it again before the interop's
API moved into `spec/`, and the interop's blueprint once more as it landed. Each objection, with the
answer that holds:

### On the builder's design

| Objection                                                                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bead's own harness and the blueprint's every decision rebuild the stock generators' naming, the mistake a generator that names messages by its own rules makes | Accepted: every decision of Bead's comes from the blueprint, and an official target reads the descriptor set for the names of the messages it imports. The TypeScript target runs on `@bufbuild/protoplugin`, in beadc's process, and prints protoc-gen-es's own symbols, which name a nested message, a keyword, a name the runtime reserves, two clashes, another package and a well-known type as protoc-gen-es does; the C# target names a message from its descriptor, compiled against Grpc.Tools' output in `examples/hello` |
| `google.protobuf.Value` as a marker contradicts the payload types; use `bead.Json` and drop the encoding axis                                                  | Accepted: `bead.Raw`, `bead.Text` and `bead.Json` are Bead's payload types, and a payload's encoding is its message's; no option names one. `ENCODING_FIT` refuses, in a blueprint written by hand, a `proto` binding to one of them, and `PROCEDURE_SAME_ENCODING` is a `WIRE` rule of `breaking`. Typed JSON comes as an option meaning protobuf's JSON mapping, under `requires`                                                                                                                                                 |
| `window` is configuration, and the runtime silently ignores a second client's window                                                                           | Accepted: no window in the options or the blueprint; the generated client takes one per procedure that notifies, unpaced by default ([0002](0002-a-subscription-goes-at-its-clients-pace.md), spec 11.8), and a notification asked for again at another window is refused on both sides ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md))                                                                                                                                           |
| `none: true` and `session: true` beside empty messages need a rule                                                                                             | Accepted: `none` and `session` are empty messages and `hook` a name, members of `oneof rule`, so no value means two things; an admission that states none of them is `ADMISSION_EMPTY`                                                                                                                                                                                                                                                                                                                                              |
| Failures named in their stripped form cannot be searched                                                                                                       | Accepted: the `.proto` lists each value as its enum writes it; the blueprint and the generated code take the name with the enum's prefix off                                                                                                                                                                                                                                                                                                                                                                                        |
| `ADMISSION_DEFAULT` is satisfied by one line at the file                                                                                                       | Accepted: the rule stays, and guards against forgetting, not against a careless choice                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `type: notification` gives `type` a second meaning and narrows spec 11.2                                                                                       | Accepted: a procedure's kind is `procedureKind`, `request`, `notifies` or `command` ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)); a procedure that notifies has a `notification` binding beside its request and its result; the generated client keeps its requester and adds a member under `notifications`; a router refuses a subscription only to a procedure that does not notify (spec 16.11)                                                                            |
| A public, versioned format with one producer and one consumer; two files that are tests, not conformance                                                       | Accepted: the blueprint's rule cases and the breaking cases are beadc's tests, in `builder/`; `spec/check.py` holds the interop's blueprint to its schema and its form alone; no companion document. Kept: `format`, `requires` and the schema. The identity rules are section 16 ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)), the payload encodings section 17 with `spec/codecs.json` ([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md))                                    |
| The interop's API leaves the spec's axis and [0005](0005-a-toolchain-per-language.md)'s standard-library rule, and spec work needs Docker                      | Accepted: `spec/interop-blueprint.json` is written by hand under `specVersion` and held by `spec/check.py`; `interop.proto` is a fixture whose blueprint beadc's tests hold equal to it; beadc runs from `builder/` on Node, and the spec's work never needs Docker                                                                                                                                                                                                                                                                 |
| `GreeterServer` is no server, and offering one on many servers is speculative                                                                                  | Accepted: a generated server is the server side of a service, offered on one Bead server, a second offer refused; the notify filter takes one subscriber ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)), so a server can join it without a break                                                                                                                                                                                                                                 |
| The failure catalogue's check changes what a caller hears                                                                                                      | Accepted: both languages narrow a resolver's failure at compile time; an unlisted code, which only a TypeScript cast reaches, is sent as written and reported ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)); changing the answer is a decision of its own, with its conversation                                                                                                                                                                                                |
| The generated surface need not inherit the runtime's currying                                                                                                  | Accepted in part: a bound call awaited with its options forgotten is TS1320 under TypeScript 7.0.2, and awaiting a delegate never compiles in C#; a requester awaited with no payload is left to oxlint's `await-thenable`. Refused: another shape for the generated surface; its calls are the runtime's, curried                                                                                                                                                                                                                  |
| The direction's sample is a server per API; the design makes one per service                                                                                   | Refused: a server class per service, as the registry and a debug filter scope names by service ([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)) and a blueprint is one id space ([0017](0017-ids-are-for-life-and-a-procedures-name-takes-one-ascii-form.md)); a package's aggregate of its service classes is an addition, under a name of its own                                                                                                                                                                |
| The JSON form comes after the codec becomes public, and `codecs.json` pins only agreement                                                                      | Accepted: the JSON form is [0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md)'s, `spec/codecs.json` written from section 17's rules, before any generated client sends a byte                                                                                                                                                                                                                                                                                                                                     |
| What Bead answers to a malformed `proto` payload is pinned nowhere                                                                                             | Accepted: section 17.9 and `spec/codecs.json`'s `proto` rows on `spec/codecs.proto`'s `Probe` ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)). Refused: typed JSON in this record; it comes as an addition under `requires`                                                                                                                                                                                                                                                       |
| A request that comes to notify passes under `API`, though every caller stops compiling                                                                         | Accepted: the requester stays and `notifications` gains a member, an addition under both categories                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Tightening an admission breaks a peer by `WIRE`'s definition                                                                                                   | Accepted: `PROCEDURE_ADMISSION_TIGHTENED` is `WIRE`; loosening one breaks nobody; a hook renamed is `PROCEDURE_SAME_HOOK`, `API`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PROCEDURE_SAME_MESSAGES` is too strict and too weak under `WIRE`                                                                                              | Accepted: a message's full name changed is `API`; under `WIRE`, a `proto` binding switched to another message is `PROCEDURE_MESSAGE_SWITCHED`, which says nobody compared the two and names the check to make by hand                                                                                                                                                                                                                                                                                                               |
| A revision's moves are enforced, yet two branches' identical moves merge without a conflict                                                                    | Refused: a revision counts a contract's releases (spec 16.9), and `--against` names the last release, never `develop`: two branches that each move it from 1 to 2 merge into the next release's 2, which is what it counts                                                                                                                                                                                                                                                                                                          |
| Generating the messages makes the image the authority over each consumer's protobuf runtime                                                                    | Accepted: each output says `messages: generate` or `external`; the header names each tool's version and the oldest runtime its output needs; `examples/hello` compiles both                                                                                                                                                                                                                                                                                                                                                         |
| Docker is the only way in, even for the repository's own work, and `--against-ref` writes to `.git`                                                            | Accepted: beadc runs from `builder/` on Node, buf from npm compiling, and CI's Windows job runs that path; the image is the distribution; `--against-ref` reads a ref through `git archive` into a temporary folder                                                                                                                                                                                                                                                                                                                 |
| Targets in TypeScript against [0005](0005-a-toolchain-per-language.md), output held to two formatters byte for byte, a generic layer no conformance holds      | Accepted in part: generated code stays out of the formatters, `**/*_bead.ts` in oxfmt's ignore patterns and `dotnet format --exclude` its folder, and keeps lint, types, analyzers, code style and doc comments; golden tests compile nothing, each language's job compiling its generated code; every peer-visible behaviour of the layer is a conversation already, `denied` and `PROCEDURE_UNKNOWN`. Refused: a target per language in its own language, which the blueprint makes possible later, with no change of its format  |
| The description rule drops a comment opening with `!`, `?` or `TODO`, this repository's convention applied to every user                                       | Accepted: every leading comment is a description; one kept out is written detached                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The equality of two compilers' blueprints was tried on `interop.proto` alone, where comments attach alike                                                      | Accepted: a fixture of leading, trailing, detached and multi-paragraph comments, CRLF and a byte order mark holds the front end. It showed protoc and buf parting on a same-line block comment and on every column, so beadc compiles with buf alone, and the fixture holds one blueprint in every line ending, on Linux and Windows                                                                                                                                                                                                |
| "Nothing changes" holds for the format, not for what a peer receives                                                                                           | Accepted: nothing in the format changes, and each change of what a peer receives was removed or decided apart: an unlisted code sent as written, the requester kept, no window unless asked for, the JSON form first ([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md))                                                                                                                                                                                                                                         |
| Protobuf's global registry assigns extension numbers, not packages, so `bead` is protected by nothing                                                          | Accepted: the options take one number of the registry, which lists the project beside it; the package `bead` stays, as `buf.validate` and `google.api` go by their project's name, `(francisdesjardins.bead.procedure)` on every rpc weighed against it ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md))                                                                                                                                                                                                     |

### On the MVP's design

| Objection                                                                                                                                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The options' number goes public on a range `descriptor.proto` keeps for one organization or for experiments: a public image carries 58500, and an organization whose own option holds it cannot import Bead's                  | Accepted: verified, protoc 36.2 exits 1 and buf 1.73.0 exits 100 on a file importing both. The premise of [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)'s "when its options freeze at v1" was that nothing carrying the number is published; the first image is. The options take the registry's number before the builder's first file writes one, and 0008 says so                                                                                                                                                                                                 |
| _Manifest_ already means a package's file, Chrome's extension manifest, the OCI image manifest and, in the interop's code, `interop-service.json`; [0003](0003-one-word-one-meaning.md) gives none of them to Bead             | Accepted: the builder's file is a _blueprint_, `bead-blueprint/1`, a word none of the platforms the repository touches gives a file of its own, written in one change across the records and the code that use it, before its format's constant is ([0003](0003-one-word-one-meaning.md)); the interop's code calls `interop-service.json` the service's file; a line that means `package.json` alone keeps npm's word, and one that named a version's two files names them; the spec names neither, its sections 16.8 and 16.10 speaking of the definitions a builder generates a side from |
| The spec's file names a C# namespace, the builder's own file and message, and a suffix buf's lint asks for: each language's file option would move a schema of `spec/`                                                         | Accepted: the format speaks no language. No file option, no rpc name, no message a native binding implies; a front end's reading of a `.proto` in optional `proto` members; the C# namespace from the set, or from `beadc.yaml` for a blueprint alone. The fixture's blueprint equals the spec's on its projection, without `proto`                                                                                                                                                                                                                                                          |
| The interop's behaviour moves from members its schema requires into an optional description, set aside by `breaking` and written three times                                                                                   | Accepted: `interop-service.json` keeps `request`, `answers`, `admits` and `notifies`, by procedure name and in the blueprint's order, as its schema requires them; `check.py` holds the names, the admissions and the kinds of the two files to one list; the blueprint keeps one line of description a procedure, and the fixture that line                                                                                                                                                                                                                                                 |
| Generated C# names collide where `NAME_TARGET` does not look: failure classes at the namespace's scope, `All` beside the rpcs, the members a record synthesizes; and the rule's verdict depends on the targets a project names | Accepted, and widened: failure classes nested in `<Name>Failures` under their rpc's names; sealed classes of `init` properties for every type a procedure or a hook names a member of; `NAME_TARGET` on the blueprint, over every official target, refusing besides two failures whose C# names are one (`A_B1`, `A_B_1`), a failure named `CODE` beside a class's `Code`, and a member named as its class. Its cost, a project refused for a target it does not use, is a consequence above                                                                                                 |
| A description reaches generated code unescaped: `*/` ends a TypeScript comment, a second paragraph leaves a C# one                                                                                                             | Accepted: TypeScript through `f.jsDoc`, C# one `///` a line, XML-escaped, a `<para>` a paragraph; the comments fixture and the golden tests hold `*/`, `<`, `&` and two paragraphs on both targets                                                                                                                                                                                                                                                                                                                                                                                           |
| "buf alone" keeps two compilers: a set from protoc taken whole brings back its descriptions, its columns and its `oneof` set twice, and protoc's half of the test stays                                                        | Accepted in part: beadc reads no set another compiler built, and protoc compiles no `.proto` of a project's; the comments fixture is buf's golden test. Refused: protoc out of the `builder` job, since it is the C# generator of messages, whose golden test widens to nested messages, `oneof`, `map` and `optional`, and `examples/hello` builds its C# messages generated as well as external                                                                                                                                                                                            |
| Plain fields and two rules are paid for a protoc input one compiler drops                                                                                                                                                      | Accepted: the `oneof`s stay, `procedure_kind` and `rule`, and [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s reason for `procedureKind` holds; one rule stays, an admission that states none                                                                                                                                                                                                                                                                                                                                              |
| The `runtime` path names another file once protoplugin prints it, which reads a relative import from the output's root                                                                                                         | Accepted: `runtime` is relative to the output's folder, as protoplugin reads it; the repository's generated file is type-checked as committed                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A hook added breaks every server's construction, which the generated constructor's two shapes hide and no rule of `breaking` names                                                                                             | Accepted: the server always takes its options, `<Name>ServerOptions`, so an option the layer gains reaches it; `SERVICE_SAME_HOOKS`, `API`, names a hook added or gone. The break itself stays, as a required option's does                                                                                                                                                                                                                                                                                                                                                                  |
| "One form" admits `1.0` beside `1`; a missing newline is a traceback; the schema fails the root's format step; an identity nothing computes                                                                                    | Accepted: integers alone, `check.py` refusing a fraction or an exponent and naming a missing newline as findings; the schema laid out by oxfmt; the identity left to the feature that reads one                                                                                                                                                                                                                                                                                                                                                                                              |
| The record states as landed what its later branches land, and owes no gate for them                                                                                                                                            | Accepted: the generated interop is a constraint, the builder under "Where Bead goes" until its last part lands, and each gate a later branch lands among 0006's gates owed until it does; the lockfile's sentence states what holds                                                                                                                                                                                                                                                                                                                                                          |
| The admission's shape, a string or an object, is one runtime's                                                                                                                                                                 | Refused: it is JSON's, a string for the two rules that carry nothing and an object for the one that carries a name, which both runtimes' `AdmissionRule` read alike, `None`, `Session`, `Hook(name)`; two members would let a hook stand beside `none`                                                                                                                                                                                                                                                                                                                                       |
| A detail no conversation pins cannot be pinned for one handler alone                                                                                                                                                           | Accepted: `logout`'s refusal in a credential's session takes one detail on both sides, stated in `interop-service.json` as `fail`'s and `denied`'s are, and pinned by no conversation, as theirs are not                                                                                                                                                                                                                                                                                                                                                                                     |
| C# written from a set was measured on one file of messages and an enum                                                                                                                                                         | Accepted: the C# generator's golden test holds nested messages, `oneof`, `map` and `optional` fields, from buf's set against the `.proto`, the embedded descriptor aside                                                                                                                                                                                                                                                                                                                                                                                                                     |

### On the interop's blueprint

| Objection                                                                                                                        | Answer                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--write-blueprints` empties the file when a string holds a surrogate alone, which I-JSON forbids and `check.py` does not refuse | Accepted: verified, the file left at 0 bytes. `check.py` refuses a surrogate alone at its place ([RFC 7493 §2.1](https://www.rfc-editor.org/rfc/rfc7493#section-2.1)) and writes no form for it; `--write-blueprints` encodes the form whole, then writes it beside the file and moves it over       |
| The form sorts arrays by identity, and `check.py` holds member order alone: a gate for half a rule                               | Accepted, and widened: `check.py` holds every array of the form to its order, names included, each finding naming the array, and `--write-blueprints` sorts them; an out-of-order edit fails here, not at the fixture's projection                                                                   |
| No reader of the interop's blueprint refuses another feature or a second service, and the schema admits both                     | Accepted: `interop-blueprint.schema.json` pins `requires` empty and one service, one gate for the five readers of one file; a kind no reader knows is the format's `enum`'s, which C#'s `KindOf` meets in an arm no checked file reaches                                                             |
| The word lives in two vocabularies for six commits, against [0003](0003-one-word-one-meaning.md)'s "in one commit"               | Accepted in part: the word moves first, in one commit across the records and the comments, before any file of `spec/` takes it. Refused: the interop code's identifiers in that commit, since they name `interop-service.json`, not the builder's file, and the readers' commits rewrite those lines |
| The record says the lines that mean `package.json` say so; three lines meant two files, and no `.nuspec` exists                  | Accepted: 0008 and the README name `package.json` and `Directory.Build.props` where they said "both manifests"; a line that means `package.json` alone keeps npm's word, which [0003](0003-one-word-one-meaning.md) leaves to its owner                                                              |
| The branch would start on a `develop` that fails the root's format step, the branch meant to fix it finished                     | Accepted: verified, two lines of `tools/release.mjs`. The fix takes a branch of its own, finished before the interop's blueprint starts, on the user's word                                                                                                                                          |
| The commit that removes keys every interop reads is a refactoring, whose subject says nothing broke                              | Accepted: `feat(spec)!`, the repository's form for a spec change its implementations follow, and a `### Removed` line under `[Unreleased]`                                                                                                                                                           |
| A list of hand-written files beside a gate that finds them alone                                                                 | Accepted: `prepare` moves the version of every conformance file that repeats one, as `check-versions.mjs` reads them; a hand-written file needs no name in the tools                                                                                                                                 |
| The two sources of the ids, a twin's name and the CHANGELOG's heading, stated against another tree                               | Accepted: the ids stand in both files for five of the branch's commits, never on `develop`, and no reader reads the second after the fourth of them; the C# test's twins are `payloadCodecOf`'s; one `### Added` heading, on the branch's base                                                       |
