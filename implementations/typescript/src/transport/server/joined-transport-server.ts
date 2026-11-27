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
import { createEmitter, tellError } from '../shared/emitter';
import { ProgrammerError, toError } from '../shared/errors';
import { gaugesOf } from '../shared/gauges';
import { createEventMethods } from '../shared/lifecycle';
import type { IProcedureAddress } from '../../router/shared/types';
import type { IGauges } from '../shared/types';
import type {
  IJoinableTransportServer,
  IJoinedTransportServer,
  TransportServerConnectionHandle,
  TransportServerEventMap,
  TransportServerToldEvent,
} from './types';

export type { IProcedureAddress } from '../../router/shared/types';
export type { IGauges } from '../shared/types';
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

/**
 * The type of each transport a join is given, in the order given, and the clock they run on, the
 * first's (spec 15.14). A join is refused, as a {@link ProgrammerError}, for the first of its rules
 * that any transport breaks, each judged over every transport before the next: none given; one that
 * is no transport; one that names no type, as a join; two of one type, the first type given again
 * named; a clock other than the first's, or none. Each transport's type is read once, in order, then
 * each one's clock, once: what a transport throws as it is read reaches the caller as thrown.
 */
const judgeJoin = (
  transports: readonly IJoinableTransportServer[]
): { clock: IClock; types: readonly string[] } => {
  // a caller without types may give anything
  const given: unknown = transports;

  if (!Array.isArray(given) || given.length === 0) {
    throw new ProgrammerError('a join takes one transport at least');
  }

  // ! an array's iterator reads a hole as the `undefined` it holds, so `[, memory]` is refused here
  for (const element of given as readonly unknown[]) {
    if (typeof element !== 'object' || element === null) {
      throw new ProgrammerError(`a join takes transports, not ${String(element)}`);
    }
  }

  const types: readonly unknown[] = transports.map(({ type }) => {
    return type;
  });

  // a join names no type of its own, past the types, so its handles would be no one's
  if (
    types.some((type) => {
      return typeof type !== 'string';
    })
  ) {
    throw new ProgrammerError(
      'a join takes transports that name the type of their handles, never a join'
    );
  }

  const seen = new Set<string>();

  for (const type of types as readonly string[]) {
    if (seen.has(type)) {
      throw new ProgrammerError(
        `a join takes one transport of each type: two are ${type}, whose handles might be one`
      );
    }

    seen.add(type);
  }

  const clocks: readonly unknown[] = transports.map(({ clock }) => {
    return clock;
  });
  const [first] = clocks;

  for (const [index, clock] of clocks.entries()) {
    // ! only a caller past the types gives none, refused as a router refuses its transport's (0011)
    if (clock === undefined || clock === null) {
      throw new ProgrammerError(
        `a join runs on the clock of its transport ${String(types[index])}, which names none`
      );
    }

    if (clock !== first) {
      throw new ProgrammerError("a join's transports run on one clock");
    }
  }

  return { clock: first as IClock, types: types as readonly string[] };
};

// definition

/**
 * One transport server over several (spec 15.14), so that one server — one router, one admission,
 * one session manager, each service offered once — takes its connections from all of them: an
 * in-memory transport beside a WebSocket one, a WebSocket transport beside an HTTP one. Each handle
 * stays the one its transport drew, and names that transport by its type, so two transports of one
 * type, whose handles might be one, are a {@link ProgrammerError} as the join is built: one
 * transport binds both addresses instead. So is none, a join among them, and two clocks, the first
 * of these rules any transport breaks refused, each judged over every transport before the next.
 *
 * A connection's flags, sends, closes, pauses and resumes go to the transport that drew its
 * handle, and so does whether it takes a procedure (spec 9.11), every one for a transport that
 * names none; each transport's events are told on with that handle, in the order it told them, each
 * listener within a guard (spec 15.1). It starts nothing and serves no port: an application starts
 * each transport, where it listens; one port for two comes from a proxy in front of them.
 *
 * @example
 * const memory = createMemoryTransportServer();
 * const webSocket = createWebSocketTransportServer({ WebSocketServer });
 * const server = createServer({ transport: joinTransports([memory, webSocket]) });
 *
 * await memory.start();
 * await webSocket.start({ port });
 */
export const joinTransports = <const Transports extends readonly IJoinableTransportServer[]>(
  transports: Transports
): IJoinedTransportServer<Transports> => {
  const { clock, types } = judgeJoin(transports);
  const byType = new Map<string, IJoinableTransportServer>();

  for (const [index, type] of types.entries()) {
    byType.set(type, transports[index] as IJoinableTransportServer);
  }

  // its dispose, which every later one shares
  let disposed: Promise<void> | undefined;
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

      transport.on(CONNECTION_EVENT, (...[, connectionHandle]) => {
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
            tellError(emitter, [toError(error), connectionHandle]);
          },
          params,
        });
      });
    }

    // * told on within a guard, as every `error` is: what a listener of it throws is dropped (spec
    // 15.1)
    transport.on(ERROR_EVENT, (error, connectionHandle) => {
      tellError(emitter, [error, connectionHandle]);
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
    // ! to the transport that drew the handle, by its type, unique within a join (spec 15.14)
    pause: (connectionHandle) => {
      ownerOf(connectionHandle)?.pause(connectionHandle);
    },
    resume: (connectionHandle) => {
      ownerOf(connectionHandle)?.resume(connectionHandle);
    },
    send: (message, connectionHandle) => {
      return ownerOf(connectionHandle)?.send(message, connectionHandle) ?? Promise.resolve();
    },
    // * present only when one of its transports names procedures, so a router over a join none of
    // whose transports does never asks (spec 9.11)
    ...(transports.some((transport) => {
      return transport.takesProcedure !== undefined;
    })
      ? {
          takesProcedure: (
            connectionHandle: TransportServerConnectionHandle,
            address: IProcedureAddress
          ) => {
            const owner = ownerOf(connectionHandle);

            return owner === undefined
              ? false
              : (owner.takesProcedure?.(connectionHandle, address) ?? true);
          },
        }
      : {}),
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
    // * it starts nothing: its dispose disposes every transport it joined, final for each, and a
    // later dispose settles with the first
    [Symbol.asyncDispose]: () => {
      disposed ??= (async () => {
        const outcomes = await Promise.allSettled(
          transports.map((transport) => {
            return Symbol.asyncDispose in transport
              ? (transport as AsyncDisposable)[Symbol.asyncDispose]()
              : transport.stop();
          })
        );

        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            throw outcome.reason;
          }
        }
      })();

      return disposed;
    },
  };

  return joined;
};
