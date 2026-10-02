// ── Demo procedures ───────────────────────────────────────────────────────────

// dependencies

import type { IProcedure } from '../src/router/shared/types';

// interfaces

/** What a token says of whoever holds it, as the demo's identity provider issues it. */
export interface IClaims {
  /** When the token stops being good, in seconds since the epoch. */
  exp: number;
  /** When it was issued, in seconds since the epoch. */
  iat: number;
  /** What the holder may do: the server's checks read these, never the role. */
  permissions: Permission[];
  /** A label for people: a writer is given `write`. */
  role: Role;
  sub: string;
}

/** How one payload of a procedure goes to bytes and comes back. */
interface ICodec<Value> {
  decode: (bytes: Uint8Array) => Value;
  encode: (value: Value) => Uint8Array;
}

/** A procedure, and how its request and its result are written. */
export interface ICall<Request, Result> {
  procedure: IProcedure;
  request: ICodec<Request>;
  result: ICodec<Result>;
}

// types

export type Permission = 'read' | 'write';

export type Role = 'reader' | 'writer';

// constants

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TEXT: ICodec<string> = Object.freeze({
  decode: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  encode: (value: string) => {
    return encoder.encode(value);
  },
});

const BYTES: ICodec<Uint8Array> = Object.freeze({
  decode: (bytes: Uint8Array) => {
    return bytes;
  },
  encode: (bytes: Uint8Array) => {
    return bytes;
  },
});

// helpers

const procedureOf = (procedureId: number, procedureName: string): IProcedure => {
  return Object.freeze({ procedureId, procedureName, serviceId: 1, serviceRevision: 1 });
};

const callOf = <Request, Result>(
  procedure: IProcedure,
  codecs: { request: ICodec<Request>; result: ICodec<Result> }
): ICall<Request, Result> => {
  return Object.freeze({ procedure, ...codecs });
};

/** The serializer a requester of `call` uses: it writes the request, and reads the result. */
export const askerOf = <Request, Result>({ request, result }: ICall<Request, Result>) => {
  return { decode: result.decode, encode: request.encode };
};

/** The serializer the resolver of `call` uses: it reads the request, and writes the result. */
export const answererOf = <Request, Result>({ request, result }: ICall<Request, Result>) => {
  return { decode: request.decode, encode: result.encode };
};

// definition

/**
 * The demo's one service. `login` takes a token and opens a session; a read needs a session, a
 * write the `write` permission; `ask` makes the server ask the client back, by a command.
 */
export const CALLS = Object.freeze({
  /** The server asks the client its time, and answers with what the client said. */
  ask: callOf(procedureOf(10, 'ask'), { request: TEXT, result: TEXT }),
  /** Adds five to the counter at once, each change told as it is made; `write` only. */
  burst: callOf(procedureOf(14, 'burst'), { request: TEXT, result: TEXT }),
  /**
   * That the counter changed, and nothing more, to whoever subscribed: a signal, which its
   * subscriber follows with a read.
   */
  changed: callOf(procedureOf(13, 'changed'), { request: TEXT, result: TEXT }),
  /** The command the server sends: the client's own clock, as its user reads it. */
  clock: callOf(procedureOf(11, 'clock'), { request: TEXT, result: TEXT }),
  /**
   * The counter's value, each time it changes, to whoever subscribed; its notifications carry the
   * key `counter`, so a paced subscriber hears the latest.
   */
  counter: callOf(procedureOf(5, 'counter'), { request: TEXT, result: TEXT }),
  /** A glyph the server draws at random, its pixels as a transfer; a session is enough. */
  download: callOf(procedureOf(7, 'download'), { request: TEXT, result: BYTES }),
  /** A failure of the procedure's own, on purpose. */
  fail: callOf(procedureOf(9, 'fail'), { request: TEXT, result: TEXT }),
  /** Adds one to the counter, and tells the subscribers; `write` only. */
  increment: callOf(procedureOf(4, 'increment'), { request: TEXT, result: TEXT }),
  /** A token in, the claims it carries out; the one procedure that needs no session. */
  login: callOf(procedureOf(1, 'login'), { request: TEXT, result: TEXT }),
  logout: callOf(procedureOf(2, 'logout'), { request: TEXT, result: TEXT }),
  /** The counter's value; a session is enough. */
  read: callOf(procedureOf(3, 'read'), { request: TEXT, result: TEXT }),
  /** An answer that takes its time, unless its call is cancelled first. */
  slow: callOf(procedureOf(8, 'slow'), { request: TEXT, result: TEXT }),
  /**
   * What the server holds and how its calls go, as JSON: its health, its gauges, and the durations
   * of the calls it answered. No session needed: nothing in it names a connection.
   */
  stats: callOf(procedureOf(15, 'stats'), { request: TEXT, result: TEXT }),
  /** A role in, a token out: the identity provider, where no HTTP server stands beside it. */
  token: callOf(procedureOf(12, 'token'), { request: TEXT, result: TEXT }),
  /** A glyph's pixels to the server, as a transfer, and the digest it computed; `write` only. */
  upload: callOf(procedureOf(6, 'upload'), { request: BYTES, result: TEXT }),
});

/** The changes a burst makes at once. */
export const BURST_CHANGES = 5;

/**
 * The notifications' serializer: what a counter's change carries is its value, as text; a signal,
 * nothing.
 */
export const NOTIFICATIONS = TEXT;
