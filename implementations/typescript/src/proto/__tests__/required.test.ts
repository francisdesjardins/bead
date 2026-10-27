// ── Required ──────────────────────────────────────────────────────────────────

// The walk of spec 17.9.7 over a message protobuf-es holds, on `spec/transcoding.proto`'s
// `Requiring` and `spec/codecs.proto`'s `Probe`: its order, and what it names. The codec's tests
// play it through the reader and the writer. The C# side's twin is `ProtoRequiredTests`.

// dependencies

import { create, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';
import { ProbeSchema } from '../../router/shared/__tests__/codecs_pb';
import { RequiringSchema } from '../../transcoding/__tests__/generated/transcoding_pb';
import { type RequiredPath, unsetNameOf, unsetPathOf } from '../required';

// helpers

/** A path as its steps' names, an item's index and a map's key as they are. */
const namesOf = (path: RequiredPath | undefined): (number | string)[] | undefined => {
  return path?.map((step) => {
    return typeof step === 'object' ? step.name : step;
  });
};

/** The path the walk gives of a message of `schema` built of `init`. */
const pathOf = <Desc extends DescMessage>(schema: Desc, init: MessageInitShape<Desc>) => {
  return namesOf(unsetPathOf(schema, create(schema, init)));
};

// definition

test.describe('the walk of a required field unset', () => {
  test('takes a message’s own fields by number before what it holds, and what it holds depth first, by field number', () => {
    expect(pathOf(RequiringSchema, { needs: {} })).toEqual(['needs', 'name']);
    expect(pathOf(RequiringSchema, { needs: { child: { name: 'b' }, name: 'a' } })).toEqual([
      'needs',
      'count',
    ]);
    expect(
      pathOf(RequiringSchema, {
        many: [{ name: 'c' }],
        needs: { child: { name: 'b' }, count: 1, name: 'a' },
      })
    ).toEqual(['needs', 'child', 'count']);
    expect(pathOf(RequiringSchema, { many: [{ count: 1, name: 'a' }, { name: 'b' }] })).toEqual([
      'many',
      1,
      'count',
    ]);
    expect(pathOf(RequiringSchema, { needs: { count: 0, name: '' } })).toBeUndefined();
  });

  test('takes a map’s values by key in 18.5’s order, whatever order the map holds them in', () => {
    expect(pathOf(RequiringSchema, { byKey: { b: { name: 'x' }, a: { name: 'y' } } })).toEqual([
      'by_key',
      'a',
      'count',
    ]);
  });

  test('names the field a path leaves unset by its full name', () => {
    const path = unsetPathOf(ProbeSchema, create(ProbeSchema, { needsItems: [{ must: 1 }] }));

    expect(namesOf(path)).toEqual(['needs_items', 0, 'shade']);
    expect(unsetNameOf(path ?? [])).toBe('bead.codecs.v1.Needs.shade');
  });
});
