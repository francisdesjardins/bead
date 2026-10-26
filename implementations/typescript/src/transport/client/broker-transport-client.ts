// ── Broker transport client ───────────────────────────────────────────────────

// dependencies

import {
  CloseCode,
  isToken,
  type IParcel,
  LEAST_RECEIVE_BOUND,
  ParcelFlag,
  REFUSE_REASONS,
} from '../shared/broker-parcel';
import {
  type IBrokerConnection,
  type IBrokerParticipant,
  portOf,
} from '../shared/broker-participant';
import { BROKER_PUBLISHED, CLOSE_EVENT, ERROR_EVENT, MESSAGE_EVENT } from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import {
  ConnectError,
  GenericError,
  ProgrammerError,
  ReadyStateError,
  toError,
} from '../shared/errors';
import { noop } from '../shared/noop';
import {
  getReadyState,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import { transferableOf } from '../shared/transferable';
import type { IBrokerPeer, ITransportMessage } from '../shared/types';
import { assertCount } from '../server/server-bounds';
import { dispose } from './symbols';
import { createTransportClient, DISCONNECT_DEFAULTS, isFieldValue } from './transport-client';
import type {
  BrokerTransportClient,
  IBrokerTransportClientConnectOptions,
  IBrokerTransportClientOptions,
} from './types';

export { TRANSPORT_BROKER } from '../shared/constants';
export type {
  BrokerTransportClient,
  IBrokerTransportClientConnectOptions,
  IBrokerTransportClientOptions,
} from './types';

// interfaces

// one connect, from its OPEN to the end of its connection
interface IAttempt {
  connection?: IBrokerConnection | undefined;
  /** What its connection handed on before its connect opened, heard once it has. */
  readonly early: ITransportMessage[];
  isEnded: boolean;
  isEndedEarly: boolean;
  isOpen: boolean;
  release: () => void;
}

// constants

/** What an omitted connect option resolves to: an OPEN answered within 10 seconds, or not at all. */
export const CONNECT_DEFAULTS = Object.freeze({ timeout: 10_000 });

/**
 * What may wait on its connection for its broker, by default: a WebSocket's own bound, since a broker
 * carries the same router's envelopes (spec 15.12).
 */
export const MAXIMUM_UNSENT_BYTES = 184_551_424;

// definition

/**
 * A connect its server refused (spec 15.18), named as section 15.6 names a refusal: the REFUSE's
 * status and reason, a 426's layouts its server reads; or `no-subscriber`, its broker saying no
 * participant serves the name. It is the `cause` of the {@link ConnectError} the connect fails with.
 */
export class BrokerRefusedError extends GenericError {
  public override readonly name: string = 'BrokerRefusedError';

  /** The layouts a 426 names. */
  public readonly layouts: readonly number[] | undefined;
  /** `malformed`, `layout-refused`, `busy`, or `no-subscriber`. */
  public readonly reason: string;
  /** The REFUSE's status; none for `no-subscriber`. */
  public readonly status: number | undefined;

  public constructor({
    layouts,
    reason,
    status,
  }: {
    layouts?: readonly number[] | undefined;
    reason: string;
    status?: number | undefined;
  }) {
    super(
      status === undefined
        ? `no participant serves the name: ${reason}`
        : `the server refused the connection: ${String(status)} ${reason}`
    );

    this.layouts = layouts;
    this.reason = reason;
    this.status = status;
  }
}

// a connect's failure, its refusal the cause (spec 15.18)
const refusedOf = (refusal: BrokerRefusedError): ConnectError => {
  return new ConnectError(refusal.message, { cause: refusal });
};

/**
 * A client's transport over a broker participant (spec 15.18 to 15.22): `connect` publishes an OPEN
 * to the server's name, its half drawn anew, and takes the first ACCEPT naming it, sending at once
 * the PING of its third leg; any other ACCEPT is reset by its participant, and a REFUSE fails the
 * connect, a {@link ConnectError} whose `cause` is a {@link BrokerRefusedError}, as does a broker
 * that says nothing serves the name. Each
 * envelope crosses in DATA parcels, in parts past its server's bound, with the credential a request
 * presents, any field value; a server's DATA that carries one closes the connection with 1002. It is
 * secure while its participant's leg and its server's are; a reconnection opens a new connection
 * through the same name, possibly to another participant.
 *
 * @example
 * const client = participant.transportClient();
 * client.on('message', ({ data }) => {});
 * await client.connect({ server: 'interop' });
 * await client.send({ credential: 'Bearer token', data: envelope });
 */
export const createBrokerTransportClient = (
  participant: IBrokerParticipant,
  options?: IBrokerTransportClientOptions
): BrokerTransportClient => {
  const port = portOf(participant);
  const { maximumUnsentBytes = MAXIMUM_UNSENT_BYTES } = options ?? {};

  assertCount('maximumUnsentBytes', { value: maximumUnsentBytes });

  return createTransportClient<IBrokerPeer, IBrokerTransportClientConnectOptions>(
    (client, { tell }) => {
      let current: IAttempt | undefined;
      // gives up on the connect in flight, so a dispose under it cannot leave it pending
      let giveUp: ((reason: Error) => void) | undefined;
      let isPeerSecure = false;

      const drop = (): IAttempt | undefined => {
        const attempt = current;

        current = undefined;
        client.socket = null;

        return attempt;
      };

      // the connection a connect's ACCEPT opens, told what befalls it once its connect opened
      const connectionOf = (
        attempt: IAttempt,
        { accepted, opener }: { accepted: IParcel; opener: Uint8Array }
      ) => {
        const peer: IBrokerPeer = Object.freeze({
          bound: accepted.bound ?? LEAST_RECEIVE_BOUND,
          id: accepted.id ?? '',
          incarnation: accepted.incarnation ?? new Uint8Array(),
          isSecure: ((accepted.flags ?? 0) & ParcelFlag.SECURE) !== 0,
        });

        return port.connect(
          { acceptor: accepted.acceptor, isOpener: true, opener, peer },
          {
            maximumUnsentBytes,
            owner: {
              envelope: ({ data }) => {
                const message = { data };

                if (current === attempt && attempt.isOpen) {
                  return (tell(MESSAGE_EVENT, [message]), undefined);
                }

                if (!attempt.isEnded) {
                  attempt.early.push(message);
                }

                return undefined;
              },
              // its server closed it, or it was lost: CLOSED, clean by a CLOSE of 1000 alone
              end: (wasClean) => {
                if (current !== attempt) {
                  attempt.isEndedEarly = true;

                  return;
                }

                drop();

                if (!client.isReconnecting()) {
                  setReadyStateClosed(client);
                  tell(CLOSE_EVENT, [wasClean, false]);
                }
              },
              report: (error) => {
                if (current === attempt) {
                  client.emit(ERROR_EVENT, error);
                }
              },
              subject: () => {
                return `the connection to ${peer.id}`;
              },
            },
          }
        );
      };

      return {
        clock: port.clock,
        get isSecure() {
          return port.isSecure && isPeerSecure;
        },

        assertConnect: ({ server }) => {
          if (typeof server !== 'string' || !isToken(server)) {
            throw new ProgrammerError(
              `a server's name is a token of base64url's alphabet, 1 to 64 characters, not ${JSON.stringify(server)}`
            );
          }
        },
        carries: isFieldValue,

        connect: async ({ server, signal, timeout = CONNECT_DEFAULTS.timeout }) => {
          const attempt: IAttempt = {
            early: [],
            isEnded: false,
            isEndedEarly: false,
            isOpen: false,
            release: noop,
          };

          if (!client.isReconnecting()) {
            setReadyStateConnecting(client);
          }

          try {
            await createPromise(
              (resolve, reject) => {
                giveUp = reject;

                // * its link up first, within its time (spec 15.15); then its OPEN, its half drawn
                // anew, and the first answer naming that half
                const opening = async (): Promise<void> => {
                  await port.linked({ signal });

                  if (attempt.isEnded) {
                    return;
                  }

                  const opener = port.drawHalf();

                  attempt.release = port.awaitAnswers(opener, {
                    accept: (accepted) => {
                      attempt.release();
                      attempt.connection = connectionOf(attempt, { accepted, opener });
                      resolve();
                    },
                    fail: (error) => {
                      attempt.release();
                      reject(error);
                    },
                    refuse: ({ layouts, status = 0 }) => {
                      attempt.release();
                      reject(
                        refusedOf(
                          new BrokerRefusedError({
                            layouts,
                            reason: REFUSE_REASONS[status] ?? String(status),
                            status,
                          })
                        )
                      );
                    },
                  });

                  const published = await port.open(server, opener);

                  if (published === BROKER_PUBLISHED.NO_SUBSCRIBER) {
                    attempt.release();
                    reject(
                      refusedOf(new BrokerRefusedError({ reason: BROKER_PUBLISHED.NO_SUBSCRIBER }))
                    );
                  }
                };

                opening().catch((reason: unknown) => {
                  reject(toError(reason));
                });
              },
              { clock: port.clock, signal, timeout }
            );

            if (attempt.isEndedEarly || attempt.connection === undefined) {
              throw new ConnectError('the server closed the connection as it opened');
            }
          } catch (reason) {
            // ! what the connect drew as it ended is let go: a later ACCEPT is reset, one taken is
            attempt.isEnded = true;
            attempt.release();
            attempt.connection?.reset();

            if (!client.isReconnecting()) {
              setReadyStateClosed(client);
            }

            throw toError(reason);
          } finally {
            giveUp = undefined;
          }

          current = attempt;
          attempt.isOpen = true;
          isPeerSecure = attempt.connection.peer.isSecure;
          client.socket = attempt.connection.peer;
          setReadyStateOpen(client);

          for (const message of attempt.early.splice(0)) {
            if (current === attempt) {
              tell(MESSAGE_EVENT, [message]);
            }
          }
        },

        // a clean close by a CLOSE of 1000; any other by a RESET, at once
        disconnect: (disconnectOptions) => {
          const { isClean = DISCONNECT_DEFAULTS.isClean, isQuick = DISCONNECT_DEFAULTS.isQuick } =
            disconnectOptions ?? {};

          if (!client.isOpen() || current === undefined) {
            return Promise.reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN));
          }

          setReadyStateClosing(client);

          const connection = drop()?.connection;

          if (isClean) {
            connection?.close(CloseCode.NORMAL);
          } else {
            connection?.reset();
          }

          setReadyStateClosed(client);
          tell(CLOSE_EVENT, [isClean, isQuick]);

          return Promise.resolve();
        },

        send: ({ credential, data }) => {
          const connection = current?.connection;

          if (!client.isOpen() || connection === undefined) {
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
              new ProgrammerError('a broker connection carries envelopes, as bytes')
            );
          }

          // an empty credential carries none, as an empty field does
          return connection.send(new Uint8Array(bytes), {
            credential: credential === '' ? undefined : credential,
          });
        },

        [dispose]: () => {
          giveUp?.(new ConnectError('the transport client was disposed as it connected'));
          drop()?.connection?.reset();
        },
      };
    }
  );
};
