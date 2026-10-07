import { defineConfig } from '@playwright/test';

import { playwrightBase } from '../implementations/typescript/tools/playwright-base.mjs';

/**
 * beadc's tests, unit tests without a browser, under the TypeScript side's CI posture: one test file
 * a module, in `__tests__/` beside it.
 */
export default defineConfig({
  ...playwrightBase(),
  testDir: './src',
  testMatch: ['**/__tests__/**/*.test.ts'],
  projects: [{ name: 'unit' }],
});
