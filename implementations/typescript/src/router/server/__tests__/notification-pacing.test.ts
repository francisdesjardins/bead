import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { createPacing, PACING_DEFAULTS, pacingLimitsOf } from '../notification-pacing';
import type { IPacingLimits } from '../types';

// helpers

const text = new TextEncoder();
const decoder = new TextDecoder();

/** A payload that reads as `word`. */
const payloadOf = (word: string): Uint8Array => {
  return text.encode(word);
};

/** What payloads read as. */
const wordsOf = (payloads: readonly Uint8Array[]): string[] => {
  return payloads.map((payload) => {
    return decoder.decode(payload);
  });
};

const LIMITS: IPacingLimits = Object.freeze({
  maximumQueuedNotificationBytes: 1_024,
  maximumQueuedNotifications: 8,
});

// definition

test.describe('PACING_DEFAULTS and pacingLimitsOf', () => {
  test('queue 64 notifications and 1 MiB at most by default, frozen', () => {
    expect(PACING_DEFAULTS).toEqual({
      maximumQueuedNotificationBytes: 1_048_576,
      maximumQueuedNotifications: 64,
    });
    expect(Object.isFrozen(PACING_DEFAULTS)).toBe(true);
    expect(pacingLimitsOf()).toEqual(PACING_DEFAULTS);
    expect(Object.isFrozen(pacingLimitsOf())).toBe(true);
  });

  test('take each limit given over the default, one left undefined keeping it', () => {
    expect(
      pacingLimitsOf({ maximumQueuedNotificationBytes: undefined, maximumQueuedNotifications: 1 })
    ).toEqual({ maximumQueuedNotificationBytes: 1_048_576, maximumQueuedNotifications: 1 });
    expect(pacingLimitsOf({ maximumQueuedNotificationBytes: 2 ** 53 - 1 })).toEqual({
      maximumQueuedNotificationBytes: 2 ** 53 - 1,
      maximumQueuedNotifications: 64,
    });
  });

  test('refuse a limit that is not a whole number above 0, naming it', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(() => {
        return pacingLimitsOf({ maximumQueuedNotifications: value });
      }, String(value)).toThrow(ProgrammerError);
    }

    expect(() => {
      return pacingLimitsOf({ maximumQueuedNotificationBytes: 0 });
    }).toThrow('maximumQueuedNotificationBytes is a whole number above 0, not 0');
  });
});

test.describe('createPacing', () => {
  test('sends the first notification, credited by asking, and queues the next', () => {
    const pacing = createPacing(LIMITS);

    expect(pacing.isPaused).toBe(false);
    expect(pacing.offer({ payload: payloadOf('first') })).toBe('send');
    expect(pacing.isPaused).toBe(true);
    expect(pacing.offer({ payload: payloadOf('second') })).toBe('queued');
    expect(pacing.queuedNotifications).toBe(1);
    expect(pacing.queuedNotificationBytes).toBe(6);
  });

  test('lets go, in order, what a credit reaches, and sends at once while credit is left', () => {
    const pacing = createPacing(LIMITS);

    pacing.offer({ payload: payloadOf('a') });

    for (const word of ['b', 'c', 'd']) {
      pacing.offer({ payload: payloadOf(word) });
    }

    // counted from the first: 3 sent at most, so 2 of the 3 queued
    expect(wordsOf(pacing.credit(3))).toEqual(['b', 'c']);
    expect(pacing.queuedNotifications).toBe(1);
    expect(pacing.isPaused).toBe(true);
    expect(wordsOf(pacing.credit(6))).toEqual(['d']);
    expect(pacing.isPaused).toBe(false);
    expect(pacing.queuedNotificationBytes).toBe(0);
    expect(pacing.offer({ payload: payloadOf('e') })).toBe('send');
    expect(pacing.offer({ payload: payloadOf('f') })).toBe('send');
    expect(pacing.offer({ payload: payloadOf('g') })).toBe('queued');
  });

  test('grants nothing for a credit at or below the one it has', () => {
    const pacing = createPacing(LIMITS);

    pacing.offer({ payload: payloadOf('a') });
    pacing.offer({ payload: payloadOf('b') });

    expect(pacing.credit(1)).toEqual([]);
    expect(pacing.credit(0)).toEqual([]);
    expect(wordsOf(pacing.credit(2))).toEqual(['b']);
    // a credit that came late, below the one granted since
    expect(pacing.credit(1)).toEqual([]);
    expect(pacing.offer({ payload: payloadOf('c') })).toBe('queued');
  });

  test('keeps the credit it has when one below it comes late, with credit left', () => {
    const pacing = createPacing(LIMITS);

    pacing.offer({ payload: payloadOf('a') });
    pacing.credit(4);
    pacing.credit(2);

    expect([
      pacing.offer({ payload: payloadOf('b') }),
      pacing.offer({ payload: payloadOf('c') }),
      pacing.offer({ payload: payloadOf('d') }),
      pacing.offer({ payload: payloadOf('e') }),
    ]).toEqual(['send', 'send', 'send', 'queued']);
  });

  test('keeps the latest of a key in the place of the first, and every notification without one', () => {
    const pacing = createPacing(LIMITS);

    pacing.offer({ key: 7, payload: payloadOf('sent') });
    pacing.offer({ key: 7, payload: payloadOf('7 a') });
    pacing.offer({ payload: payloadOf('event 1') });
    pacing.offer({ key: 'nine', payload: payloadOf('9 a') });
    pacing.offer({ payload: payloadOf('event 2') });
    pacing.offer({ key: 7, payload: payloadOf('7 b') });
    // a number and a string are two keys
    pacing.offer({ key: '7', payload: payloadOf('"7"') });

    expect(pacing.queuedNotifications).toBe(5);
    expect(wordsOf(pacing.credit(100))).toEqual(['7 b', 'event 1', '9 a', 'event 2', '"7"']);
  });

  test('counts the bytes of what replaces, not of what it replaced', () => {
    const pacing = createPacing(LIMITS);

    pacing.offer({ payload: payloadOf('sent') });
    pacing.offer({ key: 1, payload: new Uint8Array(10) });
    pacing.offer({ key: 1, payload: new Uint8Array(4) });
    pacing.offer({ payload: new Uint8Array(3) });

    expect(pacing.queuedNotificationBytes).toBe(7);
    pacing.credit(2);
    expect(pacing.queuedNotificationBytes).toBe(3);
  });

  test('says a queue went past its count, but not a key that only replaces', () => {
    const pacing = createPacing({ ...LIMITS, maximumQueuedNotifications: 2 });

    pacing.offer({ payload: payloadOf('sent') });

    expect(pacing.offer({ key: 1, payload: payloadOf('a') })).toBe('queued');
    expect(pacing.offer({ key: 2, payload: payloadOf('b') })).toBe('queued');
    expect(pacing.offer({ key: 1, payload: payloadOf('c') })).toBe('queued');
    expect(pacing.offer({ payload: payloadOf('d') })).toBe('exceeded');
    expect(pacing.queuedNotifications).toBe(3);
  });

  test('says a queue went past its bytes, a replacement larger than what it replaced too', () => {
    const pacing = createPacing({ ...LIMITS, maximumQueuedNotificationBytes: 8 });

    pacing.offer({ payload: payloadOf('sent') });

    expect(pacing.offer({ key: 1, payload: new Uint8Array(4) })).toBe('queued');
    expect(pacing.offer({ key: 2, payload: new Uint8Array(4) })).toBe('queued');
    expect(pacing.offer({ key: 2, payload: new Uint8Array(5) })).toBe('exceeded');
    expect(pacing.queuedNotificationBytes).toBe(9);
  });

  test('says a notification larger than its bytes went past them, alone', () => {
    const pacing = createPacing({ ...LIMITS, maximumQueuedNotificationBytes: 8 });

    pacing.offer({ payload: payloadOf('sent') });

    expect(pacing.offer({ payload: new Uint8Array(9) })).toBe('exceeded');
  });
});
