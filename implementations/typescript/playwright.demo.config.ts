import { defineConfig } from '@playwright/test';
import { COMPONENT_TIMEOUT, playwrightBase } from './tools/playwright-base.mjs';

/**
 * The demo's tests, apart from the package's unit project, whose claim that nothing under test
 * needs a page they would break.
 *
 * Two projects: `unit`, its procedures in Node, offered on a server joined in memory to a client;
 * and `page`, the demo's static build in Chromium, its server the page's worker.
 * `yarn playground:build:file` makes what the second loads.
 */
export default defineConfig({
  ...playwrightBase(),
  testDir: './demo',
  projects: [
    {
      name: 'unit',
      testIgnore: ['**/__tests__/sign-up.test.ts'],
      testMatch: ['**/__tests__/*.test.ts'],
    },
    {
      name: 'page',
      testMatch: ['**/__tests__/sign-up.test.ts'],
      timeout: COMPONENT_TIMEOUT,
      use: { browserName: 'chromium' },
    },
  ],
});
