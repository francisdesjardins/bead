// dependencies

import type { ITimestamp } from './types';

// definition

/**
 * Now, or — given `previous` — the time elapsed since it, with a negative microsecond part floored
 * at zero rather than borrowed from the seconds.
 */
export const timestamp = (previous?: ITimestamp): ITimestamp => {
  const ms = Date.now();

  const sec = Math.floor(ms / 1_000);
  const usec = (ms % 1_000) * 1_000;

  return previous
    ? {
        ms: ms - previous.ms,
        sec: sec - previous.sec,
        usec: usec - previous.usec < 0 ? 0 : usec - previous.usec,
      }
    : {
        ms,
        sec,
        usec,
      };
};
