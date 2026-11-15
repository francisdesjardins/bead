import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { buildPrivacy, policyRefusals } from '../build.mjs';

const MANIFEST = new URL(
  '../../implementations/typescript/devtools/chrome/manifest.json',
  import.meta.url
);

// ── The privacy policy ────────────────────────────────────────────────────────

describe('the DevTools privacy policy', () => {
  test('states every key of the extension’s manifest and every address its scripts match', () => {
    assert.deepEqual(policyRefusals(readFileSync(MANIFEST, 'utf8')), []);
  });

  test('refuses a permission, a host permission or an address it does not state', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const refusals = policyRefusals(
      JSON.stringify({
        ...manifest,
        permissions: ['storage'],
        host_permissions: ['https://*/*'],
        content_scripts: [{ matches: ['https://example.com/*'], js: ['hook.js'] }],
      })
    );
    assert.equal(refusals.length, 3);
    assert.match(refusals[0], /declares permissions/u);
    assert.match(refusals[1], /declares host_permissions/u);
    assert.match(refusals[2], /match https:\/\/example\.com\/\*/u);
  });

  test('is one document of both languages, each with its canonical address', () => {
    const page = buildPrivacy();
    const heads = JSON.parse(
      /<script type="application\/json" id="heads">([^<]+)<\/script>/u.exec(page)[1]
    );
    assert.equal(heads.en.canonical, 'https://beadproto.dev/privacy/');
    assert.equal(heads.fr.canonical, 'https://beadproto.dev/privacy/?lng=fr');
    assert.match(page, /<div id="page" data-lang="en">/u);
    assert.match(page, /<template id="page-other" data-lang="fr">/u);
    assert.match(page, /<a class="brand" href="\/"/u);
  });
});
