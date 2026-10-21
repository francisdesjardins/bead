// ── Joined transport server ───────────────────────────────────────────────────

// dependencies

import type { IClock } from '../shared/clock';
import {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  ERROR_EVENT,
  LISTEN_EVENT,
  MESSAGE_EVENT,
  REFUSAL_EVENT,
} from '../shared/constants';
import { createEmitter } from '../shared/emitter';
import { ProgrammerError, toError } from '../shared/errors';
import { gaugesOf } from '../shared/gauges';
import { createEventMethods } from '../shared/lifecycle';
import type { IGauges } from '../shared/types';
import type {
  IJoinableTransportServer,
  IJoinedTransportServer,
  TransportServerConnectionHandle,
  TransportServerEventMap,
  TransportServerToldEvent,
} from './types';

export type { IJoinableTransportServer, IJoinedTransportServer } from './types';

// constants

// the type a handle opens with (spec 15.1): `type=WS;…`
const HANDLE_TYPE = /^type=([^;]*);/u;

// every event a transport tells, each told on as it came
const TOLD_EVENTS = Object.freeze([
  CLOSE_EVENT,
  CONNECTION_EVENT,
  LISTEN_EVENT,
  MESSAGE_EVENT,
  REFUSAL_EVENT,
] as const satisfies readonly TransportServerToldEvent[]);

// helpers

/** Several parts' gauges as one, each count and each ceiling of one name added. */
const sumGauges = (
  parts: readonly IGauges<TransportServerConnectionHandle>[]
): IGauges<TransportServerConnectionHandle> => {
  const add = (sums: Record<string, number>, part: Readonly<Record<string, number>>) => {
    for (const [name, value] of Object.entries(part)) {
      sums[name] = (sums[name] ?? 0) + value;
    }

    return sums;
  };

  return gaugesOf({
    anomalies: parts.flatMap(({ anomalies }) => {
      return anomalies;
    }),
    ceilings: parts.reduce<Record<string, number>>((sums, { ceilings }) => {
      return add(sums, ceilings);
    }, {}),
    connectionHandles: parts.flatMap(({ connectionHandles }) => {
      return [...connectionHandles];
    }),
    counts: parts.reduce<Record<string, number>>((sums, { counts }) => {
      return add(sums, counts);
    }, {}),
  });
};

/** The one clock the transports run on, none when none names one; two are a misuse. */
const clockOf = (transports: readonly IJoinableTransportServer[]): IClock | undefined => {
  const clocks = new Set(
    transports.flatMap(({ clock }) => {
      return clock === undefined ? [] : [clock];
    })
  );

  if (clocks.size > 1) {
    throw new ProgrammerError('the transports a join takes run on one clock');
  }

  return clocks.values().next().value;
};

// definition

/**
 * One transport server over several (spec 15.14), so that one server — one router, one admission,
 * one session manager, each service offered once — takes its connections from all of them: an
 * in-memory transport beside a WebSocket one, a WebSocket transport beside an HTTP one. Each handle
 * stays the one its transport drew, and names that transport by its type, so two transports of one
 * type, whose handles might be one, are a {@link ProgrammerError} as the join is built: one
 * transport binds both addresses instead. So is none, and two clocks.
 *
 * A connection's flags, sends and closes go to the transport that drew its handle; each transport's
 * events are told on with that handle, in the order it told them, each listener within a guard
 * (spec 15.1). It starts nothing and serves no port: an application starts each transport, where it
 * listens; one port for two comes from a proxy in front of them.
 *
 * @example
 * const memory = createMemoryTransportServer();
 * const webSocket = createWSTransportServer({ WebSocketServer });
 * const server = createServer({ transport: joinTransports([memory, webSocket]) });
 *
 * await memory.start();
 * await webSocket.start({ port });
 */
export const joinTransports = <const Transports extends readonly IJoinableTransportServer[]>(
  transports: Transports
): IJoinedTransportServer<Transports> => {
  if (transports.length === 0) {
    throw new ProgrammerError('a join takes one transport at least');
  }

  const byType = new Map<string, IJoinableTransportServer>();

  for (const transport of transports) {
    if (byType.has(transport.type)) {
      throw new ProgrammerError(
        `a join takes one transport of type ${transport.type}, whose handles another might draw too`
      );
    }

    byType.set(transport.type, transport);
  }

  const clock = clockOf(transports);
  const emitter = createEmitter<TransportServerEventMap>();
  // each transport's gauges: its own, or, for one that counts nothing, its connections as its
  // events told them
  const gaugesBy: (() => IGauges<TransportServerConnectionHandle>)[] = [];

  const ownerOf = (
    connectionHandle: TransportServerConnectionHandle
  ): IJoinableTransportServer | undefined => {
    const type = HANDLE_TYPE.exec(connectionHandle)?.[1];

    return type === undefined ? undefined : byType.get(type);
  };

  for (const transport of transports) {
    if (transport.gauges === undefined) {
      const handles = new Set<TransportServerConnectionHandle>();

      transport.on(CONNECTION_EVENT, (...[, , connectionHandle]) => {
        handles.add(connectionHandle);
      });
      transport.on(CLOSE_EVENT, (_, connectionHandle) => {
        handles.delete(connectionHandle);
      });
      gaugesBy.push(() => {
        return gaugesOf({ connectionHandles: handles, counts: { connections: handles.size } });
      });
    } else {
      gaugesBy.push(transport.gauges.bind(transport));
    }

    for (const event of TOLD_EVENTS) {
      transport.on(event, (...params: TransportServerEventMap[typeof event]) => {
        // ! a refusal names no connection: what its listener throws goes with the empty handle
        const last: unknown = params.at(-1);
        const connectionHandle =
          typeof last === 'string' ? (last as TransportServerConnectionHandle) : '';

        emitter.emitEach(event, {
          onError: (error) => {
            emitter.emit(ERROR_EVENT, toError(error), connectionHandle);
          },
          params,
        });
      });
    }

    transport.on(ERROR_EVENT, (error, connectionHandle) => {
      emitter.emit(ERROR_EVENT, error, connectionHandle);
    });
  }

  const joined: IJoinedTransportServer<Transports> = {
    ...createEventMethods(emitter, () => {
      return joined;
    }),

    clock,
    transports,

    carriesCredential: (connectionHandle) => {
      return ownerOf(connectionHandle)?.carriesCredential?.(connectionHandle) ?? false;
    },
    close: (connectionHandle) => {
      return ownerOf(connectionHandle)?.close(connectionHandle) ?? Promise.resolve(false);
    },
    gauges: () => {
      return sumGauges(
        gaugesBy.map((gaugesOfOne) => {
          return gaugesOfOne();
        })
      );
    },
    isSecure: (connectionHandle) => {
      return ownerOf(connectionHandle)?.isSecure?.(connectionHandle) ?? false;
    },
    isTwoWay: (connectionHandle) => {
      const owner = ownerOf(connectionHandle);

      return owner === undefined ? false : (owner.isTwoWay?.(connectionHandle) ?? true);
    },
    send: (message, connectionHandle) => {
      return ownerOf(connectionHandle)?.send(message, connectionHandle) ?? Promise.resolve();
    },
    stop: async () => {
      const stopped = await Promise.allSettled(
        transports.map((transport) => {
          return transport.stop();
        })
      );

      for (const outcome of stopped) {
        if (outcome.status === 'rejected') {
          throw outcome.reason;
        }
      }
    },
    [Symbol.asyncDispose]: () => {
      return joined.stop();
    },
  };

  return joined;
};
