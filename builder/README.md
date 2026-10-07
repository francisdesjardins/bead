# beadc, Bead's builder

beadc reads the services a `.proto` declares with Bead's options, compiles it with buf, and resolves
it into a **blueprint**, `bead-blueprint/1`: each service and its procedures in the runtime's
words, with no default and no inheritance left to interpret
([decision 0022](../docs/decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
`beadc check` refuses a `.proto` or a blueprint by rule name; `beadc blueprint` writes a blueprint
in its one form, and with `--check` holds one to it. The format's schema is the spec's,
[`spec/schemas/bead-blueprint.schema.json`](../spec/schemas/bead-blueprint.schema.json), and the
interop's blueprint, [`spec/interop-blueprint.json`](../spec/interop-blueprint.json), is what
[`test/fixtures/bead/interop/v1/interop.proto`](test/fixtures/bead/interop/v1/interop.proto) gives,
byte for byte, its `proto` members left out.

beadc runs on Node from this folder, as written: `node src/cli.ts`. It reads the spec's version and
the format's schemas from [`spec/`](../spec/) in place, beside `builder/`.

## Building and testing

The builder is a Yarn project of its own
([decision 0005](../docs/decisions/0005-a-toolchain-per-language.md)), on Node 24.9 or later, its
Yarn release vendored:

```sh
yarn install --immutable
yarn check        # types, lint, format, buf's lint and format, the options' generated code
yarn test         # beadc's tests
node src/cli.ts check ../spec/interop-blueprint.json
node src/cli.ts blueprint --check ../spec/interop-blueprint.json
```

| Script               | What it runs                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `yarn type-check`    | TypeScript 7 over `src/`, under the TypeScript side's strictness and Node's module system, `nodenext`           |
| `yarn lint`          | oxlint, type-aware, the TypeScript side's lint surface by reference                                             |
| `yarn format:check`  | oxfmt, the TypeScript side's options, copied                                                                    |
| `yarn buf:lint`      | `buf lint` over [`buf.yaml`](buf.yaml)'s modules: `proto/` and `test/fixtures/`                                 |
| `yarn buf:format`    | `buf format --diff --exit-code` over the same                                                                   |
| `yarn options:check` | `src/generated/bead/options_pb.ts` written again apart and compared; `yarn options:generate` writes it in place |
| `yarn test`          | Playwright's runner, no browser: one test file a module, in `__tests__/` beside it                              |
| `yarn test:coverage` | the same under c8                                                                                               |

**The pins are the TypeScript side's.** `@bufbuild/buf`, `@bufbuild/protobuf`,
`@bufbuild/protoc-gen-es`, TypeScript, oxlint, oxlint-tsgolint, oxfmt, Playwright, c8 and
`@types/node` take the descriptors `implementations/typescript/package.json` writes, and
`yarn.lock` locks each package the two projects share at the version the TypeScript side's lock
holds. Where a caret would resolve higher here, `yarn set resolution` locks it, as for oxlint:

```sh
yarn set resolution oxlint@npm:^1.86.0 npm:1.86.0
yarn install --immutable
```

An upgrade moves both projects in one change: the descriptor in both `package.json`, then each
lock, the builder's resolution set again to the TypeScript side's locked version.

## The commands

| Command                                                     | What it does                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beadc check [<root or blueprint>]`                         | Runs [the rules](#the-rules) over the input named, a folder of `.proto` files or a blueprint's file, or over `beadc.yaml`'s source                                                                    |
| `beadc blueprint [<root or blueprint>] -o <file>`           | Runs `check`, and writes nothing on an error; otherwise writes the blueprint in [its form](#the-form), encoded whole, then moved over the file. `--descriptor-set-out` writes buf's set               |
| `beadc blueprint --check [<root or blueprint>] [-o <file>]` | Writes nothing: holds the file `-o` names, or the blueprint given, to the blueprint in its form, naming the first line off, an array out of its order, a missing final line feed or a byte order mark |
| `beadc version`                                             | beadc's version, buf's, protobuf-es's, the format, the spec's version and the options' number                                                                                                         |

Flags: `--error-format text|json|github`, `--fail-on-warning`, `--except <RULE>`, which leaves out a
warning by its name and never an error.

| Exit | Meaning                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | done, warnings included unless `--fail-on-warning`                                                                                                                   |
| 1    | an error, a warning under `--fail-on-warning`, or a difference under `blueprint --check`                                                                             |
| 2    | the input or the call: a `.proto` buf does not compile, its messages as they came; a text that is no JSON; a bad flag; a bad `beadc.yaml`; a path outside its folder |

A finding prints one a line, `file:line:column: severity RULE: message` at a `.proto`'s place, as
buf's source info gives it, and `file#/services/0/serviceId: severity RULE: message` at a
blueprint's JSON Pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)); `json` writes one
object a line, `github` GitHub's workflow commands.

`beadc.yaml`, at a project's root, names the source when the command line names none:

```yaml
version: 1
source:
  proto: [proto] # its .proto roots; or `blueprint: <file>`, a blueprint
blueprint: gen/bead.blueprint.json # where `beadc blueprint` writes
```

Every path stays under the folder that holds `beadc.yaml`; one outside it is refused, with the fix:
move `beadc.yaml` up. A key beadc does not read is refused.

## The options

[`proto/bead/options.proto`](proto/bead/options.proto) is the builder's contract: package `bead`,
C# namespace `Bead.Protobuf`, one extension on each of `FileOptions`, `ServiceOptions` and
`MethodOptions`, at **58500**, of the range `descriptor.proto` leaves to one organization or to
experimental options, until the first publication takes a number of protobuf's global registry
([decision 0008](../docs/decisions/0008-three-version-axes-and-names-qualified-by-their-owner.md)).
`OPTIONS_NUMBER` in `src/version.ts` holds the three to it.

| Option                                                    | What it means                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(bead.file).admission`                                   | What the file's services admit when they say nothing                                                                                                       |
| `(bead.file).reserved_services`, `reserved_service_names` | The service ids and names the file's package retired, which none of its services takes                                                                     |
| `(bead.service).id`, `revision`                           | The service's id on the wire, 1 to 65,535 (spec 16.2), and its revision, 1 to 2,147,483,647, the releases of its contract (16.9)                           |
| `(bead.service).admission`                                | What its procedures admit when they say nothing; overrides the file's                                                                                      |
| `(bead.service).failures`                                 | The enum that numbers its procedures' failures (spec 9.5), by its name; its 0 value is never one                                                           |
| `(bead.service).deprecation_message`                      | What to use instead, beside `option deprecated = true`; a deprecated service deprecates each of its procedures                                             |
| `(bead.service).reserved_ids`, `reserved_names`           | The procedure ids and names none of its rpcs takes again; the enum's own `reserved` ranges retire failure codes                                            |
| `(bead.procedure).id`                                     | The procedure's id, 1 to 65,535, its declaration's for life (16.8)                                                                                         |
| `(bead.procedure).notifies`, `command`                    | Its kind, one of a `oneof`: a request that may open a subscription to notifications of `message`, or a command the client offers; neither, a plain request |
| `(bead.procedure).admission`                              | Who may call it: `none`, every call; `session`, a call with a session; `hook`, a named admission the answering side is given                               |
| `(bead.procedure).maximum_payload_bytes`                  | The bytes a payload of it holds at most, up to 2,147,483,647; 0, the router's alone                                                                        |
| `(bead.procedure).deprecation_message`                    | What to use instead, beside `option deprecated = true`                                                                                                     |
| `(bead.procedure).failures`                               | The values of its service's failures enum it may answer, each by its name as the enum writes it                                                            |
| `bead.Raw`, `bead.Text`, `bead.Json`                      | The payload types whose bytes are the payload itself: `raw`, `text` and `json` (spec 17); any other message is `proto`                                     |

beadc compiles its own copy of the options first among the roots; a project imports it as
`import "bead/options.proto";` and keeps no copy of its own.

## From a `.proto` to a blueprint

- **A procedure's name** is its rpc's, the first letter lowered (spec 16.4): `EndSessionsOf` gives
  `endSessionsOf`.
- **A service's name** is its `.proto` name, a trailing `Service` taken off.
- **A failure's name** is its enum value's, the enum's prefix taken off, as buf's
  `ENUM_VALUE_PREFIX` asks: `INTEROP_FAILURE_ON_PURPOSE` gives `ON_PURPOSE`.
- **An admission** is resolved into each procedure: its own, else its service's, else its file's.
- **A binding** is its message's encoding, and for `proto` alone its full name, which `proto.messages`
  lists with its file.
- **A description** is the leading comment of a service, an rpc or a failure's value: each line's
  text after its marker, one space taken off, its end trimmed, carriage returns read as line feeds;
  a paragraph's lines joined by one space, paragraphs by a blank line. Trailing and detached comments
  are no description; a comment kept out is written detached, a blank line before the declaration.

## The names

Section 16 of the spec binds a procedure's name and the ids every side declares. What it leaves to
the builder:

- **A service's name** is an upper-case ASCII letter, then 62 ASCII letters or digits at most.
- **A failure's name** is upper-case ASCII letters and digits, in words parted by one underscore.
- **A hook's name** takes a procedure's form, spec 16.4.
- **One name a scope**, compared as spec 16.6 compares, an ASCII capital read as its small letter and
  nothing else: two services of a blueprint, two procedures or two hooks of a service; two failures of
  a service, besides, without their underscores.
- **A reserved name** is never taken again, compared alike.

**Each official target reserves names**, which `NAME_TARGET` refuses on every blueprint whatever
targets a project names, never escaping one, so a procedure's key stays the name its metrics and
filters read:

| Target     | Refuses                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every one  | A service whose classes, `<Name>Procedures`, `<Name>Failures`, `<Name>Server`, `<Name>ServerOptions` and `<Name>Client`, a message or a public type of the runtime holds already (`HttpServer`, `RouterClient`, `ServiceServer` and the others `src/targets/names.ts` lists)                                                                      |
| TypeScript | A procedure named `on`, `notifications`, `then`, `constructor`, `toString` or `valueOf`: the generated client's own members, a thenable's, `Object.prototype`'s                                                                                                                                                                                   |
| C#         | A procedure whose rpc name is `All`, `On`, `Notifications`, `Is`, one of `object`'s members (`Equals`, `GetHashCode`, `GetType`, `ToString`, `MemberwiseClone`, `ReferenceEquals`, `Finalize`) or one of its service's classes; a hook whose C# name is one of `object`'s members; a failure whose C# name is `Code` or one of `object`'s members |

## The rules

A rule's **level** says where it applies: `proto`, on a `.proto` input, each with its fixture under
[`test/proto/`](test/proto/); `blueprint`, on any blueprint, one written by hand included, each with
its cases under [`test/blueprints/`](test/blueprints/), a JSON Patch (RFC 6902) of the interop's
blueprint and the findings it gives by rule name at their JSON Pointers, or, for what a patch cannot
state, a raw text under [`test/form/`](test/form/).

On a blueprint, the rules run in one order, and a stage that finds an error ends the reading: its
JSON and I-JSON, its format, its features, the format's schema, then the rules that span entries and
its `specVersion`. A refusal of the schema maps to its rule by its place in the blueprint; a
refusal at a place no rule names is `BLUEPRINT_SCHEMA`. The findings on identities come in spec
16.10's order: a range's first, then a name's form.

| Rule                     | Level     | Severity | Refuses                                                                                                                                                | Because                                                                                    |
| ------------------------ | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `PROCEDURE_OPTIONS`      | proto     | error    | an rpc of a Bead service without `(bead.procedure)`                                                                                                    | its id cannot be guessed                                                                   |
| `SERVICE_SKIPPED`        | proto     | warning  | a service without `(bead.service)`                                                                                                                     | a forgotten option would drop a service in silence                                         |
| `STREAM_RESERVED`        | proto     | error    | `stream` on either side                                                                                                                                | kept for Bead's streams; a subscription is no stream                                       |
| `ADMISSION_DEFAULT`      | proto     | error    | a Bead service whose file and service state no admission                                                                                               | the runtime's default admits every call                                                    |
| `ADMISSION_EMPTY`        | both      | error    | an admission that states no rule: on a `.proto`, no member of `oneof rule` set; on a blueprint, `{}`                                                   | an admission says who may call                                                             |
| `DEPRECATION_MESSAGE`    | proto     | error    | a `deprecation_message` without `option deprecated = true`                                                                                             | one place says it                                                                          |
| `FAILURES_ENUM`          | proto     | error    | a `failures` naming no enum of the set; an `allow_alias` on it; a procedure's failure naming no value of it                                            | the catalogue must exist, one name a code                                                  |
| `PAYLOAD_TYPE_FIELD`     | proto     | error    | a field whose type is `bead.Raw`, `bead.Text` or `bead.Json`                                                                                           | their protobuf form is never written                                                       |
| `OPTIONS_COPY`           | proto     | error    | a `bead/options.proto` among the project's roots, read before buf compiles                                                                             | beadc compiles its own                                                                     |
| `BLUEPRINT_JSON`         | blueprint | error    | a text not UTF-8, at its byte; a member twice, a surrogate alone, a number with a fraction or an exponent, at its JSON Pointer                         | I-JSON (RFC 7493 §2.1, §2.3); a reader's value changes                                     |
| `FORMAT_UNKNOWN`         | blueprint | error    | a `format` but `bead-blueprint/1`                                                                                                                      | a reader refuses a major it does not know                                                  |
| `FEATURE_UNKNOWN`        | blueprint | error    | a `requires` naming a feature this beadc does not know (none yet)                                                                                      | never ignored in silence, as JOSE's `crit` (RFC 7515 §4.1.11)                              |
| `BLUEPRINT_SCHEMA`       | blueprint | error    | a refusal of the format's schema at a place no rule names: a member unknown, a type, a member missing                                                  | the format is its schema                                                                   |
| `SERVICE_ID_RANGE`       | blueprint | error    | a service id missing, 0, or past 65,535                                                                                                                | u16 (spec 16.2); 0 is the protocol's (16.3)                                                |
| `SERVICE_REVISION_RANGE` | blueprint | error    | a revision missing, 0, or past 2,147,483,647                                                                                                           | 0 means unknown to a relay (16.9)                                                          |
| `PROCEDURE_ID_RANGE`     | blueprint | error    | a procedure id missing, 0, or past 65,535                                                                                                              | u16, never 0 (16.2)                                                                        |
| `FAILURE_CODE`           | blueprint | error    | a failure code below 1 or past 65,535, or two failures of one code                                                                                     | codes 1 to 65,535 (spec 9.5), one name a code                                              |
| `PROCEDURE_LIMIT_RANGE`  | blueprint | error    | a `maximumPayloadBytes` below 1 or past 2,147,483,647                                                                                                  | C#'s `int?`                                                                                |
| `RESERVED_RANGE`         | blueprint | error    | a reserved range whose first or last is 0 or past 65,535, or whose first is after its last                                                             | ranges of real ids                                                                         |
| `NAME_FORM`              | blueprint | error    | a name off its form: a procedure's, a hook's, a service's, a failure's, a reserved one's                                                               | one name in every casing, out of the debug filter's grammar (spec 16.4, 16.5)              |
| `SERVICE_ID_UNIQUE`      | blueprint | error    | two services of one id                                                                                                                                 | one blueprint is one id space                                                              |
| `PROCEDURE_ID_UNIQUE`    | blueprint | error    | two procedures of a service of one id                                                                                                                  | one address, one procedure                                                                 |
| `ID_RESERVED`            | blueprint | error    | a service id, procedure id or failure code its scope reserved                                                                                          | an id is for life (16.8)                                                                   |
| `NAME_UNIQUE`            | blueprint | error    | two names of one scope that are one, as [the names](#the-names) say                                                                                    | a filter folds ASCII case (16.6)                                                           |
| `NAME_RESERVED`          | blueprint | error    | a procedure or service name its scope reserved, compared as 16.6 compares                                                                              | a retired name keeps its dashboards                                                        |
| `ENCODING_FIT`           | blueprint | error    | a `proto` binding to `bead.Raw`, `bead.Text` or `bead.Json`                                                                                            | a payload type's encoding is its own                                                       |
| `NOTIFICATION_MESSAGE`   | both      | error    | a notification binding missing on a procedure that notifies, or present on one that does not; on a `.proto`, a `notifies` naming no message of the set | the notifications' type; a command notifies nothing                                        |
| `NOTIFICATION_RESULT`    | blueprint | warning  | a procedure that notifies whose result is `raw`                                                                                                        | a subscription's result goes in one envelope (spec 11.6)                                   |
| `FAILURE_UNKNOWN`        | blueprint | error    | a procedure listing a failure its service's catalogue lacks                                                                                            | the list narrows the catalogue                                                             |
| `BINDING_SOURCE`         | blueprint | error    | a `proto` binding whose message `proto.messages` does not list, or a blueprint with a `proto` binding and no `proto`                                   | such a blueprint is never taken alone                                                      |
| `NAME_TARGET`            | blueprint | error    | a name an official target reserves, as [the names](#the-names) list them                                                                               | the key must be the name                                                                   |
| `SPEC_VERSION_NEWER`     | blueprint | warning  | a `specVersion` newer than the spec this beadc follows                                                                                                 | its identity rules may be ones beadc does not know; `format` and `requires` carry the rest |

## The form

A blueprint has one form: its members in RFC 8785's order, by their names' UTF-16 code units; its
strings escaped as RFC 8785 escapes them; its numbers integers; two spaces of indentation, a final
line feed, UTF-8 without a byte order mark; its arrays sorted by identity: files by path, messages
by full name, services by id, procedures by id, failures by code, a procedure's failures in their
codes' order, ranges ascending, names in their code points' order. `beadc blueprint` writes every
blueprint in it, and `beadc blueprint --check` and `spec/check.py` hold one to it. A layout off its
form is no rule of `check`, as `buf lint` leaves layout to `buf format`.

## Its gates

CI's `builder` job installs, then runs `yarn test`, `beadc check` and `beadc blueprint --check` over
the interop's blueprint, on Linux and on Windows, on Node 26, and on Linux on Node 24.9 besides; and
`yarn check` on Linux, whose types, lint, format and generated code no platform moves.
