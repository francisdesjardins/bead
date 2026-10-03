import { expect, test } from '@playwright/test';
import { createClock } from '@sinonjs/fake-timers';
import { assertHeld, clockOf, type IClock, LONGEST_TIMER, PLATFORM_CLOCK } from '../clock';
import { ProgrammerError } from '../errors';

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

  test('its ceiling is 2³¹ − 1 milliseconds, past which a timeout is refused, and never is Infinity', () => {
    expect(LONGEST_TIMER).toBe(2_147_483_647);

    expect(() => {
      assertHeld('a timeout', LONGEST_TIMER);
      assertHeld('a timeout', Infinity);
    }).not.toThrow();
    expect(() => {
      assertHeld('a timeout', LONGEST_TIMER + 1);
    }).toThrow(
      new ProgrammerError(
        'a timeout is 2147483647 milliseconds at most, or Infinity for never, not 2147483648'
      )
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
