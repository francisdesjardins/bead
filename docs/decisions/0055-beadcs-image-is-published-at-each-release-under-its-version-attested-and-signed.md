# 0055 — beadc's image is published on GitHub's container registry at each release, under beadc's version, attested and signed

- **Status**: accepted
- **Scope**: [`.github/workflows/image.yml`](../../.github/workflows/image.yml); the image
  `ghcr.io/francisdesjardins/beadc`, which
  [`builder/Dockerfile`](../../builder/Dockerfile) builds; the image the wrappers name by default,
  `builder/wrappers/`; and what a team reads of it, in the builder's README and the guides. The
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
version's image is pushed once: the workflow refuses a version the registry holds. No other tag is
pushed.

**Each platform is built natively, and tested before it is pushed.** On `ubuntu-26.04` and
`ubuntu-26.04-arm`, from the tag's checkout, the Dockerfile's test stage runs beadc's tests on the
image, then the image is pushed by its digest alone, labelled with its version and its commit. One
index joins the two digests under the version, annotated with the repository, the version and the
commit.

**The index is attested and signed.** `actions/attest-build-provenance` attests the index's digest
and pushes the attestation to the registry; cosign 3 signs the digest keylessly, through the run's
OIDC token. The run prints the digest and writes it in its summary.

**It runs on the tag, or by hand for a tag.** The push of a `v*` tag starts it; `workflow_dispatch`
starts it from `develop` or `main`, given a tag:

```sh
gh workflow run image.yml --ref develop -f tag=v<version>
```

A release reads the run after its push, and dispatches it when none started.

**The wrappers name the version, and a team pins the digest.** The wrappers keep
`ghcr.io/francisdesjardins/beadc:<version>` by default, which the release moves, and the engine
pulls it. A team verifies the image, then names it by its digest in `BEADC_IMAGE`, in its CI and its
shells:

```sh
gh attestation verify oci://ghcr.io/francisdesjardins/beadc:<version> --owner francisdesjardins
cosign verify ghcr.io/francisdesjardins/beadc:<version> \
  --certificate-identity-regexp '^https://github\.com/francisdesjardins/bead/\.github/workflows/image\.yml@refs/(tags/v[0-9]+\.[0-9]+\.[0-9]+|heads/(develop|main))$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
docker buildx imagetools inspect ghcr.io/francisdesjardins/beadc:<version>   # its Digest
export BEADC_IMAGE=ghcr.io/francisdesjardins/beadc@sha256:<digest>
```

An image built from a clone runs the same way, by its local name in `BEADC_IMAGE`.

## Consequences

- **A team needs no clone for beadc**: the engine pulls the image the wrappers name. The runtimes
  still come from a clone at the release's tag, so the generated code and its runtime are one
  release.
- **The default is a tag**, which the registry could move: the wrappers do not verify what they
  pull. A team that pins the digest runs what it verified.
- **A dispatched run's identity is its branch's.** The certificate and the provenance name
  `image.yml` at `refs/heads/develop` or `main` and that branch's commit; the image's labels and
  annotations name the tag's commit. The identity `cosign verify` takes admits both.
- **Verifying the signature takes cosign 3**, or cosign 2.6 with `--new-bundle-format`: an earlier
  cosign finds no signature.
- **A public image carries 58500**, the options' number, so an organization whose own option holds
  it cannot import Bead's options. Their number of protobuf's global registry is ahead, the one
  constant, three lines and the generated code
  [0022](0022-a-proto-becomes-one-checked-blueprint-and-each-language-is-generated-from-it.md)
  counts.
- **A version's image is never rebuilt.** A fix to the image is a new release; a failed run before
  the index is pushed is run again by hand.
- **Each release pays two builds**, a platform's on a runner of its own, its test stage included.
- **Its gates**: none is a pull request's. CI's image legs build and test the image on every push
  ([0006](0006-a-rule-has-its-gate.md)); `image.yml` refuses a tag that is no release's, a version
  off the tag and a version already published, and fails without both platforms' digests. The
  `commits` job holds its actions to their commits' full sha, and Dependabot's `github-actions`
  entry moves them.
