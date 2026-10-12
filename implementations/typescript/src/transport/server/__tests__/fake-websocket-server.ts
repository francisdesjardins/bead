import { EventEmitter } from 'node:events';
import type { TransportServerConnectionHandle, TransportServerEventMap } from '../transport-server';
import type {
  IIncomingMessageLike,
  IServerSocketLike,
  IWebSocketServerConstructor,
  WSTransportServer,
} from '../ws-transport-server';

/**
 * A `WebSocketServer` a test scripts by hand, for the branches a real one does not take on demand:
 * an error after listening, one before it, a peer that never answers a close, a close that throws.
 * The transport's HTTP server, which it is given, listens for real; its `listening` and its `error`
 * are what the test scripts, as `ws` forwards them.
 */

export interface IFakeSocket extends IServerSocketLike {
  closeCodes: number[];
  /** What the peer sends, or does: `message`, `pong`, `close`. */
  hear(event: string, ...params: unknown[]): void;
  /** The pings the socket was asked to send. */
  pings: number;
  wasTerminated: boolean;
}

export const createFakeSocket = (behaviour?: {
  onClose?: 'answer' | 'ignore' | 'throw';
  /** Whether the peer answers a ping; it does not by default. */
  onPing?: 'answer' | 'ignore';
}) => {
  const emitter = new EventEmitter();
  const socket: IFakeSocket = {
    binaryType: 'nodebuffer',
    closeCodes: [],
    readyState: 1,
    wasTerminated: false,
    hear: (event, ...params) => {
      emitter.emit(event, ...params);
    },
    close: (code) => {
      socket.closeCodes.push(code ?? 1005);
      if (behaviour?.onClose === 'throw') {
        throw new Error('close refused');
      }
      if (behaviour?.onClose !== 'ignore') {
        emitter.emit('close', code ?? 1005);
      }
    },
    on: (event: string, listener: (...params: never[]) => void) => {
      return emitter.on(event, listener as (...params: unknown[]) => void);
    },
    once: (event: string, listener: () => void) => {
      return emitter.once(event, listener);
    },
    ping: () => {
      socket.pings += 1;
      if (behaviour?.onPing === 'answer') {
        emitter.emit('pong');
      }
    },
    pings: 0,
    send: () => {},
    terminate: () => {
      socket.wasTerminated = true;
      emitter.emit('close', 1006);
    },
  };
  return socket;
};

/**
 * `address` is what the server reports once listening: an object for a port, as `ws` gives on TCP,
 * or a string or `null`, as Node gives for a pipe or a server not listening.
 */
export const createFakeWebSocketServer = (options?: {
  address?: { address: string; port: number } | string | null;
}) => {
  // each instance keeps the options it was built with
  const instances: (EventEmitter & { closeCount: number; options: unknown })[] = [];
  const reported =
    options === undefined || !('address' in options)
      ? { address: '127.0.0.1', port: 50_000 }
      : options.address;

  // a function rather than an arrow, since the transport calls it with `new`
  const FakeWebSocketServer = function (serverOptions: unknown) {
    const emitter = Object.assign(new EventEmitter(), { closeCount: 0, options: serverOptions });
    instances.push(emitter);
    return Object.assign(emitter, {
      address: () => {
        return reported;
      },
      close: () => {
        emitter.closeCount += 1;
      },
    });
  } as unknown as IWebSocketServerConstructor;

  // the request of an upgrade taken, from `socket`
  const requestOf = (socket: IIncomingMessageLike['socket']): IIncomingMessageLike => {
    return { headers: {}, httpVersion: '1.1', rawHeaders: [], socket };
  };

  /**
   * A connection from `10.0.0.1`, on `remotePort`, 40,000 unless it says: the handle `server` drew
   * for it, as its `connection` event tells it, never one the test predicts.
   */
  const connect = (
    socket: IServerSocketLike,
    { remotePort = 40_000, server }: { remotePort?: number; server: WSTransportServer }
  ): TransportServerConnectionHandle => {
    const request = requestOf({ remoteAddress: '10.0.0.1', remotePort });
    let drawn: TransportServerConnectionHandle | undefined;
    const listener = (...params: TransportServerEventMap['connection']) => {
      [, , drawn] = params;
    };

    server.on('connection', listener);
    instances.at(-1)?.emit('connection', socket, request);
    server.off('connection', listener);

    if (drawn === undefined) {
      throw new Error('the transport took no connection');
    }

    return drawn;
  };

  /** A connection whose TCP socket was torn down before the server saw it: it reports no address. */
  const connectGone = (socket: IServerSocketLike) => {
    const request = requestOf({});
    instances.at(-1)?.emit('connection', socket, request);
  };

  return { connect, connectGone, FakeWebSocketServer, instances };
};
