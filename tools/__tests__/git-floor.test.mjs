import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GIT_FLOOR, requireGitFloor } from '../git-floor.mjs';

describe('the Git floor', () => {
  test('the floor and newer Git versions pass, including platform suffixes', () => {
    assert.equal(GIT_FLOOR, '2.56');
    for (const version of [
      '2.56',
      '2.56.0',
      '2.56.1.windows.1',
      '2.56.0 (Apple Git-1)',
      '2.100.0',
      '3.0.0',
    ]) {
      requireGitFloor((command, args) => {
        assert.equal(command, 'git');
        assert.deepEqual(args, ['--version']);
        return { status: 0, stdout: `git version ${version}\n` };
      });
    }
  });

  test('an older or unreadable version names the found version, floor and upgrade command', () => {
    for (const version of ['2.55.9', '2.9.0', '1.99.0', 'unreadable']) {
      assert.throws(
        () => {
          requireGitFloor(() => {
            return { status: 0, stdout: `git version ${version}\n` };
          });
        },
        {
          message: `Git 2.56 or newer is required; found git version ${version}. Upgrade Git (Git for Windows: winget upgrade --id Git.Git).`,
        }
      );
    }
  });

  test('a missing or failed Git command refuses with its reason and an upgrade command', () => {
    for (const result of [
      { status: null, error: new Error('spawn git ENOENT') },
      { status: 1, stderr: 'cannot run git' },
      { status: 1, stdout: 'git version 2.56.1' },
    ]) {
      assert.throws(() => {
        requireGitFloor(() => {
          return result;
        });
      }, /Git 2\.56 or newer is required; found .+\. Upgrade Git \(Git for Windows: winget upgrade --id Git\.Git\)\./);
    }
  });
});
