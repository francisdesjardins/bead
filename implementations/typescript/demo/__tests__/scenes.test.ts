import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// the static host the DevTools extension's tests serve the same build with
import { PLAYGROUND, serveFolder } from '../../devtools/__tests__/fixtures';

// constants

const SCENES = Object.freeze(['calls', 'rules', 'openapi', 'server', 'code', 'packages'] as const);

// helpers

/** The scenes the page shows: one alone, as a tabpanel shows its tab's. */
const shownOf = async (page: Page): Promise<string[]> => {
  const shown: string[] = [];

  for (const scene of SCENES) {
    if (await page.locator(`#${scene}-scene`).isVisible()) {
      shown.push(scene);
    }
  }

  return shown;
};

// definition

test.describe('mountScenes', () => {
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

  test('shows what to try first, then the scene a tab chooses, its fragment in the address, Back the one before', async ({
    page,
  }) => {
    await page.goto(served?.url ?? '');
    expect(await shownOf(page)).toEqual(['calls']);
    expect(new URL(page.url()).hash).toBe('');

    await page.getByRole('tab', { name: 'Payload rules' }).click();
    expect(await shownOf(page)).toEqual(['rules']);
    expect(new URL(page.url()).hash).toBe('#rules');
    // a change of transport keeps it
    await expect(page.locator('.transports a[href$="?transport=worker#rules"]')).toHaveCount(1);

    await page.goBack();
    await expect(page.locator('#calls-scene')).toBeVisible();
    expect(await shownOf(page)).toEqual(['calls']);
    await expect(page.locator('#scene-tabs [aria-selected="true"]')).toHaveText('Try it');
  });

  test('opens the scene its fragment names, and what to try for a fragment of none', async ({
    page,
  }) => {
    await page.goto(`${served?.url ?? ''}#openapi`);
    expect(await shownOf(page)).toEqual(['openapi']);
    await expect(page.locator('#scene-tabs [aria-selected="true"]')).toHaveText('OpenAPI');
    await expect(page.locator('#sign-up-openapi-document')).toContainText('"openapi": "3.1.1"');

    // * corrected in its place: Back leaves the page rather than landing on the same scene
    await page.goto(`${served?.url ?? ''}#/`);
    expect(await shownOf(page)).toEqual(['calls']);
    expect(new URL(page.url()).hash).toBe('#calls');
    await page.goBack();
    await expect(page.locator('#openapi-scene')).toBeVisible();
  });

  test('keeps the wire folded until it is opened, and open at the next visit', async ({ page }) => {
    const toggle = page.locator('#wire-toggle');

    await page.goto(served?.url ?? '');
    await expect(page.locator('#wire-body')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(page.locator('#wire-body')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await page.reload();
    await expect(page.locator('#wire-body')).toBeVisible();

    await page.getByRole('button', { name: 'Fold the wire' }).click();
    await expect(page.locator('#wire-body')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await page.reload();
    await expect(page.locator('#wire-body')).toBeHidden();
  });

  test('shows the calls or the envelopes, and counts what crossed on what opens the wire', async ({
    page,
  }) => {
    await page.goto(served?.url ?? '');
    await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
    await page.click('button[data-action="reader"]');
    await expect(page.locator('#wire-toggle .count')).not.toHaveText('0');

    await page.locator('#wire-toggle').click();
    await expect(page.locator('#calls-log')).toBeVisible();
    await expect(page.locator('#calls-log li').first()).toContainText('whoami');
    await expect(page.locator('#envelopes-log')).toBeHidden();

    await page.getByRole('tab', { name: 'Envelopes' }).click();
    await expect(page.locator('#envelopes-log')).toBeVisible();
    await expect(page.locator('#calls-log')).toBeHidden();
    await expect(page.locator('#envelopes-log li')).toHaveCount(
      Number(await page.locator('#wire-toggle .count').textContent())
    );
  });

  test('scrolls no page sideways, on every scene, at 320 and 390 px, the wire a sheet at the bottom', async ({
    page,
  }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });

      for (const scene of SCENES) {
        await page.goto(`${served?.url ?? ''}#${scene}`);
        await expect(page.locator(`#${scene}-scene`)).toBeVisible();
        expect(
          await page.evaluate(() => {
            return document.documentElement.scrollWidth <= document.documentElement.clientWidth;
          }),
          `${scene} at ${String(width)} px`
        ).toBe(true);
      }
    }

    const sheet = page.locator('#wire-sheet');

    // * the strip's button opens the same sheet
    await expect(page.locator('#wire-toggle')).toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(page.locator('#wire-body')).toBeHidden();
    // * what crossed is counted once, on the strip's button
    await expect(page.locator('[data-wire-count]:visible')).toHaveCount(1);
    await expect(page.locator('#wire-toggle [data-wire-count]')).toBeVisible();
    await sheet.click();
    await expect(page.locator('#wire-body')).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#wire-toggle')).toHaveAttribute('aria-expanded', 'true');

    await expect(page.locator('[data-wire-count]:visible')).toHaveCount(1);

    // a link out of the sheet folds it, which would cover where it goes
    await page.getByRole('link', { name: 'Code › Go deeper' }).click();
    await expect(page.locator('#code-scene')).toBeVisible();
    await expect(page.locator('#wire-body')).toBeHidden();
  });

  test('keeps the scene tabs under the bar and the strip as the page scrolls, where the screen is 700 px tall or more', async ({
    page,
  }) => {
    const tabsTopOf = (): Promise<number> => {
      return page.locator('#scene-tabs').evaluate((tabs) => {
        return tabs.getBoundingClientRect().top;
      });
    };

    // a desktop: under the bar, 56 px, and the strip that stays with it
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${served?.url ?? ''}#rules`);
    const stripBottom = await page.locator('.strip').evaluate((strip) => {
      return strip.getBoundingClientRect().height + 56;
    });

    await page.evaluate(() => {
      scrollTo(0, 1500);
    });
    await expect.poll(tabsTopOf).toBe(stripBottom);

    // * the wire's drawer stays under them too
    await page.locator('#wire-toggle').click();
    await page.evaluate(() => {
      scrollTo(0, 1500);
    });
    await expect
      .poll(() => {
        return page.locator('#wire').evaluate((wire) => {
          return wire.getBoundingClientRect().top;
        });
      })
      .toBeGreaterThanOrEqual(stripBottom);

    // a phone: under the bar alone, the strip scrolled away
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      scrollTo(0, 1500);
    });
    await expect.poll(tabsTopOf).toBe(56);

    // a screen too short for them scrolls them away
    await page.setViewportSize({ width: 390, height: 600 });
    await page.evaluate(() => {
      scrollTo(0, 1500);
    });
    await expect.poll(tabsTopOf).toBeLessThan(0);
  });

  test('fades the scene tabs’ end while the list runs on past it', async ({ page }) => {
    const tabs = page.locator('#scene-tabs');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(served?.url ?? '');
    await expect(tabs).toHaveAttribute('data-runs-on', '');

    await tabs.evaluate((list) => {
      list.scrollLeft = list.scrollWidth;
    });
    await expect(tabs).not.toHaveAttribute('data-runs-on');

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(tabs).not.toHaveAttribute('data-runs-on');
  });
});
