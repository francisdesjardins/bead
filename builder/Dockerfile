# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# ── beadc's image ─────────────────────────────────────────────────────────────────────────────────
# beadc, Bead's builder, as it runs from builder/ on Node, in an image that only generates (decision
# 0022). Built from the repository's root, since beadc's tests read spec/ and the files of each side
# they hold the generated code to:
#
#   docker build -f builder/Dockerfile --target test .   # beadc's tests in the image, protoc required
#   docker build -f builder/Dockerfile -t beadc .        # the image
#
# The image is distroless: Node on Debian 13's C and C++ runtimes, from Google's distroless
# nodejs26-debian13 image, with no shell, no package manager, no npm and no Corepack. Every tool it
# runs is a static binary or Node's own code: buf, protoc and protoc-gen-buffa are static, and beadc
# runs buf's package by Node and protoc-gen-es in its own process.
#
# Stages: node, the base's debug variant, the same Node beside BusyBox's shell, for the stages that
# build; deps, every package of the lock; protoc, the pin's archive for this platform, its sha256
# checked by fetch-protoc.mjs; protoc-gen-buffa, the pin's binary for this platform, its sha256
# checked by fetch-protoc-gen-buffa.mjs; production, the runtime's packages and the licences of what
# the image adds; image, what ships; test, beadc's tests laid over the image; and the image again,
# last, so a plain build gives it and runs no test.

# ! the frontend and the base by their digests: one Dockerfile dialect on every engine, and the
# base named once, for its FROM and its labels. The base's tag names Node's major alone, so the test
# stage holds its Node to NODE_VERSION. A release bumps the frontend and both of the base's digests
# by hand, and with them shellcheck's in ci.yml and BuildKit's and buildx's in image.yml
ARG BASE=gcr.io/distroless/nodejs26-debian13
ARG BASE_DIGEST=sha256:a84242e747fbb5aaaa0180c273b6f7130ca34b3300082192ef58eea96089eb3c
ARG DEBUG_DIGEST=sha256:401369b7178ceba4ff2c63bc75a12ad8412de57dbadc78986b51ede62fd9f28f
ARG NODE_VERSION=26.13.1
# ! the licences of what the image adds to its base, its label's expression, which
# tools/licenses.mjs holds every package to; the base's own are its, under base.name, Node's at
# /nodejs/LICENSE and the rest under /usr/share/doc
ARG LICENSES="Apache-2.0 AND BSD-3-Clause AND ISC AND MIT"

# the stages that build: BusyBox's shell, and Node, which the base keeps off its path
FROM ${BASE}:debug@${DEBUG_DIGEST} AS node
SHELL ["/busybox/sh", "-c"]
ENV PATH=/nodejs/bin:${PATH}
# the folder protoc and protoc-gen-buffa are moved to, which the base lacks
RUN mkdir -p /opt

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
# ! at its place beside builder/, as the fetch tools import it by its relative path
COPY tools/fetch-pinned.mjs /bead/tools/
RUN node tools/fetch-protoc.mjs && mv ".protoc/$(node -p "require('./protoc.json').version")" /opt/protoc

# protoc-gen-buffa, by its one pin, which writes a Rust output's messages (decision 0051):
# fetch-protoc-gen-buffa.mjs reads protoc-gen-buffa.json, takes this platform's binary and checks its
# sha256 before it writes it as an executable or runs it
FROM node AS protoc-gen-buffa
WORKDIR /bead/builder
COPY builder/protoc-gen-buffa.json ./
COPY builder/tools/fetch-protoc-gen-buffa.mjs tools/
COPY tools/fetch-pinned.mjs /bead/tools/
RUN node tools/fetch-protoc-gen-buffa.mjs \
    && mv ".protoc-gen-buffa/$(node -p "require('./protoc-gen-buffa.json').version")" /opt/protoc-gen-buffa

# the runtime's packages alone, and the licence texts of everything the image adds to its base
FROM deps AS production
ARG LICENSES
COPY LICENSE /bead/LICENSE
COPY builder/licenses/ licenses/
COPY builder/tools/licenses.mjs tools/
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    node .yarn/releases/yarn-4.18.1.cjs workspaces focus --production \
    && node tools/licenses.mjs /opt/bead/licenses "$LICENSES"

# the image: Node, beadc, buf, protoc-gen-es, protoc and its well-known types, protoc-gen-buffa,
# bead/options.proto, the wrappers, the files of spec/ beadc reads at their places beside it, and the
# licences
FROM ${BASE}:nonroot@${BASE_DIGEST} AS image
ARG BASE
ARG BASE_DIGEST
ARG LICENSES
LABEL org.opencontainers.image.source=https://github.com/francisdesjardins/bead \
      org.opencontainers.image.title=beadc \
      org.opencontainers.image.description="beadc, Bead's builder: a .proto to a blueprint, and a typed server and client from it" \
      org.opencontainers.image.licenses="${LICENSES}" \
      org.opencontainers.image.base.name=${BASE}:nonroot \
      org.opencontainers.image.base.digest=${BASE_DIGEST}
COPY --from=production /bead/builder/node_modules/ /opt/bead/builder/node_modules/
COPY --from=production /opt/bead/licenses/ /opt/bead/licenses/
COPY builder/package.json builder/protoc.json builder/protoc-gen-buffa.json /opt/bead/builder/
COPY builder/proto/ /opt/bead/builder/proto/
COPY builder/wrappers/ /opt/bead/builder/wrappers/
COPY --exclude=**/__tests__ builder/src/ /opt/bead/builder/src/
COPY spec/spec.md /opt/bead/spec/
COPY spec/schemas/common.schema.json spec/schemas/bead-blueprint.schema.json /opt/bead/spec/schemas/
COPY --from=protoc /opt/protoc /opt/protoc
COPY --from=protoc-gen-buffa /opt/protoc-gen-buffa /opt/protoc-gen-buffa
# ! a read-only root: every cache under the tmpfs the wrappers mount at /tmp. Node on the path, so
# that the entry point and an engine's --entrypoint name it as node
ENV PATH=/nodejs/bin:${PATH} \
    BEADC_PROTOC=/opt/protoc/bin/protoc \
    BEADC_PROTOC_GEN_BUFFA=/opt/protoc-gen-buffa/protoc-gen-buffa \
    HOME=/tmp XDG_CACHE_HOME=/tmp/.cache
# the base's own user, nonroot, which no host account is likely to hold: the wrappers pass the
# caller's on Linux, so a missing --user shows in a test rather than hiding behind a host's first
# account, 1000
USER 65532:65532
WORKDIR /work
# ! no init of the image's own: the wrappers pass --init, under which node, not PID 1, takes an
# interrupt and a termination
ENTRYPOINT ["node", "/opt/bead/builder/src/cli.ts"]

# beadc's tests on the image itself: its Node, its protoc and its environment, the development
# packages, the tests and the files of the repository they read laid over it
FROM image AS test
ARG NODE_VERSION
USER root
# ! the image has no shell and no env: the tests' stand-ins for protoc and protoc-gen-buffa are
# #!/bin/sh scripts, and the development packages' executables, tsgolint's that the type-aware lint
# spawns among them, are #!/usr/bin/env node scripts. BusyBox from the base's debug variant, its
# shell at /bin/sh and its env at /usr/bin/env, in this stage alone
COPY --from=node /busybox/ /busybox/
RUN ["/busybox/busybox", "ln", "-s", "/busybox/sh", "/bin/sh"]
RUN ["/busybox/busybox", "ln", "-s", "/busybox/env", "/usr/bin/env"]
ENV PATH=${PATH}:/busybox
# * the base's tag names Node's major alone: the image's Node is the pin's, or the build stops here
RUN ["node", "-e", "if (process.version !== `v${process.env.NODE_VERSION}`) { console.error(`the image's Node is ${process.version}, not v${process.env.NODE_VERSION}`); process.exit(1); }"]
WORKDIR /opt/bead
COPY spec/ spec/
COPY implementations/typescript/package.json implementations/typescript/tsconfig.base.json implementations/typescript/.oxlintrc.base.json implementations/typescript/
COPY implementations/typescript/tools/playwright-base.mjs implementations/typescript/tools/
COPY implementations/typescript/interop/generated/ implementations/typescript/interop/generated/
# the runtime the goldens import, whose types carry a deprecation to each use the consumer test lints
COPY --exclude=**/__tests__ implementations/typescript/src/ implementations/typescript/src/
COPY implementations/dotnet/.editorconfig implementations/dotnet/
COPY implementations/dotnet/interop/Bead.Interop/Generated/ implementations/dotnet/interop/Bead.Interop/Generated/
# the Rust workspace's manifest, whose requirement of Buffa's crates the plugin's pin is held to
COPY implementations/rust/Cargo.toml implementations/rust/
COPY --from=deps /bead/builder/node_modules/ builder/node_modules/
COPY builder/ builder/
ENV BEADC_PROTOC_REQUIRED=1 BEADC_PROTOC_GEN_BUFFA_REQUIRED=1 CI=1
WORKDIR /opt/bead/builder
# ! emulated, as QEMU runs arm64 on amd64, V8's WebAssembly trap handler faults inside the type
# stripping Node runs beadc through: explicit bounds checks there, the image unchanged
ARG BUILDPLATFORM
ARG TARGETPLATFORM
RUN if [ "$BUILDPLATFORM" != "$TARGETPLATFORM" ]; then export NODE_OPTIONS=--disable-wasm-trap-handler; fi; \
    node .yarn/releases/yarn-4.18.1.cjs test

FROM image
