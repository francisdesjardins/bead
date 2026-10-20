// ── Router requester ──────────────────────────────────────────────────────────

// dependencies

import { assertHeld, type IClock } from '../../transport/shared/clock';
import { createPromise } from '../../transport/shared/create-promise';
import { CancelError, ProgrammerError, TimeoutError, toError } from '../../transport/shared/errors';
import type { IGauges } from '../../transport/shared/types';
import { CredentialScheme, EnvelopeKind } from './constants';
import { DisconnectError, FailureError, failureErrorOf } from './errors';
import { headerBytesOf } from './header';
import { CallEnding, endingOf, microsecondsOf } from './metrics-registry';
import { type ChunkEnvelope, type IPayloadPlacement, isPayloadLimit } from './payload-placement';
import {
  assertReservation,
  createPendingCalls,
  type IPendingRequest,
  reservationOf,
} from './pending-calls';
import type { IReceivingTransfers } from './receiving-transfers';
import type { IRouterWriter } from './router-writer';
import type { ISendingTransfers } from './sending-transfers';
import { ChunkOutcome, type IChunk, type IOutgoingTransfer } from './transfer';
import type {
  CallId,
  Credential,
  Envelope,
  ICallAddress,
  IFailure,
  IProcedure,
  IRequestHeader,
  IRouterCore,
  IRouterCoreOptions,
  IRouterCorePort,
  IRouterLimits,
  IRouterResult,
} from './types';

// interfaces

/**
 * What the requester needs of its core: the side's failures, its call ids, its reports and its
 * hooks, whether the core is disposed, and the core's own reading of a chunk no transfer takes.
 */
export interface IRouterRequesterPort<Handle extends string> extends Pick<
  IRouterCorePort<Handle>,
  'activity' | 'failures' | 'isCallIdInUse' | 'onAnswerReceived' | 'onUnpairedFailure' | 'report'
> {
  /** Whether the core is disposed, read at each call. */
  isDisposed: () => boolean;
  /** A chunk no transfer takes, on a call open or on none, as the core reads one. */
  receiveUnplaced: (
    envelope: ChunkEnvelope,
    options: { connectionHandle: Handle; isOpen: boolean }
  ) => void;
  /** A failure the core raises itself, on what came in, for the side to hear. */
  reportFailure: (
    failure: IFailure,
    options: { connectionHandle: Handle; detail?: string | undefined; envelope: Envelope }
  ) => void;
}

/**
 * What the requester is handed by its core: its clock, its limits and its metrics, the last call id
 * it draws, and the pieces it shares with the core: the writer, the placement and the transfers.
 */
export interface IRouterRequesterOptions<Handle extends string> extends Pick<
  IRouterCoreOptions,
  'lastCallId' | 'metrics'
> {
  clock: IClock;
  limits: IRouterLimits;
  placement: IPayloadPlacement;
  receivings: IReceivingTransfers<Handle>;
  sendings: ISendingTransfers<Handle>;
  writer: IRouterWriter<Handle>;
}

/**
 * The calls this side starts: each request drawn its call id and held until its answer, its timer
 * and its cancel, the answer and the result's transfer paired with it, and its call id reserved
 * once it ends.
 */
export interface IRouterRequester<Handle extends string> {
  /** Cancels a call this side opened, telling the peer when its request went out. */
  cancel: IRouterCore<Handle>['cancel'];
  /** An answer of this layout that does not read: it ends the call it answers, if one waits. */
  gateMalformedAnswer: (
    failure: FailureError,
    options: ICallAddress<Handle> & { isReported?: boolean }
  ) => void;
  /** A chunk of this layout that does not read: it ends the result's transfer it was for. */
  gateMalformedResultChunk: (
    failure: FailureError,
    options: ICallAddress<Handle> & { isReported?: boolean }
  ) => void;
  /** The pending calls' gauges. */
  gauges: () => IGauges<Handle>;
  /** Whether a call id of this side's is reserved on a connection. */
  isReserved: (callId: CallId, connectionHandle: Handle) => boolean;
  /** A result or a failure from the peer, paired with the call it answers. */
  receiveAnswer: (
    envelope: Extract<Envelope, { kind: typeof EnvelopeKind.FAILURE | typeof EnvelopeKind.RESULT }>,
    options: { connectionHandle: Handle; mayOvertake: boolean }
  ) => void;
  /** A chunk of a call's result. */
  receiveResultChunk: (
    envelope: ChunkEnvelope,
    options: { call: ICallAddress<Handle>; chunk: IChunk }
  ) => void;
  /** Makes a call, and settles as its answer, its timer, its signal or its connection does. */
  request: IRouterCore<Handle>['request'];
  /** Reserves a call id, as `IRouterCore`'s `reserve` does. */
  reserve: IRouterCore<Handle>['reserve'];
  /**
   * Takes every call waiting on one connection, or on all, out of the pending calls, for them to be
   * rejected with a {@link DisconnectError} after.
   */
  takeAll: (connectionHandle?: Handle) => { reject: (reason: string) => void };
}

/** A call this side waits on: where it is, and its entry there. */
interface IWaitingCall<Handle extends string> {
  call: ICallAddress<Handle>;
  pendingRequest: IPendingRequest<Handle>;
}

// helpers

/**
 * Throws a {@link ProgrammerError} for a credential no header of its request holds, whatever its
 * payload (spec 4.4): its header laid out on call id 1, whole, with its credential when its caller
 * gives its bytes, a `JWT` or a scheme to come; an `OPAQUE`, 16 bytes, and an `ELSEWHERE`, none,
 * always fit.
 */
const assertHeaderHolds = ({
  credential,
  destinationId,
  opensSubscription,
  paced,
  procedure: { procedureId, serviceId },
}: {
  credential?: Credential | undefined;
  destinationId?: number | undefined;
  opensSubscription?: boolean | undefined;
  paced?: boolean | undefined;
  procedure: Pick<IProcedure, 'procedureId' | 'serviceId'>;
}): void => {
  const isAsked =
    credential !== undefined &&
    credential.scheme !== CredentialScheme.OPAQUE &&
    credential.scheme !== CredentialScheme.ELSEWHERE;

  headerBytesOf({
    callId: 1,
    destinationId,
    kind: EnvelopeKind.REQUEST,
    procedureId,
    serviceId,
    ...(opensSubscription === true ? { opensSubscription } : {}),
    ...(paced === true ? { paced } : {}),
    ...(isAsked ? { credential } : {}),
  });
};

/** How a call this side made ended, by what its router settled it with (spec/debugging.md 9.6). */
const madeEndingOf = (reason: unknown): CallEnding => {
  if (reason instanceof FailureError) {
    return endingOf(reason);
  }

  if (reason instanceof TimeoutError) {
    return CallEnding.TIMEOUT;
  }

  if (reason instanceof CancelError) {
    return CallEnding.CANCELLED;
  }

  return reason instanceof DisconnectError ? CallEnding.CLOSED : CallEnding.ERROR;
};

/** Whether a call waits `timeout` at most: a duration held; none and `Infinity` wait on. */
const isTimeout = (timeout: number | undefined): timeout is number => {
  return timeout !== undefined && Number.isFinite(timeout) && timeout > 0;
};

// definition

/**
 * The requester of one router core: the calls its side makes, from their call id drawn to their
 * answer, their transfers both ways, their timers, their cancels and their call ids reserved. Its
 * `port` is its core's; its `options` hand it what the core shares with it.
 */
export const createRouterRequester = <Handle extends string>(
  port: IRouterRequesterPort<Handle>,
  {
    clock,
    lastCallId,
    limits,
    metrics,
    placement,
    receivings,
    sendings,
    writer,
  }: IRouterRequesterOptions<Handle>
): IRouterRequester<Handle> => {
  const { failures, reportFailure: report } = port;
  const { deliver, sendReporting } = writer;
  const { chunkEnvelopeOf, payloadLimitOf, tooLargeOf, transferOf } = placement;

  // what a call holds leaves with the call, whichever way the call leaves: its timer, and the
  // transfers it sends and receives
  const pendingCalls = createPendingCalls(port, {
    clock,
    lastCallId,
    onRemove: ({ receiving, sending, timer }) => {
      clock.clearTimeout(timer);

      if (receiving !== undefined) {
        receivings.close(receiving.transfer);
      }

      if (sending !== undefined) {
        sendings.close(sending);
      }
    },
  });

  // how long a call id stays reserved once its call ends: as its timeout says — and, once its result
  // came in part, as long as the peer keeps the call abandoned, should that be longer, since what
  // the credit let the peer send may still come
  const reservedFor = ({
    receiving,
    timeout,
  }: Pick<IPendingRequest<Handle>, 'receiving' | 'timeout'>): number | undefined => {
    return receiving === undefined
      ? timeout
      : Math.max(reservationOf(timeout), limits.transferInactivityTimeout);
  };

  // tells the peer a call this side opened is cancelled, once, and reserves its call id in the same
  // turn, so nothing drawn meanwhile takes it; a cancel that cannot go out is reported
  const sendCancel = ({
    callId,
    connectionHandle,
    timeout,
  }: ICallAddress<Handle> & { timeout: number | undefined }): void => {
    // a disposed router sends nothing; a call id reserved already had its cancel
    if (port.isDisposed() || pendingCalls.isReserved(callId, connectionHandle)) {
      return;
    }

    pendingCalls.reserve({ callId, connectionHandle, timeout });
    sendReporting(
      { header: { callId, kind: EnvelopeKind.CANCEL }, kind: EnvelopeKind.CANCEL },
      connectionHandle
    );
  };

  // ends a call this side waits on before its answer came whole: forgotten first, so what it holds
  // goes with it, then the peer told to cancel it, then the caller told; a call ended already — by
  // its answer, say, before a send behind it failed — ends no more
  const endPending = (reason: Error, { call, pendingRequest }: IWaitingCall<Handle>): void => {
    if (pendingCalls.get(call) !== pendingRequest) {
      return;
    }

    pendingCalls.forget(call);
    sendCancel({ ...call, timeout: reservedFor(pendingRequest) });
    pendingRequest.reject(reason);
  };

  // sets a waiting call's timer going again, which its caller waits on too: past `delay`, a
  // TimeoutError; none for no positive delay, nor for a call ended already, as a send went
  const wait = (delay: number | undefined, waiting: IWaitingCall<Handle>): void => {
    const { call, pendingRequest } = waiting;

    if (pendingCalls.get(call) !== pendingRequest) {
      return;
    }

    clock.clearTimeout(pendingRequest.timer);
    pendingRequest.timer = isTimeout(delay)
      ? clock.setTimeout(() => {
          endPending(new TimeoutError(delay), waiting);
        }, delay)
      : undefined;
  };

  // a request as a transfer: its opening, then each chunk credited; the call waits on the transfer's
  // inactivity, then on its own timeout once the last chunk is handed off
  const sendRequest = (
    outgoing: IOutgoingTransfer,
    {
      header,
      transportCredential,
      waiting,
    }: {
      header: IRequestHeader;
      transportCredential: string | undefined;
      waiting: IWaitingCall<Handle>;
    }
  ): void => {
    const { call, pendingRequest } = waiting;
    const { callId, connectionHandle } = call;
    const progress = (): void => {
      wait(limits.transferInactivityTimeout, waiting);
    };

    progress();
    // kept before its opening goes, so a credit that comes back as it goes finds it
    pendingRequest.sending = sendings.open(outgoing, {
      call,
      onCredit: progress,
      send: (chunk) => {
        deliver(chunkEnvelopeOf(callId, chunk), {
          connectionHandle,
          // the last one handed off, the call waits on its timeout — unless a result opened as it
          // went, which waits on its own inactivity
          onHandOff: chunk.isLast
            ? () => {
                if (pendingRequest.receiving === undefined) {
                  wait(pendingRequest.timeout, waiting);
                }
              }
            : progress,
        }).then(
          () => {
            if (chunk.isLast) {
              port.activity('request', connectionHandle);
            }
          },
          // one that cannot go out ends the call: the peer, which holds a part of it, cancels it
          (reason: unknown) => {
            endPending(toError(reason), waiting);
          }
        );
      },
    });
    deliver(
      {
        header: { ...header, total: outgoing.total },
        kind: EnvelopeKind.REQUEST,
        payload: outgoing.opening,
      },
      {
        connectionHandle,
        credential: transportCredential,
        onHandOff: () => {
          pendingRequest.isSent = true;
          pendingRequest.onSent?.(true);
        },
      }
    ).catch((reason: unknown) => {
      // handed over, then refused by the transport: nothing of it went out
      if (pendingRequest.isSent) {
        pendingRequest.onSent?.(false);
      }

      pendingRequest.reject(toError(reason));
    });
  };

  const cancel: IRouterCore<Handle>['cancel'] = ({ callId, connectionHandle, timeout: given }) => {
    const timeout = assertReservation(given);

    const pendingRequest = pendingCalls.get({ callId, connectionHandle });

    pendingCalls.forget({ callId, connectionHandle });

    // a request the transport never had leaves nothing at the other end to cancel
    if (pendingRequest === undefined || pendingRequest.isSent) {
      sendCancel({
        callId,
        connectionHandle,
        timeout:
          pendingRequest === undefined
            ? timeout
            : reservedFor({
                receiving: pendingRequest.receiving,
                timeout: timeout ?? pendingRequest.timeout,
              }),
      });
    }

    // heard after the cancel went out, so a call made again in its place goes out behind it
    pendingRequest?.reject(new CancelError(`call ${String(callId)} was cancelled`));
  };

  // a chunk of a call's result: the call is this side's
  const receiveResultChunk = (
    envelope: ChunkEnvelope,
    { call, chunk }: { call: ICallAddress<Handle>; chunk: IChunk }
  ): void => {
    const { callId, connectionHandle } = call;
    const pendingRequest = pendingCalls.get(call);

    if (pendingRequest?.receiving === undefined) {
      // one on a call id reserved was on its way, and is dropped in silence
      if (pendingCalls.isReserved(callId, connectionHandle)) {
        return;
      }

      return (
        port.receiveUnplaced(envelope, { connectionHandle, isOpen: pendingRequest !== undefined }),
        undefined
      );
    }

    const { destinationId, procedureAddress, receiving } = pendingRequest;
    const { header, transfer } = receiving;
    const outcome = receivings.place(transfer, chunk);

    if (typeof outcome === 'object') {
      const reason = new FailureError(outcome, { destinationId, procedureAddress });

      return (endPending(reason, { call, pendingRequest }), undefined);
    }

    switch (outcome) {
      // bytes placed are progress
      case ChunkOutcome.PLACED:
        wait(limits.transferInactivityTimeout, { call, pendingRequest });

        return (receivings.grant(transfer), undefined);
      case ChunkOutcome.COMPLETE: {
        const payload = receivings.complete(transfer);

        // out before it settles; what its credit let the peer send may still come, a copy or out
        // of order, and its call id stays reserved, for it to be dropped in silence
        pendingCalls.forget(call, pendingRequest);
        pendingCalls.reserve({ callId, connectionHandle, timeout: reservedFor(pendingRequest) });
        pendingRequest.resolve({ header, payload });

        return (port.activity('response', connectionHandle), undefined);
      }
      // a chunk that brings nothing new is dropped in silence
      case ChunkOutcome.DUPLICATE:
        return;
    }
  };

  const receiveAnswer = (
    envelope: Extract<Envelope, { kind: typeof EnvelopeKind.FAILURE | typeof EnvelopeKind.RESULT }>,
    { connectionHandle, mayOvertake }: { connectionHandle: Handle; mayOvertake: boolean }
  ): void => {
    const { header } = envelope;
    const { callId } = header;
    const call = { callId, connectionHandle };

    port.onAnswerReceived?.(header, connectionHandle);

    const pendingRequest = pendingCalls.get(call);

    if (pendingRequest === undefined) {
      // a failure may end a call the side keeps open once answered — a subscription — which the
      // side takes; anything else answers no call
      if (
        envelope.kind === EnvelopeKind.FAILURE &&
        port.onUnpairedFailure?.(envelope, connectionHandle) === true
      ) {
        return;
      }

      // one on a call id reserved is late, and dropped in silence
      if (pendingCalls.isReserved(callId, connectionHandle)) {
        return;
      }

      return (report(failures.callUnknown, { connectionHandle, envelope }), undefined);
    }

    const { destinationId, procedureAddress, receiving } = pendingRequest;

    if (envelope.kind === EnvelopeKind.FAILURE) {
      // out before it settles, so the same response again, even in the same read, pairs with
      // nothing; a result it received in part goes with it, what that credit let the peer send
      // dropped in silence behind its call id reserved
      pendingCalls.forget(call, pendingRequest);

      if (receiving !== undefined) {
        pendingCalls.reserve({ callId, connectionHandle, timeout: reservedFor(pendingRequest) });
      }

      pendingRequest.reject(
        failureErrorOf(envelope.failure, {
          destinationId,
          failures,
          header: envelope.header,
          mayOvertake,
          procedureAddress,
        })
      );

      return (port.activity('response', connectionHandle), undefined);
    }

    // a result that comes in a transfer answered the call: another answers nothing
    if (receiving !== undefined) {
      const detail = `call ${String(callId)} is answered already, by a transfer`;

      return (
        report(failures.envelopeMalformed, { connectionHandle, detail, envelope }), undefined
      );
    }

    const { total } = envelope.header;

    if (total === undefined) {
      // out before it settles, so the same response again, even in the same read, pairs with nothing
      pendingCalls.forget(call, pendingRequest);
      pendingRequest.resolve({ header: envelope.header, payload: envelope.payload });

      return (port.activity('response', connectionHandle), undefined);
    }

    // a transfer's opening is not its result: one refused — past its procedure's limit, say — ends
    // the call, and the peer, which holds the result still, is told to cancel it; opened, the call
    // waits on the rest, which one silent too long ends — its own timer, rather than the transfer's
    const { maximumPayloadBytes } = pendingRequest;
    const transfer =
      total > maximumPayloadBytes
        ? tooLargeOf(total, maximumPayloadBytes)
        : receivings.open(envelope.payload, { call, total });

    if ('code' in transfer) {
      const reason = new FailureError(transfer, { destinationId, header, procedureAddress });

      return (endPending(reason, { call, pendingRequest }), undefined);
    }

    wait(limits.transferInactivityTimeout, { call, pendingRequest });
    // kept before its first credit goes, so a chunk that credit brings at once finds it
    pendingRequest.receiving = { header: envelope.header, transfer };
    receivings.grant(transfer);
  };

  const request: IRouterCore<Handle>['request'] = (
    payload,
    {
      connectionHandle,
      credential,
      onCallId,
      onSent,
      opensSubscription,
      options: requestOptions,
      paced,
      procedure,
      refusal,
      series: given,
      transportCredential,
    }
  ) => {
    const { destinationId, signal, timeout: givenTimeout } = requestOptions;
    const procedureAddress = {
      procedureId: procedure.procedureId,
      serviceId: procedure.serviceId,
    };
    // the series it counts into, a requester's or _OTHER's; none while the router counts nothing
    const series = metrics === undefined ? undefined : (given ?? metrics.otherClient);
    // the call once drawn: where it waits, and its entry there
    let waiting: IWaitingCall<Handle> | undefined;
    // counted, the monotonic reading it started at, and whether it ended
    let startedAt: number | undefined;
    let isEnded = false;
    // ! made only for a call counted: one counted nothing allocates nothing for it
    const end =
      series === undefined
        ? undefined
        : (ending: CallEnding): void => {
            if (startedAt !== undefined && !isEnded) {
              isEnded = true;
              series.end(ending, microsecondsOf(clock.performance.now() - startedAt));
            }
          };

    // the call's timer is the core's, which the signal alone is not
    return createPromise<IRouterResult>(
      (resolved, rejected) => {
        // what no call can take draws nothing, and is no call: it is not counted
        if (!isPayloadLimit(procedure.maximumPayloadBytes)) {
          const refused = new ProgrammerError(
            `a payload's limit is a whole number above 0, not ${String(procedure.maximumPayloadBytes)}`
          );

          return (rejected(refused), undefined);
        }

        // held, which its timer, its reservation and its TimeoutError all take
        const timeout = assertHeld("a call's timeout", givenTimeout);

        // ! a credential no header of its request holds, whatever its payload, is a programmer's
        // error, thrown before the call starts and not counted (spec 4.4)
        assertHeaderHolds({ credential, destinationId, opensSubscription, paced, procedure });

        // * the call starts once nothing makes it a programmer's error and its signal is not
        // aborted, and ends wherever its router settles it, each refusal after in this turn
        if (series !== undefined) {
          series.start();
          startedAt = clock.performance.now();
        }

        const resolve =
          end === undefined
            ? resolved
            : (result: IRouterResult): void => {
                end(CallEnding.RESULT);
                resolved(result);
              };
        const reject =
          end === undefined
            ? rejected
            : (reason: Error): void => {
                end(madeEndingOf(reason));
                rejected(reason);
              };

        if (refusal !== undefined) {
          return (reject(refusal), undefined);
        }

        // ! past the calls its peer answers at once, it fails before it goes, drawing no call id,
        // as an HTTP/2 endpoint never passes the streams its peer lets it open (spec 9.1)
        if (pendingCalls.countOn(connectionHandle) >= limits.maximumAnsweringCalls) {
          const detail = `the calls waiting on ${connectionHandle} are ${String(limits.maximumAnsweringCalls)} at most`;
          const exceeded = new FailureError(
            { ...failures.capacityExceeded, detail },
            { destinationId, procedureAddress }
          );

          return (reject(exceeded), undefined);
        }

        // drawn once the call starts: an aborted signal draws nothing
        const callId = pendingCalls.draw(connectionHandle);

        if (callId === undefined) {
          const detail = `every call id of ${connectionHandle} is in use`;
          const exceeded = new FailureError(
            { ...failures.capacityExceeded, detail },
            { destinationId, procedureAddress }
          );

          return (reject(exceeded), undefined);
        }

        const header: IRequestHeader = {
          ...procedureAddress,
          callId,
          destinationId,
          kind: EnvelopeKind.REQUEST,
          ...(opensSubscription === true ? { opensSubscription } : {}),
          ...(paced === true ? { paced } : {}),
          ...(credential === undefined ? {} : { credential }),
        };
        // how it goes is decided before anything is kept of it: past its limit, nothing goes
        const maximumPayloadBytes = payloadLimitOf(procedure);
        const outgoing = transferOf(payload, { header, maximumPayloadBytes });

        if (outgoing !== undefined && 'code' in outgoing) {
          const refused = new FailureError(outgoing, { destinationId, header, procedureAddress });

          return (reject(refused), undefined);
        }

        const pendingRequest: IPendingRequest<Handle> = {
          destinationId,
          isSent: false,
          // its result, as its request, holds its procedure's limit at most
          maximumPayloadBytes,
          onSent,
          procedureAddress,
          reject,
          resolve,
          timeout,
        };
        const call = { callId, connectionHandle };

        waiting = { call, pendingRequest };
        pendingCalls.add(call, pendingRequest);
        onCallId?.(callId);

        if (outgoing !== undefined) {
          return (sendRequest(outgoing, { header, transportCredential, waiting }), undefined);
        }

        wait(timeout, waiting);
        deliver(
          { header, kind: EnvelopeKind.REQUEST, payload },
          {
            connectionHandle,
            credential: transportCredential,
            onHandOff: () => {
              pendingRequest.isSent = true;
              pendingRequest.onSent?.(true);
            },
          }
        ).then(
          () => {
            port.activity('request', connectionHandle);
          },
          (reason: unknown) => {
            // handed over, then refused by the transport: nothing of it went out
            if (pendingRequest.isSent) {
              pendingRequest.onSent?.(false);
            }

            reject(toError(reason));
          }
        );

        return undefined;
      },
      { signal }
    )
      .catch((reason: unknown) => {
        // ended by its signal, which settles it beside the executor
        end?.(madeEndingOf(reason));

        // gone out and unanswered, ended by its signal: the peer is told before the caller hears
        // of it, so a call made again in its place goes out behind the cancel
        if (
          waiting?.pendingRequest.isSent === true &&
          pendingCalls.get(waiting.call) === waiting.pendingRequest &&
          reason instanceof CancelError
        ) {
          pendingCalls.forget(waiting.call);
          sendCancel({ ...waiting.call, timeout: reservedFor(waiting.pendingRequest) });
        }

        throw reason;
      })
      .finally(() => {
        // its own entry only: a response or a close took it out already, and another may hold it
        if (waiting !== undefined) {
          pendingCalls.forget(waiting.call, waiting.pendingRequest);
        }
      });
  };

  const reserve: IRouterCore<Handle>['reserve'] = (call) => {
    pendingCalls.reserve({ ...call, timeout: assertReservation(call.timeout) });
  };

  const gateMalformedResultChunk = (
    failure: FailureError,
    {
      callId,
      connectionHandle,
      isReported = false,
    }: ICallAddress<Handle> & { isReported?: boolean }
  ): void => {
    const call = { callId, connectionHandle };
    const invalid = { ...failures.chunkInvalid, detail: failure.detail };
    const pendingRequest = pendingCalls.get(call);

    if (pendingRequest?.receiving !== undefined) {
      const { destinationId, procedureAddress } = pendingRequest;
      const reason = new FailureError(invalid, { destinationId, procedureAddress });

      return (endPending(reason, { call, pendingRequest }), undefined);
    }

    if (pendingCalls.isReserved(callId, connectionHandle)) {
      return;
    }

    if (!isReported) {
      port.report(failure, connectionHandle);
    }
  };

  const gateMalformedAnswer = (
    failure: FailureError,
    {
      callId,
      connectionHandle,
      isReported = false,
    }: ICallAddress<Handle> & { isReported?: boolean }
  ): void => {
    const pendingRequest = pendingCalls.get({ callId, connectionHandle });

    if (pendingRequest === undefined) {
      // an answer of this layout on a call id reserved is late, and dropped in silence
      if (pendingCalls.isReserved(callId, connectionHandle)) {
        return;
      }

      if (!isReported) {
        port.report(failure, connectionHandle);
      }

      return;
    }

    const { destinationId, procedureAddress } = pendingRequest;

    // the call it answers would otherwise wait out its timeout; it says what the call went to, as
    // every failure that settles a call does, and the peer, which may hold the call still, is told
    endPending(new FailureError(failure, { destinationId, procedureAddress }), {
      call: { callId, connectionHandle },
      pendingRequest,
    });
  };

  return {
    cancel,
    gateMalformedAnswer,
    gateMalformedResultChunk,
    gauges: () => {
      return pendingCalls.gauges();
    },
    isReserved: (callId: CallId, connectionHandle: Handle) => {
      return pendingCalls.isReserved(callId, connectionHandle);
    },
    receiveAnswer,
    receiveResultChunk,
    request,
    reserve,
    takeAll: (connectionHandle?: Handle) => {
      const rejected = pendingCalls.takeAll(connectionHandle);

      return {
        reject: (reason: string): void => {
          for (const pendingRequest of rejected) {
            pendingRequest.reject(new DisconnectError(reason));
          }
        },
      };
    },
  };
};
