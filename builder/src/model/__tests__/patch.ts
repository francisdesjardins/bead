// ── Patch ─────────────────────────────────────────────────────────────────────

// The blueprint cases' helper: a JSON Patch (RFC 6902) of `add`, `remove` and `replace` (§4.1 to
// 4.3), applied to a parsed value, and the cases of test/blueprints/ read with their verdicts.

// dependencies

import { readdirSync, readFileSync } from 'node:fs';

// types

/** One operation of a JSON Patch. */
export interface IOperation {
  readonly op: 'add' | 'remove' | 'replace';
  readonly path: string;
  readonly value?: unknown;
}

/** A finding a case expects: its rule, at its pointer. */
export interface IVerdict {
  readonly rule: string;
  readonly pointer: string;
}

/** A case of test/blueprints/: the patch to the interop's blueprint, and the findings it gives. */
export interface IBlueprintCase {
  readonly rule: string;
  readonly name: string;
  readonly patch: readonly IOperation[];
  readonly findings: readonly IVerdict[];
}

// constants

const CASES = new URL('../../../test/blueprints/', import.meta.url);

// helpers

const tokensOf = (pointer: string): string[] => {
  return pointer
    .split('/')
    .slice(1)
    .map((token) => {
      return token.replaceAll('~1', '/').replaceAll('~0', '~');
    });
};

// definition

/** `value` with `patch` applied, as RFC 6902 applies it: each operation in turn, on a copy. */
export const applyPatch = (value: unknown, patch: readonly IOperation[]): unknown => {
  const document = structuredClone(value);

  for (const operation of patch) {
    const tokens = tokensOf(operation.path);
    const last = tokens.pop();
    let holder: unknown = document;

    for (const token of tokens) {
      holder = (holder as Record<string, unknown>)[token];
    }

    if (last === undefined || typeof holder !== 'object' || holder === null) {
      throw new Error(`${operation.path}: no place to ${operation.op}`);
    }

    if (Array.isArray(holder)) {
      const index = last === '-' ? holder.length : Number(last);

      if (operation.op === 'add') {
        holder.splice(index, 0, operation.value);
      } else {
        holder.splice(index, 1, ...(operation.op === 'replace' ? [operation.value] : []));
      }
    } else if (operation.op === 'remove') {
      Reflect.deleteProperty(holder, last);
    } else {
      (holder as Record<string, unknown>)[last] = operation.value;
    }
  }

  return document;
};

/** Every case of test/blueprints/, by its rule's folder and its file's name. */
export const blueprintCases = (): IBlueprintCase[] => {
  return readdirSync(CASES).flatMap((rule) => {
    return readdirSync(new URL(`${rule}/`, CASES)).map((file) => {
      const read = JSON.parse(readFileSync(new URL(`${rule}/${file}`, CASES), 'utf8')) as {
        patch: IOperation[];
        findings: IVerdict[];
      };

      return {
        rule,
        name: file.replace(/\.json$/u, ''),
        patch: read.patch,
        findings: read.findings,
      };
    });
  });
};
