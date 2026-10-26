// ── Broker transport server ───────────────────────────────────────────────────

// dependencies

import {
  isToken,
  type IParcel,
  LEAST_RECEIVE_BOUND,
  PARCEL_LAYOUT,
  ParcelFlag,
  REFUSE_REASONS,
  CloseCode,
} from '../shared/broker-parcel';
import {
  type IBrokerConnection,
  type IBrokerParticipant,
  portOf,
} from '../shared/broker-participant';
import { assertHeldFinite, type TimeoutId } from '../shared/clock';
import {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  REFUSAL_EVENT,
} from '../shared/constants';
import { ProgrammerError } from '../shared/errors';
import { gaugesOf } from '../shared/gauges';
import { transferableOf } from '../shared/transferable';
import type { IBrokerPeer } from '../shared/types';
import { assertCount, MAXIMUM_CONNECTIONS, MAXIMUM_CONNECTIONS_PER_ADDRESS } from './server-bounds';
import { createTransportServer } from './transport-server';
import type {
  BrokerTransportServer,
  IBrokerTransportServerOptions,
  ITransportServerClientAware,
  TransportServerConnectionHandle,
} from './types';

export { TRANSPORT_BROKER } from '../shared/constants';
export { MAXIMUM_CONNECTIONS, MAXIMUM_CONNECTIONS_PER_ADDRESS } from './server-bounds';
export type { BrokerTransportServer, IBrokerTransportServerOptions } from './types';

// interfaces

// a connection this transport holds, half-open until its third leg draws its handle
interface IHeld {
  connection?: IBrokerConnection | undefined;
  handle?: TransportServerConnectionHandle | undefined;
  readonly peer: IBrokerPeer;
  timer?: TimeoutId | undefined;
}

// constants

/** How long a half-open connection waits for its client's first parcel, by default (spec 15.23). */
export const ACCEPT_TIMEOUT = 30_000;

/**
 * What may wait on one connection for its broker, by default: a WebSocket's own bound, since a
 * broker carries the same router's envelopes (spec 15.12).
 */
export const MAXIMUM_UNSENT_BYTES = 184_551_424;

// helpers

const hexOf = (bytes: Uint8Array): string => {
  return Array.from(bytes, (byte) => {
    return byte.toString(16).padStart(2, '0');
  }).join('');
};

// definition

/**
 * A server's transport over a broker participant (spec 15.18 to 15.23), serving `names`: each OPEN
 * to one of them judged, in its order — a layout to come refused 426, an id that is no token or a
 * receive bound under 1,024 refused 400, past `maximumConnections` or `maximumConnectionsPerAddress`
 * or once its stop began 503, each told, its address the id the OPEN claims — and any other answered
 * by an ACCEPT, half-open until the opener's first parcel naming both halves, which draws its handle,
 * `type=BROKER;participant=<id>;ordinal=n`, and tells its router; one whose third leg does not come
 * within `acceptTimeout` is forgotten, telling nothing. In a group, it lets its names go while it
 * holds `maximumConnections`. It carries no credential toward its client, and a connection is secure
 * while its own leg and its peer's are. Its stop takes no OPEN and closes each connection with 1001;
 * its participant's link is kept.
 *
 * @example
 * const transport = createBrokerTransportServer(participant, { names: ['interop'] });
 * transport.on('message', ({ address, credential, data }, connectionHandle) => {});
 * await transport.start();
 */
export const createBrokerTransportServer = (
  participant: IBrokerParticipant,
  options: IBrokerTransportServerOptions
): BrokerTransportServer => {
  const port = portOf(participant);
  const {
    group = false,
    maximumConnections = MAXIMUM_CONNECTIONS,
    maximumConnectionsPerAddress = MAXIMUM_CONNECTIONS_PER_ADDRESS,
    maximumUnsentBytes = MAXIMUM_UNSENT_BYTES,
    names,
    secure,
  } = options;
  const acceptTimeout = assertHeldFinite('acceptTimeout', options.acceptTimeout ?? ACCEPT_TIMEOUT);

  assertCount('maximumConnections', { value: maximumConnections });
  assertCount('maximumConnectionsPerAddress', { value: maximumConnectionsPerAddress });
  assertCount('maximumUnsentBytes', { value: maximumUnsentBytes });

  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    !names.every((name) => {
      return typeof name === 'string' && isToken(name);
    })
  ) {
    throw new ProgrammerError(
      "a broker's server transport serves one name at least, each a token of base64url's alphabet, 1 to 64 characters"
    );
  }

  if (group && port.adapter.capabilities.groups !== true) {
    throw new ProgrammerError(
      `a name served in a group needs an adapter that offers groups, and the adapter of ${port.id} does not`
    );
  }

  port.reserve(names);

  const served: ReadonlySet<string> = new Set(names);
  // the peer of a connection the transport holds, which only `define` reaches: replaced by it, which
  // `createTransportServer` calls before it returns
  let peerOf = (_handle: TransportServerConnectionHandle): IBrokerPeer | undefined => {
    return undefined;
  };

  const transport = createTransportServer<IBrokerPeer, undefined>(
    (server, connections, { tell }) => {
      const { clock } = port;

      peerOf = (handle) => {
        return connections.get(handle)?.socket;
      };

      // * what its participant reports of its own names no connection: a message that is no parcel
      participant.on('error', (error) => {
        server.emit(ERROR_EVENT, error, '');
      });

      // every connection it holds, half-open ones among them, by its opener's id and half
      const held = new Map<string, IHeld>();
      let ordinal = 0;
      let isServing = false;

      const countOf = (id: string): number => {
        let count = 0;

        for (const { peer } of held.values()) {
          count += peer.id === id ? 1 : 0;
        }

        return count;
      };

      // * in a group, its capacity is its broker's placement: its names let go while it is full
      const place = (): void => {
        for (const name of served) {
          port.want(name, {
            group: group ? name : undefined,
            isWanted: isServing && (!group || held.size < maximumConnections),
          });
        }
      };

      const refuse = (open: IParcel, status: number): void => {
        port.refuse(open, status);
        tell(REFUSAL_EVENT, [
          {
            address: open.id,
            authority: undefined,
            origin: undefined,
            port: 0,
            reason: REFUSE_REASONS[status] ?? String(status),
            status,
          },
        ]);
      };

      const accept = (open: IParcel, key: string): void => {
        const id = open.id ?? '';
        const peer: IBrokerPeer = Object.freeze({
          bound: open.bound ?? LEAST_RECEIVE_BOUND,
          id,
          incarnation: open.incarnation ?? new Uint8Array(),
          isSecure: ((open.flags ?? 0) & ParcelFlag.SECURE) !== 0,
        });
        const entry: IHeld = { peer };

        held.set(key, entry);
        entry.connection = port.connect(
          { acceptor: port.drawHalf(), isOpener: false, opener: open.opener, peer },
          {
            maximumUnsentBytes,
            owner: {
              // * its third leg: the opener proved it reads the inbox it named; its handle drawn now
              opened: () => {
                clock.clearTimeout(entry.timer);
                entry.timer = undefined;
                ordinal += 1;

                const handle: TransportServerConnectionHandle = `type=${port.adapter.type};participant=${id};ordinal=${ordinal}`;
                const registered: ITransportServerClientAware<IBrokerPeer> = {
                  address: id,
                  connectionHandle: handle,
                  lastActivity: undefined,
                  port: 0,
                  socket: peer,
                  type: port.adapter.type,
                };

                entry.handle = handle;
                connections.set(handle, registered);
                tell(CONNECTION_EVENT, [peer, undefined, handle]);
              },
              envelope: ({ credential, data }) => {
                const { handle } = entry;
                const registered = handle === undefined ? undefined : connections.get(handle);

                if (handle === undefined || registered === undefined) {
                  return;
                }

                registered.lastActivity = clock.Date.now();
                tell(MESSAGE_EVENT, [{ address: id, credential, data }, handle]);
              },
              end: (wasClean) => {
                const { handle } = entry;

                clock.clearTimeout(entry.timer);
                held.delete(key);

                if (handle !== undefined) {
                  connections.delete(handle);
                  tell(CLOSE_EVENT, [wasClean, handle]);
                }

                place();
              },
              report: (error) => {
                server.emit(ERROR_EVENT, error, entry.handle ?? '');
              },
              subject: () => {
                return entry.handle ?? `a half-open connection of ${id}`;
              },
            },
          }
        );
        // ! a half-open connection never waits without end: forgotten, nothing told, nothing sent
        entry.timer = clock.setTimeout(() => {
          entry.timer = undefined;
          entry.connection?.forget();
        }, acceptTimeout);
        // a browser's timer has no `unref`
        (entry.timer as { unref?: () => unknown }).unref?.();
        place();
      };

      // * an OPEN judged in its order (spec 15.18): its layout, its id and bound, then its place
      const offer = (open: IParcel): void => {
        if (open.layout !== PARCEL_LAYOUT) {
          refuse(open, 426);

          return;
        }

        const id = open.id ?? '';
        const key = `${id}\n${hexOf(open.opener)}`;

        if (held.has(key)) {
          return undefined;
        }

        if (!isToken(id) || (open.bound ?? 0) < LEAST_RECEIVE_BOUND) {
          refuse(open, 400);

          return;
        }

        if (
          !isServing ||
          !server.isOpen() ||
          held.size >= maximumConnections ||
          countOf(id) >= maximumConnectionsPerAddress
        ) {
          refuse(open, 503);

          return;
        }

        accept(open, key);

        return;
      };

      const entryOf = (handle: TransportServerConnectionHandle): IHeld | undefined => {
        return held.values().find((entry) => {
          return entry.handle === handle;
        });
      };

      return {
        clock,
        defaults: { address: port.id, findOpenPort: false, port: 0 },
        isSecure: port.isSecure,
        secure,
        type: port.adapter.type,

        close: (connection) => {
          entryOf(connection.connectionHandle)?.connection?.close(CloseCode.NORMAL);

          return Promise.resolve();
        },
        gauges: () => {
          let halfOpen = 0;
          let unsentBytes = 0;
          let largestUnsentBytes = 0;

          for (const { connection } of held.values()) {
            halfOpen += connection?.isHalfOpen === true ? 1 : 0;
            unsentBytes += connection?.unsentBytes ?? 0;
            largestUnsentBytes = Math.max(largestUnsentBytes, connection?.unsentBytes ?? 0);
          }

          const { counts } = participant.gauges();

          return gaugesOf({
            ceilings: {
              halfOpen: maximumConnections,
              largestUnsentBytes: maximumUnsentBytes,
            },
            counts: {
              departures: counts['departures'] ?? 0,
              halfOpen,
              largestPartsBytes: counts['largestPartsBytes'] ?? 0,
              largestUnsentBytes,
              names: [...port.names].filter((name) => {
                return served.has(name);
              }).length,
              partsBytes: counts['partsBytes'] ?? 0,
              unsentBytes,
            },
          });
        },
        // a credential given here is not carried: the router fails a command that presents one
        // its transport cannot carry before it goes, DESTINATION_UNREACHABLE (spec 15.22)
        send: async ({ data }, connection) => {
          const bytes = transferableOf(data);

          if (bytes === undefined) {
            throw new ProgrammerError('a broker connection carries envelopes, as bytes');
          }

          await entryOf(connection.connectionHandle)?.connection?.send(new Uint8Array(bytes));
        },
        start: async ({ signal }) => {
          await port.linked({ signal });

          for (const name of served) {
            port.serve(name, { offer });
          }

          isServing = true;
          place();

          return { address: port.id, port: 0 };
        },
        // * no OPEN taken from its start, its names let go, each connection closed with 1001; its
        // participant's link kept
        stop: () => {
          isServing = false;
          place();

          for (const { connection } of held.values()) {
            connection?.close(CloseCode.GOING_AWAY);
          }

          return Promise.resolve();
        },
      };
    }
  );

  return Object.assign(transport, {
    // a connection secure while its own leg and its peer's are, unless its application says
    // otherwise of its own (spec 15.22)
    isSecure: (connectionHandle: TransportServerConnectionHandle): boolean => {
      return secure ?? (port.isSecure && peerOf(connectionHandle)?.isSecure === true);
    },
  });
};
