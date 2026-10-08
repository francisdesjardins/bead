// ── Serving ──────────────────────────────────────────────────────────────────

// HelloService's TypeScript server, over WebSocket on 127.0.0.1.

// dependencies

import { once } from 'node:events';
import { createWSServer } from '@francisdesjardins/bead/ws-server';
import { WebSocketServer } from 'ws';
import { offerHello } from './resolvers.ts';

// definition

/**
 * Serves HelloService on `port`, any free one when 0: its first line on the standard output says
 * its port, as {"port":n}; it serves until its standard input closes.
 */
export const serve = async (port: number): Promise<number> => {
  await using server = createWSServer<string>({ transport: { WebSocketServer } });

  server.router.on('error', (error, connectionHandle) => {
    process.stderr.write(`${connectionHandle ?? 'no connection'}: ${error.message}\n`);
  });
  offerHello(server);

  const address = await server.transport.start({
    address: '127.0.0.1',
    findOpenPort: port === 0,
    port,
  });

  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);

  // served until whoever started it lets go of its input
  process.stdin.resume();
  await once(process.stdin, 'end');

  return 0;
};
