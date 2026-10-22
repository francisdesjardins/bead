import { defineConfig } from '@playwright/test';
import { COMPONENT_TIMEOUT, playwrightBase } from './tools/playwright-base.mjs';

/** The tests that load the demo's page, each of a module the page mounts. */
const PAGE_TESTS = ['scenes', 'sides', 'sign-up', 'tabs'].map((name) => {
  return `**/__tests__/${name}.test.ts`;
});

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
      testIgnore: PAGE_TESTS,
      testMatch: ['**/__tests__/*.test.ts'],
    },
    {
      name: 'page',
      testMatch: PAGE_TESTS,
      timeout: COMPONENT_TIMEOUT,
      use: { browserName: 'chromium' },
    },
  ],
});
