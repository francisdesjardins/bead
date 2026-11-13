// ── Transcoding service ───────────────────────────────────────────────────────

// The `Transcoding` service of `spec/transcoding.proto`, served as `spec/transcoding.json`'s
// `service` states each procedure, on a server whose in-memory transport is joined, behind a
// gateway on its own listener or mounted on an application's.

// dependencies

import { createServer as createNodeServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { FailureScope } from '../../router/shared/constants';
import { createServer } from '../../server/server';
import { joinTransports } from '../../transport/server/joined-transport-server';
import { createMemoryTransportServer } from '../../transport/server/memory-transport-server';
import { createHTTPGateway, type IHTTPGateway, type IHTTPGatewayOptions } from '../http-gateway';
import { HTTP_PROBLEM_TYPES, HTTP_ROUTES, OPENAPI_DOCUMENT } from './generated/bead_http';
import { TranscodingFailures, TranscodingServer } from './generated/transcoding_bead';

// interfaces

/** An application's server a gateway built with no `createServer` is mounted on, listening. */
export interface IMounted extends AsyncDisposable {
  /** Its port, on 127.0.0.1. */
  readonly port: number;
}

/** Mounts a gateway built with no `createServer` on an application's server, and starts it. */
export type Mount = (gateway: IHTTPGateway) => Promise<IMounted>;

/** A gateway's options but its transport, and the application's server that mounts it, if one does. */
export interface ITranscodingOptions
  extends
    Omit<IHTTPGatewayOptions, 'routes' | 'transport'>,
    Partial<Pick<IHTTPGatewayOptions, 'routes'>> {
  readonly mount?: Mount | undefined;
}

/** A gateway in front of a server of the service, and the counts its exchanges wait on. */
export interface ITranscodingFixture extends AsyncDisposable {
  /**
   * The calls of `hang` its resolver took, and those that ended cancelled; the calls of `require`
   * its resolver took, and the errors its server reported.
   */
  readonly counts: { cancelled: number; hanging: number; reported: number; requires: number };
  readonly gateway: IHTTPGateway;
  /** The in-memory transport its gateway's connections cross. */
  readonly memory: ReturnType<typeof createMemoryTransportServer>;
  /** The port of the gateway's own listener, or of the server it is mounted on, on 127.0.0.1. */
  readonly port: number;
  /** The detail of each command of `ask` that failed, in their order. */
  readonly refused: string[];
  readonly server: ReturnType<typeof createServer>;
  /** Notifies each subscriber of `watch` with `remaining`, as its server's service does. */
  readonly watched: (remaining: number) => Promise<void>;
}

// constants

/** The value of `authorization` the server's `ELSEWHERE` verifier takes, and the session it names. */
export const GOOD_CREDENTIAL = 'Bearer good';
export const SESSION = 'ada';

// how long `cancels` waits for the cancels it is asked for at most
const CANCELS_PATIENCE = 1_000;

// definition

/**
 * A server of the `Transcoding` service, its in-memory transport joined, and a gateway of its route
 * table listening on 127.0.0.1 in front of it, of `options` beside the transport, the document, the
 * problem types and the table beadc wrote, unless `options` gives one; where `options` mounts it,
 * built with no `createServer`, listening on the server it is mounted on.
 */
export const startTranscoding = async (
  options: ITranscodingOptions = {}
): Promise<ITranscodingFixture> => {
  const { mount, ...given } = options;
  const memory = createMemoryTransportServer();
  const server = createServer(
    { transport: joinTransports([memory]) },
    {
      credentials: {
        verify: (carried) => {
          return carried === GOOD_CREDENTIAL ? { id: SESSION } : undefined;
        },
      },
    }
  );
  const counts = { cancelled: 0, hanging: 0, reported: 0, requires: 0 };
  const refused: string[] = [];
  const service = new TranscodingServer();

  service.on('echo', (request, response) => {
    return response(request.payload);
  });
  service.on('echoEdges', (request, response) => {
    return response(request.payload);
  });
  service.on('getBook', (request, response) => {
    const { name, revision } = request.payload;

    return response({ name, pages: revision, title: 'A tale' });
  });
  service.on('listBooks', (request, response) => {
    const { parent } = request.payload;

    return response({
      books: [
        { name: `${parent}/books/a`, title: 'A' },
        { name: `${parent}/books/b`, title: 'B' },
      ],
    });
  });
  service.on('updateBook', (request, response) => {
    return response(request.payload);
  });
  service.on('archiveBook', (_request, response) => {
    return response({});
  });
  service.on('listOperations', (request, response) => {
    return response({ operations: [{ done: false, name: `${request.payload.name}/a` }] });
  });
  service.on('getOperation', (request, response) => {
    return response({ done: true, name: request.payload.name });
  });
  service.on('judge', (_request, response) => {
    return response({});
  });
  service.on('ticks', async (request, response) => {
    const { connectionHandle, payload } = request;

    await response({ ticks: payload.from });

    for (let remaining = payload.from - 1; remaining >= 0; remaining -= 1) {
      await service.notify.ticks(
        { remaining },
        {
          filter: (subscriber) => {
            return subscriber.connectionHandle === connectionHandle;
          },
        }
      );
    }

    // * the subscription ends with the service's own failure, on its call id
    await server.router.dropSubscriptions(connectionHandle, {
      code: 2,
      detail: '',
      scope: FailureScope.APPLICATION,
    });
  });
  service.on('watch', (_request, response) => {
    return response({});
  });
  service.on('raw', (request, response) => {
    return response(request.payload);
  });
  service.on('text', (request, response) => {
    return response(request.payload);
  });
  service.on('json', (request, response) => {
    return response(request.payload);
  });
  service.on('fail', (request, response) => {
    return response(null, TranscodingFailures.of('REFUSED', request.payload.detail));
  });
  service.on('whoAmI', (request, response) => {
    const identifier = request.session?.identifier;

    return response({
      session: identifier !== undefined && 'id' in identifier ? identifier.id : '',
    });
  });
  service.on('ask', async (request, response) => {
    let code = 0;

    try {
      await service.command.answer({})({ connectionHandle: request.connectionHandle });
    } catch (error) {
      const failed = error as { code?: number; detail?: string };

      code = failed.code ?? 0;
      refused.push(failed.detail ?? '');
    }

    await response({ code });
  });
  service.on('hang', (request) => {
    counts.hanging += 1;
    request.signal.addEventListener('abort', () => {
      counts.cancelled += 1;
    });

    return new Promise(() => {});
  });
  service.on('cancels', async (request, response) => {
    const until = performance.now() + CANCELS_PATIENCE;

    while (counts.cancelled < request.payload.atLeast && performance.now() < until) {
      await sleep(5);
    }

    return response({ count: counts.cancelled });
  });
  service.on('require', (request, response) => {
    counts.requires += 1;

    // * a Needs of no field where none is set, which its codec refuses to write (spec 17.9.7)
    return response(request.payload.needs ?? {});
  });
  service.on('getNeeds', (request, response) => {
    return response(request.payload);
  });
  service.on('updateNeeds', (request, response) => {
    return response(request.payload.needs ?? {});
  });
  server.router.on('error', () => {
    counts.reported += 1;
  });
  service.offer(server);
  await memory.start();

  const gateway = createHTTPGateway({
    ...(mount === undefined
      ? {
          createServer: (listener) => {
            return createNodeServer(listener);
          },
        }
      : {}),
    document: OPENAPI_DOCUMENT,
    problemTypes: HTTP_PROBLEM_TYPES,
    routes: HTTP_ROUTES,
    ...given,
    transport: memory,
  });
  const mounted = mount === undefined ? undefined : await mount(gateway);
  const { port } = mounted ?? (await gateway.start({ address: '127.0.0.1' }));

  return {
    counts,
    gateway,
    memory,
    port,
    refused,
    server,
    watched: async (remaining) => {
      await service.notify.watch({ remaining });
    },
    [Symbol.asyncDispose]: async () => {
      await gateway.stop();
      await mounted?.[Symbol.asyncDispose]();
      await server[Symbol.asyncDispose]();
    },
  };
};
