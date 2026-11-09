// ── Served ────────────────────────────────────────────────────────────────────

// What the TypeScript target prints for an output whose server names its transports (decision
// 0048): one `bead_served.ts` at the output's root, `SERVED_PROCEDURES`, the addresses each
// transport takes by the key `beadc.yaml` gives it, in the order it writes them, each list the
// option `procedures` of a server transport; and the contract with the runtime, 8, which that
// option needs. The same data the C# target writes, in this language.

// dependencies

import type { GeneratedFile } from '@bufbuild/protoplugin';

import type { ITransportCut } from '../../model/selection.ts';

// constants

/** The file an output whose server names its transports writes their procedures in, at its root. */
export const SERVED_FILE = 'bead_served.ts';

// definition

/** Prints `bead_served.ts`: each transport's addresses, by its key, and the contract. */
export const printServed = (
  f: GeneratedFile,
  details: { readonly transports: readonly ITransportCut[]; readonly runtime: string }
): void => {
  f.print(
    f.jsDoc(
      "The procedures each transport of the server takes, by the key beadc.yaml gives it: the option `procedures` of the server transport it is handed to, or of a broker's name (decision 0048). A request to any other is answered as one to no resolver (spec 9.11)."
    )
  );
  f.print(f.export('const', 'SERVED_PROCEDURES'), ' = Object.freeze({');

  for (const { key, addresses } of details.transports) {
    f.print(
      f.jsDoc(
        addresses.length === 0
          ? `The procedures the transport \`${key}\` takes: none.`
          : `The procedures the transport \`${key}\` takes: ${addresses
              .map((address) => {
                return address.name;
              })
              .join(', ')}.`,
        '  '
      )
    );

    if (addresses.length === 0) {
      f.print(`  ${key}: Object.freeze([]),`);
      continue;
    }

    f.print(`  ${key}: Object.freeze([`);

    for (const address of addresses) {
      f.print(
        `    Object.freeze({ serviceId: ${String(address.serviceId)}, procedureId: ${String(address.procedureId)} }),`
      );
    }

    f.print('  ]),');
  }

  f.print('});');
  f.print();
  f.print(
    '// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here'
  );
  f.print('void ', f.import('GENERATED_CODE_SUPPORTS_VERSION_8', details.runtime), ';');
};
