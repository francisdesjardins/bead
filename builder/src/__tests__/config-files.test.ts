import { execFileSync } from 'node:child_process';

import { test } from '@playwright/test';

// The filesystem seam lives in a child so parallel tests never see its replacement.
const workspaceRace = (folder: string, options: { removals: number; code?: string }): void => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import path from 'node:path';

        const [module, folder, scenario] = process.argv.slice(1);
        const { removals, code } = JSON.parse(scenario);
        const { temporaryFolderOf } = await import(module);
        const { BEADC_FOLDER } = await import(new URL('./config.ts', module).href);
        const own = path.join(folder, BEADC_FOLDER);
        const make = fs.mkdtempSync;
        let attempts = 0;
        let failure = Object.assign(new Error('filesystem refusal'), { code });

        fs.mkdtempSync = (prefix, encoding) => {
          assert.equal(path.dirname(prefix), own);
          attempts += 1;
          if (code !== undefined) {
            throw failure;
          }
          if (attempts <= removals) {
            // Only an empty parent goes, just as another invocation's cleanup removes it.
            fs.rmdirSync(own);
          }
          try {
            return make(prefix, encoding);
          } catch (error) {
            failure = error;
            throw error;
          }
        };
        syncBuiltinESMExports();

        try {
          if (removals >= 3 || code !== undefined) {
            assert.throws(() => { temporaryFolderOf('buf-', { folder }); },
              (error) => { return error === failure; });
            assert.equal(attempts, code === undefined ? 3 : 1);
            assert.equal(failure.code, code ?? 'ENOENT');
          } else {
            const made = temporaryFolderOf('buf-', { folder });
            assert.equal(attempts, removals + 1);
            assert.equal(path.dirname(made), own);
            assert.ok(path.basename(made).startsWith('buf-'));
            assert.deepEqual(fs.readdirSync(own), [path.basename(made)]);
            fs.rmdirSync(made);
          }
        } finally {
          fs.mkdtempSync = make;
          syncBuiltinESMExports();
        }
      `,
      new URL('../config-files.ts', import.meta.url).href,
      folder,
      JSON.stringify(options),
    ],
    { stdio: 'pipe' }
  );
};

test('creates a temporary folder after a concurrent cleanup removes its parent', () => {
  for (const removals of [1, 2]) {
    workspaceRace(test.info().outputPath(`project-${String(removals)}`), { removals });
  }
});

test('bounds temporary folder creation when concurrent cleanups keep removing its parent', () => {
  workspaceRace(test.info().outputPath('project'), { removals: 3 });
});

test('passes a temporary folder creation error other than ENOENT straight to its caller', () => {
  workspaceRace(test.info().outputPath('project'), { removals: 0, code: 'EACCES' });
});
