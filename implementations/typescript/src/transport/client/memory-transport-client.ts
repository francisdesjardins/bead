// ── Memory transport client ───────────────────────────────────────────────────

// dependencies

import { CLOSE_EVENT, MESSAGE_EVENT } from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import { ConnectError, ProgrammerError, ReadyStateError, toError } from '../shared/errors';
import {
  getReadyState,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import { transferableOf } from '../shared/transferable';
import type { IMemoryEndLike, IMemoryPeerLike, ITransportMessage } from '../shared/types';
import { dispose } from './symbols';
import { createTransportClient, DISCONNECT_DEFAULTS, isFieldValue } from './transport-client';
import type {
  IMemoryTransportClientConnectOptions,
  IMemoryTransportClientOptions,
  MemoryTransportClient,
} from './types';

export { TRANSPORT_MEMORY } from '../shared/constants';
export type { IMemoryEndLike, IMemoryPeerLike, IMemoryTransportServerLike } from '../shared/types';
export type {
  IMemoryTransportClientConnectOptions,
  IMemoryTransportClientOptions,
  MemoryTransportClient,
} from './types';

// constants

/** What an omitted connect option resolves to: a server of the process answers at once, or not at all. */
export const CONNECT_DEFAULTS = Object.freeze({
  address: 'local',
  timeout: 10_000,
} satisfies IMemoryTransportClientConnectOptions);

// an address a handle can name: visible ASCII but `;`, which ends a handle's part
const ADDRESS = /^[!-:<-~]+$/u;

// definition

/**
 * A transport client to an in-memory transport server of the same process (spec 15.13): `connect`
 * hands its server an end of its own, with the address and port it is given, and opens once the
 * server drew the connection. Each envelope crosses as a copy, whole, once and in order, in a later
 * turn than its send, with the credential a request presents beside it, any field value; nothing
 * the server sends carries one.
 *
 * It never leaves the process, so it is secure; it holds no bound or heartbeat of its own, and a
 * connect's timeout alone. `disconnect` closes the connection, its server told in a later turn,
 * clean as the close said; a server that closes it is heard as a `close`, not clean at this end.
 *
 * @example
 * const client = createMemoryTransportClient({ server });
 * client.on('message', ({ data }) => {});
 * await client.connect({ address: '192.0.2.7', port: 50_000 });
 * await client.send({ credential: 'Bearer token', data: envelope });
 * await client.disconnect();
 */
export const createMemoryTransportClient = ({
  clock,
  server,
}: IMemoryTransportClientOptions): MemoryTransportClient => {
  return createTransportClient<IMemoryEndLike, IMemoryTransportClientConnectOptions>(
    (client, { tell }) => {
      // the open connection: this client's end, and its server's
      let current: { end: IMemoryEndLike; peer: IMemoryPeerLike } | undefined;
      // gives up on the connect in flight, so a dispose under it cannot leave it pending, nor let it
      // open once its connection was drawn
      let giveUp: ((reason: Error) => void) | undefined;

      const drop = (): IMemoryEndLike | undefined => {
        const end = current?.end;

        current = undefined;
        client.socket = null;

        return end;
      };

      return {
        clock,
        isSecure: true,

        assertConnect: ({ address = CONNECT_DEFAULTS.address, port }) => {
          if (typeof address !== 'string' || !ADDRESS.test(address)) {
            throw new ProgrammerError(
              "an in-memory connect's address is visible ASCII but ';', at least one character"
            );
          }

          if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65_535)) {
            throw new ProgrammerError(
              "an in-memory connect's port is a whole number from 0 to 65535"
            );
          }
        },
        carries: isFieldValue,

        connect: async ({
          address = CONNECT_DEFAULTS.address,
          port,
          signal,
          timeout = CONNECT_DEFAULTS.timeout,
        }) => {
          // what the server sent before this end opened, heard once it has, in its order
          const early: ITransportMessage[] = [];
          // held in an object, which its ends' calls change behind the narrowing of a `let`
          const attempt = { isClosedEarly: false, isGivenUp: false, isOpened: false };
          const isCurrent = (): boolean => {
            return current?.peer === peer;
          };

          const peer: IMemoryPeerLike = {
            address,
            port,

            // the server closed it: CLOSED, as a socket the peer closed, not clean at this end
            close: () => {
              if (isCurrent()) {
                drop();

                if (!client.isReconnecting()) {
                  setReadyStateClosed(client);
                  tell(CLOSE_EVENT, [false, false]);
                }
              } else {
                attempt.isClosedEarly = true;
              }
            },
            receive: (message) => {
              if (isCurrent()) {
                return (tell(MESSAGE_EVENT, [message]), undefined);
              }

              // what comes once this end closed is dropped, as a socket's would be
              if (!attempt.isGivenUp && !attempt.isClosedEarly && !attempt.isOpened) {
                early.push(message);
              }
            },
          };

          let end: IMemoryEndLike;

          try {
            end = await createPromise<IMemoryEndLike>(
              (resolve, reject) => {
                if (!client.isReconnecting()) {
                  setReadyStateConnecting(client);
                }

                giveUp = (reason) => {
                  attempt.isGivenUp = true;
                  reject(reason);
                };
                server.accept(peer).then(
                  (accepted) => {
                    // a connection drawn once its connect was given up on is closed at once
                    if (attempt.isGivenUp) {
                      queueMicrotask(() => {
                        accepted.close(false);
                      });
                    }

                    resolve(accepted);
                  },
                  (reason: unknown) => {
                    reject(toError(reason));
                  }
                );
              },
              { clock: client.clock, signal, timeout }
            );

            // given up on as its connection was drawn, which then closes; or closed by its server
            if (attempt.isGivenUp) {
              const accepted = end;

              queueMicrotask(() => {
                accepted.close(false);
              });

              throw new ConnectError('disposed while connecting');
            }

            if (attempt.isClosedEarly) {
              throw new ConnectError('the in-memory server closed the connection as it opened');
            }
          } catch (reason) {
            attempt.isGivenUp = true;

            if (!client.isReconnecting()) {
              setReadyStateClosed(client);
            }

            throw reason;
          } finally {
            giveUp = undefined;
          }

          current = { end, peer };
          attempt.isOpened = true;
          client.socket = end;
          setReadyStateOpen(client);

          for (const message of early) {
            if (isCurrent()) {
              tell(MESSAGE_EVENT, [message]);
            }
          }
        },

        disconnect: (disconnectOptions) => {
          const { isClean = DISCONNECT_DEFAULTS.isClean, isQuick = DISCONNECT_DEFAULTS.isQuick } =
            disconnectOptions ?? {};

          if (!client.isOpen() || current === undefined) {
            return Promise.reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN));
          }

          setReadyStateClosing(client);

          const end = drop();

          // its server told in a later turn, clean as this end's close says
          queueMicrotask(() => {
            end?.close(isClean);
          });
          setReadyStateClosed(client);
          tell(CLOSE_EVENT, [isClean, isQuick]);

          return Promise.resolve();
        },

        // ! the bytes copied now, so a sender that reuses its buffer changes nothing on its way
        send: ({ credential, data }) => {
          const end = current?.end;

          if (!client.isOpen() || end === undefined) {
            return Promise.reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN));
          }

          // refused before it goes, the connection kept: a field could not carry it as it is
          if (credential !== undefined && !isFieldValue(credential)) {
            return Promise.reject(
              new ProgrammerError(
                'a credential holds visible ASCII, spaces and tabs alone, none first or last'
              )
            );
          }

          const bytes = transferableOf(data);

          if (bytes === undefined) {
            return Promise.reject(
              new ProgrammerError('an in-memory connection carries envelopes, as bytes')
            );
          }

          // an empty credential carries none, as an empty field does
          const carried = credential === '' ? undefined : credential;

          queueMicrotask(() => {
            end.receive({ credential: carried, data: bytes });
          });

          return Promise.resolve();
        },

        [dispose]: () => {
          giveUp?.(new ConnectError('disposed while connecting'));

          const end = drop();

          // the server told, as a connection dropped
          if (end !== undefined) {
            queueMicrotask(() => {
              end.close(false);
            });
          }
        },
      };
    }
  );
};
