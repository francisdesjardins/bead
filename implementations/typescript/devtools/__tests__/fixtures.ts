import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type AddressInfo, createServer as createTcpServer } from 'node:net';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// constants

/** The extension, as `yarn devtools:build` leaves it. */
export const EXTENSION = fileURLToPath(new URL('../dist/', import.meta.url));

/** The demo's static build, as `yarn playground:build:file` leaves it: a page whose server is its worker. */
export const PLAYGROUND = fileURLToPath(new URL('../../demo/dist/playground/', import.meta.url));

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
});

// helpers

/** Fails, saying which build to run, when what a test loads was not built. */
export const assertBuilt = async (): Promise<void> => {
  for (const [path, command] of [
    [join(EXTENSION, 'manifest.json'), 'yarn devtools:build'],
    [join(PLAYGROUND, 'index.html'), 'yarn playground:build:file'],
  ] as const) {
    try {
      await access(path);
    } catch {
      throw new Error(`${path} is not there: run ${command} first`);
    }
  }
};

/** A folder served on this machine, as a static host serves it; what closes it. */
export const serveFolder = async (
  root: string
): Promise<{ close: () => Promise<void>; url: string }> => {
  const server = createServer((request, reply) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = join(root, path === '/' ? 'index.html' : path);

    readFile(file).then(
      (content) => {
        reply.writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
        reply.end(content);
      },
      () => {
        reply.writeHead(404);
        reply.end();
      }
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    close: () => {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`,
  };
};

/** Chromium with the extension loaded, its background, and its id. */
export const launchExtension = async (): Promise<{
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
}> => {
  const context = await chromium.launchPersistentContext('', {
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    channel: 'chromium',
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  return { context, extensionId: new URL(worker.url()).host, worker };
};

/** The demo's launcher, beside the run's broker, and what stops it even when an assertion fails. */
export const serveMqttDemo = async () => {
  const reservation = createTcpServer();

  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');

  const address = reservation.address();

  if (address === null || typeof address === 'string') {
    throw new Error('the demo needs a TCP port');
  }

  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });

  const server = spawn(process.execPath, ['demo/serve.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, DEMO_PORT: String(address.port) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stop = async (): Promise<void> => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');

      server.kill();
      await exited;
    }
  };

  server.stderr.pipe(process.stderr);
  const deadline = setTimeout(() => {
    server.kill();
  }, 10_000);

  try {
    for await (const line of createInterface({ input: server.stdout })) {
      if (line.startsWith('Bead, a demo:')) {
        return { url: `http://127.0.0.1:${String(address.port)}/`, [Symbol.asyncDispose]: stop };
      }
    }

    throw new Error('the demo ends before it says its port');
  } catch (error) {
    await stop();

    throw error;
  } finally {
    clearTimeout(deadline);
  }
};
