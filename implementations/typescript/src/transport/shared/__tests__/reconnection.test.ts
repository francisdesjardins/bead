// dependencies

import { expect, test } from '@playwright/test';
import { CancelError, ConnectError, ProgrammerError, ReconnectError } from '../errors';
import {
  assertHeldReconnection,
  attemptReconnection,
  RECONNECTION_CANCELLED,
} from '../reconnection';
import { createTestClock } from './fixtures';

// helpers

/** An attempt that fails `failures` times with a {@link ConnectError}, then opens: each one counted. */
const failingOf = (failures: number) => {
  const attempts: (AbortSignal | undefined)[] = [];

  return {
    attempt: (signal: AbortSignal | undefined): Promise<void> => {
      attempts.push(signal);

      return attempts.length > failures
        ? Promise.resolve()
        : Promise.reject(new ConnectError(`refused ${String(attempts.length)}`));
    },
    attempts,
  };
};

// definition

test.describe('reconnection', () => {
  test('holds a maximumAttempts that is not a number, then a fixed delay, as they are given, and a function’s answer at each attempt', () => {
    expect(() => {
      assertHeldReconnection({ delay: Infinity, maximumAttempts: Number.NaN });
    }).toThrow(new ProgrammerError('maximumAttempts is not a number'));
    expect(() => {
      assertHeldReconnection({ delay: -1 });
    }).toThrow(
      new ProgrammerError(
        'a delay is 0 for at once, or a number of milliseconds from 1 to 2147483647, not -1'
      )
    );

    // * a function, a delay left out and one held: nothing to hold yet
    for (const delay of [
      () => {
        return Infinity;
      },
      undefined,
      0,
      1.4,
    ]) {
      expect(() => {
        assertHeldReconnection({ delay, maximumAttempts: Infinity });
      }).not.toThrow();
    }
  });

  test('reads its signal before each attempt, the first included, and hands it to each', async () => {
    const clock = createTestClock();
    const aborted = AbortSignal.abort('gone');
    const never = failingOf(0);

    // * aborted before any attempt: none made
    await expect(
      attemptReconnection(never.attempt, {
        clock,
        delay: 0,
        maximumAttempts: 5,
        signal: aborted,
      })
    ).rejects.toMatchObject({ cause: 'gone', message: RECONNECTION_CANCELLED });
    expect(never.attempts).toHaveLength(0);

    // aborted by the tap of its first failure: the wait cut short, no attempt after it
    const cancelling = new AbortController();
    const once = failingOf(1);
    const cancelled = attemptReconnection(once.attempt, {
      clock,
      delay: 60_000,
      maximumAttempts: 5,
      signal: cancelling.signal,
      tap: () => {
        cancelling.abort();
      },
    });

    await expect(cancelled).rejects.toBeInstanceOf(CancelError);
    expect(once.attempts).toEqual([cancelling.signal]);
  });

  test('waits each delay on its clock, telling its tap first, and gives up past its attempts, the last failure its cause', async () => {
    const clock = createTestClock();
    const failing = failingOf(Infinity);
    const taps: [number, number][] = [];
    const reconnecting = attemptReconnection(failing.attempt, {
      clock,
      delay: (previous, attempt) => {
        return (previous ?? 0) + attempt * 10;
      },
      maximumAttempts: 3,
      tap: (delay, attempt) => {
        taps.push([delay, attempt]);
      },
    }).catch((reason: unknown) => {
      return reason;
    });

    await clock.tickAsync(10);
    await clock.tickAsync(30);

    expect(await reconnecting).toMatchObject({
      cause: { message: 'refused 3' },
      message: 'attempt 3 reached',
    });
    expect(await reconnecting).toBeInstanceOf(ReconnectError);
    expect([failing.attempts.length, taps]).toEqual([
      3,
      [
        [10, 1],
        [30, 2],
      ],
    ]);
  });

  test('ends at once on a misuse an attempt meets, a function’s answer out of bounds, or what its tap throws', async () => {
    const clock = createTestClock();
    const misuse = new ProgrammerError('a misuse');
    const thrown = new Error('its tap broke');
    let attempts = 0;
    const misused = (): Promise<void> => {
      attempts += 1;

      return Promise.reject(misuse);
    };

    await expect(
      attemptReconnection(misused, { clock, delay: 0, maximumAttempts: Infinity })
    ).rejects.toBe(misuse);
    expect(attempts).toBe(1);
    await expect(
      attemptReconnection(failingOf(Infinity).attempt, {
        clock,
        delay: () => {
          return Infinity;
        },
        maximumAttempts: Infinity,
      })
    ).rejects.toThrow(
      new ProgrammerError(
        'a delay is 0 for at once, or a number of milliseconds from 1 to 2147483647, not Infinity'
      )
    );
    await expect(
      attemptReconnection(failingOf(Infinity).attempt, {
        clock,
        delay: 1_000,
        maximumAttempts: Infinity,
        tap: () => {
          throw thrown;
        },
      })
    ).rejects.toBe(thrown);
  });
});
