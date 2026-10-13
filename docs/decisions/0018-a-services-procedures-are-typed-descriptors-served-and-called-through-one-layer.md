# 0018 — A service's procedures are typed descriptors, served and called through one layer in each runtime

- **Status**: accepted
- **Scope**: both runtimes' public surface: a procedure's kind, checked by each router as it is
  declared; the payload codecs made public; the admission vocabulary; the failure catalogue; the
  typed descriptors, and their room for a validator; the service layer that serves and calls them;
  the notify filter's argument; a notification asked for again at another window; the bound call and
  its guard; the C# side's server and client interfaces, and its routers' `Notify`; the TypeScript
  side's `./service` entry; the constant of the contract with generated code. Spec section 16, whose
  16.10 holds the reason `against its kind` and whose 16.11 says what each way of declaring takes,
  with `spec/identities.json`, its schema and its generator; the support matrix's rows of the layer;
  [0003](0003-one-word-one-meaning.md)'s sentence on _kind_ and _type_. The `proto` encoding, section
  17.9, its file and its rows, is
  [0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)'s; the check of a
  `proto` payload's records before its library reads them, its levelings and protobuf's conformance
  suite are
  [0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)'s

## Context

The builder, beadc
([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)),
generates, from a `.proto` or a blueprint, data and types for each service: its procedures as typed
descriptors, its failures, a server class where only resolvers are written, and a client class that
matches it. It keeps behaviour once in each runtime, in a generic layer the generated classes are
thin shells over, as Connect-ES's `createClient(Service, transport)` types a client from a
descriptor. That layer needs eight things of each runtime, the same on both sides:

- **A procedure that says how it is called.** A procedure's ids, name, revision, limit and
  deprecation (`IProcedure`, `router/shared/types.ts`; `Procedure`, `Bead.Core/RouterTypes.cs`)
  refuse neither a command's requester made for a request nor a subscription asked of a procedure
  that never notifies. Bead says what a call is by the router's side: "a client's router makes
  requests and answers commands, a server's the reverse" (`spec/debugging.md` 8.2), as the metrics
  registry types it; the service manager's accessor names only pick the trace's type, and both
  routers declare a requester alike.
- **The codecs of section 17, public.** Generated code binds each payload to a codec by name, and
  makes a protobuf message's of its stock library's functions;
  [0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md) puts the codecs in the
  runtimes and leaves their names to this record. What a `proto` payload is, read through them, is
  [0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)'s.
- **Admission by name.** An admission written as a function and a refusal is code at each resolver;
  generated code writes none, and needs names for none, a session, and a hook given by name.
- **A failure catalogue.** A bare code, `{ code: 7, detail }`, narrows nothing: a resolver may
  answer a code its procedure does not list. And a failure received is told an application's or a
  protocol's alike on both sides.
- **A notify filter of one argument.** A filter of two, `(connectionHandle, identifier)`, that comes
  to need the call's server or its session's data can only take a third parameter, a change of
  every filter written.
- **A window refused when it differs.** The window is a dependency, not a part of the procedure: a
  notification asked for again at another window, given the first one, would keep its window in
  silence.
- **A server's interface on the C# side.** Where code needs a server, it needs one type that holds
  a router, services, sessions and `RequireSession`, and the relay's admissions, `RequireCredential`
  and `ShareLegBSession`, whichever transport serves it, as the TypeScript side's `IServer` does.
- **One shape of a router's `notify`.** The TypeScript `IRouterLike.notify` takes `Uint8Array` or
  `Error`, the reason a value did not write in its payload's place, and the C# router takes the
  same union, as [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md) maps a union
  onto overloads, a record of more than two members a record of `init` properties.

Probed on 2026-10-05: an optional `then` that no promise's `then` matches, on the bound call's
type, makes `await procedure(request)` a compile error under TypeScript 7.0.2 (TS1320), where it
otherwise compiles and sends nothing. A C# failure class given as a descriptor's type argument is
inferred in `On`'s lambda, and a failure of another procedure, another service's descriptor, a
result of another type and a subscription from a plain request's callback each fail to compile.

### The options weighed

Each item of the builder's round, in its order.

**1. A procedure's kind.**

- A third value of the trace's `type`, `notification`: a request to a procedure that notifies may
  open no subscription (spec 11.2), and the trace and the metrics count the subscribing call as a
  `request` (`spec/debugging.md` 4.1, 8.2).
- On the service layer's descriptors alone, `IProcedure` untouched: a hand-written procedure is never
  checked.
- Two optional members, `type` (`request`, `command`) and `notifies` (a boolean): three states each,
  nine together, one of them, a command that notifies, refused at run time; and the word `type`,
  which the trace gives a step, not a procedure: its `type` takes `notification`
  (`spec/debugging.md` 4.1; `DebugType` on both sides), and a notification sent for a procedure of
  type `request` is traced `notification`.
- **One optional member, `procedureKind`: `request`, `notifies` or `command`. Chosen**, the user's
  choice: it mirrors the builder's `oneof procedure_kind { Notifies notifies; Command command; }`,
  whose local name protobuf-es reads `procedureKind`, word for word, chosen there because it makes a
  command that notifies impossible to write, plus the value an unset `oneof` means, a plain request,
  since on a hand-written procedure an absent member checks nothing. No state needs a refusal, and
  the word is the options' own; the blueprint takes it too. It is neither a _call_, a request and its
  answer ([0003](0003-one-word-one-meaning.md)), nor a member a function has, since the runtime
  merges a procedure into the callable it hands out; and it is never its envelopes' kind, every call
  opening with a `REQUEST`, a command's too.

Where it is checked:

- **The service manager, by the accessor's name**: `getRequest` on a server's manager, for a
  procedure of kind `request`, passes, yet its call goes to a client, and the registry counts it a
  command. The accessor does not say the side; the router does.
- **Each router, at its declaration, by the way it is declared. Chosen.** A router knows its side,
  and whether a resolver notifies before it registers it: `typeof resolver.notify === 'function'`,
  `resolver is INotificationResolver`. A notification is registered on a client's router alone. The
  ways are `spec/identities.json`'s own, six of them: `client-resolver`, `server-resolver`,
  `server-notification-resolver`, `client-requester`, `server-requester`, `client-notification`. A
  resolver that notifies is a way of its own, since a server's router takes another kind of it than
  of a plain one. The manager adds no reason of its own, and 0017's paragraph "The service manager
  checks first where it refuses first" stands as it is: it checks the procedure's identity, once.

What each way takes, the procedure's `procedureKind` given:

| Way                            | Takes                 | Refuses                                                                         |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------- |
| `client-requester`             | `request`, `notifies` | `command`                                                                       |
| `server-requester`             | `command`             | `request`, `notifies`                                                           |
| `server-resolver`              | `request`             | `notifies`: its subscribing calls would be answered and hear nothing; `command` |
| `server-notification-resolver` | `notifies`            | `request`, `command`                                                            |
| `client-resolver`              | `command`             | `request`, `notifies`                                                           |
| `client-notification`          | `notifies`            | `request`, `command`                                                            |

A request to a procedure that notifies, by a `client-requester`, is taken: it opens no subscription
(spec 11.2).

Where it is stated: each router's own, with twin tests; or **a third reason of spec 16.10's table,
`against its kind`, after `out of its range` and `off its form`, with `spec/identities.json` holding
a group of declarations played per way, as [0006](0006-a-rule-has-its-gate.md) asks a rule's gate
and as 0017 pinned there refusals no peer sees. Chosen**, the user's choice: a third language takes
the rule from the file, where twin tests hold two sides alone. Section 16.11 says what each way
takes. A side built without the trace and the metrics, which never refuses `off its form`, still
refuses `against its kind`, which needs no name.

_Conformance:_ 16.10, 16.11 and `spec/identities.json`'s `procedureKinds`, six declarations each
played the six ways. _Matrix:_ the feature row "The identity rules" counts the procedure's kind.

**2. The codecs made public.**

The name. The plan says `Codec<T>`, the builder's sketch `TEXT_CODEC`. But _codec_ names the
envelope's already (`Bead.Core/EnvelopeCodec.cs`; the matrix's "The envelope codec and its
refusals"), and what is public here reads and writes a payload. **Chosen: the names 0016 gave them
inside, made public**: `IPayloadCodec`, `PAYLOAD_CODECS.raw`, `.text`, `.json` on the TypeScript
side; `IPayloadCodec<T>` and `PayloadCodecs.Raw`, `.Text`, `.Json` on the C# side. The keys are the
blueprint's `encoding` values; the global `JSON` is never shadowed.

What a `json` value is on the TypeScript side: `unknown` both ways; `JsonValue` both ways; or
**`JsonValue` read and `unknown` written, chosen**. `JsonValue` written is neither sound nor
complete against 17.7: it takes `NaN`, an infinity and a string holding a surrogate alone, which
17.7 refuses, and refuses a value typed by an interface, which 17.7 writes (TS2322 under TypeScript
7.0.2 and the repository's `tsconfig.base.json`) — the very shape the house style writes. The
writer's refusals stay 17.7's, at run time, as `spec/codecs.json` pins them. Read, `JsonValue` says
what a reader hands on, and narrows nothing anybody wrote.

A protobuf message. Four ways:

- The runtime depends on each language's protobuf library, as Connect-ES does (`@connectrpc/connect`
  2.2.0 has `@bufbuild/protobuf` `^2.7.0` for a peer dependency): every user of `raw`, `text` or
  `json` alone carries a library it never calls, and the constrained profile of a third language has
  none to carry.
- An optional module of its own, a `./protobuf` entry with a peer dependency and a C# project
  referencing Google.Protobuf: one more package on each side to version with the stock library's
  releases, and the C# name `Bead.Protobuf` is the builder's options' namespace already.
- A codec per message written whole in the generated file: the template repeats what each language
  does with a codec.
- **The runtime takes two functions and makes the codec; generated code passes its stock library's.
  Chosen**: what gRPC's C# runtime does. `Grpc.Core.Api` 2.84.0 depends on no protobuf library, its
  `Marshallers.Create<T>(Func<T, byte[]> serializer, Func<byte[], T> deserializer)` makes a
  marshaller of two functions, and the code Grpc.Tools 2.84.0 generates passes each message's
  `Parser` to it. One function on each side, `payloadCodecOf` and `PayloadCodecs.Of`.

The codec needs nothing more of the runtime: what does not decode throws, and the service manager
answers any throw from a decoder `PAYLOAD_UNDECODABLE`. The check of a `proto` payload's records,
which reads its library's descriptors, lives in a module of that second kind, `./proto` with an
optional peer dependency and `Bead.Protobuf` referencing Google.Protobuf
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)):
`Bead.Core` references no protobuf library, and a user of `raw`, `text` or `json` alone carries
none. What a `proto` payload is, read through the codec, is
[0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)'s.

_Conformance:_ none of its own: each side plays `spec/codecs.json` through the codecs it makes
public. _Matrix:_ the feature row "Payloads", which names `payloadCodecOf`'s tests and
`PayloadCodecsTests`.

**3. The admission vocabulary.**

- An `IBeforeRequest`, as the router takes one: a function and a refusal, which generated code would
  build per hook, and whose refusal must be an entry of the router's own table.
- **A rule, `none`, `session` or a hook by name, and a hook as data, `{ admits, detail }`, from which
  the service layer builds the `beforeRequest` once, as the service is offered, its refusal the
  router's own `ACCESS_DENIED` with the hook's detail. Chosen.** `session` is the side's
  `requireSession`, on a server; a command's `session`, on a client, is the same function with its
  router's own `SESSION_REQUIRED`, since a client's router resolves a command's credential to a
  session as a server does: the same rule on both ends of a call, the user's choice over refusing
  `session` to a command.

A hook decides alone, on the call's header and its session, present or not, synchronously
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)). Its refusal is `ACCESS_DENIED`: a
hook's refusal is never `SESSION_REQUIRED`, as the interop's `denied` conversation pins it for a
call in no session. A client side is given no hooks, so a command admitted by a hook is refused as
its resolver is registered there.

_Conformance:_ none moves; `denied` and `whoami` pin a hook's refusal and a session's already.
_Matrix:_ the feature row "The service layer".

**4. The failure catalogue.**

- Codes as numbers, the list a comment: nothing narrows, and the client tests a code.
- **A catalogue per service, `failuresOf` and `FailureCatalogue`, its names and codes, which makes a
  failure of a name with its detail and tells one received; each procedure narrowed at compile time
  to the names it lists. Chosen**: a peer hears nothing new.

The narrowing takes each language's own means. On the TypeScript side, the failure's name is a
literal type its procedure's descriptor carries; a cast still reaches a code the procedure does not
list, which is sent as written and reported. On the C# side, a failure class per procedure that
lists any, its constructor private and its values its static members, given as the descriptor's type
argument, and `NoFailure`, which has no value, for one that lists none: the class is the procedure's
list, and no value outside it exists to send (CS1503 for another procedure's failure and for one
where none is listed). So the C# side holds no second list of the same failures, and checks nothing
at run time: the difference is a platform row of the matrix, as "A value a side's type cannot hold"
is. A refusal of admission is answered through an overload of its own, `AdmissionFailure` on the C#
side, so the application codes stay narrowed.

`FailureException` has `IsApplication` and `IsProtocol` on the C# side, as `FailureError` has
`isApplication` and `isProtocol` on the TypeScript side: a failure received is told alike.

_Conformance:_ none; an unlisted code is sent as written. _Matrix:_ the feature row "The service
layer"; a platform row, "A failure its procedure does not list, answered".

**5. The typed descriptors.**

- A table of plain procedures and a codec map beside it: a callback's type then comes from two
  places, which a template keeps in step.
- **One object per procedure: its procedure, its admission rule, its failures, and its codecs.
  Chosen**, `requestOf` and `commandOf` on the TypeScript side, as Connect-ES's descriptors are data;
  on the C# side, sealed classes whose type arguments carry the service's tag, the payloads and the
  failure class: `RequestProcedure<TService, TRequest, TResult, TFailure>`, its twin of one more
  argument for a procedure that notifies, and `CommandProcedure<…>`.

The C# descriptor is built by its public constructor, never a static `Of`: the analyzers at
`latest-recommended` refuse a static member on a generic type (CA1000), and 0007 holds them.

_Conformance:_ none. _Matrix:_ the feature row "The service layer".

**6. The service layer.**

- A class per service in each language, written by the generator whole: behaviour in templates, in
  two languages.
- **One generic layer per runtime, which the generated classes are thin shells over. Chosen.**

Its name. The builder's design wrote `createAPIServer`, `ApiServer<TApi, TData>` and their peers.
But 0003 says "No abbreviations. A name is spelled out", and lists the words a standard or a
platform owns, `HTTP`, `id`, `ws`: no standard owns _API_, and no name under `implementations/*/src`
holds one. And the layer serves one service: it takes one service's procedures, and the builder
keeps one class per service, leaving the word for a per-package aggregate. **Chosen, the user's
choice: the word is _service_**: `createServiceServer`, `createServiceClient`,
`ServiceServer<TService, TData>`, `ServiceClient<TService>`, and their peers. A `GreeterServer` is
then the server side of a service, a `ServiceServer<GreeterProcedures>` with the service's name;
the word _server_ is the role, as gRPC-Go's `GreeterServer` is registered on a `grpc.Server`. The
other way: _API_ the service, 0003 gaining it as a word Bead owns, and the aggregate taking another
name.

What the server side does: `on` registers a resolver, before or after `offer`; `offer` binds every
resolver, now and later, to one Bead server, once; `command` gives a requester of each command, made
as the service is offered; `notify` notifies each procedure's subscribers;
`proceduresWithoutResolver` lists what no `on` answered, which the router answers
`PROCEDURE_UNKNOWN` (spec 9.2, step 4). What the client side does: a requester of each procedure its
server answers and a notification of each that notifies, made as the client side is built, at the
windows its caller gives, unpaced by default
([0002](0002-a-subscription-goes-at-its-clients-pace.md)); and `on`, for the commands it answers.
Each requester and resolver is declared once
([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)).

The calls stay curried, as the runtime makes them, with a guard on the bound call:
`await procedure(request)`, its options' call forgotten, is TS1320 on the TypeScript side, and on
the C# side awaiting a delegate never compiles (CS1061). The guard sits on the bound call alone, not
on the procedure, the user's choice: on the procedure it refuses an async function that hands a
procedure on (TS1058), which is no mistake. What it costs still, and what it leaves, are stated
under the decision.

_Conformance:_ none; every peer-visible behaviour of the layer is a conversation already: a hook's
refusal (`denied`), a procedure without a resolver (`PROCEDURE_UNKNOWN`), a payload that does not
decode (`PAYLOAD_UNDECODABLE`). _Matrix:_ the feature row "The service layer".

**7. The notify filter's argument.**

- Two arguments, a third the day a filter needs the call's server: a change of every filter
  written.
- One argument at the options, two at the router: two shapes of one filter.
- **One argument everywhere, `ISubscriber` and `Subscriber`: the subscription's connection and the
  identifier of the session holding it. Chosen**, so that a server, or a session's data, joins the
  object later without breaking a filter. `ISubscriber` is the TypeScript side's word for that very
  pair, generic over the handle, in the shared types.

On the C# side, `Subscriber` is a `readonly record struct` of `init` properties, with no positional
parameters, as `NotifyOptions` is a record of `init` properties. A positional record would break, at
the day a member joins it, every filter that deconstructs it (CS8129, CS8130), matches it by
position (CS8129) or constructs one (CS7036); with `init` properties, the same filters compile once
a third member joins. `Subscriber` names that pair wherever the C# side holds it, its notification
manager included, its session's member `Identifier`: one name for one pair, as 0003 asks.

The C# router's `Notify` takes the same filter: `NotifyRequest` is a sealed record of `init`
properties, `Procedure`, `Filter` and `Key`, and `IRouterLike.Notify` two overloads, one of a
payload and one of the reason a value did not write, the TypeScript union's two arms as 0007 maps a
union, so the two sides hand an unwritten notification to their router alike.

_Conformance:_ none; a filter is the server's own. _Matrix:_ none; the two sides hand an unwritten
notification to their router alike.

**8. A notification asked for again at another window.**

- Kept in silence: a second caller's window is dropped.
- **Refused, as another name, revision, deprecation or limit is (0017's table). Chosen.** Unpaced and
  paced are two windows: none against 1 is refused too. It is the service manager's one reason of its
  own, which 0017's paragraph names already: the window joins "asked for again otherwise".

_Conformance:_ none; a window asked for goes on the wire as PACED. _Matrix:_ none.

**9. A server's and a client's interfaces on the C# side, and the TypeScript side's entry.**

- **A server's interface and `IClient`, implemented by composition (0007). Chosen.** The server's
  holds what the TypeScript side's `IServer` holds: its transport, router, services and sessions,
  `RequireSession`, `RequireCredential` and `ShareLegBSession`, its gauges and its health, and its
  disposal. The two transport servers hold `RequireCredential` and `ShareLegBSession`, and give
  their transport to the interface as an `IServerTransport` by an explicit implementation.
  `IClient` holds what every client shares: its router, its services, `Disconnect`, `Reconnect` and
  its disposal; `Connect` stays each client's own, since each takes its transport's options
  record, where the TypeScript side's `IClient` reads them from its transport's type.

  Its name. `IServer<TData>` maps name for name onto the TypeScript side's `IServer`, but ASP.NET
  Core's `Microsoft.AspNetCore.Hosting.Server.IServer` is imported and called in the very projects
  whose servers implement it: C# tells the two apart by arity, and a project referencing both builds
  clean, so the cost is a reader's, not the compiler's. 0003 says a name a platform holds "is not
  available to Bead", with `BeadHttpClient` its case;
  [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) kept `HealthStatus` beside
  ASP.NET's, and qualified every type the builder generates as `global::Bead.` instead. That was a
  name already in the tree; this one is new. **Chosen, the user's choice: `IBeadServer<TData>`**,
  after `BeadHttpClient`, as 0003 has it for a new name. `IClient` collides with no platform name and
  stays.

- **`./service`, one entry of `package.json`'s `exports`, which a generated file imports alone.
  Chosen**, its name following item 6's word: the service layer, the descriptors, the catalogue, the
  payload codecs and the constant of item 10.

_Conformance:_ none. _Matrix:_ none; `Connect` outside `IClient` is a type's shape, not a behaviour.

**10. The constant of the contract with generated code.**

- A version string the generated code compares at load: a mismatch found at a call's run.
- A constant per release, as connect-go's `IsAtLeastVersion1_13_0`: its name waits on a release
  number git-flow gives only as the release branch opens, so it would be renamed there should the
  number move; and the C# name needs CA1707 overruled.
- **A counter of the contract between generated code and the runtime, from 1, moved only when
  generated code needs something the runtime did not have. Chosen**, as gRPC-Go's
  `SupportPackageIsVersion9`: "The SupportPackageIsVersion variables are referenced from generated
  protocol buffer files to ensure compatibility with the gRPC version used. The latest support
  package version is 9. Older versions are kept for compatibility" (pkg.go.dev,
  `google.golang.org/grpc`). `GENERATED_CODE_SUPPORTS_VERSION_3` on the TypeScript side, and
  `GeneratedCode.SupportsVersion3` on the C# side, with no underscore, so CA1707 stands; 2 since the
  layer's options are typed by the service, which generated code names, and 3 since it calls the
  check of a `proto` payload's records
  ([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).
  A runtime too old for a file lacks the constant, and the file fails its type-check (TS2724) and
  its load (a `SyntaxError` at link time), or its build (CS0117). It names no release, so nothing is
  renamed in a release branch, and the product's version, 0008's third axis, stays out of the
  runtime's names.

_Conformance:_ none. _Matrix:_ none.

**11. Room for a validator.**

- Nothing now: the step that validates a request against its message's rules opens the layer again.
- **An optional `validate` member of a typed descriptor, empty here. Chosen**, the user's choice: the
  side that answers calls it after the decode and before the resolver, the side that requests before
  the encode when its options say so; nothing validates until a later step fills it, and a
  violation's shape is that step's. That step fills a slot rather than reopening the layer.

_Conformance:_ none. _Matrix:_ the feature row "The service layer".

## Decision

**A procedure says how it is called.** `IProcedure` and `Procedure` carry one optional member:

```ts
/**
 * A procedure's kind, how it is called: a request, a request that may also notify (spec 11.2), or a
 * command a server makes of a client. Never an envelope's kind, which is `REQUEST` for every call.
 */
export const ProcedureKind = Object.freeze({
  COMMAND: 'command',
  NOTIFIES: 'notifies',
  REQUEST: 'request',
} as const);
export type ProcedureKind = (typeof ProcedureKind)[keyof typeof ProcedureKind];

export interface IProcedure extends IProcedureAddress {
  // … its ids, name, revision, limit and deprecation
  /** Its kind; not given, nothing checks it. Never a debug event's `type`, which is a step's. */
  procedureKind?: ProcedureKind | undefined;
}
```

```csharp
/// <summary>
/// A procedure's kind, how it is called: a request, a request that may also notify (spec 11.2), or a
/// command a server makes of a client. Never an envelope's kind, which is REQUEST for every call.
/// </summary>
public enum ProcedureKind
{
    /// <summary>A request a client makes of its server.</summary>
    Request,

    /// <summary>A request whose call may open a subscription to its notifications.</summary>
    Notifies,

    /// <summary>A request a server makes of a client.</summary>
    Command,
}

public sealed record Procedure
{
    // … its ids, name, revision, limit and deprecation
    // ! named as its type: inside this record, ProcedureKind is this property, so a member written
    // here names the enum Bead.ProcedureKind
    /// <summary>Its kind; none checks nothing.</summary>
    public ProcedureKind? ProcedureKind { get; init; }
}
```

Each router checks it as a procedure is declared, by the way it is declared (spec 16.11, the table
of item 1), after its identity and before any reason of the router's own or its registry's: a
declaration refused declares nothing. A resolver is checked before it is registered and declared to
the registry; a requester before `declareRequester` hands it on; a notification before it is
registered. The refusal is the router's, as 16.10's are on each side: a `ProgrammerError`, an
`ArgumentException`, its sentence naming the procedure, its kind and what the way takes, the
TypeScript one ending with `against its kind`. The service manager checks a procedure's identity
alone, first; the kind is the routers', so a notification of a procedure whose kind is `request` is
refused as it is registered with its router. `procedureOf` carries `procedureKind`, and a
notification asked for again with another `procedureKind` is asked for otherwise. A debug event
never lays the procedure's kind out beside its `type`.

A procedure the runtime makes callable — a resolver, a requester, a notification — is a function
that carries its procedure's members as its own, read bare, none of them a member a function has:
its `call`, `apply` and `bind` stay the platform's, which a test of `service-manager.test.ts`
holds.

**The payload codecs are public, and a protobuf message's codec is made from two functions.**

```ts
/** How one encoding reads a payload and writes a value: what does not read, or write, throws. */
export interface IPayloadCodec<Value, Given = Value> {
  readonly decode: (bytes: Uint8Array) => Value;
  readonly encode: (value: Given) => Uint8Array;
}

/** A JSON value, as spec 17 reads one. */
export type JsonValue =
  boolean | number | string | null | readonly JsonValue[] | { readonly [name: string]: JsonValue };

/** The codecs of spec 17 by their encoding's name: a reader's refusal a SyntaxError, a writer's a TypeError. */
export const PAYLOAD_CODECS: Readonly<{
  json: IPayloadCodec<JsonValue, unknown>;
  raw: IPayloadCodec<Uint8Array>;
  text: IPayloadCodec<string>;
}>;

/**
 * A codec of `codec`'s two functions, frozen: a protobuf message's, from its stock library's
 * binary reader and writer. One that is not a function is a ProgrammerError.
 */
export const payloadCodecOf: <Value, Given = Value>(
  codec: IPayloadCodec<Value, Given>
) => IPayloadCodec<Value, Given>;
```

```csharp
/// <summary>How one encoding reads a payload and writes a value; what does not, throws.</summary>
public interface IPayloadCodec<T>
{
    /// <summary>The value a payload holds.</summary>
    T Decode(ReadOnlyMemory<byte> payload);

    /// <summary>The payload of a value.</summary>
    ReadOnlyMemory<byte> Encode(T value);
}

/// <summary>The codecs of spec 17, by their encoding's name; a refusal a FormatException.</summary>
public static class PayloadCodecs
{
    public static IPayloadCodec<ReadOnlyMemory<byte>> Raw { get; }
    public static IPayloadCodec<string> Text { get; }
    public static IPayloadCodec<JsonElement> Json { get; }

    /// <summary>A codec of two functions: a protobuf message's, from its stock library's.</summary>
    public static IPayloadCodec<T> Of<T>(Func<ReadOnlyMemory<byte>, T> decode, Func<T, ReadOnlyMemory<byte>> encode);
}
```

Generated code binds a `proto` payload with `payloadCodecOf` and `PayloadCodecs.Of`, passing its
stock library's reader and writer with Bead's bound, the payload's records checked before the
library reads them: what it writes, and what a `proto` payload is, are
[0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)'s.

**A rule says who may call a procedure, and a hook is data.**

```ts
/** Who may call a procedure: every call, a call with a session, or a hook the server is given by name. */
export type AdmissionRule<Hook extends string = string> =
  'none' | 'session' | { readonly hook: Hook };

/** A hook: whether a call may reach its resolver, on its header and its call's session, present or not. */
export interface IAdmissionHook<Handle extends string = ConnectionHandle> {
  /** Synchronous; only `true` admits. One that throws answers PROCEDURE_FAILED, and is reported. */
  readonly admits: (request: IAdmissionRequest<Handle>) => boolean;
  /** The detail of the ACCESS_DENIED a call it refuses is answered with; none says nothing. */
  readonly detail?: string | undefined;
}
```

```csharp
/// <summary>Who may call a procedure: every call, a call with a session, or a hook given by name.</summary>
public sealed record AdmissionRule
{
    public static AdmissionRule None { get; }
    public static AdmissionRule Session { get; }
    public static AdmissionRule Hook(string name);

    /// <summary>The hook's name, for a hook's rule; none for the others.</summary>
    public string? HookName { get; }
}

/// <summary>A hook: whether a call may reach its resolver, on its header and its call's session.</summary>
public sealed record AdmissionHook
{
    public required Func<AdmissionRequest, bool> Admits { get; init; }
    public string Detail { get; init; } = "";
}
```

As the service is offered, `none` gives no `beforeRequest`; `session` the side's `requireSession`;
and a hook a `beforeRequest` of its `admits` whose refusal is the router's own `ACCESS_DENIED`, with
the hook's detail, built once. A hook a procedure names that the options lack, a hook the options
give that no procedure names, and one that is no hook, are refused as the service layer is built: a
`ProgrammerError`, an `ArgumentException`.

**A service's failures are a catalogue, and each procedure answers the ones it lists.**

```ts
/** A failure of a catalogue, by its name: its code, and why. */
export interface IListedFailure<Name extends string = string> extends IApplicationFailure {
  readonly detail: string;
  readonly failureName: Name;
}

/** A failure of a catalogue, received and told by its name: an application FailureError of its service. */
export interface IListedFailureError<Name extends string = string> extends FailureError {
  readonly procedureAddress: IProcedureAddress;
  readonly scope: typeof FailureScope.APPLICATION;
  readonly [failureNameBrand]: Name;
}

/** A service's failures, by name: their codes, a failure made of one, and a failure received told as one. */
export interface IFailureCatalogue<Name extends string> {
  readonly codes: Readonly<Record<Name, number>>;
  readonly serviceId: ServiceId;
  /** Whether `error` is the application failure `name`, received from a procedure of its service. */
  is: <Given extends Name>(error: unknown, name: Given) => error is IListedFailureError<Given>;
  of: <Given extends Name>(name: Given, detail?: string) => IListedFailure<Given>;
}

/** A catalogue; a code outside 1 to 65,535, or two names of one code, is a ProgrammerError. */
export const failuresOf: <const Name extends string>(catalogue: {
  codes: Readonly<Record<Name, number>>;
  serviceId: ServiceId;
}) => IFailureCatalogue<Name>;
```

```csharp
/// <summary>A procedure's own failure, of its service's catalogue: its code.</summary>
public interface IApplicationFailure
{
    /// <summary>Its code, from 1 to 65,535 (spec 9.5).</summary>
    ushort Code { get; }
}

/// <summary>The failure of a procedure that lists none: it has no value.</summary>
public sealed class NoFailure : IApplicationFailure { /* a private constructor, and no instance */ }

/// <summary>A refusal of admission a resolver answers: ACCESS_DENIED or SESSION_REQUIRED, and why.</summary>
public sealed record AdmissionFailure
{
    public static AdmissionFailure AccessDenied(string detail = "");
    public static AdmissionFailure SessionRequired(string detail = "");
}

/// <summary>A service's catalogue: whether a failure received is one of it.</summary>
public sealed class FailureCatalogue
{
    public FailureCatalogue(ushort serviceId);
    public ushort ServiceId { get; }

    /// <summary>Whether the exception is that application failure, from a procedure of this service.</summary>
    public bool Is(FailureException exception, IApplicationFailure failure);
}

// FailureException holds the TypeScript side's two
public bool IsApplication();
public bool IsApplication(ushort code);
public bool IsApplication(IReadOnlyCollection<ushort> codes);
public bool IsProtocol(ProtocolCode code, RouterSide? side = null);
public bool IsProtocol(IReadOnlyCollection<ProtocolCode> codes, RouterSide? side = null);
```

A resolver of the service layer answers a result, a failure its procedure lists, or a refusal of
admission. On the TypeScript side, a failure of the catalogue its procedure does not list, which only
a cast reaches, is sent as written, and its server reports a `ProgrammerError` through its router's
error event, with the call's connection: the caller hears what it would hear without the layer. On
the C# side, the procedure's failure class is its list, and no other value reaches `Fail`.

**A procedure's descriptor is one object, with room for a validator.**

```ts
/** What every descriptor holds. */
export interface IDescriptorInit {
  readonly admission: AdmissionRule;
  readonly failures: Readonly<Record<string, number>>;
  readonly procedure: IProcedure;
  readonly request: IPayloadCodec<unknown, never>;
  readonly result: IPayloadCodec<unknown, never>;
  /** Throws on a request its rules refuse; none validates nothing. */
  readonly validate?: ((request: unknown) => void) | undefined;
}

/** A request's descriptor, `notification` given for a procedure that notifies: its procedure's kind set. */
export const requestOf: <const Init extends IRequestInit>(init: Init) => RequestDescriptor<Init>;

/** A command's descriptor: a command never notifies. */
export const commandOf: <const Init extends IDescriptorInit>(init: Init) => CommandDescriptor<Init>;
```

```csharp
/// <summary>A procedure of the service whose type tag is TService, whatever its kind.</summary>
public interface IServiceProcedure<TService>
{
    Procedure Procedure { get; }
    AdmissionRule Admission { get; }
}

public sealed class RequestProcedure<TService, TRequest, TResult, TFailure> : IServiceProcedure<TService>
    where TFailure : IApplicationFailure
{
    public RequestProcedure(Procedure procedure, ProcedureBindings<TRequest, TResult> bindings);
}

public sealed class RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> : IServiceProcedure<TService>
    where TFailure : IApplicationFailure
{
    public RequestProcedure(Procedure procedure, ProcedureBindings<TRequest, TResult, TNotification> bindings);
}

public sealed class CommandProcedure<TService, TRequest, TResult, TFailure> : IServiceProcedure<TService>
    where TFailure : IApplicationFailure
{
    public CommandProcedure(Procedure procedure, ProcedureBindings<TRequest, TResult> bindings);
}

/// <summary>A procedure's admission and its payloads' codecs.</summary>
public sealed record ProcedureBindings<TRequest, TResult>
{
    public required AdmissionRule Admission { get; init; }
    public required IPayloadCodec<TRequest> Request { get; init; }
    public required IPayloadCodec<TResult> Result { get; init; }
    public Action<TRequest>? Validate { get; init; }
}

// and ProcedureBindings<TRequest, TResult, TNotification>, with a required Notification
```

A descriptor sets its procedure's `procedureKind`: `request` or `notifies` by `requestOf` and the request
classes, as `notification` is given or not, and `command` by `commandOf` and `CommandProcedure`; a
procedure that states another is refused as the descriptor is made, and so is a codec missing. A
descriptor is no declaration: its identity and its kind are checked as it is declared (spec 16.10),
by `on`, `offer`, or the client side's building.

`validate` is empty until a later step fills it. The side that answers calls it on the decoded
request, before the resolver: a server's resolvers, and a client's command resolvers; one that
throws is answered `PROCEDURE_FAILED` and reported. The side that requests calls it before the
encode on the client alone, when its options say so, `validates` and `Validates`, and a throw fails
the call before anything goes; a server's commands never validate, since nothing gives them that
option.

**One layer serves and calls a service, in each runtime.**

```ts
/** The server side of a service, offered on one Bead server. */
export interface IServiceServer<S extends ServiceProcedures, Data = unknown> {
  /** A requester of each command, made as the service is offered; one called before is a ProgrammerError. */
  readonly command: {
    readonly [Name in CommandName<S>]: IRequest<
      GivenOf<S[Name]['request']>,
      ValueOf<S[Name]['result']>,
      TransportServerConnectionHandle
    >;
  };
  /** Notifies each procedure's subscribers; before the service is offered, it sends nothing and resolves. */
  readonly notify: {
    readonly [Name in NotifyingName<S>]: (
      notification: GivenOf<S[Name]['notification']>,
      options?: INotifyOptions<TransportServerConnectionHandle>
    ) => Promise<void>;
  };
  /** Offers every resolver, now and later, on `server`; a second offer is a ProgrammerError. */
  offer: (server: IServer<IServerTransportLike, Data>) => void;
  /** Registers a procedure's resolver, before or after `offer`; twice for one procedure is a ProgrammerError. */
  on: <Name extends AnsweredName<S>>(
    name: Name,
    callback: ServiceResolverCallback<S[Name]>
  ) => void;
  /** The procedures a client calls that no `on` answers: the router answers them PROCEDURE_UNKNOWN. */
  proceduresWithoutResolver: () => readonly IProcedure[];
}

export const createServiceServer: <const S extends ServiceProcedures, Data = unknown>(
  procedures: S,
  ...options: ServiceServerOptions<S>
) => IServiceServer<S, Data>;

/** The client side of a service, over one Bead client. */
export interface IServiceClient<S extends ServiceProcedures> {
  /** The notification of each procedure that notifies, at the window its caller gave, or none. */
  readonly notifications: {
    readonly [Name in NotifyingName<S>]: INotification<
      GivenOf<S[Name]['request']>,
      ValueOf<S[Name]['notification']>
    >;
  };
  /** A requester of each procedure its server answers, made as the client side is built. */
  readonly request: {
    readonly [Name in AnsweredName<S>]: IRequest<
      GivenOf<S[Name]['request']>,
      ValueOf<S[Name]['result']>,
      RouterClientConnectionHandle
    >;
  };
  /** Registers the resolver of a command it answers; twice for one command is a ProgrammerError. */
  on: <Name extends CommandName<S>>(name: Name, callback: ServiceResolverCallback<S[Name]>) => void;
}

/** What a client side is given besides its Bead client: a window for each procedure that notifies, and whether it validates. */
export interface IServiceClientOptions<S extends ServiceProcedures> {
  readonly validates?: boolean | undefined;
  readonly windows?: { readonly [Name in NotifyingName<S>]?: number | undefined } | undefined;
}

export const createServiceClient: <const S extends ServiceProcedures>(
  procedures: S,
  client: IClient,
  options?: IServiceClientOptions<S>
) => IServiceClient<S>;
```

`ServiceServerOptions<S>` is an optional options object for a service whose procedures name no
hook, and a required one, its `admissions` required, for one that names any, so
`createServiceServer(procedures)` holds for the first. A client side takes its Bead client as a
parameter of its own, and its options after it, every one optional, as Connect-ES's
`createClient(service, transport)` takes its transport.

```csharp
/// <summary>The server side of the service whose type tag is TService, offered on one Bead server.</summary>
public sealed class ServiceServer<TService, TData>
{
    // the options required in the one that takes them, and none for procedures that name no hook (0007)
    public ServiceServer(IReadOnlyList<IServiceProcedure<TService>> procedures, ServiceServerOptions<TService> options);
    public ServiceServer(IReadOnlyList<IServiceProcedure<TService>> procedures);

    public void On<TRequest, TResult, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TFailure> procedure,
        ServiceResolverCallback<TRequest, TResult, TFailure> callback)
        where TFailure : IApplicationFailure;

    public void On<TRequest, TResult, TNotification, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> procedure,
        ServiceNotificationResolverCallback<TRequest, TResult, TFailure> callback)
        where TFailure : IApplicationFailure;

    public void Offer(IBeadServer<TData> server);

    public Func<TRequest, BoundCall<TResult>> CommandOf<TRequest, TResult, TFailure>(
        CommandProcedure<TService, TRequest, TResult, TFailure> procedure)
        where TFailure : IApplicationFailure;

    public Func<TNotification, NotifyOptions?, Task> NotifierOf<TRequest, TResult, TNotification, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> procedure)
        where TFailure : IApplicationFailure;

    public IReadOnlyList<Procedure> ProceduresWithoutResolver();
}

/// <summary>The hooks a server side of TService is given, as the layer reads them: each by the name its procedures give it.</summary>
public interface IServiceAdmissions<TService>
{
    IReadOnlyDictionary<string, AdmissionHook> ToDictionary();
}

/// <summary>What a server side of TService is given: its hooks, an empty record where its procedures name none.</summary>
public sealed record ServiceServerOptions<TService>
{
    public required IServiceAdmissions<TService> Admissions { get; init; }
}

/// <summary>The client side of the service whose type tag is TService, over one Bead client.</summary>
public sealed class ServiceClient<TService>
{
    public ServiceClient(IReadOnlyList<IServiceProcedure<TService>> procedures, IClient client, ServiceClientOptions<TService>? options = null);

    public Func<TRequest, BoundCall<TResult>> RequesterOf<TRequest, TResult, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TFailure> procedure)
        where TFailure : IApplicationFailure;

    // and RequesterOf for a procedure that notifies: its requester opens no subscription
    public INotification<TRequest, TNotification> NotificationOf<TRequest, TResult, TNotification, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> procedure)
        where TFailure : IApplicationFailure;

    public void On<TRequest, TResult, TFailure>(
        CommandProcedure<TService, TRequest, TResult, TFailure> procedure,
        ServiceResolverCallback<TRequest, TResult, TFailure> callback)
        where TFailure : IApplicationFailure;
}

/// <summary>The window of each procedure of TService that notifies, as the layer reads them: each by its name, null where it goes unpaced.</summary>
public interface IServiceWindows<TService>
{
    IReadOnlyDictionary<string, int?> ToDictionary();
}

/// <summary>What a client side of TService is given besides its Bead client: a window for each procedure that notifies, and whether it validates.</summary>
public sealed record ServiceClientOptions<TService>
{
    public IServiceWindows<TService>? Windows { get; init; }
    public bool Validates { get; init; }
}

/// <summary>A service's hooks, as generated code writes them, and as a service written without beadc writes them: a required member a hook.</summary>
public sealed class GreeterAdmissions : IServiceAdmissions<GreeterProcedures>
{
    public required AdmissionHook Loud { get; init; }

    IReadOnlyDictionary<string, AdmissionHook> IServiceAdmissions<GreeterProcedures>.ToDictionary()
    {
        return new Dictionary<string, AdmissionHook> { ["loud"] = Loud };
    }
}

// and GreeterWindows : IServiceWindows<GreeterProcedures>, an int? a procedure that notifies

/// <summary>How a resolver of the service layer answers: a result, a failure its procedure lists, or a refusal.</summary>
public interface IServiceResponse<TResult, TFailure> where TFailure : IApplicationFailure
{
    Task Answer(TResult result);
    Task Fail(TFailure failure, string detail = "");
    Task Fail(AdmissionFailure refusal);
}

// IServiceNotificationResponse<TResult, TFailure> adds Task<uint> RegisterNotification();
// ServiceResolverCallback<TRequest, TResult, TFailure> and ServiceNotificationResolverCallback<…> are the delegates
```

C# computes no type from another's members. A service's hooks and windows are records that its
generated code, or its author, writes, one for every service, which the layer reads through an
interface tied to the service's tag. A hook left out does not compile on either side. A service
written without beadc writes its records as the tests' `GreeterAdmissions` does. Each record
implements its interface's `ToDictionary()` explicitly, a conversion named as .NET's Framework
Design Guidelines name one, so a hook named `toDictionary` still builds beside it; the layer calls
it once, as it is built.

`Data` is the server's own: a server side offered on a server of `string` sessions is made with
`string`, as the interop's is, since the server's `sessions` is read and written through it. The
TypeScript side's response is the runtime's, narrowed: `response(result)`, or `response(null,
failure)` with `failure` an `IListedFailure` of a name its procedure lists or an `AdmissionFailure`;
a procedure that notifies adds `registerNotification()`. `IServiceResponse` and `IRegistrar` are
type aliases despite their `I`, since a conditional type is no interface and the lint refuses an
empty one. The C# side's `ProceduresWithoutResolver` is a method, as `Gauges` is.

What the layer refuses, as it is built or used:

| Mistake                                                                                            | TypeScript                                      | C#                                                                 |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `on` twice for one procedure, offered or not                                                       | `ProgrammerError`                               | `ArgumentException`, as the router's second resolver               |
| `on` of a name the service lacks, or of a command on the server side, a request on the client side | compile error; `ProgrammerError` past the types | compile error                                                      |
| `on` of a command admitted by a hook, on the client side                                           | `ProgrammerError`                               | `ArgumentException`                                                |
| `offer` twice                                                                                      | `ProgrammerError`                               | `InvalidOperationException`                                        |
| a command's requester called before `offer`                                                        | `ProgrammerError`                               | `InvalidOperationException`                                        |
| a hook a procedure names, missing from the options; one the options give that no procedure names   | compile error for a literal; `ProgrammerError`  | compile error for a record; `ArgumentException` past it            |
| a hook that is no hook                                                                             | `ProgrammerError`                               | `ArgumentException`                                                |
| a window for a procedure that does not notify                                                      | compile error for a literal; `ProgrammerError`  | compile error for a record; `ArgumentException` past it            |
| a window that is not a whole number above 0                                                        | `ProgrammerError`, the notification's           | `ArgumentException`, the notification's                            |
| a second client side over one Bead client, at another window                                       | `ProgrammerError`, item 8's                     | `InvalidOperationException`, item 8's                              |
| an unlisted failure code answered                                                                  | sent as written; `ProgrammerError` reported     | no counterpart: the failure class holds its procedure's list alone |

**A call bound to its payload is a bound call, and it carries the guard.** The runtime's procedure
takes its payload and gives a function of the call's options; that function is named, on both sides,
and the guard sits on it alone:

```ts
/** A call bound to its payload: called with its options, it goes. */
export interface IBoundCall<Result, Options extends unknown[] = RequestOptionsParameters> {
  (...options: Options): Promise<Result>;
  /** Never set: awaiting the bound call, its options' call forgotten, is TS1320. */
  readonly then?: (guard: never) => never;
}

export interface IRequest<
  RequestPayload,
  ResponsePayload,
  Handle extends string = ConnectionHandle,
> extends IProcedure {
  (requestPayload: RequestPayload): IBoundCall<ResponsePayload, RequestOptionsParameters<Handle>>;
}

// INotification's call gives IRegistrar: an IBoundCall<INotificationRegistration, [options?: …]>
```

On the C# side, the delegate is `BoundCall<TResponse>`, and `Registrar` keeps its name, since it
names neither a registration nor a request; `IRegistrar` is its TypeScript twin. The spec's
_requester_ is the party that makes a request ("as a requester is made, through the router's
`declareRequester`", `spec/debugging.md`), which a delegate named `Requester<TResponse>` would
give a second meaning; the bound call is named after the call it makes, the user's choice, though
the object makes a call rather than being one.

What the guard catches, under TypeScript 7.0.2: `await procedure(request)` and `await
Promise.resolve(procedure(request))` (TS1320); a bound call awaited inside `Promise.all` whose result
is returned (TS1058). What it leaves: `Promise.all` awaited for its effect alone, and `await
procedure` with no payload given, both caught by oxlint's type-aware `await-thenable` where a project
runs it. What it costs: an async function that returns a bound call, as a factory that waits for its
client's connection would, is TS1058; it returns the procedure, or its caller binds the payload.

**A notify filter takes one argument.**

```ts
/** Who holds a subscription: a connection, in a session of its own — a credential's, named by its identifier; its connection's, none. */
export interface ISubscriber<Handle extends string = ConnectionHandle> {
  readonly connectionHandle: Handle;
  readonly identifier?: SessionIdentifier | undefined;
}

export interface INotifyOptions<Handle extends string = ConnectionHandle> {
  exclude?: Handle | undefined;
  filter?: ((subscriber: ISubscriber<Handle>) => boolean) | undefined;
  key?: NotificationKey | undefined;
}
```

```csharp
/// <summary>Who holds a subscription: a connection, and the identifier of the session holding it; none for its connection's.</summary>
public readonly record struct Subscriber
{
    /// <summary>Its connection.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>Its credential's session's identifier; none for its connection's session.</summary>
    public SessionIdentifier? Identifier { get; init; }
}

// NotifyOptions.Filter and NotifyRequest.Filter: Func<Subscriber, bool>?

/// <summary>What a router's notify is given beside its payload: the procedure, and whom it goes to.</summary>
public sealed record NotifyRequest
{
    public required ProcedureAddress Procedure { get; init; }
    public Func<Subscriber, bool>? Filter { get; init; }
    public object? Key { get; init; }
}

// IRouterLike
Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request);
Task Notify(Exception unwritten, NotifyRequest request);
```

The router's `notify` takes the same filter, so one shape exists; the C# side's notification manager
holds `Subscriber`. The TypeScript side's `notify(payload: Uint8Array | Error, { filter?, key?,
procedure })` and the C# side's two overloads are one shape, the overloads the union's two arms.

**A notification asked for again at another window is refused**, after the procedure's identity,
as another name, revision, deprecation or limit is: a `ProgrammerError` naming both windows (`… is
already a notification with window 4, not 1`), and on the C# side an `InvalidOperationException`,
as "asked for otherwise" is. The same window, or none twice, gives the same notification.

**The C# side has a server's interface and `IClient`.**

```csharp
/// <summary>A server of Bead: its layers, its sessions, its admissions, and what it holds.</summary>
public interface IBeadServer<TData> : IAsyncDisposable
{
    IServerTransport Transport { get; }
    RouterServer Router { get; }
    ServiceManager Services { get; }
    SessionManager<TData> Sessions { get; }
    BeforeRequest RequireSession { get; }
    BeforeRequest RequireCredential { get; }
    BeforeRequest ShareLegBSession { get; }
    Task<ServerGauges> Gauges();
    Task<Health> Health();
}

/// <summary>A client of Bead: its layers, and what every client's transport does but connect.</summary>
public interface IClient : IAsyncDisposable
{
    RouterClient Router { get; }
    ServiceManager Services { get; }
    Task Disconnect(TransportDisconnectOptions? options = null);
    Task Reconnect(TransportReconnectOptions? options = null);
}
```

`Server<TData>`, `WebSocketServer<TData>` and `HttpServer<TData>` implement the first, the last two
holding `RequireCredential` and `ShareLegBSession` and giving their transport by an explicit
implementation; `WebSocketClient` and `BeadHttpClient` the second. Both live in `Bead.Core`.

**The TypeScript side's service layer is one entry**, `"./service": "./src/service/service.ts"` in
`package.json`'s `exports`: `createServiceServer`, `createServiceClient`, `requestOf`, `commandOf`,
`failuresOf`, `payloadCodecOf`, `PAYLOAD_CODECS`, `ProcedureKind`,
`GENERATED_CODE_SUPPORTS_VERSION_3`, `FailureError`, `ProgrammerError`, and their types. A generated
file imports nothing else of Bead's but `./proto`'s check, where it binds `proto`
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).

**Generated code names the contract it needs.** `GENERATED_CODE_SUPPORTS_VERSION_3` in `./service`,
`true`; `GeneratedCode.SupportsVersion3`, a `const bool` on a static class in `Bead.Core`. A
generated file names the highest it needs: `void GENERATED_CODE_SUPPORTS_VERSION_3;`, and in C# a
private constant of it. The counter moves only when generated code needs something the runtime did
not have: 2 for the layer's options typed by the service, `IServiceClientOptions` and the client
side's Bead client apart on the TypeScript side, `IServiceAdmissions<TService>`,
`IServiceWindows<TService>`, `ServiceServerOptions<TService>`, `ServiceClientOptions<TService>` and
the client side's three parameters on the C# side; 3 for the check of a `proto` payload's records,
`checkProtoRecords` and `ProtoRecords.Check`
([0028](0028-a-proto-payloads-records-are-read-against-its-message-before-its-library-reads-them.md)).
An older constant stays while the runtime still serves the code that names it: before 1.0.0, it goes
once the code that names it no longer conforms through the runtime, and from 1.0.0 it stays for the
whole major. The runtime holds 3 alone: code that names 2 reads a `proto` payload unchecked, which
does not conform. A file of a later beadc, built against a runtime that lacks its constant, fails
on the counter (TS2724, CS0117), not on a signature.

**Where it lives.** The TypeScript side: `src/service/` — `service.ts` the entry,
`service-server.ts`, `service-client.ts`, `descriptors.ts`, `failures.ts`, `generated-code.ts`, a
test file each in `src/service/__tests__/`; the codecs stay in `router/shared/payloads.ts`, with
`payloadCodecOf` beside them; `ProcedureKind` in `router/shared/constants.ts`; `ISubscriber`,
`IBoundCall` and `IRegistrar` in `router/shared/types.ts`; `checkProcedureKind` in
`router/shared/identity.ts`, run by each router. The C# side, in `Bead.Core`: `ServiceServer.cs`,
`ServiceClient.cs`, `ServiceProcedures.cs` (the descriptors, `ProcedureBindings`, `AdmissionRule`,
`AdmissionHook`), `FailureCatalogue.cs` (with `IApplicationFailure`, `NoFailure`,
`AdmissionFailure`), `PayloadCodecs.cs` (public, over the internal `Payloads`), `GeneratedCode.cs`,
`IBeadServer.cs`, `IClient.cs`; `ProcedureKind` in `RouterTypes.cs`, `Subscriber` and
`NotifyRequest` beside `NotifyOptions`, the kind's check in `Identity.cs`, run by the core and each
router.

**The rule has its gate** ([0006](0006-a-rule-has-its-gate.md)): `spec/identities.json`'s group of
procedure kinds, played the six ways on both sides; the test of `service-manager.test.ts` that holds
a callable's members; the twin tests of the feature row "The service layer"; `yarn check` and
`dotnet format`/`dotnet test` over the layer's code.

## Consequences

**What a peer receives is the protocol's alone.** The layer adds no envelope, no code and no
conversation; what it adds is what a side refuses as it is built: a procedure declared against its
kind, a notification asked for again at another window.

**On the TypeScript side, a member joining `IProcedure` must not be named as a function's member**
(`call`, `apply`, `bind`, `name`, `length`): the runtime merges the procedure into the callable it
hands out, whose own member would shadow the platform's, or be read through the prototype where the
procedure states none. A test of `service-manager.test.ts` holds it, over every member of a full
`IProcedure`; `name` alone is set on purpose, to the procedure's name. The C# side merges no
procedure into a delegate, a platform row of the matrix.

**On the TypeScript side, the layer's mapped types iterate `keyof S` and filter it**, so that a
descriptor's `@deprecated` reaches each member mapped from it: a requester, a notification, a
window's key, a command's requester, a notifier and a resolver's key, each reported where it is used
by `no-deprecated`, typescript-eslint's and oxlint's; a test of `service-client.test.ts` and one of
`service-server.test.ts`, named alike, hold it.

**A third language** plays the `procedureKinds` group the six ways, and the `proto` rows as
[0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md) says.

## The Tenth Man

The draft met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)), at
xhigh effort, on every name of the surface, the `proto` rows and their schema, the filter's shape,
the window's refusal and the procedure's kind. Each claim was verified before its answer; the user
chose where it asked, each way as the revised draft recommended, and added room for a validator. The
name of the procedure's kind met it on its own, at xhigh effort: the table's last ten rows. Its rows
on `proto`, the section, the nesting bound and the writer's clause, are
[0031](0031-a-proto-payload-is-protobufs-format-and-bead-states-only-its-own.md)'s, which keeps them.
Its other objections, each with its answer:

| Objection                                                                                                                                                                                                                                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The service manager checks the type by the accessor's name, yet Bead types a call by the router's side, so `getRequest` on a server passes; the check belongs where 0017 put identity, at the router; "no peer sees it" is no reason against a file | Accepted: verified in `spec/debugging.md` 8.2, the metrics registry and both routers' `declareRequester`. Each router checks the procedure's kind at its declaration, by the ways of `spec/identities.json`, before registering anything; the manager adds no reason, and 0017's paragraph stands. The reason joins 16.10 and the file, the user's choice                                                                                                                                                                                                           |
| "The procedure's type is the trace's type" is false: the trace's `type` takes `notification` and types a step; two optional members bring back a state the builder's `oneof` made impossible, then refuse it at run time                            | Accepted: verified in `spec/debugging.md` 4.1, `DebugType` on both sides, the service manager's trace of a notification, and `IDebugEvent` laid out flat. One optional member, `procedureKind`, `request`, `notifies` or `command`: the `oneof`'s two members and the plain request it means unset, since an absent member on a hand-written procedure checks nothing. No state is refused. The blueprint follows                                                                                                                                                   |
| `createAPIServer`, `ApiServer<TApi, TData>` and their peers bring an abbreviation into Bead's names, for a layer that serves one service, and take the word the builder leaves to a per-package aggregate                                           | Accepted: verified, no name under `implementations/*/src` holds _API_, and 0003 lists the words it owns. The layer is named after a service — `createServiceServer`, `ServiceServer<TService, TData>`, `IServiceProcedure<TService>`, `./service` — the user's choice against _API_ with 0003 amended                                                                                                                                                                                                                                                               |
| The C# `Subscriber`, a positional record struct, breaks every filter that deconstructs it, matches it by position or constructs it the day a member joins, which is item 7's only reason; and `SubscriptionPlace` stays beside it                   | Accepted: the probe gives CS8129, CS8130 and CS7036; a `readonly record struct` of `init` properties builds clean under the repository's gates with a third member against the same filters. `Subscriber` replaces the internal `SubscriptionPlace`                                                                                                                                                                                                                                                                                                                 |
| `JsonValue` both ways is neither sound nor complete against 17.7, refuses an interface-typed value the house style writes, and its break is of nothing public                                                                                       | Accepted: re-run, the type takes `NaN`, an infinity and a lone surrogate and refuses an interface-typed value (TS2322). `JsonValue` read, `unknown` written; 17.7's refusals stay at run time. The Consequences drop the break, and the interop's casts are not moved                                                                                                                                                                                                                                                                                               |
| A constant per release binds a public name to a number git-flow gives at the release branch, needs CA1707 overruled, and gives the product's version a name the runtime holds; 0008 refused "nothing is published"                                  | Accepted: a counter of the contract with generated code, as gRPC-Go's `SupportPackageIsVersion9` (its doc read on pkg.go.dev), `GENERATED_CODE_SUPPORTS_VERSION_<n>` and `GeneratedCode.SupportsVersion<n>` at the number the Decision gives, CA1707 standing                                                                                                                                                                                                                                                                                                       |
| The guard on `IRequest` refuses an async function that hands a requester on, a legitimate pattern the draft does not count                                                                                                                          | Accepted: reproduced (TS1058). The guard sits on the bound call alone, which still makes the forgotten call TS1320. What it leaves and costs is stated: `await procedure` goes to oxlint's `await-thenable`, and an async function returning a bound call is still TS1058                                                                                                                                                                                                                                                                                           |
| `IBoundRequest` and `IBoundRegistration` each give a word a second meaning; "requester" already names the outer object; the C# renames are breaks the Consequences omit                                                                             | Accepted in part: verified in the shared types, the C# `Registrar`, 0003 and `spec/debugging.md`. The bound call is named after the call it makes, `IBoundCall` and `BoundCall<TResponse>`, the C# rename a break in "Changed", the user's choice; `Registrar` already names neither a registration nor a request, so it stays, and the TypeScript side gains `IRegistrar`. Refused in part: _bound call_ is no exact fit either, since the object makes a call rather than being one; the record says so, and no name found fits better                            |
| The run-time report of an unlisted code guards a TypeScript cast, which the C# types make unreachable; `Failures` restates the class's members; the difference is a matrix row, not a twin test                                                     | Accepted: `ProcedureBindings` holds no `Failures`, and `IServiceProcedure` no `FailureCodes`, which nothing would read; the C# side checks nothing; a platform row names the TypeScript test `sends an unlisted code as written, and reports it`, as "A value a side's type cannot hold" does for a value                                                                                                                                                                                                                                                           |
| `IServer<TData>` takes ASP.NET Core's name in the very projects that call it, against 0003, with 0008's `HealthStatus` for precedent                                                                                                                | Accepted in part: the collision verified, arity keeping the compiler right and the reader not; `IBeadServer<TData>`, the user's choice, as 0003 has it for a new name. Refused, the precedent as stated: 0008 kept `HealthStatus` and qualified the builder's output with `global::Bead.`, "Nothing else is renamed"; it is a precedent for keeping a name already in the tree, which weighs for `IServer<TData>`, not against it                                                                                                                                   |
| The test that refuses `callKind` refuses `procedureKind` too: a procedure of kind `command` answers envelopes of kind `REQUEST`, and the two kinds meet where a request is routed to its procedure                                                  | Accepted in part: verified in spec 9.1 and 16.11, `IRequestHeader` and `IProcedure` over one `IProcedureAddress`, and the router that finds a request's resolver by its header. 16.11, 0003, the constant's doc and the enum's summary say a procedure's kind is never its envelopes'. Refused, the symmetry: `callKind`'s disagreement is on one noun, the call, whose kind and type would differ on the same call; `procedureKind`'s is across two owners, each always written; and `callKind` gives _kind_ the same second owner. The user chose `procedureKind` |
| 0003's "bare, it is an envelope's" is false in the tree, and a general definition of _kind_ fits every enum, `DebugType` among them                                                                                                                 | Accepted: verified, and wider than raised: `spec/durations.json`'s place `kind`, the devtools record's `kind` and the C# `AdmissionKind` are bare too. 0003 gives no general definition: it names the procedure as _kind_'s second owner, and asks a kind be named with its owner where it sits in one structure beside an envelope's. The other bare kinds stay as they are, none beside an envelope's in one structure; the devtools record, [0015](0015-a-pages-client-announces-itself-to-a-devtools-hook.md)'s format, is the one a later round may take up    |
| protobuf-es does not name this concept: its `kind` is generic, its `methodKind` the streaming axis; `oneof kind` puts three kinds on one rpc                                                                                                        | Accepted in part: verified in `@bufbuild/protobuf`'s descriptors. No standard names the axis. `oneof procedure_kind`, whose local name in protobuf-es is `procedureKind`. The streaming shape is another axis, a member of its own named the day Bead has streams, never a value of `procedureKind`; refused, naming that member now, for an axis Bead does not have                                                                                                                                                                                                |
| The prefix's stated reason is wrong, 0008 qualifying packages, namespaces and headers; the record's own pattern, `ProcedureKind? Kind`, has no C# trap                                                                                              | Accepted in part: the reason is objection 1's meeting. The request header and the procedure are siblings over one address, the header carrying `kind`, so `procedureKind` reads alone, as `procedureId` and `procedureName` do; `deprecation` and `maximumPayloadBytes`, which nothing sits beside, stay bare. Both options went to the user, who chose `procedureKind`; the C# property named as its type carries a `!` comment, since inside `Procedure` its name binds to the property                                                                           |
| The defect is understated: a procedure that states its kind under a function's member name overwrites the callable's method, and a test of a plain object does not cover the callable                                                               | Accepted: verified, a function given a member `call` by `Object.assign` throws `r.call is not a function`, and `r.apply` still answers. A test of `service-manager.test.ts` holds that a requester, a resolver and a notification carry their procedure's members as their own and keep a function's `call`, `apply` and `bind`, and that no member of a full `IProcedure` is a bare function's; a platform row of the matrix names it; the Consequences keep the constraint on a member to come                                                                    |
| Sites are missed: `getNotification`'s doc, and `spec/interop-service.json`                                                                                                                                                                          | Accepted: `getNotification`'s doc says kind, and the interop's procedures take theirs in `spec/interop-blueprint.json`, where `interop-service.json`'s `offeredBy` and `notifies` gave none ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s second round)                                                                                                                                                                                                                                                           |
| Item 1's reason, the mirror of the builder's `oneof`, does not hold with `oneof kind`                                                                                                                                                               | Accepted: `oneof procedure_kind`, the mirror held letter for letter in the front end, the blueprint and the runtime; item 1 keeps its reason, with 0003 and a function's members added                                                                                                                                                                                                                                                                                                                                                                              |
| `callKind`'s first refusal is untrue: a kind of call is 0003's one sense of _call_                                                                                                                                                                  | Accepted: `callKind` is refused on the trace's _type of call_ alone (`spec/debugging.md` 4.1): a call to a procedure that notifies is traced `request`, while its `callKind` would say `notifies`, two classifiers of one noun that disagree on the same call                                                                                                                                                                                                                                                                                                       |
| The values freeze with the name: `request` has three extents, two of them called kinds                                                                                                                                                              | Accepted in part: verified in spec 3.1, 9.1 and 16.11 and `spec/debugging.md` 4.1, the values unreleased. The user kept them, the `oneof`'s members and its unset meaning, and 16.11 and 0003 write the extents. Refused, renaming the plain value: no word says "a request answered, nothing more" better than `request`                                                                                                                                                                                                                                           |
| `against its kind` reads as an envelope's in the spec's files                                                                                                                                                                                       | Accepted in part: verified where the spec and its files say an envelope's kind. In 16.10 and `spec/identities.json` the subject is the declared procedure and no envelope is near, and 0003 does not read a bare kind as an envelope's. `against its procedure kind` went to the user, who chose `against its kind`                                                                                                                                                                                                                                                 |

### On the options typed by the service

The service layer's options, typed by the service on both sides, met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at xhigh effort, on their form and
not on the choice to type them. Each claim was verified before its answer; the user chose where it
asked, each way as the revised design recommended. Its objections, each with its answer:

| Objection                                                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The server's options have a required member yet are taken as optional, which [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md) forbids | Accepted: as 0007 maps a union, the layer takes `(procedures)` and `(procedures, options)`, the options required in the one that takes them, and so does a generated server whose procedures name no hook; a server whose procedures name one takes `(options)` alone                                                                                                                                                                 |
| Typing the options moves the contract with generated code, which nothing says                                                                           | Accepted: generated code needs types the 0.2.0 runtime lacks, so the counter moves to 2 on both sides, `GENERATED_CODE_SUPPORTS_VERSION_2` and `GeneratedCode.SupportsVersion2`; 1 is dropped, since no runtime serves its code any longer and no released generator wrote it; an older constant stays while the runtime serves its code, and from 1.0.0 for the whole major. Refused: redefining 1, which a 0.2.0 runtime would pass |
| Taking the client's Bead client apart reverses 0007's answer, and its cost is weighed against the wrong baseline                                        | Accepted: the asymmetry was put to the user, keeping the client in the options costing the TypeScript side nothing released, and the user took the client apart, a parameter of its own on both layers and both generated clients; 0007's answer is revised, for the runtime client's practice (Connect-ES's `createClient(service, transport)`) and options optional on both sides                                                   |
| A nullable required record of hooks lets a missing record compile, and two differences go unlisted                                                      | Accepted: `Admissions` is required and not nullable, a record of hooks is generated for every service, empty when none is named, and the differences left are listed: a layer given no options for a service that names a hook compiles in C#, and a hookless service's options name its empty hooks                                                                                                                                  |
| A service written without beadc pays more than stated, and is a .NET consumer's only path                                                               | Accepted in part: the C# sketch and the changelog say that such a service writes its records, as the tests' do. Refused, the user's choice: a public record by name, a type on the C# side alone; the records keyed by name go, and one typed form holds on both sides                                                                                                                                                                |
| The generated code of the two sides shares no options name, and TypeScript can close the gap                                                            | Accepted: both sides generate `<Name>Admissions` and `<Name>Windows` for every service; TypeScript's `<Name>ServerOptions` and `<Name>ClientOptions` remain, which C# cannot alias                                                                                                                                                                                                                                                    |
| `ByName` is a preposition, and a property that copies at each call                                                                                      | Accepted: `ToDictionary()`, a method named as the Framework Design Guidelines name a conversion; its explicit implementation keeps it off a record's surface                                                                                                                                                                                                                                                                          |
| C#'s new refusal checks the hooks in another order than the TypeScript side                                                                             | Accepted: each hook given is checked in turn, first that a procedure names it and then that it admits by a function, on both sides, and the twins assert which hook is named                                                                                                                                                                                                                                                          |
| The runtime's break is not the C# target's, and has a branch of its own to land on                                                                      | Accepted, the user's choice: the runtime's break is a change of its own, ahead of the C# target's, which keeps the C# target's change to the target                                                                                                                                                                                                                                                                                   |
