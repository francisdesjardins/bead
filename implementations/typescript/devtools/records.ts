// ── DevTools records ──────────────────────────────────────────────────────────

// What the hook makes of each event a source's watch hears, before it leaves the page (decision
// 0015): a plain record, JSON as a runtime port carries it — a credential by its scheme alone, a
// payload by its previews, no signal and no function.

// dependencies

import type { IRouterDebugInfo } from '../src/router/client/types';
import type { IParticipantDebugEvent } from '../src/transport/shared/participant-debug';
import type { IDebugEvent } from '../src/router/shared/types';
import type { ICallRecord, IEnvelopeRecord, IErrorRecord, IParticipantRecord } from './messages';
import { previewOf, previewTreeOf } from './preview';

// helpers

const numberOf = (value: unknown): number | undefined => {
  return typeof value === 'number' ? value : undefined;
};

const textOf = (value: unknown): string | undefined => {
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * What `error` says, made plain: its name and message, and a failure's code, scope and detail,
 * where it was raised, the relays it crossed, its destination, and the call id its envelope named.
 */
const errorOf = (error: unknown): IErrorRecord | undefined => {
  if (error === null || error === undefined) {
    return undefined;
  }

  if (!(error instanceof Error)) {
    return { message: previewOf(error) ?? '', name: typeof error };
  }

  const { code, destinationId, detail, header, origin, relays, scope, side } = error as Error &
    Record<string, unknown>;

  return {
    callId: numberOf((header as { callId?: unknown } | undefined)?.callId),
    code: numberOf(code),
    destinationId: numberOf(destinationId),
    detail: textOf(detail),
    message: error.message,
    name: error.name,
    origin: textOf(origin),
    relays: numberOf(relays),
    scope: numberOf(scope),
    side: textOf(side),
  };
};

/**
 * A header's fields, each a number, a string or a boolean: a credential by its scheme alone, as the
 * router's trace gives it, a bigint as its digits, and what is neither left out.
 */
export const plainHeaderOf = (header: object): Record<string, boolean | number | string> => {
  const plain: Record<string, boolean | number | string> = {};

  for (const [name, value] of Object.entries(header)) {
    if (name === 'credential') {
      const scheme = (value as { scheme?: unknown } | undefined)?.scheme;

      if (typeof scheme === 'number') {
        plain['credentialScheme'] = scheme;
      }
    } else if (typeof value === 'bigint') {
      plain[name] = String(value);
    } else if (
      typeof value === 'number' ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      plain[name] = value;
    }
  }

  return plain;
};

// definition

/**
 * A step of a call, as `source`'s services told it, made plain: its options all but its signal and
 * its credential's token, its payloads previewed as text and as a tree.
 */
export const callRecordOf = (
  source: number,
  [error, event]: readonly [error: unknown, event: IDebugEvent]
): ICallRecord => {
  const { options } = event;
  const scheme = (options?.credential as { scheme?: unknown } | undefined)?.scheme;
  const timeout = options?.timeout;

  return {
    callId: event.callId,
    closeOnTimeout: options?.closeOnTimeout,
    connectionHandle: event.connectionHandle,
    credentialScheme: numberOf(scheme),
    destinationId: options?.destinationId,
    direction: event.direction,
    duration: event.duration,
    error: errorOf(error),
    kind: 'call',
    procedureId: event.procedureId,
    procedureName: event.procedureName,
    rx: previewOf(event.rx),
    rxTree: previewTreeOf(event.rx),
    serviceId: event.serviceId,
    serviceRevision: event.serviceRevision,
    source,
    startedAt: event.startedAt,
    timeout: timeout === undefined ? undefined : Number.isFinite(timeout) ? timeout : 'never',
    tx: previewOf(event.tx),
    txTree: previewTreeOf(event.tx),
    type: event.type,
  };
};

/** An envelope, as `source`'s router told it at `at`, made plain. */
export const envelopeRecordOf = (
  { at, source }: { at: number; source: number },
  { connectionHandle, direction, header }: IRouterDebugInfo
): IEnvelopeRecord => {
  return {
    at,
    connectionHandle,
    direction,
    header: plainHeaderOf(header),
    kind: 'envelope',
    source,
  };
};

/** Section 13's allowlist; a source's additional fields never enter a log. */
export const participantRecordOf = (
  { at, source }: { at: number; source: number },
  event: IParticipantDebugEvent
): IParticipantRecord => {
  return {
    at,
    source,
    kind: 'participant',
    event: event.event,
    direction: event.direction,
    topic: event.topic === undefined ? undefined : [...event.topic],
    bytes: event.bytes,
    layout: event.layout,
    parcelKind: event.kind,
    flags: event.flags,
    sequence: event.sequence,
    opener: event.opener,
    connection: event.connection,
    connectionHandle: event.connectionHandle,
    id: event.id,
    incarnation: event.incarnation,
    bound: event.bound,
    secure: event.secure,
    status: event.status,
    carriedBytes: event.carriedBytes,
    more: event.more,
    hasCredential: event.hasCredential,
    answers: event.answers,
    code: event.code,
    verdict: event.verdict,
    awaited: event.awaited,
    came: event.came,
    state: event.state,
    ended: event.ended === undefined ? undefined : [...event.ended],
    name: event.name,
    isHeld: event.isHeld,
    group: event.group,
    report: event.report,
  };
};
