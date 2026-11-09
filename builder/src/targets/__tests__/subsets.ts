// ── Subsets ───────────────────────────────────────────────────────────────────

// The goldens' split output, which both targets write from test/golden/subsets.blueprint.json, in
// a folder of their own under a namespace of their own (decision 0048): Shop's orders served, its
// readers called, its readers' routes a gateway's, three transports, one of them taking none; Auth,
// which no side selects, left out.

// dependencies

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { documentOf } from '../../openapi/document.ts';
import type { IBlueprint } from '../../model/blueprint.ts';
import { cutOf, type ICut, type ISides } from '../../model/selection.ts';
import type { IHttpInput, ITargetInput } from '../target.ts';

// constants

/** The subsets' blueprint, under the goldens. */
export const SUBSETS_BLUEPRINT = fileURLToPath(
  new URL('../../../test/golden/subsets.blueprint.json', import.meta.url)
);

/** The goldens' folder of the split output, under each target's. */
export const SUBSETS_GOLDEN = 'subsets/';

/** The C# namespace of the split output's services. */
export const SUBSETS_NAMESPACE = 'Bead.Subsets.V1';

/** What the split output's beadc.yaml names. */
export const SUBSETS_SIDES: ISides = {
  server: {
    procedures: [
      {
        include: [
          'Shop/placeOrder',
          'Shop/cancelOrder',
          'Shop/watchOrders',
          'Shop/refreshCatalogue',
        ],
      },
    ],
    transports: [
      { key: 'webSocket' },
      { key: 'orders', procedures: [{ include: ['Shop/placeOrder', 'Shop/cancelOrder'] }] },
      { key: 'none', procedures: [] },
    ],
  },
  client: {
    procedures: [
      { include: ['Shop/listOrders', 'Shop/audit', 'Shop/watchOrders', 'Shop/refreshCatalogue'] },
    ],
  },
  gateway: { procedures: [{ include: ['Shop/*'], idempotencyLevel: ['IDEMPOTENT'] }] },
};

// definition

/** The split output's input, its cut, and what its gateway's route table holds. */
export const subsetsOf = (): {
  readonly input: ITargetInput;
  readonly cut: ICut;
  readonly http: IHttpInput;
} => {
  const blueprint = JSON.parse(readFileSync(SUBSETS_BLUEPRINT, 'utf8')) as IBlueprint;
  const cut = cutOf(blueprint, SUBSETS_SIDES);

  return {
    input: { blueprint, sources: { blueprint: 'test/golden/subsets.blueprint.json' }, cut },
    cut,
    http: { prefix: '/api', document: documentOf(cut.gateway ?? cut.blueprint) },
  };
};
