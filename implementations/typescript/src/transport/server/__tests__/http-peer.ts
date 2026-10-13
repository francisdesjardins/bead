// ── HTTP peer ─────────────────────────────────────────────────────────────────

// A peer of the test's own over HTTP/1.1, as `spec/transports.json` plays one: each exchange on a
// socket of its own, its request written in exact octets, its response read as its bytes come; an
// exchange answered 101 goes on as a WebSocket, whose frames the peer writes and reads itself.

// dependencies

import { connect } from 'node:net';
import { toError } from '../../shared/errors';
import { noop } from '../../shared/noop';

// interfaces

/** A response's head: its status, and its fields by name in lower case. */
export interface IResponseHead {
  fields: ReadonlyMap<string, string>;
  status: number;
}

/** A response read whole: its head, and its body, de-chunked. */
export interface IResponse extends IResponseHead {
  body: Uint8Array;
}

/** A response read as its bytes come, in whatever reads they come. */
export interface IResponseReader {
  /** Settles once the head is read, so a response whose body never comes still shows its head. */
  readonly head: Promise<IResponseHead>;
  /** The stream ended, reset or not, before any status line: the exchange is lost. */
  readonly isLost: boolean;
  /** Settles once the body is whole. */
  readonly response: Promise<IResponse>;
  /** The stream ended: a body read to its end is whole, any other is cut short. */
  end(error?: Error): void;
  feed(bytes: Uint8Array): void;
}

/** A WebSocket frame, RFC 6455 5.2: its opcode, whether it ends its message, and its payload. */
export interface IFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** One exchange: its socket, its response as it comes, and, once answered 101, its WebSocket. */
export interface IExchange {
  /** The port of the socket's own end, which names a WebSocket's connection on the server. */
  readonly localPort: number | undefined;
  readonly reader: IResponseReader;
  destroy(): void;
  /**
   * The next thing the server sends on its WebSocket, or none within `within` milliseconds; rejects
   * once a frame of a reserved opcode came, which ends the socket.
   */
  next(within: number): Promise<Heard | undefined>;
  /** Writes frames on its WebSocket, each masked, as a client's must be. */
  send(frames: readonly IFrame[]): void;
}

// types

/**
 * What the server sends on a WebSocket, each as it comes: a message whole, a close, a ping, a pong,
 * the end.
 */
export type Heard =
  | { binary: Uint8Array }
  | { close: number }
  | { end: true }
  | { ping: Uint8Array }
  | { pong: Uint8Array }
  | { text: string };

// constants

const CRLF = '\r\n';
const HEAD_END = '\r\n\r\n';

/** The opcodes of RFC 6455 5.2 the peer writes and reads. */
export const OPCODES = Object.freeze({
  BINARY: 0x2,
  CLOSE: 0x8,
  CONTINUATION: 0x0,
  PING: 0x9,
  PONG: 0xa,
  TEXT: 0x1,
});

// every opcode RFC 6455 5.2 defines; the others are reserved, and a peer fails the connection on one
const DEFINED_OPCODES: ReadonlySet<number> = new Set(Object.values(OPCODES));

// the masking key of RFC 6455's examples, 5.7: fixed, so what the peer writes is the same each run
const MASK = Uint8Array.of(0x37, 0xfa, 0x21, 0x3d);

// a close that carries no code, RFC 6455 7.1.5
const NO_STATUS = 1005;

const decoder = new TextDecoder();

// helpers

// a body in chunks, de-chunked, and where it ends; none while its last chunk and the trailers after
// it are to come
const dechunk = (bytes: Buffer): { body: Buffer; end: number } | undefined => {
  const parts: Buffer[] = [];
  let at = 0;

  for (;;) {
    const lineEnd = bytes.indexOf(CRLF, at);

    if (lineEnd === -1) {
      return undefined;
    }

    const [digits = ''] = bytes.subarray(at, lineEnd).toString('latin1').split(';');
    const size = Number.parseInt(digits.trim(), 16);

    if (Number.isNaN(size)) {
      throw new Error(`a chunk's size is no number: ${digits}`);
    }

    at = lineEnd + CRLF.length;

    // the last chunk: its trailers, each a line, end at an empty one
    if (size === 0) {
      for (let end = bytes.indexOf(CRLF, at); end !== -1; end = bytes.indexOf(CRLF, at)) {
        if (end === at) {
          return { body: Buffer.concat(parts), end: end + CRLF.length };
        }

        at = end + CRLF.length;
      }

      return undefined;
    }

    if (bytes.length < at + size + CRLF.length) {
      return undefined;
    }

    parts.push(bytes.subarray(at, at + size));
    at += size + CRLF.length;
  }
};

// a head's status line and fields; a field named twice is its values joined, as RFC 9110 5.3 reads it
const headOf = (text: string): IResponseHead => {
  const [line = '', ...lines] = text.split(CRLF);
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(line)?.[1];
  const fields = new Map<string, string>();

  if (status === undefined) {
    throw new Error(`no status line: ${line}`);
  }

  for (const each of lines) {
    const colon = each.indexOf(':');
    const name = each.slice(0, colon).trim().toLowerCase();
    const value = each.slice(colon + 1).trim();
    const before = fields.get(name);

    fields.set(name, before === undefined ? value : `${before}, ${value}`);
  }

  return { fields, status: Number(status) };
};

// how a body is framed, RFC 9112 6.3: none after a 1xx, a 204 or a 304; chunked; by its length; or
// to the end of the stream
const framingOf = ({ fields, status }: IResponseHead): 'chunked' | 'end' | number => {
  if (status < 200 || status === 204 || status === 304) {
    return 0;
  }

  if (fields.get('transfer-encoding')?.toLowerCase().includes('chunked') === true) {
    return 'chunked';
  }

  const length = fields.get('content-length');

  return length === undefined ? 'end' : Number(length);
};

/** A frame as a client writes it, RFC 6455 5.2: masked, its length in 7, 16 or 64 bits as it needs. */
export const frameOf = ({ fin, opcode, payload }: IFrame): Uint8Array => {
  const { length } = payload;
  const extended = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const at = 2 + extended + MASK.length;
  const frame = new Uint8Array(at + length);
  const view = new DataView(frame.buffer);

  view.setUint8(0, (fin ? 0x80 : 0) | opcode);
  view.setUint8(1, 0x80 | (extended === 0 ? length : extended === 2 ? 126 : 127));

  if (extended === 2) {
    view.setUint16(2, length);
  } else if (extended === 8) {
    view.setBigUint64(2, BigInt(length));
  }

  frame.set(MASK, 2 + extended);
  payload.forEach((byte, index) => {
    view.setUint8(at + index, byte ^ (MASK[index % MASK.length] ?? 0));
  });

  return frame;
};

/** A close frame and its code, RFC 6455 5.5.1. */
export const closeFrameOf = (code: number): IFrame => {
  const payload = new Uint8Array(2);

  new DataView(payload.buffer).setUint16(0, code);

  return { fin: true, opcode: OPCODES.CLOSE, payload };
};

// definition

/**
 * A reader of one HTTP/1.1 response, fed its bytes as they come; `onWhole` is given the response once
 * whole, and what came after it, which a 101 hands to the protocol it switched to.
 */
export const createResponseReader = (
  onWhole?: (response: IResponse, rest: Uint8Array) => void
): IResponseReader => {
  const head = Promise.withResolvers<IResponseHead>();
  const whole = Promise.withResolvers<IResponse>();
  let pending = Buffer.alloc(0);
  let read: { framing: 'chunked' | 'end' | number; head: IResponseHead } | undefined;
  let isSettled = false;
  let isLost = false;

  // a response nobody waits for may be cut short: neither rejection goes unhandled
  head.promise.catch(noop);
  whole.promise.catch(noop);

  const fail = (error: Error): void => {
    isSettled = true;
    head.reject(error);
    whole.reject(error);
  };

  const settle = (body: Uint8Array, rest: Uint8Array): void => {
    if (read !== undefined) {
      const response = { ...read.head, body };

      isSettled = true;
      whole.resolve(response);
      onWhole?.(response, rest);
    }
  };

  // the head once it is in, then the body once it is whole
  const advance = (): void => {
    if (read === undefined) {
      const at = pending.indexOf(HEAD_END);

      if (at === -1) {
        return;
      }

      const parsed = headOf(pending.subarray(0, at).toString('latin1'));

      read = { framing: framingOf(parsed), head: parsed };
      pending = pending.subarray(at + HEAD_END.length);
      head.resolve(parsed);
    }

    const { framing } = read;

    if (framing === 'chunked') {
      const chunked = dechunk(pending);

      if (chunked !== undefined) {
        settle(chunked.body, pending.subarray(chunked.end));
      }

      return;
    }

    if (typeof framing === 'number' && pending.length >= framing) {
      settle(pending.subarray(0, framing), pending.subarray(framing));
    }
  };

  return {
    end: (error) => {
      if (isSettled) {
        return;
      }

      if (read?.framing === 'end') {
        settle(pending, new Uint8Array());

        return;
      }

      const reason = read === undefined ? 'the head' : 'the body';

      isLost = read === undefined;

      fail(error ?? new Error(`the stream ended before ${reason} was whole`));
    },
    feed: (bytes) => {
      if (isSettled) {
        return;
      }

      pending = Buffer.concat([pending, bytes]);

      try {
        advance();
      } catch (error) {
        fail(toError(error));
      }
    },
    head: head.promise,
    get isLost() {
      return isLost;
    },
    response: whole.promise,
  };
};

/**
 * A reader of the frames a server sends, RFC 6455 5: a message's frames assembled, each thing heard
 * handed to `hear` as it comes whole, and each control frame to `answer`, which may answer it. A
 * frame of a reserved opcode throws.
 */
const createFrameReader = ({
  answer,
  hear,
}: {
  answer: (frame: IFrame) => void;
  hear: (heard: Heard) => void;
}) => {
  let pending = Buffer.alloc(0);
  let message: { opcode: number; parts: Buffer[] } | undefined;

  const onFrame = (frame: IFrame): void => {
    const { fin, opcode, payload } = frame;

    if (!DEFINED_OPCODES.has(opcode)) {
      throw new Error(`the server sent a frame of reserved opcode 0x${opcode.toString(16)}`);
    }

    if (opcode === OPCODES.CLOSE) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

      hear({ close: payload.length >= 2 ? view.getUint16(0) : NO_STATUS });
      answer(frame);

      return;
    }

    if (opcode === OPCODES.PING) {
      hear({ ping: payload });
      answer(frame);

      return;
    }

    if (opcode === OPCODES.PONG) {
      hear({ pong: payload });

      return;
    }

    if (opcode === OPCODES.BINARY || opcode === OPCODES.TEXT) {
      message = { opcode, parts: [] };
    }

    if (message === undefined) {
      return;
    }

    message.parts.push(Buffer.from(payload));

    if (fin) {
      const bytes = Buffer.concat(message.parts);

      hear(message.opcode === OPCODES.TEXT ? { text: decoder.decode(bytes) } : { binary: bytes });
      message = undefined;
    }
  };

  // each frame whole, its length in 7, 16 or 64 bits, unmasked when masked
  const advance = (): void => {
    while (pending.length >= 2) {
      const first = pending.readUInt8(0);
      const second = pending.readUInt8(1);
      const short = second & 0x7f;
      const extended = short === 126 ? 2 : short === 127 ? 8 : 0;
      const isMasked = (second & 0x80) !== 0;
      const at = 2 + extended + (isMasked ? MASK.length : 0);

      if (pending.length < at) {
        return;
      }

      const length =
        extended === 0
          ? short
          : extended === 2
            ? pending.readUInt16BE(2)
            : Number(pending.readBigUInt64BE(2));

      if (pending.length < at + length) {
        return;
      }

      const key = pending.subarray(2 + extended, 2 + extended + MASK.length);
      const payload = Buffer.from(pending.subarray(at, at + length)).map((byte, index) => {
        return isMasked ? byte ^ (key[index % MASK.length] ?? 0) : byte;
      });

      pending = pending.subarray(at + length);
      onFrame({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    }
  };

  return {
    feed: (bytes: Uint8Array): void => {
      pending = Buffer.concat([pending, bytes]);
      advance();
    },
  };
};

/**
 * Opens a socket to `port` on `host`, writes `request` on it at once, and reads its response as it
 * comes; nothing waits for it. Answered 101, the socket goes on as a WebSocket: what the server
 * sends is heard in order, a ping answered with its pong unless `answersPings` is false, and a close
 * answered with its own code, as RFC 6455 5.5.1 asks of the side that did not close first.
 */
export const openExchange = (
  {
    answersPings = true,
    host,
    port,
  }: { answersPings?: boolean | undefined; host: string; port: number },
  request: Uint8Array
): IExchange => {
  const socket = connect({ host, port });
  // what came, in order, a frame the peer fails on among it
  const heard: (Heard | Error)[] = [];
  let waiting: ((each: Heard | Error) => void) | undefined;
  let frames: ReturnType<typeof createFrameReader> | undefined;
  let hasClosed = false;
  let hasEnded = false;
  let localPort: number | undefined;

  const hear = (each: Heard | Error): void => {
    const taker = waiting;

    waiting = undefined;

    if (taker === undefined) {
      heard.push(each);
    } else {
      taker(each);
    }
  };

  const send = (each: readonly IFrame[]): void => {
    hasClosed ||= each.some(({ opcode }) => {
      return opcode === OPCODES.CLOSE;
    });
    socket.write(Buffer.concat(each.map(frameOf)));
  };

  const answer = ({ opcode, payload }: IFrame): void => {
    if (opcode === OPCODES.PING && answersPings) {
      send([{ fin: true, opcode: OPCODES.PONG, payload }]);
    }

    if (opcode === OPCODES.CLOSE && !hasClosed && !socket.destroyed) {
      send([{ fin: true, opcode: OPCODES.CLOSE, payload }]);
    }
  };

  // a frame of a reserved opcode fails the connection, RFC 6455 5.2: heard as the failure it is,
  // the socket ended behind it
  const feedFrames = (bytes: Uint8Array): void => {
    try {
      frames?.feed(bytes);
    } catch (error) {
      hear(toError(error));
      socket.destroy();
    }
  };

  const reader = createResponseReader((response, rest) => {
    if (response.status === 101) {
      frames = createFrameReader({ answer, hear });
      feedFrames(rest);
    }
  });

  const end = (error?: Error): void => {
    reader.end(error);

    if (!hasEnded) {
      hasEnded = true;
      hear({ end: true });
    }
  };

  socket.on('connect', () => {
    ({ localPort } = socket);
  });
  socket.on('data', (bytes) => {
    if (frames === undefined) {
      reader.feed(bytes);
    } else {
      feedFrames(bytes);
    }
  });
  socket.on('error', (error) => {
    end(error);
  });
  socket.on('close', () => {
    end();
  });
  socket.write(request);

  return {
    get localPort() {
      return localPort;
    },
    destroy: () => {
      socket.destroy();
    },
    next: (within) => {
      const first = heard.shift();

      if (first !== undefined) {
        return first instanceof Error ? Promise.reject(first) : Promise.resolve(first);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = undefined;
          resolve(undefined);
        }, within);

        waiting = (each) => {
          clearTimeout(timer);

          if (each instanceof Error) {
            reject(each);
          } else {
            resolve(each);
          }
        };
      });
    },
    reader,
    send,
  };
};
