import { expect, test } from '@playwright/test';
import { createMessageBudget, type IMessageBudget } from '../websocket-message-budget';

// holders of `budget` by their names; those another's charge casts off, in order
const holdersOf = (budget: IMessageBudget, { names }: { names: readonly string[] }) => {
  const castOff: string[] = [];
  const holders = new Map(
    names.map((name) => {
      return [
        name,
        budget.holderOf({
          castOff: () => {
            castOff.push(name);
          },
        }),
      ];
    })
  );

  // charges `name`'s message `bytes`, beginning it first where `isFirst` says
  const charge = (
    name: string,
    { bytes, isFirst = false }: { bytes: number; isFirst?: boolean }
  ) => {
    const holder = holders.get(name);

    if (isFirst) {
      holder?.begin();
    }

    return holder?.charge(bytes);
  };

  return { castOff, charge, holders };
};

test.describe('createMessageBudget', () => {
  // spec 15.12; IANA's WebSocket Close Code Number Registry, 1013
  test('casts off other budget holders or refuses the asker when the next byte passes the bound', () => {
    const budget = createMessageBudget(500);
    const { castOff, charge, holders } = holdersOf(budget, {
      names: ['ada', 'bob', 'carol', 'dave', 'eve'],
    });

    expect([
      charge('ada', { bytes: 194, isFirst: true }),
      charge('bob', { bytes: 146, isFirst: true }),
      budget.held,
    ]).toEqual([true, true, 340]);

    // carol's 174 passes it: ada, who holds the most, is cast off, carol's charge taken
    expect([charge('carol', { bytes: 174, isFirst: true }), castOff, budget.held]).toEqual([
      true,
      ['ada'],
      320,
    ]);

    // dave's 234 passes it: at its 181st byte, he holds more than any other, and he alone is cast
    // off, what he held released, his own cast-off his caller's
    expect([charge('dave', { bytes: 234, isFirst: true }), castOff, budget.held]).toEqual([
      false,
      ['ada'],
      320,
    ]);
    expect(holders.get('dave')?.held).toBe(0);

    // a charge of bob's that ties carol: the one whose message began first, bob, goes first
    expect([charge('bob', { bytes: 28 }), budget.held]).toEqual([true, 348]);
    expect([charge('eve', { bytes: 160, isFirst: true }), castOff, budget.held]).toEqual([
      true,
      ['ada', 'bob'],
      334,
    ]);

    // a sum past the budget alone casts off its own holder, none other
    expect([charge('carol', { bytes: 400 }), castOff, budget.held]).toEqual([
      false,
      ['ada', 'bob'],
      160,
    ]);

    // a message whole, its charge released; a holder forgotten, its charge with it
    const eve = holders.get('eve');

    eve?.release();
    expect([eve?.held, budget.held]).toEqual([0, 0]);
    charge('eve', { bytes: 10, isFirst: true });

    if (eve !== undefined) {
      budget.forget(eve);
    }

    expect(budget.held).toBe(0);
  });

  // spec 15.12
  test('charges byte by byte, casting off whom the unit that passes the budget finds first', () => {
    const budget = createMessageBudget(1_000);
    const { castOff, charge, holders } = holdersOf(budget, { names: ['x', 'a'] });

    charge('x', { bytes: 600, isFirst: true });

    // * a's 650, whole, would hold more than x's 600; its 401st byte, the first past the budget,
    // finds x holding the most, so x is cast off, and a takes the rest
    expect([charge('a', { bytes: 650, isFirst: true }), castOff, budget.held]).toEqual([
      true,
      ['x'],
      650,
    ]);
    expect([holders.get('x')?.held, holders.get('a')?.held]).toEqual([0, 650]);

    // a charge of none is taken, and judges nothing
    expect([charge('a', { bytes: 0 }), castOff, budget.held]).toEqual([true, ['x'], 650]);
  });

  // spec 15.12
  test('casts off each holder that comes before a message whose charge alone passes the budget, then that message’s connection', () => {
    const budget = createMessageBudget(2_000);
    const { castOff, charge, holders } = holdersOf(budget, { names: ['p', 'a'] });

    charge('p', { bytes: 1_096, isFirst: true });

    // a's 2,036: p, holding more at a's 905th byte, is cast off; past 2,000, none is left but a
    expect([charge('a', { bytes: 2_036, isFirst: true }), castOff, budget.held]).toEqual([
      false,
      ['p'],
      0,
    ]);
    expect([holders.get('p')?.held, holders.get('a')?.held]).toEqual([0, 0]);
  });

  // spec 15.12
  test('casts off, among equal sums, the holder whose message began first', () => {
    // another holder: ada began first, bob second, each holding 200
    const shared = createMessageBudget(500);
    const others = holdersOf(shared, { names: ['ada', 'bob', 'carol'] });

    others.charge('ada', { bytes: 200, isFirst: true });
    others.charge('bob', { bytes: 200, isFirst: true });
    expect([
      others.charge('carol', { bytes: 150, isFirst: true }),
      others.castOff,
      shared.held,
    ]).toEqual([true, ['ada'], 350]);

    // the asking holder: its unit ties the other's sum, and the one begun first goes
    for (const [first, expected] of [
      ['ada', { castOff: [], isKept: false }],
      ['bob', { castOff: ['bob'], isKept: true }],
    ] as const) {
      const budget = createMessageBudget(301);
      const { castOff, charge, holders } = holdersOf(budget, { names: ['ada', 'bob'] });
      const second = first === 'ada' ? 'bob' : 'ada';

      holders.get(first)?.begin();
      holders.get(second)?.begin();
      charge('bob', { bytes: 151 });

      // ada's 150th byte fills the budget, and her 151st ties bob's 151
      expect([charge('ada', { bytes: 151 }), castOff], `${first} began first`).toEqual([
        expected.isKept,
        expected.castOff,
      ]);
    }
  });
});
