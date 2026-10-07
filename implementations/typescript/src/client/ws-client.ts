// ── WebSocket client ──────────────────────────────────────────────────────────

// dependencies

import {
  createWSTransportClient,
  type IWSTransportClientOptions,
  type WSTransportClient,
} from '../transport/client/ws-transport-client';
import { LIMIT_DEFAULTS } from '../router/shared/constants';
import { ProgrammerError } from '../transport/shared/errors';
import { createClient } from './client';
import type { IClient, IClientLayers, IClientOptions } from './types';

export * from './client';

// interfaces

/**
 * A WebSocket client's layers and options: the transport's options, and the router, the services
 * and the limits as a client takes them.
 */
export interface IWSClientOptions
  extends Omit<IClientLayers<WSTransportClient>, 'transport'>, IClientOptions {
  /**
   * The transport's options; binary comes as frames, so as `'arraybuffer'` or `'nodebuffer'`. A
   * message is an envelope at most — the limits' `maximumEnvelopeBytes` — unless `maxPayload` says
   * more, where its `WebSocket` takes a bound: `ws` closes a connection that sends a larger one with
   * 1009. A `maxPayload` below an envelope's limit is a {@link ProgrammerError}: the socket would cut
   * off envelopes the router takes. The clock is every layer's.
   */
  transport?:
    | (Omit<IWSTransportClientOptions, 'binaryType'> & {
        binaryType?: 'arraybuffer' | 'nodebuffer' | undefined;
      })
    | undefined;
}

// types

export type WSClient = IClient<WSTransportClient>;

// definition

/**
 * A client over WebSocket: {@link createClient} with a WebSocket transport as its bottom layer.
 *
 * @example
 * import { createWSClient } from '@francisdesjardins/bead/ws-client';
 *
 * const client = createWSClient();
 *
 * void client.connect({ host, port, pathname: '/api' });
 */
export const createWSClient = (options?: IWSClientOptions): WSClient => {
  const maximumEnvelopeBytes =
    options?.limits?.maximumEnvelopeBytes ?? LIMIT_DEFAULTS.maximumEnvelopeBytes;
  const maxPayload = options?.transport?.maxPayload ?? maximumEnvelopeBytes;

  if (maxPayload < maximumEnvelopeBytes) {
    throw new ProgrammerError(
      `maxPayload is an envelope's limit at least, ${String(maximumEnvelopeBytes)} bytes, not ${String(maxPayload)}`
    );
  }

  return createClient(
    {
      router: options?.router,
      services: options?.services,
      transport: createWSTransportClient({ ...options?.transport, maxPayload }),
    },
    {
      credential: options?.credential,
      credentials: options?.credentials,
      devtools: options?.devtools,
      limits: options?.limits,
      metricsRegistry: options?.metricsRegistry,
    }
  );
};
