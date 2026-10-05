import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { FailureScope, ProtocolCode } from '../../src/router/client/router-client';
import { EnvelopeKind } from '../../src/router/shared/constants';
import { writeEnvelope } from '../../src/router/shared/envelope';
import type { BackgroundMessage } from '../messages';
import { assertBuilt, EXTENSION } from './fixtures';

// interfaces

/** What the fake DevTools API keeps, on the panel's page. */
interface IFake {
  deliver: (message: BackgroundMessage) => void;
  finish: (entry: object) => void;
  posted: unknown[];
}

// helpers

const encoder = new TextEncoder();

/** The panel, on a page of its own, over a fake of what DevTools and the runtime give it. */
const openPanel = async (page: Page): Promise<void> => {
  await assertBuilt();
  await page.addInitScript(() => {
    const listeners = {
      disconnect: [] as ((port: unknown) => void)[],
      finished: [] as ((entry: unknown) => void)[],
      message: [] as ((message: unknown) => void)[],
    };
    const posted: unknown[] = [];
    const eventOf = (list: ((value: never) => void)[]) => {
      return {
        addListener: (listener: (value: never) => void) => {
          list.push(listener);
        },
        removeListener: () => {},
      };
    };
    const fake: IFake = {
      deliver: (message) => {
        for (const listener of listeners.message) {
          listener(message);
        }
      },
      finish: (entry) => {
        for (const listener of listeners.finished) {
          listener(entry);
        }
      },
      posted,
    };

    Object.assign(globalThis, {
      chrome: {
        devtools: {
          inspectedWindow: { tabId: 7 },
          network: { onRequestFinished: eventOf(listeners.finished) },
          panels: { create: () => {}, themeName: 'dark' },
        },
        runtime: {
          connect: ({ name }: { name: string }) => {
            return {
              disconnect: () => {},
              name,
              onDisconnect: eventOf(listeners.disconnect),
              onMessage: eventOf(listeners.message),
              postMessage: (message: unknown) => {
                posted.push(message);
              },
            };
          },
          getURL: (path: string) => {
            return `chrome-extension://fake/${path}`;
          },
          id: 'fake',
          onConnect: eventOf([]),
        },
      },
      fake,
    });
  });
  await page.goto(pathToFileURL(join(EXTENSION, 'panel.html')).href);
};

const deliver = async (page: Page, message: BackgroundMessage): Promise<void> => {
  await page.evaluate((delivered) => {
    (globalThis as unknown as { fake: IFake }).fake.deliver(delivered);
  }, message);
};

const postedOf = (page: Page): Promise<unknown[]> => {
  return page.evaluate(() => {
    return (globalThis as unknown as { fake: IFake }).fake.posted;
  });
};

/** Bytes as text whose every character is one of them, as DevTools may give a request's body. */
const latin1Of = (bytes: Uint8Array): string => {
  return String.fromCharCode(...bytes);
};

const CALL = Object.freeze({
  direction: 'rx',
  duration: 3,
  kind: 'call',
  procedureId: 3,
  procedureName: 'read',
  rx: '{"value": 1}',
  serviceId: 1,
  serviceRevision: 1,
  source: 1,
  startedAt: 1_000,
  type: 'request',
} as const);

// definition

test.describe('the panel', () => {
  test('greets the background with its tab, follows DevTools’ theme, and reads the registries as its Metrics view opens', async ({
    page,
  }) => {
    await openPanel(page);

    expect(await postedOf(page)).toEqual([{ tabId: 7, type: 'panel' }]);
    expect(
      await page.evaluate(() => {
        return document.documentElement.dataset['theme'];
      })
    ).toBe('dark');

    await page.click('[data-tab="metrics"]');
    await expect
      .poll(() => {
        return postedOf(page);
      })
      .toContainEqual({ type: 'read-expositions' });
  });

  test('shows the page’s clients and their calls, filters them as the package’s filter does, and says why a filter is refused', async ({
    page,
  }) => {
    await openPanel(page);
    await deliver(page, { type: 'page-connected' });
    await deliver(page, {
      sources: [
        { id: 1, protocol: 1, side: 'client' },
        { id: 2, protocol: 2, side: 'client' },
      ],
      type: 'sources',
    });
    await deliver(page, {
      dropped: 0,
      records: [
        { ...CALL, direction: 'tx', duration: undefined, rx: undefined, tx: '""' },
        CALL,
        {
          ...CALL,
          error: {
            code: ProtocolCode.ACCESS_DENIED,
            message: 'denied',
            name: 'FailureError',
            scope: FailureScope.PROTOCOL,
          },
          procedureName: 'increment',
        },
      ],
      type: 'records',
    });

    await expect(page.locator('#status')).toHaveText('connected to the page');
    await expect(page.locator('#source option')).toHaveText([
      'All clients',
      'Client 1',
      'Client 2, protocol 2, unknown',
    ]);
    await expect(page.locator('#calls tr')).toHaveCount(3);
    await expect(page.locator('#calls tr.failed')).toContainText('ACCESS_DENIED');

    await page.fill('#filter', 'd(rx), -increment');
    await expect(page.locator('#calls tr')).toHaveCount(1);
    await page.locator('#calls tr').click();
    await expect(page.locator('#detail')).toContainText('{"value": 1}');

    await page.fill('#filter', 'd(up)');
    await expect(page.locator('#filter-state')).not.toBeEmpty();
    await expect(page.locator('#calls tr')).toHaveCount(3);

    await deliver(page, { type: 'page-gone' });
    await expect(page.locator('#status')).toHaveText('the page is gone: waiting for it');
    await expect(page.locator('#source option')).toHaveText(['All clients']);
  });

  test('shows what a registry counts, and says when a client was given none', async ({ page }) => {
    await openPanel(page);
    await deliver(page, {
      sources: [
        { id: 1, protocol: 1, side: 'client' },
        { id: 2, protocol: 1, side: 'client' },
      ],
      type: 'sources',
    });
    await deliver(page, {
      expositions: [
        {
          source: 1,
          text: [
            'bead_client_call_started_total{service="1",procedure="read",type="request"} 2',
            'bead_client_call_handled_total{service="1",procedure="read",type="request",outcome="result"} 1',
            'bead_client_call_handled_total{service="1",procedure="read",type="request",outcome="failure",code="SESSION_REQUIRED"} 1',
            'bead_client_call_duration_seconds_bucket{service="1",procedure="read",type="request",le="0.001"} 2',
            'bead_client_call_duration_seconds_bucket{service="1",procedure="read",type="request",le="+Inf"} 2',
            'bead_client_call_duration_seconds_count{service="1",procedure="read",type="request"} 2',
            '',
          ].join('\n'),
        },
        { source: 2, text: null },
      ],
      type: 'expositions',
    });
    await page.click('[data-tab="metrics"]');

    await expect(page.locator('#metrics li', { hasText: 'read' })).toContainText('2 made');
    await expect(page.locator('#metrics .chip.failure')).toHaveText('1 SESSION_REQUIRED');
    await expect(page.locator('#metrics')).toContainText(
      'This client was given no metrics registry'
    );
  });

  test('reads the HTTP transport’s exchanges from the Network panel’s entries, with the package’s codec', async ({
    page,
  }) => {
    const request = writeEnvelope({
      header: {
        callId: 1,
        kind: EnvelopeKind.REQUEST,
        procedureId: 3,
        serviceId: 1,
      },
      kind: EnvelopeKind.REQUEST,
      payload: encoder.encode('hello'),
    });
    const result = writeEnvelope({
      header: { callId: 1, kind: EnvelopeKind.RESULT },
      kind: EnvelopeKind.RESULT,
      payload: encoder.encode('hi'),
    });
    const batch = new Uint8Array(4 + result.length);

    new DataView(batch.buffer).setUint32(0, result.length);
    batch.set(result, 4);

    await openPanel(page);
    await page.evaluate(
      ([requestText, responseBase64]) => {
        const { fake } = globalThis as unknown as { fake: IFake };

        fake.finish({
          getContent: (callback: (content: string, encoding: string) => void) => {
            callback(responseBase64, 'base64');
          },
          request: {
            method: 'POST',
            postData: { mimeType: 'application/prs.bead', text: requestText },
            url: 'http://localhost:8080/bead',
          },
          response: { content: { mimeType: 'application/prs.bead' }, status: 200 },
          startedDateTime: '2026-10-04T12:00:00.000Z',
        });
        fake.finish({
          getContent: () => {},
          request: { method: 'GET', url: 'http://localhost:8080/page.js' },
          response: { content: { mimeType: 'text/javascript' }, status: 200 },
          startedDateTime: '2026-10-04T12:00:00.000Z',
        });
      },
      [latin1Of(request), btoa(latin1Of(batch))] as const
    );
    await page.click('[data-tab="wire"]');

    await expect(page.locator('#wire .exchange')).toHaveCount(1);
    await expect(page.locator('#wire h3')).toHaveText('POST /bead — 200');
    await expect(page.locator('#wire pre').first()).toContainText(
      'REQUEST #1 procedureId 3, serviceId 1'
    );
    await expect(page.locator('#wire pre').last()).toContainText('RESULT #1 2 bytes');
  });
});
