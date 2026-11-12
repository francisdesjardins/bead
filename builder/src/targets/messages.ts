// ── Messages ──────────────────────────────────────────────────────────────────

// Where an output's messages come from, in `beadc.yaml`'s words: a constant of its own, so that
// reading `beadc.yaml` touches no platform, the targets' generators and their versions not with it.

// types

/** Where an output's messages come from, in `beadc.yaml`'s words. */
export const Messages = Object.freeze({
  /** The target's generator of messages writes them into the output, from buf's set. */
  GENERATE: 'generate',
  /** Another generator writes them: a project's own build, or a folder of their own. */
  EXTERNAL: 'external',
} as const);

export type Messages = (typeof Messages)[keyof typeof Messages];
