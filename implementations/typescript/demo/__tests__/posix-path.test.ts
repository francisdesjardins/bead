import { posix } from 'node:path';
import { expect, test } from '@playwright/test';
import { posixPath } from '../posix-path';

// constants

/** Paths as `parseConfig` hands them: its folder, absolute, then what `beadc.yaml` names. */
const JOINS: readonly (readonly string[])[] = [
  ['/project', 'beadc.yaml'],
  ['/project/', 'gen/typescript-client'],
  ['/project', './gen//x/../y/'],
  ['/', '..', 'a'],
  ['a', '', 'b'],
  ['../a', '../../b'],
  ['', ''],
  ['.', './'],
];

const RESOLVES: readonly (readonly string[])[] = [
  ['/project', 'gen/typescript-client'],
  ['/project', '/elsewhere/gen'],
  ['/project', '../outside'],
  ['/project', '../../../../root'],
  ['/project', './gen/./x/../y/'],
  ['/project/gen/x'],
  ['/project/gen/x/'],
  ['/'],
  ['/project', ''],
];

const RELATIVES: readonly (readonly [string, string])[] = [
  ['/project', '/project'],
  ['/project', '/project/gen/x'],
  ['/project/gen/x', '/project'],
  ['/project/gen/x', '/project/gen/y'],
  ['/project', '/other'],
  ['/', '/project'],
  ['/project/gen/', '/project/gen/x/'],
];

// definition

test.describe('posixPath', () => {
  test('joins, resolves and relates as node:path.posix does', () => {
    for (const paths of JOINS) {
      expect(posixPath.join(...paths), JSON.stringify(paths)).toBe(posix.join(...paths));
    }

    for (const paths of RESOLVES) {
      expect(posixPath.resolve(...paths), JSON.stringify(paths)).toBe(posix.resolve(...paths));
    }

    for (const [from, to] of RELATIVES) {
      expect(posixPath.relative(from, to), `${from} → ${to}`).toBe(posix.relative(from, to));
    }
  });

  test('tells an absolute path as node:path.posix does, and separates by /', () => {
    for (const path of ['/project', 'project', './project', '../project', '', 'C:\\project']) {
      expect(posixPath.isAbsolute(path), path).toBe(posix.isAbsolute(path));
    }

    expect(posixPath.sep).toBe(posix.sep);
  });

  test('resolves a path no segment makes absolute under /, where a page has no working directory', () => {
    expect(posixPath.resolve('gen', 'x')).toBe('/gen/x');
    expect(posixPath.resolve('')).toBe('/');
  });
});
