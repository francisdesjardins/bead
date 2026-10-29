import type { Page } from '@playwright/test';
import { build } from 'esbuild';

/** A view and the panel's filter, bundled on a page without the extension's host. */
export const loadView = async (page: Page, module: string): Promise<void> => {
  const result = await build({
    bundle: true,
    stdin: {
      contents: `export * from './devtools/views/${module}'; export {keeperOf} from './devtools/model/filter'; export {replaceKeeping} from './devtools/views/dom';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    format: 'iife',
    globalName: 'view',
    platform: 'browser',
    write: false,
  });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: result.outputFiles[0]?.text ?? '' });
};
