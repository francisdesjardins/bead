// ── Durations ─────────────────────────────────────────────────────────────────

// Bead's durations, read from `spec/durations.json`: what every place that takes a duration an
// application gives a side makes of every input (spec 1.4). The harness plays them at every place,
// and the clock's assertions' twins over every input, each through this helper alone; the C# side
// reads the same file.

// dependencies

import { readFileSync } from 'node:fs';

// interfaces

/** A row of the support matrix an input, a way or an outcome crosses, and the language it excuses. */
export interface IDurationDiffers {
  language: string;
  row: string;
}

/** An input, by its name, in one of five forms: milliseconds, seconds, never, NaN, or a JSON value. */
export interface IDurationInput {
  differs?: IDurationDiffers[];
  json?: boolean | string;
  milliseconds?: number;
  name: string;
  nan?: true;
  never?: true;
  seconds?: number;
}

/** A way a place's surface takes its duration, by an id stable in its place. */
export interface IDurationWay {
  differs?: IDurationDiffers[];
  id: string;
  name: string;
  /** Its duration cannot be left out. */
  required?: true;
}

/** A place's default, where a clause states one, and the ways that build it with nothing given. */
export interface IDurationDefault {
  clause: string;
  milliseconds?: number;
  never?: true;
  state?: string;
  ways: string[];
}

/** What a place makes of an input: the whole milliseconds held, at once, never, or refused. */
export interface IDurationOutcome {
  differs?: IDurationDiffers[];
  held?: number;
  input: string;
  outcome: 'at once' | 'default' | 'held' | 'never' | 'refused' | 'taken';
  reason?: string;
}

/** A place that takes a duration, keyed by its id, and its outcome for every input, in their order. */
export interface IDurationPlace {
  clauses: string[];
  default?: IDurationDefault;
  id: string;
  kind: 'delay' | 'timeout';
  name: string;
  never: 'default' | 'refused' | 'taken';
  neverClause?: string;
  observed: 'held' | 'refusal';
  outcomes: IDurationOutcome[];
  ways: IDurationWay[];
}

export interface IDurations {
  inputs: readonly IDurationInput[];
  places: readonly IDurationPlace[];
}

// types

/** How a place holds what it is given: a delay or a timeout, and what it makes of never. */
export type DurationPolicy = Pick<IDurationPlace, 'kind' | 'never'>;

// constants

/** The language this side's `differs` name. */
const LANGUAGE = 'TypeScript';

// helpers

// `value`, and all it holds, frozen
const frozen = <Value>(value: Value): Value => {
  if (typeof value === 'object' && value !== null) {
    for (const each of Object.values(value)) {
      frozen(each);
    }

    Object.freeze(value);
  }

  return value;
};

// whether a row of the matrix excuses this side
const isCrossed = (differs: IDurationDiffers[] | undefined): boolean => {
  return (differs ?? []).some(({ language }) => {
    return language === LANGUAGE;
  });
};

// definition

/** The durations, as the repository's one file holds them, frozen. */
export const DURATIONS = frozen(
  // ! the one read of the file on this side, which spec/check.py holds: every test reads it here
  JSON.parse(
    readFileSync(new URL('../../../../../../spec/durations.json', import.meta.url), 'utf8')
  ) as IDurations
);

/**
 * `input` as an application gives it on this side: milliseconds as they are, seconds times 1000 in
 * JavaScript's own arithmetic, never `Infinity`, NaN, and a JSON value as it is — a string or a
 * boolean, typed as the number an option's type says, as a limit read from JSON is.
 */
export const givenOf = (input: IDurationInput): number => {
  if (input.seconds !== undefined) {
    return input.seconds * 1000;
  }

  if (input.never === true) {
    return Infinity;
  }

  if (input.nan === true) {
    return Number.NaN;
  }

  return (input.json ?? input.milliseconds) as number;
};

/** What `place` makes of `input`. */
export const outcomeOf = (place: IDurationPlace, input: IDurationInput): IDurationOutcome => {
  const outcome = place.outcomes.find(({ input: name }) => {
    return name === input.name;
  });

  if (outcome === undefined) {
    throw new Error(`${place.id} has no outcome for ${input.name}`);
  }

  return outcome;
};

/**
 * Whether this side is excused from `input` at `place`, by `way`: a `differs` naming it on the input,
 * on the way, or on the place's outcome for the input. A way alone, or an input alone, is excused by
 * its own.
 */
export const isExcused = (
  place: IDurationPlace,
  { input, way }: { input?: IDurationInput; way?: IDurationWay }
): boolean => {
  return (
    isCrossed(way?.differs) ||
    (input !== undefined &&
      (isCrossed(input.differs) || isCrossed(outcomeOf(place, input).differs)))
  );
};

/**
 * The first place the file reads what it holds of, that holds its durations as `policy` says: its
 * outcomes are every place's that holds them so.
 */
export const placeHolding = ({ kind, never }: DurationPolicy): IDurationPlace => {
  const place = DURATIONS.places.find((each) => {
    return each.observed === 'held' && each.kind === kind && each.never === never;
  });

  if (place === undefined) {
    throw new Error(`no place holds a ${kind} whose never is ${never}`);
  }

  return place;
};

/**
 * This side's one sentence for a duration refused, from its place's `phrase`, its kind, its never and
 * the duration `given`: what it offers besides — 0 for at once at a delay, `Infinity` where never is
 * not refused — its ceiling, a timer's unless its place holds a narrower one, and the value written,
 * a string in its quotes.
 */
export const refusalOf = (
  { kind, never }: DurationPolicy,
  {
    ceiling = 2_147_483_647,
    given,
    phrase,
  }: { ceiling?: number | undefined; given: unknown; phrase: string }
): string => {
  const zero = kind === 'delay' ? '0 for at once, or ' : '';
  const infinity = never === 'refused' ? '' : ', or Infinity for never';
  const written = typeof given === 'string' ? JSON.stringify(given) : String(given);

  return `${phrase} is ${zero}a number of milliseconds from 1 to ${String(ceiling)}${infinity}, not ${written}`;
};
