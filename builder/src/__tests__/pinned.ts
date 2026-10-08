// ── Pinned ────────────────────────────────────────────────────────────────────

// The tests' protoc: the one beadc finds, `BEADC_PROTOC` or the path's, at its pin's version. A test
// that runs it skips, with its reason, where there is none; with `BEADC_PROTOC_REQUIRED=1`, as CI's
// `builder` job sets it, it runs anyway and fails, since a skip there could only be a path gone
// wrong, as `BEAD_INTEROP_REQUIRED=1` holds the interop.

// dependencies

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test } from '@playwright/test';

import { findProtoc, protocPin } from '../protoc.ts';

// definition

/** Whether beadc finds protoc at its pin's version. */
export const hasPinnedProtoc = (): boolean => {
  return findProtoc()?.version === protocPin().version;
};

/** Skips the running test where no protoc of the pin's version runs, unless one is required. */
export const needsProtoc = (): void => {
  test.skip(
    !hasPinnedProtoc() && process.env['BEADC_PROTOC_REQUIRED'] !== '1',
    `no protoc ${protocPin().version}: node tools/fetch-protoc.mjs, then BEADC_PROTOC`
  );
};

/**
 * A stand-in for protoc in `folder`, a script, `protoc.cmd` on Windows, which answers `--version`
 * with `libprotoc <version>`, and anything else with `refusal` on stderr and exit 1, or nothing;
 * gives its path.
 */
export const stubProtoc = (
  folder: string,
  options: { readonly version: string; readonly refusal?: string }
): string => {
  const stub = join(folder, process.platform === 'win32' ? 'protoc.cmd' : 'protoc');
  const { version, refusal } = options;

  mkdirSync(folder, { recursive: true });

  if (process.platform === 'win32') {
    writeFileSync(
      stub,
      [
        '@echo off',
        `if "%~1"=="--version" (echo libprotoc ${version}& exit /b 0)`,
        ...(refusal === undefined ? [] : [`echo ${refusal}1>&2`, 'exit /b 1']),
        '',
      ].join('\r\n')
    );
  } else {
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then echo "libprotoc ${version}"; exit 0; fi`,
        ...(refusal === undefined ? [] : [`echo "${refusal}" >&2`, 'exit 1']),
        '',
      ].join('\n')
    );
    chmodSync(stub, 0o755);
  }

  return stub;
};

/** Runs `run` with `BEADC_PROTOC` naming `path`, then puts it back as it was. */
export const withProtoc = <T>(path: string, run: () => T): T => {
  const before = process.env['BEADC_PROTOC'];

  process.env['BEADC_PROTOC'] = path;

  try {
    return run();
  } finally {
    if (before === undefined) {
      delete process.env['BEADC_PROTOC'];
    } else {
      process.env['BEADC_PROTOC'] = before;
    }
  }
};
