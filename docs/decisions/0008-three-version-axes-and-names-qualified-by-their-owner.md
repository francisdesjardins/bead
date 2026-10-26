# 0008 — Versions run on three axes, and names are qualified by their owner

- **Status**: accepted
- **Scope**: the protocol, every implementation, and the repository

## Context

Bead is published to no registry, yet its name is public already: the demo francisdesjardins.ca
serves carries it. Three things change at different speeds: the bytes of an envelope, which every
peer must agree on; the spec that states them, whose text and conformance files grow faster than the
bytes; and each implementation, which ships fixes the wire never sees.

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
2. **The spec**: its text and every conformance file move together, and are tagged `spec-v*`.
   `spec/spec.md` states their version, which each conformance file repeats as its `specVersion`, as
   CloudEvents names its own `specversion`. It follows Semantic Versioning at `0.x`, without
   pre-releases: the minor moves when an implementation that conforms to the last version must
   change to conform to this one — an expectation changed, a field, a group or a file added — and
   the patch when one that conforms passes unchanged — a vector or a conversation added for what the
   spec already requires, a clarification. It moves in the release commit, as the product's version
   does, and a release whose spec moved tags `spec-v` and that version beside its `v*`. The spec's
   companion, `spec/debugging.md`, which states what a side traces, filters and counts beside the
   wire ([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)), runs on this axis under a
   version of its own: its files repeat it as their `debuggingVersion`, it moves by the same rule, a
   code the wire gains moving both, and a release whose companion moved tags `debugging-v` and that
   version. So does the transcoding's companion, `spec/transcoding.md`, which states what a gateway
   answers over HTTP of a service's procedures
   ([0037](0037-a-procedure-is-also-an-http-route-which-a-gateway-answers-as-one-more-client-of-its-server.md)):
   its file repeats it as its `transcodingVersion`, it moves by the same rule, a status a gateway
   answers moving it alone, and a release whose transcoding moved tags `transcoding-v` and that
   version.

   `tools/release.mjs` moves every version in the release commit, each document's by its own move,
   `--spec`, `--debugging` and `--transcoding`, the C# lock files' project ranges with them, an
   example's among them, and sets each document's tag at the `v*` that
   `git flow release finish` makes; `tools/check-versions.mjs` holds them
   ([0006](0006-a-rule-has-its-gate.md)). It moves as well the image an example's wrappers name and
   the `specVersion` of a blueprint an example generated, which the `examples` job holds to what
   beadc prints and writes, as `generate --check` holds the header of the code beadc generates
   ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md));
   neither is a document's file. A document's files
   are its text, the conformance files that repeat its version and their schemas; the generators
   and checks that write and read them are none of them. A document's last release is the newest
   `v*` before the commit whose tree holds it, at the version that tree states, or at that `v*`'s
   own when it states none; its tag stands at the first `v*` that gives it that version. A document
   whose files changed since its last release moves to a successor of that version, its minor at
   least when a conformance file, a top-level key of one or a property of its schemas was added,
   and one whose files did not keeps it.

3. **The product**: each implementation's releases and the builder's, under Semantic Versioning, at
   `0.x`, tagged `v*`, one version in the TypeScript side's and the builder's `package.json` and in
   `Directory.Build.props`, cut from a `release/*` branch
   ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). While its major is 0, a
   release that breaks what a consumer calls, reads or builds moves the minor, and a release of
   fixes alone the patch. npm's caret range and NuGet's floating minor read a `0.y` version as they
   read a major, and Semantic Versioning 2.0.0 §4 owes no stability under `0.y.z`, so a break in a
   patch would reach every consumer who asked for fixes alone
   ([0010](0010-a-request-presents-a-credential-of-a-scheme.md)'s round on the footguns gives the
   same reason). The CHANGELOG says what broke, and the record that decided it says why.

**A name is qualified by its owner.** The TypeScript package is `@francisdesjardins/bead` on npm.
The C# packages are `FrancisDesjardins.Bead.*` on NuGet, which has no scopes, while their assemblies
are `Bead.*` and their namespaces `Bead` and `Bead.*`. Over HTTP, the media types are
`application/prs.bead` and `application/prs.bead-batch`, in the personal tree of RFC 6838, and the
headers are `bead-*`. The builder's command is `beadc`, as `protoc` and `flatc` are named, since a
bare `bead` is not Bead's to take; the C# it generates qualifies every type as `global::Bead.`, so a
platform's name, as ASP.NET's `HealthStatus`, never makes one of Bead's ambiguous (CS0104). The
builder's options take one extension number of protobuf's global registry from their first
publication, which lists the project beside it; their package, `bead`, is protected by no registry,
as no protobuf package is, and goes by the project's name as `buf.validate` and `google.api` go by
theirs
([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).
A blueprint of the builder's names its format's major, `bead-blueprint/1`, whose schema moves on the
spec's axis.

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
- Past the floor the gate holds, whether a document's move is its minor or its patch is the
  maintainer's to say, as whether a release of the product breaks; the gate holds that a document
  moves by one step when its files changed, and not otherwise, and the product by one step at each
  release.
- A name costs more the further it travels: a rename at `0.x` costs every side's call sites, a line
  in the CHANGELOG and the Tenth Man; after a publication, it costs every consumer besides.
- The C# the builder generates is longer for its `global::` prefixes, and never ambiguous.

## The Tenth Man

The names this record settles, and the gate that holds its versions, met the Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)). Each round's objections, each
with its answer:

### On the names

| Objection                                                                                                                         | Answer                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bead` is taken on npm, PyPI and crates.io, and a memory tool for coding agents goes by Beads                                     | Accepted in part: the protocol keeps its name, and the builder's command is `beadc`.                                                                                                                  |
| npm's scope is the owner's, and NuGet has no scopes                                                                               | Accepted as a rule: the C# packages are `FrancisDesjardins.Bead.*`, and their assemblies and namespaces stay `Bead.*`.                                                                                |
| A prefix against a platform's names holds once, in `BeadHttpClient`, and `HealthStatus` collides with ASP.NET's (CS0104)          | Accepted for the builder: the C# it generates qualifies every type as `global::Bead.`. Nothing else is renamed.                                                                                       |
| The builder's protobuf package and extension numbers belong in protobuf's global registry                                         | Accepted: from their first publication, the image's, not at v1 ([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s second round).                         |
| "Nothing is published" does not hold: the demo carries the name, and names are due at the first publication, not the first commit | Accepted: the repository is kept as if it were published.                                                                                                                                             |
| Another name for the protocol, one free on every registry                                                                         | Refused: the name weighed sounds like a binary WebSocket library in the same languages; the names Bead publishes under are qualified by their owner, and free; and a rename is a decision of its own. |
| another npm scope                                                                                                                 | Refused: an account can become an organization.                                                                                                                                                       |
| another media type than `application/prs.bead`                                                                                    | Refused: RFC 6838's personal tree fits it.                                                                                                                                                            |
| another namespace than `Bead` in `Bead.Core`                                                                                      | Refused: a library's namespace is its name, as Polly's is `Polly`.                                                                                                                                    |
| one spelling of WebSocket across the sides                                                                                        | Refused: `ws` and `WS` are each language's idiom.                                                                                                                                                     |

### On the release's versions and their gate

| Objection                                                                                                                                                                                                            | Answer                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On `main`, a document's first own tag at HEAD leaves no tag before it, so the gate reads no last release and passes a spec the release left unmoved, or moved past its successor                                     | Accepted, through the next row: a document's last release is read from the `v*` tags alone, so its own tag at HEAD changes nothing, and there is no second code path for the first release.                                                                                                                                                                   |
| The gate trusts the documents' tags: one set or moved by hand redefines "changed since", and the gate checks their names, never their places                                                                         | Accepted: a document's last release is the newest `v*` before the commit whose tree holds it, at the version that tree states, or at that `v*`'s own when it states none. `spec-v*` and `debugging-v*` are outputs that the gate checks by name and by place, each at the oldest `v*` that gives its version.                                                 |
| The release leaves the C# lock files' project ranges at the old version, which a locked restore accepts and the next unrelated restore rewrites                                                                      | Accepted: `prepare` moves every project range of every `packages.lock.json` as text, with no third toolchain at the root ([0005](0005-a-toolchain-per-language.md)), and the gate holds, on every ref, each range at `<Version>`.                                                                                                                             |
| A last release found by `git tag --merged` holds only after AVH's back-merge of the tag; Driessen's text, `finish -b` and a pull request merge the release branch, and the next release is refused                   | Accepted: a `v*` is reached when its commit, or that commit's second parent, is an ancestor of the commit judged, as AVH itself finds the release branch; the gate diffs against the tag's tree.                                                                                                                                                              |
| The back-merge files `develop`'s new entries under the released version, in silence, and nothing gates the CHANGELOG though [0009](0009-conventional-commits-git-flow-and-the-tenth-man.md) makes its release a rule | Accepted: on every ref, a released section equals that section in its tag's tree, so a released section stays as shipped; on a release, `[Unreleased]` is empty, the version's section is dated and holds an entry, and both links compare the right tags. The entries' wording stays with review.                                                            |
| `prepare` runs once, at the bump, while a release branch lives on after it; and it dates the release in UTC                                                                                                          | Accepted: `prepare` reads every fact from the last release and the tree, so it runs again right before the finish, re-dating, regenerating and checking. It dates in local time, the day the tag carries. On a release branch, once its version is dated, a change tells its line under that version, and `prepare` refuses an `[Unreleased]` that holds one. |
| The flow lets CI first judge a release on `main`, after its tag; a push in parts lands `main` without its tags; and `prepare`'s Python and `node_modules` exceed a root tool                                         | Accepted: the release branch is published, and CI judges the release commit, every job, before the finish; the push is one `git push --atomic`; `main` fails when no `v*` tags its HEAD. `prepare` needs only the generators' Python, and names any check whose tool is absent, with the CI job that holds it.                                                |
| `tag`'s default looks for a `v*` at HEAD, which the finish leaves on `develop`; and git-flow's post-finish hook, which AVH runs before `-p`'s push, is the one way `finish -p` carries the documents' tags           | Accepted in part: `tag` takes the newest `v*` in the repository, refused unless `main` reaches it. Refused: the hook. `-p` pushes `develop`, `main` and then `--tags`, every local tag, neither atomic nor only the release's, and a hook is a clone's own configuration. One `tag` and one atomic push hold the release in every clone.                      |
| Line endings: `.gitattributes` holds git's blobs at LF, not the working tree the scripts read                                                                                                                        | Accepted: both scripts read the working tree's text with LF.                                                                                                                                                                                                                                                                                                  |
| Part of the minor-or-patch choice is in the diff: a file, a group or a field added                                                                                                                                   | Accepted as a floor: a conformance file, a top-level key of one, or a property of its schemas added since the last release holds the document's move to its minor at least, as axis 2 counts those additions; any other change takes either, and review holds that half.                                                                                      |
