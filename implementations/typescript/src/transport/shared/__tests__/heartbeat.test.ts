import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../errors';
import { assertHeartbeat, createHeartbeat, createSilenceHeartbeat, HEARTBEAT } from '../heartbeat';
import { spyIntervals } from './fixtures';

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

  test('pings at each beat while the peer answers, and drops it at the beat after a ping it left unanswered', () => {
    using timers = spyIntervals();
    const heard: string[] = [];
    const heartbeat = createHeartbeat(250, {
      drop: () => {
        heard.push('drop');
      },
      ping: () => {
        heard.push('ping');
      },
    });
    const [timer] = timers.armed;

    // a timer that keeps no process alive
    expect(timer?.delay).toBe(250);
    expect(timer?.unrefs).toBe(1);

    timer?.beat();
    heartbeat.answer();
    timer?.beat();
    timer?.beat();

    expect(heard).toEqual(['ping', 'ping', 'drop']);
    // dropped, it beats no more
    expect(timers.cleared).toEqual([timer]);
  });

  test('arms nothing for Infinity, and a stop clears the timer', () => {
    using timers = spyIntervals();

    createHeartbeat(Infinity, {
      drop: () => {},
      ping: () => {},
    }).stop();

    expect(timers.armed).toEqual([]);

    createHeartbeat(1_000, {
      drop: () => {},
      ping: () => {},
    }).stop();

    expect(timers.cleared.at(-1)).toBe(timers.armed[0]);
  });
  test('pings a connection silent for its heartbeat on the platform’s timer, and drops one that answered nothing by the next', async () => {
    const heard: string[] = [];
    const heartbeatOf = (heartbeat: number) => {
      return createSilenceHeartbeat(heartbeat, {
        drop: () => {
          heard.push('drop');
        },
        ping: () => {
          heard.push('ping');
        },
      });
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

    createSilenceHeartbeat(Infinity, {
      drop: () => {
        heard.push('drop');
      },
      ping: () => {
        heard.push('ping');
      },
    });
    await sleep(40);
    expect(heard).toEqual(['ping']);
  });

  test('beats no more once its own ping stopped it', async () => {
    const heard: string[] = [];
    // * a ping that ends its connection, as one past what may wait for its broker does
    const heartbeat = createSilenceHeartbeat(100, {
      drop: () => {
        heard.push('drop');
      },
      ping: () => {
        heard.push('ping');
        heartbeat.stop();
      },
    });

    await until(() => {
      return heard.length === 1;
    });
    await sleep(300);
    expect(heard).toEqual(['ping']);
  });
});
