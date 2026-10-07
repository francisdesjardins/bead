import { defineConfig } from '@playwright/test';
import { COMPONENT_TIMEOUT, playwrightBase } from './tools/playwright-base.mjs';

/**
 * The DevTools extension's tests, apart from the package's unit project, whose claim that nothing
 * under test needs a page they would break.
 *
 * Two projects: `unit`, its pure modules in Node; and `extension`, which loads `devtools/dist/` in
 * Chromium against the demo's static build, and opens the panel as a page on a fake DevTools API.
 * `yarn devtools:build` and `yarn playground:build:file` make what the second loads.
 */
export default defineConfig({
  ...playwrightBase(),
  testDir: './devtools',
  projects: [
    {
      name: 'unit',
      testMatch: ['**/__tests__/{exposition,preview,records,wire}.test.ts'],
    },
    {
      name: 'extension',
      testMatch: ['**/__tests__/{hook,panel}.test.ts'],
      timeout: COMPONENT_TIMEOUT,
    },
  ],
});
