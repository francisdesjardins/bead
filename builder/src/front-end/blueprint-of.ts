// ── Blueprint of ──────────────────────────────────────────────────────────────

// A `.proto`'s blueprint: the cascade of admissions resolved into each procedure, the kinds, the
// bindings by their messages, the names, the failures and the reservations, its `proto` members from
// buf's set (decision 0022). And where each of its places is in the `.proto`, for a finding: a
// member at its option's field or its declaration's, its nearest place when the `.proto` states none.

// dependencies

import type {
  DescEnum,
  DescFile,
  DescMessage,
  DescMethod,
  DescService,
  FileRegistry,
} from '@bufbuild/protobuf';

import type { IPlace } from '../diagnostics.ts';
import type { IdRange } from '../generated/bead/options_pb.ts';
import type {
  AdmissionRule,
  IBinding,
  IBlueprint,
  IDeprecation,
  IFailureEntry,
  IProcedureEntry,
  IRange,
  IServiceEntry,
} from '../model/blueprint.ts';
import { FORMAT, specVersion } from '../version.ts';
import { type ISourcePosition, leadingOf, pathOf, positionOf } from './comments.ts';
import type { IProtoFile, IProtoInput } from './input.ts';
import {
  admissionOf,
  FIELD,
  fileOptionsOf,
  OPTIONS_FIELD,
  optionPathOf,
  procedureOptionsOf,
  serviceOptionsOf,
} from './options.ts';

// types

/** A `.proto`'s blueprint, and where each of its places is. */
export interface IProtoBlueprint {
  readonly blueprint: IBlueprint;
  readonly placeOf: (pointer: string) => IPlace;
}

// where a value of the blueprint was read, and where its members were, each by its pointer's
// tokens under the value, `reserved/procedureNames` one member
interface ISource {
  readonly file: IProtoFile;
  readonly path: readonly number[];
  readonly members?: Readonly<Record<string, readonly number[]>>;
}

// constants

// the field of EnumDescriptorProto that holds its reserved ranges, by its number
const ENUM_RESERVED_RANGE = 4;

/** Bead's payload types, by full name, and their encodings (spec 17). */
export const PAYLOAD_TYPES: Readonly<Record<string, 'raw' | 'text' | 'json'>> = Object.freeze({
  'bead.Raw': 'raw',
  'bead.Text': 'text',
  'bead.Json': 'json',
});

// helpers

const lowerFirst = (name: string): string => {
  return `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`;
};

// an enum's name as its values' prefix: `InteropFailure` gives `INTEROP_FAILURE_`
const prefixOf = (name: string): string => {
  return `${name.replace(/(?<=[a-z0-9])(?=[A-Z])/gu, '_').toUpperCase()}_`;
};

const rangesOf = (ranges: readonly IdRange[]): IRange[] => {
  return ranges.map((range) => {
    return { first: range.first, last: range.last === 0 ? range.first : range.last };
  });
};

const deprecationOf = (deprecated: boolean, message: string): IDeprecation | undefined => {
  if (!deprecated) {
    return undefined;
  }

  return message === '' ? {} : { message };
};

// where `path` is in `file`: its own place; else the first place under it, which a message or a list
// of an option's aggregate gives, its fields' and its items'; else the nearest above it
const nearestOf = (file: DescFile, path: readonly number[]): ISourcePosition => {
  const locations = file.proto.sourceCodeInfo?.location ?? [];
  const key = path.join(',');
  const own = locations.some((each) => {
    return each.path.join(',') === key;
  });
  const [under] = locations
    .filter((each) => {
      return (
        each.path.length > path.length &&
        path.every((number, index) => {
          return each.path[index] === number;
        })
      );
    })
    .sort((one, other) => {
      return (one.span[0] ?? 0) - (other.span[0] ?? 0) || (one.span[1] ?? 0) - (other.span[1] ?? 0);
    });

  return own || under === undefined
    ? positionOf(file, path)
    : { line: (under.span[0] ?? 0) + 1, column: (under.span[1] ?? 0) + 1 };
};

const byKey = <T>(key: (item: T) => number | string): ((one: T, other: T) => number) => {
  return (one, other) => {
    const left = key(one);
    const right = key(other);

    return left < right ? -1 : left > right ? 1 : 0;
  };
};

// definition

/** A message by its full name, or by a name in `scope`'s package, as an option names one. */
export const messageNamed = (
  registry: FileRegistry,
  details: { readonly name: string; readonly scope: string }
): DescMessage | undefined => {
  const inPackage =
    details.scope === '' ? undefined : registry.getMessage(`${details.scope}.${details.name}`);

  return inPackage ?? registry.getMessage(details.name);
};

/** An enum by its full name, or by a name in `scope`'s package, as `failures` names one. */
export const enumNamed = (
  registry: FileRegistry,
  details: { readonly name: string; readonly scope: string }
): DescEnum | undefined => {
  const inPackage =
    details.scope === '' ? undefined : registry.getEnum(`${details.scope}.${details.name}`);

  return inPackage ?? registry.getEnum(details.name);
};

/** A failure's name: its enum value's, the enum's prefix taken off. */
export const failureNameOf = (catalogue: DescEnum, valueName: string): string => {
  const prefix = prefixOf(catalogue.name);

  return valueName.startsWith(prefix) ? valueName.slice(prefix.length) : valueName;
};

/**
 * The blueprint of `input`'s files, which check-proto's rules took: each Bead service and its
 * procedures, resolved, its arrays in their order.
 */
export const blueprintOf = (input: IProtoInput): IProtoBlueprint => {
  const sources = new WeakMap<object, ISource>();
  const files = new Map<string, { path: string; package: string }>();
  const messages = new Map<string, { fullName: string; file: string }>();
  const services: IServiceEntry[] = [];
  const reservedIds: IRange[] = [];
  const reservedNames: string[] = [];
  let firstFile: IProtoFile | undefined;
  const reservedServices = { ids: reservedIds, names: reservedNames };

  const noteFile = (desc: DescFile): void => {
    files.set(desc.proto.name, { path: desc.proto.name, package: desc.proto.package });
  };

  const bindingOf = (message: DescMessage): IBinding => {
    const native = PAYLOAD_TYPES[message.typeName];

    if (native !== undefined) {
      return { encoding: native };
    }

    noteFile(message.file);
    messages.set(message.typeName, { fullName: message.typeName, file: message.file.proto.name });
    return { encoding: 'proto', message: message.typeName };
  };

  const procedureOf = (
    method: DescMethod,
    context: {
      readonly file: IProtoFile;
      readonly admission: AdmissionRule;
      readonly catalogue: DescEnum | undefined;
      readonly deprecation: IDeprecation | undefined;
    }
  ): IProcedureEntry | undefined => {
    const options = procedureOptionsOf(method);

    if (options === undefined) {
      return undefined;
    }

    const own = options.admission === undefined ? undefined : admissionOf(options.admission);
    const kind = options.procedureKind.case;
    const notified =
      options.procedureKind.case === 'notifies'
        ? messageNamed(input.registry, {
            name: options.procedureKind.value.message,
            scope: method.parent.file.proto.package,
          })
        : undefined;
    const description = leadingOf(context.file.desc, pathOf(method));
    const deprecation =
      deprecationOf(method.proto.options?.deprecated === true, options.deprecationMessage) ??
      context.deprecation;
    const codes = new Map(
      (context.catalogue?.values ?? []).map((value) => {
        return [value.name, value.number];
      })
    );
    const listed = options.failures
      .filter((name) => {
        return codes.has(name);
      })
      .sort(
        byKey((name) => {
          return codes.get(name) ?? 0;
        })
      )
      .map((name) => {
        return context.catalogue === undefined ? name : failureNameOf(context.catalogue, name);
      });
    const procedure: IProcedureEntry = {
      procedureId: options.id,
      procedureName: lowerFirst(method.proto.name),
      procedureKind: kind === undefined ? 'request' : kind,
      request: bindingOf(method.input),
      result: bindingOf(method.output),
      ...(notified === undefined ? {} : { notification: bindingOf(notified) }),
      admission: own === undefined || own === 'empty' ? context.admission : own,
      failures: listed,
      ...(options.maximumPayloadBytes === 0
        ? {}
        : { maximumPayloadBytes: options.maximumPayloadBytes }),
      ...(description === undefined ? {} : { description }),
      ...(deprecation === undefined ? {} : { deprecation }),
    };
    const declaration = pathOf(method);
    const field = (number: number): number[] => {
      return optionPathOf(declaration, { options: OPTIONS_FIELD.METHOD, fields: [number] });
    };
    const kindField =
      kind === 'notifies'
        ? FIELD.PROCEDURE_NOTIFIES
        : kind === 'command'
          ? FIELD.PROCEDURE_COMMAND
          : undefined;

    sources.set(procedure, {
      file: context.file,
      path: optionPathOf(declaration, { options: OPTIONS_FIELD.METHOD }),
      members: {
        procedureId: field(FIELD.PROCEDURE_ID),
        procedureName: [...declaration, 1],
        ...(kindField === undefined ? {} : { procedureKind: field(kindField) }),
        admission: field(FIELD.PROCEDURE_ADMISSION),
        failures: field(FIELD.PROCEDURE_FAILURES),
        maximumPayloadBytes: field(FIELD.PROCEDURE_MAXIMUM_PAYLOAD_BYTES),
        notification: field(FIELD.PROCEDURE_NOTIFIES),
        request: [...declaration, 2],
        result: [...declaration, 3],
      },
    });
    return procedure;
  };

  const serviceOf = (service: DescService, file: IProtoFile): IServiceEntry | undefined => {
    const options = serviceOptionsOf(service);

    if (options === undefined) {
      return undefined;
    }

    const fileOptions = fileOptionsOf(file.desc);
    const fileAdmission =
      fileOptions?.admission === undefined ? undefined : admissionOf(fileOptions.admission);
    const own = options.admission === undefined ? undefined : admissionOf(options.admission);
    const admission = own === undefined || own === 'empty' ? fileAdmission : own;

    if (admission === undefined || admission === 'empty') {
      throw new Error(`${service.typeName} states no admission, which check-proto refuses first`);
    }

    const catalogue =
      options.failures === ''
        ? undefined
        : enumNamed(input.registry, { name: options.failures, scope: file.desc.proto.package });
    const failures: IFailureEntry[] = (catalogue?.values ?? [])
      .filter((value) => {
        return value.number !== 0;
      })
      .map((value) => {
        const description = leadingOf(value.parent.file, pathOf(value));
        // protobuf's own deprecated on the enum value, which carries no message: options.proto
        // extends no EnumValueOptions
        const deprecation = deprecationOf(value.proto.options?.deprecated === true, '');
        const failure: IFailureEntry = {
          code: value.number,
          failureName: failureNameOf(value.parent, value.name),
          ...(description === undefined ? {} : { description }),
          ...(deprecation === undefined ? {} : { deprecation }),
        };
        const owner = input.files.find((each) => {
          return each.desc === value.parent.file;
        });

        if (owner !== undefined) {
          sources.set(failure, { file: owner, path: pathOf(value) });
        }

        return failure;
      })
      .sort(
        byKey((failure) => {
          return failure.code;
        })
      );
    const deprecation = deprecationOf(
      service.proto.options?.deprecated === true,
      options.deprecationMessage
    );
    const procedures = service.methods
      .flatMap((method) => {
        const procedure = procedureOf(method, { file, admission, catalogue, deprecation });

        return procedure === undefined ? [] : [procedure];
      })
      .sort(
        byKey((procedure) => {
          return procedure.procedureId;
        })
      );
    const description = leadingOf(file.desc, pathOf(service));
    const entry: IServiceEntry = {
      serviceName: service.name.replace(/Service$/u, ''),
      serviceId: options.id,
      serviceRevision: options.revision,
      ...(description === undefined ? {} : { description }),
      ...(deprecation === undefined ? {} : { deprecation }),
      failures,
      reserved: {
        procedureIds: rangesOf(options.reservedIds).sort(
          byKey((range) => {
            return range.first;
          })
        ),
        procedureNames: [...options.reservedNames].sort(),
        failureCodes: (catalogue?.proto.reservedRange ?? [])
          .map((range) => {
            return { first: range.start, last: range.end };
          })
          .sort(
            byKey((range) => {
              return range.first;
            })
          ),
      },
      procedures,
      proto: { file: file.desc.proto.name, fullName: service.typeName },
    };
    const declaration = pathOf(service);
    const field = (number: number): number[] => {
      return optionPathOf(declaration, { options: OPTIONS_FIELD.SERVICE, fields: [number] });
    };
    const catalogueFile = input.files.find((each) => {
      return each.desc === catalogue?.file;
    });

    noteFile(file.desc);
    sources.set(entry, {
      file,
      path: optionPathOf(declaration, { options: OPTIONS_FIELD.SERVICE }),
      members: {
        serviceId: field(FIELD.SERVICE_ID),
        serviceRevision: field(FIELD.SERVICE_REVISION),
        serviceName: [...declaration, 1],
        reserved: field(FIELD.SERVICE_RESERVED_IDS),
        'reserved/procedureIds': field(FIELD.SERVICE_RESERVED_IDS),
        'reserved/procedureNames': field(FIELD.SERVICE_RESERVED_NAMES),
        'proto/file': [...declaration, 1],
        'proto/fullName': [...declaration, 1],
      },
    });

    // * the catalogue's places are its enum's, in the file that declares it
    if (catalogue !== undefined && catalogueFile !== undefined) {
      sources.set(failures, { file: catalogueFile, path: pathOf(catalogue) });
      sources.set(entry.reserved.failureCodes, {
        file: catalogueFile,
        path: [...pathOf(catalogue), ENUM_RESERVED_RANGE],
      });
    }

    return entry;
  };

  for (const file of input.files) {
    const options = fileOptionsOf(file.desc);

    firstFile ??= file;

    if (options !== undefined) {
      reservedIds.push(...rangesOf(options.reservedServices));
      reservedNames.push(...options.reservedServiceNames);
      sources.set(reservedServices, {
        file,
        path: optionPathOf([], { options: OPTIONS_FIELD.FILE }),
        members: {
          ids: optionPathOf([], {
            options: OPTIONS_FIELD.FILE,
            fields: [FIELD.FILE_RESERVED_SERVICES],
          }),
          names: optionPathOf([], {
            options: OPTIONS_FIELD.FILE,
            fields: [FIELD.FILE_RESERVED_SERVICE_NAMES],
          }),
        },
      });
    }

    for (const service of file.desc.services) {
      const entry = serviceOf(service, file);

      if (entry !== undefined) {
        services.push(entry);
      }
    }
  }

  reservedIds.sort(
    byKey((range) => {
      return range.first;
    })
  );
  reservedNames.sort();
  services.sort(
    byKey((service) => {
      return service.serviceId;
    })
  );

  const blueprint: IBlueprint = {
    format: FORMAT,
    specVersion: specVersion(),
    requires: [],
    proto: {
      files: [...files.values()].sort(
        byKey((file) => {
          return file.path;
        })
      ),
      messages: [...messages.values()].sort(
        byKey((message) => {
          return message.fullName;
        })
      ),
    },
    reservedServices,
    services,
  };

  const placeOf = (pointer: string): IPlace => {
    let at: unknown = blueprint;
    let source: ISource | undefined;
    let rest: string[] = [];

    for (const token of pointer.split('/').slice(1)) {
      const next: unknown =
        typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[token] : undefined;

      if (typeof at === 'object' && at !== null && sources.has(at)) {
        source = sources.get(at);
        rest = [];
      }

      rest.push(token);
      at = next;
    }

    if (typeof at === 'object' && at !== null && sources.has(at)) {
      source = sources.get(at);
      rest = [];
    }

    const file = source?.file ?? firstFile;

    if (file === undefined) {
      return { file: '', pointer };
    }

    // the longest member the tokens name, then the indexes under it
    let taken = 0;
    let member: readonly number[] | undefined;

    for (let length = rest.length; length > 0 && member === undefined; length -= 1) {
      member = source?.members?.[rest.slice(0, length).join('/')];
      taken = length;
    }

    const path =
      member === undefined
        ? (source?.path ?? [])
        : [...member, ...rest.slice(taken).map(Number).filter(Number.isInteger)];

    return { file: file.path, ...nearestOf(file.desc, path) };
  };

  return { blueprint, placeOf };
};
