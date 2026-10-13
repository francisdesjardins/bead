import { expect, test } from '@playwright/test';
import { EnvelopeKind } from '../../../src/router/shared/constants';
import type { IEnvelopeRecord } from '../../messages';
import type { ICall } from '../calls';
import { BEAD_STEP, THREAD_BEADS, THREAD_TOP, threadOf } from '../thread';
import { trafficCall } from './book';

// definition

test.describe('threadOf', () => {
  test('lays a call’s envelopes out in the order they were heard, each in words with what it carried, its time after the first', () => {
    const thread = threadOf(trafficCall('counter'));

    expect(
      thread.beads.map(({ kind, offset, words }) => {
        return [kind, offset, words];
      })
    ).toEqual([
      ['REQUEST', 0, 'paced subscription'],
      ['RESULT', 4, '{"value": 41}'],
      ['NOTIFICATION', 18, '{"value": 42}'],
      ['CREDIT', 19, 'up to 2 notifications'],
      ['NOTIFICATION', 48, '{"value": 47}'],
      ['CREDIT', 50, 'up to 3 notifications'],
      ['FAILURE', 1_785, ''],
    ]);
    expect(thread.beads[0]?.y).toBe(THREAD_TOP + BEAD_STEP / 2);
    expect(thread.notes).toEqual([expect.objectContaining({ kind: 'pause', value: 1_735 })]);
  });

  test('gives a relayed call its leg beyond the relay, after its request, and its failure’s code', () => {
    const thread = threadOf(trafficCall('relayed'));

    expect(thread.destinationId).toBe(7);
    expect(thread.notes).toEqual([expect.objectContaining({ kind: 'beyond', value: 7 })]);
    expect(thread.beads[1]?.words).toBe('ACCESS_DENIED, beyond 1 relay');
  });

  test('draws a call of many envelopes by its first and its last, and says how many it left out', () => {
    const many: IEnvelopeRecord[] = Array.from({ length: THREAD_BEADS + 20 }, (_, index) => {
      return {
        at: index,
        connectionHandle: 'server',
        direction: 'rx',
        header: { callId: 1, isLast: false, kind: EnvelopeKind.CHUNK, offset: index },
        kind: 'envelope',
        source: 1,
      };
    });
    const call: ICall = { ...trafficCall('download'), envelopes: many, request: undefined };
    const thread = threadOf(call);

    expect(thread.beads).toHaveLength(THREAD_BEADS);
    expect(thread.notes).toEqual([expect.objectContaining({ kind: 'left out', value: 20 })]);
  });
});
