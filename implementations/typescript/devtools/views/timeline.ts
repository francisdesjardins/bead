// ── The Timeline view ─────────────────────────────────────────────────────────

// Every call shown, on one axis of time, in SVG with nothing to load: a row a call, in the order
// they started, its bar from its start to its end, a subscription a line with a ring a
// notification, a tick for each chunk, credit or cancel; a bubble on hover. Dragging across it
// bounds the Calls list to that span, as a brush does.

// dependencies

import { EnvelopeKind } from '../../src/router/shared/constants';
import type { ICall } from '../model/calls';
import { endOf, outcomeOf, startOf, statusOf } from '../model/facts';
import { type ISpan, scaleOf, ticksOf } from '../model/scale';
import { clockOf, spanOf } from '../model/words';
import { callLabelOf, durationWordsOf, typeWordsOf } from './calls';
import { currentOf, listen, make, svgOf } from './dom';

// interfaces

/** What the Timeline draws. */
export interface ITimelineView {
  calls: readonly ICall[];
  isAllClients: boolean;
  nameOf: (call: ICall) => string;
  now: number;
  /** Bounds the Calls list to a span, or lets it be whole again. */
  onRange: (range: ISpan | undefined) => void;
  /** The span the Calls list is bounded to, if any. */
  range: ISpan | undefined;
  span: ISpan | undefined;
}

// constants

const WIDTH = 1_000;
const LEFT = 170;
const RIGHT = 16;
const ROW = 20;
const TOP = 22;

/** The rows drawn at most: the last calls. */
export const TIMELINE_ROWS = 300;

const TICKED = Object.freeze<number[]>([
  EnvelopeKind.CHUNK,
  EnvelopeKind.CREDIT,
  EnvelopeKind.CANCEL,
]);

const FILLS = Object.freeze({
  answered: 'var(--app-info)',
  closed: 'var(--app-text-secondary)',
  ended: 'none',
  failed: 'var(--app-error)',
  flight: 'var(--app-info-wash)',
  heard: 'var(--app-info)',
  open: 'var(--app-text-secondary)',
});

// definition

/** The Timeline, its legend and its brush. */
export const timelineViewOf = (view: ITimelineView): Node[] => {
  const { calls, nameOf, span } = view;

  if (span === undefined) {
    return [make('p', { className: 'note', text: 'No call yet.' })];
  }

  const shown = calls.slice(-TIMELINE_ROWS);
  const height = TOP + shown.length * ROW + 8;
  const scale = scaleOf(span, { left: LEFT, right: WIDTH - RIGHT });
  const parts: SVGElement[] = ticksOf(span).flatMap((tick) => {
    const x = scale.xOf(span.from + tick);

    return [
      svgOf('line', { attributes: { class: 'grid', x1: x, x2: x, y1: TOP - 4, y2: height } }),
      svgOf('text', {
        attributes: { class: 'axis', 'text-anchor': 'middle', x, y: 12 },
        text: spanOf(tick),
      }),
    ];
  });

  shown.forEach((call, index) => {
    const y = TOP + index * ROW;
    const status = statusOf(call);
    const start = startOf(call);
    const end = endOf(call) ?? view.now;
    const isLine = status === 'open' || status === 'closed';
    const tip = [
      `${nameOf(call)} ${callLabelOf(call, view.isAllClients)} · ${typeWordsOf(call)}`,
      `started ${clockOf(start)}`,
      `${durationWordsOf(call, view.now)} · ${outcomeOf(call)}`,
    ].join('\n');

    parts.push(
      svgOf('text', { attributes: { class: 'row-name', x: 8, y: y + 13 }, text: nameOf(call) }),
      svgOf('text', {
        attributes: { class: 'row-id', 'text-anchor': 'end', x: LEFT - 8, y: y + 13 },
        text: callLabelOf(call, view.isAllClients),
      }),
      isLine
        ? svgOf('line', {
            attributes: {
              stroke: FILLS[status],
              'stroke-dasharray': status === 'closed' ? '3 2' : undefined,
              'stroke-width': 2,
              x1: scale.xOf(start),
              x2: scale.xOf(end),
              y1: y + 10,
              y2: y + 10,
            },
          })
        : svgOf('rect', {
            attributes: {
              fill: FILLS[status],
              height: 10,
              rx: 2,
              stroke:
                status === 'ended'
                  ? 'var(--ended)'
                  : status === 'flight'
                    ? 'var(--app-info)'
                    : undefined,
              'stroke-dasharray': status === 'ended' ? '3 2' : undefined,
              width: Math.max(scale.xOf(end) - scale.xOf(start), 2),
              x: scale.xOf(start),
              y: y + 5,
            },
          }),
      ...call.notifications.map(({ at }) => {
        return svgOf('circle', {
          attributes: {
            cx: scale.xOf(at),
            cy: y + 10,
            fill: 'var(--app-paper)',
            r: 3,
            stroke: 'var(--app-text)',
            'stroke-width': 1.2,
          },
        });
      }),
      ...call.envelopes
        .filter((envelope) => {
          return TICKED.includes(Number(envelope.header['kind']));
        })
        .map(({ at }) => {
          return svgOf('line', {
            attributes: {
              stroke: 'var(--app-text)',
              'stroke-width': 1.1,
              x1: scale.xOf(at),
              x2: scale.xOf(at),
              y1: y + 2,
              y2: y + 18,
            },
          });
        }),
      svgOf('rect', {
        attributes: {
          class: 'hit',
          'data-key': String(call.key),
          height: ROW,
          width: WIDTH,
          x: 0,
          y,
        },
        children: [svgOf('title', { text: tip })],
      })
    );
  });

  const brush = svgOf('rect', {
    attributes: { class: 'brush', height: height - TOP, visibility: 'hidden', y: TOP - 4 },
  });
  const svg = svgOf('svg', {
    attributes: {
      'aria-label': 'Every call shown, on the time axis',
      role: 'img',
      viewBox: `0 0 ${String(WIDTH)} ${String(height)}`,
    },
    children: [...parts, brush],
  });
  // where a drag started, in the drawing's own units
  let from: number | undefined;
  const xOfEvent = (event: PointerEvent): number => {
    const box = currentOf(svg).getBoundingClientRect();

    return ((event.clientX - box.left) / Math.max(box.width, 1)) * WIDTH;
  };

  listen(svg, {
    type: 'pointerdown',
    handle: (event) => {
      from = xOfEvent(event);
      currentOf(svg).dataset['dragging'] = 'true';
      currentOf(svg).setPointerCapture(event.pointerId);
    },
  });
  listen(svg, {
    type: 'pointermove',
    handle: (event) => {
      if (from === undefined) {
        return;
      }

      const x = xOfEvent(event);

      currentOf(brush).setAttribute('x', String(Math.min(from, x)));
      currentOf(brush).setAttribute('width', String(Math.abs(x - from)));
      currentOf(brush).setAttribute('visibility', 'visible');
    },
  });
  listen(svg, {
    type: 'pointerup',
    handle: (event) => {
      const x = xOfEvent(event);
      const started = from;

      from = undefined;
      delete currentOf(svg).dataset['dragging'];
      currentOf(brush).setAttribute('visibility', 'hidden');

      // a click is no span
      if (started !== undefined && Math.abs(x - started) > 4) {
        view.onRange({
          from: scale.timeOf(Math.min(started, x)),
          to: scale.timeOf(Math.max(started, x)),
        });
      }
    },
  });

  listen(svg, {
    type: 'pointercancel',
    handle: () => {
      from = undefined;
      delete currentOf(svg).dataset['dragging'];
      currentOf(brush).setAttribute('visibility', 'hidden');
    },
  });

  const whole = make('button', {
    attributes: { 'aria-pressed': String(view.range === undefined), type: 'button' },
    text: 'All',
  });

  listen(whole, {
    type: 'click',
    handle: () => {
      view.onRange(undefined);
    },
  });

  return [
    make('div', {
      children: [
        whole,
        make('span', {
          className: 'legend',
          children: [
            make('span', { text: '■ answered' }),
            make('span', { text: '■ failed, in red' }),
            make('span', { text: '▭ ended without an answer, dashed' }),
            make('span', { text: '─ subscription, ○ a notification' }),
            make('span', { text: '| chunk, credit or cancel' }),
          ],
        }),
        make('span', {
          className: 'note',
          text:
            view.range === undefined
              ? 'Drag across it to show the calls of a span alone.'
              : `Calls shows ${clockOf(view.range.from)} to ${clockOf(view.range.to)}, ${spanOf(view.range.to - view.range.from)}.`,
        }),
      ],
      className: 'tl-bar',
    }),
    ...(calls.length > shown.length
      ? [
          make('p', {
            className: 'note',
            text: `The last ${String(TIMELINE_ROWS)} calls shown, of ${String(calls.length)}.`,
          }),
        ]
      : []),
    svg,
  ];
};
