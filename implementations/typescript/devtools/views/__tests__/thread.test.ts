import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { IDS, SLOW_RELAY, TRAFFIC } from '../../__tests__/traffic';
import { createCallBook } from '../../model/calls';
import type { fitThreadLabels, threadViewOf } from '../thread';

// interfaces

/** The view module's browser bundle, without the panel or the DevTools API. */
interface IThreadView {
  fitThreadLabels: typeof fitThreadLabels;
  threadViewOf: typeof threadViewOf;
}

// helpers

let script = '';
let styles = '';

const book = createCallBook();

for (const record of [...TRAFFIC, ...SLOW_RELAY]) {
  book.take(record);
}

/** Draws a traffic call directly, attached before its labels are measured. */
const drawCall = async (page: Page, callId: number): Promise<void> => {
  const call = book.calls.find((held) => {
    return held.callId === callId;
  });

  if (call === undefined) {
    throw new Error(`the traffic has no call #${String(callId)}`);
  }

  await page.evaluate((held) => {
    const { threadView } = globalThis as unknown as { threadView: IThreadView };
    const root = document.getElementById('detail') as HTMLElement;

    root.replaceChildren(...threadView.threadViewOf(held, { client: 'Client 1' }));
    threadView.fitThreadLabels(root);
  }, call);
};

test.beforeAll(async () => {
  const [bundle, panel, system, skin] = await Promise.all([
    build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL('../thread.ts', import.meta.url))],
      format: 'iife',
      globalName: 'threadView',
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

test.describe('threadViewOf', () => {
  test('fits exchange labels inside their drawing and keeps the full words in a tooltip', async ({
    page,
  }) => {
    await drawCall(page, IDS.whoami);
    await expect(page.locator('#detail .thread text.words').first()).toBeVisible();

    const labels = await page.locator('#detail .thread text.words').evaluateAll((elements) => {
      return elements.map((element) => {
        const label = element as SVGTextElement;

        return {
          edge: (label.x.baseVal[0]?.value ?? 0) + label.getComputedTextLength(),
          title: label.querySelector('title')?.textContent,
          width: label.ownerSVGElement?.viewBox.baseVal.width ?? 0,
        };
      });
    });

    for (const label of labels) {
      expect(label.edge).toBeLessThanOrEqual(label.width);
      expect(label.title).toBeTruthy();
    }

    await expect(page.locator('#detail .thread text.words title').last()).toContainText(
      'announces a session'
    );
  });

  test('keeps an exchange’s labels clear of its lanes, its beads and its offsets on a relayed thread, leg A’s words 18 characters at least', async ({
    page,
  }) => {
    for (const [name, callId] of [
      ['increment', IDS.relayed],
      ['tally', IDS.slowRelay],
    ] as const) {
      await drawCall(page, callId);
      await expect(page.locator('#detail .thread svg')).toHaveAttribute(
        'aria-label',
        `The envelopes of call #${String(callId)}, in order`
      );

      const drawing = await page.locator('#detail .thread svg').evaluate((svg) => {
        const boxesOf = (selector: string) => {
          return [...svg.querySelectorAll<SVGGraphicsElement>(selector)].map((element) => {
            return { box: element.getBBox(), name: element.firstChild?.textContent ?? selector };
          });
        };
        const meets = (a: DOMRect, b: DOMRect): boolean => {
          return (
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height
          );
        };
        const lanes = boxesOf('line.life');
        const beads = boxesOf('circle');
        const offsets = boxesOf('text.offset');
        // a lane's name sits above its line, centred on it
        const labels = boxesOf('text.kind, text.words, text.note');

        return {
          collisions: [
            ...[...labels, ...offsets].flatMap((label) => {
              return lanes
                .filter((lane) => {
                  return meets(label.box, lane.box);
                })
                .map((lane) => {
                  return `${label.name} crosses the lane at ${String(lane.box.x)}`;
                });
            }),
            ...labels.flatMap((label) => {
              return [...beads, ...offsets]
                .filter((other) => {
                  return meets(label.box, other.box);
                })
                .map((other) => {
                  return `${label.name} meets ${other.name}`;
                });
            }),
          ],
          kinds: [...svg.querySelectorAll<SVGTextElement>('text.kind')].map((text) => {
            return {
              shown: text.firstChild?.textContent ?? '',
              whole: text.querySelector('title')?.textContent,
            };
          }),
          words: [...svg.querySelectorAll<SVGTextElement>('text.words')].map((text) => {
            return {
              shown: text.firstChild?.textContent ?? '',
              whole: text.querySelector('title')?.textContent ?? '',
            };
          }),
        };
      });

      expect(drawing.collisions).toEqual([]);

      for (const { shown, whole } of drawing.kinds) {
        if (shown.endsWith('…')) {
          expect(whole?.startsWith(shown.slice(0, -1))).toBe(true);
        }
      }

      if (name === 'tally') {
        expect(
          drawing.kinds.map(({ shown, whole }) => {
            return whole ?? shown;
          })
        ).toContain('NOTIFICATION');
      }

      for (const { shown, whole } of drawing.words) {
        expect(shown.endsWith('…') ? shown.length - 1 : shown.length).toBeGreaterThanOrEqual(
          Math.min(18, whole.length)
        );
      }
    }

    await expect(page.locator('#detail .thread text.words title').last()).toHaveText(
      '"an answer longer than the room its lanes leave"'
    );
  });
});

test.describe('fitThreadLabels', () => {
  test('keeps a label whole when its text fits its room', async ({ page }) => {
    const whole = 'a label that fits';

    await page.evaluate((text) => {
      const root = document.getElementById('detail') as HTMLElement;

      root.innerHTML =
        '<div class="thread"><svg><text class="words" x="0" y="20"></text></svg></div>';

      const label = root.querySelector('text') as SVGTextElement;
      const { threadView } = globalThis as unknown as { threadView: IThreadView };

      label.textContent = text;
      label.dataset['room'] = String(label.getComputedTextLength() + 1);
      threadView.fitThreadLabels(root);
    }, whole);

    await expect(page.locator('text.words')).toHaveText(whole);
    await expect(page.locator('text.words title')).toHaveCount(0);
  });

  test('cuts a label at its room and keeps its full text in a title', async ({ page }) => {
    const whole = 'an answer longer than the room its lanes leave';

    const shown = await page.evaluate((text) => {
      const root = document.getElementById('detail') as HTMLElement;

      root.innerHTML =
        '<div class="thread"><svg><text class="words" x="0" y="20"></text></svg></div>';

      const label = root.querySelector('text') as SVGTextElement;
      const { threadView } = globalThis as unknown as { threadView: IThreadView };

      label.textContent = text;

      const room = label.getComputedTextLength() / 2;

      label.dataset['room'] = String(room);
      threadView.fitThreadLabels(root);

      return {
        room,
        text: label.firstChild?.textContent ?? '',
        width: label.getComputedTextLength(),
      };
    }, whole);

    expect(shown.text.endsWith('…')).toBe(true);
    expect(shown.text.length).toBeLessThan(whole.length);
    expect(whole.startsWith(shown.text.slice(0, -1))).toBe(true);
    expect(shown.width).toBeLessThanOrEqual(shown.room);
    await expect(page.locator('text.words title')).toHaveText(whole);
  });
});
