// ── Transcoding service ───────────────────────────────────────────────────────

// The `Transcoding` service of `spec/transcoding.proto`, served as `spec/transcoding.json`'s
// `service` states each procedure, on a server whose in-memory transport is joined, and a gateway of
// its route table in front of it: what the conformance's exchanges and the gateway's tests call.

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

/** A gateway in front of a server of the service, and the counts its exchanges wait on. */
export interface ITranscodingFixture extends AsyncDisposable {
  /** The calls of `hang` its resolver took, and those that ended cancelled. */
  readonly counts: { cancelled: number; hanging: number };
  readonly gateway: IHTTPGateway;
  /** The gateway's own listener's port, on 127.0.0.1. */
  readonly port: number;
  readonly server: ReturnType<typeof createServer>;
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
 * table listening on 127.0.0.1 in front of it, of `options` beside the table, the transport, the
 * document and the problem types beadc wrote.
 */
export const startTranscoding = async (
  options: Omit<IHTTPGatewayOptions, 'routes' | 'transport'> = {}
): Promise<ITranscodingFixture> => {
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
  const counts = { cancelled: 0, hanging: 0 };
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
    await server.router.dropSubscriptions({
      connectionHandle,
      failure: { code: 2, detail: '', scope: FailureScope.APPLICATION },
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
      code = (error as { code?: number }).code ?? 0;
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
  service.offer(server);
  await memory.start();

  const gateway = createHTTPGateway({
    createServer: (listener) => {
      return createNodeServer(listener);
    },
    document: OPENAPI_DOCUMENT,
    problemTypes: HTTP_PROBLEM_TYPES,
    ...options,
    routes: HTTP_ROUTES,
    transport: memory,
  });
  const { port } = await gateway.start({ address: '127.0.0.1' });

  return {
    counts,
    gateway,
    port,
    server,
    [Symbol.asyncDispose]: async () => {
      await gateway.stop();
      await server[Symbol.asyncDispose]();
    },
  };
};
