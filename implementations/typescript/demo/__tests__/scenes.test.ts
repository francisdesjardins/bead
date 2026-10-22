import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// the static host the DevTools extension's tests serve the same build with
import { PLAYGROUND, serveFolder } from '../../devtools/__tests__/fixtures';

// constants

const SCENES = Object.freeze(['calls', 'rules', 'openapi', 'server', 'code'] as const);

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

  test('shows the calls first, then the scene a tab chooses, its fragment in the address, Back the one before', async ({
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
    await expect(page.locator('#scene-tabs [aria-selected="true"]')).toHaveText('Calls');
  });

  test('opens the scene its fragment names, and the calls for a fragment of none', async ({
    page,
  }) => {
    await page.goto(`${served?.url ?? ''}#openapi`);
    expect(await shownOf(page)).toEqual(['openapi']);
    await expect(page.locator('#scene-tabs [aria-selected="true"]')).toHaveText('OpenAPI');
    await expect(page.locator('#sign-up-openapi-document')).toContainText('"openapi": "3.1.1"');

    await page.goto(`${served?.url ?? ''}#nowhere`);
    expect(await shownOf(page)).toEqual(['calls']);
  });

  test('folds the logs away, and keeps them folded at the next visit', async ({ page }) => {
    const toggle = page.locator('#logs-toggle');

    await page.goto(served?.url ?? '');
    await expect(page.locator('#logs-body')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await toggle.click();
    await expect(page.locator('#logs-body')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveText('Show the logs');

    await page.reload();
    await expect(page.locator('#logs-body')).toBeHidden();

    await toggle.click();
    await expect(page.locator('#logs-body')).toBeVisible();
    await expect(toggle).toHaveText('Hide the logs');
  });
});
