import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { packedExports, withJsExtensions } from '../pack-typescript.mjs';

test('the packed exports cover every source entry with JavaScript and declarations', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../implementations/typescript/package.json', import.meta.url), 'utf8')
  );
  assert.deepEqual(manifest.publishConfig.exports, packedExports(manifest.exports));
  assert.deepEqual(packedExports({ './one': './src/one.ts', './package.json': './package.json' }), {
    './one': { types: './dist/one.d.ts', default: './dist/one.js' },
    './package.json': './package.json',
  });
  assert.throws(() => packedExports({ './one': './one.js' }), /no source module/);
});

test('relative ESM imports and declaration queries name JavaScript, while packages and extensions stay', () => {
  const source = [
    "import { one } from './one';",
    "export type { Two } from '../two';",
    'type Three = import("./three").Three;',
    "const four = import('../four');",
    "import './side-effect';",
    "import { readFileSync } from 'node:fs';",
    "export { five } from './five.js';",
    "import six from './six.json' with { type: 'json' };",
    "import { seven } from '@scope/seven';",
  ].join('\n');
  assert.equal(
    withJsExtensions(source),
    source
      .replace("'./one'", "'./one.js'")
      .replace("'../two'", "'../two.js'")
      .replace('"./three"', '"./three.js"')
      .replace("'../four'", "'../four.js'")
      .replace("'./side-effect'", "'./side-effect.js'")
  );
});
