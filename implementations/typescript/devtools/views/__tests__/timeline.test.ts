import { expect, test } from '@playwright/test';
import { trafficBook } from '../../model/__tests__/book';
import type { replaceKeeping } from '../dom';
import type { timelineViewOf } from '../timeline';
import { loadView } from './page';

test('keeps the Timeline control focused with its current callback and releases a cancelled brush', async ({
  page,
}) => {
  await loadView(page, 'timeline');
  await page.evaluate((calls) => {
    const { view } = globalThis as unknown as {
      view: {
        timelineViewOf: typeof timelineViewOf;
        replaceKeeping: typeof replaceKeeping;
      };
    };
    const root = document.getElementById('root') as HTMLElement;
    const draw = (label: string): void => {
      view.replaceKeeping(
        root,
        view.timelineViewOf({
          calls,
          isAllClients: false,
          now: Date.now(),
          span: { from: 0, to: Date.now() },
          range: undefined,
          nameOf: (call) => {
            return call.procedureName ?? '';
          },
          onRange: () => {
            root.dataset['callback'] = label;
          },
        })
      );
    };
    draw('first');
    const button = root.querySelector('button') as HTMLButtonElement;
    button.focus();
    draw('current');
  }, trafficBook().calls);
  await expect(page.getByRole('button', { name: 'All', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#root')).toHaveAttribute('data-callback', 'current');
  const svg = page.locator('svg').first();
  const box = await svg.boundingBox();
  if (box === null) {
    throw new Error('the drawing has no box');
  }
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await expect(svg).toHaveAttribute('data-dragging', 'true');
  await svg.dispatchEvent('pointercancel');
  await expect(svg).not.toHaveAttribute('data-dragging');
  await expect(svg.locator('.brush')).toHaveAttribute('visibility', 'hidden');
  await page.mouse.up();
});
