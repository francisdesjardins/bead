// dependencies

import { READY_STATE_NAMES, ReadyState } from './ready-state';
import { thrownMessage } from './thrown-message';

// helpers

/** What a thrown value is called: an `Error`'s message, or {@link thrownMessage} for anything else. */
export const reasonMessage = (reason: unknown): string => {
  return reason instanceof Error ? reason.message : thrownMessage(reason);
};

/** An `ErrorClass` worded after `reason`, which it keeps as `cause`. */
export const wrapReason = <E extends Error>(
  ErrorClass: new (message?: string, options?: ErrorOptions) => E,
  reason: unknown
): E => {
  return new ErrorClass(reasonMessage(reason), { cause: reason });
};

/** The {@link CancelError} an aborted `signal` stands for, its reason kept as `cause`. */
export const toCancelError = (signal: AbortSignal): CancelError => {
  const reason: unknown = signal.reason;

  return new CancelError(undefined, { cause: reason });
};

/**
 * What a transport client refuses a send with while it is not open (debugging 9.7): before its
 * open, uninitialized or connecting, its ready state's {@link ReadyStateError}; once its state is a
 * close's — closing, closed or reconnecting — a {@link DisconnectError}, as a call pending when the
 * close came fails, for the two are one race with a close.
 */
export const notOpenOf = (state: ReadyState): DisconnectError | ReadyStateError => {
  if (state === ReadyState.UNINITIALIZED || state === ReadyState.CONNECTING) {
    return new ReadyStateError(state, ReadyState.OPEN);
  }

  // ! open, its connection already let go, is a close's too: the turn that lost it marks it closed
  return new DisconnectError(
    state === ReadyState.OPEN
      ? 'the transport client lost its connection, not open'
      : `the transport client is ${READY_STATE_NAMES[state].toLowerCase()}, not open`
  );
};

/** `reason` itself when it is an `Error`, otherwise a {@link GenericError} carrying it as `cause`. */
export const toError = (reason: unknown): Error => {
  return reason instanceof Error ? reason : wrapReason(GenericError, reason);
};

/**
 * A connection a side failed with 1009, a message past its bound, as its transport reports it on
 * `error` (spec 15.1, 15.3): `subject`, a server's handle or a client's connection, then the bound
 * in the spec's spelling and its value, the platform's own error kept as `cause`.
 */
export const tooBigOf = (
  subject: string,
  { cause, maximumMessageBytes }: { cause: unknown; maximumMessageBytes: number }
): GenericError => {
  return new GenericError(
    `${subject} is closed with 1009: a message past its maximumMessageBytes, ${String(maximumMessageBytes)} bytes`,
    { cause }
  );
};

/**
 * A name its broker refused a subscription to as its participant linked anew or its server's
 * transport served it again, as it is reported: the broker's refusal kept as `cause`.
 */
export const notServedOf = (name: string, reason: unknown): GenericError => {
  return new GenericError(
    `the name ${name} is not served: its broker refused its subscription, ${reasonMessage(reason)}`,
    { cause: reason }
  );
};

// definition

/**
 * Every error a transport raises itself, so one `instanceof GenericError` catches them all. What
 * passes through unwrapped: a protocol's own error from `send`, one thrown by a caller's `tap`, the
 * system's error from a server's `start`, and the errors an `error` event carries.
 */
export class GenericError extends Error {
  public override readonly name: string = 'GenericError';
}

/** Something whose signal aborted; the signal's reason is the `cause`. */
export class CancelError extends GenericError {
  public override readonly name: string = 'CancelError';
}

/** A connection that could not be opened; the protocol's own error is the `cause` when it gave one. */
export class ConnectError extends GenericError {
  public override readonly name: string = 'ConnectError';
}

/**
 * A call whose connection closed before its answer came, or was not open as it started — closing,
 * closed or reconnecting — or whose side was disposed.
 */
export class DisconnectError extends GenericError {
  public override readonly name: string = 'DisconnectError';
}

/** A misuse of the API, or a `delay` function that threw. */
export class ProgrammerError extends GenericError {
  public override readonly name: string = 'ProgrammerError';
}

/**
 * A transport client asked for what its state does not allow, in the C# side's words: `the
 * transport client is uninitialized, not open`; the C# side's `ReadyStateException` is its twin. A
 * send is refused so before its open alone, uninitialized or connecting, a send once its state is a
 * close's being a {@link DisconnectError}; a close or a disconnect unless open is refused so in any
 * state.
 */
export class ReadyStateError extends GenericError {
  public override readonly name: string = 'ReadyStateError';

  public readonly expected: ReadyState;
  public readonly got: ReadyState;

  public constructor(got: ReadyState, expected: ReadyState) {
    super(
      `the transport client is ${READY_STATE_NAMES[got].toLowerCase()}, not ${READY_STATE_NAMES[expected].toLowerCase()}`
    );

    this.got = got;
    this.expected = expected;
  }
}

/** A reconnection that ran out of attempts; the last attempt's error is the `cause`. */
export class ReconnectError extends GenericError {
  public override readonly name: string = 'ReconnectError';
}

/**
 * Something that waited past its timeout, worded as the C# side words it there: a call no answer
 * came for, a key set's ask unsettled at its deadline; `timed out after 10ms` for any other wait,
 * a connection's say.
 */
export class TimeoutError extends GenericError {
  public override readonly name: string = 'TimeoutError';

  /** The milliseconds waited. */
  public readonly timeout: number;

  public constructor(timeout: number, message = `timed out after ${String(timeout)}ms`) {
    super(message);

    this.timeout = timeout;
  }
}
