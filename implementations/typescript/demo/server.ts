// ── Demo server ───────────────────────────────────────────────────────────────

// dependencies

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { createMetricsRegistry } from '../src/router/shared/metrics-registry';
import type { HealthStatus } from '../src/server/health';
import { createHTTPServer } from '../src/server/http-server';
import { createServer as createBeadServer } from '../src/server/server';
import { createWSServer } from '../src/server/ws-server';
import { createHTTPGateway } from '../src/transcoding/http-gateway';
import { createMemoryTransportServer } from '../src/transport/server/memory-transport-server';
import { HTTP_PROBLEM_TYPES, HTTP_ROUTES, OPENAPI_DOCUMENT } from './gen/typescript/bead_http';
import { isRole, offer, SILENCE_MILLISECONDS } from './offer';
import { pathOf, relayExchanges, relayUpgrades } from './relay';
import { credentialsOf, issueToken, keyOf, secretOf } from './token';

// constants

/** The one public port: the page, the token, and the Bead servers behind the relay. */
const HTTP_PORT = Number(process.env['DEMO_PORT'] ?? 8_080);

/** The address it listens on: this machine alone, which the demo serves. */
const HTTP_ADDRESS = '127.0.0.1';

/** Where the page reaches Bead: its WebSocket upgrades, and its HTTP exchanges. */
const BEAD_PATHNAME = '/bead';

/** Where a probe reads the health of both Bead servers, on this machine alone. */
const HEALTH_PATHNAME = '/health';

/** Where a scraper reads both Bead servers' metrics, on this machine alone. */
const METRICS_PATHNAME = '/metrics';

/** What both Bead servers count into, summed: what `stats` and a scrape read. */
const METRICS_REGISTRY = createMetricsRegistry();

/**
 * The identity provider's key: `DEMO_KEY`'s, in base64url, else one drawn at each start, so no token
 * outlives the demo. A key refused says why, and the demo does not start.
 */
const SECRET = await secretOf(process.env['DEMO_KEY']).catch((reason: unknown): never => {
  process.stderr.write(`DEMO_KEY is refused: ${(reason as Error).message}\n`);

  return process.exit(1);
});

/** What the identity provider signs with. */
const KEY = keyOf(SECRET);

/** What both Bead servers verify each call's token with: the same key, as a JWK, and the audience. */
const CREDENTIALS = credentialsOf(SECRET);

// this module runs from `dist/`, where the launcher builds it next to the page's script
const FILES = Object.freeze({
  '/': { path: new URL('../index.html', import.meta.url), type: 'text/html; charset=utf-8' },
  '/page.js': { path: new URL('./page.js', import.meta.url), type: 'text/javascript' },
  '/worker.js': { path: new URL('./worker.js', import.meta.url), type: 'text/javascript' },
  // penumbra's two sheets, the DevTools panel's copy, under the page's skin
  '/penumbra/tokens.skin.base.css': {
    path: new URL('../../devtools/penumbra/tokens.skin.base.css', import.meta.url),
    type: 'text/css',
  },
  '/penumbra/tokens.system.css': {
    path: new URL('../../devtools/penumbra/tokens.system.css', import.meta.url),
    type: 'text/css',
  },
});

// helpers

// what the page asks of the HTTP server: a file, or a token from the identity provider
const serve = async (request: IncomingMessage, reply: ServerResponse): Promise<void> => {
  const pathname = pathOf(request);
  const role = new URLSearchParams((request.url ?? '').split('?')[1]).get('role');

  if (pathname === '/token' && isRole(role)) {
    reply.writeHead(200, { 'content-type': 'application/json' });

    return (reply.end(JSON.stringify({ token: await issueToken(role, await KEY) })), undefined);
  }

  const file = FILES[pathname as keyof typeof FILES] as (typeof FILES)['/'] | undefined;

  if (file === undefined) {
    reply.writeHead(404);

    return (reply.end(), undefined);
  }

  const content = await readFile(file.path, 'utf8');

  reply.writeHead(200, { 'content-type': file.type });
  reply.end(content.replaceAll('%BEAD_PATHNAME%', BEAD_PATHNAME));
};

// definition

// a connection gone silent is closed, as no session of its own times it; behind the relay, an
// upgrade names the host a page named, `localhost` or this machine's address, which every server
// takes, as an HTTP exchange does
const overWebSocket = createWSServer({
  connectionInactivityTimeout: SILENCE_MILLISECONDS,
  credentials: CREDENTIALS,
  metricsRegistry: METRICS_REGISTRY,
  transport: { WebSocketServer },
});
// behind the relay: the host a page named, and the address the relay says it came from
const overHTTP = createHTTPServer({
  connectionInactivityTimeout: SILENCE_MILLISECONDS,
  credentials: CREDENTIALS,
  metricsRegistry: METRICS_REGISTRY,
  transport: {
    createServer: (listener) => {
      return createServer(listener);
    },
    // the public port's relay, in this process, on the loopback
    trustedProxies: ['127.0.0.1'],
  },
});

// * the sign-up's routes over HTTP and JSON, `POST /api/SignUp/signUp` and `/openapi.json`: a
// gateway, one more client of a Bead server of its own, each exchange its own connection over the
// in-memory transport (decision 0037), mounted on the public port beside the page
const overMemory = createBeadServer(
  { transport: createMemoryTransportServer() },
  {
    connectionInactivityTimeout: SILENCE_MILLISECONDS,
    credentials: CREDENTIALS,
    metricsRegistry: METRICS_REGISTRY,
  }
);
const gateway = createHTTPGateway({
  document: OPENAPI_DOCUMENT,
  problemTypes: HTTP_PROBLEM_TYPES,
  routes: HTTP_ROUTES,
  transport: overMemory.transport,
});

gateway.on('error', (reason) => {
  process.stderr.write(`gateway: ${reason.message}\n`);
});

offer(overWebSocket, METRICS_REGISTRY);
offer(overHTTP, METRICS_REGISTRY);
offer(overMemory, METRICS_REGISTRY);

// each Bead server on a local port the system picks, reached through the public one alone
const [wsTarget, httpTarget] = await Promise.all([
  overWebSocket.transport.start({ address: '127.0.0.1', findOpenPort: true }),
  overHTTP.transport.start({ address: '127.0.0.1', findOpenPort: true }),
  overMemory.transport.start(),
]);
const exchanges = relayExchanges(httpTarget);

// both servers' health, each check under its transport's name, the worst status theirs: 503 when one
// fails, as a probe expects; counts only, never kept by anything on the way
const answerHealth = (reply: ServerResponse): void => {
  const servers = { http: overHTTP.health(), websocket: overWebSocket.health() };
  const statuses: HealthStatus[] = [servers.http.status, servers.websocket.status];
  const status = (['fail', 'warn'] as const).find((worst) => {
    return statuses.includes(worst);
  });
  const checks = Object.fromEntries(
    Object.entries(servers).flatMap(([transport, health]) => {
      return Object.entries(health.checks).map(([name, check]) => {
        return [`${transport}/${name}`, check];
      });
    })
  );

  reply.writeHead(status === 'fail' ? 503 : 200, {
    'cache-control': 'no-store',
    'content-type': 'application/health+json',
  });
  reply.end(JSON.stringify({ checks, status: status ?? 'pass' }));
};

const pages = createServer((request, reply) => {
  if (pathOf(request) === BEAD_PATHNAME) {
    return (exchanges(request, reply), undefined);
  }

  // the gateway's routes and its document, which it claims; any other path is the page's
  if (gateway.listener(request, reply)) {
    return undefined;
  }

  if (pathOf(request) === HEALTH_PATHNAME) {
    return (answerHealth(reply), undefined);
  }

  // the Prometheus text format 0.0.4, with its media type, as a scrape reads it
  if (pathOf(request) === METRICS_PATHNAME) {
    const { contentType, text } = METRICS_REGISTRY.exposition();

    reply.writeHead(200, { 'cache-control': 'no-store', 'content-type': contentType });

    return (reply.end(text), undefined);
  }

  // what went wrong stays on the server
  serve(request, reply).catch((reason: unknown) => {
    process.stderr.write(`${String(reason)}\n`);
    reply.writeHead(500);
    reply.end();
  });

  return undefined;
});

// an upload of 8 MiB over a slow link takes its time; a head that never ends does not
pages.headersTimeout = 10_000;
pages.requestTimeout = 60_000;
pages.on('upgrade', relayUpgrades({ pathname: BEAD_PATHNAME, target: wsTarget }));
pages.listen(HTTP_PORT, HTTP_ADDRESS);
process.stdout.write(
  `Bead, a demo: http://localhost:${String(HTTP_PORT)}, its sign-up over HTTP at /api/SignUp/signUp (Ctrl+C to stop)
`
);

process.once('SIGINT', () => {
  pages.close();
  void overWebSocket[Symbol.asyncDispose]();
  void overHTTP[Symbol.asyncDispose]();
  void gateway[Symbol.asyncDispose]();
  void overMemory[Symbol.asyncDispose]();
});
