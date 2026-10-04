// dependencies

import type { IClock } from '../../transport/shared/clock';
import type {
  EmitterListener,
  IEventIteratorOptions,
  ITransportMessage,
} from '../../transport/shared/types';
import type {
  DebugDirection,
  INotificationLike,
  IProcedure,
  IResolvedRequestOptions,
  IRouterResult,
  IRouterLike,
  IRouterLimits,
  RedactedHeader,
  RouterActivity,
  RouterLimitsOptions,
  ServerConnectionHandle,
  SessionToken,
} from '../shared/types';

// interfaces

/**
 * A router's client side over one transport: it writes the requests the service manager sends and
 * pairs each result and failure with its request by call id, answers the server's requests with
 * the resolvers registered in it, and triggers each notification registered in it through the call
 * that subscribed it.
 */
export interface IRouterClient<
  Transport extends IRouterClientTransportLike = IRouterClientTransportLike,
> extends IRouterLike<RouterClientConnectionHandle> {
  /**
   * What it reads, writes and holds by: its options', {@link LIMIT_DEFAULTS}' where they say nothing.
   * A relay reads them, to refuse at the opening what this router would refuse after.
   */
  readonly limits: IRouterLimits;
  /**
   * The session the server last announced; `undefined` before one, once the server announced its
   * end, and after a close or a reconnection. The client learns it and never presents it: the
   * connection is the session.
   */
  readonly sessionToken: SessionToken | undefined;
  readonly transport: Transport;

  emit<K extends ROUTER_CLIENT_EVENTS>(event: K, ...params: RouterClientEventMap[K]): boolean;
  /**
   * Every `event` from now on, as its arguments, for `for await`; the signal, a `break` or a throw
   * ends it.
   */
  events<K extends ROUTER_CLIENT_EVENTS>(
    event: K,
    options?: IEventIteratorOptions
  ): AsyncIterableIterator<RouterClientEventMap[K], undefined>;
  off<K extends ROUTER_CLIENT_EVENTS>(
    event: K,
    listener: EmitterListener<RouterClientEventMap[K]>
  ): this;
  on<K extends ROUTER_CLIENT_EVENTS>(
    event: K,
    listener: EmitterListener<RouterClientEventMap[K]>
  ): this;
  once<K extends ROUTER_CLIENT_EVENTS>(
    event: K,
    listener: EmitterListener<RouterClientEventMap[K]>
  ): this;
  removeAllListeners(event?: ROUTER_CLIENT_EVENTS): this;
  /**
   * Sends a request and resolves with its result, header and payload. With `subscribes`, the call
   * subscribes that notification: bound to its call id before it goes out, and unbound however the
   * call fails. Rejects with a {@link FailureError} for a failure answered, a payload too large
   * (PAYLOAD_TOO_LARGE) or every call id in use (CAPACITY_EXCEEDED); a {@link ProgrammerError} when
   * it `subscribes` a notification other than the one this router holds for the procedure, for a
   * procedure's payload limit that is not a whole number above 0, or a timeout longer than a timer
   * holds; a {@link TimeoutError}, a {@link CancelError}, a {@link DisconnectError} when the
   * connection closes first or the router was disposed, or what the transport's `send` does.
   */
  request(
    payload: Uint8Array,
    request: {
      /**
       * Hears `true` as the request is handed to the transport, and `false` should the transport
       * refuse it: before `true`, or after `false`, nothing of it was tried.
       */
      onSent?: ((isHanded: boolean) => void) | undefined;
      options: IResolvedRequestOptions;
      procedure: IProcedure;
      subscribes?: INotificationLike | undefined;
    }
  ): Promise<IRouterResult>;
  /**
   * What `using` calls: stops listening to the transport, rejects every request still waiting with
   * a {@link DisconnectError}, and aborts the signal of each of the server's requests still being
   * answered with one. Nothing more goes out, not even a cancel: a request or an answer after it is
   * a {@link DisconnectError}.
   */
  [Symbol.dispose](): void;
}

/** What a client's router is built with. */
export interface IRouterClientOptions {
  /**
   * The clock it runs on: its transport's, which one given must be; the platform's when neither
   * has one.
   */
  clock?: IClock | undefined;
  /**
   * How much the router reads, writes and holds: {@link LIMIT_DEFAULTS}' where these say nothing.
   * They must hold together, or the router is a {@link ProgrammerError}.
   */
  limits?: RouterLimitsOptions | undefined;
}

/** The part of a transport client this router uses — met by any of this package's. */
export interface IRouterClientTransportLike {
  /** The clock it runs on, which the router runs on too; none, and the router takes its own. */
  readonly clock?: IClock | undefined;
  off(event: 'close', listener: (wasClean: boolean, wasQuick: boolean) => void): unknown;
  off(event: 'message', listener: (message: ITransportMessage) => void): unknown;
  off(event: 'reconnect', listener: () => void): unknown;
  on(event: 'close', listener: (wasClean: boolean, wasQuick: boolean) => void): unknown;
  on(event: 'message', listener: (message: ITransportMessage) => void): unknown;
  on(event: 'reconnect', listener: () => void): unknown;
  send(message: ITransportMessage): Promise<void>;
}

/** An envelope as the router sent or took it. */
export interface IRouterDebugInfo {
  direction: DebugDirection;
  /** A copy, without its session token. */
  header: RedactedHeader;
}

// types

/** What the router just did: sent a request, took a response, or took a notification. */
export type RouterClientActivity = RouterActivity;

/** Who a request reaching the client came from: always its one peer, the server. */
export type RouterClientConnectionHandle = ServerConnectionHandle;

/** Event name → the arguments its listeners receive. */
export type RouterClientEventMap = {
  activity: [activity: RouterClientActivity];
  /** Each envelope, out or in; built only while someone listens. */
  debug: [info: IRouterDebugInfo];
  /** What went wrong with an envelope no call was waiting on, or in a resolver or a notification. */
  error: [error: Error];
};

/** The events a client router emits, named by the table that types them. */
export type ROUTER_CLIENT_EVENTS = keyof RouterClientEventMap;
