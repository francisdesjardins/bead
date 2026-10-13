// ── A call's detail ───────────────────────────────────────────────────────────

// The tabs beside the list, for the call selected: Overview, what it was and how it ended in a
// sentence; Payload, its request and its answer, as a tree where they read as one; Exchange, its
// thread; Diff, what changed against the value before it; Trace, the stack that made it, each frame
// opened in Sources.

// dependencies

import { FailureScope } from '../../src/router/client/router-client';
import type { ICall } from '../model/calls';
import { diffPayloads } from '../model/diff';
import {
  announcedOf,
  answerPayloadOf,
  destinationOf,
  errorOf,
  type IPayload,
  outcomeOf,
  presentedOf,
  requestPayloadOf,
  startOf,
  statusOf,
  subscriptionOf,
  transferOf,
} from '../model/facts';
import { isBranch, isWhole, treeOfText } from '../model/tree';
import { bytesOf, clockOf, numberOf, originWordsOf, schemeNameOf, spanOf } from '../model/words';
import type { PreviewNode } from '../preview';
import type { IStackFrame } from '../stack';
import { durationWordsOf, typeWordsOf } from './calls';
import { factsOf, make, noteOf, statusIconOf } from './dom';
import { threadViewOf } from './thread';

// interfaces

/** What a detail draws with: the calls it compares against, and what it asks of the panel. */
export interface IDetailContext {
  client: string;
  /** Copies a text, saying so. */
  copy: (text: string) => void;
  /** The answer before this one of its procedure, from its client, for the Diff tab. */
  earlier: ICall | undefined;
  nameOf: (call: ICall) => string;
  now: number;
  /** Opens a frame's script in Sources; none where the browser cannot. */
  openResource?: ((url: string, line: number) => void) | undefined;
}

// types

export type DetailTab = 'diff' | 'exchange' | 'overview' | 'payload' | 'trace';

// constants

/** What marks a frame as the package's, or a library's, rather than the page's own code. */
const LIBRARY_FRAME = /\/node_modules\/|@francisdesjardins[/_]bead/;

// helpers

const treeViewOf = (node: PreviewNode, key?: string): Node => {
  const label = key === undefined ? [] : [make('span', { className: 'key', text: key }), ': '];

  if (node === null || typeof node !== 'object') {
    return make('div', {
      children: [
        ...label,
        make('span', {
          className: typeof node === 'string' ? 'string' : '',
          text: JSON.stringify(node),
        }),
      ],
      className: 'leaf',
    });
  }

  const leaf = (text: string): Node => {
    return make('div', {
      children: [...label, make('span', { className: 'tagged', text })],
      className: 'leaf',
    });
  };

  switch (node.type) {
    case 'bigint':
      return leaf(`${node.digits}n`);
    case 'bytes':
      return leaf(
        `<${String(node.length)} bytes${node.length === 0 ? '' : `: ${node.hex}${node.length > 32 ? ' …' : ''}`}>`
      );
    case 'cut':
      return leaf(
        node.reason === 'cycle'
          ? '[cycle]'
          : node.reason === 'depth'
            ? '… deeper than the preview goes'
            : '… past the preview’s budget'
      );
    case 'other':
      return leaf(node.text);
    case 'text':
      return leaf(`${JSON.stringify(node.text)}… ${numberOf(node.more)} more characters`);
    case 'array':
    case 'map':
    case 'object':
    case 'set':
      break;
  }

  const children: Node[] =
    node.type === 'object'
      ? node.entries.map(([name, entry]) => {
          return treeViewOf(entry, JSON.stringify(name));
        })
      : node.type === 'map'
        ? node.entries.map(([name, entry]) => {
            return treeViewOf(
              entry,
              typeof name === 'object' && name !== null ? '{…}' : JSON.stringify(name)
            );
          })
        : node.items.map((item) => {
            return treeViewOf(item);
          });
  const count =
    node.type === 'object' || node.type === 'map' ? node.entries.length : node.items.length;
  const [open, close] =
    node.type === 'array'
      ? ['[', ']']
      : node.type === 'set'
        ? ['Set {', '}']
        : node.type === 'map'
          ? ['Map {', '}']
          : ['{', '}'];

  if (node.cut === true) {
    children.push(make('div', { className: 'tagged', text: '… past the preview’s budget' }));
  }

  if (node.more !== undefined) {
    children.push(make('div', { className: 'tagged', text: `… ${numberOf(node.more)} more` }));
  }

  const details = make('details', {
    children: [
      make('summary', {
        children: [...label, `${open}${String(count + (node.more ?? 0))}${close}`],
      }),
      ...children,
    ],
  });

  (details as HTMLDetailsElement).open = true;

  return details;
};

/** A payload's block: its tree where it reads as one, its text otherwise, and how to copy it. */
const payloadBlockOf = (
  title: string,
  {
    copy,
    missing,
    payload,
  }: { copy: (text: string) => void; missing: string; payload: IPayload | undefined }
): Node[] => {
  if (payload === undefined) {
    return [make('h3', { text: title }), noteOf(missing)];
  }

  const tree = payload.tree ?? treeOfText(payload.text);
  const isBranching = isBranch(tree);
  const raw = make('pre', { text: payload.text });
  const body =
    isBranching && tree !== undefined
      ? make('div', { children: [treeViewOf(tree)], className: 'tree' })
      : raw;
  const isCut = tree === undefined ? payload.text.endsWith('…') : !isWhole(tree);
  const copyButton = make('button', {
    attributes: { type: 'button' },
    className: 'link',
    text: 'Copy',
  });
  const rawButton = make('button', {
    attributes: { type: 'button' },
    className: 'link',
    text: 'Raw',
  });

  copyButton.addEventListener('click', () => {
    copy(payload.text);
  });
  rawButton.addEventListener('click', () => {
    body.replaceWith(raw);
    rawButton.remove();
  });

  return [
    make('h3', {
      children: [
        title,
        make('span', { className: 'spacer' }),
        ...(isBranching ? [rawButton] : []),
        copyButton,
      ],
    }),
    body,
    ...(isCut
      ? [
          noteOf(
            'The preview is cut short: it holds 2,000 characters, four levels and fifty entries at most.'
          ),
        ]
      : []),
  ];
};

const overviewOf = (call: ICall, context: IDetailContext): Node[] => {
  const status = statusOf(call);
  const error = errorOf(call);
  const transfer = transferOf(call);
  const destination = destinationOf(call);
  const scheme = presentedOf(call);
  const announced = announcedOf(call);
  const subscription = subscriptionOf(call);
  const timeout = call.opening?.timeout;
  const facts = factsOf([
    [
      'Call',
      call.callId === undefined
        ? 'none: refused before its call id was drawn'
        : `#${String(call.callId)}${call.isIncoming ? ', opened by the server' : ''}`,
    ],
    [
      'Procedure',
      `${context.nameOf(call)}${call.serviceId === undefined ? '' : ` (service ${String(call.serviceId)}, procedure ${String(call.procedureId)}${call.serviceRevision === undefined ? '' : `, revision ${String(call.serviceRevision)}`})`}`,
    ],
    [
      'Type',
      `${typeWordsOf(call)}${subscription?.isPaced === true ? ', credited as it settles' : ''}`,
    ],
    ['Client', context.client],
    ['Connection', call.connectionHandle],
    [
      'Destination',
      destination === undefined ? undefined : `${String(destination)}, through the server’s relay`,
    ],
    [
      'Credential',
      call.isIncoming
        ? undefined
        : scheme === undefined
          ? 'none of its own'
          : `${schemeNameOf(scheme)}, by its scheme alone`,
    ],
    [
      'Session',
      announced === undefined
        ? undefined
        : announced === 'opened'
          ? 'its answer announced one, OPAQUE'
          : 'its answer announced it ended, NONE',
    ],
    ['Started', clockOf(startOf(call))],
    ['Duration', durationWordsOf(call, context.now) || undefined],
    [
      'Timeout',
      timeout === undefined
        ? undefined
        : timeout === 'never'
          ? 'never'
          : `${spanOf(timeout)}${call.opening?.closeOnTimeout === true ? ', its connection closed past it' : ''}`,
    ],
    [
      'Transfer',
      transfer === undefined
        ? undefined
        : `${transfer.of === 'request' ? 'its request' : 'its answer'}, ${bytesOf(transfer.total)} (${numberOf(transfer.total)} bytes)`,
    ],
    [
      'Envelopes',
      call.envelopes.length === 0
        ? undefined
        : `${numberOf(call.envelopes.length + call.envelopesLetGo)}${call.envelopesLetGo === 0 ? '' : `, the last ${numberOf(call.envelopes.length)} kept`}`,
    ],
  ]);
  const box = (
    className: string,
    { more = [], text }: { more?: string[]; text: string }
  ): HTMLElement => {
    return make('div', {
      children: [
        make('b', { text }),
        ...more.flatMap((line) => {
          return [make('br'), line];
        }),
      ],
      className: `outcome-box ${className}`,
    });
  };
  let outcome: HTMLElement;

  if (status === 'failed') {
    outcome = box('failed', {
      more:
        error?.code === undefined
          ? [error?.message ?? '']
          : [
              `${error.scope === FailureScope.APPLICATION ? 'The procedure’s own code' : 'A protocol code'}${originWordsOf(error) === undefined ? '' : `, ${originWordsOf(error) ?? ''}`}${error.destinationId === undefined ? '' : `, for destination ${String(error.destinationId)}`}.`,
              ...(error.detail === undefined ? [] : [error.detail]),
            ],
      text: `Failed: ${outcomeOf(call)}.`,
    });
  } else if (status === 'ended') {
    outcome = box('ended', {
      more: ['Its call id stays reserved a while, so a late answer is dropped in silence.'],
      text: `Ended without an answer: ${outcomeOf(call)}.`,
    });
  } else if (status === 'flight') {
    outcome = box('', {
      text:
        call.callId === undefined && call.request === undefined
          ? 'Refused before it went.'
          : 'Waiting for its answer.',
    });
  } else if (status === 'open' || status === 'closed') {
    outcome = box(status === 'closed' ? 'ended' : '', {
      more: [
        `${numberOf(subscription?.heard ?? 0)} notifications heard${subscription?.credited === undefined ? '' : `, credited up to ${numberOf(subscription.credited)}`}.`,
        ...(status === 'open'
          ? ['A connection that closes ends it too, which the hook does not yet tell.']
          : []),
      ],
      text:
        status === 'open'
          ? 'Subscription open.'
          : `Subscription ended by ${subscription?.endedBy ?? 'its connection'}.`,
    });
  } else if (status === 'heard') {
    outcome = box('', {
      text: 'A notification heard, on a subscription the panel did not see open.',
    });
  } else {
    outcome = box('', { text: `Answered in ${durationWordsOf(call, context.now)}.` });
  }

  return [facts, outcome];
};

const payloadOf = (call: ICall, context: IDetailContext): Node[] => {
  const status = statusOf(call);
  const missing =
    status === 'failed'
      ? 'None: it failed, as Overview says.'
      : status === 'ended'
        ? `None: ${outcomeOf(call)}.`
        : status === 'flight'
          ? 'None yet.'
          : 'None.';
  const latest = call.notifications.at(-1)?.step;
  const [first, second] = call.isIncoming
    ? ['Request, from the server', 'Answer, from this page']
    : call.isNotification
      ? ['', 'Notification']
      : ['Request', 'Answer'];

  return [
    ...(call.isNotification
      ? []
      : payloadBlockOf(first, {
          copy: context.copy,
          missing: 'None.',
          payload: requestPayloadOf(call),
        })),
    ...payloadBlockOf(second, { copy: context.copy, missing, payload: answerPayloadOf(call) }),
    ...(latest?.rx === undefined
      ? []
      : payloadBlockOf('Latest notification', {
          copy: context.copy,
          missing: '',
          payload: { text: latest.rx, tree: latest.rxTree },
        })),
  ];
};

const diffBlockOf = (
  heading: Node[],
  { after, before }: { after: IPayload; before: IPayload }
): HTMLElement => {
  const lines = diffPayloads(before, after);
  const isSame = lines.every(({ change }) => {
    return change === 'same';
  });

  return make('div', {
    children: [
      make('header', { children: heading }),
      isSame
        ? noteOf('The same.')
        : make('pre', {
            children: lines.map(({ change, text }) => {
              return make('span', {
                className: change,
                text: `${change === 'added' ? '+ ' : change === 'removed' ? '- ' : '  '}${text}`,
              });
            }),
            className: 'diff',
          }),
    ],
    className: 'diff-item',
  });
};

const diffOf = (call: ICall, context: IDetailContext): Node[] => {
  const subscription = subscriptionOf(call);

  if (subscription !== undefined) {
    const answer = answerPayloadOf(call);
    const values = [
      ...(answer === undefined ? [] : [{ at: startOf(call), name: 'its answer', payload: answer }]),
      ...call.notifications.flatMap(({ at, step }, index) => {
        return step?.rx === undefined
          ? []
          : [
              {
                at,
                name: `notification ${numberOf(call.notificationsLetGo + index + 1)}`,
                payload: { text: step.rx, tree: step.rxTree },
              },
            ];
      }),
    ];
    const items = values.slice(1).map((value, index) => {
      const before = values[index] ?? value;

      return diffBlockOf(
        [
          make('span', { text: value.name }),
          make('span', { text: clockOf(value.at) }),
          make('span', { text: `against ${before.name}` }),
        ],
        { after: value.payload, before: before.payload }
      );
    });

    return [
      noteOf(
        'Each notification against the one before it on this subscription: a notification’s key never travels, so none is compared by key.'
      ),
      ...(items.length === 0 ? [noteOf('Nothing to compare yet.')] : items.reverse()),
    ];
  }

  const after = answerPayloadOf(call);
  const before = context.earlier === undefined ? undefined : answerPayloadOf(context.earlier);

  if (after === undefined || before === undefined || context.earlier === undefined) {
    return [
      noteOf(`No earlier answer of ${context.nameOf(call)} from this client to compare with.`),
    ];
  }

  return [
    noteOf(
      `This answer against the last one of ${context.nameOf(call)}, call ${context.earlier.callId === undefined ? '' : `#${String(context.earlier.callId)} `}at ${clockOf(startOf(context.earlier))}.`
    ),
    diffBlockOf([make('span', { text: 'before → this one' })], { after, before }),
  ];
};

const frameOf = (frame: IStackFrame, context: IDetailContext): HTMLElement => {
  const where = `${frame.url}:${String(frame.line)}:${String(frame.column)}`;
  const open = context.openResource;
  const link =
    open === undefined
      ? make('span', { text: where })
      : make('button', { attributes: { title: 'Open in Sources', type: 'button' }, text: where });

  if (open !== undefined) {
    link.addEventListener('click', () => {
      open(frame.url, frame.line);
    });
  }

  return make('li', {
    children: [make('span', { className: 'fn', text: frame.functionName ?? '(anonymous)' }), link],
  });
};

const traceOf = (call: ICall, context: IDetailContext): Node[] => {
  if (call.isIncoming || call.isNotification) {
    return [noteOf('The server made this call: no stack of the page’s made it.')];
  }

  const frames = call.opening?.stack;

  if (frames === undefined || frames.length === 0) {
    return [
      noteOf(
        'The hook took no stack for this call: it takes one as a call is made, while a panel watches.'
      ),
    ];
  }

  const own = frames.filter(({ url }) => {
    return !LIBRARY_FRAME.test(url);
  });
  const libraries = frames.length - own.length;

  return [
    noteOf(
      'The stack that made this call, as the hook took it as the call went: one capture a call, only while a panel watches.'
    ),
    make('ul', {
      children: frames
        .filter(({ url }) => {
          return !LIBRARY_FRAME.test(url);
        })
        .map((frame) => {
          return frameOf(frame, context);
        }),
      className: 'frames',
    }),
    ...(libraries === 0
      ? []
      : [
          make('details', {
            children: [
              make('summary', {
                text: `${numberOf(libraries)} ${libraries === 1 ? 'frame' : 'frames'} of libraries, the package’s among them`,
              }),
              make('ul', {
                children: frames
                  .filter(({ url }) => {
                    return LIBRARY_FRAME.test(url);
                  })
                  .map((frame) => {
                    return frameOf(frame, context);
                  }),
                className: 'frames',
              }),
            ],
          }),
        ]),
  ];
};

// definition

/** The detail of a call, its title then the tab asked for. */
export const detailOf = (
  call: ICall,
  { context, tab }: { context: IDetailContext; tab: DetailTab }
): Node[] => {
  const title = make('div', {
    children: [
      statusIconOf(statusOf(call)),
      context.nameOf(call),
      make('span', {
        className: 'count',
        text: call.callId === undefined ? '' : `#${String(call.callId)}`,
      }),
    ],
    className: 'title',
  });
  const views = {
    diff: diffOf,
    exchange: (shown: ICall, { client }: IDetailContext) => {
      return threadViewOf(shown, { client });
    },
    overview: overviewOf,
    payload: payloadOf,
    trace: traceOf,
  } as const;

  return [title, ...views[tab](call, context)];
};
