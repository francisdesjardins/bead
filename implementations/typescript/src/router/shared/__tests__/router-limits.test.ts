import { expect, test } from '@playwright/test';
import { LIMIT_DEFAULTS } from '../constants';
import { createRouterCore } from '../router-core';
import { limitsOf } from '../router-limits';
import { createPort, limits } from './router-core-fixtures';

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

    test('refuses a maximumAnsweringCalls that is not a whole number above 0', () => {
      const { port } = createPort();

      for (const maximumAnsweringCalls of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
        expect(() => {
          return createRouterCore(port, { limits: { maximumAnsweringCalls } });
        }, String(maximumAnsweringCalls)).toThrow(
          /^maximumAnsweringCalls is a whole number above 0, not /
        );
      }

      // a call at once holds, and the default is 64
      expect(limitsOf({ maximumAnsweringCalls: 1 }).maximumAnsweringCalls).toBe(1);
      expect(LIMIT_DEFAULTS.maximumAnsweringCalls).toBe(64);
    });

    test('refuse limits that do not hold together, each rule by its own failure', () => {
      const { port } = createPort();

      for (const [limits, rule] of [
        [{ windowBytes: 0 }, /^windowBytes is a whole number above 0, not 0$/],
        [{ maximumTransfers: -1 }, /^maximumTransfers is a whole number, not -1$/],
        [{ maximumDetailBytes: -1 }, /^maximumDetailBytes is a whole number, not -1$/],
        [{ chunkBytes: 63, maximumEnvelopeBytes: 63 }, /an envelope is 64 bytes at least/],
        [{ chunkBytes: 63 }, /a chunk's envelope is 64 bytes at least/],
        [{ chunkBytes: 1_024, maximumEnvelopeBytes: 1_023 }, /and an envelope at most/],
        [{ chunkBytes: 2_049, maximumEnvelopeBytes: 2_048 }, /and an envelope at most/],
        [{ windowBytes: 2 * 1_048_576 - 1 }, /a window holds two chunks at least/],
        [
          { bufferedBytesBudget: LIMIT_DEFAULTS.maximumPayloadBytes - 1 },
          /a payload fits in the budget/,
        ],
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
        using _withoutTransfers = createRouterCore(port, {
          limits: {
            bufferedBytesBudget: LIMIT_DEFAULTS.maximumPayloadBytes,
            chunkBytes: 64,
            maximumDetailBytes: 0,
            maximumEnvelopeBytes: 64,
            maximumTransfers: 0,
            transferInactivityTimeout: 2 ** 31 - 1,
            windowBytes: 128,
          },
        });
        using _shortest = createRouterCore(port, { limits: { transferInactivityTimeout: 1 } });
      }).not.toThrow();
    });
  });
});

test.describe('limitsOf', () => {
  test('holds the limits given over the defaults, frozen, and refuses limits that do not hold together', () => {
    const held = limitsOf(limits);

    expect(limitsOf(undefined)).toEqual(LIMIT_DEFAULTS);
    expect(held).toEqual({ ...LIMIT_DEFAULTS, ...limits });
    expect(Object.isFrozen(held)).toBe(true);
    expect(() => {
      return limitsOf({ ...limits, windowBytes: 64 });
    }).toThrow(/^the router's limits do not hold together: a window holds two chunks at least/);
  });
});
