import { expect, test } from '@playwright/test';
import { createSendingTransfers, type ISendingTransfers } from '../sending-transfers';
import { createOutgoingTransfer, type IChunk } from '../transfer';
import type { ICallAddress } from '../types';

// helpers

type Handle = 'a' | 'b';

/**
 * A transfer of 200 bytes opened on `call` — its opening 40 of them, each chunk 48 — which records
 * the offset of each chunk it sends, and each credit it hears; `onSend` runs as a chunk goes.
 */
const openOn = (
  sendings: ISendingTransfers<Handle>,
  { call, onSend }: { call: ICallAddress<Handle>; onSend?: ((chunk: IChunk) => void) | undefined }
) => {
  const credits: number[] = [];
  const offsets: number[] = [];
  const outgoing = createOutgoingTransfer(new Uint8Array(200), {
    openingBytes: 40,
    payloadBytesPerChunk: 48,
  });
  const sending = sendings.open(outgoing, {
    call,
    onCredit: () => {
      credits.push(outgoing.creditEnd);
    },
    send: (chunk) => {
      offsets.push(chunk.offset);
      onSend?.(chunk);
    },
  });

  return { credits, offsets, sending };
};

// definition

test.describe('createSendingTransfers', () => {
  test('sends nothing before a credit, then the chunks each one lets go, to its total', () => {
    const sendings = createSendingTransfers<Handle>();
    const call = { callId: 1, connectionHandle: 'a' } as const;
    const { credits, offsets } = openOn(sendings, { call });

    expect(offsets).toEqual([]);

    sendings.credit(call, 168);

    expect(offsets).toEqual([40, 88]);

    sendings.credit(call, 200);
    // past its total, a credit grants nothing more
    sendings.credit(call, 400);

    expect(offsets).toEqual([40, 88, 136, 184]);
    expect(credits).toEqual([168, 200]);
  });

  test('drops a credit that grants nothing, and one that comes for no transfer', () => {
    const sendings = createSendingTransfers<Handle>();
    const call = { callId: 1, connectionHandle: 'a' } as const;
    const { credits, offsets } = openOn(sendings, { call });

    sendings.credit(call, 100);
    // lower, and the same again
    sendings.credit(call, 90);
    sendings.credit(call, 100);
    // another call on its connection, and another connection
    sendings.credit({ callId: 3, connectionHandle: 'a' }, 200);
    sendings.credit({ callId: 1, connectionHandle: 'b' }, 200);

    expect(offsets).toEqual([40]);
    expect(credits).toEqual([100]);
  });

  test('takes a credit that comes as its chunks go out as a raise alone, which they take on', () => {
    const sendings = createSendingTransfers<Handle>();
    const call = { callId: 1, connectionHandle: 'a' } as const;
    let depth = 0;
    let deepest = 0;
    const { credits, offsets } = openOn(sendings, {
      call,
      // a transport that credits a chunk more before each chunk's send returns
      onSend: ({ offset }) => {
        depth += 1;
        deepest = Math.max(deepest, depth);
        sendings.credit(call, offset + 96);
        depth -= 1;
      },
    });

    sendings.credit(call, 88);

    // each chunk once, in order, and none sent inside another's send
    expect(offsets).toEqual([40, 88, 136, 184]);
    expect(credits).toEqual([88, 136, 184, 200]);
    expect(deepest).toBe(1);
  });

  test('sends nothing more of a transfer once ended, even as a credit’s chunks go out', () => {
    const sendings = createSendingTransfers<Handle>();
    const call = { callId: 1, connectionHandle: 'a' } as const;
    const other = { callId: 3, connectionHandle: 'a' } as const;
    // ended as its first chunk goes, by what that chunk's send brings back
    const ended = openOn(sendings, {
      call,
      onSend: () => {
        sendings.close(ended.sending);
      },
    });
    const kept = openOn(sendings, { call: other });

    sendings.credit(call, 200);

    expect(ended.offsets).toEqual([40]);

    // ended already, with a transfer left on its connection, then none
    sendings.close(ended.sending);
    sendings.credit(other, 200);
    sendings.close(kept.sending);
    sendings.close(kept.sending);

    expect(kept.offsets).toEqual([40, 88, 136, 184]);
  });

  test('closes no transfer but its own: not one opened on its call since', () => {
    const sendings = createSendingTransfers<Handle>();
    const call = { callId: 1, connectionHandle: 'a' } as const;
    const before = openOn(sendings, { call });
    const after = openOn(sendings, { call });

    // the one before ends late, once another took its call
    sendings.close(before.sending);
    sendings.credit(call, 88);

    expect([before.offsets, after.offsets]).toEqual([[], [40]]);
  });

  test('counts the transfers sent, and the connections they go to', () => {
    const sendings = createSendingTransfers<Handle>();
    const { sending } = openOn(sendings, { call: { callId: 1, connectionHandle: 'a' } });

    openOn(sendings, { call: { callId: 3, connectionHandle: 'a' } });

    expect(sendings.gauges()).toMatchObject({
      connectionHandles: new Set(['a']),
      counts: { sendingTransfers: 2 },
    });

    sendings.close(sending);

    expect(sendings.gauges().counts).toEqual({ sendingTransfers: 1 });
  });
});
