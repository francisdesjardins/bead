import { defineConfig } from '@playwright/test';
import { playwrightBase } from './tools/playwright-base.mjs';

/**
 * Unit projects only, and no `webServer`.
 *
 * Every module here is framework-free by the package's own rule, so nothing under test needs a page,
 * a bundler or a server to answer for it. What a browser reads of the HTTP transport, the one claim
 * only a page proves, has a config of its own, `playwright.browser.config.ts`.
 */
export default defineConfig({
  ...playwrightBase(),
  testDir: './src',
  testMatch: ['**/__tests__/**/*.test.ts'],
  projects: [{ name: 'unit' }],
});
