import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { EnvelopeKind } from '../../src/router/shared/constants';
import type { ICallRecord, IEnvelopeRecord } from '../messages';
import type { ILog } from '../model/log';
import { assertBuilt, launchExtension, PLAYGROUND, serveFolder, serveMqttDemo } from './fixtures';

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
  test('budgets participant records independently, saves their evictions and initial levels, and leaves another protocol unwatched', async () => {
    const { context, extensionId, page, served, worker } = await openPlayground();
    try {
      await page.evaluate(() => {
        const hook = (globalThis as unknown as Record<symbol, { register(source: object): void }>)[
          Symbol.for('@francisdesjardins/bead/devtools-hook')
        ];
        Object.assign(globalThis, {
          watchedParticipant: false,
          stoppedParticipant: false,
          watchedUnknown: false,
        });
        hook?.register({
          protocol: 1,
          side: 'participant',
          exposition: () => {
            return undefined;
          },
          inspect: () => {
            return {
              id: 'probe',
              inbox: ['bead', 'i', 'probe'],
              incarnation: '0102',
              isLinked: true,
              names: ['echo'],
              gauges: { counts: { partsBytes: 0 }, ceilings: { partsBytes: 64 }, anomalies: [] },
            };
          },
          watch: (listeners: {
            participant?: (event: object) => void;
            call(error: unknown, event: object): void;
          }) => {
            Object.assign(globalThis, { watchedParticipant: true });
            for (let index = 0; index < 6_000; index += 1) {
              listeners.participant?.({
                event: 'parcel',
                direction: 'rx',
                kind: 'PING',
                topic: ['bead', 'i', 'probe'],
                bytes: 28,
                sequence: index + 1,
                connection: 1,
                verdict: 'taken',
              });
            }
            listeners.call(null, {
              direction: 'tx',
              type: 'request',
              startedAt: 100,
              serviceId: 1,
              serviceRevision: 0,
              procedureId: 1,
              procedureName: 'budget-call',
              options: {},
            });
            return () => {
              Object.assign(globalThis, { stoppedParticipant: true });
            };
          },
        });
        hook?.register({
          protocol: 2,
          side: 'client',
          exposition: () => {
            return undefined;
          },
          watch: () => {
            Object.assign(globalThis, { watchedUnknown: true });
            return () => {};
          },
        });
      });
      const panel = await openPanel(context, { extensionId, tabId: await tabIdOf(worker) });
      await expect(panel.locator('#calls')).toContainText('budget-call');
      await panel.click('[data-tab="broker"]');
      await expect(panel.locator('#broker')).toContainText('5000 let go');
      await expect(panel.locator('#broker')).toContainText('probe · up');
      await expect(panel.locator('#broker tbody tr')).toHaveCount(1_000);
      const [download] = await Promise.all([
        panel.waitForEvent('download'),
        panel.click('#export'),
      ]);
      const saved = await download.path();
      const log = JSON.parse(await readFile(saved, 'utf8')) as ILog;
      expect(log.version).toBe(2);
      expect(log.dropped).toBe(0);
      expect(log.droppedParticipants).toBe(5_000);
      expect(
        log.sources.find(({ side }) => {
          return side === 'participant';
        })?.inspection?.id
      ).toBe('probe');
      expect(
        log.records.filter((record) => {
          return record.kind === 'participant';
        })
      ).toHaveLength(1_000);
      expect(
        log.records
          .filter(({ kind }) => {
            return kind === 'participant';
          })
          .every((record) => {
            return record.kind === 'participant' && record.event === 'parcel';
          })
      ).toBe(true);
      await panel.close();
      await page.waitForFunction(() => {
        return (globalThis as unknown as { stoppedParticipant: boolean }).stoppedParticipant;
      });
      expect(
        await page.evaluate(() => {
          return (globalThis as unknown as { watchedUnknown: boolean }).watchedUnknown;
        })
      ).toBe(false);
    } finally {
      await context.close();
      await served.close();
    }
  });

  test('shows the participant’s parcels and a link lost then restored over MQTT 5', async () => {
    const hasBroker =
      process.env['BEAD_MQTT_URL'] !== undefined && process.env['BEAD_MQTT_WS_URL'] !== undefined;
    const noBroker = 'no broker: BEAD_MQTT_URL or BEAD_MQTT_WS_URL is not set';
    test.skip(!hasBroker && process.env['BEAD_MQTT_REQUIRED'] !== '1', noBroker);
    expect(hasBroker, noBroker).toBe(true);
    await assertBuilt();
    await using served = await serveMqttDemo();
    const { context, extensionId, worker } = await launchExtension();
    try {
      const page = await context.newPage();
      let cut: (() => void) | undefined;
      await context.routeWebSocket(process.env['BEAD_MQTT_WS_URL'] ?? '', (socket) => {
        const server = socket.connectToServer();
        cut = () => {
          // ! the network end may wait for its peer; the page's close event starts its recovery.
          void Promise.all([server.close({ code: 1011 }), socket.close({ code: 1011 })]).catch(
            () => {}
          );
        };
      });
      await page.goto(`${served.url}?transport=mqtt`);
      await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
      const panel = await openPanel(context, { extensionId, tabId: await tabIdOf(worker) });
      await panel.click('[data-tab="broker"]');
      await expect(panel.locator('#broker')).toContainText('client · up');
      await expect(panel.locator('#broker')).toContainText('bead/i/client');
      await page.click('button[data-action="reader"]');
      await expect(page.locator('#result')).toContainText('logged in as');
      await expect(panel.locator('#broker tbody')).toContainText('DATA');
      expect(cut).toBeDefined();
      cut?.();
      await expect(panel.locator('#broker tbody')).toContainText('Link down');
      await expect(panel.locator('#broker h2').first()).toContainText('client · up');
      const [download] = await Promise.all([
        panel.waitForEvent('download'),
        panel.click('#export'),
      ]);
      const saved = await download.path();
      const log = JSON.parse(await readFile(saved, 'utf8')) as ILog;
      const records = log.records.filter((record) => {
        return record.kind === 'participant';
      });
      expect(
        records.some((record) => {
          return record.parcelKind === 'DATA';
        })
      ).toBe(true);
      const links = records.filter((record) => {
        return record.event === 'link';
      });
      expect(
        links.map((record) => {
          return record.state;
        })
      ).toEqual(['down', 'up']);
      expect(links[0]?.incarnation).not.toBe(links[1]?.incarnation);
      expect(JSON.stringify(records)).not.toContain('eyJ');
      if (process.env['BEAD_MQTT_PASSWORD'] !== undefined) {
        expect(JSON.stringify(records)).not.toContain(process.env['BEAD_MQTT_PASSWORD']);
      }
      await test
        .info()
        .attach('broker-panel-log', { contentType: 'application/json', path: saved });
      const counted = await countRecords(page);
      await panel.close();
      await page.waitForTimeout(300);
      await counted();
      cut?.();
      await page.waitForTimeout(500);
      expect(await counted()).toBe(0);
    } finally {
      await context.close();
    }
  });

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

      await expect(panel.locator('#source option')).toHaveText([
        'All clients',
        'Participant 1',
        'Client 2',
      ]);
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
      expect(log.sources).toMatchObject([
        { id: 1, protocol: 1, side: 'participant' },
        { id: 2, protocol: 1, side: 'client' },
      ]);
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
