// ── Worker server ─────────────────────────────────────────────────────────────

// dependencies

import {
  createWorkerTransportServer,
  type IWorkerTransportServerOptions,
  type WorkerTransportServer,
} from '../transport/server/worker-transport-server';
import { createServer } from './server';
import type { IServer, IServerLayers, IServerOptions } from './types';

export * from './server';

// interfaces

/** A worker server's layers and options: the transport's, and the rest as a server takes them. */
export interface IWorkerServerOptions<Data = unknown>
  extends Omit<IServerLayers<WorkerTransportServer, Data>, 'transport'>, IServerOptions {
  /** The transport's options: where the worker hears its page, its `self`. */
  transport: IWorkerTransportServerOptions;
}

// types

export type WorkerServer<Data = unknown> = IServer<WorkerTransportServer, Data>;

// definition

/**
 * A server in a Web Worker: {@link createServer} with a worker transport server as its bottom layer.
 * Its `transport.start()` listens at once: called as the worker's script runs, it loses no connect.
 *
 * @example
 * import { createWorkerServer } from '@francisdesjardins/bead/worker-server';
 *
 * const server = createWorkerServer({ transport: { scope } });
 *
 * void server.transport.start();
 */
export const createWorkerServer = <Data = unknown>(
  options: IWorkerServerOptions<Data>
): WorkerServer<Data> => {
  return createServer<WorkerTransportServer, Data>(
    {
      router: options.router,
      services: options.services,
      sessions: options.sessions,
      transport: createWorkerTransportServer(options.transport),
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
