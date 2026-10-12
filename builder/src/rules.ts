// ── Rules ─────────────────────────────────────────────────────────────────────

// Every rule of `beadc check` and of `beadc breaking`, by its name: where it applies, how severe it
// is, and for a breaking rule its category. Under `check`, a warning is left out by its name with
// `--except` and an error never is; under `breaking`, a finding of any rule it runs is waived where
// a reviewer reads it (decision 0022). What each refuses, and why, is builder/README.md's.

// constants

/** How severe a finding is: an error fails `check`; a warning fails it under `--fail-on-warning`. */
export const Severity = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
} as const);

/**
 * Where a rule applies: on a `.proto` input, or on any blueprint, one written by hand included; or
 * between two blueprints, the earlier and the current, under `beadc breaking`.
 */
export const Level = Object.freeze({
  PROTO: 'proto',
  BLUEPRINT: 'blueprint',
  BOTH: 'proto and blueprint',
  BREAKING: 'breaking',
} as const);

/**
 * What a breaking rule keeps: `WIRE`, a peer built from the earlier still talks with one built from
 * the current; `API`, besides, code written against the earlier's generated API still compiles and
 * means the same. `API` holds every `WIRE` rule.
 */
export const Category = Object.freeze({
  WIRE: 'WIRE',
  API: 'API',
} as const);

// types

export type Severity = (typeof Severity)[keyof typeof Severity];
export type Level = (typeof Level)[keyof typeof Level];
export type Category = (typeof Category)[keyof typeof Category];

/** A rule: where it applies, how severe its findings are, and a breaking rule's category. */
export interface IRule {
  readonly level: Level;
  readonly severity: Severity;
  readonly category?: Category;
}

// definition

/** Every rule beadc knows, by name. */
export const RULES = Object.freeze({
  // on a .proto
  PROCEDURE_OPTIONS: { level: Level.PROTO, severity: Severity.ERROR },
  SERVICE_SKIPPED: { level: Level.PROTO, severity: Severity.WARNING },
  STREAM_RESERVED: { level: Level.PROTO, severity: Severity.ERROR },
  ADMISSION_DEFAULT: { level: Level.PROTO, severity: Severity.ERROR },
  DEPRECATION_MESSAGE: { level: Level.PROTO, severity: Severity.ERROR },
  FAILURES_ENUM: { level: Level.PROTO, severity: Severity.ERROR },
  PAYLOAD_TYPE_FIELD: { level: Level.PROTO, severity: Severity.ERROR },
  OPTIONS_COPY: { level: Level.PROTO, severity: Severity.ERROR },
  // on both
  ADMISSION_EMPTY: { level: Level.BOTH, severity: Severity.ERROR },
  // on any blueprint, in their order: its JSON, its format, its features, its schema
  BLUEPRINT_JSON: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  FORMAT_UNKNOWN: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  FEATURE_UNKNOWN: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  BLUEPRINT_SCHEMA: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  SERVICE_ID_RANGE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  SERVICE_REVISION_RANGE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  PROCEDURE_ID_RANGE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  FAILURE_CODE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  PROCEDURE_LIMIT_RANGE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  RESERVED_RANGE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  NAME_FORM: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  // then the rules that span entries
  SERVICE_ID_UNIQUE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  PROCEDURE_ID_UNIQUE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  ID_RESERVED: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  NAME_UNIQUE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  NAME_RESERVED: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  ENCODING_FIT: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  NOTIFICATION_MESSAGE: { level: Level.BOTH, severity: Severity.ERROR },
  NOTIFICATION_RESULT: { level: Level.BLUEPRINT, severity: Severity.WARNING },
  FAILURE_UNKNOWN: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  BINDING_SOURCE: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  NAME_TARGET: { level: Level.BOTH, severity: Severity.ERROR },
  DESCRIPTION_TARGET: { level: Level.BLUEPRINT, severity: Severity.ERROR },
  SPEC_VERSION_NEWER: { level: Level.BLUEPRINT, severity: Severity.WARNING },
  // between two blueprints, by id: what a peer of the earlier meets
  SERVICE_NO_DELETE: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.WIRE },
  PROCEDURE_NO_DELETE: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.WIRE },
  FAILURE_NO_DELETE: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.WIRE },
  RESERVED_NO_DELETE: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.WIRE },
  PROCEDURE_SAME_KIND: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.WIRE },
  PROCEDURE_STILL_NOTIFIES: {
    level: Level.BREAKING,
    severity: Severity.ERROR,
    category: Category.WIRE,
  },
  PROCEDURE_SAME_ENCODING: {
    level: Level.BREAKING,
    severity: Severity.ERROR,
    category: Category.WIRE,
  },
  PROCEDURE_MESSAGE_SWITCHED: {
    level: Level.BREAKING,
    severity: Severity.ERROR,
    category: Category.WIRE,
  },
  PROCEDURE_SAME_LIMIT: {
    level: Level.BREAKING,
    severity: Severity.ERROR,
    category: Category.WIRE,
  },
  PROCEDURE_ADMISSION_TIGHTENED: {
    level: Level.BREAKING,
    severity: Severity.ERROR,
    category: Category.WIRE,
  },
  // and what code written against the earlier's generated API meets
  SERVICE_SAME_NAME: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.API },
  SERVICE_SAME_FILE: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.API },
  SERVICE_SAME_HOOKS: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.API },
  PROCEDURE_SAME_NAME: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.API },
  PROCEDURE_SAME_MESSAGES: {
    level: Level.BREAKING,
    severity: Severity.ERROR,
    category: Category.API,
  },
  PROCEDURE_SAME_HOOK: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.API },
  FAILURE_SAME_NAME: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.API },
  PROCEDURE_FAILURE_NO_DELETE: {
    level: Level.BREAKING,
    severity: Severity.ERROR,
    category: Category.API,
  },
  NAME_NO_DELETE: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.API },
  SERVICE_REVISION: { level: Level.BREAKING, severity: Severity.ERROR, category: Category.API },
  // and a comparison not run
  PROTO_SKIPPED: { level: Level.BREAKING, severity: Severity.WARNING },
} as const satisfies Readonly<Record<string, IRule>>);

/** A rule's name. */
export type RuleName = keyof typeof RULES;

/** Whether `name` is a rule beadc knows. */
export const isRuleName = (name: string): name is RuleName => {
  return Object.hasOwn(RULES, name);
};
