// ── WebSocket client ──────────────────────────────────────────────────────────

// dependencies

import {
  createWSTransportClient,
  type IWSTransportClientOptions,
  type WSTransportClient,
} from '../transport/client/ws-transport-client';
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
   * The transport's options; binary comes as frames, so as `'arraybuffer'` or `'nodebuffer'`; the
   * clock is every layer's.
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
  return createClient(
    {
      router: options?.router,
      services: options?.services,
      transport: createWSTransportClient(options?.transport),
    },
    { credential: options?.credential, credentials: options?.credentials, limits: options?.limits }
  );
};
