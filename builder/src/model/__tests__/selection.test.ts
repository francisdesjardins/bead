import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint } from '../blueprint.ts';
import {
  cutOf,
  SELECTOR,
  type Selections,
  selectionFindingsOf,
  selectionOf,
} from '../selection.ts';

const SUBSETS = new URL('../../../test/golden/subsets.blueprint.json', import.meta.url);

const blueprint = (): IBlueprint => {
  return JSON.parse(readFileSync(SUBSETS, 'utf8')) as IBlueprint;
};

// what `procedures` selects of the blueprint, as `Service/procedure`
const namesOf = (procedures: Selections | undefined): string[] => {
  const every = blueprint().services.flatMap((service) => {
    return service.procedures.map((procedure) => {
      return { service, procedure };
    });
  });

  return selectionOf(procedures, every).map(({ service, procedure }) => {
    return `${service.serviceName}/${procedure.procedureName}`;
  });
};

test('a selection holds a procedure include names, of a kind and a level it lists, that no exclude names; a list holds what any holds, [] none', () => {
  expect(namesOf(undefined)).toHaveLength(7);
  expect(namesOf([])).toEqual([]);
  expect(namesOf([{ include: ['Shop/*'], exclude: ['Shop/audit', 'Shop/placeOrder'] }])).toEqual([
    'Shop/cancelOrder',
    'Shop/listOrders',
    'Shop/watchOrders',
    'Shop/refreshCatalogue',
  ]);
  expect(namesOf([{ kind: ['notifies', 'command'] }])).toEqual([
    'Shop/watchOrders',
    'Shop/refreshCatalogue',
  ]);
  expect(namesOf([{ idempotencyLevel: ['IDEMPOTENT'] }])).toEqual([
    'Shop/listOrders',
    'Shop/watchOrders',
  ]);
  expect(
    namesOf([{ include: ['Shop/*'], idempotencyLevel: ['IDEMPOTENCY_UNKNOWN'], kind: ['request'] }])
  ).toEqual(['Shop/placeOrder', 'Shop/cancelOrder', 'Shop/audit']);
  expect(namesOf([{ include: ['Auth/signUp'] }, { include: ['Shop/audit'] }])).toEqual([
    'Shop/audit',
    'Auth/signUp',
  ]);
  // * names as the blueprint writes them: 16.6 folds them to one, a selector does not
  expect(namesOf([{ include: ['shop/*', 'Shop/ListOrders'] }])).toEqual([]);
});

test("a selector's form is a service, /, and a procedure or *", () => {
  for (const selector of ['Shop/*', 'Shop/placeOrder', 'hello.v1.HelloService/SayHello']) {
    expect(SELECTOR.test(selector), selector).toBe(true);
  }

  for (const selector of ['Shop', 'Shop/', '/placeOrder', 'Shop/a/b', 'Shop/*x', 'Shop/ place']) {
    expect(SELECTOR.test(selector), selector).toBe(false);
  }
});

test('the cut holds the union every side selects, each side its pick, the gateway its view and each transport its addresses, a service none selects left out', () => {
  const cut = cutOf(blueprint(), {
    server: {
      procedures: [{ include: ['Shop/placeOrder', 'Shop/watchOrders', 'Shop/refreshCatalogue'] }],
      transports: [{ key: 'webSocket' }, { key: 'none', procedures: [] }],
    },
    client: { procedures: [{ include: ['Shop/audit'] }] },
    gateway: { procedures: [{ idempotencyLevel: ['IDEMPOTENT'] }] },
  });

  expect(
    cut.blueprint.services.map((service) => {
      return [
        service.serviceName,
        service.procedures.map((procedure) => {
          return procedure.procedureName;
        }),
      ];
    })
  ).toEqual([['Shop', ['placeOrder', 'listOrders', 'watchOrders', 'refreshCatalogue', 'audit']]]);
  expect([...(cut.served?.get('Shop') ?? [])]).toEqual([
    'placeOrder',
    'watchOrders',
    'refreshCatalogue',
  ]);
  expect([...(cut.called?.get('Shop') ?? [])]).toEqual(['audit']);
  expect(
    cut.gateway?.services.flatMap((service) => {
      return service.procedures.map((procedure) => {
        return procedure.procedureName;
      });
    })
  ).toEqual(['listOrders', 'watchOrders']);
  // * a transport takes requests and procedures that notify alone: refreshCatalogue is a command
  expect(cut.transports).toEqual([
    {
      key: 'webSocket',
      addresses: [
        { serviceId: 1, procedureId: 1, name: 'Shop/placeOrder' },
        { serviceId: 1, procedureId: 4, name: 'Shop/watchOrders' },
      ],
    },
    { key: 'none', addresses: [] },
  ]);
});

test('an output that names neither server nor client holds both whole, and one that names one holds that one alone', () => {
  const whole = cutOf(blueprint(), {});
  const client = cutOf(blueprint(), { client: {} });

  expect(whole.blueprint).toEqual(blueprint());
  expect([...(whole.served?.keys() ?? [])]).toEqual(['Shop', 'Auth']);
  expect([...(whole.called?.keys() ?? [])]).toEqual(['Shop', 'Auth']);
  expect(whole).not.toHaveProperty('gateway');
  expect(whole).not.toHaveProperty('transports');
  expect(client).not.toHaveProperty('served');
  expect(client.called?.get('Shop')?.size).toBe(6);
});

test("the findings of an output's selections name each by its key", () => {
  expect(
    selectionFindingsOf(blueprint(), {
      sides: { client: { procedures: [{ include: ['Shop/placeorder'] }] } },
      key: 'outputs[3]',
    })
  ).toEqual([
    {
      rule: 'SELECTOR_UNMATCHED',
      message:
        'outputs[3].client.procedures[0].include[0]: Shop/placeorder names no procedure of the blueprint: Shop/placeOrder?',
    },
    {
      rule: 'SELECTION_EMPTY',
      message: 'outputs[3].client.procedures selects no procedure: write procedures: [] for none',
    },
  ]);
  expect(selectionFindingsOf(blueprint(), { sides: {}, key: 'outputs[0]' })).toEqual([]);
});
