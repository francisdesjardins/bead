import { expect, test } from '@playwright/test';
import * as entry from '../transport-client';
import {
  CancelError,
  ConnectError,
  createTransportClient,
  dispose,
  type ITransportClient,
  type ITransportClientAddressOptions,
  type ITransportClientInternal,
  ProgrammerError,
  ReconnectError,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
  TimeoutError,
} from '../transport-client';
import * as clocks from '../../shared/clock';
import * as constants from '../../shared/constants';
import { createPromise } from '../../shared/create-promise';
import {
  createTestClock,
  delaysOn,
  durationsOf,
  type TestClock,
} from '../../shared/__tests__/fixtures';
import { noop } from '../../shared/noop';
import { createWorkerTransportClient } from '../worker-transport-client';
import * as errors from '../../shared/errors';
import * as readyState from '../../shared/ready-state';

/** The drop only an implementation reaches, as the base and the transport use it. */
const drop = (client: ITransportClient<object, never>): void => {
  (client as ITransportClientInternal<object, never>)[dispose]();
};

/** A transport with no socket: it records its calls, fails `failures` times, and opens otherwise. */
const createStubClient = (options?: { clock?: TestClock; failures?: number; hang?: boolean }) => {
  const calls: string[] = [];
  let failuresLeft = options?.failures ?? 0;
  let failureCount = 0;

  const client = createTransportClient<object, ITransportClientAddressOptions>((client) => {
    return {
      clock: options?.clock,

      connect: (connectOptions) => {
        calls.push(`connect:${String(connectOptions.port)}`);

        // a connect that only its signal ends, like one stuck in a handshake
        if (options?.hang === true) {
          return createPromise(
            () => {
              /* never opens */
            },
            { signal: connectOptions.signal }
          );
        }

        if (failuresLeft > 0) {
          failuresLeft -= 1;
          failureCount += 1;
          return Promise.reject(new ConnectError(`refused ${String(failureCount)}`));
        }

        setReadyStateOpen(client);
        return Promise.resolve();
      },
      disconnect: () => {
        calls.push('disconnect');
        setReadyStateClosed(client);
        return Promise.resolve();
      },
      send: () => {
        calls.push('send');
        return Promise.resolve();
      },
      [dispose]: () => {
        calls.push('dispose');
      },
    };
  });

  return { calls, client };
};

const target = { host: 'h', port: 1 };

test.describe('@francisdesjardins/bead/transport-client', () => {
  test('re-exports the internals as the same bindings', () => {
    for (const name of ['CLOSE_EVENT', 'ERROR_EVENT', 'MESSAGE_EVENT'] as const) {
      expect(entry[name]).toBe(constants[name]);
    }

    for (const name of [
      'CancelError',
      'ConnectError',
      'GenericError',
      'ProgrammerError',
      'ReadyStateError',
      'ReconnectError',
      'TimeoutError',
    ] as const) {
      expect(entry[name]).toBe(errors[name]);
    }

    for (const name of [
      'getReadyState',
      'isReadyStateClosed',
      'isReadyStateClosing',
      'isReadyStateConnecting',
      'isReadyStateOpen',
      'isReadyStateReconnecting',
      'isReadyStateUninitialized',
      'READY_STATE_NAMES',
      'ReadyState',
      'setReadyStateClosed',
      'setReadyStateClosing',
      'setReadyStateConnecting',
      'setReadyStateOpen',
      'setReadyStateReconnecting',
      'setReadyStateUninitialized',
    ] as const) {
      expect(entry[name]).toBe(readyState[name]);
    }

    expect([entry.LONGEST_TIMER, entry.PLATFORM_CLOCK]).toEqual([
      clocks.LONGEST_TIMER,
      clocks.PLATFORM_CLOCK,
    ]);
  });
});

test.describe('createTransportClient', () => {
  test('starts uninitialized with no protocol', () => {
    const { client } = createStubClient();
    expect(client.isUninitialized()).toBe(true);
    expect(client.socket).toBeNull();
  });

  test('routes the protocol methods to what the definition returned', async () => {
    const { calls, client } = createStubClient();

    await client.connect(target);
    await client.send('x');
    await client.disconnect();
    drop(client);

    expect(calls).toEqual(['connect:1', 'send', 'disconnect', 'dispose']);
  });

  test('"on", "off", "once" and "removeAllListeners" chain on the client', () => {
    const { client } = createStubClient();

    expect(client.on('close', noop)).toBe(client);
    expect(client.off('close', noop)).toBe(client);
    expect(client.once('close', noop)).toBe(client);
    expect(client.removeAllListeners()).toBe(client);
  });

  test('"connect" with a signal already aborted rejects with a CancelError, never reaching the transport', async () => {
    const { calls, client } = createStubClient();
    const reason = new Error('given up');

    const connecting = client.connect({ ...target, signal: AbortSignal.abort(reason) });

    await expect(connecting).rejects.toBeInstanceOf(CancelError);
    await expect(connecting).rejects.toHaveProperty('cause', reason);
    expect(calls).toEqual([]);
    expect(client.isUninitialized()).toBe(true);
  });

  test('"connect" on an open client rejects without reaching the transport', async () => {
    const { calls, client } = createStubClient();

    await client.connect(target);
    await expect(client.connect({ host: 'h', port: 2 })).rejects.toThrow(
      'transport is already opened'
    );

    expect(calls).toEqual(['connect:1']);
  });

  test('"connect" while closing rejects without reaching the transport', async () => {
    const { calls, client } = createStubClient();

    await client.connect(target);
    setReadyStateClosing(client);

    await expect(client.connect(target)).rejects.toThrow('transport is already closing');
    expect(calls).toEqual(['connect:1']);
  });

  test('"await using" disconnects an open client, and drops one never opened', async () => {
    const opened = createStubClient();
    {
      await using client = opened.client;
      await client.connect(target);
    }
    expect(opened.calls).toEqual(['connect:1', 'disconnect']);
    expect(opened.client.isClosed()).toBe(true);

    const fresh = createStubClient();
    await fresh.client[Symbol.asyncDispose]();
    expect(fresh.calls).toEqual(['dispose']);
  });

  // the worker's transport, which no test of its own times a connect for: a worker that never answers
  test('holds a connect’s timeout to a whole number of milliseconds, 0 and Infinity never timing out, refusing any other before anything moves, the worker’s transport as every one', async () => {
    for (const { given, outcome, refusal } of durationsOf("a connect's timeout", {
      never: 'taken',
      zero: 'own',
    })) {
      const clock = createTestClock();
      const held: MessagePort[] = [];
      const client = createWorkerTransportClient({
        clock,
        worker: {
          postMessage: (_, transfer) => {
            held.push(transfer[0] as MessagePort);
          },
        },
      });
      const controller = new AbortController();
      const label = String(given);
      let isSettled = false;
      const connecting = client
        .connect({ signal: controller.signal, timeout: given })
        .catch((reason: unknown) => {
          return reason;
        })
        .finally(() => {
          isSettled = true;
        });

      if (outcome === 'refused') {
        expect(await connecting, label).toEqual(new ProgrammerError(refusal));
        // no port handed to the worker, and nothing kept for a reconnection
        expect([held, client.isUninitialized()], label).toEqual([[], true]);
        await expect(client.reconnect(), label).rejects.toThrow('transport was never connected');

        continue;
      }

      // a duration held times the connect out once it passed; 0 and Infinity wait on past the longest
      if (Number.isFinite(given) && given > 0) {
        await clock.tickAsync(given - 1);

        expect(isSettled, label).toBe(false);

        await clock.tickAsync(1);

        expect(await connecting, label).toBeInstanceOf(TimeoutError);
      } else {
        await clock.tickAsync(clocks.LONGEST_TIMER);

        expect(isSettled, label).toBe(false);

        controller.abort();

        expect(await connecting, label).toBeInstanceOf(CancelError);
      }

      for (const port of held) {
        port.close();
      }
    }
  });

  test('a connect refused after a close keeps the target before it, which a reconnection replays', async () => {
    const { calls, client } = createStubClient();

    await client.connect({ host: 'h', port: 7 });
    await client.disconnect();
    await expect(client.connect({ host: 'h', port: 8, timeout: 0.5 })).rejects.toThrow(
      new ProgrammerError(
        "a connect's timeout is a whole number of milliseconds from 1 to 2147483647, or Infinity for never, not 0.5"
      )
    );

    expect(client.isClosed()).toBe(true);

    await client.reconnect({ delay: 0 });

    expect([calls, client.isOpen()]).toEqual([['connect:7', 'disconnect', 'connect:7'], true]);
  });

  test('the drop leaves an open client CLOSED', async () => {
    const { calls, client } = createStubClient();

    await client.connect(target);
    drop(client);

    expect(client.isClosed()).toBe(true);
    expect(calls).toEqual(['connect:1', 'dispose']);
  });
});

test.describe('createTransportClient #reconnect', () => {
  test('reuses the options of the last accepted connect, disposing an open protocol first', async () => {
    const { calls, client } = createStubClient();

    await client.connect({ host: 'h', port: 7 });
    await expect(client.connect({ host: 'h', port: 8 })).rejects.toBeInstanceOf(ProgrammerError);
    await client.reconnect({ delay: 0 });

    expect(calls).toEqual(['connect:7', 'dispose', 'connect:7']);
    expect(client.isOpen()).toBe(true);
  });

  test('reaches a replaced "connect", as an override would', async () => {
    const { client } = createStubClient();
    const originalConnect = client.connect;
    let replacementCalls = 0;

    await client.connect(target);
    client.connect = (options) => {
      replacementCalls += 1;
      return originalConnect(options);
    };
    await client.reconnect({ delay: 0 });

    expect(replacementCalls).toBe(1);
  });

  test('rejects with a ProgrammerError when the transport was never connected', async () => {
    const { client } = createStubClient();
    await expect(client.reconnect()).rejects.toBeInstanceOf(ProgrammerError);
    expect(client.isUninitialized()).toBe(true);
  });

  test('rejects with a ProgrammerError while connecting', async () => {
    const { client } = createStubClient();

    await client.connect(target);
    setReadyStateConnecting(client);

    await expect(client.reconnect()).rejects.toThrow('cannot reconnect while connecting');
  });

  test('rejects with a ProgrammerError while closing', async () => {
    const { client } = createStubClient();

    await client.connect(target);
    setReadyStateClosing(client);

    await expect(client.reconnect()).rejects.toThrow('cannot reconnect while closing');
  });

  test('rejects with a ProgrammerError when already reconnecting, and leaves the first one alone', async () => {
    const { client } = createStubClient({ failures: 2 });

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    const first = client.reconnect({ delay: 20 });

    await expect(client.reconnect()).rejects.toThrow('already reconnecting');
    expect(client.isReconnecting()).toBe(true);

    await first;
    expect(client.isOpen()).toBe(true);
  });

  test('"connect" during the wait rejects with a ProgrammerError', async () => {
    const { client } = createStubClient({ failures: 2 });
    const controller = new AbortController();
    const waiting = Promise.withResolvers<void>();

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    const reconnecting = client.reconnect({
      delay: 60_000,
      signal: controller.signal,
      tap: () => {
        waiting.resolve();
      },
    });
    await waiting.promise;

    await expect(client.connect(target)).rejects.toThrow('transport is already reconnecting');

    controller.abort();
    await expect(reconnecting).rejects.toBeInstanceOf(CancelError);
  });

  test('passes on what "tap" throws, ending CLOSED, with no attempt after it and no wait left armed', async () => {
    const clock = createTestClock();
    const { calls, client } = createStubClient({ clock, failures: 2 });
    const failure = new Error('tap_error');

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    await expect(
      client.reconnect({
        delay: 10,
        tap: () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(client.isClosed()).toBe(true);
    expect([calls, delaysOn(clock)]).toEqual([['connect:1', 'connect:1'], []]);
  });

  test('rejects with a ProgrammerError, ending CLOSED, when "delay" throws', async () => {
    const { client } = createStubClient({ failures: 2 });

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);

    const reconnecting = client.reconnect({
      delay: () => {
        throw new Error('decay_error');
      },
    });

    await expect(reconnecting).rejects.toBeInstanceOf(ProgrammerError);
    await expect(reconnecting).rejects.toHaveProperty('message', 'decay_error');
    expect(client.isClosed()).toBe(true);
  });

  test('emits "reconnect" once as it starts, open or closed, and not on a misuse', async () => {
    const { client } = createStubClient();
    let reconnects = 0;

    client.on('reconnect', () => {
      reconnects += 1;
    });

    await expect(client.reconnect()).rejects.toBeInstanceOf(ProgrammerError);
    expect(reconnects).toBe(0);

    await client.connect(target);
    await client.reconnect();
    await client.disconnect();
    await client.reconnect();

    expect(reconnects).toBe(2);
  });

  test('makes its first attempt at once', async () => {
    const { calls, client } = createStubClient();

    await client.connect(target);
    await client.reconnect({ delay: 60_000 });

    expect(calls).toEqual(['connect:1', 'dispose', 'connect:1']);
    expect(client.isOpen()).toBe(true);
  });

  test('waits its delay after each failed attempt on the clock its transport runs on, connecting once per attempt', async () => {
    const clock = createTestClock();
    const { calls, client } = createStubClient({ clock, failures: 2 });

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);

    const reconnecting = client.reconnect({ delay: 60 });

    await expect
      .poll(() => {
        return delaysOn(clock);
      })
      .toEqual([60]);
    await clock.tickAsync(59);

    expect(calls).toEqual(['connect:1', 'connect:1']);

    await clock.tickAsync(1);
    await reconnecting;

    expect(calls).toEqual(['connect:1', 'connect:1', 'connect:1']);
    expect(client.clock).toBe(clock);
    expect(createStubClient().client.clock).toBe(clocks.PLATFORM_CLOCK);
  });

  test('holds a delay to a whole number of milliseconds, 0 waiting none, refusing Infinity and any other before "tap" hears it, ending CLOSED without another attempt', async () => {
    for (const { given, outcome, refusal } of durationsOf('a delay', {
      never: 'refused',
      zero: 'own',
    })) {
      const clock = createTestClock();
      const { calls, client } = createStubClient({ clock, failures: 2 });
      const taps: number[] = [];
      const label = String(given);

      await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);

      const reconnecting = client.reconnect({
        delay: given,
        tap: (nextDelay) => {
          taps.push(nextDelay);
        },
      });

      if (outcome === 'refused') {
        await expect(reconnecting, label).rejects.toThrow(new ProgrammerError(refusal));

        expect([calls, taps, client.isClosed()], label).toEqual([
          ['connect:1', 'connect:1'],
          [],
          true,
        ]);

        continue;
      }

      // a duration held is waited on the clock; 0, none
      if (outcome === 'taken') {
        await expect
          .poll(() => {
            return delaysOn(clock);
          }, label)
          .toEqual([given]);
        await clock.tickAsync(given - 1);

        expect(calls, label).toEqual(['connect:1', 'connect:1']);

        await clock.tickAsync(1);
      }

      await reconnecting;

      expect([calls, taps], label).toEqual([['connect:1', 'connect:1', 'connect:1'], [given]]);
    }
  });

  test('arms its wait before "tap" hears it, so a tap that moves the clock by the wait lets the next attempt follow with no other move', async () => {
    const clock = createTestClock();
    const { calls, client } = createStubClient({ clock, failures: 2 });

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    await client.reconnect({
      delay: 60,
      tap: (nextDelay) => {
        clock.tick(nextDelay);
      },
    });

    expect([calls, client.isOpen()]).toEqual([['connect:1', 'connect:1', 'connect:1'], true]);
  });

  test('tells "tap" the wait and the attempt that failed, and nothing when the first one succeeds', async () => {
    const taps: [number, number][] = [];
    const tap = (nextDelay: number, attempt: number) => {
      taps.push([nextDelay, attempt]);
    };

    const succeeding = createStubClient();
    await succeeding.client.connect(target);
    await succeeding.client.reconnect({ delay: 10, tap });
    expect(taps).toEqual([]);

    const failingOnce = createStubClient({ failures: 2 });
    await expect(failingOnce.client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    await failingOnce.client.reconnect({ delay: 10, tap });
    expect(taps).toEqual([[10, 1]]);
  });

  test('passes the previous wait to a "delay" function', async () => {
    const { client } = createStubClient({ failures: 5 });
    const seen: [number | undefined, number][] = [];

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    await expect(
      client.reconnect({
        delay: (previousDelay, attempt) => {
          seen.push([previousDelay, attempt]);
          return (previousDelay ?? 5) * 2;
        },
        maxAttempts: 4,
      })
    ).rejects.toBeInstanceOf(ReconnectError);

    expect(seen).toEqual([
      [undefined, 1],
      [10, 2],
      [20, 3],
    ]);
  });

  test('rejects with a ReconnectError carrying the last failure as cause, ending CLOSED', async () => {
    const { calls, client } = createStubClient({ failures: 3 });

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);

    const reconnecting = client.reconnect({ delay: 0, maxAttempts: 2 });

    await expect(reconnecting).rejects.toBeInstanceOf(ReconnectError);
    await expect(reconnecting).rejects.toHaveProperty('cause', expect.any(ConnectError));
    await expect(reconnecting).rejects.toHaveProperty('cause.message', 'refused 3');
    expect(calls).toEqual(['connect:1', 'connect:1', 'connect:1']);
    expect(client.isClosed()).toBe(true);
  });

  test('always makes one attempt, even with a maxAttempts of 0', async () => {
    const { calls, client } = createStubClient({ failures: 5 });

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    await expect(client.reconnect({ delay: 0, maxAttempts: 0 })).rejects.toBeInstanceOf(
      ReconnectError
    );

    expect(calls).toEqual(['connect:1', 'connect:1']);
  });

  test('rejects a maxAttempts that is not a number, leaving the state as it was', async () => {
    const { calls, client } = createStubClient();

    await client.connect(target);
    await expect(client.reconnect({ maxAttempts: Number.NaN })).rejects.toBeInstanceOf(
      ProgrammerError
    );

    expect(calls).toEqual(['connect:1']);
    expect(client.isOpen()).toBe(true);
  });

  test('an explicit undefined option falls back to its default', async () => {
    const { calls, client } = createStubClient({ failures: 10 });

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    await expect(
      client.reconnect({ delay: 0, maxAttempts: undefined, tap: undefined, signal: undefined })
    ).rejects.toBeInstanceOf(ReconnectError);

    expect(calls).toHaveLength(1 + entry.RECONNECT_DEFAULTS.maxAttempts);
  });

  test('rejects with a CancelError, without waiting out the delay, when the signal aborts mid-wait', async () => {
    const { calls, client } = createStubClient({ failures: 2 });
    const controller = new AbortController();

    await expect(client.connect(target)).rejects.toBeInstanceOf(ConnectError);

    const started = Date.now();
    const reconnecting = client.reconnect({
      delay: 60_000,
      signal: controller.signal,
      tap: () => {
        // after `tap`, once the wait has begun
        queueMicrotask(() => {
          controller.abort('why');
        });
      },
    });

    await expect(reconnecting).rejects.toBeInstanceOf(CancelError);
    await expect(reconnecting).rejects.toHaveProperty('message', '');
    await expect(reconnecting).rejects.toHaveProperty('cause', 'why');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toEqual(['connect:1', 'connect:1']);
    expect(client.isClosed()).toBe(true);
  });

  test('never attempts with a signal already aborted, and stops at the wait when "tap" aborts', async () => {
    const opened = createStubClient();
    await opened.client.connect(target);
    await expect(
      opened.client.reconnect({ delay: 0, signal: AbortSignal.abort() })
    ).rejects.toBeInstanceOf(CancelError);
    expect(opened.client.isOpen()).toBe(true);
    expect(opened.calls).toEqual(['connect:1']);

    const failing = createStubClient({ failures: 2 });
    const controller = new AbortController();
    await expect(failing.client.connect(target)).rejects.toBeInstanceOf(ConnectError);
    await expect(
      failing.client.reconnect({
        delay: 60_000,
        signal: controller.signal,
        tap: () => {
          controller.abort();
        },
      })
    ).rejects.toBeInstanceOf(CancelError);
    expect(failing.calls).toEqual(['connect:1', 'connect:1']);
  });
  test('aborts the attempt in flight when the signal aborts', async () => {
    const { calls, client } = createStubClient({ hang: true });
    const controller = new AbortController();

    await expect(
      client.connect({ ...target, signal: AbortSignal.timeout(10) })
    ).rejects.toBeInstanceOf(CancelError);

    const reconnecting = client.reconnect({ delay: 0, signal: controller.signal });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    controller.abort('why');

    await expect(reconnecting).rejects.toHaveProperty('cause', 'why');
    expect(calls).toEqual(['connect:1', 'connect:1']);
    expect(client.isClosed()).toBe(true);
  });

  test('does not keep the signal of a connect for its reconnections', async () => {
    const { client } = createStubClient();
    const controller = new AbortController();

    await client.connect({ ...target, signal: controller.signal });
    controller.abort();

    await client.reconnect({ delay: 0 });
    expect(client.isOpen()).toBe(true);
  });

  test('disconnects and rejects with a CancelError when the signal aborts after the connect resolved', async () => {
    const { calls, client } = createStubClient();
    const controller = new AbortController();
    const originalConnect = client.connect;

    await client.connect(target);
    client.connect = async (options) => {
      await originalConnect(options);
      controller.abort();
    };

    await expect(client.reconnect({ delay: 0, signal: controller.signal })).rejects.toBeInstanceOf(
      CancelError
    );

    expect(calls).toEqual(['connect:1', 'dispose', 'connect:1', 'disconnect']);
    expect(client.isClosed()).toBe(true);
  });
});
