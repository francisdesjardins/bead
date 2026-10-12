// ── Worker transport client ───────────────────────────────────────────────────

// dependencies

import { CLOSE_EVENT, MESSAGE_EVENT, WORKER_MESSAGES } from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import { ConnectError, ProgrammerError, ReadyStateError } from '../shared/errors';
import {
  getReadyState,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import { transferableOf } from '../shared/transferable';
import type { IWorkerPortLike } from '../shared/types';
import { dispose } from './symbols';
import { createTransportClient, DISCONNECT_DEFAULTS } from './transport-client';
import type {
  ITransportClientConnectOptions,
  IWorkerTransportClientOptions,
  WorkerTransportClient,
} from './types';

export { TRANSPORT_WORKER, WORKER_MESSAGES } from '../shared/constants';
export type { IWorkerMessageEventLike, IWorkerPortLike } from '../shared/types';
export type {
  IWorkerChannelLike,
  IWorkerLike,
  IWorkerTransportClientOptions,
  WorkerTransportClient,
} from './types';

// constants

/** What an omitted connect option resolves to: a worker answers at once, or not at all. */
export const CONNECT_DEFAULTS = Object.freeze({
  timeout: 10_000,
} satisfies ITransportClientConnectOptions);

// definition

/**
 * A transport client to a server in a Web Worker: `connect` makes a `MessageChannel`, keeps one end,
 * posts the other to `worker` with `bead-connect`, and opens on the server's `bead-open`. Envelopes
 * go both ways as bytes, each copied and its buffer transferred; `disconnect` posts `bead-close`,
 * and the server's own closes it, since a port does not tell its close.
 *
 * A connect given up on posts `bead-close` on its end all the same, for a server that takes the port
 * later to end at once. A worker's `error` loses the connection; one terminated without a word is
 * not heard. A worker carries no credential beside an envelope: one given to `send` is not carried.
 *
 * @example
 * const client = createWorkerTransportClient({ worker });
 * client.on('message', ({ data }) => {});
 * await client.connect({});
 * await client.send({ data: envelope });
 * await client.disconnect();
 */
export const createWorkerTransportClient = ({
  clock,
  MessageChannel: Channel = globalThis.MessageChannel,
  worker,
}: IWorkerTransportClientOptions): WorkerTransportClient => {
  return createTransportClient<IWorkerPortLike, ITransportClientConnectOptions>(
    (client, { tell }) => {
      let port: IWorkerPortLike | undefined;
      // settles the connect in flight, so a dispose under it cannot leave it pending
      let rejectConnect: ((reason: Error) => void) | undefined;

      // the connection ended at the other end, or with its worker: CLOSED, as a socket dropped; a
      // worker that erred may still run, so its server is told all the same
      const lose = (lost: IWorkerPortLike, isClean: boolean): void => {
        if (port !== lost) {
          return;
        }

        port = undefined;
        client.socket = null;
        lost.postMessage(WORKER_MESSAGES.CLOSE);
        lost.close();
        worker.removeEventListener?.('error', onError);

        if (!client.isReconnecting()) {
          setReadyStateClosed(client);
          tell(CLOSE_EVENT, [isClean, false]);
        }
      };

      const onError = (): void => {
        if (port !== undefined) {
          lose(port, false);
        }
      };

      return {
        carriesCredential: false,
        clock,
        isSecure: true,

        connect: async ({ signal, timeout = CONNECT_DEFAULTS.timeout }) => {
          const channel = new Channel();
          const opened = channel.port1;

          opened.addEventListener('message', ({ data }) => {
            if (data instanceof ArrayBuffer) {
              const isHeard = port === opened;

              return (
                isHeard ? tell(MESSAGE_EVENT, [{ credential: undefined, data }]) : undefined,
                undefined
              );
            }

            if (data === WORKER_MESSAGES.CLOSE) {
              lose(opened, true);
            }
          });

          try {
            await createPromise(
              (resolve, reject) => {
                if (!client.isReconnecting()) {
                  setReadyStateConnecting(client);
                }

                rejectConnect = reject;
                opened.addEventListener('message', ({ data }) => {
                  if (data === WORKER_MESSAGES.OPEN) {
                    resolve();
                  }
                });
                opened.start();
                worker.postMessage(WORKER_MESSAGES.CONNECT, [channel.port2]);
              },
              { clock: client.clock, signal, timeout }
            );
          } catch (reason) {
            // given up on — timed out, cancelled, disposed: a server that takes the port later ends it
            opened.postMessage(WORKER_MESSAGES.CLOSE);
            opened.close();

            if (!client.isReconnecting()) {
              setReadyStateClosed(client);
            }

            throw reason;
          } finally {
            rejectConnect = undefined;
          }

          port = opened;
          client.socket = opened;
          worker.addEventListener?.('error', onError);
          setReadyStateOpen(client);
        },

        disconnect: (disconnectOptions) => {
          const { isClean = DISCONNECT_DEFAULTS.isClean, isQuick = DISCONNECT_DEFAULTS.isQuick } =
            disconnectOptions ?? {};
          const closing = port;

          if (!client.isOpen() || closing === undefined) {
            return Promise.reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN));
          }

          setReadyStateClosing(client);
          port = undefined;
          client.socket = null;
          closing.postMessage(WORKER_MESSAGES.CLOSE);
          closing.close();
          worker.removeEventListener?.('error', onError);
          setReadyStateClosed(client);
          tell(CLOSE_EVENT, [isClean, isQuick]);

          return Promise.resolve();
        },

        // a credential given here is not carried: the client fails a call that presents one its
        // transport cannot carry before it goes, DESTINATION_UNREACHABLE (decision 0010)
        send: ({ data }) => {
          const open = port;

          if (!client.isOpen() || open === undefined) {
            return Promise.reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN));
          }

          const bytes = transferableOf(data);

          if (bytes === undefined) {
            return Promise.reject(
              new ProgrammerError('a worker connection carries envelopes, as bytes')
            );
          }

          open.postMessage(bytes, [bytes]);

          return Promise.resolve();
        },

        [dispose]: () => {
          const dropped = port;

          rejectConnect?.(new ConnectError('disposed while connecting'));
          port = undefined;
          client.socket = null;
          worker.removeEventListener?.('error', onError);

          // the server told, since a port does not tell its close
          if (dropped !== undefined) {
            dropped.postMessage(WORKER_MESSAGES.CLOSE);
            dropped.close();
          }
        },
      };
    }
  );
};
