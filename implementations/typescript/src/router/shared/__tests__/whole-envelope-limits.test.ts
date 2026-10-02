import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { createRouterServer } from '../../server/router-server';
import { LIMIT_DEFAULTS } from '../constants';
import { wholeEnvelopeLimitsOf } from '../whole-envelope-limits';

test.describe('wholeEnvelopeLimitsOf', () => {
  test('takes no transfer, and sizes the chunk and the window on the envelope, the rest as given', () => {
    expect(wholeEnvelopeLimitsOf(undefined)).toEqual({
      chunkBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
      maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
      maximumTransfers: 0,
      windowBytes: 2 * LIMIT_DEFAULTS.maximumEnvelopeBytes,
    });
    expect(
      wholeEnvelopeLimitsOf({
        chunkBytes: 64,
        maximumEnvelopeBytes: 1_024,
        maximumPayloadBytes: 512,
        maximumTransfers: 0,
      })
    ).toEqual({
      chunkBytes: 1_024,
      maximumEnvelopeBytes: 1_024,
      maximumPayloadBytes: 512,
      maximumTransfers: 0,
      windowBytes: 2_048,
    });
  });

  test('gives limits a router holds together, and refuses a transfer asked for', () => {
    expect(() => {
      createRouterServer(
        {
          off: () => {},
          on: () => {},
          send: () => {
            return Promise.resolve();
          },
        },
        { limits: wholeEnvelopeLimitsOf({ maximumEnvelopeBytes: 4_096 }) }
      )[Symbol.dispose]();
    }).not.toThrow();
    expect(() => {
      return wholeEnvelopeLimitsOf({ maximumTransfers: 4 });
    }).toThrow(ProgrammerError);
  });
});
