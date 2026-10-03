// ── Pending calls ─────────────────────────────────────────────────────────────

// dependencies

import {
  assertHeld,
  type IClock,
  LONGEST_TIMER,
  type TimeoutId,
} from '../../transport/shared/clock';
import { ProgrammerError } from '../../transport/shared/errors';
import { entriesOf, gaugesOf } from '../../transport/shared/gauges';
import type { IGauges } from '../../transport/shared/types';
import { CALL_ID_RANGES, RESERVATION_MILLISECONDS } from './constants';
import { createSequence } from './identifiers';
import type { IReceiving } from './receiving-transfers';
import type { ISending } from './sending-transfers';
import type {
  CallId,
  ConnectionHandle,
  DestinationId,
  ICallAddress,
  IProcedureAddress,
  IResultHeader,
  IRouterCoreOptions,
  IRouterCorePort,
  IRouterResult,
} from './types';

// interfaces

/**
 * A request waiting for its response: where it went, for a failure to say so, whether the transport
 * has it, how long it was given, for its call id to stay reserved once it is cancelled; the bytes its
 * result holds at most; the transfer it goes as, while it does, and the one its result comes in,
 * once opened; and the timer that ends it.
 */
export interface IPendingRequest<Handle extends string = ConnectionHandle> {
  destinationId: DestinationId | undefined;
  isSent: boolean;
  maximumPayloadBytes: number;
  /** What hears the request handed to the transport, and the transport refuse it, if it does. */
  onSent?: ((isHanded: boolean) => void) | undefined;
  procedureAddress: IProcedureAddress;
  receiving?: IResultReceiving<Handle> | undefined;
  reject: (reason: Error) => void;
  resolve: (result: IRouterResult) => void;
  sending?: ISending<Handle> | undefined;
  timeout: number | undefined;
  timer?: TimeoutId | undefined;
}

/** A result that comes in a transfer: the header that opened it, and its transfer. */
export interface IResultReceiving<Handle extends string> {
  header: IResultHeader;
  transfer: IReceiving<Handle>;
}

/** A call id reserved: when it is free again, on its clock's monotonic reading, and what frees it. */
interface IReservation {
  ends: number;
  timer: TimeoutId;
}

/** The calls one side opened and waits on, and the call ids it reserved, by connection. */
export interface IPendingCalls<Handle extends string> {
  add(call: ICallAddress<Handle>, pendingRequest: IPendingRequest<Handle>): void;
  /**
   * A call id of this side's for `connectionHandle`, skipping those waited on, reserved, or in use
   * by the side; `undefined` once every one is.
   */
  draw(connectionHandle: Handle): CallId | undefined;
  /** Takes a call out — only while `only` is its request, when given. */
  forget(call: ICallAddress<Handle>, only?: IPendingRequest<Handle>): void;
  /** The calls waited on and the call ids reserved, counted, and their connections. */
  gauges(): IGauges<Handle>;
  get(call: ICallAddress<Handle>): IPendingRequest<Handle> | undefined;
  isReserved(callId: CallId, connectionHandle: Handle): boolean;
  /**
   * Reserves a call id for `timeout`, or for the default time when it is none a timer can hold;
   * reserved twice, the later end stands. Nothing waits on a reservation: it keeps no process alive.
   */
  reserve(call: ICallAddress<Handle> & { timeout?: number | undefined }): void;
  /**
   * Takes out every call waited on and every call id reserved — `connectionHandle`'s alone, when
   * given — and gives the requests that were waiting, for the caller to reject.
   */
  takeAll(connectionHandle?: Handle): IPendingRequest<Handle>[];
}

// constants

// helpers

/**
 * Throws a {@link ProgrammerError} for a reservation no timer holds: past {@link LONGEST_TIMER},
 * which a timer would end at once, or under a millisecond, `NaN` among them. None, one not above 0,
 * or `Infinity`, takes the default.
 */
export const assertReservation = (timeout: number | undefined): void => {
  if (timeout === undefined || timeout <= 0) {
    return;
  }

  if (Number.isFinite(timeout) && timeout > LONGEST_TIMER) {
    throw new ProgrammerError(
      `a call id is reserved ${String(LONGEST_TIMER)} milliseconds at most, as a timer holds, not ${String(timeout)}`
    );
  }

  assertHeld("a call id's reservation", timeout);
};

/** How long a call id stays reserved: its call's timeout, or the default one when it had none. */
export const reservationOf = (timeout: number | undefined): number => {
  return timeout !== undefined &&
    Number.isFinite(timeout) &&
    timeout > 0 &&
    timeout <= LONGEST_TIMER
    ? timeout
    : RESERVATION_MILLISECONDS;
};

// definition

/**
 * The calls a side of a router opened, by connection and call id, from the moment their call id is
 * drawn until they settle; and the call ids it reserved once a call ended unanswered, so what comes
 * late on one is known for late, and no call drawn meanwhile takes it. Call ids are drawn odd or
 * even, as the side's `failures` say, from the first once past the last.
 *
 * `onRemove` hears each call as it leaves, once, whichever way it leaves, for what it holds to go
 * with it. A reservation runs on `clock`, and its end is compared on its monotonic reading.
 */
export const createPendingCalls = <Handle extends string>(
  port: Pick<IRouterCorePort<Handle>, 'failures' | 'isCallIdInUse'>,
  options: Pick<IRouterCoreOptions, 'lastCallId'> & {
    clock: IClock;
    onRemove?: ((pendingRequest: IPendingRequest<Handle>) => void) | undefined;
  }
): IPendingCalls<Handle> => {
  const { clock } = options;
  const range = CALL_ID_RANGES[port.failures.side];
  const nextCallId = createSequence({
    first: range.first,
    last: options.lastCallId ?? range.last,
    step: range.step,
  });
  const pending = new Map<Handle, Map<CallId, IPendingRequest<Handle>>>();
  const reservations = new Map<Handle, Map<CallId, IReservation>>();

  // takes a call out of `calls` — only while `only` is its entry, when given — and its connection's
  // map once empty; gives the entry taken out
  const forgetIn = <Entry>(
    calls: Map<Handle, Map<CallId, Entry>>,
    { callId, connectionHandle, only }: ICallAddress<Handle> & { only?: Entry | undefined }
  ): Entry | undefined => {
    const entries = calls.get(connectionHandle);
    const entry = entries?.get(callId);

    if (entries === undefined || entry === undefined || (only !== undefined && entry !== only)) {
      return undefined;
    }

    entries.delete(callId);

    if (entries.size === 0) {
      calls.delete(connectionHandle);
    }

    return entry;
  };

  const isReserved = (callId: CallId, connectionHandle: Handle): boolean => {
    return reservations.get(connectionHandle)?.has(callId) === true;
  };

  return {
    add: ({ callId, connectionHandle }, pendingRequest) => {
      const requests = pending.get(connectionHandle) ?? new Map<CallId, IPendingRequest<Handle>>();

      requests.set(callId, pendingRequest);
      pending.set(connectionHandle, requests);
    },
    draw: (connectionHandle) => {
      return nextCallId((candidate) => {
        return (
          pending.get(connectionHandle)?.has(candidate) === true ||
          isReserved(candidate, connectionHandle) ||
          port.isCallIdInUse?.(candidate, connectionHandle) === true
        );
      });
    },
    forget: (call, only) => {
      const pendingRequest = forgetIn(pending, { ...call, only });

      if (pendingRequest !== undefined) {
        options.onRemove?.(pendingRequest);
      }
    },
    gauges: () => {
      return gaugesOf({
        connectionHandles: [...pending.keys(), ...reservations.keys()],
        counts: { pendingCalls: entriesOf(pending), reservedCallIds: entriesOf(reservations) },
      });
    },
    get: ({ callId, connectionHandle }) => {
      return pending.get(connectionHandle)?.get(callId);
    },
    isReserved,
    reserve: ({ callId, connectionHandle, timeout }) => {
      const lasts = reservationOf(timeout);
      const ends = clock.performance.now() + lasts;
      const reserved = reservations.get(connectionHandle) ?? new Map<CallId, IReservation>();
      const previous = reserved.get(callId);

      if (previous !== undefined && previous.ends >= ends) {
        return;
      }

      clock.clearTimeout(previous?.timer);

      const reservation: IReservation = {
        ends,
        timer: clock.setTimeout(() => {
          forgetIn(reservations, { callId, connectionHandle, only: reservation });
        }, lasts),
      };

      // a browser's timer has no `unref`
      (reservation.timer as { unref?: () => unknown }).unref?.();
      reserved.set(callId, reservation);
      reservations.set(connectionHandle, reserved);
    },
    takeAll: (connectionHandle) => {
      const valuesOf = <Entry>(calls: Map<Handle, Map<CallId, Entry>>): Entry[] => {
        return (
          connectionHandle === undefined ? [...calls.values()] : [calls.get(connectionHandle)]
        ).flatMap((entries) => {
          return [...(entries?.values() ?? [])];
        });
      };
      const waiting = valuesOf(pending);

      for (const reservation of valuesOf(reservations)) {
        clock.clearTimeout(reservation.timer);
      }

      for (const calls of [pending, reservations]) {
        if (connectionHandle === undefined) {
          calls.clear();
        } else {
          calls.delete(connectionHandle);
        }
      }

      for (const pendingRequest of waiting) {
        options.onRemove?.(pendingRequest);
      }

      return waiting;
    },
  };
};
