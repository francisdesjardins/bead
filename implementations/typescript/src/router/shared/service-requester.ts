// ── Service requester ─────────────────────────────────────────────────────────

// dependencies

import { assertHeld } from '../../transport/shared/clock';
import { TimeoutError, toError } from '../../transport/shared/errors';
import { FailureError } from './errors';
import { type IServiceTrace, tracedCallOf, tracedFailureOf } from './service-trace';
import type {
  CallId,
  DebugType,
  INotificationLike,
  IProcedure,
  IRequestDependencies,
  IRequestOptions,
  IResolvedRequestOptions,
  IRouterLike,
  IRouterResult,
} from './types';
import { detailBoundOf, isRefused, violationsDetailOf } from './violations';

// interfaces

/**
 * What a requester is handed by its manager: the defaults a call falls back on, the close on
 * timeout, the trace, what raises `deprecated`, and how a procedure is named and copied.
 */
export interface IServiceRequesterOptions<Handle extends string> {
  closeConnection: ((connectionHandle: Handle) => void) | undefined;
  defaults: RequestDefaults;
  deprecated: (procedure: IProcedure) => void;
  /** `resolver`, named after its procedure and carrying it. */
  nameAfter: <Resolver extends (...params: never[]) => unknown>(
    resolver: Resolver,
    procedure: IProcedure
  ) => Resolver & IProcedure;
  /** The procedure alone, without whatever else the object carries. */
  procedureOf: (given: IProcedure) => IProcedure;
  trace: IServiceTrace<Handle>;
}

/**
 * The calls a manager makes: the body `getRequest`, `getCommand` and a notification's subscribing
 * call share, each returning its call id with its payload, and a request named after its procedure,
 * returning its payload alone.
 */
export interface IServiceRequester<Handle extends string> {
  /**
   * The call `procedure` makes, declared to the router as it is made; `subscribes` names the
   * notification it subscribes.
   */
  callOf: <RequestPayload, ResponsePayload>(
    procedure: IProcedure,
    options: {
      dependencies: IRequestDependencies<RequestPayload, ResponsePayload>;
      subscribes?: (() => INotificationLike) | undefined;
      type: Exclude<DebugType, 'notification'>;
    }
  ) => (
    requestPayload: RequestPayload
  ) => (options?: IRequestOptions<Handle>) => Promise<{ callId: CallId; payload: ResponsePayload }>;
  /** The request `procedure` makes, named after it and carrying it. */
  requestOf: <RequestPayload, ResponsePayload>(
    procedure: IProcedure,
    options: {
      dependencies: IRequestDependencies<RequestPayload, ResponsePayload>;
      type: Exclude<DebugType, 'notification'>;
    }
  ) => ((
    requestPayload: RequestPayload
  ) => (options?: IRequestOptions<Handle>) => Promise<ResponsePayload>) &
    IProcedure;
}

// types

export type REQUEST_DEFAULTS = typeof REQUEST_DEFAULTS;

/** What a call falls back on where its options say nothing: a timeout, and a close on timeout. */
export type RequestDefaults = Pick<IResolvedRequestOptions, 'closeOnTimeout' | 'timeout'>;

// constants

export const REQUEST_DEFAULTS = Object.freeze({
  timeout: 5_000,
});

// the payload of a call its rules refuse, which goes nowhere
const NOTHING = new Uint8Array(0);

// helpers

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

// definition

/**
 * The requester of one service manager over `router`: each call its options resolved against the
 * defaults, its value written, traced, `deprecated` raised, its answer decoded, and its connection
 * closed on a timeout where the call or the manager says so.
 */
export const createServiceRequester = <Handle extends string>(
  router: IRouterLike<Handle>,
  {
    closeConnection,
    defaults,
    deprecated,
    nameAfter,
    procedureOf,
    trace: serviceTrace,
  }: IServiceRequesterOptions<Handle>
): IServiceRequester<Handle> => {
  const { isDebugging, startedNow, trace } = serviceTrace;
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
    const { failFast = false, serializer, validate } = dependencies;
    const { deprecation } = procedure;
    const series = router.declareRequester(procedure);
    // * judged before it is written: PAYLOAD_INVALID, its detail under this side's bound, as a call
    // refused before it goes is, counted and traced by its router (spec 18.2)
    const refusalOf = (
      requestPayload: RequestPayload,
      destinationId: IResolvedRequestOptions['destinationId']
    ): FailureError | undefined => {
      if (validate === undefined) {
        return undefined;
      }

      const maximumBytes = detailBoundOf(router.limits);
      const judged = validate(requestPayload, { failFast, maximumBytes });

      if (!isRefused(judged)) {
        return undefined;
      }

      const { procedureId, serviceId } = procedure;

      return new FailureError(
        {
          ...router.failures.payloadInvalid,
          detail: violationsDetailOf(judged, { maximumBytes }),
        },
        { destinationId, procedureAddress: { procedureId, serviceId } }
      );
    };

    return (requestPayload: RequestPayload) => {
      return async (
        options?: IRequestOptions<Handle>
      ): Promise<{ callId: CallId; payload: ResponsePayload }> => {
        const resolvedOptions = resolveRequestOptions(defaults, options);
        const { closeOnTimeout, destinationId } = resolvedOptions;
        const connectionHandle = options?.connectionHandle;
        const refusal = refusalOf(requestPayload, destinationId);
        const encoded = refusal === undefined ? serializer.encode(requestPayload) : NOTHING;
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
          deprecated(procedureOf(procedure));
        }

        const requested = router.request(encoded, {
          onCallId: traced?.onCallId,
          options: resolvedOptions,
          procedure: procedureOf(procedure),
          refusal,
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

  return { callOf, requestOf };
};
