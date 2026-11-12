// ── Diagnostics ───────────────────────────────────────────────────────────────

// A finding of beadc's: its rule, its severity, its message, and its place, a .proto's line and
// column or a blueprint's JSON Pointer (RFC 6901); a breaking finding's subject, its entity by ids,
// what a waiver names. A finding of buf's breaking rules is named `buf:` and buf's rule. How a
// finding prints is `format-diagnostic.ts`'s, the command line's: this module touches no platform,
// so a page reads `beadc.yaml` with it.

// dependencies

import { RULES, type RuleName, Severity } from './rules.ts';

// types

/** A rule of buf's breaking rules, as a finding names it: `buf:FIELD_SAME_TYPE`. */
export type BufRuleName = `buf:${string}`;

/** A finding: its rule, its severity, its place, and what it says. */
export interface IDiagnostic {
  readonly rule: RuleName | BufRuleName;
  readonly severity: Severity;
  readonly message: string;
  /** The file it is about, as the command line or `beadc.yaml` named it. */
  readonly file: string;
  /** Its line and column, from 1: a .proto's, as buf's source info gives them, or a text's. */
  readonly line?: number;
  readonly column?: number;
  /** Its place in a blueprint, an RFC 6901 JSON Pointer; `""` is the whole. */
  readonly pointer?: string;
  /**
   * What a breaking finding is about, by ids no shift moves: AIP-122's hierarchy of kinds and ids,
   * each step `kind:id`, as `service:1/procedure:4`. What `--except <RULE>@<subject>` names.
   */
  readonly subject?: string;
}

/** Where a finding is: a file, and its line and column or its pointer. */
export interface IPlace {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly pointer?: string;
}

// definition

/**
 * An input or a call beadc cannot take — a `.proto` buf does not compile, a text that is no JSON, a
 * bad flag, a bad `beadc.yaml`, a path outside its folder — which exits 2, its message printed as
 * it is.
 */
export class InputError extends Error {
  override readonly name = 'InputError';
}

/** A finding of `rule`, at `place`, its severity the rule's. */
export const diagnosticOf = (
  rule: RuleName,
  details: { readonly message: string; readonly place: IPlace }
): IDiagnostic => {
  return { rule, severity: RULES[rule].severity, message: details.message, ...details.place };
};

/** A finding of buf's breaking rule `type`, at `place`: an error, its message buf's. */
export const bufDiagnosticOf = (
  type: string,
  details: { readonly message: string; readonly place: IPlace }
): IDiagnostic => {
  return {
    rule: `buf:${type}`,
    severity: Severity.ERROR,
    message: details.message,
    ...details.place,
  };
};

/** One reference token of a JSON Pointer, `~` and `/` escaped (RFC 6901 §3). */
export const tokenOf = (key: string | number): string => {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
};

/** A JSON Pointer from its keys, each escaped. */
export const pointerOf = (keys: readonly (string | number)[]): string => {
  return keys
    .map((key) => {
      return `/${tokenOf(key)}`;
    })
    .join('');
};

/** Whether any of `diagnostics` is an error. */
export const hasError = (diagnostics: readonly IDiagnostic[]): boolean => {
  return diagnostics.some((diagnostic) => {
    return diagnostic.severity === Severity.ERROR;
  });
};
