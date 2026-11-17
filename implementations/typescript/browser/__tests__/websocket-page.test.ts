// ── WebSocket page ────────────────────────────────────────────────────────────

// The WebSocket client in Chromium, given no subprotocol, against the TypeScript server, which
// selects none: a page's WebSocket fails an upgrade whose 101 names none of what it offered, so the
// client offers none (spec 15.2; WHATWG WebSockets §2.2).

// dependencies

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { createWebSocketServer } from '../../src/server/websocket-server';
import type { IWebSocketReport, IWebSocketTarget } from '../websocket-page';

// constants

const HOST = '127.0.0.1';

// helpers

/** The page, its script bundled for the browser, served on this machine; what closes it. */
const servePage = async () => {
  const { outputFiles } = await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL('../websocket-page.ts', import.meta.url))],
    format: 'esm',
    logLevel: 'silent',
    platform: 'browser',
    write: false,
  });
  const script = outputFiles[0]?.contents ?? new Uint8Array();
  const server = createServer((request, reply) => {
    if (request.url === '/websocket-page.js') {
      reply.writeHead(200, { 'content-type': 'text/javascript' });
      reply.end(script);

      return;
    }

    reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    reply.end('<!doctype html><script type="module" src="/websocket-page.js"></script>');
  });

  server.listen(0, HOST);
  await once(server, 'listening');

  return {
    close: () => {
      server.close();
      server.closeAllConnections();
    },
    port: (server.address() as AddressInfo).port,
  };
};

// definition

test.describe('the WebSocket client in a page', () => {
  // spec 15.2; WHATWG WebSockets §2.2
  test('connects to the TypeScript server offering no subprotocol when given none', async ({
    page,
  }) => {
    const served = await servePage();
    const offers: (string | undefined)[] = [];

    // ws's own server, which tells each upgrade it takes as it writes its 101: what each offered
    class NotingServer extends WebSocketServer {
      constructor(options: ConstructorParameters<typeof WebSocketServer>[0]) {
        super(options);
        this.on('headers', (_headers, request) => {
          offers.push(request.headers['sec-websocket-protocol']);
        });
      }
    }
    const server = createWebSocketServer({
      transport: {
        origins: [`http://localhost:${String(served.port)}`],
        WebSocketServer: NotingServer,
      },
    });
    const { port } = await server.transport.start({ address: HOST, findOpenPort: true });

    try {
      await page.goto(`http://localhost:${String(served.port)}/`);
      await page.waitForFunction(() => {
        return 'connectOfferingNone' in globalThis;
      });

      const target: IWebSocketTarget = { host: HOST, port };
      const report = await page.evaluate((given) => {
        const { connectOfferingNone } = globalThis as unknown as {
          connectOfferingNone: (target: IWebSocketTarget) => Promise<IWebSocketReport>;
        };

        return connectOfferingNone(given);
      }, target);

      expect([report, offers]).toEqual([{ disconnected: true }, [undefined]]);
    } finally {
      await server.transport.stop();
      served.close();
    }
  });
});
