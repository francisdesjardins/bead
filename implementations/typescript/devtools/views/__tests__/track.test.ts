import { expect, test } from '@playwright/test';
import { EnvelopeKind } from '../../../src/router/shared/constants';
import type { IEnvelopeRecord } from '../../messages';
import type { ICall } from '../../model/calls';
import type { callRowsOf } from '../calls';
import type { replaceKeeping } from '../dom';
import type { timelineViewOf } from '../timeline';
import type { trackOf } from '../track';
import { loadView } from './page';

// calls of a second's span, each answered `duration` ms after it started
const T0 = 1_760_000_000_000;

const envelopeOf = (at: number, kind: number): IEnvelopeRecord => {
  return {
    at: T0 + at,
    connectionHandle: 'server',
    direction: 'rx',
    header: { kind },
    kind: 'envelope',
    source: 1,
  };
};

const callOf = (
  key: number,
  { at, duration, envelopes = [] }: { at: number; duration: number; envelopes?: IEnvelopeRecord[] }
): ICall => {
  const step = {
    callId: key,
    direction: 'tx',
    kind: 'call' as const,
    procedureId: key,
    procedureName: `call${String(key)}`,
    serviceId: 1,
    serviceRevision: 1,
    source: 1,
    startedAt: T0 + at,
    type: 'request',
  };

  return {
    answer: { ...step, direction: 'rx', duration },
    callId: key,
    envelopes,
    envelopesLetGo: 0,
    isIncoming: false,
    isNotification: false,
    key,
    notifications: [],
    notificationsLetGo: 0,
    opening: step,
    procedureId: key,
    procedureName: step.procedureName,
    serviceId: 1,
    source: 1,
  };
};

interface IView {
  callRowsOf: typeof callRowsOf;
  replaceKeeping: typeof replaceKeeping;
  timelineViewOf: typeof timelineViewOf;
  trackOf: typeof trackOf;
}

test('marks a call narrower than 6 px as an instant, on the Timeline and in the waterfall', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_600, height: 600 });
  await loadView(page, ['calls', 'timeline', 'track'], { scheme: 'light' });
  const calls = [
    callOf(1, { at: 100, duration: 4 }),
    callOf(2, { at: 300, duration: 400 }),
    // * long, but begun before the span and cut by it to a sliver: no instant
    callOf(3, { at: -2_000, duration: 2_002 }),
  ];
  const marks = await page.evaluate(
    ({ calls: drawn, from }) => {
      const { view } = globalThis as unknown as { view: IView };
      const span = { from, to: from + 1_000 };
      const timeline = document.getElementById('timeline') as HTMLElement;
      const list = document.getElementById('calls') as HTMLElement;
      const nameOf = (call: ICall): string => {
        return call.procedureName ?? '';
      };

      timeline.hidden = false;
      view.replaceKeeping(
        timeline,
        view.timelineViewOf({
          calls: drawn,
          isAllClients: false,
          nameOf,
          now: from + 1_000,
          onOpen: () => {},
          onRange: () => {},
          onSelect: () => {},
          range: undefined,
          selected: undefined,
          span,
        })
      );
      view.replaceKeeping(
        list,
        view.callRowsOf({
          calls: drawn,
          expanded: new Set(),
          isAllClients: false,
          markers: [],
          nameOf,
          now: from + 1_000,
          selected: undefined,
          span,
        })
      );

      return [timeline, list].map((root) => {
        return [1, 2, 3].map((key) => {
          const track = root.querySelector(`tr[data-key="${String(key)}"] .wf`) as HTMLElement;
          const bar = track.querySelector('.extent') as HTMLElement;
          const instant = track.querySelector('.instant');
          const box = instant?.getBoundingClientRect();
          const visible = instant?.checkVisibility() === true;

          return {
            isInstant: visible,
            ...(visible && box !== undefined
              ? {
                  width: Math.round(box.width),
                  height: Math.round(box.height),
                  centre: Math.round(box.left + box.width / 2 - bar.getBoundingClientRect().left),
                }
              : {}),
          };
        });
      });
    },
    { calls, from: T0 }
  );

  const [timeline, waterfall] = marks;
  const instant = { isInstant: true, width: 7, height: 10, centre: 0 };

  expect(timeline).toEqual([instant, { isInstant: false }, { isInstant: false }]);
  expect(waterfall).toEqual([instant, { isInstant: false }, { isInstant: false }]);
});

test('merges the ticks that fall in one percent of the track', async ({ page }) => {
  await loadView(page, 'track');
  // 501 chunks over 50 ms of a 1,000 ms span: from 10 % of the track to 15 %
  const chunks = Array.from({ length: 501 }, (_, index) => {
    return envelopeOf(100 + index / 10, EnvelopeKind.CHUNK);
  });
  const call = {
    ...callOf(1, {
      at: 90,
      duration: 100,
      // a credit past the span's end is left out, not piled at its edge
      envelopes: [...chunks, envelopeOf(1_200, EnvelopeKind.CREDIT)],
    }),
    notifications: Array.from({ length: 40 }, (_, index) => {
      return { at: T0 + 500 + index * 2.5 };
    }),
  };
  const places = await page.evaluate(
    ({ drawn, from }) => {
      const { view } = globalThis as unknown as { view: IView };
      const track = view.trackOf(drawn, { from, to: from + 1_000 }, { now: from + 1_000 });
      const lefts = (selector: string): number[] => {
        return [...track.querySelectorAll<HTMLElement>(selector)].map((mark) => {
          return Number.parseFloat(mark.style.left);
        });
      };

      return { rings: lefts('.ring'), ticks: lefts('.tick') };
    },
    { drawn: call, from: T0 }
  );

  expect(places.ticks).toEqual([10, 11, 12, 13, 14, 15]);
  expect(places.rings).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
});
