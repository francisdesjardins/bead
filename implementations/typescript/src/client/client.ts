// ── Client ────────────────────────────────────────────────────────────────────

// dependencies

import { createRouterClient, DisconnectError } from '../router/client/router-client';
import { createServiceManager } from '../router/shared/service-manager';
import { clockOf } from '../transport/shared/clock';
import { announceToDevtools } from './devtools-hook';
import type { IClient, IClientLayers, IClientOptions, IClientTransportLike } from './types';

export {
  CLIENT_FAILURES,
  CredentialScheme,
  DisconnectError,
  FailureError,
  FailureScope,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../router/client/router-client';
export { LONGEST_TIMER, PLATFORM_CLOCK } from '../transport/shared/clock';
export type { IClock, TimeoutId } from '../transport/shared/clock';
export {
  CancelError,
  ConnectError,
  GenericError,
  ProgrammerError,
  ReadyStateError,
  ReconnectError,
  TimeoutError,
} from '../transport/shared/errors';
export type { IClient, IClientLayers, IClientOptions, IClientTransportLike } from './types';
export { DEVTOOLS_HOOK_KEY } from './devtools-hook';
export type { IDevtoolsHook, IDevtoolsListeners, IDevtoolsSource } from './devtools-hook';
export {
  createMetricsRegistry,
  METRICS_CONTENT_TYPE,
  METRICS_REGISTRY_DEFAULTS,
} from '../router/client/router-client';
export type {
  IMetricsExposition,
  IMetricsRegistry,
  IMetricsRegistryOptions,
} from '../router/client/router-client';
export type {
  ICallSession,
  IRouterClientOptions,
  IRouterLimits,
  RequestCredential,
  RouterLimitsOptions,
} from '../router/client/router-client';

// definition

/**
 * A client from its layers, bottom up: the transport, the router built on it, the services built on
 * the router. The router and the services are this package's unless others are given, so one layer
 * can be replaced without the others. Debugging is each layer's own — `client.router.on('debug', …)`
 * for the envelopes, `client.services.on('debug', …)` for the calls. Every layer runs on the
 * transport's clock: a router built on another is a {@link ProgrammerError}.
 *
 * @example
 * import { createClient } from '@francisdesjardins/bead/client';
 * import { createWSTransportClient } from '@francisdesjardins/bead/ws-transport-client';
 *
 * const client = createClient({ transport: createWSTransportClient() });
 *
 * client.services.on('debug', (error, info) => {
 *   console.log(info.direction, info.procedureName, error);
 * });
 * void client.connect({ host, port });
 */
export const createClient = <Transport extends IClientTransportLike>(
  {
    router: createRouter = createRouterClient,
    services: createServices = createServiceManager,
    transport,
  }: IClientLayers<Transport>,
  options?: IClientOptions
): IClient<Transport> => {
  const { clock } = transport;
  const router = createRouter(transport, {
    clock,
    credential: options?.credential,
    credentials: options?.credentials,
    limits: options?.limits,
    metricsRegistry: options?.metricsRegistry,
  });

  // a router a builder made on another clock comes apart, refused
  try {
    clockOf(
      { beneath: clock, given: router.clock },
      { below: 'its transport', layer: "a client's router" }
    );
  } catch (reason) {
    router[Symbol.dispose]();

    throw reason;
  }

  const services = createServices(router);
  // ends with the client: a reconnection it started must not outlive it
  const lifetime = new AbortController();
  // what the page's DevTools hook was handed, withdrawn with the client
  const withdraw =
    options?.devtools === false
      ? undefined
      : announceToDevtools({ metricsRegistry: options?.metricsRegistry, router, services });

  return {
    router,
    services,
    transport,

    connect: (options) => {
      return transport.connect(options);
    },
    disconnect: (options) => {
      return transport.disconnect(options);
    },
    reconnect: (options) => {
      const signal = options?.signal;

      return transport.reconnect({
        ...options,
        signal: signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal]),
      });
    },
    [Symbol.asyncDispose]: async () => {
      lifetime.abort(new DisconnectError('the client was disposed'));
      withdraw?.();

      // the reverse of the order they were built in; the services hold nothing of their own
      router[Symbol.dispose]();
      await transport[Symbol.asyncDispose]();
    },
  };
};
