// ── DevTools hook ─────────────────────────────────────────────────────────────

// What a page's client hands a DevTools extension's hook (decision 0015): its `debug` events while
// the extension watches, and its registry's exposition; announced, it attaches nothing until then.

// dependencies

import type {
  IRouterClient,
  IRouterDebugInfo,
  RouterClientConnectionHandle,
} from '../router/client/types';
import type { IMetricsExposition, IMetricsRegistry } from '../router/shared/metrics-registry';
import type { IDebugEvent, IServiceManager } from '../router/shared/types';

// interfaces

/** What a DevTools extension defines under {@link DEVTOOLS_HOOK_KEY}, before the page runs. */
export interface IDevtoolsHook {
  /** Takes a source; what it returns withdraws it. */
  register(source: IDevtoolsSource): () => void;
}

/** What a client hands the hook, and nothing more: never itself, its router or its credential. */
export interface IDevtoolsSource {
  /** The hook's protocol, which a change to this shape moves. */
  readonly protocol: 1;
  readonly side: 'client';
  /** The client's registry's exposition, or `undefined` when it was given none. */
  exposition(): IMetricsExposition | undefined;
  /** Listens to the services' `debug` and the router's; what it returns stops listening. */
  watch(listeners: IDevtoolsListeners): () => void;
}

/**
 * What a watch hears: each step of a call, as the services' `debug` gives it, and each envelope, as
 * the router's does, its credential reduced to its scheme.
 */
export interface IDevtoolsListeners {
  call: (error: unknown, event: IDebugEvent) => void;
  envelope: (info: IRouterDebugInfo) => void;
}

/** The layers of a client a source listens to, and the registry it reads. */
export interface IDevtoolsLayers {
  metricsRegistry: IMetricsRegistry | undefined;
  router: IRouterClient;
  services: IServiceManager<RouterClientConnectionHandle>;
}

// constants

/**
 * Where a page's DevTools hook is, on `globalThis`: a key qualified by the package that owns it, as
 * decision 0008 qualifies a name, so no other library's global meets it.
 */
export const DEVTOOLS_HOOK_KEY = Symbol.for('@francisdesjardins/bead/devtools-hook');

/** What withdraws a source never announced. */
const NOTHING_TO_WITHDRAW = (): void => {};

// helpers

/** The page's hook, when one is defined and has a `register`; none when reading it throws. */
const hookOf = (): IDevtoolsHook | undefined => {
  // ! a page's global, or its `register`, may be a getter that throws: the client is built all the
  // same
  try {
    const hook: unknown = (globalThis as Record<symbol, unknown>)[DEVTOOLS_HOOK_KEY];

    return typeof hook === 'object' &&
      hook !== null &&
      typeof (hook as Partial<IDevtoolsHook>).register === 'function'
      ? (hook as IDevtoolsHook)
      : undefined;
  } catch {
    return undefined;
  }
};

// definition

/**
 * Announces a client's layers to the page's DevTools hook, when one is defined, and gives what
 * withdraws them. A hook that is no hook, one whose read throws, or one whose `register` throws, is
 * ignored: the client is built all the same, and what this gives withdraws nothing.
 */
export const announceToDevtools = ({
  metricsRegistry,
  router,
  services,
}: IDevtoolsLayers): (() => void) => {
  const hook = hookOf();

  if (hook === undefined) {
    return NOTHING_TO_WITHDRAW;
  }

  const source: IDevtoolsSource = Object.freeze({
    exposition: () => {
      return metricsRegistry?.exposition();
    },
    protocol: 1,
    side: 'client',
    // listeners of its own each watch, so a stop takes away its own and no other watch's
    watch: (listeners: IDevtoolsListeners) => {
      const call = (error: unknown, event: IDebugEvent): void => {
        listeners.call(error, event);
      };
      const envelope = (info: IRouterDebugInfo): void => {
        listeners.envelope(info);
      };

      services.on('debug', call);
      router.on('debug', envelope);

      return () => {
        services.off('debug', call);
        router.off('debug', envelope);
      };
    },
  } as const);

  try {
    const withdraw = hook.register(source);

    if (typeof withdraw !== 'function') {
      return NOTHING_TO_WITHDRAW;
    }

    let isWithdrawn = false;

    // once, however often the client is disposed
    return () => {
      if (isWithdrawn) {
        return;
      }

      isWithdrawn = true;

      try {
        withdraw();
      } catch {
        // a hook that throws as it withdraws changes nothing of the client
      }
    };
  } catch {
    return NOTHING_TO_WITHDRAW;
  }
};
