#!/usr/bin/env node
// Every commit subject follows Conventional Commits 1.0.0: `type(scope)!: description`, the scope
// and the `!` optional. Merge commits are left out: git-flow's `finish` writes them, and their
// subjects are git's own.
//
//   node tools/check-commits.mjs <revision range…>   the commits git log lists for that range
//   node tools/check-commits.mjs --stdin             one subject per line, from standard input
//   node tools/check-commits.mjs --message <file>    the message git is about to record
//
// Exit 1 on a subject that does not follow it; a range git cannot read fails with git's error. A
// message must be UTF-8 without a byte order mark, which git records as it is: one written as UTF-16
// would reach the history as bytes no one can read.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// the types of the Angular convention, which Conventional Commits names as its example
const TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
];

const SUBJECT = new RegExp(`^(?:${TYPES.join('|')})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`);

const args = process.argv.slice(2);
if (args.length === 0 || (args[0] === '--message' && args.length !== 2)) {
  console.error('commits: give a revision range, --stdin, or --message <file>');
  process.exit(2);
}

// the subject of the message in a file, as commit-msg hands it over: its first line that is
// neither empty nor one of git's comments; none for a merge, which keeps git's own subject
const subjectOf = (file) => {
  const bytes = readFileSync(file);
  if (bytes.includes(0)) {
    console.error(
      `commits: ${file} is not UTF-8 text: it holds NUL bytes, as UTF-16 does. Write the message as UTF-8.`
    );
    process.exit(1);
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    console.error(
      `commits: ${file} starts with a byte order mark, which git would record. Write the message as UTF-8 without one.`
    );
    process.exit(1);
  }
  const subject = bytes
    .toString('utf8')
    .split(/\r?\n/)
    .find((line) => line.trim() !== '' && !line.startsWith('#'));
  return subject === undefined || subject.startsWith('Merge ') ? [] : [['subject', subject]];
};

// [label, subject] for each commit
const commits =
  args[0] === '--message'
    ? subjectOf(args[1])
    : args[0] === '--stdin'
      ? readFileSync(0, 'utf8')
          .split(/\r?\n/)
          .filter((line) => line.trim() !== '')
          .map((subject, index) => [`line ${index + 1}`, subject])
      : execFileSync('git', ['log', '--no-merges', '--format=%h %s', ...args], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        })
          .split('\n')
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]);

// a push of a merge alone, as git-flow's `finish` makes, lists none; a range git cannot read has
// already failed above
if (commits.length === 0) {
  console.log(
    args[0] === '--message'
      ? `commits: ${args[1]} is a merge's message, or empty.`
      : `commits: no commit but merges in ${args.join(' ')}.`
  );
  process.exit(0);
}

const failures = commits.filter(([, subject]) => !SUBJECT.test(subject));

if (failures.length > 0) {
  console.error(
    `commits: ${failures.length} of ${commits.length} subject(s) not Conventional Commits:`
  );
  for (const [label, subject] of failures) {
    console.error(`  ${label}: ${subject}`);
  }
  console.error(`  expected: <${TYPES.join('|')}>(<scope>)?!?: <description>`);
  process.exit(1);
}

console.log(`commits: ${commits.length} subject(s), each a Conventional Commit.`);
