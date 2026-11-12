# 0048 — One contract gives several packages, and a server's transport takes the procedures it is given

- **Status**: accepted
- **Scope**: the protocol, every side's server transports and the builder: in
  [`spec/spec.md`](../../spec/spec.md), 9.2's step 5 and its details, 9.11, 9.12, 15.1 and 15.14;
  in [`spec/debugging.md`](../../spec/debugging.md), 7.6, 7.7 and 8.3; in
  [`spec/transcoding.md`](../../spec/transcoding.md), 3.1, 11.1 and 12.1; the conversations'
  `procedures` beside `open`, their schema and their generator, and the exit of `spec/metrics.json`
  that counts a request its connection's transport does not take; each side's server transports'
  `procedures`, a broker's `proceduresByName`, the predicate `takesProcedure` and, on the C# and
  Rust sides, `NamesProcedures` and `names_procedures`, the join's forwarding of them, and the
  router's step 5; `beadc.yaml`'s `server`, `client` and `gateway`, each a selection of procedures,
  and `server.transports`; the builder's picks, its rules `SELECTOR_UNMATCHED`, `SELECTION_EMPTY`
  and `GATEWAY_EMPTY`; the generated `SERVED_PROCEDURES` and `ServedProcedures`, and the counter of
  the contract with generated code, 8. The layer a generated class stands on and the counter are
  [0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s;
  the builder, its outputs and its targets
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s;
  the join and the in-memory transport
  [0036](0036-an-in-memory-transport-joins-two-routers-of-one-process-and-a-server-takes-several-transports-through-one.md)'s;
  the gateway, its routes, its document and its HTTP client
  [0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)'s;
  the series a procedure takes [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)'s; a
  broker's names [0040](0040-a-brokers-adapter-offers-bytes-at-topics-and-bead-keeps-its-own-credit-credential-and-heartbeat.md)'s;
  what a procedure admits, the admission's
  [0010](0010-a-request-presents-a-credential-of-a-scheme.md) and
  [0034](0034-a-server-tells-each-access-it-refuses-never-the-credential.md). The Rust side's
  generated addresses are ahead, with the matrix's row `Rust's beadc target`: a Rust application
  writes its addresses by hand.

## Context

**One `.proto` is one contract, and an application ships more than one package of it.** A worker
serves a service's orders, calls its readers over the gateway and hears its notifications; a page
calls one procedure alone; a server keeps its administration on one listener and its orders on
another. An output that writes a service's server class, its client class, its route table, its
document and its HTTP client whole ships what its package never calls, and a transport that reaches
every procedure its router answers shows the administration on the listener of the orders.

**What each side holds to build on.** Each router answers step 5 from its registry, asking the
transport's list too where it names one: the TypeScript side by `resolvers.hasService(serviceId)`,
or `hasServiceTaken` where its transport names procedures, in `router-core.ts`; the C# side by
`IsServiceKnown` in `RouterCore.cs`, over `_services` and `TakesProcedure`; the Rust side by
`is_service_known` in `router/core.rs`, over `resolvers` and `takes_procedure`; each with the
details `no service <id>` and `no procedure <id> in service <id>`, and each looks a request's series
up before step 3. A transport is asked per connection whether it carries both ways, whether it
carries a credential and whether it is secure: an optional member on the TypeScript side
(`isTwoWay?`, `carriesCredential?`, `isSecure?`), a default member on the C# and Rust sides. The
join forwards those to the transport that drew a handle, and refuses two transports of one type. A
broker's server transport knows the name each OPEN reached. Two C# outputs of one `.proto` cannot
share a process: `namespace` is refused for a `.proto` source (`builder/src/config.ts`), so both
write one namespace (CS0101, CS0433).

**The standards.**

- **RFC 9110 [§15.5.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.4) and
  [§15.5.5](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.5)**: an origin server that hides a
  forbidden resource MAY answer 404, "not willing to disclose that one exists". Hence step 5's
  codes, never `ACCESS_DENIED`.
- **gRPC's status codes**: `UNIMPLEMENTED` (12), "not implemented or not supported/enabled in this
  service", the analogue of 18 and 19; `PERMISSION_DENIED` (7) is the caller's, which a
  transport's list is not.
- **Envoy's RBAC filter** (`extensions.filters.http.rbac.v3.RBAC`, `rules`): "If absent, no RBAC
  enforcement occurs. If set but empty, all requests are denied." Absent and empty held apart; a
  policy per listener, as ASP.NET Core's `RequireHost("*:5001")` restricts an endpoint per port.
- **Transcoding 3.2 and spec 16.6**: the default route is the service's name, `/`, the procedure's
  name, as the definitions write them, and 16.6 folds case: the selector's form, not gRPC's `:path`
  nor buf's `types`, which are fully qualified.
- **buf.gen.yaml v2**, `inputs[].types` and `exclude_types`: a cut of one contract in the
  generation's configuration, not a second contract.
- **`descriptor.proto`'s `MethodOptions.IdempotencyLevel`**: `NO_SIDE_EFFECTS`, `IDEMPOTENT`,
  `IDEMPOTENCY_UNKNOWN`, which a selection names.
- **OpenTelemetry's `rpc.method`**: `_OTHER` for a method the server does not recognize; a
  procedure its transport does not take is one its side declared, so it keeps its series.
- **YAML 1.2.2 §3.2.1.1**: a mapping's keys are unique, so `server.transports` is a mapping, as
  Compose's `services`.
- **gRPC-Go's `SupportPackageIsVersion`**, which 0018 follows: a file names the support it needs.

## Decision

**A server's transport takes the procedures it is given** (spec 9.11). Every server transport takes
`procedures`, a list of addresses, a service id and a procedure id each: absent, it takes every
procedure; empty, none. A broker's server transport also takes `proceduresByName`, a name it serves
to its list, in place of `procedures` for a connection its OPEN reached by that name. Both are
checked as the transport is built (9.12): an id outside 16.2's ranges, service 0, and a name the
broker's transport does not serve are refused; an address named twice is one.

**Its router answers any other at step 5, as one to no resolver.** Past step 4, for a request that
names no destination on a connection whose transport names procedures, a resolver whose address the
transport does not take is none, and its service is known there only when some resolver of it is
registered whose address the transport takes: `SERVICE_UNKNOWN` otherwise, `PROCEDURE_UNKNOWN` for
a procedure of a service known there. The details are step 5's, `no service 9` and `no procedure 99
in service 1`, which the spec states and the conversations compare, so nothing of the answer
tells a procedure left out from one absent, nor a service whose every procedure is left out from one
absent. The request takes its place among the calls its connection answers (step 3), and nothing of
it is read past its header: its credential, its admission, its transfer's credit, its payload and
its subscription are never reached. A request that names a destination is its relay's, whatever its
connection's transport takes. What a transport takes grants no access, withdraws no session, and
each procedure it takes keeps its own admission.

**It is asked only when named.** The predicate `takesProcedure(connectionHandle, address)` is the
transport's that holds a list. On the TypeScript side it is an optional member, defined only on a
transport given a list, or a join with such a member, and the router's port carries it only then,
as it models `isTwoWay?`. On the C# and Rust sides a default member, `NamesProcedures` and
`names_procedures`, answers `false`, `true` on a transport given a list and a join's the OR of its
members', asked once as the router is built, which then asks `TakesProcedure` per request or never.
The join forwards `takesProcedure` to the transport that drew the handle, `false` for a handle it
does not hold (15.14).

**It counts under its procedure.** A call its connection's transport does not take is its
procedure's where its router declares it, as a call past step 3 is, and ends `failure` with the
code it was answered (debugging 8.3): its series tells it from an absent procedure's, which no peer
can. A procedure's server series therefore take `SERVICE_UNKNOWN` and `PROCEDURE_UNKNOWN` among
their codes, 15 of them, 64 series a procedure (7.6, 7.7).

**One `.proto` gives several packages.** An output of `beadc.yaml` holds three keys, each holding a
selection of procedures:

```yaml
outputs:
  - language: typescript
    out: gen/server
    server:
      transports:
        webSocket: {}
        admin: { procedures: { include: [Shop/*] } }
        orders: { procedures: { include: [Shop/placeOrder, Shop/cancelOrder] } }
    gateway:
      procedures: { kind: [request], idempotencyLevel: [NO_SIDE_EFFECTS] }
  - language: csharp
    out: gen/only-sign-up
    client:
      procedures: { include: [Auth/signUp] }
```

- **`server`**, of `procedures` and `transports`: the server class, its resolvers, its commands'
  requesters and its notifiers, holds what `procedures` selects, every procedure where it is absent.
  `server.transports` maps each key, a lower-camel identifier, to the procedures one transport, or
  one name of a broker's, takes, cut from the `request` and `notifies` procedures the server holds;
  a key names no transport type, which binds nothing in generated code.
- **`client`**, of `procedures`: the client class, its requesters, its notifications and the
  resolvers of the commands it answers, holds what it selects.
- **`gateway`**, of `procedures` and, on a TypeScript output, `runtime`: the route table, the
  document and the `<Name>HttpClient` of the `request` and `notifies` procedures it selects,
  `gateway: {}` every one, and `runtime` the route table's runtime. An output's `http` and
  `httpRuntime` are refused, naming `gateway: {}` and `gateway.runtime`.
- An output that names neither `server` nor `client` writes both whole; one that names one writes
  that one alone, so an output that keeps both and gives its server transports writes `client: {}`
  beside `server`. `gateway` is independent of both.
- **A selection** holds `include` and `exclude`, of `Service/procedure` or `Service/*`, `kind` and
  `idempotencyLevel`; a procedure is selected when `include` names it or is absent, its kind and
  its level are listed or their key is absent, and no `exclude` names it. A list of selections holds
  what any selects; `[]` holds none.

`<Svc>Procedures` holds the union of what the three select, and a service none selects is not
written. Each class is printed over its own pick of it (0018). Where `server.transports` is given,
the output writes `bead_served.ts`, `SERVED_PROCEDURES`, and `BeadServed.cs`, `ServedProcedures`,
one member per key in the order written, the key in Pascal case on the C# side: the lists the
application hands each transport as its `procedures`. That file alone names the contract 8,
`GENERATED_CODE_SUPPORTS_VERSION_8` and `GeneratedCode.SupportsVersion8`, so a runtime that lacks
the option fails on the counter, not on a signature or, in TypeScript, not at all.

**Its rules.** As `beadc.yaml` is read, each key of the three a mapping of its own keys, a
selection's keys, kinds and levels, a selector's form and `gateway.runtime` on a C# output are held,
each refusal naming its key. Against the blueprint, three rules of `generate`, each an error:
`SELECTOR_UNMATCHED`, an `include` or `exclude` that names no service or procedure, or one its
entry cannot hold, naming the Bead form where one is near (`hello.v1.HelloService/SayHello`:
`Hello/sayHello`?); `SELECTION_EMPTY`, a `procedures` of selections that select none; and
`GATEWAY_EMPTY`, a `gateway` that selects no `request` and no `notifies`.

Nothing new goes on the wire.

## Consequences

- **Two transports of one type are two routers.** The join refuses two transports of one type
  (0036), so a server whose two WebSocket listeners take different procedures runs two servers,
  each with its router and its sessions.
- **A resolver of a procedure the server class does not serve** is a type error on the TypeScript
  side and an `ArgumentException` as `On` is called on the C# side, the descriptors of one service
  sharing one type tag: a platform row of `docs/support.md`.
- **The series a procedure takes grow by two**, `failure` under `SERVICE_UNKNOWN` and
  `PROCEDURE_UNKNOWN`: 64 in the server families, 6,400 for 100 procedures (0013).
- **No Rust target writes the addresses**: a Rust application writes them by hand, and Rust's
  beadc target is ahead.
- **`http: true` and `httpRuntime` are refused**, naming `gateway: {}` and `gateway.runtime`: a
  break a minor makes while the major is 0
  ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)), and a `beadc.yaml` that
  names either generates nothing until its author writes `gateway` in its place.

**Its gates**: the eleven conversations of 9.11 and the exit that counts one, played by every side;
the twins of 9.12 and of the predicate, named on every side; the builder's tests of the keys, the
picks and the three rules; `generate --check` over every output.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) at
xhigh effort: ten objections, each checked against its probe or the code before it was answered.
Nine were accepted, one in part, and none refused.

| Objection                                                                                                                                                                                                                                                                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1. `SELECTION_SPLIT` refuses the draft's own worker and the package planner's (a page outside the repository that drafts an output's `beadc.yaml` from a blueprint), and its fix, an output each, does not compile in one C# process; each class can be printed over its own pick of one constant | **Accepted.** Verified: `config.ts` refuses `namespace` for a `.proto` source, so two C# outputs write `namespace Hello.V1;` twice (CS0101, CS0433); a probe of it type-checks. `<Svc>Procedures` holds the union; the server class and its types are printed over the served pick, the client class and its types over the called pick; TypeScript's picks unexported frozen objects, C#'s internal `Served` and `Called` lists. The gateway's split rule goes too: one `gateway` selection, one table. On the C# side a resolver of a procedure the server does not serve is refused at run time (`ServiceServer.cs:463`), a platform row of `docs/support.md` |
| T2. A door is a listener, not a transport type: the draft refuses two entries of one type, then recommends them; the join's one-per-type costs two routers; the transport type is deployment by the draft's own test                                                                               | **In part.** Accepted: two doors of one type are allowed, the read-time one-per-type and `gateway`/`memory` checks go, and this record's consequences and the matrix's row say two transports of one type are two routers. Changed: a door is a key of the mapping `server.transports`, not a `name` member, since a broker's `names` are its topics (0040, 0041) and `name` beside `transport: mqtt` would read as one (0003); and the door holds no `transport`, which binds nothing. The per-name set of a broker transport is `proceduresByName`, with no handle change: the transport knows the name each OPEN reached (`broker-transport-server.ts`)       |
| T3. `gateway` is no transport, the draft spells the gateway three ways, and question 7 is 0003's, not taste                                                                                                                                                                                        | **Accepted.** `gateway` is an output's own key, in place of `http: true`, and `gateway.runtime` in place of `httpRuntime`; `http` and `httpRuntime` refused naming their successor; every `beadc.yaml`, `tools/check-transcoding.mjs`, the goldens and transcoding 12.1 move in one commit; the CHANGELOG says so under Removed. `GATEWAY_EMPTY` stays, on the new key                                                                                                                                                                                                                                                                                           |
| T4. `serves` and `calls` misname what they select when a procedure is a command, and one entry does two jobs, so a door's filter removes the server's commands                                                                                                                                     | **Accepted.** Verified: `HelloServer.Command` holds the command's requester, `HelloClient.On` its resolver (`HelloBead.cs`). The keys are `server` and `client`, each its own selection; the server's transports are a mapping inside it, each cut from what the server holds, its requests and notifications alone (16.11); an `include` naming a procedure the server does not hold is `SELECTOR_UNMATCHED`                                                                                                                                                                                                                                                    |
| T5. An unregistered procedure of a registered service, on a transport that takes none of that service, leaks the service, and no conversation plays it                                                                                                                                             | **Accepted.** Verified on the three sides, at step 5 (`router-core.ts`, `RouterCore.cs`, `router/core.rs`). 9.11 states it: a service is known on a connection when a resolver of it is registered whose address its transport takes; each side scans its registry's procedures of that service on that path alone. The `stranger` conversation sends procedure 99 of service 1, answered `SERVICE_UNKNOWN`, `no service 1`. The optional metrics step is not added: the exit already plays `_OTHER` under a list                                                                                                                                                |
| T6. 9.12 refuses an empty list, against Envoy's RBAC, which the draft cites, and a door taking none is unsayable                                                                                                                                                                                   | **Accepted.** Envoy's text verified: "If absent, no RBAC enforcement occurs. If set but empty, all requests are denied." Absent takes every procedure, empty none; 9.12 refuses only an id out of range, service 0, and a broker's name it does not serve. Since an empty list is seen by a peer, it is one of the eleven conversations of 9.11, T5's step among them, and a twin; the schema's `procedures` takes `[]`. `SELECTION_EMPTY` stays for a selection that selects none; `procedures: []` written is no slip                                                                                                                                          |
| T7. The counter has to move: failing where the application hands the list over is the failure on a signature 0018 chose the counter to avoid, and TypeScript may fail open                                                                                                                         | **Accepted.** Verified: 0018, "fails on the counter (TS2724, CS0117), not on a signature"; `ITransportServerOptions` held `clock` alone and no factory refused an extra member. `bead_served.ts` names `GENERATED_CODE_SUPPORTS_VERSION_8` of `./service`, `BeadServed.cs` `GeneratedCode.SupportsVersion8`; every other file keeps 7; `tools/names.tsv` holds the constant's row. The alternative, transports refusing unknown members, is refused: structural typing ignores extras, and the counter answers                                                                                                                                                   |
| T8. The selector's form is grounded on standards it departs from, and a selector copied from the `.proto` finds nothing                                                                                                                                                                            | **Accepted.** The form is grounded on transcoding 3.2's default route and 16.6. `SELECTOR_UNMATCHED` recognises a service's `proto.fullName`, which the blueprint holds where a front end read it (`model/blueprint.ts:121`), and folds the procedure by 16.6 (`SayHello`, `sayHello`), the blueprint keeping no rpc name of its own; the README says the form is not buf's `types`                                                                                                                                                                                                                                                                              |
| T9. A server whose transports name no procedures still pays for the ask on every request, a regular expression per request through a TypeScript join                                                                                                                                               | **Accepted.** TypeScript: `takesProcedure` is absent on a transport given no list, a join defines it only when a member does, and the router's port carries it only then. C# and Rust: a default member `NamesProcedures`/`names_procedures`, `false`, a join's the OR of its members', asked once as the router is built. Twin: "a router whose transport names no procedures never asks". The benches read it once in CI                                                                                                                                                                                                                                       |
| T10. The package planner's derived folder `gen/<language>-<n>` over-applies the user's rule: `out` is no selector, and numbers renumber                                                                                                                                                            | **Accepted.** The planner derives the folder from the package's content, de-duplicated, and each transport's key likewise. The user's rule holds as the planner keeps it: the folder and each transport's key are derived from the package's content and shown, never typed into the planner, and renamed in `beadc.yaml`                                                                                                                                                                                                                                                                                                                                        |

Refused besides, each weighed: a door keyed by `name`, or by its transport's type, or by the
participant's id, which is the admission's; a broker's names in `beadc.yaml`, which are deployment;
two broker transports over one participant for two sets; `ACCESS_DENIED`, a new code or a debug
event, where the answer hides and the series tells; a list that refuses empty; the counter unmoved;
one `NamesProcedures` member on the TypeScript side too, whose port models "not asked" as an absent
member already; an interop case, since a peer reads codes 18 and 19 both ways already; a package
name per output, publication being undecided; and a C# compile-time refusal of a resolver its server
does not serve, which would need a type tag per side.
