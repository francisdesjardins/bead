// ── Demo packages ────────────────────────────────────────────────────────────

// The Packages tab: a blueprint cut into the outputs of `beadc.yaml`, as `planner.ts` plans them
// with the builder's own code. On the left, the packages, each its language and its sides, every
// choice a list the blueprint gives, nothing typed; on the right, what each class holds, the
// findings `generate` would refuse, the procedures each transport takes, the gateway's routes, then
// the YAML, read back by `parseConfig`. The demo's own blueprint is planned first; another one is
// opened, or dropped, and stays in the browser.

// dependencies

import type { IBlueprint, IProcedureEntry } from '../../../builder/src/model/blueprint.ts';
import demoBlueprint from './gen/demo.blueprint.json' with { type: 'json' };
import {
  DEMO_PACKAGES,
  EMPTY_SELECTION,
  type HoldingMode,
  type IOutputPlan,
  type IPackage,
  type IPlan,
  type IPlannedSelection,
  type IPlannedSide,
  KINDS,
  type Language,
  LANGUAGES,
  LEVELS,
  planOf,
  readBlueprint,
  SHOP_BLUEPRINT,
  SHOP_PACKAGES,
  TRANSPORT_TYPES,
  type TransportType,
} from './planner';

// types

/** A procedure as the page lists it: its service's name and id beside it. */
interface IListed {
  readonly service: string;
  readonly serviceId: number;
  readonly procedure: IProcedureEntry;
  /** `Service/procedure`. */
  readonly name: string;
}

/** What the page builds an element of. */
interface IElementOptions {
  readonly className?: string;
  readonly text?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly (Node | string)[];
}

/** What a side's editor is given: its package, its place, its pool and its modes' words. */
interface ISideDetails {
  readonly at: number;
  readonly where: string;
  readonly pool: readonly IListed[];
  readonly modes: readonly (readonly [HoldingMode, string])[];
}

/** A selection's place among its side's, and what it can choose from. */
interface ISelectionDetails {
  readonly key: string;
  readonly at: number;
  readonly where: string;
  readonly index: number;
  readonly pool: readonly IListed[];
  /** Whether its side has others, each then removable. */
  readonly isOneOfMany: boolean;
}

/** A list of a selection's names, offered from `pool`. */
interface IPickDetails {
  readonly key: string;
  readonly field: 'include' | 'exclude';
  readonly chosen: readonly string[];
  readonly pool: readonly IListed[];
  readonly data: Readonly<Record<string, string>>;
}

// constants

/** What each side's class holds, as the page says it beside its name. */
const SIDE_HOLDS = Object.freeze({
  server: 'its resolvers, its notifiers and the requesters of its commands',
  client: 'its requesters, its notifications and the resolvers of the commands it answers',
  gateway: 'the route table, the OpenAPI document and the HTTP client',
});

const SIDES = Object.freeze(['server', 'client', 'gateway'] as const);

const DEMO_LABEL = 'demo/gen/demo.blueprint.json';
const SHOP_LABEL = 'Shop (an example, not a real contract)';

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the page has no #${id}`);
  }

  return element;
};

// an element of `tag`, its class, its text or its children, and its attributes
const make = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  options: IElementOptions = {}
): HTMLElementTagNameMap[Tag] => {
  const element = document.createElement(tag);

  if (options.className !== undefined) {
    element.className = options.className;
  }

  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    element.setAttribute(name, value);
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  element.append(...(options.children ?? []));

  return element;
};

const code = (text: string): HTMLElement => {
  return make('code', { text });
};

const listedOf = (blueprint: IBlueprint): IListed[] => {
  return blueprint.services.flatMap((service) => {
    return service.procedures.map((procedure) => {
      return {
        service: service.serviceName,
        serviceId: service.serviceId,
        procedure,
        name: `${service.serviceName}/${procedure.procedureName}`,
      };
    });
  });
};

const levelOf = (listed: IListed): string => {
  return listed.procedure.http?.idempotencyLevel ?? 'IDEMPOTENCY_UNKNOWN';
};

// what a transport and a gateway answer: a request, or a procedure that notifies
const answers = (listed: IListed): boolean => {
  return listed.procedure.procedureKind !== 'command';
};

const sideAt = (planned: IPackage, where: string): IPlannedSide | undefined => {
  if (where.startsWith('t')) {
    return planned.server?.transports[Number(where.slice(1))]?.side;
  }

  return planned[where as (typeof SIDES)[number]];
};

const withSide = (planned: IPackage, details: { where: string; side: IPlannedSide }): IPackage => {
  const { where, side } = details;
  const { server } = planned;

  if (where.startsWith('t')) {
    const at = Number(where.slice(1));
    const transport = server?.transports[at];

    return server === undefined || transport === undefined
      ? planned
      : {
          ...planned,
          server: { ...server, transports: server.transports.with(at, { ...transport, side }) },
        };
  }

  if (where === 'server') {
    return server === undefined
      ? planned
      : { ...planned, server: { ...server, mode: side.mode, selections: side.selections } };
  }

  return where === 'client' ? { ...planned, client: side } : { ...planned, gateway: side };
};

// a package without `side`, or with it anew, holding every procedure it can
const toggledSideOf = (planned: IPackage, side: (typeof SIDES)[number]): IPackage => {
  const isOn = planned[side] === undefined;
  const fresh: IPlannedSide = { mode: 'all', selections: [EMPTY_SELECTION] };
  const kept = SIDES.filter((each) => {
    return each !== side;
  });

  return {
    language: planned.language,
    ...(kept.includes('server') && planned.server !== undefined ? { server: planned.server } : {}),
    ...(kept.includes('client') && planned.client !== undefined ? { client: planned.client } : {}),
    ...(kept.includes('gateway') && planned.gateway !== undefined
      ? { gateway: planned.gateway }
      : {}),
    ...(isOn && side === 'server' ? { server: { ...fresh, transports: [] } } : {}),
    ...(isOn && side === 'client' ? { client: fresh } : {}),
    ...(isOn && side === 'gateway' ? { gateway: fresh } : {}),
  };
};

// a selection with `value` marked or not in `field`; a whole service marked takes its procedures'
const toggledOf = (
  selection: IPlannedSelection,
  details: { field: keyof IPlannedSelection; value: string; isChecked: boolean }
): IPlannedSelection => {
  const { field, value, isChecked } = details;
  const others = (selection[field] as readonly string[]).filter((each) => {
    return each !== value;
  });
  const marked = isChecked ? [...others, value] : others;
  const service = value.endsWith('/*') ? value.slice(0, -1) : undefined;

  return {
    ...selection,
    [field]:
      isChecked && service !== undefined
        ? marked.filter((each) => {
            return each === value || !each.startsWith(service);
          })
        : marked,
  };
};

// a radio, a checkbox and its words
const choice = (
  words: Node | string,
  details: { type: 'radio' | 'checkbox'; isChecked: boolean; attributes: Record<string, string> }
): HTMLLabelElement => {
  const input = make('input', { attributes: { type: details.type, ...details.attributes } });

  input.checked = details.isChecked;

  return make('label', { className: 'planner-choice', children: [input, words] });
};

const kindChip = (kind: string): HTMLElement => {
  return make('span', { className: `chip kind-${kind}`, text: kind });
};

// definition

/** Mounts the Packages tab on the page's `#packages-scene`: the demo's blueprint, planned. */
export const mountPackages = (): void => {
  const editor = elementOf('planner-editor');
  const shown = {
    summary: elementOf('planner-summary'),
    error: elementOf('planner-error'),
    findings: elementOf('planner-findings'),
    matrix: elementOf('planner-matrix'),
    transports: elementOf('planner-transports'),
    routes: elementOf('planner-routes'),
    yaml: elementOf('planner-yaml'),
    reading: elementOf('planner-reading'),
    copied: elementOf('planner-copied'),
  };
  let blueprint = readBlueprint(demoBlueprint);
  let packages: readonly IPackage[] = DEMO_PACKAGES;
  let label = DEMO_LABEL;
  let listed = listedOf(blueprint);

  // ── the editor: lists, radios and checkboxes alone ─────────────────────────

  const pickOf = ({ key, field, chosen, pool, data }: IPickDetails): HTMLDetailsElement => {
    const known = new Set<string>();
    const services = [
      ...new Set(
        pool.map(({ service }) => {
          return service;
        })
      ),
    ];
    const groups = services.map((service) => {
      const whole = `${service}/*`;
      const isWhole = chosen.includes(whole);
      const held = pool.filter((each) => {
        return each.service === service;
      });

      known.add(whole);

      for (const each of held) {
        known.add(each.name);
      }

      return make('div', {
        className: 'planner-service',
        children: [
          choice(code(whole), {
            type: 'checkbox',
            isChecked: isWhole,
            attributes: { ...data, 'data-f': field, value: whole, 'data-key': `${key}:${whole}` },
          }),
          ...(isWhole
            ? []
            : held.map((each) => {
                return choice(
                  make('span', {
                    className: 'planner-procedure',
                    children: [
                      code(each.procedure.procedureName),
                      kindChip(each.procedure.procedureKind),
                    ],
                  }),
                  {
                    type: 'checkbox',
                    isChecked: chosen.includes(each.name),
                    attributes: {
                      ...data,
                      'data-f': field,
                      value: each.name,
                      'data-key': `${key}:${each.name}`,
                    },
                  }
                );
              })),
        ],
      });
    });
    const stale = chosen
      .filter((each) => {
        return !known.has(each);
      })
      .map((each) => {
        return choice(
          make('span', { className: 'stale', children: [code(each), ' (not held here)'] }),
          {
            type: 'checkbox',
            isChecked: true,
            attributes: { ...data, 'data-f': field, value: each, 'data-key': `${key}:${each}` },
          }
        );
      });
    let shownChosen = 'none';

    if (chosen.length > 0) {
      shownChosen = `${String(chosen.length)} chosen`;
    } else if (field === 'include') {
      shownChosen = 'every procedure';
    }

    return make('details', {
      className: 'planner-pick',
      attributes: { 'data-key': key },
      children: [
        make('summary', {
          children: [make('span', { className: 'label', text: field }), ` ${shownChosen}`],
        }),
        make('div', {
          className: 'planner-pick-body',
          children:
            stale.length + groups.length > 0
              ? [...stale, ...groups]
              : [make('p', { className: 'note', text: 'Nothing to choose here.' })],
        }),
      ],
    });
  };

  const selectionOf = (
    selection: IPlannedSelection,
    { key, at, where, index, pool, isOneOfMany }: ISelectionDetails
  ): HTMLElement => {
    const data = { 'data-p': String(at), 'data-w': where, 'data-s': String(index) };
    const kinds = KINDS.filter((kind) => {
      return pool.some(({ procedure }) => {
        return procedure.procedureKind === kind;
      });
    });

    return make('div', {
      className: 'planner-selection',
      children: [
        ...(isOneOfMany
          ? [
              make('div', {
                className: 'planner-row',
                children: [
                  make('span', { className: 'label', text: index === 0 ? 'a selection' : 'or' }),
                  make('button', {
                    className: 'quiet',
                    text: 'Remove',
                    attributes: {
                      type: 'button',
                      'data-act': 'rm-sel',
                      ...data,
                      'data-key': `${key}:rm`,
                    },
                  }),
                ],
              }),
            ]
          : []),
        make('div', {
          className: 'planner-picks',
          children: [
            pickOf({
              key: `${key}:include`,
              field: 'include',
              chosen: selection.include,
              pool,
              data,
            }),
            pickOf({
              key: `${key}:exclude`,
              field: 'exclude',
              chosen: selection.exclude,
              pool,
              data,
            }),
          ],
        }),
        make('div', {
          className: 'planner-checks',
          attributes: { role: 'group', 'aria-label': 'kind' },
          children: [
            make('span', { className: 'label', text: 'kind' }),
            ...kinds.map((kind) => {
              return choice(kind, {
                type: 'checkbox',
                isChecked: selection.kind.includes(kind),
                attributes: {
                  ...data,
                  'data-f': 'kind',
                  value: kind,
                  'data-key': `${key}:kind:${kind}`,
                },
              });
            }),
          ],
        }),
        make('div', {
          className: 'planner-checks',
          attributes: { role: 'group', 'aria-label': 'idempotencyLevel' },
          children: [
            make('span', { className: 'label', text: 'idempotencyLevel' }),
            ...LEVELS.map((level) => {
              const count = pool.filter((each) => {
                return levelOf(each) === level;
              }).length;

              return choice(
                make('span', {
                  children: [
                    code(level),
                    make('span', { className: 'count-of', text: ` ${String(count)}` }),
                  ],
                }),
                {
                  type: 'checkbox',
                  isChecked: selection.idempotencyLevel.includes(level),
                  attributes: {
                    ...data,
                    'data-f': 'idempotencyLevel',
                    value: level,
                    'data-key': `${key}:level:${level}`,
                  },
                }
              );
            }),
          ],
        }),
      ],
    });
  };

  const sideBodyOf = (side: IPlannedSide, { at, where, pool, modes }: ISideDetails): Node[] => {
    const key = `p${String(at)}:${where}`;
    const data = { 'data-p': String(at), 'data-w': where };

    return [
      make('div', {
        className: 'planner-modes',
        attributes: {
          role: 'radiogroup',
          'aria-label': `What ${where.startsWith('t') ? 'the transport takes' : `the ${where} holds`}`,
        },
        children: modes.map(([mode, words]) => {
          return choice(words, {
            type: 'radio',
            isChecked: side.mode === mode,
            attributes: {
              ...data,
              name: `${key}:mode`,
              'data-f': 'mode',
              value: mode,
              'data-key': `${key}:mode:${mode}`,
            },
          });
        }),
      }),
      ...(side.mode === 'pick'
        ? [
            ...side.selections.map((selection, index) => {
              return selectionOf(selection, {
                key: `${key}:s${String(index)}`,
                at,
                where,
                index,
                pool,
                isOneOfMany: side.selections.length > 1,
              });
            }),
            make('div', {
              children: [
                make('button', {
                  text: 'Add another selection (or)',
                  attributes: {
                    type: 'button',
                    'data-act': 'add-sel',
                    ...data,
                    'data-key': `${key}:add`,
                  },
                }),
              ],
            }),
          ]
        : []),
    ];
  };

  const sideHeadOf = (name: string, holds: string): HTMLElement => {
    return make('p', {
      className: 'planner-side-head',
      children: [
        make('strong', { text: name }),
        ' ',
        make('span', { className: 'note', text: holds }),
      ],
    });
  };

  const packageOf = (output: IOutputPlan, at: number): HTMLElement => {
    const { planned, cut } = output;
    const key = `p${String(at)}`;
    const isWhole = planned.server === undefined && planned.client === undefined;
    const served = listed.filter((each) => {
      return (
        answers(each) && cut.served?.get(each.service)?.has(each.procedure.procedureName) === true
      );
    });
    const parts: Node[] = [
      make('div', {
        className: 'planner-package-head',
        children: [
          make('label', {
            className: 'planner-field',
            children: [
              make('span', { className: 'label', text: 'Language' }),
              make('select', {
                attributes: {
                  'data-p': String(at),
                  'data-f': 'language',
                  'data-key': `${key}:language`,
                },
                children: Object.entries(LANGUAGES).map(([value, name]) => {
                  const option = make('option', { text: name, attributes: { value } });

                  option.selected = planned.language === value;

                  return option;
                }),
              }),
            ],
          }),
          make('div', {
            className: 'planner-field planner-folder',
            children: [
              make('span', { className: 'label', text: 'Folder, derived' }),
              code(output.folder),
            ],
          }),
          make('button', {
            className: 'quiet',
            text: 'Remove',
            attributes: {
              type: 'button',
              'data-act': 'rm-pkg',
              'data-p': String(at),
              'aria-label': `Remove ${output.folder}`,
              'data-key': `${key}:rm`,
            },
          }),
        ],
      }),
      make('div', {
        className: 'planner-writes',
        attributes: { role: 'group', 'aria-label': 'What this package writes' },
        children: [
          make('span', { className: 'label', text: 'writes' }),
          ...SIDES.map((side) => {
            const isOn = planned[side] !== undefined;

            return make('button', {
              className: isOn ? 'is-on' : '',
              text: side,
              attributes: {
                type: 'button',
                'aria-pressed': String(isOn),
                'data-act': 'toggle',
                'data-p': String(at),
                'data-w': side,
                'data-key': `${key}:toggle:${side}`,
              },
            });
          }),
        ],
      }),
    ];

    if (isWhole) {
      parts.push(
        make('p', {
          className: 'note',
          children: [
            'Neither ',
            code('server'),
            ' nor ',
            code('client'),
            ': this output writes both classes whole.',
          ],
        })
      );
    }

    if (planned.server !== undefined) {
      const { server } = planned;

      parts.push(
        make('div', {
          className: 'planner-side',
          attributes: { role: 'group', 'aria-label': 'server' },
          children: [
            sideHeadOf('server', SIDE_HOLDS.server),
            ...sideBodyOf(server, {
              at,
              where: 'server',
              pool: listed,
              modes: [
                ['all', 'every procedure'],
                ['pick', 'a selection'],
              ],
            }),
            make('div', {
              className: 'planner-row',
              children: [
                sideHeadOf('transports', 'the procedures each takes'),
                make('select', {
                  attributes: {
                    'data-act': 'add-t',
                    'data-p': String(at),
                    'aria-label': 'Add a transport',
                    'data-key': `${key}:add-t`,
                  },
                  children: [
                    make('option', { text: 'Add a transport…', attributes: { value: '' } }),
                    ...Object.entries(TRANSPORT_TYPES).map(([value, name]) => {
                      return make('option', { text: name, attributes: { value } });
                    }),
                  ],
                }),
              ],
            }),
            ...server.transports.map((transport, index) => {
              const where = `t${String(index)}`;
              const transportKey = output.transportKeys[index] ?? transport.type;
              const takes = cut.transports?.[index]?.addresses.length ?? 0;

              return make('div', {
                className: 'planner-side planner-transport',
                attributes: { role: 'group', 'aria-label': `transport ${transportKey}` },
                children: [
                  make('div', {
                    className: 'planner-row',
                    children: [
                      make('p', {
                        children: [
                          make('code', { className: 'planner-key', text: transportKey }),
                          ' ',
                          make('span', {
                            className: 'note',
                            text: `${TRANSPORT_TYPES[transport.type]} · takes ${String(takes)}`,
                          }),
                        ],
                      }),
                      make('button', {
                        className: 'quiet',
                        text: 'Remove',
                        attributes: {
                          type: 'button',
                          'data-act': 'rm-t',
                          'data-p': String(at),
                          'data-w': where,
                          'aria-label': `Remove the transport ${transportKey}`,
                          'data-key': `${key}:${where}:rm`,
                        },
                      }),
                    ],
                  }),
                  ...sideBodyOf(transport.side, {
                    at,
                    where,
                    pool: served,
                    modes: [
                      ['all', 'every procedure the server holds'],
                      ['pick', 'a selection'],
                      ['none', 'none'],
                    ],
                  }),
                ],
              });
            }),
            ...(server.transports.length === 0
              ? [
                  make('p', {
                    className: 'note',
                    text: 'No transport named: the application hands no transport a list, and each takes every procedure.',
                  }),
                ]
              : []),
          ],
        })
      );
    }

    if (planned.client !== undefined) {
      parts.push(
        make('div', {
          className: 'planner-side',
          attributes: { role: 'group', 'aria-label': 'client' },
          children: [
            sideHeadOf('client', SIDE_HOLDS.client),
            ...sideBodyOf(planned.client, {
              at,
              where: 'client',
              pool: listed,
              modes: [
                ['all', 'every procedure'],
                ['pick', 'a selection'],
              ],
            }),
          ],
        })
      );
    }

    if (planned.gateway !== undefined) {
      parts.push(
        make('div', {
          className: 'planner-side',
          attributes: { role: 'group', 'aria-label': 'gateway' },
          children: [
            sideHeadOf('gateway', SIDE_HOLDS.gateway),
            ...sideBodyOf(planned.gateway, {
              at,
              where: 'gateway',
              pool: listed.filter(answers),
              modes: [
                ['all', 'every request and procedure that notifies'],
                ['pick', 'a selection'],
              ],
            }),
          ],
        })
      );
    }

    return make('section', {
      className: 'card planner-package',
      attributes: { 'aria-label': output.folder },
      children: parts,
    });
  };

  // ── the view: what each class holds, the findings, the transports, the routes, the YAML ──

  const findingsOf = (plan: IPlan): HTMLElement[] => {
    const notes: HTMLElement[] = [];
    const note = (tone: string, children: readonly (Node | string)[]): void => {
      notes.push(make('p', { className: `planner-note ${tone}`, children }));
    };

    if ('refusal' in plan.reading) {
      note('bad', [make('span', { className: 'rule', text: 'beadc.yaml' }), plan.reading.refusal]);
    }

    // * what generate refuses first; then, where it refuses nothing, that it would take them
    const isRefused =
      'refusal' in plan.reading ||
      plan.outputs.some(({ findings }) => {
        return findings.length > 0;
      });

    if (!isRefused && plan.outputs.length > 0) {
      note('ok', ['No finding: beadc generate refuses none of these selections.']);
    }

    for (const output of plan.outputs) {
      for (const { rule, message } of output.findings) {
        note('bad', [make('span', { className: 'rule', text: rule }), message]);
      }

      const types = new Map<TransportType, number>();

      for (const { type } of output.planned.server?.transports ?? []) {
        types.set(type, (types.get(type) ?? 0) + 1);
      }

      for (const [type, count] of types) {
        if (count > 1) {
          note('warn', [
            code(output.folder),
            ` has ${String(count)} transports of the type ${TRANSPORT_TYPES[type]}: a join takes no two of one type, so they are two routers (decision 0036).`,
          ]);
        }
      }

      if (
        output.planned.server !== undefined &&
        output.planned.server.transports.length > 0 &&
        output.planned.client === undefined
      ) {
        note('', [
          code(output.folder),
          ' names ',
          code('server'),
          ' alone, so it writes no client class: turn ',
          code('client'),
          ' on to keep one.',
        ]);
      }
    }

    const servers = plan.outputs.filter(({ cut }) => {
      return cut.served !== undefined;
    });
    const unserved = listed.filter((each) => {
      return !servers.some(({ cut }) => {
        return cut.served?.get(each.service)?.has(each.procedure.procedureName) === true;
      });
    });

    if (servers.length > 0 && unserved.length > 0) {
      note('warn', [
        `${String(unserved.length)} ${unserved.length === 1 ? 'procedure is' : 'procedures are'} held by no server class: `,
        ...unserved.slice(0, 6).flatMap((each, index) => {
          return [index === 0 ? '' : ', ', code(each.name)];
        }),
        unserved.length > 6 ? '…' : '.',
      ]);
    }

    return notes;
  };

  // each class's column: its folder, what it is, and whether it holds a procedure
  const columnsOf = (plan: IPlan) => {
    return plan.outputs.flatMap(({ folder, cut, planned, transportKeys }) => {
      const isWhole = planned.server === undefined && planned.client === undefined;
      const short = folder.replace(/^gen\//u, '');
      const heldIn = (picks: ReadonlyMap<string, ReadonlySet<string>> | undefined) => {
        return (each: IListed): boolean => {
          return picks?.get(each.service)?.has(each.procedure.procedureName) === true;
        };
      };

      return [
        ...(cut.served === undefined
          ? []
          : [
              {
                folder: short,
                what: isWhole ? 'server, whole' : 'server',
                holds: heldIn(cut.served),
              },
            ]),
        ...(cut.transports ?? []).map((transport, index) => {
          return {
            folder: short,
            what: `transport ${transportKeys[index] ?? transport.key}`,
            holds: (each: IListed): boolean => {
              return transport.addresses.some(({ serviceId, procedureId }) => {
                return serviceId === each.serviceId && procedureId === each.procedure.procedureId;
              });
            },
          };
        }),
        ...(cut.called === undefined
          ? []
          : [
              {
                folder: short,
                what: isWhole ? 'client, whole' : 'client',
                holds: heldIn(cut.called),
              },
            ]),
        ...(cut.gateway === undefined
          ? []
          : [
              {
                folder: short,
                what: 'gateway',
                holds: heldIn(
                  new Map(
                    cut.gateway.services.map((service) => {
                      return [
                        service.serviceName,
                        new Set(
                          service.procedures.map(({ procedureName }) => {
                            return procedureName;
                          })
                        ),
                      ];
                    })
                  )
                ),
              },
            ]),
      ];
    });
  };

  const matrixOf = (plan: IPlan): HTMLElement => {
    const columns = columnsOf(plan);

    if (columns.length === 0) {
      return make('p', { className: 'note planner-empty', text: 'Add a package.' });
    }

    const servers = plan.outputs.filter(({ cut }) => {
      return cut.served !== undefined;
    });

    return make('table', {
      children: [
        make('thead', {
          children: [
            make('tr', {
              children: [
                make('th', {
                  className: 'planner-procedure-head',
                  text: 'Procedure',
                  attributes: { scope: 'col' },
                }),
                ...columns.map((column) => {
                  return make('th', {
                    attributes: { scope: 'col' },
                    children: [
                      make('span', {
                        className: 'planner-count',
                        text: `${String(listed.filter(column.holds).length)}/${String(listed.length)}`,
                      }),
                      make('span', { className: 'planner-column', text: column.folder }),
                      make('span', { className: 'planner-what', text: column.what }),
                    ],
                  });
                }),
              ],
            }),
          ],
        }),
        make('tbody', {
          children: listed.map((each) => {
            const level = levelOf(each);
            const isUnserved =
              servers.length > 0 &&
              !servers.some(({ cut }) => {
                return cut.served?.get(each.service)?.has(each.procedure.procedureName) === true;
              });

            return make('tr', {
              className: isUnserved ? 'is-unserved' : '',
              children: [
                make('th', {
                  className: 'planner-procedure-head',
                  attributes: { scope: 'row' },
                  children: [
                    make('span', {
                      className: 'planner-procedure',
                      children: [
                        code(each.name),
                        kindChip(each.procedure.procedureKind),
                        ...(level === 'NO_SIDE_EFFECTS'
                          ? [make('span', { className: 'chip reads', text: 'reads' })]
                          : []),
                        ...(level === 'IDEMPOTENT'
                          ? [make('span', { className: 'chip', text: 'idempotent' })]
                          : []),
                      ],
                    }),
                  ],
                }),
                ...columns.map((column) => {
                  const isHeld = column.holds(each);

                  return make('td', {
                    children: [
                      make('span', {
                        className: isHeld ? 'dot is-held' : 'dot',
                        attributes: { role: 'img', 'aria-label': isHeld ? 'held' : 'not held' },
                      }),
                    ],
                  });
                }),
              ],
            });
          }),
        }),
      ],
    });
  };

  const transportsOf = (plan: IPlan): HTMLElement[] => {
    const shownTransports = plan.outputs.flatMap(({ folder, cut }) => {
      return (cut.transports ?? []).map(({ key, addresses }) => {
        return make('div', {
          className: 'planner-listing',
          children: [
            make('p', {
              className: 'label',
              text: `${folder} · ${key} · ${String(addresses.length)} ${addresses.length === 1 ? 'address' : 'addresses'}`,
            }),
            make('pre', {
              className: 'code',
              text:
                addresses
                  .map(({ serviceId, procedureId, name }) => {
                    return `(${String(serviceId)}, ${String(procedureId)})  ${name}`;
                  })
                  .join('\n') ||
                '(none: each request to it is answered SERVICE_UNKNOWN or PROCEDURE_UNKNOWN)',
            }),
          ],
        });
      });
    });

    return shownTransports.length > 0
      ? shownTransports
      : [
          make('p', {
            className: 'note',
            text: 'No server names a transport: each takes every procedure its server holds.',
          }),
        ];
  };

  const routesOf = (plan: IPlan): HTMLElement[] => {
    const shownRoutes = plan.outputs.flatMap(({ folder, routes }) => {
      if (routes === undefined) {
        return [];
      }

      return [
        make('div', {
          className: 'planner-listing',
          children: [
            make('p', {
              className: 'label',
              text: `${folder} · ${String(routes.length)} ${routes.length === 1 ? 'route' : 'routes'}`,
            }),
            make('pre', {
              className: 'code',
              text:
                routes
                  .map(({ method, template }) => {
                    return `${method.padEnd(6)} ${template}`;
                  })
                  .join('\n') || '(none)',
            }),
          ],
        }),
      ];
    });

    return shownRoutes.length > 0
      ? [
          ...shownRoutes,
          make('p', {
            className: 'note',
            children: [
              'Default routes under ',
              code('/api'),
              ' (transcoding 3.2, 3.3): a ',
              code('POST'),
              ' each, a ',
              code('GET'),
              ' where a request marked NO_SIDE_EFFECTS fits the query; each ',
              code('google.api.http'),
              ' rule beside them.',
            ],
          }),
        ]
      : [make('p', { className: 'note', text: 'No package writes a gateway.' })];
  };

  const summaryOf = (): (Node | string)[] => {
    const counts = KINDS.map((kind) => {
      return `${String(
        listed.filter(({ procedure }) => {
          return procedure.procedureKind === kind;
        }).length
      )} ${kind}`;
    });
    const reads = listed.filter((each) => {
      return levelOf(each) === 'NO_SIDE_EFFECTS';
    }).length;
    const services = blueprint.services.length;

    return [
      make('strong', { text: label }),
      ` · ${String(services)} ${services === 1 ? 'service' : 'services'}, ${String(listed.length)} ${listed.length === 1 ? 'procedure' : 'procedures'} · `,
      make('span', { className: 'mono', text: counts.join(' · ') }),
      ` · ${String(reads)} marked NO_SIDE_EFFECTS`,
    ];
  };

  const render = (): void => {
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset['key']
        : undefined;
    const opened = new Set(
      [...editor.querySelectorAll<HTMLDetailsElement>('details[open]')].map((details) => {
        return details.dataset['key'];
      })
    );
    const plan = planOf(blueprint, packages);

    shown.summary.replaceChildren(...summaryOf());
    editor.replaceChildren(
      ...(plan.outputs.length === 0
        ? [make('p', { className: 'note', text: 'No package yet: add one to start cutting.' })]
        : plan.outputs.map(packageOf))
    );

    for (const details of editor.querySelectorAll<HTMLDetailsElement>('details[data-key]')) {
      details.open = opened.has(details.dataset['key']);
    }

    if (focused !== undefined) {
      editor.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
    }

    shown.findings.replaceChildren(...findingsOf(plan));
    shown.matrix.replaceChildren(matrixOf(plan));
    shown.transports.replaceChildren(...transportsOf(plan));
    shown.routes.replaceChildren(...routesOf(plan));
    shown.yaml.textContent = plan.yaml;
    shown.copied.textContent = '';
    shown.reading.replaceChildren(
      ...('config' in plan.reading
        ? [
            code('parseConfig'),
            ` reads it back: ${String(plan.reading.config.outputs?.length ?? 0)} ${
              plan.reading.config.outputs?.length === 1 ? 'output' : 'outputs'
            }, as planned.`,
          ]
        : [code('parseConfig'), ` refuses it: ${plan.reading.refusal}`])
    );
    shown.reading.toggleAttribute('data-refused', 'refusal' in plan.reading);
  };

  const load = (
    given: unknown,
    details: { label: string; packages: readonly IPackage[] }
  ): void => {
    try {
      blueprint = readBlueprint(given);
    } catch (error) {
      shown.error.textContent = `This blueprint cannot be planned: ${(error as Error).message}.`;
      shown.error.hidden = false;

      return;
    }

    shown.error.hidden = true;
    label = details.label;
    listed = listedOf(blueprint);
    packages = details.packages;
    render();
  };

  const loadFile = async (file: File): Promise<void> => {
    let given: unknown;

    try {
      given = JSON.parse(await file.text());
    } catch (error) {
      shown.error.textContent = `This file is no JSON: ${(error as Error).message}.`;
      shown.error.hidden = false;

      return;
    }

    // a blueprint of its own: one package of both classes whole to start from
    load(given, { label: file.name, packages: [{ language: 'typescript' }] });
  };

  // ── events ──────────────────────────────────────────────────────────────────

  const update = (at: number, change: (planned: IPackage) => IPackage): void => {
    const planned = packages[at];

    if (planned !== undefined) {
      packages = packages.with(at, change(planned));
      render();
    }
  };

  editor.addEventListener('change', (event) => {
    const { target } = event;

    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
      return;
    }

    const at = Number(target.dataset['p']);
    const where = target.dataset['w'] ?? '';
    const field = target.dataset['f'];

    if (target.dataset['act'] === 'add-t') {
      const type = target.value as TransportType;

      update(at, (planned) => {
        return planned.server === undefined || !(type in TRANSPORT_TYPES)
          ? planned
          : {
              ...planned,
              server: {
                ...planned.server,
                transports: [
                  ...planned.server.transports,
                  { type, side: { mode: 'all', selections: [EMPTY_SELECTION] } },
                ],
              },
            };
      });

      return;
    }

    if (field === 'language') {
      update(at, (planned) => {
        return { ...planned, language: target.value as Language };
      });

      return;
    }

    update(at, (planned) => {
      const side = sideAt(planned, where);

      if (side === undefined) {
        return planned;
      }

      if (field === 'mode') {
        return withSide(planned, {
          where,
          side: {
            mode: target.value as HoldingMode,
            selections: side.selections.length === 0 ? [EMPTY_SELECTION] : side.selections,
          },
        });
      }

      const index = Number(target.dataset['s']);
      const selection = side.selections[index];

      if (
        selection === undefined ||
        field === undefined ||
        !(field in selection) ||
        !(target instanceof HTMLInputElement)
      ) {
        return planned;
      }

      return withSide(planned, {
        where,
        side: {
          ...side,
          selections: side.selections.with(
            index,
            toggledOf(selection, {
              field: field as keyof IPlannedSelection,
              value: target.value,
              isChecked: target.checked,
            })
          ),
        },
      });
    });
  });

  editor.addEventListener('click', (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('button[data-act]')
        : null;

    if (button === null) {
      return;
    }

    const at = Number(button.dataset['p']);
    const where = button.dataset['w'] ?? '';
    const act = button.dataset['act'];

    if (act === 'rm-pkg') {
      packages = packages.toSpliced(at, 1);
      render();

      return;
    }

    update(at, (planned) => {
      if (act === 'toggle') {
        return toggledSideOf(planned, where as (typeof SIDES)[number]);
      }

      if (act === 'rm-t' && planned.server !== undefined) {
        return {
          ...planned,
          server: {
            ...planned.server,
            transports: planned.server.transports.toSpliced(Number(where.slice(1)), 1),
          },
        };
      }

      const side = sideAt(planned, where);

      if (side === undefined) {
        return planned;
      }

      if (act === 'add-sel') {
        return withSide(planned, {
          where,
          side: { ...side, selections: [...side.selections, EMPTY_SELECTION] },
        });
      }

      if (act === 'rm-sel') {
        const selections = side.selections.toSpliced(Number(button.dataset['s']), 1);

        return withSide(planned, {
          where,
          side:
            selections.length === 0
              ? { mode: 'all', selections: [EMPTY_SELECTION] }
              : { ...side, selections },
        });
      }

      return planned;
    });
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-add-package]')) {
    button.addEventListener('click', () => {
      packages = [
        ...packages,
        {
          language: (button.dataset['addPackage'] ?? 'typescript') as Language,
          client: { mode: 'all', selections: [EMPTY_SELECTION] },
        },
      ];
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-blueprint]')) {
    button.addEventListener('click', () => {
      if (button.dataset['blueprint'] === 'shop') {
        load(SHOP_BLUEPRINT, { label: SHOP_LABEL, packages: SHOP_PACKAGES });
      } else {
        load(demoBlueprint, { label: DEMO_LABEL, packages: DEMO_PACKAGES });
      }
    });
  }

  const input = elementOf('planner-file');

  input.addEventListener('change', () => {
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;

    if (file !== undefined) {
      void loadFile(file);
    }
  });

  const drop = elementOf('planner-drop');

  for (const name of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.toggleAttribute('data-over', true);
    });
  }

  for (const name of ['dragleave', 'drop'] as const) {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.toggleAttribute('data-over', false);
    });
  }

  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files[0];

    if (file !== undefined) {
      void loadFile(file);
    }
  });

  // * the clipboard where the page may write to it; the YAML selected, to copy by hand, where not
  elementOf('planner-copy').addEventListener('click', () => {
    const selectYaml = (): void => {
      const range = document.createRange();

      range.selectNodeContents(shown.yaml);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      shown.copied.textContent = 'Selected: press Ctrl+C or ⌘C.';
    };

    // a page served over plain HTTP has no clipboard: reading it throws, and so rejects here
    new Promise<void>((resolve) => {
      resolve(navigator.clipboard.writeText(shown.yaml.textContent));
    }).then(() => {
      shown.copied.textContent = 'Copied.';
    }, selectYaml);
  });

  render();
};
