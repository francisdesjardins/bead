# 0017 — Ids are for life, a procedure's name takes one ASCII form, and every side refuses a declaration off them as it is made

- **Status**: accepted
- **Scope**: `spec/spec.md`, its section 16 and the sentence on what a side conforms to;
  `spec/debugging.md` 1.2, 6.10, 7.3 and 8.3; a new conformance file, `spec/identities.json`, its
  schema, its generator, `spec/check.py`, `spec/uncited.txt` and `spec/schemas/common.schema.json`;
  `spec/metrics.json`, its schema and its generator; every implementation's routers, service manager
  and metrics registry, and their tests; CI's `spec` job, the C# test project, the root README and
  the support matrix; decisions [0004](0004-one-behaviour-in-every-language.md),
  [0006](0006-a-rule-has-its-gate.md) and
  [0013](0013-every-language-debugs-alike-at-no-cost-when-off.md), changed in place; the builder's
  README, `beadc check` and `beadc breaking`

## Context

A request names its procedure by two ids, its service's and its own, each on 2 bytes (spec 3.1).
Nothing else of a procedure travels. Yet a procedure has a name on every side, and the name reaches
further than the ids:

- it labels the metrics, `procedure="whoami"`, its service's id beside it (debugging 8.3), and
  `spec/metrics.json` pins 15 of the interop's 18 names as label values;
- a debug filter keeps or leaves out a call by it, across every service, an ASCII letter matching in
  either case (debugging 6.4 and 6.5);
- the builder keys its generated API by it.

Two documents leave what a name may hold to this decision: debugging 6.10 and 0013, on whether a
name may start with an underscore and whether the registry's refusals relax.

**What each side refuses today, and where.** A declaration is a resolver registered, a requester
made, or a notification registered (debugging 7.2):

| Declaration                    | TypeScript                                                                                                                                      | C#                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A resolver registered          | an address part outside 1 to 65,535 or no integer; a payload limit below 1; a second resolver (`router/shared/router-core.ts`, `isAddressPart`) | a service or procedure id of 0, the `ushort` bounding the top; a payload limit below 1; a second resolver (`Bead.Core/RouterCore.cs`) |
| A requester made               | nothing: `declareRequester` hands the procedure to the registry, if any (`router/client/router-client.ts`, `router/server/router-server.ts`)    | nothing, likewise (`RouterClient.cs`, `RouterServer.cs`)                                                                              |
| A notification registered      | a second one (`router-client.ts`)                                                                                                               | a second one at its address, an `InvalidOperationException` (`RouterClient.cs`)                                                       |
| A notification asked for again | another name, revision, deprecation or limit, a `ProgrammerError` (`router/shared/service-manager.ts`)                                          | asked for otherwise, an `InvalidOperationException` (`ServiceManager.cs`)                                                             |
| Any, to a registry given one   | another name at its address; its name at another address, compared exactly; past the ceiling (`router/shared/metrics-registry.ts`)              | the same, compared `StringComparison.Ordinal` (`MetricsRegistry.cs`)                                                                  |

So a side checks no name's form and no revision anywhere: `IProcedure.serviceRevision` is a `number`
(`router/shared/types.ts`), `Procedure.ServiceRevision` an `int` (`Bead.Core/RouterTypes.cs`). An id
of 0 at a requester is refused only as the call writes its header (`router/shared/header.ts`).

**What reads a name and a revision.** A revision is read by the trace alone: the service manager
copies it into each debug event (`service-manager.ts`, `ServiceManager.cs`) and compares it when a
notification is asked for again (`service-manager.ts`); nothing else reads it. A name is read by the
trace, the filter and the registry, all three the companion's. So what a name and a revision must be
consistent for is debugging, and the one layer that holds names today is the registry, where 0013
put it.

**Where revision 0 comes from.** A relay's leg B calls the destination with a procedure it never
declared, at revision 0 (`router/server/relay.ts`, `Bead.Core/Relay.cs`), counted `_OTHER`
(debugging 8.3).

**Where names off any form are pinned already.** `spec/metrics.json` declares `_OTHER`, `a\b`, `say
"hi"`, `two\nlines` and `café` (`spec/generators/make_metrics.py`); `spec/debug-filters.json` names
`İd`, `a\u0085b`, the empty name and `café` (`spec/generators/make_debug_filters.py`). Both
harnesses declare through the registry's router-facing surface, never a router
(`router/server/__tests__/metrics.test.ts`, `MetricsTests.cs`).

**The traps a name's check meets.** The interop's schema holds `procedureName` to
`^[a-z][A-Za-z0-9]*$` (`spec/schemas/interop-service.schema.json`). Probed on 2026-10-05:

| Probe                                                 | Node 26.5.0                            | .NET 10.0.12                                     | Python 3.14.6, jsonschema 4.26.0             |
| ----------------------------------------------------- | -------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| `^[a-z][A-Za-z0-9]*$` against `"echo\n"`              | no match                               | match                                            | match: jsonschema's `pattern` is `re.search` |
| `[a-z]`, case-insensitive, against U+212A KELVIN SIGN | no match with `/i`, a match with `/iu` | a match, `IgnoreCase`                            | —                                            |
| `café` and `cafÉ`, compared without regard to case    | one, by `toLowerCase`                  | one, by `OrdinalIgnoreCase`                      | —                                            |
| `"a\uD800"` read from JSON                            | read, one lone surrogate               | `GetString()` throws `InvalidOperationException` | read                                         |

So a side that checks a name by its platform's regular expression takes one another refuses, and a
side that lowers a name before it compares reads `Kelvin` as `kelvin`.

**What a name must survive.** A metrics label value, beside its service's id (debugging 8.3); a
filter word, which reaches the procedures of that name in every service, where a comma and ASCII
white space part words, `-` leaves out, `*` stands for any run and a parenthesis is refused, and
where an ASCII letter matches in either case (debugging 6.1, 6.4); a TypeScript key and a C# member;
and the Common Language Specification, for a consumer that marks its assembly CLS-compliant, under
which two identifiers that differ only in case are one (ECMA-335, Partition I, §8.5.1, CLS rule 4).
No assembly here is so marked (`git grep -i CLSCompliant` finds nothing), so the CLS binds a
consumer's code, never Bead's. The builder generates one file for each `.proto` file, so a file
system that ignores case never meets two names.

### The options weighed

**Where the protocol's own services live.** The project's plan reserves service 0, the builder's
design gives it to the protocol and names "reflection in service 0" among what comes later. Spec 4.7 reads a service id of 0 and refuses it
by routing; 4.10 never writes one, and neither side's writer does (`header.ts`, with
`FIELD_MAXIMUMS`).

- **Service 0, the protocol's, its procedures defined by decision.** Chosen, the user's choice, as
  the plan and the builder's design have it. No application holds 0, since no writer writes it, so
  nothing is taken from anyone, and every id from 1 to 65,535 stays the application's. HTTP/2 does
  the same with its stream 0, "used for connection control messages" ([RFC 9113
  §5.1.1](https://www.rfc-editor.org/rfc/rfc9113#section-5.1.1)). It costs, on the day a protocol
  procedure is defined, 4.10's exception and each side's `writeHeader`, one line each; and it is one
  id, so the protocol's services share service 0 by its procedure ids, which spec 16 then allocates
  in a table, a row each, and one revision.
- A block at the top, 65,280 to 65,535, which the draft chose. TLS reads that block as Private Use
  ([RFC 8446 §11](https://www.rfc-editor.org/rfc/rfc8446#section-11), "Values with the first byte
  255 (decimal) are reserved for Private Use"), and DNS reads 65,280 to 65,534 so ([RFC 6895
  §3.1](https://www.rfc-editor.org/rfc/rfc6895#section-3.1)); spec 4.4 lays its credential block out
  as a TLS extension. A reader who knows them takes the block for the application's, and a
  declaration there is then refused at build, never in silence. CoAP's top range is the reverse of a
  protocol's own: "reserved for experiments … MUST NOT be used in operational deployments" ([RFC
  7252 §12.2](https://www.rfc-editor.org/rfc/rfc7252#section-12.2)). It moves no id now, and two
  twins that register at 65,535 move to 65,279 (`router-core.test.ts`, `RouterCoreTests.Calls.cs`).
- A block at the low end, 0 to 255, as CoAP keeps 0 to 255 for the IETF's own options and as IANA
  keeps ports 0 to 1023 as System Ports ([RFC 6335
  §6](https://www.rfc-editor.org/rfc/rfc6335#section-6)). It moves service 1 now: the interop's
  (`spec/interop-service.json`), with the bytes of 29 conversations and every `service="1"` label of
  `spec/metrics.json`, and the demo's (`implementations/typescript/demo/procedures.ts`); and every
  test that declares a service below 256, which `serviceId: 2` and `ServiceId = 2` alone reach in 26
  TypeScript test files and 12 C# ones.
  [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) lets the wire be revised in
  place until it is published.
- Left to the first protocol service's decision, as the builder's design leaves the range: a
  protocol service that needs an id past 0 takes one an application may hold by then.

**One rule from an rpc to a procedure's name** is the builder's: its first letter lowered, and only
that. It lives in the builder's README, beside the other names a manifest alone carries.

**A procedure's name's form.**

- protobuf's identifier, `[A-Za-z_][A-Za-z0-9_]*`: it admits `_OTHER`, the metrics' fallback, and
  underscores each target's casing treats its own way.
- An identifier of Unicode, UAX #31: the case mappings and normalizations above part the platforms,
  and the filter compares a name outside ASCII code point by code point (debugging 6.4).
- **ASCII letters and digits, a lower-case letter first, 1 to 63 characters.** Chosen. It is what
  the interop's schema holds already, what every name of the interop and the demo holds
  (`demo/procedures.ts`), and it holds nothing a label escapes, a filter reads as its own, or a
  language refuses in an identifier. The bound of 63 is a choice of its own, for short labels, keys
  and routes, and cites no standard: a bound set now costs nothing, one set later breaks a name.

**Uniqueness, and how names compare.**

- Exact, as the registry compares today: `getHTTPStatus` and `getHttpStatus` live side by side in
  one service, as two `procedure` labels beside one `service`, which every filter word of those
  letters keeps both of, and which a CLS-compliant consumer's members cannot carry apart.
- By each platform's comparison: `café` and `cafÉ` one on both, U+212A and `k` one on some readings.
- **Without regard to case, in ASCII alone, character by character.** Chosen: how debugging 6.4
  reads a pattern, and what no platform's comparison does by itself.

**Where a declaration is checked.**

- Nothing at a side: `beadc check` alone. A hand-written side is held by nothing, and section 16 is
  a preference ([0006](0006-a-rule-has-its-gate.md)).
- A table in each router, which the draft chose: a range, a form, one name an address, one revision
  a service, at each declaration whatever the registry. It repeats the registry's two reasons in a
  second layer; it costs a lock of its own on the C# side, since `DeclareRequester` runs on the
  caller's thread (`RouterClient.cs`), a table held for the router's life, and the tests that
  declare one name at two addresses on one router or core, such as `router-core.test.ts` and
  `router-server.test.ts`; one service at two revisions on one router is declared by no test found
  (each test file holds one revision, 3 or 1; revision 4 is the service manager's "asked for
  otherwise", `service-manager.test.ts`, `ServiceManagerTests.cs`); and `router-server.test.ts`,
  which pins the registry's sentence, would meet the router's first.
- **What needs no memory at every declaration, what needs memory where 0013 put it.** Chosen, the
  user's choice. Each router checks the ids' ranges, the revision's and the name's form, a pure
  function over the procedure: no lock, no table, nothing held. The registry keeps its refusals,
  compares names as section 16 compares them, and gains one: a service at another revision. One name
  an address and one revision a service then hold on a side that counts, and in a manifest through
  `beadc check`; on a side that counts nothing, two names at one address show only in its trace, the
  one reader left, which is debugging's.

**Ids for life.**

- Ids reused once a procedure is gone a while: a peer built against an earlier release calls the new
  procedure with the old payload, answered `PAYLOAD_UNDECODABLE` at best, run with the wrong meaning
  at worst.
- **For life, within a service, a retired id reserved, as protobuf reserves a field's number.**
  Chosen. Names alike, so a label and a filter never come to count or keep another procedure of that
  service. Only a sequence of releases shows it, so one tool holds it: `beadc breaking`, against the
  last release, its findings waived by rule name. Nothing holds it across manifests, nor for a side
  written by hand: section 16 writes it as a SHOULD, naming its holder
  ([0006](0006-a-rule-has-its-gate.md)).

**Revisions.**

- Derived from the contract, a hash: a revision is read in traces, and a hash says nothing to a
  reader.
- Advisory, never checked: it stops meaning anything by the second release.
- **A count of the releases of a service's contract, from 1; 0 meaning unknown, which a relay's leg
  B holds and nothing declares; one per service on a side that counts.** Chosen. How it moves is
  `beadc breaking`'s `SERVICE_REVISION`, a SHOULD in section 16; its range is a MUST every side
  holds.

**What section 16 holds.** The builder's design puts the identity rules in section 16, binding every
side, and the checks and the breaking rules in the builder's README.

- Everything a manifest holds besides: services' and failures' names, a package's scope,
  reservations, hooks, the release rules and the derivation from a `.proto`. The spec defines none
  of these and no conformance file cites them; a builder-only change would move the spec's minor,
  which moves "when an implementation must change to keep passing"
  ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).
- **What binds a side.** Chosen, the user's choice: the ids' ranges and service 0; a procedure's
  name, its form, its reading and its fold; one name an address and one revision a service, held
  where a side counts; ids for life and the revision's meaning, as SHOULDs naming `beadc breaking`;
  the refusal and its order. The rest goes to the builder's README and the manifest schema's
  descriptions, gated by beadc's tests.

**A service's name's scope** is the builder's, and its consumers choose it: the generated classes,
whose namespace is a file's `csharp_namespace`, which two packages may share, where two
`CatalogServer` classes fail with CS0101; and the HTTP façade, whose routes are `POST
/api/<service>/<procedure>`.

- Unique within a package: serves neither, since `acme.catalog.v1.Catalog` and
  `acme.catalog.v2.Catalog` both route to `/api/Catalog/…` and may share a namespace.
- Full names in the façade's routes, as gRPC and Connect route `/acme.catalog.v1.Catalog/Method`,
  and class names unique within each generated namespace, held by `NAME_TARGET`.
- **Unique within a manifest, folded.** Chosen, the user's choice, as the builder's design makes one
  manifest one id space: two versions served side by side take two names, `CatalogV1` and
  `CatalogV2`.

**Where the rules are pinned.**

- Twin tests: the probes above are what they miss.
- Rows of `spec/vectors.json`: vectors hold envelopes, and a name is in none.
- **A file of its own on the spec's axis, `spec/identities.json`**, as
  [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md) gave durations theirs, for
  what a router refuses with no memory: names, ids and revisions, each played by the five ways a
  side declares, and folds, played by the helper every comparison goes through. What the registry
  refuses stays `spec/metrics.json`'s, the companion's file. Chosen.

**What becomes of the companion's own cases.** The registry and the filter read names no router
passes on now: `_OTHER`, `say "hi"`, `café`.

- Take them out, with 12.4's escaping: code nothing reaches, but a registry is given names by its
  `attach` and `Give` too.
- **Keep them: the registry and the filter stay defined for every string, as 0013 states them.**
  Chosen. They cost nothing at run time, prove the writer and the reader whole, and keep a pattern
  holding U+212A from matching `key`. Only what folds changes: the registry's "its name at another
  address" compares as section 16 compares.

## Decision

**A service and its procedures are known by ids, which travel, and by names, which never do.** Spec
section 16 states what binds a side, hand-written or generated; it changes no envelope, and a reader
reads every id section 4 lets it read. What binds a manifest besides is the builder's, in the
builder's README.

**Ids, and their ranges.**

| What                 | Range              | On the wire                       |
| -------------------- | ------------------ | --------------------------------- |
| A service's id       | 1 to 65,535        | in each request, on 2 bytes (3.1) |
| A procedure's id     | 1 to 65,535        | in each request, on 2 bytes (3.1) |
| A service's revision | 1 to 2,147,483,647 | never                             |

Service 0 is the protocol's. No procedure of it is defined, so a side declares none, a writer writes
none (4.10), and a request that names it is refused by routing (4.7). A decision that defines one of
its procedures gives section 16 a table of them, a row each, and lifts 4.10 for them.

**A procedure's name**, in ABNF ([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)), 1 to 63
characters:

```abnf
procedure-name = lower 0*62( lower / upper / DIGIT )
lower          = %x61-7A
upper          = %x41-5A
```

- A name is read whole, character by character: a character outside these rules is in no name,
  whatever a case mapping makes of it, and a line terminator after a name leaves it no name. A side
  checks a name by these rules, never by its platform's regular expression or case mapping.
- So `_OTHER` is no procedure's name, and every procedure's name is a pattern a debug filter reads.
- **Two names are one** when they are equal once each ASCII upper-case letter is read as its
  lower-case one, and nothing else is changed, compared character by character.

**One name an address, one revision a service.** A side declares each address under one name,
written the same each time, each name of a service at one address, and each service at one
revision: the user's choice keeps an address to its spelling, where the fold joins two addresses. A side that counts refuses a
declaration that does not, in its registry (debugging 7.3, which gains `another revision of its
service`); `beadc check` holds a manifest to it.

**For life, and a revision's meaning.** Within a service, an id or a name a release declared stays
its declaration's in every later one, or is reserved; a revision counts the releases of a service's
contract, from 1, moved once in a release that changes it, never back. Section 16 writes both as
SHOULDs and names their holder, `beadc breaking` against the last release; nothing holds them across
manifests, nor on a side written by hand.

**A side refuses as it declares.** Each router refuses a declaration — a resolver registered, a
requester made, a notification registered — as it is made, never on a call, for the first of these
reasons that applies, before any of its own and before its registry's:

| Reason             | A declaration that names                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `out of its range` | a service id, a procedure id or a revision outside its range, service 0 among them, or no whole number |
| `off its form`     | a procedure's name that is no `procedure-name`                                                         |

A declaration refused declares nothing. The refusal is a `ProgrammerError` on the TypeScript side
and an `ArgumentException` on the C# side, whose sentences are each side's own; a C side reports a
code. The check is one function of the procedure alone, which holds nothing.

**The service manager checks first where it refuses first.** Its one reason of its own comes as a
notification is asked for again otherwise; `getNotification` and `GetNotification` run the router's
check before it, so the order holds at that layer too. That refusal keeps its own type, a
`ProgrammerError` and an `InvalidOperationException`, about the manager's state, and comes before
the router's reasons of state and its registry's. A requester or a resolver the manager makes goes
to the router with no reason of the manager's before it, and is checked there, once.

**A side that keeps no names.** A constrained profile built without the trace and the metrics
(debugging 1.2) refuses `out of its range` alone; its names are the manifest's whose tables `beadc
generate` wrote, which `beadc check` holds to their form.

**What a peer sees.** Ids in each request, a code in each application failure, and whether a server
holds a service or a procedure, by `SERVICE_UNKNOWN` or `PROCEDURE_UNKNOWN` (9.2, step 4). Never a
name, a revision or a reservation.

| Identity             | On the wire | A side holds it                                                   | `beadc` holds it                                         |
| -------------------- | ----------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| A service's id       | yes         | its range, at every declaration                                   | its range; unique in a manifest; reservations; for life  |
| A procedure's id     | yes         | its range, at every declaration                                   | its range; unique in its service; reservations; for life |
| A procedure's name   | no          | its form, at every declaration; folded uniqueness where it counts | the same, reservations, for life                         |
| A service's revision | no          | its range; one a service where it counts                          | its range; `breaking` its moves                          |

**`spec/identities.json` pins what a router refuses with no memory**, under its schema, its
generator `make_identities.py` from the standard library alone
([0005](0005-a-toolchain-per-language.md)), and `spec/check.py`. Its groups: `names`, procedure
names each taken or refused; `ids`, service ids, procedure ids and revisions each taken or refused,
an input no C# type holds crossing a row of the matrix; and `folds`, pairs of names, one or two. It
lists the five ways a side declares by a stable id, and each side's harness keys its table by them:
a resolver on a client's router and on a server's, a requester on each, a notification on a
client's. `beadc`'s tests play `names` and `ids` as one-procedure manifests.

**`spec/metrics.json` pins what a registry refuses**, folded, its revision among it.

**`beadc check` and `beadc breaking`** hold a manifest to section 16 and to the builder's README's
rules, amended as that file states.

### What changes on each side

| As it stands                                                 | What holds                                               | Why                                   |
| ------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------- |
| A requester's or a notification's declaration checks nothing | every declaration checked at its router: ranges and form | identity does not wait for a call     |
| A resolver's revision and name: anything                     | 1 to 2³¹ − 1, and a `procedure-name`, on both sides      | 0 is unknown; the traps of the probes |
| The registry compares names exactly                          | folded in ASCII, without building a string               | debugging 6.4's reading               |
| The registry holds no revision                               | one a service, refused `another revision of its service` | a revision is its service's           |
| The service manager's own reason first                       | the router's check, then its own                         | one order at every layer              |

## Consequences

**A hand-written side declares under the rules a generated one does.** A name off the form, a
revision of 0 or a service 0 fail as the side is built, on both sides alike. Nothing in the interop
or the demo moves: their names, their service 1 and their revision 1 hold already, and so does every
name a test declares through a router or a service manager. The only names off the form in the tests
go to a registry's own surface (`metrics-registry.test.ts`, `MetricsRegistryTests.cs`) or are a
relay's leg B, which declares nothing (`relay.test.ts`, `RelayTests.cs`). The two twins at 65,535
stay as they are.

**A declaration pays a scan of its name, and a call that makes no requester pays nothing.** The
service manager declares a requester at each `getRequest` (`service-manager.ts`), and the demo makes
one at each login (`demo/page.ts`): there, each call scans its name's 1 to 63 characters, with no
allocation and no lock. A registry's fold compares character by character, never building a folded
string, and takes a name held at its address exactly as it is, unfolded (`MetricsRegistry.cs`).

**Uniqueness and the revision hold only where a side counts, and in a manifest.** A side given no
registry takes `1/1 echo` and `1/2 echo` both, as today; its trace then shows the two, which is all
that reads them.

**A filter word reaches a name in every service.** `echo` in two services is two procedures that one
`echo` pattern keeps, as debugging 6.5 has it; a qualifier of service in a filter is the companion's
decision, not this one.

**Names cost a rename where they were sloppy, and only there.** A `.proto` with an rpc named
`get_thing` or `getThing` is refused `NAME_FORM` and asks for `GetThing`.

**Service 0's one id.** The protocol's procedures, sessions' and reflection's, share service 0 and
its revision, allocated by procedure id in section 16's table; the day the first is defined, 4.10
and both writers change, and a peer built before answers it `SERVICE_UNKNOWN`, as it answers any
service it lacks.

**A third file of the spec's own, after the durations.** `spec/identities.json` is small and grows
with section 16.

**The companion moves a minor.** Debugging 7.3 folds its second reason and gains a revision's, which
an implementation changes to keep passing: `debuggingVersion` 0.2.0, in the release that carries the
spec's.

**Versions** ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)):

- the layout: nothing, `0xA1` as it is;
- the spec: its minor, since every side must change to keep passing, in the release commit that
  carries sections 16 and 17 together
  ([0016](0016-a-json-payload-has-one-form-whichever-side-writes-it.md));
- the companion: its minor too, `debugging-v` beside it;
- the product: a minor of `v*`, the CHANGELOG under "Changed" saying what a declaration now refuses;
- the builder's manifest: `bead-manifest/1` unchanged, its `specVersion` naming the spec's version
  whose section 16 its producer follows.

## What lands with this record

In one change, or in this order, each step green, the twins on both sides together:

1. **The spec, its file, its gates**: section 16, the conformance sentence, `spec/identities.json`,
   its schema, its generator, CI's step, `common.schema.json`, `check.py`, `uncited.txt`.
2. **The companion**: debugging 1.2, 6.10, 7.3 and 8.3; `make_metrics.py`; `spec/metrics.json`.
3. **The TypeScript side**: the check, each router, the service manager, the registry, the harness,
   the twins.
4. **The C# side**: the same, and the test project's link to the file.
5. **The documents**: the support matrix, 0004, 0006, 0013, the decisions' table, the root README,
   the CHANGELOG.
6. **The builder**: its README's rules, its design's checks and breaking rules, and its options'
   comments.

## The Tenth Man

The draft met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)), and
the user chose where it asked, each way as the revised draft recommended: service 0 the protocol's,
the router's checks without memory and the registry's with it, section 16 holding what binds a side,
a service's name unique within a manifest, folded, 63 characters, a side that keeps no names
refusing out of its range alone, one conformance sentence for sections 16 and 17, and the rest of
the draft as it stood. Its objections, each with its answer:

| Objection                                                                                                                                                                              | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The protocol's range sits where the cited registries keep private use and experiments: CoAP's top is experimental and never operational, TLS's and DNS's first byte 255 is Private Use | Accepted: the CoAP citation goes, read at its source as the objection read it; the top block is weighed on its own terms, TLS's and DNS's reading named; the record recommends service 0 as the plan has it, the four placements put to the user, who takes service 0                                                                                                                                                                                   |
| "Service 0 alone" was dismissed on a false premise, and 16.3 reversed the plan and the builder's design without saying so                                                              | Accepted: no writer writes 0, so no application holds it; service 0 is the protocol's again, as the plan and the builder's design give it, its cost stated (4.10 and both writers on the day, one id and one revision shared by procedure id), HTTP/2's stream 0 named; a reversal is the user's, who keeps service 0                                                                                                                                   |
| 16.8 and 16.9 are MUSTs with no gate, and 16.11 promises a refusal no command makes                                                                                                    | Accepted: 16.11 goes with the builder's rules; ids for life and the revision's moves are SHOULDs in section 16 naming `beadc breaking` against the last release, its findings waived by rule name; "never for another" across manifests is said to be held by nothing                                                                                                                                                                                   |
| Section 16 binds builder concepts the spec does not define, and the Decision and the section disagree on hooks and the `.proto` derivation                                             | Accepted: section 16 keeps the ranges and service 0, the procedure's name, its reading and its fold, one name an address and one revision a service, the refusal and its order; services' and failures' names, packages, reservations, hooks, release rules and the derivation go to the builder's README and the schema's descriptions, gated by beadc's tests, as the builder's design already places the checks; the user keeps them out of the spec |
| The merge point with 0016 does not merge, and conformance to section 16 is undefined                                                                                                   | Accepted: one sentence for both records, "a side conforms to the wire by sections 1 to 15, to what it declares by section 16, and to what its codecs write and read by section 17", in the spec's header and in debugging 1.2; every line both records touch is listed with its text for whichever lands second                                                                                                                                         |
| The plan misses four gates, and its matrix row fails `check.py` as written                                                                                                             | Accepted: `make_identities.py` in CI's `spec` job, the C# test project's `Content` link, the root README's table row and generator list; the `ids` entries take short names, `service 65536` and the like, which the row quotes in backticks                                                                                                                                                                                                            |
| Two of the fold's three reasons are false, and the filter reason refutes 16.8                                                                                                          | Accepted: the reasons that hold are the `procedure` label read beside its `service`, a filter's letters matching in either case, and a consumer that marks its assembly CLS-compliant; the file system goes; ids and names are for life within a service, and section 16 says a filter word reaches a name in every service                                                                                                                             |
| "Unique within its package" serves neither consumer of a service's name                                                                                                                | Accepted: the scope is chosen by its consumers, unique within a manifest, folded, as the builder's design had it; full names in the façade's routes with `NAME_TARGET` per namespace was put to the user beside it, who keeps the manifest                                                                                                                                                                                                              |
| The 63-character bound rests on two misread standards and a false claim about C                                                                                                        | Accepted: the bound stays a plain choice, for short labels, keys and routes, citing no standard; "by construction" goes; a side that keeps no names refuses out of its range alone, its names the manifest's that `beadc check` holds                                                                                                                                                                                                                   |
| A cheaper option was never weighed: stateless checks at the router, stateful ones in the registry                                                                                      | Accepted, the record's recommendation: the router checks ranges and form, a pure function; the registry keeps names, folded, and gains the revision; the cost the draft left unknown is measured: tests that declare one name at two addresses on one router, none that mix revisions; the per-router table was put to the user beside it, who takes the split                                                                                          |
| "A call pays nothing" is false where a requester is made for each call                                                                                                                 | Accepted: no table and no lock at the router; the registry takes an exact name at its address without folding and folds character by character, never building a string; the claim reads "a call that makes no requester pays nothing"                                                                                                                                                                                                                  |
| The service manager refuses first, with another type, so 16.10's order does not hold at that layer                                                                                     | Accepted in part: the service manager's one reason of its own, a notification asked for again otherwise, now follows the router's check, which `getNotification` runs first, so 16.10's order holds there too; its "asked for otherwise" keeps its type, about the manager's state, and the record names it before the registry's reasons                                                                                                               |
| The file plays three of the five declaration paths, and no input that is not a number                                                                                                  | Accepted: the file lists five ways, a resolver on each router, a requester on each, a notification on a client's, each harness keyed by them; `"1"`, `true` and `null` join the ids and revisions, crossing the C# row, as `durations.json` pins `"1000"` and `true`                                                                                                                                                                                    |
| The record carries a false .NET probe                                                                                                                                                  | Accepted: run again, `GetString()` over `"a\uD800"` throws `InvalidOperationException`; that is a second reason, beside I-JSON (RFC 7493 §2.1), to keep a lone surrogate in the twins and out of the file                                                                                                                                                                                                                                               |
