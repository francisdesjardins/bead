import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { CONFIG_FILE } from '../config.ts';
import { findConfig } from '../config-files.ts';

test('finds the beadc.yaml nearest a folder, upward', () => {
  const project = test.info().outputPath('project');
  const nested = join(project, 'proto', 'hello', 'v1');
  const inner = join(project, 'proto', CONFIG_FILE);

  mkdirSync(nested, { recursive: true });
  writeFileSync(join(project, CONFIG_FILE), 'version: 1\n');

  expect(findConfig(nested)).toBe(join(project, CONFIG_FILE));
  expect(findConfig(project)).toBe(join(project, CONFIG_FILE));

  writeFileSync(inner, 'version: 1\n');
  expect(findConfig(nested)).toBe(inner);
});
