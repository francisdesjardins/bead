import { expect, test } from '@playwright/test';
import { laterTask, nextTask } from '../later-task';

test.describe('laterTask', () => {
  test('runs in a later task, after the microtasks of this one, and a cancel runs nothing', async () => {
    const order: string[] = [];

    laterTask(() => {
      order.push('task');
    });

    const cancel = laterTask(() => {
      order.push('cancelled');
    });

    cancel();
    queueMicrotask(() => {
      order.push('microtask');
    });
    order.push('now');
    await nextTask();
    await nextTask();

    expect(order).toEqual(['now', 'microtask', 'task']);
  });

  test('runs by a MessageChannel’s message where the platform has no setImmediate', async () => {
    const { clearImmediate, setImmediate } = globalThis;
    const order: string[] = [];
    let cancel: () => void = () => {
      return undefined;
    };

    // ! a page's platform: its immediate taken away while the tasks are asked for
    Reflect.deleteProperty(globalThis, 'setImmediate');

    try {
      laterTask(() => {
        order.push('task');
      });
      cancel = laterTask(() => {
        order.push('cancelled');
      });
      queueMicrotask(() => {
        order.push('microtask');
      });
    } finally {
      Object.assign(globalThis, { clearImmediate, setImmediate });
    }

    cancel();
    cancel();

    for (let task = 0; task < 10 && order.length < 2; task += 1) {
      await nextTask();
    }

    expect(order).toEqual(['microtask', 'task']);
  });
});
