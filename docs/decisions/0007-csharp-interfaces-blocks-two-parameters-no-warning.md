# 0007 — The C# side composes interfaces, writes every body as a block, takes two parameters, and builds without a warning

- **Status**: accepted
- **Scope**: the C# side, `implementations/dotnet`

## Context

The C# side mirrors the TypeScript side's surface almost name for name
([0004](0004-one-behaviour-in-every-language.md)), and the TypeScript side's style says things C#
cannot say the same way: functions bound to constants rather than classes, a block for every body,
two parameters and an options object, frozen tables rather than enums. .NET has conventions of its
own, and analyzers that hold them. Taking .NET's defaults alone, with expression bodies, base
classes and positional optional parameters, makes the two sides read as two designs; carrying the
TypeScript idioms over word for word fights the platform at every line.

The two runtimes also run code differently. JavaScript runs one turn at a time, so what a router
does in one turn happens with nothing between; .NET runs tasks on a pool of threads. Locks around the
router's state are safe, but let the order of what runs differ from the TypeScript side's; an actor
per connection is another shape again.

## Decision

**Interfaces and composition.** There is no base class of Bead's own: a type implements interfaces
and holds what it composes. Every class and record of `src/` and `interop/` is sealed or static. A
type inherits only where .NET leaves no other way: an exception from `Exception`, the router's
`SerialScheduler` from `TaskScheduler`, and in a test, a stand-in from the platform type it replaces.
Factories are static methods, and what they give is a record or a sealed class.

**Every body is a block**: a method's, a constructor's, an operator's, a local function's, a
property's, an accessor's, an indexer's and a lambda's, never an expression body, as
`arrow-body-style` asks of the TypeScript side; and a block for every branch, as `curly` asks. One
file-scoped namespace a file, `using` directives outside it with `System` first and none unused;
private fields in `_camelCase`, constants and static readonly fields in PascalCase. `.editorconfig`
states them, its rules at `warning`, and the build holds them (`EnforceCodeStyleInBuild`).

**At most two parameters**, an options record being one of them, as the TypeScript side's
`max-params` asks: a third thing to say goes in the record, where the call site names it. A
parameter that is a union on the TypeScript side, as a debug filter given as it is, as its spec, or
by a function that gives either, is an overload for each. A signature .NET imposes, an override's,
takes what it takes, and a positional record is data, as an object is on the TypeScript side.

**Every warning is an error, and the analyzers run at `latest-recommended`.** `Directory.Build.props`
holds every project to `net10.0`, the latest language version, nullable references, implicit usings,
`AnalysisLevel` at `latest-recommended`, the code style enforced in the build, a documentation file,
and `TreatWarningsAsErrors`. **Every public member has its doc comment**: the build fails on one
that has none (CS1591). A test project is exempt, and so are underscores in a test's name (CA1707):
a test says what it shows by its name. An analyzer is overruled only on the type it would wrongly
refuse, with its reason where it stands: CA1711, on `EnvelopeFlags`
([0003](0003-one-word-one-meaning.md)).

**One solution, `Bead.slnx`.** Its projects are `src/Bead.*`, their tests `tests/Bead.*.Tests`, and
the interop service and its server are under `interop/`. `Bead.Core` holds what the TypeScript
package holds: the codec, the router's core, both sides' routers, the service, session and
notification managers, the relay, and the server over them. A transport that needs a framework has a
project of its own: `Bead.Transport.WebSockets`, the server on Kestrel and the client on
`ClientWebSocket`, one connection class for both; `Bead.Transport.Http`, the server on Kestrel and the
client on `HttpClient`. Each transport server is a Kestrel application of its own: one port for both
comes from a proxy in front, never from a server they share.

**A router runs on one serial scheduler, as JavaScript runs on one thread.** What a router holds is
touched from its scheduler alone, one task at a time, and a task that awaits comes back to it, so
what the TypeScript router does in one turn happens in C# without another task between: no lock,
and the same order. Its public methods post to it from any thread. Resolvers run on the thread pool,
and a call's signal is cancelled there too, so code of the application's never runs on the
scheduler; only a test runs them on the router's own scheduler, to know when everything settled. A
notification's callbacks run on a serial scheduler of their own, in the order the notifications
came, as they run in JavaScript's turn; a test holds it. A resolver that blocks its thread stalls no
other call. A router that lets go of what waits on a connection cancels its calls' signals before
it rejects what it asked, as the TypeScript side's synchronous abort is heard first: a resolver
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
([0010](0010-a-request-presents-a-credential-of-a-scheme.md)). Names stay the TypeScript side's, in
PascalCase, but where .NET names otherwise: a `[Flags]` enum is plural, `EnvelopeFlags`, and the
HTTP client is `BeadHttpClient`, as .NET's own is `HttpClient`. A time in milliseconds is a
`TimeSpan`, and the clock a layer takes and exposes, the TypeScript side's `IClock`, is a
`TimeProvider`, named `Clock` ([0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)),
so a test moves it itself. A synchronous question of a router's state is a `Task`, since the state
is on the router's scheduler. A callable that carries members, a requester or a notification, is a
delegate or an interface: a request is made in three calls, as on the TypeScript side,
`GetRequest(procedure, dependencies)(payload)(options)`, and a notification registers with
`Register(payload, callback)(options)`.

**Each module is the TypeScript side's.** Transfers are `Transfer`, `ReceivingTransfers` and
`SendingTransfers`, wired in the core; the relay is `Relay`, its registrations under a lock, since
they are registered from any thread and read on the router's scheduler, and a destination is a
`ConnectionTarget` or an `IRouterTarget`, which a client's router meets. HTTP's transport keeps the
TypeScript side's counts where Kestrel's would stand: no body limit of Kestrel's, so a body past the
limit is the marked 413 and one past the budget the marked 503; a refusal of HTTP/1 whose body it
does not read says `connection: close`; `x-forwarded-for` is read by one rule of its own. The
transports hold the TypeScript side's ready states, and the client reconnects as it does, its delay,
attempts, token and tap, its router rejecting what waited on the connection replaced.

**The gate is two commands, from `implementations/dotnet`**: `dotnet format Bead.slnx
--verify-no-changes`, then `dotnet test --solution Bead.slnx`, which builds, and fails a run where no
test ran. CI's `dotnet` job runs both, then the interop
([0006](0006-a-rule-has-its-gate.md)).

## Consequences

- **The two-parameter rule has no gate in the build**: no analyzer of .NET's recommended set counts
  parameters, so review holds it ([0006](0006-a-rule-has-its-gate.md)). Seven functions of `src/`
  take three today: four private methods, a private class's constructor, an internal class's
  constructor (`Notification`'s), and `FailureException.OfProtocol`, whose third, its detail, is
  optional. Each is work to do.
- Nothing in the build forbids a base class either; review holds that too, and every class and
  record of `src/` and `interop/` is sealed or static.
- An event a router raises, an error or a trace, runs on its scheduler, as a listener runs in
  JavaScript's turn: one that blocks stalls its router, as it would in Node.
- A transfer's timer fires on the thread pool and posts its end to the scheduler the transfers are
  touched on, where progress may have set it going again: each timer carries a generation, and a
  stale one ends nothing.
- A test only one side has says why: a resolver that blocks its thread, or a close bounded in time,
  has no TypeScript counterpart.

**What the platform makes differ**, each a row of the support matrix
([0004](0004-one-behaviour-in-every-language.md)):

- The Web Worker transport is the browser's, and has no C# counterpart.
- Kestrel, as it stops, waits its close timeout on a peer that began an HTTP request and never
  finished it, where the TypeScript side waits on none; and the transport server raises no error of
  its own with no connection, since Kestrel only logs one.
- A trace hands on a payload as it is, where the TypeScript side hands a copy: a record does not
  change after its call.
- A notification's decoding runs with its callbacks, off its router's scheduler, so the client tells
  a notification as activity as it arrives, where the TypeScript side tells none for one whose
  trigger throws, one that does not decode.
- HTTP/2 is served over TLS alone, where Kestrel offers it beside HTTP/1.1 by ALPN; the TypeScript
  side's application may give an HTTP/2 server without TLS. Kestrel shows no HTTP/2 session, which
  the TypeScript side counts.
- A transport server's `Clients` lists a `TransportServerClient` each, in the order the connections
  came. A connection that takes a handle still held is listed at its own arrival, where a
  JavaScript `Map` keeps the older one's place.
- An instant a side reports — a transport server client's and a session's `LastActivity`, a trace's
  `StartedAt` — is a `DateTimeOffset` its clock's wall reading gives, and a trace's `Duration` a
  `TimeSpan` in whole milliseconds, where the TypeScript side's are milliseconds, since the epoch
  for an instant.
- A stop over HTTP lets the exchanges under way write their end, and Kestrel put it on the wire, a
  second at most, before it cuts what it holds: Node writes a 404 into its socket as the stop ends
  the exchange, where Kestrel's handler writes it a moment later, and a cut that comes first loses
  it, as a reset where the platform is Linux.
- A transport server's `Connection` event carries the connection's handle alone, where the
  TypeScript side's carries its socket and the request that opened it: Kestrel's `HttpContext` is
  pooled, and outlives no request.
- A request answered while its body still comes keeps its socket on the TypeScript side, where
  Node reads the rest, counted in `bodyBytes`; Kestrel stops reading with the application, and the
  socket closes, saying `connection: close`.
- The client's `Reconnect` event is an explicit `IRouterClientTransport.Reconnect`, since its method
  has the name; its ready state moves to `Reconnecting` before that event, under its lock, as
  another thread may ask meanwhile; and a connection dropped, by a quick close or a reconnection
  that replaces it, sends 1001 and waits for nothing, where a browser's sends no status, since .NET
  writes none as 1005, which a peer aborts on.

**Two differences are open**, rows of the matrix too, and closing each is work to do:

- A facade's limits over HTTP carry whole envelopes and no transfer, whatever transfers they give,
  where the TypeScript side refuses others: a record's default cannot tell given from not, and a C#
  limits type that tells a transfer asked for from the default closes it.
- Two of HTTP's bounds are the server's, not the transport's, and differ: a body that comes slowly
  is cut by Node's `requestTimeout` (300 s by default, set where the application builds its server),
  and by Kestrel's minimum data rate (240 bytes a second after 5 s) and its 30 s for the headers,
  each answering an unmarked 408. One bound both sides state, which the application sets alike,
  closes it.
