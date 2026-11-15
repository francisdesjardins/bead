// ── A call's track ────────────────────────────────────────────────────────────

// One call on a span of time, as the Calls list's Waterfall and the Timeline's rows draw it: its bar
// from its start to its end, a subscription a line, a ring a notification heard, and a tick a chunk,
// a credit or a cancel. Every place is a percentage of the track, so a track keeps its drawing at
// any width with nothing redrawn. An ended subscription's dashed line stops on a cap where it
// ended, so it reads apart from an open one's solid line, which runs on. A bar under 6 px is also
// drawn as an instant, a diamond on its start, as the Trace Event Format's viewers mark an instant
// event; the panel's sheet shows it by the bar's own width. Marks that fall within one percent of
// the track of another are drawn once, so a transfer of thousands of chunks draws tens of ticks.

// dependencies

import { EnvelopeKind } from '../../src/router/shared/constants';
import type { ICall } from '../model/calls';
import { endOf, startOf, statusOf } from '../model/facts';
import type { ISpan } from '../model/scale';
import { make } from './dom';

// interfaces

/** What a track is drawn at. */
export interface ITrackOptions {
  /** The end of a call still open. */
  now: number;
}

// constants

/** The envelopes a track ticks. */
const TICKED = Object.freeze<number[]>([
  EnvelopeKind.CHUNK,
  EnvelopeKind.CREDIT,
  EnvelopeKind.CANCEL,
]);

/** The least distance between two marks of one kind, in percent of the track. */
const MERGED = 1;

// helpers

/** A moment's place on `span`, in percent, to a thousandth. */
const percentOf = (at: number, span: ISpan): number => {
  const width = Math.max(span.to - span.from, 1);

  return Math.round(((at - span.from) / width) * 100_000) / 1_000;
};

/** The places of `moments` within `span`, one for each run that falls within {@link MERGED}. */
const placesOf = (moments: readonly number[], span: ISpan): number[] => {
  const places: number[] = [];

  for (const place of moments
    .filter((at) => {
      // * a mark outside the span is left out, never piled on its edge
      return at >= span.from && at <= span.to;
    })
    .map((at) => {
      return percentOf(at, span);
    })
    .sort((one, other) => {
      return one - other;
    })) {
    const last = places.at(-1);

    if (last === undefined || place - last >= MERGED) {
      places.push(place);
    }
  }

  return places;
};

/** The stop at the end of an ended subscription's line, as the legend draws it too. */
export const capOf = (): HTMLElement => {
  return make('span', { className: 'cap' });
};

const markOf = (className: string, place: number): HTMLElement => {
  return make('span', { attributes: { style: `left:${String(place)}%` }, className });
};

// definition

/** The track of `call` across `span`: its bar or its instant, its rings and its ticks. */
export const trackOf = (call: ICall, span: ISpan, options: ITrackOptions): HTMLElement => {
  const status = statusOf(call);
  const start = startOf(call);
  const end = endOf(call) ?? options.now;
  const left = percentOf(Math.max(start, span.from), span);
  const right = percentOf(Math.min(Math.max(end, start), span.to), span);
  // ! a bar the span cuts is a long call's sliver, never an instant: only a call whose start and
  // end both fall within the span holds the mark
  const isWhole = start >= span.from && end <= span.to;

  return make('div', {
    attributes: { 'aria-hidden': 'true' },
    children: [
      make('span', {
        attributes: {
          style: `left:${String(left)}%;width:${String(Math.max(right - left, 0))}%`,
        },
        children: [
          ...(isWhole ? [make('span', { className: 'instant' })] : []),
          // * an end the span cuts off is out of sight: no cap on the track's edge
          ...(status === 'closed' && end <= span.to ? [capOf()] : []),
        ],
        className: `extent ${status}`,
      }),
      ...placesOf(
        call.notifications.map(({ at }) => {
          return at;
        }),
        span
      ).map((place) => {
        return markOf('ring', place);
      }),
      ...placesOf(
        call.envelopes
          .filter((envelope) => {
            return TICKED.includes(Number(envelope.header['kind']));
          })
          .map(({ at }) => {
            return at;
          }),
        span
      ).map((place) => {
        return markOf('tick', place);
      }),
    ],
    className: 'wf',
  });
};
