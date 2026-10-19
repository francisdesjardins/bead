// ── Answering calls ───────────────────────────────────────────────────────────

// dependencies

import type { IClock, TimeoutId } from '../../transport/shared/clock';
import { entriesOf, gaugesOf } from '../../transport/shared/gauges';
import type { IGauges } from '../../transport/shared/types';
import { LIMIT_DEFAULTS } from './constants';
import { CallEnding, type IProcedureSeries, microsecondsOf } from './metrics-registry';
import type { CallId, ICallAddress, IHandedRequestHeader, IRouterLimits } from './types';

// interfaces

/** A request as it was dispatched: the connection it came from, and its header. */
interface IDispatchedRequest<Handle extends string> {
  connectionHandle: Handle;
  header: IHandedRequestHeader;
}

/**
 * A call to answer: its controller, whether its answer is going out, and what it receives of its
 * payload, while it does; and, counted, its series, the monotonic reading it started at, and whether
 * it ended.
 */
interface IAnswering<Receiving> {
  controller: AbortController;
  isAnswered: boolean;
  isEnded: boolean;
  receiving: Receiving | undefined;
  series: IProcedureSeries | undefined;
  startedAt: number;
}

/** A call whose transfer ended: the end its credit reached, and what forgets it. */
interface IAbandoned {
  creditEnd: number;
  timer: TimeoutId;
}

/** What a call receives of its payload: a transfer, and the end of the credit it granted so far. */
interface IReceivingCredit {
  readonly creditEnd: number;
}

/** The calls the peer opened that this side has not answered yet, by connection. */
export interface IAnsweringCalls<
  Handle extends string,
  Receiving extends IReceivingCredit = IReceivingCredit,
> {
  /**
   * The end the credit of a call abandoned reached: what comes under it is late, what comes past it
   * was never granted. `undefined` for a call not abandoned.
   */
  abandonedEndOf(call: ICallAddress<Handle>): number | undefined;
  /**
   * Marks the call of a request answered as its answer goes out: a second answer goes nowhere, and
   * the call stays until that answer closes it, or its requester cancels it, or its connection goes.
   */
  answer(request: IDispatchedRequest<Handle>): void;
  /** Gives a call what it receives of its payload, until the call leaves. */
  attach(call: ICallAddress<Handle>, receiving: Receiving): void;
  /** Takes out the call `controller` is for — none that took its call id since. */
  close(call: ICallAddress<Handle>, controller: AbortController): void;
  /** The controller of the request dispatched with `header`; `undefined` for one never dispatched. */
  controllerOf(header: IHandedRequestHeader): AbortController | undefined;
  /**
   * Counts the call of a request ended, as `ending` says — its answer handed to its transport, say
   * — once, into the series it was opened with; nothing for a call that counts none.
   */
  end(request: IDispatchedRequest<Handle>, ending: CallEnding): void;
  /** The calls answered and those abandoned, counted, and their connections. */
  gauges(): IGauges<Handle>;
  /** Whether the peer's call is open on `call`'s call id, whichever request opened it. */
  has(call: ICallAddress<Handle>): boolean;
  /**
   * Whether the call of a request is still to be answered: once its answer goes out, or it is
   * cancelled, or gone with its connection, it is not. A request never dispatched is taken as one to
   * answer.
   */
  isAnswering(request: IDispatchedRequest<Handle>): boolean;
  /**
   * Opens the call of a request as it is dispatched, and gives the controller made for it; a call
   * abandoned on its call id is forgotten. Given `series`, the call starts there now, timed from now,
   * and ends there once: as `end` says, else cancelled as it is taken, closed as every call is, and
   * an error as it is closed unanswered.
   */
  open(request: IDispatchedRequest<Handle>, series?: IProcedureSeries): AbortController;
  /** What a call receives of its payload; `undefined` for a call that receives none. */
  receivingOf(call: ICallAddress<Handle>): Receiving | undefined;
  /** Takes a call out, and gives its controller. */
  take(call: ICallAddress<Handle>): AbortController | undefined;
  /**
   * Takes out every call — `connectionHandle`'s alone, when given — and gives their controllers,
   * for the caller to abort; the calls abandoned go with them, and none is abandoned.
   */
  takeAll(connectionHandle?: Handle): AbortController[];
}

// definition

/**
 * The calls the peer opened and this side still owes an answer, by connection and call id, each
 * with its own controller. A controller does two jobs: its signal is the resolver's, aborted when
 * the call is cancelled or its connection goes; and it tells one call from another on the same call
 * id, so an answer settles the call its request opened and no other.
 *
 * A request is found again by its header, the very object dispatched: an answer given a copy of it
 * finds no call, and goes out whatever became of the call it was for.
 *
 * What a call receives of its payload leaves with the call, whichever way the call leaves:
 * `onRemove` hears it then, once. A call that received a transfer and ends — answered, refused,
 * cancelled — stays abandoned for the inactivity a transfer is allowed, since what its credit let
 * the peer send may still come, a copy or out of order; the oldest of a connection's yields once it
 * keeps `maximumTransfers`, one at least, and the inactivity runs on `clock`. A call that goes with
 * its connection is abandoned by none.
 */
export const createAnsweringCalls = <
  Handle extends string,
  Receiving extends IReceivingCredit = IReceivingCredit,
>(options: {
  clock: IClock;
  limits?: Pick<IRouterLimits, 'maximumTransfers' | 'transferInactivityTimeout'> | undefined;
  onRemove?: ((receiving: Receiving) => void) | undefined;
}): IAnsweringCalls<Handle, Receiving> => {
  const { clock } = options;
  const { maximumTransfers, transferInactivityTimeout } = options.limits ?? LIMIT_DEFAULTS;
  const answering = new Map<Handle, Map<CallId, IAnswering<Receiving>>>();
  // the controller of each request dispatched, by its header
  const dispatched = new WeakMap<IHandedRequestHeader, AbortController>();
  const abandoned = new Map<Handle, Map<CallId, IAbandoned>>();

  // forgets a call abandoned, and its timer
  const forgetAbandoned = ({ callId, connectionHandle }: ICallAddress<Handle>): void => {
    const calls = abandoned.get(connectionHandle);
    const entry = calls?.get(callId);

    if (calls === undefined || entry === undefined) {
      return;
    }

    clock.clearTimeout(entry.timer);
    calls.delete(callId);

    if (calls.size === 0) {
      abandoned.delete(connectionHandle);
    }
  };

  // counts a call ended, once, timed to now
  const ended = (entry: IAnswering<Receiving>, ending: CallEnding): void => {
    if (entry.series === undefined || entry.isEnded) {
      return;
    }

    entry.isEnded = true;
    entry.series.end(ending, microsecondsOf(clock.performance.now() - entry.startedAt));
  };

  // keeps a call abandoned until its timer fires, the oldest of its connection's yielding
  const abandon = ({ callId, connectionHandle }: ICallAddress<Handle>, creditEnd: number): void => {
    const calls = abandoned.get(connectionHandle) ?? new Map<CallId, IAbandoned>();

    for (const oldest of calls.keys()) {
      if (calls.size < maximumTransfers) {
        break;
      }

      forgetAbandoned({ callId: oldest, connectionHandle });
    }

    const timer = clock.setTimeout(() => {
      forgetAbandoned({ callId, connectionHandle });
    }, transferInactivityTimeout);

    // a browser's timer has no `unref`
    (timer as { unref?: () => unknown }).unref?.();
    calls.set(callId, { creditEnd, timer });
    abandoned.set(connectionHandle, calls);
  };

  // takes a call out — only while `only` is its controller, when given — and its connection's map
  // once empty; what it received leaves with it, its call abandoned — `takeAll` forgets that too
  const forget = (
    { callId, connectionHandle }: ICallAddress<Handle>,
    only?: AbortController
  ): IAnswering<Receiving> | undefined => {
    const calls = answering.get(connectionHandle);
    const entry = calls?.get(callId);

    if (
      calls === undefined ||
      entry === undefined ||
      (only !== undefined && entry.controller !== only)
    ) {
      return undefined;
    }

    calls.delete(callId);

    if (calls.size === 0) {
      answering.delete(connectionHandle);
    }

    if (entry.receiving !== undefined) {
      abandon({ callId, connectionHandle }, entry.receiving.creditEnd);
      options.onRemove?.(entry.receiving);
    }

    return entry;
  };

  return {
    abandonedEndOf: ({ callId, connectionHandle }) => {
      return abandoned.get(connectionHandle)?.get(callId)?.creditEnd;
    },
    answer: ({ connectionHandle, header }) => {
      const entry = answering.get(connectionHandle)?.get(header.callId);

      if (entry !== undefined && entry.controller === dispatched.get(header)) {
        entry.isAnswered = true;
      }
    },
    attach: ({ callId, connectionHandle }, receiving) => {
      const entry = answering.get(connectionHandle)?.get(callId);

      if (entry !== undefined) {
        entry.receiving = receiving;
      }
    },
    close: (call, controller) => {
      const entry = forget(call, controller);

      // closed before its end was counted, it ends with no answer handed to its transport
      if (entry !== undefined) {
        ended(entry, CallEnding.ERROR);
      }
    },
    controllerOf: (header) => {
      return dispatched.get(header);
    },
    end: ({ connectionHandle, header }, ending) => {
      const entry = answering.get(connectionHandle)?.get(header.callId);

      if (entry !== undefined && entry.controller === dispatched.get(header)) {
        ended(entry, ending);
      }
    },
    gauges: () => {
      return gaugesOf({
        connectionHandles: [...answering.keys(), ...abandoned.keys()],
        counts: { abandonedCalls: entriesOf(abandoned), answeringCalls: entriesOf(answering) },
      });
    },
    has: ({ callId, connectionHandle }) => {
      return answering.get(connectionHandle)?.has(callId) === true;
    },
    isAnswering: ({ connectionHandle, header }) => {
      const controller = dispatched.get(header);
      const entry = answering.get(connectionHandle)?.get(header.callId);

      return controller === undefined || (entry?.controller === controller && !entry.isAnswered);
    },
    open: ({ connectionHandle, header }, series) => {
      const controller = new AbortController();
      const calls = answering.get(connectionHandle) ?? new Map<CallId, IAnswering<Receiving>>();

      series?.start();
      forgetAbandoned({ callId: header.callId, connectionHandle });
      calls.set(header.callId, {
        controller,
        isAnswered: false,
        isEnded: false,
        receiving: undefined,
        series,
        startedAt: series === undefined ? 0 : clock.performance.now(),
      });
      dispatched.set(header, controller);
      answering.set(connectionHandle, calls);

      return controller;
    },
    receivingOf: ({ callId, connectionHandle }) => {
      return answering.get(connectionHandle)?.get(callId)?.receiving;
    },
    take: (call) => {
      const entry = forget(call);

      if (entry !== undefined) {
        ended(entry, CallEnding.CANCELLED);
      }

      return entry?.controller;
    },
    takeAll: (connectionHandle) => {
      const connections =
        connectionHandle === undefined
          ? new Set([...answering.keys(), ...abandoned.keys()])
          : [connectionHandle];
      const controllers: AbortController[] = [];

      for (const handle of connections) {
        for (const [callId, entry] of answering.get(handle)?.entries() ?? []) {
          forget({ callId, connectionHandle: handle });
          ended(entry, CallEnding.CLOSED);
          controllers.push(entry.controller);
        }

        // a map's entry deleted as it is visited leaves the others to visit
        for (const callId of abandoned.get(handle)?.keys() ?? []) {
          forgetAbandoned({ callId, connectionHandle: handle });
        }
      }

      return controllers;
    },
  };
};
