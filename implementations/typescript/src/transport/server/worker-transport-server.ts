// ── Worker transport server ───────────────────────────────────────────────────

// dependencies

import {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  MESSAGE_EVENT,
  TRANSPORT_WORKER,
  WORKER_MESSAGES,
} from '../shared/constants';
import { ProgrammerError } from '../shared/errors';
import { transferableOf } from '../shared/transferable';
import type { IWorkerMessageEventLike, IWorkerPortLike } from '../shared/types';
import { createTransportServer, generateDrawnHandle } from './transport-server';
import type {
  ITransportServerClientAware,
  ITransportServerStartOptions,
  IWorkerTransportServerOptions,
  WorkerTransportServer,
} from './types';

export { TRANSPORT_WORKER, WORKER_MESSAGES } from '../shared/constants';
export type { IWorkerMessageEventLike, IWorkerPortLike } from '../shared/types';
export type {
  IWorkerScopeLike,
  IWorkerTransportServerOptions,
  WorkerTransportServer,
} from './types';

// constants

/** What an omitted start option resolves to: a worker listens on no address and no port. */
export const START_DEFAULTS = Object.freeze({
  address: 'local',
  findOpenPort: false,
  port: 0,
} satisfies ITransportServerStartOptions);

// definition

/**
 * A transport server in a Web Worker, for a page that runs its server beside it, with no backend.
 * A client connects by posting `bead-connect` to the worker with one end of a `MessageChannel`: that
 * port is the connection, named `type=WORKER;ip=local;ordinal=n`, and the server says `bead-open` on
 * it. Envelopes go both ways as bytes, each buffer transferred; either end ends the connection by
 * posting `bead-close`, since a port does not tell its close. Any other message the worker hears is
 * the application's, and left to it.
 *
 * `start` listens at once, before anything is awaited, so no connect a worker hears early is lost.
 * A worker terminated takes its connections with it, and a port does not say so. A worker carries no
 * credential beside an envelope: each message delivered carries none, and a credential given to
 * `send` is not carried.
 *
 * @example
 * const server = createWorkerTransportServer({ scope });
 * server.on('message', ({ data }, connectionHandle) => {});
 * await server.start();
 */
export const createWorkerTransportServer = ({
  clock,
  scope,
}: IWorkerTransportServerOptions): WorkerTransportServer => {
  return createTransportServer<IWorkerPortLike, undefined>((server, connections) => {
    let ordinal = 0;

    // a connection held ends: its port closes, and what it still had queued goes unheard
    const end = (connection: ITransportServerClientAware<IWorkerPortLike>): void => {
      const { connectionHandle, socket: port } = connection;

      port.close();
      connections.delete(connectionHandle);
      server.emit(CLOSE_EVENT, true, connectionHandle);
    };

    // a connect: the port it carries is the connection, accepted on it
    const onConnect = (port: IWorkerPortLike): void => {
      const connectionHandle = generateDrawnHandle({
        ip: 'local',
        ordinal: (ordinal += 1),
        type: TRANSPORT_WORKER,
      });
      const connection: ITransportServerClientAware<IWorkerPortLike> = {
        address: 'local',
        connectionHandle,
        lastActivity: undefined,
        port: 0,
        socket: port,
        type: TRANSPORT_WORKER,
      };

      // what a port still had queued as its connection ended is heard by nobody
      const onMessage = ({ data }: IWorkerMessageEventLike): void => {
        if (connections.get(connectionHandle) !== connection) {
          return;
        }

        if (data instanceof ArrayBuffer) {
          connection.lastActivity = server.clock.Date.now();

          return (
            server.emit(MESSAGE_EVENT, { credential: undefined, data }, connectionHandle), undefined
          );
        }

        if (data === WORKER_MESSAGES.CLOSE) {
          end(connection);
        }
      };

      port.addEventListener('message', onMessage);
      port.start();
      connections.set(connectionHandle, connection);
      server.emit(CONNECTION_EVENT, port, undefined, connectionHandle);
      port.postMessage(WORKER_MESSAGES.OPEN);
    };

    const onScopeMessage = ({ data, ports: [port] }: IWorkerMessageEventLike): void => {
      if (data === WORKER_MESSAGES.CONNECT && port !== undefined) {
        onConnect(port);
      }
    };

    return {
      clock,
      defaults: START_DEFAULTS,
      isSecure: true,
      type: TRANSPORT_WORKER,

      close: (connection) => {
        connection.socket.postMessage(WORKER_MESSAGES.CLOSE);
        end(connection);

        return Promise.resolve();
      },
      // a credential given here is not carried: the router fails a command that presents one
      // its transport cannot carry before it goes, DESTINATION_UNREACHABLE (decision 0010)
      send: ({ data }, { socket: port }) => {
        const bytes = transferableOf(data);

        if (bytes === undefined) {
          return Promise.reject(
            new ProgrammerError('a worker connection carries envelopes, as bytes')
          );
        }

        port.postMessage(bytes, [bytes]);

        return Promise.resolve();
      },
      start: ({ address, port }) => {
        scope.addEventListener('message', onScopeMessage);

        return Promise.resolve({ address, port });
      },
      stop: () => {
        scope.removeEventListener('message', onScopeMessage);

        for (const connection of connections.values()) {
          connection.socket.postMessage(WORKER_MESSAGES.CLOSE);
          end(connection);
        }

        return Promise.resolve();
      },
    };
  });
};
