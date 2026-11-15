import { expect, type Page, test } from '@playwright/test';
import { trafficBook } from '../../model/__tests__/book';
import type { ICall } from '../../model/calls';
import { type ISpan, tickStepOf } from '../../model/scale';
import { spanOfCalls } from '../../model/state';
import type { callRowsOf } from '../calls';
import type { replaceKeeping, STATUS_NAMES } from '../dom';
import type { timelineViewOf } from '../timeline';
import { loadView } from './page';

interface IView {
  callRowsOf: typeof callRowsOf;
  replaceKeeping: typeof replaceKeeping;
  STATUS_NAMES: typeof STATUS_NAMES;
  timelineViewOf: typeof timelineViewOf;
}

/** What the drawn Timeline told its panel: each call of its callbacks, in order. */
type Heard = ['open', number] | ['range', ISpan | undefined] | ['select', number];

/** The traffic's Timeline on the panel's page, redrawn as a panel would at each callback. */
const drawTraffic = async (page: Page): Promise<ISpan> => {
  const { calls } = trafficBook();
  const span = spanOfCalls(calls);

  if (span === undefined) {
    throw new Error('the traffic has no span');
  }

  await loadView(page, ['calls', 'timeline'], { scheme: 'light' });
  await page.evaluate(
    ({ traffic, whole }) => {
      const { view } = globalThis as unknown as { view: IView };
      const timeline = document.getElementById('timeline') as HTMLElement;
      const heard: Heard[] = [];
      const state = {
        range: undefined as ISpan | undefined,
        selected: undefined as number | undefined,
      };
      const draw = (): void => {
        view.replaceKeeping(
          timeline,
          view.timelineViewOf({
            calls: traffic,
            isAllClients: false,
            nameOf: (call) => {
              return call.procedureName ?? '';
            },
            now: whole.to,
            onOpen: (key) => {
              heard.push(['open', key]);
            },
            onRange: (range) => {
              heard.push(['range', range]);
              state.range = range;
              draw();
            },
            onSelect: (key) => {
              heard.push(['select', key]);
              state.selected = key;
              draw();
            },
            range: state.range,
            selected: state.selected,
            span: whole,
          })
        );
      };

      (document.getElementById('calls-view') as HTMLElement).hidden = true;
      timeline.hidden = false;
      draw();
      Object.assign(globalThis, { heard });
    },
    { traffic: calls, whole: span }
  );

  return span;
};

const heardOf = async (page: Page): Promise<Heard[]> => {
  return page.evaluate(() => {
    return (globalThis as unknown as { heard: Heard[] }).heard;
  });
};

test('keeps the Timeline control focused with its current callback and releases a cancelled brush', async ({
  page,
}) => {
  await loadView(page, 'timeline', { scheme: 'light' });
  await page.evaluate((calls) => {
    const { view } = globalThis as unknown as { view: IView };
    const root = document.getElementById('timeline') as HTMLElement;
    const draw = (label: string): void => {
      view.replaceKeeping(
        root,
        view.timelineViewOf({
          calls,
          isAllClients: false,
          now: Date.now(),
          span: { from: 0, to: Date.now() },
          range: undefined,
          selected: undefined,
          nameOf: (call) => {
            return call.procedureName ?? '';
          },
          onOpen: () => {},
          onRange: () => {
            root.dataset['callback'] = label;
          },
          onSelect: () => {},
        })
      );
    };
    (document.getElementById('calls-view') as HTMLElement).hidden = true;
    root.hidden = false;
    draw('first');
    const button = root.querySelector('button') as HTMLButtonElement;
    button.focus();
    draw('current');
  }, trafficBook().calls);
  await expect(page.getByRole('button', { name: 'Show every call', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#timeline')).toHaveAttribute('data-callback', 'current');
  const rows = page.locator('#timeline .tl-rows');
  const box = await page.locator('#timeline thead .track').boundingBox();
  if (box === null) {
    throw new Error('the track has no box');
  }
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 40, { steps: 3 });
  await expect(rows).toHaveAttribute('data-dragging', 'true');
  await rows.dispatchEvent('pointercancel');
  await expect(rows).not.toHaveAttribute('data-dragging');
  await expect(rows.locator('.brush')).toBeHidden();
  await page.mouse.up();

  // a press let go below the rows, before it dragged, leaves no brush to follow the pointer back
  const last = await page.locator('#timeline tbody tr').last().boundingBox();
  if (last === null) {
    throw new Error('the rows have no box');
  }
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, last.y + last.height + 60, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(box.x + 90, box.y + 40, { steps: 4 });
  await expect(rows).not.toHaveAttribute('data-dragging');
  await expect(rows.locator('.brush')).toBeHidden();
});

test('draws the newest 300 calls, newest first, and says how many it leaves out', async ({
  page,
}) => {
  const { calls } = trafficBook();
  await loadView(page, 'timeline', { scheme: 'light' });
  const drawn = await page.evaluate(
    ({ traffic, whole }) => {
      const { view } = globalThis as unknown as { view: IView };
      const timeline = document.getElementById('timeline') as HTMLElement;
      const many = Array.from({ length: 301 }, (_, key) => {
        return { ...(traffic[key % traffic.length] as ICall), key };
      });

      timeline.hidden = false;
      view.replaceKeeping(
        timeline,
        view.timelineViewOf({
          calls: many,
          isAllClients: false,
          nameOf: (call) => {
            return call.procedureName ?? '';
          },
          now: whole.to,
          onOpen: () => {},
          onRange: () => {},
          onSelect: () => {},
          range: undefined,
          selected: undefined,
          span: whole,
        })
      );
      const rows = timeline.querySelectorAll<HTMLElement>('tbody tr[data-key]');

      return {
        count: rows.length,
        first: rows[0]?.dataset['key'],
        last: rows[rows.length - 1]?.dataset['key'],
        note: [...timeline.querySelectorAll('p.note')].at(-1)?.textContent,
      };
    },
    { traffic: calls, whole: spanOfCalls(calls) as ISpan }
  );

  expect(drawn).toEqual({
    count: 300,
    first: '300',
    last: '1',
    note: 'The last 300 calls shown, of 301.',
  });
});

test('draws a call a row, as the Calls list draws its rows, in its order', async ({ page }) => {
  const { calls } = trafficBook();
  await page.setViewportSize({ width: 1_600, height: 900 });
  await loadView(page, ['calls', 'dom', 'timeline'], { scheme: 'light' });
  const drawn = await page.evaluate(
    ({ traffic, whole }) => {
      const { view } = globalThis as unknown as { view: IView };
      const timeline = document.getElementById('timeline') as HTMLElement;
      const list = document.getElementById('calls') as HTMLElement;
      const nameOf = (call: ICall): string => {
        return call.procedureName ?? '';
      };

      timeline.hidden = false;
      view.replaceKeeping(
        timeline,
        view.timelineViewOf({
          calls: traffic,
          isAllClients: false,
          nameOf,
          now: whole.to,
          onOpen: () => {},
          onRange: () => {},
          onSelect: () => {},
          range: undefined,
          selected: undefined,
          span: whole,
        })
      );
      view.replaceKeeping(
        list,
        view.callRowsOf({
          calls: traffic,
          expanded: new Set(),
          isAllClients: false,
          markers: [],
          nameOf,
          now: whole.to,
          selected: undefined,
          span: whole,
        })
      );

      const rowsOf = (root: HTMLElement): HTMLTableRowElement[] => {
        return [...root.querySelectorAll<HTMLTableRowElement>('tr[data-key]')];
      };
      const looks = (row: HTMLTableRowElement): string => {
        const cell = row.cells[1] as HTMLTableCellElement;
        const style = getComputedStyle(cell);

        return `${style.fontFamily} ${style.fontSize} ${String(Math.round(row.getBoundingClientRect().height))}`;
      };
      const callRows = new Map(
        rowsOf(list).map((row) => {
          return [row.dataset['key'], row] as const;
        })
      );
      const legend = timeline.querySelector('.legend')?.textContent ?? '';
      const keysOf = (root: HTMLElement): string[] => {
        return rowsOf(root).map((row) => {
          return row.dataset['key'] ?? '';
        });
      };

      // * row for row: the same calls, newest first, in both
      if (keysOf(timeline).join() !== keysOf(list).join()) {
        return [{ order: `${keysOf(timeline).join()} against ${keysOf(list).join()}` }];
      }

      return rowsOf(timeline).map((row) => {
        const twin = callRows.get(row.dataset['key']) as HTMLTableRowElement;
        const name = row.querySelector('svg.status')?.getAttribute('aria-label') ?? '';

        return {
          key: Number(row.dataset['key']),
          name:
            row.cells[2]?.textContent ===
            nameOf(
              traffic.find(({ key }) => {
                return String(key) === row.dataset['key'];
              }) as ICall
            ),
          same:
            row.cells[1]?.textContent === twin.cells[1]?.textContent &&
            row.querySelector('td.num')?.textContent ===
              twin.querySelector('td.num')?.textContent &&
            name === twin.querySelector('svg.status')?.getAttribute('aria-label'),
          status: Object.values(view.STATUS_NAMES).includes(name) && legend.includes(name),
          looks: looks(row) === looks(twin),
        };
      });
    },
    { traffic: calls, whole: spanOfCalls(calls) as ISpan }
  );

  expect(drawn).toEqual(
    calls
      .toSorted((one, other) => {
        return other.key - one.key;
      })
      .map(({ key }) => {
        return { key, name: true, same: true, status: true, looks: true };
      })
  );
});

test('narrows its axis to the span dragged across, and gives the whole back', async ({ page }) => {
  await page.setViewportSize({ width: 1_200, height: 800 });
  const whole = await drawTraffic(page);
  const labels = page.locator('#timeline thead .axis span');
  const before = await labels.allTextContents();
  // the grid: a hairline a tick, a step of the axis apart
  await expect(page.locator('#timeline-rows')).toHaveAttribute(
    'style',
    `--grid:${String((tickStepOf(whole) / (whole.to - whole.from)) * 100)}%`
  );
  const box = await page.locator('#timeline thead .track .axis').boundingBox();
  if (box === null) {
    throw new Error('the axis has no box');
  }
  const y = box.y + box.height + 40;

  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 5 });
  await page.mouse.up();

  const [, range] = (await heardOf(page)).at(-1) ?? [];
  const width = whole.to - whole.from;
  if (typeof range !== 'object') {
    throw new Error('the drag gave no span');
  }
  expect(range.from).toBeCloseTo(whole.from + width * 0.25, -1);
  expect(range.to).toBeCloseTo(whole.from + width * 0.5, -1);
  await expect(page.getByRole('button', { name: 'Show every call' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  // * the axis is the span dragged across: its ticks a quarter's, from its own start
  const narrowed = await labels.allTextContents();
  expect(narrowed).not.toEqual(before);
  expect(narrowed[0]).toBe('0 ms');

  // a drag inside the narrowed axis narrows it again
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, y, { steps: 5 });
  await page.mouse.up();
  const [, again] = (await heardOf(page)).at(-1) ?? [];
  if (typeof again !== 'object') {
    throw new Error('the second drag gave no span');
  }
  expect(again.from).toBeCloseTo(range.from + (range.to - range.from) * 0.5, -1);
  expect(again.to).toBeCloseTo(range.to, -1);

  await page.getByRole('button', { name: 'Show every call' }).click();
  expect((await heardOf(page)).at(-1)).toEqual(['range', undefined]);
  await expect(labels).toHaveText(before);
});

test('selects a call from its Timeline row, by a click and by the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1_200, height: 800 });
  await drawTraffic(page);
  const rows = page.locator('#timeline tbody tr[data-key]');
  const keys = await rows.evaluateAll((all) => {
    return all.map((row) => {
      return Number((row as HTMLElement).dataset['key']);
    });
  });
  const [first, second] = keys;

  // a click on the track opens the call, as one on its words does
  await rows.nth(1).locator('td.track').click();
  expect(await heardOf(page)).toEqual([['open', second]]);

  await page.getByRole('button', { name: 'Show every call' }).focus();
  await page.keyboard.press('Tab');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  // ! the row the keyboard is on shows it: the panel's focus ring, on the row
  await expect(rows.nth(1)).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('ArrowUp');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await heardOf(page)).toEqual([
    ['open', second],
    ['select', second],
    ['select', first],
    ['open', first],
  ]);
});
