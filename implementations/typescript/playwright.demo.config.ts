import { defineConfig } from '@playwright/test';
import { COMPONENT_TIMEOUT, playwrightBase } from './tools/playwright-base.mjs';

/** The tests that load the demo's page: the page's own, and each of a module it mounts. */
const PAGE_TESTS = ['page', 'scenes', 'sides', 'sign-up', 'tabs'].map((name) => {
  return `**/__tests__/${name}.test.ts`;
});

/**
 * The demo's tests, apart from the package's unit project, whose claim that nothing under test
 * needs a page they would break.
 *
 * Two projects: `unit`, its procedures in Node, offered on a server joined in memory to a client;
 * and `page`, the demo's page in Chromium: its static build, its server the page's worker, which
 * `yarn playground:build:file` makes; or, over MQTT 5, as its launcher serves it beside a broker.
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
