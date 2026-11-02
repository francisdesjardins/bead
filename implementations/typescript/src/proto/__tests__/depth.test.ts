// ── Depth ─────────────────────────────────────────────────────────────────────

// A `proto` writer's depth pass (spec 17.2, 17.9.3), skipped where a message's known fields cannot
// nest past the bound; the Rust side's `required/tests.rs` plays the same sentence.

// dependencies

import { create } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';
import { NeedsSchema, type Probe, ProbeSchema } from '../../router/shared/__tests__/codecs_pb';
import { EdgesSchema } from '../../transcoding/__tests__/generated/transcoding_pb';
import { assertProtoDepth, jsonNestsPast } from '../depth';
import { nestsPastOf } from '../records';

// helpers

/** A value whose every read throws: a walk that looks into it fails. */
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('walked');
    },
    has: () => {
      throw new Error('walked');
    },
  }
);

/** What `act` throws; none when it returns. */
const thrownBy = (act: () => unknown): Error | undefined => {
  try {
    act();
  } catch (error) {
    return error as Error;
  }

  return undefined;
};

// definition

test.describe("a proto writer's depth pass", () => {
  test('walks nothing of a message whose fields cannot nest past the bound', () => {
    // * Needs of spec/codecs.proto holds no message
    expect(nestsPastOf(NeedsSchema)).toBe(false);

    // a cycle nests past: through a child, a map's value, a Struct's Value
    for (const schema of [ProbeSchema, EdgesSchema, ValueSchema]) {
      expect(nestsPastOf(schema), schema.typeName).toBe(true);
    }

    // a value judged by Needs's schema, which nests past nothing: not walked at all
    expect(
      thrownBy(() => {
        assertProtoDepth(NeedsSchema, untouchable);
      })
    ).toBeUndefined();
    expect(
      thrownBy(() => {
        assertProtoDepth(ProbeSchema, untouchable);
      })?.message
    ).toBe('walked');

    // a Probe 101 deep, walked by its own
    let probe: Probe = create(ProbeSchema);

    for (let above = 0; above < 101; above += 1) {
      probe = create(ProbeSchema, { child: probe });
    }

    const refused = thrownBy(() => {
      assertProtoDepth(ProbeSchema, probe);
    });

    expect([refused?.constructor, refused?.message]).toEqual([TypeError, 'nested past 100']);
  });

  // no counterpart: protobuf-es alone holds a Struct of a field as a JSON object, which the HTTP
  // gateway's writer counts with too
  test('counts a JSON object held for a Struct as the wire nests it, three messages a level and an array two', () => {
    // * a JSON object 33 deep, its innermost {"leaf": 1}, the Struct at 1: its last Value at 99
    let object = { leaf: 1 } as Record<string, unknown>;

    for (let level = 1; level < 33; level += 1) {
      object = { k: object };
    }

    expect(jsonNestsPast(object as never, 1)).toBe(false);
    expect(jsonNestsPast({ k: object } as never, 1)).toBe(true);
    // a Struct at 98 whose member's Value, at 100, holds an empty array: its ListValue at 101
    expect(jsonNestsPast({ a: 1 }, 98)).toBe(false);
    expect(jsonNestsPast({ a: [] }, 98)).toBe(true);
    // a Struct itself past the bound, however little it holds
    expect(jsonNestsPast({}, 100)).toBe(false);
    expect(jsonNestsPast({}, 101)).toBe(true);
  });

  // no counterpart: protobuf-es alone holds a wrapper of a singular field as its scalar
  test('counts a wrapper held as its scalar as the message it is on the wire, and a scalar’s list or map item as none', () => {
    const edges = (count: number, deepest: Parameters<typeof create<typeof EdgesSchema>>[1]) => {
      let held = create(EdgesSchema, deepest);

      for (let above = 0; above < count; above += 1) {
        held = create(EdgesSchema, { child: held });
      }

      return held;
    };

    // * the deepest Edges 99 below the top: its wrapper at 100, its list's items and its map's
    // entries of scalars within the bound
    expect(
      thrownBy(() => {
        assertProtoDepth(
          EdgesSchema,
          edges(99, { wrappedFloat: 1.5, ints: [1], labels: { a: 1 } })
        );
      })
    ).toBeUndefined();

    // the deepest Edges 100 below the top: its wrapper at 101
    const refused = thrownBy(() => {
      assertProtoDepth(EdgesSchema, edges(100, { wrappedFloat: 1.5, ints: [1] }));
    });

    expect([refused?.constructor, refused?.message]).toEqual([TypeError, 'nested past 100']);
  });
});
