// ── Service resolver ──────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { noop } from '../../transport/shared/noop';
import { admissionOf, isAdmissionFailure } from './admission';
import { EnvelopeKind, FailureScope } from './constants';
import { FailureError } from './errors';
import type { IServiceTrace } from './service-trace';
import type {
  AdmissionFailure,
  CallId,
  DebugType,
  IAdmissionRequest,
  IFailure,
  INotificationResponse,
  IProcedure,
  IRequestProps,
  IRequestResolver,
  IRequestResolverDependencies,
  IRequestResolverProps,
  IRouterFailures,
  IRouterLike,
  NotificationResolverCallback,
  ResolverFailure,
  RouterAnswer,
} from './types';
import { detailBoundOf, type IJudged, isRefused, violationsDetailOf } from './violations';

// interfaces

/** What a resolver is handed by its manager: how a procedure is named, and the trace. */
export interface IServiceResolverOptions<Handle extends string> {
  /** `resolver`, named after its procedure and carrying it. */
  nameAfter: <Resolver extends (...params: never[]) => unknown>(
    resolver: Resolver,
    procedure: IProcedure
  ) => Resolver & IProcedure;
  trace: IServiceTrace<Handle>;
}

/** The resolvers a manager registers: one per procedure, its callback given. */
export interface IServiceResolver<Handle extends string> {
  /**
   * The resolver of `procedure`, for the router to register: its admission on a request's header,
   * its payload decoded, its callback run with its signal, its one answer, each step traced.
   */
  createResolver: <RequestPayload, ResponsePayload, Failure extends ResolverFailure>(
    procedure: IProcedure,
    options: {
      callback: NotificationResolverCallback<RequestPayload, ResponsePayload, Failure, Handle>;
      dependencies: IRequestResolverDependencies<RequestPayload, ResponsePayload, Handle>;
      type: Exclude<DebugType, 'notification'>;
    }
  ) => IRequestResolver<Handle>;
}

// helpers

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

// definition

/**
 * The resolver side of one service manager over `router`: each resolver it makes admits, decodes,
 * runs its callback and answers once, a refusal or a failure answered in its place.
 */
export const createServiceResolver = <Handle extends string>(
  router: IRouterLike<Handle>,
  { nameAfter, trace: serviceTrace }: IServiceResolverOptions<Handle>
): IServiceResolver<Handle> => {
  const { isDebugging, startedNow, trace } = serviceTrace;
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
    const { beforeRequest, failFast = false, serializer, validate } = dependencies;

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

      // * a payload that reads is judged by its rules before the callback: a refusal is the
      // protocol's, PAYLOAD_INVALID, answered here as PAYLOAD_UNDECODABLE is (spec 18.2)
      if (validate !== undefined) {
        const maximumBytes = detailBoundOf(router.limits);
        let judged: IJudged;

        try {
          judged = validate(requestPayload, { failFast, maximumBytes });
        } catch (reason) {
          // a rule that fails to judge is its side's own error, answered as a resolver's that
          // throws, and why goes on for the router to report
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

          throw reason;
        }

        if (isRefused(judged)) {
          const failure = {
            ...router.failures.payloadInvalid,
            detail: violationsDetailOf(judged, { maximumBytes }),
          };

          if (started !== undefined) {
            trace(procedure, {
              callId: header.callId,
              connectionHandle,
              direction: 'tx',
              isAnswered: true,
              rx: requestPayload,
              started,
              tx: failure,
              type,
            });
          }

          return router.respond({ failure }, target);
        }
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

        // a request its router answered in its place takes this answer nowhere: its step is told
        // once, with the failure its router answered, and nothing failed here
        const answered = router.answeredOf(target);
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
          trace(
            procedure,
            answered === undefined
              ? step
              : {
                  ...step,
                  error: new FailureError(answered, {
                    header: { callId: header.callId, kind: EnvelopeKind.FAILURE },
                  }),
                }
          );
        }

        if (answered !== undefined) {
          return;
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

  return { createResolver };
};
