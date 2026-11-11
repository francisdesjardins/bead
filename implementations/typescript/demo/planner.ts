// ── Demo planner ─────────────────────────────────────────────────────────────

// The Packages tab's core: a blueprint cut into packages, each an output of `beadc.yaml`, by the
// builder's own code (decision 0048). Each package's sides become the `ISides` of `selection.ts`;
// `cutOf` gives what each of its classes holds and `selectionFindingsOf` what `generate` refuses of
// it; its `outputs` are written by `yaml`, then read back by `parseConfig`, whose refusal is
// beadc's own words. A folder and a transport's key are derived from what a package holds, never
// from its place in the list, so removing one renames no other. What depends on the disk, `source`
// and the `.proto` roots, stays `beadc generate`'s.

// dependencies

import { Document, isScalar, visit } from 'yaml';
import { type IConfig, parseConfig } from '../../../builder/src/config.ts';
import { InputError } from '../../../builder/src/diagnostics.ts';
import type {
  HttpMethod,
  IBlueprint,
  IProcedureEntry,
  IProtoSource,
  IServiceEntry,
  ProcedureKind,
} from '../../../builder/src/model/blueprint.ts';
import { type IServedRoute, servedRoutesOf } from '../../../builder/src/model/routes.ts';
import {
  cutOf,
  type ICut,
  type IdempotencyLevelName,
  type ISelection,
  type ISelectionFinding,
  type ISides,
  type Selections,
  selectionFindingsOf,
} from '../../../builder/src/model/selection.ts';
import { posixPath } from './posix-path';

// types

/** A package's language, as `beadc.yaml`'s `language` names it. */
export type Language = 'typescript' | 'csharp';

/** What a side holds: every procedure it can, its selections', or none. */
export type HoldingMode = 'all' | 'pick' | 'none';

/** A transport a server takes, from which the key it is handed its procedures under is derived. */
export type TransportType = keyof typeof TRANSPORT_TYPES;

/** One selection as the page edits it: a list left empty is a key `beadc.yaml` leaves out. */
export interface IPlannedSelection {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly kind: readonly ProcedureKind[];
  readonly idempotencyLevel: readonly IdempotencyLevelName[];
}

/** A side of a package: what it holds, its selections read where `mode` is `pick`. */
export interface IPlannedSide {
  readonly mode: HoldingMode;
  readonly selections: readonly IPlannedSelection[];
}

/** A transport of a package's server, and what it takes of what the server holds. */
export interface IPlannedTransport {
  readonly type: TransportType;
  readonly side: IPlannedSide;
}

/** A package's server, and its transports in their order. */
export interface IPlannedServer extends IPlannedSide {
  readonly transports: readonly IPlannedTransport[];
}

/** A package: its language and the sides it writes; with neither server nor client, both whole. */
export interface IPackage {
  readonly language: Language;
  readonly server?: IPlannedServer;
  readonly client?: IPlannedSide;
  readonly gateway?: IPlannedSide;
}

/** One output, planned: its folder, its transports' keys, its sides, its cut and its findings. */
export interface IOutputPlan {
  readonly planned: IPackage;
  /** Its place in `outputs`, as a finding names it: `outputs[0]`. */
  readonly key: string;
  readonly folder: string;
  /** Each transport's key, in their order. */
  readonly transportKeys: readonly string[];
  readonly sides: ISides;
  readonly cut: ICut;
  readonly findings: readonly ISelectionFinding[];
  /** Its gateway's routes, none without a gateway. */
  readonly routes?: readonly IServedRoute[];
}

/** What `parseConfig` read of the planned file, or its refusal, as beadc words it. */
export type Reading = { readonly config: IConfig } | { readonly refusal: string };

/** The packages, planned over a blueprint. */
export interface IPlan {
  readonly outputs: readonly IOutputPlan[];
  /** `outputs`, as `beadc.yaml` writes them. */
  readonly yaml: string;
  readonly reading: Reading;
}

// constants

/** The transports a server can name, each by the key its first is handed under, and its name. */
export const TRANSPORT_TYPES = Object.freeze({
  webSocket: 'WebSocket',
  http: 'HTTP',
  memory: 'in memory',
  worker: 'Web Worker',
  mqtt: 'MQTT 5',
  amqp: 'AMQP 1.0',
  broker: 'another broker',
});

/** The languages a package is written in, by `beadc.yaml`'s name, and their own. */
export const LANGUAGES = Object.freeze({ typescript: 'TypeScript', csharp: 'C#' });

/** A procedure's kinds, in spec 16.11's order. */
export const KINDS: readonly ProcedureKind[] = Object.freeze(['request', 'notifies', 'command']);

/** A procedure's idempotency levels, `descriptor.proto`'s. */
export const LEVELS: readonly IdempotencyLevelName[] = Object.freeze([
  'NO_SIDE_EFFECTS',
  'IDEMPOTENT',
  'IDEMPOTENCY_UNKNOWN',
]);

/** A selection that selects every procedure, as a side picked anew starts. */
export const EMPTY_SELECTION: IPlannedSelection = Object.freeze({
  include: [],
  exclude: [],
  kind: [],
  idempotencyLevel: [],
});

/** The folder the plan is read back in, a POSIX path: no disk is read. */
export const READ_BACK_FOLDER = '/project';

/** The file around the planned `outputs` as it is read back: its `version` and a `.proto` source. */
// ! a `.proto` source, never a blueprint: a C# output of a blueprint's services names a namespace,
// which the page never asks
const READ_BACK_HEADER = 'version: 1\nsource:\n  proto: [proto]\n';

/** The blueprint's format this reader takes. */
const FORMAT = 'bead-blueprint/1';

const METHODS: readonly string[] = Object.freeze(['GET', 'PUT', 'POST', 'DELETE', 'PATCH']);
const ENCODINGS: readonly string[] = Object.freeze(['raw', 'text', 'json', 'proto']);

// helpers

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isId = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
};

const isName = (value: unknown): value is string => {
  return typeof value === 'string' && value !== '';
};

// a selection as `beadc.yaml` writes it: a list left empty is a key left out
const selectionOf = (planned: IPlannedSelection): ISelection => {
  return {
    ...(planned.include.length > 0 ? { include: planned.include } : {}),
    ...(planned.exclude.length > 0 ? { exclude: planned.exclude } : {}),
    ...(planned.kind.length > 0 ? { kind: planned.kind } : {}),
    ...(planned.idempotencyLevel.length > 0 ? { idempotencyLevel: planned.idempotencyLevel } : {}),
  };
};

// a side's `procedures`: none for every procedure, `[]` for none, or its selections
const proceduresOf = (side: IPlannedSide): { procedures?: Selections } => {
  if (side.mode === 'all') {
    return {};
  }

  return { procedures: side.mode === 'none' ? [] : side.selections.map(selectionOf) };
};

// each transport's key: its type's, then 2, 3… for a second, a third of one type
const transportKeysOf = (transports: readonly IPlannedTransport[]): string[] => {
  const counts = new Map<TransportType, number>();

  return transports.map(({ type }) => {
    const count = (counts.get(type) ?? 0) + 1;

    counts.set(type, count);

    return count === 1 ? type : `${type}${String(count)}`;
  });
};

// a package's sides, as `selection.ts` reads them
const sidesOf = (planned: IPackage, transportKeys: readonly string[]): ISides => {
  const { server, client, gateway } = planned;

  return {
    ...(server === undefined
      ? {}
      : {
          server: {
            ...proceduresOf(server),
            ...(server.transports.length === 0
              ? {}
              : {
                  transports: server.transports.map((transport, at) => {
                    return {
                      key: transportKeys[at] ?? transport.type,
                      ...proceduresOf(transport.side),
                    };
                  }),
                }),
          },
        }),
    ...(client === undefined ? {} : { client: proceduresOf(client) }),
    ...(gateway === undefined ? {} : { gateway: proceduresOf(gateway) }),
  };
};

// each package's folder, from what it writes: its language, then its first transport's key, its
// sides', or `whole`; a second of one name takes `-2`, a sibling, never one inside the other
const foldersOf = (
  packages: readonly IPackage[],
  transportKeys: readonly (readonly string[])[]
): string[] => {
  const taken = new Set<string>();

  return packages.map((planned, at) => {
    const sides = (['server', 'client', 'gateway'] as const).filter((side) => {
      return planned[side] !== undefined;
    });
    const base = `gen/${planned.language}-${transportKeys[at]?.[0] ?? (sides.join('-') || 'whole')}`;
    let folder = base;

    for (let count = 2; taken.has(folder); count += 1) {
      folder = `${base}-${String(count)}`;
    }

    taken.add(folder);

    return folder;
  });
};

// a side's `procedures`, as the YAML writes it: one selection a mapping, several a list
const proceduresYamlOf = (procedures: Selections | undefined): { procedures?: unknown } => {
  if (procedures === undefined) {
    return {};
  }

  return { procedures: procedures.length === 1 ? procedures[0] : procedures };
};

// an output as `beadc.yaml` writes it
const outputYamlOf = (plan: IOutputPlan): Record<string, unknown> => {
  const { server, client, gateway } = plan.sides;

  return {
    language: plan.planned.language,
    out: plan.folder,
    ...(server === undefined
      ? {}
      : {
          server: {
            ...proceduresYamlOf(server.procedures),
            ...(server.transports === undefined
              ? {}
              : {
                  transports: Object.fromEntries(
                    server.transports.map((transport) => {
                      return [transport.key, proceduresYamlOf(transport.procedures)];
                    })
                  ),
                }),
          },
        }),
    ...(client === undefined ? {} : { client: proceduresYamlOf(client.procedures) }),
    ...(gateway === undefined ? {} : { gateway: proceduresYamlOf(gateway.procedures) }),
  };
};

// `outputs`, each list of names on one line, however long
const yamlOf = (outputs: readonly IOutputPlan[]): string => {
  const document = new Document({ outputs: outputs.map(outputYamlOf) });

  visit(document, {
    Seq: (_key, node) => {
      if (node.items.every(isScalar)) {
        node.flow = true;
      }
    },
  });

  return document.toString({ flowCollectionPadding: false, lineWidth: 0 });
};

// the planned file read as beadc reads it, a refusal in its words
const readingOf = (yaml: string): Reading => {
  try {
    return {
      config: parseConfig(`${READ_BACK_HEADER}${yaml}`, {
        folder: READ_BACK_FOLDER,
        path: posixPath,
      }),
    };
  } catch (error) {
    if (error instanceof InputError) {
      return { refusal: error.message };
    }

    throw error;
  }
};

// a payload's binding, where one is given
const bindingOf = (given: unknown): IProcedureEntry['request'] | undefined => {
  if (!isRecord(given) || typeof given['encoding'] !== 'string') {
    return undefined;
  }

  if (!ENCODINGS.includes(given['encoding'])) {
    return undefined;
  }

  return {
    encoding: given['encoding'] as IProcedureEntry['request']['encoding'],
    ...(typeof given['message'] === 'string' ? { message: given['message'] } : {}),
  };
};

// what a procedure's options say of it over HTTP: its idempotency and its rules' methods and
// templates
const httpOf = (given: unknown, at: string): Pick<IProcedureEntry, 'http'> => {
  if (given === undefined) {
    return {};
  }

  if (!isRecord(given)) {
    throw new Error(`${at}.http is no mapping`);
  }

  const level = given['idempotencyLevel'];

  if (level !== undefined && level !== 'NO_SIDE_EFFECTS' && level !== 'IDEMPOTENT') {
    throw new Error(`${at}.http.idempotencyLevel is NO_SIDE_EFFECTS or IDEMPOTENT`);
  }

  const rules = Array.isArray(given['rules']) ? (given['rules'] as unknown[]) : [];

  return {
    http: {
      ...(level === undefined ? {} : { idempotencyLevel: level }),
      rules: rules.map((rule, index) => {
        if (
          !isRecord(rule) ||
          !METHODS.includes(String(rule['method'])) ||
          typeof rule['template'] !== 'string'
        ) {
          throw new Error(`${at}.http.rules[${String(index)}] names no method and template`);
        }

        return {
          method: rule['method'] as HttpMethod,
          template: rule['template'],
          ...(typeof rule['body'] === 'string' ? { body: rule['body'] } : {}),
          ...(typeof rule['responseBody'] === 'string'
            ? { responseBody: rule['responseBody'] }
            : {}),
        };
      }),
    },
  };
};

const procedureOf = (given: unknown, at: string): IProcedureEntry => {
  if (
    !isRecord(given) ||
    !isId(given['procedureId']) ||
    !isName(given['procedureName']) ||
    !KINDS.includes(given['procedureKind'] as ProcedureKind)
  ) {
    throw new Error(`${at} names no procedureId, procedureName and procedureKind`);
  }

  const request = bindingOf(given['request']) ?? { encoding: 'raw' };

  return {
    procedureId: given['procedureId'],
    procedureName: given['procedureName'],
    procedureKind: given['procedureKind'] as ProcedureKind,
    request,
    result: bindingOf(given['result']) ?? { encoding: 'raw' },
    admission: 'none',
    failures: [],
    ...httpOf(given['http'], at),
  };
};

const serviceOf = (given: unknown, at: string): IServiceEntry => {
  if (
    !isRecord(given) ||
    !isId(given['serviceId']) ||
    !isName(given['serviceName']) ||
    !Array.isArray(given['procedures'])
  ) {
    throw new Error(`${at} names no serviceId, serviceName and procedures`);
  }

  const proto = given['proto'];

  return {
    serviceName: given['serviceName'],
    serviceId: given['serviceId'],
    serviceRevision: isId(given['serviceRevision']) ? given['serviceRevision'] : 1,
    failures: [],
    reserved: { procedureIds: [], procedureNames: [], failureCodes: [] },
    procedures: (given['procedures'] as unknown[]).map((procedure, index) => {
      return procedureOf(procedure, `${at}.procedures[${String(index)}]`);
    }),
    ...(isRecord(proto) &&
    typeof proto['file'] === 'string' &&
    typeof proto['fullName'] === 'string'
      ? { proto: { file: proto['file'], fullName: proto['fullName'] } }
      : {}),
  };
};

// examples

// a side that holds every procedure it can, and one that holds what `include` names
const ALL: IPlannedSide = Object.freeze({ mode: 'all', selections: [EMPTY_SELECTION] });
const including = (include: readonly string[]): IPlannedSide => {
  return { mode: 'pick', selections: [{ ...EMPTY_SELECTION, include }] };
};

// a procedure of the shop, its payloads JSON: its name, its kind, and its level where it has one
const shopProcedureOf = (
  [procedureName, procedureKind, idempotencyLevel]: readonly string[],
  at: number
): Record<string, unknown> => {
  return {
    procedureId: at + 1,
    procedureName,
    procedureKind,
    request: { encoding: 'json' },
    result: { encoding: 'json' },
    ...(procedureKind === 'command'
      ? {}
      : { http: { ...(idempotencyLevel === undefined ? {} : { idempotencyLevel }), rules: [] } }),
  };
};

/**
 * A shop's blueprint, an example and no real contract: two services, every kind of procedure and
 * every idempotency level among them.
 */
export const SHOP_BLUEPRINT = Object.freeze({
  format: 'bead-blueprint/1',
  specVersion: 'example',
  services: [
    {
      serviceId: 1,
      serviceName: 'Shop',
      procedures: [
        ['getProduct', 'request', 'NO_SIDE_EFFECTS'],
        ['listProducts', 'request', 'NO_SIDE_EFFECTS'],
        ['searchProducts', 'request', 'NO_SIDE_EFFECTS'],
        ['placeOrder', 'request'],
        ['cancelOrder', 'request'],
        ['updateStock', 'request', 'IDEMPOTENT'],
        ['watchOrders', 'notifies'],
        ['refreshCatalogue', 'command'],
      ].map(shopProcedureOf),
    },
    {
      serviceId: 2,
      serviceName: 'Auth',
      procedures: [
        ['signUp', 'request'],
        ['signIn', 'request'],
        ['whoami', 'request', 'NO_SIDE_EFFECTS'],
      ].map(shopProcedureOf),
    },
  ],
});

/**
 * The shop cut three ways: a TypeScript server over WebSocket and MQTT 5, the second taking its
 * orders alone, with a gateway of its reads; a server of the orders, with a client of the shop's
 * notifications and a gateway of the shop's reads; and a C# client of the sign-up alone.
 */
export const SHOP_PACKAGES: readonly IPackage[] = Object.freeze([
  {
    language: 'typescript',
    server: {
      ...ALL,
      transports: [
        { type: 'webSocket', side: ALL },
        { type: 'mqtt', side: including(['Shop/placeOrder', 'Shop/cancelOrder']) },
      ],
    },
    gateway: {
      mode: 'pick',
      selections: [
        { ...EMPTY_SELECTION, kind: ['request'], idempotencyLevel: ['NO_SIDE_EFFECTS'] },
      ],
    },
  },
  {
    language: 'typescript',
    server: {
      ...including([
        'Shop/placeOrder',
        'Shop/cancelOrder',
        'Shop/watchOrders',
        'Shop/refreshCatalogue',
      ]),
      transports: [],
    },
    client: {
      mode: 'pick',
      selections: [{ ...EMPTY_SELECTION, include: ['Shop/*'], kind: ['notifies'] }],
    },
    gateway: {
      mode: 'pick',
      selections: [
        { ...EMPTY_SELECTION, include: ['Shop/*'], idempotencyLevel: ['NO_SIDE_EFFECTS'] },
      ],
    },
  },
  { language: 'csharp', client: including(['Auth/signUp']) },
]);

/**
 * The demo's sign-up cut two ways: a TypeScript output of both classes and a gateway, as the
 * demo's own `beadc.yaml` writes it, and a C# client.
 */
export const DEMO_PACKAGES: readonly IPackage[] = Object.freeze([
  { language: 'typescript', gateway: ALL },
  { language: 'csharp', client: ALL },
]);

// definition

/**
 * Reads `given`, a blueprint's JSON, as far as the page needs it: its services and their
 * procedures, each its ids, its name, its kind, its payloads' bindings and what it says over HTTP,
 * and its messages, which the gateway's default `GET` reads. Throws an `Error` naming what is
 * missing; every other check of a blueprint is `beadc check`'s.
 */
export const readBlueprint = (given: unknown): IBlueprint => {
  if (!isRecord(given) || given['format'] !== FORMAT) {
    throw new Error(`no blueprint: its format is ${FORMAT}`);
  }

  if (!Array.isArray(given['services']) || given['services'].length === 0) {
    throw new Error('the blueprint holds no service');
  }

  const proto = given['proto'];

  return {
    format: FORMAT,
    specVersion: typeof given['specVersion'] === 'string' ? given['specVersion'] : '',
    requires: [],
    reservedServices: { ids: [], names: [] },
    services: (given['services'] as unknown[]).map((service, index) => {
      return serviceOf(service, `services[${String(index)}]`);
    }),
    // ! its messages as given: the gateway's routes read their fields, and `beadc check` their shape
    ...(isRecord(proto) && Array.isArray(proto['messages'])
      ? { proto: { files: [], messages: proto['messages'] as IProtoSource['messages'] } }
      : {}),
  };
};

/**
 * Plans `packages` over `blueprint`: each an output, its folder, its transports' keys, its sides,
 * what each of its classes holds and what `generate` refuses of it; then `outputs` as `beadc.yaml`
 * writes them, and what `parseConfig` reads of it.
 */
export const planOf = (blueprint: IBlueprint, packages: readonly IPackage[]): IPlan => {
  const transportKeys = packages.map((planned) => {
    return transportKeysOf(planned.server?.transports ?? []);
  });
  const folders = foldersOf(packages, transportKeys);
  const outputs = packages.map((planned, at): IOutputPlan => {
    const key = `outputs[${String(at)}]`;
    const keys = transportKeys[at] ?? [];
    const sides = sidesOf(planned, keys);
    const cut = cutOf(blueprint, sides);

    return {
      planned,
      key,
      folder: folders[at] ?? '',
      transportKeys: keys,
      sides,
      cut,
      findings: selectionFindingsOf(blueprint, { sides, key }),
      ...(cut.gateway === undefined ? {} : { routes: servedRoutesOf(cut.gateway) }),
    };
  });
  const yaml = yamlOf(outputs);

  return { outputs, yaml, reading: readingOf(yaml) };
};
