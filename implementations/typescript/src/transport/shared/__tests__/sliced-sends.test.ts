// ── Sliced sends ──────────────────────────────────────────────────────────────

// dependencies

import { expect, test } from '@playwright/test';
import { LARGEST_PAGE_MESSAGE, withSlicedSends } from '../sliced-sends';

// definition

test.describe('withSlicedSends', () => {
  test('sends what a page’s WebSocket is given in order, in messages of 16 KiB at most, none empty', () => {
    const sent: (string | Uint8Array)[] = [];
    const socket = withSlicedSends({
      send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        sent.push(typeof data === 'string' ? data : new Uint8Array(data as Uint8Array));
      },
    });
    const given = Uint8Array.from({ length: 2 * LARGEST_PAGE_MESSAGE + 100 }, (_, index) => {
      return index % 251;
    });

    expect(LARGEST_PAGE_MESSAGE).toBe(16_384);
    // a view of a larger buffer, as MQTT.js's Buffer is, its own bytes alone
    socket.send(new Uint8Array([9, ...given, 9]).subarray(1, given.length + 1));
    expect(
      sent.map((message) => {
        return message.length;
      })
    ).toEqual([LARGEST_PAGE_MESSAGE, LARGEST_PAGE_MESSAGE, 100]);
    expect(
      new Uint8Array(
        (sent as Uint8Array[]).flatMap((message) => {
          return [...message];
        })
      )
    ).toEqual(given);

    sent.length = 0;
    socket.send(new Uint8Array(0));
    socket.send(Uint8Array.of(1, 2, 3).buffer);
    socket.send('text');
    expect(sent).toEqual([Uint8Array.of(1, 2, 3), 'text']);
  });
});
