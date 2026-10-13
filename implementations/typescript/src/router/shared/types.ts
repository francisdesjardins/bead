// dependencies

import type { IClock } from '../../transport/shared/clock';
import type {
  Data,
  EmitterListener,
  IEventIteratorOptions,
  IGauges,
  ITransportMessage,
} from '../../transport/shared/types';
import type {
  CredentialScheme,
  DEBUG_EVENT,
  DEPRECATED_EVENT,
  DROPPED_EVENT,
  EnvelopeKind,
  FAILURE_KEYS,
  FailureScope,
  ProcedureKind,
  ProtocolCode,
} from './constants';
import type { IJwtKey, Jwk, JwtAlgorithm } from './jwt-verifier';
import type {
  INotifyingSeries,
  IProcedureSeries,
  IResolverSeries,
  IRouterMetrics,
} from './metrics-registry';

// declarations

declare const sessionTokenBrand: unique symbol;

// ── Envelope ─────────────────────────────────────────────────────────────────

// what travels: the envelope, its header, its failures, and the numbers they carry

// interfaces

/**
 * A procedure's own failure, as its resolver answers with it: a code from 1 to 65535 in the
 * procedure's own numbering, which the service manager sends as an application failure.
 */
export interface IApplicationFailure {
  readonly code: number;
  readonly detail?: string | undefined;
  readonly scope?: never;
}

/** A cancel's header: the call its requester cancels, and nothing more. */
export interface ICancelHeader {
  callId: CallId;
  kind: typeof EnvelopeKind.CANCEL;
}

/**
 * A chunk's header: its call, where its bytes start in the whole payload, from 0, and whether they
 * are the last — whether they reach the total the transfer's opening declared.
 */
export interface IChunkHeader {
  callId: CallId;
  isLast: boolean;
  kind: typeof EnvelopeKind.CHUNK;
  offset: number;
}

/**
 * A credit's header: its call, and the end below which the other end may send — the transfer's
 * bytes, by their offset; or, `paced`, the subscription's notifications, by their count. The highest
 * end received stands: a credit that comes again, late or out of order, grants nothing more.
 */
export interface ICreditHeader {
  callId: CallId;
  creditEnd: number;
  kind: typeof EnvelopeKind.CREDIT;
  paced?: true | undefined;
}

/**
 * An envelope's first 8 bytes, which every layout keeps where they are: its layout, its kind, and
 * the call it belongs to. Read even when the rest cannot be, to say whether a refusal is answered.
 */
export interface IEnvelopePrefix {
  callId: CallId;
  kind: number;
  layout: number;
}

/** What went wrong, as a failure envelope carries it once: whose code, the code, and why. */
export interface IFailure {
  code: number;
  /** Why, readable: '' when it says nothing. */
  detail?: string | undefined;
  /**
   * The relays it crossed, 0 when not given: a relay that passes on a failure its target sent
   * writes one more than it received.
   */
  relays?: number | undefined;
  scope: FailureScope;
}

/**
 * A failure's header: its call, and the block an answer may carry — its connection's session,
 * announced when it changes. An answer names its call alone: never a destination.
 */
export interface IFailureHeader {
  callId: CallId;
  credential?: Announcement | undefined;
  kind: typeof EnvelopeKind.FAILURE;
}

/** A notification's header: the call id of the subscription it belongs to, and nothing more. */
export interface INotificationHeader {
  callId: CallId;
  kind: typeof EnvelopeKind.NOTIFICATION;
}

/** One of the protocol's own failures, as a router of `side` raises it; `Code` keeps its code. */
export interface IProtocolFailure<Code extends ProtocolCode = ProtocolCode> {
  readonly code: Code;
  readonly detail?: string | undefined;
  readonly scope: typeof FailureScope.PROTOCOL;
  readonly side: RouterSide;
}

/** A failure as it came in: its detail read, '' when it had none, and the relays it crossed. */
export interface IReceivedFailure extends IFailure {
  detail: string;
  relays: number;
}

/**
 * A request's header: its call, the procedure it asks for, and its blocks — where it goes behind
 * the peer, the `total` of a payload it opens a transfer for, its own payload then the transfer's
 * first bytes, and the credential it presents, which its receiver resolves to the call's session.
 * `opensSubscription` says the call subscribes to the procedure's notifications: a server
 * subscribes the requester of no other request. `paced` asks for them as the requester credits
 * them, the first credited already.
 */
export interface IRequestHeader extends IProcedureAddress {
  callId: CallId;
  credential?: Credential | undefined;
  destinationId?: DestinationId | undefined;
  kind: typeof EnvelopeKind.REQUEST;
  opensSubscription?: true | undefined;
  paced?: true | undefined;
  total?: number | undefined;
}

/**
 * A result's header: as a failure's, for the answer that succeeded, and the `total` of a payload it
 * opens a transfer for.
 */
export interface IResultHeader {
  callId: CallId;
  credential?: Announcement | undefined;
  kind: typeof EnvelopeKind.RESULT;
  total?: number | undefined;
}

/**
 * The failures a router raises and answers with, one per protocol code, each saying it is this
 * router's `side`'s.
 */
export interface IRouterFailures extends RouterFailureEntries {
  readonly side: RouterSide;
}

/** How much a router reads, writes and holds. */
export interface IRouterLimits {
  /**
   * The bytes every transfer this router receives holds together, reserved as its credit grants
   * them, and given back when the transfer ends.
   */
  bufferedBytesBudget: number;
  /**
   * A chunk's envelope, its header included, in bytes: a payload whose envelope would be larger is
   * sent as a transfer, in chunks of this size, and a chunk received before the last is refused when
   * smaller. Both ends are set alike.
   */
  chunkBytes: number;
  /** The runs of bytes apart one transfer received may hold before it is whole. */
  maximumChunkRuns: number;
  /** A failure's detail, in bytes, cut at a character's boundary, when written and when read. */
  maximumDetailBytes: number;
  /** A whole envelope, its header included, in bytes, as it comes in and as it goes out. */
  maximumEnvelopeBytes: number;
  /** A whole payload, in bytes, sent in one envelope or as a transfer. */
  maximumPayloadBytes: number;
  /**
   * The transfers a connection receives at once, each until its call ends; 0 sends and takes none.
   * A sender counts none: the peer refuses a transfer past its own.
   */
  maximumTransfers: number;
  /**
   * How long, in milliseconds, a transfer waits for its next chunk or credit before it stalls, from 1
   * to 2³¹ − 1, rounded to the nearest whole one, never 0 nor `Infinity`; and how long, at least, a
   * call that received one keeps its call id once it ends — abandoned by the side that answers,
   * reserved by the requester.
   */
  transferInactivityTimeout: number;
  /** How far past the bytes it received, contiguous, a receiver lets its sender send. */
  windowBytes: number;
}

/**
 * Where a procedure is: its service, and its own number in that service, each a whole number from 1
 * to 65535 that a side declares (spec 16.2); service 0 is the protocol's (16.3).
 */
export interface IProcedureAddress {
  procedureId: ProcedureId;
  serviceId: ServiceId;
}

// types

/** What an answer announces of its connection's session: `OPAQUE`, its token; `NONE`, its end. */
export type Announcement =
  | { scheme: typeof CredentialScheme.NONE }
  | { scheme: typeof CredentialScheme.OPAQUE; token: SessionToken };

/**
 * The call an envelope belongs to, from 1 to 0xffffffff: odd when a client opened it, even when a
 * server did. A subscription's notifications carry the call id of the request that subscribed.
 */
export type CallId = number;

/**
 * A `CREDENTIAL` block: its scheme, and what it holds — an announcement's; a `JWT`'s token, one
 * character per byte, as a relay passes it on; nothing, for `ELSEWHERE`; a scheme to come's bytes,
 * read whole. Tell them apart by `token` or `bytes` first: a scheme to come is any number.
 */
export type Credential =
  | Announcement
  | { scheme: typeof CredentialScheme.JWT; token: string }
  | { scheme: typeof CredentialScheme.ELSEWHERE }
  | { bytes: Uint8Array; scheme: number };

/** What a request is for behind the peer that takes it, from 1 to 0xffffffff; none, the peer. */
export type DestinationId = number;

/**
 * A credential's session's identifier (spec 13.10): a record of its credential scheme and its
 * claim — a `JWT`'s `iss` with its `sid`, else with its `sub`; an `ELSEWHERE`'s verifier's `id`. Two
 * are one when their scheme, their claim's name and their values are equal, octet for octet, so one
 * `sub` under two issuers names two sessions.
 */
export type SessionIdentifier =
  | Readonly<{ id: string; scheme: typeof CredentialScheme.ELSEWHERE }>
  | Readonly<{ issuer: string; scheme: typeof CredentialScheme.JWT; sid: string }>
  | Readonly<{ issuer: string; scheme: typeof CredentialScheme.JWT; sub: string }>;

/**
 * An envelope as it was read: its kind, its header, and its payload — a failure's record, read,
 * for a failure; nothing, for a credit or a cancel.
 */
export type Envelope =
  | { header: IRequestHeader; kind: typeof EnvelopeKind.REQUEST; payload: Uint8Array }
  | { header: IResultHeader; kind: typeof EnvelopeKind.RESULT; payload: Uint8Array }
  | { failure: IReceivedFailure; header: IFailureHeader; kind: typeof EnvelopeKind.FAILURE }
  | { header: INotificationHeader; kind: typeof EnvelopeKind.NOTIFICATION; payload: Uint8Array }
  | { header: IChunkHeader; kind: typeof EnvelopeKind.CHUNK; payload: Uint8Array }
  | { header: ICreditHeader; kind: typeof EnvelopeKind.CREDIT }
  | { header: ICancelHeader; kind: typeof EnvelopeKind.CANCEL };

/** The header of any envelope, as flat as its bytes. */
export type EnvelopeHeader =
  | ICancelHeader
  | IChunkHeader
  | ICreditHeader
  | IFailureHeader
  | INotificationHeader
  | IRequestHeader
  | IResultHeader;

/**
 * Where a failure was raised: here, never sent; by the peer; or beyond a relay, which only passed it
 * on.
 */
export type FailureOrigin = 'local' | 'peer' | 'relayed';

export type ProcedureId = number;

/** An envelope to write: as one read, with a failure to write instead of one read. */
export type OutgoingEnvelope =
  | { header: ICancelHeader; kind: typeof EnvelopeKind.CANCEL }
  | { header: IChunkHeader; kind: typeof EnvelopeKind.CHUNK; payload: Uint8Array }
  | { header: ICreditHeader; kind: typeof EnvelopeKind.CREDIT }
  | { failure: IFailure; header: IFailureHeader; kind: typeof EnvelopeKind.FAILURE }
  | { header: INotificationHeader; kind: typeof EnvelopeKind.NOTIFICATION; payload: Uint8Array }
  | { header: IRequestHeader; kind: typeof EnvelopeKind.REQUEST; payload: Uint8Array }
  | { header: IResultHeader; kind: typeof EnvelopeKind.RESULT; payload: Uint8Array };

/**
 * A header fit to be traced or thrown: a copy, its credential left out, and its scheme said instead
 * when it had one.
 */
export type RedactedHeader = WithoutCredential<EnvelopeHeader> & {
  credentialScheme?: number | undefined;
};

/** One entry per protocol failure a router raises, each keeping its own code. */
type RouterFailureEntries = {
  readonly [Key in keyof FAILURE_KEYS]: IProtocolFailure<FAILURE_KEYS[Key]>;
};

/** Each header of `Header` without its credential, kept apart by kind. */
type WithoutCredential<Header> = Header extends unknown ? Omit<Header, 'credential'> : never;

/** Which side of a connection a router is on: the one that connects, or the one that accepts. */
export type RouterSide = 'client' | 'server';

export type ServiceId = number;

/**
 * A session, as the server announces it: 16 bytes drawn from `crypto`, in unpadded base64url. Only
 * `toSessionToken` and `drawSessionToken` make one.
 */
export type SessionToken = string & { readonly [sessionTokenBrand]: 'SessionToken' };

// ── Router ───────────────────────────────────────────────────────────────────

// what a router is: its core and the port a side gives it, and what a service manager calls

// interfaces

/**
 * A request as its admission sees it: where it came from, its header — never its payload — and the
 * session its call runs in.
 */
export interface IAdmissionRequest<Handle extends string = ConnectionHandle> {
  connectionHandle: Handle;
  header: Readonly<IRequestHeader>;
  /** The call's session, its credential resolved (spec 13.1); none when the call runs in none. */
  session?: ICallSession | undefined;
}

/**
 * The session a call runs in, its credential resolved (spec 13.1): its connection's session, for a
 * call presenting none or that session's `OPAQUE`; a credential's session, for one presenting a
 * `JWT` or an `ELSEWHERE`. Frozen: the call keeps the session it resolved to, whatever befalls its
 * connection's meanwhile.
 */
export interface ICallSession {
  /**
   * What the session holds: a connection's session's data, as its server keeps it; a credential's,
   * the data of the credential the call presented — a `JWT`'s claims set, frozen to its depth, or
   * what an `ELSEWHERE`'s verifier gave.
   */
  readonly data: unknown;
  /**
   * A credential's session's end, in whole milliseconds since the epoch (spec 13.10): the end its
   * connection keeps for its identifier, when it keeps one, else its own; none for a connection's
   * session, and for an `ELSEWHERE` whose verifier gave none.
   */
  readonly end?: number | undefined;
  /** A credential's session's identifier; none for a connection's session. */
  readonly identifier?: SessionIdentifier | undefined;
}

/**
 * What a router keeps of a notification: which procedure it is, and how to trigger it.
 *
 * The words, one meaning each: a registration is one callback; a notification is one per procedure
 * and per side; a subscription is the call left open, named by its call id at both ends. Register
 * and unregister are local; subscribe and unsubscribe happen at the other end; a cancel is the
 * wire's; a notification is dropped when the other end ended its subscription.
 */
export interface INotificationLike extends IProcedure {
  /**
   * The notifications its subscription lets come while their callbacks have not all settled: asked
   * for, the subscription is paced, and each is credited once its callbacks settled. None, each
   * comes as it is sent.
   */
  readonly window?: number | undefined;

  /**
   * What the router calls once it dropped the notification — with its connection, which the other
   * end forgot the subscription with, or with the `failure` the other end ended it with: nothing
   * more reaches the callbacks, and the next registration asks anew.
   */
  drop?: ((failure?: IReceivedFailure) => void) | undefined;
  /**
   * What the router calls with each notification, still encoded; settles as every callback did,
   * the promise each returned too, told apart. Throws a {@link ProgrammerError} when the router has
   * not registered it, and what a callback threw, which the callbacks after it do not hear.
   */
  trigger: (payload: Uint8Array) => Promise<PromiseSettledResult<unknown>[]>;
}

export interface IRequestOptions<Handle extends string = ConnectionHandle> {
  /**
   * Whether the connection it names is closed when it goes unanswered past its timeout; the
   * manager's default when not given. Only a manager that can close a connection — a server's —
   * does.
   */
  closeOnTimeout?: boolean | undefined;
  /**
   * The credential the call presents, for this call alone: `OPAQUE`, the session its router
   * learned — a server's, its connection's — so the call is refused rather than run in another
   * should that one end or be opened anew. None by default: the call runs in whatever session its
   * connection holds. A router that knows no session fails the call before it goes, with
   * `SESSION_REQUIRED`.
   */
  credential?: RequestCredential | undefined;
  /**
   * The connection the request goes to, for a router with more than one: a server's names its
   * client; a client's has one peer, and names none.
   */
  connectionHandle?: Handle | undefined;
  /**
   * What the request is for behind the peer; the peer itself when not given. A router that relays
   * nothing refuses it with `DESTINATION_UNKNOWN`.
   */
  destinationId?: DestinationId | undefined;
  /**
   * What cancels the request: it rejects with a {@link CancelError}, its answer is not waited on,
   * and the peer, once the request went out, is sent a cancel.
   */
  signal?: AbortSignal | undefined;
  /**
   * Milliseconds to wait for the answer; 5 s. While the payload, or its result, goes as a transfer,
   * the transfer's inactivity counts instead, and the timeout counts anew once the payload went.
   * From 1 to 2³¹ − 1, rounded to the nearest whole one, or `Infinity`, which waits on. Any other,
   * 0 among them, rejects with a {@link ProgrammerError}, and the call draws nothing: a manager's
   * call, before it is traced or told deprecated.
   */
  timeout?: number | undefined;
}

/**
 * What answers a request the router hands it, once its payload is whole: a resolver, for one
 * procedure, or a relay's handler, for one destination.
 */
export interface IRequestHandler<Handle extends string = ConnectionHandle> {
  (props: IRequestResolverProps<Handle>): Promise<void>;
  /**
   * Whether a request may reach the handler, asked on its header before its payload is read — or
   * comes, for one that opens a transfer: `undefined` admits it; a failure refuses it, and the router
   * answers with that failure, but for `SESSION_REQUIRED` to a request that presented a credential,
   * which it answers `ACCESS_DENIED`, its detail kept, since the credential may hold and its requester
   * would withdraw it (spec 9.2, step 5); one that throws refuses it as failed, `PROCEDURE_FAILED`,
   * and is reported. A router that asks says so with `isAdmitted`, so it is asked once.
   */
  admit?(request: IAdmissionRequest<Handle>): IFailure | undefined;
  /**
   * Whether it forwards a credential unresolved — a relay's that does not verify (spec 14.3, step
   * 1): a request presenting a `JWT`, or an `ELSEWHERE` its transport carried, reaches its
   * admission in none, every scheme the protocol names taken, and `sessionOf` is not asked; one
   * presenting none or `OPAQUE` resolves as any other.
   */
  forwardsCredentials?: boolean | undefined;
  /**
   * The bytes a payload it takes or answers holds at most, whole or as a transfer: a whole number
   * above 0, and the router's own limit where that one is smaller. The router's alone when not
   * given.
   */
  maximumPayloadBytes?: number | undefined;
}

/**
 * A procedure as a resolver answers it: the router calls it with each request, once its payload is
 * whole, and answers `PROCEDURE_FAILED` for one that fails before it answers.
 */
export interface IRequestResolver<Handle extends string = ConnectionHandle>
  extends IRequestHandler<Handle>, IProcedure {}

/** A request as the router hands it to a resolver: its payload still encoded. */
export interface IRequestResolverProps<Handle extends string = ConnectionHandle> {
  connectionHandle: Handle;
  header: IRequestHeader;
  /** Set by a router that asked the resolver's `admit` already: the resolver asks nothing again. */
  isAdmitted?: true | undefined;
  payload: Uint8Array;
  /** The call's session, as its admission read it; none when the call runs in none. */
  session?: ICallSession | undefined;
  /**
   * Aborted when the call ends before its answer: with a {@link CancelError} when its requester
   * cancels it, with a {@link DisconnectError} when its connection closes or the router is disposed.
   */
  signal: AbortSignal;
  /**
   * What its transport carried beside it, for a request presenting `ELSEWHERE`, which a relay moves
   * to leg B's transport as it came; none for any other, whose transport's credential stays where it
   * came (spec 14.2), and none when nothing was carried. Never handed to a resolver's callback.
   */
  transportCredential?: string | undefined;
}

/** The options of a request, with the manager's defaults applied. */
export interface IResolvedRequestOptions extends IRequestOptions {
  closeOnTimeout?: boolean | undefined;
  /**
   * The call's timeout, or the manager's default, held as the defaults are applied: in whole
   * milliseconds, rounded, or `Infinity`, which waits on.
   */
  timeout: number;
}

/** A result, as a request resolves with it: its header, the call id in it, and its payload. */
export interface IRouterResult {
  header: IResultHeader;
  payload: Uint8Array;
}

/** What both sides of a router do alike, as each side's router builds on it. */
export interface IRouterCore<Handle extends string> {
  /** Whether it was disposed: nothing more goes out, and nothing more waits. */
  readonly isDisposed: boolean;
  /** What it reads, writes and holds by: its options', {@link LIMIT_DEFAULTS}' where they say nothing. */
  readonly limits: IRouterLimits;

  /**
   * The failure the call of a request this side dispatched was answered with, kept once its call
   * closed: so its resolver, answering after it, finds the failure its router answered in its place.
   * None for a request answered otherwise, not yet answered, or never dispatched.
   */
  answeredOf(request: { connectionHandle: Handle; header: IRequestHeader }): IFailure | undefined;
  /**
   * Cancels a call this side opened: one still waiting is rejected with a {@link CancelError}, the
   * peer is sent a cancel, and the call id is reserved for `timeout` — the call's own when it is
   * waiting and none is given — or, once its result came in part, for as long as the peer keeps the
   * call abandoned, should that be longer. A call id reserved already, or a router disposed, sends
   * nothing. A timeout is rounded to the nearest whole millisecond; `Infinity`, a call that waited
   * on, reserves it for the default time; any other that is not from 1 to {@link LONGEST_TIMER}, 0
   * among them, is a {@link ProgrammerError}, and nothing is done.
   */
  cancel(call: ICallAddress<Handle> & { timeout?: number | undefined }): void;
  /**
   * What it holds right now, for diagnosis: its calls waited on and answered, the call ids it
   * reserved, its transfers each way and the bytes they hold, the connections told of a session.
   */
  gauges(): IGauges<Handle>;
  /**
   * Whether the call of a request is still to be answered: once its answer goes out, or it is
   * cancelled, or gone with its connection, it is not. A request this side never dispatched is taken
   * as one to answer.
   */
  isAnswering(request: { connectionHandle: Handle; header: IRequestHeader }): boolean;
  /** Whether this side's `callId` is reserved on `connectionHandle`, since its call ended. */
  isReserved(callId: CallId, connectionHandle: Handle): boolean;
  /**
   * Takes an envelope from `connectionHandle`: read, traced, then dispatched by kind. What does not
   * read is refused under one rule: a request whose prefix reads, of the peer's parity, on a call id
   * neither being answered nor in use, is answered; an answer of this layout ends the call it
   * answers, and a chunk the transfer it was for, while its payload is not whole; anything else is
   * reported, save an answer or a chunk of this layout on a call id reserved, or a chunk on a call
   * abandoned, which is late and dropped in silence. Given as a transport hands it on, the envelope
   * comes with the credential its transport carried beside it, which a request presenting
   * `ELSEWHERE` stands for (spec 15.1); given alone, it came with none.
   */
  receive(message: Data | ITransportMessage, connectionHandle: Handle): void;
  /**
   * Registers a resolver; a procedure off spec section 16 — its ids or its revision out of their
   * range, its name off its form, refused first — a second one for its procedure, or a payload's
   * limit that is not a whole number above 0, is a {@link ProgrammerError}. Its `admit` is asked of each request routed to it, before its payload
   * is read — or comes. Counted, it is declared to the router's metrics — one that has a `notify`
   * as the side that notifies too — and gives its series; a declaration refused is a
   * {@link ProgrammerError}, and nothing is registered.
   */
  registerResolver(resolver: IRequestResolver<Handle>): IResolverSeries | undefined;
  /**
   * Rejects what waits for an answer — from `connectionHandle` only, when given — with a
   * {@link DisconnectError} saying `reason`, and forgets the calls the connection opened, the call
   * ids it reserved, and the session announced to it; then the signal of each call it opened is
   * aborted, with that error as its reason.
   */
  rejectPending(reason: string, connectionHandle?: Handle): void;
  /**
   * Sends a request to `connectionHandle` under a call id of its side's, and resolves with its
   * result; `opensSubscription` flags it as a request that opens a subscription, and `paced` asks
   * for that subscription's notifications as they are credited. `onCallId` hears
   * the call id before the request goes out. `onSent` hears `true` as it is handed to the transport
   * — its transfer's opening, for one — and `false` should the transport refuse it: before `true`,
   * or after `false`, nothing of it was tried. None is drawn once `signal` aborted. Its header
   * presents `credential`, as its side resolved what its options ask, and its transport carries
   * `transportCredential` beside it — beside its opening, for a transfer. A payload too large for one
   * envelope goes as a transfer, as the peer's credit lets it, and a result may come as one; the
   * payload is read until the call settles, and must not change meanwhile. Rejects with a
   * {@link FailureError} for a failure answered, a payload too large — past its procedure's limit
   * or the router's, a transfer where this side sends none, or one whose opening's header passes
   * 1,020 bytes or leaves it no byte — or every call id taken; with a {@link ProgrammerError},
   * drawing nothing, for a procedure's limit that is not a whole number above 0, a timeout no timer
   * holds, or a credential no header of its request holds. Ended once it went out — its timeout
   * passed, a transfer silent too long, its signal aborted, a chunk that cannot go out — it cancels
   * its call, before its caller hears of it.
   */
  request(
    payload: Uint8Array,
    request: {
      connectionHandle: Handle;
      credential?: Credential | undefined;
      onCallId?: ((callId: CallId) => void) | undefined;
      onSent?: ((isHanded: boolean) => void) | undefined;
      opensSubscription?: boolean | undefined;
      options: IResolvedRequestOptions;
      paced?: boolean | undefined;
      procedure: Pick<IProcedure, 'maximumPayloadBytes' | 'procedureId' | 'serviceId'>;
      /**
       * What refuses the call once it started, before it goes: a credential its side cannot
       * present, or its transport carry, a connection not open. It draws nothing.
       */
      refusal?: Error | undefined;
      /** The series a counted call counts into: its requester's; `_OTHER`'s when none is given. */
      series?: IProcedureSeries | undefined;
      transportCredential?: string | undefined;
    }
  ): Promise<IRouterResult>;
  /**
   * Reserves this side's `callId` on `connectionHandle` for `timeout`, rounded to the nearest whole
   * millisecond, or for the default time for none or `Infinity`: the sequence skips it, and what
   * comes late on it is dropped in silence. Reserved twice, the later end stands. Any other timeout
   * that is not from 1 to {@link LONGEST_TIMER}, 0 among them, is a {@link ProgrammerError}, as for
   * {@link IRouterCore.cancel}, and nothing is reserved.
   */
  reserve(call: ICallAddress<Handle> & { timeout?: number | undefined }): void;
  /**
   * Answers a request, on its call id alone, while its call is open; once cancelled, or gone with its
   * connection, nothing goes out. A result too large for one envelope goes as a transfer: the call
   * stays open until its last chunk is handed off, and this settles once that one went. A cancel,
   * the connection gone, a transfer silent too long — the peer told with a failure — or a chunk that
   * cannot go out rejects it. A result past its limit, a transfer where this side sends none, or the
   * result of a call that opens a subscription, which goes in one envelope, is a
   * {@link FailureError}, and nothing goes out. A failure whose code is not an integer from 1 to
   * 65535, or a transfer for a request this side never dispatched, is a {@link ProgrammerError}, and
   * nothing goes out.
   */
  respond(
    response: RouterAnswer,
    request: { connectionHandle: Handle; header: IRequestHeader }
  ): Promise<void>;
  /**
   * Sends an envelope to `connectionHandle`; an answer carries the connection's session when it
   * changed since the last one announced. One past its limits — its payload's, or an envelope's —
   * is a {@link FailureError}, and nothing goes out: it is never cut into a transfer.
   */
  send(envelope: OutgoingEnvelope, connectionHandle: Handle): Promise<void>;
  /**
   * Sends a notification to one subscription, as `send` does, counting it into `series`, when
   * given: sent once its transport has it, whatever the transport does with it after; failed when
   * it could not be handed to it.
   */
  sendNotification(
    payload: Uint8Array,
    subscription: ICallAddress<Handle> & { series?: INotifyingSeries | undefined }
  ): Promise<void>;
  /**
   * Rejects what still waits, aborts the signal of each call it still answers, and sends nothing
   * more: no cancel either.
   */
  [Symbol.dispose](): void;
}

/** How a router's core is built, beyond its port. */
export interface IRouterCoreOptions {
  /**
   * The clock its timers run on — a call's timeout, a call id's reservation, a transfer's inactivity
   * — and its reservations' ends are read on; the platform's when not given.
   */
  clock?: IClock | undefined;
  /** The last call id it draws before its first again; its side's last when not given. */
  lastCallId?: CallId | undefined;
  /**
   * What it counts its calls through: its router's, attached to the registry that router was given;
   * none counts nothing.
   */
  metrics?: IRouterMetrics | undefined;
  /**
   * How much it reads, writes and holds: {@link LIMIT_DEFAULTS}' where these say nothing. They must
   * hold together, or the core is a {@link ProgrammerError}: whole numbers, positive but for the
   * transfers and the detail; an envelope of 64 bytes at least; a chunk from 64 bytes to an
   * envelope; a window of two chunks at least; a payload within the budget; a transfer's
   * inactivity from 1 to 2³¹ − 1 milliseconds, held rounded to the nearest whole one.
   */
  limits?: RouterLimitsOptions | undefined;
}

/**
 * What sets one side of a router apart, for its core: its failures, how it sends, the session its
 * answers announce, and what it hears of what the core does.
 *
 * The core calls it in this order. An envelope that reads is traced, then dispatched by kind: a
 * request asks `isCallIdInUse`, then — one that names a destination — `handlerOfDestination`, then
 * — its credential of a scheme the side takes — `sessionOf`, then its handler's `admit`, on the
 * call's session, then — one that opens a subscription — `isTwoWay`, then goes to its handler
 * once its payload is whole; a result or a failure
 * is shown to `onAnswerReceived`, then paired with its request, and a failure no call waits on is
 * offered to `onUnpairedFailure`; a notification goes to `onNotification`; a cancel to `onCancel`.
 * An answer is shown to `beforeAnswer`, then written — whole, or as a transfer's opening and its
 * chunks — with the session `sessionTokenOf` gives, each envelope traced and sent; should it not go
 * out, what `beforeAnswer` returned undoes what it did. `activity` hears a request sent and a
 * response taken; `report`, what no call waits on.
 *
 * The client's side takes notifications, answers received and failures unpaired; the server's
 * sees each answer before it goes out, takes cancels, and gives sessions. Both say which call ids
 * they hold beyond the core's.
 */
export interface IRouterCorePort<Handle extends string> {
  /**
   * The credential schemes the side takes besides `OPAQUE`, which it always does: `JWT`,
   * `ELSEWHERE`, each resolved by `sessionOf` in a later turn. None when not given: a request
   * presenting any other is refused with `CREDENTIAL_UNSUPPORTED`, whose detail names those taken.
   */
  readonly credentialSchemes?: readonly CredentialScheme[] | undefined;
  readonly failures: IRouterFailures;

  /** What the router did: sent a request, or took the response to one. */
  activity(activity: RouterActivity, connectionHandle: Handle): void;
  /**
   * Whether the side holds `callId` for `connectionHandle` beyond what the core waits on — a
   * subscription, say: the core draws none of these, and refuses a request on one.
   */
  isCallIdInUse?(callId: CallId, connectionHandle: Handle): boolean;
  /**
   * The handler of a request that names `destinationId`, asked once its call id is taken: a relay's,
   * which passes the request on. Without it, or when it gives none, the request is refused with
   * `DESTINATION_UNKNOWN`: this peer relays nothing.
   */
  handlerOfDestination?(destinationId: DestinationId): IRequestHandler<Handle> | undefined;
  /**
   * Whether a connection carries both ways — what this side sends of its own, a notification, a
   * command, as well as its answers — asked of a request that opens a subscription, once admitted:
   * on one that does not, it is refused with `SUBSCRIPTION_UNSUPPORTED`. Every connection does,
   * without it.
   */
  isTwoWay?(connectionHandle: Handle): boolean;
  /**
   * An answer about to be written — a failure or not — the handler its request was routed to, and
   * the call's session its admission read; what it returns undoes what it did, should the answer
   * not go out.
   */
  beforeAnswer?(answer: {
    connectionHandle: Handle;
    header: IRequestHeader;
    isFailure: boolean;
    resolver: IRequestHandler<Handle> | undefined;
    session: ICallSession | undefined;
  }): (() => void) | undefined;
  /**
   * A cancel from `connectionHandle`, once the call it cancels, if open, is forgotten and before its
   * signal is aborted: what the side keeps under that call id — a subscription — goes with it. It
   * may name no call at all, having crossed its answer.
   */
  onCancel?(callId: CallId, connectionHandle: Handle): void;
  /** A notification from `connectionHandle`; a side that takes none leaves it out. */
  onNotification?(
    header: INotificationHeader,
    notification: { connectionHandle: Handle; payload: Uint8Array }
  ): void;
  /**
   * A credit from `connectionHandle` that counts notifications: how many the subscription under its
   * call id lets this side have sent. A side that sends none leaves it out.
   */
  onSubscriptionCredit?(header: ICreditHeader, connectionHandle: Handle): void;
  /** Every result and every failure received, before it is paired with its request. */
  onAnswerReceived?(header: IFailureHeader | IResultHeader, connectionHandle: Handle): void;
  /**
   * A failure that answers no call waiting: one that ends a call the side keeps open once it was
   * answered — a subscription the other end ended — which the side says it took; `false`, or none,
   * reports it as answering nothing, unless it is late, on a call id reserved. A result is never
   * offered.
   */
  onUnpairedFailure?(
    envelope: { failure: IReceivedFailure; header: IFailureHeader },
    connectionHandle: Handle
  ): boolean;
  /** Whether anyone listens to the envelopes traced: nothing is built for `trace` otherwise. */
  isTracing(): boolean;
  /** What went wrong that no call waits on. */
  report(error: Error, connectionHandle: Handle): void;
  /**
   * Hands an envelope's bytes over to the transport, for `connectionHandle`, with the credential it
   * carries beside them, when it carries one.
   */
  send(
    message: { credential?: string | undefined; data: Uint8Array },
    connectionHandle: Handle
  ): Promise<unknown>;
  /**
   * The call's session a request's credential resolves to, asked once per request, its call id
   * held, as {@link SessionOf} says — never for an `ELSEWHERE` its transport carried nothing beside,
   * which no credential came for — but for a rejection with a {@link CapacityError}, a bound of the
   * side's own, which the router answers `CAPACITY_EXCEEDED` and reports nowhere. None when not
   * given: a request presenting none runs in none, and one presenting a credential is refused with
   * `SESSION_REQUIRED`.
   */
  sessionOf?(request: ISessionRequest<Handle>, signal: AbortSignal): ReturnType<SessionOf<Handle>>;
  /**
   * The session of `connectionHandle`, which its next answer announces when it changed; `undefined`
   * for none. Asked for each answer only; what it throws fails that answer. None when not given.
   */
  sessionTokenOf?(connectionHandle: Handle): SessionToken | undefined;
  /** Each envelope, out or in, its header redacted. */
  trace(
    direction: DebugDirection,
    envelope: { connectionHandle: Handle; header: RedactedHeader }
  ): void;
}

/**
 * The part of a router a service manager calls: it triggers the notifications registered, calls
 * the resolvers registered, and names the failures its side raises. One manager serves both sides,
 * so each router refuses the half that is not its own: a server notifies and subscribes, and holds
 * no notification; a client holds notifications, and notifies nobody.
 */
export interface IRouterLike<Handle extends string = ConnectionHandle> {
  /** The clock it runs on, its transport's, which what is built on it runs on too. */
  readonly clock: IClock;
  readonly failures: IRouterFailures;

  /**
   * The failure the router answered a request with in its resolver's place — a server's, as the
   * subscription the request opens queued past its bounds (spec 11.10) — read as its resolver
   * answers, whose answer then goes nowhere; none while the request is its resolver's to answer.
   */
  answeredOf(
    request: Pick<IRequestResolverProps<Handle>, 'connectionHandle' | 'header'>
  ): IFailure | undefined;
  /**
   * Declares a requester of `procedure` to the router's metrics, as it is made, and gives the series
   * each of its calls carries to `request`; none when the router counts nothing. A procedure off
   * spec section 16, refused first, or a declaration its registry refuses, is a
   * {@link ProgrammerError}.
   */
  declareRequester(procedure: IProcedure): IProcedureSeries | undefined;
  /** Whether the router holds this notification — this one, not another of its procedure. */
  hasNotification(notification: INotificationLike): boolean;
  /**
   * Sends a notification's payload to each subscription its procedure holds that `filter` keeps; or,
   * given why its value does not write (spec 17.2, item 6), sends it to none, counts it failed for
   * each of them, and reports why once.
   */
  notify(
    payload: Uint8Array | Error,
    notification: {
      /**
       * Whether a subscription gets it, by its subscriber: its connection and the session that
       * holds it; each does when not given.
       */
      filter?: ((subscriber: ISubscriber<Handle>) => boolean) | undefined;
      /** What it replaces, queued for a paced subscription: the one of the same key. */
      key?: NotificationKey | undefined;
      procedure: IProcedureAddress;
    }
  ): Promise<unknown>;
  /**
   * Registers a notification; a procedure off spec section 16, refused first, rejects with a
   * {@link ProgrammerError}, as one already registered does.
   */
  registerNotification(notification: INotificationLike): Promise<unknown>;
  registerResolver(resolver: IRequestResolver<Handle>): unknown;
  /**
   * Reports what went wrong that no call waits on through the router's `error` event — with the
   * connection it came with, on a server: a debug listener that threw, say.
   */
  report(error: Error, connectionHandle?: Handle): void;
  /**
   * Sends a request and resolves with its result. With `subscribes` — the notification the router
   * holds for the procedure — the call subscribes it: the request says it opens a subscription, and
   * what comes under its call id triggers the notification. It fails by the promise it gives, never
   * by a throw: the manager tells the call's `tx` step once it returns, so a router that throws
   * loses that step.
   */
  request(
    payload: Uint8Array,
    request: {
      /**
       * Hears the call's id once the router drew it, before the request goes; a call refused before
       * it draws one is never heard. A router that never calls it leaves each step of its calls
       * naming no call, as a call refused before its id does.
       */
      onCallId?: ((callId: CallId) => void) | undefined;
      options: IResolvedRequestOptions;
      procedure: IProcedure;
      /** The series its requester's declaration gave; a call that carries none counts as `_OTHER`. */
      series?: IProcedureSeries | undefined;
      subscribes?: INotificationLike | undefined;
    }
  ): Promise<IRouterResult>;
  respond(
    response: RouterAnswer,
    request: Pick<IRequestResolverProps<Handle>, 'connectionHandle' | 'header'>
  ): Promise<void>;
  /**
   * Subscribes the connection a request came from to that request's procedure, in the call's
   * session, which bounds it, and gives the call id of the subscription: a server's router does; a
   * client's, which notifies nobody, cannot. A request that opens no subscription is a
   * {@link ProgrammerError}: its requester asked for an answer alone. A connection closed, or a
   * router disposed, is a {@link DisconnectError}; a call its requester cancelled, or one answered
   * already, a {@link CancelError}.
   */
  subscribe(
    request: Pick<IRequestResolverProps<Handle>, 'connectionHandle' | 'header' | 'session'>
  ): CallId;
  /**
   * Unregisters a notification, and unbinds the call it is bound to: unless `cancel` is `false` — its
   * subscription taken away already, acknowledged — the peer is sent a cancel, so it holds nothing
   * under that call id either. The call id is reserved either way, so what was on its way to it is
   * dropped in silence.
   */
  unregisterNotification(
    notification: INotificationLike,
    options?: { cancel?: boolean | undefined }
  ): Promise<unknown>;
}

/** Where a call is: the connection it is on, and its call id there. */
export interface ICallAddress<Handle extends string = ConnectionHandle> {
  callId: CallId;
  connectionHandle: Handle;
}

/**
 * A request as `sessionOf` resolves its credential: where it came from, its header — the credential
 * it presents among it — and the credential its transport carried beside it.
 */
export interface ISessionRequest<Handle extends string = ConnectionHandle> {
  connectionHandle: Handle;
  header: Readonly<IRequestHeader>;
  /**
   * What its transport carried beside it, which an `ELSEWHERE` stands for (spec 15.1): over HTTP,
   * its `POST`'s `Authorization`, as it came; none when nothing was carried.
   */
  transportCredential?: string | undefined;
}

/**
 * Who holds a subscription: a connection, in a session of its own — a credential's, named by its
 * identifier; its connection's session, which a call presenting none runs in, none.
 */
export interface ISubscriber<Handle extends string = ConnectionHandle> {
  readonly connectionHandle: Handle;
  readonly identifier?: SessionIdentifier | undefined;
}

// types

/** Who a request came from, as the router names it. */
export type ConnectionHandle = string;

export type DebugDirection = 'rx' | 'tx';

/** What a notification is about, for a paced subscription to keep the latest of each. */
export type NotificationKey = number | string;

/** A router's limits as its options give them: each one it leaves out, or `undefined`, the default. */
export type RouterLimitsOptions = { [Key in keyof IRouterLimits]?: IRouterLimits[Key] | undefined };

/** What a router did: sent or took a request, a response, or a notification. */
export type RouterActivity = 'notification' | 'request' | 'response';

/**
 * The credential a call presents, among its options: `NONE`, none whatever the default; `OPAQUE`,
 * the session its router learned; a `JWT`, its token; an `ELSEWHERE`, what its transport carries
 * beside the request — over HTTP, its `Authorization` — its header writing the scheme alone.
 */
export type RequestCredential =
  | DefaultCredential
  | Readonly<{ scheme: typeof CredentialScheme.NONE }>
  | Readonly<{ scheme: typeof CredentialScheme.OPAQUE }>;

/**
 * A credential a client presents by default (spec 13.4): a `JWT`, or an `ELSEWHERE` with what its
 * transport carries beside each request. Never `OPAQUE`, which a call asks for alone.
 */
export type DefaultCredential =
  | Readonly<{ carried: string; scheme: typeof CredentialScheme.ELSEWHERE }>
  | Readonly<{ scheme: typeof CredentialScheme.JWT; token: string }>;

/**
 * What an `ELSEWHERE`'s verifier settles with for a credential that holds (spec 13.11): its `id`,
 * which names its session with the scheme, its data, which the call carries, and its end, in
 * milliseconds since the epoch, held rounded up to a whole one; none for a session without one.
 */
export interface IElsewhereSession {
  readonly data?: unknown;
  readonly end?: number | undefined;
  readonly id: string;
}

/**
 * What a side resolves a request's `JWT` and `ELSEWHERE` with (spec 9.2, step 5): a `JWT`'s keys,
 * each with its issuer and its one algorithm, its audience, and the key set the side asks for the
 * keys of an issuer it names; an `ELSEWHERE`'s verifier. The side takes a `JWT` once given keys or a
 * key set, and an `ELSEWHERE` once given its verifier; it verifies on the clock it runs on.
 */
export interface ICredentials {
  /**
   * The audience a `JWT` names for this side (RFC 7519 §4.1.3); one that names none is refused.
   * Given with keys or a key set, whatever the side's relay does: keys without one are a
   * {@link ProgrammerError}, as the side is built, since a request to the side itself would hold its
   * token to no audience.
   */
  readonly audience?: string | undefined;
  /** The keys a `JWT` is verified with (spec 13.8), held for good. */
  readonly keys?: readonly IJwtKey[] | undefined;
  /** The key set the side asks for the keys of the issuers it names (spec 13.9). */
  readonly keySet?: IJwtKeySet | undefined;
  /**
   * The `ELSEWHERE` verifier: given what its call's transport carried, whole, and its call's signal,
   * it settles with the credential's session, or with none when the credential does not hold. Asked
   * once per request whose transport carried a credential, in a later turn. One that throws or
   * rejects, or settles with an `id` that is no string or an `end` that is no number within
   * ±(2⁵³ − 1), fails the call, reported.
   */
  readonly verify?:
    | ((
        carried: string,
        signal: AbortSignal
      ) => IElsewhereSession | undefined | PromiseLike<IElsewhereSession | undefined>)
    | undefined;
}

/**
 * A key set (RFC 7517 §5), the application's to fetch, given with the issuers it answers for, one at
 * least: the side asks it for no other, compared octet for octet, so a token whose `iss` it does not
 * name is judged at once by the keys there are. Asked once a minute at most for an issuer, when a
 * token's `kid` names none of its issuer's keys that serve — or, without a `kid`, when none of its
 * issuer's keys serve — its answer is held for that issuer ten minutes, in place of the last. An
 * ask's signal aborts at its deadline, a minute after it went, on the monotonic reading. One that
 * throws or rejects, answers what is not keys shaped for their algorithms, or is unsettled as its
 * deadline is reached fails the calls that wait on it, and replaces no key held. A call past the
 * `maximumWaitingCalls` that wait for one issuer's deadline is refused `CAPACITY_EXCEEDED`, and
 * nothing is reported (spec 13.9).
 */
export interface IJwtKeySet {
  /** Asked for one of its issuers, with a signal, that issuer's keys, which it may wait for. */
  readonly ask: (issuer: string, signal: AbortSignal) => PromiseLike<readonly IJwtSetKey[]>;
  /** The issuers it answers for, one at least, each a string. */
  readonly issuers: readonly string[];
  /**
   * The most calls that wait for one issuer's deadline at once, each issuer's apart, a call on its
   * ask under way never counted: a whole number from 1 to 2³¹ − 1, 64 when not given. Any other is a
   * {@link ProgrammerError}, as the side is built.
   */
  readonly maximumWaitingCalls?: number | undefined;
}

/** A key a key set answers for the issuer it was asked for: a JWK, and its one algorithm. */
export interface IJwtSetKey {
  readonly algorithm: JwtAlgorithm;
  readonly jwk: Jwk;
}

/**
 * The call's session a request's credential resolves to (spec 9.2, step 5): its connection's
 * session, for none or that session's `OPAQUE`, compared in constant time, in the turn the request
 * came, never a promise; a credential's, for a `JWT` or an `ELSEWHERE`, which may wait, and is
 * waited on in a later turn whether it waits or not. `undefined` runs a call presenting none in
 * none, and refuses one presenting a credential with `SESSION_REQUIRED`; what throws or rejects
 * refuses it with `PROCEDURE_FAILED`, reported. `signal` is aborted once the call ends while its
 * credential resolves — its requester cancelled it, its connection closed — so a verifier stops:
 * what it settles to then is dropped.
 */
export type SessionOf<Handle extends string = ConnectionHandle> = (
  request: ISessionRequest<Handle>,
  signal: AbortSignal
) => ICallSession | undefined | PromiseLike<ICallSession | undefined>;

/**
 * What a call of a procedure takes after its payload: options a server's router must have, naming
 * the connection the call goes to; a client's, or a router's whose handle is any string, may go
 * without.
 */
export type RequestOptionsParameters<Handle extends string> = string extends Handle
  ? [options?: IRequestOptions<Handle>]
  : // bracketed, so a union of handles — a server's, of every transport — stays one handle
    [Handle] extends [ServerConnectionHandle]
    ? [options?: Omit<IRequestOptions<never>, 'closeOnTimeout' | 'connectionHandle'>]
    : [options: IRequestOptions<Handle> & { connectionHandle: Handle }];

/** An answer for the router to send: a payload, or a failure. */
export type RouterAnswer =
  | { failure: IFailure; payload?: undefined }
  | { failure?: undefined; payload: Uint8Array };

/** How a client's router names its one peer, the server, which every request reaching it comes from. */
export type ServerConnectionHandle = 'server';

// ── Service manager ──────────────────────────────────────────────────────────

// what a service manager makes: requesters, resolvers and notifications, and what it tells

// interfaces

/**
 * A call bound to its payload: called with its options, it goes. Never a promise: awaiting it, its
 * options' call forgotten, is a compile error (TS1320), where it would send nothing.
 */
export interface IBoundCall<Result, Options extends unknown[] = RequestOptionsParameters<string>> {
  (...options: Options): Promise<Result>;
  /** Never set: what makes awaiting the bound call, its options' call forgotten, TS1320. */
  readonly then?: (guard: never) => never;
}

/**
 * A subscribing call bound to its payload and its callback: called with its options, it registers
 * the callback, as {@link INotification} says.
 */
export type IRegistrar = IBoundCall<
  INotificationRegistration,
  [options?: Pick<IRequestOptions, 'destinationId' | 'signal' | 'timeout'>]
>;

/**
 * Which `debug` events a listener hears: those of a direction and a type among the ones given — any,
 * when none is — whose procedure's name matches one pattern of `include`, when there is one, and
 * none of `exclude`, which wins. A pattern is a name, whole, where `*` stands for any run of
 * characters, line terminators among them, and an ASCII letter for itself in either case; any other
 * character stands for itself alone.
 */
export interface IDebugFilter {
  directions?: readonly DebugDirection[] | undefined;
  exclude?: readonly string[] | undefined;
  include?: readonly string[] | undefined;
  /** The kinds of envelope a router's `debug` tells of; a call's listener does not ask. */
  kinds?: readonly EnvelopeKind[] | undefined;
  types?: readonly DebugType[] | undefined;
}

/** What one step of a call told whoever listens to `debug`. */
export interface IDebugEvent {
  /**
   * Its call's id, as its envelopes carry it: a call made's once its router drew it, a request
   * received's from its header; `undefined` for a call refused before its id was drawn, and for a
   * notification, which goes to each subscription under that one's id. OpenTelemetry's
   * `jsonrpc.request.id`, at its Development status.
   */
  callId: CallId | undefined;
  /**
   * The connection its call is on, as its envelopes name it, `server` on a client; `undefined` where
   * the step names no call: a call refused before its id was drawn, a notification.
   */
  connectionHandle: string | undefined;
  direction: DebugDirection;
  /**
   * How long the call took once it answered, in whole milliseconds of its router clock's monotonic
   * reading, a fraction dropped; `undefined` before, and for a notification. A span's duration, as
   * .NET's `Activity.Duration` and an OpenTelemetry span carry it.
   */
  duration: number | undefined;
  options: IResolvedRequestOptions | undefined;
  procedureId: ProcedureId;
  procedureName: string;
  /** What came in, decoded; a copy. */
  rx: unknown;
  serviceId: ServiceId;
  serviceRevision: ServiceRevision;
  /**
   * When the call started, in milliseconds since the epoch on its router clock's wall reading; a
   * notification, one step, starts as it is sent or heard. A span's start, as .NET's
   * `Activity.StartTimeUtc` and an OpenTelemetry span's start time carry it.
   */
  startedAt: number;
  /** What went out, decoded; a copy. */
  tx: unknown;
  type: DebugType;
}

/**
 * A procedure whose answer is a subscription: each call registers a callback for its
 * notifications, and resolves to what takes it away.
 */
export interface INotification<RequestPayload, NotificationPayload> extends INotificationLike {
  (
    requestPayload: RequestPayload,
    callback: (notification: NotificationPayload) => unknown
  ): IRegistrar;
}

export interface INotificationDependencies<RequestPayload, ResponsePayload, NotificationPayload> {
  serializer: INotificationSerializerClient<RequestPayload, ResponsePayload, NotificationPayload>;
  /**
   * Tells the other end to stop notifying, given the call id of the subscription and the answer that
   * made it — the request to unsubscribe with that call id, say. The last registration taken away
   * calls it and waits for it before the router unregisters the notification, so none comes for it
   * after; without it, or when it fails, the router cancels the call that subscribed, and what was
   * on its way meanwhile is dropped in silence.
   */
  unsubscribe?: ((callId: CallId, response: ResponsePayload) => Promise<unknown>) | undefined;
  /**
   * Asks for the subscription paced: at most this many notifications come while their callbacks —
   * the promises they return included — have not all settled, a whole number above 0. One lets a
   * callback that fetches hear nothing meanwhile, then the latest; more let that many come at once.
   * None, each comes as it is sent.
   */
  window?: number | undefined;
}

/** How a notification's callback answers: as any callback does, and it may subscribe first. */
export interface INotificationResponse<Payload, Failure extends ResolverFailure> extends IResponse<
  Payload,
  Failure
> {
  /**
   * Subscribes the requester to this procedure now, and gives the call id of the subscription: the
   * request's own when it is the connection's first subscription to this procedure, and otherwise
   * the one it holds already. A failure answer undoes it; after the answer, or for a request that
   * opens no subscription — an ordinary request to this procedure — it is a
   * {@link ProgrammerError}. A successful answer to a request that opens one subscribes it all the
   * same.
   */
  registerNotification(): CallId;
}

/** One callback registered for a notification. */
export interface INotificationRegistration {
  /**
   * Takes the callback away; the last one taken away unsubscribes, through the notification's
   * `unsubscribe` when it has one, then unregisters the notification from the router. Rejects with
   * what `unsubscribe` does, once the router unregistered it all the same.
   */
  unregister(): Promise<void>;
  /** What `await using` calls: {@link INotificationRegistration.unregister}. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** A request resolver that can also notify. */
export interface INotificationResolver<
  NotificationPayload,
  Handle extends string = ConnectionHandle,
> extends IRequestResolver<Handle> {
  /**
   * Sends `notification` to whoever the router notifies of this procedure — those `options` keep —
   * and resolves once the router has tried each of them; a paced subscription past its credit
   * queues it instead, and the transport has it later. A router that cannot notify, as a
   * client's, rejects, and that is only told to `debug`; a server's reports each connection it
   * could not reach to its own `error`, with the connection. A value that does not write goes to
   * none: a server's router counts it failed for each subscription it was for and reports why once,
   * and it resolves all the same (spec 17.2, item 6).
   */
  notify: (notification: NotificationPayload, options?: INotifyOptions<Handle>) => Promise<void>;
}

export interface INotificationResolverDependencies<
  RequestPayload,
  ResponsePayload,
  NotificationPayload,
  Handle extends string = ConnectionHandle,
> extends IRequestResolverDependencies<RequestPayload, ResponsePayload, Handle> {
  serializer: INotificationSerializerServer<RequestPayload, ResponsePayload, NotificationPayload>;
}

/** What the side that answers a request reads and writes, notifications included. */
export interface INotificationSerializerServer<
  RequestPayload,
  ResponsePayload,
  NotificationPayload,
> extends IRequestSerializerServer<RequestPayload, ResponsePayload> {
  encodeNotification: (notification: NotificationPayload) => Uint8Array;
}

/** What the side that sends a request writes and reads, notifications included. */
export interface INotificationSerializerClient<
  RequestPayload,
  ResponsePayload,
  NotificationPayload,
> extends IRequestSerializerClient<RequestPayload, ResponsePayload> {
  decodeNotification: (notification: Uint8Array) => NotificationPayload;
}

/**
 * A procedure as a requester calls it: its payload, then the options of that call —
 * which, on a server's router, name the connection it goes to.
 */
export interface IRequest<
  RequestPayload,
  ResponsePayload,
  Handle extends string = ConnectionHandle,
> extends IProcedure {
  (requestPayload: RequestPayload): IBoundCall<ResponsePayload, RequestOptionsParameters<Handle>>;
}

export interface IRequestDependencies<RequestPayload, ResponsePayload> {
  serializer: IRequestSerializerClient<RequestPayload, ResponsePayload>;
}

/** Whom a notification goes to, among those subscribed to it, and what it replaces. */
export interface INotifyOptions<Handle extends string = ConnectionHandle> {
  /** A connection left out: the one whose request made the change, say. */
  exclude?: Handle | undefined;
  /**
   * Whether a subscription gets it, by its subscriber — its connection and the session that holds
   * it: those of one user, say. One argument, so what a subscriber holds may grow without breaking
   * a filter.
   */
  filter?: ((subscriber: ISubscriber<Handle>) => boolean) | undefined;
  /**
   * What it is about — the entity whose state it carries, say — for a paced subscription: queued
   * past its credit, it replaces the one queued under the same key, in its place. None, it is queued
   * last. The server's own: it never travels.
   */
  key?: NotificationKey | undefined;
}

/**
 * Whether a request may reach its callback, on its header alone, before its payload is read: `true`
 * lets it through, anything else refuses it, with `refusal` when the function carries one, and with
 * `ACCESS_DENIED` otherwise.
 */
export interface IBeforeRequest<Handle extends string = ConnectionHandle> {
  (request: IAdmissionRequest<Handle>): boolean;
  /** What a refused request is answered with: an entry of the router's own table. */
  readonly refusal?: AdmissionFailure | undefined;
}

/** A request as a resolver's callback receives it: decoded, and frozen. */
export interface IRequestProps<Payload, Handle extends string = ConnectionHandle> {
  connectionHandle: Handle;
  header: Readonly<IRequestHeader>;
  payload: Readonly<Payload>;
  /** The call's session, as its admission read it; none when the call runs in none. */
  session?: ICallSession | undefined;
  /**
   * Aborted when the call ends before its answer — its requester cancelled it, its connection closed
   * — so the callback may stop: its answer would go nowhere, and what it throws then is no one's to
   * hear of. A listener that throws is an uncaught exception, in Node as elsewhere.
   */
  signal: AbortSignal;
}

export interface IRequestResolverDependencies<
  RequestPayload,
  ResponsePayload,
  Handle extends string = ConnectionHandle,
> {
  /**
   * Whether the request may reach the callback, asked on its header before its payload is read — the
   * router asks it, or the resolver itself, for a router that does not; a {@link ProgrammerError}
   * when the resolver is made, for a `refusal` that is not an admission failure of the router's own
   * side.
   */
  beforeRequest?: IBeforeRequest<Handle> | undefined;
  serializer: IRequestSerializerServer<RequestPayload, ResponsePayload>;
}

/**
 * How the side that sends a request writes it and reads the answer. A failure is the router's to
 * read.
 */
export interface IRequestSerializerClient<RequestPayload, ResponsePayload> {
  decode: (response: Uint8Array) => ResponsePayload;
  encode: (request: RequestPayload) => Uint8Array;
}

/**
 * How the side that answers a request reads it and writes the answer. A failure is the router's to
 * write.
 */
export interface IRequestSerializerServer<RequestPayload, ResponsePayload> {
  decode: (request: Uint8Array) => RequestPayload;
  encode: (response: ResponsePayload) => Uint8Array;
}

/** How a callback answers: with a payload, or with `null` and a failure. */
export interface IResponse<Payload, Failure extends ResolverFailure> {
  (response: Payload): Promise<void>;
  (response: null, failure: Failure): Promise<void>;
}

/** One procedure of one service, which names what is made for it. */
export interface IProcedure extends IProcedureAddress {
  /**
   * Present when the procedure is on its way out: a requester emits `deprecated` at each call, and
   * `message` says what to use instead, when it says.
   */
  deprecation?: { message?: string | undefined } | undefined;
  /**
   * The bytes a payload of the procedure holds at most, its request's and its result's, whole or as
   * a transfer: a whole number above 0, and the router's own limit where that one is smaller. The
   * router's alone when not given.
   */
  maximumPayloadBytes?: number | undefined;
  /**
   * Its kind, how it is called (spec 16.11), which each router holds its declaration to; none given,
   * nothing checks it. Never an envelope's kind, which is `REQUEST` for every call, nor a debug
   * event's `type`, which is a step's.
   */
  procedureKind?: ProcedureKind | undefined;
  /**
   * Its name, which labels what a side traces and counts and never travels: a lower-case ASCII
   * letter, then 62 ASCII letters and digits at most (spec 16.4); two names equal once their ASCII
   * letters are read in one case are one (16.6).
   */
  procedureName: string;
  /**
   * Which revision of its service the procedure is, for `debug` and to tell two asks apart; it does
   * not travel. A revision, not a version: the version is the protocol's, as its layout byte says.
   * A count of its service's releases, from 1 to 2³¹ − 1 (spec 16.2, 16.9); 0, which a relay's leg
   * B holds, is no revision a side declares.
   */
  serviceRevision: ServiceRevision;
}

export interface IServiceManagerOptions<Handle extends string = ConnectionHandle> {
  /**
   * The clock its traces read: its router's, which one given must be; the platform's when neither
   * has one.
   */
  clock?: IClock | undefined;
  /**
   * Closes a connection that let a request naming it — a command — go unanswered, when the call's
   * `closeOnTimeout`, or the manager's default, says so. A server gives it; a client has no
   * connection to name.
   */
  closeConnection?: ((connectionHandle: Handle) => void) | undefined;
  /**
   * What a call's options leave out: {@link REQUEST_DEFAULTS}' where these do too, and no close. Its
   * timeout is held as a call's, as the manager is built: rounded to the nearest whole millisecond,
   * `Infinity` to wait on, and a {@link ProgrammerError} for any other not from 1 to 2³¹ − 1, 0
   * among them.
   */
  defaults?:
    | (Partial<Pick<IResolvedRequestOptions, 'timeout'>> & {
        closeOnTimeout?: boolean | undefined;
      })
    | undefined;
}

/**
 * The resolvers and requesters of the services on one router; `Handle` is how that router names who
 * a request came from.
 */
export interface IServiceManager<Handle extends string = ConnectionHandle> {
  /**
   * Whether anyone listens to `debug`: the calls read no clock and build nothing for it otherwise,
   * the one check each makes.
   */
  readonly isDebugging: boolean;

  emit<K extends SERVICE_MANAGER_EVENTS>(event: K, ...params: ServiceManagerEventMap[K]): boolean;
  /**
   * Every `event` from now on, as its arguments, for `for await`; the signal, a `break` or a throw
   * ends it.
   */
  events<K extends SERVICE_MANAGER_EVENTS>(
    event: K,
    options?: IEventIteratorOptions
  ): AsyncIterableIterator<ServiceManagerEventMap[K], undefined>;
  /**
   * A procedure whose answer is a subscription. One request goes out however many callbacks
   * register at once; once registered, a callback joins without a request. The same procedure
   * gives the same notification, since the router holds one per procedure; asking for it off spec
   * section 16, checked first, or under another kind, name, revision, deprecation, payload limit or
   * window — unpaced and paced are two — is a {@link ProgrammerError}. A registration cancelled or
   * timed out once its request went out cancels its call, so the other end holds no subscription for
   * it. The serializer of the first ask is the one kept: one procedure's payloads are one
   * procedure's.
   */
  getNotification<RequestPayload, ResponsePayload, NotificationPayload>(
    procedure: IProcedure,
    dependencies: INotificationDependencies<RequestPayload, ResponsePayload, NotificationPayload>
  ): INotification<RequestPayload, NotificationPayload>;
  /** As {@link IServiceManager.getRequestResolver}, with a `notify` on the resolver. */
  getNotificationResolver<
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
  ): (
    callback: NotificationResolverCallback<RequestPayload, ResponsePayload, Failure, Handle>
  ) => INotificationResolver<NotificationPayload, Handle>;
  /**
   * A command: a procedure the server asks one client to run, on a server's router — its request
   * names the connection it goes to, which the types require. The same as
   * {@link IServiceManager.getRequest} on the wire; told to `debug` as a `command`.
   */
  getCommand<RequestPayload, ResponsePayload>(
    procedure: IProcedure,
    dependencies: IRequestDependencies<RequestPayload, ResponsePayload>
  ): IRequest<RequestPayload, ResponsePayload, Handle>;
  /**
   * What runs a command, on a client's router: the server's request, answered as
   * {@link IServiceManager.getRequestResolver} answers one; told to `debug` as a `command`.
   */
  getCommandResolver<
    RequestPayload,
    ResponsePayload,
    Failure extends ResolverFailure = ResolverFailure,
  >(
    procedure: IProcedure,
    dependencies: IRequestResolverDependencies<RequestPayload, ResponsePayload, Handle>
  ): (
    callback: RequestResolverCallback<RequestPayload, ResponsePayload, Failure, Handle>
  ) => IRequestResolver<Handle>;
  /**
   * A procedure to call; a deprecated one emits `deprecated` at each call. A call whose value does
   * not write fails before anything goes, and is neither traced nor deprecated: no call is made.
   */
  getRequest<RequestPayload, ResponsePayload>(
    procedure: IProcedure,
    dependencies: IRequestDependencies<RequestPayload, ResponsePayload>
  ): IRequest<RequestPayload, ResponsePayload, Handle>;
  /**
   * A procedure to answer: given its callback, the resolver is made and registered in the router.
   * A procedure off spec section 16 is a {@link ProgrammerError}, before any other reason. A request
   * `beforeRequest` refuses — before its payload is read — or whose payload does not decode, is
   * answered with a failure of the router's without reaching the callback.
   */
  getRequestResolver<
    RequestPayload,
    ResponsePayload,
    Failure extends ResolverFailure = ResolverFailure,
  >(
    procedure: IProcedure,
    dependencies: IRequestResolverDependencies<RequestPayload, ResponsePayload, Handle>
  ): (
    callback: RequestResolverCallback<RequestPayload, ResponsePayload, Failure, Handle>
  ) => IRequestResolver<Handle>;
  off<K extends SERVICE_MANAGER_EVENTS>(
    event: K,
    listener: EmitterListener<ServiceManagerEventMap[K]>
  ): this;
  on<K extends SERVICE_MANAGER_EVENTS>(
    event: K,
    listener: EmitterListener<ServiceManagerEventMap[K]>
  ): this;
  once<K extends SERVICE_MANAGER_EVENTS>(
    event: K,
    listener: EmitterListener<ServiceManagerEventMap[K]>
  ): this;
  removeAllListeners(event?: SERVICE_MANAGER_EVENTS): this;
}

// types

/** What `beforeRequest` may refuse with: a session required, or an access denied. */
export type AdmissionFailure = IProtocolFailure<
  typeof ProtocolCode.ACCESS_DENIED | typeof ProtocolCode.SESSION_REQUIRED
>;

/** What a call is: a request, a notification, or a command — a request the server makes of a client. */
export type DebugType = 'command' | 'notification' | 'request';

export type NotificationResolverCallback<
  RequestPayload,
  ResponsePayload,
  Failure extends ResolverFailure,
  Handle extends string = ConnectionHandle,
> = (
  request: IRequestProps<RequestPayload, Handle>,
  response: INotificationResponse<ResponsePayload, Failure>
) => Promise<void>;

/** What a resolver answers a failure with: its procedure's own, or a refusal of admission. */
export type ResolverFailure = AdmissionFailure | IApplicationFailure;

export type RequestResolverCallback<
  RequestPayload,
  ResponsePayload,
  Failure extends ResolverFailure,
  Handle extends string = ConnectionHandle,
> = (
  request: IRequestProps<RequestPayload, Handle>,
  response: IResponse<ResponsePayload, Failure>
) => Promise<void>;

/** Event name → the arguments its listeners receive. */
export type ServiceManagerEventMap = {
  /**
   * `error` is what the call failed with, or `null`; on a `tx` step, why its `tx` did not go out — a
   * notification that could not go, an answer its router refused, told again at its start, or none,
   * from a resolver that failed before it answered. What a listener throws is reported through the
   * router's `error` — with the call's connection, on a server — and changes nothing of the call.
   */
  debug: [error: unknown, info: IDebugEvent];
  /** A deprecated procedure was called; its `deprecation` says what to use instead, when it says. */
  deprecated: [procedure: IProcedure];
  /**
   * A notification was dropped: its callbacks hear nothing more, and a registration asks anew.
   * `failure` is what the other end ended its subscription with — its session ended, its queue past
   * its bounds — and `undefined` when it went with its connection.
   */
  dropped: [procedure: IProcedure, failure: IReceivedFailure | undefined];
};

/**
 * A `debug` filter as it is given: a filter, its spec, or what gives either — asked at each event,
 * as an environment variable read afresh is; `undefined`, or an empty spec, keeps every event.
 */
export type DebugFilterSource = IDebugFilter | string | (() => IDebugFilter | string | undefined);

export type ServiceManagerOnDebugCallback = EmitterListener<ServiceManagerEventMap[DEBUG_EVENT]>;

export type ServiceManagerOnDeprecatedCallback = EmitterListener<
  ServiceManagerEventMap[DEPRECATED_EVENT]
>;

export type ServiceManagerOnDroppedCallback = EmitterListener<
  ServiceManagerEventMap[DROPPED_EVENT]
>;

export type ServiceRevision = number;

/** The events a service manager emits, named by the table that types them. */
export type SERVICE_MANAGER_EVENTS = keyof ServiceManagerEventMap;
