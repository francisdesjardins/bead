import { spawnSync } from 'node:child_process';

export const GIT_FLOOR = '2.56';

// the tooling's Git floor, with the installed version and an upgrade command on refusal
export const requireGitFloor = (run = spawnSync) => {
  const result = run('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const found =
    result.stdout?.trim() || result.error?.message || result.stderr?.trim() || 'unknown';
  const version = /^git version (\d+)\.(\d+)(?:\.|\s|$)/.exec(found);
  const [major, minor] = GIT_FLOOR.split('.').map(Number);
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    version === null ||
    Number(version[1]) < major ||
    (Number(version[1]) === major && Number(version[2]) < minor)
  ) {
    throw new Error(
      `Git ${GIT_FLOOR} or newer is required; found ${found}. Upgrade Git (Git for Windows: winget upgrade --id Git.Git).`
    );
  }
};
