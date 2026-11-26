#!/usr/bin/env node
// The ignored folders of every worktree, largest first, their file bytes and newest modification.
//
//   node tools/caches.mjs [--repo <path>] [--min <size>]
//
// Sizes are apparent bytes of regular files; symbolic links are not followed. --min filters the
// rows, never the totals. A folder that cannot be read is named and its total marked partial.
// Exit 1 when the clone cannot be read; exit 2 on a usage error. Nothing is written or removed.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const BUFFER = 64 * 1024 * 1024;
const UNITS = ['B', 'K', 'M', 'G', 'T'];

const git = (root, args) => {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || 'git failed');
  }
  return result;
};

export const parseSize = (text) => {
  const match = /^(\d+(?:\.\d+)?)([BKMGT]?)$/iu.exec(text);
  if (match === null) {
    throw new Error(`invalid size ${JSON.stringify(text)}; use bytes, 500M or 2G`);
  }
  const bytes = Number(match[1]) * 1024 ** Math.max(0, UNITS.indexOf(match[2].toUpperCase()));
  if (!Number.isFinite(bytes) || bytes > Number.MAX_SAFE_INTEGER) {
    throw new Error(`size ${JSON.stringify(text)} is too large`);
  }
  return bytes;
};

const sizeOf = (bytes) => {
  let unit = 0;
  let amount = bytes;
  while (amount >= 1024 && unit < UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${amount.toFixed(2)} ${UNITS[unit]}iB`;
};

const measure = (path, readDirectory) => {
  const result = { path, bytes: 0, modified: null, errors: [], directory: false };
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    try {
      const stat = lstatSync(current);
      // ! junctions and symbolic links can point outside this worktree, or back into it
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (current === path) {
        result.directory = stat.isDirectory();
      }
      result.modified =
        result.modified === null ? stat.mtimeMs : Math.max(result.modified, stat.mtimeMs);
      if (stat.isDirectory()) {
        for (const entry of readDirectory(current)) {
          pending.push(join(current, entry));
        }
      } else if (stat.isFile()) {
        result.bytes += stat.size;
      }
    } catch (error) {
      result.errors.push(`${JSON.stringify(current)}: ${error.code ?? error.message}`);
    }
  }
  return result;
};

// readDirectory is replaceable so access refusals play on Windows and under a privileged runner.
export const readCaches = (repo, { readDirectory = readdirSync } = {}) => {
  const root = git(resolve(repo), ['rev-parse', '--show-toplevel']).stdout.replace(/\r?\n$/u, '');
  const paths = git(root, ['worktree', 'list', '--porcelain', '-z'])
    .stdout.split('\0')
    .filter((field) => {
      return field.startsWith('worktree ');
    })
    .map((field) => {
      return field.slice('worktree '.length);
    });
  return paths.map((path) => {
    const tree = { path, folders: [], bytes: 0, errors: [] };
    try {
      const listed = git(path, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ]);
      if (listed.stderr.trim() !== '') {
        tree.errors.push(listed.stderr.trim());
      }
      for (const folder of listed.stdout.split('\0')) {
        if (!folder.endsWith('/')) {
          continue;
        }
        const measured = measure(join(path, folder), readDirectory);
        if (measured.directory || measured.errors.length > 0) {
          tree.folders.push({ ...measured, path: folder });
          tree.bytes += measured.bytes;
        }
      }
      tree.folders.sort((a, b) => {
        return b.bytes - a.bytes || a.path.localeCompare(b.path, 'en');
      });
    } catch (error) {
      tree.errors.push(error.message);
    }
    return tree;
  });
};

const partial = (tree) => {
  return (
    tree.errors.length > 0 ||
    tree.folders.some((folder) => {
      return folder.errors.length > 0;
    })
  );
};

export const formatCaches = (trees, { min = 0 } = {}) => {
  const lines = ['Ignored folders: regular file bytes; links are not followed.'];
  for (const tree of trees) {
    lines.push('', `Worktree ${JSON.stringify(tree.path)}`);
    for (const folder of tree.folders) {
      if (folder.bytes >= min) {
        const modified =
          folder.modified === null ? 'unknown' : new Date(folder.modified).toISOString();
        lines.push(
          `  ${sizeOf(folder.bytes)}\t${modified}\t${JSON.stringify(folder.path)}${folder.errors.length > 0 ? ' (partial)' : ''}`
        );
      }
      for (const error of folder.errors) {
        lines.push(`  unreadable: ${error}`);
      }
    }
    for (const error of tree.errors) {
      lines.push(`  unreadable: ${error}`);
    }
    lines.push(
      `  Total (all ignored folders): ${sizeOf(tree.bytes)}${partial(tree) ? ' (partial)' : ''}`
    );
  }
  const total = trees.reduce((sum, tree) => {
    return sum + tree.bytes;
  }, 0);
  lines.push(
    '',
    `Overall total (all ignored folders): ${sizeOf(total)}${trees.some(partial) ? ' (partial)' : ''}`
  );
  return lines.join('\n');
};

if (import.meta.main) {
  let values;
  let min;
  try {
    ({ values } = parseArgs({
      options: { repo: { type: 'string' }, min: { type: 'string' } },
    }));
    min = parseSize(values.min ?? '0');
  } catch (error) {
    console.error(`caches: ${error.message}`);
    console.error('usage: node tools/caches.mjs [--repo <path>] [--min <size>]');
    process.exit(2);
  }
  try {
    console.log(formatCaches(readCaches(values.repo ?? process.cwd()), { min }));
  } catch (error) {
    console.error(`caches: ${error.message}`);
    process.exit(1);
  }
}
