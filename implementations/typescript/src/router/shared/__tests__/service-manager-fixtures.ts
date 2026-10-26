import { type IClock, PLATFORM_CLOCK } from '../../../transport/shared/clock';
import { failureTableOf, LIMIT_DEFAULTS } from '../constants';
import {
  ProgrammerError,
  type CallId,
  type IDebugEvent,
  type INotificationLike,
  type IProcedure,
  type IProcedureAddress,
  type IProcedureSeries,
  type IReceivedFailure,
  type IRequestHeader,
  type IRequestResolver,
  type IRequestResolverProps,
  type IResolvedRequestOptions,
  type IRouterResult,
  type IRouterLike,
  type IServiceManager,
  type ISubscriber,
  type NotificationKey,
  type RouterAnswer,
  type RouterSide,
} from '../service-manager';

/**
 * What the service manager's suites share: its procedures, its serializers, and a fake router
 * that records what it is handed.
 */

// helpers

export interface IText {
  text: string;
}

export const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encode = (value: unknown): Uint8Array => {
  return encoder.encode(JSON.stringify(value));
};

const decode = (bytes: Uint8Array): unknown => {
  return JSON.parse(decoder.decode(bytes));
};

/** JSON both ways, whichever side asks. */
export const serializer = {
  decode: (bytes: Uint8Array) => {
    return decode(bytes) as IText;
  },
  encode: (value: IText) => {
    return encode(value);
  },
  decodeNotification: (bytes: Uint8Array) => {
    return decode(bytes) as IText;
  },
};

export const serverSerializer = {
  ...serializer,
  encodeNotification: (notification: IText) => {
    return encode(notification);
  },
};

export const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
};
/** A request's header, as the router hands it over. */
export const header: IRequestHeader = { callId: 7, kind: 0x10, procedureId: 1, serviceId: 2 };
export const connectionHandle = 'type=WS;ip=127.0.0.1;port=50001;ordinal=1';

/** A request as its router hands it to a resolver: on `header`, carrying `payload`. */
export const propsOf = (
  payload: Uint8Array,
  signal = new AbortController().signal
): IRequestResolverProps<typeof connectionHandle> => {
  return { connectionHandle, header, payload, signal };
};

/** A result carrying `payload`, as the router resolves a request with it: call 7's. */
export const answerOf = (payload: Uint8Array): IRouterResult => {
  return { header: { callId: 7, kind: 0x11 }, payload };
};

/**
 * A router that records every call, draws call 7 for each request and answers it with `answer`, and
 * holds notifications; it raises the failures of its `side`, a server's unless given, subscribes a
 * request under its own call id, and runs on `clock`, the platform's unless given.
 */
export const createFakeRouter = (side: RouterSide = 'server', clock: IClock = PLATFORM_CLOCK) => {
  const keyOf = ({ procedureId, serviceId }: IProcedureAddress) => {
    return `${String(serviceId)}/${String(procedureId)}`;
  };
  const notifications = new Map<string, INotificationLike>();
  const calls = {
    /** Each requester declared, by its procedure's name, as it was made. */
    declareRequester: [] as string[],
    notify: [] as {
      filter: ((subscriber: ISubscriber) => boolean) | undefined;
      key: NotificationKey | undefined;
      /** What it notifies, decoded; or why its value does not write, as the manager hands it. */
      payload: Error | IText;
      procedure: IProcedureAddress;
    }[],
    registerNotification: [] as string[],
    registerResolver: [] as IRequestResolver[],
    /** What the manager reported through the router, and the connection it named. */
    report: [] as { connectionHandle: string | undefined; error: Error }[],
    request: [] as {
      payload: IText;
      request: {
        onCallId?: ((callId: CallId) => void) | undefined;
        options: IResolvedRequestOptions;
        procedure: IProcedure;
        series?: IProcedureSeries | undefined;
        subscribes?: INotificationLike | undefined;
      };
    }[],
    respond: [] as { request: object; response: RouterAnswer }[],
    subscribe: [] as object[],
    unregisterNotification: [] as string[],
    /** What each `unregisterNotification` was told, apart. */
    unregisterOptions: [] as unknown[],
  };
  const control = {
    /** What a requester's declaration gives; none, as a router given no registry. */
    series: undefined as IProcedureSeries | undefined,
    /** The id each request draws, heard through its `onCallId`; none, a router that draws none. */
    callId: 7 as CallId | undefined,
    /** What a request resolves to; an echo of its payload unless replaced. */
    answer: (payload: Uint8Array): Promise<IRouterResult> => {
      return Promise.resolve(answerOf(payload));
    },
    notifyError: undefined as Error | undefined,
    /** What a notify waits on once recorded, before it settles: with `notifyError`, when set. */
    notifyGate: Promise.resolve(),
    /** What `respond` rejects with, once it recorded the answer; none unless set. */
    respondError: undefined as Error | undefined,
    /** What a registration waits on once the router holds it, as a subscription would. */
    subscribeGate: Promise.resolve(),
    subscribeError: undefined as Error | undefined,
    /** What `unregisterNotification` waits on before it takes the notification out. */
    unregisterGate: Promise.resolve(),
  };

  const router: IRouterLike = {
    clock,
    failures: failureTableOf(side),
    limits: LIMIT_DEFAULTS,

    answeredOf: () => {
      return undefined;
    },
    declareRequester: (procedure) => {
      calls.declareRequester.push(procedure.procedureName);

      return control.series;
    },
    hasNotification: (notification) => {
      return notifications.get(keyOf(notification)) === notification;
    },
    notify: async (payload, { filter, key, procedure }) => {
      calls.notify.push({
        filter,
        key,
        payload: payload instanceof Error ? payload : (decode(payload) as IText),
        procedure,
      });
      await control.notifyGate;

      if (control.notifyError !== undefined) {
        throw control.notifyError;
      }
    },
    registerNotification: async (notification) => {
      calls.registerNotification.push(notification.procedureName);

      if (notifications.has(keyOf(notification))) {
        throw new ProgrammerError('already registered');
      }

      // held first, then subscribed, as a router over a broker does
      notifications.set(keyOf(notification), notification);
      await control.subscribeGate;

      if (control.subscribeError !== undefined) {
        throw control.subscribeError;
      }
    },
    registerResolver: (resolver) => {
      calls.registerResolver.push(resolver);
    },
    report: (error, reportedOn) => {
      calls.report.push({ connectionHandle: reportedOn, error });
    },
    request: (payload, request) => {
      calls.request.push({ payload: decode(payload) as IText, request });

      if (control.callId !== undefined) {
        request.onCallId?.(control.callId);
      }

      return control.answer(payload);
    },
    subscribe: (request) => {
      calls.subscribe.push(request);

      return request.header.callId;
    },
    respond: (response, request) => {
      calls.respond.push({ request, response });

      return control.respondError === undefined
        ? Promise.resolve()
        : Promise.reject(control.respondError);
    },
    unregisterNotification: async (notification, options) => {
      calls.unregisterNotification.push(notification.procedureName);
      calls.unregisterOptions.push(options);
      await control.unregisterGate;
      notifications.delete(keyOf(notification));
    },
  };

  /** What the router does with a notification for `procedureAddress`. */
  const deliver = (procedureAddress: IProcedureAddress, notification: IText) => {
    void notifications.get(keyOf(procedureAddress))?.trigger(encode(notification));
  };

  /** What the router does with a notification for `procedureAddress`, settled once heard. */
  const delivered = async (procedureAddress: IProcedureAddress, notification: IText) => {
    await notifications.get(keyOf(procedureAddress))?.trigger(encode(notification));
  };

  /**
   * What the router does when its connection closes, or the server ends each subscription with
   * `failure`: it lets go of each, and tells it.
   */
  const drop = (failure?: IReceivedFailure) => {
    const dropped = [...notifications.values()];

    notifications.clear();

    for (const notification of dropped) {
      notification.drop?.(failure);
    }
  };

  /** Whether the router holds a notification of `procedureAddress`, whichever it is. */
  const holds = (procedureAddress: IProcedureAddress) => {
    return notifications.has(keyOf(procedureAddress));
  };

  return { calls, control, deliver, delivered, drop, holds, router };
};

export const recordDebug = <Handle extends string>(manager: IServiceManager<Handle>) => {
  const seen: { error: unknown; info: IDebugEvent }[] = [];

  manager.on('debug', (error, info) => {
    seen.push({ error, info });
  });

  return seen;
};
