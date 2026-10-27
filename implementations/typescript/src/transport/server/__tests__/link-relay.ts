// ── Link relay ────────────────────────────────────────────────────────────────

// A relay on the loopback in front of a broker, which a case's participant links through: a `lose`
// cuts it, so that the broker sees the link end unclean (spec 15.26); a `silence` holds it silent
// (spec 15.38); and it keeps listening, so a link connects anew through it.

// dependencies

import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';

// interfaces

/** A relay to a broker: its port on the loopback, its every link cut, and what closes it. */
export interface ILinkRelay extends AsyncDisposable {
  readonly port: number;
  /** Ends every link through it at once, each socket destroyed with no packet of its own. */
  cut(): void;
  /**
   * Holds every link through it silent: nothing forwarded either way, its socket to the broker kept
   * open and what the broker writes read, so that the broker hears nothing until it gives up.
   */
  silence(): void;
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
  // the sockets each silenced link holds open, both its ends
  const silenced = new Set<Socket>();
  const server = createServer((inward) => {
    const outward = createConnection({ host, port });
    const pair = [inward, outward] as const;
    const end = (): void => {
      // * a silenced link's ends outlive each other: the broker's is held until it gives up
      if (silenced.has(inward)) {
        return;
      }

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

  const silence = (): void => {
    for (const pair of pairs) {
      const [inward, outward] = pair;

      pairs.delete(pair);
      silenced.add(inward);
      silenced.add(outward);
      inward.unpipe(outward);
      outward.unpipe(inward);

      // * the participant's side forgotten, the broker's read and dropped
      for (const socket of pair) {
        socket.on('data', () => {
          // nothing goes across
        });
      }
    }
  };

  return {
    port: (server.address() as { port: number }).port,
    cut,
    silence,
    [Symbol.asyncDispose]: async () => {
      cut();

      for (const socket of silenced) {
        socket.destroy();
      }

      server.close();
      await once(server, 'close');
    },
  };
};
