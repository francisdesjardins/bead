import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatCaches, parseSize, readCaches } from '../caches.mjs';

const SCRIPT = fileURLToPath(new URL('../caches.mjs', import.meta.url));
const roots = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

const git = (root, ...args) => {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
};

const write = (root, tree) => {
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), 'bead-caches-'));
  roots.push(base);
  const clone = join(base, 'clone with spaces');
  const worktree = join(base, 'worktree with spaces');
  mkdirSync(clone);
  git(clone, 'init', '-q', '-b', 'develop');
  for (const [key, value] of Object.entries({
    'user.name': 'Test',
    'user.email': 'test@example.com',
    'commit.gpgsign': 'false',
    'maintenance.auto': 'false',
    'core.autocrlf': 'false',
    'core.excludesFile': join(base, 'no-global-ignores'),
  })) {
    git(clone, 'config', key, value);
  }
  write(clone, {
    '.gitignore': 'target/\nnode_modules/\nbin/\nobj/\nTestResults/\nplaywright-report/\n*.log\n',
    'src/kept.txt': 'tracked',
  });
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'chore: fixture');
  git(clone, 'worktree', 'add', '-q', '-b', 'feature/cache', worktree);
  write(clone, {
    'target/debug/incremental/one': 'rust',
    'target/llvm-cov-target/two': 'coverage',
    'src/node_modules/library/index.js': 'modules',
    'src/bin/output': 'bin',
    'src/obj/output': 'obj',
    'TestResults/result': 'test',
    'playwright-report/index.html': 'report',
    'ignored.log': 'a file, not a folder',
    'untracked/file': 'untracked',
  });
  write(worktree, { 'target/debug/output': 'other tree' });
  return { base, clone, worktree };
};

const run = (repo, args = []) => {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
};

describe('caches', () => {
  test('finds the ignored folders of the clone and every worktree, from either worktree', () => {
    const { clone, worktree } = fixture();
    const fromClone = readCaches(clone);
    assert.deepEqual(readCaches(worktree), fromClone);
    assert.equal(fromClone.length, 2);
    assert.equal(fromClone[0].path.replaceAll('\\', '/'), clone.replaceAll('\\', '/'));
    assert.deepEqual(
      fromClone[0].folders.map((folder) => folder.path).sort(),
      [
        'TestResults/',
        'playwright-report/',
        'src/bin/',
        'src/node_modules/',
        'src/obj/',
        'target/',
      ].sort()
    );
    assert.deepEqual(
      fromClone[1].folders.map((folder) => folder.path),
      ['target/']
    );
    assert.equal(fromClone[0].bytes, 35);
    assert.equal(fromClone[1].bytes, 10);
    assert.ok(fromClone.every((tree) => tree.errors.length === 0));
  });

  test('orders folders by file bytes, totals each worktree and reports the newest change', () => {
    const { clone } = fixture();
    const newest = new Date('2030-01-02T03:04:05Z');
    utimesSync(join(clone, 'target'), new Date(0), new Date(0));
    utimesSync(join(clone, 'target/debug/incremental/one'), newest, newest);
    const trees = readCaches(clone);
    assert.deepEqual(
      trees[0].folders.map((folder) => folder.bytes),
      [12, 7, 6, 4, 3, 3]
    );
    assert.equal(trees[0].folders[0].modified, newest.getTime());
    const printed = formatCaches(trees);
    assert.match(printed, /12 B\t2030-01-02T03:04:05.000Z\t"target\/"/u);
    assert.match(printed, /Total \(all ignored folders\): 35 B/u);
    assert.match(printed, /Total \(all ignored folders\): 10 B/u);
    assert.match(printed, /Overall total \(all ignored folders\): 45 B/u);
    assert.ok(printed.indexOf('"target/"') < printed.indexOf('"src/node_modules/"'));
  });

  test('filters rows at the inclusive minimum and keeps the complete totals', () => {
    const { clone } = fixture();
    const result = run(clone, ['--min', '7']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"src\/node_modules\/"/u);
    assert.doesNotMatch(result.stdout, /"playwright-report\/"/u);
    assert.match(result.stdout, /Overall total \(all ignored folders\): 45 B/u);
    const hidden = run(clone, ['--min', '500M']);
    assert.equal(hidden.status, 0, hidden.stderr);
    assert.doesNotMatch(hidden.stdout, /"target\/"/u);
    assert.match(hidden.stdout, /Overall total \(all ignored folders\): 45 B/u);
  });

  test('takes --repo from outside the clone and leaves its files and status intact', () => {
    const { base, clone } = fixture();
    const before = git(clone, 'status', '--porcelain', '--ignored');
    const content = readFileSync(join(clone, 'target/debug/incremental/one'));
    const result = run(base, ['--repo', clone]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Overall total \(all ignored folders\): 45 B/u);
    assert.equal(git(clone, 'status', '--porcelain', '--ignored'), before);
    assert.deepEqual(readFileSync(join(clone, 'target/debug/incremental/one')), content);
  });

  test('names an unreadable folder even below --min, and continues with partial totals', () => {
    const { clone } = fixture();
    const denied = join(clone, 'target/debug');
    const trees = readCaches(clone, {
      readDirectory: (path) => {
        if (path === denied) {
          throw Object.assign(new Error('access denied'), { code: 'EACCES' });
        }
        return readdirSync(path);
      },
    });
    const target = trees[0].folders.find((folder) => folder.path === 'target/');
    assert.equal(target.bytes, 8);
    assert.deepEqual(target.errors, [`${JSON.stringify(denied)}: EACCES`]);
    assert.equal(trees[1].bytes, 10);
    const printed = formatCaches(trees, { min: parseSize('2G') });
    assert.ok(printed.includes(`unreadable: ${JSON.stringify(denied)}: EACCES`));
    assert.match(printed, /Total \(all ignored folders\): 31 B \(partial\)/u);
    assert.match(printed, /Overall total \(all ignored folders\): 41 B \(partial\)/u);
  });

  test('names a missing worktree and continues listing the clone', () => {
    const { clone, worktree } = fixture();
    rmSync(worktree, { recursive: true, force: true, maxRetries: 10 });
    const result = run(clone);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unreadable:/u);
    assert.ok(result.stdout.includes(JSON.stringify(worktree.replaceAll('\\', '/'))));
    assert.match(result.stdout, /Overall total \(all ignored folders\): 35 B \(partial\)/u);
  });

  test(
    'reports a filesystem access refusal and still lists the other worktree',
    {
      skip:
        process.platform === 'win32' || process.getuid?.() === 0
          ? 'POSIX permissions need an unprivileged Linux runner; injected refusal runs everywhere'
          : false,
    },
    () => {
      const { clone } = fixture();
      const denied = join(clone, 'target/debug');
      chmodSync(denied, 0);
      try {
        const result = run(clone);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(`unreadable: ${JSON.stringify(denied)}: EACCES`));
        assert.match(result.stdout, /Overall total \(all ignored folders\): 41 B \(partial\)/u);
      } finally {
        chmodSync(denied, 0o755);
      }
    }
  );

  test(
    'leaves links outside the worktree and directory cycles untraversed',
    { skip: process.platform === 'win32' ? 'POSIX symbolic links play on Linux' : false },
    () => {
      const { base, clone } = fixture();
      write(base, { 'outside/output': 'not part of this cache' });
      const outside = join(clone, 'target/outside');
      const cycle = join(clone, 'target/cycle');
      symlinkSync(join(base, 'outside'), outside);
      try {
        symlinkSync(join(clone, 'target'), cycle);
        try {
          const trees = readCaches(clone);
          assert.equal(trees[0].bytes, 35);
          assert.match(formatCaches(trees), /Overall total \(all ignored folders\): 45 B/u);
          assert.deepEqual(trees[0].folders[0].errors, []);
        } finally {
          unlinkSync(cycle);
        }
      } finally {
        unlinkSync(outside);
      }
    }
  );

  test('prints zero totals for a worktree without ignored folders', () => {
    const { clone, worktree } = fixture();
    rmSync(join(worktree, 'target'), { recursive: true, force: true, maxRetries: 10 });
    const trees = readCaches(clone);
    assert.deepEqual(trees[1].folders, []);
    assert.equal(trees[1].bytes, 0);
    assert.match(formatCaches(trees), /Total \(all ignored folders\): 0 B/u);
  });

  test('reads binary size suffixes and refuses invalid or unrepresentable sizes', () => {
    for (const [text, expected] of [
      ['0', 0],
      ['123B', 123],
      ['1k', 1024],
      ['500M', 500 * 1024 ** 2],
      ['2G', 2 * 1024 ** 3],
      ['1.5G', 1.5 * 1024 ** 3],
      ['1T', 1024 ** 4],
    ]) {
      assert.equal(parseSize(text), expected);
    }
    for (const text of ['', '-1', 'NaN', '1MB', '2GB', '1e3', '9007199254740992']) {
      assert.throws(() => parseSize(text), /size/u);
    }
  });

  test('refuses unknown options, positionals and invalid minima with exit 2', () => {
    for (const args of [['--unknown'], ['unexpected'], ['--min'], ['--min', '-1']]) {
      const result = run(tmpdir(), args);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /usage: node tools\/caches.mjs/u);
    }
  });

  test('reports a path outside a repository with exit 1', () => {
    const folder = mkdtempSync(join(tmpdir(), 'bead-caches-no-repo-'));
    roots.push(folder);
    const result = run(folder);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /caches:/u);
    assert.equal(result.stdout, '');
  });
});
