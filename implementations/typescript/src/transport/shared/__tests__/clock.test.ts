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
import { DURATIONS, givenOf, isExcused, outcomeOf, placeHolding, refusalOf } from './durations';

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

    // each assertion over every input of the durations file, as a place that holds its durations so
    for (const [hold, policy] of [
      [assertHeld, { kind: 'timeout', never: 'taken' }],
      [assertHeldFinite, { kind: 'timeout', never: 'refused' }],
      [assertHeldDelay, { kind: 'delay', never: 'refused' }],
    ] as const) {
      const place = placeHolding(policy);

      for (const input of DURATIONS.inputs) {
        if (isExcused(place, { input })) {
          continue;
        }

        const given = givenOf(input);
        const { held, outcome } = outcomeOf(place, input);
        const label = `${hold.name} ${input.name}`;
        const holding = (): number => {
          return hold('a duration', given);
        };

        if (outcome === 'refused') {
          expect(holding, label).toThrow(
            new ProgrammerError(refusalOf(policy, { given, phrase: 'a duration' }))
          );
        } else {
          expect(holding(), label).toBe(outcome === 'at once' ? 0 : (held ?? Infinity));
        }
      }
    }

    // the one sentence of each, written out whole
    for (const [policy, given, sentence] of [
      [
        { kind: 'timeout', never: 'taken' },
        0,
        'a duration is a number of milliseconds from 1 to 2147483647, or Infinity for never, not 0',
      ],
      [
        { kind: 'timeout', never: 'refused' },
        Infinity,
        'a duration is a number of milliseconds from 1 to 2147483647, not Infinity',
      ],
      [
        { kind: 'delay', never: 'refused' },
        0.5,
        'a duration is 0 for at once, or a number of milliseconds from 1 to 2147483647, not 0.5',
      ],
    ] as const) {
      expect(refusalOf(policy, { given, phrase: 'a duration' })).toBe(sentence);
    }
  });

  test('rounds a half up, never to the even', () => {
    expect(assertHeld('a duration', 2.5)).toBe(3);
    expect(assertHeldFinite('a duration', 2.5)).toBe(3);
    expect(assertHeldDelay('a duration', 2.5)).toBe(3);
  });

  test('refuses null and an object, which the durations file holds no input of, as it refuses what is not a number', () => {
    for (const [given, written] of [
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

  // a platform's difference: a JavaScript number holds the milliseconds as written, where a .NET
  // `TimeSpan` truncates them to its ticks of 100 ns, which the C# side's twin shows
  test('a duration finer than a tick is held as written on the TypeScript side, and truncated to its ticks on the C# side', () => {
    expect(() => {
      assertHeldDelay('a duration', 0.000_01);
    }).toThrow(
      new ProgrammerError(
        'a duration is 0 for at once, or a number of milliseconds from 1 to 2147483647, not 0.00001'
      )
    );
    expect(() => {
      assertHeld('a duration', 0.000_01);
    }).toThrow(
      new ProgrammerError(
        'a duration is a number of milliseconds from 1 to 2147483647, or Infinity for never, not 0.00001'
      )
    );
    expect(() => {
      assertHeld('a duration', 2_147_483_647.000_01);
    }).toThrow(
      new ProgrammerError(
        'a duration is a number of milliseconds from 1 to 2147483647, or Infinity for never, not 2147483647.00001'
      )
    );
  });

  // a platform's difference: an option here may be any value, a limit read from JSON among them,
  // where the C# side's is a `TimeSpan`, which holds none of these
  test('a duration that is not a number is refused on the TypeScript side, and no TimeSpan on the C# side', () => {
    for (const [given, written] of [
      [Number.NaN, 'NaN'],
      ['1000', '"1000"'],
      [true, 'true'],
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
