// ── Router core ───────────────────────────────────────────────────────────────

// dependencies

import { PLATFORM_CLOCK, type TimeoutId } from '../../transport/shared/clock';
import { CancelError, ProgrammerError, toError } from '../../transport/shared/errors';
import { mergeGauges } from '../../transport/shared/gauges';
import { noop } from '../../transport/shared/noop';
import type { Data, ITransportMessage } from '../../transport/shared/types';
import { createAnsweringCalls } from './answering-calls';
import { credentialSchemesDetailOf } from './call-session';
import { CredentialScheme, EnvelopeKind, EnvelopeLayout } from './constants';
import { bytesOf, readEnvelope, writeFailure } from './envelope';
import { CapacityError, DisconnectError, FailureError, redactHeader } from './errors';
import { readPrefix } from './header';
import { sideOfCallId } from './identifiers';
import { checkDeclaration } from './identity';
import { CallEnding, endingOf, type IResolverSeries, microsecondsOf } from './metrics-registry';
import { createPayloadPlacement, isPayloadLimit } from './payload-placement';
import type { ChunkEnvelope } from './payload-placement';
import { createProcedureMap } from './procedure-map';
import { createReceivingTransfers, type IReceiving } from './receiving-transfers';
import { limitsOf } from './router-limits';
import { createRouterRequester } from './router-requester';
import { createRouterWriter, DISPOSED } from './router-writer';
import { createSendingTransfers } from './sending-transfers';
import { ChunkOutcome, type IChunk, type IOutgoingTransfer } from './transfer';
import type {
  CallId,
  Credential,
  Envelope,
  IAdmissionRequest,
  ICallAddress,
  ICallSession,
  IEnvelopePrefix,
  IFailure,
  IRequestHandler,
  IRequestHeader,
  IRequestResolver,
  IResultHeader,
  IRouterCore,
  IRouterCoreOptions,
  IRouterCorePort,
  IRouterFailures,
  OutgoingEnvelope,
  RouterSide,
  SessionOf,
} from './types';

// interfaces

/**
 * A request of the peer's as this side dispatches it: its connection, its header, its controller,
 * what its transport carried beside it, and the call's session once its credential resolved.
 */
interface IDispatched<Handle extends string> {
  connectionHandle: Handle;
  controller: AbortController;
  header: IRequestHeader;
  session?: ICallSession | undefined;
  transportCredential?: string | undefined;
}

/** A request routed to its handler, with its payload as it came: a transfer's opening, for one. */
interface IRouted<Handle extends string> {
  readonly dispatched: IDispatched<Handle>;
  readonly payload: Uint8Array;
  readonly resolver: IRequestHandler<Handle>;
}

/**
 * A request whose payload comes in a transfer: as it is dispatched once whole, to its resolver, and
 * the end of the credit its transfer granted so far.
 */
interface IRequestReceiving<Handle extends string> {
  readonly creditEnd: number;
  readonly dispatched: IDispatched<Handle>;
  readonly resolver: IRequestHandler<Handle>;
  readonly transfer: IReceiving<Handle>;
}

/** A resolver registered, and the series its calls count into when the router counts. */
interface IRegistered<Handle extends string> {
  readonly resolver: IRequestResolver<Handle>;
  readonly series: IResolverSeries | undefined;
}

// constants

// SESSION_REQUIRED's details at a credential's resolution, which the spec states: one came and did
// not hold, or none came
const CREDENTIAL_NOT_HELD = 'the credential does not hold';
const NO_CREDENTIAL = 'no credential came';

// the schemes a handler that forwards credentials unresolved takes: every one the protocol names
const FORWARDED_SCHEMES: ReadonlySet<number> = new Set([
  CredentialScheme.OPAQUE,
  CredentialScheme.JWT,
  CredentialScheme.ELSEWHERE,
]);

// helpers

/**
 * `reason` as the failure it is, or as an envelope malformed in a way the codec did not name, its
 * words for the side's report alone (spec 9.0).
 */
const failureOf = (reason: unknown, failures: Pick<IRouterFailures, 'envelopeMalformed'>) => {
  return reason instanceof FailureError
    ? reason
    : new FailureError(
        { ...failures.envelopeMalformed, detail: toError(reason).message },
        { cause: reason }
      );
};

/** Whether every byte of a transfer came. */
const isWhole = ({ incoming }: IReceiving<string>): boolean => {
  return incoming.contiguous === incoming.total;
};

/** Whether `value` is a promise, or anything that settles as one. */
const isThenable = (value: unknown): value is PromiseLike<unknown> => {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function';
};

/** Whether a request presenting `credential` resolves in a later turn: a `JWT` or an `ELSEWHERE`. */
const resolvesLater = (credential: Credential | undefined): boolean => {
  return (
    credential?.scheme === CredentialScheme.JWT || credential?.scheme === CredentialScheme.ELSEWHERE
  );
};

/** `message` as a transport hands it on: an envelope alone carried nothing beside it. */
const messageOf = (message: Data | ITransportMessage): ITransportMessage => {
  return typeof message === 'object' &&
    !ArrayBuffer.isView(message) &&
    !(message instanceof ArrayBuffer) &&
    'data' in message
    ? message
    : { data: message };
};

/** The side at the other end of a connection. */
const peerOf = (side: RouterSide): RouterSide => {
  return side === 'client' ? 'server' : 'client';
};

// definition

/**
 * What both sides of a router do alike: write what goes out, take what comes in — read, checked,
 * traced, then dispatched by kind — pair each result and failure with its request by call id, send
 * a payload too large for one envelope as a transfer and put together one that comes as a transfer,
 * and hand each request to the resolver registered for it. What sets a side apart is its `port`:
 * its failures, how it sends, the session its answers announce, the call ids it holds, what it does
 * with a notification, and what an answer does first.
 */
export const createRouterCore = <Handle extends string>(
  port: IRouterCorePort<Handle>,
  options?: IRouterCoreOptions
): IRouterCore<Handle> => {
  const { failures } = port;
  const clock = options?.clock ?? PLATFORM_CLOCK;
  const metrics = options?.metrics;
  const limits = limitsOf(options?.limits);
  const placement = createPayloadPlacement(failures, limits);
  const {
    chunkEnvelopeOf,
    payloadBytesPerChunk,
    payloadLimitOf,
    tooLargeOf,
    transferOf,
    wholeBytes,
  } = placement;
  const receivings = createReceivingTransfers<Handle>({
    clock,
    failures,
    limits,
    payloadBytesPerChunk,
    sendCredit: ({ callId, connectionHandle }, creditEnd) => {
      sendReporting(
        { header: { callId, creditEnd, kind: EnvelopeKind.CREDIT }, kind: EnvelopeKind.CREDIT },
        connectionHandle
      );
    },
  });
  const sendings = createSendingTransfers<Handle>();
  const answeringCalls = createAnsweringCalls<Handle, IRequestReceiving<Handle>>({
    clock,
    limits,
    onRemove: ({ transfer }) => {
      receivings.close(transfer);
    },
  });
  const writer = createRouterWriter(port, {
    isDisposed: () => {
      return isDisposed;
    },
    limits,
    tooLargeOf,
  });
  const { deliver, sendReporting } = writer;
  // the credential schemes this side takes, OPAQUE always, and the detail that names them
  const schemesTaken: ReadonlySet<number> = new Set([
    CredentialScheme.OPAQUE,
    ...(port.credentialSchemes ?? []),
  ]);
  const unsupported = {
    ...failures.credentialUnsupported,
    detail: credentialSchemesDetailOf(schemesTaken),
  };
  const unforwarded = {
    ...failures.credentialUnsupported,
    detail: credentialSchemesDetailOf(FORWARDED_SCHEMES),
  };
  const resolvers = createProcedureMap<IRegistered<Handle>>();
  // the handler each request was routed to, by the very header dispatched: its answer is written by
  // that one's limit, whatever else holds the same address
  const handlers = new WeakMap<IRequestHeader, IRequestHandler<Handle>>();
  // the call's session each request was admitted in, by the very header dispatched, for what its
  // answer does first
  const callSessions = new WeakMap<IRequestHeader, ICallSession>();
  // the failure each request dispatched was answered with, by the very header dispatched: one its
  // router answered in its resolver's place, which its resolver's answer tells (debugging 4.2)
  const failuresAnswered = new WeakMap<IRequestHeader, IFailure>();

  let isDisposed = false;

  // what the core raises itself, for the side to hear
  const report = (
    failure: IFailure,
    {
      cause,
      connectionHandle,
      detail,
      envelope,
    }: {
      cause?: unknown;
      connectionHandle: Handle;
      detail?: string | undefined;
      envelope: Envelope;
    }
  ): void => {
    port.report(
      new FailureError(
        { ...failure, ...(detail === undefined ? {} : { detail }) },
        { cause, header: envelope.header }
      ),
      connectionHandle
    );
  };

  const requester = createRouterRequester(
    {
      failures,
      isDisposed: () => {
        return isDisposed;
      },
      isCallIdInUse: (callId, connectionHandle) => {
        return port.isCallIdInUse?.(callId, connectionHandle) === true;
      },
      report: (error, connectionHandle) => {
        port.report(error, connectionHandle);
      },
      reportFailure: (failure, details) => {
        report(failure, details);
      },
      activity: (kind, connectionHandle) => {
        port.activity(kind, connectionHandle);
      },
      onAnswerReceived: (header, connectionHandle) => {
        port.onAnswerReceived?.(header, connectionHandle);
      },
      onUnpairedFailure: (envelope, connectionHandle) => {
        return port.onUnpairedFailure?.(envelope, connectionHandle) === true;
      },
      receiveUnplaced: (envelope, unplaced) => {
        receiveUnplaced(envelope, unplaced);
      },
    },
    {
      clock,
      lastCallId: options?.lastCallId,
      limits,
      metrics,
      placement,
      receivings,
      sendings,
      writer,
    }
  );

  // whether a call id is the peer's to open on this connection, and free: a refusal on it is answered
  const isAnswerable = (callId: CallId, connectionHandle: Handle): boolean => {
    return (
      sideOfCallId(callId) === peerOf(failures.side) &&
      !answeringCalls.has({ callId, connectionHandle }) &&
      port.isCallIdInUse?.(callId, connectionHandle) !== true
    );
  };

  // answers a request whose header does not read, at the gate: a call of _OTHER's, counted, that
  // starts and ends in one turn, as its answer is handed off — or, should it not be, as an error
  const refuseUnread = (
    refusal: Extract<OutgoingEnvelope, { kind: typeof EnvelopeKind.FAILURE }>,
    connectionHandle: Handle
  ): void => {
    const series = metrics?.otherServer;

    if (series === undefined) {
      return (sendReporting(refusal, connectionHandle), undefined);
    }

    series.start();

    const startedAt = clock.performance.now();
    let isEnded = false;
    const end = (ending: CallEnding): void => {
      if (!isEnded) {
        isEnded = true;
        series.end(ending, microsecondsOf(clock.performance.now() - startedAt));
      }
    };

    deliver(refusal, {
      connectionHandle,
      onHandOff: () => {
        end(endingOf(refusal.failure));
      },
    }).catch((reason: unknown) => {
      end(CallEnding.ERROR);
      port.report(toError(reason), connectionHandle);
    });
  };

  // a result as a transfer: its opening, then each chunk credited; its call stays open until the
  // last chunk is handed off, and the answer goes out once that one did, which ends the call
  const sendResult = (
    outgoing: IOutgoingTransfer,
    {
      connectionHandle,
      controller,
      header,
      request,
    }: {
      connectionHandle: Handle;
      controller: AbortController;
      header: IResultHeader;
      request: IRequestHeader;
    }
  ): Promise<void> => {
    const { callId } = header;
    const call = { callId, connectionHandle };
    const { promise, reject, resolve } = Promise.withResolvers<void>();
    let isOpen = true;
    let timer: TimeoutId | undefined;

    // nothing more goes, and nothing more ends it
    const stop = (): void => {
      isOpen = false;
      sendings.close(sending);
      clock.clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    };
    // the call goes with it: its call id is the peer's to open again
    const fail = (reason: unknown): void => {
      stop();
      answeringCalls.close(call, controller);
      reject(reason);
    };
    // the call's signal ends it: a cancel, the connection gone
    const onAbort = (): void => {
      stop();
      reject(controller.signal.reason);
    };
    // what the transfer does sets its timer going again — never once it stopped, by what came back as
    // a send went; nothing waits on it: it keeps no process alive
    const progress = (): void => {
      if (!isOpen) {
        return;
      }

      clock.clearTimeout(timer);
      // silent too long, it ends, and the peer is told
      timer = clock.setTimeout(() => {
        const stalled = {
          ...failures.transferStalled,
          detail: `no credit came for ${String(limits.transferInactivityTimeout)} milliseconds`,
        };

        if (metrics !== undefined) {
          answeringCalls.end({ connectionHandle, header: request }, stalled.code);
        }

        fail(new FailureError(stalled, { header }));
        sendReporting(
          {
            failure: stalled,
            header: { callId, kind: EnvelopeKind.FAILURE },
            kind: EnvelopeKind.FAILURE,
          },
          connectionHandle
        );
      }, limits.transferInactivityTimeout);
      // a browser's timer has no `unref`
      (timer as { unref?: () => unknown }).unref?.();
    };
    // kept before its opening goes, so a credit that comes back as it goes finds it
    const sending = sendings.open(outgoing, {
      call,
      onCredit: progress,
      send: (chunk) => {
        deliver(chunkEnvelopeOf(callId, chunk), {
          connectionHandle,
          // the last one handed off answers the call
          onHandOff: chunk.isLast
            ? () => {
                stop();

                if (metrics !== undefined) {
                  answeringCalls.end({ connectionHandle, header: request }, CallEnding.RESULT);
                }

                answeringCalls.close(call, controller);
              }
            : progress,
        }).then(() => {
          if (chunk.isLast) {
            resolve();
          }
        }, fail);
      },
    });

    controller.signal.addEventListener('abort', onAbort, { once: true });
    progress();
    deliver(
      {
        header: { ...header, total: outgoing.total },
        kind: EnvelopeKind.RESULT,
        payload: outgoing.opening,
      },
      { connectionHandle }
    ).catch(fail);

    return promise;
  };

  // how a result goes, decided before anything is done for it: whole — `undefined` — or as a
  // transfer on the call it answers, which it keeps open; it throws as `respond` says
  const resultTransferOf = (
    payload: Uint8Array,
    {
      controller,
      header,
      maximumPayloadBytes,
      request,
    }: {
      controller: AbortController | undefined;
      header: IResultHeader;
      maximumPayloadBytes: number;
      request: IRequestHeader;
    }
  ): { controller: AbortController; outgoing: IOutgoingTransfer } | undefined => {
    const outgoing = transferOf(payload, { header, maximumPayloadBytes });

    if (outgoing === undefined) {
      return undefined;
    }

    if ('code' in outgoing) {
      throw new FailureError(outgoing, { header });
    }

    if (request.opensSubscription === true) {
      throw new FailureError(
        {
          ...failures.payloadTooLarge,
          detail: `a subscription's result goes in one envelope, of ${String(wholeBytes)} bytes at most`,
        },
        { header }
      );
    }

    if (controller === undefined) {
      throw new ProgrammerError(
        `a result goes as a transfer only on a call this router dispatched, not on call ${String(request.callId)}`
      );
    }

    return { controller, outgoing };
  };

  const respond: IRouterCore<Handle>['respond'] = async (
    response,
    { connectionHandle, header }
  ) => {
    const { callId, procedureId, serviceId } = header;

    // a failure's code must be one before anything is done for it
    if (response.failure !== undefined) {
      writeFailure(response.failure);
    }

    // the call this answer is for, when this side dispatched its request; an answer to any other
    // header ends no call
    const controller = answeringCalls.controllerOf(header);

    // a call its requester cancelled, its connection took away, or whose call id another request
    // opened since, is answered by nothing: the answer would settle a call it does not belong to;
    // once disposed, the answer goes on, to reject with a DisconnectError
    if (!isDisposed && !answeringCalls.isAnswering({ connectionHandle, header })) {
      return;
    }

    // an answer names its call alone: never its procedure, never its destination
    const result: IResultHeader = { callId, kind: EnvelopeKind.RESULT };
    // the handler its request was routed to; a copy of a header finds its procedure's, and a request
    // to a destination never a resolver of this side's
    const resolver =
      handlers.get(header) ??
      (header.destinationId === undefined
        ? resolvers.get({ procedureId, serviceId })?.resolver
        : undefined);
    const transfer =
      response.failure === undefined
        ? resultTransferOf(response.payload, {
            controller,
            header: result,
            maximumPayloadBytes: payloadLimitOf(resolver),
            request: header,
          })
        : undefined;
    const undo = port.beforeAnswer?.({
      connectionHandle,
      header,
      isFailure: response.failure !== undefined,
      resolver,
      session: callSessions.get(header),
    });

    // its answer going out: a second goes nowhere, and this one closes the call once done
    answeringCalls.answer({ connectionHandle, header });

    if (controller !== undefined && response.failure !== undefined) {
      failuresAnswered.set(header, response.failure);
    }

    // a whole answer ends its call as its transport has it
    const ending =
      metrics === undefined || response.failure === undefined
        ? CallEnding.RESULT
        : endingOf(response.failure);

    try {
      await (transfer === undefined
        ? deliver(
            response.failure === undefined
              ? { header: result, kind: EnvelopeKind.RESULT, payload: response.payload }
              : {
                  failure: response.failure,
                  header: { callId, kind: EnvelopeKind.FAILURE },
                  kind: EnvelopeKind.FAILURE,
                },
            {
              connectionHandle,
              // answered: the call id is the peer's to open again
              onHandOff: () => {
                if (controller !== undefined) {
                  // * counted, it ends as its transport has it; uncounted, nothing is built for it
                  if (metrics !== undefined) {
                    answeringCalls.end({ connectionHandle, header }, ending);
                  }

                  answeringCalls.close({ callId, connectionHandle }, controller);
                }
              },
            }
          )
        : sendResult(transfer.outgoing, {
            connectionHandle,
            controller: transfer.controller,
            header: result,
            request: header,
          }));
    } catch (reason) {
      // an answer that did not go out leaves nothing done for it behind, and its call closed
      undo?.();

      if (controller !== undefined) {
        answeringCalls.close({ callId, connectionHandle }, controller);
      }

      throw reason;
    }
  };

  // a refusal answers a request of the peer's; the answer that cannot go out is reported
  const refuse = (
    failure: IFailure,
    { connectionHandle, controller, header }: IDispatched<Handle>
  ): void => {
    respond({ failure }, { connectionHandle, header }).catch((reason: unknown) => {
      // a refusal that never reached the transport — its failure unwritable, say — leaves no call
      // open behind it
      answeringCalls.close({ callId: header.callId, connectionHandle }, controller);
      port.report(toError(reason), connectionHandle);
    });
  };

  // hands a request to its resolver: one that throws before it returns fails as one that rejects,
  // reported unless its call was cancelled or went with its connection
  const dispatch = (
    resolver: IRequestHandler<Handle>,
    dispatched: IDispatched<Handle> & { payload: Uint8Array }
  ): void => {
    const { connectionHandle, controller, header, payload, session, transportCredential } =
      dispatched;
    const fail = (reason: unknown): void => {
      const isAnswering = answeringCalls.isAnswering({ connectionHandle, header });

      if (!controller.signal.aborted) {
        port.report(toError(reason), connectionHandle);
      }

      // ! a resolver that fails before it answers is answered PROCEDURE_FAILED, so its requester
      // does not wait out its timeout (spec 9.5); a call cancelled, or gone with its connection, is
      // answered nothing, and one answered keeps its answer
      if (isAnswering && !controller.signal.aborted) {
        return (refuse(failures.procedureFailed, dispatched), undefined);
      }

      if (isAnswering) {
        answeringCalls.close({ callId: header.callId, connectionHandle }, controller);
      }
    };

    // admitted already, before its payload was read: the resolver asks nothing again
    try {
      resolver({
        connectionHandle,
        header,
        isAdmitted: true,
        payload,
        session,
        signal: controller.signal,
        ...(transportCredential === undefined ? {} : { transportCredential }),
      }).catch(fail);
    } catch (reason) {
      fail(reason);
    }
  };

  // what refuses a request before its payload is read — or comes: its resolver's admission, on its
  // header; one that throws refuses it as failed, and is reported
  const refusalOf = (
    resolver: IRequestHandler<Handle>,
    request: IAdmissionRequest<Handle>
  ): IFailure | undefined => {
    let refusal: IFailure | undefined;

    try {
      refusal = resolver.admit?.(request);
    } catch (reason) {
      port.report(toError(reason), request.connectionHandle);

      return failures.procedureFailed;
    }

    const { sessionRequired } = failures;

    // ! never SESSION_REQUIRED to a call that presented a credential, whatever its handler: the
    // credential may hold, and its requester would withdraw it (spec 9.2, step 5)
    if (
      refusal?.scope !== sessionRequired.scope ||
      refusal.code !== sessionRequired.code ||
      request.header.credential === undefined
    ) {
      return refusal;
    }

    return refusal.detail === undefined
      ? failures.accessDenied
      : { ...failures.accessDenied, detail: refusal.detail };
  };

  // a chunk that did not read ends the transfer it was for, as invalid — unless its payload came
  // whole already; on a call id reserved or abandoned, it is late, and dropped in silence; anywhere
  // else, it is reported
  const gateChunk = (
    failure: FailureError,
    {
      callId,
      connectionHandle,
      isReported = false,
    }: ICallAddress<Handle> & { isReported?: boolean }
  ): void => {
    const call = { callId, connectionHandle };

    if (sideOfCallId(callId) === failures.side) {
      return (
        requester.gateMalformedResultChunk(failure, { callId, connectionHandle, isReported }),
        undefined
      );
    } else {
      const invalid = { ...failures.chunkInvalid, detail: failure.detail };
      const receiving = answeringCalls.receivingOf(call);

      if (receiving !== undefined && !isWhole(receiving.transfer)) {
        return (refuse(invalid, receiving.dispatched), undefined);
      }

      if (answeringCalls.abandonedEndOf(call) !== undefined) {
        return;
      }
    }

    if (!isReported) {
      port.report(failure, connectionHandle);
    }
  };

  // what did not read: a request of the peer's on a free call id is answered; a response or a chunk
  // of this layout ends the call or the transfer it is for; anything else is reported, once
  const gate = (
    failure: FailureError,
    {
      connectionHandle,
      isReported = false,
      prefix,
    }: { connectionHandle: Handle; isReported?: boolean; prefix: IEnvelopePrefix }
  ): void => {
    const { callId, kind, layout } = prefix;

    // a request of the peer's, on a call id free?
    if (kind === EnvelopeKind.REQUEST && isAnswerable(callId, connectionHandle)) {
      const refusal: OutgoingEnvelope = {
        failure,
        header: { callId, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      };

      return (refuseUnread(refusal, connectionHandle), undefined);
    }

    // a chunk of this layout, of a transfer this side receives?
    if (kind === EnvelopeKind.CHUNK && layout === EnvelopeLayout.FIRST) {
      return (gateChunk(failure, { callId, connectionHandle, isReported }), undefined);
    }

    // an answer of this layout, to a call waiting?
    if (
      (kind === EnvelopeKind.RESULT || kind === EnvelopeKind.FAILURE) &&
      layout === EnvelopeLayout.FIRST
    ) {
      return (
        requester.gateMalformedAnswer(failure, { callId, connectionHandle, isReported }), undefined
      );
    }

    if (!isReported) {
      port.report(failure, connectionHandle);
    }
  };

  // a cancel from the peer ends a call it opened: forgotten first, so an answer from what hears the
  // signal finds no call to answer, then offered to the side, then the signal aborted
  const receiveCancel = (
    envelope: Extract<Envelope, { kind: typeof EnvelopeKind.CANCEL }>,
    connectionHandle: Handle
  ): void => {
    const { callId } = envelope.header;

    if (sideOfCallId(callId) === failures.side) {
      const detail = `call ${String(callId)} is this side's, which the peer cannot cancel`;

      return (
        report(failures.envelopeMalformed, { connectionHandle, detail, envelope }), undefined
      );
    }

    const controller = answeringCalls.take({ callId, connectionHandle });

    port.onCancel?.(callId, connectionHandle);
    controller?.abort(new CancelError(`call ${String(callId)} was cancelled by its requester`));
  };

  // a request admitted on the call's session, then where it goes: refused — a subscription where
  // nothing goes back, a payload past its limit, a transfer's opening refused — dispatched, or its
  // transfer opened, whose first credit goes only now
  const admitRouted = ({ dispatched, payload, resolver }: IRouted<Handle>): void => {
    const { connectionHandle, header, session, transportCredential } = dispatched;
    const { callId, total } = header;
    const refusal = refusalOf(resolver, {
      connectionHandle,
      header,
      session,
      ...(transportCredential === undefined ? {} : { transportCredential }),
    });

    if (refusal !== undefined) {
      return (refuse(refusal, dispatched), undefined);
    }

    if (session !== undefined) {
      callSessions.set(header, session);
    }

    // admitted, one that opens a subscription where nothing this side sends of its own goes is
    // refused: no notification could reach it — a transfer's opening too, before any credit
    if (header.opensSubscription === true && port.isTwoWay?.(connectionHandle) === false) {
      const detail = 'this connection carries no notification back';

      return (refuse({ ...failures.subscriptionUnsupported, detail }, dispatched), undefined);
    }

    // admitted, past its procedure's limit — or the router's, which it narrows — it is refused: a
    // transfer on the total it declares, before any credit
    const maximumPayloadBytes = payloadLimitOf(resolver);
    const length = total ?? payload.length;

    if (length > maximumPayloadBytes) {
      return (refuse(tooLargeOf(length, maximumPayloadBytes), dispatched), undefined);
    }

    if (total === undefined) {
      return (dispatch(resolver, { ...dispatched, payload }), undefined);
    }

    // a transfer's opening is not its payload: refused once routed, before any credit goes;
    // opened, its call waits on the rest, which one silent too long ends
    const transfer = receivings.open(payload, {
      call: { callId, connectionHandle },
      onStall: () => {
        const detail = `nothing came for ${String(limits.transferInactivityTimeout)} milliseconds`;

        refuse({ ...failures.transferStalled, detail }, dispatched);
      },
      total,
    });

    if ('code' in transfer) {
      return (refuse(transfer, dispatched), undefined);
    }

    // kept before its first credit goes, so a chunk that credit brings at once finds it
    answeringCalls.attach(
      { callId, connectionHandle },
      {
        get creditEnd() {
          return transfer.incoming.creditEnd;
        },
        dispatched,
        resolver,
        transfer,
      }
    );
    receivings.grant(transfer);
  };

  // the call's session, as `SessionOf` says, then its admission on it; while it resolves, its call
  // id stays held, and what settles once its call ended is dropped
  const resolveSession = (routed: IRouted<Handle>): void => {
    const { dispatched, resolver } = routed;
    const { connectionHandle, controller, header, transportCredential } = dispatched;
    const { credential } = header;
    const { signal } = controller;

    const settle = (session: ICallSession | undefined): void => {
      // a credential that does not hold refuses its call, whatever the procedure requires
      if (session === undefined && credential !== undefined) {
        const detail = CREDENTIAL_NOT_HELD;

        return (refuse({ ...failures.sessionRequired, detail }, dispatched), undefined);
      }

      admitRouted({ ...routed, dispatched: { ...dispatched, session } });
    };
    // a bound of the side's own refuses the call: nothing failed, so nothing is reported
    const fail = (reason: unknown): void => {
      if (reason instanceof CapacityError) {
        const detail = reason.message;

        return (refuse({ ...failures.capacityExceeded, detail }, dispatched), undefined);
      }

      port.report(toError(reason), connectionHandle);
      refuse(failures.procedureFailed, dispatched);
    };

    const isLater = resolvesLater(credential);

    // an ELSEWHERE its transport carried nothing beside has nothing to resolve: no credential came,
    // in a later turn all the same
    if (credential?.scheme === CredentialScheme.ELSEWHERE && transportCredential === undefined) {
      return (
        queueMicrotask(() => {
          if (!signal.aborted) {
            refuse({ ...failures.sessionRequired, detail: NO_CREDENTIAL }, dispatched);
          }
        }),
        undefined
      );
    }

    // a JWT, or an ELSEWHERE carried, that its handler forwards resolves to none here, its
    // destination's to verify, in a later turn all the same
    if (isLater && resolver.forwardsCredentials === true) {
      return (
        queueMicrotask(() => {
          if (!signal.aborted) {
            admitRouted(routed);
          }
        }),
        undefined
      );
    }

    let resolution: ReturnType<SessionOf<Handle>>;

    try {
      resolution = port.sessionOf?.(
        {
          connectionHandle,
          header,
          ...(transportCredential === undefined ? {} : { transportCredential }),
        },
        signal
      );
    } catch (reason) {
      if (!isLater) {
        return (fail(reason), undefined);
      }

      resolution = Promise.reject(toError(reason));
    }

    if (isLater) {
      // ! a later turn, whether it waits, throws or not, so the order of answers never turns on a
      // verifier
      return (
        void Promise.resolve(resolution).then(
          (session) => {
            if (!signal.aborted) {
              settle(session);
            }
          },
          (reason: unknown) => {
            if (!signal.aborted) {
              fail(reason);
            }
          }
        ),
        undefined
      );
    }

    // none and OPAQUE resolve in the turn they came: a promise for one breaks that, and what it
    // settles to is dropped
    if (isThenable(resolution)) {
      void Promise.resolve(resolution).catch(noop);

      return (
        fail(
          new ProgrammerError(
            'sessionOf resolves a request presenting none or OPAQUE in the turn it came, never by a promise'
          )
        ),
        undefined
      );
    }

    settle(resolution);
  };

  const receiveRequest = (
    envelope: Extract<Envelope, { kind: typeof EnvelopeKind.REQUEST }>,
    {
      connectionHandle,
      transportCredential,
    }: { connectionHandle: Handle; transportCredential: string | undefined }
  ): void => {
    const { header, payload } = envelope;
    const { callId, destinationId, procedureId, serviceId } = header;
    const request = { connectionHandle, header };

    // a request of this side's own parity, or on a call id in use, would answer another call
    if (sideOfCallId(callId) === failures.side) {
      const detail = `call ${String(callId)} is this side's to open, not the peer's`;

      return (
        report(failures.envelopeMalformed, { connectionHandle, detail, envelope }), undefined
      );
    }

    if (
      answeringCalls.has({ callId, connectionHandle }) ||
      port.isCallIdInUse?.(callId, connectionHandle) === true
    ) {
      const detail = `call ${String(callId)} is open already`;

      return (
        report(failures.envelopeMalformed, { connectionHandle, detail, envelope }), undefined
      );
    }

    // the resolver it is routed to, whose series it counts into: _OTHER's for any other
    const registered = destinationId === undefined ? resolvers.get(header) : undefined;
    // * its call starts as its request opens it, timed from its arrival
    const controller = answeringCalls.open(
      request,
      metrics === undefined ? undefined : (registered?.series?.calls ?? metrics.otherServer)
    );
    // ! what its transport carried stands for ELSEWHERE alone, and stays here for any other: its
    // sessionOf, its admission and its resolver are handed nothing beside it (spec 15.1)
    const carried =
      header.credential?.scheme === CredentialScheme.ELSEWHERE ? transportCredential : undefined;
    const dispatched: IDispatched<Handle> = {
      ...request,
      controller,
      ...(carried === undefined ? {} : { transportCredential: carried }),
    };
    // one that names a destination goes to the handler this side has for it — a relay's
    const resolver =
      destinationId === undefined
        ? registered?.resolver
        : port.handlerOfDestination?.(destinationId);

    // one this side has no handler for: this peer relays nothing, to that destination or elsewhere
    if (destinationId !== undefined && resolver === undefined) {
      const detail = `this peer relays nothing, to ${String(destinationId)} or elsewhere`;

      return (refuse({ ...failures.destinationUnknown, detail }, dispatched), undefined);
    }

    if (resolver === undefined) {
      const unknown = !resolvers.hasService(serviceId)
        ? { ...failures.serviceUnknown, detail: `no service ${String(serviceId)}` }
        : {
            ...failures.procedureUnknown,
            detail: `no procedure ${String(procedureId)} in service ${String(serviceId)}`,
          };

      return (refuse(unknown, dispatched), undefined);
    }

    handlers.set(header, resolver);

    // routed, a credential of a scheme this side takes none of — or its handler forwards none of —
    // is refused before it resolves, and before any credit, the schemes it takes named
    const isForwarded = resolver.forwardsCredentials === true;

    if (
      header.credential !== undefined &&
      !(isForwarded ? FORWARDED_SCHEMES : schemesTaken).has(header.credential.scheme)
    ) {
      return (refuse(isForwarded ? unforwarded : unsupported, dispatched), undefined);
    }

    resolveSession({ dispatched, payload, resolver });
  };

  // a chunk no transfer takes: on a call abandoned, one under the credit it granted is late, and
  // dropped in silence, and one past it was never granted; on a call open without a transfer, or on
  // none, it is reported
  const receiveUnplaced = (
    envelope: ChunkEnvelope,
    {
      connectionHandle,
      creditEnd,
      isOpen,
    }: { connectionHandle: Handle; creditEnd?: number | undefined; isOpen: boolean }
  ): void => {
    const { callId, offset } = envelope.header;

    if (creditEnd !== undefined) {
      if (envelope.payload.length <= creditEnd - offset) {
        return;
      }

      const detail = `bytes from ${String(offset)} run past the credit's end of ${String(creditEnd)}`;

      return (report(failures.creditExceeded, { connectionHandle, detail, envelope }), undefined);
    }

    if (isOpen) {
      const detail = `call ${String(callId)} receives no transfer`;

      return (
        report(failures.envelopeMalformed, { connectionHandle, detail, envelope }), undefined
      );
    }

    return (report(failures.callUnknown, { connectionHandle, envelope }), undefined);
  };

  // a chunk of a request's payload: the call is the peer's
  const receiveRequestChunk = (
    envelope: ChunkEnvelope,
    { call, chunk }: { call: ICallAddress<Handle>; chunk: IChunk }
  ): void => {
    const { connectionHandle } = call;
    const receiving = answeringCalls.receivingOf(call);

    if (receiving === undefined) {
      const creditEnd = answeringCalls.abandonedEndOf(call);

      return (
        receiveUnplaced(envelope, {
          connectionHandle,
          creditEnd,
          isOpen: answeringCalls.has(call),
        }),
        undefined
      );
    }

    const { dispatched, resolver, transfer } = receiving;
    // once whole, the payload went on to the resolver, which answers the call: a chunk ends nothing
    const wasWhole = isWhole(transfer);
    const outcome = receivings.place(transfer, chunk);

    if (typeof outcome === 'object') {
      return wasWhole
        ? (report(outcome, { connectionHandle, envelope }), undefined)
        : (refuse(outcome, dispatched), undefined);
    }

    switch (outcome) {
      case ChunkOutcome.PLACED:
        return (receivings.grant(transfer), undefined);
      case ChunkOutcome.COMPLETE:
        return (
          dispatch(resolver, { ...dispatched, payload: receivings.complete(transfer) }), undefined
        );
      // a chunk that brings nothing new is dropped in silence
      case ChunkOutcome.DUPLICATE:
        return;
    }
  };

  // a chunk of a transfer this side receives: on the peer's call id, of a request's payload; on
  // this side's, of a result's
  const receiveChunk = (envelope: ChunkEnvelope, connectionHandle: Handle): void => {
    const { callId, isLast, offset } = envelope.header;
    const received = {
      call: { callId, connectionHandle },
      chunk: { bytes: envelope.payload, isLast, offset },
    };

    if (sideOfCallId(callId) === failures.side) {
      return (requester.receiveResultChunk(envelope, received), undefined);
    }

    return (receiveRequestChunk(envelope, received), undefined);
  };

  const receiveNotification = (
    envelope: Extract<Envelope, { kind: typeof EnvelopeKind.NOTIFICATION }>,
    connectionHandle: Handle
  ): void => {
    const { header, payload } = envelope;

    if (port.onNotification === undefined) {
      const detail = 'this side takes no notification';

      return (report(failures.kindUnsupported, { connectionHandle, detail, envelope }), undefined);
    }

    // one on a call id reserved was on its way, and is dropped in silence
    if (requester.isReserved(header.callId, connectionHandle)) {
      return;
    }

    return (port.onNotification(header, { connectionHandle, payload }), undefined);
  };

  const receiveSubscriptionCredit = (
    envelope: Extract<Envelope, { kind: typeof EnvelopeKind.CREDIT }>,
    connectionHandle: Handle
  ): void => {
    if (port.onSubscriptionCredit === undefined) {
      const detail = 'this side sends no notification';

      return (report(failures.kindUnsupported, { connectionHandle, detail, envelope }), undefined);
    }

    return (port.onSubscriptionCredit(envelope.header, connectionHandle), undefined);
  };

  const receive = (message: Data | ITransportMessage, connectionHandle: Handle): void => {
    const { credential: transportCredential, data, mayOvertake = false } = messageOf(message);
    let bytes: Uint8Array;
    let prefix: IEnvelopePrefix;

    try {
      bytes = bytesOf(data);
      prefix = readPrefix(bytes, failures);
    } catch (reason) {
      // what is not an envelope's prefix has no call to answer: it is reported
      return (port.report(failureOf(reason, failures), connectionHandle), undefined);
    }

    let envelope: Envelope | undefined;

    try {
      envelope = readEnvelope(bytes, {
        failures,
        maximumDetailBytes: limits.maximumDetailBytes,
        maximumEnvelopeBytes: limits.maximumEnvelopeBytes,
      });
    } catch (reason) {
      if (reason instanceof FailureError) {
        return (gate(reason, { connectionHandle, prefix }), undefined);
      }

      // ! a codec that throws other than a refusal throws an error of this side's own: reported, its
      // words with it, while what answers or ends a call for it is ENVELOPE_MALFORMED with none of
      // them, which a peer's bytes could reach (spec 9.0)
      port.report(failureOf(reason, failures), connectionHandle);

      const failure = new FailureError(failures.envelopeMalformed, { cause: reason });

      return (gate(failure, { connectionHandle, isReported: true, prefix }), undefined);
    }

    // an advisory kind is skipped
    if (envelope === undefined) {
      return;
    }

    if (port.isTracing()) {
      port.trace('rx', { connectionHandle, header: redactHeader(envelope.header) });
    }

    switch (envelope.kind) {
      case EnvelopeKind.REQUEST:
        return (receiveRequest(envelope, { connectionHandle, transportCredential }), undefined);
      case EnvelopeKind.FAILURE:
      case EnvelopeKind.RESULT:
        return (requester.receiveAnswer(envelope, { connectionHandle, mayOvertake }), undefined);
      case EnvelopeKind.NOTIFICATION:
        return (receiveNotification(envelope, connectionHandle), undefined);
      case EnvelopeKind.CHUNK:
        return (receiveChunk(envelope, connectionHandle), undefined);
      // one for no transfer this side sends, or no subscription, may have crossed its end: dropped
      // in silence
      case EnvelopeKind.CREDIT:
        return envelope.header.paced === true
          ? (receiveSubscriptionCredit(envelope, connectionHandle), undefined)
          : (sendings.credit(
              { callId: envelope.header.callId, connectionHandle },
              envelope.header.creditEnd
            ),
            undefined);
      case EnvelopeKind.CANCEL:
        return (receiveCancel(envelope, connectionHandle), undefined);
    }
  };

  const rejectPending = (reason: string, connectionHandle?: Handle): void => {
    // what the connection receives, what it opened, the call ids it reserved, and what it was told
    // of its session, go with it, before anything waiting or answering hears of it; its transfers
    // first, so the budget they give back grants no credit to one about to go
    receivings.closeAll(connectionHandle);

    const rejected = requester.takeAll(connectionHandle);
    const aborted = answeringCalls.takeAll(connectionHandle);

    writer.forget(connectionHandle);

    rejected.reject(reason);

    for (const controller of aborted) {
      controller.abort(new DisconnectError(reason));
    }
  };

  return {
    get isDisposed() {
      return isDisposed;
    },
    get limits() {
      return limits;
    },

    answeredOf: ({ header }) => {
      return failuresAnswered.get(header);
    },

    cancel: requester.cancel,
    gauges: () => {
      return mergeGauges([
        requester.gauges(),
        answeringCalls.gauges(),
        sendings.gauges(),
        receivings.gauges(),
        writer.gauges(),
      ]);
    },
    isAnswering: (request) => {
      return answeringCalls.isAnswering(request);
    },
    isReserved: (callId, connectionHandle) => {
      return requester.isReserved(callId, connectionHandle);
    },
    receive,
    registerResolver: (resolver) => {
      const { maximumPayloadBytes, procedureName } = resolver;

      // * spec 16.10: its identity first, before any reason of the router's and its registry's
      checkDeclaration(resolver);

      if (!isPayloadLimit(maximumPayloadBytes)) {
        throw new ProgrammerError(
          `${procedureName}'s payload limit is a whole number above 0, not ${String(maximumPayloadBytes)}`
        );
      }

      if (resolvers.has(resolver)) {
        throw new ProgrammerError(`${procedureName} is already a registered resolver`);
      }

      // declared as it is registered: one the registry refuses is not registered either
      const series = metrics?.declareResolver(resolver, {
        notifies: typeof (resolver as { notify?: unknown }).notify === 'function',
      });

      resolvers.set(resolver, { resolver, series });

      return series;
    },
    rejectPending,
    request: requester.request,
    reserve: requester.reserve,
    respond,
    send: (envelope, connectionHandle) => {
      return deliver(envelope, { connectionHandle });
    },
    sendNotification: async (payload, { callId, connectionHandle, series }) => {
      // set as its transport has it, out of the flow a type follows here
      let isHanded = false as boolean;

      try {
        await deliver(
          {
            header: { callId, kind: EnvelopeKind.NOTIFICATION },
            kind: EnvelopeKind.NOTIFICATION,
            payload,
          },
          {
            connectionHandle,
            onHandOff:
              series === undefined
                ? undefined
                : () => {
                    isHanded = true;
                    series.sent();
                  },
          }
        );
      } catch (reason) {
        // ! handed to its transport, and refused by it after, it keeps its count as sent
        if (!isHanded) {
          series?.failed();
        }

        throw reason;
      }
    },
    [Symbol.dispose]: () => {
      isDisposed = true;
      // every connection's: each call answering aborted too, so what a resolution settles after
      // dispatches nothing
      rejectPending(`${DISPOSED} before the answer`);
    },
  };
};
