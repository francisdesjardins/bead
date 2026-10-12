// ── Options ───────────────────────────────────────────────────────────────────

// What a TypeScript output asks of the target, in `beadc.yaml`'s words: the extension its relative
// imports name, the runtime it imports, and where its messages come from, protoc-gen-es writing them
// in beadc's process for `generate`. It imports no module of the target's, so `config.ts` reads it
// without loading the target, which loads a compiler.

// dependencies

import type { Messages } from '../target.ts';

// types

/** The extension a generated file's relative imports name: none, `.js` or `.ts`. */
export type ImportExtension = 'none' | 'js' | 'ts';

/** What a TypeScript output asks of the target. */
export interface ITypeScriptOptions {
  readonly importExtension: ImportExtension;
  /**
   * The module the generated files import the runtime from: a package's name, kept as given, or a
   * path relative to the output's folder, without its extension, which each file imports at its
   * depth.
   */
  readonly runtime: string;
  readonly messages: Messages;
  /** Where the messages are, relative to the output's folder, with slashes, for `external`. */
  readonly messagesOut?: string;
}

// constants

/** The runtime generated code imports when `beadc.yaml` names none: the package's service layer. */
export const DEFAULT_RUNTIME = '@francisdesjardins/bead/service';

/** The extensions `importExtension` takes, `ts` when it names none. */
export const IMPORT_EXTENSIONS: readonly ImportExtension[] = Object.freeze(['none', 'js', 'ts']);
