// ── HTTP request exchange ─────────────────────────────────────────────────────

// dependencies

import type { TimeoutId } from '../shared/clock';
import type { ITransportMessage } from '../shared/types';
import { credentialOf } from './hosts-and-origins';
import {
  ENVELOPE_KINDS,
  ENVELOPE_PREFIX,
  REFUSALS,
  UNKNOWN_CONNECTION,
  endWith,
  headerOf,
  linesOf,
  sendHead,
} from './http-server-fields';
import type { IEnd, IExchangeIn } from './http-server-fields';
import type { IHTTPResponseLike } from './types';

// interfaces

/** An exchange of a request, from its first 8 bytes to its answer. */
export interface IExchange {
  /** A cancel came for it while its body was still coming: it is read to its end, then 204. */
  isCancelled: boolean;
  /** Its request went on to the router, which owes it an answer. */
  isDelivered: boolean;
  /** The transport ended it — an answer, a 204, a refusal, its connection closed — so its close is no loss. */
  isEnded: boolean;
  prefix: IExchangePrefix | undefined;
  readonly response: IHTTPResponseLike;
  /** Ends its connection, as lost, once its request waited past `exchangeTimeout` for its answer. */
  timer: TimeoutId | undefined;
}

interface IExchangePrefix {
  callId: number;
  kind: number;
}

/**
 * What an exchange needs of its server, for the connection it is on: its bounds, its exchange's
 * state, how a prefix is judged, and where the request and its answer go.
 */
export interface IHTTPRequestExchangePort<Connection> {
  admitExchange: (connection: Connection) => boolean;
  createExchange: (response: IHTTPResponseLike) => IExchange;
  beginExchange: (connection: Connection) => void;
  chargeBody: (count: number) => boolean;
  releaseBody: (count: number) => void;
  endExchange: (connection: Connection) => void;
  endEarly: (connection: Connection, state: IExchange) => void;
  classify: (
    connection: Connection,
    state: IExchange,
    options: { layout: number; prefix: IExchangePrefix }
  ) => IEnd | undefined;
  prefixOf: (state: IExchange) => IExchangePrefix | undefined;
  isEnded: (state: IExchange) => boolean;
  isCancelled: (state: IExchange) => boolean;
  lose: (connection: Connection, state: IExchange) => void;
  finishBody: (connection: Connection, state: IExchange) => 'ended' | 'gone' | 'continue';
  beginHandOff: (state: IExchange) => void;
  waitAfterHandOff: (
    connection: Connection,
    state: IExchange,
    options: { callId: number }
  ) => boolean;
  armExchangeTimer: (connection: Connection, state: IExchange) => void;
  message: (connection: Connection, message: ITransportMessage) => void;
  cancel: (connection: Connection, callId: number) => IHTTPResponseLike | undefined;
  finish: (exchange: IExchangeIn, end: IEnd) => void;
}

/** The exchanges of a server: each request of one envelope, read and handed on. */
export interface IHTTPRequestExchange<Connection> {
  /**
   * One envelope: its body read into one buffer under its limits, its prefix checked from its first
   * 8 bytes, then handed on, and its answer waited for.
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

/**
 * The exchanges of one HTTP server: each body read to `maximumBodyBytes` at most, charged against
 * its `port`'s budget and given back, its prefix judged, and its request handed on to its connection.
 */
export const createHTTPRequestExchange = <Connection>(
  port: IHTTPRequestExchangePort<Connection>,
  { maximumBodyBytes }: { maximumBodyBytes: number }
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

    const state = port.createExchange(response);
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

    port.beginExchange(connection);

    const release = (): void => {
      port.releaseBody(charged);
      charged = 0;
    };

    const done = (): void => {
      sides -= 1;

      if (sides === 0) {
        port.endExchange(connection);
      }
    };

    // ends it now, before its body or its answer; what still comes is counted, and dropped
    const endEarly = (end: IEnd): void => {
      port.endEarly(connection, state);

      port.finish(exchange, end);
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
      release();
      // closed before the transport ended it: lost, as a dropped socket's frames are
      port.lose(connection, state);

      done();
    });

    request.on('close', () => {
      release();
      done();
    });

    request.on('data', (chunk) => {
      received += chunk.length;
      charged += chunk.length;
      const isOverBudget = port.chargeBody(chunk.length);

      // past the limit, it is refused, and then no more of it is read
      if (received > maximumBodyBytes) {
        if (!port.isEnded(state)) {
          endEarly({ reason: REFUSALS.TOO_LARGE, status: 413 });
        }

        return (request.destroy(), undefined);
      }

      if (isOverBudget && !port.isEnded(state)) {
        const busy = { headers: { 'retry-after': '1' }, reason: REFUSALS.BUSY, status: 503 };

        return (endEarly(busy), undefined);
      }

      if (port.isEnded(state) || port.isCancelled(state)) {
        return undefined;
      }

      append(body, { chunk, limit: maximumBodyBytes });

      if (port.prefixOf(state) === undefined && body.length >= ENVELOPE_PREFIX.bytes) {
        classify(body.bytes.subarray(0, ENVELOPE_PREFIX.bytes));
      }

      return undefined;
    });

    request.on('error', () => {
      release();
    });

    request.on('end', () => {
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
        port.message(connection, { credential, data: envelope });

        // still waiting — not answered as it came — its head goes now, so its client knows the
        // router has it; and it waits for its answer no longer than it may
        if (port.waitAfterHandOff(connection, state, { callId })) {
          sendHead(response);

          port.armExchangeTimer(connection, state);
        }

        return undefined;
      }

      port.message(connection, { credential: undefined, data: envelope });

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
