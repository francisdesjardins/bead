# 0003 — One word means one thing, and there are no abbreviations

- **Status**: accepted
- **Scope**: the specification, every implementation, and the repository's prose

## Context

A protocol is read in more than one language, and its words travel further than its code: into the
spec, the conformance files, each implementation's names, and the failures a peer reads. A word that
carries two jobs makes two readers disagree without either being wrong. The words around Bead are
crowded: a transport has its own (WebSocket's frame and message, HTTP's request and response), each
platform has its own (.NET's `HttpClient`), and a short form saves a few letters once and costs a
lookup every time after.

## Decision

**A word means one thing, in the spec and in every implementation.** An _envelope_ is Bead's unit,
never a _frame_, which is what WebSocket carries it in, nor a _message_, which is what a transport
delimits. Its byte 1 is its _kind_. A procedure's kind, `procedureKind`, is how it is called,
`request`, `notifies` or `command`, and is never its envelopes': every call opens with a `REQUEST`,
a command's too. A kind that is not an envelope's is named with its owner where it sits in one
structure beside an envelope's. _Type_ is left to media types, to each language's types, and to a
debug event's step, `request`, `command` or `notification`, which types a call to a procedure that
notifies a `request`. A _call_ is a request and its answer; an _answer_ is a result or a failure,
and one _call id_ pairs a request, its answer, its cancel and its notifications. What a side
_reports_ it tells its application, what it _answers_ goes back on the wire, and what it _drops in
silence_ it does neither (spec, section 9.0). A _credit_ is what a receiver lets its sender send,
counted in bytes for a transfer and in notifications for a paced subscription, and PACED says which.

**No abbreviations.** A name is spelled out: `maximumEnvelopeBytes`, `transferInactivityTimeout`,
`connectionHandle`, `MaximumAttempts`. A word a standard or a platform owns is that owner's, and is
not an abbreviation of ours: `HTTP`, `id`, `ws`, the scheme RFC 6455 gives WebSocket and the Node
package named after it, whose own options keep their names (`maxPayload`).

**A name that the platform gives every application of Bead's kind, or that the application using
Bead declares, is not available to Bead.** The C# side's HTTP client is `BeadHttpClient`, since
.NET's is `HttpClient`, which every application that speaks HTTP has in hand beside it. A word
applications declare for themselves, as they name their procedures and services, would collide with
Bead's in every one that declares it, for good and not by bad luck, so Bead takes none. Where a
platform's rule would take a word away from the spec, the spec's word stays and the rule is
overruled where it stands: byte 2 is the flags, so the C# enum is `EnvelopeFlags`, against the
analyzer that refuses a name ending in `Flags` (CA1711).

## Consequences

The rename is the cheap half. The expensive half is noticing: a word that means two things is found
by reading the surface aloud, not by a tool, and no gate finds the next one
([0006](0006-a-rule-has-its-gate.md)). What holds it is review, and, for every renaming, the Tenth
Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)).

**A better word is applied on every side where it applies, with its call sites, in one commit**
([0004](0004-one-behaviour-in-every-language.md)); until it is, the two words are an open row of the
support matrix. Anything else leaves two vocabularies in the tree, and a reader who has to know
which file speaks which.

**A word on the wire costs more than a word in the code.** A flag's or a code's name is in the spec,
the vectors and every implementation at once, so changing one is a change of the protocol, with the
version that follows from it
([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).

**A platform's name that only some applications meet costs a qualification where they do.** Bead's
`HealthStatus` is ASP.NET's health checks' too: an application that uses both names one by its
namespace (CS0104), the C# the builder generates qualifies every type as `global::Bead.`, and
nothing is renamed for it ([0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)).
