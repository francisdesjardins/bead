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

/** What a receiving transfer holds, besides its bytes. */
interface IHeld {
  /** The transfers its connection receives at once, itself among them. */
  connection: { transfers: number };
  /** Whether its payload went on, whole: it holds no byte of the budget any more. */
  isComplete: boolean;
  /** What hears that it stalled; none, for a transfer no timer governs. */
  onStall: (() => void) | undefined;
  /** The bytes of the budget it holds: its opening's, then each credit's. */
  reserved: number;
  timer: TimeoutId | undefined;
}

/**
 * The transfers a router receives, on every connection: the bytes they hold of its budget, the
 * places they take on their connection, the credit they grant, and how long each waits.
 */
export interface IReceivingTransfers<Handle extends string> {
  /** The bytes of the budget no transfer holds. */
  readonly available: number;
  /**
   * Ends a transfer: its bytes and its place go back, its timer stops, and the transfers the budget
   * starved of credit are granted theirs. Ending one that ended already does nothing.
   */
  close(receiving: IReceiving<Handle>): void;
  /**
   * Ends every transfer — `connectionHandle`'s alone, when given — before the transfers the budget
   * starved are granted theirs, so no credit goes to a transfer about to end with them.
   */
  closeAll(connectionHandle?: Handle): void;
  /**
   * The payload of a transfer placed whole: its bytes leave the budget as they leave the router,
   * and its timer stops. Its place on its connection stays until it is closed.
   */
  complete(receiving: IReceiving<Handle>): Uint8Array;
  /** The transfers received and the bytes of the budget they hold, counted, and their connections. */
  gauges(): IGauges<Handle>;
  /** Grants the credit a transfer may, within the budget left, and sends it. */
  grant(receiving: IReceiving<Handle>): void;
  /**
   * Opens a transfer on `call` from its opening, or gives the failure that refuses it:
   * `payloadTooLarge` when this side takes no transfer, for a total of 0 or past the payload's
   * limit; `capacityExceeded` when the connection holds its transfers already, or the budget cannot
   * hold the opening; `chunkInvalid` for an opening that holds its whole total. Given `onStall`, a
   * timer hears the transfer stall when nothing comes for the inactivity allowed.
   */
  open(
    opening: Uint8Array,
    options: { call: ICallAddress<Handle>; onStall?: (() => void) | undefined; total: number }
  ): IReceiving<Handle> | IProtocolFailure;
  /** Places a chunk; what places bytes is progress, and sets the timer going again. */
  place(receiving: IReceiving<Handle>, chunk: IChunk): ChunkOutcome | IProtocolFailure;
}

// definition

/**
 * The transfers a router receives. Their bytes share one budget, reserved as each credit grants
 * them — the opening's first — so an opening holds only what its peer sends, and a transfer the
 * budget cannot credit waits until another gives some back. Each connection receives
 * `maximumTransfers` at once. `sendCredit` sends a credit a transfer is granted; a chunk before the
 * last carries `payloadBytesPerChunk`, exactly, the last that many at most. A transfer's inactivity
 * runs on `clock`.
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
  // the transfers open, and what each holds
  const held = new Map<IReceiving<Handle>, IHeld>();
  // the transfers each connection receives at once
  const connections = new Map<Handle, { transfers: number }>();
  let buffered = 0;

  // sets a transfer's timer going again, when one governs it; it keeps no process alive
  const touch = (state: IHeld): void => {
    clock.clearTimeout(state.timer);

    if (state.onStall !== undefined) {
      state.timer = clock.setTimeout(state.onStall, limits.transferInactivityTimeout);
      // a browser's timer has no `unref`
      (state.timer as { unref?: () => unknown }).unref?.();
    }
  };

  // gives a transfer's bytes back to the budget
  const drain = (state: IHeld): void => {
    buffered -= state.reserved;
    state.reserved = 0;
  };

  const grant = (receiving: IReceiving<Handle>): void => {
    const state = held.get(receiving);

    if (state === undefined || state.isComplete) {
      return;
    }

    const previous = receiving.incoming.creditEnd;
    const creditEnd = receiving.incoming.creditToGrant(limits.bufferedBytesBudget - buffered);

    if (creditEnd === undefined) {
      return;
    }

    buffered += creditEnd - previous;
    state.reserved += creditEnd - previous;
    sendCredit(receiving.call, creditEnd);
  };

  // what the budget gave back goes to the transfers it starved, in the order they opened
  const grantStarved = (): void => {
    for (const receiving of held.keys()) {
      grant(receiving);
    }
  };

  // ends a transfer, and gives back what it holds: its bytes, its place, its timer
  const end = (receiving: IReceiving<Handle>, state: IHeld): void => {
    held.delete(receiving);
    clock.clearTimeout(state.timer);
    drain(state);
    state.connection.transfers -= 1;

    if (state.connection.transfers === 0) {
      connections.delete(receiving.call.connectionHandle);
    }
  };

  return {
    get available() {
      return limits.bufferedBytesBudget - buffered;
    },

    close: (receiving) => {
      const state = held.get(receiving);

      if (state === undefined) {
        return;
      }

      end(receiving, state);
      grantStarved();
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

      grantStarved();
    },
    complete: (receiving) => {
      const state = held.get(receiving);
      const payload = receiving.incoming.payload();

      if (state !== undefined) {
        state.isComplete = true;
        clock.clearTimeout(state.timer);
        drain(state);
        grantStarved();
      }

      return payload;
    },
    grant,
    gauges: () => {
      return gaugesOf({
        ceilings: { bufferedBytes: limits.bufferedBytesBudget },
        connectionHandles: connections.keys(),
        counts: { bufferedBytes: buffered, receivingTransfers: held.size },
      });
    },
    open: (opening, { call, onStall, total }) => {
      const { connectionHandle } = call;
      const connection = connections.get(connectionHandle) ?? { transfers: 0 };
      const available = limits.bufferedBytesBudget - buffered;

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

      if (connection.transfers >= limits.maximumTransfers) {
        return {
          ...failures.capacityExceeded,
          detail: `the transfers a connection receives at once are ${String(limits.maximumTransfers)} at most`,
        };
      }

      if (opening.length > available) {
        return {
          ...failures.capacityExceeded,
          detail: `the transfers received hold the budget but ${String(available)} bytes`,
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

      const receiving: IReceiving<Handle> = { call: { ...call }, incoming };
      const state: IHeld = {
        connection,
        isComplete: false,
        onStall,
        reserved: opening.length,
        timer: undefined,
      };

      held.set(receiving, state);
      connection.transfers += 1;
      connections.set(connectionHandle, connection);
      buffered += opening.length;
      touch(state);

      return receiving;
    },
    place: (receiving, { bytes, isLast, offset }) => {
      const outcome = receiving.incoming.place(bytes, { isLast, offset });
      const state = held.get(receiving);

      if (
        state !== undefined &&
        (outcome === ChunkOutcome.PLACED || outcome === ChunkOutcome.COMPLETE)
      ) {
        touch(state);
      }

      return outcome;
    },
  };
};
