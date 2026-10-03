// ── HTTP peer ─────────────────────────────────────────────────────────────────

// A peer of the test's own over HTTP/1.1, as `spec/transports.json` plays one: each exchange on a
// socket of its own, its request written in exact octets, its response read as its bytes come.

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
  /** Settles once the body is whole. */
  readonly response: Promise<IResponse>;
  /** The stream ended: a body read to its end is whole, any other is cut short. */
  end(error?: Error): void;
  feed(bytes: Uint8Array): void;
}

/** One exchange: its socket, and its response as it comes. */
export interface IExchange {
  readonly reader: IResponseReader;
  destroy(): void;
}

// constants

const CRLF = '\r\n';
const HEAD_END = '\r\n\r\n';

// helpers

// a body in chunks, de-chunked, or none while its last chunk and the trailers after it are to come
const dechunk = (bytes: Buffer): Buffer | undefined => {
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
          return Buffer.concat(parts);
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

// definition

/** A reader of one HTTP/1.1 response, fed its bytes as they come. */
export const createResponseReader = (): IResponseReader => {
  const head = Promise.withResolvers<IResponseHead>();
  const whole = Promise.withResolvers<IResponse>();
  let pending = Buffer.alloc(0);
  let read: { framing: 'chunked' | 'end' | number; head: IResponseHead } | undefined;
  let isSettled = false;

  // a response nobody waits for may be cut short: neither rejection goes unhandled
  head.promise.catch(noop);
  whole.promise.catch(noop);

  const fail = (error: Error): void => {
    isSettled = true;
    head.reject(error);
    whole.reject(error);
  };

  const settle = (body: Uint8Array): void => {
    if (read !== undefined) {
      isSettled = true;
      whole.resolve({ ...read.head, body });
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
      const body = dechunk(pending);

      if (body !== undefined) {
        settle(body);
      }

      return;
    }

    if (typeof framing === 'number' && pending.length >= framing) {
      settle(pending.subarray(0, framing));
    }
  };

  return {
    end: (error) => {
      if (isSettled) {
        return;
      }

      if (read?.framing === 'end') {
        settle(pending);

        return;
      }

      const reason = read === undefined ? 'the head' : 'the body';

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
    response: whole.promise,
  };
};

/**
 * Opens a socket to `port` on `host`, writes `request` on it at once, and reads its response as it
 * comes; nothing waits for it.
 */
export const openExchange = (
  { host, port }: { host: string; port: number },
  request: Uint8Array
): IExchange => {
  const reader = createResponseReader();
  const socket = connect({ host, port });

  socket.on('data', (bytes) => {
    reader.feed(bytes);
  });
  socket.on('error', (error) => {
    reader.end(error);
  });
  socket.on('close', () => {
    reader.end();
  });
  socket.write(request);

  return {
    destroy: () => {
      socket.destroy();
    },
    reader,
  };
};
