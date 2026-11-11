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

  test('lays the page out on a phone with nothing wider than it, the wire a sheet at the bottom', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(served?.url ?? '');

    for (const scene of SCENES) {
      await page.goto(`${served?.url ?? ''}#${scene}`);
      expect(
        await page.evaluate(() => {
          return document.documentElement.scrollWidth <= document.documentElement.clientWidth;
        }),
        scene
      ).toBe(true);
    }

    const sheet = page.locator('#wire-sheet');

    await expect(page.locator('#wire-toggle')).toBeHidden();
    await expect(sheet).toBeVisible();
    await expect(page.locator('#wire-body')).toBeHidden();
    await sheet.click();
    await expect(page.locator('#wire-body')).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-expanded', 'true');

    // a link out of the sheet folds it, which would cover where it goes
    await page.getByRole('link', { name: 'Code › Go deeper' }).click();
    await expect(page.locator('#code-scene')).toBeVisible();
    await expect(page.locator('#wire-body')).toBeHidden();
  });
});
