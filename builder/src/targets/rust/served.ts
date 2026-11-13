// ── Served ────────────────────────────────────────────────────────────────────

// What the Rust target prints for an output whose server names its transports (decision 0048): one
// `bead_served.rs`, at the output's root, under its module `bead_served`: `SERVED_PROCEDURES`, a
// constant whose field each transport is, its key in snake case, in the order `beadc.yaml` writes
// them, each list the option `procedures` of a server transport; and the contract with the
// runtime, 8, which that option needs. The same data the other targets write, in this language.

// dependencies

import type { ITransportCut } from '../../model/selection.ts';
import { snakeIdentifierOf } from './names.ts';
import { INDENT } from './templates.ts';

// constants

/** The file an output whose server names its transports writes their procedures in. */
export const SERVED_FILE = 'bead_served.rs';

/** The module of the output's root that holds them. */
export const SERVED_MODULE = 'bead_served';

const ADDRESSES = "&'static [::bead::ProcedureAddress]";

// definition

/** Prints `bead_served.rs` as lines of Rust, after its header: each transport's addresses, and the contract. */
export const printRustServed = (details: {
  readonly transports: readonly ITransportCut[];
}): string[] => {
  const docOf = ({ key, addresses }: ITransportCut, indent: string): string => {
    const names = addresses
      .map((address) => {
        return address.name;
      })
      .join(', ');

    return `${indent}/// The procedures the transport \`${key}\` takes: ${addresses.length === 0 ? 'none' : names}.`;
  };

  return [
    '/// The procedures each transport of the server takes, by the key `beadc.yaml` gives it.',
    '///',
    "/// Each list is the option `procedures` of the server transport it is handed to, or of a broker's",
    '/// name (decision 0048). A request to any other is answered as one to no resolver (spec 9.11).',
    '#[derive(Debug, Clone, Copy)]',
    '#[non_exhaustive]',
    'pub struct ServedProcedures {',
    ...details.transports.flatMap((transport) => {
      return [
        docOf(transport, INDENT),
        `${INDENT}pub ${snakeIdentifierOf(transport.key)}: ${ADDRESSES},`,
      ];
    }),
    '}',
    '',
    '/// The procedures each transport of the server takes, by its key.',
    'pub const SERVED_PROCEDURES: ServedProcedures = ServedProcedures {',
    ...details.transports.flatMap(({ key, addresses }) => {
      const field = snakeIdentifierOf(key);

      return addresses.length === 0
        ? [`${INDENT}${field}: &[],`]
        : [
            `${INDENT}${field}: &[`,
            ...addresses.map((address) => {
              return `${INDENT}${INDENT}::bead::ProcedureAddress { service_id: ${String(address.serviceId)}, procedure_id: ${String(address.procedureId)} },`;
            }),
            `${INDENT}],`,
          ];
    }),
    '};',
    '',
    '// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here',
    'const _: bool = ::bead::GENERATED_CODE_SUPPORTS_VERSION_8;',
    '',
  ];
};
