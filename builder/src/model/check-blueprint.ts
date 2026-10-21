// ── Check blueprint ───────────────────────────────────────────────────────────

// The rules at a blueprint's level that span entries, over a blueprint the format's schema took: one
// id and one name a scope, folded as spec 16.6 folds; the reservations; a binding's encoding its
// message's; a notification's result; a failure its service lacks; a `proto` binding's source, and a
// `proto` path's file; the names every official target generates or reserves, and the descriptions
// every one writes; and, under `validate`, a field's rules of its own type (VALIDATE_RULE_FIT).

// dependencies

import { diagnosticOf, type IDiagnostic, type IPlace } from '../diagnostics.ts';
import type { RuleName } from '../rules.ts';
import {
  C_SHARP_OBJECT_MEMBERS,
  C_SHARP_PROCEDURE_NAMES,
  classNamesOf,
  csharpNameOfFailure,
  RUNTIME_TYPES,
  TYPESCRIPT_PROCEDURE_NAMES,
  xmlExcludedOf,
} from '../targets/names.ts';
import type { IBinding, IBlueprint, IRange, IServiceEntry } from './blueprint.ts';
import { foldOf } from './identity.ts';
import { fitFindingsOf } from './rules.ts';

// constants

// Bead's payload types, whose encoding is theirs, never `proto`
const PAYLOAD_TYPES = new Set(['bead.Raw', 'bead.Text', 'bead.Json']);

// helpers

const inRanges = (id: number, ranges: readonly IRange[]): boolean => {
  return ranges.some((range) => {
    return id >= range.first && id <= range.last;
  });
};

const upperFirst = (name: string): string => {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
};

// a character as its code point, U+0001
const codePointOf = (character: string): string => {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
};

// definition

/**
 * The findings of the rules that span entries over `blueprint`, each at the place `placeOf` gives
 * its pointer, in the order the blueprint is written.
 */
export const checkBlueprint = (
  blueprint: IBlueprint,
  options: { readonly placeOf: (pointer: string) => IPlace }
): IDiagnostic[] => {
  const diagnostics: IDiagnostic[] = [];
  const report = (
    rule: RuleName,
    details: { readonly at: string; readonly message: string }
  ): void => {
    diagnostics.push(
      diagnosticOf(rule, { message: details.message, place: options.placeOf(details.at) })
    );
  };
  const messages = new Set(
    (blueprint.proto?.messages ?? []).map((message) => {
      return message.fullName;
    })
  );
  const protoFiles = new Set(
    (blueprint.proto?.files ?? []).map((file) => {
      return file.path;
    })
  );
  // a description every official target writes: C#'s documentation comments are XML, which holds
  // no C0 control but tab, LF and CR, nor U+FFFE and U+FFFF, raw or by reference
  const checkDescription = (description: string | undefined, at: string): void => {
    const excluded = description === undefined ? undefined : xmlExcludedOf(description);

    if (excluded !== undefined) {
      report('DESCRIPTION_TARGET', {
        at,
        message: `the description holds ${codePointOf(excluded)}, which no XML documentation comment holds, raw or by reference`,
      });
    }
  };
  const serviceIds = new Map<number, number>();
  const serviceNames = new Map<string, string>();
  const reservedServiceNames = new Set(blueprint.reservedServices.names.map(foldOf));

  blueprint.reservedServices.ids.forEach((range, index) => {
    if (range.first > range.last) {
      report('RESERVED_RANGE', {
        at: `/reservedServices/ids/${String(index)}`,
        message: `a reserved range's first is at most its last, not ${String(range.first)} after ${String(range.last)}`,
      });
    }
  });

  const checkBinding = (binding: IBinding, at: string): void => {
    if (binding.encoding !== 'proto' || binding.message === undefined) {
      return;
    }

    if (PAYLOAD_TYPES.has(binding.message)) {
      report('ENCODING_FIT', {
        at,
        message: `${binding.message} is a payload type whose encoding is its own, never proto`,
      });
    } else if (blueprint.proto === undefined) {
      report('BINDING_SOURCE', {
        at,
        message: `a proto binding, ${binding.message}, in a blueprint with no proto: such a blueprint is never taken alone`,
      });
    } else if (!messages.has(binding.message)) {
      report('BINDING_SOURCE', {
        at,
        message: `${binding.message} is no message proto.messages lists`,
      });
    }
  };

  // * a path a blueprint carries names a file the front end read, and nothing else: compared
  // exactly, since a path is never folded
  const checkProtoFile = (file: string, at: string): void => {
    if (!protoFiles.has(file)) {
      report('PROTO_FILE', { at, message: `${file} is no file proto.files lists` });
    }
  };

  (blueprint.proto?.messages ?? []).forEach((message, at) => {
    checkProtoFile(message.file, `/proto/messages/${String(at)}/file`);
  });

  const checkService = (service: IServiceEntry, index: number): void => {
    const place = `/services/${String(index)}`;
    const codes = new Map<number, number>();
    const failureNames = new Map<string, string>();
    const procedureIds = new Map<number, number>();
    const procedureNames = new Map<string, string>();
    const hooks = new Map<string, string>();
    const reservedNames = new Set(service.reserved.procedureNames.map(foldOf));
    const catalogue = new Set(
      service.failures.map((failure) => {
        return failure.failureName;
      })
    );
    const classNames = new Set(classNamesOf(service.serviceName));
    const messageNames = new Set(
      [...messages].map((fullName) => {
        return fullName.slice(fullName.lastIndexOf('.') + 1);
      })
    );

    const firstId = serviceIds.get(service.serviceId);

    if (firstId === undefined) {
      serviceIds.set(service.serviceId, index);
    } else {
      report('SERVICE_ID_UNIQUE', {
        at: `${place}/serviceId`,
        message: `service id ${String(service.serviceId)} is /services/${String(firstId)}'s already: one blueprint is one id space`,
      });
    }

    if (inRanges(service.serviceId, blueprint.reservedServices.ids)) {
      report('ID_RESERVED', {
        at: `${place}/serviceId`,
        message: `service id ${String(service.serviceId)} is reserved: an id is for life (spec 16.8)`,
      });
    }

    const folded = foldOf(service.serviceName);
    const firstName = serviceNames.get(folded);

    if (firstName === undefined) {
      serviceNames.set(folded, service.serviceName);
    } else {
      report('NAME_UNIQUE', {
        at: `${place}/serviceName`,
        message: `${service.serviceName} and ${firstName} are one service name (spec 16.6)`,
      });
    }

    if (reservedServiceNames.has(folded)) {
      report('NAME_RESERVED', {
        at: `${place}/serviceName`,
        message: `the service name ${service.serviceName} is reserved (spec 16.6, 16.8)`,
      });
    }

    const taken = [...classNames].filter((className) => {
      return RUNTIME_TYPES.has(className) || messageNames.has(className);
    });

    if (taken.length > 0) {
      report('NAME_TARGET', {
        at: `${place}/serviceName`,
        message: `${service.serviceName} gives the classes ${taken.join(', ')}, which a public type of the runtime or a message holds already`,
      });
    }

    checkDescription(service.description, `${place}/description`);

    if (service.proto !== undefined) {
      if (blueprint.proto === undefined) {
        report('PROTO_FILE', {
          at: `${place}/proto`,
          message:
            'a service read from a .proto, in a blueprint with no proto: its file is listed nowhere',
        });
      } else {
        checkProtoFile(service.proto.file, `${place}/proto/file`);
      }
    }

    for (const key of ['procedureIds', 'failureCodes'] as const) {
      service.reserved[key].forEach((range, at) => {
        if (range.first > range.last) {
          report('RESERVED_RANGE', {
            at: `${place}/reserved/${key}/${String(at)}`,
            message: `a reserved range's first is at most its last, not ${String(range.first)} after ${String(range.last)}`,
          });
        }
      });
    }

    service.failures.forEach((failure, at) => {
      const failurePlace = `${place}/failures/${String(at)}`;
      const firstCode = codes.get(failure.code);
      const bare = failure.failureName.replaceAll('_', '');
      const firstFailure = failureNames.get(bare);
      const csharp = csharpNameOfFailure(failure.failureName);

      if (firstCode === undefined) {
        codes.set(failure.code, at);
      } else {
        report('FAILURE_CODE', {
          at: `${failurePlace}/code`,
          message: `code ${String(failure.code)} is ${place}/failures/${String(firstCode)}'s already: one name a code`,
        });
      }

      if (inRanges(failure.code, service.reserved.failureCodes)) {
        report('ID_RESERVED', {
          at: `${failurePlace}/code`,
          message: `failure code ${String(failure.code)} is reserved: a code is for life`,
        });
      }

      if (firstFailure === undefined) {
        failureNames.set(bare, failure.failureName);
      } else {
        report('NAME_UNIQUE', {
          at: `${failurePlace}/failureName`,
          message: `${failure.failureName} and ${firstFailure} are one failure name without their underscores`,
        });
      }

      if (csharp === 'Code' || C_SHARP_OBJECT_MEMBERS.has(csharp)) {
        report('NAME_TARGET', {
          at: `${failurePlace}/failureName`,
          message: `${failure.failureName} is ${csharp} in C#, a member its failure's class holds already`,
        });
      }

      checkDescription(failure.description, `${failurePlace}/description`);
    });

    service.procedures.forEach((procedure, at) => {
      const procedurePlace = `${place}/procedures/${String(at)}`;
      const firstProcedure = procedureIds.get(procedure.procedureId);
      const foldedName = foldOf(procedure.procedureName);
      const firstProcedureName = procedureNames.get(foldedName);
      const rpcName = upperFirst(procedure.procedureName);

      if (firstProcedure === undefined) {
        procedureIds.set(procedure.procedureId, at);
      } else {
        report('PROCEDURE_ID_UNIQUE', {
          at: `${procedurePlace}/procedureId`,
          message: `procedure id ${String(procedure.procedureId)} is ${place}/procedures/${String(firstProcedure)}'s already: one address, one procedure`,
        });
      }

      if (inRanges(procedure.procedureId, service.reserved.procedureIds)) {
        report('ID_RESERVED', {
          at: `${procedurePlace}/procedureId`,
          message: `procedure id ${String(procedure.procedureId)} is reserved: an id is for life (spec 16.8)`,
        });
      }

      if (firstProcedureName === undefined) {
        procedureNames.set(foldedName, procedure.procedureName);
      } else {
        report('NAME_UNIQUE', {
          at: `${procedurePlace}/procedureName`,
          message: `${procedure.procedureName} and ${firstProcedureName} are one procedure name (spec 16.6)`,
        });
      }

      if (reservedNames.has(foldedName)) {
        report('NAME_RESERVED', {
          at: `${procedurePlace}/procedureName`,
          message: `the procedure name ${procedure.procedureName} is reserved (spec 16.6, 16.8)`,
        });
      }

      if (TYPESCRIPT_PROCEDURE_NAMES.has(procedure.procedureName)) {
        report('NAME_TARGET', {
          at: `${procedurePlace}/procedureName`,
          message: `${procedure.procedureName} is a member TypeScript's generated client holds already`,
        });
      } else if (
        C_SHARP_PROCEDURE_NAMES.has(rpcName) ||
        C_SHARP_OBJECT_MEMBERS.has(rpcName) ||
        classNames.has(rpcName)
      ) {
        report('NAME_TARGET', {
          at: `${procedurePlace}/procedureName`,
          message: `${rpcName}, its C# name, is a member or a type its service's C# holds already`,
        });
      }

      if (typeof procedure.admission === 'object') {
        const hook = procedure.admission.hook;
        const foldedHook = foldOf(hook);
        const firstHook = hooks.get(foldedHook);

        if (firstHook === undefined) {
          hooks.set(foldedHook, hook);
        } else if (firstHook !== hook) {
          report('NAME_UNIQUE', {
            at: `${procedurePlace}/admission/hook`,
            message: `${hook} and ${firstHook} are one hook name (spec 16.6)`,
          });
        }

        if (C_SHARP_OBJECT_MEMBERS.has(upperFirst(hook))) {
          report('NAME_TARGET', {
            at: `${procedurePlace}/admission/hook`,
            message: `${upperFirst(hook)}, its C# name, is a member every C# object holds already`,
          });
        } else if (classNames.has(upperFirst(hook))) {
          report('NAME_TARGET', {
            at: `${procedurePlace}/admission/hook`,
            message: `${upperFirst(hook)}, its C# name, is a class of its service, which its hooks' class would hold as its member`,
          });
        }
      }

      procedure.failures.forEach((name, listed) => {
        if (csharpNameOfFailure(name) === rpcName) {
          report('NAME_TARGET', {
            at: `${procedurePlace}/failures/${String(listed)}`,
            message: `${rpcName} is ${name}'s C# name and its procedure's, whose class of failures would hold it as its member`,
          });
        }

        if (!catalogue.has(name)) {
          report('FAILURE_UNKNOWN', {
            at: `${procedurePlace}/failures/${String(listed)}`,
            message: `${name} is no failure of its service's catalogue`,
          });
        }
      });

      checkDescription(procedure.description, `${procedurePlace}/description`);
      checkBinding(procedure.request, `${procedurePlace}/request`);
      checkBinding(procedure.result, `${procedurePlace}/result`);

      if (procedure.notification !== undefined) {
        checkBinding(procedure.notification, `${procedurePlace}/notification`);
      }

      if (procedure.procedureKind === 'notifies' && procedure.result.encoding === 'raw') {
        report('NOTIFICATION_RESULT', {
          at: `${procedurePlace}/result`,
          message:
            'a procedure that notifies answers raw bytes, which go in one envelope (spec 11.6)',
        });
      }
    });
  };

  blueprint.services.forEach(checkService);

  // * a blueprint is read without its .proto, by `breaking` among others: the rules fit their
  // fields here, a wrapper's its scalar's, as buf's PROTOVALIDATE holds them on a .proto
  for (const finding of fitFindingsOf(blueprint)) {
    report('VALIDATE_RULE_FIT', { at: finding.pointer, message: finding.message });
  }

  return diagnostics;
};
