#!/usr/bin/env node
// The release tarball carries JavaScript and declarations, with relative ESM imports resolved by
// Node as well as a bundler. The source exports stay the inputs of the surface check.

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const packedExports = (exports) => {
  return Object.fromEntries(
    Object.entries(exports).map(([name, path]) => {
      if (path === './package.json') {
        return [name, path];
      }
      if (!path.startsWith('./src/') || !path.endsWith('.ts')) {
        throw new Error(`${name}: no source module at ${path}`);
      }
      const stem = path.replace('./src/', './dist/').slice(0, -3);
      return [name, { types: `${stem}.d.ts`, default: `${stem}.js` }];
    })
  );
};

// The compiler emits these module specifiers in JavaScript and declarations alike. Bare package
// imports keep their names; a relative source module names the .js file beside its declaration.
export const withJsExtensions = (text) => {
  return text.replace(
    /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"])(\.\.?\/[^'"\r\n]+)(['"])/g,
    (whole, before, path, after) => {
      return /\.[a-z]+$/i.test(path) ? whole : `${before}${path}.js${after}`;
    }
  );
};

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const folder = join(root, 'implementations/typescript');
  const out = join(folder, 'dist');
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  if (
    JSON.stringify(manifest.publishConfig.exports) !==
    JSON.stringify(packedExports(manifest.exports))
  ) {
    throw new Error(
      'publishConfig.exports must map every source export to its JavaScript and types'
    );
  }
  // ! only this package's generated dist, beneath its own folder, is replaced
  rmSync(out, { recursive: true, force: true });
  const built = spawnSync(
    process.execPath,
    ['node_modules/typescript-7/bin/tsc', '-p', 'tsconfig.pack.json'],
    { cwd: folder, stdio: 'inherit' }
  );
  if (built.status !== 0) {
    process.exit(built.status ?? 1);
  }
  for (const entry of readdirSync(out, { recursive: true })) {
    if (!entry.endsWith('.js') && !entry.endsWith('.d.ts')) {
      continue;
    }
    const path = join(out, entry);
    writeFileSync(path, withJsExtensions(readFileSync(path, 'utf8')));
  }
  copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
}
