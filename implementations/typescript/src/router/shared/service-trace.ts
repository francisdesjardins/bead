// ── Service trace ─────────────────────────────────────────────────────────────

// dependencies

import type { IClock } from '../../transport/shared/clock';
import { SERVER_CONNECTION_HANDLE } from './constants';
import { FailureError } from './errors';
import type {
  CallId,
  DebugDirection,
  DebugType,
  IDebugEvent,
  IFailure,
  IProcedure,
  IResolvedRequestOptions,
  RouterSide,
} from './types';

// interfaces

/**
 * When a call started, on its router's clock: the wall clock's instant it reports, and the
 * monotonic reading its duration counts from.
 */
export interface IStarted {
  instant: number;
  timestamp: number;
}

/** One step of a call, as `trace` tells it to `debug`. */
export interface ITraceStep<Handle extends string> {
  /** Its call's id: a call made's once its router drew it, a request received's from its header. */
  callId?: CallId | undefined;
  /** The connection the call came from or goes to, which a listener's error is reported with. */
  connectionHandle?: Handle | undefined;
  direction: DebugDirection;
  error?: unknown;
  /** Whether the call has answered, so the step carries how long it took. */
  isAnswered?: boolean | undefined;
  options?: IResolvedRequestOptions | undefined;
  rx?: unknown;
  /** When its call started: every step of one call carries the same. */
  started: IStarted;
  tx?: unknown;
  type: DebugType;
}

/** A call made while someone listens: its steps' common part, and the id its router drew. */
export interface ITracedCall<Handle extends string> {
  /** Its router's id for it, once `onCallId` heard it; none while it has not. */
  callId: CallId | undefined;
  /** What its router's `request` is handed, to hear the id it draws. */
  readonly onCallId: (callId: CallId) => void;
  readonly step: Omit<ITraceStep<Handle>, 'direction'>;
}

/** What the trace tells: whether anyone listens to `debug`, and how an event reaches them. */
export interface ITraceObserver<Handle extends string> {
  isDebugging: () => boolean;
  emit: (event: {
    error: unknown;
    info: IDebugEvent;
    connectionHandle: Handle | undefined;
  }) => void;
}

/**
 * The steps a call tells `debug`: whether anyone listens, the start of a call and of a notification,
 * and each step, told with its connection, its duration, its failure and its payloads.
 */
export interface IServiceTrace<Handle extends string> {
  /** Whether anyone listens to `debug`: the one check a call makes while nobody does. */
  isDebugging: () => boolean;
  /** Now, for a notification sent or heard: one step, which takes no duration. */
  notifiedNow: () => IStarted;
  /** Now, for a call starting: the wall clock for its start, the monotonic reading for its duration. */
  startedNow: () => IStarted;
  /** Tells `debug` one step of a call; what a listener throws changes nothing of the call. */
  trace: (procedure: IProcedure, step: ITraceStep<Handle>) => void;
}

// helpers

/** The failure a failed call carries, for `debug`; `undefined` when it carries none. */
export const tracedFailureOf = (reason: unknown): IFailure | undefined => {
  if (!(reason instanceof FailureError)) {
    return undefined;
  }

  const { code, detail, scope } = reason;

  return { code, detail, scope };
};

/** A call made, traced from `step`, which hears the id its router draws. */
export const tracedCallOf = <Handle extends string>(
  step: Omit<ITraceStep<Handle>, 'direction'>
): ITracedCall<Handle> => {
  // ! apart from `callOf`, and called only while someone listens: a closure made in that async
  // body would hold its locals in a context V8 makes at every call, listened to or not
  const traced: ITracedCall<Handle> = {
    callId: undefined,
    onCallId: (callId) => {
      traced.callId = callId;
    },
    step,
  };

  return traced;
};

/** A copy for `debug`, or the value itself when it cannot be cloned: a trace never fails a call. */
const snapshot = (value: unknown): unknown => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

// definition

/**
 * The trace of one service manager, on its router's `clock`: each step told to its `observer`'s
 * listeners, the server named on a client, the router's `side` read at each step.
 */
export const createServiceTrace = <Handle extends string>(
  observer: ITraceObserver<Handle>,
  { clock, side }: { clock: IClock; side: () => RouterSide }
): IServiceTrace<Handle> => {
  // now, for a call starting, traced: the wall clock for its start, the monotonic for its duration
  const startedNow = (): IStarted => {
    return { instant: clock.Date.now(), timestamp: clock.performance.now() };
  };

  // now, for a notification sent or heard, traced: one step, which takes no duration
  const notifiedNow = (): IStarted => {
    return { instant: clock.Date.now(), timestamp: 0 };
  };

  // tells `debug` about one step of a call, each listener within a guard: what one throws is
  // reported through the router, with the call's connection, and changes nothing of the call
  const trace = (procedure: IProcedure, step: ITraceStep<Handle>): void => {
    if (!observer.isDebugging()) {
      return;
    }

    const { callId, connectionHandle, direction, error = null, isAnswered = false } = step;
    const { options, rx, started, tx, type } = step;
    // ! the credential a call presents stays out of what is told: its token, or what its transport
    // carries, never reaches a listener
    const { credential: _credential, ...told } = options ?? {};

    observer.emit({
      connectionHandle,
      error,
      info: {
        callId,
        // a step names its connection with its call, the server on a client, and none without
        connectionHandle:
          callId === undefined
            ? undefined
            : (connectionHandle ?? (side() === 'client' ? SERVER_CONNECTION_HANDLE : undefined)),
        direction,
        duration: isAnswered ? Math.trunc(clock.performance.now() - started.timestamp) : undefined,
        options: options === undefined ? undefined : (told as IResolvedRequestOptions),
        procedureId: procedure.procedureId,
        procedureName: procedure.procedureName,
        rx: snapshot(rx),
        serviceId: procedure.serviceId,
        serviceRevision: procedure.serviceRevision,
        startedAt: started.instant,
        tx: snapshot(tx),
        type,
      },
    });
  };

  return { isDebugging: observer.isDebugging, notifiedNow, startedNow, trace };
};
