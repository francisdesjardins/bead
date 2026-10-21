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

/** The closing line at its longest, `{"more":N}` with N below 2⁵³, and the line feed before it. */
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

const NUMBERS: ReadonlySet<string> = new Set([
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
  'float',
  'double',
]);

// the words of the rules protovalidate plays itself, and of a flag alone (spec 18.8.6)
const FLAG_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'double.finite': 'must be finite',
  'enum.defined_only': 'value must be one of the defined enum values',
  'float.finite': 'must be finite',
  'repeated.unique': 'repeated value must contain unique items',
});

const PHRASES: Readonly<Record<string, string>> = Object.freeze({
  gt: 'greater than',
  gte: 'greater than or equal to',
  lt: 'less than',
  lte: 'less than or equal to',
});

const RANGE = /^(gte?)_(lte?)(_exclusive)?$/u;

// the kinds whose rules a member's words are rendered for
const RENDERED_KINDS: ReadonlySet<string> = new Set([
  ...NUMBERS,
  'bool',
  'bytes',
  'enum',
  'map',
  'repeated',
  'string',
]);

// helpers

const utf8Length = (text: string): number => {
  return ENCODER.encode(text).length;
};

/** A JSON value's text in section 17.7's form, RFC 8785's, as the `json` codec writes it. */
const canonicalOf = (value: unknown): string => {
  return DECODER.decode(PAYLOAD_CODECS.json.encode(value));
};

/** A violation as its line carries it: its members alone, `value` left on its side. */
const membersOf = (violation: IViolation): Record<string, unknown> => {
  const { bounds, fieldPath, forKey, message, ruleId } = violation;

  return {
    ...(bounds === undefined ? {} : { bounds }),
    ...(fieldPath === undefined ? {} : { fieldPath }),
    ...(forKey === true ? { forKey } : {}),
    ...(message === undefined ? {} : { message }),
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

/** A bound's text, as `%s` writes the value it is: a list by `, `, a string as it is. */
const wordsOfBound = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    const items = value.map(wordsOfBound);

    return items.includes(undefined) ? undefined : `[${items.join(', ')}]`;
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'string') {
    return value;
  }

  // * ECMAScript's Number::toString, section 17.7.4's form of the double a bound is
  return typeof value === 'number' ? String(value) : undefined;
};

/** Bytes given in base64 in lower-case hexadecimal, `%x`'s form; none where they do not read. */
const hexadecimalOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    return Array.from(atob(value), (character) => {
      return (character.codePointAt(0) ?? 0).toString(16).padStart(2, '0');
    }).join('');
  } catch {
    return undefined;
  }
};

/** A member's words, from its kind and its bounds; none where its bound is missing. */
const memberWordsOf = (
  member: string,
  { bounds, kind }: { bounds: Readonly<Record<string, unknown>>; kind: string }
): string | undefined => {
  const bound = bounds[member];
  const text = wordsOfBound(bound);
  const isString = kind === 'string';
  const unit = isString ? 'characters' : 'bytes';

  if (text === undefined) {
    return undefined;
  }

  switch (member) {
    case 'const':
      if (kind === 'bytes') {
        const hexadecimal = hexadecimalOf(bound);

        return hexadecimal === undefined ? undefined : `must be ${hexadecimal}`;
      }

      return isString ? `must equal \`${text}\`` : `must equal ${text}`;
    case 'in':
      return `must be in list ${text}`;
    case 'not_in':
      return `must not be in list ${text}`;
    case 'len':
      return `must be ${text} ${unit}`;
    case 'min_len':
      return `must be at least ${text} ${unit}`;
    case 'max_len':
      return `must be at most ${text} ${unit}`;
    case 'len_bytes':
      return `must be ${text} bytes`;
    case 'min_bytes':
      return `must be at least ${text} bytes`;
    case 'max_bytes':
      return `must be at most ${text} bytes`;
    case 'pattern':
      return `does not match regex pattern \`${text}\``;
    case 'not_contains':
      return `contains substring \`${text}\``;
    case 'min_items':
      return `must contain at least ${text} item(s)`;
    case 'max_items':
      return `must contain no more than ${text} item(s)`;
    case 'min_pairs':
      return `map must be at least ${text} entries`;
    case 'max_pairs':
      return `map must be at most ${text} entries`;
    default:
      break;
  }

  const affix = { contains: 'contain', prefix: 'have prefix', suffix: 'have suffix' }[member];

  if (affix === undefined) {
    return undefined;
  }

  if (isString) {
    return `does not ${affix === 'contain' ? 'contain substring' : affix} \`${text}\``;
  }

  const hexadecimal = hexadecimalOf(bound);

  return hexadecimal === undefined ? undefined : `does not ${affix} ${hexadecimal}`;
};

/** A line read as a violation (spec 18.3): its members alone, each of its type; none otherwise. */
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
    !(forKey === undefined || forKey === true) ||
    !isBounds
  ) {
    return undefined;
  }

  return record as unknown as IViolation;
};

/** A line read as section 17.5 reads a `json` payload; none where it refuses it. */
const readLine = (line: string): unknown => {
  try {
    return PAYLOAD_CODECS.json.decode(ENCODER.encode(line));
  } catch {
    return undefined;
  }
};

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

  const closing = canonicalOf(
    judged.stopped ? { stopped: true } : { more: judged.more + judged.violations.length - held }
  );
  const lines = [...holder.lines, closing];
  const size = lines.reduce((total, line) => {
    return total + utf8Length(line) + 1;
  }, -1);

  return size > maximumBytes ? '' : lines.join(LINE_FEED);
};

/**
 * 18.8.6's words of a violation, from its rule's id and its bounds: none where they do not give
 * them alone, as `required`'s and `message.oneof`'s, which depend on what was judged.
 *
 * @example
 * import { wordsOf } from '@francisdesjardins/bead/service';
 *
 * wordsOf({ bounds: { lte: 10 }, ruleId: 'int32.lte' }); // 'must be less than or equal to 10'
 */
export const wordsOf = (violation: Pick<IViolation, 'bounds' | 'ruleId'>): string | undefined => {
  const { bounds, ruleId } = violation;
  const flag = Object.hasOwn(FLAG_WORDS, ruleId) ? FLAG_WORDS[ruleId] : undefined;
  const dot = ruleId.indexOf('.');
  const kind = ruleId.slice(0, Math.max(dot, 0));
  const member = dot === -1 ? '' : ruleId.slice(dot + 1);

  if (flag !== undefined) {
    return flag;
  }

  if (bounds === undefined || member === '') {
    return undefined;
  }

  const isNumber = NUMBERS.has(kind);

  if ((isNumber || kind === 'enum' || kind === 'bool') && Object.hasOwn(PHRASES, member)) {
    const text = wordsOfBound(bounds[member]);

    return text === undefined ? undefined : `must be ${PHRASES[member] ?? ''} ${text}`;
  }

  const range = RANGE.exec(member);

  if (range !== null && isNumber) {
    const [, lower = '', upper = ''] = range;
    const low = wordsOfBound(bounds[lower]);
    const high = wordsOfBound(bounds[upper]);
    const joined = range[3] === undefined ? 'and' : 'or';

    return low === undefined || high === undefined
      ? undefined
      : `must be ${PHRASES[lower] ?? ''} ${low} ${joined} ${PHRASES[upper] ?? ''} ${high}`;
  }

  return RENDERED_KINDS.has(kind) ? memberWordsOf(member, { bounds, kind }) : undefined;
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

    if (names === 'more' && Number.isInteger(closing['more']) && Number(closing['more']) >= 0) {
      return { more: Number(closing['more']), violations };
    }

    if (names === 'stopped' && closing['stopped'] === true) {
      return { stopped: true, violations };
    }

    break;
  }

  return { violations };
};
