// ── Diagnostics, printed ───────────────────────────────────────────────────────

// How a finding prints: one line a finding, `file:line:column: severity RULE: message` at a .proto's
// place, or at a blueprint's JSON Pointer (RFC 6901) as a URI fragment names one,
// `file#/services/0/serviceId`; in text, in JSON a line each, or as GitHub's workflow commands. A
// breaking finding at a .proto's place carries its pointer besides, which its line ends with, and a
// finding of Bead's breaking rules its subject last: what a waiver names.

// dependencies

import { relative, resolve, sep } from 'node:path';

import type { IDiagnostic } from './diagnostics.ts';

// types

/** How findings print. */
export const ErrorFormat = Object.freeze({
  TEXT: 'text',
  JSON: 'json',
  GITHUB: 'github',
} as const);

export type ErrorFormat = (typeof ErrorFormat)[keyof typeof ErrorFormat];

// constants

// a .proto's file, whose place is its line and column, a pointer besides
const PROTO_FILE = /\.proto$/u;

// definition

/** A workflow command's message, escaped as GitHub's runner reads it. */
export const escapeData = (text: string): string => {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
};

/**
 * A file as GitHub's annotation names it: from the workspace, `GITHUB_WORKSPACE`, where a workflow
 * runs, whatever folder beadc ran in; as it was given elsewhere.
 */
export const githubFileOf = (file: string): string => {
  const workspace = process.env['GITHUB_WORKSPACE'];

  return workspace === undefined || workspace === ''
    ? file
    : relative(workspace, resolve(file)).split(sep).join('/');
};

/** A workflow command's property, its `file` or its `title`, escaped as GitHub's runner reads it. */
export const escapeProperty = (text: string): string => {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
};

// whether a finding's place is its pointer, a blueprint's, rather than a .proto's line
const isAtPointer = (diagnostic: IDiagnostic): boolean => {
  return diagnostic.pointer !== undefined && !PROTO_FILE.test(diagnostic.file);
};

// a breaking finding's subject, as its line ends: what a waiver names
const subjectOf = (diagnostic: IDiagnostic): string => {
  return diagnostic.subject === undefined ? '' : ` [${diagnostic.subject}]`;
};

// where a finding is, as its text line opens
const whereOf = (diagnostic: IDiagnostic): string => {
  if (isAtPointer(diagnostic)) {
    return `${diagnostic.file}#${diagnostic.pointer ?? ''}`;
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
      const at =
        diagnostic.pointer === undefined || isAtPointer(diagnostic)
          ? ''
          : ` (at ${diagnostic.pointer})`;

      return `${whereOf(diagnostic)}: ${diagnostic.severity} ${diagnostic.rule}: ${diagnostic.message}${at}${subjectOf(diagnostic)}`;
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
        ...(diagnostic.subject === undefined ? {} : { subject: diagnostic.subject }),
      });
    }
    case ErrorFormat.GITHUB: {
      const properties = [
        `file=${escapeProperty(githubFileOf(diagnostic.file))}`,
        ...(diagnostic.line === undefined ? [] : [`line=${String(diagnostic.line)}`]),
        ...(diagnostic.column === undefined ? [] : [`col=${String(diagnostic.column)}`]),
        `title=${escapeProperty(diagnostic.rule)}`,
      ];
      const at = diagnostic.pointer === undefined ? '' : ` (at ${diagnostic.pointer})`;

      return `::${diagnostic.severity} ${properties.join(',')}::${escapeData(`${diagnostic.message}${at}${subjectOf(diagnostic)}`)}`;
    }
  }
};
