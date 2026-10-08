// ── Names ─────────────────────────────────────────────────────────────────────

// The names each official target generates or reserves, by target, which NAME_TARGET refuses on
// every blueprint whatever targets a project names (decision 0022): a name is refused, never
// escaped, so a procedure's key stays the name its metrics and filters read. builder/README.md lists
// them.

// constants

/**
 * The types a service gives, after its name, in every official target: its descriptors, its
 * catalogue, its server and its options, its client and its options, and TypeScript's resolvers.
 */
export const CLASS_SUFFIXES: readonly string[] = Object.freeze([
  'Procedures',
  'Failures',
  'Server',
  'ServerOptions',
  'Client',
  'ClientOptions',
  'Resolvers',
  'Admissions',
  'Windows',
]);

/**
 * The procedure names TypeScript's generated client refuses: its own members, `on` and
 * `notifications`; `then`, which would make it a thenable; and the seven of `Object.prototype` a
 * procedure's name can take, which a member would shadow, or, for `constructor`, not compile.
 */
export const TYPESCRIPT_PROCEDURE_NAMES: ReadonlySet<string> = new Set([
  'on',
  'notifications',
  'then',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** The rpc names C#'s generated classes refuse: their own members. */
export const C_SHARP_PROCEDURE_NAMES: ReadonlySet<string> = new Set([
  'All',
  'On',
  'Notifications',
  'Is',
]);

/** The members every C# object holds, which no generated member may take. */
export const C_SHARP_OBJECT_MEMBERS: ReadonlySet<string> = new Set([
  'Equals',
  'GetHashCode',
  'GetType',
  'ToString',
  'MemberwiseClone',
  'ReferenceEquals',
  'Finalize',
]);

/**
 * The public types of the runtimes a generated class may not take: what `./service` exports on the
 * TypeScript side, and the public types of Bead.Core and its transports on the C# side.
 */
export const RUNTIME_TYPES: ReadonlySet<string> = new Set([
  // TypeScript, ./service
  'FailureError',
  'ProgrammerError',
  'ProcedureKind',
  // C#, Bead.Core and the transports
  'BeadHttpClient',
  'BeadHttpClientOptions',
  'CommandProcedure',
  'FailureCatalogue',
  'HttpServer',
  'HttpServerOptions',
  'HttpTransportClient',
  'HttpTransportServer',
  'Procedure',
  'RequestProcedure',
  'RouterClient',
  'RouterClientOptions',
  'RouterServer',
  'RouterServerOptions',
  'Server',
  'ServerOptions',
  'ServiceClient',
  'ServiceClientOptions',
  'ServiceManager',
  'ServiceServer',
  'ServiceServerOptions',
  'IServiceAdmissions',
  'IServiceClientOptions',
  'IServiceWindows',
  'SessionManager',
  'WebSocketClient',
  'WebSocketClientOptions',
  'WebSocketServer',
  'WebSocketServerOptions',
  'WebSocketTransportClient',
  'WebSocketTransportServer',
]);

// definition

/** The classes a service named `serviceName` gives, in every official target. */
export const classNamesOf = (serviceName: string): readonly string[] => {
  return CLASS_SUFFIXES.map((suffix) => {
    return `${serviceName}${suffix}`;
  });
};

/** A failure's C# name: its words, each its first letter kept and the others lowered, `ON_PURPOSE` `OnPurpose`. */
export const csharpNameOfFailure = (failureName: string): string => {
  return failureName
    .split('_')
    .map((word) => {
      return `${word.slice(0, 1)}${word.slice(1).toLowerCase()}`;
    })
    .join('');
};
