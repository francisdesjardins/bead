import { expect, test } from '@playwright/test';
import { areSimilar } from '../are-similar';

test.describe('areSimilar', () => {
  test('is similar for the same values, however deep', () => {
    expect(areSimilar(null, null)).toBe(true);
    expect(areSimilar(undefined, undefined)).toBe(true);
    expect(areSimilar([], [])).toBe(true);
    expect(areSimilar({}, {})).toBe(true);
    expect(areSimilar(Infinity, Infinity)).toBe(true);
    expect(areSimilar(666, 666)).toBe(true);
    expect(areSimilar('test', 'test')).toBe(true);
    expect(areSimilar({ a: [1, { b: 'c' }] }, { a: [1, { b: 'c' }] })).toBe(true);
  });

  test('is not similar for different values', () => {
    expect(areSimilar(null, undefined)).toBe(false);
    expect(areSimilar(1, '1')).toBe(false);
    expect(areSimilar([1, 2], [1])).toBe(false);
    expect(areSimilar([1, 2], [1, 3])).toBe(false);
    expect(areSimilar({ test: 'test' }, { test: 'test2' })).toBe(false);
    expect(areSimilar(123, 346)).toBe(false);
    expect(areSimilar('test1', 'test2')).toBe(false);
    expect(areSimilar({ a: 1 }, null)).toBe(false);
    expect(areSimilar(null, { a: 1 })).toBe(false);
  });

  test('counts keys whichever side has fewer', () => {
    expect(areSimilar({}, { a: 1 })).toBe(false);
    expect(areSimilar([1], [1, 2])).toBe(false);
    expect(areSimilar({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  test('compares what a structured clone keeps: dates, expressions, maps, sets, buffers, boxes, errors', () => {
    expect(areSimilar(new Date(1), new Date(1))).toBe(true);
    expect(areSimilar(new Date(1), new Date(2))).toBe(false);
    expect(areSimilar(/a/g, /a/g)).toBe(true);
    expect(areSimilar(/a/g, /a/i)).toBe(false);
    expect(areSimilar(new Map([['k', { v: 1 }]]), new Map([['k', { v: 1 }]]))).toBe(true);
    expect(areSimilar(new Map([['k', 1]]), new Map([['k', 2]]))).toBe(false);
    expect(areSimilar(new Map([['k', 1]]), new Map([['j', 1]]))).toBe(false);
    expect(areSimilar(new Set(['admin']), new Set(['admin']))).toBe(true);
    expect(areSimilar(new Set(['admin']), new Set(['guest']))).toBe(false);
    expect(areSimilar(new Set([{ id: 1 }]), new Set([{ id: 1 }]))).toBe(true);
    expect(areSimilar(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(areSimilar(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(areSimilar(new Uint8Array([1]).buffer, new Uint8Array([2]).buffer)).toBe(false);
    expect(areSimilar(Object(1n), Object(1n))).toBe(true);
    expect(areSimilar(Object('a'), Object('b'))).toBe(false);
    expect(areSimilar(new Error('a'), new Error('a'))).toBe(true);
    expect(areSimilar(new Error('a'), new TypeError('a'))).toBe(false);
  });

  test('never takes one kind for another, but for an array and an object', () => {
    expect(areSimilar(new Date(1), {})).toBe(false);
    expect(areSimilar(new Map(), new Set())).toBe(false);
    expect(areSimilar(new Uint8Array([1]), new Int8Array([1]))).toBe(false);
    expect(areSimilar([], {})).toBe(true);
  });

  test('compares an array by its length too, holes included', () => {
    const holed: unknown[] = [];

    holed[2] = 1;

    expect(areSimilar(holed, [undefined, undefined, 1])).toBe(false);
  });

  test('ends a cycle where it closes, and still sees a difference beyond it', () => {
    interface ICyclic {
      self?: ICyclic;
      v: number;
    }

    const first: ICyclic = { v: 1 };
    const second: ICyclic = { v: 1 };
    const third: ICyclic = { v: 2 };

    first.self = first;
    second.self = second;
    third.self = third;

    expect(areSimilar(first, second)).toBe(true);
    expect(areSimilar({ self: first, v: 1 }, { self: third, v: 1 })).toBe(false);

    // one left object met against two different right ones
    const x: ICyclic = { v: 1 };
    const y: ICyclic = { v: 2 };

    x.self = y;
    y.self = y;

    expect(areSimilar(first, x)).toBe(false);

    // the cycle closes before the difference is reached
    const closesFirst: Record<'self' | 'v', unknown> = { self: undefined, v: 1 };
    const differsLater: Record<'self' | 'v', unknown> = { self: undefined, v: 2 };

    closesFirst.self = closesFirst;
    differsLater.self = differsLater;

    expect(areSimilar(closesFirst, differsLater)).toBe(false);
    expect(areSimilar(closesFirst, structuredClone(closesFirst))).toBe(true);
  });

  test('ends a cycle through a map or a set', () => {
    const map = new Map<string, unknown>([['v', 1]]);
    const set = new Set<unknown>([1]);

    map.set('self', map);
    set.add(set);

    expect(areSimilar(map, structuredClone(map))).toBe(true);
    expect(areSimilar(set, structuredClone(set))).toBe(true);

    const changed = structuredClone(map);

    changed.set('v', 2);

    expect(areSimilar(map, changed)).toBe(false);
  });

  test('walks shared and densely linked data once, rather than once per path', () => {
    interface INode {
      a?: INode;
      b?: INode;
      id: number;
      peers: INode[];
    }

    // a chain where each level points twice at the next: 2^24 paths, 25 nodes
    let shared: INode = { id: 0, peers: [] };

    for (let level = 1; level <= 24; level += 1) {
      shared = { a: shared, b: shared, id: level, peers: [] };
    }

    // ten nodes, each linked to every other
    const nodes: INode[] = Array.from({ length: 10 }, (_, id) => {
      return { id, peers: [] };
    });

    for (const node of nodes) {
      node.peers = nodes.filter((peer) => {
        return peer !== node;
      });
    }

    const started = performance.now();

    expect(areSimilar(shared, structuredClone(shared))).toBe(true);
    expect(areSimilar(nodes, structuredClone(nodes))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('pairs a set’s or a map’s objects one to one, so a lost or changed one is seen', () => {
    expect(
      areSimilar(
        new Set([{ r: 'admin' }, { r: 'guest' }]),
        new Set([{ r: 'admin' }, { r: 'admin' }])
      )
    ).toBe(false);
    expect(
      areSimilar(
        new Set([{ r: 'admin' }, { r: 'guest' }]),
        new Set([{ r: 'guest' }, { r: 'admin' }])
      )
    ).toBe(true);
    // the duplicate on the left, where a reused pairing would hide it
    expect(
      areSimilar(
        new Set([{ r: 'admin' }, { r: 'admin' }]),
        new Set([{ r: 'admin' }, { r: 'guest' }])
      )
    ).toBe(false);
    expect(
      areSimilar(
        new Map([
          [{ id: 1 }, 'a'],
          [{ id: 1 }, 'a'],
        ]),
        new Map([
          [{ id: 1 }, 'a'],
          [{ id: 2 }, 'b'],
        ])
      )
    ).toBe(false);
    expect(areSimilar(new Set([1, { r: 'a' }]), new Set([{ r: 'a' }, 2]))).toBe(false);
    expect(areSimilar(new Map([[{ id: 1 }, 'a']]), new Map([[{ id: 1 }, 'a']]))).toBe(true);
    expect(areSimilar(new Map([[{ id: 1 }, 'a']]), new Map([[{ id: 1 }, 'b']]))).toBe(false);
    expect(
      areSimilar(
        new Map([
          [{ id: 1 }, 'a'],
          [{ id: 2 }, 'b'],
        ]),
        new Map([
          [{ id: 1 }, 'a'],
          [{ id: 1 }, 'b'],
        ])
      )
    ).toBe(false);
  });

  test('a comparison already found different is not taken as similar later', () => {
    const one = { v: 1 };
    const two = { v: 2 };
    const otherTwo = { v: 2 };
    const otherOne = { v: 1 };

    // the set pairing tries (one, otherTwo) and finds it different before `k` compares the same pair
    expect(
      areSimilar(
        { s: new Set([one, two]), k: one },
        { s: new Set([otherTwo, otherOne]), k: otherTwo }
      )
    ).toBe(false);
  });

  test('an invalid date is similar to another, as a structured clone keeps it', () => {
    expect(areSimilar(new Date(Number.NaN), new Date(Number.NaN))).toBe(true);
  });

  test('holds NaN not similar to itself, as `===` does', () => {
    expect(areSimilar(NaN, NaN)).toBe(false);
  });

  test('compares an array and an object by their keys, whichever comes first', () => {
    expect(areSimilar({ 0: 'test' }, ['test'])).toBe(true);
    expect(areSimilar(['test'], { 0: 'test' })).toBe(true);
  });

  test('compares keys, not only values: an undefined under another key is not similar', () => {
    expect(areSimilar({ x: undefined }, { y: undefined })).toBe(false);
    expect(areSimilar({ y: undefined }, { x: undefined })).toBe(false);
  });
});
