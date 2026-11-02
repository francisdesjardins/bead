import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { noop } from '../../../transport/shared/noop';
import { createRouterClient } from '../../client/router-client';
import { createRouterServer } from '../../server/router-server';
import { INTAKE_DEFAULTS } from '../constants';
import { intakeLimitsOf } from '../intake-limits';

// a transport that hands nothing on, which a router is built over
const transport = {
  off: noop,
  on: noop,
  pause: noop,
  resume: noop,
  send: () => {
    return Promise.resolve();
  },
};

test.describe('intakeLimitsOf', () => {
  // spec 15.12.17, 15.12.18
  test('the intake limits refuse a bound below 1, and default to 64 and 1 MiB', () => {
    expect(INTAKE_DEFAULTS).toEqual({
      maximumUntakenBytes: 1_048_576,
      maximumUntakenEnvelopes: 64,
    });
    expect(Object.isFrozen(INTAKE_DEFAULTS)).toBe(true);
    expect(intakeLimitsOf()).toEqual(INTAKE_DEFAULTS);
    expect(intakeLimitsOf({ maximumUntakenBytes: undefined, maximumUntakenEnvelopes: 1 })).toEqual({
      maximumUntakenBytes: 1_048_576,
      maximumUntakenEnvelopes: 1,
    });
    expect(Object.isFrozen(intakeLimitsOf({ maximumUntakenBytes: 1 }))).toBe(true);

    for (const value of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => {
        return intakeLimitsOf({ maximumUntakenEnvelopes: value });
      }).toThrow(
        new ProgrammerError(
          `maximumUntakenEnvelopes is a whole number above 0, not ${String(value)}`
        )
      );
      expect(() => {
        return intakeLimitsOf({ maximumUntakenBytes: value });
      }).toThrow(ProgrammerError);
    }

    // * refused as a router is built, a server's and a client's alike
    expect(() => {
      return createRouterServer(transport, { intake: { maximumUntakenBytes: 0 } });
    }).toThrow(ProgrammerError);
    expect(() => {
      return createRouterClient(transport, { intake: { maximumUntakenEnvelopes: 0 } });
    }).toThrow(ProgrammerError);
  });
});
