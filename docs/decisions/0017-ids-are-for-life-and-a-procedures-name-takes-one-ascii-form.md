# 0017 — Ids are for life, a procedure's name takes one ASCII form, and every side refuses a declaration off them as it is made

- **Status**: accepted
- **Scope**: `spec/spec.md` section 16 and the conformance sentence; `spec/debugging.md` 1.2, 6.10,
  7.3 and 8.3; `spec/identities.json` and its gate; `spec/metrics.json`; every implementation's
  routers, service manager and registry; the support matrix; and the blueprints the builder checks

## Context

A request names its procedure by two ids, its service's and its own, each on 2 bytes (spec 3.1).
Nothing else of a procedure travels. Yet a procedure has a name on every side, and the name reaches
further than the ids:

- it labels the metrics, `procedure="whoami"`, its service's id beside it (debugging 8.3), and
  `spec/metrics.json` pins 15 of the interop's 18 names as label values;
- a debug filter keeps or leaves out a call by it, across every service, an ASCII letter matching in
  either case (debugging 6.4 and 6.5);
- the builder keys its generated API by it.

**What a side refuses besides, and where.** A declaration is a resolver registered, a requester
made, or a notification registered (debugging 7.2):

| Declaration                    | TypeScript                                                                                                       | C#                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A resolver registered          | a payload limit below 1; a second resolver (`router/shared/router-core.ts`)                                      | a payload limit below 1; a second resolver (`Bead.Core/RouterCore.cs`)          |
| A notification registered      | a second one (`router-client.ts`)                                                                                | a second one at its address, an `InvalidOperationException` (`RouterClient.cs`) |
| A notification asked for again | another name, revision, deprecation, limit or window, a `ProgrammerError` (`router/shared/service-manager.ts`)   | asked for otherwise, an `InvalidOperationException` (`ServiceManager.cs`)       |
| Any, to a registry given one   | another name at its address; its name at another address; past the ceiling (`router/shared/metrics-registry.ts`) | the same (`MetricsRegistry.cs`)                                                 |

**A side that checks no name's form and no revision** lets a name through that the registry, a
filter and a generated API read differently, and refuses an id of 0 at a requester only as its
header is written (`router/shared/header.ts`).

**What reads a name and a revision.** A revision is read by the trace, which copies it into each
debug event, and compared when a notification is asked for again; a name is read by the trace, the
filter and the registry, all three the companion's. So what a name and a revision must be consistent
for is debugging, and the layer that holds names is the registry
([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)).

**Revision 0 at a relay.** A relay's leg B calls the destination with a procedure it never declared,
at revision 0 (`router/server/relay.ts`, `Bead.Core/Relay.cs`), counted `_OTHER` (debugging 8.3).

**Names off any form in the companion's files.** `spec/metrics.json` declares `_OTHER`, `a\b`,
`say "hi"`, `two\nlines` and `café` (`spec/generators/make_metrics.py`); `spec/debug-filters.json`
names `İd`, `a\u0085b`, the empty name and `café` (`spec/generators/make_debug_filters.py`). They
reach the registry's own surface, never a router (`router/server/__tests__/metrics.test.ts`,
`MetricsTests.cs`).

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
No assembly here is so marked, no project and no source naming `CLSCompliant`, so the CLS binds a
consumer's code, never Bead's. The builder generates one file for each `.proto` file, so a file
system that ignores case never meets two names.

### The options weighed

**Where the protocol's own services live.** Spec 4.7 reads a service id of 0 and refuses it by
routing; 4.10 never writes one, and neither side's writer does (`header.ts`, with `FIELD_MAXIMUMS`).

- **Service 0, the protocol's, its procedures defined by decision.** Chosen. No application holds 0,
  since no writer writes it, so nothing is taken from anyone, and every id from 1 to 65,535 stays
  the application's. HTTP/2 does the same with its stream 0, "used for connection control messages"
  ([RFC 9113 §5.1.1](https://www.rfc-editor.org/rfc/rfc9113#section-5.1.1)). It costs, on the day a
  protocol procedure is defined, 4.10's exception and each side's `writeHeader`, one line each; and
  it is one id, so the protocol's services share service 0 by its procedure ids, which spec 16 then
  allocates in a table, a row each, and one revision.
- A block at the top, 65,280 to 65,535. TLS reads that block as Private Use ([RFC 8446
  §11](https://www.rfc-editor.org/rfc/rfc8446#section-11), "Values with the first byte 255 (decimal)
  are reserved for Private Use"), and DNS reads 65,280 to 65,534 so ([RFC 6895
  §3.1](https://www.rfc-editor.org/rfc/rfc6895#section-3.1)); spec 4.4 lays its credential block out
  as a TLS extension. A reader who knows them takes the block for the application's, and a
  declaration there is then refused at build, never in silence. CoAP's top range is the reverse of a
  protocol's own: "reserved for experiments … MUST NOT be used in operational deployments" ([RFC
  7252 §12.2](https://www.rfc-editor.org/rfc/rfc7252#section-12.2)). It moves no id, and moves the
  tests that register at 65,535 (`router-core.test.ts`, `RouterCoreTests.Calls.cs`).
- A block at the low end, 0 to 255, as CoAP keeps 0 to 255 for the IETF's own options and as IANA
  keeps ports 0 to 1023 as System Ports ([RFC 6335
  §6](https://www.rfc-editor.org/rfc/rfc6335#section-6)). It moves service 1: the interop's
  (`spec/interop-blueprint.json`), with the bytes of the conversations that call it and every
  `service="1"` label of `spec/metrics.json`, and the demo's
  (`implementations/typescript/demo/procedures.ts`); and every test that declares a service below
  256, which `serviceId: 2` and `ServiceId = 2` alone reach in both sides' test files.
  [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) lets the wire be revised in
  place until it is published.
- Left to the first protocol service's decision: a protocol service that needs an id past 0 takes
  one an application may hold by then.

**One rule from an rpc to a procedure's name** binds whatever generates names from a `.proto`: its
first letter lowered, and only that.

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

- Exact: `getHTTPStatus` and `getHttpStatus` live side by side in one service, as two `procedure`
  labels beside one `service`, which every filter word of those letters keeps both of, and which a
  CLS-compliant consumer's members cannot carry apart.
- By each platform's comparison: `café` and `cafÉ` one on both, U+212A and `k` one on some readings.
- **Without regard to case, in ASCII alone, character by character.** Chosen: how debugging 6.4
  reads a pattern, and what no platform's comparison does by itself.

**Where a declaration is checked.**

- Nothing at a side: `beadc check` alone. A hand-written side is held by nothing, and section 16 is
  a preference ([0006](0006-a-rule-has-its-gate.md)).
- A table in each router: a range, a form, one name an address, one revision a service, at each
  declaration whatever the registry. It repeats the registry's two reasons in a second layer; it
  costs a lock of its own on the C# side, since `DeclareRequester` runs on the caller's thread
  (`RouterClient.cs`), a table held for the router's life, and the tests that declare one name at
  two addresses on one router or core.
- **What needs no memory at every declaration, what needs memory where 0013 put it.** Chosen. Each
  router checks the ids' ranges, the revision's and the name's form, a pure function over the
  procedure: no lock, no table, nothing held. The registry keeps its refusals, and compares names as
  section 16 compares them. One name an address then holds on a side that counts, and in a
  blueprint through `beadc check`; on a side that counts nothing, two names at one address show only
  in its trace, the one reader left, which is debugging's. A service's revision keys no series, so
  the registry takes a service at any.

**Ids for life.**

- Ids reused once a procedure is gone a while: a peer built against an earlier release calls the new
  procedure with the old payload, answered `PAYLOAD_UNDECODABLE` at best, run with the wrong meaning
  at worst.
- **For life, within a service, a retired id reserved, as protobuf reserves a field's number.**
  Chosen. Names alike, so a label and a filter never come to count or keep another procedure of that
  service. Only a sequence of releases shows it, so one tool holds it: `beadc breaking`, against the
  last release, its findings waived by rule name. Nothing holds it across blueprints, nor for a side
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

**What section 16 holds.** The identity rules bind every side; the checks and the breaking rules
bind the builder.

- Everything a blueprint holds besides: services' and failures' names, a package's scope,
  reservations, hooks, the release rules and the derivation from a `.proto`. The spec defines none
  of these and no conformance file cites them. A blueprint matter of the interop's moves the spec's
  version, as its files are the spec's, the blueprint's schema among them
  ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md));
  one of the builder alone moves the builder's
  ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).
- **What binds a side.** Chosen: the ids' ranges and service 0; a procedure's name, its form, its
  reading and its fold; one name an address, held where a side counts, and one revision a service;
  ids for life and the revision's meaning, as SHOULDs naming `beadc breaking`; the refusal and its
  order. The rest binds the builder's blueprint, held by the builder's tests.

**A service's name's scope** is the builder's, and its consumers choose it: the generated classes,
whose namespace is a file's `csharp_namespace`, which two packages may share, where two
`CatalogServer` classes fail with CS0101; and HTTP/JSON transcoding, whose routes are
`POST /api/<service>/<procedure>`.

- Unique within a package: serves neither, since `acme.catalog.v1.Catalog` and
  `acme.catalog.v2.Catalog` both route to `/api/Catalog/…` and may share a namespace.
- Full names in the transcoding's routes, as gRPC and Connect route
  `/acme.catalog.v1.Catalog/Method`, and class names unique within each generated namespace, held by
  `NAME_TARGET`.
- **Unique within a blueprint, folded.** Chosen: one blueprint is one id space, so two versions served
  side by side take two names, `CatalogV1` and `CatalogV2`.

**Where the rules are pinned.**

- Twin tests: the probes above are what they miss.
- Rows of `spec/vectors.json`: vectors hold envelopes, and a name is in none.
- **A file of its own on the spec's axis, `spec/identities.json`**, as
  [0014](0014-every-place-that-takes-a-duration-is-a-row-of-one-file.md) gave durations theirs, for
  what a router refuses with no memory: names, ids and revisions, each played by every way a side
  declares, and folds, played by the helper every comparison goes through. What the registry refuses
  stays `spec/metrics.json`'s, the companion's file. Chosen.

**What becomes of the companion's own cases.** The registry and the filter read names no router
passes on: `_OTHER`, `say "hi"`, `café`.

- Take them out, with 12.4's escaping: code nothing reaches, but a registry is given names by its
  `attach` and `Give` too.
- **Keep them: the registry and the filter stay defined for every string, as 0013 states them.**
  Chosen. They cost nothing at run time, prove the writer and the reader whole, and keep a pattern
  holding U+212A from matching `key`. Only what folds changes: the registry's "its name at another
  address" compares as section 16 compares.

## Decision

**A service and its procedures are known by ids, which travel, and by names, which never cross
Bead's wire.** Spec section 16 states what binds a side, hand-written or generated; it changes no
envelope, and a reader reads every id section 4 lets it read. What binds a blueprint besides is the
builder's own, decided with it.

**Ids, and their ranges** (16.2, 16.3): a service's id and a procedure's from 1 to 65,535, each on 2
bytes in every request; a service's revision from 1 to 2,147,483,647, which never travels. Service 0
is the protocol's: no writer writes it (4.10), so no application holds it, and a decision that
defines one of its procedures gives section 16 a table of them.

**A procedure's name** (16.4 to 16.6): 1 to 63 ASCII letters and digits, a lower-case letter first,
in ABNF ([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)), read whole, character by character,
never by a platform's regular expression or case mapping, which the probes above show parting. So
`_OTHER` is no procedure's name, and every procedure's name is a pattern a debug filter reads. Two
names are one when they are equal once each ASCII upper-case letter is read as its lower-case one,
as debugging 6.4 reads a pattern.

**One name an address, one revision a service.** A side declares each address under one name,
written the same each time, each name of a service at one address, and each service at one revision:
an address keeps its spelling, where the fold joins two addresses. A side that counts refuses a
declaration that breaks either of the first two, in its registry (debugging 7.3); one of a service at
another revision counts into its series, which no label carries, as Prometheus identifies a series by
its name and its labels. `beadc check` holds a blueprint to all three.

**For life, and a revision's meaning.** Within a service, an id or a name a release declared stays
its declaration's in every later one, or is reserved; a revision counts the releases of a service's
contract, from 1, moved once in a release that changes it, never back. Section 16 writes both as
SHOULDs and names their holder, `beadc breaking` against the last release; nothing holds them across
blueprints, nor on a side written by hand.

**A side refuses as it declares.** Each router refuses a declaration — a resolver registered, a
requester made, a notification registered — as it is made, never on a call, for the first of these
reasons that applies, before any of its own and before its registry's:

| Reason             | A declaration that names                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `out of its range` | a service id, a procedure id or a revision outside its range, service 0 among them, or no whole number                                                      |
| `off its form`     | a procedure's name that is no `procedure-name` (16.4)                                                                                                       |
| `against its kind` | a procedure whose kind its way of declaring does not take ([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)) |

A declaration refused declares nothing. The refusal is a `ProgrammerError` on the TypeScript side
and an `ArgumentException` on the C# side, whose sentences are each side's own; a C side reports a
code. The check is one function of the procedure alone, which holds nothing.

**The service manager checks first where it refuses first.** Its one reason of its own comes as a
notification is asked for again otherwise, another window among it
([0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md));
`getNotification` and `GetNotification` run the router's check before it, so the order holds at that
layer too. That refusal keeps its own type, a `ProgrammerError` and an `InvalidOperationException`,
about the manager's state, and comes before the router's reasons of state and its registry's. A
requester or a resolver the manager makes goes to the router with no reason of the manager's before
it, and is checked there, once.

**A side that keeps no names.** A constrained profile built without the trace and the metrics
(debugging 1.2) refuses `out of its range` alone; its names are a blueprint's, which `beadc check`
holds to their form ([0006](0006-a-rule-has-its-gate.md)).

**What a peer sees.** Ids in each request, a code in each application failure, and whether a server
holds a service or a procedure, by `SERVICE_UNKNOWN` or `PROCEDURE_UNKNOWN` (9.2, step 4). Never a
name, a revision or a reservation.

| Identity             | On the wire | A side holds it                                                   | `beadc` holds it                                         |
| -------------------- | ----------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| A service's id       | yes         | its range, at every declaration                                   | its range; unique in a blueprint; reservations; for life |
| A procedure's id     | yes         | its range, at every declaration                                   | its range; unique in its service; reservations; for life |
| A procedure's name   | no          | its form, at every declaration; folded uniqueness where it counts | the same, reservations, for life                         |
| A service's revision | no          | its range, at every declaration                                   | its range; `breaking` its moves                          |

**`spec/identities.json` pins what a router refuses with no memory**, under its schema, its
generator `make_identities.py` from the standard library alone
([0005](0005-a-toolchain-per-language.md)), and `spec/check.py`. Its groups: `names`, procedure
names each taken or refused; `ids`, service ids, procedure ids and revisions each taken or refused,
an input no C# type holds crossing a row of the matrix; and `folds`, pairs of names, one or two;
beside them,
[0018](0018-a-services-procedures-are-typed-descriptors-served-and-called-through-one-layer.md)'s
procedure kinds. It lists the ways a side declares by a stable id, and each side's harness keys its
table by them. A builder plays `names` and `ids` as one-procedure blueprints.

**`spec/metrics.json` pins what a registry refuses**, folded, and the series a service declared at a
second revision counts into.

**`beadc check` and `beadc breaking` hold a blueprint to section 16** and to the builder's own rules
([0006](0006-a-rule-has-its-gate.md)).

## Consequences

**A hand-written side declares under the rules a generated one does.** A name off the form, a
revision of 0 or a service 0 fail as the side is built, on both sides alike.

**A declaration pays a scan of its name, and a call that makes no requester pays nothing.** The
service manager declares a requester at each `getRequest` (`service-manager.ts`), and the demo makes
one at each login (`demo/page.ts`): there, each call scans its name's 1 to 63 characters, with no
allocation and no lock. A registry's fold compares character by character, never building a folded
string, and takes a name held at its address exactly as it is, unfolded (`MetricsRegistry.cs`).

**Uniqueness holds only where a side counts, and in a blueprint.** A side given no registry takes
`1/1 echo` and `1/2 echo` both; its trace then shows the two, which is all that reads them. A side
that counts takes a service at two revisions, two generated copies of it in one process say, and
counts both into one series, its trace telling each call's revision.

**A filter word reaches a name in every service.** `echo` in two services is two procedures that one
`echo` pattern keeps, as debugging 6.5 has it; a qualifier of service in a filter is the companion's
decision, not this one.

**Names cost a rename where they were sloppy, and only there.** A `.proto` with an rpc named
`get_thing` or `getThing` is refused `NAME_FORM` and asks for `GetThing`.

**Service 0's one id.** The protocol's procedures share service 0 and its revision, allocated by
procedure id in section 16's table; the day the first is defined, 4.10 and both writers change, and
a peer built before answers it `SERVICE_UNKNOWN`, as it answers any service it lacks.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)),
and the user chose where it asked: service 0 the protocol's, the router's checks without memory and
the registry's with it, section 16 holding what binds a side, a service's name unique within a
blueprint, folded, 63 characters, a side that keeps no names refusing out of its range alone, and one
conformance sentence for sections 16 and 17. Its objections, each with the answer that holds:

| Objection                                                                                                                                                                              | Answer                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The protocol's range sits where the cited registries keep private use and experiments: CoAP's top is experimental and never operational, TLS's and DNS's first byte 255 is Private Use | Accepted: CoAP's top range is read as the reverse of a protocol's own; the top block is weighed on its own terms, TLS's and DNS's reading named; service 0 is chosen among the four placements                                                                                                                                                                                |
| "Service 0 alone" was dismissed on a false premise, and 16.3 reversed the plan and the builder's design without saying so                                                              | Accepted: no writer writes 0, so no application holds it; service 0 is the protocol's, its cost stated (4.10 and both writers on the day, one id and one revision shared by procedure id), HTTP/2's stream 0 named                                                                                                                                                            |
| Ids for life and a revision's moves are MUSTs with no gate, and a refusal is promised that no command makes                                                                            | Accepted: the refusal no command makes goes with the builder's rules; ids for life and the revision's moves are SHOULDs in section 16 naming `beadc breaking` against the last release, its findings waived by rule name; "never for another" across blueprints is said to be held by nothing                                                                                 |
| Section 16 binds builder concepts the spec does not define, and the Decision and the section disagree on hooks and the `.proto` derivation                                             | Accepted: section 16 keeps the ranges and service 0, the procedure's name, its reading and its fold, one name an address and one revision a service, the refusal and its order; services' and failures' names, packages, reservations, hooks, release rules and the derivation bind the builder's blueprint, held by the builder's tests; the user keeps them out of the spec |
| The merge point with 0016 does not merge, and conformance to section 16 is undefined                                                                                                   | Accepted: one sentence for both records, "a side conforms to the wire by sections 1 to 15, to what it declares by section 16, and to what its codecs write and read by section 17", in the spec's header and in debugging 1.2                                                                                                                                                 |
| Two of the fold's three reasons are false, and the filter reason refutes 16.8                                                                                                          | Accepted: the reasons that hold are the `procedure` label read beside its `service`, a filter's letters matching in either case, and a consumer that marks its assembly CLS-compliant; ids and names are for life within a service, and section 16 says a filter word reaches a name in every service                                                                         |
| "Unique within its package" serves neither consumer of a service's name                                                                                                                | Accepted: the scope is chosen by its consumers, unique within a blueprint, folded; full names in the transcoding's routes with `NAME_TARGET` per namespace was weighed beside it, and the user keeps the blueprint                                                                                                                                                            |
| The 63-character bound rests on two misread standards and a false claim about C                                                                                                        | Accepted: the bound stays a plain choice, for short labels, keys and routes, citing no standard; "by construction" goes; a side that keeps no names refuses out of its range alone, its names the blueprint's that `beadc check` holds                                                                                                                                        |
| A cheaper option was never weighed: stateless checks at the router, stateful ones in the registry                                                                                      | Accepted: the router checks ranges and form, a pure function; the registry keeps names, folded, a revision keying none of its series; the per-router table was weighed beside it, its cost in the Context, and the user takes the split                                                                                                                                       |
| "A call pays nothing" is false where a requester is made for each call                                                                                                                 | Accepted: no table and no lock at the router; the registry takes an exact name at its address without folding and folds character by character, never building a string; the claim reads "a call that makes no requester pays nothing"                                                                                                                                        |
| The service manager refuses first, with another type, so 16.10's order does not hold at that layer                                                                                     | Accepted in part: the service manager's one reason of its own, a notification asked for again otherwise, follows the router's check, which `getNotification` runs first, so 16.10's order holds there too; its "asked for otherwise" keeps its type, about the manager's state, and the record names it before the registry's reasons                                         |
| The file plays three of the five declaration paths, and no input that is not a number                                                                                                  | Accepted: the file lists five ways, a resolver on each router, a requester on each, a notification on a client's, each harness keyed by them; `"1"`, `true` and `null` join the ids and revisions, crossing the C# row, as `durations.json` pins `"1000"` and `true`                                                                                                          |
| The record carries a false .NET probe                                                                                                                                                  | Accepted: `GetString()` over `"a\uD800"` throws `InvalidOperationException`, as the Context's probe shows; that is a second reason, beside I-JSON (RFC 7493 §2.1), to keep a lone surrogate in the twins and out of the file                                                                                                                                                  |
