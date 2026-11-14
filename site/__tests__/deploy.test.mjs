import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  FILES,
  REDIRECTS,
  assemble,
  demoFilesOf,
  headersOf,
  inlineScriptHashes,
  sitemapOf,
  tokenRefusals,
  treeRefusals,
} from '../deploy.mjs';

// ── Fixture ───────────────────────────────────────────────────────────────────

const TEMPORARY = mkdtempSync(join(tmpdir(), 'bead-deploy-'));
after(() => {
  rmSync(TEMPORARY, { force: true, recursive: true });
});

// a git that answers each command by the output the case gives it
const gitOf = ({ status = '', remotes = '  origin/develop\n' } = {}) => {
  return (args) => {
    if (args[0] === 'status') {
      return status;
    }
    if (args[0] === 'branch') {
      return remotes;
    }
    throw new Error(`no answer for git ${args.join(' ')}`);
  };
};

// a demo's static build, its files by their names
const demoOf = (names) => {
  const folder = mkdtempSync(join(TEMPORARY, 'demo-'));
  for (const name of names) {
    writeFileSync(join(folder, name), name);
  }
  return folder;
};

const BUILT = ['index.html', 'page-JNDJCHZM.js', 'worker-67FCRBOE.js'];

// ── Refusals ──────────────────────────────────────────────────────────────────

describe('a token in the environment', () => {
  test('is refused, either variable, unless --token means it', () => {
    assert.deepEqual(tokenRefusals({}, false), []);
    assert.deepEqual(tokenRefusals({ CLOUDFLARE_API_TOKEN: '' }, false), []);
    assert.match(tokenRefusals({ CLOUDFLARE_API_TOKEN: 't' }, false)[0], /CLOUDFLARE_API_TOKEN/u);
    assert.match(tokenRefusals({ CLOUDFLARE_ACCOUNT_ID: 'a' }, false)[0], /CLOUDFLARE_ACCOUNT_ID/u);
    assert.deepEqual(
      tokenRefusals({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }, true),
      []
    );
  });
});

describe('the tree a deploy ships', () => {
  test('is a commit on origin, with nothing changed', () => {
    assert.deepEqual(treeRefusals(gitOf()), []);
  });

  test('refuses a change not committed', () => {
    assert.match(treeRefusals(gitOf({ status: ' M site/src/page.js\n' }))[0], /not committed/u);
  });

  test('refuses a commit no branch of origin holds', () => {
    assert.match(treeRefusals(gitOf({ remotes: '' }))[0], /no branch of origin/u);
  });
});

// ── Assembly ──────────────────────────────────────────────────────────────────

describe('the demo’s build', () => {
  test('is its page and its two scripts', () => {
    assert.deepEqual(demoFilesOf(BUILT), BUILT);
  });

  test('refuses a file the list does not know, a source map among them', () => {
    assert.throws(() => {
      return demoFilesOf([...BUILT, 'page-JNDJCHZM.js.map']);
    }, /does not know: page-JNDJCHZM\.js\.map/u);
    assert.throws(() => {
      return demoFilesOf([...BUILT, '.env']);
    }, /does not know: \.env/u);
  });

  test('refuses a build that lacks one of them', () => {
    assert.throws(() => {
      return demoFilesOf(['index.html', 'page-JNDJCHZM.js']);
    }, /lacks/u);
  });
});

describe('out/', () => {
  test('holds the lists’ files and the four written, nothing else', () => {
    const out = join(TEMPORARY, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'stale.txt'), 'an earlier assembly’s');
    const written = assemble({ out, demo: demoOf(BUILT), day: '2026-11-13' });
    const expected = [
      ...Object.keys(FILES),
      ...BUILT.map((name) => {
        return `playground/${name}`;
      }),
      '_headers',
      '_redirects',
      'robots.txt',
      'sitemap.xml',
    ].sort();
    assert.deepEqual(written, expected);
    const listed = readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((entry) => {
        return entry.isFile();
      })
      .map((entry) => {
        return join(entry.parentPath, entry.name)
          .slice(out.length + 1)
          .split(sep)
          .join('/');
      })
      .sort();
    assert.deepEqual(listed, expected);
    assert.equal(readFileSync(join(out, '_redirects'), 'utf8'), REDIRECTS);
  });
});

// ── What is written ───────────────────────────────────────────────────────────

describe('the headers', () => {
  const html =
    '<script>\nfirst();\n    </script><script type="application/json" id="heads">{}</script><script>\nsecond();\n</script>';

  test('name each inline script by its hash, and the JSON the page reads not at all', () => {
    const hash = (text) => {
      return `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
    };
    assert.deepEqual(inlineScriptHashes(html), [hash('\nfirst();\n    '), hash('\nsecond();\n')]);
  });

  test('hash a script as a parser reads it, a CRLF as an LF', () => {
    assert.deepEqual(inlineScriptHashes(html.replaceAll('\n', '\r\n')), inlineScriptHashes(html));
  });

  test('deny framing, sniffing and eval, and keep to HTTPS', () => {
    const headers = headersOf(html);
    assert.match(headers, /^\/\*\n/u);
    assert.match(headers, /frame-ancestors 'none'/u);
    assert.doesNotMatch(headers, /unsafe-eval/u);
    assert.match(headers, /script-src 'self' 'sha256-[^']+' 'sha256-[^']+';/u);
    assert.match(
      headers,
      /Strict-Transport-Security: max-age=63072000; includeSubDomains; preload/u
    );
    assert.match(headers, /X-Content-Type-Options: nosniff/u);
    for (const line of headers.split('\n')) {
      // Cloudflare's bound on a line of _headers
      assert.ok(line.length <= 2_000, line.slice(0, 40));
    }
  });
});

describe('the redirects', () => {
  test('send the demo’s old paths before the page’s, each in one hop', () => {
    const rules = REDIRECTS.trim().split('\n');
    assert.ok(
      rules.indexOf('/bead/playground/* /playground/:splat 301') <
        rules.indexOf('/bead/* /:splat 301')
    );
    for (const rule of rules) {
      assert.match(rule, / 301$/u);
      assert.doesNotMatch(rule.split(' ')[1], /^\/bead/u);
    }
  });
});

describe('the sitemap', () => {
  test('lists each canonical address, absolute, the page’s with both languages', () => {
    const sitemap = sitemapOf('2026-11-13');
    assert.deepEqual(
      [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, loc]) => {
        return loc;
      }),
      [
        'https://beadproto.dev/',
        'https://beadproto.dev/?lng=fr',
        'https://beadproto.dev/playground/',
      ]
    );
    assert.equal(sitemap.match(/hreflang="x-default"/gu).length, 2);
    assert.equal(sitemap.match(/<lastmod>2026-11-13<\/lastmod>/gu).length, 3);
  });
});
