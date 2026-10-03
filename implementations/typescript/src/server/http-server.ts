// ── HTTP server ───────────────────────────────────────────────────────────────

// dependencies

import { wholeEnvelopeLimitsOf } from '../router/shared/whole-envelope-limits';
import {
  createHTTPTransportServer,
  type HTTPTransportServer,
  type IHTTPTransportServerOptions,
} from '../transport/server/http-transport-server';
import { createServer } from './server';
import type { IServer, IServerLayers, IServerOptions } from './types';

export * from './server';
export {
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
} from '../transport/server/http-transport-server';
export type {
  HTTPTransportServer,
  IHTTPServerLike,
  IHTTPTransportServerOptions,
} from '../transport/server/http-transport-server';

// interfaces

/**
 * An HTTP server's layers and options: the transport's options, and the rest as a server takes them.
 */
export interface IHTTPServerOptions<Data = unknown>
  extends
    Omit<IServerLayers<HTTPTransportServer, Data>, 'transport'>,
    Omit<IServerOptions, 'clock'> {
  /**
   * The transport's options; the largest body is the limits' envelope, which they set, and the
   * clock is every layer's.
   */
  transport: Omit<IHTTPTransportServerOptions, 'maximumBodyBytes'>;
}

// constants

/**
 * How long, by default, a connection with no session may stay silent over HTTP: a connection is
 * drawn by any `POST`, so one never used goes within 30 s.
 */
export const CONNECTION_INACTIVITY_TIMEOUT = 30_000;

// types

export type HTTPServer<Data = unknown> = IServer<HTTPTransportServer, Data>;

// definition

/**
 * A server over HTTP: {@link createServer} with an HTTP transport server as its bottom layer, one
 * envelope per exchange. Its router takes no transfer — a request's body reaches it before its
 * answer goes, so no credit could come back — and a payload is what one envelope holds. What it
 * sends of its own reaches a client that listens; a client that does not is refused a subscription,
 * and a command to it rejects.
 *
 * @example
 * import { createHTTPServer } from '@francisdesjardins/bead/http-server';
 *
 * const server = createHTTPServer({
 *   transport: { createServer: (listener) => createServer(listener) },
 * });
 *
 * void server.transport.start({ port });
 */
export const createHTTPServer = <Data = unknown>(
  options: IHTTPServerOptions<Data>
): HTTPServer<Data> => {
  const limits = wholeEnvelopeLimitsOf(options.limits);

  return createServer<HTTPTransportServer, Data>(
    {
      router: options.router,
      services: options.services,
      sessions: options.sessions,
      transport: createHTTPTransportServer({
        ...options.transport,
        maximumBodyBytes: limits.maximumEnvelopeBytes,
      }),
    },
    {
      closeOnCommandTimeout: options.closeOnCommandTimeout,
      connectionInactivityTimeout:
        options.connectionInactivityTimeout ?? CONNECTION_INACTIVITY_TIMEOUT,
      limits,
      pacing: options.pacing,
      relay: options.relay,
    }
  );
};
