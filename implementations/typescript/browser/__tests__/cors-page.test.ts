// ── CORS page ─────────────────────────────────────────────────────────────────

// The HTTP client in Chromium, from a page of another origin, against the interop service's HTTP
// server on each side: what proves a browser reads the CORS answer (spec 15.12; decision 0027), and
// keeps it for every exchange at the connection's one URL (spec 15.9; decision 0029), which the
// conformance cases hold on the wire alone. The C# server is built and started by .NET: where
// .NET is not installed, its half is skipped, saying so, or fails where `BEAD_INTEROP_REQUIRED=1`.
// A page of its server's own origin, that server answering its connect with a redirect, shows what
// a page's fetch reads of one: no status (spec 15.6).

// dependencies

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as requestHTTP } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';
import type { ICrossOriginReport, ICrossOriginTarget } from '../cors-page';

// constants

const HOST = '127.0.0.1';

/** The package, where the TypeScript interop server runs from. */
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));

/** The C# side, beside the package, where its interop server runs from. */
const DOTNET = fileURLToPath(new URL('../../../dotnet/', import.meta.url));

/** Whether .NET answers, to build and start the C# server. */
const HAS_DOTNET = spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;

/** Whether the C# half must run: a path to the other side gone wrong then fails, not skips. */
const REQUIRED = process.env['BEAD_INTEROP_REQUIRED'] === '1';

/** Each side's interop server: how it starts, and whether it can here. */
const SERVERS = [
  {
    args: ['interop/serve.ts'],
    command: process.execPath,
    cwd: PACKAGE,
    isRunnable: true,
    label: 'TypeScript',
  },
  {
    args: ['run', '--project', 'interop/Bead.Interop.Server'],
    command: 'dotnet',
    cwd: DOTNET,
    isRunnable: HAS_DOTNET,
    label: 'C#',
  },
] as const;

// helpers

/**
 * The page, its script bundled for the browser, served on this machine, and, given `redirectTo`, a
 * port, its own `/bead` answered with a 307 to that port's; what closes it.
 */
const servePage = async ({ redirectTo }: { redirectTo?: number } = {}) => {
  const { outputFiles } = await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL('../cors-page.ts', import.meta.url))],
    format: 'esm',
    logLevel: 'silent',
    platform: 'browser',
    write: false,
  });
  const script = outputFiles[0]?.contents ?? new Uint8Array();
  const server = createServer((request, reply) => {
    if (redirectTo !== undefined && request.url === '/bead') {
      request.resume();
      reply.writeHead(307, { location: `http://${HOST}:${String(redirectTo)}/bead` });
      reply.end();

      return;
    }

    if (request.url === '/cors-page.js') {
      reply.writeHead(200, { 'content-type': 'text/javascript' });
      reply.end(script);

      return;
    }

    reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    reply.end('<!doctype html><script type="module" src="/cors-page.js"></script>');
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

/**
 * A proxy on this machine in front of the server at `port`, which notes what it forwards: the
 * preflights, each listen's `bead-after`, and every target. On a port of its own, it is a URL no
 * browser cached a preflight for.
 */
const startNotingProxy = async (port: number) => {
  const noted = { afters: [] as unknown[], preflights: 0, targets: new Set<string>() };
  const server = createServer((request, reply) => {
    noted.targets.add(request.url ?? '');

    if (request.method === 'OPTIONS') {
      noted.preflights += 1;
    } else if (request.method === 'GET') {
      noted.afters.push(request.headers['bead-after']);
    }

    const forwarded = requestHTTP(
      { headers: request.headers, host: HOST, method: request.method, path: request.url, port },
      (answer) => {
        reply.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(reply);
      }
    );

    forwarded.on('error', () => {
      reply.destroy();
    });
    request.pipe(forwarded);
  });

  server.listen(0, HOST);
  await once(server, 'listening');

  return {
    close: () => {
      server.close();
      server.closeAllConnections();
    },
    noted,
    port: (server.address() as AddressInfo).port,
  };
};

/**
 * An interop server, started, naming `origin`, and the HTTP port it says it listens on: what it
 * writes before, `dotnet run` building it, comes first.
 */
const startServer = async (
  { args, command, cwd }: (typeof SERVERS)[number],
  { origin }: { origin: string }
): Promise<{ httpPort: number; server: ChildProcessWithoutNullStreams }> => {
  const server = spawn(command, args, {
    cwd,
    env: { ...process.env, BEAD_INTEROP_ORIGINS: origin },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  server.stderr.pipe(process.stderr);

  for await (const line of createInterface({ input: server.stdout })) {
    try {
      const { httpPort } = JSON.parse(line) as { httpPort?: unknown };

      if (typeof httpPort === 'number') {
        return { httpPort, server };
      }
    } catch {
      // a line of the build's, before the server's
    }
  }

  throw new Error(`the ${command} interop server ended before it said its port`);
};

// definition

for (const each of SERVERS) {
  test.describe(`a page of another origin, against the ${each.label} server`, () => {
    test.skip(
      !each.isRunnable && !REQUIRED,
      'it builds and starts a .NET program, and .NET is not installed'
    );
    test.describe.configure({ mode: 'serial' });

    let served: Awaited<ReturnType<typeof servePage>> | undefined;
    let server: ChildProcessWithoutNullStreams | undefined;
    let target: ICrossOriginTarget;

    test.beforeAll(async () => {
      // the first run builds the C# server
      test.setTimeout(180_000);

      if (!each.isRunnable) {
        throw new Error(
          'BEAD_INTEROP_REQUIRED=1 asks for the C# server, and .NET is not installed'
        );
      }

      served = await servePage();

      // the page's origin is localhost's, the server's 127.0.0.1's: two origins on one machine
      const started = await startServer(each, {
        origin: `http://localhost:${String(served.port)}`,
      });

      server = started.server;
      target = { host: HOST, port: started.httpPort };
    });

    test.afterAll(async () => {
      served?.close();

      if (server !== undefined) {
        const exited = once(server, 'exit');

        server.stdin.end();
        await exited;
      }
    });

    /** What the page at `url` came to against the server. */
    const reportOf = async (browserPage: Page, url: string): Promise<ICrossOriginReport> => {
      await browserPage.goto(url);
      await browserPage.waitForFunction(() => {
        return 'callAcrossOrigins' in globalThis;
      });

      return browserPage.evaluate((given) => {
        const { callAcrossOrigins } = globalThis as unknown as {
          callAcrossOrigins: (on: ICrossOriginTarget) => Promise<ICrossOriginReport>;
        };

        return callAcrossOrigins(given);
      }, target);
    };

    test('a page of an origin the server names connects, calls, presents ELSEWHERE in Authorization, hears what it listens for, reads a refusal and disconnects', async ({
      page,
    }) => {
      const report = await reportOf(page, `http://localhost:${String(served?.port)}/`);

      expect(report).toEqual({
        disconnected: true,
        echoed: { across: 'origins' },
        heard: 1,
        refusal: [404, 'connection-unknown'],
        whoami: 'ada',
      });
    });

    test('a page of another origin listens through a stream of batches on one preflight', async ({
      page,
    }) => {
      const proxy = await startNotingProxy(target.port);

      try {
        await page.goto(`http://localhost:${String(served?.port)}/`);
        await page.waitForFunction(() => {
          return 'listenAcrossOrigins' in globalThis;
        });

        const report = await page.evaluate(
          (given) => {
            const { listenAcrossOrigins } = globalThis as unknown as {
              listenAcrossOrigins: (
                on: ICrossOriginTarget,
                options: { count: number }
              ) => Promise<unknown>;
            };

            return listenAcrossOrigins(given, { count: 5 });
          },
          { host: HOST, port: proxy.port }
        );

        // each tick a batch of its own, each listen's cursor past the last, at one URL: the
        // connect's preflight is the only one, Chromium keeping its answer by that URL. The listen
        // after the fifth races the disconnect, so the cursors before it are read
        expect(report).toEqual({ heard: [1, 2, 3, 4, 5] });
        expect([...new Set(proxy.noted.afters)].slice(0, 5)).toEqual(['0', '1', '2', '3', '4']);
        expect([proxy.noted.targets, proxy.noted.preflights]).toEqual([new Set(['/bead']), 1]);
      } finally {
        proxy.close();
      }
    });

    test('a page of an origin the server does not name connects to nothing', async ({ page }) => {
      // the same page from 127.0.0.1's origin, which the server does not name
      const report = await reportOf(page, `http://${HOST}:${String(served?.port)}/`);

      expect(report).toEqual({ connectFailure: expect.stringContaining('ConnectError') });
    });
  });
}

test.describe('a page of its server’s own origin', () => {
  test('names no status of a redirect answered to a page of its server’s own origin', async ({
    page,
  }) => {
    // where the redirect points: a listener that notes every request
    const heard: string[] = [];
    const target = createServer((request, reply) => {
      heard.push(request.method ?? '');
      request.resume();
      reply.writeHead(404);
      reply.end();
    });

    target.listen(0, HOST);
    await once(target, 'listening');

    const served = await servePage({ redirectTo: (target.address() as AddressInfo).port });

    try {
      await page.goto(`http://localhost:${String(served.port)}/`);
      await page.waitForFunction(() => {
        return 'connectToOwnOrigin' in globalThis;
      });

      const report = await page.evaluate(() => {
        const { connectToOwnOrigin } = globalThis as unknown as {
          connectToOwnOrigin: () => Promise<ICrossOriginReport>;
        };

        return connectToOwnOrigin();
      });

      // an opaque redirect, of status 0, never followed
      expect([report, heard]).toEqual([
        { connectFailure: 'ConnectError: the server drew no connection: a redirect' },
        [],
      ]);
    } finally {
      served.close();
      target.close();
      target.closeAllConnections();
    }
  });
});
