# 0055 — beadc's image is published on GitHub's container registry at each release, under beadc's version, attested and signed

- **Status**: accepted
- **Scope**: [`.github/workflows/image.yml`](../../.github/workflows/image.yml); the image
  `ghcr.io/francisdesjardins/beadc`, which
  [`builder/Dockerfile`](../../builder/Dockerfile) builds; the image the wrappers name by default,
  `builder/wrappers/`; what a team reads of it, in the builder's README and the guides, and what
  runs their verify blocks, [`tools/verify-image.mjs`](../../tools/verify-image.mjs) and
  [`.github/workflows/guides.yml`](../../.github/workflows/guides.yml). The
  image's contents and its wrappers' contract stay
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s;
  versions and names [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md)'s. The
  packages stay unpublished.

## Context

**The wrappers name an image the engine pulls.** `beadc wrapper` and `beadc init` write wrappers
that run `ghcr.io/francisdesjardins/beadc:<version>`, and an engine pulls an image it does not hold.
The image holds beadc, buf, protoc-gen-es, protoc and protoc-gen-buffa, each at its pin, and no
runtime: it is the one part of Bead a team can run without building it, and a team that builds it
from a clone names its build by `BEADC_IMAGE`.

**A pulled image is trusted by what proves where it came from.** A tag on a registry moves; a
digest names one manifest. Two proofs a reader can check without trusting the registry: GitHub's
artifact attestations, SLSA build provenance signed through Sigstore and stored beside the image as
an OCI 1.1 referrer, which `gh attestation verify` checks; and a keyless cosign signature, whose
Fulcio certificate names the workflow that signed and the ref it ran from, logged in Rekor, which
`cosign verify` checks. cosign 3 writes the signature in Sigstore's bundle format, as a referrer.

**Both proofs name the ref and the commit a run is on.** GitHub's attestation is SLSA provenance
v1 under GitHub's build type: its `externalParameters` name the workflow, its ref and its
repository, and its resolved dependencies the commit the run is on. A dispatch's input never reaches
`externalParameters`, so a run dispatched from a branch names the branch's commit, whatever tag it
is given. Fulcio's certificate names the same: the workflow at its ref, and the commit, by OID
1.3.6.1.4.1.57264.1.3, logged in Rekor.

**The digest exists only after the push.** A release's commit, which names the image's version in
the wrappers, comes before its tag, and its tag before the build. Buildx's output is not
reproducible byte for byte, so no build ahead of the push gives the digest the push will. The image
prints its own wrappers, and no image can hold its own digest.

**GitHub creates no push event for tags when more than three are pushed at once.** A release's
one push carries its `v*` and each document's tag that moved, `spec-v*`, `debugging-v*` and
`transcoding-v*`: four at most.

**The options carry 58500.** `bead/options.proto`, in the image, numbers its three extensions
58500, of the range `descriptor.proto` leaves to one organization or to experiments. An
organization whose own option holds that number on `MethodOptions` cannot compile a file that
imports Bead's: protoc 36.2 exits 1, and buf 1.73.0 exits 100
([0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)).

### Considered

- **The image by its digest in the wrappers.** Refused: the digest exists after the release's
  commit and its tag, and a wrapper the image prints cannot name the image's own digest. A commit
  after the tag that writes it into the example's wrappers would leave the tagged tree naming none.
- **A `latest` tag, or a moving `0.16` beside `0.16.0`.** Refused: a team pins one version, and a
  tag that moves gives a team another image under a name it already trusted.
- **One runner, arm64 under QEMU.** Refused: CI builds and tests each platform natively, and V8's
  WebAssembly trap handler faults under QEMU in the type stripping Node runs beadc through, which the
  test stage works around. Two native runners and an index joining their digests, as Docker
  documents a build across runners.
- **Buildx's own provenance and SBOM in the image's index.** Refused: GitHub's attestation is the
  provenance, kept beside the image, and Buildx's would add an `unknown/unknown` manifest per
  platform.
- **A dispatch from develop or main, given the tag.** Refused: its provenance and its certificate
  name the branch's commit, whose tree is not the image's, so a reader cannot bind the image to its
  tag's commit.
- **A dispatch on the tag.** Taken: the run is on the tag and its commit, as a tag's push is, and
  both proofs name them.
- **Signing with a key of the project's.** Refused: a key is a secret to keep, rotate and publish;
  keyless signing binds the signature to the workflow and its ref, which a reader checks against the
  repository.
- **Attestation alone, or the signature alone.** Refused, both kept: `gh attestation verify` needs GitHub's CLI
  and API, and `cosign verify` needs neither; each is the check one toolchain already runs.
- **The options' number of protobuf's global registry before the image**, as
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)'s
  round answered. Refused: the registry's request is public and its answer would hold the release;
  the image ships the options at 58500, at the cost Consequences states, and the number is ahead.
- **The packages on npm, NuGet and crates.io with it.** Refused: they stay ahead.
- **Docker Hub, or a registry of another host.** Refused: GHCR sits beside the repository, takes the
  workflow's own token, and links the image to its source by
  `org.opencontainers.image.source`.

## Decision

**The image, and nothing else, is published.** At each release, `image.yml` publishes
`ghcr.io/francisdesjardins/beadc:<version>`, for linux/amd64 and linux/arm64. The npm, NuGet and
crates.io packages stay unpublished, as
[0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) keeps them.

**Its tag is beadc's version.** The workflow reads the version from `builder/package.json` at the
release's tag, and refuses a tag that names another: one product version, as 0008 states. A
version's image is pushed once: the workflow refuses a version unless the registry says it is not
there, at the start and again before its push. The one index it admits there is the run's own, of
exactly the digests it built, which a failed job run again finds. No other version tag is pushed;
the attestation and the signature are referrers, which GHCR, answering no referrers API, keeps
under the tag `sha256-<index digest>`, the fallback of OCI 1.1's distribution specification.

**Each platform is built natively, and tested before it is pushed.** On `ubuntu-26.04` and
`ubuntu-26.04-arm`, from the tag's commit, checked out and asserted, the Dockerfile's test stage
runs beadc's tests on the image, then the image is pushed by its digest alone, labelled with its
version and its commit. One index joins the two digests under the version, annotated with the
repository, the version and the commit.

**The index is attested and signed.** `actions/attest-build-provenance` attests the index's digest,
the digest it pushed, read from what `imagetools create` wrote, never by its tag, and pushes the
attestation to the registry; cosign 3 signs that digest keylessly, through the run's OIDC token. A
failed job run again, which finds its own index, takes the digest from the same read that matched
the index's digests and its commit. The run prints the digest and writes it in its summary. The release's run then verifies it by the
README's block, in POSIX shell and in PowerShell, as a reader runs it.

**It runs on the tag alone**: its push, or a dispatch on the tag:

```sh
gh workflow run image.yml --ref v<version>
```

Every job builds `github.sha`, the tag's commit, and asserts it. The workflow refuses a run on any
other ref, a tag that names another commit than the run's, and a commit off `main`. A release reads
the run after its push, and dispatches it when none started.

**The wrappers name the version, and a team pins the digest.** The wrappers keep
`ghcr.io/francisdesjardins/beadc:<version>` by default, which the release moves, and the engine
pulls it. A team verifies the image, then names it by its digest in `BEADC_IMAGE`, in its CI and its
shells, by a block that binds the digest to the repository, the signer workflow, the tag and its
commit, and sets `BEADC_IMAGE` only once every check passed:

```sh
v=<version>
git clone --branch "v$v" https://github.com/francisdesjardins/bead bead-pinned
commit="$(git -C bead-pinned rev-parse HEAD)"
digest="$(docker buildx imagetools inspect "ghcr.io/francisdesjardins/beadc:$v" --format '{{.Manifest.Digest}}')"
image="ghcr.io/francisdesjardins/beadc@$digest"
[ -n "$digest" ] && [ -n "$commit" ] &&
  git -C bead-pinned merge-base --is-ancestor HEAD origin/main &&
  gh attestation verify "oci://$image" --repo francisdesjardins/bead \
    --signer-workflow francisdesjardins/bead/.github/workflows/image.yml \
    --source-ref "refs/tags/v$v" --source-digest "$commit" --deny-self-hosted-runners &&
  cosign verify "$image" \
    --certificate-identity "https://github.com/francisdesjardins/bead/.github/workflows/image.yml@refs/tags/v$v" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    --certificate-github-workflow-sha "$commit" &&
  export BEADC_IMAGE="$image"
```

```powershell
# in PowerShell 7.6 (pwsh), not Windows PowerShell
$v = '<version>'
git clone --branch "v$v" https://github.com/francisdesjardins/bead bead-pinned
$commit = git -C bead-pinned rev-parse HEAD
$digest = docker buildx imagetools inspect "ghcr.io/francisdesjardins/beadc:$v" --format '{{.Manifest.Digest}}'
$image = "ghcr.io/francisdesjardins/beadc@$digest"
if ($digest -and $commit) {
  git -C bead-pinned merge-base --is-ancestor HEAD origin/main &&
    gh attestation verify "oci://$image" --repo francisdesjardins/bead `
      --signer-workflow francisdesjardins/bead/.github/workflows/image.yml `
      --source-ref "refs/tags/v$v" --source-digest $commit --deny-self-hosted-runners &&
    cosign verify $image `
      --certificate-identity "https://github.com/francisdesjardins/bead/.github/workflows/image.yml@refs/tags/v$v" `
      --certificate-oidc-issuer https://token.actions.githubusercontent.com `
      --certificate-github-workflow-sha $commit &&
    Set-Item Env:BEADC_IMAGE $image
}
```

An image built from a clone runs the same way, by its local name in `BEADC_IMAGE`.

## Consequences

- **A team needs no clone for beadc**: the engine pulls the image the wrappers name. The runtimes
  still come from a clone at the release's tag, so the generated code and its runtime are one
  release.
- **The default is a tag**, which the registry could move: the wrappers do not verify what they
  pull. A team that pins the digest runs what it verified.
- **Every image's identity is `image.yml` at its tag and that tag's commit**; 0.16.0's alone is
  develop's, at `576bf111`, its tag older than the workflow. Its block, in the getting-started
  guide, names that identity and holds the index's revision annotation to the tag's commit.
- **The proofs hold as far as write access to the repository and the package is kept.** The
  workflow refuses a tag whose commit is off `main`, against a mistaken tag; a writer could remove
  that check, so a verifier who wants the ancestry holds it, as the block's `merge-base` line does.
- **Verifying the signature takes cosign 3**, or cosign 2.6 with `--new-bundle-format`: an earlier
  cosign finds no signature.
- **A public image carries 58500**, the options' number, so an organization whose own option holds
  it cannot import Bead's options. Their number of protobuf's global registry is ahead, the one
  constant, three lines and the generated code
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)
  counts.
- **A version's image is never rebuilt.** A fix to the image is a new release, and so is a fault
  in the workflow found after a tag. A run that fails before the index is pushed is dispatched
  again on the tag; one that fails after it, at the attestation, the signature or the verification,
  has its failed job run again, `gh run rerun <run> --failed`, from the digests its builds kept for
  a week, since a new dispatch refuses the version the registry holds.
- **BuildKit and buildx are pinned**, BuildKit by its version and its digest, buildx by its version,
  and a release moves them with the base's digests.
- **Each release pays two builds**, a platform's on a runner of its own, its test stage included.
- **Its gates**: none is a pull request's. CI's image legs build and test the image on every push
  ([0006](0006-a-rule-has-its-gate.md)). `image.yml` refuses a run off a release's tag, a tag that
  names another commit than the run's, a commit off `main`, a version off the tag, a version already
  published and a registry that does not say it is not; it builds the commit it asserted, fails
  without both platforms' digests or when the tag resolves to another digest than the one pushed,
  and ends by running the README's block, by
  [`tools/verify-image.mjs`](../../tools/verify-image.mjs), against the index it signed.
  [`guides.yml`](../../.github/workflows/guides.yml) runs the getting-started guide's block the same
  way on every push that changes it, the README's block or the tool, and the `commits` job runs the
  tool's tests. That job also holds the workflows' actions to their commits' full sha, and
  Dependabot's `github-actions` entry moves them.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md))
once, at xhigh effort, in a round on the image built from its tag shared with
[0026](0026-a-server-tells-each-refusal-it-judges-and-a-client-names-the-one-it-reads.md),
[0054](0054-a-client-connects-the-loopbacks-names-to-the-loopback-itself-through-no-resolver-and-no-proxy.md)
and [0056](0056-a-websocket-server-holds-a-message-partway-to-a-budget-and-a-rate-and-every-side-reads-its-frames-at-their-heads.md),
each of which keeps its own objections. Each claim was checked against the workflow and by probes
of `gh attestation verify` and of each shell. Three objections here: two accepted, one of them
carried further, and one in part, none refused. No question went to the user. The objections, with
the answers that hold:

### On the image built from its tag

| Objection                                                                                                                                                                                                                                                                                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1.** The guide's verify block is pasted without `set -eu` or `$ErrorActionPreference`, so a failed `gh` or `cosign` check, or an empty digest, still exports `BEADC_IMAGE`, and the guide's next steps pull it. Chain the export behind both checks, in POSIX shell and PowerShell 7, the export a command after `&&`. | **Accepted, and carried further.** A probe of each shell showed the export after two failed checks unchained, and none chained. A further probe found one more hole: `gh attestation verify` with `--source-digest ""` exits 0, an empty digest read as unset, so a failed clone would leave the commit unchecked. The chain guards the commit beside the digest, and the guide says `BEADC_IMAGE` is set only once every check passes.                                                                                                                                   |
| **O2.** Every cosign line the guide states is unrun, and the proposal's own `gh` output is empty. Make it a gate: the publish job ends by running the guide's block against the digest it signed; a `ci.yml` job runs 0.16.0's block on the branch's push; the quoted output comes from that run.                         | **In part.** `gh attestation verify` of 0.16.0's index under its identity exits 0, and under another exits 1. The gate is taken. But the guide's block is 0.16.0's exception, which no image built on its tag passes, so the publish job runs the builder's README's general block, set to its version, by `tools/verify-image.mjs`. 0.16.0's block runs in `guides.yml`, a workflow filtered on the guide's, the README's and the tool's paths, not a `ci.yml` job that would ask the registry and Sigstore on every push. The guide's quoted output comes from its run. |
| **O3.** The ancestry check in `image.yml` guards against a mistaken tag, not the proofs: a writer who tags a commit off `main` can remove it from that commit's file. Saying "a tag's commit is on main" presents it as a property of the proofs.                                                                         | **Accepted.** A tag runs its own commit's `image.yml`; `v0.16.0` is on `main`, and develop's `576bf111` is not. The record says the workflow refuses a tag off `main` against a mistake, and that the proofs come down to write access. The block holds the ancestry for a verifier: `git -C bead-pinned merge-base --is-ancestor HEAD origin/main`.                                                                                                                                                                                                                      |
