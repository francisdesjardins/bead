// ── Link relay ────────────────────────────────────────────────────────────────

// A relay on the loopback in front of a broker, which a case's participant links through over MQTT
// 5: a `lose` cuts it, so that the broker sees the link end unclean and publishes its will (spec
// 15.26); it keeps listening, so a link connects anew through it.

// dependencies

import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';

// interfaces

/** A relay to a broker: its port on the loopback, its every link cut, and what closes it. */
export interface ILinkRelay extends AsyncDisposable {
  readonly port: number;
  /** Ends every link through it at once, each socket destroyed with no packet of its own. */
  cut(): void;
}

// definition

/** A relay on 127.0.0.1, on a port of its own, piping each link to `host`:`port`. */
export const createLinkRelay = async ({
  host,
  port,
}: {
  host: string;
  port: number;
}): Promise<ILinkRelay> => {
  const pairs = new Set<readonly [Socket, Socket]>();
  const server = createServer((inward) => {
    const outward = createConnection({ host, port });
    const pair = [inward, outward] as const;
    const end = (): void => {
      pairs.delete(pair);
      inward.destroy();
      outward.destroy();
    };

    pairs.add(pair);
    inward.pipe(outward);
    outward.pipe(inward);

    for (const socket of pair) {
      socket.on('error', end);
      socket.on('close', end);
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const cut = (): void => {
    for (const pair of pairs) {
      pairs.delete(pair);

      for (const socket of pair) {
        socket.resetAndDestroy();
      }
    }
  };

  return {
    port: (server.address() as { port: number }).port,
    cut,
    [Symbol.asyncDispose]: async () => {
      cut();
      server.close();
      await once(server, 'close');
    },
  };
};
