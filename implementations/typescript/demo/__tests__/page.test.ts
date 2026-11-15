// ── Demo page ─────────────────────────────────────────────────────────────────

// The demo's page in Chromium: its faces and its theme, in its static build and as its launcher
// serves it; and over MQTT 5, served by its launcher beside the Mosquitto `BEAD_MQTT_URL` names
// (`node tools/mqtt-broker.mjs run -- yarn test:demo`), as `?transport=mqtt` links it: where none
// is given, skipped, saying so, or failed where `BEAD_MQTT_REQUIRED=1`.

// dependencies

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  outcomeOf,
  PLAYGROUND,
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
