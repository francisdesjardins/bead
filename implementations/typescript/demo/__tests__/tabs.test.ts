import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// the static host the DevTools extension's tests serve the same build with
import { PLAYGROUND, serveFolder } from '../../devtools/__tests__/fixtures';

// definition

test.describe('mountTabs', () => {
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

  test('selects by a click and by the arrow keys, Home and End, the focus with the tab', async ({
    page,
  }) => {
    const selected = page.locator('#scene-tabs [aria-selected="true"]');

    await page.goto(served?.url ?? '');
    await page.getByRole('tab', { name: 'Server' }).click();
    await expect(selected).toHaveText('Server');

    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Code' })).toBeFocused();
    await expect(selected).toHaveText('Code');

    // * from the last, the right arrow comes back to the first, and the left one goes round too
    await page.keyboard.press('ArrowRight');
    await expect(selected).toHaveText('Calls');
    await page.keyboard.press('ArrowLeft');
    await expect(selected).toHaveText('Code');
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'Calls' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(selected).toHaveText('Code');

    // one tab stop for the tabs: the one selected
    await expect(page.locator('#scene-tabs [tabindex="0"]')).toHaveCount(1);
  });
});
