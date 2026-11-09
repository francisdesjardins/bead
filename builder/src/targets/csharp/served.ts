// ── Served ────────────────────────────────────────────────────────────────────

// What the C# target prints for an output whose server names its transports (decision 0048): one
// `BeadServed.cs`, beside its route table's place, the first service's file, in its namespace,
// `ServedProcedures`, a property each transport, its key in Pascal case, in the order `beadc.yaml`
// writes them, each list the option `Procedures` of a server transport; and the contract with the
// runtime, 8, which that option needs. The same data the TypeScript target writes, in this
// language.

// dependencies

import type { ITransportCut } from '../../model/selection.ts';

// constants

/** The file an output whose server names its transports writes their procedures in. */
export const SERVED_FILE = 'BeadServed.cs';

const INDENT = '    ';
const ADDRESSES = 'global::System.Collections.Generic.IReadOnlyList<global::Bead.ProcedureAddress>';

// helpers

const upperFirst = (name: string): string => {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
};

// definition

/** Prints `BeadServed.cs` as lines of C#, after its header: each transport's addresses, and the contract. */
export const printCSharpServed = (details: {
  readonly transports: readonly ITransportCut[];
  readonly namespace: string;
}): string[] => {
  return [
    '#nullable enable',
    ...(details.namespace === '' ? [] : ['', `namespace ${details.namespace};`]),
    '',
    '/// <summary>',
    '/// The procedures each transport of the server takes, by the key <c>beadc.yaml</c> gives it: the',
    "/// option <c>Procedures</c> of the server transport it is handed to, or of a broker's name",
    '/// (decision 0048). A request to any other is answered as one to no resolver (spec 9.11).',
    '/// </summary>',
    'public static class ServedProcedures',
    '{',
    ...details.transports.flatMap(({ key, addresses }, at) => {
      const names = addresses
        .map((address) => {
          return `<c>${address.name}</c>`;
        })
        .join(', ');

      return [
        ...(at === 0 ? [] : ['']),
        `${INDENT}/// <summary>The procedures the transport <c>${key}</c> takes: ${addresses.length === 0 ? 'none' : names}.</summary>`,
        ...(addresses.length === 0
          ? [`${INDENT}public static ${ADDRESSES} ${upperFirst(key)} { get; } = [];`]
          : [
              `${INDENT}public static ${ADDRESSES} ${upperFirst(key)} { get; } =`,
              `${INDENT}[`,
              ...addresses.map((address) => {
                return `${INDENT}${INDENT}new(${String(address.serviceId)}, ${String(address.procedureId)}),`;
              }),
              `${INDENT}];`,
            ]),
      ];
    }),
    '}',
    '',
    '// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here',
    'file static class GeneratedCodeContract',
    '{',
    '    private const bool Supported = global::Bead.GeneratedCode.SupportsVersion8;',
    '}',
    '',
  ];
};
