// ── Options ───────────────────────────────────────────────────────────────────

// What a C# output asks of the target, in `beadc.yaml`'s words: the namespace of a service a
// blueprint alone declares, and where its messages come from, protoc writing them for `generate`,
// a project's own build compiling them for `external`, named by their namespace either way. It
// imports no module of the target's, so `config.ts` reads it without loading the target.

// dependencies

import type { IHttpInput, Messages } from '../target.ts';

// types

/** What a C# output asks of the target. */
export interface ICSharpOptions {
  /**
   * The namespace of a service a blueprint alone declares; a service a `.proto` declares takes its
   * file's, its `csharp_namespace` or its package in Pascal case, as protoc's C# generator does.
   */
  readonly namespace?: string;
  readonly messages: Messages;
  /** For an output with `http: true`: what its route table holds (decision 0037). */
  readonly http?: IHttpInput;
}

// constants

/** A namespace as `beadc.yaml` names one: C# identifiers of ASCII letters, digits and `_`, by dots. */
export const NAMESPACE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
