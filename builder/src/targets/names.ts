// ── Names ─────────────────────────────────────────────────────────────────────

// The names each official target generates or reserves, by target, which NAME_TARGET refuses on
// every blueprint whatever targets a project names (decision 0022): a name is refused, never
// escaped, so a procedure's key stays the name its metrics and filters read. builder/README.md lists
// them. Beside them, C#'s names as protoc's C# generator gives them, over strings, which the C#
// target and the `.proto` half of NAME_TARGET read; and the characters no C# documentation comment
// holds, which DESCRIPTION_TARGET refuses. This module imports nothing, so `check` loads no target.

// constants

/**
 * The types a service gives, after its name, in every official target: its descriptors, its
 * catalogue, its server and its options, its client and its options, its hooks and its windows;
 * TypeScript's resolvers; and the classes C#'s server and client hold, a member a command, a
 * procedure that notifies, or its notification.
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
  'Commands',
  'Notifiers',
  'Notifications',
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

/**
 * The rpc names C#'s generated classes refuse: their own members, and `Code`, which the class of
 * failures a procedure that lists any holds, refused whatever it lists.
 */
export const C_SHARP_PROCEDURE_NAMES: ReadonlySet<string> = new Set([
  'All',
  'On',
  'Notifications',
  'Is',
  'Code',
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

/**
 * A name in Pascal case as protoc's C# generator writes one, its `UnderscoresToCamelCase` with the
 * first letter raised: each ASCII letter after an underscore, a digit or any other character raised,
 * a capital first letter kept, every character but a letter or a digit dropped, and a dot kept when
 * `periods` holds.
 */
export const pascalOf = (input: string, options: { readonly periods?: boolean } = {}): string => {
  let result = '';
  let raise = true;

  for (const character of input) {
    if (character >= 'a' && character <= 'z') {
      result += raise ? character.toUpperCase() : character;
      raise = false;
    } else if (character >= 'A' && character <= 'Z') {
      result += character;
      raise = false;
    } else if (character >= '0' && character <= '9') {
      result += character;
      raise = true;
    } else {
      raise = true;

      if (character === '.' && options.periods === true) {
        result += '.';
      }
    }
  }

  return result;
};

/**
 * A `.proto` file's C# namespace, as protoc's C# generator gives it: its `csharp_namespace` when it
 * states one, else its package in Pascal case, each part raised, `bead.messages.v1` giving
 * `Bead.Messages.V1`.
 */
export const csharpNamespaceOf = (packageName: string, csharpNamespace?: string): string => {
  return csharpNamespace === undefined || csharpNamespace === ''
    ? pascalOf(packageName, { periods: true })
    : csharpNamespace;
};

/**
 * The first character of `text` no XML document holds, raw or by reference, as XML 1.0's `Char`
 * production leaves them out: C0's controls but tab, line feed and carriage return, and U+FFFE and
 * U+FFFF. C# reads every documentation comment as XML, so no escape writes one (CS1570).
 */
export const xmlExcludedOf = (text: string): string | undefined => {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      return character;
    }
  }

  return undefined;
};
