// ── A call's thread ───────────────────────────────────────────────────────────

// Where the Exchange tab draws a call's envelopes: each a bead on the call's thread, one under the
// other in the order the page heard them, going from the page to the server or back, its time after
// the call's first envelope on the left. A pause of more than a moment leaves a gap that says how
// long; a call relayed to a destination has a third lane, its leg beyond the relay drawn apart, as
// nothing of it is seen from the page. A call of many envelopes shows its first and its last.

// dependencies

import { EnvelopeKind } from '../../src/router/shared/constants';
import type { IEnvelopeRecord } from '../messages';
import type { ICall } from './calls';
import { anchorOf, answerPayloadOf, destinationOf, errorOf } from './facts';
import { failureWordsOf, headerWordsOf, kindNameOf } from './words';

// interfaces

/** A bead: an envelope, where it sits, and what it says. */
export interface IBead {
  envelope: IEnvelopeRecord;
  /** Whether it is small on the thread: a chunk, a credit, a notification. */
  isSmall: boolean;
  kind: string;
  /** Its time after the call's first envelope, in milliseconds, never below 0. */
  offset: number;
  words: string;
  y: number;
}

/** What a thread holds besides its beads: a pause, the envelopes left out, the leg beyond a relay. */
export interface IThreadNote {
  kind: 'beyond' | 'left out' | 'pause';
  /** A pause's span in milliseconds, or the envelopes left out. */
  value: number;
  y: number;
}

/** A call's thread, laid out. */
export interface IThread {
  beads: IBead[];
  /** The destination its third lane is for, when it was relayed. */
  destinationId?: number | undefined;
  height: number;
  notes: IThreadNote[];
}

// constants

/** Where the first bead sits, below the lanes' names. */
export const THREAD_TOP = 46;

/** The room a bead takes. */
export const BEAD_STEP = 40;

/** The room a note takes. */
const NOTE_STEP = 22;

/** The pause, in milliseconds, past which a thread says how long it waited. */
const PAUSE_MILLISECONDS = 120;

/** The beads a thread draws at most: its first ones, and its last. */
export const THREAD_BEADS = 60;

const FIRST_BEADS = 10;

const SMALL = Object.freeze<number[]>([
  EnvelopeKind.CHUNK,
  EnvelopeKind.CREDIT,
  EnvelopeKind.NOTIFICATION,
]);

// definition

/** A call's thread, its beads laid out top to bottom. */
export const threadOf = (call: ICall): IThread => {
  const anchor = anchorOf(call);
  const destinationId = destinationOf(call);
  const all = call.envelopes;
  const isLong = all.length > THREAD_BEADS;
  const heard = new Map(
    call.notifications.map(({ envelope, step }) => {
      return [envelope, step?.rx] as const;
    })
  );
  // * what an envelope carried, where a step told it: a notification's value, an answer's, a failure's code
  const carriedOf = (envelope: IEnvelopeRecord): string[] => {
    const kind = Number(envelope.header['kind']);
    const error = errorOf(call);
    const carried =
      kind === EnvelopeKind.NOTIFICATION
        ? heard.get(envelope)
        : envelope === call.answerEnvelope
          ? kind === EnvelopeKind.FAILURE
            ? error === undefined
              ? undefined
              : failureWordsOf(error)
            : answerPayloadOf(call)?.text
          : undefined;

    return carried === undefined ? [] : [carried];
  };
  const shown = isLong
    ? [...all.slice(0, FIRST_BEADS), ...all.slice(all.length - (THREAD_BEADS - FIRST_BEADS))]
    : all;
  const beads: IBead[] = [];
  const notes: IThreadNote[] = [];
  let y = THREAD_TOP;
  let last = anchor;

  if (call.envelopesLetGo > 0) {
    notes.push({ kind: 'left out', value: call.envelopesLetGo, y: y + 4 });
    y += NOTE_STEP;
  }

  shown.forEach((envelope, index) => {
    if (isLong && index === FIRST_BEADS) {
      notes.push({ kind: 'left out', value: all.length - THREAD_BEADS, y: y + 4 });
      y += NOTE_STEP;
    } else if (envelope.at - last > PAUSE_MILLISECONDS) {
      notes.push({ kind: 'pause', value: envelope.at - last, y: y + 4 });
      y += NOTE_STEP;
    }

    beads.push({
      envelope,
      isSmall: SMALL.includes(Number(envelope.header['kind'])),
      kind: kindNameOf(envelope.header),
      offset: Math.max(0, envelope.at - anchor),
      words: [...headerWordsOf(envelope.header), ...carriedOf(envelope)].join(' · '),
      y: y + BEAD_STEP / 2,
    });
    y += BEAD_STEP;
    last = envelope.at;

    // the leg beyond the relay, after the request that crossed to it
    if (destinationId !== undefined && index === 0) {
      notes.push({ kind: 'beyond', value: destinationId, y: y + BEAD_STEP / 2 });
      y += BEAD_STEP + 8;
    }
  });

  return { beads, destinationId, height: y + 16, notes };
};
