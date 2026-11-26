import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { finish } from '../flow.mjs';

const SCRIPT = fileURLToPath(new URL('../flow.mjs', import.meta.url));
const BRANCH = 'feature/x';

// ── Fixture ───────────────────────────────────────────────────────────────────

const roots = [];
after(() => {
  for (const root of roots) {
    // Windows holds a folder a process just let go a moment longer: its removal is retried
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

const git = (root, ...args) => {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
};

const configure = (root) => {
  for (const [key, value] of Object.entries({
    'user.name': 'Test',
    'user.email': 'test@example.com',
    'commit.gpgsign': 'false',
    'tag.gpgsign': 'false',
    'core.autocrlf': 'false',
    // ! no maintenance after a commit: git detaches it, and it keeps .git/objects/maintenance.lock
    // after the commit returns, so the folder's removal finds the lock listed, then gone
    'maintenance.auto': 'false',
  })) {
    git(root, 'config', key, value);
  }
};

const write = (root, tree) => {
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

// a bare origin holding main, develop and feature/x, one commit past develop; a clone on develop,
// which also holds feature/x, checked out in a worktree with node_modules folders, one deep
const flowing = () => {
  const base = mkdtempSync(join(tmpdir(), 'bead-flow-'));
  roots.push(base);
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  const worktree = join(base, 'wt');
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  configure(origin);
  mkdirSync(clone);
  git(clone, 'init', '-q', '-b', 'main');
  configure(clone);
  git(clone, 'remote', 'add', 'origin', origin);
  write(clone, { 'a.txt': 'one\n', '.gitignore': 'node_modules/\n' });
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'feat: one');
  git(clone, 'checkout', '-q', '-b', 'develop');
  git(clone, 'checkout', '-q', '-b', BRANCH);
  write(clone, { 'b.txt': 'two\n' });
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'feat: two');
  git(clone, 'checkout', '-q', 'develop');
  git(clone, 'push', '-q', '-u', 'origin', 'main', 'develop', BRANCH);
  git(clone, 'worktree', 'add', '-q', worktree, BRANCH);
  write(worktree, {
    'node_modules/a/node_modules/b/index.js': '',
    'site/node_modules/c/d/e/f/g/h/index.js': '',
  });
  return { base, origin, clone, worktree, feature: git(clone, 'rev-parse', BRANCH) };
};

// gh as the tool calls it: `list(branch)` gives a branch's runs, the newest first, read when called;
// `view` gives a run by its id, each run of `going` reading in progress that many times first, and a
// run listed as going then passing
const standIn = ({ list, going = {} }) => {
  const calls = [];
  const known = new Map();
  const gh = (args) => {
    calls.push(args.join(' '));
    const [noun, verb] = args;
    if (noun === 'run' && verb === 'list') {
      assert.equal(args[args.indexOf('--workflow') + 1], 'ci.yml');
      const runs = list(args[args.indexOf('--branch') + 1]);
      for (const run of runs) {
        known.set(run.databaseId, run);
      }
      return JSON.stringify(
        runs.map(({ databaseId, headSha, status, conclusion }) => {
          return { databaseId, headSha, status, conclusion };
        })
      );
    }
    if (noun === 'run' && verb === 'view') {
      const run = known.get(Number(args[2]));
      if ((going[run.databaseId] ?? 0) > 0) {
        going[run.databaseId] -= 1;
        return JSON.stringify({ ...run, status: 'in_progress', conclusion: '' });
      }
      return JSON.stringify({
        jobs: [],
        ...run,
        status: 'completed',
        conclusion: run.conclusion || 'success',
      });
    }
    throw new Error(`gh ${args.join(' ')}: not stood in for`);
  };
  return { gh, calls };
};

const passed = (databaseId, headSha) => {
  return { databaseId, headSha, status: 'completed', conclusion: 'success' };
};

// origin's develop when gh is called, which is the merge once the tool pushed it
const developOf = (origin) => {
  return git(origin, 'rev-parse', 'refs/heads/develop');
};

const run = (fixture, options) => {
  const lines = [];
  const promise = finish(fixture.clone, {
    branch: BRANCH,
    sleep: async () => {},
    log: (line) => {
      lines.push(line);
    },
    cwd: fixture.base,
    ...options,
  });
  return { lines, promise };
};

// what the tool may change: the clone's refs and status, its worktrees, and origin's refs
const snapshot = (fixture) => {
  return {
    refs: git(fixture.clone, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    status: git(fixture.clone, 'status', '--porcelain'),
    worktrees: git(fixture.clone, 'worktree', 'list', '--porcelain'),
    origin: git(fixture.origin, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktree: existsSync(fixture.worktree),
    modules: existsSync(join(fixture.worktree, 'node_modules')),
  };
};

// the clone's files and index, including merge state, which a trial merge must leave untouched
const cloneState = (fixture) => {
  const read = (path) => {
    const file = join(fixture.clone, path);
    return existsSync(file) ? readFileSync(file) : null;
  };
  return {
    ...snapshot(fixture),
    index: read('.git/index'),
    head: read('.git/HEAD'),
    merge: read('.git/MERGE_HEAD'),
    original: read('.git/ORIG_HEAD'),
    a: read('a.txt'),
    spaced: read('has space.txt'),
  };
};

const featureRuns = (fixture, run) => {
  return (branch) => {
    return branch === BRANCH ? [run] : [passed(20, developOf(fixture.origin))];
  };
};

// ── Refusals ──────────────────────────────────────────────────────────────────

describe('refusals', () => {
  test('a branch whose run failed is refused, its failed jobs named, and nothing changes', async () => {
    const fixture = flowing();
    const before = snapshot(fixture);
    const { gh } = standIn({
      list: featureRuns(fixture, {
        databaseId: 11,
        headSha: fixture.feature,
        status: 'completed',
        conclusion: 'failure',
        jobs: [
          { name: 'Spec', conclusion: 'failure' },
          { name: 'Rust', conclusion: 'success' },
          { name: 'CI ok', conclusion: 'failure' },
        ],
      }),
    });
    await assert.rejects(
      run(fixture, { gh }).promise,
      /^Error: feature\/x: run 11 for \w{7} ended failure: Spec, CI ok$/
    );
    assert.deepEqual(snapshot(fixture), before);
  });

  test('a branch whose run was cancelled is refused: a newer run is needed', async () => {
    const fixture = flowing();
    const { gh } = standIn({
      list: featureRuns(fixture, {
        databaseId: 11,
        headSha: fixture.feature,
        status: 'completed',
        conclusion: 'cancelled',
      }),
    });
    await assert.rejects(
      run(fixture, { gh }).promise,
      /run 11 for \w{7} was cancelled, neither failed nor passed; a newer run is needed/
    );
  });

  test('a branch with no run for its head is refused', async () => {
    const fixture = flowing();
    const { gh } = standIn({ list: featureRuns(fixture, passed(11, 'f'.repeat(40))) });
    await assert.rejects(run(fixture, { gh }).promise, /no run of ci\.yml for its head \w{7}/);
  });

  test('a dirty develop is refused before gh is asked anything', async () => {
    const fixture = flowing();
    write(fixture.clone, { 'a.txt': 'changed\n' });
    const { gh, calls } = standIn({ list: featureRuns(fixture, passed(11, fixture.feature)) });
    await assert.rejects(run(fixture, { gh }).promise, /^Error: develop has changes/);
    assert.deepEqual(calls, []);
  });

  test('develop apart from origin/develop is refused', async () => {
    const fixture = flowing();
    git(fixture.clone, 'commit', '-q', '--allow-empty', '-m', 'feat: local');
    const { gh } = standIn({ list: featureRuns(fixture, passed(11, fixture.feature)) });
    await assert.rejects(run(fixture, { gh }).promise, /is not origin\/develop/);
  });

  test('develop held by another worktree is refused with its path and the detach command, including --dry-run', async () => {
    for (const dryRun of [false, true]) {
      const fixture = flowing();
      const held = join(fixture.base, 'develop elsewhere');
      git(fixture.clone, 'checkout', '-q', 'main');
      git(fixture.clone, 'worktree', 'add', '-q', held, 'develop');
      const before = cloneState(fixture);
      const { gh, calls } = standIn({ list: () => [] });
      await assert.rejects(run(fixture, { gh, dryRun }).promise, {
        message: `develop is checked out in another worktree, ${held.replaceAll('\\', '/')}: free it with git -C "${held.replaceAll('\\', '/')}" checkout --detach`,
      });
      assert.deepEqual(cloneState(fixture), before);
      assert.deepEqual(calls, []);
    }
  });

  test('develop forced into another worktree is refused even when the clone holds it too', async () => {
    const fixture = flowing();
    const held = join(fixture.base, 'develop elsewhere');
    git(fixture.clone, 'worktree', 'add', '-q', '--force', held, 'develop');
    const before = cloneState(fixture);
    const { gh, calls } = standIn({ list: () => [] });
    await assert.rejects(
      run(fixture, { gh }).promise,
      /develop is checked out in another worktree/
    );
    assert.deepEqual(cloneState(fixture), before);
    assert.deepEqual(calls, []);
  });

  test('release/*, hotfix/* and a name outside feature/* are refused, pointing at git flow and tools/release.mjs', async () => {
    const fixture = flowing();
    const { gh, calls } = standIn({ list: () => [] });
    for (const branch of ['release/0.2.0', 'hotfix/0.1.1']) {
      await assert.rejects(
        run(fixture, { gh, branch }).promise,
        /finished by git flow and tools\/release\.mjs/
      );
    }
    for (const branch of ['main', 'develop', 'feature/', 'feature/a..b']) {
      await assert.rejects(run(fixture, { gh, branch }).promise, /not a feature\/\* branch/);
    }
    assert.deepEqual(calls, []);
  });

  test('a worktree with changes, or a local branch ahead of origin’s, is refused', async () => {
    const fixture = flowing();
    const { gh } = standIn({ list: featureRuns(fixture, passed(11, fixture.feature)) });
    write(fixture.worktree, { 'c.txt': 'work\n' });
    await assert.rejects(run(fixture, { gh }).promise, /has changes: commit or drop them first/);
    git(fixture.worktree, 'add', '-A');
    git(fixture.worktree, 'commit', '-qm', 'feat: three');
    await assert.rejects(run(fixture, { gh }).promise, /holds commits origin's lacks/);
  });

  test('a conflict is refused before merging, names every file and the recovery, and leaves the clone and index untouched, including --dry-run', async () => {
    for (const dryRun of [false, true]) {
      const fixture = flowing();
      write(fixture.worktree, { 'a.txt': 'feature\n', 'has space.txt': 'feature\n' });
      git(fixture.worktree, 'add', '-A');
      git(fixture.worktree, 'commit', '-qm', 'feat: three');
      git(fixture.worktree, 'push', '-q', 'origin', BRANCH);
      write(fixture.clone, { 'a.txt': 'develop\n', 'has space.txt': 'develop\n' });
      git(fixture.clone, 'add', '-A');
      git(fixture.clone, 'commit', '-qm', 'feat: four');
      git(fixture.clone, 'push', '-q', 'origin', 'develop');
      const head = git(fixture.worktree, 'rev-parse', 'HEAD');
      git(fixture.clone, 'config', 'rerere.enabled', 'true');
      const before = cloneState(fixture);
      const { gh, calls } = standIn({ list: featureRuns(fixture, passed(11, head)) });
      await assert.rejects(run(fixture, { gh, dryRun }).promise, {
        message:
          'merging feature/x into develop conflicts in a.txt, has space.txt: merge develop into feature/x, resolve and commit, push, let CI pass, then finish again',
      });
      assert.deepEqual(cloneState(fixture), before);
      assert.equal(git(fixture.clone, 'ls-files', '-u'), '');
      assert.equal(git(fixture.clone, 'status', '--porcelain'), '');
      assert.equal(existsSync(join(fixture.clone, '.git/rr-cache')), false);
      assert.deepEqual(calls, []);
    }
  });

  test('a trial merge failure without conflicting files removes its temporary worktree and leaves the clone untouched', async () => {
    const fixture = flowing();
    git(fixture.worktree, 'checkout', '-q', '--orphan', 'feature/unrelated');
    git(fixture.worktree, 'commit', '-qm', 'feat: unrelated');
    const head = git(fixture.worktree, 'rev-parse', 'HEAD');
    git(fixture.worktree, 'push', '-q', '--force', 'origin', `HEAD:${BRANCH}`);
    git(fixture.clone, 'branch', '-f', BRANCH, head);
    const before = cloneState(fixture);
    const { gh, calls } = standIn({ list: featureRuns(fixture, passed(11, head)) });
    await assert.rejects(
      run(fixture, { gh, dryRun: true }).promise,
      /the trial merge of feature\/x failed: fatal: refusing to merge unrelated histories/
    );
    assert.deepEqual(cloneState(fixture), before);
    assert.deepEqual(calls, []);
  });
});

// ── Finish ────────────────────────────────────────────────────────────────────

describe('finish', () => {
  test('a branch that passed is merged, develop pushed, and origin’s, the worktree and the local branch deleted', async () => {
    const fixture = flowing();
    // a tag and push.followTags, which the push of develop must leave behind
    git(fixture.clone, 'tag', '-a', 'v9.9.9', '-m', 'v9.9.9');
    git(fixture.clone, 'config', 'push.followTags', 'true');
    const { gh } = standIn({
      list: (branch) => {
        return branch === BRANCH
          ? [{ databaseId: 11, headSha: fixture.feature, status: 'in_progress', conclusion: '' }]
          : [
              {
                databaseId: 21,
                headSha: developOf(fixture.origin),
                status: 'queued',
                conclusion: '',
              },
            ];
      },
      going: { 11: 2, 21: 1 },
    });
    const { lines, promise } = run(fixture, { gh });
    const result = await promise;

    const merge = developOf(fixture.origin);
    assert.equal(result.merge, merge);
    assert.equal(git(fixture.clone, 'rev-parse', 'develop'), merge);
    assert.equal(
      git(fixture.origin, 'log', '-1', '--format=%s', merge),
      "Merge branch 'feature/x' into develop"
    );
    assert.equal(git(fixture.origin, 'rev-parse', `${merge}^2`), fixture.feature);
    assert.equal(git(fixture.origin, 'for-each-ref', 'refs/heads/feature'), '');
    assert.equal(git(fixture.origin, 'for-each-ref', 'refs/tags'), '');
    assert.equal(git(fixture.clone, 'for-each-ref', 'refs/heads/feature'), '');
    assert.equal(existsSync(fixture.worktree), false);
    assert.equal(
      git(fixture.clone, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).length,
      1
    );
    assert.deepEqual(lines, [
      `origin: feature/x at ${fixture.feature.slice(0, 7)}`,
      `develop: clean, at origin/develop (${git(fixture.clone, 'rev-parse', '--short=7', 'main')})`,
      'waiting: run 11 (in_progress), polled every 30 s',
      `CI: run 11 passed for feature/x at ${fixture.feature.slice(0, 7)}`,
      `merged: feature/x into develop at ${merge.slice(0, 7)}`,
      `pushed: develop at ${merge.slice(0, 7)}`,
      'waiting: run 21 (queued), polled every 30 s',
      `CI: run 21 passed for develop at ${merge.slice(0, 7)}`,
      "deleted: origin's feature/x",
      lines[9],
      'deleted: the local feature/x',
    ]);
    // the worktree's path as git prints it, which may spell the temporary folder its own way
    assert.match(lines[9], /^removed: the worktree .+[\\/]wt, 2 node_modules folders first$/);
  });

  test('a develop run cancelled by a newer push gives way to the newest run that contains the merge', async () => {
    const fixture = flowing();
    const other = join(fixture.base, 'other');
    let newer;
    const { gh } = standIn({
      list: (branch) => {
        if (branch === BRANCH) {
          return [passed(11, fixture.feature)];
        }
        const merge = developOf(fixture.origin);
        if (newer === undefined) {
          // someone pushes on top of the merge, which cancels its run
          git(fixture.base, 'clone', '-q', '-b', 'develop', fixture.origin, other);
          configure(other);
          write(other, { 'c.txt': 'three\n' });
          git(other, 'add', '-A');
          git(other, 'commit', '-qm', 'feat: three');
          git(other, 'push', '-q', 'origin', 'develop');
          newer = { merge, head: developOf(fixture.origin) };
        }
        return [
          passed(23, newer.head),
          { databaseId: 22, headSha: newer.merge, status: 'completed', conclusion: 'cancelled' },
          passed(21, git(fixture.origin, 'rev-parse', 'main')),
        ];
      },
    });
    const { lines, promise } = run(fixture, { gh });
    await promise;
    assert.ok(
      lines.includes(
        `CI: develop's run 22 was cancelled, superseded by run 23 of ${newer.head.slice(0, 7)}, which contains the merge; following it`
      ),
      lines.join('\n')
    );
    assert.ok(lines.includes(`CI: run 23 passed for develop at ${newer.head.slice(0, 7)}`));
    assert.equal(git(fixture.origin, 'for-each-ref', 'refs/heads/feature'), '');
    assert.equal(existsSync(fixture.worktree), false);
  });

  test('a develop run cancelled with no newer run is refused, and nothing deleted', async () => {
    const fixture = flowing();
    const { gh } = standIn({
      list: (branch) => {
        return branch === BRANCH
          ? [passed(11, fixture.feature)]
          : [
              {
                databaseId: 22,
                headSha: developOf(fixture.origin),
                status: 'completed',
                conclusion: 'cancelled',
              },
            ];
      },
    });
    await assert.rejects(
      run(fixture, { gh }).promise,
      /run 22 for \w{7} was cancelled, and no newer run contains the merge; a newer run is needed .*; nothing deleted$/
    );
    assert.notEqual(git(fixture.origin, 'for-each-ref', 'refs/heads/feature'), '');
  });

  test('a develop failure names its failed jobs and deletes nothing', async () => {
    const fixture = flowing();
    const { gh } = standIn({
      list: (branch) => {
        return branch === BRANCH
          ? [passed(11, fixture.feature)]
          : [
              {
                databaseId: 22,
                headSha: developOf(fixture.origin),
                status: 'completed',
                conclusion: 'failure',
                jobs: [
                  { name: 'TypeScript', conclusion: 'success' },
                  { name: 'C#', conclusion: 'failure' },
                  { name: 'Interop', conclusion: 'skipped' },
                  { name: 'CI ok', conclusion: 'failure' },
                ],
              },
            ];
      },
    });
    await assert.rejects(
      run(fixture, { gh }).promise,
      /^Error: develop: run 22 for \w{7} ended failure: C#, CI ok; nothing deleted$/
    );
    // the merge is pushed, and the branch, its worktree and the local branch all stay
    assert.equal(
      git(fixture.origin, 'log', '-1', '--format=%s', 'develop'),
      "Merge branch 'feature/x' into develop"
    );
    assert.equal(git(fixture.origin, 'rev-parse', `refs/heads/${BRANCH}`), fixture.feature);
    assert.equal(git(fixture.clone, 'rev-parse', `refs/heads/${BRANCH}`), fixture.feature);
    assert.equal(
      existsSync(join(fixture.worktree, 'node_modules/a/node_modules/b/index.js')),
      true
    );
  });

  test('--dry-run makes every check, says what it would do, and changes nothing', async () => {
    const fixture = flowing();
    for (const hook of ['post-checkout', 'pre-merge-commit']) {
      writeFileSync(join(fixture.clone, '.git/hooks', hook), '#!/bin/sh\nexit 42\n', {
        mode: 0o755,
      });
    }
    const before = cloneState(fixture);
    const { gh, calls } = standIn({ list: featureRuns(fixture, passed(11, fixture.feature)) });
    const { lines, promise } = run(fixture, { gh, dryRun: true });
    const result = await promise;
    assert.equal(result.dryRun, true);
    assert.deepEqual(cloneState(fixture), before);
    assert.match(
      lines.at(-1),
      /^dry run: would merge feature\/x \(\w{7}\) into develop with --no-ff, push develop, await its run of ci\.yml, then delete origin's feature\/x, the worktree .+, its node_modules first, the local feature\/x$/
    );
    assert.ok(
      calls.every((call) => call.startsWith('run list') && call.includes('--branch feature/x'))
    );
  });
});

// ── The command line ──────────────────────────────────────────────────────────

describe('the command line', () => {
  test('it exits 1 on a refusal, and 2 on a usage error', () => {
    const fixture = flowing();
    const cli = (...args) => {
      return spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: fixture.base,
        encoding: 'utf8',
      });
    };
    const release = cli('finish', 'release/0.2.0', '--repo', fixture.clone);
    assert.equal(release.status, 1);
    assert.match(
      release.stderr,
      /^flow: release\/0\.2\.0: a release or a hotfix is finished by git flow and tools\/release\.mjs/
    );
    write(fixture.clone, { 'a.txt': 'changed\n' });
    const dirty = cli('finish', BRANCH, '--repo', fixture.clone, '--dry-run');
    assert.equal(dirty.status, 1);
    assert.equal(dirty.stderr, 'flow: develop has changes: commit, stash or drop them first\n');
    for (const args of [
      [],
      ['start', BRANCH],
      ['finish'],
      ['finish', BRANCH, 'x'],
      ['finish', BRANCH, '--bogus'],
    ]) {
      assert.equal(cli(...args).status, 2, args.join(' '));
    }
  });
});
