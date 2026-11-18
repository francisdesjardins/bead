#!/usr/bin/env node
// A feature branch finished as git-flow finishes one (decision 0009), once CI has passed on it:
// merged into develop, develop pushed, and the branch deleted once CI has passed on the merge. It
// never pushes main or a tag, and never touches a release or a hotfix, which `git flow` and
// tools/release.mjs finish.
//
//   node tools/flow.mjs finish <feature/name> [--repo <path>] [--dry-run]
//
// From a clone on develop, or the clone --repo names. Each step is checked before the next:
//   1. the branch is a feature/* branch on origin, after a fetch; develop is clean and at
//      origin/develop; the branch is not merged yet; a local branch of that name holds nothing
//      origin's lacks; a worktree that has it checked out is clean; and a run of CI's ci.yml for
//      origin's head of the branch passed, a run still going awaited by its id;
//   2. that head is merged into develop with --no-ff, git's hooks run; a conflict is left to the
//      human, as git leaves it;
//   3. develop is pushed, and CI's run of the merge awaited by its id; a run cancelled because a
//      newer push superseded it gives way to the newest run whose commit contains the merge;
//   4. on that run's success alone, origin's branch, a worktree that has it checked out (its
//      node_modules folders first) and the local branch are deleted; on its failure, the failed
//      jobs are named and nothing is deleted.
// Every call to gh goes through one function, which a test replaces. `--dry-run` fetches, makes
// every check and says what it would do; it changes nothing else.
// Exit 1 on a refusal; exit 2 on a usage error.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const REMOTE = 'origin';
const DEVELOP = 'develop';
const WORKFLOW = 'ci.yml';
const FEATURE = /^feature\/./;
const FLOWED = /^(release|hotfix)\//;
const BUFFER = 64 * 1024 * 1024;
// a run is polled every 30 seconds, and a run of develop's merge is looked for 20 times before the
// tool gives up on it
const INTERVAL = 30_000;
const APPEARANCES = 20;
// the conclusions of a job that did not fail
const PASSED = new Set(['success', 'skipped', 'neutral']);

// ── Commands ──────────────────────────────────────────────────────────────────

// the one line of a command's output that says why it failed
const reasonOf = (text) => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return (
    lines.find((line) => /^(fatal|error):|\[rejected\]|\[remote rejected\]/.test(line)) ??
    lines[0] ??
    ''
  );
};

const short = (sha) => {
  return sha.slice(0, 7);
};

// one git command, its status and its output; a merge's message is never opened in an editor
const gitRun = (root, args) => {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: BUFFER,
    env: { ...process.env, GIT_MERGE_AUTOEDIT: 'no' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) {
    throw new Error(`git: ${result.error.message}`);
  }
  return result;
};

// a git command that must succeed: its output, trimmed; its failure, one line
const git = (root, args) => {
  const { status, stdout, stderr } = gitRun(root, args);
  if (status !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${reasonOf(stderr) || reasonOf(stdout) || `exit ${status}`}`
    );
  }
  return stdout.trim();
};

// whether git holds `ref`, and the commit it names
const commitOf = (root, ref) => {
  const { status, stdout } = gitRun(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return status === 0 ? stdout.trim() : null;
};

// ! exit 1 says no, and anything else, a commit git does not hold, is no either: never a yes
const isAncestor = (root, { ancestor, of }) => {
  return gitRun(root, ['merge-base', '--is-ancestor', ancestor, of]).status === 0;
};

// * every call to gh goes through this one, which a test replaces: its output, or its failure in
// one line
export const runGh = (root, args) => {
  const result = spawnSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) {
    throw new Error(
      result.error.code === 'ENOENT' ? 'gh is not installed' : `gh: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${reasonOf(result.stderr)}`);
  }
  return result.stdout;
};

// ── Worktrees ─────────────────────────────────────────────────────────────────

// each worktree of the clone, as `git worktree list --porcelain` gives it, the main one first
const worktreesOf = (root) => {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split(/\n\s*\n/)
    .filter((block) => block.trim() !== '')
    .map((block, index) => {
      const fields = new Map(
        block.split('\n').map((line) => {
          const space = line.indexOf(' ');
          return space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
        })
      );
      return {
        path: fields.get('worktree'),
        branch: fields.get('branch') ?? null,
        locked: fields.has('locked'),
        main: index === 0,
      };
    });
};

const realOf = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

const isInside = (path, folder) => {
  const way = relative(realOf(folder), realOf(path));
  return way === '' || (!way.startsWith('..') && !isAbsolute(way));
};

// the node_modules folders under a folder, none inside another, and nothing under .git
const nodeModulesUnder = (folder) => {
  const found = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') {
        continue;
      }
      if (entry.name === 'node_modules') {
        found.push(join(path, entry.name));
      } else {
        walk(join(path, entry.name));
      }
    }
  };
  walk(folder);
  return found;
};

// ! git's own removal fails on Windows where a path runs past MAX_PATH, as node_modules' do; Node's
// removal does not, so the node_modules folders go first, and the folder by Node where git refused
// ! a folder a process still holds, a shell's or an editor's, refuses its removal (EPERM on Windows):
// the removal is left as it stands, and its caller says what is left to do
const removeWorktree = (root, path) => {
  const folders = nodeModulesUnder(path);
  try {
    for (const folder of folders) {
      rmSync(folder, { recursive: true, force: true, maxRetries: 10 });
    }
    if (gitRun(root, ['worktree', 'remove', path]).status !== 0) {
      rmSync(path, { recursive: true, force: true, maxRetries: 10 });
    }
  } catch {
    // the folder stays, and finish names it
  }
  git(root, ['worktree', 'prune']);
  return folders.length;
};

// ── CI ────────────────────────────────────────────────────────────────────────

const FIELDS = 'databaseId,headSha,status,conclusion';

// a branch's runs of ci.yml, the newest first
const runsOf = (context, branch) => {
  return JSON.parse(
    context.gh([
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--branch',
      branch,
      '--limit',
      '50',
      '--json',
      FIELDS,
    ])
  );
};

const viewOf = (context, id) => {
  return JSON.parse(context.gh(['run', 'view', String(id), '--json', `${FIELDS},jobs`]));
};

// a run, awaited by its id until it completes
const settled = async (context, run) => {
  let current = run;
  let said = false;
  while (current.status !== 'completed') {
    if (!said) {
      context.log(
        `waiting: run ${current.databaseId} (${current.status}), polled every ${context.interval / 1000} s`
      );
      said = true;
    }
    await context.sleep(context.interval);
    current = viewOf(context, current.databaseId);
  }
  return current;
};

// the jobs of a run that did not pass, by name
const failedJobs = (context, run) => {
  const jobs = run.jobs ?? viewOf(context, run.databaseId).jobs ?? [];
  const failed = jobs
    .filter((job) => !PASSED.has(job.conclusion))
    .map((job) => {
      return job.name;
    });
  return failed.length > 0 ? failed.join(', ') : 'no job named';
};

// ! of the runs of one commit, a success wins, then a run still going, then the newest
const chosen = (runs, sha) => {
  const own = runs.filter((run) => run.headSha === sha);
  return (
    own.find((run) => run.status === 'completed' && run.conclusion === 'success') ??
    own.find((run) => run.status !== 'completed') ??
    own[0]
  );
};

// the branch's head passed CI, or a refusal
const branchPassed = async (context, { branch, sha }) => {
  const run = chosen(runsOf(context, branch), sha);
  if (run === undefined) {
    throw new Error(
      `${branch}: no run of ${WORKFLOW} for its head ${short(sha)}; push it, or wait for its run to start`
    );
  }
  const done = await settled(context, run);
  if (done.conclusion === 'success') {
    return done;
  }
  if (done.conclusion === 'cancelled') {
    throw new Error(
      `${branch}: run ${done.databaseId} for ${short(sha)} was cancelled, neither failed nor passed; a newer run is needed (gh run rerun ${done.databaseId})`
    );
  }
  throw new Error(
    `${branch}: run ${done.databaseId} for ${short(sha)} ended ${done.conclusion}: ${failedJobs(context, done)}`
  );
};

// develop's runs whose commit contains the merge, the newest first, after a fetch brings each
// commit they name
const runsContaining = (context, merge) => {
  git(context.root, ['fetch', '--quiet', REMOTE]);
  return runsOf(context, DEVELOP).filter((run) => {
    return isAncestor(context.root, { ancestor: merge, of: run.headSha });
  });
};

// develop's run of the merge passed CI, or a refusal; a run a newer push superseded gives way to
// the newest that contains the merge
const developPassed = async (context, merge) => {
  let run;
  for (let look = 1; ; look += 1) {
    const runs = runsContaining(context, merge);
    run = runs.find((each) => each.headSha === merge) ?? runs[0];
    if (run !== undefined) {
      break;
    }
    if (look >= context.appearances) {
      throw new Error(
        `develop: no run of ${WORKFLOW} contains the merge ${short(merge)} after ${look} looks; nothing deleted`
      );
    }
    await context.sleep(context.interval);
  }
  if (run.headSha !== merge) {
    context.log(
      `CI: no run of develop for ${short(merge)} listed; run ${run.databaseId} of ${short(run.headSha)} contains it, followed instead`
    );
  }
  for (;;) {
    const done = await settled(context, run);
    if (done.conclusion === 'success') {
      return done;
    }
    if (done.conclusion !== 'cancelled') {
      throw new Error(
        `develop: run ${done.databaseId} for ${short(done.headSha)} ended ${done.conclusion}: ${failedJobs(context, done)}; nothing deleted`
      );
    }
    const newer = runsContaining(context, merge)
      .filter((each) => each.databaseId > done.databaseId)
      .sort((a, b) => b.databaseId - a.databaseId)[0];
    if (newer === undefined) {
      throw new Error(
        `develop: run ${done.databaseId} for ${short(done.headSha)} was cancelled, and no newer run contains the merge; a newer run is needed (gh run rerun ${done.databaseId}); nothing deleted`
      );
    }
    context.log(
      `CI: develop's run ${done.databaseId} was cancelled, superseded by run ${newer.databaseId} of ${short(newer.headSha)}, which contains the merge; following it`
    );
    run = newer;
  }
};

// ── Finish ────────────────────────────────────────────────────────────────────

// what the branch's deletion meets: its worktrees, each clean, and the local branch, holding
// nothing origin's lacks
const deletable = (root, { branch, sha, cwd }) => {
  const worktrees = worktreesOf(root).filter((worktree) => {
    return worktree.branch === `refs/heads/${branch}`;
  });
  for (const worktree of worktrees) {
    if (worktree.main) {
      throw new Error(
        `${branch} is checked out in the main worktree, ${worktree.path}: check out develop there`
      );
    }
    if (worktree.locked) {
      throw new Error(
        `the worktree ${worktree.path} that has ${branch} checked out is locked: git worktree unlock it first`
      );
    }
    if (!existsSync(worktree.path)) {
      continue;
    }
    if (isInside(cwd, worktree.path)) {
      throw new Error(
        `this command runs inside the worktree ${worktree.path} it would remove: run it from elsewhere, with --repo`
      );
    }
    if (git(worktree.path, ['status', '--porcelain']) !== '') {
      throw new Error(
        `the worktree ${worktree.path} that has ${branch} checked out has changes: commit or drop them first`
      );
    }
  }
  const local = commitOf(root, `refs/heads/${branch}`);
  if (local !== null && !isAncestor(root, { ancestor: local, of: sha })) {
    throw new Error(
      `the local ${branch}, at ${short(local)}, holds commits origin's lacks: push them, then finish`
    );
  }
  return { worktrees, local };
};

// finishes a feature branch, each step checked before the next
//   branch      feature/<name>, required
//   dryRun      every check, and what it would do; nothing changed but a fetch
//   gh          runs gh with its arguments and gives its output; runGh by default
//   log         prints a line
//   sleep       waits some milliseconds
//   interval    between two polls of a run, in milliseconds
//   appearances how many times develop's runs are looked for one of the merge
//   cwd         where the command runs, which a worktree it removes must not hold
export const finish = async (root, options) => {
  const {
    branch,
    dryRun = false,
    log = console.log,
    sleep = delay,
    interval = INTERVAL,
    appearances = APPEARANCES,
    cwd = process.cwd(),
  } = options;
  const gh =
    options.gh ??
    ((args) => {
      return runGh(root, args);
    });
  const context = { root, gh, log, sleep, interval, appearances };

  // 1. the checks, before anything changes
  if (typeof branch !== 'string' || branch === '') {
    throw new Error('a feature/* branch to finish is required');
  }
  if (FLOWED.test(branch)) {
    throw new Error(
      `${branch}: a release or a hotfix is finished by git flow and tools/release.mjs (README, Releasing), never by this tool`
    );
  }
  if (
    !FEATURE.test(branch) ||
    gitRun(root, ['check-ref-format', '--branch', branch]).status !== 0
  ) {
    throw new Error(`${branch}: not a feature/* branch`);
  }
  const head = gitRun(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
  if (head !== DEVELOP) {
    throw new Error(
      `the clone ${root} is on ${head || 'a detached HEAD'}, not develop: check out develop, or name a clone on it with --repo`
    );
  }
  git(root, ['fetch', '--quiet', '--prune', REMOTE]);
  const sha = commitOf(root, `refs/remotes/${REMOTE}/${branch}`);
  if (sha === null) {
    throw new Error(`${branch}: no such branch on ${REMOTE}; publish it first`);
  }
  log(`origin: ${branch} at ${short(sha)}`);
  if (git(root, ['status', '--porcelain']) !== '') {
    throw new Error('develop has changes: commit, stash or drop them first');
  }
  const develop = commitOf(root, `refs/heads/${DEVELOP}`);
  const remoteDevelop = commitOf(root, `refs/remotes/${REMOTE}/${DEVELOP}`);
  if (develop !== remoteDevelop) {
    throw new Error(
      `develop, at ${short(develop)}, is not origin/develop, at ${remoteDevelop === null ? 'nothing' : short(remoteDevelop)}: pull or push it first`
    );
  }
  log(`develop: clean, at origin/develop (${short(develop)})`);
  if (isAncestor(root, { ancestor: sha, of: develop })) {
    throw new Error(`${branch}: already merged into develop`);
  }
  const { worktrees } = deletable(root, { branch, sha, cwd });
  const judged = await branchPassed(context, { branch, sha });
  log(`CI: run ${judged.databaseId} passed for ${branch} at ${short(sha)}`);
  // the run may have taken a while: origin's head is the one it judged, or nothing goes on
  git(root, ['fetch', '--quiet', '--prune', REMOTE]);
  const now = commitOf(root, `refs/remotes/${REMOTE}/${branch}`);
  if (now !== sha) {
    throw new Error(
      `${branch} moved on ${REMOTE} to ${now === null ? 'nothing' : short(now)} while its run was awaited: run this again`
    );
  }

  const removable = worktrees.filter((worktree) => existsSync(worktree.path));
  const deletions = [
    `${REMOTE}'s ${branch}`,
    ...removable.map((worktree) => `the worktree ${worktree.path}, its node_modules first`),
    `the local ${branch}`,
  ];
  if (dryRun) {
    log(
      `dry run: would merge ${branch} (${short(sha)}) into develop with --no-ff, push develop, await its run of ${WORKFLOW}, then delete ${deletions.join(', ')}`
    );
    return { sha, merge: null, dryRun: true };
  }

  // 2. the merge, of the very commit CI judged, git's hooks run
  const merging = gitRun(root, [
    'merge',
    '--no-ff',
    '-m',
    `Merge branch '${branch}' into ${DEVELOP}`,
    sha,
  ]);
  if (merging.status !== 0) {
    const conflicted = git(root, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n')
      .filter((path) => path !== '');
    const pending = commitOf(root, 'MERGE_HEAD') !== null;
    if (conflicted.length > 0) {
      throw new Error(
        `merging ${branch} into develop conflicts in ${conflicted.join(', ')}: the merge is left to you, to resolve and commit, or to git merge --abort`
      );
    }
    const reason = reasonOf(merging.stderr) || reasonOf(merging.stdout);
    throw new Error(
      pending
        ? `the merge of ${branch} stopped (${reason}): it is left as it stands, git status shows where`
        : `the merge of ${branch} failed: ${reason}`
    );
  }
  const merge = git(root, ['rev-parse', 'HEAD']);
  log(`merged: ${branch} into develop at ${short(merge)}`);

  // 3. develop pushed, alone and by its full name, never a tag beside it
  const pushing = gitRun(root, [
    'push',
    '--no-follow-tags',
    REMOTE,
    `refs/heads/${DEVELOP}:refs/heads/${DEVELOP}`,
  ]);
  if (pushing.status !== 0) {
    throw new Error(
      `the push of develop was refused (${reasonOf(pushing.stderr)}): develop holds the merge ${short(merge)}, unpushed`
    );
  }
  log(`pushed: develop at ${short(merge)}`);
  const passed = await developPassed(context, merge);
  log(`CI: run ${passed.databaseId} passed for develop at ${short(passed.headSha)}`);

  // 4. the deletions, on develop's success alone; a worktree is held to its checks again, since a
  // run can take long enough for someone to work in it
  try {
    deletable(root, { branch, sha, cwd });
  } catch (error) {
    throw new Error(
      `develop passed, but ${error.message}; nothing deleted: delete ${deletions.join(', ')} by hand`
    );
  }
  // ! leased on the head CI judged: a commit pushed since is never deleted
  const deleting = gitRun(root, [
    'push',
    '--no-follow-tags',
    `--force-with-lease=refs/heads/${branch}:${sha}`,
    REMOTE,
    `:refs/heads/${branch}`,
  ]);
  if (deleting.status !== 0) {
    throw new Error(
      `the deletion of ${REMOTE}'s ${branch} was refused (${reasonOf(deleting.stderr)}): nothing deleted`
    );
  }
  log(`deleted: ${REMOTE}'s ${branch}`);
  for (const worktree of worktrees) {
    if (!existsSync(worktree.path)) {
      git(root, ['worktree', 'prune']);
      continue;
    }
    const count = removeWorktree(root, worktree.path);
    if (existsSync(worktree.path)) {
      throw new Error(
        `merged, pushed and ${REMOTE}'s ${branch} deleted, but the worktree ${worktree.path} is ` +
          `still there, something running in it holding it: once nothing does, remove the folder, ` +
          `then git worktree prune and git branch -d ${branch}`
      );
    }
    log(`removed: the worktree ${worktree.path}, ${count} node_modules folders first`);
  }
  if (commitOf(root, `refs/heads/${branch}`) !== null) {
    git(root, ['branch', '-d', branch]);
    log(`deleted: the local ${branch}`);
  }
  if (passed.headSha !== merge) {
    log(`develop: origin's has moved past the merge; git pull --ff-only brings it here`);
  }
  return { sha, merge, run: passed.databaseId, dryRun: false };
};

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const usage = () => {
    console.error('usage: node tools/flow.mjs finish <feature/name> [--repo <path>] [--dry-run]');
    process.exit(2);
  };
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    });
  } catch (error) {
    console.error(`flow: ${error.message}`);
    usage();
  }
  const { values, positionals } = parsed;
  const [command, branch, ...rest] = positionals;
  if (command !== 'finish' || branch === undefined || rest.length > 0) {
    usage();
  }
  try {
    const where = values.repo === undefined ? process.cwd() : resolve(values.repo);
    if (!existsSync(where)) {
      throw new Error(`${where}: no such folder`);
    }
    const root = git(where, ['rev-parse', '--show-toplevel']);
    await finish(root, { branch, dryRun: values['dry-run'] });
  } catch (error) {
    console.error(`flow: ${error.message}`);
    process.exit(1);
  }
}
