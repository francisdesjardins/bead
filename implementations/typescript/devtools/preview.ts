// ── A payload, previewed ──────────────────────────────────────────────────────

// What the panel shows of a call's payload: a line of text, of bounded length, from whatever its
// procedure decoded — text, bytes, an object — so it crosses a runtime port as JSON, and a large
// payload costs the page no more than its preview; and the same, as a tree of the same bounds, which
// the panel unfolds and compares.

// interfaces

/** Where a preview stands: how deep it is, what it is inside of, and the characters it has left. */
interface IPreviewing {
  budget: { left: number };
  depth: number;
  seen: ReadonlySet<object>;
}

/** What a container of a tree left out: the entries past fifty, and whether its budget ran out. */
export interface IPreviewBounds {
  cut?: true | undefined;
  more?: number | undefined;
}

// types

/**
 * A payload previewed as a tree: what JSON holds as itself — a string, a finite number, a boolean,
 * `null` — and the rest tagged by its `type`, each within the text preview's bounds: what nests,
 * with `more` for the entries left out; bytes, by their length and their first ones in hexadecimal;
 * a bigint, by its digits; a string cut short, with the characters left out; what JSON has no form
 * for, as the text preview writes it; and a cut, past the depth, past the budget, or on a cycle.
 * Every node is JSON, as a runtime port carries it.
 */
export type PreviewNode =
  | boolean
  | number
  | string
  | null
  | (IPreviewBounds & { items: PreviewNode[]; type: 'array' | 'set' })
  | (IPreviewBounds & { entries: [key: string, value: PreviewNode][]; type: 'object' })
  | (IPreviewBounds & { entries: [key: PreviewNode, value: PreviewNode][]; type: 'map' })
  | { hex: string; length: number; type: 'bytes' }
  | { digits: string; type: 'bigint' }
  | { more: number; text: string; type: 'text' }
  | { text: string; type: 'other' }
  | { reason: 'budget' | 'cycle' | 'depth'; type: 'cut' };

// constants

/** The characters a preview holds at most; past them, it ends with an ellipsis. */
export const PREVIEW_CHARACTERS = 2_000;

/** The bytes of a byte array a preview shows, in hexadecimal. */
const PREVIEW_BYTES = 32;

/** The items of an array, or the entries of an object, a map or a set, a preview shows. */
const PREVIEW_ITEMS = 50;

/** How deep a preview goes into what nests. */
const PREVIEW_DEPTH = 4;

// helpers

/** The first `count` items of `iterable`, never walking past them. */
const firstOf = <Item>(iterable: Iterable<Item>, count: number): Item[] => {
  const items: Item[] = [];

  for (const item of iterable) {
    if (items.length === count) {
      break;
    }

    items.push(item);
  }

  return items;
};

const hexOf = (bytes: Uint8Array): string => {
  return [...bytes.subarray(0, PREVIEW_BYTES)]
    .map((byte) => {
      return byte.toString(16).padStart(2, '0');
    })
    .join(' ');
};

/** The bytes of a byte array, or of a view on some; none for anything else. */
const bytesOf = (value: unknown): Uint8Array | undefined => {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : undefined;
};

/** What a value says of itself, when it holds nothing to go into; `undefined` when it does. */
const leafOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    // only what the budget could hold is ever written out
    return value.length > PREVIEW_CHARACTERS
      ? `${JSON.stringify(value.slice(0, PREVIEW_CHARACTERS))}…`
      : JSON.stringify(value);
  }

  if (typeof value === 'bigint') {
    return `${String(value)}n`;
  }

  if (typeof value === 'function') {
    return '[function]';
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value !== 'object' || value === null) {
    return String(value);
  }

  const bytes = bytesOf(value);

  if (bytes !== undefined) {
    const more = bytes.length > PREVIEW_BYTES ? ' …' : '';

    return `<${String(bytes.length)} bytes${bytes.length === 0 ? '' : `: ${hexOf(bytes)}${more}`}>`;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  return undefined;
};

/** A leaf's node: JSON's own value where it has one, else its tag, `leaf` its text preview. */
const leafNodeOf = (value: unknown, leaf: string): PreviewNode => {
  if (typeof value === 'string') {
    return value.length > PREVIEW_CHARACTERS
      ? {
          more: value.length - PREVIEW_CHARACTERS,
          text: value.slice(0, PREVIEW_CHARACTERS),
          type: 'text',
        }
      : value;
  }

  if (typeof value === 'boolean' || value === null) {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { text: leaf, type: 'other' };
  }

  if (typeof value === 'bigint') {
    return { digits: String(value), type: 'bigint' };
  }

  const bytes = bytesOf(value);

  return bytes === undefined
    ? { text: leaf, type: 'other' }
    : { hex: hexOf(bytes), length: bytes.length, type: 'bytes' };
};

/** The node of `value`, where `previewing` stands, spending from its budget as `partOf` does. */
const nodeOf = (value: unknown, previewing: IPreviewing): PreviewNode => {
  const { budget, depth, seen } = previewing;

  if (budget.left <= 0) {
    return { reason: 'budget', type: 'cut' };
  }

  const leaf = leafOf(value);

  if (leaf !== undefined) {
    budget.left -= leaf.length;

    return leafNodeOf(value, leaf);
  }

  const object = value as object;

  if (seen.has(object)) {
    return { reason: 'cycle', type: 'cut' };
  }

  if (depth >= PREVIEW_DEPTH) {
    return { reason: 'depth', type: 'cut' };
  }

  const inner: IPreviewing = { budget, depth: depth + 1, seen: new Set([...seen, object]) };
  const [items, total] =
    object instanceof Map || object instanceof Set
      ? [firstOf<unknown>(object, PREVIEW_ITEMS), object.size]
      : Array.isArray(object)
        ? [object.slice(0, PREVIEW_ITEMS) as unknown[], object.length]
        : [Object.entries(object).slice(0, PREVIEW_ITEMS), Object.keys(object).length];
  const kind =
    object instanceof Map
      ? 'map'
      : object instanceof Set
        ? 'set'
        : Array.isArray(object)
          ? 'array'
          : 'object';
  const nodes: unknown[] = [];

  // the entries the budget reaches, each spending from it as it is previewed
  for (const item of items) {
    if (budget.left <= 0) {
      break;
    }

    if (kind === 'map') {
      const [key, entry] = item as [unknown, unknown];

      nodes.push([nodeOf(key, inner), nodeOf(entry, inner)]);
    } else if (kind === 'object') {
      const [key, entry] = item as [string, unknown];

      nodes.push([key, nodeOf(entry, inner)]);
    } else {
      nodes.push(nodeOf(item, inner));
    }
  }

  const bounds: IPreviewBounds = {
    // a container the budget ran out in says so, as its text preview ends in an ellipsis
    ...(nodes.length < items.length ? { cut: true as const } : {}),
    ...(total > PREVIEW_ITEMS ? { more: total - PREVIEW_ITEMS } : {}),
  };

  if (kind === 'map') {
    return { ...bounds, entries: nodes as [PreviewNode, PreviewNode][], type: kind };
  }

  if (kind === 'object') {
    return { ...bounds, entries: nodes as [string, PreviewNode][], type: kind };
  }

  return { ...bounds, items: nodes as PreviewNode[], type: kind };
};

/** What a preview says of `value`, where `previewing` stands, spending from its budget. */
const partOf = (value: unknown, previewing: IPreviewing): string => {
  const { budget, depth, seen } = previewing;

  if (budget.left <= 0) {
    return '…';
  }

  const leaf = leafOf(value);

  if (leaf !== undefined) {
    budget.left -= leaf.length;

    return leaf;
  }

  const object = value as object;

  if (seen.has(object)) {
    return '[cycle]';
  }

  if (depth >= PREVIEW_DEPTH) {
    return Array.isArray(object) ? '[…]' : '{…}';
  }

  const inner: IPreviewing = { budget, depth: depth + 1, seen: new Set([...seen, object]) };
  const [open, close, items, total] =
    object instanceof Map
      ? (['Map {', '}', firstOf(object, PREVIEW_ITEMS), object.size] as const)
      : object instanceof Set
        ? (['Set {', '}', firstOf(object, PREVIEW_ITEMS), object.size] as const)
        : Array.isArray(object)
          ? (['[', ']', object.slice(0, PREVIEW_ITEMS), object.length] as const)
          : ([
              '{',
              '}',
              Object.entries(object).slice(0, PREVIEW_ITEMS),
              Object.keys(object).length,
            ] as const);
  const parts: string[] = [];

  for (const item of items as unknown[]) {
    if (budget.left <= 0) {
      parts.push('…');

      break;
    }

    if (object instanceof Map) {
      const [key, entry] = item as [unknown, unknown];

      parts.push(`${partOf(key, inner)} => ${partOf(entry, inner)}`);
    } else if (object instanceof Set || Array.isArray(object)) {
      parts.push(partOf(item, inner));
    } else {
      const [key, entry] = item as [string, unknown];

      parts.push(`${JSON.stringify(key)}: ${partOf(entry, inner)}`);
    }
  }

  if (total > PREVIEW_ITEMS && budget.left > 0) {
    parts.push(`… ${String(total - PREVIEW_ITEMS)} more`);
  }

  return `${open}${parts.join(', ')}${close}`;
};

// definition

/**
 * A preview of `value`: a text as itself, JSON's form for the rest where it has one, bytes by their
 * length and their first ones in hexadecimal, what nests cut short past four levels and fifty
 * entries, and {@link PREVIEW_CHARACTERS} characters at most; none when there is no value.
 */
export const previewOf = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  // a payload that is text reads as itself, not as JSON's string
  if (typeof value === 'string' && value !== '') {
    return value.length > PREVIEW_CHARACTERS ? `${value.slice(0, PREVIEW_CHARACTERS)}…` : value;
  }

  const preview = partOf(value, {
    budget: { left: PREVIEW_CHARACTERS },
    depth: 0,
    seen: new Set(),
  });

  return preview.length > PREVIEW_CHARACTERS ? `${preview.slice(0, PREVIEW_CHARACTERS)}…` : preview;
};

/**
 * A preview of `value` as a tree, of {@link previewOf}'s bounds, which the panel unfolds and
 * compares; none when there is no value.
 */
export const previewTreeOf = (value: unknown): PreviewNode | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return nodeOf(value, { budget: { left: PREVIEW_CHARACTERS }, depth: 0, seen: new Set() });
};
