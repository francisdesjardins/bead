// ── Demo page ─────────────────────────────────────────────────────────────────

// dependencies

import {
  CancelError,
  createWSClient,
  FailureError,
  FailureScope,
  ProtocolCode,
  TimeoutError,
} from '../src/client/ws-client';
import { createHTTPClient } from '../src/client/http-client';
import { createWorkerClient } from '../src/client/worker-client';
import type { IClient } from '../src/client/types';
import type { IWorkerLike } from '../src/transport/client/worker-transport-client';
import type { IRouterDebugInfo } from '../src/router/client/types';
import { EnvelopeKind } from '../src/router/shared/constants';
import type { IDurationSummary } from '../src/router/shared/debug-statistics';
import type { INotificationRegistration } from '../src/router/shared/types';
import type { IHealth, ServerGauges } from '../src/server/health';
import {
  answererOf,
  askerOf,
  BURST_CHANGES,
  CALLS,
  type ICall,
  type IClaims,
  NOTIFICATIONS,
} from './procedures';
import { drawGlyph, GLYPH_BYTES, GLYPH_SIDE } from './glyph';
import { createQuietCalls, watchDebug } from './debug';

// interfaces

/** What the `stats` procedure answers, read. */
interface IServerStats {
  durations: IDurationSummary;
  gauges: ServerGauges;
  health: IHealth;
}

// constants

/** The lines a log keeps, newest first. */
const LOG_LINES = 300;

/** How often the server's statistics are read, while the page is seen. */
const STATS_MILLISECONDS = 1_000;

/**
 * Of those reads, the one a hidden page makes: enough to stay under the server's silence, which a
 * background tab's slowed timers still are, and no more.
 */
const HIDDEN_READ_EVERY = 20;

const KIND_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(EnvelopeKind).map(([name, kind]) => {
    return [kind, name];
  })
);

const CODE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(ProtocolCode).map(([name, code]) => {
    return [code, name];
  })
);

const ROLE_NAMES = Object.freeze({ reader: 'reader', writer: 'writer' });

/** The demo's procedures by id, so an envelope, which carries none of their names, shows one. */
const PROCEDURE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.values(CALLS).map(({ procedure }) => {
    return [procedure.procedureId, procedure.procedureName];
  })
);

const numbers = new Intl.NumberFormat('en-CA');

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the page has no #${id}`);
  }

  return element;
};

// the lines each log is owed, written at the next frame: a burst lays the page out once, not once a
// line
const owed = new Map<HTMLElement, string[]>();

const writeLogs = (): void => {
  for (const [list, lines] of owed) {
    const fragment = document.createDocumentFragment();

    // the newest first, as the log reads
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = document.createElement('li');
      const text = lines[index] ?? '';

      line.textContent = text;
      // which way it went, for the page to mark
      line.dataset['direction'] = text.startsWith('→') ? 'tx' : 'rx';
      fragment.append(line);
    }

    list.prepend(fragment);

    while (list.children.length > LOG_LINES) {
      list.lastElementChild?.remove();
    }
  }

  owed.clear();
};

/** A line at the top of `list`, at the next frame; the oldest let go past the last one kept. */
const log = (list: HTMLElement, text: string): void => {
  const lines = owed.get(list) ?? [];

  if (owed.size === 0) {
    requestAnimationFrame(writeLogs);
  }

  lines.push(text);

  // a hidden page draws no frame: what its next one would let go is not kept meanwhile
  if (lines.length > LOG_LINES) {
    lines.shift();
  }

  owed.set(list, lines);
};

/** What an envelope's header says, on one line: its direction, kind, call id, and its own part. */
const envelopeLineOf = ({ direction, header }: IRouterDebugInfo): string => {
  const parts = [
    direction === 'tx' ? '→' : '←',
    KIND_NAMES[header.kind] ?? `0x${header.kind.toString(16)}`,
    `#${String(header.callId)}`,
  ];

  if (header.kind === EnvelopeKind.REQUEST) {
    parts.push(
      `${PROCEDURE_NAMES[header.procedureId] ?? '?'} (${String(header.serviceId)}/${String(header.procedureId)})`
    );

    if (header.opensSubscription === true) {
      parts.push(header.paced === true ? 'paced subscription' : 'subscription');
    }
  }

  if (
    (header.kind === EnvelopeKind.REQUEST || header.kind === EnvelopeKind.RESULT) &&
    header.total !== undefined
  ) {
    parts.push(`total ${numbers.format(header.total)}`);
  }

  if (header.kind === EnvelopeKind.CHUNK) {
    parts.push(`at ${numbers.format(header.offset)}`, header.isLast ? 'last' : 'MORE');
  }

  if (header.kind === EnvelopeKind.CREDIT) {
    parts.push(
      header.paced === true
        ? `${numbers.format(header.creditEnd)} notifications at most`
        : `up to ${numbers.format(header.creditEnd)}`
    );
  }

  return parts.join(' ');
};

/** Why a call failed, as a person reads it. */
const reasonOf = (reason: unknown): string => {
  if (reason instanceof FailureError) {
    const name =
      reason.scope === FailureScope.APPLICATION
        ? `the procedure's code ${String(reason.code)}`
        : (CODE_NAMES[reason.code] ?? `code ${String(reason.code)}`);

    return reason.detail === '' ? name : `${name} — ${reason.detail}`;
  }

  if (reason instanceof TimeoutError) {
    return 'timed out';
  }

  if (reason instanceof CancelError) {
    return 'cancelled';
  }

  return String(reason);
};

const base64urlOf = (text: string): string => {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
};

const textOf = (part: string): string => {
  const binary = atob(part.replaceAll('-', '+').replaceAll('_', '/'));

  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => {
      return character.charCodeAt(0);
    })
  );
};

/** A reader's token made to say it writes, its signature kept: what a forger would try. */
const forgedOf = (token: string): string => {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const claims = { ...(JSON.parse(textOf(payload)) as IClaims), permissions: ['read', 'write'] };

  return `${header}.${base64urlOf(JSON.stringify({ ...claims, role: 'writer' }))}.${signature}`;
};

/**
 * A token from the demo's identity provider: a service of its own, over HTTP — or, with no server,
 * a procedure of the worker's.
 */
const tokenOf = async (role: keyof typeof ROLE_NAMES): Promise<string> => {
  if (workerClient !== undefined) {
    return services.getRequest(CALLS.token.procedure, { serializer: askerOf(CALLS.token) })(role)();
  }

  const reply = await fetch(`/token?role=${role}`);

  return ((await reply.json()) as { token: string }).token;
};

/**
 * `read`, run one at a time however often it is asked, and once more when it was asked meanwhile:
 * a signal with no data, "it changed", merged around the code that handles it. Each run reads the
 * latest, so a burst of signals costs two reads — the one under way, and the one after it. The
 * application's own, not the protocol's.
 */
const mergedOf = (read: () => Promise<unknown>): (() => void) => {
  let isReading = false;
  let isAskedAgain = false;

  const run = (): void => {
    const after = (): void => {
      isReading = false;

      if (isAskedAgain) {
        isAskedAgain = false;
        run();
      }
    };

    isReading = true;
    void read().then(after, after);
  };

  return () => {
    if (isReading) {
      isAskedAgain = true;
    } else {
      run();
    }
  };
};

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  // what the router puts together, and what this page draws, stands on an ArrayBuffer of its own
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  );

  return [...digest]
    .map((byte) => {
      return byte.toString(16).padStart(2, '0');
    })
    .join('');
};

// definition

// the transport the page's address asks for — `?transport=http`, or `?transport=worker` for a server
// of the page's own in a Web Worker, with no backend — else the page's own, which a page served as
// files alone says is its worker; WebSocket otherwise
const transport =
  new URLSearchParams(location.search).get('transport') ?? document.body.dataset['beadTransport'];
// beside the page's script, wherever the page is served, under the name its HTML gives — a build
// names it by its content
const workerFile = document.body.dataset['beadWorker'] ?? 'worker.js';
// one server for every tab of the site, where a browser shares a worker between them — each tab a
// client of its own — and the page's own otherwise
const isShared = typeof SharedWorker === 'function';

const workerOf = (): IWorkerLike => {
  const url = new URL(`./${workerFile}`, import.meta.url);

  if (!isShared) {
    return new Worker(url, { type: 'module' });
  }

  const shared = new SharedWorker(url, { name: 'bead', type: 'module' });

  // what the client posts goes on the tab's port; what fails is the worker's
  return {
    addEventListener: (type, listener) => {
      shared.addEventListener(type, listener);
    },
    postMessage: (message, transfer) => {
      shared.port.postMessage(message, transfer as Transferable[]);
    },
    removeEventListener: (type, listener) => {
      shared.removeEventListener(type, listener);
    },
  };
};

const workerClient =
  transport === 'worker' ? createWorkerClient({ transport: { worker: workerOf() } }) : undefined;
const client: IClient =
  workerClient ?? (transport === 'http' ? createHTTPClient() : createWSClient());
const { services } = client;
// the page's own port: the server relays the upgrade to the Bead server behind it
const port = Number(
  location.port === '' ? (location.protocol === 'https:' ? 443 : 80) : location.port
);
const pathname = document.body.dataset['beadPathname'] ?? '/';
const shown = {
  burst: elementOf('burst'),
  calls: elementOf('calls'),
  connection: elementOf('connection'),
  counter: elementOf('counter'),
  durations: elementOf('durations'),
  envelopes: elementOf('envelopes'),
  gauges: elementOf('gauges'),
  // a canvas, as the page declares it
  glyph: elementOf('glyph') as HTMLCanvasElement,
  glyphCaption: elementOf('glyph-caption'),
  health: elementOf('health'),
  identity: elementOf('identity'),
  result: elementOf('result'),
  subscribe: elementOf('subscribe'),
  tabs: elementOf('tabs'),
};

const requestOf = <Request, Result>(call: ICall<Request, Result>) => {
  return services.getRequest(call.procedure, { serializer: askerOf(call) });
};

const calls = {
  ask: requestOf(CALLS.ask),
  burst: requestOf(CALLS.burst),
  download: requestOf(CALLS.download),
  fail: requestOf(CALLS.fail),
  increment: requestOf(CALLS.increment),
  login: requestOf(CALLS.login),
  logout: requestOf(CALLS.logout),
  read: requestOf(CALLS.read),
  slow: requestOf(CALLS.slow),
  stats: requestOf(CALLS.stats),
  upload: requestOf(CALLS.upload),
};
// the counter's state, paced: the next value comes once the last one is shown
const subscribe = services.getNotification(CALLS.counter.procedure, {
  serializer: { ...askerOf(CALLS.counter), decodeNotification: NOTIFICATIONS.decode },
  window: 1,
});
// the signal, pushed each time: the page merges it itself
const subscribeChanged = services.getNotification(CALLS.changed.procedure, {
  serializer: { ...askerOf(CALLS.changed), decodeNotification: NOTIFICATIONS.decode },
});
// what the counter's subscription and the signal's brought, since the last burst
const heard = { reads: 0, signals: 0, values: 0 };
let registrations: INotificationRegistration[] = [];
let slowCall: AbortController | undefined;

const showHeard = (): void => {
  shown.burst.textContent = `counter: ${String(heard.values)} notifications; signal: ${String(heard.signals)} received, ${String(heard.reads)} reads`;
};

// each signal asks for a read; merged, a burst of them reads twice
const readChanged = mergedOf(async () => {
  heard.reads += 1;
  showHeard();

  try {
    shown.counter.textContent = await calls.read('')();
  } catch (reason) {
    shown.result.textContent = `read refused: ${reasonOf(reason)}`;
  }
});

// the calls that read the server's statistics, which the logs leave out
const isQuiet = createQuietCalls([CALLS.stats.procedure]);

/** What the server's statistics say, shown: its verdict, its answers' durations, what each layer holds. */
const showStats = (stats: IServerStats): void => {
  const { count, maximum, median } = stats.durations;
  const failing = Object.entries(stats.health.checks)
    .filter(([, [check]]) => {
      return check !== undefined && check.status !== 'pass';
    })
    .map(([name, [check]]) => {
      return `${name} ${String(check?.observedValue)}${check?.output === undefined ? '' : ` (${check.output})`}`;
    });

  shown.health.dataset['status'] = stats.health.status;
  shown.health.textContent = [stats.health.status, ...failing].join(' — ');
  shown.durations.textContent =
    count === 0
      ? 'none yet'
      : `${numbers.format(count)} calls, median ${numbers.format(median ?? 0)} ms, slowest ${numbers.format(maximum ?? 0)} ms`;
  shown.gauges.replaceChildren(
    ...Object.entries(stats.gauges).map(([layer, { anomalies, ceilings, counts, orphans }]) => {
      const line = document.createElement('li');
      const name = document.createElement('span');
      const chips = document.createElement('span');
      const held = Object.entries(counts)
        .filter(([, value]) => {
          return value !== 0;
        })
        .map(([count, value]) => {
          const ceiling = ceilings[count];

          return ceiling === undefined
            ? `${count} ${numbers.format(value)}`
            : `${count} ${numbers.format(value)} / ${numbers.format(ceiling)}`;
        });
      const said = [
        ...held,
        ...(orphans === 0 ? [] : [`${String(orphans)} orphans`]),
        ...anomalies,
      ];

      name.className = 'layer';
      name.textContent = layer;
      chips.className = 'chips';
      chips.append(
        ...(said.length === 0 ? ['nothing'] : said).map((text) => {
          const chip = document.createElement('span');

          chip.className = said.length === 0 ? 'chip quiet' : 'chip';
          chip.textContent = text;

          return chip;
        })
      );
      line.append(name, chips);

      return line;
    })
  );
};

// read once at a time, however often the timer asks
const refreshStats = mergedOf(async () => {
  try {
    showStats(JSON.parse(await calls.stats('')({ timeout: 5_000 })) as IServerStats);
  } catch (reason) {
    shown.health.dataset['status'] = 'unread';
    shown.health.textContent = `unread: ${reasonOf(reason)}`;
  }
});

/** A glyph's pixels, drawn on the page, and which way they went. */
const showGlyph = (pixels: Uint8Array, caption: string): void => {
  // a server that sends anything else sends no glyph
  if (pixels.length !== GLYPH_BYTES) {
    return;
  }

  shown.glyph
    .getContext('2d')
    ?.putImageData(new ImageData(new Uint8ClampedArray(pixels), GLYPH_SIDE, GLYPH_SIDE), 0, 0);
  shown.glyph.hidden = false;
  shown.glyphCaption.textContent = caption;
};

// who this connection is, as its session says; nothing once it ends
const showIdentity = (claims: IClaims | undefined): void => {
  const token = client.router.sessionToken;

  shown.identity.textContent =
    claims === undefined || token === undefined
      ? 'no session'
      : `${claims.sub}, ${ROLE_NAMES[claims.role]} (${claims.permissions.join(', ')}) — session ${token.slice(0, 8)}…`;
};

const login = async (token: string): Promise<string> => {
  const claims = JSON.parse(await calls.login(token)()) as IClaims;

  showIdentity(claims);

  return `session open, as a ${ROLE_NAMES[claims.role]}`;
};

/** What each button does, and what it says once done. */
const ACTIONS: Readonly<Record<string, () => Promise<string>>> = Object.freeze({
  ask: async () => {
    return `the server asked the client its time, which answered ${await calls.ask('')()}`;
  },
  burst: async () => {
    Object.assign(heard, { reads: 0, signals: 0, values: 0 });
    showHeard();

    const value = await calls.burst('')();

    return registrations.length === 0
      ? `${String(BURST_CHANGES)} increments, counter at ${value}: subscribe to see what comes of them`
      : `${String(BURST_CHANGES)} increments at once, counter at ${value}`;
  },
  cancel: () => {
    slowCall?.abort();

    return Promise.resolve('cancel asked');
  },
  download: async () => {
    const bytes = await calls.download('')({ timeout: 60_000 });

    showGlyph(bytes, 'received from the server');

    return `a glyph received, ${numbers.format(bytes.length)} bytes, SHA-256 ${(await digestOf(bytes)).slice(0, 16)}…`;
  },
  fail: () => {
    return calls.fail('')();
  },
  forged: async () => {
    return login(forgedOf(await tokenOf('reader')));
  },
  increment: async () => {
    return `counter at ${await calls.increment('')()}`;
  },
  logout: async () => {
    await calls.logout('')();
    showIdentity(undefined);

    return 'session closed';
  },
  read: async () => {
    return `counter at ${await calls.read('')()}`;
  },
  reader: async () => {
    return login(await tokenOf('reader'));
  },
  slow: async () => {
    const controller = new AbortController();

    slowCall = controller;

    const waited = await calls.slow('')({ signal: controller.signal, timeout: 30_000 });

    return `answered after ${numbers.format(Number(waited))} ms`;
  },
  subscribe: async () => {
    if (registrations.length > 0) {
      await Promise.all(
        registrations.map((registration) => {
          return registration.unregister();
        })
      );
      registrations = [];
      shown.subscribe.textContent = 'Subscribe (value + signal)';

      return 'unsubscribed';
    }

    registrations = await Promise.all([
      subscribe('', (value) => {
        heard.values += 1;
        shown.counter.textContent = value;
        showHeard();
      })(),
      subscribeChanged('', () => {
        heard.signals += 1;
        showHeard();
        readChanged();
      })(),
    ]);
    shown.subscribe.textContent = 'Unsubscribe';

    return 'subscribed: to the counter, paced, and to its signal, which the page merges';
  },
  timeout: async () => {
    return `answered after ${numbers.format(Number(await calls.slow('')({ timeout: 1_000 })))} ms`;
  },
  upload: async () => {
    const payload = drawGlyph();
    const [theirs, mine] = await Promise.all([
      calls.upload(payload)({ timeout: 60_000 }),
      digestOf(payload),
    ]);

    if (theirs !== mine) {
      return `the digests differ: ${theirs} against ${mine}`;
    }

    // shown once the server says it has the same: a glyph refused never crossed
    showGlyph(payload, 'sent to the server');

    return `the server received the same glyph, ${numbers.format(payload.length)} bytes, SHA-256 ${mine.slice(0, 16)}…`;
  },
  writer: async () => {
    return login(await tokenOf('writer'));
  },
});

// the server asks the client its time, by a command
services.getCommandResolver(CALLS.clock.procedure, { serializer: answererOf(CALLS.clock) })(
  (_request, response) => {
    return response(new Date().toLocaleTimeString('en-CA'));
  }
);

services.on('debug', (error, info) => {
  const duration = info.timestamp.duration;

  if (info.procedureName === CALLS.stats.procedure.procedureName) {
    return;
  }

  log(
    shown.calls,
    [
      info.direction === 'tx' ? '→' : '←',
      info.type,
      info.procedureName,
      duration === undefined ? '' : `${String(Math.round(duration))} ms`,
      error === null ? '' : reasonOf(error),
    ]
      .filter(Boolean)
      .join(' ')
  );
});

client.router.on('debug', (info) => {
  if (!isQuiet(info)) {
    log(shown.envelopes, envelopeLineOf(info));
  }
});

// a developer's own, to the console, as the `localStorage` of the page says, the statistics aside
watchDebug(client, { quiet: [CALLS.stats.procedure] });

// the transport in use, marked among the others
document
  .querySelector(`.transports a[href="?transport=${transport ?? 'ws'}"]`)
  ?.setAttribute('aria-current', 'page');

client.transport.on('close', () => {
  shown.connection.dataset['state'] = 'closed';
  shown.connection.textContent = 'closed: reload the page';
  showIdentity(undefined);
});

// a page that goes tells the server at once, rather than leaving its connection to time out
addEventListener('pagehide', () => {
  client.transport.disconnect().catch(() => {});
});

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
  button.addEventListener('click', () => {
    const action = ACTIONS[button.dataset['action'] ?? ''];

    if (action === undefined) {
      return;
    }

    action().then(
      (said) => {
        shown.result.textContent = said;
      },
      (reason: unknown) => {
        shown.result.textContent = `refused: ${reasonOf(reason)}`;
      }
    );
  });
}

// a worker is reached where it runs; a server, at the page's own address
(workerClient === undefined
  ? client.connect({
      host: location.hostname,
      pathname,
      port,
      secured: location.protocol === 'https:',
    })
  : workerClient.connect({})
).then(
  () => {
    // the server's statistics, each second the page is seen
    refreshStats();
    let ticks = 0;

    setInterval(() => {
      ticks += 1;

      if (document.visibilityState === 'visible' || ticks % HIDDEN_READ_EVERY === 0) {
        refreshStats();
      }
    }, STATS_MILLISECONDS);
    shown.connection.dataset['state'] = 'open';
    // a second tab is a second client of the same server
    shown.tabs.hidden = workerClient === undefined || !isShared;
    shown.connection.textContent =
      workerClient === undefined
        ? `connected, ${transport === 'http' ? 'HTTP' : 'WebSocket'} on ${location.host}${pathname}`
        : isShared
          ? 'connected, in a Web Worker the tabs share'
          : 'connected, in a Web Worker of the page';
  },
  (reason: unknown) => {
    shown.connection.dataset['state'] = 'closed';
    shown.connection.textContent = `cannot connect: ${String(reason)}`;
  }
);
