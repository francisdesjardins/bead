// ── Selection ─────────────────────────────────────────────────────────────────

// What an output of `beadc.yaml` holds of a blueprint (decision 0048): `server`, `client` and
// `gateway` each select procedures, and `server.transports` the procedures each transport of its
// server takes. A selection names procedures as transcoding 3.2's default route names them,
// `Service/procedure` or `Service/*`, by their Bead names (spec 16.4), never buf's fully-qualified
// `types`; holds a procedure when `include` names it or is absent, its kind is in `kind` or `kind`
// is absent, its level in `idempotencyLevel` or it is absent, and no `exclude` names it; and a list
// of selections holds what any of them holds, `[]` none. Each entry selects among what it can hold:
// a transport and the gateway among requests and procedures that notify, since neither a server's
// router nor a gateway answers a command (spec 16.11, transcoding 2.6), a transport among those its
// server holds besides. The cut is what the targets print: the union of what every side selects,
// a service none selects left out; each side's pick of each service; the gateway's view; and each
// transport's addresses. The findings are what `generate` refuses of it: SELECTOR_UNMATCHED,
// SELECTION_EMPTY and GATEWAY_EMPTY.

// dependencies

import type { RuleName } from '../rules.ts';
import type { IBlueprint, IProcedureEntry, IServiceEntry, ProcedureKind } from './blueprint.ts';

// types

/** A procedure's idempotency, `descriptor.proto`'s, `IDEMPOTENCY_UNKNOWN` where it names none. */
export type IdempotencyLevelName = 'NO_SIDE_EFFECTS' | 'IDEMPOTENT' | 'IDEMPOTENCY_UNKNOWN';

/** One selection of procedures, as `beadc.yaml` writes it. */
export interface ISelection {
  /** `Service/procedure` or `Service/*`; every procedure where absent. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly kind?: readonly ProcedureKind[];
  readonly idempotencyLevel?: readonly IdempotencyLevelName[];
}

/** What a `procedures` key holds: selections, a procedure held when any holds it; `[]`, none. */
export type Selections = readonly ISelection[];

/** A side of an output: the procedures its class holds, every one where absent. */
export interface ISide {
  readonly procedures?: Selections;
}

/** A transport of a server, by the key the application hands its procedures to it under. */
export interface ITransportSide extends ISide {
  readonly key: string;
}

/** An output's server: the procedures its class holds, and those each of its transports takes. */
export interface IServerSide extends ISide {
  /** In the order `beadc.yaml` writes them. */
  readonly transports?: readonly ITransportSide[];
}

/** What an output names of its sides: none of `server` and `client` writes both whole. */
export interface ISides {
  readonly server?: IServerSide;
  readonly client?: ISide;
  readonly gateway?: ISide;
}

/** A procedure's address: its service id and its id (spec 16.7). */
export interface IAddress {
  readonly serviceId: number;
  readonly procedureId: number;
  /** `Service/procedure`, for a comment. */
  readonly name: string;
}

/** The procedures a transport takes, by its key. */
export interface ITransportCut {
  readonly key: string;
  readonly addresses: readonly IAddress[];
}

/**
 * What an output holds of a blueprint: the union every side selects, each side's pick of each
 * service, the gateway's view and each transport's addresses.
 */
export interface ICut {
  /** The blueprint, each service with the procedures some side selects, a service none selects left out. */
  readonly blueprint: IBlueprint;
  /** The procedures its server class holds, by its service's name; none where it writes no server. */
  readonly served?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The procedures its client class holds, by its service's name; none where it writes no client. */
  readonly called?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The blueprint as its gateway sees it, of the procedures it selects; none without a gateway. */
  readonly gateway?: IBlueprint;
  /** Each transport of its server, in their order; none where `server.transports` is not given. */
  readonly transports?: readonly ITransportCut[];
}

/** What `generate` refuses of an output's selections, a rule and its message. */
export interface ISelectionFinding {
  readonly rule: Extract<RuleName, 'SELECTOR_UNMATCHED' | 'SELECTION_EMPTY' | 'GATEWAY_EMPTY'>;
  readonly message: string;
}

// a procedure of a service, as a selection reads it
interface IHeld {
  readonly service: IServiceEntry;
  readonly procedure: IProcedureEntry;
}

// constants

/** A selector's form, read before the blueprint: a service, `/`, a procedure or `*`. */
export const SELECTOR = /^[^/\s]+\/(?:\*|[^/\s*]+)$/u;

// helpers

const nameOf = (held: IHeld): string => {
  return `${held.service.serviceName}/${held.procedure.procedureName}`;
};

const levelOf = (procedure: IProcedureEntry): IdempotencyLevelName => {
  return procedure.http?.idempotencyLevel ?? 'IDEMPOTENCY_UNKNOWN';
};

const answers = (held: IHeld): boolean => {
  return held.procedure.procedureKind !== 'command';
};

// a name as spec 16.6 reads it: each ASCII upper-case letter its lower-case one
const foldedOf = (name: string): string => {
  return name.replace(/[A-Z]/gu, (letter) => {
    return letter.toLowerCase();
  });
};

// whether `selector` names `held`: its service and its procedure, or its service and `*`
const names = (selector: string, held: IHeld): boolean => {
  const [service, procedure] = selector.split('/');

  return (
    service === held.service.serviceName &&
    (procedure === '*' || procedure === held.procedure.procedureName)
  );
};

const holdsOf = (selection: ISelection, held: IHeld): boolean => {
  const { include, exclude, kind, idempotencyLevel } = selection;

  return (
    (include === undefined ||
      include.some((selector) => {
        return names(selector, held);
      })) &&
    (kind === undefined || kind.includes(held.procedure.procedureKind)) &&
    (idempotencyLevel === undefined || idempotencyLevel.includes(levelOf(held.procedure))) &&
    !(exclude ?? []).some((selector) => {
      return names(selector, held);
    })
  );
};

const everyOf = (blueprint: IBlueprint): IHeld[] => {
  return blueprint.services.flatMap((service) => {
    return service.procedures.map((procedure) => {
      return { service, procedure };
    });
  });
};

// the Bead form of a selector that names nothing, where one is near: a service by its `.proto` full
// name, or a name spec 16.6 folds to one
const nearOf = (selector: string, blueprint: IBlueprint): string | undefined => {
  const [service = '', procedure = ''] = selector.split('/');
  const found = blueprint.services.find((each) => {
    return (
      each.proto?.fullName === service ||
      foldedOf(each.serviceName) === foldedOf(service) ||
      (each.proto !== undefined && foldedOf(each.proto.fullName) === foldedOf(service))
    );
  });

  if (found === undefined) {
    return undefined;
  }

  if (procedure === '*') {
    return `${found.serviceName}/*`;
  }

  const named = found.procedures.find((each) => {
    return foldedOf(each.procedureName) === foldedOf(procedure);
  });

  return named === undefined ? undefined : `${found.serviceName}/${named.procedureName}`;
};

// definition

/** The procedures `procedures` selects among `among`: every one where absent, none for `[]`. */
export const selectionOf = <Held extends IHeld>(
  procedures: Selections | undefined,
  among: readonly Held[]
): Held[] => {
  if (procedures === undefined) {
    return [...among];
  }

  return among.filter((held) => {
    return procedures.some((selection) => {
      return holdsOf(selection, held);
    });
  });
};

// the blueprint with only the procedures `held` holds, a service it holds none of left out
const viewOf = (blueprint: IBlueprint, held: readonly IHeld[]): IBlueprint => {
  const kept = new Set(held.map(nameOf));

  return {
    ...blueprint,
    services: blueprint.services.flatMap((service) => {
      const procedures = service.procedures.filter((procedure) => {
        return kept.has(`${service.serviceName}/${procedure.procedureName}`);
      });

      return procedures.length === 0 ? [] : [{ ...service, procedures }];
    }),
  };
};

// each service's pick, by its name, of a service the union holds
const picksOf = (held: readonly IHeld[]): ReadonlyMap<string, ReadonlySet<string>> => {
  const picks = new Map<string, Set<string>>();

  for (const { service, procedure } of held) {
    const pick = picks.get(service.serviceName) ?? new Set<string>();

    pick.add(procedure.procedureName);
    picks.set(service.serviceName, pick);
  }

  return picks;
};

// what each side holds of `blueprint`, before any finding: the server's, the client's, the
// gateway's, and each transport's, cut from what the server holds
const heldOf = (blueprint: IBlueprint, sides: ISides) => {
  const every = everyOf(blueprint);
  const whole = sides.server === undefined && sides.client === undefined;
  const server =
    whole || sides.server !== undefined ? selectionOf(sides.server?.procedures, every) : undefined;
  const client =
    whole || sides.client !== undefined ? selectionOf(sides.client?.procedures, every) : undefined;
  const gateway =
    sides.gateway === undefined
      ? undefined
      : selectionOf(sides.gateway.procedures, every.filter(answers));
  const transports = sides.server?.transports?.map((transport) => {
    return {
      transport,
      held: selectionOf(transport.procedures, (server ?? []).filter(answers)),
    };
  });

  return { every, server, client, gateway, transports };
};

/** What `sides` holds of `blueprint`, as the targets print it. */
export const cutOf = (blueprint: IBlueprint, sides: ISides): ICut => {
  const { server, client, gateway, transports } = heldOf(blueprint, sides);
  const union = [...(server ?? []), ...(client ?? []), ...(gateway ?? [])];

  return {
    blueprint: viewOf(blueprint, union),
    ...(server === undefined ? {} : { served: picksOf(server) }),
    ...(client === undefined ? {} : { called: picksOf(client) }),
    ...(gateway === undefined ? {} : { gateway: viewOf(blueprint, gateway) }),
    ...(transports === undefined
      ? {}
      : {
          transports: transports.map(({ transport, held }) => {
            return {
              key: transport.key,
              addresses: held.map((each) => {
                return {
                  serviceId: each.service.serviceId,
                  procedureId: each.procedure.procedureId,
                  name: nameOf(each),
                };
              }),
            };
          }),
        }),
  };
};

/**
 * What `generate` refuses of `sides`, the selections of the output `key` names, against
 * `blueprint`: each `include` or `exclude` that names no service, no procedure of it, or one its
 * entry cannot hold, SELECTOR_UNMATCHED, with the Bead form where one is near; each `procedures`
 * of selections that select none, SELECTION_EMPTY, `[]` written being no slip; and a gateway that
 * selects no request and no procedure that notifies, GATEWAY_EMPTY.
 */
export const selectionFindingsOf = (
  blueprint: IBlueprint,
  details: { readonly sides: ISides; readonly key: string }
): ISelectionFinding[] => {
  const { sides, key } = details;
  const { every, server } = heldOf(blueprint, sides);
  const findings: ISelectionFinding[] = [];
  // the selectors of one entry, held to what it can hold, and its selections to selecting one
  const entryOf = (
    procedures: Selections | undefined,
    entry: { readonly at: string; readonly among: readonly IHeld[]; readonly cannot?: string }
  ): void => {
    (procedures ?? []).forEach((selection, index) => {
      for (const list of ['include', 'exclude'] as const) {
        (selection[list] ?? []).forEach((selector, at) => {
          const place = `${entry.at}.procedures[${String(index)}].${list}[${String(at)}]`;

          if (
            entry.among.some((held) => {
              return names(selector, held);
            })
          ) {
            return;
          }

          const known = every.some((held) => {
            return names(selector, held);
          });
          const near = known ? undefined : nearOf(selector, blueprint);

          findings.push({
            rule: 'SELECTOR_UNMATCHED',
            message: known
              ? `${place}: ${selector} names ${entry.cannot ?? 'nothing its entry holds'}`
              : `${place}: ${selector} names no procedure of the blueprint${near === undefined ? '' : `: ${near}?`}`,
          });
        });
      }
    });

    if (
      procedures !== undefined &&
      procedures.length > 0 &&
      selectionOf(procedures, entry.among).length === 0 &&
      entry.at !== `${key}.gateway`
    ) {
      findings.push({
        rule: 'SELECTION_EMPTY',
        message: `${entry.at}.procedures selects no procedure: write procedures: [] for none`,
      });
    }
  };

  if (sides.server !== undefined) {
    entryOf(sides.server.procedures, { at: `${key}.server`, among: every });

    for (const transport of sides.server.transports ?? []) {
      entryOf(transport.procedures, {
        at: `${key}.server.transports.${transport.key}`,
        among: (server ?? []).filter(answers),
        cannot:
          'no request and no procedure that notifies its server holds: a transport takes neither a command nor a procedure its server does not hold',
      });
    }
  }

  if (sides.client !== undefined) {
    entryOf(sides.client.procedures, { at: `${key}.client`, among: every });
  }

  if (sides.gateway !== undefined) {
    const among = every.filter(answers);

    entryOf(sides.gateway.procedures, {
      at: `${key}.gateway`,
      among,
      cannot: 'a command, which a gateway does not answer (transcoding 2.6)',
    });

    if (selectionOf(sides.gateway.procedures, among).length === 0) {
      findings.push({
        rule: 'GATEWAY_EMPTY',
        message: `${key}.gateway selects no request and no procedure that notifies: it would serve no route; take gateway out of it, or select one`,
      });
    }
  }

  return findings;
};
