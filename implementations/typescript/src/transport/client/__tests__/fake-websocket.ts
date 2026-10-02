import type {
  ICloseEventLike,
  IWebSocketConstructor,
  IWebSocketLike,
} from '../ws-transport-client';

/**
 * A WebSocket a test scripts by hand, for only what neither real implementation does on demand: an
 * error that carries its cause or nothing, a close with a reason before opening, a close never
 * answered, a close that throws. Everything else is tested on the real ones.
 */

export interface IFakeWebSocket extends IWebSocketLike {
  /** What `close()` does: close at once, start closing and never finish, or throw. */
  closeBehaviour: 'answer' | 'ignore' | 'throw';
  readonly closeCodes: (number | undefined)[];
  readyState: number;
  fireClose(event: ICloseEventLike): void;
  fireError(event: unknown): void;
  fireOpen(): void;
  /** How many pings more the server answers, each as it is sent; none by default. */
  answeredPings: number;
  /** The pings the socket was asked to send. */
  pings: number;
  wasTerminated: boolean;
}

/** `canPing` builds sockets that ping and terminate, as `ws`'s do; a browser's do neither. */
export const createFakeWebSocket = ({ canPing = false }: { canPing?: boolean } = {}) => {
  const sockets: IFakeWebSocket[] = [];

  // a function rather than an arrow, since the transport calls it with `new`
  const construct = function () {
    const pongs: (() => void)[] = [];
    const socket: IFakeWebSocket = {
      answeredPings: 0,
      binaryType: 'blob',
      closeBehaviour: 'answer',
      closeCodes: [],
      onclose: null,
      onerror: null,
      onmessage: null,
      onopen: null,
      readyState: 0,
      close: (code) => {
        socket.closeCodes.push(code);

        if (socket.closeBehaviour === 'throw') {
          throw new Error('close refused');
        }

        if (socket.closeBehaviour === 'ignore') {
          socket.readyState = 2;
          return;
        }

        socket.fireClose({ code: code ?? 1005, reason: '' });
      },
      fireClose: (event) => {
        socket.readyState = 3;
        socket.onclose?.(event);
      },
      fireError: (event) => {
        socket.onerror?.(event);
      },
      fireOpen: () => {
        socket.readyState = 1;
        socket.onopen?.({});
      },
      pings: 0,
      send: () => {},
      wasTerminated: false,
    };

    sockets.push(socket);

    // `ws`'s own: a ping, its answer, and a drop that closes as a network does, with 1006
    return canPing
      ? Object.assign(socket, {
          on: (_event: 'pong', listener: () => void) => {
            pongs.push(listener);
          },
          ping: () => {
            socket.pings += 1;

            if (socket.answeredPings > 0) {
              socket.answeredPings -= 1;

              for (const listener of pongs) {
                listener();
              }
            }
          },
          terminate: () => {
            socket.wasTerminated = true;
            socket.fireClose({ code: 1006, reason: '' });
          },
        })
      : socket;
  };

  const FakeWebSocket = Object.assign(construct, {
    CONNECTING: 0,
    OPEN: 1,
  }) as unknown as IWebSocketConstructor;

  return { FakeWebSocket, sockets };
};
