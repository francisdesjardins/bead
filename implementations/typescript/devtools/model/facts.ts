// ── What a call came to ───────────────────────────────────────────────────────

// What the panel says of one call, read from its records alone: where it stands, how it ended, in
// words, when it started and ended, what it moves as a transfer, what it subscribes to, and what
// its answer announced of a session. Each takes a moment, so the State view reads the call as it
// stood then.

// dependencies

import { CredentialScheme, EnvelopeKind } from '../../src/router/shared/constants';
import type { ICallRecord, IEnvelopeRecord } from '../messages';
import type { PreviewNode } from '../preview';
import type { ICall } from './calls';
import { failureWordsOf, spanOf } from './words';

// interfaces

/** A call's transfer: which way its bytes go, how many, and which of its payloads they are. */
export interface ITransfer {
  /** The way its bytes go: `tx`, from the page; `rx`, to it. */
  direction: 'rx' | 'tx';
  of: 'answer' | 'request';
  total: number;
}

/** Where a transfer stood: the bytes before its last chunk, or all, and the end credited. */
export interface ITransferProgress {
  credited: number | undefined;
  isWhole: boolean;
  passed: number;
}

/** A call's subscription: whether it is paced, how far it was credited, and how it ended. */
export interface ISubscription {
  /** The notifications credited so far, for one paced: its request credits the first. */
  credited: number | undefined;
  /** Who ended it: the page, by a cancel; the server, by a failure; none while it is open. */
  endedBy?: 'the page' | 'the server' | undefined;
  /** The notifications heard so far, those let go among them. */
  heard: number;
  isAnswered: boolean;
  isOpen: boolean;
  isPaced: boolean;
}

// types

/**
 * Where a call stands: answered, failed, ended without an answer (cancelled, timed out, its
 * connection gone), in flight; a subscription open or closed; a notification heard alone.
 */
export type CallStatus = 'answered' | 'closed' | 'ended' | 'failed' | 'flight' | 'heard' | 'open';

// constants

/** The errors a call ends with that are no failure of its own: it went unanswered. */
const UNANSWERED = Object.freeze(['CancelError', 'DisconnectError', 'TimeoutError', 'AbortError']);

/** No end: a moment past every record. */
const LIVE = Number.POSITIVE_INFINITY;

// helpers

const before = (envelope: IEnvelopeRecord | undefined, at: number): IEnvelopeRecord | undefined => {
  return envelope !== undefined && envelope.at <= at ? envelope : undefined;
};

const kindOf = (envelope: IEnvelopeRecord): number => {
  return Number(envelope.header['kind']);
};

// definition

/** When a call started: its opening step's start, else its first record's time. */
export const startOf = (call: ICall): number => {
  return (
    call.opening?.startedAt ??
    call.answer?.startedAt ??
    call.request?.at ??
    call.envelopes[0]?.at ??
    call.notifications[0]?.at ??
    0
  );
};

/**
 * The moment a call's thread is drawn from: its first envelope's, on the clock its envelopes are
 * read by, else its start. A step's start is its router's wall clock, a few milliseconds from it.
 */
export const anchorOf = (call: ICall): number => {
  return call.request?.at ?? call.envelopes[0]?.at ?? startOf(call);
};

/**
 * When its answer came: its RESULT or FAILURE, else its answer's step, its duration after start. An
 * answer that opens a transfer came once its last chunk did, which its step follows.
 */
export const answeredAtOf = (call: ICall): number | undefined => {
  const answer = call.answerEnvelope;
  const stepAt =
    call.answer === undefined ? undefined : call.answer.startedAt + (call.answer.duration ?? 0);

  if (answer !== undefined && typeof answer.header['total'] === 'number') {
    const last = call.envelopes.find((envelope) => {
      return (
        kindOf(envelope) === EnvelopeKind.CHUNK &&
        envelope.header['isLast'] === true &&
        envelope.direction === answer.direction
      );
    });

    return last?.at ?? stepAt;
  }

  return answer?.at ?? stepAt;
};

/** The error its answer told, if any. */
export const errorOf = (call: ICall): ICallRecord['error'] => {
  return call.answer?.error ?? (call.isNotification ? call.opening?.error : undefined);
};

/** A call's payload, previewed as text and as a tree, if the trace told it. */
export interface IPayload {
  text: string;
  tree?: PreviewNode | undefined;
}

const payloadOf = (step: ICallRecord | undefined, direction: 'rx' | 'tx'): IPayload | undefined => {
  const text = step?.[direction];

  return text === undefined ? undefined : { text, tree: step?.[`${direction}Tree`] };
};

/** What a call's request carried: what the page sent, or, for a command, what came to it. */
export const requestPayloadOf = (call: ICall): IPayload | undefined => {
  return call.isIncoming
    ? payloadOf(call.opening, 'rx')
    : (payloadOf(call.opening, 'tx') ?? payloadOf(call.answer, 'tx'));
};

/** What a call's answer carried: what came back, or, for a command, what the page answered. */
export const answerPayloadOf = (call: ICall): IPayload | undefined => {
  if (call.isNotification) {
    return payloadOf(call.opening, 'rx');
  }

  return call.isIncoming ? payloadOf(call.answer, 'tx') : payloadOf(call.answer, 'rx');
};

/** The subscription a call opened, as it stood `at`; none for a call that opened none. */
export const subscriptionOf = (call: ICall, at = LIVE): ISubscription | undefined => {
  if (call.request?.header['opensSubscription'] !== true) {
    return undefined;
  }

  const isPaced = call.request.header['paced'] === true;
  const answered = before(call.answerEnvelope, at);
  const isAnswered =
    (answered !== undefined && kindOf(answered) === EnvelopeKind.RESULT) ||
    (answered === undefined &&
      at === LIVE &&
      call.answer !== undefined &&
      call.answer.error === undefined);
  const cancel = before(call.cancel, at);
  const failure =
    before(call.endEnvelope, at) ??
    (answered !== undefined && kindOf(answered) === EnvelopeKind.FAILURE ? answered : undefined);
  const heard = call.notifications.filter((notification) => {
    return notification.at <= at;
  }).length;
  const credits = call.envelopes
    .filter((envelope) => {
      return (
        envelope.at <= at &&
        kindOf(envelope) === EnvelopeKind.CREDIT &&
        envelope.header['paced'] === true
      );
    })
    .map((envelope) => {
      return Number(envelope.header['creditEnd']);
    });

  return {
    credited: isPaced ? Math.max(1, ...credits) : undefined,
    endedBy: cancel !== undefined ? 'the page' : failure !== undefined ? 'the server' : undefined,
    heard: heard + (heard > 0 ? call.notificationsLetGo : 0),
    isAnswered,
    isOpen: isAnswered && cancel === undefined && failure === undefined,
    isPaced,
  };
};

/** The transfer a call opened, its request's or its answer's; none for one that opened none. */
export const transferOf = (call: ICall): ITransfer | undefined => {
  const requestTotal = call.request?.header['total'];

  if (call.request !== undefined && typeof requestTotal === 'number') {
    return {
      direction: call.request.direction === 'tx' ? 'tx' : 'rx',
      of: 'request',
      total: requestTotal,
    };
  }

  const answer = call.answerEnvelope;
  const answerTotal = answer?.header['total'];

  if (answer !== undefined && typeof answerTotal === 'number') {
    return { direction: answer.direction === 'tx' ? 'tx' : 'rx', of: 'answer', total: answerTotal };
  }

  return undefined;
};

/** Where a call's transfer stood `at`: by the offset of its last chunk, and its highest credit. */
export const progressOf = (call: ICall, at = LIVE): ITransferProgress | undefined => {
  const transfer = transferOf(call);

  if (transfer === undefined) {
    return undefined;
  }

  const seen = call.envelopes.filter((envelope) => {
    return envelope.at <= at;
  });
  const chunks = seen.filter((envelope) => {
    return kindOf(envelope) === EnvelopeKind.CHUNK && envelope.direction === transfer.direction;
  });
  const last = chunks.at(-1);
  const credits = seen
    .filter((envelope) => {
      return (
        kindOf(envelope) === EnvelopeKind.CREDIT &&
        envelope.header['paced'] !== true &&
        envelope.direction !== transfer.direction
      );
    })
    .map((envelope) => {
      return Number(envelope.header['creditEnd']);
    });
  const isWhole = last?.header['isLast'] === true;

  return {
    credited: credits.length === 0 ? undefined : Math.max(...credits),
    isWhole,
    passed: isWhole ? transfer.total : Number(last?.header['offset'] ?? 0),
  };
};

/** Where a call stood `at`. */
export const statusOf = (call: ICall, at = LIVE): CallStatus => {
  if (call.isNotification) {
    return 'heard';
  }

  const subscription = subscriptionOf(call, at);

  if (subscription?.isAnswered === true) {
    return subscription.isOpen ? 'open' : 'closed';
  }

  const answeredAt = answeredAtOf(call);
  const isAnswered = answeredAt !== undefined && (at === LIVE || answeredAt <= at);
  const error = errorOf(call);

  if (isAnswered && error !== undefined) {
    return UNANSWERED.includes(error.name) ? 'ended' : 'failed';
  }

  if (isAnswered) {
    const answer = call.answerEnvelope;

    return answer !== undefined && kindOf(answer) === EnvelopeKind.FAILURE ? 'failed' : 'answered';
  }

  return before(call.cancel, at) === undefined ? 'flight' : 'ended';
};

/** When a call ended `at` the latest: its answer, a subscription's end, its cancel; none while open. */
export const endOf = (call: ICall): number | undefined => {
  const subscription = subscriptionOf(call);

  if (subscription?.isAnswered === true) {
    return subscription.isOpen ? undefined : (call.cancel?.at ?? call.endEnvelope?.at);
  }

  return answeredAtOf(call) ?? call.cancel?.at;
};

/** What a call came to, in words. */
export const outcomeOf = (call: ICall): string => {
  const status = statusOf(call);
  const error = errorOf(call);

  if (status === 'heard') {
    return answerPayloadOf(call)?.text ?? '';
  }

  if (status === 'open' || status === 'closed') {
    const subscription = subscriptionOf(call);
    const heard = `${String(subscription?.heard ?? 0)} heard`;

    return subscription?.endedBy === undefined
      ? heard
      : `${heard} · ended by ${subscription.endedBy}`;
  }

  if (status === 'ended') {
    if (error?.name === 'TimeoutError') {
      const timeout = call.opening?.timeout;

      return typeof timeout === 'number' ? `timed out after ${spanOf(timeout)}` : 'timed out';
    }

    if (error?.name === 'DisconnectError') {
      return 'its connection closed';
    }

    return 'cancelled';
  }

  if (status === 'failed') {
    return error === undefined ? 'failed' : failureWordsOf(error);
  }

  if (status === 'flight') {
    return call.request === undefined && call.callId === undefined
      ? 'refused before it went'
      : 'waiting';
  }

  return answerPayloadOf(call)?.text ?? '';
};

/** The session a call's answer announced: OPAQUE for one opened, NONE for its end; none for none. */
export const announcedOf = (call: ICall): 'ended' | 'opened' | undefined => {
  const scheme = call.answerEnvelope?.header['credentialScheme'];

  if (typeof scheme !== 'number' || call.answerEnvelope?.direction !== 'rx') {
    return undefined;
  }

  return scheme === CredentialScheme.NONE ? 'ended' : 'opened';
};

/** The credential scheme a call presented, by its step's options or its REQUEST's header. */
export const presentedOf = (call: ICall): number | undefined => {
  const scheme = call.opening?.credentialScheme ?? call.request?.header['credentialScheme'];

  return typeof scheme === 'number' ? scheme : undefined;
};

/** A call's destination behind the server, by its options or its REQUEST's header. */
export const destinationOf = (call: ICall): number | undefined => {
  const destination = call.opening?.destinationId ?? call.request?.header['destinationId'];

  return typeof destination === 'number' ? destination : undefined;
};
