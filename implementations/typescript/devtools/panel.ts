// ── DevTools panel ────────────────────────────────────────────────────────────

// The Bead panel (decision 0015), the same in every browser: the clients the inspected page
// announced and their calls, a row a call with its envelopes beneath, filtered by the package's
// own filter; a call's detail; the state of a connection at any moment the panel recorded; every
// call on a time axis; what the registries count; and, for a page with no hook, the HTTP
// transport's exchanges the Network panel saw. What it asks of its browser is its host's.

// dependencies

import type { IParticipantInspection } from '../src/transport/shared/participant-debug';
import { brokerViewOf } from './views/broker';
import type { IHarEntry, IHostPort, IPanelHost } from './host';
import type {
  ActivityRecord,
  BackgroundMessage,
  IPanelGreeting,
  IParticipantRecord,
  ISourceRecord,
  PanelMessage,
} from './messages';
import { PROTOCOLS } from './messages';
import { metricsOf } from './exposition';
import { createCallBook, type ICall, type ICallBook } from './model/calls';
import {
  endOf,
  requestPayloadOf,
  answerPayloadOf,
  startOf,
  statusOf,
  subscriptionOf,
} from './model/facts';
import { hasWord, KEEP_ALL, keeperOf, keepsCall, toggleWord } from './model/filter';
import { type IReading, withReading } from './model/history';
import { logOf, readLog } from './model/log';
import type { ISpan } from './model/scale';
import { codeOfCall } from './model/snippets';
import { spanOfCalls } from './model/state';
import { clockOf, numberOf } from './model/words';
import { callRowsOf, envelopeListRowsOf } from './views/calls';
import { type DetailTab, detailOf } from './views/detail';
import { make, noteOf, replaceKeeping } from './views/dom';
import { metricsViewOf } from './views/metrics';
import { stateViewOf } from './views/state';
import { fitThreadLabels } from './views/thread';
import { timelineViewOf } from './views/timeline';
import { type IExchange, wireViewOf } from './views/wire';
import { bytesOfContent, isBeadType, readBody } from './wire';

// types

type View = 'broker' | 'calls' | 'metrics' | 'state' | 'timeline' | 'wire';

/** Where the detail sits: as the panel's shape says, right of the list, or under it. */
type Layout = (typeof LAYOUTS)[number];

/** Where the detail sits once `auto` is read. */
type Placement = Exclude<Layout, 'auto'>;

// constants

/** The exchanges the Wire view keeps, newest first. */
const EXCHANGES_KEPT = 1_000;

/** How often the panel redraws what time moves — a call in flight — and reads the registries. */
const TICK_MILLISECONDS = 1_000;

/** How long a panel whose port closed waits before it opens another, in milliseconds. */
const RECONNECT_MILLISECONDS = 1_000;

/** How long a word the panel says, "Copied" say, stays. */
const TOAST_MILLISECONDS = 1_600;

/** The detail's layouts, as DevTools' Elements panel offers its own. */
const LAYOUTS = Object.freeze(['auto', 'right', 'bottom'] as const);

/** The split's width past which `auto` puts the detail beside the list, as the Elements panel's. */
const AUTO_RIGHT_WIDTH = 680;

/** The list's share of the split, in percent: by default, and a key's step. */
const SHARE = Object.freeze({ default: 60, step: 5 });

/** The calls a list over its detail keeps in sight, however tight the panel. */
const LIST_ROWS = 8;

/** The least each side of the split keeps, in pixels, where what is drawn asks no more. */
const SIDES = Object.freeze({
  bottom: Object.freeze({ detail: 160, list: 240 }),
  right: Object.freeze({ detail: 260, list: 240 }),
});

/** What the panel's page keeps, under its own keys: its layout, and a share for each placement. */
const KEPT = Object.freeze({
  layout: 'bead-devtools-layout',
  share: Object.freeze({
    bottom: 'bead-devtools-share-bottom',
    right: 'bead-devtools-share-right',
  }),
});

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the panel has no #${id}`);
  }

  return element;
};

/** What the panel's page keeps under `key`, or nothing where its storage is absent or refuses. */
const readKept = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Keeps `value` under `key`; a storage that refuses leaves the choice to this page alone. */
const keep = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // the choice holds until the panel closes
  }
};

const layoutOf = (kept: string | null): Layout => {
  return (
    LAYOUTS.find((layout) => {
      return layout === kept;
    }) ?? 'auto'
  );
};

const shareOf = (kept: string | null): number => {
  const share = kept === null ? Number.NaN : Number(kept);

  return Number.isFinite(share) && share > 0 && share < 100 ? share : SHARE.default;
};

const isTyping = (target: EventTarget | null): boolean => {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
};

// definition

/** Starts the panel on its page, over what `host` gives it. */
export const startPanel = (host: IPanelHost): void => {
  const shown = {
    broker: elementOf('broker'),
    calls: elementOf('calls'),
    callsTable: elementOf('calls-table'),
    callsView: elementOf('calls-view'),
    clear: elementOf('clear') as HTMLButtonElement,
    detail: elementOf('detail'),
    detailTabs: elementOf('detail-tabs'),
    empty: elementOf('empty'),
    envelopes: elementOf('envelopes'),
    envelopesTable: elementOf('envelopes-table'),
    export: elementOf('export') as HTMLButtonElement,
    filter: elementOf('filter') as HTMLInputElement,
    filterHelp: elementOf('filter-help'),
    filterHelpButton: elementOf('filter-help-button') as HTMLButtonElement,
    filterState: elementOf('filter-state'),
    footer: elementOf('footer'),
    import: elementOf('import') as HTMLButtonElement,
    importFile: elementOf('import-file') as HTMLInputElement,
    layout: elementOf('layout') as HTMLSelectElement,
    list: elementOf('list'),
    menu: elementOf('menu'),
    metrics: elementOf('metrics'),
    preserve: elementOf('preserve') as HTMLInputElement,
    range: elementOf('range'),
    record: elementOf('record') as HTMLButtonElement,
    source: elementOf('source') as HTMLSelectElement,
    splitter: elementOf('splitter'),
    state: elementOf('state'),
    status: elementOf('status'),
    timeline: elementOf('timeline'),
    toast: elementOf('toast'),
    wire: elementOf('wire'),
  };
  const recordOrder = new WeakMap<ActivityRecord, number>();
  let nextRecord = 0;
  const state = {
    at: undefined as number | undefined,
    participants: [] as IParticipantRecord[],
    participantDropped: 0,
    skipped: 0,
    participantFilters: { kind: '', connection: '', verdict: '' },
    participantSelected: undefined as IParticipantRecord | undefined,
    inspections: new Map<number, IParticipantInspection>(),
    sourceArchive: new Map<number, ISourceRecord>(),
    isImported: false,
    book: undefined as unknown as ICallBook,
    detailTab: 'overview' as DetailTab,
    dropped: 0,
    exchanges: [] as IExchange[],
    expanded: new Set<number>(),
    expositions: new Map<number, string | null>(),
    hidden: undefined as string | undefined,
    history: new Map<number, IReading[]>(),
    isFailedOnly: false,
    isGone: false,
    isRecording: true,
    keeper: KEEP_ALL,
    mode: 'calls' as 'calls' | 'envelopes',
    pausedLetGo: 0,
    range: undefined as ISpan | undefined,
    selected: undefined as number | undefined,
    sources: [] as ISourceRecord[],
    view: 'calls' as View,
    wasGone: false,
  };
  let port: IHostPort | undefined;
  let isDrawing = false;
  let envelopeAt: number | undefined;

  // the detail's place and the split, kept by the panel's page
  const split = {
    layout: layoutOf(readKept(KEPT.layout)),
    shares: {
      bottom: shareOf(readKept(KEPT.share.bottom)),
      right: shareOf(readKept(KEPT.share.right)),
    } satisfies Record<Placement, number>,
  };
  // the share Enter restores, by placement, once it has sent the detail to its least
  const restored: Record<Placement, number | undefined> = { bottom: undefined, right: undefined };
  // the call and tab the detail last drew, which a redraw of the same keeps as its reader left it
  let detailShown: string | undefined;

  const placementOf = (): Placement => {
    if (split.layout === 'auto') {
      // * DevTools' Elements panel's rule: its sidebar beside a split wider than 680 px, else under
      const width = shown.callsView.getBoundingClientRect().width || innerWidth;

      return width > AUTO_RIGHT_WIDTH ? 'right' : 'bottom';
    }

    return split.layout;
  };

  /** What each side keeps: the detail its whole tab bar, the list its rows, as they are drawn. */
  const floorsOf = (placement: Placement): { detail: number; list: number } => {
    const sides = SIDES[placement];

    if (placement === 'right') {
      // ! read to the fraction: offsets round, and a bar a pixel short of its tabs scrolls
      const last = shown.detailTabs.lastElementChild;
      const bar =
        last instanceof HTMLElement
          ? last.getBoundingClientRect().right -
            shown.detailTabs.getBoundingClientRect().left +
            Number.parseFloat(getComputedStyle(shown.detailTabs).paddingRight)
          : 0;

      return { detail: Math.max(sides.detail, Math.ceil(bar)), list: sides.list };
    }

    const table = shown.list.querySelector<HTMLElement>('table:not([hidden])');
    const bar = shown.list.querySelector<HTMLElement>('.list-bar')?.offsetHeight ?? 0;
    const head = table?.querySelector<HTMLElement>('thead')?.offsetHeight ?? 0;
    const row = table?.querySelector<HTMLElement>('tbody tr')?.offsetHeight ?? 0;

    return {
      detail: sides.detail,
      list: Math.max(sides.list, Math.ceil(bar + head + LIST_ROWS * row)),
    };
  };

  /** The list's least and greatest share, in percent: the list keeps its least first. */
  const limitsOf = (placement: Placement): { max: number; min: number } => {
    const box = shown.callsView.getBoundingClientRect();
    const size = (placement === 'right' ? box.width : box.height) - 1;
    const floors = floorsOf(placement);
    const min = Math.min(100, Math.ceil((floors.list / size) * 1_000) / 10);

    if (size <= floors.list + floors.detail) {
      return { max: min, min };
    }

    return { max: Math.floor((1 - floors.detail / size) * 1_000) / 10, min };
  };

  const shareShown = (placement: Placement): number => {
    const { max, min } = limitsOf(placement);

    return Math.min(max, Math.max(min, split.shares[placement]));
  };

  const layOut = (): void => {
    shown.layout.value = split.layout;

    if (shown.callsView.hidden) {
      return;
    }

    const placement = placementOf();
    const { max, min } = limitsOf(placement);
    const share = shareShown(placement);
    const tracks = `minmax(0, ${String(share)}fr) 1px minmax(0, ${String(100 - share)}fr)`;

    shown.callsView.dataset['layout'] = placement;
    shown.callsView.style.gridTemplate =
      placement === 'right' ? `minmax(0, 1fr) / ${tracks}` : `${tracks} / minmax(0, 1fr)`;
    shown.splitter.setAttribute(
      'aria-orientation',
      placement === 'right' ? 'vertical' : 'horizontal'
    );
    shown.splitter.setAttribute('aria-valuemin', String(min));
    shown.splitter.setAttribute('aria-valuemax', String(max));
    shown.splitter.setAttribute('aria-valuenow', String(share));
  };

  const moveSplit = (value: number, { isKept }: { isKept: boolean }): void => {
    const placement = placementOf();
    const { max, min } = limitsOf(placement);

    split.shares[placement] = Math.round(Math.min(max, Math.max(min, value)) * 10) / 10;

    if (isKept) {
      keep(KEPT.share[placement], String(split.shares[placement]));
    }

    layOut();
  };
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const sideOf = (source: number): string | undefined => {
    return state.sources.find(({ id }) => {
      return id === source;
    })?.side;
  };

  const newBook = (): ICallBook => {
    return createCallBook({ sideOf });
  };

  state.book = newBook();

  const tell = (message: PanelMessage): void => {
    port?.postMessage(message);
  };

  const say = (text: string): void => {
    shown.toast.textContent = text;
    shown.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      shown.toast.hidden = true;
    }, TOAST_MILLISECONDS);
  };

  // a DevTools panel may be refused the clipboard's API; a selection copied is the fallback
  const copy = (text: string): void => {
    const fallback = (): void => {
      const area = make('textarea', { text }) as HTMLTextAreaElement;

      document.body.append(area);
      area.select();
      // oxlint-disable-next-line typescript/no-deprecated -- the one copy a panel denied the clipboard's API has
      document.execCommand('copy');
      area.remove();
      say('Copied');
    };

    navigator.clipboard.writeText(text).then(
      () => {
        say('Copied');
      },
      () => {
        fallback();
      }
    );
  };

  const nameOf = (call: ICall): string => {
    if (call.procedureName !== undefined) {
      return call.procedureName;
    }

    if (call.serviceId !== undefined && call.procedureId !== undefined) {
      return (
        state.book.nameOf({
          procedureId: call.procedureId,
          serviceId: call.serviceId,
          source: call.source,
        }) ?? `service ${String(call.serviceId)} · procedure ${String(call.procedureId)}`
      );
    }

    return 'a call not seen open';
  };

  const isShownSource = (source: number): boolean => {
    return shown.source.value === 'all' || shown.source.value === String(source);
  };

  // a call's client is named beside its id when more than one client's calls are shown
  const isEveryClient = (): boolean => {
    return (
      shown.source.value === 'all' &&
      new Set(
        state.book.calls.map(({ source }) => {
          return source;
        })
      ).size > 1
    );
  };

  /** The calls the list shows, in the order they opened. */
  const visibleCalls = (): ICall[] => {
    const now = Date.now();

    return state.book.calls.filter((call) => {
      if (!isShownSource(call.source) || !keepsCall(call, state.keeper)) {
        return false;
      }

      if (state.isFailedOnly && statusOf(call) !== 'failed') {
        return false;
      }

      const { range } = state;

      return (
        range === undefined || (startOf(call) <= range.to && (endOf(call) ?? now) >= range.from)
      );
    });
  };

  const selectedCall = (): ICall | undefined => {
    return state.book.calls.find(({ key }) => {
      return key === state.selected;
    });
  };

  const earlierOf = (call: ICall): ICall | undefined => {
    return state.book.calls
      .filter((other) => {
        return (
          other.key < call.key &&
          other.source === call.source &&
          other.serviceId === call.serviceId &&
          other.procedureId === call.procedureId &&
          statusOf(other) === 'answered' &&
          answerPayloadOf(other) !== undefined
        );
      })
      .at(-1);
  };

  const clientOf = (source: number): string => {
    return `Client ${String(source)}`;
  };

  const drawEmpty = (visible: readonly ICall[]): void => {
    const chosen = state.sources.find(({ id }) => {
      return String(id) === shown.source.value;
    });

    if (chosen !== undefined && !PROTOCOLS.includes(chosen.protocol)) {
      shown.empty.replaceChildren(
        noteOf(
          `Client ${String(chosen.id)} speaks hook protocol ${String(chosen.protocol)}, which this extension does not read. Update the extension to see its calls.`
        )
      );

      return;
    }

    if (visible.length > 0) {
      shown.empty.replaceChildren();

      return;
    }

    if (state.book.calls.length > 0) {
      shown.empty.replaceChildren(noteOf('No call passes this filter.'));

      return;
    }

    if (state.sources.length > 0) {
      shown.empty.replaceChildren(
        noteOf('No call yet: the panel shows the calls made after it opened.')
      );

      return;
    }

    const reload = make('button', { attributes: { type: 'button' }, text: 'Reload the page' });

    reload.addEventListener('click', () => {
      host.reload?.();
    });
    shown.empty.replaceChildren(
      make('div', {
        children: [
          make('h2', { text: 'No Bead client on this page yet.' }),
          make('ul', {
            children: [
              make('li', {
                text: 'The page loaded before the extension: a client announces itself as it is built, so reload the page.',
              }),
              make('li', {
                text: 'Its clients were built with devtools: false, which announces nothing.',
              }),
              make('li', {
                text: 'It makes no Bead client; over HTTP, its exchanges still show in Wire.',
              }),
            ],
          }),
          ...(host.reload === undefined ? [] : [reload]),
        ],
        className: 'empty',
      })
    );
  };

  const drawCalls = (): void => {
    const visible = visibleCalls();
    const now = Date.now();
    const isAllClients = isEveryClient();

    // * a selection the filter or the client now hides is let go, with a word why
    if (
      state.selected !== undefined &&
      !visible.some(({ key }) => {
        return key === state.selected;
      })
    ) {
      state.selected = undefined;
      state.hidden = 'The call selected is hidden by the filter, the client or the span chosen.';
    }

    shown.callsTable.hidden = state.mode !== 'calls';
    shown.envelopesTable.hidden = state.mode !== 'envelopes';

    for (const button of document.querySelectorAll<HTMLElement>('[data-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset['mode'] === state.mode));
    }

    if (state.mode === 'calls') {
      const keys = new Set(
        visible.map(({ key }) => {
          return key;
        })
      );
      const first = visible[0]?.key ?? 0;

      shown.calls.replaceChildren(
        ...callRowsOf({
          calls: visible,
          expanded: state.expanded,
          isAllClients,
          markers: state.book.markers.filter(({ key }) => {
            return key > first || keys.size === 0;
          }),
          nameOf,
          now,
          selected: state.selected,
          span: state.range ?? spanOfCalls(visible),
        })
      );
    } else {
      shown.envelopes.replaceChildren(
        ...envelopeListRowsOf({
          envelopes: visible
            .flatMap((call) => {
              return call.envelopes
                .filter((envelope) => {
                  return state.keeper.keepsEnvelope(envelope);
                })
                .map((envelope) => {
                  return { call, envelope };
                });
            })
            .sort((one, other) => {
              return one.envelope.at - other.envelope.at;
            }),
          isAllClients,
          nameOf,
          selected: state.selected,
        })
      );
    }

    const range = state.range;

    if (range === undefined) {
      shown.range.replaceChildren();
    } else {
      const chip = make('button', {
        attributes: { title: 'Show every span again', type: 'button' },
        className: 'chip',
        text: `${clockOf(range.from)} to ${clockOf(range.to)} ✕`,
      });

      chip.addEventListener('click', () => {
        state.range = undefined;
        draw();
      });
      shown.range.replaceChildren(chip);
    }

    drawEmpty(visible);
    drawDetail();
  };

  const drawDetail = (): void => {
    for (const tab of document.querySelectorAll<HTMLElement>('[data-detail]')) {
      const isSelected = tab.dataset['detail'] === state.detailTab;

      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    }

    shown.detail.setAttribute('aria-labelledby', `${state.detailTab}-tab`);

    const call = selectedCall();

    if (call === undefined) {
      detailShown = undefined;
      shown.detail.replaceChildren(
        ...(state.hidden === undefined ? [] : [noteOf(state.hidden)]),
        noteOf(
          'Select a call to see what went across: its payloads, its envelopes, what changed, and what made it.'
        )
      );

      return;
    }

    // * what a reader left in a call's detail is kept while that call and tab stay shown alone
    const subject = `${String(call.key)} ${state.detailTab}`;
    const nodes = detailOf(call, {
      context: {
        client: clientOf(call.source),
        copy,
        earlier: earlierOf(call),
        nameOf,
        now: Date.now(),
        openResource: host.openResource,
      },
      tab: state.detailTab,
    });

    if (subject === detailShown) {
      replaceKeeping(shown.detail, nodes);
    } else {
      shown.detail.replaceChildren(...nodes);
      detailShown = subject;
    }

    fitThreadLabels(shown.detail);
  };

  const drawFooter = (): void => {
    const calls = state.book.calls.filter(({ source }) => {
      return isShownSource(source);
    });
    const count = (status: string): number => {
      return calls.filter((call) => {
        return statusOf(call) === status;
      }).length;
    };
    const subscriptions = calls.filter((call) => {
      return subscriptionOf(call) !== undefined;
    });
    const part = (value: number, words: string): HTMLElement => {
      return make('span', { children: [make('b', { text: numberOf(value) }), ` ${words}`] });
    };

    shown.footer.replaceChildren(
      part(calls.length, calls.length === 1 ? 'call' : 'calls'),
      part(count('failed'), 'failed'),
      part(count('flight'), 'in flight'),
      part(subscriptions.length, `subscriptions, ${numberOf(count('open'))} open`),
      part(state.dropped, 'records let go'),
      make('span', {
        text:
          state.book.callsLetGo === 0
            ? 'kept: the last 1,000 calls'
            : `kept: the last 1,000 calls, ${numberOf(state.book.callsLetGo)} before them let go`,
      }),
      ...(state.isRecording
        ? []
        : [make('span', { text: `paused: ${numberOf(state.pausedLetGo)} records not recorded` })])
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
        view.classList.toggle('page-gone', state.isGone);
      }

      for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]')) {
        const isSelected = tab.dataset['tab'] === state.view;

        tab.setAttribute('aria-selected', String(isSelected));
        tab.tabIndex = isSelected ? 0 : -1;
      }

      shown.record.setAttribute('aria-pressed', String(state.isRecording));
      shown.record.title = state.isRecording
        ? 'Recording: pause (Ctrl+E)'
        : 'Paused: record (Ctrl+E)';

      for (const button of document.querySelectorAll<HTMLElement>('[data-quick]')) {
        const word = button.dataset['quick'] ?? '';

        button.setAttribute(
          'aria-pressed',
          String(word === 'failed' ? state.isFailedOnly : hasWord(shown.filter.value, word))
        );
      }

      drawFooter();

      const calls = state.book.calls.filter(({ source }) => {
        return isShownSource(source);
      });

      if (state.view === 'calls') {
        layOut();
        drawCalls();
      } else if (state.view === 'state') {
        // a cursor being moved keeps its place: it redraws what it reads itself
        if (document.activeElement?.id === 'at' && state.at !== undefined) {
          return;
        }

        replaceKeeping(shown.state, [
          ...stateViewOf({
            at: state.at,
            calls,
            callsLetGo: state.book.callsLetGo,
            nameOf,
            now: Date.now(),
            onScrub: (at) => {
              state.at = at;
              draw();
            },
            span: spanOfCalls(calls),
          }),
        ]);
      } else if (state.view === 'timeline') {
        replaceKeeping(shown.timeline, [
          ...timelineViewOf({
            calls: visibleCalls(),
            isAllClients: isEveryClient(),
            nameOf,
            now: Date.now(),
            onRange: (range) => {
              state.range = range;
              draw();
            },
            range: state.range,
            span: spanOfCalls(calls),
          }),
        ]);
      } else if (state.view === 'broker') {
        replaceKeeping(
          shown.broker,
          brokerViewOf({
            records: state.participants.filter(({ source }) => {
              return isShownSource(source);
            }),
            sources: [...state.sourceArchive.values()].filter(({ id }) => {
              return isShownSource(id);
            }),
            inspections: state.inspections,
            letGo: state.participantDropped,
            filters: state.participantFilters,
            selected: state.participantSelected,
            onFilter: (filters) => {
              state.participantFilters = filters;
              draw();
            },
            onSelect: (record) => {
              state.participantSelected = record;
              draw();
            },
            onState: () => {
              state.view = 'state';
              draw();
            },
          })
        );
      } else if (state.view === 'metrics') {
        replaceKeeping(shown.metrics, metricsOfView());
      } else {
        replaceKeeping(shown.wire, [
          ...wireViewOf({
            copy,
            exchanges: state.exchanges,
            isAvailable: host.onExchange !== undefined,
            nameOf: (address) => {
              return state.book.nameOf(address);
            },
          }),
        ]);
      }
    });
  };

  const metricsOfView = (): Node[] => {
    return metricsViewOf({
      expositions: state.expositions,
      history: state.history,
      onProcedure: (procedure) => {
        shown.filter.value = procedure;
        applyFilter();
        state.view = 'calls';
        draw();
      },
      sources: state.sources
        .map(({ id }) => {
          return id;
        })
        .filter(isShownSource),
    });
  };

  const drawSources = (): void => {
    const chosen = shown.source.value;
    const options = [
      new Option('All clients', 'all'),
      ...state.sources.map(({ id, protocol, side }) => {
        return new Option(
          PROTOCOLS.includes(protocol)
            ? side === 'participant'
              ? `Participant ${String(id)}`
              : clientOf(id)
            : `${clientOf(id)}, protocol ${String(protocol)}, unknown`,
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

  const clear = (): void => {
    state.participants = [];
    state.participantDropped = 0;
    state.skipped = 0;
    state.participantSelected = undefined;
    state.isImported = false;
    state.sourceArchive = new Map(
      state.sources.map((source) => {
        return [source.id, source];
      })
    );
    state.book = newBook();
    state.dropped = 0;
    state.exchanges = [];
    state.expanded.clear();
    state.selected = undefined;
    state.hidden = undefined;
    state.range = undefined;
    state.at = undefined;
    state.pausedLetGo = 0;
    draw();
  };

  const take = (records: readonly ActivityRecord[]): void => {
    for (const record of records) {
      recordOrder.set(record, nextRecord++);
      if (record.kind === 'participant') {
        state.participants.push(record);
        if (state.participants.length > 1_000) {
          const evicted = state.participants.shift();
          if (state.participantSelected === evicted) {
            state.participantSelected = undefined;
          }
          state.participantDropped += 1;
        }
      } else {
        state.book.take(record);
      }
    }
  };

  const setStatus = (text: string, isOpen: boolean): void => {
    shown.status.textContent = text;
    shown.status.dataset['state'] = isOpen ? 'open' : 'closed';
  };

  const hear = (message: BackgroundMessage): void => {
    switch (message.type) {
      case 'participants':
        if (state.isImported || !state.isRecording) {
          break;
        }
        for (const { source, inspection } of message.inspections) {
          state.inspections.set(source, inspection);
        }
        break;
      case 'expositions':
        for (const { source, text } of message.expositions) {
          state.expositions.set(source, text);

          if (text !== null) {
            state.history.set(
              source,
              withReading(state.history.get(source) ?? [], {
                at: Date.now(),
                rows: metricsOf(text, []),
              })
            );
          }
        }
        break;
      case 'page-connected':
        // * the page came back after it went: a reload, which clears the log unless it is preserved
        if (state.wasGone) {
          if (shown.preserve.checked) {
            state.book.mark({ at: Date.now(), kind: 'reload' });
          } else {
            clear();
          }
        }

        state.wasGone = false;
        state.isGone = false;
        setStatus('connected to the page', true);
        tell({ type: 'read-expositions' });
        break;
      case 'page-gone':
        state.wasGone = true;
        state.isGone = true;
        setStatus('the page is gone: its calls stay until you clear them', false);
        break;
      case 'records':
        if (state.isImported) {
          break;
        }
        if (!state.isRecording) {
          const participants = message.records.filter(({ kind }) => {
            return kind === 'participant';
          }).length;
          state.participantDropped += participants + (message.droppedParticipants ?? 0);
          state.pausedLetGo += message.records.length - participants + message.dropped;
          break;
        }

        if (message.dropped > 0) {
          state.dropped += message.dropped;
          state.book.mark({ at: Date.now(), count: message.dropped, kind: 'gap' });
        }

        state.participantDropped += message.droppedParticipants ?? 0;
        take(message.records);
        break;
      case 'sources':
        if (state.isImported) {
          break;
        }
        for (const source of message.sources) {
          const prior = state.sourceArchive.get(source.id);
          state.sourceArchive.set(source.id, prior?.inspection === undefined ? source : prior);
          if (source.inspection !== undefined && !state.inspections.has(source.id)) {
            state.inspections.set(source.id, source.inspection);
          }
        }
        state.sources = message.sources;
        drawSources();
        break;
      default:
        break;
    }

    draw();
  };

  const connect = (): void => {
    const opened = host.connect();
    const greeting: IPanelGreeting = { tabId: host.tabId, type: 'panel' };

    opened.onMessage((message) => {
      hear(message as BackgroundMessage);
    });
    // the background, a service worker, may stop: the panel reaches it again
    opened.onDisconnect(() => {
      port = undefined;
      setStatus('reconnecting…', false);
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
    const isEmpty = postData?.text === undefined || postData.text === '';
    const exchange: IExchange = {
      method: entry.request.method,
      request: isEmpty
        ? entry.request.method === 'POST'
          ? 'listen'
          : 'no body'
        : requestBytes === undefined
          ? 'its body is not one DevTools hands an extension'
          : readBody(requestBytes, 'envelope'),
      requestBytes: requestBytes?.length ?? 0,
      startedAt: Date.parse(entry.startedDateTime),
      status: entry.response.status,
      url: entry.request.url,
    };

    state.exchanges.unshift(exchange);
    state.exchanges.length = Math.min(state.exchanges.length, EXCHANGES_KEPT);
    entry.getContent((content, encoding) => {
      const bytes = content === null ? undefined : bytesOfContent({ encoding, text: content });

      exchange.responseBytes = bytes?.length ?? 0;
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

  const applyFilter = (): void => {
    const spec = shown.filter.value;

    try {
      state.keeper = keeperOf(spec);
      shown.filter.removeAttribute('aria-invalid');
      shown.filterState.textContent = '';
    } catch (reason) {
      // * the last filter that held stays, as a filter given in place does (debugging 6.9)
      shown.filter.setAttribute('aria-invalid', 'true');
      shown.filterState.textContent = `${reason instanceof Error ? reason.message : String(reason)}; the last filter that held stays`;
    }

    draw();
  };

  const select = (key: number | undefined): void => {
    state.selected = key;
    state.hidden = undefined;
    draw();
  };

  const toggleExpanded = (key: number, isExpanded?: boolean): void => {
    if (isExpanded ?? !state.expanded.has(key)) {
      state.expanded.add(key);
    } else {
      state.expanded.delete(key);
    }

    draw();
  };

  const toggleRecording = (): void => {
    state.isRecording = !state.isRecording;
    if (state.isRecording) {
      state.isImported = false;
    }
    say(
      state.isRecording
        ? 'Recording'
        : 'Paused: the hook still listens, and the panel lets its records go'
    );
    draw();
  };

  const closeMenu = (): void => {
    shown.menu.hidden = true;
    shown.menu.replaceChildren();
  };

  const openMenu = (call: ICall, { x, y }: { x: number; y: number }): void => {
    const name = nameOf(call);
    const code = codeOfCall(call);
    const request = requestPayloadOf(call);
    const answer = answerPayloadOf(call);
    const items: [string, (() => void) | undefined][] = [
      [
        'Copy its request',
        request === undefined
          ? undefined
          : () => {
              copy(request.text);
            },
      ],
      [
        'Copy its answer',
        answer === undefined
          ? undefined
          : () => {
              copy(answer.text);
            },
      ],
      [
        'Copy as code',
        code === undefined
          ? undefined
          : () => {
              copy(code);
            },
      ],
      [
        `Hide ${name}`,
        call.procedureName === undefined
          ? undefined
          : () => {
              shown.filter.value = toggleWord(shown.filter.value, `-${name}`);
              applyFilter();
            },
      ],
      [
        `Show ${name} alone`,
        call.procedureName === undefined
          ? undefined
          : () => {
              shown.filter.value = name;
              applyFilter();
            },
      ],
      [
        'Show its envelopes',
        () => {
          toggleExpanded(call.key, true);
        },
      ],
    ];

    shown.menu.replaceChildren(
      ...items.map(([text, action]) => {
        const button = make('button', {
          attributes: {
            role: 'menuitem',
            title:
              text === 'Copy as code' && action === undefined
                ? 'Its payload is cut short, or the server made it'
                : undefined,
            type: 'button',
          },
          text,
        }) as HTMLButtonElement;

        button.disabled = action === undefined;
        button.addEventListener('click', () => {
          closeMenu();
          action?.();
        });

        return button;
      })
    );
    shown.menu.hidden = false;
    shown.menu.style.left = `${String(Math.min(x, innerWidth - shown.menu.offsetWidth - 4))}px`;
    shown.menu.style.top = `${String(Math.min(y, innerHeight - shown.menu.offsetHeight - 4))}px`;
    shown.menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };

  const callOfRow = (target: EventTarget | null): ICall | undefined => {
    const row = target instanceof Element ? target.closest<HTMLElement>('tr[data-key]') : null;
    const key = Number(row?.dataset['key']);

    return state.book.calls.find((call) => {
      return call.key === key;
    });
  };

  const exportLog = (): void => {
    const log = logOf(
      {
        dropped: state.dropped,
        droppedParticipants: state.participantDropped,
        skipped: state.skipped,
        records: [...state.book.recordsOf(), ...state.participants].sort((one, other) => {
          return (recordOrder.get(one) ?? 0) - (recordOrder.get(other) ?? 0);
        }),
        sources: [...state.sourceArchive.values()],
      },
      { savedAt: new Date() }
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' })
    );
    const link = make('a', {
      attributes: { download: `bead-${log.savedAt.replaceAll(':', '-')}.json`, href: url },
    });

    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    say(`Exported ${numberOf(log.records.length)} records`);
  };

  const importLog = async (file: File): Promise<void> => {
    try {
      const log = readLog(await file.text());

      clear();
      state.sources = log.sources;
      state.sourceArchive = new Map(
        log.sources.map((source) => {
          return [source.id, source];
        })
      );
      state.inspections.clear();
      state.isImported = true;
      state.participantDropped = log.droppedParticipants;
      state.skipped = log.skipped;
      state.dropped = log.dropped;
      // * the page's own records would mix with the file's: the panel pauses as it reads one
      state.isRecording = false;
      drawSources();
      take(log.records);
      say(
        `Imported ${numberOf(log.records.length)} records from ${file.name}; ${String(log.skipped)} unknown records skipped; recording paused`
      );
    } catch (reason) {
      say(
        `${file.name} does not read: ${reason instanceof Error ? reason.message : String(reason)}`
      );
    }

    draw();
  };

  // the panel follows DevTools' theme, not the system's
  document.documentElement.dataset['colorScheme'] = host.theme;

  const closeFilterHelp = (): void => {
    shown.filterHelp.hidden = true;
    shown.filterHelpButton.setAttribute('aria-expanded', 'false');
  };

  // * the help is WAI-ARIA APG's Disclosure: the `?` shows and hides it, and says which in
  // `aria-expanded`; it closes too as focus leaves the field and the help
  shown.filterHelpButton.addEventListener('click', () => {
    if (!shown.filterHelp.hidden) {
      closeFilterHelp();

      return;
    }

    shown.filterHelp.hidden = false;
    shown.filterHelpButton.setAttribute('aria-expanded', 'true');

    const button = shown.filterHelpButton.getBoundingClientRect();
    const help = shown.filterHelp.getBoundingClientRect();

    shown.filterHelp.style.left = `${String(Math.max(12, Math.min(button.right - help.width, innerWidth - help.width - 12)))}px`;
    shown.filterHelp.style.top = `${String(Math.max(12, Math.min(button.bottom + 12, innerHeight - help.height - 12)))}px`;
  });
  window.addEventListener('resize', closeFilterHelp);

  for (const part of [shown.filterHelpButton.parentElement, shown.filterHelp]) {
    part?.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      const isWithin =
        next instanceof Node &&
        (shown.filterHelp.contains(next) ||
          shown.filterHelpButton.parentElement?.contains(next) === true);

      if (!isWithin) {
        closeFilterHelp();
      }
    });
  }

  shown.layout.addEventListener('change', () => {
    split.layout = layoutOf(shown.layout.value);
    keep(KEPT.layout, split.layout);
    layOut();
  });
  window.addEventListener('resize', layOut);

  // * the splitter is WAI-ARIA APG's Window Splitter, the list its primary pane: a separator
  // whose value is the list's share, moved by its arrows, sent to its limits by Home and End.
  // Its Enter collapses the list to its least, and restores the share it had
  shown.splitter.addEventListener('keydown', (event) => {
    const placement = placementOf();
    const { max, min } = limitsOf(placement);
    const now = shareShown(placement);
    const [less, more] =
      placement === 'right' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const isCollapsed = now <= min;
    const next =
      event.key === less
        ? now - SHARE.step
        : event.key === more
          ? now + SHARE.step
          : event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : event.key === 'Enter'
                ? isCollapsed
                  ? (restored[placement] ?? SHARE.default)
                  : min
                : undefined;

    if (next !== undefined) {
      event.preventDefault();
      restored[placement] = event.key === 'Enter' && !isCollapsed ? now : undefined;
      moveSplit(next, { isKept: true });
    }
  });

  shown.splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    shown.splitter.setPointerCapture(event.pointerId);
    shown.splitter.classList.add('is-dragging');
  });

  shown.splitter.addEventListener('pointermove', (event) => {
    if (!shown.splitter.hasPointerCapture(event.pointerId)) {
      return;
    }

    const box = shown.callsView.getBoundingClientRect();

    moveSplit(
      placementOf() === 'right'
        ? ((event.clientX - box.left) / box.width) * 100
        : ((event.clientY - box.top) / box.height) * 100,
      { isKept: false }
    );
  });

  shown.splitter.addEventListener('lostpointercapture', () => {
    shown.splitter.classList.remove('is-dragging');
    keep(KEPT.share[placementOf()], String(split.shares[placementOf()]));
  });

  // * each tab bar is WAI-ARIA APG's Tabs, a tab shown as it is focused: ←, →, Home and End move
  // along the bar, which keeps one tab stop
  for (const nav of document.querySelectorAll<HTMLElement>('[role="tablist"]')) {
    // a bar narrower than its tabs scrolls within itself: a tab focused comes whole into sight,
    // which focus alone leaves to a tab out of sight entirely
    nav.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLElement && event.target.getAttribute('role') === 'tab') {
        event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
    nav.addEventListener('keydown', (event) => {
      const tabs = [...nav.querySelectorAll<HTMLElement>('[role="tab"]')];
      const index = tabs.findIndex((tab) => {
        return tab === document.activeElement;
      });

      if (index < 0) {
        return;
      }

      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (index + tabs.length - 1) % tabs.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : undefined;

      if (next !== undefined) {
        event.preventDefault();

        // ! the tab stop moves now, not at the next drawing: a Tab pressed before it leaves the bar
        tabs.forEach((tab, at) => {
          tab.tabIndex = at === next ? 0 : -1;
        });
        tabs[next]?.click();
        tabs[next]?.focus();
      }
    });
  }

  for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]')) {
    tab.addEventListener('click', () => {
      state.view = tab.dataset['tab'] as View;

      if (state.view === 'metrics') {
        tell({ type: 'read-expositions' });
      } else if (state.view === 'broker' && !state.isImported) {
        tell({ type: 'read-participants' });
      }

      draw();
    });
  }

  for (const tab of document.querySelectorAll<HTMLElement>('[data-detail]')) {
    tab.addEventListener('click', () => {
      state.detailTab = tab.dataset['detail'] as DetailTab;
      draw();
    });
  }

  for (const button of document.querySelectorAll<HTMLElement>('[data-mode]')) {
    button.addEventListener('click', () => {
      state.mode = button.dataset['mode'] === 'envelopes' ? 'envelopes' : 'calls';
      draw();
    });
  }

  for (const button of document.querySelectorAll<HTMLElement>('[data-quick]')) {
    button.addEventListener('click', () => {
      const word = button.dataset['quick'] ?? '';

      if (word === 'failed') {
        state.isFailedOnly = !state.isFailedOnly;
        draw();

        return;
      }

      shown.filter.value = toggleWord(shown.filter.value, word);
      applyFilter();
    });
  }

  shown.filter.addEventListener('input', applyFilter);
  shown.source.addEventListener('change', draw);
  shown.clear.addEventListener('click', clear);
  shown.record.addEventListener('click', toggleRecording);
  shown.export.addEventListener('click', exportLog);
  shown.import.addEventListener('click', () => {
    shown.importFile.click();
  });
  shown.importFile.addEventListener('change', () => {
    const [file] = shown.importFile.files ?? [];

    if (file !== undefined) {
      void importLog(file);
    }

    shown.importFile.value = '';
  });

  shown.calls.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const twist = target?.closest<HTMLElement>('[data-twist]');

    if (twist !== null && twist !== undefined) {
      toggleExpanded(Number(twist.dataset['twist']));

      return;
    }

    const call = callOfRow(target);

    if (call !== undefined) {
      select(call.key);
      shown.list.focus({ preventScroll: true });
    }
  });

  shown.envelopes.addEventListener('click', (event) => {
    const call = callOfRow(event.target);
    const row = event.target instanceof Element ? event.target.closest('tr') : null;

    if (call !== undefined) {
      envelopeAt = row === null ? undefined : [...shown.envelopes.children].indexOf(row);
      select(call.key);
    }
  });

  /** In the Envelopes mode, the arrows step from the row shown to the next of another call. */
  const stepEnvelopes = (step: number): void => {
    const rows = [...shown.envelopes.querySelectorAll<HTMLElement>('tr[data-key]')];
    const isOfSelected = (row: HTMLElement | undefined): boolean => {
      return row !== undefined && Number(row.dataset['key']) === state.selected;
    };
    const from =
      envelopeAt !== undefined && isOfSelected(rows[envelopeAt])
        ? envelopeAt
        : rows.findIndex(isOfSelected);

    for (let at = from + step; at >= 0 && at < rows.length; at += step) {
      const row = rows[at];

      if (row !== undefined && !isOfSelected(row)) {
        envelopeAt = at;
        select(Number(row.dataset['key']));
        requestAnimationFrame(() => {
          shown.envelopes
            .querySelectorAll('tr[data-key]')
            [at]?.scrollIntoView({ block: 'nearest' });
        });

        return;
      }
    }
  };

  shown.calls.addEventListener('contextmenu', (event) => {
    const call = callOfRow(event.target);

    if (call !== undefined) {
      event.preventDefault();
      select(call.key);
      openMenu(call, { x: event.clientX, y: event.clientY });
    }
  });

  shown.list.addEventListener('keydown', (event) => {
    const rows = [...shown.calls.querySelectorAll<HTMLElement>('tr[data-key]')];
    const index = rows.findIndex((row) => {
      return Number(row.dataset['key']) === state.selected;
    });
    const call = selectedCall();

    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && state.mode === 'envelopes') {
      event.preventDefault();
      stepEnvelopes(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();

      const next =
        rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];

      if (next !== undefined) {
        select(Number(next.dataset['key']));
        requestAnimationFrame(() => {
          shown.calls
            .querySelector(`tr[data-key="${String(state.selected)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
        });
      }
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && call !== undefined) {
      event.preventDefault();
      toggleExpanded(call.key, event.key === 'ArrowRight');
    } else if (event.key === 'Enter' && call !== undefined) {
      event.preventDefault();
      shown.detail.focus();
    } else if (
      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) &&
      call !== undefined
    ) {
      event.preventDefault();

      const box = shown.calls
        .querySelector(`tr[data-key="${String(call.key)}"]`)
        ?.getBoundingClientRect();

      openMenu(call, { x: box?.left ?? 0, y: box?.bottom ?? 0 });
    }
  });

  shown.menu.addEventListener('keydown', (event) => {
    const items = [...shown.menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === 'Escape') {
      closeMenu();
      shown.list.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[
        (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(items.length, 1)
      ]?.focus();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (
      event.target instanceof Node &&
      !shown.filterHelp.contains(event.target) &&
      !shown.filterHelpButton.contains(event.target)
    ) {
      closeFilterHelp();
    }

    if (
      !shown.menu.hidden &&
      !(event.target instanceof Node && shown.menu.contains(event.target))
    ) {
      closeMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    const isModified = event.ctrlKey || event.metaKey;

    if (event.key === 'Escape' && !shown.filterHelp.hidden) {
      // * this Escape closes the help alone: the filter keeps its words, and its focus
      event.preventDefault();

      if (
        document.activeElement === shown.filterHelpButton ||
        shown.filterHelp.contains(document.activeElement)
      ) {
        shown.filterHelpButton.focus();
      }

      closeFilterHelp();
    } else if (isModified && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      toggleRecording();
    } else if (isModified && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      clear();
    } else if (event.key === '/' && !isTyping(event.target)) {
      event.preventDefault();
      closeFilterHelp();
      shown.filter.focus();
    }
  });

  // what time moves, each second: a call in flight's wait, and the registries, while Metrics shows
  setInterval(() => {
    if (document.visibilityState !== 'visible') {
      return;
    }

    if (state.view === 'metrics') {
      tell({ type: 'read-expositions' });
    } else if (state.view === 'broker' && !state.isImported) {
      tell({ type: 'read-participants' });
    } else if (
      state.book.calls.some((call) => {
        return statusOf(call) === 'flight';
      })
    ) {
      draw();
    }
  }, TICK_MILLISECONDS);

  host.onExchange?.(takeExchange);
  connect();
  draw();
};
