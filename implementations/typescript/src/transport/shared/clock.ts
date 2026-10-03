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
 * at once. Every timeout Bead takes is refused past it; never is `Infinity`, which arms nothing.
 */
export const LONGEST_TIMER = 2 ** 31 - 1;

/** The platform's clock: the globals themselves, the one place Bead names them. */
export const PLATFORM_CLOCK: IClock = globalThis;

// helpers

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

/**
 * Throws a {@link ProgrammerError} for a timeout past {@link LONGEST_TIMER}, which a timer would fire
 * at once, naming it `name`; `Infinity`, never, arms nothing and passes.
 */
export const assertHeld = (name: string, timeout: number): void => {
  if (Number.isFinite(timeout) && timeout > LONGEST_TIMER) {
    throw new ProgrammerError(
      `${name} is ${String(LONGEST_TIMER)} milliseconds at most, or Infinity for never, not ${String(timeout)}`
    );
  }
};
