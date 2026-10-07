// ── Demo procedures ───────────────────────────────────────────────────────────

// dependencies

import type { IProcedure } from '../src/router/shared/types';

// interfaces

/**
 * What an access token says of whoever holds it, as the demo's identity provider issues it: the
 * claims RFC 9068 §2.2 requires, the role's scope and its sign-in. A server that verified it holds
 * them as the data of the call's session.
 */
export interface IClaims {
  /** Who the token is for: the demo's Bead servers. */
  aud: string;
  /** The client it was handed to: the demo's page. */
  client_id: string;
  /** When the token stops holding, in seconds since the epoch. */
  exp: number;
  /** When it was issued, in seconds since the epoch. */
  iat: number;
  /** Who issued it: the demo's identity provider. */
  iss: string;
  /** The token's own identifier. */
  jti: string;
  /** A label for people (RFC 9068 §2.2.3.1): a writer's scope holds `write`. */
  roles: Role[];
  /**
   * What the holder may do, separated by spaces (RFC 8693 §4.2): the server's checks read it, never
   * the roles.
   */
  scope: string;
  /** The sign-in it was issued for, which names its session at a server, under its issuer. */
  sid: string;
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

/** What a scope may hold. */
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
 * The demo's one service. Each call presents the client's token, a `JWT`, and runs in the session
 * the server makes of it: a read needs a session, a write one whose scope holds `write`; `ask` makes
 * the server ask the client back, by a command.
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
  /**
   * Ends the call's session, and the subscriptions it holds, on every connection: its token still
   * holds, so its client forgets it.
   */
  logout: callOf(procedureOf(2, 'logout'), { request: TEXT, result: TEXT }),
  /**
   * What the server's metrics registry holds, as a scrape reads it: the Prometheus text format
   * 0.0.4, what `/metrics` serves beside a Node server, over Bead itself. No session needed: nothing
   * in it names a connection.
   */
  metrics: callOf(procedureOf(16, 'metrics'), { request: TEXT, result: TEXT }),
  /** The counter's value; a session is enough. */
  read: callOf(procedureOf(3, 'read'), { request: TEXT, result: TEXT }),
  /** An answer that takes its time, unless its call is cancelled first. */
  slow: callOf(procedureOf(8, 'slow'), { request: TEXT, result: TEXT }),
  /**
   * What the server holds, as JSON: its health, and its gauges. No session needed: nothing in it
   * names a connection.
   */
  stats: callOf(procedureOf(15, 'stats'), { request: TEXT, result: TEXT }),
  /**
   * A role in, a token out: the identity provider, where no HTTP server stands beside it. Called
   * with no credential: one that no longer holds would have it refused.
   */
  token: callOf(procedureOf(12, 'token'), { request: TEXT, result: TEXT }),
  /** A glyph's pixels to the server, as a transfer, and the digest it computed; `write` only. */
  upload: callOf(procedureOf(6, 'upload'), { request: BYTES, result: TEXT }),
  /**
   * Who the call's session says its caller is: the claims of the token it presented, as the server
   * verified them, and when that session ends.
   */
  whoami: callOf(procedureOf(1, 'whoami'), { request: TEXT, result: TEXT }),
});

/** The changes a burst makes at once. */
export const BURST_CHANGES = 5;

/**
 * The notifications' serializer: what a counter's change carries is its value, as text; a signal,
 * nothing.
 */
export const NOTIFICATIONS = TEXT;
