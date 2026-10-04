import { EventEmitter } from 'node:events';
import type {
  HTTPRequestListener,
  IHTTPRequestLike,
  IHTTPResponseLike,
  IHTTPServerLike,
} from '../http-transport-server';

/**
 * An HTTP server a test scripts by hand, for the branches a real one does not take on demand: a
 * header twice, a socket gone before its address is read, a target no URL parses, an error after
 * listening, one before it, an address that is no port, a response that closes before it is
 * written, a body that comes a piece at a time while the test acts in between.
 */

export interface IFakeResponse extends IHTTPResponseLike {
  /** What it wrote, all together; none until it writes. */
  body: Uint8Array | undefined;
  /** Closes it as a client gone would, written or not. */
  close(): void;
  headers: Record<string, string> | undefined;
  /** Whether `end` finishes it, as a response whose client is there does. */
  isFinishing: boolean;
  isDestroyed: boolean;
  status: number | undefined;
}

export interface IFakeRequest extends IHTTPRequestLike {
  isDestroyed: boolean;
  emit(event: 'close' | 'end'): boolean;
  emit(event: 'data', chunk: Uint8Array): boolean;
  emit(event: 'error', error: Error): boolean;
}

// what a response wrote so far, `data` after it
const joined = (body: Uint8Array | undefined, data: Uint8Array): Uint8Array => {
  return Uint8Array.from([...(body ?? []), ...data]);
};

const createFakeResponse = (): IFakeResponse => {
  const emitter = new EventEmitter();
  const response: IFakeResponse = {
    body: undefined,
    close: () => {
      emitter.emit('close');
    },
    destroy: () => {
      response.isDestroyed = true;
      emitter.emit('close');
    },
    end: (data?: Uint8Array) => {
      response.body = data === undefined ? response.body : joined(response.body, data);

      if (response.isFinishing) {
        (response as { writableFinished: boolean }).writableFinished = true;
        emitter.emit('finish');
        emitter.emit('close');
      }
    },
    headers: undefined,
    headersSent: false,
    isDestroyed: false,
    isFinishing: true,
    on: (event, listener) => {
      return emitter.on(event, listener);
    },
    status: undefined,
    writableFinished: false,
    write: (data) => {
      response.body = joined(response.body, data);
    },
    writeHead: (status, headers) => {
      response.status = status;
      response.headers = headers;
      (response as { headersSent: boolean }).headersSent = true;
    },
  };

  return response;
};

export const createFakeHTTPServer = (options?: {
  address?: { address: string; port: number } | string | null;
}) => {
  const reported =
    options === undefined || !('address' in options)
      ? { address: '127.0.0.1', port: 50_000 }
      : options.address;
  const servers: (EventEmitter & { closes: number; listened: [number, string] | undefined })[] = [];
  let listener: HTTPRequestListener | undefined;
  let listening: (() => void) | undefined;

  const createServer = (handler: HTTPRequestListener): IHTTPServerLike => {
    const emitter = Object.assign(new EventEmitter(), {
      closes: 0,
      listened: undefined as [number, string] | undefined,
    });

    listener = handler;
    servers.push(emitter);

    return {
      address: () => {
        return reported;
      },
      close: () => {
        emitter.closes += 1;
      },
      listen: (...[port, host, callback]) => {
        emitter.listened = [port, host];
        listening = callback;
      },
      on: (event: string, handlerOfEvent: (...params: never[]) => void) => {
        return emitter.on(event, handlerOfEvent as (...params: unknown[]) => void);
      },
    };
  };

  /** Tells the transport it listens, as a server's callback does. */
  const listen = () => {
    listening?.();
  };

  /**
   * Hands the transport one exchange: its request, which the test goes on to feed, and its response.
   * A `url` given as `undefined` stays so, as a request with no target.
   */
  const exchange = (
    options: {
      headers?: Record<string, string | string[]>;
      httpVersionMajor?: number;
      method?: string;
      socket?: { remoteAddress?: string; remotePort?: number };
      url?: string | undefined;
    } = {}
  ) => {
    const {
      headers = {},
      httpVersionMajor = 1,
      method = 'POST',
      socket = { remoteAddress: '10.0.0.1', remotePort: 40_000 },
    } = options;
    const url = 'url' in options ? options.url : '/bead';
    // each field as it came, a field given twice twice: its name, then its value
    const rawHeaders = Object.entries(headers).flatMap(([name, value]) => {
      return (Array.isArray(value) ? value : [value]).flatMap((each) => {
        return [name, each];
      });
    });
    const request = Object.assign(new EventEmitter(), {
      destroy: () => {
        request.isDestroyed = true;
      },
      headers,
      httpVersionMajor,
      isDestroyed: false,
      method,
      rawHeaders,
      socket,
      url,
    }) as unknown as IFakeRequest;
    const response = createFakeResponse();

    listener?.(request, response);

    return { request, response };
  };

  /** Sends `body` in pieces, one `data` each, then its end and its close. */
  const feed = (request: IFakeRequest, pieces: Uint8Array[]) => {
    for (const piece of pieces) {
      request.emit('data', piece);
    }

    request.emit('end');
    request.emit('close');
  };

  return { createServer, exchange, feed, listen, servers };
};
