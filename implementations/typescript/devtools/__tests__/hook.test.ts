import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { assertBuilt, launchExtension, PLAYGROUND, serveFolder } from './fixtures';

// helpers

/** The extension, the demo's static build served, and a page of it, connected. */
const openPlayground = async () => {
  await assertBuilt();

  const served = await serveFolder(PLAYGROUND);
  const { context, extensionId, worker } = await launchExtension();
  const page = await context.newPage();

  await page.goto(served.url);
  await page.waitForFunction(() => {
    return document.getElementById('connection')?.dataset['state'] === 'open';
  });

  return { context, extensionId, page, served, worker };
};

/** The id of the tab in front: the page last opened. */
const tabIdOf = async (worker: Worker): Promise<number> => {
  return worker.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        chrome: { tabs: { query: (query: object) => Promise<{ id?: number }[]> } };
      }
    ).chrome;
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });

    return tab?.id ?? -1;
  });
};

/** A panel on `tabId`'s page, as DevTools would open it, opened as a page of its own. */
const openPanel = async (
  context: BrowserContext,
  { extensionId, tabId }: { extensionId: string; tabId: number }
): Promise<Page> => {
  const panel = await context.newPage();

  await panel.goto(`chrome-extension://${extensionId}/panel.html?tabId=${String(tabId)}`);
  await expect(panel.locator('#status')).toHaveText('connected to the page');

  return panel;
};

/** Counts, on the page's window, the records the hook posts. */
const countRecords = async (page: Page): Promise<() => Promise<number>> => {
  await page.evaluate(() => {
    const counted = globalThis as unknown as { counted: number };

    counted.counted = 0;
    addEventListener('message', ({ data }) => {
      const { channel, from, message } = (data ?? {}) as {
        channel?: string;
        from?: string;
        message?: { records?: unknown[]; type?: string };
      };

      if (channel === 'bead-devtools' && from === 'hook' && message?.type === 'records') {
        counted.counted += message.records?.length ?? 0;
      }
    });
  });

  return () => {
    return page.evaluate(() => {
      const counted = globalThis as unknown as { counted: number };
      const count = counted.counted;

      counted.counted = 0;

      return count;
    });
  };
};

// definition

test.describe('the hook, the bridge and the background', () => {
  test('defines the hook in the page’s world before its scripts run, under the package’s key, unlisted', async () => {
    const { context, page, served } = await openPlayground();

    expect(
      await page.evaluate(() => {
        const key = Symbol.for('@francisdesjardins/bead/devtools-hook');
        const hook = (globalThis as Record<symbol, { register?: unknown } | undefined>)[key];

        return [
          typeof hook?.register,
          Object.getOwnPropertySymbols(globalThis).includes(key),
          Object.keys(globalThis).some((name) => {
            return name.includes('bead');
          }),
        ];
      })
    ).toEqual(['function', true, false]);
    await context.close();
    await served.close();
  });

  test('follows the page’s calls and envelopes, and what its registry counts, to the panel on its tab', async () => {
    const { context, extensionId, page, served, worker } = await openPlayground();
    const tabId = await tabIdOf(worker);
    const panel = await openPanel(context, { extensionId, tabId });

    for (const action of ['read', 'reader', 'read']) {
      await page.click(`button[data-action="${action}"]`);
      await expect(page.locator('#result')).not.toHaveText('—');
    }

    await expect(panel.locator('#source option')).toHaveText(['All clients', 'Client 1']);
    await expect(panel.locator('#calls tr', { hasText: 'whoami' })).toHaveCount(2);
    await expect(panel.locator('#calls tr', { hasText: 'SESSION_REQUIRED' })).toHaveCount(1);

    await panel.locator('#calls tr', { hasText: 'whoami' }).first().click();
    await expect(panel.locator('#detail')).toContainText('Received');

    await panel.click('[data-tab="envelopes"]');
    await expect(
      panel.locator('#envelopes tr', { hasText: 'credential JWT' }).first()
    ).toBeVisible();
    // a credential crosses by its scheme alone, never its token
    expect(await panel.locator('#envelopes').textContent()).not.toContain('eyJ');

    await panel.click('[data-tab="metrics"]');
    await expect(panel.locator('#metrics li', { hasText: 'whoami' })).toContainText('1 made');

    await panel.fill('#filter', '-stats, -metrics, d(rx)');
    await panel.click('[data-tab="calls"]');
    await expect(panel.locator('#calls tr', { hasText: 'stats' })).toHaveCount(0);
    await expect(panel.locator('#calls tr[data-direction="tx"]')).toHaveCount(0);
    await context.close();
    await served.close();
  });

  test('watches the page only while a panel is open on its tab', async () => {
    const { context, extensionId, page, served, worker } = await openPlayground();
    const tabId = await tabIdOf(worker);
    const counted = await countRecords(page);

    await page.click('button[data-action="read"]');
    await page.waitForTimeout(500);
    expect(await counted()).toBe(0);

    const panel = await openPanel(context, { extensionId, tabId });

    await page.click('button[data-action="read"]');
    await expect.poll(counted).toBeGreaterThan(0);

    await panel.close();
    await page.waitForTimeout(300);
    await counted();
    await page.click('button[data-action="read"]');
    await page.waitForTimeout(1_500);
    expect(await counted()).toBe(0);
    await context.close();
    await served.close();
  });
});
