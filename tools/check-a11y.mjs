#!/usr/bin/env node
// Holds pages to WCAG 2.2 AA in a headless Chromium: axe's rules of the wcag2a, wcag2aa, wcag21aa
// and wcag22aa tags, on the page as it loads and with each of its disclosures and menus open, then
// the checks axe cannot make:
//
//   reflow               1.4.10  no page scrolls sideways at 320 px
//   text-spacing         1.4.12  the spacing overrides clip no text that showed whole
//   keyboard             2.1.1   the Tab key reaches every control drawn
//   focus-order          2.4.3   no positive tabindex, every Tab stop drawn on the screen
//   focus-visible        2.4.7   each Tab stop looks other than it does unfocused
//   focus-not-obscured   2.4.11  no Tab stop wholly under a sticky bar or strip, walked both ways
//   target-size-coarse   2.5.8   44 px on a coarse pointer, the floor Bead's surfaces keep
//   name-role-value      4.1.2   a tab, a radio, a toggle and a theme switch say their new state
//   reduced-motion       2.3.3   nothing moves under `prefers-reduced-motion: reduce`
//   use-of-color         1.4.1   rows of two statuses (`data-status`) told apart by a named glyph
//
//   node tools/check-a11y.mjs <url…>                     those addresses
//   node tools/check-a11y.mjs --serve <folder> <path…>   the folder on the loopback, as a static
//                                                        host serves it, each path read against it
//   --scheme light|dark   a scheme, repeated for more (both where none is given)
//   --width <px>          a width, repeated for more (1280 and 390 where none is given)
//   --exceptions <file>   the exceptions (tools/a11y-exceptions.json where none is given)
//   --chromium <path>     the Chromium to drive (Playwright's own where none is given)
//   --json                the violations as JSON, on the standard output
//
// Axe and Playwright are the TypeScript side's (`yarn install` in implementations/typescript).
// Each violation is printed by its rule, its element and the pages it was found on; an exception
// names a rule, a selector and its reason. Exit 1 on any violation, or on a page that fails to load.
// Tests import `auditPage` to hold a page they bring to a state of their own.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TYPESCRIPT = join(ROOT, 'implementations', 'typescript');
export const EXCEPTIONS = join(HERE, 'a11y-exceptions.json');

export const TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
export const SCHEMES = Object.freeze(['light', 'dark']);
export const WIDTHS = Object.freeze([1280, 390]);
// the width WCAG 1.4.10 sets, 1280 CSS px at 400 %
const REFLOW = 320;
// the skin's `--app-touch`, the least a control a finger reaches is, tall and wide
const TOUCH = 44;
const HEIGHT = 900;
// the walk's bound, Tab after Tab: a page with more stops is cut there, and says so
const TABS = 600;
// a control whose name changes as it acts, rather than a state: Bead's theme switch
const NAMED_TOGGLES = '[data-action="theme"]';

// every check, in the order `auditPage` runs them: axe first, the ones that move the page after
export const CHECKS = Object.freeze([
  'axe',
  'use-of-color',
  'text-spacing',
  'keyboard',
  'target-size-coarse',
  'reduced-motion',
  'reflow',
  'name-role-value',
]);

const CRITERIA = Object.freeze({
  reflow: '1.4.10',
  'text-spacing': '1.4.12',
  keyboard: '2.1.1',
  'focus-order': '2.4.3',
  'focus-visible': '2.4.7',
  'focus-not-obscured': '2.4.11',
  'target-size-coarse': '2.5.8',
  'name-role-value': '4.1.2',
  'reduced-motion': '2.3.3',
  'use-of-color': '1.4.1',
});

const TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
});

// ── The tools ─────────────────────────────────────────────────────────────────

// axe's builder and Playwright's Chromium, from the TypeScript side's install, one copy of each, so
// a page a test brings is driven by the Playwright its axe is given
export const toolsOf = async () => {
  const require = createRequire(join(TYPESCRIPT, 'package.json'));
  let paths;
  try {
    paths = {
      axe: require.resolve('@axe-core/playwright'),
      playwright: require.resolve('@playwright/test'),
    };
  } catch {
    throw new Error(
      'check-a11y: axe or Playwright is not installed: yarn install, in implementations/typescript'
    );
  }
  const axe = await import(pathToFileURL(paths.axe).href);
  const playwright = await import(pathToFileURL(paths.playwright).href);
  return {
    AxeBuilder: axe.default.default ?? axe.default,
    chromium: playwright.chromium ?? playwright.default.chromium,
  };
};

// the exceptions a file holds, each a rule, a selector and its reason; one without all three is
// refused
export const exceptionsOf = (path = EXCEPTIONS) => {
  if (!existsSync(path)) {
    return [];
  }
  const read = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(read) ? read : (read.exceptions ?? []);
  for (const exception of list) {
    for (const key of ['rule', 'selector', 'reason']) {
      if (typeof exception[key] !== 'string' || exception[key].trim() === '') {
        throw new Error(`check-a11y: an exception in ${path} has no ${key}`);
      }
    }
  }
  return list;
};

// ── In the page ───────────────────────────────────────────────────────────────

// ! the checks' bodies below run in the page, as text: each reads nothing of this module's scope but
// the helpers and what it is given

// a selector that finds `element` alone, from its nearest ancestor with an id
const PAGE_HELPERS = String.raw`
  const selectorOf = (element) => {
    const steps = [];
    for (let at = element; at !== null && at.nodeType === 1; at = at.parentElement) {
      if (at.id !== '' && document.querySelectorAll('#' + CSS.escape(at.id)).length === 1) {
        steps.unshift('#' + CSS.escape(at.id));
        break;
      }
      const tag = at.tagName.toLowerCase();
      if (at.parentElement === null) {
        steps.unshift(tag);
        break;
      }
      const same = [...at.parentElement.children].filter((child) => child.tagName === at.tagName);
      steps.unshift(same.length === 1 ? tag : tag + ':nth-of-type(' + (same.indexOf(at) + 1) + ')');
    }
    return steps.join(' > ');
  };
  const nameOf = (element) => {
    const label = element.getAttribute('aria-label');
    if (label !== null && label.trim() !== '') {
      return label.trim();
    }
    const by = element.getAttribute('aria-labelledby');
    if (by !== null) {
      return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    }
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  };
  const describe = (element) => {
    const text = nameOf(element).slice(0, 32);
    return selectorOf(element) + (text === '' ? '' : ' "' + text + '"');
  };
  const isDrawn = (element) => {
    if (element.checkVisibility !== undefined && !element.checkVisibility({ visibilityProperty: true })) {
      return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
`;

// the page's helpers, then `body`, run in the page with `given`; as text, as the console runs it,
// so a page's policy that refuses `eval` does not refuse it
const inPage = (page, body, given = null) => {
  return page.evaluate(
    `(async () => {
const given = ${JSON.stringify(given)};
${PAGE_HELPERS}
${body}
})()`
  );
};

// two frames, so a change of size or style is laid out, then every finite transition ended
const settled = (page) => {
  return page.evaluate(async () => {
    await new Promise((done) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          done();
        });
      });
    });
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => {
          return animation.effect?.getComputedTiming().endTime !== Infinity;
        })
        .map((animation) => {
          return animation.finished.catch(() => {});
        })
    );
  });
};

// ── Checks ────────────────────────────────────────────────────────────────────

const violation = (rule, element, message) => {
  return { rule, element, message };
};

// axe's violations, each node one
const axeOf = async (page, AxeBuilder) => {
  const results = await new AxeBuilder({ page }).withTags([...TAGS]).analyze();
  return results.violations.flatMap((found) => {
    return found.nodes.map((node) => {
      return {
        rule: found.id,
        element: node.target.join(' '),
        message: [
          found.help,
          ...[...node.any, ...node.all, ...node.none].map((check) => check.message),
        ]
          .filter((said) => said !== undefined && said !== '')
          .join('; '),
        selector: node.target.join(' '),
      };
    });
  });
};

// axe on the page, then with each disclosure or menu drawn closed opened alone, then closed again
const checkAxe = async (page, { AxeBuilder }) => {
  const found = await axeOf(page, AxeBuilder);
  const closed = await inPage(
    page,
    `return [...document.querySelectorAll('[aria-expanded="false"]')]
      .filter((element) => isDrawn(element) && !element.matches('[role="combobox"]'))
      .map((element) => selectorOf(element));`
  );
  for (const toggle of closed) {
    const opened = await inPage(
      page,
      `const element = document.querySelector(given);
      if (element === null || element.getAttribute('aria-expanded') !== 'false') {
        return null;
      }
      element.click();
      return describe(element);`,
      toggle
    );
    if (opened === null) {
      continue;
    }
    await settled(page);
    // what the opened state adds alone: what holds closed too is said once
    for (const each of await axeOf(page, AxeBuilder)) {
      if (
        !found.some((known) => {
          return known.rule === each.rule && known.selector === each.selector;
        })
      ) {
        found.push({ ...each, message: `${each.message}, ${opened} open` });
      }
    }
    await inPage(
      page,
      `const element = document.querySelector(given);
      if (element !== null && element.getAttribute('aria-expanded') === 'true') {
        element.click();
      }
      if (element !== null && element.getAttribute('aria-expanded') === 'true') {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }`,
      toggle
    );
    await settled(page);
  }
  return found;
};

// rows of two statuses that a named glyph does not tell apart, or a row that names none
const checkColour = (page) => {
  return inPage(
    page,
    `const found = [];
    const names = new Map();
    for (const row of document.querySelectorAll('[data-status]')) {
      if (!isDrawn(row)) {
        continue;
      }
      const glyphs = [...row.querySelectorAll('[role="img"][aria-label], img[alt], [aria-label]')]
        .filter((glyph) => glyph.closest('[aria-hidden="true"]') === null)
        .map((glyph) => (glyph.getAttribute('aria-label') ?? glyph.getAttribute('alt') ?? '').trim())
        .filter((name) => name !== '');
      // where no glyph names it, the row's own words do, short enough to be a status's
      const words = (row.textContent ?? '').replace(/\\s+/g, ' ').trim();
      if (glyphs.length === 0 && words !== '' && words.length <= 40 && row.children.length === 0) {
        glyphs.push(words);
      }
      if (glyphs.length === 0) {
        found.push({ rule: 'use-of-color', element: describe(row), selector: selectorOf(row),
          message: 'its status, ' + row.dataset.status + ', is told by colour alone: no glyph names it' });
        continue;
      }
      const status = row.dataset.status;
      const common = names.get(status);
      names.set(status, common === undefined ? new Set(glyphs) : new Set(glyphs.filter((name) => common.has(name))));
    }
    const statuses = [...names.keys()];
    for (const status of statuses) {
      if (names.get(status).size === 0) {
        found.push({ rule: 'use-of-color', element: '[data-status="' + status + '"]', selector: '[data-status]',
          message: 'the rows of its status, ' + status + ', share no name: told by colour alone' });
      }
    }
    for (const [at, one] of statuses.entries()) {
      for (const other of statuses.slice(at + 1)) {
        const said = [...names.get(one)];
        const otherSaid = names.get(other);
        if (said.length > 0 && said.length === otherSaid.size && said.every((name) => otherSaid.has(name))) {
          found.push({ rule: 'use-of-color', element: '[data-status="' + one + '"], [data-status="' + other + '"]',
            selector: '[data-status]', message: 'two statuses, ' + one + ' and ' + other + ', named alike: told by colour alone' });
        }
      }
    }
    return found;`
  );
};

// the elements that clip their text once WCAG 1.4.12's spacing is set, which did not before
const checkSpacing = async (page) => {
  const clippedNow = `const clipped = new Set();
    for (const element of document.body.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      const hides = (overflow) => overflow === 'hidden' || overflow === 'clip';
      if (!hides(style.overflowX) && !hides(style.overflowY)) {
        continue;
      }
      if (!isDrawn(element) || (element.textContent ?? '').trim() === '') {
        continue;
      }
      const wide = hides(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
      const tall = hides(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      if (wide || tall) {
        clipped.add(selectorOf(element));
      }
    }
    return [...clipped];`;
  const before = new Set(await inPage(page, clippedNow));
  await inPage(
    page,
    `const style = document.createElement('style');
    style.id = 'check-a11y-spacing';
    style.textContent = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
    document.head.append(style);`
  );
  await settled(page);
  const after = await inPage(page, clippedNow);
  const found = await inPage(
    page,
    `return given.map((selector) => {
      const element = document.querySelector(selector);
      return { rule: 'text-spacing', element: element === null ? selector : describe(element), selector,
        message: 'clips its text under the spacing overrides' };
    });`,
    after.filter((selector) => {
      return !before.has(selector);
    })
  );
  await inPage(page, `document.getElementById('check-a11y-spacing')?.remove();`);
  await settled(page);
  return found;
};

// what the focused element looks like, itself, its parent and its pseudo-elements, as text
const LOOK = `const lookOf = (element) => {
    const parts = [];
    for (const [at, pseudo] of [[element, null], [element, '::before'], [element, '::after'], [element.parentElement, null]]) {
      if (at === null) {
        continue;
      }
      const style = getComputedStyle(at, pseudo);
      parts.push(style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow,
        style.backgroundColor, style.borderColor, style.borderWidth, style.color, style.textDecorationLine);
    }
    return parts.join('|');
  };`;

// one Tab stop, read where the focus is: its order, whether it is drawn, covered and shown
const STOP = `${LOOK}
      const element = document.activeElement;
      if (element === null || element === document.body || element.id === 'check-a11y-start') {
        return null;
      }
      const selector = selectorOf(element);
      const faults = [];
      const tabindex = element.getAttribute('tabindex');
      if (tabindex !== null && Number(tabindex) > 0) {
        faults.push(['focus-order', 'a positive tabindex takes it out of the page’s order']);
      }
      const box = element.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const onScreen = box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < width && box.top < height;
      if (!onScreen) {
        faults.push(['focus-order', 'the focus lands on what the screen does not draw']);
      } else {
        const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([x, y]) => [box.left + box.width * x, box.top + box.height * y]);
        const covers = [];
        let seen = false;
        for (const [x, y] of points) {
          if (x < 0 || y < 0 || x >= width || y >= height) {
            continue;
          }
          const hit = document.elementFromPoint(x, y);
          if (hit === null || element.contains(hit) || hit.contains(element) || [...(element.labels ?? [])].some((label) => label.contains(hit))) {
            seen = true;
            break;
          }
          covers.push(hit);
        }
        if (!seen) {
          const cover = covers[0];
          faults.push(['focus-not-obscured', 'wholly under ' + (cover === undefined ? 'the screen’s edge' : describe(cover))]);
        }
      }
      const unfocused = globalThis.checkA11yLooks.get(element);
      if (unfocused !== undefined && lookOf(element) === unfocused) {
        faults.push(['focus-visible', 'looks the same focused and unfocused']);
      }
      return { selector, described: describe(element), faults };`;

// the Tab key's walk from the top of the page: where it stops, how each stop looks against itself
// unfocused, whether a sticky bar covers it, then the controls drawn it never reached
const checkKeyboard = async (page) => {
  // * a smooth scroll would be measured midway: the walk scrolls at once, where the focus ends the same
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await inPage(
    page,
    `window.scrollTo(0, 0);
    const start = document.createElement('span');
    start.id = 'check-a11y-start';
    start.tabIndex = -1;
    // ! out of the flow: a grid or a flex body would give it a track, and move every row after it
    start.style.cssText = 'position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none';
    document.body.prepend(start);
    start.focus();
    ${LOOK}
    globalThis.checkA11yLooks = new Map();
    for (const element of document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]')) {
      globalThis.checkA11yLooks.set(element, lookOf(element));
    }`
  );
  const found = [];
  const reached = new Set();
  // the stops of one walk, by `key`, until the focus leaves the page or comes back to its first
  const walk = async (key) => {
    const stops = [];
    let first;
    for (let tabs = 0; tabs < TABS; tabs += 1) {
      await page.keyboard.press(key);
      const stop = await inPage(page, STOP);
      if (stop === null || stop.selector === first) {
        return { stops, ended: true };
      }
      first ??= stop.selector;
      stops.push(stop);
    }
    return { stops, ended: false };
  };
  const forth = await walk('Tab');
  for (const stop of forth.stops) {
    if (reached.has(stop.selector)) {
      continue;
    }
    reached.add(stop.selector);
    for (const [rule, message] of stop.faults) {
      found.push({ rule, element: stop.described, selector: stop.selector, message });
    }
  }
  // * back from the end, a stop lands at the screen's top, where a sticky bar or strip stands
  if (forth.ended) {
    const met = new Set();
    for (const stop of (await walk('Shift+Tab')).stops) {
      for (const [rule, message] of stop.faults) {
        if (rule === 'focus-not-obscured' && !met.has(stop.selector)) {
          met.add(stop.selector);
          found.push({
            rule,
            element: stop.described,
            selector: stop.selector,
            message: `${message}, Shift+Tab`,
          });
        }
      }
    }
  }
  const ended = forth.ended;
  const done = async () => {
    await page.emulateMedia({ reducedMotion: null });
    await inPage(
      page,
      `document.getElementById('check-a11y-start')?.remove();
      delete globalThis.checkA11yLooks;`
    );
  };
  if (!ended) {
    await done();
    found.push(
      violation(
        'keyboard',
        'body',
        `the walk ends at ${String(TABS)} Tab stops, the page not wholly walked`
      )
    );
    return found;
  }
  // a control drawn that no Tab reached; one of a composite widget is reached by its group's stop
  const missed = await inPage(
    page,
    `const reached = new Set(given);
    const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [tabindex]';
    const GROUPS = '[role="tablist"], [role="radiogroup"], [role="menu"], [role="menubar"], [role="listbox"], [role="grid"], [role="tree"], [role="treegrid"], [role="toolbar"], table, ul, ol';
    const missed = [];
    for (const element of document.querySelectorAll(CONTROLS)) {
      if (element.id === 'check-a11y-start' || !isDrawn(element) || element.matches(':disabled, [aria-disabled="true"]') || element.closest('[inert], [aria-hidden="true"]') !== null) {
        continue;
      }
      if (element.matches('[tabindex="-1"]') && !element.matches('a[href], button, input, select, textarea, summary, [role]')) {
        continue;
      }
      if (Number(element.getAttribute('tabindex') ?? 0) > 0) {
        missed.push({ rule: 'focus-order', element: describe(element), selector: selectorOf(element), message: 'a positive tabindex takes it out of the page’s order' });
        continue;
      }
      if (reached.has(selectorOf(element))) {
        continue;
      }
      // a native radio is reached by the stop of its group, the radios of its name
      if (element.matches('input[type="radio"]') && element.name !== '' && [...document.getElementsByName(element.name)].some((radio) => reached.has(selectorOf(radio)))) {
        continue;
      }
      const group = element.closest(GROUPS);
      if (element.matches('[tabindex="-1"]') && group !== null && [...group.querySelectorAll('*')].some((member) => reached.has(selectorOf(member)))) {
        continue;
      }
      // a control inside a control, as a link inside a summary, is reached with it
      if ([...reached].some((selector) => document.querySelector(selector)?.contains(element) ?? false)) {
        continue;
      }
      missed.push({ rule: 'keyboard', element: describe(element), selector: selectorOf(element), message: 'drawn, and no Tab reaches it' });
    }
    return missed;`,
    [...reached]
  );
  await done();
  return [...found, ...missed];
};

// on a coarse pointer, the controls a finger reaches under TOUCH either way; a link inside a
// sentence is exempt, as WCAG 2.5.8 exempts it
const checkTouch = async (page) => {
  const coarse = await page.evaluate(() => {
    return matchMedia('(pointer: coarse)').matches;
  });
  if (!coarse) {
    return [];
  }
  return inPage(
    page,
    `const found = [];
    const seen = new Set();
    for (const element of document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="button"], [role="radio"], [role="link"]')) {
      if (element.matches('a') && element.closest('p, li, dd, figcaption, td') !== null && element.closest('header, nav, .strip, [role="toolbar"]') === null) {
        continue;
      }
      const target = element.matches('input') ? (element.closest('label') ?? element) : element;
      if (seen.has(target) || !isDrawn(target)) {
        continue;
      }
      seen.add(target);
      const { width, height } = target.getBoundingClientRect();
      if (width < given - 0.5 || height < given - 0.5) {
        found.push({ rule: 'target-size-coarse', element: describe(target), selector: selectorOf(target),
          message: Math.round(width) + '×' + Math.round(height) + ' px, under ' + given + ' on a coarse pointer' });
      }
    }
    return found;`,
    TOUCH
  );
};

// what still moves under `prefers-reduced-motion: reduce`: a smooth scroll, a transition of where
// or how big a thing is, an animation whose frames move it
const checkMotion = async (page) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settled(page);
  const found = await inPage(
    page,
    `const MOVES = /^(all|transform|translate|rotate|scale|top|right|bottom|left|inset|margin.*|width|height|max-height|max-width|offset.*)$/;
    const found = [];
    const seconds = (value) => value.trim().endsWith('ms') ? parseFloat(value) / 1000 : parseFloat(value);
    const smooth = (element) => getComputedStyle(element).scrollBehavior === 'smooth';
    if (smooth(document.documentElement)) {
      found.push({ rule: 'reduced-motion', element: 'html', selector: 'html', message: 'scrolls smoothly' });
    }
    const keyframes = new Map();
    for (const sheet of document.styleSheets) {
      let rules = [];
      try {
        rules = [...sheet.cssRules];
      } catch {
        continue;
      }
      const walk = (list) => {
        for (const rule of list) {
          if (rule instanceof CSSKeyframesRule) {
            keyframes.set(rule.name, [...rule.cssRules].some((frame) => [...frame.style].some((property) => MOVES.test(property))));
          } else if (rule.cssRules !== undefined) {
            walk([...rule.cssRules]);
          }
        }
      };
      walk(rules);
    }
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      const properties = style.transitionProperty.split(',');
      const durations = style.transitionDuration.split(',');
      const moving = properties.filter((property, at) => MOVES.test(property.trim()) && seconds(durations[at % durations.length]) > 0.01);
      if (moving.length > 0) {
        found.push({ rule: 'reduced-motion', element: describe(element), selector: selectorOf(element),
          message: 'a transition of ' + moving.map((each) => each.trim()).join(', ') + ' under reduced motion' });
      }
      const names = style.animationName.split(',');
      const animated = style.animationDuration.split(',');
      const moves = names.filter((name, at) => name.trim() !== 'none' && seconds(animated[at % animated.length]) > 0.01 && keyframes.get(name.trim()) !== false);
      if (moves.length > 0) {
        found.push({ rule: 'reduced-motion', element: describe(element), selector: selectorOf(element),
          message: 'an animation, ' + moves.map((each) => each.trim()).join(', ') + ', under reduced motion' });
      }
      if (element !== document.documentElement && smooth(element) && element.scrollHeight > element.clientHeight) {
        found.push({ rule: 'reduced-motion', element: describe(element), selector: selectorOf(element), message: 'scrolls smoothly' });
      }
    }
    return found;`
  );
  await page.emulateMedia({ reducedMotion: null });
  await settled(page);
  return found;
};

// the page at 320 px: what is wider than the screen, the outermost of it
const checkReflow = async (page) => {
  const size = page.viewportSize() ?? { width: WIDTHS[0], height: HEIGHT };
  await page.setViewportSize({ width: REFLOW, height: size.height });
  await settled(page);
  const found = await inPage(
    page,
    `const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth) {
      return [];
    }
    const wide = [...document.body.querySelectorAll('*')].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.right > root.clientWidth + 1 && getComputedStyle(element).position !== 'fixed';
    });
    const outermost = wide.filter((element) => !wide.includes(element.parentElement)).slice(0, 3);
    return [{ rule: 'reflow', element: outermost.map((element) => describe(element)).join(', ') || 'html', selector: 'html',
      message: 'the page scrolls sideways at ${String(REFLOW)} px, ' + root.scrollWidth + ' in ' + root.clientWidth }];`
  );
  await page.setViewportSize(size);
  await settled(page);
  return found;
};

// each tab, radio and toggle acted on: its state is the one it now has, then it is put back
const checkStates = async (page) => {
  const controls = await inPage(
    page,
    `const found = [];
    const groups = [];
    for (const list of document.querySelectorAll('[role="tablist"], [role="radiogroup"]')) {
      const isTabs = list.matches('[role="tablist"]');
      const members = [...list.querySelectorAll(isTabs ? '[role="tab"]' : '[role="radio"]')].filter((member) => isDrawn(member) && member.closest('[role="tablist"], [role="radiogroup"]') === list);
      if (members.length === 0) {
        continue;
      }
      const state = isTabs ? 'aria-selected' : 'aria-checked';
      const on = members.filter((member) => member.getAttribute(state) === 'true');
      if (isTabs && on.length !== 1) {
        found.push({ rule: 'name-role-value', element: describe(list), selector: selectorOf(list), message: on.length + ' tabs say they are selected, not one' });
      }
      if (!isTabs && on.length > 1) {
        found.push({ rule: 'name-role-value', element: describe(list), selector: selectorOf(list), message: on.length + ' radios say they are checked' });
      }
      for (const member of members) {
        if (member.getAttribute(state) === null) {
          found.push({ rule: 'name-role-value', element: describe(member), selector: selectorOf(member), message: 'says no ' + state });
        }
      }
      const other = members.find((member) => member.getAttribute(state) !== 'true');
      if (other !== undefined && !(other.matches('a[href]') && !other.getAttribute('href').startsWith('#'))) {
        groups.push({ kind: 'group', state, other: selectorOf(other), back: on[0] === undefined ? null : selectorOf(on[0]) });
      }
    }
    const toggles = [...document.querySelectorAll('button[aria-pressed], [role="switch"], [role="checkbox"]:not(input)')]
      .filter((toggle) => isDrawn(toggle))
      .map((toggle) => ({ kind: 'toggle', selector: selectorOf(toggle), state: toggle.matches('[aria-pressed]') ? 'aria-pressed' : 'aria-checked' }));
    const named = [...document.querySelectorAll(given)].filter((toggle) => isDrawn(toggle)).map((toggle) => ({ kind: 'named', selector: selectorOf(toggle) }));
    return { found, acts: [...groups, ...toggles, ...named] };`,
    NAMED_TOGGLES
  );
  const found = [...controls.found];
  // * each read finds its element again: a view that draws itself anew on a click replaces it
  const click = async (selector) => {
    await inPage(page, `document.querySelector(given)?.click();`, selector);
    await settled(page);
  };
  const read = (selector, state) => {
    return inPage(
      page,
      `const element = document.querySelector(given.selector);
      if (element === null) {
        return null;
      }
      const state = given.state === null ? null : element.getAttribute(given.state);
      return { described: describe(element), said: given.state === null ? nameOf(element) + '|' + (element.getAttribute('aria-pressed') ?? '') : state };`,
      { selector, state }
    );
  };
  const fault = (selector, element, message) => {
    found.push({ rule: 'name-role-value', selector, element, message });
  };
  for (const act of controls.acts) {
    if (act.kind === 'group') {
      await click(act.other);
      const chosen = await read(act.other, act.state);
      const was = act.back === null ? null : await read(act.back, act.state);
      if (act.back !== null) {
        await click(act.back);
      }
      if (chosen !== null && chosen.said !== 'true') {
        fault(act.other, chosen.described, `chosen, it says ${act.state}="${String(chosen.said)}"`);
      } else if (was !== null && was.said === 'true') {
        fault(act.back, was.described, `still says ${act.state}="true" once another is chosen`);
      }
      continue;
    }
    const state = act.kind === 'toggle' ? act.state : null;
    const before = await read(act.selector, state);
    await click(act.selector);
    const after = await read(act.selector, state);
    await click(act.selector);
    if (before !== null && after !== null && before.said === after.said) {
      fault(
        act.selector,
        before.described,
        act.kind === 'toggle'
          ? `acted on, it still says ${act.state}="${String(after.said)}"`
          : 'acted on, its name and its state say the same'
      );
    }
  }
  return found;
};

// ── Auditing a page ───────────────────────────────────────────────────────────

// the violations no exception covers: an exception names a rule and a selector the element matches
const unexcepted = async (page, found, exceptions) => {
  if (exceptions.length === 0 || found.length === 0) {
    return found;
  }
  const kept = await page.evaluate(
    ({ found, exceptions }) => {
      return found.map((each) => {
        return !exceptions.some((exception) => {
          if (exception.rule !== each.rule) {
            return false;
          }
          let element = null;
          try {
            element = document.querySelector(each.selector);
          } catch {
            element = null;
          }
          return element !== null && element.matches(exception.selector);
        });
      });
    },
    { found, exceptions }
  );
  return found.filter((_, at) => {
    return kept[at];
  });
};

/**
 * The violations of the page as it stands, at its own size and scheme: each `{ rule, element,
 * message, page }`. `checks` picks among CHECKS; `label` names the page in each; `exceptions` are
 * the file's. The page is left as it was given, its size, its media and its focus aside.
 */
export const auditPage = async (page, { label = page.url(), checks = CHECKS, exceptions } = {}) => {
  const tools = await toolsOf();
  const excepted = exceptions ?? exceptionsOf();
  const runs = {
    axe: () => checkAxe(page, tools),
    'use-of-color': () => checkColour(page),
    'text-spacing': () => checkSpacing(page),
    keyboard: () => checkKeyboard(page),
    'target-size-coarse': () => checkTouch(page),
    'reduced-motion': () => checkMotion(page),
    reflow: () => checkReflow(page),
    'name-role-value': () => checkStates(page),
  };
  await settled(page);
  const found = [];
  for (const check of CHECKS) {
    if (checks.includes(check)) {
      found.push(...(await unexcepted(page, await runs[check](), excepted)));
    }
  }
  return found.map(({ rule, element, message }) => {
    return { rule, element, message, page: label };
  });
};

/** The violations, one line each, grouped by rule and element, the pages each was found on. */
export const reportOf = (found) => {
  const groups = new Map();
  for (const each of found) {
    const key = `${each.rule}\u0000${each.element}\u0000${each.message}`;
    const pages = groups.get(key) ?? new Set();
    pages.add(each.page);
    groups.set(key, pages);
  }
  return [...groups.entries()]
    .map(([key, pages]) => {
      const [rule, element, message] = key.split('\u0000');
      const criterion = CRITERIA[rule] === undefined ? '' : ` (${CRITERIA[rule]})`;
      return `${rule}${criterion}: ${element}: ${message}\n    on ${[...pages].join('; ')}`;
    })
    .sort();
};

// ── Serving ───────────────────────────────────────────────────────────────────

// a folder as a static host serves it: a folder's path its index.html, a file by its type, every
// other path the folder's 404.html, answered 404
export const serveFolder = (folder) => {
  const root = resolve(folder);
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    let file = resolve(root, `.${path}`);
    if (path.endsWith('/')) {
      file = join(file, 'index.html');
    } else if (existsSync(join(file, 'index.html'))) {
      response.writeHead(301, { location: `${path}/` });
      response.end();
      return;
    }
    if ((file === root || file.startsWith(`${root}${sep}`)) && existsSync(file) && extname(file)) {
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      });
      response.end(readFileSync(file));
      return;
    }
    const missing = join(root, '404.html');
    response.writeHead(404, { 'content-type': TYPES['.html'] });
    response.end(existsSync(missing) ? readFileSync(missing) : 'not found');
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done({
        url: `http://127.0.0.1:${String(server.address().port)}/`,
        close: () => {
          return new Promise((closed) => {
            server.close(() => {
              closed();
            });
          });
        },
      });
    });
  });
};

// ── Auditing an address ───────────────────────────────────────────────────────

const loaded = async (page, url) => {
  await page.goto(url, { waitUntil: 'load' });
  await settled(page);
};

// what a scheme changes, at every width of every scheme: what axe and the colour check read
export const EACH_SCHEME = Object.freeze(['axe', 'use-of-color']);
// what a width changes, at every width of the first scheme
export const EACH_WIDTH = Object.freeze([...EACH_SCHEME, 'text-spacing', 'keyboard']);
// what neither changes, once
export const ONCE = Object.freeze(['reduced-motion', 'reflow', 'name-role-value']);

/**
 * The violations of an address, in each scheme and at each width: axe and the colour at every
 * one, the spacing and the keyboard at each width of the first scheme, the motion, the reflow and
 * the states once, and a finger's targets on a coarse pointer at 390 px. `prepare`, where given,
 * brings each load to its state.
 */
export const auditAddress = async (
  browser,
  url,
  { schemes = SCHEMES, widths = WIDTHS, exceptions, prepare, label = url } = {}
) => {
  const found = [];
  const open = async (options) => {
    const context = await browser.newContext({ bypassCSP: true, ...options });
    const page = await context.newPage();
    await loaded(page, url);
    if (prepare !== undefined) {
      await prepare(page);
      await settled(page);
    }
    return { context, page };
  };
  for (const [at, scheme] of schemes.entries()) {
    const { context, page } = await open({
      colorScheme: scheme,
      viewport: { width: widths[0] ?? WIDTHS[0], height: HEIGHT },
    });
    try {
      for (const width of widths) {
        await page.setViewportSize({ width, height: HEIGHT });
        found.push(
          ...(await auditPage(page, {
            label: `${label}, ${scheme}, ${String(width)} px`,
            checks: at === 0 ? EACH_WIDTH : EACH_SCHEME,
            exceptions,
          }))
        );
      }
      if (at === 0) {
        found.push(
          ...(await auditPage(page, {
            label: `${label}, ${scheme}`,
            checks: ONCE,
            exceptions,
          }))
        );
      }
    } finally {
      await context.close();
    }
  }
  const { context, page } = await open({
    colorScheme: schemes[0] ?? 'light',
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    found.push(
      ...(await auditPage(page, {
        label: `${label}, a coarse pointer`,
        checks: ['target-size-coarse'],
        exceptions,
      }))
    );
  } finally {
    await context.close();
  }
  return found;
};

// ── Run ───────────────────────────────────────────────────────────────────────

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      serve: { type: 'string' },
      scheme: { type: 'string', multiple: true },
      width: { type: 'string', multiple: true },
      exceptions: { type: 'string' },
      chromium: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const schemes = values.scheme ?? [...SCHEMES];
  for (const scheme of schemes) {
    if (!SCHEMES.includes(scheme)) {
      throw new Error(`check-a11y: no scheme ${scheme}: light or dark`);
    }
  }
  const widths = (values.width ?? WIDTHS.map(String)).map((width) => {
    const px = Number(width);
    if (!Number.isInteger(px) || px < REFLOW) {
      throw new Error(
        `check-a11y: a width of ${width}: a whole number of px, ${String(REFLOW)} or more`
      );
    }
    return px;
  });
  const exceptions = exceptionsOf(values.exceptions ?? EXCEPTIONS);
  const served = values.serve === undefined ? undefined : await serveFolder(values.serve);
  const addresses = (positionals.length > 0 ? positionals : served === undefined ? [] : ['/']).map(
    (address) => {
      return served === undefined ? address : new URL(address.replace(/^\//, ''), served.url).href;
    }
  );
  if (addresses.length === 0) {
    throw new Error('check-a11y: no address: give URLs, or --serve <folder> and its paths');
  }
  const { chromium } = await toolsOf();
  const browser = await chromium.launch(
    values.chromium === undefined ? {} : { executablePath: values.chromium }
  );
  const found = [];
  try {
    for (const address of addresses) {
      const label = served === undefined ? address : address.slice(served.url.length - 1);
      found.push(...(await auditAddress(browser, address, { schemes, widths, exceptions, label })));
    }
  } finally {
    await browser.close();
    await served?.close();
  }
  if (values.json === true) {
    console.log(JSON.stringify(found, null, 2));
  } else if (found.length === 0) {
    console.log(`check-a11y: ${String(addresses.length)} pages, no violation`);
  } else {
    console.error(reportOf(found).join('\n'));
    console.error(`check-a11y: ${String(found.length)} violations`);
  }
  if (found.length > 0) {
    process.exitCode = 1;
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
