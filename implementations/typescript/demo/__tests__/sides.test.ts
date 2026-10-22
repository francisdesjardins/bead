import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// the static host the DevTools extension's tests serve the same build with
import { PLAYGROUND, serveFolder } from '../../devtools/__tests__/fixtures';
import { SAMPLES } from '../samples';

// helpers

/** What the panel shows: its tab selected, and each side's file. */
const shownOf = async (page: Page) => {
  return {
    csharp: await page.locator('#side-csharp-file').textContent(),
    selected: (await page.locator('#sides-tabs [aria-selected="true"]').textContent())?.trim(),
    typescript: await page.locator('#side-typescript-file').textContent(),
  };
};

// definition

test.describe('mountSides', () => {
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

  test('shows a role on both sides, its resolvers first, as examples/hello holds them', async ({
    page,
  }) => {
    await page.goto(served?.url ?? '');

    expect(await shownOf(page)).toEqual({
      csharp: SAMPLES.resolvers.csharp.file,
      selected: 'Its resolvers',
      typescript: SAMPLES.resolvers.typescript.file,
    });
    await expect(page.locator('#side-typescript')).toHaveText(SAMPLES.resolvers.typescript.text);
    await expect(page.locator('#side-csharp')).toHaveText(SAMPLES.resolvers.csharp.text);
    await expect(page.locator('#sides-panel')).toHaveAttribute(
      'aria-labelledby',
      'sides-resolvers'
    );
  });

  test('changes role by a click and by the arrow keys, Home and End, the focus with the tab', async ({
    page,
  }) => {
    await page.goto(served?.url ?? '');

    await page.getByRole('tab', { name: 'Its client' }).click();
    expect(await shownOf(page)).toEqual({
      csharp: SAMPLES.calling.csharp.file,
      selected: 'Its client',
      typescript: SAMPLES.calling.typescript.file,
    });

    // * from the last, the right arrow comes back to the first
    await page.getByRole('tab', { name: 'Its client' }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Its resolvers' })).toBeFocused();
    expect((await shownOf(page)).selected).toBe('Its resolvers');

    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Its client' })).toBeFocused();
    await page.keyboard.press('Home');
    expect((await shownOf(page)).selected).toBe('Its resolvers');
    await page.keyboard.press('End');
    expect((await shownOf(page)).selected).toBe('Its client');

    // one tab stop for the tabs: the one selected
    await expect(page.locator('#sides-tabs [tabindex="0"]')).toHaveCount(1);
  });
});
