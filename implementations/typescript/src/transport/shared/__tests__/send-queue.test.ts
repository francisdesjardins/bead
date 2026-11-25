import { expect, test } from '@playwright/test';
import { createSendQueue, SOCKET_MARK, type IQueuedSocketLike } from '../send-queue';
import type { Data } from '../types';

test('settles queued sends and releases their byte count when its socket fails', () => {
  const sent: Data[] = [];
  let written: ((error?: Error) => void) | undefined;
  const socket: IQueuedSocketLike & { readyState: number } = {
    bufferedAmount: SOCKET_MARK,
    readyState: 1,
    send: (data, callback) => {
      sent.push(data);
      written = callback;
    },
  };
  const queue = createSendQueue(socket);
  queue.send(Uint8Array.of(1, 2, 3), 3);
  queue.send(Uint8Array.of(4, 5), 2);
  queue.send(Uint8Array.of(6), 1);

  expect(queue.heldBytes).toBe(3);
  expect(sent).toEqual([Uint8Array.of(1, 2, 3)]);
  socket.readyState = 3;
  written?.(new Error('the socket fails'));

  expect(queue.heldBytes).toBe(0);
  expect(sent).toEqual([Uint8Array.of(1, 2, 3)]);
});
