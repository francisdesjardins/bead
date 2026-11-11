// ── Config, on disk ───────────────────────────────────────────────────────────

// What reading `beadc.yaml` asks of the platform, apart from `config.ts`, which touches none: the
// nearest `beadc.yaml`, upward, and the temporary folders beadc keeps beside it.

// dependencies

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { BEADC_FOLDER, CONFIG_FILE } from './config.ts';

// constants

const WORKSPACE_ATTEMPTS = 3;

// definition

/**
 * A temporary folder of beadc's, made: under `options.folder`'s `.beadc/` where a `beadc.yaml` was
 * read; under the system's temporary folder otherwise. The caller takes it out.
 */
export const temporaryFolderOf = (
  prefix: string,
  options: { readonly folder?: string } = {}
): string => {
  if (options.folder === undefined) {
    return mkdtempSync(nodePath.join(tmpdir(), `beadc-${prefix}`));
  }

  const own = nodePath.join(options.folder, BEADC_FOLDER);

  // * an empty-parent cleanup can land between mkdir and mkdtemp; retry just that race.
  for (let attempt = 1; ; attempt += 1) {
    mkdirSync(own, { recursive: true });

    try {
      return mkdtempSync(nodePath.join(own, prefix));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === WORKSPACE_ATTEMPTS) {
        throw error;
      }
    }
  }
};

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
