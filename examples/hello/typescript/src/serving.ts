// ── Serving ──────────────────────────────────────────────────────────────────

// HelloService's TypeScript server, over WebSocket on 127.0.0.1, and its gateway beside it: one
// server, HelloService offered on it once, which takes its connections from its WebSocket transport
// and from an in-memory one, joined, the gateway's calls crossing the second (decision 0037).

// dependencies

import { once } from 'node:events';
import { createServer as createNodeServer } from 'node:http';
import { createHTTPGateway } from '@francisdesjardins/bead/http-gateway';
import { joinTransports } from '@francisdesjardins/bead/joined-transport-server';
import { createMemoryTransportServer } from '@francisdesjardins/bead/memory-transport-server';
import { createServer } from '@francisdesjardins/bead/server';
import { createWSTransportServer } from '@francisdesjardins/bead/ws-transport-server';
import { WebSocketServer } from 'ws';
import { HTTP_PROBLEM_TYPES, HTTP_ROUTES, OPENAPI_DOCUMENT } from '#hello/http';
import { offerHello } from './resolvers.ts';

// definition

/**
 * Serves HelloService on `port`, any free one when 0, and its gateway on any free port: its first
 * line on the standard output says both, as {"port":n,"gateway":m}; it serves until its standard
 * input closes.
 */
export const serve = async (port: number): Promise<number> => {
  const webSocket = createWSTransportServer({ WebSocketServer });
  const memory = createMemoryTransportServer();

  await using server = createServer<ReturnType<typeof joinTransports>, string>({
    transport: joinTransports([webSocket, memory]),
  });

  server.router.on('error', (error, connectionHandle) => {
    process.stderr.write(`${connectionHandle ?? 'no connection'}: ${error.message}\n`);
  });
  // what a socket or a listener of the transport's events threw, and each request it refused of
  // its own, which no router forwards
  server.transport.on('error', (error, connectionHandle) => {
    process.stderr.write(
      `${connectionHandle === '' ? 'no connection' : connectionHandle}: ${error.message}\n`
    );
  });
  server.transport.on('refusal', ({ reason, status }) => {
    process.stderr.write(`refused ${String(status)} ${reason}\n`);
  });
  offerHello(server);

  // * the gateway answers each procedure's routes as one more client of this server, one
  // connection an exchange, over the in-memory transport the server takes beside WebSocket
  await using gateway = createHTTPGateway({
    createServer: (listener) => {
      return createNodeServer(listener);
    },
    document: OPENAPI_DOCUMENT,
    problemTypes: HTTP_PROBLEM_TYPES,
    routes: HTTP_ROUTES,
    transport: memory,
  });

  gateway.on('error', (error) => {
    process.stderr.write(`gateway: ${error.message}
`);
  });

  await memory.start();

  const address = await webSocket.start({
    address: '127.0.0.1',
    findOpenPort: port === 0,
    port,
  });
  const gatewayAddress = await gateway.start({ address: '127.0.0.1' });

  process.stdout.write(`${JSON.stringify({ port: address.port, gateway: gatewayAddress.port })}\n`);

  // served until whoever started it lets go of its input
  process.stdin.resume();
  await once(process.stdin, 'end');

  return 0;
};
