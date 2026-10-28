// constants

export const CLOSE_EVENT = 'close';
export const CONNECTION_EVENT = 'connection';
export const ERROR_EVENT = 'error';
export const LISTEN_EVENT = 'listen';
export const MESSAGE_EVENT = 'message';
export const RECONNECT_EVENT = 'reconnect';
export const REFUSAL_EVENT = 'refusal';

export const TRANSPORT_AMQP = 'AMQP';
export const TRANSPORT_BROKER = 'BROKER';
export const TRANSPORT_HTTP = 'HTTP';
export const TRANSPORT_MEMORY = 'MEMORY';
export const TRANSPORT_MQTT = 'MQTT';
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
 * an Item of RFC 9651 whose bare item is a Boolean (§3.3.6), its parameters ignored (§2.3). The
 * server's 201 carries it back when it takes the listen, as a WebSocket server names the subprotocol
 * it chose; either way, it holds for the connection's life.
 */
export const LISTEN_HEADER = 'bead-listen';

/**
 * The header that numbers a batch's first envelope, the others following one by one: an Item of
 * RFC 9651 whose bare item is an Integer, 1 or more. A listen acknowledges by `bead-after` the last
 * one its client heard whole.
 */
export const SEQUENCE_HEADER = 'bead-sequence';

/**
 * The header a listen acknowledges in: the number of the last envelope its client heard whole; an
 * Item whose bare item is an Integer of RFC 9651, 0 or more.
 */
export const AFTER_HEADER = 'bead-after';

/** The header a listen asks the server to hold it in, in milliseconds; 0 when left out. */
export const WAIT_HEADER = 'bead-wait';

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
 * tell by itself — clean, or, from the client, lost.
 */
export const WORKER_MESSAGES = Object.freeze({
  CLOSE: 'bead-close',
  CONNECT: 'bead-connect',
  LOST: 'bead-lost',
  OPEN: 'bead-open',
});

/** The deliveries a broker's adapter gives (spec 15.19). */
export const BROKER_DELIVERIES = Object.freeze({
  AT_LEAST_ONCE: 'at-least-once',
  AT_MOST_ONCE: 'at-most-once',
});

/** What a broker says of a publication: taken, or refused for want of a subscriber. */
export const BROKER_PUBLISHED = Object.freeze({
  NO_SUBSCRIBER: 'no-subscriber',
  TAKEN: 'taken',
});

/**
 * How long a WebSocket's close handshake may take by default, a client's or a server's: a peer that
 * never answers is dropped after it (spec 15.3).
 */
export const CLOSE_TIMEOUT = 5_000;

/** `'arraybuffer'` rather than `'blob'`: an envelope is read synchronously, and a `Blob` cannot be. */
export const TRANSPORT_WEBSOCKET_BINARYTYPE = 'arraybuffer' as const;

/**
 * What `ws` codes the errors of what it reads by: each a protocol error, or a message past its
 * `maxPayload`, {@link WS_TOO_BIG_CODE}, each failing its connection (RFC 6455 §7.1.7).
 */
export const WS_ERROR_CODE_PREFIX = 'WS_ERR_';

/** The code `ws` gives a message past its `maxPayload`, which fails its connection with 1009. */
export const WS_TOO_BIG_CODE = 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

// types

export type CLOSE_EVENT = typeof CLOSE_EVENT;
export type CONNECTION_EVENT = typeof CONNECTION_EVENT;
export type ERROR_EVENT = typeof ERROR_EVENT;
export type LISTEN_EVENT = typeof LISTEN_EVENT;
export type MESSAGE_EVENT = typeof MESSAGE_EVENT;
export type RECONNECT_EVENT = typeof RECONNECT_EVENT;
export type REFUSAL_EVENT = typeof REFUSAL_EVENT;

export type TRANSPORT_AMQP = typeof TRANSPORT_AMQP;
export type TRANSPORT_BROKER = typeof TRANSPORT_BROKER;
export type TRANSPORT_HTTP = typeof TRANSPORT_HTTP;
export type TRANSPORT_MEMORY = typeof TRANSPORT_MEMORY;
export type TRANSPORT_MQTT = typeof TRANSPORT_MQTT;
export type TRANSPORT_WORKER = typeof TRANSPORT_WORKER;
export type TRANSPORT_WS = typeof TRANSPORT_WS;
export type TRANSPORTS =
  | TRANSPORT_AMQP
  | TRANSPORT_BROKER
  | TRANSPORT_HTTP
  | TRANSPORT_MEMORY
  | TRANSPORT_MQTT
  | TRANSPORT_WORKER
  | TRANSPORT_WS;
