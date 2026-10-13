// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import type { IClock, TimeoutId } from '../../transport/shared/clock';
import type {
  EmitterListener,
  IEventIteratorOptions,
  IGauges,
  ITransportMessage,
} from '../../transport/shared/types';
import type { IRouterClient } from '../client/types';
import type {
  IMetricsRegistry,
  INotifyingSeries,
  IProcedureSeries,
} from '../shared/metrics-registry';
import type {
  CallId,
  DebugDirection,
  DestinationId,
  IBeforeRequest,
  ICallAddress,
  ICredentials,
  IFailure,
  INotificationLike,
  IProcedure,
  IProcedureAddress,
  IResolvedRequestOptions,
  IRouterResult,
  IRouterLike,
  IRouterLimits,
  ISubscriber,
  NotificationKey,
  ProcedureId,
  RedactedHeader,
  RouterActivity,
  RouterLimitsOptions,
  ServiceId,
  SessionIdentifier,
  SessionOf,
  SessionToken,
} from '../shared/types';
import type {
  CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT,
  CREATED_EVENT,
  DELETED_EVENT,
  SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT,
  UPDATED_EVENT,
} from './constants';

// ── Notification manager ──────────────────────────────────────────────────────

// interfaces

/** Who is notified of which procedure of which service, by connection, session and call id. */
export interface INotificationManager {
  /** The subscriptions notified of a procedure, as copies: each connection's, in each session. */
  candidates(procedureAddress: IProcedureAddress): NotificationCandidates;
  /** Forgets every subscription of a connection, as when it closes. */
  clean(connectionHandle: TransportServerConnectionHandle): void;
  /**
   * The subscriptions it notifies, counted, and their connections; of those paced, the ones whose
   * credit is spent, and what they queue — all together, and the fullest queue, at its limits.
   */
  gauges(): IGauges<TransportServerConnectionHandle>;
  /** Whether `connectionHandle` holds a subscription under `callId`. */
  has(callId: CallId, connectionHandle: TransportServerConnectionHandle): boolean;
  /** The registry itself, for tests: an empty map is removed with its last entry. */
  readonly notifications: Notifications;
  /** The pacing of `connectionHandle`'s subscription under `callId`; `undefined` when not paced. */
  pacingOf(callId: CallId, connectionHandle: TransportServerConnectionHandle): IPacing | undefined;
  /**
   * The series a subscription counts its notifications into, as it was registered with; `undefined`
   * for one registered with none, or none under that call id.
   */
  seriesOf(
    callId: CallId,
    connectionHandle: TransportServerConnectionHandle
  ): INotifyingSeries | undefined;
  /**
   * Subscribes `subscription.connectionHandle` to `procedureAddress` under the call id of the
   * request that subscribed it, in the session that holds it — paced, when that request asked — and
   * gives that call id. Throws a {@link ProgrammerError}, and registers nothing, when the connection
   * holds a subscription to that procedure in that session already, or one under that call id.
   */
  register(procedureAddress: IProcedureAddress, subscription: ISubscribingCall): CallId;
  /**
   * The call id a connection is subscribed to a procedure under, in a session of its own; `undefined`
   * when none.
   */
  subscriptionOf(
    procedureAddress: IProcedureAddress,
    subscriber: ISubscriber<TransportServerConnectionHandle>
  ): CallId | undefined;
  /** Every subscription — `connectionHandle`'s alone, when given — as copies. */
  subscriptions(connectionHandle?: TransportServerConnectionHandle): ISubscription[];
  /**
   * Forgets one subscription of `connectionHandle`'s; `undefined` when it holds none under that
   * call id, so no connection takes another's.
   */
  unregister(callId: CallId, connectionHandle: TransportServerConnectionHandle): CallId | undefined;
}

/** What a notification manager is built with. */
export interface INotificationManagerOptions {
  /** What a paced subscription queues at most: {@link PACING_DEFAULTS}' where it says nothing. */
  pacing?: PacingLimitsOptions | undefined;
}

/**
 * A call that subscribes: where it is, the session it holds the subscription in, and whether its
 * request asked to be paced.
 */
export interface ISubscribingCall extends ICallAddress<TransportServerConnectionHandle> {
  /**
   * For a credential's session, its end as the call resolved it, in whole milliseconds since the
   * epoch, which the router times while the session holds a subscription; none for a session
   * without one.
   */
  end?: number | undefined;
  /** A credential's session's identifier; none for its connection's session. */
  identifier?: SessionIdentifier | undefined;
  paced?: boolean | undefined;
  /** The series its notifications count into, at the side that notifies; none counts nothing. */
  series?: INotifyingSeries | undefined;
}

/**
 * One subscription: which procedure, which connection, the call id it stays open under, and the
 * identifier of the credential's session that holds it, when one does.
 */
export interface ISubscription
  extends IProcedureAddress, ICallAddress<TransportServerConnectionHandle> {
  identifier?: SessionIdentifier | undefined;
}

// types

/** The subscriptions notified of one procedure: each connection's, in each session of its own. */
export type NotificationCandidates = ISubscription[];

/**
 * Service → procedure → connection → session → the call id of its subscription: its connection's
 * session under `''`, a credential's under a key its identifier gives.
 */
export type Notifications = ReadonlyMap<
  ServiceId,
  ReadonlyMap<
    ProcedureId,
    ReadonlyMap<TransportServerConnectionHandle, ReadonlyMap<string, CallId>>
  >
>;

// ── Notification pacing ───────────────────────────────────────────────────────

// interfaces

/**
 * One paced subscription, as its server holds it: how many notifications its client credited, how
 * many went, and those queued past the credit, in order, the latest of each key.
 */
export interface IPacing {
  /** Whether its credit is spent: the next notification is queued. */
  readonly isPaused: boolean;
  /** The notifications queued. */
  readonly queuedNotifications: number;
  /** The bytes of their payloads. */
  readonly queuedNotificationBytes: number;

  /**
   * Raises the credit to `creditEnd` — a lower one grants nothing — and gives the notifications
   * queued that it lets go, in order, counted as sent.
   */
  credit(creditEnd: number): Uint8Array[];
  /**
   * A notification for the subscription: `send` when its credit lets it go now, counted as sent;
   * `queued` when it waits — in the place of the one queued under its key, or last; `exceeded` when
   * the queue then holds more than its limits.
   */
  offer(notification: IQueuedNotification): PacingOutcome;
}

/** What a paced subscription queues at most. */
export interface IPacingLimits {
  /** The bytes of the payloads it queues. */
  maximumQueuedNotificationBytes: number;
  /** The notifications it queues. */
  maximumQueuedNotifications: number;
}

/** A notification offered to a paced subscription: its payload, and what it is about. */
export interface IQueuedNotification {
  key?: NotificationKey | undefined;
  payload: Uint8Array;
}

// types

/** What a paced subscription does with a notification offered: sends it, queues it, or ends. */
export type PacingOutcome = 'exceeded' | 'queued' | 'send';

/** A pacing's limits as options give them: each one left out, or `undefined`, the default. */
export type PacingLimitsOptions = { [Key in keyof IPacingLimits]?: IPacingLimits[Key] | undefined };

// ── Session manager ───────────────────────────────────────────────────────────

// interfaces

/**
 * One connection's session. Every one handed out is a copy: change it, then pass it to an `update*`
 * method to store what changed.
 */
export interface ISession<Data> {
  connectionHandle: TransportServerConnectionHandle;
  /**
   * Milliseconds without activity before `connectionInactivityTimeoutReached`: from 1 to 2³¹ − 1,
   * stored rounded to the nearest whole one, or `Infinity` for never; 0 is refused. Left out, it is
   * stored as the manager's default; a session handed out always holds one.
   */
  connectionInactivityTimeout?: number | undefined;
  /** What the router keeps about the session; structured-cloneable, since it is stored as a copy. */
  data: Data | undefined;
  /**
   * When the session was last active, in milliseconds since the epoch, as its manager's clock reads
   * the wall clock.
   */
  lastActivity: number;
  /** As `connectionInactivityTimeout`, before `sessionInactivityTimeoutReached`. */
  sessionInactivityTimeout?: number | undefined;
  /** What the router announces to the connection; `undefined` until `set` draws one. */
  sessionToken: SessionToken | undefined;
}

/**
 * The sessions, by connection, with their inactivity timers. A connection with no session has no
 * timer.
 */
export interface ISessionManager<Data> {
  /** The clock its timers run on, and its activity is read on. */
  readonly clock: IClock;
  /** Each connection's timers. */
  readonly timers: ISessionManagerTimers;

  connectionHandles(): TransportServerConnectionHandle[];
  /**
   * What it holds right now, for diagnosis: its sessions and the connections it keeps timers for;
   * timers kept for a connection with no session — set through `timers` — are an anomaly.
   */
  gauges(): IGauges<TransportServerConnectionHandle>;
  /**
   * A new session for `connectionHandle`, not stored: its timeouts `Infinity`, none, and no token
   * until `set`.
   */
  create(connectionHandle: TransportServerConnectionHandle): ISession<Data>;
  /** Forgets a session and stops its timers, emitting `deleted`; `false` when there was none. */
  delete(connectionHandle: TransportServerConnectionHandle): boolean;
  /**
   * Every `event` from now on, as its arguments, for `for await`; the signal, a `break` or a throw
   * ends it.
   */
  events<K extends SESSION_MANAGER_EVENTS>(
    event: K,
    options?: IEventIteratorOptions
  ): AsyncIterableIterator<SessionManagerEventMap<Data>[K], undefined>;
  get(connectionHandle: TransportServerConnectionHandle): ISession<Data> | undefined;
  getAll(): ISession<Data>[];
  /** The session of `connectionHandle`, stored first when it has none. */
  getOrElseSet(connectionHandle: TransportServerConnectionHandle): ISession<Data>;
  has(connectionHandle: TransportServerConnectionHandle): boolean;
  off<K extends SESSION_MANAGER_EVENTS>(
    event: K,
    listener: EmitterListener<SessionManagerEventMap<Data>[K]>
  ): this;
  on<K extends SESSION_MANAGER_EVENTS>(
    event: K,
    listener: EmitterListener<SessionManagerEventMap<Data>[K]>
  ): this;
  once<K extends SESSION_MANAGER_EVENTS>(
    event: K,
    listener: EmitterListener<SessionManagerEventMap<Data>[K]>
  ): this;
  removeAllListeners(event?: SESSION_MANAGER_EVENTS): this;
  /**
   * Restarts the connection timer of a stored session, which only its `connectionHandle` names:
   * `connectionInactivityTimeoutReached` in `timeout` milliseconds, rounded to the nearest whole
   * one. `Infinity` only stops it; one that is not from 1 to {@link LONGEST_TIMER}, 0 among them, is
   * a {@link ProgrammerError}, and the timer is left as it was. A connection with no session arms
   * nothing.
   */
  resetConnectionInactivityTimeout(
    session: Pick<ISession<Data>, 'connectionHandle'>,
    timeout: number
  ): void;
  /** As {@link ISessionManager.resetConnectionInactivityTimeout}, for the session timer. */
  resetSessionInactivityTimeout(
    session: Pick<ISession<Data>, 'connectionHandle'>,
    timeout: number
  ): void;
  /**
   * Stores a session, drawing its token when it has none; emits `created`, or `updated` when it
   * replaces a different one. A new session's timers start over, and a timeout that changed
   * restarts its timer; a timeout left out is the manager's default, as for the `update*` methods.
   * Throws a {@link ProgrammerError} for a timeout neither `Infinity` nor from 1 to
   * {@link LONGEST_TIMER} milliseconds, 0 among them, or a token that is not one or that another
   * connection holds — before anything is stored.
   */
  set(session: ISession<Data>): ISession<Data>;
  /**
   * Stores `session.connectionInactivityTimeout`, rounded to the nearest whole millisecond — the
   * manager's default when left out, a {@link ProgrammerError} when neither `Infinity` nor from 1
   * to {@link LONGEST_TIMER}, 0 among them. When it changed, restarts the timer with it and emits
   * `connectionInactivityTimeoutChanged`; the same timeout restarts nothing, since activity is what
   * restarts a timer. `undefined` when the connection has no session.
   */
  updateConnectionInactivityTimeout(session: ISession<Data>): ISession<Data> | undefined;
  /** Stores a copy of `session.data`; emits `dataChanged` when it is not similar to the last. */
  updateData(session: ISession<Data>): ISession<Data> | undefined;
  /**
   * The session token of `connectionHandle`, which the router announces when it changes;
   * `undefined` when it has no session. No copy is made, so a router can ask it for every answer.
   */
  sessionTokenOf(connectionHandle: TransportServerConnectionHandle): SessionToken | undefined;
  /**
   * As {@link ISessionManager.updateLastActivity}, by connection and without a copy, for
   * every message; whether the connection has a session.
   */
  touch(connectionHandle: TransportServerConnectionHandle): boolean;
  /**
   * Stamps activity now and restarts both timers; emits `lastActivityChanged` when the stamp moved
   * to another millisecond.
   */
  updateLastActivity(session: ISession<Data>): ISession<Data> | undefined;
  /** As {@link ISessionManager.updateConnectionInactivityTimeout}, for the session timeout. */
  updateSessionInactivityTimeout(session: ISession<Data>): ISession<Data> | undefined;
  /**
   * What `using` calls: stops every timer and forgets every session, without events. A `set` after
   * it is a {@link DisconnectError}.
   */
  [Symbol.dispose](): void;
}

export interface ISessionManagerOptions {
  /** The clock its timers run on, and its activity is read on; the platform's when not given. */
  clock?: IClock | undefined;
  /**
   * What `set` and `updateConnectionInactivityTimeout` store for a timeout left out; `Infinity`,
   * never, when not given: the application gives its own. One that authenticates takes OWASP ASVS
   * 4.0.3 V3.3.2's: 30 minutes of inactivity at level 2, 15 at level 3. From 1 to
   * {@link LONGEST_TIMER} milliseconds, rounded to the nearest whole one, or `Infinity` for never:
   * anything else, 0 among them, is a {@link ProgrammerError}, as the manager is built.
   */
  connectionInactivityTimeout?: number | undefined;
  /** As `connectionInactivityTimeout`, for the session timeout; `Infinity` when not given. */
  sessionInactivityTimeout?: number | undefined;
}

/** Each connection's two timers; setting one stops the one it replaces. */
export interface ISessionManagerTimers {
  clearConnectionInactivityTimeout(connectionHandle: TransportServerConnectionHandle): void;
  clearInactivityTimeout(connectionHandle: TransportServerConnectionHandle): void;
  clearSessionInactivityTimeout(connectionHandle: TransportServerConnectionHandle): void;
  /** Starts a connection over with no timer, stopping any it had. */
  create(connectionHandle: TransportServerConnectionHandle): void;
  /** Stops a connection's timers and forgets it; `false` when it had none. */
  delete(connectionHandle: TransportServerConnectionHandle): boolean;
  /** The connections it keeps timers for, counted. */
  gauges(): IGauges<TransportServerConnectionHandle>;
  setConnectionInactivityTimeout(
    timeoutId: TimeoutId,
    connectionHandle: TransportServerConnectionHandle
  ): void;
  setSessionInactivityTimeout(
    timeoutId: TimeoutId,
    connectionHandle: TransportServerConnectionHandle
  ): void;
  /** Stops every timer and forgets every connection. */
  [Symbol.dispose](): void;
}

export interface ISessionTimeoutIds {
  connectionTimeoutId: TimeoutId | undefined;
  sessionTimeoutId: TimeoutId | undefined;
}

// types

/** Event name → the arguments its listeners receive; every session is a copy. */
export type SessionManagerEventMap<Data = unknown> = {
  connectionInactivityTimeoutChanged: [session: ISession<Data>, newValue: number, oldValue: number];
  /** The session as it is when its timer fires. */
  connectionInactivityTimeoutReached: [session: ISession<Data>];
  created: [session: ISession<Data>];
  dataChanged: [session: ISession<Data>, newValue: Data | undefined, oldValue: Data | undefined];
  deleted: [session: ISession<Data>];
  lastActivityChanged: [session: ISession<Data>, newValue: number, oldValue: number];
  sessionInactivityTimeoutChanged: [session: ISession<Data>, newValue: number, oldValue: number];
  /** The session as it is when its timer fires. */
  sessionInactivityTimeoutReached: [session: ISession<Data>];
  updated: [session: ISession<Data>];
};

/** The events a session manager emits, named by the table that types them. */
export type SESSION_MANAGER_EVENTS = keyof SessionManagerEventMap;

export type SessionManagerOnInactivityTimeoutCallback<Data = unknown> = EmitterListener<
  SessionManagerEventMap<Data>[
    | CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT
    | SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT]
>;
export type SessionManagerOnSessionCallback<Data = unknown> = EmitterListener<
  SessionManagerEventMap<Data>[CREATED_EVENT | DELETED_EVENT | UPDATED_EVENT]
>;

// ── Router server ─────────────────────────────────────────────────────────────

// interfaces

/**
 * A router's server side over one transport server: it answers each connection's requests with the
 * resolvers registered in it, sends its own requests to a connection named in their options, and
 * notifies the connections that subscribed, each under the call id of the request that subscribed
 * it — a connection subscribes by getting a successful answer from a notification's resolver to a
 * request that opens a subscription, keeps its first subscription to a procedure — or, should that
 * one fall while still in flight, the first answered meanwhile — and is forgotten when it closes.
 */
export interface IRouterServer<
  Transport extends IRouterServerTransportLike = IRouterServerTransportLike,
> extends IRouterLike<TransportServerConnectionHandle> {
  /**
   * What it reads, writes and holds by: its options', {@link LIMIT_DEFAULTS}' where they say nothing.
   * A relay reads them, to refuse at the opening what this router would refuse after.
   */
  readonly limits: IRouterLimits;
  /** Who is subscribed to what; the router fills it, and empties it of each connection that closes. */
  readonly notifications: INotificationManager;
  readonly transport: Transport;

  /** The destinations registered, each as its registration names it. */
  destinations(): IDestination[];
  /**
   * Ends each subscription `connectionHandle` holds, established by its answer, with `failure` on
   * its call id — SESSION_REQUIRED when its session ended, say, whose end the first failure
   * announces — then forgets it. A subscribing call still in flight is left to its own answer.
   * Resolves once each failure was tried; one that cannot go out is reported to `error`.
   */
  dropSubscriptions(connection: {
    connectionHandle: TransportServerConnectionHandle;
    failure: IFailure;
  }): Promise<void>;
  /**
   * Ends a credential's session by its identifier on every connection that keeps it, and nothing
   * else (spec 13.10): each subscription it bounds ends with SESSION_REQUIRED on its call id, a
   * call still in flight left to its own answer. Resolves once each failure was tried; one that
   * cannot go out is reported to `error`. One no connection keeps ends nothing. Ending refuses no
   * credential: one that still holds opens its session anew.
   */
  endSession(identifier: SessionIdentifier): Promise<void>;
  /**
   * Ends every credential's session of an issuer by that issuer, as when a key of its leaks, on every
   * connection that keeps one, and nothing else (spec 13.10): each `JWT`'s session whose
   * identifier's issuer is `issuer`, octet for octet, whatever its `sid` or `sub`, each subscription
   * it bounds ending with SESSION_REQUIRED on its call id, a call still in flight left to its own
   * answer; an `ELSEWHERE`'s identifier names no issuer. Resolves once each failure was tried; one
   * that cannot go out is reported to `error`. An issuer no connection's session names ends nothing;
   * one that is no string rejects with a {@link ProgrammerError}. Ending refuses no credential: one
   * that still holds opens its session anew, a token a leaked key signed among them while that key
   * serves.
   */
  endSessionsOf(issuer: string): Promise<void>;
  emit<K extends ROUTER_SERVER_EVENTS>(event: K, ...params: RouterServerEventMap[K]): boolean;
  /**
   * Every `event` from now on, as its arguments, for `for await`; the signal, a `break` or a throw
   * ends it.
   */
  events<K extends ROUTER_SERVER_EVENTS>(
    event: K,
    options?: IEventIteratorOptions
  ): AsyncIterableIterator<RouterServerEventMap[K], undefined>;
  /**
   * What it holds right now, for diagnosis: the connections it follows, its core's calls and
   * transfers, its subscriptions — in flight, waiting for a place, notified — and its destinations,
   * those whose connection closed among them, which it keeps on purpose and counts for no connection.
   */
  gauges(): IGauges<TransportServerConnectionHandle>;
  off<K extends ROUTER_SERVER_EVENTS>(
    event: K,
    listener: EmitterListener<RouterServerEventMap[K]>
  ): this;
  on<K extends ROUTER_SERVER_EVENTS>(
    event: K,
    listener: EmitterListener<RouterServerEventMap[K]>
  ): this;
  once<K extends ROUTER_SERVER_EVENTS>(
    event: K,
    listener: EmitterListener<RouterServerEventMap[K]>
  ): this;
  removeAllListeners(event?: ROUTER_SERVER_EVENTS): this;
  /**
   * Relays each request that names the destination to `target` — a client router this relay calls
   * through, or a connection of its own — and gives its registration: the relay terminates each
   * leg, passing on the payload's bytes and the answer, a failure of the target's counted one relay
   * more. Why leg B failed is reported to `error`, with leg A's connection, and never passed on. A
   * destination given that is taken, or not an integer from 1 to 2³² − 1, or a timeout no timer
   * holds, is a {@link ProgrammerError}.
   */
  registerDestination(target: RelayTarget, options?: IDestinationOptions): IDestinationRegistration;
  /**
   * Sends a request to the connection its options name, on an even call id, and resolves with its
   * result. Rejects with a {@link ProgrammerError} when none is named, for a notification it
   * `subscribes`, which a server never holds, for a procedure's payload limit that is not a whole
   * number above 0, or a timeout no timer holds; a {@link DisconnectError} when that
   * connection is not open, closes first, or the router was disposed; a {@link FailureError} for a
   * failure answered, a payload too large or every call id in use; a {@link TimeoutError}, a
   * {@link CancelError}, or what the transport's `send` throws.
   */
  request(
    payload: Uint8Array,
    request: {
      /**
       * Hears the call's id once the router drew it, before the request goes; a call refused before
       * it draws one is never heard.
       */
      onCallId?: ((callId: CallId) => void) | undefined;
      /**
       * Hears `true` as the request is handed to the transport, and `false` should the transport
       * refuse it: before `true`, or after `false`, nothing of it was tried.
       */
      onSent?: ((isHanded: boolean) => void) | undefined;
      options: IResolvedRequestOptions;
      procedure: IProcedure;
      /**
       * The series its requester's declaration gave, which a counted call counts into; `_OTHER`'s
       * when none is given, as a relay's leg B.
       */
      series?: IProcedureSeries | undefined;
      subscribes?: INotificationLike | undefined;
    }
  ): Promise<IRouterResult>;
  /**
   * Takes a connection's subscription away, as its request to unsubscribe asks with the call id of
   * the request that subscribed it; whether it held that one.
   */
  unsubscribe(subscription: ICallAddress<TransportServerConnectionHandle>): boolean;
  /**
   * What `using` calls: stops listening to the transport, forgets every connection and what it
   * subscribed to, rejects every request still waiting with a {@link DisconnectError}, and aborts
   * the signal of each call still being answered with one. Nothing more goes out, not even a
   * cancel: a request or an answer after it is a {@link DisconnectError}, and a notification
   * reaches no one.
   */
  [Symbol.dispose](): void;
}

/**
 * An envelope as the router sent or took it, and the connection it went to or came from. What a
 * listener throws is reported to `error`, with that connection, and changes nothing of the envelope.
 */
export interface IRouterServerDebugInfo {
  connectionHandle: TransportServerConnectionHandle;
  direction: DebugDirection;
  /** A copy, its credential reported by its scheme alone. */
  header: RedactedHeader;
}

/** What a server's router is built with. */
export interface IRouterServerOptions {
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
  /**
   * What it resolves a request presenting a `JWT` or an `ELSEWHERE` with, on its clock: a `JWT`'s
   * keys, audience and key set, an `ELSEWHERE`'s verifier. A scheme it is given nothing for is
   * refused, CREDENTIAL_UNSUPPORTED. Given a `JWT`'s keys or key set, its limits hold 1,024 bytes of
   * chunk and envelope at least, and its audience is given, whatever its relay does, or it is a
   * {@link ProgrammerError}, as are a key not shaped for its algorithm and a key set given no issuer.
   */
  credentials?: ICredentials | undefined;
  /**
   * The registry it counts its calls and its notifications into, its `_OTHER` series made as it is
   * given it: each resolver registered, and each requester made, declared to it. None counts
   * nothing, and costs nothing.
   */
  metricsRegistry?: IMetricsRegistry | undefined;
  /** What a paced subscription queues at most: {@link PACING_DEFAULTS}' where it says nothing. */
  pacing?: PacingLimitsOptions | undefined;
  /** How the router relays a request that names a destination registered in it. */
  relay?: IRelayOptions | undefined;
  /**
   * The call's session a request presenting none or `OPAQUE` runs in, asked once per request, its
   * call id held, before its admission, in the turn it came: its connection's — a server's sessions
   * give it — as {@link SessionOf} says. None when not given: a request presenting none runs in
   * none, and one presenting `OPAQUE` is refused with `SESSION_REQUIRED`. A `JWT` and an `ELSEWHERE`
   * resolve by `credentials`.
   */
  sessionOf?: SessionOf<TransportServerConnectionHandle> | undefined;
  /**
   * The session of a connection — a session manager's token, say — which the router announces on
   * the next answer to it whenever it changed, and a command presenting `OPAQUE` presents;
   * `undefined` for none. Never announced when not given. What it throws fails the answer it was
   * asked for.
   */
  sessionTokenOf?:
    | ((connectionHandle: TransportServerConnectionHandle) => SessionToken | undefined)
    | undefined;
}

/**
 * A connection of the relay's own router that a destination names: something behind the relay that
 * connected to it, which the relay asks as the server asks a client, by a command. Once that
 * connection closes, the destination is unreachable, and no connection takes its handle again: the
 * application unregisters it, and registers the next connection anew once it knows it.
 */
export interface IConnectionTarget {
  connectionHandle: TransportServerConnectionHandle;
}

/** A destination, as its registration names it. */
export interface IDestination {
  readonly destinationId: DestinationId;
  /** What the application calls it, for a list of its own. */
  readonly label: string | undefined;
}

export interface IDestinationOptions {
  /**
   * The audience it verifies, as a resource is named for a token (RFC 8707): a `JWT` goes to it only
   * when its `aud` names it, and an `ELSEWHERE` only when it has one. None by default, which takes
   * neither; a string of well-formed Unicode otherwise, or it is a {@link ProgrammerError}.
   */
  audience?: string | undefined;
  /** The destination, an integer from 1 to 2³² − 1; drawn, one not in use, when not given. */
  destinationId?: DestinationId | undefined;
  /** What the application calls it, for a list of its own. */
  label?: string | undefined;
  /**
   * The milliseconds leg B waits for its answer, the relay's at most; the relay's if not given. From
   * 1 to 2³¹ − 1, rounded to the nearest whole one, or `Infinity` for none; any other, 0 among
   * them, is a {@link ProgrammerError}.
   */
  timeout?: number | undefined;
}

/** A destination registered: what names it, and what takes it out. */
export interface IDestinationRegistration extends IDestination {
  /**
   * Takes the destination out, unless another took its id since; whether it did. A call relayed
   * to it already finishes: what comes after is refused with `DESTINATION_UNKNOWN`.
   */
  unregister(): boolean;
}

/** How a server router relays the requests that name a destination. */
export interface IRelayOptions {
  /**
   * Whether a request may be relayed, asked on its header — its destination included — and the
   * call's session, before its destination is looked up, so a requester presenting none or `OPAQUE`
   * that is not admitted learns only whether any is registered: only `true` admits. Without it, the
   * relay admits nobody; a server's admits by `requireSessionOrCredential`. Synchronous, as every
   * admission.
   */
  beforeRoute?: IBeforeRequest<TransportServerConnectionHandle> | undefined;
  /**
   * The milliseconds leg B waits for its answer at most, whatever a destination says; none,
   * `Infinity`, by default: the requester's own timeout governs, end to end, by the cancel it sends.
   * From 1 to 2³¹ − 1 otherwise, rounded to the nearest whole one; any other, 0 among them, is a
   * {@link ProgrammerError}.
   */
  timeout?: number | undefined;
  /**
   * Whether it verifies what it forwards besides (spec 14.3, step 1), with its router's
   * `credentials`, before `beforeRoute`: a `JWT` against the audiences its destinations were
   * registered with, a credential that does not hold refused SESSION_REQUIRED, one that holds
   * resolving to its credential's session, which `beforeRoute` reads. Not by default: a `JWT`, and
   * an `ELSEWHERE` its transport carried, go on unresolved, for the destination to verify.
   */
  verifies?: boolean | undefined;
}

/** The part of a transport server this router uses — met by this package's. */
export interface IRouterServerTransportLike {
  /** The clock it runs on, which the router runs on too; none, and the router takes its own. */
  readonly clock?: IClock | undefined;
  off(
    event: 'close',
    listener: EmitterListener<
      [wasClean: boolean, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  off(
    event: 'connection',
    listener: EmitterListener<
      [socket: unknown, request: unknown, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  off(
    event: 'message',
    listener: EmitterListener<
      [message: ITransportMessage, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  on(
    event: 'close',
    listener: EmitterListener<
      [wasClean: boolean, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  on(
    event: 'connection',
    listener: EmitterListener<
      [socket: unknown, request: unknown, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  on(
    event: 'message',
    listener: EmitterListener<
      [message: ITransportMessage, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  /**
   * Whether a connection carries a credential beside an envelope the server sends it — a command, a
   * relay's leg B: none of this package's does, a listen's batch, a WebSocket and a worker alike.
   * None does without it. A command presenting `ELSEWHERE` over one that does not fails before it
   * goes, DESTINATION_UNREACHABLE, and a relay sends it none (spec 13.4, 14.3).
   */
  carriesCredential?(connectionHandle: TransportServerConnectionHandle): boolean;
  /**
   * Whether a connection is secure: under TLS, from the loopback, or never leaving the machine, as
   * a Web Worker. None is without it. A command presenting a `JWT` or an `ELSEWHERE` over one that is
   * not fails before it goes, DESTINATION_UNREACHABLE, and a relay sends it neither (spec 13.4, 14.3).
   */
  isSecure?(connectionHandle: TransportServerConnectionHandle): boolean;
  /**
   * Whether a connection carries both ways — what the server sends of its own, a notification, a
   * command, a relay's request, as well as its answers; every connection does, without it. One drawn
   * over HTTP does not, yet: a request that opens a subscription on it is refused, and a relay passes
   * it no request.
   */
  isTwoWay?(connectionHandle: TransportServerConnectionHandle): boolean;
  send(
    message: ITransportMessage,
    connectionHandle: TransportServerConnectionHandle
  ): Promise<void>;
}

// types

/**
 * What the router did on its own account, and with which connection: sent a request, took the
 * response to one, or sent a notification. A connection's requests, and the answers to them, are
 * not activity of the router's.
 */
export type RouterServerActivity = RouterActivity;

/**
 * What a destination names: a client router the relay calls through — the transport it calls
 * through saying what it carries, none when it has none — or a connection of its own.
 */
export type RelayTarget =
  | IConnectionTarget
  | (Pick<IRouterClient, 'limits' | 'request'> & {
      readonly transport?:
        | Pick<IRouterClient['transport'], 'carriesCredential' | 'isSecure'>
        | undefined;
    });

/** Event name → the arguments its listeners receive. */
export type RouterServerEventMap = {
  activity: [activity: RouterServerActivity, connectionHandle: TransportServerConnectionHandle];
  /** Each envelope, out or in; built only while someone listens. */
  debug: [info: IRouterServerDebugInfo];
  /**
   * What went wrong with an envelope no call was waiting on, in a resolver, or with a notification,
   * and the connection that envelope came from or went to; none for what no connection carries: a
   * debug listener that throws as a notification is told sent, to whoever is subscribed.
   */
  error: [error: Error, connectionHandle: TransportServerConnectionHandle | undefined];
};

/** The events a server router emits, named by the table that types them. */
export type ROUTER_SERVER_EVENTS = keyof RouterServerEventMap;
