// ── Demo POSIX path ──────────────────────────────────────────────────────────

// The path a page hands `parseConfig`: POSIX's rules, `node:path.posix`'s answers, for the
// operations `builder/src/config.ts` asks of one, `join`, `resolve`, `relative`, `isAbsolute` and
// `sep`. A page has no working directory: a path no segment makes absolute resolves under `/`,
// where `node:path` would take the process's.

// dependencies

import type { PlatformPath } from 'node:path';

// constants

const SEP = '/';

// helpers

// `path` as `node:path.posix.normalize` gives it: `.` and empty segments out, each `..` taking the
// segment before it, or kept at the start of a relative path; a trailing `/` kept
const normalize = (path: string): string => {
  if (path === '') {
    return '.';
  }

  const isAbsolute = path.startsWith(SEP);
  const hasTrailing = path.endsWith(SEP);
  const segments: string[] = [];

  for (const segment of path.split(SEP)) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop();
      } else if (!isAbsolute) {
        segments.push(segment);
      }

      continue;
    }

    segments.push(segment);
  }

  const joined = segments.join(SEP);

  if (isAbsolute) {
    return `${SEP}${joined}${hasTrailing && joined !== '' ? SEP : ''}`;
  }

  if (joined === '') {
    return hasTrailing ? `.${SEP}` : '.';
  }

  return hasTrailing ? `${joined}${SEP}` : joined;
};

const isAbsolute = (path: string): boolean => {
  return path.startsWith(SEP);
};

// oxlint-disable-next-line bead/options-last -- node:path's own, as many segments as it is given
const join = (...paths: string[]): string => {
  const given = paths.filter((path) => {
    return path !== '';
  });

  return given.length === 0 ? '.' : normalize(given.join(SEP));
};

// from the last segment back to the first absolute one, under `/` where none is
// oxlint-disable-next-line bead/options-last -- node:path's own, as many segments as it is given
const resolve = (...paths: string[]): string => {
  const kept: string[] = [];

  for (const path of paths.toReversed()) {
    if (path === '') {
      continue;
    }

    kept.unshift(path);

    if (isAbsolute(path)) {
      break;
    }
  }

  const resolved = normalize(`${SEP}${kept.join(SEP)}`);

  return resolved.length > 1 && resolved.endsWith(SEP) ? resolved.slice(0, -1) : resolved;
};

const relative = (from: string, to: string): string => {
  const fromSegments = resolve(from).split(SEP).filter(Boolean);
  const toSegments = resolve(to).split(SEP).filter(Boolean);
  let shared = 0;

  while (
    shared < fromSegments.length &&
    shared < toSegments.length &&
    fromSegments[shared] === toSegments[shared]
  ) {
    shared += 1;
  }

  return [
    ...fromSegments.slice(shared).map(() => {
      return '..';
    }),
    ...toSegments.slice(shared),
  ].join(SEP);
};

// definition

/**
 * POSIX's path for `parseConfig` in a page: `join`, `resolve`, `relative`, `isAbsolute` and `sep`,
 * as `node:path.posix` answers them, a path no segment makes absolute resolved under `/`.
 */
// ! `config.ts` asks these five alone: a member it comes to ask of `PlatformPath` beyond them is
// one this object lacks, though the type says otherwise; `posix-path.test.ts` holds the five
export const posixPath = Object.freeze({
  isAbsolute,
  join,
  relative,
  resolve,
  sep: SEP,
}) as unknown as PlatformPath;
