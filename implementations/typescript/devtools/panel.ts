// ── DevTools panel ────────────────────────────────────────────────────────────

// The Bead panel (decision 0015): the clients the inspected page announced, their calls and their
// envelopes, filtered by the package's own filter, what their registries count, and, for a page
// with no hook, the HTTP transport's exchanges the Network panel saw. Opened outside DevTools, as
// its tests open it, it reads its tab from `?tabId=` and has no Network panel to read.

// dependencies

import { CredentialScheme, FailureScope, ProtocolCode } from '../src/router/client/router-client';
import { EnvelopeKind } from '../src/router/shared/constants';
import { filterDebug, filterEnvelopeDebug } from '../src/router/shared/debug-filter';
import type { IDebugEvent } from '../src/router/shared/types';
import { chromeOf, type IHarEntry, type IPort } from './chrome';
import { type IProcedureMetrics, metricsOf, quantileOf } from './exposition';
import type {
  ActivityRecord,
  BackgroundMessage,
  ICallRecord,
  IEnvelopeRecord,
  IPanelGreeting,
  ISourceRecord,
  PanelMessage,
} from './messages';
import { PORTS, PROTOCOLS } from './messages';
import { bytesOfContent, isBeadType, type IWireReading, readBody } from './wire';

// interfaces

/** An HTTP exchange the Network panel saw, read. */
interface IExchange {
  method: string;
  /** What its request's body held, or why it could not be read. */
  request: IWireReading | string;
  /** What its answer's body held, or why it could not be read; none until DevTools gives it. */
  response?: IWireReading | string | undefined;
  startedAt: string;
  status: number;
  url: string;
}

// types

type View = 'calls' | 'envelopes' | 'metrics' | 'wire';

// constants

/** The records each list keeps, newest first; the oldest are let go past them. */
const KEPT = 1_000;

/** How often the registries are read, while the Metrics view is shown, in milliseconds. */
const METRICS_MILLISECONDS = 1_000;

/** How long a panel whose port closed waits before it opens another, in milliseconds. */
const RECONNECT_MILLISECONDS = 1_000;

const namesOf = (values: Record<string, number>): ReadonlyMap<number, string> => {
  return new Map(
    Object.entries(values).map(([name, value]) => {
      return [value, name];
    })
  );
};

const CODE_NAMES = namesOf(ProtocolCode);
const KIND_NAMES = namesOf(EnvelopeKind);
const SCHEME_NAMES = namesOf(CredentialScheme);

const numbers = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 3 });

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the panel has no #${id}`);
  }

  return element;
};

/** An element of `tag`, its class and its text. */
const make = (
  tag: string,
  { className, text }: { className?: string; text?: string }
): HTMLElement => {
  const element = document.createElement(tag);

  if (className !== undefined) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
};

const timeOf = (milliseconds: number): string => {
  const date = new Date(milliseconds);

  return `${date.toLocaleTimeString('en-CA', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
};

const arrowOf = (direction: string): string => {
  return direction === 'tx' ? '→' : '←';
};

/** What a call's step ended with, as a person reads it. */
const outcomeOf = ({ direction, error }: ICallRecord): string => {
  if (error === undefined) {
    return direction === 'tx' ? '' : 'ok';
  }

  if (error.code === undefined) {
    return error.name;
  }

  return error.scope === FailureScope.APPLICATION
    ? `the procedure's code ${String(error.code)}`
    : (CODE_NAMES.get(error.code) ?? `code ${String(error.code)}`);
};

/** A header's fields after its kind and call id, as one line. */
const headerLineOf = (header: IEnvelopeRecord['header']): string => {
  return Object.entries(header)
    .filter(([name]) => {
      return name !== 'kind' && name !== 'callId';
    })
    .map(([name, value]) => {
      return name === 'credentialScheme'
        ? `credential ${SCHEME_NAMES.get(Number(value)) ?? String(value)}`
        : `${name} ${String(value)}`;
    })
    .join(', ');
};

/** Whether `record` passes the filter `spec` makes, read by the package's own filter. */
const keeperOf = (spec: string): ((record: ActivityRecord) => boolean) => {
  let isKept = false;
  const keep = (): void => {
    isKept = true;
  };
  const calls = filterDebug(keep, spec);
  const envelopes = filterEnvelopeDebug(keep, spec);

  return (record) => {
    isKept = false;

    if (record.kind === 'call') {
      calls(null, record as unknown as IDebugEvent);
    } else {
      envelopes({
        direction: record.direction as 'rx' | 'tx',
        header: { kind: Number(record.header['kind']) as EnvelopeKind },
      });
    }

    return isKept;
  };
};

// definition

const chrome = chromeOf();
const tabId =
  chrome.devtools?.inspectedWindow.tabId ??
  Number(new URLSearchParams(location.search).get('tabId'));
const shown = {
  calls: elementOf('calls'),
  clear: elementOf('clear') as HTMLButtonElement,
  detail: elementOf('detail'),
  envelopes: elementOf('envelopes'),
  filter: elementOf('filter') as HTMLInputElement,
  filterState: elementOf('filter-state'),
  metrics: elementOf('metrics'),
  source: elementOf('source') as HTMLSelectElement,
  status: elementOf('status'),
  wire: elementOf('wire'),
};
const state = {
  calls: [] as ICallRecord[],
  dropped: 0,
  envelopes: [] as IEnvelopeRecord[],
  exchanges: [] as IExchange[],
  expositions: new Map<number, string | null>(),
  keeps: (_record: ActivityRecord): boolean => {
    return true;
  },
  selected: undefined as ICallRecord | undefined,
  sources: [] as ISourceRecord[],
  view: 'calls' as View,
};
let port: IPort | undefined;
let isDrawing = false;

const tell = (message: PanelMessage): void => {
  port?.postMessage(message);
};

const isShownSource = (source: number): boolean => {
  return shown.source.value === 'all' || shown.source.value === String(source);
};

const drawCalls = (): void => {
  const rows = state.calls
    .filter((record) => {
      return isShownSource(record.source) && state.keeps(record);
    })
    .map((record) => {
      const row = document.createElement('tr');
      const cells = [
        timeOf(record.startedAt + (record.direction === 'rx' ? (record.duration ?? 0) : 0)),
        arrowOf(record.direction),
        record.type,
        record.procedureName,
        record.duration === undefined ? '' : `${numbers.format(record.duration)} ms`,
        outcomeOf(record),
      ];

      row.append(
        ...cells.map((text) => {
          return make('td', { text });
        })
      );
      row.dataset['direction'] = record.direction;
      row.title = `service ${String(record.serviceId)}, procedure ${String(record.procedureId)}`;

      if (record.error !== undefined) {
        row.classList.add('failed');
      }

      if (record === state.selected) {
        row.classList.add('selected');
      }

      row.addEventListener('click', () => {
        state.selected = record;
        draw();
      });

      return row;
    });

  shown.calls.replaceChildren(...rows);
  drawDetail();
};

const drawDetail = (): void => {
  const record = state.selected;

  if (record === undefined) {
    shown.detail.replaceChildren(
      make('p', { className: 'note', text: 'Select a call to see what went across.' })
    );

    return;
  }

  const facts: [string, string | undefined][] = [
    ['Client', `client ${String(record.source)}`],
    [
      'Procedure',
      `${record.procedureName} (service ${String(record.serviceId)}, revision ${String(record.serviceRevision)}, procedure ${String(record.procedureId)})`,
    ],
    ['Type', `${record.type}, ${record.direction === 'tx' ? 'out' : 'in'}`],
    ['Started', new Date(record.startedAt).toISOString()],
    [
      'Duration',
      record.duration === undefined ? undefined : `${numbers.format(record.duration)} ms`,
    ],
    [
      'Timeout',
      record.timeout === undefined
        ? undefined
        : record.timeout === 'never'
          ? 'never'
          : `${numbers.format(record.timeout)} ms`,
    ],
    [
      'Credential',
      record.credentialScheme === undefined
        ? undefined
        : (SCHEME_NAMES.get(record.credentialScheme) ?? String(record.credentialScheme)),
    ],
    [
      'Failed',
      record.error === undefined
        ? undefined
        : [outcomeOf(record), record.error.detail ?? record.error.message].join(' — '),
    ],
  ];
  const list = make('dl', { className: 'facts' });

  for (const [name, value] of facts) {
    if (value !== undefined) {
      list.append(make('dt', { text: name }), make('dd', { text: value }));
    }
  }

  const payloads = (['tx', 'rx'] as const).flatMap((direction) => {
    const preview = record[direction];

    return preview === undefined
      ? []
      : [
          make('h3', { text: direction === 'tx' ? 'Sent' : 'Received' }),
          make('pre', { text: preview }),
        ];
  });

  shown.detail.replaceChildren(list, ...payloads);
};

const drawEnvelopes = (): void => {
  shown.envelopes.replaceChildren(
    ...state.envelopes
      .filter((record) => {
        return isShownSource(record.source) && state.keeps(record);
      })
      .map((record) => {
        const row = document.createElement('tr');
        const kind = Number(record.header['kind']);

        row.append(
          make('td', { text: timeOf(record.at) }),
          make('td', { text: arrowOf(record.direction) }),
          make('td', { text: KIND_NAMES.get(kind) ?? `0x${kind.toString(16)}` }),
          make('td', { text: `#${String(record.header['callId'] ?? '')}` }),
          make('td', { text: headerLineOf(record.header) })
        );
        row.dataset['direction'] = record.direction;

        return row;
      })
  );
};

/** A registry's lines, one a procedure that saw a call or a notification, as the demo shows them. */
const metricsLineOf = (row: IProcedureMetrics): HTMLElement | undefined => {
  const { buckets, count, notifications, outcomes, procedure, role, started, type } = row;
  const chip = (text: string, className = 'chip'): HTMLElement => {
    return make('span', { className, text });
  };
  const milliseconds = (quantile: number): string => {
    return `${numbers.format((quantileOf(buckets, quantile) ?? 0) * 1_000)} ms`;
  };
  const chips = [
    ...(started === 0 ? [] : [chip(`${numbers.format(count)} ${role}`)]),
    ...(type === 'request' || started === 0 ? [] : [chip(type, 'chip quiet')]),
    ...(started > count ? [chip(`${numbers.format(started - count)} in flight`)] : []),
    ...(count === 0
      ? []
      : [chip(`median ≈ ${milliseconds(0.5)}`), chip(`p95 ≈ ${milliseconds(0.95)}`)]),
    ...[...outcomes, ...notifications]
      .filter(([outcome, value]) => {
        return outcome !== 'result' && value > 0;
      })
      .map(([outcome, value]) => {
        const isFailure =
          outcomes.has(outcome) || outcome === 'not sent' || outcome.startsWith('dropped');

        return chip(`${numbers.format(value)} ${outcome}`, isFailure ? 'chip failure' : 'chip');
      }),
  ];

  if (chips.length === 0) {
    return undefined;
  }

  const line = make('li', {});
  const held = make('span', { className: 'chips' });

  held.append(...chips);
  line.append(make('span', { className: 'name', text: procedure }), held);

  return line;
};

const drawMetrics = (): void => {
  const blocks = state.sources
    .filter(({ id }) => {
      return isShownSource(id);
    })
    .map(({ id }) => {
      const block = make('section', { className: 'registry' });
      const text = state.expositions.get(id);

      block.append(make('h3', { text: `Client ${String(id)}` }));

      if (text === undefined) {
        block.append(make('p', { className: 'note', text: 'Reading…' }));
      } else if (text === null) {
        block.append(
          make('p', {
            className: 'note',
            text: 'This client was given no metrics registry: give it one, as its metricsRegistry, to see what it counts.',
          })
        );
      } else {
        const lines = metricsOf(text, []).flatMap((row) => {
          const line = metricsLineOf(row);

          return line === undefined ? [] : [line];
        });
        const list = make('ul', { className: 'lines' });
        const raw = make('details', {});

        list.append(
          ...(lines.length === 0
            ? [make('li', { className: 'note', text: 'Nothing counted yet.' })]
            : lines)
        );
        raw.append(
          make('summary', { text: 'Its exposition, as a scrape reads it' }),
          make('pre', { text })
        );
        block.append(list, raw);
      }

      return block;
    });

  // an open exposition stays open across a redraw
  const open = new Set(
    [...shown.metrics.querySelectorAll('details[open]')].map((details) => {
      return details.parentElement?.querySelector('h3')?.textContent;
    })
  );

  for (const block of blocks) {
    const details = block.querySelector('details');

    if (details !== null && open.has(block.querySelector('h3')?.textContent)) {
      details.open = true;
    }
  }

  shown.metrics.replaceChildren(
    ...(blocks.length === 0
      ? [make('p', { className: 'note', text: 'No client announced itself yet.' })]
      : blocks)
  );
};

const readingOf = (reading: IWireReading | string | undefined): string => {
  if (reading === undefined) {
    return 'reading…';
  }

  if (typeof reading === 'string') {
    return reading;
  }

  const lines = reading.envelopes.map(({ failure, header, payloadBytes }) => {
    const kind = Number(header['kind']);

    return [
      KIND_NAMES.get(kind) ?? 'advisory',
      `#${String(header['callId'] ?? '')}`,
      headerLineOf(header),
      payloadBytes === undefined ? '' : `${numbers.format(payloadBytes)} bytes`,
      failure === undefined
        ? ''
        : `${CODE_NAMES.get(failure.code) ?? `code ${String(failure.code)}`} ${failure.detail}`,
    ]
      .filter(Boolean)
      .join(' ');
  });

  return (
    [
      ...lines,
      ...(reading.problem === undefined ? [] : [`does not read: ${reading.problem}`]),
    ].join('\n') || 'no envelope'
  );
};

const drawWire = (): void => {
  if (chrome.devtools?.network === undefined) {
    shown.wire.replaceChildren(
      make('p', {
        className: 'note',
        text: 'The Network panel’s exchanges reach this panel in DevTools alone.',
      })
    );

    return;
  }

  shown.wire.replaceChildren(
    ...(state.exchanges.length === 0
      ? [
          make('p', {
            className: 'note',
            text: 'No exchange of application/prs.bead yet: the HTTP transport’s appear here, read with the package’s codec.',
          }),
        ]
      : state.exchanges.map((exchange) => {
          const block = make('section', { className: 'exchange' });
          const path = new URL(exchange.url).pathname;

          block.append(
            make('h3', { text: `${exchange.method} ${path} — ${String(exchange.status)}` }),
            make('pre', { text: `→ ${readingOf(exchange.request).replaceAll('\n', '\n→ ')}` }),
            make('pre', { text: `← ${readingOf(exchange.response).replaceAll('\n', '\n← ')}` })
          );

          return block;
        }))
  );
};

const draw = (): void => {
  if (isDrawing) {
    return;
  }

  isDrawing = true;
  requestAnimationFrame(() => {
    isDrawing = false;

    for (const view of document.querySelectorAll<HTMLElement>('[data-view]')) {
      view.hidden = view.dataset['view'] !== state.view;
    }

    for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]')) {
      tab.setAttribute('aria-selected', String(tab.dataset['tab'] === state.view));
    }

    if (state.view === 'calls') {
      drawCalls();
    } else if (state.view === 'envelopes') {
      drawEnvelopes();
    } else if (state.view === 'metrics') {
      drawMetrics();
    } else {
      drawWire();
    }
  });
};

const drawSources = (): void => {
  const chosen = shown.source.value;
  const options = [
    new Option('All clients', 'all'),
    ...state.sources.map(({ id, protocol }) => {
      return new Option(
        PROTOCOLS.includes(protocol)
          ? `Client ${String(id)}`
          : `Client ${String(id)}, protocol ${String(protocol)}, unknown`,
        String(id)
      );
    }),
  ];

  shown.source.replaceChildren(...options);
  shown.source.value = options.some(({ value }) => {
    return value === chosen;
  })
    ? chosen
    : 'all';
};

const take = (records: ActivityRecord[]): void => {
  for (const record of records) {
    const list: ActivityRecord[] = record.kind === 'call' ? state.calls : state.envelopes;

    list.unshift(record);

    if (list.length > KEPT) {
      list.length = KEPT;
    }
  }
};

const hear = (message: BackgroundMessage): void => {
  switch (message.type) {
    case 'expositions':
      for (const { source, text } of message.expositions) {
        state.expositions.set(source, text);
      }
      break;
    case 'page-connected':
      shown.status.textContent = 'connected to the page';
      shown.status.dataset['state'] = 'open';
      tell({ type: 'read-expositions' });
      break;
    case 'page-gone':
      shown.status.textContent = 'the page is gone: waiting for it';
      shown.status.dataset['state'] = 'closed';
      state.sources = [];
      drawSources();
      break;
    case 'records':
      state.dropped += message.dropped;
      take(message.records);
      break;
    case 'sources':
      state.sources = message.sources;
      drawSources();
      break;
    default:
      break;
  }

  if (state.dropped > 0) {
    shown.status.textContent = `connected to the page; ${numbers.format(state.dropped)} records let go in bursts`;
  }

  draw();
};

const connect = (): void => {
  const opened = chrome.runtime.connect({ name: PORTS.panel });
  const greeting: IPanelGreeting = { tabId, type: 'panel' };

  opened.onMessage.addListener((message) => {
    hear(message as BackgroundMessage);
  });
  // the background, a service worker, may stop: the panel reaches it again
  opened.onDisconnect.addListener(() => {
    port = undefined;
    shown.status.textContent = 'reconnecting…';
    shown.status.dataset['state'] = 'closed';
    setTimeout(connect, RECONNECT_MILLISECONDS);
  });
  opened.postMessage(greeting);
  port = opened;
};

const takeExchange = (entry: IHarEntry): void => {
  const { postData } = entry.request;

  if (!isBeadType(postData?.mimeType) && !isBeadType(entry.response.content.mimeType)) {
    return;
  }

  const requestBytes =
    postData?.text === undefined || postData.text === ''
      ? undefined
      : bytesOfContent({ encoding: postData.encoding, text: postData.text });
  const exchange: IExchange = {
    method: entry.request.method,
    request:
      postData === undefined
        ? 'no body'
        : requestBytes === undefined
          ? 'its body is not one DevTools hands an extension'
          : readBody(requestBytes, 'envelope'),
    startedAt: entry.startedDateTime,
    status: entry.response.status,
    url: entry.request.url,
  };

  state.exchanges.unshift(exchange);
  state.exchanges.length = Math.min(state.exchanges.length, KEPT);
  entry.getContent((content, encoding) => {
    const bytes = content === null ? undefined : bytesOfContent({ encoding, text: content });

    exchange.response =
      content === null || content === ''
        ? 'no body'
        : bytes === undefined
          ? 'its body did not come as bytes'
          : readBody(bytes, 'batch');
    draw();
  });
  draw();
};

// the panel follows DevTools' theme, not the system's
document.documentElement.dataset['theme'] =
  chrome.devtools?.panels.themeName === 'dark' ? 'dark' : 'light';

for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    state.view = tab.dataset['tab'] as View;

    if (state.view === 'metrics') {
      tell({ type: 'read-expositions' });
    }

    draw();
  });
}

shown.filter.addEventListener('input', () => {
  const spec = shown.filter.value;

  try {
    state.keeps = keeperOf(spec);
    shown.filterState.textContent = '';
  } catch (reason) {
    state.keeps = () => {
      return true;
    };
    shown.filterState.textContent = reason instanceof Error ? reason.message : String(reason);
  }

  draw();
});

shown.source.addEventListener('change', draw);

shown.clear.addEventListener('click', () => {
  state.calls = [];
  state.envelopes = [];
  state.exchanges = [];
  state.dropped = 0;
  state.selected = undefined;
  draw();
});

// the registries, each second the Metrics view is shown
setInterval(() => {
  if (state.view === 'metrics' && document.visibilityState === 'visible') {
    tell({ type: 'read-expositions' });
  }
}, METRICS_MILLISECONDS);

chrome.devtools?.network.onRequestFinished.addListener(takeExchange);
connect();
draw();
