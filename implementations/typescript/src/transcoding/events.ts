// ── Events ────────────────────────────────────────────────────────────────────

// A stream's call as Server-Sent Events of WHATWG HTML §9.2 (spec/transcoding.md 8): its result
// first, each notification a plain event, the failure that ends it last, each an id, a comment
// while nothing goes, and each notification credited once its event was taken.

// dependencies

import type { IClock, TimeoutId } from '../transport/shared/clock';

export { HEARTBEAT } from '../transport/shared/heartbeat';
import { base64Of } from './json-form';
import type { IProblem } from './problems';

// interfaces

/** Where a stream goes: the response a gateway writes it on. */
export interface IEventSink {
  /** Answers a failure that came before its result, as any call's: a problem of its status. */
  readonly answer: (problem: IProblem) => void;
  /** Ends the response, once the failure that ends the stream went. */
  readonly end: () => void;
  /** Writes the stream's head, 200 `text/event-stream`, before its first event. */
  readonly open: () => void;
  /** Writes `text`, and settles once the response took it: written to its socket, or its drain came. */
  readonly write: (text: string) => Promise<void>;
}

/** What a stream's call is given, in order, and writes as its events. */
export interface IEventStream {
  /** Whether it ended: by its failure, before its result or after, or closed. */
  readonly isEnded: boolean;

  /** Stops it with nothing more written: its client went, its heartbeat stopped. */
  close: () => void;
  /** Its call's failure: a problem before its result, its last event after, its end either way. */
  failure: (problem: IProblem) => void;
  /**
   * A notification's data, one JSON text: held until its result, and written after it; settles once
   * the response took its event, which credits the next (8.8). One after its end is dropped.
   */
  notification: (data: string) => Promise<void>;
  /** Its call's result, one JSON text: the stream opens, its first event. */
  result: (data: string) => void;
}

/** How often a quiet stream writes its comment, on the clock it runs on. */
export interface IEventStreamOptions {
  readonly clock: IClock;
  /** Milliseconds between comments while nothing else goes; `Infinity`, none. */
  readonly heartbeat: number;
}

// constants

/** The media type of a stream of events (WHATWG HTML §9.2). */
export const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream';

/** A heartbeat's comment, which no `EventSource` dispatches (§9.2.6). */
export const HEARTBEAT_COMMENT = ':\n';

// helpers

/** An event's lines (8.5): its name where it has one, its id, its data, then the empty line. */
export const eventOf = ({
  data,
  id,
  name,
}: {
  data: string;
  id: number;
  name?: 'failure' | 'result' | undefined;
}): string => {
  return `${name === undefined ? '' : `event: ${name}\n`}id: ${String(id)}\ndata: ${data}\n\n`;
};

/**
 * A `text` or a `raw` payload as an event's data (8.4): its text, or its bytes in standard base64,
 * padded, each a JSON string; a `proto` or a `json` one's is its JSON already.
 */
export const eventDataOf = (
  payload: { bytes: Uint8Array; encoding: 'raw' } | { encoding: 'text'; text: string }
): string => {
  return payload.encoding === 'text'
    ? JSON.stringify(payload.text)
    : `"${base64Of(payload.bytes)}"`;
};

// definition

/**
 * A stream's call written on `sink` as Server-Sent Events (transcoding 8): nothing before its
 * result; a notification that comes first held, then written after it, or dropped by a failure; each
 * event an id, its count from 1; a comment every `heartbeat` while nothing else goes; each
 * notification settled once its event was taken, the subscription's credit.
 */
export const createEventStream = (
  sink: IEventSink,
  { clock, heartbeat }: IEventStreamOptions
): IEventStream => {
  // notifications that came before the result, each with what settles its credit
  const held: { data: string; settle: () => void }[] = [];
  let count = 0;
  let isOpen = false;
  let isEnded = false;
  let timer: TimeoutId | undefined;

  const stopBeating = (): void => {
    clock.clearTimeout(timer);
    timer = undefined;
  };

  // * re-armed by every write: a comment only while nothing else goes
  const beat = (): void => {
    stopBeating();

    if (!Number.isFinite(heartbeat) || isEnded) {
      return;
    }

    timer = clock.setTimeout(() => {
      timer = undefined;

      if (!isEnded) {
        void sink.write(HEARTBEAT_COMMENT);
        beat();
      }
    }, heartbeat);
    (timer as { unref?: () => unknown }).unref?.();
  };

  const write = (text: string): Promise<void> => {
    const taken = sink.write(text);

    beat();

    return taken;
  };

  const writeEvent = (data: string, name?: 'failure' | 'result'): Promise<void> => {
    count += 1;

    return write(eventOf({ data, id: count, name }));
  };

  const drop = (): void => {
    for (const { settle } of held.splice(0)) {
      settle();
    }
  };

  return {
    get isEnded() {
      return isEnded;
    },

    close: () => {
      isEnded = true;
      stopBeating();
      drop();
    },

    failure: (problem) => {
      if (isEnded) {
        return;
      }

      isEnded = true;
      stopBeating();

      if (!isOpen) {
        drop();
        sink.answer(problem);

        return;
      }

      count += 1;
      void sink.write(eventOf({ data: problem.body, id: count, name: 'failure' }));
      sink.end();
    },

    notification: (data) => {
      if (isEnded) {
        return Promise.resolve();
      }

      if (!isOpen) {
        return new Promise((resolve) => {
          held.push({ data, settle: resolve });
        });
      }

      return writeEvent(data);
    },

    result: (data) => {
      if (isEnded || isOpen) {
        return;
      }

      isOpen = true;
      sink.open();
      void writeEvent(data, 'result');

      for (const { data: notification, settle } of held.splice(0)) {
        writeEvent(notification).then(settle, settle);
      }
    },
  };
};
