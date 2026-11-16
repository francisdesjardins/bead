// ── Work area ─────────────────────────────────────────────────────────────────

// Where a run of beadc works: one folder of its own under the system's temporary folder,
// `beadc/<id>`, its id mkdtemp's, made on first use and removed as the process exits, a signal's
// exit included. Nothing of a run is written in the project. Each area holds a marker, its process's
// pid and start time, as JSON; each run first sweeps the stale areas, a dead process's or, without a
// marker, one older than a bound, and `beadc clean` sweeps them on demand. An area of a live process
// is never touched.

// dependencies

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

// types

/** A work area a sweep removed: its folder, and the bytes its files held. */
export interface ISweptArea {
  readonly path: string;
  readonly bytes: number;
}

// what a marker holds
interface IMarker {
  readonly pid: number;
  readonly started: string;
}

// constants

/** The folder under the system's temporary folder that holds every run's work area. */
export const WORK_AREAS = 'beadc';

/** The file in each work area that names its process: its pid and its start time, as JSON. */
export const MARKER_FILE = 'run.json';

/** How old an area without a readable marker grows before a sweep removes it: a day. */
export const STALE_AFTER = 24 * 60 * 60 * 1000;

/**
 * How old an area without a readable marker must be before even `clean --all` removes it: a run
 * makes its area, then writes its marker.
 */
export const NEWBORN = 60 * 1000;

// the prefix of every area's name, before mkdtemp's id
const AREA_PREFIX = 'run-';

// how a removal meets a file another process holds a moment, as an antivirus does on Windows
const REMOVAL = Object.freeze({ recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

// how many times the areas' folder is made again, another process or a user removing it
const AREA_ATTEMPTS = 3;

// what a removal answers when another run removes the same folder, works in it or holds it open:
// Windows answers EPERM to a folder another process is removing, and EBUSY to one it holds
const CONTENDED = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY']);

// what a sweep leaves for the next one, another user's area among them
const LEFT = new Set([...CONTENDED, 'EACCES']);

// ! the areas' folder, as the system's temporary folder is, where users share it: anyone makes an
// area in it, and only its owner removes one
const SHARED = 0o1777;

// the signals that end a run, Windows' Ctrl+Break and console close among them
const ENDING_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];

// state

// this process's area, once made
let own: string | undefined;

// helpers

const codeOf = (error: unknown): string => {
  return (error as NodeJS.ErrnoException).code ?? '';
};

// whether `error` is another run's removal or hold of the same folder
const isContended = (error: unknown): boolean => {
  return CONTENDED.has(codeOf(error));
};

/** The folder that holds every run's work area, under the system's temporary folder. */
export const workAreasFolder = (): string => {
  return join(tmpdir(), WORK_AREAS);
};

// whether `pid` names a running process: a signal 0 delivered, or refused for want of the right
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return codeOf(error) === 'EPERM';
  }
};

// the marker of `area`, or none where it is missing or unreadable
const markerOf = (area: string): IMarker | undefined => {
  try {
    const marker = JSON.parse(readFileSync(join(area, MARKER_FILE), 'utf8')) as Partial<IMarker>;

    return Number.isSafeInteger(marker.pid) &&
      (marker.pid ?? 0) > 0 &&
      typeof marker.started === 'string'
      ? (marker as IMarker)
      : undefined;
  } catch {
    return undefined;
  }
};

// whether `area` is stale: a marker whose process no longer runs, or, without a marker, a folder
// `options.modified` older than the bound, or than a newborn's under `--all`
const isStale = (
  area: string,
  options: { readonly all: boolean; readonly now: number; readonly modified: number }
): boolean => {
  const marker = markerOf(area);

  if (marker !== undefined) {
    return !isRunning(marker.pid);
  }

  const age = options.now - options.modified;

  return age > (options.all ? NEWBORN : STALE_AFTER);
};

// the bytes the files under `folder` hold, never following a link; a file another run removes
// counts nothing
const bytesUnder = (folder: string): number => {
  let bytes = 0;

  try {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);

      if (entry.isDirectory()) {
        bytes += bytesUnder(path);
      } else {
        try {
          bytes += lstatSync(path).size;
        } catch (error) {
          if (!isContended(error)) {
            throw error;
          }
        }
      }
    }
  } catch (error) {
    if (!isContended(error)) {
      throw error;
    }
  }

  return bytes;
};

// ! the marker goes last: an area removed halfway keeps it, and the next sweep finds it stale
const removeArea = (area: string): void => {
  for (const entry of readdirSync(area)) {
    if (entry !== MARKER_FILE) {
      rmSync(join(area, entry), REMOVAL);
    }
  }

  rmSync(join(area, MARKER_FILE), REMOVAL);
  rmdirSync(area);
};

// the areas' folder, made; a removal of it between mkdir and mkdtemp is met again
const madeArea = (): string => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const made = mkdirSync(workAreasFolder(), { recursive: true });

      if (made !== undefined && process.platform !== 'win32') {
        chmodSync(workAreasFolder(), SHARED);
      }

      return mkdtempSync(join(workAreasFolder(), AREA_PREFIX));
    } catch (error) {
      if (codeOf(error) !== 'ENOENT' || attempt === AREA_ATTEMPTS) {
        throw error;
      }
    }
  }
};

// definition

/**
 * This process's work area, made on first use, its marker written, and removed as the process
 * exits.
 */
export const workArea = (): string => {
  if (own !== undefined) {
    return own;
  }

  const area = madeArea();
  const marker: IMarker = { pid: process.pid, started: new Date().toISOString() };

  writeFileSync(join(area, MARKER_FILE), `${JSON.stringify(marker)}\n`);
  own = area;
  process.once('exit', removeWorkArea);

  return area;
};

/** A temporary folder of beadc's, made in this process's work area. The caller takes it out. */
export const temporaryFolderOf = (prefix: string): string => {
  return mkdtempSync(join(workArea(), prefix));
};

/**
 * Removes this process's work area, where it made one. Never throws: what a removal leaves keeps
 * its marker, and the next sweep removes it.
 */
export const removeWorkArea = (): void => {
  const area = own;

  if (area === undefined) {
    return;
  }

  own = undefined;
  process.removeListener('exit', removeWorkArea);

  try {
    removeArea(area);
  } catch {
    // * the marker kept, the next run's sweep finds the area stale once this process is gone
  }
};

/**
 * Removes the work area as a signal ends the run, Ctrl+C on Windows among them, then exits as the
 * signal would, 128 and its number. For beadc's command line: a library leaves the signals alone.
 */
export const removeWorkAreaOnSignals = (): void => {
  for (const signal of ENDING_SIGNALS) {
    process.once(signal, () => {
      removeWorkArea();
      process.exit(128 + constants.signals[signal]);
    });
  }
};

/**
 * Removes every stale work area: one whose process no longer runs, and one without a readable
 * marker older than {@link STALE_AFTER}, or, under `all`, than {@link NEWBORN}; never this
 * process's, nor a running process's, nor a link. Gives each area removed. Tolerates another run
 * removing the same areas, or holding one, and another user's area: what it cannot remove is left
 * for the next sweep.
 */
export const sweepWorkAreas = (options: { readonly all?: boolean } = {}): ISweptArea[] => {
  const folder = workAreasFolder();
  const now = Date.now();
  const swept: ISweptArea[] = [];
  let names: string[];

  try {
    // ! a link in its place is never followed: what it names is not beadc's to remove
    names = lstatSync(folder).isDirectory() ? readdirSync(folder) : [];
  } catch (error) {
    if (LEFT.has(codeOf(error))) {
      return [];
    }

    throw error;
  }

  for (const name of names) {
    const area = join(folder, name);

    if (area === own || !name.startsWith(AREA_PREFIX)) {
      continue;
    }

    try {
      // ! an area is a folder, never a link to one, whose target a removal would empty
      const found = lstatSync(area);

      if (
        !found.isDirectory() ||
        !isStale(area, { all: options.all === true, now, modified: found.mtimeMs })
      ) {
        continue;
      }

      const bytes = bytesUnder(area);

      removeArea(area);
      swept.push({ path: area, bytes });
    } catch (error) {
      if (!LEFT.has(codeOf(error))) {
        throw error;
      }
    }
  }

  return swept;
};
