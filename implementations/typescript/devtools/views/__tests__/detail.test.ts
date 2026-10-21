import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { REFUSED_INVALID, TRAFFIC } from '../../__tests__/traffic';
import { createCallBook } from '../../model/calls';
import type { detailOf } from '../detail';

// interfaces

/** The view module's browser bundle, without the panel or the DevTools API. */
interface IDetailView {
  detailOf: typeof detailOf;
}

// helpers

let script = '';
let styles = '';

const book = createCallBook();

for (const record of [...TRAFFIC, ...REFUSED_INVALID]) {
  book.take(record);
}

/** Draws a call's Overview directly, by its procedure's name, in a detail `width` pixels wide. */
const drawOverview = async (
  page: Page,
  { name, width = 960 }: { name: string; width?: number }
): Promise<void> => {
  const call = book.calls.find((held) => {
    return held.procedureName === name;
  });

  if (call === undefined) {
    throw new Error(`the traffic has no call of ${name}`);
  }

  await page.setViewportSize({ height: 720, width });
  await page.evaluate((held) => {
    const { detailView } = globalThis as unknown as { detailView: IDetailView };
    const root = document.getElementById('detail') as HTMLElement;

    root.replaceChildren(
      ...detailView.detailOf(held, {
        context: {
          client: 'Client 1',
          copy: () => {},
          earlier: undefined,
          nameOf: (shown) => {
            return shown.procedureName ?? '';
          },
          now: held.opening?.startedAt ?? 0,
        },
        tab: 'overview',
      })
    );
  }, call);
};

/** The violations table's rows, each its cells' text. */
const rowsOf = (page: Page): Promise<string[][]> => {
  return page.locator('#detail table.violations tbody tr').evaluateAll((rows) => {
    return rows.map((row) => {
      return Array.from(row.querySelectorAll('td'), (cell) => {
        return cell.textContent;
      });
    });
  });
};

test.beforeAll(async () => {
  const [bundle, panel, system, skin] = await Promise.all([
    build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL('../detail.ts', import.meta.url))],
      format: 'iife',
      globalName: 'detailView',
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

test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="detail"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
});

// definition

test.describe('detailOf', () => {
  test('tables a PAYLOAD_INVALID refused before it went, a violation a row with its header cells and its caption, and no line under a count of 0', async ({
    page,
  }) => {
    await drawOverview(page, { name: 'submit whole' });

    const table = page.locator('#detail .outcome-box.failed table.violations');

    await expect(page.locator('#detail .outcome-box')).toContainText('Failed: PAYLOAD_INVALID.');
    await expect(page.locator('#detail .outcome-box')).toContainText(
      'A protocol code, raised here, by this page’s router.'
    );
    await expect(table.locator('caption')).toHaveText('1 violation, in their order');
    await expect(table.locator('thead th[scope="col"]')).toHaveText([
      'Field',
      'Rule',
      'Words',
      'Bounds',
    ]);
    expect(await rowsOf(page)).toEqual([
      ['from', 'int32.lte', 'must be less than or equal to 10', '{"lte":10}'],
    ]);
    await expect(page.locator('#detail .outcome-box .note')).toHaveCount(0);
    await expect(page.locator('#detail .outcome-box')).not.toContainText('"ruleId"');
  });

  test('says under the table what the closing line counts, that its side stopped, or that the detail was cut', async ({
    page,
  }) => {
    await drawOverview(page, { name: 'submit counted' });
    expect(await rowsOf(page)).toEqual([
      ['from', 'int32.lte', 'must be less than or equal to 10', '{"lte":10}'],
      ['names[0]', 'string.min_len', 'must be at least 1 characters', '{"min_len":"1"}'],
    ]);
    await expect(page.locator('#detail table.violations caption')).toHaveText(
      '2 violations, in their order'
    );
    await expect(page.locator('#detail .outcome-box .note')).toHaveText('and 3 more');

    await drawOverview(page, { name: 'submit stopped' });
    await expect(page.locator('#detail .outcome-box .note')).toHaveText(
      'stopped at the first (failFast)'
    );

    await drawOverview(page, { name: 'submit cut' });
    expect(await rowsOf(page)).toEqual([
      ['from', 'int32.lte', 'must be less than or equal to 10', '{"lte":10}'],
    ]);
    await expect(page.locator('#detail .outcome-box .note')).toHaveText(
      'cut: what follows is not counted'
    );
  });

  test('gives a line that came without its words those its rule and its bounds give, and marks a map key’s violation', async ({
    page,
  }) => {
    await drawOverview(page, { name: 'submit wordless' });

    const rows = await rowsOf(page);

    expect(
      rows.map(([field, rule, words]) => {
        return [field, rule, words];
      })
    ).toEqual([
      ['from', 'int32.lte', 'must be less than or equal to 10'],
      ['code', 'string.pattern', expect.stringMatching(/^does not match regex pattern `\^/u)],
      ['names[1]', 'string.min_len', 'must be at least 1 characters'],
      ['distinct', 'repeated.unique', 'repeated value must contain unique items'],
      ['above_tenth', 'float.gt', 'must be greater than 0.10000000149011612'],
      ['exactly', 'bytes.const', 'must be 00ff'],
    ]);
    expect(rows[3]?.[3]).toBe('');

    await drawOverview(page, { name: 'submit key' });
    expect(await rowsOf(page)).toEqual([
      [
        'labels["a"] (its key)',
        'string.min_len',
        'must be at least 2 characters',
        '{"min_len":"2"}',
      ],
    ]);
  });

  test('keeps the raw text of a detail of another form, as it reads', async ({ page }) => {
    await drawOverview(page, { name: 'submit text' });

    await expect(page.locator('#detail table.violations')).toHaveCount(0);
    await expect(page.locator('#detail .outcome-box')).toContainText('the request is invalid');
  });

  test('wraps a long pattern and a long key within the detail, stacked when narrow, its page scrolling no way sideways', async ({
    page,
  }, testInfo) => {
    for (const [name, width] of [
      ['submit wordless', 360],
      ['submit wordless', 560],
      ['submit wordless', 680],
      ['submit wordless', 960],
      ['submit longKey', 360],
      ['submit longKey', 960],
    ] as const) {
      await drawOverview(page, { name, width });

      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        const table = document.querySelector('#detail table.violations') as HTMLElement;
        const box = document.querySelector('#detail .outcome-box') as HTMLElement;

        return {
          page: root.scrollWidth - root.clientWidth,
          table: table.getBoundingClientRect().right - box.getBoundingClientRect().right,
        };
      });

      expect(overflow.page).toBeLessThanOrEqual(0);
      expect(overflow.table).toBeLessThanOrEqual(0);

      // the table as it looks, kept among the test's outputs
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath(`${name.replace(' ', '-')}-${String(width)}.png`),
      });
    }
  });
});
