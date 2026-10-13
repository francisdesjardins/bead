// ── Archive ───────────────────────────────────────────────────────────────────

// A tar as `git archive --format=tar` writes it, read into a folder: POSIX.1-2001's pax interchange
// format, 512-byte ustar headers, a global header `g` skipped, an extended header `x` giving the next
// entry's `path` and its `size`, which override the ustar header's as GNU tar and bsdtar read them,
// then folders and regular files. A link is not written, as `export-ignore` drops a file; a path
// absolute, holding `..` or a NUL, or empty, a path an earlier entry holds, an entry of a type `git
// archive` never writes, a header whose checksum is off and an archive cut short are refused, exit 2:
// a `git archive` that failed mid-stream leaves one. No dependency: the format is a page of POSIX's.

// dependencies

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { InputError } from '../diagnostics.ts';

// constants

const BLOCK = 512;

// a ustar header's fields, by offset and length
const NAME = [0, 100] as const;
const SIZE = [124, 12] as const;
const CHECKSUM = [148, 8] as const;
const TYPE = 156;
const MAGIC = [257, 6] as const;
const PREFIX = [345, 155] as const;

// the entry types a `git archive` writes
const EntryType = Object.freeze({
  FILE: '0',
  OLD_FILE: '\0',
  HARD_LINK: '1',
  SYMBOLIC_LINK: '2',
  FOLDER: '5',
  GLOBAL: 'g',
  EXTENDED: 'x',
} as const);

// a path's form a folder never takes: absolute, by a slash or a drive
const ABSOLUTE = /^(?:[/\\]|[A-Za-z]:)/u;

// helpers

const decoder = new TextDecoder('utf-8');

// a field's text, up to its first NUL
const textOf = (header: Uint8Array, [offset, length]: readonly [number, number]): string => {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);

  return decoder.decode(end === -1 ? field : field.subarray(0, end));
};

// a numeric field, octal digits in ASCII
const octalOf = (
  header: Uint8Array,
  details: { readonly field: readonly [number, number]; readonly at: number }
): number => {
  const text = textOf(header, details.field).trim();

  if (!/^[0-7]+$/u.test(text)) {
    throw new InputError(
      `the archive's header at byte ${String(details.at)} holds no octal number where one is due: no tar git archive writes`
    );
  }

  return Number.parseInt(text, 8);
};

// a header's checksum: its bytes summed, its checksum's own read as spaces
const checksumOf = (header: Uint8Array): number => {
  let sum = 0;

  for (let index = 0; index < BLOCK; index += 1) {
    const inChecksum = index >= CHECKSUM[0] && index < CHECKSUM[0] + CHECKSUM[1];

    sum += inChecksum ? 0x20 : (header[index] ?? 0);
  }

  return sum;
};

// a pax extended header's records, `<length> <key>=<value>\n` each
const recordsOf = (data: Uint8Array): Map<string, string> => {
  const records = new Map<string, string>();
  let at = 0;

  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = Number.parseInt(decoder.decode(data.subarray(at, space)), 10);

    if (space === -1 || !Number.isInteger(length) || length <= 0 || at + length > data.length) {
      throw new InputError("the archive's pax header holds a record cut short");
    }

    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const equals = record.indexOf('=');

    records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }

  return records;
};

// a path of the archive, refused when it would leave the folder, or names nothing a folder holds
const safePathOf = (path: string): string[] => {
  const segments = path.split(/[/\\]/u).filter((segment) => {
    return segment !== '' && segment !== '.';
  });

  if (ABSOLUTE.test(path) || segments.includes('..')) {
    throw new InputError(
      `the archive holds ${path}, a path outside its folder: no tar git archive writes`
    );
  }

  if (segments.length === 0 || path.includes('\0')) {
    throw new InputError(
      `the archive holds ${JSON.stringify(path)}, a path that names no file: no tar git archive writes`
    );
  }

  return segments;
};

// an entry's size: its pax header's `size`, which overrides the ustar header's, or the ustar header's
const sizeOf = (
  header: Uint8Array,
  details: { readonly records: ReadonlyMap<string, string> | undefined; readonly at: number }
): number => {
  const given = details.records?.get('size');

  if (given === undefined) {
    return octalOf(header, { field: SIZE, at: details.at });
  }

  if (!/^[0-9]+$/u.test(given)) {
    throw new InputError(
      `the archive's pax header before byte ${String(details.at)} holds a size that is no whole number`
    );
  }

  return Number.parseInt(given, 10);
};

const isZero = (block: Uint8Array): boolean => {
  return block.every((byte) => {
    return byte === 0;
  });
};

// definition

/**
 * Reads `bytes`, a tar as `git archive --format=tar` writes it, into `options.into`: its folders and
 * regular files, a link left out. Gives the files written, by their paths in the archive. Throws an
 * {@link InputError} for an archive cut short, a path outside the folder, or an entry `git archive`
 * never writes.
 */
export const extractArchive = (bytes: Uint8Array, options: { readonly into: string }): string[] => {
  const written: string[] = [];
  // each path an entry gave, so that none gives it twice
  const held = new Set<string>();
  const hold = (segments: readonly string[]): void => {
    const path = segments.join('/');

    if (held.has(path)) {
      throw new InputError(
        `the archive holds ${path} twice, an entry over an earlier one: no tar git archive writes`
      );
    }

    held.add(path);
  };
  let at = 0;
  let next: Map<string, string> | undefined;

  mkdirSync(options.into, { recursive: true });

  while (at + BLOCK <= bytes.length) {
    const header = bytes.subarray(at, at + BLOCK);

    // * the end: a zero block, then another, which git archive writes
    if (isZero(header)) {
      const second = bytes.subarray(at + BLOCK, at + 2 * BLOCK);

      if (second.length === BLOCK && isZero(second)) {
        return written;
      }

      break;
    }

    if (octalOf(header, { field: CHECKSUM, at }) !== checksumOf(header)) {
      throw new InputError(
        `the archive's header at byte ${String(at)} is off its checksum: no tar git archive writes`
      );
    }

    if (!textOf(header, MAGIC).startsWith('ustar')) {
      throw new InputError(`the archive's header at byte ${String(at)} is no ustar header`);
    }

    const size = sizeOf(header, { records: next, at });
    const start = at + BLOCK;
    const end = start + size;

    if (end > bytes.length) {
      throw new InputError('the archive is cut short: did git archive fail?');
    }

    const data = bytes.subarray(start, end);
    const type = String.fromCharCode(header[TYPE] ?? 0);
    const prefix = textOf(header, PREFIX);
    const name =
      next?.get('path') ??
      (prefix === '' ? textOf(header, NAME) : `${prefix}/${textOf(header, NAME)}`);

    at = start + Math.ceil(size / BLOCK) * BLOCK;

    switch (type) {
      case EntryType.GLOBAL: {
        break;
      }
      case EntryType.EXTENDED: {
        next = recordsOf(data);
        continue;
      }
      case EntryType.FOLDER: {
        const segments = safePathOf(name);

        hold(segments);
        mkdirSync(join(options.into, ...segments), { recursive: true });
        break;
      }
      case EntryType.FILE:
      case EntryType.OLD_FILE: {
        const segments = safePathOf(name);
        const path = join(options.into, ...segments);

        hold(segments);

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
        written.push(segments.join('/'));
        break;
      }
      case EntryType.HARD_LINK:
      case EntryType.SYMBOLIC_LINK: {
        // ! a link is not written: its target may lie outside the folder
        safePathOf(name);
        break;
      }
      default: {
        throw new InputError(
          `the archive holds ${name}, an entry of type ${JSON.stringify(type)}, which git archive never writes`
        );
      }
    }

    next = undefined;
  }

  throw new InputError('the archive is cut short: did git archive fail?');
};
