import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { brokerViewOf } from '../broker';

let script = '';
let styles = '';

test.beforeAll(async () => {
  const [bundle, panel, system, skin] = await Promise.all([
    build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL('../broker.ts', import.meta.url))],
      format: 'iife',
      globalName: 'brokerView',
      platform: 'browser',
      write: false,
    }),
    readFile(new URL('../../panel.html', import.meta.url), 'utf8'),
    readFile(new URL('../../penumbra/tokens.system.css', import.meta.url), 'utf8'),
    readFile(new URL('../../penumbra/tokens.skin.base.css', import.meta.url), 'utf8'),
  ]);
  script = bundle.outputFiles[0]?.text ?? '';
  styles = `${system}\n${skin}\n${panel.split('<style>')[1]?.split('</style>')[0] ?? ''}`;
});

test('draws pulled participant levels, parcel columns, link separators and reports, with selected detail and column filters', async ({
  page,
}) => {
  await page.setContent('<main id="broker"></main>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const { brokerView } = globalThis as unknown as {
      brokerView: { brokerViewOf: typeof brokerViewOf };
    };
    const root = document.getElementById('broker') as HTMLElement;
    const records = [
      {
        kind: 'participant' as const,
        source: 1,
        at: 100,
        event: 'link' as const,
        state: 'down' as const,
        ended: [1],
      },
      {
        kind: 'participant' as const,
        source: 1,
        at: 101,
        event: 'parcel' as const,
        direction: 'rx' as const,
        parcelKind: 'DATA',
        sequence: 10,
        connection: 2,
        topic: ['bead', 'i', 'ada'],
        bytes: 38,
        carriedBytes: 10,
        more: true,
        verdict: 'taken' as const,
      },
      {
        kind: 'participant' as const,
        source: 1,
        at: 102,
        event: 'parcel' as const,
        direction: 'rx' as const,
        parcelKind: 'DATA',
        sequence: 11,
        connection: 2,
        bytes: 38,
        carriedBytes: 10,
        more: false,
        verdict: 'taken' as const,
      },
      {
        kind: 'participant' as const,
        source: 1,
        at: 103,
        event: 'parcel' as const,
        direction: 'rx' as const,
        parcelKind: 'DATA',
        sequence: 12,
        connection: 2,
        bytes: 38,
        carriedBytes: 10,
        more: false,
        verdict: 'taken' as const,
      },
      {
        kind: 'participant' as const,
        source: 1,
        at: 104,
        event: 'parcel' as const,
        direction: 'tx' as const,
        parcelKind: 'PING',
        sequence: 3,
        connection: 2,
        bytes: 28,
      },
      {
        kind: 'participant' as const,
        source: 1,
        at: 105,
        event: 'report' as const,
        report: 'the connection reached maximumUnsentBytes, 64 bytes',
        connection: 2,
      },
    ];
    const inspection = {
      id: 'ada',
      inbox: ['bead', 'i', 'ada'],
      incarnation: '0102',
      isLinked: true,
      names: ['echo'],
      gauges: {
        counts: { connections: 1, partsBytes: 10 },
        ceilings: { partsBytes: 64 },
        anomalies: [],
      },
    };
    const options: Parameters<typeof brokerViewOf>[0] = {
      records,
      sources: [{ id: 1, protocol: 1, side: 'participant', inspection }],
      inspections: new Map(),
      letGo: 0,
      filters: { kind: '', connection: '', verdict: '' },
      selected: undefined,
      onFilter: (filters) => {
        options.filters = filters;
        draw();
      },
      onSelect: (record) => {
        options.selected = record;
        draw();
      },
      onState: () => {
        root.dataset['state'] = 'selected';
      },
    };
    const draw = (): void => {
      root.replaceChildren(...brokerView.brokerViewOf(options));
    };
    Object.assign(globalThis, {
      renderGap: () => {
        options.letGo = 1;
        draw();
      },
    });
    draw();
  });
  await expect(page.locator('#broker')).toContainText('Participant 1 · ada · up');
  await expect(page.locator('meter')).toHaveAttribute('max', '64');
  await expect(page.locator('th')).toHaveText([
    'Time',
    'Participant',
    'Direction',
    'Kind',
    'Connection',
    'Sequence',
    'Topic',
    'Bytes',
    'Carried / parts',
    'Verdict',
  ]);
  await expect(page.locator('.participant-transition td')).toHaveAttribute('colspan', '10');
  await expect(page.locator('.participant-report')).toContainText('maximumUnsentBytes, 64 bytes');
  await expect(page.locator('pre')).toHaveCount(0);
  await expect(page.locator('tbody tr[title]')).toHaveCount(0);
  const data = page.locator('tr[data-event="parcel"]').filter({ hasText: 'DATA' });
  await expect(data.nth(0)).toContainText('part 1');
  await expect(data.nth(1)).toContainText('incomplete capture');
  await expect(data.nth(2)).not.toContainText('incomplete capture');
  await data.first().click();
  await expect(page.locator('.participant-detail pre')).toContainText('"sequence": 10');
  await page.getByLabel('Parcel kind', { exact: true }).selectOption('DATA');
  await expect(page.locator('tr[data-event="parcel"]')).toHaveCount(3);
  await expect(page.locator('.participant-transition')).toHaveCount(1);
  await page.getByRole('button', { name: 'Envelope credit → State' }).click();
  await expect(page.locator('#broker')).toHaveAttribute('data-state', 'selected');
  await page.evaluate(() => {
    (globalThis as unknown as { renderGap(): void }).renderGap();
  });
  for (const row of await data.all()) {
    await expect(row).toContainText('incomplete capture');
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate((color) => {
      document.documentElement.dataset['colorScheme'] = color;
    }, theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: test.info().outputPath(`broker-${theme}-wide.png`) });
    await page.setViewportSize({ width: 480, height: 800 });
    await page.screenshot({ path: test.info().outputPath(`broker-${theme}-narrow.png`) });
    const table = await page.locator('.participant-table').boundingBox();
    const detail = await page.locator('.participant-detail').boundingBox();
    expect(detail?.y).toBeGreaterThanOrEqual((table?.y ?? 0) + (table?.height ?? 0));
    expect(
      await page.evaluate(() => {
        return document.documentElement.scrollWidth <= innerWidth;
      })
    ).toBe(true);
  }
});
