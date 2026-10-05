// ── Worker client ─────────────────────────────────────────────────────────────

// dependencies

import {
  createWorkerTransportClient,
  type IWorkerTransportClientOptions,
  type WorkerTransportClient,
} from '../transport/client/worker-transport-client';
import { createClient } from './client';
import type { IClient, IClientLayers, IClientOptions } from './types';

export * from './client';

// interfaces

/** A worker client's layers and options: the transport's, and the rest as a client takes them. */
export interface IWorkerClientOptions
  extends Omit<IClientLayers<WorkerTransportClient>, 'transport'>, IClientOptions {
  /** The transport's options: the worker the server runs in, at least; its clock, every layer's. */
  transport: IWorkerTransportClientOptions;
}

// types

export type WorkerClient = IClient<WorkerTransportClient>;

// definition

/**
 * A client to a server in a Web Worker: {@link createClient} with a worker transport as its bottom
 * layer — a page's own server, with no backend, for a demo or a test.
 *
 * @example
 * import { createWorkerClient } from '@francisdesjardins/bead/worker-client';
 *
 * const client = createWorkerClient({ transport: { worker } });
 *
 * void client.connect({});
 */
export const createWorkerClient = (options: IWorkerClientOptions): WorkerClient => {
  return createClient(
    {
      router: options.router,
      services: options.services,
      transport: createWorkerTransportClient(options.transport),
    },
    {
      credential: options.credential,
      credentials: options.credentials,
      limits: options.limits,
      metricsRegistry: options.metricsRegistry,
    }
  );
};
