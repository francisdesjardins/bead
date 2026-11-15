import { expect, test } from '@playwright/test';
import { installRuntime, runtimeOf, scriptOf } from './runtime';

// definition

let script = '';

test.beforeAll(async () => {
  script = await scriptOf('background');
});

test.describe('the background', () => {
  test('reads runtime.lastError as a page’s port or a panel’s closes', async ({ page }) => {
    await installRuntime(page);
    // * init scripts run on a navigation, which setContent is not
    await page.goto('data:text/html,<main></main>');
    await page.addScriptTag({ content: script });

    await page.evaluate(() => {
      const { fake } = globalThis as unknown as {
        fake: {
          drop: (index: number, error?: string) => void;
          offer: (port: { name: string; sender?: object }) => void;
        };
      };
      const error = 'The page keeping the extension port is moved into back/forward cache';

      fake.offer({ name: 'bead-page', sender: { frameId: 0, tab: { id: 7 } } });
      fake.offer({ name: 'bead-panel', sender: { url: 'chrome-extension://fake/panel.html' } });
      fake.drop(0, error);
      fake.drop(1, error);
    });

    const { lastErrorReads, ports } = await runtimeOf(page);

    expect(lastErrorReads).toBe(2);
    // a page that no panel watches is told to stop
    expect(ports[0]?.posted).toEqual([{ type: 'unwatch' }]);
  });
});
