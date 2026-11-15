// ── Demo page ─────────────────────────────────────────────────────────────────

// The demo's page in Chromium: its faces, its theme and its top bar, its controls' size and its
// code's, in its static build and as its launcher serves it; and over MQTT 5, served by its launcher beside the Mosquitto `BEAD_MQTT_URL` names
// (`node tools/mqtt-broker.mjs run -- yarn test:demo`), as `?transport=mqtt` links it: where none
// is given, skipped, saying so, or failed where `BEAD_MQTT_REQUIRED=1`.

// dependencies

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  outcomeOf,
  PLAYGROUND,
  rowFaultsOf,
  serveFolder,
  serveMqttDemo,
} from '../../devtools/__tests__/fixtures';

// constants

/** The page's three faces, which the demo sets its text in. */
const FACES = Object.freeze(['Geist', 'Geist Mono', 'Newsreader']);

/** Where the page keeps the theme chosen: a JSON boolean, true for dark. */
const THEME_KEY = 'theme-preference';

const NO_BROKER =
  'no broker: BEAD_MQTT_URL or BEAD_MQTT_WS_URL is not set (node tools/mqtt-broker.mjs start)';
const HAS_BROKER =
  process.env['BEAD_MQTT_URL'] !== undefined && process.env['BEAD_MQTT_WS_URL'] !== undefined;
const IS_MQTT_REQUIRED = process.env['BEAD_MQTT_REQUIRED'] === '1';

/** How long a glyph has to cross, each way: the page's own timeout for it. */
const GLYPH_TIMEOUT = 60_000;

/** The widths the bar is held at: a small phone to a wide desktop, each side of every breakpoint. */
const WIDTHS = Object.freeze([320, 390, 600, 899, 900, 1199, 1200, 1440]);

/** The page's scenes, by their fragments. */
const SCENES = Object.freeze(['calls', 'rules', 'openapi', 'server', 'code', 'packages']);

/** The least a control a finger reaches is, tall and wide: the skin's `--app-touch`. */
const TOUCH = 44;

// helpers

/** The faces the page has loaded, by their families. */
const facesOf = (page: Page): Promise<string[]> => {
  return page.evaluate(async () => {
    await document.fonts.ready;

    return [...document.fonts]
      .filter((face) => {
        return face.status === 'loaded';
      })
      .map((face) => {
        return face.family.replaceAll('"', '');
      })
      .sort();
  });
};

/** The scheme the root held once the document was parsed, before a deferred script ran. */
const parsedSchemeOf = (page: Page): Promise<unknown> => {
  return page.evaluate(() => {
    return (globalThis as { parsedScheme?: unknown }).parsedScheme;
  });
};

/**
 * The controls a finger reaches that are under `TOUCH` either way. A link inside a sentence is
 * exempt, as WCAG 2.5.8 exempts it; a box inside its label is reached by its label, which is
 * measured instead.
 */
const smallTargetsOf = (page: Page): Promise<string[]> => {
  return page.evaluate((touch) => {
    const small = new Set<string>();

    for (const element of document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [role="tab"], label'
    )) {
      if (
        element.matches('a') &&
        element.closest('p, li, dd, figcaption, td') !== null &&
        element.closest('header, nav, .strip') === null
      ) {
        continue;
      }

      const target = element.matches('input') ? (element.closest('label') ?? element) : element;

      // a label that holds no control is text, not a target
      if (target.matches('label') && target.querySelector('input, select, textarea') === null) {
        continue;
      }

      const { height, width } = target.getBoundingClientRect();

      if (width > 0 && height > 0 && (width < touch - 0.5 || height < touch - 0.5)) {
        small.add(
          `${target.tagName.toLowerCase()}${target.id === '' ? '' : `#${target.id}`} ${String(Math.round(width))}x${String(Math.round(height))} "${target.textContent.trim().slice(0, 24)}"`
        );
      }
    }

    return [...small];
  }, TOUCH);
};

/**
 * The outline `selector`'s first element draws once the keyboard reaches it, Tab after Tab from
 * where the focus is; `none` where it draws none, or where no Tab reaches it.
 */
const outlineByTabOf = async (page: Page, selector: string): Promise<string> => {
  for (let tabs = 0; tabs < 40; tabs += 1) {
    await page.keyboard.press('Tab');

    const style = await page.evaluate((wanted) => {
      const focused = document.activeElement;

      return focused !== null && focused.matches(wanted) && focused.matches(':focus-visible')
        ? getComputedStyle(focused).outlineStyle
        : undefined;
    }, selector);

    if (style !== undefined) {
      return style;
    }
  }

  return 'none';
};

/** The sizes code is set in, by what holds it: each block, and the wire's log. */
const codeSizesOf = (page: Page): Promise<string[]> => {
  return page.evaluate(() => {
    return [
      ...new Set(
        [...document.querySelectorAll('pre, pre code, .log ol')].map((element) => {
          return getComputedStyle(element).fontSize;
        })
      ),
    ];
  });
};

// definition

// ! the launcher builds into `demo/dist/`, which two of it at once would write together
test.describe.configure({ mode: 'default' });

test.describe('the demo’s page', () => {
  // the demo's static build, served for each worker of the run
  let served: Awaited<ReturnType<typeof serveFolder>> | undefined;

  test.beforeAll(async () => {
    try {
      await access(join(PLAYGROUND, 'index.html'));
    } catch {
      throw new Error(`${PLAYGROUND} is not there: run yarn playground:build:file first`);
    }

    served = await serveFolder(PLAYGROUND);
  });

  test.afterAll(async () => {
    await served?.close();
  });

  test('sets its text in Geist, Geist Mono and Newsreader', async ({ page }) => {
    await page.goto(served?.url ?? '');
    await expect
      .poll(() => {
        return facesOf(page);
      }, 'in its static build')
      .toEqual([...FACES]);

    // * the launcher serves the same faces at the same address, bytes and all
    await using launched = await serveMqttDemo();

    await page.goto(launched.url);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
    await expect
      .poll(() => {
        return facesOf(page);
      }, 'as its launcher serves it')
      .toEqual([...FACES]);
  });

  test('follows the theme the page keeps, and keeps the one chosen', async ({ page }) => {
    // * the root's scheme once the document is parsed: a script that set it later, the page's own
    // module among them, would paint the page in the other one first
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') {
          (globalThis as { parsedScheme?: unknown }).parsedScheme =
            document.documentElement.getAttribute('data-color-scheme');
        }
      });
    });
    const root = page.locator('html');
    const toggle = page.locator('button[data-action="theme"]');

    // nothing kept: the system's
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(served?.url ?? '');
    expect(await parsedSchemeOf(page)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    expect(await parsedSchemeOf(page)).toBe('light');
    await expect(toggle).toHaveAccessibleName('Switch to dark mode');

    // dark, as the page keeps it, over the system's light
    await page.evaluate((key) => {
      localStorage.setItem(key, 'true');
    }, THEME_KEY);
    await page.reload();
    expect(await parsedSchemeOf(page)).toBe('dark');
    await expect(toggle).toHaveAccessibleName('Switch to light mode');

    // light chosen here, kept where the page reads it, and at the next visit
    await toggle.click();
    await expect(root).toHaveAttribute('data-color-scheme', 'light');
    await expect(toggle).toHaveAccessibleName('Switch to dark mode');
    expect(
      await page.evaluate((key) => {
        return localStorage.getItem(key);
      }, THEME_KEY)
    ).toBe('false');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    expect(await parsedSchemeOf(page)).toBe('light');
  });

  test('keeps its bar 56 px tall, on one line, every tool whole, at 320, 390, 600, 899, 900, 1199, 1200 and 1440 px', async ({
    page,
  }) => {
    await page.goto(served?.url ?? '');
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      expect(
        await rowFaultsOf(page, '.topbar', {
          height: 56,
          items: '.topbar > *, .topbar .tools > *',
        }),
        `at ${String(width)} px`
      ).toEqual([]);
    }

    // * the bar names Bead and its page, and holds nothing of the demo's state
    await expect(page.locator('.topbar .brand')).toHaveAttribute('href', 'https://beadproto.dev/');
    await expect(page.locator('.topbar .tools a')).toHaveText('Page');
    await expect(page.locator('.topbar #connection, .topbar .transports')).toHaveCount(0);
  });

  test('gives every control a finger reaches 44 px on a coarse pointer', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
      for (const scene of SCENES) {
        await page.goto(`${served?.url ?? ''}#${scene}`);
        // ! a fragment's change keeps the document, and the served attribute the scene before set
        await page.evaluate(() => {
          document.body.dataset['beadTransport'] = 'worker';
        });
        await expect(page.locator(`#${scene}-scene`)).toBeVisible();
        expect(await smallTargetsOf(page), `${scene}, static`).toEqual([]);

        // * what a served page shows too: its transports
        await page.evaluate(() => {
          document.body.dataset['beadTransport'] = 'ws';
        });
        expect(await smallTargetsOf(page), `${scene}, served`).toEqual([]);
      }

      // what the strip and the wire open
      await page.locator('#transport-toggle').click();
      expect(await smallTargetsOf(page), 'the transports').toEqual([]);
      await page.locator('#status-toggle').click();
      expect(await smallTargetsOf(page), 'the connection').toEqual([]);
      await page.locator('#wire-sheet').click();
      expect(await smallTargetsOf(page), 'the wire').toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('shows the keyboard’s focus on the bar’s tools and the strip’s controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(served?.url ?? '');
    await page.evaluate(() => {
      document.body.dataset['beadTransport'] = 'ws';
    });

    for (const control of [
      '.topbar .brand',
      '.topbar .tools a',
      '.topbar [data-action="theme"]',
      '#transport-toggle',
      '#status-toggle',
      '#wire-toggle',
    ]) {
      expect(await outlineByTabOf(page, control), control).not.toBe('none');
    }

    // * a link of the transports the chip opens
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('#transports')).toBeVisible();
    expect(await outlineByTabOf(page, '#transports a'), 'a transport').not.toBe('none');
  });

  test('sets every block of code at 13 px', async ({ page }) => {
    for (const scene of SCENES) {
      await page.goto(`${served?.url ?? ''}#${scene}`);
      await expect(page.locator(`#${scene}-scene`)).toBeVisible();
      expect(await codeSizesOf(page), scene).toEqual(['13px']);
    }
  });
});

test.describe('the demo’s page, over MQTT 5', () => {
  test('sends a glyph to the server and receives one, its link kept', async ({ page }) => {
    test.skip(!HAS_BROKER && !IS_MQTT_REQUIRED, NO_BROKER);
    expect(HAS_BROKER, NO_BROKER).toBe(true);
    test.setTimeout(3 * GLYPH_TIMEOUT);

    await using served = await serveMqttDemo();
    const failures: string[] = [];

    page.on('websocket', (socket) => {
      socket.on('socketerror', (error) => {
        failures.push(error);
      });
    });
    await page.goto(`${served.url}?transport=mqtt`);
    await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
    await page.click('button[data-action="writer"]');
    await expect(outcomeOf(page, 'writer')).toContainText('logged in as demo-writer');

    // * 8,386,816 bytes in parts each way, under the broker's Maximum Packet Size
    await page.click('button[data-action="upload"]');
    await expect(outcomeOf(page, 'upload')).toContainText(
      /^the server received the same glyph, 8,386,816 bytes/u,
      { timeout: GLYPH_TIMEOUT }
    );
    await page.click('button[data-action="download"]');
    await expect(outcomeOf(page, 'download')).toContainText(/^a glyph received, 8,386,816 bytes/u, {
      timeout: GLYPH_TIMEOUT,
    });
    await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
    expect(failures).toEqual([]);
  });
});
