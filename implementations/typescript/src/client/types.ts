// dependencies

import type {
  IRouterClient,
  IRouterClientOptions,
  IRouterClientTransportLike,
  RouterClientConnectionHandle,
} from '../router/client/types';
import type { IServiceManager, RouterLimitsOptions } from '../router/shared/types';

// interfaces

/**
 * What an application talks to a server with: its three layers — the transport, the router on it,
 * the services on the router — and the transport's connection.
 */
export interface IClient<Transport extends IClientTransportLike = IClientTransportLike> {
  readonly router: IRouterClient<Transport>;
  /** The requesters and resolvers of the services, made on {@link IClient.router}. */
  readonly services: IServiceManager<RouterClientConnectionHandle>;
  readonly transport: Transport;

  connect(options: Parameters<Transport['connect']>[0]): Promise<void>;
  disconnect(options?: Parameters<Transport['disconnect']>[0]): Promise<void>;
  /** Reconnects the transport; a dispose aborts it, along with the signal given. */
  reconnect(options?: Parameters<Transport['reconnect']>[0]): Promise<void>;
  /**
   * What `await using` calls: a reconnection under way is aborted, so none reopens a connection
   * nothing owns; then the layers come apart in the reverse of the order they were built in — the
   * router stops listening to the transport, rejecting what still waits for an answer, then the
   * transport closes.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * The layers of a client, bottom up: the transport, built, then what builds each layer on the one
 * under it.
 */
export interface IClientLayers<Transport extends IClientTransportLike> {
  /**
   * Builds the router on the transport, with the client's limits; `createRouterClient` when not
   * given.
   */
  router?:
    | ((transport: Transport, options: IRouterClientOptions) => IRouterClient<Transport>)
    | undefined;
  /** Builds the services on the router; `createServiceManager` when not given. */
  services?:
    | ((router: IRouterClient<Transport>) => IServiceManager<RouterClientConnectionHandle>)
    | undefined;
  transport: Transport;
}

export interface IClientOptions {
  /**
   * How much the router reads, writes and holds, which it is built with: {@link LIMIT_DEFAULTS}'
   * where these say nothing. They must hold together, or the client is a {@link ProgrammerError}.
   */
  limits?: RouterLimitsOptions | undefined;
}

/**
 * The part of a transport client a client uses, besides what its router does — met by any of this
 * package's. The options are the transport's own: {@link IClient} reads them back from it.
 */
export interface IClientTransportLike extends IRouterClientTransportLike {
  connect(options: unknown): Promise<void>;
  disconnect(options?: unknown): Promise<void>;
  reconnect(options?: { signal?: AbortSignal | undefined }): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
