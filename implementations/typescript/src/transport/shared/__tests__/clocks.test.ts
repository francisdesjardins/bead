// ── Clocks ────────────────────────────────────────────────────────────────────

// Bead's clock cases, `spec/clocks.json`, played on the test clock the harnesses give the side under
// test, started at the file's wall clock: what an advance and a wall step do to the timers a case
// arms and to the readings. The C# side's test clock plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { IClock } from '../clock';
import { createTestClock } from './fixtures';

// interfaces

/** A timer a case arms: due in `due` milliseconds, every `period` after that, arming `then` as it fires. */
interface IArm {
  due: number;
  period?: number;
  then?: IArm;
  timer: string;
}

/** A timer that fired, and the monotonic reading its callback read, from the case's start. */
interface IFired {
  at: number;
  timer: string;
}

/** One step of a case: what it does to the clock, or what the clock did. */
interface IStep {
  advance?: number;
  arm?: IArm;
  fired?: IFired[];
  readings?: { monotonic?: number; wall?: string };
  wall?: number;
}

interface IClockCase {
  name: string;
  steps: IStep[];
}

// constants

const { cases: CASES, wallClock: WALL_CLOCK } = JSON.parse(
  readFileSync(new URL('../../../../../../spec/clocks.json', import.meta.url), 'utf8')
) as { cases: IClockCase[]; wallClock: string };

// definition

test.describe('the clock cases', () => {
  // played once, as the C# side plays them: a retry would hide what fails there
  test.describe.configure({ retries: 0 });

  for (const { name, steps } of CASES) {
    test(name, async () => {
      const clock = createTestClock(Date.parse(WALL_CLOCK));
      // the readings, as Bead reads them, the monotonic one from the case's start
      const given: IClock = clock;
      const startedAt = given.performance.now();
      const fired: IFired[] = [];
      const monotonic = (): number => {
        return given.performance.now() - startedAt;
      };
      // its callback notes its firing, then arms what follows from the reading it read; a period
      // other than its due repeats from its first firing on
      const arm = ({ due, period, then, timer }: IArm): void => {
        const fire = (): void => {
          fired.push({ at: monotonic(), timer });

          if (then !== undefined) {
            arm(then);
          }
        };

        if (period === due) {
          clock.setInterval(fire, period);

          return;
        }

        clock.setTimeout(() => {
          fire();

          if (period !== undefined) {
            clock.setInterval(fire, period);
          }
        }, due);
      };

      for (const [index, step] of steps.entries()) {
        const at = `step ${String(index + 1)}`;

        if (step.arm !== undefined) {
          arm(step.arm);
        }

        if (step.advance !== undefined) {
          await clock.tickAsync(step.advance);
        }

        if (step.wall !== undefined) {
          clock.setSystemTime(clock.Date.now() + step.wall);
        }

        if (step.fired !== undefined) {
          expect(fired.splice(0), `${at}: the timers fired`).toEqual(step.fired);
        }

        if (step.readings !== undefined) {
          const { readings } = step;

          expect(
            {
              ...('monotonic' in readings ? { monotonic: monotonic() } : {}),
              ...('wall' in readings ? { wall: new Date(given.Date.now()).toISOString() } : {}),
            },
            `${at}: the readings`
          ).toEqual(readings);
        }
      }
    });
  }
});
