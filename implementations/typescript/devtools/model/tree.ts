// ── A payload's tree ──────────────────────────────────────────────────────────

// What the panel does with a payload previewed as a tree: reads one from a text preview that reads
// as JSON, where the hook sent none; writes it out, indented, a line a value, for the Payload tab
// and the diff; says whether it holds the whole payload; and writes it as JavaScript, for a call
// copied as code.

// dependencies

import type { IPreviewBounds, PreviewNode } from '../preview';

// interfaces

/** One line of a tree written out: its depth, and its text. */
export interface ITreeLine {
  depth: number;
  text: string;
}

// helpers

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** A value JSON read, as a tree's node. */
const nodeOfJson = (value: unknown): PreviewNode => {
  if (Array.isArray(value)) {
    return { items: value.map(nodeOfJson), type: 'array' };
  }

  if (isObject(value)) {
    return {
      entries: Object.entries(value).map(([key, entry]) => {
        return [key, nodeOfJson(entry)];
      }),
      type: 'object',
    };
  }

  return value as PreviewNode;
};

/** What a leaf writes, or `undefined` for a node that holds others. */
const leafTextOf = (node: PreviewNode): string | undefined => {
  if (node === null || typeof node !== 'object') {
    return JSON.stringify(node);
  }

  switch (node.type) {
    case 'bigint':
      return `${node.digits}n`;
    case 'bytes':
      return `<${String(node.length)} bytes${node.length === 0 ? '' : `: ${node.hex}${node.length > 32 ? ' …' : ''}`}>`;
    case 'cut':
      return node.reason === 'cycle' ? '[cycle]' : '…';
    case 'other':
      return node.text;
    case 'text':
      return `${JSON.stringify(node.text)}… ${String(node.more)} more characters`;
    case 'array':
    case 'map':
    case 'object':
    case 'set':
      return undefined;
  }
};

// definition

/** A tree, from a text preview that reads as JSON and holds an object or an array; none otherwise. */
export const treeOfText = (text: string | undefined): PreviewNode | undefined => {
  if (text === undefined) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(text);

    return typeof value === 'object' && value !== null ? nodeOfJson(value) : undefined;
  } catch {
    return undefined;
  }
};

/** Whether a node holds what nests: an array, a set, an object or a map. */
export const isBranch = (node: PreviewNode | undefined): boolean => {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node.type === 'array' || node.type === 'set' || node.type === 'object' || node.type === 'map')
  );
};

/** A tree written out, indented, a line a value: the text its diff compares line by line. */
export const linesOfTree = (node: PreviewNode, depth = 0): ITreeLine[] => {
  const leaf = leafTextOf(node);

  if (leaf !== undefined || node === null || typeof node !== 'object') {
    return [{ depth, text: leaf ?? '' }];
  }

  const [open, close] =
    node.type === 'array'
      ? ['[', ']']
      : node.type === 'set'
        ? ['Set {', '}']
        : node.type === 'map'
          ? ['Map {', '}']
          : ['{', '}'];
  const inner: ITreeLine[] = [];

  if (node.type === 'array' || node.type === 'set') {
    for (const item of node.items) {
      inner.push(...linesOfTree(item, depth + 1));
    }
  } else if (node.type === 'object') {
    for (const [key, entry] of node.entries) {
      const lines = linesOfTree(entry, depth + 1);
      const [first] = lines;

      if (first !== undefined) {
        first.text = `${JSON.stringify(key)}: ${first.text}`;
      }

      inner.push(...lines);
    }
  } else if (node.type === 'map') {
    for (const [key, entry] of node.entries) {
      const lines = linesOfTree(entry, depth + 1);
      const [first] = lines;

      if (first !== undefined) {
        first.text = `${leafTextOf(key) ?? '{…}'} => ${first.text}`;
      }

      inner.push(...lines);
    }
  }

  // only what nests reaches here, and each such node has its bounds
  const { cut, more } = node as IPreviewBounds;

  if (cut === true) {
    inner.push({ depth: depth + 1, text: '…' });
  }

  if (more !== undefined) {
    inner.push({ depth: depth + 1, text: `… ${String(more)} more` });
  }

  return [{ depth, text: open }, ...inner, { depth, text: close }];
};

/** A tree written out as text, two spaces a level. */
export const textOfTree = (node: PreviewNode): string => {
  return linesOfTree(node)
    .map(({ depth, text }) => {
      return `${'  '.repeat(depth)}${text}`;
    })
    .join('\n');
};

/** Whether a tree holds its whole payload: nothing cut, no entry left out, every byte shown. */
export const isWhole = (node: PreviewNode): boolean => {
  if (node === null || typeof node !== 'object') {
    return true;
  }

  switch (node.type) {
    case 'array':
    case 'set':
      return node.cut !== true && node.more === undefined && node.items.every(isWhole);
    case 'bytes':
      return node.length <= 32;
    case 'cut':
    case 'text':
      return false;
    case 'map':
      return (
        node.cut !== true &&
        node.more === undefined &&
        node.entries.every(([key, entry]) => {
          return isWhole(key) && isWhole(entry);
        })
      );
    case 'object':
      return (
        node.cut !== true &&
        node.more === undefined &&
        node.entries.every(([, entry]) => {
          return isWhole(entry);
        })
      );
    case 'other':
      return node.text === 'undefined' || node.text === 'NaN' || /^-?Infinity$/.test(node.text);
    case 'bigint':
      return true;
  }
};

/** A whole tree, as JavaScript that makes its value again; none for one that is not whole. */
export const codeOfTree = (node: PreviewNode): string | undefined => {
  if (!isWhole(node)) {
    return undefined;
  }

  const codeOf = (part: PreviewNode): string => {
    if (part === null || typeof part !== 'object') {
      return JSON.stringify(part);
    }

    switch (part.type) {
      case 'array':
        return `[${part.items.map(codeOf).join(', ')}]`;
      case 'bigint':
        return `${part.digits}n`;
      case 'bytes':
        return `new Uint8Array([${part.hex
          .split(' ')
          .filter(Boolean)
          .map((byte) => {
            return `0x${byte}`;
          })
          .join(', ')}])`;
      case 'map':
        return `new Map([${part.entries
          .map(([key, entry]) => {
            return `[${codeOf(key)}, ${codeOf(entry)}]`;
          })
          .join(', ')}])`;
      case 'object':
        return part.entries.length === 0
          ? '{}'
          : `{ ${part.entries
              .map(([key, entry]) => {
                return `${JSON.stringify(key)}: ${codeOf(entry)}`;
              })
              .join(', ')} }`;
      case 'other':
        return part.text;
      case 'set':
        return `new Set([${part.items.map(codeOf).join(', ')}])`;
      // * a tree cut short is never whole, so never written
      case 'cut':
      case 'text':
        return 'undefined';
    }
  };

  return codeOf(node);
};
