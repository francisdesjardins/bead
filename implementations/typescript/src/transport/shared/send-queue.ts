// ── Send queue ────────────────────────────────────────────────────────────────

// dependencies

import type { Data } from './types';

// interfaces

/** The part of a socket a send queue hands its messages to — met by `ws`'s `WebSocket`. */
export interface IQueuedSocketLike {
  /** The bytes handed to it that its socket has not taken yet. */
  readonly bufferedAmount?: number | undefined;
  readonly readyState: number;
  /** Sends `data`, calling `callback` once it is written out, as `ws` does. */
  send(data: Data, callback?: (error?: Error) => void): void;
}

/**
 * What one WebSocket connection holds that its socket was not handed yet, in order, so that its
 * ping goes ahead of it (spec 15.3): its socket is handed a message while it holds less than
 * {@link SOCKET_MARK}, and the rest waits here.
 */
export interface ISendQueue {
  /** What it holds, in bytes, that its socket was not handed yet. */
  readonly heldBytes: number;

  /** Drops what it holds: its connection ended. */
  clear(): void;
  /** Hands its socket everything it holds, as a close goes behind it. */
  flush(): void;
  /** Hands `data`, of `bytes`, to its socket behind what it holds, or holds it. */
  send(data: Data, bytes: number): void;
}

// constants

/**
 * What a socket holds, in bytes, past which a send queue holds what comes rather than hand it on:
 * 128 KiB, what tungstenite's write buffer holds on the Rust side before it writes.
 */
export const SOCKET_MARK = 131_072;

// the WebSocket's OPEN, which `ws` and the global `WebSocket` share
const OPEN = 1;

const encoder = new TextEncoder();

// helpers

/** The bytes `data` holds as it goes: a text message's encoded. */
export const bytesOf = (data: Data): number => {
  if (typeof data === 'string') {
    return encoder.encode(data).byteLength;
  }

  return data instanceof Blob ? data.size : data.byteLength;
};

// definition

/**
 * A send queue in front of `socket`. Each message is handed on as its socket's `bufferedAmount`
 * falls under {@link SOCKET_MARK}, woken by the callback of a send before it: a socket that calls
 * back no send it is handed, and holds a `bufferedAmount` under the mark, is handed every message
 * at once.
 *
 * @example
 * const queue = createSendQueue(socket);
 * queue.send(envelope, envelope.byteLength);
 * socket.ping(data); // ahead of what the queue holds
 */
export const createSendQueue = (socket: IQueuedSocketLike): ISendQueue => {
  const held: { bytes: number; data: Data }[] = [];
  let heldBytes = 0;
  // the sends handed on whose callback has not come yet: with none, nothing would wake the queue
  let inFlight = 0;

  const clear = (): void => {
    held.length = 0;
    heldBytes = 0;
  };
  const isRoom = (): boolean => {
    return inFlight === 0 || (socket.bufferedAmount ?? 0) < SOCKET_MARK;
  };
  // * a send written out, or failed: what it holds is handed on while its socket has room, and
  // dropped once its socket is no longer open, which takes nothing more
  const wake = (): void => {
    inFlight = Math.max(0, inFlight - 1);

    if (socket.readyState !== OPEN) {
      return (clear(), undefined);
    }

    while (held.length > 0 && isRoom()) {
      take();
    }

    return undefined;
  };
  const handOn = (data: Data): void => {
    inFlight += 1;
    socket.send(data, wake);
  };
  const take = (): void => {
    const next = held.shift();

    if (next !== undefined) {
      heldBytes -= next.bytes;
      handOn(next.data);
    }
  };

  return {
    get heldBytes() {
      return heldBytes;
    },

    clear,
    flush: () => {
      while (held.length > 0 && socket.readyState === OPEN) {
        take();
      }

      clear();
    },
    send: (data, bytes) => {
      if (held.length === 0 && isRoom()) {
        return (handOn(data), undefined);
      }

      held.push({ bytes, data });
      heldBytes += bytes;

      return undefined;
    },
  };
};
