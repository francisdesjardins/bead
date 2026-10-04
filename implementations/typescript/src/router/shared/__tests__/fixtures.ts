import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CALL_ID_RANGES, CLIENT_FAILURES, EnvelopeKind, SERVER_FAILURES } from '../constants';
import { bytesOf, writeEnvelope } from '../envelope';
import type { IRouterClientTransportLike } from '../../client/types';
import type { IRouterServerTransportLike } from '../../server/types';
import { createEmitter } from '../../../transport/shared/emitter';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import type { ITransportMessage } from '../../../transport/shared/types';
import { createRouterCore } from '../router-core';
import type {
  CallId,
  IRouterCore,
  IRouterCorePort,
  IRouterFailures,
  OutgoingEnvelope,
  RouterLimitsOptions,
  RouterSide,
} from '../types';

/**
 * What the router suites share: an envelope's bytes as the codec writes them, a counter of call ids
 * of one side's parity, made anew in each test, payloads large enough for a transfer and what tells
 * them apart, and two cores joined by a queue.
 */

export const envelopeOf = (envelope: OutgoingEnvelope): Uint8Array => {
  return writeEnvelope(envelope);
};

// 1, 3, 5, … for a client; 2, 4, 6, … for a server
export const callIdsOf = (side: RouterSide): (() => CallId) => {
  const { first, step } = CALL_ID_RANGES[side];
  let next = first;

  return () => {
    const callId = next;

    next += step;

    return callId;
  };
};

/** `length` bytes that differ from one to the next, so a byte out of place shows. */
export const patternOf = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);

  // a loop, not a callback per byte: 20 MiB of them
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 7 + 3) % 256;
  }

  return bytes;
};

/** What tells a payload apart, however large, without printing it: its length and its SHA-256. */
export const digestOf = (bytes: Uint8Array): string => {
  return `${String(bytes.length)} ${createHash('sha256').update(bytes).digest('hex')}`;
};

/** Numbers from 0 to 1 drawn from `seed` — the same seed, the same draws (mulberry32). */
export const drawsOf = (seed: number): (() => number) => {
  let state = seed;

  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;

    let mixed = Math.imul(state ^ (state >>> 15), state | 1);

    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** An envelope on its way from one core to the other. */
interface IQueued {
  bytes: Uint8Array;
  /** Whether it may come in any order, and twice: a chunk or a credit. */
  isLoose: boolean;
  to: RouterSide;
}

/**
 * Two cores built with `limits`, a client's on the connection `'server'` and a server's on `'a'`,
 * joined by one queue: what one sends waits there until `flush` hands it to the other, a turn
 * between each, until none is left. In order; or, from `seed`, the chunks and the credits taken in
 * any order and sent twice half the time — every other kind in order, and once. Each side records
 * what it reports, and the kind of each envelope it sends; `sizes` holds the bytes of every
 * envelope sent, and `traffic` every envelope as it was sent, once, and as it was handed over.
 */
export const createLoopback = ({
  limits,
  seed,
}: {
  limits?: RouterLimitsOptions | undefined;
  seed?: number | undefined;
}) => {
  const queue: IQueued[] = [];
  const draws = seed === undefined ? undefined : drawsOf(seed);
  const sizes: number[] = [];
  const traffic = { delivered: [] as IQueued[], sent: [] as IQueued[] };
  const recorded = {
    client: { reported: [] as Error[], sent: [] as number[] },
    server: { reported: [] as Error[], sent: [] as number[] },
  };

  const portOf = <Handle extends string>(
    side: RouterSide,
    failures: IRouterFailures
  ): IRouterCorePort<Handle> => {
    return {
      failures,

      activity: () => {
        return undefined;
      },
      report: (error) => {
        recorded[side].reported.push(error);
      },
      send: (bytes) => {
        // the kind is an envelope's second byte, whatever its layout
        const kind = bytes[1] ?? 0;
        const isLoose = kind === EnvelopeKind.CHUNK || kind === EnvelopeKind.CREDIT;
        const to = side === 'client' ? 'server' : 'client';

        sizes.push(bytes.length);
        recorded[side].sent.push(kind);
        traffic.sent.push({ bytes, isLoose, to });
        queue.push({ bytes, isLoose, to });

        if (isLoose && draws !== undefined && draws() < 0.5) {
          queue.push({ bytes: bytes.slice(), isLoose, to });
        }

        return Promise.resolve();
      },
      trace: () => {
        return undefined;
      },
    };
  };

  const client: IRouterCore<'server'> = createRouterCore(
    portOf<'server'>('client', CLIENT_FAILURES),
    {
      limits,
    }
  );
  const server: IRouterCore<'a'> = createRouterCore(portOf<'a'>('server', SERVER_FAILURES), {
    limits,
  });

  // the next envelope to hand over: the first, in order; else any chunk or credit, or the first of
  // the other kinds
  const nextIndex = (): number => {
    if (draws === undefined) {
      return 0;
    }

    const first = queue.findIndex(({ isLoose }) => {
      return !isLoose;
    });
    const candidates = queue.flatMap(({ isLoose }, index) => {
      return isLoose || index === first ? [index] : [];
    });

    return candidates[Math.floor(draws() * candidates.length)] ?? 0;
  };

  const flush = async (): Promise<void> => {
    while (queue.length > 0) {
      for (const queued of queue.splice(nextIndex(), 1)) {
        const { bytes, to } = queued;

        traffic.delivered.push(queued);

        if (to === 'server') {
          server.receive(bytes, 'a');
        } else {
          client.receive(bytes, 'server');
        }
      }

      // a turn for what answers asynchronously
      await nextTurn();
    }
  };

  return { client, flush, recorded, server, sizes, traffic };
};

/**
 * A client transport and a server transport joined back to back, as one connection `connectionHandle`:
 * what the client sends the server takes from it, and the other way. A message is handed over within
 * its send, or a turn later when `isDeferred`; a send while the connection is not open rejects.
 * `open` and `close` play its life; `sent` holds each side's bytes, in order.
 */
export const createPipedTransports = ({
  connectionHandle,
  isDeferred = false,
}: {
  connectionHandle: TransportServerConnectionHandle;
  isDeferred?: boolean | undefined;
}) => {
  const client = createEmitter<{
    close: [wasClean: boolean, wasQuick: boolean];
    message: [message: ITransportMessage];
    reconnect: [];
  }>();
  const server = createEmitter<{
    close: [wasClean: boolean, connectionHandle: TransportServerConnectionHandle];
    connection: [
      socket: unknown,
      request: unknown,
      connectionHandle: TransportServerConnectionHandle,
    ];
    message: [message: ITransportMessage, connectionHandle: TransportServerConnectionHandle];
  }>();
  const sent = { client: [] as Uint8Array[], server: [] as Uint8Array[] };
  let isOpen = false;

  // within the send, or a turn later
  const hand = (deliver: () => void): void => {
    if (isDeferred) {
      return (
        void Promise.resolve().then(() => {
          if (isOpen) {
            deliver();
          }
        }),
        undefined
      );
    }

    return (deliver(), undefined);
  };

  const clientTransport: IRouterClientTransportLike = {
    // oxlint-disable-next-line typescript/unbound-method -- `createEmitter` returns arrow functions, which have no `this` to lose
    off: client.off,
    // oxlint-disable-next-line typescript/unbound-method -- as above
    on: client.on,
    send: ({ data }) => {
      if (!isOpen) {
        return Promise.reject(new Error(`${connectionHandle} is not open`));
      }

      const bytes = bytesOf(data);

      sent.client.push(bytes);
      hand(() => {
        server.emit('message', { data: bytes }, connectionHandle);
      });

      return Promise.resolve();
    },
  };
  const serverTransport: IRouterServerTransportLike = {
    // oxlint-disable-next-line typescript/unbound-method -- `createEmitter` returns arrow functions, which have no `this` to lose
    off: server.off,
    // oxlint-disable-next-line typescript/unbound-method -- as above
    on: server.on,
    send: ({ data }, handle) => {
      if (!isOpen || handle !== connectionHandle) {
        return Promise.reject(new Error(`${handle} is not open`));
      }

      const bytes = bytesOf(data);

      sent.server.push(bytes);
      hand(() => {
        client.emit('message', { data: bytes });
      });

      return Promise.resolve();
    },
  };

  return {
    client: clientTransport,
    close: () => {
      isOpen = false;
      client.emit('close', false, false);
      server.emit('close', false, connectionHandle);
    },
    open: () => {
      isOpen = true;
      server.emit('connection', {}, {}, connectionHandle);
    },
    sent,
    server: serverTransport,
  };
};
