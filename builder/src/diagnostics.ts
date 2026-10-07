// ── Diagnostics ───────────────────────────────────────────────────────────────

// A finding of beadc's, and how it prints: one line a finding, `file:line:column: severity RULE:
// message` at a .proto's place, or at a blueprint's JSON Pointer (RFC 6901) as a URI fragment names
// one, `file#/services/0/serviceId`; in text, in JSON a line each, or as GitHub's workflow commands.

// dependencies

import { RULES, type RuleName, Severity } from './rules.ts';

// types

/** A finding: its rule, its severity, its place, and what it says. */
export interface IDiagnostic {
  readonly rule: RuleName;
  readonly severity: Severity;
  readonly message: string;
  /** The file it is about, as the command line or `beadc.yaml` named it. */
  readonly file: string;
  /** Its line and column, from 1: a .proto's, as buf's source info gives them, or a text's. */
  readonly line?: number;
  readonly column?: number;
  /** Its place in a blueprint, an RFC 6901 JSON Pointer; `""` is the whole. */
  readonly pointer?: string;
}

/** Where a finding is: a file, and its line and column or its pointer. */
export interface IPlace {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly pointer?: string;
}

/** How findings print. */
export const ErrorFormat = Object.freeze({
  TEXT: 'text',
  JSON: 'json',
  GITHUB: 'github',
} as const);

export type ErrorFormat = (typeof ErrorFormat)[keyof typeof ErrorFormat];

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

// a property or a message of a workflow command, escaped as the runner reads them
const escapeData = (text: string): string => {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
};

const escapeProperty = (text: string): string => {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
};

// where a finding is, as its text line opens
const whereOf = (diagnostic: IDiagnostic): string => {
  if (diagnostic.pointer !== undefined) {
    return `${diagnostic.file}#${diagnostic.pointer}`;
  }

  if (diagnostic.line === undefined) {
    return diagnostic.file;
  }

  return `${diagnostic.file}:${String(diagnostic.line)}:${String(diagnostic.column ?? 1)}`;
};

/** One finding as one line in `format`. */
export const formatDiagnostic = (diagnostic: IDiagnostic, format: ErrorFormat): string => {
  switch (format) {
    case ErrorFormat.TEXT: {
      return `${whereOf(diagnostic)}: ${diagnostic.severity} ${diagnostic.rule}: ${diagnostic.message}`;
    }
    case ErrorFormat.JSON: {
      return JSON.stringify({
        file: diagnostic.file,
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
        ...(diagnostic.pointer === undefined ? {} : { pointer: diagnostic.pointer }),
        severity: diagnostic.severity,
        rule: diagnostic.rule,
        message: diagnostic.message,
      });
    }
    case ErrorFormat.GITHUB: {
      const properties = [
        `file=${escapeProperty(diagnostic.file)}`,
        ...(diagnostic.line === undefined ? [] : [`line=${String(diagnostic.line)}`]),
        ...(diagnostic.column === undefined ? [] : [`col=${String(diagnostic.column)}`]),
        `title=${escapeProperty(diagnostic.rule)}`,
      ];
      const at = diagnostic.pointer === undefined ? '' : ` (at ${diagnostic.pointer})`;

      return `::${diagnostic.severity} ${properties.join(',')}::${escapeData(`${diagnostic.message}${at}`)}`;
    }
  }
};

/** Whether any of `diagnostics` is an error. */
export const hasError = (diagnostics: readonly IDiagnostic[]): boolean => {
  return diagnostics.some((diagnostic) => {
    return diagnostic.severity === Severity.ERROR;
  });
};
