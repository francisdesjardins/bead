// ── Router client ─────────────────────────────────────────────────────────────

// dependencies

import { clockOf } from '../../transport/shared/clock';
import { createEmitter } from '../../transport/shared/emitter';
import { ProgrammerError, toError } from '../../transport/shared/errors';
import { createEventMethods } from '../../transport/shared/lifecycle';
import { CLOSE_EVENT, MESSAGE_EVENT, RECONNECT_EVENT } from '../../transport/shared/constants';
import type { ITransportMessage } from '../../transport/shared/types';
import { connectionSessionOf, presentedCredentialOf, uncarriedOf } from '../shared/call-session';
import { CLIENT_FAILURES, CredentialScheme, EnvelopeKind } from '../shared/constants';
import { assertLimitsHoldJwt, createCredentialResolver } from '../shared/credentials';
import { FailureError } from '../shared/errors';
import { checkDeclaration } from '../shared/identity';
import type { IHearingSeries } from '../shared/metrics-registry';
import { createProcedureMap } from '../shared/procedure-map';
import { createRouterCore } from '../shared/router-core';
import type {
  CallId,
  DefaultCredential,
  INotificationLike,
  IRouterLimits,
  SessionToken,
} from '../shared/types';
import type {
  IRouterClient,
  IRouterClientOptions,
  IRouterClientTransportLike,
  RouterClientConnectionHandle,
  RouterClientEventMap,
} from './types';

export {
  CLIENT_FAILURES,
  CredentialScheme,
  EnvelopeKind,
  FailureScope,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../shared/constants';
export { filterEnvelopeDebug, parseDebugFilter } from '../shared/debug-filter';
export {
  createMetricsRegistry,
  METRICS_CONTENT_TYPE,
  METRICS_REGISTRY_DEFAULTS,
} from '../shared/metrics-registry';
export type {
  IMetricsExposition,
  IMetricsRegistry,
  IMetricsRegistryOptions,
  IProcedureSeries,
} from '../shared/metrics-registry';
export { DisconnectError, FailureError } from '../shared/errors';
export { LONGEST_TIMER, PLATFORM_CLOCK } from '../../transport/shared/clock';
export type { IClock, TimeoutId } from '../../transport/shared/clock';
export {
  CancelError,
  GenericError,
  ProgrammerError,
  TimeoutError,
} from '../../transport/shared/errors';
export type {
  Announcement,
  CallId,
  Credential,
  DebugFilterSource,
  DefaultCredential,
  DestinationId,
  EnvelopeHeader,
  FailureOrigin,
  ICancelHeader,
  IChunkHeader,
  ICreditHeader,
  ICredentials,
  IDebugFilter,
  IElsewhereSession,
  IFailure,
  IFailureHeader,
  INotificationHeader,
  IProtocolFailure,
  IRequestHeader,
  IResultHeader,
  ICallSession,
  IRouterResult,
  IRouterFailures,
  IRouterLimits,
  RedactedHeader,
  RequestCredential,
  RouterLimitsOptions,
  RouterSide,
  SessionIdentifier,
  SessionToken,
} from '../shared/types';
export type { IJwtKey, Jwk, JwtAlgorithm } from '../shared/jwt-verifier';
export type {
  IRouterClient,
  IRouterClientOptions,
  IRouterClientTransportLike,
  IRouterDebugInfo,
  ROUTER_CLIENT_EVENTS,
  RouterClientActivity,
  RouterClientConnectionHandle,
  RouterClientEventMap,
} from './types';

// interfaces

/**
 * A notification bound to the call that subscribed it, how long that call was given, its pacing
 * when it asked for one, whether its answer came, and the series it counts into, when counted.
 */
interface IBoundNotification {
  callId: CallId;
  hearing: IHearingSeries | undefined;
  isAnswered: boolean;
  notification: INotificationLike;
  pacing: IClientPacing | undefined;
  timeout: number;
}

/**
 * A paced subscription, as its client counts it: the notifications credited, those whose callbacks
 * settled, and how many may be under way.
 */
interface IClientPacing {
  creditEnd: number;
  settled: number;
  readonly window: number;
}

// constants

/** The one peer a client has: every request reaching it comes from the server. */
export const SERVER_CONNECTION_HANDLE: RouterClientConnectionHandle = 'server';

// helpers

/**
 * `credential` as a default a client presents: a `JWT` or an `ELSEWHERE`, frozen, or none; `OPAQUE`,
 * which a call asks for alone, or any other, is a {@link ProgrammerError}, and so is a `JWT` past
 * what `limits` hold (spec 12.2).
 */
const defaultCredentialOf = (
  credential: DefaultCredential | undefined,
  limits: IRouterLimits
): DefaultCredential | undefined => {
  if (credential === undefined) {
    return undefined;
  }

  const { scheme } = credential as { scheme: unknown };

  if (scheme !== CredentialScheme.JWT && scheme !== CredentialScheme.ELSEWHERE) {
    throw new ProgrammerError(
      `a client presents a JWT or an ELSEWHERE by default, never scheme ${String(scheme)}: OPAQUE goes on a call that asks for it`
    );
  }

  // what it presents is checked as a call presents it, before anything is kept
  presentedCredentialOf(credential, { failures: CLIENT_FAILURES, token: undefined });

  if (scheme === CredentialScheme.JWT) {
    assertLimitsHoldJwt(limits);
  }

  return Object.freeze({ ...credential });
};

/** Whether two defaults are one credential: the same scheme, and the same token or value carried. */
const isSameCredential = (first: DefaultCredential, second: DefaultCredential): boolean => {
  return first.scheme === CredentialScheme.JWT
    ? second.scheme === CredentialScheme.JWT && first.token === second.token
    : second.scheme === CredentialScheme.ELSEWHERE && first.carried === second.carried;
};

// definition

/**
 * The client side of a router, over any transport that meets {@link IRouterClientTransportLike};
 * the transport must deliver binary as `'arraybuffer'` or `'nodebuffer'`. The request itself — its
 * call id, its pairing, its timeout and its cancel — is the core's: this router binds the
 * notifications, and learns the session.
 *
 * Requests are paired with their results and failures by call id; the server's own requests go to
 * the resolvers registered, by service and procedure, and its notifications to the notification
 * whose subscription opened their call. What no call waits on is reported as `error`.
 *
 * It runs on its transport's clock, and on the one its options give when its transport has none: a
 * clock given that differs from its transport's is a {@link ProgrammerError}.
 *
 * @example
 * import { createRouterClient } from '@francisdesjardins/bead/router-client';
 * import { createWSTransportClient } from '@francisdesjardins/bead/ws-transport-client';
 *
 * const router = createRouterClient(createWSTransportClient());
 *
 * router.on('error', (error) => {
 *   console.error(error);
 * });
 * void router.transport.connect({ host, port });
 */
export const createRouterClient = <Transport extends IRouterClientTransportLike>(
  transport: Transport,
  options?: IRouterClientOptions
): IRouterClient<Transport> => {
  const clock = clockOf(
    { beneath: transport.clock, given: options?.clock },
    { below: 'its transport', layer: "a client's router" }
  );
  const emitter = createEmitter<RouterClientEventMap>();
  // what it counts its calls and notifications through, attached to the registry it was given
  const metrics = options?.metricsRegistry?.attach('client');
  // the notification registered for each procedure, until it is unregistered or dropped
  const notifications = createProcedureMap<INotificationLike>();
  // the series each notification registered counts into, declared as it was registered
  const hearings = new WeakMap<INotificationLike, IHearingSeries>();
  // each subscription by the call id that opened it, and each notification's call id
  const subscriptions = new Map<CallId, IBoundNotification>();
  const callIds = new Map<INotificationLike, CallId>();

  // what resolves a command's JWT or ELSEWHERE, on the router's clock
  const credentials = createCredentialResolver(options?.credentials, { clock });

  let sessionToken: SessionToken | undefined;

  // an error nobody waits on still has somewhere to go, when someone listens
  const report = (error: Error): void => {
    emitter.emit('error', error);
  };
  // what a debug listener throws is reported, and the envelope goes on as if nobody listened
  const reportThrown = (error: unknown): void => {
    report(toError(error));
  };

  // a paced subscription credits as far as its window reaches past what settled, once that is half
  // a window past its credit, as a transfer's credit is renewed; one unbound meanwhile credits
  // nothing
  const renew = (subscription: IBoundNotification | undefined): void => {
    if (
      subscription?.pacing === undefined ||
      subscriptions.get(subscription.callId) !== subscription
    ) {
      return;
    }

    const { callId, pacing } = subscription;
    const creditEnd = pacing.settled + pacing.window;

    if (creditEnd - pacing.creditEnd < pacing.window / 2) {
      return;
    }

    pacing.creditEnd = creditEnd;
    core
      .send(
        {
          header: { callId, creditEnd, kind: EnvelopeKind.CREDIT, paced: true },
          kind: EnvelopeKind.CREDIT,
        },
        SERVER_CONNECTION_HANDLE
      )
      .catch((reason: unknown) => {
        report(toError(reason));
      });
  };

  // a notification's callbacks, settled: what each rejected with is reported, and a paced
  // subscription counts it done
  const settle = async (
    subscription: IBoundNotification,
    settling: Promise<PromiseSettledResult<unknown>[]>
  ): Promise<void> => {
    for (const settled of await settling) {
      if (settled.status === 'rejected') {
        report(toError(settled.reason));
      }
    }

    if (subscription.pacing !== undefined) {
      subscription.pacing.settled += 1;
      renew(subscription);
    }
  };

  // unbinds the call a notification is bound to, and gives it: its call id, and how long it was
  // given, for as long as the call id stays reserved
  const unbind = (
    notification: INotificationLike
  ):
    | { callId: CallId; connectionHandle: RouterClientConnectionHandle; timeout: number }
    | undefined => {
    const callId = callIds.get(notification);
    const subscription = callId === undefined ? undefined : subscriptions.get(callId);

    if (callId === undefined || subscription === undefined) {
      return undefined;
    }

    callIds.delete(notification);
    subscriptions.delete(callId);

    return { callId, connectionHandle: SERVER_CONNECTION_HANDLE, timeout: subscription.timeout };
  };

  const core = createRouterCore<RouterClientConnectionHandle>(
    {
      credentialSchemes: credentials.schemes,
      failures: CLIENT_FAILURES,

      activity: (activity) => {
        emitter.emit('activity', activity);
      },
      isCallIdInUse: (callId) => {
        return subscriptions.has(callId);
      },
      onNotification: (header, { payload }) => {
        const subscription = subscriptions.get(header.callId);

        if (subscription === undefined) {
          const detail = `no subscription under call ${String(header.callId)}`;
          const unknown = new FailureError(
            { ...CLIENT_FAILURES.subscriptionUnknown, detail },
            { header }
          );

          return (report(unknown), undefined);
        }

        // heard as it is paired with its subscription, whether it decodes or not
        subscription.hearing?.heard();

        // a callback that throws is reported, and the notifications after it still arrive: a paced
        // subscription counts it done
        try {
          void settle(subscription, subscription.notification.trigger(payload));
        } catch (reason) {
          report(toError(reason));

          return (void settle(subscription, Promise.resolve([])), undefined);
        }

        return (emitter.emit('activity', 'notification'), undefined);
      },
      // a failure after its result ends a subscription the server ended — its session ended, say:
      // the notification is dropped here too, and told, so the next registration asks anew
      onUnpairedFailure: ({ failure, header }) => {
        const subscription = subscriptions.get(header.callId);

        if (subscription === undefined) {
          return false;
        }

        const { hearing, isAnswered, notification } = subscription;
        const call = unbind(notification);

        // * dropped at this end once answered; one refused in its own answer is its call's failure
        if (isAnswered) {
          hearing?.dropped(failure);
        }

        if (notifications.get(notification) === notification) {
          notifications.delete(notification);
        }

        // the server ended it: nothing is left there to cancel, and what was on its way is dropped in
        // silence
        if (call !== undefined) {
          core.reserve(call);
        }

        try {
          notification.drop?.(failure);
        } catch (reason) {
          report(toError(reason));
        }

        return true;
      },
      // the session is the server's to give: an answer announces it when it changes, and carries
      // none otherwise
      onAnswerReceived: ({ credential }) => {
        if (credential !== undefined) {
          sessionToken =
            credential.scheme === CredentialScheme.OPAQUE ? credential.token : undefined;
        }
      },
      report,
      send: (message) => {
        return transport.send(message);
      },
      // a command runs in the session this client learned, as a request runs in its connection's;
      // one presenting a JWT or an ELSEWHERE, in the credential's session it resolves to
      sessionOf: ({ header, transportCredential }, signal) => {
        const { credential } = header;

        return credential?.scheme === CredentialScheme.JWT ||
          credential?.scheme === CredentialScheme.ELSEWHERE
          ? credentials.resolve({ credential, transportCredential }, signal)
          : connectionSessionOf(credential, { token: sessionToken });
      },
      isTracing: () => {
        return emitter.listenerCount('debug') > 0;
      },
      trace: (direction, { header }) => {
        emitter.emitEach('debug', {
          onError: reportThrown,
          params: [{ connectionHandle: SERVER_CONNECTION_HANDLE, direction, header }],
        });
      },
    },
    { clock, limits: options?.limits, metrics }
  );

  // a router that takes a JWT holds its header: its limits hold 1,024 bytes at least
  if (credentials.takesJwt) {
    assertLimitsHoldJwt(core.limits);
  }

  // the credential every call presents but one that gives its own, or none, until withdrawn
  let defaultCredential = defaultCredentialOf(options?.credential, core.limits);

  // binds the calls of a subscription as their call ids are drawn: before the request goes out, so
  // a notification right behind its result is heard — paced, when the notification has a window, its
  // first credited by asking; `release` unbinds a call that did not take
  const bindingOf = (notification: INotificationLike, timeout: number) => {
    let bound: CallId | undefined;

    return {
      onCallId: (callId: CallId) => {
        // the call it was bound to before is cancelled, so the server holds it no longer
        const previous = unbind(notification);

        if (previous !== undefined) {
          core.cancel(previous);
        }

        subscriptions.set(callId, {
          callId,
          hearing: hearings.get(notification),
          isAnswered: false,
          notification,
          pacing:
            notification.window === undefined
              ? undefined
              : { creditEnd: 1, settled: 0, window: notification.window },
          timeout,
        });
        callIds.set(notification, callId);
        bound = callId;
      },
      // a subscription that did not take holds nothing, whatever ended it
      release: () => {
        if (bound !== undefined && callIds.get(notification) === bound) {
          unbind(notification);
        }
      },
    };
  };

  // the server forgets a connection's subscriptions with it: so does the client, and tells each,
  // counting each answered dropped with no code
  const dropNotifications = (): void => {
    const dropped = [...notifications.values()];

    for (const { hearing, isAnswered } of subscriptions.values()) {
      if (isAnswered) {
        hearing?.dropped(undefined);
      }
    }

    // emptied first, so what a drop registers again is the next connection's
    notifications.clear();
    subscriptions.clear();
    callIds.clear();

    for (const notification of dropped) {
      try {
        notification.drop?.();
      } catch (reason) {
        report(toError(reason));
      }
    }
  };

  // what a transport carried beside the envelope goes with it: a command presenting ELSEWHERE
  // stands for it
  const onMessage = (message: ITransportMessage): void => {
    core.receive(message, SERVER_CONNECTION_HANDLE);
  };

  // a call that presented the default, refused SESSION_REQUIRED through relays or not, withdraws it
  // while it is still that credential by value, set again or not: later calls present none by
  // default, and the application hears of it by its scheme alone
  const withdraw = (reason: unknown, presented: DefaultCredential | undefined): void => {
    if (
      presented !== undefined &&
      defaultCredential !== undefined &&
      isSameCredential(presented, defaultCredential) &&
      reason instanceof FailureError &&
      reason.origin !== 'local' &&
      reason.isProtocol(CLIENT_FAILURES.sessionRequired.code)
    ) {
      defaultCredential = undefined;
      emitter.emit('credentialWithdrawn', presented.scheme);
    }
  };

  const onClose = (): void => {
    sessionToken = undefined;
    core.rejectPending('the connection closed before the answer');
    dropNotifications();
  };

  // a connection replaced emits no close, but nothing sent on it will be answered either
  const onReconnect = (): void => {
    sessionToken = undefined;
    core.rejectPending('the connection was replaced before the answer');
    dropNotifications();
  };

  const router: IRouterClient<Transport> = {
    ...createEventMethods(emitter, () => {
      return router;
    }),

    get clock() {
      return clock;
    },
    get credential() {
      return defaultCredential;
    },
    set credential(credential) {
      defaultCredential = defaultCredentialOf(credential, core.limits);
    },
    get failures() {
      return CLIENT_FAILURES;
    },
    get limits() {
      return core.limits;
    },
    get sessionToken() {
      return sessionToken;
    },
    get transport() {
      return transport;
    },

    declareRequester: (procedure) => {
      checkDeclaration(procedure);

      return metrics?.declareRequester(procedure);
    },
    hasNotification: (notification) => {
      return notifications.get(notification) === notification;
    },
    notify: () => {
      return Promise.reject(
        new ProgrammerError('only a server notifies; a client asks with a request')
      );
    },
    registerNotification: (notification) => {
      // * spec 16.10: its identity first, before the router's reasons and its registry's
      try {
        checkDeclaration(notification);
      } catch (reason) {
        return Promise.reject(toError(reason));
      }

      if (notifications.has(notification)) {
        return Promise.reject(
          new ProgrammerError(`${notification.procedureName} is already a registered notification`)
        );
      }

      // declared as it is registered: one the registry refuses is not registered either
      try {
        const hearing = metrics?.declareNotification(notification);

        if (hearing !== undefined) {
          hearings.set(notification, hearing);
        }
      } catch (reason) {
        return Promise.reject(toError(reason));
      }

      notifications.set(notification, notification);

      return Promise.resolve();
    },
    registerResolver: (resolver) => {
      core.registerResolver(resolver);
    },
    report,
    request: (payload, { onSent, options, procedure, series, subscribes }) => {
      const connectionHandle = SERVER_CONNECTION_HANDLE;

      // ! a programmer's error first, before the call starts, so it is never counted: only the
      // notification held for the procedure is bound, or its notifications would reach none that
      // is listening
      if (subscribes !== undefined && notifications.get(procedure) !== subscribes) {
        return Promise.reject(
          new ProgrammerError(
            `${subscribes.procedureName} is not the notification this router holds for ${procedure.procedureName}`
          )
        );
      }

      // the call's own credential, or the default, as it is now
      const presentedDefault = options.credential === undefined ? defaultCredential : undefined;
      let presented: ReturnType<typeof presentedCredentialOf> = {};
      let refusal: Error | undefined;

      // OPAQUE, the session this client learned, as its answers announced it; a JWT, or an
      // ELSEWHERE beside it. A credential asked of the wrong shape is a programmer's error; OPAQUE
      // with no session known refuses the call once it started
      try {
        presented = presentedCredentialOf(options.credential ?? presentedDefault, {
          failures: CLIENT_FAILURES,
          token: sessionToken,
        });
      } catch (reason) {
        if (!(reason instanceof FailureError)) {
          return Promise.reject(toError(reason));
        }

        refusal = reason;
      }

      const { carried, credential } = presented;
      // a credential its transport cannot carry fails the call before it goes: nothing was tried,
      // and the default stays
      const uncarried = uncarriedOf(credential, {
        carriesCredential: transport.carriesCredential === true,
        failures: CLIENT_FAILURES,
        isSecure: transport.isSecure === true,
      });

      if (refusal === undefined && uncarried !== undefined) {
        const { destinationId } = options;
        const { procedureId, serviceId } = procedure;

        refusal = new FailureError(uncarried, {
          destinationId,
          procedureAddress: { procedureId, serviceId },
        });
      }

      const sent = { connectionHandle, credential, onSent, options, procedure, refusal, series };
      const withdrawing = (reason: unknown): never => {
        withdraw(reason, presentedDefault);

        throw reason;
      };

      if (subscribes === undefined) {
        return core.request(payload, { ...sent, transportCredential: carried }).catch(withdrawing);
      }

      const { onCallId, release } = bindingOf(subscribes, options.timeout);

      return core
        .request(payload, {
          ...sent,
          onCallId,
          opensSubscription: true,
          paced: subscribes.window !== undefined,
          transportCredential: carried,
        })
        .then(
          (result) => {
            const subscription = subscriptions.get(result.header.callId);

            // answered, it is a subscription: what ends it now drops it
            if (subscription !== undefined) {
              subscription.isAnswered = true;
            }

            // the server paces nothing before its answer: the window opens once it came, unless
            // the server ended the subscription since
            renew(subscription);

            return result;
          },
          (reason: unknown) => {
            release();

            return withdrawing(reason);
          }
        );
    },
    respond: (response, { header }) => {
      return core.respond(response, { connectionHandle: SERVER_CONNECTION_HANDLE, header });
    },
    subscribe: () => {
      throw new ProgrammerError(
        'only a server subscribes a connection; a client asks with a request'
      );
    },
    unregisterNotification: (notification, options) => {
      // another's of the same procedure stays: only what registered takes itself away
      if (notifications.get(notification) !== notification) {
        return Promise.resolve();
      }

      notifications.delete(notification);

      const call = unbind(notification);

      // the server is told unless it ended it already; either way, what was on its way is dropped
      // in silence
      if (call !== undefined && options?.cancel === false) {
        core.reserve(call);
      } else if (call !== undefined) {
        core.cancel(call);
      }

      return Promise.resolve();
    },
    [Symbol.dispose]: () => {
      transport.off(MESSAGE_EVENT, onMessage);
      transport.off(CLOSE_EVENT, onClose);
      transport.off(RECONNECT_EVENT, onReconnect);
      sessionToken = undefined;
      core[Symbol.dispose]();
      dropNotifications();
    },
  };

  transport.on(MESSAGE_EVENT, onMessage);
  transport.on(CLOSE_EVENT, onClose);
  transport.on(RECONNECT_EVENT, onReconnect);

  return router;
};
