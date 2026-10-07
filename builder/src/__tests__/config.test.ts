import path from 'node:path';

import { expect, test } from '@playwright/test';

import { isInside, parseConfig } from '../config.ts';
import { InputError } from '../diagnostics.ts';

test("a path outside the folder is refused in Windows' forms, a backslash, a drive letter and a second drive, through path.win32", () => {
  const folder = 'C:\\work\\project';
  const win32 = path.win32;

  expect(isInside(folder, { target: 'proto', path: win32 })).toBe(true);
  expect(isInside(folder, { target: 'proto\\bead\\v1', path: win32 })).toBe(true);
  expect(isInside(folder, { target: 'C:\\work\\project\\proto', path: win32 })).toBe(true);
  expect(isInside(folder, { target: 'c:\\WORK\\Project\\proto', path: win32 })).toBe(true);
  expect(isInside(folder, { target: '..\\other', path: win32 })).toBe(false);
  expect(isInside(folder, { target: 'proto\\..\\..\\other', path: win32 })).toBe(false);
  expect(isInside(folder, { target: 'C:\\work\\other', path: win32 })).toBe(false);
  expect(isInside(folder, { target: 'D:\\project\\proto', path: win32 })).toBe(false);
  expect(isInside(folder, { target: '\\\\server\\share\\proto', path: win32 })).toBe(false);
  expect(() => {
    return parseConfig('version: 1\nsource:\n  proto: [D:\\proto]\n', { folder, path: win32 });
  }).toThrow(/outside the folder that holds beadc\.yaml.*move beadc\.yaml up/u);
  expect(
    parseConfig('version: 1\nsource:\n  proto: [proto]\nblueprint: gen\\bead.json\n', {
      folder,
      path: win32,
    })
  ).toEqual({
    folder,
    source: { proto: ['C:\\work\\project\\proto'] },
    blueprint: 'C:\\work\\project\\gen\\bead.json',
  });
});

test('reads its version, its source and its blueprint, each path under its folder', () => {
  const folder = '/work';
  const posix = path.posix;

  expect(parseConfig('version: 1\nsource:\n  proto: proto\n', { folder, path: posix })).toEqual({
    folder,
    source: { proto: ['/work/proto'] },
  });
  expect(
    parseConfig('version: 1\nsource:\n  blueprint: spec/a.json\n', { folder, path: posix })
  ).toEqual({ folder, source: { blueprint: '/work/spec/a.json' } });
  expect(isInside(folder, { target: '../other', path: posix })).toBe(false);
  expect(isInside(folder, { target: '/elsewhere', path: posix })).toBe(false);
});

test('refuses a key it does not read, and a source of neither or both kinds', () => {
  const refused = [
    'version: 1\nsource:\n  proto: [proto]\noutputs: []\n',
    'version: 2\nsource:\n  proto: [proto]\n',
    'version: 1\nsource:\n  proto: [proto]\n  blueprint: a.json\n',
    'version: 1\nsource: {}\n',
    'version: 1\nsource:\n  blueprint: a.json\nblueprint: b.json\n',
    'version: 1\nsource:\n  protos: [proto]\n',
    '- a list\n',
    'version: [1\n',
  ];

  for (const text of refused) {
    expect(() => {
      return parseConfig(text, { folder: '/work', path: path.posix });
    }, text).toThrow(InputError);
  }
});
