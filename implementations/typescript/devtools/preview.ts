// ── A payload, previewed ──────────────────────────────────────────────────────

// What the panel shows of a call's payload: a line of text, of bounded length, from whatever its
// procedure decoded — text, bytes, an object — so it crosses a runtime port as JSON, and a large
// payload costs the page no more than its preview.

// interfaces

/** Where a preview stands: how deep it is, what it is inside of, and the characters it has left. */
interface IPreviewing {
  budget: { left: number };
  depth: number;
  seen: ReadonlySet<object>;
}

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

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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
