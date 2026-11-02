import { expect, test } from '@playwright/test';
import { createEmitter } from '../../../transport/shared/emitter';
import { createTelling, toldOf } from '../telling';

// definition

test.describe('createTelling', () => {
  test('tells within a scope that nests, and gives what its listener returns, or throws', () => {
    const telling = createTelling();
    const seen: boolean[] = [telling.isTelling()];

    const value = telling.heard(() => {
      seen.push(telling.isTelling());

      return telling.heard(() => {
        seen.push(telling.isTelling());

        return 'told';
      });
    });

    expect(value).toBe('told');
    expect(() => {
      telling.heard(() => {
        throw new Error('a listener failed');
      });
    }).toThrow('a listener failed');
    seen.push(telling.isTelling());

    expect(seen).toEqual([false, true, true, false]);
  });

  // spec 9.0; decision 0045
  test('runs an operation at once outside a telling, and within one in a later turn, behind what the turn deferred before it', async () => {
    const telling = createTelling();
    const order: string[] = [];

    await telling.later(() => {
      order.push('at once');

      return Promise.resolve();
    });
    telling.defer(() => {
      order.push('deferred at once');
    });

    let made: Promise<string> | undefined;

    telling.heard(() => {
      queueMicrotask(() => {
        order.push('deferred by the turn');
      });
      made = telling.later(() => {
        order.push('made within the turn');

        return Promise.resolve('made');
      });
      telling.defer(() => {
        order.push('a dispose within the turn');
      });
      order.push('the turn sends');
    });

    await expect(made).resolves.toBe('made');
    expect(order).toEqual([
      'at once',
      'deferred at once',
      'the turn sends',
      'deferred by the turn',
      'made within the turn',
      'a dispose within the turn',
    ]);
  });

  test('rejects what an operation taken in a later turn throws', async () => {
    const telling = createTelling();
    const failed = telling.heard(() => {
      return telling.later((): Promise<void> => {
        throw new Error('it failed');
      });
    });

    await expect(failed).rejects.toThrow('it failed');
  });
});

test.describe('toldOf', () => {
  test('emits within its telling, guarded or not, and leaves the rest of its emitter as it is', () => {
    const telling = createTelling();
    const emitter = toldOf(createEmitter<{ told: [number] }>(), telling);
    const heard: [number, boolean][] = [];
    const listener = (value: number) => {
      heard.push([value, telling.isTelling()]);
    };

    emitter.on('told', listener);
    emitter.emit('told', 1);
    emitter.emitEach('told', {
      onError: (error) => {
        throw error;
      },
      params: [2],
    });

    expect(emitter.listenerCount('told')).toBe(1);
    emitter.off('told', listener);
    emitter.emit('told', 3);

    expect(heard).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(telling.isTelling()).toBe(false);
  });
});
