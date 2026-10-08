// ── Rules ─────────────────────────────────────────────────────────────────────

// Every rule of `beadc check`, by its name: where it applies and how severe it is. A warning is left
// out by its name with `--except`; an error never is (decision 0022). What each refuses, and why, is
// builder/README.md's.

// constants

/** How severe a finding is: an error fails `check`; a warning fails it under `--fail-on-warning`. */
export const Severity = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
} as const);

/** Where a rule applies: on a `.proto` input, or on any blueprint, one written by hand included. */
export const Level = Object.freeze({
  PROTO: 'proto',
  BLUEPRINT: 'blueprint',
  BOTH: 'proto and blueprint',
} as const);

// types

export type Severity = (typeof Severity)[keyof typeof Severity];
export type Level = (typeof Level)[keyof typeof Level];

/** A rule: where it applies, and how severe its findings are. */
export interface IRule {
  readonly level: Level;
  readonly severity: Severity;
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
} as const satisfies Readonly<Record<string, IRule>>);

/** A rule's name. */
export type RuleName = keyof typeof RULES;

/** Whether `name` is a rule beadc knows. */
export const isRuleName = (name: string): name is RuleName => {
  return Object.hasOwn(RULES, name);
};
