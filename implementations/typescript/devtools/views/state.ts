// ── The State view ────────────────────────────────────────────────────────────

// What a client's connection held at the moment the cursor stands on, rebuilt from the panel's
// records: its session, the calls in flight, the subscriptions and their credit, the transfers and
// how far they went. Live follows the last record; the cursor reads back, and replays nothing.

// dependencies

import type { ICall } from '../model/calls';
import { startOf } from '../model/facts';
import type { ISpan } from '../model/scale';
import { type IStateAt, stateAt } from '../model/state';
import { bytesOf, clockOf, numberOf, schemeNameOf, spanOf } from '../model/words';
import { factsOf, make } from './dom';

// interfaces

/** What the State view draws. */
export interface IStateView {
  /** The moment shown; none for Live. */
  at: number | undefined;
  calls: readonly ICall[];
  /** What the panel let go before its first call, which the state does not hold. */
  callsLetGo: number;
  nameOf: (call: ICall) => string;
  now: number;
  /** Moves the cursor, to a moment or back to Live. */
  onScrub: (at: number | undefined) => void;
  span: ISpan | undefined;
}

// helpers

const labelOf = (call: ICall, nameOf: (call: ICall) => string): string => {
  return `${nameOf(call)}${call.callId === undefined ? '' : ` #${String(call.callId)}`}`;
};

const tableOf = (
  heads: readonly string[],
  rows: readonly (readonly (Node | string)[])[]
): HTMLElement => {
  return make('table', {
    children: [
      make('thead', {
        children: [
          make('tr', {
            children: heads.map((head) => {
              return make('th', { attributes: { scope: 'col' }, text: head });
            }),
          }),
        ],
      }),
      make('tbody', {
        children: rows.map((cells) => {
          return make('tr', {
            children: cells.map((cell) => {
              return make('td', { children: [cell] });
            }),
          });
        }),
      }),
    ],
    className: 'plain',
  });
};

const sectionOf = (
  title: string,
  { body, count, empty }: { body: Node | undefined; count?: string | undefined; empty: string }
): HTMLElement => {
  return make('div', {
    children: [
      make('h2', {
        children: [
          title,
          ...(count === undefined ? [] : [make('span', { className: 'count', text: count })]),
        ],
      }),
      body ?? make('p', { className: 'note', text: empty }),
    ],
    className: 'sect',
  });
};

const sessionOf = (state: IStateAt, nameOf: (call: ICall) => string): HTMLElement => {
  const { announced, isAnyMade, presented, refused } = state.session;

  return sectionOf('Session', {
    body: factsOf([
      [
        'Presented',
        !isAnyMade
          ? 'no call made yet'
          : presented === undefined
            ? 'no credential of its own, on the last call'
            : `${schemeNameOf(presented)}, on the last call, by its scheme alone`,
      ],
      [
        'Connection’s',
        announced === undefined
          ? 'none announced yet'
          : `${announced.state === 'opened' ? 'a session, OPAQUE' : 'none: its session ended, NONE'}, announced by ${labelOf(announced.call, nameOf)}`,
      ],
      [
        'Refused for it',
        refused.length === 0
          ? 'none'
          : refused
              .map((call) => {
                return `${labelOf(call, nameOf)}, SESSION_REQUIRED`;
              })
              .join('; '),
      ],
    ]),
    empty: '',
  });
};

/** The sections of a state: its session, its calls in flight, its subscriptions, its transfers. */
const sectionsOf = (state: IStateAt, view: IStateView): Node[] => {
  const { nameOf } = view;
  const { at } = state;

  return [
    sessionOf(state, nameOf),
    sectionOf('In flight', {
      body:
        state.inFlight.length === 0
          ? undefined
          : tableOf(
              ['Call', 'Started', 'Waiting', 'Timeout'],
              state.inFlight.map((call) => {
                const timeout = call.opening?.timeout;

                return [
                  labelOf(call, nameOf),
                  clockOf(startOf(call)),
                  spanOf(Math.max(0, at - startOf(call))),
                  timeout === undefined ? '' : timeout === 'never' ? 'never' : spanOf(timeout),
                ];
              })
            ),
      count: numberOf(state.inFlight.length),
      empty: 'No call waits for its answer.',
    }),
    sectionOf('Subscriptions', {
      body:
        state.subscriptions.length === 0
          ? undefined
          : tableOf(
              ['Procedure', 'Pace', 'State', 'Heard', 'Credit', 'Latest'],
              state.subscriptions.map((subscription) => {
                const { credited, heard } = subscription;
                const meter =
                  credited === undefined
                    ? 'pushed, no credit'
                    : make('span', {
                        children: [
                          make('span', {
                            attributes: {
                              title: `${numberOf(heard)} heard of ${numberOf(credited)} credited`,
                            },
                            children: Array.from({ length: Math.min(credited, 12) }, (_, index) => {
                              return make('i', { className: index < heard ? 'on' : '' });
                            }),
                            className: 'meter',
                          }),
                          ` ${numberOf(Math.max(0, credited - heard))} free`,
                        ],
                      });

                return [
                  labelOf(subscription.call, nameOf),
                  subscription.isPaced ? 'paced' : 'pushed',
                  !subscription.isAnswered
                    ? 'opening'
                    : subscription.isOpen
                      ? 'open'
                      : `ended by ${subscription.endedBy ?? 'its connection'}`,
                  numberOf(heard),
                  meter,
                  subscription.latest === undefined
                    ? '—'
                    : `${subscription.latest.text} at ${clockOf(subscription.latest.at)}`,
                ];
              })
            ),
      count: `${numberOf(
        state.subscriptions.filter(({ isOpen }) => {
          return isOpen;
        }).length
      )} open`,
      empty: 'None yet.',
    }),
    sectionOf('Transfers', {
      body:
        state.transfers.length === 0
          ? undefined
          : tableOf(
              ['Call', 'Way', 'Progress', 'Passed', 'Credit'],
              state.transfers.map((transfer) => {
                return [
                  labelOf(transfer.call, nameOf),
                  `${transfer.direction === 'tx' ? '↑' : '↓'} its ${transfer.of}`,
                  make('div', {
                    children: [
                      make('i', {
                        attributes: {
                          style: `width:${String((transfer.passed / transfer.total) * 100)}%`,
                        },
                      }),
                    ],
                    className: 'bar-mini',
                  }),
                  `${transfer.isWhole ? '' : 'at least '}${bytesOf(transfer.passed)} of ${bytesOf(transfer.total)}`,
                  transfer.credited === undefined ? 'none seen' : bytesOf(transfer.credited),
                ];
              })
            ),
      count: `${numberOf(
        state.transfers.filter(({ isWhole }) => {
          return !isWhole;
        }).length
      )} under way`,
      empty: 'None yet.',
    }),
    sectionOf('Connection', {
      body: undefined,
      empty: 'The hook does not yet tell a client’s transport, its address or its state.',
    }),
  ];
};

// definition

/** The State view at its cursor. */
export const stateViewOf = (view: IStateView): Node[] => {
  const { calls, span } = view;

  if (span === undefined) {
    return [
      make('p', {
        className: 'note',
        text: 'No call yet: the state builds from the calls the panel hears.',
      }),
    ];
  }

  const at = view.at ?? view.now;
  const range = make('input', {
    attributes: {
      'aria-label': 'The moment shown',
      max: String(Math.ceil(Math.max(span.to, view.now))),
      min: String(Math.floor(span.from)),
      step: '1',
      type: 'range',
      value: String(Math.round(at)),
    },
  }) as HTMLInputElement;
  const live = make('button', {
    attributes: { 'aria-pressed': String(view.at === undefined), type: 'button' },
    text: 'Live',
  });
  const when = make('span', { className: 'when', text: clockOf(at) });
  const body = make('div', { children: sectionsOf(stateAt(calls, at), view) });
  // * the cursor redraws what it reads in place, so a drag is never cut short by a redraw of itself
  const show = (moment: number): void => {
    when.textContent = clockOf(moment);
    body.replaceChildren(...sectionsOf(stateAt(calls, moment), view));
  };

  range.id = 'at';
  live.id = 'live';
  range.addEventListener('input', () => {
    const moment = Number(range.value);

    view.onScrub(moment);
    live.setAttribute('aria-pressed', 'false');
    show(moment);
  });
  live.addEventListener('click', () => {
    view.onScrub(undefined);
    live.setAttribute('aria-pressed', 'true');
    range.value = range.max;
    show(view.now);
  });

  const scrub = make('div', {
    children: [
      when,
      range,
      live,
      make('span', {
        className: 'said',
        text: `As the panel saw it, rebuilt from its records up to this moment; nothing is sent to the page.${view.callsLetGo === 0 ? '' : ` It holds the last calls alone: ${numberOf(view.callsLetGo)} before them were let go.`}`,
      }),
    ],
    className: 'scrub',
  });

  return [scrub, body];
};
