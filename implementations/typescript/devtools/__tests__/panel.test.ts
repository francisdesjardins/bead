import { expect, test, type Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvelopeKind } from '../../src/router/shared/constants';
import { writeEnvelope } from '../../src/router/shared/envelope';
import type { BackgroundMessage } from '../messages';
import { assertBuilt, EXTENSION } from './fixtures';
import { IDS, SLOW_RELAY, T0, TRAFFIC } from './traffic';

// interfaces

/** What the fake DevTools API keeps, on the panel's page. */
interface IFake {
  deliver: (message: BackgroundMessage) => void;
  finish: (entry: object) => void;
  opened: [url: string, line: number][];
  posted: unknown[];
  reloads: number;
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
      opened: [],
      posted: [],
      reloads: 0,
    };

    Object.assign(globalThis, {
      chrome: {
        devtools: {
          inspectedWindow: {
            reload: () => {
              fake.reloads += 1;
            },
            tabId: 7,
          },
          network: { onRequestFinished: eventOf(listeners.finished) },
          panels: {
            create: () => {},
            openResource: (url: string, line: number) => {
              fake.opened.push([url, line]);
            },
            themeName: 'dark',
          },
        },
        runtime: {
          connect: ({ name }: { name: string }) => {
            return {
              disconnect: () => {},
              name,
              onDisconnect: eventOf(listeners.disconnect),
              onMessage: eventOf(listeners.message),
              postMessage: (message: unknown) => {
                fake.posted.push(message);
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

const fakeOf = (page: Page): Promise<IFake> => {
  return page.evaluate(() => {
    const { fake } = globalThis as unknown as { fake: IFake };

    return { ...fake, deliver: undefined, finish: undefined } as unknown as IFake;
  });
};

/** The panel, its page connected, a client announced, and the traffic heard. */
const openWithTraffic = async (page: Page): Promise<void> => {
  await openPanel(page);
  await deliver(page, { type: 'page-connected' });
  await deliver(page, { sources: [{ id: 1, protocol: 1, side: 'client' }], type: 'sources' });
  await deliver(page, { dropped: 0, records: [...TRAFFIC], type: 'records' });
};

const rowOf = (page: Page, name: string) => {
  return page.locator('#calls tr.call', { hasText: name });
};

/** What tells a tab's state apart: its text's colour, its tint and its underline. */
const lookOf = (page: Page, selector: string) => {
  return page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);

    return { color: style.color, tint: style.backgroundColor, underline: style.borderBottomColor };
  });
};

/** Where a focused element's outline falls: inside its box when its offset takes its width back. */
const outlineOf = (page: Page, selector: string) => {
  return page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      isFocusVisible: element.matches(':focus-visible'),
      isInside: Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth) <= 0,
      style: style.outlineStyle,
    };
  });
};

/** Where the detail sits against the list, and each side's size along the split, in pixels. */
const splitOf = (page: Page) => {
  return page.evaluate(() => {
    const list = document.getElementById('list')?.getBoundingClientRect();
    const detail = document.querySelector('.detail')?.getBoundingClientRect();

    if (list === undefined || detail === undefined) {
      return { detail: 0, list: 0, placement: 'none' };
    }

    const isRight = detail.left >= list.right;

    return {
      detail: isRight ? detail.width : detail.height,
      list: isRight ? list.width : list.height,
      placement: isRight ? 'right' : detail.top >= list.bottom ? 'bottom' : 'none',
    };
  });
};

const placementOf = async (page: Page): Promise<string> => {
  return (await splitOf(page)).placement;
};

/** The splitter's value and its limits, as its ARIA attributes say. */
const splitterOf = (page: Page) => {
  return page.locator('#splitter').evaluate((splitter) => {
    return {
      max: Number(splitter.getAttribute('aria-valuemax')),
      min: Number(splitter.getAttribute('aria-valuemin')),
      now: Number(splitter.getAttribute('aria-valuenow')),
      orientation: splitter.getAttribute('aria-orientation'),
    };
  });
};

/** Bytes as text whose every character is one of them, as DevTools may give a request's body. */
const latin1Of = (bytes: Uint8Array): string => {
  return String.fromCharCode(...bytes);
};

// definition

test.describe('the panel', () => {
  test('defines every custom property its styles and its views draw with, on penumbra’s sheets or its own skin', async () => {
    const devtools = new URL('../', import.meta.url);
    const read = (path: string): Promise<string> => {
      return readFile(new URL(path, devtools), 'utf8');
    };
    const views = (await readdir(new URL('views/', devtools))).filter((name) => {
      return name.endsWith('.ts');
    });
    const sheets = await Promise.all(
      ['panel.html', 'penumbra/tokens.system.css', 'penumbra/tokens.skin.base.css'].map(read)
    );
    const scripts = await Promise.all(
      [
        'panel.ts',
        ...views.map((name) => {
          return `views/${name}`;
        }),
      ].map(read)
    );
    const defined = new Set(
      sheets.flatMap((text) => {
        return [...text.matchAll(/(--[\w-]+)\s*:/gu)].map(([, name]) => {
          return name;
        });
      })
    );
    const undefinedOnes = [...sheets, ...scripts]
      .flatMap((text) => {
        return [...text.matchAll(/var\((--[\w-]+)/gu)].map(([, name]) => {
          return name;
        });
      })
      .filter((name) => {
        return !defined.has(name);
      });

    expect([...new Set(undefinedOnes)]).toEqual([]);
  });

  test('greets the background with its tab, follows DevTools’ theme, and reads the registries as its Metrics view opens', async ({
    page,
  }) => {
    await openPanel(page);

    expect((await fakeOf(page)).posted).toEqual([{ tabId: 7, type: 'panel' }]);
    expect(
      await page.evaluate(() => {
        return document.documentElement.dataset['colorScheme'];
      })
    ).toBe('dark');

    await page.click('[data-tab="metrics"]');
    await expect
      .poll(async () => {
        return (await fakeOf(page)).posted;
      })
      .toContainEqual({ type: 'read-expositions' });
  });

  test('says why it shows nothing yet, and reloads the page it inspects', async ({ page }) => {
    await openPanel(page);

    await expect(page.locator('#empty')).toContainText('No Bead client on this page yet.');
    await expect(page.locator('#empty')).toContainText('devtools: false');
    await page.click('#empty button');
    expect((await fakeOf(page)).reloads).toBe(1);
  });

  test('opens filter syntax without changing the filter, dismisses it, and keeps it inside a narrow panel', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 600, width: 400 });
    await openWithTraffic(page);
    await page.fill('#filter', 'whoami');

    const button = page.getByRole('button', { name: 'Filter syntax' });
    const help = page.locator('#filter-help');

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(help).toBeVisible();
    await expect(help).toContainText('d(rx)');
    await expect(page.locator('#filter')).toHaveValue('whoami');
    await expect(rowOf(page, 'whoami')).toBeVisible();

    const box = await help.boundingBox();

    expect(box).not.toBeNull();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(400);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(600);

    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
    await button.click();
    await page.keyboard.press('/');
    await expect(help).toBeHidden();
    await expect(page.locator('#filter')).toBeFocused();
    await button.click();
    await page.locator('#filter').click();
    await expect(help).toBeHidden();
    await button.click();
    await page.locator('#filter').focus();
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
    await expect(page.locator('#filter')).toBeFocused();
    await expect(page.locator('#filter')).toHaveValue('whoami');
  });

  test('keeps a hovered tab apart from the selected one, and the selected one as it is under the mouse', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await rowOf(page, 'whoami').click();

    for (const [selected, other] of [
      ['[data-tab="calls"]', '[data-tab="state"]'],
      ['[data-detail="overview"]', '[data-detail="payload"]'],
    ] as const) {
      await page.mouse.move(0, 0);

      const atRest = await lookOf(page, selected);

      await page.hover(other);

      const hovered = await lookOf(page, other);

      expect({ tint: hovered.tint, underline: hovered.underline }).not.toEqual({
        tint: atRest.tint,
        underline: atRest.underline,
      });
      await page.hover(selected);
      expect(await lookOf(page, selected)).toEqual(atRest);
    }
  });

  test('draws the focus ring of the list and of the detail inside them, where their scrolling keeps it', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await rowOf(page, 'whoami').click();

    await page.locator('[data-tab="calls"]').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#list')).toBeFocused();
    expect(await outlineOf(page, '#list')).toEqual({
      isFocusVisible: true,
      isInside: true,
      style: 'solid',
    });

    await page.locator('[data-detail="overview"]').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#detail')).toBeFocused();
    expect(await outlineOf(page, '#detail')).toEqual({
      isFocusVisible: true,
      isInside: true,
      style: 'solid',
    });
  });

  test('places its detail right of the list or under it as the panel’s shape says, and where its Detail choice says', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openWithTraffic(page);

    await expect(page.getByRole('combobox', { name: 'Detail' })).toHaveValue('auto');
    await expect
      .poll(() => {
        return placementOf(page);
      })
      .toBe('right');
    expect((await splitterOf(page)).orientation).toBe('vertical');

    await page.setViewportSize({ height: 900, width: 600 });
    await expect
      .poll(() => {
        return placementOf(page);
      })
      .toBe('bottom');
    expect((await splitterOf(page)).orientation).toBe('horizontal');

    await page.setViewportSize({ height: 500, width: 700 });
    await expect
      .poll(() => {
        return placementOf(page);
      })
      .toBe('bottom');

    await page.getByRole('combobox', { name: 'Detail' }).selectOption('right');
    await expect
      .poll(() => {
        return placementOf(page);
      })
      .toBe('right');

    await page.setViewportSize({ height: 800, width: 1280 });
    await page.getByRole('combobox', { name: 'Detail' }).selectOption('bottom');
    await expect
      .poll(() => {
        return placementOf(page);
      })
      .toBe('bottom');
  });

  test('moves its splitter by keyboard and by pointer, within the least each side keeps', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openWithTraffic(page);

    const splitter = page.getByRole('separator', { name: 'Size of the list and the detail' });

    await expect(splitter).toHaveAttribute('aria-valuenow', '60');
    await splitter.focus();
    await page.keyboard.press('ArrowRight');
    await expect(splitter).toHaveAttribute('aria-valuenow', '65');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(splitter).toHaveAttribute('aria-valuenow', '55');

    await page.keyboard.press('Home');

    const atLeast = await splitterOf(page);

    expect(atLeast.now).toBe(atLeast.min);
    expect((await splitOf(page)).list).toBeGreaterThanOrEqual(240);
    expect((await splitOf(page)).list).toBeLessThan(240 + 13);

    await page.keyboard.press('End');

    const atMost = await splitterOf(page);

    expect(atMost.now).toBe(atMost.max);
    expect((await splitOf(page)).detail).toBeGreaterThanOrEqual(260);
    await page.keyboard.press('Enter');
    await expect(splitter).toHaveAttribute('aria-valuenow', '60');

    const box = await splitter.boundingBox();

    if (box === null) {
      throw new Error('the splitter has no box');
    }

    await page.mouse.move(box.x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(400, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(Math.abs((await splitOf(page)).list - 400)).toBeLessThan(3);

    await page.mouse.move(400, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(1270, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();

    const dragged = await splitterOf(page);

    expect(dragged.now).toBe(dragged.max);
    expect((await splitOf(page)).detail).toBeGreaterThanOrEqual(260);

    await page.getByRole('combobox', { name: 'Detail' }).selectOption('bottom');
    await splitter.focus();
    await page.keyboard.press('ArrowRight');
    await expect(splitter).toHaveAttribute('aria-valuenow', '60');
    await page.keyboard.press('ArrowDown');
    await expect(splitter).toHaveAttribute('aria-valuenow', '65');
  });

  test('keeps its layout and each placement’s split across a reload of its page', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openPanel(page);

    const splitter = page.locator('#splitter');

    await splitter.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(splitter).toHaveAttribute('aria-valuenow', '50');
    await page.getByRole('combobox', { name: 'Detail' }).selectOption('bottom');
    await splitter.focus();
    await page.keyboard.press('ArrowDown');
    await expect(splitter).toHaveAttribute('aria-valuenow', '65');

    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Detail' })).toHaveValue('bottom');
    await expect
      .poll(() => {
        return placementOf(page);
      })
      .toBe('bottom');
    await expect(splitter).toHaveAttribute('aria-valuenow', '65');
    await page.getByRole('combobox', { name: 'Detail' }).selectOption('right');
    await expect(splitter).toHaveAttribute('aria-valuenow', '50');
  });

  test('keeps its defaults, and its choices for the page’s life, when its storage refuses', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new DOMException('refused', 'SecurityError');
        },
      });
    });
    await page.setViewportSize({ height: 800, width: 1280 });
    await openPanel(page);

    const splitter = page.locator('#splitter');

    await expect(page.getByRole('combobox', { name: 'Detail' })).toHaveValue('auto');
    await expect(splitter).toHaveAttribute('aria-valuenow', '60');
    await page.getByRole('combobox', { name: 'Detail' }).selectOption('bottom');
    await expect
      .poll(() => {
        return placementOf(page);
      })
      .toBe('bottom');
    await splitter.focus();
    await page.keyboard.press('ArrowDown');
    await expect(splitter).toHaveAttribute('aria-valuenow', '65');

    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Detail' })).toHaveValue('auto');
    await expect
      .poll(() => {
        return placementOf(page);
      })
      .toBe('right');
    await expect(splitter).toHaveAttribute('aria-valuenow', '60');
  });

  test('moves between views and detail tabs with arrows and Home and End, keeping one tab stop in each', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await rowOf(page, 'whoami').click();
    await page.locator('[data-tab="calls"]').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-tab="wire"]')).toBeFocused();
    await expect(page.locator('[data-view="wire"]')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-tab="calls"]')).toBeFocused();
    await expect(page.locator('[data-view="calls"]')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.locator('[data-tab="wire"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.locator('[data-tab="calls"]')).toBeFocused();
    await expect(page.locator('.tabs [tabindex="0"]')).toHaveCount(1);

    await page.locator('[data-detail="overview"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-detail="payload"]')).toBeFocused();
    await expect(page.locator('#detail .tree')).toBeVisible();
    await expect(page.locator('#detail')).toHaveAttribute('aria-labelledby', 'payload-tab');
    await page.keyboard.press('End');
    await expect(page.locator('[data-detail="trace"]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-detail="overview"]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Home');
    await expect(page.locator('[data-detail="overview"]')).toBeFocused();
    await expect(page.locator('.detail-tabs [tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(page.locator('#detail')).toBeFocused();
  });

  test('filters by client through the styled select, including a client with no calls', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await deliver(page, {
      sources: [
        { id: 1, protocol: 1, side: 'client' },
        { id: 2, protocol: 1, side: 'client' },
      ],
      type: 'sources',
    });
    await page.locator('#source').selectOption('2');
    await expect(page.locator('#calls tr.call')).toHaveCount(0);
    await page.locator('#source').selectOption('1');
    await expect(page.locator('#calls tr.call')).toHaveCount(10);
    await page.locator('#source').selectOption('all');
    await expect(page.locator('#calls tr.call')).toHaveCount(10);
  });

  test('fits exchange labels inside their drawing and keeps the full words in a tooltip', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await rowOf(page, 'whoami').click();
    await page.click('[data-detail="exchange"]');
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
    await openWithTraffic(page);
    await deliver(page, { dropped: 0, records: [...SLOW_RELAY], type: 'records' });
    await rowOf(page, 'increment').click();
    await page.click('[data-detail="exchange"]');

    for (const name of ['increment', 'tally']) {
      await rowOf(page, name).click();
      await expect(page.locator('#detail .thread circle').first()).toBeVisible();

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
          words: [...svg.querySelectorAll<SVGTextElement>('text.words')].map((text) => {
            return {
              shown: text.firstChild?.textContent ?? '',
              whole: text.querySelector('title')?.textContent ?? '',
            };
          }),
        };
      });

      expect(drawing.collisions).toEqual([]);

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

  test('shows a call a row, newest first, its outcome in words, a command read the right way round', async ({
    page,
  }) => {
    await openWithTraffic(page);

    await expect(page.locator('#status')).toHaveText('connected to the page');
    await expect(page.locator('#source option')).toHaveText(['All clients', 'Client 1']);
    await expect(page.locator('#calls tr.call')).toHaveCount(10);
    await expect(page.locator('#calls tr.call').first()).toContainText('stats');
    await expect(rowOf(page, 'increment')).toContainText('ACCESS_DENIED, beyond 1 relay');
    await expect(rowOf(page, 'increment')).toContainText('→ dest 7');
    await expect(rowOf(page, 'slow')).toContainText('cancelled');
    await expect(rowOf(page, 'counter')).toContainText('2 heard · ended by the server');
    await expect(rowOf(page, 'clock')).toContainText('command, in');
    await expect(rowOf(page, 'clock')).toContainText('"14:03:13"');
    await expect(rowOf(page, 'download')).toContainText('↓ 2.5 MiB');
    await expect(page.locator('#footer')).toContainText('10 calls');
    await expect(page.locator('#footer')).toContainText('3 failed');
  });

  test('unfolds a call into its envelopes in words, and lists every envelope in its Envelopes mode', async ({
    page,
  }) => {
    await openWithTraffic(page);

    await rowOf(page, 'download').locator('[data-twist]').click();
    await expect(page.locator('#calls tr.envelope')).toHaveText([
      /→ REQUEST/,
      /← RESULT · opens a transfer of 2\.5 MiB/,
      /→ CREDIT · up to 2\.5 MiB/,
      /← CHUNK · at 1 MiB · more/,
      /← CHUNK · at 2 MiB · last/,
    ]);

    await page.click('[data-mode="envelopes"]');
    await expect(page.locator('#envelopes tr')).toHaveCount(25);
    await page.fill('#filter', 'e(credit)');
    await expect(page.locator('#envelopes tr')).toHaveCount(3);
  });

  test('keeps the call whose envelope was clicked selected in the Envelopes mode, each of its envelopes marked', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await page.click('[data-mode="envelopes"]');
    await page.locator('#envelopes tr', { hasText: 'download' }).last().click();

    const selected = page.locator('#envelopes tr[aria-selected="true"]');
    const backgroundOf = (row: ReturnType<Page['locator']>): Promise<string> => {
      return row
        .locator('td')
        .first()
        .evaluate((cell) => {
          return getComputedStyle(cell).backgroundColor;
        });
    };

    await expect(selected).toHaveCount(5);
    await expect(selected).toContainText(
      Array.from({ length: 5 }, () => {
        return 'download';
      })
    );
    expect(await backgroundOf(selected.first())).not.toBe(
      await backgroundOf(page.locator('#envelopes tr[aria-selected="false"]').first())
    );
  });

  test('filters as the package’s filter does, keeps the last filter that held when one is refused, and says why', async ({
    page,
  }) => {
    await openWithTraffic(page);

    await page.click('[data-quick="t(command)"]');
    await expect(page.locator('#filter')).toHaveValue('t(command)');
    await expect(page.locator('#calls tr.call')).toHaveCount(1);
    await expect(page.locator('#calls tr.call')).toContainText('#2');

    await page.fill('#filter', 'd(up)');
    await expect(page.locator('#filter')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#filter-state')).toContainText('not "up"');
    await expect(page.locator('#calls tr.call')).toHaveCount(1);

    await page.fill('#filter', '');
    await page.click('[data-quick="failed"]');
    await expect(page.locator('#calls tr.call')).toHaveCount(3);
  });

  test('lets a selection go, with a word, once the filter hides it', async ({ page }) => {
    await openWithTraffic(page);

    await rowOf(page, 'whoami').click();
    await expect(page.locator('#detail')).toContainText('#3');
    await page.fill('#filter', '-whoami');
    await expect(page.locator('#detail')).toContainText(
      'The call selected is hidden by the filter'
    );
  });

  test('details a call: its overview, its payload as a tree, its thread, what changed, and the stack that made it', async ({
    page,
  }) => {
    await openWithTraffic(page);

    await rowOf(page, 'increment').click();
    await expect(page.locator('#detail')).toContainText('raised beyond 1 relay, for destination 7');
    await page.click('[data-detail="exchange"]');
    await expect(page.locator('#detail .thread circle')).toHaveCount(2);
    await expect(page.locator('#detail .thread')).toContainText('not seen from the page');

    await rowOf(page, 'whoami').click();
    await page.click('[data-detail="payload"]');
    await expect(page.locator('#detail .tree')).toContainText('"role": "writer"');
    await page.click('[data-detail="trace"]');
    await expect(page.locator('#detail .frames').first()).toContainText('onWhoami');
    await page.locator('#detail .frames button', { hasText: 'src/page.ts:42:7' }).click();
    expect((await fakeOf(page)).opened).toEqual([['http://localhost:5173/src/page.ts', 41]]);

    await rowOf(page, 'counter').click();
    await page.click('[data-detail="diff"]');
    await expect(page.locator('#detail .diff .added').first()).toHaveText('+   "value": 47');
  });

  test('rebuilds the state at a moment the cursor stands on, replaying nothing', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await page.click('[data-tab="state"]');

    await expect(page.locator('#state')).toContainText('a session, OPAQUE, announced by whoami #3');
    await expect(page.locator('#state')).toContainText('ended by the server');

    await page.locator('#at').evaluate((range: HTMLInputElement, at) => {
      range.focus();
      range.value = String(at);
      range.dispatchEvent(new Event('input'));
    }, T0 + 1_430);
    await expect(page.locator('#state .sect').nth(1)).toContainText(
      `download #${String(IDS.download)}`
    );
    await expect(page.locator('#state .sect').nth(2)).toContainText('open');
    await expect(page.locator('#live')).toHaveAttribute('aria-pressed', 'false');
  });

  test('draws every call on a time axis, and bounds the list to the span dragged across it', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await page.click('[data-tab="timeline"]');

    await expect(page.locator('#timeline .hit')).toHaveCount(10);

    const box = await page.locator('#timeline svg').boundingBox();

    if (box === null) {
      throw new Error('the timeline has no box');
    }

    await page.mouse.move(box.x + box.width * 0.8, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.99, box.y + 40, { steps: 4 });
    await page.mouse.up();
    await page.click('[data-tab="calls"]');
    await expect(page.locator('#range .chip')).toBeVisible();
    await expect(page.locator('#calls tr.call')).not.toHaveCount(10);
    await page.click('#range .chip');
    await expect(page.locator('#calls tr.call')).toHaveCount(10);
  });

  test('marks the records let go where they were, and keeps the page’s state apart from them', async ({
    page,
  }) => {
    await openWithTraffic(page);
    await deliver(page, { dropped: 1_834, records: [], type: 'records' });

    await expect(page.locator('#calls tr.marker.gap')).toContainText('1,834 records let go here');
    await expect(page.locator('#footer')).toContainText('1,834 records let go');
    await expect(page.locator('#status')).toHaveText('connected to the page');

    await deliver(page, { type: 'page-gone' });
    await expect(page.locator('#status')).toHaveText(
      'the page is gone: its calls stay until you clear them'
    );
    await expect(page.locator('#calls tr.call')).toHaveCount(10);
    await deliver(page, { type: 'page-connected' });
    await expect(page.locator('#calls tr.call')).toHaveCount(0);
  });

  test('pauses, preserves its log across a reload, and exports its records and imports them back', async ({
    page,
  }) => {
    await openWithTraffic(page);

    await page.check('#preserve');
    await deliver(page, { type: 'page-gone' });
    await deliver(page, { type: 'page-connected' });
    await expect(page.locator('#calls tr.marker.reload')).toContainText('Page reloaded');
    await expect(page.locator('#calls tr.call')).toHaveCount(10);

    await page.keyboard.press('Control+e');
    await expect(page.locator('#record')).toHaveAttribute('aria-pressed', 'false');
    await deliver(page, { dropped: 0, records: TRAFFIC.slice(0, 4), type: 'records' });
    await expect(page.locator('#footer')).toContainText('paused: 4 records not recorded');
    await expect(page.locator('#calls tr.call')).toHaveCount(10);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    const saved = await download.path();
    const log = JSON.parse(await readFile(saved, 'utf8')) as { format: string; records: unknown[] };

    expect(log.format).toBe('bead-devtools-log');
    expect(log.records).toHaveLength(TRAFFIC.length);

    await page.keyboard.press('Control+l');
    await expect(page.locator('#calls tr.call')).toHaveCount(0);
    await page.locator('#import-file').setInputFiles(saved);
    await expect(page.locator('#calls tr.call')).toHaveCount(10);
    await expect(page.locator('#toast')).toContainText('Imported 46 records');
  });

  test('answers to the keyboard and to a context menu, and copies a call as code', async ({
    page,
  }) => {
    await openWithTraffic(page);

    await rowOf(page, 'stats').click();
    await page.keyboard.press('ArrowDown');
    await expect(rowOf(page, 'read')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(rowOf(page, 'read').locator('[data-twist]')).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    await rowOf(page, 'increment').click({ button: 'right' });
    await expect(page.locator('#menu')).toBeVisible();
    await page.locator('#menu button', { hasText: 'Hide increment' }).click();
    await expect(page.locator('#filter')).toHaveValue('-increment');
    await expect(page.locator('#calls tr.call')).toHaveCount(9);

    await rowOf(page, 'whoami').click({ button: 'right' });
    await page.locator('#menu button', { hasText: 'Copy as code' }).click();
    await expect(page.locator('#toast')).toHaveText('Copied');

    await page.keyboard.press('/');
    await expect(page.locator('#filter')).toBeFocused();
  });

  test('shows what a registry counts and its calls a second, and says when a client was given none', async ({
    page,
  }) => {
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

    await expect(page.locator('#metrics tr[data-procedure="read"]')).toContainText('made');
    await expect(page.locator('#metrics tr[data-procedure="read"] .spark')).toBeVisible();
    await expect(page.locator('#metrics .chip.failure')).toHaveText('1 SESSION_REQUIRED');
    await expect(page.locator('#metrics')).toContainText(
      'This client was given no metrics registry'
    );

    await page.locator('#metrics tr[data-procedure="read"] button').click();
    await expect(page.locator('[data-tab="calls"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#filter')).toHaveValue('read');
  });

  test('reads the HTTP transport’s exchanges from the Network panel’s entries, with the package’s codec, names learned from calls', async ({
    page,
  }) => {
    const request = writeEnvelope({
      header: { callId: 1, kind: EnvelopeKind.REQUEST, procedureId: 12, serviceId: 1 },
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

    await openWithTraffic(page);
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
          getContent: (callback: (content: string, encoding: string) => void) => {
            callback('', 'base64');
          },
          request: { method: 'POST', url: 'http://localhost:8080/bead' },
          response: { content: { mimeType: 'application/prs.bead' }, status: 200 },
          startedDateTime: '2026-10-04T12:00:01.000Z',
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

    await expect(page.locator('#wire .exchange')).toHaveCount(2);
    await expect(page.locator('#wire .request-line').first()).toHaveText('POST /bead');
    await expect(page.locator('#wire .exchange').first()).toContainText('nothing: a listen');
    await expect(page.locator('#wire .exchange').last()).toContainText(
      '→ REQUEST · #1 · token · 5 bytes'
    );
    await expect(page.locator('#wire .exchange').last()).toContainText('← RESULT · #1 · 2 bytes');
    await page
      .locator('#wire .exchange')
      .last()
      .locator('button', { hasText: 'Copy as conversation' })
      .click();
    await expect(page.locator('#toast')).toHaveText('Copied');
  });
});
