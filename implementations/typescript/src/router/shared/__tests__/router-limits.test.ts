import { expect, test } from '@playwright/test';
import { createRouterCore } from '../router-core';
import { createPort } from './router-core-fixtures';

// definition

test.describe('createRouterCore', () => {
  test.describe('its limits', () => {
    test('take the defaults where they say nothing, and let the transfers and the detail be none', () => {
      const { port } = createPort();

      expect(() => {
        using _core = createRouterCore(port, {
          limits: { chunkBytes: undefined, maximumDetailBytes: 0, maximumTransfers: 0 },
        });
      }).not.toThrow();
    });

    test('refuse a limit that is not a whole number, or not above 0 where 0 means nothing', () => {
      const { port } = createPort();

      for (const [limits, named] of [
        [{ chunkBytes: 1_024.5 }, /^chunkBytes is a whole number above 0/],
        [{ windowBytes: 0 }, /^windowBytes is a whole number above 0/],
        [{ maximumPayloadBytes: Number.NaN }, /^maximumPayloadBytes is a whole number above 0/],
        [{ maximumTransfers: -1 }, /^maximumTransfers is a whole number, not -1/],
        [{ maximumDetailBytes: 2 ** 53 }, /^maximumDetailBytes is a whole number, not/],
      ] as const) {
        expect(() => {
          return createRouterCore(port, { limits });
        }, JSON.stringify(limits)).toThrow(named);
      }
    });

    test('refuse limits that do not hold together, each rule by its own failure', () => {
      const { port } = createPort();

      for (const [limits, rule] of [
        [{ chunkBytes: 63, maximumEnvelopeBytes: 63 }, /an envelope is 64 bytes at least/],
        [{ chunkBytes: 63 }, /a chunk's envelope is 64 bytes at least/],
        [{ chunkBytes: 2_049, maximumEnvelopeBytes: 2_048 }, /and an envelope at most/],
        [{ windowBytes: 2 * 1_048_576 - 1 }, /a window holds two chunks at least/],
        [{ maximumPayloadBytes: 268_435_457 }, /a payload fits in the budget/],
      ] as const) {
        expect(() => {
          return createRouterCore(port, { limits });
        }, JSON.stringify(limits)).toThrow(rule);
      }

      // the edges hold, a transfer's inactivity of a millisecond among them
      expect(() => {
        using _core = createRouterCore(port, {
          limits: {
            chunkBytes: 64,
            maximumEnvelopeBytes: 64,
            maximumPayloadBytes: 268_435_456,
            transferInactivityTimeout: 2 ** 31 - 1,
            windowBytes: 128,
          },
        });
        using _shortest = createRouterCore(port, { limits: { transferInactivityTimeout: 1 } });
      }).not.toThrow();
    });
  });
});
