// ── Worker transport client ───────────────────────────────────────────────────

// dependencies

import { CLOSE_EVENT, ERROR_EVENT, MESSAGE_EVENT, WORKER_MESSAGES } from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import { ConnectError, GenericError, ProgrammerError, ReadyStateError } from '../shared/errors';
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
  IWorkerErrorEventLike,
  IWorkerTransportClientOptions,
  WorkerTransportClient,
} from './types';

export { TRANSPORT_WORKER, WORKER_MESSAGES } from '../shared/constants';
export type { IWorkerMessageEventLike, IWorkerPortLike } from '../shared/types';
export type {
  IWorkerChannelLike,
  IWorkerErrorEventLike,
  IWorkerLike,
  IWorkerTransportClientOptions,
  WorkerTransportClient,
} from './types';

// constants

/** What an omitted connect option resolves to: a worker answers at once, or not at all. */
export const CONNECT_DEFAULTS = Object.freeze({
  timeout: 10_000,
} satisfies ITransportClientConnectOptions);

// helpers

// what a worker's error says, after what it erred: its message, where its script threw, each where
// given — HTML's 0 and empty string are none
const erredOf = ({ colno, filename, lineno, message }: IWorkerErrorEventLike): string => {
  const said = message ? `: ${message}` : ', saying nothing';
  const line = lineno ? `:${String(lineno)}${colno ? `:${String(colno)}` : ''}` : '';

  return filename ? `${said} (at ${filename}${line})` : said;
};

// definition

/**
 * A transport client to a server in a Web Worker: `connect` makes a `MessageChannel`, keeps one end,
 * posts the other to `worker` with `bead-connect`, and opens on the server's `bead-open`. Envelopes
 * go both ways as bytes, each copied and its buffer transferred; `disconnect` posts `bead-close`, or
 * `bead-lost` when it is not clean, and the server's own closes it, since a port does not tell its
 * close.
 *
 * A connect given up on posts `bead-close` on its end all the same, for a server that takes the port
 * later to end at once. A worker's `error` — an exception its script did not catch, or a script that
 * failed to load — fails the connect under way with a `ConnectError` at once, or ends the connection
 * of the client's own: told once on `error`, with the error's message and where it was thrown, then
 * its close, unclean, its server told `bead-lost`. A worker terminated without a word is not heard. A
 * worker carries no credential beside an envelope: one given to `send` is not carried.
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

      // ended at the other end, or by its worker's error, which may leave it running: its server
      // told all the same, the error before the close, whatever `error` throws (spec 15.1); unclean
      // either way, as every client tells a close it did not ask for
      const lose = (lost: IWorkerPortLike, failure?: GenericError): void => {
        if (port !== lost) {
          return;
        }

        port = undefined;
        client.socket = null;
        lost.postMessage(failure === undefined ? WORKER_MESSAGES.CLOSE : WORKER_MESSAGES.LOST);
        lost.close();
        worker.removeEventListener?.('error', onError);

        if (!client.isReconnecting()) {
          setReadyStateClosed(client);

          try {
            if (failure !== undefined) {
              client.emit(ERROR_EVENT, failure);
            }
          } finally {
            tell(CLOSE_EVENT, [false, false]);
          }
        }
      };

      // heard from the connect on: one under way fails, an open connection ends
      const onError = (event: IWorkerErrorEventLike): void => {
        if (rejectConnect !== undefined) {
          rejectConnect(
            new ConnectError(`its worker erred before the connection opened${erredOf(event)}`)
          );
        } else if (port !== undefined) {
          lose(port, new GenericError(`its worker erred${erredOf(event)}`));
        }
      };

      return {
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
              lose(opened);
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
                worker.addEventListener?.('error', onError);
                worker.postMessage(WORKER_MESSAGES.CONNECT, [channel.port2]);
              },
              { clock: client.clock, signal, timeout }
            );
          } catch (reason) {
            // given up on — timed out, cancelled, disposed, its worker erred: a server that takes the
            // port later ends it
            opened.postMessage(WORKER_MESSAGES.CLOSE);
            opened.close();
            worker.removeEventListener?.('error', onError);

            if (!client.isReconnecting()) {
              setReadyStateClosed(client);
            }

            throw reason;
          } finally {
            rejectConnect = undefined;
          }

          port = opened;
          client.socket = opened;
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
          // its server hears the close as clean as it is
          closing.postMessage(isClean ? WORKER_MESSAGES.CLOSE : WORKER_MESSAGES.LOST);
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

          rejectConnect?.(new ConnectError('the transport client was disposed as it connected'));
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
