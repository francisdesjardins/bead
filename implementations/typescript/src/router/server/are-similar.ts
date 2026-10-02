// helpers

const asRecord = (value: object): Record<string, unknown> => {
  return value as Record<string, unknown>;
};

/** The bytes a buffer, or a view on one, holds. */
const bytesOf = (value: ArrayBuffer | ArrayBufferView): Uint8Array => {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
};

// JSON's two containers compare key by key, whichever each one is
const isContainer = (tag: string): boolean => {
  return tag === '[object Object]' || tag === '[object Array]';
};

const isBoxed = (tag: string): boolean => {
  return ['[object BigInt]', '[object Boolean]', '[object Number]', '[object String]'].includes(
    tag
  );
};

const isObject = (value: unknown): value is object => {
  return typeof value === 'object' && value !== null;
};

/** A map's entries whose key is an object, as `[key, value]` pairs. */
const entriesKeyedByObjects = (map: ReadonlyMap<unknown, unknown>): unknown[][] => {
  return [...map].filter(([key]) => {
    return isObject(key);
  });
};

/** The built-in kind of an object, as `[object Date]` names it. */
const tagOf = (value: object): string => {
  return Object.prototype.toString.call(value);
};

// definition

/**
 * Whether `a` and `b` hold the same values, as a structured clone keeps them. Primitives compare by
 * `===`, so `NaN` is not similar to itself. Dates compare by time, regular expressions by source
 * and flags, buffers byte by byte, errors by name and message. Maps and sets pair their entries one
 * to one: a primitive key or member by identity, an object one by similarity, since a clone never
 * keeps an object's identity. Objects and arrays compare key by key over their own enumerable keys,
 * so an array and an object with the same keys are similar. A cycle is similar where it closes.
 */
export const areSimilar = (a: unknown, b: unknown): boolean => {
  // every pair taken as similar so far: a cycle ends where it meets one, and shared data is walked
  // once. A pair only stays wrong-footed inside a pairing candidate that fails, and `pairOneToOne`
  // takes those back through the journal; anywhere else, a pair found different ends the comparison.
  const comparing = new WeakMap<object, WeakSet<object>>();
  const journal: [left: object, right: object][] = [];

  const undoTo = (mark: number): void => {
    for (const [left, right] of journal.splice(mark)) {
      comparing.get(left)?.delete(right);
    }
  };

  const compare = (left: unknown, right: unknown): boolean => {
    if (left === right) {
      return true;
    }

    if (!isObject(left) || !isObject(right)) {
      return false;
    }

    let rights = comparing.get(left);

    if (rights === undefined) {
      rights = new WeakSet();
      comparing.set(left, rights);
    }

    if (rights.has(right)) {
      return true;
    }

    rights.add(right);
    journal.push([left, right]);

    return compareObjects(left, right);
  };

  // each of `lefts` paired with a different one of `rights`
  const pairOneToOne = (lefts: unknown[], rights: unknown[]): boolean => {
    const unpaired = [...rights];

    return (
      lefts.length === rights.length &&
      lefts.every((left) => {
        const index = unpaired.findIndex((right) => {
          const mark = journal.length;
          const isSimilar = compare(left, right);

          // a candidate that failed takes back every pair it assumed
          if (!isSimilar) {
            undoTo(mark);
          }

          return isSimilar;
        });

        return index !== -1 && (unpaired.splice(index, 1), true);
      })
    );
  };

  const compareObjects = (left: object, right: object): boolean => {
    const leftTag = tagOf(left);
    const rightTag = tagOf(right);

    if (leftTag !== rightTag && !(isContainer(leftTag) && isContainer(rightTag))) {
      return false;
    }

    if (left instanceof Date && right instanceof Date) {
      return Object.is(left.getTime(), right.getTime());
    }

    if (left instanceof RegExp && right instanceof RegExp) {
      return left.source === right.source && left.flags === right.flags;
    }

    if (left instanceof Map && right instanceof Map) {
      return (
        left.size === right.size &&
        [...left].every(([key, value]) => {
          return isObject(key) || (right.has(key) && compare(value, right.get(key)));
        }) &&
        pairOneToOne(entriesKeyedByObjects(left), entriesKeyedByObjects(right))
      );
    }

    if (left instanceof Set && right instanceof Set) {
      return (
        left.size === right.size &&
        [...left].every((value) => {
          return isObject(value) || right.has(value);
        }) &&
        pairOneToOne([...left].filter(isObject), [...right].filter(isObject))
      );
    }

    if (
      (left instanceof ArrayBuffer || ArrayBuffer.isView(left)) &&
      (right instanceof ArrayBuffer || ArrayBuffer.isView(right))
    ) {
      const leftBytes = bytesOf(left);
      const rightBytes = bytesOf(right);

      return (
        leftBytes.length === rightBytes.length &&
        leftBytes.every((byte, index) => {
          return byte === rightBytes[index];
        })
      );
    }

    if (isBoxed(leftTag)) {
      return left.valueOf() === right.valueOf();
    }

    if (left instanceof Error && right instanceof Error) {
      if (left.name !== right.name || left.message !== right.message) {
        return false;
      }
    }

    if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) {
      return false;
    }

    const keys = Object.keys(left);

    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => {
        return Object.hasOwn(right, key) && compare(asRecord(left)[key], asRecord(right)[key]);
      })
    );
  };

  return compare(a, b);
};
