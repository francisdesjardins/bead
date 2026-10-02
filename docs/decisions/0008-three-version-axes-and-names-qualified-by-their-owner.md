# 0008 — Versions run on three axes, and names are qualified by their owner

- **Status**: accepted
- **Scope**: the protocol, every implementation, and the repository

## Context

Bead is published to no registry, yet its name is public already: the demo francisdesjardins.ca
serves carries it. Three things change at different speeds: the bytes of an envelope, which every
peer must agree on; the spec that states them, whose text and conformance files grow faster than
the bytes; and each implementation, which ships fixes the wire never sees.

One version for all of them would tie a fix in one implementation to the wire, or hide a change of
the wire in a package's patch. A version negotiated at connect costs a round trip and a state before
the first call, where a byte in every envelope costs nothing. A bare name on a registry or in a
namespace belongs to whoever took it first, and collides with whatever a platform already calls
that. And a repository kept as though nothing would ever be published leaves every name and every
promise to be decided at once, on the day of the first release.

## Decision

**Versions run on three axes, each moving alone.**

1. **The layout**, the first byte of every envelope: `0xA1` is the layout `spec/spec.md` describes,
   and `0xA2` to `0xAF` are the layouts to come, each keeping the 8-byte prefix
   ([0001](0001-the-envelope-sits-at-fixed-offsets.md)). A reader refuses a layout it does not read
   with `LAYOUT_UNSUPPORTED`, and should name the layouts it reads in the detail, on the call it can
   still answer. **Until the wire is first published, it is revised in place:** a change decided
   here rewrites `0xA1`, its spec, its vectors and both implementations at once, and no reader of an
   earlier `0xA1` is kept. From the first publication on, a change that a reader of the layout
   before it cannot read takes the next layout byte.
2. **The spec**: its text, its vectors, its conversations and the interop service move together,
   and are tagged `spec-v*`.
3. **The product**: each implementation's releases, under Semantic Versioning, at `0.x`, tagged
   `v*`, one version for both manifests, cut from a `release/*` branch
   ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)).

**A name is qualified by its owner.** The TypeScript package is `@francisdesjardins/bead` on npm.
The C# packages are `FrancisDesjardins.Bead.*` on NuGet, which has no scopes, while their assemblies
are `Bead.*` and their namespaces `Bead` and `Bead.*`. Over HTTP, the media types are
`application/prs.bead` and `application/prs.bead-batch`, in the personal tree of RFC 6838, and the
headers are `bead-*`. The builder's command is `beadc`, as `protoc` and `flatc` are named, since a
bare `bead` is not Bead's to take; the C# it generates qualifies every type as `global::Bead.`, so a
platform's name, as ASP.NET's `HealthStatus`, never makes one of Bead's ambiguous (CS0104). The
builder's protobuf package and extension numbers are reserved in protobuf's global registry when its
options freeze at v1.

**The repository is kept as if it were published.** The wire changes only by decision: a record
here, and the Tenth Man before it ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)).
Versions stay at `0.x`, and the CHANGELOG is kept current. The TypeScript manifest stays
`private: true`, and the C# projects carry no package id, until a first publication sets them.

## Consequences

- **Fifteen layouts before the byte runs out**, `0xA1` to `0xAF`; anything else in byte 0 is no
  envelope. Each new layout is a decision of its own, and the prefix is never one to change.
- A fix in one implementation moves its `v*` and nothing else; a clarification of the spec moves
  `spec-v*` and no layout. A reader learns the layout from the envelope itself, so no peer asks
  another for its version.
- `spec-v*` and `v*` share the repository's tags, and their prefixes keep them apart. A language
  whose packaging asks for tags of another form, as a Go module under a subfolder does, settles that
  when it joins.
- At `0.x`, Semantic Versioning lets a minor release break; the CHANGELOG says what broke, and the
  record that decided it says why.
- A name costs more the further it travels: a rename at `0.x` costs every side's call sites, a line
  in the CHANGELOG and the Tenth Man; after a publication, it costs every consumer besides.
- The generated C# is longer for its `global::` prefixes, and never ambiguous.

## The Tenth Man

The names this record settles met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). Its objections, each with its
answer:

| Objection                                                                                                                         | Answer                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bead` is taken on npm, PyPI and crates.io, and a memory tool for coding agents goes by Beads                                     | Accepted in part: the protocol keeps its name, and the builder's command is `beadc`.                                                                                                                  |
| npm's scope is the owner's, and NuGet has no scopes                                                                               | Accepted as a rule: the C# packages are `FrancisDesjardins.Bead.*`, and their assemblies and namespaces stay `Bead.*`.                                                                                |
| A prefix against a platform's names holds once, in `BeadHttpClient`, and `HealthStatus` collides with ASP.NET's (CS0104)          | Accepted for the builder: the C# it generates qualifies every type as `global::Bead.`. Nothing else is renamed.                                                                                       |
| The builder's protobuf package and extension numbers belong in protobuf's global registry                                         | Accepted, when its options freeze at v1, not before.                                                                                                                                                  |
| "Nothing is published" does not hold: the demo carries the name, and names are due at the first publication, not the first commit | Accepted: the repository is kept as if it were published.                                                                                                                                             |
| Another name for the protocol, one free on every registry                                                                         | Refused: the name weighed sounds like a binary WebSocket library in the same languages; the names Bead publishes under are qualified by their owner, and free; and a rename is a decision of its own. |

Refused, as the Tenth Man proposed itself: another npm scope, since an account can become an
organization; another media type than `application/prs.bead`, since RFC 6838's personal tree fits
it; another namespace than `Bead` in `Bead.Core`, as Polly's is `Polly`; and one spelling of
WebSocket across the sides, against `ws` and `WS`, each language's idiom.
