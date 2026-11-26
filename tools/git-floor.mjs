import { spawnSync } from 'node:child_process';

export const GIT_FLOOR = '2.56';

// the tooling's Git floor, refused with the version found
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
    throw new Error(`Git ${GIT_FLOOR} or newer is required; found ${found}.`);
  }
};
