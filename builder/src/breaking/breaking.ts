// ── Breaking ──────────────────────────────────────────────────────────────────

// `beadc breaking` over one input against the earlier `--against` names: the current checked whole
// first, as `generate` checks it, an error ending the run with `check`'s findings; then the earlier
// read; then Bead's rules over the two blueprints, and buf's over the two images where both sides
// compiled, `PROTO_SKIPPED` where a side's `.proto` goes uncompared; then the waivers (decision
// 0022). A waiver names a rule scoped to a subject, an entity by its ids as a finding's line prints
// it, which no shift moves, or buf's rule scoped to a file or a folder; bare, only a rule that finds
// no subject, since a bare waiver of one that does would waive a later change's finding too, in the
// CI that keeps it. A scope off its form, a pointer among them, is refused. A waiver that waived nothing is WAIVER_UNUSED's
// warning, as a linter says of a suppression no finding used: a mistyped subject, or a change a
// release has taken, is said, never kept in silence.

// dependencies

import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

import { checkBlueprintFile, checkRoots, type IChecked } from '../check.ts';
import { asksHttp, type IAgainstConfig, type IConfig, type Source } from '../config.ts';
import { diagnosticOf, hasError, type IDiagnostic, InputError } from '../diagnostics.ts';
import type { IBlueprint, IServiceEntry } from '../model/blueprint.ts';
import { areOneName } from '../model/identity.ts';
import { DEFAULT_PREFIX } from '../model/routes.ts';
import { displayOf, pathOnDisk } from '../roots.ts';
import {
  Category,
  HTTP_CATEGORY,
  type IRule,
  isRuleName,
  Level,
  RULES,
  type RuleName,
  Severity,
} from '../rules.ts';
import { againstOf, type IEarlier } from './against.ts';
import {
  BUF_CATEGORY,
  BUF_EXCEPTED,
  BUF_RULES,
  BUF_RULES_RUN,
  bufFindings,
  type IBufFinding,
  isUnderScope,
} from './buf.ts';
import { compareBlueprints, hooksOf, messageIndexOf } from './compare.ts';
import { holdsHttp } from './http.ts';

// types

/** What `beadc breaking` runs with. */
export interface IBreakingOptions {
  /** What `--against` names: a folder, `-` or a blueprint's file. */
  readonly against: string;
  readonly category: Category;
  /** Each `--except`, as the call gave it. */
  readonly except?: readonly string[];
  /** The current `beadc.yaml`, when the call read one. */
  readonly config?: IAgainstConfig | IConfig;
  /** The tar `--against -` read from standard input. */
  readonly archive?: Uint8Array;
}

/** A waiver of a call, parsed: a rule wherever it finds, or at one subject, or buf's at a path. */
export interface IWaiver {
  /** The `--except`, as the call gave it. */
  readonly given: string;
  /** The rule it waives: Bead's by its name, buf's as its findings name it, `buf:` first. */
  readonly rule: string;
  /** For Bead's rule, the one subject it waives. */
  readonly subject?: string;
  /** For buf's rule, the file or the folder it waives under, by its import path. */
  readonly path?: string;
}

/** What a breaking run gives: its findings, and whether it compared the two sides. */
export interface IBreaking {
  readonly diagnostics: readonly IDiagnostic[];
  readonly compared: boolean;
}

// a shape of subject: how its line writes it, and the parts it holds
interface IShape {
  readonly form: string;
  readonly pattern: RegExp;
}

// constants

const BUF_PREFIX = 'buf:';
const SCOPE = '@';

// a subject's parts: an id, a run of ids, a procedure's or a hook's name, a service's name
const ID = '([1-9][0-9]{0,4})';
const LOWER = '([a-z][A-Za-z0-9]{0,62})';
const UPPER = '([A-Z][A-Za-z0-9]{0,62})';

/**
 * The shapes of a subject, AIP-122's hierarchy of kinds and ids written `kind:id`, by the entity
 * each names (decision 0022).
 */
const SHAPES = Object.freeze({
  service: { form: 'service:<id>', pattern: new RegExp(`^service:${ID}$`, 'u') },
  procedure: {
    form: 'service:<id>/procedure:<id>',
    pattern: new RegExp(`^service:${ID}/procedure:${ID}$`, 'u'),
  },
  failure: {
    form: 'service:<id>/failure:<code>',
    pattern: new RegExp(`^service:${ID}/failure:${ID}$`, 'u'),
  },
  listed: {
    form: 'service:<id>/procedure:<id>/failure:<code>',
    pattern: new RegExp(`^service:${ID}/procedure:${ID}/failure:${ID}$`, 'u'),
  },
  hook: {
    form: 'service:<id>/hook:<name>',
    pattern: new RegExp(`^service:${ID}/hook:${LOWER}$`, 'u'),
  },
  procedureIds: {
    form: 'service:<id>/procedure:<first>[-<last>]',
    pattern: new RegExp(`^service:${ID}/procedure:${ID}(?:-${ID})?$`, 'u'),
  },
  failureCodes: {
    form: 'service:<id>/failure:<first>[-<last>]',
    pattern: new RegExp(`^service:${ID}/failure:${ID}(?:-${ID})?$`, 'u'),
  },
  serviceIds: {
    form: 'service:<first>[-<last>]',
    pattern: new RegExp(`^service:${ID}(?:-${ID})?$`, 'u'),
  },
  procedureName: {
    form: 'service:<id>/name:<name>',
    pattern: new RegExp(`^service:${ID}/name:${LOWER}$`, 'u'),
  },
  serviceName: { form: 'name:<Name>', pattern: new RegExp(`^name:${UPPER}$`, 'u') },
} as const satisfies Readonly<Record<string, IShape>>);

type Shape = keyof typeof SHAPES;

// the shapes that name a run of ids, as a reservation declared it
const RUNS: ReadonlySet<Shape> = new Set(['procedureIds', 'failureCodes', 'serviceIds']);

// the largest id or code, spec 16.2 and 9.5's
const LARGEST_ID = 65_535;

/** The subjects each of Bead's breaking rules finds, by shape: what a scope of it may name. */
const SHAPES_OF_RULE: Readonly<Partial<Record<RuleName, readonly Shape[]>>> = Object.freeze({
  SERVICE_NO_DELETE: ['service'],
  SERVICE_SAME_NAME: ['service'],
  SERVICE_SAME_FILE: ['service'],
  SERVICE_REVISION: ['service'],
  SERVICE_SAME_HOOKS: ['hook'],
  PROCEDURE_NO_DELETE: ['procedure'],
  PROCEDURE_SAME_NAME: ['procedure'],
  PROCEDURE_SAME_KIND: ['procedure'],
  PROCEDURE_STILL_NOTIFIES: ['procedure'],
  PROCEDURE_SAME_ENCODING: ['procedure'],
  PROCEDURE_MESSAGE_SWITCHED: ['procedure'],
  PROCEDURE_SAME_LIMIT: ['procedure'],
  PROCEDURE_ADMISSION_TIGHTENED: ['procedure'],
  PROCEDURE_RULES_TIGHTENED: ['procedure'],
  PROCEDURE_SAME_MESSAGES: ['procedure'],
  PROCEDURE_SAME_HOOK: ['procedure'],
  PROCEDURE_FAILURE_NO_DELETE: ['listed'],
  HTTP_ROUTE_NO_DELETE: ['procedure'],
  HTTP_GET_NO_DELETE: ['procedure'],
  HTTP_ROUTE_SHADOWED: ['procedure'],
  FAILURE_NO_DELETE: ['failure'],
  FAILURE_SAME_NAME: ['failure'],
  NAME_NO_DELETE: ['service', 'procedure', 'failure'],
  RESERVED_NO_DELETE: [
    'procedureIds',
    'failureCodes',
    'serviceIds',
    'procedureName',
    'serviceName',
  ],
});

// helpers

const ruleOf = (name: RuleName): IRule => {
  return RULES[name];
};

// whether a rule runs under `category`: a breaking rule of its category, one the run gives itself,
// or one of check's warnings
const runs = (name: RuleName, category: Category): boolean => {
  const rule = ruleOf(name);

  if (rule.level !== Level.BREAKING) {
    return rule.severity === Severity.WARNING;
  }

  return (
    rule.category === undefined ||
    category === Category.API ||
    rule.category === Category.WIRE ||
    rule.category === HTTP_CATEGORY
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

// the shapes `subject` takes, none when it is off the grammar: each id from 1 to 65535, a run's
// first at most its last
const shapesOf = (subject: string): Shape[] => {
  return (Object.keys(SHAPES) as Shape[]).filter((shape) => {
    const parts = SHAPES[shape].pattern.exec(subject);

    if (parts === null) {
      return false;
    }

    // ! a group no run matched is undefined, whatever the array's type says
    const groups: readonly (string | undefined)[] = parts.slice(1);
    const ids = groups
      .filter((part) => {
        return part !== undefined && /^[0-9]+$/u.test(part);
      })
      .map(Number);
    // a run's ends, its last two parts: after its service's id but for the services' own
    const [first, last] = RUNS.has(shape) ? groups.slice(shape === 'serviceIds' ? 0 : 1) : [];

    return (
      ids.every((id) => {
        return id <= LARGEST_ID;
      }) &&
      (first === undefined || last === undefined || Number(first) <= Number(last))
    );
  });
};

// whether `blueprint` holds the entity `subject` names, by its id or its name, or reserves its id or
// its name: what a waiver keyed to it could have waived
const holds = (blueprint: IBlueprint, subject: string): boolean => {
  const serviceOf = (id: string | undefined): IServiceEntry | undefined => {
    return blueprint.services.find((service) => {
      return String(service.serviceId) === id;
    });
  };
  const inRanges = (ranges: readonly { first: number; last: number }[], id: string): boolean => {
    return ranges.some((range) => {
      return Number(id) >= range.first && Number(id) <= range.last;
    });
  };

  return shapesOf(subject).some((shape) => {
    const [, one = '', two = '', three = ''] = SHAPES[shape].pattern.exec(subject) ?? [];
    const service = serviceOf(one);

    switch (shape) {
      case 'service':
      case 'serviceIds': {
        return service !== undefined || inRanges(blueprint.reservedServices.ids, one);
      }
      case 'procedure':
      case 'procedureIds':
      case 'listed': {
        return (
          service !== undefined &&
          (service.procedures.some((procedure) => {
            return String(procedure.procedureId) === two;
          }) ||
            inRanges(service.reserved.procedureIds, two)) &&
          (shape !== 'listed' ||
            service.failures.some((failure) => {
              return String(failure.code) === three;
            }))
        );
      }
      case 'failure':
      case 'failureCodes': {
        return (
          service !== undefined &&
          (service.failures.some((failure) => {
            return String(failure.code) === two;
          }) ||
            inRanges(service.reserved.failureCodes, two))
        );
      }
      case 'hook': {
        return service !== undefined && hooksOf(service).includes(two);
      }
      case 'procedureName': {
        return (
          service !== undefined &&
          [
            ...service.procedures.map((procedure) => {
              return procedure.procedureName;
            }),
            ...service.reserved.procedureNames,
          ].some((name) => {
            return areOneName(name, two);
          })
        );
      }
      case 'serviceName': {
        return [
          ...blueprint.services.map((each) => {
            return each.serviceName;
          }),
          ...blueprint.reservedServices.names,
        ].some((name) => {
          return areOneName(name, one);
        });
      }
    }
  });
};

// whether `waiver` waives `finding`: its rule, at its subject or under its path when it names one
const waives = (waiver: IWaiver, finding: IBufFinding): boolean => {
  const { diagnostic, path } = finding;

  if (waiver.rule !== diagnostic.rule) {
    return false;
  }

  if (waiver.subject !== undefined) {
    return diagnostic.subject === waiver.subject;
  }

  if (waiver.path !== undefined) {
    return path !== undefined && isUnderScope(path, waiver.path);
  }

  return true;
};

// definition

/**
 * Parses each `--except` of a `breaking` call under `category`: `<RULE>`, a rule it runs that finds
 * no subject or one of check's warnings; `<RULE>@<subject>`, a breaking rule at one subject of its
 * kind; `buf:<RULE>@<path>`, a rule buf's category runs and beadc does not except already. Throws an
 * {@link InputError} for any other, a bare waiver of a rule that finds subjects or of buf's among
 * them, which would waive a later change's finding too, and for WAIVER_UNUSED, which nothing waives.
 */
export const waiversOf = (
  except: readonly string[],
  options: { readonly category: Category }
): IWaiver[] => {
  const { category } = options;

  return except.map((given) => {
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

      if (!BUF_RULES_RUN[category].has(rule)) {
        throw new InputError(
          `--except ${given}: a rule buf's ${BUF_CATEGORY[category]} does not run, which --category ${category} takes`
        );
      }

      // ! bare, it would waive every finding of the rule, a later change's too, in a CI that keeps
      // it: buf's ignore_only names its paths alike
      if (scope === undefined) {
        throw new InputError(
          `--except ${given}: waives every finding of ${rule}, a later change's too: name a .proto file or folder, buf:${rule}@<path>`
        );
      }

      if (scope === '') {
        throw new InputError(`--except ${given}: a scope names a .proto file or folder`);
      }

      return { given, rule: name, path: scope };
    }

    if (!isRuleName(name)) {
      throw new InputError(`--except ${given}: no rule beadc knows`);
    }

    if (name === 'WAIVER_UNUSED') {
      throw new InputError(
        `--except ${given}: a waiver that waived nothing is taken out, never waived`
      );
    }

    if (!runs(name, category)) {
      throw new InputError(
        ruleOf(name).level === Level.BREAKING
          ? `--except ${given}: an API rule, which --category ${category} does not run`
          : `--except ${given}: an error, which --except never leaves out`
      );
    }

    // * a scope is a subject, of the rule's own kind: a pointer is a place, which a shift moves
    const shapes = SHAPES_OF_RULE[name];

    if (scope === undefined) {
      // ! a rule that finds subjects, waived bare, would waive a later change's finding too
      if (shapes !== undefined) {
        throw new InputError(
          `--except ${given}: waives every finding of ${name}, a later change's too: name its subject, ${shapes
            .map((shape) => {
              return `${name}@${SHAPES[shape].form}`;
            })
            .join(' or ')}`
        );
      }

      return { given, rule: name };
    }

    if (shapes === undefined) {
      throw new InputError(
        `--except ${given}: ${name} finds no subject, and is waived by its name`
      );
    }

    if (scope === '' || scope.startsWith('/')) {
      throw new InputError(
        `--except ${given}: a scope names a finding's subject, as its line prints it, such as service:1/procedure:4; a pointer shifts`
      );
    }

    const taken = shapesOf(scope);

    if (taken.length === 0) {
      throw new InputError(
        `--except ${given}: no subject, which names an entity by its kinds and ids, such as service:1/procedure:4`
      );
    }

    if (
      !taken.some((shape) => {
        return shapes.includes(shape);
      })
    ) {
      throw new InputError(
        `--except ${given}: a scope names one entity of the rule's kind, ${shapes
          .map((shape) => {
            return SHAPES[shape].form;
          })
          .join(' or ')}`
      );
    }

    return { given, rule: name, subject: scope };
  });
};

/**
 * Runs `beadc breaking` over `source` against `options.against`, giving its findings with the
 * waivers applied, and WAIVER_UNUSED's for each waiver that waived none. Throws an
 * {@link InputError} for a waiver, an earlier or a scope beadc cannot take.
 */
export const breaking = (source: Source, options: IBreakingOptions): IBreaking => {
  const { category } = options;
  const waivers = waiversOf(options.except ?? [], { category });
  const used = new Set<IWaiver>();
  // every waiver that waives `finding`, each marked used
  const waived = (finding: IBufFinding): boolean => {
    const by = waivers.filter((waiver) => {
      return waives(waiver, finding);
    });

    for (const waiver of by) {
      used.add(waiver);
    }

    return by.length > 0;
  };
  const kept = (findings: readonly IBufFinding[]): IDiagnostic[] => {
    return findings
      .filter((finding) => {
        return !waived(finding);
      })
      .map((finding) => {
        return finding.diagnostic;
      });
  };
  const of = (diagnostics: readonly IDiagnostic[]): IBufFinding[] => {
    return diagnostics.map((diagnostic) => {
      return { diagnostic };
    });
  };
  const fromProto = 'proto' in source;
  const checked: IChecked = fromProto
    ? checkRoots(source.proto, {
        image: true,
        ...(options.config === undefined ? {} : { folder: options.config.folder }),
      })
    : checkBlueprintFile(source.blueprint, { file: displayOf(source.blueprint) });

  // * the current input checked first: an error is check's, and nothing is compared
  if (
    hasError(checked.diagnostics) ||
    checked.blueprint === undefined ||
    checked.placeOf === undefined
  ) {
    return { diagnostics: kept(of(checked.diagnostics)), compared: false };
  }

  const current = checked.blueprint;
  const placeOf = checked.placeOf;
  const roots = 'proto' in source ? source.proto : [];
  const earlier: IEarlier = againstOf(options.against, {
    current: source,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.archive === undefined ? {} : { archive: options.archive }),
  });
  const earlierFiles =
    earlier.image === undefined
      ? []
      : fromBinary(FileDescriptorSetSchema, earlier.image).file.map((file) => {
          return file.name;
        });

  // ! a path of buf's is a file or a folder either side holds: a file the current lost is the
  // earlier's
  for (const waiver of waivers) {
    const { path } = waiver;

    if (
      path !== undefined &&
      roots.length > 0 &&
      pathOnDisk(path, roots) === undefined &&
      !earlierFiles.some((file) => {
        return isUnderScope(file, path);
      })
    ) {
      throw new InputError(
        `--except ${waiver.given}: no .proto file or folder of the current roots, nor of the earlier's`
      );
    }
  }

  const image = fromProto ? checked.set : undefined;
  // * the category HTTP, held where the earlier states an HTTP member or the project writes HTTP
  const config: Partial<IConfig> | undefined = options.config;
  const http =
    holdsHttp(earlier.blueprint) || (config !== undefined && asksHttp(config))
      ? { prefix: config?.http?.prefix ?? DEFAULT_PREFIX }
      : undefined;
  const bead = compareBlueprints(current, {
    earlier: earlier.blueprint,
    category,
    placeOf,
    ...(http === undefined ? {} : { http }),
    ...(image === undefined || earlier.image === undefined
      ? {}
      : { messages: { earlier: messageIndexOf(earlier.image), current: messageIndexOf(image) } }),
  });
  const currentFile = placeOf('').file;
  let buf: IBufFinding[] = [];
  let skipped: IDiagnostic[] = [];

  if (image !== undefined && earlier.image !== undefined) {
    buf = bufFindings(image, {
      earlier: earlier.image,
      category,
      ...(http === undefined ? {} : { json: true }),
      roots,
      ...(earlier.roots === undefined ? {} : { earlierRoots: earlier.roots }),
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

  const diagnostics = kept([
    ...of(checked.diagnostics),
    ...of(earlier.diagnostics ?? []),
    ...of(bead),
    ...buf,
    ...of(skipped),
  ]);
  // * a waiver that waived nothing: a mistyped subject, or a change a release has taken
  const unused = waivers
    .filter((waiver) => {
      return !used.has(waiver);
    })
    .map((waiver) => {
      const nowhere =
        waiver.subject !== undefined &&
        !holds(current, waiver.subject) &&
        !holds(earlier.blueprint, waiver.subject);

      return diagnosticOf('WAIVER_UNUSED', {
        message: `--except ${waiver.given} waived nothing${nowhere ? ', and neither side holds it' : ''}: take it out`,
        place: { file: currentFile === '' ? earlier.file : currentFile },
      });
    });

  return { diagnostics: [...diagnostics, ...unused], compared: true };
};
