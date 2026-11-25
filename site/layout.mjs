#!/usr/bin/env node
// Holds the page beadproto.dev serves, `dist/index.html`, the DevTools extension's privacy policy,
// `dist/privacy/index.html`, and the not-found page, `dist/404.html`, to their layout in a headless Chromium, served on the loopback with the page's faces at /fonts/:
// the top bar 56 px tall and on one line, every tool whole, at each width from a small phone to a
// wide desktop, in both languages and both themes; no page wider than a phone; every control a
// finger reaches 44 px on a coarse pointer; every block of code at 13 px; no name of code in a table,
// which scrolls sideways, split inside its word on a phone; the keyboard's focus shown
// on the bar's tools, the menu's links and its languages; the menu opened, closed by Escape and the
// focus given back; the bar's button named by the section read, Bead's name above the first; the
// language in the contents' foot on a phone, the bar's two letters past it; the page's contents in their two parts, each part's name above its links, every link
// landing on a section in the page's order; the mascot, the bar's own mark on a phone, its face in
// a marked section alone, and beside the text on a wide desktop, the mark plain; and the theme the
// page keeps, set before the first paint.
//
//   node layout.mjs                       every check, in Playwright's own Chromium
//   node layout.mjs --chromium <path>     the Chromium to drive
//
// Exit 1 on a check that fails, each named by its surface, language, theme and width.

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');
const SRC = join(HERE, 'src');

// each side of every breakpoint the page, the demo and the not-found page have
const WIDTHS = Object.freeze([320, 390, 600, 899, 900, 1199, 1200, 1440]);
const PHONES = Object.freeze([320, 390]);
const LANGUAGES = Object.freeze(['en', 'fr']);
const SCHEMES = Object.freeze(['light', 'dark']);
const BAR = 56;
// the skin's `--app-touch`, the least a control a finger reaches is, tall and wide
const TOUCH = 44;
// the skin's `--app-text-code`
const CODE = '13px';
const THEME_KEY = 'theme-preference';

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
});

// ── Serving ───────────────────────────────────────────────────────────────────

// the page at `/`, the privacy policy at `/privacy/`, their faces and icons where the host serves
// them, and the not-found page for every other path, as the host answers it
const serve = () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file =
      path === '/'
        ? join(DIST, 'index.html')
        : path === '/privacy/'
          ? join(DIST, 'privacy', 'index.html')
          : path.startsWith('/fonts/')
            ? join(SRC, 'fonts', path.slice('/fonts/'.length))
            : join(SRC, path.slice(1));
    if (!path.includes('..') && existsSync(file) && extname(file) !== '') {
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      });
      response.end(readFileSync(file));
      return;
    }
    response.writeHead(404, { 'content-type': TYPES['.html'] });
    response.end(readFileSync(join(DIST, '404.html')));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
};

// ── Measures, in the page ─────────────────────────────────────────────────────

// what breaks a row that must hold on one line: a height other than its own, an item off its
// middle, so on a line of its own, an item out of its box or clipped, or the row scrolling
const rowFaultsOf = (page, { row, items, height }) => {
  return page.evaluate(
    ({ row, items, height }) => {
      const element = document.querySelector(row);
      if (element === null) {
        return [`no ${row}`];
      }
      const box = element.getBoundingClientRect();
      const middle = box.top + box.height / 2;
      const faults = [];
      if (Math.abs(box.height - height) > 0.5) {
        faults.push(`${row} is ${box.height} px tall`);
      }
      if (element.scrollWidth > element.clientWidth) {
        faults.push(`${row} scrolls, ${element.scrollWidth} in ${element.clientWidth}`);
      }
      for (const item of element.querySelectorAll(items)) {
        const at = item.getBoundingClientRect();
        const name = `${item.tagName.toLowerCase()} "${item.textContent.trim().slice(0, 20)}"`;
        if (at.width === 0) {
          continue;
        }
        if (Math.abs(at.top + at.height / 2 - middle) > 1) {
          faults.push(`${name} is off the bar's middle`);
        }
        if (
          at.left < box.left - 0.5 ||
          at.right > box.right + 0.5 ||
          at.top < box.top - 0.5 ||
          at.bottom > box.bottom + 0.5
        ) {
          faults.push(`${name} is out of the bar`);
        }
        if (item.scrollWidth > item.clientWidth + 1) {
          faults.push(`${name} is clipped`);
        }
      }
      return faults;
    },
    { row, items, height }
  );
};

const isSideways = (page) => {
  return page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
};

// the controls a finger reaches under TOUCH either way: a link inside a sentence is exempt, as
// WCAG 2.5.8 exempts it
const smallTargetsOf = (page) => {
  return page.evaluate((touch) => {
    const small = new Set();
    for (const element of document.querySelectorAll(
      'a[href], button, input, select, textarea, summary, [role="tab"]'
    )) {
      if (
        element.matches('a') &&
        element.closest('p, li, dd, figcaption, td') !== null &&
        element.closest('header, nav') === null
      ) {
        continue;
      }
      const target = element.matches('input') ? (element.closest('label') ?? element) : element;
      const { width, height } = target.getBoundingClientRect();
      if (width > 0 && height > 0 && (width < touch - 0.5 || height < touch - 0.5)) {
        small.add(
          `${target.tagName.toLowerCase()} ${Math.round(width)}x${Math.round(height)} "${target.textContent.trim().slice(0, 24)}"`
        );
      }
    }
    return [...small];
  }, TOUCH);
};

// the names of code in a table that a phone breaks inside a word: a table scrolls sideways
// instead, so a name with no space or hyphen in it stays on one line
const splitCodesOf = (page) => {
  return page.evaluate(() => {
    return [
      ...new Set(
        [...document.querySelectorAll('td code, th code')]
          .filter((code) => {
            return code.getClientRects().length > 1 && !/[s-]/u.test(code.textContent.trim());
          })
          .map((code) => {
            return code.textContent.trim();
          })
      ),
    ];
  });
};

const codeSizesOf = (page) => {
  return page.evaluate(() => {
    return [
      ...new Set(
        [...document.querySelectorAll('pre, pre code')].map((element) => {
          return getComputedStyle(element).fontSize;
        })
      ),
    ];
  });
};

// the outline the first element of `selector` draws once the keyboard reaches it, Tab after Tab;
// `none` where it draws none, or where no Tab reaches it
const outlineByTabOf = async (page, selector) => {
  for (let tabs = 0; tabs < 40; tabs += 1) {
    await page.keyboard.press('Tab');
    const style = await page.evaluate((wanted) => {
      const focused = document.activeElement;
      return focused !== null && focused.matches(wanted) && focused.matches(':focus-visible')
        ? getComputedStyle(focused).outlineStyle
        : null;
    }, selector);
    if (style !== null) {
      return style;
    }
  }
  return 'none';
};

const facesIn = (page) => {
  return page.evaluate(async () => {
    await document.fonts.ready;
  });
};

// ── Checks ────────────────────────────────────────────────────────────────────

// the bar, the page wider than none of the phones, and its code, at every width of one load
const holdBar = async ({ browser, address, path, label, scheme, items, alone = false, faults }) => {
  const context = await browser.newContext({ colorScheme: scheme });
  try {
    const page = await context.newPage();
    await page.goto(`${address}${path}`);
    await facesIn(page);
    if (alone && (await page.locator('.topbar > *').count()) !== 1) {
      faults.push(`${label}: its bar holds more than its mark and its name`);
    }
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      for (const fault of await rowFaultsOf(page, { row: '.topbar', items, height: BAR })) {
        faults.push(`${label}, ${scheme}, ${width} px: ${fault}`);
      }
      if (PHONES.includes(width) && (await isSideways(page))) {
        faults.push(`${label}, ${scheme}, ${width} px: the page scrolls sideways`);
      }
      if (PHONES.includes(width)) {
        for (const name of await splitCodesOf(page)) {
          faults.push(`${label}, ${scheme}, ${width} px: ${name} split inside its word in a table`);
        }
      }
    }
    const sizes = await codeSizesOf(page);
    if (sizes.some((size) => size !== CODE)) {
      faults.push(`${label}, ${scheme}: code at ${sizes.join(', ')}, not ${CODE} alone`);
    }
  } finally {
    await context.close();
  }
};

// the surfaces of both languages, each by its path and its name in a fault
const SURFACES = Object.freeze([
  Object.freeze({ path: '', label: 'the page' }),
  Object.freeze({ path: 'privacy/', label: 'the privacy policy' }),
]);

// on a coarse pointer, every control whole, the menu's included once it is open
const holdTouch = async ({ browser, address, language, surface, faults }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${address}${surface.path}?lng=${language}`);
    await facesIn(page);
    for (const small of await smallTargetsOf(page)) {
      faults.push(`${surface.label}, ${language}, a finger's target: ${small}`);
    }
    await page.locator('[data-action="menu"]').tap();
    for (const small of await smallTargetsOf(page)) {
      faults.push(`${surface.label}'s menu, ${language}, a finger's target: ${small}`);
    }
    if (surface.path !== '') {
      return;
    }
    const page404 = await context.newPage();
    await page404.goto(`${address}nowhere`);
    for (const small of await smallTargetsOf(page404)) {
      faults.push(`the not-found page, a finger's target: ${small}`);
    }
  } finally {
    await context.close();
  }
};

// the menu opened by its button, closed by Escape, the focus back on its button; no menu past it
const holdMenu = async ({ browser, address, language, surface, faults }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const label = `${surface.label}'s menu, ${language}`;
  try {
    const page = await context.newPage();
    await page.goto(`${address}${surface.path}?lng=${language}`);
    const button = page.locator('[data-action="menu"]');
    await button.click();
    const opened = await page.evaluate(() => {
      return {
        expanded: document.querySelector('[data-action="menu"]').getAttribute('aria-expanded'),
        open: document.documentElement.hasAttribute('data-menu-open'),
        shown: document.querySelector('.toc').getBoundingClientRect().height > 0,
      };
    });
    if (opened.expanded !== 'true' || !opened.open || !opened.shown) {
      faults.push(`${label}: not opened by its button`);
    }
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => {
      const button = document.querySelector('[data-action="menu"]');
      return {
        expanded: button.getAttribute('aria-expanded'),
        open: document.documentElement.hasAttribute('data-menu-open'),
        focused: document.activeElement === button,
      };
    });
    if (closed.expanded !== 'false' || closed.open || !closed.focused) {
      faults.push(`${label}: Escape leaves it open, or the focus elsewhere`);
    }
    await page.setViewportSize({ width: 1200, height: 800 });
    if (await button.isVisible()) {
      faults.push(`${label}: its button shown beside the contents`);
    }
  } finally {
    await context.close();
  }
};

// the keyboard's focus shown on each tool of the bar, on a link of the menu, and on the not-found
// page's name
const holdFocus = async ({ browser, address, language, faults }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(`${address}?lng=${language}`);
    for (const tool of [
      '.topbar .brand',
      '[data-action="menu"]',
      '.topbar .demo',
      '[data-action="theme"]',
    ]) {
      if ((await outlineByTabOf(page, tool)) === 'none') {
        faults.push(`the page, ${language}: no focus shown on ${tool}`);
      }
    }
    await page.goto(`${address}?lng=${language}`);
    await outlineByTabOf(page, '[data-action="menu"]');
    await page.keyboard.press('Enter');
    if ((await outlineByTabOf(page, '.toc a')) === 'none') {
      faults.push(`the page's menu, ${language}: no focus shown on its links`);
    }
    if ((await outlineByTabOf(page, '.toc-languages a')) === 'none') {
      faults.push(`the page's menu, ${language}: no focus shown on its languages`);
    }
    // * past a phone, the language is the bar's tool
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`${address}?lng=${language}`);
    if ((await outlineByTabOf(page, '.tools [data-action="language"]')) === 'none') {
      faults.push(`the page, ${language}: no focus shown on the language`);
    }
    await page.goto(`${address}nowhere`);
    if ((await outlineByTabOf(page, '.topbar .brand')) === 'none') {
      faults.push('the not-found page: no focus shown on its name');
    }
  } finally {
    await context.close();
  }
};

// the contents in their parts: the questions, then the protocol in detail, each part's name shown
// above its links beside the page and in the menu, and every link of the contents landing on a
// section of the page, in the page's order
const PARTS = 2;

const contentsFaultsOf = (page) => {
  return page.evaluate((parts) => {
    const faults = [];
    const titles = [...document.querySelectorAll('.toc .toc-part-title')];
    if (titles.length !== parts) {
      faults.push(`${titles.length} parts, not ${parts}`);
    }
    for (const title of titles) {
      const box = title.getBoundingClientRect();
      const links = title.parentElement.querySelectorAll('a');
      if (box.height === 0 || links.length === 0) {
        faults.push(`the part "${title.textContent}" shown with no link, or not shown`);
      } else if (links[0].getBoundingClientRect().top < box.bottom - 0.5) {
        faults.push(`the part "${title.textContent}" not above its links`);
      }
    }
    const sections = [...document.querySelectorAll('main section[id]')];
    let last = -1;
    for (const link of document.querySelectorAll('.toc ol a')) {
      const at = sections.findIndex((section) => {
        return `#${section.id}` === link.getAttribute('href');
      });
      if (at === -1) {
        faults.push(`${link.getAttribute('href')} lands on no section`);
      } else if (at < last) {
        faults.push(`${link.getAttribute('href')} out of the page's order`);
      } else {
        last = at;
      }
    }
    return faults;
  }, PARTS);
};

const holdContents = async ({ browser, address, language, faults }) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(`${address}?lng=${language}`);
    for (const fault of await contentsFaultsOf(page)) {
      faults.push(`the page's contents, ${language}, 1200 px: ${fault}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-action="menu"]').click();
    for (const fault of await contentsFaultsOf(page)) {
      faults.push(`the page's menu, ${language}, 390 px: ${fault}`);
    }
  } finally {
    await context.close();
  }
};

// the theme the page keeps, on the root once the document is parsed, and the one chosen kept
const holdTheme = async ({ browser, address, faults }) => {
  const context = await browser.newContext({ colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') {
          globalThis.parsedScheme = document.documentElement.getAttribute('data-color-scheme');
        }
      });
    });
    const parsed = () => {
      return page.evaluate(() => {
        return globalThis.parsedScheme;
      });
    };
    await page.goto(address);
    if ((await parsed()) !== 'light') {
      faults.push(`the theme: the system's light is ${await parsed()} at the first paint`);
    }
    await page.evaluate((key) => {
      localStorage.setItem(key, 'true');
    }, THEME_KEY);
    await page.reload();
    if ((await parsed()) !== 'dark') {
      faults.push(`the theme: the dark kept is ${await parsed()} at the first paint`);
    }
    await page.locator('[data-action="theme"]').click();
    const chosen = await page.evaluate((key) => {
      return {
        scheme: document.documentElement.getAttribute('data-color-scheme'),
        stored: localStorage.getItem(key),
      };
    }, THEME_KEY);
    if (chosen.scheme !== 'light' || chosen.stored !== 'false') {
      faults.push(`the theme: the light chosen is ${chosen.scheme}, kept as ${chosen.stored}`);
    }
  } finally {
    await context.close();
  }
};

// the mascot, one at a time: on a phone, the bar's own mark, its face shown in a marked section
// alone and no other drawing in the bar; beside the text on a wide desktop, the bar's mark plain
const holdMascot = async ({ browser, address, language, faults }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const label = `the mascot, ${language}`;
  try {
    const page = await context.newPage();
    await page.goto(`${address}?lng=${language}`);
    await page.waitForFunction(() => {
      return document.querySelector('.topbar .bead-mark') !== null;
    });
    const read = () => {
      return page.evaluate(() => {
        const mark = document.querySelector('.topbar .bead-mark');
        const button = document.querySelector('.bead-mascot');
        return {
          shown: mark?.hasAttribute('data-face-shown') ?? false,
          face: mark?.getAttribute('data-face') ?? null,
          drawings: document.querySelectorAll('.topbar svg').length,
          button: button !== null && button.checkVisibility(),
          bar: document.querySelector('.topbar').getBoundingClientRect().height,
        };
      });
    };
    const outside = await read();
    if (outside.shown) {
      faults.push(`${label}, 390 px: a face on the mark outside every marked section`);
    }
    if (outside.drawings !== 1 || outside.button) {
      faults.push(`${label}, 390 px: a second mascot beside the bar's mark`);
    }
    if (outside.bar !== BAR) {
      faults.push(`${label}, 390 px: the bar ${outside.bar} px tall with the mark`);
    }
    await page.evaluate(() => {
      const section = document.getElementById('securite');
      const box = section.getBoundingClientRect();
      window.scrollTo({
        top: window.scrollY + box.top + box.height / 2 - innerHeight / 2,
        behavior: 'instant',
      });
    });
    try {
      await page.waitForFunction(
        () => {
          const mark = document.querySelector('.topbar .bead-mark');
          return (
            mark?.hasAttribute('data-face-shown') && mark.getAttribute('data-face') === 'surprised'
          );
        },
        null,
        { timeout: 2000 }
      );
    } catch {
      const inside = await read();
      faults.push(
        `${label}, 390 px: in the security section, the mark shows ${inside.shown ? inside.face : 'no face'}`
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    try {
      await page.waitForFunction(
        () => {
          const button = document.querySelector('.bead-mascot');
          return (
            document.querySelector('.topbar .bead-mark') === null &&
            button !== null &&
            !button.hidden
          );
        },
        null,
        { timeout: 2000 }
      );
    } catch {
      faults.push(`${label}, 1440 px: the bar's mark not plain, or no mascot beside the text`);
    }
  } finally {
    await context.close();
  }
};

// the bar's button, where the contents are a sheet: Bead's name above the first section, then the
// section read; the sheet's foot, both languages written out, the page's own marked; and the
// language the bar's tool, by its two letters, where the contents are a column
const holdReading = async ({ browser, address, language, faults }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const label = `the bar's section, ${language}`;
  try {
    const page = await context.newPage();
    await page.goto(`${address}?lng=${language}`);
    const read = () => {
      return page.evaluate(() => {
        return document.querySelector('[data-reading]').textContent;
      });
    };
    if ((await read()) !== 'Bead') {
      faults.push(`${label}: reads ${await read()} above the first section`);
    }
    const expected = await page.evaluate(() => {
      const section = document.getElementById('securite');
      window.scrollTo({
        top: window.scrollY + section.getBoundingClientRect().top - 60,
        behavior: 'instant',
      });
      return document.querySelector('.toc ol a[href="#securite"]').textContent;
    });
    try {
      await page.waitForFunction(
        (title) => {
          return document.querySelector('[data-reading]').textContent === title;
        },
        expected,
        { timeout: 2000 }
      );
    } catch {
      faults.push(`${label}: reads ${await read()} in the section ${expected}`);
    }
    const foot = await page.evaluate(() => {
      return [...document.querySelectorAll('.toc-languages a')].map((link) => {
        return `${link.textContent}${link.hasAttribute('aria-current') ? '*' : ''}`;
      });
    });
    const marked = language === 'en' ? ['English*', 'Français'] : ['English', 'Français*'];
    if (foot.join(' ') !== marked.join(' ')) {
      faults.push(`${label}: the contents' foot offers ${foot.join(' ')}`);
    }
    if (await page.locator('.tools [data-action="language"]').isVisible()) {
      faults.push(`${label}: the language in the bar beside the contents' sheet`);
    }
    await page.setViewportSize({ width: 1200, height: 800 });
    const tool = (
      await page.locator('.tools [data-action="language"] [aria-hidden="true"]').innerText()
    ).trim();
    if (tool !== (language === 'en' ? 'FR' : 'EN')) {
      faults.push(`${label}, 1200 px: the language reads ${tool}`);
    }
  } finally {
    await context.close();
  }
};

// ── Run ───────────────────────────────────────────────────────────────────────

const main = async () => {
  const { values } = parseArgs({ options: { chromium: { type: 'string' } } });
  const server = await serve();
  const address = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(
    values.chromium === undefined ? {} : { executablePath: values.chromium }
  );
  const faults = [];
  try {
    for (const scheme of SCHEMES) {
      for (const surface of SURFACES) {
        for (const language of LANGUAGES) {
          await holdBar({
            browser,
            address,
            path: `${surface.path}?lng=${language}`,
            label: `${surface.label}, ${language}`,
            scheme,
            items: '.topbar > *, .topbar .tools > *',
            faults,
          });
        }
      }
      // * the mark and the name alone: no tool
      await holdBar({
        browser,
        address,
        path: 'nowhere',
        label: 'the not-found page',
        scheme,
        items: '.topbar > *',
        alone: true,
        faults,
      });
    }
    for (const language of LANGUAGES) {
      for (const surface of SURFACES) {
        await holdTouch({ browser, address, language, surface, faults });
        await holdMenu({ browser, address, language, surface, faults });
      }
      await holdFocus({ browser, address, language, faults });
      await holdContents({ browser, address, language, faults });
      await holdMascot({ browser, address, language, faults });
      await holdReading({ browser, address, language, faults });
    }
    await holdTheme({ browser, address, faults });
  } finally {
    await browser.close();
    server.close();
  }
  for (const fault of faults) {
    console.error(`layout: ${fault}`);
  }
  if (faults.length > 0) {
    return 1;
  }
  console.log(
    `layout: the page, the privacy policy and the not-found page hold, at ${WIDTHS.join(', ')} px, in both languages and both themes, the page's contents in their ${PARTS} parts`
  );
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
