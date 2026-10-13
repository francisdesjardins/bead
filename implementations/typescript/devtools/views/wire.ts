// ── The Wire view ─────────────────────────────────────────────────────────────

// For a page whose clients announce nothing: each exchange of the HTTP transport the Network panel
// saw, a line each — its time, its method and its path as they were, its status, the bytes each way —
// and its envelopes beneath, read with the package's codec, each procedure named where a client of
// the page told its name. A `POST` with no body is a listen.

// dependencies

import { EnvelopeKind } from '../../src/router/shared/constants';
import { conversationOf } from '../model/snippets';
import { bytesOf, clockOf, codeNameOf, envelopeLineOf } from '../model/words';
import type { IWireEnvelope, IWireReading } from '../wire';
import { make } from './dom';

// interfaces

/** An HTTP exchange the Network panel saw, read. */
export interface IExchange {
  method: string;
  /** What its request's body held, or why it could not be read; `listen` for none. */
  request: IWireReading | string;
  requestBytes: number;
  /** What its answer's body held, or why it could not be read; none until DevTools gives it. */
  response?: IWireReading | string | undefined;
  responseBytes?: number | undefined;
  /** When it started, in milliseconds since the epoch. */
  startedAt: number;
  status: number;
  url: string;
}

/** What the Wire view draws. */
export interface IWireView {
  /** Copies a text, saying so. */
  copy: (text: string) => void;
  exchanges: readonly IExchange[];
  /** Whether the browser hands the panel the Network panel's exchanges. */
  isAvailable: boolean;
  /** A procedure's name, as a client of the page told it. */
  nameOf: (address: { procedureId: number; serviceId: number }) => string | undefined;
}

// helpers

const envelopeTextOf = (
  { failure, header, payloadBytes }: IWireEnvelope,
  nameOf: IWireView['nameOf']
): string => {
  const kind = Number(header['kind']);
  const name =
    kind === EnvelopeKind.REQUEST
      ? (nameOf({
          procedureId: Number(header['procedureId']),
          serviceId: Number(header['serviceId']),
        }) ?? `service ${String(header['serviceId'])} · procedure ${String(header['procedureId'])}`)
      : undefined;

  return [
    header['advisory'] === true ? 'advisory' : envelopeLineOf(header),
    `#${String(header['callId'] ?? '')}`,
    ...(name === undefined ? [] : [name]),
    ...(payloadBytes === undefined ? [] : [bytesOf(payloadBytes)]),
    ...(failure === undefined
      ? []
      : [`${codeNameOf(failure.code)}${failure.detail === '' ? '' : `: ${failure.detail}`}`]),
  ].join(' · ');
};

const linesOf = (
  reading: IWireReading | string | undefined,
  { arrow, nameOf }: { arrow: string; nameOf: IWireView['nameOf'] }
): HTMLElement[] => {
  if (reading === undefined) {
    return [make('div', { text: `${arrow} reading…` })];
  }

  if (typeof reading === 'string') {
    return [make('div', { text: `${arrow} ${reading}` })];
  }

  return [
    ...reading.envelopes.map((envelope) => {
      return make('div', { text: `${arrow} ${envelopeTextOf(envelope, nameOf)}` });
    }),
    ...(reading.problem === undefined
      ? []
      : [make('div', { text: `${arrow} does not read: ${reading.problem}` })]),
    ...(reading.envelopes.length === 0 && reading.problem === undefined
      ? [make('div', { text: `${arrow} no envelope` })]
      : []),
  ];
};

// definition

/** The Wire view, an exchange a block. */
export const wireViewOf = (view: IWireView): Node[] => {
  if (!view.isAvailable) {
    return [
      make('p', {
        className: 'note',
        text: 'The Network panel’s exchanges reach this panel in DevTools alone.',
      }),
    ];
  }

  if (view.exchanges.length === 0) {
    return [
      make('p', {
        className: 'note',
        text: 'No exchange of application/prs.bead yet: the HTTP transport’s appear here, read with the package’s codec.',
      }),
    ];
  }

  return view.exchanges.map((exchange) => {
    const url = new URL(exchange.url);
    const copy = make('button', {
      attributes: { type: 'button' },
      className: 'link',
      text: 'Copy as conversation',
    });
    const { request, response } = exchange;

    copy.addEventListener('click', () => {
      view.copy(
        conversationOf({
          request: typeof request === 'string' ? [] : request.envelopes,
          response:
            response === undefined || typeof response === 'string' ? [] : response.envelopes,
        })
      );
    });

    return make('section', {
      children: [
        make('div', {
          children: [
            make('span', { text: clockOf(exchange.startedAt) }),
            make('b', { className: 'request-line', text: `${exchange.method} ${url.pathname}` }),
            make('span', { text: String(exchange.status) }),
            make('span', {
              className: 'note',
              text: `sent ${request === 'listen' ? 'nothing: a listen' : bytesOf(exchange.requestBytes)}, received ${exchange.responseBytes === undefined ? '…' : bytesOf(exchange.responseBytes)}`,
            }),
            copy,
          ],
          className: 'line',
        }),
        make('div', {
          children: [
            ...(request === 'listen' ? [] : linesOf(request, { arrow: '→', nameOf: view.nameOf })),
            ...linesOf(response, { arrow: '←', nameOf: view.nameOf }),
          ],
          className: 'envelopes',
        }),
      ],
      className: 'exchange',
    });
  });
};
