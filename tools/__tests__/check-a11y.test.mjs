import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { exceptionsOf, reportOf } from '../check-a11y.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'check-a11y.mjs');
const TYPESCRIPT = join(HERE, '..', '..', 'implementations', 'typescript');

// ! the Commits job runs these tests with nothing installed: there they skip, saying why; the
// TypeScript job, which has axe and a Chromium, sets BEAD_A11Y_REQUIRED=1, which fails the skip
const isRequired = process.env['BEAD_A11Y_REQUIRED'] === '1';

const missingOf = () => {
  const require = createRequire(join(TYPESCRIPT, 'package.json'));
  try {
    require.resolve('@axe-core/playwright');
    const { chromium } = require('@playwright/test');
    return existsSync(chromium.executablePath())
      ? undefined
      : 'no Chromium: yarn playwright install chromium, in implementations/typescript';
  } catch {
    return 'axe or Playwright is not installed: yarn install, in implementations/typescript';
  }
};
const missing = missingOf();
const skip = missing !== undefined && !isRequired ? missing : false;

// a page that holds to every check, but for what `body` and `head` add
const pageOf = (body, head = '') => {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>A fixture</title>
    ${head}
  </head>
  <body>
    <main>
      <h1>A fixture</h1>
      ${body}
    </main>
  </body>
</html>
`;
};

// one page a kind, each with its one known violation, and the clean one with none
const FIXTURES = Object.freeze({
  clean: pageOf(
    '<p>A sentence with <a href="#here">a link</a> in it.</p><button type="button" style="min-width: 44px; min-height: 44px">Act</button>'
  ),
  'image-alt': pageOf('<img src="mark.png" width="40" height="40" />'),
  'target-size': pageOf(
    '<button type="button" style="width: 12px; height: 12px; padding: 0; margin: 0" aria-label="One"></button><button type="button" style="width: 12px; height: 12px; padding: 0; margin: 0" aria-label="Two"></button>'
  ),
  reflow: pageOf('<p style="width: 600px">A line wider than a small phone.</p>'),
  'text-spacing': pageOf(
    '<p style="height: 1.2em; line-height: 1.2; overflow: hidden; margin: 0">One line, clipped once it is spaced out.</p>'
  ),
  keyboard: pageOf(
    '<div role="button" onclick="this.textContent = \'Acted\'" style="width: 60px; height: 44px">Act</div>'
  ),
  'focus-order': pageOf(
    '<button type="button" style="min-width: 44px; min-height: 44px">One</button><button type="button" tabindex="2" style="min-width: 44px; min-height: 44px">Two</button>'
  ),
  'focus-visible': pageOf(
    '<button type="button" style="min-width: 44px; min-height: 44px">Act</button>',
    '<style>button:focus, button:focus-visible { outline: none; }</style>'
  ),
  'focus-not-obscured': pageOf(
    '<div style="position: fixed; inset: 0 0 auto 0; height: 80px; background: #fff; z-index: 1">A bar</div><a href="#under" style="position: absolute; top: 8px; left: 8px; display: inline-block; min-height: 44px">Under the bar</a>'
  ),
  // * a bar over most of the screen: Chromium brings a stop it scrolls to into the middle, under it
  'shift-tab': pageOf(
    '<div style="position: sticky; top: 0; height: 520px; background: #fff; z-index: 1">A bar</div><div style="height: 2000px"></div><a href="#one" style="display: inline-block; min-height: 44px">One</a><div style="height: 2000px"></div>'
  ),
  // * what a disclosure shows is held once it is open
  disclosure: pageOf(
    '<button type="button" aria-expanded="false" aria-controls="more" style="min-width: 44px; min-height: 44px" onclick="const open = this.ariaExpanded === `false`; this.ariaExpanded = String(open); document.getElementById(`more`).hidden = !open;">More</button><div id="more" hidden><img src="mark.png" width="40" height="40" /></div>'
  ),
  'target-size-coarse': pageOf(
    '<button type="button" style="width: 32px; height: 32px; padding: 0">A</button>'
  ),
  'name-role-value': pageOf(
    '<div role="tablist" aria-label="Views"><button type="button" role="tab" aria-selected="true" style="min-width: 44px; min-height: 44px">One</button><button type="button" role="tab" aria-selected="false" style="min-width: 44px; min-height: 44px">Two</button></div>'
  ),
  'reduced-motion': pageOf(
    '<button type="button" style="min-width: 44px; min-height: 44px; transition: transform 1s">Act</button>'
  ),
  'use-of-color': pageOf(
    '<table><caption>Calls</caption><tr><th scope="col">Name</th></tr><tr data-status="answered"><td><span style="color: #0a0">●</span> one</td></tr><tr data-status="answered"><td><span style="color: #0a0">●</span> two</td></tr><tr data-status="failed"><td><span style="color: #a00">●</span> three</td></tr></table>'
  ),
});

const run = (args) => {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr });
      }
    );
  });
};

describe('exceptionsOf', () => {
  test('refuses an exception without its reason', () => {
    const folder = mkdtempSync(join(tmpdir(), 'check-a11y-'));
    try {
      const path = join(folder, 'exceptions.json');
      writeFileSync(path, JSON.stringify([{ rule: 'image-alt', selector: 'img' }]));

      assert.throws(() => {
        exceptionsOf(path);
      }, /has no reason/u);
    } finally {
      rmSync(folder, { force: true, recursive: true });
    }
  });

  test('reads the repository’s own, each with its rule, its selector and its reason', () => {
    for (const exception of exceptionsOf()) {
      assert.equal(typeof exception.reason, 'string');
    }
  });
});

describe('reportOf', () => {
  test('prints a violation once, by its rule, its criterion and its element, with every page it is on', () => {
    const report = reportOf([
      { rule: 'reflow', element: 'html', message: 'wide', page: '/a' },
      { rule: 'reflow', element: 'html', message: 'wide', page: '/b' },
    ]);

    assert.deepEqual(report, ['reflow (1.4.10): html: wide\n    on /a; /b']);
  });
});

describe('check-a11y', { skip }, () => {
  let folder = '';
  let found = [];
  let code = 0;

  before(async () => {
    if (missing !== undefined) {
      throw new Error(`check-a11y: ${missing}`);
    }
    folder = mkdtempSync(join(tmpdir(), 'check-a11y-'));
    for (const [name, html] of Object.entries(FIXTURES)) {
      writeFileSync(join(folder, `${name}.html`), html);
    }
    const ran = await run([
      '--serve',
      folder,
      '--scheme',
      'light',
      '--width',
      '1280',
      '--exceptions',
      join(folder, 'none.json'),
      '--json',
      ...Object.keys(FIXTURES).map((name) => {
        return `/${name}.html`;
      }),
    ]);
    code = ran.code;
    found = JSON.parse(ran.stdout);
  });

  after(() => {
    rmSync(folder, { force: true, recursive: true });
  });

  const rulesOn = (name) => {
    return new Set(
      found
        .filter((each) => {
          return each.page.startsWith(`/${name}.html,`);
        })
        .map((each) => {
          return each.rule;
        })
    );
  };

  test('exits 1 on a violation', () => {
    assert.equal(code, 1);
  });

  test('finds nothing on a page that holds to every check', () => {
    assert.deepEqual([...rulesOn('clean')], []);
  });

  for (const name of Object.keys(FIXTURES).filter((each) => {
    return !['clean', 'shift-tab', 'disclosure'].includes(each);
  })) {
    test(`finds ${name} on the page that breaks it`, () => {
      assert.ok(rulesOn(name).has(name), `${name}: found ${[...rulesOn(name)].join(', ')}`);
    });
  }

  test('finds a focus under a sticky bar on the walk back, by Shift+Tab', () => {
    assert.ok(
      found.some((each) => {
        return (
          each.page.startsWith('/shift-tab.html,') &&
          each.rule === 'focus-not-obscured' &&
          each.message.endsWith('Shift+Tab')
        );
      }),
      JSON.stringify(found.filter((each) => each.page.startsWith('/shift-tab.html,')))
    );
  });

  test('finds what a disclosure shows once it opens it', () => {
    assert.ok(
      found.some((each) => {
        return (
          each.page.startsWith('/disclosure.html,') &&
          each.rule === 'image-alt' &&
          each.message.endsWith('open')
        );
      }),
      JSON.stringify(found.filter((each) => each.page.startsWith('/disclosure.html,')))
    );
  });

  test('leaves out what an exception names, by its rule and its selector', async () => {
    const path = join(folder, 'exceptions.json');
    writeFileSync(
      path,
      JSON.stringify([{ rule: 'image-alt', selector: 'img', reason: 'the fixture’s own' }])
    );
    const ran = await run([
      '--serve',
      folder,
      '--scheme',
      'light',
      '--width',
      '1280',
      '--exceptions',
      path,
      '--json',
      '/image-alt.html',
    ]);

    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), []);
  });

  test('exits 0 on a clean page, in both schemes, at 1280 and 390 px', async () => {
    const ran = await run([
      '--serve',
      folder,
      '--exceptions',
      join(folder, 'none.json'),
      '/clean.html',
    ]);

    assert.equal(ran.code, 0, ran.stderr);
  });
});
