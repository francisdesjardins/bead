import { expect, test } from '@playwright/test';
import { createClock } from '@sinonjs/fake-timers';
import {
  assertHeld,
  assertHeldDelay,
  assertHeldFinite,
  clockOf,
  type IClock,
  LONGEST_TIMER,
  PLATFORM_CLOCK,
} from '../clock';
import { ProgrammerError } from '../errors';
import { durationsOf } from './fixtures';

test.describe('the clock', () => {
  test("the platform's is the globals themselves", () => {
    expect(PLATFORM_CLOCK).toBe(globalThis);
  });

  test("a fake one, never installed, is one: its timers fire and its readings move as it is advanced, the globals' never", () => {
    const fake = createClock(1_000);
    const clock: IClock = fake;
    const fired: number[] = [];
    const { now } = Date;

    clock.setTimeout(() => {
      fired.push(clock.Date.now());
    }, 250);

    const startedAt = clock.performance.now();

    fake.tick(249);

    expect(fired).toEqual([]);

    fake.tick(1);

    expect(fired).toEqual([1_250]);
    expect(clock.performance.now() - startedAt).toBe(250);
    expect(Date.now).toBe(now);
  });

  test('holds a duration as a whole number of milliseconds from 1 to 2³¹ − 1, a fraction rounded to the nearest, a half up, 0 at once for a delay, and never where never has a meaning, refusing any other in one message', () => {
    expect(LONGEST_TIMER).toBe(2_147_483_647);

    for (const [hold, outcomes] of [
      [assertHeld, { never: 'never', zero: 'refused' }],
      [assertHeldFinite, { never: 'refused', zero: 'refused' }],
      [assertHeldDelay, { never: 'refused', zero: 'at once' }],
    ] as const) {
      for (const { given, held, outcome, refusal } of durationsOf('a duration', outcomes)) {
        const holding = (): number => {
          return hold('a duration', given);
        };

        if (outcome === 'refused') {
          expect(holding, `${hold.name} ${String(given)}`).toThrow(new ProgrammerError(refusal));
        } else {
          expect(holding(), `${hold.name} ${String(given)}`).toBe(held);
        }
      }
    }
  });

  test('rounds a half up, never to the even', () => {
    expect(assertHeld('a duration', 2.5)).toBe(3);
    expect(assertHeldFinite('a duration', 2.5)).toBe(3);
    expect(assertHeldDelay('a duration', 2.5)).toBe(3);
  });

  test('refuses what is not a number at all, as a limit read from JSON may be, a string written in its quotes', () => {
    for (const [given, written] of [
      ['1000', '"1000"'],
      [true, 'true'],
      [null, 'null'],
      [{}, '[object Object]'],
    ] as const) {
      expect(() => {
        assertHeld('a duration', given);
      }, written).toThrow(
        new ProgrammerError(
          `a duration is a number of milliseconds from 1 to 2147483647, or Infinity for never, not ${written}`
        )
      );
    }
  });

  // a platform's difference: -1 here is a number under a millisecond, where .NET's -1 ms is its
  // infinite, `Timeout.InfiniteTimeSpan`, which the C# side's twin takes as never
  test('a duration of -1 ms is refused on the TypeScript side, and never on the C# side', () => {
    expect(() => {
      assertHeld('a duration', -1);
    }).toThrow(
      new ProgrammerError(
        'a duration is a number of milliseconds from 1 to 2147483647, or Infinity for never, not -1'
      )
    );
    expect(() => {
      assertHeldFinite('a duration', -1);
    }).toThrow(
      new ProgrammerError('a duration is a number of milliseconds from 1 to 2147483647, not -1')
    );
  });

  test('a layer runs on the clock of the one beneath it, unless given one, and refuses one that differs, naming both', () => {
    const beneath = createClock();
    const given = createClock();
    const names = { below: 'its transport', layer: 'a server' };

    expect(clockOf({ beneath, given: undefined }, names)).toBe(beneath);
    expect(clockOf({ beneath, given: beneath }, names)).toBe(beneath);
    expect(clockOf({ beneath: undefined, given }, names)).toBe(given);
    expect(clockOf({ beneath: undefined, given: undefined }, names)).toBe(PLATFORM_CLOCK);
    expect(() => {
      clockOf({ beneath, given }, names);
    }).toThrow(
      new ProgrammerError(
        'a server runs on the clock of its transport, one of its own, and was given another, one of its own'
      )
    );
    expect(() => {
      clockOf({ beneath, given: PLATFORM_CLOCK }, names);
    }).toThrow(
      new ProgrammerError(
        "a server runs on the clock of its transport, one of its own, and was given another, the platform's"
      )
    );
  });
});
