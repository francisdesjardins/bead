// ── MQTT script ───────────────────────────────────────────────────────────────

// A scripted MQTT 5 peer on the loopback, over `net` and `mqtt-packet`, which the adapter's tests
// play a broker with: each packet read as it comes, each answer the test's own, so that nothing a
// real broker does hides what the adapter sends.

// dependencies

import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { createServer as createTLSServer } from 'node:tls';
import { generate, type Packet, parser } from 'mqtt-packet';

// interfaces

/** One network connection to the script: what came on it, and what the test writes back. */
export interface IScriptedLink {
  /** Every packet that came, in its order. */
  readonly packets: Packet[];
  /** Whether the adapter's end of it closed. */
  readonly isClosed: boolean;
  /** Ends it at once, as a broker that drops a link does. */
  cut(): void;
  /** Ends it once what was written went, as a broker that closes a link does. */
  end(): void;
  /** The next packet that comes, of `cmd` where given, skipping others, within `within` ms. */
  next(cmd?: Packet['cmd'], options?: { within?: number | undefined }): Promise<Packet>;
  /** Writes `packet`, as MQTT 5 encodes it. */
  send(packet: Packet): void;
  /** Writes `bytes` as they are, for what no encoder writes. */
  write(bytes: Uint8Array): void;
  /** Resolves once the adapter's end closed. */
  readonly closed: Promise<void>;
}

/** The script: its address, each link as it comes, and what closes it. */
export interface IMqttScript extends AsyncDisposable {
  readonly url: string;
  /** The next link that comes, its CONNECT read, within `within` ms. */
  link(options?: { within?: number | undefined }): Promise<IScriptedLink & { connect: Packet }>;
}

// constants

const PATIENCE = 5_000;

const VERSION = Object.freeze({ protocolVersion: 5 });

// helpers

const scriptedLinkOf = (socket: Socket): IScriptedLink => {
  const packets: Packet[] = [];
  const unread: Packet[] = [];
  const waiting: (() => void)[] = [];
  const reader = parser(VERSION);
  let isClosed = false;

  reader.on('packet', (packet: Packet) => {
    packets.push(packet);
    unread.push(packet);

    for (const wake of waiting.splice(0)) {
      wake();
    }
  });
  socket.on('data', (chunk: Buffer) => {
    reader.parse(chunk);
  });
  socket.on('error', () => {
    // the adapter's end cut it
  });

  const closed = once(socket, 'close').then(() => {
    isClosed = true;

    for (const wake of waiting.splice(0)) {
      wake();
    }
  });

  return {
    closed,
    get isClosed() {
      return isClosed;
    },
    packets,
    cut: () => {
      socket.resetAndDestroy();
    },
    end: () => {
      socket.end();
    },
    next: async (cmd, options) => {
      const deadline = Date.now() + (options?.within ?? PATIENCE);

      for (;;) {
        const index = unread.findIndex((packet) => {
          return cmd === undefined || packet.cmd === cmd;
        });

        if (index !== -1) {
          const [packet] = unread.splice(0, index + 1).slice(-1);

          if (packet !== undefined) {
            return packet;
          }
        }

        if (Date.now() >= deadline) {
          throw new Error(`no ${cmd ?? 'packet'} came within its time`);
        }

        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));

          waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    send: (packet) => {
      socket.write(generate(packet, VERSION));
    },
    write: (bytes) => {
      socket.write(bytes);
    },
  };
};

// definition

/**
 * A scripted MQTT 5 peer on 127.0.0.1, on a port of its own: over TCP, or over TLS under `tls`'s
 * certificate, `mqtts://localhost`.
 */
export const createMqttScript = async (options?: {
  tls?: { cert: string; key: string } | undefined;
}): Promise<IMqttScript> => {
  const links: (IScriptedLink & { connect: Packet })[] = [];
  const pending: IScriptedLink[] = [];
  const sockets = new Set<Socket>();
  const waiting: (() => void)[] = [];
  const accept = (socket: Socket): void => {
    const link = scriptedLinkOf(socket);

    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    pending.push(link);

    void link.next('connect', { within: PATIENCE }).then(
      (connect) => {
        pending.splice(pending.indexOf(link), 1);
        links.push(Object.assign(link, { connect }));

        for (const wake of waiting.splice(0)) {
          wake();
        }
      },
      () => {
        socket.destroy();
      }
    );
  };
  const tls = options?.tls;
  const server =
    tls === undefined
      ? createServer(accept)
      : createTLSServer({ cert: tls.cert, key: tls.key }, accept);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `${tls === undefined ? 'mqtt://127.0.0.1' : 'mqtts://localhost'}:${String((server.address() as { port: number }).port)}`,
    link: async (options) => {
      const deadline = Date.now() + (options?.within ?? PATIENCE);

      while (links.length === 0) {
        if (Date.now() >= deadline) {
          throw new Error('no link came within its time');
        }

        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));

          waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      return links.shift() as IScriptedLink & { connect: Packet };
    },
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.close();
      await once(server, 'close');
    },
  };
};
