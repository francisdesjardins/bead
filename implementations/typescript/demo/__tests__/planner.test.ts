import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { IBlueprint } from '../../../../builder/src/model/blueprint.ts';
import {
  DEMO_PACKAGES,
  EMPTY_SELECTION,
  inLanguage,
  type IPackage,
  type IPlan,
  type IPlannedSide,
  planOf,
  readBlueprint,
  READ_BACK_FOLDER,
  SHOP_BLUEPRINT,
  SHOP_PACKAGES,
  TRANSPORT_TYPES,
  TRANSPORTS_OF,
} from '../planner';

// helpers

const including = (include: readonly string[]): IPlannedSide => {
  return { mode: 'pick', selections: [{ ...EMPTY_SELECTION, include }] };
};

const ALL: IPlannedSide = { mode: 'all', selections: [EMPTY_SELECTION] };

const demoBlueprint = async (): Promise<IBlueprint> => {
  return readBlueprint(
    JSON.parse(await readFile(new URL('../gen/demo.blueprint.json', import.meta.url), 'utf8'))
  );
};

/** What `parseConfig` read back of each output: its language, its folder and its sides. */
const readBackOf = (plan: IPlan) => {
  if (!('config' in plan.reading)) {
    throw new Error(`beadc refused the plan: ${plan.reading.refusal}`);
  }

  return (plan.reading.config.outputs ?? []).map((output) => {
    return {
      language: output.language,
      out: output.out,
      ...(output.server === undefined ? {} : { server: output.server }),
      ...(output.client === undefined ? {} : { client: output.client }),
      ...(output.gateway === undefined
        ? {}
        : {
            gateway:
              output.gateway.procedures === undefined
                ? {}
                : { procedures: output.gateway.procedures },
          }),
    };
  });
};

/** What each output was planned: its language, its folder under the folder read back, its sides. */
const plannedOf = (plan: IPlan) => {
  return plan.outputs.map((output) => {
    return {
      language: output.planned.language,
      out: `${READ_BACK_FOLDER}/${output.folder}`,
      ...output.sides,
    };
  });
};

const findingsOf = (plan: IPlan) => {
  return plan.outputs.flatMap((output) => {
    return output.findings;
  });
};

const refusalsOf = (plan: IPlan) => {
  return plan.outputs.flatMap((output) => {
    return output.refusals;
  });
};

/** A blueprint whose procedures are named as the methods a Rust HTTP client holds already. */
const CLIENT_METHODS_BLUEPRINT = Object.freeze({
  format: 'bead-blueprint/1',
  services: [
    {
      serviceId: 1,
      serviceName: 'Doc',
      procedures: [
        { procedureId: 1, procedureName: 'clone', procedureKind: 'request' },
        { procedureId: 2, procedureName: 'fmt', procedureKind: 'notifies' },
        { procedureId: 3, procedureName: 'new', procedureKind: 'command' },
        { procedureId: 4, procedureName: 'read', procedureKind: 'request' },
      ],
    },
  ],
});

// definition

test.describe('planOf', () => {
  test('cuts the shop three ways, and parseConfig reads back the outputs planned', () => {
    const plan = planOf(readBlueprint(SHOP_BLUEPRINT), SHOP_PACKAGES);

    expect(
      plan.outputs.map(({ folder }) => {
        return folder;
      })
    ).toEqual([
      'gen/typescript-webSocket',
      'gen/typescript-server-client-gateway',
      'gen/csharp-client',
    ]);
    expect(readBackOf(plan)).toEqual(plannedOf(plan));
    expect(findingsOf(plan)).toEqual([]);

    // * the MQTT 5 transport takes the two orders it names; WebSocket every request and procedure
    // that notifies of its server, the command left out
    const [first] = plan.outputs;

    expect(first?.cut.transports).toEqual([
      {
        key: 'webSocket',
        addresses: [1, 2, 3, 4, 5, 6, 7]
          .map((procedureId) => {
            return expect.objectContaining({ serviceId: 1, procedureId });
          })
          .concat(
            [1, 2, 3].map((procedureId) => {
              return expect.objectContaining({ serviceId: 2, procedureId });
            })
          ),
      },
      {
        key: 'mqtt',
        addresses: [
          { serviceId: 1, procedureId: 4, name: 'Shop/placeOrder' },
          { serviceId: 1, procedureId: 5, name: 'Shop/cancelOrder' },
        ],
      },
    ]);
    expect(
      first?.routes?.map(({ method, template }) => {
        return `${method} ${template}`;
      })
    ).toEqual([
      'POST /api/Shop/getProduct',
      'POST /api/Shop/listProducts',
      'POST /api/Shop/searchProducts',
      'POST /api/Auth/whoami',
    ]);
    expect(plan.yaml).toContain(
      '        mqtt:\n          procedures:\n            include: [Shop/placeOrder, Shop/cancelOrder]\n'
    );
  });

  test('cuts the shop otherwise, each cut read back as planned', () => {
    const cuts: readonly (readonly IPackage[])[] = [
      // a server alone over two WebSockets, the second taking the shop's reads, none over HTTP
      [
        {
          language: 'typescript',
          server: {
            ...ALL,
            transports: [
              { type: 'webSocket', side: ALL },
              {
                type: 'webSocket',
                side: {
                  mode: 'pick',
                  selections: [{ ...EMPTY_SELECTION, idempotencyLevel: ['NO_SIDE_EFFECTS'] }],
                },
              },
              { type: 'http', side: { mode: 'none', selections: [EMPTY_SELECTION] } },
            ],
          },
        },
      ],
      // two selections of the client, either holding, and a C# gateway of its own
      [
        {
          language: 'csharp',
          client: {
            mode: 'pick',
            selections: [
              { ...EMPTY_SELECTION, include: ['Auth/*'], exclude: ['Auth/whoami'] },
              { ...EMPTY_SELECTION, kind: ['notifies', 'command'] },
            ],
          },
        },
        { language: 'csharp', gateway: ALL },
      ],
    ];

    for (const packages of cuts) {
      const plan = planOf(readBlueprint(SHOP_BLUEPRINT), packages);

      expect(readBackOf(plan)).toEqual(plannedOf(plan));
      expect(findingsOf(plan)).toEqual([]);
    }

    const [server] = planOf(readBlueprint(SHOP_BLUEPRINT), cuts[0] ?? []).outputs;

    expect(server?.transportKeys).toEqual(['webSocket', 'webSocket2', 'http']);
    expect(
      server?.cut.transports?.[1]?.addresses.map(({ name }) => {
        return name;
      })
    ).toEqual(['Shop/getProduct', 'Shop/listProducts', 'Shop/searchProducts', 'Auth/whoami']);
    expect(server?.cut.transports?.[2]?.addresses).toEqual([]);

    const [client] = planOf(readBlueprint(SHOP_BLUEPRINT), cuts[1] ?? []).outputs;

    expect([...(client?.cut.called ?? new Map())]).toEqual([
      ['Shop', new Set(['watchOrders', 'refreshCatalogue'])],
      ['Auth', new Set(['signUp', 'signIn'])],
    ]);
  });

  test('writes a Rust output as beadc reads it', () => {
    const plan = planOf(readBlueprint(SHOP_BLUEPRINT), [
      {
        language: 'rust',
        server: {
          ...ALL,
          transports: [
            { type: 'webSocket', side: ALL },
            { type: 'mqtt', side: including(['Shop/placeOrder']) },
          ],
        },
        client: ALL,
        gateway: ALL,
      },
    ]);

    expect(plan.outputs[0]?.folder).toBe('gen/rust-webSocket');
    expect(plan.yaml).toContain('  - language: rust\n    out: gen/rust-webSocket\n');
    expect(readBackOf(plan)).toEqual(plannedOf(plan));
    expect(findingsOf(plan)).toEqual([]);
    expect(refusalsOf(plan)).toEqual([]);

    // * beadc's default for a Rust output: the messages generated beside its services
    expect('config' in plan.reading ? plan.reading.config.outputs?.[0]?.messages : undefined).toBe(
      'generate'
    );
  });

  test('derives Rust transports’ keys that are each their own field, which parseConfig refuses otherwise', () => {
    const transports = TRANSPORTS_OF.rust.flatMap((type) => {
      return [
        { type, side: ALL },
        { type, side: ALL },
      ];
    });
    const plan = planOf(readBlueprint(SHOP_BLUEPRINT), [
      { language: 'rust', server: { ...ALL, transports } },
    ]);

    expect(plan.outputs[0]?.transportKeys).toEqual([
      'webSocket',
      'webSocket2',
      'http',
      'http2',
      'memory',
      'memory2',
      'mqtt',
      'mqtt2',
      'broker',
      'broker2',
    ]);
    expect(readBackOf(plan)).toEqual(plannedOf(plan));
  });

  test('refuses a Rust gateway’s procedure named as a method its HTTP client holds, as beadc words it', () => {
    const blueprint = readBlueprint(CLIENT_METHODS_BLUEPRINT);
    const refused = planOf(blueprint, [{ language: 'rust', gateway: ALL }]);

    // * a command takes any name, since no HTTP client calls it
    expect(refusalsOf(refused)).toEqual([
      "the procedure Doc/clone is the method clone of DocHttpClient in Rust, which the client holds already: rename the procedure, or take it out of the output's gateway",
      "the procedure Doc/fmt is the method fmt of DocHttpClient in Rust, which the client holds already: rename the procedure, or take it out of the output's gateway",
    ]);
    expect('config' in refused.reading).toBe(true);

    // a gateway without them, another language's and a Rust output with no gateway: nothing refused
    const others = planOf(blueprint, [
      { language: 'rust', gateway: including(['Doc/read', 'Doc/new']) },
      { language: 'typescript', gateway: ALL },
      { language: 'rust', client: ALL },
    ]);

    expect(refusalsOf(others)).toEqual([]);
  });

  test('offers each language the transports it has', () => {
    expect(TRANSPORTS_OF.typescript).toEqual(Object.keys(TRANSPORT_TYPES));
    expect(TRANSPORTS_OF.csharp).toEqual(['webSocket', 'http', 'memory', 'mqtt', 'amqp', 'broker']);
    expect(TRANSPORTS_OF.rust).toEqual(['webSocket', 'http', 'memory', 'mqtt', 'broker']);

    // * a package moved to another language keeps the transports it has there, in their order
    const planned: IPackage = {
      language: 'typescript',
      server: {
        ...ALL,
        transports: [
          { type: 'worker', side: ALL },
          { type: 'webSocket', side: ALL },
          { type: 'amqp', side: including(['Shop/placeOrder']) },
          { type: 'mqtt', side: ALL },
        ],
      },
      client: ALL,
    };

    expect(inLanguage(planned, 'csharp')).toEqual({
      ...planned,
      language: 'csharp',
      server: {
        ...ALL,
        transports: [
          { type: 'webSocket', side: ALL },
          { type: 'amqp', side: including(['Shop/placeOrder']) },
          { type: 'mqtt', side: ALL },
        ],
      },
    });
    expect(inLanguage(planned, 'rust').server?.transports).toEqual([
      { type: 'webSocket', side: ALL },
      { type: 'mqtt', side: ALL },
    ]);
    expect(inLanguage({ language: 'csharp', client: ALL }, 'rust')).toEqual({
      language: 'rust',
      client: ALL,
    });
  });

  test('derives each folder from what its package writes: a package removed renames no other', () => {
    const packages: readonly IPackage[] = [
      { language: 'typescript', client: ALL },
      { language: 'typescript', client: including(['Shop/getProduct']) },
      { language: 'typescript', client: including(['Auth/signIn']) },
      { language: 'csharp' },
    ];
    const folders = (each: readonly IPackage[]) => {
      return planOf(readBlueprint(SHOP_BLUEPRINT), each).outputs.map(({ folder }) => {
        return folder;
      });
    };

    expect(folders(packages)).toEqual([
      'gen/typescript-client',
      'gen/typescript-client-2',
      'gen/typescript-client-3',
      'gen/csharp-whole',
    ]);
    expect(
      folders(
        [packages[0], packages[1], packages[3]].filter((each) => {
          return each !== undefined;
        })
      )
    ).toEqual(['gen/typescript-client', 'gen/typescript-client-2', 'gen/csharp-whole']);
  });

  test('finds a selection that selects nothing SELECTION_EMPTY, as selectionFindingsOf words it', () => {
    const plan = planOf(readBlueprint(SHOP_BLUEPRINT), [
      {
        language: 'typescript',
        client: {
          mode: 'pick',
          selections: [{ ...EMPTY_SELECTION, include: ['Auth/*'], kind: ['notifies'] }],
        },
      },
    ]);

    expect(findingsOf(plan)).toEqual([
      {
        rule: 'SELECTION_EMPTY',
        message: 'outputs[0].client.procedures selects no procedure: write procedures: [] for none',
      },
    ]);
    // beadc reads it, and refuses it as it generates
    expect(readBackOf(plan)).toEqual(plannedOf(plan));
  });

  test('finds a selector of what another output holds SELECTOR_UNMATCHED, as selectionFindingsOf words it', () => {
    const plan = planOf(readBlueprint(SHOP_BLUEPRINT), [
      { language: 'typescript', client: ALL },
      {
        language: 'typescript',
        server: {
          ...including(['Auth/*']),
          transports: [{ type: 'webSocket', side: including(['Shop/getProduct']) }],
        },
      },
    ]);

    expect(findingsOf(plan)).toEqual([
      {
        rule: 'SELECTOR_UNMATCHED',
        message:
          'outputs[1].server.transports.webSocket.procedures[0].include[0]: Shop/getProduct names no request and no procedure that notifies its server holds: a transport takes neither a command nor a procedure its server does not hold',
      },
      {
        rule: 'SELECTION_EMPTY',
        message:
          'outputs[1].server.transports.webSocket.procedures selects no procedure: write procedures: [] for none',
      },
    ]);
  });

  test('finds a gateway of commands GATEWAY_EMPTY, as selectionFindingsOf words it', () => {
    const plan = planOf(readBlueprint(SHOP_BLUEPRINT), [
      {
        language: 'typescript',
        gateway: { mode: 'pick', selections: [{ ...EMPTY_SELECTION, kind: ['command'] }] },
      },
    ]);

    expect(findingsOf(plan)).toEqual([
      {
        rule: 'GATEWAY_EMPTY',
        message:
          'outputs[0].gateway selects no request and no procedure that notifies: it would serve no route; take gateway out of it, or select one',
      },
    ]);
    expect(plan.outputs[0]?.routes).toEqual([]);
  });

  test("cuts the demo's own blueprint, its sign-up a route of the gateway, read back as planned", async () => {
    const blueprint = await demoBlueprint();
    const plan = planOf(blueprint, DEMO_PACKAGES);

    expect(plan.yaml).toBe(
      [
        'outputs:',
        '  - language: typescript',
        '    out: gen/typescript-gateway',
        '    gateway: {}',
        '  - language: csharp',
        '    out: gen/csharp-client',
        '    client: {}',
        '',
      ].join('\n')
    );
    expect(readBackOf(plan)).toEqual(plannedOf(plan));
    expect(findingsOf(plan)).toEqual([]);
    expect(
      plan.outputs[0]?.routes?.map(({ method, template }) => {
        return `${method} ${template}`;
      })
    ).toEqual(['POST /api/SignUp/signUp']);
    expect([...(plan.outputs[1]?.cut.called ?? new Map())]).toEqual([
      ['SignUp', new Set(['signUp'])],
    ]);
  });

  test("cuts the demo's own blueprint otherwise: a transport of none, a selector of the shop's", async () => {
    const blueprint = await demoBlueprint();
    const served = planOf(blueprint, [
      {
        language: 'typescript',
        server: {
          ...ALL,
          transports: [
            { type: 'webSocket', side: ALL },
            { type: 'http', side: { mode: 'none', selections: [EMPTY_SELECTION] } },
          ],
        },
        client: ALL,
      },
    ]);

    expect(readBackOf(served)).toEqual(plannedOf(served));
    expect(findingsOf(served)).toEqual([]);
    expect(served.outputs[0]?.cut.transports).toEqual([
      { key: 'webSocket', addresses: [{ serviceId: 2, procedureId: 1, name: 'SignUp/signUp' }] },
      { key: 'http', addresses: [] },
    ]);

    // * a selector the shop's blueprint would hold, which the demo's has no service of
    const shops = planOf(blueprint, [{ language: 'csharp', client: including(['Shop/*']) }]);

    expect(findingsOf(shops)).toEqual([
      {
        rule: 'SELECTOR_UNMATCHED',
        message:
          'outputs[0].client.procedures[0].include[0]: Shop/* names no procedure of the blueprint',
      },
      {
        rule: 'SELECTION_EMPTY',
        message: 'outputs[0].client.procedures selects no procedure: write procedures: [] for none',
      },
    ]);
  });
});

test.describe('readBlueprint', () => {
  test('refuses what is no blueprint, one of no service, and a procedure of no kind', () => {
    expect(() => {
      return readBlueprint({ format: 'bead-blueprint/2', services: [] });
    }).toThrow('no blueprint: its format is bead-blueprint/1');
    expect(() => {
      return readBlueprint({ format: 'bead-blueprint/1', services: [] });
    }).toThrow('the blueprint holds no service');
    expect(() => {
      return readBlueprint({
        format: 'bead-blueprint/1',
        services: [
          {
            serviceId: 1,
            serviceName: 'Shop',
            procedures: [{ procedureId: 1, procedureName: 'getProduct' }],
          },
        ],
      });
    }).toThrow('services[0].procedures[0] names no procedureId, procedureName and procedureKind');
  });
});
