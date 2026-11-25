import { defineConfig } from '@playwright/test';
import { COMPONENT_TIMEOUT, playwrightBase } from './tools/playwright-base.mjs';

/**
 * The DevTools extension's tests, apart from the package's unit project, whose claim that nothing
 * under test needs a page they would break.
 *
 * Two projects: `unit`, its pure modules in Node, the panel's model among them; and `extension`,
 * which loads `devtools/dist/` in Chromium against the demo's static build, opens the panel as a
 * page on a fake DevTools API, and runs the extension's scripts on a fake of Chrome's runtime.
 * `yarn devtools:build` and `yarn playground:build:file` make what the second loads.
 */
export default defineConfig({
  ...playwrightBase(),
  testDir: './devtools',
  projects: [
    {
      name: 'unit',
      testIgnore: [
        '**/__tests__/{hook,panel}.test.ts',
        '**/views/__tests__/*.test.ts',
        '**/chrome/__tests__/*.test.ts',
      ],
      testMatch: ['**/__tests__/*.test.ts'],
    },
    // the skin the page, the demo and the panel share: its mascot's pure core, in Node
    {
      name: 'skin',
      testDir: './skin',
      testMatch: ['**/__tests__/*.test.ts'],
    },
    {
      name: 'extension',
      testMatch: [
        '**/__tests__/{hook,panel}.test.ts',
        '**/views/__tests__/*.test.ts',
        '**/chrome/__tests__/*.test.ts',
      ],
      timeout: COMPONENT_TIMEOUT,
    },
  ],
});
