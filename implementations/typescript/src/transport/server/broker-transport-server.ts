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
import { CLOSE_EVENT, CONNECTION_EVENT, MESSAGE_EVENT, REFUSAL_EVENT } from '../shared/constants';
import { notServedOf, ProgrammerError } from '../shared/errors';
import { gaugesOf } from '../shared/gauges';
import { transferableOf } from '../shared/transferable';
import type { IBrokerPeer } from '../shared/types';
import { assertCount, MAXIMUM_CONNECTIONS, MAXIMUM_CONNECTIONS_PER_ADDRESS } from './server-bounds';
import type { IProcedureAddress } from '../../router/shared/types';
import { type IProceduresTaken, proceduresTakenOf } from './shared/procedures-taken';
import { createTransportServer } from './transport-server';
import type {
  BrokerTransportServer,
  IBrokerTransportServerOptions,
  ITransportServerClientAware,
  TransportServerConnectionHandle,
} from './types';

export type { IProcedureAddress } from '../../router/shared/types';
export { TRANSPORT_BROKER } from '../shared/constants';
export { MAXIMUM_CONNECTIONS, MAXIMUM_CONNECTIONS_PER_ADDRESS } from './server-bounds';
export type { BrokerTransportServer, IBrokerTransportServerOptions } from './types';

// interfaces

// a connection this transport holds, half-open until its third leg draws its handle, and the name
// its OPEN reached
interface IHeld {
  connection?: IBrokerConnection | undefined;
  handle?: TransportServerConnectionHandle | undefined;
  readonly name: string;
  readonly peer: IBrokerPeer;
  timer?: TimeoutId | undefined;
}

// constants

// how a refusal of what it takes names it
const TRANSPORT = "a broker's server transport";

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

/**
 * What each name served takes (spec 9.11), checked as the transport is built (9.12): a name it does
 * not serve, or an address out of 16.2's ranges, is a {@link ProgrammerError}.
 */
const takenByNameOf = (
  proceduresByName: IBrokerTransportServerOptions['proceduresByName'],
  names: readonly string[]
): ReadonlyMap<string, IProceduresTaken> => {
  // a caller without types may give anything
  const given: unknown = proceduresByName;

  if (given === undefined) {
    return new Map();
  }

  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw new ProgrammerError(`${TRANSPORT} takes its procedures by name as a record of lists`);
  }

  const taken = new Map<string, IProceduresTaken>();

  for (const [name, procedures] of Object.entries(
    given as Readonly<Record<string, readonly IProcedureAddress[] | undefined>>
  )) {
    if (!names.includes(name)) {
      throw new ProgrammerError(
        `${TRANSPORT} takes procedures for ${name}, a name it does not serve (spec 9.12)`
      );
    }

    const listed = proceduresTakenOf(procedures, TRANSPORT);

    if (listed !== undefined) {
      taken.set(name, listed);
    }
  }

  return taken;
};

// definition

/**
 * A server's transport over a broker participant (spec 15.18 to 15.23), serving `names`: each OPEN
 * to one of them judged, in its order — a layout to come refused 426, an id that is no token or a
 * receive bound under 1,024 refused 400, past `maximumConnections` or `maximumConnectionsPerAddress`
 * or once its stop or its participant's began 503, each told, its address the id the OPEN claims —
 * and any other answered
 * by an ACCEPT, half-open until the opener's first parcel naming both halves, which draws its handle,
 * its adapter's type first, `type=MQTT;participant=<id>;ordinal=n`, and tells its router; one whose third leg does not come
 * within `acceptTimeout` is forgotten, telling nothing. In a group, it lets its names go while it
 * holds `maximumConnections`. It carries no credential toward its client, and a connection is secure
 * while its own leg and its peer's are, its own as `secure` says where given, its ACCEPT marked so.
 * Its stop takes no OPEN, lets go of its names and closes each connection with 1001, its names'
 * unsubscriptions handed first, and settles once its broker let each go; its participant's link is
 * kept. Its
 * participant's stop keeps it open, its names wanted and served again at its next link; its start
 * once its participant is disposed is a {@link ProgrammerError}, its state kept (spec 15.21). A
 * connection its router paused is held by its participant, in order, its CLOSE behind what it
 * holds, to `maximumHeldEnvelopeBytes`, past which that connection alone is lost: nothing of a pause
 * reaches its peer over a broker, whose link carries other connections (spec 15.12, 15.23). Each
 * connection takes the procedures `proceduresByName` gives the name its OPEN reached, else
 * `procedures`, else every one (spec 9.11).
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
    procedures,
    proceduresByName,
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

  // * what it takes, refused before its names are reserved (spec 9.12)
  const taken = proceduresTakenOf(procedures, TRANSPORT);
  const takenByName = takenByNameOf(proceduresByName, names);

  port.reserve(names);

  const served: ReadonlySet<string> = new Set(names);
  // * its own leg, as its application says of its own, or its participant's (spec 15.22)
  const isOwnLegSecure = secure ?? port.isSecure;
  // the peer of a connection the transport holds, which only `define` reaches: replaced by it, which
  // `createTransportServer` calls before it returns
  let peerOf = (_handle: TransportServerConnectionHandle): IBrokerPeer | undefined => {
    return undefined;
  };

  const transport = createTransportServer<IBrokerPeer, undefined>(
    (server, connections, { report, tell }) => {
      const { clock } = port;

      peerOf = (handle) => {
        return connections.get(handle)?.socket;
      };

      // * what its participant reports of its own names no connection: a message that is no parcel
      participant.on('error', (error) => {
        report(error, '');
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

      // * in a group, its capacity is its broker's placement: its names let go while it is full;
      // settles once its broker holds each, or let each go
      const wantOf = (name: string): Promise<void> => {
        return port.want(name, {
          group: group ? name : undefined,
          isWanted: isServing && (!group || held.size < maximumConnections),
        });
      };

      const place = async (): Promise<void> => {
        await Promise.all([...served].map(wantOf));
      };

      // a name its broker refuses at a rejoin is reported and left unheld, the gauge saying so
      const replace = (): void => {
        for (const name of served) {
          wantOf(name).catch((reason: unknown) => {
            report(notServedOf(name, reason), '');
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

      const accept = (open: IParcel, { key, name }: { key: string; name: string }): void => {
        const id = open.id ?? '';
        const peer: IBrokerPeer = Object.freeze({
          bound: open.bound ?? LEAST_RECEIVE_BOUND,
          id,
          incarnation: open.incarnation ?? new Uint8Array(),
          isSecure: ((open.flags ?? 0) & ParcelFlag.SECURE) !== 0,
        });
        const entry: IHeld = { name, peer };

        held.set(key, entry);
        entry.connection = port.connect(
          { acceptor: port.drawHalf(), isOpener: false, opener: open.opener, peer },
          {
            isSecure: isOwnLegSecure,
            maximumUnsentBytes,
            owner: {
              connectionHandle: () => {
                return entry.handle;
              },
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
                tell(CONNECTION_EVENT, [
                  Object.freeze({ request: undefined, socket: peer }),
                  handle,
                ]);
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

                replace();
              },
              report: (error) => {
                report(error, entry.handle ?? '');
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
        replace();
      };

      // * an OPEN to `name` judged in its order (spec 15.18): its layout, its id and bound, then its
      // place
      const offer = (open: IParcel, name: string): void => {
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

        // * its participant's stop under way: what its broker hands it as it lets its names go is
        // refused, its adapter still up (spec 15.18, 15.21)
        if (
          !isServing ||
          !server.isOpen() ||
          port.stopped.aborted ||
          held.size >= maximumConnections ||
          countOf(id) >= maximumConnectionsPerAddress
        ) {
          refuse(open, 503);

          return;
        }

        accept(open, { key, name });

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
        // * by the name its OPEN reached, else every name's; present only when it was given any
        // (spec 9.11)
        ...(taken === undefined && takenByName.size === 0
          ? {}
          : {
              takesProcedure: (connectionHandle, address) => {
                const entry = entryOf(connectionHandle);

                if (entry === undefined) {
                  return false;
                }

                const listed = takenByName.get(entry.name) ?? taken;

                return listed === undefined || listed.has(address);
              },
            }),

        // ! its participant outranks it: once disposed, a start over it is a misuse, its state kept
        // (spec 15.21)
        assertStart: () => {
          if (port.isDisposed) {
            throw new ProgrammerError(`the participant ${port.id} is disposed`);
          }
        },
        close: (connection) => {
          entryOf(connection.connectionHandle)?.connection?.close(CloseCode.NORMAL);

          return Promise.resolve();
        },
        // * its participant holds what comes for it, never pausing its link, which carries other
        // connections, and loses it alone past maximumHeldEnvelopeBytes (spec 15.12, 15.23)
        pause: (connection) => {
          entryOf(connection.connectionHandle)?.connection?.pause();
        },
        resume: (connection) => {
          entryOf(connection.connectionHandle)?.connection?.resume();
        },
        gauges: () => {
          let halfOpen = 0;
          let unsentBytes = 0;
          let largestPartsBytes = 0;
          let largestUnsentBytes = 0;

          for (const { connection } of held.values()) {
            halfOpen += connection?.isHalfOpen === true ? 1 : 0;
            unsentBytes += connection?.unsentBytes ?? 0;
            largestPartsBytes = Math.max(largestPartsBytes, connection?.partsBytes ?? 0);
            largestUnsentBytes = Math.max(largestUnsentBytes, connection?.unsentBytes ?? 0);
          }

          // what its participant holds across its connections: its parts, and the departures
          const { ceilings, counts } = participant.gauges();

          return gaugesOf({
            ceilings: {
              connections: maximumConnections,
              halfOpen: maximumConnections,
              largestPartsBytes: ceilings['largestPartsBytes'] ?? 0,
              largestUnsentBytes: maximumUnsentBytes,
              partsBytes: ceilings['partsBytes'] ?? 0,
            },
            counts: {
              departures: counts['departures'] ?? 0,
              halfOpen,
              largestPartsBytes,
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
        // * settles once its broker holds each name it serves, and fails on one refused; links anew
        // a participant whose link was taken over
        start: async ({ signal }) => {
          await port.linked({ isStart: true, signal });

          for (const name of served) {
            port.serve(name, {
              offer: (open) => {
                offer(open, name);
              },
            });
          }

          isServing = true;
          await place();

          return { address: port.id, port: 0 };
        },
        // * no OPEN taken from its start, its names let go, each unsubscription handed before each
        // connection's CLOSE of 1001, settling once its broker let each go; its participant's link
        // kept (spec 15.21)
        stop: async () => {
          isServing = false;

          const letGo = place();

          for (const { connection } of held.values()) {
            connection?.close(CloseCode.GOING_AWAY);
          }

          await letGo;
        },
      };
    }
  );

  return Object.assign(transport, {
    // a connection secure while its own leg and its peer's are, its application saying otherwise
    // of its own leg alone (spec 15.22)
    isSecure: (connectionHandle: TransportServerConnectionHandle): boolean => {
      return isOwnLegSecure && peerOf(connectionHandle)?.isSecure === true;
    },
  });
};
