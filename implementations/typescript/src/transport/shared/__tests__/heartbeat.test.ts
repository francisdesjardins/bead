import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { PLATFORM_CLOCK } from '../clock';
import { ProgrammerError } from '../errors';
import { assertHeartbeat, createHeartbeat, createSilenceHeartbeat, HEARTBEAT } from '../heartbeat';
import { createTestClock } from './fixtures';

// helpers

/**
 * Waits, on the real clock and within a patience of 10 seconds, until `holds` does: what a loaded
 * run delays comes late, never wrong, as the WebSocket's heartbeat tests wait theirs.
 */
const until = async (holds: () => boolean): Promise<void> => {
  for (let waited = 0; !holds() && waited < 10_000; waited += 10) {
    await sleep(10);
  }
};

// definition

test.describe('heartbeat', () => {
  test('takes a duration a timer holds or never for none, and refuses zero and one past the longest timer', () => {
    expect(assertHeartbeat(20)).toBe(20);
    expect(assertHeartbeat(Infinity)).toBe(Infinity);
    for (const heartbeat of [0, 2 ** 31]) {
      expect(() => {
        assertHeartbeat(heartbeat);
      }).toThrow(/a heartbeat/u);
    }
  });

  test('drops an unanswered ping after a delayed beat without arming a timer for less than nothing', () => {
    for (const crossesDeadline of [false, true]) {
      const heard: string[] = [];
      const dues: number[] = [];
      let readings: number[] = [];
      let now = 0;
      let pending: (() => void) | undefined;
      const clock = {
        ...createTestClock(),
        performance: {
          now: () => {
            now = readings.shift() ?? now;

            return now;
          },
        },
        setTimeout: (callback: () => void, due: number) => {
          expect(due).toBeGreaterThanOrEqual(1);
          dues.push(due);
          pending = callback;

          return {};
        },
        clearTimeout: () => {
          pending = undefined;
        },
      };
      const fire = (next: number[]) => {
        const callback = pending;

        expect(callback).toBeDefined();
        pending = undefined;
        readings = next;
        callback?.();
      };
      const heartbeat = createSilenceHeartbeat(
        100,
        {
          ping: () => {
            heard.push('ping');
          },
          drop: () => {
            heard.push('drop');
          },
        },
        { clock }
      );

      try {
        fire([100, 100]);
        expect(heard).toEqual(['ping']);
        expect(dues).toEqual([100, 100]);

        if (crossesDeadline) {
          // * the ping's age reads 199; a second age read sees 201
          fire([199, 201]);
          expect(heard).toEqual(['ping']);
          expect(dues).toEqual([100, 100, 1]);
        }

        // * the timer due at 200 runs at 201: the unanswered ping is dropped at once
        fire([201]);
        expect(heard).toEqual(['ping', 'drop']);
        expect(dues).toEqual(crossesDeadline ? [100, 100, 1] : [100, 100]);
        expect(pending).toBeUndefined();
      } finally {
        heartbeat.stop();
      }
    }
  });

  test('takes a number of milliseconds a timer holds, rounded to the nearest whole one, or Infinity for none, and refuses -Infinity, which the durations file holds no input of', () => {
    for (const [heartbeat, held] of [
      [1, 1],
      [1.5, 2],
      [HEARTBEAT, HEARTBEAT],
      [2 ** 31 - 1, 2 ** 31 - 1],
      [Infinity, Infinity],
    ] as const) {
      expect(assertHeartbeat(heartbeat), String(heartbeat)).toBe(held);
    }

    expect(() => {
      assertHeartbeat(-Infinity);
    }).toThrow(
      new ProgrammerError(
        'a heartbeat is a number of milliseconds from 1 to 2147483647, or Infinity for never, not -Infinity'
      )
    );

    expect(HEARTBEAT).toBe(30_000);
  });

  test('pings once nothing was read for its heartbeat, again after each echo, and drops its connection once a ping’s echo has not come within its heartbeat', async () => {
    const clock = createTestClock();
    const heard: string[] = [];
    const pings: Uint8Array[] = [];
    const heartbeat = createHeartbeat(
      250,
      {
        drop: () => {
          heard.push('drop');
        },
        ping: (data) => {
          heard.push('ping');
          pings.push(data);
        },
      },
      { clock }
    );

    try {
      // what is read within each heartbeat keeps it from a ping
      for (let read = 0; read < 4; read += 1) {
        await clock.tickAsync(200);
        heartbeat.heard();
      }

      expect(heard).toEqual([]);

      // silent for its heartbeat: pinged, and kept by the echo, a timer that keeps no process alive
      await clock.tickAsync(250);
      expect(heard).toEqual(['ping']);
      expect(clock.armed.at(-1)?.delay).toBe(250);
      heartbeat.answer(pings[0] ?? new Uint8Array());

      // silent again for its heartbeat after the echo: pinged again; what is read, the echo of
      // none, answers nothing, and it is dropped a heartbeat past its ping
      await clock.tickAsync(250);
      expect(heard).toEqual(['ping', 'ping']);
      await clock.tickAsync(100);
      heartbeat.heard();
      await clock.tickAsync(149);
      expect(heard).toEqual(['ping', 'ping']);
      await clock.tickAsync(1);
      expect(heard).toEqual(['ping', 'ping', 'drop']);

      // dropped, it beats no more
      await clock.tickAsync(1_000);
      expect(heard).toEqual(['ping', 'ping', 'drop']);
      expect(clock.timers?.size ?? 0).toBe(0);
    } finally {
      heartbeat.stop();
    }
  });

  test('takes only the pong that echoes its ping, 8 bytes of a count from 1, never an empty one, another’s or an earlier ping’s', async () => {
    const clock = createTestClock();
    const heard: string[] = [];
    const pings: Uint8Array[] = [];
    const heartbeat = createHeartbeat(
      100,
      {
        drop: () => {
          heard.push('drop');
        },
        ping: (data) => {
          heard.push('ping');
          pings.push(data);
        },
      },
      { clock }
    );
    const countOf = (count: number): Uint8Array => {
      return Uint8Array.of(0, 0, 0, 0, 0, 0, 0, count);
    };

    try {
      await clock.tickAsync(100);
      heartbeat.answer(countOf(1));
      await clock.tickAsync(100);

      // a new count at each ping
      expect(pings).toEqual([countOf(1), countOf(2)]);

      // an empty pong, another's and the first ping's echo answer nothing
      heartbeat.answer(new Uint8Array());
      heartbeat.answer(Uint8Array.of(0x6f, 0x74, 0x68, 0x65, 0x72));
      heartbeat.answer(countOf(1));
      await clock.tickAsync(100);

      expect(heard).toEqual(['ping', 'ping', 'drop']);
    } finally {
      heartbeat.stop();
    }
  });

  test('arms nothing for Infinity, and a stop clears the timer', () => {
    const clock = createTestClock();

    createHeartbeat(
      Infinity,
      {
        drop: () => {},
        ping: () => {},
      },
      { clock }
    ).stop();

    expect(clock.armed).toEqual([]);

    createHeartbeat(
      1_000,
      {
        drop: () => {},
        ping: () => {},
      },
      { clock }
    ).stop();

    expect(clock.armed).toHaveLength(1);
    expect(clock.cleared).toEqual([clock.armed[0]?.handle]);
  });
  test('pings a connection silent for its heartbeat on the platform’s timer, and drops one that answered nothing by the next', async () => {
    const heard: string[] = [];
    const heartbeatOf = (heartbeat: number) => {
      return createSilenceHeartbeat(
        heartbeat,
        {
          drop: () => {
            heard.push('drop');
          },
          ping: () => {
            heard.push('ping');
          },
        },
        { clock: PLATFORM_CLOCK }
      );
    };
    // * a connection that hears something every tenth of its heartbeat is never pinged: a margin a
    // loaded run keeps
    const busy = heartbeatOf(1_000);

    for (let beat = 0; beat < 15; beat += 1) {
      await sleep(100);
      busy.heard();
    }

    expect(heard).toEqual([]);
    busy.stop();

    // one silent is pinged, and dropped once nothing answered by its heartbeat after
    const quiet = heartbeatOf(100);

    await until(() => {
      return heard.length === 2;
    });
    expect(heard).toEqual(['ping', 'drop']);
    quiet.stop();

    // anything heard answers the ping, and none beats once stopped, nor for Infinity
    heard.length = 0;

    const answered = heartbeatOf(1_000);

    await until(() => {
      return heard.length === 1;
    });
    answered.heard();
    await sleep(100);
    expect(heard).toEqual(['ping']);
    answered.stop();
    await sleep(300);
    expect(heard).toEqual(['ping']);

    createSilenceHeartbeat(
      Infinity,
      {
        drop: () => {
          heard.push('drop');
        },
        ping: () => {
          heard.push('ping');
        },
      },
      { clock: PLATFORM_CLOCK }
    );
    await sleep(40);
    expect(heard).toEqual(['ping']);
  });

  test('starts a fresh silence after anything heard answers its ping, then drops a ping left unanswered', async () => {
    const heard: string[] = [];
    const heartbeat = createSilenceHeartbeat(
      100,
      {
        drop: () => {
          heard.push('drop');
        },
        ping: () => {
          heard.push('ping');
        },
      },
      { clock: PLATFORM_CLOCK }
    );

    try {
      await until(() => {
        return heard.length >= 1;
      });
      expect(heard).toEqual(['ping']);
      heartbeat.heard();
      await until(() => {
        return heard.length >= 3;
      });
      expect(heard).toEqual(['ping', 'ping', 'drop']);
    } finally {
      heartbeat.stop();
    }
  });

  test('beats no more once its own ping stopped it', async () => {
    const heard: string[] = [];
    // * a ping that ends its connection, as one past what may wait for its broker does
    const heartbeat = createSilenceHeartbeat(
      100,
      {
        drop: () => {
          heard.push('drop');
        },
        ping: () => {
          heard.push('ping');
          heartbeat.stop();
        },
      },
      { clock: PLATFORM_CLOCK }
    );

    await until(() => {
      return heard.length === 1;
    });
    await sleep(300);
    expect(heard).toEqual(['ping']);
  });
});
