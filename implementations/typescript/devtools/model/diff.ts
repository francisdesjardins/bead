// ── What changed ──────────────────────────────────────────────────────────────

// What the Diff tab shows: one value against the one before it — a subscription's notification
// against its last, an answer against its procedure's last — line by line, as `diff` reads two
// texts: the longest run of lines they share kept, the rest taken out or put in. A value that is a
// tree is written out first, a line a value, so a change reads as the field that moved.

// dependencies

import type { PreviewNode } from '../preview';
import { isBranch, textOfTree, treeOfText } from './tree';

// interfaces

/** A line of a diff: the same in both, taken out of the first, or put into the second. */
export interface IDiffLine {
  change: 'added' | 'removed' | 'same';
  text: string;
}

// constants

/** The lines a side is compared to at most; past them, the rest is compared as one block. */
const DIFF_LINES = 2_000;

// definition

/** The lines of two texts, the longest run they share kept, the rest taken out or put in. */
export const diffLines = (before: readonly string[], after: readonly string[]): IDiffLine[] => {
  const first = before.slice(0, DIFF_LINES);
  const second = after.slice(0, DIFF_LINES);
  // the longest run shared from each pair of places on, read from the end
  const shared: number[][] = Array.from({ length: first.length + 1 }, () => {
    return Array.from({ length: second.length + 1 }, () => {
      return 0;
    });
  });

  for (let one = first.length - 1; one >= 0; one -= 1) {
    for (let other = second.length - 1; other >= 0; other -= 1) {
      const row = shared[one] ?? [];

      row[other] =
        first[one] === second[other]
          ? (shared[one + 1]?.[other + 1] ?? 0) + 1
          : Math.max(shared[one + 1]?.[other] ?? 0, row[other + 1] ?? 0);
    }
  }

  const lines: IDiffLine[] = [];
  let one = 0;
  let other = 0;

  while (one < first.length && other < second.length) {
    if (first[one] === second[other]) {
      lines.push({ change: 'same', text: first[one] ?? '' });
      one += 1;
      other += 1;
    } else if ((shared[one + 1]?.[other] ?? 0) >= (shared[one]?.[other + 1] ?? 0)) {
      lines.push({ change: 'removed', text: first[one] ?? '' });
      one += 1;
    } else {
      lines.push({ change: 'added', text: second[other] ?? '' });
      other += 1;
    }
  }

  return [
    ...lines,
    ...first.slice(one).map((text) => {
      return { change: 'removed' as const, text };
    }),
    ...second.slice(other).map((text) => {
      return { change: 'added' as const, text };
    }),
  ];
};

/** The lines a payload compares by: its tree written out, where it is one, else its text's. */
export const comparedLinesOf = (payload: {
  text: string;
  tree?: PreviewNode | undefined;
}): string[] => {
  const tree = payload.tree ?? treeOfText(payload.text);

  return (tree !== undefined && isBranch(tree) ? textOfTree(tree) : payload.text).split('\n');
};

/** Two payloads compared, line by line. */
export const diffPayloads = (
  before: { text: string; tree?: PreviewNode | undefined },
  after: { text: string; tree?: PreviewNode | undefined }
): IDiffLine[] => {
  return diffLines(comparedLinesOf(before), comparedLinesOf(after));
};
