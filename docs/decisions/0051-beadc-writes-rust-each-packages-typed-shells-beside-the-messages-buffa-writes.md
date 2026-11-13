# 0051 — beadc writes Rust each package's typed shells beside the messages Buffa writes

- **Status**: accepted
- **Scope**: beadc's Rust target, `rust`: the layout of an output, its three roots `messages`,
  `services` and `bead_served`, the names it renders, its descriptions and deprecations, the typed
  shells of each package's services and the lists of the procedures a server's transports take; its
  messages, through the pinned `protoc-gen-buffa` (`messages: generate`) or an application's build
  script through `bead_protobuf_build::config_of` (`messages: external`), and the pin of the plugin
  beside Buffa's crates required exactly; the validators' runtime in `bead-protobuf`; the Rust
  side's counter of the contract with generated code, 7 and 8; `ProtoCodec::new`'s refusal of a
  message whose generator left a repeated closed enum closed; the crate `bead-goldens` and the gates
  of the Rust goldens; `examples/hello`'s Rust half; and the Rust interop's descriptors, generated.
  The builder, its blueprint, its outputs and its other targets stay
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s,
  the layer the shells stand on and the counter's rule
  [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s,
  an output's selections and its served lists
  [0048](0048-one-contract-gives-several-packages-and-a-servers-transport-takes-the-procedures-it-is-given.md)'s,
  a payload's rules [0035](0035-a-payload-that-reads-is-held-to-its-messages-rules-before-its-resolver-sees-it.md)'s,
  a closed enum [0042](0042-a-proto-message-that-leaves-a-required-field-unset-neither-reads-nor-writes-and-a-gateway-refuses-it-where-its-server-would.md)'s,
  the Rust side's rules [0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)'s
  and the surface [0047](0047-every-side-shows-one-public-surface.md)'s. Ahead: the Rust target's
  `http: true`, its route table, its `<Service>HttpClient`, the document an output with `gateway`
  writes and `examples/hello`'s Rust gateway, with the gateway's stage, the matrix's row
  `Rust's gateway`, under a record of its own.

## Context

**What the other two targets write.** The TypeScript target writes a file a `.proto` file that
declares a service, `<file>_bead.ts`, at the `.proto`'s path, and a native service's
`<service>_bead.ts` at its output's root; the C# target `<File>Bead.cs` in its namespace's folder,
every type `global::`. Each writes a service's descriptors, its catalogue, its server and client
classes over the layer's `ServiceServer` and `ServiceClient`, its hooks, its windows and its
options, its requests' validators, and, where an output's server names its transports, the file of
the procedures each takes. Each target's goldens are written again and compared
(`BEADC_WRITE_GOLDEN=1`); the C# goldens build under the C# side's gates in `Bead.Goldens`, in the
`dotnet` job, not the builder's. `CLASS_SUFFIXES` and `RUNTIME_TYPES`
(`builder/src/targets/names.ts`) are compared with a blueprint's message names and a C#
namespace's types: the scopes a TypeScript file and a C# namespace share with messages. Procedures
and hooks are unique under spec 16.6's folding (`foldOf`, `builder/src/model/identity.ts`); a
transport's key is `^[a-z][A-Za-z0-9]*$`, not folded.

**What the Rust side holds to build on.** Its descriptors carry no service type, and `ServiceServer`
refuses a descriptor that is not `Arc::ptr_eq` to its own (`crates/bead/src/service.rs`); a
resolver is `ResolverCallback<Req, Res>`, an `Arc<dyn Fn(…) -> BoxFuture<…>>`
(`managers/service.rs`). `bead-protobuf` holds the `proto` codec on Buffa 0.9.2, and
`bead-protobuf-build`'s `config_of` sets Buffa's generator as the codec reads a message: views,
vtable reflection, unknown fields, `MessageSet`, and each repeated or map field of a closed enum
opened (`open_enums_in(opened_of(…))`).

**The standards.**

- **The Cargo Book, "Build Scripts"**: a build script writes into `OUT_DIR` and runs on every
  machine that builds the crate, docs.rs and an offline build among them. A build script that ran
  beadc would need Node or a container at every `cargo build`; Bead's code is committed.
- **Buffa's two modes** (`buffa-build` 0.9.2): a build script into `OUT_DIR`, or checked-in code,
  which it prefers ("Prefer running `buf generate` with the `protoc-gen-buffa` plugin and checking
  in the generated code"), its tree rooted at the `include_file("mod.rs")` it names. Buffa's
  checked-in tree, mounted out of line as `pub mod messages;` under one `#[allow]`, is clean under
  the Rust workspace's whole lint table, its documentation and its formatter, and gives a binary of
  default lints no warning.
- **`buffa-codegen`'s `ALLOW_LINTS`**: Buffa allows on its own modules what its code trips,
  `dead_code` among them, written on each package's module with `use super::*;`.
- **Buffa's `__private`**: "Not part of the public API. These items may change or disappear in any
  release" (`buffa` 0.9.2), and the generated messages name it, so committed code and its runtime
  are held to one version.
- **The protobuf plugin protocol** (`google/protobuf/compiler/plugin.proto`): a plugin reads one
  `CodeGeneratorRequest` and writes one `CodeGeneratorResponse`, so beadc can hand
  `protoc-gen-buffa` its request itself, as it hands protoc its set.
- **The Rust API Guidelines**: C-CASE ("in snake_case, acronyms and contractions are
  lower-cased"), C-GETTER and C-CTOR; RFC 2008, `#[non_exhaustive]` binding other crates alone; RFC
  3513, `gen` reserved in edition 2024.
- **The Rust Reference**: raw identifiers, and `self`, `super`, `crate` and `Self`, which cannot be
  raw; a lint's level applies where its item is used, so a module's `allow(deprecated)` silences its
  own uses and never a consumer's.
- **gRPC-Go's `SupportPackageIsVersion`**, which 0018's counter follows.
- **protovalidate**'s `validate.proto` v1.2.2, and protobuf's
  [Enum Behavior](https://protobuf.dev/programming-guides/enum/).
- **CommonMark 0.31.2 §4.6**, an HTML block, which rustdoc reads; rustc's
  `text_direction_codepoint_in_comment` (CVE-2021-42574).
- **SemVer 2.0.0 §4**: before 1.0.0 a minor may break.

**`protoc-gen-buffa` 0.9.2, run as beadc runs it.** Its release's binaries are listed with their
sha256 in its `checksums-sha256.txt`, each signed keylessly (cosign, identity
`https://github.com/anthropics/buffa/.github/workflows/release.yml@refs/tags/v0.9.2`, issuer
`https://token.actions.githubusercontent.com`) and attested by SLSA provenance. Handed a
`CodeGeneratorRequest` over buf's set stripped as beadc strips it for protoc, with
`views=true,reflect_mode=vtable,unknown_fields=true,allow_message_set=true`, it writes every file
byte for byte as Buffa's checked-in mode through `config_of` writes it over the same set, for
`examples/hello` and for `spec/validations.proto`: both start from `CodeGenConfig::default()`, no
default differs, and `open_enums_in` holds on `bead-protobuf`'s own test set. It writes no module
root (`protoc-gen-buffa-packaging`, a second binary, writes one). Stripping leaves protovalidate's
and `google.api`'s files in the set each message embeds, `FILE_DESCRIPTOR_SET_BYTES`, 74 KB of it
for `hello`. A protoc run on the sources, or under `--descriptor_set_in`, embeds another set,
source-retention options or the import closure alone.

**The options not taken.**

- **A build script that runs beadc**: Node or a container at every `cargo build`.
- **A trait per service, tonic's form**: a resolver for every procedure at compile time is a
  behaviour neither other side has, and it loses registration one procedure at a time, before or
  after the offer, and `procedures_without_resolver`; a procedure that notifies answers through its
  response, so a method that returns a `Result` fits plain requests alone.
- **The layer's raw callback as the registration's parameter**: an awaiting resolver is then
  `Arc::new(move |r, s| Box::pin(async move { … }))`, and an `async fn` cannot be given by its name.
- **Bead's shells inside Buffa's package modules**: beadc then declares Buffa's tree again without
  Buffa's per-package `#[allow]`s, an application's build warns in Buffa's files and its clippy
  fails on them, Bead's crates need a blanket exception over the shells, and two `.proto` refusals
  follow.
- **A module per `.proto` file**: a file's stem is no identifier in general (`2fa.proto`,
  `my-service.proto`, `hello.v2.proto`, each taken by the blueprint's schema), two files of one
  package can share a stem, and its name would need a rendering and a refusal of its own. **A module
  per service**: the rules of a message two services share would be written twice in one package.
- **`Requesters` in `CLASS_SUFFIXES`, the Rust newtypes in `RUNTIME_TYPES`**: a refusal on every
  blueprint for a collision no Rust output has.
- **Snake case split at each capital**, `get_h_t_t_p_status2`: against C-CASE, and against Buffa's
  rule in the same output.
- **An owned `serde_json::Value` for a violation's value**: a deep copy of a peer's string or list
  at each violation, held or counted, and `serde_json` a dependency of every application.
- **`#[expect(deprecated)]` item by item**: unfulfilled where Buffa marks nothing, and on any item
  whose deprecated use a later change removes.
- **`HelloProcedures::new()` in each shell**: a descriptor of one shell refused at run time by a
  layer built over another, and a `procedures()` member neither other side has.
- **The Rust runtime's counter from 1**: the two runtimes' numbers move together, each given a
  meaning on both sides, and a third numbering would make one contract three numbers.
- **`messages: external` alone**: every Rust output's messages its application's own work, where
  the other targets write theirs, and an offline or docs.rs build then needs a set at `cargo build`
  or its application's own commit of Buffa's checked-in tree.
- **Bead's own plugin binary over `config_of`**: equal to `config_of` by construction, but a Rust
  build in beadc's image and a binary a platform for a beadc run outside it, which Bead does not
  release.

## Decision

### An output: one module tree under three roots

beadc's third target, `rust`, writes an output as one module tree. Its root is `mod.rs`, which an
application mounts as `mod generated;` or `pub mod generated;`; `beadc init --language rust` names
`rust/src/generated`, since `gen`, the other targets' folder, is reserved by edition 2024.

```rust
// @generated by beadc <version> from proto/hello/v1/hello.proto: bead-blueprint/1, spec <version>.
// Do not edit: regenerate with beadc.

//! The code beadc writes for this output: Buffa's messages under `messages`, each package's
//! services under `services`, and the procedures each transport of its server takes.

#[rustfmt::skip]
#[allow(
    clippy::all,
    clippy::pedantic,
    clippy::nursery,
    clippy::restriction,
    missing_docs,
    unnameable_types,
    unreachable_pub,
    unused_qualifications,
    reason = "Buffa's generated code answers to Buffa's lints, not its application's"
)]
pub mod messages; // generate: messages/mod.rs, Buffa's tree as committed
// external: pub mod messages { include!(concat!(env!("OUT_DIR"), "/_include.rs")); }

#[rustfmt::skip]
#[allow(
    dead_code,
    deprecated,
    clippy::allow_attributes,
    unreachable_pub,
    clippy::struct_field_names,
    clippy::type_complexity,
    reason = "an application uses the classes of its own side alone and mounts them where it will, beadc's code names what it marks deprecated, a record's fields are its procedures' names, and a descriptor's type names each of its codecs by its whole path"
)]
pub mod services {
    //! Each package's services, a module a package.

    pub mod hello {
        //! The package `hello`.

        pub mod v1 {
            //! The package `hello.v1`: the services of `hello/v1/hello.proto`.

            include!("services/hello.v1.rs");
        }
    }
}

#[rustfmt::skip]
#[allow(
    dead_code,
    unreachable_pub,
    clippy::allow_attributes,
    reason = "an application hands a transport the list it names, and mounts it where it will"
)]
pub mod bead_served {
    //! The procedures each transport of the server takes.

    include!("bead_served.rs");
}
```

- **`messages`** is Buffa's tree as Buffa writes it, never declared again by beadc. Under
  `generate`, `messages/mod.rs` and the files it includes, exactly the files Buffa's checked-in mode
  writes through `config_of`, Buffa's per-package `#[allow]`s and `use super::*;` in them; beadc
  writes `messages/mod.rs` itself, in the form `buffa-build` writes it (`generate_module_tree`),
  since the plugin writes no root. Under `external`, Buffa's include file from `OUT_DIR`,
  `_include.rs`. The one `#[allow]` above it is beadc's: Buffa's code answers to Buffa's lints; it
  names `clippy::restriction`, so `clippy::allow_attributes` is allowed with it, and rustc's
  `unnameable_types` and `unreachable_pub`, which a private mount fires on Buffa's public items.
- **`services`** is Bead's tree, **a module a package**, each segment named by Buffa's
  `escape_mod_ident`, so its path is the package's (`services::hello::v1`, C#'s `Hello.V1`
  namespace in Rust's form). Its file is **one a package**, `services/<package>.rs` (Buffa's
  `package_to_filename`), holding every service of every `.proto` file of that package in the
  blueprint's order, its header naming the files. A service with no `proto` member, and one in the
  unnamed package, is written in `services` itself, its file `services/__buffa.rs` (Buffa's
  `SENTINEL_MOD`). No module is named after a `.proto` file's stem.
- **`bead_served`** holds `SERVED_PROCEDURES`, at the root.
- **`include!` and `#[rustfmt::skip]`**: every file of `services` and `bead_served` is
  `include!`d, which rustfmt never follows, and `messages`, an out-of-line module, carries
  `#[rustfmt::skip]`, so rustfmt reads none of Buffa's files; every item of `mod.rs` is
  `#[rustfmt::skip]`, its other lines comments. An application's `cargo fmt` changes nothing beadc
  writes, whatever its `rustfmt.toml`. The marker is the header's `// @generated by beadc …`;
  Buffa's files keep Buffa's `// @generated by buffa-codegen. DO NOT EDIT.`.
- **The two `allow`s on Bead's roots** are the one exception beadc writes on its own code:
  `dead_code`, since a binary that serves one service never calls its client; `deprecated`, the
  file's own uses of what it marks, a consumer's uses reported at the consumer's site;
  `unreachable_pub`, since an application mounts the tree privately or publicly as it will;
  `clippy::struct_field_names`, since a record's fields are its procedures' names, which may share a
  word; `clippy::type_complexity`, since a descriptor's type names each of its codecs by its whole
  path; and `clippy::allow_attributes` itself, since an `expect` fails wherever its lint is not met.
  As `buffa-codegen`'s `ALLOW_LINTS` allows `dead_code` on Buffa's own modules.

### Where the code comes from

- **Bead's code is beadc's, committed and golden-tested**, as on the other two sides: only beadc
  reads a blueprint ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s
  one front end).
- **`messages: generate`**, the default: beadc runs **`protoc-gen-buffa` 0.9.2, pinned** as protoc
  is, handing it a `CodeGeneratorRequest` itself, no protoc run, over the set it hands protoc for
  the C# target, buf's set with protovalidate's options and `google.api.http` taken out unless the
  output keeps them, built once for both targets. **beadc prunes the request's files** to those the
  output's messages need, so the set each message embeds holds no file it does not reach, and
  `bead_protobuf_build::config_of` reads the same pruned set, so the two modes stay equal. The
  plugin's parameter is `config_of`'s settings: `views=true`, `reflect_mode=vtable`,
  `unknown_fields=true`, `allow_message_set=true`, and `open_enums_in=` each field `opened_of`
  names, computed by beadc as `bead_protobuf_build::opened_of` computes it. beadc writes
  `messages/mod.rs`. The files are committed under `messages/`, held by `generate --check`.
- **`messages: external`**: the application's build script writes them by
  `bead_protobuf_build::config_of(set, files)?.include_file("_include.rs").compile()`, over its own
  set (`buffa_build`'s `use_buf()`, protoc, or `beadc blueprint --descriptor-set-out` run before
  `cargo`). That set is buf's as it is: protovalidate's options and `google.api.http` stay in it, as
  they stay in the set the C# half's external build compiles with its own protoc. beadc writes no
  binary set into an output.
- **One Buffa**: `bead-protobuf` and `bead-protobuf-build` require Buffa's crates exactly,
  `=0.9.2`, so an application's lock never moves Buffa apart from Bead; the header's line is
  `// Messages: protoc-gen-buffa 0.9.2, for buffa =0.9.2.` The plugin's pin,
  `builder/protoc-gen-buffa.json`, its version and each platform's sha256, which
  `builder/tools/fetch-protoc-gen-buffa.mjs` checks before it runs the binary, is held to that
  requirement by a test; an upgrade moves both in one change. `BEADC_PROTOC_GEN_BUFFA` names
  another binary, `beadc version` prints the plugin's line, and beadc's image carries it, its
  Apache-2.0 licence beside protoc's.

### What generated code depends on

`bead` with no feature (the service layer, the codecs `JsonCodec`, `RawCodec` and `TextCodec`, the
counter), and, where a binding is `proto` or a rule is generated, `bead-protobuf` (`ProtoCodec`, the
validators' runtime) and the Buffa crates its messages name, `buffa`, `buffa-descriptor`, and
`buffa-types` for a well-known type. Generated code names no `serde_json`. Every item is named by a
path from its crate's root, `::bead::…`, `::bead_protobuf::…`, `::std::…`, `::core::…`; a message
by its path from the shell's module to `messages`
(`super::super::super::messages::hello::v1::SayHelloRequest`, a nested one through Buffa's module,
`outer::Inner`). A Rust output takes no `runtime` or `protoRuntime` key.

### The surface a service gives

| Concept        | TypeScript                                                                                     | C#                                                                                                    | Rust                                                                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| descriptors    | `HelloProcedures`, frozen object                                                               | `HelloProcedures`, static class, `All`                                                                | `HelloProcedures`, a `#[non_exhaustive]` struct of public descriptor fields, made once a process behind a `static` `LazyLock`: `HelloProcedures::get() -> Result<&'static Self, ProgrammerError>`; `all() -> Vec<ServiceProcedure>`                                             |
| catalogue      | `HelloFailures = failuresOf(1, {…})`, `.of`, `.is`                                             | `HelloFailures`, a class per procedure, `Is`                                                          | `HelloFailures`, a unit struct: an associated `ListedFailure` constant a failure (`HelloFailures::NAMELESS`), `is(&CallError, &ListedFailure) -> bool`, `catalogue()`, made once a process as `get` is                                                                          |
| server         | `HelloServer<Data>`: `on(name, cb)`, `command`, `notify`, `offer`, `proceduresWithoutResolver` | `HelloServer<TData>`: `On(descriptor, cb)`, `Command`, `Notify`, `Offer`, `ProceduresWithoutResolver` | `HelloServer`: `new(&HelloServerOptions)`, `on_<procedure>(resolver)` for each request and procedure that notifies it serves, `command() -> &HelloCommands`, `notify() -> &HelloNotifiers`, `offer(&Server)`, `procedures_without_resolver()`                                   |
| client         | `HelloClient`: requesters by name, `notifications`, `on`                                       | `HelloClient`: requesters by rpc name, `Notifications`, `On`                                          | `HelloClient`: `new(&Client, &HelloClientOptions)`, `request() -> &HelloRequesters`, `notifications() -> &HelloNotifications`, `on_<command>(resolver)` for each command it answers                                                                                             |
| handle records | (indexed types)                                                                                | `HelloCommands`, `HelloNotifiers`, `HelloNotifications`                                               | `HelloRequesters`, `HelloCommands`, `HelloNotifiers`, `HelloNotifications`: `#[non_exhaustive]` structs of public handle fields                                                                                                                                                 |
| hooks          | `HelloAdmissions` (type)                                                                       | `HelloAdmissions`, required members                                                                   | `HelloAdmissions`, a struct of public `AdmissionHook` fields, exhaustive, every hook required                                                                                                                                                                                   |
| windows        | `HelloWindows` (type)                                                                          | `HelloWindows`, `int?` members                                                                        | `HelloWindows`, `#[non_exhaustive]`, `Default`, an `Option<u64>` field a procedure that notifies                                                                                                                                                                                |
| options        | `HelloServerOptions`, `HelloClientOptions`                                                     | `ServiceServerOptions<HelloProcedures>`, `ServiceClientOptions<HelloProcedures>`                      | `HelloServerOptions`, `#[non_exhaustive]`: where a procedure names a hook, `admissions: HelloAdmissions` plain and `new(admissions)`, no `Default`, else `Default`; `HelloClientOptions`, `Default`: `fail_fast`, `validates`, and the client's `windows: Option<HelloWindows>` |
| served lists   | `SERVED_PROCEDURES`                                                                            | `ServedProcedures`                                                                                    | `SERVED_PROCEDURES: ServedProcedures`, a `const` of a `#[non_exhaustive]` struct whose field a key is `&'static [ProcedureAddress]`                                                                                                                                             |

`HelloProcedures::get` is the one set a process: the layer matches a descriptor by identity, so
`HelloProcedures::get()?.say_hello` is the descriptor everywhere, as `HelloProcedures.sayHello` and
`HelloProcedures.SayHello` are; the shells hold a `&'static HelloProcedures` and have no
`procedures()` member. `ProtoCodec::new`'s check runs as the set is made, once a process.

Renderings, each in 0022's list of a language's classes, not differences of behaviour: `request()`
and `HelloRequesters`, the same requesters through a record whose fields are a namespace of their
own; `on_<name>`, one registration typed by its procedure, 0044's "an overload a second name";
`get()`, a lazily made static, Rust's form of a static object; no `<Name>Resolvers`, TypeScript's
alone. The server's data type is a difference, a row of the matrix.

### The server, the client, the catalogue

- **Registration, not a trait**: one `on_<procedure>` a procedure, generic over the resolver and
  its future, boxing inside:

  ```rust
  pub fn on_say_hello<F, Fut>(&self, resolver: F) -> Result<(), ::bead::ProgrammerError>
  where
      F: Fn(
              ::bead::RequestProps<super::super::super::messages::hello::v1::SayHelloRequest>,
              ::bead::Response<::bead_protobuf::ProtoCodec<super::super::super::messages::hello::v1::SayHelloResponse>>,
          ) -> Fut
          + Send
          + Sync
          + 'static,
      Fut: ::core::future::Future<Output = Result<(), ::bead::ResolverError>> + Send + 'static,
  {
      self.service.on(
          &self.procedures.say_hello,
          ::std::sync::Arc::new(move |request, response| ::std::boxed::Box::pin(resolver(request, response))),
      )
  }
  ```

  The same form for a procedure that notifies and for a client's command. An `async fn` is given by
  its name (`server.on_say_hello(say_hello)`), an `async` closure as written; the layer's
  `ResolverCallback` stays. The generics are explicit, since `impl_trait_in_params` is denied. A
  command, another service's procedure, or one the server class does not serve has no method:
  E0599. Registration before or after `offer`, and `procedures_without_resolver`, stay name for
  name.

- **A failure of the catalogue**: `response.failure(&HelloFailures::NAMELESS.of("nobody to
  greet"))`; the layer's `failure` takes any `Failure`, so the matrix's row of a failure its
  procedure does not list stays.
- **The client**: `client.request().say_hello.call(request, &RequestOptions::default())`;
  `client.notifications().count_down.register(payload, callback, &options)`;
  `client.on_ask_name(resolver)`.

### Names

- **Snake case is Buffa's `to_snake_case`** (C-CASE, an acronym one word): `getHTTPStatus2` gives
  `get_http_status2` and `on_get_http_status2`, for procedures, hooks, transport keys and the
  modules beadc names. Its underscores removed, it gives the name in lower case, a name holding no
  underscore (spec 16.4), which is spec 16.6's folding, under which no two procedures of a service,
  nor two hooks, are one name: the rendering is injective there. A transport's key is not folded,
  so **the Rust target refuses an output two of whose keys render as one field** (`getHTTP`,
  `getHttp`), as it reads the output.
- **A keyword is a raw identifier, `r#type`; `self`, `super` and `crate` take Buffa's `_` suffix,
  `self_`.** The key, the descriptor's `procedureName`, never moves: a rendering that keeps the key,
  snake case, a raw identifier, or Buffa's `_` where Rust holds no raw one, is no escape under
  0022's "refused, never escaped".
- **No verdict of any blueprint moves.** Bead's classes share no scope with a message, `messages`
  apart, nor with a runtime type, always `::bead::…`, so `CLASS_SUFFIXES` and `RUNTIME_TYPES` stay
  as they are and no `.proto` refusal is added. **The Rust target refuses, for its own output**, a
  package segment that renders as a class of its parent package's services (a package
  `hello.v1.HelloServer` beside a service `Hello` of `hello.v1`), which would be one name of one
  module.
- **Buffa's names, repeated in beadc** for the paths its shells write and for `messages/mod.rs`:
  `escape_mod_ident`, `to_snake_case` for a nested type's module with its collision overrides,
  `package_to_filename`, `generate_module_tree`. The goldens, compiled against Buffa's output, and
  the parity test hold them.
- **Rules' names**: `rules_of_<message>`, a message's local name in snake case, numbered on a
  collision within its package's file (`_2`), as the TypeScript target numbers `$2` and the C# one
  `Rules2`; private to the module.

### Descriptions and deprecations

- **A description**: beadc's one-line summary first, then an HTML block, one `<p>…</p>` a
  paragraph, its text escaped as HTML's (`&`, `<`, `>`), and each bidi control rustc refuses in a
  comment (U+202A to U+202E, U+2066 to U+2069) as its numeric reference: the C# target's XML rule in
  Rust's dress.
- **A deprecation** is `#[deprecated(note = "<text>")]`, its text the blueprint's message or `No
  replacement is named.`, a bidi control written `\u{…}`, on each item beadc writes for the
  procedure: its descriptor's field, its `on_<name>`, its fields in the handle records and in
  `HelloWindows`, a failure's constant; for a service, every type. The file's own uses are silenced
  by `services`' `allow(deprecated)`, as C#'s file-wide `#pragma` silences them, never by an
  `#[expect]`, which fails where nothing is met.
- **protobuf's own deprecations**: Buffa 0.9.2 marks none, so beadc writes nothing for them, a row
  of the matrix; and rustc's `deprecated` is one lint for every library, with no id of Bead's, a
  row.

### The validators' runtime

- **Generated**: `fn rules_of_<message>(message: &M, sink: &mut dyn ViolationSink) -> bool`,
  judging in spec 18.5's order; a `const` `ViolationRule` a site; a `const` `PatternTable` a
  pattern; the descriptor's `validate: Some(::bead_protobuf::validator_of(rules_of_x))`. It reads
  Buffa's representation (an explicit presence's `Option<T>`, `Vec<u8>`, `EnumValue<E>` or `E`,
  `Vec<T>`, a map ordered by key through `entries_by_key`, a wrapper's `MessageField<W>`, a oneof's
  `Option<message::Oneof>`); integers by their operators, floats by `partial_cmp`, a NaN breaking
  every bound, every index, slice and step checked.
- **The runtime is `bead-protobuf`'s module `validate`**, re-exported at its root:
  - `ViolationRule`, an exhaustive struct of `&'static str` fields and
    `bounds: Option<&'static str>`;
  - `RuleValue<'a>`, `Copy`, `#[non_exhaustive]`: `Absent`, `Bool(bool)`, `Signed(i64)`,
    `Unsigned(u64)`, `Float(f64)`, `Text(&'a str)`, `Bytes(&'a [u8])`, `Items(&'a dyn RuleItems)`;
    `RuleItems`, which `bead-protobuf` implements for Buffa's lists and maps of those kinds;
  - `ViolationSink`, a trait: `add(&mut self, rule: &ViolationRule, value: RuleValue<'_>) -> bool`,
    `enter`, `enter_index`, `enter_key(MapKey<'_>)`, `leave`. The sink turns a value into the
    core's `serde_json::Value` only for a violation it holds; past its bound it counts and reads
    nothing, as the C# side's `Add` does. Bytes are their base64; a message, or a list or map of
    messages, is kept absent, since `bead-protobuf` has no JSON form of a message in every build, an
    open row of the matrix;
  - `MessageRules<M>`, `validator_of(rules) -> Validate<M>`, `judge_rules`, `PatternTable`,
    `matches_pattern`, `code_point_length`, `utf8_length`, `bytes_contain`, `bytes_start_with`,
    `bytes_end_with`, `bytes_equal`, `is_unique`, `entries_by_key`, `MapKey<'_>`;
  - built on the core's `ViolationHolder`, `Judged`, `Violation` and `ValidateOptions`.
- **0044's exhaustive records gain a third kind**: what generated code builds as a constant,
  `ViolationRule` and `PatternTable`.
- **The interop's `checked`** takes `validator_of` over its rules written by hand, and its own sink
  goes; `bead-interop` depends on `bead-protobuf`.

### A closed enum: `ProtoCodec` refuses what its generator left closed

`ProtoCodec::new() -> Result<Self, ProgrammerError>` reads the message's pool, the message and every
message its fields reach, and refuses one whose repeated or map field of a closed enum carries no
`features.enum_type = OPEN` override: a generator set otherwise than `config_of`. The generated set
folds the error into `get`'s; a caller that writes its codec takes `?`. A break, while the major
is 0.

### The counter: 7 and 8, the other runtimes' numbers

`bead::GENERATED_CODE_SUPPORTS_VERSION_7` and `bead::GENERATED_CODE_SUPPORTS_VERSION_8`, `bool`
constants `true` in the core, answer for `bead-protobuf`'s calls too. One number is one contract,
every side's, moved together, and a file names the highest it needs
([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)):
a package's file of services names 7, as `hello_bead.ts` and `HelloBead.cs` do, and
`bead_served.rs` names 8, as `bead_served.ts` and `BeadServed.cs` do. The Rust runtime meets both
contracts and holds those two alone, since no Rust code names an older one. A package's file ends:

```rust
// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here
const _: bool = ::bead::GENERATED_CODE_SUPPORTS_VERSION_7;
```

A runtime that lacks it fails the build, E0425, as TS2724 and CS0117.

### The served lists

`bead_served.rs` holds `SERVED_PROCEDURES`, a `const` whose fields are each key in snake case, in
`beadc.yaml`'s order, each list's doc naming its procedures. A transport takes
`procedures: Some(SERVED_PROCEDURES.web_socket.to_vec())`. `ProcedureAddress` is exhaustive
([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)). The file
names counter 8.

### The mount

| Crate                                              | Its mount                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| an application, default lints                      | `mod generated;` or `pub mod generated;`: no warning from its build or from clippy                                                                            |
| one of Bead's, the workspace's table               | `#[expect(clippy::mod_module_files, reason = "beadc writes its tree's root as mod.rs, Buffa's name for a checked-in tree")] mod generated;`, and nothing else |
| a root mounted by its path, `#[path = "…/mod.rs"]` | no `expect`: a root mounted by its path is no `mod.rs` to `clippy::mod_module_files`, as `bead-goldens` and `examples/hello`'s Rust half mount theirs         |

In the crate that holds them, `#[non_exhaustive]` binds nothing, and clippy's
`field_reassign_with_default` refuses 0044's assignment idiom on a generated options struct; a
literal over `..HelloClientOptions::default()` is the form there, a row of the matrix. Mounted in a
crate of its own, the struct is non-exhaustive to its users and the assignment form holds.

### The gates

- **`crates/bead-goldens`**, a member of the Rust workspace, `publish = false`, `Bead.Goldens`'
  twin, mounts each golden output's `mod.rs` whole and once,
  `#[path = "…/builder/test/golden/rust/<fixture>/mod.rs"]`, under `[lints] workspace = true`, so
  CI's clippy and documentation runs hold beadc's output as an application compiles it. Its build
  script writes the `external` golden's `_include.rs` by `config_of` over that fixture's set. Its
  `tests/` hold the consumer twins and the parity test, which compares each golden's `messages/`,
  `mod.rs` included, byte for byte with Buffa's checked-in mode through `config_of` over the
  fixture's set. The builder's jobs need no Rust toolchain: the `rust` job builds it, as the
  `dotnet` job builds the C# goldens.
- **The sets**: beadc's golden writer writes, beside each Rust golden of a `proto` fixture, the set
  it handed the plugin, `messages.binpb`, a test fixture, never an output's file, marked binary by
  `.gitattributes`.
- **`bead-house`** reads `builder/test/golden/rust`.
- **Coverage** leaves generated code, `/generated/`, and `crates/bead-goldens/` out of the Rust
  side's floor, as it leaves out the tests and the test kit.
- **Projects outside the workspace**, each with its own lock: `examples/hello/rust/` and
  `implementations/rust/tools/protovalidate-differential/`, each with its `cargo deny
  --manifest-path … --locked check` line, run from `implementations/rust` so that the workspace's
  `deny.toml` is theirs, and its Dependabot folder; `examples/hello/rust/` its own
  `rust-toolchain.toml`, held to the workspace's pin by `tools/check-versions.mjs`.
- **The `examples` job**: one leg takes the pinned Rust toolchain and builds hello's Rust half in
  both modes over one target folder.

### `examples/hello`'s Rust half

`examples/hello/rust/`, outside the workspace, its own lock, depends by path on `bead` with
`websocket`, `bead-protobuf`, Buffa's crates and tokio. `beadc.yaml` names two outputs,
`rust/src/generated/generate` and `rust/src/generated/external`, the feature `external` choosing the
mount, its `build.rs` running `config_of` over the set `buf build --as-file-descriptor-set` writes,
never committed. It names no `gateway`: the Rust target has `http: false`, so an output naming
`gateway` is `HTTP_UNGENERATED`. `pairs.mjs` plays `Rust, generate` and `Rust, external` among the
halves: 36 WebSocket pairs; the gateway's lines stay the TypeScript and C# servers'.

### The interop

The root's `beadc.yaml` names `language: rust`, out
`implementations/rust/crates/bead-interop/src/generated`. The handlers take the generated
`InteropProcedures`, `InteropFailures` and `InteropAdmissions`; `checked` is the layer's server
built directly over the generated descriptors' getters with its own `validate`, as the C# side
builds it. `generate --check` holds the files, as it holds the other sides'.

## Consequences

- **One more pinned binary in beadc's image**, `protoc-gen-buffa`, about 4.8 MB on amd64 and 4.1 MB
  on arm64, its sum checked before it runs, its licence beside protoc's.
- **Buffa is required exactly**, `=0.9.2`: a Buffa patch release asks for a Bead release, which
  moves the plugin's pin and the requirement in one change.
- **Committed messages**: about 240 KB for `hello`'s, about 0.9 MB for `spec/validations.proto`'s,
  which `crates/bead-protobuf/tests/generated/` holds as each side holds its validators of that
  file, and the goldens' `messages/` beside them.
- **Buffa's naming is repeated in beadc** for the paths its shells write and its `messages/mod.rs`;
  the goldens, compiled against Buffa's output, and the parity test hold it, and an upgrade of
  Buffa runs them.
- **A generated options struct is built by a literal in its own crate**, `..Default::default()`,
  clippy refusing the assignment form there; a crate of its own takes the assignment form.
- **A server class takes no data type** on the Rust side, its core's `Server` and `ServiceServer`
  having none: an open row of the matrix, a change of the Rust core's layer by a decision of its
  own.
- **A violation's value on a message**, or on a list or map of messages, is absent on the Rust
  side: an open row of the matrix, a JSON form of a message in `bead-protobuf` for every build by a
  decision of its own.
- **`ProtoCodec::new` returns a `Result`**: a break for every caller that writes its codec, while
  the major is 0.
- **Two more projects outside the workspace**, each a `cargo deny` line, a Dependabot folder, and
  hello's Rust half a toolchain file; the `examples` job builds the Rust half in both modes.
- **Ahead**: the Rust target's gateway, `http: true`, its route table, its `<Service>HttpClient`,
  its document, and `examples/hello`'s Rust gateway, with `Rust's gateway`.

**Its gates**: `bead-goldens` under the workspace's whole lint table, its consumer twins and its
parity test; `generate --check` over every Rust output, the interop's and `examples/hello`'s among
them; the builder's tests of the Rust target and its goldens; `spec/validations.json`'s verdicts
through `bead-protobuf/tests/validations.rs`, a trial each, and the differential's Rust testee;
`tools/check-validations.mjs` over the Rust side's validators of `spec/validations.proto`; the test
that holds the plugin's pin to Buffa's requirement; and the `cargo deny` lines and the `examples`
job's Rust leg.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, at xhigh effort. Sixteen objections, each checked against its probe or the code before
it was answered: fifteen accepted and one in part, none refused.

| Objection                                                                                                                                                                                                                                                                                                                                                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bead's shells belong beside Buffa's tree, not inside it: inside, beadc re-declares Buffa's package modules without Buffa's per-package `#[allow]`s and `use super::*;`, an application's clippy fails on Buffa's files, a binary warns in them, Bead's crates mount the whole tree under a blanket exception that also covers the shells, and `config_of` must change | Accepted. Three fixed roots: `messages`, Buffa's tree as Buffa writes it (its checked-in `mod.rs` under `generate`, its include file from `OUT_DIR` under `external`) under one `#[allow]` beadc writes; `services`, Bead's; `bead_served`. Buffa's checked-in tree through `config_of`, mounted so, passes the workspace's whole table, its doc and its formatter, and gives a default-lints binary no warning. `config_of` does not change, no `.proto` refusal is added, and Bead's crates mount the output with `clippy::mod_module_files` expected alone                                                                                                                                                                                                                                                                                                                                                                                  |
| No exception on beadc's files and a clean build in an application cannot both hold: a binary that uses one side of a service warns `dead_code` on the other's classes, and the workspace denies the attribute generators use                                                                                                                                          | Accepted. beadc writes `#[allow(dead_code, deprecated, clippy::allow_attributes, reason = …)]` on its own roots, the one exception on its code, as Buffa's `ALLOW_LINTS` allows `dead_code` on its own; an `expect` would fail wherever the lint is not met                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A handler that awaits has no Rust form: the registration takes the layer's boxed callback, so an `async fn` cannot be given by its name                                                                                                                                                                                                                               | Accepted. Each `on_<procedure>` is generic over the resolver and its future and boxes inside; the layer's `ResolverCallback` stays. Request, notifying and command registrations so written pass the workspace's table, and the pair test passes over them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Splitting at each capital writes `get_h_t_t_p_status2`, against C-CASE and against Buffa's rule beadc repeats in the same output; injectivity does not choose between the two                                                                                                                                                                                         | Accepted. One rule, Buffa's `to_snake_case`: its underscores removed it gives spec 16.6's folding, under which no two procedures of a service, nor two hooks, are one name. A transport's key is not folded, so the Rust target refuses an output two of whose keys render as one field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A module named after a `.proto` file's stem is no identifier in general, two files of one package can share a stem, and tonic names by service                                                                                                                                                                                                                        | Accepted. No module is named after a file: `services` holds a module a package, its path the package's, as C#'s namespace, and its file is one a package, Buffa's `package_to_filename`; a message's rules are written once in the package's file, numbered on a collision as the other targets number theirs. A module a service was refused: two services sharing a message would write its rules twice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Requesters` in `CLASS_SUFFIXES` refuses a message on every blueprint for a collision no Rust output has                                                                                                                                                                                                                                                              | Accepted. `CLASS_SUFFIXES` stays, and so does `RUNTIME_TYPES`: Bead's Rust classes name every runtime type `::bead::…` and every message through `messages`. 0018's line that had the Rust newtypes join `RUNTIME_TYPES` with the target is revised: they join nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| An owned JSON value in the sink copies a value the sink will not keep, a peer's whole string or list, and makes `serde_json` every application's dependency                                                                                                                                                                                                           | In part. Accepted: the sink takes a borrowed `RuleValue<'_>` (scalars, text and bytes by reference, a list or map of them through `RuleItems`) and makes JSON only for a violation it holds; the bound's twin asserts no value is made past it; generated code names no `serde_json`. Refused: a message by reference, since `bead-protobuf` has no JSON form of a message for every build; a message's value is kept absent, an open row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Buffa marks nothing protobuf deprecates, so an `#[expect(deprecated)]` on an item naming such a message is never met, and the difference has no row                                                                                                                                                                                                                   | Accepted. The file's own uses are allowed on `services` (C#'s `#pragma` in Rust's form), never expected item by item; beadc writes nothing for protobuf's deprecations; a Differences row, platform                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Committed Buffa code compiled against a caret requirement breaks by Buffa's own word: its generated code names `__private`, which may change in any release                                                                                                                                                                                                           | Accepted. `bead-protobuf` and `bead-protobuf-build` require Buffa's crates exactly, `=0.9.2`; the header says `=`; a Buffa patch release asks for a Bead release, a consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The default mode rests on a binary nobody ran, the record was to be written before its test, its fallback fails the standard the proposal used against a build script, and the parity test had no stated source for its set                                                                                                                                           | Accepted. The pinned binary, its sha256 its release's `checksums-sha256.txt`'s, its signature and its SLSA attestation verified, was run before this record on the `CodeGeneratorRequest` beadc hands it, over buf's stripped sets of `examples/hello` and `spec/validations.proto`: every file it writes equals, byte for byte, what Buffa's checked-in mode through `config_of` writes over the same set with the settings the Decision names, no default differing; the fallback is gone. Two findings joined the Decision: the plugin writes no module root, so beadc writes `messages/mod.rs` as `buffa-build` lays it; and stripping leaves protovalidate's and `google.api`'s files in the set each message embeds, so beadc prunes the request's files to those its messages need, and `config_of` reads the same pruned set. The parity test's set is that one, `messages.binpb`, written beside each golden by beadc's golden writer |
| The page's check fails at the series that takes `Rust's beadc target` out of the matrix's row of payload rules, since `site/` moved only at the last                                                                                                                                                                                                                  | Accepted. The validators' series carries the page's cell in both languages, the two sentences on the Rust validators, and the rebuilt page; every series runs `node site/check.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Three differences have no row: `gateway` in an output, the server's data type, protobuf's deprecations                                                                                                                                                                                                                                                                | Accepted. The Rust cell of the matrix's row of an output's selections keeps `gateway` ahead under `Rust's gateway`; a Differences row for a server class's data type, open; a row for protobuf's deprecations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The gates and costs left out: two projects outside the workspace without their `cargo deny`, Dependabot and toolchain lines; a Node-only Examples job; the committed size; the consumer twins' codes across crates                                                                                                                                                    | Accepted. Both projects get their `cargo deny` line in CLAUDE.md and CI and their Dependabot folder; hello's Rust half its toolchain file, held by `tools/check-versions.mjs`, its `cargo deny` run from `implementations/rust`, whose `deny.toml` it reads; one Examples leg builds it, its limit measured; the committed size is a consequence; the window's twin asserts E0609 on the assignment form, E0639 beside it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Descriptors made in each shell are matched by identity, so one shell's descriptor is refused by another's layer at run time, and the shells carry a `procedures()` neither other side has                                                                                                                                                                             | Accepted. One set a process, a `static` `LazyLock` behind `HelloProcedures::get()`, the catalogue the same; the shells hold `&'static HelloProcedures` and lose `procedures()`; the codec's check runs once, as the set is made. Probed under the whole table, with the pair test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The route table, the typed HTTP client and the document belong to no round: each design leaves them to the other                                                                                                                                                                                                                                                      | Accepted. They belong to the gateway's stage, which designs them in a round of its own before it is implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The counter's stated reason is false: the two runtimes' counters moved together, each number given a meaning on both sides                                                                                                                                                                                                                                            | Accepted, and the number with it: a package's file names 7 and the served lists' file 8, as on the other sides, the Rust runtime holding those two alone; 0018's "each runtime's counter its own" reads "one number a contract, every side's, moved together"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
