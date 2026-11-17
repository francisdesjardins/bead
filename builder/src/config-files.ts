// ── Config, on disk ───────────────────────────────────────────────────────────

// What reading `beadc.yaml` asks of the platform, apart from `config.ts`, which touches none: the
// nearest `beadc.yaml`, upward.

// dependencies

import { existsSync } from 'node:fs';
import nodePath from 'node:path';

import { CONFIG_FILE } from './config.ts';

// definition

/** The `beadc.yaml` nearest `from`, upward, or none. */
export const findConfig = (from: string): string | undefined => {
  for (let folder = nodePath.resolve(from); ;) {
    const candidate = nodePath.join(folder, CONFIG_FILE);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = nodePath.dirname(folder);

    if (parent === folder) {
      return undefined;
    }

    folder = parent;
  }
};
