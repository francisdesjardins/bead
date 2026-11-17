// ── Options ───────────────────────────────────────────────────────────────────

// What a Rust output asks of the target, in `beadc.yaml`'s words: where its messages come from,
// `protoc-gen-buffa` writing them under `messages/` for `generate`, the application's build script
// through `bead_protobuf_build::config_of` for `external`, named by their path under the output's
// `messages` root either way (decision 0051). A Rust output takes no `runtime`, `protoRuntime`,
// `namespace` nor `messagesOut`: its code names every runtime type from its crate's root, and its
// messages' root is its own. An output with a `gateway` hands it what its route table holds. It
// imports no module of the target's, so `config.ts` reads it without loading the target.

// dependencies

import type { IHttpInput, Messages } from '../target.ts';

// types

/** What a Rust output asks of the target. */
export interface IRustOptions {
  readonly messages: Messages;
  /** For an output with a `gateway`: what its route table holds (decisions 0037 and 0052). */
  readonly http?: IHttpInput;
}

// constants

/**
 * The file a Rust output's build script writes Buffa's tree into, under `OUT_DIR`, for `messages:
 * external`: the name Buffa's README gives an include file, `config_of(…).include_file(…)`'s.
 */
export const EXTERNAL_INCLUDE_FILE = '_include.rs';
