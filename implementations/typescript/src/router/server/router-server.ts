// ── Router server ─────────────────────────────────────────────────────────────

// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { createEmitter } from '../../transport/shared/emitter';
import { CancelError, ProgrammerError, toError } from '../../transport/shared/errors';
import { CLOSE_EVENT, CONNECTION_EVENT, MESSAGE_EVENT } from '../../transport/shared/constants';
import { gaugesOf, mergeGauges } from '../../transport/shared/gauges';
import { createEventMethods } from '../../transport/shared/lifecycle';
import type { Data } from '../../transport/shared/types';
import { EnvelopeKind, SERVER_FAILURES } from '../shared/constants';
import { DisconnectError } from '../shared/errors';
import { createRouterCore } from '../shared/router-core';
import type { ICallAddress, IFailure, IRequestHeader } from '../shared/types';
import { createNotificationManager } from './notification-manager';
import { createRelay } from './relay';
import { createSubscriptionPlaces } from './subscription-places';
import type {
  IPacing,
  IRouterServer,
  IRouterServerOptions,
  IRouterServerTransportLike,
  RouterServerEventMap,
} from './types';

export {
  CLIENT_FAILURES,
  EnvelopeKind,
  FailureScope,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../shared/constants';
export { PACING_DEFAULTS } from './notification-pacing';
export { filterEnvelopeDebug, parseDebugFilter } from '../shared/debug-filter';
export { DisconnectError, FailureError } from '../shared/errors';
export {
  CancelError,
  GenericError,
  ProgrammerError,
  TimeoutError,
} from '../../transport/shared/errors';
export type { TransportServerConnectionHandle } from '../../transport/server/types';
export type {
  AdmissionFailure,
  CallId,
  DebugFilterSource,
  DestinationId,
  EnvelopeHeader,
  FailureOrigin,
  IAdmissionRequest,
  IBeforeRequest,
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
  IRouterResult,
  IRouterFailures,
  IRouterLimits,
  NotificationKey,
  RedactedHeader,
  RouterLimitsOptions,
  RouterSide,
  SessionToken,
} from '../shared/types';
export type {
  IConnectionTarget,
  IDestination,
  IDestinationOptions,
  IDestinationRegistration,
  IPacingLimits,
  IRelayOptions,
  IRouterServer,
  IRouterServerDebugInfo,
  IRouterServerOptions,
  IRouterServerTransportLike,
  PacingLimitsOptions,
  RelayTarget,
  ROUTER_SERVER_EVENTS,
  RouterServerActivity,
  RouterServerEventMap,
} from './types';

// types

/** A call of a connection's. */
type ServerCall = ICallAddress<TransportServerConnectionHandle>;

// definition

/**
 * The server side of a router, over any transport server that meets
 * {@link IRouterServerTransportLike}; build it before the transport starts, so it sees every
 * connection.
 *
 * A connection's requests go to the resolvers registered, by service and procedure; a request of
 * the router's own goes to the connection its options name, on an even call id. A notification goes
 * to each connection subscribed, under the call id of the request that subscribed it: a connection
 * subscribes by getting a successful answer from the notification's resolver to a request that
 * opens a subscription, and its first subscription to a procedure is the one it keeps; an ordinary
 * request to that procedure gets its answer, and subscribes nothing. A subscription whose request
 * asked to be paced gets a notification while its client credited one, and queues the others, as
 * `options.pacing` bounds them; past those bounds, it ends with `CAPACITY_EXCEEDED`. A request that
 * names a destination goes on through the relay to the destination registered, as `options.relay`
 * admits it; while none is registered, it is refused: this router relays nothing.
 *
 * @example
 * import { createRouterServer } from '@francisdesjardins/bead/router-server';
 * import { createWSTransportServer } from '@francisdesjardins/bead/ws-transport-server';
 *
 * const router = createRouterServer(createWSTransportServer({ WebSocketServer }));
 *
 * router.on('error', (error, connectionHandle) => {
 *   console.error(connectionHandle, error);
 * });
 * void router.transport.start({ port });
 */
export const createRouterServer = <Transport extends IRouterServerTransportLike>(
  transport: Transport,
  options?: IRouterServerOptions
): IRouterServer<Transport> => {
  const emitter = createEmitter<RouterServerEventMap>();
  const notifications = createNotificationManager({ pacing: options?.pacing });
  // the request of each paced subscription its resolver subscribed in flight, so one whose queue
  // goes past its bounds before the answer is answered with that failure; gone with the pacing
  const requests = new WeakMap<IPacing, IRequestHeader>();
  // the connections this router sends on, by the handle as a string, so a request's option finds
  // the connection it names; a server keeps its own, which hears of each connection first
  const connections = new Map<string, TransportServerConnectionHandle>();
  const places = createSubscriptionPlaces({
    isConnected: (connectionHandle) => {
      return connections.has(connectionHandle);
    },
    notifications,
  });

  const report = (error: Error, connectionHandle: TransportServerConnectionHandle): void => {
    emitter.emit('error', error, connectionHandle);
  };

  const core = createRouterCore<TransportServerConnectionHandle>(
    {
      failures: SERVER_FAILURES,

      activity: (activity, connectionHandle) => {
        emitter.emit('activity', activity, connectionHandle);
      },
      // a request of the peer's on a subscription's call id would answer that subscription
      isCallIdInUse: (callId, connectionHandle) => {
        return notifications.has(callId, connectionHandle);
      },
      // a request that names a destination goes on through the relay
      handlerOfDestination: (destinationId) => {
        return relay.handlerOf(destinationId);
      },
      isTwoWay: (connectionHandle) => {
        return transport.isTwoWay?.(connectionHandle) ?? true;
      },
      beforeAnswer: ({ connectionHandle, header, isFailure, resolver }) => {
        const { callId, procedureId, serviceId } = header;

        return places.settle(
          { callId, connectionHandle, paced: header.paced === true },
          {
            isFailure,
            // a notification's resolver, answering a request that opens a subscription, on a
            // connection still open
            notifies:
              header.opensSubscription === true &&
              resolver !== undefined &&
              'notify' in resolver &&
              connections.has(connectionHandle),
            procedure: { procedureId, serviceId },
          }
        );
      },
      // a cancel takes away what its call subscribed, established or still in flight, on that
      // connection alone
      onCancel: (callId, connectionHandle) => {
        places.cancel({ callId, connectionHandle });
      },
      // a credit lets go what the subscription queued; one for a subscription gone may have crossed
      // its end, and is dropped in silence
      onSubscriptionCredit: ({ callId, creditEnd }, connectionHandle) => {
        const released = notifications.pacingOf(callId, connectionHandle)?.credit(creditEnd) ?? [];

        for (const payload of released) {
          void sendNotification(payload, { callId, connectionHandle });
        }
      },
      report,
      send: (bytes, connectionHandle) => {
        return transport.send(bytes, connectionHandle);
      },
      ...(options?.sessionTokenOf === undefined ? {} : { sessionTokenOf: options.sessionTokenOf }),
      trace: (direction, { connectionHandle, header }) => {
        if (emitter.listenerCount('debug') > 0) {
          emitter.emit('debug', { connectionHandle, direction, header });
        }
      },
    },
    { limits: options?.limits }
  );

  // one notification to one subscription; a connection that cannot take it keeps none of the others
  // from getting theirs
  const sendNotification = async (
    payload: Uint8Array,
    { callId, connectionHandle }: ServerCall
  ): Promise<void> => {
    try {
      await core.send(
        {
          header: { callId, kind: EnvelopeKind.NOTIFICATION },
          kind: EnvelopeKind.NOTIFICATION,
          payload,
        },
        connectionHandle
      );

      emitter.emit('activity', 'notification', connectionHandle);
    } catch (reason) {
      report(toError(reason), connectionHandle);
    }
  };

  // ends an established subscription with `failure` on its call id, forgotten as the failure goes,
  // so no notification follows it
  const endSubscription = async (
    { callId, connectionHandle }: ServerCall,
    failure: IFailure
  ): Promise<void> => {
    const sending = core.send(
      {
        failure,
        header: { callId, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      },
      connectionHandle
    );

    notifications.unregister(callId, connectionHandle);

    try {
      await sending;
    } catch (reason) {
      report(toError(reason), connectionHandle);
    }
  };

  // a subscription that queued past its bounds ends: in flight, its call is answered with the
  // failure, which takes away what it subscribed; established, the failure follows its answer
  const exceed = async (call: ServerCall, pacing: IPacing): Promise<void> => {
    const { callId, connectionHandle } = call;
    const failure = {
      ...SERVER_FAILURES.capacityExceeded,
      detail: `the notifications queued for call ${String(callId)} went past their bounds`,
    };
    const request = requests.get(pacing);

    if (request === undefined || !core.isAnswering({ connectionHandle, header: request })) {
      return endSubscription(call, failure);
    }

    try {
      await core.respond({ failure }, { connectionHandle, header: request });
    } catch (reason) {
      report(toError(reason), connectionHandle);
    }
  };

  const onMessage = (data: Data, connectionHandle: TransportServerConnectionHandle): void => {
    // a connection that speaks is open, even one opened before the router was built
    connections.set(connectionHandle, connectionHandle);
    core.receive(data, connectionHandle);
  };

  const onConnection = (
    ...[, , connectionHandle]: [
      socket: unknown,
      request: unknown,
      connectionHandle: TransportServerConnectionHandle,
    ]
  ): void => {
    connections.set(connectionHandle, connectionHandle);
  };

  const onClose = (_: boolean, connectionHandle: TransportServerConnectionHandle): void => {
    connections.delete(connectionHandle);
    // its destinations stay unreachable, whoever takes its handle next
    relay.closeConnection(connectionHandle);
    places.clear(connectionHandle);
    notifications.clean(connectionHandle);
    core.rejectPending('the connection closed before the answer', connectionHandle);
  };

  // a request of the router's own, to the connection its options name — the relay's leg B, too
  const request: IRouterServer<Transport>['request'] = (
    payload,
    { onSent, options: requestOptions, procedure, subscribes }
  ) => {
    if (subscribes !== undefined) {
      return Promise.reject(
        new ProgrammerError('a server does not subscribe to notifications; it sends them')
      );
    }

    if (requestOptions.connectionHandle === undefined) {
      return Promise.reject(
        new ProgrammerError('a server request names the connection it goes to')
      );
    }

    const connectionHandle = connections.get(requestOptions.connectionHandle);

    if (connectionHandle === undefined) {
      return Promise.reject(
        new DisconnectError(`${requestOptions.connectionHandle} is not an open connection`)
      );
    }

    return core.request(payload, {
      connectionHandle,
      onSent,
      options: requestOptions,
      procedure,
    });
  };

  // the requests that name a destination go on through it; none does until one is registered
  const relay = createRelay({
    failures: SERVER_FAILURES,
    isTwoWay: (connectionHandle) => {
      return transport.isTwoWay?.(connectionHandle) ?? true;
    },
    limits: core.limits,
    options: options?.relay,
    report,
    request,
    respond: (answer, target) => {
      return core.respond(answer, target);
    },
  });

  const router: IRouterServer<Transport> = {
    ...createEventMethods(emitter, () => {
      return router;
    }),

    get failures() {
      return SERVER_FAILURES;
    },
    get limits() {
      return core.limits;
    },
    get notifications() {
      return notifications;
    },
    get transport() {
      return transport;
    },

    destinations: () => {
      return relay.destinations();
    },
    dropSubscriptions: async ({ connectionHandle, failure }) => {
      // each established subscription, and each call waiting, is ended with a failure on its call
      // id; a call still in flight is left to its own answer, so no call is answered twice
      const ending = places.drop(connectionHandle).map((callId) => {
        return endSubscription({ callId, connectionHandle }, failure);
      });

      await Promise.all(ending);
    },
    gauges: () => {
      return mergeGauges([
        gaugesOf({
          connectionHandles: connections.values(),
          counts: { connections: connections.size },
        }),
        core.gauges(),
        places.gauges(),
        notifications.gauges(),
        relay.gauges(),
      ]);
    },
    hasNotification: () => {
      return false;
    },
    notify: async (payload, { filter, key, procedure: { procedureId, serviceId } }) => {
      // who gets it is settled before any is sent: a filter that throws sends it to none
      const targets = notifications
        .candidates({ procedureId, serviceId })
        .entries()
        .filter(([connectionHandle]) => {
          return filter === undefined || filter(connectionHandle);
        })
        .toArray();
      // offered in order, each before the next: a paced subscription sends it, queues it, or ends
      const sending = targets.map(([connectionHandle, callId]) => {
        const call = { callId, connectionHandle };
        const pacing = notifications.pacingOf(callId, connectionHandle);

        if (pacing === undefined) {
          return sendNotification(payload, call);
        }

        switch (pacing.offer({ key, payload })) {
          case 'exceeded':
            return exceed(call, pacing);
          case 'queued':
            return Promise.resolve();
          case 'send':
            return sendNotification(payload, call);
        }
      });

      await Promise.all(sending);
    },
    registerNotification: () => {
      return Promise.reject(
        new ProgrammerError('a server does not subscribe to notifications; it sends them')
      );
    },
    registerDestination: (target, destinationOptions) => {
      return relay.register(target, destinationOptions);
    },
    registerResolver: (resolver) => {
      core.registerResolver(resolver);
    },
    request,
    respond: (response, request) => {
      return core.respond(response, request);
    },
    subscribe: ({ connectionHandle, header }) => {
      const { callId, procedureId, serviceId } = header;

      // its requester asked for an answer alone, and would take the notifications for nothing
      if (header.opensSubscription !== true) {
        throw new ProgrammerError(
          `call ${String(callId)} opens no subscription: an ordinary request to ${String(serviceId)}/${String(procedureId)} subscribes nothing`
        );
      }

      // one that closed would never be cleaned, nor would a call its requester cancelled
      if (!connections.has(connectionHandle)) {
        throw new DisconnectError(`${connectionHandle} is not an open connection`);
      }

      if (!core.isAnswering({ connectionHandle, header })) {
        throw new CancelError(`call ${String(callId)} was cancelled, or answered already`);
      }

      const subscribed = places.subscribe(
        { callId, connectionHandle, paced: header.paced === true },
        { procedureId, serviceId }
      );
      const pacing = notifications.pacingOf(subscribed, connectionHandle);

      // the call took the place, in flight: its request answers it, should its queue go past its
      // bounds before its answer
      if (subscribed === callId && pacing !== undefined) {
        requests.set(pacing, header);
      }

      return subscribed;
    },
    unregisterNotification: () => {
      return Promise.reject(
        new ProgrammerError('a server does not subscribe to notifications; it sends them')
      );
    },
    unsubscribe: (call) => {
      return places.unsubscribe(call);
    },
    [Symbol.dispose]: () => {
      const followed = [...connections.values()];

      transport.off(CLOSE_EVENT, onClose);
      transport.off(CONNECTION_EVENT, onConnection);
      transport.off(MESSAGE_EVENT, onMessage);
      // no connection is followed any more, before any call hears of it: none is asked, subscribed or
      // notified again
      connections.clear();
      places.clear();
      core[Symbol.dispose]();

      for (const connectionHandle of followed) {
        notifications.clean(connectionHandle);
      }
    },
  };

  transport.on(CLOSE_EVENT, onClose);
  transport.on(CONNECTION_EVENT, onConnection);
  transport.on(MESSAGE_EVENT, onMessage);

  return router;
};
