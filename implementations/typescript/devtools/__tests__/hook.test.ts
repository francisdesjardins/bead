import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EnvelopeKind } from '../../src/router/shared/constants';
import type { ICallRecord, IEnvelopeRecord } from '../messages';
import type { ILog } from '../model/log';
import { assertBuilt, launchExtension, PLAYGROUND, serveFolder } from './fixtures';

// helpers

/** The demo's launcher, beside the run's broker, and what stops it even when an assertion fails. */
const serveMqttDemo = async () => {
  const reservation = createServer();

  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');

  const address = reservation.address();

  if (address === null || typeof address === 'string') {
    throw new Error('the demo needs a TCP port');
  }

  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });

  const server = spawn(process.execPath, ['demo/serve.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, DEMO_PORT: String(address.port) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stop = async (): Promise<void> => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');

      server.kill();
      await exited;
    }
  };

  server.stderr.pipe(process.stderr);
  const deadline = setTimeout(() => {
    server.kill();
  }, 10_000);

  try {
    for await (const line of createInterface({ input: server.stdout })) {
      if (line.startsWith('Bead, a demo:')) {
        return { url: `http://127.0.0.1:${String(address.port)}/`, [Symbol.asyncDispose]: stop };
      }
    }

    throw new Error('the demo ends before it says its port');
  } catch (error) {
    await stop();

    throw error;
  } finally {
    clearTimeout(deadline);
  }
};

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
  test('follows the page’s calls, each service debug step and its envelopes to the panel over MQTT 5', async () => {
    const noBroker =
      'no broker: BEAD_MQTT_URL or BEAD_MQTT_WS_URL is not set (node tools/mqtt-broker.mjs start)';
    const hasBroker =
      process.env['BEAD_MQTT_URL'] !== undefined && process.env['BEAD_MQTT_WS_URL'] !== undefined;

    test.skip(!hasBroker && process.env['BEAD_MQTT_REQUIRED'] !== '1', noBroker);
    expect(hasBroker, noBroker).toBe(true);
    await assertBuilt();

    await using served = await serveMqttDemo();
    const { context, extensionId, worker } = await launchExtension();

    try {
      const page = await context.newPage();
      const links: string[] = [];

      page.on('websocket', (socket) => {
        links.push(socket.url());
      });
      await page.goto(`${served.url}?transport=mqtt`);
      await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
      expect(links).toEqual([process.env['BEAD_MQTT_WS_URL']]);
      const panel = await openPanel(context, { extensionId, tabId: await tabIdOf(worker) });

      await expect(panel.locator('#source option')).toHaveText(['All clients', 'Client 1']);
      await panel.fill('#filter', '-stats, -metrics');

      for (const [action, result] of [
        ['read', /SESSION_REQUIRED/u],
        ['reader', /logged in as/u],
        ['read', /counter at 0/u],
        ['fail', /procedure/u],
        ['ask', /the server asked the client its time/u],
      ] as const) {
        await page.click(`button[data-action="${action}"]`);
        await expect(page.locator('#result')).toContainText(result);
      }

      await expect(panel.locator('#calls tr.call')).toHaveCount(6);
      await expect(panel.locator('#calls tr.call', { hasText: 'SESSION_REQUIRED' })).toHaveCount(1);
      await expect(panel.locator('#calls tr.call', { hasText: 'clock' })).toContainText(
        'command, in'
      );
      const whoami = panel.locator('#calls tr.call', { hasText: 'whoami' });

      await whoami.click();
      await panel.click('[data-detail="payload"]');
      await expect(panel.locator('#detail')).toContainText('reader');
      await panel.click('[data-detail="exchange"]');
      await expect(panel.locator('#detail .thread circle')).toHaveCount(2);
      await whoami.locator('[data-twist]').click();
      await expect(panel.locator('#calls tr.envelope')).toHaveText([
        /→ REQUEST.*credential JWT/u,
        /← RESULT/u,
      ]);

      // * Export reads what the panel holds, beyond what its rows summarize.
      const [download] = await Promise.all([
        panel.waitForEvent('download'),
        panel.click('#export'),
      ]);
      const saved = await download.path();
      const log = JSON.parse(await readFile(saved, 'utf8')) as ILog;

      await test.info().attach('mqtt-panel-log', { contentType: 'application/json', path: saved });

      const steps = log.records.filter((record): record is ICallRecord => {
        return record.kind === 'call' && !['stats', 'metrics'].includes(record.procedureName);
      });
      const words = steps.map((record) => {
        return `${record.direction === 'tx' ? '→' : '←'} ${record.type} ${record.procedureName}`;
      });
      const pageSteps = (await page.locator('#calls-log li').allTextContents())
        .reverse()
        .map((line) => {
          return line.match(/[→←] \w+ \w+/u)?.[0];
        });

      expect(words).toEqual(pageSteps);
      expect(words).toEqual([
        '→ request read',
        '← request read',
        '→ request whoami',
        '← request whoami',
        '→ request read',
        '← request read',
        '→ request fail',
        '← request fail',
        '→ request ask',
        '← command clock',
        '→ command clock',
        '← request ask',
      ]);
      expect(log.sources).toEqual([{ id: 1, protocol: 1, side: 'client' }]);
      expect(log.dropped).toBe(0);

      const envelopes = log.records.filter((record): record is IEnvelopeRecord => {
        return (
          record.kind === 'envelope' &&
          steps.some((step) => {
            return (
              step.callId === record.header['callId'] &&
              step.connectionHandle === record.connectionHandle
            );
          })
        );
      });

      expect(envelopes).toHaveLength(12);
      const kindNameOf = new Map<number, string>(
        Object.entries(EnvelopeKind).map(([name, kind]) => {
          return [kind, name];
        })
      );
      const envelopeWords = envelopes.map((record) => {
        return `${record.direction === 'tx' ? '→' : '←'} ${kindNameOf.get(Number(record.header['kind']))} #${String(record.header['callId'])}`;
      });
      const callIds = new Set(
        steps.map((step) => {
          return step.callId;
        })
      );
      const pageEnvelopes = (await page.locator('#envelopes-log li').allTextContents())
        .reverse()
        .flatMap((line) => {
          const found = line.match(/[→←] \w+ #(\d+)/u);

          return found !== null && callIds.has(Number(found[1])) ? [found[0]] : [];
        });

      expect(envelopeWords).toEqual(pageEnvelopes);
      expect(
        envelopes.filter((record) => {
          return record.header['kind'] === EnvelopeKind.FAILURE;
        })
      ).toHaveLength(2);
      await panel.click('[data-mode="envelopes"]');
      await expect(panel.locator('#envelopes tr')).toHaveCount(envelopes.length);
      expect(await panel.locator('#envelopes').textContent()).not.toContain('eyJ');
    } finally {
      await context.close();
    }
  });

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
    // a call a row, its steps and its envelopes together
    await expect(panel.locator('#calls tr.call', { hasText: 'whoami' })).toHaveCount(1);
    await expect(panel.locator('#calls tr.call', { hasText: 'SESSION_REQUIRED' })).toHaveCount(1);

    await panel.locator('#calls tr.call', { hasText: 'whoami' }).click();
    await panel.click('[data-detail="payload"]');
    await expect(panel.locator('#detail')).toContainText('Answer');

    // the stack that made a call reaches the page's own script, the hook's frames left out
    await panel.locator('#calls tr.call', { hasText: 'SESSION_REQUIRED' }).click();
    await panel.click('[data-detail="trace"]');
    await expect(panel.locator('#detail .frames').first()).toContainText(new URL(served.url).host);
    expect(await panel.locator('#detail').textContent()).not.toContain('hook.js');

    await panel.click('[data-detail="exchange"]');
    await expect(panel.locator('#detail .thread circle').first()).toBeVisible();

    await panel.click('[data-mode="envelopes"]');
    await expect(
      panel.locator('#envelopes tr', { hasText: 'credential JWT' }).first()
    ).toBeVisible();
    // a credential crosses by its scheme alone, never its token
    expect(await panel.locator('#envelopes').textContent()).not.toContain('eyJ');

    await panel.click('[data-tab="metrics"]');
    await expect(panel.locator('#metrics tr[data-procedure="whoami"]')).toContainText('made');

    await panel.fill('#filter', '-stats, -metrics, d(rx)');
    await panel.click('[data-tab="calls"]');
    await panel.click('[data-mode="calls"]');
    await expect(panel.locator('#calls tr.call', { hasText: 'stats' })).toHaveCount(0);
    await expect(panel.locator('#calls tr.call', { hasText: 'whoami' })).toHaveCount(1);
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
