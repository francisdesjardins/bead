import { expect, test } from '@playwright/test';
import type { keeperOf } from '../../model/filter';
import type { metricsViewOf } from '../metrics';
import { loadView } from './page';

test('filters metric rows and their exposition by procedure while keeping unlabelled samples', async ({
  page,
}) => {
  await loadView(page, 'metrics');
  for (const [spec, count] of [
    ['-metrics', 1],
    ['reader', 1],
    ['d(rx)', 2],
    ['e(result)', 2],
  ] as const) {
    await page.evaluate((filter) => {
      const { view } = globalThis as unknown as {
        view: { keeperOf: typeof keeperOf; metricsViewOf: typeof metricsViewOf };
      };
      document.getElementById('root')?.replaceChildren(
        ...view.metricsViewOf({
          sources: [1],
          history: new Map(),
          keeper: view.keeperOf(filter),
          onProcedure: () => {},
          expositions: new Map([
            [
              1,
              [
                'bead_client_call_started_total{service="1",procedure="metrics",type="request"} 2',
                'bead_client_call_started_total{service="1",procedure="reader",type="request"} 1',
                'bead_connections 3',
              ].join('\n'),
            ],
          ]),
        })
      );
    }, spec);
    await expect(page.locator('tbody tr')).toHaveCount(count);
    await expect(page.locator('.filter-count')).toHaveText(
      `${String(2 - count)} hidden by the filter`
    );
    await expect(page.locator('pre')).toContainText('bead_connections 3');
  }
});
