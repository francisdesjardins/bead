// ── Clock ─────────────────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from './errors';

// interfaces

/**
 * What Bead takes its time from: the part of the globals it calls, in their own shape, so that the
 * platform's — `globalThis` — is one, and so is a clock never installed on the globals, as
 * `@sinonjs/fake-timers`' `createClock()` makes one. A duration runs on its timers, which keep the
 * platform's handle, `unref` included where it has one; a deadline of Bead's own is compared on
 * `performance.now()`, the monotonic reading; an instant a side reports is `Date.now()`, the wall
 * clock's.
 *
 * @example
 * const transport = createWSTransportClient({ clock: createClock() });
 */
export interface IClock {
  readonly Date: { now(): number };
  readonly performance: { now(): number };
  clearInterval(timer: TimeoutId | undefined): void;
  clearTimeout(timer: TimeoutId | undefined): void;
  setInterval(callback: () => void, delay: number): TimeoutId;
  setTimeout(callback: () => void, delay: number): TimeoutId;
}

// types

/**
 * What a clock's timer is: the handle its `setTimeout` or `setInterval` gives — an object or a
 * number, as its platform makes it — which only it clears.
 */
export type TimeoutId = number | object;

// constants

/**
 * The longest a timer waits, in milliseconds: 2³¹ − 1, JavaScript's, past which `setTimeout` fires
 * at once. Every duration Bead is given is held as a whole number of milliseconds from 1 to it, a
 * fraction rounded to the nearest; never is `Infinity`, which arms nothing.
 */
export const LONGEST_TIMER = 2 ** 31 - 1;

/** The platform's clock: the globals themselves, the one place Bead names them. */
export const PLATFORM_CLOCK: IClock = globalThis;

// helpers

// whether every platform's timers hold `duration` alike once rounded: from 1 to the ceiling, read
// before rounding, so that neither 0.5 nor the ceiling and a half rounds into it
const isHeld = (duration: unknown): duration is number => {
  return typeof duration === 'number' && duration >= 1 && duration <= LONGEST_TIMER;
};

// a duration as a refusal writes it: a string quoted, so `'1000'` reads apart from 1000
const writtenOf = (duration: unknown): string => {
  return typeof duration === 'string' ? JSON.stringify(duration) : String(duration);
};

// a clock as a refusal names it: the platform's, or one of its own, since a test's clock tells its
// reading rather than its name
const nameOf = (clock: IClock): string => {
  return clock === PLATFORM_CLOCK ? "the platform's" : 'one of its own';
};

/**
 * The clock of a layer built on another: the one beneath it, unless it was given one — the one
 * given when there is none beneath, and the platform's when neither is. One given that differs is a
 * {@link ProgrammerError} naming both: `"a server runs on the clock of its transport, one of its
 * own, and was given another, the platform's"`.
 */
export const clockOf = (
  { beneath, given }: { beneath: IClock | undefined; given: IClock | undefined },
  { below, layer }: { below: string; layer: string }
): IClock => {
  if (given === undefined || beneath === undefined || given === beneath) {
    return beneath ?? given ?? PLATFORM_CLOCK;
  }

  throw new ProgrammerError(
    `${layer} runs on the clock of ${below}, ${nameOf(beneath)}, and was given another, ${nameOf(given)}`
  );
};

// the one refusal of a duration, which offers what its place takes besides: 0, a delay's, and
// `Infinity` where never is taken
const refusalOf = (
  name: string,
  { duration, offered }: { duration: unknown; offered: { never: boolean; zero: boolean } }
): ProgrammerError => {
  const zero = offered.zero ? '0 for at once, or ' : '';
  const never = offered.never ? ', or Infinity for never' : '';

  return new ProgrammerError(
    `${name} is ${zero}a number of milliseconds from 1 to ${String(LONGEST_TIMER)}${never}, not ${writtenOf(duration)}`
  );
};

/**
 * `duration` held as every platform's timers hold it alike: a number of milliseconds from 1 to
 * {@link LONGEST_TIMER}, rounded to the nearest whole one, a half up — under a millisecond, Node
 * waits one and .NET none; past the ceiling, a timer fires at once — or `Infinity`, never, which
 * arms nothing. Any other — 0, a negative, `NaN`, or what is not a number at all, a limit read from
 * JSON — is a {@link ProgrammerError} naming the duration `name`. A timeout or a bound where never
 * has no meaning holds to {@link assertHeldFinite}; a delay, which takes 0, to
 * {@link assertHeldDelay}.
 */
export const assertHeld = (name: string, duration: unknown): number => {
  if (duration === Infinity) {
    return Infinity;
  }

  if (!isHeld(duration)) {
    throw refusalOf(name, { duration, offered: { never: true, zero: false } });
  }

  return Math.round(duration);
};

/** As {@link assertHeld}, where never has no meaning: `Infinity` is refused too. */
export const assertHeldFinite = (name: string, duration: unknown): number => {
  if (!isHeld(duration)) {
    throw refusalOf(name, { duration, offered: { never: false, zero: false } });
  }

  return Math.round(duration);
};

/**
 * As {@link assertHeldFinite}, for a delay: 0 is at once, held as 0, for which no timer is armed;
 * `Infinity` is refused, since a delay of never would never end.
 */
export const assertHeldDelay = (name: string, duration: unknown): number => {
  if (duration === 0) {
    return 0;
  }

  if (!isHeld(duration)) {
    throw refusalOf(name, { duration, offered: { never: false, zero: true } });
  }

  return Math.round(duration);
};
