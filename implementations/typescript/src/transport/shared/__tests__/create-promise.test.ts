import { expect, test } from '@playwright/test';
import { createPromise } from '../create-promise';
import { CancelError, ConnectError, GenericError, TimeoutError } from '../errors';

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

  test('waits for the delay before running the executor', async () => {
    const started = Date.now();
    let waited = 0;

    await createPromise(
      (resolve) => {
        waited = Date.now() - started;
        resolve();
      },
      { delay: 60 }
    );

    expect(waited).toBeGreaterThanOrEqual(50);
  });

  test('counts the delay in the timeout', async () => {
    const pending = createPromise(
      () => {
        /* never settles */
      },
      { delay: 20, timeout: 30 }
    );

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await expect(pending).rejects.toHaveProperty('timeout', 50);
  });

  test('treats a delay that is not a number as none, in the timeout too', async () => {
    const pending = createPromise(
      () => {
        /* never settles */
      },
      { delay: Number.NaN, timeout: 30 }
    );

    await expect(pending).rejects.toHaveProperty('timeout', 30);
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
      createPromise(
        (resolve) => {
          setTimeout(resolve, 20);
        },
        { timeout: 0 }
      )
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
