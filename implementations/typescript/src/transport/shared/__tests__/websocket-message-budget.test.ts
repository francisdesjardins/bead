import { expect, test } from '@playwright/test';
import { createMessageBudget, type IMessageBudget } from '../websocket-message-budget';

// holders of `budget` by their names, each past its grace as `pastGrace` names it; those another's
// charge casts off, in order
const holdersOf = (
  budget: IMessageBudget,
  { names, pastGrace = [] }: { names: readonly string[]; pastGrace?: readonly string[] }
) => {
  const castOff: string[] = [];
  const holders = new Map(
    names.map((name) => {
      return [
        name,
        budget.holderOf({
          castOff: () => {
            castOff.push(name);
          },
          isPastGrace: () => {
            return pastGrace.includes(name);
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
  test('casts off with 1013 the connections whose messages hold the most when a charge would pass messageBytesBudget, the newcomer only when it holds the most', () => {
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

    // dave's 234 passes it, more than any other holds: he alone is cast off, his charge not
    // taken, his own cast-off his caller's
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

  // spec 15.12; rationale of decision 0056
  test('casts off a message past its grace before one within it', () => {
    const budget = createMessageBudget(3_200);
    const { castOff, charge } = holdersOf(budget, {
      names: ['ada', 'bob', 'carol'],
      pastGrace: ['ada', 'carol'],
    });

    charge('ada', { bytes: 1_576, isFirst: true });
    charge('carol', { bytes: 100, isFirst: true });

    // bob's 1,636 holds the most, within his grace: ada, past hers, goes first, and alone fits it
    expect([charge('bob', { bytes: 1_636, isFirst: true }), castOff, budget.held]).toEqual([
      true,
      ['ada'],
      1_736,
    ]);

    // carol, past her grace, goes before bob, though she holds far less
    expect([charge('bob', { bytes: 1_500 }), castOff, budget.held]).toEqual([
      true,
      ['ada', 'carol'],
      3_136,
    ]);
  });
});
