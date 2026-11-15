// ── The Timeline view ─────────────────────────────────────────────────────────

// Every call shown, a row each as the Calls list draws its rows, newest first as it lists them: its
// status, its id, its procedure, how long it took, and its track on one axis of time, drawn as the
// Waterfall draws it. The axis is the calls' whole span, or the span dragged across the track,
// which bounds the Calls list as a brush does and narrows the axis to it; "Show every call" gives
// the whole back. A click or Enter on a row opens its call's detail, and ↑ and ↓ move through the
// rows.

// dependencies

import type { ICall } from '../model/calls';
import { type CallStatus, outcomeOf, startOf, statusOf } from '../model/facts';
import { type ISpan, tickStepOf, ticksOf } from '../model/scale';
import { clockOf, spanOf } from '../model/words';
import { callLabelOf, durationWordsOf, typeWordsOf } from './calls';
import { currentOf, listen, make, STATUS_NAMES, statusIconOf } from './dom';
import { capOf, trackOf } from './track';

// interfaces

/** What the Timeline draws. */
export interface ITimelineView {
  calls: readonly ICall[];
  isAllClients: boolean;
  nameOf: (call: ICall) => string;
  now: number;
  /** Opens a call's detail, as a click on its row or Enter asks. */
  onOpen: (key: number) => void;
  /** Bounds the Calls list to a span, or lets it be whole again. */
  onRange: (range: ISpan | undefined) => void;
  /** Selects a call, as ↑ and ↓ move through the rows. */
  onSelect: (key: number) => void;
  /** The span the Calls list is bounded to, if any: the axis, when there is one. */
  range: ISpan | undefined;
  selected: number | undefined;
  /** The span of every call shown. */
  span: ISpan | undefined;
}

// constants

/** The rows drawn at most: the newest calls. */
export const TIMELINE_ROWS = 300;

/** How far a press moves before it is a drag, in CSS pixels: less is a click. */
const DRAG = 4;

/** The statuses the legend names, a bar each. */
const LEGEND = Object.freeze<CallStatus[]>([
  'answered',
  'failed',
  'ended',
  'flight',
  'open',
  'closed',
]);

/** The keys that move through the rows. */
const MOVES = Object.freeze<string[]>(['ArrowDown', 'ArrowUp', 'End', 'Home']);

// helpers

/** One key of the legend: a swatch drawn as the tracks draw, and its words. */
const keyOf = (marks: readonly HTMLElement[], words: string): HTMLElement => {
  return make('span', {
    children: [
      make('span', {
        attributes: { 'aria-hidden': 'true' },
        children: marks,
        className: 'wf swatch',
      }),
      words,
    ],
    className: 'key',
  });
};

const legendOf = (): HTMLElement => {
  return make('span', {
    children: [
      ...LEGEND.map((status) => {
        return keyOf(
          [
            make('span', {
              attributes: { style: 'left:0;width:100%' },
              children: status === 'closed' ? [capOf()] : [],
              className: `extent ${status}`,
            }),
          ],
          STATUS_NAMES[status]
        );
      }),
      keyOf(
        [
          make('span', {
            attributes: { style: 'left:50%;width:0' },
            children: [make('span', { className: 'instant' })],
            className: 'extent answered',
          }),
        ],
        'a call too short for its bar, at its start'
      ),
      keyOf(
        [make('span', { attributes: { style: 'left:50%' }, className: 'ring' })],
        'a notification'
      ),
      keyOf(
        [make('span', { attributes: { style: 'left:50%' }, className: 'tick' })],
        'a chunk, credit or cancel'
      ),
    ],
    className: 'legend',
  });
};

/** The head of the track's column: the axis's labels at their places, in percent. */
const axisOf = (axis: ISpan): HTMLElement => {
  const width = Math.max(axis.to - axis.from, 1);

  return make('div', {
    children: ticksOf(axis).map((tick) => {
      return make('span', {
        attributes: { style: `left:${String((tick / width) * 100)}%` },
        text: spanOf(tick),
      });
    }),
    className: 'axis',
  });
};

const rowOf = (
  call: ICall,
  { axis, isFocus, view }: { axis: ISpan; isFocus: boolean; view: ITimelineView }
): HTMLElement => {
  const status = statusOf(call);

  return make('tr', {
    attributes: {
      'aria-selected': String(call.key === view.selected),
      'data-key': String(call.key),
      'data-status': status,
      // * one row in the tab order, the selected one: ↑ and ↓ move from it
      tabindex: isFocus ? '0' : '-1',
      title: [
        `${view.nameOf(call)} ${callLabelOf(call, view.isAllClients)} · ${typeWordsOf(call)}`,
        `started ${clockOf(startOf(call))}`,
        `${durationWordsOf(call, view.now)} · ${outcomeOf(call)}`,
      ].join('\n'),
    },
    children: [
      make('td', { children: [statusIconOf(status)] }),
      make('td', { text: callLabelOf(call, view.isAllClients) }),
      make('td', { className: 'name', text: view.nameOf(call) }),
      make('td', { className: 'num', text: durationWordsOf(call, view.now) }),
      make('td', { children: [trackOf(call, axis, { now: view.now })], className: 'track' }),
    ],
    className: status === 'failed' ? 'call failed' : 'call',
  });
};

// definition

/** The Timeline: its legend and its reset, then its rows, under the axis, and its brush. */
export const timelineViewOf = (view: ITimelineView): Node[] => {
  const { calls, span } = view;

  if (span === undefined) {
    return [make('p', { className: 'note', text: 'No call yet.' })];
  }

  const axis = view.range ?? span;
  // * newest first, row for row as the Calls list orders them; the time axis runs left to right
  const shown = calls
    .toSorted((one, other) => {
      return other.key - one.key;
    })
    .slice(0, TIMELINE_ROWS);
  const focus = shown.some(({ key }) => {
    return key === view.selected;
  })
    ? view.selected
    : shown[0]?.key;
  const head = axisOf(axis);
  const brush = make('div', { attributes: { hidden: '' }, className: 'brush' });
  const body = make('tbody', {
    children: shown.map((call) => {
      return rowOf(call, { axis, isFocus: call.key === focus, view });
    }),
  });
  const rows = make('div', {
    attributes: {
      id: 'timeline-rows',
      // the grid: a line at each tick, a step of the axis apart
      style: `--grid:${String((tickStepOf(axis) / Math.max(axis.to - axis.from, 1)) * 100)}%`,
    },
    children: [
      make('table', {
        children: [
          make('thead', {
            children: [
              make('tr', {
                children: [
                  make('th', {
                    attributes: { scope: 'col' },
                    children: [make('span', { className: 'status' })],
                  }),
                  make('th', { attributes: { scope: 'col' }, text: 'Call' }),
                  make('th', { attributes: { scope: 'col' }, text: 'Procedure' }),
                  make('th', { attributes: { scope: 'col' }, className: 'num', text: 'Duration' }),
                  make('th', {
                    attributes: { scope: 'col' },
                    children: [head],
                    className: 'track',
                  }),
                ],
              }),
            ],
          }),
          body,
        ],
      }),
      brush,
    ],
    className: 'tl-rows',
  });

  // where a press started, its pointer, and whether it became a drag
  let press: { isDrag: boolean; pointer: number; x: number } | undefined;
  const release = (): void => {
    press = undefined;
    delete currentOf(rows).dataset['dragging'];
    currentOf(brush).hidden = true;
  };
  /** Where `x` falls on the axis's column, from 0 at its start to 1 at its end. */
  const fractionOf = (x: number): number => {
    const box = currentOf(head).getBoundingClientRect();

    return Math.min(1, Math.max(0, (x - box.left) / Math.max(box.width, 1)));
  };

  listen(rows, {
    type: 'pointerdown',
    handle: (event) => {
      const isOnTrack = event.target instanceof Element && event.target.closest('.track') !== null;

      if (event.button !== 0 || !isOnTrack) {
        return;
      }

      press = { isDrag: false, pointer: event.pointerId, x: event.clientX };
      // * a press holds the drawing still: the panel redraws nothing that is being dragged
      currentOf(rows).dataset['dragging'] = 'true';
    },
  });
  listen(rows, {
    type: 'pointermove',
    handle: (event) => {
      // ! a press let go outside the rows, before its capture, sends them no pointerup: a move
      // with no button held ends it
      if (press !== undefined && event.buttons === 0) {
        release();

        return;
      }

      if (press === undefined || (!press.isDrag && Math.abs(event.clientX - press.x) <= DRAG)) {
        return;
      }

      // ! captured past the threshold alone: a capture from the press would aim its click at the
      // rows' box, never at the row pressed
      if (!press.isDrag) {
        press.isDrag = true;
        currentOf(rows).setPointerCapture(press.pointer);
      }

      const box = currentOf(head).getBoundingClientRect();
      const origin = currentOf(rows).getBoundingClientRect().left;
      const [one, other] = [fractionOf(press.x), fractionOf(event.clientX)].sort((a, b) => {
        return a - b;
      }) as [number, number];

      currentOf(brush).style.left = `${String(box.left - origin + one * box.width)}px`;
      currentOf(brush).style.width = `${String((other - one) * box.width)}px`;
      currentOf(brush).hidden = false;
    },
  });
  listen(rows, {
    type: 'pointerup',
    handle: (event) => {
      const started = press;

      release();

      if (started?.isDrag === true) {
        const [one, other] = [fractionOf(started.x), fractionOf(event.clientX)].sort((a, b) => {
          return a - b;
        }) as [number, number];
        const width = axis.to - axis.from;

        view.onRange({ from: axis.from + one * width, to: axis.from + other * width });
      }
    },
  });
  listen(rows, {
    type: 'pointercancel',
    handle: release,
  });
  listen(rows, {
    type: 'pointerleave',
    handle: () => {
      // a press that leaves the rows before it is a drag is no drag, and holds nothing still
      if (press?.isDrag === false) {
        release();
      }
    },
  });
  listen(rows, {
    type: 'click',
    handle: (event) => {
      const row =
        event.target instanceof Element ? event.target.closest<HTMLElement>('tr[data-key]') : null;

      if (row !== null) {
        view.onOpen(Number(row.dataset['key']));
      }
    },
  });
  listen(rows, {
    type: 'keydown',
    handle: (event) => {
      const all = [...currentOf(body).querySelectorAll<HTMLElement>('tr[data-key]')];
      const at = all.findIndex((row) => {
        return row === document.activeElement;
      });
      const row = all[at];

      if (row === undefined) {
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        view.onOpen(Number(row.dataset['key']));

        return;
      }

      if (!MOVES.includes(event.key)) {
        return;
      }

      event.preventDefault();

      const next =
        event.key === 'Home'
          ? all[0]
          : event.key === 'End'
            ? all.at(-1)
            : all[Math.max(0, Math.min(all.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];

      if (next !== undefined && next !== row) {
        next.focus();
        view.onSelect(Number(next.dataset['key']));
      }
    },
  });

  const whole = make('button', {
    attributes: { 'aria-pressed': String(view.range === undefined), type: 'button' },
    text: 'Show every call',
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
        legendOf(),
        make('span', {
          className: 'note',
          text:
            view.range === undefined
              ? 'Drag across the time axis to see a span alone: the Calls list shows its calls, and the axis narrows to it.'
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
    rows,
  ];
};
