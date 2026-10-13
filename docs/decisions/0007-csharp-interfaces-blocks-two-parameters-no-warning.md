# 0007 — The C# side composes interfaces, writes every body as a block, takes two parameters and an options record, and builds without a warning

- **Status**: accepted
- **Scope**: the C# side, `implementations/dotnet`; its layout and its modules are its
  [README](../../implementations/dotnet/README.md)'s

## Context

Both sides share one surface, almost name for name
([0004](0004-one-behaviour-in-every-language.md)), and one house style, which says things C# cannot
say the way JavaScript does: functions bound to constants rather than classes, a block for every
body, two parameters and an options object, frozen tables rather than enums. .NET has conventions of
its own, and analyzers that hold them. Taking .NET's defaults alone, with expression bodies, base
classes and positional optional parameters, makes the two sides read as two designs; carrying
JavaScript's idioms over word for word fights the platform at every line.

The two runtimes also run code differently. JavaScript runs one turn at a time, so what a router
does in one turn happens with nothing between; .NET runs tasks on a pool of threads. Locks around
the router's state are safe, but let the order of what runs differ from JavaScript's; an actor per
connection is another shape again.

## Decision

**Interfaces and composition.** There is no base class of Bead's own: a type implements interfaces
and holds what it composes. Every class and record of `src/` and `interop/` is sealed or static. A
type inherits only where .NET leaves no other way: an exception from `Exception`, the router's
`SerialScheduler` from `TaskScheduler`, and in a test, a stand-in from the platform type it
replaces. Factories are static methods, and what they give is a record or a sealed class.

**Every body is a block**: a method's, a constructor's, an operator's, a local function's, a
property's, an accessor's, an indexer's and a lambda's, never an expression body, as
`arrow-body-style` asks of the TypeScript side; and a block for every branch, as `curly` asks. One
file-scoped namespace a file, `using` directives outside it with `System` first and none unused;
private fields in `_camelCase`, constants and static readonly fields in PascalCase. `.editorconfig`
states them, its rules at `warning`, and the build holds them (`EnforceCodeStyleInBuild`).

**At most two parameters, then the options.** A function takes at most two parameters, and after
them at most one options record, always last:
`FindIn(haystack, needle, new FindOptions { FromIndex = 10 })`, as the TypeScript side writes
`findIn(haystack, needle, { fromIndex: 10 })`. The count is Deno's, and Bead holds it for every
function, not only the public ones. The options record is a sealed record of `init` properties, its
name ending in `Options`; it is optional, `TOptions? options = null`, when every member is, and
required when one is, as a connect's `Host` and `Port` are. An optional parameter goes in the
options; one alone may stay positional where no second could come, as
`Fail(failure, string detail = "")`. A third essential thing is a design to revisit — a record of
the call, or a type that holds two of the things — and never a third positional parameter. A
`CancellationToken` goes in the options record whenever the function takes one, as
`RequestOptions.CancellationToken` does and the TypeScript side's `signal` is; it is positional only
as one of the two essentials, as in `SessionOf(request, signal)`. An event carries at most two
values, and a listener takes what its event carries. A record of more than two members is a record
of `init` properties, built by name as an object is on the TypeScript side. A parameter that is a
union on the TypeScript side, as a debug filter given as it is, as its spec, or by a function that
gives either, is an overload for each. A signature .NET imposes, an override's or a platform
interface's, takes what it takes.

**Every warning is an error, and the analyzers run at `latest-recommended`.**
`Directory.Build.props` holds every project to `net10.0`, the latest language version, nullable
references, implicit usings, `AnalysisLevel` at `latest-recommended`, the code style enforced in the
build, a documentation file, and `TreatWarningsAsErrors`. **Every public member has its doc
comment**: the build fails on one that has none (CS1591). A test project is exempt, and so are
underscores in a test's name (CA1707): a test says what it shows by its name. An analyzer is
overruled only on the type it would wrongly refuse, with its reason where it stands: CA1711, on
`EnvelopeFlags` ([0003](0003-one-word-one-meaning.md)).

**One solution, `Bead.slnx`**, laid out as the C# side's
[README](../../implementations/dotnet/README.md) says: a transport that needs a framework has a
project of its own, and each transport server is a Kestrel application of its own, one port for both
coming from a proxy in front, never from a server they share.

**A router runs on one serial scheduler, as JavaScript runs on one thread.** What a router holds is
touched from its scheduler alone, one task at a time, and a task that awaits comes back to it, so
what a router does in one turn of JavaScript happens in C# without another task between: no lock,
and the same order. Its public methods post to it from any thread. Resolvers run on the thread pool,
and a call's signal is cancelled there too, so code of the application's never runs on the
scheduler; only a test runs them on the router's own scheduler, to know when everything settled. A
notification's callbacks run on a serial scheduler of their own, in the order the notifications
came, as they run in JavaScript's turn; a test holds it. A resolver that blocks its thread stalls no
other call. A router that lets go of what waits on a connection cancels its calls' signals before it
rejects what it asked, so the order is the one a synchronous abort gives in JavaScript: a resolver
waiting on a call of its own, a relay's leg B, hears its caller gone before its call's end.

**The surface maps term for term.** A promise is a `Task`, an `AbortSignal` a `CancellationToken`,
`Symbol.asyncDispose` an `IAsyncDisposable`, a frozen table an `enum`, a `WeakMap` a
`ConditionalWeakTable`. A union is an interface its sealed records implement: `IEnvelopeHeader`, and
a record per kind. A value or the failure that refuses it, a transfer opened or refused, is a tuple
of the two, the one given and the other none; an outcome that may be a refusal says so among its own
values, as `ChunkOutcome.Refused` does. A send on a connection not open throws a
`DisconnectException`; an error's `cause` is its `InnerException`; a programmer's error is an
`ArgumentException`, or an `InvalidOperationException` where the state, not an argument, is wrong,
and a failure a `FailureException`. Data alike, which the TypeScript side compares by their
structure, is the data's own `Equals`, or the comparer `SessionManagerOptions.DataComparer` names. A
field that may be absent, `null` or a value, as a header's credential, is a nullable `Credential`, a
record of its `CredentialScheme` and what that scheme holds — an `OPAQUE` one's `SessionToken`, a
`JWT`'s token, a scheme to come's bytes — where the TypeScript side's is a union of its schemes;
both name the field `credential`, `Credential`, on a request and on an answer alike
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)). A name is one name on both sides, in
each language's case, but where .NET names otherwise: a `[Flags]` enum is plural, `EnvelopeFlags`,
and the HTTP client is `BeadHttpClient`, as .NET's own is `HttpClient`. A time in milliseconds is a
`TimeSpan`, and the clock a layer takes and exposes, the TypeScript side's `IClock`, is a
`TimeProvider`, named `Clock` ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)),
so a test moves it itself. A synchronous question of a router's state is a `Task`, since the state
is on the router's scheduler. A callable that carries members, a requester or a notification, is a
delegate or an interface: a request is made in three calls, as on the TypeScript side,
`GetRequest(procedure, dependencies)(payload)(options)`, and a notification registers with
`Register(payload, callback)(options)`.

**Where a platform's default would make the sides differ, the C# side sets the shared behaviour**:
no body limit of Kestrel's, so a body past the limit is the marked 413 and one past the budget the
marked 503; a refusal of HTTP/1 whose body it does not read says `connection: close`;
`x-forwarded-for` is read by one rule of its own
([0030](0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-alone.md)).

**The gate is two commands, from `implementations/dotnet`**:
`dotnet format Bead.slnx --verify-no-changes`, then `dotnet test --solution Bead.slnx`, which
builds, and fails a run where no test ran. CI's `dotnet` job runs both, then the interop
([0006](0006-a-rule-has-its-gate.md)).

## Consequences

- **The parameter rule has no gate in the build**: no analyzer of .NET's recommended set counts
  parameters, so review holds it, and a test over the built assemblies that holds the public surface
  is among [0006](0006-a-rule-has-its-gate.md)'s gates owed. Past the rule, each work to do: seven
  functions of `src/` take three — four private methods, a private class's constructor, an internal
  class's constructor (`Notification`'s), and `FailureException.OfProtocol`, whose third, its
  detail, is a positional optional; the transports' `Connect` and `Start` take their
  `CancellationToken` after their options; the session manager's four events of a change carry three
  values; and eighteen positional records take more than two members, `TransportServerClient` five.
- Nothing in the build forbids a base class either; review holds that too, and every class and
  record of `src/` and `interop/` is sealed or static.
- An event a router raises, an error or a trace, runs on its scheduler, as a listener runs in
  JavaScript's turn: one that blocks stalls its router, as it would in Node.
- A transfer's timer fires on the thread pool and posts its end to the scheduler the transfers are
  touched on, where progress may have set it going again: each timer carries a generation, and a
  stale one ends nothing.
- A test only one side has is a row of the support matrix, which says why: a resolver that blocks
  its thread, a close bounded in time.

**Each difference the platform makes is a platform row of the support matrix**, with its test, and
each difference still open an open row, closing which is work to do
([0004](0004-one-behaviour-in-every-language.md)).

## The Tenth Man

The parameter rule met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) when it took an options object
after two parameters. Its objections, each with the answer that holds:

### On the parameter rule

| Objection                                                                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The rule is stricter than Deno's and the user's, yet calls itself Deno's                                    | Accepted: it is Deno's first two rules, and what Bead adds is stated as Bead's: every function, the options last, a token inside them, an event of two values. Deno's third rule and its latitude for a function given as an argument are not taken. The options are optional when every member is, required when one is; a third essential thing is a design to revisit, which Deno answers with the options object. |
| "Nothing essential in the options" condemns the house's own pattern, and is applied in two places only      | Accepted: the clause goes. A service layer's client takes its Bead client as its second parameter and its options, every one optional, after it ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)), as Connect-ES's `createClient(service, transport)` takes its transport; the C# records with `required` members stay, each a required options parameter.            |
| A `CancellationToken` cannot follow the options under CA1068, and six public methods take it after them     | Accepted: the token goes in the options whenever a function takes them, as `RequestOptions.CancellationToken` does and the TypeScript side's `signal` is, and is positional only as one of two essentials. The six are work to do, a break of the C# side, not exceptions. CA2016 reads a token parameter and not a record's member, so forwarding one held in the options is review's.                               |
| The text contradicts itself on a positional optional                                                        | Accepted in part: the rule on a positional optional is written here and in the lint, held by review, and [0006](0006-a-rule-has-its-gate.md)'s list says so. Refused: that nothing tells a positional optional from a third parameter: the count does, and a third positional is refused whatever it is.                                                                                                              |
| The TypeScript side's plugin refuses option types the house writes                                          | Accepted: the plugin accepts them before it lands, each with a case.                                                                                                                                                                                                                                                                                                                                                  |
| The TypeScript side's plugin passes what the rule refuses, and loses what `max-params` caught               | Accepted, one point in part: the plugin judges written rest tuples, refuses options not last, a second options parameter and an incoherent literal, and visits the forms with an empty body. In part: a rest indexed into an event map is judged at the map, rather than every generic rest refused unless listed; a callback whose alias ends in `Options` stays review's.                                           |
| A reflection gate on the C# side is neither clean, flawless nor simple                                      | Accepted: the C# side stays on review, and its test is among [0006](0006-a-rule-has-its-gate.md)'s gates owed until one meets that bar.                                                                                                                                                                                                                                                                               |
| Exempting positional records lets the C# side make positional calls of three to five                        | Accepted in part: a record of more than two members is a record of `init` properties, and the eighteen are work as they are touched, `NotifyRequest` first. Refused: listing them as exceptions in a gate, since no C# gate lands; and value equality is no reason to keep a record positional, a record of `init` properties having it too.                                                                          |
| For events of three values, the gate judges the listener, not the event                                     | Accepted: an event carries at most two values, a listener takes what its event carries, and the plugin judges the event maps. Reshaping the five events of three values breaks both sides, and is a decision of its own.                                                                                                                                                                                              |
| `IRouterLike` would leave the service layer with two shapes, and a fix on the C# side alone aligns `notify` | Accepted: `notify` keeps its bag beside `request`'s; the C# side takes `NotifyRequest` of `init` properties and two overloads, and the TypeScript side is unchanged ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)).                                                                                                                                                |
| The gates before the service layer cost more than they give it                                              | Accepted, one point refused: the text lands first, the gates after, 0006's table edited once with them. Refused: that the order was already taken; it was put to the user, who took the text first.                                                                                                                                                                                                                   |
| "The rule does not reopen the notification's call" is half true                                             | Accepted: the old count, not the call's design, forced the notification's second call; it keeps its curried shape on its own reason, one shape for the request and the notification.                                                                                                                                                                                                                                  |
| "One or two parameters" leaves out a function of its options alone                                          | Accepted: at most two parameters, then at most one options object, everywhere.                                                                                                                                                                                                                                                                                                                                        |
