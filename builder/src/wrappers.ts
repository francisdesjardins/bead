// ── Wrappers ──────────────────────────────────────────────────────────────────

// The wrappers a project commits to run beadc's image, `beadc.sh` for bash and `beadc.ps1` for
// PowerShell 7.6 and later, one contract for both (decision 0022). Their templates are under
// `wrappers/`, beside `src/`, the image's tag left as a token that `beadc wrapper` and `beadc init`
// fill with beadc's own version: a release moves no version of theirs (decision 0008).

// dependencies

import { readFileSync } from 'node:fs';

// constants

/** The wrappers, by the names a project commits them under. */
export const WRAPPERS = Object.freeze(['beadc.sh', 'beadc.ps1'] as const);

export type WrapperName = (typeof WRAPPERS)[number];

/** The image the wrappers run, which a release tags with beadc's version. */
export const IMAGE = 'ghcr.io/francisdesjardins/beadc';

// the token a template holds where the image's tag goes
const VERSION_TOKEN = '@BEADC_VERSION@';

const TEMPLATES = new URL('../wrappers/', import.meta.url);

// definition

/** Whether `name` is one of the wrappers' names. */
export const isWrapperName = (name: string): name is WrapperName => {
  return (WRAPPERS as readonly string[]).includes(name);
};

/** The wrapper `name`, its image's tag filled with `options.version`: ASCII, each line ended LF. */
export const wrapperText = (name: WrapperName, options: { readonly version: string }): string => {
  return readFileSync(new URL(name, TEMPLATES), 'utf8').replaceAll(VERSION_TOKEN, options.version);
};
