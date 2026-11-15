import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';

/** What a view is loaded on. */
export interface IViewOptions {
  /** The panel's own page and its sheets, in this scheme, in place of a bare `#root`. */
  scheme?: 'dark' | 'light' | undefined;
}

/** The panel's page, its sheets inlined and its script left out, so a view draws as it does there. */
const panelPageOf = async (scheme: 'dark' | 'light'): Promise<string> => {
  const html = await readFile('devtools/panel.html', 'utf8');
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)" \/>/g)];
  let page = html
    .replace('<html lang="en">', `<html lang="en" data-color-scheme="${scheme}">`)
    .replace('<script src="panel.js"></script>', '');

  for (const [link, href] of links) {
    page = page.replace(link, `<style>${await readFile(`devtools/${href ?? ''}`, 'utf8')}</style>`);
  }

  return page;
};

/** Views and the panel's filter, bundled on a page without the extension's host. */
export const loadView = async (
  page: Page,
  module: string | readonly string[],
  options: IViewOptions = {}
): Promise<void> => {
  const modules = typeof module === 'string' ? [module] : module;
  const result = await build({
    bundle: true,
    stdin: {
      contents: `${modules
        .map((name) => {
          return `export * from './devtools/views/${name}';`;
        })
        .join(
          ' '
        )} export {keeperOf} from './devtools/model/filter'; export {replaceKeeping} from './devtools/views/dom';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    format: 'iife',
    globalName: 'view',
    platform: 'browser',
    write: false,
  });
  await page.setContent(
    options.scheme === undefined ? '<main id="root"></main>' : await panelPageOf(options.scheme)
  );
  await page.addScriptTag({ content: result.outputFiles[0]?.text ?? '' });
};
