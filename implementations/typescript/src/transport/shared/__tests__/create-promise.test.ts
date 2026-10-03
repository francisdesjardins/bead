import { expect, test } from '@playwright/test';
import { createPromise } from '../create-promise';
import { CancelError, ConnectError, GenericError, ProgrammerError, TimeoutError } from '../errors';
import { createTestClock, delaysOn, durationsOf } from './fixtures';

const activeTimeouts = () => {
  return process.getActiveResourcesInfo().filter((resource) => {
    return resource === 'Timeout';
  }).length;
};

test.describe('createPromise', () => {
  test('resolves like a plain promise without options', async () => {
    await expect(
      createPromise<number>((resolve) => {
        resolve(42);
      })
    ).resolves.toBe(42);
  });

  test('turns a synchronous throw into a rejection', async () => {
    await expect(
      createPromise(() => {
        throw new ConnectError('boom');
      })
    ).rejects.toBeInstanceOf(ConnectError);
  });

  test('wraps a thrown non-Error in a GenericError that keeps it as cause', async () => {
    const pending = createPromise(() => {
      // oxlint-disable-next-line typescript/only-throw-error -- a non-Error throw is the case under test
      throw 'boom';
    });

    await expect(pending).rejects.toBeInstanceOf(GenericError);
    await expect(pending).rejects.toHaveProperty('cause', 'boom');
  });

  test('waits for the delay on its clock before running the executor', async () => {
    const clock = createTestClock();
    let ran = false;
    const pending = createPromise(
      (resolve) => {
        ran = true;
        resolve();
      },
      { clock, delay: 60 }
    );

    clock.tick(59);

    expect(ran).toBe(false);

    clock.tick(1);
    await pending;

    expect(ran).toBe(true);
  });

  test('counts the delay in the timeout', async () => {
    const clock = createTestClock();
    const pending = createPromise(
      () => {
        /* never settles */
      },
      { clock, delay: 20, timeout: 30 }
    );

    expect(
      clock.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([50, 20]);

    clock.tick(50);

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await expect(pending).rejects.toHaveProperty('timeout', 50);
  });

  test('refuses a delay or a timeout past the longest a timer waits, or the two together, never running the executor', async () => {
    const clock = createTestClock();
    let ran = false;
    const run = () => {
      ran = true;
    };

    for (const [options, refusal] of [
      [
        { delay: 2 ** 31 },
        'a delay is 0 for at once, or a number of milliseconds from 1 to 2147483647, not 2147483648',
      ],
      [
        { timeout: 2 ** 31 },
        'a timeout is a number of milliseconds from 1 to 2147483647, or Infinity for never, not 2147483648',
      ],
      [
        { delay: 2 ** 30, timeout: 2 ** 30 },
        'a timer waits 2147483647 milliseconds at most, a timeout and its delay together, not 2147483648',
      ],
    ] as const) {
      await expect(createPromise(run, { clock, ...options })).rejects.toThrow(
        new ProgrammerError(refusal)
      );
    }

    expect([ran, clock.armed]).toEqual([false, []]);

    // the longest a timer waits, and never, are taken
    void createPromise(run, { clock, timeout: 2 ** 31 - 1 });
    void createPromise(run, { clock, timeout: Infinity });

    expect(ran).toBe(true);
  });

  test('holds a delay as 0 at once or a duration, and a timeout as a duration or never, rounded, never running the executor for one refused', async () => {
    for (const [name, outcomes] of [
      ['delay', { never: 'refused', zero: 'at once' }],
      ['timeout', { never: 'never', zero: 'refused' }],
    ] as const) {
      for (const { given, held, outcome, refusal } of durationsOf(`a ${name}`, outcomes)) {
        const clock = createTestClock();
        let ran = false;
        const pending = createPromise(
          () => {
            ran = true;
          },
          { clock, [name]: given }
        );
        const label = `${name} ${String(given)}`;

        if (outcome === 'refused') {
          await expect(pending, label).rejects.toThrow(new ProgrammerError(refusal));
          expect([ran, clock.armed], label).toEqual([false, []]);
        } else {
          // a delay held waits before it runs the executor; a timeout held, at once and never run
          // it at once
          expect([ran, delaysOn(clock)], label).toEqual(
            outcome === 'taken' ? [name === 'timeout', [held]] : [true, []]
          );
        }
      }
    }
  });

  test('rejects with a TimeoutError that names its timeout', async () => {
    const pending = createPromise(
      () => {
        /* never settles */
      },
      { timeout: 30 }
    );

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await expect(pending).rejects.toHaveProperty('timeout', 30);
  });

  test('never times out without a timeout', async () => {
    await expect(
      createPromise((resolve) => {
        setTimeout(resolve, 20);
      })
    ).resolves.toBeUndefined();
  });

  test('rejects with a CancelError, without running the executor, for a signal already aborted', async () => {
    let ran = false;
    const pending = createPromise(
      () => {
        ran = true;
      },
      { signal: AbortSignal.abort('why') }
    );

    await expect(pending).rejects.toBeInstanceOf(CancelError);
    await expect(pending).rejects.toHaveProperty('cause', 'why');
    expect(ran).toBe(false);
  });

  test('rejects with a CancelError when the signal aborts, even during the delay', async () => {
    const controller = new AbortController();
    let ran = false;
    const pending = createPromise(
      () => {
        ran = true;
      },
      { delay: 60_000, signal: controller.signal }
    );

    controller.abort('why');

    await expect(pending).rejects.toHaveProperty('cause', 'why');
    expect(ran).toBe(false);
  });

  test('clears both timers when a delayed promise settles', async () => {
    const before = activeTimeouts();

    await createPromise(
      (resolve) => {
        resolve();
      },
      { delay: 10, timeout: 60_000 }
    );

    expect(activeTimeouts()).toBe(before);
  });

  test('clears its timeout when the promise resolves first', async () => {
    const before = activeTimeouts();

    await createPromise(
      (resolve) => {
        resolve();
      },
      { timeout: 60_000 }
    );

    expect(activeTimeouts()).toBe(before);
  });

  test('clears its timeout when the promise rejects first', async () => {
    const before = activeTimeouts();

    await expect(
      createPromise(
        (_, reject) => {
          reject(new ConnectError('refused'));
        },
        { timeout: 60_000 }
      )
    ).rejects.toBeInstanceOf(ConnectError);

    expect(activeTimeouts()).toBe(before);
  });
});
