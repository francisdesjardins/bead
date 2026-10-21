// ── Templates ─────────────────────────────────────────────────────────────────

// `http.proto`'s path templates (spec/transcoding.md 3): parsed by its grammar, a request's path
// matched raw, its verb split at the last unencoded `:`, the routes ordered by the peers'
// precedence, and each variable's value decoded.

// dependencies

import { STRICT_UTF8 } from '../router/shared/payloads';
import { ProgrammerError } from '../transport/shared/errors';

// types

/** A segment of a template: a literal, `*`, one segment, or `**`, zero or more. */
export type Segment =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'star' }
  | { readonly kind: 'stars' };

/** A template read: parsed, or refused and why. */
export type TemplateReading =
  | { readonly reason?: undefined; readonly template: ITemplate }
  | { readonly reason: string; readonly template?: undefined };

/** A variable's values decoded, by their field paths, or why one does not decode. */
export type VariablesReading =
  | { readonly reason?: undefined; readonly variables: Readonly<Record<string, string>> }
  | { readonly reason: string; readonly variables?: undefined };

// interfaces

/** A variable of a template: its field path, and the segments it takes, `start` to `end`. */
export interface IVariable {
  readonly end: number;
  readonly fieldPath: string;
  /** Whether it takes more than one segment, or `**`: its value keeps each `%2F` (3.8). */
  readonly isMultiSegment: boolean;
  readonly start: number;
}

/** A template of `http.proto`'s grammar, parsed. */
export interface ITemplate {
  readonly segments: readonly Segment[];
  readonly text: string;
  readonly variables: readonly IVariable[];
  readonly verb?: string | undefined;
}

/** A request's path as a route matches it: its segments raw, its verb split off. */
export interface IRawPath {
  readonly segments: readonly string[];
  readonly verb?: string | undefined;
}

// constants

// a literal of a template, and a field path of a variable (http.proto's grammar)
const LITERAL = /^[A-Za-z0-9._~-]+/u;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/u;

// a percent-encoded octet, and a `%` of a path that two hexadecimal digits follow
const OCTET = /%([0-9A-Fa-f]{2})/gu;
const PERCENT = /%(?![0-9A-Fa-f]{2})/u;
// what a multi-segment variable keeps as it came (http.proto:252-253)
const SLASH = /^%2f$/iu;

// a segment's rank under 3.5's precedence: a literal, then `*`, then `**`; a template that ends
// where the path ends before a `**` that takes none
const END = -1;
const LITERAL_RANK = 0;
const STAR_RANK = 1;
const STARS_RANK = 2;

// helpers

class Refusal extends Error {}

// a template's text from `at`, parsed into `segments` and `variables`, inside a variable or not
const parseSegments = (
  text: string,
  state: {
    at: number;
    inside: boolean;
    segments: Segment[];
    variables: { end: number; fieldPath: string; start: number }[];
  }
): void => {
  for (;;) {
    const rest = text.slice(state.at);

    if (rest.startsWith('**')) {
      state.segments.push({ kind: 'stars' });
      state.at += 2;
    } else if (rest.startsWith('*')) {
      state.segments.push({ kind: 'star' });
      state.at += 1;
    } else if (rest.startsWith('{')) {
      if (state.inside) {
        throw new Refusal('a variable within a variable');
      }

      const path = FIELD_PATH.exec(rest.slice(1));

      if (path === null) {
        throw new Refusal('a variable that names no field path');
      }

      const start = state.segments.length;

      state.at += 1 + path[0].length;

      if (text.startsWith('=', state.at)) {
        state.at += 1;
        state.inside = true;
        parseSegments(text, state);
        state.inside = false;
      } else {
        state.segments.push({ kind: 'star' });
      }

      if (!text.startsWith('}', state.at)) {
        throw new Refusal('a variable that does not close');
      }

      state.at += 1;
      state.variables.push({ end: state.segments.length, fieldPath: path[0], start });
    } else {
      const literal = LITERAL.exec(rest);

      if (literal === null) {
        throw new Refusal('a literal that is no segment');
      }

      state.segments.push({ kind: 'literal', text: literal[0] });
      state.at += literal[0].length;
    }

    if (!text.startsWith('/', state.at)) {
      return;
    }

    state.at += 1;
  }
};

const rankOf = (segment: Segment): number => {
  if (segment.kind === 'literal') {
    return LITERAL_RANK;
  }

  return segment.kind === 'star' ? STAR_RANK : STARS_RANK;
};

// a matching template's ranks for a path of `count` segments (3.5)
const ranksOf = (template: ITemplate, count: number): number[] => {
  return [...template.segments.map(rankOf), ...(template.segments.length === count ? [END] : [])];
};

// whether a segment is `.` or `..`, as it came or once percent-decoded (3.6)
const isDotSegment = (segment: string): boolean => {
  const decoded = segment.replaceAll(/%2e/giu, '.');

  return decoded === '.' || decoded === '..';
};

/**
 * `text` percent-decoded, each `%XX` an octet but what `keeps` keeps, then read as UTF-8: a `%`
 * that two hexadecimal digits do not follow, or bytes that are no UTF-8, refused.
 */
const decodeOf = (text: string, keeps?: RegExp): string => {
  if (PERCENT.test(text)) {
    throw new Refusal('a % that two hexadecimal digits do not follow');
  }

  // * the text's own characters as UTF-8, each octet decoded beside them, read as one sequence
  const parts: number[] = [];
  const encoder = new TextEncoder();
  let at = 0;

  for (const match of text.matchAll(OCTET)) {
    parts.push(...encoder.encode(text.slice(at, match.index)));

    if (keeps?.test(match[0]) === true) {
      parts.push(...encoder.encode(match[0]));
    } else {
      parts.push(Number.parseInt(match[1] ?? '', 16));
    }

    at = match.index + match[0].length;
  }

  parts.push(...encoder.encode(text.slice(at)));

  try {
    return STRICT_UTF8.decode(new Uint8Array(parts));
  } catch {
    throw new Refusal('a value whose bytes are not UTF-8');
  }
};

// definition

/**
 * `text` parsed as `http.proto`'s grammar writes a template (`:221-230`), or why it is not one:
 * `/` first, then segments, each a literal, `*`, `**` or a variable, `**` last but the verb, and a
 * verb of one literal after a `:` (transcoding 3.9).
 */
export const parseTemplate = (text: string): TemplateReading => {
  const state = {
    at: 0,
    inside: false,
    segments: [] as Segment[],
    variables: [] as { end: number; fieldPath: string; start: number }[],
  };
  let verb: string | undefined;

  try {
    if (!text.startsWith('/')) {
      throw new Refusal('a template that does not begin with /');
    }

    state.at = 1;
    parseSegments(text, state);

    if (text.startsWith(':', state.at)) {
      const literal = LITERAL.exec(text.slice(state.at + 1));

      if (literal === null || state.at + 1 + literal[0].length !== text.length) {
        throw new Refusal('a verb that is no literal');
      }

      verb = literal[0];
      state.at = text.length;
    }

    if (state.at !== text.length) {
      throw new Refusal('a literal that is no segment');
    }

    if (
      state.segments.slice(0, -1).some((segment) => {
        return segment.kind === 'stars';
      })
    ) {
      throw new Refusal('a ** that is not its last segment');
    }
  } catch (error) {
    if (error instanceof Refusal) {
      return { reason: error.message };
    }

    throw error;
  }

  const { segments } = state;

  return {
    template: Object.freeze({
      segments: Object.freeze(segments),
      text,
      variables: Object.freeze(
        state.variables.map(({ end, fieldPath, start }) => {
          return Object.freeze({
            end,
            fieldPath,
            isMultiSegment:
              end - start > 1 ||
              segments.slice(start, end).some((segment) => {
                return segment.kind === 'stars';
              }),
            start,
          });
        })
      ),
      ...(verb === undefined ? {} : { verb }),
    }),
  };
};

/** `text` parsed, for a route table's template; one off the grammar is a {@link ProgrammerError}. */
export const templateOf = (text: string): ITemplate => {
  const { reason, template } = parseTemplate(text);

  if (template === undefined) {
    throw new ProgrammerError(`${text} is no template of http.proto's: ${reason}`);
  }

  return template;
};

/** Whether two templates tie under 3.5's precedence: one shape, up to their variables' names (3.9). */
export const isTie = (one: ITemplate, other: ITemplate): boolean => {
  const shapeOf = (template: ITemplate): string => {
    const segments = template.segments.map((segment) => {
      if (segment.kind === 'literal') {
        return `=${segment.text}`;
      }

      return segment.kind === 'star' ? '*' : '**';
    });

    return `/${segments.join('/')}${template.verb === undefined ? '' : `:${template.verb}`}`;
  };

  return shapeOf(one) === shapeOf(other);
};

/**
 * A request's path, raw, as routes match it (3.6, 3.7): its segments by `/`, its verb what follows
 * the last `:` its last segment holds unencoded; none for a path that matches no route, one with an
 * empty segment or a dot segment, raw or once decoded.
 */
export const rawPathOf = (path: string): IRawPath | undefined => {
  if (!path.startsWith('/')) {
    return undefined;
  }

  const segments = path.slice(1).split('/');
  const last = segments.at(-1) ?? '';
  const colon = last.lastIndexOf(':');
  const verb = colon === -1 ? undefined : last.slice(colon + 1);

  if (colon !== -1) {
    segments[segments.length - 1] = last.slice(0, colon);
  }

  if (
    segments.some((segment) => {
      return segment === '' || isDotSegment(segment);
    })
  ) {
    return undefined;
  }

  return { segments, ...(verb === undefined ? {} : { verb }) };
};

/**
 * Whether `template` matches `path`: its verb the path's, a literal its segment's text exactly, `*`
 * one segment, `**` the rest, none among them (3.6, 3.7).
 */
export const matchesTemplate = (template: ITemplate, path: IRawPath): boolean => {
  const { segments } = template;

  if (template.verb !== path.verb) {
    return false;
  }

  const isOpen = segments.at(-1)?.kind === 'stars';
  const fixed = isOpen ? segments.slice(0, -1) : segments;

  if (isOpen ? path.segments.length < fixed.length : path.segments.length !== fixed.length) {
    return false;
  }

  return fixed.every((segment, index) => {
    return segment.kind !== 'literal' || segment.text === path.segments[index];
  });
};

/**
 * Of two templates that match `path`, the order 3.5 answers them by: below 0 where `one` answers,
 * above 0 where `other` does, compared segment by segment from the first.
 */
export const comparePrecedence = (
  one: ITemplate,
  { other, path }: { other: ITemplate; path: IRawPath }
): number => {
  const left = ranksOf(one, path.segments.length);
  const right = ranksOf(other, path.segments.length);

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return left.length - right.length;
};

/**
 * The index of the template of `templates` that answers `path` by 3.5's precedence, the first of
 * two that tie; none where none matches.
 */
export const routeIndexOf = (
  templates: readonly ITemplate[],
  path: IRawPath
): number | undefined => {
  let best: number | undefined;

  for (const [index, template] of templates.entries()) {
    if (!matchesTemplate(template, path)) {
      continue;
    }

    const held = best === undefined ? undefined : templates[best];

    if (held === undefined || comparePrecedence(template, { other: held, path }) < 0) {
      best = index;
    }
  }

  return best;
};

/**
 * The values `template`'s variables take of `path`, which it matches, by their field paths: each
 * its segments by `/`, a single-segment one percent-decoded whole, a multi-segment one but each
 * `%2F` and `%2f`, which stays as it came (3.8); or why one does not decode, which a gateway answers
 * 400 `PAYLOAD_UNDECODABLE`.
 */
export const variablesOf = (template: ITemplate, path: IRawPath): VariablesReading => {
  const { segments } = template;
  // the path's segments a template's segment takes: one each, the rest for a `**`
  const taken = (from: number, to: number): string[] => {
    const isOpen = segments.at(-1)?.kind === 'stars';
    const end = isOpen && to === segments.length ? path.segments.length : to;

    return path.segments.slice(from, end);
  };
  const variables: Record<string, string> = {};

  try {
    for (const variable of template.variables) {
      const value = taken(variable.start, variable.end).join('/');

      variables[variable.fieldPath] = variable.isMultiSegment
        ? value
            .split(/(%2f)/iu)
            .map((part) => {
              return SLASH.test(part) ? part : decodeOf(part);
            })
            .join('')
        : decodeOf(value);
    }
  } catch (error) {
    if (error instanceof Refusal) {
      return { reason: error.message };
    }

    throw error;
  }

  return { variables };
};

/**
 * `text` percent-decoded and read as UTF-8, as a query's name or value is once its `+` became a
 * space (transcoding 4.3); none where its bytes are no UTF-8. A `%` that two hexadecimal digits do
 * not follow stays as it is, as the WHATWG URL Standard's decoder leaves it.
 */
export const queryDecodeOf = (text: string): string | undefined => {
  try {
    return decodeOf(text.replaceAll(/%(?![0-9A-Fa-f]{2})/gu, '%25'));
  } catch {
    return undefined;
  }
};
