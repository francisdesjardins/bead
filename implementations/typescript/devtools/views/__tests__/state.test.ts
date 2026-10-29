import { expect, test } from '@playwright/test';
import { trafficBook } from '../../model/__tests__/book';
import type { keeperOf } from '../../model/filter';
import type { stateViewOf } from '../state';
import { loadView } from './page';

test('draws State from the filtered calls and keeps the scrubber usable', async ({ page }) => {
  await loadView(page, 'state');
  const calls = trafficBook().calls;
  await page.evaluate((traffic) => {
    const { view } = globalThis as unknown as {
      view: {
        keeperOf: typeof keeperOf;
        stateViewOf: typeof stateViewOf;
      };
    };
    const root = document.getElementById('root') as HTMLElement;
    root.replaceChildren(
      ...view.stateViewOf({
        calls: traffic,
        keeper: view.keeperOf('-counter'),
        at: undefined,
        now: Date.now(),
        callsLetGo: 0,
        nameOf: (call) => {
          return call.procedureName ?? '';
        },
        onScrub: () => {},
        span: { from: 0, to: Date.now() },
      })
    );
  }, calls);
  await expect(page.locator('#root')).not.toContainText('counter #');
  await expect(page.locator('.filter-count')).toHaveText('1 hidden by the filter');
  await expect(page.locator('#at')).toHaveCount(1);
  await page.locator('#at').focus();
  await page.locator('#at').press('Home');
  await expect(page.locator('#at')).toHaveValue('0');
});
