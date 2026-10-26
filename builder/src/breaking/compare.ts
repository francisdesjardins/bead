// ── Compare ───────────────────────────────────────────────────────────────────

// `beadc breaking`'s own rules: two blueprints, the earlier and the current, compared by id — a
// service by its id, a procedure by its id within its service, a failure by its code — each finding
// placed in the current input at its pointer, a deletion at the reservation that would waive it
// (decision 0022), and keyed by its subject: its entity by the ids no shift moves, AIP-122's
// hierarchy of kinds and ids written `kind:id`, which is what a waiver names. `WIRE` keeps a peer
// built from the earlier talking with one built from the current; `API` holds every `WIRE` rule and
// keeps code written against the earlier's generated API compiling and meaning the same, so a
// service or a procedure gone is its finding even where `WIRE` waives it, deprecated, then its id
// reserved. A revision is never lowered, and moves where its service changed: a finding of any
// rule, an addition, a deprecation, a request's rules changed either way, or a message its bindings
// reach where both sides are buf images, with what of its file reaches the wire or a target's API. Read through the model, never as bytes:
// an earlier in another member or array order, and a description, change nothing. The category
// `HTTP`, what a client of the earlier's routes meets, is held under either where a run asks it
// (`http.ts`, decision 0037), beside the wire: no revision moves for it.

// dependencies

import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  DescriptorProtoSchema,
  type EnumDescriptorProto,
  EnumDescriptorProtoSchema,
  FeatureSetSchema,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';

import { diagnosticOf, type IDiagnostic } from '../diagnostics.ts';
import {
  type AdmissionRule,
  type IBinding,
  type IBlueprint,
  type IFailureEntry,
  type IProcedureEntry,
  type IRange,
  type IServiceEntry,
  type PlaceOf,
  sortFindings,
} from '../model/blueprint.ts';
import { areOneName } from '../model/identity.ts';
import { Category, HTTP_CATEGORY, type IRule, RULES, type RuleName } from '../rules.ts';
import { httpBreakingOf } from './http.ts';
import { rulesChangedOf, tighteningsOf } from './rules.ts';

// types

/** A message or an enum of a buf image: its descriptor's bytes, and what its fields name. */
export interface IMessageEntry {
  readonly fingerprint: string;
  readonly references: readonly string[];
}

/** The messages and enums of a buf image, by full name. */
export type MessageIndex = ReadonlyMap<string, IMessageEntry>;

/** What {@link compareBlueprints} compares the current against. */
export interface ICompareOptions {
  readonly earlier: IBlueprint;
  readonly category: Category;
  /** Where a pointer of the current blueprint is in the current input. */
  readonly placeOf: PlaceOf;
  /** The two sides' messages, where both are buf images. */
  readonly messages?: { readonly earlier: MessageIndex; readonly current: MessageIndex };
  /**
   * Where the category `HTTP` is held (decision 0037): the prefix the routes are under. Left out,
   * no HTTP rule runs.
   */
  readonly http?: { readonly prefix: string };
}

// a finding before its place: its rule, its pointer into the current, its subject, the service it
// is on
interface IFinding {
  readonly rule: RuleName;
  readonly pointer: string;
  readonly message: string;
  readonly subject: string;
  readonly serviceId?: number;
}

// constants

// how tight an admission is: none, then a session, then a hook
const ADMISSION_RANK = Object.freeze({ none: 0, session: 1, hook: 2 } as const);

// the bindings a procedure may hold
const SIDES = Object.freeze(['request', 'result', 'notification'] as const);

// the kind of entity each reserved list of a service holds ids of
const RESERVED_KIND = Object.freeze({
  procedureIds: 'procedure',
  failureCodes: 'failure',
} as const);

// helpers

const covers = (ranges: readonly IRange[], id: number): boolean => {
  return ranges.some((range) => {
    return id >= range.first && id <= range.last;
  });
};

const idsOf = (ranges: readonly IRange[]): Set<number> => {
  const ids = new Set<number>();

  for (const range of ranges) {
    for (let id = range.first; id <= range.last; id += 1) {
      ids.add(id);
    }
  }

  return ids;
};

// ids as a reader takes them: `3`, `3 to 5`, `3 to 5 and 9`
const idsText = (ids: readonly number[]): string => {
  const runs: string[] = [];
  const sorted = [...ids].sort((one, other) => {
    return one - other;
  });

  for (let index = 0; index < sorted.length;) {
    const first = sorted[index] ?? 0;
    let last = first;

    while (sorted[index + 1] === last + 1) {
      index += 1;
      last += 1;
    }

    runs.push(first === last ? String(first) : `${String(first)} to ${String(last)}`);
    index += 1;
  }

  return runs.length < 2
    ? (runs[0] ?? '')
    : `${runs.slice(0, -1).join(', ')} and ${String(runs.at(-1))}`;
};

/** A range as a subject keys it: `4`, or `4-6`, as the earlier declared it. */
export const rangeKeyOf = (range: IRange): string => {
  return range.first === range.last
    ? String(range.first)
    : `${String(range.first)}-${String(range.last)}`;
};

const holdsName = (names: readonly string[], name: string): boolean => {
  return names.some((each) => {
    return areOneName(each, name);
  });
};

const hookOf = (admission: AdmissionRule): string | undefined => {
  return typeof admission === 'object' ? admission.hook : undefined;
};

const rankOf = (admission: AdmissionRule): number => {
  return typeof admission === 'object' ? ADMISSION_RANK.hook : ADMISSION_RANK[admission];
};

const admissionText = (admission: AdmissionRule): string => {
  return typeof admission === 'object' ? `the hook ${admission.hook}` : admission;
};

const bindingText = (binding: IBinding): string => {
  return binding.message === undefined
    ? binding.encoding
    : `${binding.encoding} ${binding.message}`;
};

/** The hooks a service's procedures name, in their names' order. */
export const hooksOf = (service: IServiceEntry): string[] => {
  return [
    ...new Set(
      service.procedures.flatMap((procedure) => {
        const hook = hookOf(procedure.admission);

        return hook === undefined ? [] : [hook];
      })
    ),
  ].sort();
};

const sameDeprecation = (
  one: IProcedureEntry | IServiceEntry | IFailureEntry,
  other: typeof one
): boolean => {
  return (
    (one.deprecation === undefined) === (other.deprecation === undefined) &&
    one.deprecation?.message === other.deprecation?.message
  );
};

// a procedure's failures by code, read through its own service's catalogue
const codesOf = (procedure: IProcedureEntry, service: IServiceEntry): Set<number> => {
  return new Set(
    procedure.failures.flatMap((name) => {
      const failure = service.failures.find((each) => {
        return each.failureName === name;
      });

      return failure === undefined ? [] : [failure.code];
    })
  );
};

// the messages and enums `service`'s `proto` bindings reach in `index`, by their fields' types
const reachedOf = (service: IServiceEntry, index: MessageIndex): Set<string> => {
  const reached = new Set<string>();
  const pending = service.procedures.flatMap((procedure) => {
    return SIDES.flatMap((side) => {
      const message = procedure[side]?.message;

      return message === undefined ? [] : [message];
    });
  });

  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (!reached.has(name)) {
      reached.add(name);
      pending.push(...(index.get(name)?.references ?? []));
    }
  }

  return reached;
};

const fingerprintOf = (bytes: Uint8Array): string => {
  return Buffer.from(bytes).toString('base64');
};

// * what of a file reaches the wire or a Bead target's API, beside its declarations: its syntax,
// its edition and its own features, which with the edition give each declaration's resolved
// features, and `csharp_namespace`, which the C# target's namespace reads. Not another language's
// option, buf FILE's under API, nor `(bead.file)`, the blueprint's compare's
const fileFingerprintOf = (file: FileDescriptorProto): string => {
  const features = file.options?.features;

  return JSON.stringify([
    file.syntax,
    file.edition,
    features === undefined ? '' : fingerprintOf(toBinary(FeatureSetSchema, features)),
    file.options?.csharpNamespace ?? '',
  ]);
};

// definition

/**
 * The messages and enums of `image`, buf's image or a set, by full name: each one's descriptor's
 * bytes, its nested declarations taken out, which are entries of their own, with what of its file
 * reaches the wire or a target's API, and the full names its fields' types give. A descriptor holds
 * no source info: a comment moves nothing.
 */
export const messageIndexOf = (image: Uint8Array): MessageIndex => {
  const index = new Map<string, IMessageEntry>();

  for (const file of fromBinary(FileDescriptorSetSchema, image).file) {
    const scope = file.package === '' ? '' : `${file.package}.`;
    const ofFile = fileFingerprintOf(file);
    const noteEnum = (proto: EnumDescriptorProto, at: string): void => {
      index.set(`${at}${proto.name}`, {
        fingerprint: `${fingerprintOf(toBinary(EnumDescriptorProtoSchema, proto))} ${ofFile}`,
        references: [],
      });
    };
    const noteMessage = (proto: DescriptorProto, at: string): void => {
      const name = `${at}${proto.name}`;
      const own = clone(DescriptorProtoSchema, proto);

      own.nestedType = [];
      own.enumType = [];
      index.set(name, {
        fingerprint: `${fingerprintOf(toBinary(DescriptorProtoSchema, own))} ${ofFile}`,
        references: proto.field.flatMap((field) => {
          return field.typeName === '' ? [] : [field.typeName.replace(/^\./u, '')];
        }),
      });

      for (const nested of proto.nestedType) {
        noteMessage(nested, `${name}.`);
      }

      for (const nested of proto.enumType) {
        noteEnum(nested, `${name}.`);
      }
    };

    for (const message of file.messageType) {
      noteMessage(message, scope);
    }

    for (const enumeration of file.enumType) {
      noteEnum(enumeration, scope);
    }
  }

  return index;
};

/**
 * Bead's breaking rules over `current` against `options.earlier`, under `options.category`: each
 * finding at the place `options.placeOf` gives its pointer into the current, its pointer and its
 * subject kept, in the order of the pointers. Pure: it reads nothing and runs nothing.
 */
export const compareBlueprints = (current: IBlueprint, options: ICompareOptions): IDiagnostic[] => {
  const { earlier } = options;
  const findings: IFinding[] = [];
  const changed = new Set<number>();
  const find = (finding: IFinding): void => {
    findings.push(finding);
  };

  // ! the services both hold, by id: what every rule but a service's deletion reads
  earlier.services.forEach((was, wasAt) => {
    const at = current.services.findIndex((service) => {
      return service.serviceId === was.serviceId;
    });
    const now = current.services[at];
    const serviceId = was.serviceId;
    const service = `/services/${String(at)}`;
    const named = `service ${String(serviceId)} ${was.serviceName}`;
    const serviceSubject = `service:${String(serviceId)}`;

    if (now === undefined) {
      const deprecated = was.deprecation !== undefined;
      const reserved = covers(current.reservedServices.ids, serviceId);

      // * deprecated, then its id reserved, it passes WIRE (16.8); under API, its generated client
      // and server go with it, as buf's FILE refuses
      if (!(deprecated && reserved)) {
        find({
          rule: 'SERVICE_NO_DELETE',
          pointer: '/reservedServices/ids',
          message: `${named}, the earlier's /services/${String(wasAt)}, is gone${deprecated ? '' : ', never deprecated'}${reserved ? '' : ', its id not reserved'}: a peer's call is answered SERVICE_UNKNOWN; deprecate it in a release, then reserve its id`,
          subject: serviceSubject,
        });
      } else if (options.category === Category.API) {
        find({
          rule: 'SERVICE_NO_DELETE',
          pointer: '/reservedServices/ids',
          message: `${named}, the earlier's /services/${String(wasAt)}, is gone, deprecated and its id reserved: its generated client and server go with it; take it out in a release that moves the major, the minor before 1.0, and waive this there`,
          subject: serviceSubject,
        });
      }

      if (!holdsName(current.reservedServices.names, was.serviceName)) {
        find({
          rule: 'NAME_NO_DELETE',
          pointer: '/reservedServices/names',
          message: `${named}, the earlier's /services/${String(wasAt)}, is gone, its name not reserved: a name never comes to label another service; reserve it`,
          subject: serviceSubject,
        });
      }

      return;
    }

    // its names, its file and its hooks
    if (was.serviceName !== now.serviceName) {
      find({
        rule: 'SERVICE_SAME_NAME',
        pointer: `${service}/serviceName`,
        message: `${named} is ${now.serviceName} now: its generated types are imported by its name`,
        subject: serviceSubject,
        serviceId,
      });
    } else if (
      was.proto !== undefined &&
      now.proto !== undefined &&
      was.proto.fullName !== now.proto.fullName
    ) {
      find({
        rule: 'SERVICE_SAME_NAME',
        pointer: `${service}/proto/fullName`,
        message: `${named} was ${was.proto.fullName}, now ${now.proto.fullName}: its generated types are imported by its name`,
        subject: serviceSubject,
        serviceId,
      });
    }

    if (was.proto !== undefined && now.proto !== undefined && was.proto.file !== now.proto.file) {
      find({
        rule: 'SERVICE_SAME_FILE',
        pointer: `${service}/proto/file`,
        message: `${named} was declared in ${was.proto.file}, now in ${now.proto.file}: the TypeScript target writes its code beside its file, which every import names`,
        subject: serviceSubject,
        serviceId,
      });
    }

    // * one finding a hook gone or added: its server's options name each, required
    const hooksBefore = hooksOf(was);
    const hooksNow = hooksOf(now);

    for (const hook of hooksBefore.filter((each) => {
      return !hooksNow.includes(each);
    })) {
      find({
        rule: 'SERVICE_SAME_HOOKS',
        pointer: service,
        message: `${named} named the hook ${hook}, and names it no more: its server's options name each hook, required`,
        subject: `${serviceSubject}/hook:${hook}`,
        serviceId,
      });
    }

    for (const hook of hooksNow.filter((each) => {
      return !hooksBefore.includes(each);
    })) {
      find({
        rule: 'SERVICE_SAME_HOOKS',
        pointer: service,
        message: `${named} names the hook ${hook} now: its server's options name each hook, required`,
        subject: `${serviceSubject}/hook:${hook}`,
        serviceId,
      });
    }

    if (!sameDeprecation(was, now)) {
      changed.add(serviceId);
    }

    // its catalogue, by code
    for (const failure of was.failures) {
      const nowAt = now.failures.findIndex((each) => {
        return each.code === failure.code;
      });
      const kept = now.failures[nowAt];
      const failureNamed = `failure ${String(failure.code)} ${failure.failureName}`;
      const failureSubject = `${serviceSubject}/failure:${String(failure.code)}`;

      if (kept === undefined) {
        if (!covers(now.reserved.failureCodes, failure.code)) {
          find({
            rule: 'FAILURE_NO_DELETE',
            pointer: `${service}/reserved/failureCodes`,
            message: `${failureNamed} of ${named} is gone, its code not reserved: a code reused means another failure to an earlier peer; reserve it`,
            subject: failureSubject,
            serviceId,
          });
        }

        find({
          rule: 'NAME_NO_DELETE',
          pointer: `${service}/failures`,
          message: `${failureNamed} of ${named} is gone from its catalogue: its generated member goes with it`,
          subject: failureSubject,
          serviceId,
        });
      } else if (kept.failureName !== failure.failureName) {
        find({
          rule: 'FAILURE_SAME_NAME',
          pointer: `${service}/failures/${String(nowAt)}/failureName`,
          message: `${failureNamed} of ${named} is ${kept.failureName} now: its catalogue's member is named by it`,
          subject: failureSubject,
          serviceId,
        });
      } else if (!sameDeprecation(failure, kept)) {
        changed.add(serviceId);
      }
    }

    if (
      now.failures.some((failure) => {
        return !was.failures.some((each) => {
          return each.code === failure.code;
        });
      })
    ) {
      changed.add(serviceId);
    }

    // its reservations, for life: one finding a range the earlier declared, keyed to it as declared
    const reservedIds = (key: 'procedureIds' | 'failureCodes', what: string): void => {
      for (const range of was.reserved[key]) {
        const lost = [...idsOf([range])].filter((id) => {
          return !covers(now.reserved[key], id);
        });

        if (lost.length > 0) {
          find({
            rule: 'RESERVED_NO_DELETE',
            pointer: `${service}/reserved/${key}`,
            message: `${what} ${idsText(lost)} of ${named}, reserved in the earlier, are reserved no more: a reservation is for life`,
            subject: `${serviceSubject}/${RESERVED_KIND[key]}:${rangeKeyOf(range)}`,
            serviceId,
          });
        }
      }

      const before = idsOf(was.reserved[key]);

      if (
        [...idsOf(now.reserved[key])].some((id) => {
          return !before.has(id);
        })
      ) {
        changed.add(serviceId);
      }
    };

    reservedIds('procedureIds', 'the procedure ids');
    reservedIds('failureCodes', 'the failure codes');

    for (const name of was.reserved.procedureNames) {
      if (!holdsName(now.reserved.procedureNames, name)) {
        find({
          rule: 'RESERVED_NO_DELETE',
          pointer: `${service}/reserved/procedureNames`,
          message: `the procedure name ${name} of ${named}, reserved in the earlier, is reserved no more: a reservation is for life`,
          subject: `${serviceSubject}/name:${name}`,
          serviceId,
        });
      }
    }

    if (
      now.reserved.procedureNames.some((name) => {
        return !holdsName(was.reserved.procedureNames, name);
      })
    ) {
      changed.add(serviceId);
    }

    // its procedures, by id
    was.procedures.forEach((before, beforeAt) => {
      const nowAt = now.procedures.findIndex((each) => {
        return each.procedureId === before.procedureId;
      });
      const after = now.procedures[nowAt];
      const procedure = `${service}/procedures/${String(nowAt)}`;
      const procedureNamed = `procedure ${String(before.procedureId)} ${before.procedureName} of ${named}`;
      const procedureSubject = `${serviceSubject}/procedure:${String(before.procedureId)}`;

      // * the name the earlier gave an id stays that id's, or is reserved (16.8)
      if (
        !(after !== undefined && areOneName(after.procedureName, before.procedureName)) &&
        !holdsName(now.reserved.procedureNames, before.procedureName)
      ) {
        const holder = now.procedures.find((each) => {
          return areOneName(each.procedureName, before.procedureName);
        });

        find({
          rule: 'NAME_NO_DELETE',
          pointer: `${service}/reserved/procedureNames`,
          message: `the name ${before.procedureName}, procedure ${String(before.procedureId)}'s in the earlier, is neither its name nor reserved${holder === undefined ? '' : `, and procedure ${String(holder.procedureId)} holds it`}: a name never comes to label another procedure; reserve it`,
          subject: procedureSubject,
          serviceId,
        });
      }

      if (after === undefined) {
        const deprecated = before.deprecation !== undefined || was.deprecation !== undefined;
        const reserved = covers(now.reserved.procedureIds, before.procedureId);

        // * deprecated, then its id reserved, it passes WIRE (16.8); under API, its requester and
        // its resolver go with it, as buf's FILE refuses
        if (!(deprecated && reserved)) {
          find({
            rule: 'PROCEDURE_NO_DELETE',
            pointer: `${service}/reserved/procedureIds`,
            message: `${procedureNamed}, the earlier's /services/${String(wasAt)}/procedures/${String(beforeAt)}, is gone${deprecated ? '' : ', never deprecated'}${reserved ? '' : ', its id not reserved'}: a peer's call is answered PROCEDURE_UNKNOWN; deprecate it in a release, then reserve its id`,
            subject: procedureSubject,
            serviceId,
          });
        } else if (options.category === Category.API) {
          find({
            rule: 'PROCEDURE_NO_DELETE',
            pointer: `${service}/reserved/procedureIds`,
            message: `${procedureNamed}, the earlier's /services/${String(wasAt)}/procedures/${String(beforeAt)}, is gone, deprecated and its id reserved: its requester and its resolver go with it; take it out in a release that moves the major, the minor before 1.0, and waive this there`,
            subject: procedureSubject,
            serviceId,
          });
        }

        changed.add(serviceId);
        return;
      }

      if (before.procedureName !== after.procedureName) {
        find({
          rule: 'PROCEDURE_SAME_NAME',
          pointer: `${procedure}/procedureName`,
          message: `${procedureNamed} is ${after.procedureName} now: its requester, its resolver and the metrics and filters that name it follow its name`,
          subject: procedureSubject,
          serviceId,
        });
      }

      if ((before.procedureKind === 'command') !== (after.procedureKind === 'command')) {
        find({
          rule: 'PROCEDURE_SAME_KIND',
          pointer: `${procedure}/procedureKind`,
          message: `${procedureNamed} was a ${before.procedureKind}, now a ${after.procedureKind}: the caller and the answerer trade places`,
          subject: procedureSubject,
          serviceId,
        });
      } else if (before.procedureKind === 'notifies' && after.procedureKind !== 'notifies') {
        find({
          rule: 'PROCEDURE_STILL_NOTIFIES',
          pointer: `${procedure}/procedureKind`,
          message: `${procedureNamed} notified, and no longer does: an earlier subscriber is answered and hears nothing more`,
          subject: procedureSubject,
          serviceId,
        });
      } else if (before.procedureKind !== after.procedureKind) {
        changed.add(serviceId);
      }

      for (const side of SIDES) {
        const one = before[side];
        const other = after[side];

        if (one === undefined || other === undefined) {
          continue;
        }

        if (one.encoding !== other.encoding) {
          find({
            rule: 'PROCEDURE_SAME_ENCODING',
            pointer: `${procedure}/${side}`,
            message: `${procedureNamed}'s ${side} was ${bindingText(one)}, now ${bindingText(other)}: its bytes are read another way`,
            subject: procedureSubject,
            serviceId,
          });
        } else if (one.message !== other.message) {
          find({
            rule: 'PROCEDURE_MESSAGE_SWITCHED',
            pointer: `${procedure}/${side}/message`,
            message: `${procedureNamed}'s ${side} was ${String(one.message)}, now ${String(other.message)}: buf compares a message with its namesake alone, so nobody compared these two; check them by hand, then waive this`,
            subject: procedureSubject,
            serviceId,
          });
          find({
            rule: 'PROCEDURE_SAME_MESSAGES',
            pointer: `${procedure}/${side}/message`,
            message: `${procedureNamed}'s ${side} was ${String(one.message)}, now ${String(other.message)}: its generated types change`,
            subject: procedureSubject,
            serviceId,
          });
        }
      }

      if (before.maximumPayloadBytes !== after.maximumPayloadBytes) {
        const limitText = (limit: number | undefined): string => {
          return limit === undefined ? "the router's" : String(limit);
        };

        find({
          rule: 'PROCEDURE_SAME_LIMIT',
          pointer: `${procedure}/maximumPayloadBytes`,
          message: `${procedureNamed}'s limit was ${limitText(before.maximumPayloadBytes)}, now ${limitText(after.maximumPayloadBytes)}: both ends hold it, and nothing announces it`,
          subject: procedureSubject,
          serviceId,
        });
      }

      const rankBefore = rankOf(before.admission);
      const rankAfter = rankOf(after.admission);
      const hookBefore = hookOf(before.admission);
      const hookAfter = hookOf(after.admission);

      if (
        rankAfter > rankBefore ||
        (rankBefore > ADMISSION_RANK.none &&
          rankAfter > ADMISSION_RANK.none &&
          rankAfter !== rankBefore)
      ) {
        find({
          rule: 'PROCEDURE_ADMISSION_TIGHTENED',
          pointer: `${procedure}/admission`,
          message: `${procedureNamed} was admitted by ${admissionText(before.admission)}, now by ${admissionText(after.admission)}: a peer it admitted is refused`,
          subject: procedureSubject,
          serviceId,
        });
      } else if (hookBefore !== undefined && hookAfter !== undefined && hookBefore !== hookAfter) {
        find({
          rule: 'PROCEDURE_SAME_HOOK',
          pointer: `${procedure}/admission/hook`,
          message: `${procedureNamed} was admitted by the hook ${hookBefore}, now by ${hookAfter}: beadc cannot read a hook's code, and its generated member is another`,
          subject: procedureSubject,
          serviceId,
        });
      } else if (rankAfter < rankBefore) {
        changed.add(serviceId);
      }

      // * a request's rules, where both sides bind one message: tightened, a peer's request the
      // earlier took is refused; changed either way, the revision moves (decision 0035)
      const requested = before.request.message;

      if (
        requested !== undefined &&
        before.request.encoding === 'proto' &&
        after.request.encoding === 'proto' &&
        requested === after.request.message
      ) {
        const sides = { earlier, current };
        const tightened = tighteningsOf(sides, requested);

        if (tightened.length > 0) {
          find({
            rule: 'PROCEDURE_RULES_TIGHTENED',
            pointer: `${procedure}/request/message`,
            message: `${procedureNamed}'s request, ${requested}, is held to tighter rules: ${tightened[0] ?? ''}${
              tightened.length > 1 ? `, and ${String(tightened.length - 1)} more` : ''
            }; a request an earlier peer sends is refused`,
            subject: procedureSubject,
            serviceId,
          });
        } else if (rulesChangedOf(sides, requested)) {
          changed.add(serviceId);
        }
      }

      const listedBefore = codesOf(before, was);
      const listedNow = codesOf(after, now);

      for (const code of listedBefore) {
        const kept = now.failures.find((failure) => {
          return failure.code === code;
        });

        if (kept !== undefined && !listedNow.has(code)) {
          find({
            rule: 'PROCEDURE_FAILURE_NO_DELETE',
            pointer: `${procedure}/failures`,
            message: `failure ${String(code)} ${kept.failureName} is taken out of ${procedureNamed}'s failures, its catalogue keeping it: the procedure's generated failures lose a member`,
            subject: `${procedureSubject}/failure:${String(code)}`,
            serviceId,
          });
        }
      }

      if (
        [...listedNow].some((code) => {
          return !listedBefore.has(code);
        }) ||
        !sameDeprecation(before, after)
      ) {
        changed.add(serviceId);
      }
    });

    if (
      now.procedures.some((procedure) => {
        return !was.procedures.some((each) => {
          return each.procedureId === procedure.procedureId;
        });
      })
    ) {
      changed.add(serviceId);
    }

    // * a message one of its bindings reaches, where both sides are buf images
    if (options.messages !== undefined) {
      const { earlier: earlierIndex, current: currentIndex } = options.messages;
      const reached = new Set([...reachedOf(was, earlierIndex), ...reachedOf(now, currentIndex)]);

      for (const name of reached) {
        if (earlierIndex.get(name)?.fingerprint !== currentIndex.get(name)?.fingerprint) {
          changed.add(serviceId);
        }
      }
    }
  });

  // a service the current holds, its name the earlier gave another id
  for (const was of earlier.services) {
    const now = current.services.find((service) => {
      return service.serviceId === was.serviceId;
    });

    if (
      now !== undefined &&
      !areOneName(now.serviceName, was.serviceName) &&
      !holdsName(current.reservedServices.names, was.serviceName)
    ) {
      const holder = current.services.find((service) => {
        return areOneName(service.serviceName, was.serviceName);
      });

      find({
        rule: 'NAME_NO_DELETE',
        pointer: '/reservedServices/names',
        message: `the name ${was.serviceName}, service ${String(was.serviceId)}'s in the earlier, is neither its name nor reserved${holder === undefined ? '' : `, and service ${String(holder.serviceId)} holds it`}: a name never comes to label another service; reserve it`,
        subject: `service:${String(was.serviceId)}`,
        serviceId: was.serviceId,
      });
    }
  }

  // the services' reservations, for life
  for (const range of earlier.reservedServices.ids) {
    const lost = [...idsOf([range])].filter((id) => {
      return !covers(current.reservedServices.ids, id);
    });

    if (lost.length > 0) {
      find({
        rule: 'RESERVED_NO_DELETE',
        pointer: '/reservedServices/ids',
        message: `the service ids ${idsText(lost)}, reserved in the earlier, are reserved no more: a reservation is for life`,
        subject: `service:${rangeKeyOf(range)}`,
      });
    }
  }

  for (const name of earlier.reservedServices.names) {
    if (!holdsName(current.reservedServices.names, name)) {
      find({
        rule: 'RESERVED_NO_DELETE',
        pointer: '/reservedServices/names',
        message: `the service name ${name}, reserved in the earlier, is reserved no more: a reservation is for life`,
        subject: `name:${name}`,
      });
    }
  }

  // * the revision: never lowered, and moved where the service changed; a jump is no finding
  for (const finding of findings) {
    if (finding.serviceId !== undefined) {
      changed.add(finding.serviceId);
    }
  }

  current.services.forEach((now, at) => {
    const was = earlier.services.find((service) => {
      return service.serviceId === now.serviceId;
    });

    if (was === undefined) {
      return;
    }

    const named = `service ${String(now.serviceId)} ${now.serviceName}`;
    const subject = `service:${String(now.serviceId)}`;

    if (now.serviceRevision < was.serviceRevision) {
      find({
        rule: 'SERVICE_REVISION',
        pointer: `/services/${String(at)}/serviceRevision`,
        message: `${named}'s revision is ${String(now.serviceRevision)}, lower than the earlier's ${String(was.serviceRevision)}: it counts the releases of its contract, and never goes back`,
        subject,
      });
    } else if (changed.has(now.serviceId) && now.serviceRevision === was.serviceRevision) {
      find({
        rule: 'SERVICE_REVISION',
        pointer: `/services/${String(at)}/serviceRevision`,
        message: `${named}'s contract changed and its revision is the earlier's, ${String(was.serviceRevision)}: ${String(was.serviceRevision + 1)} at least is due`,
        subject,
      });
    }
  });

  // * what a client of the earlier's routes meets, held under either category; beside the wire, no
  // revision moves for it
  if (options.http !== undefined) {
    findings.push(...httpBreakingOf(current, { earlier, prefix: options.http.prefix }));
  }

  const kept = findings.filter((finding) => {
    const rule: IRule = RULES[finding.rule];

    return (
      options.category === Category.API ||
      rule.category === Category.WIRE ||
      rule.category === HTTP_CATEGORY
    );
  });

  return sortFindings(
    kept.map((finding) => {
      return {
        ...diagnosticOf(finding.rule, {
          message: finding.message,
          place: { ...options.placeOf(finding.pointer), pointer: finding.pointer },
        }),
        subject: finding.subject,
      };
    })
  );
};
