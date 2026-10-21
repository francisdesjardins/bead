// ── Violations ────────────────────────────────────────────────────────────────

// PAYLOAD_INVALID's violations and its detail (spec 18.3, 18.6, 18.7): lines of canonical JSON, a
// violation a line in their order, then a closing line, written under the detail's bound and read
// back line by line, each through the `json` codec, so a cut keeps every whole line.

// dependencies

import { FailureScope, ProtocolCode } from './constants';
import { PAYLOAD_CODECS } from './payloads';
import type { IFailure, IRouterLimits } from './types';

// interfaces

/**
 * A violation, the breach of one rule (spec 18.3): its path, its rule's id, the bounds its rule
 * takes, its words, and whether it is a map key's; and the value that broke it, which stays on the
 * side that judged and never goes on the wire.
 */
export interface IViolation {
  /** The members its rule takes, as protobuf's JSON mapping writes them; none for a flag alone. */
  readonly bounds?: Readonly<Record<string, unknown>> | undefined;
  /** The path from the request's message to the field (spec 18.4); none for the message's own. */
  readonly fieldPath?: string | undefined;
  readonly forKey?: true | undefined;
  /** Its words (spec 18.8.6); a violation read without them keeps none where its rule gives none. */
  readonly message?: string | undefined;
  readonly ruleId: string;
  /** What broke it, held by the side that judged alone. */
  readonly value?: unknown;
}

/**
 * What a judging gives: the violations its detail can carry, in their order (spec 18.5), the count
 * of the rest, and whether it stopped at its first.
 */
export interface IJudged {
  readonly more: number;
  readonly stopped: boolean;
  readonly violations: readonly IViolation[];
}

/** What a validator is given: whether it stops at its first violation, and its detail's bound. */
export interface IValidateOptions {
  /** Stops at the first violation, protovalidate's `failFast`; every rule is judged otherwise. */
  readonly failFast?: boolean | undefined;
  /** The bytes of the detail its violations are written in; unbounded when not given. */
  readonly maximumBytes?: number | undefined;
}

/**
 * What a reader read of a detail (spec 18.7): its violations, and its closing line's count, or that
 * its side stopped; neither where the detail holds no closing line.
 */
export interface IReadViolations {
  readonly more?: number;
  readonly stopped?: true;
  readonly violations: readonly IViolation[];
}

/** A placeholder of a template: the member it is written from, whether as bytes, and the text after it. */
interface IPlaceholder {
  readonly isBytes: boolean;
  readonly name: string;
  readonly tail: string;
}

/** A rule's template (spec 18.8.6): its words before its first placeholder, then its placeholders. */
interface ITemplate {
  readonly head: string;
  readonly placeholders: readonly IPlaceholder[];
}

/** What holds a judging's violations within a detail's bound, line by line as its writer writes. */
export interface IViolationHolder {
  /** The lines held, in their order. */
  readonly lines: readonly string[];

  /**
   * Holds `violation` where one of its lines holds, the 26 bytes of the closing line kept; the first
   * that holds in none fills it, and every one after is refused.
   */
  hold: (violation: IViolation) => boolean;
}

// constants

/** The closing line at its longest, `{"more":N}` with N at 2⁵³ − 1, and the line feed before it. */
export const CLOSING_BYTES = 26;

// what an envelope holds beside a failure's detail: its prefix, an announcement's block, its
// record (spec 7.4)
const ENVELOPE_BESIDE_DETAIL = 32;

const LINE_FEED = '\n';

const DECODER = new TextDecoder();

const ENCODER = new TextEncoder();

const VIOLATION_MEMBERS: ReadonlySet<string> = new Set([
  'bounds',
  'fieldPath',
  'forKey',
  'message',
  'ruleId',
]);

// the largest count a closing line writes and reads, the largest integer an I-JSON number holds
// exactly (RFC 7493 §2.2)
const LARGEST_COUNT = Number.MAX_SAFE_INTEGER;

// the twelve number types of validate.proto's rules
const NUMBER_TYPES: readonly string[] = Object.freeze([
  'float',
  'double',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
]);

const BOUND_WORDS = Object.freeze({
  gt: 'greater than',
  gte: 'greater than or equal to',
  lt: 'less than',
  lte: 'less than or equal to',
});

// a template's placeholders, each written from the member beside it (spec 18.8.6)
const PLACEHOLDER = /%[dsx]/u;

// the members a list is written for, in and not_in alone; every other member is a scalar
const LISTS: ReadonlySet<string> = new Set(['in', 'not_in']);

// base64 as RFC 4648 §4 writes it: its standard alphabet, by fours, padded to the last
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

// helpers

const utf8Length = (text: string): number => {
  return ENCODER.encode(text).length;
};

/** A JSON value's text in section 17.7's form, RFC 8785's, as the `json` codec writes it. */
const canonicalOf = (value: unknown): string => {
  return DECODER.decode(PAYLOAD_CODECS.json.encode(value));
};

/**
 * A violation as its line carries it (spec 18.6, 18.7): its members alone, none empty — no
 * `fieldPath` or `message` of `''`, no `bounds` of `{}`, no `forKey` but `true` — and `value` left
 * on its side.
 */
const membersOf = (violation: IViolation): Record<string, unknown> => {
  const { bounds, fieldPath, forKey, message, ruleId } = violation;

  return {
    ...(bounds === undefined || Object.keys(bounds).length === 0 ? {} : { bounds }),
    ...(fieldPath === undefined || fieldPath === '' ? {} : { fieldPath }),
    ...(forKey === true ? { forKey } : {}),
    ...(message === undefined || message === '' ? {} : { message }),
    ruleId,
  };
};

/** A violation's lines, whole, then without its `message`, then without its `bounds` too. */
const linesOf = (violation: IViolation): string[] => {
  const whole = membersOf(violation);
  const { message: _message, ...short } = whole;
  const { bounds: _bounds, ...shortest } = short;

  return [...new Set([canonicalOf(whole), canonicalOf(short), canonicalOf(shortest)])];
};

/**
 * The placeholders of `text`, which opens on one, each `%s`, `%d` or `%x` with the member of `names`
 * it takes, in their order, and the text after it up to the next.
 */
const placeholdersOf = (text: string, names: readonly string[]): IPlaceholder[] => {
  const [name, ...rest] = names;

  if (name === undefined) {
    return [];
  }

  const after = text.slice(2);
  const next = after.search(PLACEHOLDER);
  const tail = next === -1 ? after : after.slice(0, next);

  return [
    Object.freeze({ isBytes: text.startsWith('%x'), name, tail }),
    ...placeholdersOf(after.slice(tail.length), rest),
  ];
};

/** The template of `words`, each of its placeholders written from the member of `names` beside it. */
const templateOf = (words: string, names: readonly string[] = []): ITemplate => {
  const first = words.search(PLACEHOLDER);
  const head = first === -1 ? words : words.slice(0, first);

  return Object.freeze({ head, placeholders: placeholdersOf(words.slice(head.length), names) });
};

/** A number type's templates, by their ids: its `const`, its bounds, its ranges, reversed or not, its lists. */
const numberTemplatesOf = (kind: string): [string, ITemplate][] => {
  const bounds = (['lt', 'lte', 'gt', 'gte'] as const).map((member): [string, ITemplate] => {
    return [`${kind}.${member}`, templateOf(`must be ${BOUND_WORDS[member]} %s`, [member])];
  });
  const ranges = (['gt', 'gte'] as const).flatMap((lower) => {
    return (['lt', 'lte'] as const).flatMap((upper) => {
      const words = (joined: string): string => {
        return `must be ${BOUND_WORDS[lower]} %s ${joined} ${BOUND_WORDS[upper]} %s`;
      };

      return [
        [`${kind}.${lower}_${upper}`, templateOf(words('and'), [lower, upper])],
        [`${kind}.${lower}_${upper}_exclusive`, templateOf(words('or'), [lower, upper])],
      ] satisfies [string, ITemplate][];
    });
  });

  return [
    [`${kind}.const`, templateOf('must equal %s', ['const'])],
    ...bounds,
    ...ranges,
    [`${kind}.in`, templateOf('must be in list %s', ['in'])],
    [`${kind}.not_in`, templateOf('must not be in list %s', ['not_in'])],
  ];
};

/** A scalar as `%s` writes it: a string as it is, a number as section 17.7.4 writes it, a literal. */
const scalarWordsOf = (value: unknown): string | undefined => {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
};

/** Bytes in base64 as RFC 4648 §4 writes them, in lower-case hexadecimal, `%x`'s form; none otherwise. */
const hexadecimalOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !BASE64.test(value)) {
    return undefined;
  }

  return Array.from(atob(value), (character) => {
    return character.charCodeAt(0).toString(16).padStart(2, '0');
  }).join('');
};

const isWords = (words: readonly (string | undefined)[]): words is readonly string[] => {
  return !words.includes(undefined);
};

/**
 * A member's words, as its placeholder writes it: bytes in hexadecimal, `in` and `not_in` as a list
 * of scalars, `[`, its items by `, `, `]`, any other a scalar; none where it is missing or of another
 * shape.
 */
const memberWordsOf = (
  { isBytes, name }: IPlaceholder,
  bounds: Readonly<Record<string, unknown>> | undefined
): string | undefined => {
  const value = bounds !== undefined && Object.hasOwn(bounds, name) ? bounds[name] : undefined;

  if (isBytes) {
    return hexadecimalOf(value);
  }

  if (!LISTS.has(name)) {
    return scalarWordsOf(value);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.map(scalarWordsOf);

  return isWords(items) ? `[${items.join(', ')}]` : undefined;
};

/** A line read as a violation (spec 18.3, 18.7): its members alone, each of its type, none empty. */
const asViolation = (value: unknown): IViolation | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const { bounds, fieldPath, forKey, message, ruleId } = record;
  const isBounds =
    bounds === undefined ||
    (typeof bounds === 'object' && bounds !== null && !Array.isArray(bounds));

  if (
    !Object.keys(record).every((name) => {
      return VIOLATION_MEMBERS.has(name);
    }) ||
    typeof ruleId !== 'string' ||
    !(fieldPath === undefined || typeof fieldPath === 'string') ||
    !(message === undefined || typeof message === 'string') ||
    !(forKey === undefined || typeof forKey === 'boolean') ||
    !isBounds
  ) {
    return undefined;
  }

  // * a member empty is absent, as protovalidate drops an empty field path or message
  return membersOf(record as unknown as IViolation) as unknown as IViolation;
};

/** A line read as section 17.5 reads a `json` payload; none where it refuses it. */
const readLine = (line: string): unknown => {
  try {
    return PAYLOAD_CODECS.json.decode(ENCODER.encode(line));
  } catch {
    return undefined;
  }
};

// the templates of the rules beadc compiles, by their ids, each its rule's in validate.proto: a reader
// gives words to these alone (spec 18.8.6)
const TEMPLATES: Readonly<Record<string, ITemplate>> = Object.freeze(
  Object.fromEntries([
    ...NUMBER_TYPES.flatMap(numberTemplatesOf),
    ['float.finite', templateOf('must be finite')],
    ['double.finite', templateOf('must be finite')],
    ['bool.const', templateOf('must equal %s', ['const'])],
    ['string.const', templateOf('must equal `%s`', ['const'])],
    ['string.len', templateOf('must be %s characters', ['len'])],
    ['string.min_len', templateOf('must be at least %s characters', ['min_len'])],
    ['string.max_len', templateOf('must be at most %s characters', ['max_len'])],
    ['string.len_bytes', templateOf('must be %s bytes', ['len_bytes'])],
    ['string.min_bytes', templateOf('must be at least %s bytes', ['min_bytes'])],
    ['string.max_bytes', templateOf('must be at most %s bytes', ['max_bytes'])],
    ['string.pattern', templateOf('does not match regex pattern `%s`', ['pattern'])],
    ['string.prefix', templateOf('does not have prefix `%s`', ['prefix'])],
    ['string.suffix', templateOf('does not have suffix `%s`', ['suffix'])],
    ['string.contains', templateOf('does not contain substring `%s`', ['contains'])],
    ['string.not_contains', templateOf('contains substring `%s`', ['not_contains'])],
    ['string.in', templateOf('must be in list %s', ['in'])],
    ['string.not_in', templateOf('must not be in list %s', ['not_in'])],
    ['bytes.const', templateOf('must be %x', ['const'])],
    ['bytes.len', templateOf('must be %s bytes', ['len'])],
    ['bytes.min_len', templateOf('must be at least %s bytes', ['min_len'])],
    ['bytes.max_len', templateOf('must be at most %s bytes', ['max_len'])],
    ['bytes.prefix', templateOf('does not have prefix %x', ['prefix'])],
    ['bytes.suffix', templateOf('does not have suffix %x', ['suffix'])],
    ['bytes.contains', templateOf('does not contain %x', ['contains'])],
    ['enum.const', templateOf('must equal %s', ['const'])],
    ['enum.defined_only', templateOf('value must be one of the defined enum values')],
    ['enum.in', templateOf('must be in list %s', ['in'])],
    ['enum.not_in', templateOf('must not be in list %s', ['not_in'])],
    ['repeated.min_items', templateOf('must contain at least %d item(s)', ['min_items'])],
    ['repeated.max_items', templateOf('must contain no more than %s item(s)', ['max_items'])],
    ['repeated.unique', templateOf('repeated value must contain unique items')],
    ['map.min_pairs', templateOf('map must be at least %d entries', ['min_pairs'])],
    ['map.max_pairs', templateOf('map must be at most %d entries', ['max_pairs'])],
  ])
);

// definition

/**
 * The detail's bound under `limits` (spec 7.4): `maximumDetailBytes`, and `maximumEnvelopeBytes`
 * less the 32 bytes an envelope holds beside its detail.
 */
export const detailBoundOf = (
  limits: Pick<IRouterLimits, 'maximumDetailBytes' | 'maximumEnvelopeBytes'>
): number => {
  return Math.max(
    0,
    Math.min(limits.maximumDetailBytes, limits.maximumEnvelopeBytes - ENVELOPE_BESIDE_DETAIL)
  );
};

/** Whether a judging refuses its request: a violation held, or one counted past its bound. */
export const isRefused = (judged: IJudged): boolean => {
  return judged.violations.length > 0 || judged.more > 0;
};

/**
 * What holds violations within a detail of `maximumBytes`: each in the first of its lines that
 * holds, whole, then without its `message`, then without its `bounds` too, with 26 bytes kept for
 * the closing line; the first that holds in none ends them (spec 18.6).
 */
export const createViolationHolder = (maximumBytes: number): IViolationHolder => {
  const lines: string[] = [];
  let size = 0;
  let isFull = false;

  return {
    hold: (violation) => {
      if (isFull) {
        return false;
      }

      const separator = lines.length > 0 ? 1 : 0;

      for (const line of linesOf(violation)) {
        const length = utf8Length(line);

        if (size + separator + length + CLOSING_BYTES <= maximumBytes) {
          size += separator + length;
          lines.push(line);

          return true;
        }
      }

      isFull = true;

      return false;
    },
    lines,
  };
};

/**
 * The detail of PAYLOAD_INVALID that `judged` gives, under `maximumBytes` (spec 18.6): the lines of
 * the violations it holds, then `{"more":N}`, N every one it leaves out, or `{"stopped":true}`; an
 * empty detail where the bound holds no closing line.
 *
 * @example
 * import { violationsDetailOf } from '@francisdesjardins/bead/service';
 *
 * const detail = violationsDetailOf(judged, { maximumBytes: 1_024 });
 */
export const violationsDetailOf = (
  judged: IJudged,
  { maximumBytes }: { maximumBytes: number }
): string => {
  const holder = createViolationHolder(maximumBytes);
  let held = 0;

  for (const violation of judged.violations) {
    if (!holder.hold(violation)) {
      break;
    }

    held += 1;
  }

  // * a count past 2⁵³ − 1 is written as it, the largest integer I-JSON holds (spec 18.6)
  const closing = canonicalOf(
    judged.stopped
      ? { stopped: true }
      : { more: Math.min(judged.more + judged.violations.length - held, LARGEST_COUNT) }
  );
  const lines = [...holder.lines, closing];
  const size = lines.reduce((total, line) => {
    return total + utf8Length(line) + 1;
  }, -1);

  return size > maximumBytes ? '' : lines.join(LINE_FEED);
};

/**
 * 18.8.6's words of a violation, from its rule's id and its bounds, for the rules beadc compiles
 * alone, by their templates in `validate.proto`: none for another id, as `required`'s and
 * `message.oneof`'s, which depend on what was judged, or a CEL rule's, nor where a member its
 * template takes is missing or of another shape.
 *
 * @example
 * import { wordsOf } from '@francisdesjardins/bead/service';
 *
 * wordsOf({ bounds: { lte: 10 }, ruleId: 'int32.lte' }); // 'must be less than or equal to 10'
 */
export const wordsOf = (violation: Pick<IViolation, 'bounds' | 'ruleId'>): string | undefined => {
  const { bounds, ruleId } = violation;
  const template = Object.hasOwn(TEMPLATES, ruleId) ? TEMPLATES[ruleId] : undefined;

  if (template === undefined) {
    return undefined;
  }

  const pieces = template.placeholders.map((placeholder) => {
    const words = memberWordsOf(placeholder, bounds);

    return words === undefined ? undefined : `${words}${placeholder.tail}`;
  });

  return isWords(pieces) ? `${template.head}${pieces.join('')}` : undefined;
};

/**
 * The violations a PAYLOAD_INVALID's detail carries (spec 18.7): each whole line that reads as one,
 * up to the first that does not, a line without its `message` given the words its rule and its
 * bounds give; then its closing line's count, or that its side stopped. A failure of another code,
 * or a detail whose first line is neither, gives none, and the failure stands by its code.
 *
 * @example
 * import { FailureError, violationsOf } from '@francisdesjardins/bead/service';
 *
 * greeter.request
 *   .sayHello({ name: '' })()
 *   .catch((reason: unknown) => {
 *     if (reason instanceof FailureError) {
 *       const { more, violations } = violationsOf(reason);
 *     }
 *   });
 */
export const violationsOf = (
  failure: Pick<IFailure, 'code' | 'detail' | 'scope'>
): IReadViolations => {
  const { code, detail = '', scope } = failure;
  const violations: IViolation[] = [];

  if (code !== ProtocolCode.PAYLOAD_INVALID || scope !== FailureScope.PROTOCOL || detail === '') {
    return { violations };
  }

  for (const line of detail.split(LINE_FEED)) {
    const value = readLine(line);
    const violation = asViolation(value);

    if (violation !== undefined) {
      const words = violation.message === undefined ? wordsOf(violation) : undefined;

      violations.push(words === undefined ? violation : { ...violation, message: words });

      continue;
    }

    const closing = (typeof value === 'object' && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    const names = Object.keys(closing).join(',');

    // * a count is an integer from 0 to 2⁵³ − 1 (spec 18.7); any other leaves the detail uncounted
    if (names === 'more' && Number.isSafeInteger(closing['more']) && Number(closing['more']) >= 0) {
      // * a count of -0 is 0
      return { more: Math.abs(Number(closing['more'])), violations };
    }

    if (names === 'stopped' && closing['stopped'] === true) {
      return { stopped: true, violations };
    }

    break;
  }

  return { violations };
};
