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

// constants

const DIRECTIONS: readonly DebugDirection[] = Object.freeze(['rx', 'tx']);
const TYPES: readonly DebugType[] = Object.freeze(['command', 'notification', 'request']);
const KINDS: readonly EnvelopeKind[] = Object.freeze(Object.values(EnvelopeKind));

// a spec names a type by its first letter, as it names a direction by its two
const TYPE_LETTERS: ReadonlyMap<string, DebugType> = new Map([
  ['c', 'command'],
  ['n', 'notification'],
  ['r', 'request'],
]);

// a spec names a kind as its constant does, which a letter could not: a request, a result
const KIND_NAMES: ReadonlyMap<string, EnvelopeKind> = new Map(
  Object.entries(EnvelopeKind).map(([name, kind]) => {
    return [name.toLowerCase(), kind];
  })
);

// a spec's words part on commas and on white space, as `DEBUG`'s do
const SEPARATORS = /[\s,]+/;

// a selector: `d(…)` for directions, `t(…)` for types, `e(…)` for an envelope's kinds, their
// values parted by `|`
const SELECTOR = /^([dte])\((.*)\)$/i;

// what a pattern takes literally: every character a regular expression gives a meaning to
const SPECIAL = /[.*+?^${}()|[\]\\]/g;

// helpers

/** `values`, each checked to be one of `known`, as `what` names them. */
const valuesOf = <Value extends number | string>(
  values: readonly Value[],
  { known, what }: { known: readonly Value[]; what: string }
): Value[] => {
  return values.map((value) => {
    if (!known.includes(value)) {
      throw new ProgrammerError(
        `a debug filter takes a ${what} among ${known.join(', ')}, not ${JSON.stringify(value)}`
      );
    }

    return value;
  });
};

/** Each of `words`, lowered, as `named` names it; `what` says what they are, should one not be. */
const namedOf = <Value>(
  words: readonly string[],
  { named, what }: { named: ReadonlyMap<string, Value>; what: string }
): Value[] => {
  return valuesOf(
    words.map((word) => {
      return word.toLowerCase();
    }),
    { known: [...named.keys()], what }
  ).map((word) => {
    // a word checked above
    return named.get(word) as Value;
  });
};

/** `pattern` as it matches a whole name, without regard to case: `*` for any run of characters. */
const patternOf = (pattern: string): RegExp => {
  return new RegExp(`^${pattern.replace(SPECIAL, '\\$&').replaceAll('\\*', '.*')}$`, 'i');
};

/** Whether a call's event passes `filter`: its direction, its type, its procedure's name. */
const callPredicateOf = (filter: IDebugFilter): ((event: IDebugEvent) => boolean) => {
  const directions = valuesOf(filter.directions ?? [], { known: DIRECTIONS, what: 'direction' });
  const types = valuesOf(filter.types ?? [], { known: TYPES, what: 'type' });
  const include = (filter.include ?? []).map(patternOf);
  const exclude = (filter.exclude ?? []).map(patternOf);

  return ({ direction, procedureName, type }) => {
    return (
      (directions.length === 0 || directions.includes(direction)) &&
      (types.length === 0 || types.includes(type)) &&
      (include.length === 0 ||
        include.some((pattern) => {
          return pattern.test(procedureName);
        })) &&
      !exclude.some((pattern) => {
        return pattern.test(procedureName);
      })
    );
  };
};

/** Whether an envelope's event passes `filter`: its direction and its kind; it carries no name. */
const envelopePredicateOf = (filter: IDebugFilter): ((event: IEnvelopeDebug) => boolean) => {
  const directions = valuesOf(filter.directions ?? [], { known: DIRECTIONS, what: 'direction' });
  const kinds = valuesOf(filter.kinds ?? [], { known: KINDS, what: 'kind' });

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

// definition

/**
 * A `debug` filter, from its spec: words parted by commas or white space, as the `DEBUG` variable of
 * the `debug` package has them. `d(rx)` or `d(tx)` keeps a direction; `t(r)`, `t(n)` or `t(c)` a
 * call's type — a request, a notification or a command, by its first letter; `e(request)`,
 * `e(result)`, `e(failure)`, `e(notification)`, `e(chunk)`, `e(credit)` or `e(cancel)` an
 * envelope's kind, by its name;
 * `d(rx|tx)`, `t(r|c)` or `e(request|failure)` keeps either. `-name` leaves a procedure out, and
 * any other word is a procedure to keep, `*` standing for any run of characters. Throws a
 * {@link ProgrammerError} for a direction, a type letter or a kind that is not one.
 *
 * @example
 * import { parseDebugFilter } from '@francisdesjardins/bead/service-manager';
 *
 * parseDebugFilter('d(rx), t(r|c), e(failure), get*, -getStatus');
 */
export const parseDebugFilter = (spec: string): IDebugFilter => {
  const selected: Record<'d' | 'e' | 't', string[]> = { d: [], e: [], t: [] };
  const include: string[] = [];
  const exclude: string[] = [];

  for (const word of spec.split(SEPARATORS)) {
    const selector = SELECTOR.exec(word);

    if (selector !== null) {
      const [, which = '', values = ''] = selector;

      selected[which.toLowerCase() as 'd' | 'e' | 't'].push(...values.split('|'));
    } else if (word.startsWith('-')) {
      exclude.push(word.slice(1));
    } else if (word !== '') {
      include.push(word);
    }
  }

  return {
    directions: namedOf(selected.d, {
      named: new Map(
        DIRECTIONS.map((direction) => {
          return [direction, direction];
        })
      ),
      what: 'direction',
    }),
    exclude,
    include,
    kinds: namedOf(selected.e, { named: KIND_NAMES, what: 'kind' }),
    types: namedOf(selected.t, { named: TYPE_LETTERS, what: 'type' }),
  };
};

/**
 * `listener`, hearing only the `debug` events of the calls its filter keeps: their direction, their
 * type, their procedure's name; an envelope's kind says nothing of a call, and is not asked. A
 * filter given as a function is asked at each event, and compiled again only when what it gives
 * changed. The filter given at first must hold, or this throws a {@link ProgrammerError}; one that
 * stops holding later — or a function that throws — leaves the last that held in place, since a
 * trace never fails a call.
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
