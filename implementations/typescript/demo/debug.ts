/* oxlint-disable no-console -- a developer's debug switch: the console is where it writes */
// ── Demo debug switch ─────────────────────────────────────────────────────────

// What a developer turns on from the console, as the `debug` package reads `localStorage.debug`: a
// filter in the `DEBUG` convention under `bead:debug` — `*` for every call, `d(rx), t(n), -token`
// for less, and an `e(…)` selector for the envelopes too — and the page logs what it keeps to the
// console; removed, it stops. Nothing to reload: the key is read each second.
//
// A listener only queues: the console is written when the page is idle, one collapsed group at a
// time, since an open console that renders an object per event is what slows a page through a
// burst. While it is off, it listens to nothing: a router with no other listener builds no `debug`
// event at all.

// dependencies

import type { IClient } from '../src/client/types';
import { filterEnvelopeDebug } from '../src/router/client/router-client';
import type { IRouterDebugInfo } from '../src/router/client/types';
import { EnvelopeKind } from '../src/router/shared/constants';
import { filterDebug } from '../src/router/shared/service-manager';
import type { IDebugEvent, IProcedure, IProcedureAddress } from '../src/router/shared/types';

// constants

/** The key a developer sets, in the page's `localStorage`. */
export const DEBUG_KEY = 'bead:debug';

/** How often the key is read, in milliseconds. */
const CHECK_MILLISECONDS = 1_000;

/** How long what is queued waits for the page to be idle, at most, in milliseconds. */
const IDLE_TIMEOUT = 250;

/** The events queued at most; past them, the next write says how many it left out. */
const MAXIMUM_QUEUED = 500;

/** The events one write holds at most, so no write holds the page long; the rest waits for the next. */
const EVENTS_PER_WRITE = 50;

// an `e(…)` selector among the words of a spec: the envelopes are asked for
const ENVELOPES_ASKED = /(?:^|[\s,])e\(/;

// helpers

/** The filter the key holds; `null` when it holds none, or when the page may keep no storage. */
const filterSpecOf = (): string | null => {
  try {
    return localStorage.getItem(DEBUG_KEY);
  } catch {
    return null;
  }
};

/**
 * Whether an envelope belongs to a call of one of `procedures`, known by its call id while the call
 * is open: its request names its procedure, and the rest of it carries the call id alone. Each
 * listener keeps its own, since each hears the envelopes in order.
 */
export const createQuietCalls = (
  procedures: readonly IProcedureAddress[]
): ((info: IRouterDebugInfo) => boolean) => {
  const open = new Set<number>();

  return ({ header }) => {
    if (header.kind === EnvelopeKind.REQUEST) {
      const isQuiet = procedures.some(({ procedureId, serviceId }) => {
        return header.procedureId === procedureId && header.serviceId === serviceId;
      });

      return isQuiet ? (open.add(header.callId), true) : false;
    }

    if (!open.has(header.callId)) {
      return false;
    }

    // its answer, or its cancel, ends the call
    if (
      header.kind === EnvelopeKind.RESULT ||
      header.kind === EnvelopeKind.FAILURE ||
      header.kind === EnvelopeKind.CANCEL
    ) {
      open.delete(header.callId);
    }

    return true;
  };
};

/**
 * A console written later: what each event says is queued as it comes, and written when the page
 * is idle, {@link EVENTS_PER_WRITE} at a time — one line alone, or several in one collapsed group
 * that says how many more are to come. Past {@link MAXIMUM_QUEUED}, a group says how many it left
 * out.
 */
const createIdleConsole = (): ((label: string, detail: unknown) => void) => {
  const queued: [label: string, detail: unknown][] = [];
  let leftOut = 0;
  let isScheduled = false;

  const schedule = (): void => {
    if (isScheduled) {
      return;
    }

    isScheduled = true;

    // a browser without idle callbacks writes a little later all the same
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(write, { timeout: IDLE_TIMEOUT });
    } else {
      setTimeout(write, IDLE_TIMEOUT);
    }
  };

  const write = (): void => {
    const lines = queued.splice(0, EVENTS_PER_WRITE);
    const left = leftOut;
    const [only] = lines;

    leftOut = 0;
    isScheduled = false;

    if (queued.length > 0) {
      schedule();
    }

    if (lines.length === 1 && only !== undefined && left === 0) {
      return (console.debug(...only), undefined);
    }

    console.groupCollapsed(
      [
        `bead: ${String(lines.length)} events`,
        ...(queued.length === 0 ? [] : [`${String(queued.length)} more to come`]),
        ...(left === 0 ? [] : [`${String(left)} left out`]),
      ].join(', ')
    );

    for (const [label, detail] of lines) {
      console.debug(label, detail);
    }

    console.groupEnd();
  };

  return (label, detail) => {
    if (queued.length < MAXIMUM_QUEUED) {
      queued.push([label, detail]);
    } else {
      leftOut += 1;
    }

    schedule();
  };
};

// definition

/**
 * Watches {@link DEBUG_KEY} for `client`: set, the calls its filter keeps go to the console, and the
 * envelopes too when it asks for them by `e(…)`, each under `bead`, its direction and its kind —
 * those of the `quiet` procedures aside; removed, the listeners go too.
 *
 * @example
 * localStorage.setItem('bead:debug', 'd(rx), counter'); // the counter's calls that come in
 * localStorage.setItem('bead:debug', '*, e(notification)'); // every call, and the notifications
 * localStorage.removeItem('bead:debug'); // quiet again
 */
export const watchDebug = (client: IClient, { quiet }: { quiet: readonly IProcedure[] }): void => {
  const write = createIdleConsole();
  const quietNames = new Set(
    quiet.map(({ procedureName }) => {
      return procedureName;
    })
  );
  const isQuiet = createQuietCalls(quiet);
  // what the key held when last read: the filter is read from it, never from the storage per event
  let spec: string | null = null;
  const specOf = (): string => {
    return spec ?? '';
  };

  const onCall = filterDebug((error: unknown, event: IDebugEvent) => {
    const { direction, procedureName, rx, timestamp, tx, type } = event;

    if (!quietNames.has(procedureName)) {
      write(`bead ${direction} ${type} ${procedureName}`, {
        duration: timestamp.duration,
        error,
        rx,
        tx,
      });
    }
  }, specOf);
  const envelopes = filterEnvelopeDebug((info: IRouterDebugInfo) => {
    write(`bead ${info.direction} envelope`, info.header);
  }, specOf);
  // the quiet calls are followed on every envelope, those the filter leaves out included
  const onEnvelope = (info: IRouterDebugInfo): void => {
    if (!isQuiet(info)) {
      envelopes(info);
    }
  };
  const listening = { calls: false, envelopes: false };

  // listening follows the key, so a page that debugs nothing pays nothing
  const check = (): void => {
    spec = filterSpecOf();

    const calls = spec !== null;
    const envelopesToo = spec !== null && ENVELOPES_ASKED.test(spec);

    if (calls !== listening.calls) {
      listening.calls = calls;

      if (calls) {
        client.services.on('debug', onCall);
        console.info(`bead: debug on, "${specOf()}"; removeItem('${DEBUG_KEY}') stops it`);
      } else {
        client.services.off('debug', onCall);
        console.info('bead: debug off');
      }
    }

    if (envelopesToo !== listening.envelopes) {
      listening.envelopes = envelopesToo;

      if (envelopesToo) {
        client.router.on('debug', onEnvelope);
      } else {
        client.router.off('debug', onEnvelope);
      }
    }
  };

  check();
  setInterval(check, CHECK_MILLISECONDS);
  // another tab of the same site changed it
  addEventListener('storage', check);
};
