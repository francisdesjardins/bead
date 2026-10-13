# beadc, Bead's builder

beadc reads the services a `.proto` declares with Bead's options, compiles it with buf, and resolves
it into a **blueprint**, `bead-blueprint/1`: each service and its procedures in the runtime's
words, with no default and no inheritance left to interpret
([decision 0022](../docs/decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
`beadc check` refuses a `.proto` or a blueprint by rule name; `beadc blueprint` writes a blueprint
in its one form, and with `--check` holds one to it; `beadc generate` writes, from a blueprint, a
typed server where only resolvers are written and a client holding a requester of each procedure by
its name, in TypeScript and in C#, and with `--check` holds them to it; `beadc breaking` holds a
project to its last release. The format's schema is the spec's,
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
export BEADC_PROTOC="$(node tools/fetch-protoc.mjs)"   # protoc, by its pin
yarn check        # types, the goldens' types, lint, format, buf's lint and format, the options' generated code
yarn test         # beadc's tests, the targets' goldens among them
node src/cli.ts check ../spec/interop-blueprint.json
node src/cli.ts blueprint --check ../spec/interop-blueprint.json
```

| Script               | What it runs                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn type-check`    | TypeScript 7 over `src/`, under the TypeScript side's strictness and Node's module system, `nodenext`; then over the target's goldens, as a consumer compiles them, against `@bufbuild/protobuf`'s pin and its floor                                                                                |
| `yarn lint`          | oxlint, type-aware, the TypeScript side's lint surface by reference                                                                                                                                                                                                                                 |
| `yarn format:check`  | oxfmt, the TypeScript side's options, copied                                                                                                                                                                                                                                                        |
| `yarn buf:lint`      | `buf lint` over [`buf.yaml`](buf.yaml)'s modules: `proto/`, `test/fixtures/` and `test/messages/`                                                                                                                                                                                                   |
| `yarn buf:format`    | `buf format --diff --exit-code` over the same                                                                                                                                                                                                                                                       |
| `yarn options:check` | `src/generated/bead/options_pb.ts` written again apart and compared; `yarn options:generate` writes it in place                                                                                                                                                                                     |
| `yarn test`          | Playwright's runner, no browser: one test file a module, in `__tests__/` beside it; `BEADC_WRITE_GOLDEN=1 yarn test` writes the targets' goldens again; a test that runs protoc skips, with its reason, where none of the pin's version is found, and fails instead under `BEADC_PROTOC_REQUIRED=1` |
| `yarn test:coverage` | the same under c8                                                                                                                                                                                                                                                                                   |

**The pins are the TypeScript side's.** `@bufbuild/buf`, `@bufbuild/protobuf`,
`@bufbuild/protoc-gen-es`, TypeScript, oxlint, oxlint-tsgolint, oxfmt, Playwright, c8 and
`@types/node` take the descriptors `implementations/typescript/package.json` writes, and
`yarn.lock` locks each package the two projects share at the version the TypeScript side's lock
holds; `@bufbuild/protoplugin`, which the target is written on, takes the version protoc-gen-es
depends on. Where a caret would resolve higher here, `yarn set resolution` locks it, as for oxlint:

```sh
yarn set resolution oxlint@npm:^1.86.0 npm:1.86.0
yarn install --immutable
```

An upgrade moves both projects in one change: the descriptor in both `package.json`, then each
lock, the builder's resolution set again to the TypeScript side's locked version.

**protoc is pinned by [`protoc.json`](protoc.json)**: its version, 36.2, the oldest Google.Protobuf
the C# it writes runs on, 3.36.2, the runtime its release pairs it with, and each release archive's
sha256. beadc runs the protoc `BEADC_PROTOC` names, or `protoc` on the path, only where a C# output
generates messages, and refuses one of another version, which writes other code.
[`tools/fetch-protoc.mjs`](tools/fetch-protoc.mjs) downloads this platform's archive from
protobuf's release, checks its sha256 before it reads it, extracts it into `.protoc/<version>/`,
which git ignores, and prints the executable's path. An upgrade moves `protoc.json` whole, its
version, its floor and its sums, and writes the C# goldens again.

## The commands

| Command                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beadc check [<root or blueprint>]`                                       | Runs [the rules](#the-rules) over the input named, a folder of `.proto` files or a blueprint's file, or over `beadc.yaml`'s source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `beadc blueprint [<root or blueprint>] -o <file>`                         | Runs `check`, and writes nothing on an error; otherwise writes the blueprint in [its form](#the-form), encoded whole, then moved over the file. `--descriptor-set-out` writes buf's set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `beadc blueprint --check [<root or blueprint>] [-o <file>]`               | Writes nothing: holds the file `-o` names, or the blueprint given, to the blueprint in its form, naming the first line off, an array out of its order, a missing final line feed or a byte order mark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `beadc generate`                                                          | Runs `check` over `beadc.yaml`'s source, and writes nothing on an error; otherwise writes each output `beadc.yaml` names, and for a `.proto` source the blueprint it names and the editor's copy of the options, each file encoded whole, then moved over the one it replaces; refuses, before it writes anything, a file outside its output's folder, where a blueprint's `proto.file` climbs out of it, as protoc refuses a plugin's `..`, and two files at one path, compared as a system that folds case compares them, naming both sources; under `clean`, takes out of each output's folder a file of a kind it writes that it no longer writes, read by its first lines, and prints each, `beadc: generate takes out <path>: <source> no longer gives it` |
| `beadc generate --check`                                                  | Writes nothing: holds each file `generate` writes to what it would write, CRLF read as LF, naming a file that differs at its first line off, a file missing, and, under `clean`, a file of a kind `generate` writes in an output's folder that it would not write; never the editor's copy, and never a file under an output's `bin/`, `obj/` or `node_modules/`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `beadc breaking [<root or blueprint>] --against <folder, - or blueprint>` | Runs `check` over the input, then holds it to the earlier `--against` names, by [the breaking rules](#breaking), `API`'s by default or `--category WIRE`'s; prints each finding, Bead's and buf's, with its pointer, and writes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `beadc init <name> [--language typescript\|csharp]`                       | Writes a project in the folder it runs in: its `beadc.yaml`, an output for each language named, both when none is, its outputs under a folder a language, `typescript/gen` and `dotnet/gen`, so a package at the project's root or in its language's folder resolves what the generated code imports; `proto/<name>/v1/<name>.proto`, one service that `check` passes and buf's STANDARD lint takes; buf's `buf.yaml` for an editor; the editor's copy of the options; the wrappers `beadc.sh`, executable, and `beadc.ps1`; and appends to `.gitignore` and `.gitattributes` each line they lack. It writes over no file, every path looked at first, but a wrapper byte for byte the one it would write, which it keeps                                        |
| `beadc wrapper beadc.sh\|beadc.ps1`                                       | Prints the wrapper named, filled with beadc's version, and nothing else: it reads and writes no file, so the image's first run needs no mount ([the image and its wrappers](#the-image-and-its-wrappers))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `beadc version`                                                           | beadc's version, buf's, protobuf-es's, protoplugin's, protoc-gen-es's, protoc's, `protoc 36.2`, or another's beside the pin, `protoc 35.1, pinned 36.2`, or `protoc none, pinned 36.2`, the format, the spec's version and the options' number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Flags: `--error-format text|json|github`, `--fail-on-warning`, `--except <RULE>`, which leaves out a
warning by its name and never an error; on `breaking`, any finding, `<RULE>` or `<RULE>@<subject>`,
a subject as its finding's line prints it, buf's as `buf:<RULE>` or `buf:<RULE>@<path>`
([breaking](#breaking)); `--against` and `--category WIRE|API`, `breaking`'s, and refused on another
command; `--language`, `init`'s, repeated. `--against-ref` is the wrappers' own: on Node, beadc
refuses it, naming the pipe that does its work, `git archive <ref>` into `--against -`.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | done, warnings included unless `--fail-on-warning`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1    | an error, a warning under `--fail-on-warning`, a difference under `blueprint --check` or `generate --check`, or a breaking finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2    | the input or the call: a `.proto` buf does not compile, its messages as they came; a text that is no JSON; a bad flag; an input named to `generate`, which reads `beadc.yaml` alone; a bad `beadc.yaml`, an output of a language this beadc has no target for among them; a path outside its folder; two outputs' folders one inside the other, or one holding or inside another's `messagesOut`; a blueprint whose bindings name messages, as `generate`'s source; a file `generate` would write outside its output's folder, or two at one path; where a C# output generates messages, no protoc, one off its pin, or protoc's refusal, in its words; `init`'s name missing or no proto package's part, a language it has no target for, a file it would write over; a wrapper's name other than `beadc.sh` or `beadc.ps1`; on `breaking`, `--against` missing, `--category` other than `WIRE` or `API`, an `--except` of a rule it does not run or an error of `check`'s, a scope on a rule that finds no subject, a scope that is a pointer, or no subject of its rule's kind, `--except WAIVER_UNUSED`, a `buf:<RULE>` buf does not know, one beadc excepts always or one its category does not run, a path neither side's roots hold; `--against-ref`, given to beadc on Node; an earlier beadc cannot read: a `.binpb`, a file that is no JSON, a blueprint its schema refuses, a `beadc.yaml` it refuses, a blueprint it names that is not there, a `.proto` buf does not compile beside no committed blueprint, a folder without `beadc.yaml` against a blueprint named on the command line; `--against -` with a terminal or nothing on standard input, an archive cut short, a path absolute, empty, holding `..` or a NUL, an entry over an earlier one, a header off ustar or its checksum, a pax `size` that is no whole number, an entry `git archive` never writes, an earlier's root that holds no `.proto`; buf's refusal of its configuration or its images, in its words; a path the file system refuses, a file where a folder is meant or no room, in one line |

A finding prints one a line, `file:line:column: severity RULE: message` at a `.proto`'s place, as
buf's source info gives it, and `file#/services/0/serviceId: severity RULE: message` at a
blueprint's JSON Pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)); a finding of
`breaking`'s own rules ends with its subject, ` [service:1/procedure:4]`, what a waiver names;
`json` writes one object a line, its `subject` among its members, `github` GitHub's workflow
commands, a file named from `GITHUB_WORKSPACE` where it is set, wherever beadc ran.

`beadc.yaml`, at a project's root, names the source when the command line names none, and what
`beadc generate` writes:

```yaml
version: 1
source:
  proto: [proto] # its .proto roots; or `blueprint: <file>`, a blueprint
blueprint: gen/bead.blueprint.json # where `beadc blueprint` and `beadc generate` write
outputs:
  - language: typescript # or csharp
    out: gen/ts # the output's folder
    importExtension: ts # what a relative import ends with: none, js or ts (the default)
    runtime: '@francisdesjardins/bead/service' # the default; or a path relative to out, no extension
    messages: generate # the default; or external, another generator's, with messagesOut
    # messagesOut: gen/messages # where messages: external finds them
  - language: csharp
    out: gen/cs
    # namespace: Acme.Greeter # for a blueprint source alone: a .proto's services take their file's
    messages: generate # the default, protoc's; or external, a project's own build's
clean: true # generate takes out what it no longer writes; off unless set, as buf's
```

Every path stays under the folder that holds `beadc.yaml`; one outside it is refused, with the fix:
move `beadc.yaml` up. A key beadc does not read is refused, an output's among them, and so is
`messagesOut` without `messages: external`; two outputs write two folders, neither inside the
other, and no output's folder holds another's `messagesOut` or lies in it, since under `clean`
`generate` takes out of an output's folder each file of its kinds it does not write there. A C# output names its
`namespace` for a blueprint source, whose services have no file to take one from, and never for a
`.proto` source, whose services take their file's. For a `.proto` source, `generate` writes a copy
of Bead's options to `.beadc/include/bead/options.proto` beside `beadc.yaml`, for an editor, and for
a project's own generator where its messages are `external`, to resolve
`import "bead/options.proto";`: it is git's to ignore, and `--check` never compares it, so a build
that reads it runs after `generate`.

**`clean`** is buf.gen.yaml's opt-in: protoc never removes a file, and buf removes one only under
`clean: true`. Off, the default, `generate` takes out nothing and `--check` names no file it would
not write. On, `generate` takes out of each output's folder a file of a kind it writes that this run
does not, in both targets by its first lines: a `_bead.ts` or a `*Bead.cs` under beadc's header;
where messages are generated, a `_pb.ts` under protoc-gen-es's, or a `.cs` under protoc's at the
path protoc gives its source; and prints each. Where buf's `clean` empties the folder, beadc takes
out only by kind and header, since an output's folder may hold a project's own files: under
`clean`, the generated files' kinds in an output's folder are beadc's alone, so a protoc-gen-es file
another run left there is taken out and printed, while a `legacy_bead.ts` a person wrote, a
`*_grpc_pb.ts` and a project's own files stay. `init` writes `clean: true`, its output folders
being beadc's own.

**What beadc makes for a run**, protoc's output and the tree `--against -` extracts, it makes under
`.beadc/` beside `beadc.yaml`, which `init`'s `.gitignore` ignores, and takes out after; with no
`beadc.yaml`, under the system's temporary folder. buf builds the roots and beadc's options as one
module, under the folder that holds them all, so a root on another drive than beadc's options is
refused: on Node from a clone, keep the project on the clone's drive; the image has one.

## The image and its wrappers

beadc ships as an image, `ghcr.io/francisdesjardins/beadc:<version>`, for linux/amd64 and
linux/arm64, built by [`Dockerfile`](Dockerfile) from the repository's root, since beadc's tests
read `spec/` and the files of each side they hold the generated code to; the context's ignore file,
[`Dockerfile.dockerignore`](Dockerfile.dockerignore), is beside it:

```sh
docker build -f builder/Dockerfile --target test .   # beadc's tests, on the image itself, protoc required
docker build -f builder/Dockerfile -t beadc:local .  # the image
BEADC_IMAGE=beadc:local yarn test                    # from builder/: each wrapper runs it besides
```

It holds Node from `node:26.10.0-trixie-slim`, pinned by its digest; beadc as this folder holds it,
with its production packages, run by Node as written; buf, protoc-gen-es, protoc at its pin with its
well-known types, `bead/options.proto`, the files of `spec/` beadc reads at their places beside it;
and under `/opt/bead/licenses/` the licence texts of what it adds to its base, which
[`tools/licenses.mjs`](tools/licenses.mjs) writes and holds to the image's
`org.opencontainers.image.licenses` label: a package whose licence leaves the label fails the
build. It has no SDK; its own user, 65532, is not root.

A project runs it through two wrappers, `beadc.sh` for bash 3.2 or later and `beadc.ps1` for
PowerShell 7.6 or later, which `beadc wrapper` prints and `beadc init` writes, filled with beadc's
version; a project commits both. The first run asks nothing but the engine:

```sh
docker run --rm ghcr.io/francisdesjardins/beadc:<version> wrapper beadc.sh > beadc.sh
bash beadc.sh init hello
./beadc.sh generate
git add --chmod=+x beadc.sh   # git on Windows records no mode
```

```powershell
# in PowerShell 7.6 (pwsh), not Windows PowerShell
docker run --rm ghcr.io/francisdesjardins/beadc:<version> wrapper beadc.ps1 > beadc.ps1
./beadc.ps1 init hello
./beadc.ps1 generate
```

The two wrappers are one contract, which
[`src/__tests__/wrappers.test.ts`](src/__tests__/wrappers.test.ts) holds them to, each case run by
bash, by `pwsh -File` and inside a pwsh session, to one engine call, one output and one exit:

- **The folder**: the nearest upward that holds `beadc.yaml`, else the current one, by its physical
  path, asked of the system, a link or a junction on the way resolved, mounted at `/work`, the run
  kept at the same place under it. A path beadc is given is the container's: relative, with `/`.
- **The engine and the image**: `docker`, or the engine `BEADC_ENGINE` names, told Docker or
  Podman by what its `--version` reports; `ghcr.io/francisdesjardins/beadc:<version>`, or the image
  `BEADC_IMAGE` names, by a tag or a digest.
- **The run**: `--rm --init --network none --read-only --tmpfs /tmp --cap-drop ALL`,
  `--security-opt no-new-privileges` and `--security-opt label=disable`; no terminal, which would
  end each line with CRLF and merge stderr into stdout, and no variable passed; the engine's output
  read as UTF-8.
- **Who writes the files**: the caller. `--user <uid>:<gid>` to a rootful engine,
  `--userns=keep-id` to rootless Podman, `--user 0:0` to rootless Docker, whose root is the caller,
  and the image's own user on Windows, where Docker Desktop maps every user to the caller.
- **The arguments**, as the shell hands them. Inside a pwsh session, PowerShell takes a bare `--`
  and cuts a `-name:value` token, which `pwsh -File` splits; quoted, `'--'` and `'-o:f'` pass whole,
  and beadc's own forms, `--except=A` and `--except A`, pass alike every way. A session's `>` on
  Windows ends each line it writes with CRLF. [The support matrix](../docs/support.md) lists what
  each shell cannot do.
- **`--against-ref <ref>`**, or `--against-ref=<ref>`, is the wrappers' own, taken out of the
  arguments, once, never beside `--against`: with git on the host, inside a work tree, `<ref>`
  naming a commit that holds the project's folder, the wrapper pipes
  `git -C <folder> archive --format=tar <ref>`, the project's folder at that ref rooted at it, into
  the engine call, which gains `-i` and, after the arguments, `--against -`. Nothing lands on the
  host: the archive goes to the container's `/tmp` and leaves with it, less what the ref's
  `.gitattributes` marks `export-ignore`. `--against-ref:<ref>`, which `pwsh -File` would split, is
  refused. Inside a pwsh session, `--against-ref`'s run writes the engine's bytes to the process's
  own streams, past the session's `>` and `2>`, since `beadc.ps1` pipes the archive between two
  processes to keep the engine's exit. `--against -` given by hand passes `-i` too:
  `git archive v0.3.0 | ./beadc.sh breaking --against -`; with a terminal as its standard input it
  is refused, and so is an archive piped into `beadc.ps1` inside a session, which PowerShell hands
  the script as objects: `--against-ref` names the ref instead.

| Exit     | From a wrapper                                                                                                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0, 1, 2  | beadc's own; and 2 on `--against-ref` given twice, without its ref, as `--against-ref:<ref>` or beside `--against`, outside a git work tree, for a ref that names no commit, or one that holds no project's folder, and on `--against -` from a terminal or, in a session, piped into `beadc.ps1`, the engine never called                   |
| 3        | the environment: no engine on the path, an engine that does not answer, Docker in Windows containers' mode, the engine's own failure, its 125, 126 or 127, an image it cannot pull among them; and a shell the wrapper is not written for, `sh beadc.sh`, Windows PowerShell, PowerShell 7.4 or 7.5; `--against-ref` with no git on the path |
| 130, 143 | an interrupt, a termination, which the engine's init passes on to beadc                                                                                                                                                                                                                                                                      |

An execution policy that refuses `beadc.ps1`, Windows PowerShell's `Restricted`, the Windows
client's default, a group policy's `AllSigned`, or `RemoteSigned` on a downloaded file, stops
PowerShell before the wrapper's first line, with PowerShell's exit 1:
`pwsh -ExecutionPolicy Bypass -File ./beadc.ps1 generate` runs it. On Windows, `bash` run from
PowerShell is WSL's, where `beadc.sh` acts as on Linux, its folder a `/mnt/<drive>/` path; Git Bash
runs it as Windows.

The repository runs beadc on Node from this folder, and commits no filled wrapper: the templates are
in [`wrappers/`](wrappers/), their image's tag a token that `wrapper` and `init` fill.

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
  lists with its file, by the path its import names: `PROTO_FILE` holds `proto.messages[].file` and
  a service's `proto.file` to that form, and to `proto.files`.
- **A deprecation** is protobuf's `option deprecated = true`, its `deprecation_message` its text: a
  service's deprecates each of its procedures. A failure's is its enum value's `[deprecated = true]`,
  which carries no message, since the options extend no `EnumValueOptions`.
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

| Target     | Refuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every one  | A service whose types, `<Name>Procedures`, `<Name>Failures`, `<Name>Server`, `<Name>ServerOptions`, `<Name>Admissions`, `<Name>Client`, `<Name>ClientOptions`, `<Name>Windows`, `<Name>Resolvers`, `<Name>Commands`, `<Name>Notifiers` and `<Name>Notifications`, a message or a public type of the runtime holds already (`HttpServer`, `RouterClient`, `ServiceServer` and the others `src/targets/names.ts` lists); on a `.proto`, one a message or an enum of its C# namespace holds, in any file of the set that shares it, since C# compiles them into one           |
| TypeScript | A procedure named `on`, `notifications` or `then`, or one of `Object.prototype`'s seven a procedure's name can take (`constructor`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `toString`, `valueOf`): the generated client's own members, a thenable's, and the members it would shadow, or, for `constructor`, not compile                                                                                                                                                                                                             |
| C#         | A procedure whose rpc name is `All`, `On`, `Notifications`, `Is`, `Code`, one of `object`'s members (`Equals`, `GetHashCode`, `GetType`, `ToString`, `MemberwiseClone`, `ReferenceEquals`, `Finalize`) or one of its service's classes, `Code` whatever it lists, since the class of failures of a procedure that lists any holds it; a hook whose C# name is one of `object`'s members or one of its service's classes; a failure whose C# name is `Code`, one of `object`'s members, or the rpc name of a procedure that lists it, whose class of failures would hold it |

**A description** is written by every official target, and C#'s documentation comments are XML:
`DESCRIPTION_TARGET` refuses, on every blueprint, a description holding a character XML 1.0 holds in
no document, raw or by reference, C0's controls but tab, LF and CR, and U+FFFE and U+FFFF, rather
than one target dropping it and the two sides' documentation differing.

## The TypeScript target

`beadc generate` writes, for each file a service's `proto` member names, `<file>_bead.ts` at that
`.proto`'s path under the output's folder, beside protoc-gen-es's `<file>_pb.ts`, whichever the
source, as protoc and buf write a file at the path its descriptor names; for a service with no
`proto` member, `<name>_bead.ts` at the folder's root, its `serviceName` with its first letter
lowered: the interop's is `interop_bead.ts`. A blueprint carries a `proto` path only in the form
an import names one, which the schema and `PROTO_FILE` hold, and `generate` refuses a path that
would leave the output's folder besides. The target is a
[protoplugin](https://github.com/bufbuild/protobuf-es/tree/main/packages/protoplugin) plugin, run
in beadc's process over protoc's plugin request (`google/protobuf/compiler/plugin.proto`), built
from buf's set, or empty for a blueprint alone. A file holds, for each of its services:

- **`<Name>Procedures`**, frozen: a descriptor each, `requestOf` or `commandOf`, its admission, its
  failures by name and code, its procedure as the runtime takes it, its deprecation and its payload
  limit among them, and its codecs, `PAYLOAD_CODECS.raw`, `.text` or `.json`, or `payloadCodecOf`
  over protobuf-es's `fromBinary` and `toBinary`, at a nesting limit of 101, for a `proto` binding;
- **`<Name>Failures`**, its catalogue; **`<Name>Resolvers`**, for resolvers written in a module of
  their own; **`<Name>ServerOptions`** and **`<Name>ClientOptions`**, the service layer's options,
  and **`<Name>Admissions`** and **`<Name>Windows`**, their hooks and their windows;
- **`<Name>Server<Data>`**, where only resolvers are written: the layer's `command`, `notify`,
  `offer`, `on` and `proceduresWithoutResolver`, its options one parameter, required where a
  procedure names a hook;
- **`<Name>Client`**, over its Bead client, its options after it: a requester of each procedure
  its server answers, by its name, its `notifications` and `on`;

and, once, the contract with the runtime, `GENERATED_CODE_SUPPORTS_VERSION_2`
([decision 0018](../docs/decisions/0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)). Every doc comment is the description, then what
the procedure admits, through protoplugin's `jsDoc`, which writes `*/` as `*\/`.

**A deprecation is marked** `@deprecated`, the blueprint's message or `No replacement is named.`,
on each declaration the file writes for it, as protoc-gen-es marks a deprecated rpc: a procedure's,
its own or its service's, on its descriptor and its requester, which the service layer's mapped
types carry to its notification, its command's requester, its notifier, its resolver's key and its
window; a service's on every type the file declares for it. A name passed to `on`, `of` or `is` is
marked by an overload of its own, written only where something is deprecated: `<Name>Server.on`
for a deprecated procedure, `<Name>Client.on` for a deprecated command, `<Name>Failures.of` and
`.is` for a deprecated failure, the use flagged under `on`, `of` or `is`; a name held in a
variable of a wider type, `'NOBODY' | 'LATE'`, takes the layer's own signature and is not. tsc says
nothing of a deprecation: typescript-eslint's `no-deprecated`, in `strict-type-checked`, and
oxlint's `typescript/no-deprecated` report each use, the service's own implementer's too, who
still serves the procedure; their `allow` scopes Bead's, by name or by file. It is the warning
period SemVer's FAQ asks for, ahead of the release that takes the declaration out, which `API`
holds.

**Its header leads the file**, above the imports protoplugin prints first, as `@generated` markers
and Go's `Code generated … DO NOT EDIT.` do; never protoplugin's preamble, which needs a `.proto`
and writes `/* eslint-disable */` in every file:

```ts
// @generated by beadc <version> from spec/interop-blueprint.json: bead-blueprint/1, spec <specVersion>.
// Do not edit: regenerate with beadc.
```

It names beadc's version, the product's, the source as `beadc.yaml`'s folder sees it, the format
and the blueprint's `specVersion`; where the output generates messages, a third line names
protoc-gen-es's version and the oldest `@bufbuild/protobuf` its output runs on, 2.13.0.
`tools/release.mjs prepare` moves the first line's two versions to a release's. Where the file
marks a deprecation, or names a message protobuf deprecates, itself or through the message it is
nested in, as protoplugin reads a deprecated parent, `/* eslint-disable */` closes the header,
protoc-gen-es's own directive, which oxlint and ESLint read alike, so the file's own uses of what it
marks are silenced, and only its own: a rule-named directive fails ESLint where typescript-eslint is
not loaded. Every other file keeps the TypeScript side's lint, which holds the interop's file to its
rules; protoc-gen-es writes the directive in every file, and a file that must mark loses that lint,
and no other.

**Its imports** are protoplugin's symbols: one `import type` and one `import` a module, so a clash
is aliased, as a service whose `<Name>Resolvers` is the runtime's `ServiceResolvers` imports
`ServiceResolvers as ServiceResolvers$1`. `runtime` is the module the runtime comes from: a
package's name, kept as given, or a path relative to the output's folder, without its extension,
which each file imports at its depth. `importExtension` is what every relative import ends with,
the messages' and the runtime's alike.

**Its messages.** Where a binding is `proto`, protoc-gen-es writes the messages in beadc's process
(`target=ts,erasable_syntax=true`), as `buf generate` writes them: the files that declare them and
every file of the project they import, `bead/options_pb.ts` among them where a file imports Bead's
options, since a `_pb.ts` imports the `_pb.ts` of each file its descriptor depends on; protobuf's
well-known types are `@bufbuild/protobuf/wkt`'s. With `messages: external`, beadc writes none, and
the target imports them from `messagesOut`.

**Its goldens**, under [`test/golden/typescript/`](test/golden/typescript/): the comments fixture's
`bead/comments/v1/comments_bead.ts`, whose descriptions hold `*/`, markup, a backslash, an astral
character and two paragraphs, and the messages fixture's `messages_bead.ts`, `messages_pb.ts` and
`bead/options_pb.ts`, the fixture a root of its own, [`test/messages/`](test/messages/), each
importing the runtime by the package's name. A test writes them again and compares them byte for
byte, their header's versions written as today's first, since a release moves the versions and
never a golden; `BEADC_WRITE_GOLDEN=1 yarn test` writes them. `yarn type-check` compiles them as a
consumer does, under their own [`tsconfig.json`](test/golden/typescript/tsconfig.json): the
TypeScript side's strictness and its `Bundler` resolution, the runtime's name mapped to its source;
then under [`tsconfig.floor.json`](test/golden/typescript/tsconfig.floor.json), against the
header's floor, `@bufbuild/protobuf` 2.13.0, installed beside the pin as `@bufbuild/protobuf-floor`,
an npm alias that `version.test.ts` holds to `PROTOBUF_FLOOR`. Their lint is the TypeScript side's,
over the code it generates. A consumer of what they mark,
[`test/consumer/use-deprecated.ts`](test/consumer/use-deprecated.ts), is linted with
`typescript/no-deprecated` alone, type-aware: each use a caller or an implementer makes is reported
with its text, and none of the goldens' own; `yarn type-check` compiles it, so a callback taken
through a deprecated overload stays typed.

## The C# target

`beadc generate` writes, for each `.proto` file that declares a service, `<File>Bead.cs` beside the
`<File>.cs` protoc writes for it, in the folder of its C# namespace, `Bead/Messages/V1/MessagesBead.cs`
for `bead/messages/v1/messages.proto`, its file's base name in Pascal case as protoc names it,
whichever the source; for a service with no `proto` member, `<Name>Bead.cs` at the folder's root,
in the output's `namespace`: the interop's is `InteropBead.cs`, in `Bead.Interop`. A file's
namespace is its `csharp_namespace`, or its package in Pascal case, as protoc's C# generator gives
it, for a `.proto` source; the output's `namespace` for a blueprint, which carries no language's
option, so one contract generated from its `.proto` and from its blueprint lands in one folder
where the output names the file's namespace. The target is a
printer of its own: every type it names is qualified from `global::`, so it manages no `using`, and
no type of the namespace takes a runtime type's place. A file holds, for each of its services:

- **`<Name>Procedures`**: a descriptor each, `RequestProcedure` or `CommandProcedure`, its
  procedure as the runtime takes it, its deprecation and its payload limit among them, its
  admission, and its codecs, `PayloadCodecs.Raw`, `.Text` or `.Json`, or `PayloadCodecs.Of` over
  Google.Protobuf, at a nesting limit of 101, for a `proto` binding; then `All`, every one in their
  ids' order;
- **`<Name>Failures`**, a class of failures for each procedure that lists any, its values its own,
  and `Is`, which tells a failure received by the service's catalogue;
- **`<Name>Admissions`** and **`<Name>Windows`**, the records of its hooks, each required, and of
  the windows of its procedures that notify, which the service layer's options take typed by the
  service; and **`<Name>Commands`**, **`<Name>Notifiers`** and **`<Name>Notifications`**, a member
  a command, a procedure that notifies, and its notification;
- **`<Name>Server<TData>`**, where only resolvers are written: the layer's `Command`, `Notify`,
  `On`, `Offer` and `ProceduresWithoutResolver`, over the layer's options, `ServiceServerOptions`,
  given in its one constructor where a procedure names a hook, or by a second, beside one that takes
  none, where none does;
- **`<Name>Client`**, over its Bead client, the layer's options after it: a requester of each
  procedure its server answers, by its rpc's name, its `Notifications` and `On`;

and, once, the contract with the runtime, `GeneratedCode.SupportsVersion2`. Every doc comment is the
description, then what the procedure admits, through one writer: one `///` a line, the text
XML-escaped, a `<para>` a paragraph where there are two, and each character C# reads as a line's
end besides LF, CR, NEL, LS and PS, written as its reference, `&#xD;`; a string literal writes them
as escapes.

**A deprecation is marked**
`[global::System.Obsolete("<its text>", DiagnosticId = "BEAD0001")]`, the blueprint's message or
`No replacement is named.`, which CA1041 asks of a mark, on each declaration the file writes for it,
as protoc's C# generator and gRPC's mark a deprecated rpc: a procedure's, its own or its service's,
on its descriptor, its requester, and its members of `<Name>Commands`, `<Name>Notifiers`,
`<Name>Notifications` and `<Name>Windows`, a required member's on its getter, since C# refuses the
mark on a required member of a type that is not obsolete (CS9042); `On(<Name>Procedures.X, …)`
names the descriptor, so the resolver's registration is marked through it. A failure's is on its
member of the class of failures, which a resolver answers and a caller's `Is` names; a service's on
every type the file declares for it. `BEAD0001`, .NET's form for a library's own deprecation, as
`SYSLIB0001`, is every mark's id: a consumer under `TreatWarningsAsErrors` keeps Bead's warnings
with `<WarningsNotAsErrors>BEAD0001</WarningsNotAsErrors>`, or silences them with `<NoWarn>` or a
`#pragma`, while every other library's `CS0618` still fails. The service's own implementer meets
the mark too, who still serves the procedure. Each side scopes Bead's deprecations with its
platform's own means; the behaviour, a deprecation reported at each use, is one.

**Its header** is beadc's, as the TypeScript target writes it, and ends with `// <auto-generated/>`,
Roslyn's mark of generated code, so a consumer's analyzers and `dotnet format` leave the file alone;
then `#nullable enable`, which a file so marked needs, and, in every file, protoc's and gRPC's own
form, the warnings of a deprecated member, protobuf's or Bead's, disabled where the file names one:
a compiler's warning is no analyzer's, which `<auto-generated/>` silences, and a message protobuf
deprecates is named by the codecs and the requesters of a procedure that binds it, deprecated or
not:

```csharp
// @generated by beadc <version> from spec/interop-blueprint.json: bead-blueprint/1, spec <specVersion>.
// Do not edit: regenerate with beadc.
// <auto-generated/>

#nullable enable
#pragma warning disable CS0612, CS0618, BEAD0001 // a deprecated member, protobuf's or Bead's, is named by its own file

namespace Bead.Interop;
```

Where the output generates messages, a third line names protoc's version and the oldest
Google.Protobuf its code runs on, both the pin's. Where a project's own rules should judge the file
anyway, as Bead's do, its `.editorconfig` says so: `[*Bead.cs]` `generated_code = false`.

**Its messages.** Where a binding is `proto`, protoc's C# generator, the stock one, writes the
messages from buf's set alone (`--descriptor_set_in`): the files that declare them and every file of
the project they import, then `bead/options.proto`, where they import it, in a run of its own with
`internal_access`, so each project keeps its copy to itself. Both runs take `base_namespace=`,
protoc's own option, so each file lands in its namespace's folder and two files of one name in two
packages never meet. From buf's set, protoc writes the code it writes from the `.proto` itself; its
embedded descriptor differs by each field's `json_name` alone, the default, which buf's set writes
and protoc's own leaves out. protoc is the [pinned](#building-and-testing) one. With
`messages: external`, beadc writes none and names each message by its namespace, as a project's own
build compiles them, Grpc.Tools among them.

**Its goldens**, under [`test/golden/csharp/`](test/golden/csharp/): the comments fixture's
`Bead/Comments/V1/CommentsBead.cs` and the messages fixture's `Bead/Messages/V1/MessagesBead.cs`,
with protoc's `Bead/Messages/V1/Messages.cs` and `Bead/Protobuf/Options.cs`; the messages fixture
holds a nested message, a `oneof`, a `map` and an `optional` field. A test writes them again and
compares them byte for byte, their header's versions written as today's first; beadc's own files
need no protoc, their messages' line being the pin's, and protoc's are compared where the pinned
protoc runs. The C# side's solution builds them as a consumer does, in
[`implementations/dotnet/tests/Bead.Goldens`](../implementations/dotnet/tests/Bead.Goldens/Bead.Goldens.csproj),
under that side's analyzers and every warning an error; their code style is that side's
`.editorconfig`, of which the goldens' own is a copy, since an `.editorconfig` reaches only the files
under its folder, and a test holds the two equal, byte for byte. A consumer of what they mark,
[`test/consumer/UseDeprecated.cs`](test/consumer/UseDeprecated.cs), the TypeScript consumer's twin,
is compiled with them by Roslyn in
[`Bead.Goldens.Tests`](../implementations/dotnet/tests/Bead.Goldens.Tests/Bead.Goldens.Tests.csproj),
every warning a warning: each use is `BEAD0001`'s with its text, and none of the goldens' own is
reported, protobuf's `CS0612` and `CS0618` none either.

## The rules

A rule's **level** says where it applies: `proto`, on a `.proto` input, each with its fixture under
[`test/proto/`](test/proto/); `blueprint`, on any blueprint, one written by hand included, each with
its cases under [`test/blueprints/`](test/blueprints/), a JSON Patch (RFC 6902) of the interop's
blueprint and the findings it gives by rule name at their JSON Pointers, or, for what a patch cannot
state, a raw text under [`test/form/`](test/form/); or `breaking`, between two blueprints, the
earlier and the current, as [breaking](#breaking) says, each with its cases under
[`test/breaking/`](test/breaking/).

On a blueprint, the rules run in one order, and a stage that finds an error ends the reading: its
JSON and I-JSON, its format, its features, the format's schema, then the rules that span entries and
its `specVersion`. A refusal of the schema maps to its rule by its place in the blueprint; a
refusal at a place no rule names is `BLUEPRINT_SCHEMA`. The findings on identities come in spec
16.10's order: a range's first, then a name's form.

| Rule                     | Level     | Severity | Refuses                                                                                                                                                              | Because                                                                                                                                                               |
| ------------------------ | --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROCEDURE_OPTIONS`      | proto     | error    | an rpc of a Bead service without `(bead.procedure)`                                                                                                                  | its id cannot be guessed                                                                                                                                              |
| `SERVICE_SKIPPED`        | proto     | warning  | a service without `(bead.service)`                                                                                                                                   | a forgotten option would drop a service in silence                                                                                                                    |
| `STREAM_RESERVED`        | proto     | error    | `stream` on either side                                                                                                                                              | kept for Bead's streams; a subscription is no stream                                                                                                                  |
| `ADMISSION_DEFAULT`      | proto     | error    | a Bead service whose file and service state no admission                                                                                                             | the runtime's default admits every call                                                                                                                               |
| `ADMISSION_EMPTY`        | both      | error    | an admission that states no rule: on a `.proto`, no member of `oneof rule` set; on a blueprint, `{}`                                                                 | an admission says who may call                                                                                                                                        |
| `DEPRECATION_MESSAGE`    | proto     | error    | a `deprecation_message` without `option deprecated = true`                                                                                                           | one place says it                                                                                                                                                     |
| `FAILURES_ENUM`          | proto     | error    | a `failures` naming no enum of the set; an `allow_alias` on it; a procedure's failure naming no value of it                                                          | the catalogue must exist, one name a code                                                                                                                             |
| `PAYLOAD_TYPE_FIELD`     | proto     | error    | a field or an extension, a file's or a message's, whose type is `bead.Raw`, `bead.Text` or `bead.Json`; a map whose values are, by its own name                      | their protobuf form is never written                                                                                                                                  |
| `OPTIONS_COPY`           | proto     | error    | a `bead/options.proto` among the project's roots, read before buf compiles                                                                                           | beadc compiles its own                                                                                                                                                |
| `BLUEPRINT_JSON`         | blueprint | error    | a text not UTF-8, at its byte; a member twice, a surrogate alone, a number with a fraction or an exponent, at its JSON Pointer                                       | I-JSON (RFC 7493 §2.1, §2.3); a reader's value changes                                                                                                                |
| `FORMAT_UNKNOWN`         | blueprint | error    | a `format` but `bead-blueprint/1`                                                                                                                                    | a reader refuses a major it does not know                                                                                                                             |
| `FEATURE_UNKNOWN`        | blueprint | error    | a `requires` naming a feature this beadc does not know (none yet)                                                                                                    | never ignored in silence, as JOSE's `crit` (RFC 7515 §4.1.11)                                                                                                         |
| `BLUEPRINT_SCHEMA`       | blueprint | error    | a refusal of the format's schema at a place no rule names: a member unknown, a type, a member missing                                                                | the format is its schema                                                                                                                                              |
| `SERVICE_ID_RANGE`       | blueprint | error    | a service id missing, 0, or past 65,535                                                                                                                              | u16 (spec 16.2); 0 is the protocol's (16.3)                                                                                                                           |
| `SERVICE_REVISION_RANGE` | blueprint | error    | a revision missing, 0, or past 2,147,483,647                                                                                                                         | 0 means unknown to a relay (16.9)                                                                                                                                     |
| `PROCEDURE_ID_RANGE`     | blueprint | error    | a procedure id missing, 0, or past 65,535                                                                                                                            | u16, never 0 (16.2)                                                                                                                                                   |
| `FAILURE_CODE`           | blueprint | error    | a failure code below 1 or past 65,535, or two failures of one code                                                                                                   | codes 1 to 65,535 (spec 9.5), one name a code                                                                                                                         |
| `PROCEDURE_LIMIT_RANGE`  | blueprint | error    | a `maximumPayloadBytes` below 1 or past 2,147,483,647                                                                                                                | C#'s `int?`                                                                                                                                                           |
| `RESERVED_RANGE`         | blueprint | error    | a reserved range whose first or last is 0 or past 65,535, or whose first is after its last                                                                           | ranges of real ids                                                                                                                                                    |
| `NAME_FORM`              | blueprint | error    | a name off its form: a procedure's, a hook's, a service's, a failure's, a reserved one's                                                                             | one name in every casing, out of the debug filter's grammar (spec 16.4, 16.5)                                                                                         |
| `SERVICE_ID_UNIQUE`      | blueprint | error    | two services of one id                                                                                                                                               | one blueprint is one id space                                                                                                                                         |
| `PROCEDURE_ID_UNIQUE`    | blueprint | error    | two procedures of a service of one id                                                                                                                                | one address, one procedure                                                                                                                                            |
| `ID_RESERVED`            | blueprint | error    | a service id, procedure id or failure code its scope reserved                                                                                                        | an id is for life (16.8)                                                                                                                                              |
| `NAME_UNIQUE`            | blueprint | error    | two names of one scope that are one, as [the names](#the-names) say                                                                                                  | a filter folds ASCII case (16.6)                                                                                                                                      |
| `NAME_RESERVED`          | blueprint | error    | a procedure or service name its scope reserved, compared as 16.6 compares                                                                                            | a retired name keeps its dashboards                                                                                                                                   |
| `ENCODING_FIT`           | blueprint | error    | a `proto` binding to `bead.Raw`, `bead.Text` or `bead.Json`                                                                                                          | a payload type's encoding is its own                                                                                                                                  |
| `NOTIFICATION_MESSAGE`   | both      | error    | a notification binding missing on a procedure that notifies, or present on one that does not; on a `.proto`, a `notifies` naming no message of the set               | the notifications' type; a command notifies nothing                                                                                                                   |
| `NOTIFICATION_RESULT`    | blueprint | warning  | a procedure that notifies whose result is `raw`                                                                                                                      | a subscription's result goes in one envelope (spec 11.6)                                                                                                              |
| `FAILURE_UNKNOWN`        | blueprint | error    | a procedure listing a failure its service's catalogue lacks                                                                                                          | the list narrows the catalogue                                                                                                                                        |
| `BINDING_SOURCE`         | blueprint | error    | a `proto` binding whose message `proto.messages` does not list, or a blueprint with a `proto` binding and no `proto`                                                 | such a blueprint is never taken alone                                                                                                                                 |
| `PROTO_FILE`             | blueprint | error    | a `proto` path off its form, `..`, absolute or by a backslash, or one `proto.files` does not list; a service's `proto` in a blueprint with no `proto`                | a path a blueprint carries names a file the front end read, and nothing else: relative, by `/`, free of `.` and `..`, as protoc's plugin protocol holds a file's name |
| `NAME_TARGET`            | both      | error    | a name an official target reserves, as [the names](#the-names) list them; on a `.proto`, a class a service gives that a message or an enum of its C# namespace holds | the key must be the name                                                                                                                                              |
| `DESCRIPTION_TARGET`     | blueprint | error    | a description, a service's, a procedure's or a failure's, holding a C0 control but tab, LF and CR, or U+FFFE or U+FFFF                                               | XML 1.0's `Char` holds none of them, so no C# documentation comment writes one, raw or by reference                                                                   |
| `SPEC_VERSION_NEWER`     | blueprint | warning  | a `specVersion` newer than the spec this beadc follows                                                                                                               | its identity rules may be ones beadc does not know; `format` and `requires` carry the rest                                                                            |

## The form

A blueprint has one form: its members in RFC 8785's order, by their names' UTF-16 code units; its
strings escaped as RFC 8785 escapes them; its numbers integers; two spaces of indentation, a final
line feed, UTF-8 without a byte order mark; its arrays sorted by identity: files by path, messages
by full name, services by id, procedures by id, failures by code, a procedure's failures in their
codes' order, ranges ascending, names in their code points' order. `beadc blueprint` writes every
blueprint in it, and `beadc blueprint --check` and `spec/check.py` hold one to it. A layout off its
form is no rule of `check`, as `buf lint` leaves layout to `buf format`.

## Breaking

`beadc breaking` holds the input to an earlier release of it, which `--against` names, and writes
nothing (spec 16.8 and 16.9,
[decision 0022](../docs/decisions/0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
It checks the input whole first, as `generate` does: an error there is `check`'s, exit 1, and
nothing is compared.

```sh
./beadc.sh breaking --against-ref v0.3.0                            # through a wrapper, at a tag
git archive --format=tar v0.3.0 | ./beadc.sh breaking --against -   # the same, piped by hand
node builder/src/cli.ts breaking --against ../bead-0.3.0            # on Node: a release's tree
node builder/src/cli.ts breaking spec/interop-blueprint.json --against earlier.json --category WIRE
```

Through a wrapper, `--against` names what the container sees: a folder under the project's, or `-`.

**Two categories, `WIRE` within `API`**, as Google's AIP-180 parts compatibility: `WIRE`, a peer
built from the earlier still talks with one built from the current, its wire compatibility widened
from the bytes to the peer, since a call answered `PROCEDURE_UNKNOWN` breaks a peer whose bytes
still parse; `API`, the default, besides, code written against the earlier's generated API still compiles
and means the same, and so do the metrics and filters that name a procedure. `API` holds every
`WIRE` rule.

**By id.** A service is compared by its `serviceId`, a procedure by its `procedureId` within its
service, a failure by its `code`. A name is compared exactly, as a generated member is named, but
where a reservation or a name's absence is read, which compares as spec 16.6 does. Each finding is
placed in the current input, at its JSON Pointer into the current blueprint, or on a `.proto` at the
place that pointer has there, its line ending with the pointer, ` (at /services/0/serviceRevision)`,
which `json` writes as `pointer`. A deletion is placed where its fix goes, the reservation, its
message naming the earlier's entity and its pointer. **Each finding names its subject**, its entity
by ids, which no shift moves: `service:1`, `service:1/procedure:4`, `service:1/failure:7`,
`service:1/procedure:4/failure:7`, `service:1/hook:audited`; a reservation the earlier declared,
`service:1/procedure:19-21` or `service:1/procedure:19`, `service:2-3`, `service:1/name:fail`,
`name:Retired`; a deletion the earlier's entity. Its line ends with it, ` [service:1/procedure:4]`,
which `json` writes as `subject`. It is AIP-122's hierarchy of kinds and ids, each step written
`kind:id` rather than AIP-122's `services/1/procedures/4`, which, a pointer pasted without its
slash, would read as one; SARIF 2.1.0's `logicalLocations[].fullyQualifiedName` is the field, should
`json` grow locations. A service or a procedure the earlier deprecated
and the current takes out, its id reserved, passes `WIRE` and is a finding under `API`, its
generated code gone: it goes in a release that moves the major, the minor before 1.0, which waives
it there.

| Rule                            | Category | Refuses                                                                                                                                                                                                                                                             | Because                                                                                                                                                                             |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVICE_NO_DELETE`             | WIRE     | a service id gone, unless the earlier deprecated the service and the current reserves its id; under `API`, a service id gone, deprecated and reserved or not                                                                                                        | a peer's call is answered `SERVICE_UNKNOWN`; its generated client and server go with it, which buf's `FILE` refuses alike                                                           |
| `PROCEDURE_NO_DELETE`           | WIRE     | a procedure id gone from a service both hold, unless the earlier deprecated it, or its service, and the current reserves its id; under `API`, a procedure id gone, deprecated and reserved or not                                                                   | it is answered `PROCEDURE_UNKNOWN`; the id travels, the name does not; its requester and its resolver go with it, which buf's `FILE` refuses alike                                  |
| `FAILURE_NO_DELETE`             | WIRE     | a failure code gone from its catalogue, unless the current reserves it                                                                                                                                                                                              | a code reused means another failure to an earlier peer                                                                                                                              |
| `RESERVED_NO_DELETE`            | WIRE     | an id, a code or a name the earlier reserved that the current does not, ranges read as their ids, names as spec 16.6 compares them; one finding a range the earlier declared, whatever part of it the current released, its subject that range                      | a reservation is for life (16.8)                                                                                                                                                    |
| `PROCEDURE_SAME_KIND`           | WIRE     | a command that became a request, or a request, notifying or not, that became a command                                                                                                                                                                              | the caller and the answerer trade places                                                                                                                                            |
| `PROCEDURE_STILL_NOTIFIES`      | WIRE     | a procedure that notified and no longer does                                                                                                                                                                                                                        | an earlier subscriber is answered, holds nothing and hears nothing more                                                                                                             |
| `PROCEDURE_SAME_ENCODING`       | WIRE     | a binding's encoding changed: its request's, its result's or its notification's                                                                                                                                                                                     | the bytes are read another way (spec 17)                                                                                                                                            |
| `PROCEDURE_MESSAGE_SWITCHED`    | WIRE     | a `proto` binding whose message is another, by its full name                                                                                                                                                                                                        | buf compares a message with its namesake alone, so nobody compared these two: check them by hand, then waive it                                                                     |
| `PROCEDURE_SAME_LIMIT`          | WIRE     | `maximumPayloadBytes` changed, either way, stated or left to the router                                                                                                                                                                                             | both ends hold the limit, and nothing announces it (spec 12.2)                                                                                                                      |
| `PROCEDURE_ADMISSION_TIGHTENED` | WIRE     | `none` become `session` or a hook; `session` become a hook; a hook become `session`                                                                                                                                                                                 | a peer that never opens a session, or that a hook admitted, is refused                                                                                                              |
| `SERVICE_SAME_NAME`             | API      | a service renamed; from a `.proto`, its full name changed, moved to another package                                                                                                                                                                                 | its generated types are imported by its name                                                                                                                                        |
| `SERVICE_SAME_FILE`             | API      | from a `.proto`, a service declared in another file                                                                                                                                                                                                                 | the TypeScript target writes its code at `<file>_bead.ts`, which every import names                                                                                                 |
| `SERVICE_SAME_HOOKS`            | API      | the hooks a service's procedures name, as a set, compared exactly: one finding a hook added or gone                                                                                                                                                                 | its server's options name each, required                                                                                                                                            |
| `PROCEDURE_SAME_NAME`           | API      | a procedure renamed, a letter's case included                                                                                                                                                                                                                       | its requester, its resolver and its C# rpc name follow it, and the metrics and filters read it                                                                                      |
| `PROCEDURE_SAME_MESSAGES`       | API      | a `proto` binding whose message is another, by its full name                                                                                                                                                                                                        | the generated types change                                                                                                                                                          |
| `PROCEDURE_SAME_HOOK`           | API      | a procedure admitted by another hook                                                                                                                                                                                                                                | beadc cannot read a hook's code, and the generated member is another                                                                                                                |
| `FAILURE_SAME_NAME`             | API      | a code's failure renamed                                                                                                                                                                                                                                            | `<Name>Failures` and the C# classes of failures name it                                                                                                                             |
| `PROCEDURE_FAILURE_NO_DELETE`   | API      | a failure, by its code, taken out of a procedure's list while its catalogue keeps it                                                                                                                                                                                | the procedure's C# class of failures loses a member, and the TypeScript union narrows                                                                                               |
| `NAME_NO_DELETE`                | API      | the name the earlier gave a service id, or a procedure id within a service both hold, that the current gives that id no more, as spec 16.6 compares, and does not reserve, held by another id or by none; a failure's code gone from its catalogue, reserved or not | a name never comes to label another procedure (16.8); a failure's generated member goes with its code, which buf's `FILE` refuses alike, and no blueprint reserves a failure's name |
| `SERVICE_REVISION`              | API      | a revision lower than the earlier's; the earlier's, where the service changed                                                                                                                                                                                       | it counts the releases of its contract, moves in a release whose contract differs, and never goes back (16.9)                                                                       |
| `PROTO_SKIPPED`                 | warning  | buf's comparison of the `.proto` not run, where either side was read from a `.proto` or binds a `proto` message: a side a blueprint alone, or an earlier `.proto` this beadc does not compile                                                                       | as with `SERVICE_SKIPPED`, a check not run is said; `--fail-on-warning` refuses it                                                                                                  |
| `AGAINST_BLUEPRINT`             | warning  | an earlier folder whose committed blueprint its `.proto`, compiled by this beadc, contradicts, compared by id under `API`, the first finding named; one whose `beadc.yaml` names a blueprint it does not hold                                                       | Bead's rules read the blueprint and buf's the `.proto`: two readings of one release are said to differ, never compared in silence                                                   |
| `WAIVER_UNUSED`                 | warning  | an `--except`, bare, scoped or buf's, that waived no finding of the run, "neither side holds it" where neither holds its subject's entity by id nor reserves its id or name; nothing waives it                                                                      | a suppression no finding used is said, as ESLint, ruff, `@ts-expect-error` and IDE0079 say one: a mistyped subject, or a change a release has taken                                 |

A service or a procedure the current adds, a failure added to a catalogue or to a list, a request
that comes to notify, a window, a deprecation, a description and a reservation added break nothing.

**What moves a revision.** A service both sides hold, by id, has changed where any of Bead's rules
finds on it, before any waiver; where it loses a procedure, or gains one, a failure in its
catalogue or in a procedure's list, a reservation, a request that comes to notify, or an admission
loosened; where a
deprecation, a procedure's, the service's or a failure's, is added, changed or withdrawn; and,
where both sides are buf images, where a message one of its `proto` bindings reaches, by its
fields' types, changed, compared as its `DescriptorProto` with what of its file reaches the wire
or a Bead target's API, its `syntax`, its `edition` and its own `features`, which with the edition
give its resolved features, and its `csharp_namespace`, which the C# target's namespace reads; so a
field added, or an edition's `DELIMITED`, moves the revision though no blueprint shows it. Another
language's file option, `go_package` and its kind, moves none: buf's `FILE` holds it under `API`;
nor does `(bead.file)`, whose admission and reservations the blueprints' compare holds. Its revision is
then the earlier's plus one at least, and otherwise the earlier's at least. A jump, and a move where
nothing changed, are no finding: `--against` may name any release, so beadc cannot know the one it
names came just before. A service the current adds is held to nothing. Each is read through the
model, never as bytes: an earlier in another member or array order changes nothing, nor does a
description.

**A waiver.** A finding is waived by `--except`, in the call a reviewer reads:

- `--except <RULE>` waives every finding of that rule, for a run at a desk; it also leaves out a
  warning of `check`'s;
- `--except <RULE>@<subject>` waives that rule's finding whose subject is that subject, exactly,
  as its line prints it: `PROCEDURE_NO_DELETE@service:1/procedure:8` waives the one procedure and
  no other, wherever a deletion or an addition before it moves it in the array. A scope is a
  subject of the rule's own kind, one entity: `PROCEDURE_SAME_NAME@service:1` is refused, exit 2,
  naming the form, `service:<id>/procedure:<id>`, and so are a subject off the grammar, a scope that
  begins with `/` or is empty, a pointer, which shifts, and a scope on a rule that finds no subject.
  A run of ids is matched as the finding prints it, the earlier's declaration, never as a scope over
  other findings;
- `--except buf:<RULE>` and `--except buf:<RULE>@<path>`, a `.proto` file or folder either side's
  roots hold: beadc runs buf without them, then waives buf's findings of that rule, under the path
  where it names one, as buf's `ignore_only` matches a path, the file itself or a file under the
  folder at a part's boundary. A rule buf does not know at its pin is refused, whether buf runs or
  not, and so are one beadc excepts always and one the category's `use`, buf's `WIRE` or `FILE`,
  does not run.

**A waiver that waived nothing is said**, `WAIVER_UNUSED`, a warning, one an `--except` that waived
no finding of the run, bare, scoped or buf's, at the current input's file:
`--except PROCEDURE_SAME_NAME@service:1/procedure:4 waived nothing: take it out`, with `, and neither
side holds it` where neither side holds the subject's entity by id nor reserves its id or name,
which points at a typo. A well-formed subject neither side holds is that warning, never exit 2:
beadc cannot tell a typo from a change a release has taken. `--fail-on-warning` refuses it, and
nothing waives it: `--except WAIVER_UNUSED` is refused.

An `API` rule under `--category WIRE`, which runs none, is refused. The repository's CI scopes each
waiver to its subject, so a waiver kept until the next release waives the change it was written for
and no other, and its life ends with the release, as [its gates](#its-gates) say.

**The earlier is read, never judged.** The beadc of its release accepted it, and a later beadc may
refuse it by a rule added since. A blueprint, given or committed, is read through its JSON, its
format, its features and its schema, its rules that span entries and its `specVersion` not run;
a refusal is exit 2, its first finding quoted. A folder's `beadc.yaml` is read for its `version`,
its `source` and its `blueprint` alone, so an output key a later beadc dropped stops nothing. A
folder whose `beadc.yaml` names a blueprint it holds gives Bead's rules that blueprint, the
release's own, which `generate` writes and `generate --check` holds, so a derivation this beadc
changed since is a finding of the names it changed; its `.proto` is compiled for buf's rules alone,
its `.proto` rules not run, and a compile this beadc refuses is `PROTO_SKIPPED`, naming buf's first
message. Without a committed blueprint, the folder's `.proto` gives both, and a refusal is exit 2.
Where the folder commits a blueprint and its `.proto` compiles, the two readings are compared by
id under `API`, and a finding is `AGAINST_BLUEPRINT`'s warning, naming the first; so is a blueprint
its `beadc.yaml` names and the folder does not hold, which falls back to its `.proto`. A root the
earlier's `beadc.yaml` names that is no folder, or holds no `.proto`, is refused, exit 2, named as
the `beadc.yaml` names it: `git archive` writes a submodule as an empty folder, and leaves a link
and what `export-ignore` names out.

**buf's rules** run over two buf images, each side's `.proto` roots compiled into buf's image, whose
files mark their imports, then `buf breaking --exclude-imports` under a configuration of beadc's:
`use` is buf's `WIRE` under `WIRE`, and its `FILE` under `API`, since a generated import path
follows a file and `FILE_SAME_PACKAGE` and `FILE_SAME_CSHARP_NAMESPACE` hold what a blueprint does not,
`API` holding buf's whole `FILE`, every language's file options among them;
`bead/options.proto`, a module of beadc's build and never an import, is ignored; buf's
`SERVICE_NO_DELETE` and every `RPC_*` rule are excepted, since buf keys a service and an rpc by
name, and Bead keys them by id and holds them by its own rules. A failure's enum stays buf's too:
`ENUM_VALUE_NO_DELETE_UNLESS_NUMBER_RESERVED` under `WIRE`, `ENUM_VALUE_NO_DELETE` and
`ENUM_VALUE_SAME_NAME` under `API`. Each finding is an error, its rule `buf:` and buf's,
`buf:FIELD_SAME_TYPE`, its message buf's, at buf's line and column in the current roots, or, for a
file the current lost, at the earlier's path, on disk where the earlier is a folder, else by the
path its import names. buf's exit 100 is its findings, 0 none, any other its refusal,
exit 2. `WIRE_JSON` is not run: a `json` binding's bytes are the payload itself (spec 17), never
protobuf's JSON mapping.

| `--against`                           | Bead's rules read                                                                                                                                                                                                            | buf's rules read                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| a folder holding `beadc.yaml`         | the blueprint it names, `source.blueprint` or the `blueprint` output, where the folder holds it; else its `.proto` roots, compiled                                                                                           | its `.proto` roots, compiled, where both sides have them                  |
| a folder without one                  | the current source's paths, taken from the current `beadc.yaml`'s folder into this one; a root named on the command line, the folder itself as that root; a blueprint named on the command line, refused: name the earlier's | the same                                                                  |
| `-`                                   | a tar on standard input, as `git archive --format=tar` writes it, extracted under `.beadc/` beside the current `beadc.yaml`, else the system's temporary folder, read as a folder, then removed                              | as a folder                                                               |
| a blueprint's file                    | that blueprint                                                                                                                                                                                                               | none: `PROTO_SKIPPED`, where a side came from a `.proto` or binds `proto` |
| a `.binpb`, or a file that is no JSON | refused, exit 2: a release's `.proto` is its tag's, named by its folder, piped as its `git archive`, or `--against-ref` through a wrapper                                                                                    |                                                                           |

**The archive** is read as `git archive` writes it and no further: POSIX.1-2001's pax interchange
format, 512-byte ustar headers, a global header skipped, an extended header's `path` and `size`,
which override the ustar header's as GNU tar and bsdtar read them, folders and regular files. A
link is not written, a file the ref's `.gitattributes` marks `export-ignore` is not in the
archive, and a submodule is an empty folder, as for every consumer of `git archive`: an earlier
that needs any of them is named by its folder. A path absolute, empty, holding `..` or a NUL, an
entry over a path an earlier one gave, a header off its checksum and an archive cut short, which a
`git archive` that failed leaves, are refused, exit 2; so is `--against -` whose standard input is
a terminal.

**Its cases**, beside the rules': a JSON Patch of the interop's blueprint for each side,
`earlier` and `current`, and the findings by rule name at their pointers, under the case's
category, `API` unless it names `WIRE`, which runs under both, in
[`test/breaking/<RULE>/`](test/breaking/); a `.proto` case for every rule, a shared earlier and in
each case its current, the findings by rule at their lines and columns, in
[`test/breaking/proto/`](test/breaking/proto/); buf's rules run once, over one pair that breaks a
field, in [`test/breaking/buf/`](test/breaking/buf/); and a tar `git archive` wrote, in
[`test/breaking/archive/`](test/breaking/archive/).

## Its gates

CI's `builder` job installs, fetches protoc by its pin and checks its sha256, then runs `yarn test`,
`BEADC_PROTOC_REQUIRED=1` turning a test that would skip without protoc into one that fails, then
`beadc check` and `beadc blueprint --check` over the interop's blueprint, and from the repository's
root `node builder/src/cli.ts generate --check` over the root's [`beadc.yaml`](../beadc.yaml), which
holds each side's interop to what beadc generates from its blueprint, on Linux and on Windows, on
Node 26, and on Linux on Node 24.9 besides; and `yarn check` on Linux, whose types, the goldens'
types, lint, format and generated code no platform moves. On every leg, the wrappers' tests hold
`beadc.sh` and `beadc.ps1` to one contract against a stand-in engine, a native `docker.exe` on
Windows, `BEADC_WRAPPERS_REQUIRED=1` turning a test that would skip without bash, pwsh 7.6 or, on
Windows, the right to make a symbolic link into one that fails. On Linux, last, `beadc breaking`
holds the interop's blueprint and `examples/hello` to the last `v*` tag that carries a blueprint,
`git archive` piped into `--against -`, by version order: before 0.3.0, the first such release, the
step says it holds nothing and passes; from 0.3.0, a last release without one fails it. The last
release is the newest `vX.Y.Z`, as `tools/release.mjs` reads one, whose commit is not HEAD's, read
by the tag's commit, never by ancestry, which the shallow fetch does not hold: on a release's own
commit, `main`'s, the release before it, so a waiver the release carried still waives its change
there. The step runs under `--fail-on-warning`, so a waiver that waived nothing fails it. A waiver
stands on its line, scoped to its subject, for the cycle of the change it was written for:
`tools/release.mjs tag`, which ends on `develop` at its back-merge, writes the CI file without the
waivers the tagged commit carries, and prints the commit before the one push, which carries
`develop`'s tip without them; `prepare`, on a hotfix, which starts from `main`, writes it without
every waiver, each moot since the release `main` holds. A branch behind a release's merge-back
merges `develop` first, or meets the release's moot waivers. On the image's legs, Linux on
Node 26, amd64 on `ubuntu-26.04` and arm64 on `ubuntu-26.04-arm`, each natively: the image's test
stage, beadc's tests on the image's own Node, protoc and environment; then the image, which
`yarn test` runs through each wrapper under `BEADC_IMAGE_REQUIRED=1`: `beadc version`,
`generate --check` over the root's `beadc.yaml` and over
[`examples/hello`](../examples/hello/README.md)'s, the messages fixture in both languages, a
project's files written as the caller and an interrupt's 130; and shellcheck 0.11.0, from its image
by its digest, and PSScriptAnalyzer 1.25.0 over the wrappers. The C# side's `dotnet` job builds the
C# goldens in its solution, under that side's gates, and `dotnet format` leaves them to their
generator.
