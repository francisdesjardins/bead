// ── Demo page ─────────────────────────────────────────────────────────────────

// dependencies

import {
  CancelError,
  CredentialScheme,
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
import { createMetricsRegistry } from '../src/router/shared/metrics-registry';
import type { INotificationRegistration, IReceivedFailure } from '../src/router/shared/types';
import type { IHealth, ServerGauges } from '../src/server/health';
import {
  answererOf,
  askerOf,
  BURST_CHANGES,
  CALLS,
  type ICall,
  type IClaims,
  NOTIFICATIONS,
  type Role,
} from './procedures';
import { drawGlyph, GLYPH_BYTES, GLYPH_SIDE } from './glyph';
import { createQuietCalls, watchDebug } from './debug';
import { SignUpProcedures } from './gen/typescript/demo/v1/sign_up_bead';
import { mountScenes } from './scenes';
import { mountSides } from './sides';
import { mountSignUp } from './sign-up';
import {
  answeredOf,
  type IAnswered,
  type IProcedureMetrics,
  metricsOf,
  quantileOf,
} from '../devtools/exposition';

// interfaces

/** What the `whoami` procedure answers, read: the claims of the call's session, and its end. */
interface IIdentity {
  claims: IClaims;
  /** When the session ends, in milliseconds since the epoch: the token's `exp`, and its leeway. */
  end: number;
}

/** What the `stats` procedure answers, read. */
interface IServerStats {
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

const SCHEME_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(CredentialScheme).map(([name, scheme]) => {
    return [scheme, name];
  })
);

/** The calls that read the server each second, which the logs and the metrics shown leave out. */
const READS = [CALLS.stats.procedure, CALLS.metrics.procedure];

const READ_NAMES = READS.map(({ procedureName }) => {
  return procedureName;
});

/**
 * The demo's procedures by their service and their id, the sign-up's among them, so an envelope,
 * which carries none of their names, shows one.
 */
const PROCEDURE_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  [...Object.values(CALLS), ...Object.values(SignUpProcedures)].map(({ procedure }) => {
    return [
      `${String(procedure.serviceId)}/${String(procedure.procedureId)}`,
      procedure.procedureName,
    ];
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
    const address = `${String(header.serviceId)}/${String(header.procedureId)}`;

    parts.push(`${PROCEDURE_NAMES[address] ?? '?'} (${address})`);

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

  // the credential block, by its scheme alone: its bytes are never traced
  if (header.credentialScheme !== undefined) {
    parts.push(
      `credential ${SCHEME_NAMES[header.credentialScheme] ?? String(header.credentialScheme)}`
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

/** Why the server ended a subscription, as a person reads it. */
const failureOf = ({ code, detail, scope }: IReceivedFailure): string => {
  const name =
    scope === FailureScope.APPLICATION
      ? `the procedure's code ${String(code)}`
      : (CODE_NAMES[code] ?? `code ${String(code)}`);

  return detail === '' ? name : `${name} — ${detail}`;
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
  const claims: IClaims = {
    ...(JSON.parse(textOf(payload)) as IClaims),
    roles: ['writer'],
    scope: 'read write',
  };

  return `${header}.${base64urlOf(JSON.stringify(claims))}.${signature}`;
};

/**
 * A token from the demo's identity provider: a service of its own, over HTTP — or, with no server,
 * a procedure of the worker's, called with no credential, so one that no longer holds keeps nobody
 * from logging in again.
 */
const tokenOf = async (role: Role): Promise<string> => {
  if (workerClient !== undefined) {
    return services.getRequest(CALLS.token.procedure, { serializer: askerOf(CALLS.token) })(role)({
      credential: { scheme: CredentialScheme.NONE },
    });
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

// what the page's client counts: the calls it made, and the commands it answered
const metricsRegistry = createMetricsRegistry();
// the sign-up's short-detail link bounds the client's own refusals, on any transport
const limits =
  new URLSearchParams(location.search).get('detail') === 'short'
    ? { maximumDetailBytes: 256 }
    : undefined;
const workerClient =
  transport === 'worker'
    ? createWorkerClient({ limits, metricsRegistry, transport: { worker: workerOf() } })
    : undefined;
const client: IClient =
  workerClient ??
  (transport === 'http'
    ? createHTTPClient({ limits, metricsRegistry })
    : createWSClient({ limits, metricsRegistry }));
const { services } = client;
// the page's own port: the server relays the upgrade to the Bead server behind it
const port = Number(
  location.port === '' ? (location.protocol === 'https:' ? 443 : 80) : location.port
);
const pathname = document.body.dataset['beadPathname'] ?? '/';
const shown = {
  burst: elementOf('burst'),
  calls: elementOf('calls-log'),
  // each a <details>, as the page declares it
  clientExposition: elementOf('client-exposition') as HTMLDetailsElement,
  clientMetrics: elementOf('client-metrics'),
  connection: elementOf('connection'),
  counter: elementOf('counter'),
  durations: elementOf('durations'),
  envelopes: elementOf('envelopes-log'),
  gauges: elementOf('gauges'),
  // a canvas, as the page declares it
  glyph: elementOf('glyph') as HTMLCanvasElement,
  glyphCaption: elementOf('glyph-caption'),
  health: elementOf('health'),
  identity: elementOf('identity'),
  result: elementOf('result'),
  serverExposition: elementOf('server-exposition') as HTMLDetailsElement,
  serverMetrics: elementOf('server-metrics'),
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
  logout: requestOf(CALLS.logout),
  metrics: requestOf(CALLS.metrics),
  read: requestOf(CALLS.read),
  slow: requestOf(CALLS.slow),
  stats: requestOf(CALLS.stats),
  upload: requestOf(CALLS.upload),
  whoami: requestOf(CALLS.whoami),
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
// the subscriptions held, by procedure, until the page or the server ends them
const registrations = new Map<number, INotificationRegistration>();
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

// the calls that read the server, which the logs leave out
const isQuiet = createQuietCalls(READS);

// each exposition's last text, written in its <details> while it is open
const expositions = new Map<HTMLDetailsElement, string>();

/** A chip, as the gauges and the metrics show one: plain, quiet, or a failure. */
const chipOf = (text: string, kind?: 'failure' | 'quiet'): HTMLElement => {
  const chip = document.createElement('span');

  chip.className = kind === undefined ? 'chip' : `chip ${kind}`;
  chip.textContent = text;

  return chip;
};

/** A line of a list of chips: its name, and its chips. */
const lineOf = (named: string, chips: readonly HTMLElement[]): HTMLElement => {
  const line = document.createElement('li');
  const name = document.createElement('span');
  const held = document.createElement('span');

  name.className = 'layer';
  name.textContent = named;
  held.className = 'chips';
  held.append(...chips);
  line.append(name, held);

  return line;
};

/** A duration in seconds, as the page shows one, in milliseconds. */
const millisecondsOf = (seconds: number | undefined): string => {
  return `${numbers.format((seconds ?? 0) * 1_000)} ms`;
};

/** What the server's statistics say, shown: its verdict, and what each layer holds. */
const showStats = (stats: IServerStats): void => {
  const failing = Object.entries(stats.health.checks)
    .filter(([, [check]]) => {
      return check !== undefined && check.status !== 'pass';
    })
    .map(([name, [check]]) => {
      return `${name} ${String(check?.observedValue)}${check?.output === undefined ? '' : ` (${check.output})`}`;
    });

  shown.health.dataset['status'] = stats.health.status;
  shown.health.textContent = [stats.health.status, ...failing].join(' — ');
  shown.gauges.replaceChildren(
    ...Object.entries(stats.gauges).map(([layer, { anomalies, ceilings, counts, orphans }]) => {
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

      return lineOf(
        layer,
        said.length === 0
          ? [chipOf('nothing', 'quiet')]
          : said.map((text) => {
              return chipOf(text);
            })
      );
    })
  );
};

/** The calls the server answered, every procedure's together: how many, their mean, their median. */
const showAnswered = ({ count, mean, median }: IAnswered): void => {
  shown.durations.textContent =
    count === 0
      ? 'none yet'
      : `${numbers.format(count)} calls, mean ${numbers.format(mean ?? 0)} ms, median about ${numbers.format(median ?? 0)} ms`;
};

/**
 * What a registry counted, a line a procedure that saw a call or a notification: its calls, made or
 * answered, those in flight, how long they took, and what did not end in a result.
 */
const showMetrics = (list: HTMLElement, rows: readonly IProcedureMetrics[]): void => {
  const lines = rows
    .map(({ buckets, count, notifications, outcomes, procedure, role, started, type }) => {
      const chips = [
        ...(started === 0 ? [] : [chipOf(`${numbers.format(count)} ${role}`)]),
        ...(type === 'request' || started === 0 ? [] : [chipOf(type, 'quiet')]),
        ...(started > count ? [chipOf(`${numbers.format(started - count)} in flight`)] : []),
        ...(count === 0
          ? []
          : [
              chipOf(`median ≈ ${millisecondsOf(quantileOf(buckets, 0.5))}`),
              chipOf(`p95 ≈ ${millisecondsOf(quantileOf(buckets, 0.95))}`),
            ]),
        ...[...outcomes, ...notifications]
          .filter(([outcome, value]) => {
            return outcome !== 'result' && value > 0;
          })
          .map(([outcome, value]) => {
            const isFailure =
              outcomes.has(outcome) || outcome === 'not sent' || outcome.startsWith('dropped');

            return chipOf(`${numbers.format(value)} ${outcome}`, isFailure ? 'failure' : undefined);
          }),
      ];

      return chips.length === 0 ? undefined : lineOf(procedure, chips);
    })
    .filter((line) => {
      return line !== undefined;
    });

  list.replaceChildren(
    ...(lines.length === 0 ? [lineOf('—', [chipOf('none yet', 'quiet')])] : lines)
  );
};

/** An exposition's text, kept, and written in its <details> while it is open and holds no selection. */
const showExposition = (details: HTMLDetailsElement, text: string): void => {
  const written = details.querySelector('pre');
  const selection = getSelection();

  expositions.set(details, text);

  // a selection in it holds it still, for a copy
  if (
    written === null ||
    !details.open ||
    (selection !== null && !selection.isCollapsed && selection.containsNode(written, true))
  ) {
    return;
  }

  written.textContent = text;
};

// a public read needs no identity: it presents none, so a token withdrawn neither fails it nor is
// withdrawn by it
const PUBLIC = Object.freeze({ credential: { scheme: CredentialScheme.NONE }, timeout: 5_000 });

// read once at a time, however often the timer asks
const refreshStats = mergedOf(async () => {
  try {
    showStats(JSON.parse(await calls.stats('')(PUBLIC)) as IServerStats);
  } catch (reason) {
    shown.health.dataset['status'] = 'unread';
    shown.health.textContent = `unread: ${reasonOf(reason)}`;
  }
});

// the client's registry, in the page, and the server's, by a `metrics` call, once at a time too
const refreshMetrics = mergedOf(async () => {
  const mine = metricsRegistry.exposition().text;

  showMetrics(shown.clientMetrics, metricsOf(mine, READ_NAMES));
  showExposition(shown.clientExposition, mine);

  try {
    const theirs = await calls.metrics('')(PUBLIC);
    const rows = metricsOf(theirs, READ_NAMES);

    showAnswered(answeredOf(rows));
    showMetrics(shown.serverMetrics, rows);
    showExposition(shown.serverExposition, theirs);
  } catch (reason) {
    shown.durations.textContent = `unread: ${reasonOf(reason)}`;
    shown.serverMetrics.replaceChildren(
      lineOf('—', [chipOf(`unread: ${reasonOf(reason)}`, 'failure')])
    );
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

// who the calls are made as, as the server read the token's claims; why not, once logged out
const showIdentity = (identity: IIdentity | string): void => {
  if (typeof identity === 'string') {
    shown.identity.textContent = identity;

    return;
  }

  const { claims, end } = identity;

  shown.identity.textContent = `${claims.sub}, ${claims.roles.join(', ')} (${claims.scope}) — session ${claims.sid.slice(0, 8)}…, until ${new Date(end).toLocaleTimeString('en-CA')}`;
};

// the token presented by every call from now on, in its header, and the server asked what it read
const logIn = async (token: string): Promise<string> => {
  client.router.credential = { scheme: CredentialScheme.JWT, token };

  const identity = JSON.parse(await calls.whoami('')()) as IIdentity;

  showIdentity(identity);

  return `logged in as ${identity.claims.sub}: each call presents the token, which the server verifies`;
};

// a subscription the page holds no longer, however it ended
const forget = (procedureId: number): void => {
  registrations.delete(procedureId);

  if (registrations.size === 0) {
    shown.subscribe.textContent = 'Subscribe (value + signal)';
  }
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

    return registrations.size === 0
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
    return logIn(forgedOf(await tokenOf('reader')));
  },
  increment: async () => {
    return `counter at ${await calls.increment('')()}`;
  },
  logout: async () => {
    // a token withdrawn holds no session to end: the page forgets it alone, in writing
    if (!client.router.isCredentialWithdrawn) {
      await calls.logout('')();
    }

    client.router.credential = undefined;
    showIdentity('logged out');

    return 'logged out: the server ended the session and its subscriptions, and the page forgot its token';
  },
  read: async () => {
    return `counter at ${await calls.read('')()}`;
  },
  reader: async () => {
    return logIn(await tokenOf('reader'));
  },
  slow: async () => {
    const controller = new AbortController();

    slowCall = controller;

    const waited = await calls.slow('')({ signal: controller.signal, timeout: 30_000 });

    return `answered after ${numbers.format(Number(waited))} ms`;
  },
  subscribe: async () => {
    if (registrations.size > 0) {
      const held = [...registrations.values()];

      registrations.clear();
      shown.subscribe.textContent = 'Subscribe (value + signal)';
      await Promise.all(
        held.map((registration) => {
          return registration.unregister();
        })
      );

      return 'unsubscribed';
    }

    const [values, signals] = await Promise.all([
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

    registrations.set(CALLS.counter.procedure.procedureId, values);
    registrations.set(CALLS.changed.procedure.procedureId, signals);
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
    return logIn(await tokenOf('writer'));
  },
});

// the server asks the client its time, by a command
services.getCommandResolver(CALLS.clock.procedure, { serializer: answererOf(CALLS.clock) })(
  (_request, response) => {
    return response(new Date().toLocaleTimeString('en-CA'));
  }
);

services.on('debug', (error, info) => {
  const { duration } = info;

  if (READ_NAMES.includes(info.procedureName)) {
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

// a token the server refused, SESSION_REQUIRED, is presented no more: a call that would present
// it fails before it goes until the page signs in again, or out
client.router.on('credentialWithdrawn', () => {
  showIdentity(
    'logged out: the server refused the token — log in again; calls that need it fail until then'
  );
});

// a subscription the server ended — its session at its end, or ended by a logout — is held no more,
// and the log says why: over HTTP, it may come after the answer of the call that ended it
services.on('dropped', (procedure, failure) => {
  forget(procedure.procedureId);

  if (failure !== undefined) {
    log(shown.calls, `← dropped ${procedure.procedureName} ${failureOf(failure)}`);
  }
});

// a developer's own, to the console, as the `localStorage` of the page says, the reads aside
watchDebug(client, { quiet: READS });

// the sign-up, its request held to the rules of its .proto
mountSignUp(client, { reasonOf });
mountSides();
// the scenes, one a tab, and the logs beside them
mountScenes();

// an exposition opened is written at once, from its last text
for (const details of [shown.clientExposition, shown.serverExposition]) {
  details.addEventListener('toggle', () => {
    showExposition(details, expositions.get(details) ?? '');
  });
}

// the transport in use, marked among the others
document
  .querySelector(`.transports a[href="?transport=${transport ?? 'ws'}"]`)
  ?.setAttribute('aria-current', 'page');

client.transport.on('close', () => {
  shown.connection.dataset['state'] = 'closed';
  shown.connection.textContent = 'closed: reload the page';
  showIdentity('logged out');
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
    // the server's statistics and both registries, each second the page is seen
    refreshStats();
    refreshMetrics();
    let ticks = 0;

    setInterval(() => {
      ticks += 1;

      if (document.visibilityState === 'visible' || ticks % HIDDEN_READ_EVERY === 0) {
        refreshStats();
        refreshMetrics();
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
