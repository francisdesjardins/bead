// ── Receiving transfers ───────────────────────────────────────────────────────

// dependencies

import type { IClock, TimeoutId } from '../../transport/shared/clock';
import { gaugesOf } from '../../transport/shared/gauges';
import type { IGauges } from '../../transport/shared/types';
import {
  ChunkOutcome,
  createIncomingTransfer,
  type IChunk,
  type IIncomingTransfer,
} from './transfer';
import type { ICallAddress, IProtocolFailure, IRouterFailures, IRouterLimits } from './types';

// interfaces

/** A transfer this side receives: the call it belongs to, and its bytes as they come. */
export interface IReceiving<Handle extends string> {
  readonly call: ICallAddress<Handle>;
  readonly incoming: IIncomingTransfer;
}

/**
 * What a connection holds of the transfers it receives: those it receives at once, and those whose
 * call's resolver outlives the call.
 */
interface IConnectionTransfers {
  outliving: number;
  transfers: number;
}

/** What a receiving transfer holds, besides its bytes. */
interface IHeld {
  /** Whether the budget admitted it: until then it waits, holding none of it, granted nothing. */
  admitted: boolean;
  /** The transfers its connection receives at once, itself among them. */
  connection: IConnectionTransfers;
  /** Whether its payload went on, whole: it holds no byte of the budget any more. */
  isComplete: boolean;
  /** What hears that the budget admitted it once it waited; none, for one no call waits on. */
  onAdmitted: (() => void) | undefined;
  /** What hears that it waited for the budget too long; none, for one no timer governs. */
  onRefused: ((failure: IProtocolFailure) => void) | undefined;
  /** What hears that it stalled; none, for a transfer no timer governs. */
  onStall: (() => void) | undefined;
  /** The bytes it holds: its opening's, then each chunk's placed, until its payload is whole. */
  received: number;
  /** The bytes of the budget it reserves: its whole total once admitted, none while it waits. */
  reserved: number;
  /** Its wait for the budget, then its inactivity once admitted. */
  timer: TimeoutId | undefined;
  /** Its whole payload's length, as its opening declared it. */
  total: number;
}

/**
 * The transfers a router receives, on every connection: the bytes of its budget they reserve, the
 * places they take on their connection, the credit they grant, and how long each waits.
 */
export interface IReceivingTransfers<Handle extends string> {
  /** The bytes of the budget no transfer reserves. */
  readonly available: number;
  /**
   * Ends a transfer, admitted or waiting: its bytes and its place go back, its timer stops, and the
   * openings that wait for the budget are admitted as it holds them. Ending one that ended already
   * does nothing.
   */
  close(receiving: IReceiving<Handle>): void;
  /**
   * Ends every transfer — `connectionHandle`'s alone, when given — admitted or waiting, before the
   * openings that wait are admitted, so the budget given back admits none about to end with them;
   * those whose call's resolver outlives the call there go with them, and settle to nothing.
   */
  closeAll(connectionHandle?: Handle): void;
  /**
   * The payload of a transfer placed whole: its bytes leave the budget as they leave the router,
   * and its timer stops. Its place on its connection stays until it is closed.
   */
  complete(receiving: IReceiving<Handle>): Uint8Array;
  /**
   * The transfers received and those waiting for the budget, those whose call's resolver outlives
   * the call, the bytes of the budget they reserve, under its ceiling, and the bytes they hold,
   * counted, and their connections.
   */
  gauges(): IGauges<Handle>;
  /** Grants the credit an admitted transfer may, and sends it; one that waits gets nothing. */
  grant(receiving: IReceiving<Handle>): void;
  /** Whether a transfer waits for the budget, admitted to none of it yet. */
  isWaiting(receiving: IReceiving<Handle>): boolean;
  /**
   * Opens a transfer on `call` from its opening, or gives the failure that refuses it, in this
   * order (spec 12.3): `payloadTooLarge` when this side takes no transfer, for a total of 0 or past
   * the payload's limit; `capacityExceeded` when the connection holds its transfers already, or
   * twice as many with those whose call's resolver outlives the call; `chunkInvalid` for an opening
   * that carries no byte of its payload, holds its whole total, or carries other than
   * `openingBytes`, when given. Then the budget admits it, when no opening waits and the budget
   * left holds its total; otherwise it waits for the budget, and `onRefused` hears it past half the
   * inactivity allowed — or it is refused `capacityExceeded` at once, when that half is 0. Given
   * `onStall`, a timer hears the transfer stall when nothing comes for the inactivity allowed once
   * admitted; `onAdmitted` hears it admitted once it waited, before its first credit goes.
   */
  open(
    opening: Uint8Array,
    options: {
      call: ICallAddress<Handle>;
      onAdmitted?: (() => void) | undefined;
      onRefused?: ((failure: IProtocolFailure) => void) | undefined;
      onStall?: (() => void) | undefined;
      openingBytes?: number | undefined;
      total: number;
    }
  ): IReceiving<Handle> | IProtocolFailure;
  /**
   * Ends a transfer whose call ended while its resolver runs on: as `close` does, but its place
   * among the transfers its connection holds with those its resolvers outlive stays until `settle`
   * (spec 12.3). Ending one that ended already does nothing.
   */
  outlive(receiving: IReceiving<Handle>): void;
  /**
   * Places a chunk; what places bytes is progress, and sets the timer going again, unless it makes
   * the payload whole, which stops it.
   */
  place(receiving: IReceiving<Handle>, chunk: IChunk): ChunkOutcome | IProtocolFailure;
  /**
   * The resolver a transfer outlived its call with settled: its place goes back. Settling one that
   * outlives nothing, or whose connection closed, does nothing.
   */
  settle(receiving: IReceiving<Handle>): void;
}

// helpers

/**
 * How long an opening waits for the budget: half of `transferInactivityTimeout`, in whole
 * milliseconds rounded down (spec 12.4).
 */
export const budgetWaitOf = ({
  transferInactivityTimeout,
}: Pick<IRouterLimits, 'transferInactivityTimeout'>): number => {
  return Math.floor(transferInactivityTimeout / 2);
};

// definition

/**
 * The transfers a router receives. Each reserves its whole total of one budget as it is admitted,
 * and keeps it until its payload is whole or it ends, so no credit waits on the budget. An opening
 * the budget left cannot hold, or that comes while another waits, waits in the order the openings
 * came, on every connection, holding its place and its bytes and none of the budget. Each
 * connection receives `maximumTransfers` at once. `sendCredit` sends a credit a transfer is
 * granted; a chunk before the last carries `payloadBytesPerChunk`, exactly, the last that many at
 * most. A transfer's wait and its inactivity run on `clock`.
 */
export const createReceivingTransfers = <Handle extends string>({
  clock,
  failures,
  limits,
  payloadBytesPerChunk,
  sendCredit,
}: {
  clock: IClock;
  failures: Pick<
    IRouterFailures,
    'capacityExceeded' | 'chunkInvalid' | 'creditExceeded' | 'payloadTooLarge'
  >;
  limits: Pick<
    IRouterLimits,
    | 'bufferedBytesBudget'
    | 'maximumChunkRuns'
    | 'maximumPayloadBytes'
    | 'maximumTransfers'
    | 'transferInactivityTimeout'
    | 'windowBytes'
  >;
  payloadBytesPerChunk: number;
  sendCredit: (call: ICallAddress<Handle>, creditEnd: number) => void;
}): IReceivingTransfers<Handle> => {
  // the transfers open, admitted or waiting, and what each holds
  const held = new Map<IReceiving<Handle>, IHeld>();
  // * the openings that wait for the budget, in the order they came, on every connection
  const waiting = new Map<IReceiving<Handle>, IHeld>();
  // the transfers each connection receives at once, and those whose resolvers outlive their call
  const connections = new Map<Handle, IConnectionTransfers>();
  // the transfers whose call's resolver outlives the call, and their connection's
  const outlived = new Map<IReceiving<Handle>, IConnectionTransfers>();
  const budgetWait = budgetWaitOf(limits);
  // the bytes of the budget the admitted reserve, and the bytes every transfer holds
  let reserved = 0;
  let buffered = 0;

  // stops a transfer's timer
  const stop = (state: IHeld): void => {
    clock.clearTimeout(state.timer);
    state.timer = undefined;
  };

  // sets a transfer's timer going again, when one governs it; it keeps no process alive
  const touch = (state: IHeld): void => {
    stop(state);

    if (state.onStall !== undefined) {
      state.timer = clock.setTimeout(state.onStall, limits.transferInactivityTimeout);
      // a browser's timer has no `unref`
      (state.timer as { unref?: () => unknown }).unref?.();
    }
  };

  // gives a transfer's bytes back, and what it reserved of the budget
  const drain = (state: IHeld): void => {
    reserved -= state.reserved;
    buffered -= state.received;
    state.reserved = 0;
    state.received = 0;
  };

  // reserves a transfer's whole total, which it holds until its payload is whole or it ends
  const admit = (state: IHeld): void => {
    state.admitted = true;
    state.reserved = state.total;
    reserved += state.total;
  };

  const grant = (receiving: IReceiving<Handle>): void => {
    const state = held.get(receiving);

    if (state === undefined || !state.admitted || state.isComplete) {
      return;
    }

    const creditEnd = receiving.incoming.creditToGrant();

    if (creditEnd !== undefined) {
      sendCredit(receiving.call, creditEnd);
    }
  };

  // the openings that wait, in the order they came: each the budget left holds is admitted, its
  // wait stopped, its inactivity set going, then its first credit sent; the first it does not hold
  // stops the walk, which none after it passes (spec 12.4)
  const admitWaiting = (): void => {
    // a map's entry deleted as it is visited leaves the others to visit, a walk within this one too
    for (const [receiving, state] of waiting) {
      if (state.total > limits.bufferedBytesBudget - reserved) {
        return;
      }

      waiting.delete(receiving);
      admit(state);
      touch(state);
      state.onAdmitted?.();
      grant(receiving);
    }
  };

  // forgets a connection that holds no transfer, nor one its resolvers outlive
  const release = (connectionHandle: Handle, connection: IConnectionTransfers): void => {
    if (connection.transfers === 0 && connection.outliving === 0) {
      connections.delete(connectionHandle);
    }
  };

  // ends a transfer, admitted or waiting, and gives back what it holds: its bytes, its place, its
  // timer
  const end = (receiving: IReceiving<Handle>, state: IHeld): void => {
    held.delete(receiving);
    waiting.delete(receiving);
    stop(state);
    drain(state);
    state.connection.transfers -= 1;
    release(receiving.call.connectionHandle, state.connection);
  };

  // the failure of an opening the budget did not admit within its wait
  const waitedOf = (total: number): IProtocolFailure => {
    return {
      ...failures.capacityExceeded,
      detail: `a total of ${String(total)} bytes waited ${String(budgetWait)} milliseconds for the budget`,
    };
  };

  return {
    get available() {
      return limits.bufferedBytesBudget - reserved;
    },

    close: (receiving) => {
      const state = held.get(receiving);

      if (state === undefined) {
        return;
      }

      end(receiving, state);
      admitWaiting();
    },
    closeAll: (connectionHandle) => {
      // a map's entry deleted as it is visited leaves the others to visit
      for (const [receiving, state] of held) {
        if (
          connectionHandle === undefined ||
          receiving.call.connectionHandle === connectionHandle
        ) {
          end(receiving, state);
        }
      }

      // * the places its resolvers outlive end with its connection
      for (const [receiving, connection] of outlived) {
        if (
          connectionHandle === undefined ||
          receiving.call.connectionHandle === connectionHandle
        ) {
          outlived.delete(receiving);
          connection.outliving -= 1;
          release(receiving.call.connectionHandle, connection);
        }
      }

      admitWaiting();
    },
    complete: (receiving) => {
      const state = held.get(receiving);
      const payload = receiving.incoming.payload();

      if (state !== undefined) {
        state.isComplete = true;
        stop(state);
        drain(state);
        admitWaiting();
      }

      return payload;
    },
    grant,
    gauges: () => {
      return gaugesOf({
        ceilings: { reservedBytes: limits.bufferedBytesBudget },
        connectionHandles: connections.keys(),
        counts: {
          bufferedBytes: buffered,
          outlivingTransfers: outlived.size,
          receivingTransfers: held.size,
          reservedBytes: reserved,
          waitingTransfers: waiting.size,
        },
      });
    },
    isWaiting: (receiving) => {
      return waiting.has(receiving);
    },
    open: (opening, { call, onAdmitted, onRefused, onStall, openingBytes, total }) => {
      const { connectionHandle } = call;
      const connection = connections.get(connectionHandle) ?? { outliving: 0, transfers: 0 };

      if (limits.maximumTransfers === 0) {
        return { ...failures.payloadTooLarge, detail: 'this peer takes no transfer' };
      }

      if (total === 0) {
        return { ...failures.payloadTooLarge, detail: 'a transfer declares its total, not 0' };
      }

      if (total > limits.maximumPayloadBytes) {
        return {
          ...failures.payloadTooLarge,
          detail: `a payload is ${String(limits.maximumPayloadBytes)} bytes at most, not ${String(total)}`,
        };
      }

      // * checked first: the places its resolvers outlive bound a peer that cancels each transfer it
      // sends (spec 12.3)
      if (connection.transfers + connection.outliving >= 2 * limits.maximumTransfers) {
        return {
          ...failures.capacityExceeded,
          detail: `the transfers a connection receives and those its resolvers outlive are ${String(2 * limits.maximumTransfers)} at most`,
        };
      }

      if (connection.transfers >= limits.maximumTransfers) {
        return {
          ...failures.capacityExceeded,
          detail: `the transfers a connection receives at once are ${String(limits.maximumTransfers)} at most`,
        };
      }

      const incoming = createIncomingTransfer(opening, {
        failures,
        limits,
        payloadBytesPerChunk,
        total,
      });

      if ('code' in incoming) {
        return incoming;
      }

      // ! an opening carries what its sender places in it, to the byte: the budget is reserved by
      // the total it declares, which a full opening prices, and every sender fills its own (spec
      // 12.3)
      if (openingBytes !== undefined && opening.length !== openingBytes) {
        return {
          ...failures.chunkInvalid,
          detail: `an opening carries ${String(openingBytes)} bytes of its payload, not ${String(opening.length)}`,
        };
      }

      // * no opening passes one that waits, though the budget left holds it (spec 12.4)
      const isAdmitted = waiting.size === 0 && total <= limits.bufferedBytesBudget - reserved;

      if (!isAdmitted && budgetWait === 0) {
        return waitedOf(total);
      }

      const receiving: IReceiving<Handle> = { call: { ...call }, incoming };
      const state: IHeld = {
        admitted: false,
        connection,
        isComplete: false,
        onAdmitted,
        onRefused,
        onStall,
        received: opening.length,
        reserved: 0,
        timer: undefined,
        total,
      };

      held.set(receiving, state);
      connection.transfers += 1;
      connections.set(connectionHandle, connection);
      buffered += opening.length;

      if (isAdmitted) {
        admit(state);
        touch(state);

        return receiving;
      }

      waiting.set(receiving, state);

      if (onRefused !== undefined) {
        state.timer = clock.setTimeout(() => {
          onRefused(waitedOf(total));

          // * its end walks the openings that wait, whatever its refusal did with it
          const current = held.get(receiving);

          if (current !== undefined) {
            end(receiving, current);
            admitWaiting();
          }
        }, budgetWait);
        // a browser's timer has no `unref`
        (state.timer as { unref?: () => unknown }).unref?.();
      }

      return receiving;
    },
    outlive: (receiving) => {
      const state = held.get(receiving);

      if (state === undefined) {
        return;
      }

      // counted among those its resolvers outlive before it leaves, so its connection stays
      state.connection.outliving += 1;
      outlived.set(receiving, state.connection);
      end(receiving, state);
      admitWaiting();
    },
    place: (receiving, chunk) => {
      const { bytes, isLast, offset } = chunk;
      const outcome = receiving.incoming.place(bytes, { isLast, offset });
      const state = held.get(receiving);

      if (state === undefined || state.isComplete || typeof outcome === 'object') {
        return outcome;
      }

      // * the chunk that makes the payload whole leaves nothing to wait for (spec 12.6, 12.7)
      if (outcome === ChunkOutcome.COMPLETE) {
        buffered += bytes.length;
        state.received += bytes.length;
        stop(state);
      } else if (outcome === ChunkOutcome.PLACED) {
        buffered += bytes.length;
        state.received += bytes.length;
        touch(state);
      }

      return outcome;
    },
    settle: (receiving) => {
      const connection = outlived.get(receiving);

      if (connection === undefined) {
        return;
      }

      outlived.delete(receiving);
      connection.outliving -= 1;
      release(receiving.call.connectionHandle, connection);
    },
  };
};
