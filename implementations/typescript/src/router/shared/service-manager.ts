// ── Service manager ───────────────────────────────────────────────────────────

// dependencies

import { assertHeld, clockOf } from '../../transport/shared/clock';
import { createEmitter } from '../../transport/shared/emitter';
import { ProgrammerError, toError } from '../../transport/shared/errors';
import { createEventMethods } from '../../transport/shared/lifecycle';
import { isAdmissionFailure } from './admission';
import { DEBUG_EVENT, DEPRECATED_EVENT, DROPPED_EVENT } from './constants';
import { checkDeclaration } from './identity';
import { createNotification } from './notification';
import { createProcedureMap } from './procedure-map';
import { createServiceRequester, REQUEST_DEFAULTS } from './service-requester';
import { createServiceResolver } from './service-resolver';
import { createServiceTrace } from './service-trace';
import type {
  ConnectionHandle,
  INotification,
  INotificationDependencies,
  INotificationResolver,
  INotificationResolverDependencies,
  INotifyOptions,
  IProcedure,
  IRequestResolver,
  IRequestResolverDependencies,
  IRouterLike,
  IServiceManager,
  IServiceManagerOptions,
  ISubscriber,
  NotificationResolverCallback,
  RequestResolverCallback,
  ResolverFailure,
  ServiceManagerEventMap,
} from './types';

// helpers

/**
 * What sets `asked` apart from `known`, two asks for one procedure, as a phrase for an error;
 * `undefined` when they are the same ask.
 */
const differenceOf = (known: IProcedure, asked: IProcedure): string | undefined => {
  if (known.procedureKind !== asked.procedureKind) {
    return `kind ${String(known.procedureKind)}, not ${String(asked.procedureKind)}`;
  }

  for (const field of ['maximumPayloadBytes', 'procedureName', 'serviceRevision'] as const) {
    if (known[field] !== asked[field]) {
      return `${field} ${String(known[field])}, not ${String(asked[field])}`;
    }
  }

  if (
    (known.deprecation === undefined) !== (asked.deprecation === undefined) ||
    known.deprecation?.message !== asked.deprecation?.message
  ) {
    return 'another deprecation';
  }

  return undefined;
};

/** `resolver`, named after its procedure and carrying it. */
const nameAfter = <Resolver extends (...params: never[]) => unknown>(
  resolver: Resolver,
  procedure: IProcedure
): Resolver & IProcedure => {
  return Object.defineProperty(Object.assign(resolver, procedureOf(procedure)), 'name', {
    value: procedure.procedureName,
  });
};

/**
 * Whether a notification goes to a subscription, by its connection and the session holding it, as
 * `options` say; `undefined` when each gets it.
 */
const filterOf = <Handle extends string>(
  options?: INotifyOptions<Handle>
): ((subscriber: ISubscriber<Handle>) => boolean) | undefined => {
  const { exclude, filter } = options ?? {};

  if (exclude === undefined && filter === undefined) {
    return undefined;
  }

  return (subscriber) => {
    return subscriber.connectionHandle !== exclude && (filter === undefined || filter(subscriber));
  };
};

/**
 * The procedure alone, without whatever else the object carries: its kind and its limit, when it
 * has them, and a copy of its deprecation.
 */
const procedureOf = (given: IProcedure): IProcedure => {
  const {
    deprecation,
    maximumPayloadBytes,
    procedureId,
    procedureKind,
    procedureName,
    serviceId,
    serviceRevision,
  } = given;
  const procedure = {
    procedureId,
    procedureName,
    serviceId,
    serviceRevision,
    ...(procedureKind === undefined ? {} : { procedureKind }),
    ...(maximumPayloadBytes === undefined ? {} : { maximumPayloadBytes }),
  };

  return deprecation === undefined ? procedure : { ...procedure, deprecation: { ...deprecation } };
};

// definition

/**
 * The requesters and resolvers of the services on one router: what a requester calls, and what
 * answers it on the other side. Both sides of a router use the same manager, which runs on its
 * router's clock: one its options give that differs is a {@link ProgrammerError}.
 *
 * @example
 * import { createServiceManager } from '@francisdesjardins/bead/service-manager';
 *
 * const manager = createServiceManager(router);
 *
 * manager.on('deprecated', (procedure) => {
 *   console.warn(`${procedure.procedureName} is deprecated`, procedure.deprecation?.message);
 * });
 *
 * const echo = manager.getRequestResolver(
 *   { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 1 },
 *   { serializer: textSerializer }
 * )((request, response) => {
 *   return response(request.payload);
 * });
 */
export const createServiceManager = <Handle extends string = ConnectionHandle>(
  router: IRouterLike<Handle>,
  options?: IServiceManagerOptions<Handle>
): IServiceManager<Handle> => {
  const clock = clockOf(
    { beneath: router.clock, given: options?.clock },
    { below: 'its router', layer: 'a service manager' }
  );
  const closeConnection = options?.closeConnection;
  // held as the manager is built, rather than refused at each call it would time
  const defaults = Object.freeze({
    closeOnTimeout: options?.defaults?.closeOnTimeout,
    timeout: assertHeld(
      "a call's default timeout",
      options?.defaults?.timeout ?? REQUEST_DEFAULTS.timeout
    ),
  });
  const emitter = createEmitter<ServiceManagerEventMap>();
  // the notifications this manager made, one per procedure, kept for its life: asked for again,
  // the same one is given
  const notifications = createProcedureMap<{
    notification: unknown;
    procedure: IProcedure;
    window: number | undefined;
  }>();

  // whether anyone listens to `debug`: the one check a call makes while nobody does
  const isDebugging = (): boolean => {
    return emitter.listenerCount(DEBUG_EVENT) > 0;
  };

  const serviceTrace = createServiceTrace<Handle>(
    {
      isDebugging,
      emit: ({ connectionHandle, error, info }) => {
        emitter.emitEach(DEBUG_EVENT, {
          onError: (thrown) => {
            router.report(toError(thrown), connectionHandle);
          },
          params: [error, info],
        });
      },
    },
    {
      clock,
      side: () => {
        return router.failures.side;
      },
    }
  );

  const { notifiedNow, trace } = serviceTrace;

  const { callOf, requestOf } = createServiceRequester(router, {
    closeConnection,
    defaults,
    deprecated: (procedure) => {
      emitter.emit(DEPRECATED_EVENT, procedure);
    },
    nameAfter,
    procedureOf,
    trace: serviceTrace,
  });

  const getNotification = <RequestPayload, ResponsePayload, NotificationPayload>(
    procedure: IProcedure,
    dependencies: INotificationDependencies<RequestPayload, ResponsePayload, NotificationPayload>
  ): INotification<RequestPayload, NotificationPayload> => {
    // * the router's check before the manager's own reason, so spec 16.10's order holds here too
    checkDeclaration(procedure);

    const known = notifications.get(procedure);

    // the router holds one notification per procedure, so a second one would never be triggered
    if (known !== undefined) {
      // * a window is the notification's, asked for once: unpaced and paced are two windows
      const difference =
        differenceOf(known.procedure, procedure) ??
        (known.window === dependencies.window
          ? undefined
          : `window ${String(known.window)}, not ${String(dependencies.window)}`);

      if (difference !== undefined) {
        throw new ProgrammerError(
          `${String(procedure.serviceId)}/${String(procedure.procedureId)} is already a notification with ${difference}`
        );
      }

      // the same procedure, kind, name, revision, deprecation, payload limit and window: the same
      // payloads
      return known.notification as INotification<RequestPayload, NotificationPayload>;
    }

    const notification = createNotification(procedure, {
      dependencies,
      named: (callable) => {
        return nameAfter(callable, procedure);
      },
      onDropped: (failure) => {
        emitter.emit(DROPPED_EVENT, procedureOf(procedure), failure);
      },
      requesterOf: (subscribes) => {
        return callOf(procedure, { dependencies, subscribes, type: 'request' });
      },
      router,
      // heard, decoded or not: one check while nobody listens, and nothing built
      trace: (error, rx) => {
        if (isDebugging()) {
          trace(procedure, {
            direction: 'rx',
            error,
            rx,
            started: notifiedNow(),
            type: 'notification',
          });
        }
      },
    });

    notifications.set(procedure, {
      notification,
      procedure: procedureOf(procedure),
      window: dependencies.window,
    });

    return notification;
  };

  const { createResolver } = createServiceResolver(router, { nameAfter, trace: serviceTrace });

  // a refusal is checked once, as the resolver is asked for, rather than as each request is refused,
  // after the procedure's identity, which spec 16.10 checks before any reason of the manager's
  const assertRefusal = (
    procedure: IProcedure,
    { beforeRequest }: Pick<IRequestResolverDependencies<never, never, Handle>, 'beforeRequest'>
  ): void => {
    checkDeclaration(procedure);

    if (
      beforeRequest?.refusal !== undefined &&
      !isAdmissionFailure(beforeRequest.refusal, router.failures)
    ) {
      throw new ProgrammerError(
        `${procedure.procedureName} refuses with a failure that is not an admission's of the ${router.failures.side}'s table`
      );
    }
  };

  const getRequestResolver = <
    RequestPayload,
    ResponsePayload,
    Failure extends ResolverFailure = ResolverFailure,
  >(
    procedure: IProcedure,
    dependencies: IRequestResolverDependencies<RequestPayload, ResponsePayload, Handle>
  ) => {
    assertRefusal(procedure, dependencies);

    return (
      callback: RequestResolverCallback<RequestPayload, ResponsePayload, Failure, Handle>
    ): IRequestResolver<Handle> => {
      const resolver = createResolver(procedure, { callback, dependencies, type: 'request' });

      router.registerResolver(resolver);

      return resolver;
    };
  };

  const getCommandResolver = <
    RequestPayload,
    ResponsePayload,
    Failure extends ResolverFailure = ResolverFailure,
  >(
    procedure: IProcedure,
    dependencies: IRequestResolverDependencies<RequestPayload, ResponsePayload, Handle>
  ) => {
    assertRefusal(procedure, dependencies);

    return (
      callback: RequestResolverCallback<RequestPayload, ResponsePayload, Failure, Handle>
    ): IRequestResolver<Handle> => {
      const resolver = createResolver(procedure, { callback, dependencies, type: 'command' });

      router.registerResolver(resolver);

      return resolver;
    };
  };

  const getNotificationResolver = <
    RequestPayload,
    ResponsePayload,
    NotificationPayload,
    Failure extends ResolverFailure = ResolverFailure,
  >(
    procedure: IProcedure,
    dependencies: INotificationResolverDependencies<
      RequestPayload,
      ResponsePayload,
      NotificationPayload,
      Handle
    >
  ) => {
    assertRefusal(procedure, dependencies);

    return (
      callback: NotificationResolverCallback<RequestPayload, ResponsePayload, Failure, Handle>
    ): INotificationResolver<NotificationPayload, Handle> => {
      const { serializer } = dependencies;
      // its `notify` given before it is registered: the router declares a resolver that notifies
      const resolver = Object.assign(
        createResolver(procedure, { callback, dependencies, type: 'request' }),
        {
          notify: async (
            notification: NotificationPayload,
            notifyOptions?: INotifyOptions<Handle>
          ): Promise<void> => {
            // * the one check a notification makes while nobody listens
            const step = isDebugging()
              ? ({
                  direction: 'tx',
                  started: notifiedNow(),
                  tx: notification,
                  type: 'notification',
                } as const)
              : undefined;

            if (step !== undefined) {
              trace(procedure, step);
            }

            // a value that does not write goes to the router in its payload's place, for it to count
            // failed at each subscription it was for and report, as spec 17.2, item 6, has it
            let payload: Uint8Array | Error;
            let failure: unknown;

            try {
              payload = serializer.encodeNotification(notification);
            } catch (reason) {
              payload = toError(reason);
              failure = payload;
            }

            try {
              await router.notify(payload, {
                filter: filterOf(notifyOptions),
                key: notifyOptions?.key,
                procedure: procedureOf(resolver),
              });
            } catch (reason) {
              failure = reason;
            }

            // what keeps it from going out is told at the start it was sent with
            if (failure !== undefined && step !== undefined) {
              trace(procedure, { ...step, error: failure });
            }
          },
        }
      );

      router.registerResolver(resolver);

      return resolver;
    };
  };

  const manager: IServiceManager<Handle> = {
    ...createEventMethods(emitter, () => {
      return manager;
    }),

    get isDebugging() {
      return isDebugging();
    },

    getCommand: (procedure, dependencies) => {
      return requestOf(procedure, { dependencies, type: 'command' });
    },
    getCommandResolver,
    getNotification,
    getNotificationResolver,
    getRequest: (procedure, dependencies) => {
      return requestOf(procedure, { dependencies, type: 'request' });
    },
    getRequestResolver,
  };

  return manager;
};

// what the entry point gives with the manager

export {
  CLIENT_FAILURES,
  CredentialScheme,
  DEBUG_EVENT,
  DEPRECATED_EVENT,
  DROPPED_EVENT,
  FailureScope,
  ProcedureKind,
  ProtocolCode,
  SERVER_FAILURES,
} from './constants';
export { filterDebug, parseDebugFilter } from './debug-filter';
export {
  createMetricsRegistry,
  METRICS_CONTENT_TYPE,
  METRICS_REGISTRY_DEFAULTS,
} from './metrics-registry';
export type {
  IMetricsExposition,
  IMetricsRegistry,
  IMetricsRegistryOptions,
  IProcedureSeries,
} from './metrics-registry';
export { DisconnectError, FailureError } from './errors';
export { ProgrammerError } from '../../transport/shared/errors';
export type { IEventIteratorOptions } from '../../transport/shared/types';
export type {
  AdmissionFailure,
  Announcement,
  CallId,
  ConnectionHandle,
  Credential,
  DebugDirection,
  DebugFilterSource,
  DebugType,
  DestinationId,
  EnvelopeHeader,
  FailureOrigin,
  IAdmissionRequest,
  IApplicationFailure,
  IBeforeRequest,
  IBoundCall,
  IDebugEvent,
  IDebugFilter,
  IFailure,
  IFailureHeader,
  INotification,
  INotificationDependencies,
  INotificationHeader,
  INotificationLike,
  INotificationRegistration,
  INotificationResolver,
  INotificationResolverDependencies,
  INotificationResponse,
  INotificationSerializerClient,
  INotificationSerializerServer,
  INotifyOptions,
  IProcedure,
  IProcedureAddress,
  IProtocolFailure,
  IReceivedFailure,
  IRequest,
  IRequestDependencies,
  IRequestHeader,
  IRequestOptions,
  IRequestProps,
  IRequestResolver,
  IRequestResolverDependencies,
  IRequestResolverProps,
  IRequestSerializerClient,
  IRegistrar,
  IRequestSerializerServer,
  IResolvedRequestOptions,
  IResponse,
  IResultHeader,
  IRouterResult,
  IRouterFailures,
  IRouterLike,
  IServiceManager,
  IServiceManagerOptions,
  ISubscriber,
  NotificationKey,
  NotificationResolverCallback,
  ProcedureId,
  RedactedHeader,
  RequestOptionsParameters,
  RequestResolverCallback,
  ResolverFailure,
  RouterAnswer,
  RouterSide,
  SERVICE_MANAGER_EVENTS,
  ServerConnectionHandle,
  ServiceId,
  ServiceManagerEventMap,
  ServiceManagerOnDebugCallback,
  ServiceManagerOnDeprecatedCallback,
  ServiceManagerOnDroppedCallback,
  ServiceRevision,
  SessionIdentifier,
  SessionToken,
} from './types';

export { REQUEST_DEFAULTS, resolveRequestOptions } from './service-requester';
export type { RequestDefaults } from './service-requester';
