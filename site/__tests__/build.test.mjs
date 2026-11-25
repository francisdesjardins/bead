import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { TRANSPORTS, TRANSPORTS_OFF } from '../src/data.mjs';
import {
  buildPrivacy,
  contentsOf,
  facesOf,
  policyRefusals,
  transportsRefusals,
  typeset,
} from '../build.mjs';

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

// ── The contents ──────────────────────────────────────────────────────────────

describe('the contents', () => {
  test('lists each section in the page’s order, in the part its data-part opens', () => {
    const { items, content } = contentsOf(
      [
        '<section id="a" class="status" data-toc="A">',
        '<section id="b" data-toc="B" data-part="Questions">',
        '<section id="c" data-toc="C">',
        '<section id="d" data-toc="D" data-part="">',
      ].join('')
    );
    assert.equal(
      items,
      '<li><a href="#a">A</a></li><li class="toc-part"><p class="toc-part-title">Questions</p><ol><li><a href="#b">B</a></li><li><a href="#c">C</a></li></ol></li><li><a href="#d">D</a></li>'
    );
    assert.equal(
      content,
      '<section id="a" class="status"><section id="b"><section id="c"><section id="d">'
    );
  });

  test('keeps the face a section gives the mascot, and refuses one the mascot has not', () => {
    const { content } = contentsOf(
      '<section id="a" data-toc="A" data-part="" data-bead-face="serene"><section id="b" data-toc="B">'
    );
    assert.equal(content, '<section id="a" data-bead-face="serene"><section id="b">');
    assert.equal(facesOf(content), 'a=serene');
    assert.throws(() => {
      return contentsOf('<section id="a" data-toc="A" data-bead-face="bored">');
    }, /the face bored, which the mascot has not/u);
  });

  test('refuses a data-toc it cannot take, so no section drops out unseen', () => {
    assert.throws(() => {
      return contentsOf('<section data-toc="A" id="a">');
    }, /data-toc or a data-part the contents did not take/u);
  });
});

// ── The table of the transports ───────────────────────────────────────────────

describe('the table of the transports', () => {
  test('holds the support matrix’s Transports', () => {
    assert.deepEqual(transportsRefusals(), []);
  });

  test('refuses a side the matrix does not give a transport, and a row in no list', () => {
    const transports = TRANSPORTS.map((transport) => {
      return transport.name[0] === 'AMQP 1.0'
        ? { ...transport, sides: ['TypeScript', 'C#', 'Rust'] }
        : transport;
    });
    const refusals = transportsRefusals({ transports, off: TRANSPORTS_OFF.slice(1) });
    assert.equal(refusals.length, 2);
    assert.match(refusals[0], /is in no list of src\/data\.mjs/u);
    assert.match(
      refusals[1],
      /“AMQP 1\.0”: the matrix says TypeScript, C#; the page says TypeScript, C#, Rust/u
    );
  });
});

// ── French typography ─────────────────────────────────────────────────────────

describe('French typography', () => {
  test('keeps a number whole and with its unit alone, and a mark with its word, never inside code', () => {
    const narrow = String.fromCodePoint(0x20_2f);
    const noBreak = String.fromCodePoint(0xa0);
    assert.equal(
      typeset('<p>16 778 240 octets, 30 s : « oui » ? MQTT 5 ou 2 sides</p><code>a : b</code>'),
      `<p>16${narrow}778${narrow}240${noBreak}octets, 30${noBreak}s${narrow}: «${narrow}oui${narrow}»${narrow}? MQTT 5 ou 2 sides</p><code>a : b</code>`
    );
  });
});
