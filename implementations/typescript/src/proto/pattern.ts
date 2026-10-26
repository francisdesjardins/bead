// ── Pattern ───────────────────────────────────────────────────────────────────

// A `pattern` rule's match (spec 18.8.5): the DFA beadc builds from the pattern's RE2 program,
// walked a code point at a time, its class by a search of the ranges' bounds, then one cell, so a
// match costs a constant per character whatever the pattern (decision 0035).

// interfaces

/**
 * A pattern's table, as beadc writes it into generated code: the code points split into classes
 * every instruction treats alike, and the transitions of each state by class.
 */
export interface IPatternTable {
  /** The states the text's end leaves matched, ascending. */
  readonly accepting: readonly number[];
  /** The first code point of each range, ascending from 0; a range runs to the next one's. */
  readonly bounds: readonly number[];
  readonly classCount: number;
  /** The class of each range, by its index in `bounds`. */
  readonly classes: readonly number[];
  /** The state no text leaves for a match, or −1. */
  readonly dead: number;
  /** The state a match, once reached, keeps whatever follows, or −1. */
  readonly matched: number;
  readonly stateCount: number;
  /** Each state's next, by class: `stateCount × classCount` cells, the start state 0's first. */
  readonly transitions: Uint16Array;
}

// constants

const REPLACEMENT_CHARACTER = 0xfffd;

const SURROGATES_FIRST = 0xd800;

const SURROGATES_LAST = 0xdfff;

// helpers

/** The class of `point` in `table`: the range it falls in, by a binary search over their bounds. */
const classOf = (table: IPatternTable, point: number): number => {
  const { bounds, classes } = table;
  let low = 0;
  let high = bounds.length - 1;

  while (low < high) {
    const middle = (low + high + 1) >> 1;

    if ((bounds[middle] ?? 0) <= point) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return classes[low] ?? 0;
};

// definition

/**
 * Whether `table`'s pattern matches anywhere in `text`, unless it is anchored: one class and one
 * cell a code point, a surrogate alone read as U+FFFD, as its UTF-8 carries it; the walk ends at
 * the state a match keeps, or at the one no match leaves.
 *
 * @example
 * import { matchesPattern } from '@francisdesjardins/bead/proto';
 *
 * matchesPattern(Address$country$string_pattern$table, 'CA');
 */
export const matchesPattern = (table: IPatternTable, text: string): boolean => {
  const { classCount, dead, matched, transitions } = table;
  let state = 0;

  for (const character of text) {
    const read = character.codePointAt(0) ?? REPLACEMENT_CHARACTER;
    const point =
      read >= SURROGATES_FIRST && read <= SURROGATES_LAST ? REPLACEMENT_CHARACTER : read;

    state = transitions[state * classCount + classOf(table, point)] ?? dead;

    if (state === matched) {
      return true;
    }

    if (state === dead) {
      return false;
    }
  }

  return table.accepting.includes(state);
};
