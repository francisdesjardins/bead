import { expect, test } from '@playwright/test';
import { trafficCall } from '../../model/__tests__/book';
import type { envelopeListRowsOf } from '../calls';
import type { replaceKeeping } from '../dom';
import { loadView } from './page';

test('keeps an envelope row selected and focused when another envelope with the same timestamp joins its call', async ({
  page,
}) => {
  await loadView(page, 'calls');
  const result = await page.evaluate((call) => {
    const { view } = globalThis as unknown as {
      view: {
        envelopeListRowsOf: typeof envelopeListRowsOf;
        replaceKeeping: typeof replaceKeeping;
      };
    };
    const table = document.createElement('table');
    const body = document.createElement('tbody');
    table.append(body);
    document.getElementById('root')?.append(table);
    const entries = call.envelopes.map((envelope) => {
      return { call, envelope };
    });
    const draw = (): void => {
      const rows = view.envelopeListRowsOf({
        envelopes: entries,
        isAllClients: false,
        selected: call.key,
        nameOf: () => {
          return 'whoami';
        },
      });
      for (const row of rows) {
        row.tabIndex = 0;
      }
      view.replaceKeeping(body, rows);
    };
    draw();
    const row = body.rows[0] as HTMLTableRowElement;
    row.focus();
    const first = entries[0];
    if (first === undefined) {
      throw new Error('the fixture has no envelope');
    }
    entries.unshift({
      call,
      envelope: { ...first.envelope, header: { ...first.envelope.header, kind: 2 } },
    });
    draw();
    return {
      connected: row.isConnected,
      focused: document.activeElement === row,
      selected: row.getAttribute('aria-selected'),
      count: body.rows.length,
      keys: new Set(
        [...body.rows].map((item) => {
          return item.dataset['row'];
        })
      ).size,
    };
  }, trafficCall('whoami'));
  expect(result).toEqual({ connected: true, focused: true, selected: 'true', count: 3, keys: 3 });
});
