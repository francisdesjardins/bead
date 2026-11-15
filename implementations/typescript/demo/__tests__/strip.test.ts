// ── Demo strip ────────────────────────────────────────────────────────────────

// The demo's status strip under the top bar, in Chromium, in its static build: one row at every
// width, the transports from its chip on a phone, the connection and the identity from its light.
// A served page's transports are shown by setting `data-bead-transport` as its server does.

// dependencies

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PLAYGROUND, rowFaultsOf, serveFolder } from '../../devtools/__tests__/fixtures';

// constants

/** The widths the strip is held at: a small phone to a wide desktop, each side of every breakpoint. */
const WIDTHS = Object.freeze([320, 390, 600, 899, 900, 1199, 1200, 1440]);

/** The longest words the connection's light says, of each of its states. */
const STATES = Object.freeze(['connecting…', 'cannot connect', 'closed: reload']);

// helpers

/** The longest words each control of the strip holds: the connection's `said`, a role, a count. */
const sayLongest = (page: Page, said: string): Promise<void> => {
  return page.evaluate((connection) => {
    const words = {
      connection,
      identity: 'logged out',
      'transport-name': 'Web Worker',
    };

    for (const [id, text] of Object.entries(words)) {
      const element = document.getElementById(id);

      if (element !== null) {
        element.textContent = text;
      }
    }

    for (const count of document.querySelectorAll('[data-wire-count]')) {
      count.textContent = '9,999';
    }
  }, said);
};

// definition

test.describe('mountStrip', () => {
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

  test('keeps the strip on one row, every control whole, at 320, 390, 600, 899, 900, 1199, 1200 and 1440 px, served or static, with the longest words', async ({
    page,
  }) => {
    await page.goto(served?.url ?? '');
    await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    for (const transport of ['worker', 'ws']) {
      await page.evaluate((shown) => {
        document.body.dataset['beadTransport'] = shown;
      }, transport);

      for (const said of STATES) {
        await sayLongest(page, said);

        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 800 });
          expect(
            await rowFaultsOf(page, '.strip-row', {
              items: '.strip-row > *, .strip-row .transports > a, .strip-row button > span',
            }),
            `${transport}, "${said}", at ${String(width)} px`
          ).toEqual([]);
          expect(
            await page.evaluate(() => {
              return document.documentElement.scrollWidth <= document.documentElement.clientWidth;
            }),
            `${transport}, "${said}", the page at ${String(width)} px`
          ).toBe(true);
        }
      }
    }
  });

  test('stays under the bar as the page scrolls on a desktop, and scrolls away on a phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${served?.url ?? ''}#rules`);
    await page.mouse.wheel(0, 1200);
    await expect
      .poll(() => {
        return page.locator('.strip').evaluate((strip) => {
          return strip.getBoundingClientRect().top;
        });
      })
      .toBe(56);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      scrollTo(0, 1200);
    });
    await expect
      .poll(() => {
        return page.locator('.strip').evaluate((strip) => {
          return strip.getBoundingClientRect().bottom;
        });
      })
      .toBeLessThan(56);
  });

  test('opens the other transports from its chip on a phone, closes them by Escape and gives the focus back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(served?.url ?? '');
    // * a page of one transport has no choice to offer: a chip that names it, and no menu
    await expect(page.locator('#transport-toggle')).toBeHidden();
    await expect(page.locator('.strip .transport-chip[data-static]')).toHaveText('Web Worker');

    await page.evaluate(() => {
      document.body.dataset['beadTransport'] = 'ws';
    });
    const toggle = page.locator('#transport-toggle');
    const transports = page.locator('#transports');

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(transports).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(transports).toBeVisible();
    // each with its explanation written under it, which a phone shows no title for
    await expect(transports.getByRole('link', { name: /^HTTP/u })).toContainText('a long poll');

    await page.keyboard.press('Escape');
    await expect(transports).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();

    // a click outside closes it too
    await toggle.click();
    await page.locator('.topbar .context').click();
    await expect(transports).toBeHidden();

    // * on a desktop, the transports are the strip's segmented control, their explanations unseen
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(transports).toBeVisible();
    await expect(toggle).toBeHidden();
    await expect(transports.locator('.why').first()).toBeHidden();
  });

  test('opens the connection’s sentence and the identity from its light, one disclosure at a time', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(served?.url ?? '');
    await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');

    const toggle = page.locator('#status-toggle');
    const detail = page.locator('#status-detail');

    await expect(detail).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // the page's own worker, or the one the browser's tabs share where it has one
    await expect(page.locator('#connection-said')).toHaveText(
      /^connected, in (this page’s Web Worker|a Web Worker the tabs share)$/u
    );
    await expect(page.locator('#identity-said')).toHaveText('logged out');

    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await expect(toggle).toBeFocused();

    // the identity, as the server read it, once logged in
    await page.click('button[data-action="writer"]');
    await toggle.click();
    await expect(page.locator('#identity-said')).toContainText('demo-writer, writer');

    // * opening the transports closes the connection's
    await page.evaluate(() => {
      document.body.dataset['beadTransport'] = 'ws';
    });
    await page.locator('#transport-toggle').click();
    await expect(detail).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
