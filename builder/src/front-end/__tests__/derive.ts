// ── Derive ────────────────────────────────────────────────────────────────────

// The front end's test helper: a fixture's file copied into a root of its own, its text changed —
// to CRLF, behind a byte order mark, or edited — under the test's output folder, beside builder/,
// since buf builds beadc's options and a root only from a folder that holds both. The fixtures are
// committed in LF alone.

// dependencies

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from '@playwright/test';

// constants

/** The fixtures' root, test/fixtures. */
export const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));

/** The `.proto` rule fixtures, test/proto, a root each. */
export const RULE_FIXTURES = fileURLToPath(new URL('../../../test/proto/', import.meta.url));

/** The interop's fixture, by its import path. */
export const INTEROP_PROTO = 'bead/interop/v1/interop.proto';

/** The comments fixture, by its import path. */
export const COMMENTS_PROTO = 'bead/comments/v1/comments.proto';

// definition

/** Every line ending of `text` as CRLF. */
export const toCrlf = (text: string): string => {
  return text.replaceAll('\n', '\r\n');
};

/**
 * Copies the fixture `name`, by its import path, into a root of its own named `root` under the
 * running test's output folder, its text through `change`; gives the root.
 */
export const deriveRoot = (
  name: string,
  options: { readonly root: string; readonly change: (text: string) => string }
): string => {
  const root = test.info().outputPath(options.root);
  const path = join(root, ...name.split('/'));

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, options.change(readFileSync(join(FIXTURES, ...name.split('/')), 'utf8')));
  return root;
};
