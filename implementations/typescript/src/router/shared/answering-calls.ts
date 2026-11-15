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
  /**
   * Sets the run of `connectionHandle`'s refusals past the calls it has this side answer and those
   * its resolvers outlive back to none: a request reached step 3 of spec 9.2 and was not refused
   * there past both.
   */
  admitted(connectionHandle: Handle): void;
  /** Takes out the call `controller` is for — none that took its call id since. */
  close(call: ICallAddress<Handle>, controller: AbortController): void;
  /** The controller of the request dispatched with `header`; `undefined` for one never dispatched. */
  controllerOf(header: IHandedRequestHeader): AbortController | undefined;
  /** The calls `connectionHandle`'s peer has this side answer now; those abandoned not among them. */
  countOn(connectionHandle: Handle): number;
  /**
   * Counts the call of a request ended, as `ending` says — its answer handed to its transport, say
   * — once, into the series it was opened with; nothing for a call that counts none.
   */
  end(request: IDispatchedRequest<Handle>, ending: CallEnding): void;
  /**
   * The calls answered and those abandoned, counted, and their connections; the resolvers that
   * outlive their call, those of connections closed among them; the busiest connection's calls,
   * under their ceiling, `maximumAnsweringCalls`; and the busiest connection's calls with the
   * resolvers that outlive its calls, under theirs, twice as many.
   */
  gauges(): IGauges<Handle>;
  /** Whether the peer's call is open on `call`'s call id, whichever request opened it. */
  has(call: ICallAddress<Handle>): boolean;
  /**
   * Whether the call of a request is still to be answered: once its answer goes out, or it is
   * cancelled, or gone with its connection, it is not. A request never dispatched is open to none:
   * a copy of its header finds no call.
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
  /**
   * Adds one to the run of `connectionHandle`'s refusals past the calls it has this side answer and
   * those its resolvers outlive, and gives the run, as it is now.
   */
  refusedPast(connectionHandle: Handle): number;
  /**
   * Marks the resolver of the call `controller` is for running — or its verifier, while its
   * credential resolves — and whether it may: `false` for a call that ended before its turn came,
   * whose resolver is handed nothing (spec 9.2, step 9).
   */
  run(controller: AbortController): boolean;
  /**
   * The resolver of the call `controller` is for settled: one that outlived its call gives its
   * place back, on its connection or among those of connections closed; one whose call is open
   * runs no more. Settling one not running does nothing.
   */
  settle(controller: AbortController): void;
  /** Takes a call out, and gives its controller. */
  take(call: ICallAddress<Handle>): AbortController | undefined;
  /**
   * Takes out every call — `connectionHandle`'s alone, when given — and gives their controllers,
   * for the caller to abort, with those of the resolvers that outlive their call there and are not
   * aborted yet (spec 9.10); the calls abandoned go with them, and none is abandoned. Each call is
   * counted closed once all are out; the resolvers still running there are counted among those of
   * connections closed until they settle, and the connection's run of refusals ends.
   */
  takeAll(connectionHandle?: Handle): AbortController[];
  /** The calls `connectionHandle`'s peer has this side answer now, and those its resolvers outlive. */
  trackedOn(connectionHandle: Handle): number;
}

// definition

/**
 * The calls the peer opened and this side still owes an answer, by connection and call id, each
 * with its own controller. A controller does two jobs: its signal is the resolver's, aborted when
 * the call is cancelled or its connection goes; and it tells one call from another on the same call
 * id, so an answer settles the call its request opened and no other.
 *
 * A request is found again by its header, the very object dispatched: an answer given a copy of it
 * finds no call, and is refused.
 *
 * What a call receives of its payload leaves with the call, whichever way the call leaves:
 * `onRemove` hears it then, once. A call that received a transfer and ends — answered, refused,
 * cancelled — stays abandoned for the inactivity a transfer is allowed, since what its credit let
 * the peer send may still come, a copy or out of order; the oldest of a connection's yields once it
 * keeps `maximumTransfers`, one at least, and the inactivity runs on `clock`. A call that goes with
 * its connection is abandoned by none.
 *
 * A resolver marked running whose call ends, answered or cancelled, outlives it: it keeps a place
 * on its connection until it settles, as Go's HTTP/2 server counts a handler until it returns, so
 * a peer that cancels each request it sends has no more resolvers run on a connection than twice
 * `maximumAnsweringCalls` (spec 9.2, step 3). What its call received then outlives it with it:
 * `onOutlive` hears it in place of `onRemove`, and `onSettle` once that resolver settles. Once its
 * connection closes, it counts among the resolvers of connections closed, by no connection, until
 * it settles.
 */
export const createAnsweringCalls = <
  Handle extends string,
  Receiving extends IReceivingCredit = IReceivingCredit,
>(options: {
  clock: IClock;
  limits?:
    | (Pick<IRouterLimits, 'maximumTransfers' | 'transferInactivityTimeout'> &
        Partial<Pick<IRouterLimits, 'maximumAnsweringCalls'>>)
    | undefined;
  onOutlive?: ((receiving: Receiving) => void) | undefined;
  onRemove?: ((receiving: Receiving) => void) | undefined;
  onSettle?: ((receiving: Receiving) => void) | undefined;
}): IAnsweringCalls<Handle, Receiving> => {
  const { clock } = options;
  const {
    maximumAnsweringCalls = LIMIT_DEFAULTS.maximumAnsweringCalls,
    maximumTransfers,
    transferInactivityTimeout,
  } = options.limits ?? LIMIT_DEFAULTS;
  const answering = new Map<Handle, Map<CallId, IAnswering<Receiving>>>();
  // the controller of each request dispatched, by its header
  const dispatched = new WeakMap<IHandedRequestHeader, AbortController>();
  const abandoned = new Map<Handle, Map<CallId, IAbandoned>>();
  // ! each by its controller, never by its handle: a connection opened again under the same handle
  // — a client's, reconnected — holds nothing a resolver of the one before gives back
  // the controllers whose call is open, and the connection of each controller opened
  const opened = new WeakSet<AbortController>();
  const connectionOf = new WeakMap<AbortController, Handle>();
  // the controllers whose resolver, or verifier, runs
  const running = new WeakSet<AbortController>();
  // by connection, the resolvers that outlive their call, each with what its call received
  const outliving = new Map<Handle, Map<AbortController, Receiving | undefined>>();
  // the resolvers that outlive a connection closed, and how many
  const outlivingClosed = new WeakSet<AbortController>();
  let closedCount = 0;
  // by connection, its refusals in a row past what it answers and its resolvers outlive
  const runs = new Map<Handle, number>();

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
    opened.delete(entry.controller);

    if (calls.size === 0) {
      answering.delete(connectionHandle);
    }

    const { controller, receiving } = entry;

    // * its resolver still running, it outlives the call, and keeps its place until it settles,
    // with what the call received (spec 9.2, step 3)
    if (running.has(controller)) {
      const resolvers =
        outliving.get(connectionHandle) ?? new Map<AbortController, Receiving | undefined>();

      resolvers.set(controller, receiving);
      outliving.set(connectionHandle, resolvers);
    }

    if (receiving !== undefined) {
      abandon({ callId, connectionHandle }, receiving.creditEnd);

      if (running.has(controller)) {
        options.onOutlive?.(receiving);
      } else {
        options.onRemove?.(receiving);
      }
    }

    return entry;
  };

  // the resolvers that outlive their call on `connectionHandle`
  const outlivingOn = (connectionHandle: Handle): number => {
    return outliving.get(connectionHandle)?.size ?? 0;
  };

  return {
    abandonedEndOf: ({ callId, connectionHandle }) => {
      return abandoned.get(connectionHandle)?.get(callId)?.creditEnd;
    },
    admitted: (connectionHandle) => {
      runs.delete(connectionHandle);
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
    countOn: (connectionHandle) => {
      return answering.get(connectionHandle)?.size ?? 0;
    },
    end: ({ connectionHandle, header }, ending) => {
      const entry = answering.get(connectionHandle)?.get(header.callId);

      if (entry !== undefined && entry.controller === dispatched.get(header)) {
        ended(entry, ending);
      }
    },
    gauges: () => {
      let largestAnsweringCalls = 0;
      let largestTrackedCalls = 0;

      // * the busiest connection's, under its ceiling: the health warns before its first refusal
      for (const { size } of answering.values()) {
        largestAnsweringCalls = Math.max(largestAnsweringCalls, size);
      }

      for (const handle of new Set([...answering.keys(), ...outliving.keys()])) {
        largestTrackedCalls = Math.max(
          largestTrackedCalls,
          (answering.get(handle)?.size ?? 0) + outlivingOn(handle)
        );
      }

      return gaugesOf({
        ceilings: {
          largestAnsweringCalls: maximumAnsweringCalls,
          largestTrackedCalls: 2 * maximumAnsweringCalls,
        },
        connectionHandles: [...answering.keys(), ...abandoned.keys(), ...outliving.keys()],
        counts: {
          abandonedCalls: entriesOf(abandoned),
          answeringCalls: entriesOf(answering),
          largestAnsweringCalls,
          largestTrackedCalls,
          outlivingResolvers: entriesOf(outliving) + closedCount,
        },
      });
    },
    has: ({ callId, connectionHandle }) => {
      return answering.get(connectionHandle)?.has(callId) === true;
    },
    isAnswering: ({ connectionHandle, header }) => {
      const controller = dispatched.get(header);
      const entry = answering.get(connectionHandle)?.get(header.callId);

      return controller !== undefined && entry?.controller === controller && !entry.isAnswered;
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
      opened.add(controller);
      connectionOf.set(controller, connectionHandle);
      answering.set(connectionHandle, calls);

      return controller;
    },
    receivingOf: ({ callId, connectionHandle }) => {
      return answering.get(connectionHandle)?.get(callId)?.receiving;
    },
    refusedPast: (connectionHandle) => {
      const run = (runs.get(connectionHandle) ?? 0) + 1;

      runs.set(connectionHandle, run);

      return run;
    },
    // ! checked and marked in one step, at the head of the later turn: a call that ended before it
    // hands its resolver nothing, as Go's HTTP/2 server starts no handler for a stream reset first
    run: (controller) => {
      if (!opened.has(controller)) {
        return false;
      }

      running.add(controller);

      return true;
    },
    settle: (controller) => {
      if (!running.has(controller)) {
        return;
      }

      running.delete(controller);

      const handle = connectionOf.get(controller);
      const resolvers = handle === undefined ? undefined : outliving.get(handle);

      // one whose connection closed counts by none, and gives its place back there alone
      if (outlivingClosed.has(controller)) {
        outlivingClosed.delete(controller);
        closedCount -= 1;

        return;
      }

      if (handle === undefined || resolvers?.has(controller) !== true) {
        return;
      }

      const receiving = resolvers.get(controller);

      resolvers.delete(controller);

      if (resolvers.size === 0) {
        outliving.delete(handle);
      }

      if (receiving !== undefined) {
        options.onSettle?.(receiving);
      }
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
          ? new Set([...answering.keys(), ...abandoned.keys(), ...outliving.keys(), ...runs.keys()])
          : [connectionHandle];
      const taken: IAnswering<Receiving>[] = [];
      // the resolvers that outlived their call there before, its signal not aborted yet
      const told: AbortController[] = [];

      for (const handle of connections) {
        const before = [...(outliving.get(handle)?.keys() ?? [])];

        for (const [callId, entry] of answering.get(handle)?.entries() ?? []) {
          forget({ callId, connectionHandle: handle });
          taken.push(entry);
        }

        // a map's entry deleted as it is visited leaves the others to visit
        for (const callId of abandoned.get(handle)?.keys() ?? []) {
          forgetAbandoned({ callId, connectionHandle: handle });
        }

        // * every resolver still running there counts by no connection until it settles, and the
        // connection's counts end with it (spec 9.10)
        for (const controller of outliving.get(handle)?.keys() ?? []) {
          outlivingClosed.add(controller);
          closedCount += 1;
        }

        for (const controller of before) {
          if (!controller.signal.aborted) {
            told.push(controller);
          }
        }

        outliving.delete(handle);
        runs.delete(handle);
      }

      // each counted once every one is out, so none is counted while another is still held
      for (const entry of taken) {
        ended(entry, CallEnding.CLOSED);
      }

      return [
        ...taken.map(({ controller }) => {
          return controller;
        }),
        ...told,
      ];
    },
    trackedOn: (connectionHandle) => {
      return (answering.get(connectionHandle)?.size ?? 0) + outlivingOn(connectionHandle);
    },
  };
};
