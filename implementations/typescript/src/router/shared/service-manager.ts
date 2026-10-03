// ── Service manager ───────────────────────────────────────────────────────────

// dependencies

import { assertHeld, clockOf } from '../../transport/shared/clock';
import { createEmitter } from '../../transport/shared/emitter';
import { ProgrammerError, TimeoutError, toError } from '../../transport/shared/errors';
import { createEventMethods } from '../../transport/shared/lifecycle';
import { noop } from '../../transport/shared/noop';
import { admissionOf, isAdmissionFailure } from './admission';
import { DEBUG_EVENT, DEPRECATED_EVENT, DROPPED_EVENT, FailureScope } from './constants';
import { FailureError } from './errors';
import { createNotification } from './notification';
import { createProcedureMap } from './procedure-map';
import type {
  AdmissionFailure,
  CallId,
  ConnectionHandle,
  DebugDirection,
  DebugType,
  IAdmissionRequest,
  IFailure,
  INotification,
  INotificationDependencies,
  INotificationLike,
  INotificationResolver,
  INotificationResolverDependencies,
  INotificationResponse,
  INotifyOptions,
  IProcedure,
  IRequestDependencies,
  IRequestOptions,
  IRequestProps,
  IRequestResolver,
  IRequestResolverDependencies,
  IRequestResolverProps,
  IResolvedRequestOptions,
  IRouterFailures,
  IRouterLike,
  IServiceManager,
  IServiceManagerOptions,
  NotificationResolverCallback,
  RequestResolverCallback,
  ResolverFailure,
  RouterAnswer,
  ServiceManagerEventMap,
} from './types';

// interfaces

/**
 * When a call started, on its router's clock: the wall clock's instant it reports, and the
 * monotonic reading its duration counts from.
 */
interface IStarted {
  instant: number;
  timestamp: number;
}

/** One step of a call, as `trace` tells it to `debug`. */
interface ITraceStep {
  direction: DebugDirection;
  error?: unknown;
  /** Whether the call has answered, so the step carries how long it took. */
  isAnswered?: boolean | undefined;
  options?: IResolvedRequestOptions | undefined;
  rx?: unknown;
  /** When its call started: every step of one call carries the same. */
  started: IStarted;
  tx?: unknown;
  type: DebugType;
}

// types

export type REQUEST_DEFAULTS = typeof REQUEST_DEFAULTS;

// constants

export const REQUEST_DEFAULTS = Object.freeze({
  timeout: 5_000,
});

// helpers

/**
 * What sets `asked` apart from `known`, two asks for one procedure, as a phrase for an error;
 * `undefined` when they are the same ask.
 */
const differenceOf = (known: IProcedure, asked: IProcedure): string | undefined => {
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

/** The failure a failed call carries, for `debug`; `undefined` when it carries none. */
const tracedFailureOf = (reason: unknown): IFailure | undefined => {
  if (!(reason instanceof FailureError)) {
    return undefined;
  }

  const { code, detail, scope } = reason;

  return { code, detail, scope };
};

/**
 * The failure a resolver's answer sends: the procedure's own — a code from 1 to 65535 and no scope —
 * as an application failure, or a refusal of admission from `failures`' table. Anything else is a
 * {@link ProgrammerError}, which leaves the request to be answered as failed.
 */
const resolverFailureOf = (failure: ResolverFailure, failures: IRouterFailures): IFailure => {
  const { code, detail } = failure;
  const described = typeof detail === 'string' ? { detail } : {};

  if (failure.scope === undefined && Number.isInteger(code) && code >= 1 && code <= 0xffff) {
    return { code, scope: FailureScope.APPLICATION, ...described };
  }

  if (isAdmissionFailure(failure, failures)) {
    return { code, scope: FailureScope.PROTOCOL, ...described };
  }

  throw new ProgrammerError(
    `a resolver answers a failure of its own, from 1 to 65535, or a refusal of admission from the ${failures.side}'s table, not ${String(code)}`
  );
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
 * `options` with `defaults` where they say nothing — a close on timeout only where `defaults` has one
 * — and the timeout held as a call's, so the trace, the router and the error tell one number:
 * rounded to the nearest whole millisecond, `Infinity` to wait on, and a {@link ProgrammerError} for
 * any other not from 1 to 2³¹ − 1, 0 among them. `options` is left alone.
 */
export const resolveRequestOptions = (
  options?: IRequestOptions,
  defaults: Pick<IResolvedRequestOptions, 'closeOnTimeout' | 'timeout'> = REQUEST_DEFAULTS
): IResolvedRequestOptions => {
  const {
    closeOnTimeout = defaults.closeOnTimeout,
    timeout: givenTimeout = defaults.timeout,
    ...rest
  } = options ?? {};
  const timeout = assertHeld("a call's timeout", givenTimeout);

  return closeOnTimeout === undefined ? { ...rest, timeout } : { ...rest, closeOnTimeout, timeout };
};

/** Whether a notification goes to a connection, as `options` say; `undefined` when each gets it. */
const filterOf = <Handle extends string>(
  options?: INotifyOptions<Handle>
): ((connectionHandle: Handle) => boolean) | undefined => {
  const { exclude, filter } = options ?? {};

  if (exclude === undefined && filter === undefined) {
    return undefined;
  }

  return (connectionHandle) => {
    return connectionHandle !== exclude && (filter === undefined || filter(connectionHandle));
  };
};

/**
 * The procedure alone, without whatever else the object carries: its limit, when it has one, and a
 * copy of its deprecation.
 */
const procedureOf = ({
  deprecation,
  maximumPayloadBytes,
  procedureId,
  procedureName,
  serviceId,
  serviceRevision,
}: IProcedure): IProcedure => {
  const procedure = {
    procedureId,
    procedureName,
    serviceId,
    serviceRevision,
    ...(maximumPayloadBytes === undefined ? {} : { maximumPayloadBytes }),
  };

  return deprecation === undefined ? procedure : { ...procedure, deprecation: { ...deprecation } };
};

/** A copy for `debug`, or the value itself when it cannot be cloned: a trace never fails a call. */
const snapshot = (value: unknown): unknown => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
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
  const notifications = createProcedureMap<{ notification: unknown; procedure: IProcedure }>();

  // now, for a call starting
  const startedNow = (): IStarted => {
    return { instant: clock.Date.now(), timestamp: clock.performance.now() };
  };

  // tells `debug` about one step of a call; nothing is built when nobody listens
  const trace = (procedure: IProcedure, step: ITraceStep): void => {
    if (emitter.listenerCount(DEBUG_EVENT) === 0) {
      return;
    }

    const { direction, error = null, isAnswered = false, options, rx, started, tx, type } = step;

    emitter.emit(DEBUG_EVENT, error, {
      direction,
      duration: isAnswered ? Math.trunc(clock.performance.now() - started.timestamp) : undefined,
      options: options === undefined ? undefined : { ...options },
      procedureId: procedure.procedureId,
      procedureName: procedure.procedureName,
      rx: snapshot(rx),
      serviceId: procedure.serviceId,
      serviceRevision: procedure.serviceRevision,
      startedAt: started.instant,
      tx: snapshot(tx),
      type,
    });
  };

  // the requester body that `getRequest`, `getCommand` and a notification's subscribing call share:
  // the options, the trace, the request, the close on timeout and the decoding; `subscribes` names
  // the notification the call subscribes; a timeout refused fails as the options are resolved,
  // before the trace and the deprecation
  const callOf = <RequestPayload, ResponsePayload>(
    procedure: IProcedure,
    {
      dependencies,
      subscribes,
      type,
    }: {
      dependencies: IRequestDependencies<RequestPayload, ResponsePayload>;
      subscribes?: (() => INotificationLike) | undefined;
      type: Exclude<DebugType, 'notification'>;
    }
  ) => {
    const { serializer } = dependencies;
    const { deprecation } = procedure;

    return (requestPayload: RequestPayload) => {
      return async (
        options?: IRequestOptions<Handle>
      ): Promise<{ callId: CallId; payload: ResponsePayload }> => {
        const resolvedOptions = resolveRequestOptions(options, defaults);
        const { closeOnTimeout, destinationId } = resolvedOptions;
        const connectionHandle = options?.connectionHandle;
        const started = startedNow();
        const step = {
          options: resolvedOptions,
          started,
          tx: requestPayload,
          type,
        } as const;

        trace(procedure, { ...step, direction: 'tx' });

        if (deprecation !== undefined) {
          emitter.emit(DEPRECATED_EVENT, procedureOf(procedure));
        }

        const encoded = serializer.encode(requestPayload);
        // what the call fails with once it went out is told as its answer
        const fail = (reason: unknown): never => {
          trace(procedure, {
            ...step,
            direction: 'rx',
            error: reason,
            isAnswered: true,
            rx: tracedFailureOf(reason),
          });

          throw reason;
        };
        const { header, payload } = await router
          .request(encoded, {
            options: resolvedOptions,
            procedure: procedureOf(procedure),
            subscribes: subscribes?.(),
          })
          .catch((reason: unknown) => {
            // a connection that let it go unanswered is closed, when the call or the manager says so
            if (
              reason instanceof TimeoutError &&
              closeOnTimeout &&
              connectionHandle !== undefined
            ) {
              closeConnection?.(connectionHandle);
            }

            return fail(reason);
          });
        let responsePayload: ResponsePayload;

        // an answer that does not decode fails here, with the result's header
        try {
          responsePayload = serializer.decode(payload);
        } catch (reason) {
          return fail(
            new FailureError(
              { ...router.failures.payloadUndecodable, detail: toError(reason).message },
              {
                cause: reason,
                destinationId,
                header,
                procedureAddress: procedure,
              }
            )
          );
        }

        trace(procedure, { ...step, direction: 'rx', isAnswered: true, rx: responsePayload });

        return { callId: header.callId, payload: responsePayload };
      };
    };
  };

  const requestOf = <RequestPayload, ResponsePayload>(
    procedure: IProcedure,
    {
      dependencies,
      type,
    }: {
      dependencies: IRequestDependencies<RequestPayload, ResponsePayload>;
      type: Exclude<DebugType, 'notification'>;
    }
  ) => {
    const requester = callOf(procedure, { dependencies, type });

    return nameAfter((requestPayload: RequestPayload) => {
      return async (options?: IRequestOptions<Handle>): Promise<ResponsePayload> => {
        const { payload } = await requester(requestPayload)(options);

        return payload;
      };
    }, procedure);
  };

  const getNotification = <RequestPayload, ResponsePayload, NotificationPayload>(
    procedure: IProcedure,
    dependencies: INotificationDependencies<RequestPayload, ResponsePayload, NotificationPayload>
  ): INotification<RequestPayload, NotificationPayload> => {
    const known = notifications.get(procedure);

    // the router holds one notification per procedure, so a second one would never be triggered
    if (known !== undefined) {
      const difference = differenceOf(known.procedure, procedure);

      if (difference !== undefined) {
        throw new ProgrammerError(
          `${String(procedure.serviceId)}/${String(procedure.procedureId)} is already a notification with ${difference}`
        );
      }

      // the same procedure, name, revision, deprecation and payload limit: the same payloads
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
      trace: (step) => {
        trace(procedure, { ...step, started: startedNow(), type: 'notification' });
      },
    });

    notifications.set(procedure, {
      notification,
      procedure: procedureOf(procedure),
    });

    return notification;
  };

  // the resolver of one procedure, registered in the router; a notification's callback may subscribe
  // its requester, which a plain request's callback is not typed to see
  const createResolver = <RequestPayload, ResponsePayload, Failure extends ResolverFailure>(
    procedure: IProcedure,
    {
      callback,
      dependencies,
      type,
    }: {
      callback: NotificationResolverCallback<RequestPayload, ResponsePayload, Failure, Handle>;
      dependencies: IRequestResolverDependencies<RequestPayload, ResponsePayload, Handle>;
      type: Exclude<DebugType, 'notification'>;
    }
  ): IRequestResolver<Handle> => {
    const { beforeRequest, serializer } = dependencies;

    // whether a request may reach the callback, on its header alone — the admission sees no more
    const admission =
      beforeRequest === undefined ? undefined : admissionOf(beforeRequest, router.failures);
    const admit = (request: IAdmissionRequest<Handle>): AdmissionFailure | undefined => {
      return admission?.(request);
    };

    const resolver = nameAfter(async (props: IRequestResolverProps<Handle>): Promise<void> => {
      const { connectionHandle, header, signal } = props;
      // the call starts as it arrives: its admission and its decoding count in its duration
      const started = startedNow();
      const target = { connectionHandle, header };
      // a request is answered once: by its callback, by a refusal, or as failed; the answer sets it,
      // out of the flow a type follows here
      let isAnswered = false as boolean;
      let requestPayload: RequestPayload;

      // a router that did not ask its admission leaves it here, before the payload is read; one that
      // throws answers the request as failed, and its reason goes on to the router
      if (props.isAdmitted !== true) {
        let refusal: AdmissionFailure | undefined;

        try {
          refusal = admit(target);
        } catch (reason) {
          await router.respond({ failure: router.failures.procedureFailed }, target).catch(noop);

          throw reason;
        }

        if (refusal !== undefined) {
          return router.respond({ failure: refusal }, target);
        }
      }

      // a payload that does not decode never reaches the callback
      try {
        requestPayload = serializer.decode(props.payload);
      } catch {
        return router.respond({ failure: router.failures.payloadUndecodable }, target);
      }

      trace(procedure, { direction: 'rx', rx: requestPayload, started, type });

      // the callback is handed the request, decoded, and no more
      const request: IRequestProps<RequestPayload, Handle> = Object.freeze({
        connectionHandle,
        header,
        payload: requestPayload,
        signal,
      });
      const answer = async (payload: ResponsePayload | null, failure?: Failure) => {
        if (isAnswered) {
          throw new ProgrammerError(`${procedure.procedureName} has answered this request already`);
        }

        // what fails before the answer goes out leaves the request unanswered, to be answered as
        // failed: a failure a resolver may not answer, or a payload that does not encode
        const routerAnswer: RouterAnswer =
          failure === undefined
            ? // without a failure, the overloads guarantee a payload
              { payload: serializer.encode(payload as ResponsePayload) }
            : { failure: resolverFailureOf(failure, router.failures) };

        isAnswered = true;
        trace(procedure, {
          direction: 'tx',
          isAnswered: true,
          rx: requestPayload,
          started,
          tx: failure ?? payload,
          type,
        });

        try {
          await router.respond(routerAnswer, target);
        } catch (reason) {
          // an answer the router could not send — too large, say — is answered as failed, so its
          // requester does not wait out its timeout; a connection gone takes neither
          await router.respond({ failure: router.failures.procedureFailed }, target).catch(noop);

          throw reason;
        }
      };
      const response: INotificationResponse<ResponsePayload, Failure> = Object.assign(answer, {
        registerNotification: (): CallId => {
          // a subscription the answer carries, so made before it goes out
          if (isAnswered) {
            throw new ProgrammerError(`${procedure.procedureName} subscribes before it answers`);
          }

          return router.subscribe(target);
        },
      });

      try {
        await callback(request, response);
      } catch (reason) {
        // a resolver that failed before it answered still answers, so its requester does not wait
        // out its timeout; why it failed stays here, for the router to report
        if (!isAnswered) {
          isAnswered = true;
          await router.respond({ failure: router.failures.procedureFailed }, target).catch(noop);
        }

        throw reason;
      }
    }, procedure);

    // the router asks the admission itself, before the payload comes
    const admitted = Object.assign(resolver, { admit });

    router.registerResolver(admitted);

    return admitted;
  };

  // a refusal is checked once, as the resolver is asked for, rather than as each request is refused
  const assertRefusal = (
    procedure: IProcedure,
    { beforeRequest }: Pick<IRequestResolverDependencies<never, never, Handle>, 'beforeRequest'>
  ): void => {
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
      return createResolver(procedure, { callback, dependencies, type: 'request' });
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
      return createResolver(procedure, { callback, dependencies, type: 'command' });
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
      const resolver = createResolver(procedure, { callback, dependencies, type: 'request' });

      return Object.assign(resolver, {
        notify: async (
          notification: NotificationPayload,
          notifyOptions?: INotifyOptions<Handle>
        ): Promise<void> => {
          const step = {
            direction: 'tx',
            started: startedNow(),
            tx: notification,
            type: 'notification',
          } as const;

          trace(procedure, step);

          // what keeps it from going out is told at the start it was sent with
          await router
            .notify(serializer.encodeNotification(notification), {
              filter: filterOf(notifyOptions),
              key: notifyOptions?.key,
              procedure: procedureOf(resolver),
            })
            .catch((reason: unknown) => {
              trace(procedure, { ...step, error: reason });
            });
        },
      });
    };
  };

  const manager: IServiceManager<Handle> = {
    ...createEventMethods(emitter, () => {
      return manager;
    }),

    get debug() {
      return emitter.listenerCount(DEBUG_EVENT) > 0;
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
  DEBUG_EVENT,
  DEPRECATED_EVENT,
  DROPPED_EVENT,
  FailureScope,
  ProtocolCode,
  SERVER_FAILURES,
} from './constants';
export { filterDebug, parseDebugFilter } from './debug-filter';
export {
  createDebugStatistics,
  DEBUG_STATISTICS_DEFAULTS,
  type IDebugStatistics,
  type IDebugStatisticsOptions,
  type IDurationSummary,
} from './debug-statistics';
export { DisconnectError, FailureError } from './errors';
export { ProgrammerError } from '../../transport/shared/errors';
export type { IEventIteratorOptions } from '../../transport/shared/types';
export type {
  AdmissionFailure,
  CallId,
  ConnectionHandle,
  DebugDirection,
  DebugFilterSource,
  DebugType,
  DestinationId,
  EnvelopeHeader,
  FailureOrigin,
  IAdmissionRequest,
  IApplicationFailure,
  IBeforeRequest,
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
  IRequestSerializerServer,
  IResolvedRequestOptions,
  IResponse,
  IResultHeader,
  IRouterResult,
  IRouterFailures,
  IRouterLike,
  IServiceManager,
  IServiceManagerOptions,
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
  SessionToken,
} from './types';
