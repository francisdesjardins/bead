// ── WebSocket server ──────────────────────────────────────────────────────────

// dependencies

import {
  createWSTransportServer,
  type IWSTransportServerOptions,
  type WSTransportServer,
} from '../transport/server/ws-transport-server';
import { LIMIT_DEFAULTS } from '../router/shared/constants';
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
  extends Omit<IServerLayers<WSTransportServer, Data>, 'transport'>, IServerOptions {
  /**
   * The transport's options; binary comes as frames, so as `'arraybuffer'` or `'nodebuffer'`. A
   * message is an envelope at most — the limits' `maximumEnvelopeBytes` — unless `maxPayload` says
   * more: `ws` closes a connection that sends a larger one with 1009. A `maxPayload` below an
   * envelope's limit is a {@link ProgrammerError}: the socket would cut off envelopes the router
   * takes.
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

  return createServer<WSTransportServer, Data>(
    {
      router: options.router,
      services: options.services,
      sessions: options.sessions,
      transport: createWSTransportServer({ ...options.transport, maxPayload }),
    },
    {
      closeOnCommandTimeout: options.closeOnCommandTimeout,
      connectionInactivityTimeout: options.connectionInactivityTimeout,
      limits: options.limits,
      pacing: options.pacing,
      relay: options.relay,
    }
  );
};
