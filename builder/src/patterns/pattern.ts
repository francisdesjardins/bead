// ── A pattern's table ─────────────────────────────────────────────────────────

// A `string.pattern` compiled ahead of time into the table each runtime walks (spec 18.8.5, decision
// 0035): RE2's unanchored search, protovalidate's `matches`, as a deterministic automaton, so a
// side matches in time linear in the string, one class lookup and one cell a character, whatever
// the pattern, never by backtracking.
//
// The pattern is written out first (`rewrite.ts`), its classes and case folding of beadc's own
// Unicode tables, then compiled by `@bufbuild/re2` into RE2's own program, whose instructions the
// automaton is built from by subset construction:
//
// - its **alphabet**, the code points cut into the classes every instruction treats alike, `\n`
//   and the ASCII word characters kept apart for the assertions;
// - a **state**, the instructions a thread waits at and the kind of the character before, the
//   text's start, `\n`, a word character or another, kept only where an assertion reads it; `^`,
//   `$`, `\b`, `\B` and `(?m)`'s line ends judged as each character is read, and at the text's end
//   by one last closure, whose verdict is the state's `accepting`; a match, once reached, kept for
//   good, as `matches` needs no more;
// - the automaton minimized (Hopcroft's algorithm), then the classes no state tells apart merged.
//
// The table is its states × its classes cells, bounded at `PATTERN_CELLS_MAXIMUM`: a pattern past
// it is refused (`VALIDATE_PATTERN_LARGE`), its states and classes named. The automaton it is
// minimized from is bounded too, at `CONSTRUCTION_CELLS_MAXIMUM` while it is built, so that beadc's
// own time is: a pattern past that is refused alike, by the bound it passed.

// dependencies

import { RE2JS } from '@bufbuild/re2';

import {
  type CodePoints,
  codePointsOf,
  complementOf,
  EVERY_CODE_POINT,
  includes,
  LAST_CODE_POINT,
  rangesOf,
} from './code-points.ts';
import { rewritePattern } from './rewrite.ts';

// types

/**
 * A pattern's table, the data each runtime walks: a character's class by one binary search over
 * `bounds`, then one cell of `transitions`. Every number fits 16 bits but `bounds`, which are code
 * points.
 */
export interface IPatternTable {
  /**
   * The alphabet's ranges, by the code point each starts at, ascending: the first is 0, and each
   * runs to the next one's start, the last to U+10FFFF.
   */
  readonly bounds: readonly number[];
  /** The class of each range of `bounds`, by its index: each distinct class written once. */
  readonly classes: readonly number[];
  /** The number of classes. */
  readonly classCount: number;
  /** The number of states; the start is state 0. */
  readonly stateCount: number;
  /** The next state of each state and class, `transitions[state * classCount + class]`. */
  readonly transitions: readonly number[];
  /** The states the text's end leaves matched, ascending. */
  readonly accepting: readonly number[];
  /** The state a match is reached for good in, whatever follows; `-1` where none is. */
  readonly matched: number;
  /** The state no text that follows can match from; `-1` where none is. */
  readonly dead: number;
}

/** A pattern compiled into its table. */
export interface IPatternCompiled {
  readonly kind: 'table';
  /** The pattern as its author wrote it. */
  readonly pattern: string;
  readonly table: IPatternTable;
}

/**
 * A pattern refused for its size, `VALIDATE_PATTERN_LARGE`: its table, minimized, passes
 * `PATTERN_CELLS_MAXIMUM` cells (`bound` `table`), or the automaton it is minimized from passes 16
 * times as many while it is built, which an unanchored counted `.` does, `a.{20}` (`bound`
 * `construction`).
 */
export interface IPatternLarge {
  readonly kind: 'large';
  readonly pattern: string;
  /** Which bound it passed: its table's, or its construction's. */
  readonly bound: 'construction' | 'table';
  /** Its states: its table's, or, past its construction's bound, those built when it stopped. */
  readonly states: number;
  readonly classes: number;
  /** `states × classes`. */
  readonly cells: number;
}

/** A pattern beadc does not compile, and why: a syntax RE2 refuses, or a name it does not take. */
export interface IPatternRefused {
  readonly kind: 'refused';
  readonly pattern: string;
  readonly reason: string;
}

// a program's instruction, as `@bufbuild/re2` types it
type Instruction = ReturnType<RE2JS['re2']>['prog']['inst'][number];

// constants

/** The most cells a pattern's table holds, its states × its classes (U5). */
export const PATTERN_CELLS_MAXIMUM = 16_384;

/**
 * The most cells the automaton a table is minimized from holds while it is built: past it, the
 * construction stops, so a pattern whose automaton grows exponentially costs a bounded time to
 * refuse, though its table, minimized, may be small (`a.{20}`'s, 22 states × 3 classes).
 */
export const CONSTRUCTION_CELLS_MAXIMUM = PATTERN_CELLS_MAXIMUM * 16;

// ! RE2's instruction codes, its empty-width flags and its fold flag, as `@bufbuild/re2` 0.6.1
// numbers them (`Inst.js`, `Utils.js`, `RE2Flags.js`), which it exports none of: a version moved is
// read again here
const OP = Object.freeze({
  ALT: 1,
  ALT_MATCH: 2,
  CAPTURE: 3,
  EMPTY_WIDTH: 4,
  FAIL: 5,
  MATCH: 6,
  NOP: 7,
  RUNE: 8,
  RUNE1: 9,
  RUNE_ANY: 10,
  RUNE_ANY_NOT_NL: 11,
});
const EMPTY = Object.freeze({
  BEGIN_LINE: 0x01,
  END_LINE: 0x02,
  BEGIN_TEXT: 0x04,
  END_TEXT: 0x08,
  WORD_BOUNDARY: 0x10,
  NO_WORD_BOUNDARY: 0x20,
});
const FOLD_CASE = 0x01;

// the kind of the character before a state, as the assertions read it
const KIND = Object.freeze({ START: 0, NEWLINE: 1, WORD: 2, OTHER: 3 });

const NEWLINE = 0x0a;

// the code points the ASCII word characters start and end at, `[0-9A-Z_a-z]`
const WORD_CUTS = Object.freeze([0x30, 0x3a, 0x41, 0x5b, 0x5f, 0x60, 0x61, 0x7b]);

const REPLACEMENT_CHARACTER = 0xfffd;

// definition

const isWord = (point: number): boolean => {
  return (
    (point >= 0x30 && point <= 0x39) ||
    (point >= 0x41 && point <= 0x5a) ||
    point === 0x5f ||
    (point >= 0x61 && point <= 0x7a)
  );
};

const isRune = (instruction: Instruction): boolean => {
  return instruction.op >= OP.RUNE && instruction.op <= OP.RUNE_ANY_NOT_NL;
};

/**
 * The code points a rune instruction takes. A class of two code points RE2's parser took for a
 * literal folded by its own tables comes back as the two `rewritePattern` wrote.
 */
const codePointsOfRune = (instruction: Instruction, literals: ReadonlySet<number>): CodePoints => {
  const [first = 0] = instruction.runes;

  switch (instruction.op) {
    case OP.RUNE_ANY:
      return EVERY_CODE_POINT;
    case OP.RUNE_ANY_NOT_NL:
      return complementOf([NEWLINE, NEWLINE]);
    case OP.RUNE1:
      return [first, first];
    default:
      break;
  }

  if (instruction.runes.length === 1) {
    if ((instruction.arg & FOLD_CASE) === 0) {
      return [first, first];
    }

    // ! RE2's parser folds a class of two code points, written `[Δδ]` or merged from `Δ|δ`, into
    // one literal when its own tables, the platform's, say each folds to the other: the pair is
    // the two beadc wrote, the other found among them by the instruction's own reading, never a
    // fold of the platform's tables
    const pair = [...literals].filter((point) => {
      return point === first || instruction.matchRune(point);
    });

    if (pair.length !== 2) {
      throw new Error(`a folded literal, U+${first.toString(16)}, of no two code points written`);
    }

    return codePointsOf(
      pair.map((point) => {
        return [point, point];
      })
    );
  }

  const ranges: [number, number][] = [];

  for (let at = 0; at + 1 < instruction.runes.length; at += 2) {
    ranges.push([instruction.runes[at] ?? 0, instruction.runes[at + 1] ?? 0]);
  }

  return codePointsOf(ranges);
};

// the alphabet: the code points cut into the classes every rune instruction treats alike
interface IAlphabet {
  // each range's start, ascending, the first 0
  readonly bounds: readonly number[];
  // each range's class
  readonly classes: readonly number[];
  // a code point of each class
  readonly representatives: readonly number[];
  // whether each rune instruction takes each class, `takes[pc][class]`
  readonly takes: ReadonlyMap<number, readonly boolean[]>;
}

const alphabetOf = (
  instructions: readonly Instruction[],
  literals: ReadonlySet<number>
): IAlphabet => {
  const sets = new Map<string, CodePoints>();
  const setOf = new Map<number, string>();

  instructions.forEach((instruction, pc) => {
    if (isRune(instruction)) {
      const set = codePointsOfRune(instruction, literals);
      const key = set.join(',');

      sets.set(key, set);
      setOf.set(pc, key);
    }
  });

  const cuts = new Set<number>([0, NEWLINE, NEWLINE + 1, ...WORD_CUTS, LAST_CODE_POINT + 1]);

  for (const set of sets.values()) {
    for (const [low, high] of rangesOf(set)) {
      cuts.add(low);
      cuts.add(high + 1);
    }
  }

  const starts = [...cuts]
    .sort((a, b) => {
      return a - b;
    })
    .filter((start) => {
      return start <= LAST_CODE_POINT;
    });
  const keys = [...sets.keys()];
  const bySignature = new Map<string, number>();
  const representatives: number[] = [];
  const classes = starts.map((start) => {
    const kind = start === NEWLINE ? 'n' : isWord(start) ? 'w' : 'o';
    const signature =
      kind +
      keys
        .map((key) => {
          return includes(sets.get(key) ?? [], start) ? '1' : '0';
        })
        .join('');
    const known = bySignature.get(signature);

    if (known !== undefined) {
      return known;
    }

    bySignature.set(signature, representatives.length);
    representatives.push(start);

    return representatives.length - 1;
  });
  const takes = new Map<number, readonly boolean[]>();

  for (const [pc, key] of setOf) {
    const set = sets.get(key) ?? [];

    takes.set(
      pc,
      representatives.map((point) => {
        return includes(set, point);
      })
    );
  }

  return { bounds: starts, classes, representatives, takes };
};

// a state of the construction: the instructions its threads wait at, and the kind before
interface IState {
  readonly pcs: readonly number[];
  readonly kind: number;
}

// an automaton before it is minimized
interface IAutomaton {
  readonly stateCount: number;
  readonly classCount: number;
  readonly transitions: Int32Array;
  readonly accepting: Uint8Array;
}

const flagsOf = (before: number, after: { end: boolean; point: number }): number => {
  let flags = 0;

  if (before === KIND.START) {
    flags |= EMPTY.BEGIN_TEXT | EMPTY.BEGIN_LINE;
  } else if (before === KIND.NEWLINE) {
    flags |= EMPTY.BEGIN_LINE;
  }

  if (after.end) {
    flags |= EMPTY.END_TEXT | EMPTY.END_LINE;
  } else if (after.point === NEWLINE) {
    flags |= EMPTY.END_LINE;
  }

  const wordBefore = before === KIND.WORD;
  const wordAfter = !after.end && isWord(after.point);

  flags |= wordBefore === wordAfter ? EMPTY.NO_WORD_BOUNDARY : EMPTY.WORD_BOUNDARY;

  return flags;
};

/** The automaton of `instructions`' unanchored search, or the cells it passed its bound at. */
const constructionOf = (
  instructions: readonly Instruction[],
  options: { alphabet: IAlphabet; start: number }
): IAutomaton | { readonly states: number; readonly classes: number } => {
  const { alphabet, start } = options;
  const classCount = alphabet.representatives.length;
  const readsLines = instructions.some((instruction) => {
    return instruction.op === OP.EMPTY_WIDTH && (instruction.arg & EMPTY.BEGIN_LINE) !== 0;
  });
  const readsWords = instructions.some((instruction) => {
    return (
      instruction.op === OP.EMPTY_WIDTH &&
      (instruction.arg & (EMPTY.WORD_BOUNDARY | EMPTY.NO_WORD_BOUNDARY)) !== 0
    );
  });
  const kindOf = (point: number): number => {
    if (readsLines && point === NEWLINE) {
      return KIND.NEWLINE;
    }

    return readsWords && isWord(point) ? KIND.WORD : KIND.OTHER;
  };
  const seen = new Uint32Array(instructions.length);
  let generation = 0;

  // the rune instructions a thread reaches from `pcs` and the start, and whether one matched
  const closureOf = (
    pcs: readonly number[],
    flags: number
  ): { matched: boolean; runes: number[] } => {
    generation++;

    const stack = [...pcs, start];
    const runes: number[] = [];
    let matched = false;

    while (stack.length > 0) {
      const pc = stack.pop() ?? 0;
      const instruction = instructions[pc];

      if (instruction === undefined || seen[pc] === generation) {
        continue;
      }

      seen[pc] = generation;

      switch (instruction.op) {
        case OP.ALT:
        case OP.ALT_MATCH:
          stack.push(instruction.arg, instruction.out);
          break;
        case OP.CAPTURE:
        case OP.NOP:
          stack.push(instruction.out);
          break;
        case OP.EMPTY_WIDTH:
          if ((instruction.arg & ~flags) === 0) {
            stack.push(instruction.out);
          }

          break;
        case OP.MATCH:
          matched = true;
          break;
        case OP.FAIL:
          break;
        default:
          runes.push(pc);
      }
    }

    return { matched, runes };
  };

  const states: IState[] = [{ kind: KIND.START, pcs: [] }];
  const byKey = new Map<string, number>([[`${KIND.START}:`, 0]]);
  const transitions: number[] = [];
  const accepting: boolean[] = [];
  // the state a match is kept in, numbered once every other is
  const MATCHED = -1;

  for (let index = 0; index < states.length; index++) {
    const state = states[index] ?? { kind: KIND.OTHER, pcs: [] };
    const closures = new Map<number, { matched: boolean; runes: number[] }>();

    for (let each = 0; each < classCount; each++) {
      const point = alphabet.representatives[each] ?? 0;
      const flags = flagsOf(state.kind, { end: false, point });
      let closure = closures.get(flags);

      if (closure === undefined) {
        closure = closureOf(state.pcs, flags);
        closures.set(flags, closure);
      }

      if (closure.matched) {
        transitions.push(MATCHED);
        continue;
      }

      const next = new Set<number>();

      for (const pc of closure.runes) {
        if (alphabet.takes.get(pc)?.[each] === true) {
          next.add(instructions[pc]?.out ?? 0);
        }
      }

      const pcs = [...next].sort((a, b) => {
        return a - b;
      });
      const kind = kindOf(point);
      const key = `${kind}:${pcs.join(',')}`;
      let target = byKey.get(key);

      if (target === undefined) {
        target = states.length;
        byKey.set(key, target);
        states.push({ kind, pcs });

        if ((states.length + 1) * classCount > CONSTRUCTION_CELLS_MAXIMUM) {
          return { classes: classCount, states: states.length + 1 };
        }
      }

      transitions.push(target);
    }

    accepting.push(closureOf(state.pcs, flagsOf(state.kind, { end: true, point: 0 })).matched);
  }

  const matchedState = states.length;
  const stateCount = states.length + 1;
  const table = new Int32Array(stateCount * classCount);

  transitions.forEach((target, cell) => {
    table[cell] = target === MATCHED ? matchedState : target;
  });

  for (let each = 0; each < classCount; each++) {
    table[matchedState * classCount + each] = matchedState;
  }

  return {
    accepting: Uint8Array.from([...accepting, true], (value) => {
      return value ? 1 : 0;
    }),
    classCount,
    stateCount,
    transitions: table,
  };
};

/** Each state's block of equivalent states, by Hopcroft's partition refinement. */
const blocksOf = (automaton: IAutomaton): Int32Array => {
  const { accepting, classCount, stateCount, transitions } = automaton;
  // the states each state is reached from, by class: `sources[class][target]`
  const sources: number[][][] = Array.from({ length: classCount }, () => {
    return Array.from({ length: stateCount }, () => {
      return [];
    });
  });

  for (let state = 0; state < stateCount; state++) {
    for (let each = 0; each < classCount; each++) {
      sources[each]?.[transitions[state * classCount + each] ?? 0]?.push(state);
    }
  }

  const blockOf = new Int32Array(stateCount);
  const members: number[][] = [];
  const accepted: number[] = [];
  const refused: number[] = [];

  for (let state = 0; state < stateCount; state++) {
    (accepting[state] === 1 ? accepted : refused).push(state);
  }

  for (const block of [accepted, refused]) {
    if (block.length > 0) {
      for (const state of block) {
        blockOf[state] = members.length;
      }

      members.push(block);
    }
  }

  const waiting = members.map((_, block) => {
    return block;
  });
  const isWaiting = new Set(waiting);
  const marked = new Uint8Array(stateCount);

  while (waiting.length > 0) {
    const splitter = waiting.pop() ?? 0;

    isWaiting.delete(splitter);

    const targets = [...(members[splitter] ?? [])];

    for (let each = 0; each < classCount; each++) {
      // the states the splitter is reached from by this class, by their block
      const touched = new Map<number, number[]>();

      for (const target of targets) {
        for (const source of sources[each]?.[target] ?? []) {
          const block = blockOf[source] ?? 0;
          const list = touched.get(block);

          if (list === undefined) {
            touched.set(block, [source]);
          } else {
            list.push(source);
          }
        }
      }

      for (const [block, inside] of touched) {
        const all = members[block] ?? [];

        if (inside.length === all.length) {
          continue;
        }

        for (const state of inside) {
          marked[state] = 1;
        }

        const outside = all.filter((state) => {
          return marked[state] === 0;
        });

        for (const state of inside) {
          marked[state] = 0;
        }

        const created = members.length;

        members[block] = outside;
        members.push(inside);

        for (const state of inside) {
          blockOf[state] = created;
        }

        if (isWaiting.has(block)) {
          waiting.push(created);
          isWaiting.add(created);
        } else {
          const smaller = inside.length <= outside.length ? created : block;

          waiting.push(smaller);
          isWaiting.add(smaller);
        }
      }
    }
  }

  return blockOf;
};

/** The table of `automaton`, minimized, its states numbered from the start, its classes merged. */
const tableOf = (automaton: IAutomaton, alphabet: IAlphabet): IPatternTable => {
  const { classCount, transitions } = automaton;
  const blockOf = blocksOf(automaton);
  // the minimized states, numbered in the order the start reaches them, class by class
  const numberOf = new Map<number, number>();
  const representativeOf: number[] = [];
  const queue = [0];

  numberOf.set(blockOf[0] ?? 0, 0);
  representativeOf.push(0);

  for (let at = 0; at < queue.length; at++) {
    const state = queue[at] ?? 0;

    for (let each = 0; each < classCount; each++) {
      const target = transitions[state * classCount + each] ?? 0;
      const block = blockOf[target] ?? 0;

      if (!numberOf.has(block)) {
        numberOf.set(block, representativeOf.length);
        representativeOf.push(target);
        queue.push(target);
      }
    }
  }

  const stateCount = representativeOf.length;
  const cellOf = (state: number, each: number): number => {
    const representative = representativeOf[state] ?? 0;

    return numberOf.get(blockOf[transitions[representative * classCount + each] ?? 0] ?? 0) ?? 0;
  };

  // the classes no state tells apart, merged, numbered by the first code point of each
  const mergedOf = new Map<string, number>();
  const classOf: number[] = [];
  const columns: number[][] = [];

  for (const each of alphabet.classes) {
    if (classOf[each] !== undefined) {
      continue;
    }

    const column = Array.from({ length: stateCount }, (_, state) => {
      return cellOf(state, each);
    });
    const key = column.join(',');
    const known = mergedOf.get(key);

    if (known === undefined) {
      mergedOf.set(key, columns.length);
      classOf[each] = columns.length;
      columns.push(column);
    } else {
      classOf[each] = known;
    }
  }

  const bounds: number[] = [];
  const classes: number[] = [];

  alphabet.bounds.forEach((start, range) => {
    const merged = classOf[alphabet.classes[range] ?? 0] ?? 0;

    if (classes.at(-1) !== merged) {
      bounds.push(start);
      classes.push(merged);
    }
  });

  const mergedCount = columns.length;
  const cells: number[] = [];

  for (let state = 0; state < stateCount; state++) {
    for (const column of columns) {
      cells.push(column[state] ?? 0);
    }
  }

  const accepting: number[] = [];
  let matched = -1;
  let dead = -1;

  for (let state = 0; state < stateCount; state++) {
    const accepts = automaton.accepting[representativeOf[state] ?? 0] === 1;
    const loops = columns.every((column) => {
      return column[state] === state;
    });

    if (accepts) {
      accepting.push(state);
    }

    if (loops && accepts) {
      matched = state;
    } else if (loops) {
      dead = state;
    }
  }

  return Object.freeze({
    accepting: Object.freeze(accepting),
    bounds: Object.freeze(bounds),
    classCount: mergedCount,
    classes: Object.freeze(classes),
    dead,
    matched,
    stateCount,
    transitions: Object.freeze(cells),
  });
};

/**
 * `pattern` compiled into its table, or refused: past `PATTERN_CELLS_MAXIMUM` cells, or in a syntax
 * RE2 refuses. A pattern buf's `PROTOVALIDATE` took is refused for its size, or for a Unicode name
 * Go takes and RE2 does not.
 */
export const compilePattern = (
  pattern: string
): IPatternCompiled | IPatternLarge | IPatternRefused => {
  const rewritten = rewritePattern(pattern);

  if (rewritten.kind === 'refused') {
    return { kind: 'refused', pattern, reason: rewritten.reason };
  }

  let program: ReturnType<RE2JS['re2']>['prog'];

  try {
    program = new RE2JS(rewritten.text).re2().prog;
  } catch (thrown) {
    return {
      kind: 'refused',
      pattern,
      reason: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }

  const alphabet = alphabetOf(program.inst, rewritten.literals);
  const automaton = constructionOf(program.inst, { alphabet, start: program.start });

  if (!('transitions' in automaton)) {
    const { classes, states } = automaton;

    return {
      bound: 'construction',
      cells: states * classes,
      classes,
      kind: 'large',
      pattern,
      states,
    };
  }

  const table = tableOf(automaton, alphabet);
  const cells = table.stateCount * table.classCount;

  if (cells > PATTERN_CELLS_MAXIMUM) {
    return {
      bound: 'table',
      cells,
      classes: table.classCount,
      kind: 'large',
      pattern,
      states: table.stateCount,
    };
  }

  return { kind: 'table', pattern, table };
};

/** The class of `point` in `table`: the last range of `bounds` that starts at or below it. */
export const classOfPoint = (table: IPatternTable, point: number): number => {
  let low = 0;
  let high = table.bounds.length - 1;

  while (low < high) {
    const middle = (low + high + 1) >> 1;

    if ((table.bounds[middle] ?? 0) <= point) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return table.classes[low] ?? 0;
};

/**
 * Whether `table`'s pattern matches anywhere in `text`, as each runtime walks it: one class and one
 * cell a code point, a lone surrogate read as U+FFFD, as the UTF-8 it would be sent as reads it,
 * then the state the text's end leaves.
 */
export const matchesTable = (table: IPatternTable, text: string): boolean => {
  let state = 0;

  for (const character of text) {
    const read = character.codePointAt(0) ?? REPLACEMENT_CHARACTER;
    const point = read >= 0xd800 && read <= 0xdfff ? REPLACEMENT_CHARACTER : read;

    state = table.transitions[state * table.classCount + classOfPoint(table, point)] ?? 0;

    if (state === table.matched) {
      return true;
    }

    if (state === table.dead) {
      return false;
    }
  }

  return table.accepting.includes(state);
};
