// ── Router core ───────────────────────────────────────────────────────────────

// dependencies

import { LONGEST_TIMER, PLATFORM_CLOCK, type TimeoutId } from '../../transport/shared/clock';
import { createPromise } from '../../transport/shared/create-promise';
import { CancelError, ProgrammerError, TimeoutError, toError } from '../../transport/shared/errors';
import { mergeGauges } from '../../transport/shared/gauges';
import type { Data } from '../../transport/shared/types';
import { createAnnouncements } from './announcements';
import { createAnsweringCalls } from './answering-calls';
import { EnvelopeKind, EnvelopeLayout, LIMIT_DEFAULTS, SESSION_TOKEN_BYTES } from './constants';
import { bytesOf, readEnvelope, writeEnvelope, writeFailure } from './envelope';
import { DisconnectError, FailureError, failureErrorOf, redactHeader } from './errors';
import { headerBytesOf, readPrefix } from './header';
import { sideOfCallId } from './identifiers';
import {
  assertReservation,
  createPendingCalls,
  type IPendingRequest,
  reservationOf,
} from './pending-calls';
import { createProcedureMap } from './procedure-map';
import { createReceivingTransfers, type IReceiving } from './receiving-transfers';
import { createSendingTransfers } from './sending-transfers';
import {
  ChunkOutcome,
  chunkPayloadBytes,
  createOutgoingTransfer,
  type IChunk,
  type IOutgoingTransfer,
} from './transfer';
import type {
  CallId,
  Envelope,
  IAdmissionRequest,
  ICallAddress,
  IEnvelopePrefix,
  IFailure,
  IProcedure,
  IProtocolFailure,
  IRequestHandler,
  IRequestHeader,
  IRequestResolver,
  IResultHeader,
  IRouterResult,
  IRouterCore,
  IRouterCoreOptions,
  IRouterCorePort,
  IRouterFailures,
  IRouterLimits,
  OutgoingEnvelope,
  RouterLimitsOptions,
  RouterSide,
} from './types';

// interfaces

/** A request of the peer's as this side dispatches it: its connection, its header, its controller. */
interface IDispatched<Handle extends string> {
  connectionHandle: Handle;
  controller: AbortController;
  header: IRequestHeader;
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

/** A call this side waits on: where it is, and its entry there. */
interface IWaitingCall<Handle extends string> {
  call: ICallAddress<Handle>;
  pendingRequest: IPendingRequest<Handle>;
}

// types

type ChunkEnvelope = Extract<Envelope, { kind: typeof EnvelopeKind.CHUNK }>;

// constants

// a chunk's header: its prefix, then its offset
const CHUNK_HEADER_BYTES = headerBytesOf({
  callId: 1,
  isLast: true,
  kind: EnvelopeKind.CHUNK,
  offset: 0,
});

const DISPOSED = 'the router was disposed';

// what a failure's envelope holds besides its detail: its header with a session, and its record
const FAILURE_OVERHEAD_BYTES = 28;

// what the limits hold to together, each as the failure that says it does not
const LIMIT_RULES: readonly { holds: (limits: IRouterLimits) => boolean; rule: string }[] =
  Object.freeze([
    {
      holds: ({ maximumEnvelopeBytes }) => {
        return maximumEnvelopeBytes >= 64;
      },
      rule: 'an envelope is 64 bytes at least',
    },
    {
      holds: ({ chunkBytes, maximumEnvelopeBytes }) => {
        return chunkBytes >= 64 && chunkBytes <= maximumEnvelopeBytes;
      },
      rule: "a chunk's envelope is 64 bytes at least, and an envelope at most",
    },
    {
      holds: ({ chunkBytes, windowBytes }) => {
        return windowBytes >= 2 * chunkBytes;
      },
      rule: 'a window holds two chunks at least, so a sender waits for no credit it is owed',
    },
    {
      holds: ({ bufferedBytesBudget, maximumPayloadBytes }) => {
        return maximumPayloadBytes <= bufferedBytesBudget;
      },
      rule: 'a payload fits in the budget of the transfers received',
    },
    {
      holds: ({ transferInactivityTimeout }) => {
        return transferInactivityTimeout <= LONGEST_TIMER;
      },
      rule: `a transfer's inactivity is ${String(LONGEST_TIMER)} milliseconds at most, as a timer holds`,
    },
  ]);

// the limits that may be 0: no transfer taken, and no detail told
const MAY_BE_NONE: ReadonlySet<keyof IRouterLimits> = new Set([
  'maximumDetailBytes',
  'maximumTransfers',
]);

// helpers

/** Whether `value` is an address a resolver may be registered under: 1 to 65535. */
const isAddressPart = (value: number): boolean => {
  return Number.isInteger(value) && value >= 1 && value <= 0xffff;
};

/** `reason` as the failure it is, or as an envelope malformed in a way the codec did not name. */
const failureOf = (reason: unknown, failures: Pick<IRouterFailures, 'envelopeMalformed'>) => {
  return reason instanceof FailureError
    ? reason
    : new FailureError(
        { ...failures.envelopeMalformed, detail: toError(reason).message },
        { cause: reason }
      );
};

/**
 * `given` over {@link LIMIT_DEFAULTS}, where it says nothing. A {@link ProgrammerError} for a limit
 * that is not a whole number — positive, but for the transfers and the detail — or for limits that
 * do not hold together.
 */
const limitsOf = (given: RouterLimitsOptions | undefined): IRouterLimits => {
  const keys = Object.keys(LIMIT_DEFAULTS) as (keyof IRouterLimits)[];
  const limits = Object.fromEntries(
    keys.map((key) => {
      return [key, given?.[key] ?? LIMIT_DEFAULTS[key]];
    })
  ) as unknown as IRouterLimits;

  for (const key of keys) {
    const value = limits[key];

    if (!Number.isSafeInteger(value) || value < (MAY_BE_NONE.has(key) ? 0 : 1)) {
      throw new ProgrammerError(
        `${key} is a whole number${MAY_BE_NONE.has(key) ? '' : ' above 0'}, not ${String(value)}`
      );
    }
  }

  for (const { holds, rule } of LIMIT_RULES) {
    if (!holds(limits)) {
      throw new ProgrammerError(`the router's limits do not hold together: ${rule}`);
    }
  }

  return Object.freeze(limits);
};

/** Whether `value` limits a procedure's payloads: none, or a whole number above 0. */
const isPayloadLimit = (value: unknown): boolean => {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1);
};

/** Whether a call waits `timeout` at most: any positive finite number; anything else waits on. */
const isTimeout = (timeout: number | undefined): timeout is number => {
  return timeout !== undefined && Number.isFinite(timeout) && timeout > 0;
};

/** Whether every byte of a transfer came. */
const isWhole = ({ incoming }: IReceiving<string>): boolean => {
  return incoming.contiguous === incoming.total;
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
  const limits = limitsOf(options?.limits);
  // a failure's detail fits in an envelope, whatever the limit of a detail says
  const detailBytes = Math.min(
    limits.maximumDetailBytes,
    limits.maximumEnvelopeBytes - FAILURE_OVERHEAD_BYTES
  );
  // the largest envelope a payload goes whole in, and the bytes a chunk carries
  const wholeBytes = Math.min(limits.chunkBytes, limits.maximumEnvelopeBytes);
  const payloadBytesPerChunk = chunkPayloadBytes(limits, CHUNK_HEADER_BYTES);
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
  // what a call holds leaves with the call, whichever way the call leaves: its timer, and the
  // transfers it sends and receives
  const pendingCalls = createPendingCalls(port, {
    clock,
    lastCallId: options?.lastCallId,
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
  const answeringCalls = createAnsweringCalls<Handle, IRequestReceiving<Handle>>({
    clock,
    limits,
    onRemove: ({ transfer }) => {
      receivings.close(transfer);
    },
  });
  const announcements = createAnnouncements(port);
  const resolvers = createProcedureMap<IRequestResolver<Handle>>();
  // the handler each request was routed to, by the very header dispatched: its answer is written by
  // that one's limit, whatever else holds the same address
  const handlers = new WeakMap<IRequestHeader, IRequestHandler<Handle>>();

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

  // the bytes a payload of `procedure` holds at most: its own limit, within the router's
  const payloadLimitOf = (
    procedure: Pick<IProcedure, 'maximumPayloadBytes'> | undefined
  ): number => {
    return Math.min(procedure?.maximumPayloadBytes ?? Infinity, limits.maximumPayloadBytes);
  };

  // the failure of a payload of `length` bytes, past `limit`
  const tooLargeOf = (length: number, limit: number): IProtocolFailure => {
    return {
      ...failures.payloadTooLarge,
      detail: `a payload is ${String(limit)} bytes at most, not ${String(length)}`,
    };
  };

  // whether a call id is the peer's to open on this connection, and free: a refusal on it is answered
  const isAnswerable = (callId: CallId, connectionHandle: Handle): boolean => {
    return (
      sideOfCallId(callId) === peerOf(failures.side) &&
      !answeringCalls.has({ callId, connectionHandle }) &&
      port.isCallIdInUse?.(callId, connectionHandle) !== true
    );
  };

  // sends an envelope; `onHandOff` runs once the transport has it, before it settles
  const deliver = async (
    outgoing: OutgoingEnvelope,
    {
      connectionHandle,
      onHandOff,
    }: { connectionHandle: Handle; onHandOff?: (() => void) | undefined }
  ): Promise<void> => {
    // a disposed router is done with its transport: nothing more goes out on it
    if (isDisposed) {
      throw new DisconnectError(DISPOSED);
    }

    // a failure, a credit and a cancel carry no payload of their own
    if (
      outgoing.kind !== EnvelopeKind.CANCEL &&
      outgoing.kind !== EnvelopeKind.CREDIT &&
      outgoing.kind !== EnvelopeKind.FAILURE &&
      outgoing.payload.length > limits.maximumPayloadBytes
    ) {
      throw new FailureError(tooLargeOf(outgoing.payload.length, limits.maximumPayloadBytes), {
        header: outgoing.header,
      });
    }

    const { envelope, restore } = announcements.announce(outgoing, connectionHandle);
    let sending: Promise<unknown>;

    try {
      const bytes = writeEnvelope(envelope, detailBytes);

      // one past its limit, the peer would refuse: a notification too large for one envelope, say
      if (bytes.length > limits.maximumEnvelopeBytes) {
        throw new FailureError(
          {
            ...failures.payloadTooLarge,
            detail: `an envelope is ${String(limits.maximumEnvelopeBytes)} bytes at most, not ${String(bytes.length)}`,
          },
          { header: outgoing.header }
        );
      }

      port.trace('tx', { connectionHandle, header: redactHeader(envelope.header) });
      sending = port.send(bytes, connectionHandle);
    } catch (reason) {
      restore();

      throw reason;
    }

    onHandOff?.();

    try {
      await sending;
    } catch (reason) {
      restore();

      throw reason;
    }
  };

  // sends an envelope no call waits on: what keeps it from going out is reported
  const sendReporting = (envelope: OutgoingEnvelope, connectionHandle: Handle): void => {
    deliver(envelope, { connectionHandle }).catch((reason: unknown) => {
      port.report(toError(reason), connectionHandle);
    });
  };

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
    if (isDisposed || pendingCalls.isReserved(callId, connectionHandle)) {
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

  // how a payload goes after `header`: whole — `undefined` — or as a transfer, a result's header
  // counted with the session it may announce; or not at all, and the failure says why
  const transferOf = (
    payload: Uint8Array,
    {
      header,
      maximumPayloadBytes,
    }: { header: IRequestHeader | IResultHeader; maximumPayloadBytes: number }
  ): IOutgoingTransfer | IProtocolFailure | undefined => {
    const sessionBytes = header.kind === EnvelopeKind.RESULT ? SESSION_TOKEN_BYTES : 0;

    if (payload.length > maximumPayloadBytes) {
      return tooLargeOf(payload.length, maximumPayloadBytes);
    }

    if (headerBytesOf(header) + sessionBytes + payload.length <= wholeBytes) {
      return undefined;
    }

    if (limits.maximumTransfers === 0) {
      return {
        ...failures.payloadTooLarge,
        detail: `a payload of ${String(payload.length)} bytes goes as a transfer, which this side sends none of`,
      };
    }

    return createOutgoingTransfer(payload, {
      openingBytes: wholeBytes - headerBytesOf({ ...header, total: payload.length }) - sessionBytes,
      payloadBytesPerChunk,
    });
  };

  // a chunk's envelope, on `callId`
  const chunkEnvelopeOf = (callId: CallId, { bytes, isLast, offset }: IChunk): OutgoingEnvelope => {
    return {
      header: { callId, isLast, kind: EnvelopeKind.CHUNK, offset },
      kind: EnvelopeKind.CHUNK,
      payload: bytes,
    };
  };

  // a request as a transfer: its opening, then each chunk credited; the call waits on the transfer's
  // inactivity, then on its own timeout once the last chunk is handed off
  const sendRequest = (
    outgoing: IOutgoingTransfer,
    { header, waiting }: { header: IRequestHeader; waiting: IWaitingCall<Handle> }
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

  // a result as a transfer: its opening, then each chunk credited; its call stays open until the
  // last chunk is handed off, and the answer goes out once that one did
  const sendResult = (
    outgoing: IOutgoingTransfer,
    {
      connectionHandle,
      controller,
      header,
    }: { connectionHandle: Handle; controller: AbortController; header: IResultHeader }
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

  const cancel: IRouterCore<Handle>['cancel'] = ({ callId, connectionHandle, timeout }) => {
    assertReservation(timeout);

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
      (header.destinationId === undefined ? resolvers.get({ procedureId, serviceId }) : undefined);
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
    });

    // its answer going out: a second goes nowhere, and this one closes the call once done
    answeringCalls.answer({ connectionHandle, header });

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
                  answeringCalls.close({ callId, connectionHandle }, controller);
                }
              },
            }
          )
        : sendResult(transfer.outgoing, {
            connectionHandle,
            controller: transfer.controller,
            header: result,
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

  // hands a request to its resolver: one that throws before it returns is reported as one that
  // rejects; either frees its call id unless its answer went out, which closes the call itself; a
  // call cancelled, or gone with its connection, is not reported
  const dispatch = (
    resolver: IRequestHandler<Handle>,
    { connectionHandle, controller, header, payload }: IDispatched<Handle> & { payload: Uint8Array }
  ): void => {
    const fail = (reason: unknown): void => {
      if (answeringCalls.isAnswering({ connectionHandle, header })) {
        answeringCalls.close({ callId: header.callId, connectionHandle }, controller);
      }

      if (!controller.signal.aborted) {
        port.report(toError(reason), connectionHandle);
      }
    };

    // admitted already, before its payload was read: the resolver asks nothing again
    try {
      resolver({
        connectionHandle,
        header,
        isAdmitted: true,
        payload,
        signal: controller.signal,
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
    try {
      return resolver.admit?.(request);
    } catch (reason) {
      port.report(toError(reason), request.connectionHandle);

      return failures.procedureFailed;
    }
  };

  // a chunk that did not read ends the transfer it was for, as invalid — unless its payload came
  // whole already; on a call id reserved or abandoned, it is late, and dropped in silence; anywhere
  // else, it is reported
  const gateChunk = (failure: FailureError, call: ICallAddress<Handle>): void => {
    const { callId, connectionHandle } = call;
    const invalid = { ...failures.chunkInvalid, detail: failure.detail };

    if (sideOfCallId(callId) === failures.side) {
      const pendingRequest = pendingCalls.get(call);

      if (pendingRequest?.receiving !== undefined) {
        const { destinationId, procedureAddress } = pendingRequest;
        const reason = new FailureError(invalid, { destinationId, procedureAddress });

        return (endPending(reason, { call, pendingRequest }), undefined);
      }

      if (pendingCalls.isReserved(callId, connectionHandle)) {
        return;
      }
    } else {
      const receiving = answeringCalls.receivingOf(call);

      if (receiving !== undefined && !isWhole(receiving.transfer)) {
        return (refuse(invalid, receiving.dispatched), undefined);
      }

      if (answeringCalls.abandonedEndOf(call) !== undefined) {
        return;
      }
    }

    return (port.report(failure, connectionHandle), undefined);
  };

  // what did not read: a request of the peer's on a free call id is answered; a response or a chunk
  // of this layout ends the call or the transfer it is for; anything else is reported
  const gate = (
    failure: FailureError,
    { connectionHandle, prefix }: { connectionHandle: Handle; prefix: IEnvelopePrefix }
  ): void => {
    const { callId, kind, layout } = prefix;

    // a request of the peer's, on a call id free?
    if (kind === EnvelopeKind.REQUEST && isAnswerable(callId, connectionHandle)) {
      const refusal: OutgoingEnvelope = {
        failure,
        header: { callId, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      };

      return (sendReporting(refusal, connectionHandle), undefined);
    }

    // a chunk of this layout, of a transfer this side receives?
    if (kind === EnvelopeKind.CHUNK && layout === EnvelopeLayout.FIRST) {
      return (gateChunk(failure, { callId, connectionHandle }), undefined);
    }

    // an answer of this layout, to a call waiting?

    const pendingRequest =
      (kind === EnvelopeKind.RESULT || kind === EnvelopeKind.FAILURE) &&
      layout === EnvelopeLayout.FIRST
        ? pendingCalls.get({ callId, connectionHandle })
        : undefined;

    if (pendingRequest === undefined) {
      // an answer of this layout on a call id reserved is late, and dropped in silence
      if (
        (kind === EnvelopeKind.RESULT || kind === EnvelopeKind.FAILURE) &&
        layout === EnvelopeLayout.FIRST &&
        pendingCalls.isReserved(callId, connectionHandle)
      ) {
        return;
      }

      return (port.report(failure, connectionHandle), undefined);
    }

    const { destinationId, procedureAddress } = pendingRequest;

    // the call it answers would otherwise wait out its timeout; it says what the call went to, as
    // every failure that settles a call does, and the peer, which may hold the call still, is told
    endPending(new FailureError(failure, { destinationId, procedureAddress }), {
      call: { callId, connectionHandle },
      pendingRequest,
    });
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

  const receiveRequest = (
    envelope: Extract<Envelope, { kind: typeof EnvelopeKind.REQUEST }>,
    connectionHandle: Handle
  ): void => {
    const { header, payload } = envelope;
    const { callId, destinationId, procedureId, serviceId, total } = header;
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

    const controller = answeringCalls.open(request);
    const dispatched = { ...request, controller };
    // one that names a destination goes to the handler this side has for it — a relay's
    const resolver =
      destinationId === undefined
        ? resolvers.get(header)
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

    // routed, it is asked its admission, on its header: a refusal goes before any credit
    const refusal = refusalOf(resolver, request);

    if (refusal !== undefined) {
      return (refuse(refusal, dispatched), undefined);
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

  // a chunk no transfer takes: on a call abandoned, one under the credit it granted is late, and
  // dropped in silence, and one past it was never granted; on a call open without a transfer, or on
  // none, it is reported
  const receiveUnplaced = (
    envelope: ChunkEnvelope,
    {
      connectionHandle,
      creditEnd,
      isOpen,
    }: { connectionHandle: Handle; creditEnd: number | undefined; isOpen: boolean }
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
        receiveUnplaced(envelope, {
          connectionHandle,
          creditEnd: undefined,
          isOpen: pendingRequest !== undefined,
        }),
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

  // a chunk of a transfer this side receives: on the peer's call id, of a request's payload; on
  // this side's, of a result's
  const receiveChunk = (envelope: ChunkEnvelope, connectionHandle: Handle): void => {
    const { callId, isLast, offset } = envelope.header;
    const received = {
      call: { callId, connectionHandle },
      chunk: { bytes: envelope.payload, isLast, offset },
    };

    if (sideOfCallId(callId) === failures.side) {
      return (receiveResultChunk(envelope, received), undefined);
    }

    return (receiveRequestChunk(envelope, received), undefined);
  };

  const receiveAnswer = (
    envelope: Extract<Envelope, { kind: typeof EnvelopeKind.FAILURE | typeof EnvelopeKind.RESULT }>,
    connectionHandle: Handle
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
    if (pendingCalls.isReserved(header.callId, connectionHandle)) {
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

  const receive = (data: Data, connectionHandle: Handle): void => {
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
      return (gate(failureOf(reason, failures), { connectionHandle, prefix }), undefined);
    }

    // an advisory kind is skipped
    if (envelope === undefined) {
      return;
    }

    port.trace('rx', { connectionHandle, header: redactHeader(envelope.header) });

    switch (envelope.kind) {
      case EnvelopeKind.REQUEST:
        return (receiveRequest(envelope, connectionHandle), undefined);
      case EnvelopeKind.FAILURE:
      case EnvelopeKind.RESULT:
        return (receiveAnswer(envelope, connectionHandle), undefined);
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

    const rejected = pendingCalls.takeAll(connectionHandle);
    const aborted = answeringCalls.takeAll(connectionHandle);

    announcements.forget(connectionHandle);

    for (const pendingRequest of rejected) {
      pendingRequest.reject(new DisconnectError(reason));
    }

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

    cancel,
    gauges: () => {
      return mergeGauges([
        pendingCalls.gauges(),
        answeringCalls.gauges(),
        sendings.gauges(),
        receivings.gauges(),
        announcements.gauges(),
      ]);
    },
    isAnswering: (request) => {
      return answeringCalls.isAnswering(request);
    },
    isReserved: (callId, connectionHandle) => {
      return pendingCalls.isReserved(callId, connectionHandle);
    },
    receive,
    registerResolver: (resolver) => {
      const { maximumPayloadBytes, procedureId, procedureName, serviceId } = resolver;

      if (!isAddressPart(serviceId) || !isAddressPart(procedureId)) {
        throw new ProgrammerError(
          `${procedureName} is at a service and a procedure from 1 to 65535, not ${String(serviceId)}/${String(procedureId)}`
        );
      }

      if (!isPayloadLimit(maximumPayloadBytes)) {
        throw new ProgrammerError(
          `${procedureName}'s payload limit is a whole number above 0, not ${String(maximumPayloadBytes)}`
        );
      }

      if (resolvers.has(resolver)) {
        throw new ProgrammerError(`${procedureName} is already a registered resolver`);
      }

      resolvers.set(resolver, resolver);
    },
    rejectPending,
    request: (
      payload,
      {
        connectionHandle,
        onCallId,
        onSent,
        opensSubscription,
        options: requestOptions,
        paced,
        procedure,
      }
    ) => {
      const { destinationId, signal, timeout } = requestOptions;
      const procedureAddress = {
        procedureId: procedure.procedureId,
        serviceId: procedure.serviceId,
      };
      // the call once drawn: where it waits, and its entry there
      let waiting: IWaitingCall<Handle> | undefined;

      // the call's timer is the core's, which the signal alone is not
      return createPromise<IRouterResult>(
        (resolve, reject) => {
          // what no call can take draws nothing
          if (!isPayloadLimit(procedure.maximumPayloadBytes)) {
            const refused = new ProgrammerError(
              `a payload's limit is a whole number above 0, not ${String(procedure.maximumPayloadBytes)}`
            );

            return (reject(refused), undefined);
          }

          if (Number.isFinite(timeout) && timeout > LONGEST_TIMER) {
            const refused = new ProgrammerError(
              `a call's timeout is ${String(LONGEST_TIMER)} milliseconds at most, as a timer holds, not ${String(timeout)}`
            );

            return (reject(refused), undefined);
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
            return (sendRequest(outgoing, { header, waiting }), undefined);
          }

          wait(timeout, waiting);
          deliver(
            { header, kind: EnvelopeKind.REQUEST, payload },
            {
              connectionHandle,
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
    },
    reserve: (call) => {
      assertReservation(call.timeout);
      pendingCalls.reserve(call);
    },
    respond,
    send: (envelope, connectionHandle) => {
      return deliver(envelope, { connectionHandle });
    },
    [Symbol.dispose]: () => {
      isDisposed = true;
      rejectPending(`${DISPOSED} before the answer`);
    },
  };
};
