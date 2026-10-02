import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../errors';
import { assertHeartbeat, createHeartbeat, HEARTBEAT } from '../heartbeat';
import { spyIntervals } from './fixtures';

// definition

test.describe('heartbeat', () => {
  test('takes a whole number of milliseconds a timer holds, or Infinity for none, and nothing else', () => {
    for (const heartbeat of [1, HEARTBEAT, 2 ** 31 - 1, Infinity]) {
      expect(() => {
        assertHeartbeat(heartbeat);
      }, String(heartbeat)).not.toThrow();
    }

    for (const heartbeat of [0, -1, 1.5, Number.NaN, 2 ** 31, -Infinity]) {
      expect(() => {
        assertHeartbeat(heartbeat);
      }, String(heartbeat)).toThrow(ProgrammerError);
    }

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
});
