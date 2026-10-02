import { expect, test } from '@playwright/test';
import { createEmitter } from '../emitter';
import { noop } from '../noop';

const counter = () => {
  let count = 0;
  return {
    listener: () => {
      count += 1;
    },
    count: () => {
      return count;
    },
  };
};

test.describe('createEmitter', () => {
  test('calls listeners in registration order with the emitted arguments', () => {
    const emitter = createEmitter<{ close: [clean: boolean, isQuick: boolean] }>();
    const calls: string[] = [];

    emitter.on('close', (clean, quick) => {
      calls.push(`a:${String(clean)}:${String(quick)}`);
    });
    emitter.on('close', () => {
      calls.push('b');
    });

    expect(emitter.emit('close', true, false)).toBe(true);
    expect(calls).toEqual(['a:true:false', 'b']);
  });

  test('reports that nobody listened', () => {
    const emitter = createEmitter<{ message: [] }>();
    expect(emitter.emit('message')).toBe(false);
  });

  test('"off" of a listener never registered leaves the registered ones alone', () => {
    const emitter = createEmitter<{ message: [] }>();
    const registered = counter();

    emitter.off('message', () => {});
    emitter.on('message', registered.listener);
    emitter.off('message', () => {});
    emitter.emit('message');

    expect(registered.count()).toBe(1);
  });

  test('"once" fires a single time, and "off" removes it before it fires', () => {
    const emitter = createEmitter<{ message: [] }>();
    const counted = counter();

    emitter.once('message', counted.listener);
    emitter.emit('message');
    emitter.emit('message');
    expect(counted.count()).toBe(1);

    emitter.once('message', counted.listener);
    emitter.off('message', counted.listener);
    expect(emitter.emit('message')).toBe(false);
    expect(counted.count()).toBe(1);
  });

  test('every registration counts, as in Node', () => {
    const emitter = createEmitter<{ message: [] }>();
    const twice = counter();
    const onceTwice = counter();
    const mixed = counter();

    emitter.on('message', twice.listener);
    emitter.on('message', twice.listener);
    emitter.once('message', onceTwice.listener);
    emitter.once('message', onceTwice.listener);
    emitter.on('message', mixed.listener);
    emitter.once('message', mixed.listener);

    emitter.emit('message');
    expect([twice.count(), onceTwice.count(), mixed.count()]).toEqual([2, 2, 2]);

    emitter.emit('message');
    expect([twice.count(), onceTwice.count(), mixed.count()]).toEqual([4, 2, 3]);
  });

  test('"off" removes the latest registration', () => {
    const emitter = createEmitter<{ message: [] }>();
    const counted = counter();

    emitter.on('message', counted.listener);
    emitter.once('message', counted.listener);
    emitter.off('message', counted.listener);

    emitter.emit('message');
    emitter.emit('message');
    expect(counted.count()).toBe(2);
  });

  test('an emit runs over a snapshot — a listener added or removed mid-emit waits for the next one', () => {
    const emitter = createEmitter<{ message: [] }>();
    const late = counter();
    const removed = counter();

    emitter.on('message', () => {
      emitter.on('message', late.listener);
      emitter.off('message', removed.listener);
    });
    emitter.on('message', removed.listener);

    emitter.emit('message');
    expect([late.count(), removed.count()]).toEqual([0, 1]);
  });

  test('taking a "once" listener out mid-emit leaves every other listener registered', () => {
    const emitter = createEmitter<{ message: [] }>();
    const takenOut = counter();
    const other = counter();

    emitter.on('message', () => {
      emitter.off('message', takenOut.listener);
    });
    emitter.once('message', takenOut.listener);
    emitter.on('message', other.listener);

    emitter.emit('message');
    emitter.emit('message');

    expect([takenOut.count(), other.count()]).toEqual([1, 2]);
  });

  test('"removeAllListeners" mid-emit keeps a listener added after it for the next emit', () => {
    const emitter = createEmitter<{ message: [] }>();
    const removed = counter();
    const late = counter();
    let hasCleared = false;

    emitter.on('message', () => {
      if (!hasCleared) {
        hasCleared = true;
        emitter.removeAllListeners('message');
        emitter.on('message', late.listener);
      }
    });
    emitter.once('message', removed.listener);

    emitter.emit('message');
    expect(emitter.emit('message')).toBe(true);

    expect([removed.count(), late.count()]).toEqual([1, 1]);
  });

  test('a "once" listener runs once even when an earlier listener emits again', () => {
    const emitter = createEmitter<{ message: [] }>();
    const counted = counter();
    let hasReemitted = false;

    emitter.on('message', () => {
      if (!hasReemitted) {
        hasReemitted = true;
        emitter.emit('message');
      }
    });
    emitter.once('message', counted.listener);

    emitter.emit('message');
    expect(counted.count()).toBe(1);
  });

  test('"removeAllListeners" clears one event or all of them', () => {
    const emitter = createEmitter<{ a: []; b: [] }>();

    emitter.on('a', noop);
    emitter.on('b', noop);
    emitter.removeAllListeners('a');
    expect(emitter.emit('a')).toBe(false);
    expect(emitter.emit('b')).toBe(true);

    emitter.removeAllListeners();
    expect(emitter.emit('b')).toBe(false);
  });

  test('"listenerCount" counts registrations, and a "once" until it fires', () => {
    const emitter = createEmitter<{ a: []; b: [] }>();

    expect(emitter.listenerCount('a')).toBe(0);

    emitter.on('a', noop);
    emitter.on('a', noop);
    emitter.once('a', noop);
    expect(emitter.listenerCount('a')).toBe(3);
    expect(emitter.listenerCount('b')).toBe(0);

    emitter.emit('a');
    expect(emitter.listenerCount('a')).toBe(2);

    emitter.off('a', noop);
    expect(emitter.listenerCount('a')).toBe(1);

    emitter.removeAllListeners();
    expect(emitter.listenerCount('a')).toBe(0);
  });

  test('an "error" nobody listens to makes emit return false instead of throwing', () => {
    const emitter = createEmitter<{ error: [err: Error] }>();
    expect(emitter.emit('error', new Error('unheard'))).toBe(false);
  });
});
