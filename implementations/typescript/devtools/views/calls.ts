// ── The Calls view ────────────────────────────────────────────────────────────

// One row a call, newest first, with headed columns: its status by an icon, its call id, its
// procedure, its type, when it started, how long it took, how it ended in words, and its bar on the
// waterfall. A row unfolds into its envelopes, a line each, in words. Its other mode, Envelopes,
// lists every envelope on its own, for whoever reads the wire.

// dependencies

import type { IEnvelopeRecord } from '../messages';
import type { ICall, IMarker } from '../model/calls';
import {
  anchorOf,
  answeredAtOf,
  destinationOf,
  endOf,
  outcomeOf,
  startOf,
  statusOf,
  subscriptionOf,
  transferOf,
} from '../model/facts';
import type { ISpan } from '../model/scale';
import { bytesOf, clockOf, envelopeLineOf, numberOf, spanOf } from '../model/words';
import { make, statusIconOf } from './dom';

// interfaces

/** What the list draws. */
export interface ICallList {
  /** The calls shown, in the order they opened. */
  calls: readonly ICall[];
  expanded: ReadonlySet<number>;
  isAllClients: boolean;
  markers: readonly IMarker[];
  /** The name of a call's procedure, as a step told it, or its ids. */
  nameOf: (call: ICall) => string;
  now: number;
  selected: number | undefined;
  /** The span the waterfall spreads over. */
  span: ISpan | undefined;
}

/** What the Envelopes mode draws. */
export interface IEnvelopeList {
  envelopes: readonly { call: ICall; envelope: IEnvelopeRecord }[];
  isAllClients: boolean;
  nameOf: (call: ICall) => string;
}

// helpers

const arrowOf = (direction: string): string => {
  return direction === 'tx' ? '→' : '←';
};

/** A call's id as the list shows it, its client first when every client's are shown. */
export const callLabelOf = (call: ICall, isAllClients: boolean): string => {
  const id = call.callId === undefined ? '—' : `#${String(call.callId)}`;

  return isAllClients ? `${String(call.source)}·${id}` : id;
};

/** A call's type, as the list reads it. */
export const typeWordsOf = (call: ICall): string => {
  if (call.isNotification) {
    return 'notification';
  }

  if (call.isIncoming) {
    return 'command, in';
  }

  const subscription = subscriptionOf(call);

  if (subscription !== undefined) {
    return subscription.isPaced ? 'subscription, paced' : 'subscription';
  }

  return 'request';
};

/** How long a call took, or has been waiting. */
export const durationWordsOf = (call: ICall, now: number): string => {
  const status = statusOf(call);

  if (status === 'heard') {
    return '';
  }

  if (status === 'open') {
    return 'open';
  }

  if (status === 'flight') {
    return `${spanOf(Math.max(0, now - startOf(call)))}…`;
  }

  const duration =
    call.answer?.duration ?? (answeredAtOf(call) ?? endOf(call) ?? now) - anchorOf(call);

  return spanOf(Math.max(0, duration));
};

const waterfallOf = (
  call: ICall,
  { now, span }: { now: number; span: ISpan | undefined }
): HTMLElement => {
  const box = make('div', { className: 'wf' });

  if (span === undefined) {
    return box;
  }

  const width = Math.max(span.to - span.from, 1);
  const percent = (at: number): number => {
    return Math.min(100, Math.max(0, ((at - span.from) / width) * 100));
  };
  const status = statusOf(call);
  const start = startOf(call);
  const end = endOf(call) ?? now;

  box.append(
    make('i', {
      attributes: {
        style: `left:${String(percent(start))}%;width:${String(Math.max(percent(end) - percent(start), 0.5))}%`,
      },
      className: status,
    }),
    ...call.notifications.map(({ at }) => {
      return make('b', { attributes: { style: `left:${String(percent(at))}%` } });
    })
  );

  return box;
};

const envelopeRowsOf = (
  call: ICall,
  { nameOf }: { nameOf: (call: ICall) => string }
): HTMLElement[] => {
  const anchor = anchorOf(call);
  const heard = new Map(
    call.notifications.map(({ envelope, step }) => {
      return [envelope, step?.rx] as const;
    })
  );
  const rows = call.envelopes.map((envelope) => {
    return make('tr', {
      attributes: { 'data-direction': envelope.direction, 'data-envelope-of': String(call.key) },
      children: [
        make('td'),
        make('td'),
        make('td', {
          className: 'name',
          text: `${arrowOf(envelope.direction)} ${envelopeLineOf(envelope.header)}`,
        }),
        make('td', { className: 'mid' }),
        make('td', { className: 'mid', text: clockOf(envelope.at) }),
        make('td', {
          className: 'num',
          text: `+${numberOf(Math.max(0, Math.round(envelope.at - anchor)))} ms`,
        }),
        make('td', { className: 'outcome', text: heard.get(envelope) ?? '' }),
        make('td', { className: 'wide' }),
      ],
      className: 'envelope',
    });
  });
  const left =
    call.envelopesLetGo === 0
      ? []
      : [
          make('tr', {
            children: [
              make('td', {
                attributes: { colspan: '8' },
                text: `${numberOf(call.envelopesLetGo)} earlier envelopes of ${nameOf(call)} let go: a call keeps its last ${numberOf(call.envelopes.length)}`,
              }),
            ],
            className: 'marker',
          }),
        ];

  return [...left, ...rows];
};

const markerRowOf = (marker: IMarker): HTMLElement => {
  return make('tr', {
    children: [
      make('td', {
        attributes: { colspan: '8' },
        text:
          marker.kind === 'gap'
            ? `${numberOf(marker.count ?? 0)} records let go here, in a burst: the hook holds 5,000 at most between two batches`
            : `Page reloaded at ${clockOf(marker.at)}`,
      }),
    ],
    className: `marker ${marker.kind}`,
  });
};

// definition

/** The rows of the calls, newest first, an unfolded one's envelopes beneath it. */
export const callRowsOf = (list: ICallList): HTMLElement[] => {
  const items: ({ call: ICall; key: number } | { key: number; marker: IMarker })[] = [
    ...list.calls.map((call) => {
      return { call, key: call.key };
    }),
    ...list.markers.map((marker) => {
      return { key: marker.key, marker };
    }),
  ].sort((one, other) => {
    return other.key - one.key;
  });

  return items.flatMap((item) => {
    if ('marker' in item) {
      return [markerRowOf(item.marker)];
    }

    const { call } = item;
    const status = statusOf(call);
    const isExpanded = list.expanded.has(call.key);
    const transfer = transferOf(call);
    const destination = destinationOf(call);
    const name = make('td', {
      children: [
        make('button', {
          attributes: {
            'aria-expanded': String(isExpanded),
            'aria-label': `Envelopes of ${callLabelOf(call, false)}`,
            'data-twist': String(call.key),
            tabindex: '-1',
            type: 'button',
          },
          className: 'twist',
          text: '▶',
        }),
        list.nameOf(call),
        ...(transfer === undefined
          ? []
          : [
              make('span', {
                className: 'tag',
                text: `${transfer.direction === 'tx' ? '↑' : '↓'} ${bytesOf(transfer.total)}`,
              }),
            ]),
        ...(destination === undefined
          ? []
          : [make('span', { className: 'tag', text: `→ dest ${String(destination)}` })]),
      ],
      className: 'name',
    });
    const row = make('tr', {
      attributes: {
        'aria-selected': String(call.key === list.selected),
        'data-key': String(call.key),
        'data-status': status,
      },
      children: [
        make('td', { children: [statusIconOf(status)] }),
        make('td', { text: callLabelOf(call, list.isAllClients) }),
        name,
        make('td', { className: 'mid', text: typeWordsOf(call) }),
        make('td', { className: 'mid', text: clockOf(startOf(call)) }),
        make('td', { className: 'num', text: durationWordsOf(call, list.now) }),
        make('td', { className: 'outcome', text: outcomeOf(call) }),
        make('td', { children: [waterfallOf(call, list)], className: 'wide' }),
      ],
      className: status === 'failed' ? 'call failed' : 'call',
    });

    row.title = [
      call.serviceId === undefined
        ? undefined
        : `service ${String(call.serviceId)}, procedure ${String(call.procedureId)}`,
      call.connectionHandle === undefined ? undefined : `on ${call.connectionHandle}`,
    ]
      .filter(Boolean)
      .join(', ');

    return [row, ...(isExpanded ? envelopeRowsOf(call, list) : [])];
  });
};

/** The rows of the Envelopes mode: every envelope, newest first, a line each. */
export const envelopeListRowsOf = (list: IEnvelopeList): HTMLElement[] => {
  return [...list.envelopes].reverse().map(({ call, envelope }) => {
    return make('tr', {
      attributes: { 'data-direction': envelope.direction, 'data-key': String(call.key) },
      children: [
        make('td', { text: clockOf(envelope.at) }),
        make('td', { text: arrowOf(envelope.direction) }),
        make('td', { text: callLabelOf(call, list.isAllClients) }),
        make('td', { text: list.nameOf(call) }),
        make('td', { className: 'outcome', text: envelopeLineOf(envelope.header) }),
      ],
      className: 'flat',
    });
  });
};
