# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# ── beadc's image ─────────────────────────────────────────────────────────────────────────────────
# beadc, Bead's builder, as it runs from builder/ on Node, in an image that only generates (decision
# 0022). Built from the repository's root, since beadc's tests read spec/ and the files of each side
# they hold the generated code to:
#
#   docker build -f builder/Dockerfile --target test .   # beadc's tests in the image, protoc required
#   docker build -f builder/Dockerfile -t beadc .        # the image
#
# Stages: deps, every package of the lock; protoc, the pin's archive for this platform, its sha256
# checked by fetch-protoc.mjs; production, the runtime's packages and the licences of what the image
# adds; image, what ships; test, beadc's tests laid over the image; and the image again, last, so a
# plain build gives it and runs no test.

# ! the frontend and the base by their digests: one Dockerfile dialect on every engine, and the
# base named once, for its FROM and its labels. A release bumps both by hand, and shellcheck's in
# ci.yml with them
ARG NODE_IMAGE=node:26.12.1-trixie-slim
ARG NODE_DIGEST=sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec
# ! the licences of what the image adds to its base, its label's expression, which
# tools/licenses.mjs holds every package to; the base's own are its, under base.name and
# /usr/share/doc
ARG LICENSES="Apache-2.0 AND BSD-3-Clause AND ISC AND MIT"
FROM ${NODE_IMAGE}@${NODE_DIGEST} AS node

# every package the lock names, this platform's buf among them
FROM node AS deps
WORKDIR /bead/builder
COPY builder/package.json builder/yarn.lock builder/.yarnrc.yml ./
COPY builder/.yarn/releases/ .yarn/releases/
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    node .yarn/releases/yarn-4.18.1.cjs install --immutable

# protoc, by its one pin: fetch-protoc.mjs reads protoc.json, takes this platform's archive and
# checks its sha256 before it reads a byte of it
FROM node AS protoc
WORKDIR /bead/builder
COPY builder/protoc.json ./
COPY builder/tools/fetch-protoc.mjs tools/
RUN node tools/fetch-protoc.mjs && mv ".protoc/$(node -p "require('./protoc.json').version")" /opt/protoc

# the runtime's packages alone, and the licence texts of everything the image adds to its base
FROM deps AS production
ARG LICENSES
COPY LICENSE /bead/LICENSE
COPY builder/licenses/ licenses/
COPY builder/tools/licenses.mjs tools/
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    node .yarn/releases/yarn-4.18.1.cjs workspaces focus --production \
    && node tools/licenses.mjs /opt/bead/licenses "$LICENSES"

# the image: Node, beadc, buf, protoc-gen-es, protoc and its well-known types, bead/options.proto,
# the wrappers, the files of spec/ beadc reads at their places beside it, and the licences
FROM node AS image
ARG NODE_IMAGE
ARG NODE_DIGEST
ARG LICENSES
LABEL org.opencontainers.image.source=https://github.com/francisdesjardins/bead \
      org.opencontainers.image.title=beadc \
      org.opencontainers.image.description="beadc, Bead's builder: a .proto to a blueprint, and a typed server and client from it" \
      org.opencontainers.image.licenses="${LICENSES}" \
      org.opencontainers.image.base.name=docker.io/library/${NODE_IMAGE} \
      org.opencontainers.image.base.digest=${NODE_DIGEST}
COPY --from=production /bead/builder/node_modules/ /opt/bead/builder/node_modules/
COPY --from=production /opt/bead/licenses/ /opt/bead/licenses/
COPY builder/package.json builder/protoc.json /opt/bead/builder/
COPY builder/proto/ /opt/bead/builder/proto/
COPY builder/wrappers/ /opt/bead/builder/wrappers/
COPY --exclude=**/__tests__ builder/src/ /opt/bead/builder/src/
COPY spec/spec.md /opt/bead/spec/
COPY spec/schemas/common.schema.json spec/schemas/bead-blueprint.schema.json /opt/bead/spec/schemas/
COPY --from=protoc /opt/protoc /opt/protoc
# ! a read-only root: every cache under the tmpfs the wrappers mount at /tmp
ENV BEADC_PROTOC=/opt/protoc/bin/protoc HOME=/tmp XDG_CACHE_HOME=/tmp/.cache
# a user no host account is likely to hold: the wrappers pass the caller's on Linux, so a missing
# --user shows in a test rather than hiding behind a host's first account, 1000
USER 65532:65532
WORKDIR /work
# ! no init of the image's own: the wrappers pass --init, under which node, not PID 1, takes an
# interrupt and a termination
ENTRYPOINT ["node", "/opt/bead/builder/src/cli.ts"]

# beadc's tests on the image itself: its Node, its protoc and its environment, the development
# packages, the tests and the files of the repository they read laid over it
FROM image AS test
USER root
WORKDIR /opt/bead
COPY spec/ spec/
COPY implementations/typescript/package.json implementations/typescript/tsconfig.base.json implementations/typescript/.oxlintrc.base.json implementations/typescript/
COPY implementations/typescript/tools/playwright-base.mjs implementations/typescript/tools/
COPY implementations/typescript/interop/generated/ implementations/typescript/interop/generated/
# the runtime the goldens import, whose types carry a deprecation to each use the consumer test lints
COPY --exclude=**/__tests__ implementations/typescript/src/ implementations/typescript/src/
COPY implementations/dotnet/.editorconfig implementations/dotnet/
COPY implementations/dotnet/interop/Bead.Interop/Generated/ implementations/dotnet/interop/Bead.Interop/Generated/
COPY --from=deps /bead/builder/node_modules/ builder/node_modules/
COPY builder/ builder/
ENV BEADC_PROTOC_REQUIRED=1 CI=1
WORKDIR /opt/bead/builder
# ! emulated, as QEMU runs arm64 on amd64, V8's WebAssembly trap handler faults inside the type
# stripping Node runs beadc through: explicit bounds checks there, the image unchanged
ARG BUILDPLATFORM
ARG TARGETPLATFORM
RUN if [ "$BUILDPLATFORM" != "$TARGETPLATFORM" ]; then export NODE_OPTIONS=--disable-wasm-trap-handler; fi; \
    node .yarn/releases/yarn-4.18.1.cjs test

FROM image
