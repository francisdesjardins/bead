// ── Debug filter ──────────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { EnvelopeKind } from './constants';
import type {
  DebugDirection,
  DebugFilterSource,
  DebugType,
  IDebugEvent,
  IDebugFilter,
  ServiceManagerOnDebugCallback,
} from './types';

// interfaces

/** What a router tells `debug` of each envelope, whichever side it is on. */
interface IEnvelopeDebug {
  direction: DebugDirection;
  header: { kind: EnvelopeKind };
}

/** The values one selector's letter names, by their names in the grammar, and what it calls them. */
interface ISelected<Value> {
  readonly named: ReadonlyMap<string, Value>;
  readonly what: string;
}

// constants

const DIRECTIONS: readonly DebugDirection[] = Object.freeze(['rx', 'tx']);
const TYPES: readonly DebugType[] = Object.freeze(['request', 'command', 'notification']);

// the kinds by their names in section 3.1, in lower case, in the order of their numbers
const KIND_NAMES: ReadonlyMap<string, EnvelopeKind> = new Map(
  Object.entries(EnvelopeKind).map(([name, kind]) => {
    return [name.toLowerCase(), kind];
  })
);

// each selector's letter's values, by the grammar's rules `direction`, `type` — its short forms
// among them — and `kind`
const DIRECTION_NAMES: ISelected<DebugDirection> = {
  named: new Map(
    DIRECTIONS.map((direction) => {
      return [direction, direction];
    })
  ),
  what: 'direction',
};
const TYPE_NAMES: ISelected<DebugType> = {
  named: new Map<string, DebugType>([
    ...TYPES.map((type) => {
      return [type, type] as const;
    }),
    ['r', 'request'],
    ['c', 'command'],
    ['n', 'notification'],
  ]),
  what: 'type',
};
const KIND_SELECTED: ISelected<EnvelopeKind> = { named: KIND_NAMES, what: 'kind' };

// a selector's letter, read in ASCII case
const SELECTORS: ReadonlySet<string> = new Set(['d', 'e', 't']);

// ! a separator is a comma or one of the six characters C's isspace reads as white space in the C
// locale: nothing outside ASCII parts two words (spec/debugging.md 6.2)
const SEPARATORS = /[,\t\n\v\f\r ]+/;

const STAR = '*'.codePointAt(0) as number;
const UPPER_A = 'A'.codePointAt(0) as number;
const UPPER_Z = 'Z'.codePointAt(0) as number;
const LOWER_A = 'a'.codePointAt(0) as number;
const LOWER_Z = 'z'.codePointAt(0) as number;

// helpers

/** `value` quoted as JSON writes a string (RFC 8259): what a refusal names, as it was written. */
const quotedOf = (value: unknown): string => {
  return JSON.stringify(value);
};

/** `text` with its ASCII capitals lowered, and nothing else: U+212A and U+0130 stay as they are. */
const asciiLowerOf = (text: string): string => {
  return text.replaceAll(/[A-Z]/g, (letter) => {
    return letter.toLowerCase();
  });
};

/** `codePoint` lowered when it is an ASCII capital, and as it is otherwise. */
const foldedOf = (codePoint: number): number => {
  return codePoint >= UPPER_A && codePoint <= UPPER_Z ? codePoint + (LOWER_A - UPPER_A) : codePoint;
};

/** Whether `codePoint` is an ASCII letter, which a pattern matches in either case. */
const isAsciiLetter = (codePoint: number): boolean => {
  const folded = foldedOf(codePoint);

  return folded >= LOWER_A && folded <= LOWER_Z;
};

/**
 * Whether `name` matches `pattern` whole, both by code point: `*` any run, none included, line
 * terminators among them; an ASCII letter itself in either case; any other code point itself alone.
 */
const matchesWhole = (pattern: readonly number[], name: readonly number[]): boolean => {
  let at = 0;
  let of = 0;
  // where the last star stood, and how far into the name it reached so far
  let star = -1;
  let reached = 0;

  while (of < name.length) {
    const wanted = pattern[at];
    const given = name[of] as number;

    if (
      wanted !== undefined &&
      wanted !== STAR &&
      (wanted === given || (isAsciiLetter(wanted) && foldedOf(wanted) === foldedOf(given)))
    ) {
      at += 1;
      of += 1;
    } else if (wanted === STAR) {
      star = at;
      at += 1;
      reached = of;
    } else if (star !== -1) {
      // the last star takes one character more, and the pattern after it is tried again
      at = star + 1;
      reached += 1;
      of = reached;
    } else {
      return false;
    }
  }

  while (pattern[at] === STAR) {
    at += 1;
  }

  return at === pattern.length;
};

/** `pattern` as it matches a whole name. */
const patternOf = (pattern: string): ((name: string) => boolean) => {
  const codePoints = Array.from(pattern, (character) => {
    return character.codePointAt(0) as number;
  });

  return (name) => {
    return matchesWhole(
      codePoints,
      Array.from(name, (character) => {
        return character.codePointAt(0) as number;
      })
    );
  };
};

/** `values`, each checked to be one of `known`, as `what` names them, `names` naming them all. */
const valuesOf = <Value extends number | string>(
  values: readonly Value[],
  { known, names }: { known: readonly Value[]; names: string }
): Value[] => {
  return values.map((value) => {
    if (!known.includes(value)) {
      throw new ProgrammerError(`a debug filter takes a ${names}, not ${quotedOf(value)}`);
    }

    return value;
  });
};

/** What a selector's letter takes, named for a refusal: `direction among rx, tx`. */
const takenOf = <Value>({ named, what }: ISelected<Value>): string => {
  return `${what} among ${[...named.keys()].join(', ')}`;
};

/** The kinds `filter` keeps, each checked to be one, named for a refusal in the grammar's names. */
const kindsOf = (filter: IDebugFilter): EnvelopeKind[] => {
  const known = [...KIND_NAMES.values()];

  return (filter.kinds ?? []).map((kind) => {
    if (!known.includes(kind)) {
      throw new ProgrammerError(
        `a debug filter takes a kind among ${[...KIND_NAMES.keys()].join(', ')}, not ${quotedOf(kind)}`
      );
    }

    return kind;
  });
};

/** Whether a call's event passes `filter`: its direction, its type, its procedure's name. */
const callPredicateOf = (filter: IDebugFilter): ((event: IDebugEvent) => boolean) => {
  const directions = valuesOf(filter.directions ?? [], {
    known: DIRECTIONS,
    names: `direction among ${DIRECTIONS.join(', ')}`,
  });
  const types = valuesOf(filter.types ?? [], {
    known: TYPES,
    names: `type among ${TYPES.join(', ')}`,
  });
  const include = (filter.include ?? []).map(patternOf);
  const exclude = (filter.exclude ?? []).map(patternOf);

  return ({ direction, procedureName, type }) => {
    return (
      (directions.length === 0 || directions.includes(direction)) &&
      (types.length === 0 || types.includes(type)) &&
      (include.length === 0 ||
        include.some((matches) => {
          return matches(procedureName);
        })) &&
      !exclude.some((matches) => {
        return matches(procedureName);
      })
    );
  };
};

/** Whether an envelope's event passes `filter`: its direction and its kind; it carries no name. */
const envelopePredicateOf = (filter: IDebugFilter): ((event: IEnvelopeDebug) => boolean) => {
  const directions = valuesOf(filter.directions ?? [], {
    known: DIRECTIONS,
    names: `direction among ${DIRECTIONS.join(', ')}`,
  });
  const kinds = kindsOf(filter);

  return ({ direction, header }) => {
    return (
      (directions.length === 0 || directions.includes(direction)) &&
      (kinds.length === 0 || kinds.includes(header.kind))
    );
  };
};

/** What a filter's source gives now, as a filter, and the key it is compiled again under. */
const resolveOf = (
  given: IDebugFilter | string | undefined
): { filter: IDebugFilter; key: string } => {
  const filter = typeof given === 'string' ? parseDebugFilter(given) : (given ?? {});

  return { filter, key: JSON.stringify(filter) };
};

/**
 * Whether an event passes the filter `source` gives, as `predicateOf` compiles it: asked again at
 * each event when a function, read again only when it gives other than it gave last — another
 * string, another object — compiled again only when that reads as another filter, and left as it
 * was when that no longer holds. The first must hold, or this throws.
 */
const keeperOf = <Event>(
  source: DebugFilterSource,
  predicateOf: (filter: IDebugFilter) => (event: Event) => boolean
): ((event: Event) => boolean) => {
  let given = typeof source === 'function' ? source() : source;
  const first = resolveOf(given);
  let key = first.key;
  let predicate = predicateOf(first.filter);

  return (event) => {
    if (typeof source === 'function') {
      try {
        const next = source();

        // a burst of events asks a hundred times for the one spec it was given: none is read twice
        if (next !== given) {
          const resolved = resolveOf(next);

          if (resolved.key !== key) {
            predicate = predicateOf(resolved.filter);
            key = resolved.key;
          }

          given = next;
        }
      } catch {
        // the last filter that held stays: a filter that fails never fails the call it traces
      }
    }

    return predicate(event);
  };
};

/**
 * One selector's values, `values` as they were written within `word`'s parentheses, each read in
 * ASCII case: the first left empty, or that names none of its letter's, refuses the filter.
 */
const selectedOf = <Value>(
  values: readonly string[],
  { selected, word }: { selected: ISelected<Value>; word: string }
): Value[] => {
  return values.map((value) => {
    if (value === '') {
      throw new ProgrammerError(
        `a debug filter's selector leaves no value empty, not ${quotedOf(word)}`
      );
    }

    const named = selected.named.get(asciiLowerOf(value));

    if (named === undefined) {
      throw new ProgrammerError(
        `a debug filter takes a ${takenOf(selected)}, not ${quotedOf(value)}`
      );
    }

    return named;
  });
};

// definition

/**
 * A `debug` filter, from its spec, as `spec/debugging.md` states it (section 6): words parted by
 * commas or ASCII white space, as the `DEBUG` variable of the `debug` package has them. `d(rx)` or
 * `d(tx)` keeps a direction; `t(request)`, `t(command)` or `t(notification)` a call's type, `r`, `c`
 * and `n` its short forms; `e(request)`, `e(result)`, `e(failure)`, `e(notification)`, `e(chunk)`,
 * `e(credit)` or `e(cancel)` an envelope's kind; `d(rx|tx)`, `t(r|c)` or `e(request|failure)`
 * keeps either, and selectors of one letter add up. A selector's letter and its values are read in
 * ASCII case. `-name` leaves a procedure out, which wins, and any other word is a procedure to keep,
 * matched whole, `*` standing for any run of characters and an ASCII letter for itself in either
 * case. Each list keeps the order of its words, a value given twice kept twice. Throws a
 * {@link ProgrammerError} for the first word that does not hold, naming it, or its value, as it was
 * written: a selector empty or with a value left empty, a value that names none of its letter's, a
 * word holding a parenthesis that is no selector.
 *
 * @example
 * import { parseDebugFilter } from '@francisdesjardins/bead/service-manager';
 *
 * parseDebugFilter('d(rx), t(r|c), e(failure), get*, -getStatus');
 */
export const parseDebugFilter = (spec: string): IDebugFilter => {
  const directions: DebugDirection[] = [];
  const types: DebugType[] = [];
  const kinds: EnvelopeKind[] = [];
  const include: string[] = [];
  const exclude: string[] = [];

  for (const word of spec.split(SEPARATORS)) {
    if (word === '') {
      continue;
    }

    const letter = asciiLowerOf(word.slice(0, 1));
    const isSelector = word[1] === '(' && word.endsWith(')') && SELECTORS.has(letter);

    if (isSelector) {
      const within = word.slice(2, -1);

      if (within === '') {
        throw new ProgrammerError(`a debug filter's selector names a value, not ${quotedOf(word)}`);
      }

      const values = within.split('|');

      if (letter === 'd') {
        directions.push(...selectedOf(values, { selected: DIRECTION_NAMES, word }));
      } else if (letter === 't') {
        types.push(...selectedOf(values, { selected: TYPE_NAMES, word }));
      } else {
        kinds.push(...selectedOf(values, { selected: KIND_SELECTED, word }));
      }
    } else if (word.includes('(') || word.includes(')')) {
      throw new ProgrammerError(
        `a debug filter holds a parenthesis in a selector alone, d(…), t(…) or e(…), not ${quotedOf(word)}`
      );
    } else if (word.startsWith('-')) {
      exclude.push(word.slice(1));
    } else {
      include.push(word);
    }
  }

  return { directions, exclude, include, kinds, types };
};

/**
 * `listener`, hearing only the `debug` events of the calls its filter keeps: their direction, their
 * type, their procedure's name; an envelope's kind says nothing of a call, and is not asked. A
 * filter given as a function is asked at each event, and compiled again only when what it gives
 * changed; a function that gives none keeps every event, as an empty filter does. The filter given
 * at first must hold, or this throws a {@link ProgrammerError}; one that stops holding later — or a
 * function that throws — leaves the last that held in place, reported to no one, since a trace
 * never fails a call. A filter given whole, not as a string, is refused in the grammar's names.
 *
 * @example
 * import { createServiceManager, filterDebug } from '@francisdesjardins/bead/service-manager';
 *
 * createServiceManager(router).on(
 *   'debug',
 *   filterDebug(
 *     (error, info) => {
 *       console.log(info.direction, info.procedureName, error);
 *     },
 *     () => process.env['DEBUG_CALLS']
 *   )
 * );
 */
export const filterDebug = (
  listener: ServiceManagerOnDebugCallback,
  source: DebugFilterSource
): ServiceManagerOnDebugCallback => {
  const keeps = keeperOf(source, callPredicateOf);

  return (error, event) => {
    if (keeps(event)) {
      listener(error, event);
    }
  };
};

/**
 * `listener`, hearing only the envelopes a router's `debug` tells of that its filter keeps: their
 * direction and their kind. An envelope carries no procedure's name, and a call's type is the
 * services': names and types are not asked, so one spec serves both listeners. Given as a
 * function, and at first, the filter behaves as {@link filterDebug}'s.
 *
 * @example
 * import { createRouterClient, filterEnvelopeDebug } from '@francisdesjardins/bead/router-client';
 * import { createWSTransportClient } from '@francisdesjardins/bead/ws-transport-client';
 *
 * createRouterClient(createWSTransportClient()).on(
 *   'debug',
 *   filterEnvelopeDebug(
 *     ({ direction, header }) => {
 *       console.log(direction, header);
 *     },
 *     () => process.env['DEBUG_CALLS']
 *   )
 * );
 */
export const filterEnvelopeDebug = <Info extends IEnvelopeDebug>(
  listener: (info: Info) => void,
  source: DebugFilterSource
): ((info: Info) => void) => {
  const keeps = keeperOf(source, envelopePredicateOf);

  return (info) => {
    if (keeps(info)) {
      listener(info);
    }
  };
};
