import { expect, test } from '@playwright/test';
import type * as dom from '../dom';
import { loadView } from './page';

test('reconciles keyed rows and live callbacks without detaching focus or changing scroll and disclosures', async ({
  page,
}) => {
  await loadView(page, 'dom');
  const result = await page.evaluate(() => {
    const { view } = globalThis as unknown as { view: typeof dom };
    const root = document.getElementById('root') as HTMLElement;
    let clicked = 0;
    const draw = (count: number): void => {
      const pane = view.make('div', {
        attributes: { id: 'pane', style: 'height:80px;width:200px;overflow:auto' },
      });
      const button = view.make('button', { attributes: { 'data-row': 'button' }, text: 'Read' });
      view.listen(button, {
        type: 'click',
        handle: () => {
          clicked = count;
          view.currentOf(button).textContent = String(count);
        },
      });
      pane.append(button, view.make('div', { attributes: { style: 'height:500px;width:1000px' } }));
      const details = view.make('details', {
        attributes: { open: '' },
        children: [view.make('summary', { text: 'Levels' })],
      });
      view.replaceKeeping(root, [pane, details]);
    };
    draw(1);
    const button = root.querySelector('button') as HTMLButtonElement;
    const pane = root.querySelector('#pane') as HTMLElement;
    const details = root.querySelector('details') as HTMLDetailsElement;
    details.open = false;
    button.focus();
    pane.scrollTop = 50;
    pane.scrollLeft = 90;
    draw(2);
    button.click();
    return {
      same: button === root.querySelector('button'),
      focused: document.activeElement === button,
      top: pane.scrollTop,
      left: pane.scrollLeft,
      open: details.open,
      clicked,
      text: button.textContent,
    };
  });
  expect(result).toEqual({
    same: true,
    focused: true,
    top: 50,
    left: 90,
    open: false,
    clicked: 2,
    text: '2',
  });
});
