// ── Interop server ────────────────────────────────────────────────────────────

// The TypeScript server of Bead's interop service, on 127.0.0.1, over WebSocket and over HTTP, each a
// server of its own: its first line on the standard output says their ports, as
// {"port":n,"httpPort":m,"gatewayPort":g}; it serves until its standard input closes. A port given as its one
// argument is the WebSocket server's; none, any free one. The HTTP server takes any free one. Each
// names the origins `BEAD_INTEROP_ORIGINS` lists, separated by spaces, none when it is not set: a
// page of another origin calls them so. The C# side's interop server does the same, so each side's
// client calls the other's server. The gateway serves the Transcoding fixture and its document.
// `serve.ts` bundles it and runs it, as Node runs no import without
// its extension.

// dependencies

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createHTTPServer } from '../src/server/http-server';
import { createWSServer } from '../src/server/ws-server';
import { PLATFORM_CLOCK } from '../src/transport/shared/clock';
import { startTranscoding } from '../src/transcoding/__tests__/transcoding-service';
import { interopCredentialsOf } from './credentials';
import { offerInterop } from './handlers';

// definition

const port = Number(process.argv[2] ?? 0);
const origins = (process.env['BEAD_INTEROP_ORIGINS'] ?? '').split(' ').filter((origin) => {
  return origin !== '';
});
// the interop service's credentials, on the clock both servers run on, the platform's
const credentials = interopCredentialsOf(PLATFORM_CLOCK);
const server = createWSServer<string>({ credentials, transport: { origins, WebSocketServer } });
const httpServer = createHTTPServer<string>({
  credentials,
  transport: {
    createServer: (listener) => {
      return createServer(listener);
    },
    origins,
  },
});

for (const each of [server, httpServer]) {
  each.router.on('error', (error, connectionHandle) => {
    process.stderr.write(`${connectionHandle ?? 'no connection'}: ${error.message}
`);
  });
  offerInterop(each);
}

const address = await server.transport.start({
  address: '127.0.0.1',
  findOpenPort: port === 0,
  port,
});
const httpAddress = await httpServer.transport.start({ address: '127.0.0.1', findOpenPort: true });
const transcoding = await startTranscoding({
  origins,
  maximumBodyBytes: 1024,
  maximumConnectionsPerAddress: 1,
});

process.stdout
  .write(`${JSON.stringify({ gatewayPort: transcoding.port, httpPort: httpAddress.port, port: address.port })}
`);

// served until whoever started it lets go of its input
process.stdin.on('end', () => {
  void Promise.all([
    server[Symbol.asyncDispose](),
    httpServer[Symbol.asyncDispose](),
    transcoding[Symbol.asyncDispose](),
  ]).finally(() => {
    process.exit(0);
  });
});
process.stdin.resume();
