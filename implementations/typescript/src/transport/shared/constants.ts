// constants

export const CLOSE_EVENT = 'close';
export const CONNECTION_EVENT = 'connection';
export const ERROR_EVENT = 'error';
export const MESSAGE_EVENT = 'message';
export const RECONNECT_EVENT = 'reconnect';

export const TRANSPORT_HTTP = 'HTTP';
export const TRANSPORT_WORKER = 'WORKER';
export const TRANSPORT_WS = 'WS';

/**
 * A Bead envelope's media type over HTTP, in the personal tree (RFC 6838 §3.3): no vendor owns Bead.
 * A body of any other type is refused, 415, so a page a portal or a proxy slips in is never read.
 */
export const BEAD_MEDIA_TYPE = 'application/prs.bead';

/**
 * What a listen brings back over HTTP: the envelopes the server sent of its own, in their order, each
 * after its length in 4 bytes, in network order — read as they come, each bounded alone, as a
 * socket's frames are.
 */
export const BEAD_BATCH_MEDIA_TYPE = 'application/prs.bead-batch';

/** The header that carries a drawn connection's token, on every exchange after the one drawing it. */
export const CONNECTION_TOKEN_HEADER = 'bead-connection-token';

/**
 * The header a connect carries when its client listens for what the server sends of its own: `?1`,
 * a boolean structured field (RFC 9651 §3.3.6). The server's 201 carries it back when it takes the
 * listen, as a WebSocket server names the subprotocol it chose; either way, it holds for the
 * connection's life.
 */
export const LISTEN_HEADER = 'bead-listen';

/**
 * The header that numbers a batch's first envelope, the others following one by one; a listen
 * acknowledges by `after` the last one its client heard whole.
 */
export const SEQUENCE_HEADER = 'bead-sequence';

/**
 * The header that marks each refusal of the HTTP transport's own, with its reason, among the
 * statuses anything on the way may answer: a client rejects its send on a marked refusal alone —
 * nothing was tried — and `connection-unknown`, on a 404, closes it.
 */
export const REFUSAL_HEADER = 'bead-refusal';
export const CONNECTION_UNKNOWN = 'connection-unknown';

/**
 * What a worker transport posts besides envelopes, which go as bytes: a connect, with the port its
 * connection takes; its acceptance, on that port; and the close of either end, which a port does not
 * tell by itself.
 */
export const WORKER_MESSAGES = Object.freeze({
  CLOSE: 'bead-close',
  CONNECT: 'bead-connect',
  OPEN: 'bead-open',
});

/** The longest delay a timer holds, in milliseconds: past it, `setTimeout` fires at once. */
export const TIMER_MAX = 2 ** 31 - 1;

/** `'arraybuffer'` rather than `'blob'`: an envelope is read synchronously, and a `Blob` cannot be. */
export const TRANSPORT_WEBSOCKET_BINARYTYPE = 'arraybuffer' as const;

// types

export type CLOSE_EVENT = typeof CLOSE_EVENT;
export type CONNECTION_EVENT = typeof CONNECTION_EVENT;
export type ERROR_EVENT = typeof ERROR_EVENT;
export type MESSAGE_EVENT = typeof MESSAGE_EVENT;
export type RECONNECT_EVENT = typeof RECONNECT_EVENT;

export type TRANSPORT_HTTP = typeof TRANSPORT_HTTP;
export type TRANSPORT_WORKER = typeof TRANSPORT_WORKER;
export type TRANSPORT_WS = typeof TRANSPORT_WS;
export type TRANSPORTS = TRANSPORT_HTTP | TRANSPORT_WORKER | TRANSPORT_WS;
