// ── Service manager ───────────────────────────────────────────────────────────

// dependencies

import { assertHeld, clockOf } from '../../transport/shared/clock';
import { createEmitter } from '../../transport/shared/emitter';
import { ProgrammerError, TimeoutError, toError } from '../../transport/shared/errors';
import { createEventMethods } from '../../transport/shared/lifecycle';
import { noop } from '../../transport/shared/noop';
import { admissionOf, isAdmissionFailure } from './admission';
import {
  DEBUG_EVENT,
  DEPRECATED_EVENT,
  DROPPED_EVENT,
  FailureScope,
  SERVER_CONNECTION_HANDLE,
} from './constants';
import { FailureError } from './errors';
import { checkDeclaration } from './identity';
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
  IRouterResult,
  IServiceManager,
  IServiceManagerOptions,
  NotificationResolverCallback,
  RequestResolverCallback,
  ResolverFailure,
  ISubscriber,
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
interface ITraceStep<Handle extends string> {
  /** Its call's id: a call made's once its router drew it, a request received's from its header. */
  callId?: CallId | undefined;
  /** The connection the call came from or goes to, which a listener's error is reported with. */
  connectionHandle?: Handle | undefined;
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

/** A call made while someone listens: its steps' common part, and the id its router drew. */
interface ITracedCall<Handle extends string> {
  /** Its router's id for it, once `onCallId` heard it; none while it has not. */
  callId: CallId | undefined;
  /** What its router's `request` is handed, to hear the id it draws. */
  readonly onCallId: (callId: CallId) => void;
  readonly step: Omit<ITraceStep<Handle>, 'direction'>;
}

// types

export type REQUEST_DEFAULTS = typeof REQUEST_DEFAULTS;

/** What a call falls back on where its options say nothing: a timeout, and a close on timeout. */
export type RequestDefaults = Pick<IResolvedRequestOptions, 'closeOnTimeout' | 'timeout'>;

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
  defaults: RequestDefaults,
  options?: IRequestOptions
): IResolvedRequestOptions => {
  const {
    closeOnTimeout = defaults.closeOnTimeout,
    timeout: givenTimeout = defaults.timeout,
    ...rest
  } = options ?? {};
  const timeout = assertHeld("a call's timeout", givenTimeout);

  return closeOnTimeout === undefined ? { ...rest, timeout } : { ...rest, closeOnTimeout, timeout };
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

/** A call made, traced from `step`, which hears the id its router draws. */
const tracedCallOf = <Handle extends string>(
  step: Omit<ITraceStep<Handle>, 'direction'>
): ITracedCall<Handle> => {
  // ! apart from `callOf`, and called only while someone listens: a closure made in that async
  // body would hold its locals in a context V8 makes at every call, listened to or not
  const traced: ITracedCall<Handle> = {
    callId: undefined,
    onCallId: (callId) => {
      traced.callId = callId;
    },
    step,
  };

  return traced;
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
  const notifications = createProcedureMap<{
    notification: unknown;
    procedure: IProcedure;
    window: number | undefined;
  }>();

  // whether anyone listens to `debug`: the one check a call makes while nobody does
  const isDebugging = (): boolean => {
    return emitter.listenerCount(DEBUG_EVENT) > 0;
  };

  // now, for a call starting, traced: the wall clock for its start, the monotonic for its duration
  const startedNow = (): IStarted => {
    return { instant: clock.Date.now(), timestamp: clock.performance.now() };
  };

  // now, for a notification sent or heard, traced: one step, which takes no duration
  const notifiedNow = (): IStarted => {
    return { instant: clock.Date.now(), timestamp: 0 };
  };

  // tells `debug` about one step of a call, each listener within a guard: what one throws is
  // reported through the router, with the call's connection, and changes nothing of the call
  const trace = (procedure: IProcedure, step: ITraceStep<Handle>): void => {
    if (!isDebugging()) {
      return;
    }

    const { callId, connectionHandle, direction, error = null, isAnswered = false } = step;
    const { options, rx, started, tx, type } = step;
    // ! the credential a call presents stays out of what is told: its token, or what its transport
    // carries, never reaches a listener
    const { credential: _credential, ...told } = options ?? {};

    emitter.emitEach(DEBUG_EVENT, {
      onError: (thrown) => {
        router.report(toError(thrown), connectionHandle);
      },
      params: [
        error,
        {
          callId,
          // a step names its connection with its call, the server on a client, and none without
          connectionHandle:
            callId === undefined
              ? undefined
              : (connectionHandle ??
                (router.failures.side === 'client' ? SERVER_CONNECTION_HANDLE : undefined)),
          direction,
          duration: isAnswered
            ? Math.trunc(clock.performance.now() - started.timestamp)
            : undefined,
          options: options === undefined ? undefined : (told as IResolvedRequestOptions),
          procedureId: procedure.procedureId,
          procedureName: procedure.procedureName,
          rx: snapshot(rx),
          serviceId: procedure.serviceId,
          serviceRevision: procedure.serviceRevision,
          startedAt: started.instant,
          tx: snapshot(tx),
          type,
        },
      ],
    });
  };

  // the requester body that `getRequest`, `getCommand` and a notification's subscribing call share,
  // declared to the router as it is made, each call carrying the series it gave; `subscribes` names
  // the notification the call subscribes; a timeout refused, or a value not written, fails first
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
    const series = router.declareRequester(procedure);

    return (requestPayload: RequestPayload) => {
      return async (
        options?: IRequestOptions<Handle>
      ): Promise<{ callId: CallId; payload: ResponsePayload }> => {
        const resolvedOptions = resolveRequestOptions(defaults, options);
        const { closeOnTimeout, destinationId } = resolvedOptions;
        const connectionHandle = options?.connectionHandle;
        const encoded = serializer.encode(requestPayload);
        // * the one check a call makes while nobody listens: no clock is read, no step is built
        const traced = isDebugging()
          ? tracedCallOf<Handle>({
              connectionHandle,
              options: resolvedOptions,
              started: startedNow(),
              tx: requestPayload,
              type,
            })
          : undefined;

        if (deprecation !== undefined) {
          emitter.emit(DEPRECATED_EVENT, procedureOf(procedure));
        }

        const requested = router.request(encoded, {
          onCallId: traced?.onCallId,
          options: resolvedOptions,
          procedure: procedureOf(procedure),
          series,
          subscribes: subscribes?.(),
        });

        // ! told as `request` returns, before the await, on every path: with the id its router
        // drew, or none for a call refused first; a listener never runs in its router's turn
        if (traced !== undefined) {
          trace(procedure, { ...traced.step, callId: traced.callId, direction: 'tx' });
        }

        let result: IRouterResult;

        try {
          result = await requested;
        } catch (reason) {
          // a connection that let it go unanswered is closed, when the call or the manager says so
          if (reason instanceof TimeoutError && closeOnTimeout && connectionHandle !== undefined) {
            closeConnection?.(connectionHandle);
          }

          // what the call fails with once it went out is told as its answer
          if (traced !== undefined) {
            const { callId, step } = traced;
            const rx = tracedFailureOf(reason);

            trace(procedure, {
              ...step,
              callId,
              direction: 'rx',
              error: reason,
              isAnswered: true,
              rx,
            });
          }

          throw reason;
        }

        const { header, payload } = result;
        let responsePayload: ResponsePayload;

        // an answer that does not decode fails here, with the result's header
        try {
          responsePayload = serializer.decode(payload);
        } catch (reason) {
          const failure = new FailureError(
            { ...router.failures.payloadUndecodable, detail: toError(reason).message },
            {
              cause: reason,
              destinationId,
              header,
              procedureAddress: procedure,
            }
          );

          if (traced !== undefined) {
            const { callId, step } = traced;
            const rx = tracedFailureOf(failure);

            trace(procedure, {
              ...step,
              callId,
              direction: 'rx',
              error: failure,
              isAnswered: true,
              rx,
            });
          }

          throw failure;
        }

        if (traced !== undefined) {
          const { callId, step } = traced;

          trace(procedure, {
            ...step,
            callId,
            direction: 'rx',
            isAnswered: true,
            rx: responsePayload,
          });
        }

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

  // the resolver of one procedure, for the router to register; a notification's callback may
  // subscribe its requester, which a plain request's callback is not typed to see
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
      const { connectionHandle, header, session, signal } = props;
      // * the one check a request makes while nobody listens; traced, the call starts as it
      // arrives, its admission and its decoding counting in its duration
      const started = isDebugging() ? startedNow() : undefined;
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
          refusal = admit({ ...target, session });
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

      if (started !== undefined) {
        trace(procedure, {
          callId: header.callId,
          connectionHandle,
          direction: 'rx',
          rx: requestPayload,
          started,
          type,
        });
      }

      // the callback is handed the request, decoded, its call's session, and no more
      const request: IRequestProps<RequestPayload, Handle> = Object.freeze({
        connectionHandle,
        header,
        payload: requestPayload,
        session,
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

        const step =
          started === undefined
            ? undefined
            : ({
                callId: header.callId,
                connectionHandle,
                direction: 'tx',
                isAnswered: true,
                rx: requestPayload,
                started,
                tx: failure ?? payload,
                type,
              } as const);

        if (step !== undefined) {
          trace(procedure, step);
        }

        try {
          await router.respond(routerAnswer, target);
        } catch (reason) {
          // an answer the router could not send — too large, say — is told again at its start with
          // why, and answered as failed, so its requester does not wait out its timeout; a call no
          // longer answered takes neither
          if (step !== undefined && !signal.aborted) {
            trace(procedure, { ...step, error: reason });
          }

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

          return router.subscribe({ ...target, session });
        },
      });

      try {
        await callback(request, response);
      } catch (reason) {
        // a resolver that failed before it answered still answers, so its requester does not wait
        // out its timeout, told with why beside it, and why goes on for the router to report; a
        // call no longer answered takes neither
        if (!isAnswered) {
          isAnswered = true;

          if (started !== undefined && !signal.aborted) {
            trace(procedure, {
              callId: header.callId,
              connectionHandle,
              direction: 'tx',
              error: reason,
              isAnswered: true,
              rx: requestPayload,
              started,
              type,
            });
          }

          await router.respond({ failure: router.failures.procedureFailed }, target).catch(noop);
        }

        throw reason;
      }
    }, procedure);

    // the router asks the admission itself, before the payload comes
    return Object.assign(resolver, { admit });
  };

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
