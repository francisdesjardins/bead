import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FailureScope, ProtocolCode } from '../../../src/router/client/router-client';
import { EnvelopeKind } from '../../../src/router/shared/constants';
import { writeEnvelope } from '../../../src/router/shared/envelope';
import { INVALID_DETAILS, specDetailOf } from '../../__tests__/traffic';
import { readBody } from '../../wire';
import type { IExchange, wireViewOf } from '../wire';

// interfaces

/** The view module's browser bundle, without the panel or the DevTools API. */
interface IWireViewModule {
  wireViewOf: typeof wireViewOf;
}

// helpers

let script = '';
let styles = '';

const encoder = new TextEncoder();

/** A FAILURE of call `callId`, its code, its scope the protocol's, and its detail. */
const failureOf = (callId: number, { code, detail }: { code: number; detail: string }) => {
  return writeEnvelope({
    failure: { code, detail, scope: FailureScope.PROTOCOL },
    header: { callId, kind: EnvelopeKind.FAILURE },
    kind: EnvelopeKind.FAILURE,
  });
};

/** A batch, as an answer carries one: each envelope after its length on 4 bytes. */
const batchOf = (...envelopes: Uint8Array[]): Uint8Array => {
  const batch = new Uint8Array(
    envelopes.reduce((total, envelope) => {
      return total + 4 + envelope.length;
    }, 0)
  );
  const view = new DataView(batch.buffer);
  let offset = 0;

  for (const envelope of envelopes) {
    view.setUint32(offset, envelope.length);
    batch.set(envelope, offset + 4);
    offset += 4 + envelope.length;
  }

  return batch;
};

/** An exchange whose answer is a batch of failures, a PAYLOAD_INVALID's each of the details named. */
const EXCHANGE: IExchange = {
  method: 'POST',
  request: readBody(
    writeEnvelope({
      header: { callId: 1, kind: EnvelopeKind.REQUEST, procedureId: 12, serviceId: 1 },
      kind: EnvelopeKind.REQUEST,
      payload: encoder.encode('{"from":11}'),
    }),
    'envelope'
  ),
  requestBytes: 24,
  response: readBody(
    batchOf(
      failureOf(1, {
        code: ProtocolCode.PAYLOAD_INVALID,
        detail: specDetailOf(INVALID_DETAILS.whole),
      }),
      failureOf(2, {
        code: ProtocolCode.PAYLOAD_INVALID,
        detail: specDetailOf(INVALID_DETAILS.counted),
      }),
      failureOf(3, {
        code: ProtocolCode.PAYLOAD_INVALID,
        detail: specDetailOf(INVALID_DETAILS.wordless),
      }),
      failureOf(4, {
        code: ProtocolCode.PAYLOAD_INVALID,
        detail: specDetailOf(INVALID_DETAILS.text),
      }),
      failureOf(5, { code: ProtocolCode.ACCESS_DENIED, detail: 'not you' })
    ),
    'batch'
  ),
  responseBytes: 1_200,
  startedAt: 1_760_000_000_000,
  status: 200,
  url: 'http://localhost:8080/bead',
};

/** Draws the Wire view of {@link EXCHANGE} in a page `width` pixels wide. */
const drawWire = async (page: Page, width: number): Promise<void> => {
  await page.setViewportSize({ height: 720, width });
  await page.evaluate((exchange) => {
    const { wireView } = globalThis as unknown as { wireView: IWireViewModule };
    const root = document.getElementById('wire') as HTMLElement;

    root.replaceChildren(
      ...wireView.wireViewOf({
        copy: () => {},
        exchanges: [exchange],
        isAvailable: true,
        nameOf: () => {
          return 'offer';
        },
      })
    );
  }, EXCHANGE);
};

test.beforeAll(async () => {
  const [bundle, panel, system, skin] = await Promise.all([
    build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL('../wire.ts', import.meta.url))],
      format: 'iife',
      globalName: 'wireView',
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
  await page.setContent('<div id="wire"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
});

// definition

test.describe('wireViewOf', () => {
  test('sums a PAYLOAD_INVALID up on its line, its whole detail in its tooltip, and keeps another detail as text', async ({
    page,
  }) => {
    await drawWire(page, 960);

    const lines = page.locator('#wire .envelopes > div');

    await expect(lines).toHaveText([
      '→ REQUEST · #1 · offer · 11 bytes',
      '← FAILURE · #1 · PAYLOAD_INVALID · 1 violation · from: must be less than or equal to 10',
      '← FAILURE · #2 · PAYLOAD_INVALID · 2 violations · from: must be less than or equal to 10 … +3',
      '← FAILURE · #3 · PAYLOAD_INVALID · 6 violations · from: must be less than or equal to 10',
      '← FAILURE · #4 · PAYLOAD_INVALID: the request is invalid',
      '← FAILURE · #5 · ACCESS_DENIED: not you',
    ]);
    await expect(lines.nth(2)).toHaveAttribute('title', specDetailOf(INVALID_DETAILS.counted));
    await expect(page.locator('#wire .envelopes .summed')).toHaveCount(3);
    await expect(lines.nth(4)).not.toHaveAttribute('title');
  });

  test('keeps a summed line to one line in a narrow panel', async ({ page }) => {
    await drawWire(page, 320);

    const heights = await page.locator('#wire .envelopes .summed').evaluateAll((lines) => {
      return lines.map((line) => {
        return (
          line.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(line).lineHeight)
        );
      });
    });

    expect(heights).toHaveLength(3);

    for (const height of heights) {
      expect(height).toBeLessThan(1.5);
    }

    expect(
      await page.evaluate(() => {
        return document.documentElement.scrollWidth - document.documentElement.clientWidth;
      })
    ).toBeLessThanOrEqual(0);
  });
});
