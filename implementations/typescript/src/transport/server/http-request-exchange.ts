// ── HTTP request exchange ─────────────────────────────────────────────────────

// dependencies

import type { IClock, TimeoutId } from '../shared/clock';
import type { ITransportMessage } from '../shared/types';
import { credentialOf } from './hosts-and-origins';
import {
  endWith,
  ENVELOPE_KINDS,
  ENVELOPE_PREFIX,
  headerOf,
  type IEnd,
  type IExchangeIn,
  linesOf,
  REFUSALS,
  sendHead,
  UNKNOWN_CONNECTION,
} from './http-server-fields';
import type { IHTTPRequestLike, IHTTPResponseLike } from './types';

// interfaces

/** An exchange of a request, from its first 8 bytes to its answer. */
export interface IExchange {
  /** Its request, which an end written before its body is whole closes in stages. */
  readonly request: IHTTPRequestLike;
  /** A cancel came for it while its body was still coming: it is read to its end, then 204. */
  isCancelled: boolean;
  /** Its request went on to the router, which owes it an answer. */
  isDelivered: boolean;
  /** The transport ended it — an answer, a 204, a refusal, its connection closed — so its close is no loss. */
  isEnded: boolean;
  /** What its first 8 bytes said, once they came. */
  prefix: IExchangePrefix | undefined;
  readonly response: IHTTPResponseLike;
  /** Ends its connection, as lost, once its request waited past `exchangeTimeout` for its answer. */
  timer: TimeoutId | undefined;
}

/** What an envelope's prefix says the transport needs: its call id and its kind. */
interface IExchangePrefix {
  callId: number;
  kind: number;
}

/**
 * What an exchange needs of its server, for the connection it is on: its bounds, its exchange's
 * state, how a prefix is judged, and where the request and its answer go.
 */
export interface IHTTPRequestExchangePort<Connection> {
  /** Whether a connection may take another exchange, under the bound on what it has under way. */
  admitExchange: (connection: Connection) => boolean;
  /** The state of an exchange of `request`, answered on `response`. */
  createExchange: (exchange: IExchangeIn) => IExchange;
  /** An exchange under way on its connection, its idle timer stopped. */
  beginExchange: (connection: Connection) => void;
  /** Bytes of body charged against the server's budget: whether it is now past it. */
  chargeBody: (count: number) => boolean;
  /** Bytes of body given back to the server's budget. */
  releaseBody: (count: number) => void;
  /** An exchange done, both its request and its response: its connection rests once it has none. */
  endExchange: (connection: Connection) => void;
  /** An exchange ended before its body or its answer: no longer waiting under its call id. */
  endEarly: (connection: Connection, state: IExchange) => void;
  /** What the first 8 bytes say: a request waits under its call id from now on; or its refusal. */
  classify: (
    connection: Connection,
    state: IExchange,
    options: { layout: number; prefix: IExchangePrefix }
  ) => IEnd | undefined;
  /** What an exchange's first 8 bytes said, once they came. */
  prefixOf: (state: IExchange) => IExchangePrefix | undefined;
  /** Whether the transport ended an exchange. */
  isEnded: (state: IExchange) => boolean;
  /** Whether a cancel came for an exchange while its body was still coming. */
  isCancelled: (state: IExchange) => boolean;
  /** An exchange closed before the transport ended it: lost, as a dropped socket's frames are. */
  lose: (connection: Connection, state: IExchange) => void;
  /** A body read whole: ended as it came, its connection gone, or to go on. */
  finishBody: (connection: Connection, state: IExchange) => 'ended' | 'gone' | 'continue';
  /** A request about to go on to the router, which then owes it an answer. */
  beginHandOff: (state: IExchange) => void;
  /** A request handed on: whether it still waits for its answer. */
  waitAfterHandOff: (
    connection: Connection,
    state: IExchange,
    options: { callId: number }
  ) => boolean;
  /** Ends an exchange's connection, as lost, once its request waited past `exchangeTimeout`. */
  armExchangeTimer: (connection: Connection, state: IExchange) => void;
  /**
   * An envelope handed on to the router, with the credential its exchange carried, and the address
   * and port of the exchange that brought it.
   */
  message: (connection: Connection, message: ITransportMessage) => void;
  /** The client's address and port of an exchange, as the server reads them (spec 15.12). */
  originOf: (request: IHTTPRequestLike) => {
    address?: string | undefined;
    port?: number | undefined;
  };
  /** A cancel's call ended: the response of its exchange to end empty, when its head went. */
  cancel: (connection: Connection, callId: number) => IHTTPResponseLike | undefined;
  /** Ends an exchange the transport answers itself. */
  finish: (exchange: IExchangeIn, end: IEnd) => void;
}

/** The exchanges of a server: each request of one envelope, read and handed on. */
export interface IHTTPRequestExchange<Connection> {
  /**
   * One envelope: its body read into one buffer under its limits, its prefix checked from its first
   * 8 bytes, then handed on; a request's head sent and its timer armed, its answer written by the
   * server's `send`.
   */
  receive: (exchange: IExchangeIn, connection: Connection) => void;
}

/** A body as it comes: one buffer it grows into, so no chunk it came in is kept. */
interface IBody {
  bytes: Uint8Array;
  length: number;
}

// constants

// what a body is first given room for, before it grows
const FIRST_BODY_BYTES = 65_536;

// helpers

// a chunk copied into the body, which doubles its room as it needs, up to `limit`
const append = (body: IBody, { chunk, limit }: { chunk: Uint8Array; limit: number }): void => {
  const length = body.length + chunk.length;

  if (length > body.bytes.length) {
    const grown = new Uint8Array(Math.min(Math.max(length, 2 * body.bytes.length), limit));

    grown.set(body.bytes.subarray(0, body.length));
    body.bytes = grown;
  }

  body.bytes.set(chunk, body.length);
  body.length = length;
};

// definition

/** What bounds a body as it comes: its bytes, and its pace, on the server's clock. */
export interface IHTTPRequestExchangeOptions {
  /** How long, in milliseconds, a body comes before its rate is held, from its head. */
  bodyGracePeriod: number;
  clock: IClock;
  maximumBodyBytes: number;
  /** The slowest, in bytes a second, a body may come once its grace passed. */
  minimumBodyBytesPerSecond: number;
}

/**
 * The exchanges of one HTTP server: each body read to `maximumBodyBytes` at most, at
 * `minimumBodyBytesPerSecond` once `bodyGracePeriod` passed, charged against its `port`'s budget and
 * given back, its prefix judged, and its request handed on to its connection.
 */
export const createHTTPRequestExchange = <Connection>(
  port: IHTTPRequestExchangePort<Connection>,
  {
    bodyGracePeriod,
    clock,
    maximumBodyBytes,
    minimumBodyBytesPerSecond,
  }: IHTTPRequestExchangeOptions
): IHTTPRequestExchange<Connection> => {
  // one envelope: read into one buffer, its prefix checked from its first 8 bytes, then handed on
  const receive = (exchange: IExchangeIn, connection: Connection): void => {
    const { request, response } = exchange;
    const declared = Number(headerOf(request, 'content-length') ?? Number.NaN);
    const authorizations = linesOf(request, 'authorization');

    // ! a field that is no list is not combined (RFC 9110 §5.3): two are refused before either
    // could be taken for the other
    if (authorizations.length > 1) {
      return (port.finish(exchange, { reason: REFUSALS.MALFORMED, status: 400 }), undefined);
    }

    if (Number.isFinite(declared) && declared > maximumBodyBytes) {
      return (port.finish(exchange, { reason: REFUSALS.TOO_LARGE, status: 413 }), undefined);
    }

    // a bound on what one connection has under way, cancels included, well past what its
    // waiting requests may be: those are refused at their prefix
    if (!port.admitExchange(connection)) {
      return (port.finish(exchange, { reason: REFUSALS.BUSY, status: 429 }), undefined);
    }

    const state = port.createExchange(exchange);
    const body: IBody = {
      bytes: new Uint8Array(
        Number.isFinite(declared) ? Math.min(declared, FIRST_BODY_BYTES) : FIRST_BODY_BYTES
      ),
      length: 0,
    };
    let charged = 0;
    let received = 0;
    // under way until both its request and its response are done
    let sides = 2;
    // * its body's pace, on the server's clock from its head's reading: due once it has not brought
    // what the longer of its grace and its rate asks of it (spec 15.12)
    const headAt = clock.performance.now();
    let slow: TimeoutId | undefined;

    port.beginExchange(connection);

    const release = (): void => {
      port.releaseBody(charged);
      charged = 0;
    };

    const unpace = (): void => {
      clock.clearTimeout(slow);
      slow = undefined;
    };

    const done = (): void => {
      sides -= 1;

      if (sides === 0) {
        port.endExchange(connection);
      }
    };

    // ends it now, before its body or its answer; what still comes is dropped
    const endEarly = (end: IEnd): void => {
      unpace();
      port.endEarly(connection, state);

      port.finish(exchange, end);
    };

    // the body due by the longer of its grace and what its bytes take at its rate; past it, refused
    // 408, its charge released, what still comes dropped
    const pace = (): void => {
      const due =
        headAt +
        Math.max(bodyGracePeriod, Math.ceil((received * 1_000) / minimumBodyBytesPerSecond));

      clock.clearTimeout(slow);
      slow = clock.setTimeout(
        () => {
          slow = undefined;

          if (!port.isEnded(state)) {
            release();
            endEarly({ reason: REFUSALS.TOO_SLOW, status: 408 });
          }
        },
        Math.max(0, due - clock.performance.now())
      );
      // a browser's timer has no `unref`
      (slow as { unref?: () => unknown }).unref?.();
    };

    // what the first 8 bytes say: a request waits under its call id from now on
    const classify = (head: Uint8Array): void => {
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const layout = view.getUint8(0);
      const kind = view.getUint8(1);
      const callId = view.getUint32(4);

      const candidate = { callId, kind };
      const refused = port.classify(connection, state, { layout, prefix: candidate });

      if (refused !== undefined) {
        return (endEarly(refused), undefined);
      }
    };

    response.on('close', () => {
      unpace();
      release();
      // closed before the transport ended it: lost, as a dropped socket's frames are
      port.lose(connection, state);

      done();
    });

    request.on('close', () => {
      unpace();
      release();
      done();
    });

    request.on('data', (chunk) => {
      // ! what comes once it ended is dropped, and charged nothing: an answer written before its
      // body is whole reads on until its client closes, and a body refused holds no budget
      if (port.isEnded(state)) {
        return (unpace(), undefined);
      }

      received += chunk.length;
      charged += chunk.length;
      const isOverBudget = port.chargeBody(chunk.length);

      // past the limit, it is refused, its charge released
      if (received > maximumBodyBytes) {
        unpace();
        release();

        return (endEarly({ reason: REFUSALS.TOO_LARGE, status: 413 }), undefined);
      }

      if (isOverBudget) {
        const busy = { headers: { 'retry-after': '1' }, reason: REFUSALS.BUSY, status: 503 };

        unpace();
        release();

        return (endEarly(busy), undefined);
      }

      pace();

      if (port.isCancelled(state)) {
        return undefined;
      }

      append(body, { chunk, limit: maximumBodyBytes });

      if (port.prefixOf(state) === undefined && body.length >= ENVELOPE_PREFIX.bytes) {
        classify(body.bytes.subarray(0, ENVELOPE_PREFIX.bytes));
      }

      return undefined;
    });

    request.on('error', () => {
      unpace();
      release();
    });

    pace();

    request.on('end', () => {
      unpace();
      release();

      const outcome = port.finishBody(connection, state);

      if (outcome === 'ended') {
        return undefined;
      }

      // its connection closed while its body came: its client learns it is gone
      if (outcome === 'gone') {
        return (endWith(response, UNKNOWN_CONNECTION), undefined);
      }

      const prefix = port.prefixOf(state);

      if (prefix === undefined) {
        return (endEarly({ reason: REFUSALS.MALFORMED, status: 400 }), undefined);
      }

      const { callId, kind } = prefix;

      // its cancel came first, or while it came: dropped, and ended empty
      if (port.isCancelled(state)) {
        return (endEarly({ status: 204 }), undefined);
      }

      const envelope = body.bytes.slice(0, body.length);

      // a request is handed on with the credential its exchange carried; no other envelope is
      if (kind === ENVELOPE_KINDS.REQUEST) {
        const credential = credentialOf(authorizations);

        port.beginHandOff(state);
        port.message(connection, { ...port.originOf(request), credential, data: envelope });

        // still waiting — not answered as it came — its head goes now, so its client knows the
        // router has it; and it waits for its answer no longer than it may
        if (port.waitAfterHandOff(connection, state, { callId })) {
          sendHead(response);

          port.armExchangeTimer(connection, state);
        }

        return undefined;
      }

      port.message(connection, {
        ...port.originOf(request),
        credential: undefined,
        data: envelope,
      });

      if (kind === ENVELOPE_KINDS.CANCEL) {
        const cancelled = port.cancel(connection, callId);

        if (cancelled !== undefined) {
          endWith(cancelled, { status: 204 });
        }
      }

      return (endEarly({ status: 204 }), undefined);
    });
  };

  return { receive };
};
