import { expect, test } from '@playwright/test';
import { createEmitter } from '../emitter';
import { createEventIterator } from '../event-iterator';

test.describe('createEventIterator', () => {
  test("yields each event's arguments in order, buffering those not read yet", async () => {
    const emitter = createEmitter<{ message: [data: string, n: number] }>();
    const events = createEventIterator(emitter, { event: 'message' });

    emitter.emit('message', 'a', 1);
    emitter.emit('message', 'b', 2);

    await expect(events.next()).resolves.toEqual({ done: false, value: ['a', 1] });
    await expect(events.next()).resolves.toEqual({ done: false, value: ['b', 2] });

    const later = events.next();
    emitter.emit('message', 'c', 3);
    await expect(later).resolves.toEqual({ done: false, value: ['c', 3] });
  });

  test('answers the reads made ahead of the events in order, and ends each still pending', async () => {
    const emitter = createEmitter<{ message: [data: string] }>();
    const events = createEventIterator(emitter, { event: 'message' });

    const reads = [events.next(), events.next(), events.next(), events.next()];

    emitter.emit('message', 'a');
    emitter.emit('message', 'b');
    await events.return?.();

    expect(await Promise.all(reads)).toEqual([
      { done: false, value: ['a'] },
      { done: false, value: ['b'] },
      { done: true, value: undefined },
      { done: true, value: undefined },
    ]);
  });

  test('a "break" ends it and takes its listener away', async () => {
    const emitter = createEmitter<{ message: [data: string] }>();
    const seen: string[] = [];

    queueMicrotask(() => {
      emitter.emit('message', 'a');
      emitter.emit('message', 'stop');
    });

    for await (const [data] of createEventIterator(emitter, { event: 'message' })) {
      seen.push(data);
      if (data === 'stop') {
        break;
      }
    }

    expect(seen).toEqual(['a', 'stop']);
    expect(emitter.emit('message', 'unheard')).toBe(false);
  });

  test('its signal ends a pending read, and one already aborted ends it at once', async () => {
    const emitter = createEmitter<{ message: [] }>();
    const controller = new AbortController();
    const events = createEventIterator(emitter, { event: 'message', signal: controller.signal });

    const pending = events.next();
    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
    expect(emitter.emit('message')).toBe(false);

    const never = createEventIterator(emitter, { event: 'message', signal: AbortSignal.abort() });
    await expect(never.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
