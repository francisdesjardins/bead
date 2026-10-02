// ── Notification pacing ───────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import type { NotificationKey } from '../shared/types';
import type { IPacing, IPacingLimits, PacingLimitsOptions } from './types';

export { ProgrammerError } from '../../transport/shared/errors';
export type {
  IPacing,
  IPacingLimits,
  IQueuedNotification,
  PacingLimitsOptions,
  PacingOutcome,
} from './types';

// constants

/** What a paced subscription queues at most, unless its router says otherwise. */
export const PACING_DEFAULTS: IPacingLimits = Object.freeze({
  maximumQueuedNotificationBytes: 1_048_576,
  maximumQueuedNotifications: 64,
});

// helpers

/**
 * `options` over {@link PACING_DEFAULTS}, frozen. A limit that is not a whole number above 0 is a
 * {@link ProgrammerError}.
 */
export const pacingLimitsOf = (options?: PacingLimitsOptions): IPacingLimits => {
  const limits = { ...PACING_DEFAULTS };

  for (const [name, value] of Object.entries(options ?? {})) {
    if (value === undefined) {
      continue;
    }

    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ProgrammerError(`${name} is a whole number above 0, not ${String(value)}`);
    }

    limits[name as keyof IPacingLimits] = value;
  }

  return Object.freeze(limits);
};

// definition

/**
 * One paced subscription's credit and queue. Its client credited the first notification by asking;
 * each credit after raises the count it may have been sent. Past it, a notification is queued: one
 * with a key takes the place of the one queued under that key, which keeps its place in the queue,
 * so none waits forever behind newer ones; one without is queued last. The queue is a map, whose
 * order is the order its keys came in, and a notification without a key gets one of its own that no
 * other can match.
 */
export const createPacing = (limits: IPacingLimits): IPacing => {
  const queue = new Map<NotificationKey | symbol, Uint8Array>();
  let creditEnd = 1;
  let queuedBytes = 0;
  let sent = 0;

  return {
    get isPaused() {
      return sent >= creditEnd;
    },
    get queuedNotificationBytes() {
      return queuedBytes;
    },
    get queuedNotifications() {
      return queue.size;
    },

    credit: (end) => {
      const released: Uint8Array[] = [];

      creditEnd = Math.max(creditEnd, end);

      // a map lets its entries go as it is walked
      for (const [key, payload] of queue) {
        if (sent >= creditEnd) {
          break;
        }

        queue.delete(key);
        queuedBytes -= payload.byteLength;
        sent += 1;
        released.push(payload);
      }

      return released;
    },
    offer: ({ key, payload }) => {
      // credit left means nothing is queued: what the credit let go went at once
      if (sent < creditEnd) {
        sent += 1;

        return 'send';
      }

      const slot = key ?? Symbol('unkeyed');

      queuedBytes += payload.byteLength - (queue.get(slot)?.byteLength ?? 0);
      queue.set(slot, payload);

      return queue.size > limits.maximumQueuedNotifications ||
        queuedBytes > limits.maximumQueuedNotificationBytes
        ? 'exceeded'
        : 'queued';
    },
  };
};
