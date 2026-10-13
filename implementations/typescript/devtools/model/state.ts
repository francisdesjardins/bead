// ── The state, as the panel saw it ────────────────────────────────────────────

// What a client's connection held at a moment, rebuilt from the calls the panel took up to it: the
// calls in flight, the subscriptions and their credit, the transfers and how far they went, and the
// session its answers announced. It replays nothing, and sends nothing to the page: it reads the
// panel's own records, those it let go aside.

// dependencies

import { ProtocolCode } from '../../src/router/client/router-client';
import type { ICall } from './calls';
import {
  announcedOf,
  answeredAtOf,
  errorOf,
  type ISubscription,
  type ITransfer,
  type ITransferProgress,
  presentedOf,
  progressOf,
  startOf,
  statusOf,
  subscriptionOf,
  transferOf,
} from './facts';

// interfaces

/** A subscription, as it stood. */
export interface ISubscriptionState extends ISubscription {
  call: ICall;
  /** Its latest value — its last notification's, else its answer's — and when it came. */
  latest?: { at: number; text: string } | undefined;
}

/** A transfer, as it stood. */
export interface ITransferState extends ITransfer, ITransferProgress {
  call: ICall;
}

/** The session, as the answers announced it. */
export interface ISessionState {
  /** The last answer that announced one: opened, OPAQUE, or ended, NONE. */
  announced?: { call: ICall; state: 'ended' | 'opened' } | undefined;
  /** The scheme the last call made presented, by its number; none for none. */
  presented?: number | undefined;
  /** Whether a call was made at all, so `presented` reads as none rather than unknown. */
  isAnyMade: boolean;
  /** The calls refused for want of one. */
  refused: ICall[];
}

/** The state at a moment. */
export interface IStateAt {
  at: number;
  inFlight: ICall[];
  session: ISessionState;
  subscriptions: ISubscriptionState[];
  transfers: ITransferState[];
}

// definition

/** The span the calls cover, from the first start to the last record; none for no call. */
export const spanOfCalls = (calls: readonly ICall[]): { from: number; to: number } | undefined => {
  if (calls.length === 0) {
    return undefined;
  }

  const times = calls.flatMap((call) => {
    return [
      startOf(call),
      ...call.envelopes.map(({ at }) => {
        return at;
      }),
      ...call.notifications.map(({ at }) => {
        return at;
      }),
      answeredAtOf(call) ?? startOf(call),
    ];
  });

  return { from: Math.min(...times), to: Math.max(...times) };
};

/** The state the calls held at `at`, as the panel saw them; those started after it are not yet. */
export const stateAt = (calls: readonly ICall[], at: number): IStateAt => {
  const started = calls.filter((call) => {
    return startOf(call) <= at && !call.isNotification;
  });
  const made = started.filter((call) => {
    return !call.isIncoming;
  });
  const announcing = started.filter((call) => {
    const answeredAt = answeredAtOf(call);

    return announcedOf(call) !== undefined && answeredAt !== undefined && answeredAt <= at;
  });
  const last = announcing.at(-1);
  const lastMade = made.at(-1);

  return {
    at,
    inFlight: started.filter((call) => {
      return statusOf(call, at) === 'flight';
    }),
    session: {
      announced:
        last === undefined ? undefined : { call: last, state: announcedOf(last) ?? 'opened' },
      isAnyMade: lastMade !== undefined,
      presented: lastMade === undefined ? undefined : presentedOf(lastMade),
      refused: made.filter((call) => {
        const answeredAt = answeredAtOf(call);

        return (
          errorOf(call)?.code === ProtocolCode.SESSION_REQUIRED &&
          answeredAt !== undefined &&
          answeredAt <= at
        );
      }),
    },
    subscriptions: started.flatMap((call) => {
      const subscription = subscriptionOf(call, at);

      if (subscription === undefined) {
        return [];
      }

      const heard = call.notifications.filter((notification) => {
        return notification.at <= at;
      });
      const lastHeard = heard.at(-1);
      const text = lastHeard?.step?.rx;
      const answeredAt = answeredAtOf(call);
      const answer = call.answer?.rx;

      return [
        {
          ...subscription,
          call,
          latest:
            lastHeard !== undefined && text !== undefined
              ? { at: lastHeard.at, text }
              : answer !== undefined && answeredAt !== undefined && answeredAt <= at
                ? { at: answeredAt, text: answer }
                : undefined,
        },
      ];
    }),
    transfers: started.flatMap((call) => {
      const transfer = transferOf(call);
      const progress = progressOf(call, at);
      // an answer's transfer opens with its RESULT, not before
      const isOpened = transfer?.of !== 'answer' || (call.answerEnvelope?.at ?? at) <= at;

      return transfer === undefined || progress === undefined || !isOpened
        ? []
        : [{ ...transfer, ...progress, call }];
    }),
  };
};
