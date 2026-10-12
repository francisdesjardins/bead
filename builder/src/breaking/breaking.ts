// ── Breaking ──────────────────────────────────────────────────────────────────

// `beadc breaking` over one input against the earlier `--against` names: the current checked whole
// first, as `generate` checks it, an error ending the run with `check`'s findings; then the earlier
// read; then Bead's rules over the two blueprints, and buf's over the two images where both sides
// compiled, `PROTO_SKIPPED` where a side's `.proto` goes uncompared; then the waivers (decision
// 0022). A waiver names a rule, scoped or not to a pointer into the current blueprint, or buf's rule,
// scoped or not to a path; a scope the current does not resolve is refused, so a mistyped one never
// waives nothing in silence.

// dependencies

import { checkBlueprintFile, checkRoots, type IChecked } from '../check.ts';
import type { IAgainstConfig, Source } from '../config.ts';
import { diagnosticOf, hasError, type IDiagnostic, InputError } from '../diagnostics.ts';
import type { IBlueprint } from '../model/blueprint.ts';
import { displayOf, pathOnDisk } from '../roots.ts';
import {
  Category,
  type IRule,
  isRuleName,
  Level,
  RULES,
  type RuleName,
  Severity,
} from '../rules.ts';
import { againstOf, type IEarlier } from './against.ts';
import { BUF_EXCEPTED, BUF_RULES, bufFindings, type IBufWaivers } from './buf.ts';
import { compareBlueprints, messageIndexOf } from './compare.ts';

// types

/** What `beadc breaking` runs with. */
export interface IBreakingOptions {
  /** What `--against` names: a folder, `-` or a blueprint's file. */
  readonly against: string;
  readonly category: Category;
  /** Each `--except`, as the call gave it. */
  readonly except?: readonly string[];
  /** The current `beadc.yaml`, when the call read one. */
  readonly config?: IAgainstConfig;
  /** The tar `--against -` read from standard input. */
  readonly archive?: Uint8Array;
}

/** The waivers of a call, parsed: Bead's rules, whole or at pointers, and buf's. */
export interface IWaivers {
  /** A rule waived wherever it finds, by name. */
  readonly rules: ReadonlySet<string>;
  /** A rule waived at a pointer and under it. */
  readonly scoped: readonly { readonly rule: RuleName; readonly pointer: string }[];
  readonly buf: IBufWaivers;
}

/** What a breaking run gives: its findings, and whether it compared the two sides. */
export interface IBreaking {
  readonly diagnostics: readonly IDiagnostic[];
  readonly compared: boolean;
}

// constants

const BUF_PREFIX = 'buf:';
const SCOPE = '@';

// helpers

const ruleOf = (name: RuleName): IRule => {
  return RULES[name];
};

// whether a rule runs under `category`: a breaking rule of its category, PROTO_SKIPPED, or one of
// check's warnings
const runs = (name: RuleName, category: Category): boolean => {
  const rule = ruleOf(name);

  if (rule.level !== Level.BREAKING) {
    return rule.severity === Severity.WARNING;
  }

  return (
    rule.category === undefined || category === Category.API || rule.category === Category.WIRE
  );
};

const bindsProto = (blueprint: IBlueprint): boolean => {
  return blueprint.services.some((service) => {
    return service.procedures.some((procedure) => {
      return [procedure.request, procedure.result, procedure.notification].some((binding) => {
        return binding?.encoding === 'proto';
      });
    });
  });
};

// whether `pointer` names a place `value` holds
const resolves = (value: unknown, pointer: string): boolean => {
  let at = value;

  for (const token of pointer.split('/').slice(1)) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');

    if (Array.isArray(at) && /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < at.length) {
      at = at[Number(key)];
    } else if (
      typeof at === 'object' &&
      at !== null &&
      !Array.isArray(at) &&
      Object.hasOwn(at, key)
    ) {
      at = (at as Record<string, unknown>)[key];
    } else {
      return false;
    }
  }

  return true;
};

const isUnder = (pointer: string, scope: string): boolean => {
  return pointer === scope || pointer.startsWith(`${scope}/`);
};

// definition

/**
 * Parses each `--except` of a `breaking` call under `category`: `<RULE>`, a rule it runs or one of
 * check's warnings; `<RULE>@<pointer>`, a breaking rule at an RFC 6901 pointer; `buf:<RULE>` and
 * `buf:<RULE>@<path>`, a rule buf knows and does not run excepted already. Throws an
 * {@link InputError} for any other.
 */
export const waiversOf = (
  except: readonly string[],
  options: { readonly category: Category }
): IWaivers => {
  const rules = new Set<string>();
  const scoped: { rule: RuleName; pointer: string }[] = [];
  const bufExcept: string[] = [];
  const ignoreOnly: Record<string, string[]> = {};

  for (const given of except) {
    const scopeAt = given.indexOf(SCOPE);
    const name = scopeAt === -1 ? given : given.slice(0, scopeAt);
    const scope = scopeAt === -1 ? undefined : given.slice(scopeAt + 1);

    if (name.startsWith(BUF_PREFIX)) {
      const rule = name.slice(BUF_PREFIX.length);

      if (!BUF_RULES.has(rule)) {
        throw new InputError(`--except ${given}: no breaking rule buf knows`);
      }

      if (BUF_EXCEPTED.includes(rule)) {
        throw new InputError(
          `--except ${given}: a rule beadc excepts always, since buf keys it by a name Bead keys by id`
        );
      }

      if (scope === undefined) {
        bufExcept.push(rule);
      } else if (scope === '') {
        throw new InputError(`--except ${given}: a scope names a .proto file or folder`);
      } else {
        (ignoreOnly[rule] ??= []).push(scope);
      }
      continue;
    }

    if (!isRuleName(name)) {
      throw new InputError(`--except ${given}: no rule beadc knows`);
    }

    if (!runs(name, options.category)) {
      throw new InputError(
        ruleOf(name).level === Level.BREAKING
          ? `--except ${given}: an API rule, which --category ${options.category} does not run`
          : `--except ${given}: an error, which --except never leaves out`
      );
    }

    if (scope === undefined) {
      rules.add(name);
    } else if (ruleOf(name).category === undefined || !(scope === '' || scope.startsWith('/'))) {
      throw new InputError(
        `--except ${given}: a scope is a breaking rule's, an RFC 6901 pointer into the current blueprint`
      );
    } else {
      scoped.push({ rule: name, pointer: scope });
    }
  }

  return { rules, scoped, buf: { except: bufExcept, ignoreOnly } };
};

/**
 * Runs `beadc breaking` over `source` against `options.against`, giving its findings with the
 * waivers applied. Throws an {@link InputError} for a waiver, an earlier or a scope beadc cannot
 * take.
 */
export const breaking = (source: Source, options: IBreakingOptions): IBreaking => {
  const { category } = options;
  const waivers = waiversOf(options.except ?? [], { category });
  const waived = (diagnostic: IDiagnostic): boolean => {
    return (
      waivers.rules.has(diagnostic.rule) ||
      waivers.scoped.some((scoped) => {
        return (
          scoped.rule === diagnostic.rule &&
          diagnostic.pointer !== undefined &&
          isUnder(diagnostic.pointer, scoped.pointer)
        );
      })
    );
  };
  const fromProto = 'proto' in source;
  const checked: IChecked = fromProto
    ? checkRoots(source.proto, { image: true })
    : checkBlueprintFile(source.blueprint, { file: displayOf(source.blueprint) });
  const kept = (diagnostics: readonly IDiagnostic[]): IDiagnostic[] => {
    return diagnostics.filter((diagnostic) => {
      return !waived(diagnostic);
    });
  };

  // * the current input checked first: an error is check's, and nothing is compared
  if (
    hasError(checked.diagnostics) ||
    checked.blueprint === undefined ||
    checked.placeOf === undefined
  ) {
    return { diagnostics: kept(checked.diagnostics), compared: false };
  }

  const current = checked.blueprint;
  const placeOf = checked.placeOf;

  for (const scoped of waivers.scoped) {
    if (!resolves(current, scoped.pointer)) {
      throw new InputError(
        `--except ${scoped.rule}${SCOPE}${scoped.pointer}: the current blueprint holds nothing at ${scoped.pointer}`
      );
    }
  }

  const roots = 'proto' in source ? source.proto : [];

  for (const [rule, paths] of Object.entries(waivers.buf.ignoreOnly)) {
    for (const path of paths) {
      if (roots.length > 0 && pathOnDisk(path, roots) === undefined) {
        throw new InputError(
          `--except ${BUF_PREFIX}${rule}${SCOPE}${path}: no .proto file or folder of the current roots`
        );
      }
    }
  }

  const earlier: IEarlier = againstOf(options.against, {
    current: source,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.archive === undefined ? {} : { archive: options.archive }),
  });
  const image = fromProto ? checked.set : undefined;
  const bead = compareBlueprints(current, {
    earlier: earlier.blueprint,
    category,
    placeOf,
    ...(image === undefined || earlier.image === undefined
      ? {}
      : { messages: { earlier: messageIndexOf(earlier.image), current: messageIndexOf(image) } }),
  });
  const currentFile = placeOf('').file;
  let buf: IDiagnostic[] = [];
  let skipped: IDiagnostic[] = [];

  if (image !== undefined && earlier.image !== undefined) {
    buf = bufFindings(image, {
      earlier: earlier.image,
      category,
      roots,
      waivers: waivers.buf,
    });
  } else if (
    fromProto ||
    earlier.fromProto ||
    bindsProto(current) ||
    bindsProto(earlier.blueprint)
  ) {
    const why =
      earlier.skipped === undefined
        ? fromProto
          ? `the earlier, ${earlier.file}, is a blueprint alone: name its release's folder, or pipe its git archive to --against -`
          : `the current input is a blueprint alone, which gives buf no .proto`
        : `the earlier's .proto, ${earlier.file}, is one this beadc does not compile: ${earlier.skipped}`;

    skipped = [
      diagnosticOf('PROTO_SKIPPED', {
        message: `buf's comparison of the .proto was not run: ${why}`,
        place: { file: currentFile === '' ? earlier.file : currentFile },
      }),
    ];
  }

  return {
    diagnostics: kept([...checked.diagnostics, ...bead, ...buf, ...skipped]),
    compared: true,
  };
};
