import { expect, test, type Page } from '@playwright/test';
import { installRuntime, runtimeOf, scriptOf } from './runtime';

// helpers

let script = '';

/** A page with the bridge running on the fake runtime, its clock in the test's hands. */
const openBridge = async (page: Page): Promise<void> => {
  await page.clock.install();
  await installRuntime(page);
  // * init scripts run on a navigation, which setContent is not
  await page.goto('data:text/html,<main></main>');
  await page.addScriptTag({ content: script });
};

const drop = (page: Page, error?: string): Promise<void> => {
  return page.evaluate((message) => {
    const { fake } = globalThis as unknown as {
      fake: { drop: (index: number, error?: string) => void; ports: unknown[] };
    };

    fake.drop(fake.ports.length - 1, message);
  }, error);
};

// a page put into the back/forward cache, or taken out of it, or left for good
const transition = (page: Page, options: { type: 'pagehide' | 'pageshow'; persisted: boolean }) => {
  return page.evaluate(({ type, persisted }) => {
    window.dispatchEvent(new PageTransitionEvent(type, { persisted }));
  }, options);
};

// definition

test.beforeAll(async () => {
  script = await scriptOf('bridge');
});

test.describe('the bridge', () => {
  test('reads runtime.lastError as its port closes, then opens another a second later', async ({
    page,
  }) => {
    await openBridge(page);
    expect((await runtimeOf(page)).ports).toHaveLength(1);

    await drop(page, 'The page keeping the extension port is moved into back/forward cache');

    expect((await runtimeOf(page)).lastErrorReads).toBe(1);
    await page.clock.runFor(1_000);
    expect((await runtimeOf(page)).ports).toHaveLength(2);
  });

  test('closes its port as the page enters the back/forward cache, and opens none until it leaves', async ({
    page,
  }) => {
    await openBridge(page);

    // * a page left for good keeps its port to the end
    await transition(page, { type: 'pagehide', persisted: false });
    expect((await runtimeOf(page)).ports[0]?.isDisconnected).toBe(false);

    await transition(page, { type: 'pagehide', persisted: true });
    expect((await runtimeOf(page)).ports[0]?.isDisconnected).toBe(true);

    // * a disconnect told while the page is cached schedules nothing
    await drop(page, 'The page keeping the extension port is moved into back/forward cache');
    await page.clock.runFor(5_000);
    expect(await runtimeOf(page)).toEqual({
      lastErrorReads: 1,
      ports: [{ name: 'bead-page', isDisconnected: true, posted: [] }],
    });

    await transition(page, { type: 'pageshow', persisted: true });
    expect(
      (await runtimeOf(page)).ports.map(({ isDisconnected }) => {
        return isDisconnected;
      })
    ).toEqual([true, false]);

    // * the page restored is shown once: no second port
    await page.clock.runFor(5_000);
    expect((await runtimeOf(page)).ports).toHaveLength(2);
  });
});
