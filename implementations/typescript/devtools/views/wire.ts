// ── The Wire view ─────────────────────────────────────────────────────────────

// For a page whose clients announce nothing: each exchange of the HTTP transport the Network panel
// saw, a line each — its time, its method and its path as they were, its status, the bytes each way —
// and its envelopes beneath, read with the package's codec, each procedure named where a client of
// the page told its name, a PAYLOAD_INVALID's violations summed up on its line. A `POST` with no body
// is a listen.

// dependencies

import { EnvelopeKind } from '../../src/router/shared/constants';
import { KEEP_ALL, type IKeeper } from '../model/filter';
import { conversationOf } from '../model/snippets';
import { bytesOf, clockOf, envelopeLineOf, failureLineOf, violationsReadOf } from '../model/words';
import type { IWireEnvelope, IWireReading } from '../wire';
import { keyOfRecord, filterCountOf, listen, make } from './dom';

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
  keeper?: IKeeper;
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
    ...(failure === undefined ? [] : [failureLineOf(failure)]),
  ].join(' · ');
};

/** An envelope's line: its words, and a PAYLOAD_INVALID's whole detail where its line sums it up. */
const envelopeLineViewOf = (
  envelope: IWireEnvelope,
  { arrow, nameOf }: { arrow: string; nameOf: IWireView['nameOf'] }
): HTMLElement => {
  const { failure } = envelope;
  const isSummed = failure !== undefined && violationsReadOf(failure) !== undefined;

  return make('div', {
    attributes: { title: isSummed ? failure.detail : undefined },
    className: isSummed ? 'summed' : undefined,
    text: `${arrow} ${envelopeTextOf(envelope, nameOf)}`,
  });
};

const linesOf = (
  reading: IWireReading | string | undefined,
  {
    arrow,
    nameOf,
    hasHidden = false,
  }: { arrow: string; nameOf: IWireView['nameOf']; hasHidden?: boolean }
): HTMLElement[] => {
  if (reading === undefined) {
    return [make('div', { text: `${arrow} reading…` })];
  }

  if (typeof reading === 'string') {
    return [make('div', { text: `${arrow} ${reading}` })];
  }

  return [
    ...reading.envelopes.map((envelope) => {
      return envelopeLineViewOf(envelope, { arrow, nameOf });
    }),
    ...(reading.problem === undefined
      ? []
      : [make('div', { text: `${arrow} does not read: ${reading.problem}` })]),
    ...(reading.envelopes.length === 0 && reading.problem === undefined && !hasHidden
      ? [make('div', { text: `${arrow} no envelope` })]
      : []),
  ];
};

// definition

/** The Wire view, an exchange a block. */
export const wireViewOf = (view: IWireView): Node[] => {
  if (!view.isAvailable) {
    return [
      filterCountOf(0),
      make('p', {
        className: 'note',
        text: 'The Network panel’s exchanges reach this panel in DevTools alone.',
      }),
    ];
  }

  if (view.exchanges.length === 0) {
    return [
      filterCountOf(0),
      make('p', {
        className: 'note',
        text: 'No exchange of application/prs.bead yet: the HTTP transport’s appear here, read with the package’s codec.',
      }),
    ];
  }

  const keeper = view.keeper ?? KEEP_ALL;
  let hidden = 0;
  const sections = view.exchanges.flatMap((exchange) => {
    const names = new Map<number, string>();
    for (const reading of [exchange.request, exchange.response]) {
      if (reading === undefined || typeof reading === 'string') {
        continue;
      }
      for (const envelope of reading.envelopes) {
        if (Number(envelope.header['kind']) === EnvelopeKind.REQUEST) {
          const name = view.nameOf({
            procedureId: Number(envelope.header['procedureId']),
            serviceId: Number(envelope.header['serviceId']),
          });
          if (name !== undefined) {
            names.set(Number(envelope.header['callId']), name);
          }
        }
      }
    }
    const filtered = (
      reading: IWireReading | string | undefined,
      direction: string
    ): IWireReading | string | undefined => {
      if (reading === undefined || typeof reading === 'string') {
        return reading;
      }
      return {
        ...reading,
        envelopes: reading.envelopes.filter((envelope) => {
          const kept =
            keeper.keepsProcedure(names.get(Number(envelope.header['callId']))) &&
            keeper.keepsEnvelope({
              at: exchange.startedAt,
              source: 0,
              kind: 'envelope',
              connectionHandle: '',
              direction,
              header: envelope.header,
            });
          if (!kept) {
            hidden += 1;
          }
          return kept;
        }),
      };
    };
    const request = filtered(exchange.request, 'tx') as IWireReading | string;
    const response = filtered(exchange.response, 'rx');
    const hasEnvelope = [request, response].some((reading) => {
      return typeof reading === 'object' && reading.envelopes.length > 0;
    });
    const hadEnvelope = [exchange.request, exchange.response].some((reading) => {
      return typeof reading === 'object' && reading.envelopes.length > 0;
    });
    if (hadEnvelope && !hasEnvelope) {
      return [];
    }
    const url = new URL(exchange.url);
    const copy = make('button', {
      attributes: { type: 'button' },
      className: 'link',
      text: 'Copy as conversation',
    });

    listen(copy, {
      type: 'click',
      handle: () => {
        view.copy(
          conversationOf({
            request: typeof request === 'string' ? [] : request.envelopes,
            response:
              response === undefined || typeof response === 'string' ? [] : response.envelopes,
          })
        );
      },
    });

    return [
      make('section', {
        attributes: { 'data-row': keyOfRecord(exchange) },
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
              ...(request === 'listen'
                ? []
                : linesOf(request, {
                    arrow: '→',
                    nameOf: view.nameOf,
                    hasHidden:
                      typeof exchange.request === 'object' &&
                      typeof request === 'object' &&
                      exchange.request.envelopes.length > request.envelopes.length,
                  })),
              ...linesOf(response, {
                arrow: '←',
                nameOf: view.nameOf,
                hasHidden:
                  typeof exchange.response === 'object' &&
                  typeof response === 'object' &&
                  exchange.response.envelopes.length > response.envelopes.length,
              }),
            ],
            className: 'envelopes',
          }),
        ],
        className: 'exchange',
      }),
    ];
  });
  return [filterCountOf(hidden), ...sections];
};
