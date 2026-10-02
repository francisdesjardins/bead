// ── Sending transfers ─────────────────────────────────────────────────────────

// dependencies

import { entriesOf, gaugesOf } from '../../transport/shared/gauges';
import type { IGauges } from '../../transport/shared/types';
import type { IChunk, IOutgoingTransfer } from './transfer';
import type { CallId, ICallAddress } from './types';

// interfaces

/** A transfer this side sends: the call it belongs to, and its payload as the credit lets it go. */
export interface ISending<Handle extends string> {
  readonly call: ICallAddress<Handle>;
  readonly outgoing: IOutgoingTransfer;
}

/** A transfer kept, and what it does besides its payload. */
interface IHeld<Handle extends string> {
  /** Whether its chunks still go: none once it ended. */
  isOpen: boolean;
  /** Whether its chunks are going out now: a credit that comes meanwhile only raises its end. */
  isSending: boolean;
  onCredit: () => void;
  send: (chunk: IChunk) => void;
  sending: ISending<Handle>;
}

/** The transfers a router sends, on every connection, each found by its call as a credit comes. */
export interface ISendingTransfers<Handle extends string> {
  /**
   * Ends a transfer: nothing more of it goes, and a credit on its call is for none. Ending one that
   * ended already does nothing.
   */
  close(sending: ISending<Handle>): void;
  /**
   * A credit received on `call`: it raises the end of the transfer sent there, `onCredit` hears it
   * when it did, then the chunks it lets go are sent. A credit that comes while chunks go out only
   * raises the end, which the chunks going out take on; one for no transfer is dropped in silence.
   */
  credit(call: ICallAddress<Handle>, creditEnd: number): void;
  /** The transfers sent, counted, and their connections. */
  gauges(): IGauges<Handle>;
  /**
   * Keeps a transfer of `outgoing` on `call` before its opening goes, so a credit that comes back
   * as the opening goes finds it: `send` hands each chunk to the transport, until the transfer is
   * closed — once its last chunk went, or its call ended.
   */
  open(
    outgoing: IOutgoingTransfer,
    options: {
      call: ICallAddress<Handle>;
      onCredit: () => void;
      send: (chunk: IChunk) => void;
    }
  ): ISending<Handle>;
}

// definition

/**
 * The transfers a router sends. The opening is the sender's own to send; this keeps each transfer
 * from then on, by its connection and its call id — this side's for a request, the peer's for a
 * result — and sends its chunks as the credit comes, until its sender closes it. They hold no
 * budget: the payload is the caller's.
 */
export const createSendingTransfers = <Handle extends string>(): ISendingTransfers<Handle> => {
  // the transfer each call sends, by connection
  const sent = new Map<Handle, Map<CallId, IHeld<Handle>>>();

  // takes a transfer out, unless it is out already
  const end = (sending: ISending<Handle>): void => {
    const { callId, connectionHandle } = sending.call;
    const calls = sent.get(connectionHandle);
    const held = calls?.get(callId);

    if (calls === undefined || held?.sending !== sending) {
      return;
    }

    held.isOpen = false;
    calls.delete(callId);

    if (calls.size === 0) {
      sent.delete(connectionHandle);
    }
  };

  // sends the chunks the credit lets go, one after the other, while the transfer is open
  const pump = (held: IHeld<Handle>): void => {
    if (held.isSending) {
      return;
    }

    held.isSending = true;

    while (held.isOpen) {
      const chunk = held.sending.outgoing.nextChunk();

      if (chunk === undefined) {
        break;
      }

      held.send(chunk);
    }

    held.isSending = false;
  };

  return {
    close: end,
    credit: ({ callId, connectionHandle }, creditEnd) => {
      const held = sent.get(connectionHandle)?.get(callId);

      if (held === undefined) {
        return;
      }

      const { outgoing } = held.sending;
      const previous = outgoing.creditEnd;

      outgoing.grant(creditEnd);

      // late, repeated, or lower: it grants nothing
      if (outgoing.creditEnd === previous) {
        return;
      }

      held.onCredit();
      pump(held);
    },
    gauges: () => {
      return gaugesOf({
        connectionHandles: sent.keys(),
        counts: { sendingTransfers: entriesOf(sent) },
      });
    },
    open: (outgoing, { call, onCredit, send }) => {
      const { callId, connectionHandle } = call;
      const sending: ISending<Handle> = { call: { callId, connectionHandle }, outgoing };
      const calls = sent.get(connectionHandle) ?? new Map<CallId, IHeld<Handle>>();

      calls.set(callId, { isOpen: true, isSending: false, onCredit, send, sending });
      sent.set(connectionHandle, calls);

      return sending;
    },
  };
};
