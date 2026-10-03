// ── HTTP client ───────────────────────────────────────────────────────────────

// dependencies

import { wholeEnvelopeLimitsOf } from '../router/shared/whole-envelope-limits';
import {
  createHTTPTransportClient,
  type HTTPTransportClient,
  type IHTTPTransportClientOptions,
} from '../transport/client/http-transport-client';
import { createClient } from './client';
import type { IClient, IClientLayers, IClientOptions } from './types';

export * from './client';

// interfaces

/**
 * An HTTP client's layers and options: the transport's options, and the router, the services and
 * the limits as a client takes them.
 */
export interface IHTTPClientOptions
  extends Omit<IClientLayers<HTTPTransportClient>, 'transport'>, IClientOptions {
  /**
   * The transport's options; the largest answer is the limits' envelope, which they set, and the
   * clock is every layer's.
   */
  transport?: Omit<IHTTPTransportClientOptions, 'maximumBodyBytes'> | undefined;
}

// types

export type HTTPClient = IClient<HTTPTransportClient>;

// definition

/**
 * A client over HTTP: {@link createClient} with an HTTP transport as its bottom layer, one envelope
 * per exchange. It sends no transfer, and a payload is what one envelope holds. It listens for what
 * the server sends of its own — a subscription's notifications, a command — unless its transport is
 * told not to, and then subscribes to nothing and answers no command.
 *
 * @example
 * import { createHTTPClient } from '@francisdesjardins/bead/http-client';
 *
 * const client = createHTTPClient();
 *
 * void client.connect({ host, port });
 */
export const createHTTPClient = (options?: IHTTPClientOptions): HTTPClient => {
  const limits = wholeEnvelopeLimitsOf(options?.limits);

  return createClient(
    {
      router: options?.router,
      services: options?.services,
      transport: createHTTPTransportClient({
        ...options?.transport,
        maximumBodyBytes: limits.maximumEnvelopeBytes,
      }),
    },
    { limits }
  );
};
