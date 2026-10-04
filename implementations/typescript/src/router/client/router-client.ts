// ── Router client ─────────────────────────────────────────────────────────────

// dependencies

import { clockOf } from '../../transport/shared/clock';
import { createEmitter } from '../../transport/shared/emitter';
import { ProgrammerError, toError } from '../../transport/shared/errors';
import { createEventMethods } from '../../transport/shared/lifecycle';
import { CLOSE_EVENT, MESSAGE_EVENT, RECONNECT_EVENT } from '../../transport/shared/constants';
import type { ITransportMessage } from '../../transport/shared/types';
import { connectionSessionOf, presentedCredentialOf } from '../shared/call-session';
import { CLIENT_FAILURES, CredentialScheme, EnvelopeKind } from '../shared/constants';
import { FailureError } from '../shared/errors';
import { createProcedureMap } from '../shared/procedure-map';
import { createRouterCore } from '../shared/router-core';
import type { CallId, Credential, INotificationLike, SessionToken } from '../shared/types';
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
  DestinationId,
  EnvelopeHeader,
  FailureOrigin,
  ICancelHeader,
  IChunkHeader,
  ICreditHeader,
  IDebugFilter,
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
  SessionToken,
} from '../shared/types';
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
 * A notification bound to the call that subscribed it, how long that call was given, and its pacing
 * when it asked for one.
 */
interface IBoundNotification {
  callId: CallId;
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
  // the notification registered for each procedure, until it is unregistered or dropped
  const notifications = createProcedureMap<INotificationLike>();
  // each subscription by the call id that opened it, and each notification's call id
  const subscriptions = new Map<CallId, IBoundNotification>();
  const callIds = new Map<INotificationLike, CallId>();

  let sessionToken: SessionToken | undefined;

  // an error nobody waits on still has somewhere to go, when someone listens
  const report = (error: Error): void => {
    emitter.emit('error', error);
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

        const { notification } = subscription;
        const call = unbind(notification);

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
      send: (bytes) => {
        return transport.send({ data: bytes });
      },
      // a command runs in the session this client learned, as a request runs in its connection's
      sessionOf: ({ header }) => {
        return connectionSessionOf(header.credential, { token: sessionToken });
      },
      trace: (direction, { header }) => {
        if (emitter.listenerCount('debug') > 0) {
          emitter.emit('debug', { direction, header });
        }
      },
    },
    { clock, limits: options?.limits }
  );

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

  // the server forgets a connection's subscriptions with it: so does the client, and tells each
  const dropNotifications = (): void => {
    const dropped = [...notifications.values()];

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

  // what a transport carried beside the envelope is the server's, and no client's to read
  const onMessage = ({ data }: ITransportMessage): void => {
    core.receive(data, SERVER_CONNECTION_HANDLE);
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

    hasNotification: (notification) => {
      return notifications.get(notification) === notification;
    },
    notify: () => {
      return Promise.reject(
        new ProgrammerError('only a server notifies; a client asks with a request')
      );
    },
    registerNotification: (notification) => {
      if (notifications.has(notification)) {
        return Promise.reject(
          new ProgrammerError(`${notification.procedureName} is already a registered notification`)
        );
      }

      notifications.set(notification, notification);

      return Promise.resolve();
    },
    registerResolver: (resolver) => {
      core.registerResolver(resolver);
    },
    request: (payload, { onSent, options, procedure, subscribes }) => {
      const connectionHandle = SERVER_CONNECTION_HANDLE;
      let credential: Credential | undefined;

      // OPAQUE, the session this client learned, as its answers announced it
      try {
        credential = presentedCredentialOf(options.credential, {
          failures: CLIENT_FAILURES,
          token: sessionToken,
        });
      } catch (reason) {
        return Promise.reject(toError(reason));
      }

      if (subscribes === undefined) {
        return core.request(payload, { connectionHandle, credential, onSent, options, procedure });
      }

      // only the notification held for the procedure is bound, or its notifications would reach
      // none that is listening
      if (notifications.get(procedure) !== subscribes) {
        return Promise.reject(
          new ProgrammerError(
            `${subscribes.procedureName} is not the notification this router holds for ${procedure.procedureName}`
          )
        );
      }

      const { onCallId, release } = bindingOf(subscribes, options.timeout);

      return core
        .request(payload, {
          connectionHandle,
          credential,
          onCallId,
          onSent,
          opensSubscription: true,
          options,
          paced: subscribes.window !== undefined,
          procedure,
        })
        .then(
          (result) => {
            // the server paces nothing before its answer: the window opens once it came, unless
            // the server ended the subscription since
            renew(subscriptions.get(result.header.callId));

            return result;
          },
          (reason: unknown) => {
            release();

            throw reason;
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
