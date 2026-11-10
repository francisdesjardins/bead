import { defineConfig } from '@playwright/test';
import { COMPONENT_TIMEOUT, playwrightBase } from './tools/playwright-base.mjs';

/**
 * The HTTP client in a browser, apart from the package's unit project, whose claim that nothing
 * under test needs a page it would break.
 *
 * One project, Chromium: a page of one origin whose client calls the interop service's HTTP server
 * at another, on each side, which only a browser's reading of the CORS answer proves (spec 15.12).
 * The C# server needs .NET, so it runs where the interop does, in CI's .NET job; the Rust one is
 * the binary `BEAD_INTEROP_RUST_SERVER` names, built, and runs where it names one.
 */
export default defineConfig({
  ...playwrightBase(),
  testDir: './browser',
  testMatch: ['**/__tests__/**/*.test.ts'],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  timeout: COMPONENT_TIMEOUT,
});
