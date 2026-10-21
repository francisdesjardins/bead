// ── Memory transport server ───────────────────────────────────────────────────

// dependencies

import {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  MESSAGE_EVENT,
  TRANSPORT_MEMORY,
} from '../shared/constants';
import { ConnectError, ProgrammerError } from '../shared/errors';
import { transferableOf } from '../shared/transferable';
import type { IMemoryEndLike, IMemoryPeerLike, ITransportMessage } from '../shared/types';
import { createTransportServer, generateHandle } from './transport-server';
import type {
  IMemoryTransportServerOptions,
  ITransportServerClientAware,
  ITransportServerStartOptions,
  MemoryTransportServer,
} from './types';

export { TRANSPORT_MEMORY } from '../shared/constants';
export type { IMemoryEndLike, IMemoryPeerLike, IMemoryTransportServerLike } from '../shared/types';
export type { IMemoryTransportServerOptions, MemoryTransportServer } from './types';

// constants

/** What an omitted start option resolves to: in memory, a server listens on no address and no port. */
export const START_DEFAULTS = Object.freeze({
  address: 'local',
  findOpenPort: false,
  port: 0,
} satisfies ITransportServerStartOptions);

// definition

/**
 * A transport server in memory, for a client's router of the same process (spec 15.13): a gateway
 * calling its application's server, a third language's core before it has a socket, a test. A
 * client's connect draws a connection, named `type=MEMORY;ip=<address>;ordinal=n` by the address its
 * client gave, `local` when none, and hands that address and port with each envelope. Each envelope
 * crosses as a copy, whole, once and in order, in a later turn than its send; a credential its
 * client handed with a request crosses beside it, and none goes toward the client.
 *
 * It never leaves the process, so it is secure; it holds no bound, heartbeat or timeout of its own,
 * its routers' limits bounding what crosses. Either end closes a connection, the other told in a
 * later turn; `stop` closes each, and a connect while it does not listen fails, a
 * {@link ConnectError}.
 *
 * @example
 * const server = createMemoryTransportServer();
 * server.on('message', ({ address, credential, data }, connectionHandle) => {});
 * await server.start();
 */
export const createMemoryTransportServer = (
  options?: IMemoryTransportServerOptions
): MemoryTransportServer => {
  // `accept` reaches the registry and `tell`, which only `define` is handed: replaced by it, which
  // `createTransportServer` calls before it returns
  let acceptOf = (_peer: IMemoryPeerLike): Promise<IMemoryEndLike> => {
    return Promise.reject(new ConnectError('the in-memory server is not built'));
  };

  const transport = createTransportServer<IMemoryPeerLike, undefined>(
    (server, connections, { tell }) => {
      let ordinal = 0;

      // a connection held ends: closed at this end, clean, its client told in a later turn; or at
      // its client's, told here as its client closed it; what either end still had on its way goes
      // unheard
      const end = (
        connection: ITransportServerClientAware<IMemoryPeerLike>,
        { isClosedHere, wasClean }: { isClosedHere: boolean; wasClean: boolean }
      ): void => {
        const { connectionHandle, socket: peer } = connection;

        connections.delete(connectionHandle);

        if (isClosedHere) {
          queueMicrotask(() => {
            peer.close(true);
          });
        }

        tell(CLOSE_EVENT, [wasClean, connectionHandle]);
      };

      acceptOf = (peer) => {
        return new Promise((resolve, reject) => {
          // * a later turn than the connect, so its client's router is never entered from it
          queueMicrotask(() => {
            if (!server.isOpen()) {
              return (reject(new ConnectError('the in-memory server is not listening')), undefined);
            }

            const connectionHandle = generateHandle({
              ip: peer.address,
              ordinal: (ordinal += 1),
              type: TRANSPORT_MEMORY,
            });
            const connection: ITransportServerClientAware<IMemoryPeerLike> = {
              address: peer.address,
              connectionHandle,
              lastActivity: undefined,
              port: peer.port ?? 0,
              socket: peer,
              type: TRANSPORT_MEMORY,
            };
            const isHeld = (): boolean => {
              return connections.get(connectionHandle) === connection;
            };

            connections.set(connectionHandle, connection);
            tell(CONNECTION_EVENT, [peer, undefined, connectionHandle]);
            resolve({
              close: (wasClean) => {
                if (isHeld()) {
                  end(connection, { isClosedHere: false, wasClean });
                }
              },
              receive: ({ credential, data }: ITransportMessage) => {
                if (!isHeld()) {
                  return;
                }

                connection.lastActivity = server.clock.Date.now();
                tell(MESSAGE_EVENT, [
                  { address: peer.address, credential, data, port: peer.port },
                  connectionHandle,
                ]);
              },
            });
          });
        });
      };

      return {
        clock: options?.clock,
        defaults: START_DEFAULTS,
        isSecure: true,
        type: TRANSPORT_MEMORY,

        // * its close told in a later turn, after what it sent before, so no router is entered
        // again from its own call; settled once told
        close: (connection) => {
          return new Promise((resolve) => {
            queueMicrotask(() => {
              if (connections.get(connection.connectionHandle) === connection) {
                end(connection, { isClosedHere: true, wasClean: true });
              }

              resolve();
            });
          });
        },
        // a credential given here is not carried: the router fails a command that presents one
        // its transport cannot carry before it goes, DESTINATION_UNREACHABLE (decision 0010)
        send: ({ data }, { socket: peer }) => {
          const bytes = transferableOf(data);

          if (bytes === undefined) {
            return Promise.reject(
              new ProgrammerError('an in-memory connection carries envelopes, as bytes')
            );
          }

          queueMicrotask(() => {
            peer.receive({ data: bytes });
          });

          return Promise.resolve();
        },
        start: ({ address, port }) => {
          return Promise.resolve({ address, port });
        },
        // every connection ended in one later turn, in the order they came: none drawn in a turn
        // before it is left open, and none is drawn after it
        stop: () => {
          return new Promise((resolve) => {
            queueMicrotask(() => {
              for (const connection of connections.values()) {
                end(connection, { isClosedHere: true, wasClean: true });
              }

              resolve();
            });
          });
        },
      };
    }
  );

  return Object.assign(transport, {
    accept: (peer: IMemoryPeerLike): Promise<IMemoryEndLike> => {
      return acceptOf(peer);
    },
  });
};
