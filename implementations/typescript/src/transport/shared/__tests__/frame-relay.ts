// ── Frame relay ───────────────────────────────────────────────────────────────

// A relay on the loopback in front of a broker's WebSocket, recording each frame a client sends
// (RFC 6455 §5.2) as it passes every byte through.

// dependencies

import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';

// interfaces

/** A frame a client sent: whether it ends its message, its opcode, and its payload's length. */
export interface IRecordedFrame {
  readonly fin: boolean;
  readonly length: number;
  readonly opcode: number;
}

/** The relay: the URL a client links through, what each client sent, and what closes it. */
export interface IFrameRelay extends AsyncDisposable {
  /** Every frame of every client, in their order. */
  readonly frames: readonly IRecordedFrame[];
  readonly url: string;
}

// constants

// where a client's upgrade request ends (RFC 9112 §2.1)
const HEAD_END = Buffer.from('\r\n\r\n');

// helpers

/** What reads a client's bytes, its request first and its frames after, into `frames`. */
const readerOf = (frames: IRecordedFrame[]): ((chunk: Buffer) => void) => {
  let buffer = Buffer.alloc(0);
  let isUpgraded = false;

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (!isUpgraded) {
      const end = buffer.indexOf(HEAD_END);

      if (end === -1) {
        return;
      }

      buffer = buffer.subarray(end + HEAD_END.length);
      isUpgraded = true;
    }

    for (;;) {
      if (buffer.length < 2) {
        return;
      }

      const marker = buffer[1] ?? 0;
      let length = marker & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < 4) {
          return;
        }

        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) {
          return;
        }

        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      // * a client masks every frame it sends (RFC 6455 §5.3)
      offset += (marker & 0x80) === 0 ? 0 : 4;

      if (buffer.length < offset + length) {
        return;
      }

      const first = buffer[0] ?? 0;

      frames.push({ fin: (first & 0x80) !== 0, length, opcode: first & 0x0f });
      buffer = buffer.subarray(offset + length);
    }
  };
};

// definition

/**
 * The frames of `frames` that are no whole binary message: one that ends no message, a continuation,
 * or text (RFC 6455 §5.2, §5.4).
 */
export const unwholeOf = (frames: readonly IRecordedFrame[]): IRecordedFrame[] => {
  return frames.filter(({ fin, opcode }) => {
    return !fin || opcode === 0x0 || opcode === 0x1;
  });
};

/** A relay to the broker's WebSocket at `target`, listening on the loopback, its path the same. */
export const createFrameRelay = async (target: string): Promise<IFrameRelay> => {
  const { hostname, pathname, port } = new URL(target);
  const frames: IRecordedFrame[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const broker = createConnection({ host: hostname, port: Number(port) });
    const read = readerOf(frames);

    sockets.add(client);
    sockets.add(broker);
    client.on('data', (chunk: Buffer) => {
      read(chunk);
      broker.write(chunk);
    });
    broker.on('data', (chunk: Buffer) => {
      client.write(chunk);
    });
    client.on('close', () => {
      broker.destroy();
    });
    broker.on('close', () => {
      client.destroy();
    });
    // a link cut ends both legs, its close told above
    client.on('error', () => {});
    broker.on('error', () => {});
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const relayPort = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    frames,
    url: `ws://127.0.0.1:${String(relayPort)}${pathname}`,
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.close();
      await once(server, 'close');
    },
  };
};
