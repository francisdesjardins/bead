// ── DevTools records ──────────────────────────────────────────────────────────

// What the hook makes of each event a source's watch hears, before it leaves the page (decision
// 0015): a plain record, JSON as a runtime port carries it — a credential by its scheme alone, a
// payload by its preview, no signal and no function.

// dependencies

import type { IRouterDebugInfo } from '../src/router/client/types';
import type { IDebugEvent } from '../src/router/shared/types';
import type { ICallRecord, IEnvelopeRecord, IErrorRecord } from './messages';
import { previewOf } from './preview';

// helpers

/** What `error` says, made plain: its name and message, and a failure's code, scope and detail. */
const errorOf = (error: unknown): IErrorRecord | undefined => {
  if (error === null || error === undefined) {
    return undefined;
  }

  if (!(error instanceof Error)) {
    return { message: previewOf(error) ?? '', name: typeof error };
  }

  const { code, detail, scope } = error as Error & Record<string, unknown>;

  return {
    code: typeof code === 'number' ? code : undefined,
    detail: typeof detail === 'string' && detail !== '' ? detail : undefined,
    message: error.message,
    name: error.name,
    scope: typeof scope === 'number' ? scope : undefined,
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

/** A step of a call, as `source`'s services told it, made plain. */
export const callRecordOf = (
  source: number,
  [error, event]: readonly [error: unknown, event: IDebugEvent]
): ICallRecord => {
  const { options } = event;
  const scheme = (options?.credential as { scheme?: unknown } | undefined)?.scheme;
  const timeout = options?.timeout;

  return {
    credentialScheme: typeof scheme === 'number' ? scheme : undefined,
    direction: event.direction,
    duration: event.duration,
    error: errorOf(error),
    kind: 'call',
    procedureId: event.procedureId,
    procedureName: event.procedureName,
    rx: previewOf(event.rx),
    serviceId: event.serviceId,
    serviceRevision: event.serviceRevision,
    source,
    startedAt: event.startedAt,
    timeout: timeout === undefined ? undefined : Number.isFinite(timeout) ? timeout : 'never',
    tx: previewOf(event.tx),
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
