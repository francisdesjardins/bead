// ── WebSocket server ──────────────────────────────────────────────────────────

// dependencies

import {
  createWSTransportServer,
  type IWSTransportServerOptions,
  type WSTransportServer,
} from '../transport/server/ws-transport-server';
import { LIMIT_DEFAULTS } from '../router/shared/constants';
import { limitsOf } from '../router/shared/router-limits';
import { ProgrammerError } from '../transport/shared/errors';
import { createServer } from './server';
import type { IServer, IServerLayers, IServerOptions } from './types';

export * from './server';

// interfaces

/**
 * A WebSocket server's layers and options: the transport's options, and the rest as a server takes
 * them.
 */
export interface IWSServerOptions<Data = unknown>
  extends Omit<IServerLayers<WSTransportServer, Data>, 'transport'>, Omit<IServerOptions, 'clock'> {
  /**
   * The transport's options; binary comes as frames, so as `'arraybuffer'` or `'nodebuffer'`. A
   * message is an envelope at most — the limits' `maximumEnvelopeBytes` — unless `maxPayload` says
   * more: `ws` closes a connection that sends a larger one with 1009. A `maxPayload` below an
   * envelope's limit is a {@link ProgrammerError}: the socket would cut off envelopes the router
   * takes. What may wait for a socket, `maximumUnsentBytes`, is what a peer that keeps every rule can
   * be owed under the limits, unless it says otherwise. Its clock is every layer's.
   */
  transport: Omit<IWSTransportServerOptions, 'binaryType'> & {
    binaryType?: 'arraybuffer' | 'nodebuffer' | undefined;
  };
}

// types

export type WSServer<Data = unknown> = IServer<WSTransportServer, Data>;

// definition

/**
 * A server over WebSocket: {@link createServer} with a WebSocket transport server, on `ws`'s
 * injected `WebSocketServer`, as its bottom layer.
 *
 * @example
 * import { createWSServer } from '@francisdesjardins/bead/ws-server';
 *
 * const server = createWSServer({ closeOnCommandTimeout: true, transport: { WebSocketServer } });
 *
 * void server.transport.start({ port });
 */
export const createWSServer = <Data = unknown>(options: IWSServerOptions<Data>): WSServer<Data> => {
  const maximumEnvelopeBytes =
    options.limits?.maximumEnvelopeBytes ?? LIMIT_DEFAULTS.maximumEnvelopeBytes;
  const maxPayload = options.transport.maxPayload ?? maximumEnvelopeBytes;

  if (maxPayload < maximumEnvelopeBytes) {
    throw new ProgrammerError(
      `maxPayload is an envelope's limit at least, ${String(maximumEnvelopeBytes)} bytes, not ${String(maxPayload)}`
    );
  }

  // the router's limits, held as it holds them: one that does not hold is refused here first
  const { chunkBytes, maximumAnsweringCalls, maximumTransfers, windowBytes } = limitsOf(
    options.limits
  );
  // * what a peer that keeps every rule can be owed at once (spec 15.12): a chunk a call each way, a
  // window a transfer, and two envelopes of the server's own
  const maximumUnsentBytes =
    options.transport.maximumUnsentBytes ??
    2 * maximumAnsweringCalls * chunkBytes +
      maximumTransfers * windowBytes +
      2 * maximumEnvelopeBytes;

  return createServer<WSTransportServer, Data>(
    {
      router: options.router,
      services: options.services,
      sessions: options.sessions,
      transport: createWSTransportServer({ ...options.transport, maximumUnsentBytes, maxPayload }),
    },
    {
      closeOnCommandTimeout: options.closeOnCommandTimeout,
      connectionInactivityTimeout: options.connectionInactivityTimeout,
      credentials: options.credentials,
      limits: options.limits,
      metricsRegistry: options.metricsRegistry,
      pacing: options.pacing,
      relay: options.relay,
    }
  );
};
